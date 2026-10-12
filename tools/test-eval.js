'use strict';
// 收官闸（下完最后一个子）与评估曲线语义的针对性回归测试
// 从 bookmarklet.js 抠出真实源码函数执行，确保测的是发布出去的那份逻辑。
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

const N = 15;
// 抠出 evalToScore（含前面的注释块）与其依赖
const evalSrc = grab('function evalToScore(', '\n  }');
const fiveSrc = grab('function allImmediateFiveCells(', '\n  }');
const maxLenSrc = grab('function maxLineLen(', '\n  }');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL ' + name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

const ctx = new Function('N', '"use strict";var N; ' + evalSrc + fiveSrc + maxLenSrc +
  '; return {evalToScore:evalToScore, allImmediateFiveCells:allImmediateFiveCells, maxLineLen:maxLineLen};')(N);

console.log('=== 1. evalToScore：数值评估换到「我方视角」 ===');
// 轮我走：+500 → 我优 +500
eq('轮我走 +500', ctx.evalToScore('+500', true).score, 500);
// 轮对手走：引擎说 +500 是"对手优" → 我方视角必须为 -500
eq('轮对手走 +500 → 我 -500', ctx.evalToScore('+500', false).score, -500);
eq('轮对手走 -500 → 我 +500', ctx.evalToScore('-500', false).score, 500);
eq('轮我走 -500', ctx.evalToScore('-500', true).score, -500);
eq('0 恒为 0', ctx.evalToScore('0', false).score, 0);

console.log('=== 2. evalToScore：M/-M 杀棋判定 ===');
eq('轮我走 +M1 → win', ctx.evalToScore('+M1', true).verdict, 'win');
eq('轮我走 +M1 → +1000', ctx.evalToScore('+M1', true).score, 1000);
eq('轮我走 -M1 → lose', ctx.evalToScore('-M1', true).verdict, 'lose');
eq('轮对手走 +M1 → 对手赢=我 lose', ctx.evalToScore('+M1', false).verdict, 'lose');
eq('轮对手走 -M1 → 对手输=我 win', ctx.evalToScore('-M1', false).verdict, 'win');
eq('matePly 透传', ctx.evalToScore('+M5', true).matePly, 5);

console.log('=== 3. 收官闸：allImmediateFiveCells 能找出成五点 ===');
function empty() { const b = []; for (let j = 0; j < N; j++) b.push(new Array(N).fill(0)); return b; }
{
  // 白方（2）在 j=7 行 i=3..6 四连，i=2 与 i=7 都能成五
  const b = empty();
  for (let i = 3; i <= 6; i++) b[7][i] = 2;
  const cells = ctx.allImmediateFiveCells(b, 2, false);
  eq('找到 2 个成五点', cells.length, 2);
  const set = cells.map(c => c.i + ',' + c.j).sort().join(' | ');
  eq('成五点正确', set, '2,7 | 7,7');
}
{
  // 有禁手规则下黑方（1）已四连：i=2 与 i=7 成"恰好五" → 允许
  const b = empty();
  for (let i = 3; i <= 6; i++) b[7][i] = 1;
  const cells = ctx.allImmediateFiveCells(b, 1, true);
  eq('有禁手黑方恰好成五仍可落', cells.length >= 1, true);
}
{
  // 没有四连 → 无制胜手
  const b = empty();
  b[7][3] = 2; b[7][4] = 2; b[7][5] = 2;
  eq('三连时无制胜手', ctx.allImmediateFiveCells(b, 2, false).length, 0);
}

console.log('=== 4. maxLineLen 判定盘面五连 ===');
{
  const b = empty();
  for (let i = 0; i < 5; i++) b[7][i] = 2;
  eq('横向五连', ctx.maxLineLen(b, 2), 5);
  eq('对手无连', ctx.maxLineLen(b, 1), 0);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
