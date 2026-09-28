// 用取证重建的真盘查询引擎，对照面板显示的 -M30
const http = require('http');
const N = 15;
const board = Array.from({ length: N }, () => new Array(N).fill(0));
// 黑: H8 J8 K8 K7 F6 ; 白: F9 F8 F7 J7
const B = [['H', 8], ['J', 8], ['K', 8], ['K', 7], ['F', 6]];
const W = [['F', 9], ['F', 8], ['F', 7], ['J', 7]];
const col = c => 'ABCDEFGHJKLMNOP'.indexOf(c);   // 无 I 记法（与取证脚本一致）
for (const [c, r] of B) board[15 - r][col(c)] = 1;
for (const [c, r] of W) board[15 - r][col(c)] = 2;

function q(side) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ board, matchMs: 600000, turnMs: 3000, timeUsedMs: 0,
      topN: 3, rule: 0, side, lane: 'sub', cid: 'forensic-' + side });
    const req = http.request({ host: '127.0.0.1', port: 8964, path: '/api/analyze',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', e => resolve('ERR ' + e.message));
    req.end(body);
  });
}
(async () => {
  for (const s of [1, 2]) {
    const r = await q(s);
    try {
      const j = JSON.parse(r);
      const c0 = (j.candidates || [])[0] || {};
      console.log('side=' + s, 'eval=', c0.eval, 'depth=', c0.depth, 'best=', c0.x != null ? c0.x + ',' + c0.y : '-', 'pv=', (c0.line || []).slice(0, 8).join(' '));
    } catch (e) { console.log('side=' + s, 'RAW:', r.slice(0, 300)); }
  }
})();
