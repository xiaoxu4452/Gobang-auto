/*
 * run-suite.js —— 依次跑所有测试脚本并把结果落盘（PortableGit shim 下管道常被吞，故写文件）
 * 用法: node tools/run-suite.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const scripts = process.argv.slice(2).length ? process.argv.slice(2)
  : ['tools/test-perspective.js', 'tools/test-evalcurve.js', 'tools/test-release.js'];
const outPath = path.join(ROOT, 'build-release', 'suite-output.txt');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

let all = '';
let failed = 0;
for (const s of scripts) {
  const p = path.join(ROOT, s);
  if (!fs.existsSync(p)) { all += '\n### 缺失: ' + s + '\n'; failed++; continue; }
  const r = spawnSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8' });
  const txt = (r.stdout || '') + (r.stderr || '');
  all += '\n==================================================\n### ' + s + '  (exit ' + r.status + ')\n';
  all += txt.split('\n').filter(l => /FAIL|passed|failed|/\s\d+ 通过/.test(l) || /^###/.test(l)).join('\n') || '(无 FAIL 行)';
  if (r.status !== 0) failed++;
}
all += '\n\n==================================================\n失败脚本数: ' + failed + '\n';
fs.writeFileSync(outPath, all, 'utf8');
process.stdout.write(all);
process.exit(failed ? 1 : 0);
