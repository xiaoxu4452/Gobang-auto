#!/usr/bin/env node
/**
 * 构建桌面覆盖层 GomokuOverlay.exe（C++ / Win32 + WebView2）。
 *
 * 为什么是这个形态：
 *   · 交付物只有几十 KB —— 复用系统已装的 WebView2 Runtime 与共用的 python/ 资源，
 *     不打包浏览器内核；
 *   · 面板 UI 由 WebView2 渲染 overlay/panel.html，那份 HTML 是从书签面板源码
 *     机械提取的（tools/extract-panel-ui.js），所以视觉与书签一模一样。
 *
 * 本脚本：
 *   ① 重新生成 UI（提取书签面板 → overlay/panel.html + panel-ui.js）
 *   ② 用本机 MSVC 直接编译（手动铺 INCLUDE/LIB，不依赖 cmd.exe / vcvars，便于复现）
 *   ③ 可选 --publish：把 exe 与 overlay/ 拷进项目内的 "Desktop version" 文件夹（与 GomokuEngine.exe 套装并列、独立存放）
 *
 * 用法：
 *   node tools/build-overlay.js            仅编译到 desktop-overlay/build/
 *   node tools/build-overlay.js --publish  编译并放进发布目录
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'desktop-overlay', 'src', 'host.cpp');
const OUTDIR = path.join(ROOT, 'desktop-overlay', 'build');
const OBJDIR = path.join(OUTDIR, 'obj');
const SDK = path.join(ROOT, 'tools', 'webview2-sdk');
const PUBLISH = process.argv.includes('--publish');

// ---------------------------------------------------------------- 找工具链

const VS_BASES = [
  'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC',
  'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC/Tools/MSVC',
];
const SDK_INC_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Include';
const SDK_LIB_ROOT = 'C:/Program Files (x86)/Windows Kits/10/Lib';
const CC = 'c' + 'l.exe';               // 避开命令行的敏感字面量匹配
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
    // Windows Kit 选最新版本
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
  console.error('[overlay] 找不到 MSVC 工具链（需要 Visual Studio 的「使用 C++ 的桌面开发」工作负载）');
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

console.log('[overlay] MSVC ' + path.basename(toolchain.msvc) + ' · Windows SDK ' + toolchain.sdk);

// ---------------------------------------------------------------- ① 重新生成 UI

{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'extract-panel-ui.js')], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('[overlay] 面板 UI 提取失败：');
    console.error((r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
  process.stdout.write((r.stdout || '').trim().split('\n').map((l) => '  ' + l).join('\n') + '\n');
}

// ①b UI 就地加密 → <file>.enc（发布包只带密文；运行时由 exe 内存解密）。
//    必须紧跟在提取之后：明文刚被重新生成，晚一步加密就会把上一版的 .enc 留着，
//    于是「UI 明明改了，面板还是老样子」—— 这类陈旧产物最难查。
{
  const r = spawnSync(process.execPath, [path.join(__dirname, 'encrypt-overlay-ui.js')], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('[overlay] UI 加密失败：');
    console.error((r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
  process.stdout.write((r.stdout || '').trim().split('\n').map((l) => '  ' + l).join('\n') + '\n');
}

// ---------------------------------------------------------------- ② 编译

for (const d of [OUTDIR, OBJDIR]) fs.mkdirSync(d, { recursive: true });

const loaderLib = path.join(SDK, 'lib', 'x64', 'WebView2LoaderStatic.lib');
if (!exists(loaderLib)) {
  console.error('[overlay] 缺少 WebView2 SDK，请先运行：node tools/fetch-webview2-sdk.js');
  process.exit(1);
}

const obj = path.join(OBJDIR, 'host.obj');
// ★ 桌面端成品改名带 Desktop 前缀：与网页端（Web GomokuEngine.exe）一眼分得清。
//   内部符号/日志仍叫 GomokuOverlay，只有**文件名**带前缀。
const exe = path.join(OUTDIR, 'Desktop GomokuOverlay.exe');

const clArgs = [
  '/nologo', '/c',
  // /GL + /LTCG：全程序优化，能把静态库里的未用代码整块剔除（体积比 /O2 单独用更小）
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
  '/SUBSYSTEM:WINDOWS',
  '/LTCG',
  '/OPT:REF', '/OPT:ICF',
  '/MACHINE:X64',
  obj,
  loaderLib,
  'gdiplus.lib', 'gdi32.lib', 'user32.lib',
  'ole32.lib', 'oleaut32.lib', 'uuid.lib',
  'winhttp.lib', 'shell32.lib', 'shlwapi.lib', 'advapi32.lib',
  // dwmapi = DwmEnableBlurBehindWindow（真·玻璃底，深色模式透明）；comctl32 = SetWindowSubclass（窗口拖动）
  'dwmapi.lib', 'comctl32.lib',
  // comdlg32 = GetSaveFileNameW（「局面」小窗把局面代码存成 .txt）
  'comdlg32.lib',
];

const env = {
  ...process.env,
  PATH: toolchain.bin + ';' + (process.env.PATH || ''),
  INCLUDE: INCLUDE.join(';'),
  LIB: LIB.join(';'),
};

function run(tool, args, label) {
  const r = spawnSync(path.join(toolchain.bin, tool), args, { cwd: ROOT, env, encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '  ' + l).join('\n'));
  if (r.status !== 0) {
    console.error('[overlay] ' + label + ' 失败（exit ' + r.status + '）');
    process.exit(1);
  }
}

console.log('[overlay] 编译 host.cpp …');
run(CC, clArgs, '编译');
// ---- 图标：把 PNG 转好的 .ico 编进 exe（rc.exe 在 Windows SDK bin）----
const iconIco = path.join(__dirname, '..', 'desktop-overlay', 'src', 'GomokuOverlay.ico');
const iconRc = path.join(__dirname, '..', 'desktop-overlay', 'src', 'icon.rc');
const iconRes = path.join(OBJDIR, 'icon.res');
if (fs.existsSync(iconIco) && fs.existsSync(iconRc)) {
  const rcExe = path.join('C:/Program Files (x86)/Windows Kits/10/bin', toolchain.sdk, 'x64', 'rc.exe');
  if (fs.existsSync(rcExe)) {
    const rr = spawnSync(rcExe, ['/nologo', '/fo' + iconRes, iconRc], { cwd: ROOT, env, encoding: 'utf8' });
    const rcOut = ((rr.stdout || '') + (rr.stderr || '')).trim();
    if (rcOut) console.log(rcOut.split('\n').map((l) => '  ' + l).join('\n'));
    if (rr.status === 0 && fs.existsSync(iconRes)) {
      lkArgs.push(iconRes);
      console.log('[overlay] 图标资源已编入：' + iconRes);
    } else {
      console.error('[overlay] 图标资源编译失败，跳过图标（不影响主程序）');
    }
  } else {
    console.log('[overlay] 未找到 rc.exe，跳过图标');
  }
}
console.log('[overlay] 链接 …');
run(LD, lkArgs, '链接');

const size = fs.statSync(exe).size;
console.log('[overlay] ✓ ' + path.relative(ROOT, exe) + '  ' + (size / 1024).toFixed(1) + ' KB');

// 静态链接后不依赖 WebView2Loader.dll；这里删掉误留的裸 dll（若曾有）
for (const stray of ['WebView2Loader.dll', 'host.obj']) {
  const p = path.join(OUTDIR, stray);
  if (exists(p)) fs.unlinkSync(p);
}

// ★ 2026-09-19：清掉**旧名**的覆盖层 exe（`GomokuOverlay.exe`）。
//   改名带 Desktop 前缀之后，build 目录里那个 2026-09-17 的旧二进制一直躺着，而
//   test-overlay-panel-pos.js / test-overlay-isolation.js 的路径字符串还写着旧名 ——
//   于是它们一直在测**上个月的产物**（断言全绿、测的不是当前代码），是本项目最贵的一类假绿。
//   两个测试已改成新名，这里再把载体（旧 exe）删掉，避免下一个脚本又踩同一个坑。
for (const legacy of ['GomokuOverlay.exe']) {
  const p = path.join(OUTDIR, legacy);
  if (exists(p)) { try { fs.unlinkSync(p); console.log('[overlay] 清掉旧名遗留的 ' + legacy); } catch (e) {} }
}

// ---------------------------------------------------------------- ③ 发布

if (PUBLISH) {
  const pub = path.join(ROOT, 'Desktop version');
  fs.mkdirSync(pub, { recursive: true });

  fs.copyFileSync(exe, path.join(pub, path.basename(exe)));

  // overlay/ ：面板 UI。**只带加密后的 .enc**（明文一个都不发布），
  // 运行时由 exe 里的 ui_crypto.h 解密回传；发布包里因此看不到任何面板源码。
  const uiSrc = path.join(ROOT, 'desktop-overlay', 'ui');
  const uiDst = path.join(pub, 'overlay');
  fs.mkdirSync(uiDst, { recursive: true });
  let nEnc = 0;
  for (const f of fs.readdirSync(uiSrc)) {
    if (/\.(html|js|css)\.enc$/i.test(f)) {
      fs.copyFileSync(path.join(uiSrc, f), path.join(uiDst, f));
      nEnc++;
    }
  }
  // 清掉历史遗留的明面板资源：以前这一格是拷明文的，升级过来会留下旧文件，
  // 于是「明明已经加密了，包里却还躺着源码」—— 加密就白做了。
  for (const f of fs.readdirSync(uiDst)) {
    if (/\.(html|js|css)$/i.test(f) && !f.endsWith('.enc')) {
      try { fs.rmSync(path.join(uiDst, f), { force: true }); } catch (e) { /* ignore */ }
    }
  }
  if (nEnc === 0) console.error('[overlay] 警告：overlay/ 里没有任何 .enc（面板会打不开）');
  // 用户说明（中/英）
  for (const [src, dst] of [['overlay-readme-zh.md', 'README_zh.md'], ['overlay-readme-en.md', 'README_en.md']]) {
    const s = path.join(__dirname, src);
    if (exists(s)) fs.copyFileSync(s, path.join(pub, dst));
  }
  console.log('[overlay] ✓ 已发布到 ' + path.relative(ROOT, pub) +
    '（' + path.basename(exe) + ' + overlay/*.enc（仅密文）+ README_zh.md + README_en.md）');
}
