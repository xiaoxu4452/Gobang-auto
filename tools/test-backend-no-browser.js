#!/usr/bin/env node
/**
 * 回归护栏：`Web GomokuEngine.exe --as-backend` 被桌面助手拉起时**绝不能打开浏览器**。
 *
 * 为什么值得单独测：引擎的启动器里有两处会开浏览器/挂住的地方——
 *   ① server.listen 回调里的 `start "" "http://127.0.0.1:PORT/"`（正常桌面用法要开，后台模式不能开）
 *   ② EADDRINUSE 分支里的「按任意键退出」（后台模式没人按键，会一直挂着不退）
 * 一旦发布版引擎漏了 `GB_IS_BACKEND` 守卫，覆盖层每次启动都会「顺带」弹出一个浏览器书签页——
 * 这正是用户现场看到的现象。代码是加密发布的，肉眼看不出来，所以只能靠这个脚本在真 exe 上验。
 *
 * 断言：
 *   1. 后台模式下 :8964 会监听（引擎正常工作）
 *   2. 全程没有新增的浏览器进程
 *   3. 端口被占用时（重复拉起）进程会自己退出，而不是挂住
 *   4. ★ 2026-09-18：`/api/health` 真的在（端口归属判据；它不存在曾导致「被占用」误判 + 卡窗口）
 *   5. ★ 2026-09-18：端口被**外部程序**占用时，普通启动器也自动退出（不再卡「按任意键」）
 *
 * 用法：node tools/test-backend-no-browser.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'Meter engine-server', 'Web GomokuEngine.exe');
const PORT = 8964;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    s.setTimeout(timeout);
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.on('timeout', () => fin(false));
  });
}

/** 当前在跑的浏览器进程名集合（按「名字:pid」计，便于比对新增）。 */
function browserProcs() {
  let out = '';
  try { out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { return new Set(); }
  const RE = /^(msedge|chrome|firefox|iexplore|brave|opera|vivaldi|360se|360chrome|qqbrowser|sogouexplorer|maxthon)\.exe$/i;
  const set = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue;
    if (RE.test(m[1])) set.add(m[1].toLowerCase() + ':' + m[2]);
  }
  return set;
}

/** 向引擎端口发一个 GET，拿回 {code, body}（Buffer.concat，绝不逐块 +=：多字节中文会被切块）。 */
function httpGet(pathname, timeout = 2500) {
  return new Promise((resolve) => {
    let req;
    try {
      req = require('http').request(
        { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
    } catch (e) { return resolve(null); }
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

function killTree(pid) {
  try { execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore' }); } catch (e) {}
}

/** 剥掉注释只留代码 —— 本文件里有多条**否定**断言（"不再弹…MessageBox"），
 *  而源码的说明性注释里恰好写着同样的词，直接在原文上 indexOf 会自我命中、永远失败。 */
const stripComments = (s) => s.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ============================================================ A. 源码契约
// 发布版 exe 是**加密**的，字符串搜索看不到启动器逻辑。所以先在源工程上把
// 「可共存 / 不卡黑窗口」的契约钉死，再用下面的运行时断言在真 exe 上确认它真的进去了。
//
// 背景（2026-09-18 用户现场）：「我打开五子棋练习器，也应该可以打开其他的五子棋助手，
//   而不能显示在控制台中，无法打开。」—— 练习器用 --as-backend 占住 :8964，用户再双击
//   启动器时旧代码会：① 弹「同一时间只能运行其中一个」拦人；② 探一个不存在的
//   /api/health（404）→ 判成「被别的程序占用」→ 卡在「按任意键退出」的黑窗口里。
console.log('== A. 启动器源码契约（engine-server.js）==');
{
  const ES = stripComments(fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8'));

  // ① /api/health 是「:8964 上是不是我们自己的引擎」的唯一判据。它不存在 = 必然误判。
  check('/api/health 路由存在并标明 app=GomokuEngine',
    /pathname === '\/api\/health'/.test(ES) && /app: 'GomokuEngine'/.test(ES));

  // ② 端口预检必须排在**任何重活之前**，否则会白加载一整套 Rapfi 去抢 CPU。
  const iProbe = ES.indexOf('const pre = await probeOwnPort();');
  const iRecog = ES.indexOf('startRecognitionAsync();');
  check('端口预检排在任何重活之前（不先加载 Rapfi / 识别服务）',
    iProbe > 0 && iRecog > 0 && iProbe < iRecog, 'probe@' + iProbe + ' recog@' + iRecog);

  // ③ 可共存：锁分支只记一行日志，不拦人、不退出。
  const iLock = ES.indexOf('if (!GB_IS_BACKEND) {');
  const iLockEnd = ES.indexOf("process.on('exit', gbReleaseLock)");
  const lockSeg = (iLock >= 0 && iLockEnd > iLock) ? ES.slice(iLock, iLockEnd) : '';
  check('「可共存」：检测到别的实例只记日志，不弹框、不退出',
    lockSeg.length > 0 && /可共存/.test(lockSeg) &&
    !/process\.exit/.test(lockSeg) && !/MessageBox/.test(lockSeg));

  // ④ 端口上是自己的引擎：非后台把启动器页面开出来再退；后台直接退。
  check('端口是自己的引擎：非后台打开启动器页面、后台直接退出（复用不再起第二份）',
    /if \(pre\.state === 'ours'\) \{[\s\S]{0,400}?if \(GB_IS_BACKEND\) process\.exit\(0\);[\s\S]{0,240}?openLauncherPage\(\);/.test(ES));

  // ⑤ 被别人占用：只提示 + 自动关窗。绝不能退回 process.stdin.resume() 等按键。
  check('端口被外部占用：提示 + 自动关窗（不再等按键挂住黑窗口）',
    /if \(pre\.state === 'foreign'\) \{[\s\S]{0,400}?sayThenExit\(/.test(ES) &&
    /function sayThenExit\(lines, delayMs\)/.test(ES) &&
    /setTimeout\(\(\) => process\.exit\(0\), delayMs\);/.test(ES) &&
    !/process\.stdin\.resume\(\)/.test(ES));

  // ⑥ listen 竞态（EADDRINUSE）走同一套判定，不再挂住。
  check('EADDRINUSE 竞态同样走 probeOwnPort 判定（不再挂「按任意键」）',
    /server\.on\('error', \(e\) => \{[\s\S]{0,700}?probeOwnPort\(\)\.then\(\(pre\) =>/.test(ES));
}

(async () => {
  console.log('== 后台模式不得打开浏览器 ==');
  if (!fs.existsSync(ENGINE)) {
    console.error('找不到 ' + ENGINE + '，请先 node tools/build-release.js');
    process.exit(1);
  }

  const before = browserProcs();
  console.log('  基线：浏览器进程 ' + before.size + ' 个');

  const child = spawn(ENGINE, ['--as-backend'], {
    detached: true, stdio: 'ignore', cwd: path.dirname(ENGINE),
  });
  child.unref();
  const pid = child.pid;
  console.log('  启动 pid=' + pid + ' --as-backend');

  await sleep(9000);

  const alive = (() => { try { process.kill(pid, 0); return true; } catch (e) { return false; } })();
  check('后台引擎进程存活', alive, 'pid=' + pid);
  check('引擎端口 :' + PORT + ' 已监听', await portOpen(PORT));

  // ★ 2026-09-18 根因修复的护栏：`/api/health` 是「:8964 上跑的是不是我们自己的引擎」的
  //   **唯一判据**。历史上这个路由**根本不存在** —— EADDRINUSE 分支去探它永远拿 404，
  //   于是被判定为「被别的程序占用」→ 卡在「按任意键退出」的黑窗口里赖着不走。
  //   发布版是加密 exe，肉眼看不见路由，所以必须在真 exe 上验。
  const h = await httpGet('/api/health');
  let hApp = null;
  try { hApp = JSON.parse(h && h.body).app; } catch (e) {}
  check('/api/health 存在且 app=GomokuEngine（端口归属的唯一判据）',
    !!h && h.code === 200 && hApp === 'GomokuEngine',
    h ? ('HTTP ' + h.code + ' app=' + hApp) : '无响应');

  const after = browserProcs();
  const added = [...after].filter((x) => !before.has(x));
  check('未新增任何浏览器进程', added.length === 0, added.length ? added.join(', ') : '无');

  // 重复拉起（端口已占用）：必须自己退出，不能挂在「按任意键退出」上。
  const dup = spawn(ENGINE, ['--as-backend'], {
    detached: true, stdio: 'ignore', cwd: path.dirname(ENGINE),
  });
  dup.unref();
  console.log('  重复拉起 pid=' + dup.pid + '（端口已占用）…');
  await sleep(6000);
  let dupAlive = true;
  try { process.kill(dup.pid, 0); } catch (e) { dupAlive = false; }
  check('端口冲突时后台实例自行退出（不挂住）', !dupAlive, dupAlive ? '仍在运行 — 发布版可能没带 GB_IS_BACKEND 守卫' : '已退出');

  const added2 = [...browserProcs()].filter((x) => !before.has(x));
  check('重复拉起也未新增浏览器进程', added2.length === 0, added2.length ? added2.join(', ') : '无');

  killTree(pid);
  try { process.kill(dup.pid, 0); killTree(dup.pid); } catch (e) {}
  await sleep(800);

  // ---- 端口被**别的程序**占用：必须打印明确提示并自动退出，绝不能挂住 ----
  // 这是用户现场的另一半：「打开练习器后再双击启动器 → 黑窗口赖着不走」。
  // 用假服务占住 :8964（回 200 但 app 不是 GomokuEngine）就能精确复现「foreign」分支。
  {
    const http = require('http');
    const dummy = http.createServer((rq, rs) => {
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end('{"hello":1}');
    });
    await new Promise((r) => dummy.listen(PORT, '127.0.0.1', r));
    const before2 = browserProcs();
    // ★ 故意**不带** --as-backend：走的就是「普通用户双击启动器」那条路。
    const launcher = spawn(ENGINE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(ENGINE) });
    launcher.unref();
    console.log('  外部程序占住 :' + PORT + ' 时启动非后台启动器 pid=' + launcher.pid + ' …');
    await sleep(9000);
    let stillAlive = true;
    try { process.kill(launcher.pid, 0); } catch (e) { stillAlive = false; }
    check('端口被外部程序占用时启动器自动退出（不再卡「按任意键」）', !stillAlive,
      stillAlive ? '仍在运行 —— 可能又退回按键等待 / 或误判成自己的引擎' : '已退出');
    const added3 = [...browserProcs()].filter((x) => !before2.has(x));
    check('外部占用端口时只提示、不开浏览器', added3.length === 0, added3.length ? added3.join(', ') : '无');
    try { killTree(launcher.pid); } catch (e) {}
    await new Promise((r) => dummy.close(r));
  }

  console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + e.message);
  process.exit(1);
});
