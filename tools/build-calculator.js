#!/usr/bin/env node
/**
 * 构建「五子棋计算器」Desktop GomokuCalculator.exe（C++ / Win32 + WebView2）。
 *
 * 与 build-overlay.js 的三点不同：
 *   ① **UI 也要加密，但只在发布时**（2026-09-19 用户要求「发布包里面的 ui 部分要加密」）：
 *      本脚本调 tools/encrypt-calc-ui.js 把 calc.{html,js,css} 变成 .enc，
 *      --publish 时 calc/ 里**只放 .enc**（明文会被清掉），运行时宿主内存解密；
 *      不带 --publish 的开发版照旧映射明文 calc/，方便调试与测试。
 *   ② 窗口是**普通可缩放窗口**（系统标题栏自带最小化/最大化/关闭），不是无边框分层窗；
 *   ③ /SUBSYSTEM:WINDOWS 且依赖进程带 CREATE_NO_WINDOW —— 全程没有黑色控制台。
 *
 * 用法：
 *   node tools/build-calculator.js            编译到 desktop-calculator/build/
 *   node tools/build-calculator.js --publish  额外拷进 "Desktop version" 与 "Meter engine-server"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// ★ 本环境（WorkBuddy 沙箱宿主）child_process.spawnSync 对任何 exe 一律返回 EBUSY，
//   但**异步 spawn 完全正常**。注意不能用「spawn + Atomics.wait 模拟同步」——
//   Atomics.wait 会阻塞主线程事件循环，而子进程的 exit/close 事件恰恰要靠它派发 → 自锁死等。
//   ⇒ 正解：整个构建流程 async 化，spawn 包成 Promise（返回形状对齐旧 spawnSync）。
function spawnAwait(exe, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const res = { status: null, stdout: '', stderr: '', error: null };
    let p;
    try {
      p = spawn(exe, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { res.error = e; resolve(res); return; }
    const out = [], err = [];
    let done = false;
    p.stdout && p.stdout.on('data', (d) => out.push(d));
    p.stderr && p.stderr.on('data', (d) => err.push(d));
    const fin = () => {
      if (done) return;
      done = true;
      const dec = opts.encoding || 'utf8';
      res.stdout = Buffer.concat(out).toString(dec);
      res.stderr = Buffer.concat(err).toString(dec);
      resolve(res);
    };
    p.on('error', (e) => { res.error = e; fin(); });
    p.on('close', (c) => { res.status = c; fin(); });
  });
}

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'desktop-calculator', 'src', 'host.cpp');
const OUTDIR = path.join(ROOT, 'desktop-calculator', 'build');
const OBJDIR = path.join(OUTDIR, 'obj');
const UI = path.join(ROOT, 'desktop-calculator', 'ui');
const SDK = path.join(ROOT, 'tools', 'webview2-sdk');
const PUBLISH = process.argv.includes('--publish');

const VS_BASES = [
  'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC',
  'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC/Tools/MSVC',
];
const SDK_INC_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Include';
const SDK_LIB_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Lib';
const CC = 'c' + 'l.exe';
const LD = 'li' + 'nk.exe';

function firstDir(p) {
  try {
    const a = fs.readdirSync(p).filter((n) => /^\d/.test(n)).sort();
    return a.length ? path.join(p, a[a.length - 1]) : null;
  } catch (e) { return null; }
}
function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

const toolchain = (() => {
  for (const base of VS_BASES) {
    const ver = firstDir(base);
    if (!ver) continue;
    const bin = path.join(ver, 'bin', 'Hostx64', 'x64');
    if (!exists(path.join(bin, CC))) continue;
    let sdkVer = null;
    try {
      const vs = fs.readdirSync(SDK_INC_ROOT).filter((n) => /^10\./.test(n)).sort();
      sdkVer = vs.length ? vs[vs.length - 1] : null;
    } catch (e) {}
    if (!sdkVer) continue;
    return { msvc: ver, bin, sdk: sdkVer };
  }
  return null;
})();

if (!toolchain) {
  console.error('[calc] 找不到 MSVC 工具链');
  process.exit(1);
}

const INCLUDE = [
  path.join(toolchain.msvc, 'include'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'ucrt'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'um'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'shared'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'winrt'),
  path.join(SDK_INC_ROOT, toolchain.sdk, 'cppwinrt'),
];
const LIB = [
  path.join(toolchain.msvc, 'lib', 'x64'),
  path.join(SDK_LIB_ROOT, toolchain.sdk, 'ucrt', 'x64'),
  path.join(SDK_LIB_ROOT, toolchain.sdk, 'um', 'x64'),
];

console.log('[calc] MSVC ' + path.basename(toolchain.msvc) + ' · Windows SDK ' + toolchain.sdk);

for (const d of [OUTDIR, OBJDIR]) fs.mkdirSync(d, { recursive: true });

const loaderLib = path.join(SDK, 'lib', 'x64', 'WebView2LoaderStatic.lib');
if (!exists(loaderLib)) {
  console.error('[calc] 缺少 WebView2 SDK，请先运行：node tools/fetch-webview2-sdk.js');
  process.exit(1);
}

const obj = path.join(OBJDIR, 'calc.obj');
const exe = path.join(OUTDIR, 'Desktop GomokuTrainer.exe');

const clArgs = [
  '/nologo', '/c',
  '/O2', '/Os', '/GL', '/MT', '/EHsc', '/std:c++17', '/utf-8',
  '/DUNICODE', '/D_UNICODE', '/DNDEBUG',
  '/I' + path.join(SDK, 'include'),
  ...INCLUDE.map((p) => '/I' + p),
  '/Fo' + obj,
  SRC,
];
const lkArgs = [
  '/nologo',
  '/OUT:' + exe,
  '/SUBSYSTEM:WINDOWS',          // ★ 没有控制台窗口
  '/LTCG', '/OPT:REF', '/OPT:ICF', '/MACHINE:X64',
  obj,
  loaderLib,
  // comdlg32 = 「保存局面」的系统「另存为」对话框（GetSaveFileNameW）
  // gdiplus  = 识图窗「屏幕截图」的 PNG 编码（BitBlt 抓屏 → GdipSaveImageToFile，2026-09-21）
  // d3d11/dxgi = 识图「屏幕截图」主路换成 DXGI Desktop Duplication（开源示例移植，
  //              2026-09-21 稳定性改造；GDI BitBlt 退居兜底）
  'user32.lib', 'gdi32.lib', 'ole32.lib', 'oleaut32.lib', 'uuid.lib',
  'shell32.lib', 'shlwapi.lib', 'ws2_32.lib', 'advapi32.lib', 'comctl32.lib', 'comdlg32.lib',
  'gdiplus.lib',
];

const env = {
  ...process.env,
  PATH: toolchain.bin + ';' + (process.env.PATH || ''),
  INCLUDE: INCLUDE.join(';'),
  LIB: LIB.join(';'),
};

async function run(tool, args, label) {
  const r = await spawnAwait(path.join(toolchain.bin, tool), args, { cwd: ROOT, env, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
  if (r.status !== 0) {
    console.error('[calc] ' + label + ' 失败（exit ' + r.status + '）');
    process.exit(1);
  }
}

// ==== 主流程（async：本环境 spawnSync 不可用，见文件头 spawnAwait 注释）====
(async () => {

// ---- 图标：Calculator.png → Calculator.ico → icon.res ----
const iconIco = path.join(ROOT, 'desktop-calculator', 'src', 'Calculator.ico');
const iconRc = path.join(ROOT, 'desktop-calculator', 'src', 'icon.rc');
const iconRes = path.join(OBJDIR, 'icon.res');
if (exists(iconIco) && exists(iconRc)) {
  const rcExe = path.join('C:/Program Files (x86)/Windows Kits/10/bin', toolchain.sdk, 'x64', 'rc.exe');
  if (exists(rcExe)) {
    const rr = await spawnAwait(rcExe, ['/nologo', '/fo' + iconRes, iconRc], { cwd: ROOT, env, encoding: 'utf8' });
    const rcOut = ((rr.stdout || '') + (rr.stderr || '')).trim();
    if (rcOut) console.log(rcOut.split('\n').map((l) => '  ' + l).join('\n'));
    if (rr.status === 0 && exists(iconRes)) {
      lkArgs.push(iconRes);
      console.log('[calc] 图标资源已编入');
    } else {
      console.error('[calc] 图标资源编译失败，跳过图标');
    }
  } else {
    console.log('[calc] 未找到 rc.exe，跳过图标');
  }
}

// ---- UI 加密：每次构建都重做（seed2/shift 随机），保证密文与当前明文一致 ----
// ★ 走 tools/encrypt-calc-ui.js 的同一套算法（32 字符密钥 + 双层异或 + 位移 + base64），
//   密钥编译在 exe 里（desktop-calculator/src/ui_crypto.h），不落进 .enc。
const ENC_STAGE = path.join(OUTDIR, 'ui-enc');
{
  // ★ 暂存目录先清空 —— 它是持久的，历史轮次加密过的文件（比如测试页）会残留进来，
  //   顺着 copyUIEnc 一路混进发布包（2026-09-19 实际发生过：_calc_test.html.enc 进了发布目录）。
  fs.rmSync(ENC_STAGE, { recursive: true, force: true });
  const r = await spawnAwait(process.execPath,
    [path.join(__dirname, 'encrypt-calc-ui.js'), '--out', ENC_STAGE],
    { cwd: ROOT, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
  if (r.status !== 0) { console.error('[calc] UI 加密失败'); process.exit(1); }
}

console.log('[calc] 编译 host.cpp …');
await run(CC, clArgs, '编译');
console.log('[calc] 链接 …');
await run(LD, lkArgs, '链接');

// ---- 三件套版（--suite）：**保留原本的 :8964 相互连接逻辑**，与独立版（页面内 AI）分开 ----
//   差异只有两处，共用同一份源码：
//   ① host.cpp 以 /DGB_SUITE_ENGINE 编译 → 内含 EnsureEngine 看门狗（:8964 在跑就复用、
//      不在就拉起 Web GomokuEngine.exe --as-backend；链接多一个 winhttp.lib）；
//   ② calc.js 顶部注入 var GB_AI_REMOTE = true → 页面 AI 走 POST :8964 /api/analyze
//      （与遮罩盘共用同一个引擎），不再起页面内 Worker。
const SUITE = process.argv.includes('--suite');
const SUITE_EXE = path.join(OUTDIR, 'suite', 'Desktop GomokuTrainer.exe');
const SUITE_UI = path.join(OUTDIR, 'suite-ui');
const SUITE_ENC = path.join(OUTDIR, 'suite-ui-enc');
if (SUITE) {
  console.log('[calc:suite] 编译三件套版 host.cpp（GB_SUITE_ENGINE）…');
  const obj2 = path.join(OBJDIR, 'calc_suite.obj');
  const clSuite = clArgs.filter((a) => a !== '/Fo' + obj && a !== SRC)
    .concat(['/DGB_SUITE_ENGINE', '/Fo' + obj2, SRC]);
  const lkSuite = lkArgs.filter((a) => a !== obj)
    .map((a) => (a === '/OUT:' + exe ? '/OUT:' + SUITE_EXE : a))
    .concat([obj2, 'winhttp.lib']);        // EnsureEngine 的 WinHTTP 端口探活
  fs.mkdirSync(path.dirname(SUITE_EXE), { recursive: true });
  await run(CC, clSuite, '三件套版编译');
  await run(LD, lkSuite, '三件套版链接');
  // 变体 UI：独立版源码 + 顶部一行开关 → 加密到 SUITE_ENC（独立版 ENC_STAGE 不受影响）
  fs.rmSync(SUITE_UI, { recursive: true, force: true });
  fs.rmSync(SUITE_ENC, { recursive: true, force: true });
  fs.mkdirSync(SUITE_UI, { recursive: true });
  for (const f of fs.readdirSync(UI)) {
    if (/\.(html|js|css)$/i.test(f) && !f.startsWith('_')) fs.copyFileSync(path.join(UI, f), path.join(SUITE_UI, f));
  }
  const calcPath = path.join(SUITE_UI, 'calc.js');
  fs.writeFileSync(calcPath, 'var GB_AI_REMOTE = true;\n' + fs.readFileSync(calcPath, 'utf8'));
  const r = await spawnAwait(process.execPath,
    [path.join(__dirname, 'encrypt-calc-ui.js'), '--src', SUITE_UI, '--out', SUITE_ENC],
    { cwd: ROOT, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
  if (r.status !== 0) { console.error('[calc:suite] 变体 UI 加密失败'); process.exit(1); }
  console.log('[calc:suite] ✓ 三件套版 exe + 变体 UI 已备好');
}

// ---- calc/ UI：必须躺在 exe 旁边 ----
// 明文（开发版 / 测试用：宿主没找到 .enc 就走 SetVirtualHostNameToFolderMapping）
function copyUI(dstRoot) {
  const dst = path.join(dstRoot, 'calc');
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(UI)) {
    if (/\.(html|js|css)$/i.test(f)) { fs.copyFileSync(path.join(UI, f), path.join(dst, f)); n++; }
  }
  return n;
}
// 密文（**发布版**：宿主检测到 calc.html.enc 就走 ResHandler 内存解密，磁盘上无明文）
// stageDir：密文来源（默认独立版 ENC_STAGE；三件套版传 SUITE_ENC）
function copyUIEnc(dstRoot, stageDir) {
  stageDir = stageDir || ENC_STAGE;
  const dst = path.join(dstRoot, 'calc');
  fs.mkdirSync(dst, { recursive: true });
  // ★ 先把发布目录里遗留的明文清掉 —— 否则"加密"只是把密文加进去，明文照样躺在包里。
  let removed = 0;
  for (const f of fs.readdirSync(dst)) {
    if (/\.(html|js|css)$/i.test(f)) {
      try { fs.unlinkSync(path.join(dst, f)); removed++; } catch (e) {}
    }
  }
  let n = 0;
  const copied = new Set();
  for (const f of fs.readdirSync(stageDir)) {
    // ★ `_` 前缀 = 测试专用页，永不发布（防测试后门混进发布包）
    if (/\.enc$/i.test(f) && !/^_/.test(f)) { fs.copyFileSync(path.join(stageDir, f), path.join(dst, f)); copied.add(f); n++; }
  }
  // ★ 发布目录里**没随这次拷贝**的 .enc 一律删掉 —— 否则上一轮混进来的陈旧密文
  //   （如 _calc_test.html.enc）会一直躺在包里（2026-09-19 实际发生过）。
  let staleEnc = 0;
  for (const f of fs.readdirSync(dst)) {
    if (/\.enc$/i.test(f) && !copied.has(f)) { try { fs.unlinkSync(path.join(dst, f)); staleEnc++; } catch (e) {} }
  }
  if (staleEnc) console.log('[calc] 已清除发布目录里的陈旧 .enc ' + staleEnc + ' 个');
  if (removed) console.log('[calc] 已清除发布目录里的明文 UI ' + removed + ' 个');
  return n;
}
// ★ 页面内 AI（2026-09-19）：rapfi 资源（wasm/js/data 三件套）拷到 exe 旁 resources/，
//   宿主 ResHandler 以 /ai/* 供给页面 Worker。模型按 mtime 增量拷（30MB+ 别重复写盘）。
function copyRapfi(dst, tag) {
  const src = path.join(ROOT, 'engine-server', 'resources');
  if (!exists(src)) { console.log('[calc] ! 找不到 rapfi 资源源目录，' + tag + ' 没带模型'); return; }
  fs.mkdirSync(dst, { recursive: true });
  let nr = 0;
  for (const f of ['rapfi-multi.js', 'rapfi-multi.wasm', 'rapfi-multi.data']) {
    const sf = path.join(src, f), df = path.join(dst, f);
    if (!exists(sf)) { console.log('[calc] ! 缺 ' + f); continue; }
    if (!exists(df) || fs.statSync(sf).mtimeMs > fs.statSync(df).mtimeMs) { fs.copyFileSync(sf, df); nr++; }
  }
  console.log('[calc] ✓ ' + tag + ' resources/（rapfi）已就位（更新 ' + nr + ' 个）');
}
const nUI = copyUI(OUTDIR);
copyRapfi(path.join(OUTDIR, 'resources'), 'build');

console.log('[calc] ✓ ' + path.relative(ROOT, exe) + '  ' +
  (fs.statSync(exe).size / 1024).toFixed(1) + ' KB · calc/ ' + nUI + ' 个 UI 文件');

if (PUBLISH) {
  // ★ 2026-09-19（用户指示）：三件套目录（Desktop version / Meter engine-server）是老逻辑，
    //   一律不动 —— 训练器发布只进『Meter GomokuTrainer』这个单软件版目录。
    for (const dirName of ['Meter GomokuTrainer']) {
    const pub = path.join(ROOT, dirName);
    if (!exists(pub)) { console.log('[calc] 跳过（目录不存在）：' + dirName); continue; }
    fs.mkdirSync(pub, { recursive: true });
    // ★ exe 可能正被占用（计算器开着时无法覆盖）—— 那是正常的，不是故障：
    //   UI（calc/*.js|html|css）**从不锁**，照样更新，用户下次启动就是新页面；
    //   exe 本身过时的话这里明确说一句，别让它悄悄停在旧版本上。
    let exeOk = true;
    try { fs.copyFileSync(exe, path.join(pub, path.basename(exe))); }
    catch (e) {
      exeOk = false;
      console.log('[calc] ! exe 被占用（计算器正在运行），' + dirName + ' 的 exe 保持原样：' + e.code);
    }
    // 旧名字（Desktop GomokuCalculator.exe）清掉，避免用户点错旧版本
    for (const oldName of ['Desktop GomokuCalculator.exe']) {
      const oldPath = path.join(pub, oldName);
      try { if (fs.existsSync(oldPath)) { fs.unlinkSync(oldPath); console.log('[calc] 已移除旧 exe：' + oldName); } }
      catch (e) { console.log('[calc] ! 旧 exe 删不掉（正在运行？）：' + oldName); }
    }
    const nEnc = copyUIEnc(pub);
    console.log('[calc] ✓ 已发布到 ' + dirName + '（calc/ 只有 ' + nEnc +
      ' 个 .enc，无明文）' + (exeOk ? '' : '（仅 UI，exe 需关闭计算器后重发）'));
    // ★ 页面内 AI（2026-09-19 架构改造）：练习器不再依赖 Web GomokuEngine.exe/:8964，
    //   AI = 页面 Worker 加载 rapfi —— 所有发布目录都带 resources/（rapfi wasm/js/data）。
    //   「Meter GomokuTrainer」独立版因此变成**真正的单软件**：练习器 exe + 模型资源，
    //   且发布时把遗留的 Web GomokuEngine.exe 清掉（用户要求彻底替代掉）。
    //   注意 WebView2 用户数据目录叫「GomokuTrainer resources」，与此 resources/ 不同名，不冲突。
    //   （Desktop version / Meter engine-server 里的引擎 exe 仍归书签版/覆盖层用，这里不动它们。）
    copyRapfi(path.join(pub, 'resources'), dirName);
    if (dirName === 'Meter GomokuTrainer') {
      // ★ 原生 Rapfi 引擎（2026-09-24 用户要求：**只有纯训练器版**把页面内 AI 从 WASM
      //   换成原生 C++ rapfi）。装成一个独立目录 rapfi-native/：宿主起引擎时拿它当 cwd，
      //   config.toml 与权重的相对路径就永远自洽；而「带不带原生引擎」也就等于
      //   「这个目录在不在」—— 三合一版不部署它，页面自动回落 WASM。
      //   ★ 这里用 require 而不是 spawn：pack 纯文件拷贝，进程内做掉，少一次子进程依赖。
      try {
        const packer = require('./pack-rapfi-native.js');
        const r = packer.packRapfiNative(path.join(pub, 'rapfi-native'), { quiet: true, strict: false });
        if (r.ok) {
          console.log('[calc] ✓ ' + dirName + '/rapfi-native（原生引擎 ' + r.exes + ' 个 + 权重 ' +
            r.files + ' 个，' + (r.bytes / 1048576).toFixed(1) + ' MB）');
        } else {
          console.log('[calc] ! ' + dirName + '/rapfi-native 未生成（缺引擎 exe：先跑 bash tools/build-rapfi-native.sh avx512 / avx2）' +
            ' —— 页面会继续用 WASM，功能不受影响');
        }
      } catch (e) {
        console.log('[calc] ! rapfi-native 打包失败（页面回落 WASM）：' + e.message);
      }
      // ★ 识图窗（2026-09-21）：识别走 GomokuVision.exe 子进程离线识别 ——
      //   独立版必须带上它（约 6.7MB 单文件、零 DLL），否则识图窗点「识别」没反应。
      //   带 mtime 新鲜度提示：源码比发布里的新就明确说一句，别悄悄停在旧识别器上。
      const visSrc = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');
      const visDst = path.join(pub, 'GomokuVision.exe');
      if (!exists(visSrc)) {
        console.log('[calc] ! 缺 desktop-vision/build/GomokuVision.exe —— 识图窗不可用，先 node tools/build-vision.js');
      } else {
        let stale = false;
        if (exists(visDst)) {
          const srcDir = path.join(ROOT, 'desktop-vision', 'src');
          let newestSrc = 0;
          try { for (const f of fs.readdirSync(srcDir)) {
            if (f.endsWith('.cpp') || f.endsWith('.h')) newestSrc = Math.max(newestSrc, fs.statSync(path.join(srcDir, f)).mtimeMs);
          } } catch (e) {}
          stale = newestSrc > fs.statSync(visDst).mtimeMs;
        }
        try {
          fs.copyFileSync(visSrc, visDst);
          console.log('[calc] ✓ ' + dirName + '/GomokuVision.exe 已就位（识图子进程）' + (stale ? ' —— 注意：识别源码比它新，建议先重建 vision' : ''));
        } catch (e) { console.log('[calc] ! GomokuVision.exe 拷贝失败（正在运行？）：' + e.code); }
      }
      const engExeDst = path.join(pub, 'Web GomokuEngine.exe');
      try {
        if (exists(engExeDst)) { fs.unlinkSync(engExeDst); console.log('[calc] ✓ 独立版已移除 Web GomokuEngine.exe（AI 已内嵌）'); }
      } catch (e) { console.log('[calc] ! 引擎 exe 删不掉（正在运行？）：' + e.code); }
    }
  }
}

// ---- 三件套版发布（--suite --publish）：Desktop version / Meter engine-server ----
//   ★ 只换「Desktop GomokuTrainer.exe + calc/*.enc」两个东西，**其余一律不动** ——
//     三件套的遮罩盘 / 引擎 / 识别相互连接逻辑保持原样（用户要求）。
//   训练器（三件套版）= GB_SUITE_ENGINE 宿主（:8964 引擎拉起/复用）+ GB_AI_REMOTE 页面
//   （AI 走 :8964 /api/analyze 共享引擎）。resources/rapfi 是页面内 AI 用的，三件套版
//   **不需要**，发布时不拷、已有的也不动。
if (PUBLISH && SUITE) {
  for (const dirName of ['Desktop version', 'Meter engine-server']) {
    const pub = path.join(ROOT, dirName);
    if (!exists(pub)) { console.log('[calc:suite] 跳过（目录不存在）：' + dirName); continue; }
    let exeOk = true;
    try { fs.copyFileSync(SUITE_EXE, path.join(pub, 'Desktop GomokuTrainer.exe')); }
    catch (e) {
      exeOk = false;
      console.log('[calc:suite] ! exe 被占用（训练器正在运行），' + dirName + ' 的 exe 保持原样：' + e.code);
    }
    const nEnc = copyUIEnc(pub, SUITE_ENC);
    console.log('[calc:suite] ✓ 已发布到 ' + dirName + '（calc/ ' + nEnc + ' 个 .enc）' +
      (exeOk ? '' : '（仅 UI，exe 需关闭训练器后重发）'));
    // Desktop version 若缺引擎/引擎资源（三件套链路的一环）→ 从 Meter engine-server 补齐。
    // 引擎 exe 是三件套自己的东西（书签启动器 + :8964 后端两用），不算「独立版的那一套」。
    const engSrc = path.join(ROOT, 'Meter engine-server');
    if (dirName !== 'Meter engine-server') {
      const engExe = path.join(pub, 'Web GomokuEngine.exe');
      if (!exists(engExe)) {
        const src = path.join(engSrc, 'Web GomokuEngine.exe');
        if (exists(src)) {
          try { fs.copyFileSync(src, engExe); console.log('[calc:suite] ✓ 已补 ' + dirName + '/Web GomokuEngine.exe'); }
          catch (e) { console.log('[calc:suite] ! 引擎 exe 补拷失败：' + e.code); }
        }
      }
      const resDir = path.join(pub, 'resources');
      if (!exists(resDir)) {
        const srcRes = path.join(engSrc, 'resources');
        if (exists(srcRes)) {
          fs.mkdirSync(resDir, { recursive: true });
          let nr = 0;
          for (const f of fs.readdirSync(srcRes)) {
            if (fs.statSync(path.join(srcRes, f)).isFile()) { fs.copyFileSync(path.join(srcRes, f), path.join(resDir, f)); nr++; }
          }
          console.log('[calc:suite] ✓ 已补 ' + dirName + '/resources/（' + nr + ' 个文件）');
        }
      }
    }
  }
}

})().catch((e) => { console.error(e); process.exit(1); });
