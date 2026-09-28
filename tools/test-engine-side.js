/* 行棋方（side-to-move）真机回归 —— 十六轮「白子让着黑子去赢」的根因守卫。
 *
 * 判据：给某方摆一个**冲四**（只有一个成五点），引擎的 eval 符号直接暴露它认为轮到谁：
 *   · 轮到有四的一方 → +M1（自己能赢）      · 轮到对手 → -M…（要挡，且挡了也多半输）
 *
 * 必守的两条事实：
 *   ① 合法局面（bn=wn 或 bn=wn+1）下，旧口径（末子反色）与界面（总子数奇偶）本来就一致；
 *   ② 子数不均衡（残局自由摆盘 / 识图 VC 补充子，例 30 黑 + 10 白）时二者**相反** ——
 *      引擎按白方出着法，界面却把那手标成黑子。修法 = 调用方显式给 side，
 *      引擎侧重排 token 让末子颜色 = 3-side（engine-ai.js / engine-server.js 两处同款）。
 *
 * 跑法：node tools/test-engine-side.js（自己拉起一份引擎，GB_PORT=8977，线程 2 / 哈希 128MB）
 * ⚠️ 需要真实的 GomokuEngine.exe（engine-server/ 下）；属 LIVE 套件，离线跑不了。 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8977;
const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const SIZE = 15;

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' | ' + extra : '')); }
}
function mk() { const b = []; for (let y = 0; y < SIZE; y++) b.push(new Array(SIZE).fill(0)); return b; }
function pat(x, y) { return (((x + 2 * y) % 4) < 2) ? 1 : 2; }   // 四方向都不会连五的底纹
function count(b) { let a = 0, c = 0; for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { if (b[y][x] === 1) a++; else if (b[y][x] === 2) c++; } return [a, c]; }
function fill(b, wantB, wantW) {
  let nb = 0, nw = 0;
  const bl = [], wh = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x < SIZE; x++) { if (!b[y][x]) (pat(x, y) === 1 ? bl : wh).push([x, y]); }
  for (const p of bl) { if (nb >= wantB) break; b[p[1]][p[0]] = 1; nb++; }
  for (const p of wh) { if (nw >= wantW) break; b[p[1]][p[0]] = 2; nw++; }
  return b;
}
function post(obj) {
  return new Promise((resolve, reject) => {
    const d = Buffer.from(JSON.stringify(obj));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/analyze', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': d.length } }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))); } catch (e) { reject(new Error('bad json')); } });
    });
    req.on('error', reject);
    req.end(d);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ask(board, side, turnMs) {
  return post({ board: board, moveList: [], matchMs: 600000, turnMs: turnMs || 1500, timeUsedMs: 0,
    topN: 1, rule: 0, side: side || 0, cid: 'side-' + Math.random().toString(36).slice(2), lane: 'main' });
}
/** eval 是否「行棋方能赢」的记法（+M 开头） */
function isMateForMover(ev) { return /^\+?M\d+$/i.test(String(ev == null ? '' : ev).replace('+', '')) && String(ev).indexOf('-') !== 0; }

(async function main() {
  // 底盘：黑 (3..6,7) 冲四，白 (2,7) 堵左端 → 唯一成五点 (7,7)
  function base() { const b = mk(); for (let x = 3; x <= 6; x++) b[7][x] = 1; b[7][2] = 2; return b; }

  const log = fs.createWriteStream(path.join(__dirname, '_engine-side.log'));
  const proc = spawn(NODE, [path.join(ROOT, 'engine-server', 'engine-server.js'), '--as-backend'], {
    cwd: path.join(ROOT, 'engine-server'), windowsHide: true,
    env: Object.assign({}, process.env, { GB_PORT: String(PORT), GB_THREADS: '2', GB_HASH_MB: '128' }),
  });
  proc.stdout.on('data', (d) => log.write('[out] ' + d));
  proc.stderr.on('data', (d) => log.write('[err] ' + d));

  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { await ask(mk(), 0, 600); up = true; } catch (e) { await sleep(500); }
  }
  if (!up) { console.log('✗ 引擎没起来（engine-server/ 下有 GomokuEngine.exe 吗？）'); proc.kill(); log.end(); process.exit(1); }
  console.log('=== 行棋方（side-to-move）真机回归 ===');

  // ① 合法局面：不传 side 也该是黑走（+M1）
  const A = fill(base(), 0, 3);
  let r = await ask(A, 0);
  ok('合法盘 bn=4/wn=4：不指定 side → 黑走并看到杀', isMateForMover(r.candidates[0].eval),
     'eval=' + r.candidates[0].eval + ' best=' + JSON.stringify(r.best));

  // ② 不均衡盘面（残局/VC）：不传 side → 引擎站到对面（这是用户遇到的坑，负号即证据）
  const B = fill(base(), 26, 9);
  r = await ask(B, 0);
  ok('不均衡 bn=30/wn=10：不指定 side → 引擎按白走（历史 bug 现场）', !isMateForMover(r.candidates[0].eval),
     'eval=' + r.candidates[0].eval);

  // ③ 显式 side=1 → 立刻变回黑方杀（本轮修复的核心）
  r = await ask(B, 1);
  ok('不均衡盘 + side=1 → 引擎按黑走并看到杀', isMateForMover(r.candidates[0].eval),
     'eval=' + r.candidates[0].eval + ' best=' + JSON.stringify(r.best));

  // ④ 显式 side=2 → 仍是白方视角（负号）
  r = await ask(B, 2);
  ok('不均衡盘 + side=2 → 引擎按白走（负号）', !isMateForMover(r.candidates[0].eval),
     'eval=' + r.candidates[0].eval);

  // ⑤ 合法盘 + side=2 → 白方被迫挡冲四（负号，不是杀）
  r = await ask(A, 2);
  ok('合法盘 + side=2 → 白方视角（非 +M）', !isMateForMover(r.candidates[0].eval),
     'eval=' + r.candidates[0].eval);

  // ⑥ 落点正确：三种情况下唯一成五点都是 (7,7)
  const b1 = (await ask(A, 0)).best, b3 = (await ask(B, 1)).best, b5 = (await ask(A, 2)).best;
  ok('成五点坐标一致 = [7,7]（面板坐标 y=0 在顶）',
     [b1, b3, b5].every((p) => p && p[0] === 7 && p[1] === 7), JSON.stringify([b1, b3, b5]));

  console.log('\n== test-engine-side: ' + pass + ' passed, ' + fail + ' failed ==');
  proc.kill();
  log.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR ' + ((e && e.stack) || e)); process.exit(1); });
