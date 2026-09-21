// dsh-autoresume 分类回归（2026-09-21，DSH 0.1.6-alpha.2）
// 缺陷 A：工具调用被中断于「记录为开始」之前时，自动继续完全不生效。
//   宿主补写 ToolNotStartedError 的 tool/result（"The tool call was interrupted before the
//   Harness recorded it as started. Retry it if it is still needed."）——上一条 assistant/message
//   是**未执行**的工具请求，轮次并未结束；旧代码见 lastType==='assistant/message' 一律判 completed。
// 缺陷 B：用户手动停止会触发自动继续（用户明示「绝对的 bug」）。
//   aborted 是驱动主动收尾（边界闭合），与「环境杀死进程」（turn/end 缺失）本质不同；
//   旧代码见 open step / 悬挂 tool/call 一律判 interrupted 并注入「继续」，等于推翻用户指令。
// 运行：node --test tests/manual-stop.test.mjs（零依赖，纯函数级）
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSessionEvents } from '../src/service.js';

const CONTINUE = '继续未完成的任务';
const analyze = (events) => analyzeSessionEvents(events, CONTINUE, 2, {});

const ev = (type, seq, data) => ({ type, seq, data });
const turnStart = (seq) => ev('turn/start', seq, { turn: 1 });
const stepStart = (seq) => ev('step/start', seq, { step: 1 });
const stepEnd = (seq) => ev('step/end', seq, { step: 1 });
const toolCall = (seq, callId) => ev('tool/call', seq, { callId, tool: 'bash' });
const toolResult = (seq, callId) => ev('tool/result', seq, { message: { source: { kind: 'tool', callId }, content: [] } });
const endAborted = (seq, cause) => ev('turn/end', seq, { turn: 1, reason: { kind: 'aborted', reason: { kind: cause } } });
const endInterrupted = (seq) => ev('turn/end', seq, { turn: 1, reason: { kind: 'interrupted' } });
const endCompleted = (seq) => ev('turn/end', seq, { turn: 1, reason: { kind: 'completed' } });
const endError = (seq, code = 'RATE_LIMIT', message = '429 too many requests') =>
  ev('turn/end', seq, { turn: 1, reason: { kind: 'error', error: { code, message } } });
const assistant = (seq, blocks) => ev('assistant/message', seq, { message: { content: blocks } });
const tc = (id) => ({ type: 'tool-call', id, callId: id, tool: 'bash' });
const text = (s) => ({ type: 'text', text: s });
const reasoning = (s) => ({ type: 'reasoning', text: s });
const userMsg = (seq) => ev('user/message', seq, { role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } });

// ── A. 缺陷 A：工具请求不是终结回复，自动继续必须生效 ─────────────────
test('A1 末事件是含 tool-call 的 assistant/message + 轮次仍打开 → interrupted（可继续）', () => {
  const r = analyze([turnStart(1), stepStart(2), assistant(3, [reasoning('准备调工具'), tc('c1')])]);
  assert.equal(r.state, 'interrupted');
  assert.match(r.reason, /open turn/);
});

test('A1b 同形态但 step 已闭合、轮次仍打开 → interrupted', () => {
  const r = analyze([turnStart(1), stepStart(2), stepEnd(3), assistant(4, [tc('c1')])]);
  assert.equal(r.state, 'interrupted');
  assert.match(r.reason, /open turn/);
});

test('A2 对照：不含 tool-call 的 assistant/message（终结回复）+ 轮次仍打开 → completed（旧行为保留）', () => {
  const r = analyze([turnStart(1), stepStart(2), assistant(3, [text('答完了')])]);
  assert.equal(r.state, 'completed');
  assert.match(r.reason, /assistant\/message/);
});

test('A3 宿主已补 ToolNotStartedError 的 tool/result + turn/end interrupted → interrupted', () => {
  const r = analyze([
    turnStart(1), stepStart(2), assistant(3, [tc('c1')]),
    toolResult(4, 'c1'), stepEnd(5), endInterrupted(6)
  ]);
  assert.equal(r.state, 'interrupted');
  assert.match(r.reason, /interrupted/);
});

// ── B. 缺陷 B：用户手动停止是终态，绝不自动继续 ─────────────────────
test('B1 turn/end aborted/user、无悬挂边界 → settled', () => {
  const r = analyze([turnStart(1), stepStart(2), stepEnd(3), endAborted(4, 'user')]);
  assert.equal(r.state, 'settled');
  assert.match(r.reason, /explicit abort \(user\)/);
});

test('B2 核心回归：aborted/user + 悬挂 tool/call + step 未闭合 → settled（旧代码会判 interrupted 并注入）', () => {
  const r = analyze([turnStart(1), stepStart(2), assistant(3, [tc('c1')]), toolCall(4, 'c1'), endAborted(5, 'user')]);
  assert.equal(r.state, 'settled');
  assert.match(r.reason, /explicit abort \(user\)/);
});

test('B3 对照：aborted/user 之后又起新轮次并被环境杀死（open turn）→ interrupted（真实中断仍继续）', () => {
  const r = analyze([turnStart(1), stepStart(2), stepEnd(3), endAborted(4, 'user'), turnStart(5), stepStart(6)]);
  assert.equal(r.state, 'interrupted');
  assert.match(r.reason, /open turn/);
});

test('B4 turn/end aborted/disposed（生命周期拆除）→ settled', () => {
  const r = analyze([turnStart(1), stepStart(2), stepEnd(3), endAborted(4, 'disposed')]);
  assert.equal(r.state, 'settled');
  assert.match(r.reason, /explicit abort \(disposed\)/);
});

test('B5 aborted/user + 悬挂 tool/call + 其后一条用户消息 → settled（不推翻用户停止）', () => {
  const r = analyze([
    turnStart(1), stepStart(2), assistant(3, [tc('c1')]), toolCall(4, 'c1'),
    endAborted(5, 'user'), userMsg(6)
  ]);
  assert.equal(r.state, 'settled');
  assert.match(r.reason, /explicit abort \(user\)/);
});

// ── C. 闭合轮次落到 turn/end 原因判定：网络类仍可继续，其余终态 ───────
test('C1 turn/end error(网络) + 悬挂 tool/call → network-stopped（网络分支接管，仍可继续）', () => {
  const r = analyze([turnStart(1), stepStart(2), toolCall(3, 'c1'), endError(4)]);
  assert.equal(r.state, 'network-stopped');
  assert.match(r.reason, /network/);
});

test('C2 turn/end completed + 悬挂 tool/call → completed（不注入）', () => {
  const r = analyze([turnStart(1), stepStart(2), toolCall(3, 'c1'), endCompleted(4)]);
  assert.equal(r.state, 'completed');
});

test('C3 重启循环守卫对 open turn 的拦截未被破坏（注入后零产出被杀 → settled）', () => {
  const ours = ev('user/message', 2, { role: 'user', content: [{ type: 'text', text: CONTINUE }], source: { kind: 'plugin', plugin: 'dsh-autoresume' } });
  const r = analyze([turnStart(1), ours, turnStart(3), stepStart(4)]);
  assert.equal(r.state, 'settled');
  assert.match(r.reason, /restart loop guard/);
});
