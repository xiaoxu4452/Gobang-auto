#!/usr/bin/env node
/**
 * 护栏：桌面覆盖层的「我执黑 / 我执白」两个按键，配色必须与书签面板逐字一致。
 *
 * 背景：桌面版的面板 UI 是从 engine-server/resources/bookmarklet.js 机械抽取的
 * （tools/extract-panel-ui.js），理论上外观应当完全一致。但 side 按键是有状态的
 * （选中态要反转填充），抽取器只搬了元素声明、没搬 paintSideBtns 的绘制逻辑，
 * 于是桌面版自己写了一份——用了绿色 #43a047 描边，跟书签版的「黑底白字 / 白底黑字」
 * 完全不是一回事。用户一眼就看出来了：「选择黑子白子的按键颜色没有同步」。
 *
 * 本脚本把两边的色值字面量对齐，防止再次各画各的：
 *   ① 从 bookmarklet.js 的 paintSideBtns() 里抽出所有颜色字面量
 *   ② 断言同样的字面量都出现在 desktop-overlay/ui/bridge.js 的 applySideUI() 里
 *   ③ 断言已废弃的绿色描边不再出现
 *   ④ 断言状态文字 __gb_side_txt 真的被写入（之前一直是空的）
 *
 * 用法：node tools/test-side-buttons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BM = path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js');
const BRIDGE = path.join(ROOT, 'desktop-overlay', 'ui', 'bridge.js');
const EXTRACT = path.join(ROOT, 'tools', 'extract-panel-ui.js');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

const bm = fs.readFileSync(BM, 'utf8');
const bridge = fs.readFileSync(BRIDGE, 'utf8');

/** 取一段函数体：从 `function name(` 起，按花括号配平找到结束位置。 */
function sliceFn(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

const bmFn = sliceFn(bm, 'function paintSideBtns(');
const bdFn = sliceFn(bridge, 'function applySideUI(');

check('书签面板里找得到 paintSideBtns()', bmFn.length > 200, bmFn.length + ' 字符');
check('桌面面板里找得到 applySideUI()', bdFn.length > 200, bdFn.length + ' 字符');

// ① 抽取书签版用到的颜色字面量
const COLORS = ['#1a1a1a', '#fff', '#111', '#000', '#262b3a', '#c8ccd6', '#555', '#5a6072', '#999'];
const missing = COLORS.filter((c) => bmFn.includes(c) === false && bmFn.includes(c.toUpperCase()) === false);
check('书签版色值集合与预期一致（未被改名）', missing.length === 0,
  missing.length ? '书签版缺少：' + missing.join(',') : COLORS.length + ' 个色值齐备');

// ② 同样的字面量必须都出现在桌面版里
const notInBridge = COLORS.filter((c) => !bdFn.includes(c));
check('桌面版 applySideUI 覆盖了书签版全部色值', notInBridge.length === 0,
  notInBridge.length ? '桌面版缺少：' + notInBridge.join(',') : '逐字一致');

// ③ 选中/未选中的结构契约：这几个属性两边都必须设置
for (const prop of ['background', 'color', 'border', 'boxShadow', 'fontWeight', 'opacity', 'padding']) {
  check('书签版设置了 ' + prop, bmFn.includes('style.' + prop) || bmFn.includes("'" + prop + "'"));
  check('桌面版设置了 ' + prop, bdFn.includes('style.' + prop));
}

// ④ 选中态必须「反转填充」：黑选中用黑底、白选中用白底
check('黑选中 = 黑底白字（书签版）', /isBlack\s*\?\s*'#1a1a1a'\s*:\s*'#fff'/.test(bmFn));
check('黑选中 = 黑底白字（桌面版）', /isBlack\s*\?\s*'#1a1a1a'\s*:\s*'#fff'/.test(bdFn));
check('黑选中内描白线（桌面版）', bdFn.includes("'0 0 0 1.5px #fff inset'"));
// ★ 2026-09-17 修正：原先这里钉的是 `opacity = on ? '1' : '0.45'`（未选中就淡）。
//   但后来加了「再点一次同一个颜色 = 取消选择，两个都不选」的需求，并且明确要求
//   **未选定时不能淡出**（淡淡的看起来像坏了，用户会以为功能挂了）—— 于是那条旧断言
//   与现行契约直接冲突，长期假红。现在改钉真实契约：
//     选中 / 未选定 → 1（全对比度，等用户点）；只有「选了另一边」才淡到 0.45。
//   两边口径必须等价：书签版写 `!on && eff >= 0`，桌面版写 `on || unset`。
check('未选中降低不透明度（桌面版）：只有「选了另一边」才淡，未选定不淡',
  /opacity\s*=\s*\(on\s*\|\|\s*unset\)\s*\?\s*'1'\s*:\s*'0\.45'/.test(bdFn));
check('未选定不淡出这条在书签版是同一口径（!on && eff >= 0）',
  /opacity\s*=\s*\(!on\s*&&\s*eff\s*>=\s*0\)\s*\?\s*'0\.45'\s*:\s*'1'/.test(bmFn));
check('桌面版未选定判据走 sideUnset()（0/1 之外一律算未选定）', /sideUnset\(\)/.test(bdFn));

// ⑤ 已废弃的绿色描边不得回潮
check('桌面版不再使用绿色描边 #43a047', !bdFn.includes('#43a047'), '（旧实现用绿色表示选中，与书签版不符）');

// ⑥ 状态文字必须写入（之前 __gb_side_txt 一直是空的）
check('桌面版写入 __gb_side_txt 状态文字', /__gb_side_txt/.test(bdFn));
check('状态文字带「锁定」前缀（中文）', bdFn.includes('锁定'));
check('状态文字带 locked 前缀（英文）', bdFn.includes('locked'));
check('状态文字按黑白走 i18n 键', /T\(S\.side === 0 \? 'black' : 'white'\)/.test(bdFn));

// ⑦ 用户明确要求：白子不许用蓝色轮廓（选中态只能靠黑/白反转表示）
check('白选中不使用蓝色系边框',
  !/2px solid #(?:3b7dd8|2196f3|1976d2|1e88e5)/i.test(bdFn));
check('选中态边框只用 #000 / #111',
  (bdFn.match(/2px solid #([0-9a-fA-F]{3,6})/g) || []).every((s) => /#(000|111)$/.test(s)),
  (bdFn.match(/2px solid #[0-9a-fA-F]{3,6}/g) || []).join(' , '));

// ⑧ 生成的 panel-ui.js 必须已经把 side 三个元素声明搬过来（否则 applySideUI 只能自己再查一遍）
const ui = fs.readFileSync(path.join(ROOT, 'desktop-overlay', 'ui', 'panel-ui.js'), 'utf8');
for (const v of ['sideBlack', 'sideWhite', 'sideTxtEl']) {
  check('panel-ui.js 含元素声明 ' + v, new RegExp('var\\s+' + v + '\\s*=').test(ui));
}

// ⑨ 桌面版面板 HTML 里确实有这三个节点
const html = fs.readFileSync(path.join(ROOT, 'desktop-overlay', 'ui', 'panel.html'), 'utf8');
check('panel.html 含 __gb_side_black', html.includes('id="__gb_side_black"'));
check('panel.html 含 __gb_side_white', html.includes('id="__gb_side_white"'));
check('panel.html 含 __gb_side_txt', html.includes('id="__gb_side_txt"'));

console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
