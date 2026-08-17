#!/usr/bin/env node
// 自测：analyzeSessionEvents 状态机（空/完成/中断/已闭合）
// 用法: node scripts/self-test.mjs
import { analyzeSessionEvents } from '../src/service.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}: got "${actual}", want "${expected}"`); }
}

console.log('analyzeSessionEvents 状态机自测');
eq('empty', analyzeSessionEvents([]).state, 'empty');
eq('non-array → empty', analyzeSessionEvents(null).state, 'empty');

// 完成：最后是 assistant/message
eq('completed (assistant/message)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
    { type: 'assistant/message', seq: 3 },
  ]).state, 'completed');

// 完成：turn/end completed 且其后无新用户消息
eq('completed (turn/end=completed)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
  ]).state, 'completed');

// 中断：open turn（有 start 无 end）
eq('interrupted (open turn)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'step/start', seq: 2 },
  ]).state, 'interrupted');

// 中断：pending tool call（call 无 result）
eq('interrupted (pending tool call)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'tool/call', seq: 2, data: { callId: 'c1' } },
  ]).state, 'interrupted');

// 中断：turn/end reason=interrupted
eq('interrupted (turn/end=interrupted)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'interrupted' } } },
  ]).state, 'interrupted');

// 已闭合终态（cancelled）→ settled
eq('settled (cancelled)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'turn/end', seq: 2, data: { reason: { kind: 'cancelled' } } },
  ]).state, 'settled');

// tool/result 匹配后 pending 清空 → 无中断信号
eq('completed (tool resolved)',
  analyzeSessionEvents([
    { type: 'turn/start', seq: 1 },
    { type: 'tool/call', seq: 2, data: { callId: 'c1' } },
    { type: 'tool/result', seq: 3, data: { message: { source: { kind: 'tool', callId: 'c1' } } } },
    { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } },
  ]).state, 'completed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
