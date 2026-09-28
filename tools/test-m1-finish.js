// test-m1-finish.js —— 「+M1 收官补完 / 补着」回归测试（源码契约）
// 用户要求：「我方先手的时候，到最后评估完成后，应额外自动下完最后一个子，
// 进行五子连珠（此过程不评估）」。
// 截图场景：黑 F13-G12-H11-I10 四连、白 34 堵一端 → 面板恒停「推荐 E14 +M1 已锁定」
// 却永不下最后一子 —— 根因是 M1 停算闸 halt 后所有落子链路被 !haltForNewGame 封死。
// 本测试钉死两层修法的位置与语义：
//   A) M1 停算闸内部：verdict==='win' && ourTurn 时先落制胜子（解 halt），失败才停算；
//   B) 收官闸之后、needEngine 之前：m1 停算状态的「补着」看门狗（全程不请求引擎）；
//   C) 两处落子都走 allImmediateFiveCells + 有禁手过滤 + 空格校验；
//   D) 解除 m1 停算后交由【终局权威闸】确认盘面五连（持久化锁 + 曲线封口）。
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function assert(cond, name) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }
function idx(s, from) { const v = src.indexOf(s, from || 0); return v; }

// ---- 关键锚点 ----
const iGate = idx('if (matePly === 1) {');                        // M1 停算闸
const iFinishInGate = idx('+M1 收官补完');                         // 闸内补完
const iShouGuan = idx('【收官闸】轮到我方');                        // 收官闸注释
const iWatchdog = idx('M1 收官补着');                              // 看门狗注释
const iNeedEngine = idx('var needEngine = !haltForNewGame');      // 引擎请求判定
const iAuthGate = idx('【★ 终局权威闸');                           // 终局权威闸注释

// ---- A) 位置契约 ----
assert(iGate > 0, 'A1 M1 停算闸存在');
assert(iFinishInGate > iGate, 'A2 闸内「+M1 收官补完」在 M1 停算闸内（之后）');
const iGateHalt = idx('haltReason = \'m1\';', iGate);
assert(iGateHalt > iFinishInGate, 'A3 闸内补完位于 halt(m1) 之前：先尝试落子，失败才停算');
assert(iShouGuan > 0 && iWatchdog > iShouGuan && iWatchdog < iNeedEngine,
  'A4 看门狗位于【收官闸】之后、needEngine 之前（halt 状态也每轮执行）');
assert(iAuthGate > 0 && iAuthGate < iWatchdog, 'A5 终局权威闸在最前（五连确认走持久化锁）');

// ---- B) 闸内补完语义 ----
{
  const seg = src.slice(iFinishInGate, iGateHalt);
  assert(seg.includes("verdict === 'win' && ourTurn"), 'B1 只在「我方必胜且轮到我方」时补完');
  assert(seg.includes('Date.now() >= autoHaltUntil'), 'B2 尊重 autoHaltUntil 节流');
  assert(seg.includes('maxLineLen(board, myColor0) < 5'), 'B3 盘面尚无我方五连才补完');
  assert(seg.includes('allImmediateFiveCells(board, myColor0'), 'B4 成五点由盘面自证（不依赖引擎 best）');
  assert(seg.includes('isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0)'), 'B5 有禁手规则下过滤禁手成五点');
  assert(seg.includes('m1WinCells[mw].i === data.best[0]'), 'B6 优先引擎推荐的制胜格');
  assert(seg.includes('playMove(cal, cv, m1Cell.i, m1Cell.j, myColor0)'), 'B7 落子用我方颜色码');
  assert(seg.includes('haltForNewGame = false; haltReason = \'\';'), 'B8 落子后解除 m1 停算（下一轮终局权威闸确认五连）');
  assert(seg.includes('不再评估'), 'B9 状态栏标明不再评估');
}

// ---- C) 看门狗语义（halt(m1) 冻结态的补着）----
{
  const seg = src.slice(iWatchdog, iNeedEngine);
  assert(seg.includes("haltForNewGame && haltReason === 'm1'"), 'C1 只处理 m1 停算冻结态');
  assert(seg.includes('!gameOverLocked()'), 'C2 真终局持久化锁不被看门狗解开');
  assert(seg.includes("S.verdict === 'win'"), 'C3 只补我方必胜（-M1 落败维持停算等新局）');
  assert(seg.includes('ourTurn'), 'C4 轮到我方才补着');
  assert(seg.includes('allImmediateFiveCells(board, myColor0'), 'C5 成五点盘面自证');
  assert(seg.includes('isForbiddenPoint'), 'C6 有禁手过滤');
  assert(seg.includes('playMove(cal, cv, m1w0.i, m1w0.j, myColor0)'), 'C7 补着落子');
  assert(seg.includes('haltForNewGame = false; haltReason = \'\';'), 'C8 解除 m1 停算');
  assert(!seg.includes('/api/analyze'), 'C9 全程不请求引擎（此过程不评估）');
}

// ---- D) 落败路径保持不变 ----
{
  const iGateHaltTrue = idx('haltForNewGame = true;', iFinishInGate);
  assert(iGateHaltTrue > iFinishInGate && iGateHaltTrue < iGateHalt, 'D1 落败/无法落子时仍置 haltForNewGame=true 等新局');
  const loseSeg = src.slice(iGateHaltTrue, idx('兜底：matePly>1 但盘面已经出现对方五连'));
  assert(loseSeg.includes('+M1'), 'D2 ±M1 状态栏文案保留');
}

console.log(`test-m1-finish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
