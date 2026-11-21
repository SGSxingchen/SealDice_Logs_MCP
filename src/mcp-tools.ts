import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HttpError, LOG_UNAVAILABLE } from './errors.js';
import { DEFAULT_DISCLOSURE_MODE, type DisclosureMode, type LinkScope } from './link-store.js';
import type { SealDiceDb } from './sealdice-db.js';
import { formatTranscript } from './transcript.js';

export const MCP_INFO = { name: 'sealdice-logs-mcp', version: '1.0.0' };
export const MCP_TOOL_COUNT = 5;
export const PROGRESSIVE_TOOL_COUNT = 3;

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const INSTRUCTIONS = [
  '先调用 list_logs 查找 log_id，再用 get_log_messages 获取最近一页。指定 group_id 时，可自动选择该群正在录制的日志。',
  '续读时固定使用同一个 log_id，并把上次的 next_cursor_id 作为 get_recent_updates 的 since_id。',
  '即使本页没有符合筛选的消息，也要保存新的 next_cursor_id。has_newer 为真时可继续读取下一页。',
  '向前翻阅历史时，把 first_id 作为 get_log_messages 的 before_id，并保留已有的增量游标。',
].join('\n');
const PROGRESSIVE_INSTRUCTIONS = '先用 sealdice_discover 查看动作与授权范围，再用 sealdice_describe 取参数与游标规则，最后用 sealdice_execute 读取日志。';

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

const selectorHelp = {
  log_id: '日志的正整数 ID。续读和翻页时固定使用同一个 ID。',
  group_id: '完整群 ID。只给 group_id 读取消息时，优先选择群内正在录制的授权日志。',
  log_name: '精确匹配日志名称，可以搭配 group_id 使用。',
};
const filterHelp = {
  filter_mode: 'all 为全部，ic 为场内，ooc 为场外。',
  include_dice: '是否保留掷骰结果和指令，默认 true。',
  include_raw_cq: '是否附带原始消息 raw_cq，默认 false。',
  extra_ooc_prefixes: '附加的场外发言开头，最多 10 项，每项 1 至 16 字符。',
  speaker: '精确匹配昵称或 IM 用户 ID，忽略首尾空白和大小写。',
  query: '在清理 CQ 和转换艾特后的正文中匹配子串，忽略大小写。',
  start_time: '含边界的起始时间，支持 Unix 秒、毫秒和 ISO 日期。',
  end_time: '含边界的结束时间，支持 Unix 秒、毫秒和 ISO 日期。',
  last_minutes: '以当前时刻为基准保留最近 N 分钟，与 start_time 同时设置时取较晚的起点。',
  limit: '返回的消息条数，默认 100，最多 5000。',
};

const GUIDES = {
  cursor_workflow: {
    summary: '取得最近一页、续读新消息并向前翻历史。',
    instructions: [
      '以下动作通过 sealdice_execute 调用，动作参数放在 params 中。',
      INSTRUCTIONS,
      'since_id 和 after_id 只读取 ID 更大的消息，before_id 只读取 ID 更小的消息。返回的消息按 ID 升序排列。',
      '空日志的 next_cursor_id 可能为 null，下次可以用 since_id: 0 继续。first_id 为 null 时，本页没有可用于向前翻页的消息。',
    ].join('\n'),
  },
  filters: {
    summary: '场内场外、掷骰、时间和发言人筛选。',
    instructions: [
      '忽略前置 CQ 标签和 OpenQQ 艾特后，消息以中文或英文左圆括号开头时视为场外，无需闭合括号。extra_ooc_prefixes 可补充场外开头。',
      '掷骰结果和识别出的骰子指令归入场内，include_dice: false 会过滤两者。get_recent_updates 默认 filter_mode: ic，消息阅读与检索默认 all。',
      'start_time、end_time 包含边界，since_time 排除边界。均接受 Unix 秒、毫秒或 ISO 日期，建议在 ISO 日期中指定时区。last_minutes 可进一步限制到最近 N 分钟。',
      'speaker 精确匹配昵称或 IM 用户 ID，忽略首尾空白与大小写。query 匹配清理 CQ 和转换艾特后的正文子串。',
    ].join('\n'),
  },
};

type Read = <T extends object>(
  operation: (scope: LinkScope) => T | Promise<T>, format?: (result: T) => string,
) => Promise<CallToolResult>;

function toolConfig<Input extends z.ZodObject>(description: string, inputSchema: Input) {
  return { description, inputSchema, annotations: ANNOTATIONS };
}

function defineAction<Shape extends z.core.$ZodShape, Result extends object>(definition: {
  description: string;
  summary: string;
  inputSchema: z.ZodObject<Shape>;
  parameters: Record<keyof Shape, string>;
  examples: z.input<z.ZodObject<Shape>>[];
  operation: (db: SealDiceDb, scope: LinkScope, params: z.output<z.ZodObject<Shape>>) => Result | Promise<Result>;
  format?: (result: Result) => string;
}) {
  const { description, summary, inputSchema, parameters, examples, operation, format } = definition;
  const config = toolConfig(description, inputSchema);

  return {
    config, summary, parameters, examples,
    register(server: McpServer, name: string, db: SealDiceDb, read: Read) {
      server.registerTool<never, z.ZodObject<Shape>>(
        name, config, params => read(scope => operation(db, scope, params), format),
      );
    },
    execute(db: SealDiceDb, read: Read, params: Record<string, unknown>) {
      return read(scope => {
        const parsed = inputSchema.safeParse(params);
        if (!parsed.success) throw new HttpError(400, `动作参数无效\n${z.prettifyError(parsed.error)}`);
        return operation(db, scope, parsed.data);
      }, format);
    },
  };
}

const ACTIONS = {
  list_logs: defineAction({
    description: '列出有权读取的日志，按更新时间倒序，可用群 ID、关键词或录制状态筛选。',
    summary: '列出授权日志和录制状态。',
    inputSchema: z.object({
      group_id: selector.group_id, query: query.optional(), active_only: z.boolean().optional(),
      limit: filters.limit, offset: cursor.optional(),
    }),
    parameters: {
      group_id: '只列出该群的授权日志。',
      query: '在日志名称、群 ID、群显示名或日志 ID 中匹配子串。',
      active_only: '设为 true 时只返回正在录制的日志。',
      limit: '每页日志数，默认 40，最多 200。',
      offset: '在返回结果前跳过的条数，从 0 开始。',
    },
    examples: [{ active_only: true, limit: 10 }],
    operation: (db, scope, params) => db.listLogs(scope, params),
  }),
  get_log_messages: defineAction({
    description: '读取一页跑团消息，默认从末尾取最近一页。before_id 向前翻页，after_id 增量续读。',
    summary: '读取最近的消息或翻历史。',
    inputSchema: z.object({ ...selector, ...filters, before_id: cursor.optional(), after_id: cursor.optional() }),
    parameters: {
      ...selectorHelp, ...filterHelp,
      filter_mode: `${filterHelp.filter_mode}默认 all。`,
      before_id: '只读此 ID 之前的消息。向前翻页时传上一页的 first_id。',
      after_id: '只读此 ID 之后的消息。传入后从旧到新读取。',
    },
    examples: [{ log_id: 1, limit: 30, filter_mode: 'ic' }, { log_id: 1, before_id: 120, limit: 30 }],
    operation: (db, scope, params) => db.getMessages(scope, params),
    format: formatTranscript,
  }),
  get_recent_updates: defineAction({
    description: '从 since_id 或 since_time 之后读取消息，默认只看场内。续读请保存 next_cursor_id。',
    summary: '用游标续读新消息。',
    inputSchema: z.object({ ...selector, ...filters, since_id: cursor.optional(), since_time: time.optional() }),
    parameters: {
      ...selectorHelp, ...filterHelp,
      filter_mode: `${filterHelp.filter_mode}默认 ic。`,
      since_id: '只读此 ID 之后的消息。续读时传同一日志上次返回的 next_cursor_id。',
      since_time: '只读此时间之后的消息，支持 Unix 秒、毫秒和 ISO 日期。',
    },
    examples: [{ log_id: 1, since_id: 150, limit: 30 }],
    operation: (db, scope, params) => db.getRecentUpdates(scope, params),
    format: formatTranscript,
  }),
  search_log_messages: defineAction({
    description: '在授权日志中检索清理过 CQ 标签的正文，并附带同一日志的前后文。',
    summary: '检索消息正文和前后文。',
    inputSchema: z.object({ ...selector, ...filters, query: query.trim().min(1), context_lines: cursor.optional() }),
    parameters: {
      ...selectorHelp, ...filterHelp,
      group_id: '只检索该群的授权日志。',
      filter_mode: `${filterHelp.filter_mode}默认 all。`,
      query: `必填，去除首尾空白后不能为空。${filterHelp.query}`,
      limit: '返回的命中条数，默认 20，最多 200。',
      context_lines: '每条命中前后各取的消息条数，默认 2，最多 20。',
    },
    examples: [{ log_id: 1, query: '灯塔', context_lines: 2 }],
    operation: (db, scope, params) => db.searchMessages(scope, params),
  }),
  get_log_participants: defineAction({
    description: '统计一份日志中的发言人、场内外发言以及掷骰和指令。',
    summary: '统计一份日志的发言人与发言类型。',
    inputSchema: z.object({ log_id: logId }),
    parameters: { log_id: '必填，待统计的授权日志 ID。' },
    examples: [{ log_id: 1 }],
    operation: (db, scope, { log_id }) => db.getParticipants(scope, log_id),
  }),
};

const actionName = z.string().max(128);
const META_TOOLS = {
  sealdice_discover: toolConfig('查看授权范围、动作和指南。', z.object({ query: query.optional() })),
  sealdice_describe: toolConfig('取得指定动作的参数和指南。', z.object({
    actions: z.array(actionName).optional(), guide: z.enum(['cursor_workflow', 'filters']).optional(),
  })),
  sealdice_execute: toolConfig('按动作和参数读取日志。', z.object({
    action: actionName, params: z.record(z.string(), z.unknown()).optional(),
  })),
};

function findAction(name: string) {
  if (!Object.hasOwn(ACTIONS, name)) throw new HttpError(400, `未知动作：${name}。请先调用 sealdice_discover`);
  return ACTIONS[name as keyof typeof ACTIONS];
}

function summarizeScope(scope: LinkScope) {
  const parts: string[] = [];
  if (scope.group_ids.length) parts.push(`指定群 ${scope.group_ids.length} 个`);
  if (scope.log_ids.length) parts.push(`指定团 ${scope.log_ids.length} 个`);
  return { ...scope, summary: scope.type === 'all' ? '全量日志' : parts.join('、') || '无授权日志' };
}

function jsonSchema(schema: z.ZodObject) {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
}

function contextBytes(instructions: string, tools: [string, ReturnType<typeof toolConfig>][]): number {
  return Buffer.byteLength(JSON.stringify({
    instructions,
    // 按 MCP SDK 的工具清单格式计入普通工具的执行元数据。
    tools: tools.map(([name, config]) => ({
      name, ...config, inputSchema: jsonSchema(config.inputSchema), execution: { taskSupport: 'forbidden' },
    })),
  }));
}

const progressiveBytes = contextBytes(PROGRESSIVE_INSTRUCTIONS, Object.entries(META_TOOLS));
const legacyBytes = contextBytes(INSTRUCTIONS, Object.entries(ACTIONS).map(([name, action]) => [name, action.config]));

export function getDisclosureMetrics() {
  return {
    progressiveTools: PROGRESSIVE_TOOL_COUNT, legacyTools: MCP_TOOL_COUNT,
    progressiveBytes, legacyBytes,
    estimatedSavedPercent: Math.round((1 - progressiveBytes / legacyBytes) * 10_000) / 100,
  };
}

export function createMcpServer(
  db: SealDiceDb,
  scope: LinkScope | (() => LinkScope),
  onToolCompleted?: () => void | Promise<void>,
  disclosureMode: DisclosureMode = DEFAULT_DISCLOSURE_MODE,
): McpServer {
  const server = new McpServer(MCP_INFO, {
    instructions: disclosureMode === 'legacy' ? INSTRUCTIONS : PROGRESSIVE_INSTRUCTIONS,
  });

  async function respond<T extends object>(
    operation: (scope: LinkScope) => T | Promise<T>, format: (result: T) => string = JSON.stringify,
    onCompleted?: () => void | Promise<void>,
  ): Promise<CallToolResult> {
    try {
      const result = await operation(typeof scope === 'function' ? scope() : scope);
      const text = format(result);
      await onCompleted?.();
      return { structuredContent: Object.fromEntries(Object.entries(result)), content: [{ type: 'text', text }] };
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('MCP 读取或记录调用失败', error);
      const text = error instanceof HttpError
        ? (error.status === 404 ? LOG_UNAVAILABLE : error.message)
        : '日志读取暂不可用';
      return { isError: true, content: [{ type: 'text', text }] };
    }
  }

  const read: Read = (operation, format) => respond(operation, format, onToolCompleted);
  if (disclosureMode === 'legacy') {
    for (const [name, action] of Object.entries(ACTIONS)) action.register(server, name, db, read);
    return server;
  }

  server.registerTool('sealdice_discover', META_TOOLS.sealdice_discover, ({ query }) => respond(scope => {
    const needle = query?.trim().toLowerCase();
    const actions = Object.entries(ACTIONS)
      .filter(([name, { summary, config }]) => !needle || `${name} ${summary} ${config.description}`.toLowerCase().includes(needle))
      .map(([action, { summary }]) => ({ action, summary }));
    const guides = Object.entries(GUIDES).map(([name, { summary }]) => ({ name, summary }));
    return { scope: summarizeScope(scope), actions, guides };
  }));

  server.registerTool('sealdice_describe', META_TOOLS.sealdice_describe, ({ actions, guide }) => respond(() => ({
    actions: [...new Set(actions)].map(action => {
      const { config, parameters, examples } = findAction(action);
      return {
        action, description: config.description, inputSchema: jsonSchema(config.inputSchema), parameters,
        examples: examples.map(params => ({ action, params })),
      };
    }),
    ...(guide ? { guide: { name: guide, ...GUIDES[guide] } } : {}),
  })));

  server.registerTool('sealdice_execute', META_TOOLS.sealdice_execute,
    ({ action, params }) => findAction(action).execute(db, read, params ?? {}));

  return server;
}
