/** 临时探针：验证抓屏后端自适应（首帧择一 + 强制开关）。用完即删。 */
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(port, p, body) {
  return new Promise((res, rej) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body || {});
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 20000 },
      r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); });
    rq.on('error', rej); rq.on('timeout', () => { rq.destroy(); rej(new Error('timeout')); });
    rq.write(data); rq.end();
  });
}

async function trial(label, env, port) {
  const e = Object.assign({}, process.env, env, { GB_VISION_PERF: '1' });
  const ch = cp.spawn(EXE, ['--scan', '--nosnap'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ch.stderr.on('data', d => err += d.toString('utf8'));
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(250); try { await post(port, '/scan', {}); ok = true; } catch (ev) {} }
  for (let i = 0; i < 3; i++) { try { await post(port, '/scan', {}); } catch (ev) {} await sleep(120); }
  await sleep(400);
  try { ch.kill(); } catch (ev) {}
  await sleep(300);
  const lines = err.split(/\r?\n/).filter(l => /capture|perf\]/.test(l));
  console.log('=== ' + label + ' ===');
  lines.slice(0, 8).forEach(l => console.log('   ' + l.trim()));
  return lines;
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('EXE 缺失'); process.exit(1); }
  await trial('默认（自适应，期望首选 DXGI）', {}, 8971);
  await trial('GB_FORCE_CAPTURE=gdi（强制纯 CPU）', { GB_FORCE_CAPTURE: 'gdi' }, 8971);
  await trial('GB_NO_DXGI=1（排障开关，等价纯 CPU）', { GB_NO_DXGI: '1' }, 8971);
  process.exit(0);
})().catch(e => { console.log('探针失败：' + (e && e.message || e)); process.exit(1); });
