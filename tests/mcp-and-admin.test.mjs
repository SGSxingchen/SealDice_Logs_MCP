import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, duplexPair } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { writeAdminFile } from '../dist/admin-files.js';
import { createStreamableHttpApp } from '../dist/http-app.js';
import { ALL_SCOPE, LinkStore } from '../dist/link-store.js';
import { createMcpServer, getDisclosureMetrics } from '../dist/mcp-tools.js';
import { readRuntimeConfig } from '../dist/runtime.js';
import { SealDiceDb } from '../dist/sealdice-db.js';
import { createFixture, GROUP_A, GROUP_B, LOG_A, LOG_A_HISTORY, LOG_B, LOG_B_EMPTY } from './fixtures.mjs';

const ADMIN = '/sealdice-logs';
const PASSWORD = '测试环境专用-long-random-password';
const PUBLIC_ORIGIN = 'https://logs.example.test';
const DENIED = '找不到该日志或当前链接无权访问';
const REQUEST_TIMEOUT = 5000;
const TEST_TIMEOUT = 20000;
const ACTIONS = ['list_logs', 'get_log_messages', 'get_recent_updates', 'search_log_messages', 'get_log_participants'];
const META_TOOLS = ['sealdice_discover', 'sealdice_describe', 'sealdice_execute'];
const listTools = (client) => client.listTools(undefined, { timeout: REQUEST_TIMEOUT });
const callTool = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT });

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
    defaultDisclosureMode: readRuntimeConfig({}).defaultDisclosureMode, enableUnauthLocalMcp: false, ...options,
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
    disclosureMode: 'progressive', progressiveTools: 3, totalActions: 5,
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

test('legacy MCP 按群与日志隔离，链接收窄、停用、轮换和删除会撤销会话', { timeout: TEST_TIMEOUT }, async (t) => {
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
    label: '仅甲群', disclosure_mode: 'legacy', expires_in_hours: 24,
    scope: { type: 'restricted', group_ids: [GROUP_A, GROUP_A], log_ids: [] },
  }, 201);
  assert.match(groupLink.id, /^lnk_[a-f0-9]{12}$/);
  assert.equal(groupLink.disclosure_mode, 'legacy');
  assert.equal(new URL(groupLink.url).origin, PUBLIC_ORIGIN);
  assert.match(new URL(groupLink.url).pathname, /^\/sealdice-logs-mcp\/[A-Za-z0-9_-]{43}\/mcp$/);
  assert.equal(groupLink.expired, false);
  assert.equal(Date.parse(groupLink.expires_at) - Date.parse(groupLink.created_at), 86_400_000);
  assert.deepEqual(groupLink.scope, { type: 'restricted', group_ids: [GROUP_A], log_ids: [] });
  assert.deepEqual(groupLink.scope_labels, { groups: [{ group_id: GROUP_A, display_name: '月港调查组' }], logs: [] });
  const { item: logLink } = await mutate('POST', '/links', {
    label: '仅乙群一份日志', disclosure_mode: 'legacy', expires_in_hours: null,
    scope: { type: 'restricted', group_ids: [], log_ids: [LOG_B] },
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
  const tools = await listTools(groupSession.client);
  assert.deepEqual(tools.tools.map((tool) => tool.name), ACTIONS);
  for (const tool of tools.tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }
  const call = (session, name, args) => callTool(session.client, name, args);
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

test('本机调试入口默认以渐进式工具提供全量权限', { timeout: TEST_TIMEOUT }, async (t) => {
  const { connect } = await start(t, { enableUnauthLocalMcp: true });
  const { client } = await connect('/mcp');
  assert.equal(client.getServerVersion().name, 'sealdice-logs-mcp');
  assert.equal(client.getServerVersion().version, '1.0.0');
  assert.deepEqual((await listTools(client)).tools.map(({ name }) => name), META_TOOLS);
  assert.equal((await callTool(client, 'sealdice_discover')).structuredContent.scope.type, 'all');
  const result = await callTool(client, 'sealdice_execute', { action: 'list_logs' });
  assert.equal(result.structuredContent.total, 4);
});

test('工具注册单测验证默认三元工具及初始上下文大小', { timeout: TEST_TIMEOUT }, async (t) => {
  const { logsPath, dataPath } = createFixture(t);
  const db = new SealDiceDb(logsPath, dataPath);
  t.after(() => db.close());
  async function readContext(mode) {
    const server = createMcpServer(db, ALL_SCOPE, undefined, mode);
    const client = new Client({ name: 'sealdice-tools-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport, { timeout: REQUEST_TIMEOUT });
      return { instructions: client.getInstructions(), listing: await listTools(client) };
    } finally {
      await client.close();
    }
  }
  const [progressive, legacy] = await Promise.all([readContext(), readContext('legacy')]);
  assert.deepEqual(progressive.listing.tools.map(({ name }) => name), META_TOOLS);
  assert.deepEqual(legacy.listing.tools.map(({ name }) => name), ACTIONS);
  for (const { annotations } of progressive.listing.tools) {
    assert.deepEqual(annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  }
  assert.equal(progressive.instructions, '先用 sealdice_discover 查看动作与授权范围，再用 sealdice_describe 取参数与游标规则，最后用 sealdice_execute 读取日志。');
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const contextBytes = ({ instructions, listing }) => bytes({ instructions, tools: listing.tools });
  assert.ok(bytes(progressive.listing) < bytes(legacy.listing) * 0.65);
  const progressiveBytes = contextBytes(progressive);
  const legacyBytes = contextBytes(legacy);
  assert.deepEqual(getDisclosureMetrics(), {
    progressiveTools: 3, legacyTools: 5, progressiveBytes, legacyBytes,
    estimatedSavedPercent: Math.round((1 - progressiveBytes / legacyBytes) * 10_000) / 100,
  });
  t.diagnostic(`tools/list：${bytes(legacy.listing)} → ${bytes(progressive.listing)} 字节，含初始化指引：${legacyBytes} → ${progressiveBytes} 字节`);
});

test('渐进式协议按需披露 Schema，并保留范围隔离、翻页、续读与译名', { timeout: TEST_TIMEOUT }, async (t) => {
  const { api, login, connect, insertMessage } = await start(t);
  const auth = await login();
  await json(auth);
  const cookie = cookieOf(auth);
  const { item } = await json(await api('/links', {
    method: 'POST', cookie, body: { label: '仅甲群', scope: { type: 'restricted', group_ids: [GROUP_A] } },
  }), 201);
  assert.equal(item.disclosure_mode, 'progressive');
  const { item: legacyItem } = await json(await api('/links', {
    method: 'POST', cookie, body: { label: '旧客户端', disclosure_mode: 'legacy' },
  }), 201);
  const { client } = await connect(new URL(item.url).pathname);
  const { client: legacyClient } = await connect(new URL(legacyItem.url).pathname);
  const legacy = await listTools(legacyClient);
  const panel = await json(await api('/links', { cookie }));
  assert.deepEqual(panel.disclosure, getDisclosureMetrics());

  const discover = (args) => callTool(client, 'sealdice_discover', args).then(({ structuredContent }) => structuredContent);
  const discovery = await discover();
  assert.deepEqual(discovery.scope.group_ids, [GROUP_A]);
  assert.deepEqual(discovery.scope.log_ids, []);
  assert.match(discovery.scope.summary, /指定群/);
  assert.doesNotMatch(JSON.stringify(discovery), /保密副本|OpenQQ-Group/);
  assert.deepEqual(discovery.actions.map(({ action }) => action), ACTIONS);
  assert.ok(discovery.actions.every((entry) => Object.keys(entry).length === 2 && entry.summary));
  assert.deepEqual(discovery.guides.map(({ name }) => name), ['cursor_workflow', 'filters']);
  assert.deepEqual((await discover({ query: 'GET_RECENT' })).actions.map(({ action }) => action), ['get_recent_updates']);

  const describe = (args) => callTool(client, 'sealdice_describe', args).then(({ structuredContent }) => structuredContent);
  const details = await describe({ actions: ['get_log_messages', 'get_recent_updates'], guide: 'cursor_workflow' });
  assert.deepEqual(details.actions.map(({ action }) => action), ['get_log_messages', 'get_recent_updates']);
  for (const { action, inputSchema, parameters, examples } of details.actions) {
    assert.deepEqual(inputSchema, legacy.tools.find(({ name }) => name === action).inputSchema);
    assert.deepEqual(Object.keys(parameters).sort(), Object.keys(inputSchema.properties).sort());
    assert.ok(examples.some((example) => example.action === action && example.params.log_id));
  }
  assert.ok(details.guide.instructions.includes(legacyClient.getInstructions()));
  const filters = await describe({ guide: 'filters' });
  assert.deepEqual(filters.actions, []);
  assert.match(filters.guide.instructions, /括号/);
  for (const param of ['include_dice', 'start_time', 'end_time', 'last_minutes', 'speaker']) {
    assert.ok(filters.guide.instructions.includes(param));
  }

  let reads = 0;
  const execute = (action, params) => callTool(client, 'sealdice_execute', { action, params });
  const read = async (action, params) => {
    const result = await execute(action, params);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    reads += 1;
    return result.structuredContent;
  };
  const listed = await read('list_logs');
  assert.deepEqual(listed.items.map(({ log_id }) => log_id), [LOG_A_HISTORY, LOG_A]);
  const messageFilters = { log_id: listed.items[1].log_id, filter_mode: 'ic', include_dice: false };
  const tail = await read('get_log_messages', { ...messageFilters, limit: 1 });
  assert.deepEqual(tail.items.map(({ id }) => id), [16]);
  assert.equal(tail.next_cursor_id, 18);
  assert.equal(tail.has_older, true);
  const older = await read('get_log_messages', { ...messageFilters, before_id: tail.first_id });
  assert.deepEqual(older.items.map(({ id }) => id), [11]);

  insertMessage({ id: 19, message: '（稍等）' });
  insertMessage({ id: 20, message: '[CQ:reply,id=16](回来了)' });
  const empty = await read('get_recent_updates', { log_id: LOG_A, since_id: tail.next_cursor_id });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.next_cursor_id, 20);
  assert.equal(empty.filtered_out.ooc, 2);
  const hexId = 'AABBCCDDEEFF00112233445566778899';
  insertMessage({ id: 22, nickname: '观测员', im_userid: `OpenQQ:400-${hexId}`, message: '找到路了' });
  insertMessage({ id: 23, nickname: '向导', im_userid: 'QQ:123456789', message: '我来带路' });
  insertMessage({ id: 24, message: `<@${hexId}> [CQ:at,qq=123456789] 看灯塔` });
  const firstUpdate = await read('get_recent_updates', { log_id: LOG_A, since_id: empty.next_cursor_id, limit: 2 });
  assert.deepEqual(firstUpdate.items.map(({ id }) => id), [22, 23]);
  assert.equal(firstUpdate.has_newer, true);
  const translated = '[@观测员] [@向导] 看灯塔';
  const nextUpdate = await execute('get_recent_updates', { log_id: LOG_A, since_id: firstUpdate.next_cursor_id });
  reads += 1;
  assert.deepEqual(nextUpdate.structuredContent.items.map(({ id, message }) => [id, message]), [[24, translated]]);
  assert.ok(nextUpdate.content[0].text.includes(translated));
  assert.equal(nextUpdate.structuredContent.has_newer, false);
  const search = await read('search_log_messages', { query: ' 观测员 ', context_lines: 1 });
  assert.deepEqual(search.matches.map(({ message }) => message.id), [24]);
  assert.equal((await read('get_log_participants', { log_id: LOG_A_HISTORY })).total, 1);

  for (const [action, params] of [
    ['get_log_messages', { log_id: LOG_B }], ['get_log_messages', { group_id: GROUP_B }],
    ['get_recent_updates', { log_id: LOG_B, since_id: 0 }], ['get_log_participants', { log_id: 99999 }],
  ]) {
    const denied = await execute(action, params);
    assert.equal(denied.isError, true);
    assert.deepEqual(denied.content, [{ type: 'text', text: DENIED }]);
    assert.equal(denied.structuredContent, undefined);
  }
  for (const [action, params] of [
    ['get_log_messages', { log_id: '1' }], ['search_log_messages', { query: '  ' }],
    ['get_log_participants', {}], ['constructor', {}],
  ]) assert.equal((await execute(action, params)).isError, true);

  await json(await api(`/links/${item.id}`, {
    method: 'PATCH', cookie, body: { scope: { type: 'restricted', group_ids: [GROUP_A], log_ids: [LOG_B] } },
  }));
  assert.deepEqual((await discover()).scope.log_ids, [LOG_B]);
  assert.equal((await read('get_log_messages', { log_id: LOG_B })).log.log_id, LOG_B);
  assert.equal((await execute('get_log_messages', { log_id: LOG_B_EMPTY })).isError, true);
  const recorded = await json(await api(`/links/${item.id}`, { cookie }));
  assert.equal(recorded.item.call_count, reads);
});

test('旧链接缺省为渐进式，切换模式断开旧会话并持久化', { timeout: TEST_TIMEOUT }, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'sealdice-link-test-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const id = 'lnk_000000000001';
  const token = Buffer.alloc(32, 19).toString('base64url');
  const timestamp = new Date().toISOString();
  await writeAdminFile(join(stateDir, 'links.json'), JSON.stringify([{
    id, token, label: '旧链接', enabled: true, scope: { type: 'all' },
    created_at: timestamp, updated_at: timestamp, expires_at: null, last_used_at: null, call_count: 0,
  }]));
  const { defaultDisclosureMode } = readRuntimeConfig({ SEALDICE_LOGS_MCP_DISCLOSURE_MODE: 'legacy' });
  assert.equal(defaultDisclosureMode, 'legacy');
  const { api, fetch, login, connect } = await start(t, { stateDir, defaultDisclosureMode, enableUnauthLocalMcp: true });
  assert.equal((await json(await fetch('/health'))).disclosureMode, 'legacy');
  const { client: local } = await connect('/mcp');
  assert.deepEqual((await listTools(local)).tools.map(({ name }) => name), ACTIONS);
  const auth = await login();
  await json(auth);
  const cookie = cookieOf(auth);
  const links = await json(await api('/links', { cookie }));
  assert.equal(links.items[0].id, id);
  assert.equal(links.items[0].disclosure_mode, 'progressive');
  const preferred = await json(await api('/links', { method: 'POST', cookie, body: { label: '新链接' } }), 201);
  assert.equal(preferred.item.disclosure_mode, 'progressive');
  await json(await api('/links', { method: 'POST', cookie, body: { label: '无效模式', disclosure_mode: 'unknown' } }), 400);

  const url = new URL(links.items[0].url);
  const initial = await connect(url.pathname, { watchStream: true });
  assert.deepEqual((await listTools(initial.client)).tools.map(({ name }) => name), META_TOOLS);
  const sse = await initial.stream;
  assert.equal(sse.status, 200);
  const patchMode = (mode, status) => api(`/links/${id}`, { method: 'PATCH', cookie, body: { disclosure_mode: mode } })
    .then((response) => json(response, status));
  await patchMode(null, 400);
  assert.deepEqual((await listTools(initial.client)).tools.map(({ name }) => name), META_TOOLS);
  const { item: updated } = await patchMode('legacy');
  assert.equal(updated.url, url.href);
  assert.equal(updated.disclosure_mode, 'legacy');
  await sse.text();
  await json(await rpc(fetch, url.pathname, 'POST', initial.transport.sessionId), 404);
  assert.equal((await LinkStore.open(stateDir)).getById(id).disclosure_mode, 'legacy');
  const switched = await connect(url.pathname);
  assert.deepEqual((await listTools(switched.client)).tools.map(({ name }) => name), ACTIONS);
  assert.equal((await callTool(switched.client, 'list_logs')).structuredContent.total, 4);
  const { item: restored } = await patchMode('progressive');
  assert.equal(restored.disclosure_mode, 'progressive');
  await json(await rpc(fetch, url.pathname, 'POST', switched.transport.sessionId), 404);
  assert.deepEqual((await listTools((await connect(url.pathname)).client)).tools.map(({ name }) => name), META_TOOLS);
  assert.deepEqual((await listTools(local)).tools.map(({ name }) => name), ACTIONS);
});

test('stdio 默认注册渐进式工具，环境变量可以切回 legacy', { timeout: TEST_TIMEOUT }, async (t) => {
  const { logsPath, dataPath } = createFixture(t);
  for (const [mode, expected] of [[undefined, META_TOOLS], ['legacy', ACTIONS]]) {
    const client = new Client({ name: 'sealdice-stdio-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
      env: {
        SEALDICE_LOGS_DB: logsPath, SEALDICE_DATA_DB: dataPath,
        ...(mode ? { SEALDICE_LOGS_MCP_DISCLOSURE_MODE: mode } : {}),
      },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT });
      assert.deepEqual((await listTools(client)).tools.map(({ name }) => name), expected);
    } finally {
      await client.close();
    }
  }
});
