import { fileURLToPath } from 'node:url';
import express, { type Express, type Request } from 'express';
import type { AdminAuth } from './admin-auth.js';
import { SerializedWrites } from './admin-files.js';
import { HttpError } from './errors.js';
import { ALL_SCOPE, isLinkExpired, type LinkScope, type LinkStore, type McpLinkRecord } from './link-store.js';
import { getDisclosureMetrics } from './mcp-tools.js';
import { httpOrigin } from './runtime.js';
import type { MessageOptions, SealDiceDb } from './sealdice-db.js';
import { formatTranscript } from './transcript.js';

const ADMIN_PATH = '/sealdice-logs';
const ADMIN_WEB = fileURLToPath(new URL('../web/admin/', import.meta.url));
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'";
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

interface AdminOptions {
  db: SealDiceDb;
  auth: AdminAuth;
  linkStore: LinkStore;
  publicOrigin?: string;
  onRevokeLink: (id: string) => void | Promise<void>;
}

export function requestOrigin(req: Request, protocol = `${req.protocol}:`): string | undefined {
  const host = req.get('host');
  return host && /^[^/?#\\@\s]+$/.test(host) ? httpOrigin(`${protocol}//${host}`) : undefined;
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${name} 只接受单个值`);
  return value.trim() || undefined;
}

function queryNumber(req: Request, name: string): number | undefined {
  const value = queryString(req, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, `${name} 必须是数字`);
  return number;
}

function queryFlag(req: Request, name: string): boolean | undefined {
  const value = queryString(req, name);
  if (value === undefined) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new HttpError(400, `${name} 必须是 1、0、true 或 false`);
}

function logId(req: Request): number {
  const param = req.params.logId;
  const value = Number(param);
  if (typeof param !== 'string' || !/^\d+$/.test(param) || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, '日志 ID 必须是正整数');
  }
  return value;
}

function messageOptions(req: Request, defaultLimit?: number): MessageOptions {
  const filter_mode = queryString(req, 'filter_mode');
  if (filter_mode !== undefined && filter_mode !== 'all' && filter_mode !== 'ic' && filter_mode !== 'ooc') {
    throw new HttpError(400, 'filter_mode 必须是 all、ic 或 ooc');
  }
  return {
    log_id: logId(req), filter_mode,
    include_dice: queryFlag(req, 'include_dice'), include_raw_cq: queryFlag(req, 'include_raw_cq'),
    speaker: queryString(req, 'speaker'), query: queryString(req, 'q') ?? queryString(req, 'query'),
    last_minutes: queryNumber(req, 'last_minutes'),
    start_time: queryString(req, 'start_time'), end_time: queryString(req, 'end_time'),
    limit: queryNumber(req, 'limit') ?? defaultLimit,
    after_id: queryNumber(req, 'after_id'), before_id: queryNumber(req, 'before_id'),
  };
}

function narrowed(before: LinkScope, after: LinkScope): boolean {
  if (after.type === 'all') return false;
  if (before.type === 'all') return true;
  const groups = new Set(after.group_ids);
  const logs = new Set(after.log_ids);
  return before.group_ids.some(id => !groups.has(id)) || before.log_ids.some(id => !logs.has(id));
}

function needsRevocation(before: McpLinkRecord, after: McpLinkRecord): boolean {
  const expiryReduced = after.expires_at !== null
    && (before.expires_at === null || Date.parse(after.expires_at) < Date.parse(before.expires_at));
  const now = Date.now();
  return !after.enabled || isLinkExpired(before, now) || isLinkExpired(after, now)
    || before.disclosure_mode !== after.disclosure_mode || expiryReduced || narrowed(before.scope, after.scope);
}

function presentLinks(db: SealDiceDb, links: McpLinkRecord[], origin: string | null) {
  const ids = [...new Set(links.flatMap(item => item.scope.log_ids))];
  const labels = (() => {
    try {
      return db.getLogLabels(ids);
    } catch (error) {
      // 日志库短时不可读时，管理台仍能停用或轮换链接。
      console.error('读取链接范围的日志名称失败', error);
      return undefined;
    }
  })();
  const now = Date.now();
  return links.map(item => {
    const { token, ...fields } = item;
    return {
      ...fields,
      expired: isLinkExpired(item, now),
      url: `${origin ?? ''}/sealdice-logs-mcp/${token}/mcp`,
      scope_labels: {
        groups: item.scope.group_ids.map(group_id => ({ group_id, display_name: db.getGroupDisplayName(group_id) })),
        logs: item.scope.log_ids.map(id => labels?.get(id) ?? { id, name: `日志 #${id}`, display_group_name: '' }),
      },
    };
  });
}

export function mountAdminRoutes(app: Express, options: AdminOptions): void {
  const { db, auth, linkStore, publicOrigin, onRevokeLink } = options;
  const linkUpdates = new SerializedWrites();
  const api = express.Router();
  const jsonBody = express.json({ limit: '8mb' });
  const origin = (req: Request) => publicOrigin ?? requestOrigin(req) ?? null;

  app.use(ADMIN_PATH, (_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': CSP,
    });
    next();
  });
  app.get(/^\/sealdice-logs$/, (_req, res) => res.redirect(302, `${ADMIN_PATH}/`));

  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const source = req.get('origin') ?? req.get('referer');
    if (!SAFE_METHODS.includes(req.method) && source !== undefined) {
      const parsed = httpOrigin(source);
      if (parsed === undefined || (parsed !== publicOrigin && parsed !== requestOrigin(req, new URL(parsed).protocol))) {
        throw new HttpError(403, '请求来源与管理台不同源');
      }
    }
    next();
  });
  api.get('/auth/status', (req, res) => {
    res.json({ authenticated: auth.authenticated(req), adminConfigured: true, publicOrigin: origin(req) });
  });
  api.post('/auth/login', express.json({ limit: '128kb' }), (req, res) => auth.login(req, res, publicOrigin));
  api.post('/auth/logout', (req, res) => auth.logout(req, res, publicOrigin));
  api.use((req, res, next) => {
    if (auth.authenticated(req)) next();
    else res.status(401).json({ error: '请先登录管理台' });
  });

  api.get('/overview', async (req, res) => {
    const stats = await db.getOverview();
    const links = linkStore.list();
    const now = Date.now();
    res.json({
      stats, publicOrigin: origin(req),
      links: {
        total: links.length,
        enabled: links.filter(item => item.enabled && !isLinkExpired(item, now)).length,
        totalCalls: links.reduce((count, item) => count + item.call_count, 0),
      },
    });
  });
  api.get('/groups', (req, res) => res.json({ items: db.getGroups(queryString(req, 'q')) }));
  api.get('/logs', (req, res) => res.json(db.listLogs(ALL_SCOPE, {
    query: queryString(req, 'q') ?? queryString(req, 'query'), group_id: queryString(req, 'group_id'),
    active_only: queryFlag(req, 'active_only'), limit: queryNumber(req, 'limit'), offset: queryNumber(req, 'offset'),
  })));
  api.get('/logs/:logId/participants', async (req, res) => {
    res.json(await db.getParticipants(ALL_SCOPE, logId(req)));
  });
  api.get('/logs/:logId/messages', async (req, res) => {
    res.json(await db.getMessages(ALL_SCOPE, messageOptions(req)));
  });
  api.get('/logs/:logId/export', async (req, res) => {
    const format = queryString(req, 'format') ?? 'txt';
    if (format !== 'txt' && format !== 'json') throw new HttpError(400, '导出格式必须是 txt 或 json');
    const download = queryFlag(req, 'download');
    const result = await db.getMessages(ALL_SCOPE, messageOptions(req, 5000));
    if (download) res.attachment(`sealdice-log-${result.log.id}.${format}`);
    if (format === 'json') res.json(result);
    else res.type('text/plain').send(formatTranscript(result));
  });

  api.get('/links', (req, res) => {
    const publicOrigin = origin(req);
    res.json({ items: presentLinks(db, linkStore.list(), publicOrigin), publicOrigin, disclosure: getDisclosureMetrics() });
  });
  api.get('/links/:linkId', (req, res) => {
    const link = linkStore.getById(req.params.linkId);
    if (!link) throw new HttpError(404, '找不到该链接');
    const [item] = presentLinks(db, [link], origin(req));
    res.json({ item });
  });
  api.post('/links', jsonBody, async (req, res) => {
    const link = await linkStore.create(req.body);
    const [item] = presentLinks(db, [link], origin(req));
    res.status(201).json({ item });
  });
  api.patch('/links/:linkId', jsonBody, async (req, res) => {
    const id = req.params.linkId;
    const link = await linkUpdates.run(async () => {
      const before = linkStore.getById(id);
      if (!before) throw new HttpError(404, '找不到该链接');
      const after = await linkStore.update(id, req.body);
      if (needsRevocation(before, after)) await onRevokeLink(id);
      return after;
    });
    const [item] = presentLinks(db, [link], origin(req));
    res.json({ item });
  });
  api.post('/links/:linkId/rotate', async (req, res) => {
    const link = await linkStore.rotate(req.params.linkId);
    await onRevokeLink(link.id);
    const [item] = presentLinks(db, [link], origin(req));
    res.json({ item });
  });
  api.delete('/links/:linkId', async (req, res) => {
    const id = req.params.linkId;
    await linkStore.delete(id);
    await onRevokeLink(id);
    res.json({ ok: true, id });
  });

  api.use((_req, res) => res.status(404).json({ error: '找不到该接口' }));
  app.use(`${ADMIN_PATH}/api`, api);
  app.use(ADMIN_PATH, express.static(ADMIN_WEB, { redirect: false }));
}
