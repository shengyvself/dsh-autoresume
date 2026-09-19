// dsh-autoresume 队列守卫 + 会话代际 回归测试（2026-09-13，DSH 0.1.5-rc.2 适配）
// 运行：node tests/pending-input.test.mjs   （零依赖，纯函数级）
import assert from 'node:assert/strict';
import {
  analyzeSessionEvents,
  applyInboxSplice,
  foldPendingInbox,
  pickSessionLog,
  buildContinueMessage,
  apply,
  name as moduleName,
  inject
} from '../src/service.js';

let pass = 0; const fails = [];
function t(name, fn) { try { fn(); pass += 1; } catch (e) { fails.push(name + ' :: ' + e.message); } }

const CONTINUE = '继续未完成的任务';
const ours = () => buildContinueMessage(CONTINUE);
const userMsg = (text) => ({ id: 'u-' + text, role: 'user', content: [{ type: 'text', text }] });
function ev(type, seq, data) { return { type, seq, data }; }
function turnStart(seq) { return ev('turn/start', seq, { turn: 1 }); }
function turnEndError(seq, code = 'RATE_LIMIT', message = '429 too many requests') {
  return ev('turn/end', seq, { turn: 1, reason: { kind: 'error', error: { code, message } } });
}
function turnEndCompleted(seq) { return ev('turn/end', seq, { turn: 1, reason: { kind: 'completed' } }); }
function inboxInsert(seq, target, messages) { return ev('agent/inbox/spliced', seq, { target, start: 0, removedCount: 0, inserted: messages }); }
function inboxClaim(seq, target, count) { return ev('agent/inbox/spliced', seq, { target, start: 0, removedCount: count, inserted: [] }); }

// ── A. 会话日志代际（0.1.5-rc.2: v3）──────────────────────────────
t('A1 只有旧代际文件 → 选旧名', () => assert.equal(pickSessionLog(['session.jsonl.zstd']), 'session.jsonl.zstd'));
t('A2 v3 与旧代际同存 → 取 v3（当前代际）', () => assert.equal(pickSessionLog(['session.jsonl.zstd', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd'));
t('A3 只有 v3 → 选 v3', () => assert.equal(pickSessionLog(['session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd'));
t('A4 无日志文件 → undefined', () => assert.equal(pickSessionLog(['notes.txt']), undefined));
t('A5 非规范名不认（v03）', () => assert.equal(pickSessionLog(['session.v03.jsonl.zstd']), undefined));
t('A6 明文 v3 也认', () => assert.equal(pickSessionLog(['session.v3.jsonl']), 'session.v3.jsonl'));

// ── B. inbox 折叠 ────────────────────────────────────────────────
t('B1 append 累加', () => {
  const s = foldPendingInbox([inboxInsert(1, 'next-turn', [userMsg('a'), userMsg('b')])]);
  assert.equal(s['next-turn'].length, 2); assert.equal(s['next-step'].length, 0);
});
t('B2 claim 后清空', () => {
  const s = foldPendingInbox([inboxInsert(1, 'next-turn', [userMsg('a')]), inboxClaim(2, 'next-turn', 1)]);
  assert.equal(s['next-turn'].length, 0);
});
t('B3 两目标互不干扰', () => {
  const s = foldPendingInbox([inboxInsert(1, 'next-step', [userMsg('steer')])]);
  assert.equal(s['next-step'].length, 1); assert.equal(s['next-turn'].length, 0);
});
t('B4 applyInboxSplice 非法 target 不炸', () => {
  const s = foldPendingInbox([ev('agent/inbox/spliced', 1, { target: 'bogus', start: 0, inserted: [] })]);
  assert.deepEqual(s, { 'next-turn': [], 'next-step': [] });
});

// ── C. 队列守卫（本轮 bug 修复核心）──────────────────────────────
const netThen = (extra = []) => [turnStart(1), turnEndError(2), ...extra];

t('C1 网络错误 + 用户挂起消息 → pending-input（不注入）', () => {
  const r = analyzeSessionEvents(netThen([inboxInsert(3, 'next-turn', [userMsg('我要说的事')])]), CONTINUE, 2);
  assert.equal(r.state, 'pending-input'); assert.equal(r.pendingInput.others, 1);
});
t('C2 网络错误 + 无挂起 → network-stopped（回归：仍注入）', () => {
  const r = analyzeSessionEvents(netThen(), CONTINUE, 2);
  assert.equal(r.state, 'network-stopped');
});
t('C3 我们自己的「继续」还挂着 → completed（不重复注入）', () => {
  const r = analyzeSessionEvents(netThen([inboxInsert(3, 'next-turn', [ours()])]), CONTINUE, 2);
  assert.equal(r.state, 'completed'); assert.equal(r.pendingInput.own, 1); assert.equal(r.pendingInput.others, 0);
});
t('C4 挂起消息被认领后 → 回到 network-stopped', () => {
  const r = analyzeSessionEvents(netThen([inboxInsert(3, 'next-turn', [userMsg('m')]), inboxClaim(4, 'next-turn', 1)]), CONTINUE, 2);
  assert.equal(r.state, 'network-stopped');
});
t('C5 open turn（被打断）+ 用户挂起 → pending-input 优先', () => {
  const r = analyzeSessionEvents([turnStart(1), inboxInsert(2, 'next-turn', [userMsg('m')])], CONTINUE, 2);
  assert.equal(r.state, 'pending-input');
});
t('C6 next-step（steer）挂起同样拦', () => {
  const r = analyzeSessionEvents(netThen([inboxInsert(3, 'next-step', [userMsg('steer')])]), CONTINUE, 2);
  assert.equal(r.state, 'pending-input'); assert.equal(r.pendingInput.nextStep, 1);
});
t('C7 关掉守卫（skipWhenInputPending:false）→ 旧行为 network-stopped', () => {
  const r = analyzeSessionEvents(netThen([inboxInsert(3, 'next-turn', [userMsg('m')])]), CONTINUE, 2, { skipWhenInputPending: false });
  assert.equal(r.state, 'network-stopped');
});
t('C8 挂起项是别人的多条时计数正确', () => {
  const r = analyzeSessionEvents(netThen([inboxInsert(3, 'next-turn', [userMsg('a'), ours(), userMsg('b')])]), CONTINUE, 2);
  assert.equal(r.pendingInput.others, 2); assert.equal(r.pendingInput.own, 1); assert.equal(r.state, 'pending-input');
});

// ── D. 既有语义回归 ─────────────────────────────────────────────
t('D1 assistant/message 结尾 → completed', () => {
  assert.equal(analyzeSessionEvents([turnStart(1), turnEndCompleted(2), ev('assistant/message', 3, {})], CONTINUE, 2).state, 'completed');
});
t('D2 空事件流 → empty', () => assert.equal(analyzeSessionEvents([], CONTINUE, 2).state, 'empty'));
t('D3 余额类注入后再失败 → settled（防无限循环）', () => {
  const events = [turnStart(1), turnEndError(2, 'QUOTA', '402 Insufficient balance'), inboxInsert(3, 'next-turn', [ours()]), inboxClaim(4, 'next-turn', 1),
    ev('user/message', 5, ours()), turnStart(6), turnEndError(7, 'QUOTA', '402 Insufficient balance')];
  assert.equal(analyzeSessionEvents(events, CONTINUE, 2).state, 'settled');
});
t('D4 网络失败 failStreak 达上限 → settled', () => {
  const events = [turnStart(1), turnEndError(2), ev('user/message', 3, ours()), turnStart(4), turnEndError(5),
    ev('user/message', 6, ours()), turnStart(7), turnEndError(8)];
  assert.equal(analyzeSessionEvents(events, CONTINUE, 2).state, 'settled');
});
t('D5 注入后零进展被再次打断 → settled（重启循环守卫）', () => {
  const events = [turnStart(1), ev('user/message', 2, ours()), turnStart(3)];
  assert.equal(analyzeSessionEvents(events, CONTINUE, 2).state, 'settled');
});
t('D6 永久错误码（CONTEXT_WINDOW_EXCEEDED）→ settled', () => {
  assert.equal(analyzeSessionEvents([turnStart(1), turnEndError(2, 'CONTEXT_WINDOW_EXCEEDED', '400 status code (no body)')], CONTINUE, 2).state, 'settled');
});

// ── E. 模块面与 mock-apply 冒烟（上线前门禁）────────────────────
t('E1 模块面：name/inject', () => {
  assert.equal(moduleName, 'dsh-autoresume');
  assert.deepEqual(inject, ['agents', 'sessions', 'sessionPersistence']);
});
t('E2 mock-apply：用假 ctx 调 apply 不抛、能拿到 disposer', () => {
  let disposer; const warns = [];
  const ctx = {
    logger: { info() {}, warn(m) { warns.push(String(m)); } },
    get() { return undefined; },
    on() { return () => {}; },
    effect(fn) { disposer = fn(); return () => {}; }
  };
  apply(ctx, { scanMode: true, targetSessionId: '', initialDelayMs: 3600000, pollIntervalMs: 3600000 });
  assert.equal(typeof disposer, 'function');
  disposer();
  assert.equal(warns.length, 0);
});
t('E3 注入消息形状（source.kind=plugin 且带 plugin 名）', () => {
  const m = buildContinueMessage(CONTINUE);
  assert.equal(m.role, 'user');
  assert.equal(m.source.kind, 'plugin'); assert.equal(m.source.plugin, 'dsh-autoresume');
  assert.equal(m.content[0].text, CONTINUE);
});

if (fails.length > 0) {
  console.error('FAIL ' + fails.length + '/' + (pass + fails.length));
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + '/' + pass);
