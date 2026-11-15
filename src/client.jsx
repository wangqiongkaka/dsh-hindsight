import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { ENDPOINT } from './api-path.mjs';
import styles from './client.css';

export const name = 'dsh-hindsight-client';
export const inject = ['slots', 'locale'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('dsh-hindsight', { 'zh-CN': { title: 'Hindsight 管理' }, 'en-US': { title: 'Hindsight 管理' } }));
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-hindsight', order: 30, label: () => 'Hindsight', locale: 'dsh-hindsight' }, HindsightPage)));
}

async function request(input, key) {
  let response;
  try {
    response = await fetch(ENDPOINT, input ? { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-hindsight-key': key }, body: JSON.stringify(input) } : { cache: 'no-store' });
  } catch { throw new Error('无法连接插件后台，请稍后重试'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('插件后台尚未就绪，请稍后重试'); }
  if (!response.ok) throw new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
  return data;
}

export function HindsightPage() {
  const [state, setState] = useState(null), [globalModel, setGlobalModel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [frameUrl, setFrameUrl] = useState(''), [consoleError, setConsoleError] = useState(''), [connecting, setConnecting] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(''); setConsoleError(''); setConnecting(true);
    void request().then(async next => {
      if (!active) return;
      setState(next); setGlobalModel(next.defaultModel);
      try {
        const result = await request({ type: 'console.open' }, next.key);
        if (active) setFrameUrl(result.url);
      } catch (cause) { if (active) setConsoleError(cause.message); }
      finally { if (active) setConnecting(false); }
    }).catch(cause => { if (active) { setError(cause.message); setConnecting(false); } });
    return () => { active = false; };
  }, [reload]);

  async function modelsAction(save) {
    setBusy(true); setError(''); setNotice('');
    try {
      if (save) setNotice((await request({ type: 'global.save', model: globalModel }, state.key)).message);
      const next = await request(); setState(next); setGlobalModel(next.defaultModel);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function openConsole() {
    setConnecting(true); setConsoleError(''); setFrameUrl('');
    try { setFrameUrl((await request({ type: 'console.open' }, state.key)).url); }
    catch (cause) { setConsoleError(cause.message); }
    finally { setConnecting(false); }
  }

  const models = state?.models ?? [];
  const savedLabel = models.find(model => model.id === state?.defaultModel)?.label ?? '已配置模型当前不可用';
  return <main className="hm" aria-label="Hindsight 管理">
    <style>{styles}</style>
    <section className="hm-model" aria-labelledby="hm-model-title">
      <div className="hm-heading"><h2 id="hm-model-title">全局默认模型</h2>
        <Button variant="outline" disabled={busy || !state} onClick={() => void modelsAction(false)}>刷新模型</Button>
      </div>
      {error && <div className="hm-error" role="alert">{error}{!state && <Button variant="outline" onClick={() => setReload(value => value + 1)}>重试</Button>}</div>}
      {notice && <p className="hm-notice" role="status">{notice}</p>}
      {!state ? <p role="status">{error ? '请确认插件后台正常运行。' : '正在读取模型配置…'}</p> : <>
        {state.modelError && <p className="hm-error" role="alert">{state.modelError}</p>}
        {!models.length && !state.modelError && <p className="hm-help">请先在 DSH 中添加服务商模型，然后刷新。</p>}
        <form className="hm-model-form" onSubmit={event => { event.preventDefault(); void modelsAction(true); }}>
          <div><label htmlFor="hm-global">默认模型</label><select id="hm-global" value={globalModel} disabled={busy || !models.length} onChange={event => setGlobalModel(event.target.value)}>
            <option value="">请选择 DSH 已配置模型</option>
            {globalModel && !models.some(model => model.id === globalModel) && <option value={globalModel}>已配置模型当前不可用</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></div>
          <Button type="submit" variant="primary" disabled={busy || !state.gateway || !models.some(model => model.id === globalModel)}>保存默认模型并生成环境文件</Button>
        </form>
        {!state.gateway && <p className="hm-error" role="alert">模型转接未启动，请检查插件端口配置；原生控制台仍可使用。</p>}
        <dl className="hm-details"><div><dt>已保存的默认路由</dt><dd>{state.defaultModel ? savedLabel : '尚未配置'}</dd></div>
          <div><dt>环境文件</dt><dd><code>{state.environmentFile}</code></dd></div></dl>
        <p className="hm-help">首次接入需加载环境文件并重启 Hindsight，之后可直接切换默认模型。DSH 需保持运行；服务已有的独立用途配置仍然优先。环境文件含私有令牌，请勿分享。</p>
      </>}
    </section>
    <section className="hm-console" aria-labelledby="hm-console-title">
      <div className="hm-heading"><h2 id="hm-console-title">Hindsight 控制台</h2>
        <Button variant="outline" disabled={connecting || !state} onClick={() => void openConsole()}>重新载入</Button>
      </div>
      {connecting && <p className="hm-help" role="status">正在打开原生控制台…</p>}
      {consoleError && <div className="hm-error" role="alert">{consoleError}<Button variant="outline" disabled={connecting} onClick={() => void openConsole()}>重试连接</Button></div>}
      {frameUrl && <iframe className="hm-frame" title="Hindsight 原生控制台" src={frameUrl} referrerPolicy="no-referrer" />}
    </section>
  </main>;
}
