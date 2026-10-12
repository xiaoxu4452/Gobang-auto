#!/usr/bin/env node
/**
 * 生成 desktop-calculator/src/appver.rc —— 把 calc.js 里的 APP_VERSION 编进 exe 的
 * VERSIONINFO 资源，这样：
 *   · 资源管理器右键属性 / PowerShell / 网盘工具都能「解析 EXE 文件」看到版本号；
 *   · 打包脚本（tools/pkg-7z.js）直接从 exe 里读版本来命名压缩包，不用再另存一份常量。
 *
 * ★ 版本号仍然只有一个来源 —— desktop-calculator/ui/calc.js 的 `var APP_VERSION = '4.33';`。
 *   想改版本号就改那一行，exe 资源、关于页、压缩包名会一起跟着变。
 *
 * 用法：
 *   node tools/gen-appver-rc.js                 # 从 calc.js 读，写到 src/appver.rc
 *   node tools/gen-appver-rc.js --ver 4.34      # 强制指定（临时验证用）
 *   node tools/gen-appver-rc.js --print         # 只打印解析出的版本，不写文件
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// ★ 2026-10-06（连线版）：支持 --calc / --out-dir（fork 源码树各自生成，互不覆盖）。
const CALC = path.join(ROOT, process.argv.includes('--calc')
  ? path.relative(ROOT, process.argv[process.argv.indexOf('--calc') + 1]).replace(/\\/g, '/')
  : 'desktop-calculator/ui/calc.js');
const OUTDIR2 = process.argv.includes('--out-dir')
  ? process.argv[process.argv.indexOf('--out-dir') + 1]
  : path.join(ROOT, 'desktop-calculator', 'src');
const OUT = path.join(OUTDIR2, 'appver.rc');
const HOUT = path.join(OUTDIR2, 'appver.h');

/** 从 calc.js 里抠 `var APP_VERSION = '4.33';`（注释里的样例不会误命中：只认这一行的声明式）。 */
function readAppVersion() {
  const s = fs.readFileSync(CALC, 'utf8');
  const m = s.match(/^\s*var\s+APP_VERSION\s*=\s*'([^']+)'\s*;/m);
  if (!m) throw new Error('calc.js 里找不到 `var APP_VERSION = \'x.y\';`');
  return m[1];
}

/** '4.33' / '4.3.30' / '4.33.1' → [4,33,0,0]（不足补 0，非数字按 0）。 */
function toQuads(ver) {
  const parts = String(ver).split(/[.\-+_]/).map((x) => parseInt(x, 10)).map((n) => (isNaN(n) ? 0 : n));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const ver = val('--ver') || readAppVersion();
const [a, b, c, d] = toQuads(ver);
const vs = `${a}.${b}.${c}.${d}`;

if (flag('--print')) { console.log(vs); process.exit(0); }

// ★ 全 ASCII：rc.exe 对含中文的 .rc 会按 ANSI 解释，写中文容易变乱码。
const rc =
  '/* 自动生成，勿手改 —— 由 tools/gen-appver-rc.js 从 calc.js 的 APP_VERSION 生成。 */\n' +
  '#include <winver.h>\n' +
  '\n' +
  'VS_VERSION_INFO VERSIONINFO\n' +
  ` FILEVERSION    ${a},${b},${c},${d}\n` +
  ` PRODUCTVERSION ${a},${b},${c},${d}\n` +
  ' FILEFLAGSMASK  0x3fL\n' +
  ' FILEFLAGS      0x0L\n' +
  ' FILEOS         0x40004L\n' +
  ' FILETYPE       0x1L\n' +
  ' FILESUBTYPE    0x0L\n' +
  'BEGIN\n' +
  '    BLOCK "StringFileInfo"\n' +
  '    BEGIN\n' +
  '        BLOCK "040904b0"\n' +
  '        BEGIN\n' +
  '            VALUE "CompanyName",      "Meter"\n' +
  '            VALUE "FileDescription",  "Desktop Gomoku Trainer"\n' +
  `            VALUE "FileVersion",      "${vs}"\n` +
  '            VALUE "InternalName",     "Desktop GomokuTrainer"\n' +
  '            VALUE "LegalCopyright",   "Meter"\n' +
  '            VALUE "OriginalFilename", "Desktop GomokuTrainer.exe"\n' +
  '            VALUE "ProductName",      "Meter Gomoku Trainer"\n' +
  `            VALUE "ProductVersion",   "${vs}"\n` +
  '        END\n' +
  '    END\n' +
  '    BLOCK "VarFileInfo"\n' +
  '    BEGIN\n' +
  '        VALUE "Translation", 0x409, 1200\n' +
  '    END\n' +
  'END\n';

fs.writeFileSync(OUT, rc, 'utf8');
console.log(`[appver] APP_VERSION=${ver} → ${vs} → ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);

// ★ 2026-09-29（检查更新）：同时产出一个极简头文件，让 C++ 宿主也能拿到版本号（单来源，
//   避免 C++ 与 calc.js 两处漂移）。winhttp 检查远端安装包版本时直接吃 APP_VER。
const h =
  '/* 自动生成，勿手改 —— 由 tools/gen-appver-rc.js 从 calc.js 的 APP_VERSION 生成。 */\n' +
  '#pragma once\n' +
  '#define APP_VER "' + ver + '"\n' +
  '#define APP_VER_DISPLAY "v' + ver + '"\n';
fs.writeFileSync(HOUT, h, 'utf8');
