/*
 * test-perspective.js —— 「评估值/评估曲线都是我方的评估」语义自测
 *
 * 覆盖用户明确提出的三条要求：
 *   1. 评估值（面板 + 状态栏）必须是【我方视角】：轮到对手走时，引擎给行棋方 +350，
 *      对我方就是 -350，显示必须翻号；M 值只翻符号，绝不做「步数→分值」换算。
 *   2. 曲线动态：点数 ≤15 → 铺满整幅可视宽度；>15 → 点距锁定、画布向右延伸出滚动条。
 *   3. 每一子都要有映射：M/-M 不再被跳过，归一到 ±1000 入点；±M1 那一手也必须有曲线点。
 *
 * 做法：从 bookmarklet.js 里【抽取真实函数源码】在沙箱里跑（不复制粘贴实现，
 * 保证测的就是即将发布的那份代码）。
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
  else { fail++; results.push('  FAIL  ' + name + (extra ? '   → ' + extra : '')); }
}
function section(t) { results.push('\n== ' + t + ' =='); }

// ---------- 抽取一个顶层 function 的源码（花括号配平） ----------
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

// ---------- 沙箱：只放被测函数 + 依赖 ----------
const sandbox = {};
const fnNames = ['evalToMine', 'evalToScore'];
for (const n of fnNames) {
  const src = extractFn(n);
  // 用 Function 构造，注入到沙箱对象上（不需要 DOM）
  const f = new Function('return (' + src + ')')();
  sandbox[n] = f;
}

const { evalToMine, evalToScore } = sandbox;

section('1) evalToMine —— 我方视角归一（数值）');
// 轮我方走：引擎值即我方值（只补正号）
ok('轮我方 +350 → +350', evalToMine('+350', true) === '+350', evalToMine('+350', true));
ok('轮我方 -120 → -120', evalToMine('-120', true) === '-120', evalToMine('-120', true));
// 轮对手走：必须翻号（对手 +350 = 我方 -350）
ok('轮对手 +350 → -350（关键：不能把对手的分当我方的分）',
  evalToMine('+350', false) === '-350', evalToMine('+350', false));
ok('轮对手 -120 → +120', evalToMine('-120', false) === '+120', evalToMine('-120', false));
ok('无符号 350 轮我方 → +350', evalToMine('350', true) === '+350', evalToMine('350', true));
ok('无符号 350 轮对手 → -350', evalToMine('350', false) === '-350', evalToMine('350', false));
ok('0 轮我方 → +0 或 0（不产生 -0）', !/-0/.test(evalToMine('0', true)), evalToMine('0', true));

section('2) evalToMine —— 杀棋标记只翻符号、不动量级');
ok('轮我方 +M17 → +M17', evalToMine('+M17', true) === '+M17', evalToMine('+M17', true));
ok('轮我方 -M3 → -M3', evalToMine('-M3', true) === '-M3', evalToMine('-M3', true));
ok('轮对手 +M17 → -M17', evalToMine('+M17', false) === '-M17', evalToMine('+M17', false));
ok('轮对手 -M3 → +M3', evalToMine('-M3', false) === '+M3', evalToMine('-M3', false));
ok('小写 m 也识别：+m5 轮对手 → -M5', evalToMine('+m5', false) === '-M5', evalToMine('+m5', false));
ok('绝不出现 638 这类伪分值', !/63[0-9]/.test(evalToMine('+M17', true)));
ok('空串 → 空串', evalToMine('', true) === '');
ok('无法解析 → 原样返回', evalToMine('???', true) === '???');

section('3) evalToScore —— 每一手都有分值（M 归一 ±1000）+ valid 标记');
let r;
r = evalToScore('+350', true);   ok('数字轮我方 +350 → score 350 + valid', r.score === 350 && r.valid === true, JSON.stringify(r));
r = evalToScore('+350', false);  ok('数字轮对手 +350 → score -350（我方视角翻转）', r.score === -350 && r.valid === true, JSON.stringify(r));
r = evalToScore('+M17', true);   ok('+M17 轮我方 → +1000（每一手都有映射）', r.score === 1000 && r.verdict === 'win' && r.matePly === 17 && r.valid === true, JSON.stringify(r));
r = evalToScore('+M17', false);  ok('+M17 轮对手 → -1000（对手杀我）', r.score === -1000 && r.verdict === 'lose' && r.matePly === 17 && r.valid === true, JSON.stringify(r));
r = evalToScore('-M1', true);    ok('-M1 轮我方 → -1000 + matePly 1', r.score === -1000 && r.matePly === 1 && r.valid === true, JSON.stringify(r));
r = evalToScore('+M1', false);   ok('+M1 轮对手 → -1000 + matePly 1（终局那一手必须有点）', r.score === -1000 && r.matePly === 1 && r.valid === true, JSON.stringify(r));
r = evalToScore('', true);       ok('空串 → valid=false（不得塞假 0 点）', r.valid === false, JSON.stringify(r));
r = evalToScore('abc', true);    ok('非法串 → valid=false', r.valid === false, JSON.stringify(r));

section('4) 曲线动态：铺满 → 超阈值延伸');
// 复刻 drawChart 的几何公式（与实现同式；实现里用 csc.clientWidth 作 viewW）
// ★ 阈值 30 → 15（2026-09-15 用户要求：「曲线图满 15 个坐标点向后延伸」）
function geom(n, viewW) {
  const padL = 4, padR = 4, FIT = 15;
  const innerW0 = viewW - padL - padR;
  const denom = (n <= FIT) ? Math.max(1, n - 1) : (FIT - 1);
  const step = innerW0 / denom;
  const contentW = padL + padR + (n > 1 ? (n - 1) * step : 0);
  const W = Math.max(Math.round(viewW), Math.round(contentW));
  const pxOf = (k) => (n <= 1) ? (padL + innerW0 / 2) : (padL + k * step);
  return { step, W, pxOf, last: n ? pxOf(n - 1) : null };
}
const VW = 195;
let g;
g = geom(3, VW);
ok('3 个点：最后一点正好落在右边界（铺满整幅视图）', Math.abs(g.last - (VW - 4)) < 0.01, 'last=' + g.last);
ok('3 个点：画布不超出可视宽度（无滚动条）', g.W === VW, 'W=' + g.W);
ok('3 个点：点距被拉伸到 (195-8)/2=93.5', Math.abs(g.step - 93.5) < 0.01, 'step=' + g.step);
g = geom(2, VW);
ok('2 个点：同样铺满整幅视图', Math.abs(g.last - (VW - 4)) < 0.01, 'last=' + g.last);
g = geom(15, VW);
ok('15 个点：刚好铺满，无滚动条（新阈值）', g.W === VW && Math.abs(g.last - (VW - 4)) < 0.01, 'W=' + g.W + ' last=' + g.last);
const step15 = g.step;
g = geom(16, VW);
ok('16 个点：点距锁定为 15 点时的宽度', Math.abs(g.step - step15) < 1e-9, g.step + ' vs ' + step15);
ok('16 个点：画布开始变宽（出现横向滚动条）', g.W > VW, 'W=' + g.W);
g = geom(60, VW);
ok('60 个点：画布继续向右延伸', g.W > geom(16, VW).W, 'W=' + g.W);
ok('60 个点：最后一个点仍在画布右边界', Math.abs(g.last - (g.W - 4)) < 0.51, 'last=' + g.last + ' W=' + g.W);
g = geom(1, VW);
ok('1 个点：水平居中（不贴左）', Math.abs(g.pxOf(0) - (4 + (VW - 8) / 2)) < 0.01, 'x=' + g.pxOf(0));

section('5) 实现源码一致性（防「测试通过但代码没改」）');
const need = [
  ['drawChart 用 clientWidth 取可视宽度', /var viewW = \(csc && csc\.clientWidth\) \? csc\.clientWidth : 0;/],
  ['drawChart 有 CHART_FIT 阈值（=15）', /var CHART_FIT = 15;/],
  ['drawChart 点距按 denom 动态计算', /var denom = \(n <= CHART_FIT\) \? Math\.max\(1, n - 1\) : \(CHART_FIT - 1\);/],
  ['drawChart 的 px 用点序 k（非真实手数）', /var px = function \(k\) \{ return \(n <= 1\) \? \(padL \+ innerW0 \/ 2\) : \(padL \+ k \* step\); \};/],
  ['drawChart 无旧的 MIN_PLIES/pointW 固定间距实现（注释里提及历史做法不算）',
    /\b(?:var|let|const)\s+(?:MIN_PLIES|pointW)\s*=|\bpointW\s*\)/, true],
  ['存在 evalToMine 我方视角归一函数', /function evalToMine\(evStr, myIsSideToMove\)/],
  ['evalToScore 带 valid 标记', /var out = \{ score: 0, verdict: 'none', matePly: 0, valid: false \};/],
  ['renderResult M 值也入点（不再 isNaN 跳过）', /if \(pv != null\) pushHistPoint\(plyNow, pv\);/],
  ['存在 pushHistPoint（同一手覆盖、不重复加点）', /function pushHistPoint\(ply, value\)/],
  ['面板评估栏走我方视角（rawEvalText 读 myEval）', /var s = S\.myEval;\s*\n?\s*if \(typeof s === 'string' && s\.length\) return s\.trim\(\);/],
  ['状态栏评估文本走 myEval', /var dispEv = \(typeof S\.myEval === 'string' && S\.myEval\.length\) \? S\.myEval/],
  ['实时轮询也归一我方视角', /var lMine = lRaw \? evalToMine\(lRaw, myIsSideToMove\) : '';/],
  ['主分析写入 myEval', /S\.myEval = S\.rawEval \? evalToMine\(S\.rawEval, myIsSideToMove\) : '';/],
  ['新局重置 myEval', /S\.rawEval = ''; S\.myEval = ''; S\.verdict = 'none'; S\.matePly = 0; saveHistory\(\);/],
  ['持久化含 myEval', /myEval: S\.myEval/],
  ['轮到对手不评估（等待分支直接 return）', /if \(!ourTurn\) \{/],
  ['旧的「仅自动模式」守卫已移除（手动模式也必须不评估对手）', /if \(S\.autoPlay && !ourTurn\) \{ setStatus\('<span style="color:#555;">'/, true],
];
for (const [name, re, negate] of need) {
  const hit = re.test(code);
  ok(name, negate ? !hit : hit);
}

console.log(results.join('\n'));
console.log('\n----------------------------------------');
console.log('perspective/eval/curve 测试：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
