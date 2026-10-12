#!/usr/bin/env node
/**
 * ★ 2026-10-01：**ponder 中断吐行**探针。
 *
 * 疑点：AI 自打时下一手 220ms 就到，上一手的后台预思（PONDERING 1）被 INFO/YXBOARD 打断并
 *   停止；若引擎在「停止预思」这条路径上**又吐出一行着法**（或把预思的最佳点当作结果输出），
 *   而我们的 waitForMove 判据是「见到裸 x,y 就算 done」—— 那么这一手就会拿到
 *   **预思那条线里的着法**（为上一个局面/另一个视角算的）→ 用户看到的就是「严重下偏」。
 *
 * 做法：连发两手（手间 gap 可调），把「第一手着法行之后 ~ 第二手着法行」之间的所有输出逐行打出，
 *      并标注每行是否会被 engine-ai.js 的 done 判据命中。
 * 用法：node tools/_ponder_interrupt.js [每手毫秒=2000] [gap毫秒=220]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const ENGINE_DIR = path.join(__dirname, '..', 'Meter GomokuTrainer', 'rapfi-native');
const ENGINE = path.join(ENGINE_DIR, 'RapfiEngine-avx2.exe');
const TURN_MS = +(process.argv[2] || 2000);
const GAP_MS = +(process.argv[3] || 220);
const PONDER = process.argv[4] === undefined ? 1 : +process.argv[4];

const child = spawn(ENGINE, [], { cwd: ENGINE_DIR, windowsHide: true });
let buf = ''; const lines = [];
child.stdout.on('data', d => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) { lines.push({ t: Date.now(), s: buf.slice(0, i) }); buf = buf.slice(i + 1); }
});
child.stderr.on('data', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isMove = s => /^\d+,\d+$/.test(s.trim());
const isDone = s => isMove(s) || /\bbest\s+\d+\s+\d+/.test(s) || /^\s*REJECT\s*$/.test(s);

(async () => {
  child.stdin.write('START 15\n');
  await sleep(1500);
  child.stdin.write(['INFO THREAD_NUM 8', 'INFO HASH_SIZE 262144', 'INFO CAUTION_FACTOR 3',
    'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3', 'INFO SWAPABLE 0', 'INFO USEDATABASE 0',
    'INFO RULE 0', 'INFO PONDERING ' + PONDER].join('\n') + '\n');
  await sleep(150);

  // 第 1 手（黑，空盘）
  lines.length = 0;
  child.stdin.write(['INFO TIMEOUT_TURN ' + TURN_MS, 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', 'YXBOARD DONE', 'YXNBEST 1'].join('\n') + '\n');
  let t0 = Date.now();
  while (Date.now() - t0 < TURN_MS + 8000 && !lines.some(l => isMove(l.s))) await sleep(20);
  const mi1 = lines.findIndex(l => isMove(l.s));
  const mv1 = lines[mi1].s.trim();
  console.log('第1手（黑）= ' + mv1 + '（用时 ' + (lines[mi1].t - t0) + 'ms）');
  const tok1 = mv1.replace(',', ',').split(',');
  const seq1 = tok1[0] + ',' + tok1[1] + ',1';

  await sleep(GAP_MS);                       // 手间间隔（与 chainAiIfNeeded 的 220ms 同）
  const nBefore = lines.length;
  const tSend = Date.now();
  // 第 2 手（白）—— 与 app 同款命令批
  child.stdin.write(['INFO RULE 0', 'INFO TIMEOUT_TURN ' + TURN_MS, 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000',
    'YXBOARD ' + seq1 + ' DONE', 'YXNBEST 1'].join('\n') + '\n');
  t0 = Date.now();
  while (Date.now() - t0 < TURN_MS + 8000) {
    const hit = lines.slice(nBefore).findIndex(l => isMove(l.s));
    if (hit >= 0) { console.log('第2手（白）= ' + lines[nBefore + hit].s.trim() + '（用时 ' + (lines[nBefore + hit].t - tSend) + 'ms）'); break; }
    await sleep(20);
  }
  console.log('\n【第1手着法行 → 第2手着法行 之间的全部输出】（★ = 会被 done 判据命中）');
  const between = lines.slice(mi1 + 1, nBefore + (lines.slice(nBefore).findIndex(l => isMove(l.s)) + 1));
  between.forEach(l => console.log('   ' + (isDone(l.s) && !isMove(l.s) ? '★ ' : (isMove(l.s) ? '★着法行 ' : '')) +
    JSON.stringify(l.s.trim()) + '  [+' + (l.t - tSend) + 'ms]'));
  const spurious = between.filter((l, i) => isMove(l.s) && i < between.length - 1);
  console.log('\n⇒ 中间出现的「着法形状」行（除最后一条）：' + spurious.length +
              spurious.map(l => ' [' + l.s.trim() + ' @+' + (l.t - tSend) + 'ms]').join(''));
  child.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
