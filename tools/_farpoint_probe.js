#!/usr/bin/env node
/**
 * ★ 2026-10-01：**远点探测** —— 少子开局下，引擎的 best 会不会周期性落到离最近棋子 ≥3 格的远点？
 *
 * 背景：仓库里覆盖层面板已记录过同类 bug（落点 H11 这种离最近子 2~3 格的远点），
 *      修法是「近石守卫 autoAnchorPick」。但训练器 UI 的 aiMove() 只吃引擎 best + mustAnswer，
 *      **没有这道守卫**。本脚本就是要确认这道守卫对训练器是否同样必要。
 *
 * 命令序列**逐条对齐** engine-ai.js 的 doAnalyze：
 *   INFO THREAD_NUM(满核) → [PONDERING 1] → [HASH 独占] → RULE → TIMEOUT_TURN/MATCH/TIME_LEFT
 *   → YXBOARD … DONE → YXNBEST 1
 *
 * 用法：node tools/_farpoint_probe.js [每手毫秒=2000] [重复次数=12]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
const NEED = ['config.toml', 'mix9svqfreestyle_bsmix.bin.lz4', 'mix9svqstandard_bs15.bin.lz4',
  'mix9svqrenju_bs15_black.bin.lz4', 'mix9svqrenju_bs15_white.bin.lz4',
  'model210901.bin', 'model220723.bin'];
const TURN = +(process.argv[2] || 2000);
const REPS = +(process.argv[3] || 12);
const THREADS = (os.cpus() || []).length || 8;

const D = path.join(os.tmpdir(), 'gb-farpoint');
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
for (const f of NEED) fs.copyFileSync(path.join(REL, f), path.join(D, f));
fs.copyFileSync(path.join(REL, 'RapfiEngine-avx2.exe'), path.join(D, 'RapfiEngine-avx2.exe'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function open() {
  const c = spawn(path.join(D, 'RapfiEngine-avx2.exe'), [], { cwd: D, windowsHide: true });
  let buf = ''; const lines = [];
  c.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
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
  // ★ 与 doAnalyze 同形：RULE / TIMEOUT×3 / YXBOARD / YXNBEST 1（PONDERING 与 HASH 已在 boot 阶段给足）
  e.send(['INFO RULE 0', 'INFO TIMEOUT_TURN ' + TURN, 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', 'YXBOARD ' + (toks.length ? toks.join(' ') + ' ' : '') + 'DONE', 'YXNBEST 1']);
  let mv = null, ev = '', dep = '';
  while (Date.now() - t0 < TURN + 10000) {
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
  return { move: [x, 14 - y], eval: ev, depth: +dep || 0 };
}
const dist = (mv, st) => { if (!st.length) return 0; let b = 99; for (const s of st) b = Math.min(b, Math.max(Math.abs(mv[0] - s[0]), Math.abs(mv[1] - s[1]))); return b; };

(async () => {
  console.log('线程 ' + THREADS + '，每手 ' + TURN + 'ms，每局面重复 ' + REPS + ' 次\n');
  const e = open();
  e.send(['START 15']);
  await sleep(1800);
  e.send(['INFO THREAD_NUM ' + THREADS, 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100',
    'INFO SHOW_DETAIL 3', 'INFO PONDERING 1', 'INFO SWAPABLE 0', 'INFO HASH_SIZE 1048576']);
  await sleep(300);

  // 三个少子局面（都在开局早期）——每局面重复问 REPS 次，看 best 的分散程度
  const cases = [
    { name: '黑 H8 后轮白', line: [[7, 7, 1]], side: 2 },
    { name: '黑 H8 / 白 I9 后轮黑', line: [[7, 7, 1], [8, 6, 2]], side: 1 },
    { name: '黑 H8 / 白 I9 / 黑 G7 后轮白', line: [[7, 7, 1], [8, 6, 2], [6, 8, 1]], side: 2 },
  ];
  let farTotal = 0;
  for (const c of cases) {
    const stones = c.line.map(m => [m[0], m[1]]);
    const got = [];
    for (let i = 0; i < REPS; i++) {
      const r = await play(e, c.line, c.side);
      if (r.fail) { got.push({ mv: 'X', d: -1 }); continue; }
      const d = dist(r.move, stones);
      got.push({ mv: r.move.join(','), d: d, ev: r.eval, dep: r.depth });
      if (d > 2) farTotal++;
    }
    const ds = got.map(g => g.d).filter(d => d >= 0);
    const uniq = [...new Set(got.map(g => g.mv))];
    console.log('== ' + c.name + '  （最近棋子距离分布 ' + ds.join(',') + '）');
    console.log('   着法去重 ' + uniq.length + '/' + REPS + ' 种: ' + uniq.join('  '));
    const farOnes = got.filter(g => g.d > 2);
    if (farOnes.length) console.log('   ★ 远点(≥3) ' + farOnes.length + ' 次: ' + farOnes.map(f => f.mv + '(距' + f.d + ' ev=' + f.ev + ')').join(' '));
    const mateOnes = got.filter(g => g.ev && /M/.test(g.ev));
    if (mateOnes.length) console.log('   ★ 出现 M 评估 ' + mateOnes.length + ' 次: ' + mateOnes.map(f => f.ev + '@' + f.mv).join(' '));
  }
  console.log('\n===== 结论：远点(≥3格) 合计 ' + farTotal + ' / ' + (REPS * cases.length) + ' 次 =====');
  try { e.c.stdin.end(); } catch (x) {}
  await sleep(1500);
  try { e.c.kill('SIGKILL'); } catch (x) {}
  fs.rmSync(D, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
