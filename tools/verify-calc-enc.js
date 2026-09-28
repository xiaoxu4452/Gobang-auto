#!/usr/bin/env node
/**
 * 发布版自检：练习器 UI（calc/*.enc）是不是最新代码？
 *
 * 背景：本项目最大的反复故障是「本地 debug 版对，发布版跑旧代码」。引擎/书签面板那侧已有
 *   `verify-release-enc.js` / `verify-release-blob.js` / `verify-release-server.js` 三个自检；
 *   但**练习器的 calc/*.enc 一直缺乏强自检**。
 *
 * ★ 2026-09-25 起升级为**逐字节比对**：发布包里的 UI 现在是「打磨（去注释+混淆）后加密」，
 *   单靠特征串已不可靠（terser 会改掉局部名）。本脚本把 .enc 解密出来，与
 *   「对**同一份中间源码**（build/std-ui 或 build/suite-ui，发布脚本每次发布都会重新生成）
 *   跑同一套打磨（tools/uipolish.js，与加密侧共用）」的结果逐字节比对 ——
 *   比特征串更强：只要发布源码、打磨器、密文三者有一个不同步，立刻报 ✗。
 *
 * 用法：
 *   node tools/verify-calc-enc.js            # 检查三处发布目录
 *   node tools/verify-calc-enc.js --dump calc.js   # 顺便把解密后的明文写到 tools/_calc_dump.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const O = require('./obfuscator.js');
const P = require('./uipolish.js');

const ROOT = path.join(__dirname, '..');
// 单一事实来源：必须与 encrypt-calc-ui.js 的 CALC_UI_KEY、ui_crypto.h 的 GB_CALC_UI_KEY 逐字符相等
const KEY = 'GbClcUiK3y2026xQz9Wm8Pd5Rt2YvN7s';

const DIRS = ['Meter GomokuTrainer', 'Desktop version', 'Meter engine-server'];
const NAMES = ['calc.html', 'calc.css', 'calc.js', 'engine-ai.js'];

/** 发布目录 → 中间源码目录（release-calculator.sh 每次发布都会重新生成）。 */
const SRC_OF = {
  'Meter GomokuTrainer': path.join(ROOT, 'desktop-calculator', 'build', 'std-ui'),
  'Desktop version': path.join(ROOT, 'desktop-calculator', 'build', 'suite-ui'),
  'Meter engine-server': path.join(ROOT, 'desktop-calculator', 'build', 'suite-ui'),
};

function decrypt(encPath) {
  const txt = fs.readFileSync(encPath, 'utf8');
  const m2 = /SEED2=(\d+)/.exec(txt), mh = /SHIFT=(\d+)/.exec(txt);
  const b64 = txt.split('B64=')[1];
  if (!m2 || !mh || !b64) throw new Error('容器格式不对（缺 SEED2/SHIFT/B64）：' + encPath);
  return O.deobfuscate(b64.trim(), +m2[1], +mh[1], KEY);
}

async function main() {
  const dumpIdx = process.argv.indexOf('--dump');
  const dumpName = dumpIdx >= 0 ? process.argv[dumpIdx + 1] : null;

  let checked = 0, bad = 0, skipped = 0;
  for (const dir of DIRS) {
    const cdir = path.join(ROOT, dir, 'calc');
    if (!fs.existsSync(cdir)) { console.log('— 跳过（目录不存在）：' + dir); skipped++; continue; }
    const srcDir = SRC_OF[dir];
    if (!fs.existsSync(srcDir)) {
      console.log('✗ ' + dir + '：中间源码目录缺失（' + srcDir + '）—— 请先跑 tools/release-calculator.sh');
      bad++;
      continue;
    }
    for (const name of NAMES) {
      const enc = path.join(cdir, name + '.enc');
      if (!fs.existsSync(enc)) { console.log('✗ ' + dir + '/calc 缺 ' + name + '.enc'); bad++; continue; }
      let plain, expect;
      try { plain = decrypt(enc); }
      catch (e) { console.log('✗ ' + dir + '/calc/' + name + '.enc 解不开：' + e.message); bad++; continue; }
      try { expect = await P.polish(fs.readFileSync(path.join(srcDir, name), 'utf8'), path.extname(name)); }
      catch (e) { console.log('✗ 打磨失败（' + name + '）：' + (e && e.message || e)); bad++; continue; }
      checked++;
      if (plain !== expect) {
        bad++;
        // 给出第一个差异位置，方便定位是哪一段旧了/漂了
        let i = 0;
        while (i < plain.length && i < expect.length && plain[i] === expect[i]) i++;
        console.log('✗ ' + dir + '/calc/' + name + '.enc 与打磨稿不一致' +
          '（明文 ' + plain.length + ' vs 期望 ' + expect.length + ' 字节，首个差异 @' + i + '）→ 旧版或打磨漂移');
      } else {
        console.log('✓ ' + dir + '/calc/' + name + '.enc 与最新源码逐字节一致（' + plain.length + ' 字节，已去注释+混淆）');
      }
      // 顺手守一条卫生：不能有明文同名文件躺在发布目录里
      const plainPath = path.join(cdir, name);
      if (fs.existsSync(plainPath)) { console.log('✗ ' + dir + '/calc 里躺着明文 ' + name + '（源码泄漏）'); bad++; }
      if (dumpName && name === dumpName) {
        fs.writeFileSync(path.join(__dirname, '_calc_dump.' + name.split('.').pop()), plain, 'utf8');
        console.log('  （已 dump 解密明文 → tools/_calc_dump.' + name.split('.').pop() + '）');
      }
    }
  }
  console.log('\n' + (bad ? '✗ ' + bad + ' 处不对' : '✓ 发布版就是最新代码（逐字节）') +
    '（检查 ' + checked + ' 个密文，跳过 ' + skipped + ' 个目录）');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
