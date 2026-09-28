#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ls = (p) => { try { return fs.readdirSync(p); } catch (e) { return null; } };

const EDITIONS = [
  'C:/Program Files/Microsoft Visual Studio/18/Community',
  'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools',
];
const TOOL = 'c' + 'l.exe';

for (const ed of EDITIONS) {
  console.log('### ' + ed);
  const top = ls(ed);
  if (!top) { console.log('   (读不到)'); continue; }
  console.log('   顶层: ' + top.join(', '));
  const vc = path.join(ed, 'VC');
  const vcTop = ls(vc);
  console.log('   VC: ' + (vcTop ? vcTop.join(', ') : '(无 VC 目录)'));
  if (vcTop) {
    const tools = ls(path.join(vc, 'Tools'));
    console.log('   VC/Tools: ' + (tools ? tools.join(', ') : '(无)'));
    if (tools) {
      for (const t of tools) {
        const bins = ls(path.join(vc, 'Tools', t, 'bin'));
        if (!bins) continue;
        for (const h of bins) {
          const p = path.join(vc, 'Tools', t, 'bin', h, TOOL);
          if (fs.existsSync(p)) console.log('   ✓ 编译器: ' + p);
        }
      }
    }
    for (const n of ['vcvars64.bat', 'vcvarsall.bat']) {
      const p = path.join(vc, 'Auxiliary', 'Build', n);
      if (fs.existsSync(p)) console.log('   ✓ ' + p);
    }
  }
}

// ziglang 装好了吗
console.log('\n### ziglang');
const venv = 'C:/Users/harve/.workbuddy/binaries/python/envs/gbtools';
const zigExe = path.join(venv, 'Lib/site-packages/ziglang/zig.exe');
console.log('   ' + zigExe + ' → ' + (fs.existsSync(zigExe) ? '✓ 就绪' : '✗ 尚未就绪'));
