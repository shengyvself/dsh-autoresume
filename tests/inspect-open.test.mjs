// dsh-autoresume：0.1.5 会话读取契约回归（2026-09-13）
// 背景：0.1.5 的 SessionPersistence 移除了 inspect()，公开面为 create/open/flush/stat/list。
// 旧 4 处 inspect() 调用在生产上每次都抛（catch 只走 logger.warn，不进 journal）→
// 重启后自动继续**静默失效**（用户实报「自动继续没有在这里生效」）。
// 本测试：① 源码不得再出现已移除的 API；② 早期路径必须经 open(id,'read') 读事件并 resume。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply } from '../src/service.js';

const SOURCE = readFileSync(new URL('../src/service.js', import.meta.url), 'utf8');

test('源码不再调用 0.1.5 已移除的 sessionPersistence.inspect()，改用 open()', () => {
  // 只看真实调用（await 前缀），避免命中解释性注释。
  assert.ok(!/await\s+ctx\.sessionPersistence\.inspect\(/.test(SOURCE), '仍存在 sessionPersistence.inspect( 调用');
  assert.ok(/sessionPersistence\.open\(/.test(SOURCE), '缺少 sessionPersistence.open( 调用');
});

test('setup 回调签名须为 (agentCtx, agent)（0.1.5 AgentSetup）', () => {
  assert.ok(/setup = async \(agentCtx, agent\)/.test(SOURCE), 'setup 回调未声明 (agentCtx, agent)');
  assert.ok(/installSessionSelection\(agent, agentCtx\)/.test(SOURCE), '未按 0.1.5 签名把 agent 传给 installSessionSelection');
  assert.ok(!/installSessionSelection\(agentCtx\)/.test(SOURCE), '仍存在 0.1.2 旧签名 installSessionSelection(agentCtx)');
  assert.ok(!/const agent = agentCtx\.agent/.test(SOURCE), '仍从 agentCtx.agent 取 agent（0.1.5 已改为第二参数）');
});

function mockCtx(events) {
  const opened = [];
  const resumed = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    get() { return undefined; },
    on() { return () => {}; },
    // cordis 的 effect 回调返回 disposer；apply 自身不返回，故测试须自行收集并在结束时释放，
    // 否则 1h 的 setInterval 会让测试进程永不退出（2026-09-13 实测：node --test 挂死）。
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
    agents: {
      get() { return undefined; },
      async resume(options) { resumed.push(options?.resumeSessionId); return {}; }
    },
    sessionPersistence: {
      async open(id, access) {
        opened.push([id, access]);
        return {
          header: { id, agentPreset: 'narrative-iterate' },
          async read() { return { events }; },
          async close() { opened.push(['closed', id]); }
        };
      }
    }
  };
  return { ctx, opened, resumed, disposers };
}

test('早期路径：open(id,\'read\') 读事件 → 判定 interrupted → 自行 resume（重启后自动继续的根路径）', async () => {
  // 单目标模式（targetSessionId）避免扫描真实 ~/.dsh/sessions，保证确定性。
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }];
  const { ctx, opened, resumed, disposers } = mockCtx(events);
  apply(ctx, { targetSessionId: 'session-test-open', initialDelayMs: 1, pollIntervalMs: 3600000 });
  await new Promise((r) => setTimeout(r, 80));
  for (const d of disposers) { try { d(); } catch { /* noop */ } }
  assert.deepEqual(opened.filter(([a]) => a !== 'closed'), [['session-test-open', 'read']], '未用 read 权限打开目标会话');
  assert.ok(opened.some(([a]) => a === 'closed'), '句柄未关闭');
  assert.deepEqual(resumed, ['session-test-open'], '被打断的会话未被 resume');
});

test('早期路径：会话不存在（open 抛错）不崩、不 resume', async () => {
  const mock = mockCtx([]);
  const ctx = mock.ctx;
  ctx.sessionPersistence.open = async () => { throw new Error('SessionPersistenceNotFoundError'); };
  const resumed = [];
  ctx.agents.resume = async (o) => { resumed.push(o?.resumeSessionId); };
  apply(ctx, { targetSessionId: 'session-missing', initialDelayMs: 1, pollIntervalMs: 3600000 });
  await new Promise((r) => setTimeout(r, 80));
  for (const d of mock.disposers) { try { d(); } catch { /* noop */ } }
  assert.deepEqual(resumed, [], '会话不存在时不应 resume');
});
