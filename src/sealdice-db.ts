import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { HttpError, LOG_UNAVAILABLE } from './errors.js';
import { isLogAllowedByScope, type LinkScope } from './link-store.js';
import { classifyLogItem, cleanCqMessage, filterReason, resolveMentions, type FilterMode, type MessageKind } from './message-classifier.js';

const BATCH_SIZE = 400;
const GROUP_CACHE_MS = 15_000;
const MENTION_CACHE_MS = 30_000;
const MAX_MENTION_CACHE_LOGS = 64;
const OVERVIEW_CACHE_MS = 60_000;
const MAX_MULTI_LOG_SEARCH_SCAN = 120_000;
const MAX_SINGLE_LOG_SEARCH_SCAN = 250_000;
const LOG_COLUMNS = "id, name, COALESCE(group_id, '') AS group_id, created_at, updated_at, size";
const ITEM_COLUMNS = 'id, nickname, im_userid, time, message, is_dice';
const VISIBLE = '(removed IS NULL OR removed = 0)';
const LOG_ITEMS = 'log_items INDEXED BY idx_log_items_log_id';

type LogRow = {
  id: number;
  name: string | null;
  group_id: string;
  created_at: number | null;
  updated_at: number | null;
  size: number | null;
};

type ItemRow = {
  id: number;
  nickname: string | null;
  im_userid: string | null;
  time: number | null;
  message: string | null;
  is_dice: number | null;
};

interface GroupInfo {
  group_name: string | null;
  system: string | null;
  log_on: boolean;
  log_cur_name: string | null;
}

const EMPTY_GROUP: GroupInfo = { group_name: null, system: null, log_on: false, log_cur_name: null };

export interface SealDiceLog {
  id: number;
  log_id: number;
  name: string;
  group_id: string;
  group_name: string | null;
  display_group_name: string;
  system: string | null;
  is_recording: boolean;
  created_at: number | null;
  updated_at: number | null;
  created_at_iso: string | null;
  updated_at_iso: string | null;
  size: number;
}

export interface LogSelector {
  log_id?: number;
  group_id?: string;
  log_name?: string;
}

interface ListLogsOptions {
  group_id?: string;
  query?: string;
  active_only?: boolean;
  limit?: number;
  offset?: number;
}

type TimeInput = number | string;

interface MessageFilters {
  filter_mode?: FilterMode;
  include_dice?: boolean;
  include_raw_cq?: boolean;
  extra_ooc_prefixes?: readonly string[];
  speaker?: string;
  query?: string;
  start_time?: TimeInput;
  end_time?: TimeInput;
  last_minutes?: number;
  limit?: number;
}

export interface MessageOptions extends LogSelector, MessageFilters {
  after_id?: number;
  before_id?: number;
}

export interface RecentOptions extends LogSelector, MessageFilters {
  since_id?: number;
  since_time?: TimeInput;
}

export interface SearchOptions extends LogSelector, MessageFilters {
  query: string;
  context_lines?: number;
}

interface ItemFilters {
  mode: FilterMode;
  includeDice: boolean;
  includeRaw: boolean;
  extraOocPrefixes: readonly string[];
  speaker?: string;
  query?: string;
}

interface TimeRange {
  start?: number;
  end?: number;
  since?: number;
}

export interface LogMessage {
  id: number;
  time: number | null;
  time_iso: string | null;
  nickname: string;
  im_userid: string | null;
  channel: 'ic' | 'ooc';
  kind: MessageKind;
  is_dice: boolean;
  message: string;
  raw_cq?: string;
}

type FilterCounts = Record<'ooc' | 'ic' | 'dice' | 'speaker' | 'query', number>;

export interface MessageResult {
  log: SealDiceLog;
  items: LogMessage[];
  filter_mode: FilterMode;
  include_dice: boolean;
  scanned_count: number;
  returned_count: number;
  filtered_out: FilterCounts;
  first_id: number | null;
  last_id: number | null;
  next_cursor_id: number | null;
  latest_log_id: number | null;
  latest_log_time: number | null;
  has_older: boolean;
  has_newer: boolean;
}

interface SearchMatch {
  log: SealDiceLog;
  message: LogMessage;
  before: LogMessage[];
  after: LogMessage[];
}

interface LogParticipant {
  nickname: string;
  im_userid: string | null;
  total: number;
  ic: number;
  ooc: number;
  dice: number;
  last_time: number | null;
}

function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 3000; PRAGMA query_only = ON;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function formatGroupDisplayName(groupId: string, groupName?: string | null): string {
  const name = groupName?.trim();
  if (name) return name;
  if (groupId.startsWith('QQ-Group:')) return `QQ群 ${groupId.slice('QQ-Group:'.length)}`;
  if (groupId.startsWith('OpenQQ-Group:')) {
    const id = groupId.slice('OpenQQ-Group:'.length);
    return `频道群 ${id.length > 17 ? `${id.slice(0, 17)}…` : id}`;
  }
  return groupId;
}

function isoTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseTime(value: TimeInput | undefined): number | undefined {
  if (value === undefined) return undefined;
  const input = typeof value === 'string' ? value.trim() : value;
  const numeric = typeof input === 'number' || /^-?\d+(?:\.\d+)?$/.test(input);
  const time = numeric ? Number(input) : Date.parse(String(input));
  if (!Number.isFinite(time)) throw new HttpError(400, '时间必须是 Unix 秒、毫秒或 ISO 日期');
  return numeric && Math.abs(time) < 1e11 ? time : time / 1000;
}

function timeRange(options: MessageFilters, sinceTime?: TimeInput): TimeRange {
  let start = parseTime(options.start_time);
  const end = parseTime(options.end_time);
  const since = parseTime(sinceTime);
  if (start !== undefined && end !== undefined && start > end) {
    throw new HttpError(400, '开始时间不能晚于结束时间');
  }
  if (options.last_minutes !== undefined) {
    if (!Number.isFinite(options.last_minutes) || options.last_minutes <= 0) {
      throw new HttpError(400, 'last_minutes 必须是正数');
    }
    start = Math.max(start ?? -Infinity, Math.floor(Date.now() / 1000) - options.last_minutes * 60);
  }
  return { start, end, since };
}

function integer(value: number, name: string, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) throw new HttpError(400, `${name} 必须是大于等于 ${min} 的整数`);
  return value;
}

function textFilter(value?: string): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function itemFilters(options: MessageFilters): ItemFilters {
  const mode = options.filter_mode ?? 'all';
  if (mode !== 'all' && mode !== 'ic' && mode !== 'ooc') throw new HttpError(400, 'filter_mode 必须是 all、ic 或 ooc');
  const extraOocPrefixes = (options.extra_ooc_prefixes ?? [])
    .map(prefix => prefix.trim())
    .filter(Boolean);
  return {
    mode, includeDice: options.include_dice ?? true, includeRaw: options.include_raw_cq ?? false,
    extraOocPrefixes, speaker: textFilter(options.speaker), query: textFilter(options.query),
  };
}

function readMessage(
  row: ItemRow, filters: ItemFilters, getMentions?: () => Map<string, string>,
): LogMessage | keyof FilterCounts {
  const classification = classifyLogItem(row, filters.extraOocPrefixes);
  const excluded = filterReason(classification, filters.mode, filters.includeDice);
  if (excluded) return excluded;
  const nickname = row.nickname ?? '';
  if (filters.speaker && filters.speaker !== textFilter(nickname) && filters.speaker !== textFilter(row.im_userid ?? undefined)) {
    return 'speaker';
  }
  const raw = row.message ?? '';
  let message = cleanCqMessage(raw);
  if (message.includes('<@') || message.includes('[@')) {
    message = resolveMentions(message, getMentions?.());
  }
  if (filters.query && !message.toLowerCase().includes(filters.query)) return 'query';
  return {
    id: row.id, time: row.time, time_iso: isoTime(row.time), nickname, im_userid: row.im_userid,
    channel: classification.channel, kind: classification.kind, is_dice: classification.isDiceResult, message,
    ...(filters.includeRaw ? { raw_cq: raw } : {}),
  };
}

function timeConditions(range: TimeRange): { sql: string; values: number[] } {
  let sql = '';
  const values: number[] = [];
  for (const [operator, value] of [['>=', range.start], ['<=', range.end], ['>', range.since]] as const) {
    if (value === undefined) continue;
    sql += ` AND time ${operator} ?`;
    values.push(value);
  }
  return { sql, values };
}

export class SealDiceDb {
  private readonly logs: DatabaseSync;
  private closed = false;
  private groupCache?: { expires: number; items: Map<string, GroupInfo> };
  private overviewCache?: { expires: number; maxId: number; totalMessages: number };
  private readonly mentionCache = new Map<number, { expires: number; names: Map<string, string> }>();

  constructor(logsPath: string, private readonly dataPath?: string) {
    this.logs = openReadOnly(logsPath);
  }

  close(): void {
    if (this.closed) return;
    this.logs.close();
    this.closed = true;
  }

  isReady(): boolean {
    try {
      this.logs.prepare(`SELECT ${LOG_COLUMNS} FROM logs LIMIT 1`).get();
      this.logs.prepare(`SELECT ${ITEM_COLUMNS}, removed FROM ${LOG_ITEMS} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }

  listLogs(scope: LinkScope, options: ListLogsOptions = {}) {
    const limit = Math.min(integer(options.limit ?? 40, 'limit', 1), 200);
    const offset = integer(options.offset ?? 0, 'offset', 0);
    const query = textFilter(options.query);
    const groups = this.groupInfo();
    const items: SealDiceLog[] = [];
    let total = 0;
    for (const row of this.logRows(scope, options)) {
      const group = groups.get(row.group_id) ?? EMPTY_GROUP;
      const displayName = formatGroupDisplayName(row.group_id, group.group_name);
      if (options.active_only && !this.isRecording(row, group)) continue;
      if (query && ![row.name, row.group_id, displayName, String(row.id)].some(value => textFilter(value ?? undefined)?.includes(query))) continue;
      if (total >= offset && items.length < limit) items.push(this.describeLog(row, group));
      total += 1;
    }
    return { items, total, limit, offset };
  }

  getLog(scope: LinkScope, id: number): SealDiceLog {
    return this.resolveLog(scope, { log_id: id });
  }

  getGroups(query?: string) {
    const needle = textFilter(query);
    const groups = this.groupInfo();
    const rows = this.logs.prepare(`
      SELECT COALESCE(group_id, '') AS group_id, COUNT(*) AS log_count, MAX(updated_at) AS latest_updated_at
      FROM logs GROUP BY group_id ORDER BY latest_updated_at DESC, group_id
    `).iterate() as Iterable<{ group_id: string; log_count: number; latest_updated_at: number | null }>;
    const items = [];
    for (const row of rows) {
      const group = groups.get(row.group_id) ?? EMPTY_GROUP;
      const display_name = formatGroupDisplayName(row.group_id, group.group_name);
      if (needle && ![display_name, row.group_id].some(value => value.toLowerCase().includes(needle))) continue;
      items.push({ ...row, ...group, display_name });
    }
    return items;
  }

  getGroupDisplayName(groupId: string): string {
    return formatGroupDisplayName(groupId, this.groupInfo().get(groupId)?.group_name);
  }

  getLogLabels(ids: readonly number[]): Map<number, Pick<SealDiceLog, 'id' | 'name' | 'display_group_name'>> {
    const labels = new Map<number, Pick<SealDiceLog, 'id' | 'name' | 'display_group_name'>>();
    if (ids.length === 0) return labels;
    const rows = this.logs.prepare(`
      SELECT id, name, COALESCE(group_id, '') AS group_id FROM logs WHERE id IN (SELECT value FROM json_each(?))
    `).iterate(JSON.stringify(ids)) as Iterable<Pick<LogRow, 'id' | 'name' | 'group_id'>>;
    const groups = this.groupInfo();
    for (const row of rows) {
      labels.set(row.id, {
        id: row.id, name: row.name ?? '',
        display_group_name: formatGroupDisplayName(row.group_id, groups.get(row.group_id)?.group_name),
      });
    }
    return labels;
  }

  async getMessages(scope: LinkScope, options: MessageOptions = {}): Promise<MessageResult> {
    return this.messagePage(scope, options, options.after_id !== undefined);
  }

  async getRecentUpdates(scope: LinkScope, options: RecentOptions): Promise<MessageResult> {
    const { since_id, since_time, ...filters } = options;
    return this.messagePage(scope, { ...filters, after_id: since_id, filter_mode: filters.filter_mode ?? 'ic' }, true, since_time);
  }

  async searchMessages(scope: LinkScope, options: SearchOptions) {
    const query = textFilter(options.query);
    if (!query) throw new HttpError(400, '请输入检索关键词');
    const limit = Math.min(integer(options.limit ?? 20, 'limit', 1), 200);
    const contextLines = Math.min(integer(options.context_lines ?? 2, 'context_lines', 0), 20);
    const filters = itemFilters({ ...options, query: undefined });
    const range = timeRange(options);
    const groups = this.groupInfo();
    const matches: SearchMatch[] = [];
    const scanBudget = options.log_id !== undefined ? MAX_SINGLE_LOG_SEARCH_SCAN : MAX_MULTI_LOG_SEARCH_SCAN;
    let scanned = 0;
    let truncated = false;
    let foundLog = false;
    for (const row of this.logRows(scope, options, true)) {
      foundLog = true;
      const log = this.describeLog(row, groups.get(row.group_id));
      const getMentions = () => this.mentionNames(log.id);
      const newer: LogMessage[] = [];
      const pending: SearchMatch[] = [];
      const firstMatch = matches.length;
      for await (const batch of this.itemBatches(log.id, range)) {
        for (const row of batch) {
          scanned += 1;
          const item = readMessage(row, filters, getMentions);
          if (typeof item === 'string') {
            if (scanned >= scanBudget && pending.length === 0) {
              truncated = true;
              break;
            }
            continue;
          }
          for (const match of pending) match.before.push(item);
          if (pending[0]?.before.length === contextLines) pending.shift();
          if (matches.length < limit && item.message.toLowerCase().includes(query)) {
            const match: SearchMatch = { log, message: item, before: [], after: [...newer].reverse() };
            matches.push(match);
            if (contextLines > 0) pending.push(match);
          }
          if (matches.length === limit && pending.length === 0) break;
          if (contextLines > 0) {
            newer.push(item);
            if (newer.length > contextLines) newer.shift();
          }
          if (scanned >= scanBudget && pending.length === 0) {
            truncated = true;
            break;
          }
        }
        if ((matches.length === limit || truncated) && pending.length === 0) break;
      }
      for (let index = firstMatch; index < matches.length; index += 1) matches[index].before.reverse();
      if (matches.length === limit || truncated) break;
    }
    if (!foundLog && (options.log_id !== undefined || options.group_id !== undefined || options.log_name !== undefined)) {
      throw new HttpError(404, LOG_UNAVAILABLE);
    }
    return { query: options.query.trim(), matches, returned_count: matches.length, ...(truncated ? { truncated: true } : {}) };
  }

  async getParticipants(scope: LinkScope, id: number) {
    const log = this.getLog(scope, id);
    const people = new Map<string, LogParticipant>();
    const breakdown = { ic: 0, dialogue: 0, ooc: 0, dice_result: 0, dice_command: 0 };
    let total = 0;
    let first_time: number | null = null;
    let last_time: number | null = null;
    for await (const batch of this.itemBatches(log.id, {})) {
      for (const row of batch) {
        const { channel, kind } = classifyLogItem(row);
        const nickname = row.nickname ?? '';
        const key = JSON.stringify([nickname, row.im_userid]);
        let person = people.get(key);
        if (!person) {
          person = { nickname, im_userid: row.im_userid, total: 0, ic: 0, ooc: 0, dice: 0, last_time: null };
          people.set(key, person);
        }
        person.total += 1;
        person[channel] += 1;
        if (kind === 'dice_result' || kind === 'dice_command') person.dice += 1;
        if (row.time !== null) {
          person.last_time = Math.max(person.last_time ?? row.time, row.time);
          first_time = Math.min(first_time ?? row.time, row.time);
          last_time = Math.max(last_time ?? row.time, row.time);
        }
        total += 1;
        breakdown[kind] += 1;
        if (channel === 'ic') breakdown.ic += 1;
      }
    }
    const participants = [...people.values()].sort((a, b) => b.total - a.total || (b.last_time ?? 0) - (a.last_time ?? 0));
    return { log, total, first_time, last_time, breakdown, participants };
  }

  async getOverview() {
    const groups = this.getGroups();
    const latestVisible = this.logs.prepare(`
      SELECT id, time FROM log_items WHERE ${VISIBLE} ORDER BY id DESC LIMIT 1
    `).get() as { id: number; time: number | null } | undefined;
    const end = latestVisible?.id;
    const latestMessageAt = latestVisible?.time ?? null;
    const now = Date.now();

    let totalMessages = 0;
    if (end !== undefined) {
      const cached = this.overviewCache;
      if (cached && now < cached.expires && end === cached.maxId) {
        totalMessages = cached.totalMessages;
      } else {
        const incremental = Boolean(cached && now < cached.expires && end > cached.maxId);
        let cursor = incremental ? cached!.maxId : 0;
        totalMessages = incremental ? cached!.totalMessages : 0;
        const countBatch = this.logs.prepare(`
          SELECT MAX(id) AS last_id, COUNT(CASE WHEN ${VISIBLE} THEN 1 END) AS total
          FROM (SELECT id, removed FROM log_items WHERE id > ? AND id <= ? ORDER BY id LIMIT 10000)
        `);
        while (cursor < end) {
          const batch = countBatch.get(cursor, end) as { last_id: number | null; total: number };
          if (batch.last_id === null) break;
          totalMessages += batch.total;
          cursor = batch.last_id;
          if (cursor < end) await setImmediate();
        }
        this.overviewCache = { expires: now + OVERVIEW_CACHE_MS, maxId: end, totalMessages };
      }
    } else {
      this.overviewCache = { expires: now + OVERVIEW_CACHE_MS, maxId: 0, totalMessages: 0 };
    }

    return {
      totalLogs: groups.reduce((total, group) => total + group.log_count, 0), totalMessages,
      activeRecordingCount: groups.filter(group => group.log_on).length, groupCount: groups.length, latestMessageAt,
    };
  }

  private async messagePage(
    scope: LinkScope, options: MessageOptions, forward: boolean, sinceTime?: TimeInput,
  ): Promise<MessageResult> {
    const log = this.resolveLog(scope, options);
    const filters = itemFilters(options);
    const range = timeRange(options, sinceTime);
    const limit = Math.min(integer(options.limit ?? 100, 'limit', 1), 5000);
    const after = options.after_id === undefined ? undefined : integer(options.after_id, 'after_id', 0);
    const before = options.before_id === undefined ? undefined : integer(options.before_id, 'before_id', 0);
    const latest = this.logs.prepare(`
      SELECT id, time FROM ${LOG_ITEMS} WHERE log_id = ? AND ${VISIBLE} ORDER BY id DESC LIMIT 1
    `).get(log.id) as Pick<ItemRow, 'id' | 'time'> | undefined;
    const filtered_out: FilterCounts = { ooc: 0, ic: 0, dice: 0, speaker: 0, query: 0 };
    const items: LogMessage[] = [];
    let scanned_count = 0;
    let firstScanned: number | undefined;
    let lastScanned: number | undefined;
    if (latest) {
      const getMentions = () => this.mentionNames(log.id);
      for await (const batch of this.itemBatches(log.id, range, forward, after, before, latest.id)) {
        for (const row of batch) {
          firstScanned ??= row.id;
          lastScanned = row.id;
          scanned_count += 1;
          const item = readMessage(row, filters, getMentions);
          if (typeof item === 'string') filtered_out[item] += 1;
          else items.push(item);
          if (items.length === limit) break;
        }
        if (items.length === limit) break;
      }
    }
    if (!forward) items.reverse();

    // 游标包含已扫描的过滤项，但不会跳过同一批里尚未处理的消息。
    const lowest = forward ? firstScanned : lastScanned;
    const highest = forward ? lastScanned : firstScanned;
    const exists = (operator: '<' | '<=' | '>' | '>=', id: number | undefined): boolean => {
      if (!latest || id === undefined) return false;
      const { sql, values } = timeConditions(range);
      return this.logs.prepare(`
        SELECT 1 FROM ${LOG_ITEMS} WHERE log_id = ? AND ${VISIBLE}
        AND id ${operator} ? AND id <= ?${sql} LIMIT 1
      `).get(log.id, id, latest.id, ...values) !== undefined;
    };

    return {
      log, items, filter_mode: filters.mode, include_dice: filters.includeDice, scanned_count, filtered_out,
      returned_count: items.length, first_id: items[0]?.id ?? null, last_id: items.at(-1)?.id ?? null,
      next_cursor_id: highest ?? after ?? latest?.id ?? null,
      latest_log_id: latest?.id ?? null, latest_log_time: latest?.time ?? null,
      has_older: lowest === undefined ? exists('<=', after) : exists('<', lowest),
      has_newer: highest === undefined ? exists('>=', before) : exists('>', highest),
    };
  }

  private async *itemBatches(
    logId: number, range: TimeRange, forward = false, after?: number, before?: number, maxId?: number,
  ): AsyncGenerator<ItemRow[]> {
    const direction = forward ? 'ASC' : 'DESC';
    const bound = forward ? '>' : '<';
    const time = timeConditions(range);
    let where = `log_id = ? AND ${VISIBLE}${time.sql}`;
    const values = [logId, ...time.values];
    if (maxId !== undefined) {
      where += ' AND id <= ?';
      values.push(maxId);
    }
    const otherBound = forward ? before : after;
    if (otherBound !== undefined) {
      where += forward ? ' AND id < ?' : ' AND id > ?';
      values.push(otherBound);
    }
    let cursor = forward ? after : before;
    const page = this.logs.prepare(`
      SELECT ${ITEM_COLUMNS} FROM ${LOG_ITEMS} WHERE ${where} AND id ${bound} ?
      ORDER BY id ${direction} LIMIT ${BATCH_SIZE}
    `);
    for (;;) {
      const rows = (cursor === undefined
        ? this.logs.prepare(`
            SELECT ${ITEM_COLUMNS} FROM ${LOG_ITEMS} WHERE ${where} ORDER BY id ${direction} LIMIT ${BATCH_SIZE}
          `).all(...values)
        : page.all(...values, cursor)) as ItemRow[];
      if (rows.length) yield rows;
      if (rows.length < BATCH_SIZE) return;
      cursor = rows[rows.length - 1].id;
      await setImmediate();
    }
  }

  private resolveLog(scope: LinkScope, selector: LogSelector): SealDiceLog {
    const groups = this.groupInfo();
    let latest: SealDiceLog | undefined;
    for (const row of this.logRows(scope, selector)) {
      const group = groups.get(row.group_id);
      if (selector.log_id !== undefined || selector.log_name !== undefined || this.isRecording(row, group)) {
        return this.describeLog(row, group);
      }
      latest ??= this.describeLog(row, group);
    }
    if (latest) return latest;
    throw new HttpError(404, LOG_UNAVAILABLE);
  }

  private *logRows(scope: LinkScope, selector: LogSelector, byId = false): Generator<LogRow> {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    const add = (clause: string, value: SQLInputValue) => { clauses.push(clause); values.push(value); };
    if (selector.log_id !== undefined) add('id = ?', selector.log_id);
    if (selector.group_id !== undefined) add('group_id = ?', selector.group_id);
    if (selector.log_name !== undefined) add('name = ?', selector.log_name);
    if (scope.type === 'restricted') {
      clauses.push('(group_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))');
      values.push(JSON.stringify(scope.group_ids), JSON.stringify(scope.log_ids));
    }
    const query = `SELECT ${LOG_COLUMNS} FROM logs WHERE ${clauses.length ? clauses.join(' AND ') : '1'}`;
    if (!byId) {
      const rows = this.logs.prepare(`${query} ORDER BY updated_at DESC, id DESC`).iterate(...values) as Iterable<LogRow>;
      for (const row of rows) if (isLogAllowedByScope(scope, row)) yield row;
      return;
    }

    // 检索可跨多个日志。每批结束即释放语句，避免在等待期间固定 WAL 快照。
    const page = this.logs.prepare(`${query} AND id < ? ORDER BY id DESC LIMIT ${BATCH_SIZE}`);
    let rows = this.logs.prepare(`${query} ORDER BY id DESC LIMIT ${BATCH_SIZE}`).all(...values) as LogRow[];
    for (;;) {
      for (const row of rows) if (isLogAllowedByScope(scope, row)) yield row;
      if (rows.length < BATCH_SIZE) return;
      rows = page.all(...values, rows[rows.length - 1].id) as LogRow[];
    }
  }

  private describeLog(row: LogRow, group = EMPTY_GROUP): SealDiceLog {
    return {
      id: row.id, log_id: row.id, name: row.name ?? '', group_id: row.group_id,
      group_name: group.group_name, display_group_name: formatGroupDisplayName(row.group_id, group.group_name),
      system: group.system, is_recording: this.isRecording(row, group),
      size: row.size ?? 0, created_at: row.created_at, updated_at: row.updated_at,
      created_at_iso: isoTime(row.created_at), updated_at_iso: isoTime(row.updated_at),
    };
  }

  private isRecording(row: LogRow, group?: GroupInfo): boolean {
    return group?.log_on === true && group.log_cur_name === row.name;
  }

  private groupInfo(): Map<string, GroupInfo> {
    const now = Date.now();
    if (this.groupCache && now < this.groupCache.expires) return this.groupCache.items;
    const items = new Map<string, GroupInfo>();
    if (this.dataPath) {
      let db: DatabaseSync | undefined;
      try {
        db = openReadOnly(this.dataPath);
        for (const { id, data } of db.prepare('SELECT id, data FROM group_info ORDER BY id').iterate()) {
          if (typeof id !== 'string' || !(typeof data === 'string' || data instanceof Uint8Array)) continue;
          try {
            const info: unknown = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
            if (!info || typeof info !== 'object') continue;
            const { groupName, system, logOn, logCurName } = info as Record<string, unknown>;
            items.set(id, {
              group_name: typeof groupName === 'string' ? groupName.trim() || null : null,
              system: typeof system === 'string' ? system : null, log_on: logOn === true,
              log_cur_name: typeof logCurName === 'string' ? logCurName : null,
            });
          } catch {
            // 单条群元数据无效时，仍读取同库的其他群。
          }
        }
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 14) console.error('读取可选群信息数据库失败');
      } finally {
        db?.close();
      }
    }
    this.groupCache = { expires: now + GROUP_CACHE_MS, items };
    return items;
  }

  private mentionNames(logId: number): Map<string, string> {
    const now = Date.now();
    const cached = this.mentionCache.get(logId);
    if (cached && now < cached.expires) return cached.names;
    const names = new Map<string, string>();
    const register = (key: string, nick: string) => {
      const upper = key.trim().toUpperCase();
      if (upper && !names.has(upper)) names.set(upper, nick);
    };
    const rows = this.logs.prepare(`
      SELECT im_userid, nickname FROM ${LOG_ITEMS}
      WHERE log_id = ? AND ${VISIBLE} AND im_userid IS NOT NULL AND nickname IS NOT NULL
      ORDER BY id DESC
    `).iterate(logId) as Iterable<{ im_userid: string; nickname: string }>;
    for (const { im_userid, nickname } of rows) {
      const nick = nickname.trim();
      const uid = im_userid.trim();
      if (!nick || !uid) continue;
      register(uid, nick);
      const dashIdx = uid.lastIndexOf('-');
      if (dashIdx !== -1 && dashIdx < uid.length - 1) register(uid.slice(dashIdx + 1), nick);
      const colonIdx = uid.lastIndexOf(':');
      if (colonIdx !== -1 && colonIdx < uid.length - 1) {
        const tail = uid.slice(colonIdx + 1);
        register(tail, nick);
        const subDash = tail.lastIndexOf('-');
        if (subDash !== -1 && subDash < tail.length - 1) register(tail.slice(subDash + 1), nick);
      }
    }
    if (this.mentionCache.size >= MAX_MENTION_CACHE_LOGS) {
      const oldest = this.mentionCache.keys().next().value;
      if (oldest !== undefined) this.mentionCache.delete(oldest);
    }
    this.mentionCache.set(logId, { expires: now + MENTION_CACHE_MS, names });
    return names;
  }
}
