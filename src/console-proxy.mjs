import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONSOLE_PATH } from './api-path.mjs';
import { HttpError, localRequest, failure } from './http.mjs';
import { consoleBridge } from './console-bridge.mjs';

/**
 * The native console is a desktop-first app shown at phone width inside its iframe. These rules
 * only touch what breaks at that width: the bank palette's rows, long bank ids and the search
 * field (16px keeps iOS from zooming the whole console when the keyboard opens). Nothing here
 * adds or removes console features.
 */
export const consolePhoneStyle = '<style data-dsh-hindsight-phone>@media (max-width: 720px){'
  + '[role="combobox"]{min-height:44px}'
  + '[cmdk-input]{font-size:16px !important}'
  + '[cmdk-item]{min-height:44px}'
  // A bank id like `coding-agent::crm-2026-11-12-7e…` is the only thing distinguishing rows on a
  // phone, where the title attribute has no hover to reveal it: let it take two lines.
  + '[cmdk-item]>div.relative>span.truncate.flex-1{display:-webkit-box;white-space:normal;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}'
  // The count stays; the relative time beside it is the first thing to give up the little width.
  + '[cmdk-item] span.tabular-nums>span.ml-1\\.5{display:none}'
  + '[data-radix-popper-content-wrapper] [cmdk-list]{max-height:min(300px,calc(100dvh - 240px))}'
  + '}</style>';

const MAX_TEXT = 16 * 1024 * 1024;
const requestHeaders = ['accept', 'accept-language', 'content-type', 'range', 'rsc', 'next-url', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch', 'next-action', 'next-hmr-refresh'];
const hopHeaders = new Set(['connection', 'transfer-encoding', 'keep-alive', 'set-cookie', 'content-encoding', 'content-length']);

function publicPath(value, target) {
  if (!value || value.startsWith('//') || value.startsWith(CONSOLE_PATH)) return value;
  let url;
  try { url = new URL(value, target); } catch { return value; }
  if (url.origin !== target.origin || !value.startsWith('/') && !value.startsWith(target.origin)) return value;
  const base = target.pathname.replace(/\/$/, '');
  const path = base && (url.pathname === base || url.pathname.startsWith(base + '/')) ? url.pathname.slice(base.length) || '/' : url.pathname;
  return CONSOLE_PATH + path + url.search + url.hash;
}

export function rewriteConsole(text, type, target) {
  if (type.includes('text/html')) return text.replace(/\b(href|src|action|poster)=(['"])([^'"]*)\2/gi,
    (_, attribute, quote, value) => `${attribute}=${quote}${publicPath(value, target)}${quote}`)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, start, body, end) => start + body.replaceAll(target.pathname.replace(/\/$/, '') + '/_next/', CONSOLE_PATH + '/_next/') + end)
    .replace(/<head(?:\s[^>]*)?>/i, match => `${match}<script src="${CONSOLE_PATH}/_bridge.js"></script>${consolePhoneStyle}`);
  if (type.includes('text/css')) return text.replace(/url\(\s*(['"]?)(\/[^)'"\s]*)\1\s*\)/g,
    (_, quote, value) => `url(${quote}${publicPath(value, target)}${quote})`);
  if (!/(?:application|text)\/(?:javascript|x-javascript)/i.test(type)) return text;
  // 只改应用路径字面量，不改 API JSON 或记忆正文，也不改普通的 "/" 分隔符。
  return text.replace(/(["'`])\/(?:_next|api|fonts|static|images|logo|favicon)(?=[\/?.#"'`-]|$)/g,
    match => match[0] + CONSOLE_PATH + match.slice(1))
    // shortcut: Hindsight 1.2 的 BankProvider 仅识别根路径，原生支持 basePath 后移除此兼容。
    .replaceAll('/^\\/banks\\/', '/^(?:' + CONSOLE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('/', '\\/') + ')?\\/banks\\/');
}

export function consoleProxy(manager, authorize) {
  return async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', abort);
    try {
      localRequest(req);
      if (!authorize) throw new HttpError(503, 'DSH 控制台鉴权服务尚未就绪');
      if (!authorize(req, res)) return;
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) throw new HttpError(405, '控制台请求方法无效');
      if (req.url.split('?')[0] === CONSOLE_PATH + '/_bridge.js' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? '' : consoleBridge); return;
      }
      if (!manager.consoleSession) await manager.openConsole();
      const suffix = req.url.slice(CONSOLE_PATH.length);
      if (suffix && !suffix.startsWith('/') && !suffix.startsWith('?')) throw new HttpError(404, '控制台路径无效');
      const makeTarget = () => new URL(manager.consoleSession.url + (suffix.startsWith('/') ? suffix : '/' + suffix));
      let target = makeTarget();
      const headers = new Headers();
      for (const name of requestHeaders) if (req.headers[name]) headers.set(name, String(req.headers[name]));
      headers.set('accept-encoding', 'identity');
      headers.set('origin', target.origin);
      headers.set('referer', target.href);
      const send = () => {
        headers.set('cookie', manager.consoleSession.cookie);
        return manager.fetch(target, { method: req.method, headers, redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }) });
      };
      let reply = await send();
      const expired = reply.status === 401 && reply.headers.get('x-hindsight-session-required') === '1'
        || [301, 302, 303, 307, 308].includes(reply.status) && /\/login(?:\?|$)/.test(reply.headers.get('location') ?? '');
      if (expired && manager.consoleSession.cookie && ['GET', 'HEAD'].includes(req.method)) {
        await reply.body?.cancel(); await manager.openConsole(); target = makeTarget(); reply = await send();
      }
      for (const cookie of reply.headers.getSetCookie()) {
        const pair = cookie.split(';')[0];
        if (/^hindsight_cp_access=[A-Za-z0-9._~-]*$/.test(pair)) manager.consoleSession.cookie = pair.endsWith('=') ? '' : pair;
      }
      const outgoing = {};
      const connectionFields = (reply.headers.get('connection') ?? '').toLowerCase().split(',').map(value => value.trim());
      for (const [name, value] of reply.headers) if (!hopHeaders.has(name) && !connectionFields.includes(name)) outgoing[name] = value;
      if (outgoing.location) {
        const location = new URL(outgoing.location, target);
        if (location.origin !== target.origin) throw new HttpError(502, '原生控制台返回了外部跳转');
        outgoing.location = publicPath(location.href, new URL(manager.consoleSession.url));
      }
      const type = reply.headers.get('content-type') ?? '';
      const rewrite = !suffix.startsWith('/api/') && /text\/html|text\/css|(?:application|text)\/(?:javascript|x-javascript)/i.test(type);
      if (rewrite && reply.body && req.method !== 'HEAD') {
        const chunks = []; let size = 0;
        for await (const chunk of reply.body) {
          size += chunk.length; if (size > MAX_TEXT) throw new HttpError(502, '控制台页面资源超过代理大小限制');
          chunks.push(chunk);
        }
        outgoing['cache-control'] = 'no-cache'; delete outgoing.etag;
        res.writeHead(reply.status, outgoing);
        res.end(rewriteConsole(Buffer.concat(chunks).toString('utf8'), type, new URL(manager.consoleSession.url)));
      } else {
        res.writeHead(reply.status, outgoing);
        if (!reply.body || req.method === 'HEAD') { res.end(); await reply.body?.cancel(); }
        else await pipeline(Readable.fromWeb(reply.body), res);
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else failure(res, error);
    } finally { res.off('close', abort); }
  };
}
