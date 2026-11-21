#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ALL_SCOPE } from './link-store.js';
import { createMcpServer } from './mcp-tools.js';
import { readDatabasePaths, readDisclosureMode, registerShutdown } from './runtime.js';
import { SealDiceDb } from './sealdice-db.js';

async function startStdioServer(): Promise<void> {
  const { logsPath, dataPath } = readDatabasePaths();
  const disclosureMode = readDisclosureMode();
  const db = new SealDiceDb(logsPath, dataPath);
  try {
    const server = createMcpServer(db, ALL_SCOPE, undefined, disclosureMode);
    const transport = new StdioServerTransport();
    let stopping: Promise<void> | undefined;
    const close = () => stopping ??= (async () => {
      process.stdin.off('end', onEnd);
      try {
        await server.close();
      } finally {
        db.close();
        unregister();
      }
    })();
    const onEnd = () => {
      void close().catch(error => {
        console.error('停止海豹日志 stdio 服务失败', error);
        process.exitCode = 1;
      });
    };
    const unregister = registerShutdown(close);
    try {
      await server.connect(transport);
      process.stdin.once('end', onEnd);
    } catch (error) {
      await close();
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

try {
  await startStdioServer();
} catch (error) {
  console.error('启动海豹日志 stdio 服务失败', error);
  process.exitCode = 1;
}
