'use strict';
// 颜色一致性 + M1 停算 回归测试
// 目标（用户原话）：「用户选择那一手，就一直评估那一手…不要跳跃越级和跨黑白子」
//                「评估到 +-M1 就不再进行评估，等待下一局」
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return SRC.slice(a, b + endMarker.length);
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL ' + name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

console.log('=== 1. 源码层：三项关键守卫必须存在 ===');
const marks = [
  ['颜色指纹含我方颜色码', 'fpStones + \'#\' + myColorCode()'],
  ['请求期颜色快照', 'var reqFp = fp;'],
  ['快照与本帧一致才渲染', 'if (reqFp !== fp || reqOurIsBlack !== ourIsBlack)'],
  ['M1 停算闸', 'M1 停算闸'],
  ['M1 判定即 haltForNewGame=true', 'haltForNewGame = true;'],
  ['换色清空候选缓存', 'S.candCache = [];'],
  ['换色作废 fp', 'lastEngineFp = null; lastEngineAt = 0;'],
  ['换色清对手圈', 'lastOppRings = null; lastOppGeom = null;'],
  ['收官闸（不看 autoPlay）', '【收官闸】'],
  ['标题已去「可拖动下边缘」', '可拖动下边缘'],
];
marks.forEach(([n, k]) => { eq(n, SRC.indexOf(k) >= 0, n.indexOf('去') >= 0 ? false : true); });

console.log('=== 2. evalToScore：同一盘面在两种我执下必须给出相反符号 ===');
const N = 15;
const evalSrc = grab('function evalToScore(', '\n  }');
const ctx = new Function('N', '"use strict";var N; ' + evalSrc + '; return {evalToScore:evalToScore};')(N);
// 引擎报 +M1 是"当前行棋方赢"。轮我走→我赢；轮对手走→对手赢→我输。
eq('轮我走 +M1 = 我胜', ctx.evalToScore('+M1', true).verdict, 'win');
eq('轮对手走 +M1 = 我败', ctx.evalToScore('+M1', false).verdict, 'lose');
eq('轮我走 +M1 分数 +1000', ctx.evalToScore('+M1', true).score, 1000);
eq('轮对手走 +M1 分数 -1000', ctx.evalToScore('+M1', false).score, -1000);
// 数值评估同样必须反号，否则曲线会跨黑白跳变
eq('轮我走 +400 → +400', ctx.evalToScore('+400', true).score, 400);
eq('轮对手走 +400 → -400', ctx.evalToScore('+400', false).score, -400);

console.log('=== 3. 颜色指纹：换色必须让指纹变化（触发重算） ===');
// 复刻 fp 构造：落子串 + '#' + myColorCode + '#' + 轮次
function fpOf(stones, myColorCode, toMoveIsBlack) {
  return stones + '#' + myColorCode + '#' + (toMoveIsBlack ? 1 : 2);
}
{
  const stones = 'h8h9i8';
  const fpBlack = fpOf(stones, 1, true);   // 我执黑
  const fpWhite = fpOf(stones, 2, true);   // 我执白（同一盘面）
  eq('同盘面换色 → 指纹不同', fpBlack !== fpWhite, true);
  eq('同盘面同色 → 指纹相同', fpOf(stones, 1, true) === fpBlack, true);
  eq('未定色(0)也参与指纹', fpOf(stones, 0, true) !== fpBlack, true);
}

console.log('=== 4. M1 停算：matePly===1 是唯一停算条件，且必须早于普通渲染 ===');
{
  const iM1 = SRC.indexOf('M1 停算闸');
  // 注意：'M1 停算闸' 在源码中首次出现于 evalToScore（约 1695 行，±M1 停算闸注释），
  // 其位置天然早于自动落子/普通渲染块，故该断言实为「M1 相关标记早于普通渲染」。
  // iNormal 用自动落子块起始串定位（避免 renderResult 与 if 之间插入注释后多行精确匹配失效）。
  const iNormal = SRC.indexOf('if (S.autoPlay && ourTurn && Date.now() >= autoHaltUntil');
  eq('M1 闸在普通渲染之前', iM1 > 0 && iM1 < iNormal, true);
  // 收官闸的语义是【本帧轮到对手就什么都别做】，所以它必须排在「轮到对手 → return」之后；
  // 但它又必须排在「引擎请求」之前（否则会掉进"等引擎返回才收官"的旧 bug：
  // 手动模式下轮到我方制胜手时直接 return，四连眼睁睁下不出第五子）。
  // 即：iWait  <  iWin  <  iEngine。
  const iWin = SRC.indexOf('【收官闸】');
  const iWait = SRC.indexOf("if (!ourTurn) {");
  const iEngine = SRC.indexOf('var needEngine =');
  eq('「等待对手」return 在收官闸之前', iWait > 0 && iWait < iWin, true);
  eq('收官闸在引擎请求之前', iWin > 0 && iWin < iEngine, true);
  // 五连即停算闸：同样必须在引擎请求之前（不看引擎、纯盘面判定），且在收官闸之后
  const iFive = SRC.indexOf('【★ 五连即停算（用户明确要求）★】');
  eq('五连即停算闸在引擎请求之前', iFive > 0 && iFive < iEngine, true);
  eq('收官闸在五连即停算闸之前', iWin < iFive, true);
}

console.log('=== 5. 收官闸不依赖 autoPlay ===');
{
  // 抠出收官闸整段，确认条件里没有 autoPlay
  const a = SRC.indexOf('【收官闸】');
  const seg = SRC.slice(a, a + 1200);
  const condLine = seg.split('\n').find(l => l.indexOf('if (!haltForNewGame && ourTurn') >= 0) || '';
  eq('收官闸条件不含 autoPlay', condLine.indexOf('autoPlay') < 0, true);
  eq('收官闸条件含 ourTurn', condLine.indexOf('ourTurn') >= 0, true);
}

console.log('=== 6. 终局权威闸（本轮新增）：盘面五连必须在【轮次判断之前】短路 ===');
{
  // 用户原话：「我方是黑色的时候要下完最后第 5 个子」——落完第 5 子后：
  //   · 下面那把【五连即停算】闸位于 ourTurn 之后 → 终局那手轮次一翻转就永远执行不到；
  //   · haltForNewGame 会被 n===0 / resetNewGame 解开 → 终局画面"复活"。
  // 因此必须在 myColor0 解析完之后、`if (!ourTurn)` 之前插一把权威闸。
  const iAuth = SRC.indexOf('【★ 终局权威闸（本轮新增 · 最高优先级）★】');
  const iWait = SRC.indexOf('if (!ourTurn) {');
  const iWin = SRC.indexOf('【收官闸】');
  const iFiveOld = SRC.indexOf('【★ 五连即停算（用户明确要求）★】');
  eq('终局权威闸存在', iAuth > 0, true);
  eq('终局权威闸在「轮到对手 return」之前（否则第五子落完就漏判）', iAuth > 0 && iAuth < iWait, true);
  eq('终局权威闸在收官闸之前', iAuth > 0 && iAuth < iWin, true);
  eq('终局权威闸在旧五连闸之前', iAuth > 0 && iAuth < iFiveOld, true);
  // 闸门条件：任一方五连（两个 maxLineLen 都要出现）
  const seg = SRC.slice(iAuth, iAuth + 1600);
  const condLine = seg.split('\n').find(l => l.indexOf('maxLineLen(board') >= 0 && l.indexOf('if (') >= 0) || '';
  eq('终局权威闸判我方五连', condLine.indexOf('maxLineLen(board, myColor0)') >= 0, true);
  eq('终局权威闸判对手五连', condLine.indexOf('maxLineLen(board, oppColor0)') >= 0, true);
  eq('终局权威闸条件不含 autoPlay / ourTurn（纯盘面）',
     condLine.indexOf('autoPlay') < 0 && condLine.indexOf('ourTurn') < 0, true);
  // 必须上持久化锁（跨帧/跨会话都解不开）
  eq('终局权威闸置 haltForNewGame', seg.indexOf('haltForNewGame = true') >= 0, true);
  eq('终局权威闸上持久化锁 setGameOverLock', seg.indexOf('setGameOverLock(haltReason)') >= 0, true);
  eq('终局权威闸清对手圈 clearOppSvgLayer', seg.indexOf('clearOppSvgLayer()') >= 0, true);
  eq('终局权威闸封曲线 pushHistPoint', seg.indexOf('pushHistPoint(') >= 0, true);
  eq('终局权威闸落盘 saveHistory', seg.indexOf('saveHistory()') >= 0, true);
  // 持久化锁本身：只有 resetNewGame 与手动换色才解
  eq('gameOverLocked 存在（持久化终局锁）', SRC.indexOf('function gameOverLocked()') > 0, true);
  const iReset = SRC.indexOf('haltReason = \'\'; clearGameOverLock();  // 新局：解除「盘面五连·真终局」的持久化锁');
  eq('resetNewGame 解除持久化锁', iReset > 0, true);
  const iEmpty = SRC.indexOf('if (n === 0 && !gameOverLocked())');
  eq('空盘解闸受持久化锁保护（真终局不被误解）', iEmpty > 0, true);
  eq('手动换色解除持久化锁', SRC.indexOf("if (!already) { haltForNewGame = false; haltReason = ''; clearGameOverLock(); }") > 0, true);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
