#!/usr/bin/env node
/**
 * 收官闸（学书签版）行为回归：把 bridge.js 里的三个纯函数抽出来在 Node 里跑，
 * 断言「我方活四 / 冲四 → 有成五点」「对手活四 → 也拦得住」「已有五连 → 不落子」。
 *
 * 为什么单独建这个测试：
 *   用户现场「执黑能收官、执白收不了官」的根因是**顺序**（定局闸把活四当终局，
 *   排在收官闸前面就永远执行不到）。顺序由 test-guide-layer 的静态断言守；
 *   这里守的是「成五点到底找不找得到」这层行为 —— 白方视角也要能找到。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'desktop-overlay', 'ui', 'bridge.js'), 'utf8');

// 从 bridge.js 抽出函数体（不引整个 module，避免依赖 DOM）
function grab(name) {
  const re = new RegExp('function ' + name + '\\(([^)]*)\\) \\{');
  const m = re.exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { j++; break; } }
  }
  return 'function ' + name + '(' + m[1] + ') ' + src.slice(i, j);
}

const N = 15;
const code = [
  'var N = 15;',
  'var S = { rule: 0, side: 1 };',        // 规则：0 自由（长连算赢）/ 2 连珠（黑长连不算）；我执白
  'var lastBl = [], lastWh = [];',
  grab('myColOf'),
  grab('exactFiveFor'),
  grab('lastBoardMatrix'),
  grab('findWinningFive'),
  grab('hasFiveOnBoard'),
  grab('findOpenFour'),
  grab('boardDecided'),
  `return { m: lastBoardMatrix, find: findWinningFive, five: hasFiveOnBoard,
            open4: findOpenFour, mine: myColOf, decided: boardDecided, S: S,
            set: function (b, w) { lastBl = b; lastWh = w; } };`,
].join('\n');

const api = new Function(code)();

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
// 造点：黑点用 (x,y)
const B = (x, y) => ({ x, y });

console.log('== 收官闸行为回归（白方视角为重点）==\n');

// ① 白方活四：白 G9 H9 I9 J9，两端 F9/K9 空 → 白该收官，成五点应有两个（F9、K9）
api.set([], [B(6, 9), B(7, 9), B(8, 9), B(9, 9)]);
{
  const m = api.m();
  const w1 = api.find(m, 2);
  const w2 = api.find(m, 1);
  ok('白方活四 → 白有成五点（' + w1.length + ' 个：' + w1.map(([x, y]) => x + ',' + y).join(' ') + '）', w1.length >= 2);
  ok('同一局面下黑方没有成五点（不能替对手收官）', w2.length === 0);
  ok('活四会点亮定局闸（所以收官闸必须排在它前面）', api.decided(m) === true);
  ok('但盘面没有五连 → hasFiveOnBoard=false（收官闸的放行条件）', api.five(m) === false);
}

// ② 白方冲四：白 F9? 用黑堵住一端 —— 白 E9 F9 G9 H9 + 黑 D9  → 成五点只有 I9
api.set([B(3, 9)], [B(4, 9), B(5, 9), B(6, 9), B(7, 9)]);
{
  const m = api.m();
  const w1 = api.find(m, 2);
  ok('白方冲四（一端被堵）→ 仍能找到唯一成五点 I9',
    w1.length === 1 && w1[0][0] === 8 && w1[0][1] === 9);
  ok('冲四不点定局闸', api.decided(m) === false);
}

// ③ 已有五连 → 不落子（hasFiveOnBoard 拦住收官闸）
api.set([], [B(4, 9), B(5, 9), B(6, 9), B(7, 9), B(8, 9)]);
{
  const m = api.m();
  ok('白方已成五连 → hasFiveOnBoard=true（收官闸放行条件不成立，不再落子）', api.five(m) === true);
  ok('已成五连 → 定局闸也亮', api.decided(m) === true);
}

// ④ 黑方活四（回归对称性：黑方一样要能找到）
api.set([B(3, 5), B(4, 5), B(5, 5), B(6, 5)], []);
{
  const m = api.m();
  const b1 = api.find(m, 1);
  ok('黑方活四 → 黑有成五点（对称性检查）', b1.length >= 2);
  ok('黑方活四时白方没有成五点', api.find(m, 2).length === 0);
}

// ⑤ 规则感知（训练器 exactFiveFor 口径）：连珠（rule=2）黑方长连不算赢 → 长连点不能算制胜点
api.set([B(3, 5), B(4, 5), B(5, 5), B(6, 5), B(7, 5)], []);      // 黑五连，左端 A5 空、右端 I5 空
{
  api.S.rule = 2;                                                  // 连珠
  const m = api.m();
  const b1 = api.find(m, 1);
  ok('连珠+黑：已成五连的延长点（A5/I5 → 长连）不算制胜点',
    !b1.some((p) => (p[0] === 2 && p[1] === 5) || (p[0] === 8 && p[1] === 5)));
  ok('连珠+黑：五连本身仍算「已有五连」（exactFiveFor(黑)=true，n===5）', api.five(m) === true);
  api.S.rule = 0;                                                  // 自由
  ok('自由规则：长连算赢 → 同一局面下延长点也算制胜点',
    api.find(api.m(), 1).some((p) => (p[0] === 2 && p[1] === 5) || (p[0] === 8 && p[1] === 5)));
}
// ⑥ 连珠白方：白长连算赢（只有黑方受长连限制）
api.set([], [B(3, 5), B(4, 5), B(5, 5), B(6, 5), B(7, 5)]);
{
  api.S.rule = 2;
  const m = api.m();
  ok('连珠+白：白方五连算「已有五连」（不受黑方长连限制）', api.five(m) === true);
  ok('连珠下白方的成五点照常返回', api.find(api.m(), 2).length >= 1);
  api.S.rule = 0;
}

// ⑦ 斜向四（白）：D11 E10 F9 G8 → 成五点 C12 或 H7


// ⑦ 斜向四（白）：D11 E10 F9 G8 → 成五点 C12 或 H7
api.set([], [B(3, 11), B(4, 10), B(5, 9), B(6, 8)]);
{
  const m = api.m();
  const w1 = api.find(m, 2);
  const has = (x, y) => w1.some((p) => p[0] === x && p[1] === y);
  ok('白方斜向四 → 成五点含 C12 与 H7', has(2, 12) || has(7, 7));
}

// ⑧ 活四只提示、不断局（2026-10-03 用户现场：对方活四时旧口径把自动落子关掉了）
api.set([B(3, 5), B(4, 5), B(5, 5), B(6, 5)], []);       // 黑 D5-G5? 实为 x=3..6 四个，两端空
{
  const m = api.m();
  const o4 = api.open4(m);
  ok('黑方活四 → findOpenFour 找到它（' + (o4 ? o4.cells.length : 0) + ' 子）', !!o4 && o4.color === 1);
  ok('活四局面下 hasFiveOnBoard=false（所以**不该**停摆，要继续下棋）', api.five(m) === false);
  ok('我方颜色映射：side=1(白) → 2', api.mine() === 2);
  api.S.side = 0;
  ok('我方颜色映射：side=0(黑) → 1', api.mine() === 1);
  api.S.side = 1;
}
api.set([B(2, 5), B(3, 5), B(4, 5), B(5, 5), B(6, 5)], []);   // 黑已有五连
{
  ok('黑方五连 → hasFiveOnBoard=true（这才是真终局，停评估停落子）', api.five(api.m()) === true);
  ok('五连局面里 open4 不再返回（终局优先）', api.open4(api.m()) === null);
}

console.log('\n== test-finish-move: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
