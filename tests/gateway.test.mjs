import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { gatewayHandler, completion, optionsFor } from '../src/gateway.mjs';
import { apiHandler } from '../src/api.mjs';
import { fixture, models, listen } from './helpers.mjs';

const message = { model: 'dsh-default', messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'test' }] };
test('本机网关拒绝未授权和跨站请求，默认路由即时更新', async t => {
  const { manager, llm } = await fixture(t); await manager.globalModel(models[0]);
  const url = await listen(t, gatewayHandler({ llm: () => llm, settings: () => manager.settings }));
  const request = (body, extra = {}) => fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${manager.settings.token}`, ...extra }, body: JSON.stringify(body) });
  assert.equal((await request(message, { authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await request(message, { origin: 'https://evil.example' })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/v1/models`, { headers: { host: 'evil.example', authorization: `Bearer ${manager.settings.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHost, 403);
  const response = await request(message), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.choices[0].message.content, '{"ok":true}');
  assert.deepEqual(data.usage, { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
  assert.equal(llm.calls.at(-1).model, 'model-a');
  await manager.globalModel(models[1]); await request(message);
  assert.equal(llm.calls.at(-1).model, 'model-b');
  assert.equal((await request({ ...message, model: models[0] })).status, 200);
  assert.equal(llm.calls.at(-1).model, 'model-a');
  assert.equal((await request({ ...message, model: 'removed' })).status, 400);
});

test('结构化输出按 Schema 校验，格式错误和模型失败不冒充成功', async t => {
  const { manager, llm } = await fixture(t);
  const body = { ...message, response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } } };
  const route = (await manager.state()).models[0], signal = new AbortController().signal;
  await completion(llm, body, route, signal);
  llm.text = '{"ok":"wrong"}'; await assert.rejects(completion(llm, body, route, signal), { status: 502 });
  llm.text = 'not JSON'; await assert.rejects(completion(llm, body, route, signal), { status: 502 });
  llm.stream = async function* () { yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":' } }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; };
  assert.equal((await completion(llm, body, route, signal)).choices[0].finish_reason, 'length');
  llm.stream = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'secret upstream error' } } }; };
  await assert.rejects(completion(llm, message, route, signal), { status: 502, message: 'DSH 模型调用失败，请检查该模型配置' });
});

test('工具定义、调用历史和返回值保留，生成参数校验在转接边界执行', () => {
  const route = { provider: 'example', model: 'model-a' }, signal = new AbortController().signal;
  const body = { ...message, messages: [...message.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"hello"}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'found' }], tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }], max_tokens: 200 };
  const { options } = optionsFor(body, route, signal);
  assert.equal(options.messages.at(-1).source.callId, 'call-1');
  assert.equal(options.messages.at(-2).content[1].arguments, '{"q":"hello"}');
  assert.equal(options.tools[0].name, 'search'); assert.equal(options.maxTokens, 200);
  for (const patch of [{ stream: true }, { messages: [] }, { tools: {} }, { tools: [null] }, { max_tokens: -1 }, { response_format: { type: 'invalid' } }, { top_p: 0.8 }, { n: 2 }]) assert.throws(() => optionsFor({ ...message, ...patch }, route, signal), { status: 400 });
});

test('管理 API 拒绝跨站及未带写入令牌的操作，响应不泄漏私有令牌', async t => {
  const { manager } = await fixture(t), url = await listen(t, apiHandler(manager));
  const initial = await (await fetch(url)).json();
  assert.equal(initial.token, undefined); assert.ok(initial.key);
  const post = (key, origin) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hindsight-key': key, ...(origin ? { origin } : {}) }, body: JSON.stringify({ type: 'logout' }) });
  assert.equal((await post('wrong')).status, 403);
  assert.equal((await post(initial.key, 'https://evil.example')).status, 403);
  assert.equal((await post(initial.key)).status, 200);
});
