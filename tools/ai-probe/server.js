// AI 探针服务：带 COOP/COEP 头的本地 HTTP，供 rapfi 在浏览器页面内做 pthreads 多线程。
// 仅用于探针验证（task 22），不是交付物。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const RES = path.join(ROOT, 'tools', 'rapfi-wasm-src');   // 2026-09-26 WASM 资源自 engine-server/resources 归档至此
const CALC = path.join(ROOT, 'desktop-calculator', 'build', 'calc');
const PORT = parseInt(process.env.PROBE_PORT || '8990', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
};
function addIso(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
}
const server = http.createServer((req, res) => {
  console.log('[req]', req.url);
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  if (p === '/') { p = '/probe.html'; }
  if (p.startsWith('/ai/')) {
    const f = path.join(RES, path.basename(p));
    if (!fs.existsSync(f)) { addIso(res); res.writeHead(404); res.end('no'); return; }
    addIso(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  // calc.html 及其资源（来自 build/calc，模拟练习器宿主的供给方式 + 同样的隔离头）
  const cf = path.join(CALC, path.basename(p));
  if (fs.existsSync(cf) && fs.statSync(cf).isFile()) {
    addIso(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(cf)] || 'application/octet-stream' });
    res.end(fs.readFileSync(cf));
    return;
  }
  if (p === '/probe.html') {
    addIso(res);
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(fs.readFileSync(path.join(__dirname, 'probe.html')));
    return;
  }
  addIso(res); res.writeHead(404); res.end('no');
});
server.listen(PORT, '127.0.0.1', () => console.log('probe server on http://127.0.0.1:' + PORT));
