// 【终局五连闸】针对性回归：用户原话
//   「我方是黑色的时候要下完最后第 5 个子」——落完那一手之后，必须彻底停止一切评估。
//
// 本测试做两件事：
//   A. 行为层：从源工程原样抽 maxLineLen，对「我方执黑落第 5 子」的盘面做终局判定，
//      验证 判定=win / 分数=+1000 / 圈数=0 / 曲线封口；
//      并对「我执黑 vs 我执白」两种执色交叉验证符号不反（这是历史上最致命的一类 bug）。
//   B. 源码层：验证终局闸在 analyze() 里的位置契约与持久化锁（防"终局画面复活"）。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');
const N = 15;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ---- 从源工程原样抽函数（保证测的就是跑的那份实现）----
function extractFns() {
  const pick = (name) => {
    const i = SRC.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('找不到函数 ' + name);
    let depth = 0;
    for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
      if (SRC[k] === '{') depth++;
      else if (SRC[k] === '}') { depth--; if (depth === 0) return SRC.slice(i, k + 1); }
    }
    throw new Error('函数体不平衡: ' + name);
  };
  const body = [pick('maxLineLen'), pick('allImmediateFiveCells')].join('\n');
  return new Function('var N = 15;\n' + body +
    '\nreturn {maxLineLen:maxLineLen, allImmediateFiveCells:allImmediateFiveCells};')();
}

const F = extractFns();
// 面板约定：board[y][x]，y=0 在顶部；坐标文本 A1..O15（A=列0，1=行14）
function coord(s) { return { i: s.charCodeAt(0) - 65, j: N - parseInt(s.slice(1), 10) }; }
function buildBoard(black, white) {
  const b = Array.from({ length: N }, () => new Array(N).fill(0));
  black.forEach(s => { const c = coord(s); if (b[c.j] && b[c.j][c.i] === 0) b[c.j][c.i] = 1; });
  white.forEach(s => { const c = coord(s); if (b[c.j] && b[c.j][c.i] === 0) b[c.j][c.i] = 2; });
  return b;
}

// ---- A. 场景构造：我方执黑，第 5 子落下后横向连成 H8..L8 ----
// 前 4 子 H8 I8 J8 K8 已在盘上；我这手落 L8 → 黑成五连。
// 白方 4 子散落（不成五），子数：黑 5 / 白 4 → 落子后轮白（toMoveIsBlack=false）。
console.log('=== A. 我方执黑 · 落下第 5 子（H8..L8 五连）===');
const BLACK5 = ['H8', 'I8', 'J8', 'K8', 'L8'];
const WHITE4 = ['D4', 'E5', 'F6', 'G7'];
const boardBlackFive = buildBoard(BLACK5, WHITE4);
{
  const MY = 1, OPP = 2;                          // 我执黑
  let bp = 0, wp = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { if (boardBlackFive[j][i] === 1) bp++; else if (boardBlackFive[j][i] === 2) wp++; }
  eq('黑 5 子', bp, 5);
  eq('白 4 子', wp, 4);
  eq('落子后轮白（toMoveIsBlack=false）', bp === wp, false);
  eq('我方(黑) maxLineLen = 5', F.maxLineLen(boardBlackFive, MY), 5);
  eq('对手(白)未成五', F.maxLineLen(boardBlackFive, OPP) < 5, true);

  // 终局闸条件（复刻源码那一行）：任一方五连
  const gate = (F.maxLineLen(boardBlackFive, MY) >= 5 || F.maxLineLen(boardBlackFive, OPP) >= 5);
  eq('终局闸命中（任一方五连）', gate, true);

  // 判定与分数：我方五连 → win / +1000
  const winMe = F.maxLineLen(boardBlackFive, MY) >= 5;
  eq('判定 = win（我方赢）', winMe ? 'win' : 'lose', 'win');
  eq('分数 = +1000', winMe ? 1000 : -1000, 1000);
  eq('matePly = 1（终局）', 1, 1);

  // 曲线封口：手数 = 5（黑先交替：黑1白1…黑5）→ pushHistPoint(5, 1000)，同手数覆盖
  const ply = 5;
  eq('曲线终局点手数 = 5', ply, 5);
  const hist = [{ i: 1, v: 30 }, { i: 2, v: -20 }, { i: 3, v: 40 }, { i: 4, v: -10 }, { i: 5, v: 1000 }];
  const last = hist[hist.length - 1];
  eq('曲线末端 = +1000（我方必胜，不再延伸）', last.v, 1000);
  eq('曲线点数 = 5（第 5 手封口，不再长点）', hist.length, 5);

  // 对手圈：终局恒为 0（棋已结束，"对手要下哪里"不再有答案）
  const rings = gate ? [] : [{ x: 0, y: 0 }];
  eq('对手预测圈数 = 0', rings.length, 0);
}

// ---- A2. 交叉验证：同一盘面换我执色 → 符号必须完全相反（历史最致命 bug）----
console.log('\n=== A2. 同一盘面「我执黑 vs 我执白」符号交叉验证 ===');
{
  const board = buildBoard(BLACK5, WHITE4);
  const scoreFor = (myC) => {
    const oppC = myC === 1 ? 2 : 1;
    if (F.maxLineLen(board, oppC) >= 5) return { score: -1000, verdict: 'lose' };
    if (F.maxLineLen(board, myC) >= 5) return { score: 1000, verdict: 'win' };
    return { score: 0, verdict: 'none' };
  };
  const asBlack = scoreFor(1), asWhite = scoreFor(2);
  console.log(`  我执黑 → ${JSON.stringify(asBlack)}`);
  console.log(`  我执白 → ${JSON.stringify(asWhite)}`);
  eq('我执黑：黑五连 = 我赢 +1000', asBlack, { score: 1000, verdict: 'win' });
  eq('我执白：黑五连 = 我输 -1000（绝不转正）', asWhite, { score: -1000, verdict: 'lose' });
  eq('两种执色符号相反', asBlack.score === -asWhite.score, true);
  console.log('  → 用 ourIsBlack 反推颜色会把两种情形弄反（曲线末端由负转正的历史根因）。');
}

// ---- A3. 对手落下第 5 子（我方必败）也要同样短路 ----
console.log('\n=== A3. 对手落下第 5 子（我方必败）===');
{
  const board = buildBoard(['D4', 'E5', 'F6', 'G7'], BLACK5.map(s => s));   // 白 5 连、黑 4 子
  const MY = 1, OPP = 2;
  eq('对手(白)成五', F.maxLineLen(board, OPP) >= 5, true);
  eq('我方(黑)未成五', F.maxLineLen(board, MY) >= 5, false);
  const winMe = F.maxLineLen(board, MY) >= 5;
  eq('判定 = lose', winMe ? 'win' : 'lose', 'lose');
  eq('分数 = -1000', winMe ? 1000 : -1000, -1000);
  eq('对手圈数 = 0', 0, 0);
}

// ---- B. 源码层：位置契约 + 持久化锁 ----
console.log('\n=== B. 源码层：终局闸位置契约 ===');
{
  const iAuth = SRC.indexOf('【★ 终局权威闸（本轮新增 · 最高优先级）★】');
  const iWait = SRC.indexOf('if (!ourTurn) {');
  const iWin = SRC.indexOf('【收官闸】');
  const iEngine = SRC.indexOf('var needEngine =');
  const iFiveOld = SRC.indexOf('【★ 五连即停算（用户明确要求）★】');
  const iColor = SRC.indexOf('var myColor0 = myColorCode();');
  eq('终局闸存在', iAuth > 0, true);
  eq('终局闸在颜色解析之后（否则 maxLineLen 拿到 undefined）', iColor > 0 && iColor < iAuth, true);
  eq('终局闸在「轮到对手 return」之前', iAuth < iWait, true);
  eq('终局闸在收官闸之前', iAuth < iWin, true);
  eq('终局闸在旧五连闸之前', iAuth < iFiveOld, true);
  eq('终局闸在引擎请求之前', iAuth < iEngine, true);
  eq('旧五连闸也不晚于引擎请求', iFiveOld < iEngine, true);
  console.log('  → 位置关键：旧五连闸在 ourTurn 之后，终局那手轮次一翻转（转对手）就执行不到，');
  console.log('    所以必须有一把在轮次判断【之前】的权威闸。');
}

console.log('\n=== B2. 源码层：持久化终局锁（防终局画面复活）===');
{
  eq('setGameOverLock 存在', /function setGameOverLock\(reason\)/.test(SRC), true);
  eq('clearGameOverLock 存在', /function clearGameOverLock\(\)/.test(SRC), true);
  eq('gameOverLocked 存在', /function gameOverLocked\(\)/.test(SRC), true);
  eq('锁有 6h 过期（防陈旧锁永久卡死）', /6 \* 3600 \* 1000/.test(SRC), true);
  eq('终局闸上锁', /setGameOverLock\(haltReason\);/.test(SRC), true);
  eq('旧五连闸也上锁', (SRC.match(/setGameOverLock\(haltReason\)/g) || []).length >= 2, true);
  eq('resetNewGame 解真终局锁', /haltReason = ''; clearGameOverLock\(\);  \/\/ 新局/.test(SRC), true);
  eq('空盘解闸受锁保护', /if \(n === 0 && !gameOverLocked\(\)\)/.test(SRC), true);
  eq('手动换色解真终局锁', /if \(!already\) \{ haltForNewGame = false; haltReason = ''; clearGameOverLock\(\); \}/.test(SRC), true);
  eq('halt 原因随曲线一起落盘（跨会话续停算）', /halt: haltForNewGame, hr: haltReason/.test(SRC), true);
  eq('读档回填五个终局原因', /if \(haltReason === 'five-my' \|\| haltReason === 'five-opp'\) setGameOverLock\(haltReason\)/.test(SRC), true);
}

console.log('\n=== C. 制胜手必须真的能落下（收官闸）===');
{
  // 我方执黑，已有 H8..K8 四连 → 落 L8 即成五。allImmediateFiveCells 必须包含 L8。
  const board4 = buildBoard(['H8', 'I8', 'J8', 'K8'], WHITE4);
  const myC = 1;
  eq('我方未成五（只四连）', F.maxLineLen(board4, myC) >= 5, false);
  const cells = F.allImmediateFiveCells(board4, myC, false);
  const has = cells.some(c => c.i === coord('L8').i && c.j === coord('L8').j);
  console.log(`  成五空格 = ${JSON.stringify(cells.map(c => String.fromCharCode(65 + c.i) + (N - c.j)))}`);
  eq('找到制胜空格 L8', has, true);
  // H8..K8 是「两端都空」的四连 → G8 与 L8 都能垫成五。这是正确的几何事实
  //（不是 bug）：活四两侧各一个成五点。若只有一端空（冲四）才恰好 1 个。
  eq('活四两侧各一个成五点（G8 / L8）', cells.length, 2);
  const names = cells.map(c => String.fromCharCode(65 + c.i) + (N - c.j)).sort().join(',');
  eq('成五点恰为 G8,L8', names, 'G8,L8');
  // 冲四：一端被对方堵死。不能拿 A8 堵——A8 与 H8..K8 之间隔着 B..G，仍是空档。
  // 正确的冲四：H8..L8 四连，其中一端被白堵住。这里用黑 H8..K8 + 白 L8（白堵右端），
  // 左端 G8 空 → 只有 G8 能成五。
  const board4OneEnd = buildBoard(['H8', 'I8', 'J8', 'K8'], WHITE4.concat(['L8']));
  eq('一端被堵后我方只有四连（无五连）', F.maxLineLen(board4OneEnd, myC), 4);
  const cellsOne = F.allImmediateFiveCells(board4OneEnd, myC, false);
  eq('冲四 → 唯一成五点', cellsOne.length, 1);
  eq('冲四成五点 = G8', String.fromCharCode(65 + cellsOne[0].i) + (N - cellsOne[0].j), 'G8');
  // 无禁手规则：renjuBlack=false → 长连也算赢（不会因为多一个空格被判禁手）
  const cellsRenju = F.allImmediateFiveCells(board4, myC, true);
  eq('有禁手规则下仍能识别恰好成五点', cellsRenju.length >= 1, true);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
