// _perfprobe.js —— 识别分段耗时实测（GB_VISION_TRACE=1，bypass 单次调用）
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const EXE = 'C:/Users/harve/Desktop/Gobang auto/desktop-vision/build/GomokuVision.exe';
const PORT = 8971;
const BOARD_PNG = 'C:/Users/harve/Desktop/Gobang auto/tools/_shot_board.png';

const srv = spawn(EXE, ['--scan'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  // ★ 2026-10-02：GB_VISION_PERF（分段打点、读子保持 8 线程）。TRACE 必须从环境里
  //   **彻底删除**（空串也会让 C getenv 返回非 null → trace 开启 → 读子强制串行）。
  env: (() => { const e = { ...process.env }; delete e.GB_VISION_TRACE; e.GB_VISION_PERF = '1';
  if (process.env.PROBE_CVTHREADS) e.GB_VISION_CVTHREADS = process.env.PROBE_CVTHREADS;
  return e; })(),
});
let slog = '', elog = '';
srv.stdout.on('data', d => slog += d);
srv.stderr.on('data', d => elog += d);

function waitUp(port, maxMs) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, x => {
        x.resume(); clearInterval(t); res();
      });
      r.on('error', () => { if (Date.now() - t0 > maxMs) { clearInterval(t); rej(new Error('never up')); } });
      r.on('timeout', () => r.destroy());
    }, 250);
  });
}
function post(path, body, ct) {
  return new Promise((res, rej) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': ct || 'application/json', 'Content-Length': body.length }, timeout: 30000 }, r => {
      let buf = '';
      r.on('data', c => buf += c);
      r.on('end', () => res({ ms: Number(process.hrtime.bigint() - t0) / 1e6, body: buf }));
    });
    req.on('error', rej);
    req.end(body);
  });
}

(async () => {
  try {
    await waitUp(PORT, 30000);
    console.log('== 服务就绪（GB_VISION_TRACE=1）==');
    for (let i = 0; i < 2; i++) {
      const r = await post('/scan', '{"size":15}');
      console.log(`/scan 无盘 #${i + 1}: ${r.ms.toFixed(0)}ms  ${r.body.slice(0, 60)}`);
    }
    const png = fs.readFileSync(BOARD_PNG);
    console.log('测试图: ' + BOARD_PNG + ' ' + png.length + 'B');
    for (let i = 0; i < 3; i++) {
      const r = await post('/scan-image', png, 'image/png');
      console.log(`/scan-image 有盘 #${i + 1}: ${r.ms.toFixed(0)}ms  found=${/\"found\": ?true/.test(r.body)}`);
    }
  } catch (e) { console.log('探针失败:', e.message); }
  await new Promise(r => setTimeout(r, 400));
  console.log('== 服务端 [perf] 分段 ==');
  console.log(elog.split('\n').filter(l => /\[perf(seg)?\]|\[trace\]/.test(l)).slice(-12).join('\n') || '(无 perf 行)');
  srv.kill('SIGKILL');
  process.exit(0);
})();
