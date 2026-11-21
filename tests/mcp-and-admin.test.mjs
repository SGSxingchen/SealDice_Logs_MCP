import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, createServer, request } from 'node:http';
import { join } from 'node:path';
import { Readable, duplexPair } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createStreamableHttpApp } from '../dist/http-app.js';
import { SealDiceDb } from '../dist/sealdice-db.js';
import { createFixture, GROUP_A, GROUP_B, LOG_A, LOG_A_HISTORY, LOG_B, LOG_B_EMPTY } from './fixtures.mjs';

const ADMIN = '/sealdice-logs';
const PASSWORD = '测试环境专用-long-random-password';
const PUBLIC_ORIGIN = 'https://logs.example.test';
const DENIED = '找不到该日志或当前链接无权访问';
const REQUEST_TIMEOUT = 5000;
const TEST_TIMEOUT = 20000;

// 受限环境无法绑定端口时，仍由 Node 解析真实 HTTP 字节并交给 Express。
function inMemoryHttp(server) {
  const agent = new Agent();
  agent.createConnection = () => {
    const [client, peer] = duplexPair();
    for (const socket of [client, peer]) {
      socket.remoteAddress = '127.0.0.1';
      socket.setTimeout = socket.setNoDelay = socket.setKeepAlive = socket.ref = socket.unref = () => socket;
      socket.destroySoon = socket.end.bind(socket);
    }
    server.emit('connection', peer);
    return client;
  };
  const fetch = (url, init) => new Promise((resolve, reject) => {
    const req = request(url, {
      agent, method: init.method, signal: init.signal,
      headers: Object.fromEntries(new Headers(init.headers)),
    }, (res) => {
      const headers = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      }
      const empty = init.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
      const body = empty ? null : Readable.toWeb(res);
      if (empty) res.resume();
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage, headers }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
  return { fetch, close: () => agent.destroy() };
}

async function start(t, options = {}) {
  const closeClients = new Set();
  let db;
  let service;
  let server;
  let memoryHttp;
  t.after(async () => {
    await Promise.all([...closeClients].map((client) => client.close()));
    try {
      await service?.close();
    } finally {
      memoryHttp?.close();
      if (server?.listening) {
        const drained = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await drained;
      }
      db?.close();
    }
  });
  const fixture = createFixture(t);
  db = new SealDiceDb(fixture.logsPath, fixture.dataPath);
  service = await createStreamableHttpApp({
    db, stateDir: join(fixture.dir, '.admin'), adminPassword: PASSWORD, publicOrigin: PUBLIC_ORIGIN,
    enableUnauthLocalMcp: false, ...options,
  });
  server = createServer(service.app);
  let base;
  try {
    const listening = once(server, 'listening', { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    server.listen(0, '127.0.0.1');
    await listening;
    base = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    memoryHttp = inMemoryHttp(server);
    base = 'http://127.0.0.1:3004';
  }
  const fetch = (path, init = {}) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    const send = memoryHttp?.fetch ?? globalThis.fetch;
    return send(new URL(path, base), { redirect: 'manual', ...init, signal });
  };
  const api = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(`${ADMIN}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin: PUBLIC_ORIGIN }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = () => api('/auth/login', { method: 'POST', body: { password: PASSWORD } });
  async function connect(path, { watchStream = false } = {}) {
    const stream = watchStream ? Promise.withResolvers() : null;
    const transport = new StreamableHTTPClientTransport(new URL(path, base), {
      fetch: async (url, init) => {
        try {
          const response = await fetch(url, init);
          if (init.method === 'GET' && stream) stream.resolve(response.clone());
          return response;
        } catch (error) {
          if (init.method === 'GET') stream?.reject(error);
          throw error;
        }
      },
      reconnectionOptions: {
        initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0,
      },
    });
    const client = new Client({ name: 'sealdice-test', version: '1.0.0' });
    closeClients.add(client);
    await client.connect(transport, { timeout: REQUEST_TIMEOUT });
    assert.ok(transport.sessionId);
    return { client, transport, stream: stream?.promise };
  }
  return { ...fixture, fetch, api, login, connect };
}

async function json(response, status = 200) {
  const body = await response.text();
  assert.equal(response.status, status, body);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  return JSON.parse(body);
}

function cookieOf(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie ?? '', /^sealdice_logs_admin_session=[^;]+/);
  return setCookie.split(';', 1)[0];
}

function rpc(fetch, path, method, sessionId) {
  return fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 45, method: 'tools/list' }) : undefined,
  });
}

test('管理台静态文件、登录会话及日志查询和导出符合前端契约', { timeout: TEST_TIMEOUT }, async (t) => {
  const { fetch, api, login, now } = await start(t);
  const redirect = await fetch(ADMIN);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `${ADMIN}/`);
  await redirect.body?.cancel();
  const page = await fetch(`${ADMIN}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html\b/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src[^;]*'self'/);
  const markup = await page.text();
  assert.match(markup, /src="\.\/app\.js"/);
  assert.match(markup, /href="\.\/styles\.css"/);
  const script = await fetch(`${ADMIN}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /(?:java|ecma)script/);
  assert.match(await script.text(), /const API_BASE = '\.\/api'/);
  const css = await fetch(`${ADMIN}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css\b/);
  await css.body?.cancel();
  assert.deepEqual(await json(await fetch('/health')), {
    status: 'ok', service: 'sealdice-logs-mcp', version: '1.0.0', tools: 5, dbReady: true,
  });

  const status = (cookie) => api('/auth/status', { cookie }).then(json);
  assert.deepEqual(await status(), { authenticated: false, adminConfigured: true, publicOrigin: PUBLIC_ORIGIN });
  for (const path of ['/overview', '/groups', '/logs', `/logs/${LOG_A}/messages`, `/logs/${LOG_A}/participants`, `/logs/${LOG_A}/export`, '/links']) {
    assert.deepEqual(await json(await api(path), 401), { error: '请先登录管理台' });
  }
  await json(await api('/auth/login', {
    method: 'POST', body: { password: PASSWORD }, headers: { origin: 'https://foreign.example.test' },
  }), 403);
  const loginResponse = await login();
  assert.deepEqual(await json(loginResponse), { ok: true });
  const cookie = cookieOf(loginResponse);
  const setCookie = loginResponse.headers.get('set-cookie');
  assert.match(setCookie, /;\s*Path=\/sealdice-logs(?:;|$)/i);
  assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(setCookie, /;\s*Secure(?:;|$)/i);
  assert.match(setCookie, /;\s*SameSite=(?:Strict|Lax)(?:;|$)/i);
  assert.equal((await status(cookie)).authenticated, true);
  assert.equal((await status(cookie.replace(/=./, (m) => m === '=A' ? '=B' : '=A'))).authenticated, false);
  const read = (path) => api(path, { cookie }).then(json);
  await json(await api('/links', {
    method: 'POST', cookie, body: { label: '跨站请求' }, headers: { origin: 'https://foreign.example.test' },
  }), 403);

  assert.deepEqual(await read('/overview'), {
    stats: { totalLogs: 4, totalMessages: 10, activeRecordingCount: 1, groupCount: 2, latestMessageAt: now - 20 },
    links: { total: 0, enabled: 0, totalCalls: 0 }, publicOrigin: PUBLIC_ORIGIN,
  });
  const { items: groups } = await read(`/groups?q=${encodeURIComponent('调查组')}`);
  assert.deepEqual(groups, [{
    group_id: GROUP_A, group_name: '月港调查组', display_name: '月港调查组', system: 'coc7',
    log_on: true, log_cur_name: '月港失踪案', log_count: 2, latest_updated_at: now - 40,
  }]);
  const pageOfLogs = await read('/logs?limit=1&offset=1');
  assert.equal(pageOfLogs.total, 4);
  assert.equal(pageOfLogs.limit, 1);
  assert.equal(pageOfLogs.offset, 1);
  assert.deepEqual(pageOfLogs.items.map((entry) => entry.id), [LOG_A_HISTORY]);
  const logs = await read(`/logs?group_id=${encodeURIComponent(GROUP_A)}&q=${encodeURIComponent('调查组')}&active_only=1&limit=40&offset=0`);
  assert.equal(logs.total, 1);
  const [log] = logs.items;
  assert.equal(log.id, LOG_A);
  assert.equal(log.is_recording, true);
  assert.equal(log.display_group_name, '月港调查组');
  assert.equal(log.system, 'coc7');
  assert.equal(log.updated_at_iso, new Date((now - 60) * 1000).toISOString());

  const people = await read(`/logs/${LOG_A}/participants`);
  assert.equal(people.log.id, LOG_A);
  assert.equal(people.total, 7);
  assert.equal(people.first_time, now - 7200);
  assert.equal(people.last_time, now - 60);
  assert.deepEqual(people.breakdown, { ic: 4, dialogue: 2, ooc: 3, dice_result: 1, dice_command: 1 });
  assert.deepEqual(people.participants.find((person) => person.nickname === '调查员'), {
    nickname: '调查员', im_userid: 'QQ:101', total: 4, ic: 2, ooc: 2, dice: 1, last_time: now - 300,
  });

  const filters = `filter_mode=ic&include_dice=0&q=${encodeURIComponent('线索')}&limit=2`;
  const messages = await read(`/logs/${LOG_A}/messages?${filters}`);
  assert.equal(messages.log.id, LOG_A);
  assert.equal(messages.filter_mode, 'ic');
  assert.equal(messages.include_dice, false);
  assert.equal(messages.scanned_count, 7);
  assert.deepEqual(messages.filtered_out, { ooc: 3, ic: 0, dice: 2, speaker: 0, query: 1 });
  assert.equal(messages.returned_count, 1);
  assert.equal(messages.first_id, 16);
  assert.equal(messages.last_id, 16);
  assert.equal(messages.next_cursor_id, 18);
  assert.equal(messages.latest_log_id, 18);
  assert.equal(messages.latest_log_time, now - 60);
  assert.deepEqual(messages.items.map(({ id, time, nickname, channel, kind, message }) => ({ id, time, nickname, channel, kind, message })), [
    { id: 16, time: now - 360, nickname: '调查员', channel: 'ic', kind: 'dialogue', message: '灯塔线索[图片]' },
  ]);
  assert.equal(Object.hasOwn(messages.items[0], 'raw_cq'), false);
  const rawMessages = await read(`/logs/${LOG_A}/messages?${filters}&include_raw_cq=1`);
  assert.equal(rawMessages.items[0].raw_cq, '灯塔线索[CQ:image,file=test.png]');
  const exported = await api(`/logs/${LOG_A}/export?${filters}&format=txt&download=1`, { cookie });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type') ?? '', /^text\/plain\b/);
  assert.match(exported.headers.get('content-disposition') ?? '', /^attachment\b/);
  const transcript = await exported.text();
  assert.match(transcript, /\[#16 \| .* \| 场内\] 调查员: 灯塔线索\[图片\]/);
  assert.doesNotMatch(transcript, /已删除线索|尾部场外/);
  const exportedJson = await read(`/logs/${LOG_A}/export?${filters}&format=json`);
  assert.deepEqual(exportedJson.items, messages.items);

  const logout = await api('/auth/logout', { method: 'POST', cookie });
  assert.deepEqual(await json(logout), { ok: true });
  assert.match(logout.headers.get('set-cookie') ?? '', /^sealdice_logs_admin_session=;/);
  assert.equal((await status(cookie)).authenticated, false);
  assert.deepEqual(await json(await api('/overview', { cookie }), 401), { error: '请先登录管理台' });
});

test('管理台拒绝连续错误密码，伪造转发地址无法绕开限流', { timeout: TEST_TIMEOUT }, async (t) => {
  const { api, login } = await start(t);
  let limited = false;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const response = await api('/auth/login', {
      method: 'POST', body: { password: '错误密码' }, headers: { 'x-forwarded-for': `198.51.100.${attempt + 1}` },
    });
    if (response.status === 429) {
      assert.ok(attempt > 0);
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      await json(response, 429);
      limited = true;
      break;
    }
    await json(response, 401);
  }
  assert.equal(limited, true);
  await json(await login(), 429);
});

test('MCP 按群与日志隔离，链接收窄、停用、轮换和删除会撤销会话', { timeout: TEST_TIMEOUT }, async (t) => {
  const { fetch, api, login, connect, insertMessage } = await start(t);
  const auth = await login();
  await json(auth);
  const cookie = cookieOf(auth);
  const mutate = (method, path, body, status) => api(path, { method, cookie, body }).then((r) => json(r, status));
  const read = (path) => api(path, { cookie }).then(json);
  const deniedToken = `/sealdice-logs-mcp/${Buffer.alloc(32, 7).toString('base64url')}/mcp`;
  for (const method of ['GET', 'POST', 'DELETE']) {
    await json(await rpc(fetch, deniedToken, method), 404);
  }
  await json(await rpc(fetch, '/mcp', 'POST'), 404);
  await mutate('POST', '/links', { label: '无效范围', scope: { type: 'restricted', group_ids: [], log_ids: [] } }, 400);
  await mutate('POST', '/links', { label: '无效类型', scope: { type: 'restricted', group_ids: [], log_ids: ['1'] } }, 400);
  const { item: groupLink } = await mutate('POST', '/links', {
    label: '仅甲群', expires_in_hours: 24, scope: { type: 'restricted', group_ids: [GROUP_A, GROUP_A], log_ids: [] },
  }, 201);
  assert.match(groupLink.id, /^lnk_[a-f0-9]{12}$/);
  assert.equal(new URL(groupLink.url).origin, PUBLIC_ORIGIN);
  assert.match(new URL(groupLink.url).pathname, /^\/sealdice-logs-mcp\/[A-Za-z0-9_-]{43}\/mcp$/);
  assert.equal(groupLink.expired, false);
  assert.equal(Date.parse(groupLink.expires_at) - Date.parse(groupLink.created_at), 86_400_000);
  assert.deepEqual(groupLink.scope, { type: 'restricted', group_ids: [GROUP_A], log_ids: [] });
  assert.deepEqual(groupLink.scope_labels, { groups: [{ group_id: GROUP_A, display_name: '月港调查组' }], logs: [] });
  const { item: logLink } = await mutate('POST', '/links', {
    label: '仅乙群一份日志', expires_in_hours: null, scope: { type: 'restricted', group_ids: [], log_ids: [LOG_B] },
  }, 201);
  assert.equal(logLink.expires_at, null);
  assert.equal(logLink.scope_labels.logs[0].name, '保密副本');

  const groupPath = new URL(groupLink.url).pathname;
  const logPath = new URL(logLink.url).pathname;
  const groupSession = await connect(groupPath, { watchStream: true });
  const initialId = groupSession.transport.sessionId;
  const sse = await groupSession.stream;
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type') ?? '', /^text\/event-stream\b/);
  const tools = await groupSession.client.listTools(undefined, { timeout: REQUEST_TIMEOUT });
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'get_log_messages', 'get_log_participants', 'get_recent_updates', 'list_logs', 'search_log_messages',
  ]);
  for (const tool of tools.tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }
  const call = (session, name, args = {}) => session.client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT });
  let groupCalls = 0;
  const succeed = async (session, name, args) => {
    const result = await call(session, name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.ok(result.structuredContent);
    if (session === groupSession) groupCalls += 1;
    return result;
  };
  const listed = await succeed(groupSession, 'list_logs');
  assert.deepEqual(listed.structuredContent.items.map((entry) => entry.log_id), [LOG_A_HISTORY, LOG_A]);
  assert.doesNotMatch(JSON.stringify(listed), /保密副本|OpenQQ-Group/);
  const [activeLogs, groupSearch] = await Promise.all([
    succeed(groupSession, 'list_logs', { active_only: true }),
    succeed(groupSession, 'list_logs', { query: '调查组', offset: 1, limit: 1 }),
  ]);
  assert.deepEqual(activeLogs.structuredContent.items.map((entry) => entry.log_id), [LOG_A]);
  assert.deepEqual(groupSearch.structuredContent.items.map((entry) => entry.log_id), [LOG_A]);
  const messages = await succeed(groupSession, 'get_log_messages', { group_id: GROUP_A, filter_mode: 'ic', include_dice: false });
  assert.equal(messages.structuredContent.log.log_id, LOG_A);
  assert.deepEqual(messages.structuredContent.items.map((item) => item.id), [11, 16]);
  assert.equal(messages.structuredContent.next_cursor_id, 18);
  assert.match(messages.content[0].text, /\[#16 \| .* \| 场内\] 调查员: 灯塔线索\[图片\]/);
  const matches = await succeed(groupSession, 'search_log_messages', { query: '线索', context_lines: 1 });
  assert.equal(matches.structuredContent.matches.length, 1);
  assert.doesNotMatch(JSON.stringify(matches), /私密线索|保密结局|已删除线索/);
  const participants = await succeed(groupSession, 'get_log_participants', { log_id: LOG_A_HISTORY });
  assert.equal(participants.structuredContent.total, 1);
  for (const [name, args] of [
    ['get_log_messages', { log_id: LOG_B }],
    ['get_log_messages', { group_id: GROUP_B }],
    ['get_recent_updates', { log_id: LOG_B, since_id: 0 }],
    ['search_log_messages', { query: '线索', log_id: LOG_B }],
    ['get_log_participants', { log_id: LOG_B }],
    ['get_log_participants', { log_id: 99999 }],
  ]) {
    const result = await call(groupSession, name, args);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: DENIED }]);
    assert.equal(result.structuredContent, undefined);
  }
  insertMessage({ id: 19, message: '（等一下）' });
  insertMessage({ id: 20, message: '[CQ:reply,id=12](稍后回来)' });
  const noNewIc = await succeed(groupSession, 'get_recent_updates', { log_id: LOG_A, since_id: 18 });
  assert.deepEqual(noNewIc.structuredContent.items, []);
  assert.equal(noNewIc.structuredContent.next_cursor_id, 20);
  assert.equal(noNewIc.structuredContent.filtered_out.ooc, 2);
  assert.match(noNewIc.content[0].text, /场外/);
  insertMessage({ id: 22, message: '继续调查' });
  const incremental = await succeed(groupSession, 'get_recent_updates', { log_id: LOG_A, since_id: 20 });
  assert.deepEqual(incremental.structuredContent.items.map((item) => item.id), [22]);
  assert.equal(incremental.structuredContent.next_cursor_id, 22);

  const logSession = await connect(logPath);
  const logList = await succeed(logSession, 'list_logs');
  assert.deepEqual(logList.structuredContent.items.map((entry) => entry.log_id), [LOG_B]);
  const groupNeighbor = await call(logSession, 'get_log_messages', { log_id: LOG_B_EMPTY });
  assert.equal(groupNeighbor.isError, true);
  assert.deepEqual(groupNeighbor.content, [{ type: 'text', text: DENIED }]);
  await json(await rpc(fetch, logPath, 'POST', initialId), 404);
  await json(await rpc(fetch, logPath, 'DELETE', initialId), 404);
  const panel = await read('/links');
  assert.equal(panel.publicOrigin, PUBLIC_ORIGIN);
  const recorded = panel.items.find((entry) => entry.id === groupLink.id);
  assert.equal(recorded.call_count, groupCalls);
  assert.ok(Date.parse(recorded.last_used_at));
  assert.deepEqual((await read('/overview')).links, { total: 2, enabled: 2, totalCalls: groupCalls + 1 });

  const { item: narrowed } = await mutate('PATCH', `/links/${groupLink.id}`, {
    label: '仅甲群前传', scope: { type: 'restricted', group_ids: [], log_ids: [LOG_A_HISTORY] },
  });
  await sse.text();
  assert.equal(narrowed.url, groupLink.url);
  assert.deepEqual(narrowed.scope_labels.logs, [{ id: LOG_A_HISTORY, name: '月港前传', display_group_name: '月港调查组' }]);
  await json(await rpc(fetch, groupPath, 'POST', initialId), 404);
  await groupSession.client.close();
  const narrowedSession = await connect(groupPath);
  assert.deepEqual((await succeed(narrowedSession, 'list_logs')).structuredContent.items.map((entry) => entry.log_id), [LOG_A_HISTORY]);

  await mutate('PATCH', `/links/${groupLink.id}`, { enabled: false });
  await json(await rpc(fetch, groupPath, 'POST', narrowedSession.transport.sessionId), 404);
  await mutate('PATCH', `/links/${groupLink.id}`, { enabled: true, expires_in_hours: null });
  await json(await rpc(fetch, groupPath, 'POST', narrowedSession.transport.sessionId), 404);
  const enabledSession = await connect(groupPath);
  const { item: expired } = await mutate('PATCH', `/links/${groupLink.id}`, { expires_in_hours: 0 });
  assert.equal(expired.expired, true);
  await json(await rpc(fetch, groupPath, 'POST', enabledSession.transport.sessionId), 404);
  await mutate('PATCH', `/links/${groupLink.id}`, { expires_in_hours: null });
  await json(await rpc(fetch, groupPath, 'POST', enabledSession.transport.sessionId), 404);
  const beforeRotation = await connect(groupPath);
  const { item: rotated } = await mutate('POST', `/links/${groupLink.id}/rotate`);
  const rotatedPath = new URL(rotated.url).pathname;
  assert.notEqual(rotatedPath, groupPath);
  await json(await rpc(fetch, groupPath, 'POST', beforeRotation.transport.sessionId), 404);
  await json(await rpc(fetch, rotatedPath, 'POST', beforeRotation.transport.sessionId), 404);

  const freshSession = await connect(rotatedPath);
  const finishedId = freshSession.transport.sessionId;
  const finish = await rpc(fetch, rotatedPath, 'DELETE', finishedId);
  assert.ok(finish.ok, await finish.text());
  await json(await rpc(fetch, rotatedPath, 'POST', finishedId), 404);
  const deletedSession = await connect(rotatedPath);
  assert.deepEqual(await mutate('DELETE', `/links/${groupLink.id}`), { ok: true, id: groupLink.id });
  await json(await rpc(fetch, rotatedPath, 'POST', deletedSession.transport.sessionId), 404);
  assert.deepEqual((await read('/links')).items.map((entry) => entry.id), [logLink.id]);
  assert.equal((await succeed(logSession, 'list_logs')).structuredContent.total, 1);
});

test('本机调试入口启用时，用全量权限连接 MCP', { timeout: TEST_TIMEOUT }, async (t) => {
  const { connect } = await start(t, { enableUnauthLocalMcp: true });
  const { client } = await connect('/mcp');
  assert.equal(client.getServerVersion().name, 'sealdice-logs-mcp');
  assert.equal(client.getServerVersion().version, '1.0.0');
  const result = await client.callTool({ name: 'list_logs', arguments: {} }, undefined, { timeout: REQUEST_TIMEOUT });
  assert.equal(result.structuredContent.total, 4);
});
