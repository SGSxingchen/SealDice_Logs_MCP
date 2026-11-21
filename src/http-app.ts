import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { AdminAuth } from './admin-auth.js';
import { mountAdminRoutes, requestOrigin } from './admin-routes.js';
import { HttpError, LOG_UNAVAILABLE } from './errors.js';
import { ALL_SCOPE, LinkStore, type McpLinkRecord } from './link-store.js';
import { createMcpServer, MCP_INFO, MCP_TOOL_COUNT } from './mcp-tools.js';
import { allowedOriginsFrom, httpOrigin, publicOriginFrom, readRuntimeConfig, registerShutdown } from './runtime.js';
import { SealDiceDb } from './sealdice-db.js';

const MCP_METHODS = ['POST', 'GET', 'DELETE'];
const MAX_MCP_SESSIONS = 4096;
const MAX_TIMER_MS = 2 ** 31 - 1;
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface StreamableHttpAppOptions {
  db: SealDiceDb;
  stateDir: string;
  adminPassword?: string;
  bootstrapLinks?: string;
  publicOrigin?: string;
  allowedOrigins?: string | readonly string[];
  enableUnauthLocalMcp?: boolean;
}

interface Session {
  id: string;
  linkId?: string;
  token?: string;
  transport: StreamableHTTPServerTransport;
  activeRequests: number;
  expiryTimer?: NodeJS.Timeout;
  lastActivity: number;
}

function unavailableSession(): HttpError {
  return new HttpError(404, '找不到 MCP 会话或链接');
}

const sendError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error?.status === 400 || error?.status === 413 || error?.status === 415) {
    const message = error.status === 413 ? '请求体过大' : '请求格式无效';
    res.status(error.status).json({ error: message });
    return;
  }
  console.error('处理 HTTP 请求失败', error);
  res.status(500).json({ error: '服务暂不可用' });
};

export async function createStreamableHttpApp(options: StreamableHttpAppOptions) {
  const { db } = options;
  const publicOrigin = publicOriginFrom(options.publicOrigin);
  const allowed = allowedOriginsFrom(options.allowedOrigins);
  const [auth, linkStore] = await Promise.all([
    AdminAuth.open(options.stateDir, options.adminPassword),
    LinkStore.open(options.stateDir, options.bootstrapLinks),
  ]);
  const app = express();
  app.disable('x-powered-by');
  const sessions = new Map<string, Session>();
  let closing: Promise<void> | undefined;

  function forget(session: Session): void {
    sessions.delete(session.id);
    clearTimeout(session.expiryTimer);
  }

  async function closeSession(session: Session): Promise<void> {
    forget(session);
    await session.transport.close();
  }

  async function revokeLinkSessions(linkId: string): Promise<void> {
    await Promise.all([...sessions.values()].filter(session => session.linkId === linkId).map(closeSession));
  }

  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const session of sessions.values()) {
      if (session.activeRequests === 0 && session.lastActivity < cutoff) {
        void closeSession(session).catch(error => console.error('清理空闲 MCP 会话失败', error));
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS).unref();

  function close(): Promise<void> {
    clearInterval(sweepTimer);
    return closing ??= Promise.all([...sessions.values()].map(closeSession)).then(() => {});
  }

  function watchExpiry(session: Session, expiresAt: string | null): void {
    if (expiresAt === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(1, Date.parse(expiresAt) - Date.now()));
    session.expiryTimer = setTimeout(() => {
      const link = linkStore.findActiveByToken(session.token!);
      if (!link || link.id !== session.linkId) {
        void closeSession(session).catch(error => console.error('关闭过期的 MCP 会话失败', error));
      } else {
        watchExpiry(session, link.expires_at);
      }
    }, delay).unref();
  }

  async function serveSession(session: Session, req: Request, res: ServerResponse): Promise<void> {
    session.activeRequests += 1;
    session.lastActivity = Date.now();
    try {
      await session.transport.handleRequest(req, res, req.body);
    } finally {
      session.activeRequests -= 1;
      session.lastActivity = Date.now();
    }
  }

  const checkOrigin: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const header = req.get('origin');
    if (header !== undefined && allowed !== '*') {
      const source = httpOrigin(header);
      const valid = source !== undefined
        && (allowed ? allowed.has(source) : source === publicOrigin || source === requestOrigin(req));
      if (!valid) throw new HttpError(403, '此请求来源未获准访问 MCP');
    }
    next();
  };
  const mcpCors = cors({
    origin: allowed === '*' ? '*' : true,
    methods: [...MCP_METHODS, 'OPTIONS'],
    exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
  });
  const mcpJson = express.json({ limit: '256kb', inflate: false });

  function mcpHandlers(requireLink: boolean): RequestHandler[] {
    function findLink(req: Request): McpLinkRecord | undefined {
      if (!requireLink) return undefined;
      const token = req.params.token;
      const link = typeof token === 'string' ? linkStore.findActiveByToken(token) : undefined;
      if (!link) throw unavailableSession();
      return link;
    }

    return [
      checkOrigin,
      mcpCors,
      (req, res, next) => {
        findLink(req);
        if (!MCP_METHODS.includes(req.method)) {
          res.set('Allow', [...MCP_METHODS, 'OPTIONS'].join(', '));
          throw new HttpError(405, 'MCP 入口不支持此请求方法');
        }
        next();
      },
      mcpJson,
      async (req, res) => {
        if (closing) throw new HttpError(503, 'MCP 服务正在停止');
        const link = findLink(req);
        const id = req.get('mcp-session-id');
        if (id !== undefined) {
          const session = sessions.get(id);
          if (!session || session.linkId !== link?.id || session.token !== link?.token) throw unavailableSession();
          await serveSession(session, req, res);
          return;
        }
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          throw new HttpError(400, '请先初始化 MCP 会话或提供 Mcp-Session-Id');
        }
        if (sessions.size >= MAX_MCP_SESSIONS) {
          const idle = [...sessions.values()].find(session => session.activeRequests === 0);
          if (!idle) throw new HttpError(503, 'MCP 会话数量已达到上限');
          void closeSession(idle).catch(error => console.error('清理空闲 MCP 会话失败', error));
        }

        const sessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
        const session: Session = { id: sessionId, linkId: link?.id, token: link?.token, transport, activeRequests: 0, lastActivity: Date.now() };
        const server = createMcpServer(db, () => {
          if (!sessions.has(sessionId)) throw new HttpError(404, LOG_UNAVAILABLE);
          if (!link) return ALL_SCOPE;
          const current = linkStore.findActiveByToken(link.token);
          if (!current || current.id !== session.linkId) throw new HttpError(404, LOG_UNAVAILABLE);
          return current.scope;
        }, link && (() => linkStore.recordUsage(link.id)));

        transport.onclose = () => forget(session);
        sessions.set(sessionId, session);
        if (link) watchExpiry(session, link.expires_at);
        try {
          await server.connect(transport);
          await serveSession(session, req, res);
        } finally {
          if (transport.sessionId !== sessionId || res.statusCode >= 400 || (res.destroyed && !res.writableFinished)) {
            await closeSession(session);
          }
        }
      },
    ];
  }

  app.get('/health', (_req, res) => {
    const dbReady = db.isReady();
    res.status(dbReady ? 200 : 503).json({
      status: dbReady ? 'ok' : 'unavailable', service: MCP_INFO.name, version: MCP_INFO.version, tools: MCP_TOOL_COUNT, dbReady,
    });
  });
  app.all('/sealdice-logs-mcp/:token/mcp', ...mcpHandlers(true));
  if (options.enableUnauthLocalMcp === true) app.all('/mcp', ...mcpHandlers(false));
  mountAdminRoutes(app, { db, auth, linkStore, publicOrigin, onRevokeLink: revokeLinkSessions });
  app.use((_req, res) => res.status(404).json({ error: '找不到该接口' }));
  app.use(sendError);

  return { app, close, revokeLinkSessions };
}

export async function startHttpServer() {
  const config = readRuntimeConfig();
  const db = new SealDiceDb(config.logsPath, config.dataPath);
  try {
    const service = await createStreamableHttpApp({ db, ...config });
    const server = createServer({ headersTimeout: 15_000, requestTimeout: 0 }, service.app);
    try {
      const listening = once(server, 'listening', { signal: AbortSignal.timeout(10_000) });
      server.listen(config.port, config.bindHost);
      await listening;
    } catch (error) {
      server.close();
      await service.close();
      throw error;
    }

    let stopping: Promise<void> | undefined;
    const close = () => stopping ??= (async () => {
      const drained = new Promise<void>(resolve => { server.close(() => resolve()); });
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
      try {
        await service.close();
      } finally {
        await drained;
        clearTimeout(deadline);
        db.close();
        unregister();
      }
    })();
    const unregister = registerShutdown(close);
    server.on('error', error => {
      console.error('海豹日志 HTTP 服务发生错误', error);
      process.exitCode = 1;
      void close().catch(error => console.error('停止海豹日志 HTTP 服务失败', error));
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.error(`海豹日志 HTTP 服务正在监听 ${config.bindHost} 端口 ${port}`);
    return { server, close };
  } catch (error) {
    db.close();
    throw error;
  }
}
