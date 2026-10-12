#!/usr/bin/env node
/* 一次性补丁：desktop-overlay/src/host.cpp
 * 覆盖 B2（保存局面 PNG）/ B3（面板高度可调）/ B4（坐标离棋盘远一点）
 *      + C1（换台电脑能装能跑：环境自检 + WebView2 引导）/ C3（服务自愈可诊断）。
 * 手法：find + 唯一性断言 → 一次落盘（不要并行 Edit 同一个文件）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, '..', 'desktop-overlay', 'src', 'host.cpp');
let s = fs.readFileSync(F, 'utf8');
const before = s.length;
let n = 0;
function rep(oldStr, newStr, label) {
  const i = s.indexOf(oldStr);
  if (i < 0) throw new Error('找不到锚点：' + label);
  if (s.indexOf(oldStr, i + 1) >= 0) throw new Error('锚点不唯一：' + label);
  s = s.slice(0, i) + newStr + s.slice(i + oldStr.length);
  n++;
}

/* ---------------------------------------------------------------- B4 坐标缝 */
rep(
'#define POS_COORD_W   13                      // 左右坐标栏宽（写 1..15）\n' +
'#define POS_COORD_H   14                      // 坐标字号占高（写 A..O）\n' +
'#define POS_CARD_PX    4                      // 卡片左右内衬（比坐标栏还窄：整体边距收紧）\n' +
'#define POS_CARD_PT   (POS_COORD_H / 2 + 1)   // 卡片上内衬 (8)：顶行行号半个字高要落在卡片里\n' +
'#define POS_CARD_PB   (POS_COORD_H + 2)       // 卡片下内衬 (16)：列号那一行要完整落在卡片里\n' +
'#define POS_CARD_W    (POS_GRID + POS_COORD_W * 2 + POS_CARD_PX * 2)   // 244\n' +
'#define POS_CARD_H    (POS_CARD_PT + POS_GRID + POS_CARD_PB)           // 234（比宽矮：没有上坐标栏）\n',

'#define POS_COORD_W   13                      // 左右坐标栏宽（写 1..15）\n' +
'#define POS_COORD_H   14                      // 坐标字号占高（写 A..O）\n' +
'// ★ 2026-09-19（用户）：「棋盘上的坐标字母和数字要距离棋盘稍微远一点，因为有的子落到棋盘\n' +
'//   边缘会没过数字和字母」。棋子直径 = POS_CELL - 4 = 11 设计单位 ⇒ 半径 5.5，所以「标注与\n' +
'//   棋盘线之间的缝」必须 **大于 5.5** 才能让最边上那一路的子完全不压住标注 —— 原来是 2，\n' +
'//   边缘子会盖住标注 3.5 个设计单位（现场就是「数字被黑子淹了」）。取 6，留 0.5 的余量。\n' +
'//   ⚠ 缝变大后**下方**那一行列号也要跟着下移，所以 POS_CARD_PB 必须跟着 COORD_GAP 一起长；\n' +
'//     左右两栏不用动卡片宽 —— 标注矩形仍是整栏宽、靠 Far/Near 对齐，缝只是把它往卡片内衬\n' +
'//     里挪一点，不会溢出（内衬 4 + 栏宽 13 = 17 ≥ 缝 6 + 两位数宽度 9）。\n' +
'#define POS_COORD_GAP   6                     // 坐标字与棋盘线之间的缝（设计单位）\n' +
'#define POS_CARD_PX    4                      // 卡片左右内衬（比坐标栏还窄：整体边距收紧）\n' +
'#define POS_CARD_PT   (POS_COORD_H / 2 + 1)   // 卡片上内衬 (8)：顶行行号半个字高要落在卡片里\n' +
'#define POS_CARD_PB   (POS_COORD_H + POS_COORD_GAP + 2)   // 卡片下内衬 (22)：缝 + 列号那一行\n' +
'#define POS_CARD_W    (POS_GRID + POS_COORD_W * 2 + POS_CARD_PX * 2)   // 244\n' +
'#define POS_CARD_H    (POS_CARD_PT + POS_GRID + POS_CARD_PB)           // 240（比宽矮：没有上坐标栏）\n',
'POS 宏块');

rep(
'#define POS_CODE_Y    (POS_BY + POS_CARD_H + POS_GAP)          // 代码卡片 y (280)\n' +
'#define POS_BTN_Y     (POS_CODE_Y + POS_CODE_H + POS_GAP)      // 按钮行 y (372)\n' +
'#define POS_H         (POS_BTN_Y + POS_BTN_H + POS_PAD)        // 410\n',
'#define POS_CODE_Y    (POS_BY + POS_CARD_H + POS_GAP)          // 代码卡片 y (286)\n' +
'#define POS_BTN_Y     (POS_CODE_Y + POS_CODE_H + POS_GAP)      // 按钮行 y (378)\n' +
'#define POS_H         (POS_BTN_Y + POS_BTN_H + POS_PAD)        // 416\n',
'POS 派生 y 注释');

rep(
'        const Gdiplus::REAL lw = PXF(POS_COORD_W), lh = PXF(POS_COORD_H);\n' +
'        const Gdiplus::REAL gap = PXF(2);                        // 与棋盘线之间的缝\n',
'        const Gdiplus::REAL lw = PXF(POS_COORD_W), lh = PXF(POS_COORD_H);\n' +
'        // ★ 2026-09-19（用户）：「坐标字母和数字要距离棋盘稍微远一点，因为有的子落到棋盘\n' +
'        //   边缘会没过数字和字母」。缝必须 > 棋子半径（(POS_CELL-4)/2 = 5.5），见 POS_COORD_GAP。\n' +
'        const Gdiplus::REAL gap = PXF(POS_COORD_GAP);            // 与棋盘线之间的缝\n',
'PaintPosition gap');

/* ---------------------------------------------------------------- 面板高度状态量 */
rep(
'static int g_panelHdrH = 34;\n',
'static int g_panelHdrH = 34;\n' +
'// ★ 2026-09-19（B3）：面板高度可手动调节（用户：「可以进行这个窗口的长度的调节，最矮不要\n' +
'//   没过哈希表，最长就是全部功能都展示，长度短就可以进行鼠标滚动」）。\n' +
'//   · g_panelUserH  —— 用户拖出来的高度（物理像素；0 = 没拖过，跟着内容自动）\n' +
'//   · g_panelMinH   —— 最矮：标题栏 + 到「哈希表」那一行为止（物理像素；0 = 页面还没上报）\n' +
'//   · g_panelNatH   —— 最长：全部功能都展示时的自然高（物理像素；0 = 还没算出来）\n' +
'//   · g_panelNatCss —— 页面自报的内容自然高（CSS 像素）。**必须**单独上报：面板现在是\n' +
'//     height:100%，getBoundingClientRect().height 已经变成「视口=窗口」的自指值，\n' +
'//     拿它当内容高就再也回不到「全部功能都展示」。\n' +
'static int g_panelUserH = 0;\n' +
'static int g_panelMinH = 0;\n' +
'static int g_panelNatH = 0;\n' +
'static double g_panelNatCss = 0.0;\n',
'面板高度状态量');

/* ---------------------------------------------------------------- 前向声明 */
rep(
'static void ReportUiLook();                        // 把当前外观推给「局面」窗\n',
'static void ReportUiLook();                        // 把当前外观推给「局面」窗\n' +
'static void PosSavePng();                          // 「保存局面」：把识别到的棋盘导出 PNG（B2）\n',
'PosSavePng 前向声明');

/* ---------------------------------------------------------------- B2/B3 页面消息分支 */
rep(
'      // 页面报告标题栏被按下 → 转给面板窗口发起系统原生拖动（见 PanelProc 的 WM_APP+11）。\n' +
'      if (w.find(L"\\"type\\":\\"dragStart\\"") != std::wstring::npos) {\n' +
'        LogMsg("[panel] page reported drag start -> handing off to native move loop");\n' +
'        if (g_panel) PostMessageW(g_panel, WM_APP + 11, 0, 0);\n' +
'        return S_OK;\n' +
'      }\n',

'      // 页面报告标题栏被按下 → 转给面板窗口发起系统原生拖动（见 PanelProc 的 WM_APP+11）。\n' +
'      if (w.find(L"\\"type\\":\\"dragStart\\"") != std::wstring::npos) {\n' +
'        LogMsg("[panel] page reported drag start -> handing off to native move loop");\n' +
'        if (g_panel) PostMessageW(g_panel, WM_APP + 11, 0, 0);\n' +
'        return S_OK;\n' +
'      }\n' +
'      // ★ B3：页面报告「底部拖拽条被按下」→ 宿主跑一段改高的模态循环。\n' +
'      //   为什么不由宿主自己判 HTBOTTOM：见 PanelResizeLoop 的注释（同一堵墙：客户区被\n' +
'      //   WebView2 的子窗口盖住，父窗口收不到 WM_NCHITTEST）。\n' +
'      if (w.find(L"\\"type\\":\\"panelResizeStart\\"") != std::wstring::npos) {\n' +
'        LogMsg("[panel] page reported height-drag start -> running resize loop");\n' +
'        PanelResizeLoop();\n' +
'        return S_OK;\n' +
'      }\n' +
'      // ★ B2：底栏「保存局面」→ 把识别到的棋盘渲染成 PNG，弹系统「另存为」写盘。\n' +
'      //   页面只会「报一声」（WebView2 里既没有路径也没有文件系统），真正的渲染与写盘在宿主。\n' +
'      if (w.find(L"\\"type\\":\\"savePosPng\\"") != std::wstring::npos) {\n' +
'        LogMsg("[ui] panel requested board PNG export (savePosPng)");\n' +
'        PosSavePng();\n' +
'        return S_OK;\n' +
'      }\n',
'dragStart 相邻分支');

/* ---------------------------------------------------------------- B3 上报解析 */
rep(
'        if (v[0] > 20 && v[1] > 20) {\n' +
'          g_panelCss.left = 0;\n',
'        // ★ B3：页面**另外**实测的两个高度（见 g_panelNatCss 的说明）。\n' +
'        //   hMin = 标题栏 + 到「哈希表」那一行为止 → 用户要的「最矮不要没过哈希表」；\n' +
'        //   hNat = 全部功能都展示时的自然高 → 用户要的「最长就是全部功能都展示」。\n' +
'        //   两者都以 CSS 像素上报，这里按页面自报的 dpr 换成窗口物理像素。\n' +
'        size_t mnp = w.find(L"\\"hMin\\":");\n' +
'        if (mnp != std::wstring::npos) {\n' +
'          double mv = _wtof(w.c_str() + mnp + 7);\n' +
'          if (mv >= 40 && mv <= 4000) {\n' +
'            double pd = (g_pageDpr > 0.3 && g_pageDpr < 8.0) ? g_pageDpr : 1.0;\n' +
'            g_panelMinH = (int)llround(mv * pd);\n' +
'          }\n' +
'        }\n' +
'        size_t ntp = w.find(L"\\"hNat\\":");\n' +
'        if (ntp != std::wstring::npos) {\n' +
'          double nv = _wtof(w.c_str() + ntp + 7);\n' +
'          if (nv >= 120 && nv <= 8000) g_panelNatCss = nv;\n' +
'        }\n' +
'        if (v[0] > 20 && v[1] > 20) {\n' +
'          g_panelCss.left = 0;\n',
'panelRect 解析');

/* ---------------------------------------------------------------- B3 ApplyPanelRect */
rep(
'    double cssH = (double)(g_panelCss.bottom - g_panelCss.top);\n' +
'    double cssMax = (double)GetSystemMetrics(SM_CYSCREEN) / dprH - 16.0;\n' +
'    if (cssH >= 160.0 && cssH <= cssMax) h = (int)llround(cssH * dprH);\n',

'    // ★ B3：面板现在是 height:100%（见 extract-panel-ui.js 的 desktopExtraCss），\n' +
'    //   于是页面的 getBoundingClientRect().height = 视口高 = 窗口高 —— **自指**。\n' +
'    //   拿它当内容高，窗口就被锁在当前位置、再也回不到「全部功能都展示」。\n' +
'    //   所以优先用页面单独实测并上报的内容自然高 g_panelNatCss（标题栏 + body.scrollHeight）。\n' +
'    double cssH = (g_panelNatCss >= 160.0) ? g_panelNatCss\n' +
'                                           : (double)(g_panelCss.bottom - g_panelCss.top);\n' +
'    double cssMax = (double)GetSystemMetrics(SM_CYSCREEN) / dprH - 16.0;\n' +
'    if (cssH >= 160.0 && cssH <= cssMax) h = (int)llround(cssH * dprH);\n' +
'    // 「最长 = 全部功能都展示」：自然高既是拖动夹取的上限，也是日志里可断言的事实。\n' +
'    g_panelNatH = h;\n' +
'    // 用户手动拖过高度 → 听用户的，夹在 [最矮, 最长] 之间。\n' +
'    //   ⚠ 这段必须排在 g_panelNatH = h 之后：否则「最长」会被用户当前高度顶替掉，\n' +
'    //     拖矮一次之后就再也拉不回来。\n' +
'    if (g_panelUserH > 0) {\n' +
'      int mn = (g_panelMinH > 0) ? g_panelMinH : (int)llround(150 * dprH);\n' +
'      if (mn > h) mn = h;                       // 兜底：最矮不该超过自然高\n' +
'      if (g_panelUserH < mn) g_panelUserH = mn;\n' +
'      if (g_panelUserH > h) g_panelUserH = h;\n' +
'      h = g_panelUserH;\n' +
'    }\n',
'ApplyPanelRect 高度');

/* ---------------------------------------------------------------- B3 高度拖动循环 */
rep(
'// ---------------------------------------------------------------- 依赖服务\n' +
'\n' +
'static void SpawnDetached(const std::wstring& exe, const std::wstring& args, const std::wstring& cwd) {\n',

'/** 面板高度手动调节（底部「拖拽条」，B3）。\n' +
' *\n' +
' *  ★ 用户 2026-09-19：「添加桌面端的五子棋助手可以进行这个窗口的长度的调节，最矮不要没过\n' +
' *    哈希表，最长就是全部功能都展示，长度短就可以进行鼠标滚动」。\n' +
' *\n' +
' *  为什么由页面报一声、宿主跑模态循环（而不是宿主自己判 WM_NCHITTEST 的 HTBOTTOM）：\n' +
' *    面板客户区被 WebView2 的多个子窗口盖着，父窗口**收不到** WM_NCHITTEST；能挂上\n' +
' *    SetWindowSubclass 的只有其中 1 个（实测 4 个只挂上 1 个）—— 这正是「标题栏 HTCAPTION\n' +
' *    永远不生效」的同一堵墙。鼠标事件本来就落在网页上，所以和拖动一样：页面报一声，宿主接管。\n' +
' *\n' +
' *  几何约定：拖动期间**冻结窗口顶边**，让底边跟手走（唯一符合直觉的映射）；松手后按最终\n' +
' *    矩形重算「距右下角偏移」并落盘 —— 于是窗口仍然贴着右下角，下一次 ApplyPanelRect 算出来的\n' +
' *    矩形与当前**完全一致**（y = sh - h - offY = wr.bottom - h = wr.top），不会跳。\n' +
' *  高度夹在 [最矮(到哈希表行为止), 最长(全部功能)] 之间，两个数都由页面实测上报。\n' +
' *  短于内容高时靠 #__gb_body{overflow-y:auto} 滚动 —— 本来就有。*/\n' +
'static void PanelResizeLoop() {\n' +
'  if (!g_panel || !IsWindow(g_panel)) return;\n' +
'  RECT wr;\n' +
'  if (!GetWindowRect(g_panel, &wr)) return;\n' +
'  POINT a = {0, 0};\n' +
'  GetCursorPos(&a);\n' +
'  const int y0 = a.y;\n' +
'  const int h0 = wr.bottom - wr.top;\n' +
'  const int w = wr.right - wr.left;\n' +
'  int minH = (g_panelMinH > 0) ? g_panelMinH : (int)llround(150 * EffectiveDpr());\n' +
'  int maxH = (g_panelNatH > 0) ? g_panelNatH : h0;\n' +
'  if (maxH < minH) maxH = minH;\n' +
'  const int sh = GetSystemMetrics(SM_CYSCREEN);\n' +
'  if (maxH > sh - 8) maxH = sh - 8;\n' +
'  {\n' +
'    char b[192];\n' +
'    snprintf(b, sizeof(b), "[panel] height drag start: h0=%d min=%d max=%d", h0, minH, maxH);\n' +
'    LogMsg(b);\n' +
'  }\n' +
'  g_panelDragging = true;              // 与拖动同理：期间不让 ApplyPanelRect / 置顶定时器来抢\n' +
'  int lastH = h0;\n' +
'  for (;;) {\n' +
'    MSG msg;\n' +
'    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {\n' +
'      if (msg.message == WM_QUIT) { PostQuitMessage((int)msg.wParam); g_panelDragging = false; return; }\n' +
'      TranslateMessage(&msg);\n' +
'      DispatchMessageW(&msg);\n' +
'    }\n' +
'    POINT c = {0, 0};\n' +
'    GetCursorPos(&c);\n' +
'    const bool down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;\n' +
'    int h = h0 + (c.y - y0);\n' +
'    if (h < minH) h = minH;\n' +
'    if (h > maxH) h = maxH;\n' +
'    if (h != lastH) {\n' +
'      lastH = h;\n' +
'      SetWindowPos(g_panel, HWND_TOPMOST, wr.left, wr.top, w, h, SWP_NOACTIVATE);\n' +
'      int rad = FixedPanelSizeEnabled() ? 0 : (int)llround((PANEL_RADIUS_CSS + 1) * EffectiveDpr());\n' +
'      HRGN rgn = MakePanelRegion(w, h, rad);\n' +
'      if (rgn) SetWindowRgn(g_panel, rgn, TRUE);\n' +
'      // ★ 尺寸变了必须刷命中表面：否则多出来的那一段「图能画、点击穿过去」\n' +
'      //   （与 ApplyPanelRect 里同一条根因，见 RefreshPanelHitSurface 的注释）。\n' +
'      RefreshPanelHitSurface();\n' +
'      LayoutWebView();\n' +
'    }\n' +
'    if (!down) break;\n' +
'    Sleep(8);\n' +
'  }\n' +
'  g_panelDragging = false;\n' +
'  g_panelUserH = (lastH > 0) ? lastH : h0;\n' +
'  g_panelApplied = RECT{0, 0, 0, 0};   // 让下一次 ApplyPanelRect 重新对齐（会带上 g_panelUserH）\n' +
'  OnPanelDragEnd();                    // 换算成右下偏移 + 落盘（高度也一起存了）\n' +
'  {\n' +
'    char b[192];\n' +
'    snprintf(b, sizeof(b), "[panel] height drag end: h=%d (clamped to [%d,%d], saved)",\n' +
'             g_panelUserH, minH, maxH);\n' +
'    LogMsg(b);\n' +
'  }\n' +
'}\n' +
'\n' +
'// ---------------------------------------------------------------- 依赖服务\n' +
'\n' +
'static void SpawnDetached(const std::wstring& exe, const std::wstring& args, const std::wstring& cwd) {\n',
'PanelResizeLoop');

/* ---------------------------------------------------------------- B3 存档第三字段 */
rep(
'  int x = 18, y = 18;\n' +
'  if (fscanf(f, "%d %d", &x, &y) == 2) {\n' +
'    if (x > -4000 && x < 4000) g_panelOffX = x;\n' +
'    if (y > -4000 && y < 4000) g_panelOffY = y;\n' +
'  }\n' +
'  fclose(f);\n',
'  int x = 18, y = 18, uh = 0;\n' +
'  // 第三个字段 = 用户手动拖出来的面板高度（0 = 跟着内容自动，见 g_panelUserH）。\n' +
'  // ★ 兼容旧存档：两字段的老文件 fscanf 只返回 2，uh 保持 0 —— 老用户的位置照样读得回来。\n' +
'  int got = fscanf(f, "%d %d %d", &x, &y, &uh);\n' +
'  if (got >= 2) {\n' +
'    if (x > -4000 && x < 4000) g_panelOffX = x;\n' +
'    if (y > -4000 && y < 4000) g_panelOffY = y;\n' +
'  }\n' +
'  if (got >= 3 && uh >= 60 && uh <= 8000) g_panelUserH = uh;\n' +
'  fclose(f);\n',
'LoadPanelPos');

rep(
'  fprintf(f, "%d %d\\n", g_panelOffX, g_panelOffY);\n',
'  fprintf(f, "%d %d %d\\n", g_panelOffX, g_panelOffY, g_panelUserH);\n',
'SavePanelPos');

/* ---------------------------------------------------------------- B2 绘制抽取 + PNG 导出 */
const BMARK_A = '    // ---- 棋盘卡片：极简（细线 + 纯黑/纯白棋子，不做高光渐变）----\n    {\n';
const BMARK_B = '\n    }\n\n    // ---- 局面代码卡片：圆角底 + 自绘等宽多行文本（滚轮可滚）----';
const ia = s.indexOf(BMARK_A);
if (ia < 0) throw new Error('找不到棋盘卡片块起点');
if (s.indexOf(BMARK_A, ia + 1) >= 0) throw new Error('棋盘卡片块起点不唯一');
const ib = s.indexOf(BMARK_B, ia);
if (ib < 0) throw new Error('找不到棋盘卡片块终点');
const innerRaw = s.slice(ia + BMARK_A.length, ib);
const inner = innerRaw.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
s = s.slice(0, ia) +
  '    // ---- 棋盘卡片（网格 + 星位 + 棋子 + 坐标标注 + 未识别提示）----\n' +
  '    //   ★ B2（2026-09-19）：整块抽成 DrawPosBoardCard()，供「保存局面」导出 PNG 时\n' +
  '    //     **逐像素复用**同一份绘制代码 —— 导出的图片与窗口里看到的必然是同一张盘。\n' +
  '    DrawPosBoardCard(g, dk);\n' +
  s.slice(ib + BMARK_B.length);
n++;

// 未被抽走、留在 PaintPosition 里的局部变量（cCard/cGrid 只服务于棋盘块；bSub 同理）
rep(
'    const Gdiplus::Color cBg    = dk ? Gdiplus::Color(255, 28, 31, 38)    : Gdiplus::Color(255, 250, 250, 252);\n' +
'    const Gdiplus::Color cCard  = dk ? Gdiplus::Color(255, 36, 40, 50)    : Gdiplus::Color(255, 255, 255, 255);\n' +
'    const Gdiplus::Color cLine  = dk ? Gdiplus::Color(255, 62, 68, 84)    : Gdiplus::Color(255, 223, 226, 232);\n' +
'    const Gdiplus::Color cGrid  = dk ? Gdiplus::Color(255, 96, 104, 126)  : Gdiplus::Color(255, 176, 184, 198);\n',
'    // 棋盘卡片那套配色（cCard/cGrid）已随绘制一起搬进 DrawPosBoardCard()，这里不再需要。\n' +
'    const Gdiplus::Color cBg    = dk ? Gdiplus::Color(255, 28, 31, 38)    : Gdiplus::Color(255, 250, 250, 252);\n' +
'    const Gdiplus::Color cLine  = dk ? Gdiplus::Color(255, 62, 68, 84)    : Gdiplus::Color(255, 223, 226, 232);\n',
'PaintPosition 去掉未用配色');

rep(
'    Gdiplus::SolidBrush bTitle(cWhite), bText(cText), bSub(cSub);\n',
'    Gdiplus::SolidBrush bTitle(cWhite), bText(cText);   // bSub 随棋盘块搬进 DrawPosBoardCard()\n',
'PaintPosition 去掉未用 bSub');

// 新函数（放在 PaintPosition 之前：渲染 PNG 要用同一份绘制代码）
const Q = String.fromCharCode(39);   // '
const B = String.fromCharCode(92);   // 反斜杠
const NEWFUNS =
'// ---------------------------------------------------------------- 棋盘绘制（窗口与导出 PNG 共用）\n' +
'\n' +
'/** 棋盘卡片：圆角底 + 网格 + 星位 + 棋子 + 三面坐标标注 + 「尚未识别到棋盘」提示。\n' +
' *\n' +
' *  ★ 2026-09-19 从 PaintPosition 里抽出：调用者变成两个 —— 屏幕上的局面小窗，以及\n' +
' *    「保存局面」导出的 PNG（RenderPositionPng）。抽出来的目的是让导出的图片与窗口里看到的\n' +
' *    **同源**：版式改一处两处一起变，不会再出现「窗口里对了、导出图还是旧版式」。\n' +
' *  坐标一律走 PXF/PX（即全局 g_posScale）：导出时把它调大就得到一张放大的清晰图。\n' +
' *  ⚠ 这里刻意不接任何「窗口尺寸」参数：卡片位置仍然由 POS_PAD/POS_BY 决定，\n' +
' *    导出的胶片靠 RenderPositionPng 里的 TranslateTransform 把卡片挪到胶片左上角。*/\n' +
'static void DrawPosBoardCard(Gdiplus::Graphics& g, bool dk) {\n' +
'  const Gdiplus::Color cCard  = dk ? Gdiplus::Color(255, 36, 40, 50)    : Gdiplus::Color(255, 255, 255, 255);\n' +
'  const Gdiplus::Color cLine  = dk ? Gdiplus::Color(255, 62, 68, 84)    : Gdiplus::Color(255, 223, 226, 232);\n' +
'  const Gdiplus::Color cGrid  = dk ? Gdiplus::Color(255, 96, 104, 126)  : Gdiplus::Color(255, 176, 184, 198);\n' +
'  const Gdiplus::Color cSub   = dk ? Gdiplus::Color(255, 150, 158, 175) : Gdiplus::Color(255, 132, 138, 150);\n' +
'  Gdiplus::FontFamily ff(L"Segoe UI");\n' +
'  Gdiplus::Font fBody(&ff, PXF(10.5), Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);\n' +
'  Gdiplus::SolidBrush bSub(cSub);\n' +
'  Gdiplus::StringFormat sfc;\n' +
'  sfc.SetAlignment(Gdiplus::StringAlignmentCenter);\n' +
'  sfc.SetLineAlignment(Gdiplus::StringAlignmentCenter);\n' +
'\n' +
inner + '\n' +
'}\n' +
'\n' +
'// ---------------------------------------------------------------- 「保存局面」导出 PNG（B2）\n' +
'// ★ 用户 2026-09-19：「在局面的右面添加一个保存局面这个按键，可以保存渲染出来的识别后的\n' +
'//   棋盘软件渲染的棋盘 png 图片文件」。\n' +
'//   图片内容 = 窗口里那张棋盘卡片的**同一份绘制代码**（DrawPosBoardCard），只是把\n' +
'//   设计单位 → 像素的比例从 dpr（本机 ≈1.87）提到 2.4，得到一张放大的清晰图；\n' +
'//   底色填白（窗口里圆角外沿是透明的，图片上留白比留透明更通用）。\n' +
'//   ⚠ 覆盖层此前**完全没有** PNG 编码能力（只有 GDI+ 绘制），所以这里补一个编码器查询。\n' +
'static const double kPosPngScale = 2.4;\n' +
'\n' +
'/** JSON 字符串里的一段文本的最小转义（只需处理反斜杠 —— Windows 路径一定带它；\n' +
' *  文件名里不允许出现双引号，所以不处理引号）。不转义的话页面拿到的 JSON 直接解析失败。 */\n' +
'static std::string EscapeJson(const std::string& in) {\n' +
'  std::string o;\n' +
'  o.reserve(in.size() + 8);\n' +
'  for (size_t i = 0; i < in.size(); ++i) {\n' +
'    const char c = in[i];\n' +
'    if (c == ' + Q + B + B + Q + ') { o += ' + Q + B + B + Q + '; o += ' + Q + B + B + Q + '; }\n' +
'    else o += c;\n' +
'  }\n' +
'  return o;\n' +
'}\n' +
'\n' +
'/** 按 MIME 找 GDI+ 的编码器 CLSID（image/png）。 */\n' +
'static bool GetEncoderClsid(const wchar_t* mime, CLSID* out) {\n' +
'  UINT num = 0, size = 0;\n' +
'  if (Gdiplus::GetImageEncodersSize(&num, &size) != Gdiplus::Ok || size == 0) return false;\n' +
'  std::vector<BYTE> buf(size);\n' +
'  Gdiplus::ImageCodecInfo* info = (Gdiplus::ImageCodecInfo*)buf.data();\n' +
'  if (Gdiplus::GetImageEncoders(num, size, info) != Gdiplus::Ok) return false;\n' +
'  for (UINT i = 0; i < num; ++i) {\n' +
'    if (info[i].MimeType && wcscmp(info[i].MimeType, mime) == 0) {\n' +
'      *out = info[i].Clsid;\n' +
'      return true;\n' +
'    }\n' +
'  }\n' +
'  return false;\n' +
'}\n' +
'\n' +
'/** 把识别到的棋盘渲染成 PNG 写到 path。失败时把原因写进 errOut。 */\n' +
'static bool RenderPositionPng(const std::wstring& path, std::string* errOut) {\n' +
'  const double saved = g_posScale;\n' +
'  g_posScale = kPosPngScale;\n' +
'  const int W = PX(POS_W);\n' +
'  const int H = PX(POS_CARD_H + POS_PAD * 2);        // 胶片 = 卡片 + 上下各一圈外边距\n' +
'  Gdiplus::Bitmap bmp(W, H, PixelFormat32bppARGB);\n' +
'  bool drawn = false;\n' +
'  {\n' +
'    Gdiplus::Graphics g(&bmp);\n' +
'    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);\n' +
'    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);\n' +
'    g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);\n' +
'    g.Clear(Gdiplus::Color(255, 255, 255, 255));\n' +
'    // 卡片在窗口里画在 (POS_PAD, POS_BY)，胶片里把它挪到 (POS_PAD, POS_PAD)\n' +
'    g.TranslateTransform(0.0f, PXF(POS_PAD - POS_BY));\n' +
'    DrawPosBoardCard(g, g_uiDark);\n' +
'    drawn = (g.GetLastStatus() == Gdiplus::Ok);\n' +
'  }\n' +
'  g_posScale = saved;                                // ★ 无论成败都要还原，别把窗口版式带歪\n' +
'  if (!drawn) { if (errOut) *errOut = "draw failed"; return false; }\n' +
'  CLSID png;\n' +
'  if (!GetEncoderClsid(L"image/png", &png)) { if (errOut) *errOut = "no png encoder"; return false; }\n' +
'  if (bmp.Save(path.c_str(), &png, nullptr) != Gdiplus::Ok) {\n' +
'    if (errOut) *errOut = "save failed";\n' +
'    return false;\n' +
'  }\n' +
'  return true;\n' +
'}\n' +
'\n' +
'/** 「保存局面」（B2）：弹系统「另存为」→ 渲染 → 写盘，并把结果回执给页面。\n' +
' *  与「复制代码」的口径**故意不同**：这里导的是**图**（用户要的就是棋盘图片），\n' +
' *  所以没有识别到棋盘时直接拒绝，不做「存一张空盘」这种让人困惑的事。\n' +
' *  测试出口 GB_TEST_SAVE_POS_PNG=<路径>：不弹对话框，直接写该路径（像素测试要用）。*/\n' +
'static void PosSavePng() {\n' +
'  if (!g_posHasBoard) {\n' +
'    LogMsg("[pos] save png skipped: no board recognized yet");\n' +
'    PostToPanel("{\\"type\\":\\"posSave\\",\\"ok\\":false,\\"reason\\":\\"noboard\\"}");\n' +
'    return;\n' +
'  }\n' +
'  std::wstring path;\n' +
'  char tv[MAX_PATH * 2] = {0};\n' +
'  DWORD tn = GetEnvironmentVariableA("GB_TEST_SAVE_POS_PNG", tv, sizeof(tv));\n' +
'  if (tn > 0 && tn < sizeof(tv)) {\n' +
'    path = Utf8ToWide(tv);\n' +
'  } else {\n' +
'    wchar_t buf[MAX_PATH] = {0};\n' +
'    {\n' +
'      SYSTEMTIME st;\n' +
'      GetLocalTime(&st);\n' +
'      swprintf(buf, MAX_PATH, L"gomoku-board-%04d%02d%02d-%02d%02d%02d.png",\n' +
'               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);\n' +
'    }\n' +
'    OPENFILENAMEW ofn;\n' +
'    ZeroMemory(&ofn, sizeof(ofn));\n' +
'    ofn.lStructSize = sizeof(ofn);\n' +
'    ofn.hwndOwner = (g_posWnd && IsWindow(g_posWnd)) ? g_posWnd : g_panel;\n' +
'    ofn.lpstrFile = buf;\n' +
'    ofn.nMaxFile = MAX_PATH;\n' +
'    ofn.lpstrFilter = L"PNG \\u56fe\\u7247 (*.png)\\0*.png\\0\\u6240\\u6709\\u6587\\u4ef6 (*.*)\\0*.*\\0";\n' +
'    ofn.nFilterIndex = 1;\n' +
'    ofn.lpstrDefExt = L"png";\n' +
'    ofn.lpstrTitle = L"\\u4fdd\\u5b58\\u5c40\\u9762\\uff08\\u68cb\\u76d8\\u56fe\\u7247\\uff09";\n' +
'    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;\n' +
'    wchar_t desk[MAX_PATH] = {0};\n' +
'    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_DESKTOPDIRECTORY, nullptr, 0, desk)) && desk[0]) {\n' +
'      ofn.lpstrInitialDir = desk;\n' +
'    }\n' +
'    if (!GetSaveFileNameW(&ofn)) {                  // 用户取消\n' +
'      LogMsg("[pos] save png cancelled by user");\n' +
'      PostToPanel("{\\"type\\":\\"posSave\\",\\"ok\\":false,\\"reason\\":\\"cancel\\"}");\n' +
'      return;\n' +
'    }\n' +
'    path = buf;\n' +
'  }\n' +
'  std::string err;\n' +
'  if (RenderPositionPng(path, &err)) {\n' +
'    LogMsg("[pos] board png saved: " + WideToUtf8(path));\n' +
'    PostToPanel("{\\"type\\":\\"posSave\\",\\"ok\\":true,\\"path\\":\\"" + EscapeJson(WideToUtf8(path)) + "\\"}");\n' +
'  } else {\n' +
'    LogMsg("[pos] board png failed: " + err);\n' +
'    PostToPanel("{\\"type\\":\\"posSave\\",\\"ok\\":false,\\"reason\\":\\"" + EscapeJson(err) + "\\"}");\n' +
'  }\n' +
'}\n' +
'\n' +
'/** 局面小窗的**唯一**绘制入口：整窗画进一块 32bpp PARGB 位图 →\n';
rep('static void PaintPosition(HWND h) {', NEWFUNS + 'static void PaintPosition(HWND h) {', '插入新函数');

/* ---------------------------------------------------------------- C1 环境自检 + WebView2 引导 */
rep(
'// ---------------------------------------------------------------- 入口\n',
'/** 环境自检（C1，2026-09-19）：把「换台电脑能不能跑」所需的全部事实写进日志。\n' +
' *  用户的诉求是「除了我的电脑可以顺利识别复杂的网站和应用，别人的电脑同样也可以，\n' +
' *  支持 Windows 10 以上电脑」—— 远程排查别人的机器时，日志里没有这几行就只能靠猜。*/\n' +
'static void LogEnvSelfCheck() {\n' +
'  // OS 版本：GetVersionEx 会被 manifest 谎报，RtlGetVersion 才是真实值。\n' +
'  // 自建结构体（等价 RTL_OSVERSIONINFOW），免得多引一个 winternl.h。\n' +
'  typedef struct { ULONG sz; ULONG major; ULONG minor; ULONG build; ULONG plat; WCHAR csd[128]; } Osvi;\n' +
'  std::string os = "unknown";\n' +
'  bool win10plus = false;\n' +
'  {\n' +
'    HMODULE nt = GetModuleHandleW(L"ntdll.dll");\n' +
'    Osvi vi;\n' +
'    ZeroMemory(&vi, sizeof(vi));\n' +
'    vi.sz = sizeof(vi);\n' +
'    typedef LONG(WINAPI * Fn)(Osvi*);\n' +
'    Fn fn = nt ? (Fn)GetProcAddress(nt, "RtlGetVersion") : nullptr;\n' +
'    if (fn && fn(&vi) == 0) {\n' +
'      char b[96];\n' +
'      snprintf(b, sizeof(b), "%lu.%lu build %lu", (unsigned long)vi.major,\n' +
'               (unsigned long)vi.minor, (unsigned long)vi.build);\n' +
'      os = b;\n' +
'      // 基线取 Win10 1809（build 17763）：WebView2 常青运行时官方要求 1803+，\n' +
'      // 而我们的 DPI/分层窗口组合在 1809 上才全绿，所以按 17763 报。\n' +
'      win10plus = (vi.major > 10) || (vi.major == 10 && vi.build >= 17763);\n' +
'    }\n' +
'  }\n' +
'  const char* arch =\n' +
'#ifdef _M_X64\n' +
'      "x64";\n' +
'#else\n' +
'      "x86";\n' +
'#endif\n' +
'  char b[320];\n' +
'  snprintf(b, sizeof(b),\n' +
'           "[env] OS %s  arch=%s  %s  (baseline: Windows 10 build 17763 / 1809)",\n' +
'           os.c_str(), arch, win10plus ? "supported" : "BELOW BASELINE - some features may fail");\n' +
'  LogMsg(b);\n' +
'  snprintf(b, sizeof(b),\n' +
'           "[env] screen %dx%d  virtual %dx%d@(%d,%d)  monitors=%d  dpi=%.3f  pageDpr=%.3f",\n' +
'           (int)GetSystemMetrics(SM_CXSCREEN), (int)GetSystemMetrics(SM_CYSCREEN),\n' +
'           (int)GetSystemMetrics(SM_CXVIRTUALSCREEN), (int)GetSystemMetrics(SM_CYVIRTUALSCREEN),\n' +
'           (int)GetSystemMetrics(SM_XVIRTUALSCREEN), (int)GetSystemMetrics(SM_YVIRTUALSCREEN),\n' +
'           (int)GetSystemMetrics(SM_CMONITORS), g_dpi, g_pageDpr);\n' +
'  LogMsg(b);\n' +
'  // WebView2 运行时：面板能不能渲染，全看这一条。Win11 与带 Edge 的 Win10 一般自带，\n' +
'  // 干净装机的 Win10（或企业镜像里剥离了 Edge 的）可能没有 —— 那是「别人电脑上面板一片黑」\n' +
'  // 最常见的原因，日志里必须先看它。\n' +
'  std::wstring rt;\n' +
'  LogMsg(std::string("[env] WebView2 runtime: ") +\n' +
'         (WebView2RuntimeVersion(rt) ? WideToUtf8(rt) : "NOT FOUND (panel cannot render)"));\n' +
'  LogMsg("[env] services: engine :8964 " + std::string(PortAlive(8964) ? "up" : "down") +\n' +
'         ", recognition :" + std::to_string(ScanPort()) + " " +\n' +
'         (PortAlive(ScanPort()) ? "up" : "down"));\n' +
'}\n' +
'\n' +
'// ---------------------------------------------------------------- 入口\n',
'LogEnvSelfCheck');

rep(
'    if (FAILED(hr)) {\n' +
'      LogMsg("[boot] WebView2 environment creation failed");\n' +
'      MessageBoxW(nullptr,\n' +
'        L"WebView2 runtime was not detected.\\n\\n"\n' +
'        L"Windows 11 and most Windows 10 ship it with Edge; if missing, install it once\\n"\n' +
'        L"(\\"Microsoft Edge WebView2 Runtime\\" from Microsoft, free of charge).",\n' +
'        L"Gomoku Assistant", MB_ICONWARNING | MB_TOPMOST);\n' +
'    }\n',

'    if (FAILED(hr)) {\n' +
'      LogMsg("[boot] WebView2 environment creation failed");\n' +
'      // ★ C1（2026-09-19）：把「怎么办」直接给出来。以前只有一句说明，用户拿到手不知道\n' +
'      //   该去哪装；现在点「是」就开官方下载页（常青独立安装包，免费）。\n' +
'      //   同时明确告诉用户：其余功能（四角框 / 识别 / 引擎）不受影响。\n' +
'      int r = MessageBoxW(nullptr,\n' +
'        L"\\u672a\\u68c0\\u6d4b\\u5230 WebView2 \\u8fd0\\u884c\\u65f6\\uff08\\u9762\\u677f\\u65e0\\u6cd5\\u663e\\u793a\\uff09\\u3002\\n\\n"\n' +
'        L"\\u672c\\u7a0b\\u5e8f\\u5176\\u4f59\\u529f\\u80fd\\u4e0d\\u53d7\\u5f71\\u54cd\\uff1a\\u56db\\u89d2\\u5b9a\\u4f4d\\u6846\\u3001\\u68cb\\u76d8\\u8bc6\\u522b\\u4e0e\\u5f15\\u64ce\\u7167\\u5e38\\u5de5\\u4f5c\\u3002\\n\\n"\n' +
'        L"WebView2 \\u8fd0\\u884c\\u65f6\\u662f\\u5fae\\u8f6f\\u514d\\u8d39\\u7ec4\\u4ef6\\uff1aWin11 \\u4e0e\\u7edd\\u5927\\u591a\\u6570 Win10 \\u968f Edge \\u81ea\\u5e26\\u3002\\n"\n' +
'        L"\\u70b9\\u300c\\u662f\\u300d\\u6253\\u5f00\\u5b98\\u65b9\\u4e0b\\u8f7d\\u9875\\uff0c\\u88c5\\u597d\\u540e\\u91cd\\u65b0\\u6253\\u5f00\\u672c\\u7a0b\\u5e8f\\u5373\\u53ef\\u3002",\n' +
'        L"Gomoku Assistant / \\u4e94\\u5b50\\u68cb\\u52a9\\u624b", MB_ICONWARNING | MB_TOPMOST | MB_YESNO);\n' +
'      if (r == IDYES) {\n' +
'        // 常青版「独立安装包」的官方固定短链（微软自己的 fwlink，随版本更新）\n' +
'        HINSTANCE sh = ShellExecuteW(nullptr, L"open",\n' +
'                                     L"https://go.microsoft.com/fwlink/p/?LinkId=2124703",\n' +
'                                     nullptr, nullptr, SW_SHOWNORMAL);\n' +
'        LogMsg(std::string("[boot] opened the WebView2 runtime download page (ShellExecute=") +\n' +
'               std::to_string((INT_PTR)sh) + ")");\n' +
'      }\n' +
'    }\n',
'WebView2 失败对话框');

rep(
'  Gdiplus::GdiplusStartupInput gsi;\n' +
'  Gdiplus::GdiplusStartup(&g_gdiToken, &gsi, nullptr);\n',
'  Gdiplus::GdiplusStartupInput gsi;\n' +
'  Gdiplus::GdiplusStartup(&g_gdiToken, &gsi, nullptr);\n' +
'  LogEnvSelfCheck();                  // ★ C1：环境自检（OS / 缩放 / WebView2 / 依赖端口）\n',
'WinMain 自检调用');

/* ---------------------------------------------------------------- C3 服务自愈可诊断 */
rep(
'static void EnsureEngine() {\n' +
'  if (PortAlive(8964)) {\n' +
'    // 端口上已经有引擎（上一次运行的残留，或另一个实例拉起的）——直接复用，不重复拉起。\n' +
'    // 只在第一次说明一次：EnsureEngine 也会被 ScanLoop 巡检线程反复调用，每次都打日志会刷屏。\n' +
'    // 这行日志同时也是「覆盖层到底自己起了依赖、还是搭了别人的车」的唯一线索。\n' +
'    static std::atomic<bool> told(false);\n' +
'    if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");\n' +
'    return;\n' +
'  }\n',

'static void EnsureEngine() {\n' +
'  // ★ C3（2026-09-19）：记住「上一轮看到它是活的」，由活变死就打一行 —— 这是\n' +
'  //   「引擎被安全软件杀掉 / 自己崩了」在日志里唯一的直接证据。旧版只有第一次那句\n' +
'  //   「reusing it」，之后死了又活、活了又死全都看不见，远程根本没法判断。\n' +
'  static std::atomic<int> seenAlive(0);\n' +
'  static std::atomic<int> restarts(0);\n' +
'  if (PortAlive(8964)) {\n' +
'    // 端口上已经有引擎（上一次运行的残留，或另一个实例拉起的）——直接复用，不重复拉起。\n' +
'    // 只在第一次说明一次：EnsureEngine 也会被 ScanLoop 巡检线程反复调用，每次都打日志会刷屏。\n' +
'    // 这行日志同时也是「覆盖层到底自己起了依赖、还是搭了别人的车」的唯一线索。\n' +
'    if (seenAlive.exchange(1) == 0) {\n' +
'      static std::atomic<bool> told(false);\n' +
'      if (!told.exchange(true)) LogMsg("[deps] engine :8964 already running, reusing it (not launching again)");\n' +
'    }\n' +
'    return;\n' +
'  }\n' +
'  if (seenAlive.exchange(0) == 1) {\n' +
'    LogMsg("[deps] engine :8964 went down -> restarting it (restart #" +\n' +
'           std::to_string(restarts.load() + 1) + ")");\n' +
'  }\n',
'EnsureEngine 存活跟踪');

rep(
'  if (!ClaimSpawnSlot(g_engineSpawnedAt)) return;\n' +
'  LogMsg("[deps] starting engine backend --as-backend (headless, no browser)");\n' +
'  SpawnDetached(exe, L"--as-backend", root);\n',
'  if (!ClaimSpawnSlot(g_engineSpawnedAt)) return;\n' +
'  LogMsg("[deps] starting engine backend --as-backend (headless, no browser)");\n' +
'  SpawnDetached(exe, L"--as-backend", root);\n' +
'  restarts.fetch_add(1);\n',
'引擎重启计数');

rep(
'static void EnsureScanServer() {\n' +
'  if (PortAlive(ScanPort())) {\n' +
'    static std::atomic<bool> told(false);\n' +
'    if (!told.exchange(true)) LogMsg("[deps] recognition service :" + std::to_string(ScanPort()) +\n' +
'                                     " already running, reusing it (not launching again)");\n' +
'    return;\n' +
'  }\n',

'static void EnsureScanServer() {\n' +
'  // ★ C3（2026-09-19）：与 EnsureEngine 同一套「由活变死就报一行」的追踪 ——\n' +
'  //   识别服务被安全软件拦掉/自己崩了，是「面板一直停在未检测到棋盘」的头号原因。\n' +
'  static std::atomic<int> seenAlive(0);\n' +
'  static std::atomic<int> restarts(0);\n' +
'  if (PortAlive(ScanPort())) {\n' +
'    if (seenAlive.exchange(1) == 0) {\n' +
'      static std::atomic<bool> told(false);\n' +
'      if (!told.exchange(true)) LogMsg("[deps] recognition service :" + std::to_string(ScanPort()) +\n' +
'                                       " already running, reusing it (not launching again)");\n' +
'    }\n' +
'    return;\n' +
'  }\n' +
'  if (seenAlive.exchange(0) == 1) {\n' +
'    LogMsg("[deps] recognition service :" + std::to_string(ScanPort()) +\n' +
'           " went down -> restarting it (restart #" + std::to_string(restarts.load() + 1) + ")");\n' +
'  }\n',
'EnsureScanServer 存活跟踪');

rep(
'  if (!ClaimSpawnSlot(g_scanSpawnedAt)) return;\n' +
'  LogMsg("[deps] starting recognition service GomokuVision.exe --scan on :" +\n' +
'         std::to_string(ScanPort()));\n' +
'  SpawnDetached(exe, L"--scan", cwd);\n',

'  if (!ClaimSpawnSlot(g_scanSpawnedAt)) return;\n' +
'  LogMsg("[deps] starting recognition service GomokuVision.exe --scan on :" +\n' +
'         std::to_string(ScanPort()));\n' +
'  SpawnDetached(exe, L"--scan", cwd);\n' +
'  restarts.fetch_add(1);\n',
'识别服务重启计数');

fs.writeFileSync(F, s, 'utf8');
console.log('[patch-overlay] ' + n + ' 处替换完成，' + before + ' → ' + s.length + ' 字符');
