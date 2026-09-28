/* 识别服务（GomokuVision.exe · 官方 OpenCV C++ 自包含版）—— 现行实现的契约 + 端到端护栏
 * ============================================================================
 * 背景（2026-09-20 换装）：识别从「随包便携 Python + pip 装 opencv/numpy/pillow」
 *   换成**一个自包含的 C++ 单文件 EXE**（官方 OpenCV 5.0.0，只编 core/imgproc/imgcodecs
 *   三个模块并静态链接，约 6.7MB，零 DLL、零依赖）。发布包因此少了 193MB 的 python/。
 *
 * 本测试守四件事：
 *   A 源码契约：当年 Python 版一条条钉下来的「预防针」必须还在 C++ 里 ——
 *     换装最大的风险不是编译不过，而是**移植时把某个防护分支丢了**，而且丢得很安静。
 *   B 产物契约：EXE 在、体积合理、比源码新（防「跑了旧识别逻辑」的发布包）。
 *   C 发布包契约：两个发布目录都得有它，且**不许再有任何 Python 残留**。
 *   D 端到端：真跑 --scan-image / --recognize-image，现场截图里得认出棋盘与棋子。
 *
 * 另有一个更狠的等价性护栏：tools/vision-parity.py（预防针矩阵 A~J 逐子对拍），
 * 由 tools/test-vision-parity.js 驱动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'desktop-vision', 'src');
const EXE = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---------------------------------------------------------------- A 源码契约

console.log('--- A) 源码契约：整屏找盘（screen_board.py → gbscreen.cpp）---');
const SCREEN = read('gbscreen.cpp');
eq('抓屏是多显示器虚拟屏 + DPI 感知（否则缩放屏坐标错位）',
   SCREEN.includes('SM_XVIRTUALSCREEN') && SCREEN.includes('setDpiAware'), true);
eq('用 GDI BitBlt 抓屏（替代 PIL.ImageGrab）', SCREEN.includes('BitBlt'), true);
eq('Canny 阈值由梯度幅值 Otsu 决定（不用灰度中位数）', SCREEN.includes('THRESH_OTSU'), true);
eq('等距族允许跳过缺失线（否则缺一条就凑不齐）', SCREEN.includes('可能整段缺失'), true);
eq('长度门槛相对最长线（不用分位，防误删棋盘线）', SCREEN.includes('thrLen'), true);
eq('横竖族需真实交叉（防网页文字行被当成棋盘）', SCREEN.includes('interX'), true);
eq('支持格距成整数倍的子采样配对', SCREEN.includes('subsampleFamily'), true);
eq('多尺度 + 多线长档位（适配任意分辨率/窗口大小）',
   SCREEN.includes('{1.0, 0.6}') && SCREEN.includes('{0.05, 0.10}'), true);
eq('读子在棋盘裁剪区内做（否则全局众数取到桌面色）', SCREEN.includes('cropBoard'), true);
// ★ 2026-09-25（用户要求）：「识别范围 = 棋盘边界线 + 再外扩 1/30 个棋盘」，且必须是
//   **半格 + 边长/30** 这个统一口径（与 host.cpp 的贴盘、gbrecognize 的吸附重试同款）——
//   老实现留的是 `spacing * 1.3`，多出来那一大圈全是盘外背景，会把 estimate_background 的
//   全局众数带偏（这正是下面那条注释警告的问题），贴边子也更难和盘外底色分开。
eq('裁剪余量 = 边界线 + 半格 + 棋盘边长/30（不再是凭空 1.3 格）',
   SCREEN.includes('double pad = (spacing * 0.5 + span / 30.0) * padMul;') &&
   !SCREEN.includes('double pad = spacing * padRatio;'), true);
eq('裁剪余量有「任何情况下不少于半格」的兜底', SCREEN.includes('if (pad < spacing * 0.5) pad = spacing * 0.5;'), true);
eq('★ 读子可疑时放大一倍余量重读一次（贴边被裁的盘面能救回来）',
   SCREEN.includes('wide_crop_retry') &&
   SCREEN.includes('cropBoard(masked, geo.xLines, geo.yLines, spacing, crop2, cx2, cy2, 2.0);'), true);
eq('支持跟踪模式（hint 附近优先搜索）', SCREEN.includes('searchNear'), true);

console.log('--- A) 源码契约：自适应读子（adaptive.py → gbadaptive.cpp）---');
const AD = read('gbadaptive.cpp');
eq('边界格局部底色并进「盘外」角（防边缘暗角被读成黑子）', AD.includes('cellBgUnion'), true);
eq('平斑块闸门 + 边界环边缘复核（反识别手段）',
   AD.includes('plateauGateVeto') && AD.includes('edgeOutM'), true);
eq('棋子核心半径常量与 Python 一致', AD.includes('constexpr double CORE_R = 0.26;'), true);
eq('阈值常量与 Python 一致（BASE_CONTRAST=10 / MAD_K=4 / 逐格 14）',
   AD.includes('constexpr double BASE_CONTRAST = 10.0;') &&
   AD.includes('constexpr double MAD_K = 4.0;') &&
   AD.includes('constexpr double CELL_CONTRAST_MIN = 14.0;'), true);
// ★ 2026-09-20 现场钉出来的 bug：patch 是**大于它的父矩阵**的子视图 → 不连续，
//   而 gatherI16/掩膜展平循环用 `ptr(0)[i]` 做行主序线性寻址，会跨过 patch 边界读到
//   父矩阵相邻列 → 整屏 /scan 路径上 225 格全部读成 0 子（几何却完全正确）。
//   修法就是 clone 成连续块；这条一旦被"优化"掉就会静默复发。
eq('★ 交叉点补丁必须 clone 成连续块（行序寻址不许回退）',
   /cv::Rect\(x - half, y - half, win, win\)\)\.clone\(\)/.test(AD), true);
eq('diff 用截断转 int16（对齐 numpy astype，不能用 convertTo 四舍五入）',
   AD.includes('(int16_t)((int)gp[c] - (int)(float)fp[c])'), true);
eq('边缘补 0（边角棋子取样窗口完整，否则永远读不到）',
   AD.includes('copyMakeBorder'), true);

console.log('--- A) 源码契约：点阵重锚 / 双路仲裁 / 服务 ---');
const DET = read('gbdetector.cpp');
eq('点阵重锚护栏（防棋盘装饰外框线被当第 0 行）', DET.includes('reanchorRegular'), true);
eq('两轴互救（lattice 互相纠正）', DET.includes('latticeRectangles'), true);
const REC = read('gbrecognize.cpp');
eq('旧路径独立复核 + 两路仲裁（不是单点判据）',
   REC.includes('readStonesRobust') && REC.includes('arbitrate'), true);
eq('棋理不变量闸门（连珠/手数合法性）', REC.includes('invariants'), true);
// ★ 2026-09-21 用户样张（裁边残盘只剩 14×13 条线，整线定位必然失败）：
//   晶格兜底 = 自相关周期+相位 → 活线定 k 区间 → 复用主路径读子 → 居中 partial。
//   Python 参考实现同步了同一套（_partial_grid_stones），两侧缺一即对拍口径破裂。
{
  const PYREC = fs.readFileSync(path.join(ROOT, 'engine-server', 'python', 'recognize_server.py'), 'utf8');
  eq('★ 残盘晶格兜底（裁边残盘）：C++ 周期/相位/活线/复用读子/居中 partial 全链',
     REC.includes('PartialGridStones') &&
     REC.includes('latticeAxis') && REC.includes('liveLines') &&
     /if \(cx < 0\.30 \|\| cy < 0\.30\) return false;/.test(REC) &&
     REC.includes('"partial_lattice"') &&
     /PartialGridStones\(img, size, p\)/.test(REC), true);
  eq('★ 残盘晶格兜底：Python 参考实现与 C++ 同口径（对拍前提）',
     PYREC.includes('_partial_grid_stones') &&
     PYREC.includes('_lattice_axis') && PYREC.includes('_live_lines') &&
     /if cx < 0\.30 or cy < 0\.30:/.test(PYREC) &&
     PYREC.includes('"partial_lattice"'), true);
  eq('★ 残盘兜底链顺序：晶格优先于找圆（周期信号比 HoughCircles 抗木纹伪圆）',
     REC.indexOf('PartialGridStones(img, size, p)') >= 0 &&
     REC.indexOf('PartialGridStones(img, size, p)') < REC.indexOf('PartialStonesFallback(gray, p)'), true);
}
const MAIN = read('main.cpp');
eq('单实例锁改用命名互斥体（替代 msvcrt 文件锁）', MAIN.includes('CreateMutexW'), true);
eq('角色分端口：--recognize(:8970) / --scan(:8971) / --both',
   MAIN.includes('"--recognize"') && MAIN.includes('"--scan"') && MAIN.includes('"--both"'), true);
eq('CORS：* + 私网预检头（缺了浏览器会把面板请求整体拦掉）',
   MAIN.includes('Access-Control-Allow-Origin') &&
   MAIN.includes('Access-Control-Allow-Private-Network'), true);
const GB = read('gb.cpp');
eq('JSON 分隔符与 Python json.dumps 同口径（": " / ", "）',
   GB.includes('": "') && GB.includes('", "'), true);
eq('非 ASCII 转义成 \\uXXXX（对齐 ensure_ascii=True）', GB.includes('\\u'), true);

// ---------------------------------------------------------------- B 产物契约

console.log('--- B) 产物契约 ---');
{
  // ★ 2026-09-26（用户报 playok 书签版识别被 Chrome 拦）：:8970 的应答必须带
  //   Access-Control-Allow-Private-Network —— https 公网页面 → 127.0.0.1 的 POST 在
  //   Chrome PNA 强制下一律先发预检，缺头 = 面板识别请求全被拦（回落页内 JS 识别=不准）。
  //   当年 :8971（覆盖层）修过同样的坑，:8970（书签）漏了 —— 这条断言把它钉死。
  const MAIN = read('main.cpp');
  eq(':8970 预检应答带 PNA 头（noContent(true)）', /OPTIONS"\) return noContent\(true\)/.test(MAIN), true);
  eq(':8970 不再有无 PNA 的应答（corsHeaders(false) 清零）', (MAIN.match(/corsHeaders\(false\)/g) || []).length, 0);
}
eq('GomokuVision.exe 已编译', fs.existsSync(EXE), true);
if (fs.existsSync(EXE)) {
  const mb = fs.statSync(EXE).size / 1024 / 1024;
  // 静态链接 OpenCV 三模块的合理区间：小于 4MB 说明模块没链接全，大于 20MB 说明编多了
  eq('体积在 4~20MB（单文件静态链接，零 DLL）', mb > 4 && mb < 20, true);
  console.log('    （实测 ' + mb.toFixed(2) + ' MB）');
  let newest = 0, newestName = '';
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.cpp') && !f.endsWith('.h')) continue;
    const m = fs.statSync(path.join(SRC, f)).mtimeMs;
    if (m > newest) { newest = m; newestName = f; }
  }
  eq('EXE 比源码新（否则发的是跑了旧逻辑的包；最新源 ' + newestName + '）',
     fs.statSync(EXE).mtimeMs >= newest, true);
}

// ---------------------------------------------------------------- C 发布包契约

console.log('--- C) 发布包契约：有识别服务、零 Python 残留 ---');
function walkPy(dir, out, depth) {
  if (depth > 4) return;
  let kids = [];
  try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of kids) {
    if (e.isDirectory()) walkPy(path.join(dir, e.name), out, depth + 1);
    else if (/\.(py|pyc|pyd)$/i.test(e.name)) out.push(path.relative(ROOT, path.join(dir, e.name)));
  }
}
for (const rel of ['Meter engine-server', 'Desktop version']) {
  const pub = path.join(ROOT, rel);
  if (!fs.existsSync(pub)) { console.log('  … ' + rel + ' 不存在，跳过'); continue; }
  eq(rel + ' 内含 GomokuVision.exe', fs.existsSync(path.join(pub, 'GomokuVision.exe')), true);
  eq(rel + ' 内不再有 python/ 运行时', fs.existsSync(path.join(pub, 'python')), false);
  const pys = [];
  walkPy(pub, pys, 0);
  eq(rel + ' 内任何层级都不含 .py/.pyc/.pyd' + (pys.length ? '：' + pys.slice(0, 3).join(', ') : ''),
     pys.length, 0);
}
{
  // 宿主代码也不许再拉起 Python：一旦有人「顺手加个回退」，193MB 又回来了
  const ES = fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8');
  eq('engine-server.js 改为找 GomokuVision.exe', ES.includes('findVisionExe'), true);
  eq('engine-server.js 不再有 venv/pip 装配逻辑', ES.includes('ensurePythonEnv'), false);
  const HOST = fs.readFileSync(path.join(ROOT, 'desktop-overlay', 'src', 'host.cpp'), 'utf8');
  eq('覆盖层宿主改为拉起 GomokuVision.exe --scan',
     HOST.includes('L"GomokuVision.exe"') && HOST.includes('L"--scan"'), true);
  eq('覆盖层宿主不再拉 python\\runtime\\python.exe',
     HOST.includes('python\\\\runtime\\\\python.exe'), false);
  const BR = fs.readFileSync(path.join(ROOT, 'tools', 'build-release.js'), 'utf8');
  eq('build-release 暂存 GomokuVision.exe（并带新鲜度护栏）',
     BR.includes('GomokuVision.exe') && BR.includes('比源码旧'), true);
  eq('build-release 不再暂存 python-bundle 运行时', BR.includes('python-bundle'), false);
}

// ---------------------------------------------------------------- D 端到端

console.log('--- D) 端到端：现场截图跑真识别链路 ---');
function runJson(args) {
  const r = spawnSync(EXE, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '').trim();
  if (!out) return { err: (r.stderr || 'no stdout').slice(0, 200), status: r.status };
  try { return JSON.parse(out.split('\n').pop()); }
  catch (e) { return { err: 'bad json: ' + out.slice(0, 120), status: r.status }; }
}
const FIX = [
  ['屏江棋院（jpg 压缩 + 深色底）', 'pingjiang-20260919.jpg'],
  ['五林（拟真光泽棋子 + 亮木底）', 'wulin_gloss_board.jpg'],
];
for (const [tag, f] of FIX) {
  const p = path.join(ROOT, 'tools', 'fixtures', f);
  if (!fs.existsSync(p)) { console.log('  … 缺 fixtures/' + f + '，跳过'); continue; }
  const s = runJson(['--scan-image', p]);
  const n = (x) => ((x && x.black) || []).length + ((x && x.white) || []).length;
  eq('scan ' + tag + '：找到棋盘', s.found === true, true);
  eq('scan ' + tag + '：读出棋子（黑+白=' + n(s) + '）', n(s) > 0, true);
  const rr = s.board_rect || {};
  eq('scan ' + tag + '：棋盘框尺寸合理（w=' + rr.w + ',h=' + rr.h + '）',
     rr.w > 100 && rr.h > 100, true);

  const c = runJson(['--recognize-image', p]);
  eq('recognize ' + tag + '：ok 且读出棋子（黑+白=' + n(c) + '）',
     c.ok === true && n(c) > 0, true);
  eq('recognize ' + tag + '：不误报 suspect', !!c.suspect, false);
}

// ---------------------------------------------------------------- E 大图内嵌小棋盘

// ★ 2026-09-22（用户样张）：大图里只有一小块棋盘时，主定位容易把整幅大图的 UI 纹理
//   当网格、读出违反棋理的数量（163 黑 0 白）。修法 = 棋理仲裁重试链（吸附矩形 →
//   文档轮廓 → 残盘兜底）。夹具 = partial-board-photo 贴到大幅页面画布（原尺寸 + 0.45x）。
console.log('--- E) 大图内嵌小棋盘（棋理仲裁重试链） ---');
const BIGFIX = [
  ['大图原尺寸', 'big-canvas-paste.png'],
  ['大图缩小 0.45x', 'big-canvas-small-board.png'],
];
for (const [tag, f] of BIGFIX) {
  const p = path.join(ROOT, 'tools', 'fixtures', f);
  if (!fs.existsSync(p)) { console.log('  … 缺 fixtures/' + f + '，跳过'); continue; }
  const c = runJson(['--recognize-image', p]);
  const nb = ((c && c.black) || []).length, nw = ((c && c.white) || []).length;
  eq('recognize ' + tag + '：ok 且读出 6 黑 6 白（实际 ' + nb + '/' + nw + '）',
     c.ok === true && nb === 6 && nw === 6, true);
  eq('recognize ' + tag + '：不违反棋理（suspect=false）', !!c.suspect, false);
}

// ---------------------------------------------------------------- E2 标记白子

// ★ 2026-09-27（用户截图实证，「书签版恒等待对手落子」的根治回归）：平台把「最后一手」
//   红方块直接印在白子中心（E5）—— 旧 rawClassify 因「核心盘被红色拉暗」弃权 → 整颗
//   白子被丢 → 白子数少 1 → 轮次奇偶反转 → 面板判错行棋方。真盘 20 黑 20 白轮黑，
//   修复前读成 20 黑 19 白。夹具 = 该截图原样；断言 = 20/20 且 E5 必须在白子列表里。
console.log('--- E2) 最后一手标记印在白子上（标记子不丢） ---');
{
  const p = path.join(ROOT, 'tools', 'fixtures', 'marked-lastmove-white.png');
  if (!fs.existsSync(p)) { console.log('  … 缺 fixtures/marked-lastmove-white.png，跳过'); }
  else {
    const c = runJson(['--recognize-image', p]);
    const nb = ((c && c.black) || []).length, nw = ((c && c.white) || []).length;
    const hasE5 = ((c && c.white) || []).some((s) => s.x === 4 && s.y === 10);
    eq('recognize 标记白子：ok 且读出 20 黑 20 白（实际 ' + nb + '/' + nw + '）',
       c.ok === true && nb === 20 && nw === 20, true);
    eq('recognize 标记白子：红标盖住的白子 E5 不丢', hasE5, true);
    eq('recognize 标记白子：不违反棋理（suspect=false）', !!c.suspect, false);
  }
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
