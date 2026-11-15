import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HindsightManager } from '../src/service.mjs';
import { modelId } from '../src/gateway.mjs';

export const models = [modelId('example', 'model-a'), modelId('example', 'model-b')];
export function fakeLlm() {
  return {
    calls: [], text: '{"ok":true}',
    listProviders: () => [{ id: 'example', name: '示例服务商' }],
    listModels: async () => [{ id: 'model-a', name: '示例模型 A' }, { id: 'model-b', name: '示例模型 B' }],
    async *stream(options) {
      this.calls.push(options);
      yield { type: 'text-delta', index: 0, text: this.text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.text } };
      yield { type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 2, outputTokens: 4 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

export async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hindsight-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = { calls: [], auth: true };
  const llm = fakeLlm();
  const manager = new HindsightManager({ root, llm: () => llm, accessKey: async () => 'test-access-key', fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
    upstream.calls.push({ url, ...options, body });
    if (path.endsWith('/api/version')) return Response.json({ features: { access_key_auth: upstream.auth } });
    if (path.endsWith('/api/auth/login')) return body.key === 'test-access-key' ? Response.json({ success: true }, { headers: { 'set-cookie': 'hindsight_cp_access=test-session; Path=/; HttpOnly' } }) : Response.json({ error: 'wrong key' }, { status: 401 });
    return Response.json({ error: 'not found' }, { status: 404 });
  } });
  await manager.init(); manager.gateway = 'http://127.0.0.1:18991';
  return { manager, upstream, root, llm };
}
