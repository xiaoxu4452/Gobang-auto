#!/usr/bin/env node
/**
 * 回归护栏：五子棋练习器的**复盘独立窗口**。
 *
 * 用户 2026-09-19 的三条要求（原文）：
 *   「打开复盘，弹出一个新的窗口，就是一个新的窗口，这个窗口只有一个棋盘和下面的几个控制键，
 *     不参与任何功能的连接，比如说 AI 功能以及有禁手、无禁手功能」
 *   「在历史中打开某一个历史也是一个复盘也是一个新窗口，因为现在还是会有连接的情况」
 *   「点击复盘的时候，是一个特别简单的框，就是没有任何功能（没有 AI 和规则干扰的第三方纯棋盘框），
 *     只能用户自行落子，只有一个棋盘和复盘功能相关的几个功能键」
 * 同轮追加：
 *   「如果不通过历史在主界面上打开复盘的话，复盘里面就有单纯的『重来、保存局面和关闭』这三个按键，
 *     如果打开复盘这个独立窗口，再选择历史，背诵复盘、回顾复盘这几个按键又会重新出现」
 *   「打开复盘这个窗口的时间有点太长了，它会黑一会再打开」
 *
 * 这条链路横跨「一个页面 / 两个窗口 / 一个宿主」三层，肉眼看不出退化，所以拆成四段断言：
 *   A. 源码契约 —— ?rv=1 那条启动路径**不许**碰设置 / 存档 / 停靠栏 / 引擎档位；
 *      复盘键按来源（hist）分流；「已在独立窗口打开复盘」那句文案不许留着；
 *   B. 真实 Edge 无头加载 calc.html?rv=1 —— 行为级：主窗口那一套全收起、只留一行复盘键、
 *      **一个引擎请求都不发**、用户点棋盘能自行落子、摆出连珠就出现**天蓝标线**，
 *      以及 hist:false（主界面「复盘」）只留三个常驻键 / hist:true（历史）才露出「背诵 / 回顾」；
 *   C. 真实 exe 端到端（GB_TEST_OPEN_REVIEW / GB_TEST_SAVE_POS 钩子）——
 *      真开出一个 class=GbCalcReview 的顶层窗口、**先藏后显**（created → hidden → ready → shown）、
 *      WebView2 默认底色 = 页面底色（不闪黑/白）、真把局面投递过去并收到回执、
 *      「保存局面」真走系统「另存为」（GB_TEST_SAVE_PNG 指路，测试里不弹框）并真落盘成 PNG；
 *   D. 预热（不下任何钩子）—— 主窗口就绪后宿主会在后台把复盘窗**藏好**建出来（首次打开即秒开），
 *      且预热期间屏幕上**枚举不到** GbCalcReview（藏着的窗口不许漏到屏幕上/任务栏）。
 *
 * 用法：node tools/test-trainer-review.js
 *
 * ★ 想验证**发布版**（而不是 debug 构建目录）时：
 *     GB_RV_EXE="Desktop version/Desktop GomokuTrainer.exe" node tools/test-trainer-review.js
 *   发布目录的 exe 与 calc/ 都换了一套路径，是最容易出现「本地对、发布错」的地方
 *   （页面读的还是 exe 旁边的 calc/，少一个文件就整个窗口空白）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 默认测 debug 构建产物；GB_RV_EXE 可指向发布目录里的 exe 做「发布版也是好的」核对
const EXE = process.env.GB_RV_EXE
  ? path.resolve(ROOT, process.env.GB_RV_EXE)
  : path.join(ROOT, 'desktop-calculator', 'build', 'Desktop GomokuTrainer.exe');
const UI_DIR = path.join(ROOT, 'desktop-calculator', 'ui');
const CALC_HTML = path.join(UI_DIR, 'calc.html');
const HARNESS = path.join(UI_DIR, '_calc_rv_test.html');
const LISTWIN = path.join(__dirname, 'list-windows.py');
const PY = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanupHarness() { try { fs.unlinkSync(HARNESS); } catch (e) {} }
process.on('exit', cleanupHarness);

// ============================================================ A. 源码契约
console.log('== A. 复盘窗口的启动路径（源码契约）==');
const JS = fs.readFileSync(path.join(UI_DIR, 'calc.js'), 'utf8');
const CSS = fs.readFileSync(path.join(UI_DIR, 'calc.css'), 'utf8');
const HTML = fs.readFileSync(CALC_HTML, 'utf8');

ok('?rv=1 是**唯一**的复盘窗识别方式（严格匹配，不吃 rv=11 / xrv=1）',
  /var RV_MODE = \/\(\?:\^\|\[\?&\]\)rv=1\(\?:&\|\$\)\/\.test\(window\.location\.search \|\| ''\);/.test(JS));
ok('入口三分：VIS_MODE → bootVis()，RV_MODE → bootReview()，否则 boot()',
  /var GB_BOOT = VIS_MODE \? bootVis : \(RV_MODE \? bootReview : boot\);/.test(JS) &&
  /document\.addEventListener\('DOMContentLoaded', GB_BOOT\);/.test(JS));
{
  // bootReview 的整段函数体：不许出现「读设置 / 恢复存档 / 建停靠栏 / 问引擎档位 / 落局」这些东西
  const a = JS.indexOf('function bootReview()');
  const b = JS.indexOf('function reviewLoad(');
  const body = (a >= 0 && b > a) ? JS.slice(a, b) : '';
  ok('bootReview 函数体找得到（没被改名/删掉）', body.length > 200);
  const forbidden = [
    ['读设置', /loadSettings|restoreSettings/],
    ['恢复上次局面', /restoreGame/],
    ['建停靠栏', /defaultLayout|syncDocks|applyLayout/],
    ['建历史抽屉', /renderDrawer/],
    ['问引擎档位', /buildSelects|loadCores/],
    ['直接落局', /G\.moves\.push/],
    ['发分析请求', /refreshHeat|aiMove/],
  ];
  const bad = forbidden.filter((p) => p[1].test(body)).map((p) => p[0]);
  ok('★ bootReview 只做「棋盘 + 一行复盘键」：不读设置 / 不恢复局面 / 不建停靠栏 / 不问引擎',
    bad.length === 0, bad.length ? '仍然做了：' + bad.join('、') : '');
  ok('★ 复盘窗里只有用户在落子（棋盘 click 绑 onRvBoardClick，AI 不参与）',
    /els\.board\.addEventListener\('click', onRvBoardClick\);/.test(body) &&
    /function onRvBoardClick\(ev\)/.test(JS) &&
    /if \(G\.review && G\.review\.kind === 'recite'\) \{ reciteStep\(x, y\); return; \}/.test(JS));
}
// ★ 廿三轮同步：复盘窗的「关闭」键在**十八轮就删了**（用户要求「这个窗口本身是可以关闭的」），
//   这条老断言还在要它 → 一直在报红。现在改成守「它确实不存在」。
ok('★ 复盘窗没有「关闭」键（十八轮删除：右上系统关窗按钮即关闭，页面里不再有这颗键）',
  !/id="btn_rv_close"/.test(HTML) && !/btn_rv_close/.test(JS));
ok('宿主把局面投进来走 reviewData → reviewLoad（复盘窗从空盘起步）',
  /if \(m\.type === 'reviewData'\) reviewLoad\(m\.record \|\| null\);/.test(JS) &&
  /if \(HOST\) tellHost\(\{ type: 'reviewAck', moves: mv\.length \}\);/.test(JS));
// ★ 2026-09-19（用户要求）：「不通过历史、在主界面上打开复盘」→ 只有 重来 / 保存局面 / 关闭；
//   「打开复盘窗口后再（在历史里）选一局」→ 背诵 / 回顾那一组重新出现。
//   实现 = record 上的 hist 标志，只有 hist=true 才露 rvGroup。
ok('★ 复盘键按来源分流：只有「从历史打开」（或残局/VC 记录）才露「背诵 / 回顾」那一组',
  /var fromHist = !!\(rec && rec\.hist\) && mv\.length > 0;/.test(JS) &&
  // ★ 十八/二十轮：VC 题面（egFirst，整盘首帧）+ 确定过的残局（egLen>0）也露那一组
  /if \(els\.rvGroup\) els\.rvGroup\.hidden = !\(fromHist \|\| egFirst \|\| egLen > 0\);/.test(JS) &&
  !/els\.rvGroup\.hidden = !mv\.length;/.test(JS) &&
  /var fromHist = \(hist === undefined\) \? !!\(h && h\.hist\) : !!hist;/.test(JS) &&
  // 顶栏「复盘」显式 hist:false；历史条目 / 抽屉「打开」/ 右键「打开复盘」显式 true
  // ★ 2026-09-19：三条历史入口收进 openFromHistoryIndex（主窗口那支调 openReviewWindow(h,true)）
  /function openReviewFromBoard\(\) \{[\s\S]{0,240}?: null, false\);/.test(JS) &&
  /function openFromHistoryIndex\(idx\) \{[\s\S]{0,400}?openReviewWindow\(h, true\);/.test(JS) &&
  /openFromHistoryIndex\(idx\[0\]\);/.test(JS) &&
  /d\.onclick = function \(\) \{ openFromHistoryIndex\(idx\); \};/.test(JS));
// ★ 2026-09-19（用户要求）：「打开复盘这个独立窗口，**再选择历史**，背诵复盘、回顾复盘这几个
//   按键又会重新出现」⇒ 复盘窗自己多了一个「历史」键：点开的是**同一套抽屉**（wireDrawer），
//   挑一局 → 就地 reviewLoad(hist=true) → rvGroup 露出来。
//   这不是「参与功能连接」：抽屉只读 localStorage 的历史、只把记录摆进本窗口，不碰 AI/规则/主窗口。
ok('★ 复盘窗里也能取历史（「历史」键 + 共用抽屉；挑一局就地载入 → 露出背诵/回顾）',
  /<button id="btn_rv_hist" class="btn">历史<\/button>/.test(HTML) &&
  // 「历史」与「重来 / 保存局面 / 关闭」同在 #rvGroup **之外** → 纯空盘时也看得见
  HTML.indexOf('id="btn_rv_hist"') > HTML.indexOf('id="rvGroup"') &&
  HTML.indexOf('id="btn_rv_hist"') < HTML.indexOf('id="ctxMenu"') &&
  /els\.btn_rv_hist\.onclick = function \(\) \{\s*\n\s*if \(els\.drawer\.hidden\) openDrawer\('hist'\); else closeDrawer\(\);/.test(JS) &&
  /wireDrawer\(\);\s*\/\/ 抽屉接线与主窗口共用/.test(JS) &&
  // 复盘窗里那条「打开一局」是**就地载入**（不再绕宿主开第三个窗口）
  /if \(RV_MODE\) \{ reviewLoad\(recordForReview\(h, true\)\); closeDrawer\(\); return true; \}/.test(JS) &&
  // CSS：抽屉在复盘窗里默认仍收着，只有摘掉 hidden 才显示（不再被 body.rv 一刀切掉）
  /body\.rv #drawer\[hidden\]\{display:none\}/.test(CSS) &&
  /body\.rv #drawer:not\(\[hidden\]\)\{display:flex\}/.test(CSS) &&
  !/body\.rv #dockR,body\.rv #drawer/.test(CSS));
ok('★ 常驻键（重来 / 保存局面 / 历史）在 HTML 里就在 #rvGroup **之外**（永远不被那组连坐）',
  HTML.indexOf('id="rvGroup"') > 0 && HTML.indexOf('id="btn_redo_rv"') > HTML.indexOf('id="rvGroup"') &&
  HTML.indexOf('id="btn_save_rv"') > HTML.indexOf('id="rvGroup"') &&
  HTML.indexOf('id="btn_rv_hist"') > HTML.indexOf('id="rvGroup"') &&
  !/id="btn_rv_close"/.test(HTML));                                       // ★十八轮：关闭键已删
ok('★ 状态栏那句「已在独立窗口打开复盘」已删净（文案 + 调用点 + i18n 键）',
  !/已在独立窗口打开复盘/.test(JS) && !/Opened the review in its own window/.test(JS) &&
  !/rvOpening/.test(JS));
// ★ 2026-09-19：复盘窗「黑一会才出来」的修法 —— 页面把底色报上去，宿主据此设
//   DefaultBackgroundColor 并且**等报到才** ShowWindow（show 的判定在 host.cpp 里，见 C 段日志）。
ok('★ 复盘页报到时把**页面底色**一起报上去（宿主拿它当 WebView2 默认底色 → 不闪黑/白）',
  /function pageBgHex\(\)/.test(JS) &&
  /getComputedStyle\(document\.body\)\.backgroundColor/.test(JS) &&
  // ★ 2026-09-19：ready 报文升级为 { type, theme, bg, lang }（Wave 5 主题跟随用）——bg 仍在
  /postMessage\(\{ type: 'ready', theme: themeKey\(\), bg: pageBgHex\(\), lang: S\.lang \}\)/.test(JS) &&
  /body\{\s*margin:0; background:var\(--bg\)/.test(CSS));
ok('复盘窗永远按无禁手渲染（ruleForRender → 0），不读用户选的规则',
  /function ruleForRender\(\) \{ return RV_MODE \? 0 : \+S\.rule; \}/.test(JS) &&
  !/S\.rule/.test(JS.slice(JS.indexOf('function bootReview()'), JS.indexOf('function reviewLoad('))));
ok('复盘窗不用 applyTheme（不读主题设置，永远是 :root 那套配色）',
  !/applyTheme/.test(JS.slice(JS.indexOf('function bootReview()'), JS.indexOf('function reviewLoad('))) &&
  // 2026-09-20：棋盘那组变量（含 --winline）已统一到 :root 一档，这里跟着换色值。
  /--winline:#1e9bf0;/.test(CSS));
ok('★ 复盘窗启动时把整行复盘键**真的显出来**（摘掉 #rvBar 的 hidden）',
  /els\.rvBar\.hidden = false;/.test(JS.slice(JS.indexOf('function bootReview()'), JS.indexOf('function reviewLoad('))) &&
  /#rvBar\{display:none\}/.test(CSS) && /body\.rv #rvBar:not\(\[hidden\]\)/.test(CSS));
// ★ 2026-09-19（用户要求）：回顾复盘加「播放/暂停」+ 单步速度 0.5~5s + 键盘操控
//   （← 上一子、→ 下一子、空格 播放/暂停 —— 用户补充「所有播放键都适配空格键」）。
//   自动播放只属于回顾复盘：背诵要凭记忆落子，方向键/自动播放一开就把答案走出来了。
ok('★ 回顾复盘：播放/暂停键 + 0.5~5s 速度档 + ←/→/空格 键盘操控（只属回顾态）',
  // HTML：播放键与速度档在 rvGroup 里、◀ ▶ 之后、退出之前，且默认 hidden
  /<button id="btn_rv_play" class="btn sq" hidden>播放<\/button>/.test(HTML) &&
  /<select id="rvSpeed" hidden/.test(HTML) && /<option value="0\.5">0\.5s<\/option>/.test(HTML) &&
  /<option value="5">5s<\/option>/.test(HTML) &&
  HTML.indexOf('id="btn_rv_play"') > HTML.indexOf('id="btn_rv_next"') &&
  HTML.indexOf('id="rvSpeed"') < HTML.indexOf('id="btn_rv_exit"') &&
  // grab 名单拿到元素
  /'btn_rv_play','rvSpeed',/.test(JS) &&
  // 播放引擎：setTimeout 链、间隔取自设置（0.5~5 兜底回 1）、播完自动停
  /function rvStepSec\(\) \{/.test(JS) &&
  /if \(!\(v >= 0\.5\) \|\| !\(v <= 5\)\) v = 1;/.test(JS) &&
  /function rvStepMs\(\) \{ return Math\.round\(rvStepSec\(\) \* 1000\); \}/.test(JS) &&
  /G\.rvTimer = setTimeout\(step, rvStepMs\(\)\);/.test(JS) &&
  /if \(G\.review\.k >= G\.loaded\.moves\.length\) \{ rvStopPlay\(\); return; \}/.test(JS) &&
  // 键盘：←/→/空格 都在，且只在 kind==='replay' 时接住；焦点在表单控件里不抢。
  // ★ 2026-09-25：入口判断放宽成 `if (!G.review) return`（Ctrl+Z / Ctrl+R 两种复盘都认），
  //   「只属回顾态」改由下面那句 `else if (G.review.kind !== 'replay')` 负责 ——
  //   方向键 / 空格仍然只在回顾态生效，背诵态一律不接。
  /window\.addEventListener\('keydown', function \(e\) \{[\s\S]{0,120}?if \(!G\.review\) return;/.test(JS) &&
  /\} else if \(G\.review\.kind !== 'replay'\) \{/.test(JS) &&
  /\^\(INPUT\|SELECT\|TEXTAREA\)\$/.test(JS) &&
  /e\.key === 'ArrowLeft'/.test(JS) && /e\.key === 'ArrowRight'/.test(JS) &&
  /e\.key === ' ' \|\| e\.code === 'Space'/.test(JS) &&
  /rvSetPlaying\(!G\.rvPlaying\);/.test(JS) &&
  // 播放中手动进退：经 rvSetPlaying(true) 重排计时（不会连跳两手）。
  // ★ 2026-09-25：四处「改 k → applyReviewStep → 重排」统一收进 rvGoTo，只留这一处实现。
  /function rvGoTo\(k\) \{/.test(JS) &&
  /applyReviewStep\(\);[\s\S]{0,40}?if \(G\.rvPlaying\) rvSetPlaying\(true\);/.test(JS) &&
  JS.match(/rvGoTo\(/g).length >= 5 &&
  // 速度档随设置持久化 + 播放中改速度下一手生效
  /S\.rvSpeedSec = \+els\.rvSpeed\.value \|\| 1;/.test(JS) &&
  /if \(G\.rvPlaying\) rvSetPlaying\(true\);\s+\/\/ 播放中改速度/.test(JS) &&
  // 只属回顾态：startRecite / hideReviewNav 一律收掉播放键与速度档
  /rvStopPlay\(\);\s*\n\s*if \(els\.btn_rv_play\) els\.btn_rv_play\.hidden = true;\s*\n\s*if \(els\.rvSpeed\) els\.rvSpeed\.hidden = true;\s*\n\s*els\.btn_rv_exit\.hidden = false;/.test(JS) &&
  JS.slice(JS.indexOf('function hideReviewNav()'), JS.indexOf('function setMissBox()'))
    .match(/rvStopPlay\(\);/).length === 1);
ok('「保存局面」在复盘窗里也是同一个入口（btn_save_rv → savePos）',
  /els\.btn_save_rv\.onclick = savePos;/.test(JS) &&
  /tellHost\(\{ type: 'savePng', name: name, data: url \}\);/.test(JS));

// ============================================================ B. 真实 Edge 无头跑 ?rv=1
const SHELL_JS = `
<script>
(function () {
  window.__errs = [];
  window.__msgs = [];
  window.__fetches = [];
  window.onerror = function (m, s, l) { window.__errs.push(String(m) + ' @' + l); return true; };
  window.chrome = {
    webview: {
      addEventListener: function (t, fn) { window.__handler = fn; },
      postMessage: function (s) { window.__msgs.push(typeof s === 'string' ? s : JSON.stringify(s)); },
    },
  };
  // ★ 复盘窗必须**一个引擎请求都不发** —— 这里把每一次 fetch 都记下来当判据。
  window.fetch = function (u) { window.__fetches.push(String(u)); return Promise.reject(new Error('stub: no engine in test')); };
})();
</script>
`;

const RV_TEST_JS = `
<script>
(function () {
  var out = [];
  function P(l, v) { out.push('PASS | ' + l + ' | ' + v); }
  function F(l, v) { out.push('FAIL | ' + l + ' | ' + v); }
  function finish() {
    var pre = document.createElement('pre');
    pre.id = '__test_out';
    var B = '<<' + 'GBRES' + '>>', E = '<<' + 'GBEND' + '>>';
    pre.textContent = '\\n' + B + '\\n' + out.join('\\n') + '\\n' + E + '\\n';
    document.body.appendChild(pre);
  }
  function vis(id) {
    var e = document.getElementById(id);
    return e ? getComputedStyle(e).display : 'missing';
  }
  // ★ 「真的占位了吗」：父级 display:none 时子元素的 getComputedStyle 仍会报自己的 display，
  //   只看 display 会假绿（#rvBar 忘了摘 hidden 时就是这么骗过一次）。所以另给一个判据。
  function shown(id) {
    var e = document.getElementById(id);
    if (!e) return false;
    var r = e.getBoundingClientRect();
    return e.offsetParent !== null && r.width > 2 && r.height > 2;
  }
  // 抽屉是 position:fixed → offsetParent 恒为 null，shown() 那个判据对它不成立，另给一个「有没有真的占位」
  function box(id) {
    var e = document.getElementById(id);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return (r.width > 2 && r.height > 2) ? r : null;
  }
  function done() {
    if (window.__errs && window.__errs.length) F('复盘窗没有 JS 异常', window.__errs.join(' ; '));
    else P('复盘窗没有 JS 异常', '0 条');

    // ---- 分流：body.rv + 主窗口那一套全部收起 ----
    if (document.body.classList.contains('rv')) P('复盘窗加了 body.rv（CSS 分流生效）', 'true');
    else F('复盘窗加了 body.rv（CSS 分流生效）', '没有 rv 类');
    // 主窗口那一套一律收起。★ #drawer 不在这个名单里了（2026-09-19 用户要求：
    // 复盘窗里点「历史」也要能翻历史）—— 它由阶段 3 单独验：**默认仍必须是收着的**。
    ['hdr', 'dockL', 'dockR', 'openBar', 'boardFoot'].forEach(function (id) {
      if (vis(id) === 'none') P('主窗口的 #' + id + ' 已收起（复盘窗里没有）', 'none');
      else F('主窗口的 #' + id + ' 已收起（复盘窗里没有）', vis(id));
    });
    if (vis('rvBar') !== 'none' && shown('rvBar'))
      P('★ 复盘功能键那一行**真的占位可见**（#rvBar 摘掉了 hidden）',
        Math.round(document.getElementById('rvBar').getBoundingClientRect().width) + 'px 宽');
    else F('★ 复盘功能键那一行**真的占位可见**（#rvBar 摘掉了 hidden）',
           'display=' + vis('rvBar') + ' shown=' + shown('rvBar'));

    // ---- 没有记录（顶栏「复盘」）= 纯空盘：中间那组不出现，只留 重来 / 保存局面 / 关闭 ----
    if (document.getElementById('rvGroup').hidden)
      P('没记录进来（顶栏「复盘」）= 纯空盘：不出现 背诵 / 回顾 / 背错', 'hidden');
    else F('没记录进来（顶栏「复盘」）= 纯空盘：不出现 背诵 / 回顾 / 背错', 'visible');
    // ★ 十八轮：复盘窗的「关闭」键已删 → 常驻键只剩 重来 / 保存局面 / 历史
    var keep = ['btn_redo_rv', 'btn_save_rv', 'btn_rv_hist'].filter(shown);
    if (keep.length === 3) P('纯空盘仍保留并**真的显示** 重来 / 保存局面 / 历史 三个常驻键', keep.join(','));
    else F('纯空盘仍保留并**真的显示** 重来 / 保存局面 / 历史 三个常驻键', keep.join(',') || '(一个都没占位)');

    // ---- 棋盘画出来了 ----
    var cv = document.getElementById('board');
    if (!cv) { F('棋盘 canvas 存在', 'not found'); finish(); return; }
    P('棋盘 canvas 存在', cv.width + 'x' + cv.height);
    if (cv.width > 100 && cv.height > 100) P('棋盘尺寸合理（>100px）', cv.width + 'px');
    else F('棋盘尺寸合理（>100px）', cv.width + 'px');

    // ---- ★ 一个引擎请求都不发 ----
    if (window.__fetches.length === 0) P('★ 复盘窗一个引擎请求都没发（不连 AI）', '0 次');
    else F('★ 复盘窗一个引擎请求都没发（不连 AI）', window.__fetches.join(' | ').slice(0, 120));

    // ---- 用户自行落子：摆一个黑五连（黑 x=7 的 y=7..11，白 x=8 陪四手）----
    var g = window.geom();
    var r = cv.getBoundingClientRect();
    function click(x, y) {
      cv.dispatchEvent(new MouseEvent('click', {
        clientX: r.left + g.pad + x * g.gap, clientY: r.top + g.pad + y * g.gap, bubbles: true,
      }));
    }
    [[7, 7], [8, 7], [7, 8], [8, 8], [7, 9], [8, 9], [7, 10], [8, 10], [7, 11]]
      .forEach(function (p) { click(p[0], p[1]); });
    var G = window.G || {};
    var stonesOk = G.moves && G.moves.length === 9 &&
                   G.board && G.board[7][7] === 1 && G.board[11][7] === 1 && G.board[7][8] === 2;
    if (stonesOk) P('★ 用户能在复盘窗棋盘上自行落子（9 手：黑在 x=7 连成五）', G.moves.length + ' 手');
    else F('★ 用户能在复盘窗棋盘上自行落子（9 手：黑在 x=7 连成五）',
           (G.moves ? G.moves.length : '?') + ' 手');
    if (window.__fetches.length === 0) P('★ 落子全程依然没有引擎请求（AI 真的没参与）', '0 次');
    else F('★ 落子全程依然没有引擎请求（AI 真的没参与）', window.__fetches.length + ' 次');

    // ---- ★ 天蓝连珠标线：取 (7,7)-(7,8) 正中间那一点（两颗子之间，只有标线）----
    var dpr = window.devicePixelRatio || 1;
    function pxAt(x, y) {
      var d = cv.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    }
    var linePx = pxAt(g.pad + 7 * g.gap, g.pad + 7.5 * g.gap);
    var skyBlue = linePx[2] > 150 && linePx[2] - linePx[0] > 90 && linePx[2] > linePx[1] + 20;
    if (skyBlue) P('★ 连珠段被**天蓝色**标线连起来（两颗子之间的中点上就是天蓝）',
                   'rgb(' + linePx.join(',') + ')');
    else F('★ 连珠段被**天蓝色**标线连起来（两颗子之间的中点上就是天蓝）',
           'rgb(' + linePx.join(',') + ')');
    // 对照点：没连珠的地方（x=2 那一路的两子之间）不许是天蓝
    var ctrlPx = pxAt(g.pad + 2 * g.gap, g.pad + 2.5 * g.gap);
    var ctrlBlue = ctrlPx[2] > 150 && ctrlPx[2] - ctrlPx[0] > 90;
    if (!ctrlBlue) P('对照点（没连珠的位置）没有天蓝标线', 'rgb(' + ctrlPx.join(',') + ')');
    else F('对照点（没连珠的位置）没有天蓝标线', 'rgb(' + ctrlPx.join(',') + ')');

    // ---- ★ 阶段 1.5：主界面点「复盘」那条路（hist:false）----
    //   用户要求：不通过历史、在主界面上打开复盘 → 复盘里就只有 重来 / 保存局面 / 关闭。
    //   注意这里**故意带着 5 手棋**投进去：判定依据必须是 hist，而不是「有没有手数」。
    if (typeof window.__handler === 'function') {
      window.__handler({ data: { type: 'reviewData', record: {
        ts: 0, src: 'local', hist: false,
        moves: [[7, 7, 1], [8, 7, 2], [7, 8, 1], [8, 8, 2], [7, 9, 1]],
      } } });
    }
    if (document.getElementById('rvGroup').hidden && !shown('btn_recite') && !shown('btn_replay'))
      P('★ 主界面「复盘」（hist:false，即使带手数）→ 不露背诵 / 回顾', 'hidden');
    else F('★ 主界面「复盘」（hist:false，即使带手数）→ 不露背诵 / 回顾',
           'group.hidden=' + document.getElementById('rvGroup').hidden +
           ' recite=' + shown('btn_recite') + ' replay=' + shown('btn_replay'));
    var keep2 = ['btn_redo_rv', 'btn_save_rv'].filter(shown);
    if (keep2.length === 2)
      P('★ 这时复盘窗里就只有 重来 / 保存局面 这两个常驻键（+ 历史）',
        keep2.join(',') + (window.G && window.G.moves && window.G.moves.length === 0 ? ' · 空盘' : ''));
    else F('★ 这时复盘窗里就只有 重来 / 保存局面 这两个常驻键（+ 历史）', keep2.join(',') || '(缺键)');

    // ---- 阶段 2：宿主投递一局（hist:true = 从历史打开）→ 露出「背诵 / 回顾」并各自能走通 ----
    var rec = { ts: 0, src: 'local', hist: true,
                moves: [[7, 7, 1], [8, 7, 2], [7, 8, 1], [8, 8, 2], [7, 9, 1],
                        [8, 9, 2], [7, 10, 1], [8, 10, 2], [7, 11, 1]] };
    if (typeof window.__handler === 'function') window.__handler({ data: { type: 'reviewData', record: rec } });
    if (!document.getElementById('rvGroup').hidden && shown('btn_recite') && shown('btn_replay'))
      P('★ 从历史投一局进来后：背诵复盘 / 回顾复盘 / 背错 N 又重新出现并**真的显示**', 'visible');
    else F('★ 从历史投一局进来后：背诵复盘 / 回顾复盘 / 背错 N 又重新出现并**真的显示**',
           'group=' + document.getElementById('rvGroup').hidden + ' recite=' + shown('btn_recite'));
    var G2 = window.G || {};
    if (G2.moves && G2.moves.length === 0)
      P('★ 复盘窗进来一律是**全新空盘**（记录只当数据源，绝不预摆）', '0 手');
    else F('★ 复盘窗进来一律是**全新空盘**（记录只当数据源，绝不预摆）',
           (G2.moves ? G2.moves.length : '?') + ' 手');
    // ★ 2026-09-19：回调内发出的报文现在走**延迟投递**（WebView2 会丢掉回调里的同步 post），
    //   所以这条断言推迟一个宏任务，等 shim 真正收到。
    setTimeout(function () {
      if (window.__msgs.join(' ').indexOf('reviewAck') >= 0)
        P('复盘窗把「收到几手」回报给宿主（reviewAck）', 'ok');
      else F('复盘窗把「收到几手」回报给宿主（reviewAck）', window.__msgs.join(' | ').slice(0, 80));
    }, 0);

    // 背诵：故意点错位置 → 背错 +1，且该键进入选中态
    document.getElementById('btn_recite').click();
    var on = document.getElementById('btn_recite').classList.contains('on') &&
             !document.getElementById('btn_replay').classList.contains('on');
    if (on) P('点「背诵复盘」→ 该键进入选中态', 'on');
    else F('点「背诵复盘」→ 该键进入选中态', 'off');
    click(0, 0);                                  // 第 0 手本该是 (7,7)
    var missTxt = document.getElementById('rvMiss').textContent;
    if (missTxt.indexOf('1') >= 0) P('背诵点错一子 → 「背错 N」计数到 1', missTxt);
    else F('背诵点错一子 → 「背错 N」计数到 1', missTxt);

    // 退出 → 回到那一行（三角收起）；再「回顾复盘」→ 三角出现 + 边框变蓝
    document.getElementById('btn_rv_exit').click();
    var back = !document.getElementById('rvGroup').hidden &&
               document.getElementById('btn_rv_exit').hidden;
    if (back) P('「退出」→ 回到复盘那一行（◀ ▶ 收起）', 'ok');
    else F('「退出」→ 回到复盘那一行（◀ ▶ 收起）', 'state');
    document.getElementById('btn_replay').click();
    var rvBar = document.getElementById('rvBar');
    var stepOk = document.getElementById('btn_replay').classList.contains('on') &&
                 rvBar.classList.contains('stepping') &&
                 !document.getElementById('btn_rv_prev').hidden &&
                 !document.getElementById('btn_rv_next').hidden;
    if (stepOk) P('点「回顾复盘」→ 该键选中 + ◀ ▶ 出现（stepping）', 'ok');
    else F('点「回顾复盘」→ 该键选中 + ◀ ▶ 出现（stepping）', 'state');
    var m = /rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/.exec(getComputedStyle(document.getElementById('btn_rv_next')).borderTopColor) || [];
    var isBlue = m.length === 4 && (+m[3] > +m[1] + 60) && (+m[3] > +m[2] + 40);
    if (rvBar.classList.contains('stepping') && isBlue)
      P('回顾态 ◀ ▶ 的边框确实是蓝色', 'rgb(' + m.slice(1) + ')');
    else F('回顾态 ◀ ▶ 的边框确实是蓝色', 'rgb(' + m.slice(1) + ')');
    document.getElementById('btn_rv_next').click();      // 走一手
    var posTxt = document.getElementById('rvPos').textContent;
    if (/1\\s*\\/\\s*9/.test(posTxt)) P('「▶」能一手手往前走（0/9 → 1/9）', posTxt);
    else F('「▶」能一手手往前走（0/9 → 1/9）', posTxt);
    // ★ 键盘 ←/→（用户要求 2026-09-19：方向键上一子/下一子）。同步断言，
    //   走 window 级 keydown（复盘窗的监听就挂在那里）；e.target=window 不带 tagName，
    //   正好覆盖「焦点不在表单控件里」这条真实路径。
    function key(k) { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); }
    key('ArrowLeft');
    if (/^0\\s*\\//.test(document.getElementById('rvPos').textContent))
      P('★ 键盘 ← 上一子（1/9 → 0/9）', document.getElementById('rvPos').textContent);
    else F('★ 键盘 ← 上一子（1/9 → 0/9）', document.getElementById('rvPos').textContent);
    key('ArrowRight');
    if (/^1\\s*\\//.test(document.getElementById('rvPos').textContent))
      P('★ 键盘 → 下一子（0/9 → 1/9）', document.getElementById('rvPos').textContent);
    else F('★ 键盘 → 下一子（0/9 → 1/9）', document.getElementById('rvPos').textContent);

    // ---- ★ 阶段 3：复盘窗里点「历史」→ 就地挑一局 → 背诵 / 回顾又出现（用户要求）----
    //   用户原话：「如果用户还没有选择历史，直接打开复盘，就没有背诵复盘这几个功能键，
    //   就只有重来、保存局面和关闭这三个按钮」+「打开复盘这个独立窗口，再选择历史，
    //   背诵复盘、回顾复盘这几个按键又会重新出现」。这一阶段就是把后半句验穿。
    document.getElementById('btn_rv_exit').click();          // 先退出回顾态，回到常驻那一行
    try {
      localStorage.setItem('gbcalc.history.v1', JSON.stringify([
        { ts: 1700000000000, src: 'local', rule: 0, name: '复盘窗取的一局',
          moves: [[7,7,1],[8,7,2],[7,8,1],[8,8,2],[7,9,1],[8,9,2],[7,10,1],[8,10,2],[7,11,1]] },
      ]));
    } catch (e) {}
    if (vis('drawer') === 'none') P('复盘窗里历史抽屉**默认是收着的**（不占棋盘地方）', 'none');
    else F('复盘窗里历史抽屉**默认是收着的**（不占棋盘地方）', vis('drawer'));
    if (shown('btn_rv_hist')) P('★ 「历史」键是**常驻**的（没选历史时它也在，跟重来/保存局面/关闭一样）', 'visible');
    else F('★ 「历史」键是**常驻**的（没选历史时它也在，跟重来/保存局面/关闭一样）', 'not shown');
    document.getElementById('btn_rv_hist').click();
    if (vis('drawer') !== 'none' && box('drawer'))
      P('★ 点「历史」→ 抽屉真的滑出来（复盘窗里也能翻历史）',
        Math.round(box('drawer').width) + '×' + Math.round(box('drawer').height));
    else F('★ 点「历史」→ 抽屉真的滑出来（复盘窗里也能翻历史）',
      'display=' + vis('drawer') + ' box=' + !!box('drawer'));
    var hItems = document.querySelectorAll('#drList .item');
    if (hItems.length === 1 && /复盘窗取的一局/.test(hItems[0].textContent))
      P('复盘窗抽屉里列出了那一局（含自己起的名字）', hItems[0].textContent.slice(0, 40));
    else F('复盘窗抽屉里列出了那一局（含自己起的名字）', hItems.length + ' 条：' +
      (hItems[0] ? hItems[0].textContent.slice(0, 40) : '(空)'));
    if (hItems[0]) hItems[0].click();                        // 就地载入（不是再开第三个窗口）
    if (vis('drawer') === 'none' && !document.getElementById('rvGroup').hidden && shown('btn_recite'))
      P('★ 复盘窗里挑一局 → 就地载入 + 抽屉收起 + **背诵 / 回顾重新出现**', 'ok');
    else F('★ 复盘窗里挑一局 → 就地载入 + 抽屉收起 + **背诵 / 回顾重新出现**',
      'drawer=' + vis('drawer') + ' group.hidden=' + document.getElementById('rvGroup').hidden +
      ' recite=' + shown('btn_recite'));
    if (window.G && window.G.moves && window.G.moves.length === 0)
      P('就地载入后棋盘依旧是**空盘**（记录只当背诵/回顾的数据源，绝不预摆）', '0 手');
    else F('就地载入后棋盘依旧是**空盘**（记录只当背诵/回顾的数据源，绝不预摆）',
      (window.G && window.G.moves ? window.G.moves.length : '?') + ' 手');
    if (window.__msgs.join(' ').indexOf('openReview') < 0)
      P('★ 复盘窗自己挑历史**不会再开一个窗口**（不绕宿主，没有 openReview 报文）', 'ok');
    else F('★ 复盘窗自己挑历史**不会再开一个窗口**（不绕宿主，没有 openReview 报文）',
      window.__msgs.join(' | ').slice(0, 80));
    if (window.__fetches.length === 0) P('★ 翻历史全程也**没有引擎请求**（依然不连 AI）', '0 次');
    else F('★ 翻历史全程也**没有引擎请求**（依然不连 AI）', window.__fetches.length + ' 次');

    // ---- ★ 阶段 3.6（廿三轮，用户要求）**真·端到端**：历史里的**残局记录**
    //   走抽屉 → recordForReview → reviewLoad 这条**真实链路**（不是直接投 record），
    //   第一眼必须是「还没有额外落子前」的残局布局。此前 recordForReview 把 eg/egLen 丢掉，
    //   这条路第一眼是空盘、背诵从第一颗子开始 —— 这条断言就是那次的守卫。 ----
    try {
      localStorage.setItem('gbcalc.history.v1', JSON.stringify([
        { ts: 1700000000001, src: 'local', rule: 0, name: '确定的残局', eg: true, egLen: 4,
          moves: [[7, 7, 1], [8, 7, 2], [7, 8, 1], [9, 9, 2],     // 前 4 手 = 那个残局
                  [8, 8, 1], [8, 9, 2], [7, 9, 1], [7, 10, 2]] }, // 其后 4 手 = 额外研究着法
      ]));
    } catch (e) {}
    document.getElementById('btn_rv_hist').click();
    var egItems = document.querySelectorAll('#drList .item');
    if (egItems[0]) egItems[0].click();
    var egN2 = (window.G && window.G.moves) ? window.G.moves.length : -1;
    if (egN2 === 4) P('★ 历史里的残局记录 → 打开第一眼就是**残局那 4 手**（eg/egLen 没被丢掉）', egN2 + ' 手');
    else F('★ 历史里的残局记录 → 打开第一眼就是**残局那 4 手**（eg/egLen 没被丢掉）', egN2 + ' 手');
    if (egItems[0] && /Endgame/.test(egItems[0].textContent))
      P('历史条目带 Endgame 徽标（残局记录一眼能认出来）', 'ok');
    else F('历史条目带 Endgame 徽标（残局记录一眼能认出来）',
      egItems[0] ? egItems[0].textContent.slice(0, 40) : '(没有条目)');

    // ---- ★ 阶段 3.5（廿三轮，用户要求）：残局记录（eg/egLen）打开 → **第一眼就是那个残局** ----
    //   用户原话：「如果是有残局状态存进历史的话，打开这个历史，第一眼应该是这个还没有额外落子
    //   前的残局的黑白子的布局状况」。⇒ 前 egLen 手一次摆上（其后的研究手**不铺**），
    //   背诵/回顾从 egLen 之后数起、绝不到第一颗子。
    var egRec = { ts: 0, src: 'local', hist: true, eg: true, egLen: 5,
                  moves: [[7, 7, 1], [8, 7, 2], [7, 8, 1], [8, 8, 2], [7, 9, 1],     // 前 5 手 = 确定的残局
                          [8, 9, 2], [7, 10, 1], [8, 10, 2], [7, 11, 1], [8, 11, 2], [7, 12, 1]] };
    if (typeof window.__handler === 'function') window.__handler({ data: { type: 'reviewData', record: egRec } });
    var egN = (window.G && window.G.moves) ? window.G.moves.length : -1;
    if (egN === 5) P('★ 打开残局记录 → 第一眼就是**残局那 5 手**（其后的 6 手研究着法不铺）', egN + ' 手');
    else F('★ 打开残局记录 → 第一眼就是**残局那 5 手**（其后的 6 手研究着法不铺）', egN + ' 手');
    document.getElementById('btn_replay').click();
    var egK = (window.G && window.G.review) ? window.G.review.k : -1;
    if (egK === 5) P('★ 回顾/背诵从残局之后数起（k 从 5 起步，不是 0）', 'k=' + egK);
    else F('★ 回顾/背诵从残局之后数起（k 从 5 起步，不是 0）', 'k=' + egK);
    document.getElementById('btn_rv_exit').click();

    // 关闭：键已删（★十八轮）—— 关窗交给右上系统按钮，页面里不该再有这颗键
    if (!document.getElementById('btn_rv_close'))
      P('★ 复盘窗不再有「关闭」键（右上系统关窗按钮即关闭）', 'ok');
    else F('★ 复盘窗不再有「关闭」键（右上系统关窗按钮即关闭）', 'still there');

    // ---- ★ 播放/暂停 + 速度档（用户要求 2026-09-19）—— 异步段放最后，finish 由它收尾 ----
    //   virtual-time 预算 12s 足够：默认 1s 档播放 1.4s 应前进 ≥1 手；暂停后 1.5s 应原地不动。
    var playBtn = document.getElementById('btn_rv_play'), speedSel = document.getElementById('rvSpeed');
    document.getElementById('btn_replay').click();       // 重新进入回顾态（此时 k=0，0/9）
    var pvOk = playBtn && !playBtn.hidden && speedSel && !speedSel.hidden && speedSel.options.length >= 5;
    if (pvOk) P('★ 回顾态里「播放」键与速度档（0.5~5s，' + speedSel.options.length + ' 档）都出现', 'ok');
    else F('★ 回顾态里「播放」键与速度档（0.5~5s）都出现',
           playBtn ? ('play.hidden=' + playBtn.hidden + ' speed.hidden=' + (speedSel ? speedSel.hidden : '?')) : '键不存在');
    var posBefore = document.getElementById('rvPos').textContent;   // 应为 0 / 9
    key(' ');                                            // 空格 = 播放（用户补充：所有播放键都适配空格键）
    if (playBtn.classList.contains('on') && playBtn.textContent === '暂停')
      P('★ 空格 → 播放开始（键亮 + 文案变「暂停」）', playBtn.textContent);
    else F('★ 空格 → 播放开始（键亮 + 文案变「暂停」）',
           playBtn.textContent + ' on=' + playBtn.classList.contains('on'));
    setTimeout(function () {
      var posNow = document.getElementById('rvPos').textContent;
      // 默认 1s 档：1.4s 时恰好走过 1 手（第二手在 t=2.0s）→ 断「比播放前前进了」即可
      if (posNow !== posBefore && !/^0\\s*\\//.test(posNow))
        P('★ 播放 ~1.4s 后从 ' + posBefore.trim() + ' 前进到 ' + posNow.trim() + '（默认 1s 档）', posNow);
      else F('★ 播放 ~1.4s 后自动前进（默认 1s 档）', posBefore + ' → ' + posNow);
      key(' ');                                          // 再按空格 → 暂停
      var posPaused = document.getElementById('rvPos').textContent;
      if (!playBtn.classList.contains('on') && playBtn.textContent === '播放')
        P('★ 再按空格 → 暂停（键灭 + 文案回「播放」）', 'ok');
      else F('★ 再按空格 → 暂停（键灭 + 文案回「播放」）', playBtn.textContent);
      setTimeout(function () {
        var posStop = document.getElementById('rvPos').textContent;
        if (posStop === posPaused)
          P('★ 暂停后手数保持不动（停在 ' + posStop + '）', posStop);
        else F('★ 暂停后手数保持不动', posPaused + ' → ' + posStop);
        // 播放键本体（点击，不走键盘）同样能切换
        playBtn.click();
        if (playBtn.classList.contains('on')) P('★ 点「播放」键本体也能开始播放', 'on');
        else F('★ 点「播放」键本体也能开始播放', 'off');
        playBtn.click();
        if (!playBtn.classList.contains('on')) P('★ 再点「播放」键本体 = 暂停', 'off');
        else F('★ 再点「播放」键本体 = 暂停', 'on');
        document.getElementById('btn_rv_exit').click();  // 清场：退出回顾态（hideReviewNav 收播放键）
        if (playBtn.hidden && speedSel.hidden)
          P('★ 退出回顾态 → 播放键与速度档一并收起', 'hidden');
        else F('★ 退出回顾态 → 播放键与速度档一并收起',
               'play.hidden=' + playBtn.hidden + ' speed.hidden=' + speedSel.hidden);
        finish();
      }, 1500);
    }, 1400);
  }
  window.addEventListener('DOMContentLoaded', function () { setTimeout(done, 1200); });
})();
</script>
`;

function runBrowser() {
  let browser = null;
  for (const b of BROWSERS) { if (fs.existsSync(b)) { browser = b; break; } }
  if (!browser) { console.log('  (未找到 Edge/Chrome，跳过 B 段)'); return Promise.resolve(); }

  for (const [name, src] of [['SHELL_JS', SHELL_JS], ['RV_TEST_JS', RV_TEST_JS]]) {
    const body = src.replace(/^\s*<script>\s*/, '').replace(/<\/script>\s*$/, '');
    try { new vm.Script(body); } catch (e) { console.error(name + ' 语法错误：' + e.message); process.exit(1); }
  }
  let html = fs.readFileSync(CALC_HTML, 'utf8');
  const atShell = html.indexOf('<script src="calc.js">');
  if (atShell < 0) { console.error('找不到 calc.js 引用'); process.exit(1); }
  html = html.slice(0, atShell) + SHELL_JS + html.slice(atShell);
  const atEnd = html.lastIndexOf('</body>');
  html = html.slice(0, atEnd) + RV_TEST_JS + html.slice(atEnd);
  fs.writeFileSync(HARNESS, html, 'utf8');

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const f = path.join(UI_DIR, rel);
      if (!f.startsWith(UI_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      const ext = path.extname(f);
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/css';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      res.end(fs.readFileSync(f));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // ★ 必须带 ?rv=1 —— 这就是复盘窗口的那条入口
      const url = 'http://127.0.0.1:' + port + '/' + path.basename(HARNESS) + '?rv=1';
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-rv-'));
      const child = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--no-sandbox', '--user-data-dir=' + profile, '--window-size=1000,900',
        '--virtual-time-budget=12000', '--dump-dom', url,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let dom = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { dom += d; });
      const finish = (why) => {
        server.close();
        cleanupHarness();
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {}
        console.log('== B. 真实 Edge 加载 calc.html?rv=1（' + why + '）==');
        if (!dom.trim()) { console.log('  ✗ 浏览器无回传'); fail++; return resolve(); }
        const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
        if (!m) { console.log('  ✗ 页面无回传'); fail++; return resolve(); }
        for (const line of m[1].split('\n')) {
          const t = line.trim();
          if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
          else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
        }
        resolve();
      };
      const killer = setTimeout(() => { try { child.kill(); } catch (x) {} finish('超时'); }, 90000);
      child.on('exit', (code) => { clearTimeout(killer); finish('exit=' + code); });
    });
  });
}

// ============================================================ C. 真实 exe 端到端
const LOG = path.join(os.tmpdir(), 'GomokuTrainer.log');
const TMP_PNG = path.join(os.tmpdir(), 'gb-rv-save-' + process.pid + '.png');

function pidsOf(name) {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8' }).stdout || '';
    const a = [];
    for (const line of out.split(/\r?\n/)) {
      const mm = line.match(new RegExp('^"' + name.replace('.', '\\.') + '","(\\d+)"', 'i'));
      if (mm) a.push(Number(mm[1]));
    }
    return a;
  } catch (e) { return []; }
}
function killExe() { spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); }
/** 谁在监听这个端口（没有则 0）。用来区分「本次起的引擎」与「起跑前就在的引擎」。 */
function portPid(port) {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
    const re = new RegExp(':' + port + '(?!\\d)');
    for (const line of out.split(/\r?\n/)) {
      if (!re.test(line) || !/LISTENING/i.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) return Number(pid);
    }
  } catch (e) {}
  return 0;
}
/** 枚举可见顶层窗口（用项目自带的 python 运行时，不依赖 PATH）。 */
function listWindows(filter) {
  if (!fs.existsSync(PY)) return '';
  try {
    return spawnSync(PY, [LISTWIN, filter], { encoding: 'utf8' }).stdout || '';
  } catch (e) { return ''; }
}
function tailLog(from) {
  try {
    const buf = fs.readFileSync(LOG);
    return buf.slice(from).toString('utf8');
  } catch (e) { return ''; }
}

async function runEndToEnd() {
  console.log('== C. 真实 exe 端到端（开复盘窗 + 投递局面 + 保存局面走系统另存为）==');
  if (!fs.existsSync(EXE)) { ok('找到 Desktop GomokuTrainer.exe', false, EXE); return; }
  ok('找到 Desktop GomokuTrainer.exe', true, path.relative(ROOT, EXE));

  killExe();
  await sleep(600);
  ok('起跑前没有残留实例（单实例互斥体会拒绝第二次启动）', pidsOf('Desktop GomokuTrainer.exe').length === 0);

  let from = 0;
  try { from = fs.statSync(LOG).size; } catch (e) { from = 0; }
  try { fs.unlinkSync(TMP_PNG); } catch (e) {}
  // 起跑前 :8964 上有引擎吗？训练器启动时会「已有人服务就复用，否则自己起一个」——
  // 收尾只能回收**本次新起**的那个，绝不能碰起跑前就存在的用户实例。
  const engineBefore = portPid(8964);

  const child = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, {
      GB_TEST_OPEN_REVIEW: '1',        // 让页面自己走「点复盘 → 开窗 → 投递」
      GB_TEST_SAVE_POS: '1',           // 让页面调一次 savePos()
      GB_TEST_SAVE_PNG: TMP_PNG,       // 「另存为」不弹框，直接写这个路径
    }),
  });
  child.unref();

  // WebView2 首帧偶发 LAUNCH_FAILED → 宿主自愈重启（~23s），页面 ~15s 才 boot；
  // 所以**不许死等固定秒数**，轮询到判据行出现为止（上限 75s）。
  let log = '', ack = null, created = false, navved = false, saved = null;
  for (let i = 0; i < 150; i++) {
    await sleep(500);
    log = tailLog(from);
    created = created || /\[rv\] review window created \(independent top-level window\)/.test(log);
    navved = navved || /\[rv\] navigated to calc\.html\?rv=1/.test(log);
    const am = log.match(/\[rv\] ack moves=(\d+)/);
    if (am) ack = +am[1];
    const sm = log.match(/\[save\] png written: ([^\r\n(]+)\((\d+) bytes\)/);
    if (sm) saved = { path: sm[1].trim(), bytes: +sm[2] };
    if (ack != null && saved) break;
  }

  ok('宿主页面侧钩子生效（要求页面去开复盘窗）',
    /\[rv\] test hook: asked the page to open a review window/.test(log));
  ok('宿主页面侧钩子生效（要求页面去保存局面）',
    /\[save\] test hook: asked the page to save the position/.test(log));
  ok('★ 复盘窗是**独立顶层窗口**（不是主窗口里换棋盘）',
    created, created ? '' : '(日志里没有 [rv] review window created)');
  ok('★ 复盘窗导航到 calc.html?rv=1（RV_MODE 那条入口）',
    navved, navved ? '' : '(日志里没有 navigated to calc.html?rv=1)');
  // ★ 2026-09-19（用户反馈「打开复盘会黑一会、有点慢」）—— 两条都要验到：
  //   ① 窗口建好**先藏着**，等页面报到才 ShowWindow（→ 一露面就是画好的盘面，不闪黑/白）；
  //   ② 页面把底色报上来 → 宿主设 WebView2 的 DefaultBackgroundColor。
  // ★ 2026-09-19（用户再强调「一定要先弹出界面」）：点了复盘**立刻** ShowWindow ——
  //   shown 必须发生在 openReview（asked the page to open）之后，且不许晚于页面报到太多；
  //   遮罩（Gomoku Review）承接加载，页面报到后控制器才放正片（RevealRvPage）。
  const iCreated = log.indexOf('[rv] review window created');
  const iHidden = log.indexOf('[rv] window kept hidden until the page reports ready');
  const iReady = log.indexOf('[rv] review page ready');
  const iShown = log.indexOf('[rv] review window shown');
  const iOpen = log.indexOf('[rv] test hook (delayed): asked the page to open a review window');
  const ordered = iCreated >= 0 && iHidden > iCreated && iShown > iOpen && iReady > iHidden;
  ok('★ 点复盘立刻弹窗（shown 紧跟 openReview，不等页面；页面报到后才放正片）', ordered,
    ordered ? '' : 'created@' + iCreated + ' hidden@' + iHidden + ' ready@' + iReady + ' shown@' + iShown + ' open@' + iOpen);
  const bgLine = (log.match(/\[rv\] default background = #[0-9a-fA-F]{6}/) || [])[0] || '';
  ok('★ 复盘窗的 WebView2 默认底色 = 页面底色（画出来之前那一瞬不闪黑/白）',
    !!bgLine, bgLine || '(日志里没有 [rv] default background)');
  ok('★ 复盘窗报到 → 宿主把局面投过去 → 复盘窗回执（reviewAck）',
    ack != null && ack === 9, ack == null ? '(没收到 [rv] ack)' : 'moves=' + ack);

  // 真的多了一个 class=GbCalcReview 的可见顶层窗口
  let winLine = '';
  for (let i = 0; i < 20 && !winLine; i++) {
    const out = listWindows('GbCalcReview');
    winLine = out.split(/\r?\n/).filter((l) => l.indexOf('GbCalcReview') >= 0)[0] || '';
    if (!winLine) await sleep(300);
  }
  ok('★ 屏幕上真的多出一个 GbCalcReview 顶层窗口',
    /GbCalcReview/.test(winLine), winLine ? winLine.replace(/\s+/g, ' ').slice(0, 110) : '(枚举不到)');
  const mainWin = listWindows('GbCalcHost').split(/\r?\n/).filter((l) => l.indexOf('GbCalcHost') >= 0)[0] || '';
  ok('★ 主窗口还在（开复盘没有把主窗口换掉/关掉）',
    /GbCalcHost/.test(mainWin), mainWin ? 'ok' : '(主窗口不见了)');

  // 「保存局面」：真落盘成 PNG
  ok('★ 「保存局面」真写入 PNG（走系统另存为那条链路）',
    !!saved, saved ? saved.bytes + ' bytes' : '(日志里没有 [save] png written)');
  if (saved) {
    let head = null;
    try { head = fs.readFileSync(TMP_PNG).slice(0, 8); } catch (e) {}
    const isPng = head && head[0] === 0x89 && head.slice(1, 4).toString('latin1') === 'PNG';
    ok('★ 落盘的文件确实是 PNG（魔数 89 50 4E 47）且非空',
      isPng && fs.statSync(TMP_PNG).size > 200,
      isPng ? fs.statSync(TMP_PNG).size + ' bytes' : String(head));
  }

  try { child.kill(); } catch (e) {}
  killExe();
  await sleep(400);
  ok('收尾：实例已清干净', pidsOf('Desktop GomokuTrainer.exe').length === 0);
  // 引擎：只在「起跑前 :8964 是空的、跑完却有了」时才认定是本次起的，回收掉。
  // （_runall 的 LIVE 套件都要求 :8964 空闲，所以这条保持干净是硬要求。）
  const engineAfter = portPid(8964);
  if (!engineBefore && engineAfter) {
    try { spawnSync('taskkill', ['/PID', String(engineAfter), '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(500);
  }
  ok('收尾：本次新起的引擎已回收（起跑前 :8964 ' +
     (engineBefore ? '已有 pid=' + engineBefore + '，不碰它' : '空闲') + '）',
    !(!engineBefore && portPid(8964)),
    engineBefore ? '' : (portPid(8964) ? '仍然占着 ' + portPid(8964) : '已空闲'));
  try { fs.unlinkSync(TMP_PNG); } catch (e) {}
}

// ============================================================ D. 预热 + 延迟打开（用户的真实路径）
// 用户反馈「打开复盘这个窗口的时间有点太长了」→ 主窗口页面就绪 2.5s 后，宿主会在后台把复盘窗
// **藏好**建出来（WebView2 先启好、页面也加载完）；用户点「复盘」时只剩「投数据 + 显示」= 秒开。
// 这一段就是按**用户的真实时序**跑：先预热（不下钩子），过 6s 才触发「点复盘」。
//
// 三段判据：
//   ① 预热确实发生了（prewarming + prewarmed and hidden 两行），而且**此刻窗口不可见**
//      （枚举不到 GbCalcReview）—— 藏着的窗口不许漏到屏幕上/任务栏；
//   ② 延迟触发后窗口真的显示出来（review window shown）并收到回执（ack moves=9）；
//   ③ 顺序正确：prewarmed and hidden **早于** review window shown
//      （也就是说显示这件事是被「用户点了复盘」触发的，而不是预热时就把它亮出来了）。
async function runPrewarm() {
  console.log('== D. 复盘窗预热 + 延迟打开（先藏好，6s 后才「点复盘」）==');
  if (!fs.existsSync(EXE)) { ok('找到 Desktop GomokuTrainer.exe', false, EXE); return; }
  killExe();
  await sleep(600);

  let from = 0;
  try { from = fs.statSync(LOG).size; } catch (e) { from = 0; }
  const engineBefore = portPid(8964);
  const child = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, {
      GB_TEST_OPEN_REVIEW: '1',
      GB_TEST_OPEN_REVIEW_DELAY_MS: '6000',    // 预热(2.5s)早已完成，6s 才「点复盘」
    }),
  });
  child.unref();

  // ---- ① 等预热完成，并趁「还没显示」的时候枚举一次屏幕 ----
  let log = '', warmed = false;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    log = tailLog(from);
    if (/\[rv\] prewarmed and hidden \(page ready, waiting for the user\)/.test(log)) { warmed = true; break; }
  }
  ok('★ 主窗口页面就绪后会自动**预热**复盘窗（藏着建好，WebView2 先启动）',
    /\[rv\] prewarming the review window \(hidden, so the first open is instant\)/.test(log));
  ok('★ 预热的复盘窗页面也报到就绪（ready），只是**不显形**', warmed,
    warmed ? '' : '(没等到 [rv] prewarmed and hidden)');
  const notShownYet = !/\[rv\] review window shown/.test(log);
  const leaks = listWindows('GbCalcReview').split(/\r?\n/).filter((l) => l.indexOf('GbCalcReview') >= 0);
  ok('★ 预热期间屏幕上看不到 GbCalcReview（藏着的，不是开着的）',
    leaks.length === 0 && notShownYet,
    (leaks.length ? leaks[0].replace(/\s+/g, ' ').slice(0, 100) : '枚举不到 ✓') +
    (notShownYet ? '' : ' · 但日志里已经有 review window shown'));
  const iWarm = log.indexOf('[rv] prewarmed and hidden');

  // ---- ② 等延迟触发后的显示 + 回执 ----
  let shown = /\[rv\] review window shown/.test(log), ack = null;
  for (let i = 0; i < 60; i++) {
    if (shown) break;
    await sleep(500);
    log = tailLog(from);
    shown = /\[rv\] review window shown/.test(log);
  }
  for (let i = 0; i < 40; i++) {
    const am = log.match(/\[rv\] ack moves=(\d+)/);
    if (am) { ack = +am[1]; break; }
    await sleep(500);
    log = tailLog(from);
  }
  ok('★ 延迟「点复盘」后窗口真的显示出来（review window shown）', shown,
    shown ? '' : '(没等到 [rv] review window shown)');
  ok('★ 复用的是预热好的那个窗口（不是又新建一个）',
    (log.match(/\[rv\] review window created/g) || []).length === 1,
    'created 出现 ' + (log.match(/\[rv\] review window created/g) || []).length + ' 次');
  ok('★ 预热好的窗口照样把局面投进去并回执（ack moves=9）', ack === 9,
    ack == null ? '(没收到 [rv] ack)' : 'moves=' + ack);
  const iShown = log.indexOf('[rv] review window shown');
  ok('★ 顺序正确：先预热藏好（prewarmed and hidden）→ 用户点复盘后才 shown',
    iWarm >= 0 && iShown > iWarm, 'warm@' + iWarm + ' shown@' + iShown);

  // ---- ③ 延迟显示后，窗口在屏幕上（且主窗口还在）----
  let winLine = '';
  for (let i = 0; i < 20 && !winLine; i++) {
    const out = listWindows('GbCalcReview');
    winLine = out.split(/\r?\n/).filter((l) => l.indexOf('GbCalcReview') >= 0)[0] || '';
    if (!winLine) await sleep(300);
  }
  ok('★ 这时才真的冒出 GbCalcReview 顶层窗口',
    /GbCalcReview/.test(winLine), winLine ? winLine.replace(/\s+/g, ' ').slice(0, 110) : '(枚举不到)');
  const mainWin = listWindows('GbCalcHost').split(/\r?\n/).filter((l) => l.indexOf('GbCalcHost') >= 0)[0] || '';
  ok('★ 预热 / 延迟显示全程不影响主窗口', /GbCalcHost/.test(mainWin), mainWin ? 'ok' : '(主窗口不见了)');

  try { child.kill(); } catch (e) {}
  killExe();
  await sleep(400);
  ok('收尾（D 段）：实例已清干净', pidsOf('Desktop GomokuTrainer.exe').length === 0);
  const engineAfter = portPid(8964);
  if (!engineBefore && engineAfter) {
    try { spawnSync('taskkill', ['/PID', String(engineAfter), '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(500);
  }
  ok('收尾（D 段）：本次新起的引擎已回收（起跑前 :8964 ' +
     (engineBefore ? '已有 pid=' + engineBefore + '，不碰它' : '空闲') + '）',
    !(!engineBefore && portPid(8964)),
    engineBefore ? '' : (portPid(8964) ? '仍然占着 ' + portPid(8964) : '已空闲'));
}

(async function main() {
  await runBrowser();
  await runEndToEnd();
  await runPrewarm();
  console.log('\n== test-trainer-review: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
})();
