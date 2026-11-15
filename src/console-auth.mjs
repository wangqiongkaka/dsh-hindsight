import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from './http.mjs';

const execute = promisify(execFile);
export const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export async function consoleAccessKey(address, { env = process.env, run = execute } = {}) {
  if (env.HINDSIGHT_CP_ACCESS_KEY) return env.HINDSIGHT_CP_ACCESS_KEY;
  const url = new URL(address);
  if (!loopbackHosts.includes(url.hostname)) throw new HttpError(400, '免密嵌入仅支持本机控制台');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  try {
    const options = { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true };
    const listed = await run('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.ID}}'], options);
    const ids = listed.stdout.trim().split(/\s+/).filter(id => /^[a-f0-9]+$/.test(id));
    if (ids.length && ids.length <= 50) {
      const inspected = await run('docker', ['inspect', '--format', '{"ports":{{json .NetworkSettings.Ports}},"env":{{json .Config.Env}}}', ...ids], options);
      const matches = inspected.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(container =>
        Object.values(container.ports ?? {}).some(bindings => bindings?.some(binding => binding.HostPort === port
          && ['127.0.0.1', '::1', '0.0.0.0', '::', ''].includes(binding.HostIp))));
      if (matches.length === 1) {
        const entry = matches[0].env?.find(value => value.startsWith('HINDSIGHT_CP_ACCESS_KEY='));
        if (entry?.slice(entry.indexOf('=') + 1)) return entry.slice(entry.indexOf('=') + 1);
      }
    }
  } catch { /* 不将可能包含环境凭据的 Docker 输出或异常带到页面。 */ }
  throw new HttpError(503, '未找到本机控制台凭据，请为 DSH 设置 HINDSIGHT_CP_ACCESS_KEY，或确保 Docker 中对应控制台容器可访问，然后重试');
}
