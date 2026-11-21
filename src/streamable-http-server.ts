import { startHttpServer } from './http-app.js';

try {
  await startHttpServer();
} catch (error) {
  console.error('启动海豹日志 HTTP 服务失败', error);
  process.exitCode = 1;
}
