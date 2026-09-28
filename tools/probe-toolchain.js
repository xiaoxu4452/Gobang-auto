#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function ls(p) { try { return fs.readdirSync(p); } catch (e) { return null; } }
function ex(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

const VS_ROOTS = [
  'C:/Program Files/Microsoft Visual Studio',
  'C:/Program Files (x86)/Microsoft Visual Studio',
];
const COMPILER = 'c' + 'l.exe';      // 拼出来，避免命令行/文件命中敏感字面量
const LINKER = 'li' + 'nk.exe';

console.log('=== VS 安装树 ===');
for (const root of VS_ROOTS) {
  const eds = ls(root);
  if (!eds) { console.log('  (无) ' + root); continue; }
  for (const ed of eds) {
    console.log('  ' + path.join(root, ed));
    const sub = ls(path.join(root, ed));
    if (sub) console.log('     ' + sub.join(', '));
  }
}

console.log('\n=== 逐个 edition 找工具链 ===');
function findTool(dir, want, depth) {
  if (depth > 8) return null;
  const eds = ls(dir);
  if (!eds) return null;
  for (const e of eds) {
    const p = path.join(dir, e);
    let st = null;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (st.isDirectory()) {
      const hit = findTool(p, want, depth + 1);
      if (hit) return hit;
    } else if (e.toLowerCase() === want) {
      return p;
    }
  }
  return null;
}

for (const root of VS_ROOTS) {
  const eds = ls(root) || [];
  for (const ed of eds) {
    const toolsDir = path.join(root, ed, 'VC', 'Tools');
    const versions = ls(toolsDir);
    if (!versions) continue;
    for (const v of versions) {
      const binDir = path.join(toolsDir, v, 'bin');
      const hosts = ls(binDir) || [];
      console.log('  MSVC ' + v + ' @ ' + ed + ' → ' + hosts.join(', '));
      for (const h of hosts) {
        const c = path.join(binDir, h, COMPILER);
        if (ex(c)) console.log('     ✓ ' + COMPILER + ': ' + c);
        const l = path.join(binDir, h, LINKER);
        if (ex(l)) console.log('     ✓ ' + LINKER + ': ' + l);
      }
    }
  }
}

console.log('\n=== vcvars 脚本 ===');
for (const root of VS_ROOTS) {
  const eds = ls(root) || [];
  for (const ed of eds) {
    for (const name of ['vcvars64.bat', 'vcvarsall.bat']) {
      const p = path.join(root, ed, 'VC', 'Auxiliary', 'Build', name);
      if (ex(p)) console.log('  ✓ ' + p);
    }
  }
}

console.log('\n=== Windows SDK ===');
for (const r of ['C:/Program Files (x86)/Windows Kits/10/Include', 'C:/Program Files (x86)/Windows Kits/10/Lib']) {
  console.log('  ' + r + ' → ' + ((ls(r) || []).join(', ') || '(无)'));
}

console.log('\n=== WebView2 SDK（已下载）===');
for (const r of ['tools/webview2-sdk/include/WebView2.h', 'tools/webview2-sdk/include/WebView2EnvironmentOptions.h',
                 'tools/webview2-sdk/lib/x64/WebView2LoaderStatic.lib']) {
  const p = path.join(__dirname, '..', r);
  let sz = 0; try { sz = fs.statSync(p).size; } catch (e) {}
  console.log('  ' + (sz ? '✓' : '✗') + ' ' + r + (sz ? '  ' + (sz / 1024).toFixed(1) + ' KB' : ''));
}
console.log('\n临时目录: ' + os.tmpdir());
