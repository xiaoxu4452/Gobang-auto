/* 整屏棋盘定位回归（桌面覆盖层应用的核心能力）
 * ① 源码契约：关键函数与踩过的坑是否还在
 * ② 功能自测：调用 tools/screen_board_selftest.py（合成屏幕：整幅棋盘 / 屏幕局部棋盘 / 无棋盘）
 *
 * ⚠ 本测试测的是**Python 参考实现**（仓库保留、只用于开发期对拍，**不进发布包**）。
 *   对外发布的实现已换成 C++ 的 GomokuVision.exe —— 守住它的见
 *   tools/test-vision-service.js（源码/产物/发布包契约 + 现场截图端到端）
 *   与 tools/test-vision-parity.js（预防针矩阵 A~J 逐子对拍）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = fs.readFileSync(path.join(ROOT, 'engine-server', 'python', 'gomoku_assistant', 'screen_board.py'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'engine-server', 'python', 'screen_scan_server.py'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

console.log('--- 源码契约：整屏棋盘定位 ---');
eq('有整屏定位模块', fs.existsSync(path.join(ROOT, 'engine-server', 'python', 'gomoku_assistant', 'screen_board.py')), true);
eq('抓屏支持多显示器（返回虚拟屏原点偏移）', SB.includes('ImageGrab.grab(all_screens=True)'), true);
eq('设置 DPI 感知（否则缩放屏坐标会错位）', SB.includes('SetProcessDpiAwareness'), true);
eq('Canny 阈值由梯度幅值 Otsu 决定（不用灰度中位数）',
   SB.includes('cv2.THRESH_BINARY + cv2.THRESH_OTSU'), true);
eq('线簇保留线段总长度（防短碎线盖过棋盘线）', SB.includes('def _weighted_clusters'), true);
eq('等距族允许跳过缺失线（否则缺一条就凑不齐）', SB.includes('可能整段缺失'), true);
eq('长度门槛相对最长线（不用分位，防误删棋盘线）', SB.includes('thr_len'), true);
eq('横竖族需真实交叉（防网页文字行被当成棋盘）', SB.includes('def _pair_once') && SB.includes('inter_x'), true);
eq('支持格距成整数倍的子采样配对', SB.includes('def _subsample'), true);
eq('多尺度 + 多线长档位（适配任意分辨率/窗口大小）',
   SB.includes('scales=(1.0, 0.6)') && SB.includes('len_ratios=(0.05, 0.10)'), true);
eq('读子在棋盘裁剪区内做（否则全局众数取到桌面色）', SB.includes('def crop_board'), true);
eq('支持跟踪模式（hint 附近优先搜索）', SB.includes('def _search_near'), true);

console.log('--- 源码契约：扫描服务 ---');
eq('扫描服务存在', fs.existsSync(path.join(ROOT, 'engine-server', 'python', 'screen_scan_server.py')), true);
eq('服务有单实例锁（多实例会读到旧状态）', SRV.includes('gomoku_scan_') && SRV.includes('msvcrt'), true);
eq('服务提供 /scan 与 /quit', SRV.includes('/scan') && SRV.includes('/quit'), true);
eq('自动沿用上一帧位置加速', SRV.includes('_last["res"]'), true);

// 功能自测：交给 Python
console.log('--- 功能自测：合成屏幕定位（python 子进程）---');
const py = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const script = path.join(ROOT, 'tools', 'screen_board_selftest.py');
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
  console.log('  （Python 自测：' + (m ? (m[2] === '0' ? 'OK（' + m[1] + ' 条断言）' : m[1] + ' 通过 / ' + m[2] + ' 失败') : '未产出汇总行') +
              '，exit=' + r.status + '）');
  if (r.status !== 0 || bad > 0) {
    out.split('\n').filter(l => /^\s*✗/.test(l)).slice(0, 10).forEach(l => console.log('    ' + l.trim()));
  }
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
