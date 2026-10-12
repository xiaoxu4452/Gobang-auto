#!/usr/bin/env node
/**
 * 按截图的三步序列逐局面问引擎（开库 / 关库 对照），看哪一步冒出 M33 或远点。
 * 局面：P1 黑H8 → 轮白 ; P2 黑H8+白E11 → 轮黑 ; P3 +黑I9 → 轮白
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
const POISONED = path.join(REL, 'rapfi.db.poisoned-bak');
const NEED = ['config.toml', 'mix9svqfreestyle_bsmix.bin.lz4', 'mix9svqstandard_bs15.bin.lz4',
  'mix9svqrenju_bs15_black.bin.lz4', 'mix9svqrenju_bs15_white.bin.lz4', 'model210901.bin', 'model220723.bin'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const X = 'ABCDEFGHIJKLMNO';
const nm = m => X[m[0]] + (15 - m[1]);

function mkDir(tag, withDb) {
  const d = path.join(os.tmpdir(), 'gb-seq-' + tag);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of NEED) fs.copyFileSync(path.join(REL, f), path.join(d, f));
  fs.copyFileSync(path.join(REL, 'RapfiEngine-avx2.exe'), path.join(d, 'RapfiEngine-avx2.exe'));
  if (withDb) fs.copyFileSync(POISONED, path.join(d, 'rapfi.db'));
  return d;
}
function open(d) {
  const c = spawn(path.join(d, 'RapfiEngine-avx2.exe'), [], { cwd: d, windowsHide: true });
  let buf = ''; const lines = [];
  c.stdout.on('data', x => { buf += x.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  c.stderr.on('data', () => {});
  return { c, lines, send: a => { try { c.stdin.write(a.join('\n') + '\n'); } catch (e) {} } };
}
async function play(e, line, side) {
  const toks = line.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
  const want = 3 - side;
  if (toks.length && toks[toks.length - 1].split(',')[2] !== String(want)) {
    for (let i = toks.length - 1; i >= 1; i--) if (toks[i].split(',')[2] === String(want)) { toks.push(toks.splice(i, 1)[0]); break; }
  }
  e.lines.length = 0;
  const t0 = Date.now();
  e.send(['INFO RULE 0', 'INFO TIMEOUT_TURN 2000', 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', 'YXBOARD ' + toks.join(' ') + ' DONE', 'YXNBEST 1']);
  let mv = null, ev = '', dep = '', usedDb = false;
  while (Date.now() - t0 < 11000) {
    await sleep(40);
    for (const l of e.lines.splice(0)) {
      const t = l.trim();
      if (/USEDATABASE|DATABASE|yixindb/i.test(t)) usedDb = true;
      if (/^\d+,\d+$/.test(t) && !mv) mv = t;
      const m1 = /Eval\s+(-?M?\d+)/i.exec(t); if (m1) ev = m1[1];
      const m2 = /Depth\s+(\d+)/i.exec(t); if (m2) dep = m2[1];
    }
    if (mv) break;
  }
  if (!mv) return { fail: true, usedDb: usedDb };
  const [x, y] = mv.split(',').map(Number);
  return { mv: [x, 14 - y], eval: ev, depth: +dep || 0, usedDb: usedDb };
}

(async () => {
  const P = [
    { name: 'P1 黑H8 → 轮白（截图第2手）', line: [[7, 7, 1]], side: 2, ref: [4, 4] },
    { name: 'P2 黑H8+白E11 → 轮黑（截图第3手）', line: [[7, 7, 1], [4, 4, 2]], side: 1, ref: [8, 6] },
    { name: 'P3 +黑I9 → 轮白（截图当前）', line: [[7, 7, 1], [4, 4, 2], [8, 6, 1]], side: 2, ref: null },
  ];
  for (const withDb of [false, true]) {
    console.log('\n========== ' + (withDb ? '开库（用你那本 rapfi.db.poisoned-bak）' : '关库（当前发布口径）') + ' ==========');
    const d = mkDir(withDb ? 'on' : 'off', withDb);
    const e = open(d);
    e.send(['START 15']);
    await sleep(1800);
    e.send(['INFO THREAD_NUM 16', 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3',
      'INFO PONDERING 0', 'INFO SWAPABLE 0', 'INFO HASH_SIZE 1048576',
      'INFO USEDATABASE ' + (withDb ? '1' : '0')]);
    await sleep(400);
    for (const p of P) {
      const r = await play(e, p.line, p.side);
      const stones = p.line.map(m => [m[0], m[1]]);
      const dist = r.fail ? -1 : (stones.length ? Math.min.apply(null, stones.map(s => Math.max(Math.abs(r.mv[0] - s[0]), Math.abs(r.mv[1] - s[1])))) : 0);
      console.log('  ' + p.name);
      console.log('     → ' + (r.fail ? '未出子' : nm(r.mv) + '  离最近棋子 ' + dist + '  评估 ' + r.eval + '  深度 ' + r.depth) +
        (p.ref && !r.fail ? '   （截图里实际是 ' + nm(p.ref) + (r.mv[0] === p.ref[0] && r.mv[1] === p.ref[1] ? '  ✓命中' : '  ✗不同') + '）' : ''));
    }
    try { e.c.stdin.end(); } catch (x) {}
    await sleep(1500);
    try { e.c.kill('SIGKILL'); } catch (x) {}
    fs.rmSync(d, { recursive: true, force: true });
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
