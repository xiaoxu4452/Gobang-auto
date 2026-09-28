// ★ 回归：引擎文本 PV（MESSAGE PV / Depth 摘要里的 F6/B2 类着法）的行号约定。
//
// 背景（2026-09-19 热力图纵向镜像的根因）：同一迭代的
//   `MESSAGE (1) ... F6 E3 K5`（字母数字，行号 1 基、**从顶部数**，A1=左上）
// 与 `INFO BESTLINE 5,9 4,12 10,10`（数字，底原点 0 基，服务端翻回面板坐标）
// 描述的是**同一条 PV** —— F6 → 面板 (5,5) = 行号-1。旧解析用 `SIZE - n`，
// 把整条 PV 上下镜像（仅第 8 行恰好重合）→ 热力图第 2~8 名色块画到镜像位置；
// best 走数字路径恒正确，所以极难察觉。
//
// 判据：构造「战斗集中在左上角、其余全空」的局面（黑斜活三，白走），
// 正确候选只能出现在棋子附近；镜像解析会把候选投到**离所有棋子都很远**的
// 对角位置（如 (1,13)）。断言：每个候选到最近棋子的切比雪夫距离 ≤2，
// 且 best 必须是活三的两个挡点 (1,1)/(5,5) 之一。
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.env.GB_NODE || 'C:/Users/harve/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
const PORT = 8997;
const N = 15;

// 面板坐标（y=0 顶）：黑 (2,2),(3,3),(4,4) 斜活三 + (7,11)；白 (11,3),(12,4),(11,4)。
// bn=4 > wn=3 → 轮白。白必挡 (1,1) 或 (5,5)。
const BLACK = [[2, 2], [3, 3], [4, 4], [7, 11]];
const WHITE = [[11, 3], [12, 4], [11, 4]];
const STONES = BLACK.concat(WHITE);

function buildBoard() {
  const b = Array.from({ length: N }, () => new Array(N).fill(0));
  BLACK.forEach(([x, y]) => { b[y][x] = 1; });
  WHITE.forEach(([x, y]) => { b[y][x] = 2; });
  return b;
}

function get(port, p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', () => resolve(null));
  });
}

function analyze(port, board) {
  const body = JSON.stringify({ board, turnMs: 1800, topN: 8, rule: 0, lane: 'main', cid: 'pv-frame' });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/analyze', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  let passed = 0, failed = 0;
  const check = (name, ok, extra) => {
    if (ok) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
  };

  const child = spawn(NODE, ['engine-server.js'], {
    cwd: path.join(ROOT, 'engine-server'),
    env: Object.assign({}, process.env, { GB_PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise(r => setTimeout(r, 500));
      const h = await get(PORT, '/health');
      if (h && h.includes('"ready":true')) up = true;
    }
    check('engine up on :' + PORT, up);

    const res = await analyze(PORT, buildBoard());
    check('analyze returned', !!(res && res.candidates && res.candidates.length));
    const best = res.best || [];
    check('best is a real block of the open three',
      (best[0] === 1 && best[1] === 1) || (best[0] === 5 && best[1] === 5),
      'best=' + JSON.stringify(best));

    const cands = (res.candidates || []).map(c => [c.x, c.y]);
    const far = cands.filter(([x, y]) =>
      Math.min(...STONES.map(([sx, sy]) => Math.max(Math.abs(x - sx), Math.abs(y - sy)))) > 2);
    check('no mirror artifacts (every candidate within 2 of a stone)',
      cands.length > 0 && far.length === 0,
      'far candidates: ' + JSON.stringify(far) + ' all: ' + JSON.stringify(cands));

    // 思路 line 同样吃这套解析：best 的 line 首步应等于自身坐标（若非空）。
    const c0 = (res.candidates || [])[0] || {};
    if (c0.line && c0.line.length) {
      check('line[0] consistent with candidate', c0.line[0][0] === c0.x && c0.line[0][1] === c0.y,
        'cand=' + JSON.stringify([c0.x, c0.y]) + ' line0=' + JSON.stringify(c0.line[0]));
    }
  } finally {
    try { child.kill(); } catch (e) {}
  }

  console.log('\n=== test-engine-pv-frame: %d passed, %d failed ===', passed, failed);
  console.log('=== test-engine-pv-frame: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
