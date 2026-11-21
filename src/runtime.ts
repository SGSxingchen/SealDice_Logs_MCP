import { resolve } from 'node:path';

export function httpOrigin(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (!url.username && !url.password) return url.origin;
    }
  } catch {
    return undefined;
  }
}

export function publicOriginFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const origin = httpOrigin(value);
  if (!origin || !/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) {
    throw new Error('公开源必须是 HTTP 或 HTTPS 源，格式如 https://logs.example.com');
  }
  return origin;
}

export function allowedOriginsFrom(value: string | readonly string[] | undefined): '*' | Set<string> | undefined {
  const parts = (typeof value === 'string' ? value.split(',') : value ?? []).map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.includes('*')) return '*';
  return new Set(parts.map(part => publicOriginFrom(part)!));
}

export function readDatabasePaths(env = process.env) {
  const dataPath = env.SEALDICE_DATA_DB?.trim();
  return {
    logsPath: resolve(env.SEALDICE_LOGS_DB?.trim() || 'data/default/data-logs.db'),
    dataPath: dataPath ? resolve(dataPath) : undefined,
  };
}

export function readRuntimeConfig(env = process.env) {
  const port = Number(env.PORT?.trim() || '3004');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0 至 65535 的整数');

  const localMcp = env.MCP_ENABLE_UNAUTH_LOCAL_MCP?.trim().toLowerCase();
  if (localMcp && !['true', 'false', '1', '0'].includes(localMcp)) {
    throw new Error('MCP_ENABLE_UNAUTH_LOCAL_MCP 必须是 true、false、1 或 0');
  }
  return {
    ...readDatabasePaths(env),
    stateDir: resolve(env.MCP_STATE_DIR?.trim() || '.admin'),
    port,
    bindHost: env.MCP_BIND_HOST?.trim() || '127.0.0.1',
    publicOrigin: publicOriginFrom(env.MCP_PUBLIC_ORIGIN?.trim()),
    allowedOrigins: env.MCP_ALLOWED_ORIGINS,
    adminPassword: env.MCP_ADMIN_PASSWORD,
    bootstrapLinks: env.MCP_BOOTSTRAP_LINKS,
    enableUnauthLocalMcp: localMcp === 'true' || localMcp === '1',
  };
}

export function registerShutdown(close: () => Promise<void>): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void close().catch(error => {
      console.error('停止海豹日志服务失败', error);
      process.exitCode = 1;
    }).finally(unregister);
  };
  const unregister = () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return unregister;
}
