// 对手预测圈：确定性渲染（本轮修复「圈乱出」）
//
// 用户原话：「我们先手的时候，应该下完最后一个棋子进行五子连珠，然后对手评估的圆圈
//            3/4 的概率只出青色圈、1/4 的概率青色绿色同时出，这时你要做好科学的渲染了不要乱出」。
//
// 契约 —— 对手圈 = 局面的【纯函数】：
//   ① 任一方五连（含「我方模拟制胜手」造成的五连）→ 0 个圈
//   ② 有冲四/活四 → 必防点（闭四 = 1 个青圈；活四 = 2 个青+绿）
//   ③ 常规中盘 → 引擎候选前 2 名（确定性排序：分值降序 → y → x）
// 与 S.candCache 是否已算出、定时器相位、引擎回包顺序【完全无关】。
//
// 本轮修的两条根因：
//   A. clearOppSvgLayer() 只摘 SVG 节点、不作废 lastOppRings → drawOverlay 的「同帧重投影」
//      把刚清掉的圈原样复活（概率性观感就来自"热力层重画落在哪个 250ms tick"）。
//   B. 圈数取决于 best0 是否已算出 + 两个内联分支过滤规则不一致 → 同一局面 1 个或 2 个。
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log(`  FAIL ${name}: got ${a} want ${b}`); }
}
function ok(name, cond) { eq(name, !!cond, true); }

// ---- 从源工程真实抽取函数（不另写实现，避免"测试用另一套代码"）----
function pick(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}') { depth--; if (!depth) return SRC.slice(i, k + 1); }
  }
  throw new Error('函数体不平衡: ' + name);
}
const F = new Function(
  'var N = 15;\n' +
  ['maxLineLen', 'allImmediateFiveCells', 'evalToScore', 'candScoreOf', 'boardHasFive', 'computeOppRings']
    .map(pick).join('\n') +
  '\nreturn { maxLineLen, allImmediateFiveCells, evalToScore, candScoreOf, boardHasFive, computeOppRings };'
)();

// ---- 盘面工具 ----
const L = 'ABCDEFGHIJKLMNO';
const at = (s) => ({ i: s.charCodeAt(0) - 65, j: parseInt(s.slice(1), 10) - 1 });
function mk(black, white) {
  const b = Array.from({ length: 15 }, () => new Array(15).fill(0));
  black.forEach(s => { const c = at(s); b[c.j][c.i] = 1; });
  white.forEach(s => { const c = at(s); b[c.j][c.i] = 2; });
  return b;
}
const clone = (b) => b.map(r => r.slice());
function stm(b) {
  let bn = 0, wn = 0;
  for (let j = 0; j < 15; j++) for (let i = 0; i < 15; i++) { if (b[j][i] === 1) bn++; else if (b[j][i] === 2) wn++; }
  return bn > wn ? 2 : 1;
}
// 便于比对的稳定标签，例如 J4:t1
const R = (rings) => rings.map(r => L[r.x] + (r.y + 1) + ':t' + r.tier).sort();

const MY = 1, OPP = 2;   // 我方执黑（先手），对手执白

console.log('=== 1. 终局（任一方五连）→ 必须 0 个圈 ===');
{
  // 1a 我方（黑）已成五连：F4..J4
  const b1 = mk(['F4', 'G4', 'H4', 'I4', 'J4'], ['A1', 'B1', 'C1', 'D1']);
  ok('boardHasFive 认定我方五连', F.boardHasFive(b1));
  eq('我方五连 → 0 圈（即使给了候选）', F.computeOppRings(b1, MY, OPP, [{ x: 7, y: 7, eval: '+500' }], 0), []);

  // 1b 对手（白）已成五连
  const b2 = mk(['H8', 'I8', 'J8', 'K8'], ['A1', 'B1', 'C1', 'D1', 'E1']);
  ok('boardHasFive 认定对手五连', F.boardHasFive(b2));
  eq('对手五连 → 0 圈', F.computeOppRings(b2, MY, OPP, [{ x: 7, y: 7, eval: '+500' }], 0), []);

  // 1c 【本次反馈的核心场景】我方轮次 + 我方活四 → 模拟落入 best 后【恰好五连】
  //    棋局在我方这一手就结束 → 对手不存在"要下的位置" → 必须 0 个圈
  const b3 = mk(['F4', 'G4', 'H4', 'I4'], ['A1', 'B1', 'C1', 'D1']);   // 4:4 → 轮黑（我方）
  ok('活四局面本身还不是终局', !F.boardHasFive(b3));
  eq('活四局面的走子方 = 我方(黑1)', stm(b3), MY);
  const reqBoard = clone(b3);
  reqBoard[3][9] = MY;                       // 模拟我方 best 落在 J4 → 连成五
  ok('模拟我方制胜手后 reqBoard 已是五连', F.boardHasFive(reqBoard));
  eq('★ 模拟制胜手造成五连 → 0 圈（不可再出青/绿圈）', F.computeOppRings(reqBoard, MY, OPP, [{ x: 4, y: 3, eval: '+M1' }, { x: 9, y: 3, eval: '+M1' }], 0), []);

  // 1d 我方真正落下制胜子之后的盘面（= 1c 的 reqBoard），同样 0 圈
  eq('已落制胜子 → 0 圈', F.computeOppRings(reqBoard, MY, OPP, null, 0), []);
}

console.log('=== 2. 闭四（冲四）→ 恰好 1 个青圈 ===');
{
  // 我方黑 F4..I4，其中 E4 已被白子堵住 → 唯一的成五点是 J4
  const b = mk(['F4', 'G4', 'H4', 'I4'], ['E4', 'A1', 'A2']);   // 黑4 白3 → 轮白（对手）
  eq('轮到对手', stm(b), OPP);
  eq('我方成五点只有 J4', F.allImmediateFiveCells(b, MY, false).map(p => L[p.i] + (p.j + 1)), ['J4']);
  eq('★ 闭四 → 只画 1 个圈（J4 青色）', R(F.computeOppRings(b, MY, OPP, null, 0)), ['J4:t1']);
  eq('★ 即使引擎给了 3 个候选也不多画', R(F.computeOppRings(b, MY, OPP,
    [{ x: 7, y: 7, eval: '+900' }, { x: 8, y: 8, eval: '+800' }, { x: 9, y: 9, eval: '+700' }], 0)), ['J4:t1']);
}

console.log('=== 3. 活四 → 恰好 2 个圈（青 + 绿）===');
{
  // 我方黑 F4..I4 两端 E4 / J4 皆空 → 两个成五点
  const b = mk(['F4', 'G4', 'H4', 'I4'], ['A1', 'B1', 'C1']);   // 黑4 白3 → 轮白（对手）
  eq('轮到对手', stm(b), OPP);
  eq('两个成五点', F.allImmediateFiveCells(b, MY, false).map(p => L[p.i] + (p.j + 1)).sort(), ['E4', 'J4']);
  eq('★ 活四 → 2 个圈（E4 青 / J4 绿，按 y→x 确定性排序）',
    R(F.computeOppRings(b, MY, OPP, null, 0)), ['E4:t1', 'J4:t2']);
  // 关键：不依赖引擎候选 —— 传 null 也有同样的 2 个圈（证明是盘面推导出来的）
  eq('★ 候选为空也照样给出 2 个必防点', R(F.computeOppRings(b, MY, OPP, [], 0)), ['E4:t1', 'J4:t2']);
}

console.log('=== 4. 纯函数性：候选乱序 / 缺失 → 结果必须完全一致 ===');
{
  const b = mk(['F4', 'G4', 'H4', 'I4'], ['A1', 'B1', 'C1']);
  const base = R(F.computeOppRings(b, MY, OPP, null, 0));
  const baseKey = base.join('|');                 // 数组要用 join 后比较（=== 比的是引用）
  let same = 0;
  for (let n = 0; n < 200; n++) {
    // 每次塞入一批随机顺序（含非法/已占格/重复）的候选
    const junk = [
      { x: 3, y: 3, eval: '+400' }, { x: 9, y: 3, eval: '+M1' }, { x: 4, y: 3, eval: '-200' },
      { x: 0, y: 0, eval: '+100' }, { x: -1, y: 99, eval: '+999' }, { x: 7, y: 7 },
      { x: 4, y: 3, eval: '+300' }, { x: 14, y: 14, eval: '+50' },
    ];
    for (let i = junk.length - 1; i > 0; i--) { const k = (Math.random() * (i + 1)) | 0; const t = junk[i]; junk[i] = junk[k]; junk[k] = t; }
    if (R(F.computeOppRings(b, MY, OPP, junk, 0)).join('|') === baseKey) same++;
  }
  eq('★ 200 次乱序候选 → 结果 200 次完全相同', same, 200);
  eq('三种候选输入（null/[]/乱序）结果一致', [
    R(F.computeOppRings(b, MY, OPP, null, 0)),
    R(F.computeOppRings(b, MY, OPP, [], 0)),
    R(F.computeOppRings(b, MY, OPP, [{ x: 7, y: 7, eval: '+1' }], 0)),
  ], [base, base, base]);
}

console.log('=== 5. 常规中盘：最多 2 个圈 + 确定性排序 ===');
{
  const b = mk(['H8', 'I8'], ['H9', 'I9']);        // 无任何四 → 走候选兜底
  ok('中盘无成五点', F.allImmediateFiveCells(b, 1, false).length === 0 && F.allImmediateFiveCells(b, 2, false).length === 0);
  const cands = [{ x: 7, y: 7, eval: '+100' }, { x: 3, y: 3, eval: '+500' }, { x: 5, y: 5, eval: '+200' }];
  eq('按分值降序取前 2（(3,3)=500 青、(5,5)=200 绿）',
    R(F.computeOppRings(b, 1, 2, cands, 0)), ['D4:t1', 'F6:t2']);
  // 打乱顺序 → 同样的两个点
  let same = 0;
  for (let n = 0; n < 100; n++) {
    const s = cands.slice();
    for (let i = s.length - 1; i > 0; i--) { const k = (Math.random() * (i + 1)) | 0; const t = s[i]; s[i] = s[k]; s[k] = t; }
    if (R(F.computeOppRings(b, 1, 2, s, 0)).join(',') === 'D4:t1,F6:t2') same++;
  }
  eq('★ 100 次乱序候选 → 取到的始终是同样两点', same, 100);
  // 已占格绝不出圈：(7,7)=H8 黑、(8,8)=I9 白 都已被占
  const occ = F.computeOppRings(b, 1, 2, [{ x: 7, y: 7, eval: '+900' }, { x: 10, y: 10, eval: '+800' }, { x: 3, y: 3, eval: '+100' }], 0);
  ok('已占格 (7,7)=H8 不出圈', !occ.some(r => r.x === 7 && r.y === 7));
  eq('跳过已占格后按分值取前 2（K11 青、D4 绿）', R(occ), ['D4:t2', 'K11:t1']);
  eq('tier 连续且从 1 开始', F.computeOppRings(b, 1, 2, cands, 0).map(r => r.tier), [1, 2]);
  ok('圈数不超过 2', F.computeOppRings(b, 1, 2,
    Array.from({ length: 20 }, (_, i) => ({ x: i, y: 10, eval: '+100' })), 0).length <= 2);
}

console.log('=== 6. 源码守卫（防止回退到旧的时序相关实现）===');
{
  const clearFn = SRC.slice(SRC.indexOf('function clearOppSvgLayer('), SRC.indexOf('function clearOppSvgLayer(') + 1500);
  ok('clearOppSvgLayer 内作废 lastOppRings（根因 A）', /lastOppRings = null;/.test(clearFn));
  ok('clearOppSvgLayer 内作废 lastOppKey', /lastOppKey = null;/.test(clearFn));

  const drawI = SRC.indexOf('if (S.oppMoves && lastOppRings && lastOppRings.length && cal && cv && !boardHasFive(board))');
  ok('drawOverlay 的同帧重投影带终局闸（根因 A 的第二道保险）', drawI > 0);
  const keepI = SRC.indexOf('if (S.oppMoves && oppSvg && cal && cv && lastOppRings && lastOppRings.length && !boardHasFive(board))');
  ok('clearOverlayKeepOpp 的重投影同样带终局闸', keepI > 0);

  const runI = SRC.indexOf('async function runOppEval()');
  const runSeg = SRC.slice(runI, runI + 6000);
  ok('回包后先查 haltForNewGame（竞态闸）', /var d = await r\.json\(\);[\s\S]{0,400}if \(haltForNewGame\) return;/.test(runSeg));
  ok('回包后重判终局（boardHasFive(lastGoodBoard || board)）', /boardHasFive\(lastGoodBoard \|\| board\)/.test(runSeg));
  ok('圈由 computeOppRings 统一产出（根因 B）', /computeOppRings\(reqBoard, _myC, _oppC, d\.candidates, S\.rule\)/.test(runSeg));
  ok('无圈时显式清层（旧代码此处是"什么都不做"）',
    /if \(!rings\.length\) \{[\s\S]{0,400}?clearOppSvgLayer\(\);[\s\S]{0,80}?return;\s*\}/.test(runSeg));

  // 旧的内联分支必须已清除
  ok('旧内联 needDefend 已清除', SRC.indexOf('var needDefend = [];') < 0);
  ok('旧 uniqueMust 分支已清除', SRC.indexOf('var uniqueMust =') < 0);
  ok('旧 maxRings 变量已清除', SRC.indexOf('var maxRings =') < 0);
  ok('旧的"取候选前 2 名"循环已清除', SRC.indexOf('rings.length < maxRings') < 0);
  // lastOppKey 只声明一次（声明上移以便与 lastOppRings 一起作废）
  eq('var lastOppKey 只声明一次', (SRC.match(/var lastOppKey\b/g) || []).length, 1);
  ok('lastOppKey 与 lastOppRings 声明相邻（同生命周期）',
    Math.abs(SRC.indexOf('var lastOppKey') - SRC.indexOf('var lastOppRings')) < 500);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
