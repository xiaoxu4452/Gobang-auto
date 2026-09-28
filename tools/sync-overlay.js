#!/usr/bin/env node
/**
 * 把「桌面覆盖层」的产物同步进已发布的套装目录。
 *
 * 为什么单独做一个脚本：tools/build-release.js 会重建整套发布包（含 330MB 便携 Python、
 * 83MB 引擎 exe、再跑一遍 SEA 注入），耗时数分钟。而覆盖层（host.cpp / ui/*）改动的
 * 时候，发布包里真正变动的只有 4 个文件，没必要为此重跑整条链路。
 *
 * 同步内容与 build-release.js 的 3e 段完全一致：
 *   desktop-overlay/build/Desktop GomokuOverlay.exe → <发布目录>/Desktop GomokuOverlay.exe
 *   desktop-overlay/ui/*.{html,js,css}.enc          → <发布目录>/overlay/（只带密文）
 *
 * 用法：node tools/sync-overlay.js [发布目录名，默认 "Desktop version"]
 * 前置：先跑 node tools/build-overlay.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const relName = process.argv[2] || 'Desktop version';
const projDir = path.join(ROOT, relName);

let bad = 0;
function die(msg) { console.error('[sync-overlay] ✗ ' + msg); process.exit(1); }

const EXE_NAME = 'Desktop GomokuOverlay.exe';
const exe = path.join(ROOT, 'desktop-overlay', 'build', EXE_NAME);
const uiDir = path.join(ROOT, 'desktop-overlay', 'ui');
const UI_FILES = ['panel.html', 'panel-ui.js', 'bridge.js'];
// 发布只带加密产物：明文 UI 一个都不进包。
const ENC_FILES = UI_FILES.map((f) => f + '.enc');

if (!fs.existsSync(exe)) die('找不到覆盖层 exe（' + EXE_NAME + '），请先跑 node tools/build-overlay.js');
fs.mkdirSync(projDir, { recursive: true });

// 一致性自检：面板 HTML 里必须已经带桌面版定位覆盖，否则同步过去的是旧模板。
const html = fs.readFileSync(path.join(uiDir, 'panel.html'), 'utf8');
if (!/top:0/.test(html) || !/left:0/.test(html) || !/right:auto/.test(html) || !/bottom:auto/.test(html)) {
  die('panel.html 不含桌面版定位（top:0/left:0/right:auto/bottom:auto）——请先跑 tools/build-overlay.js');
}
// ⚠️ 回归护栏：面板高度上限**绝不能用 vh**。
// 视口高度 = 宿主窗口高度 = 面板高度，三者同一个数；用它当上限就是正反馈，
// 每轮把面板压小约 6%，几十轮后缩成一条线（实测 595→556→520→…→399）。
if (/max-height:\s*100vh/.test(html) || /max-height:\s*\d+vh/.test(html)) {
  die('panel.html 用了 vh 作为 max-height —— 会形成「视口↔窗口↔面板」正反馈把面板压塌，'
      + '上限必须由 bridge.js 按 screen.availHeight 以像素写入 style.maxHeight');
}
// ★ 桌面版**不落子**（用户方案 2026-09-16）：面板里不允许再出现任何落子开关。
//   抽取器已经拦过一次；这里再拦一次，因为「发布包里的 panel.html 是旧的」是最常见的翻车方式
//   ——改了源码忘了重建，或从旧包手拷回来，用户就会看到一个点下去会自己下棋的按钮。
for (const gone of ['__gb_auto', '__gb_autocap', '__gb_clickn', 'data-i18n="auto"']) {
  if (html.indexOf(gone) >= 0) {
    die('panel.html 残留落子控件「' + gone + '」——桌面版只做指导（蓝圈/热力图），不替用户落子');
  }
}
// ★ 桌面版**没有「对手落点评估」**（用户要求 2026-09-17）。同样是双保险：
//   抽取器在生成时已摘掉并自检，这里再拦一次，防止旧模板被同步进发布目录。
if (html.indexOf('__gb_opp') >= 0 || html.indexOf('oppMoves') >= 0) {
  die('panel.html 残留「对手落点评估」控件 —— 桌面版该功能已取消（见 extract-panel-ui.js 增量⑦）');
}
// ★ 用户要求桌面弹窗做成**直角**：容器样式的末尾必须把书签版的 border-radius:10px 覆盖成 0。
//   只改窗口 region 不够 —— 窗口是方的、面板自己还画着圆角，四角会各露一块桌面。
{
  const m = /id="__gb_panel" style="([^"]*)"/.exec(html);
  if (!m || !/border-radius:0;\s*$/.test(m[1])) {
    die('panel.html 的 #__gb_panel 不是直角（缺少末尾的 border-radius:0）——请先跑 tools/build-overlay.js');
  }
}
if (!/display:flex/.test(html) || !/flex-direction:column/.test(html)) {
  die('panel.html 缺少桌面版的纵向 flex 布局（面板头部固定 + 内容区滚动）');
}
if (!/__gb_body\{overflow-y:auto/.test(html)) {
  die('panel.html 缺少 #__gb_body 滚动样式——请先跑 tools/build-overlay.js');
}
// bridge.js 里不能再残留已被删掉的 placePanel 调用（历史回归点）。
const bridge = fs.readFileSync(path.join(uiDir, 'bridge.js'), 'utf8');
if (/placePanel\s*\(/.test(bridge)) die('bridge.js 仍调用已删除的 placePanel()');
if (!/dpr:\s*Math\.round\(dpr/.test(bridge)) die('bridge.js 未上报 devicePixelRatio（宿主无法正确换算窗口物理尺寸）');
if (!/applyMaxHeight/.test(bridge)) die('bridge.js 缺少 applyMaxHeight（面板高度上限的唯一来源）');

fs.copyFileSync(exe, path.join(projDir, EXE_NAME));
console.log('[sync-overlay] ✓ ' + EXE_NAME + '  ' + (fs.statSync(exe).size / 1024).toFixed(1) + ' KB');

const ovDst = path.join(projDir, 'overlay');
fs.mkdirSync(ovDst, { recursive: true });
for (const f of ENC_FILES) {
  const s = path.join(uiDir, f);
  if (!fs.existsSync(s)) die('缺少加密面板资源 desktop-overlay/ui/' + f + '（请先跑 tools/build-overlay.js）');
  fs.copyFileSync(s, path.join(ovDst, f));
  console.log('[sync-overlay] ✓ overlay/' + f + '  ' + (fs.statSync(s).size / 1024).toFixed(1) + ' KB');
}
// 明文 UI 绝不能被带进发布目录：那等于把加密白做一遍。
for (const f of UI_FILES) {
  const stray = path.join(ovDst, f);
  if (fs.existsSync(stray)) { fs.rmSync(stray, { force: true }); console.log('[sync-overlay] 已清掉明文残留 overlay/' + f); }
}

// 用户说明（中/英）：**只放进「独立桌面版」目录**。
// ⚠️ 绝不往完整套装目录里塞 —— 套装的顶层是固定 7 项
//    （Web GomokuEngine.exe + Desktop GomokuOverlay.exe + 使用说明.txt + User Guide.txt
//      + overlay/ + python/ + resources/），它自己的说明就是那两份 txt。
//    多出来的 README_*.md 属于「夹带文件」，会被打包卫生检查判红。
//    【2026-09-17 实测】`node tools/sync-overlay.js "Meter engine-server"` 会把两个 README
//    塞进套装，把 7 项顶层撑成 9 项 —— 所以这里必须按目标目录类型分流，顺带自愈历史误塞。
const isSuite = fs.existsSync(path.join(projDir, 'Web GomokuEngine.exe'));
if (isSuite) {
  console.log('[sync-overlay] 目标是完整套装（同桌有 Web GomokuEngine.exe）→ 不放 README_*.md');
  for (const dst of ['README_zh.md', 'README_en.md']) {
    const p = path.join(projDir, dst);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      console.log('[sync-overlay] 已清掉误入套装的 ' + dst);
    }
  }
} else {
  for (const [src, dst] of [['overlay-readme-zh.md', 'README_zh.md'], ['overlay-readme-en.md', 'README_en.md']]) {
    const s = path.join(__dirname, src);
    if (fs.existsSync(s)) {
      fs.copyFileSync(s, path.join(projDir, dst));
      console.log('[sync-overlay] ✓ ' + dst);
    }
  }
}

// 回读校验：确认落地内容与源一致（防止半程失败留下新旧混合的包）。
for (const f of [EXE_NAME]) {
  const a = fs.readFileSync(path.join(ROOT, 'desktop-overlay', 'build', f));
  const b = fs.readFileSync(path.join(projDir, f));
  if (a.length !== b.length || !a.equals(b)) { bad++; console.error('[sync-overlay] ✗ ' + f + ' 校验不一致'); }
}
for (const f of ENC_FILES) {
  const a = fs.readFileSync(path.join(uiDir, f));
  const b = fs.readFileSync(path.join(ovDst, f));
  if (!a.equals(b)) { bad++; console.error('[sync-overlay] ✗ overlay/' + f + ' 校验不一致'); }
}

console.log(bad ? '[sync-overlay] ✗ 有 ' + bad + ' 项不一致' : '[sync-overlay] OK ✓ 覆盖层已同步到「' + relName + '」');
process.exit(bad ? 1 : 0);
