#!/usr/bin/env node
/**
 * UI 打磨共享模块（2026-09-25）：加密前与发布自检共用的同一套「去注释 + 混淆」。
 *
 * 加密侧（encrypt-calc-ui.js）：明文 → polish() → 密文；
 * 自检侧（verify-calc-enc.js）：解密 .enc → 与 polish(源码) **逐字节比对**。
 * 两边必须用同一份实现 + 同一个 terser —— 否则自检假红。
 *
 * 打磨内容（用户要求「加密的时候删除各种注释，混淆代码函数，即使对方能破解我们的
 * 界面 js 也可能很难看懂」）：
 *   · .js  → terser：删**全部**注释 + 折叠空白 + mangle **局部**函数/变量名
 *     （顶层名一律保留 —— calc.html 的内联脚本 / Worker 注入 / 宿主桥都靠全局名互操作；
 *       ascii_only=false —— 中文文案原样保留，宿主按 UTF-8 喂 WebView）；
 *   · .css → 删 CSS 块注释、压掉空行；
 *   · .html→ 删 <!-- --> 注释（<script> 内部除外，JS 由 terser 处理）、压掉空行。
 */
'use strict';
const path = require('path');

function loadTerser() {
  const home = require('os').homedir();
  const tries = ['terser',
    process.env.GB_TERSER_PATH || '',
    path.join(home, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'terser')];
  for (const t of tries) {
    if (!t) continue;
    try { return require(t); } catch (e) { /* 下一个 */ }
  }
  throw new Error('找不到 terser —— 请 NODE_PATH 指向含 terser 的 node_modules（或设 GB_TERSER_PATH）');
}

/** 去掉 CSS 注释 + 压缩空行（本项目 CSS 字符串里没有 "/*" 形态，安全）。 */
function polishCss(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n').trim() + '\n';
}

/** 去掉 HTML 注释（<script>…</script> 段原样保留，JS 由 terser 处理）+ 压缩空行。 */
function polishHtml(s) {
  const parts = s.split(/(<script[\s\S]*?<\/script>)/gi);
  for (let i = 0; i < parts.length; i += 2)          // 偶数段 = 非 script
    parts[i] = parts[i].replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n+/g, '\n');
  return parts.join('').trim() + '\n';
}

/** JS：terser 打磨。compress=false（行为零改动，只去注释 + 空白 + mangle 局部名）。 */
async function polishJs(s) {
  const TERSER = loadTerser();
  const r = await TERSER.minify(s, {
    compress: false,
    mangle: { toplevel: false },                     // 顶层名保留：HTML/Worker/宿主桥互操作
    format: { comments: false, ascii_only: false },  // 中文原样（宿主按 UTF-8 喂 WebView）
  });
  if (!r.code || r.error) throw (r.error || new Error('terser 空输出'));
  return r.code;
}

/** 按文件扩展名分发；ext 传 'js' / 'css' / 'html'（大小写不敏感）。 */
async function polish(plain, ext) {
  const e = String(ext).toLowerCase().replace(/^\./, '');
  if (e === 'js') return polishJs(plain);
  if (e === 'css') return polishCss(plain);
  return polishHtml(plain);
}

module.exports = { polish, polishCss, polishHtml, polishJs };
