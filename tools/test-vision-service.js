/* 识别服务（GomokuVision.exe · 官方 OpenCV C++ 自包含版）—— 现行实现的契约 + 端到端护栏
 * ============================================================================
 * 背景（2026-09-20 换装）：识别从「随包便携 Python + pip 装 opencv/numpy/pillow」
 *   换成**自包含的 C++ 实现**（官方 OpenCV 5.0.0，只编 core/imgproc/imgcodecs
 *   三个模块并静态链接，零依赖）。发布包因此少了 193MB 的 python/。
 *   ★ 2026-10-02（任务 #108）：进一步拆成 **壳 + 模型库** ——
 *     `GomokuVision.exe`（HTTP/命名管道壳，无 OpenCV，~0.4MB）+
 *     `GomokuVision.dll`（OpenCV + 识别模型，~7MB，宿主 LoadLibrary 加载）。
 *     两者必须**成对**且与 desktop-vision/build 逐字节一致（见 C 段）。
 *
 * 本测试守五件事：
 *   A 源码契约：当年 Python 版一条条钉下来的「预防针」必须还在 C++ 里 ——
 *     换装最大的风险不是编译不过，而是**移植时把某个防护分支丢了**，而且丢得很安静。
 *   A2 GPU 抓屏契约：抓屏必须首选举显卡（DXGI），且 CPU 侧的边框/线族识别完整保留。
 *   B 产物契约：exe+dll 成对在、体积合理、比源码新（防「跑了旧识别逻辑」的发布包）。
 *   C 发布包契约：各发布目录都得有它，且**不许再有任何 Python 残留**。
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
// ★ 2026-10-11：注释锚点换代码锚点（10-10 整理剥掉了源码里的中文注释，特征代码全在）——
//   「跳过缺失线」= arithmeticCandidates 里缺线时按步长倍数回跳再吸附的那段。
eq('等距族允许跳过缺失线（否则缺一条就凑不齐）',
   /int m = iRound\(df \/ d\);\s*\n\s*if \(m >= 1 && std::abs\(cand\[k\]\.mean - \(expect \+ m \* d\)\) <= tol\)/.test(SCREEN), true);
eq('长度门槛相对最长线（不用分位，防误删棋盘线）', SCREEN.includes('thrLen'), true);
eq('横竖族需真实交叉（防网页文字行被当成棋盘）', SCREEN.includes('interX'), true);
eq('支持格距成整数倍的子采样配对', SCREEN.includes('subsampleFamily'), true);
eq('多尺度 + 多线长档位（适配任意分辨率/窗口大小）',
   SCREEN.includes('{1.0, 0.6}') && SCREEN.includes('{0.05, 0.10}'), true);
eq('读子在棋盘裁剪区内做（否则全局众数取到桌面色）', SCREEN.includes('cropBoard'), true);
// ★ 2026-09-25（用户要求）：「识别范围 = 棋盘边界线 + 再外扩」，且必须是**统一口径**
//   （与 host.cpp 的贴盘、gbrecognize 的吸附重试同款）—— 老实现留的是 `spacing * 1.3`，
//   多出来那一大圈全是盘外背景，会把 estimate_background 的全局众数带偏
//   （这正是下面那条注释警告的问题），贴边子也更难和盘外底色分开。
// ★★ 2026-10-03（用户**再**要求，现行口径）：**0.6 格** —— 先前的「半格 + 边长/30」
//   （≈0.53 格）在大棋盘上仍读不出个别贴边子：棋子画得比理论格距略大，加抗锯齿与描边，
//   半格覆盖不住。0.6 格与 gbrecognize.cpp 的自动吸附重试**逐字同口径** ——
//   两边必须一起改，否则「吸附路径裁得宽、精修路径裁得窄」会行为不一致。
eq('裁剪余量 = 边界线 + 0.6 格（与 gbrecognize 吸附重试同口径；既不是旧的「半格 + 边长/30」，更不是 1.3 格）',
   SCREEN.includes('double pad = (spacing * 0.6) * padMul;') &&
   !SCREEN.includes('double pad = spacing * padRatio;') &&
   !SCREEN.includes('spacing * 0.5 + span / 30.0'), true);
eq('裁剪余量有「任何情况下不少于 0.6 格」的兜底', SCREEN.includes('if (pad < spacing * 0.6) pad = spacing * 0.6;'), true);
// 同口径守护：识别侧的自动吸附重试也得是 0.6 格，不能一边 0.6 一边 0.5
{
  const REC = read('gbrecognize.cpp');
  eq('★ 吸附重试与裁盘同口径（gbrecognize 也是 0.6 格）',
     /double pad = \(c\.step > 0 \? c\.step : 20\.0\) \* 0\.6;/.test(REC), true);
}
eq('★ 读子可疑时放大一倍余量（padMul = 2.0）重读一次（贴边被裁的盘面能救回来）',
   SCREEN.includes('wide_crop_retry') &&
   SCREEN.includes('cropBoard(masked, xL, yL, spacing, crop2, cx2, cy2, 2.0);'), true);
eq('支持跟踪模式（hint 附近优先搜索）', SCREEN.includes('searchNear'), true);

// ★★ 2026-10-09（用户：「要活动地使用核显或者显卡」「不仅仅是识图，识图和连线，你要灵活
//   地去运用 GPU，就是 GPU 与 CPU 共同进行。有时候复杂的边框识别还得需要 CPU」）★★
//   抓屏那条路此前是「GDI BitBlt 一次 + GetDIBits 一次」= **两次整屏内存搬运**
//   （3072×1920×4B ≈ 23.6MB ×2）再加 590 万像素的**标量** BGRA→RGB 三重循环；而且这段
//   成本**既没被计时也没被优化**（`[perf] scan` 的计时从 scanSub 才开始，截屏在它之前）。
//   现在的分工：**GPU 做大块像素搬运与格式转换，CPU 仍然做边框/线族识别**（Canny/Hough/
//   投影/亚像素细化）—— 这正是「复杂的边框识别还得需要 CPU」的落点。
console.log('--- A) 源码契约：GPU 抓屏（DXGI Desktop Duplication）+ GDI 兜底 + CPU 保留边框识别 ---');
eq('★ 抓屏首选举显卡（DXGI Desktop Duplication，OBS/录屏软件的标准抓屏路径）',
   SCREEN.includes('#include <d3d11.h>') && SCREEN.includes('#include <dxgi1_2.h>') &&
   SCREEN.includes('IDXGIOutputDuplication') && SCREEN.includes('DuplicateOutput'), true);
eq('★ DXGI 抓屏：CopyResource 到 STAGING 纹理后 Map，只走一次「显存 → 内存」',
   SCREEN.includes('ctx->CopyResource(staging, tex)') &&
   SCREEN.includes('ctx->Map(staging, 0, D3D11_MAP_READ, 0, &m)'), true);
eq('★ 超时 0 轮询 + 桌面没变就复用上一帧（重复抓屏的绝大部分场景 = 零开销）',
   SCREEN.includes('AcquireNextFrame(0, &info, &res)') &&
   SCREEN.includes('DXGI_ERROR_WAIT_TIMEOUT') && SCREEN.includes('rgb = last; reused = true;'), true);
eq('★ ACCESS_LOST（切分辨率/全屏切换/驱动重置）→ 标记重建；一次失败永久回退 GDI（不每帧重试）',
   SCREEN.includes('DXGI_ERROR_ACCESS_LOST') && SCREEN.includes('lost = true;') &&
   SCREEN.includes('if (!c.tried || c.lost)') && SCREEN.includes('if (!usable) return false;'), true);
eq('★ 行步长 RowPitch 用带 stride 的 cv::Mat 视图直接转（不做逐像素循环）',
   /cv::Mat view\(h, w, CV_8UC4, m\.pData, \(size_t\)m\.RowPitch\)/.test(SCREEN) &&
   /cv::cvtColor\(view, rgb, cv::COLOR_BGRA2RGB\)/.test(SCREEN), true);
// ★ 2026-10-11：注释锚点（② 纯 CPU：GDI BitBlt）随 10-10 注释剥离改锚代码本体。
eq('★ GDI BitBlt 仍是**纯 CPU 通道**（多屏拼接 / RDP / 无 GPU 驱动 / DuplicateOutput 被拒 / 实测不划算）',
   SCREEN.includes('BitBlt(mem, 0, 0, vw, vh, screen, vx, vy, SRCCOPY | CAPTUREBLT)'), true);
// ★★ 2026-10-09（用户：「如果检测到用户的电脑的核心不支持 OpenCV，或者说支持能力还不如 CPU，
//   就自动切换为全 CPU」＋「识图和连线要灵活运用 GPU，GPU 与 CPU 共同进行」）★★
//   抓屏后端从「永远先试 DXGI」改成**自适应择一**：能力（建不起来就纯 CPU）
//   + 性价比（实测显卡不比 CPU 快就永久切纯 CPU）+ 运行中退化（连续 3 帧失败就降级）。
eq('★★ 抓屏后端自适应择一：CapSelect 首帧定一次，之后按真机实测校正',
   SCREEN.includes('enum class CapMode { DXGI, GDI }') &&
   SCREEN.includes('void CapSelect()') &&
   SCREEN.includes('CapSelect();') &&
   SCREEN.includes('if (g_capMode == CapMode::DXGI) {'), true);
eq('★★ 性价比判据只用**真正搬了像素的帧**（复用帧恒 0ms 会把均值带偏；首帧含设备创建也不计）',
   SCREEN.includes('if (reused || firstFresh) return;') &&
   SCREEN.includes('g_dxgiFresh >= 12 && g_gdiBaseMs > 0'), true);
eq('★★ 显卡不比 CPU 快（>90% 打平即不划算）→ 永久切纯 CPU，日志给出两边实测值',
   SCREEN.includes('avg > (double)g_gdiBaseMs * 0.9') &&
   SCREEN.includes('永久切换为全 CPU'), true);
eq('★★ 运行中退化：显卡抓屏连续 3 帧失败（驱动重置 / 全屏独占抢走桌面复制）→ 永久降级纯 CPU',
   SCREEN.includes('if (++g_dxgiFails >= 3)') && SCREEN.includes('g_capMode = CapMode::GDI;'), true);
eq('★★ 强制开关 GB_FORCE_CAPTURE=dxgi|gdi（排障/对比）；GB_NO_DXGI=1 仍然等价于纯 CPU',
   SCREEN.includes('GB_FORCE_CAPTURE') && SCREEN.includes('_stricmp(v, "gdi")') &&
   SCREEN.includes('_stricmp(v, "dxgi")') && SCREEN.includes('gbNoDxgi()'), true);
eq('★ GDI 兜底的整屏逐像素 BGRA→RGB 标量三重循环已换成 OpenCV SIMD（同一结果，差一个数量级）',
   /cv::cvtColor\(bgra, rgb, cv::COLOR_BGRA2RGB\)/.test(SCREEN) &&
   !/for \(int y = 0; y < vh; \+?\+?y\)/.test(SCREEN), true);
eq('★ 抓屏分段计时（GB_VISION_PERF）：mode=dxgi / mode=gdi 都要报，且复用帧要标出来',
   /\[perf\] capture mode=dxgi ms=%lld%s/.test(SCREEN) &&
   SCREEN.includes('(desktop unchanged, reused)') &&
   /\[perf\] capture mode=gdi ms=%lld/.test(SCREEN), true);
eq('★ GB_NO_DXGI=1 可强制回 GDI（排障/对比用），Init/Grab 两处都认这个开关',
   /GetEnvironmentVariableA\("GB_NO_DXGI"/.test(SCREEN) &&
   (SCREEN.match(/gbNoDxgi\(\)/g) || []).length >= 4, true);
// 「GPU 与 CPU 共同进行」的另一半：边框/线族识别必须仍在 CPU 侧（不搬到 GPU，也不删）
eq('★ CPU 侧边框/线族识别完整保留（自适应 Canny + Otsu 阈值 + HoughLinesP + 找盘矩形 + 子采样配对）',
   SCREEN.includes('THRESH_OTSU') && SCREEN.includes('cv::Canny(gray, edges, lo, hi)') &&
   SCREEN.includes('cv::HoughLinesP(edges, lines') &&
   SCREEN.includes('findBoardRects') && SCREEN.includes('subsampleFamily'), true);
{
  // DXGI 是 GPU 路径，符号必须被真正链接进识别模型库（gbscreen.cpp 编进 MODEL_OBJS → DLL）
  const BUILD = fs.readFileSync(path.join(ROOT, 'tools', 'build-vision-msvc.sh'), 'utf8');
  eq('★ 识别模型库链接 dxgi.lib + d3d11.lib（漏了 = LNK2019 直接编不过，不是静默降级）',
     /dxgi\.lib d3d11\.lib/.test(BUILD), true);
  eq('★ gbscreen.cpp 编进 MODEL_OBJS（DLL 侧），exe 壳不背 OpenCV 与 D3D 依赖',
     /MODEL_OBJS=""/.test(BUILD) && /for s in gb gbadaptive gbdetector gbrecognize gbscreen gbscanapi; do/.test(BUILD) &&
     !/gbscreen\.obj/.test((BUILD.match(/链接 exe[\s\S]*?ls -la desktop-vision\/build\/GomokuVision\.exe/) || [''])[0]), true);
}

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
// ★ 2026-10-03 用户实拍（白子上叠鼠标「移动」十字光标 → 整颗白子被丢）：淡色盘上
//   白子仅 ~1.07× 对比、十字把核心盘中位拖到 0.965×，白壳阈值 1.06×/核亮 1.12× 全够不着。
//   白身补判 = 壳环不暗 + 中性饱和 + 亮白占比，不看核心中位数（标记拉不掉占比）。
eq('★ 白身补判兜底：带中心小标记/低对比的白子（鼠标十字、淡色盘）',
   AD.includes('auto whiteByBody') &&
   AD.includes('return whiteByBody(ax, ay);') &&
   /bright \/ \(double\)tot < 0\.22/.test(AD), true);
eq('★ rawClassify 弃权前必须先试白身补判（不能直接 return EMPTY）',
   /rawColoredFrac\(ax, ay, 0\.18\) >= 0\.25\) return WHITE;\s*\n\s*(?:\/\/[^\n]*\n\s*)?return whiteByBody\(ax, ay\);/.test(AD), true);
{
  // ★ 2026-10-05（用户：「把助手的识别方案给训练器视觉用上：先找棋盘、后找子、外扩 0.6 格」）：
  //  GbvScanImage 的吸附补救闸必须同时盖住「found=false（框选失败）」与「空盘」两种形态，
  //  且采纳候选时把 geometry 网格线平移回全图坐标（num/inum 同步 —— dump() 走 inum）。
  const DL = read('gbdll.cpp');
  eq('★ scan 框选失败也进补救链（found=false → 吸附候选 + 0.6 格外扩 + recognize 仲裁）',
     DL.includes('bool needRescue = res.ok && (!res.found ||') &&
     DL.includes('notfound_multi_alt') &&
     DL.includes('double pad = (c.step > 0 ? c.step : 20.0) * 0.6;'), true);
  eq('★ 补救采纳时 geometry 平移回全图：num/inum 必须同步改（dump() 序列化走 inum）',
     /v\.num \+= x0;\s*\n\s*if \(v\.isInt\) v\.inum = \(long long\)v\.num;/.test(DL) &&
     /v\.num \+= y0;\s*\n\s*if \(v\.isInt\) v\.inum = \(long long\)v\.num;/.test(DL), true);
}

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
  // ★ 2026-10-02（任务 #108）架构改为**壳 + 模型库**：exe 只做 HTTP/管道壳（零 OpenCV），
  //   OpenCV + 识别模型全在 GomokuVision.dll 里（宿主 LoadLibrary 加载，避免 exe 每次
  //   启动都摊开 ~7MB 的静态库）。所以「体积」这条要按**成对**看，不能再拿 exe 单文件衡量。
  const exeMB = fs.statSync(EXE).size / 1024 / 1024;
  const dllPath = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.dll');
  const hasDll = fs.existsSync(dllPath);
  const dllMB = hasDll ? fs.statSync(dllPath).size / 1024 / 1024 : 0;
  eq('壳很小（<2MB，无 OpenCV）+ 模型库 4~20MB + 成对合计 4~22MB',
     exeMB < 2 && dllMB > 4 && dllMB < 20 && (exeMB + dllMB) > 4 && (exeMB + dllMB) < 22, true);
  console.log('    （实测 exe ' + exeMB.toFixed(2) + ' MB + dll ' + dllMB.toFixed(2) +
              ' MB = ' + (exeMB + dllMB).toFixed(2) + ' MB）');
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
  // ★ #108 布局：exe/dll 挪进 Vision\ 子目录（Desktop version 保留根目录直放）
  eq(rel + ' 内含 GomokuVision.exe',
     fs.existsSync(path.join(pub, 'GomokuVision.exe')) ||
     fs.existsSync(path.join(pub, 'Vision', 'GomokuVision.exe')), true);
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
{
  // ★ 2026-10-05 事故护栏（训练器识别全灭）：训练器 Vision 目录只剩 9-29 老 exe、dll 缺失，
  //   新架构宿主 LoadLibrary 失败 → recognize 恒 12 字节 {"ok":false}，HTTP 回落又因
  //   老 exe 不认 GB_RECOG_PORT/GB_SCAN_PORT 全灭。四个发布目录必须「exe+dll 成对」
  //   且与 desktop-vision/build 逐字节一致（md5），谁再半途铺目录直接红。
  const crypto = require('crypto');
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  // ★★ 2026-10-09（用户：「发布的新鲜度只针对我们这个版本的软件，其他的软件不要动」）★★
  //   本段现在分两档：
  //     · **本版本（连线版 `Meter Gomoku`）** —— 必须存在 + 与 build 逐字节一致（硬红）。
  //       它的 `Vision/` 就是这一版安装包（MeterGomokuLink.iss 的 `{#SrcDir}\Vision\`）的
  //       识别组件来源，半途铺目录会直接让用户装到一个旧识别。
  //     · 其余四个历史发布目录 —— 仍要求「exe + dll 成对存在」，但**字节一致性只告警不判红**：
  //       它们不是这一版的发布物，用户已明示「其他的软件不要动」，本测试不去替它们铺目录。
  //       要恢复旧口径（全目录硬比对）时加 `--all`。
  const ALL_DIRS = process.argv.includes('--all');
  const pairs = [['Meter GomokuAssistant', 'Vision'], ['Meter engine-server', 'Vision'],
                 ['Meter GomokuTrainer', 'Vision'], ['Desktop version', '']];
  for (const [rel, sub] of pairs) {
    const dir = path.join(ROOT, rel, sub);
    for (const f of ['GomokuVision.exe', 'GomokuVision.dll']) {
      const p = path.join(dir, f);
      eq(rel + (sub ? '/' + sub : '') + ' 内含 ' + f, fs.existsSync(p), true);
      if (!fs.existsSync(p)) continue;
      const same = md5(p) === md5(path.join(ROOT, 'desktop-vision', 'build', f));
      if (ALL_DIRS) {
        eq(rel + (sub ? '/' + sub : '') + ' 的 ' + f + ' 与 build 逐字节一致', same, true);
      } else if (!same) {
        console.log('  ⚠ ' + rel + (sub ? '/' + sub : '') + ' 的 ' + f +
                    ' 与 build 不一致 —— 属「其他软件」，按用户指示不动它（加 --all 可恢复硬比对）');
      }
    }
  }
  // ★ 本版本（连线版）：硬口径 —— 存在 + 逐字节一致，一个都不能少。
  for (const f of ['GomokuVision.exe', 'GomokuVision.dll']) {
    const p = path.join(ROOT, 'Meter Gomoku', 'Vision', f);
    eq('Meter Gomoku/Vision 内含 ' + f, fs.existsSync(p), true);
    if (fs.existsSync(p)) {
      eq('Meter Gomoku/Vision 的 ' + f + ' 与 build 逐字节一致',
         md5(p), md5(path.join(ROOT, 'desktop-vision', 'build', f)));
    }
  }
}

// ---------------------------------------------------------------- D 端到端

console.log('--- D) 端到端：现场截图跑真识别链路 ---');
function runJson(args) {
  // stdin 用 ignore：继承沙箱/重定向环境的坏 stdin 句柄会让 libuv 建管道报 EBUSY
  const r = spawnSync(EXE, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
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
