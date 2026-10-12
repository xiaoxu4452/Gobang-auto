// ★ 频繁关开竞态回归测试：hostbye 后 1.5s 裁决窗口内被新宿主 adopt → 必须留守
//   （修前：裁决只看 wsClients.size==0 → exit，把刚认的新主人甩掉）
const { spawn } = require('child_process');
const http = require('http');
const PORT = 8965;
const EXE = 'C:/Users/harve/Desktop/Meter engine-server/Web GomokuEngine.exe';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(3000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let fail = 0;
  // 宿主 A：活着的牺牲进程（engine 的 GB_PARENT_PID）
  const hostA = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  await sleep(300);
  // 宿主 B：接盘的新宿主（一直活着）
  const hostB = spawn('node', ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  await sleep(300);

  console.log('[t0] boot engine (parent=hostA pid=' + hostA.pid + ')');
  const eng = spawn(process.execPath, ['C:/Users/harve/Desktop/Gobang auto/engine-server/engine-server.js', '--as-backend'], {
    env: { ...process.env, GB_PORT: String(PORT), GB_PARENT_PID: String(hostA.pid) },
    stdio: 'ignore'
  });
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    await sleep(500);
    try { const h = await req('GET', '/health'); ready = JSON.parse(h.body).ready === true; } catch (e) {}
  }
  console.log('[boot] engine ready=' + ready);
  if (!ready) { console.log('!! engine never became ready'); process.exit(1); }

  // 场景：宿主 A 退出 → hostbye → 引擎排定 1.5s 裁决 → 在窗口内新宿主 B adopt
  hostA.kill();
  console.log('[t1] hostA killed; POST /api/hostbye');
  await req('POST', '/api/hostbye', {});
  await sleep(300);                                    // 留 1.2s —— 真实新宿主的 adopt 也赶得及
  const ad = await req('POST', '/api/adopt', { pid: hostB.pid }).catch(e => ({ body: String(e) }));
  console.log('[t2] adopt -> ' + ad.body);
  await sleep(3000);                                   // 越过 1.5s 裁决点
  let alive = false;
  try { const h = await req('GET', '/health'); alive = JSON.parse(h.body).pid === eng.pid; } catch (e) {}
  console.log('[t3+3s] engine alive after adopt-in-bye-window: ' + alive);
  if (!alive) { console.log('!! FAIL: engine exited despite post-bye adoption'); fail++; }

  // 场景二（回归保护）：hostbye 后无 adopt、无客户端 → 1.5s 内照旧自退
  console.log('[t4] POST /api/hostbye again (no adopt)');
  await req('POST', '/api/hostbye', {}).catch(() => {});
  await sleep(2500);
  let gone = false;
  try { await req('GET', '/health'); } catch (e) { gone = true; }
  console.log('[t5] engine exited without adopt: ' + gone);
  if (!gone) {
    console.log('!! FAIL: engine should die with host when no adopt');
    fail++;
    try { eng.kill(); } catch (e) {}
  }
  try { hostB.kill(); } catch (e) {}
  console.log(fail === 0 ? 'ALL PASS' : 'FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
