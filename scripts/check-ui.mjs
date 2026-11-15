import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { fixture, models } from '../tests/helpers.mjs';
import { apiHandler, ENDPOINT } from '../src/api.mjs';
import { consoleAccessKey } from '../src/console-auth.mjs';
import { consoleProxy } from '../src/console-proxy.mjs';
import { CONSOLE_PATH } from '../src/api-path.mjs';

const real = process.argv.includes('--real-console');
const phone = process.argv.includes('--phone');
const safari = process.argv.includes('--webkit');
const cleanup = [], errors = [], failed = [], badScripts = [], flights = [], t = { after: action => cleanup.push(action) };
let browser, server, native, page, phoneServer;
try {
  const { manager, root } = await fixture(t);
  if (real) {
    manager.fetch = fetch; manager.accessKey = consoleAccessKey;
  } else {
    native = createServer((req, res) => {
      if (req.url === '/api/version') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"features":{"access_key_auth":true}}');
      if (req.url === '/api/auth/login') {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(body.key === 'test-access-key' ? 200 : 401, body.key === 'test-access-key' ? { 'set-cookie': 'hindsight_cp_access=test-session; HttpOnly' } : {}); res.end('{}');
        }); return;
      }
      if (!req.headers.cookie?.split('; ').includes('hindsight_cp_access=test-session')) { res.writeHead(307, { location: '/login' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>原生控制台测试替身</title><body style="margin:0;font:14px/1.6 system-ui;background:#fff;color:#222"><nav style="padding:20px;border-bottom:1px solid #ddd"><strong>Hindsight</strong>　<a href="/">记忆库</a>　<a href="/operations">操作</a></nav><main style="padding:24px"><h1>${req.url === '/operations' ? '操作记录' : '原生记忆库'}</h1><p>这是用于导航和登录验证的控制台替身。</p></main></body></html>`);
    });
    native.listen(0, '127.0.0.1'); await once(native, 'listening');
    manager.consoleAddress = `http://localhost:${native.address().port}`;
    manager.fetch = fetch;
    manager.accessKey = async () => 'wrong';
  }
  const output = await build({ entryPoints: ['tests/fixtures/preview.jsx'], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'text' },
    alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve('tests/fixtures/button.jsx') } });
  const handler = apiHandler(manager);
  const proxy = consoleProxy(manager, (req, res) => {
    if (req.headers.cookie?.includes('dsh-preview=paired')) return true;
    res.writeHead(401).end(); return false;
  });
  server = createServer((req, res) => {
    if (req.url === ENDPOINT) return void handler(req, res);
    if (req.url.startsWith(CONSOLE_PATH)) return void proxy(req, res);
    if (req.url === '/preview.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(output.outputFiles[0].contents); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hindsight 插件验收</title><body style="margin:0;padding:24px;background:#181818;color:#f2f2f2;--dsw-alias-border-l2:#484848;--dsw-alias-label-secondary:#b7b7b7;--dsw-alias-label-primary:#f2f2f2;--dsw-alias-bg-layer-1:#222;--dsw-alias-state-active-primary:#88aaff;--dsw-alias-state-error-primary:#ff8989;--dsw-alias-state-success-primary:#8cdbb5"><div id="app"></div><script src="/preview.js"></script></body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await (safari ? webkit : chromium).launch({ headless: true });
  page = await browser.newPage({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1200 }, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'dark', isMobile: phone, hasTouch: phone, ignoreHTTPSErrors: phone });
  const backend = `http://127.0.0.1:${server.address().port}`;
  let address = backend;
  if (phone) {
    const key = join(root, 'phone-test.key'), cert = join(root, 'phone-test.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    phoneServer = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
      try {
        if (!req.headers.cookie?.includes('phone-paired=yes')) return res.writeHead(401).end('尚未配对');
        if (req.headers.origin && req.headers.origin !== address) return res.writeHead(403).end();
        const headers = { ...req.headers, host: new URL(backend).host, cookie: 'dsh-preview=paired' };
        if (headers.origin) headers.origin = backend;
        for (const key of ['x-forwarded-host', 'x-forwarded-proto', 'content-length', 'connection', 'transfer-encoding']) delete headers[key];
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const reply = await fetch(backend + req.url, { method: req.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        const responseHeaders = Object.fromEntries(reply.headers);
        for (const key of ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete responseHeaders[key];
        const body = Buffer.from(await reply.arrayBuffer()); res.writeHead(reply.status, responseHeaders).end(body);
      } catch { res.writeHead(502).end('测试转发失败'); }
    });
    phoneServer.listen(0, '127.0.0.1'); await once(phoneServer, 'listening');
    address = `https://localhost:${phoneServer.address().port}`;
    await page.context().addCookies([{ url: address, name: 'phone-paired', value: 'yes', httpOnly: true, secure: true }]);
    const nativePort = new URL(manager.consoleAddress || manager.settings.consoleUrl).port;
    await page.route(url => ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === nativePort, route => route.abort('connectionrefused'));
  } else await page.context().addCookies([{ url: backend, name: 'dsh-preview', value: 'paired', httpOnly: true }]);
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', input => failed.push({ path: new URL(input.url()).pathname, cause: input.failure()?.errorText }));
  page.on('response', reply => { if (reply.request().resourceType() === 'script' && reply.headers()['content-type']?.includes('text/html')) badScripts.push(new URL(reply.url()).pathname); });
  page.on('request', input => { if (new URL(input.url()).pathname.includes(CONSOLE_PATH + '/banks/')) flights.push({ phase: 'request', rsc: input.headers().rsc, type: input.resourceType() }); });
  page.on('response', reply => { if (new URL(reply.url()).pathname.includes(CONSOLE_PATH + '/banks/')) flights.push({ phase: 'response', status: reply.status(), type: reply.headers()['content-type'] }); });
  await page.goto(address);
  assert.equal(await page.locator('iframe').count(), 0);
  await page.getByRole('button', { name: 'Hindsight', exact: true }).click();
  await mkdir('artifacts', { recursive: true });
  if (!real) {
    await page.getByRole('alert').filter({ hasText: '自动登录失败' }).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await page.screenshot({ path: 'artifacts/console-error.png', fullPage: true });
    manager.accessKey = async () => 'test-access-key';
    await page.getByRole('button', { name: '重试连接' }).click();
  }
  const frame = page.frameLocator('iframe[title="Hindsight 原生控制台"]');
  await frame.locator('body').waitFor();
  if (real) {
    await frame.getByRole('heading', { name: '记忆库', exact: true }).waitFor();
    await frame.getByRole('row').nth(1).waitFor();
    await frame.locator('a[href*="/banks/"]').first().click();
    const nativeFrame = page.frames().find(frame => frame.parentFrame());
    await nativeFrame.waitForURL(url => url.pathname.includes(CONSOLE_PATH + '/banks/'), { timeout: 5000 });
    await frame.locator('h1').waitFor();
    await page.screenshot({ path: `artifacts/console-bank${phone ? '-phone' : ''}${safari ? '-webkit' : ''}.png`, fullPage: true });
    await page.getByRole('button', { name: '重新载入', exact: true }).click();
    await frame.getByRole('heading', { name: '记忆库', exact: true }).waitFor();
    await frame.getByRole('row').nth(1).waitFor();
  }
  else await frame.getByRole('heading', { name: '原生记忆库' }).waitFor();
  const frameUrl = await page.locator('iframe').getAttribute('src');
  assert.equal(new URL(frameUrl, address).origin, new URL(address).origin);
  assert.equal(new URL(frameUrl, address).pathname, CONSOLE_PATH + '/');
  assert.equal(new URL(frameUrl, address).search, '');
  assert.equal(await frame.locator('input[type="password"]').count(), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '登录控制台', exact: true }).count(), 0);
  assert.equal(await page.getByRole('list', { name: '记忆库列表' }).count(), 0);
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === 'hindsight_cp_access');
  assert.equal(cookie, undefined);
  assert.equal(await frame.locator('body').evaluate(() => document.cookie.includes('hindsight_cp_access=')), false);
  if (!real) {
    await frame.getByRole('link', { name: '操作', exact: true }).click();
    await frame.getByRole('heading', { name: '操作记录' }).waitFor();
  }
  await page.getByLabel('默认模型', { exact: true }).selectOption(models[0]);
  await page.getByRole('button', { name: '保存默认模型并生成环境文件' }).click();
  await page.getByRole('status').filter({ hasText: '环境文件已生成' }).waitFor();
  if (!real) await frame.getByRole('heading', { name: '操作记录' }).waitFor();
  await page.getByRole('button', { name: '刷新模型' }).click();
  if (!real) await frame.getByRole('heading', { name: '操作记录' }).waitFor();
  const prefix = (real ? 'console-native' : 'console-embedded') + (phone ? '-phone' : '') + (safari ? '-webkit' : '');
  await page.screenshot({ path: `artifacts/${prefix}.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `artifacts/${prefix}-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.reload();
  await page.getByRole('button', { name: 'Hindsight', exact: true }).click();
  await page.frameLocator('iframe[title="Hindsight 原生控制台"]').getByRole('heading', { name: real ? '记忆库' : '原生记忆库', exact: true }).waitFor();
  assert.equal(await page.frameLocator('iframe').locator('input[type="password"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`页面验收通过：设置入口注册及打开、${real ? '真实原生控制台免密嵌入' : '自动登录失败及重试、原生导航'}、模型保存、模型刷新、原生 Cookie 仅存后台、页面刷新保持登录、窄屏无横向溢出${phone ? '、手机 HTTPS 代理及禁止直连宿主端口' : ''}。`);
  console.log(`截图：artifacts/${prefix}.png、${prefix}-mobile.png。设置容器、模型目录和 DSH 按钮使用测试替身；未修改真实 Hindsight 数据或调用模型。`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'artifacts/console-check-failure.png', fullPage: true });
    const child = page.frames().find(frame => frame.parentFrame());
    console.log(JSON.stringify({ alerts: await page.getByRole('alert').allTextContents(), frameUrl: child?.url(), headings: child ? await child.locator('h1,h2').allTextContents() : [], passwordFields: child ? await child.locator('input[type="password"]').count() : 0, failed, badScripts, flights: flights.slice(0,12), flightCount: flights.length }));
  }
  throw error;
} finally {
  await browser?.close();
  for (const service of [phoneServer, server, native]) if (service) await new Promise(resolve => { service.close(resolve); service.closeAllConnections(); });
  for (const action of cleanup.reverse()) await action();
}
