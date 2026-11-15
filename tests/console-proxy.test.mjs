import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleProxy, rewriteConsole } from '../src/console-proxy.mjs';
import { CONSOLE_PATH } from '../src/api-path.mjs';
import { fixture, listen } from './helpers.mjs';

test('代理保留鉴权，私有 Cookie 留在后台，不把 DSH 凭据转发给原生控制台', async t => {
  const { manager } = await fixture(t);
  const requests = [];
  const native = await listen(t, async (req, res) => {
    requests.push(req.headers);
    if (req.url === '/api/version') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"features":{"access_key_auth":true}}');
    if (req.url === '/api/auth/login') { for await (const _ of req) {} return res.writeHead(200, { 'set-cookie': 'hindsight_cp_access=private-session; HttpOnly' }).end('{}'); }
    if (req.url === '/') return res.writeHead(307, { location: '/dashboard' }).end();
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'hindsight_cp_access=renewed; HttpOnly' });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.end(JSON.stringify({ cookie: req.headers.cookie, authorization: req.headers.authorization ?? null, text: '/api/literal', body: Buffer.concat(chunks).toString() }));
  });
  manager.fetch = fetch; manager.consoleAddress = native;
  const proxy = await listen(t, consoleProxy(manager, (req, res) => {
    if (req.headers.cookie === 'dsh=paired') return true;
    res.writeHead(401).end(); return false;
  }));
  assert.equal((await fetch(proxy + CONSOLE_PATH + '/')).status, 401);
  assert.equal(requests.length, 0);
  const headers = { cookie: 'dsh=paired', authorization: 'Bearer dsh-secret', 'content-type': 'application/json' };
  const redirected = await fetch(proxy + CONSOLE_PATH + '/', { headers, redirect: 'manual' });
  assert.equal(redirected.headers.get('location'), CONSOLE_PATH + '/dashboard');
  const response = await fetch(proxy + CONSOLE_PATH + '/api/example', { method: 'PATCH', headers, body: '{"value":"/api/keep-this"}' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { cookie: 'hindsight_cp_access=private-session', authorization: null, text: '/api/literal', body: '{"value":"/api/keep-this"}' });
  assert.equal(manager.consoleSession.cookie, 'hindsight_cp_access=renewed');
  assert.equal((await fetch(proxy + CONSOLE_PATH + '/', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
});

test('页面、脚本和样式路径留在代理内，外部链接、API 数据和普通分隔符保持原样', () => {
  const target = new URL('http://localhost:9999');
  assert.equal(rewriteConsole('<a href="/dashboard">控制台</a><script src="/_next/app.js"></script><a href="https://example.com">外部</a>', 'text/html', target), `<a href="${CONSOLE_PATH}/dashboard">控制台</a><script src="${CONSOLE_PATH}/_next/app.js"></script><a href="https://example.com">外部</a>`);
  assert.equal(rewriteConsole('fetch("/api/banks");const p="/_next/";const logo="/logo.png";x.split("/")', 'application/javascript', target), `fetch("${CONSOLE_PATH}/api/banks");const p="${CONSOLE_PATH}/_next/";const logo="${CONSOLE_PATH}/logo.png";x.split("/")`);
  assert.equal(rewriteConsole('a{background:url(/images/a.png)}', 'text/css', target), `a{background:url(${CONSOLE_PATH}/images/a.png)}`);
  assert.equal(rewriteConsole('<a href="/hindsight/dashboard">控制台</a>', 'text/html', new URL('http://localhost:9999/hindsight')), `<a href="${CONSOLE_PATH}/dashboard">控制台</a>`);
  assert.equal(rewriteConsole('<script>self.__next_f.push(["/_next/static/app.js"])</script>', 'text/html', target), `<script>self.__next_f.push(["${CONSOLE_PATH}/_next/static/app.js"])</script>`);
  assert.equal(rewriteConsole('1:I["/_next/static/bank.js"]', 'text/x-component', target), '1:I["/_next/static/bank.js"]');
  assert.equal(rewriteConsole('{"memory":"/api/literal"}', 'application/json', target), '{"memory":"/api/literal"}');
  assert.equal(rewriteConsole('router.push("/banks/id")', 'application/javascript', target), 'router.push("/banks/id")');
  const parseBank = new Function('path', rewriteConsole('return path.match(/^\\/banks\\/([^/?]+)/)?.[1]', 'application/javascript', target));
  assert.equal(parseBank(CONSOLE_PATH + '/banks/coding%3A%3Aagent?view=data'), 'coding%3A%3Aagent');
  assert.equal(parseBank('/banks/original'), 'original');
});

test('原生会话过期时读取只续期一次，写入不会自动重试', async t => {
  let logins = 0, requests = 0;
  const manager = {
    consoleSession: { url: 'http://localhost:9999', cookie: 'hindsight_cp_access=expired' },
    async openConsole() { logins++; this.consoleSession.cookie = 'hindsight_cp_access=renewed'; },
    async fetch() { requests++; return new Response('{}', { status: 401, headers: { 'x-hindsight-session-required': '1', 'content-type': 'application/json' } }); },
  };
  const proxy = await listen(t, consoleProxy(manager, () => true));
  assert.equal((await fetch(proxy + CONSOLE_PATH + '/api/banks')).status, 401);
  assert.equal(logins, 1); assert.equal(requests, 2);
  assert.equal((await fetch(proxy + CONSOLE_PATH + '/api/banks', { method: 'POST', body: '{}' })).status, 401);
  assert.equal(logins, 1); assert.equal(requests, 3);
});
