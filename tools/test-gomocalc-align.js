// test-gomocalc-align.js — 回归护栏：确认「借鉴 gomocalc 的越界改动」已被回退
//
// 背景：曾尝试把 https://www.gomocalc.com/#/（dhbloo/gomoku-calculator）的两条逻辑搬进本项目：
//   ① 评估面板展示 WINRATE（S.winrate 胜率 surfacing）；
//   ② 稳定换局「前缀一致性」检测器 T3（prefixBreakStreak：已记录落子从盘面消失即判换局）。
// 实测引入两处副作用：T3 在识别偶发漏读一子时会【误触发新局重置】→ 坐标抖动 + 热力图候选被清空只剩两色。
// 用户明确要求「不要借助这个网站，恢复咱们之前的思路」。故这两条改动已回退，本测试改为护栏，
// 防止日后被误加回来。空盘监测(T1)/子数骤减(T2)/跨局几何稳定 等【非借鉴】的修复不在此列、仍在 test-cross-game.js。
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 1) 不应再存在 T3 前缀一致性检测器
ok('无 prefixBreakStreak 计数器', !SRC.includes('prefixBreakStreak'));
// 2) 不应再遍历 S.moves 判「落子消失即换局」
ok('无 T3 落子消失检测(resetNewGame 棋盘已换局)',
   !SRC.includes("resetNewGame(S.lang === 'en' ? 'board replaced' : '棋盘已换局')"));
// 3) 不应再有 winrate 胜率 surfacing
ok('无 S.winrate 胜率字段', !SRC.includes('S.winrate'));
ok('无处从 candidates[0].winrate 取原始胜率',
   !SRC.includes('var rawWr = (data.candidates[0] && data.candidates[0].winrate)'));
ok('状态栏无「我方胜率」展示', !SRC.includes("'WR' : '我方胜率'"));
// 4) 评估仍按「我方视角」显示（这是用户硬要求，非借鉴，必须保留）
ok('评估仍归一到我方视角(myEval)',
   SRC.includes('S.myEval = S.rawEval ? evalToMine(S.rawEval, myIsSideToMove) : ' + "''" + ';'));

console.log('\n== test-gomocalc-align(回归护栏): ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
