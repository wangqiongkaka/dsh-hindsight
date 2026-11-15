import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { fixture, models } from '../tests/helpers.mjs';
import { apiHandler, ENDPOINT } from '../src/api.mjs';

const cleanup = [], errors = [], t = { after: action => cleanup.push(action) };
let browser, server;
try {
  const { manager } = await fixture(t);
  const output = await build({ entryPoints: ['tests/fixtures/preview.jsx'], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'text' },
    alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve('tests/fixtures/button.jsx') } });
  const handler = apiHandler(manager);
  server = createServer((req, res) => {
    if (req.url === ENDPOINT) return void handler(req, res);
    if (req.url === '/preview.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(output.outputFiles[0].contents); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hindsight 插件验收</title><body style="margin:0;background:#f7f8fa"><div id="app"></div><script src="/preview.js"></script></body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 1100 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '登录控制台', exact: true }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/01-login.png', fullPage: true });
  await page.getByLabel('访问密钥').fill('wrong');
  await page.getByRole('button', { name: '登录控制台', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '访问密钥不正确' }).waitFor();
  await page.getByLabel('访问密钥').fill('test-access-key');
  await page.getByRole('button', { name: '登录控制台', exact: true }).click();
  await page.getByText('控制台登录成功', { exact: true }).waitFor();
  await page.locator('#hm-global').selectOption(models[0]);
  await page.getByRole('button', { name: '保存默认模型并生成环境文件' }).click();
  await page.getByRole('status').filter({ hasText: '环境文件已生成' }).waitFor();
  await page.getByRole('list', { name: '记忆库列表' }).waitFor();
  assert.equal(await page.getByRole('list', { name: '记忆库列表' }).getByRole('listitem').count(), 2);
  assert.equal(await page.getByRole('button', { name: '保存记忆库模型' }).count(), 0);
  await page.getByRole('button', { name: '刷新列表' }).click();
  await page.getByRole('status').filter({ hasText: '记忆库列表已刷新' }).waitFor();
  await page.screenshot({ path: 'artifacts/02-connected.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/03-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: '登录控制台', exact: true }).waitFor();
  assert.equal(await page.getByLabel('访问密钥').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('页面验收通过：错误密钥、登录、全局保存、只读记忆库列表、退出、窄屏无横向溢出。');
  console.log('截图：artifacts/01-login.png、02-connected.png、03-mobile.png。使用真实页面与后台，DSH 按钮和上游数据为测试替身。');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  for (const action of cleanup.reverse()) await action();
}
