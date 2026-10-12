#!/usr/bin/env node
/**
 * ★ 2026-10-01 修复验收（用户两个诉求，一次跑完）
 *
 *  A. 「频繁切换 AI 执黑/白 → 智力严重下降、着法严重下偏」是否已修？
 *     ★ 关键方法论：多线程(lazy SMP) + 限时搜索**本身就非确定性** —— 同一局面跑三次给出不同
 *       着法是正常的，**不能**拿它当「不稳定」的证据（第一版脚本就是这么误判的）。
 *       真正能证明「有状态污染」的是下面两条：
 *       ① **确定性基准**（固定深度 MAX_DEPTH + 单线程）：此时搜索是**位置的纯函数**，
 *          同一进程里连打 3 轮必须逐手完全一致 —— 不一致 ⇒ 有隐藏状态（曾经的元凶就是开局库）。
 *       ② **同一局面重复问**（真实口径：8 线程 + 2 秒，把每个局面插空问 3 次）：
 *          允许 SMP 抖动，但**不许**出现「这次是普通分、下次变成 M 值」的系统性跳变
 *          （这正是之前库污染的特征：−625 → −M42），也不许深度塌陷、不许下偏、不许不出子。
 *
 *  B. 「别的机器上用不了模型、一直下不了子」会不会复发？
 *     模拟**全新机器**：只拷发布目录 rapfi-native/ 的原样文件（**没有 rapfi.db**、没有历史），
 *     逐个 ISA 变体 boot + 出子；再测最坏情况（手动开库 + 只读 + 库文件缺失）不崩。
 *
 * 用法：node tools/_fix_verify.js [每手毫秒=2000] [手数=8]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
const NEED = ['config.toml', 'mix9svqfreestyle_bsmix.bin.lz4', 'mix9svqstandard_bs15.bin.lz4',
  'mix9svqrenju_bs15_black.bin.lz4', 'mix9svqrenju_bs15_white.bin.lz4',
  'model210901.bin', 'model220723.bin'];
const VARIANTS = ['avx512vnni', 'avxvnni', 'avx512', 'avx2', 'sse'];
const TURN = +(process.argv[2] || 2000);
const PLIES = +(process.argv[3] || 8);

// ★ 与 app 完全一致的 boot 配置（engine-ai.js bootAll）：**不带**启用开局库的那条 INFO
const CFG = ['INFO THREAD_NUM 8', 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100',
  'INFO SHOW_DETAIL 3', 'INFO PONDERING 0', 'INFO SWAPABLE 0', 'INFO HASH_SIZE 1048576'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) fails++;
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + msg + (extra ? '  | ' + extra : ''));
};

/** 建一个「全新机器」目录：只放发布文件，绝不留下 rapfi.db */
function freshDir(tag, variant) {
  const d = path.join(os.tmpdir(), 'gb-fixverify-' + tag + '-' + variant);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of NEED) fs.copyFileSync(path.join(REL, f), path.join(d, f));
  fs.copyFileSync(path.join(REL, 'RapfiEngine-' + variant + '.exe'), path.join(d, 'RapfiEngine-' + variant + '.exe'));
  for (const f of fs.readdirSync(d)) if (/\.db$/i.test(f)) fs.unlinkSync(path.join(d, f));
  return d;
}

function open(dir, variant) {
  const c = spawn(path.join(dir, 'RapfiEngine-' + variant + '.exe'), [], { cwd: dir, windowsHide: true });
  let buf = ''; const lines = [];
  c.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  c.stderr.on('data', d => { lines.push('!STDERR ' + d.toString()); });
  return { c, lines, dir, dead: false, send: a => { try { c.stdin.write(a.join('\n') + '\n'); } catch (e) {} } };
}

/** 一手。side=1 黑 / 2 白；prefix=[[x,y,color]…]（y 为 UI 行号 0..14） */
async function play(e, prefix, side, opt) {
  opt = opt || {};
  const toks = prefix.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
  const want = 3 - side;
  if (toks.length && toks[toks.length - 1].split(',')[2] !== String(want)) {
    for (let i = toks.length - 1; i >= 1; i--) if (toks[i].split(',')[2] === String(want)) { toks.push(toks.splice(i, 1)[0]); break; }
  }
  e.lines.length = 0;
  const t0 = Date.now();
  const head = ['INFO TIMEOUT_TURN ' + (opt.turn || TURN), 'INFO TIMEOUT_MATCH 600000', 'INFO TIME_LEFT 600000']
    .concat(opt.maxDepth ? ['INFO MAX_DEPTH ' + opt.maxDepth] : []);
  e.send(head.concat(['YXBOARD ' + (toks.length ? toks.join(' ') + ' ' : '') + 'DONE', 'YXNBEST 1']));
  let mv = null, ev = '', dep = '';
  const cap = (opt.maxDepth ? 60000 : TURN + 12000);
  while (Date.now() - t0 < cap) {
    await sleep(50);
    for (const l of e.lines.splice(0)) {
      const t = l.trim();
      if (/^\d+,\d+$/.test(t) && !mv) mv = t;
      const m1 = /Eval\s+(-?M?\d+)/i.exec(t); if (m1) ev = m1[1];
      const m2 = /Depth\s+(\d+)/i.exec(t); if (m2) dep = m2[1];
    }
    if (mv) break;
    if (e.dead) break;
  }
  if (!mv) return { fail: true, eval: ev, depth: dep, ms: Date.now() - t0 };
  const [x, y] = mv.split(',').map(Number);
  return { move: [x, 14 - y], eval: ev, depth: +dep || 0, ms: Date.now() - t0 };
}

/** 落点与已有棋子的切比雪夫距离（五子棋的着子必在战场内） */
function distToStones(mv, stones) {
  if (!stones.length) return 0;
  let best = 99;
  for (const s of stones) best = Math.min(best, Math.max(Math.abs(mv[0] - s[0]), Math.abs(mv[1] - s[1])));
  return best;
}

async function boot(dir, variant, extra) {
  const e = open(dir, variant);
  e.c.on('exit', () => { e.dead = true; });
  e.send(['START 15']);
  await sleep(1800);
  e.send((extra || CFG));
  await sleep(250);
  return e;
}
async function closeEng(e) {
  const dead = new Promise(r => e.c.on('exit', r));
  try { e.c.stdin.end(); } catch (x) {}
  await Promise.race([dead, sleep(6000)]);
  try { e.c.kill('SIGKILL'); } catch (x) {}
}

(async () => {
  console.log('每手 ' + TURN + 'ms，手数 ' + PLIES + '，引擎源 ' + REL + '\n');

  // ============ A1. 确定性基准：固定深度 + 单线程 ⇒ 搜索是位置的纯函数 ============
  console.log('===== A1. 确定性基准（MAX_DEPTH 12 + 单线程，同一进程连打 3 轮）=====');
  const dirA1 = freshDir('det', 'avx2');
  const e1 = await boot(dirA1, 'avx2', ['INFO THREAD_NUM 1', 'INFO CAUTION_FACTOR 3',
    'INFO STRENGTH 100', 'INFO SHOW_DETAIL 3', 'INFO PONDERING 0', 'INFO SWAPABLE 0',
    'INFO HASH_SIZE 1048576']);
  const det = [];
  for (let round = 1; round <= 3; round++) {
    const line = [], out = [];
    for (let i = 0; i < PLIES; i++) {
      const side = (i % 2 === 0) ? 1 : 2;      // ★ 每手换边 = 用户「频繁切换执黑/执白」
      const r = await play(e1, line, side, { maxDepth: 12, turn: 60000 });
      out.push(r);
      if (r.fail) { console.log('   ply' + i + ' ★ 未出子'); continue; }
      line.push([r.move[0], r.move[1], side]);
      console.log('   第' + round + '轮 ply' + i + ' ' + (side === 1 ? '黑' : '白') +
        ' → ' + r.move.join(',') + '  eval=' + r.eval + ' depth=' + r.depth);
    }
    det.push(out);
  }
  await closeEng(e1);
  fs.rmSync(dirA1, { recursive: true, force: true });

  console.log('\n-- A1 判定 --');
  let detDiff = 0, detMate = 0;
  for (let i = 0; i < PLIES; i++) {
    const a = det[0][i];
    for (let round = 1; round <= 2; round++) {
      const b = det[round][i];
      if (!a || !b || a.fail || b.fail) { detDiff++; continue; }
      if (a.move[0] !== b.move[0] || a.move[1] !== b.move[1]) detDiff++;
    }
  }
  ok(detDiff === 0, '固定深度下 3 轮**逐手完全一致**（⇒ 没有隐藏状态/库污染，搜索是位置的纯函数）',
    '不一致 ' + detDiff + ' 处');
  ok(det[0].filter(r => r.fail).length === 0, '确定性基准下每手都出子');

  // ============ A2. 真实口径：8 线程 + 限时；同一局面插空问 3 次 ============
  console.log('\n===== A2. 真实口径（8 线程 + ' + TURN + 'ms；每局面插空重复问 3 次）=====');
  const dirA2 = freshDir('real', 'avx2');
  const e2 = await boot(dirA2, 'avx2');
  // 先走出一条主线（每手换边），记下每个局面
  const line = [], positions = [];
  for (let i = 0; i < PLIES; i++) {
    const side = (i % 2 === 0) ? 1 : 2;
    positions.push({ prefix: line.slice(), side: side, stones: line.map(m => [m[0], m[1]]) });
    const r = await play(e2, line, side);
    if (r.fail) { console.log('   ply' + i + ' ★ 未出子'); break; }
    line.push([r.move[0], r.move[1], side]);
  }
  // 每个局面插空问 3 次
  const reps = positions.map(() => []);
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const r = await play(e2, p.prefix, p.side);
      r.dist = r.fail ? 99 : distToStones(r.move, p.stones);
      reps[i].push(r);
    }
  }
  await closeEng(e2);
  fs.rmSync(dirA2, { recursive: true, force: true });

  console.log('\n-- A2 明细（同一局面 3 次）--');
  let mateJump = 0, offCnt = 0, stuck = 0, depthDrop = 0, offList = [], jumpList = [], dropList = [], spread = [];
  for (let i = 0; i < positions.length; i++) {
    const rs = reps[i];
    const ms = rs.map(r => (r.fail ? 'X' : r.move.join(',')));
    const evs = rs.map(r => (r.fail ? 'X' : r.eval));
    const dps = rs.map(r => r.depth);
    const isM = rs.map(r => !r.fail && /M/.test(r.eval));
    console.log('   ply' + i + ' ' + (positions[i].side === 1 ? '黑' : '白') +
      ' 着法[' + ms.join(' ') + '] 评估[' + evs.join(' ') + '] 深度[' + dps.join(' ') + ']' +
      ' 距棋子[' + rs.map(r => r.dist).join(' ') + ']');
    if (rs.some(r => r.fail)) stuck++;
    // ★ 系统性跳变：同一次序里「有 M 也有非 M」= 结论量级在变（库污染的典型特征）
    if (isM.some(Boolean) && isM.some(v => !v)) { mateJump++; jumpList.push('ply' + i + '(' + evs.join('/') + ')'); }
    for (const r of rs) if (!r.fail && r.dist > 2) { offCnt++; offList.push('ply' + i + ':' + r.move.join(',') + '(距' + r.dist + ')'); }
    // ★ 深度判据用**相对**口径，不用绝对层数差：
    //   限时 + 8 线程(lazy SMP)下，同一局面每次搜到的深度本来就会随机器负载、置换表命中
    //   浮动 20~30%（实测 21~28 层），这是时间控制搜索的固有抖动，**不是**智力退化。
    //   真要抓的「塌陷」是断崖式掉档（不足峰值的 60% 且掉到 15 层以下）。
    const ds = dps.filter(d => d > 0);
    const mx = Math.max.apply(null, ds), mn = Math.min.apply(null, ds);
    if (mx > 0 && mn < mx * 0.6 && mn < 15) { depthDrop++; dropList.push('ply' + i + '(' + dps.join('/') + ')'); }
    spread.push(mx - mn);
  }
  console.log('\n-- A2 判定 --');
  ok(stuck === 0, '每个局面每次都出子（不会「一直下不了子」）', '卡住 ' + stuck + ' 个');
  ok(offCnt === 0, '**没有下偏**：所有着法都落在已有棋子 2 格内',
    offCnt ? '下偏 ' + offCnt + ' 次: ' + offList.join(' ') : '0 次');
  ok(mateJump === 0, '**无系统性跳变**：同一局面不会「这次普通分、下次 M 值」（库污染特征已消除）',
    mateJump ? jumpList.join(' ') : '0 处');
  ok(depthDrop === 0, '**无深度塌陷**：同一局面三次深度无断崖式掉档（正常抖动最大 ' +
    Math.max.apply(null, spread) + ' 层）', depthDrop ? dropList.join(' ') : '0 个局面');

  // ============ B. 全新机器可用性 ============
  console.log('\n===== B. 全新机器可用性（无 rapfi.db、无历史，逐个 ISA 变体）=====');
  const variantRes = [];
  for (const v of VARIANTS) {
    const d = freshDir('fresh', v);
    const e = await boot(d, v);
    const r = await play(e, [], 1);
    await closeEng(e);
    const hasDb = fs.readdirSync(d).some(f => /\.db$/i.test(f));
    variantRes.push({ v, okv: !r.fail, move: r.fail ? null : r.move, db: hasDb });
    console.log('   ' + v.padEnd(11) + (r.fail ? '✗ 未出子（该变体在本机跑不起来）'
      : '✓ 出子 ' + r.move.join(',') + '  eval=' + r.eval + ' depth=' + r.depth) +
      '   | 跑完是否生成 rapfi.db: ' + (hasDb ? '是' : '否'));
    fs.rmSync(d, { recursive: true, force: true });
  }
  const anyOk = variantRes.filter(x => x.okv).length;
  ok(anyOk >= 1, '至少有一个 ISA 变体在全新机器上能出子（' + anyOk + '/' + VARIANTS.length + '）',
    variantRes.filter(x => x.okv).map(x => x.v).join(','));
  ok(variantRes.every(x => !x.db),
    '全新机器上**不会再写出 rapfi.db**（库只读 + 未启用，不会累积脏标签）');

  console.log('\n-- B 最坏情况：手动开库 + 只读 + 无 rapfi.db --');
  const dW = freshDir('worst', 'avx2');
  const eW = await boot(dW, 'avx2', CFG.concat(['INFO USEDATABASE 1']));
  const rW = await play(eW, [], 1);
  const rW2 = await play(eW, [[rW.fail ? 7 : rW.move[0], rW.fail ? 7 : rW.move[1], 1]], 2);
  await closeEng(eW);
  ok(!rW.fail && !rW2.fail, '库缺失 + 只读模式下引擎**照常出子、不崩**（兜底安全）',
    rW.fail ? '第1手就没出子' : ('两手都出子: ' + rW.move.join(',') + ' / ' + rW2.move.join(',')));
  fs.rmSync(dW, { recursive: true, force: true });

  // ★ 中文用户最常见的坑：装到含中文/空格的目录（D:\五子棋 助手\）引擎还认不认得 config/模型？
  console.log('\n-- B 中文 + 空格路径（模拟国内用户装到 D:\\五子棋 助手\\）--');
  const dC = path.join(os.tmpdir(), '五子棋 助手 v4.35', '引擎 目录');
  fs.rmSync(path.join(os.tmpdir(), '五子棋 助手 v4.35'), { recursive: true, force: true });
  fs.mkdirSync(dC, { recursive: true });
  for (const f of NEED) fs.copyFileSync(path.join(REL, f), path.join(dC, f));
  fs.copyFileSync(path.join(REL, 'RapfiEngine-avx2.exe'), path.join(dC, 'RapfiEngine-avx2.exe'));
  const eC = await boot(dC, 'avx2');
  const rC = await play(eC, [], 1);
  const rC2 = await play(eC, [[rC.fail ? 7 : rC.move[0], rC.fail ? 7 : rC.move[1], 1]], 2);
  await closeEng(eC);
  ok(!rC.fail && !rC2.fail, '中文 + 空格路径下引擎照常加载模型并出子（路径编码不是隐患）',
    rC.fail ? '第1手就没出子' : ('出子 ' + rC.move.join(',') + ' / ' + rC2.move.join(',')));
  fs.rmSync(path.join(os.tmpdir(), '五子棋 助手 v4.35'), { recursive: true, force: true });

  console.log('\n===== 汇总：' + (fails ? fails + ' 项未通过 ✗' : '全部通过 ✓') + ' =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
