#!/usr/bin/env node
/**
 * ★ 2026-10-01：**库污染实测** —— 同一开局连打两局，看第二局是否被库带偏。
 *
 * 三段：
 *   ① 基线线：每手新起进程、**关库**、2s 单发 → 得到「公认主线」+ 每手的正常评估/深度；
 *   ② 第 1 局：常驻进程 + **开库**（USEDATABASE 1，与 app 一致）按基线前缀逐手请求
 *      → 这一局会把记录写进库（含 mate 标签）；
 *   ③ 第 2 局：**同一个库**（已有一局记录）、同样前缀、同样 2s
 *      → 若第 2 局的评估突然变成 M 值 / 深度骤降 / 着法变了 ⇒ 库在带偏对局。
 *
 * 用法：node tools/_db_poison_e2e.js [每手毫秒=2000] [手数=8]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const TMP = path.join(os.tmpdir(), 'gb-selfplay-eng');
const ENGINE = path.join(TMP, 'RapfiEngine-avx2.exe');
const TURN = +(process.argv[2] || 2000);
const PLIES = +(process.argv[3] || 8);
const CFG = ['INFO THREAD_NUM 8', 'INFO HASH_SIZE 1048576', 'INFO CAUTION_FACTOR 3',
             'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3', 'INFO SWAPABLE 0', 'INFO RULE 0'];

function open() {
  const c = spawn(ENGINE, [], { cwd: TMP, windowsHide: true });
  let buf = ''; const lines = [];
  c.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  c.stderr.on('data', () => {});
  return { c, lines, send: a => c.stdin.write(a.join('\n') + '\n') };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanDb = () => { for (const f of ['rapfi.db', 'rapfi_bak1.db', 'rapfi_bak2.db']) { try { fs.unlinkSync(path.join(TMP, f)); } catch (e) {} } };

/** 一手：前缀 prefix=[[x,y,c]…]，行棋方 side。返回 {move(panel), eval, depth, ms} */
async function play(e, prefix, side) {
  const toks = prefix.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
  const want = 3 - side;
  if (toks.length && toks[toks.length - 1].split(',')[2] !== String(want)) {
    for (let i = toks.length - 1; i >= 1; i--) if (toks[i].split(',')[2] === String(want)) { toks.push(toks.splice(i, 1)[0]); break; }
  }
  e.lines.length = 0;
  const t0 = Date.now();
  e.send(['INFO TIMEOUT_TURN ' + TURN, 'INFO TIMEOUT_MATCH 600000', 'INFO TIME_LEFT 600000',
    'YXBOARD ' + (toks.length ? toks.join(' ') + ' ' : '') + 'DONE', 'YXNBEST 1']);
  let mv = null, ev = '', dep = '';
  while (Date.now() - t0 < TURN + 9000) {
    await sleep(50);
    for (const l of e.lines.splice(0)) {
      const t = l.trim();
      if (/^\d+,\d+$/.test(t) && !mv) mv = t;
      const m1 = /Eval\s+(-?M?\d+)/i.exec(t); if (m1) ev = m1[1];
      const m2 = /Depth\s+(\d+)/i.exec(t); if (m2) dep = m2[1];
    }
    if (mv) break;
  }
  const [x, y] = mv.split(',').map(Number);
  return { move: [x, 14 - y], eval: ev, depth: dep, ms: Date.now() - t0 };
}

async function boot(db) {
  const e = open();
  e.send(['START 15']); await sleep(1500);
  e.send(CFG.concat(['INFO USEDATABASE ' + db])); await sleep(150);
  return e;
}
/** ★ 关键：必须**优雅关闭**（关 stdin → 引擎 EOF 退出）才会触发 save_on_close 把库落盘；
 *  SIGKILL 杀进程 = 库永远不写盘（第一版实验就是这么白跑的）。 */
async function closeEng(e) {
  const dead = new Promise(r => e.c.on('exit', r));
  try { e.c.stdin.end(); } catch (x) {}
  await Promise.race([dead, sleep(8000)]);
  try { e.c.kill('SIGKILL'); } catch (x) {}
}

(async () => {
  console.log('每手 ' + TURN + 'ms，手数 ' + PLIES + '，库目录 ' + TMP + '\n');
  // ① 基线线（关库、每手新进程）
  cleanDb();
  console.log('① 基线（关库 / 每手新进程）');
  const line = [];
  for (let i = 0; i < PLIES; i++) {
    const side = (i % 2 === 0) ? 1 : 2;
    const e = await boot(0);
    const r = await play(e, line, side);
    await closeEng(e);
    line.push([r.move[0], r.move[1], side]);
    console.log('   ply' + i + ' 方' + side + ' → ' + r.move.join(',') + '  eval=' + r.eval + ' depth=' + r.depth);
  }
  const prefixAt = i => line.slice(0, i);
  // ②③ 连打两局（开库，同一份库）
  cleanDb();
  const runs = [];
  for (let round = 1; round <= 2; round++) {
    console.log('\n' + (round === 1 ? '②' : '③') + ' 第 ' + round + ' 局（开库 USEDATABASE 1' +
      (round === 2 ? '，库里已有第 1 局的记录' : '，库为空') + '）');
    const e = await boot(1);
    const out = [];
    for (let i = 0; i < PLIES; i++) {
      const side = (i % 2 === 0) ? 1 : 2;
      const r = await play(e, prefixAt(i), side);
      out.push(r);
      console.log('   ply' + i + ' 方' + side + ' → ' + r.move.join(',') + '  eval=' + r.eval +
        ' depth=' + r.depth + '  (' + r.ms + 'ms)  基线=' + line[i].slice(0, 2).join(',') +
        (r.move[0] === line[i][0] && r.move[1] === line[i][1] ? ' ✓' : ' ✗不同'));
    }
    await closeEng(e);
    runs.push(out);
  }
  console.log('\n===== 判定：第 2 局 vs 第 1 局 =====');
  let mateJump = 0, depthDrop = 0, moveChg = 0;
  for (let i = 0; i < PLIES; i++) {
    const a = runs[0][i], b = runs[1][i];
    const m1 = /^-?M\d/.test(a.eval), m2 = /^-?M\d/.test(b.eval);
    const d1 = +a.depth || 0, d2 = +b.depth || 0;
    const same = b.move[0] === a.move[0] && b.move[1] === a.move[1];
    if (m2 && !m1) mateJump++;
    if (d2 < d1 - 3) depthDrop++;
    if (!same) moveChg++;
    console.log('  ply' + i + '  第1局 eval=' + a.eval + ' depth=' + a.depth + '  →  第2局 eval=' + b.eval +
      ' depth=' + b.depth + (m2 && !m1 ? '   ★第2局突然变成 mate' : '') + (same ? '' : '   ★着法变了'));
  }
  console.log('\n  ⇒ 第 2 局新增 mate 评估: ' + mateJump + '/' + PLIES +
    '，深度骤降: ' + depthDrop + '/' + PLIES + '，着法改变: ' + moveChg + '/' + PLIES);
  console.log('  （第 2 局库大小 ' + (fs.existsSync(path.join(TMP, 'rapfi.db')) ? fs.statSync(path.join(TMP, 'rapfi.db')).size + 'B' : '无') + '）');
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
