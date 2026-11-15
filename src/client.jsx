import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { ENDPOINT } from './api-path.mjs';
import styles from './client.css';

export const name = 'dsh-hindsight-client';
export const inject = ['slots', 'locale'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('dsh-hindsight', { 'zh-CN': { title: 'Hindsight 管理' }, 'en-US': { title: 'Hindsight 管理' } }));
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-hindsight', locale: 'dsh-hindsight' }, HindsightPage));
}

async function responseData(response) {
  let data;
  try { data = await response.json(); } catch { throw new Error('插件后台尚未就绪，请稍后刷新'); }
  if (!response.ok) throw new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
  return data;
}

function ModelSelect({ id, models, value, onChange, disabled }) {
  return <select id={id} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
    <option value="">请选择 DSH 已配置模型</option>
    {value && !models.some(model => model.id === value) && <option value={value}>已配置模型当前不可用</option>}
    {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
  </select>;
}

export function HindsightPage() {
  const [state, setState] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [url, setUrl] = useState('http://localhost:9999'), [key, setKey] = useState(''), [globalModel, setGlobalModel] = useState('');
  const [banks, setBanks] = useState([]);
  async function load() {
    const next = await responseData(await fetch(ENDPOINT, { cache: 'no-store' }));
    setState(next);
    if (!next.loggedIn) setBanks([]);
    return next;
  }
  async function call(input, snapshot = state) {
    const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hindsight-key': snapshot.key }, body: JSON.stringify(input) });
    if (response.status === 401) await load();
    return responseData(response);
  }
  async function run(action) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void responseDataFromState();
    async function responseDataFromState() {
      try {
        const next = await responseData(await fetch(ENDPOINT, { cache: 'no-store' }));
        if (!active) return;
        setState(next); setUrl(next.consoleUrl); setGlobalModel(next.defaultModel);
        if (next.loggedIn) {
          const result = await responseData(await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hindsight-key': next.key }, body: JSON.stringify({ type: 'banks' }) }));
          if (active) setBanks(result.banks);
        }
      } catch (cause) { if (active) setError(cause.message); }
    }
    return () => { active = false; };
  }, []);

  const models = state?.models ?? [];
  const modelLabel = id => models.find(model => model.id === id)?.label ?? '已配置模型当前不可用';
  return <main className="hm" aria-label="Hindsight 管理">
    <style>{styles}</style>
    <header className="hm-header"><div><span className="hm-eyebrow">DSH 插件</span><h1>Hindsight 管理</h1><p>连接记忆控制台，复用 DSH 已有的大模型配置。</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void run(async () => { const next = await load(); setUrl(next.consoleUrl); setGlobalModel(next.defaultModel); if (next.loggedIn) setBanks((await call({ type: 'banks' }, next)).banks); })}>刷新</Button>
    </header>
    {error && <div className="hm-error" role="alert">{error}</div>}
    {notice && <div className="hm-notice" role="status">{notice}</div>}
    {!state ? <p role="status">{error ? '请确认插件已安装并启动，然后刷新。' : '正在读取插件状态…'}</p> : <>
      <section className="hm-section" aria-labelledby="hm-connect-title">
        <div className="hm-section-head"><h2 id="hm-connect-title">控制台连接</h2><span className={state.loggedIn ? 'hm-tag hm-online' : 'hm-tag'}>{state.loggedIn ? '已登录' : '未登录'}</span></div>
        <form onSubmit={event => { event.preventDefault(); const secret = key; setKey(''); void run(async () => { await call({ type: 'login', url, key: secret }); await load(); setNotice('控制台登录成功'); setBanks((await call({ type: 'banks' })).banks); }); }}>
          <fieldset disabled={busy || state.loggedIn}>
            <label htmlFor="hm-url">控制台地址</label><input id="hm-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="http://localhost:9999" />
            {!state.loggedIn && <><label htmlFor="hm-key">访问密钥</label><input id="hm-key" type="password" value={key} autoComplete="off" onChange={event => setKey(event.target.value)} placeholder="HINDSIGHT_CP_ACCESS_KEY；未启用认证时可留空" /></>}
          </fieldset>
          <div className="hm-actions">{!state.loggedIn ? <Button type="submit" variant="primary" disabled={busy}>{busy ? '正在处理…' : '登录控制台'}</Button>
            : <Button type="button" variant="outline" disabled={busy} onClick={() => void run(async () => { await call({ type: 'logout' }); await load(); setNotice('已退出插件控制台会话'); })}>退出登录</Button>}
            <a href={state.consoleUrl} target="_blank" rel="noopener noreferrer">打开原生控制台 ↗</a>
          </div>
          <p className="hm-help">密钥仅用于后台换取登录会话，关闭插件后需重新登录。原生控制台使用自己的浏览器登录会话。</p>
        </form>
      </section>

      <section className="hm-section" aria-labelledby="hm-global-title">
        <div className="hm-section-head"><h2 id="hm-global-title">全局默认模型</h2><span className="hm-tag">{state.gateway ? '转接已启动' : '转接不可用'}</span></div>
        <p>从 DSH 已有模型中选择，服务商密钥继续由 DSH 管理。</p>
        {state.modelError && <p className="hm-error" role="alert">{state.modelError}</p>}
        {!models.length && !state.modelError && <p className="hm-help">DSH 尚未配置模型，请先在 DSH 服务商设置中添加，然后刷新。</p>}
        <form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await call({ type: 'global.save', model: globalModel }); await load(); setNotice(result.message); }); }}>
          <label htmlFor="hm-global">默认模型</label><ModelSelect id="hm-global" models={models} value={globalModel} onChange={setGlobalModel} disabled={busy || !models.length} />
          <div className="hm-actions"><Button type="submit" variant="primary" disabled={busy || !globalModel || !state.gateway || !models.some(model => model.id === globalModel)}>保存默认模型并生成环境文件</Button></div>
        </form>
        <div className="hm-detail"><span>已保存的默认路由</span><strong>{state.defaultModel ? modelLabel(state.defaultModel) : '尚未配置'}</strong></div>
        <div className="hm-detail"><span>环境文件路径</span><code>{state.environmentFile}</code></div>
        <p className="hm-help">首次接入：让 Hindsight 服务加载这个文件，再重启服务。之后切换这里的默认模型会立即更新 DSH 路由。服务中已有独立用途的环境配置仍然优先。</p>
        <p className="hm-help">转接仅监听本机。Hindsight 必须能访问该地址，DSH 需要保持运行；Docker 部署需要额外配置本机网络。环境文件包含私有令牌，请勿分享。</p>
      </section>

      <section className="hm-section" aria-labelledby="hm-bank-title">
        <div className="hm-section-head"><h2 id="hm-bank-title">记忆库列表</h2><span className="hm-tag">只读{state.loggedIn ? ` · ${banks.length}` : ''}</span></div>
        {!state.loggedIn ? <p className="hm-help">登录控制台后可查看已有记忆库。</p> : <>
          <div><Button variant="outline" disabled={busy} onClick={() => void run(async () => { setBanks((await call({ type: 'banks' })).banks); setNotice('记忆库列表已刷新'); })}>刷新列表</Button></div>
          {banks.length ? <ul className="hm-banks" aria-label="记忆库列表">{banks.map(bank => <li key={bank.id}><strong>{bank.name}</strong><code>{bank.id}</code></li>)}</ul> : <p className="hm-help">暂无记忆库，可到原生控制台创建。</p>}
          <p className="hm-help">记忆内容与其他管理操作请在原生控制台中完成。</p>
        </>}
      </section>
    </>}
  </main>;
}
