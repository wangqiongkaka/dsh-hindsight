import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, models } from './helpers.mjs';
import { consoleUrl } from '../src/service.mjs';

test('登录校验密钥，后台保留会话，前端与磁盘均不回显控制台密钥', async t => {
  const { manager, root } = await fixture(t);
  await assert.rejects(manager.login('http://localhost:9999', 'wrong'), { status: 401 });
  assert.equal(manager.session, null);
  await manager.login('http://localhost:9999', 'test-access-key');
  assert.equal((await manager.state()).loggedIn, true);
  assert.equal((await manager.banks()).banks.length, 2);
  const disk = await readFile(join(root, 'settings.json'), 'utf8');
  const state = JSON.stringify(await manager.state());
  for (const secret of ['test-access-key', 'test-session']) { assert.ok(!disk.includes(secret)); assert.ok(!state.includes(secret)); }
  assert.ok(!state.includes(manager.settings.token));
  await manager.action({ type: 'logout' });
  await assert.rejects(manager.banks(), { status: 401 });
});

test('未启用认证时可以空密钥连接，控制台支持带 basePath 的地址', async t => {
  const { manager, upstream } = await fixture(t); upstream.auth = false;
  await manager.login('https://example.test/hindsight/', '');
  assert.equal((await manager.banks()).banks.length, 2);
  assert.ok(upstream.calls.some(call => call.url.startsWith('https://example.test/hindsight/api/banks')));
  for (const url of ['http://example.test', 'https://u:p@example.test', 'file:///tmp/test', 'https://example.test/?token=x']) assert.throws(() => consoleUrl(url), { status: 400 });
});

test('只在控制台会话过期时退出，不把后端 API 认证失败当成会话过期', async t => {
  const { manager, upstream } = await fixture(t);
  await manager.login('http://localhost:9999', 'test-access-key');
  upstream.dataAuthError = true;
  await assert.rejects(manager.banks(), { status: 401 }); assert.ok(manager.session);
  upstream.dataAuthError = false; upstream.expired = true;
  await assert.rejects(manager.banks(), { status: 401 }); assert.equal(manager.session, null);
});

test('记忆库列表完整分页，不返回上游额外字段', async t => {
  const { manager, upstream } = await fixture(t);
  await manager.login('http://localhost:9999', 'test-access-key');
  upstream.bankCount = 205;
  assert.equal((await manager.banks()).banks.length, 205);
  assert.deepEqual(Object.keys((await manager.banks()).banks[0]), ['id', 'name']);
});

test('全局配置生成私有文件，保留令牌，模型删除时拒绝保存', async t => {
  const { manager, root } = await fixture(t);
  await manager.globalModel(models[0]);
  const file = join(root, 'hindsight.env'), env = await readFile(file, 'utf8');
  assert.ok(env.includes('HINDSIGHT_API_LLM_MODEL=dsh-default'));
  assert.ok(env.includes(manager.settings.token));
  assert.ok(!env.includes('ENABLE_BANK_CONFIG_API'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'settings.json'))).mode & 0o777, 0o600);
  await manager.globalModel(models[1]);
  assert.equal(await readFile(file, 'utf8'), env);
  await assert.rejects(manager.globalModel('removed'), { status: 400 });
  assert.equal(manager.settings.defaultModel, models[1]);
});

test('记忆库保持只读，拒绝已取消的 Bank 写入操作', async t => {
  const { manager, upstream } = await fixture(t);
  await assert.rejects(manager.action({ type: 'bank.save', bankId: 'bank-0', model: models[1] }), { status: 400 });
  assert.equal(upstream.calls.length, 0);
});

test('损坏的持久配置不被静默覆盖', async t => {
  const { manager, root } = await fixture(t);
  for (const content of ['{broken', 'null', '0', '[]', '{}']) {
    await writeFile(join(root, 'settings.json'), content);
    await assert.rejects(manager.init(), /配置.*失败|配置格式无效/);
    assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), content);
  }
});
