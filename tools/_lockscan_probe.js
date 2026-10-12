// _lockscan_probe.js —— 复刻连线版**稳态**识别请求（region + 锁定几何），量真实每帧延迟与分段。
// 第 1 发全屏 find 拿几何 → 之后按连线版的口径带 region+geometry 连发，得到用户实际感受到的速度。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');
const PORT = 8971;

const srv = spawn(EXE, ['--scan'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: (() => { const e = { ...process.env }; delete e.GB_VISION_TRACE; e.GB_VISION_PERF = '1'; return e; })(),
});
let elog = '';
srv.stdout.on('data', () => {});
srv.stderr.on('data', d => elog += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(p) {
  return new Promise(res => {
    const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 1500 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res(b));
    });
    q.on('error', () => res(null)); q.on('timeout', () => { q.destroy(); res(null); });
  });
}
function post(p, body, ct) {
  return new Promise((res, rej) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': ct || 'application/json', 'Content-Length': body.length }, timeout: 30000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => res({ ms: Number(process.hrtime.bigint() - t0) / 1e6, body: b }));
    });
    req.on('error', rej); req.end(body);
  });
}

(async () => {
  for (let i = 0; i < 60; i++) { if (await get('/health')) break; await sleep(300); }
  console.log('== ① 全屏 find（首帧，拿几何）==');
  let r = await post('/scan', '{"size":15}');
  console.log(`  ${r.ms.toFixed(0)}ms found=${/"found": ?true/.test(r.body)}`);
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { console.log('  解析失败'); }
  if (!j || !j.geometry) { console.log('  未拿到几何 —— 屏幕上没有棋盘，后面的锁定快道无法测'); srv.kill(); process.exit(0); }
  const gx = j.geometry.x_lines, gy = j.geometry.y_lines, sp = j.geometry.spacing;
  const ox = (j.offset && j.offset[0]) || 0, oy = (j.offset && j.offset[1]) || 0;
  const br = j.board_rect;
  console.log(`  几何: x0=${gx[0].toFixed(1)} y0=${gy[0].toFixed(1)} spacing=${sp.toFixed(2)} offset=${ox},${oy}`);
  console.log(`  黑${(j.black || []).length} 白${(j.white || []).length}`);

  // 连线版锁定后的请求体：region = 框住棋盘的屏幕区域 + geometry（屏幕坐标）
  const mx = Math.round((gx[gx.length - 1] - gx[0]) * 0.06) + 8;
  const my = Math.round((gy[gy.length - 1] - gy[0]) * 0.06) + 8;
  const region = [
    Math.round(gx[0] - mx), Math.round(gy[0] - my),
    Math.round(gx[gx.length - 1] - gx[0] + 2 * mx), Math.round(gy[gy.length - 1] - gy[0] + 2 * my)];
  const body = JSON.stringify({ size: 15, region, geometry: { x_lines: gx, y_lines: gy, spacing: sp } });
  console.log('\n== ② 稳态（region + 锁定几何，连线版每帧走的就是这条）==');
  const ms = [];
  for (let i = 0; i < 6; i++) {
    const q = await post('/scan', body);
    ms.push(q.ms);
    const sus = /"suspect": ?true/.test(q.body);
    console.log(`  #${i + 1} ${q.ms.toFixed(0)}ms suspect=${sus} found=${/"found": ?true/.test(q.body)}`);
    await sleep(60);
  }
  ms.sort((a, b) => a - b);
  console.log(`  中位数 ${ms[3].toFixed(0)}ms  最小 ${ms[0].toFixed(0)}ms  最大 ${ms[5].toFixed(0)}ms`);

  console.log('\n== 服务端 [perf] 分段 ==');
  console.log(elog.split('\n').filter(l => /\[perf/.test(l)).slice(-14).join('\n') || '(无)');
  srv.kill('SIGKILL'); process.exit(0);
})();
