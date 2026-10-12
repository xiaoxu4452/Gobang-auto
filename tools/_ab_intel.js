#!/usr/bin/env node
/**
 * ★ 2026-09-30 深夜：引擎智力 A/B 对跑（用户报「被五子棋计算器比下去，偏离官方」）。
 *
 * 同一颗引擎二进制 + 同一份 config.toml，两种调用序列、同一局面、同一时长各搜一手：
 *   A = 我们的序列（对齐 engine-ai.js doAnalyze 实发内容）：CAUTION_FACTOR 3 / STRENGTH 100 /
 *       SWAPABLE 0 / INFO 组 / YXBOARD(x,y,色) DONE / YXNBEST 1
 *   B = 官方朴素序列（官方整合包口径 = 只发线程/哈希/时间，其余全默认）
 *
 * 用法：node tools/_ab_intel.js [每手毫秒]   （默认 5000）
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..', 'Meter GomokuTrainer', 'rapfi-native');
const ENGINE = path.join(ENGINE_DIR, process.env.AB_ENGINE || 'RapfiEngine-avx2.exe');
const TURN_MS = Math.max(1000, (+process.argv[2] || 5000));
const THREADS = +process.env.AB_THREADS || 8;
const HASH_KB = +process.env.AB_HASHKB || 1048576;

// 0 基棋盘坐标 [x, y]（y 向下）。覆盖：空盘首手 / 早期 / 战术必应 / 中期白走。
const POSITIONS = [
  { name: 'P1-空盘首手(黑)', moves: [] },
  { name: 'P2-早期(黑走)',   moves: [[7,7],[8,8],[6,6],[9,9],[5,5]] },
  { name: 'P3-黑冲三(白应)', moves: [[7,7],[8,7],[7,8],[9,7],[7,9]] },
  { name: 'P4-中期(白走)',   moves: [[7,7],[8,8],[7,8],[8,7],[9,9],[6,8]] },
];

function seqOurs() {
  return [
    'INFO THREAD_NUM ' + THREADS,
    'INFO HASH_SIZE ' + HASH_KB,
    'INFO CAUTION_FACTOR 3',
    'INFO STRENGTH 100',
    'INFO SWAPABLE 0',
    'INFO RULE 0',
    'INFO TIMEOUT_TURN ' + TURN_MS,
    'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000',
  ];
}
function seqOfficial() {
  return [
    'INFO THREAD_NUM ' + THREADS,
    'INFO HASH_SIZE ' + HASH_KB,
    'INFO RULE 0',
    'INFO TIMEOUT_TURN ' + TURN_MS,
    'INFO TIMEOUT_MATCH 600000',
    'INFO TIME_LEFT 600000',
  ];
}

function probe(seq, moves) {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, [], { cwd: ENGINE_DIR, windowsHide: true });
    let buf = ''; const raw = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), TURN_MS + 5000);
    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) raw.push(line);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', () => { clearTimeout(timer); resolve(raw); });

    // YXBOARD 语法：x,y,色（1=黑 2=白），黑先交替；无子时仅 DONE。
    const toks = moves.map((m, i) => m[0] + ',' + m[1] + ',' + (i % 2 === 0 ? 1 : 2));
    const boardCmd = 'YXBOARD ' + toks.join(' ') + ' DONE';
    child.stdin.write('START 15\n');                 // ★ 先开局（漏了它 board=null 全盘报错）
    setTimeout(() => {
      child.stdin.write(seq.join('\n') + '\n');
      setTimeout(() => {
        child.stdin.write(boardCmd + '\nYXNBEST 1\n');
      }, 300);
    }, 1500);
  });
}

(async () => {
  console.log(`引擎=${path.basename(ENGINE)} 线程=${THREADS} 哈希=${(HASH_KB / 1024) | 0}MB 每手=${TURN_MS}ms 规则=free(0)\n`);
  for (const pos of POSITIONS) {
    for (const [label, seq] of [['A-我们', seqOurs()], ['B-官方', seqOfficial()]]) {
      const t0 = Date.now();
      const raw = await probe(seq, pos.moves);
      const tail = raw.filter(l => !/Load config|Evaluator set|Transposition/.test(l)).slice(-6);
      console.log(`[${pos.name}] ${label}  墙钟${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log('  ' + tail.join('\n  '));
    }
    console.log('');
  }
  process.exit(0);
})();
