import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function equalSecret(actual, expected) {
  const a = Buffer.from(actual ?? ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function localRequest(req) {
  const remote = req.socket.remoteAddress;
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { throw new HttpError(403, '主机无效'); }
  // host.docker.internal：Docker Desktop 下容器访问宿主机网关的别名，来源仍是本机回环。
  if (!['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) throw new HttpError(403, '仅允许本机访问');
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site' || origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin)) throw new HttpError(403, '请求来源无效');
}

export async function readJson(req, limit = 1024 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '需要 JSON 请求');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new HttpError(400, 'JSON 对象无效'); }
}

export function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

export function failure(res, error) {
  if (!res.destroyed) json(res, error instanceof HttpError ? error.status : 502, { error: error instanceof HttpError ? error.message : '操作失败，请检查服务连接和配置。' });
}
