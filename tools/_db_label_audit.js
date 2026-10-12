#!/usr/bin/env node
/**
 * ★ 2026-10-01：**校验库里的 mate 标签是否可信**。
 * 取几条 label=w/l 的真实记录，把它们描述的局面用「纯搜索 + 10 秒 + 关库」重算一遍：
 *   · 记录声称「N 步内必胜/必败」，重算若也给出 mate 值 → 记录可信；
 *   · 重算若是普通分值（几十~几百）→ **记录是错的**，而引擎会拿它当权威（root 直接采用）→
 *     这就是「仪表盘报 M33、着法却发飘」的来源。
 * 用法：node tools/_db_label_audit.js [每手毫秒=8000]
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), os = require('os');
const TMP = path.join(os.tmpdir(), 'gb-selfplay-eng');
const ENGINE = path.join(TMP, 'RapfiEngine-avx2.exe');
const TURN = +(process.argv[2] || 8000);

// key → {black:[[x,panelY]…], white:[…], side}   （key 里的行号 = 引擎 y+1 → 面板 y = 15-digit）
function parseKey(key) {
  const p = key.split('-');            // f,15,15,<black>,<white>,<stm>
  const decode = s => {
    const out = [];
    for (let i = 0; i < s.length;) {
      const x = s.charCodeAt(i) - 97; i++;
      let d = '';
      while (i < s.length && s[i] >= '0' && s[i] <= '9') { d += s[i++]; }
      out.push([x, 15 - (+d)]);
    }
    return out;
  };
  return { black: decode(p[3] || ''), white: decode(p[4] || ''), side: p[5] === 'b' ? 1 : 2 };
}
const CASES = [
  { key: 'f-15-15-g7h8-f6g8-b', label: 'l', value: 29969, depth: 6 },
  { key: 'f-15-15-g7g9h8-c8f6h7-b', label: 'l', value: 29975, depth: 1 },
  { key: 'f-15-15-g7g9h8-f6h7-w', label: 'w', value: -29970, depth: 35 },
  { key: 'f-15-15-f6f8f9g7h8h9i9-e5f7g8h6i7j10-w', label: 'w', value: -29976, depth: 0 },
];

function open() {
  const c = spawn(ENGINE, [], { cwd: TMP, windowsHide: true });
  let buf = ''; const lines = [];
  c.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  c.stderr.on('data', () => {});
  return { c, lines, send: a => c.stdin.write(a.join('\n') + '\n') };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('校验用例（纯搜索 ' + TURN + 'ms、关库）：\n');
  for (const cs of CASES) {
    const d = parseKey(cs.key);
    const seq = [];
    const B = d.black.slice(), W = d.white.slice();
    for (let i = 0; i < Math.max(B.length, W.length); i++) { if (B[i]) seq.push([B[i][0], B[i][1], 1]); if (W[i]) seq.push([W[i][0], W[i][1], 2]); }
    // 末 token 颜色须为 3-side
    const want = 3 - d.side;
    if (seq.length && seq[seq.length - 1][2] !== want) {
      for (let i = seq.length - 1; i >= 1; i--) if (seq[i][2] === want) { seq.push(seq.splice(i, 1)[0]); break; }
    }
    const e = open();
    e.send(['START 15']); await sleep(1500);
    e.send(['INFO THREAD_NUM 8', 'INFO HASH_SIZE 1048576', 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100',
      'INFO SHOW_DETAIL 3', 'INFO SWAPABLE 0', 'INFO RULE 0', 'INFO USEDATABASE 0']);
    await sleep(120);
    e.lines.length = 0;
    const toks = seq.map(m => m[0] + ',' + (14 - m[1]) + ',' + m[2]);
    const t0 = Date.now();
    e.send(['INFO TIMEOUT_TURN ' + TURN, 'INFO TIMEOUT_MATCH 600000', 'INFO TIME_LEFT 600000',
      'YXBOARD ' + (toks.length ? toks.join(' ') + ' ' : '') + 'DONE', 'YXNBEST 1']);
    let mv = null, ev = '', dep = '';
    while (Date.now() - t0 < TURN + 9000) {
      await sleep(60);
      for (const l of e.lines.splice(0)) {
        const t = l.trim();
        if (/^\d+,\d+$/.test(t) && !mv) mv = t;
        const m1 = /Eval\s+(-?M?\d+)/i.exec(t); if (m1) ev = m1[1];
        const m2 = /Depth\s+(\d+)/i.exec(t); if (m2) dep = m2[1];
      }
      if (mv) break;
    }
    e.c.kill('SIGKILL');
    const claim = cs.value > 0 ? ('mover 输（-M' + (30000 - Math.abs(cs.value)) + '）') : ('mover 赢（+M' + (30000 - Math.abs(cs.value)) + '）');
    const real = /^-?M\d+/.test(ev) ? 'mate ' + ev : '普通分值 ' + ev;
    console.log('· ' + cs.key);
    console.log('    记录：label=' + cs.label + '  depth=' + cs.depth + '  → 声称 ' + claim);
    console.log('    重算：' + real + '（深度 ' + dep + '）  着法=' + mv);
    console.log('    判定：' + (/^-?M\d+/.test(ev) ? '✔ 记录可信（重算也是 mate）' : '✘ **记录不可信**（重算只是普通分值）') + '\n');
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
