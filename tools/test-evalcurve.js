'use strict';
// 评估栏 + 评估曲线 契约测试
//
// 【形态参考 gomocalc，视角/入点按本项目用户要求有意偏离】
//   gomocalc app.js（已反查其线上 bundle）：
//     曲线入点：var n = +t.outputs.pv[0].eval; isNaN(n) || t.evalData.push({index:t.position.length, eval:n, piece});
//     评估栏  ：i("td",{...},[e._v(e._s(e.outputs.pv[0].eval))])
//     曲线种子：evalData:[{index:0,eval:0,piece:黑},{index:0,eval:0,piece:白}]
//   本项目两处有意偏离（均由用户明确要求驱动）：
//     △1 视角：一律换算成【我方视角】(evalToMine)，不再原样打印行棋方视角的 eval。
//     △2 入点：M/-M 不再跳过 —— 归一到 ±1000，保证【每一手都有曲线点】，±M1 那一手也必须有。
//   曲线动态：点数 ≤CHART_FIT(30) → 铺满整幅可视宽度；>30 → 点距锁定、画布向右延伸出滚动条。
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到函数 ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('函数未闭合 ' + name);
}
// 从真实源码里取出被测函数（保证测的就是要发布的那份）
const evalToMine = new Function('return (' + grab('evalToMine') + ')')();
const evalToScore = new Function('return (' + grab('evalToScore') + ')')();

console.log('=== 1. 评估栏 / 状态栏 = 我方视角的 eval ===');
const rawEvalSrc = grab('rawEvalText');
ok('rawEvalText 优先读 S.myEval（我方视角归一值）', /var s = S\.myEval;/.test(rawEvalSrc));
ok('rawEvalText 兜底读 S.rawEval（归一值缺失时不显示 -）', /s = S\.rawEval;/.test(rawEvalSrc));
ok('setStatPanel 用 rawEvalText() 填 __gb_st_eval', /var ev = rawEvalText\(\);\s*set\('__gb_st_eval', ev\)/.test(src));
ok('setStatPanel 不再自己拼 +M/-M', !/if \(S\.verdict === 'win'\) ev = '\+M'/.test(src));
ok('状态栏评估走 dispEv = S.myEval', /var dispEv = \(typeof S\.myEval === 'string' && S\.myEval\.length\) \? S\.myEval/.test(src));
ok('实时轮询评估栏走 lMine（已归一）',
  /var lMine = lRaw \? evalToMine\(lRaw, myIsSideToMove\) : '';/.test(src) &&
  /lset\('__gb_st_eval', lMine \|\| '-'\)/.test(src));
ok('实时轮询状态栏走 lMine', /'<\/b> <b style="color:' \+ lCol \+ '">\(' \+ lLab \+ '\)<\/b>'/.test(src) === false ||
  /\(lMine \|\| '-'\)/.test(src));
ok('主分析写入 S.myEval', /S\.myEval = S\.rawEval \? evalToMine\(S\.rawEval, myIsSideToMove\) : '';/.test(src));

console.log('');
console.log('=== 2. evalToMine：只翻符号、不动量级 ===');
ok('轮我方 +350 → +350', evalToMine('+350', true) === '+350');
ok('轮对手 +350 → -350', evalToMine('+350', false) === '-350');
ok('轮对手 -120 → +120', evalToMine('-120', false) === '+120');
ok('轮我方 +M17 → +M17（不做分值换算）', evalToMine('+M17', true) === '+M17');
ok('轮对手 +M17 → -M17', evalToMine('+M17', false) === '-M17');
ok('绝不出现 638 这类伪分值', !/63[0-9]/.test(evalToMine('+M17', true)));
ok('无法解析 → 原样返回', evalToMine('???', true) === '???');

console.log('');
console.log('=== 3. 每一手都要有曲线点（M/-M 不再跳过）===');
ok('存在 pushHistPoint（同手覆盖、不重复加点）', /function pushHistPoint\(ply, value\)/.test(src));
ok('pushHistPoint 同手数覆盖', /if \(lastP && lastP\.i === ply\) \{ lastP\.v = v; return; \}/.test(src));
ok('renderResult 曲线上限改 hand 数（≤400）', /if \(S\.history\.length > 400\) S\.history\.shift\(\);/.test(src));
ok('旧的 !isNaN(numEv) 跳过式入点已删除', !/if \(!isNaN\(numEv\) &&/.test(src));
ok('renderResult 无条件入点（valid 即入）', /if \(pv != null\) pushHistPoint\(plyNow, pv\);/.test(src));
ok('终局兜底：matePly===1 时也保证有点',
  /if \(pv == null && S\.matePly === 1\) pv = \(S\.verdict === 'lose'\) \? -1000 : \(S\.verdict === 'win' \? 1000 : null\);/.test(src));
ok('曲线点结构为 {i: 手数, v: 分值}', /S\.history\.push\(\{ i: ply, v: v \}\);/.test(src));
ok('X 用手数 plyNow = S.moves.length', /var plyNow = \(S\.moves && S\.moves\.length\) \? S\.moves\.length : 0;/.test(src));

// 真实映射：从第一手到 ±M1，每一手都该有点
const seq = ['0', '+120', '+M17', '-M3', '+350', '+M1'];
let mapped = 0;
seq.forEach(ev => { const r = evalToScore(ev, true); if (r.valid) mapped++; });
ok('数值与 M 值混合序列 ' + seq.length + ' 手全部可入点', mapped === seq.length, mapped + '/' + seq.length);

console.log('');
console.log('=== 4. 曲线动态：≤15 铺满 → >15 延伸（阈值 30→15，用户 2026-09-15 要求） ===');
ok('drawChart 用可视宽度作基准', /var viewW = \(csc && csc\.clientWidth\) \? csc\.clientWidth : 0;/.test(src));
ok('阈值 CHART_FIT = 15', /var CHART_FIT = 15;/.test(src));
ok('点距按 denom 动态计算', /var denom = \(n <= CHART_FIT\) \? Math\.max\(1, n - 1\) : \(CHART_FIT - 1\);/.test(src));
ok('px 以点序 k 为自变量', /var px = function \(k\) \{ return \(n <= 1\) \? \(padL \+ innerW0 \/ 2\) : \(padL \+ k \* step\); \};/.test(src));
ok('旧「固定 11px/手 + MIN_PLIES 靠左」实现已删除', !/\bvar MIN_PLIES\b/.test(src) && !/\bvar pointW\b/.test(src));
ok('单点时水平居中而非贴左', /\(n <= 1\) \? \(padL \+ innerW0 \/ 2\)/.test(src));
// 复现几何
function geom(n, viewW) {
  const padL = 4, padR = 4, FIT = 15, innerW0 = viewW - padL - padR;
  const denom = (n <= FIT) ? Math.max(1, n - 1) : (FIT - 1);
  const step = innerW0 / denom;
  const contentW = padL + padR + (n > 1 ? (n - 1) * step : 0);
  const W = Math.max(Math.round(viewW), Math.round(contentW));
  const pxOf = k => (n <= 1) ? (padL + innerW0 / 2) : (padL + k * step);
  return { step, W, pxOf, last: n ? pxOf(n - 1) : null };
}
const VW = 195;
const g3 = geom(3, VW), g15 = geom(15, VW), g16 = geom(16, VW), g60 = geom(60, VW);
ok('3 个点铺满整幅视图（末点 x=191）', Math.abs(g3.last - (VW - 4)) < 0.01, 'x=' + g3.last);
ok('3 个点点距 93.5px', Math.abs(g3.step - 93.5) < 0.01, 'step=' + g3.step);
ok('3 个点无滚动条（W=195）', g3.W === VW, 'W=' + g3.W);
ok('15 个点刚好铺满且无滚动条', g15.W === VW && Math.abs(g15.last - (VW - 4)) < 0.01);
ok('16 个点点距锁定为 15 点时的值', Math.abs(g16.step - g15.step) < 1e-9);
ok('16 个点开始出滚动条（W>195）', g16.W > VW, 'W=' + g16.W);
ok('60 个点继续向后延伸', g60.W > g16.W, g60.W + ' > ' + g16.W);
ok('60 个点末点贴右边界', Math.abs(g60.last - (g60.W - 4)) < 0.51, 'last=' + g60.last);

console.log('');
console.log('=== 5. evalToScore：M 归一到 ±1000，不再伪造中间分值 ===');
const ev2s = grab('evalToScore');
ok('旧 log10 幅度映射公式已删除', !/1000 - 500 \* Math\.log10\(nMV\)/.test(ev2s));
ok('M 情况 score 置 ±1000', /out\.score = myIsBenefited \? 1000 : -1000;/.test(ev2s));
ok('matePly 保留（供 ±M1 停算闸用）', /out\.matePly = nMV;/.test(ev2s));
ok('带 valid 标记（解析失败不得塞假 0 点）', /valid: false/.test(ev2s) && /out\.valid = true;/.test(ev2s));
const r17 = evalToScore('+M17', true);
ok('+M17（轮我走）→ matePly=17, verdict=win, score=+1000', r17.matePly === 17 && r17.verdict === 'win' && r17.score === 1000, JSON.stringify(r17));
const rn = evalToScore('+350', true);
ok('+350（轮我走）→ score=350', rn.score === 350 && rn.matePly === 0);
const rn2 = evalToScore('+350', false);
ok('+350（轮对手走）→ score=-350，视角正确翻转', rn2.score === -350);
const rm = evalToScore('-M3', false);
ok('-M3（轮对手走）→ 对我方有利 → win, +1000', rm.verdict === 'win' && rm.score === 1000 && rm.matePly === 3);
const rm1 = evalToScore('+M1', false);
ok('+M1（轮对手走）→ 我方必败 → -1000（终局那一手也入点）', rm1.verdict === 'lose' && rm1.score === -1000 && rm1.matePly === 1);
const rempty = evalToScore('', true);
ok('空串 → valid=false（不塞假 0 点）', rempty.valid === false);

console.log('');
console.log('=== 6. 持久化：v2 对象数组 + myEval ===');
ok('saveHistory 写入 __v:2 与 myEval', /__v: 2, h: S\.history, score: S\.score, rawEval: S\.rawEval, myEval: S\.myEval/.test(src));
ok('normalizeHistPoint 支持旧数字格式', /if \(typeof p === 'number'\) return \{ i: idx, v: p \};/.test(src));
ok('loadHistory 逐点归一化后截断', /S\.history = norm\.slice\(-400\)/.test(src));
ok('loadHistory 恢复 myEval', /S\.myEval = \(typeof d\.myEval === 'string'\) \? d\.myEval : '';/.test(src));
function normalizeHistPoint(p, idx) {
  if (typeof p === 'number') return { i: idx, v: p };
  if (p && typeof p === 'object' && typeof p.v === 'number') return { i: (typeof p.i === 'number' ? p.i : idx), v: p.v };
  return null;
}
const oldPts = [120, -300, 500].map((v, i) => normalizeHistPoint(v, i));
ok('旧 [120,-300,500] → [{i:0,v:120},{i:1,v:-300},{i:2,v:500}]',
  oldPts[0].v === 120 && oldPts[1].i === 1 && oldPts[2].v === 500, JSON.stringify(oldPts));
const nw = normalizeHistPoint({ i: 8, v: 640 }, 3);
ok('新格式 {i:8,v:640} 原样保留手数', nw.i === 8 && nw.v === 640, JSON.stringify(nw));
ok('脏数据 null/{}/字符串 → 丢弃', normalizeHistPoint(null, 0) === null &&
  normalizeHistPoint({}, 0) === null && normalizeHistPoint('x', 0) === null);

console.log('');
console.log('=== 7. 新局重置 ===');
ok('新局清空 rawEval / myEval / verdict / matePly',
  /S\.score = 0; S\.rawEval = ''; S\.myEval = ''; S\.verdict = 'none'; S\.matePly = 0; saveHistory\(\);/.test(src));

console.log('');
console.log('=== 8. 不评估对手 + 既有守卫仍在 ===');
ok('轮到对手：等待分支直接 return（不评估，且不限自动模式）',
  /if \(!ourTurn\) \{[\s\S]{0,400}?return;\s*\}/.test(src));
ok('颜色指纹含我执色', /myColorCode\(\) \+ '#'/.test(src));
ok('请求快照 reqOurIsBlack', /var reqOurIsBlack = ourIsBlack/.test(src));
ok('颜色一致性丢弃闸', /reqOurIsBlack !== ourIsBlack/.test(src));
ok('M1 停算闸仍在', /if \(matePly === 1\) \{/.test(src));

console.log('');
console.log('=== 9. 本轮三项修复的源码守卫 ===');
// 修复 1：轮对手不评估（不限自动模式）——防止按对手那一帧重算 eval 导致符号反转
ok('轮对手守卫对所有模式生效', /if \(!ourTurn\) \{/.test(src));
ok('旧的「仅自动模式」守卫已移除', !/if \(S\.autoPlay && !ourTurn\) \{ setStatus\('<span style="color:#555;">'/.test(src));
// 修复 2：落子走「强单路」、评估走「多路」→ 主分析 topN 恒为 1（单路深搜），多路 topN=8 由补充搜索负责
ok('主分析 topN 恒为单路 1（落子=强单路思考）', /var liveTopN = 1;/.test(src) && /topN: liveTopN, cid: CLIENT_ID/.test(src));
ok('多路 topN=8 由补充搜索承担（热图/对手圈评估）', /topN: 8, cid: CLIENT_ID/.test(src));
ok('不再硬编码 topN: 1', !/topN: 1, cid: CLIENT_ID/.test(src));
// 修复 3：对手圈与热力图同帧出现 → drawOverlay 末尾重投影对手层
// 【本轮收紧】重投影必须带终局闸 `!boardHasFive(board)`：任一方五连后棋局结束，
// 绝不允许把（可能残留的）lastOppRings 重新投影到已终局的盘面上（用户反馈的「圈乱出」）。
ok('drawOverlay 末尾重投影对手圈（同帧）', /if \(S\.oppMoves && lastOppRings && lastOppRings\.length && cal && cv && !boardHasFive\(board\)\) \{[\s\S]{0,120}?drawOppSvg\(cal, board, lastOppRings\)/.test(src));
ok('重投影带终局闸（五连后绝不投影对手圈）', /!boardHasFive\(board\)\) \{[\s\S]{0,120}?drawOppSvg\(cal, board, lastOppRings\)/.test(src));
ok('clearOverlayKeepOpp 的重投影同样带终局闸', /lastOppRings\.length && !boardHasFive\(board\)\)/.test(src));
ok('对手评估周期已收紧到 700ms（1200→700，用户反馈「慢了一点」）', /setInterval\(runOppEval, 700\)/.test(src));
ok('对手评估支持盘面变化即刻触发（kickOppEval）', /function kickOppEval\(\)/.test(src));

console.log('');
console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
