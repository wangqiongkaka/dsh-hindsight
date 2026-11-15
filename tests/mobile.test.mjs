import test from 'node:test';
import assert from 'node:assert/strict';
import { apiHandler } from '../src/api.mjs';
import { fixture, listen } from './helpers.mjs';

test('手机通过 DSH 代理打开控制台时，iframe 地址必须是同源路径，不能指向手机回环地址', async t => {
  const { manager } = await fixture(t);
  const url = await listen(t, apiHandler(manager));
  const { key } = await (await fetch(url)).json();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hindsight-key': key }, body: JSON.stringify({ type: 'console.open' }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.url, /^\/\.well-known\/dsh-hindsight\/console\//, '手机收到回环地址会访问手机自身，导致 iframe 整块空白');
});
