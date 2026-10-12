// 取证：模拟面板的 composeBoardImage + /recognize 调用，喂 playok 棋盘
const http = require('http');
const fs = require('fs');

// playok 棋盘 canvas 区域（木色掩膜外接框，比网格各方向多一圈 padding）
const img = fs.readFileSync('C:/Users/harve/Desktop/Gobang auto/tools/_forensic/board_canvas.png').toString('base64');

function recognize(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: 8970, path: '/recognize', method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(data) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', e => resolve('ERR ' + e.message));
    req.end(data);
  });
}
(async () => {
  const r = await recognize({ image: img, size: 15 });
  try {
    const j = JSON.parse(r);
    console.log('ok=', j.ok, ' suspect=', j.suspect);
    if (j.geometry) console.log('geo:', JSON.stringify(j.geometry).slice(0, 200));
    console.log('black(' + (j.black || []).length + '):', (j.black || []).map(s => 'ABCDEFGHJKLMNOP'[s.x] + (15 - s.y)).join(' '));
    console.log('white(' + (j.white || []).length + '):', (j.white || []).map(s => 'ABCDEFGHJKLMNOP'[s.x] + (15 - s.y)).join(' '));
  } catch (e) { console.log('RAW:', r.slice(0, 500)); }
})();
