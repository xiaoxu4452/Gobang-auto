#!/usr/bin/env node
/**
 * 加密五子棋练习器的 UI（构建期）——把 desktop-calculator/ui/ 下的 calc.html/js/css 变成 <file>.enc。
 *
 * 为什么：用户要求「发布包里面的 ui 部分要加密」。练习器的 UI 原先是**明文**躺在 exe 旁边的
 *   calc/ 里，解包就能读到全部页面源码。加密后发布包里只有 .enc，运行时由
 *   Desktop GomokuTrainer.exe 里的 ui_crypto.h 在**内存里**解密再喂给 WebView2
 *   （见 host.cpp 的 ResHandler）—— 磁盘上全程没有明文。
 *
 * 与发布链路的接口：
 *   · tools/build-calculator.js --publish 时调用本脚本，输出到 staging 目录；
 *   · 明文仍留在 desktop-calculator/ui/ 供开发调试与测试（宿主：有 .enc 走解密，没有才回退明文）；
 *   · 发布目录里**只放 .enc**，同名的明文会被清掉。
 *
 * ⚠️ CALC_UI_KEY 必须与 desktop-calculator/src/ui_crypto.h 的 GB_CALC_UI_KEY **逐字符相等**
 *    （32 字符）。密钥编译在 exe 里，不落进 .enc。两边漂移 → 页面直接白屏。
 *
 * 用法：node tools/encrypt-calc-ui.js [--out <目录>]     # 默认就地写到 ui/ 旁边
 */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require('./obfuscator.js');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'desktop-calculator', 'ui');

// ★ 单一事实来源：与 desktop-calculator/src/ui_crypto.h 的 GB_CALC_UI_KEY 必须完全一致（32 字符）★
const CALC_UI_KEY = 'GbClcUiK3y2026xQz9Wm8Pd5Rt2YvN7s';

const argOut = process.argv.indexOf('--out');
const OUT_DIR = argOut > 0 ? process.argv[argOut + 1] : UI_DIR;
// ★ --src：从指定目录读 UI（默认 desktop-calculator/ui）。三件套变体构建用：
//   build-calculator.js --suite 先把变体 calc.js（顶部注入 GB_AI_REMOTE）暂存到一个目录，
//   再用 --src 指过来加密 —— 独立版与三件套版共用同一份源码，只在构建期分叉。
const argSrc = process.argv.indexOf('--src');
const SRC_DIR = argSrc > 0 ? process.argv[argSrc + 1] : UI_DIR;

if (CALC_UI_KEY.length !== 32) {
  console.error('[enc-calc] CALC_UI_KEY 必须是 32 字符，当前 ' + CALC_UI_KEY.length);
  process.exit(1);
}

// 与 C++ 那一侧交叉核对：密钥一旦漂移，页面就是一片空白，且不报任何错 —— 必须在构建期拦住。
{
  const h = path.join(ROOT, 'desktop-calculator', 'src', 'ui_crypto.h');
  const src = fs.readFileSync(h, 'utf8');
  const m = /GB_CALC_UI_KEY\s*=\s*"([^"]+)"/.exec(src);
  if (!m) {
    console.error('[enc-calc] ui_crypto.h 里找不到 GB_CALC_UI_KEY');
    process.exit(1);
  }
  if (m[1] !== CALC_UI_KEY) {
    console.error('[enc-calc] 密钥不一致：\n  JS  = ' + CALC_UI_KEY + '\n  C++ = ' + m[1] +
      '\n两处必须逐字符相同，否则页面解密不出东西（白屏）。');
    process.exit(1);
  }
}

const EXTS = /\.(html|js|css)$/i;
// ★ `_` 前缀 = 测试专用页（如 _calc_test.html），永不加密/发布 —— 防测试后门混进发布包
const files = fs.readdirSync(SRC_DIR).filter((f) => EXTS.test(f) && !f.endsWith('.enc') && !f.startsWith('_'));
if (!files.length) {
  console.error('[enc-calc] ' + SRC_DIR + ' 里没有可加密的 UI 文件');
  process.exit(1);
}

// ---------------------------------------------------------------- 打磨（2026-09-25 用户要求）
// 「加密的时候删除各种注释，混淆代码函数，即使对方能破解我们的界面 js 也可能很难看懂」。
// 实现在 tools/uipolish.js（加密侧与 verify-calc-enc 自检侧**共用同一份**，
// 自检靠「解密 == 打磨(源码) 逐字节比对」才成立）。terser 找不到时直接失败：
// 宁可不发布，也不许把带注释的明文封进发布包。
const P = require('./uipolish.js');

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
(async () => {
  for (const f of files) {
    let plain = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    let polished;
    try {
      polished = await P.polish(plain, path.extname(f));
    } catch (e) {
      console.error('[enc-calc] 打磨失败（' + f + '）：' + (e && e.message || e));
      process.exit(1);
    }
    const e = O.obfuscate(polished, CALC_UI_KEY);
    const out = 'GBUIENC1\nSEED2=' + e.seed2 + '\nSHIFT=' + e.shift + '\nB64=' + e.b64 + '\n';
    fs.writeFileSync(path.join(OUT_DIR, f + '.enc'), out, 'utf8');
    // 就地往返校验：密文必须能还原成**逐字节相同**的打磨稿。
    // 这一步不能省 —— 曾出现「能解、但解出来少一个换行」导致脚本静默失效。
    const back = O.deobfuscate(e.b64, e.seed2, e.shift, CALC_UI_KEY);
    if (back !== polished) {
      console.error('[enc-calc] 往返校验失败：' + f);
      process.exit(1);
    }
    total += out.length;
    console.log('  [enc-calc] ' + f + '  明文 ' + plain.length + ' → 打磨 ' + polished.length +
      ' → 密文 ' + out.length + ' 字节');
  }
  console.log('[enc-calc] ✓ 已加密 ' + files.length + ' 个 UI 文件 → ' + OUT_DIR +
    '（合计 ' + (total / 1024).toFixed(1) + ' KB），去注释+混淆+往返校验通过');
})();
