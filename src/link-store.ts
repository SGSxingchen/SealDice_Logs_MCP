import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { prepareAdminDirectory, readAdminFile, SerializedWrites, writeAdminFile } from './admin-files.js';
import { HttpError } from './errors.js';

export type DisclosureMode = 'progressive' | 'legacy';
export const DEFAULT_DISCLOSURE_MODE: DisclosureMode = 'progressive';

export interface LinkScope {
  type: 'all' | 'restricted';
  group_ids: string[];
  log_ids: number[];
}

export interface McpLinkRecord {
  id: string;
  label: string;
  token: string;
  enabled: boolean;
  scope: LinkScope;
  disclosure_mode?: DisclosureMode;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  call_count: number;
}

const MAX_LINK_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINKS = 4_096;
const MAX_SCOPE_ENTRIES = 4_096;
const LINK_ID = /^lnk_[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

export const ALL_SCOPE: LinkScope = { type: 'all', group_ids: [], log_ids: [] };
Object.freeze(ALL_SCOPE.group_ids);
Object.freeze(ALL_SCOPE.log_ids);
Object.freeze(ALL_SCOPE);

export function isLogAllowedByScope(scope: LinkScope, log: { id: number; group_id: string }): boolean {
  return scope.type === 'all' || (scope.type === 'restricted'
    && (scope.group_ids.includes(log.group_id) || scope.log_ids.includes(log.id)));
}

export function isLinkExpired(item: McpLinkRecord, now = Date.now()): boolean {
  return item.expires_at !== null && Date.parse(item.expires_at) <= now;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyScope(scope: LinkScope): LinkScope {
  return { type: scope.type, group_ids: [...scope.group_ids], log_ids: [...scope.log_ids] };
}

function copyRecord(item: McpLinkRecord): McpLinkRecord {
  return { ...item, scope: copyScope(item.scope), disclosure_mode: item.disclosure_mode ?? DEFAULT_DISCLOSURE_MODE };
}

function groupIdValid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function logIdValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseScope(value: unknown): LinkScope {
  if (!isObject(value) || (value.type !== 'all' && value.type !== 'restricted')) {
    throw new HttpError(400, 'scope.type 必须是 all 或 restricted');
  }
  const groupIds = value.group_ids === undefined ? [] : value.group_ids;
  const logIds = value.log_ids === undefined ? [] : value.log_ids;
  if (!Array.isArray(groupIds) || groupIds.length > MAX_SCOPE_ENTRIES || !groupIds.every(groupIdValid)) {
    throw new HttpError(400, 'scope.group_ids 必须是有效的群 ID 数组');
  }
  if (!Array.isArray(logIds) || logIds.length > MAX_SCOPE_ENTRIES || !logIds.every(logIdValid)) {
    throw new HttpError(400, 'scope.log_ids 必须是有效的日志 ID 数组');
  }
  if (value.type === 'all') return copyScope(ALL_SCOPE);
  if (groupIds.length + logIds.length === 0) throw new HttpError(400, '限定范围时，请至少选择一个群或一份日志');
  return { type: 'restricted', group_ids: [...new Set(groupIds)], log_ids: [...new Set(logIds)] };
}

function parseLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120) {
    throw new HttpError(400, '链接备注必须是 1 至 120 个字符');
  }
  return value.trim();
}

function parseEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
  return value;
}

function parseDisclosureMode(value: unknown = DEFAULT_DISCLOSURE_MODE): DisclosureMode {
  if (value === 'progressive' || value === 'legacy') return value;
  throw new HttpError(400, 'disclosure_mode 必须是 progressive 或 legacy');
}

function expiresAt(hours: unknown, now: number): string | null {
  if (hours === undefined || hours === null) return null;
  if (typeof hours === 'number' && Number.isFinite(hours)) {
    const date = new Date(now + hours * 3_600_000);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  throw new HttpError(400, 'expires_in_hours 必须是有效小时数或 null');
}

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const isDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function loadRecords(raw: Buffer): { records: Map<string, McpLinkRecord>; imported: Set<string> } {
  try {
    const data: unknown = JSON.parse(raw.toString('utf8'));
    const items = Array.isArray(data) ? data : isObject(data) ? data.items : undefined;
    const hashes = isObject(data) ? data.importedBootstrapTokens ?? [] : [];
    if (!Array.isArray(items) || items.length > MAX_LINKS || !Array.isArray(hashes)
      || !hashes.every(hash => typeof hash === 'string' && TOKEN_HASH.test(hash))) throw new Error();

    const records = new Map<string, McpLinkRecord>();
    const tokens = new Set<string>();
    for (const item of items) {
      if (!isObject(item)) throw new Error();
      const { id, token, created_at, updated_at, expires_at, last_used_at, call_count } = item;
      if (typeof id !== 'string' || !LINK_ID.test(id) || records.has(id)
        || typeof token !== 'string' || !TOKEN.test(token) || tokens.has(token)
        || !isDate(created_at) || !isDate(updated_at) || (expires_at !== null && !isDate(expires_at))
        || (last_used_at !== null && !isDate(last_used_at)) || typeof call_count !== 'number'
        || !Number.isSafeInteger(call_count) || call_count < 0) throw new Error();
      records.set(id, {
        id, token, created_at, updated_at, expires_at, last_used_at, call_count,
        label: parseLabel(item.label), enabled: parseEnabled(item.enabled), scope: parseScope(item.scope),
        disclosure_mode: item.disclosure_mode === undefined ? undefined : parseDisclosureMode(item.disclosure_mode),
      });
      tokens.add(token);
    }
    return { records, imported: new Set(hashes) };
  } catch {
    throw new Error('MCP 链接状态文件格式无效');
  }
}

function newRecord(
  records: Map<string, McpLinkRecord>, input: Record<string, unknown>, token: string, now: number,
): McpLinkRecord {
  if (records.size >= MAX_LINKS) throw new HttpError(409, '链接数量已达到上限');
  let id: string;
  do {
    id = `lnk_${randomBytes(6).toString('hex')}`;
  } while (records.has(id));
  const timestamp = new Date(now).toISOString();
  return {
    id, token, label: parseLabel(input.label), enabled: input.enabled === undefined ? true : parseEnabled(input.enabled),
    scope: input.scope === undefined ? copyScope(ALL_SCOPE) : parseScope(input.scope),
    disclosure_mode: parseDisclosureMode(input.disclosure_mode),
    created_at: timestamp, updated_at: timestamp, expires_at: expiresAt(input.expires_in_hours, now),
    last_used_at: null, call_count: 0,
  };
}

export class LinkStore {
  private readonly writes = new SerializedWrites();
  private byToken: Map<string, string>;

  private constructor(
    private readonly file: string,
    private records: Map<string, McpLinkRecord>,
    private readonly imported: Set<string>,
  ) {
    this.byToken = this.tokenIndex();
  }

  static async open(stateDir: string, bootstrap?: string): Promise<LinkStore> {
    await prepareAdminDirectory(stateDir);
    const file = join(stateDir, 'links.json');
    const raw = await readAdminFile(file, MAX_LINK_FILE_BYTES);
    const { records, imported } = raw ? loadRecords(raw) : { records: new Map(), imported: new Set<string>() };
    const store = new LinkStore(file, records, imported);
    const changed = store.importBootstrapLinks(bootstrap);
    if (changed || !raw) await store.persist(records, !raw);
    return store;
  }

  private importBootstrapLinks(bootstrap: string | undefined): boolean {
    if (!bootstrap?.trim()) return false;
    const now = Date.now();
    let changed = false;
    try {
      const inputs: unknown = JSON.parse(bootstrap);
      if (!Array.isArray(inputs) || inputs.length > MAX_LINKS) throw new Error();
      for (const input of inputs) {
        if (!isObject(input) || typeof input.token !== 'string' || !TOKEN.test(input.token)) throw new Error();
        const hash = tokenHash(input.token);
        if (this.imported.has(hash)) continue;
        if (!this.byToken.has(hash)) {
          const record = newRecord(this.records, input, input.token, now);
          this.records.set(record.id, record);
          this.byToken.set(hash, record.id);
        }
        // 已轮换或删除的预设令牌在重启后保持无效。
        this.imported.add(hash);
        changed = true;
      }
    } catch {
      throw new Error('MCP_BOOTSTRAP_LINKS 必须是有效的链接数组，每项需包含备注和 32 字节 base64url 令牌');
    }
    return changed;
  }

  list(): McpLinkRecord[] {
    return [...this.records.values()].map(copyRecord);
  }

  getById(id: string): McpLinkRecord | undefined {
    const item = this.records.get(id);
    return item && copyRecord(item);
  }

  findActiveByToken(token: string): McpLinkRecord | undefined {
    if (!TOKEN.test(token)) return undefined;
    const id = this.byToken.get(tokenHash(token));
    const item = id === undefined ? undefined : this.records.get(id);
    if (item?.enabled && !isLinkExpired(item)) return copyRecord(item);
    return undefined;
  }

  create(input: unknown): Promise<McpLinkRecord> {
    return this.change(records => {
      if (!isObject(input)) throw new HttpError(400, '请求体必须是对象');
      const item = newRecord(records, input, this.generateToken(), Date.now());
      records.set(item.id, item);
      return copyRecord(item);
    }, true);
  }

  update(id: string, input: unknown): Promise<McpLinkRecord> {
    return this.change(records => {
      const previous = this.requireLink(id);
      if (!isObject(input)) throw new HttpError(400, '请求体必须是对象');
      const now = Date.now();
      const item = {
        ...previous,
        label: input.label === undefined ? previous.label : parseLabel(input.label),
        enabled: input.enabled === undefined ? previous.enabled : parseEnabled(input.enabled),
        scope: input.scope === undefined ? previous.scope : parseScope(input.scope),
        disclosure_mode: input.disclosure_mode === undefined ? previous.disclosure_mode : parseDisclosureMode(input.disclosure_mode),
        expires_at: input.expires_in_hours === undefined ? previous.expires_at : expiresAt(input.expires_in_hours, now),
        updated_at: new Date(now).toISOString(),
      };
      records.set(id, item);
      return copyRecord(item);
    });
  }

  rotate(id: string): Promise<McpLinkRecord> {
    return this.change(records => {
      const item = { ...this.requireLink(id), token: this.generateToken(), updated_at: new Date().toISOString() };
      records.set(id, item);
      return copyRecord(item);
    }, true);
  }

  delete(id: string): Promise<void> {
    return this.change(records => {
      this.requireLink(id);
      records.delete(id);
    }, true);
  }

  recordUsage(id: string): Promise<void> {
    if (!this.records.has(id)) return Promise.resolve();
    return this.change(records => {
      const item = records.get(id);
      if (item) records.set(id, {
        ...item,
        last_used_at: new Date().toISOString(),
        call_count: Math.min(Number.MAX_SAFE_INTEGER, item.call_count + 1),
      });
    });
  }

  private requireLink(id: string): McpLinkRecord {
    const item = this.records.get(id);
    if (!item) throw new HttpError(404, '找不到该链接');
    return item;
  }

  private generateToken(): string {
    let token: string;
    let hash: string;
    do {
      token = randomBytes(32).toString('base64url');
      hash = tokenHash(token);
    } while (this.byToken.has(hash) || this.imported.has(hash));
    return token;
  }

  private tokenIndex(): Map<string, string> {
    return new Map([...this.records.values()].map(item => [tokenHash(item.token), item.id]));
  }

  private change<T>(change: (records: Map<string, McpLinkRecord>) => T, reindex = false): Promise<T> {
    return this.writes.run(async () => {
      const records = new Map(this.records);
      const value = change(records);
      await this.persist(records);
      this.records = records;
      if (reindex) this.byToken = this.tokenIndex();
      return value;
    });
  }

  private persist(records: Map<string, McpLinkRecord>, createOnly = false): Promise<void> {
    const data = JSON.stringify({ items: [...records.values()], importedBootstrapTokens: [...this.imported] });
    if (Buffer.byteLength(data) > MAX_LINK_FILE_BYTES) throw new HttpError(409, '链接状态已超过存储上限');
    return writeAdminFile(this.file, data, createOnly);
  }
}
