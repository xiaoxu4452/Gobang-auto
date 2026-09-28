#!/usr/bin/env node
/**
 * 加密桌面端面板 UI（构建期）——把 desktop-overlay/ui/ 下的 html/js/css 变成 <file>.enc。
 *
 * 为什么：发布包里不该躺着 panel.html / panel-ui.js / bridge.js 的明文。
 *   加密后，包里只有 .enc；运行时由 GomokuOverlay.exe 里的 ui_crypto.h 在**内存里**解密，
 *   再交给 WebView2（见 host.cpp 的 ResHandler）—— 磁盘上全程没有明文。
 *
 * 与发布链路的接口：
 *   · 本脚本在 tools/build-overlay.js 重新生成 UI **之后**自动跑一次（保证 .enc 与明文同步）；
 *   · 明文仍留在 desktop-overlay/ui/ 供开发调试（宿主优先读 .enc，读不到才回退明文）；
 *   · tools/build-release.js 只把 .enc 拷进发布目录，明文一个都不带。
 *
 * ⚠️ UI_KEY 必须与 desktop-overlay/src/ui_crypto.h 的 GB_UI_KEY **逐字符相等**（32 字符）。
 *    改一边不 writable 另一边，面板会直接白屏 —— 密钥编译在 exe 里，不落进 .enc。
 *
 * 用法：node tools/encrypt-overlay-ui.js [--ui <目录>] [--verify]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require('./obfuscator.js');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'desktop-overlay', 'ui');

// ★ 单一事实来源：与 desktop-overlay/src/ui_crypto.h 的 GB_UI_KEY 必须完全一致（32 字符）★
const UI_KEY = 'Gb0vErL4yU1K3y2026xQz9Wm8Pd5Rt2Y';

if (UI_KEY.length !== 32) {
  console.error('[enc-ui] UI_KEY 必须是 32 字符，当前 ' + UI_KEY.length);
  process.exit(1);
}

// ui_crypto.h 里的密钥也要是这一个：两边一旦漂移，面板就是一片白。
{
  const h = path.join(ROOT, 'desktop-overlay', 'src', 'ui_crypto.h');
  const src = fs.readFileSync(h, 'utf8');
  const m = /GB_UI_KEY\s*=\s*"([^"]+)"/.exec(src);
  if (!m) {
    console.error('[enc-ui] ui_crypto.h 里找不到 GB_UI_KEY');
    process.exit(1);
  }
  if (m[1] !== UI_KEY) {
    console.error('[enc-ui] 密钥不一致：\n  JS  = ' + UI_KEY + '\n  C++ = ' + m[1] +
      '\n两处必须逐字符相同，否则面板解密不出东西（白屏）。');
    process.exit(1);
  }
}

const EXTS = /\.(html|js|css)$/i;
const files = fs.readdirSync(UI_DIR).filter((f) => EXTS.test(f) && !f.endsWith('.enc'));
if (!files.length) {
  console.error('[enc-ui] ' + UI_DIR + ' 里没有可加密的 UI 文件');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  const plain = fs.readFileSync(path.join(UI_DIR, f), 'utf8');
  const e = O.obfuscate(plain, UI_KEY);
  const out = 'GBUIENC1\nSEED2=' + e.seed2 + '\nSHIFT=' + e.shift + '\nB64=' + e.b64 + '\n';
  fs.writeFileSync(path.join(UI_DIR, f + '.enc'), out, 'utf8');
  // 就地往返校验：密文必须能还原成**逐字节相同**的原文。
  // 这一步不能省 —— 曾出现「能解、但解出来少一个换行」导致脚本静默失效。
  const back = O.deobfuscate(e.b64, e.seed2, e.shift, UI_KEY);
  if (back !== plain) {
    console.error('[enc-ui] 往返校验失败：' + f);
    process.exit(1);
  }
  total += out.length;
  console.log('  [enc-ui] ' + f + '  ' + plain.length + ' → ' + out.length + ' 字节密文');
}
console.log('[enc-ui] ✓ 已加密 ' + files.length + ' 个 UI 文件（合计 ' +
  (total / 1024).toFixed(1) + ' KB），往返校验通过');
