/* 识别移植等价性护栏：C++ 版（GomokuVision.exe）与 Python 参考实现逐子对拍
 * ============================================================================
 * 换装的正确定性只有一条硬指标：**在完全相同的激励上给出完全相同的结果**。
 * tools/vision-parity.py 复用当年现场钉出来的「预防针」矩阵（A~H：浅底白子 / 深盘黑子 /
 * 拟真光泽子 / 反识别手段 / 空盘假阳性防线 / 缩放 / 整屏同色系背景 / 屏江与五林现场截图）
 * 外加 I~J（五林真实截图 / 整屏找盘等距线族配对），逐子比对黑白子集合、棋盘矩形与
 * multi_board 计数。
 *
 * 全离线：两侧都走「离线单图入口」，不需要先起任何服务。
 * 需要仓库里的 Python 参考实现与便携运行时（都只用于开发期对拍，不进发布包）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const SCRIPT = path.join(__dirname, 'vision-parity.py');
const EXE = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');

console.log('--- 逐子对拍：C++ 识别服务 vs Python 参考实现 ---');
if (!fs.existsSync(EXE)) {
  console.log('  ✗ 找不到 GomokuVision.exe（请先跑 node tools/build-vision.js）');
  console.log('\n--- 0 passed, 1 failed ---');
  process.exit(1);
}
if (!fs.existsSync(PY) || !fs.existsSync(SCRIPT)) {
  console.log('  … 缺 Python 参考实现 / 便携运行时（只用于开发期对拍），跳过');
  console.log('\n--- 0 passed, 0 failed ---');
  process.exit(0);
}

const r = spawnSync(PY, [SCRIPT], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const out = (r.stdout || '') + (r.stderr || '');
const m = out.match(/parity:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
const subPass = m ? +m[1] : 0;
const subFail = m ? +m[2] : 1;

// 各分段标题保留下来（一眼看出哪一段红了），但**绝不能**把子进程那行
// "N passed, M failed" 打出来 —— _runall.js 用首个匹配解析，会被它抢先。
out.split('\n')
  .filter((l) => (/^==\s/.test(l) || /^\s*✗/.test(l)) && !/passed,/.test(l))
  .slice(0, 24)
  .forEach((l) => console.log('  ' + l.trim()));

console.log('\n--- ' + (m ? subPass : 0) + ' passed, ' + (m ? subFail : 1) + ' failed ---');
process.exit(subFail ? 1 : 0);
