export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const LOG_UNAVAILABLE = '找不到该日志或当前链接无权访问';
