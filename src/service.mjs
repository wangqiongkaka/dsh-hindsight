import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { catalog, DEFAULT_MODEL } from './gateway.mjs';
import { HttpError } from './http.mjs';

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
  constructor({ root, llm, fetchImpl = fetch }) {
    this.root = root; this.llm = llm; this.fetch = fetchImpl; this.session = null; this.gateway = null;
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
    return { consoleUrl: this.settings.consoleUrl, loggedIn: !!this.session, models, modelError, defaultModel: this.settings.defaultModel,
      gateway: this.gateway, environmentFile: join(this.root, 'hindsight.env') };
  }
  async upstream(path, session = this.session) {
    if (!session) throw new HttpError(401, '请先登录 Hindsight 控制台');
    let response;
    try { response = await this.fetch(`${session.url}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: session.cookie ? { cookie: session.cookie } : {} }); }
    catch { throw new HttpError(502, '无法连接 Hindsight 控制台，请检查地址和服务状态'); }
    if (response.status === 401 && response.headers.get('x-hindsight-session-required') === '1') {
      if (this.session === session) this.session = null;
      throw new HttpError(401, '控制台登录已过期，请重新登录');
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '请检查控制台权限及后端 API 认证配置' : response.status === 404 ? '请检查控制台地址和版本' : '请检查 Hindsight 服务日志';
      throw new HttpError(response.status, `Hindsight 请求失败（HTTP ${response.status}），${hint}`);
    }
    let data;
    try { data = await response.json(); } catch { throw new HttpError(502, 'Hindsight 返回了无效 JSON'); }
    if (!data || typeof data !== 'object') throw new HttpError(502, 'Hindsight 响应格式无效');
    return data;
  }
  async login(urlValue, key) {
    const url = consoleUrl(urlValue);
    if (typeof key !== 'string' || key.length > 8192) throw new HttpError(400, '访问密钥无效');
    const version = await this.upstream('/api/version', { url });
    let cookie = '';
    if (version.features?.access_key_auth !== false) {
      let response;
      try { response = await this.fetch(`${url}/api/auth/login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }); }
      catch { throw new HttpError(502, '无法连接 Hindsight 登录接口'); }
      if (!response.ok) throw new HttpError(response.status, response.status === 401 ? '访问密钥不正确' : `控制台登录失败（HTTP ${response.status}）`);
      cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('hindsight_cp_access=')) ?? '';
      if (!cookie) throw new HttpError(502, '控制台没有返回受支持的登录会话');
    }
    await this.persist({ ...this.settings, consoleUrl: url });
    this.session = { url, cookie };
    return { loggedIn: true };
  }
  async banks() {
    const banks = []; let offset = 0;
    while (true) {
      const data = await this.upstream(`/api/banks?limit=100&offset=${offset}`);
      if (!Array.isArray(data.banks) || !data.banks.every(bank => typeof bank?.bank_id === 'string' && (bank.name == null || typeof bank.name === 'string'))) throw new HttpError(502, '控制台记忆库列表格式无效');
      banks.push(...data.banks.map(bank => ({ id: bank.bank_id, name: bank.name ?? bank.bank_id })));
      offset += data.banks.length;
      if (!data.banks.length || offset >= (data.total ?? offset)) return { banks };
      if (offset >= 10000) throw new HttpError(413, '记忆库数量超过 10000，请在原控制台管理');
    }
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
      case 'login': return this.login(input.url, input.key);
      case 'logout': this.session = null; return { loggedIn: false };
      case 'banks': return this.banks();
      case 'global.save': return this.globalModel(input.model);
      default: throw new HttpError(400, '未知操作');
    }
  }
}
