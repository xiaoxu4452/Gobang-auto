// test-anchor.js —— 自动落子「开局锚点守卫」回归测试
// 直接抽取源文件里真实的 autoAnchorPick（不做副本，避免实现漂移），用桩函数喂入依赖，
// 覆盖：① Rapfi 浅搜远点（用户反馈的“白子落点非常偏”）② 近石候选回退 ③ 禁手绕开
//      ④ 距离 2 跳（合法）⑤ 仅 candCache 无 data 的缓存回退支 ⑥ 空盘首手
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js');
const src = fs.readFileSync(SRC, 'utf8');

// ---- 抽取真实函数（花括号配平）----
const start = src.indexOf('function autoAnchorPick(');
if (start < 0) { console.error('FAIL: autoAnchorPick not found in source'); process.exit(1); }
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const funcText = src.slice(start, end + 1);

// 桩：从 (i,j) 向外螺旋找最近空格（与面板 nearestEmpty 语义一致）
function nearestEmpty(b, i, j) {
  for (let rad = 1; rad < b.length; rad++)
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
      const x = i + dx, y = j + dy;
      if (x >= 0 && x < b.length && y >= 0 && y < b.length && b[y][x] === 0) return { i: x, j: y };
    }
  return null;
}
function makeFactory(S, forbidStub) {
  const factory = new Function('S', 'isForbiddenPoint', 'nearestEmpty',
    'return ' + funcText + ';');
  return factory(S, forbidStub, nearestEmpty);
}
function emptyBoard() { return Array.from({ length: 15 }, () => new Array(15).fill(0)); }
function cheb(a, b) { return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); }
function eq(p, x, y) { return p && p[0] === x && p[1] === y; }

let pass = 0, fail = 0;
function assert(cond, name) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }

const S0 = { rule: 0 };                       // 无禁手规则
const fap = makeFactory(S0, () => false);

// 局面：仅黑子落在 H8 = (7,7)（用户截图同款“黑先一手后轮白”）
const board = emptyBoard(); board[7][7] = 1;

// A1) 【深搜尊重】Rapfi 深搜 best=H11(7,10)（距 H8 达 3 格）→ 一律尊重引擎，照下
//     （2026-09-25 晚三新契约：深搜落远点是正着——做杀延诱/远防，不再被守卫改判）
{
  const data = { best: [7, 10], candidates: [] };
  const r = fap(board, data, [], null, { budgetMs: 5000 });
  assert(eq(r, 7, 10), 'A1 深搜(5s)远点 best 直接尊重');
  const r0 = fap(board, data, [], null);   // 未传 opts 也按深搜口径（两调用点均已显式传参）
  assert(eq(r0, 7, 10), 'A1b 未传 opts 默认按深搜尊重');
}

// A2) 【浅搜守卫】同局面、预算 1s（浅搜）→ 远点 best 被否，落近石点
{
  const data = { best: [7, 10], candidates: [] };
  const r = fap(board, data, [], null, { budgetMs: 1000 });
  assert(r !== null, 'A2 返回有效落点');
  assert(cheb(r, [7, 7]) <= 2, 'A2 浅搜落点贴近已有棋子(≤2)');
  assert(!eq(r, 7, 10), 'A2 浅搜拒绝远点 H11');
}

// B) best 远点、浅搜预算：候选里首条近石候选 (7,8) 应被选中；深搜则尊重 best(7,10)
{
  const data = { best: [7, 10], candidates: [{ x: 7, y: 8, score: 100 }, { x: 7, y: 10, score: 50 }] };
  const rs = fap(board, data, [], null, { budgetMs: 1000 });
  assert(eq(rs, 7, 8), 'B 浅搜选中首条近石候选(7,8)');
  const rd = fap(board, data, [], null, { budgetMs: 5000 });
  assert(eq(rd, 7, 10), 'B2 深搜尊重 best(7,10)');
}

// C) best 本身就是近石(7,8) → 直接采用
{
  const r = fap(board, { best: [7, 8], candidates: [] }, [], null);
  assert(eq(r, 7, 8), 'C 直接采用近石 best');
}

// E) 距离 2 的“跳”(7,9) 属合法连接 → 接受
{
  const r = fap(board, { best: [7, 9], candidates: [] }, [], null);
  assert(eq(r, 7, 9), 'E 距离2跳合法');
}

// F) 仅 candCache、无 data 的缓存回退支：缓存来自主车道深搜 → 深搜口径取首条合法候选(7,8)
{
  const r = fap(board, null, [{ x: 7, y: 8 }, { x: 7, y: 10 }], null, { budgetMs: 99999 });
  assert(eq(r, 7, 8), 'F 缓存支(深搜口径)采用首条候选(7,8)');
  const rf = fap(board, null, [{ x: 7, y: 8 }, { x: 7, y: 10 }], null);
  assert(eq(rf, 7, 8), 'F2 缓存支未传 opts 默认深搜口径');
}

// ---- ★ 新契约：威胁点豁免（任何模式下不被守卫/贴身覆盖）----
// 局面：黑 (4,4)(5,5)(6,6)(7,7) 四连斜线，两端 (3,3)/(8,8) 成五点；白(0,0)，轮白（forbidColor=2）
// 盘上 5 子 ≤10 → 贴身(hugOpp)生效。引擎 best=(3,3)（挡黑五），距黑子远但属威胁点。
// 旧实现：贴身闸门会因 (3,3) 不贴黑而让位给贴黑候选 → 白眼睁睁看着黑成五 —— 已修复。
{
  const bt = emptyBoard();
  bt[0][0] = 2;                       // 白
  bt[4][4] = 1; bt[5][5] = 1; bt[6][6] = 1; bt[7][7] = 1;   // 黑斜四
  const data = { best: [3, 3], candidates: [{ x: 6, y: 7 }, { x: 3, y: 3 }] };
  const rShallow = fap(bt, data, [], 2, { budgetMs: 1000 });
  assert(eq(rShallow, 3, 3), 'T1 浅搜下威胁点(3,3)挡黑五仍被采用');
  const rDeep = fap(bt, data, [], 2, { budgetMs: 5000 });
  assert(eq(rDeep, 3, 3), 'T2 深搜下威胁点(3,3)被采用');
}

// G) 空盘首手：无棋子，best=天元(7,7) → 退回原 best（真实代码里首手另有专门处理，此处仅校验不崩）
{
  const r = fap(emptyBoard(), { best: [7, 7], candidates: [] }, [], null);
  assert(eq(r, 7, 7), 'G 空盘退回天元 best');
}

// D) 有禁手规则(rule=2)、我执黑(forbidColor=1)：best(7,8)恰为禁手 → 跳过并选下一近石候选(7,9)
{
  const forbid = (b, x, y, rule, color) => (x === 7 && y === 8);
  const fap2 = makeFactory({ rule: 2 }, forbid);
  const data = { best: [7, 8], candidates: [{ x: 7, y: 8 }, { x: 7, y: 9 }] };
  const r = fap2(board, data, [], 1);
  assert(eq(r, 7, 9), 'D 跳过禁手近点、选下一近石候选(7,9)');
}

// ---- ★ 开局白子贴身（根据 rapfi 白子开局贴近对手黑子）----
// 局面：黑 H8(7,7) + 白(3,3)（总 2 子 ≤10 → 开局贴身生效），落白子 forbidColor=2
const bw = emptyBoard(); bw[7][7] = 1; bw[3][3] = 2;

// H1) rapfi best(3,4) 只贴自家白子、不贴黑；候选里 (8,7) 贴黑 → 优先取贴黑候选
{
  const data = { best: [3, 4], candidates: [{ x: 3, y: 4, score: 90 }, { x: 8, y: 7, score: 70 }] };
  const r = fap(bw, data, [], 2);
  assert(eq(r, 8, 7), 'H1 白子开局优先取贴黑候选(8,7)');
}

// H2) rapfi best 本身贴黑(7,8) → 尊重引擎，直接采用
{
  const r = fap(bw, { best: [7, 8], candidates: [] }, [], 2);
  assert(eq(r, 7, 8), 'H2 best 贴黑时直接采用');
}

// H3) 无任何贴黑候选（best(3,4)/候选(3,5)(4,4) 都只贴白）→ 退回 rapfi 原始 best(3,4)
{
  const data = { best: [3, 4], candidates: [{ x: 3, y: 5 }, { x: 4, y: 4 }] };
  const r = fap(bw, data, [], 2);
  assert(eq(r, 3, 4), 'H3 无贴黑候选时尊重 rapfi best');
}

// H4) 落黑子(forbidColor=1)不启用贴身：best 只贴自家黑子 → 照常直接采用
{
  const bb = emptyBoard(); bb[3][3] = 1; bb[7][7] = 2;
  const data = { best: [3, 4], candidates: [{ x: 8, y: 7 }] };
  const r = fap(bb, data, [], 1);
  assert(eq(r, 3, 4), 'H4 黑子不启用贴身、仍用 best');
}

// H5) 总子数 >10（开局已过）→ 白子也不强制贴身：best(3,4) 只贴白 → 照常采用
{
  const bg = emptyBoard(); bg[3][3] = 2; bg[7][7] = 1;
  // 铺满 12 子（6 黑 6 白）
  const extra = [[0,0,1],[0,1,2],[1,0,1],[1,1,2],[2,0,1],[2,1,2],[13,13,1],[13,14,2],[14,13,1],[14,14,2]];
  for (const [x, y, c] of extra) bg[y][x] = c;
  const r = fap(bg, { best: [3, 4], candidates: [] }, [], 2);
  assert(eq(r, 3, 4), 'H5 开局已过(>10子)不强制贴身');
}

// H6) 仅 candCache 缓存支同样贴身：候选 (8,7) 贴黑 优先于 (3,4) 只贴白
{
  const r = fap(bw, null, [{ x: 3, y: 4 }, { x: 8, y: 7 }], 2);
  assert(eq(r, 8, 7), 'H6 缓存支同样优先贴黑候选');
}

console.log(`test-anchor: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
