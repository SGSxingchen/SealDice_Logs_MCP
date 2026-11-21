import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { CookieOptions, Request, Response } from 'express';
import { prepareAdminDirectory, readOrGenerate, SerializedWrites, writeAdminFile } from './admin-files.js';

const COOKIE_NAME = 'sealdice_logs_admin_session';
const COOKIE_PATH = '/sealdice-logs';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 1_024;
const MAX_SESSION_FILE_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 16 * 1024;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_FAILURE_SOURCES = 4_096;
const SESSION_ID = /^[A-Za-z0-9_-]{32}$/;

interface LoginFailures {
  count: number;
  expiresAt: number;
}

function parseSessions(data: Buffer): Map<string, number> {
  try {
    const entries: unknown = JSON.parse(data.toString('utf8'));
    if (!Array.isArray(entries) || entries.length > MAX_SESSIONS) throw new Error();
    const now = Date.now();
    const sessions = new Map<string, number>();
    for (const entry of entries) {
      if (!entry || typeof entry.sid !== 'string' || !SESSION_ID.test(entry.sid)
        || !Number.isSafeInteger(entry.exp) || sessions.has(entry.sid)) throw new Error();
      if (entry.exp > now) sessions.set(entry.sid, entry.exp);
    }
    return sessions;
  } catch {
    throw new Error('管理员会话状态文件格式无效');
  }
}

function passwordDigest(password: string): Buffer {
  return createHash('sha256').update(password).digest();
}

function cookieOptions(req: Request, publicOrigin?: string): CookieOptions {
  return {
    path: COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || publicOrigin?.startsWith('https://') === true,
  };
}

export class AdminAuth {
  private readonly writes = new SerializedWrites();
  private readonly failures = new Map<string, LoginFailures>();
  private nextFailureSweep = 0;

  private constructor(
    private readonly file: string,
    private readonly passwordHash: Buffer,
    private readonly sessionKey: Buffer,
    private sessions: Map<string, number>,
  ) {}

  static async open(stateDir: string, password?: string): Promise<AdminAuth> {
    await prepareAdminDirectory(stateDir);
    if (!password) {
      const path = join(stateDir, 'admin-password.txt');
      let generated = false;
      const data = await readOrGenerate(path, MAX_PASSWORD_BYTES, () => {
        generated = true;
        return Buffer.from(randomBytes(24).toString('base64url'));
      });
      password = data.toString('utf8').replace(/\r?\n$/, '');
      if (generated) console.error(`管理员密码文件已就绪 ${path}`);
    }
    if (!password || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error('管理员密码为空或过长');
    const hash = passwordDigest(password);
    const secret = await readOrGenerate(join(stateDir, 'session-secret.key'), 32, () => randomBytes(32));
    if (secret.length !== 32) throw new Error('管理员会话签名密钥格式无效');
    // 密码变更后，旧密码关联的会话签名立即失效。
    const sessionKey = createHmac('sha256', secret).update(hash).digest();
    const file = join(stateDir, 'sessions.json');
    const data = await readOrGenerate(file, MAX_SESSION_FILE_BYTES, () => Buffer.from('[]'));
    return new AdminAuth(file, hash, sessionKey, parseSessions(data));
  }

  authenticated(req: Request): boolean {
    return this.sessionId(req) !== undefined;
  }

  async login(req: Request, res: Response, publicOrigin?: string): Promise<void> {
    const now = Date.now();
    const address = req.socket.remoteAddress ?? '';
    const failures = this.failedAttempts(address, now);
    if (failures && failures.count >= MAX_FAILURES) {
      this.sendRateLimit(res, failures.expiresAt, now);
      return;
    }
    const password: unknown = req.body?.password;
    if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES
      || !timingSafeEqual(this.passwordHash, passwordDigest(password))) {
      const bucket = failures ?? { count: 0, expiresAt: now + FAILURE_WINDOW_MS };
      if (!failures && this.failures.size >= MAX_FAILURE_SOURCES) {
        this.sendRateLimit(res, this.nextFailureSweep, now);
        return;
      }
      bucket.count += 1;
      this.failures.set(address, bucket);
      if (bucket.count >= MAX_FAILURES) this.sendRateLimit(res, bucket.expiresAt, now);
      else res.status(401).json({ error: '管理员密码错误' });
      return;
    }

    this.failures.delete(address);
    const priorId = this.sessionId(req);
    const id = await this.changeSessions(sessions => {
      if (priorId) sessions.delete(priorId);
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      let sid: string;
      do {
        sid = randomBytes(24).toString('base64url');
      } while (sessions.has(sid));
      sessions.set(sid, Date.now() + SESSION_TTL_MS);
      return sid;
    });
    const signature = this.sign(id).toString('base64url');
    res.cookie(COOKIE_NAME, `${id}.${signature}`, { ...cookieOptions(req, publicOrigin), maxAge: SESSION_TTL_MS });
    res.json({ ok: true });
  }

  async logout(req: Request, res: Response, publicOrigin?: string): Promise<void> {
    const id = this.sessionId(req);
    if (id) await this.changeSessions(sessions => { sessions.delete(id); });
    res.clearCookie(COOKIE_NAME, cookieOptions(req, publicOrigin));
    res.json({ ok: true });
  }

  private sessionId(req: Request): string | undefined {
    const prefix = `${COOKIE_NAME}=`;
    const cookie = req.get('cookie')?.split(';').map(field => field.trim()).find(field => field.startsWith(prefix));
    const match = cookie?.slice(prefix.length).match(/^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return undefined;
    const [, id, signature] = match;
    if ((this.sessions.get(id) ?? 0) <= Date.now()) return undefined;
    const expected = this.sign(id).toString('base64url');
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? id : undefined;
  }

  private sign(id: string): Buffer {
    return createHmac('sha256', this.sessionKey).update(id).digest();
  }

  private changeSessions<T>(change: (sessions: Map<string, number>) => T): Promise<T> {
    return this.writes.run(async () => {
      const now = Date.now();
      const sessions = new Map([...this.sessions].filter(([, exp]) => exp > now));
      const result = change(sessions);
      await writeAdminFile(this.file, JSON.stringify([...sessions].map(([sid, exp]) => ({ sid, exp }))));
      this.sessions = sessions;
      return result;
    });
  }

  private failedAttempts(address: string, now: number): LoginFailures | undefined {
    if (now >= this.nextFailureSweep) {
      for (const [source, entry] of this.failures) {
        if (now >= entry.expiresAt) this.failures.delete(source);
      }
      this.nextFailureSweep = now + 60_000;
    }
    const entry = this.failures.get(address);
    if (entry && now < entry.expiresAt) return entry;
    this.failures.delete(address);
    return undefined;
  }

  private sendRateLimit(res: Response, expiresAt: number, now: number): void {
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: '登录失败次数过多，请稍后重试', retryAfterSeconds });
  }
}
