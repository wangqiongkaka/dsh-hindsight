import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, models } from './helpers.mjs';
import { consoleUrl } from '../src/service.mjs';
import { CONSOLE_PATH } from '../src/api-path.mjs';

test('免密登录复用原生会话，模型状态与磁盘不回显控制台凭据', async t => {
  const { manager, root } = await fixture(t);
  const result = await manager.openConsole();
  assert.deepEqual(result, { url: `${CONSOLE_PATH}/` });
  assert.equal(manager.consoleSession.cookie, 'hindsight_cp_access=test-session');
  const disk = await readFile(join(root, 'settings.json'), 'utf8');
  const state = JSON.stringify(await manager.state());
  for (const secret of ['test-access-key', 'test-session']) { assert.ok(!disk.includes(secret)); assert.ok(!state.includes(secret)); }
  assert.ok(!state.includes(manager.settings.token));
  assert.equal((await manager.state()).loggedIn, undefined);
});

test('未启用认证时不读取凭据，后台保留部署路径，手机只获得同源入口', async t => {
  const { manager, upstream } = await fixture(t); upstream.auth = false;
  manager.consoleAddress = 'http://localhost:9999/hindsight';
  manager.accessKey = async () => { throw new Error('不应读取凭据'); };
  assert.deepEqual(await manager.openConsole(), { url: `${CONSOLE_PATH}/` });
  assert.deepEqual(manager.consoleSession, { url: 'http://localhost:9999/hindsight', cookie: '' });
  assert.equal(upstream.calls.length, 1);
  for (const url of ['http://example.test', 'https://u:p@example.test', 'file:///tmp/test', 'https://example.test/?token=x']) assert.throws(() => consoleUrl(url), { status: 400 });
});

test('无效凭据和非本地上游明确失败，手机的 HTTPS 与本地 HTTP 可以经同源代理连接', async t => {
  const { manager, upstream } = await fixture(t);
  manager.accessKey = async () => 'wrong';
  await assert.rejects(manager.openConsole(), { status: 401 });
  assert.equal(upstream.auth, true);
  manager.consoleAddress = 'https://remote.example';
  await assert.rejects(manager.openConsole(), { status: 400 });
  manager.consoleAddress = 'http://localhost:9999'; manager.accessKey = async () => 'test-access-key';
  assert.deepEqual(await manager.action({ type: 'console.open' }), { url: `${CONSOLE_PATH}/` });
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

test('自建登录、退出与记忆库列表接口已经移除', async t => {
  const { manager, upstream } = await fixture(t);
  for (const type of ['login', 'logout', 'banks', 'bank.save']) await assert.rejects(manager.action({ type }), { status: 400 });
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
