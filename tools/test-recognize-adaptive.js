// test-recognize-adaptive.js — 自适应棋盘识别核心的回归测试
//
// 故障背景（用户实测）：某站点棋盘是「浅米色底 #f2ead8（亮度 234）+ 棕色细线」，
//   旧读子逻辑用绝对亮度阈值判白（gray > 215）→ 每个空交点都满足「够亮 + 低饱和」→
//   225 个交点读出 224 个假白子 → 面板误报「对手已五子连珠·我方落败」（实际只下了 2 子）。
//
// 本测试两层把关：
//   ① 源码契约：确认新识别链路（自适应读子 / 形状验证 / 网格兜底 / 不变量闸门 / 面板护栏）
//      的关键实现都在，且旧的绝对阈值写法已不存在；
//   ② 功能自测：调用 tools/recognize_selftest.py（合成 5 种底色 × 空盘/中局/边角/密集棋簇
//      + 淡线 + Hough 兜底 + 不变量），以及 tools/recog_vaccine_selftest.py（识别预防针：
//      极端浅/深底、光泽棋子、反识别手段、空盘假阳性、缩放），要求全通过。
//
// ⚠ 本测试测的是**Python 参考实现**（仓库保留、只用于开发期对拍，**不进发布包**）。
//   对外发布的实现已换成 C++ 的 GomokuVision.exe —— 守住它的见
//   tools/test-vision-service.js 与 tools/test-vision-parity.js（预防针矩阵逐子对拍）。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PYDIR = path.join(ROOT, 'engine-server', 'python');
const DETECTOR = fs.readFileSync(path.join(PYDIR, 'gomoku_assistant', 'detector.py'), 'utf8');
const ADAPTIVE = fs.readFileSync(path.join(PYDIR, 'gomoku_assistant', 'adaptive.py'), 'utf8');
const SERVER = fs.readFileSync(path.join(PYDIR, 'recognize_server.py'), 'utf8');
const SCREEN_BOARD = fs.readFileSync(path.join(PYDIR, 'gomoku_assistant', 'screen_board.py'), 'utf8');
const BM = fs.readFileSync(path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = (got === want);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

console.log('--- 源码契约：旧绝对阈值已移除 ---');
eq('detector 判白改用随底色自适应的 bright_thr',
   DETECTOR.includes('patch_gray > bright_thr'), true);
eq('detector 不再出现写死的 215 判白阈值',
   DETECTOR.includes('patch_gray > 215'), false);
eq('detector.read_stones 接受底色亮度参数 bg_level',
   /def read_stones\([^)]*bg_level/.test(DETECTOR), true);

console.log('--- 源码契约：自适应读子核心（OpenCV 官方手段）---');
eq('局部背景用掩膜归一化盒滤波（排除非背景像素）', ADAPTIVE.includes('cv2.boxFilter'), true);
eq('形状验证用连通域统计', ADAPTIVE.includes('connectedComponentsWithStats'), true);
eq('圆度用官方 arcLength/contourArea', ADAPTIVE.includes('cv2.arcLength') && ADAPTIVE.includes('cv2.contourArea'), true);
eq('网格兜底用官方自动 Canny + HoughLinesP',
   ADAPTIVE.includes('cv2.Canny') && ADAPTIVE.includes('cv2.HoughLinesP'), true);
eq('有棋理不变量自诊断（suspect 闸门）', ADAPTIVE.includes('def invariants'), true);
eq('边缘补零：边角棋子不再被越界检查跳过',
   ADAPTIVE.includes('copyMakeBorder'), true);
eq('等距格对齐用线感证据 + 居中先验（防整体错格）',
   ADAPTIVE.includes('_line_evidence') && ADAPTIVE.includes('_snap_lattice'), true);
// ★ 外边界伪棋子清理：棋盘外框/窗口边框被读成「最外一行整行同色」→ 黑白失衡 →
//   invariants 判 suspect → 宿主丢弃整帧 → 面板永远显示「未检测到棋盘」（用户实测故障）。
eq('有「外边界整行/整列同色」伪棋子清理',
   ADAPTIVE.includes('def strip_border_artifacts'), true);
eq('清理只在四条外边界上做（绝不碰内部，真实棋形含五连不会被误删）',
   /for r in \(0, n - 1\):/.test(ADAPTIVE) && /for c in \(0, n - 1\):/.test(ADAPTIVE), true);
eq('清理阈值按棋理设（≥8 且 ≥80% 格数，任何合法局面都不可能）',
   /min_run = max\(8, int\(round\(n \* min_ratio\)\)\)/.test(ADAPTIVE), true);
eq('★ 清理必须发生在 invariants 之前（不变量判定的是清理后的真实盘面）',
   ADAPTIVE.indexOf('removed = strip_border_artifacts(board, conf)') >= 0 &&
   ADAPTIVE.indexOf('removed = strip_border_artifacts(board, conf)') <
   ADAPTIVE.indexOf('diag.update(invariants(board))'), true);
eq('diag 回传 border_artifacts 便于定位',
   ADAPTIVE.includes('"border_artifacts": removed'), true);

console.log('--- 源码契约：exclude 抹除必须先拿可写副本 ---');
// ★ 实测故障（用户报「之前识别挺流畅，现在识别不了、看不到识别框」）：
//   capture_screen 用 np.asarray(img.convert("RGB")) —— Pillow 12 起这返回**只读**视图，
//   _mask_excluded 直接原地写入抛 ValueError → 服务回 {"ok":false} →
//   宿主每一帧都带 exclude（面板矩形）→ 永远拿不到 found → 面板永远「未检测到棋盘」。
eq('capture_screen 抓屏路径存在（改动别挪走别处的判据）',
   SCREEN_BOARD.includes('def capture_screen'), true);
eq('★ 抹除前检查数组可写性（只读视图就先复制）',
   SCREEN_BOARD.includes('flags.writeable'), true);
eq('★ 不再有「先取别名再原地写」的写法（out = rgb）',
   /^\s*out = rgb\s*$/m.test(SCREEN_BOARD), false);
eq('可写守卫出现在 _mask_excluded 内部（不是别处顺手写的）',
   SCREEN_BOARD.indexOf('flags.writeable') > SCREEN_BOARD.indexOf('def _mask_excluded') &&
   SCREEN_BOARD.indexOf('flags.writeable') < SCREEN_BOARD.indexOf('def _count_distinct_boards'), true);
eq('无 exclude 时提前返回（不复制，省掉每帧一张全屏拷贝）',
   /if not exclude:\s*\n\s*return rgb/.test(SCREEN_BOARD), true);

console.log('--- 源码契约：空心/描边棋子（浅底白子=深环，深底黑子=浅环）---');
eq('有独立的径向分区工具（内盘 / 描边环带 / 角向扇区）',
   ADAPTIVE.includes('def _radial_maps'), true);
eq('有独立的径向判色函数', ADAPTIVE.includes('def decide_color'), true);
eq('存在性由「环带角向闭合」判定，而非内盘亮度（粗网格线棋盘空点内盘本就半暗）',
   /if arc < RING_ARC_MIN and cover < RING_COVER_MIN:/.test(ADAPTIVE), true);
eq('角向分箱 + 环形连续弧（容纳多半圈描边 + 落影）',
   ADAPTIVE.includes('RING_SECTORS') && ADAPTIVE.includes('RING_ARC_MIN'), true);
eq('内盘与底色不可分辨时改由描边环极性定色',
   /WHITE if med < 0 else BLACK/.test(ADAPTIVE), true);
eq('深环判白 / 亮环判黑（两种底色的对称画法）',
   ADAPTIVE.includes('RING_R0') && ADAPTIVE.includes('RING_R1'), true);
eq('主路径判色走径向证据（不再用整块连通域中位数）',
   ADAPTIVE.includes('color, cconf = decide_color(patch, core_m, ring_m, ring_sec, thr)'), true);
eq('新证据不足时仍回退旧中位数判法（防既有场景回归）',
   ADAPTIVE.includes('回退到旧的「整块中位数」判法'), true);

console.log('--- 源码契约：识别服务编排 ---');
eq('服务端走自适应读子 + 旧路径二次意见', SERVER.includes('adaptive.read_stones_adaptive') &&
   SERVER.includes('_arbitrate'), true);
eq('服务端返回 suspect 供前端否决', SERVER.includes('"suspect": bool'), true);
eq('网格合理性校验（防重复/不齐假网格）', SERVER.includes('_grid_plausible'), true);
eq('网格线极性自适应（深色主题亮线）', SERVER.includes('_line_polarity'), true);
eq('精修不会把网格推走（原点漂移闸门）', SERVER.includes('step0 * 0.35'), true);

console.log('--- 源码契约：面板侧护栏 ---');
eq('面板尊重服务端 suspect 判决', BM.includes('&& !data.suspect'), true);
eq('面板丢弃「整盘近乎同色 / 黑白严重失衡」的读子结果',
   BM.includes('py board rejected: black='), true);
eq('页面内 JS 读子阈值随底色自适应（亮底可读白子）',
   BM.includes('var needDev = Math.min(22, Math.max(7, (255 - bgBright) * 0.35));'), true);

// 功能自测：交给 Python（合成棋盘，多底色 + 多局面）
console.log('--- 功能自测：合成棋盘读子（python 子进程）---');
const py = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const script = path.join(ROOT, 'tools', 'recognize_selftest.py');
if (!fs.existsSync(py)) {
  fail++; console.log('  ✗ 找不到便携 Python 运行时（tools/python-bundle/runtime/python.exe）');
} else {
  const r = spawnSync(py, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const okN = (out.match(/^\s*✓/gm) || []).length;
  const badN = (out.match(/^\s*✗/gm) || []).length;
  const m = out.match(/---\s+(\d+) passed,\s+(\d+) failed\s+---/);
  pass += m ? +m[1] : okN;
  fail += m ? +m[2] : badN;
  // 注意：成功时不要打印 "N passed, M failed" 字样，否则总跑测 _runall.js 会先匹配到
  // 子进程这一行、漏掉本文件自身的 18 条源码契约断言。
  const pySummary = m ? (m[2] === '0' ? 'OK（' + m[1] + ' 条断言）' : m[1] + ' 通过 / ' + m[2] + ' 失败')
                      : '未产出汇总行';
  console.log('  （Python 自测：' + pySummary + '，exit=' + r.status + '）');
  if (r.status !== 0 || badN > 0) {
    out.split('\n').filter(l => /^\s*✗/.test(l)).slice(0, 10).forEach(l => console.log('    ' + l.trim()));
  }
}

// 识别预防针（2026-09-19 用户要求「优先提升识别能力」）：极端浅/深底、光泽棋子、
// 反识别手段（水印/噪声/JPEG）、空盘假阳性防线、缩放 —— 全走生产 recognize() 管线。
console.log('--- 识别预防针：极端场景矩阵（python 子进程）---');
{
  const script2 = path.join(ROOT, 'tools', 'recog_vaccine_selftest.py');
  const r = spawnSync(py, [script2], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const okN = (out.match(/^\s*✓/gm) || []).length;
  const badN = (out.match(/^\s*✗/gm) || []).length;
  const m = out.match(/(?:---\s+|==\s*recog_vaccine:\s*)(\d+) passed,\s+(\d+) failed/);
  pass += m ? +m[1] : okN;
  fail += m ? +m[2] : badN;
  const pySummary = m ? (m[2] === '0' ? 'OK（' + m[1] + ' 条断言）' : m[1] + ' 通过 / ' + m[2] + ' 失败')
                      : '未产出汇总行';
  console.log('  （预防针：' + pySummary + '，exit=' + r.status + '）');
  if (r.status !== 0 || badN > 0) {
    out.split('\n').filter(l => /^\s*✗/.test(l)).slice(0, 10).forEach(l => console.log('    ' + l.trim()));
  }
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
