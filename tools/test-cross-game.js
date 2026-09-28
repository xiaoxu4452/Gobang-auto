// test-cross-game.js — 跨局故障回归测试（源码契约）
// 复现：黑方(我方先手)下完制胜第5子那一刻，识别偶发「黑-白≠0/1」抖动 →
//   旧逻辑 stoneDiff 门控在「五连终局闸」「新局检测」之前 return →
//   ① 终局不被识别（仍评估 + 弹「棋盘子数异常」而非「我方五子连珠」）
//   ② 下一局 resetNewGame 永不触发 → 上一局状态残留 → 下一局乱下子
// 修复：新局检测提前到 stoneDiff 门之前；stoneDiff 门在「已五连」时让行(!fiveExists)。
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = (got === want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

// 1) fiveExists 必须由两种颜色分别检查盘面五连（与「我执」无关，终局是物理事实）
eq('fiveExists 由 maxLineLen(1)/maxLineLen(2) 判定',
   SRC.includes("var fiveExists = (maxLineLen(board, 1) >= 5 || maxLineLen(board, 2) >= 5);"), true);

// 2) 新局检测(emptyStreak/shrinkStreak → resetNewGame) 必须排在「棋盘子数异常」文案之前
const iNewGame = SRC.indexOf('emptyStreak++;');
const iAnomaly = SRC.indexOf('棋盘子数异常');
eq('新局检测位于「子数异常」门控之前', iNewGame > 0 && iNewGame < iAnomaly, true);

// 3) stoneDiff 门控在「已五连」时让行，交终局闸判定「我方五子连珠」
eq('stoneDiff 门控含 !fiveExists 让行',
   SRC.includes('if (n > 0 && stoneDiff !== 0 && stoneDiff !== 1 && !fiveExists) {'), true);

// 4) 五个关键锚点的相对顺序：fiveExists < 新局检测 < stoneDiff 门(!fiveExists) < 终局闸(五连)
const iFive = SRC.indexOf('var fiveExists');
const iGate = SRC.indexOf('if (n > 0 && stoneDiff !== 0 && stoneDiff !== 1 && !fiveExists)');
const iTerminal = SRC.indexOf('maxLineLen(board, myColor0) >= 5 || maxLineLen(board, oppColor0) >= 5');
eq('顺序: fiveExists < 新局检测 < stoneDiff门(!fiveExists) < 终局闸',
   iFive > 0 && iFive < iNewGame && iNewGame < iGate && iGate < iTerminal, true);

// 5) resetNewGame 实现仍存在且会解除终局锁（clearGameOverLock）
eq('resetNewGame 解除 gameOverLocked', SRC.includes('clearGameOverLock();  // 新局：解除'), true);

// 6) 新局开场：我执黑(先手)且空盘 → 落天元（用户要求「下一局在不在天元」）
eq('新局黑先手空盘落天元',
   SRC.includes('if (S.autoPlay && n === 0 && ourIsBlack && !haltForNewGame)'), true);

// 7) 空盘监测（用户要求：检测不到任何一个子 → 直接新开一局）：「有子→连续空盘」触发 resetNewGame
eq('空盘监测: n===0 → emptyStreak → resetNewGame',
   SRC.includes('if (emptyStreak >= 2) resetNewGame('), true);

// 7b) ★ 空盘连击必须跨帧存活：首空帧在帧底部会把 lastCount 清零，若条件只判 lastCount>0，
//     第二空帧恒走 else → emptyStreak 永远到不了 2 → resetNewGame 从不触发
//     （残留 +M3/推荐 H13/曲线 + gameOverLock 锁死天元首手，两症同源）。
//     正确契约：n===0 && (lastCount>0 || emptyStreak>0)；且旧坏条件不得再出现。
eq('空盘连击跨帧存活: (lastCount>0 || emptyStreak>0)',
   SRC.includes('if (n === 0 && (lastCount > 0 || emptyStreak > 0)) {'), true);
eq('旧坏条件(lastCount>0 单独判空)已消失',
   !SRC.includes('if (n === 0 && lastCount > 0) {'), true);

// 8) 空盘新局【保留稳定几何】：resetNewGame 不再清空 cachedBoard/screenBoard/lastGoodCal，
//    否则下一帧在空盘上重新校准易被纵向镜像/抖动带偏，开局首手点错（乱放位置）或被挡（卡死）。
eq('resetNewGame 不再清空稳定几何(跨局保留)',
   !SRC.includes('pyBoardCache = null; cachedBoard = null; screenBoard = null;'), true);
eq('resetNewGame 保留稳定几何注释',
   SRC.includes('跨局【保留稳定几何】'), true);

// 9) 空盘新局开局落子失败 → 带冷却重锚几何（防「什么都不发生」的卡死），而非静默 return
eq('空盘新局开局失败→重锚几何(防卡死)',
   SRC.includes('opening click failed -> re-anchor geometry'), true);

console.log('\n== test-cross-game: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
