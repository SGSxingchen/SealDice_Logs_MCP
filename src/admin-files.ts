import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpError } from './errors.js';

const FILE_TIMEOUT_MS = 10_000;
const MAX_PENDING_WRITES = 128;

export async function prepareAdminDirectory(directory: string): Promise<void> {
  const signal = AbortSignal.timeout(FILE_TIMEOUT_MS);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error('管理台状态路径必须是真实目录');
  signal.throwIfAborted();
  if ((info.mode & 0o7777) !== 0o700) await chmod(directory, 0o700);
}

export async function readAdminFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const signal = AbortSignal.timeout(FILE_TIMEOUT_MS);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('管理台状态文件无效或过大');
    signal.throwIfAborted();
    if ((info.mode & 0o7777) !== 0o600) await file.chmod(0o600);
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(data, length, data.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    signal.throwIfAborted();
    if (length !== info.size) throw new Error('读取期间管理台状态文件大小发生变化');
    return data.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function writeAdminFile(path: string, data: Buffer | string, createOnly = false): Promise<void> {
  const signal = AbortSignal.timeout(FILE_TIMEOUT_MS);
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      signal.throwIfAborted();
      await file.chmod(0o600);
      await file.writeFile(data, { signal });
      signal.throwIfAborted();
      await file.sync();
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    if (createOnly) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('清理管理台临时文件失败');
    });
  }
  // 替换已经提交，目录同步报错时仍须发布与磁盘一致的内存状态。
  try {
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    console.error('同步管理台状态目录失败');
  }
}

export async function readOrGenerate(path: string, maxBytes: number, generate: () => Buffer): Promise<Buffer> {
  const existing = await readAdminFile(path, maxBytes);
  if (existing) return existing;
  const data = generate();
  try {
    await writeAdminFile(path, data, true);
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const concurrent = await readAdminFile(path, maxBytes);
    if (!concurrent) throw error;
    return concurrent;
  }
}

export class SerializedWrites {
  private tail = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING_WRITES) return Promise.reject(this.busy());
    const dueAt = performance.now() + FILE_TIMEOUT_MS;
    this.pending += 1;
    const result = this.tail.then(async () => {
      if (performance.now() >= dueAt) throw this.busy();
      return operation();
    }).finally(() => { this.pending -= 1; });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private busy(): HttpError {
    return new HttpError(503, '管理台状态写入繁忙，请稍后重试');
  }
}
