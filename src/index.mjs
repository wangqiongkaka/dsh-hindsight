import { createServer } from 'node:http';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { HindsightManager } from './service.mjs';
import { gatewayHandler } from './gateway.mjs';
import { apiHandler, ENDPOINT } from './api.mjs';
import { CONSOLE_PATH } from './api-path.mjs';
import { consoleProxy } from './console-proxy.mjs';

export const name = 'dsh-hindsight';
export const inject = [];
export const Config = z.object({
  port: z.number().min(1024).max(65535).default(18991).description('本机模型转接端口；修改后需要重新生成环境文件'),
  root: z.string().default('').description('配置保存目录；默认 <DSH_HOME>/dsh-hindsight'),
  consoleUrl: z.string().default('').description('本机原生控制台地址；默认沿用已有配置或 http://localhost:9999'),
});

export async function apply(ctx, config = {}) {
  const manager = new HindsightManager({ root: resolve(config.root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-hindsight')), llm: () => ctx.get('llm'), consoleAddress: config.consoleUrl || '' });
  try { await manager.init(); }
  catch { ctx.logger.warn('Hindsight 插件配置读取失败，未修改原文件；请检查配置目录。'); return; }
  ctx.inject(['webServer'], scope => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: ENDPOINT, handler: apiHandler(manager) }));
  });
  ctx.inject(['webServer', 'connection'], scope => {
    scope.effect(() => scope.webServer.register({ kind: 'prefix', path: CONSOLE_PATH, handler: consoleProxy(manager, (req, res) => scope.connection.authorizeIndex(req, res)) }));
  });
  const server = createServer(gatewayHandler({ llm: () => ctx.get('llm'), settings: () => manager.settings }));
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  ctx.effect(() => () => { server.close(); server.closeAllConnections(); });
  try {
    const port = config.port ?? 18991;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效');
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    server.unref();
    manager.gateway = `http://127.0.0.1:${port}`;
  } catch { ctx.logger.warn('Hindsight 模型转接启动失败，请检查端口是否被占用；原生控制台嵌入仍可使用。'); }
}
