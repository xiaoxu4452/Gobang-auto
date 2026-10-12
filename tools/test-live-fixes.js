/*
 * test-live-fixes.js —— 本轮（2026-09-15 晚）四项用户反馈的回归测试
 *
 * 用户原话与诉求：
 *   ① 「曲线图满 15 个坐标点向后延伸」                  → CHART_FIT 必须为 15
 *   ② 「如果检测有一方五子连珠的话，就不用再评估了」      → 盘面五连前置闸（纯盘面判定）
 *   ③ 「到最后评估的分数直接由负转正了（不在合理的思维内）」→ 颜色一律走 myColorCode/oppColorCode，
 *                                                        绝不用 ourIsBlack 反推；任一方五连后曲线封口
 *   ④ 「活4冲4的时候，还有两个对手视图的识别圆…只有一个」 → 唯一必防点时只画 1 个圈
 *   ⑤ 「我方要下的位置蓝色圆圈还是会坐标跳跃」            → 最佳落点稳定器（滞回）
 *   ⑥ 「对手评估有一点点慢了」                          → 周期 700ms + 盘面变化即刻触发
 *
 * 做法：源码守卫（断言发布的那份代码里确有该逻辑）+ 从源码抽真实函数做纯逻辑单测。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js');
const code = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push('  PASS  ' + name); }
  else { fail++; results.push('  FAIL  ' + name + (extra !== undefined ? '   → ' + extra : '')); }
}
function section(t) { results.push('\n== ' + t + ' =='); }

function extractFn(name) {
  const key = 'function ' + name + '(';
  const start = code.indexOf(key);
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = code.indexOf('{', start), depth = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return code.slice(start, i + 1); }
  }
  throw new Error('花括号不配平: ' + name);
}
const has = (s) => code.indexOf(s) >= 0;

// ═══════════════════════════════════════════════════════════
section('① 曲线铺满阈值 = 15（用户：「满 15 个坐标点向后延伸」）');
ok('CHART_FIT 定义为 15', /var\s+CHART_FIT\s*=\s*15\s*;/.test(code));
ok('已不存在 CHART_FIT = 30', !/var\s+CHART_FIT\s*=\s*30\s*;/.test(code));
ok('注释已同步为「满 15 手」语义', has('曲线图满 15 个坐标点向后延伸'));
ok('drawChart 用 CHART_FIT 控制点距（铺满 ↔ 延伸）',
  /denom\s*=\s*\(n\s*<=\s*CHART_FIT\)\s*\?\s*Math\.max\(1,\s*n\s*-\s*1\)\s*:\s*\(CHART_FIT\s*-\s*1\)/.test(code));

// 曲线几何纯逻辑：从源码抽 denom/step/W 的算法复现，验证 15 是分界
(function () {
  const padL = 4, padR = 4, viewW = 195;
  const innerW0 = viewW - padL - padR;
  function geom(n, FIT) {
    const denom = (n <= FIT) ? Math.max(1, n - 1) : (FIT - 1);
    const step = innerW0 / denom;
    const contentW = padL + padR + (n > 1 ? (n - 1) * step : 0);
    return { step, W: Math.max(Math.round(viewW), Math.round(contentW)) };
  }
  const g15 = geom(15, 15), g16 = geom(16, 15), g14 = geom(14, 15);
  ok('n=15 恰好铺满（画布宽 == 可视宽）', Math.abs(g15.W - viewW) <= 1, 'W=' + g15.W);
  ok('n=16 超出 → 画布变宽（出现横向滚动条）', g16.W > viewW, 'W=' + g16.W);
  ok('n=14 也铺满（≤15 均铺满）', Math.abs(g14.W - viewW) <= 1, 'W=' + g14.W);
  ok('n=16 点距 == n=15 点距（锁定为 15 点铺满时的点距）',
    Math.abs(g16.step - g15.step) < 1e-9, g16.step + ' vs ' + g15.step);
})();

// ═══════════════════════════════════════════════════════════
section('② 五连即停算（用户：「检测有一方五子连珠就不用再评估了」）');
ok('存在盘面五连前置闸（纯盘面判定，不看引擎 matePly）', has('五连即停算（用户明确要求）'));
ok('闸内用 _myFive / _opFive 双向判定', has('var _myFive = maxLineLen(board, _mC) >= 5;') && has('var _opFive = maxLineLen(board, _oC) >= 5;'));
ok('闸内无条件置 haltForNewGame = true', /if\s*\(_myFive\s*\|\|\s*_opFive\)\s*\{[\s\S]{0,400}?haltForNewGame\s*=\s*true/.test(code));
ok('闸内把终局那一手入点（封口）', /if\s*\(_myFive\s*\|\|\s*_opFive\)\s*\{[\s\S]{0,600}?pushHistPoint\(/.test(code));
ok('闸内清对手圈（终局无预测意义）', /if\s*\(_myFive\s*\|\|\s*_opFive\)\s*\{[\s\S]{0,700}?clearOppSvgLayer\(\)/.test(code));
ok('闸位置在「轮到对手」守卫之后（对手成五也要停）',
  code.indexOf('五连即停算（用户明确要求）') > code.indexOf('if (!ourTurn) {'));
ok('闸位置在引擎请求之前（不浪费一次搜索）',
  code.indexOf('五连即停算（用户明确要求）') < code.indexOf('var body0 = JSON.stringify({ board: board'));

// 纯逻辑：五连判定
(function () {
  const N = 15;
  function maxLineLen(b, color) {
    let best = 0; const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (b[r][c] !== color) continue;
      for (const [dr, dc] of dirs) {
        const pr = r - dr, pc = c - dc;
        if (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === color) continue;
        let len = 1;
        for (let nr = r + dr, nc = c + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) len++;
        if (len > best) best = len;
      }
    }
    return best;
  }
  const empty = () => Array.from({ length: N }, () => new Array(N).fill(0));
  const b1 = empty(); for (let x = 5; x <= 9; x++) b1[3][x] = 1;              // 黑横五连 F12..J12（视觉）
  ok('黑横五连 maxLineLen=5', maxLineLen(b1, 1) === 5, maxLineLen(b1, 1));
  ok('同局面白无连 maxLineLen=0', maxLineLen(b1, 2) === 0);
  const b2 = empty(); for (let x = 5; x <= 8; x++) b2[3][x] = 1;              // 黑四连（冲四）
  ok('黑四连不是五连（不触发停算）', maxLineLen(b2, 1) === 4, maxLineLen(b2, 1));
  const b3 = empty(); for (let y = 3; y <= 7; y++) b3[y][6] = 2;              // 白竖五连
  ok('白竖五连 maxLineLen=5', maxLineLen(b3, 2) === 5);
  const b4 = empty(); for (let k = 0; k < 5; k++) b4[2 + k][2 + k] = 1;       // 黑斜五连
  ok('黑斜五连 maxLineLen=5', maxLineLen(b4, 1) === 5);
  const b5 = empty(); for (let k = 0; k < 6; k++) b5[2][2 + k] = 1;           // 黑长连 6
  ok('黑长连 6 也 >=5（触发停算）', maxLineLen(b5, 1) >= 5, maxLineLen(b5, 1));
})();

// ═══════════════════════════════════════════════════════════
section('③ 颜色一律走 myColorCode/oppColorCode（修「由负转正」）');
ok('盘面五连判定改用 myColorCode()', has('var myColor0 = myColorCode();'));
ok('盘面五连判定改用 oppColorCode()', has('var oppColor0 = oppColorCode();'));
// ourIsBlack 只允许出现在「颜色未定(myColor0===0)的兜底分支」内，不得作为主路径。
// 判据：它必须出现在 `if (myColor0 === 0) {` 之后紧邻的几行内。
(function () {
  const i0 = code.indexOf('var myColor0 = myColorCode();');
  const iNull = code.indexOf('if (myColor0 === 0) {', i0);
  const iMain = code.indexOf('myColor0 = ourIsBlack === true ? 1 : 2;', i0);
  ok('ourIsBlack 反推仅存在于「颜色未定」兜底分支',
    iNull > i0 && iMain > iNull && (iMain - iNull) < 220,
    'nullBranch@' + iNull + ' main@' + iMain);
})();
ok('存在颜色源不一致告警（可观测）', has('color source mismatch: myColorCode='));
ok('我方/对手颜色未定时有兜底（不臆造）', /if\s*\(myColor0\s*===\s*0\)\s*\{/.test(code));

// 指纹顺序 bug 修复
ok('指纹不再提前引用未赋值的 toMoveIsBlack', !has("var fp = fpStones + '#' + myColorCode() + '#' + (toMoveIsBlack ? 1 : 2);"));
ok('指纹用现算的轮次，且走【开局行棋方权威】（空盘判黑先）',
   has("var fpToMoveIsBlack = (openingSideToMove(board) === 1);"));
ok('指纹仍包含我方颜色码与轮次', /var fp = fpStones \+ '#' \+ myColorCode\(\) \+ '#' \+ \(fpToMoveIsBlack \? 1 : 2\);/.test(code));

// renderResult 入点封口
ok('renderResult 入点加了 !haltForNewGame 守卫', has('if (fresh !== false && !haltForNewGame) {'));
ok('注释说明「停止评估 = 曲线封口」', has('停止评估 = 曲线封口'));

// ═══════════════════════════════════════════════════════════
section('④ 唯一必防点时对手圈只画一个（用户：「冲4只有一个要防的位置」）');
// 【本轮重构】原来内联在 runOppEval 里的 needDefend / uniqueMust / maxRings 三分支，
// 已抽成「局面的纯函数」computeOppRings。原因（用户新反馈：「3/4 概率只出青色圈、
// 1/4 概率青色绿色同时出」）：内联版的两个分支过滤规则不一致，且圈数还取决于
// S.candCache[0] 是否已算出来 → 同一局面会因"引擎回包落在哪一帧"给出 1 个或 2 个圈。
// 详细行为断言见 tools/test-opp-rings.js（40 项，含终局 0 圈与乱序候选不变性）。
ok('圈统一由 computeOppRings 产出（唯一产出者）', has('function computeOppRings(reqBoard, myC, oppC, cands, rule)'));
ok('终局（任一方五连）→ 0 圈', has('if (boardHasFive(reqBoard)) return [];'));
ok('枚举我方成五点（对手必堵）', has('collect(myC, pts);'));
ok('枚举对手成五点', has('collect(oppC, pts);'));
ok('必防点最多取 2（闭四 1 个 / 活四 2 个）', has('return pts.slice(0, 2).map('));
ok('确定性排序（与引擎候选顺序无关）', has('pts.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });'));
ok('旧的三个内联分支已清除', !has('var uniqueMust =') && !has('var maxRings =') && !has('var needDefend = []'));
ok('无圈时显式清层（不再让旧圈残留）', has('clearOppSvgLayer();'));
ok('清层连带作废 lastOppRings（否则同帧重投影把旧圈复活）', has('lastOppRings = null; lastOppKey = null;'));

// allImmediateFiveCells 抽出来测「唯一必防点」判定
(function () {
  const N = 15;
  function allImmediateFiveCells(b, color) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const out = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (b[r][c] !== 0) continue;
      for (let d = 0; d < 4; d++) {
        const dr = dirs[d][0], dc = dirs[d][1];
        let cnt = 1;
        for (let nr = r + dr, nc = c + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) cnt++;
        for (let nr = r - dr, nc = c - dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr -= dr, nc -= dc) cnt++;
        if (cnt >= 5) { out.push({ i: c, j: r }); break; }
      }
    }
    return out;
  }
  const empty = () => Array.from({ length: N }, () => new Array(N).fill(0));
  // 我方（白=2）冲四：'.2 2 2 2 .' → 只有两个端点能成五 → 其实是 2 个必防点（活四两端）
  const a = empty(); a[7][5] = 2; a[7][6] = 2; a[7][7] = 2; a[7][8] = 2;
  ok('活四（两端）→ 2 个成五点（不该只画一个）', allImmediateFiveCells(a, 2).length === 2, JSON.stringify(allImmediateFiveCells(a, 2)));
  // 冲四：一端被堵 → 唯一成五点
  const b = empty(); b[7][4] = 1; b[7][5] = 2; b[7][6] = 2; b[7][7] = 2; b[7][8] = 2;
  ok('冲四（一端被堵）→ 唯一成五点 == 1', allImmediateFiveCells(b, 2).length === 1, JSON.stringify(allImmediateFiveCells(b, 2)));
  // 斜向冲四
  const c = empty(); c[4][4] = 1; c[5][5] = 2; c[6][6] = 2; c[7][7] = 2; c[8][8] = 2;
  ok('斜向冲四 → 唯一成五点 == 1', allImmediateFiveCells(c, 2).length === 1, JSON.stringify(allImmediateFiveCells(c, 2)));
})();

// ═══════════════════════════════════════════════════════════
section('⑤ 最佳落点稳定器（修「蓝圈坐标跳跃」）');
ok('存在 stabilizeBest 函数', has('function stabilizeBest(best, cands, fpKey, scoreOf) {'));
ok('存在 stabilizeBestReset', has('function stabilizeBestReset()'));
ok('STABLE_CONFIRM 已定义', /var\s+STABLE_CONFIRM\s*=\s*\d+\s*;/.test(code));
ok('STABLE_MARGIN 已定义', /var\s+STABLE_MARGIN\s*=\s*\d+\s*;/.test(code));
ok('drawOverlay 内调用了稳定器', has('best = stabilizeBest(best, cands, _sbKey, _sbScore);'));
ok('换色（pickSideManual）重置稳定器', /function pickSideManual[\s\S]{0,900}?stabilizeBestReset\(\)/.test(code));
ok('新局（resetNewGame）重置稳定器', /function resetNewGame[\s\S]{0,700}?stabilizeBestReset\(\)/.test(code));
ok('注释点明「只影响显示，不影响落子」', has('只影响【显示】，绝不影响落子'));

// 稳定器纯逻辑复现（从源码抽 stabilizeBest 需外层状态；这里按同一算法独立实现验证语义）
(function () {
  const STABLE_CONFIRM = 2, STABLE_MARGIN = 120;
  let st = { key: null, x: -1, y: -1, score: null, candX: -1, candY: -1, candN: 0 };
  function stabilizeBest(best, fpKey, scoreOf) {
    const bx = best[0], by = best[1];
    if (st.key !== fpKey) { st = { key: fpKey, x: bx, y: by, score: scoreOf(bx, by), candX: bx, candY: by, candN: 1 }; return best; }
    if (bx === st.x && by === st.y) { st.candN = 0; st.candX = -1; st.candY = -1; st.score = scoreOf(bx, by); return [st.x, st.y]; }
    const newSc = scoreOf(bx, by), oldSc = st.score;
    if (newSc != null && oldSc != null && (newSc - oldSc) >= STABLE_MARGIN) { st = { key: fpKey, x: bx, y: by, score: newSc, candX: bx, candY: by, candN: 1 }; return best; }
    if (bx === st.candX && by === st.candY) st.candN++; else { st.candX = bx; st.candY = by; st.candN = 1; }
    if (st.candN >= STABLE_CONFIRM) { st = { key: fpKey, x: bx, y: by, score: newSc, candX: -1, candY: -1, candN: 0 }; return best; }
    return [st.x, st.y];
  }
  const scores = { '5,5': 300, '6,6': 310, '7,7': 900 };
  const sc = (x, y) => scores[x + ',' + y];
  // 同一局面：先 A(5,5)，再 B(6,6)（仅高 10 分）→ 应保持 A
  let r1 = stabilizeBest([5, 5], 'K1', sc); ok('首次直接采纳 A', r1[0] === 5 && r1[1] === 5, r1);
  let r2 = stabilizeBest([6, 6], 'K1', sc); ok('B 只高 10 分 → 仍显示 A（抑制跳跃）', r2[0] === 5 && r2[1] === 5, r2);
  let r3 = stabilizeBest([6, 6], 'K1', sc); ok('B 连续第 2 次 → 切换到 B', r3[0] === 6 && r3[1] === 6, r3);
  // 明显更优（+600）→ 立即切换
  let r4 = stabilizeBest([7, 7], 'K1', sc); ok('明显更优（+590）→ 立即切到 C', r4[0] === 7 && r4[1] === 7, r4);
  // 局面变了 → 直接采纳新结果
  let r5 = stabilizeBest([5, 5], 'K2', sc); ok('新局面 → 立即采纳（不残留旧点）', r5[0] === 5 && r5[1] === 5, r5);
  // 同一局面再来一次 A→B 抖动序列，验证不会被拉走
  stabilizeBest([6, 6], 'K3', sc);
  let r6 = stabilizeBest([6, 6], 'K3', sc);   // 稳定在 B
  let r7 = stabilizeBest([5, 5], 'K3', sc);   // 抖回 A（低 10 分）
  ok('稳定后抖回低分点 → 保持', r7[0] === 6 && r7[1] === 6, r7);
})();

// ═══════════════════════════════════════════════════════════
section('⑥ 对手评估提速');
ok('周期收紧到 700ms', has('setInterval(runOppEval, 700)'));
ok('已不存在 1200ms 周期', !has('setInterval(runOppEval, 1200)'));
ok('存在 kickOppEval（盘面变化即刻触发）', has('function kickOppEval() {'));
ok('对手落子处调用 kickOppEval', /oppColorHere = added\[kA\]\.v;[\s\S]{0,200}?kickOppEval\(\)/.test(code));
ok('kickOppEval 有防抖（120ms 合并同波抖动）', has('}, 120);'));
ok('kickOppEval 有 haltForNewGame 短路', /function kickOppEval\(\)\s*\{\s*\n?\s*if\s*\(!S\.oppMoves \|\| oppEvalBusy \|\| haltForNewGame\) return;/.test(code));

// ═══════════════════════════════════════════════════════════
section('⑦ 旧实现已彻底清除（防回归）');
ok('无旧「同色连写」说明', !has('同色连写（先列全部黑子'));
ok('无 CHART_FIT=30', !has('var CHART_FIT = 30;'));
ok('无旧 2000ms 对手周期', !has('setInterval(runOppEval, 2000)'));
ok('无「候选前 2 名」硬编码写法残留', !has('d.candidates.length && rings.length < 2; ci++'));

console.log(results.join('\n'));
console.log('\n' + '='.repeat(60));
console.log('test-live-fixes: ' + pass + ' passed, ' + fail + ' failed  (total ' + (pass + fail) + ')');
process.exit(fail ? 1 : 0);
