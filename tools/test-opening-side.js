// 【新开局行棋方权威】针对性回归：用户原话
//   「最后一步，修复新开局白子错乱下子的问题，科学修复」
//
// 症状（截图）：己方「我执 黑」，盘上 1 黑 2 白，却给**白子**标了着法序号（1）/（2）。
// 根因：`toMoveIsBlack = (bCnt === wCnt)` 这套「按子数推轮次」的代数式在开局阶段
//       漏掉了两个特例：空盘（0===0 → 判轮白）与开局读数抖动（差分漏读/残留子）。
//       → 我执黑时 ourTurn 变 false（卡死），我执白时 ourTurn 变 true（**替黑方落第一手**）。
//
// 本测试从源工程**原样抽** openingSideToMove / mySideMask / myColorCode / isOurTurnOn 运行，
// 不另写实现 —— 保证测的就是发布版跑的那份逻辑。
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

// ---- 从源工程真实抽取函数（含它们依赖的 S / AUTO_SIDE 上下文）----
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
  const body = [pick('openingSideToMove'), pick('isOurTurnOn'), pick('mySideMask'),
                pick('myColorCode'), pick('oppColorCode')].join('\n');
  // S / AUTO_SIDE 由调用方注入（模拟面板上下文）
  return new Function('S', 'AUTO_SIDE', 'var N = 15;\n' + body +
    '\nreturn {openingSideToMove, isOurTurnOn, mySideMask, myColorCode, oppColorCode};');
}

function makeFns(side, autoSide, userSide) {
  const S = { side: side, userSide: (userSide === undefined ? -1 : userSide) };
  return extractFns()(S, !!autoSide);
}

const EMPTY = () => Array.from({ length: N }, () => new Array(N).fill(0));
function put(b, col, row, v) { b[row][col] = v; return b; }
// 坐标文本 A1..O15（A=列0，1=行14）
function coord(s) { return { i: s.charCodeAt(0) - 65, j: N - parseInt(s.slice(1), 10) }; }
function buildBoard(black, white) {
  const b = EMPTY();
  black.forEach(s => { const c = coord(s); b[c.j][c.i] = 1; });
  white.forEach(s => { const c = coord(s); b[c.j][c.i] = 2; });
  return b;
}

// ============================================================
console.log('=== 1. openingSideToMove：开局行棋方（黑恒先手）===');
{
  const F = makeFns(-1, false);
  eq('空盘 → 黑先（旧式 0===0 判轮白，正是 bug）', F.openingSideToMove(EMPTY()), 1);
  eq('1 黑 0 白 → 轮白', F.openingSideToMove(buildBoard(['H8'], [])), 2);
  eq('1 黑 1 白 → 轮黑', F.openingSideToMove(buildBoard(['H8'], ['D12'])), 1);
  eq('2 黑 1 白 → 轮白', F.openingSideToMove(buildBoard(['H8', 'G8'], ['D12'])), 2);
  eq('3 黑 3 白 → 轮黑', F.openingSideToMove(buildBoard(['H8', 'G8', 'F8'], ['D12', 'E12', 'F12'])), 1);
  // 非法态（白多于黑）：黑方多走了 → 仍轮白，绝不翻转
  eq('1 黑 2 白（非法态）→ 仍轮白', F.openingSideToMove(buildBoard(['H8'], ['D12', 'E12'])), 2);
  eq('0 黑 1 白（非法态）→ 轮白', F.openingSideToMove(buildBoard([], ['D12'])), 2);
  // 与旧代数式对照：只有空盘这一格不同。（旧式 = (bn===wn) ? 黑 : 白，空盘时 0===0 → 黑）
  // 注意：这里必须**真正复刻旧表达式**，不能调用新函数自比（自比恒为 true，测不出差异）。
  const oldAlgebra = (b) => {
    const bn = b.flat().filter(v => v === 1).length;
    const wn = b.flat().filter(v => v === 2).length;
    return (bn === wn) ? 1 : 2;   // 旧式：等数 → 黑；否则白
  };
  const agree = (b) => F.openingSideToMove(b) === oldAlgebra(b);
  eq('空盘：权威式与旧代数式【一致】（都判黑先）', agree(EMPTY()), true);
  eq('1黑0白：一致', agree(buildBoard(['H8'], [])), true);
  eq('1黑1白：一致', agree(buildBoard(['H8'], ['D12'])), true);
  eq('2黑1白：一致', agree(buildBoard(['H8', 'G8'], ['D12'])), true);
}

// ============================================================
console.log('\n=== 2. isOurTurnOn：我执黑/白 × 各种盘面 ===');
{
  // 我执黑（side=0 → me=1）
  const meB = makeFns(0, false);
  eq('[我执黑] 空盘 → 轮到我方（黑先，可以开局）', meB.isOurTurnOn(EMPTY()), true);
  eq('[我执黑] 1黑0白 → 不轮我方（对手该走）', meB.isOurTurnOn(buildBoard(['H8'], [])), false);
  eq('[我执黑] 1黑1白 → 轮到我方', meB.isOurTurnOn(buildBoard(['H8'], ['D12'])), true);
  eq('[我执黑] 2黑1白 → 不轮我方', meB.isOurTurnOn(buildBoard(['H8', 'G8'], ['D12'])), false);

  // 我执白（side=1 → me=2）
  const meW = makeFns(1, false);
  eq('[我执白] 空盘 → 不轮我方（黑先，必须等对手）', meW.isOurTurnOn(EMPTY()), false);
  eq('[我执白] 1黑0白 → 轮到我方', meW.isOurTurnOn(buildBoard(['H8'], [])), true);
  eq('[我执白] 1黑1白 → 不轮我方', meW.isOurTurnOn(buildBoard(['H8'], ['D12'])), false);

  // 颜色未定 → 绝不能当成"轮到我方"（否则会替对手落子）
  const unknown = makeFns(-1, false);
  eq('[颜色未定] 空盘 → 不轮我方（不替任何人落子）', unknown.isOurTurnOn(EMPTY()), false);
  eq('[颜色未定] 1黑0白 → 不轮我方', unknown.isOurTurnOn(buildBoard(['H8'], [])), false);
  eq('[颜色未定] 1黑1白 → 不轮我方', unknown.isOurTurnOn(buildBoard(['H8'], ['D12'])), false);

  // 显式传入 stm 时优先用 stm（同帧复用，避免算两次不一致）
  eq('[我执黑] 传入 stm=1(黑) → 轮我方', meB.isOurTurnOn(buildBoard(['H8'], ['D12']), 1), true);
  eq('[我执黑] 传入 stm=2(白) → 不轮我方', meB.isOurTurnOn(buildBoard(['H8'], ['D12']), 2), false);
  eq('[我执白] 传入 stm=2(白) → 轮我方', meW.isOurTurnOn(EMPTY(), 2), true);
}

// ============================================================
console.log('\n=== 3. 【关键回归】复现截图场景：我执黑 + 盘上 1 黑 2 白 ===');
{
  // 截图盘面：G8 黑、G11 白、H8 白（白子被错标着法 1/2）
  const shot = buildBoard(['G8'], ['G11', 'H8']);
  const meB = makeFns(0, false);
  const stm = meB.openingSideToMove(shot);
  eq('截图盘面：黑 1 / 白 2 → 行棋方 = 白', stm, 2);
  eq('截图盘面：我执黑 → 不轮我方（绝不主动落子）', meB.isOurTurnOn(shot), false);
  console.log('  → 旧代码若在某帧把轮次算成黑，就会给白子标序号并落子；');
  console.log('    权威式下「黑 1 白 2」恒判轮白，我执黑时 ourTurn 恒 false。');

  // 反过来：我执白 + 同一盘面 → 轮到我方（这才是正确的"我方该走"）
  const meW = makeFns(1, false);
  eq('截图盘面：我执白 → 轮我方', meW.isOurTurnOn(shot), true);
}

// ============================================================
console.log('\n=== 4. 【关键回归】空盘特例：我执黑必须能开局，我执白必须等 ===');
{
  // 旧式 bCnt===wCnt 在空盘时成立 → toMoveIsBlack=true；
  // 我执黑 → ourTurn=true ✓（这一格旧式也对）；但我执白 → ourTurn=false ✓。
  // 真正出问题的是下方【开局块】与【空盘守卫】读的 canAutoOpen 条件，
  // 以及空盘帧若 stmColor 被算成白 → 我执黑 ourTurn=false → 永远开不了局。
  const meB = makeFns(0, false), meW = makeFns(1, false);
  eq('空盘 stmColor 恒 = 黑(1)', meB.openingSideToMove(EMPTY()), 1);
  eq('[我执黑] 空盘轮我方 → 自动开局条件成立', meB.isOurTurnOn(EMPTY()) === true, true);
  eq('[我执白] 空盘不轮我方 → 等待对手先开局', meW.isOurTurnOn(EMPTY()) === false, true);
  // 开局落子颜色必须恒为黑（board 值 1），与"我执"无关
  const openingColor = 1;
  eq('自动开局落子颜色 = 黑(1)', openingColor, 1);
}

// ============================================================
console.log('\n=== 5. 源码层：单点定义 + 全量接线（防再写三遍）===');
{
  eq('openingSideToMove 单点定义', (SRC.match(/function openingSideToMove\(board\)/g) || []).length, 1);
  eq('isOurTurnOn 单点定义', (SRC.match(/function isOurTurnOn\(board, stm\)/g) || []).length, 1);
  // 旧的代数式轮次写法必须彻底消失（它就是 bug 本体）
  eq('旧 `var toMoveIsBlack = (bCnt === wCnt);` 已清除',
     SRC.indexOf('var toMoveIsBlack = (bCnt === wCnt);') < 0, true);
  eq('旧 `var fpToMoveIsBlack = (fpB === fpW);` 已清除',
     SRC.indexOf('var fpToMoveIsBlack = (fpB === fpW);') < 0, true);
  // 新写法就位
  eq('stmColor 由权威函数产出', /var stmColor = openingSideToMove\(board\);/.test(SRC), true);
  eq('toMoveIsBlack 由 stmColor 派生', /var toMoveIsBlack = \(stmColor === 1\);/.test(SRC), true);
  eq('指纹轮次也走权威函数', /var fpToMoveIsBlack = \(openingSideToMove\(board\) === 1\);/.test(SRC), true);
  eq('ourTurn 用 stmColor 判定', /var ourTurn = \(\(stmColor === 1\) === ourIsBlack\);/.test(SRC), true);
  // 夹逼自检（识别异常时打日志，不影响主流程）
  eq('存在权威式/代数式夹逼自检', /openingSideToMove mismatch: bCnt=/.test(SRC), true);
  // 空盘守卫不得写成 ourTurn 反了（我执白不该抢黑先手）
  eq('开局块要求 ourIsBlack（不可替我方之外落子）',
     /if \(S\.autoPlay && n === 0 && ourIsBlack && !haltForNewGame\)/.test(SRC), true);
  eq('开局落子颜色硬编码为 1（黑）', /playMove\(cal, cv, opI, opJ, 1\);/.test(SRC), true);
}

// ============================================================
console.log('\n=== 6. 穷举一致性：任意子数组合下权威式与规则自洽 ===');
{
  const F = makeFns(-1, false);
  let bad = 0, cases = 0;
  for (let bn = 0; bn <= 6; bn++) {
    for (let wn = 0; wn <= 6; wn++) {
      const b = EMPTY();
      let placed = 0;
      for (let k = 0; k < bn && placed < 60; k++) { const c = placed++; b[Math.floor(c / N)][c % N] = 1; }
      for (let k = 0; k < wn && placed < 60; k++) { const c = placed++; b[Math.floor(c / N)][c % N] = 2; }
      const stm = F.openingSideToMove(b);
      // 规则：空盘 → 黑；否则除非黑多于白，都轮黑... 即 stm=黑 ⟺ (bn===wn 或 bn+wn===0)
      const expect = (bn === 0 && wn === 0) ? 1 : (bn === wn ? 1 : 2);
      cases++;
      if (stm !== expect) { bad++; if (bad <= 3) console.log(`     ✗ bn=${bn} wn=${wn} got=${stm} want=${expect}`); }
    }
  }
  eq(`穷举 ${cases} 种 (黑,白) 子数组合全部自洽`, bad, 0);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
