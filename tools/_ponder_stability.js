#!/usr/bin/env node
/**
 * ★ 2026-10-01：复现 / 定位「频繁切换黑白（AI 自打）→ 智力严重下降、黑白都严重下偏」。
 *
 * 假设：PONDERING 1（后台预思）是为「人的思考间隙」设计的；AI 自打时下一手 220ms 后就到，
 *   上一手的预思搜索要么刚起步、要么还在收尾，此时 YXBOARD 会改写棋盘并开新搜索 ——
 *   引擎侧 gomocup.cpp 派发只 stopThinking()、**不 waitForIdle()**，
 *   think() 的护栏又是 `if (ctx.inPonder)`（预思尚未登记就漏过）→
 *   新旧搜索可能重叠 / 上下文被覆盖 → 着法偏离 + 棋力剧烈波动。
 *
 * 做法（同一颗引擎、同一局面主线，**前缀对跑**）：
 *   ① 主线：从空盘起，每手新起一个干净进程单发（PONDERING 0）→ 得到一条「公认着法」主线；
 *   ② 对跑：一个常驻进程按主干前缀逐手请求（手间 gap 可调），PONDERING = 1 / 0 各跑一遍，
 *      把每一手的着法、用时与①的公认着法比对。
 *   ⇒ 若 PONDER=1 一侧偏离更多 / 用时被蚕食（下一手被预思收尾拖慢），假设成立。
 *
 * 用法：node tools/_ponder_stability.js [每手毫秒=1500] [gap毫秒=220] [手数=8]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', 'Meter GomokuTrainer', 'rapfi-native');
const ENGINE = path.join(ENGINE_DIR, process.env.PS_ENGINE || 'RapfiEngine-avx2.exe');
const TURN_MS = Math.max(1000, +process.argv[2] || 1500);
const GAP_MS = Math.max(0, +process.argv[3] || 220);
const PLIES = Math.max(4, +process.argv[4] || 8);
const THREADS = +process.env.PS_THREADS || 8;
const HASH_KB = +process.env.PS_HASHKB || 262144;
const STARTUP_MS = 1500;
const CFG = ['INFO THREAD_NUM ' + THREADS, 'INFO HASH_SIZE ' + HASH_KB,
             'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3',
             'INFO SWAPABLE 0', 'INFO USEDATABASE 0', 'INFO RULE 0'];

function openEngine() {
  const child = spawn(ENGINE, [], { cwd: ENGINE_DIR, windowsHide: true });
  let buf = ''; const lines = []; let waiter = null;
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (waiter) { const w = waiter; waiter = null; w(); }
    }
  });
  child.stderr.on('data', () => {});
  return {
    child, lines,
    send(cmds) { child.stdin.write(cmds.join('\n') + '\n'); },
    waitLine(re, timeoutMs) {
      const t0 = Date.now();
      return new Promise((resolve, reject) => {
        const scan = () => {
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].trim().match(re);
            if (m) { lines.splice(0, i + 1); return resolve(m); }
          }
          if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout ' + re));
          waiter = scan;
        };
        scan();
      });
    },
    drain() { const a = lines.slice(); lines.length = 0; return a; },
    kill() { try { child.kill('SIGKILL'); } catch (e) {} },
  };
}

/** 发一手（前缀 moves + 行棋方 side），返回 { move, ms }。 */
async function searchOnce(eng, prefix, side) {
  const toks = prefix.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
  const wantLast = 3 - side;
  if (toks.length && toks[toks.length - 1].split(',')[2] !== String(wantLast)) {
    for (let i = toks.length - 1; i >= 1; i--) {
      if (toks[i].split(',')[2] === String(wantLast)) { toks.push(toks.splice(i, 1)[0]); break; }
    }
  }
  const t0 = Date.now();
  eng.send(['INFO RULE 0', 'INFO TIMEOUT_TURN ' + TURN_MS, 'INFO TIMEOUT_MATCH 600000',
            'INFO TIME_LEFT 600000',
            'YXBOARD ' + (toks.length ? toks.join(' ') + ' ' : '') + 'DONE', 'YXNBEST 1']);
  const m = await eng.waitLine(/^(\d+),(\d+)$/, TURN_MS + 12000);
  return { move: [+m[1], 14 - (+m[2])], ms: Date.now() - t0 };
}

async function freshSearch(prefix, side) {
  const eng = openEngine();
  eng.send(['START 15']);
  await new Promise(r => setTimeout(r, STARTUP_MS));
  eng.send(CFG.concat(['INFO PONDERING 0']));
  await new Promise(r => setTimeout(r, 120));
  const r = await searchOnce(eng, prefix, side);
  eng.kill();
  return r;
}

(async function main() {
  console.log('引擎=' + path.basename(ENGINE) + ' 每手=' + TURN_MS + 'ms gap=' + GAP_MS + ' 手数=' + PLIES);
  // ① 主线：每手干净进程单发
  const line = [];   // [{x,y,c}]，c = 1/2
  const canon = [];
  console.log('\n① 主线（每手新进程单发，PONDERING 0）');
  for (let i = 0; i < PLIES; i++) {
    const side = (i % 2 === 0) ? 1 : 2;
    const r = await freshSearch(line, side);
    canon.push(r.move);
    line.push([r.move[0], r.move[1], side]);
    console.log('  ply' + i + ' 方' + side + ' → ' + r.move.join(',') + '  (' + r.ms + 'ms)');
  }
  const prefixAt = i => line.slice(0, i);   // 第 i 手之前的局面
  // ② 对跑
  for (const p of [1, 0]) {
    console.log('\n② 连打对跑 PONDERING ' + p + '（常驻进程，手间 ' + GAP_MS + 'ms）');
    const eng = openEngine();
    eng.send(['START 15']);
    await new Promise(r => setTimeout(r, STARTUP_MS));
    eng.send(CFG.concat(['INFO PONDERING ' + p]));
    await new Promise(r => setTimeout(r, 120));
    eng.drain();
    let bad = 0, slow = 0;
    for (let i = 0; i < PLIES; i++) {
      const side = (i % 2 === 0) ? 1 : 2;
      const r = await searchOnce(eng, prefixAt(i), side);
      const same = r.move[0] === canon[i][0] && r.move[1] === canon[i][1];
      if (!same) bad++;
      if (r.ms > TURN_MS + 120) slow++;
      console.log('  ply' + i + ' 方' + side + ' → ' + r.move.join(',') +
                  ' 主线=' + canon[i].join(',') + (same ? ' ✓' : ' ✗偏离') + '  (' + r.ms + 'ms)');
      if (i < PLIES - 1 && GAP_MS) await new Promise(res => setTimeout(res, GAP_MS));
    }
    eng.kill();
    console.log('  ⇒ 偏离 ' + bad + '/' + PLIES + '，超时收尾 ' + slow + '/' + PLIES);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
