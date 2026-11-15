import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleAccessKey } from '../src/console-auth.mjs';

test('显式环境凭据优先，不调用 Docker', async () => {
  assert.equal(await consoleAccessKey('http://localhost:9999', { env: { HINDSIGHT_CP_ACCESS_KEY: 'explicit' }, run: () => { throw new Error('不应调用 Docker'); } }), 'explicit');
});

test('Docker 只读取精确匹配发布端口的容器，忽略同容器端口的其他实例', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'ps') return { stdout: 'a1\nb2\n' };
    return { stdout: [
      { ports: { '9999/tcp': [{ HostIp: '127.0.0.1', HostPort: '9998' }] }, env: ['HINDSIGHT_CP_ACCESS_KEY=other'] },
      { ports: { '9999/tcp': [{ HostIp: '127.0.0.1', HostPort: '9999' }] }, env: ['HINDSIGHT_CP_ACCESS_KEY=correct=key'] },
    ].map(value => JSON.stringify(value)).join('\n') };
  };
  assert.equal(await consoleAccessKey('http://localhost:9999', { env: {}, run }), 'correct=key');
  assert.equal(calls[0].command, 'docker');
  assert.ok(calls[0].args.includes('publish=9999'));
  assert.deepEqual(calls[1].args.slice(-2), ['a1', 'b2']);
});

test('Docker 不可用或容器有歧义时给出配置提示，不暴露命令异常中的凭据', async () => {
  const run = async () => { throw new Error('private-key-from-command'); };
  await assert.rejects(consoleAccessKey('http://localhost:9999', { env: {}, run }), error => error.status === 503 && !error.message.includes('private-key-from-command'));
  await assert.rejects(consoleAccessKey('https://remote.example', { env: {}, run }), { status: 400 });
  const container = JSON.stringify({ ports: { '9999/tcp': [{ HostIp: '127.0.0.1', HostPort: '9999' }] }, env: ['HINDSIGHT_CP_ACCESS_KEY=secret'] });
  const ambiguous = async (_, args) => ({ stdout: args[0] === 'ps' ? 'a1\nb2' : `${container}\n${container}` });
  await assert.rejects(consoleAccessKey('http://localhost:9999', { env: {}, run: ambiguous }), { status: 503 });
});
