import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HttpError, LOG_UNAVAILABLE } from './errors.js';
import type { LinkScope } from './link-store.js';
import type { SealDiceDb } from './sealdice-db.js';
import { formatTranscript } from './transcript.js';

export const MCP_INFO = { name: 'sealdice-logs-mcp', version: '1.0.0' };
export const MCP_TOOL_COUNT = 5;

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const INSTRUCTIONS = [
  '先调用 list_logs 查找 log_id，再用 get_log_messages 获取最近一页。指定 group_id 时，可自动选择该群正在录制的日志。',
  '续读时固定使用同一个 log_id，并把上次的 next_cursor_id 作为 get_recent_updates 的 since_id。',
  '即使本页没有符合筛选的消息，也要保存新的 next_cursor_id。has_newer 为真时可继续读取下一页。',
  '向前翻阅历史时，把 first_id 作为 get_log_messages 的 before_id，并保留已有的增量游标。',
].join('\n');

const logId = z.number().int().positive();
const cursor = z.number().int().nonnegative();
const selector = {
  log_id: logId.optional(),
  group_id: z.string().max(256).optional(),
  log_name: z.string().max(1024).optional(),
};
const query = z.string().max(2048);
const time = z.union([z.number(), z.string().max(128)]);
const filters = {
  filter_mode: z.enum(['all', 'ic', 'ooc']).optional(),
  include_dice: z.boolean().optional(),
  include_raw_cq: z.boolean().optional(),
  extra_ooc_prefixes: z.array(z.string().min(1).max(16)).max(10).optional(),
  speaker: z.string().max(256).optional(),
  query: query.optional(),
  start_time: time.optional(),
  end_time: time.optional(),
  last_minutes: z.number().positive().optional(),
  limit: z.number().int().positive().optional(),
};

export function createMcpServer(
  db: SealDiceDb,
  scope: LinkScope | (() => LinkScope),
  onToolCompleted?: () => void | Promise<void>,
): McpServer {
  const server = new McpServer(MCP_INFO, { instructions: INSTRUCTIONS });

  async function read<T extends object>(
    operation: (scope: LinkScope) => T | Promise<T>, format: (result: T) => string = JSON.stringify,
  ): Promise<CallToolResult> {
    try {
      const result = await operation(typeof scope === 'function' ? scope() : scope);
      const text = format(result);
      await onToolCompleted?.();
      return { structuredContent: Object.fromEntries(Object.entries(result)), content: [{ type: 'text', text }] };
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('MCP 读取或记录调用失败', error);
      const text = error instanceof HttpError
        ? (error.status === 404 ? LOG_UNAVAILABLE : error.message)
        : '日志读取暂不可用';
      return { isError: true, content: [{ type: 'text', text }] };
    }
  }

  server.registerTool('list_logs', {
    description: '列出有权读取的日志，按更新时间倒序，可用群 ID、关键词或录制状态筛选。',
    inputSchema: {
      group_id: selector.group_id, query: query.optional(), active_only: z.boolean().optional(),
      limit: filters.limit, offset: cursor.optional(),
    },
    annotations: ANNOTATIONS,
  }, options => read(scope => db.listLogs(scope, options)));

  server.registerTool('get_log_messages', {
    description: '读取一页跑团消息，默认从末尾取最近一页。before_id 向前翻页，after_id 增量续读。',
    inputSchema: { ...selector, ...filters, before_id: cursor.optional(), after_id: cursor.optional() },
    annotations: ANNOTATIONS,
  }, options => read(scope => db.getMessages(scope, options), formatTranscript));

  server.registerTool('get_recent_updates', {
    description: '从 since_id 或 since_time 之后读取消息，默认只看场内。续读请保存 next_cursor_id。',
    inputSchema: { ...selector, ...filters, since_id: cursor.optional(), since_time: time.optional() },
    annotations: ANNOTATIONS,
  }, options => read(scope => db.getRecentUpdates(scope, options), formatTranscript));

  server.registerTool('search_log_messages', {
    description: '在授权日志中检索清理过 CQ 标签的正文，并附带同一日志的前后文。',
    inputSchema: { ...selector, ...filters, query: query.trim().min(1), context_lines: cursor.optional() },
    annotations: ANNOTATIONS,
  }, options => read(scope => db.searchMessages(scope, options)));

  server.registerTool('get_log_participants', {
    description: '统计一份日志中的发言人、场内外发言以及掷骰和指令。',
    inputSchema: { log_id: logId },
    annotations: ANNOTATIONS,
  }, ({ log_id }) => read(scope => db.getParticipants(scope, log_id)));

  return server;
}
