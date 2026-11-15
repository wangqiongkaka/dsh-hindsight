import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog, DEFAULT_MODEL } from './gateway.mjs';
import { HttpError } from './http.mjs';
import { consoleAccessKey, loopbackHosts } from './console-auth.mjs';
import { CONSOLE_PATH } from './api-path.mjs';

async function privateFile(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}

export function consoleUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, '控制台地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, '请填写不含凭据、查询参数和片段的 HTTP(S) 地址');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new HttpError(400, '远程控制台必须使用 HTTPS');
  return url.href.replace(/\/+$/, '');
}

export class HindsightManager {
  constructor({ root, llm, fetchImpl = fetch, accessKey = consoleAccessKey, consoleAddress = '' }) {
    this.root = root; this.llm = llm; this.fetch = fetchImpl; this.accessKey = accessKey; this.consoleAddress = consoleAddress; this.gateway = null; this.consoleSession = null;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    let saved;
    try { saved = JSON.parse(await readFile(join(this.root, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Hindsight 配置读取失败，请检查 settings.json，原文件未改动'); }
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1 || typeof saved.token !== 'string' || !/^[a-f0-9]{64}$/.test(saved.token) || typeof saved.defaultModel !== 'string' || consoleUrl(saved.consoleUrl) !== saved.consoleUrl)) throw new Error('Hindsight 配置格式无效，原文件未改动');
    this.settings = saved ?? { version: 1, consoleUrl: 'http://localhost:9999', defaultModel: '', token: randomBytes(32).toString('hex') };
    if (!saved) await this.persist(this.settings);
    else await chmod(join(this.root, 'settings.json'), 0o600);
  }
  async persist(next) {
    await privateFile(join(this.root, 'settings.json'), JSON.stringify(next, null, 2) + '\n');
    this.settings = next;
  }
  async state() {
    let models = [], modelError = '';
    try { models = await catalog(this.llm()); } catch { modelError = 'DSH 模型目录读取失败，请检查模型服务并刷新'; }
    return { models, modelError, defaultModel: this.settings.defaultModel,
      gateway: this.gateway, environmentFile: join(this.root, 'hindsight.env') };
  }
  async openConsole() {
    const url = consoleUrl(this.consoleAddress || this.settings.consoleUrl);
    if (!loopbackHosts.includes(new URL(url).hostname)) throw new HttpError(400, '仅代理宿主机本地控制台');
    const request = async (path, options = {}) => {
      try { return await this.fetch(`${url}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw new HttpError(502, '无法连接原生控制台，请确认 Hindsight 正在运行后重试'); }
    };
    const versionResponse = await request('/api/version');
    if (!versionResponse.ok) throw new HttpError(502, `原生控制台连接失败（HTTP ${versionResponse.status}），请检查控制台地址配置`);
    let version;
    try { version = await versionResponse.json(); } catch { throw new HttpError(502, '原生控制台版本响应无效'); }
    if (!version || typeof version.features?.access_key_auth !== 'boolean') throw new HttpError(502, '原生控制台未提供受支持的认证能力');
    let cookie = '';
    if (version.features.access_key_auth) {
      const key = await this.accessKey(url);
      if (typeof key !== 'string' || !key || key.length > 8192) throw new HttpError(503, '本机控制台凭据无效，请检查环境配置后重试');
      const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!response.ok) throw new HttpError(response.status, '原生控制台自动登录失败，请检查本机 HINDSIGHT_CP_ACCESS_KEY 配置后重试');
      cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('hindsight_cp_access=')) ?? '';
      if (!/^hindsight_cp_access=[A-Za-z0-9._~-]+$/.test(cookie)) throw new HttpError(502, '控制台没有返回受支持的原生登录会话');
    }
    this.consoleSession = { url, cookie };
    return { url: `${CONSOLE_PATH}/` };
  }
  async choose(id) {
    const model = (await catalog(this.llm())).find(item => item.id === id);
    if (!model) throw new HttpError(400, '所选 DSH 模型已不存在，请刷新后重新选择');
    return model;
  }
  async globalModel(id) {
    await this.choose(id);
    if (!this.gateway) throw new HttpError(503, '模型转接服务尚未启动');
    const env = [
      '# 由 dsh-hindsight 生成；包含私有转接令牌，请勿提交到 Git。',
      '# 首次加载后重启 Hindsight。后续切换默认模型由 DSH 路由生效。',
      'HINDSIGHT_API_LLM_PROVIDER=openai',
      `HINDSIGHT_API_LLM_BASE_URL=${this.gateway}/v1`,
      `HINDSIGHT_API_LLM_API_KEY=${this.settings.token}`,
      `HINDSIGHT_API_LLM_MODEL=${DEFAULT_MODEL}`,
      '',
    ].join('\n');
    await privateFile(join(this.root, 'hindsight.env'), env);
    await this.persist({ ...this.settings, defaultModel: id });
    return { message: '默认路由已保存，环境文件已生成。首次接入需加载文件并重启 Hindsight。' };
  }
  async action(input) {
    switch (input.type) {
      case 'console.open': return this.openConsole();
      case 'global.save': return this.globalModel(input.model);
      default: throw new HttpError(400, '未知操作');
    }
  }
}
