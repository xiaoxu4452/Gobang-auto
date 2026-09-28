/* VCF / VCT 算杀器的「对齐 Rapfi 官方算法」行为回归（廿三轮，用户报「VCF/VCT 有一点小瑕疵」）。
 *
 * Rapfi 的 VCF / VCT 是**威胁空间搜索**，三条硬语义：
 *   ① 根节点必须是**轮进攻方行棋**（不合法的问法 = 进攻方连走两手的非法线）；
 *   ② 算杀线**颜色必须交替**（攻方 → 守方 → 攻方 …），且每一手都落在空点（不许叠子）；
 *   ③ VCF 里攻方每一手都必须是**冲四/活四**（成五点存在），守方每一手都是**被迫**的应手，
 *      末手攻方成五 —— 规则（连珠黑方长连 = 禁手，不算赢）必须被尊重。
 *
 * 事故现场（用户截图，像素级还原）：前瞻推演到第 9 手 F4（黑，成四），此时**轮到白方**、
 * 白方被逼在 F2 必应；旧版却在「黑刚落完 F4」时就跑算杀回探 → 得到 F2「黑方 1 手杀」，
 * 把白方的必应手当成黑方的杀着，棋盘上于是出现 **F4 黑 → F2 黑 两连手**。
 *
 * 跑法：node tools/test-vcx-rules.js（纯 JS，不需要引擎，秒级）
 * 说明：算杀器直接从 calc.js 里**切片求值**（与运行时同一份源码），校验器是本文件独立实现
 *      （不复用算杀器自己的函数，避免「用被检查者检查自己」）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIZE = 15;
const CALC = path.join(__dirname, '..', 'desktop-calculator', 'ui', 'calc.js');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' | ' + extra : '')); }
}

// ---------------------------------------------------------------- 加载算杀器（切片求值）
const src = fs.readFileSync(CALC, 'utf8');
const iStart = src.indexOf('var VCX_BUDGET = 600000;');
const iEnd = src.indexOf('/** 并行入口（二轮，用户要求）');
if (iStart < 0 || iEnd < 0 || iEnd <= iStart) {
  console.log('✗ 找不到算杀器代码段（calc.js 结构变了？）'); process.exit(1);
}
const chunk = src.slice(iStart, iEnd);
// 算杀器要按规则判「成五」（标准规则下长连不算赢）—— exactFiveFor 也切片求值，保证与主程序同一份规则表
const fnExact = /function exactFiveFor\(rule, moverColor\) \{[\s\S]*?\n\}/.exec(src);
if (!fnExact || src.split(fnExact[0]).length - 1 !== 1) {
  console.log('✗ exactFiveFor 切片失败/不唯一（calc.js 结构变了？）'); process.exit(1);
}
const HEAD = fnExact[0] + '\n';
const solver = new Function('N', HEAD + chunk + '\nreturn { vcxSolve: vcxSolve };')(SIZE);

// ---------------------------------------------------------------- 独立校验器（本文件实现）
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function mk() { const b = []; for (let y = 0; y < SIZE; y++) b.push(new Array(SIZE).fill(0)); return b; }
function clone(b) { return b.map((r) => r.slice()); }
/** 面板记法（列 A..O / 行 15..1）→ 内部 b[y][x]（y=0 在顶，与 calc.js 全盘一致）。 */
function pt(s) {
  const x = s.toUpperCase().charCodeAt(0) - 65;
  const row = parseInt(s.slice(1), 10);
  return { x: x, y: SIZE - row };
}
function put(b, list, c) { for (const s of list) { const p = pt(s); b[p.y][p.x] = c; } return b; }
function count(b) {
  let nb = 0, nw = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { if (b[y][x] === 1) nb++; else if (b[y][x] === 2) nw++; }
  return [nb, nw];
}
function sideToMove(b) { const t = count(b); return ((t[0] + t[1]) % 2 === 0) ? 1 : 2; }   // 黑先
/** 连子长度（假设 (x,y) 已经是 c）。 */
function runLen(b, x, y, c, d) {
  let n = 1;
  for (const s of [1, -1]) {
    for (let k = 1; k < SIZE; k++) {
      const nx = x + DIRS[d][0] * k * s, ny = y + DIRS[d][1] * k * s;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || b[ny][nx] !== c) break;
      n++;
    }
  }
  return n;
}
/** (x,y) 上已放好一方子 → 是否已成五（≥5，自由局口径）。 */
function stoneMakesFive(b, x, y, c) {
  for (let d = 0; d < 4; d++) if (runLen(b, x, y, c, d) >= 5) return true;
  return false;
}
/** 落 (x,y) 为 c 之后，能靠它成五的空点集合（=「四」的成五点）。0 个 = 不是冲四。 */
function winPointsOf(b, x, y, c) {
  if (b[y][x]) return [];
  b[y][x] = c;
  const set = new Set();
  for (let d = 0; d < 4; d++) {
    const dx = DIRS[d][0], dy = DIRS[d][1];
    for (let k = -4; k <= 0; k++) {
      const x0 = x + dx * k, y0 = y + dy * k, xe = x0 + dx * 4, ye = y0 + dy * 4;
      if (x0 < 0 || y0 < 0 || xe < 0 || ye < 0 || x0 >= SIZE || y0 >= SIZE || xe >= SIZE || ye >= SIZE) continue;
      let nC = 0, empty = -1, dead = false;
      for (let m = 0; m < 5; m++) {
        const v = b[y0 + dy * m][x0 + dx * m];
        if (v === c) nC++;
        else if (v === 0) { if (empty >= 0) { dead = true; break; } empty = (y0 + dy * m) * SIZE + (x0 + dx * m); }
        else { dead = true; break; }
      }
      if (dead) continue;
      if (nC === 4 && empty >= 0) set.add(empty);
    }
  }
  b[y][x] = 0;
  return Array.from(set);
}
/** 逐手复演一条算杀线，返回问题清单（空数组 = 合法）。kind='VCF' 时额外要求每手都是冲四且守方被迫。 */
function auditLine(b0, line, atk, kind) {
  const probs = [];
  if (!line || !line.length) return ['空线'];
  // ★ Rapfi 根条件：算杀只能在**进攻方行棋**的局面上起算（否则就是「攻方连走两手」的非法线）
  if (atk !== sideToMove(b0)) probs.push('根节点不是进攻方的回合（算杀只能由进攻方执子起算）');
  if (line[0].c !== atk) probs.push('第一手不是进攻方');
  const b = clone(b0);
  let expect = atk;
  for (let i = 0; i < line.length; i++) {
    const m = line[i];
    if (m.x < 0 || m.x >= SIZE || m.y < 0 || m.y >= SIZE) { probs.push('第' + (i + 1) + '手越界'); break; }
    if (m.c !== expect) probs.push('第' + (i + 1) + '手颜色不交替');
    expect = 3 - expect;
    if (b[m.y][m.x] !== 0) probs.push('第' + (i + 1) + '手落在非空点（叠子）');
    b[m.y][m.x] = m.c;
  }
  const last = line[line.length - 1];
  if (!stoneMakesFive(b, last.x, last.y, last.c)) probs.push('末手没有成五');
  if (last.c !== atk) probs.push('末手不是进攻方');
  for (let i = 0; i + 1 < line.length; i += 2) {                 // 攻方的每一手（末手除外）
    const m = line[i];
    const bb = clone(b0);
    for (let j = 0; j < i; j++) bb[line[j].y][line[j].x] = line[j].c;
    const wp = winPointsOf(bb, m.x, m.y, m.c);
    if (!wp.length) probs.push('第' + (i + 1) + '手不是冲四（无成五点）');
    if (kind === 'VCF' && wp.length === 1) {                     // 冲四 → 守方唯一应点，必须被写进线里
      const d = line[i + 1];
      if (!d) probs.push('第' + (i + 1) + '手后缺少守方应手');
      else if (d.c === m.c) probs.push('第' + (i + 2) + '手不是守方');
      else if (d.x !== (wp[0] % SIZE) || d.y !== Math.floor(wp[0] / SIZE)) {
        probs.push('守方没有落在唯一成五点（不是被迫应手）');
      }
    }
  }
  return probs;
}

// ---------------------------------------------------------------- 截图局面（像素级还原）
const BASE_B = ['D15', 'I15', 'M15', 'A14', 'I11', 'C10', 'M10', 'K9', 'F5', 'N3', 'A2', 'F1', 'L1'];
const BASE_W = ['B15', 'F15', 'L15', 'N15', 'J10', 'A8', 'G8', 'I6', 'K6', 'N6', 'C1', 'I1', 'N1'];
// 前瞻推演出的 9 手（界面上的编号 1..9）
const FWD = [['F3', 1], ['J6', 2], ['L6', 1], ['J8', 2], ['J7', 1], ['H7', 2], ['F9', 1], ['H8', 2], ['F4', 1]];

function shotBase() { const b = mk(); put(b, BASE_B, 1); put(b, BASE_W, 2); return b; }
function shotAfterFwd() { const b = shotBase(); for (const [s, c] of FWD) { const p = pt(s); b[p.y][p.x] = c; } return b; }

console.log('=== VCF / VCT 算杀器契约回归（对齐 Rapfi：根节点必须轮进攻方） ===');

// 0) 校验器自检（防止「校验器是瞎的」把整份测试变成假绿）
{
  const b = mk(); put(b, ['D15', 'I15', 'M15', 'A14', 'I11'], 1); put(b, ['B15', 'F15', 'L15'], 2);
  const bad1 = [{ x: 3, y: 14, c: 1 }, { x: 4, y: 14, c: 1 }];                    // 同色两连手
  const bad2 = [{ x: 3, y: 14, c: 1 }, { x: 3, y: 14, c: 2 }];                    // 叠子
  const bad3 = [{ x: 3, y: 14, c: 1 }, { x: 4, y: 14, c: 2 }, { x: 5, y: 14, c: 1 }]; // 末手不成五
  ok('校验器自检：能抓出「同色两连手」', auditLine(b, bad1, 1, 'VCF').some((s) => s.indexOf('不交替') >= 0));
  ok('校验器自检：能抓出「叠子」', auditLine(b, bad2, 1, 'VCF').some((s) => s.indexOf('叠子') >= 0));
  ok('校验器自检：能抓出「末手不成五」', auditLine(b, bad3, 1, 'VCF').some((s) => s.indexOf('末手没有成五') >= 0));
}

// 1) 截图局面
{
  const tb = count(shotBase());
  ok('截图局面还原：13 黑 + 13 白 = 26 子，轮黑（与界面一致）',
     tb[0] === 13 && tb[1] === 13 && sideToMove(shotBase()) === 1, 'bn=' + tb[0] + ' wn=' + tb[1]);
  const P2 = shotAfterFwd();
  const t2 = count(P2);
  ok('推演 9 手后 = 35 子（奇数）→ **轮到白方**', (t2[0] + t2[1]) === 35 && sideToMove(P2) === 2);

  // 独立复核事故现场：F4 成四后，F2 是黑方唯一的成五点 —— 所以白方必须去 F2 堵
  const bb = clone(P2);
  const f4 = pt('F4');
  bb[f4.y][f4.x] = 0;                                        // 先把 F4 拿掉，再问「落 F4 会造出哪些成五点」
  const wp = winPointsOf(bb, f4.x, f4.y, 1);
  ok('独立复核：F4 这一手是冲四，成五点 = F2（白方被迫应手）',
     wp.length === 1 && (wp[0] % SIZE) === pt('F2').x && Math.floor(wp[0] / SIZE) === pt('F2').y,
     'winPoints=' + JSON.stringify(wp.map((q) => [q % SIZE, Math.floor(q / SIZE)])));
  ok('独立复核：F2 落黑即五连（旧版就是把它当成「黑方 VCF 杀 1 手」）',
     (function () { const c = clone(P2); const p = pt('F2'); c[p.y][p.x] = 1; return stoneMakesFive(c, p.x, p.y, 1); })());

  // ★ 核心回归：这不是进攻方的回合 → 算杀器必须拒绝（旧版会给出 F2「1 手杀」）
  const rIllegal = solver.vcxSolve(clone(P2), 0, 'vcf', 1);
  ok('★ 轮白而问黑方 VCF → 必须 null（旧版给出 F2「1 手杀」＝攻方连走两手的非法线）',
     rIllegal === null, rIllegal ? 'line=' + JSON.stringify(rIllegal.line) : '');

  // 白方必应后（轮黑）→ 允许搜，且若有解必须合法
  const P2b = clone(P2); const bf = pt('F2'); P2b[bf.y][bf.x] = 2;
  ok('白方被迫在 F2 应手后 = 36 子 → 轮黑（回到进攻方回合）', sideToMove(P2b) === 1);
  const rLegal = solver.vcxSolve(clone(P2b), 0, 'vcf', 1);
  ok('轮黑问黑方 VCF：无解或合法线（不再出现同色两连手）',
     rLegal === null || auditLine(P2b, rLegal.line, 1, rLegal.kind).length === 0,
     rLegal ? 'line=' + rLegal.line.map((m) => 'ABCDEFGHIJKLMNO'[m.x] + (SIZE - m.y)).join(' ') : 'null');
  const rVct = solver.vcxSolve(clone(P2b), 0, 'vct', 1);
  ok('轮黑问黑方 VCT：无解或合法线',
     rVct === null || auditLine(P2b, rVct.line, 1, rVct.kind).length === 0,
     rVct ? 'kind=' + rVct.kind + ' n=' + rVct.line.length : 'null');
}

// 2) 反向守卫：轮黑而指定白方 → null
{
  const b = shotBase();
  ok('轮黑而问白方 → null（另一侧的守卫）', solver.vcxSolve(clone(b), 0, 'vcf', 2) === null);
}

// 3) 构造的合法 VCF：黑 6 子 / 白 2 子 = 8 → 轮黑；第 8 手 (8,5) 起活四，白堵一头、黑补另一头成五
{
  const b = mk();
  put(b, ['F6', 'G6', 'H6'], 1);              // 第 6 行三连（横向）
  put(b, ['I3', 'I4', 'I5'], 1);              // I 列三连（纵向）
  put(b, ['E6'], 2);                          // 白堵左侧
  put(b, ['A15'], 2);                         // 凑成偶数子 → 轮黑
  ok('构造局面：6 黑 + 2 白 = 8 子 → 轮黑', sideToMove(b) === 1);
  const r = solver.vcxSolve(clone(b), 0, 'vcf', 1);
  ok('构造局面：黑方有 VCF → 给出解', !!r && !!r.line);
  if (r) {
    const probs = auditLine(b, r.line, 1, r.kind);
    ok('★ 构造 VCF 的解合法（颜色交替 / 每手冲四 / 守方被迫 / 末手成五）', probs.length === 0,
       probs.length ? probs.join('；') : r.line.map((m) => 'ABCDEFGHIJKLMNO'[m.x] + (SIZE - m.y) + (m.c === 1 ? '黑' : '白')).join(' → '));
  } else {
    ok('★ 构造 VCF 的解合法（颜色交替 / 每手冲四 / 守方被迫 / 末手成五）', false, '没有解，无法校验');
  }
}

// 4) 构造的 VCT（活三起手）：解（若有）同样必须合法
{
  const b = mk();
  put(b, ['F6', 'G6', 'H6'], 1);              // 活三
  put(b, ['F4', 'F5'], 1);                    // F 列三连（与上一行共 F6）
  put(b, ['A15', 'B15'], 2);                  // 偶数子 → 轮黑
  ok('构造 VCT 局面：5 黑 + 2 白 = 7 子 → 轮白（先凑奇偶）', sideToMove(b) === 2);
  put(b, ['C15'], 2);                         // 再补 1 白 → 8 子，轮黑
  const r = solver.vcxSolve(clone(b), 0, 'vct', 1);
  ok('构造 VCT：给出解或明说无解', r === null || (r.kind === 'VCT' && r.line.length > 0));
  if (r) {
    const probs = auditLine(b, r.line, 1, r.kind);
    ok('★ 构造 VCT 的解合法（颜色交替 / 不叠子 / 末手进攻方成五）', probs.length === 0, probs.join('；'));
  } else {
    ok('★ 构造 VCT 的解合法（颜色交替 / 不叠子 / 末手进攻方成五）', true, '无解（照样守住了契约）');
  }
}

// 5) 规则对齐：只有「长连」才能成五的局面 —— 连珠黑方（rule 2）不算赢，自由局（rule 0）算赢
{
  const b = mk();
  put(b, ['E6', 'F6', 'G6', 'H6', 'J6'], 1);  // 黑：E~H 四连 + 隔一格 J（下 I6 会成 6 连长连）
  put(b, ['D6'], 2);                          // 白堵左端
  put(b, ['K6'], 2);                          // 白堵右端
  put(b, ['A15'], 2);                         // 偶数子 → 轮黑
  ok('长连局面：轮黑、唯一「成五」点是 I6（落下去其实是 6 连长连）', sideToMove(b) === 1);
  const free = solver.vcxSolve(clone(b), 0, 'vcf', 1);
  const renju = solver.vcxSolve(clone(b), 2, 'vcf', 1);
  ok('自由局（rule 0）：≥5 即胜 → 找到 I6 的「杀」', !!free && !!free.line,
     free ? free.line.map((m) => 'ABCDEFGHIJKLMNO'[m.x] + (SIZE - m.y)).join(' → ') : 'null');
  ok('★ 连珠（rule 2）：黑方长连 = 禁手 → 不算胜（不产出该线）', renju === null,
     renju ? 'line=' + JSON.stringify(renju.line) : '');
  // ★ 廿三轮：成五口径必须跟随规则 ——「标准」规则下长连同样不算赢（算杀器内部原来是自由局口径）
  const std = solver.vcxSolve(clone(b), 1, 'vcf', 1);
  ok('★ 标准（rule 1）：长连不算赢 → 同样不产出该线（成五口径跟着规则走）', std === null,
     std ? 'line=' + std.line.map((m) => 'ABCDEFGHIJKLMNO'[m.x] + (SIZE - m.y)).join(' → ') : '');
  const wb = mk();
  put(wb, ['E6', 'F6', 'G6', 'H6', 'J6'], 2);          // 白方同样的长连题面（E~H + J → 落 I6 是 6 连长连）
  put(wb, ['D6', 'K6', 'A15', 'B15'], 1);              // 黑方只做封口；4 黑 + 5 白 = 9 → 轮白（进攻方 = 白）
  ok('长连题面（白方进攻）：9 子 → 轮白', sideToMove(wb) === 2);
  ok('标准（rule 1）：白方长连同样不算赢（两色同口径）', solver.vcxSolve(clone(wb), 1, 'vcf', 2) === null);
  const wFree = solver.vcxSolve(clone(wb), 0, 'vcf', 2);
  ok('自由局（rule 0）：白方长连算赢 → 给出 I6', !!wFree && !!wFree.line &&
     wFree.line[0].x === pt('I6').x && wFree.line[0].y === pt('I6').y,
     wFree ? wFree.line.map((m) => 'ABCDEFGHIJKLMNO'[m.x] + (SIZE - m.y)).join(' → ') : 'null');
}

// 6) 反向证明（防「测试是空转」）：把入口守卫从源码里去掉 = 还原旧版行为 → 本回归必须报警
{
  const legacyChunk = chunk.replace('if (atkSel && atkSel !== toMove) return null;', '/* 旧版：无守卫 */');
  const legacy = new Function('N', HEAD + legacyChunk + '\nreturn { vcxSolve: vcxSolve };')(SIZE);
  const P2 = shotAfterFwd();
  const r = legacy.vcxSolve(clone(P2), 0, 'vcf', 1);
  const first = r && r.line && r.line[0];
  const probs = r ? auditLine(P2, r.line, 1, r.kind) : ['没有产出线'];
  ok('★ 反向证明：去掉守卫 = 旧版会给出「F2 黑」的非法线（复刻截图事故）',
     !!first && first.c === 1 && first.x === pt('F2').x && first.y === pt('F2').y,
     first ? 'line=' + r.line.map((m) => 'ABCDEFGHIJKLMNO'[m.x] + (SIZE - m.y) + (m.c === 1 ? '黑' : '白')).join(' → ') : 'null');
  ok('★ 反向证明：本文件的校验器会点名这条非法线（说明测试不是空转）',
     probs.length > 0, probs.join('；'));
}

// 7) 调用侧契约（静态）：算杀回探必须在「引擎取点之前」，且全文件只有一处
{
  const iProbe = src.indexOf('if (wantVcx && step > 0 && cc === atkFix)');
  const iEng = src.indexOf('r = await LocalAI.analyze({ board: b');
  const iPush = src.indexOf('G.fwd.line.push({ x: pick.x, y: pick.y, c: cc });');
  let nTry = 0, p = -1;
  while ((p = src.indexOf('fwdTryVcx(b, wantA, VCX_STEP_TIMEOUT)', p + 1)) >= 0) nTry++;
  const last = src.lastIndexOf('fwdTryVcx(b, wantA, VCX_STEP_TIMEOUT)');
  ok('静态契约：回探在「引擎取点」之前（旧版在落子之后 → 两连手事故）',
     iProbe > 0 && iProbe < iEng);
  ok('静态契约：全文件只有一处途中回探，且它不在落子之后',
     nTry === 1 && last < iPush,
     'nTry=' + nTry + ' probe@' + iProbe + ' push@' + iPush);
  ok('静态契约：两处入口都有「非进攻方回合 → 直接无解」的守卫',
     src.split('if (atkSel && atkSel !== toMove) return null;').length - 1 === 1 &&
     src.split('if (atkSel && atkSel !== toMove) { resolve(null); return; }').length - 1 === 1);
  // 项目老坑：Worker 注入列表少一个函数 → Worker 里 ReferenceError 被 try/catch 吞掉 →
  // 静默「无解」（表现为「点了 VCF/VCT 没反应」）。这里守着「定义 = 注入」。
  const defined = (chunk.match(/function (vcx[A-Za-z0-9_]+)\(/g) || []).map((s) => s.slice('function '.length, -1))
    .filter((n) => n !== 'vcxId' && n !== 'vcxSolve');            // 这两个只在主线程用（vcxSolve 是同步兜底入口）
  const injBlock = /\[(vcxAnalyze[\s\S]*?)\]\.map\(function \(f\) \{ return f\.toString\(\); \}\)/.exec(src);
  const injected = injBlock ? injBlock[1].split(',').map((s) => s.trim()) : [];
  const missing = defined.filter((n) => injected.indexOf(n) < 0);
  ok('静态契约：Worker 注入列表覆盖全部算杀器函数（漏一个 = 静默「无解」）',
     !!injBlock && defined.length >= 10 && missing.length === 0,
     missing.length ? '缺 ' + missing.join(',') : defined.length + ' 个函数全覆盖');
}

console.log('\n== test-vcx-rules: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
