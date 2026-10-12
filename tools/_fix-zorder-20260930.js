// 2026-09-30 修复：WM_SIZE 内 put_Bounds 顺序（内容→顶栏→建议），否则内容 WebView 置顶盖住顶栏/建议层
'use strict';
const fs = require('fs');
const p = 'C:/Users/harve/Desktop/Gobang auto/desktop-calculator/src/host.cpp';
let s = fs.readFileSync(p, 'utf8');
const old =
'    case WM_SIZE: {\n' +
'      RECT rc;\n' +
'      GetClientRect(h, &rc);\n' +
'      int bar = GbPx(h, 46);                       // 顶栏工具栏高度（CSS px）\n' +
'      if (g_updToolController) g_updToolController->put_Bounds(RECT{0, 0, rc.right, bar});\n' +
'      if (g_updSuggestController) g_updSuggestController->put_Bounds(RECT{0, bar - GbPx(h, 6), rc.right, GbPx(h, 300)});\n' +
'      if (g_updController) g_updController->put_Bounds(RECT{0, bar, rc.right, rc.bottom});\n' +
'      return 0;\n' +
'    }\n';
const next =
'    case WM_SIZE: {\n' +
'      RECT rc;\n' +
'      GetClientRect(h, &rc);\n' +
'      int bar = GbPx(h, 46);                       // 顶栏工具栏高度（CSS px）\n' +
'      // ★ 2026-09-30（根因修复）：WebView2 put_Bounds 会把该 controller 的窗口**置顶**——\n' +
'      //   若先调顶栏/建议再调内容，内容区会盖住顶栏与悬浮建议层（用户实测：顶栏不可见、\n' +
'      //   误在 Bing 页面搜索框操作、粘贴网址变必应、建议层永不出现）。\n' +
'      //   必须按「内容 → 顶栏 → 建议层」的 Z 序顺序调用：\n' +
'      if (g_updController) g_updController->put_Bounds(RECT{0, bar, rc.right, rc.bottom});\n' +
'      if (g_updToolController) g_updToolController->put_Bounds(RECT{0, 0, rc.right, bar});\n' +
'      if (g_updSuggestController) g_updSuggestController->put_Bounds(RECT{0, bar - GbPx(h, 6), rc.right, GbPx(h, 300)});\n' +
'      return 0;\n' +
'    }\n';
const i = s.indexOf(old);
if (i < 0) throw new Error('WM_SIZE 锚点未找到');
s = s.slice(0, i) + next + s.slice(i + old.length);
fs.writeFileSync(p, s, 'utf8');
console.log('WM_SIZE Z 序修复落盘 OK');
