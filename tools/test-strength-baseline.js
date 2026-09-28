// test-strength-baseline.js —— 战术局面强度基准（2026-09-25 晚三 B2）
// 直打本地引擎 /api/analyze（新代码），验证算法链路的决策质量底线：
//   ① 己方四连 → 必须成五（两卫星点任一）
//   ② 对方四连 → 必须堵（不堵即输）
//   ③ 空盘     → 天元
//   ④ 己方活三 → 落点必须在这条线的攻防延伸区（不得投到无关远点）
//   ⑤ JSONP 通道同局面①结果一致（降级通道决策不劣化）
// 前置：engine-server 已在 8964 运行。
'use strict';
const http = require('http');

function emptyBoard() { return Array.from({ length: 15 }, () => new Array(15).fill(0)); }
function analyze(body) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: 8964, path: '/api/analyze', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(d); req.end();
  });
}
function jsonpAnalyze(body) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8964/api/analyze?cb=x&d=' + encodeURIComponent(JSON.stringify(body)), (res) => {
      let s = ''; res.on('data', (c) => s += c);
      res.on('end', () => { const m = s.match(/^x\(([\s\S]*)\);?$/); try { resolve(JSON.parse(m[1])); } catch (e) { reject(new Error('bad jsonp: ' + s.slice(0, 80))); } });
    }).on('error', reject);
  });
}

let pass = 0, fail = 0;
const assert = (c, n) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

(async () => {
  const T = { matchMs: 600000, turnMs: 3000, topN: 3, rule: 0 };

  // ① 黑四连 (5,7)..(8,7)，轮黑 → 成五
  {
    const b = emptyBoard();
    for (let x = 5; x <= 8; x++) b[7][x] = 1;
    b[8][5] = 2; b[8][6] = 2;                    // 两枚白子凑合法轮次
    const d = await analyze({ ...T, board: b, side: 1 });
    const [bx, by] = d.best || [-1, -1];
    assert(d.best && by === 7 && (bx === 4 || bx === 9),
      `① 己方四连成五（best=${bx},${by}）`);
  }

  // ② 白四连 (5,7)..(8,7)，轮黑 → 必堵
  {
    const b = emptyBoard();
    for (let x = 5; x <= 8; x++) b[7][x] = 2;
    b[8][5] = 1; b[8][6] = 1; b[8][7] = 1;       // 黑三子
    const d = await analyze({ ...T, board: b, side: 1 });
    const [bx, by] = d.best || [-1, -1];
    assert(d.best && by === 7 && (bx === 4 || bx === 9),
      `② 对方四连必堵（best=${bx},${by}）`);
  }

  // ③ 空盘 → 天元
  {
    const d = await analyze({ ...T, board: emptyBoard(), side: 1 });
    const [bx, by] = d.best || [-1, -1];
    assert(bx === 7 && by === 7, `③ 空盘天元（best=${bx},${by}）`);
  }

  // ④ 黑活三 (6,7)(7,7)(8,7)，白 (6,8)(7,8) → 落点须在攻防延伸区
  {
    const b = emptyBoard();
    b[7][6] = 1; b[7][7] = 1; b[7][8] = 1;
    b[8][6] = 2; b[8][7] = 2;
    const d = await analyze({ ...T, board: b, side: 1 });
    const [bx, by] = d.best || [-1, -1];
    assert(d.best && by >= 6 && by <= 8 && bx >= 3 && bx <= 11,
      `④ 活三落点在攻防区（best=${bx},${by}）`);
    // 近石约束（切比雪夫 ≤2 内有子）：活三局面下好手不会是孤岛远点
    const near = b.some((row, y) => row.some((v, x) => v &&
      Math.max(Math.abs(x - bx), Math.abs(y - by)) <= 2));
    assert(near, `④b 落点贴近棋子群（≤2）`);
  }

  // ⑤ JSONP 通道：局面①同参数，决策应一致（降级通道不劣化）
  {
    const b = emptyBoard();
    for (let x = 5; x <= 8; x++) b[7][x] = 1;
    b[8][5] = 2; b[8][6] = 2;
    const d = await jsonpAnalyze({ ...T, board: b, side: 1, cid: 'jsonp-b' });
    const [bx, by] = d.best || [-1, -1];
    assert(d.best && by === 7 && (bx === 4 || bx === 9),
      `⑤ JSONP 通道同样成五（best=${bx},${by}）`);
  }

  console.log(`test-strength-baseline: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR:', e.message); process.exit(1); });
