import { CONSOLE_PATH } from './api-path.mjs';

// 仅运行在原生控制台 iframe 内，补齐 Next 动态加载和浏览器导航产生的根路径。
export const consoleBridge = `(${function (prefix) {
  const map = value => {
    const url = new URL(String(value), location.href);
    if (url.origin === location.origin && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) url.pathname = prefix + url.pathname;
    return url.href;
  };
  const fetchNative = window.fetch;
  window.fetch = function (input, options) {
    const headers = new Headers(options?.headers || (input instanceof Request ? input.headers : undefined));
    if (headers.get('rsc') === '1') {
      // shortcut: 原生 Next 未配置代理前缀，导航回退为完整页面；原生支持该前缀后移除此分支。
      const url = new URL(map(input instanceof Request ? input.url : input)); url.searchParams.delete('_rsc');
      const response = new Response('', { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: url.href });
      return Promise.resolve(response);
    }
    if (input instanceof Request) { const url = map(input.url); if (url !== input.url) input = new Request(url, input); }
    else input = map(input);
    return fetchNative.call(window, input, options);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return open.call(this, method, map(url), ...rest); };
  for (const [type, key] of [[HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLAnchorElement, 'href']]) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, key);
    Object.defineProperty(type.prototype, key, { ...descriptor, set(value) { descriptor.set.call(this, map(value)); } });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (key, value) {
    if (key === 'src' && this instanceof HTMLScriptElement || key === 'href' && (this instanceof HTMLLinkElement || this instanceof HTMLAnchorElement)) value = map(value);
    return setAttribute.call(this, key, value);
  };
  for (const key of ['pushState', 'replaceState']) {
    const original = history[key];
    history[key] = function (state, unused, url) { return original.call(this, state, unused, url == null ? url : map(url)); };
  }
}})(${JSON.stringify(CONSOLE_PATH)});`;
