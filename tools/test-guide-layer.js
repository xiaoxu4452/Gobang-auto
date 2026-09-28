// test-guide-layer.js — 覆盖层「指导层 / 直角面板 / 不落子」源码契约护栏
//
// 背景（用户方案 2026-09-16）：
//   「桌面端的弹窗做成直角的，并且取消自动落子这个功能键，只在屏幕上用蓝色圆圈，
//     或者说用户点击热力图后显示热力图，在用户的电脑上应该得映射出来，
//     就只是起到了指导用户去落子的作用，不参与自动落子」
//
// 这五条需求**全部是屏幕上看得到的东西**，而本项目的开发环境看不到屏幕。所以用源码契约
// 把它们钉死：谁哪天又把落子键加回来、把蓝圈/热力块删掉、把面板改回圆角，这里立刻红，
// 而不是等用户在现场发现。
//
// ★ 一个必须注意的坑：本文件里到处是「没有 /api/click 通道」这类**否定断言**，
//   而被检查的源码里恰好有一段解释性注释写着同样几个字（"没有 /api/click 通道"）。
//   直接在原文上 indexOf 会自我命中、永远失败。所以先把**整行注释**剥掉再断言：
//   只看真正的代码，不看注释怎么说。
//
// 与 test-desktop-controls.js 的分工：
//   · 那个用真实 Edge 无头跑面板 DOM（验证「面板里真的没有落子键」「控件接线没坏」）；
//   · 这个读 C++ / JS 源码（验证「宿主真的会画蓝圈与热力块」「宿主真的不会点鼠标」）。
// 两者互补：一个管页面，一个管宿主。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rd = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
/** 剥掉注释，只留代码。只处理「整行 //」与「/* … *\/」两种 —— 足够用，
 *  且不会误伤字符串里的 `//`（如 'http://127.0.0.1:8964/api/analyze'）。 */
const stripComments = (s) => s.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const HOST = rd('desktop-overlay', 'src', 'host.cpp');
const BRIDGE = rd('desktop-overlay', 'ui', 'bridge.js');
const PANEL = rd('desktop-overlay', 'ui', 'panel.html');
// 提取产物（不是书签版源码）：桌面版独有的控件样式就补在这个文件里，
// 所以「局面键的深浅色」这类断言必须读它，读 bookmarklet.js 永远看不到。
const PANEL_UI = rd('desktop-overlay', 'ui', 'panel-ui.js');
const EXTRACT = rd('tools', 'extract-panel-ui.js');
// 截图/分带统计算法：它的比例常量是「渲染测试断言是否可信」的前提，所以也要盯。
const SHOT = rd('tools', '_screen_shot.py');
const SYNC = rd('tools', 'sync-overlay.js');
const HOST_CODE = stripComments(HOST);
const BRIDGE_CODE = stripComments(BRIDGE);

// ---------------------------------------------------------------- POS_* 宏求值器
// 把 host.cpp 里 `#define POS_* …` 的算式**真的算一遍**（只含数字与算术符号，安全）。
// 两处要用，所以放在外面共用：
//   ① 版式自洽性（⑫③e）：「算式改一个数、另一个数忘了跟」肉眼看注释看不出来 ——
//      本项目差点上线过「上内衬被压到 4、最上面那个 15 露到圆角卡片外」的版本；
//   ② 截图工具（tools/_screen_shot.py）的分带比例：它必须等于 host.cpp 算出来的窗口高，
//      版式再改一次而忘了同步它，「棋盘带」就会把代码卡片/按钮行圈进去、所有像素断言失真。
const POS_DEFS = {};
{
  const re = /^#define[ \t]+(POS_[A-Z0-9_]+)[ \t]+(.*)$/gm;
  let m;
  while ((m = re.exec(HOST))) {
    let body = m[2];
    const ci = body.lastIndexOf('//');
    if (ci >= 0) body = body.slice(0, ci);
    POS_DEFS[m[1]] = body.trim();
  }
}
const evalPosDef = (name, depth) => {
  if ((depth || 0) > 12) throw new Error('macro too deep: ' + name);
  const src = POS_DEFS[name];
  if (src === undefined) throw new Error('no macro ' + name);
  const sub = src.replace(/[A-Z][A-Z0-9_]*/g, (n) => '(' + evalPosDef(n, (depth || 0) + 1) + ')');
  if (!/^[-+*/(). \d]+$/.test(sub)) throw new Error('bad expr: ' + name + ' = ' + src);
  return new Function('return (' + sub + ')')();      // 只含数字与算术符号，安全
};
/** 求一个 POS_* 宏的数值；拿不到就返回 NaN（断言里自然会红）。 */
const POSN = (name) => { try { return evalPosDef(name, 0); } catch (e) { return NaN; } };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' | ' + extra)); }
}
const at = (s, n) => s.indexOf(n);

// ---------------------------------------------------------------- ① 直角弹窗
console.log('== ① 桌面弹窗做成直角（去圆角）==');
ok('host.cpp 的面板圆角常量是 0', /#define PANEL_RADIUS_CSS 0\b/.test(HOST));
ok('半径 ≤2 时走矩形 region（CreateRectRgn）',
  /static HRGN MakePanelRegion\([\s\S]{0,240}?CreateRectRgn/.test(HOST));
// 数 CreateRoundRectRgn 时要把「局面」小窗那处排除 —— 它是有意做成现代圆角卡片的
// （用户需求 2026-09-17：「展示局面的小棋盘这个弹窗的界面有点太老了，运用现代的布局方式」），
// 与「面板本体必须直角」并不冲突。
// ⚠ 必须定位**函数定义**（`() {`）而不是前置声明（`();`）：这几个函数在文件上方紧凑地
//   连续声明了三行，indexOf('static void OpenPositionWindow()') 会命中第一行前置声明，
//   切出来的「函数体」只有 30 来个字符 —— 于是 posRound 恒为 0，断言看起来绿其实是假的。
const posStart = HOST_CODE.indexOf('static void OpenPositionWindow() {');
const posBody = posStart >= 0
  ? HOST_CODE.slice(posStart, HOST_CODE.indexOf('static void ClosePositionWindow() {', posStart))
  : '';
const posRound = (posBody.match(/CreateRoundRectRgn/g) || []).length;
const roundCalls = (HOST_CODE.match(/CreateRoundRectRgn/g) || []).length - posRound;
ok('除 MakePanelRegion 内部外，代码里不再直接用 CreateRoundRectRgn（否则窗口有一处还是圆角）',
  roundCalls <= 1, roundCalls + ' 处（总 ' + (roundCalls + posRound) + '，其中局面小窗 ' + posRound + '）');
// ★ 2026-09-17 改口径：局面窗不再用窗口 region 做圆角。
//   原因见 host.cpp PaintPosition 的说明 —— 这个窗现在整块走 UpdateLayeredWindow 逐像素合成，
//   而 SetWindowRgn 是**硬边裁剪**，会把圆角的 alpha 过渡切掉、还会把窗口四角变成不透明。
//   圆角改由 GDI+ 路径抗锯齿绘制，四角保持真透明。
ok('「局面」小窗不再用 SetWindowRgn / CreateRoundRectRgn 做圆角（region 是硬边，会切掉 alpha 过渡）',
  posRound === 0 && !/SetWindowRgn/.test(posBody), 'posRound=' + posRound);
ok('「局面」小窗的圆角由 GDI+ 路径绘制（半径取 PXF(POS_RADIUS)，不是写死的数字）',
  /PosRoundPath\(winPath[\s\S]{0,200}?PXF\(POS_RADIUS\)/.test(HOST));
const rgnCalls = (HOST_CODE.match(/MakePanelRegion\(/g) || []).length;
ok('两处窗口 region 都改走 MakePanelRegion（定义 1 + 调用 2）', rgnCalls >= 3, rgnCalls + ' 处');

const styleM = /id="__gb_panel" style="([^"]*)"/.exec(PANEL);
const style = styleM ? styleM[1] : '';
ok('panel.html 里能抓到 #__gb_panel 的内联样式', !!style);
// 书签版容器自带 border-radius:10px；桌面版必须用后置声明覆盖成 0，
// 否则「窗口是方的、面板自己还画着圆角」——四角各露一块桌面，非常显眼。
ok('#__gb_panel 的 border-radius 最终为 0（后置声明覆盖书签版的 10px）',
  /border-radius:0;\s*$/.test(style), JSON.stringify(style.slice(-48)));
ok('抽取器里确实加了这条覆盖（而不是手改产物）',
  at(EXTRACT, "desktopCss += 'border-radius:0;'") >= 0);
ok('桌面版只做覆盖，不去动从书签版机械抽来的那段 CSS',
  at(EXTRACT, 'stripBoxOffsets') >= 0 && at(EXTRACT, 'containerCss') >= 0);
ok('sync-overlay.js 也拦一道（防旧模板/旧包被同步进发布目录）',
  at(SYNC, '不是直角') >= 0);

// ---------------------------------------------------------------- ② 屏幕指导层
console.log('== ② 屏幕指导层：蓝圈 + 热力色块 ==');
ok('host.cpp 定义了 DrawGuideCircle（推荐落点蓝圈）', at(HOST, 'static void DrawGuideCircle') >= 0);
ok('host.cpp 定义了 DrawHeatCells（热力图色块）', at(HOST, 'static void DrawHeatCells') >= 0);

const pi = at(HOST, 'static void PaintOverlay()');
ok('找得到 PaintOverlay', pi >= 0);
const paint = pi < 0 ? '' : HOST.slice(pi, pi + 6000);
ok('PaintOverlay 真的画了热力色块', at(paint, 'DrawHeatCells(g)') >= 0);
ok('PaintOverlay 真的画了指导蓝圈', at(paint, 'DrawGuideCircle(g,') >= 0);
ok('先热力色块、后蓝圈（圈必须压在色块上面才看得见）',
  at(paint, 'DrawHeatCells(g)') >= 0 && at(paint, 'DrawHeatCells(g)') < at(paint, 'DrawGuideCircle(g,'));
// ★ 测试底色 GB_TEST_BACKDROP 必须**盖在所有图元之上**（这条是踩过坑后补的护栏）。
//   两个像素级测试把它当「已知背景」用（tools/test-overlay-alpha.js 反推面板 alpha、
//   tools/test-overlay-pos-render.js 给 25% 档一个可断言的底），而 _screen_shot.py 的
//   locate_window 判据正是「不是底色的像素 = 局面小窗自己画的」。
//   原先底色在绘制**之前**填 → 屏幕角框 / 棋盘 L 虚线框 / 星位十字仍然压在底色上，
//   其中屏幕左上角那条虚线框比小窗还靠上，直接把定位带到 y=1：截图整体裁偏 79px，
//   标题栏带读出来是底色、网格带错位、行数只数到 2 —— 一堆断言看着像渲染坏了，
//   真实原因却是取样框偏了。填充放最后，「已知背景」这个前提才成立。
ok('★ 测试底色填在绘制之后（否则角框留在底色上，会骗偏局面小窗的定位）',
  at(paint, 'DrawHeatCells(g)') >= 0 &&
  at(paint, 'DrawHeatCells(g)') < at(paint, 'px[i] = backdrop;') &&
  at(paint, 'px[i] = backdrop;') < at(paint, 'UpdateLayeredWindow(g_overlay,'));
ok('蓝圈用面板同一个强调色 #3b7dd8（59,125,216）',
  /static void DrawGuideCircle[\s\S]{0,700}?59, 125, 216/.test(HOST));
ok('蓝圈半径有上下限（不会大到糊满棋盘 / 小到看不见）',
  /static void DrawGuideCircle[\s\S]{0,240}?r < 6\.0f[\s\S]{0,160}?r > 60\.0f/.test(HOST));
ok('热力色块按名次分四档配色（青最佳→绿良好→粉红一般→浅粉劣势）',
  /static void DrawHeatCells[\s\S]{0,3000}?switch \(tier\)/.test(HOST) &&
  /cr = 0;[\s\S]{0,200}?cg = 191; cb = 165; a = 170/.test(HOST) &&
  /cr = 255; cg = 179; cb = 193; a = 95/.test(HOST));
ok('热力档位有上下钳位（1..4，防面板送来越界档位烧坏色块）',
  /int tier = c\.tier < 1 \? 1 : \(c\.tier > 4 \? 4 : c\.tier\);/.test(HOST));
// 「L 形棋盘定位角边框稍微粗一点」（2.5 → 3.4）；2026-09-18 再改：腿长 = 一个格子（棋盘 1/15），
// 腿长超过 50px 时描边再提到 4.0。
// 颜色演进：白紫 232,214,255（2026-09-18）→ 深蓝紫 #6633E6 = 102,51,230
// （2026-09-19 用户原话「浅紫色改成深蓝紫色」；源码注释里有完整演进记录）。
// 虚线连接线（1.4f）与外扩量 e 都不动，所以这里一并把两个"不该动"的也钉住。
ok('棋盘 L 形角框腿长 = 一个格子（棋盘的 1/15，2026-09-18 用户要求）',
  /float barm = \(\(bw < bh \? bw : bh\) \+ 0\.5f\) \/ 15\.0f;/.test(HOST));
ok('棋盘 L 形角框颜色是深蓝紫 #6633E6（102,51,230；白紫 232,214,255 已弃）',
  /#define COL_BOARD_R 102/.test(HOST) && /#define COL_BOARD_G 51/.test(HOST) &&
  /#define COL_BOARD_B 230/.test(HOST));
ok('棋盘 L 形角框调用处走动态描边（3.4 起步，腿长 >50px 提到 4.0）',
  /COL_BOARD_B, barm, bth\)/.test(HOST));
ok('L 臂加粗没有顺手把虚线连接线也改掉（仍为 1.4f）',
  /Gdiplus::Pen pen\(Gdiplus::Color\(205, cr, cg, cb\), 1\.4f\)/.test(HOST));
ok('棋盘框外扩量仍是 6px（外扩变大反而显得没对齐网格）',
  /float e = 6\.0f;/.test(HOST));
const prevCall = /drawLBracket\(r\.x0 - e,[\s\S]{0,300}?\[5, 7\]\)/.exec(BRIDGE);
ok('浏览器预览模式的棋盘框线宽与宿主一致（3.4，不能一个粗一个细）',
  !!prevCall && /, 3\.4, \[5, 7\]\)/.test(prevCall[0]),
  prevCall ? prevCall[0].replace(/\s+/g, ' ').slice(0, 110) : '没找到预览模式的棋盘框调用');
// 实战踩过：结构体定义放在了解析函数后面 → C2061「未声明的标识符 HeatCell」。
// 这条断言把位置关系钉死，免得日后挪动「全局状态」时又踩一次。
ok('struct HeatCell 定义在 ParseHeatCells 之前（否则编译不过 C2061）',
  at(HOST, 'struct HeatCell {') >= 0 &&
  at(HOST, 'struct HeatCell {') < at(HOST, 'static int ParseHeatCells'));

// ---------------------------------------------------------------- ③ 面板 → 宿主 协议
console.log('== ③ 面板 → 宿主 的消息协议 ==');
// C++ 源码里的字面量是  L"\"type\":\"guide\""  →  逐段拼出来，避免在 JS 里数错转义
const Q = '"', B = '\\';
const cxxGuide = Q + B + Q + 'type' + B + Q + ':' + B + Q + 'guide' + B + Q + Q;
const cxxHeat = Q + B + Q + 'type' + B + Q + ':' + B + Q + 'heat' + B + Q + Q;
ok('宿主认得 "type":"guide" 消息', HOST.indexOf(cxxGuide) >= 0);
ok('宿主认得 "type":"heat" 消息', HOST.indexOf(cxxHeat) >= 0);
ok('指导层开关变化会让覆盖层重绘（WM_APP+2）',
  /g_guideOn\.exchange\(on\)[\s\S]{0,140}?WM_APP \+ 2/.test(HOST));
ok('热力图收到就会让覆盖层重绘（WM_APP+2）',
  /g_heatN\.store\(n\)[\s\S]{0,400}?WM_APP \+ 2/.test(HOST));
ok('坐标用扫描服务的整屏物理像素换算（面板算好下发，宿主不自己算棋）',
  at(BRIDGE, 'function boardToScreen(') >= 0 &&
  at(BRIDGE, 'Math.round(xs[x])') >= 0 && at(BRIDGE, 'Math.round(ys[y])') >= 0);

// ---------------------------------------------------------------- ④ 绝不自动落子
console.log('== ④ 绝不自动落子（只指导）==');
ok('bridge.js 代码里没有 /api/click 点击通道', at(BRIDGE_CODE, '/api/click') < 0);
ok('bridge.js 代码里没有 CLICK_URL', at(BRIDGE_CODE, 'CLICK_URL') < 0);
ok('host.cpp 里没有任何合成鼠标输入的 API（SendInput / mouse_event / SetCursorPos）',
  !/SendInput|mouse_event|SetCursorPos|MOUSEEVENTF/.test(HOST_CODE));
ok('analyze 把推荐落点交给「屏幕蓝圈」，而不是去点击',
  at(BRIDGE_CODE, 'postGuide(true, best[0], best[1]);') >= 0);
ok('无候选 / 分析失败时会把蓝圈收掉（不留一个假落点）',
  (BRIDGE_CODE.match(/postGuide\(false\)/g) || []).length >= 3,
  (BRIDGE_CODE.match(/postGuide\(false\)/g) || []).length + ' 处');
ok('热力图是独立补充搜索（topN:8 + sub 通道），不干扰主分析（topN:1）',
  /refreshHeatOverlay[\s\S]{0,600}?topN: 8, rule: S\.rule, cid: 'desktop-heat', lane: 'sub'/.test(BRIDGE_CODE));
ok('热力图消息带 cells（逐格 x,y,v,label）与 gap（格距）',
  at(BRIDGE_CODE, "type: 'heat', on: true, gap:") >= 0 &&
  at(BRIDGE_CODE, "cells: parts.join(';')") >= 0);
ok('关掉热力图会通知宿主清空色块', at(BRIDGE_CODE, "type: 'heat', on: false") >= 0);
ok('空盘也会把蓝圈/色块收掉（不残留上一局的推荐）',
  /empty[\s\S]{0,600}?postGuide\(false\)/.test(BRIDGE_CODE));

// ---------------------------------------------------------------- ⑤ 面板里没有落子键
console.log('== ⑤ 面板里没有落子键（控件已彻底移除）==');
for (const gone of ['__gb_auto', '__gb_autocap', '__gb_clickn']) {
  ok('panel.html 里没有 ' + gone, at(PANEL, gone) < 0);
}
ok('panel.html 里没有落子按钮的 i18n 键（data-i18n="auto"）', at(PANEL, 'data-i18n="auto"') < 0);
ok('抽取器会拦下残留的落子控件（出厂自检）',
  at(EXTRACT, "for (const gone of ['__gb_auto', '__gb_autocap', '__gb_clickn'])") >= 0);
ok('bridge.js 代码里不再给落子键接线',
  at(BRIDGE_CODE, "on('__gb_auto'") < 0 && at(BRIDGE_CODE, "on('__gb_clickn'") < 0);
ok('bridge.js 代码里不再调用 applyAutoUI()', at(BRIDGE_CODE, 'applyAutoUI()') < 0);
ok('sync-overlay.js 也拦一道（防「改了源码忘重建」把旧面板发出去）',
  at(SYNC, '__gb_auto') >= 0 && at(SYNC, '不替用户落子') >= 0);

// ---------------------------------------------------------------- ⑥ 只调透明度（模糊已移除，需求⑤）
console.log('== ⑥ 桌面端只调透明度（模糊控件与玻璃层都已移除）==');
// 用户需求（2026-09-17）：「移除模糊度这个功能选项，只是单纯的调整透明度」。
// 所以契约反过来了：模糊滑块/数字框/文案键**都不允许存在**，透明度滑块必须留着。
//
// ★ 真透明的实现配方（2026-09-17 定案，三条缺一不可）：
//     ① 宿主面板窗口 WS_EX_LAYERED          —— 允许逐像素 alpha 参与 DWM 合成
//     ② 宿主面板窗口 WS_EX_NOREDIRECTIONBITMAP —— 关键：不分配 GDI 重定向位图，
//        DWM 直接合成 WebView2 的 DComp 视觉树；少了它 alpha 会被拍平 → 一片黑
//     ③ WebView2 DefaultBackgroundColor({A=0}) —— 网页没画到的地方交给 DWM
//   ⚠ 并且**绝不能**给面板调 SetLayeredWindowAttributes：它一旦被调用就强制整窗不透明，
//     透明像素随即变黑 —— 上一轮「加了 WS_EX_LAYERED 反而全黑」就是踩了这一条。
//
// ⚠ 匹配必须锚在**面板**那一次 CreateWindowExW 上：老写法 /WS_EX_TOPMOST \| WS_EX_LAYERED/
//   会被覆盖层窗口（WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT）误命中 ——
//   面板自己漏了条件它照样绿（假绿）。
const panelCreate = (HOST.match(/g_panel = CreateWindowExW\(([\s\S]{0,300}?)L"GbPanelHost"/) || [])[1] || '';
ok('面板窗口是分层窗口（WS_EX_LAYERED，逐像素 alpha 合成的前提）',
  /WS_EX_LAYERED/.test(panelCreate), JSON.stringify(panelCreate.slice(0, 120)));
ok('面板窗口带 WS_EX_NOREDIRECTIONBITMAP（缺它 DWM 拿不到 WebView2 的 alpha，仍是一片黑）',
  /WS_EX_NOREDIRECTIONBITMAP/.test(panelCreate));
ok('面板绝不调 SetLayeredWindowAttributes（一调整窗变不透明、透明像素压成黑色）',
  !/SetLayeredWindowAttributes\(\s*g_panel/.test(HOST));
ok('WebView2 背板设为全透明（面板背后透出真实桌面）',
  /put_DefaultBackgroundColor/.test(HOST));
ok('抽取器会把「模糊」整行摘掉并自检（防「改了源码忘重建」）',
  /__gb_blur_range/.test(EXTRACT) && /桌面版模糊控件未摘干净/.test(EXTRACT));
ok('抽取产物 panel.html 里没有任何模糊控件',
  at(PANEL, '__gb_blur_range') < 0 && at(PANEL, '__gb_blur_num') < 0);
ok('抽取产物 panel.html 里没有「模糊度」文案键（data-i18n="blur"）',
  at(PANEL, 'data-i18n="blur"') < 0);
ok('透明度滑块被保留（只摘模糊，不能连透明度一起摘掉）',
  at(PANEL, '__gb_opacity_range') >= 0 && at(PANEL, '__gb_opacity_num') >= 0 &&
  at(PANEL, 'data-i18n="opacity"') >= 0);

// ---------------------------------------------------------------- ⑥b 取消对手评估 + 四色图例跟上热力图
console.log('== ⑥b 取消「对手落点评估」；四色图例紧跟热力图按钮 ==');
// 用户要求（2026-09-17）：「取消对手评估这个功能」
//                    「热力图按键后面就是四种颜色的颜色展示标点」。
// ⚠ 只取消**桌面版**；书签版（engine-server/resources/bookmarklet.js）保留该功能 ——
//    test-opp-rings.js / test-live-fixes.js / test-live-semantics.js 测的都是书签版，必须继续绿。
ok('桌面面板里没有「对手落点评估」按钮', at(PANEL, '__gb_opp') < 0);
ok('桌面面板里没有对手落点的文案键（data-i18n="oppMoves"）', at(PANEL, 'oppMoves') < 0);
ok('bridge.js 里没有任何对手落点/对手圈逻辑（按钮删了、逻辑一并删）',
  !/oppMoves|refreshOppOverlay|oppBusy/.test(BRIDGE_CODE));
ok('抽取器里写死了「摘掉对手键 + 搬图例」两步，并各自自检',
  /__gb_opp 控件/.test(EXTRACT) && /四色图例没有紧跟/.test(EXTRACT));
ok('四色图例在面板里只有一份', (PANEL.match(/id="__gb_legend"/g) || []).length === 1);
ok('四色图例紧跟「热力图」按钮（同排右侧）',
  /id="__gb_heat"[\s\S]{0,400}?id="__gb_legend"/.test(PANEL));
ok('四色图例常显（不再靠点热力图才显形）', /id="__gb_legend"[^>]*display:flex/.test(PANEL));
{
  const lgM = /<div id="__gb_legend"[\s\S]*?<\/div>/.exec(PANEL);
  const lg = lgM ? lgM[0] : '';
  ok('四色图例就是四个色点，四个颜色一个不少（最佳/较优/一般/较弱）',
    ['#00bfa5', '#43a047', '#ff7f9f', '#ffb3c1'].every((c) => lg.indexOf(c) >= 0),
    lg.slice(0, 160));
}
ok('bridge.js 里 applyHeat 的显隐逻辑已删除（图例常显，不能再被设成 none）',
  !/applyHeat/.test(BRIDGE_CODE));

// ---------------------------------------------------------------- ⑥c 评估不抖动（严令）
console.log('== ⑥c 评估不得抖动：盘面必须连续稳定才重算 ==');
// 用户严令（2026-09-17）：「确保评估不要抖动，不要在黑子白子来回跳跃」。
// 单帧误读若立刻触发重算，行棋方（mine）会翻，评估符号就跟着跳。
// 契约：新盘面必须连续 STABLE_FRAMES 帧完全一致才被采纳；手动触发走 forceScan 旁路。
ok('bridge.js 有盘面稳定门（pendingKey / pendingN / STABLE_FRAMES）',
  /pendingKey/.test(BRIDGE_CODE) && /STABLE_FRAMES/.test(BRIDGE_CODE));
ok('新盘面连续一致才采纳，否则直接 return（不重算 → 行棋方不翻 → 符号不跳）',
  /if \(key !== pendingKey\) \{ pendingKey = key; pendingN = 1; return; \}[\s\S]{0,140}?if \(\+\+pendingN < STABLE_FRAMES\) return;/
    .test(BRIDGE_CODE));
ok('手动触发（重新识别/分析/深算/换规则/换我执）走 forceScan 旁路，不被稳定门拖慢',
  (BRIDGE_CODE.match(/forceScan = true/g) || []).length >= 4,
  (BRIDGE_CODE.match(/forceScan = true/g) || []).length + ' 处');

// ---------------------------------------------------------------- ⑧ 热力图跟随书签页的副任务处理
// 用户要求：「热力图跟随书签页的多任务（副任务）处理」。
// 书签版的 refreshOverlayCands 有一整套稳定手段（独立 sub 通道 / 半步时预算 / 候选<4 补搜 /
// 局面变了就丢弃 / 首候选对齐主分析），少一条现场就会看到"热力图只剩一两种颜色"。
// 这里逐条钉住，防止桌面版日后被"简化"回去。
console.log('== ⑧ 热力图跟随书签页的副任务(sub)处理 ==');
ok('热力图走 sub 副通道 + topN=8（与主线 topN=1 并行、不抢算力）',
  /topN: 8, rule: S\.rule, cid: 'desktop-heat', lane: 'sub'/.test(BRIDGE_CODE));
ok('预算由步时推出（半步时，夹在 1200..4000）',
  /Math\.max\(1200, Math\.min\(4000, Math\.round\(\(S\.turnMs \|\| 5000\) \* 0\.5\)\)\)/.test(BRIDGE_CODE));
ok('候选 <4 时在同一条 sub 通道补搜一次（更长预算）',
  /candidates\.length < 4[\s\S]{0,420}?refreshMs \+ 1500/.test(BRIDGE_CODE));
ok('补搜没变多就沿用原结果（绝不丢弃已有候选）',
  /res2\.candidates\.length > res\.candidates\.length\) res = res2;/.test(BRIDGE_CODE));
ok('期间局面已变 → 丢弃这批（盘面指纹守卫）', /fp !== lastBoardKey/.test(BRIDGE_CODE));
ok('首候选对齐主分析推荐（只做真实重排，不虚构候选）',
  /lastBest[\s\S]{0,260}?cands\.unshift\(cands\.splice\(i, 1\)\[0\]\)/.test(BRIDGE_CODE));
ok('与主分析同格时用深搜的评估/深度覆盖浅搜',
  /cands\[0\]\.eval = lastMainC0\.eval/.test(BRIDGE_CODE) &&
  /cands\[0\]\.depth = lastMainC0\.depth/.test(BRIDGE_CODE));
ok('结果写回 S.candCache（与书签版同一个状态字段）', /S\.candCache = cands;/.test(BRIDGE_CODE));
ok('空盘/离线时清掉主分析批次（不留上一局的推荐）',
  (BRIDGE_CODE.match(/lastBest = null; lastMainC0 = null;/g) || []).length >= 2,
  (BRIDGE_CODE.match(/lastBest = null; lastMainC0 = null;/g) || []).length + ' 处');

// ---------------------------------------------------------------- ⑨ 热力色块里填入评估数字
// 用户要求：「热力图图中填入评估数字，就和智子的热力评估差不多」。
console.log('== ⑨ 热力色块里填入评估数字 ==');
ok('格子格式 x,y,tier,label，用分号分隔（标签不会被逗号截断）',
  /parts\.push\(p\.x \+ ',' \+ p\.y \+ ',' \+ tiers\[ci\] \+ ',' \+ heatLabel\(ev\)\)/.test(BRIDGE_CODE) &&
  /cells: parts\.join\(';'\)/.test(BRIDGE_CODE));
ok('标签被滤成 ASCII 数字/字母/正负号（+645、+M45 都能过）',
  /replace\(\/\[\^0-9A-Za-z\+\\-\]\/g, ''\)/.test(BRIDGE_CODE));
ok('host 的 HeatCell 带 label 字段', /struct HeatCell \{ int x, y, tier; wchar_t label\[16\]; \}/.test(HOST));
ok('宿主解析第 4 个字段（label，可空）', /out\[n\]\.label\[ln\] = 0;/.test(HOST));
ok('宿主按分号切格子', /s\[i\] != L';'/.test(HOST));
ok('数字画在色块中心（居中 StringFormat）',
  /static void DrawHeatCells[\s\S]{0,1600}?StringAlignmentCenter/.test(HOST));
ok('数字是白字 + 深色描边（浅盘面/暗盘面都看得清）',
  /static void DrawHeatCells[\s\S]{0,2600}?halo[\s\S]{0,700}?DrawString/.test(HOST));
  var heatBody = (function () {                       // 只取 DrawHeatCells 函数体（粗体在别处是合法的）
    var at = HOST.indexOf('static void DrawHeatCells');
    return at < 0 ? '' : HOST.slice(at, at + 1800);
  })();
  ok('字号跟格距走且有上下限（2026-09-18 缩到 8..15px + 常规体：确保数字显示完整）',
    /fsz < 8\.0f[\s\S]{0,140}?fsz > 15\.0f/.test(heatBody) &&
    /FontStyleRegular, Gdiplus::UnitPixel/.test(heatBody) &&
    heatBody.indexOf('FontStyleBold, Gdiplus::UnitPixel') < 0);
ok('蓝圈/热力格带下发时锚点（棋盘窗口移动时按 delta 平移跟随）',
  /g_guideAnchor = g_hasBoard\.load\(\) \? g_boardRect : RECT\{ 0, 0, 0, 0 \};/.test(HOST) &&
  /g_heatAnchor = \(n > 0 && g_hasBoard\.load\(\)\) \? g_boardRect : RECT\{ 0, 0, 0, 0 \};/.test(HOST) &&
  /g_boardRect\.left - ha\.left/.test(HOST) && /g_boardRect\.left - ga\.left/.test(HOST));
ok('拿不到字体就只画色块（不让数字把整个指导层拖没）', /canText/.test(HOST));

// ---------------------------------------------------------------- ⑩ 星位标记：十字 + 虚线方框
// 用户要求（依次三条）：
//   ①「在棋盘的天元还有其他 4 个定位点添加小十字形，十字中心是细小的荧光蓝方格（十字是荧光橙色）」
//   ②「蓝色的小矩形变成虚线的小矩形，并且这个小矩形的尺寸是十字定位标的 1/3」
//   ③（2026-09-17 现场）「棋盘中5个识别点的蓝色虚线矩形，应该是细的，并且再大一倍多」
//      → 线更细 + 方框放大 ≈2.2 倍 + 十字同步放大（否则被方框吃掉）+ 虚线段长改按像素算
console.log('== ⑩ 星位标记：橙十字 + 中心虚线方框（细线 · 边长 ≈0.44 格）==');
{
  const si = at(HOST, 'static void DrawStarMarks');
  ok('找得到 DrawStarMarks', si >= 0);
  const body = si < 0 ? '' : HOST.slice(si, si + 3400);
  ok('★ 方框边长按格距直接给 0.44 格（旧值 ≈0.20 格 → 放大 ≈2.2 倍）',
    /float side = gap \* 0\.44f;/.test(body));
  ok('★ 方框线更细（光晕 2.4 / 本体 1.2；旧值 4.2 / 1.9）',
    /const float w = \(pass == 0\) \? 2\.4f : 1\.2f;/.test(body));
  ok('★ 虚线段长按**像素**算、再除以各自线宽（否则线一细虚线就碎成实线、两遍还不同相位）',
    /const float dashPx = side \* 0\.18f;/.test(body) &&
    /Gdiplus::REAL pat\[2\] = \{dashPx \/ w, gapPx \/ w\};/.test(body));
  ok('★ 十字与方框同步放大，并复核「仍在方框外露出一截」',
    /float arm = gap \* 0\.44f;/.test(body) &&
    /if \(arm < h \+ gap \* 0\.14f\) arm = h \+ gap \* 0\.14f;/.test(body));
  ok('★ 方框是**虚线**画的（SetDashPattern + DrawRectangle）',
    /SetDashPattern\(pat, 2\)/.test(body) && /DrawRectangle\(&pen, cx - h, cy - h, side, side\)/.test(body));
  ok('方框不再是实心填充（FillRectangle 已移除）', !/FillRectangle/.test(body));
  ok('虚线方框也分光晕/本体两遍（浅盘面深盘面都看得清）',
    (body.match(/SetDashPattern/g) || []).length >= 1 &&
    /for \(int pass = 0; pass < 2; \+\+pass\)/.test(body));
  ok('★ 十字是荧光蓝（47,216,255，2026-09-18 由橙黄改蓝）且四段从方框边缘起画',
    /255, 47, 216, 255/.test(body) && /DrawLine\(&pen, cx \+ h, cy, cx \+ arm, cy\)/.test(body));
  ok('★ 十字已加粗（光晕 6.5 / 本体 3.2；旧值 5.0 / 2.0）',
    /Gdiplus::Pen pen\(c, \(pass == 0\) \? 6\.5f : 3\.2f\)/.test(body));
  ok('星位索引按 15/13/19 路分别取（3/7/11、3/6/9、3/9/15）',
    /out\[0\] = 3; out\[1\] = 7; out\[2\] = 11;/.test(HOST) &&
    /out\[0\] = 3; out\[1\] = 6; out\[2\] = 9;/.test(HOST) &&
    /out\[0\] = 3; out\[1\] = 9; out\[2\] = 15;/.test(HOST));
}

// ---------------------------------------------------------------- ⑪ 两个"隐蔽失败"的护栏
console.log('== ⑪ 两个隐蔽失败的护栏 ==');
// ① WStrAfter 曾经从 key 的起点找结束引号 → 永远返回空串 → 热力图整条链路静默不出图。
ok('WStrAfter 从 key 之后开始找结束引号（否则永远返回空串）',
  /size_t s = p \+ wcslen\(key\);[\s\S]{0,220}?w\.find\(L'"', s\)/.test(HOST));
// ② 日志额度被 panelRect 吃干 → 后面真正有用的消息一条都不落盘，排查时完全瞎。
// C++ 源码里这一行字面量是：  if (w.find(L"\"panelRect\"") == std::wstring::npos && ++msgN <= 40)
// 在 JS 单引号串里就是 'w.find(L"\\"panelRect\\"") == std::wstring::npos'。
// 注意：**不能用模板串 / 反引号拼**，也不要做引号拼接 —— 直接写死字面量最不容易错。
ok('日志额度不被高频的 panelRect 占用（否则 guide/heat 消息进不了日志）',
  at(HOST, 'w.find(L"\\"panelRect\\"") == std::wstring::npos') >= 0);
// 顺带钉住额度数额：这条守卫必须与 msgN 上限写在同一行（若只留守卫、上限被搬到别处，
// 语义会漂移）。
ok('panelRect 跳过与 msgN<=40 额度写在一起',
  /w\.find\(L"\\"panelRect\\""\) == std::wstring::npos && \+\+msgN <= 40/.test(HOST));
// ③ 反过来也不能一条都不记：面板几何必须可观测（历史上「高度一路缩成一条线」就是靠它抓的），
//    test-overlay-smoke.js 的「面板高度已收敛」断言直接依赖这些行 —— 只留首帧一条会让它恒失败。
ok('panelRect 另有独立的限流几何日志（每 4 帧一条，上限 96 帧）',
  /rectN % 4 == 0 && rectN <= 96/.test(HOST));
ok('几何日志的前 5 个字段（w/h/hdrH/dpr/dragW）在截断长度内可见',
  /rectN % 4 == 0 && rectN <= 96[\s\S]{0,220}?substr\(0, 220\)/.test(HOST));
ok('smoke 测试的 parseGeometry 仍指向同一种日志（防两边漂移）',
  /"type":"panelRect","w":\(\\d\+\),"h":\(\\d\+\),"hdrH":\(\\d\+\),"dpr":\(\[\\d\.\]\+\),"dragW":\(\\d\+\)/.test(
    rd('tools', 'test-overlay-smoke.js')));
// ④ 命名空间隔离必须**连 WebView2 userData 一起**。只隔离互斥体是不够的：上一个实例的
//    msedgewebview2 子进程还没完全退出时，同一 userData 目录会让新实例 LAUNCH_FAILED ——
//    渲染进程起不来 → 页面不加载 → 面板不上报 → test-overlay-smoke 连跑偶发 13/18（单跑全绿）。
ok('测试命名空间（GB_INSTANCE_ID）时 WebView2 userData 也加后缀隔离',
  /wv = Join\(dir, std::wstring\(L"WebView2_"\) \+ iid\)/.test(HOST) &&
  /GetEnvironmentVariableW\(L"GB_INSTANCE_ID", iid/.test(HOST));
ok('默认（生产单实例）路径仍是不带后缀的 WebView2（保留登录态/缓存）',
  /std::wstring wv = Join\(dir, L"WebView2"\);/.test(HOST));

// ---------------------------------------------------------------- ⑫ 局面小窗：全自绘 + 逐像素透明
// 用户 2026-09-17 的三条反馈一次落地：
//   ①「这个局面的弹窗…而且没有出现棋盘，按键较为粗糙」—— 棋盘其实一直在画，
//      栽的是渲染路径（见 host.cpp PaintPosition 里那段对照实验结论）；
//   ②「按键要小一圈，按键字体大小和主程序的一致」；
//   ③「需要凭借训练好的书签端的 opencv 棋盘数据，适配到桌面（应该本来就是这样）」
//      —— 确认桌面局面窗与书签版共用同一份 /scan 识别结果。
console.log('== ⑫ 局面小窗：全自绘 + UpdateLayeredWindow 逐像素透明 ==');
{
  const posFn = /static void PaintPosition\(HWND h\) \{([\s\S]*?)\n\}/.exec(HOST_CODE);
  const pb = posFn ? posFn[1] : '';
  // ⚠ 命中/绘制分别在两个函数里：posBody 是「开窗」，posProcBody 才是「事件处理」。
  //   上一版把两处断言都挂在 posBody 上，必然假红 —— 这是本文件里最容易踩的一类错。
  const posProcStart = HOST_CODE.indexOf('static LRESULT CALLBACK PosProc(');
  const posProcBody = posProcStart >= 0
    ? HOST_CODE.slice(posProcStart, HOST_CODE.indexOf('static void OpenPositionWindow() {', posProcStart))
    : '';
  ok('找得到 PaintPosition 函数体', pb.length > 500, pb.length + ' 字符');
  ok('找得到 PosProc 函数体', posProcBody.length > 800, posProcBody.length + ' 字符');
  // ★ B2（2026-09-19）：「保存局面」要把**窗口里那张棋盘卡片**原样导出成 PNG，
  //   所以卡片绘制被抽成了独立函数 DrawPosBoardCard(g, dk)，窗口与导出的图片共用同一份
  //   绘制代码（不然导出的图和屏幕上一眼就是两套东西）。
  //   ⇒ 从此「棋盘 / 坐标标注 / 棋子」这些绘制断言必须挂在 DrawPosBoardCard 上；
  //     还挂在 PaintPosition 上会**集体假红**（那个函数体里已经没有坐标绘制了）。
  const posCardFn = /static void DrawPosBoardCard\(Gdiplus::Graphics& g, bool dk\) \{([\s\S]*?)\n\}/.exec(HOST_CODE);
  const pcb = posCardFn ? posCardFn[1] : '';
  ok('找得到 DrawPosBoardCard 函数体（棋盘卡片绘制已独立成函数）',
    pcb.length > 800, pcb.length + ' 字符');
  ok('★ PaintPosition 里确实调用了 DrawPosBoardCard（窗口与 PNG 导出共用同一份卡片绘制）',
    /DrawPosBoardCard\(g, dk\);/.test(pb));

  // ① 渲染路径
  ok('局面窗绘制里不再出现 SetLayeredWindowAttributes（它就是「没有棋盘」的根因）',
    !/SetLayeredWindowAttributes/.test(pb));
  ok('局面窗走 UpdateLayeredWindow(ULW_ALPHA) 逐像素合成（与主覆盖层同一条路径）',
    /UpdateLayeredWindow\(h, screen[\s\S]{0,160}?ULW_ALPHA\)/.test(pb));
  ok('局面窗的位图是 32bpp PARGB（GDI+ 直写；预乘 alpha 才能逐像素合成）',
    /PixelFormat32bppPARGB/.test(pb) && /biBitCount = 32/.test(pb));
  ok('整窗 alpha 由位图后处理统一缩放（r/g/b/a 四通道同比例 → 与 LWA_ALPHA 等价）',
    /\(sa \* A \+ 127u\) \/ 255u/.test(pb) &&
    /\(\(\(v >> 16\) & 0xFFu\) \* A \+ 127u\) \/ 255u/.test(pb));
  ok('全透明像素不参与缩放（圆角外沿保持真透明 → 鼠标在那儿点到的是桌面）',
    /if \(!sa\) continue;/.test(pb));

  // ② 不再有原生子控件
  ok('局面窗不再创建原生 EDIT 子控件', !/L"EDIT"/.test(posBody));
  ok('局面窗不再创建原生 BUTTON 子控件', !/L"BUTTON"/.test(posBody));
  ok('局面窗不再有 WM_DRAWITEM / WM_CTLCOLOREDIT 分支（没有子控件可自绘了）',
    !/WM_DRAWITEM|WM_CTLCOLOREDIT/.test(posBody));
  ok('按钮命中由 PosHitTest 自己算（矩形口径与绘制共用同一组 POS_BTN_* 常量）',
    /static int PosHitTest[\s\S]{0,600}?POS_BTN_X0[\s\S]{0,240}?POS_BTN_X1/.test(HOST_CODE) &&
    /int hit = PosHitTest\(h, c\);/.test(posProcBody));
  ok('四个命中目标（关闭 / 最小化 / 复制 / 保存）都能落地',
    /POSHIT_CLOSE\) \{ ClosePositionWindow\(\); return 0; \}/.test(posProcBody) &&
    /POSHIT_MIN\) \{ ShowWindow\(h, SW_MINIMIZE\); return 0; \}/.test(posProcBody) &&
    /POSHIT_COPY\) \{ PosCopyCode\(\); return 0; \}/.test(posProcBody) &&
    /POSHIT_SAVE\) \{ PosSaveCode\(\); return 0; \}/.test(posProcBody));

  // ③ 按钮「小一圈」+ 文案 + 字号
  ok('按钮高度 26 设计单位（原 32 → 小一圈）', /#define POS_BTN_H\s+26\b/.test(HOST));
  ok('按钮行左右各内缩 10 设计单位（整体比卡片窄一圈）', /#define POS_BTN_INSET 10\b/.test(HOST));
  ok('副按钮文案是「保存局面」（用户：保存这个按钮，写成保存局面）',
    /L"\\u4fdd\\u5b58\\u5c40\\u9762"/.test(pb) && /L"Save position"/.test(pb) &&
    !/\\u4fdd\\u5b58\\u2026/.test(pb));
  ok('按钮字号 PXF(13)（用户：这两个按键字体再大一点）',
    /Gdiplus::Font fBtn\(&ff, PXF\(13\)/.test(pb));

  // ③b 深浅色模式适配：取色全部由 g_uiDark 决定，浅/深两套都在
  ok('局面窗的配色分浅/深两套（底/卡片/线/网格/文字；卡片那套已随绘制搬进 DrawPosBoardCard）',
    [/cBg/, /cCard/, /cLine/, /cGrid/, /cText/, /cSub/].every((re) =>
      new RegExp('const Gdiplus::Color\\s+' + re.source + '\\s*=\\s*dk \\?').test(pb + pcb)));
  ok('局面窗的取色来自 g_uiDark（面板 uiLook 消息同步的那个字段）',
    /const bool dk = g_uiDark;/.test(pb) && /DrawPosBoardCard\(g, dk\);/.test(pb));
  ok('切换深浅色会重画局面窗（ReportUiLook → ApplyPosAlpha → PaintPosition）',
    /static void ReportUiLook\(\)[\s\S]{0,260}?ApplyPosAlpha\(\)/.test(HOST_CODE) &&
    /static void ApplyPosAlpha\(\)[\s\S]{0,900}?PaintPosition\(g_posWnd\);/.test(HOST_CODE));
  // ★ 2026-09-17 真凶：uiLook 消息里的 dark 是 **JSON 布尔**（{"dark":true}），
  //   而早先这里用 JsonNumberIn（内部是 strtod）去取它 —— strtod("true") 解析失败并返回
  //   false，于是 g_uiDark 永远停在 false：主面板切了夜间模式，局面小窗还是白的。
  //   日志里明明有 "dark":true、截图却依然是浅色卡片，就是这条断言要钉住的回归。
  ok('★ dark 用 JsonBoolIn 解析（它是布尔 true，不是数字 —— 用 JsonNumberIn 会永远解析失败）',
    /JsonBoolIn\(WideToUtf8\(w\), "dark", bd\)/.test(HOST) &&
    !/JsonNumberIn\(WideToUtf8\(w\), "dark"/.test(HOST));
  ok('测试钩子 GB_TEST_DARK 能把面板切进夜间模式（供渲染测试断言深浅适配）',
    /GB_TEST_DARK/.test(HOST) && /getAttribute\('data-dark'\)!=='1'/.test(HOST));
  // ③d 主面板的「局面」键也要适配深浅色（用户 2026-09-17：「主弹窗中『局面』
  //     这个按钮也得适配深浅色模式」）。
  //     ★ 2026-09-18 改法变了：以前是「抽取器往 applyDark 里补一行行内色」，
  //       而 bridge.js 的 posBtnOn() 又写了一份 —— 两处各写各的，其中 posBtnOn 判主题
  //       时读的是根本不存在的 `#__gb_root` → 恒判浅色 → 深色面板上按钮变浅绿
  //       （用户 2026-09-18 反馈 + 截图：「局面这个按键没有匹配深色主题」）。
  //       现在配色**只有一处**：FOOT_STYLE 里按 `[data-dark="1"]` / `[data-on="1"]` 给的
  //       CSS 规则；JS 只翻 data-on 标记，一个行内色都不写。
  ok('★ 「局面」键的深浅两套色只由样式表给（浅色/深色 × 开/关 四条规则都在）',
    /#__gb_pos\{background:#2e7d32!important/.test(PANEL) &&
    /\[data-dark="1"\] #__gb_pos\{background:#1e3a26!important;color:#9bd6a2!important/.test(PANEL) &&
    /#__gb_pos\[data-on="1"\]\{/.test(PANEL) &&
    /\[data-dark="1"\] #__gb_pos\[data-on="1"\]\{/.test(PANEL));
  ok('★ JS 不再给「局面」键写行内颜色（只有一个 data-on 标记，杜绝「JS 记错主题」）',
    /function posBtnOn\(on\)/.test(BRIDGE_CODE) &&
    /setAttribute\('data-on', '1'\)/.test(BRIDGE_CODE) &&
    !/pb\.style\.background/.test(PANEL_UI) &&
    !/pb\.style\.color/.test(PANEL_UI) &&
    // ★ 那次事故的直接病灶：用不存在的 #__gb_root 判主题（回退 body 后恒为浅色）
    !/__gb_root/.test(BRIDGE_CODE));
  ok('抽取器对「局面」键配色回退/深色规则缺失都会抛错（不会默默产出浅色面板）',
    /「局面」键的配色又回到了行内样式/.test(EXTRACT) &&
    /「局面」键的深色配色规则没进面板样式表/.test(EXTRACT) &&
    // 行内样式里不许再出现颜色（用 indexOf 而不是正则：里面全是 [] ^ | 之类的元字符）
    EXTRACT.indexOf('id="__gb_pos"[^>]*style="[^"]*(background|color)') >= 0);

  // ③e 棋盘坐标标注（用户 2026-09-17：「在棋盘的左右侧和下面写上坐标代码（细小的数字和
  //     字母），不要与棋盘堆叠，合理布局。左下角为坐标原点，纵轴 1~15，横轴 A~O」）
  ok('左右 / 下方各有独立的坐标栏常量（标注占地是棋盘之外的专属留白）',
    /#define POS_COORD_W\s+13\b/.test(HOST) && /#define POS_COORD_H\s+14\b/.test(HOST));
  ok('棋盘线原点把左右坐标栏让了出去（POS_OX = PAD + CARD_PX + COORD_W）',
    /#define POS_OX\s+\(POS_PAD \+ POS_CARD_PX \+ POS_COORD_W\)/.test(HOST));
  ok('棋盘卡片按自己的高绘制（上内衬 + 棋盘 + 下内衬，不能再当正方形）',
    /#define POS_CARD_H\s+\(POS_CARD_PT \+ POS_GRID \+ POS_CARD_PB\)/.test(HOST) &&
    /PosRoundPath\(cp, PXF\(POS_PAD\), PXF\(POS_BY\), PXF\(POS_CARD_W\), PXF\(POS_CARD_H\), PXF\(10\)\)/.test(pcb));
  // ★ B4（2026-09-19，用户）：「局面棋盘上的坐标字母和数字要距离棋盘稍微远一点，因为有的子
  //   落到棋盘边缘会没过数字和字母」。棋子直径 = POS_CELL - 4 ⇒ 半径 5.5，所以标注与棋盘线
  //   之间的缝**必须大于 5.5**，否则最边上那一路的子会盖住标注（现场就是「数字被黑子淹了」）。
  //   缝由 POS_COORD_GAP 一个常量统一给三处（左 / 右 / 下），不许再散落成 PXF(2)。
  ok('★ 坐标与棋盘线的缝 = POS_COORD_GAP，且 > 棋子半径（否则边缘的子会盖住标注）',
    /#define POS_COORD_GAP\s+6\b/.test(HOST) &&
    /const Gdiplus::REAL gap = PXF\(POS_COORD_GAP\);/.test(pcb) &&
    !/const Gdiplus::REAL gap = PXF\(2\)/.test(HOST) &&
    POSN('POS_COORD_GAP') > (POSN('POS_CELL') - 4) / 2,
    '缝=' + POSN('POS_COORD_GAP') + ' 棋子半径=' + ((POSN('POS_CELL') - 4) / 2));
  ok('格距放大到 15、棋盘 210（用户：让棋盘稍微大一点点）',
    /#define POS_CELL\s+15\b/.test(HOST) && /#define POS_GRID\s+\(POS_CELL \* 14\)/.test(HOST));
  // ★ 版式自洽性：把 POS_* 的整数宏真的算一遍（求值器见文件开头的 POSN）。
  //   这类「算式改一个数、另一个数忘了跟」的错误肉眼看注释是看不出来的 ——
  //   本次就差点上线「上内衬被压到 4、最上面那个 15 露到圆角卡片外」的版本。
  {
    const N = POSN;
    const w = N('POS_CARD_W'), h = N('POS_CARD_H');
    const grid = N('POS_GRID'), cw = N('POS_COORD_W'), ch = N('POS_COORD_H');
    const px = N('POS_CARD_PX'), pt = N('POS_CARD_PT'), pbz = N('POS_CARD_PB');
    const pad = N('POS_PAD'), by = N('POS_BY'), ox = N('POS_OX'), oy = N('POS_OY');
    ok('棋盘 + 左右坐标栏 + 左右内衬 == 卡片宽（不溢出、不留空）',
      grid + cw * 2 + px * 2 === w, grid + '+' + cw * 2 + '+' + px * 2 + ' vs ' + w);
    ok('★ 上内衬 ≥ 半个字高（行号以格线为中心，否则顶行「15」会露到卡片外）',
      pt * 2 >= ch, 'PT=' + pt + ' COORD_H/2=' + ch / 2);
    ok('★ 下内衬 ≥ 一个字高（列号那一行要完整落在卡片里）', pbz >= ch, 'PB=' + pbz + ' COORD_H=' + ch);
    ok('卡片高 == 上内衬 + 棋盘 + 下内衬', pt + grid + pbz === h, pt + '+' + grid + '+' + pbz + ' vs ' + h);
    ok('左右坐标栏正好贴住卡片内容区（左栏左边界 == 卡片内衬起点）',
      ox - cw === pad + px, (ox - cw) + ' vs ' + (pad + px));
    // 用户 2026-09-17：「棋盘距离圆角边框有较大的距离（左右和下）…边距稍微小一点」。
    // 上一版三条边距都是 24（内衬 10 + 坐标栏 14），随后收到 横 17 / 上 8 / 下 16。
    // ★ 2026-09-19 下边距的口径改了：坐标与棋盘线之间的缝（POS_COORD_GAP）2 → 6
    //   （用户：「有的子落到棋盘边缘会没过数字和字母」，缝必须 > 棋子半径 5.5），
    //   列号那一行整体下移 4，下内衬必须跟着涨 —— 16 → 22。
    //   所以老护栏里的「下 ≤ 20」已经失效（它守的是「缝 = 2」那版版式）。
    //   换成当下真正要守的两条：① 下内衬 = 缝 + 一整行坐标字 + 2 的余量（公式锁死）；
    //   ② 仍然明显小于最初的 24，别又回到「边距太大」。
    ok('★ 左右/上边距收小了，下边距跟着坐标缝长（横 17 / 上 8 / 下 22 = 缝 6 + 行 14 + 2）',
      px + cw <= 20 && pt <= 20 && px + cw < 24 &&
      pbz === N('POS_COORD_GAP') + ch + 2 && pbz < 24,
      '横' + (px + cw) + ' 上' + pt + ' 下' + pbz + '（缝 ' + N('POS_COORD_GAP') + '）');
    ok('棋盘在卡片里垂直居中偏上（上没有坐标行，下要多留一行列号）',
      oy - pt === by, (oy - pt) + ' vs ' + by);
    ok('窗口宽 / 主面板宽 ∈ [1.1, 1.3]（逐字重算一遍，不只是看注释）',
      N('POS_W') / 225 >= 1.1 && N('POS_W') / 225 <= 1.3,
      N('POS_W') + ' / 225 = ' + (N('POS_W') / 225).toFixed(3));
  }
  // ⚠ 以下 6 条原本挂在 pb（PaintPosition）上，2026-09-19 抽出 DrawPosBoardCard 之后
  //   必须改挂 pcb —— 坐标标注与棋子的绘制都已经搬到那个函数里了。
  ok('行号自下往上（g_posN - i，底行 = 1）、列号 A..O',
    /swprintf\(t, 8, L"%d", g_posN - i\)/.test(pcb) && /\(wchar_t\)\(L'A' \+ i\)/.test(pcb));
  ok('左栏 / 右栏 / 下栏三处都真的写了坐标（三处 DrawString 都在）',
    (pcb.match(/g\.DrawString\(t, -1, &fCoord, r/g) || []).length === 3,
    (pcb.match(/g\.DrawString\(t, -1, &fCoord, r/g) || []).length + ' 处');
  ok('标注字号比棋子小一档（PXF(8.0)，用户要的「细小的数字和字母」）',
    /Gdiplus::Font fCoord\(&ff, PXF\(8\.0\)/.test(pcb));
  // 用户 2026-09-17 第六条：「坐标里面的 10、11 等两位数应该横向写」
  //   → GDI+ 的 DrawString 布局矩形默认**会折行**，所以必须显式 NoWrap，
  //     并且把布局矩形给足整栏宽（靠 Far/Near 对齐留缝，不靠把矩形减窄）。
  ok('★ 三个坐标 StringFormat 全部禁用自动折行（否则「15」会被折成上下两行＝看着像竖排）',
    (pcb.match(/SetFormatFlags\(Gdiplus::StringFormatFlagsNoWrap\)/g) || []).length === 3,
    (pcb.match(/SetFormatFlags\(Gdiplus::StringFormatFlagsNoWrap\)/g) || []).length + ' 处（应为 3）');
  ok('★ 坐标布局矩形给足整栏宽（不再靠减窄矩形留缝 —— 那正是把两位数挤折行的原因）',
    /RectF rl\(bx - gap - lw, cy, lw, lh\)/.test(pcb) &&
    /RectF rr\(bx \+ span \+ gap, cy, lw, lh\)/.test(pcb) &&
    !/RectF rl\(bx - lw, cy, lw - gap, lh\)/.test(pcb));
  // 用户 2026-09-17 第七条：「深色模式黑子应该有清晰的白边」
  ok('★ 深色模式下黑子描一圈亮边（夜间卡片 (36,40,50) 与黑子 (17,17,17) 只差十几灰阶）',
    /Gdiplus::Pen kp\(Gdiplus::Color\(255, 232, 236, 245\), PXF\(1\.2\)\)/.test(pcb) &&
    /if \(dk\) g\.DrawEllipse\(&kp, cx, cy, sd, sd\);/.test(pcb));
  ok('浅色模式黑子仍不描边（白卡片上纯黑本来就清楚，别把旧观感改掉）',
    /if \(v == 1\) \{\s*g\.FillEllipse\(&bk, cx, cy, sd, sd\);\s*if \(dk\) g\.DrawEllipse/.test(pcb));
  // ★ 测试钩子：把局面窗钉在指定坐标，好让「残留实例抢屏」当场暴露
  ok('测试钩子 GB_TEST_POS_AT 能把局面窗钉在指定坐标（识破残留实例抢屏）',
    /GB_TEST_POS_AT/.test(HOST) && /sscanf\(v, "%d,%d", &tx, &ty\)/.test(HOST));

  // ③f 局面代码新增「总代码」（用户 2026-09-17：「代码不仅有专属黑色、白色的，
  //     也应该有『总代码』，也就是从第一手到最后一手的总代码」）。
  //     识别结果只有黑白两组的集合、不含落子先后，所以「总」= 黑白合并的一整条，
  //     顺序取「自上而下、自左而右」的稳定遍历（用户已在两条方案中选定这一种）。
  ok('★ 局面代码多出「总代码」一行（A: 黑白合并）',
    /s \+= "A: " \+ sa \+ "\\n";/.test(HOST) && /std::string sb, sw, sa;/.test(HOST));
  // 用户 2026-09-17 第七条：「棋盘总代码是五子棋计算器样式的，是字母和数字连一块的」
  //   → 总代码必须**不加任何分隔符**（区分 sa 与 sb/sw：后两者仍是逗号清单）。
  ok('★ 总代码是连写的（五子棋计算器样式：坐标首尾相接，无逗号无空格）',
    /std::string c = coord\(x, y\);\s*sa \+= c;/.test(HOST_CODE) &&
    !/if \(!sa\.empty\(\)\) sa \+= /.test(HOST_CODE),
    'sa 仍在插分隔符？');
  ok('B:/W: 两条仍是逗号分隔的清单（不能为了「连写」把三条格式混成一套）',
    /if \(!sb\.empty\(\)\) sb \+= ","; sb \+= c;/.test(HOST_CODE) &&
    /if \(!sw\.empty\(\)\) sw \+= ","; sw \+= c;/.test(HOST_CODE));
  ok('总代码与 B:/W: 共用同一个遍历与 coord()（三条口径必然一致）',
    /std::string c = coord\(x, y\);/.test(HOST) &&
    /if \(v == 1\) \{ nb\+\+; if \(!sb\.empty\(\)\) sb \+= ","; sb \+= c; \}/.test(HOST) &&
    /else\s+\{ nw\+\+; if \(!sw\.empty\(\)\) sw \+= ","; sw \+= c; \}/.test(HOST));
  ok('总代码不能靠「猜落子顺序」实现（识别结果里没有先后信息，硬排会给出假序列）',
    !/moveOrder|plyOrder|落子顺序推断/.test(HOST));
  // 渲染侧的配套：测试工具的分带比例必须跟着新窗口高度走，否则「棋盘带」会把代码卡片
  // 一起圈进去，所有像素断言都会失真。
  //   历史：420 → 406 → 410（2026-09-17 两次改版）→ 416（2026-09-19：坐标缝 2 → 6，
  //   卡片下内衬 16 → 22 ⇒ 卡片高 234 → 240 ⇒ 窗口高 +6）。
  ok('截图工具的分带比例已跟上新窗口高度 416（旧的 420 / 406 / 410 都已绝迹）',
    /2 \/ 416\.0, 26 \/ 416\.0/.test(SHOT) &&
    /38 \/ 416\.0, 278 \/ 416\.0/.test(SHOT) &&
    /378 \/ 416\.0, 404 \/ 416\.0/.test(SHOT) &&
    /294 \/ 416\.0, 362 \/ 416\.0/.test(SHOT) &&
    /261 \/ 416\.0, 275 \/ 416\.0/.test(SHOT) &&
    !/\/ 406\.0/.test(SHOT) && !/\/ 420\.0/.test(SHOT) && !/\/ 410\.0/.test(SHOT));
  // ★ 再钉一条**不靠手抄数字**的：每条带都必须等于 host.cpp 算出来的区间。
  //   为什么非要这样：2026-09-19 改坐标缝时，卡片下内衬 16 → 22 把代码卡片与按钮行整体
  //   往下推了 6，而「按钮行带」还停在旧位置 —— 于是它把按钮拦腰截断，
  //   test-overlay-pos-render 量出「按钮只有 20 设计单位高（应为 26）」，
  //   看起来像产品把按钮改小了，其实是**量错了地方**。这条断言就是那次假红的解药。
  ok('★ 截图工具的每条分带都等于 host.cpp 的 POS_* 区间（分母不是手抄的数）',
    POSN('POS_H') > 0 &&
    new RegExp(' / ' + POSN('POS_H') + '\\.0').test(SHOT) &&
    // 棋盘带 = POS_BY .. POS_BY + POS_CARD_H
    new RegExp('38 / ' + POSN('POS_H') + '\\.0, ' +
               (POSN('POS_BY') + POSN('POS_CARD_H')) + ' / ' + POSN('POS_H') + '\\.0').test(SHOT) &&
    // 按钮行带 = POS_BTN_Y .. POS_BTN_Y + POS_BTN_H（差一个数就会把按钮截断/把别的圈进来）
    new RegExp('(?:^|[^\\d])' + POSN('POS_BTN_Y') + ' / ' + POSN('POS_H') + '\\.0, ' +
               (POSN('POS_BTN_Y') + POSN('POS_BTN_H')) + ' / ' + POSN('POS_H') + '\\.0').test(SHOT) &&
    // 代码卡片带 = POS_CODE_Y + 8 .. POS_CODE_Y + 76（躲开卡片圆角与边框）
    new RegExp('(?:^|[^\\d])' + (POSN('POS_CODE_Y') + 8) + ' / ' + POSN('POS_H') + '\\.0, ' +
               (POSN('POS_CODE_Y') + 76) + ' / ' + POSN('POS_H') + '\\.0').test(SHOT),
    'POS_H=' + POSN('POS_H') + ' 棋盘下界=' + (POSN('POS_BY') + POSN('POS_CARD_H')) +
    ' 按钮行=' + POSN('POS_BTN_Y') + '..' + (POSN('POS_BTN_Y') + POSN('POS_BTN_H')) +
    ' 代码带=' + (POSN('POS_CODE_Y') + 8) + '..' + (POSN('POS_CODE_Y') + 76));
  // ★ 坐标三条分带也必须跟着 POS_COORD_GAP 走：缝加大之后标注要往卡片里侧挪
  //   （左栏文字右缘贴的是 bx-gap、下栏文字上缘贴的是 by+GRID+gap），
  //   分带还停在老位置的话，一半字形落到栏外 —— coordLeft / coordBottom 断言就会开始飘。
  ok('★ 截图工具的坐标栏分带跟着 POS_COORD_GAP 走（缝 2 → 6 后三条栏各挪 4 个设计单位）',
    POSN('POS_COORD_GAP') > (POSN('POS_CELL') - 4) / 2 &&
    // 左栏：从卡片内容区左沿(POS_PAD)起，到「标注右缘 POS_OX-gap」再放 2 的余量为止（不越过 POS_OX）
    new RegExp('(?:^|[^\\d])' + POSN('POS_PAD') + ' / 268\\.0, ' +
               (POSN('POS_OX') - POSN('POS_COORD_GAP') + 2) + ' / 268\\.0').test(SHOT) &&
    // 右栏：从「标注左缘 POS_OX+GRID+gap」往回放 4 的余量起
    new RegExp('(?:^|[^\\d])' +
               (POSN('POS_OX') + POSN('POS_GRID') + POSN('POS_COORD_GAP') - 4) + ' / 268\\.0').test(SHOT) &&
    // 下栏：从「棋盘下沿 POS_OY+GRID + 缝」再往上放 1 起（既不碰格线 256，也不把字形的
    //   上沿抗锯齿切掉）—— 正好是「格线 + 缝 − 1」
    new RegExp('(?:^|[^\\d])' +
               (POSN('POS_OY') + POSN('POS_GRID') + POSN('POS_COORD_GAP') - 1) +
               ' / ' + POSN('POS_H') + '\\.0').test(SHOT),
    '缝=' + POSN('POS_COORD_GAP') + '（棋子半径 ' + ((POSN('POS_CELL') - 4) / 2) + '）' +
    ' 左栏=' + POSN('POS_PAD') + '..' + (POSN('POS_OX') - POSN('POS_COORD_GAP') + 2) +
    ' 右栏起点=' + (POSN('POS_OX') + POSN('POS_GRID') + POSN('POS_COORD_GAP') - 4) +
    ' 下栏起点=' + (POSN('POS_OY') + POSN('POS_GRID') + POSN('POS_COORD_GAP')));
  // 坐标栏像素 + **棋盘线实测位置**（gridX0/gridY0…）。
  // ⚠ 别再退回「数坐标栏里有没有网格色」那个口径：坐标字的抗锯齿边缘会穿过网格色的
  //   邻域，每栏能数出两三百像素的假阳性。现在改成直接量棋盘线的位置与条数。
  ok('截图工具能统计坐标栏像素 + 棋盘线实测位置/条数（不用会被抗锯齿骗的旧口径）',
    /coordLeft/.test(SHOT) && /gridX0/.test(SHOT) && /gridVCount/.test(SHOT) &&
    !/gridInLeftGutter/.test(SHOT));
  // ★ 定位逻辑的鲁棒性（2026-09-17 第二个真事故的护栏）：
  //   「不是底色的像素 = 小窗」这个前提，只要屏幕上还有**任何**别的 topmost 窗口就不成立
  //   （本程序自己残留的实例、或别的软件）。老实现取「最上面一行有内容的像素」，
  //   于是比小窗更靠上的薄虚线段把它整个带偏（截图裁偏 79px，一片假红）。
  //   现在行判据是 0.6w（小窗每行几乎满宽，薄线段必被挡掉）且取**最长连续段**。
  ok('★ 截图工具的窗口定位改用「0.6w 行判据 + 最长连续段」（薄虚线段/外来窗口骗不偏它）',
    /_longest_run/.test(SHOT) && /rowcnt > 0\.6 \* w/.test(SHOT) &&
    /run_r = _longest_run\(wide\)/.test(SHOT) && !/rows\.min\(\)/.test(SHOT));

  // ④ 窗口宽度仍锚定主面板 1.2 倍
  {
    const wm = /#define POS_W\s+\(POS_PAD \+ POS_CARD_W \+ POS_PAD\)\s*\/\/\s*(\d+)/.exec(HOST);
    const pw = wm ? parseInt(wm[1], 10) : 0;
    ok('局面窗宽 / 主面板宽 ∈ [1.1, 1.3]（用户要求「1.2 倍左右」）',
      pw > 0 && pw / 225 >= 1.1 && pw / 225 <= 1.3, pw + ' / 225 = ' + (pw / 225).toFixed(3));
  }

  // ⑤ 棋盘数据来源：与书签版共用同一份 OpenCV /scan 结果
  ok('局面窗的棋子直接取扫描服务那一帧 JSON（found && !suspect && ParseStonesForPos(res)）',
    /found && !suspect && ParseStonesForPos\(res\)/.test(HOST_CODE));
  ok('ParseStonesForPos 读的就是 black/white 两组识别坐标（与书签版同一份 opencv 输出）',
    /const char\* keys\[2\] = \{"black", "white"\};/.test(HOST) &&
    /g_posBoard\[y\]\[x\] = colors\[k\]; total\+\+;/.test(HOST));
  ok('局面小窗的矩形被排除在识别之外（自己画的东西绝不喂回 OpenCV）',
    /g_posWnd/.test(HOST) && /exclude/.test(HOST));
}

// ---------------------------------------------------------------- ⑬ 我执黑/白可「两个都不选」
// 用户要求（2026-09-17）：「锁定黑和锁定白也可以，两者都没选上 —— 比如说选择白色了，
//   再点击一次白色就取消选择了，就是黑色、白色都没有选，待用户选择黑白中的其中一个，
//   这样可能会稳定一些」。
// 关键点有三个，缺一条用户就会觉得「取消不了」或「又跳了」：
//   ① 再点同一个颜色 = 取消（S.side → -1）；
//   ② -1 是合法状态，boot 不能把它兜底成黑；
//   ③ -1 时**停止评估**（否则评估符号在黑/白视角之间来回翻，正是用户最烦的抖动）。
console.log('== ⑬ 我执黑/白：再点一次取消，两者都不选 ==');
ok('再点同一个颜色 → S.side 变 -1（取消选择）',
  /S\.side = \(S\.side === v\) \? -1 : v;/.test(BRIDGE_CODE));
ok('有 sideUnset() 这个统一判据（0/1 之外一律算未选定）',
  /function sideUnset\(\) \{ return S\.side !== 0 && S\.side !== 1; \}/.test(BRIDGE_CODE));
ok('boot 不再把 -1 兜底成黑（旧实现让用户"取消完一刷新又变黑"）',
  /if \(S\.side !== 0 && S\.side !== 1\) S\.side = -1;/.test(BRIDGE_CODE) &&
  !/S\.side !== 0 && S\.side !== 1\) S\.side = 0;/.test(BRIDGE_CODE));
ok('未选定时停止评估（handleScan 里先判 sideUnset 再 analyze）',
  /if \(sideUnset\(\)\) \{\s*haltNoSide\(\);\s*return;\s*\}/.test(BRIDGE_CODE) &&
  BRIDGE_CODE.indexOf('haltNoSide()') < BRIDGE_CODE.indexOf('await analyze(bl, wh);'));
ok('「停住」分支会清掉旧颜色的推荐/热力图/统计（不留上一方的结果）',
  /function haltNoSide\(\)[\s\S]{0,420}?postGuide\(false\)[\s\S]{0,160}?type: 'heat', on: false/.test(BRIDGE_CODE));
ok('换色/取消时也清缓存（曲线与候选不跨颜色）',
  /function setSide\(v\) \{[\s\S]{0,320}?S\.candCache = \[\];[\s\S]{0,200}?S\.history = \[\];/.test(BRIDGE_CODE));
ok('未选定时两个按钮都不淡出（淡淡的那种看起来像坏了）',
  /el\.style\.opacity = \(on \|\| unset\) \? '1' : '0\.45';/.test(BRIDGE_CODE));
ok('状态文字给出橙色「请选黑/白」提示（中英各一份）',
  /txt\.textContent = en \? 'pick B\/W' : '请选黑\/白';/.test(BRIDGE_CODE));
ok('按钮 title 写明「再点一次取消」',
  /我执黑（再点一次取消）/.test(BRIDGE_CODE) && /我执白（再点一次取消）/.test(BRIDGE_CODE));
ok('未选定时状态栏也提示去选颜色（不是静默什么都不做）',
  /我执颜色未选定——请点「黑」或「白」开始评估/.test(BRIDGE_CODE));

// ---------------------------------------------------------------- ⑦ 发布目录已同步
console.log('== ⑦ 发布目录与源一致（防「本地对、包是旧的」）==');
const PUB = path.join(ROOT, 'Meter engine-server', 'overlay');
if (fs.existsSync(PUB)) {
  // ★ 发布目录只该有**密文**（.enc）：明文 UI 一个都不许躺着，否则加密等于白做。
  for (const f of ['panel.html', 'panel-ui.js', 'bridge.js']) {
    const src = path.join(ROOT, 'desktop-overlay', 'ui', f);
    const encSrc = src + '.enc';
    const encPub = path.join(PUB, f + '.enc');
    ok('发布目录 overlay/' + f + '.enc 与源逐字节一致',
      fs.existsSync(encSrc) && fs.existsSync(encPub) &&
      fs.readFileSync(encSrc).equals(fs.readFileSync(encPub)));
    ok('发布目录**没有**明文 overlay/' + f + '（UI 已加密发布）',
      !fs.existsSync(path.join(PUB, f)));
    ok('overlay/' + f + '.enc 是 GBUIENC1 密文（不是明文套壳）',
      fs.readFileSync(encPub, 'utf8').indexOf('GBUIENC1') === 0);
  }
} else {
  console.log('  (未找到发布目录，跳过同步检查)');
}

// ---------------------------------------------------------------- ⑪ 中空选框窗 + 局面开关
// 用户 2026-09-18 现场三条，全是「点了没反应 / 反复弹」这类交互契约，
// 光看代码看不出对错，所以钉在源码文本上：改坏了立刻红，不用等上真机。
console.log('== ⑪ 中空选框窗（手动调节）与「局面」开关 ==');
// ① 中空：整窗先擦成全透明，只有标题栏 + 一圈边框 —— 中间必须能看见底下的棋盘。
ok('选框窗口整窗先擦成全透明（中空，透出屏幕）',
  /g\.Clear\(Gdiplus::Color\(0, 0, 0, 0\)\);/.test(HOST));
// ② 标题栏高度 44 且是淡紫。
//    用户先说「窗口栏要较窄」（26），2026-09-18 实机看过又说「上面的控制框栏要稍微宽一点，
//    当前很细」→ 34；同日第三次仍嫌「控制栏和两个按键和字体太细了」→ **44**，
//    并且按键同步加宽（56/42 → 78/62）、字号 12 → 15/14 并加粗。
//    这里钉住**当前**值，别再改回去（26/34 都已经被用户否掉了）。
ok('标题栏高度 44（2026-09-18 三次加宽：26→34→44）且淡紫（196,170,255）',
  /#define SEL_TITLE_H 44/.test(HOST) && /#define SEL_PURPLE_R 196/.test(HOST) &&
  /#define SEL_PURPLE_G 170/.test(HOST) && /#define SEL_PURPLE_B 255/.test(HOST));
// ②b 用户 2026-09-18：「控制栏和两个按键和字体太细了，宽大一点」——四个量一起钉。
ok('★ 选框按键加宽（识别 78 / 关闭 62）且高度跟着标题栏（bh = SEL_TITLE_H - 8）',
  /#define SEL_BTN_W\s+78\b/.test(HOST) && /#define SEL_CLOSE_W\s+62\b/.test(HOST) &&
  /int bh = SEL_TITLE_H - 8/.test(HOST));
ok('★ 选框字号变大变粗（标题 15px 加粗 / 按键 14px 加粗，不再是 12px 细体）',
  /Gdiplus::Font f\(&ff, 15\.0f, Gdiplus::FontStyleBold/.test(HOST) &&
  /Gdiplus::Font f\(&ff, 14\.0f, Gdiplus::FontStyleBold/.test(HOST) &&
  !/Gdiplus::Font f\(&ff, 12\.0f/.test(HOST));
ok('★ 四角把手跟着放大（6 → 8）', /const int hs = 8;/.test(HOST));
ok('选框按键宽度不会溢出标题栏（宽度 = 边距+识别+间距+关闭，且都为常量宏）',
  /#define SEL_BTN_GAP 8/.test(HOST) && /#define SEL_EDGE\s+8/.test(HOST) &&
  /int bx2 = W - SEL_EDGE - SEL_CLOSE_W;/.test(HOST) &&
  /int bx1 = bx2 - SEL_BTN_GAP - SEL_BTN_W;/.test(HOST));
// ③ 两个按键：「识别」「关闭」。点识别**不关框**（这是与旧「拖完即关」最大的差别）。
ok('标题栏上有「识别」「关闭」两个按键（中英文各一份）',
  /SEL_BTN_REC,\s+148, 108, 238, SelT\(L"\\u8bc6\\u522b", L"Scan"\)/.test(HOST) &&
  /SEL_BTN_CLOSE, 214,\s+96,\s+96, SelT\(L"\\u5173\\u95ed", L"Close"\)/.test(HOST));
ok('点「识别」只设区域、框保留（不调 CloseSelectWindow）',
  /static void SelApplyRegion\(HWND h\)[\s\S]{0,900}?PostToPanel\("\{\\"type\\":\\"region\\",\\"set\\":true\}"\)[\s\S]{0,120}?PaintSelect\(h\)/.test(HOST) &&
  !/static void SelApplyRegion\(HWND h\)[\s\S]{0,1200}?CloseSelectWindow\(\);/.test(HOST));
ok('点「关闭」/Esc 才关框，且识别区域保留（不清 g_scanRegion）',
  /case WM_KEYDOWN:[\s\S]{0,120}?if \(wp == VK_ESCAPE\) \{ CloseSelectWindow\(\); return 0; \}/.test(HOST) &&
  !/static void CloseSelectWindow\(\)[\s\S]{0,400}?g_scanRegion = \{0, 0, 0, 0\};/.test(HOST));
// ④ 框还在时再点「手动调节」必须**不反应**（不重复弹、不抢焦点）。
ok('选框已存在时 StartSelectWindow 直接返回（再点手动调节不反应）',
  /if \(g_selectWnd && IsWindow\(g_selectWnd\)\) return;/.test(HOST));
// ⑤ 选框自己绝不能进截屏：否则它画的紫边会被当棋盘线，污染它正要框的那块区域。
ok('选框窗口设了 WDA_EXCLUDEFROMCAPTURE（自己不进截屏）',
  /SetWindowDisplayAffinity\(g_selectWnd, WDA_EXCLUDEFROMCAPTURE\)/.test(HOST));
// ⑥ 可拖可缩放：标题栏拖动 + 四边/四角把手（命中测试里 8 个方向齐全）。
ok('选框可拖动（标题栏）并可缩放（四边四角共 8 个把手）',
  /return SEL_MOVE;/.test(HOST) && /if \(L && T\) return SEL_TL;/.test(HOST) &&
  /if \(R && B\) return SEL_BR;/.test(HOST) && /case SEL_MOVE:/.test(HOST));
// ⑦ 「局面」是**开关**：看得见 → 再点关闭；**看不见/最小化 → 还原+前台**（绝不当成"关闭"）。
//    ★ 2026-09-18：判据从 `IsWindow()` 改成 `IsWindowVisible() && !IsIconic()`。
//    旧写法只要窗口"存在"就走关闭分支 —— 而最小化 / 被拖到屏幕外都仍是"存在"，
//    于是用户点「局面」得到的是"点了没反应"（其实是把它关了），第二下才开出来。
//    这正是用户反复报的「可以保证点击局面能打开这个小窗口」。
ok('「局面」按钮是开关式（可见 → 再点关闭；不可见/最小化 → 还原+前台，不再误关）',
  /bool visible = \(g_posWnd && IsWindow\(g_posWnd\) && IsWindowVisible\(g_posWnd\) &&/.test(HOST_CODE) &&
  /!IsIconic\(g_posWnd\)\)/.test(HOST_CODE) &&
  /if \(visible\) \{[\s\S]{0,160}?ClosePositionWindow\(\);/.test(HOST_CODE) &&
  /OpenPositionWindow\(\);/.test(HOST_CODE));
// ⑧ 底部只留「局面」一个键：「手动调节」顶部本来就有一个，底部重复会撞 id
//    （bridge 的 on() 只绑 getElementById 取到的第一个 → 底部那个是死键）。
ok('底部条没有重复 id（__gb_adjust 1 个、__gb_pos 1 个、__gb_possave 1 个）',
  (PANEL.match(/id="__gb_adjust"/g) || []).length === 1 &&
  (PANEL.match(/id="__gb_pos"/g) || []).length === 1 &&
  (PANEL.match(/id="__gb_possave"/g) || []).length === 1);
// ⑨ 底部条底色跟深色模式（原来写死 #fff → 深色模式下留一条白杠）。
// 2026-09-18 改：三个键不再逐个 on(id,'click',...)，改成挂在 document 上的**事件委托**
// （FOOT_ACTIONS 表）。原因见 bridge.js 里的注释：逐个绑时用户点击收不到，日志里连一条
// openPos 都没有。这里把「键存在 + 委托表里真有对应动作」两头都钉住，
// 免得以后有人改回逐个绑定却又忘了同步断言。
ok('底部条是「局面 + 保存局面」两个键（2026-09-18 去掉「复盘」，2026-09-19 加「保存局面」）',
  /id="__gb_pos"/.test(PANEL) && !/id="__gb_review"/.test(PANEL) &&
  /id="__gb_possave"/.test(PANEL) &&
  /var FOOT_ACTIONS = \{/.test(BRIDGE_CODE) &&
  // ★ 2026-09-18：openPos 不再内联在 FOOT_ACTIONS 里，而是经 askPosition() 转一手
  //   （askPosition 重置重试计数 → 发第一枪），所以这里顺着调用链把两头都钉住。
  /__gb_pos: function \(\) \{ askPosition\(\); \}/.test(BRIDGE_CODE) &&
  // ★ B2：新键**必须**挂进 FOOT_ACTIONS —— 底栏的绑定 / 启动探针 / 点击派发三处
  //   都只看这张表的键（bindFootDirect / footProbeLine / fireFoot），漏登记就是
  //   「按钮长得出来但点不动」——正是用户报过的那类故障。
  /__gb_possave: function \(\) \{ tellHost\(\{ type: 'savePosPng' \}\); \}/.test(BRIDGE_CODE) &&
  /function askPosition\(\)/.test(BRIDGE_CODE) &&
  /function sendOpenPos\(\) \{[\s\S]{0,120}?type: 'openPos'/.test(BRIDGE_CODE) &&
  !/__gb_review:/.test(BRIDGE_CODE));
ok('底部条显式 pointer-events:auto（外层整片是 none，不然按钮看得见点不到）',
  /id="__gb_footbar"[^>]*pointer-events:auto/.test(PANEL));
ok('底部条功能键：委托 + 直连双保险，并上报启动探针（定位「点了没反应」）',
  /function fireFoot\(id, e\)/.test(BRIDGE_CODE) && /function bindFootDirect\(\)/.test(BRIDGE_CODE) &&
  /new MutationObserver\(function \(\) \{ bindFootDirect\(\); \}\)/.test(BRIDGE_CODE) &&
  /type: 'footProbe'/.test(BRIDGE_CODE) &&
  /footProbe/.test(HOST));
// ★ 2026-09-18：用户要求「**保证**点击局面能打开小窗」。双保险仍然只是「点击→发消息」，
//   消息丢了/宿主没处理就彻底静默。所以再加一层**回执 + 重试**：宿主开/关小窗后回推
//   posState（open:true / false 两个方向都推），页面发完 openPos 若 800ms 内没等到
//   open:true 就重发（最多 3 次）。页面据此熄灭重试定时器并点亮/熄灭「局面」键。
ok('「局面」按键有回执 + 重试（宿主回推 posState，页面 800ms 未确认就重发，最多 3 次）',
  /posState/.test(HOST) && /open\\":true/.test(HOST) && /open\\":false/.test(HOST) &&
  // 宿主读重试计数：源码是窄字符串比较 `w.find(L"\"try\":")` —— 文件里躺着的是
  // `\"try\":`（带转义反斜杠），所以正则必须把那个反斜杠写进去，否则永远匹配不上。
  /try\\":/.test(HOST) &&
  /msg\.type === 'posState'/.test(BRIDGE_CODE) && /function posConfirmed\(\)/.test(BRIDGE_CODE) &&
  /posRetry = setTimeout/.test(BRIDGE_CODE) && /posTries >= 3/.test(BRIDGE_CODE) &&
  /function posBtnOn\(on\)/.test(BRIDGE_CODE));
ok('「复盘」把当前棋盘写进 %TEMP%\\gb-calc-inbox.json（计算器自己的 watcher 拾取）',
  /gb-calc-inbox\.json/.test(HOST) && /static void OpenCalculatorWithBoard\(\)/.test(HOST));
ok('计算器已开时只激活窗口，没开才拉起（不做命令行转义）',
  /FindWindowW\(L"GbCalcHost", nullptr\)/.test(HOST) && /Desktop GomokuTrainer\.exe/.test(HOST));
// 底部条**不允许自己上色**：paintPanelBg() 会把 #__gb_panel 涂成 rgba(…,a)，
// 底栏一旦写死底色（旧版 #fff / 深色 #1f2330）就会变成一条不跟随「透明度」的白杠 ——
// 用户 2026-09-18 现场反馈的原话是「它周围的透明效果没有实现」。必须 transparent，
// 让 #__gb_panel 的 rgba 背景自己透出来；分隔用 inset 阴影（不占布局、不随透明度发白）。
ok('底部条不上色（transparent），透出面板自己的半透明底 —— 跟随「透明度」设置',
  /#__gb_footbar\{background:transparent/.test(PANEL) &&
  !/#__gb_footbar\{background:#fff\}/.test(PANEL) &&
  !/#__gb_footbar\{background:#1f2330\}/.test(PANEL) &&
  !/id="__gb_footbar"[^>]*background:#fff/.test(PANEL));
ok('「局面」键是实心绿（深色另有更深的一套），面板里不再出现旧的浅绿 #eaf6ec',
  /#__gb_pos\{background:#2e7d32!important;color:#fff!important/.test(PANEL) &&
  !/#eaf6ec/.test(PANEL));

// ⑬ 「局面按键点不动」的根因修复（2026-09-18，tools/_probe_footbar.py 定位）
//    实测：面板窗口 421x1208，沿中线扫 WindowFromPoint 时 y=720..1744 命中我们的
//    WebView2、**y>=1748 全部穿透**到别的窗口；1748-680=1068 正是面板**创建时**的高度。
//    WS_EX_LAYERED 的命中表面不随 SetWindowPos 长大（region 已是全尺寸、重设也没用），
//    只有摘掉分层样式再挂回去才恢复 —— 恢复后同一记真实点击立刻把局面窗开出来了。
ok('面板尺寸变化后刷新分层窗口命中表面（否则底栏「画得出来、点不到」）',
  /static void RefreshPanelHitSurface\(\)/.test(HOST) &&
  /GetWindowLongW\(g_panel, GWL_EXSTYLE\)/.test(HOST) &&
  /ex & ~\(\(LONG\)WS_EX_LAYERED\)/.test(HOST) &&
  // 必须在 SetWindowRgn 之后：顺序反了会被 region 重设再打回陈旧状态。
  /SetWindowRgn\(g_panel, rgn, TRUE\);[\s\S]{0,500}?RefreshPanelHitSurface\(\);/.test(HOST));

// ⑭ 「局面」小窗对识别服务免疫（用户 2026-09-18 要求）
//    WDA_EXCLUDEFROMCAPTURE 实测有效（A/B 同帧：普通窗 48400/48400 像素、WDA 窗 0 像素，
//    且它盖住的那块露出背后的真实棋盘）—— 比「把窗口矩形抹成纯色」强在：
//    被它挡住的棋盘还能被认出来，DWM 投影阴影那圈也不残留。
ok('「局面」小窗设了 WDA_EXCLUDEFROMCAPTURE（截图里整窗消失）',
  /SetWindowDisplayAffinity\(g_posWnd, WDA_EXCLUDEFROMCAPTURE\)/.test(HOST) &&
  /#define WDA_EXCLUDEFROMCAPTURE 0x11/.test(HOST));
ok('三处自绘窗口（覆盖层/小窗/选框）都排除出截图，且共用同一个测试退出口',
  /static bool SelfCaptureAllowedForTest\(\)/.test(HOST) &&
  /GB_TEST_CAPTURABLE/.test(HOST) &&
  /SetWindowDisplayAffinity\(g_posWnd, WDA_EXCLUDEFROMCAPTURE\)/.test(HOST) &&
  /SetWindowDisplayAffinity\(g_selectWnd, WDA_EXCLUDEFROMCAPTURE\)/.test(HOST) &&
  /SetWindowDisplayAffinity\(g_overlay, WDA_EXCLUDEFROMCAPTURE\)/.test(HOST));
// ★ 覆盖层那一处**必须**也认退出口，这条是实测踩出来的：
//   覆盖层被排除出截图后，GB_TEST_BACKDROP 那块纯绿底衬在截图里 0 像素 →
//   _screen_shot.py 的 locate_window 恒定偏 (-80,-80) → test-overlay-pos-render 22 条红、
//   test-overlay-alpha 同理。根因不在渲染，全在「测试看不到自己铺的底」。
ok('★ 覆盖层的截图排除也认测试退出口（否则 GB_TEST_BACKDROP 拍不到 → 像素测试连锁假红）',
  /SelfCaptureAllowedForTest\(\)[\s\S]{0,240}?\[boot\] \(test\) self-capture allowed/.test(HOST));

// ⑩ 扫描节奏自适应（用户：「设 1.25 秒却近 5 秒才出结果」）
//    旧代码 Sleep(900) 且**没扣识别耗时**，实际 1.3~1.6s/帧；面板又要求连续 2 帧一致
//    才采纳 → 光确认就 ~3s。这里钉住：周期按耗时补齐 + 盘面变化后几帧快轮询。
ok('扫描周期按本帧真实耗时补齐（不再 900ms + 识别耗时）',
  /int s = period - \(int\)elapsedMs;/.test(HOST) && /ScanSleepMs\(scanElapsed,/.test(HOST));
ok('盘面变化后的几帧切快轮询（260ms），常态仍是 900ms',
  /int period = fast \? 260 : 900;/.test(HOST) && /fastStreak = 3/.test(HOST));
ok('盘面指纹只取 "black" 之后（避开每帧变的诊断字段，防止恒走快轮询）',
  /res\.find\("\\"black\\""\)/.test(HOST) && /res\.substr\(pb\)/.test(HOST));

// ⑮ 局面小窗的棋子必须能解析**真实报文**（用户 2026-09-18：「局面的棋盘并没有正确
//     识别出当前的棋盘」）
//   现场：面板有推荐落点/曲线（= 同一帧 JSON 里确实有棋子），局面小窗却恒显示
//   「尚未识别到当前棋盘」+ 空局面代码。根因是 ParseStonesForPos 死抠 `"black":[`，
//   而识别服务用的是 Python `json.dumps` 的**默认分隔符**（`": "` / `", "`）→ 永远匹配不上。
//   这条链路此前**零覆盖**：唯一被测过的是 GB_TEST_DEMO_POS 的「演示注入」，
//   所以这个 bug 能在全绿套件下活到今天。端到端护栏见 test-pos-stones.js。
// ⚠️ 这条用 indexOf 而不是正则：要匹配的原文里带 `[`，写成正则需要转义 `\[`，
//   漏转义就会把 `[` 当成字符类开头吞掉行尾 → "Invalid regular expression: missing /"。
ok('★ ParseStonesForPos 不再死抠 "black":[（json.dumps 的冒号后是有空格的）',
  HOST.indexOf('keys[k] + "\\":["') < 0 &&
  /JsonIntInRange/.test(HOST) &&
  // 先找键、再找它后面的 '['
  /size_t lb = json\.find\('\[', p \+ kk\.size\(\)\);/.test(HOST));
ok('★ 取 x/y 时会跳过冒号后的空白（数字解析不依赖紧贴写法）',
  /bool JsonIntInRange\(const std::string& s, size_t from, size_t limit,/.test(HOST) &&
  /while \(d < limit && \(s\[d\] == ' ' \|\| s\[d\] == '\\t'/.test(HOST));
ok('★ 识别服务端口可由 GB_SCAN_PORT 覆盖（假的识别服务才有地方落脚，不必抢用户 8971）',
  /static int ScanPort\(\)/.test(HOST) && /GB_SCAN_PORT/.test(HOST) &&
  /PortAlive\(ScanPort\(\)\)/.test(HOST) &&
  /HttpPost\(ScanPort\(\), L"\/scan"/.test(HOST) &&
  // 生产默认值仍是 8971（改这个开关不能顺手把默认端口也改了）
  /if \(!p\) p = 8971;/.test(HOST));

// ⑯ 「复制代码」只复制总代码（用户 2026-09-18：「如果用户点击复制代码，
//     只复制总代码（连一块的棋盘局势代码）」）
//   旧实现把整块多行文本（`Gomoku15 B:n W:m` 表头 + A: + B: + W: 四行）都塞进剪贴板，
//   用户粘去计算器还得自己删表头、挑行。现在只放总代码那一串（连写、无前缀、无分隔符）。
//   ⚠️ 与 PosSaveCode() 故意不同：**保存文件仍是完整四行**（可读存档），别把两条合并。
ok('★ 「复制代码」只放总代码（BuildPositionCode 回填 sa，剪贴板里没有表头/分行）',
  /static std::wstring BuildPositionCode\(std::string\* totalOut = nullptr\)/.test(HOST) &&
  /if \(totalOut\) \*totalOut = sa;/.test(HOST) &&
  /std::string total;\s*\n\s*BuildPositionCode\(&total\);/.test(HOST) &&
  /std::wstring code = Utf8ToWide\(total\);/.test(HOST));
ok('★ 空盘不复制（不清空用户剪贴板），并留一条可查的日志',
  /copy skipped: board is empty/.test(HOST));
ok('★ 「保存局面」仍然是完整四行（与复制的口径故意不同）',
  /static void PosSaveCode\(\)[\s\S]{0,300}?BuildPositionCode\(\);/.test(HOST));
ok('复制有端到端退出口（GB_TEST_COPY_POS → 解析成功后自动复制一次，供 test-pos-stones.js 读剪贴板）',
  /GB_TEST_COPY_POS/.test(HOST) && /copiedOnce/.test(HOST));
// ★ 这条日志是 test-pos-stones.js 的锚点，也是现场排查「小窗不显示棋盘」的唯一真信号：
//   `[pos] paint ... board=? stones=?` 每种尺寸只打两次，且总拍在「窗口刚开、还没扫到盘」
//   的时刻（用户就是照着那两行 board=0 stones=0 误判成「棋子没解析出来」）。
ok('★ 局面棋子按**变化**记日志（stones updated），不再只靠那两行「只打两次」的 paint 日志',
  /\[pos\] stones updated: B=%d W=%d \(recognized=%d\)/.test(HOST) &&
  /if \(nb != prevNb \|\| nw != prevNw\)/.test(HOST));

// ---------------------------------------------------------------- ⑰ B 轮（2026-09-19 用户五条）
// 用户原话：「就是局面和上面的按键为同一个背景板块，在局面的右面添加一个保存局面这个按键，
//   可以保存渲染出来的识别后的棋盘软件渲染的棋盘 png 图片文件，添加桌面端的五子棋助手可以
//   进行这个窗口的长度的调节，最矮不要没过哈希表，最长就是全部功能都展示，长度短就可以
//   进行鼠标滚动，然后局面棋盘上的坐标字母和数字要距离棋盘稍微远一点，因为有的子落到棋盘
//   边缘会没过数字和字母；并且局面，和复制局面，这两个功能键应该小一点，高度和上面的三个
//   按钮一样」（坐标缝 B4 的护栏在 ⑫③e）。
console.log('== ⑰ 底栏合并成一个背景板块 / 保存局面(PNG) / 面板高度可调 ==');

// ⑰① 「局面和上面的按键为同一个背景板块」
{
  // 做法：把「重新识别/分析/深算」那一排与底栏包进**同一个** #__gb_bottombar（sticky 钉在
  //   滚动区底部），容器自己**不上色**，直接透出面板那一层 rgba —— 于是整块与面板同底色、
  //   同透明度，观感就是一块板。★ 旧写法（给底栏单独加 backdrop-filter 模糊 + 上沿 inset
  //   分隔线）恰好把「局面」做成浮在面板上的一块小板子，用户看到的就是两个板块。
  ok('★ 抽取器把「三键行 + 底栏」包进同一个 #__gb_bottombar 容器（barStart/BAR_OPEN/BAR_CLOSE）',
    /const BAR_OPEN =/.test(EXTRACT) && /const BAR_CLOSE = '<\/div>';/.test(EXTRACT) &&
    /const barStart = htmlOut\.lastIndexOf\('<div', iDeep\);/.test(EXTRACT) &&
    /htmlOut\.slice\(0, barStart\) \+ BAR_OPEN \+ htmlOut\.slice\(barStart\)/.test(EXTRACT) &&
    // 结构自检：两行必须真在同一个容器里（中间不许有别的兄弟节点），否则「同一个板块」是空话
    /三键行与「局面」不在同一个 #__gb_bottombar 里/.test(EXTRACT) &&
    /缺 <\/div><\/div>/.test(EXTRACT));
  ok('★ 容器与底栏自己都**不上色**（background:transparent —— 透出面板同一层，才是一块板）',
    /#__gb_bottombar\{background:transparent;/.test(PANEL) &&
    /#__gb_footbar\{background:transparent;/.test(PANEL) &&
    // 分隔线只留一条、画在整块的上沿（两行之间不许有线）
    /#__gb_bottombar\{background:transparent;box-shadow:inset 0 1px 0/.test(PANEL));
  ok('★ 旧写法（底栏单独做毛玻璃 backdrop-filter）已绝迹 —— 那正是「两个板块」的元凶',
    !/backdrop-filter/.test(PANEL));
  ok('产物里三键行与底栏真的同属一个容器（DOM 顺序：#__gb_rec < #__gb_pos 且在容器内）',
    PANEL.indexOf('id="__gb_bottombar"') >= 0 &&
    PANEL.indexOf('id="__gb_rec"') > PANEL.indexOf('id="__gb_bottombar"') &&
    PANEL.indexOf('id="__gb_pos"') > PANEL.indexOf('id="__gb_rec"') &&
    (PANEL.match(/id="__gb_bottombar"/g) || []).length === 1 &&
    // 容器内**只**出现两行按钮：底栏不许再把「复盘」加回来
    !/id="__gb_review"/.test(PANEL));
}

// ⑰② 「在局面的右面添加一个保存局面这个按键，保存渲染出来的棋盘 png」
{
  ok('★ 「保存局面」键排在「局面」右边（同一个 #__gb_footbar 里，DOM 顺序在后）',
    PANEL.indexOf('id="__gb_possave"') > PANEL.indexOf('id="__gb_pos"') &&
    /id="__gb_footbar"/.test(PANEL) &&
    /'<button id="__gb_possave"/.test(EXTRACT));
  ok('★ 页面只报一声 savePosPng（WebView2 里没有文件系统，渲染+写盘都在宿主）',
    /__gb_possave: function \(\) \{ tellHost\(\{ type: 'savePosPng' \}\); \}/.test(BRIDGE_CODE) &&
    // 宿主那侧是 C++ 窄字符串里的转义引号，所以正则必须写成 \\"…\\" 的形状
    /\\"type\\":\\"savePosPng\\"/.test(HOST) &&
    /static void PosSavePng\(\)/.test(HOST));
  ok('★ 宿主导出用的是**同一份**棋盘绘制（DrawPosBoardCard），不是另画一套',
    /static bool RenderPositionPng[\s\S]{0,1400}?DrawPosBoardCard\(g, g_uiDark\)/.test(HOST_CODE));
  ok('★ 覆盖层补上了 PNG 编码能力（此前只有 GDI+ 绘制，没有任何编码器）',
    /static bool GetEncoderClsid\(const wchar_t\* mime, CLSID\* out\)/.test(HOST) &&
    /GetImageEncodersSize/.test(HOST) && /GetImageEncoders\(num, size, info\)/.test(HOST) &&
    /GetEncoderClsid\(L"image\/png", &png\)/.test(HOST) &&
    /bmp\.Save\(path\.c_str\(\), &png, nullptr\)/.test(HOST));
  ok('★ 导出成品固定 800×800（用户 2026-09-19：分辨率应为 800*800），且是等比缩放 + 居中',
    /static const int kPosPngSize = 800;/.test(HOST) &&
    /const int W = kPosPngSize, H = kPosPngSize;/.test(HOST) &&
    // 比例由「长边铺满 800」反推，而不是把画面拉成方的
    /const double sc = \(double\)kPosPngSize \/ \(double\)\(cw > ch \? cw : ch\);/.test(HOST) &&
    // 胶片尺寸（卡片 + 上下各一圈外边距）与居中留白
    /const int ch = POS_CARD_H \+ POS_PAD \* 2;/.test(HOST) &&
    /const double ox = \(\(double\)kPosPngSize - cw \* sc\) \/ 2\.0;/.test(HOST) &&
    /const double oy = \(\(double\)kPosPngSize - ch \* sc\) \/ 2\.0;/.test(HOST) &&
    // 旧的「按比例放大」写法（kPosPngScale）不许回来：它给不出 800×800
    !/kPosPngScale/.test(HOST_CODE) &&
    // 底色填白（窗口里圆角外沿是透明的，图片上留白比留透明更通用）
    /g\.Clear\(Gdiplus::Color\(255, 255, 255, 255\)\);/.test(HOST));
  ok('★ 导出时临时改比例，**无论成败都还原** g_posScale（否则窗口版式被带歪）',
    /const double saved = g_posScale;/.test(HOST) && /g_posScale = sc;/.test(HOST) &&
    /g_posScale = saved;/.test(HOST));
  ok('★ 弹系统「另存为」（用户自己挑路径），默认名带时间戳、默认落桌面',
    /GetSaveFileNameW\(&ofn\)/.test(HOST) &&
    /gomoku-board-%04d%02d%02d-%02d%02d%02d\.png/.test(HOST) &&
    /CSIDL_DESKTOPDIRECTORY/.test(HOST) &&
    /OFN_OVERWRITEPROMPT \| OFN_PATHMUSTEXIST \| OFN_NOCHANGEDIR/.test(HOST));
  ok('★ 没识别到棋盘就拒绝导出（不做「存一张空盘」这种让人困惑的事）',
    /if \(!g_posHasBoard\) \{[\s\S]{0,240}?save png skipped: no board recognized yet/.test(HOST) &&
    /\\"reason\\":\\"noboard\\"/.test(HOST));
  ok('★ 三种结局都要回执（成功带路径 / 用户取消 / 失败），页面据此给一句话反馈',
    /PostToPanel\("\{\\"type\\":\\"posSave\\",\\"ok\\":true,\\"path\\":\\"" \+ EscapeJson/.test(HOST) &&
    /\\"ok\\":false,\\"reason\\":\\"cancel\\"/.test(HOST) &&
    /\\"ok\\":false,\\"reason\\":\\"" \+ EscapeJson\(err\)/.test(HOST) &&
    /msg\.type === 'posSave'/.test(BRIDGE_CODE) &&
    /Save failed: /.test(BRIDGE_CODE));
  ok('★ 回执里的 Windows 路径做了 JSON 转义（反斜杠不转义，页面 JSON.parse 直接失败）',
    /static std::string EscapeJson\(const std::string& in\)/.test(HOST) &&
    /if \(c == '\\\\'\) \{ o \+= '\\\\'; o \+= '\\\\'; \}/.test(HOST));
  ok('★ 导出有端到端测试出口（GB_TEST_SAVE_POS_PNG 给路径 + 自动存一次，不弹对话框）',
    /GetEnvironmentVariableA\("GB_TEST_SAVE_POS_PNG"/.test(HOST) &&
    /auto-saving board png \(GB_TEST_SAVE_POS_PNG\)/.test(HOST));
  ok('「保存局面」的文案跟着中英切换（写死中文会在英文界面露馅）',
    /var sb = document\.getElementById\('__gb_possave'\)/.test(BRIDGE_CODE) &&
    /'Save board'/.test(BRIDGE_CODE));
  ok('「保存局面」配色只由样式表给（浅/深两套、覆盖 hover；行内一个颜色都不留）',
    /#__gb_possave\{background:#fff!important;color:#2e7d32!important;/.test(PANEL) &&
    /#__gb_possave:hover\{background:#f2f9f3!important/.test(PANEL) &&
    /\[data-dark="1"\] #__gb_possave\{background:#232a3a!important;color:#9bd6a2!important;/.test(PANEL) &&
    /\[data-dark="1"\] #__gb_possave:hover\{background:#2b3346!important\}/.test(PANEL) &&
    !/id="__gb_possave"[^>]*style="[^"]*(background|color)\s*:/.test(PANEL));
}

// ⑰③ 「可以进行这个窗口的长度的调节，最矮不要没过哈希表，最长就是全部功能都展示，
//      长度短就可以进行鼠标滚动」
{
  ok('★ 页面底部有高度拖拽条 #__gb_grip，且是 #__gb_panel 的**最后一个子元素**（在滚动区之外）',
    /<div id="__gb_panel" style="\$\{escAttr\(desktopCss\)\}">\$\{htmlOut\}<div id="__gb_grip"/.test(EXTRACT) &&
    /id="__gb_grip" title="/.test(PANEL) &&
    /'#__gb_grip\{flex:0 0 auto;height:8px;cursor:ns-resize;pointer-events:auto;'/.test(EXTRACT) &&
    /#__gb_grip\{flex:0 0 auto;height:8px;cursor:ns-resize;pointer-events:auto;/.test(PANEL));
  ok('★ 按下拖拽条只「报一声」，改高由宿主接手（与标题栏拖动同一堵墙：父窗口收不到 WM_NCHITTEST）',
    /gripEl\.addEventListener\('mousedown'/.test(BRIDGE_CODE) &&
    /tellHost\(\{ type: 'panelResizeStart' \}\)/.test(BRIDGE_CODE) &&
    /\\"type\\":\\"panelResizeStart\\"/.test(HOST) &&
    /page reported height-drag start -> running resize loop/.test(HOST) &&
    /static void PanelResizeLoop\(\)/.test(HOST));
  ok('★ 拖动期间**冻结窗口顶边**、只让底边跟手走（往下拖 = 变长，唯一符合直觉的映射）',
    /int h = h0 \+ \(c\.y - y0\);/.test(HOST) &&
    /SetWindowPos\(g_panel, HWND_TOPMOST, wr\.left, wr\.top, w, h, SWP_NOACTIVATE\)/.test(HOST) &&
    /g_panelDragging = true;/.test(HOST));
  ok('★ 「最矮不要没过哈希表」：下界由页面实测的 hMin（到哈希表那一行为止 + 常驻底栏 + 拖拽条）',
    /var hNat = 0, hMin = 0;/.test(BRIDGE_CODE) &&
    /hashLbl\.closest\('\.__gb_row'\)/.test(BRIDGE_CODE) &&
    /hMin = hdrPx \+ hashRow\.offsetTop \+ hashRow\.offsetHeight \+ barPx \+ gripPx;/.test(BRIDGE_CODE) &&
    /hMin: Math\.round\(hMin\)/.test(BRIDGE_CODE) &&
    /size_t mnp = w\.find\(L"\\"hMin\\":"\);/.test(HOST) &&
    /g_panelMinH = \(int\)llround\(mv \* pd\);/.test(HOST));
  ok('★ 「最长 = 全部功能都展示」：上界 = 内容自然高（body.scrollHeight），绝不用面板自身 rect.height',
    /var bodyEl = document\.getElementById\('__gb_body'\)/.test(BRIDGE_CODE) &&
    /hNat = hdrPx \+ bodyEl\.scrollHeight \+ gripPx;/.test(BRIDGE_CODE) &&
    /g_panelNatCss = nv;/.test(HOST) &&
    // ★ 自指陷阱：面板改成 height:100% 之后 rect.height ≡ 窗口高，拿它当内容高就再也拉不回来
    /g_panelNatCss >= 160\.0/.test(HOST) &&
    /#__gb_panel\{height:100%;\}/.test(PANEL) && !/max-height:100vh/.test(PANEL));
  ok('★ 高度夹在 [最矮, 最长] 之间（拖太矮不越过哈希表，拖太长不超出内容自然高）',
    /int minH = \(g_panelMinH > 0\)/.test(HOST) &&
    /int maxH = \(g_panelNatH > 0\)/.test(HOST) &&
    /if \(h < minH\) h = minH;/.test(HOST) && /if \(h > maxH\) h = maxH;/.test(HOST) &&
    /height drag start: h0=%d min=%d max=%d/.test(HOST) &&
    /height drag end: h=%d \(clamped to \[%d,%d\], saved\)/.test(HOST));
  ok('★ 改高时**同时**刷分层窗口命中表面 + 重排 WebView（否则多出来的那一段「能画不能点」）',
    /static void PanelResizeLoop[\s\S]{0,2400}?RefreshPanelHitSurface\(\);/.test(HOST) &&
    /static void PanelResizeLoop[\s\S]{0,2400}?LayoutWebView\(\);/.test(HOST) &&
    /static void RefreshPanelHitSurface\(\)/.test(HOST));
  ok('★ 松手后重新对齐 + 落盘（下次启动仍是用户摆的那个高度）',
    /g_panelUserH = \(lastH > 0\) \? lastH : h0;/.test(HOST) &&
    /g_panelApplied = RECT\{0, 0, 0, 0\};/.test(HOST) &&
    /OnPanelDragEnd\(\);/.test(HOST) &&
    /fprintf\(f, "%d %d %d\\n", g_panelOffX, g_panelOffY, g_panelUserH\);/.test(HOST));
  ok('★ 位置存档第三个字段 = 用户拖出来的高度；两字段的老存档照样读得回来（兼容）',
    /int got = fscanf\(f, "%d %d %d", &x, &y, &uh\);/.test(HOST) &&
    /if \(got >= 2\) \{/.test(HOST) &&
    /if \(got >= 3 && uh >= 60 && uh <= 8000\) g_panelUserH = uh;/.test(HOST));
  ok('★ 用户拖过高度就听用户的（夹在 [最矮, 最长] 内），没拖过才跟着内容自动',
    // ★ 2026-09-25（用户要求「默认就是最长的状态」）：启动**首帧**不套用存档高度，
    //   所以网关条件多了一个 g_panelBootHeightDone（首帧为 false → 走 else → 丢弃存档高）。
    /if \(g_panelUserH > 0 && g_panelBootHeightDone\) \{/.test(HOST) &&
    /if \(g_panelUserH < mn\) g_panelUserH = mn;/.test(HOST) &&
    /if \(g_panelUserH > h\) g_panelUserH = h;/.test(HOST) &&
    // ⚠ 必须排在「自然高」赋值之后，否则拖矮一次就再也回不到「全部功能都展示」
    /g_panelNatH = h;[\s\S]{0,600}?if \(g_panelUserH > 0 && g_panelBootHeightDone\) \{/.test(HOST));
  ok('★ 「长度短就可以进行鼠标滚动」：滚动交给 #__gb_body（面板自己 flex 撑满窗口）',
    /#__gb_body\{overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;\}/.test(PANEL));
  ok('★ 兜底上限刻意写得比宿主松（avail+240，不再是 avail-96）—— 它不该反过来压住窗口',
    /Math\.max\(240, Math\.round\(avail \+ 240\)\)/.test(BRIDGE_CODE) &&
    !/availHeight - 96/.test(BRIDGE_CODE));
}

// ⑰④ 「这两个功能键应该小一点，高度和上面的三个按钮一样」
{
  // 上排三键的盒子是 padding:5px 0 + 1px 边框 + **继承来的**字号；底栏两键只写盒子参数，
  // 高度自然相等。旧写法（min-height:34px + align-items:stretch + font-size:11px）正是
  // 「底栏两键比上排高一截、字体还小一号」的原因。
  // ★ 这里**禁止**再出现 font-size —— 踩过：想「和面板一致」写死 12px，而上排实际是
  //   13.3333px，于是底栏 29px / 上排 31px，用户要的「一样高」差 2px
  //   （被 tools/test-openpos-click.js 的真实 DOM 测量当场抓住）。
  ok('★ 底栏两键与上排三键同一套盒子（只给 padding/圆角，字号一律继承 → 高度严格相等）',
    /#__gb_footbar>button\{flex:1;padding:5px 0;border-radius:6px;cursor:pointer;/.test(PANEL) &&
    !/#__gb_footbar>button\{[^}]*font-size/.test(PANEL) &&
    !/#__gb_footbar>button\{[^}]*font-weight/.test(PANEL) &&
    !/#__gb_footbar>button\{[^}]*min-height/.test(PANEL) &&
    /id="__gb_rec"[^>]*padding:5px 0;border:1px solid #ddd;border-radius:6px;/.test(PANEL) &&
    /id="__gb_analyze"[^>]*padding:5px 0;border:1px solid #ddd;border-radius:6px;/.test(PANEL));
  ok('★ 旧写法已绝迹（min-height:34px / 底栏 align-items:stretch / 11px 字号）',
    !/min-height:34/.test(PANEL) && !/#__gb_footbar[^}]*align-items/.test(PANEL) &&
    !/#__gb_footbar>button\{[^}]*font-size:11px/.test(PANEL));
  ok('底栏两键仍是 flex:1 平分宽度（用户要的是「小一点」，不是「窄一条」）',
    /id="__gb_pos" title="[^"]*" style="flex:1;cursor:pointer;"/.test(PANEL) &&
    /id="__gb_possave" title="[^"]*" style="flex:1;cursor:pointer;"/.test(PANEL) &&
    /#__gb_footbar>button\{flex:1;/.test(PANEL));
}

// ---------------------------------------------------------------- ⑱ C 轮：换台电脑能装能跑
// 用户 2026-09-19：「增强稳定性，桌面端的识别助手，除了我的电脑可以顺利识别复杂的网站和应用，
//   别人的电脑同样也可以，支持 Windows 10 以上电脑」。
// 排查结论（tools/_audit_c.txt）：静态 CRT（不依赖 VCRedist）/ 单文件 EXE / 无 AVX2 /
//   DPI 感知动态加载 —— 这些「能装能跑」的前提本来就成立；缺的是**可诊断性**下两块：
//   ① 环境自检（这台机器到底满足不满足）；② 依赖服务由活变死时有没有留痕。
//   「识别更抗环境」（BitBlt 黑屏自检 + 回退抓帧）尚未落地 —— 见文件末尾的备注。
console.log('== ⑱ 环境自检（换台电脑的第一现场）+ 服务自愈留痕 ==');
ok('★ 启动即环境自检，且 OS 版本用 RtlGetVersion（GetVersionEx 会被 manifest 谎报）',
  /static void LogEnvSelfCheck\(\)/.test(HOST) &&
  /LogEnvSelfCheck\(\);/.test(HOST_CODE) &&
  /GetProcAddress\(nt, "RtlGetVersion"\)/.test(HOST));
ok('★ 自检报 Win10 基线（build 17763 / 1809）并明确说出「低于基线」与架构',
  /win10plus = \(vi\.major > 10\) \|\| \(vi\.major == 10 && vi\.build >= 17763\)/.test(HOST) &&
  /\[env\] OS %s  arch=%s  %s  \(baseline: Windows 10 build 17763 \/ 1809\)/.test(HOST) &&
  /BELOW BASELINE - some features may fail/.test(HOST) &&
  /#ifdef _M_X64[\s\S]{0,60}?"x64"/.test(HOST));
ok('★ 自检还报屏幕 / 虚拟屏 / 显示器数 / DPI / 页面 dpr（多屏与缩放问题的唯一现场证据）',
  /\[env\] screen %dx%d  virtual %dx%d@\(%d,%d\)  monitors=%d  dpi=%.3f  pageDpr=%.3f/.test(HOST) &&
  /SM_CMONITORS/.test(HOST) && /SM_XVIRTUALSCREEN/.test(HOST));
ok('★ 自检单独一行报 WebView2 运行时有没有（「别人电脑上面板一片黑」的第一嫌疑）',
  /static bool WebView2RuntimeVersion\(std::wstring& out\)/.test(HOST) &&
  /\[env\] WebView2 runtime: /.test(HOST) &&
  /NOT FOUND \(panel cannot render\)/.test(HOST));
ok('★ 自检报依赖端口状态（引擎 :8964 / 识别 :8971）',
  /\[env\] services: engine :8964 /.test(HOST) &&
  /", recognition :" \+ std::to_string\(ScanPort\(\)\)/.test(HOST));
ok('★ 缺 WebView2 时给一条**可点的**官方下载引导（不再是「你自己去装一下」）',
  /MB_ICONWARNING \| MB_TOPMOST \| MB_YESNO/.test(HOST) &&
  /if \(r == IDYES\) \{/.test(HOST) &&
  /https:\/\/go\.microsoft\.com\/fwlink\/p\/\?LinkId=2124703/.test(HOST) &&
  /ShellExecuteW\(nullptr, L"open"/.test(HOST) &&
  // 其它功能不受影响这句必须说清楚，否则用户以为整个程序废了
  /u5176\\u4f59\\u529f\\u80fd\\u4e0d\\u53d7\\u5f71\\u54cd/.test(HOST));
ok('★ 依赖服务「由活变死」会留一行带序号的日志（旧版只有第一次那句 reusing it，之后全瞎）',
  // 引擎与识别服务各一套（两个函数各有一个 seenAlive/restarts）
  (HOST.match(/static std::atomic<int> seenAlive\(0\);/g) || []).length === 2 &&
  (HOST.match(/if \(seenAlive\.exchange\(0\) == 1\) \{/g) || []).length === 2 &&
  /\[deps\] engine :8964 went down -> restarting it \(restart #/.test(HOST) &&
  /went down -> restarting it \(restart #/.test(HOST) &&
  (HOST.match(/restarts\.fetch_add\(1\);/g) || []).length >= 2 &&
  // 「活着」只报一次，别把巡检线程刷爆
  /static std::atomic<bool> told\(false\);/.test(HOST) &&
  /if \(!told\.exchange\(true\)\) LogMsg/.test(HOST));
// ---------------------------------------------------------------------------
// ★ 2026-09-25（用户四条要求）：控制台后台 / 默认开局面小窗 / 面板高度默认最长 / 关手动调整即恢复自动
//   四条全是「启动瞬间或某个动作之后**屏幕上看得见**的行为」，本机看不到屏幕 ⇒ 继续用源码契约钉死。
// ---------------------------------------------------------------------------
ok('★ 用户要求①：黑色日志控制台放到后台（自己开的那个一建就藏；用户终端的控制台绝不藏）',
  // 「自己 AllocConsole 出来的」才藏 —— 从终端启动时 AttachConsole 拿到的是**用户的**控制台
  /bool ownConsole = false;/.test(HOST_CODE) &&
  /else if \(AllocConsole\(\)\) \{[\s\S]{0,120}?ownConsole = true;/.test(HOST_CODE) &&
  /if \(ownConsole && !ShowConsoleRequested\(\)\) \{[\s\S]{0,120}?ShowWindow\(cw, SW_HIDE\);/.test(HOST_CODE) &&
  /static bool ShowConsoleRequested\(\) \{/.test(HOST_CODE) &&
  /GB_SHOW_CONSOLE/.test(HOST_CODE));
ok('★ 用户要求②：默认展示「局面」小弹窗（启动即开，且页面一就绪就补推 posState 让「局面」键高亮对得上）',
  /if \(!suppress && !UnderTestEnv\(\) && !g_posWnd\) \{[\s\S]{0,200}?OpenPositionWindow\(\);/.test(HOST_CODE) &&
  /static bool UnderTestEnv\(\) \{/.test(HOST_CODE) &&
  /wcsncmp\(p, L"GB_TEST_", 8\)/.test(HOST_CODE) &&               // 自动化环境保持旧行为
  /GB_NO_POS_WINDOW/.test(HOST_CODE) &&                            // 显式退路
  // 页面就绪后补推一次 posState（否则启动那一帧推的消息在页面加载前就丢了）
  /static bool toldPosState = false;[\s\S]{0,80}?NotifyPositionState\(\)/.test(HOST_CODE));
ok('★ 用户要求③：面板高度默认 = 最长（启动首帧钉在自然高，不套用上次拖出的矮高度 → 不顶滚动条）',
  /static bool g_panelBootHeightDone = false;/.test(HOST_CODE) &&
  /if \(g_panelUserH > 0 && g_panelBootHeightDone\) \{/.test(HOST_CODE) &&
  /if \(!g_panelBootHeightDone\) \{[\s\S]{0,160}?g_panelUserH = 0;/.test(HOST_CODE) &&
  /boot height = natural \(full content, no scrollbar\)/.test(HOST_CODE) &&
  // 自然高那条链路本身不许被删（页面报 hNat → 宿主钉窗口高）
  /g_panelNatCss/.test(HOST_CODE) && /if \(cssH >= 160\.0 && cssH <= cssMax\) h = \(int\)llround\(cssH \* dprH\);/.test(HOST_CODE));
ok('★ 用户要求④：关闭「手动调整」= 解锁识别区，恢复自动识别棋盘（旧行为是「区域保留」）',
  /static void CloseSelectWindow\(\) \{[\s\S]{0,2500}?g_scanRegion = RECT\{0, 0, 0, 0\};/.test(HOST_CODE) &&
  /manual region cleared -> full-screen auto board detection restored/.test(HOST_CODE) &&
  /PostToPanel\("\{\\"type\\":\\"region\\",\\"set\\":false\}"\)/.test(HOST_CODE) &&
  // 框内「关闭」键与 ESC 都走同一个出口
  /if \(wp == VK_ESCAPE\) \{ CloseSelectWindow\(\); return 0; \}/.test(HOST_CODE) &&
  // 页面侧早就有 set:false 分支（清区域 → 文案「Scan region cleared — full screen」）
  /scanRegionCleared|Scan region cleared/.test(BRIDGE));

ok('★ 拉起被限流（ClaimSpawnSlot）—— 死循环重启会把用户电脑拖垮',
  /static bool ClaimSpawnSlot\(std::atomic<unsigned long long>& slot\)/.test(HOST) &&
  /g_engineSpawnedAt/.test(HOST) && /g_scanSpawnedAt/.test(HOST));

console.log('\n== test-guide-layer: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
