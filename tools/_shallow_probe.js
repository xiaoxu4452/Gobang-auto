#!/usr/bin/env node
/**
 * 极浅深度下，黑 H8 之后白方的 best 是什么？（验证「浅层 best = 下偏」）
 * 若 depth 1~4 里出现离天元 ≥3 格的远点（如 E11），则「App 误用实时最佳」这条链完全闭合。
 * 用法：node tools/_shallow_probe.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
const NEED = ['config.toml', 'mix9svqfreestyle_bsmix.bin.lz4', 'mix9svqstandard_bs15.bin.lz4',
  'mix9svqrenju_bs15_black.bin.lz4', 'mix9svqrenju_bs15_white.bin.lz4', 'model210901.bin', 'model220723.bin'];
const D = path.join(os.tmpdir(), 'gb-shallow');
fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
for (const f of NEED) fs.copyFileSync(path.join(REL, f), path.join(D, f));
fs.copyFileSync(path.join(REL, 'RapfiEngine-avx2.exe'), path.join(D, 'RapfiEngine-avx2.exe'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const X = 'ABCDEFGHIJKLMNO';
const nm = m => X[m[0]] + (15 - m[1]);
const c = spawn(path.join(D, 'RapfiEngine-avx2.exe'), [], { cwd: D, windowsHide: true });
let buf = ''; const lines = [];
c.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
c.stderr.on('data', () => {});

async function ask(maxDepth, prefixLabel) {
  lines.length = 0;
  c.stdin.write(['INFO RULE 0', 'INFO TIMEOUT_TURN 60000', 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', 'INFO MAX_DEPTH ' + maxDepth, 'YXBOARD 7,14,1 DONE', 'YXNBEST 1'].join('\n') + '\n');
  const t0 = Date.now(); let mv = null, ev = '';
  while (Date.now() - t0 < 30000) {
    await sleep(40);
    for (const l of lines.splice(0)) {
      const t = l.trim();
      if (/^\d+,\d+$/.test(t) && !mv) mv = t;
      const m = /Eval\s+(-?M?\d+)/i.exec(t); if (m) ev = m[1];
    }
    if (mv) break;
  }
  if (!mv) return null;
  const [x, y] = mv.split(',').map(Number);
  return { mv: [x, 14 - y], eval: ev };
}

(async () => {
  c.stdin.write('START 15\n'); await sleep(1800);
  c.stdin.write(['INFO THREAD_NUM 16', 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100',
    'INFO SHOW_DETAIL 3', 'INFO PONDERING 0', 'INFO SWAPABLE 0', 'INFO HASH_SIZE 1048576'].join('\n') + '\n');
  await sleep(300);
  console.log('局面：黑 H8（天元），轮白。看不同深度下 best 离天元多远（≥3 = 下偏）\n');
  for (const d of [1, 2, 3, 4, 6, 8, 12, 20]) {
    const r = await ask(d);
    if (!r) { console.log('  depth ' + String(d).padStart(2) + '  未出子'); continue; }
    const dist = Math.max(Math.abs(r.mv[0] - 7), Math.abs(r.mv[1] - 7));
    console.log('  depth ' + String(d).padStart(2) + '  → ' + nm(r.mv).padEnd(4) +
      ' 离天元 ' + dist + '  eval=' + r.eval + (dist >= 3 ? '   ★ 远点（=下偏）' : ''));
  }
  try { c.stdin.end(); } catch (x) {}
  await sleep(1200); try { c.kill('SIGKILL'); } catch (x) {}
  fs.rmSync(D, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
