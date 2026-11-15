import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { HttpError, equalSecret, localRequest, readJson, json, failure } from './http.mjs';

const ajv = new Ajv2020({ strict: false, validateFormats: false });
export const DEFAULT_MODEL = 'dsh-default';
export function modelId(provider, model) { return `dsh-${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`; }

export async function catalog(llm) {
  if (!llm) throw new HttpError(503, 'DSH 模型服务尚未就绪');
  return (await Promise.all(llm.listProviders().map(async provider => (await llm.listModels(provider.id)).map(model => ({
    id: modelId(provider.id, model.id), provider: provider.id, model: model.id, label: `${provider.name} · ${model.name ?? model.id}`,
  }))))).flat();
}

function textContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => part?.type === 'text' && typeof part.text === 'string')) return value.map(part => part.text).join('\n');
  throw new HttpError(400, '转接仅支持文本消息');
}

export function optionsFor(body, route, signal) {
  if (body.stream) throw new HttpError(400, 'Hindsight 转接使用非流式响应，请设置 stream=false');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, '缺少消息');
  if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice)) throw new HttpError(400, 'DSH 不支持强制工具选择');
  const messages = body.messages.map(message => {
    if (!message || !['user', 'assistant', 'system', 'developer', 'tool'].includes(message.role)) throw new HttpError(400, '消息角色无效');
    const content = [{ type: 'text', text: textContent(message.content) }];
    if (message.role === 'assistant' && message.tool_calls) {
      if (!Array.isArray(message.tool_calls)) throw new HttpError(400, '工具调用无效');
      for (const call of message.tool_calls) {
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw new HttpError(400, '工具调用无效');
        content.push({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') throw new HttpError(400, '缺少工具调用标识');
    const source = message.role === 'assistant' ? { kind: 'model', provider: route.provider, model: route.model }
      : message.role === 'tool' ? { kind: 'tool', callId: message.tool_call_id } : { kind: message.role === 'user' ? 'user' : 'system-prompt' };
    return { id: randomUUID(), role: message.role, source, content };
  });
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new HttpError(400, '工具定义必须是列表');
  for (const field of ['top_p', 'logit_bias', 'seed', 'frequency_penalty', 'presence_penalty']) {
    if (body[field] != null) throw new HttpError(400, `DSH 转接不支持参数 ${field}`);
  }
  if (body.n !== undefined && body.n !== 1) throw new HttpError(400, 'DSH 转接仅支持单个候选响应');
  const tools = body.tool_choice === 'none' ? [] : (body.tools ?? []).map(tool => {
    if (!tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.parameters || typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters)) throw new HttpError(400, '工具定义无效');
    return { name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters };
  });
  let validate;
  if (body.response_format) {
    const format = body.response_format;
    if (!['json_object', 'json_schema', 'text'].includes(format.type)) throw new HttpError(400, '响应格式不受支持');
    if (format.type === 'json_schema') {
      if (!format.json_schema?.schema || typeof format.json_schema.schema !== 'object') throw new HttpError(400, '缺少 JSON Schema');
      try { validate = ajv.compile(format.json_schema.schema); ajv.removeSchema(format.json_schema.schema); } catch { throw new HttpError(400, 'JSON Schema 无效'); }
    }
    // shortcut: DSH 暂无原生 response_format；用提示词和返回校验，宿主支持后改为原生约束。
    if (format.type !== 'text') messages.push({ role: 'user', content: [{ type: 'text', text: `Return only a valid JSON object, without Markdown.${format.type === 'json_schema' ? ` Match this JSON Schema: ${JSON.stringify(format.json_schema.schema)}` : ''}` }] });
  }
  const options = { provider: route.provider, model: route.model, messages, tools, signal };
  for (const [key, value] of [['temperature', body.temperature], ['maxTokens', body.max_completion_tokens ?? body.max_tokens]]) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || key === 'temperature' && (value < 0 || value > 2) || key === 'maxTokens' && (!Number.isInteger(value) || value <= 0)) throw new HttpError(400, '生成参数无效');
    options[key] = value;
  }
  if (body.stop !== undefined) {
    const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;
    if (!Array.isArray(stop) || !stop.every(item => typeof item === 'string')) throw new HttpError(400, '停止词无效');
    options.stop = stop;
  }
  if (body.reasoning_effort !== undefined) {
    if (typeof body.reasoning_effort !== 'string') throw new HttpError(400, '推理强度无效');
    options.reasoningEffort = body.reasoning_effort;
  }
  return { options, validate };
}

export async function completion(llm, body, route, signal) {
  const { options, validate } = optionsFor(body, route, signal);
  const blocks = new Map(); let usage = {}, reason;
  for await (const chunk of llm.stream(options)) {
    if (signal.aborted) throw new HttpError(499, '请求已取消');
    if (chunk.type === 'block-end') blocks.set(chunk.index, chunk.block);
    if (chunk.type === 'usage') usage = chunk.usage;
    if (chunk.type === 'finish') reason = chunk.reason;
  }
  if (!reason || ['error', 'aborted'].includes(reason.kind)) throw new HttpError(502, 'DSH 模型调用失败，请检查该模型配置');
  const ordered = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block);
  const content = ordered.filter(block => block.type === 'text').map(block => block.text).join('');
  const calls = ordered.filter(block => block.type === 'tool-call').map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }));
  if (!calls.length && reason.kind !== 'max-tokens' && body.response_format && body.response_format.type !== 'text') {
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new HttpError(502, '模型没有返回有效 JSON，请选择支持结构化输出的模型'); }
    if (!parsed || typeof parsed !== 'object' || validate && !validate(parsed)) throw new HttpError(502, '模型输出不符合 JSON Schema');
  }
  const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), output = usage.outputTokens ?? 0;
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: reason.kind === 'max-tokens' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output } };
}

export function gatewayHandler({ llm, settings }) {
  return async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 5 * 60 * 1000); timer.unref();
    res.once('close', abort);
    try {
      localRequest(req);
      if (!equalSecret(req.headers.authorization, `Bearer ${settings().token}`)) throw new HttpError(401, '转接令牌无效');
      const models = await catalog(llm());
      if (req.url === '/v1/models' && req.method === 'GET') return json(res, 200, { object: 'list', data: [DEFAULT_MODEL, ...models.map(model => model.id)].map(id => ({ id, object: 'model', owned_by: 'dsh' })) });
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') throw new HttpError(404, '接口不存在');
      const body = await readJson(req, 16 * 1024 * 1024);
      const route = models.find(model => model.id === (body.model === DEFAULT_MODEL ? settings().defaultModel : body.model));
      if (!route) throw new HttpError(400, '所选 DSH 模型不可用，请重新选择');
      json(res, 200, await completion(llm(), body, route, controller.signal));
    } catch (error) { failure(res, error); }
    finally { clearTimeout(timer); res.off('close', abort); }
  };
}
