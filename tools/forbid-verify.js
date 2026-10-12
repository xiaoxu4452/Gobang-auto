/**
 * _forbid_verify.js —— 禁手判定「JS 移植版 vs Rapfi 引擎官方」全盘对拍。
 * 用法：node tools/_forbid_verify.js [局数]   （DBG_FORBID=1 打印每局 FORBID 原行）
 * 引擎口径 = gomocalc 红叉的数据源（YXSHOWFORBID → Board::checkForbiddenPoint）。
 * 要求：每一局全盘每个点的判定逐点一致，任何不一致都算失败。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'tools/rapfi-build/avx512/RapfiEngine-avx512.exe');
const CALC = path.join(ROOT, 'desktop-calculator/ui/calc.js');
const N = 15;

/* ---------- 1) 从 calc.js 抽出禁手判定实现（与 UI 同一份代码） ---------- */
const JS = fs.readFileSync(CALC, 'utf8');
const i0 = JS.indexOf('var VCX_PAT_DEAD = 0');
const iF = JS.indexOf('function vcxForbidden(b, x, y) {');
if (i0 < 0 || iF < 0) { console.error('calc.js 里找不到禁手实现'); process.exit(2); }
let d = 0, end = -1;
for (let k = JS.indexOf('{', iF); k < JS.length; k++) {
  if (JS[k] === '{') d++;
  else if (JS[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
}
if (end < 0) { console.error('vcxForbidden 花括号配平失败'); process.exit(2); }
const factory = new Function('N', JS.slice(i0, end) + '; return { vcxForbidden: vcxForbidden };');
const { vcxForbidden } = factory(N);

/* ---------- 2) 局面生成 ---------- */
function mk(pairs) {
  const b = Array.from({ length: N }, () => new Array(N).fill(0));
  pairs.forEach(([x, y, c]) => { b[y][x] = c; });
  return b;
}
// ★ 对拍约束：sideToMove 必须是黑（showForbid 只在轮黑时输出）→ 局面必须黑=白 或 黑=白-1。
//   黑多时贪心补「距盘上所有子 ≥5（无共 5 格窗）且互距 ≥5」的远处白子。
function balance(b) {
  let nb = 0, nw = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (b[y][x] === 1) nb++; else if (b[y][x] === 2) nw++;
  }
  const placed = [];
  const okSpot = (x, y) => {
    for (let yy = 0; yy < N; yy++) for (let xx = 0; xx < N; xx++)
      if (b[yy][xx] && Math.max(Math.abs(xx - x), Math.abs(yy - y)) < 5) return false;
    for (const [px, py] of placed)
      if (Math.max(Math.abs(px - x), Math.abs(py - y)) < 5) return false;
    return true;
  };
  while (nb > nw) {
    let done = false;
    for (let y = 0; y < N && !done; y++) for (let x = 0; x < N && !done; x++)
      if (!b[y][x] && okSpot(x, y)) { b[y][x] = 2; placed.push([x, y]); nw++; done = true; }
    if (!done) return null;                            // 配不平 → 调用方跳过
  }
  return b;
}
const crafted = [];
// 四三（合法）—— 用户截图那两个点（黑 9 白 8 → 补 1 白）
crafted.push(balance(mk([[4,5,1],[5,5,1],[4,6,1],[6,6,1],[7,6,1],[6,7,1],[4,8,1],[6,8,1],[8,8,1],
  [3,5,2],[7,5,2],[8,6,2],[4,7,2],[5,7,2],[7,7,2],[5,8,2],[4,9,2]])));
// 三三 / 四四 / 长连 / 成五 / 单活三（回归用例同款）
crafted.push(balance(mk([[5,7,1],[6,7,1],[7,5,1],[7,6,1]])));
crafted.push(balance(mk([[4,7,1],[5,7,1],[6,7,1],[7,4,1],[7,5,1],[7,6,1]])));
crafted.push(balance(mk([[4,7,1],[5,7,1],[6,7,1],[8,7,1],[9,7,1]])));
crafted.push(balance(mk([[5,7,1],[6,7,1],[8,7,1],[9,7,1]])));
crafted.push(balance(mk([[5,7,1],[6,7,1]])));
// 密集聚簇（黑 7 白 8 = 轮黑；容易撞出假三/递归复核路径）
crafted.push(mk([[6,6,1],[7,6,1],[8,6,1],[6,7,1],[8,7,1],[6,8,1],[7,8,1],
  [5,5,2],[9,5,2],[5,9,2],[9,9,2],[7,4,2],[4,7,2],[10,7,2],[7,10,2]]));
for (let i = crafted.length - 1; i >= 0; i--) if (!crafted[i]) crafted.splice(i, 1);

function randomGame() {
  const b = Array.from({ length: N }, () => new Array(N).fill(0));
  const stones = [];
  const nMoves = 4 + 2 * Math.floor(Math.random() * 14);      // 4..30 偶数 → 黑=白，轮黑
  const nearish = () => {
    if (!stones.length || Math.random() < 0.35) {
      const x = 2 + Math.floor(Math.random() * (N - 4));
      const y = 2 + Math.floor(Math.random() * (N - 4));
      return [x, y];
    }
    const [sx, sy] = stones[Math.floor(Math.random() * stones.length)];
    const x = Math.max(0, Math.min(N - 1, sx + Math.floor(Math.random() * 5) - 2));
    const y = Math.max(0, Math.min(N - 1, sy + Math.floor(Math.random() * 5) - 2));
    return [x, y];
  };
  for (let m = 0; m < nMoves; m++) {
    let x, y, tries = 0;
    do { [x, y] = nearish(); } while (b[y][x] && ++tries < 50);
    if (b[y][x]) continue;
    b[y][x] = (m % 2 === 0) ? 1 : 2;
    stones.push([x, y]);
  }
  return b;
}

/* ---------- 3) 引擎对话 ---------- */
const eng = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
eng.stderr.on('data', () => {});   // 引擎会往 stderr 噪，忽略
let outBuf = '';
let waiters = [];
eng.stdout.on('data', (chunk) => {
  outBuf += chunk.toString();
  let idx;
  while ((idx = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, idx);
    outBuf = outBuf.slice(idx + 1);
    waiters.forEach((w) => w(line));
  }
});
function send(cmd) { eng.stdin.write(cmd + '\n'); }
function waitFor(pred, ms) {
  return new Promise((resolve, reject) => {
    const w = (line) => { if (pred(line)) { cleanup(); resolve(line); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('engine timeout')); }, ms);
    function cleanup() { waiters = waiters.filter((x) => x !== w); clearTimeout(timer); }
    waiters.push(w);
  });
}

async function engineForbid(b) {
  // YXBOARD 严格黑白交替（黑=白），引擎 y=0 在底 → engineY = 14 - y
  const blacks = [], whites = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (b[y][x] === 1) blacks.push([x, y]);
    else if (b[y][x] === 2) whites.push([x, y]);
  }
  const toks = [];
  for (let i = 0; i < blacks.length; i++) {
    toks.push(blacks[i][0] + ',' + (N - 1 - blacks[i][1]) + ',1');
    if (whites[i]) toks.push(whites[i][0] + ',' + (N - 1 - whites[i][1]) + ',2');
  }
  send('YXBOARD ' + toks.join(' ') + ' DONE');
  send('YXSHOWFORBID');
  const line = await waitFor((l) => l.startsWith('FORBID'), 8000);
  if (process.env.DBG_FORBID) console.log('DBG ' + line.trim());
  const cells = line.slice(7).match(/.{4}/g) || [];
  return new Set(cells.map((s) => {
    const cx = +s.slice(0, 2), cy = +s.slice(2, 4);
    return cx + ',' + (N - 1 - cy);            // 翻回面板坐标
  }));
}

/* ---------- 4) 主流程 ---------- */
(async () => {
  send('START ' + N);
  await waitFor((l) => l.trim() === 'OK' || l.startsWith('='), 15000).catch(() => {});
  send('INFO RULE 2');
  await new Promise((r) => setTimeout(r, 200));

  const nRandom = parseInt(process.argv[2] || '300', 10);
  const games = [];
  crafted.forEach((b) => games.push({ b, tag: 'crafted' }));
  for (let i = 0; i < nRandom; i++) games.push({ b: randomGame(), tag: 'random' });

  let mismatch = 0, totalPts = 0, totalForbid = 0;
  for (let g = 0; g < games.length; g++) {
    const { b, tag } = games[g];
    const engSet = await engineForbid(b);
    const jsSet = new Set();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (b[y][x]) continue;
      totalPts++;
      if (vcxForbidden(b, x, y)) { jsSet.add(x + ',' + y); totalForbid++; }
    }
    const bad = [];
    for (const p of engSet) if (!jsSet.has(p)) bad.push('engine-only ' + p);
    for (const p of jsSet) if (!engSet.has(p)) bad.push('js-only ' + p);
    if (bad.length) {
      mismatch++;
      if (mismatch <= 5) {
        console.log('\n== 不一致 [' + tag + '] 局 #' + g + ' ==');
        for (const p of bad) console.log('  ' + p);
        let head = '    ';
        for (let x = 0; x < N; x++) head += (x % 10) + ' ';
        console.log(head);
        for (let y = 0; y < N; y++) {
          let row = ' ' + (y % 10) + '  ';
          for (let x = 0; x < N; x++) row += '.OX'[b[y][x]] + ' ';
          console.log(row);
        }
      }
    }
    if ((g + 1) % 100 === 0) console.log('  ...' + (g + 1) + '/' + games.length + ' 局已比');
  }
  console.log('\n== 对拍结果：' + games.length + ' 局 / ' + totalPts + ' 空点 / 禁手点 ' + totalForbid +
              ' 个，不一致 ' + mismatch + ' 局 ==');
  eng.kill();
  process.exit(mismatch ? 1 : 0);
})().catch((e) => { console.error(e); eng.kill(); process.exit(2); });
