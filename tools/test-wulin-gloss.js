/* 拟真「光泽棋子」识别回归（五林五子棋现场截图）
 * ① 源码契约：光泽棋子的三段判据还在，且**顺序**没被换过
 * ② 基准自测：tools/wulin_gloss_selftest.py —— 拿用户现场截图跑真识别链路
 *
 * 背景（用户 2026-09-18）：「适配五林五子棋的棋盘的棋子，因为这种棋子是有光泽的」
 *   这种棋子的高光 + 径向渐变让它**没有清晰的边**，白子在亮木底上「棋子 vs 底色」
 *   的对比一路渐隐到 0；而木纹照片盘的全局阈值 thr≈71，白子内部最大偏离只有 ~49
 *   —— 只靠全局阈值，白子会整颗消失。救回来的是「逐格中位数」（内盘 vs 格子四角），
 *   实测白子 lc=25~34、空点 |lc|≤9，余量 2.8 倍。
 *   这两条数字在基准自测里都被断言，改坏了立刻红。
 *
 * ⚠ 本测试测的是**Python 参考实现**（仓库保留、只用于开发期对拍，**不进发布包**）。
 *   对外发布的实现已换成 C++ 的 GomokuVision.exe —— 守住它的见
 *   tools/test-vision-service.js 与 tools/test-vision-parity.js（预防针矩阵逐子对拍）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AD = fs.readFileSync(path.join(ROOT, 'engine-server', 'python', 'gomoku_assistant',
                                    'adaptive.py'), 'utf8');
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'wulin_gloss_board.jpg');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

console.log('--- 源码契约：拟真光泽棋子的三段判据 ---');
eq('基准图存在（现场截图裁到只剩棋盘）', fs.existsSync(FIXTURE), true);
eq('凸包圆度复核在（掩膜被高光/落影切成新月时，外轮廓的凸包仍是那个圆）',
   AD.includes('HULL_CIRC_MIN'), true);
eq('凸包门限 0.80（正圆轮廓实测 0.85~0.95，方格/十字凸包 ≤ π/4≈0.785）',
   /HULL_CIRC_MIN = 0\.80/.test(AD), true);
eq('注释里点明「拟真棋子 / 五林五子棋」（口径可追溯）',
   AD.includes('拟真棋子') && AD.includes('五林五子棋'), true);
eq('逐格存在性判据在（内盘 vs 格子四角的中位数差）',
   AD.includes('CELL_CONTRAST_MIN') && AD.includes('CELL_FILL_MIN') &&
   AD.includes('def _cell_bg_masks'), true);
eq('判色走径向证据（内盘定色 / 环带角向闭合）',
   AD.includes('def decide_color') && AD.includes('RING_SECTORS'), true);
eq('外边界伪棋子清理仍在（连 5 即终局 → 整行同色必是外框）',
   AD.includes('def strip_border_artifacts'), true);
// 顺序是个真坑：逐格兜底必须**排在描边兜底之前**，否则「实心高光白子」会被
// 「内盘不够暗」读成黑子（adaptive.py 里有原文注释钉着）。
eq('★ 逐格兜底排在描边兜底之前（顺序反了会把高光白子读成黑子）',
   AD.indexOf('cell_rescued = 0') < AD.indexOf('outline_hits = 0') &&
   AD.indexOf('cell_rescued = 0') > 0, true);
eq('★ 逐格兜底只放宽**本格**阈值（thr_cell = |lc| × 比例，再夹在 [下限, 全局 thr]）',
   AD.includes('thr_cell') && AD.includes('CELL_THR_RATIO'), true);
eq('★ 边界格的局部底色要并进「盘外的角」（防木底边缘暗角被读成黑子）',
   AD.includes('def cell_bg_union') && AD.includes('cell_bg_union(cell_bg, row, col, n)'),
   true);

// —— 棋盘外框线陷阱（2026-09-19 修）——
// 木/照片底棋盘最外圈还有一条**装饰外框线**，它落在真格线外侧 ~0.87 格处
// （现场实测：原图行轴外框 y=73.5，第一条**可落子**格线 y=143.5；列轴 72.5 vs 142.5）。
// 它与真格线的间距（≈70px）和格距（≈80.7px）不同，所以不属于那 15 条等距线族。
// 老实现只奖励「峰值强度 + 吸附规整度」，会把外框当第 0 行 → 整盘每颗子差一格；
// 而且**缩放后又自己变对** → 同一盘面在不同截屏倍率下解出不同坐标。
// 判据：真棋盘 15 条线严格等距（间距 CV≈0.004~0.006），掺进外框立刻 0.03+。
const DET = fs.readFileSync(path.join(ROOT, 'engine-server', 'python', 'gomoku_assistant',
                                     'detector.py'), 'utf8');
eq('★ 点阵「重锚」护栏在（防外框线把整条点阵拽偏一格）',
   DET.includes('def _reanchor_regular') && DET.includes('def _spacing_cv'), true);
eq('★ 护栏按「间距最均匀」定胜负（真棋盘 CV≈0.005，掺外框 → 0.03+）',
   DET.includes('viable.sort(key=lambda c: c[1])'), true);
eq('★ _fit_axis 与 _locate_stretched 两个轴都接了护栏',
   (DET.match(/_reanchor_regular\(/g) || []).length >= 4, true);
eq('★ 注释写明「0.87 格」这个实测数字（口径可追溯）',
   DET.includes('0.87'), true);

// 功能自测：交给 Python（真识别链路 + 实测数字）
console.log('--- 基准自测：现场截图跑真识别链路（python 子进程）---');
const py = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const script = path.join(ROOT, 'tools', 'wulin_gloss_selftest.py');
if (!fs.existsSync(py)) {
  fail++; console.log('  ✗ 找不到便携 Python 运行时');
} else {
  const r = spawnSync(py, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const bad = (out.match(/^\s*✗/gm) || []).length;
  const m = out.match(/---\s+(\d+) passed,\s+(\d+) failed\s+---/);
  pass += m ? +m[1] : 0;
  fail += m ? +m[2] : bad;
  // 注意：成功时不要打印 "N passed, M failed" 字样，否则 _runall.js 会先匹配到子进程这一行
  console.log('  （Python 自测：' + (m
    ? (m[2] === '0' ? 'OK（' + m[1] + ' 条断言）' : m[1] + ' 通过 / ' + m[2] + ' 失败')
    : '未产出汇总行') + '，exit=' + r.status + '）');
  out.split('\n').filter(l => /^\s*\[实测\]/.test(l)).forEach(l => console.log('  ' + l.trim()));
  if (r.status !== 0 || bad > 0) {
    out.split('\n').filter(l => /^\s*✗/.test(l)).slice(0, 10).forEach(l => console.log('    ' + l.trim()));
  }
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
