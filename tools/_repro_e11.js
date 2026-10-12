#!/usr/bin/env node
/**
 * ★ 决定性复现：用**用户自己那本被污染的 rapfi.db**（已改名为 rapfi.db.poisoned-bak），
 *   开库后问截图里那个局面 —— 若引擎吐出 E11 + M33（关库时是贴身的好手），
 *   则「白子下偏 + 假 mate」的根因**完全坐实**。
 *
 * 用法：node tools/_repro_e11.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
const POISONED = path.join(REL, 'rapfi.db.poisoned-bak');
const NEED = ['config.toml', 'mix9svqfreestyle_bsmix.bin.lz4', 'mix9svqstandard_bs15.bin.lz4',
  'mix9svqrenju_bs15_black.bin.lz4', 'mix9svqrenju_bs15_white.bin.lz4',
  'model210901.bin', 'model220723.bin'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function mkDir(tag) {
  const d = path.join(os.tmpdir(), 'gb-repro-' + tag);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of NEED) fs.copyFileSync(path.join(REL, f), path.join(d, f));
  fs.copyFileSync(path.join(REL, 'RapfiEngine-avx2.exe'), path.join(d, 'RapfiEngine-avx2.exe'));
  return d;
}
function open(d) {
  const c = spawn(path.join(d, 'RapfiEngine-avx2.exe'), [], { cwd: d, windowsHide: true });
  let buf = ''; const lines = [];
  c.stdout.on('data', x => { buf += x.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  c.stderr.on('data', () => {});
  return { c, lines, send: a => { try { c.stdin.write(a.join('\n') + '\n'); } catch (e) {} } };
}
async function play(e, prefix, side) {
  const toks = prefix.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
  const want = 3 - side;
  if (toks.length && toks[toks.length - 1].split(',')[2] !== String(want)) {
    for (let i = toks.length - 1; i >= 1; i--) if (toks[i].split(',')[2] === String(want)) { toks.push(toks.splice(i, 1)[0]); break; }
  }
  e.lines.length = 0;
  const t0 = Date.now();
  e.send(['INFO RULE 0', 'INFO TIMEOUT_TURN 2000', 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', 'YXBOARD ' + toks.join(' ') + ' DONE', 'YXNBEST 1']);
  let mv = null, ev = '', dep = '';
  while (Date.now() - t0 < 11000) {
    await sleep(40);
    for (const l of e.lines.splice(0)) {
      const t = l.trim();
      if (/^\d+,\d+$/.test(t) && !mv) mv = t;
      const m1 = /Eval\s+(-?M?\d+)/i.exec(t); if (m1) ev = m1[1];
      const m2 = /Depth\s+(\d+)/i.exec(t); if (m2) dep = m2[1];
    }
    if (mv) break;
  }
  if (!mv) return { fail: true };
  const [x, y] = mv.split(',').map(Number);
  return { mv: [x, 14 - y], eval: ev, depth: +dep || 0 };
}
const X = 'ABCDEFGHIJKLMNO';
const name = m => X[m[0]] + (15 - m[1]);

(async () => {
  if (!fs.existsSync(POISONED)) { console.log('找不到被污染的库：' + POISONED); process.exit(1); }
  const POS = [[7, 7, 1]];             // 黑 H8（截图第 1 手）
  const dist = m => Math.max(Math.abs(m[0] - 7), Math.abs(m[1] - 7));

  console.log('局面：黑 H8（天元），轮白 —— 截图中白子落在 E11（距 3 格）\n');

  for (const mode of ['关库', '开库(用你那本 rapfi.db.poisoned-bak)']) {
    const d = mkDir(mode === '关库' ? 'off' : 'on');
    if (mode !== '关库') fs.copyFileSync(POISONED, path.join(d, 'rapfi.db'));
    const e = open(d);
    e.send(['START 15']);
    await sleep(1800);
    e.send(['INFO THREAD_NUM 16', 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100',
      'INFO SHOW_DETAIL 3', 'INFO PONDERING 0', 'INFO SWAPABLE 0', 'INFO HASH_SIZE 1048576',
      'INFO USEDATABASE ' + (mode === '关库' ? '0' : '1')]);
    await sleep(400);
    const r = await play(e, POS, 2);
    console.log('  ' + mode.padEnd(38) + (r.fail ? '未出子' :
      ('着法 ' + name(r.mv) + '  离天元距离 ' + dist(r.mv) + '  评估 ' + r.eval + '  深度 ' + r.depth)));
    try { e.c.stdin.end(); } catch (x) {}
    await sleep(1200);
    try { e.c.kill('SIGKILL'); } catch (x) {}
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\n★ 若「开库」那一行给出 E11 / 距离 3 / 评估带 M，则截图的下偏与 +M33 完全由库标签造成。');
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
