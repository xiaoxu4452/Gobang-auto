#!/usr/bin/env node
/**
 * ★ 2026-10-01：**开局库（rapfi.db）是否在污染对局** —— 截图里「3 手棋的局面报 +M33 / 最佳点
 *   落在对手两子之间」只有一种不靠搜索的解释：引擎命中了数据库里的现成结论。
 *
 * 做法：拿截图那一局的确切局面（黑 H9/J9、白 E12，轮白走），分别用
 *   USEDATABASE 0（纯搜索）与 USEDATABASE 1（吃库）各搜一手，比对 着法 / 评估 / 深度；
 *   并直接把库里这条局面的记录（YXQUERYDATABASEALL）打出来看它写了什么。
 *
 * 用法：node tools/_db_influence.js [每手毫秒=2000]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const ENGINE_DIR = path.join(__dirname, '..', 'Meter GomokuTrainer', 'rapfi-native');
const ENGINE = path.join(ENGINE_DIR, 'RapfiEngine-avx2.exe');
const TURN_MS = +(process.argv[2] || 2000);

// 面板 0 基坐标：黑 H9=(7,6) 黑 J9=(9,6) 白 E12=(4,3)；轮白走（side=2）
const PREFIX = [[7, 6, 1], [4, 3, 2], [9, 6, 1]];
const SIDE = 2;

function openEngine() {
  const child = spawn(ENGINE, [], { cwd: ENGINE_DIR, windowsHide: true });
  let buf = ''; const lines = []; let waiter = null;
  child.stdout.on('data', d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (waiter) { const w = waiter; waiter = null; w(); }
    }
  });
  child.stderr.on('data', () => {});
  return {
    lines,
    send(c) { child.stdin.write(c.join('\n') + '\n'); },
    wait(re, ms) {
      const t0 = Date.now();
      return new Promise((res, rej) => {
        const scan = () => {
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].trim().match(re);
            if (m) { lines.splice(0, i + 1); return res(m); }
          }
          if (Date.now() - t0 > ms) return rej(new Error('timeout ' + re));
          waiter = scan;
        };
        scan();
      });
    },
    kill() { try { child.kill('SIGKILL'); } catch (e) {} },
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boardCmd() {
  const toks = PREFIX.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
  // 末 token 颜色应为 3-side（side=2 → 末子 1=黑）——已经是黑，无需重排
  return 'YXBOARD ' + toks.join(' ') + ' DONE';
}

async function run(db) {
  const eng = openEngine();
  eng.send(['START 15']);
  await sleep(1500);
  eng.send(['INFO THREAD_NUM 8', 'INFO HASH_SIZE 262144', 'INFO CAUTION_FACTOR 3',
    'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3', 'INFO SWAPABLE 0', 'INFO RULE 0',
    'INFO USEDATABASE ' + db]);
  await sleep(150);
  eng.lines.length = 0;
  eng.send(['INFO TIMEOUT_TURN ' + TURN_MS, 'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000', boardCmd(), 'YXNBEST 1']);
  const t0 = Date.now();
  let move = null, evals = [], depths = [];
  while (Date.now() - t0 < TURN_MS + 9000) {
    await sleep(50);
    for (const l of eng.lines.splice(0)) {
      const t = l.trim();
      if (/^\d+,\d+$/.test(t) && !move) move = t;
      const e = /Eval\s+(-?\d+|M\d+|\+M\d+|-\w?\d+)/i.exec(t); if (e) evals.push(e[1]);
      const d = /Depth\s+\d+/.exec(t); if (d) depths.push(d[0]);
    }
    if (move) break;
  }
  const lastEval = evals.length ? evals[evals.length - 1] : '(无)';
  const lastDepth = depths.length ? depths[depths.length - 1] : '(无)';
  // 库里这条局面写了什么
  eng.send([boardCmd(), 'YXQUERYDATABASEALL']);
  await sleep(1200);
  const dbLines = eng.lines.splice(0).map(s => s.trim()).filter(s => s && !/^\d+,\d+$/.test(s));
  eng.kill();
  return { db, move, lastEval, lastDepth, ms: Date.now() - t0, dbLines };
}

(async () => {
  console.log('局面：黑 H9(7,6) 黑 J9(9,6) 白 E12(4,3)，轮**白**走，' + TURN_MS + 'ms/手');
  for (const db of [0, 1]) {
    const r = await run(db);
    console.log('\n=== USEDATABASE ' + db + ' ===');
    console.log('  着法 = ' + r.move + '   末次评估 = ' + r.lastEval + '   ' + r.lastDepth + '   用时 ' + r.ms + 'ms');
    console.log('  库记录（YXQUERYDATABASEALL 前 12 行）:');
    r.dbLines.slice(0, 12).forEach(l => console.log('     ' + JSON.stringify(l)));
    if (!r.dbLines.length) console.log('     (空 —— 这个局面库里没有条目)');
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
