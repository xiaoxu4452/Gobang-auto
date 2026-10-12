#!/usr/bin/env node
/**
 * ★ 2026-10-01：抓「一手返回之后」引擎还会吐什么行 —— 验证 ponder 残留输出污染下一手解析。
 * 做法：PONDERING 1 发一手 → 拿到着法行后**继续收集 2.5s 输出**，并把每一行拿去跑
 *       engine-ai.js 的完成判据（bare x,y / best x y / REJECT），看是否有行会把
 *       「下一手的等待」当场判成 done（= 下一手直接拿这一手的残留着法 → 下偏）。
 * 用法：node tools/_ponder_residue.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const ENGINE_DIR = path.join(__dirname, '..', 'Meter GomokuTrainer', 'rapfi-native');
const ENGINE = path.join(ENGINE_DIR, 'RapfiEngine-avx2.exe');
const TURN_MS = +(process.argv[2] || 1500);

const child = spawn(ENGINE, [], { cwd: ENGINE_DIR, windowsHide: true });
let buf = ''; const all = [];
child.stdout.on('data', d => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) { all.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
});
child.stderr.on('data', () => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  child.stdin.write('START 15\n');
  await sleep(1500);
  child.stdin.write(['INFO THREAD_NUM 8', 'INFO HASH_SIZE 262144', 'INFO CAUTION_FACTOR 3',
    'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3', 'INFO SWAPABLE 0', 'INFO USEDATABASE 0',
    'INFO RULE 0', 'INFO PONDERING 1'].join('\n') + '\n');
  await sleep(150);
  all.length = 0;
  child.stdin.write(['INFO TIMEOUT_TURN ' + TURN_MS, 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', 'YXBOARD 7,7,1 8,8,2 DONE', 'YXNBEST 1'].join('\n') + '\n');
  // 等着法行（bare x,y）
  let t0 = Date.now(), moveIdx = -1;
  while (Date.now() - t0 < TURN_MS + 8000) {
    moveIdx = all.findIndex(l => /^\d+,\d+$/.test(l.trim()));
    if (moveIdx >= 0) break;
    await sleep(30);
  }
  console.log('【着法行】index=' + moveIdx + ' 内容=' + JSON.stringify(all[moveIdx] && all[moveIdx].trim()));
  const after = all.length;
  await sleep(2500);          // 着法之后继续收 2.5 秒（预思期）
  const tail = all.slice(moveIdx + 1);
  console.log('【着法后新增行 ' + tail.length + ' 条】（若其中有行能当 done 判据 → 下一手会被污染）');
  const isDone = l => /^\d+,\d+$/.test(l.trim()) || /\bbest\s+\d+\s+\d+/.test(l) || /^\s*REJECT\s*$/.test(l);
  const heads = {};
  tail.forEach(l => {
    const h = (l.trim().split(/\s+/)[0] || '').slice(0, 24);
    heads[h] = (heads[h] || 0) + 1;
  });
  const doneLines = tail.filter(isDone);
  console.log('【行首分布】');
  Object.keys(heads).sort((a, b) => heads[b] - heads[a]).slice(0, 12)
    .forEach(h => console.log('   ' + h + ' × ' + heads[h]));
  console.log('【会被误判为 done 的行数】' + doneLines.length);
  doneLines.slice(0, 6).forEach(l => console.log('   !! ' + JSON.stringify(l.trim())));
  console.log('【样本 ≤ 8 条】');
  tail.slice(0, 8).forEach(l => console.log('   ' + JSON.stringify(l.trim())));
  child.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
