import { randomBytes } from 'node:crypto';
import { HttpError, equalSecret, localRequest, readJson, json, failure } from './http.mjs';

export { ENDPOINT } from './api-path.mjs';
export function apiHandler(manager) {
  const key = randomBytes(32).toString('hex');
  let pending = Promise.resolve();
  return async (req, res) => {
    try {
      localRequest(req);
      if (req.method === 'GET') return json(res, 200, { ...await manager.state(), key });
      if (req.method !== 'POST') throw new HttpError(405, '请求方法不受支持');
      if (!equalSecret(req.headers['x-hindsight-key'], key)) throw new HttpError(403, '请刷新插件页面后重试');
      const input = await readJson(req);
      const task = pending.then(() => manager.action(input));
      pending = task.catch(() => {});
      json(res, 200, await task);
    } catch (error) { failure(res, error); }
  };
}
