#!/usr/bin/env node
/**
 * 从书签面板源码（engine-server/resources/bookmarklet.js）里**机械提取**面板 UI，
 * 生成桌面覆盖层可直接加载的 ui/panel.html。
 *
 * 为什么用提取而不是手抄：桌面版的 UI 必须与书签版"完整一致"。手抄会漂移，
 * 提取则保证只要书签面板改了，重跑本脚本桌面版立刻同步。
 *
 * 抽三样东西：
 *   ① I18N 语言表 + T()      → 面板里所有文案
 *   ② 面板容器样式           → width / 圆角 / 阴影 / 底色
 *   ③ root.innerHTML 表达式  → 面板全部 DOM + 内联样式
 * 在 vm 沙箱里求值 ③（只需 T / optRow / stepBtn / S 四个符号），写出静态 HTML。
 *
 * 定位使用的锚点（书签源码里的字面量，改动面板结构时若锚点失配会显式报错，不会静默产出坏 UI）：
 *   'var I18N = {'   'function T(k)'   'function optRow('   'var stepBtn ='
 *   "root.id = '__gb_panel'"   'root.style.cssText ='   'root.innerHTML ='
 *   'document.body.appendChild(root)'
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js');
const OUT_DIR = path.join(ROOT, 'desktop-overlay', 'ui');

const src = fs.readFileSync(SRC, 'utf8');

function must(needle, from = 0) {
  const i = src.indexOf(needle, from);
  if (i < 0) throw new Error('锚点失配（书签源码结构变了？）: ' + needle);
  return i;
}

/** 从 i 起按 JS 字符串/括号状态扫描，返回顶层分号或闭合大括号的下一个位置。 */
function scanExpr(i) {
  let depth = 0, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { if (depth === 0) return i + 1; depth--; }
    else if (c === ';' && depth === 0) return i + 1;
  }
  return src.length;
}

/** 从函数名起点扫到函数体闭合大括号。 */
function scanFunction(i) {
  const b = src.indexOf('{', i);
  if (b < 0) throw new Error('函数体未找到 @' + i);
  let depth = 0, q = null;
  for (let k = b; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return k + 1; }
  }
  throw new Error('函数体未闭合 @' + i);
}

// ---------- ① I18N + T ----------
const iI18N = must('var I18N = {');
const iT = must('function T(k)', iI18N);
const segI18N = src.slice(iI18N, iT);
const segT = src.slice(iT, scanFunction(iT));

// ---------- ② 容器样式 ----------
const iCss = must('root.style.cssText =');
const segCss = src.slice(iCss + 'root.style.cssText ='.length, scanExpr(iCss)).replace(/;\s*$/, '');
// 滚动条样式（细滚动条）
const iScroll = src.indexOf("sc.textContent = '");
let segScrollCss = '';
if (iScroll >= 0) {
  segScrollCss = /sc\.textContent = '((?:[^'\\]|\\.)*)'/.exec(src.slice(iScroll, iScroll + 600));
  segScrollCss = segScrollCss ? segScrollCss[1] : '';
}

// ---------- ③ optRow / stepBtn ----------
const iOptRow = must('function optRow(');
const segOptRow = src.slice(iOptRow, scanFunction(iOptRow));
const iStep = must('var stepBtn =');
const segStep = src.slice(iStep, scanExpr(iStep));

// ---------- ④ root.innerHTML 表达式 ----------
const iRoot = must("root.id = '__gb_panel'");
const iHtml = must('root.innerHTML =', iRoot);
const exprStart = iHtml + 'root.innerHTML ='.length;
const exprEnd = scanExpr(iHtml);
let segHtml = src.slice(exprStart, exprEnd).trim();
segHtml = segHtml.replace(/;\s*$/, '');

// ---------- 沙箱求值 ----------
const sandbox = {
  S: { lang: 'zh', hashMB: 1024 },
  Math, JSON, String, Number, Array, Object, Date, parseInt, parseFloat, isNaN, encodeURIComponent,
  console,
};
vm.createContext(sandbox);
// segHtml 是表达式，需要 return 出来
const program = [
  segI18N, segT, segOptRow, segStep,
  ';__OUT__ = String(' + segHtml + ');',
].join('\n');
vm.runInContext(program, sandbox, { timeout: 20000, filename: 'panel-extract' });

const html = sandbox.__OUT__;
if (typeof html !== 'string' || html.length < 3000) {
  throw new Error('提取失败：HTML 长度异常（' + (html || '').length + '）');
}

const containerCss = vm.runInContext('String(' + segCss + ')', sandbox, { timeout: 5000 });

// 桌面版定位：书签版固定在浏览器视口的右上角（top:80px;right:20px），而桌面版的宿主窗口
// **就是**这块面板——宿主按页面回报的宽高把窗口调到一致，窗口摆在哪由宿主的「右下角偏移」决定。
// 因此页面这边必须把面板钉死在视口左上角 (0,0)、并去掉一切 top/right/bottom/left：
// 留着 right:18px 的话，窗口宽度会被调成 225px，面板又自己往左让 18px → 左侧被裁掉一条。
function stripBoxOffsets(css) {
  return css
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^(top|right|bottom|left)$/i.test(d.split(':')[0].trim()))
    .join(';');
}
let desktopCss = stripBoxOffsets(containerCss);
desktopCss += ';top:0;left:0;right:auto;bottom:auto;box-sizing:border-box;';
// 高度封顶 + 内容滚动。⚠️ 上限**绝不能用 vh**：视口高度 = 宿主窗口高度 = 面板高度，
// 用 vh 就是正反馈——每轮把面板压小一点，几十轮后面板缩成一条线
//（实测 595→556→520→487→456→427→399→…）。真正的上限由 screen.availHeight 算出，
// 在 bridge.js 的 reportPanelRect 里按像素写进 style.maxHeight（见那里的注释）。
desktopCss += 'display:flex;flex-direction:column;';
// ★ 面板必须**撑满整个浮动窗口**（窗口按屏幕最窄边 ×0.618 定尺寸，可能比 225px 宽不少）。
//   书签版是网页里的一张卡片，写死 width:225px 天经地义；桌面版窗口按屏幕比例放大后，
//   若面板还守着 225px，就会「窗口很大、面板一条」—— 观感就是窗口空荡荡、内容很小。
//   宿主同时用 zoomFactor 把 225px 的设计稿整体缩放到窗口宽度
//   （见 host.cpp 的 ApplyZoomFromDpi），所以这里给 100% 与缩放是配套的：
//   视口恒为 225 CSS px，面板 100% = 225 CSS px，正好铺满、不留边。
desktopCss += 'width:100%;';
// ★ 桌面弹窗做成**直角**（用户要求 2026-09-16）。书签版容器的 border-radius:10px 是"网页卡片"
//   的观感；桌面版是贴在屏幕上的浮动工具窗，而且窗口 region 本身已经是矩形
//   （见 host.cpp 的 PANEL_RADIUS_CSS=0 / MakePanelRegion）。两处必须一起改，
//   否则会出现「窗口是方的、面板自己还画着圆角」——四角各露一块桌面，非常显眼。
//   这里用后置声明覆盖，不去动从书签版机械抽来的那段 CSS（那份要保持逐字复刻）。
desktopCss += 'border-radius:0;';
const desktopExtraCss =
  '#__gb_hdr{flex:0 0 auto;}' +                                   // 标题栏高度固定，别被内容挤扁
  // ★ B3（2026-09-19，用户）：「添加桌面端的五子棋助手可以进行这个窗口的长度的调节，最矮
  //   不要没过哈希表，最长就是全部功能都展示，长度短就可以进行鼠标滚动」。
  //   面板改成**撑满宿主的浮动窗口**（窗口高度由「内容自然高 / 用户拖拽值」决定，见 host.cpp
  //   的 ApplyPanelRect 与 PanelResizeLoop），短于内容时由 #__gb_body 自己滚动。
  //   ⚠ 这里用 height:100% 而不是 max-height:100vh —— 后者是**自反馈**：视口高 = 窗口高 =
  //     面板高，每轮把面板压小一点（实测 595→556→520→…→一条线）。height:100% 只是
  //     「等于宿主给的窗口高」，而窗口高不再由页面自报的 rect.height 决定（页面改报 hNat），
  //     所以没有回路。
  '#__gb_panel{height:100%;}' +
  '#__gb_body{overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;}' +
  // ★ B3：底部高度拖拽条。**必须**是 #__gb_panel 的最后一个子元素（在滚动区之外），
  //   这样它永远贴在窗口最下沿；拖动交给宿主（见 host.cpp 的 PanelResizeLoop），
  //   页面只负责在 mousedown 时报一声 —— 理由与标题栏拖动完全相同（客户区被 WebView2
  //   的子窗口盖着，父窗口收不到 WM_NCHITTEST）。
  '#__gb_grip{flex:0 0 auto;height:8px;cursor:ns-resize;pointer-events:auto;' +
  'display:flex;align-items:center;justify-content:center;background:transparent;}' +
  '#__gb_grip i{display:block;width:36px;height:3px;border-radius:2px;background:#c9cfd9;}' +
  '#__gb_grip:hover i{background:#3b7dd8;}' +
  '[data-dark="1"] #__gb_grip i{background:#4c5366;}' +
  '[data-dark="1"] #__gb_grip:hover i{background:#7fb0ef;}';
// ★ 不要在这里给 #__gb_panel 加 max-height:100vh！（2026-09-18 亲测，同一天踩了两次）
//   面板高度上限的**唯一**权威是 bridge.js 的 applyMaxHeight()：它写的是**行内**
//   panel.style.maxHeight = screen.availHeight - 96，行内样式压过样式表，所以这条加上去
//   在正常环境里根本不起作用（gain 0）；而在 screen.availHeight 拿不到（<200）时行内不会写，
//   这时 100vh 就生效了 —— 视口高度 = 宿主窗口高度 =（宿主按面板上报高度设的）窗口高度，
//   三者是同一个数，于是每轮把面板压小一点：595→556→520→487→…→一条线（bridge.js:191 有实录）。
//   要动面板高度上限，改 applyMaxHeight 的基准，别在 CSS 里绕。

// ---------- ⑤ 纯 UI 函数（曲线 / 状态栏）：一并提取复用，做到真正「完整复刻」----------
// 判定标准：函数体只依赖 S / N / DOM / localStorage，不碰网页 DOM、不发网络请求。
// 这类函数提取出来在桌面版行为完全一致；反之（读盘、注入点击）由 bridge.js 另写。
const UI_FUNCS = [
  ['var', 'var CHART_FIT'],
  ['fn', 'function drawChart('],
  ['fn', 'function fmtKMG('],
  ['fn', 'function coordLower('],
  ['fn', 'function rawEvalText('],
  ['fn', 'function setStatus('],
  ['fn', 'function setStatPanel('],
  ['fn', 'function setStatPanelThinking('],
  ['fn', 'function refreshStatLang('],
  ['fn', 'function fillStatFromCache('],
  // —— 面板外观 / 主题 / 透明度 / 开关态 ——
  ['fn', 'function applyDark('],
  ['fn', 'function applyLang('],
  ['fn', 'function applyOpacity('],
  ['fn', 'function applyBlur('],
  ['fn', 'function paintPanelBg('],
  ['fn', 'function btnOpacityFor('],
  ['fn', 'function paintButtons('],
  ['fn', 'function applyLowOpacityText('],
  ['fn', 'function paintPosWin('],   // ★ 2026-09-25：局面小窗配色（桌面版无 #__gb_poswin → 早退 no-op）
  ['fn', 'function paintToggle('],
  ['fn', 'function paintAuto('],
  ['fn', 'function paintHeat('],
  ['fn', 'function paintOpp('],
  ['fn', 'function paintSel('],
  ['fn', 'function applyPreset('],
  ['fn', 'function applyHash('],
  ['fn', 'function clamp('],
];

// 面板里所有「元素引用」声明整体搬运，使上面那些函数用到的按钮/滑块变量全部有定义。
const elRefs = [];
{
  const re = /var\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\.getElementById|Id)\(\s*'(__gb_[a-z0-9_]+)'\s*\)\s*;/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(src))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    elRefs.push('var ' + m[1] + " = document.getElementById('" + m[2] + "');");
  }
}

// save / load：面板状态持久化（纯 localStorage，与网页无关）
let saveLoad = '';
{
  const iSave = src.indexOf('function save(');
  if (iSave >= 0) saveLoad += src.slice(iSave, scanFunction(iSave)) + '\n';
  const iLoad = src.indexOf('function load(');
  if (iLoad >= 0) saveLoad += src.slice(iLoad, scanFunction(iLoad)) + '\n';
}
let stateInit = '';
{
  const iS = must('var S = {');
  const segS = src.slice(iS, scanExpr(iS));                       // var S = {...};
  stateInit += segS.replace(/^var S = /, 'var S_DEFAULTS = ') + '\n';
  const iR0 = must("var s = JSON.parse(localStorage.getItem('gb_state')");
  const iR = src.lastIndexOf('try {', iR0);              // 必须连 try 一起搬，否则 catch 悬空
  if (iR < 0) throw new Error('存档恢复段的 try 未找到');
  const iREnd = src.indexOf('S.analyzing = false;', iR0) + 'S.analyzing = false;'.length;
  stateInit += 'function initState() {\n  for (var _k in S_DEFAULTS) if (S[_k] === undefined) S[_k] = S_DEFAULTS[_k];\n'
    + src.slice(iR, iREnd).split('\n').map((l) => '  ' + l).join('\n') + '\n}\n';
}

const pieces = [];
const names = [];
for (const [kind, anchor] of UI_FUNCS) {
  const at = must(anchor);
  const code = kind === 'fn'
    ? src.slice(at, scanFunction(at))
    : src.slice(at, scanExpr(at)).replace(/;\s*$/, '') + ';';
  pieces.push(code);
  names.push(anchor.replace(/^(function|var)\s+/, '').replace(/[(;].*$/, '').trim());
}
// save / load 也要对外可用（bridge 改状态后落盘），见上文 saveLoad
if (/function save\(/.test(saveLoad)) names.push('save');
if (/function load\(/.test(saveLoad)) names.push('load');

const indent2 = (t) => t.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');

/** 造一个「假 DOM」沙箱：让生成的 panel-ui.js 能在 Node 里真跑一遍。
 *  只覆盖模块顶层实际用到的东西（取元素、样式、localStorage），不求完整 DOM。 */
function safeCtx() {
  const noop = () => {};
  const stubEl = new Proxy(
    {},
    {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'style' || k === 'dataset') return (t[k] = {});
        if (k === 'classList') return (t[k] = { add: noop, remove: noop, toggle: noop, contains: () => false });
        if (k === 'children') return (t[k] = []);
        if (k === 'getContext') return (t[k] = () => stubCtx2d);
        if (k === 'appendChild' || k === 'removeChild' || k === 'setAttribute' || k === 'remove')
          return (t[k] = noop);
        if (k === 'querySelector' || k === 'querySelectorAll') return (t[k] = () => null);
        if (k === 'addEventListener' || k === 'removeEventListener') return (t[k] = noop);
        if (k === 'offsetWidth' || k === 'offsetHeight') return 200;
        return undefined;
      },
      set(t, k, v) { t[k] = v; return true; },
    }
  );
  const stubCtx2d = new Proxy(
    {},
    { get: () => noop, set: () => true }
  );
  const win = { GB_S: {} };
  const sandbox = {
    window: win,
    document: {
      getElementById: () => stubEl,
      querySelector: () => stubEl,
      querySelectorAll: () => [],
      createElement: () => stubEl,
      body: stubEl,
      documentElement: stubEl,
      readyState: 'complete',
      addEventListener: noop,
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    console,
    Math, JSON, String, Number, Array, Object, Date,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    setInterval: () => 0, setTimeout: () => 0, clearInterval: noop, clearTimeout: noop,
  };
  win.document = sandbox.document;
  win.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  return { sandbox, win };
}

// 语法自检：提取结果必须能独立编译，否则宁可直接失败（避免产出坏文件）
let uiJs = `/* 由 tools/extract-panel-ui.js 从书签面板源码机械提取 —— 请勿手改。
 * 这些是面板的纯 UI 逻辑（评估曲线绘制、状态栏渲染、主题/语言/透明度/开关外观），
 * 桌面版与书签版共用同一份实现，因此可视化行为与书签面板逐字一致。
 * 凡涉及「读网页 DOM / 注入点击 / 请求引擎」的逻辑都不在此处，由 bridge.js 另行实现。 */
(function () {
  'use strict';
  var S = window.GB_S = window.GB_S || {};   // 与 bridge.js 共用同一个状态对象（不整体替换）
  var N = 15;
${indent2(segI18N)}
${indent2(segT)}
  var root = document.getElementById('__gb_panel');
  var statusEl = document.getElementById('__gb_status');
  var _prevOp = 100;
${indent2(elRefs.join('\n'))}
${indent2(stateInit)}
${indent2(saveLoad)}
${indent2(pieces.join('\n\n'))}

  window.GBUI = {
    names: ${JSON.stringify(names.concat(['initState']))},
    setN: function (v) { N = v | 0 || 15; },
    T: T,                                   // bridge 需要本地化文案（如「未检测到棋盘」）
    I18N: I18N,
    initState: initState,                   // 读取 gb_state 存档（含 v4/v5/v6 迁移）
${names.map((n) => '    ' + n + ': ' + n + ',').join('\n')}
  };
})();
`;
// ---------- 桌面版增量 ③：取消模糊模式（仅作用于提取产物，书签版源码不变）----------
// 用户需求（2026-09-16）：模糊在桌面上无法调节，且透明面板应像玻璃一样纯透，不再模糊；
// 浅色模式文字改纯黑，便于在透明面板上阅读。书签版（浏览器内）backdrop-filter 正常，故只改桌面版。
{
  // ① 中和 backdrop 模糊：paintPanelBg 里不再写 blur(...)，改成 'none'
  uiJs = uiJs.replace(/root\.style\.backdropFilter = blur;/g, "root.style.backdropFilter = 'none';");
  uiJs = uiJs.replace(/root\.style\.webkitBackdropFilter = blur;/g, "root.style.webkitBackdropFilter = 'none';");
  uiJs = uiJs.replace(
    /var bp = \(Math\.max\(5[\s\S]*?var blur = 'blur\(' \+ \(bp \* 18\)\.toFixed\(1\) \+ 'px\) saturate\(1\.35\)';/g,
    ''
  );
  // ② 浅色模式文字纯黑（只改 light 分支的灰字，不动深色模式 / 边框 / 强调色控件）
  const BLACKEN = [
    ["body.style.color = d ? '#e6e8ee' : '#1d1d1f';", "body.style.color = d ? '#e6e8ee' : '#000';"],
    ["el.style.color = d ? '#c8ccd6' : '#333';", "el.style.color = d ? '#c8ccd6' : '#000';"],
    ["el.style.color = d ? '#e6e8ee' : '#333';", "el.style.color = d ? '#e6e8ee' : '#000';"],
    ["if (hv) hv.style.color = d ? '#c8ccd6' : '#333';", "if (hv) hv.style.color = d ? '#c8ccd6' : '#000';"],
    ["el.style.color = d ? '#c8ccd6' : (el.classList.contains('__gb_lbl2') ? '#9aa3ad' : '#555');",
      "el.style.color = d ? '#c8ccd6' : (el.classList.contains('__gb_lbl2') ? '#000' : '#000');"],
    ["if (stEl) stEl.style.color = d ? '#c8ccd6' : '#666';", "if (stEl) stEl.style.color = d ? '#c8ccd6' : '#000';"],
    ["if (lgEl) { lgEl.style.color = '#888';", "if (lgEl) { lgEl.style.color = d ? '#888' : '#000';"],
    ["if (opPopEl) { opPopEl.style.color = d ? '#c8ccd6' : '#666';", "if (opPopEl) { opPopEl.style.color = d ? '#c8ccd6' : '#000';"],
    ["db.style.color = d ? '#c8ccd6' : '#555';", "db.style.color = d ? '#c8ccd6' : '#000';"],
    ["el.style.color = d ? '#c8ccd6' : '#9aa3ad'; });", "el.style.color = d ? '#c8ccd6' : '#000'; });"],
    ["el.style.color = d ? '#e6e8ee' : '#1d1d1f'; });", "el.style.color = d ? '#e6e8ee' : '#000'; });"],
    ["if (stLine) stLine.style.color = d ? '#9aa0ac' : '#666';", "if (stLine) stLine.style.color = d ? '#9aa0ac' : '#000';"],
    ["if (stFen) stFen.style.color = d ? '#7d8390' : '#9aa3ad';", "if (stFen) stFen.style.color = d ? '#7d8390' : '#000';"],
    ["var labelCol = S.dark ? '#7d8390' : '#9aa3ad';", "var labelCol = S.dark ? '#7d8390' : '#000';"],
    ["rec.style.color = d ? '#e6e8ee' : '#1d1d1f';", "rec.style.color = d ? '#e6e8ee' : '#000';"],
    ["an.style.color = d ? '#e6e8ee' : '#1d1d1f';", "an.style.color = d ? '#e6e8ee' : '#000';"],
    ["oppBtn.style.color = S.dark ? '#c8ccd6' : '#A5B4FC';", "oppBtn.style.color = S.dark ? '#c8ccd6' : '#000';"],
  ];
  const present = BLACKEN.filter(([o]) => uiJs.indexOf(o) >= 0);
  for (const [o, n] of present) uiJs = uiJs.split(o).join(n);
  // 断言：模糊已中和、浅色灰字已清除
  if ((uiJs.match(/backdropFilter = blur;/g) || []).length) {
    throw new Error('桌面版中和模糊失败：仍有 backdropFilter = blur');
  }
  if (/var blur = 'blur\(/.test(uiJs)) throw new Error('桌面版中和模糊失败：blur 变量未清除');
  for (const [o] of present) {
    if (uiJs.indexOf(o) >= 0) throw new Error('桌面版浅色文字未全部转黑，残留：' + o);
  }
  const greyLeft = uiJs.match(/style\.color = d \? '(?:#c8ccd6|#e6e8ee)' : '(?:#333|#555|#666|#9aa3ad|#1d1d1f)'/g) || [];
  if (greyLeft.length) throw new Error('桌面版浅色灰字未全部转黑，残留 ' + greyLeft.length + ' 处');
}

// ---------- 桌面版增量 ⑤：模糊的合法区间改成 0–50 ----------
// applyBlur 里写死的 5~100 必须跟着改，否则用户把滑块拖到 50 以下会被"纠正"回 50，
// 看起来就是「滑块拖不动」。默认档直接从 50 降到 0：开机即全透明，不挡棋盘。
// ⚠️ 必须排在 panel-ui.js 落盘（以及 vm 自检）**之前**，否则改了个寂寞。
{
  const OLD = 'var v = parseInt(S.blur, 10);\n      if (!(v >= 5 && v <= 100)) v = 50;';
  const NEW = 'var v = parseInt(S.blur, 10);\n      if (!(v >= 0 && v <= 50)) v = 0;';
  if (uiJs.indexOf(OLD) < 0) throw new Error('applyBlur 的区间判定没找到（书签版源码结构变了？）');
  uiJs = uiJs.split(OLD).join(NEW);
  if (/v >= 5 && v <= 100/.test(uiJs)) throw new Error('applyBlur 仍在做 5~100 的旧区间');
  // 存档默认值：桌面版默认 0（纯透明），书签版保持 50 不变
  const OLD_DEF = 'blur: 50,';
  if (uiJs.indexOf(OLD_DEF) >= 0) uiJs = uiJs.replace(OLD_DEF, 'blur: 0,');
}

// ---------- 桌面版增量 ⑧：主面板的「手动调节」键也跟着深浅色换肤 ----------
// 用户 2026-09-17：「主弹窗中『局面』这个按钮也得适配深浅色模式」。
// 这两个键都是本抽取器**新加**的（书签版源码里根本没有），所以书签版的 applyDark()
// 当然不认识它们 —— 不补这一段，面板一切到夜间模式，唯一还亮着的就是那块浅绿底，
// 在满屏深色里非常扎眼。
// 手法与「自动落子删除」一致：只在提取产物上补一行，书签版源码一字不动。
// ★ 2026-09-18 第五修正：**「局面」键从这里搬走了**。
//   它原来也在 applyDark 里写行内色（`#1d2a22 / #eaf6ec` 那套），而 bridge.js 的
//   posBtnOn() 又在**另一处**写同一组行内色，两边各写各的 —— 于是「谁最后写谁赢」。
//   实测的现场（用户截图）：深色面板 + 一块浅绿底按钮。根因是 posBtnOn 里判断深浅的
//   那句读的是 `getElementById('__gb_root')`（**页面上根本没有这个 id**）→ 回退到
//   document.body（body 上从来没有 data-dark）→ 恒判「浅色」→ 每次小窗状态刷新都把
//   按钮涂成浅色版。同一个颜色写两处、其中一处判错主题，就必然出这种事。
//   现在「局面」键的四套配色（浅/深 × 开/关）**只**由 FOOT_STYLE 里的 CSS 规则给
//   （见下面 POS_ROW 区块），行内一个颜色都不留；这里只剩「手动调节」键。
// ⚠️ 必须排在 panel-ui.js 落盘（以及 vm 自检）**之前**，否则改了个寂寞。
{
  const ANCHOR = "if (db) { db.style.background = d ? '#262b3a' : '#fff';"
    + " db.style.color = d ? '#c8ccd6' : '#000';"
    + " db.style.borderColor = d ? '#4a5060' : '#555'; }";
  const at = uiJs.indexOf(ANCHOR);
  if (at < 0) {
    throw new Error('applyDark 里找不到「深色键」那一行，无法给桌面版功能键补深浅色');
  }
  // 取该行自己的缩进，补上去的那行才和邻居对齐（提取后的缩进不由我们决定，别写死）。
  const lineStart = uiJs.lastIndexOf('\n', at) + 1;
  const indent = uiJs.slice(lineStart, at);
  const EXTRA =
    indent + "var ab = document.getElementById('__gb_adjust');\n" +
    indent + "if (ab) { ab.style.background = d ? '#16233a' : '#eaf1fb';" +
    " ab.style.color = d ? '#7fb0ef' : '#3b7dd8';" +
    " ab.style.borderColor = d ? '#3a5a8a' : '#3b7dd8'; }";
  uiJs = uiJs.slice(0, at + ANCHOR.length) + '\n' + EXTRA + uiJs.slice(at + ANCHOR.length);
  if (uiJs.indexOf("getElementById('__gb_adjust')") < 0) {
    throw new Error('「手动调节」键的深浅色样式注入失败');
  }
  // 「局面」键的配色**不许**再回到 applyDark 的行内写法（否则又会出现两处各写各的）
  if (/pb\.style\.background/.test(uiJs)) {
    throw new Error('「局面」键的配色又回到了行内样式 —— 它只能由 FOOT_STYLE 的 CSS 给');
  }
}

// ---------- 桌面版增量 ⑨：把「未检测到棋盘」的提示换成桌面版说法 ----------
// 书签版那句「打开有棋盘的网页后点书签」对桌面端毫无意义：桌面版是**扫屏**识别，
// 既没有网页、也没有书签可点。用户 2026-09-17 的截图里，面板显示的恰恰就是这句书签版
// 提示（同一条反馈里的「发布版桌面端识别不了了」），照着做只会越走越偏。
// 与其它桌面增量同一手法：只改提取产物，书签版源码（bookmarklet.js）一字不动 ——
// 书签版用户仍然需要那句「点书签」的提示。
// ⚠️ 找不到原文案就**抛错**，别静默跳过：书签版哪天改了这句话，这里必须当场红，
//    否则桌面端会悄悄退回书签版说法，又变成看不懂的提示。
{
  const ZH_OLD = "no_board: '未检测到棋盘（打开有棋盘的网页后点书签；若页面无可识别 canvas，请换用其它五子棋网站）',";
  const ZH_NEW = "no_board: '未检测到棋盘（把棋盘显示在屏幕上、别让其它窗口挡住；点「重新识别」可立即重扫）',";
  const EN_OLD = "no_board: 'No board detected. Open a Gomoku page and click the bookmark; if no readable canvas, try another site.',";
  const EN_NEW = "no_board: 'No board detected. Keep the board visible on screen and not covered by other windows; press Re-scan to retry.',";
  if (uiJs.indexOf(ZH_OLD) < 0) {
    throw new Error('panel-ui.js 里找不到中文 no_board 原文，无法改成桌面版说法（书签版文案是不是改了？）');
  }
  if (uiJs.indexOf(EN_OLD) < 0) {
    throw new Error('panel-ui.js 里找不到英文 no_board 原文，无法改成桌面版说法（书签版文案是不是改了？）');
  }
  uiJs = uiJs.split(ZH_OLD).join(ZH_NEW).split(EN_OLD).join(EN_NEW);
  if (uiJs.indexOf(ZH_NEW) < 0 || uiJs.indexOf(EN_NEW) < 0) {
    throw new Error('桌面版 no_board 文案注入失败');
  }
}

try {
  new vm.Script(uiJs, { filename: 'panel-ui.js' });
} catch (e) {
  throw new Error('提取出的 UI 函数无法独立编译：' + e.message);
}

// 运行自检：语法过关 ≠ 真能跑。用一个假 DOM 把生成的文件实际执行一遍，
// 确认 window.GBUI 真的被赋值、且每个导出都在。
// 这条是为了防住「漏写 I18N / T → GBUI 整个未定义 → 面板所有 UI 静默失效」这类事故：
// 那次语法检查是绿的，界面却是死的，排查代价极高。
{
  const ctx2 = safeCtx();
  vm.runInContext(uiJs, ctx2.sandbox, { timeout: 20000, filename: 'panel-ui.runtime' });
  const U = ctx2.win.GBUI;
  if (!U) throw new Error('panel-ui.js 执行后 window.GBUI 未定义（面板 UI 会整体失效）');
  if (typeof U.T !== 'function') throw new Error('panel-ui.js 未导出 T()（面板全部文案会失效）');
  if (!U.I18N || typeof U.I18N !== 'object') throw new Error('panel-ui.js 未导出 I18N 语言表');
  const want = names.concat(['initState']);
  // 只要求「导出存在」：CHART_FIT 之类是数值常量，不是函数。
  // 真正要防的是「因为某个符号未定义，整个 GBUI 字面量抛错 → GBUI 全无」。
  const missing = want.filter((n) => U[n] === undefined);
  if (missing.length) throw new Error('panel-ui.js 缺少导出：' + missing.join(', '));
  console.log('[extract-panel-ui] 运行自检通过：GBUI 导出 ' + want.length + ' 个函数 + T/I18N');
}

fs.writeFileSync(path.join(OUT_DIR, 'panel-ui.js'), uiJs, 'utf8');

// ---------- 桌面版增量：把「自动落子」整段摘掉 ----------
// 用户方案（2026-09-16）：「只在屏幕上用蓝色圆圈 / 热力图指导用户去落子，**不参与自动落子**」。
// 既然桌面版不再替用户点鼠标，「自动落子」开关就没有存在意义了（它配套的「点击次数」旋钮
// 更是只服务于系统级点击）。所以这里把书签版的 `__gb_auto` 按钮**整体删除**。
//
// 为什么不是"改造成胶囊"：上一版确实把它连成过胶囊（左段开/关 + 右段 ×1/×2），但那只在
// 「还要自动落子」的前提下才成立。现在是**功能被取消**，控件必须一起消失 —— 只留一个
// 按不动的、或者点开什么都不发生的落子键，比没有更糟。
//
// 这是**唯一**对提取结果做的结构改动（其余仍是逐字复刻），所以位置固定、失败即抛错：
// 书签版那边 id/结构一改，构建立刻报错，而不是默默产出"还带着落子键"的面板。
// ⚠️ 只改桌面版：书签版（网页内注入）保留它自己的「自动落子」——那边有 DOM，
//    落子是在页面内合成事件，与桌面版的系统级点击是两件事，互不影响。
let htmlOut = html;
{
  const iAuto = html.indexOf('<button id="__gb_auto"');
  if (iAuto < 0) throw new Error('找不到「自动落子」按钮，无法从桌面版面板删除');
  const closeAt = html.indexOf('</button>', iAuto);
  if (closeAt < 0) throw new Error('「自动落子」按钮未闭合');
  const autoBtn = html.slice(iAuto, closeAt + '</button>'.length);
  // 仍然要求书签版那边带着 data-i18n 与文案：结构一变就立刻报错，免得默默提取出一份残件。
  const k = /data-i18n="([^"]+)"/.exec(autoBtn);
  const label = autoBtn.replace(/^<button[^>]*>/, '').replace(/<\/button>$/, '').trim();
  if (!k || !label) throw new Error('「自动落子」按钮缺少 data-i18n 或文案，无法安全删除');
  const kAuto = k[1];
  htmlOut = html.slice(0, iAuto) + html.slice(closeAt + '</button>'.length);

  // ★ 出厂自检：桌面版面板里**不允许**再出现任何落子开关。
  //   逐个点名检查，是为了同时挡住"漏删新控件"和"历史遗留"两类问题：
  //   __gb_auto  = 书签版那个按钮（本次要删的目标）
  //   __gb_autocap / __gb_clickn = 上一版桌面独有胶囊（容器 / 次数），必须一并绝迹，
  //   否则 bridge.js 或契约测试会在某天又"以为"它们存在。
  for (const gone of ['__gb_auto', '__gb_autocap', '__gb_clickn']) {
    if (htmlOut.indexOf(gone) >= 0) throw new Error('桌面版面板仍残留落子控件：' + gone);
  }
  // 文案层面也堵一道：中文「自动落子」/ 英文 Auto 的 i18n 键都不该再挂在任何元素上。
  if (new RegExp('data-i18n="' + kAuto + '"').test(htmlOut)) {
    throw new Error('桌面版面板仍挂着落子按钮的 i18n 键：' + kAuto);
  }
}

// ---------- 桌面版增量 ②：让「我执」那一行允许换行 ----------
// 这一行 = 我执黑 + 我执白 + 锁定态文字（"锁定·黑" / "locked·Black"），窄面板（225px）下本来就挤；
// 英文界面里那句更长，必定顶出右边界。落子键删掉后这一行宽松了些，但换行保护仍要留着 ——
// 宁可换行，绝不越界。
{
  const iIplay = htmlOut.indexOf('data-i18n="iplay"');
  if (iIplay < 0) throw new Error('找不到「我执」行，无法设置自动换行');
  const at = htmlOut.lastIndexOf('<div style="', iIplay);
  if (at < 0) throw new Error('「我执」行的容器结构变了（找不到 style 属性）');
  const q = htmlOut.indexOf('"', at + '<div style="'.length);
  if (q < 0) throw new Error('「我执」行的 style 属性未闭合');
  htmlOut = htmlOut.slice(0, q) + 'flex-wrap:wrap;row-gap:3px;' + htmlOut.slice(q);
  const seg = htmlOut.slice(at, at + 400);
    if (seg.indexOf('flex-wrap:wrap') < 0) throw new Error('「我执」行换行样式注入失败');
  }

// ---------- 桌面版增量 ③：把「模糊」控件整段摘掉（只留透明度） ----------
// 用户需求（2026-09-17）：桌面端**只调透明度**，不要模糊。模糊滑块留着就是
// 一个"点了没反应"的控件（宿主只按透明度/语言/深浅同步，模糊恒为 0 = 纯透明）。
// 与「自动落子删除」同一手法：从桌面版 HTML 里整行删除，书签版源码不动。
// applyBlur/blur 状态仍保留在 panel-ui.js 里（全部 null-guard，控件不存在也不会报错），
// 桌面端 S.blur 恒为 0 → 宿主 uiLook.blur=0 → ApplyGlassBlur(0)=ACCENT_DISABLED 纯透明。
{
  const iBlurLbl = htmlOut.indexOf('<span data-i18n="blur"');
  if (iBlurLbl < 0) throw new Error('找不到「模糊」行，无法为桌面版摘除');
  // 模糊行结构扁平（无嵌套 div）：从它所在的 <div ...> 起到最近的 </div> 止
  const iDiv = htmlOut.lastIndexOf('<div', iBlurLbl);
  const iEnd = htmlOut.indexOf('</div>', iBlurLbl);
  if (iDiv < 0 || iEnd <= iBlurLbl) throw new Error('「模糊」行的 div 结构变了，摘除失败');
  htmlOut = htmlOut.slice(0, iDiv) + htmlOut.slice(iEnd + '</div>'.length);

  // 控件摘了，只服务于它的 CSS 也得跟着走，否则桌面页里留一段死样式。
  // 这几条都是「透明度滑块 + 模糊滑块」共用选择器（形如 `#__gb_opacity_range,#__gb_blur_range{…}`），
  // 把 `,#__gb_blur_range…{` 这一段去掉即可 —— 透明度那一半必须留着。
  htmlOut = htmlOut.replace(/,\s*#__gb_blur_range[^{]*\{/g, '{');
  // 兜底：若哪天书签版给模糊控件单开一条独立规则，整条删掉。
  htmlOut = htmlOut.replace(/#__gb_blur_range[^{]*\{[^}]*\}/g, '');

  if (/id="__gb_blur_range"|id="__gb_blur_num"/.test(htmlOut)) {
    throw new Error('桌面版模糊控件未摘干净（__gb_blur_* 标记仍在）');
  }
  if (/__gb_blur_range|__gb_blur_num/.test(htmlOut)) {
    throw new Error('桌面版仍残留 __gb_blur_* 的样式/引用');
  }
  if (/data-i18n="blur"/.test(htmlOut)) {
    throw new Error('桌面版模糊文案键仍挂在元素上（data-i18n="blur"）');
  }
}

// ---------- 桌面版增量 ⑥（HTML 侧）：加「局面」+「手动调节」两个常驻功能键 ----------
// 点开「局面」→ 宿主弹出另一个小浮动窗（识别出来的小棋盘 + 局面代码，可复制/保存）。
// 「手动调节」→ 进入拖拽选框模式：用户在屏幕上拖一个矩形圈定识别区域，宿主只在这块
//   矩形里认盘（不再全屏自动找盘，解决某些网站/缩放下整屏找盘失败的问题）。
// ★ 2026-09-18 关键修复：这一行原本是 scroll 区里**最后一排**，面板高度不够时会被
//   `overflow:hidden` 裁到折叠区之下 → 用户根本点不到「局面」（点击链本身一直正常，
//   是布局把它藏起来了）。改成 `position:sticky;bottom:0` 钉在滚动容器底部，**永远可见可点**。
// 放在功能键那一排（重新识别 / 分析 / 深算）**下面另起一行**：那排本来就是 3 个等宽键，
// 再挤一个进去，窄面板（225px）下「重新识别」四个字会被压到换行，反而更难看。
{
  const iDeep = htmlOut.indexOf('id="__gb_deep"');
  if (iDeep < 0) throw new Error('找不到「深算」按钮，无法确定「局面」键的插入位置');
  // ★ 2026-09-25（书签版同款两键下放）：书签源码现在**自带** __gb_footbar（局面/保存局面，
  //   行内只留布局、配色全部在源码的 <style> 里，与 FOOT_STYLE 同一套规则文本）。
  //   桌面版不再注入 POS_ROW / FOOT_STYLE（会双份），只保留「sticky 底栏」的包装：
  //   把「重新识别/分析/深算」一行 + 源码自带的底栏一起包进 #__gb_bottombar。
  const srcHasFootbar = htmlOut.indexOf('id="__gb_footbar"') >= 0;
  const rowEnd = htmlOut.indexOf('</div>', iDeep);
  if (rowEnd < 0) throw new Error('功能键那一排未闭合，无法插入「局面」键');
  // ★ 2026-09-18 二次修正（用户现场反馈两条）：
  //   ① 底部只留「局面」一个键：面板**顶部标题栏本来就有一个「手动调节」**，
  //      底部再放一个就成了重复 id —— 而 bridge.js 的 on('__gb_adjust') 只绑
  //      getElementById 取到的**第一个**，底部这个从装上那天起就是死的。
  //   ② 底色不再写死 #fff：sticky 条必须盖住滚上来的内容（所以不能透明），
  //      但写死白底后，一切深色模式底部就留一条白杠 —— 用户说的
  //      「适配的背景深色效果也失效了」就是它。改成由 data-dark 属性选择器驱动：
  //      applyDark() 会 root.setAttribute('data-dark','1')，CSS 自动跟着翻，
  //      不用去改 applyDark/applyLowOpacityText 那一堆刷新路径。
  // ★ 2026-09-18 第四次修正（用户现场反馈）：
  //   「局面的按键浅色模式下…并且它周围的透明效果没有实现」。
  //   旧写法给底栏钉死 `background:#fff` —— 这恰好把面板自己的**透明度设置**废掉了：
  //   paintPanelBg() 把 #__gb_panel 涂成 `rgba(255,255,255,a)`、把 `.__gb_row` 涂成
  //   `rgba(250,251,252,0.62a)`，于是整块面板都跟着桌面一起变淡，**唯独底栏那一横条
  //   还是纯白**（a=100% 时纯白，a=25% 时也纯白）→ 屏幕上看就是一条突兀的白杠，
  //   用户说的「周围的透明效果没有实现」就是它。
  //   正解：底栏**不再自己上色**（transparent），直接透出 #__gb_panel 的 rgba 背景，
  //   于是它的透明度天然等于面板透明度、任何档位都不会脱节；分隔改用 inset 阴影
  //   （不占布局、不随透明度发白），深色模式由 data-dark 翻转阴影色。
  //   backdrop-filter 只是保险：万一有内容滚到条底下，糊一下仍能读清按钮文字。
  //
  //   ★ 2026-09-18 第五修正（用户：「局面这个按键没有匹配深色主题」）。
  //     旧写法把颜色**写死在按钮的行内样式**里（`background:#2e7d32;color:#fff`），
  //     于是深色模式下它是黑面板中央一块高饱和亮绿 —— 亮度跟面板（#1f2330 / #262b3a）
  //     差着两个档，是整块面板里唯一「跳出来」的元素。
  //     现在两条配色都进样式表（行内只留布局），并且**必须带 !important**：
  //     行内样式优先级高于样式表，不带 !important 覆盖不掉。
  //       · 浅色：实心绿 #2e7d32 + 白字（沿用上一版，一眼是主操作）
  //       · 深色：深墨绿底 #1e3a26 + 浅绿字 #9bd6a2 + 绿描边 —— 亮度落在深色面板那一档，
  //         既留住「绿 = 局面」这个语义，又跟 #262b3a 的兄弟们是一个世界的。
  const FOOT_STYLE =
    '<style>' +
    // ★ B1（2026-09-19，用户）：「局面和上面的按键为同一个背景板块」。
    //   做法：把「重新识别 / 分析 / 深算」那一排与「局面」底栏包进**同一个**容器
    //   #__gb_bottombar（sticky 钉在滚动区底部），容器自己**不上色** —— 它直接透出
    //   #__gb_panel 的 rgba 背景，于是整块与面板同底色、同透明度，观感就是一块板。
    //   ⚠ 旧写法是给底栏单独加 backdrop-filter 模糊 + 上沿 inset 分隔线，那恰好把
    //     「局面」做成一块浮在面板上的小板子（用户看到的就是两个板块）。
    //   分隔线只留**一条**、画在整块的**上沿**；两行之间不许有线。
    '#__gb_bottombar{background:transparent;' +
    'box-shadow:inset 0 1px 0 rgba(18,38,86,.10);}' +
    '[data-dark="1"] #__gb_bottombar{' +
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.12);}' +
    '#__gb_footbar{background:transparent;display:flex;gap:6px;padding:0 12px 10px;}' +
    // ★ B5（2026-09-19，用户）：「局面，和保存局面，这两个功能键应该小一点，高度和上面的
    //   三个按钮一样」。上面那三个键的盒子是 padding:5px 0 + 1px 边框 + **继承来的**字号，
    //   所以这里只写「盒子」参数（padding / 圆角），**绝不写 font-size / font-weight /
    //   min-height** —— 高度自然与上排严格相等。
    //   ⚠ 这里踩过一次真坑（被 tools/test-openpos-click.js 的真实 DOM 测量当场抓住）：
    //     一开始照抄了一句 `font-size:12px`（想的是「和面板一致」），可上排三键实际算出来是
    //     **13.3333px**（面板上的字号是别处给的，不是 12px）—— 于是底栏两键 29px、
    //     上排 31px，用户要的「一样高」差 2px。写死字号就是根源，所以现在一个字都不写。
    '#__gb_footbar>button{flex:1;padding:5px 0;border-radius:6px;cursor:pointer;' +
    'box-sizing:border-box;}' +
    // 浅色：实心绿（主操作）
    '#__gb_pos{background:#2e7d32!important;color:#fff!important;' +
    'border:1px solid #2e7d32!important}' +
    // 浅色 · 小窗开着（选中态）：压深一档 + 内描边
    '#__gb_pos[data-on="1"]{background:#1b5e20!important;border-color:#123f16!important;' +
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)!important}' +
    '#__gb_pos:hover{filter:brightness(1.08)}' +
    // 深色：深墨绿（跟随深色主题的明度档位）
    '[data-dark="1"] #__gb_pos{background:#1e3a26!important;color:#9bd6a2!important;' +
    'border-color:#3f7a4a!important}' +
    // 深色 · 小窗开着：提亮到「点亮」的感觉，但仍不刺眼
    '[data-dark="1"] #__gb_pos[data-on="1"]{background:#2c6b3a!important;color:#eafbe9!important;' +
    'border-color:#5aa869!important;' +
    'box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)!important}' +
    '[data-dark="1"] #__gb_pos:hover{filter:brightness(1.12)}' +
    // ★ B2（2026-09-19，用户）：「在局面的右面添加一个保存局面这个按键」。
    //   配色走**样式表**（和「局面」键同一个套路，行内一个颜色都不留）：
    //   浅色 = 白底 + 绿字 + 绿描边（与上排三个键同款的次级按钮观感）；
    //   深色 = 面板同族的深底 + 浅绿字。选中态没有（它是一次性动作，不是开关）。
    '#__gb_possave{background:#fff!important;color:#2e7d32!important;' +
    'border:1px solid #7cb98a!important}' +
    '#__gb_possave:hover{background:#f2f9f3!important;filter:none}' +
    '[data-dark="1"] #__gb_possave{background:#232a3a!important;color:#9bd6a2!important;' +
    'border-color:#3f7a4a!important}' +
    '[data-dark="1"] #__gb_possave:hover{background:#2b3346!important}' +
    '</style>';
  const BAR_OPEN =
    // ★ B1：整块底栏的容器。sticky 钉在滚动区底部，**永远可见可点**（历史教训：
    //   这一行原本是滚动区里最后一排，面板高度不够时会被 overflow:hidden 裁到折叠区之下，
    //   用户根本点不到「局面」）。pointer-events:auto 也必须显式写：外层
    //   #__gb_panel_wrap 整片是 none。
    '<div id="__gb_bottombar" style="position:sticky;bottom:0;z-index:9;pointer-events:auto;' +
    'display:flex;flex-direction:column;">';
  const BAR_CLOSE = '</div>';
  const POS_ROW =
    // 按钮：布局只留 flex:1 + cursor（盒子尺寸全部由 FOOT_STYLE 的
    // `#__gb_footbar>button` 给，高度才与上排三键严格相等）。
    // ⚠ 配色**不许**写进行内样式（见下方「行内样式里不许再出现颜色」的自检）。
    // ★ 2026-09-18 第三次修正（用户要求）：底栏从那时起只留「局面」；
    //   复盘（把识别到的棋盘送进练习器）由「局面」小窗承担，不许再加回来。
    //   ⚠ pointer-events:auto 必须留着：外层 #__gb_panel_wrap 整片是 none，
    //     容器 #__gb_bottombar 虽然也显式开了，但两处都写死才不会被谁改一处就坏掉。
    '<div id="__gb_footbar" style="display:flex;gap:6px;padding:0 12px 10px;pointer-events:auto;">' +
    '<button id="__gb_pos" title="打开局面窗口（识别出来的棋盘 + 局面代码）" ' +
    'style="flex:1;cursor:pointer;">局面</button>' +
    // ★ B2：页面只负责「报一声 savePosPng」，真正的渲染与写盘在宿主 ——
    //   WebView2 里既没有路径也没有文件系统，做不到「让用户挑保存位置」。
    '<button id="__gb_possave" title="保存局面（把识别到的棋盘渲染成 PNG 图片）" ' +
    'style="flex:1;cursor:pointer;">保存局面</button>' +
    '</div>';
  // ★ B1：**包住**上面那排功能键（重新识别/分析/深算），让两行成为一个板块。
  //   rowStart = 那一排的 <div 起点；rowEnd = 它的 </div> 之后。
  const barStart = htmlOut.lastIndexOf('<div', iDeep);
  if (barStart < 0) throw new Error('找不到功能键那一排的容器起点，无法合并底栏背景板块');
  htmlOut = htmlOut.slice(0, barStart) + BAR_OPEN + htmlOut.slice(barStart);
  // 重新定位：插入了 BAR_OPEN 之后，原来那个 </div> 的下标要重新找一遍
  const iDeep2 = htmlOut.indexOf('id="__gb_deep"');
  const rowEnd2 = htmlOut.indexOf('</div>', iDeep2);
  if (rowEnd2 < 0) throw new Error('功能键那一排未闭合，无法插入底栏');
  if (srcHasFootbar) {
    // 源码自带底栏：样式与 POS_ROW 都已在源码 <style>/标记里 —— 只需在**底栏闭合之后**
    // 补 BAR_CLOSE（把三键行 + 底栏一起圈进 sticky 板块）。
    const iPos2 = htmlOut.indexOf('id="__gb_pos"', rowEnd2);
    if (iPos2 < 0) throw new Error('源码自带底栏里找不到「局面」键');
    const fbClose = htmlOut.indexOf('</div>', htmlOut.indexOf('id="__gb_possave"', iPos2));
    if (fbClose < 0) throw new Error('源码自带底栏未闭合');
    const insertAt = fbClose + '</div>'.length;
    htmlOut = htmlOut.slice(0, insertAt) + BAR_CLOSE + htmlOut.slice(insertAt);
  } else {
    htmlOut = htmlOut.slice(0, rowEnd2 + '</div>'.length) + FOOT_STYLE + POS_ROW + BAR_CLOSE +
              htmlOut.slice(rowEnd2 + '</div>'.length);
  }
  if (htmlOut.indexOf('id="__gb_pos"') < 0) throw new Error('「局面」功能键插入失败');
  if (htmlOut.indexOf('id="__gb_possave"') < 0) throw new Error('「保存局面」功能键插入失败');
  if (htmlOut.indexOf('id="__gb_bottombar"') < 0) throw new Error('底栏共用背景板块插入失败');
  // ★ B1 结构自检：三键行与底栏必须都在同一个容器里（中间不许有别的兄弟节点），
  //   否则「同一个背景板块」就是一句空话。
  {
    const bs = htmlOut.indexOf('id="__gb_bottombar"');
    const rec = htmlOut.indexOf('id="__gb_rec"', bs);
    const pos = htmlOut.indexOf('id="__gb_pos"', bs);
    const close = htmlOut.indexOf('</div></div>', pos);
    if (!(bs >= 0 && rec > bs && pos > rec)) {
      throw new Error('底栏板块结构不对：三键行与「局面」不在同一个 #__gb_bottombar 里');
    }
    if (close < 0) throw new Error('底栏板块未闭合（缺 </div></div>）');
  }
  // ★ 「局面」键的配色必须真的进了样式表（含深色那一套）——
  //   它是**唯一**的颜色来源，缺了就又回到「JS 自己写行内色」那条老路（见增量 ⑧ 的说明）。
  if (htmlOut.indexOf('[data-dark="1"] #__gb_pos{') < 0) {
    throw new Error('「局面」键的深色配色规则没进面板样式表');
  }
  if (htmlOut.indexOf('[data-dark="1"] #__gb_pos[data-on="1"]') < 0) {
    throw new Error('「局面」键深色选中态的规则没进面板样式表');
  }
  // 行内样式里**不许**再出现颜色（只留布局），否则会盖住（或将来被误以为盖住）主题规则
  if (/id="__gb_pos"[^>]*style="[^"]*(background|color)\s*:/.test(htmlOut)) {
    throw new Error('「局面」键又把颜色写回了行内样式');
  }
  // 底栏**不允许**再出现复盘键（2026-09-18 用户要求：最下面只保留「局面」）
  if (htmlOut.indexOf('id="__gb_review"') >= 0) {
    throw new Error('底栏仍有「复盘」键 —— 用户要求底栏只留「局面」');
  }
  // 底部**不应该**再出现第二个 __gb_adjust（顶部那个才是真正被绑事件的）
  {
    const first = htmlOut.indexOf('id="__gb_adjust"');
    const second = htmlOut.indexOf('id="__gb_adjust"', first + 1);
    if (second >= 0) throw new Error('「手动调节」出现重复 id（底部重复键未摘干净）');
  }
}

// （「局面」功能键已在上方插入 htmlOut；uiJs 侧的模糊区间改动见文件前段的增量 ⑤，
//   必须在 panel-ui.js 落盘之前做，所以不能放在这里。）

// ---------- 桌面版增量 ⑦：取消「对手落点评估」，四色图例挪到「热力图」按钮后面 ----------
// 用户要求（2026-09-17）：「取消对手评估这个功能」「热力图按键后面就是四种颜色的颜色展示标点」。
//
// ⚠ 只改**桌面版**：书签版（浏览器内注入）保留它自己的「对手落点评估」——
//    那边有网页 DOM，对手圈画在网页里；桌面版画在屏幕指导层上，是两件事，互不影响。
//    所以这里删的是 htmlOut（桌面产物），engine-server/resources/bookmarklet.js 一字不动
//    （test-opp-rings.js / test-live-fixes.js / test-live-semantics.js 测的都是书签版，必须继续绿）。
{
  // ① 摘掉「对手落点评估」按钮（连它在热力图那一行里的占位一起）
  const iOpp = htmlOut.indexOf('id="__gb_opp"');
  if (iOpp < 0) throw new Error('桌面版找不到「对手落点评估」按钮，无法摘除');
  const bStart = htmlOut.lastIndexOf('<button', iOpp);
  const bEnd = htmlOut.indexOf('</button>', iOpp);
  if (bStart < 0 || bEnd < 0) throw new Error('「对手落点评估」按钮标签未闭合，无法安全摘除');
  htmlOut = htmlOut.slice(0, bStart) + htmlOut.slice(bEnd + '</button>'.length);
  if (htmlOut.indexOf('__gb_opp') >= 0) throw new Error('桌面版仍残留 __gb_opp 控件');
  if (htmlOut.indexOf('oppMoves') >= 0) throw new Error('桌面版仍残留 oppMoves 文案键');

  // ② 原来的四色图例是独立一行、而且 display:none（点热力图才显形）。
  //    现在把它整段删掉，改在「热力图」按钮**同排右侧**重建一个常显版本。
  const iLg = htmlOut.indexOf('id="__gb_legend"');
  if (iLg < 0) throw new Error('桌面版找不到四色图例（__gb_legend），无法挪到热力图后面');
  const lgStart = htmlOut.lastIndexOf('<div', iLg);
  const lgClose = htmlOut.indexOf('</div>', iLg);
  if (lgStart < 0 || lgClose < 0) throw new Error('四色图例标签未闭合，无法安全搬移');
  htmlOut = htmlOut.slice(0, lgStart) + htmlOut.slice(lgClose + '</div>'.length);

  // 四个色点 + 「最佳 / 较优 / 一般 / 较弱」文字。
  //  ★ 第一版只放了色点，含义塞在 title 里；用户 2026-09-17 追加要求：
  //    「热力图4颜色点后面跟上「最佳」等提示，字体稍小一点」。所以这里把文字显式画出来。
  //  排版预算（面板 225px 宽 - 2px 边框 - 左右各 12px 内衬 = 199px 可用）：
  //    「热力图」按钮 ≈51px + 行内 gap 6px = 57px，留给图例 ≈142px；
  //    图例 = 4×(点9 + 缝3 + 字18) + 3×间隔4 + 左衬4 = 136px → 总 193px，留 6px 余量。
  //    文字 9px 比同排按钮的 11px 小一档，正好是用户说的「稍小一点」。
  //  ⚠ 文案必须走 data-i18n（字典里已有 heatBest/heatGood/heatMid/heatLow）：
  //    面板切中英文时 applyLang() 会顺带刷这四处，写死中文会在英文界面下露馅。
  //  ⚠ 图例内部只能用 <span>/<i>，**不能**出现 <div>：
  //    tools/test-guide-layer.js 用 /<div id="__gb_legend">[\s\S]*?<\/div>/ 截取图例片段，
  //    内部一旦有 <div>，非贪婪匹配会提前截断，四条颜色断言就假失败了。
  const lgItem = (color, key, zh) =>
    '<span style="display:inline-flex;align-items:center;gap:3px;">' +
    '<i title="' + zh + '" style="width:9px;height:9px;border-radius:50%;background:' + color +
    ';display:inline-block;flex:none;"></i>' +
    '<span data-i18n="' + key + '">' + zh + '</span></span>';
  const legendRow =
    '<div id="__gb_legend" style="margin-left:auto;display:flex;align-items:center;gap:4px;' +
    'padding:0 0 0 4px;font-size:9px;color:#888;user-select:none;white-space:nowrap;">' +
    lgItem('#00bfa5', 'heatBest', '最佳') +
    lgItem('#43a047', 'heatGood', '较优') +
    lgItem('#ff7f9f', 'heatMid',  '一般') +
    lgItem('#ffb3c1', 'heatLow',  '较弱') +
    '</div>';

  const iHeat = htmlOut.indexOf('id="__gb_heat"');
  if (iHeat < 0) throw new Error('桌面版找不到「热力图」按钮，四色图例无处安放');
  const heatClose = htmlOut.indexOf('</button>', iHeat);
  if (heatClose < 0) throw new Error('「热力图」按钮标签未闭合');
  const at = heatClose + '</button>'.length;
  htmlOut = htmlOut.slice(0, at) + legendRow + htmlOut.slice(at);

  // ③ 出厂自检：热力图按钮后面紧跟的就是图例；且图例全文件只出现一次；且默认可见
  if (!/id="__gb_heat"[\s\S]{0,400}?id="__gb_legend"/.test(htmlOut)) {
    throw new Error('四色图例没有紧跟「热力图」按钮');
  }
  if ((htmlOut.match(/id="__gb_legend"/g) || []).length !== 1) {
    throw new Error('四色图例在桌面版里出现了多次');
  }
  if (!/id="__gb_legend"[^>]*display:flex/.test(htmlOut)) {
    throw new Error('四色图例没有默认展开（应常显，不该再靠点热力图才出现）');
  }
  // ③b 图例文字自检（用户 2026-09-17 追加：「4颜色点后面跟上「最佳」等提示」）
  {
    const lgM = /<div id="__gb_legend"[\s\S]*?<\/div>/.exec(htmlOut);
    const lg = lgM ? lgM[0] : '';
    if (!lg) throw new Error('截取不到四色图例片段');
    if (lg.indexOf('<div') !== lg.lastIndexOf('<div')) {
      throw new Error('四色图例内部出现了嵌套 <div>，会截断 test-guide-layer 的图例片段');
    }
    for (const [key, zh] of [['heatBest', '最佳'], ['heatGood', '较优'],
                             ['heatMid', '一般'], ['heatLow', '较弱']]) {
      if (lg.indexOf('data-i18n="' + key + '"') < 0) {
        throw new Error('四色图例缺少 data-i18n="' + key + '"（面板切英文会露馅）');
      }
      if (lg.indexOf('>' + zh + '<') < 0) {
        throw new Error('四色图例缺少「' + zh + '」文字（用户要求色点后面跟提示）');
      }
    }
    if ((lg.match(/<i /g) || []).length !== 4) {
      throw new Error('四色图例的色点不是 4 个');
    }
    if (!/font-size:9px/.test(lg)) {
      throw new Error('四色图例文字没有比同排按钮（11px）小一档');
    }
  }
}

// ---------- 写出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });

// 面板内联样式里有 font-family:"Segoe UI" 这类**双引号**，直接塞进 HTML 属性会截断属性值。
// HTML 属性值里必须用 &quot;（浏览器解析后仍是双引号，CSS 语义不变）。
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
// <style> 内容只需防止提前闭合
const escCss = (s) => s.replace(/<\/style>/gi, '<\\/style>');

const page = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>五子棋桌面助手</title>
<style>
  html,body{margin:0;padding:0;width:100%;background:transparent;overflow:hidden;
    font-family:"Segoe UI","Microsoft YaHei",sans-serif;-webkit-user-select:none;user-select:none;}
  /* 桌面版：面板是可拖动的浮动卡片，底下的网页/应用要能点到 → 空白处点击穿透 */
  #__gb_panel_wrap{position:fixed;inset:0;pointer-events:none;}
  #__gb_panel{pointer-events:auto;}
  /* 面板在桌面版允许拖动（真正的拖动由宿主按标题栏区域接管） */
  #__gb_hdr{cursor:move!important;}
  ${desktopExtraCss}
  ${escCss(segScrollCss)}
</style>
</head>
<body>
<!-- 覆盖层画布：屏幕四角 L 型 + 细虚线连接、棋盘外框（亮蓝紫）。整层点击穿透，不挡操作。 -->
<canvas id="__gb_frame" style="position:fixed;left:0;top:0;z-index:1;pointer-events:none;"></canvas>
<div id="__gb_panel_wrap">
  <!-- ↓↓↓ 以下结构与内联样式由 tools/extract-panel-ui.js 从书签面板源码机械提取，请勿手改 ↓↓↓ -->
  <div id="__gb_panel" style="${escAttr(desktopCss)}">${htmlOut}<div id="__gb_grip" title="按住上下拖动可调节面板高度"><i></i></div></div>
  <!-- ↑↑↑ extract-panel-ui.js 生成结束 ↑↑↑ -->
</div>
<script src="panel-ui.js"></script>
<script src="bridge.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(OUT_DIR, 'panel.html'), page, 'utf8');

// 统计绑定契约：面板里所有 id / class，供 bridge.js 与回归测试核对
const ids = [...new Set([...htmlOut.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))].sort();
const i18nKeys = [...new Set([...htmlOut.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))].sort();
fs.writeFileSync(path.join(OUT_DIR, 'panel-contract.json'),
  JSON.stringify({ generatedFrom: 'engine-server/resources/bookmarklet.js', ids, i18nKeys }, null, 2), 'utf8');

console.log('[extract-panel-ui] 面板 HTML ' + htmlOut.length + ' 字符，容器样式 ' + desktopCss.length + ' 字符');
console.log('[extract-panel-ui] DOM id ' + ids.length + ' 个：' + ids.slice(0, 16).join(', ') + (ids.length > 16 ? ' …' : ''));
console.log('[extract-panel-ui] data-i18n 键 ' + i18nKeys.length + ' 个');
console.log('[extract-panel-ui] → ' + path.join(OUT_DIR, 'panel.html'));
