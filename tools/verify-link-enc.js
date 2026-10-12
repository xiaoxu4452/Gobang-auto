#!/usr/bin/env node
/**
 * 连线版（Meter Gomoku）加密界面**三层校验** —— `Meter Gomoku/calc/*.enc` 的内容级护栏。
 *
 * 为什么需要它：`tools/audit-publish-freshness.js` 只能比对 **mtime**（源码比密文新就报警），
 * 却答不出「密文里的**内容**是不是当前这份源码」。而连线版的发布路径有三处可能走偏：
 *   ① 只重编了 exe、忘了重跑 `tools/encrypt-calc-ui.js`（磁盘上留着上一版的界面）；
 *   ② 改了 `desktop-connect/ui/` 却跑到了 `desktop-calculator/ui/`（两棵源码树同名同结构）；
 *   ③ 加密容器写了一半（截断/空串）却因为 test 只查存在性而溜过去。
 *   ⇒ 唯一可靠的判据是：**解密回来 == 对当前源码跑同一套打磨**，逐字节比。
 *     这与 `tools/verify-calc-enc.js`（单机训练器那份）是同一条口径。
 *
 * 三层：
 *   ① 解密 Meter Gomoku/calc/<name>.enc（容器 GBUIENC1 / SEED2 / SHIFT / B64）
 *   ② 对 desktop-connect/ui/<name> 跑 tools/uipolish.js（与加密前置打磨**同一份实现**）
 *   ③ 逐字节比对；再对字符串字面量做特征粗筛（防止「解密出一个空壳也算过」）
 *
 * 用法：node tools/verify-link-enc.js        （退出码 0 = 全过）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const O = require('./obfuscator.js');
const P = require('./uipolish.js');

const ROOT = path.join(__dirname, '..');
const KEY = 'GbClcUiK3y2026xQz9Wm8Pd5Rt2YvN7s';
const PUB = path.join(ROOT, 'Meter Gomoku', 'calc');
const SRC = path.join(ROOT, 'desktop-connect', 'ui');
const NAMES = ['calc.html', 'calc.css', 'calc.js', 'engine-ai.js', 'bridge.js'];

// 特征串：**只挑混淆器改不动的字符串字面量 / 属性名 / 选择器**
//   （局部函数名与变量名会被 terser 改名，拿它们做探针必然误报）。
//   真正证明「不是旧代码」的是上面的逐字节比对；这里是可读性辅助，顺带钉住关键特性不被删。
const FEATURES = {
  'calc.css': [
    ['界面外壳禁选（user-select:none）', /user-select:none/],
    ['内容文本保留可选中（user-select:text）', /user-select:text/],
    ['真实点击开关的宽度规则', /\.lk-btns #lk_real\{flex:0 0 auto/],
  ],
  'calc.js': [
    ['复盘序号按钮（syncRvNumBtn 直调）', /syncRvNumBtn/],
    ['连线窗「真实点击」按钮', /id="lk_real"/],
    ['真实点击双语键面', /Real Click/],
    ['真实点击状态交给桥的隐藏控件', /__gb_realclick/],
  ],
  'bridge.js': [
    ['主线独占调度日志', /LINK_MAIN_EXCLUSIVE/],
    ['核配额随状态上报的探针行', /LINK_ENG_QUOTA/],
    ['CPU 拆分状态字段', /engineCPUs/],
    ['真实点击开关的控件读取', /__gb_realclick/],
  ],
  'engine-ai.js': [
    ['分核预算字段', /engineCPUs/],
    ['按需引导车道', /bootLazyLane|lazyBooting/],
  ],
};

function decrypt(encPath) {
  const txt = fs.readFileSync(encPath, 'utf8');
  const m2 = /SEED2=(\d+)/.exec(txt), mh = /SHIFT=(\d+)/.exec(txt);
  const b64 = txt.split('B64=')[1];
  if (!m2 || !mh || !b64) throw new Error('容器格式不对：' + encPath);
  return O.deobfuscate(b64.trim(), +m2[1], +mh[1], KEY);
}

(async () => {
  let bad = 0;
  for (const f of NAMES) {
    const enc = path.join(PUB, f + '.enc');
    const src = path.join(SRC, f);
    if (!fs.existsSync(enc)) { console.log('— 跳过（无密文）：' + f); continue; }
    if (!fs.existsSync(src)) { console.log('✗ 源缺失：' + src); bad++; continue; }
    const plain = fs.readFileSync(src, 'utf8');
    const want = await P.polish(plain, path.extname(f));
    let got;
    try { got = decrypt(enc); }
    catch (e) { console.log('✗ ' + f + ' 解密失败：' + e.message); bad++; continue; }

    const ok = got === want;
    if (!ok) {
      bad++;
      // 找出第一处差异，方便定位
      let i = 0;
      const n = Math.min(got.length, want.length);
      while (i < n && got[i] === want[i]) i++;
      console.log('✗ ' + f + ' 逐字节不一致：解密 ' + got.length + ' B / 期望 ' + want.length +
        ' B，首个差异 @' + i +
        '  期望…' + JSON.stringify(want.slice(i, i + 40)) +
        '  实际…' + JSON.stringify(got.slice(i, i + 40)));
    } else {
      console.log('✓ ' + f + '  逐字节一致（明文 ' + plain.length + ' → 打磨 ' + want.length + ' B）');
    }

    // 特征串粗筛（在解密明文上查）
    for (const [label, re] of (FEATURES[f] || [])) {
      if (!re.test(got)) { console.log('   ✗ 特征缺失：' + label + '（' + re + '）'); bad++; }
      else console.log('   ✓ 特征在位：' + label);
    }
  }
  console.log(bad === 0 ? '\n★ 连线版加密三层校验：全部通过' : '\n★ 连线版加密三层校验：' + bad + ' 项不通过');
  process.exit(bad === 0 ? 0 : 1);
})();
