/* 五子棋计算器（第三个 EXE）测试
 * ----------------------------------------------------------------------------
 * 两部分：
 *   A. 源码契约（host.cpp / build-calculator.js）—— 窗口形态、无控制台、图标、
 *      核心数上限规则、两个识别器的接入通道；
 *   B. 真实 Edge 无头加载 calc.html —— 棋盘真的画出来了、中英/深浅切换、
 *      外部存档落库、背诵复盘可用，且全程没有 JS 异常。
 *
 * A 抓的是「改坏了立刻红」的硬契约；B 抓的是「页面到底跑不跑得起来」——
 * 计算器是纯新写的页面，最容易在第一行就挂掉却没有任何提示。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST_CPP = path.join(ROOT, 'desktop-calculator', 'src', 'host.cpp');
const BUILD_JS = path.join(ROOT, 'tools', 'build-calculator.js');
const UI_DIR = path.join(ROOT, 'desktop-calculator', 'ui');
const CALC_HTML = path.join(UI_DIR, 'calc.html');
const HARNESS = path.join(UI_DIR, '_calc_test.html');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

// ============================================================ A. 源码契约
console.log('== A. 计算器宿主契约（host.cpp / 构建脚本）==');
const HOST = fs.readFileSync(HOST_CPP, 'utf8');
const BUILD = fs.readFileSync(BUILD_JS, 'utf8');
// ★ 2026-09-22 三轮：识别引擎（GomokuVision）源码契约 —— 自动吸附智能开关链路
const VISHDR = fs.readFileSync(path.join(ROOT, 'desktop-vision', 'src', 'gbvision.h'), 'utf8');
const VISSRC = fs.readFileSync(path.join(ROOT, 'desktop-vision', 'src', 'gbrecognize.cpp'), 'utf8');
const VISMAIN = fs.readFileSync(path.join(ROOT, 'desktop-vision', 'src', 'main.cpp'), 'utf8');

ok('普通可缩放窗口：WS_OVERLAPPEDWINDOW（标题栏自带最小化/最大化/关闭）',
  /WS_OVERLAPPEDWINDOW/.test(HOST));
ok('有最小尺寸限制（不会缩成一团）', /ptMinTrackSize\.x\s*=\s*\w/.test(HOST));
// ★★ 2026-09-28（用户要求）：最小窗口尺寸 = **底栏按键文字开始换行/堆叠的实测临界宽度**，
//   而且**随显示器分辨率与缩放换算**（不是写死物理像素）。
//   · 临界值量的是**内容侧 CSS px**（无头 Edge 二分实测 tools/measure-bottombar-minwidth.html：
//     #boardBtns 自然宽 410px，底栏共需 424px；视口 655px 时出横向滚动条、底栏 33→41px；
//     视口 660px 刚好齐平 ⇒ 660 + 20 余量 = **680 CSS px**，高 600）。
//   · 窗口阈值是**物理像素**，WebView2 内容按 DPI 缩放 ⇒ 必须 × dpi/96：
//     1080p@100% → 680；4K@175% → 1190。两者内容宽度都是同一个 680 CSS px。
//   · 最后夹到工作区（极小屏上「最小值>可用区」会把窗口卡死）。改底栏按键/字号必须重新实测。
ok('★ 主窗最小尺寸 = 实测底栏临界 680×600（CSS px）× 当前显示器 DPI，并夹到工作区',
  /kMainMinCssW\s+= 680;/.test(HOST) && /kMainMinCssH\s+= 600;/.test(HOST) &&
  /static int GbPx\(HWND h, int css\) \{ return MulDiv\(css, GbDpiFor\(h\), 96\); \}/.test(HOST) &&
  /int mw = GbPx\(h, kMainMinCssW\), mh = GbPx\(h, kMainMinCssH\);/.test(HOST) &&
  /GbClampToWorkArea\(h, mw, mh\);/.test(HOST) &&
  /mm->ptMinTrackSize\.x = mw;/.test(HOST) && /mm->ptMinTrackSize\.y = mh;/.test(HOST));
// ★ 2026-09-28：默认窗口尺寸同样按 DPI 换算（1280×820 CSS px）—— 原来写死 1180×780 物理像素，
//   4K@175% 上首启只有 674×446 CSS px（比底栏临界还窄），第一次打开就是挤堆的。
ok('★ 主窗默认尺寸按 DPI 换算（1280×820 CSS px），存档尺寸也过一遍当前最小值',
  /kMainDefCssW\s+= 1280;/.test(HOST) && /kMainDefCssH\s+= 820;/.test(HOST) &&
  /int w = GbPx\(nullptr, kMainDefCssW\), h = GbPx\(nullptr, kMainDefCssH\);/.test(HOST) &&
  /if \(w < mw\) w = mw;/.test(HOST) && /if \(h < mh\) h = mh;/.test(HOST));
ok('全程无黑色控制台：/SUBSYSTEM:WINDOWS', /\/SUBSYSTEM:WINDOWS/.test(BUILD));
// ★ 2026-09-19 二轮（用户要求）：三件套版恢复「原本的相互连接逻辑」（:8964 拉起/复用共享引擎），
//   但 spawn 代码必须被 GB_SUITE_ENGINE 编译开关**整个圈住** —— 独立版构建里这段代码不存在。
ok('★ 引擎 spawn 代码只在 GB_SUITE_ENGINE 开关内（独立版构建仍无任何引擎 spawn）',
  (() => {
    const gated = [];
    const outside = HOST.replace(/#ifdef GB_SUITE_ENGINE[\s\S]*?#endif[^\n]*/g, (m) => { gated.push(m); return ''; })
      .replace(/\/\/[^\n]*/g, '');                       // 注释里的字样不算（如函数头注释提到 EnsureEngine）
    const g = gated.join('\n');
    return gated.length >= 2 &&
      /DETACHED_PROCESS/.test(g) && /EnsureEngine/.test(g) && /EngineWatchdog/.test(g) &&
      /WinHttpOpen/.test(g) && /--as-backend/.test(g) &&
      !/DETACHED_PROCESS/.test(outside) && !/EnsureEngine/.test(outside) &&
      !/EngineWatchdog/.test(outside) && !/WinHttpOpen/.test(outside) &&
      !/FindEngineExe/.test(HOST);
  })());
ok('★ 三件套版构建注入：cl 带 /DGB_SUITE_ENGINE、链接带 winhttp.lib（默认构建不带）',
  /'\/DGB_SUITE_ENGINE'/.test(BUILD) && /'winhttp\.lib'/.test(BUILD));
ok('窗口位置会记住（下次打开还在原位）',
  /GomokuTrainer\.pos/.test(HOST) && /GetWindowPlacement/.test(HOST));
ok('单实例：已开则激活，不开第二份',
  /Global\\\\GomokuTrainer_v1/.test(HOST) && /FindWindowW\(kCls, nullptr\)/.test(HOST));
ok('核心数上限 = 总核 −1/2/4（机器越强留越多），默认半核',
  /int sub = \(n >= 16\) \? 4 : \(\(n >= 8\) \? 2 : 1\);/.test(HOST) &&
  /int t = n \/ 2;/.test(HOST));
ok('页面内 AI：全响应带 COOP/COEP（crossOriginIsolated = SAB/pthreads 前提）',
  /Cross-Origin-Opener-Policy: same-origin/.test(HOST) &&
  /Cross-Origin-Embedder-Policy: require-corp/.test(HOST) &&
  /kIsoHeaders/.test(HOST));
ok('页面内 AI：/ai/* 从 exe 旁 resources/ 供模型（wasm mime + 长缓存 + 挡 ../ 穿越）',
  /path\.rfind\(L"ai\/", 0\) == 0/.test(HOST) &&
  /application\/wasm/.test(HOST) &&
  /Cache-Control: max-age=86400/.test(HOST) &&
  /name\.find\(L"\.\."\) == std::wstring::npos/.test(HOST));
ok('页面内 AI：WebView2 子进程提权（对齐原引擎 High 优先级）',
  /BoostWebViewPriority/.test(HOST) &&
  /msedgewebview2\.exe/.test(HOST) &&
  /HIGH_PRIORITY_CLASS/.test(HOST));
ok('书签端接入：本机 :8972 收 POST /history（带 CORS + PNA）',
  /htons\(8972\)/.test(HOST) && /Access-Control-Allow-Origin: \*/.test(HOST) &&
  /Access-Control-Allow-Private-Network: true/.test(HOST));
ok('桌面端接入：轮询 %TEMP%\\gb-calc-inbox.json',
  /gb-calc-inbox\.json/.test(HOST) && /InboxFileWatcher/.test(HOST));
ok('两个入口最终都转成同一条 historyInbox 消息给页面',
  (HOST.match(/\\"type\\":\\"historyInbox\\"/g) || []).length >= 2);
ok('外部进来的 JSON 先转义再拼（不信任外部存档）',
  /JsonQuote\(body\)/.test(HOST) && /JsonQuote\(data\)/.test(HOST));
ok('图标由 Calculator.ico 编入（用户指定的图标）',
  /Calculator\.ico/.test(fs.readFileSync(path.join(ROOT, 'desktop-calculator', 'src', 'icon.rc'), 'utf8')) &&
  /icon\.res/.test(BUILD));
ok('UI 由宿主内置本地 HTTP 供给（:8965，COOP/COEP 齐全；gbcalc.local 拦截器已废弃）',
  !/SetVirtualHostNameToFolderMapping/.test(HOST) && /HttpUiServer/.test(HOST) &&
  /8965/.test(HOST) && !/AddWebResourceRequestedFilter/.test(HOST));
// ★ 2026-09-19（用户要求）：「打开复盘，弹出一个新的窗口……只有棋盘和下面的几个控制键，
//   不参与任何功能的连接」+「在历史中打开某一个历史也是一个复盘也是一个新窗口」。
//   ⇒ 复盘不再是「主窗口里换棋盘」，而是宿主开**第二个顶层窗口**（class GbCalcReview），
//     复用同一个 WebView2 环境与同一份 calc/ 资源，页面用 ?rv=1 进 RV_MODE。
ok('★ 复盘窗口 = 宿主建的独立顶层窗口（GbCalcReview；复用 g_env + 同一份 calc/ 资源）',
  /static const wchar_t\* kRvCls = L"GbCalcReview";/.test(HOST) &&
  /static void OpenReviewWindow\(const std::string& recordJson\);/.test(HOST) &&
  /static LRESULT CALLBACK RvWndProc\(HWND h, UINT m, WPARAM w, LPARAM l\)/.test(HOST) &&
  /class RvMsgHandler : public Cb<ICoreWebView2WebMessageReceivedEventHandler>/.test(HOST) &&
  /class RvCtlHandler : public Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>/.test(HOST) &&
  // 创建在 g_env 上（不是新环境）→ 与主窗口同源同目录，页面才能读同一份 calc.js
  /g_env->CreateCoreWebView2Controller\(g_rvHwnd, new RvCtlHandler\(\)\);/.test(HOST) &&
  /g_rvWebview->Navigate\(L"http:\/\/127\.0\.0\.1:8965\/calc\.html\?rv=1"\);/.test(HOST) &&
  /LogMsg\("\[rv\] review window created \(independent top-level window\)"\);/.test(HOST));
ok('★ 复盘窗只管自己：关它不退出进程（WM_DESTROY 不 PostQuitMessage）',
  /LogMsg\("\[rv\] review window destroyed"\);/.test(HOST) &&
  // 关复盘 = 页面发 closeReview → PostMessage(WM_CLOSE)；主窗口完全不动
  /if \(s\.find\("\\"closeReview\\""\) != std::string::npos\) \{/.test(HOST) &&
  /if \(g_rvHwnd\) PostMessageW\(g_rvHwnd, WM_CLOSE, 0, 0\);/.test(HOST) &&
  // 复盘页面报到 → 宿主把「要复盘的那一局」投过去（reviewData 报文）
  /if \(s\.find\("\\"ready\\""\) != std::string::npos\) \{/.test(HOST) &&
  /\\"reviewData\\"/.test(HOST) && /PostToRvPage\(/.test(HOST) &&
  // 复盘窗自己也会回执手数（端到端测试据它确认记录确实到了）
  /if \(s\.find\("\\"reviewAck\\""\) != std::string::npos\) \{/.test(HOST) &&
  /LogMsg\("\[rv\] ack moves=" \+ std::to_string\(n\)\);/.test(HOST));
ok('★ 「保存局面」走系统「另存为」对话框（提示用户保存到哪里，不默认落盘）',
  /#include <commdlg\.h>/.test(HOST) && /comdlg32\.lib/.test(HOST) &&
  /static std::wstring PickSavePath\(const std::wstring& suggested, HWND owner\)/.test(HOST) &&
  /ofn\.Flags = OFN_OVERWRITEPROMPT \| OFN_PATHMUSTEXIST \| OFN_EXPLORER \| OFN_NOCHANGEDIR;/.test(HOST) &&
  /if \(!GetSaveFileNameW\(&ofn\)\) return L"";/.test(HOST) &&
  // 用户取消 → 一个字节都不写
  /if \(path\.empty\(\)\) \{ LogMsg\("\[save\] cancelled by user"\); return; \}/.test(HOST) &&
  // 页面 dataURL → 解码 → 写盘，并记字节数（可核对「真的落盘了」）
  /static std::vector<unsigned char> Base64Decode\(const std::string& in\)/.test(HOST) &&
  /static void SavePngFromPage\(const std::string& s, HWND owner\)/.test(HOST) &&
  /LogMsg\("\[save\] png written: " \+ WideToUtf8\(path\) \+ " \(" \+ std::to_string\(png\.size\(\)\) \+ " bytes\)"\);/.test(HOST));
ok('复盘窗消息路由：openReview → 开窗、savePng → 另存为（两窗共用同一套处理）',
  /if \(s\.find\("\\"openReview\\""\) != std::string::npos\) \{/.test(HOST) &&
  /OpenReviewWindow\(JsonSubObject\(s, "\\"record\\""\)\);/.test(HOST) &&
  /if \(s\.find\("\\"savePng\\""\) != std::string::npos\) \{/.test(HOST) &&
  /static std::string JsonSubObject\(const std::string& s, const char\* key\)/.test(HOST) &&
  // 主窗口那边 savePng 落给 g_hwnd 当 owner；复盘窗那边落给 g_rvHwnd
  /SavePngFromPage\(s, g_hwnd\);/.test(HOST) && /SavePngFromPage\(s, g_rvHwnd\);/.test(HOST));

// ---- 页面源码的关键契约 ----
const JS = fs.readFileSync(path.join(UI_DIR, 'calc.js'), 'utf8');
// ★ 2026-09-25：rapfi-native 的 config.toml —— 引擎的算法档位在这份文件里，
//   改坏了（比如把官方的 advanced_stop_ratio 调小）不会有任何报错，只是**悄悄变弱**，
//   所以必须纳入回归（之前 0.75 就是这么悄悄亏掉 25% 思考时间的）。
const CFG_TOML = fs.readFileSync(
  path.join(ROOT, 'tools', 'rapfi-src', 'Networks', 'config.toml'), 'utf8');
const JS_AI = fs.readFileSync(path.join(UI_DIR, 'engine-ai.js'), 'utf8');
const CSS = fs.readFileSync(path.join(UI_DIR, 'calc.css'), 'utf8');
const HTML = fs.readFileSync(CALC_HTML, 'utf8');
// ★ 十六轮：页面内 AI 引擎（engine-ai.js，与 calc.js 同源发布）—— 行棋方重排逻辑的契约也在这里
const ENGINEJS = fs.readFileSync(path.join(UI_DIR, 'engine-ai.js'), 'utf8');
// ★ 十七轮：:8964 服务端引擎（三件套共享）—— 开机热身的契约
const SERVERJS = fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8');

ok('历史上限 150', /var HIST_MAX = 150;/.test(JS));
// ★ 2026-09-19（用户要求）：白子曲线换成**再浅一点**的蓝（#7fb0ef → #aecdf5，同色相提亮度）
ok('评估曲线不按正负变色：黑子恒紫 #7a5af8、白子恒浅蓝 #aecdf5',
  /plot\('b', '#7a5af8'\);/.test(JS) && /plot\('w', '#aecdf5'\);/.test(JS));
// ★ 2026-09-19（用户要求）：曲线与面积都要**沿贝塞尔路径** —— 面积沿同一条贝塞尔
//   下探到 0 轴闭合（原来面积用折线围，边缘与曲线对不上）。
// ★ 2026-09-20（用户反馈）：曲线要**永不断线**（过滤 NaN），面积改**逐段梯形**
//   （贝塞尔离散成密集折线，每小段与 0 轴围一个四边形分别填 —— 穿 0 轴不自交、不漏）。
ok('评估曲线：NaN 过滤永不断线 + 面积积分式单路径填充（曲线/描边共用同一贝塞尔）',
  /function trace\(\) \{/.test(JS) &&
  /if \(typeof v !== 'number' \|\| !isFinite\(v\)\) return;/.test(JS) &&
  /trace\(\);\s*\n\s*ctx\.stroke\(\);/.test(JS) &&
  /ctx\.lineTo\(flat\[flat\.length - 1\]\.x, yz\);/.test(JS) &&
  /ctx\.closePath\(\);[\s\S]{0,260}ctx\.fill\(\);/.test(JS));
ok('曲线可向后延伸（画布随点数变宽 + 自动滚到右端）',
  // x 按手数（p.i）铺 —— 悔棋/重下造成的 ply 缺口不再把曲线挤变形
  /var maxPly = 0;/.test(JS) &&
  /G\.curve\.forEach\(function \(p\) \{ maxPly = Math\.max\(maxPly, p\.i \|\| 0\); \}\);/.test(JS) &&
  /var need = 16 \+ Math\.max\(0, maxPly\) \* step \+ 16;/.test(JS) &&
  /\(p\.i \/ maxPly\)\)/.test(JS) &&
  /scroll\.scrollLeft = w;/.test(JS));
// ★ 2026-09-19（用户要求）：纵轴改成**活动量程** —— 初始 ±10，分数上去就升档
//   （量程与进位一起变大，即「单位坐标轴进位变大」）。
// ★ 2026-09-25（用户要求「评估分数依靠 rapfi 官方」）：上限由自定的 ±1250 改为
//   **Rapfi 官方非杀棋评估上限 ±6000**（VALUE_EVAL_MAX）；杀棋（官方编码 ±(30000-n)）
//   不参与定档，由 yOf 压进最外侧 8% 窄带（否则一个 29988 会把整条曲线压成直线）。
ok('★ 评估曲线纵轴是活动的：阶梯表 + 升档立刻 / 降档带 0.8 死区',
  /var CURVE_TIERS = \[/.test(JS) && /\[10, 2\], \[20, 5\], \[50, 10\]/.test(JS) &&
  /\[6000, 1500\]/.test(JS) && !/\[1250, 250\]/.test(JS) && /var curveTier = 0;/.test(JS) &&
  /if \(ti > curveTier\) curveTier = ti;/.test(JS) &&
  /else if \(ti < curveTier && peak <= CURVE_TIERS\[ti\]\[0\] \* 0\.8\) curveTier = ti;/.test(JS) &&
  /var RANGE = CURVE_TIERS\[curveTier\]\[0\], STEP = CURVE_TIERS\[curveTier\]\[1\];/.test(JS) &&
  // 空盘 / 换局 → 回到最初那一档（±10）
  /if \(!G\.curve\.length\) curveTier = 0;/.test(JS) &&
  !/RANGE = 1000, STEP = 250;/.test(JS));
ok('评估曲线走贝塞尔平滑（不再是一段段折线）', /ctx\.bezierCurveTo\(/.test(JS));
// 2026-09-18 新增：棋盘坐标轴 / 分析模式 / 平衡点 / 局面代码 / GIF
ok('棋盘有横纵坐标轴（字母 + 数字）', /ctx\.fillText\(letter, cx, g\.axis \* 0\.5\)/.test(JS));
// ★ 2026-09-24（用户要求）：「人机」改名「对弈」（两字键，与摆盘/残局同排）。
ok('模式三项（★十五轮）：对弈 / 摆盘 / 残局（两字键用户定稿；分析模式已取消，摆盘/残局 AI 完全不参与）',
  /<button data-mode="pve" class="on">对弈<\/button>/.test(HTML) &&
  /<button data-mode="place">摆盘<\/button>/.test(HTML) &&
  /<button data-mode="endgame">残局<\/button>/.test(HTML) &&
  HTML.indexOf('data-mode="endgame"') > HTML.indexOf('data-mode="place"') &&
  !/data-mode="analyze"/.test(HTML) && !/data-mode="free"/.test(HTML) &&
  /S\.mode === 'place' \|\| S\.mode === 'endgame'\) \{\s*(?:\/\/[^\n]*\n\s*)*paint\(\); return;\s*\}/.test(JS) &&   // ★ 三十轮：摆盘每摆一子 → 开流式窗口铺下一手方评估分
  /S\.heat && S\.mode !== 'place' && S\.mode !== 'endgame'/.test(JS));
ok('复盘窗启动时从 localStorage 恢复主题（修「深色开出来是浅色」）',
  /gbcalc\.settings\.v1/.test(JS.slice(JS.indexOf('function bootReview'), JS.indexOf('function reviewLoad'))) &&
  /document\.body\.setAttribute\('data-theme', S\.theme\)/.test(JS.slice(JS.indexOf('function bootReview'), JS.indexOf('function reviewLoad'))));
ok('AI 计算时棋盘上有闪动的「计算点」', /G\.busy && G\.think\.length/.test(JS) && /function pulse\(\)/.test(JS));
// 2026-09-18 二轮：复盘独立板块 / 悔棋拆分 / 保存局面 / 取消平衡点 / 交换手棋盘引导
ok('平衡点已取消（不再出现 btn_bal* / findBalance）',
  !/btn_bal/.test(HTML) && !/findBalance/.test(JS) && !/G\.balance/.test(JS));
// ★ 2026-09-19（用户要求）：底栏只剩**一整行居中的对局按键** ——
//   「轮到我方 / AI 思考中…」搬到「引擎仪表盘」卡片下面（#turnPillRow）；
//   复盘那一组按键整组搬进**独立复盘窗口**（#rvBar）。底栏因此从三列网格收成 flex 居中。
ok('棋盘底栏 = 左(分析计算) / 中(对局按键) / 右(AI 执子+设置) 三段（2026-09-27）',
  /<div id="boardFoot">/.test(HTML) &&
  /id="btn_live"/.test(HTML) && /id="btn_aiside"/.test(HTML) && /id="btn_set"/.test(HTML) &&
  // ★ 2026-09-28（用户要求）：三段仍在（DOM 顺序 左→中→右 不变），但**整条允许换行**：
  //   原来 justify-content:space-between + 左右两段 flex:1 1 0 —— 窄窗口下两段被压到 34px
  //   （键本身要 55px）⇒ 键被裁、互相压住 = 用户报的「堆叠」。现在整条居中 + wrap。
  /#boardFoot\{display:flex; align-items:center; justify-content:center; gap:\.42rem \.55rem;\s*\n?\s*flex-wrap:wrap; min-width:0; overflow-x:visible\}/.test(CSS) &&
  /#boardFoot \.bf-side\{[^}]*flex:0 0 auto/.test(CSS) &&
  !/id="rvEnd"/.test(HTML) && !/els\.rvEnd/.test(JS) &&
  /els\.btn_review\.onclick = openReviewFromBoard;/.test(JS));
// ★ 2026-09-28（用户要求，**反转上一版**）：引擎仪表盘最下面的文字框（#turnPillRow/#turnPill）
//   **恢复**回来 —— 「轮到谁 / AI 思考中 / 暂停 / 终局…」落在这里，且**最多只显示两行**；
//   同时标题后面那个「空闲 / 计算中」小胶囊（#calcPill）**整块删除**。
ok('★ 引擎仪表盘下方文字框恢复（#turnPillRow/#turnPill 存在，且最多两行）',
  /id="turnPillRow"/.test(HTML) && /id="turnPill"/.test(HTML) &&
  /'turnPillRow','turnPill',/.test(JS) &&
  /function setTurnPill\(txt\) \{ if \(els\.turnPill\) els\.turnPill\.textContent = txt \|\| ''; \}/.test(JS) &&
  /-webkit-line-clamp:2/.test(CSS));
ok('★ 引擎仪表盘标题后的「空闲 / 计算中」小胶囊已整块删除（#calcPill 三处都不留）',
  !/id="calcPill"/.test(HTML) && !/'calcPill','calcPillTxt',/.test(JS) &&
  !/els\.calcPill/.test(JS) && !/\.calc-pill\{/.test(CSS));

// ===================== 2026-09-28 本轮新增（用户 11 条）源码契约 =====================
// ① 后台预热：跟随官方 rapfi 的 ponder 口径，界面上**关于后台预热的提示文字整条删掉**
ok('★ 后台预热提示文字已删除（只留标签 + 勾选框，preheatHint 三处都不留）',
  !/id="t_preheatHint"/.test(HTML) && !/preheatHint:/.test(JS) &&
  !/'t_preheatHint',/.test(JS) && !/els\.t_preheatHint/.test(JS) &&
  /id="t_preheat"/.test(HTML) && /id="chk_preheat"/.test(HTML) &&
  /preheat: false,/.test(JS));            // 默认关（官方口径：软件默认不开）
// ② 速度 / 节点：**1000 万以下把位数显示全**；超过 1000 万 →「X M」且**保留三位小数**
ok('★ 速度/节点：>1000万 显示 X M 且保留三位小数；以下显示完整位数（不再缩写 k/M）',
  /if \(nps >= 1e7\) return \(nps \/ 1e6\)\.toFixed\(3\) \+ ' M';/.test(JS) &&
  /return String\(Math\.round\(nps\)\);/.test(JS) &&
  !/1e3\) return \(nps \/ 1e3\)\.toFixed\(1\)/.test(JS) &&
  /els\.st_speed\.textContent = c0\.speed != null \? fmtSpeed\(\+c0\.speed\) : '-';/.test(JS) &&
  /els\.st_nodes\.textContent = c0\.nodes != null \? fmtNodes\(\+c0\.nodes\) : '-';/.test(JS));
// ③ 分析计算（★ 09-28 晚口径二修）：gomocalc 式持续分析 —— 主车道满血、无时间窗口、引擎榜单直显
ok('★ 分析计算 = gomocalc 式持续分析：主车道满血 topN=8，无时间窗口（旧 4.5× 定格已删）',
  /var r = await analyzeVote\(liveAnaRoundMs\(\), 8, side, null, null, T\('tagLiveAna'\)\);/.test(JS) &&
  !/LIVE_AN\.winUntil/.test(JS) && !/liveAnaWindowMs/.test(JS) &&
  /function liveAnaAiPending\(\)/.test(JS) &&
  /Math\.round\(Math\.min\(20000, ms\)\)/.test(JS));
ok('★ 分析计算最佳点 = 引擎当前榜单直显（自然微变，不再人为加权/迟滞钉死）',
  !/histAccum|histScore|histLabel|pickStableBest/.test(JS) &&
  /LIVE_AN\.items = cs\.map/.test(JS) &&
  /ev: fmtEval\(c\.eval\), rank: i/.test(JS));
ok('★ 分析计算用时跨轮累加 + 轮间不闪断（paintLiveDash 会话起点 / onEngineLive 保活主车道）',
  /var tShow = \(LIVE_AN\.on && LIVE_AN\.t0\) \? LIVE_AN\.t0 : a\.t0;/.test(JS) &&
  /if \(!\(LIVE_AN\.on && d\.lane === 'main'\)\) delete LIVE_LANES\[d\.lane\];/.test(JS) &&
  /delete LIVE_LANES\.main;/.test(JS));
ok('★ 分析计算让位规则：AI 落子/显式计算忙 → 暂停重试；显式计算键接管、预热让出主车道',
  /if \(G\.busy \|\| G\.ana\.busy\) \{/.test(JS) &&
  /if \(LIVE_AN\.on\) liveAnaToggle\(\);/.test(JS) &&
  /if \(LIVE_AN\.on\) return false;/.test(JS) &&
  /G\.ana\.defWinUntil = Date\.now\(\) \+ streamWindowMs\(\)/.test(JS));
// ④ AI 执子：点开弹窗默认落在「AI 执黑」；两键配色跟随对局设置的浅紫 / 浅蓝
ok('★ 点开「AI 执子」默认落在 AI 执黑（两边都没指定时）',
  /if \(willOpen && !S\.aiB && !S\.aiW\) \{/.test(JS) &&
  /setAiSides\(true, false\);/.test(JS));
ok('★ AI 执子弹窗的执黑/执白配色跟随对局设置（浅紫 / 浅蓝同款 CSS 变量）',
  /#aiSidePop \.tglbtn\[data-ai="b"\]\.on\{background:var\(--side-b-bg\)/.test(CSS) &&
  /#aiSidePop \.tglbtn\[data-ai="w"\]\.on\{background:var\(--side-w-bg\)/.test(CSS) &&
  // ★★ 2026-09-28 修的真 bug：光有上面两条 CSS 还不够 —— 弹窗里那两颗开关原来**没有 data-ai**，
  //   选择器永远匹配不到，落到 .tglbtn.on .tgl{background:var(--accent)} 的默认蓝轨道上
  //   （用户截图：AI 执黑亮起来是蓝的，跟对局设置的浅紫对不上）。HTML 必须带 data-ai。
  //   取色实测工具：tools/measure-aiside-colors.html（无头 Edge 读 getComputedStyle 取真值，
  //   判据 = 弹窗与对局设置逐字节同色，且黑≠白）。
  /<button id="ai_side_b" data-ai="b" class="tglbtn">/.test(HTML) &&
  /<button id="ai_side_w" data-ai="w" class="tglbtn">/.test(HTML));
// ⑤ 底栏：‹ › 按键**加高**（符号自然大一号但不夸张）；窄窗口**整条换行**（绝不堆叠）；↻⇄✥ 三键靠近已有按键
ok('★ ‹ › 按键加高 + 符号只大一档（1.35rem），且必须用 #boardFoot #btn_prev 双 id 选择器',
  // ★★ 旧版写成单 id `#btn_prev`（优先级 (1,0,0)）根本压不过 `#boardFoot .btn`（(1,1,0)），
  //   那条 2rem 是**死规则**（实测字号一直是 .86rem）—— 这里把「必须双 id」锁进契约，防回退。
  /#boardFoot #btn_prev, #boardFoot #btn_next\{[\s\S]{0,120}?font-size:1\.35rem;[\s\S]{0,120}?min-height:2\.1rem;/.test(CSS) &&
  !/#btn_prev, #btn_next\{font-size:2rem/.test(CSS));
ok('★ 窄窗口底栏**换行**（不再 nowrap 滚动、不再把左右两段压扁）；按键内部仍不折行',
  /#boardBtns\{[\s\S]{0,160}?flex-wrap:wrap;/.test(CSS) &&
  /#boardBtns\{[\s\S]{0,200}?flex:0 1 auto; min-width:0;/.test(CSS) &&
  /#boardBtns \.btn, #boardFoot \.bf-side \.btn\{/.test(CSS) &&
  /display:inline-flex; align-items:center; justify-content:center; white-space:nowrap\}/.test(CSS) &&
  /\.nav-group\{margin:0 \.45rem; gap:\.42rem\}/.test(CSS) &&
  /\.lay-group\{margin:0 \.3rem\}/.test(CSS));
ok('★ 复盘 = **独立窗口**（页面 ?rv=1）：#rvBar 整组在主窗口里永不显示',
  /id="btn_review"/.test(HTML) && /id="rvGroup" hidden/.test(HTML) &&
  /<div id="rvBar" hidden>/.test(HTML) &&
  /#rvBar\{display:none\}/.test(CSS) &&
  /body\.rv #rvBar:not\(\[hidden\]\)/.test(CSS) &&
  /id="btn_recite"/.test(HTML) && /id="btn_replay"/.test(HTML) &&
  // ★ 露出一组键的条件是 hist（从历史打开），不是「有没有手数」
  //   ★ 十五轮：残局（vc 记录）整盘首帧打开时同样露出（egFirst），但藏起「背诵复盘」
  /if \(els\.rvGroup\) els\.rvGroup\.hidden = !\(fromHist \|\| egFirst \|\| egLen > 0\);/.test(JS) &&
  /if \(els\.btn_recite\) els\.btn_recite\.hidden = egFirst;/.test(JS) &&
  /function openReviewWindow\(rec, hist\)/.test(JS) &&
  // 老版本「主窗口内切棋盘」的两个入口必须彻底消失
  !/function openReviewPanel\(/.test(JS) && !/function closeReviewPanel\(/.test(JS) &&
  !/G\.rvPanel/.test(JS) && !/G\.rvBackup/.test(JS) && !/G\.rvFromHistory/.test(JS));
ok('★ 复盘窗口由宿主开（tellHost openReview），主窗口棋盘原样不动',
  /tellHost\(\{ type: 'openReview', record: payload \}\)/.test(JS) &&
  /var payload = rec \? recordForReview\(rec, hist\)/.test(JS) &&
  // 开复盘这件事本身**不重排主窗口的局面**（openReviewWindow + openReviewFromBoard 两段里无 newBoard）
  !/newBoard\(\)/.test(JS.slice(JS.indexOf('function openReviewWindow'), JS.indexOf('function openRecord'))) &&
  // 从历史打开 = 开复盘窗口（不是把局面摆到主棋盘上「接着下」）；顶栏「复盘」显式 hist=false。
  // ★ 2026-09-19：历史那三条入口（点条目 / 抽屉「打开」/ 右键「打开复盘」）都收进
  //   openFromHistoryIndex —— 主窗口那支调 openReviewWindow(h, true)。
  /function openFromHistoryIndex\(idx\) \{[\s\S]{0,400}?openReviewWindow\(h, true\);/.test(JS));
ok('「背错 N 子」是浅蓝小矩形（missbox，非按键）',
  /id="rvMiss" class="missbox"/.test(HTML) && /\.missbox\{/.test(CSS) &&
  /--missbox-bg:#cfe7fb/.test(CSS) && /function setMissBox\(/.test(JS) &&
  !/btn_rvmiss/.test(HTML));
ok('悔棋拆成 上一步 / 下一步（人机一次撤两手）',
  /id="btn_prev"/.test(HTML) && /id="btn_next"/.test(HTML) &&
  /function stepBack\(/.test(JS) && /function stepForward\(/.test(JS) && /G\.redo/.test(JS));
ok('保存 GIF 改为 保存局面（棋盘导出 PNG + 带出局面代码）',
  /id="btn_save"/.test(HTML) && /function savePos\(/.test(JS) &&
  /toDataURL\('image\/png'\)/.test(JS) && !/btn_gif/.test(HTML));
ok('局面代码实时镜像棋盘（不再「填过一次就冻结」）+ 格式与 gomocalc.com 一致',
  /placeholder="h8h9g7…"/.test(HTML) &&
  /if \(document\.activeElement !== els\.inp_code\) \{/.test(JS) &&
  /var codeTxt = buildCode\(\);/.test(JS) &&
  /String\.fromCharCode\(97 \+ x\) \+ \(N - y\)/.test(JS) &&
  /low\.match\(\/\(\[a-z\]\)\(\\d\+\)\/g\)/.test(JS) &&
  /if \(winAt\(board, x, y, c, exactFiveRule\(c\)\)\) break;/.test(JS));
ok('粘贴：宿主读系统剪贴板（navigator.clipboard 被拒也有兜底）+ 粘贴即载入',
  /tellHost\(\{ type: 'paste' \}\)/.test(JS) && /function applyCodeText\(/.test(JS) &&
  /function loadFromCode\(/.test(JS) && /m\.type === 'clip'/.test(JS) &&
  /ReadClipboardText/.test(HOST) && /"\\"paste\\""/.test(HOST) &&
  /WriteClipboardText/.test(HOST));
ok('曲线删掉「可向后延伸」提示句（但滚动跟随保留）',
  !/t_curveHint/.test(HTML) && /scroll\.scrollLeft = w;/.test(JS));
ok('★ 曲线面积 = 单路径闭合填充（0 分线为基准，平滑不一条一条）',
  /ctx\.moveTo\(flat\[0\]\.x, yz\);/.test(JS) &&
  /ctx\.lineTo\(flat\[flat\.length - 1\]\.x, yz\);/.test(JS) &&
  !/globalAlpha = 0\.16/.test(JS));
// ★ 2026-09-25（用户定稿）：「渐变是从曲线向 0 点横坐标变浅的，并且填充效果不好，
//   应该符合曲线边缘的填充效果」→ 撤掉按包围盒算的**垂直**渐变（黑白两条线浓淡方向
//   相反、且浓淡只跟纵坐标有关），改成「均匀底色 + 裁剪到区域内沿曲线的羽化描边」。
ok('★ 曲线填充：渐变**由曲线向 0 横坐标轴由深到浅，正负两侧同一套**（逐层收缩，非垂直渐变）',
  !/createLinearGradient\(0, topY, 0, botY\)/.test(JS) &&
  !/grad\.addColorStop\(0, rgba\(color, 0\.30\)\)/.test(JS) &&
  /function scaledY\(q, s\) \{ return yz \+ \(q\.y - yz\) \* s; \}/.test(JS) &&   // 朝 0 分线等比收缩
  /var AREA_LAYERS = 24, AREA_STEP = 0\.010;/.test(JS) &&
  /for \(var li = 0; li < AREA_LAYERS; li\+\+\) \{/.test(JS) &&
  /for \(var f5 = flat\.length - 1; f5 >= 0; f5--\) ctx\.lineTo\(flat\[f5\]\.x, scaledY\(flat\[f5\], sIn\)\);/.test(JS) &&
  /ctx\.fillStyle = rgba\(color, 0\.05\);/.test(JS));
// ★★ 2026-09-25 真因（用户连着三轮说「填充不贴曲线 / 不平滑」）：面积采样把三次贝塞尔的
//   Bernstein 权重**写反了** —— w1=u³ 乘的是 P1、w4=v³ 乘的是 P2，等价于 Bezier(P2,C2,C1,P1)，
//   也就是**同一条曲线倒着走**：于是每段采样从 P2 走到 P1，`flat` 变成
//   「pts[1]→pts[0]，跳 pts[2]→pts[1]，跳 pts[3]→pts[2]…」的来回折返锯齿。
//   描边 trace() 用的是真 bezierCurveTo（线一直是顺的），填充用的却是这条折返多边形 ——
//   所以线顺、填充永远不顺。这里**直接把公式抠出来数值验算**，防止再写反。
(function () {
  var m = /var w1 = ([^;]+);[\s\S]{0,240}?flat\.push\(\{ x: ([^,]+),/.exec(JS);
  var fn = null;
  if (m) {
    try {
      // 源码里写的是 p1.x / c1x / c2x / p2.x —— 这里喂标量，把 .x 与 x 后缀抹掉即可
      var expr = m[2].replace(/\.x/g, '').replace(/\bc1x\b/g, 'c1').replace(/\bc2x\b/g, 'c2');
      fn = new Function('u', 'v', 'p1', 'c1', 'c2', 'p2',
        'var w1 = ' + m[1] + '; return ' + expr + ';');
    } catch (e) { fn = null; }
  }
  // 不对称的控制点：p1=0, c1=10, c2=20, p2=100 —— 权重一写反，端点立刻翻车
  var atStart = NaN, atEnd = NaN;
  try {
    atStart = fn(0, 1, 0, 10, 20, 100);   // t=0 必须落在 p1
    atEnd = fn(1, 0, 0, 10, 20, 100);     // t=1 必须落在 p2
  } catch (e) {}
  ok('★ 面积采样 = 正确的三次贝塞尔 Bernstein 权重（t=0 起于 P1、t=1 止于 P2，不是倒着走）',
    !!fn && Math.abs(atStart - 0) < 1e-9 && Math.abs(atEnd - 100) < 1e-9,
    fn ? ('（实测 t=0 → ' + atStart + '，t=1 → ' + atEnd + '）') : '（公式没抠到）');
})();

// ★★ 2026-09-25（用户定稿）：曲形面积的渐变 = **从曲线向 0 横坐标轴由深到浅，正负同一套**。
//   实现方式：把曲线朝 0 分线等比收缩 s∈[0,1]（s=1 曲线、s=0 轴），第 li 层填
//   「曲线 ↔ 收缩到 sIn=li/N 的副本」之间的带 ⇒ 任一点被覆盖的层数 ∝ 它的 s。
//   这里**把分层算法抠出来数值复算**：验 ① 靠曲线最浓、靠 0 分线最淡（单调递减）；
//   ② 曲线在轴**上方**与在轴**下方**时，同一个 s 的浓淡**完全一样**（正负对称）；
//   ③ 撤掉垂直渐变（createLinearGradient），它只认屏幕纵坐标、正负两侧浓淡必然相反。
(function () {
  var mL = /var AREA_LAYERS = (\d+), AREA_STEP = ([\d.]+);/.exec(JS);
  var mS = /function scaledY\(q, s\) \{ return yz \+ \(q\.y - yz\) \* s; \}/.test(JS);
  var mI = /var sIn = li \/ AREA_LAYERS;/.test(JS);
  var N = mL ? parseInt(mL[1], 10) : 0, STEP = mL ? parseFloat(mL[2]) : 0;
  // 某点参数 s 处累计的不透明度：被覆盖层数 = #\{li : li/N <= s\}
  function alphaAt(s) {
    var cnt = 0;
    for (var li = 0; li < N; li++) if (li / N <= s) cnt++;
    return 1 - Math.pow(1 - STEP, cnt);
  }
  var aCurve = alphaAt(1), aMid = alphaAt(0.5), aAxis = alphaAt(0.02);
  // 正负对称：把 yz=100、曲线在上方 y=20（s=1 → 20）与下方 y=180 都按公式折回 s，应同一个 s
  var yz = 100, up = 20, down = 180;
  function sOf(yc, y) { return (y - yz) / (yc - yz); }        // scaledY 的逆
  var sUp = sOf(up, 60), sDown = sOf(down, 140);              // 两侧各取「离轴 40px」的同名点
  ok('★ 曲形面积渐变 = 从曲线向 0 横坐标由深到浅（贴曲线最浓、贴 0 分线最淡，单调）',
    N >= 8 && STEP > 0 && mS && mI &&
    aCurve > aMid && aMid > aAxis && aAxis < 0.05,
    '（实测 贴曲线=' + aCurve.toFixed(3) + ' 中段=' + aMid.toFixed(3) +
    ' 贴0线=' + aAxis.toFixed(3) + '，' + N + ' 层 × ' + STEP + '）');
  ok('★ 该渐变正负两侧**同一套**（只按「曲线↔0分线」比例算，与曲线在轴上方/下方无关）',
    Math.abs(sUp - sDown) < 1e-9 && Math.abs(alphaAt(sUp) - alphaAt(sDown)) < 1e-12,
    '（实测 上方 s=' + sUp.toFixed(3) + ' / 下方 s=' + sDown.toFixed(3) + ' → 同浓度）');
  ok('★ 已撤掉「垂直渐变」（正负浓淡相反、且浓淡与曲线无关）',
    !/createLinearGradient\(0, topY, 0, botY\)/.test(JS) &&
    !/grad\.addColorStop/.test(JS) &&
    !/var FEATHER = \[/.test(JS));
})();
ok('★ 评估分数取 Rapfi 官方编码（VALUE_MATE=30000 / 非杀棋钳 ±6000，不再自造 1000+n）',
  /var RAPFI_MATE = 30000;/.test(JS) && /var RAPFI_EVAL_MAX = 6000;/.test(JS) &&
  /var mv = RAPFI_MATE - ply;/.test(JS) &&
  !/return 1000 \+ parseInt\(m\[1\], 10\);/.test(JS) &&
  // 杀棋不参与纵轴定档（否则 29988 会把整条曲线压成直线）
  /if \(vb > RAPFI_EVAL_MAX \|\| vw > RAPFI_EVAL_MAX\) return;/.test(JS) &&
  // 杀棋压进最外侧 8% 窄带：越短杀越贴边
  /var band = 0\.08 \* \(1 - d\);/.test(JS));
ok('交换手规则棋盘引导：虚线区域 + 角刻线 + 标注（塔拉山口 / 山口 / 一手交换）',
  /function drawOpenGuide\(/.test(JS) && /setLineDash\(/.test(JS) &&
  /strokeRect\(a, a, b - a, b - a\)/.test(JS) && /OPEN\.kind === 'yama'/.test(JS) &&
  /OPEN\.kind === 'swap1'/.test(JS));
ok('局面代码在对局设置卡片低端；复制/粘贴/载入三小键与标题同行等宽对齐',
  /function buildCode\(\)/.test(JS) && /function parseCode\(/.test(JS) &&
  /class="codeHead"/.test(HTML) && /\.codeHead \.btn\.sq2\{/.test(CSS) &&
  /btn_copy/.test(HTML) && /btn_paste/.test(HTML) && /btn_load/.test(HTML) &&
  !/codeActs/.test(HTML));
// 2026-09-18 六轮：底部按键整行居中。★ 2026-09-25（用户要求）重排：
//   ‹ ›（图标键）→ 重新开始 → ❚❚/▶（开关键）→ 保存局面 → ↻（旋转）→ ⇄（镜像/翻转）
ok('底部按键整行居中：‹ › / 重新开始 / 开关键 / 保存局面 / ↻ / ⇄ 按序排列',
  /#boardBtns\{[\s\S]{0,120}?justify-content:center/.test(CSS) &&
  (function () {
    var order = ['btn_prev', 'btn_next', 'btn_reset', 'btn_pause', 'btn_save', 'btn_rot', 'btn_mirror']
      .map(function (id) { return HTML.indexOf('id="' + id + '"'); });
    for (var i = 0; i < order.length; i++) if (order[i] < 0) return false;
    for (var j = 1; j < order.length; j++) if (order[j] < order[j - 1]) return false;
    return true;
  })() &&
  /#boardBtns\{/.test(CSS) && /id="boardBtns">[\s\S]{0,500}?<button id="btn_prev"/.test(HTML) &&
  /id="btn_rot"[^>]*>↻<\/button>/.test(HTML) && /id="btn_mirror"[^>]*>⇄<\/button>/.test(HTML) &&
  /id="btn_prev"[^>]*>‹<\/button>/.test(HTML) && /id="btn_next"[^>]*>›<\/button>/.test(HTML) &&
  /id="mirrorPop"/.test(HTML) && /id="btn_mv_fv"/.test(HTML) && /id="btn_mv_d2"/.test(HTML));
ok('暂停键图标随状态来回切换（❚❚ ↔ ▶），三态都可用',
  /var aiRunning = G\.busy \|\|/.test(JS) &&
  /els\.btn_pause\.textContent = \(S\.paused \|\| !aiRunning\) \? '▶' : '❚❚';/.test(JS) &&
  /if \(G\.busy\) \{ S\.paused = true;/.test(JS) &&
  /if \(S\.paused\) \{ S\.paused = false;/.test(JS) &&
  /aiAssistOnce\(\);/.test(JS));
// 2026-09-18 六轮：判胜 —— AI 落子也必须走终局判定（白子连成十个不结束的 bug）
ok('判胜统一出口 settleMove（玩家 / AI 自动 / AI 辅助三条落子路径都判）',
  /function settleMove\(\)/.test(JS) && /if \(settleMove\(\)\) \{ paint\(\); return; \}/.test(JS) &&
  (JS.match(/if \(settleMove\(\)\) \{ G\.busy = false; paint\(\); return; \}/g) || []).length === 2 &&
  /winCheck\(G\.board, last\.x, last\.y, last\.c\)/.test(JS));
ok('胜负判定对齐 gomocalc.com：五连即胜，长连按规则「正好五子」才赢',
  /function winAt\(b, x, y, c, exactlyFive\)/.test(JS) &&
  /if \(exactlyFive \? \(n === 5\) : \(n >= 5\)\) return true;/.test(JS) &&
  // ★ 2026-09-19：判定与「渲染规则」拆开 —— ruleForRender() 让复盘窗恒用无禁手（0），
  //   主窗口用用户选的规则；所以精确五子的判定搬进 exactFiveFor(rule, color)。
  /function exactFiveFor\(rule, moverColor\)/.test(JS) &&
  /if \(rule === 1\) return true;/.test(JS) &&
  /if \(rule === 2 \|\| rule === 6 \|\| rule === 7\) return moverColor === 1;/.test(JS) &&
  /function exactFiveRule\(moverColor\) \{ return exactFiveFor\(ruleForRender\(\), moverColor\); \}/.test(JS) &&
  /function winCheck\(b, x, y, c\) \{ return winAt\(b, x, y, c, exactFiveFor\(ruleForRender\(\), c\)\); \}/.test(JS));
// ★ 2026-09-19：复盘搬出主窗口后，主窗口的「重新开始」不再需要按状态改文案 ——
//   「重来」只存在于复盘窗口（#btn_redo_rv），且点它只清空局面、**不写历史**。
ok('主窗口「重新开始」文案固定；「重来」只属于复盘窗口（且不写历史）',
  /els\.btn_reset\.textContent = T\('reset'\);/.test(JS) &&
  !/inRv/.test(JS) &&
  /function redoReview\(\)/.test(JS) &&
  /els\.btn_redo_rv\.onclick = redoReview;/.test(JS) &&
  /els\.btn_redo_rv\.textContent = T\('redo'\);/.test(JS) &&
  /redo: '重来'/.test(JS) && /redo: 'Redo'/.test(JS) &&
  // 只清局面：这一段里不许出现 addRecord
  !/addRecord/.test(JS.slice(JS.indexOf('function redoReview'), JS.indexOf('function buildCode'))));
ok('背错按手数记录（missAt），上一步/下一步能复原「哪个子错了」',
  /missAt: \{\}/.test(JS) && /G\.review\.missAt\[k\] = \{ x: x, y: y \};/.test(JS) &&
  /for \(var key in G\.review\.missAt\)/.test(JS) &&
  /if \(idx < k\) \{ n\+\+; G\.missRings\.push\(G\.review\.missAt\[key\]\); \}/.test(JS));
// 2026-09-18 六轮：取消板块拖动改尺寸
ok('板块「拖动改变尺寸」已彻底取消（split / gripbar / grip 全部移除）',
  !/class="split"/.test(HTML) && !/id="splitL"/.test(HTML) && !/id="splitR"/.test(HTML) &&
  !/class="gripbar"/.test(HTML) && !/class="grip"/.test(HTML) &&
  !/onGripDown/.test(JS) && !/onSplMove/.test(JS) && !/syncSplitters/.test(JS) &&
  !/\.gripbar\{/.test(CSS) && !/\.split\{/.test(CSS) &&
  /gbcalc\.layout\.v7/.test(JS));   // ★ 2026-09-27：曲线并入仪表盘 + 新默认集 → v7
// 2026-09-18 七轮：停靠栏左右对称 + 空栏收起 + 拖动换栏/调序
ok('板块搬运只靠拖动标题栏（▲▼◀▶ 控制键已全部删除，改成一根小横杠提示）',
  /function onCardDown\(/.test(JS) && /function applyLayout\(/.test(JS) &&
  !/dockW/.test(JS) && !/st\.h\)/.test(JS) &&
  !/function moveCard\(/.test(JS) && !/data-act=/.test(HTML) && !/class="dbtn"/.test(HTML) &&
  !/\.dbtn/.test(CSS) &&
  /class="dash"/.test(HTML) && /\.card-h \.dash\{/.test(CSS) &&
  // 拖动落点仍然给出占位块，松手写入布局（顺序持久化）
  /drag\.ph/.test(JS) && /function onCardUp\(/.test(JS) &&
  /l\.order\[dn === 'dockL' \? 'L' : 'R'\] = \[\]\.map\.call/.test(JS) &&
  /var list = order\[dn === 'dockL' \? 'L' : 'R'\];/.test(JS));
// ★ 空栏必须收干净：卡片全搬到左边后右栏不能还占着 23rem（用户截图「尺寸不协调」的根因）
// ★ 2026-09-20 更新：面板显隐由「卡片」功能键接管 ⇒ 数「有没有卡片」时要**只数没被隐藏的**，
//   并且「卡片」功能条本身也算占位（否则用户把面板全关掉时右栏塌成 0 宽，那颗键跟着消失就点不回来了）。
ok('空停靠栏收成 0 宽（.has 类驱动，不用 :empty —— 搬走后还剩空白文本节点）',
  /\.dock:not\(\.has\)\{flex:0 0 0; width:0; min-width:0/.test(CSS) &&
  /\.dock\.has\{flex:0 0 auto; width:20rem/.test(CSS) &&
  /function syncDocks\(\)/.test(JS) &&
  /var live = \[\]\.filter\.call\(dock\.querySelectorAll\('\.card'\), function \(c\) \{ return !c\.hidden; \}\);/.test(JS) &&
  /dock\.classList\.toggle\('has', live\.length > 0 \|\| !!dock\.querySelector\('\.cardbar'\)\)/.test(JS) &&
  !/#dockR\{/.test(CSS) && !/#dockL\{/.test(CSS));
// ★ 用户 2026-09-18：「全屏状态下左右各一列，不能左边两列右边一列，也不能右边两列左边一列」
//   原先「一栏里 ≥2 个板块就摊成双列」的网格会让某一侧变两列 → 不对称，已整体删除。
ok('每侧永远只有一列（栏内双列网格已删除，.two 类不再使用）',
  !/\.dock\.has\.two/.test(CSS) && !/grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/.test(CSS) &&
  !/toggle\('two'/.test(JS) && !/classList\.contains\('two'\)/.test(JS));
// ★ 2026-09-27（用户要求）：评估曲线并入引擎仪表盘（三卡）；引擎仪表盘默认显示，
//   对局设置 / 计算评估默认收起（棋盘下的「设置」弹窗里开）—— 布局 key v6 → v7。
ok('默认布局：引擎仪表盘默认显示；设置/评估默认收起（曲线已并入，v7）',
  /var CARD_IDS = \['setup', 'analysis', 'engine'\];/.test(JS) &&
  /var DEFAULT_CARDS = \{ setup: 0, analysis: 0, engine: 1 \};/.test(JS) &&
  /function defaultLayout\(\)/.test(JS) &&
  /\['engine'\]\.forEach\(function \(id\) \{/.test(JS) &&
  /els\.dockL\.appendChild\(c\);/.test(JS) &&
  /if \(fresh\) defaultLayout\(\);/.test(JS) &&
  /var fresh = !order\.L && !order\.R;/.test(JS) &&
  /gbcalc\.layout\.v7/.test(JS));
// ★ 2026-09-20（用户要求）：「计算评估：里面有计算、扫描防守、停止计算、多点分析、平衡一、平衡二，
//   这些功能，一定要参考这种现有的亦心棋盘思路……把它给摘取下来」+「计算评估里面把 AI 视图和
//   指导视图这个板块从对局设置里面移动到这个计算评估这个窗口里面」。
//   命令语义照搬 Rapfi 整合包 function/toolbar*.txt（thinking start/stop、searchdefend、nbest、
//   balance1/balance2）；命令本身走 :8964/页面内 Worker 的 analyze，不引新协议。
ok('★ 计算评估卡：五键（多点分析/平衡一/平衡二/扫描防守/计算·停止计算同键）+ 数字输入；AI视图/指导视图已从对局设置搬进来',
  /<section class="card" data-id="analysis">/.test(HTML) &&
  /id="btn_an_stop"/.test(HTML) && /id="btn_an_nbest"/.test(HTML) &&
  /id="btn_an_bal1"/.test(HTML) && /id="btn_an_bal2"/.test(HTML) &&
  // ★ 2026-09-20 二轮（用户反馈）：扫描防守回归；「计算/停止计算」合并成一颗键（无独立 calc 键）；
  //   「计算对象」（用户/AI 手动开关）整行删除 —— 恒按行棋方算。
  /id="btn_an_defend"/.test(HTML) && !/id="btn_an_calc"/.test(HTML) &&
  !/id="seg_anview"/.test(HTML) && !/data-view=/.test(HTML) && !/计算对象/.test(HTML) &&
  // ★ 2026-09-25（用户要求）：「计算」收成半宽（去掉 wide），右半格放「清除标记」。
  /class="btn accent">计算<\/button>/.test(HTML) &&
  /id="btn_fwd_clear"/.test(HTML) &&
  HTML.indexOf('id="btn_an_stop"') < HTML.indexOf('id="btn_fwd_clear"') &&
  /id="num_nbest"[^>]*min="2"[^>]*max="8"/.test(HTML) &&
  /id="anStatus"/.test(HTML) && /id="anList"/.test(HTML) &&
  // .heatbox 落在 analysis 段里（在对局设置段里必须找不到 —— 这就是「搬过去」）
  HTML.indexOf('class="heatbox"') > HTML.indexOf('data-id="analysis"') &&
  // ★ 用 class="heatbox" 这个**元素**判，不要用裸的 'heatbox' 子串 ——
  //   对局设置卡里留了一条「本来的组框已搬到下面」的说明注释，裸子串会被它绊倒（假红）。
  HTML.slice(HTML.indexOf('data-id="setup"'), HTML.indexOf('data-id="analysis"'))
      .indexOf('class="heatbox"') < 0);
ok('★ 计算评估四键照搬亦心/Rapfi 侧边栏语义（多点分析=nbest、平衡二=二手平衡且翻成我方视角）',
  /async function anaNbest\(\)/.test(JS) && /async function anaBal1\(\)/.test(JS) &&
  /async function anaBal2\(\)/.test(JS) && /function anaStop\(\)/.test(JS) &&
  // ★ 2026-09-20 二轮：anaCalc（计算）/ anaDefend（扫描防守）回归；「计算/停止计算」同键，
  //   文字随状态走（闲=计算、忙=停止计算）—— 见 anaCalcUI()。
  /async function anaCalc\(\)/.test(JS) && /function anaDefend\(renew\)/.test(JS) &&
  /function anaCalcUI\(\)/.test(JS) &&
  /els\.btn_an_stop\.textContent = busy \? T\('anStop'\) : T\('anCalc'\);/.test(JS) &&
  /els\.btn_an_stop\.onclick = function \(\) \{ if \(G\.ana\.busy\) anaStop\(\); else anaCalc\(\); \};/.test(JS) &&
  // 手动视角开关删干净（anaAsk / anaTargetColor / S.anView 一个不许留）
  !/anaAsk/.test(JS) && !/anaTargetColor/.test(JS) && !/anView/.test(JS) &&
  // 扫描防守 = 页面内形状启发式（不走引擎）：四方向「连子数+两端开闭」查表打分
  /function cellScore\(board, x, y, c\)/.test(JS) && /function anaLineScore\(cnt, open\)/.test(JS) &&
  /var N = 9, M = 9, hx = \(N - 1\) \/ 2, hy = \(M - 1\) \/ 2;/.test(JS) &&
  // ★ 2026-09-20 三轮：徽标改最短杀记法（五轮起记号 = Yixin 的 W/L），A/B/C 字母退场；
  //   ★ 五轮：renderDefendMarks 共用出口 + 前三名 inline 双行 + 引擎精修收敛轮
  /function cellLines\(board, x, y, c\)/.test(JS) &&
  /function defendMateAt\(board, x, y, me, opp\)/.test(JS) &&
  /function renderDefendMarks\(cells\)/.test(JS) &&
  /async function anaDefendRefine\(gen\)/.test(JS) &&
  /badge: c\.badge \|\| c\.mate \|\| String\(i \+ 1\),[\s\S]{0,60}?label: c\.pct \+ '%', tier: i, inline: true/.test(JS) &&
  /if \(m\) return \(m\[1\] === '-' \? '-' : '\+'\) \+ 'M' \+ m\[2\];/.test(JS) &&
  /plain: true,/.test(JS) &&
  /function wireAnalysis\(\)/.test(JS) &&
  // ★ 四键必须真被接上：wireColors/wireCards/wireAnalysis 三连要出现在 boot() 的布局初始化之后
  //   （只定义不接线 = 页面不报错但调色窗 / 卡片键 / 计算评估四键全无反应，2026-09-20 实测踩过）。
  /applyLayout\(\);[\s\S]{0,400}?wireColors\(\);[\s\S]{0,80}?wireCards\(\);[\s\S]{0,80}?wireAnalysis\(\);/.test(JS) &&
  // 停止计算 = 代数 +1 作废在途结果 + 清标注（引擎那次搜索本身停不掉）
  /G\.ana\.gen\+\+;[\s\S]{0,220}?G\.ana\.marks = \[\];/.test(JS) &&
  // 平衡二：虚拟落子后行棋方变成对手 → eval 取负才是我方视角（与 pushCurve 一致）
  /var after = cs2\.length \? -evalNum\(cs2\[0\]\.eval\) : evalNum\(c\.eval\);/.test(JS));
ok('★ 分析结果画在棋盘上：名次徽标（数字 / A-H / ≡）+ 评估分标签，复盘窗不画',
  /G\.ana\.marks\.forEach\(function \(mk\) \{/.test(JS) &&
  /ctx\.fillText\(mk\.badge, px, py \+ 0\.5\);/.test(JS) &&
  /ctx\.strokeText\(mk\.label, pick\.x, pick\.y\);/.test(JS) &&
  /var ANA_PAL = \[/.test(JS) && /var ANA_BAL = \{/.test(JS) &&
  /function aiDecorOn\(\) \{ return !RV_MODE && !G\.review; \}/.test(JS) &&
  /if \(G\.ana\.marks\.length && aiDecorOn\(\)\) \{/.test(JS) &&
  /badge: isBal \? '≡' : String\(i \+ 1\)/.test(JS) &&
  // ★ 2026-09-20 四轮：多点分析多彩圆圈（ANA_PAL 名次色）+ 数字融入评估圆圈
  //   （inline：数字小字在上、评估小字在下 —— 官方 Gomocalc 的格内遮罩语言）；
  //   三轮的 neutral 中性圈已整体作废（实现与断言一起清）。
  /badge: String\(i \+ 1\), label: fmtEval\(c\.eval\), tier: anaTierOf\(i\), inline: true/.test(JS) &&
  /if \(mk\.inline\) \{/.test(JS) &&
  !/mk\.neutral/.test(JS) &&
  // 局面一变（落子 / 重开 / 载入）旧标注立刻作废 —— 三处入口都收口到 anaReset()
  ((JS.match(/anaReset\(\)/g) || []).length >= 3));
ok('★ 计算评估六键 + 「颜色 / 卡片」都有中英两套文案',
  /anCalc: '计算'/.test(JS) && /anStop: '停止计算'/.test(JS) && /anDefend: '扫描防守'/.test(JS) &&
  /anDefendDone: '扫 \{c\} 点：%越高越要防，W=距赢 L=距输'/.test(JS) &&   // ★ 廿九轮：仪表盘下文案 ≤2 行，简化口径
  // ★ 2026-09-24（用户要求）：取代旧的「黑（先手）/ 白（后手）」二选一.
  /sideAiB: 'AI 执黑', sideAiW: 'AI 执白'/.test(JS) &&
  /sideAiB: 'AI plays Black', sideAiW: 'AI plays White'/.test(JS) &&
  /data-ai="b" class="tglbtn"><span class="tgl"><i><\/i><\/span><span class="tgl-txt">AI 执黑<\/span><\/button>/.test(HTML) &&   // ★ 三十轮：拨动式开关
  /data-ai="w" class="tglbtn"><span class="tgl"><i><\/i><\/span><span class="tgl-txt">AI 执白<\/span><\/button>/.test(HTML) &&   // ★ 三十轮：拨动式开关（默认都不亮）
  !/data-ai="w" class="on"/.test(HTML) &&                                                    // ★ 三十轮：默认 AI 执白不亮
  /aiB: false, aiW: false,/.test(JS) &&                                                      // ★ 三十轮：默认两色都不开（用户自己下）
  !/id="t_players"/.test(HTML) && !/id="whoUser"/.test(HTML) &&
  /anNbest: '多点分析'/.test(JS) && /anBal1: '平衡一'/.test(JS) && /anBal2: '平衡二'/.test(JS) &&
  /anCalc: 'Compute'/.test(JS) && /anStop: 'Stop'/.test(JS) && /anDefend: 'Defend scan'/.test(JS) &&
  /anNbest: 'Multi-point'/.test(JS) && /anBal1: 'Balance 1'/.test(JS) && /anBal2: 'Balance 2'/.test(JS) &&
  !/anView/.test(JS) &&
  /themeCustom: '自定义'/.test(JS) && /themeCustom: 'Custom'/.test(JS) &&
  /color: '颜色'/.test(JS) && /color: 'Colours'/.test(JS) &&
  /cards: '卡片'/.test(JS) && /cards: 'Cards'/.test(JS));
// ★★ 2026-09-20 五轮（用户要求批次）：预览框开关 / 自定义色记忆 / 描边变细 / 渐变色板
ok('★ 五轮：预览框开关（默认开）+ 自定义颜色记忆槽 + 棋子描边变细 + 青蓝→深红渐变',
  /previewOn: true/.test(JS) &&
  /customColors: \{ board: '', page: '' \}/.test(JS) &&
  /S\.customColors\.board = S\.boardColor;/.test(JS) &&        // 切深/浅主题先存记忆槽
  /S\.boardColor = S\.customColors\.board;/.test(JS) &&        // 点「自定义」原样还原
  /S\.customColors\.board = ''; S\.customColors\.page = '';/.test(JS) &&   // 恢复默认连槽清
  /G\.hover && S\.previewOn !== false/.test(JS) &&             // 悬停方块受开关管
  /id="chk_preview"/.test(HTML) &&
  /preview: '预览框'/.test(JS) && /preview: 'Hover box'/.test(JS) &&
  /Math\.max\(0\.9, gap \* 0\.026\)/.test(JS) && /Math\.max\(0\.7, gap \* 0\.016\)/.test(JS) &&   // 描边变细
  /rgba\(25,118,210,\.95\)/.test(JS) && /rgba\(176,32,32,\.95\)/.test(JS) &&   // 卡塔狗名次色两端：蓝/深红
  /rgba\(56,142,60,\.95\)/.test(JS) && /rgba\(235,180,20,\.95\)/.test(JS) &&   // 卡塔狗名次色中段：绿/黄（09-27 意见②）
  /function anaInlineMetrics\(ctx, mk, mr\)/.test(JS) &&
  /anDefendStable: '已收敛，结论稳定/.test(JS));
// ★★ 2026-09-20 五轮：前瞻（残局自动推演到五连终局）
ok('★ 五轮前瞻：开关键变色 + < > 步进 + 色框代码链（黑紫/白浅蓝）+ 临时盘推演不碰真盘',
  /async function fwdRun\(\)/.test(JS) &&
  /function fwdToggle\(\)/.test(JS) && /function fwdCommit\(\)/.test(JS) &&
  /function fwdStep\(d\)/.test(JS) && /function renderFwdSeq\(\)/.test(JS) &&
  /function fwdQueue\(\)/.test(JS) &&
  /G\.board\.map\(function \(row\) \{ return row\.slice\(\); \}\)/.test(JS) &&   // 临时盘拷贝
  /id="fwdBox"/.test(HTML) && /id="btn_fwd"/.test(HTML) &&
  /id="btn_fwd_prev"/.test(HTML) && /id="btn_fwd_next"/.test(HTML) &&
  /\.fwc\.b\{background:#7a5cc7/.test(CSS) && /\.fwc\.w\{background:#aed6f0/.test(CSS) &&
  /fwd: '前瞻'/.test(JS) && /fwd: 'Look-ahead'/.test(JS) &&
  /G\.fwd && G\.fwd\.on && G\.fwd\.line\.length && aiDecorOn\(\)/.test(JS) &&  // 棋盘透明推演子
  /G\.fwd && G\.fwd\.on && !G\.fwd\.hold\) fwdQueue\(\);/.test(JS));           // 落子后自动重推（hold 闸）
// ★★ 2026-09-21 六轮：前瞻优化（图例 / 确定键 / 变灰可点 / 不重算 / 渐变序号 / 防闪 / 专用车道）
ok('★ 六轮前瞻：紫黑/浅蓝图例 + 选中→确定键两段式 + 确定后变浅仍可点 + 冻结不重算 + 渐变序号 + 阶段渲染 + fwd 车道',
  /class="fwd-lg"/.test(HTML) && /lgfr-b/.test(HTML) && /lgfr-w/.test(HTML) &&  // ★ 五轮：图例色框
  /id="btn_fwd_ok"/.test(HTML) &&                                             // 确定键
  /fwdOk: '确定'/.test(JS) && /fwdOk: 'Commit'/.test(JS) &&                   // 中英文案
  /\.fwdkey\{background:#5fb6e6/.test(CSS) &&                                 // 前瞻键舒心天蓝
  /\.fwdok\.on\{/.test(CSS) && /\.fwc\.dim\{/.test(CSS) && /\.fwc\.sel\{/.test(CSS) &&
  /function fwdSelect\(i\)/.test(JS) && /function fwdOkUI\(\)/.test(JS) &&    // 选中/确定键状态
  /G\.fwd\.hold = true;/.test(JS) &&                                          // 确定后冻结
  /G\.fwd && G\.fwd\.on && !G\.fwd\.hold\) fwdQueue\(\);/.test(JS) &&         // hold 期间不自动重推
  /if \(fi <= G\.fwd\.committed\) continue;/.test(JS) &&                      // 已确定的不叠透明子
  /ctx\.fillText\(String\(fi \+ 1\), fx, fy \+ 0\.5\);/.test(JS) &&           // 推演子渐变序号
  /function fwdHoverRelease/.test(JS) && /FWD_HOLD_MS/.test(JS) &&            // 阶段性渲染防闪烁
  /lane: 'fwd', side: cc,/.test(JS) &&                       // ★十六轮：专用 fwd 车道 + 显式行棋方 side
  /G\.fwd\.base \+ fi \+ 1/.test(JS) &&                                       // 显示序号=应有的手数
  /flex-direction:row/.test(CSS) && /fwdkey\{white-space:nowrap\}/.test(CSS) && // ★ 五轮：图例横排+键文字横排
  /els\.chk_num\.onchange = function \(\) \{ S\.showNum = !!els\.chk_num\.checked; save\(\); paint\(\); \};/.test(JS) &&
  /ng\.addColorStop\(0, '#8ec9ff'\)/.test(JS) &&                              // 序号渐变（显示序号同族）
  /cid: 'defA-' \+ gen \+ '-' \+ r, lane: 'fwd'/.test(JS) &&                  // 精修挪专用 fwd 车道
  /var RD = \[600, 1400, 2600\];/.test(JS) &&                                // ★廿八轮：原生算力下预算加深
  /e\.key !== 'ArrowLeft' && e\.key !== 'ArrowRight'/.test(JS) &&            // 键盘 ←/→ 步进前瞻
  /fwdStep\(e\.key === 'ArrowLeft' \? -1 : 1\);/.test(JS) &&
  /document\.body\.setAttribute\('data-lang', S\.lang \|\| 'zh'\);/.test(JS) &&   // 英文小字号钩子
  /fwdLegend: 'Attacker indicators \(not clickable\): purple = black, light blue = white/.test(JS) &&
  /\[data-lang="en"\] \.fwdkey\{font-size:\.78rem/.test(CSS));
// ★★ 2026-09-22（用户要求）：VCF/VCT 算杀器 —— 前瞻先算杀（威胁空间搜索 + 迭代加深 +
//   Web Worker 并行：VCF 全树 1 工人 + VCT 根候选模分片 n-1 工人），命中按必胜序列推演；
//   防守应手必须「排序后截断」（反四优先 + 贴子优先），防稻草人化假必胜；窗口两端钳界。
ok('★ VCF/VCT 算杀器接入前瞻（2026-09-22 用户要求）：迭代加深 + Worker 并行 + 排序截断防假胜',
  /function vcxAnalyze\(b, x, y, c\) \{/.test(JS) &&
  /var xe = x0 \+ dx \* 4, ye = y0 \+ dy \* 4;/.test(JS) &&                   // 窗口两端钳界
  /if \(x0 < 0 \|\| y0 < 0 \|\| xe < 0 \|\| ye < 0 \|\| x0 >= N \|\| y0 >= N \|\| xe >= N \|\| ye >= N\) continue;/.test(JS) &&
  /function vcxVcfLoop\(b, atk, dLeft, skip, mod\) \{/.test(JS) &&
  /function vcxVctLoop\(b, atk, dLeft, skip, mod\) \{/.test(JS) &&
  /function vcxDefReplies\(b, px, py, atk\) \{/.test(JS) &&
  /list\.sort\(function \(a, c\) \{ return \(a\.w - c\.w\) \|\| \(a\.d - c\.d\); \}\);/.test(JS) &&  // 反四优先+贴子优先再截断
  /function vcxSolveAsync\(b, rule, mode\) \{/.test(JS) &&
  /new Blob\(\[src\], \{ type: 'application\/javascript' \}\)/.test(JS) &&      // Worker blob 注入
  /async function fwdTryVcx\(b, kind, budgetMs\) \{/.test(JS) &&               // ★ 十轮：一次算杀探测（喂副本）
  /await vcxSolveAsync\(bb, engineRule\(\), k, G\.fwd\.atk, budgetMs\)/.test(JS) &&  // 前瞻先算杀
  /fwdVcf: 'VCF 算杀成功：\{n\} 手连续冲四必胜/.test(JS) &&
  /fwdVct: 'VCT 算杀成功/.test(JS));
// ★★ 2026-09-22 三轮（用户要求）：「查找VCF / 查找VCT」小键 = 只算杀不逐手推演；
//   前瞻键开启变**浅紫**（关闭恢复天蓝）
ok('★ 三轮前瞻：查找VCF/查找VCT 小键（专用模式、未找到有明确提示）+ 前瞻键 on 浅紫',
  /id="btn_fwd_vcf"/.test(HTML) && /id="btn_fwd_vct"/.test(HTML) &&
  /function fwdFind\(kind\)/.test(JS) &&
  /G\.fwd\.wantVcx = true;/.test(JS) &&                                      // ★ 十轮：进入算杀模式
  /G\.fwd\.want2 = \(kind === 'VCF'\) \? 'VCT' : 'VCF';/.test(JS) &&          // 首选 + 兜底规则
  /await fwdRun\(\);/.test(JS) &&                                             // ★ 十轮：走同一条推演线
  /fwdFindVcf: 'VCF'/.test(JS) && /fwdFindVcf: 'VCF'/.test(JS) &&
  /fwdVcfNone: /.test(JS) && /fwdVctNone: /.test(JS) &&
  /els\.btn_fwd_vcf\.onclick = function \(\) \{ fwdFind\('VCF'\); \};/.test(JS) &&
  /\.fwdmini\{font-size:\.78rem/.test(CSS) &&
  /\.fwdkey\.on\{background:#a78bdb/.test(CSS));
// ★ 四轮（用户要求）：「查找VCF / 查找VCT」点击后变**粉紫色**（查找中/命中点亮，
//   普通前瞻/关前瞻/未命中熄灭）
ok('★ 四轮前瞻：查找VCF/VCT 点击后粉紫（fwdFindUi 点灭管理）',
  /function fwdFindUi\(\) \{/.test(JS) &&
  /els\.btn_fwd_vcf\.classList\.toggle\('find-on', k === 'VCF'\)/.test(JS) &&
  /els\.btn_fwd_vct\.classList\.toggle\('find-on', k === 'VCT'\)/.test(JS) &&
  /fwdFindUi\(\);\s*\n\s*fwdOkUI\(\);/.test(JS) &&                          // fwdRun 里：先认 kind 再定格确定键
  /fwdFindUi\(\); renderFwdSeq\(\); paint\(\);/.test(JS) &&                    // 命中/并线后一次收敛
  /fwdFindUi\(\);\s*\/\/ ★ 四轮：关前瞻 → 查找键粉紫一并熄灭/.test(JS) &&
  /\.fwdkey\.find-on\{background:#e07fdf/.test(CSS) &&
  /\.fwdkey\.find-on:hover\{background:#d874d8\}/.test(CSS));
// ★ 五轮（用户要求 2026-09-22）：前瞻框两行重排（VCF/VCT 去掉「查找」+ < > 挪第一行；
//   图例色点改色框框文字、与确定键放第二行）+ 算杀有解棋盘画**蓝色虚线**杀路（★十三轮蓝/蓝绿系）+
//   ★★ VCF 逼堵子必须真落临时盘（漏放 = 末端黑白叠同格 + 假必胜，压测抓到的真凶）
ok('★ 五轮前瞻：两行布局（VCF/VCT 短名 + < > 上移；色框图例 + 确定键第二行）+ 虚线杀路 + VCF 堵子落盘修复',
  HTML.indexOf('id="btn_fwd_prev"') > HTML.indexOf('id="btn_fwd_vct"') &&    // < > 在第一行（VCT 之后）
  HTML.indexOf('id="btn_fwd_ok"') > HTML.indexOf('class="fwd-h fwd-h2"') &&  // 确定键在第二行
  /fwd-h2\{margin-top:-\.1rem\}/.test(CSS) &&
  /\.fwd-lg \.lgfr-b\{border:1\.5px solid #7a5cc7/.test(CSS) &&              // 黑子紫框
  /\.fwd-lg \.lgfr-w\{border:1\.5px solid #7fb6dd/.test(CSS) &&              // 白子浅蓝框
  !/class="lg lg-b"/.test(HTML) &&                                           // 旧色点图例删除
  /fwdVcfNone: '当前局面，\{c\}（所选进攻方）不存在VCF强制连续冲四杀棋'/.test(JS) &&         // ★十八轮：点名进攻方颜色
  /fwdFiveNoVcx: '已五子连珠（共 \{n\} 手）—— 全程未出现\{c\}的 VCF \/ VCT 进攻可能/.test(JS) &&
  /if \(G\.fwd\.kind && G\.fwd\.vcxAt >= 0\) \{/.test(JS) &&                 // ★ 十轮：算杀段才画虚线
  /var dFrom = Math\.max\(G\.fwd\.committed \+ 1, G\.fwd\.vcxAt\);/.test(JS) && // ★ 十轮：从算杀段第一手起串
  /ctx\.setLineDash\(\[Math\.max\(3, gap \* 0\.16\), Math\.max\(2\.5, gap \* 0\.12\)\]\);/.test(JS) &&
  /rgba\(96,146,248,\.85\)/.test(JS) &&                                     // ★ 十三轮：蓝色虚线杀路（蓝/蓝绿系）
  /var sub = vcxVcfLoop\(b, atk, dLeft - 1, 0, 1\);/.test(JS) &&
  /b\[qy\]\[qx\] = def;/.test(JS) && /b\[qy\]\[qx\] = 0;/.test(JS));          // ★ 堵子真落盘 + 回退
// ★★ 2026-09-22 七轮（用户要求）：VCF/VCT 有禁手 + 进攻方点选 + 序号标注/清除 + 无解弹窗 + 100+ 手
ok('★ 七轮算杀：连珠禁手（三三/四四/长连）+ 黑框白框选进攻方 + 清除杀棋标记 + 无解弹窗 + 深度 100+',
  /var VCX_FORBID = false;/.test(JS) &&                                      // 禁手闸全局
  /function vcxForbidden\(b, x, y\) \{/.test(JS) &&                          // 禁手判定（进 Worker）
  /function vcxOverlineAt\(b, q\) \{/.test(JS) &&
  // ★ 2026-09-25（对齐 Rapfi + 规则适配）：威胁点必须**带上落子锚点**判定
  //   （vcxAnalyze 给的点是「落完本手之后」才成立，不带锚点会把全部威胁误杀成 0）。
  /function vcxRealThreats\(b, arr, c, ax, ay\) \{/.test(JS) &&
  (JS.match(/var th = vcxRealThreats\(b, a\.threats, atk, x, y\);/g) || []).length >= 2 &&
  /function vcxFiveReal\(b, q, c\) \{/.test(JS) &&                            // 按规则判「真成五」
  /function vcxRunLenAt\(b, q, c\) \{/.test(JS) &&                            // 最长连子数（长连口径）
  /function vcxAudit\(b0, line, renju, ex1, ex2, atk\) \{/.test(JS) &&        // ★ 交付前逐手复演闸
  /if \(line && line\.length && vcxAudit\(b, line, renju, VCX_EXACT_1, VCX_EXACT_2, side\)\)/.test(JS) &&
  /if \(line2 && line2\.length && vcxAudit\(b, line2, renju, VCX_EXACT_1, VCX_EXACT_2, side\)\)/.test(JS) &&
  /if\(line&&line\.length&&!vcxAudit\(b0,line,!!d\.forbid,!!d\.ex1,!!d\.ex2,atk\)\)line=null;/.test(JS) &&
  // 候选点避禁手（VCF + VCT 共用串；★ 只对**黑方进攻**生效，白方在连珠下无禁手）
  /if \(VCX_FORBID && atk === 1 && vcxForbidden\(b, x, y\)\) continue;/.test(JS) &&
  (JS.match(/if \(VCX_FORBID && atk === 1 && vcxForbidden\(b, x, y\)\) continue;/g) || []).length >= 2 &&
  // ★ 防守应手也要避禁手（黑方堵点本身是禁手 → 换另一成五点 / 保守判失败）
  /if \(VCX_FORBID && def === 1 && vcxForbidden\(b, qx, qy\)\)/.test(JS) &&
  /if \(VCX_FORBID && def === 1 && vcxForbidden\(b, nx, ny\)\) continue;/.test(JS) &&
  /var forbid = VCX_FORBID && c === 1;/.test(JS) &&                          // 威胁过滤里的同口径
  /var th = vcxRealThreats\(b, a\.threats, atk, x, y\);/.test(JS) &&          // 长连假成五点过滤
  /var renju = \(rule === 2\);/.test(JS) &&                                   // 连珠黑方才开闸
  /VCX_FORBID = \(renju && side === 1\);/.test(JS) &&
  !/rule === 2 && side === 1\) \{ resolve\(null\); return; \}/.test(JS) &&   // 不再短路放弃（VCF/VCT 没反应的真凶）
  /VCX_FORBID=!!d\.forbid;/.test(JS) && /forbid: rj,/.test(JS) &&            // Worker 随消息下闸
  /vcxOverlineAt, vcxRealThreats,/.test(JS) && /vcxForbidden, vcxVcfTry,/.test(JS) &&  // 注入 Worker
  /vcxRunLenAt, vcxFiveReal, vcxAudit,/.test(JS) &&                          // ★ 廿四轮：复演闸也进 Worker
  /vcxDefReplies,\s*\n\s*exactFiveFor\]\.map/.test(JS) &&                     // 精确成五口径随 Worker 一起注入
  /var VCX_VCF_DEPTH = 64;/.test(JS) && /var VCX_VCT_DEPTH = 32;/.test(JS) && // ★ 100 手以上
  /var VCX_WORKER_DEEP = 30000;/.test(JS) &&
  /\? VCX_WORKER_TIMEOUT : VCX_WORKER_DEEP\);/.test(JS) &&                    // 显式档 30s
  /var tOutArg = arguments\.length > 4 \? arguments\[4\] : 0;/.test(JS) &&     // ★ 十轮：调用方覆盖超时
  /id="fwdLgB"/.test(HTML) && /id="fwdLgW"/.test(HTML) &&                    // 黑框/白框 = 进攻方指示框
  !/function fwdPickAtk\(/.test(JS) &&                                       // ★十八轮：不可点（选择函数已删）
  !/fwdLgB\.onclick/.test(JS) &&                                             // 不再挂 onclick
  /fwdAtkAuto: '进攻方：自动 —— 轮走方（算杀题面按惯例 = 子多的一方）/.test(JS) &&            // 自动判定口径
  /\.fwd-lg \.lgr\{cursor:default; user-select:none\}/.test(CSS) &&           // 鼠标不再是手型
  /atk: 0,   \/\/ ★ 七轮/.test(JS) &&
  /\.fwd-lg \.lgfr-b\.sel\{background:#7a5cc7/.test(CSS) &&
  /\.fwd-lg \.lgfr-w\.sel\{background:#7fb6dd/.test(CSS) &&
  /fwdVcfHit: '找到VCF杀，共\{n\}手；进攻方：\{c\}/.test(JS) &&               // 命中提示带进攻方
  /fwdVcfHit: 'VCF win found: \{n\} moves; attacker: \{c\}/.test(JS) &&
  /id="btn_fwd_clear"/.test(HTML) && /function fwdClearMarks\(\) \{/.test(JS) &&  // 清除杀棋标记
  /fwdClear: '清除标记'/.test(JS) && /fwdClear: 'Clear marks'/.test(JS) &&
  // ★ 2026-09-25（用户要求）：「清除标记」从「前瞻」框搬到「计算评估」卡、与「计算」并排
  //   （各占半宽 = anbtns 两列格的各一格），并泛化为 clearAllMarks()。
  /id="btn_an_stop" class="btn accent">计算<\/button>/.test(HTML) &&         // 计算收成半宽（不再 wide）
  !/id="btn_an_stop" class="btn accent wide"/.test(HTML) &&
  HTML.indexOf('id="btn_an_stop"') < HTML.indexOf('id="btn_fwd_clear"') &&   // 清除标记紧跟计算（右半格）
  HTML.indexOf('id="btn_fwd_clear"') < HTML.indexOf('id="fwdBox"') &&       // 已不在前瞻框里（在计算评估卡内）
  /function clearAllMarks\(\) \{/.test(JS) &&                                 // 泛化入口
  /fwdClearMarks\(\);[\s\S]{0,400}?anaReset\(\);/.test(JS) &&                 // 泛化 = 前瞻 + 计算评估一起清
  /markCleared: '已清除棋盘上的所有分析标记/.test(JS) &&
  /markCleared: 'Cleared every analysis mark/.test(JS) &&
  /id="vcxPop"/.test(HTML) && /function vcxPopShow\(text\) \{/.test(JS) &&   // 无解弹窗
  /els\.btn_fwd_clear\.onclick = function \(\) \{ clearAllMarks\(\); \};/.test(JS) &&
  /ctx\.globalAlpha = \(G\.fwd\.vcxAt >= 0 && fi >= G\.fwd\.vcxAt\) \? 0\.8 : 0\.52;/.test(JS) &&  // ★ 十轮：只有算杀段画实
  /if \(mk0\.t < 4\) continue;/.test(JS));                                    // ★ 十五轮：标识简化（活三/防守不画圈）
// ★★ 2026-09-22 七轮（用户要求）：识图编辑栏单行化 + 添加黑白子下拉 + 撤销/Ctrl+Z
ok('★ 七轮识图：添加黑白子浅蓝下拉（再点收起）+ 五键一行 + 撤销键与 Ctrl+Z',
  /<button id="btn_ve_undo" class="btn">撤销<\/button>/.test(HTML) &&
  HTML.indexOf('id="btn_ve_add"') > HTML.indexOf('id="btn_ve_fillw"') &&     // 添加键与上面四键同行
  HTML.indexOf('id="veAddKeys"') > HTML.indexOf('id="btn_ve_add"') &&        // 小框在添加键右边弹出
  HTML.indexOf('id="btn_ve_undo"') > HTML.indexOf('id="veAddKeys"') &&
  /<span id="veAddKeys" class="ve-pop" hidden>/.test(HTML) &&
  /function visAddToggle\(\) \{/.test(JS) &&
  /VIS\.addOpen = !VIS\.addOpen;/.test(JS) &&
  /els\.btn_ve_add\.classList\.toggle\('add-on', VIS\.addOpen\);/.test(JS) &&
  /\.btn\.add-on\{background:#9fd2f2/.test(CSS) &&                           // 点亮 = 浅蓝色
  /#veAddKeys\[hidden\]\{display:none\}/.test(CSS) &&                        // 收起真隐藏
  /function visUndo\(\) \{/.test(JS) &&
  /function visSnapPush\(\) \{/.test(JS) &&
  (JS.match(/visSnapPush\(\);/g) || []).length >= 5 &&                       // 加/删/补/交换五个落定点
  /if \(VIS\.edit\) visEditHint\(T\('veUndoNone'\)\);/.test(JS) &&
  /els\.btn_ve_undo\.onclick = function \(\) \{ visUndo\(\); \};/.test(JS) &&
  /if \(!\(e\.ctrlKey \|\| e\.metaKey\) \|\| String\(e\.key\)\.toLowerCase\(\) !== 'z'\) return;/.test(JS) &&  // Ctrl+Z
  /if \(!VIS\.edit\) VIS\.undoStack = \[\];/.test(JS) &&                     // 退出修改清空撤销栈
  /veUndo: '撤销', veUndoNone: '没有可撤销的操作/.test(JS) &&
  /veUndo: 'Undo', veUndoNone: 'Nothing to undo'/.test(JS));
// ★★ 2026-09-22 八轮（用户要求）：黑白数异常拦截 + 两个抽屉方向键选择
ok('★ 八轮识图：黑白异常禁保存/加载并提示 + 历史/图片抽屉方向键选择与回车打开',
  /function visGate\(\) \{/.test(JS) &&
  /var bad = \(c\.w > c\.b\) \|\| \(c\.b - c\.w > 1\);/.test(JS) &&        // 白>黑 或 黑>白+1 = 异常
  /els\.btn_vis_save\.disabled = bad;/.test(JS) &&
  /els\.btn_vis_load\.disabled = bad;/.test(JS) &&
  (JS.match(/visGate\(\)/g) || []).length >= 5 &&                          // 定义+识别/同步/保存/加载把关
  /visCountBad: '★ 黑白数异常（黑 \{b\} \/ 白 \{w\}）/.test(JS) &&
  /visCountBad: 'Imbalanced stones \(black \{b\} \/ white \{w\}\)/.test(JS) &&
  /function drKeyNav\(d\) \{/.test(JS) &&
  /function drKbEnter\(\) \{/.test(JS) &&
  /function visKeyNav\(d\) \{/.test(JS) &&
  /function visKbEnter\(\) \{/.test(JS) &&
  /if \(VIS\.kb >= 0 && VIS\.kb < VIS\.list\.length\) \{ VIS\.idx = VIS\.kb;/.test(JS) &&  // 回车=载入该图
  /if \(DR\.kb >= 0 && DR\.kb < listOfTab\(\)\.length\) openFromHistoryIndex\(DR\.kb\);/.test(JS) &&
  /var DR = \{ tab: 'hist', sel: \{\}, kb: -1 \};/.test(JS) &&
  /DR\.kb = -1;                          \/\/ ★ 八轮：重开抽屉清掉方向键高亮/.test(JS) &&
  /\.dr-list \.item\.kb\{outline:2px dashed/.test(CSS) &&
  /\.vd-item\.kb\{outline:2px dashed/.test(CSS) &&
  /if \(G\.fwd && G\.fwd\.on && G\.fwd\.line\.length\) return;/.test(JS)); // 前瞻 ←/→ 步进优先
// ★★ 2026-09-22 九轮（用户要求）：识图「VC 模式」+ 前瞻回退质量 + 关于「使用方法」
ok('★ 九轮/十二轮识图：VC 模式键在「加载到练习」与「修改」之间（第 4 键）+ 放行 + 不自动算杀',
  (() => { const i = HTML.indexOf('id="btn_vis_load"'), j = HTML.indexOf('id="btn_vis_vc"'), k = HTML.indexOf('id="btn_vis_edit"');
           return i >= 0 && i < j && j < k; })() &&
  /vc: false, gateBad: false \}/.test(JS) &&                                    // VIS 状态
  /function visVcToggle\(\) \{/.test(JS) &&
  /if \(els\.btn_vis_vc\) els\.btn_vis_vc\.onclick = visVcToggle;/.test(JS) &&
  /if \(VIS\.vc\) bad = false;/.test(JS) &&                                     // 闸门放行
  /VIS\.gateBad = bad;/.test(JS) &&
  /else if \(VIS\.vc && VIS\.gateBad\) visMsg\(T\('visVcPass'\)/.test(JS) &&    // 放行明示
  /vc: !!VIS\.vc \} \}\);/.test(JS) &&                                          // 宿主载荷带 vc
  /vc: !!VIS\.vc \}\)\);/.test(JS) &&                                           // 本地 pending 带 vc
  // ★★ 十二轮（用户要求「进入之后不要自动，让用户自己选择」）：加载后只「准备」不「开算」。
  /if \(o\.vc\) setTimeout\(visVcArm, 450\);/.test(JS) &&                       // 只调准备函数
  /function visVcArm\(\) \{/.test(JS) &&
  !/fwdAutoVcx/.test(JS) &&                                                     // 自动算杀已整段移除
  /G\.fwd\.atk = \(nb > nw\) \? 1 : \(nw > nb \? 2 : 0\);/.test(JS) &&          // 子多一方=进攻方（预设）
  /visVcArm: 'VC 模式已就绪/.test(JS) &&                                        // 提示用户自己点
  /return !!\(G\.fwd\.line && G\.fwd\.line\.length\);/.test(JS) &&              // fwdFind 返回命中
  /visVc: 'VC 模式', visVcTip:/.test(JS) &&
  /visVcPass: '★ VC 模式放行/.test(JS) &&
  /visVc: 'VC Mode', visVcTip:/.test(JS) &&
  /if \(els\.btn_vis_vc\) \{ els\.btn_vis_vc\.textContent = d\.visVc; els\.btn_vis_vc\.title = d\.visVcTip; \}/.test(JS) &&
  /\.vis-acts \.btn\{padding:\.42rem \.55rem; font-size:\.9rem; white-space:nowrap\}/.test(CSS) && // 五键一行收紧
  /flex:0 0 clamp\(22rem, 36vw, 37rem\); min-width:20rem/.test(CSS) &&          // 面板加宽
  /0\.5→0\.56 识别框加高/.test(JS));                                            // 识别框加高
ok('★ 九轮/十一轮前瞻：模拟线语义 + 手数上限（十一轮删掉「凭引擎判胜负提前收手」）',
  /fwdDone: '已模拟推演到五子连珠（共 \{n\} 手）——引擎模拟线，非算杀必胜/.test(JS) &&
  /fwdCap: '推演停在 \{n\} 手：引擎这一步没给出可下的点/.test(JS) &&
  /fwdFull: '棋盘已铺满（共 \{n\} 手）仍未连五 —— 和棋/.test(JS) &&
  /fwdFull: 'Board is full after \{n\} moves without a five - a draw/.test(JS) &&
  /var boardFull = \(G\.fwd\.line\.length >= maxSteps\);/.test(JS) &&
  /Math\.max\(300, S\.turnMs \|\| 2000\)/.test(JS) &&                          // ★廿八轮：每手预算 = 用户设置（默认 2s，09-27）
  /var maxSteps = N \* N - baseStones;/.test(JS) &&                            // ★ 十轮：上限=棋盘空位数
  /step < maxSteps; step\+\+\) \{   \/\/ ★ 十轮/.test(JS) &&                    // ★ 十轮：不设子数上限
  // ★★ 十一轮（用户要求「不可能一两手就定性，必须一直走到五子连珠」）：
  //   唯一终局判据 = 盘面真的连五 → 抽成 fwdReportFive()，落子后立刻判。
  /function fwdReportFive\(\) \{/.test(JS) &&
  // ★ 廿一轮：连五判据改为按当前规则（engineRule），不再硬编码自由局 rule 0
  /if \(findWinLine\(b, engineRule\(\)\)\) \{ fwdReportFive\(\); return; \}/.test(JS) &&
  !/fwdSimEval/.test(JS) &&                                                    // 「胜势已定」文案已删
  !/var proven =/.test(JS) && !/evTxt/.test(JS) &&                             // eval 提前收手整段已删
  !/胜负已明会提前收手/.test(JS) && !/stops early once the outcome is proven/.test(JS)); // 手册同步
ok('★ 九轮关于：中英双语保姆级「使用方法」',
  /aboutGuide: '使用方法',/.test(JS) && /aboutGuideList: \[/.test(JS) &&
  /aboutGuide: 'How to Use',/.test(JS) &&
  // ★ 十六轮：插入「残局」一节后识图顺延为第六节
  /\{ t: '六、识图（Gomoku Vision）', ps: \[/.test(JS) &&
  /\{ t: '6\. Vision \(Gomoku Vision\)', ps: \[/.test(JS) &&
  /VC 模式」= 算杀题模式/.test(JS) &&
  /aboutGuide'\)\) \+ '<\/div>';/.test(JS) &&
  /class="ab-g-sec"><div class="ab-g-t">/.test(JS) &&
  /class="ab-g-p">/.test(JS) &&
  /\.ab-g-sec\{margin:\.6rem 0 \.1rem\}/.test(CSS) &&
  /\.ab-g-t\{font-weight:700; color:var\(--accent\)/.test(CSS) &&
  /\.ab-g-p\{margin:\.24rem 0 0; line-height:1\.62/.test(CSS));
// ★★ 2026-09-22 十轮（用户要求 2026-09-22）：前瞻 × VCF/VCT = **边走边算一条线** ——
//   选 VCF/VCT 就先分析突破口（首次可能慢），再逐手向前走、**每步回探**这套规则能不能接手；
//   能接手 → 杀棋序列并入同一条线（蓝色虚线杀路 + 按威胁分色的虚线环）一路走到五连；
//   走完全程没用上该规则却已连五 → 状态行明说「已五子连珠，本次未用到 VCF / VCT」。
ok('★ 十轮前瞻：VCF/VCT = 边走边算（开局分析 → 每步回探 → 接手走到底 / 没用上就明说 + 威胁虚线环）',
  /wantVcx: false, want: '', want2: '', vcxAt: -1, vcxMarks: \[\] \}/.test(JS) &&          // 状态字段
  /var VCX_STEP_TIMEOUT = 2500;/.test(JS) &&                                   // ★廿八轮：途中回探预算 1500→2500
  /function fwdVcxMarks\(b, line, startIdx\) \{/.test(JS) &&                   // 威胁标记计算
  /function fwdAdoptVcx\(b, vcx, from\) \{/.test(JS) &&                        // 算杀段并线
  /var atkFix = G\.fwd\.atk \|\| fwdSide\(\);/.test(JS) &&                     // ★ 进攻方一次推演内锁定
  /if \(!wantVcx \|\| fwdSide\(\) === atkFix\) \{/.test(JS) &&                 // 非进攻方回合先不查，先往前走
  // ★★ 廿三轮（对齐 Rapfi）：途中回探必须落在**进攻方行棋之前**（旧版在落子之后 → 攻方连走两手）
  /if \(wantVcx && step > 0 && cc === atkFix\) \{/.test(JS) &&
  /var rp = await fwdTryVcx\(b, wantA, VCX_STEP_TIMEOUT\);/.test(JS) &&
  /fwdAdoptVcx\(b, rp, from\);/.test(JS) &&
  /if \(wantVcx\) vcxPopShow\(T\(wantA === 'VCF' \? 'fwdVcfNone' : 'fwdVctNone'\)\n[\s\S]{0,80}?\.replace\('\{c\}', T\(atkFix === 1 \? 'fwdBlack' : 'fwdWhite'\)\)\);/.test(JS) &&  // 走满上限也明说（★十八轮带进攻方颜色）
  /fwdProbing: '正在分析突破口/.test(JS) &&                                     // 中英文案
  /fwdVcxLater: '前瞻推进 \{k\} 手后，进攻方出现 \{r\} 杀/.test(JS) &&
  /fwdFiveNoVcx: '已五子连珠（共 \{n\} 手）—— 全程未出现\{c\}的 VCF \/ VCT 进攻可能/.test(JS) &&
  /fwdProbing: 'Analysing the breakthrough/.test(JS) &&
  /fwdVcxLater: 'After \{k\} moves the attacker has a \{r\} win/.test(JS) &&
  /fwdFiveNoVcx: 'Reached five in a row in \{n\} moves - no VCF \/ VCT attacking chance for \{c\}/.test(JS) &&
  /if \(G\.fwd\.vcxAt >= 0 && G\.fwd\.vcxMarks\.length\) \{/.test(JS) &&       // 标记只在算杀段画
  /if \(mk0\.t >= 5\) \{/.test(JS) &&                                        // 连五/冲四分档（十五轮：活三分档已删）
  // ★ 十二轮（形状化 + 半透明）★ 十五轮（简化：防守手 t=0 不再画圈）
  !/if \(mk0\.t === 0\) \{/.test(JS) &&
  /ctx\.rect\(mpx - hw, mpy - hw, hw \* 2, hw \* 2\);/.test(JS) &&              // 冲四=虚线方框
  // ★ 十三轮（蓝/蓝绿系）+ ★ 十五轮（简化：只留连五双环 + 冲四方框，活三/防守圈删除）
  /rgba\(59,108,242,\.68\)/.test(JS) && /rgba\(88,164,246,\.60\)/.test(JS) &&
  !/rgba\(150,152,164,\.42\)/.test(JS) &&                                      // 防守手浅灰圈已删
  (JS.match(/G\.fwd\.wantVcx = false; G\.fwd\.want = ''; G\.fwd\.want2 = '';/g) || []).length >= 2);  // 关前瞻/普通前瞻都退出算杀模式
// ★★ 2026-09-22 十二轮：① 前瞻只认「盘面连五」；② VC 不自动算杀；③ 算杀器按标准口径校准。
ok('★ 十二轮算杀器：VCT 防守应手 = 完整最小集（不截断）+ 冲四候选不丢 + 被迫回防分支已回退',
  // 防守应手：必堵点（攻方落这成活四/成五）∪ 反四点（守方落这成四）—— 两类之外不必枚举
  /var mustBlock = aA\.win \|\| vcxRealThreats\(b, aA\.threats, atk, nx, ny\)\.length >= 2;/.test(JS) &&
  /counter = aD\.win \|\| vcxRealThreats\(b, aD\.threats, def, nx, ny\)\.length >= 1;/.test(JS) &&
  /if \(!mustBlock && !counter\) continue;/.test(JS) &&
  /return list;                                                              \/\/ ★ 不截断/.test(JS) &&
  !/VCX_VCT_DEF_MAX/.test(JS) &&                                               // 旧的截断常量已除
  // 冲四候选一个都不许丢，只对活三候选截断
  /return fours\.concat\(threes\.slice\(0, atkMax\)\);/.test(JS) &&
  // ★ 曾经想加的「被迫回防」分支（会产出颜色不交替的非法线）已整段回退，别再加回来
  !/function vcxForcedReply\(/.test(JS) &&
  /不要\*\*为此加专门的搜索分支/.test(JS) &&
  // Worker 注入列表必须覆盖 vcxDefReplies（漏注入 = 静默无解）
  /vcxVctCands, vcxVctTry, vcxVctLoop, vcxDefReplies,/.test(JS));
// ★★ 2026-09-22 十二轮（用户要求）：识图窗「裁剪」—— 屏幕截图右边那块空档放一个裁剪键，
//   点开浮层拖矩形框选，点「确定」把**当前这张图就地裁掉**（不新增条目）。
ok('★ 十二轮识图：裁剪键（屏幕截图右边）+ 拖框选浮层 + 确定就地替换当前图',
  HTML.indexOf('id="btn_vis_crop"') > HTML.indexOf('id="btn_vis_shot"') &&          // 排在屏幕截图右边
  HTML.indexOf('id="btn_vis_crop"') < HTML.indexOf('id="btn_vis_prev"') &&          // 且在翻页键之前
  /<button id="btn_vis_crop" class="btn">裁剪<\/button>/.test(HTML) &&
  /<div id="visCrop" class="crop-mask" hidden>/.test(HTML) &&
  /<canvas id="cropCanvas"><\/canvas>/.test(HTML) &&
  /<button id="btn_crop_ok" class="btn accent">确定<\/button>/.test(HTML) &&
  /body\.vis #visCrop:not\(\[hidden\]\)\{/.test(CSS) &&                              // 遮罩只在识图窗显示
  /#cropCanvas\{display:block; cursor:crosshair; touch-action:none\}/.test(CSS) &&
  /function cropOpen\(\) \{/.test(JS) && /function cropApply\(\) \{/.test(JS) &&
  /function cropDraw\(\) \{/.test(JS) && /function wireCrop\(\) \{/.test(JS) &&
  /function cropNorm\(a, b\) \{/.test(JS) &&                                        // 反向拖拽归一化
  /ctx\.fill\('evenodd'\);/.test(JS) &&                                             // 框外压暗（挖空选区）
  /cv\.getContext\('2d'\)\.drawImage\(im, sx, sy, sw, sh, 0, 0, sw, sh\);/.test(JS) &&  // 按原图像素裁
  /it\.d = url;/.test(JS) &&                                                        // ★ 就地替换这张
  !/visAddImage\(url/.test(JS) &&                                                   // 不是新增条目
  /visPersist\(\);\s*visRefreshView\(\);\s*cropClose\(\);/.test(JS) &&
  /els\.btn_vis_crop\.onclick = cropOpen;/.test(JS) && /wireCrop\(\);/.test(JS) &&
  /if \(CROP\.open && ev\.key === 'Escape'\)/.test(JS) &&                            // Esc 关闭
  /visCrop: '裁剪', visCropTitle: '裁剪图片'/.test(JS) &&
  /visCrop: 'Crop', visCropTitle: 'Crop image'/.test(JS) &&
  /visCropDone: '已裁剪（\{w\} × \{h\}）'/.test(JS));
// ★ 六轮补丁（用户叮嘱）：「显示序号」开关**只改序号显示**（真子换 showNum 样式、推演子
//   在小渐变序号与应有手数之间切换），与前瞻「确定」完全解耦 —— 不重推、不重置 committed/hold。
// ★★ 2026-09-21 六轮：右键菜单修复 + 预制色不跳自定义 + 后手重开 AI 自动开局
ok('★ 六轮杂修：抽屉外点收起豁免 #ctxMenu（右键菜单真凶）+ 预制色 keepTheme + 重新开始 maybeAi',
  /e\.target\.closest\('#ctxMenu'\)\) return;/.test(JS) &&                    // mousedown 豁免菜单
  /function cpCommit\(keepTheme\)/.test(JS) && /cpCommit\(true\)/.test(JS) && // 预制色不跳自定义
  /openStart\(\);\s*refreshUI\(\);[\s\S]{0,300}?maybeAi\(\);/.test(JS));       // 重开=AI 自动开局
// ★★ 2026-09-21（用户要求，练习器第二轮）
// ★ 2026-09-27（用户要求）：顶栏「卡片」键整颗取消 —— 显隐收进棋盘下「设置」弹窗：
//   三键（对局设置/计算评估/引擎仪表盘）+ 卡片右上角「固定 / ✕」小键。
// ★ 2026-09-28（用户要求）：①「设置」弹窗里**引擎仪表盘置首**；②**恢复「固定」两态** ——
//   未固定显示「固定」、点击转为固定并显示 ✕，再点 = 取消固定并关闭；③ 引擎仪表盘**默认固定**。
ok('★ 「卡片」键取消 → 棋盘下「设置」弹窗三键（引擎仪表盘置首）+ 卡片「固定/✕」小键',
  !/id="btn_cards"/.test(HTML) && !/id="cardMenu"/.test(HTML) && !/id="cardBar"/.test(HTML) &&
  /id="btn_set"/.test(HTML) && /id="setPop"/.test(HTML) &&
  /<button data-card="setup" class="btn">/.test(HTML) &&
  /<button data-card="analysis" class="btn">/.test(HTML) &&
  /<button data-card="engine" class="btn">/.test(HTML) &&
  /function toggleSetPop\(\)/.test(JS) &&
  /function toggleCardFromMenu\(id\)/.test(JS) &&
  /function pinKeySync\(pk, id\)/.test(JS) &&
  /var CARD_PIN = \{ engine: true \};/.test(JS) &&                   // ★ 引擎仪表盘默认固定
  /pk\.textContent = T\('pinFix'\);/.test(JS) &&                     // 未固定态显示「固定」
  /if \(v\[other\] && !CARD_PIN\[other\]\) v\[other\] = 0;/.test(JS) &&  // 固定卡不被互斥收起
  // ★ 2026-09-28（用户要求，**反转上一版**）：栏内次序 = **选择次序**（谁先选中谁在最上面）。
  //   旧版把新开的卡插到固定卡上面（bringAbovePinned）⇒ 每开关一张卡两卡上下就翻一次
  //   （实测 R 栏 setup>analysis / analysis>setup 来回跳）= 用户说的「逻辑混乱」。
  /function cardOrderBySelect\(id\)/.test(JS) &&
  !/bringAbovePinned\(id\);/.test(JS) &&                             // 旧函数调用必须已消失
  /card\.parentNode\.appendChild\(card\);/.test(JS) &&
  // ★ 关掉卡片 = 连固定一起撤；再显示时得重新点「固定」（否则再开又是 ✕）
  /if \(!opening\) delete CARD_PIN\[id\];/.test(JS) &&
  /function syncPinKeys\(\)/.test(JS) && /syncPinKeys\(\);/.test(JS) &&
  /class="pinkey"/.test(HTML));
ok('★ 调色：RGB 只留输入框（滑条已取消）+ 取色板按 dpr 出高保真 + 主题三档含「自定义」',
  /<div class="seg s3" id="cp_theme">/.test(HTML) && /data-th="custom"/.test(HTML) &&
  !/id="cp_r" type="range"/.test(HTML) && !/type="range"/.test(HTML) &&
  /\.cp-sliders\{display:grid; grid-template-columns:1\.15rem 5\.4rem/.test(CSS) &&
  // 高保真：后备缓冲按 dpr 放大 + setTransform(dpr) + 色相条逐设备像素铺 360 段
  /window\.devicePixelRatio \|\| 1/.test(JS) && /sc\.setTransform\(dpr/.test(JS) &&
  /var steps = Math\.max\(24, Math\.min\(360, Math\.round\(HW \* dpr\)\)\);/.test(JS) &&
  // 自定义：一动色就顶到 custom 档；宿主只收 light/dark（themeKey 归一化）
  /S\.customBase = \(S\.theme === 'dark'\) \? 'dark' : 'light'; S\.theme = 'custom'; cpSyncSegs\(\); \}/.test(JS) &&
  /function themeKey\(\)/.test(JS) && /theme: themeKey\(\)/.test(JS) &&
  // ★ 2026-09-20 三轮：点「深色/浅色」= 恢复默认；★ 五轮：清掉前先把手调色存进记忆槽
  //  （S.customColors，切回「自定义」原样还原 —— 自定义色不再因切主题失忆）；先算色再落盘
  /if \(S\.boardColor\) S\.customColors\.board = S\.boardColor;/.test(JS) &&
  /S\.boardColor = ''; S\.pageBgColor = '';/.test(JS) &&
  /if \(S\.customColors\.board \|\| S\.customColors\.page\) \{/.test(JS) &&
  /if \(th !== 'custom'\) cpFromColor\(cpCurrentHex\(\)\);/.test(JS) &&
  // ★ 2026-09-20 三轮：custom 记底子（深色壳下动色不再变回浅色）
  /if \(th !== 'custom'\) S\.customBase = th;/.test(JS) &&
  /\(S\.customBase === 'dark' \? 'dark' : 'light'\)/.test(JS) &&
  /S\.customBase = \(S\.theme === 'dark'\) \? 'dark' : 'light';/.test(JS) &&
  // ★ 2026-09-20 修复：拖动/输入过程中调色盘本身也要重画（原 cpLive 只刷字段不刷 canvas
  //   → 光标圈/游标纹丝不动 = 用户看到的「没有办法选中和移动」）
  /cpRender\(\);\s*\n\s*var hex = rgbToHex\.apply\(null, cpRGB\(\)\);/.test(JS));
ok('★ 预制选色只在「棋盘」时出现（选「背景」整行隐藏）',
  /id="cpPresetRow"/.test(HTML) &&
  /els\.cpPresetRow\.hidden = \(CP\.target === 'page'\)/.test(JS) &&
  /'cpPresetRow',/.test(JS) &&
  // ★ 2026-09-20 修复：.cp-row{display:flex}（作者样式）压过 UA 的 [hidden]{display:none}
  //   → 「背景」时预制色整行藏不掉。必须显式补这条。
  /\.cp-row\[hidden\]\{display:none!important\}/.test(CSS));
ok('★ 多点分析条目：第一行徽标+坐标+分数，第二行最佳线且可换行（不再 nowrap 截断）',
  /\.anlist \.it\{[\s\S]{0,220}?display:grid/.test(CSS) &&
  /\.anlist \.it \.pv\{[\s\S]{0,160}?grid-row:2; grid-column:1 \/ -1;/.test(CSS) &&
  /white-space:normal; word-break:break-all/.test(CSS) &&
  !/\.anlist \.it\{[\s\S]{0,200}?white-space:nowrap/.test(CSS) &&
  // ★ 2026-09-20（用户反馈，照 Yixin 截图）：名次徽标是**方形**底，不是圆胶囊
  /\.anlist \.it \.rk\{[\s\S]{0,120}?border-radius:2px/.test(CSS) &&
  /padding:0 \.16rem; min-width:1\.05rem; box-sizing:border-box;/.test(CSS));
ok('★ 棋盘标注防重叠：分数标签在「下/上/右/左」里挑第一个不撞的位落',
  /var taken = \[\];/.test(JS) && /function hits\(a, b\)/.test(JS) &&
  /taken\.push\(\{ x1: px - pw \/ 2 - 1/.test(JS) &&   // ★ 三轮：登记矩形按胶囊尺寸（单字徽标 pw=ph=mr*2，足迹与旧圆一致）
  /var cands = \[[\s\S]{0,320}?\/\/ 左/.test(JS) &&
  /if \(!clash\) \{ pick = c; taken\.push\(box\); \}/.test(JS));

// 2026-09-18 六轮：整页不滚动 / 板块不向下延伸
ok('整页永不滚动：stage 收敛在视口内，窄窗口也不堆叠（只收窄停靠栏）',
  /#stage\{[\s\S]{0,160}?overflow:hidden/.test(CSS) &&
  /#boardCol\{[\s\S]{0,160}?overflow:hidden/.test(CSS) &&
  /@media \(max-width:1100px\)/.test(CSS) && /@media \(max-width:860px\)/.test(CSS) &&
  !/#stage\{flex-direction:column\}/.test(CSS) &&
  /body\{[\s\S]{0,200}?overflow:hidden/.test(CSS));
// 2026-09-18 补丁：终局锁 —— 五连（含无禁手长连）后封盘，不再允许继续落子
ok('终局锁：连五后 G.over 封盘（点棋盘无效、AI 辅助拒绝、悔棋/重开解锁）',
  /over: false,\s*\/\/ 终局锁/.test(JS) &&
  /G\.over = true;/.test(JS) &&
  /if \(G\.over\) return;\s*\/\/ 终局锁：对局结束后棋盘只读/.test(JS) &&
  /G\.busy \|\| G\.review \|\| G\.over \|\| openActive\(\)/.test(JS) &&
  /G\.over = false;\s*\/\/ 悔棋回到终局前/.test(JS));
// ★ 2026-09-19（用户要求）：复盘**整体搬出主窗口** —— 主窗口里那份「暂存/恢复」
//   （G.rvBackup）连同它的接线一并消失；复盘窗口自己从空盘起步（见 bootReview / reviewLoad）。
ok('复盘不再动主窗口局面：G.rvBackup 已彻底删除',
  !/rvBackup/.test(JS) &&
  // 复盘窗口一律从空盘起步：记录只进 G.loaded 当「背诵/回顾」的数据源
  /G\.board = newBoard\(\); G\.moves = \[\]; G\.heat = \[\]; G\.nums = \[\]; G\.curve = \[\];/.test(JS));
ok('复盘窗口不设「关闭」键（★十八轮：右上系统关窗按钮即关闭，这颗是冗余）',
  !/id="btn_rv_close"/.test(HTML) &&                                        // HTML 里已删
  !/btn_rv_close/.test(JS));                                                // JS 里（grab/文案/接线）一并清干净
// 2026-09-18 新增：仪表盘可搬运 / 可停靠左右（尺寸不再可拖，见上面那两条）
ok('仪表盘卡片可拖动停靠 + 可在左/右停靠栏之间搬',
  /id="dockL"/.test(HTML) && /id="dockR"/.test(HTML) &&
  /function onCardDown\(/.test(JS) && /function persistLayout\(\)/.test(JS));
// 2026-09-18 新增：历史改成按键 + 长条抽屉 + 保存历史
// ★ 2026-09-20 三轮（用户要求）：「历史之前是抽屉的形式，但是现在，变成弹窗了，恢复之前的」
//   ⇒ 抽屉恢复**通到底**的右侧全高侧栏（top:0;bottom:0;border-left），不再是无根浮卡。
ok('历史是一个按键，点开是竖向长抽屉（全高通底 + 含「保存历史」页）',
  /btn_history/.test(HTML) && /id="drawer"/.test(HTML) && /data-tab="saved"/.test(HTML) &&
  /#drawer\{position:fixed; right:0; top:0; bottom:0;/.test(CSS) &&
  /border-left:1px solid var\(--border\)/.test(CSS) &&
  !/right:\.6rem; top:3\.9rem/.test(CSS));
ok('保存历史是独立永久空间（gbcalc.saved.v1）', /gbcalc\.saved\.v1/.test(JS));
// ★ 2026-09-19 二轮（用户要求）：功能键 2 行 × 3 列 —— 第一行 打开/保存选中/删除，
//   第二行 导入/导出/关闭：导入和导出同在第二行，删除、关闭都落在最右一列。
ok('★ 历史抽屉功能键 2 行 3 列（导入/导出一行，删除/关闭都在最右列）',
  /grid-template-columns:1fr 1fr 1fr/.test(CSS) &&
  HTML.indexOf('id="dr_open"') < HTML.indexOf('id="dr_save"') &&
  HTML.indexOf('id="dr_save"') < HTML.indexOf('id="dr_del"') &&
  HTML.indexOf('id="dr_del"') < HTML.indexOf('id="dr_imp"') &&
  HTML.indexOf('id="dr_imp"') < HTML.indexOf('id="dr_exp"') &&
  HTML.indexOf('id="dr_exp"') < HTML.indexOf('id="dr_close"'));
ok('★ 「保存选中」在保存历史页用 ghost-slot 藏（visibility 占位，不许网格重排）',
  /dr_save\.classList\.toggle\('ghost-slot', DR\.tab !== 'hist'\)/.test(JS) &&
  /\.dr-actions \.btn\.ghost-slot\{visibility:hidden\}/.test(CSS));
ok('★ 点抽屉外部自动收起（document mousedown + drawer.contains 闸门）',
  /document\.addEventListener\('mousedown', function \(e\) \{[\s\S]{0,200}?els\.drawer\.hidden[\s\S]{0,200}?els\.drawer\.contains\(e\.target\)[\s\S]{0,200}?closeDrawer\(\);/.test(JS));
// ★ 2026-09-19（用户要求）：「可以让用户自己更改某条历史的名字」。名字是历史记录上的一个可选
//   `name` 字段：列表里显示在 #N 之后；改名走行内输入框（右键菜单那一条）；空名字 = 删掉字段。
ok('★ 历史条目可改名（name 字段 + 行内输入框；空名字不占位）',
  /function renameRecord\(idx, val\) \{/.test(JS) &&
  /if \(nm\) list\[idx\]\.name = nm; else delete list\[idx\]\.name;/.test(JS) &&
  /function beginRename\(idx\) \{/.test(JS) &&
  /inp\.onkeydown = function \(e\) \{/.test(JS) && /settle\(true\)/.test(JS) && /settle\(false\)/.test(JS) &&
  /nm\.className = 'nm'; nm\.textContent = h\.name \|\| '';/.test(JS) &&
  /d\.setAttribute\('data-idx', String\(idx\)\);/.test(JS) &&
  // 没名字时 :empty 收掉那一段（不然每条都挂一个「未命名」，纯噪声）
  /\.dr-list \.item \.nm:empty\{display:none\}/.test(CSS) &&
  /namePh: '给这局起个名字'/.test(JS));
// ★ 2026-09-19（用户要求）：「用户选择了某个历史，右击了鼠标，可以有一个选择栏，
//   里面有删除、重命名等一些功能」。宿主已经把 WebView2 的默认右键菜单关掉了
//   （put_AreDefaultContextMenusEnabled(FALSE)），所以这个菜单必须**自己画**。
ok('★ 历史条目右键出选择栏（自绘菜单：打开复盘 / 重命名 / 导出这一局 / 存入保存历史 / 删除）',
  /<div id="ctxMenu" class="ctx" hidden><\/div>/.test(HTML) &&
  /\.ctx\{\s*\n\s*position:fixed/.test(CSS) && /\.ctx\[hidden\]\{display:none\}/.test(CSS) &&
  /function showCtx\(ev, idx\) \{/.test(JS) && /function closeCtx\(\) \{/.test(JS) &&
  /d\.oncontextmenu = function \(e\) \{/.test(JS) &&
  /\[T\('ctxOpen'\), false, function \(\) \{ openFromHistoryIndex\(idx\); \}\]/.test(JS) &&
  /\[T\('ctxRename'\), false, function \(\) \{ beginRename\(idx\); \}\]/.test(JS) &&
  /\[T\('ctxExport'\), false, function \(\) \{ exportRecords\(\[listOfTab\(\)\[idx\]\], exportNameOf\(idx\)\); \}\]/.test(JS) &&
  /if \(DR\.tab === 'hist'\) items\.push\(\[T\('ctxToSaved'\), false, function \(\) \{ moveToSaved\(\[idx\]\); \}\]\);/.test(JS) &&
  /items\.push\(\[T\('ctxDel'\), true, function \(\) \{ deleteIndexes\(\[idx\]\); \}\]\);/.test(JS) &&
  // 宿主侧：默认右键菜单确实是关掉的（这条注释与实现都不能少）
  /put_AreDefaultContextMenusEnabled\(FALSE\)/.test(HOST) &&
  // 菜单要能在鼠标处弹、越界回收，并且点别处/滚动/Esc 会收起来
  /m\.style\.left = Math\.max\(6, Math\.min\(ev\.clientX, window\.innerWidth - w - 6\)\)/.test(JS) &&
  /els\.drList\.addEventListener\('scroll', closeCtx\);/.test(JS) &&
  /if \(e\.key === 'Escape'\) closeCtx\(\);/.test(JS));
// ★ 2026-09-19（用户要求）：「历史记录中的历史可以导出导入通过 txt 中的代码」。
//    txt 格式：`#` 注释行 + 一行一局「<名字>\t<局面代码>」（代码与 gomocalc.com 同格式）。
//    导出走宿主「另存为」（同「保存局面」），导入走宿主「打开」读回来 → 页面解析入库。
ok('★ 历史可以导出成 txt（每行一局「名字 + 局面代码」；宿主弹「另存为」）',
  /var HIST_TXT_HEAD =/.test(JS) &&
  /function histTxtOf\(list\) \{/.test(JS) &&
  /function movesToCode\(mv\) \{/.test(JS) && /function buildCode\(\) \{\s*\n\s*return movesToCode\(G\.moves\);/.test(JS) &&
  // 名字与代码之间用 **TAB** 分隔（名字里出现字母+数字也不会被当成着法）
  /return nm \+ '\\t' \+ movesToCode\(h && h\.moves\);/.test(JS) &&
  /function exportRecords\(list, fname\) \{/.test(JS) &&
  /tellHost\(\{ type: 'saveTxt', name: name, data: txt, n: list\.length \}\);/.test(JS) &&
  /function exportSelected\(\) \{/.test(JS) &&
  /id="dr_exp"/.test(HTML) && /id="dr_imp"/.test(HTML));
ok('★ 历史可以从 txt 导入（解析 → 追加进历史 → 按 150 上限裁掉最旧的）',
  /function parseHistTxt\(text\) \{/.test(JS) &&
  /if \(!line \|\| \/\^\\s\*#\/\.test\(line\)\) continue;/.test(JS) &&
  /var tab = line\.indexOf\('\\t'\);/.test(JS) &&
  /var mv = parseCode\(code\);/.test(JS) &&
  /function importHist\(text\) \{/.test(JS) &&
  /var list = loadHist\(\)\.concat\(recs\);/.test(JS) &&
  /while \(list\.length > HIST_MAX\) list\.shift\(\);/.test(JS) &&
  /tellHost\(\{ type: 'openTxt' \}\);/.test(JS) &&
  // 浏览器里没有宿主时退回 <input type=file>（readAsText('utf-8')）
  /els\.file_imp\.onchange = function \(\) \{/.test(JS) && /readAsText\(f, 'utf-8'\)/.test(JS) &&
  /id="file_imp"/.test(HTML));
ok('★ 历史 txt 的宿主侧：另存为写 UTF-8(带 BOM)，打开对话框读回来推给页面',
  /static TxtSaveResult SaveTxtFromPage\(const std::string& s, HWND owner\)/.test(HOST) &&
  /static std::string ReadTxtMessage\(HWND owner\)/.test(HOST) &&
  /static std::wstring PickOpenTxtPath\(HWND owner\)/.test(HOST) &&
  /GetOpenFileNameW\(&ofn\)/.test(HOST) &&
  // 存 PNG 与存 txt 共用同一支「另存为」（PickSavePath 只是 PNG 那套参数的包装）
  /static std::wstring PickSavePathAs\(const std::wstring& suggested, HWND owner,/.test(HOST) &&
  /return PickSavePathAs\(suggested, owner,\s*\n\s*L"PNG 图片 \(\*\.png\)/.test(HOST) &&
  // 中文记事本靠 BOM 认 UTF-8，不然打开是一片乱码
  /const unsigned char bom\[3\] = \{ 0xEF, 0xBB, 0xBF \};/.test(HOST) &&
  /LogMsg\("\[hist\] txt written: "/.test(HOST) &&
  // 两个窗口（主窗 + 复盘窗）都要认 saveTxt / openTxt
  (HOST.match(/s\.find\("\\"saveTxt\\""\)/g) || []).length >= 2 &&
  (HOST.match(/s\.find\("\\"openTxt\\""\)/g) || []).length >= 2 &&
  // 回执：写盘成功后告诉页面「导出了几局」；导入后页面回报「入库了几局」
  /\\"type\\":\\"histExported\\",\\"n\\":/.test(HOST) &&
  /LogMsg\("\[hist\] imported n=" \+ std::to_string\(JsonIntAfter\(s, "\\"n\\":"\)\)/.test(HOST));
// ★ 抽屉接线只有一处（wireDrawer）：主窗口与复盘窗共用，差别只有「打开一局往哪儿去」。
ok('★ 历史抽屉接线只写一处（wireDrawer），两个窗口共用',
  /function wireDrawer\(\) \{/.test(JS) &&
  /els\.dr_exp\.onclick = exportSelected;/.test(JS) &&
  /els\.dr_imp\.onclick = pickImport;/.test(JS) &&
  /wireDrawer\(\);/.test(JS.slice(JS.indexOf('function boot()'))) &&
  /wireDrawer\(\);\s*\/\/ 抽屉接线与主窗口共用/.test(JS));
// 2026-09-18 三轮迭代：滑块取消，只留数字输入框
// ★ 2026-09-19（用户要求）：单位由**毫秒改成秒**，0.2 ~ 300 秒，最多三位小数；框长减半。
ok('思考时间只留数字输入框（滑块已取消），单位 = 秒（0.2 ~ 300 / 最多三位小数）', !/id="rng_turn"/.test(HTML) &&
  /id="num_turn" type="number" min="0\.2" max="300" step="0\.1" value="2"/.test(HTML) &&   // ★09-27：默认 2 秒
  /<span class="unit">s<\/span>/.test(HTML) &&
  !/<span class="unit">ms<\/span>/.test(HTML) &&
  /els\.num_turn\.onchange/.test(JS));
ok('思考时间：输入框里是「秒」，内部仍存毫秒（S.turnMs 唯一事实来源），范围 200 ~ 300000',
  // 秒 → 毫秒的换算与钳位都在 setTurn 里，两处常数一个都不能少
  /var secs = Math\.round\(\(\+v \|\| 2\) \* 1000\) \/ 1000;/.test(JS) &&   // ★09-27：默认 2 秒
  /secs = Math\.max\(0\.2, Math\.min\(300, secs\)\);/.test(JS) &&
  /S\.turnMs = Math\.round\(secs \* 1000\);/.test(JS) &&
  /function turnSecs\(\) \{ return \+\(S\.turnMs \/ 1000\)\.toFixed\(3\); \}/.test(JS) &&
  /els\.num_turn\.value = turnSecs\(\);/.test(JS) &&
  /turnMs: 2000,/.test(JS));   // ★09-27：默认思考时间 2 秒
// 2026-09-18 四轮：难度取消 / 思考时间同一行 / 持久化 / 历史自动保存 / 载入局面重判终局
ok('难度三键已取消（有思考时间就够了），思考时间与数字框同一行',
  !/seg_level/.test(HTML) && !/seg_level/.test(JS) && !/LV_MS/.test(JS) &&
  /id="turnRow"/.test(HTML) &&
  // ★ 不给 #turnRow 单独设 gap —— 沿用 .row 的 .5rem，才可能跟「人机」那一行严丝合缝
  !/#turnRow\{gap:/.test(CSS));
// ★ 2026-09-19（用户要求）：「思考时间这个数字输入框应该与人机，还有黑和先手这个功能键对齐」。
//   对齐 = 左边缘与右边缘都跟分段键一致。当年对不齐是两处叠加：
//     ① `#turnRow>label{flex:0 0 auto}` 把标签压成内容宽 → 整条左移；
//     ② `#num_turn{width:5.6rem}` 窄框 → 右边缘差一大块。
//   做法：「输入框 + 单位」包成 .field（flex:1，与 .seg 同位同宽），单位变成框内后缀。
//   ★ 又一轮（用户要求）：「框长变为原来的一半」→ 又多一层 .numbox（占 .field 的 50%）：
//     列（.field）仍与 .seg 同位同宽 → 左右两条边照旧对齐；框本身只吃半列。
//   几何判据在 B 段（列真量左右两条边、框真量≈半列宽），这里先钉住实现手段。
ok('★ 思考时间输入框左右边缘与「人机 / 黑（先手）」键对齐（同标签列 + 同 flex 列宽）',
  // 标签列必须与其它 .row 同宽（老版本在这里把它压成 flex:0 0 auto 才会错位）
  !/#turnRow>label\{flex:0 0 auto\}/.test(CSS) &&
  /\.card \.row>label\{flex:0 0 5\.4rem/.test(CSS) &&
  // 输入框 + 单位包成 .field（flex:1，与 .seg 同位同宽），框本体再包一层 .numbox（半列）
  /<span class="field">\s*<span class="numbox">\s*<input id="num_turn"/.test(HTML) &&
  /#turnRow \.field\{position:relative; flex:1 1 auto; display:flex; min-width:0\}/.test(CSS) &&
  // ★ 半列：只能在 50% 上（改了这条 B 段的「≈半列宽」会跟着红）
  /#turnRow \.numbox\{position:relative; flex:0 0 50%; max-width:50%; display:flex; min-width:0\}/.test(CSS) &&
  /#num_turn\{[\s\S]{0,80}?flex:1 1 auto; width:100%; min-width:3rem;/.test(CSS) &&
  // 单位是**框内后缀**（绝对定位，挂在 .numbox 上），不再从输入框右侧挤走一块宽度
  /#turnRow \.unit\{position:absolute; right:\.5rem; top:50%; transform:translateY\(-50%\)/.test(CSS) &&
  // 字号 / 内边距与 .seg button 齐平 → 高度也齐
  /font-size:\.88rem; padding:\.34rem 1\.5rem \.34rem \.45rem/.test(CSS) &&
  /\.seg\{flex:1 1 auto/.test(CSS) &&
  /\.seg button\{[\s\S]{0,80}?padding:\.34rem \.3rem; font-size:\.88rem/.test(CSS));
// 2026-09-18 八轮：「哈希表」下拉被截成「256 M」、且并排一行时被顶到第二行还拉满整行宽
// → 改成各占一行、标签靠左（与「模式/规则」同一列），下拉只按内容宽（"稍微大一点"就够）
ok('核心数 / 哈希表各占一行、标签靠左对齐，下拉按内容宽不强撑整行',
  /<div class="row"><label id="t_cores">核心数<\/label>/.test(HTML) &&
  /<div class="row"><label id="t_hash">哈希表<\/label>/.test(HTML) &&
  !/class="row pair"/.test(HTML) && !/\.row\.pair/.test(CSS) &&
  /#sel_cores,#sel_hash\{flex:0 0 auto; width:auto; min-width:4\.4rem/.test(CSS));
ok('局面持久化：落子后写 gbcalc.game.v1，启动时 restoreGame 摆回来',
  /localStorage\.setItem\('gbcalc\.game\.v1'/.test(JS) && /function restoreGame\(\)/.test(JS) &&
  /restoreGame\(\);/.test(JS));
ok('重新开始自动存历史（★十八轮：确定过的残局带 eg/egLen）',
  /var rec = \{ ts: Date\.now\(\), src: 'local', rule: S\.rule, side: S\.side,/.test(JS) &&
  /els\.btn_reset\.onclick = function \(\) \{[\s\S]{0,600}?addRecord\(rec\);/.test(JS) &&
  /rec\.eg = true; rec\.egLen = S\.egBase\.length;/.test(JS));
ok('载入的局面重新判定终局（历史局面已连五就不能再下）', /function recomputeOver\(\)/.test(JS) &&
  /recomputeOver\(\);\s*\/\/ 历史局面可能已经连五/.test(JS));
// ★ 2026-09-19（用户要求）：复盘窗口「不参与任何功能的连接」——
//   页面里就是一个 RV_MODE 总闸：AI 落子 / 热力 / 引擎重试 / 离线提示 / 开局引导
//   全部在入口处早退，那个窗口一个 :8964 请求都不会发。
ok('★ 复盘窗与引擎彻底解耦：RV_MODE 在各入口一律早退',
  /function aiDecorOn\(\) \{ return !RV_MODE && !G\.review; \}/.test(JS) &&
  /function ruleForRender\(\) \{ return RV_MODE \? 0 : \+S\.rule; \}/.test(JS) &&
  /if \(RV_MODE \|\| S\.mode !== 'pve' \|\| S\.paused \|\| G\.review \|\| G\.over\) return;/.test(JS) &&
  /if \(!G\.engineOffline \|\| RV_MODE \|\| G\.review\) return;/.test(JS) &&
  /if \(!openActive\(\) \|\| RV_MODE\) \{ els\.openBar\.hidden = true; return; \}/.test(JS) &&
  /if \(RV_MODE\) \{ refreshRvUI\(\); return; \}/.test(JS) &&
  /if \(!RV_MODE && !G\.review\) noteEngineDown\(\);/.test(JS) &&
  // 入口分流：?rv=1 走 bootReview（不读设置、不恢复局面、不建停靠栏）；?vis=1 走 bootVis
  /var GB_BOOT = VIS_MODE \? bootVis : \(RV_MODE \? bootReview : boot\);/.test(JS));
// ★ 2026-09-19（用户要求）：删掉主窗口那句「已在独立窗口打开复盘」——
//   复盘窗会自己弹出来，主窗口不需要再喊一句废话。i18n 里的键也要一并清掉，不留死文案。
ok('★ 状态栏不再喊「已在独立窗口打开复盘」（文案与调用点都删净）',
  !/已在独立窗口打开复盘/.test(JS) && !/Opened the review in its own window/.test(JS) &&
  !/rvOpening/.test(JS) && !/rvOpening/.test(HTML) && !/rvOpening/.test(CSS));
// ★ 2026-09-19（用户要求）：「不通过历史、在主界面上打开复盘」→ 复盘窗里只有
//   「重来 / 保存局面 / 关闭」；「打开复盘窗口后再（在历史里）选一局」→ 背诵/回顾那一组
//   重新出现。实现就是 record 上的 hist 标志：只有 hist=true 才露 rvGroup。
ok('★ 复盘窗按键按来源分流：只有「从历史打开」才露「背诵 / 回顾」那一组',
  // record 带上 hist；没显式给就看记录自带（TEST_RV_RECORD 那种固定样本）
  /function recordForReview\(h, hist\) \{[\s\S]{0,220}?var fromHist = \(hist === undefined\) \? !!\(h && h\.hist\) : !!hist;/.test(JS) &&
  /hist: fromHist,/.test(JS) &&
  // 复盘窗：hist 决定 rvGroup 显不显、G.loaded 留不留
  /var fromHist = !!\(rec && rec\.hist\) && mv\.length > 0;/.test(JS) &&
  /G\.loaded = fromHist \? \{ moves: mv, src: \(rec && rec\.src\) \|\| 'local' \} : null;/.test(JS) &&
  /if \(els\.rvGroup\) els\.rvGroup\.hidden = !\(fromHist \|\| egFirst \|\| egLen > 0\);/.test(JS) &&   // ★ 十五轮
  // 顶栏「复盘」= hist:false（纯棋盘）；历史条目 / 抽屉「打开」/ 右键「打开复盘」= hist:true
  // ★ 2026-09-19：三条入口统一收进 openFromHistoryIndex（复盘窗里那条就地载入，不再绕宿主）
  /function openReviewFromBoard\(\) \{[\s\S]{0,220}?\}, false\);/.test(JS) &&
  /function openFromHistoryIndex\(idx\) \{[\s\S]{0,400}?openReviewWindow\(h, true\);/.test(JS) &&
  /if \(RV_MODE\) \{ reviewLoad\(recordForReview\(h, true\)\); closeDrawer\(\); return true; \}/.test(JS) &&
  /d\.onclick = function \(\) \{ openFromHistoryIndex\(idx\); \};/.test(JS) &&
  /openFromHistoryIndex\(idx\[0\]\);/.test(JS) &&
  // 三个常驻键（重来 / 保存局面 / 关闭）在 HTML 里必须落在 #rvGroup **之外**
  /<span id="rvGroup" hidden>[\s\S]*?<\/span>\s*<button id="btn_redo_rv"/.test(HTML) ||
  (/id="btn_redo_rv"/.test(HTML) && /id="btn_save_rv"/.test(HTML) &&
   !/id="btn_rv_close"/.test(HTML) &&                                       // ★十八轮：关闭键删除

   HTML.indexOf('id="rvGroup"') < HTML.indexOf('id="btn_redo_rv"')));
// 2026-09-18 新增：复杂交换规则（一手交换 / 山口 / 塔拉山口10）
ok('规则方案含复杂交换：一手交换 / 山口 / 塔拉山口10',
  /value="5"/.test(HTML) && /value="6"/.test(HTML) && /value="7"/.test(HTML) &&
  /function tarRegion\(/.test(JS) && /function symEquivInSet\(/.test(JS) && /function startTenCall\(/.test(JS));
ok('塔拉山口区域限制：黑1 天元 / 白2 3×3 / 黑3 5×5 / 白4 7×7 / 黑5 9×9',
  /function tarRegion\(n\) \{ return \[0, 1, 2, 3, 4\]\[n - 1\]; \}/.test(JS));
// ★ 2026-09-19（用户要求）：交换类规则交换完成后 → 棋盘下方小弹窗让**用户**选先手/后手；
//   AI 自动执另一色并立刻开始计算（chooseSwapSide → maybeAi）。AI 私自定色（aiDecideSwap/aiDecideColor）已废。
ok('★ 交换先后手小弹窗：DOM/样式/i18n 齐备，决策点全部改走 showSwapChoice',
  /id=\"swapPop\" class=\"swappop\"/.test(HTML) &&
  /id=\"btn_swap_first\"/.test(HTML) && /id=\"btn_swap_second\"/.test(HTML) &&
  /\.swappop\{/.test(CSS) && /\.swappop\[hidden\]\{display:none !important\}/.test(CSS) &&
  /swapTtl: '交换完成 · 请选择你的先后手'/.test(JS) &&
  /swapFirst: '先手 · 执黑', swapSecond: '后手 · 执白'/.test(JS) &&
  /'swapTtl','swapFirst','swapSecond'\]\.forEach/.test(JS));
ok('★ 交换决策点：showSwapChoice 弹窗定色（OPEN.choice 暂停流程），选完 maybeAi 接管',
  /function showSwapChoice\(\) \{/.test(JS) &&
  /function chooseSwapSide\(side, silent\) \{/.test(JS) &&
  /\{ showSwapChoice\(\); return true; \}/.test(JS) &&
  /OPEN\.choice = true;/.test(JS) &&
  /if \(els\.swapPop\) els\.swapPop\.hidden = true;/.test(JS) &&
  /els\.btn_swap_first\.onclick/.test(JS) && /els\.btn_swap_second\.onclick/.test(JS) &&
  /aiDecideSwap/.test(JS) === false && /aiDecideColor/.test(JS) === false);
// ★ 2026-09-19（用户要求）：弹窗在棋盘下方水平居中、**半透明**磨砂小卡、两按钮**同一颜色**；
//   顺手修掉「.swappop 规则被误并进 body.rv 选择器组」（主窗无样式 + 复盘窗顶栏漏显）的坏档。
ok('★ 交换弹窗样式：棋盘下方居中 + 半透明模糊 + 两键同色 + body.rv 隐藏规则已复原',
  /background:color-mix\(in srgb, var\(--card\) 86%, transparent\)/.test(CSS) &&
  /backdrop-filter:blur\(8px\)/.test(CSS) &&
  /margin:\.55rem auto 0/.test(CSS) &&
  /\.swappop \.sp-btns \.btn\{background:var\(--chip\)\}/.test(CSS) &&
  /body\.rv :is\(#hdr,#dockL,#dockR\)\{display:none\}/.test(CSS) &&
  !/body\.rv #dockR,body\.rv \/\*/.test(CSS) &&
  /id="btn_swap_first" class="btn"/.test(HTML) && !/btn_swap_first" class="btn accent"/.test(HTML));
ok('曲线容器是微圆角矩形', /#curveWrap\{[\s\S]{0,220}?border-radius:10px/.test(CSS));
// 2026-09-18 五轮：纵坐标固定左边，不随绘图区横向滚动而滑走（用户要求）
ok('评估曲线纵轴固定不滚动（轴是独立画布，只有绘图区滚动）',
  /<canvas id="curveAxis">/.test(HTML) && /<div id="curveScroll">/.test(HTML) &&
  /var cv = els\.curve, scroll = els\.curveScroll, ax = els\.curveAxis;/.test(JS) &&
  /scroll\.scrollLeft = w;/.test(JS) && !/wrap\.scrollLeft/.test(JS) &&
  /#curveScroll\{[^}]*overflow-x:auto/.test(CSS));
// ★ 2026-09-20（用户要求）：「当前的深色还有浅色的棋盘，其他的颜色不太正规，默认用大多正规的
//   五子棋棋盘，类似与牛皮纸暗舒适护眼黄色」「深色、浅色都用一种棋盘颜色」+
//   「棋盘上的白色棋子要稍微的灰上一点点（有点像象牙棋子），要不然看起来有点刺眼」。
//   棋盘那一组变量**只在 :root 定义一次**（[data-theme="dark"] 里不再重复）→
//   深浅两套主题共用同一块牛皮纸护眼黄、同一副象牙白棋子。
ok('★ 棋盘色深浅共用一块护眼牛皮纸黄（dark 块里不再重复定义棋盘变量）',
  /--board:#d9b878; --line:#8a6f42; --star:#4a3a1e; --axis:#7a6338;/.test(CSS) &&
  /--blk:#1b1916; --blk-edge:#f2eee7; --wht:#eeeadf; --wht-edge:#c3bda9;/.test(CSS) &&
  // ★ 用「抓 [data-theme="dark"]{…} 这一条规则体」的写法，而不是 split 到第一个 }。
  //   老写法会被 :root 注释里出现的 `[data-theme="dark"]` 字样截歪（注释里提到它 → split
  //   把 :root 自己的棋盘变量当成 dark 块的 → 假红）。规则体里没有嵌套大括号，[^}]* 够用。
  !/--(board|line|star|axis|blk|blk-edge|wht|wht-edge|winline):/.test(
    (/\[data-theme="dark"\]\{([^}]*)\}/.exec(CSS) || [])[1] || ''));
ok('★ 白子改成偏灰的象牙白（不再是刺眼的纯白）',
  /--wht:#eeeadf/.test(CSS) && !/--wht:#ffffff/.test(CSS) && !/--wht:#f4f1ec/.test(CSS));
ok('浅色外壳：底色沿用参考站 #f6f6f4、强调键走 蓝/天蓝 系（用户要求）',
  /--bg:#f6f6f4/.test(CSS) && /--accent:#2f86d6/.test(CSS) && /--board:#d9b878/.test(CSS));
ok('深色外壳：背景深灰 + 彩色按键改深蓝系 + 亮色正文（用户要求）',
  /--bg:#26272a/.test(CSS) && /--accent:#2e6da4/.test(CSS) && /--ink:#e7e9ec/.test(CSS));
ok('字号随窗口缩放（棋盘与文字一起变大变小）',
  /document\.documentElement\.style\.fontSize/.test(JS) && /fitFont\(\)/.test(JS));
ok('背诵复盘：背错按手数记下错点并画粉红圈、计数',
  /G\.review\.missAt\[k\] = \{ x: x, y: y \}/.test(JS) &&
  /G\.missRings\.push\(G\.review\.missAt\[key\]\)/.test(JS) &&
  /G\.review\.miss = n;/.test(JS) && /--miss:#ff5f9e/.test(CSS));
ok('★ 复盘窗棋盘下方只有一行复盘键（背诵 / 回顾 … 都在 #rvBar 里）',
  /id="btn_recite"/.test(HTML) && /id="btn_replay"/.test(HTML) &&
  /body\.rv #rvBar:not\(\[hidden\]\)\{[\s\S]{0,200}?justify-content:center/.test(CSS) &&
  /#rvGroup\{display:inline-flex/.test(CSS) && /#rvGroup\[hidden\]\{display:none\}/.test(CSS));
// ★ 2026-09-19（用户要求）：「五子连珠后，或者说无禁手连珠后，用**天蓝色**的标线标记这个连珠」。
//   ★ 2026-09-20：棋盘色深浅统一 ⇒ 连珠线也跟着**只留一档**（在 :root，dark 块不再重复）；
//     色值同时从 #29a8e0 调成 #1e9bf0 —— 标线是 alpha .68 的半透明线，看到的是它与棋盘底的混色，
//     棋盘换成牛皮纸黄（G 通道高）后旧色混出来偏青（实测 rgb(98,173,190)，B 仅比 G 高 17，发闷）。
//   ★ 二轮精修：线长 = 首子圆心 → 末子圆心（不再两端外伸）；更浅、半透明（alpha 0.68）、
//   更细（线宽减半）；图层在「显示序号」的下面（winline 块在 showNum 块之前绘制）。
ok('★ 连珠用**天蓝色**标线标出（首末圆心连线、半透明更细、图层在序号下面）',
  /--winline:#1e9bf0;/.test(CSS) &&
  /function findWinLine\(b, rule\)/.test(JS) &&
  // 全盘扫（不是只看最后一手）：复盘窗里用户自己摆出的五连同样会标
  /var wl = findWinLine\(G\.board, ruleForRender\(\)\);/.test(JS) &&
  /ctx\.strokeStyle = css\('--winline'\);/.test(JS) &&
  /ctx\.lineCap = 'round';/.test(JS) &&
  /ctx\.globalAlpha = 0\.68;/.test(JS) &&
  /ctx\.lineWidth = Math\.max\(2, gap \* 0\.07\);/.test(JS) &&
  // 线长 = 首子圆心 → 末子圆心（不许再有 ±0.9r 的外伸偏移）
  /ctx\.moveTo\(pad \+ w0\.x \* gap, pad \+ w0\.y \* gap\);/.test(JS) &&
  /ctx\.lineTo\(pad \+ w1\.x \* gap, pad \+ w1\.y \* gap\);/.test(JS) &&
  !/wl\.dir\[0\] \* r \* 0\.9/.test(JS) &&
  // 图层在序号下面：winline 绘制块在 showNum 绘制块之前
  JS.indexOf('var wl = findWinLine') < JS.indexOf('if (numShown() && G.moves.length)') &&
  // 复盘窗口按无禁手：≥5 就是连珠（用户说的「无禁手连珠后也要标」）
  /return RV_MODE \? 0 : \+S\.rule;/.test(JS));
ok('规则覆盖四种（0/1/2/5）', /value="0"/.test(HTML) && /value="5"/.test(HTML));
ok('热力图走独立 sub 通道（与主分析并行，不抢算力）',
  // ★ 三十三轮：指导视图改走多引擎票箱 —— sub 仍是退回单发时的固定车道；
  // ★ 2026-09-27（用户意见③）：analyzeVote 增加尾参 tag（引擎仪表盘「计算中 · 教练」）。
  /analyzeVote\(ms, 8, curColor\(\), null, 'sub', T\('tagCoach'\)\)/.test(JS));
// ★ 2026-09-19（用户要求）：三件套版与独立版**共用同一份源码** —— AI 后端用 GB_AI_REMOTE
//   构建期开关分流：独立版（默认）= 页面内 Worker（LocalAI，无 :8964）；
//   三件套版（--suite 注入）= POST :8964 /api/analyze 共享引擎（原本的相互连接逻辑，
//   引擎由宿主 GB_SUITE_ENGINE 看门狗拉起/复用）。默认路径的返回形状两条完全一致。
ok('★ AI 后端开关（GB_AI_REMOTE）：独立版默认页面内 Worker；三件套版注入后走 :8964 共享引擎',
  /var AI_REMOTE = \(typeof GB_AI_REMOTE !== 'undefined'\) && !!GB_AI_REMOTE;/.test(JS) &&
  /var AI_REMOTE_URL = 'http:\/\/127\.0\.0\.1:8964\/api\/analyze';/.test(JS) &&
  /function remoteAnalyze\(body, ms\)/.test(JS) &&
  /boot: AI_REMOTE \? function \(\) \{\} : ensure,/.test(JS) &&
  /if \(AI_REMOTE\) return remoteAnalyze\(body, ms\);/.test(JS) &&
  /if \(AI_REMOTE\) return;/.test(JS));
// 2026-09-18 七轮：热力图「及时 + 分车道 + 数字=评估分 + 是 AI 那一方」
// ★ 2026-09-19 三轮（用户新语义）：热力图（AI 方面）**只在 AI 思考期间展示** ——
//   aiMove 开跑即铺（sub 车道与主搜并行），AI 一落子即清；玩家回合**不再铺**
//   （旧的「AI 落定后为玩家回合补铺」就是用户看到的「AI 下完子热力还在显示」—— 已删）；
//   refreshHeat 里旧的 G.busy 让路等待也一并拆掉（新语义下并行铺是故意的）。
{
  const aiSeg = JS.slice(JS.indexOf('async function aiMove()'), JS.indexOf('async function aiAssistOnce()'));
  ok('★ 热力图只在 AI 思考期间展示：aiMove 开跑即铺、落子即清，玩家回合不铺',
    /G\.busy = true;[\s\S]{0,400}?if \(S\.heat && !G\.over\) refreshHeat\(true\)\.then\(paint\);/.test(aiSeg) &&
    aiSeg.indexOf('refreshHeat(true).then(paint);') < aiSeg.indexOf('await analyze') &&
    // ★ 2026-09-24：aiTurn/aiColor 已被 isAiColor() 取代（AI 执黑/执白双开关 + AI 自打）。
    /if \(isAiColor\(curColor\(\)\)\) aiMove\(\);/.test(JS) &&
    /function chainAiIfNeeded\(\) \{/.test(JS) &&                             // AI 自打接力（下完一手再来一手）
    !/if \(!aiTurn\) refreshHeat\(\)\.then\(paint\);/.test(JS) &&
    !/while \(G\.busy && waited < 8000\)/.test(JS) &&
    /lane: lane \|\| 'main'/.test(JS) && /await analyzeVote\(ms, prof\.topN, aiColor, null, 'sub', T\('tagHeat'\)\)/.test(JS) &&
    /function heatBudget\(\)/.test(JS));
}
// ★ 2026-09-25（用户定档）改写：哈希默认 **固定 1024MB**（旧口径「物理内存 1/4 自动」作废——
//   32GB 机自动给 6GB 太激进）。存过档的用户仍用自己存过的值。
//   核心数默认仍是「全部可用核」（= threadsMax，已按机器规模留 1/2/4 个给系统）。
ok('★ AI 默认档位拉满：核心数默认 = 全部可用核（threadsMax）、哈希默认 = 固定 1024MB',
  /S\.cores = maxT \|\| host\.threadsDefault \|\| 1;/.test(JS) &&
  /S\.hashMB = 1024;   \/\/ 默认 1024MB/.test(JS));
ok('热力格内数字 = 评估分数（不再画名次）+ 档位按名次切 4 档',
  /ev: fmtEval\(c\.eval\)/.test(JS) && /function fmtEval\(ev\)/.test(JS) &&
  /tier: 1 \+ Math\.floor\(i \* 4 \/ cs\.length\)/.test(JS) &&
  /ctx\.fillText\(h\.ev, px, py\)/.test(JS) && !/fillText\(String\(n\.rank\)/.test(JS));
ok('热力恒为 AI 那一方：轮到 AI 直接取候选；轮到我方先虚拟一手再取 AI 应手',
  /curColor\(\) !== aiColor/.test(JS) && /virtual = \{ x: c1\[0\]\.x, y: c1\[0\]\.y \}/.test(JS) &&
  /function boardFp\(\)/.test(JS) && /gen !== G\.heatGen \|\| fp !== boardFp\(\)/.test(JS) &&
  // ★ 十轮：力图为空时的「不做」闸从 `!force && !aiTurn && G.heat.length` 改成
  //   显式的 want（热力开关 / 自由摆盘 / 复盘 / **复盘窗口** 四选一），语义更直白。
  // ★ 2026-09-19：终局（有人连五）之后一次热力评估都不再发
  // ★ 十五轮：want 闸加「残局」（与自由摆盘同待遇：AI 完全不参与）
  /var want = S\.heat && S\.mode !== 'place' && S\.mode !== 'endgame' && !G\.review && !RV_MODE && !G\.over;/.test(JS) &&
  /if \(!want\) \{ clearHeat\(\); return; \}/.test(JS));
// ★ 2026-09-19（用户要求）：「对局结束不可再次进行热力图评估展示」。
//   两道锁缺一不可：① 闸门带 !G.over（新的发不出来）② 判出终局即 clearHeat()（旧的立刻撤掉）。
ok('★ 对局结束后不再做热力图评估：闸门带 !G.over + 终局即清热力',
  /&& !RV_MODE && !G\.over;/.test(JS) &&
  /G\.over = true;[\s\S]{0,120}?clearHeat\(\);/.test(JS));
// ★ 2026-09-18 十轮（用户对标 https://www.gomocalc.com/#/ ）：
//   「用户下完子之后热力图和数值**瞬间**在棋盘上评估并**动态刷新**；
//     评估完整的最佳位置并 AI 下完之后热力图就**消失**。」
//   三段都必须落成源码契约 —— 否则哪天有人改回单发/不清热力，没有任何东西会红。
ok('★ 落子瞬间就出热力图：第一发只用极短预算（HEAT_FAST_MS=260），先把「有内容」铺上棋盘',
  /var HEAT_FAST_MS = 260;/.test(JS) &&
  /var got = await heatPass\(gen, fp, HEAT_FAST_MS, false\);/.test(JS) &&
  /if \(got\) paint\(\);/.test(JS));
ok('★ 随后按完整预算动态刷新覆盖（第二发允许补搜；两发都过「代数 + 局面指纹」双闸）',
  /async function heatPass\(gen, fp, ms, allowTopUp\)/.test(JS) &&
  /await heatPass\(gen, fp, heatBudget\(\), true\);/.test(JS) &&
  /if \(allowTopUp && prof\.colors > 2 && cs\.length < prof\.colors\)/.test(JS) &&
  /analyze\(Math\.min\(6000, heatBudget\(\) \+ 1500\), prof\.topN, 'sub', aiColor, T\('tagHeat'\)\)/.test(JS) &&
  /if \(gen !== G\.heatGen\) return;/.test(JS));
ok('★ AI 完整评估并落子后热力图消失：clearHeat() 清 heat/nums/think 并把代数 +1（作废在途）',
  /function clearHeat\(\) \{\s*\n\s*G\.heatGen\+\+;\s*\n\s*G\.heat = \[\];\s*\n\s*G\.nums = \[\];\s*\n\s*G\.think = \[\];/.test(JS) &&
  (JS.match(/clearHeat\(\);/g) || []).length >= 4);
{
  const aiSeg = JS.slice(JS.indexOf('async function aiMove()'), JS.indexOf('async function aiAssistOnce()'));
  const asSeg = JS.slice(JS.indexOf('async function aiAssistOnce()'));
  ok('★ 两处自动落子（aiMove / aiAssistOnce）都在落定后立刻 clearHeat()',
    // ★ 深夜：place 与 clearHeat 之间插入了粒子滤波种子块（PREHEAT.lastPv）→ 窗口放宽
    /place\(best\[0\], best\[1\]\);[\s\S]{0,700}?clearHeat\(\);/.test(aiSeg) &&
    /place\(best\[0\], best\[1\]\);[\s\S]{0,700}?clearHeat\(\);/.test(asSeg));
}
// 2026-09-18 八轮：热力图文案瘦身 —— 只留四色图例 + 一句短 hint
//（原来勾选行一句长 hint、图例里又两句「热力 = AI 的候选点 / 数字 = 评估分」，三句重复）
// ★ 2026-09-19（用户要求）：热力图（AI 方面）改圆形铺色 → hint 同步更新
ok('热力图去掉冗余文字说明：只留四色图例，hint 缩成一句（圆形铺色）',
  /<div class="row" id="heatLegend" hidden>\s*\n\s*<span class="lg">/.test(HTML) &&
  !/t_heatMeans/.test(HTML) && !/t_heatNum/.test(HTML) &&
  !/heatMeans/.test(JS) && !/heatNum/.test(JS) &&
  /heatHint: 'AI 思考时只标出它准备下的那一点，落子即消失'/.test(JS) &&
  /id="t_heatBest"/.test(HTML) && /id="t_heatGood"/.test(HTML) &&
  /id="t_heatFair"/.test(HTML) && /id="t_heatPoor"/.test(HTML));
// ★ 2026-09-19（用户要求）：「指导视图」—— 热力图之后加的开关。
//   循环语义：轮到用户 → 方形四色热力（全展示带数字，AI 帮用户算最佳落点）；
//   用户落子 → 立刻消失（afterMove clearCoach）；AI 落定 → aiMove 末尾再铺，依次循环；
//   五子连珠（G.over）→ 永久停发。热力图（AI 方面）= 圆形，色档随思考时间变（2/3/4 色），AI 落子后消失。
ok('★ 指导视图：方形四色热力（独立管线 coachPass/refreshCoach，轮到用户才算）',
  /id="chk_coach"/.test(HTML) && /id="t_coach"/.test(HTML) && /id="t_coachHint"/.test(HTML) &&
  /'t_coach','chk_coach','t_coachHint'/.test(JS) &&
  /coach: '指导视图', coachHint: /.test(JS) && /coach: 'Coach view', coachHint: /.test(JS) &&
  /function clearCoach\(\) \{/.test(JS) && /async function coachPass\(gen, fp, ms\) \{/.test(JS) &&
  /async function refreshCoach\(\) \{/.test(JS) &&
  // ★ 2026-09-24：myColor() 已被 isAiColor() 取代（AI 执黑/执白双开关 + AI 自打）。
  /if \(isAiColor\(curColor\(\)\)\) \{ clearCoach\(\); return; \}/.test(JS));
ok('★ 指导视图生命周期：用户落子即消失 / AI 落定后再铺（循环）/ 终局停发',
  /function afterMove\(\) \{\s*\n\s*clearCoach\(\);/.test(JS) &&
  /clearHeat\(\);\s*\n\s*clearCoach\(\);/.test(JS) &&
  /if \(S\.coach && !G\.over\) refreshCoach\(\)\.then\(paint\);/.test(JS) &&
  /els\.chk_coach\.onchange/.test(JS) && /els\.chk_coach\.checked = !!S\.coach;/.test(JS));
ok('★ AI 视图色档随思考时间自适应：<3s → 2 色 / ≤3 点，≤4.5s → 3 色 / ≤6 点，>4.5s → 4 色 / ≤8 点',
  /function heatProfile\(\) \{/.test(JS) &&
  /if \(t < 3000\) return \{ colors: 2, topN: 3 \};/.test(JS) &&
  /if \(t <= 4500\) return \{ colors: 3, topN: 6 \};/.test(JS) &&
  /return \{ colors: 4, topN: 8 \};/.test(JS) &&
  /async function heatPass\(gen, fp, ms, allowTopUp\) \{\s*\n\s*var prof = heatProfile\(\);/.test(JS) &&
  /await analyzeVote\(ms, prof\.topN, aiColor, null, 'sub', T\('tagHeat'\)\)/.test(JS) &&
  /var n = Math\.min\(cs\.length, prof\.topN\);/.test(JS) &&
  /var tier = \(n <= prof\.colors\) \? \(1 \+ i\)/.test(JS) &&
  /G\.heatColors = prof\.colors;/.test(JS) &&
  /G\.nums = cs\.slice\(0, prof\.topN\)\.map\(/.test(JS));
ok('★ AI 视图（圆形）调色板按档位取 HEAT_PAL（2/3/4 色）；指导视图固定 HEAT_PAL[2] 四色',
  /var HEAT_PAL = \[/.test(JS) &&
  /var HEAT4 = HEAT_PAL\[2\];/.test(JS) &&
  /var hpal = HEAT_PAL\[Math\.max\(0, Math\.min\(2, \(G\.heatColors \|\| 2\) - 2\)\)\];/.test(JS) &&
  /ctx\.fillStyle = hpal\[Math\.max\(0, Math\.min\(hpal\.length - 1, h\.tier - 1\)\)\];/.test(JS) &&
  /ctx\.arc\(pad \+ h\.x \* gap, pad \+ h\.y \* gap, gap \* 0\.42, 0, Math\.PI \* 2\);/.test(JS) &&
  /G\.coach\.forEach\(function \(h\) \{\s*\n\s*ctx\.fillStyle = HEAT4\[/.test(JS) &&
  /G\.coach\.forEach\(drawHeatNum\);/.test(JS) && /G\.heat\.forEach\(drawHeatNum\);/.test(JS) &&
  /\(S\.heat \|\| S\.coach\) && S\.mode !== 'place'/.test(JS));
ok('★ 图例档数跟随实际用色：data-colors=2/3/4（指导视图开着恒四色），CSS 裁掉多余条目',
  /var lgN = S\.coach \? 4 : \(G\.heat\.length \? \(G\.heatColors \|\| 2\) : 0\)/.test(JS) &&
  /els\.heatLegend\.setAttribute\('data-colors', String\(lgN\)\)/.test(JS) &&
  /#heatLegend\[data-colors="2"\] \.lg:nth-child\(n\+3\)\{display:none\}/.test(CSS) &&
  /#heatLegend\[data-colors="3"\] \.lg:nth-child\(n\+4\)\{display:none\}/.test(CSS));
ok('★ 鼠标悬浮格提示：浅灰蓝半透明圆角方框（坐标换算与点击同源；主窗 + 复盘窗都绑）',
  /hover: null,/.test(JS) &&
  /function hoverFromEvent\(ev\) \{/.test(JS) && /function bindBoardHover\(\) \{/.test(JS) &&
  /els\.board\.addEventListener\('mousemove', function \(ev\) \{/.test(JS) &&
  /els\.board\.addEventListener\('mouseleave', function \(\) \{/.test(JS) &&
  (JS.match(/bindBoardHover\(\);/g) || []).length >= 2 &&
  /'rgba\(150,168,196,\.20\)'/.test(JS) &&
  /'rgba\(150,168,196,\.66\)'/.test(JS) &&
  /var hPurple = !!\(VIS && VIS\.edit\);/.test(JS) &&                        // 识图修改模式 = 浅紫预览框
  // ★ 2026-09-25 二轮澄清：布局变换改在**数据层**（layoutApply），paint 恒按原始盘坐标画 ——
  //   命中就是简单「取最近交叉点」（cellAt 统一入口），四处都不得再自算 Math.round 换算。
  /function cellAt\(px, py\) \{/.test(JS) &&
  /var x = Math\.round\(\(px - g\.pad\) \/ g\.gap\), y = Math\.round\(\(py - g\.pad\) \/ g\.gap\);/.test(JS) &&
  /S\.view|viewApply|VIEW_ROT_CW/.test(JS) === false &&
  (JS.match(/Math\.round\(\(ev\.clientX - rect\.left - g\.pad\) \/ g\.gap\)/g) || []).length === 0 &&
  (JS.match(/cellAt\(ev\.clientX - rect\.left, ev\.clientY - rect\.top\)/g) || []).length >= 3 &&
  /function layoutApply\(map\) \{/.test(JS) &&
  /els\.btn_rot\.onclick = function \(\) \{ layoutApply\(ROT_CW\); \};/.test(JS) &&
  /els\.btn_mv_d1\.onclick = function \(\) \{ layoutApply\(DIAG_1\); \};/.test(JS) &&
  /els\.btn_mv_up\.onclick = function \(\) \{ layoutApply\(SHIFT_U\); \};/.test(JS));
// ★ 布局变换数值回归（二轮澄清）：五种对称映射的数学必须严格正确 ——
//   ROT_CW 顺时针 / FLIP_H 左右 / FLIP_V 上下 / DIAG_1 ╲ / DIAG_2 ╱，逐点抽查。
ok('★ 布局变换数值回归：ROT_CW / FLIP_H / FLIP_V / DIAG_1 / DIAG_2 逐点正确',
  (() => {
    try {
      const N = 15;
      const iR = JS.indexOf('var ROT_CW  = function (x, y) { return [N - 1 - y, x]; };');
      if (iR < 0) return false;
      const seg = JS.slice(iR, JS.indexOf('var SHIFT_U', iR) < 0 ? iR + 700 : JS.indexOf('var SHIFT_U', iR));
      const fns = new Function('N', seg + '; return { ROT_CW, FLIP_H, FLIP_V, DIAG_1, DIAG_2 };')(N);
      const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
      const pts = [[0, 0], [7, 7], [14, 0], [0, 14], [14, 14], [3, 11], [5, 9]];
      return pts.every(([x, y]) =>
        eq(fns.ROT_CW(x, y), [N - 1 - y, x]) &&    // (0,0)→(14,0)：顺时针，上边到右边
        eq(fns.FLIP_H(x, y), [N - 1 - x, y]) &&    // (0,y)→(14,y)：左右翻
        eq(fns.FLIP_V(x, y), [x, N - 1 - y]) &&    // (x,0)→(x,14)：上下翻
        eq(fns.DIAG_1(x, y), [y, x]) &&            // 主对角 ╲ 交换 xy
        eq(fns.DIAG_2(x, y), [N - 1 - y, N - 1 - x])); // 副对角 ╱
    } catch (e) { return false; }
  })());
// ★ 布局变换闸门：复盘窗（RV_MODE/G.review）与 AI 思考中（G.busy）必须拦下；
//   平移越界（shift 类 map 出盘）→ 整体不动 + 提示。先验后改在 layoutApply 里做。
//   ★ 2026-09-25（用户反馈「按键没效果」）：拦截提示升级为底栏上方浮出短提示（layoutTip）。
ok('★ 布局变换闸门与越界拦截：layoutAlive（RV/busy，layoutTip 浮出提示）+ layoutApply 先验后改',
  /function layoutAlive\(\) \{/.test(JS) &&
  /if \(RV_MODE \|\| G\.review\) \{ layoutTip\(T\('layoutRV'\)\); return false; \}/.test(JS) &&
  /if \(G\.busy\) \{ layoutTip\(T\('layoutBusy'\)\); return false; \}/.test(JS) &&
  /function layoutTip\(msg\) \{/.test(JS) &&
  /if \(q\[0\] < 0 \|\| q\[1\] < 0 \|\| q\[0\] >= N \|\| q\[1\] >= N\) \{ setStat\(null, T\('shiftOOB'\)\); return false; \}/.test(JS) &&
  /G\.board = newBoard\(\);/.test(JS) &&
  /if \(G\.fwd && G\.fwd\.on && !G\.fwd\.hold\) fwdQueue\(\);/.test(JS));
// ★ 2026-09-25（用户要求）：⇄ / ✥ 两个小弹窗互斥替换 —— 打开一个收起另一个，不并排显示
ok('★ 布局弹窗互斥：开 ⇄ 收 ✥、开 ✥ 收 ⇄（新弹窗替换旧弹窗）',
  /els\.btn_shift\.onclick = function \(e\) \{/.test(JS) &&
  /els\.mirrorPop\.hidden = true;/.test(JS) &&
  /els\.shiftPop\.hidden = true;/.test(JS));
// ★ 2026-09-25（用户要求）：主窗口 ← / → 方向键 = 上一步 / 下一步（输入框/抽屉/前瞻优先）
ok('★ 主界面键盘：← = 上一步、→ = 下一步（stepBack / stepForward）',
  /if \(!RV_MODE && !e\.ctrlKey && !e\.altKey && !e\.metaKey\) \{/.test(JS) &&
  /if \(e\.key === 'ArrowLeft'\) \{ stepBack\(\); e\.preventDefault\(\); \}/.test(JS) &&
  /else if \(e\.key === 'ArrowRight'\) \{ stepForward\(\); e\.preventDefault\(\); \}/.test(JS));
// ★ 2026-09-25（用户要求）：分组虚线框的浅蓝/浅紫背景涂色取消（.nav-group/.lay-group 规则删除）
ok('★ 底栏分组只留虚线框：浅蓝/浅紫涂色取消',
  !/\.nav-group\{background/.test(CSS) && !/\.lay-group\{background/.test(CSS) &&
  /\.bgroup\{/.test(CSS));
// ★ 2026-09-20（用户要求）：**点标题栏右上角那根小横杠 → 卡片折叠成一条长条圆角矩形**
//   （只剩标题行；再点一次展开）。折叠态写进布局（重开窗口仍是收着的）；
//   横杠自己不参与拖动 —— 单击只折叠，不会把卡片抓起来变成拖动。
ok('★ 卡片折叠：点右上角小横杠 → 收成长条圆角矩形（.card.collapsed，可再点展开）',
  /\.card\.collapsed\{/.test(CSS) && /\.card\.collapsed .card-b\{display:none\}/.test(CSS) &&
  // 半高胶囊圆角 = 「一条长条圆角矩形」，不是「变小了的卡片」
  /\.card\.collapsed\{[^}]*border-radius:999px/.test(CSS) &&
  /\.card\.collapsed \.card-h\{margin-bottom:0\}/.test(CSS) &&
  /function setCardFolded\(card, on, silent\) \{/.test(JS) &&
  /card\.classList\.toggle\('collapsed', !!on\)/.test(JS) &&
  /function toggleCardFold\(card\) \{/.test(JS) &&
  /if \(!silent\) layoutBoard\(\);/.test(JS) &&
  // 折叠态持久化：写进 l.collapsed，启动时按 id 还原
  /l\.collapsed\[c\.getAttribute\('data-id'\)\] = 1/.test(JS) &&
  /setCardFolded\(card, !!col\[card\.getAttribute\('data-id'\)\], true\)/.test(JS));
ok('★ 小横杠是折叠开关：可点（cursor:pointer + 扩大命中区），且不吃拖动（onCardDown 排除 .dash）',
  /\.card-h \.dash\{[^}]*cursor:pointer/.test(CSS) &&
  /\.card-h \.dash::after\{/.test(CSS) &&
  /e\.target\.closest\('button, input, select, a, \.dash'\)/.test(JS) &&
  /if \(dash\) dash\.addEventListener\('click'/.test(JS) &&
  // 三张卡的横杠都要能被翻译成同一条提示（2026-09-27 曲线并入仪表盘 → 4 → 3）
  (HTML.match(/class="dash" data-tip="dragCard"/g) || []).length === 3);
// ★ 2026-09-19（用户要求）：「AI视图（原热力图改名）/ 指导视图」收进**一个带边框的组框**，
//   框的主体是两个勾选键、四色图例放框的下部 —— 一眼看出它们同属「热力图」这一部分。
ok('★ AI视图 + 指导视图收进 .heatbox 组框：两键为主体、四色图例在框的下部',
  /class="heatbox"/.test(HTML) && /\.heatbox\{/.test(CSS) &&
  HTML.indexOf('class="heatbox"') < HTML.indexOf('id="chk_heat"') &&
  HTML.indexOf('id="chk_heat"') < HTML.indexOf('id="chk_coach"') &&
  HTML.indexOf('id="chk_coach"') < HTML.indexOf('id="heatLegend"') &&
  /heat: 'AI视图'/.test(JS) && /heat: 'AI view'/.test(JS));
// ★ 2026-09-19（用户要求）：「这个卡片有一个较为舒适的高度」。
//   原来是**量出来**的（= 左列卡高 − 仪表盘卡高 − 间距 − 卡内边距），左列卡一高曲线就被
//   拉到 ~490px、刻度间隔 60px 中间一大片空。现在锁死 **16rem** 这一档舒适高度
//   （按 root 字号跟随窗口缩放），不再追求两列等高 —— 用户连着两轮要的就是这一条。
ok('★ 评估曲线卡锁在 16rem 舒适高度（按 rem 跟随窗口缩放，不再跟左列等高）',
  /var rootFs = parseFloat\(getComputedStyle\(document\.documentElement\)\.fontSize\)/.test(JS) &&
  /var H = Math\.round\(16 \* rootFs\);/.test(JS) && !/var H = 150;/.test(JS) &&
  !/11\.5 \* rootFs/.test(JS) &&
  /#curveAxis\{display:block; flex:0 0 auto; height:16rem\}/.test(CSS) &&
  /#curve\{display:block; height:16rem\}/.test(CSS));
// ★ 2026-09-19：既然锁了舒适高度，那段「量左列卡高反推」的代码就必须**彻底消失** ——
//   留着会互相打架（量出来的值又会把 16rem 覆盖掉，高度还是跟着左列飘）。
ok('★ 曲线高度不再靠实测反推（那段「量左列卡高」的测量代码已删除）',
  !/var chromeH = cvCard\.offsetHeight - ax\.offsetHeight;/.test(JS) &&
  !/cvCard\.parentNode === enCard\.parentNode/.test(JS) &&
  !/if \(want > 60 && want < 900\) H = Math\.round\(want\);/.test(JS));

// ★ 2026-09-19（用户要求）：对局设置卡新增「显示序号」—— 棋子上标出它是第几手。
ok('★ 对局设置卡有「显示序号」功能键（勾选框 + 说明，与热力图同组同列）',
  /id="t_showNum"/.test(HTML) && /id="chk_num"/.test(HTML) && /id="t_showNumHint"/.test(HTML) &&
  /showNum: false,/.test(JS) && /'t_showNum','chk_num','t_showNumHint'/.test(JS) &&
  /els\.chk_num\.onchange = function \(\) \{ S\.showNum = !!els\.chk_num\.checked; save\(\); paint\(\); \};/.test(JS) &&
  /els\.chk_num\.checked = !!S\.showNum;/.test(JS));
// ★ 2026-09-25（用户要求）：复盘窗也要能显示序号 —— 但**用自己那颗「序号」键**（S.rvNum），
//   不与主窗口的 S.showNum 共用：主窗那颗若在复盘窗也生效，背诵复盘就等于把答案印在盘上。
//   于是判据抽成 numShown()：主窗读 showNum、复盘窗读 rvNum。
ok('★ 「显示序号」判据 = numShown()：主窗读 S.showNum、复盘窗读 S.rvNum（两个开关互不相干）',
  /function numShown\(\) \{ return RV_MODE \? !!S\.rvNum : !!S\.showNum; \}/.test(JS) &&
  /if \(numShown\(\) && G\.moves\.length\) \{/.test(JS) &&
  /if \(numShown\(\)\) \{/.test(JS) &&
  !/if \(S\.showNum && !RV_MODE/.test(JS) &&
  /ctx\.fillText\(String\(i \+ 1\), sx, sy\);/.test(JS) &&
  // 复盘窗「序号」键：rvBar 里那颗 + 持久化 + 中英文案
  /<button id="btn_rv_num" class="btn">序号<\/button>/.test(HTML) &&
  /rvNum: '序号', rvNumHint: '在棋子上标出它是第几手'/.test(JS) &&
  /rvNum: 'Numbers', rvNumHint: 'Mark each stone with its move number'/.test(JS) &&
  /els\.btn_rv_num\.onclick = function \(\) \{ S\.rvNum = !S\.rvNum; save\(\); syncRvNumBtn\(\); paint\(\); \};/.test(JS) &&
  /function syncRvNumBtn\(\) \{/.test(JS) &&
  /els\.btn_rv_num\.classList\.toggle\('on', !!S\.rvNum\);/.test(JS));

// ★ 2026-09-25（用户要求）：复盘键盘操控 **Ctrl+Z = 上一手 / Ctrl+R = 重来**。
//   三个要点：① 两种复盘（背诵/回顾）都认，不像方向键那样只在回顾里生效；
//            ② Ctrl+R 是浏览器「刷新」，必须 preventDefault，否则一按就把复盘窗刷回空盘；
//            ③ 所有跳步（◀▶ 键 / ←→ / Ctrl+Z / Ctrl+R）统一走 rvGoTo —— 改一处漏三处
//               就会出「按钮动了键盘没动」的半边失灵。
ok('★ 复盘 Ctrl+Z = 上一手 / Ctrl+R = 重来（统一走 rvGoTo，且拦下浏览器刷新）',
  /function rvGoTo\(k\) \{/.test(JS) &&
  /els\.btn_rv_prev\.onclick = function \(\) \{ rvGoTo\(G\.review \? G\.review\.k - 1 : 0\); \};/.test(JS) &&
  /els\.btn_rv_next\.onclick = function \(\) \{\s*rvGoTo\(G\.review \? G\.review\.k \+ 1 : 0\);/.test(JS) &&
  /if \(mod && kc === 'z'\) \{\s*rvGoTo\(G\.review\.k - 1\);/.test(JS) &&
  /\} else if \(mod && kc === 'r'\) \{\s*rvSetPlaying\(false\);[^\n]*\n\s*rvGoTo\(0\);/.test(JS) &&
  /var mod = e\.ctrlKey \|\| e\.metaKey;/.test(JS) &&
  /if \(handled\) e\.preventDefault\(\);/.test(JS) &&
  // 只在真的有复盘在跑时才拦键（没有 G.review 时 Ctrl+R 仍是正常刷新窗口）
  /window\.addEventListener\('keydown', function \(e\) \{\s*if \(!G\.review\) return;/.test(JS) &&
  /rvKeyHint: 'Ctrl\+Z 上一手 · Ctrl\+R 重来（回到开局）'/.test(JS));
ok('★ 「显示序号」有中英两套文案',
  /showNum: '显示序号', showNumHint: '棋子上标出第几手'/.test(JS) &&
  /showNum: 'Move numbers', showNumHint: 'Mark each stone with its move number'/.test(JS));
// ★ 2026-09-19（用户定稿）：启动遮罩 = 一行**软件英文名**（首字母大写 / 斜体 / 稍粗 / 灰蓝），
//   不写「加载中…」、不放动画。宿主 GDI 那一层（host.cpp PaintSplash）画的是同一行字。
ok('★ 启动遮罩：页面静态 #boot 里就一行软件英文名「Meter Gomoku Trainer」（Meter 天蓝）',
  /<div id="boot" class="boot"><span class="brand"><i>Meter<\/i> Gomoku Trainer<\/span><\/div>/.test(HTML) &&
  /\.boot\{[\s\S]{0,240}?background:var\(--bg\)/.test(CSS) && /\.boot\.off\{opacity:0\}/.test(CSS));
ok('★ 启动页那行字：斜体 + 稍粗 + 更大字号 + 灰蓝（--boot-fg 深浅两套）',
  /\.boot \.brand\{[\s\S]{0,200}?font-style:italic/.test(CSS) &&
  /\.boot \.brand\{[\s\S]{0,200}?font-weight:600/.test(CSS) &&
  /\.boot \.brand\{[\s\S]{0,200}?color:var\(--boot-fg\)/.test(CSS) &&
  /--boot-fg:#5b7a99/.test(CSS) && /\[data-theme="dark"\][\s\S]{0,200}?--boot-fg:#8ca6c0/.test(CSS));
ok('★ 字体走思源（可商用 SIL OFL），不再首选微软雅黑',
  /--font:[\s\S]{0,200}?"Source Han Sans SC"/.test(CSS) &&
  /--font:[\s\S]{0,300}?"Noto Sans SC"/.test(CSS) &&
  /font:400 var\(--fs\)\/1\.5 var\(--font\)/.test(CSS));
ok('★ 宿主 GDI 那一层画同一行字：思源优先 + 斜体 + Meter 天蓝分段（双色调居中）',
  /static const wchar_t\* kBrandName = L"Meter Gomoku Trainer";/.test(HOST) &&
  /static const wchar_t\* kBrandNameRv = L"Gomoku Review";/.test(HOST) &&
  /static COLORREF BrandFg\(\)/.test(HOST) && /static const wchar_t\* BrandFontFace\(\)/.test(HOST) &&
  /wcsncmp\(brand, kMeter, mlen\) == 0 && brand\[mlen\] == L' '/.test(HOST) &&
  /SetTextColor\(dc, RGB\(0x3d, 0x9b, 0xd6\)\);/.test(HOST) &&
  /PaintSplash\(h, g_rvPageReady, kBrandNameRv\)/.test(HOST));
// ★ 2026-09-19 架构定稿：UI + AI 资源统一由宿主内置本地 HTTP（:8965）供给，
//   有 .enc → 内存解密后出（发布版磁盘无明文）；无 .enc → 直接出明文（开发版）。
//   ⇒ 主窗/复盘窗天然同源同一份资源，本地 HTTP 上 COOP/COEP 齐全 → SAB/pthreads 可用。
ok('★ 复盘窗与主窗共用同一份 UI 供给（:8965 本地 HTTP，.enc 解密/明文自适应）',
  /static void HttpUiServer\(\)/.test(HOST) &&
  /std::thread\(HttpUiServer\)\.detach\(\)/.test(HOST) &&
  /gbCalcReadEncFile\(enc, body\)/.test(HOST) &&
  /Cross-Origin-Opener-Policy: same-origin/.test(HOST) &&
  /Cross-Origin-Embedder-Policy: require-corp/.test(HOST));
ok('★ 「关于」浮层：顶栏按键 + 骨架容器 + 关闭键都在 HTML 里',
  /<button id="btn_about" class="btn" data-tip="aboutTip">关于<\/button>/.test(HTML) &&
  /<div id="about" class="modal" hidden>/.test(HTML) &&
  /<div id="ab_body" class="modal-body"><\/div>/.test(HTML) &&
  /<button id="ab_close" class="btn">关闭<\/button>/.test(HTML));
ok('★ 「关于」正文由 renderAbout() 生成（切语言会重画），两个窗口都接线',
  /var APP_VERSION = '4\.33';/.test(JS) &&
  /function renderAbout\(\) \{/.test(JS) && /function openAbout\(\) \{/.test(JS) &&
  /function wireAbout\(\) \{/.test(JS) &&
  /wireAbout\(\);/.test(JS) && /renderAbout\(\); +\/\/ 正文是纯文案/.test(JS));
ok('★ 「关于」写明版本号 + 功能 + 开源组件各自的许可证（Rapfi 是 GPL-3.0，不能笼统写 MIT）',
  /aboutVer: '版本'/.test(JS) && /aboutOss: '开源组件'/.test(JS) &&
  // ★ 十六轮：组件说明改正（Rapfi 是编译进包的 WebAssembly 内核、OpenCV 静态链入、不再列 NumPy/Pillow）
  /\['Rapfi', '五子棋 \/ 连珠引擎内核（编译为 WebAssembly，随本软件分发）', 'GPL-3\.0'\]/.test(JS) &&
  /\['OpenCV', '棋盘与棋子识别（静态链入 GomokuVision\.exe，不额外分发 DLL）', 'Apache-2\.0'\]/.test(JS) &&
  /aboutLicText:[^\n]*MIT/.test(JS) && /aboutLicText:[^\n]*dhbloo\/rapfi/.test(JS));
ok('★ 遮罩由 bootDone() 淡出移除，主窗口与复盘窗都调它',
  /function bootDone\(\) \{/.test(JS) && /b\.classList\.add\('off'\);/.test(JS) &&
  // ★ 09-28（用户要求「页面初始化不能慢，界面直接到开局面」）：bootDone 提前到 openStart/openHint
  //   之前 —— 首帧即棋盘对局态；历史抽屉渲染让路下一拍（renderDrawer 走 setTimeout）。
  /bootDone\(\);\n  setTimeout\(function \(\) \{ renderDrawer\(\); \}, 0\);/.test(JS) &&
  /maybeAi\(\);\n\}/.test(JS) &&
  /reviewLoad\(JSON\.parse\(txt\)\); \} catch \(e\) \{\}[\s\S]{0,80}?bootDone\(\);/.test(JS));
ok('★ 宿主从第一帧就铺「加载中…」：GDI+ 自绘遮罩 + 主题底色持久化 + 页面报到才放 WebView2',
  /static void PaintSplash\(HWND h, bool pageShown, const wchar_t\* brand\)/.test(HOST) &&
  /static void RevealMainPage\(\)/.test(HOST) && /static void RevealRvPage\(\)/.test(HOST) &&
  /put_IsVisible\(FALSE\)/.test(HOST) && /SaveUiPrefs\(s\);/.test(HOST) &&
  /static void LoadUiPrefs\(\)/.test(HOST) && /kMainTimerReload/.test(HOST) &&
  // ★ 2026-09-19（用户定稿）：显示类定时器（遮罩兜底/动画心跳）必须**不存在** —— 纯事件驱动
  !/kMainTimerShow|kMainTimerSplash|kRvTimerShow|kRvTimerSplash/.test(HOST));
// ★ 2026-09-19（用户要求）：「英文模式要更全面一点」
ok('★ 规则下拉的 6 个选项走 i18n（不再是写死在 HTML 里的中文）',
  /ruleName: \{[\s\S]{0,260}?0: '无禁手'[\s\S]{0,260}?\}/.test(JS) &&
  /ruleName: \{[\s\S]{0,260}?0: 'Freestyle'[\s\S]{0,260}?\}/.test(JS) &&
  /els\.sel_rule\.querySelectorAll\('option'\)/.test(JS) &&
  /if \(rn\[o\.value\]\) o\.textContent = rn\[o\.value\];/.test(JS));
ok('★ 悬浮提示（拖动 / 局面代码）也走 i18n：HTML 打 data-tip，applyLang 统一翻译',
  /data-tip="dragCard"/.test(HTML) && /data-tip="codeTip"/.test(HTML) &&
  /document\.querySelectorAll\('\[data-tip\]'\)/.test(JS) &&
  // ★ 2026-09-20：这条提示现在同时讲两件事（拖动换位 + 点横杠折叠），中英都要带上后半句
  /dragCard: '按住标题栏可拖动换位；点击小横杠折叠/.test(JS) &&
  /dragCard: 'Drag the title bar to move it; click the bar to fold/.test(JS));
ok('★ 窗口标题 / 十打键 / 历史手数也跟着语言走',
  /docTitle: '五子棋练习器 · Gomoku Trainer'/.test(JS) && /docTitle: 'Gomoku Trainer'/.test(JS) &&
  /document\.title = T\('docTitle'\);/.test(JS) &&
  /ten: '十打（叫 10 个候选点）'/.test(JS) && /ten: 'Ten-call/.test(JS) &&
  /els\.btn_ten\.textContent = d\.ten;/.test(JS) &&
  /T\('nMoves'\)\.replace\('\{n\}', String\(mn\)\)/.test(JS));
ok('★ 导出的 txt 表头也分中英两套',
  /var HIST_TXT_HEAD = \{/.test(JS) && /zh: '# 五子棋练习器 · 历史导出 v1/.test(JS) &&
  /en: '# Gomoku Trainer · history export v1/.test(JS) &&
  /var head = HIST_TXT_HEAD\[S\.lang\] \|\| HIST_TXT_HEAD\.zh;/.test(JS));
// ★ 2026-09-19（用户要求）：「复盘这个独立窗口也应该适配深浅色主题」
ok('★ 主题切换同步到两个窗口（页面报 uiTheme → 宿主改标题栏 + 转发复盘窗）',
  // ★ 2026-09-20：这条报文顺带把自定义色的整套变量也发过去（复盘窗要换同一块棋盘）
  /tellHost\(\{ type: 'uiTheme', theme: themeKey\(\), bg: pageBgHex\(\), lang: S\.lang, cssVars: S\.cssVars \}\);/.test(JS) &&
  /function themeKey\(\) \{ return \(S\.theme === 'custom'\) \? \(S\.customBase === 'dark' \? 'dark' : 'light'\)/.test(JS) &&
  /s\.find\("uiTheme"\)/.test(HOST) && /ApplyDarkTitleBar\(g_rvHwnd, g_uiDark\);/.test(HOST) &&
  /PostToRvPageSoon\([\s\S]{0,140}?uiTheme/.test(HOST) &&
  /else if \(m\.type === 'uiTheme'\) \{/.test(JS));
ok('★ 首帧就按持久化的主题 / 语言渲染（内联脚本先写 data-theme 与 lang）',
  /gbcalc\.settings\.v1/.test(HTML) &&
  /document\.body\.setAttribute\('data-theme', th\);/.test(HTML) &&
  /document\.documentElement\.lang = lg;/.test(HTML));
ok('★ 两个窗口的 ready 都把主题 / 底色 / 语言报给宿主（下次启动的遮罩直接用它）',
  /postMessage\(\{ type: 'ready', theme: themeKey\(\), bg: pageBgHex\(\), lang: S\.lang \}\);/.test(JS));

// ---------------------------------------------------------- 识图窗口（2026-09-21，#65）
ok('★ 顶栏「识图」键在「复盘」左边；识图面板 + 图片抽屉 + 左下角水印 + 文件通道齐全（?vis=1 专属）',
  /<button id="btn_vis" class="btn">识图<\/button>\s*<button id="btn_review"/.test(HTML) &&
  /<aside id="visPane" hidden>/.test(HTML) &&
  /id="visView"/.test(HTML) &&
  /id="btn_vis_upload"/.test(HTML) && /id="btn_vis_shot"/.test(HTML) &&
  /id="btn_vis_rec"/.test(HTML) && /id="btn_vis_save"/.test(HTML) &&
  /id="btn_vis_load"/.test(HTML) && /id="btn_vis_del"/.test(HTML) &&
  /id="visMsg"/.test(HTML) &&
  // ★ 2026-09-21（用户要求）：胶囊数字键可点（弹左侧图片抽屉）+ 左下角水印
  /<button id="visPos" class="pill vis-pill">/.test(HTML) &&
  /<aside id="visDrawer" hidden>/.test(HTML) && /id="vdList"/.test(HTML) &&
  /id="visMark"/.test(HTML) && /<i>Meter<\/i><span>Gomoku Vision<\/span>/.test(HTML) &&
  /id="file_vis" type="file" accept="image\/\*" multiple hidden/.test(HTML));
ok('★ 图片抽屉（2026-09-21 用户要求）：胶囊点击开关 / 缩略图选中 / ✕ 按索引移除 / ESC 收起',
  /els\.visPos\.onclick = function \(\) \{/.test(JS) &&
  /els\.visDrawer\.hidden = !els\.visDrawer\.hidden;/.test(JS) &&
  /function visRenderDrawer\(\) \{/.test(JS) &&
  /function visRemoveAt\(i\) \{/.test(JS) &&
  /function visRemoveCurrent\(\) \{ visRemoveAt\(VIS\.idx\); \}/.test(JS) &&
  /del\.onclick = function \(ev\) \{ ev\.stopPropagation\(\); visRemoveAt\(i\); \};/.test(JS) &&
  /if \(els\.visDrawer && !els\.visDrawer\.hidden\) \{ els\.visDrawer\.hidden = true; \}/.test(JS));
ok('★ 水印样式（2026-09-21 用户要求）：左下角、最底层、半透明融入背景、斜体稍粗；Meter 天蓝 / 其余灰蓝',
  /body\.vis #visMark\{/.test(CSS) &&
  /pointer-events:none; user-select:none/.test(CSS) &&
  /z-index:0;/.test(CSS) &&
  /font-style:italic; font-weight:600/.test(CSS) &&
  /#5ebbee/.test(CSS) && /#8ea6bf/.test(CSS));
ok('★ VIS_MODE 三窗分流（bootVis / bootReview / boot 严格三选一）',
  JS.indexOf("var VIS_MODE = /(?:^|[?&])vis=1(?:&|$)/.test(window.location.search || '');") >= 0 &&
  /var GB_BOOT = VIS_MODE \? bootVis : \(RV_MODE \? bootReview : boot\);/.test(JS) &&
  /GB_BOOT\(\);/.test(JS) &&
  /document\.body\.classList\.add\('vis'\);/.test(JS) &&
  /document\.title = T\('visTitle'\);/.test(JS));
ok('★ 识图状态机：≤150 张自动删最老（2026-09-22 改版）/ 翻页到头变灰 / 识别与结果回投（带 seq 防过期）',
  /var VIS_LIST_MAX = 150;/.test(JS) &&
  /function visMakeRoom\(\) \{/.test(JS) &&
  /while \(VIS\.list\.length >= VIS_LIST_MAX\) \{/.test(JS) &&
  /VIS\.list\.shift\(\);/.test(JS) &&
  /els\.btn_vis_prev\.disabled = !has \|\| VIS\.idx <= 0;/.test(JS) &&
  /els\.btn_vis_next\.disabled = !has \|\| VIS\.idx >= VIS\.list\.length - 1;/.test(JS) &&
  /tellHost\(\{ type: 'visRecognize', mode: 'image', data: it\.d, seq: VIS\.reqSeq \}\);/.test(JS) &&
  /function visHandleResult\(m\) \{/.test(JS) &&
  /visShowResult\(r\);/.test(JS));
ok('★ 识别结果 y 就是面板坐标（不翻转）：black/white 原样合成着手序列入盘',
  /\(bl \|\| \[\]\)\.forEach\(function \(p\) \{ bs\.push\(\{ x: p\.x, y: p\.y, c: 1 \}\); \}\);/.test(JS) &&
  /\(wh \|\| \[\]\)\.forEach\(function \(p\) \{ ws\.push\(\{ x: p\.x, y: p\.y, c: 2 \}\); \}\);/.test(JS) &&
  /\(mv \|\| \[\]\)\.forEach\(function \(m\) \{ b\[m\[1\]\]\[m\[0\]\] = m\[2\]; \}\);/.test(JS));
ok('★ 识图提示语细分（2026-09-21 用户要求）：没认出棋盘 / 认出棋盘没棋子 / 图片可能模糊 / 低分辨率',
  /visBad: '暂时没识别出棋盘和棋子/.test(JS) &&
  /visNoStones: '识别到了棋盘，但没有读出棋子/.test(JS) &&
  /visSuspect: '当前图片可能模糊，识别不准确/.test(JS) &&
  /visLowRes: '图片分辨率较低（\{w\}×\{h\}），识别可能不准确'/.test(JS) &&
  /T\('visNoStones'\)/.test(JS) &&
  /T\('visLowRes'\)\.replace\('\{w\}', String\(it\.w\)\)/.test(JS));
ok('★ 残棋盘容错（2026-09-21 用户要求）：识别端 partial 标记 → 页面挂「棋盘可能不完整、' +
   '已居中加载」提示；加载到练习 = 静态盘面，人机模式自动切自由摆盘（AI 不接管）',
  /visPartial: '当前棋盘可能不完整（残盘），已按棋子排布居中加载；'/.test(JS) &&
  /\(r\.partial \? T\('visPartial'\) : ''\)/.test(JS) &&
  /if \(S\.mode !== 'place'\) \{/.test(JS) &&
  /S\.mode = 'place';/.test(JS) &&
  /x\.classList\.toggle\('on', x\.getAttribute\('data-mode'\) === 'place'\);/.test(JS));
ok('★ 复盘窗同步主窗「预览框」开关（2026-09-21 用户要求）：启动时读 previewOn + ' +
   'storage 事件实时跟进（其余设置照旧不恢复）',
  /if \(rvst && typeof rvst\.previewOn === 'boolean'\) S\.previewOn = rvst\.previewOn;/.test(JS) &&
  /ev\.key !== 'gbcalc\.settings\.v1'/.test(JS) &&
  /st\.previewOn !== S\.previewOn/.test(JS) &&
  /S\.previewOn = st\.previewOn;/.test(JS));
// ★ 2026-09-22（用户要求）：最后落点标记改版 —— 无序号 = 天蓝小圆点；有序号 = 最后一手
//   的数字单独放大、直接天蓝色（★ 2026-09-28 用户要求：不再白描边 + 黑白填充，
//   改用极淡暗描边衬底以免天蓝字在黑/白子上读不清；普通序号层仍跳过最后一手）。
ok('★ 最后落点标记：无序号=天蓝圆点 / 有序号=大一号天蓝数字（极淡暗描边衬底、居中）',
  JS.indexOf('if (i === G.moves.length - 1) return;') >= 0 &&  // 小字序号层跳过最后一手
  /ctx\.fillStyle = css\('--winline'\);/.test(JS) &&
  /ctx\.arc\(lx, ly, Math\.max\(2\.2, r \* 0\.22\), 0, Math\.PI \* 2\);/.test(JS) &&  // 无序号天蓝圆点
  /ctx\.font = '700 ' \+ Math\.max\(9, gap \* 0\.42\)/.test(JS) &&   // ★09-27：字号大一号
  /ctx\.strokeStyle = 'rgba\(15,40,60,\.35\)';/.test(JS) &&         // 极淡暗描边：天蓝字在黑白子上都读得清
  /ctx\.fillStyle = css\('--winline'\);/.test(JS) &&               // ★09-28：末手数字直接天蓝色
  /ctx\.strokeText\(String\(G\.moves\.length\), lx, ly\);/.test(JS) &&
  /ctx\.fillText\(String\(G\.moves\.length\), lx, ly\);/.test(JS));
// ★ 2026-09-22（用户要求）：图片抽屉 —— 自动保存（IndexedDB）/ 超 150 删最老 /
//   选择·全选·删除三小键 / Ctrl+A·Ctrl 点选·Shift 范围选 / 右键菜单 / 复制图片
ok('★ 图片抽屉管理（2026-09-22 用户要求）：持久化 / 多选 / 右键菜单 / 复制图片',
  /<button id="btn_vd_sel" class="btn vd-mini">/.test(HTML) &&
  /<button id="btn_vd_all" class="btn vd-mini">/.test(HTML) &&
  /<button id="btn_vd_del" class="btn vd-mini danger">/.test(HTML) &&
  /function visDb\(\) \{/.test(JS) &&
  /indexedDB\.open\('gbcalc-vis', 1\)/.test(JS) &&
  /function visPersist\(\) \{/.test(JS) &&
  /function visRestore\(cb\) \{/.test(JS) &&
  /function visItemClick\(ev, i\) \{/.test(JS) &&
  /ev\.ctrlKey \|\| ev\.metaKey \|\| selMode/.test(JS) &&
  /if \(ev\.shiftKey && VIS\.anchor >= 0\) \{/.test(JS) &&
  /function visRemoveSelected\(\) \{/.test(JS) &&
  /function visCopyImage\(idx\) \{/.test(JS) &&
  /new ClipboardItem\(\{ 'image\/png': blob \}\)/.test(JS) &&
  /function visShowMenu\(ev, items\) \{/.test(JS) &&
  /\(ev\.ctrlKey \|\| ev\.metaKey\) && \(ev\.key === 'a' \|\| ev\.key === 'A'\)/.test(JS));
// ★ 2026-09-22（用户要求）：识图「修改」键 —— 逐对交换 / 删除棋子（黑=白+1 可单删黑、
//   白=黑 可单删白，其余成对删）/ 加子「黑子开始/白子开始」双击成对流程（虚线框预览）；
//   修改模式下棋盘悬停预览框变浅紫；棋盘右键 = 同款菜单
// ★ 三轮（用户要求）：新增「补充黑子/补充白子」单补键；功能条整行居中；
//   提示文字统一走左侧 #visMsg（稍大一号，veHint 取消）；「自动吸附」智能开关
// ★ 四轮（用户要求）：修复补充键点击反向 bug；「缺谁亮谁」引导 + 齐平禁一边（变灰）；
//   补充键/黑子开始不再默认涂蓝；开始/确定组单独占一行
ok('★ 识图修改模式（2026-09-22 三/四轮用户要求）：逐对交换 / 单删+成对删 / 黑白开始加子流 / 补充单子 / 两行工具条 / 提示走左侧 / 浅紫预览框 / 缺谁亮谁',
  /<button id="btn_vis_edit" class="btn">/.test(HTML) &&
  /<div id="visEditBar" hidden>/.test(HTML) &&
  /<div class="ve-row">/.test(HTML) &&
  /<button id="btn_ve_swap" class="btn">/.test(HTML) &&
  /<button id="btn_ve_del" class="btn">/.test(HTML) &&
  /<button id="btn_ve_add" class="btn">/.test(HTML) &&
  /<button id="btn_ve_fillb" class="btn">补充黑子<\/button>/.test(HTML) &&
  /<button id="btn_ve_fillw" class="btn">补充白子<\/button>/.test(HTML) &&
  !/btn_ve_fillb" class="btn accent/.test(HTML) &&                       // 四轮：补充键不默认涂蓝
  !/btn_ve_addb" class="btn accent/.test(HTML) &&                        // 四轮：黑子开始不默认涂蓝
  !/veHint/.test(HTML) &&
  /function visEditToggle\(\) \{/.test(JS) &&
  /function visEditSwap\(\) \{/.test(JS) &&
  /function visEditPick\(kind\) \{/.test(JS) &&
  /function visFillGuide\(\) \{/.test(JS) &&                             // ★ 四轮：缺谁亮谁
  /els\.btn_ve_fillb\.disabled = !canB;/.test(JS) &&
  /els\.btn_ve_fillw\.disabled = !canW;/.test(JS) &&
  /function visGhostsCommit\(\) \{/.test(JS) &&
  /function visBoardClick\(ev\) \{/.test(JS) &&
  /function visSyncResult\(\) \{/.test(JS) &&
  /var singleOk = \(col === 1\) \? \(cnt0\.b === cnt0\.w \+ 1\) : \(cnt0\.b === cnt0\.w\);/.test(JS) &&
  /gs\.push\(\{ x: x, y: y, c: gs\.length \? \(3 - startC\) : startC \}\);/.test(JS) &&
  /if \(G\.board\[y\]\[x\]\) return;/.test(JS) &&                             // ★ 四轮：修复「点空点没反应」反向判断
  /if \(fc === 1 && fc0\.b > fc0\.w\) \{ visEditHint\(T\('veFillBFull'\)\); visFillGuide\(\); return; \}/.test(JS) &&
  /if \(fc === 2 && fc0\.w >= fc0\.b\) \{ visEditHint\(T\('veFillWFull'\)\); visFillGuide\(\); return; \}/.test(JS) &&
  /veFillGuideB: '白子比黑子多 \{d\} 颗 → 请点「补充黑子」补齐（一点补一颗）'/.test(JS) &&
  /veFillGuideB: 'White has \{d\} more than black/.test(JS) &&
  /function visEditHint\(t\) \{ visMsg\(t\); \}/.test(JS) &&
  /var hPurple = !!\(VIS && VIS\.edit\);/.test(JS) &&
  /ctx\.setLineDash\(\[Math\.max\(4, gap \* 0\.16\), Math\.max\(3, gap \* 0\.10\)\]\);/.test(JS) &&
  (JS.match(/bindBoardHover\(\);/g) || []).length >= 3 &&                    // 主窗 + 复盘 + 识图（修改模式预览框）
  /function visBoardCtx\(ev\) \{/.test(JS) &&
  /els\.board\.addEventListener\('contextmenu', visBoardCtx\);/.test(JS) &&
  /#visEditBar\{display:flex; flex-direction:column/.test(CSS) &&            // ★ 四轮：两行工具条
  /#visEditBar \.ve-row\{display:flex/.test(CSS) &&
  /body\.vis \.vis-msg\{font-size:1\.02rem/.test(CSS) &&
  /\.vd-item\.chk \.vd-chk\{display:block\}/.test(CSS));
// ★ 五轮（用户要求 2026-09-22）：「自动吸附」键整个删掉 —— 吸附不是问题：吸附重试只在
//   核心结果 suspect 时才走，且裁剪外扩约棋盘 1/30（与宿主选框同款口径）细节保得住，
//   大棋盘跳过判据一并删除（全棋盘图也能受益）；nosnap 请求链路从页面侧下线。
ok('★ 识图自动吸附键删除（2026-09-22 五轮用户要求）：吸附恒开 + 外扩棋盘 1/30 + 大棋盘跳过判据删除',
  !/btn_vis_snap/.test(HTML) &&                                              // 界面键整个删掉
  !/nosnap: S\.visSnap/.test(JS) &&                                          // 页面不再发 nosnap
  !/gbcalc\.vis\.snap/.test(JS) &&                                           // 开关持久化一并删除
  /Json recognize\(const std::string& imageB64, int size, bool allowSnap = true\);/.test(VISHDR) &&
  /bool skipCrops = !allowSnap;/.test(VISSRC) &&                             // 只剩显式关断才跳过
  !/bigBoard/.test(VISSRC) &&                                                // 大棋盘跳过判据删除
  /latticeCoverage/.test(VISSRC) &&
  /\(\(bw \+ bh\) \* 0\.5\) \/ 30\.0/.test(VISSRC) &&                        // 外扩 = 棋盘平均边长 / 30
  /--nosnap/.test(VISMAIN));                                                 // 协议层保留（向后兼容）
// ★ 五轮（用户要求 2026-09-22）：识别的**棋盘代码框** —— 夹在功能键与提示文字之间，
//   识别 / 修改落定后自动同步（movesToCode 同格式），带一键复制。
ok('★ 识图棋盘代码框（2026-09-22 五轮用户要求）：功能键与提示文字之间 + 自动同步 + 复制键',
  /<div class="vis-codebar" id="visCodeBar" hidden>/.test(HTML) &&
  HTML.indexOf('id="visCodeBar"') > HTML.indexOf('class="vis-acts"') &&      // 在功能键之后
  HTML.indexOf('id="visCodeBar"') < HTML.indexOf('id="visMsg"') &&           //   在提示文字之前
  /function visUpdateCode\(\) \{/.test(JS) &&
  /els\.visCode\.value = movesToCode\(G\.moves\);/.test(JS) &&
  /visUpdateCode\(\);/ && (JS.match(/visUpdateCode\(\);/g) || []).length >= 3 &&  // visShowMoves + visSyncResult 至少
  /els\.btn_vis_codecopy\.onclick/.test(JS) &&
  /visCode: '棋盘代码'/.test(JS) && /visCodeCopied: '棋盘代码已复制'/.test(JS) &&
  /\.vis-codebar\{display:flex/.test(CSS));
ok('★ 识图窗动态棋盘（2026-09-21 用户要求）：窗口缩放时棋盘跟着变、图片框大小不变',
  /window\.addEventListener\('resize', function \(\) \{ fitFont\(\); layoutBoard\(\); \}\);/.test(JS) &&
  /new ResizeObserver\(function \(\) \{ fitFont\(\); layoutBoard\(\); \}\)\.observe\(els\.boardWrap\);/.test(JS));
ok('★ 保存到历史（同源 localStorage 直接入库）/ 加载到练习（宿主转投 external 通道）',
  /addRecord\(\{\s*ts: Date\.now\(\), src: 'vis', rule: 0, first: 'b',/.test(JS) &&
  // ★ 九轮：载荷随行 vc 标记（识图 VC 模式 → 主窗自动 VCF/VCT 模拟）
  /tellHost\(\{ type: 'visToTrainer', payload: \{ src: 'vis', black: VIS\.result\.black, white: VIS\.result\.white, vc: !!VIS\.vc \} \}\);/.test(JS) &&
  /localStorage\.setItem\('gbcalc\.vis\.pending'/.test(JS));
ok('★ 识图文案中英两套齐全（i18n 双词条）',
  /vis: '识图'/.test(JS) && /vis: 'Vision'/.test(JS) &&
  /visUpload: '上传图片'/.test(JS) && /visUpload: 'Upload images'/.test(JS) &&
  /visShot: '屏幕截图'/.test(JS) && /visShot: 'Screenshot'/.test(JS) &&
  /visOk: '识别到 \{b\} 颗黑子、\{w\} 颗白子'/.test(JS) &&
  /visOk: 'Recognized \{b\} black and \{w\} white stones'/.test(JS) &&
  /if \(els\.btn_vis\) els\.btn_vis\.textContent = d\.vis;/.test(JS));
ok('★ 识图窗 CSS：body.vis 收掉主窗/复盘的一切，左面板 + 右棋盘',
  /body\.vis :is\(#hdr,#dockL,#dockR,#openBar,#swapPop,#boardFoot,#rvBar\)\{display:none !important\}/.test(CSS) &&
  /body\.vis #visPane:not\(\[hidden\]\)\{/.test(CSS) &&
  /\.btn\[disabled\]\{opacity:\.4; pointer-events:none\}/.test(CSS));
ok('★ 宿主：openVis 分支 + GbCalcVis 独立顶层窗 + 「Gomoku Vision」遮罩',
  HOST.indexOf('s.find("\\"openVis\\"")') >= 0 &&
  /static const wchar_t\* kVisCls = L"GbCalcVis";/.test(HOST) &&
  /static const wchar_t\* kBrandNameVis = L"Gomoku Vision";/.test(HOST) &&
  /Navigate\(L"http:\/\/127\.0\.0\.1:8965\/calc\.html\?vis=1"\);/.test(HOST) &&
  /SetupUiServing\(g_visWebview, "vis"\);/.test(HOST) &&
  /\[vis\] vision window shown/.test(HOST));
ok('★ 宿主：屏幕截图 = GDI BitBlt 一次成图（DXGI 花屏已退掉；不再最小化三窗 —— 用户定稿），' +
   'GDI+ 编 PNG 回投 dataURL',
  !/VisMinimizeOurs/.test(HOST) && !/SW_MINIMIZE\);/.test(HOST) &&
  !/DxgiDupOutput/.test(HOST) &&
  !/CreateDXGIFactory1/.test(HOST) &&
  /BitBlt\(mdc, 0, 0, w, h, sdc, rc\.left, rc\.top, SRCCOPY\);/.test(HOST) &&
  /Gdiplus::Bitmap bmp\(hb, nullptr\);/.test(HOST) &&
  HOST.indexOf('visShotData\\",\\"data\\":\\"data:image/png;base64,') >= 0 &&
  HOST.indexOf('"type\\":\\"visShotFail\\"') >= 0);
ok('★ 宿主：自由截取 = 中空选框窗（复用五子棋助手「手动调节」，天蓝版）——内部 alpha=0 透出活屏、' +
   'UpdateLayeredWindow 合成、WDA 排除自身；开框前 GdiplusEnsure（不初始化 = 整窗透明的「框不出来」根因）；' +
   '截完框保留（只有关闭/ESC 收框）',
  /static void VselPaint\(HWND h\)/.test(HOST) &&
  /g\.Clear\(Gdiplus::Color\(0, 0, 0, 0\)\);/.test(HOST) &&
  /UpdateLayeredWindow\(h, sdc, nullptr, &sz, mem, &src, 0, &bf, ULW_ALPHA\);/.test(HOST) &&
  /SetWindowDisplayAffinity\(g_visSelHwnd, WDA_EXCLUDEFROMCAPTURE\);/.test(HOST) &&
  /GB_TEST_CAPTURABLE/.test(HOST) &&
  /GdiplusEnsure\(\);\s*\n\s*static const wchar_t\* kCls/.test(HOST) &&
  /static void VselShot\(HWND h\)/.test(HOST) &&
  /int top = wr\.top \+ VSEL_TITLE_H;/ .test(HOST) &&
  !/VselClose\(\);\s*\n\s*VisShotDeliver\(rc\);/.test(HOST) &&
  /RunVisHollowSelect\(\);/.test(HOST));
ok('★ 宿主：识别走 GomokuVision.exe 子进程（喂原始字节；环境块必须 nullptr）',
  /static void RunVisionForVis\(std::string req\)/.test(HOST) &&
  /static std::wstring FindVisionExe\(\)/.test(HOST) &&
  /L"--recognize-image"/.test(HOST) && /L"--scan-image"/.test(HOST) &&
  /mode == "scan" \? L"--scan-image" : L"--recognize-image"/.test(HOST) &&
  /CREATE_NO_WINDOW, nullptr, cwd\.c_str\(\)/.test(HOST) &&
  HOST.indexOf('\\"result\\":" + out + "}")') >= 0);
ok('★ 宿主：「加载到练习」→ 主窗 external 通道；uiTheme 转发三窗；outbox 支持跨线程 flush',
  /PostToPageSoon\("\{\\"type\\":\\"external\\",\\"payload\\":" \+ JsonQuote\(payload\) \+ "\}"\)/.test(HOST) &&
  /ApplyDarkTitleBar\(g_visHwnd, g_uiDark\);/.test(HOST) &&
  /static const UINT kMsgFlushOutbox = WM_APP \+ 2;/.test(HOST) &&
  /case kMsgFlushOutbox:/.test(HOST) &&
  /for \(size_t i = 0; i < vs\.size\(\); \+\+i\) PostToVisPage\(vs\[i\]\);/.test(HOST));
ok('★ 截图入口 = 点「截图」直接弹中空选框（用户 2026-09-21 定稿：无中间小弹窗、不最小化；' +
   'visShot 经 kMsgVisShot 独立消息进 UI 线程，不在 WebView2 回调栈上跑嵌套循环）',
  /static void StartVisShotFlow\(\)/.test(HOST) &&
  /PostMessageW\(g_hwnd, kMsgVisShot, 0, 0\);/.test(HOST) &&
  /static const UINT kMsgVisShot = WM_APP \+ 7;/.test(HOST) &&
  /case kMsgVisShot:/.test(HOST) &&
  /if \(g_visSelHwnd && IsWindow\(g_visSelHwnd\)\) return;/.test(HOST) &&
  /RunVisHollowSelect\(\);/.test(HOST) &&
  !/VisMinimizeOurs/.test(HOST) &&
  !/GbCalcVisPick/.test(HOST) && !/g_visPickHwnd/.test(HOST) &&
  !/PickActivate/.test(HOST) && !/PickScale/.test(HOST));
ok('★ 识图窗最小窗口阈值 = 900×660（CSS px 基准）× 当前显示器 DPI（随分辨率/缩放换算）',
  /kVisMinCssW\s+= 900;/.test(HOST) && /kVisMinCssH\s+= 660;/.test(HOST) &&
  /int mw = GbPx\(h, kVisMinCssW\), mh = GbPx\(h, kVisMinCssH\);/.test(HOST) &&
  /GbClampToWorkArea\(h, mw, mh\);/.test(HOST));
ok('★ 构建脚本给识图链接 gdiplus.lib（截屏 PNG 编码）',
  /'gdiplus\.lib',/.test(fs.readFileSync(BUILD_JS, 'utf8')));
ok('★ 中空选框「自动贴棋盘」（用户 2026-09-21 晚定稿：默认开启，复刻助手自动贴盘手感）——' +
   '标题栏「自动 开/关」键 + WM_TIMER 1.2s 轮询 + 后台线程抓虚拟屏喂 GomokuVision --scan-image + ' +
   '命中回 VSEL_WM_SNAP 贴到 board_rect（拖拽中不抢、已贴好不抖）',
  /VSEL_BTN_AUTO = 102/.test(HOST) &&
  /static bool g_vselAuto = true;/.test(HOST) &&
  /VshT\(L"自动 开", L"Auto"\)/.test(HOST) &&
  /SetTimer\(g_visSelHwnd, 1, 1200, nullptr\);/.test(HOST) &&
  /KillTimer\(h, 1\);/.test(HOST) &&
  /static void VselAutoScan\(HWND h\)/.test(HOST) &&
  HOST.indexOf('--scan-image') >= 0 &&
  HOST.indexOf('"board_rect\\"') >= 0 &&
  /static bool VselScanRect\(const std::string& s, RECT& out, double& stepOut\)/.test(HOST) &&
  /\\"board_rect\\"/.test(HOST) &&
  /#define VSEL_WM_SNAP \(WM_APP \+ 9\)/.test(HOST) &&
  /case VSEL_WM_SNAP: \{/.test(HOST) &&
  /if \(wp == 1 && g_vselAuto && g_vselDrag == VSEL_NONE\) VselAutoScan\(h\);/.test(HOST));
ok('★ 自动贴框外扩（用户 2026-09-21：多留约「棋盘尺寸的 1/30」轮廓，边缘棋子完整进图；' +
   '★ 2026-09-22 深夜修（用户「1/30 应用到了框的里面」）：board_rect=最外两条格线中心，' +
   '只外扩 1/30 框边压在外圈子上 —— 改与识别端同口径 pad = 半格 + 平均边长/30；' +
   'step 取 scan 的 spacing（缺失按 w/14 估）；下限 6px 保留；外扩后钳回虚拟屏防抓到黑边）',
  /double step = \(g_vselStep > 0\) \? g_vselStep : \(double\)bw \/ 14\.0;/.test(HOST) &&
  /int pad = \(int\)\(step \* 0\.5 \+ \(\(bw \+ bh\) \* 0\.5\) \/ 30\.0 \+ 0\.5\);/.test(HOST) &&
  /static double g_vselStep = 0;/.test(HOST) &&
  /g_vselStep = step;/.test(HOST) &&
  /s\.find\([^)]*spacing[^)]*\)/.test(HOST) &&
  /if \(pad < 6\) pad = 6;/.test(HOST) &&
  /if \(x < vx\) \{ w -= \(vx - x\); x = vx; \}/.test(HOST) &&
  /if \(x \+ w > vx \+ vw\) w = vx \+ vw - x;/.test(HOST));
ok('★ 选框英文模式（2026-09-21 收官）：按键/标题一律英文短词（Auto/Off·Shot·Close、Drag · Shot），' +
   '键宽按**量出来的字宽**定（不写死）且「开/关」取较宽者防跳；窄框最小宽度跟着实测跨度走；' +
   '语言三处同步 —— 启动读 ui 文件、页面 ready、切语言时页面上报 uiTheme',
  /VshT\(L"截图", L"Shot"\)/.test(HOST) &&
  /VshT\(L"关闭", L"Close"\)/.test(HOST) &&
  /L"Drag · Shot"/.test(HOST) &&
  /bw\[i\] = \(int\)\(m\.Width \+ 0\.999f\) \+ VsS\(22\);/.test(HOST) &&
  /「自动」键按「开\/关两种状态里更宽的那个」定宽/.test(HOST) &&
  /g_vselBtnSpan = span;/.test(HOST) &&
  /if \(g_vselBtnSpan > 0 && g_vselBtnSpan \+ VsS\(30\) > minW\)/.test(HOST) &&
  /g_uiLangEn = \(lang\.rfind\("en", 0\) == 0\);/.test(HOST) &&
  /if \(!lg\.empty\(\)\) g_uiLangEn = \(lg\.rfind\("en", 0\) == 0\);/.test(HOST) &&
  JS.indexOf("if (HOST) tellHost({ type: 'uiTheme', theme: themeKey(), bg: pageBgHex(), lang: S.lang, cssVars: S.cssVars });")
    > JS.indexOf('function applyLang()') &&
  JS.indexOf("if (HOST) tellHost({ type: 'uiTheme'") < JS.indexOf('function applyRuleHint()'));
ok('★ 识图界面关闭 → 截图框跟着关（2026-09-21 收官）：识图窗 WM_CLOSE/WM_DESTROY 都 Post ' +
   'WM_CLOSE 给选框（不直接 Destroy：选框有自己的消息循环），选框 WM_CLOSE 走 VselClose 统一收尾',
  /static void VselCloseWithVisWindow\(\)/.test(HOST) &&
  /PostMessageW\(g_visSelHwnd, WM_CLOSE, 0, 0\);/.test(HOST) &&
  /VselCloseWithVisWindow\(\);\n      DestroyWindow\(h\);/.test(HOST) &&
  /VselCloseWithVisWindow\(\);\n      if \(g_visController\)/.test(HOST) &&
  /case WM_CLOSE:\n      VselClose\(\);\n      return 0;/.test(HOST));
ok('★ 选框观感（2026-09-21 收官）：框栏压到 0.6 倍 = 34 高、按键只压高度 26（宽度和字号 17/16 不变）、' +
   '边框 VsS(3)、把手 VsS(12)、命中区 VsS(18)、初始尺寸 VsS(480×360) —— 全部随系统 DPI 缩放',
  /Gdiplus::Pen pen\(sky, \(Gdiplus::REAL\)VsS\(3\)\);/.test(HOST) &&
  /const int hs = VsS\(12\);/.test(HOST) &&
  /#define VSEL_TITLE_H \(VsS\(34\)\)/.test(HOST) &&
  /#define VSEL_GRIP    \(VsS\(18\)\)/.test(HOST) &&
  /int bh = VsS\(26\), by = \(VSEL_TITLE_H - VsS\(26\)\) \/ 2;/.test(HOST) &&
  /Gdiplus::Font f\(&ff, \(Gdiplus::REAL\)VsS\(17\), Gdiplus::FontStyleBold/.test(HOST) &&
  /Gdiplus::Font f\(&ff, \(Gdiplus::REAL\)VsS\(16\), Gdiplus::FontStyleBold/.test(HOST) &&
  /static int VsDpi\(\)/.test(HOST) && /static int VsS\(int v\)/.test(HOST) &&
  /int w = VsS\(480\), h = VsS\(360\) \+ VSEL_TITLE_H;/.test(HOST));
{
  const PYDET = fs.readFileSync(path.join(ROOT, 'engine-server', 'python', 'gomoku_assistant', 'detector.py'), 'utf8');
  const VDET = fs.readFileSync(path.join(ROOT, 'desktop-vision', 'src', 'gbdetector.cpp'), 'utf8');
  const ES = fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8');
  const EAI = fs.readFileSync(path.join(ROOT, 'desktop-calculator', 'ui', 'engine-ai.js'), 'utf8');
  ok('★ 识别预防针（2026-09-21 收官）：细网线峰位亚像素细化（抛物线插值）+ 贴边格补读 ——' +
     ' Python 参考与 C++ 两侧逐位同式（对拍口径不变）',
    /预防针（2026-09-21 收官）：细网线的峰被整数像素量化/.test(VDET) &&
    /double delta = 0\.5 \* \(pa - pc\) \/ den;/.test(VDET) &&
    /贴边格不再整格跳过/.test(VDET) &&
    /if \(yy < 0 \|\| yy >= gray\.rows \|\| xx < 0 \|\| xx >= gray\.cols\) continue;/.test(VDET) &&
    PYDET.indexOf('预防针（2026-09-21 收官）') >= 0 &&
    PYDET.indexOf('np.mean(dark_detail, axis=0, dtype=np.float64)') >= 0 &&
    PYDET.indexOf('pos += delta') >= 0);
  // ★ 2026-09-24（原生 Rapfi 车道）：EAI 的哈希口径从「固定 2GB / 1-3 内存」升级为
  //   **按车道区分** —— wasm 仍 2GB / 1-3（与 engine-server.js 同式，未动），原生进程
  //   没有 wasm32 地址空间天花板 → 6GB / 1-4（比例更保守，别把系统吃干）。
  ok('★ 引擎档位（09-28 科学分配 + 晚间稳定性余量：主搜留 ≥25% 核给系统）+ STOP 抢占 + 官方 ponder + 哈希 KB 口径',
    // ★ 2026-09-28：废弃 defaultThreads 分档（10 核机只给主搜 7 线程，比对手 8 线程还少）——
    //   新公式 main = cpuAll - max(2, ⌈cpuAll/4⌉)（10 核机 8 线程；16 核机 12 线程，
    //   整机负载 ~75% 不满载 —— 用户「保留些许空间，怕用户的电脑崩溃」），sub/fwd 各 1 专供视图
    /var mainT = Math\.max\(1, cpuAll - Math\.max\(2, Math\.ceil\(cpuAll \/ 4\)\)\);/.test(ES) &&
    /if \(process\.env\.GB_THREADS\) mainT = Math\.max\(1, Math\.min\(cpuAll, parseInt\(process\.env\.GB_THREADS, 10\) \|\| mainT\)\);/.test(ES) &&
    /var subT  = 1;/.test(ES) && /var fwdT  = 1;/.test(ES) &&
    // ★ 2026-09-28 晚：STOP 抢占通道（ponder 期间正式请求零排队）+ 进程优先级让位系统
    /function preemptLane\(lane, maxMs\)/.test(ES) &&
    /sendLane\(lane, 'STOP'\)/.test(ES) &&
    /!\(lane\.liveState && lane\.liveState\.searching === true\)/.test(ES) &&
    /if \(lane\.mayPonder\) await preemptLane\(lane, 1500\);/.test(ES) &&
    /const PRIO = process\.env\.GB_PRIO \|\| 'AboveNormal';/.test(ES) && !/PriorityClass='High'/.test(ES) &&
    // ★ 2026-09-28：官方 ponder（主车道 PONDERING 1 + quiesce 防改盘竞态 + 闲时 watchdog）
    /sendLane\(lj, 'INFO PONDERING ' \+ \(ponderOn \? 1 : 0\)\)/.test(ES) &&
    /if \(lane === LANES\.main && process\.env\.GB_PONDER !== '0'\) sendLane\(lane, 'INFO PONDERING 1'\);/.test(ES) &&
    /function quiesceLane\(lane, maxMs\)/.test(ES) &&
    /PONDER_WATCHDOG_MS = 10 \* 60 \* 1000/.test(ES) &&
    /lane\.outBuf\.length > 131072/.test(ES) &&                                              // ponder 流量限长
    /const quietLine = !lane\.inSearch && \(line\.startsWith\('INFO '\) \|\| line\.startsWith\('MESSAGE '\)\)/.test(ES) &&
    // ★ 2026-09-25：哈希改 KB 口径（修「MB 当 KB 用」单位 bug）—— 内存 1/3、封顶 4GB、保底 256MB
    /Math\.max\(262144, Math\.min\(4 \* 1024 \* 1024, Math\.floor\(totalKB \/ 3\)\)\)/.test(ES) &&
    /Math\.max\(2, cpuAll - 1\)/.test(EAI) &&
    // ★ 2026-09-25：EAI（页面 Worker）不再「main 拿 60% 再减 2」—— 那会让算力更强的原生版
    //   主力车道反而比 WASM 版少 2 个线程（用户报「原生版棋力不如网页版」的实测根因之一）。
    //   改成只给辅助车道留 2~3 个线程，其余全给 main（见「车道线程向 main 倾斜」那条断言）。
    /var mainT = cpuN;/.test(EAI) &&
    !/Math\.round\(cpuN \* 0\.6\)/.test(EAI) && !/var mainT = Math\.max\(1, cpuN - reserve\);/.test(EAI) && /var subT = 1;/.test(EAI) &&
    /var hashCapKB = NATIVE\.ok \? 6291456 : 2097152;/.test(EAI) &&
    /var hashDiv = NATIVE\.ok \? 4 : 3;/.test(EAI) &&
    /Math\.max\(262144, Math\.min\(hashCapKB, Math\.floor\(totalMemKB\(\) \/ hashDiv\)\)\);/.test(EAI) &&
    /var calcMs = Math\.min\(60000, Math\.round\(\(S\.turnMs \|\| 2000\) \* 1\.6\)\);/.test(JS) &&   // ★09-27：封顶放宽 60s 防呆（随思考时间走）
    // ★ 三十三轮：「计算」改走多引擎票箱 —— 单引擎档仍是 topN=1 的单路深搜（ensTopN 保深度）
    /analyzeVote\(calcMs, 1, curColor\(\), null, null, T\('tagCalc'\)\)/.test(JS));
}

// ★ 2026-09-25（用户要求）：两条「机器能力 → 档位」的规则，页面与宿主两侧都要对上。
//   ① 核心数上限：总核 ≥16 留 4、≥8 留 2、其余留 1（16 核机 → 上限 12）；
//   ② 哈希可选 256MB→6GB，且**物理内存 < 8GB 时 6GB 档变灰不可选**；6GB 只给原生引擎（WASM 上限 2GB）。
//   还顺手守一条真实缺陷：档位必须**开机就推给引擎** —— 此前 Worker 拿 0/0（自动档）起，
//   页面显示「12 线程 / 1024MB」而引擎按 15 线程跑，用户设的上限形同虚设。
{
  ok('★ 引擎档位·核心数规则（host.cpp）：总核 ≥16 留 4、≥8 留 2、其余留 1 —— 机器越强留越多给系统',
    /int sub = \(n >= 16\) \? 4 : \(\(n >= 8\) \? 2 : 1\);/.test(HOST) &&
    /int t = n - sub;/.test(HOST) &&
    /static int CpuCount\(\)/.test(HOST) && /GetNativeSystemInfo\(&si\)/.test(HOST));
  ok('★ 引擎档位·宿主把内存与「有没有原生引擎」一起报给页面（6GB 档的门禁靠它）',
    /static int MemTotalMB\(\)/.test(HOST) &&
    /GlobalMemoryStatusEx\(&ms\)/.test(HOST) &&
    /"\\"memMB\\":%d,\\"native\\":%s}"/.test(HOST) &&
    /MemTotalMB\(\),/.test(HOST) &&
    /nativeeng::Available\(\) \? "true" : "false"/.test(HOST) &&
    /static bool Available\(\) \{\s*Probe\(\);\s*return g_avail;\s*\}/.test(HOST));
  ok('★ 引擎档位·哈希 256MB→6GB（页面侧）：6GB 只给原生引擎、内存 < 8GB 变灰、默认固定 1024MB',
    /var maxH = native \? 6144 : 2048;/.test(JS) &&
    /if \(maxH > 2048\) hs = hs\.concat\(\[3072, 4096, 6144\]\);/.test(JS) &&
    /var allow6 = native && \(memMB <= 0 \|\| memMB >= 8192\);/.test(JS) &&
    /var off = \(h === 6144 && !allow6\);/.test(JS) &&
    /\(off \? ' disabled' : ''\)/.test(JS) &&
    /S\.hashMB = 1024;   \/\/ 默认 1024MB/.test(JS) &&
    /memMB: m\.memMB \|\| 0, native: !!m\.native/.test(JS));
  ok('★ 档位立刻推给引擎（修「页面显示 12 线程、引擎按 15 线程跑」）：buildSelects 末尾就下发',
    /els\.sel_hash\.innerHTML = hs\.map\(function \(h\) \{[\s\S]{0,400}?\}\)\.join\(''\);\s*[\s\S]{0,700}?applyEngineConfig\(\);/.test(JS) &&
    /tellHost\(\{ type: 'engineConfig', threads: S\.cores \|\| 0, hashMB: S\.hashMB \|\| 0 \}\);/.test(JS));
}

// ★★ 2026-09-25（用户要求）：AI 执黑 + AI 执白都选中 → **AI 自动对弈**；棋盘正中那颗键
//   （原来只是「辅助一手 / 暂停」的图标键）= 自动对弈的开关键，语义与播放器一致：
//   ❚❚ = 正在自动走子（点一下停手）、▶ = 已停手（点一下继续）。三处缺一不可：
//     ① 两个开关都选中 → 自动解除「停手」并立刻开局（用户不必再去点 ▶）；
//     ② 正中键在自打时**不能禁用**（旧版 disabled 掉了 → 用户根本停不下来）；
//     ③ 点击时走「播放/暂停」而不是「辅助一手」（自打时 AI 自己会走每一步）。
{
  ok('★ AI 自打（1/3）：两个执子开关都选中 → 自动解除停手、立刻开局',
    /if \(aiVsAi\(\)\) S\.paused = false;/.test(JS) &&
    /if \(!openActive\(\)\) maybeAi\(\);/.test(JS));
  ok('★ AI 自打（2/3）：正中那颗键 = 开关键（自打时不再禁用；摆盘/残局才禁用）',
    /els\.btn_pause\.disabled = \(S\.mode === 'place' \|\| S\.mode === 'endgame'\);/.test(JS) &&
    /els\.btn_pause\.title = S\.paused[\s\S]{0,180}?T\('spResume'\)[\s\S]{0,180}?T\('spPause'\)/.test(JS) &&
    /spPause: '停手（暂停自动对弈）'/.test(JS) && /spResume: '继续自动对弈'/.test(JS) &&
    /spPause: 'Stop \(pause AI self-play\)'/.test(JS) && /spResume: 'Resume AI self-play'/.test(JS));
  ok('★ AI 自打（3/3）：点这颗键 = 播放/暂停（自打时不再走「辅助一手」），继续时立刻接上下一手',
    /els\.btn_pause\.onclick = function \(\) \{[\s\S]{0,600}?if \(aiVsAi\(\)\) \{\s*S\.paused = !S\.paused;[\s\S]{0,200}?if \(!S\.paused\) maybeAi\(\);/.test(JS) &&
    /if \(!S\.paused\) maybeAi\(\);\s*\/\/ 继续 \u2192 立刻接着走下一手/.test(JS) &&
    // 「摆盘 / 残局」不自动走子 —— 提示文案要明说（用户原话：如果摆盘的话，就不用自动对弈）
    /sideHintBothPlace: 'AI 自打已就绪，但「自由摆盘」是摆盘用的、不会自动走子/.test(JS) &&
    /S\.mode === 'pve' \? T\('sideHintBoth'\) : T\('sideHintBothPlace'\)/.test(JS) &&
    /S\.mode === 'pve' \? d\.sideHintBoth : d\.sideHintBothPlace/.test(JS));
}
ok('★ 选框「自动」键浅蓝绿涂色 + 标题文字量宽放不下就换短档（英文长字不压键、不留半句）+ ' +
   '最窄宽度容得下三个键（2026-09-21 晚二批）',
  /autoOn \? 72 : 96, autoOn \? 201 : 118, autoOn \? 186 : 136,/.test(HOST) &&
  /Gdiplus::FontFamily ff\(BrandFontFace\(\)\);/.test(HOST) &&
  /g\.MeasureString\(cands\[i\], -1, &f, Gdiplus::PointF\(0, 0\), &sf, &msz\);/.test(HOST) &&
  /if \(VsS\(12\) \+ msz\.Width <= room\)/.test(HOST) &&
  /Gdiplus::REAL room = \(Gdiplus::REAL\)\(g_vselBtnAuto\.left - VsS\(8\)\);/.test(HOST) &&
  /int minW = VsS\(330\), minH = VSEL_TITLE_H \+ VsS\(60\);/.test(HOST) &&
  /g_uiLangEn \? L"Drag · Shot" : L"拖到棋盘 · 点截图",/.test(HOST));

// ★ 2026-09-21（用户要求）：AI 引擎必须用**强 SIMD 加速**构建 —— 随包 rapfi-multi.wasm
//   是 SIMD(v128)+pthreads 版：SIMD 操作码 0xFD、原子操作 0xFE 在字节码里大量存在
//   （非 SIMD 构建几乎为 0），emscripten 胶水带 SharedArrayBuffer/pthread；加载单路
//   rapfi-multi，不存在非 SIMD 回退。
{
  const wasmP = path.join(ROOT, 'desktop-calculator', 'build', 'resources', 'rapfi-multi.wasm');
  if (fs.existsSync(wasmP)) {
    const w = fs.readFileSync(wasmP);
    let fd = 0, fe = 0;
    for (let i = 0; i < w.length - 1; i++) {
      if (w[i] === 0xFD && w[i + 1] <= 0x0F) fd++;
      if (w[i] === 0xFE && w[i + 1] <= 0x0F) fe++;
    }
    ok('★ AI 引擎 = 强 SIMD 加速构建（wasm 字节码含 ' + fd + ' 个 v128 操作码 + ' + fe + ' 个原子操作码）',
      fd >= 100 && fe >= 50);
    const glueP = path.join(ROOT, 'desktop-calculator', 'build', 'resources', 'rapfi-multi.js');
    const glue = fs.existsSync(glueP) ? fs.readFileSync(glueP, 'utf8') : '';
    ok('★ AI 引擎多线程 = SAB/pthreads（emscripten 胶水带 SharedArrayBuffer + pthread worker）',
      /SharedArrayBuffer/.test(glue) && /pthread/i.test(glue) &&
      /importScripts\(AI_BASE \+ 'rapfi-multi\.js'\)/.test(fs.readFileSync(path.join(UI_DIR, 'engine-ai.js'), 'utf8')));
  } else {
    ok('★ AI 引擎 = 强 SIMD 加速构建（build/resources 未就位，跳过字节级检查）', true);
    ok('★ AI 引擎多线程 = SAB/pthreads（build/resources 未就位，跳过）', true);
  }
}

// ★ 2026-09-24（廿七轮）：引擎命令乱序防护 —— 原生车道每条命令一个独立 fetch POST，
//   浏览器并发连接到达顺序不保证：YXNBEST 先到 → 引擎在空盘思考（START 已建盘）→
//   YXBOARD 被 `thinking` 拦截 → 落子=空盘最佳点（白棋「下偏」）；INFO TIMEOUT_TURN/HASH_SIZE
//   乱序丢失 → 按错参数思考（棋力波动）。修法 = 一批命令 join('\n') 一次发；YXSHOWFORBID
//   并进主 body 且 captureLine 先挂后发。
{
  const EAI = fs.readFileSync(path.join(UI_DIR, 'engine-ai.js'), 'utf8');
  ok('★ 引擎命令乱序防护 = sendLaneCmds 批量发送（native 合并一个 body）',
    /function sendLaneCmds\(lane, cmds\) \{/.test(EAI) &&
    /lane\.engine\.sendCommand\(cmds\.join\('\\n'\)\)/.test(EAI) &&
    /sendLaneCmds\(lane, cmds\);/.test(EAI));
  ok('★ 引擎命令乱序防护 = boot 的 START+INFO 合并 + YXSHOWFORBID 并进主 body',
    /'INFO HASH_SIZE ' \+ sp\.hashKB\]\)/.test(EAI) &&
    /if \(rule === 2 \|\| rule === 4\) \{ cmds\.push\('YXSHOWFORBID'\); forbidCap = armForbidCapture\(lane\); \}/.test(EAI) &&
    /function armForbidCapture\(lane\) \{/.test(EAI) &&
    /cmds\.push\('YXNBEST ' \+ effTopN\);/.test(EAI));
  // ★ 2026-09-24（廿八轮，用户要求）：纯训练器版移除 WASM —— GB_NO_WASM 构建期开关
  ok('★ 纯训练器版无 WASM 回落 = GB_NO_WASM 开关 + 原生不可用明确 bootfail',
    /var GB_NO_WASM = \(typeof GB_NO_WASM !== 'undefined'\) \? GB_NO_WASM : false;/.test(EAI) &&
    /else if \(GB_NO_WASM\) throw new Error\('NO_NATIVE_NO_WASM'\);/.test(EAI) &&
    /if \(GB_NO_WASM\) return Promise\.reject\(new Error\('NO_NATIVE_NO_WASM'\)\);/.test(EAI) &&
    /toast\(T\('noNativeEngine'\)\)/.test(JS) &&
    /noNativeEngine: '本机不支持原生 AI 引擎/.test(JS));
}

// ★ 2026-09-24（廿八轮，用户要求）：前瞻后期每手思考时间 = 用户设置的思考时间（S.turnMs），
//   不再「×2 封顶 1.2 秒」；普通前瞻**不**运用 VCF/VCT —— 只有点「查找 VCF / 查找 VCT」
//   （wantVcx）才在途中回探杀线（回探时机 = 进攻方行棋前，对齐 Rapfi 威胁空间搜索语义）。
ok('★ 前瞻后期每手思考时间 = 用户设置（S.turnMs），不再封顶 1.2 秒',
  /var thinkMs = Math\.max\(300, S\.turnMs \|\| 2000\);/.test(JS) &&
  /turnMs: tms, timeUsedMs: 0,/.test(JS) &&
  !/Math\.min\(1200, \(S\.turnMs \|\| 400\) \* 2\)/.test(JS));
ok('★ 前瞻运用 VCF/VCT 只在显式查找模式（wantVcx 才回探，普通前瞻不查杀）',
  /if \(wantVcx && step > 0 && cc === atkFix\) \{/.test(JS) &&
  /await fwdTryVcx\(b, wantA, VCX_STEP_TIMEOUT\)/.test(JS) &&
  /await fwdTryVcx\(b, wantVcx \? wantA : 'auto', wantVcx \? VCX_WORKER_DEEP : VCX_WORKER_TIMEOUT\)/.test(JS));
// ★ 廿八轮：计算习惯全面原生化 —— Bal2 探针 ×0.5/2.2s → ×0.6/5s；防守精修 400/900/1600 → 600/1400/2600
ok('★ 计算习惯匹配原生引擎（Bal2 探针放宽 + 防守精修预算加深）',
  /var probeMs = Math\.max\(700, Math\.min\(5000, Math\.round\(\(S\.turnMs \|\| 2000\) \* 0\.6\)\)\);/.test(JS) &&
  /var RD = \[600, 1400, 2600\];/.test(JS));
// ★ 廿八轮（用户要求）：识图裁剪预览 = 原图形式（小图绝不放大），高于屏幕的原图等比缩到合适大小。
// ★ 2026-09-25（用户要求）：弹窗更大（90% 窗宽 / 84% 窗高）；画布位图按 DPR 建 + setTransform，
//   高分屏 1:1 物理像素显示不再发糊；逻辑坐标（选区/鼠标/裁剪换算）仍是 CSS 像素。
ok('★ 识图裁剪预览 = 原图形式 + DPR 位图（高分屏不发糊）+ 更大的弹窗',
  /var maxW = Math\.max\(240, window\.innerWidth \* 0\.9\);/.test(JS) &&
  /var maxH = Math\.max\(200, window\.innerHeight \* 0\.84\);/.test(JS) &&
  /CROP\.scale = Math\.min\(maxW \/ im\.naturalWidth, maxH \/ im\.naturalHeight, 1\);/.test(JS) &&
  /CROP\.dpr = Math\.max\(1, window\.devicePixelRatio \|\| 1\);/.test(JS) &&
  /cv\.width = Math\.max\(1, Math\.round\(CROP\.cssW \* CROP\.dpr\)\);/.test(JS) &&
  /cv\.style\.width = CROP\.cssW \+ 'px';/.test(JS) &&
  /ctx\.setTransform\(CROP\.dpr, 0, 0, CROP\.dpr, 0, 0\);/.test(JS) &&
  /Math\.min\(CROP\.cssW, Math\.min\(a\.x, b\.x\)\)/.test(JS) &&
  !/Math\.min\(window\.innerWidth \* 0\.68, 1100\)/.test(JS));

// ---------------------------------------------------------- 启动遮罩双色调（2026-09-21）
ok('★ 软件名「Meter Gomoku Trainer」：Meter 单独涂天蓝（页面 i 标签 + GDI 分段分色）',
  /<span class="brand"><i>Meter<\/i> Gomoku Trainer<\/span>/.test(HTML) &&
  /\.boot \.brand i\{\s*font-style:inherit;\s*color:#3d9bd6;/.test(CSS) &&
  /static const wchar_t\* kBrandName = L"Meter Gomoku Trainer";/.test(HOST) &&
  /SetTextColor\(dc, RGB\(0x3d, 0x9b, 0xd6\)\);/.test(HOST) &&
  /TextOutW\(dc, tx, ty, kMeter, \(int\)mlen\);/.test(HOST) &&
  /TextOutW\(dc, tx \+ sm\.cx, ty, rest, \(int\)wcslen\(rest\)\);/.test(HOST));

// ---------------------------------------------------------- 评估曲线积分式填充（2026-09-21）
ok('★ 评估曲线面积 = 积分式单路径填充（贝塞尔 t 采样同形 + 一次 fill，无逐片接缝；' +
   '2026-09-25 填色改为「朝 0 分线等比收缩的曲形分层」，渐变 = 从曲线向 0 横坐标由深到浅）',
  /for \(var t2 = 0; t2 < 28; t2\+\+\) \{/.test(JS) &&
  // 三次贝塞尔 Bernstein 权重（t=0 起于 P1、t=1 止于 P2）—— 写反会让填充倒着走成锯齿
  /var w1 = v \* v \* v, w2 = 3 \* v \* v \* u, w3 = 3 \* v \* u \* u, w4 = u \* u \* u;/.test(JS) &&
  !/var w1 = u \* u \* u/.test(JS) &&
  /ctx\.moveTo\(flat\[0\]\.x, yz\);/.test(JS) &&
  /ctx\.lineTo\(flat\[flat\.length - 1\]\.x, yz\);/.test(JS) &&
  /ctx\.closePath\(\);[\s\S]{0,260}ctx\.fill\(\);/.test(JS) &&
  // 收缩分层：scaledY + AREA_LAYERS + 反向回程闭合成带
  /function scaledY\(q, s\) \{ return yz \+ \(q\.y - yz\) \* s; \}/.test(JS) &&
  /var AREA_LAYERS = 24, AREA_STEP = 0\.010;/.test(JS) &&
  /ctx\.lineTo\(flat\[f5\]\.x, scaledY\(flat\[f5\], sIn\)\);/.test(JS) &&
  /for \(var f = 0; f < flat\.length - 1; f\+\+\) \{\s*var q0 = flat\[f\]/.test(JS) === false);

// ---------------------------------------------------------- 算法层：时间利用率与关键局面加权（2026-09-25）
// 用户这一轮的要求原文：「继续优化**算法上的**，而不是性能上的，追求更极致的效率来使用这个
//   原生 rapfi 模型提升智力」—— 下面两条的共性是：**不改线程/哈希/模型**，只改「怎么用」。
// ① Rapfi 自带按局面重要度分配时间的机制（timecontrol.cpp），但它只在 ampleMatchTime==false
//    时生效；我们每手都发 TIMEOUT_MATCH 600 秒 ⇒ 恒为 true ⇒ 那套自适应从来没启用过。
//    于是「把用户给的时间用满」就是这里唯一有效的旋钮，而它由 advanced_stop_ratio 决定：
//    optimum = (turnTime − 30) × ratio。官方 / 源码默认都是 **0.9**，0.75 = 白扔 25%。
ok('★ 引擎时间利用率 = 官方 advanced_stop_ratio 0.9（0.75 会白扔 25% 思考时间）',
  /^advanced_stop_ratio = 0\.9$/m.test(CFG_TOML) && !/advanced_stop_ratio = 0\.75/.test(CFG_TOML));
// ② 既然引擎那套自适应用不上，就在应用层把「重要度加权」补回来（见 aiTurnBudget 的长注释）。
//    判据用现成的威胁检测，只增不减、封顶 1.6× —— 用户设的思考时间仍是基准值。
ok('★ AI 落子时间 = 关键局面加权（aiTurnBudget：被叫杀 ×1.5 / 活三必应 ×1.25 / 我方收官 ×0.8）',
  /function aiTurnBudget\(\) \{/.test(JS) &&
  /if \(winPoints\(G\.board, op, rule\)\.length\) return Math\.round\(base \* 1\.5\);/.test(JS) &&
  /if \(openFourPoints\(G\.board, op, rule\)\.length\) return Math\.round\(base \* 1\.25\);/.test(JS) &&
  /return Math\.round\(base \* 0\.8\);/.test(JS) &&
  // 两个 AI 落子入口都要走它（aiMove 与「辅助一手」）—— 只改一处就会半边失灵
  // ★ 三十三轮：入口改走 analyzeVote（多引擎票箱）；单引擎档由 ensTopN(1) 退回 topN=1 老口径。
  JS.indexOf('var r = await analyzeVote(aiTurnBudget(), 1, curColor(), warm, null, T(\'tagAiMove\'));') > 0 &&
  (JS.match(/await analyzeVote\(aiTurnBudget\(\), 1, curColor\(\)/g) || []).length === 2 &&
  // ★ 关键：**有增有减、均值守恒** —— 绝不能出现「只增」。fourPoints()（对手有三）中局几乎
  //   每手都非空，拿它当加成条件会退化成全局 ×1.35，那是偷偷调大用户设置，不是变强。
  !/fourPoints\(G\.board, op, rule\)\.length\) k = /.test(JS) &&
  !/var k = 1;/.test(JS.slice(JS.indexOf('function aiTurnBudget()'), JS.indexOf('function heatBudget()'))));

// ---------------------------------------------------------- 关于窗「最近更新」（2026-09-21 晚）
ok('★ 「关于」窗加「最近更新」段（用户要求）：中英词条 + renderAbout 渲染在**最后**一节',
  /aboutUpdates: '最近更新',/.test(JS) &&
  /aboutUpdateList: \[/.test(JS) &&
  /aboutUpdates: 'Recent updates',/.test(JS) &&
  /h \+= '<div class="ab-h2">' \+ escHtml\(T\('aboutUpdates'\)\) \+ '<\/div><ul class="ab-ul ab-news">';/.test(JS) &&
  // ★ 十六轮（用户要求）：顺序 = 使用方法 → 功能 → 开源组件 → 许可 → 最近更新
  JS.indexOf("aboutGuide')") < JS.indexOf("aboutFeat')") &&
  JS.indexOf("aboutFeat')") < JS.indexOf("aboutOss')") &&
  JS.indexOf("aboutLic')") < JS.indexOf("aboutUpdates')"));
ok('★ 十六轮「关于」：使用方法最详细（含残局一节）+ 开源组件/许可改正 + 更新只留主要功能',
  /aboutTip: '版本、使用方法、功能与开源许可',/.test(JS) &&
  /aboutTip: 'Version, how to use, features and open-source licences',/.test(JS) &&
  /\{ t: '二、残局模式（自己摆一个局面来研究）', ps: \[/.test(JS) &&
  /\{ t: '2\. Endgame mode \(set up a position and study it\)', ps: \[/.test(JS) &&
  /\{ t: '三、计算评估', ps: \[/.test(JS) && /\{ t: '七、规则与外观', ps: \[/.test(JS) &&
  /aboutOssNote: '说明：上表只列随本软件分发/.test(JS) &&
  /aboutOssNote: 'Note: the table lists only third-party components/.test(JS) &&
  // ★ 不再出现的错误条目：NumPy / Pillow / 思源黑体 / Electron（都不随本软件分发或已废弃）
  !/\['NumPy'/.test(JS) && !/\['Pillow'/.test(JS) &&
  !/Source Han Sans/.test(JS) && !/Electron \/ electron-builder/.test(JS) &&
  /\['Rapfi', '五子棋 \/ 连珠引擎内核（编译为 WebAssembly，随本软件分发）', 'GPL-3\.0'\]/.test(JS) &&
  /\['OpenCV', '棋盘与棋子识别（静态链入 GomokuVision\.exe，不额外分发 DLL）', 'Apache-2\.0'\]/.test(JS) &&
  /aboutLicText: '本软件自身的界面与配套代码以 MIT 许可发布[\s\S]*?dhbloo\/rapfi/.test(JS) &&
  // ★ 更新日志只留主要功能：旧的琐碎条目（水印、天蓝圆点之类）不再出现
  !/识图窗全面改版：图片抽屉、水印/.test(JS) && !/最后落点标记焕新/.test(JS) &&
  !/截图框适配英文模式/.test(JS) && !/识别预防针：细网线峰位亚像素细化/.test(JS));

// ============================================================ B. 真实 Edge
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const SHELL_JS = `
<script>
(function () {
  window.__errs = [];
  window.__msgs = [];
  window.onerror = function (m, s, l) { window.__errs.push(String(m) + ' @' + l); return true; };
  window.chrome = {
    webview: {
      addEventListener: function (t, fn) { window.__handler = fn; },
      // ★ 页面发的是**对象**（tellHost({type:'openReview'…})），必须序列化后再存 ——
      //   老版本 String(s) 会把每条消息都压成 "[object Object]"，于是「有没有发出 openReview」
      //   这类断言永远查不出来（假绿）。字符串就原样存，保持老断言（'paste' 等）不变。
      postMessage: function (s) { window.__msgs.push(typeof s === 'string' ? s : JSON.stringify(s)); },
    },
  };
  window.fetch = function () { return Promise.reject(new Error('stub: no engine in test')); };
  // ★ 页面内 AI 测试钩子：calc.js 的 LocalAI 看到它就不建 Worker、analyze 直接按离线拒绝
  //   （等价旧「fetch 一律 reject」的语义；测试壳里也绝不去加载 40MB 模型）。
  window.__GB_TEST__ = true;
})();
</script>
`;

const TEST_JS = `
<script>
(function () {
  var out = [];
  function P(l, v) { out.push('PASS | ' + l + ' | ' + v); }
  function F(l, v) { out.push('FAIL | ' + l + ' | ' + v); }
  function finish() {
    var pre = document.createElement('pre');
    pre.id = '__test_out';
    var B = '<<' + 'GBRES' + '>>', E = '<<' + 'GBEND' + '>>';
    pre.textContent = '\\n' + B + '\\n' + out.join('\\n') + '\\n' + E + '\\n';
    document.body.appendChild(pre);
  }
  function px(cv, x, y) {
    var c = cv.getContext('2d');
    var d = c.getImageData(x, y, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(function (v) {
      return ('0' + v.toString(16)).slice(-2);
    }).join('');
  }
  // ★ 取「两个交叉点正中间」的像素：棋盘中心正好是天元星位（会被画成一个黑点），
  //   直接取中心读到的是星位色而不是棋盘底色 —— 测试会误报。
  function boardPx(cv) {
    var dpr = window.devicePixelRatio || 1;
    var size = cv.width / dpr;
    var pad = Math.max(12, size * 0.045);
    var gap = (size - pad * 2) / 14;
    return px(cv, Math.round((pad + gap * 1.5) * dpr), Math.round((pad + gap * 1.5) * dpr));
  }
  function done() {
    if (window.__errs && window.__errs.length) F('页面无 JS 异常', window.__errs.join(' ; '));
    else P('页面无 JS 异常', '0 条');

    var cv = document.getElementById('board');
    if (!cv) { F('棋盘 canvas 存在', 'not found'); finish(); return; }
    P('棋盘 canvas 存在', 'true');
    P('棋盘已按容器铺开', cv.style.width + ' x ' + cv.style.height);
    if (cv.width > 100 && cv.height > 100) P('棋盘尺寸合理（>100px）', cv.width + 'px');
    else F('棋盘尺寸合理（>100px）', cv.width + 'px');

    // ★ 2026-09-20（用户要求）：「默认用大多正规的五子棋棋盘，类似与牛皮纸暗舒适护眼黄色」
    //   +「深色、浅色都用一种棋盘颜色」⇒ 两套主题的棋盘底像素必须**同一个值**（下面深色段再取
    //   一次，两次数值相同才算过）；白子同时改成偏灰的象牙白（不再刺眼）。
    var lightPx = boardPx(cv);
    P('棋盘底色取样（浅色主题）', lightPx);
    if (lightPx === '#d9b878') P('★ 棋盘底色 = 护眼牛皮纸黄 #d9b878', lightPx);
    else F('★ 棋盘底色 = 护眼牛皮纸黄 #d9b878', lightPx);

    // 中英
    var t0 = document.getElementById('t_title').textContent;
    document.getElementById('btn_lang').click();
    var t1 = document.getElementById('t_title').textContent;
    if (t1 === 'Gomoku Trainer' && t0 !== t1) P('中英切换生效（软件名 五子棋练习器 / Gomoku Trainer）', t0 + ' → ' + t1);
    else F('中英切换生效（软件名 五子棋练习器 / Gomoku Trainer）', t0 + ' → ' + t1);
    document.getElementById('btn_lang').click();

    // 顶栏副标题应当已被删除（用户要求：不要再出现「人机对战 · 分析 · 复盘 · 历史台」）
    var subEl = document.getElementById('t_sub');
    if (!subEl) P('顶栏副标题已移除（不再有「人机对战 · 分析 · 复盘 · 历史台」）', 'no #t_sub');
    else F('顶栏副标题已移除（不再有「人机对战 · 分析 · 复盘 · 历史台」）', subEl.textContent);
    var i18n = window.I18N || {};
    var subZh = (i18n.zh || {}).sub, subEn = (i18n.en || {}).sub;
    if (subZh === undefined && subEn === undefined) P('文案表里已无 sub 副标题键', 'ok');
    else F('文案表里已无 sub 副标题键', subZh + ' / ' + subEn);

    // 「自由摆盘」不应再带「（AI 不参与）」
    var mpZh = (i18n.zh || {}).modePlace, mpEn = (i18n.en || {}).modePlace;
    if (mpZh === '自由摆盘' && mpEn === 'Free placement')
      P('「自由摆盘」已去掉「（AI 不参与）」', mpZh + ' / ' + mpEn);
    else F('「自由摆盘」已去掉「（AI 不参与）」', mpZh + ' / ' + mpEn);
    if (!/不参与|no AI/i.test(String(mpZh) + ' ' + String(mpEn))) P('文案里已无「AI 不参与」字样', 'ok');
    else F('文案里已无「AI 不参与」字样', mpZh + ' / ' + mpEn);

    // 深浅
    // ★ 2026-09-20（用户要求）：「把之前的深色改成颜色，点击颜色后会有一个弹窗，里面有深色和
    //   浅色主题这两个按键，还有一个调色盘，细微调色调（模仿 Photoshop），以及 RGB 输入框、
    //   滑动条，还有 RGB 代码输入框，选择棋盘的颜色以及背景的颜色进行自定义调色并持久化」。
    var btnColor = document.getElementById('btn_color');
    if (btnColor && btnColor.textContent === '颜色' && !document.getElementById('btn_theme'))
      P('★ 顶栏「深色」两态键 → 一颗「颜色」键（旧的 btn_theme 已不存在）', btnColor.textContent);
    else F('★ 顶栏「深色」两态键 → 一颗「颜色」键（旧的 btn_theme 已不存在）',
      (btnColor ? btnColor.textContent : 'no btn_color') + ' / 旧键=' + !!document.getElementById('btn_theme'));

    var pop = document.getElementById('colorPop');
    if (pop && pop.hidden) P('调色窗默认收着（不会一启动就弹出来）', 'hidden');
    else F('调色窗默认收着（不会一启动就弹出来）', pop ? String(pop.hidden) : 'missing');
    btnColor.click();
    var popOpen = pop && !pop.hidden;
    var ps = document.getElementById('cp_theme').querySelectorAll('button');
    var ptg = document.getElementById('cp_target').querySelectorAll('button');
    if (popOpen && ps.length === 3 && ptg.length === 2 &&
        ps[0].textContent === '浅色' && ps[1].textContent === '深色' && ps[2].textContent === '自定义' &&
        ptg[0].textContent === '棋盘' && ptg[1].textContent === '背景')
      P('★ 调色窗：浅色/深色/自定义 三个主题键 + 棋盘/背景 两个调色对象',
        ps[0].textContent + '/' + ps[1].textContent + '/' + ps[2].textContent +
        ' · ' + ptg[0].textContent + '/' + ptg[1].textContent);
    else F('★ 调色窗：主题三键 + 调色对象两键',
      'open=' + popOpen + ' n=' + ps.length + '/' + ptg.length +
      ' t=' + (ps[0] ? ps[0].textContent : '?') + '/' + (ps[1] ? ps[1].textContent : '?'));
    var svC = document.getElementById('cp_sv'), hueC = document.getElementById('cp_hue');
    var sliders = ['cp_r', 'cp_g', 'cp_b'].map(function (id) { return document.getElementById(id); });
    var boxes = ['cp_rn', 'cp_gn', 'cp_bn'].map(function (id) { return document.getElementById(id); });
    // ★ 2026-09-21（用户要求）：「RGB 只保留输入框，取消滑动条」→ 三条 range 必须**不存在**。
    if (svC && hueC && svC.width > 40 && hueC.width > 40 &&
        sliders.every(function (s) { return !s; }) &&
        boxes.every(function (s) { return s && s.type === 'number'; }) && document.getElementById('cp_hex'))
      P('★ 取色盘（饱和/明度方块 + 色相条）+ RGB 三个数字输入框 + RGB 代码框齐了（滑条已取消）',
        svC.width + 'x' + svC.height + ' / ' + hueC.width + 'x' + hueC.height);
    else F('★ 取色盘 + RGB 数字框 + 代码框（滑条应已取消）',
      'sv=' + !!svC + ' hue=' + !!hueC + ' ranges=' + sliders.filter(Boolean).length +
      ' nums=' + boxes.filter(Boolean).length + ' hex=' + !!document.getElementById('cp_hex'));
    var presets = document.getElementById('cp_presets').querySelectorAll('button');
    if (presets.length >= 4 && presets[0].style.background)
      P('★ 调色窗里有一排预制色块（用颜色方块表示）', presets.length + ' 块');
    else F('★ 调色窗里有一排预制色块', presets.length + ' 块');

    // 深浅主题切换（现在在弹窗里）：棋盘底色必须**一点没变**（用户要求「深浅都用一种棋盘颜色」）
    ps[1].click();
    var th = document.body.getAttribute('data-theme');
    var darkPx = boardPx(cv);
    if (th === 'dark' && darkPx === lightPx)
      P('★ 切到深色主题后棋盘底色**一模一样**（深浅共用一种棋盘色）', darkPx);
    else F('★ 切到深色主题后棋盘底色一模一样', th + ' ' + darkPx + ' vs 浅色 ' + lightPx);
    ps[0].click();
    if (document.body.getAttribute('data-theme') === 'light') P('浅色键点回去 → 主题回到浅色', 'light');
    else F('浅色键点回去 → 主题回到浅色', document.body.getAttribute('data-theme'));

    // 预制色块：点一下 → 棋盘立刻换色 + 落盘持久化（boardColor + 派生出来的整套 cssVars）
    var pick = presets[4].getAttribute('data-c');
    presets[4].click();
    var pxPick = boardPx(cv);
    var st1 = {};
    try { st1 = JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}') || {}; } catch (e) {}
    if (pxPick === pick && st1.boardColor === pick && st1.cssVars && st1.cssVars['--board'] === pick)
      P('★ 点预制色块 → 棋盘立刻换色并持久化（boardColor + 派生 cssVars）', pick + ' → ' + pxPick);
    else F('★ 点预制色块 → 棋盘立刻换色并持久化',
      'px=' + pxPick + ' boardColor=' + st1.boardColor + ' vars=' + (st1.cssVars ? st1.cssVars['--board'] : 'none'));

    // ★ 2026-09-20（用户反馈）修复实测：「调色盘与调色条没有办法选中和移动」——
    //   cpLive 原来只刷 RGB 框、**从不重画两块 canvas**：CP 明明在变，定位圈/游标纹丝不动。
    //   模拟「在盘上 0.9/0.1 处按下」：CP 要跟到手指位置、画布像素要真的变（圈重画了）。
    (function () {
      if (!svC) return;
      var c0 = svC.getContext('2d').getImageData(0, 0, svC.width, svC.height).data.slice();
      var keep = { h: CP.h, s: CP.s, v: CP.v };
      var r0 = svC.getBoundingClientRect();
      svC.dispatchEvent(new MouseEvent('mousedown',
        { clientX: r0.left + r0.width * 0.9, clientY: r0.top + r0.height * 0.1, bubbles: true }));
      var sel = CP.s > 0.8 && CP.v > 0.8;
      var c1 = svC.getContext('2d').getImageData(0, 0, svC.width, svC.height).data;
      var dd = 0; for (var i5 = 0; i5 < c0.length; i5 += 4) if (c0[i5] !== c1[i5]) dd++;
      if (sel && dd > 40)
        P('★ 调色盘按下即选中 + 光标圈跟着重画（cpLive 现在会重绘 canvas）',
          's=' + CP.s.toFixed(2) + ' v=' + CP.v.toFixed(2) + ' diff=' + dd);
      else F('★ 调色盘按下即选中 + 光标圈跟着重画',
          's=' + (CP.s || 0).toFixed(2) + ' v=' + (CP.v || 0).toFixed(2) + ' diff=' + dd);
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      // 还原（保持后续主题/RGB 断言的口径干净）：CP 回原值 + 重新落盘原色
      CP.h = keep.h; CP.s = keep.s; CP.v = keep.v; cpCommit();
    })();

    // RGB 数字框：R 改成 0 → 棋盘底色跟着变（输入框真的接到棋盘上了）
    var before = boardPx(cv);
    boxes[0].value = '0';
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    var after = boardPx(cv);
    if (after !== before) P('★ RGB 输入框真的接到棋盘上（改 R → 底色立刻变）', before + ' → ' + after);
    else F('★ RGB 输入框真的接到棋盘上', before + ' → ' + after);
    // ★ 2026-09-21：一动色 → 主题档位自动顶到「自定义」，且那颗键亮起来
    var cbtn = document.querySelector('#cp_theme button[data-th="custom"]');
    if (S.theme === 'custom' && cbtn && cbtn.classList.contains('on'))
      P('★ 改变颜色 → 自动切到「自定义」档（按键同步点亮）', S.theme);
    else F('★ 改变颜色 → 自动切到「自定义」档',
      'theme=' + S.theme + ' on=' + (cbtn ? cbtn.classList.contains('on') : 'no btn'));

    // RGB 代码框：直接敲 #rrggbb
    var hexIn = document.getElementById('cp_hex');
    hexIn.value = '#c3cbb4';
    hexIn.dispatchEvent(new Event('change', { bubbles: true }));
    if (boardPx(cv) === '#c3cbb4') P('★ RGB 代码框：敲 #rrggbb 立刻生效', boardPx(cv));
    else F('★ RGB 代码框：敲 #rrggbb 立刻生效', boardPx(cv));

    // 调色对象 = 背景：只动页面底色，棋盘色纹丝不动
    var boardBefore = boardPx(cv);
    ptg[1].click();                      // 切到「背景」
    presets[3].click();
    var bgNow = getComputedStyle(document.body).backgroundColor;
    // ★ 注意：本段在**模板字符串**里，正则的 \\s 必须写成 双反斜杠 s ——
    //   单反斜杠会被模板字符串当转义吃掉，正则变成 /195,s*203,s*180/ 永远匹配不上（假红）。
    if (boardPx(cv) === boardBefore && /195,\\s*203,\\s*180/.test(bgNow))
      P('★ 调色对象切到「背景」：只改页面底色，棋盘色纹丝不动', bgNow);
    else F('★ 调色对象切到「背景」：只改页面底色，棋盘色纹丝不动',
      bgNow + ' board=' + boardPx(cv) + '/' + boardBefore);
    ptg[0].click();                      // 调回「棋盘」

    // ★ 2026-09-20 三轮（用户反馈）：自定义过颜色后点「深色」→ **整个恢复默认深色**
    //   （棋盘回牛皮纸黄、boardColor 清空 —— 只有「自定义」档保留手调色）
    ps[1].click();
    var st3 = {};
    try { st3 = JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}') || {}; } catch (e) {}
    if (document.body.getAttribute('data-theme') === 'dark' && st3.boardColor === '' &&
        boardPx(cv) === '#d9b878')
      P('★ 自定义色后点「深色」→ 恢复默认深色（棋盘回牛皮纸黄、boardColor 清空）', boardPx(cv));
    else F('★ 自定义色后点「深色」→ 恢复默认深色',
      'th=' + document.body.getAttribute('data-theme') + ' px=' + boardPx(cv) +
      ' bg=' + JSON.stringify(st3.boardColor));
    ps[0].click();                      // 回浅色（后面「恢复默认」段的口径）

    // 「恢复默认」+「关闭」：棋盘回到护眼黄、持久化字段清干净、弹窗收起
    document.getElementById('cp_reset').click();
    document.getElementById('cp_close').click();
    var st2 = {};
    try { st2 = JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}') || {}; } catch (e) {}
    if (boardPx(cv) === '#d9b878' && st2.boardColor === '' && !st2.cssVars && pop.hidden)
      P('★ 「恢复默认」还原棋盘与背景并清掉持久化字段；「关闭」收起弹窗', boardPx(cv));
    else F('★ 「恢复默认」还原棋盘与背景并清掉持久化字段',
      boardPx(cv) + ' boardColor=' + JSON.stringify(st2.boardColor) +
      ' vars=' + !!st2.cssVars + ' hidden=' + pop.hidden);

    // 外部存档（模拟识别器 push）
    var rec = { src: 'desktop', ts: Date.now(), rule: 0,
                moves: [[7,7,1],[8,8,2],[7,8,1],[8,7,2]] };
    if (typeof window.__handler === 'function') {
      window.__handler({ data: { type: 'historyInbox', text: JSON.stringify(rec) } });
    }
    // 历史列表已从右侧卡片搬进「历史抽屉」#drList（ingestExternal 会直接渲染它）
    var items = document.querySelectorAll('#drList .item');
    if (items.length >= 1) P('外部存档入库并渲染', items.length + ' 条');
    else F('外部存档入库并渲染', '0 条');

    // 底部按键：整行居中、暂停图标键在正中间。
    // ★ 2026-09-25（用户要求）：‹ › 收进 .bgroup 导航组、↻/⇄/✥ 收进 .bgroup 布局组 ——
    //   断言改为「所有按键（含组内）的中线顺序」：prev/next 仍在最左、pause 仍居中、
    //   布局三键收尾；组框 span 不计入。
    var row = document.getElementById('boardBtns');
    var ids = [];
    [].forEach.call(row.querySelectorAll('button'), function (b) { if (b.id) ids.push(b.id); });
    var mids = ids;
    if (mids.join(',') === 'btn_prev,btn_next,btn_reset,btn_pause,btn_save,btn_rot,btn_mirror,btn_shift')
      P('底部按键顺序 = ‹ ›（组）/ 重新开始 / 暂停 / 保存局面（暂停居中）/ ↻ ⇄ ✥（组）', mids.join(','));
    else F('底部按键顺序 = ‹ ›（组）/ 重新开始 / 暂停 / 保存局面（暂停居中）/ ↻ ⇄ ✥（组）', mids.join(','));
    var jc = getComputedStyle(row).justifyContent;
    if (jc === 'center') P('底部按键整行居中对齐', jc);
    else F('底部按键整行居中对齐', jc);

    // ★ 2026-09-18 八轮（用户要求）：每侧只有一列 + 两列等高 + 下拉按内容宽
    var dl = document.getElementById('dockL'), dr = document.getElementById('dockR');
    if (getComputedStyle(dl).display !== 'grid' && getComputedStyle(dr).display !== 'grid' &&
        !dl.classList.contains('two') && !dr.classList.contains('two'))
      P('停靠栏每侧只有一列（不用栏内双列网格）', getComputedStyle(dr).display);
    else F('停靠栏每侧只有一列（不用栏内双列网格）',
      'L=' + getComputedStyle(dl).display + ' R=' + getComputedStyle(dr).display);
    // ★ 2026-09-20（用户要求）：「在棋盘的右面添加一个卡片这个功能键，点击之后会有几个选项，
    //   分别是显示的窗口：引擎仪表盘，评估曲线，计算评估」+「默认显示对局设置和计算评估的视图，
    //   初始都放到棋盘右边」。
    var rr = function (el) { return el.getBoundingClientRect(); };
    var setupCard = document.querySelector('.card[data-id="setup"]');
    var anaCard = document.querySelector('.card[data-id="analysis"]');
    var enCard = document.querySelector('.card[data-id="engine"]');
    // ★ 2026-09-27（用户要求）：引擎仪表盘默认显示（评估曲线已并入本卡）；
    //   对局设置 / 计算评估默认收起 —— 棋盘下的「设置」弹窗里开。
    if (enCard && !enCard.hidden && setupCard && setupCard.hidden && anaCard && anaCard.hidden)
      P('★ 默认只显示引擎仪表盘（对局设置/计算评估收起，曲线已并入）', 'engine on');
    else F('★ 默认只显示引擎仪表盘（对局设置/计算评估收起）',
      'engine=' + (enCard ? enCard.hidden : 'missing') +
      ' setup=' + (setupCard ? setupCard.hidden : 'missing') +
      ' ana=' + (anaCard ? anaCard.hidden : 'missing'));

    var btnSet = document.getElementById('btn_set'), setPop = document.getElementById('setPop');
    if (btnSet && setPop && setPop.hidden)
      P('「设置」键在底栏右段，弹窗默认收着', 'hidden');
    else F('「设置」键 + 弹窗默认收着', 'pop=' + (setPop ? setPop.hidden : 'missing'));
    if (btnSet) btnSet.click();
    var sb = setPop ? [].slice.call(setPop.querySelectorAll('button[data-card]')) : [];
    var sbIds = sb.map(function (b) { return b.getAttribute('data-card'); });
    // ★ 2026-09-28（用户要求）：引擎仪表盘置首（最左）→ 三键顺序 = 引擎 / 对局设置 / 计算评估
    if (setPop && !setPop.hidden && sbIds.join(',') === 'engine,setup,analysis')
      P('★ 点「设置」弹出三键：引擎仪表盘 / 对局设置 / 计算评估（引擎置首）', sbIds.join(','));
    else F('★ 点「设置」弹出三键', 'open=' + (setPop && !setPop.hidden) + ' ids=' + sbIds.join(','));
    // ★ 按 data-card 名字取键，不依赖 DOM 顺序（顺序一调整，下标取值就会悄悄错位）。
    //   ★★ 千万别叫 cbtn —— 上面「主题」那一段已经用 var cbtn 存了一个 DOM 元素，
    //      同名函数声明会被那次赋值覆盖掉，调用时直接 TypeError: cbtn is not a function。
    //      （本段是注入字符串，注释里不要用反引号，会提前截断字符串。）
    function cardBtn(id) { return setPop ? setPop.querySelector('button[data-card="' + id + '"]') : null; }
    var bSetup = cardBtn('setup'), bAna = cardBtn('analysis');
    // 互斥：未固定时，对局设置 / 计算评估一次只显示一个（用户：点击对局设置则计算评估消失）
    if (bSetup) bSetup.click();
    if (setupCard && !setupCard.hidden)
      P('★ 设置里点「对局设置」→ 卡片显示', 'visible');
    else F('★ 设置里点「对局设置」→ 卡片显示', 'setup.hidden=' + (setupCard ? setupCard.hidden : 'missing'));
    if (bAna) bAna.click();
    if (setupCard && setupCard.hidden && anaCard && !anaCard.hidden)
      P('★ 再点「计算评估」→ 对局设置被互斥收起', 'switched');
    else F('★ 再点「计算评估」→ 对局设置收起', 'setup=' + (setupCard && setupCard.hidden) + ' ana=' + (anaCard && anaCard.hidden));
    // ★ 2026-09-28（用户要求）：**恢复两态固定** —— 未固定时键上写「固定」，点一下才固定
    //   （键变 ✕，之后不被互斥收起），再点 ✕ = 取消固定并关闭。引擎仪表盘默认就是固定态。
    var pinAna = anaCard ? anaCard.querySelector('.card-h .pinkey') : null;
    var pinEngine = enCard ? enCard.querySelector('.card-h .pinkey') : null;
    if (pinAna && pinAna.textContent.indexOf('固定') >= 0)
      P('★ 未固定时卡片右上角键显示「固定」（点击才固定，键随后变 ✕）', pinAna.textContent);
    else F('★ 未固定时键显示「固定」', 'pinAna=' + (pinAna ? pinAna.textContent : 'missing'));
    if (pinEngine && pinEngine.textContent.indexOf('\u2715') >= 0)
      P('★ 引擎仪表盘默认固定（键初始即为 ✕）', pinEngine.textContent);
    else F('★ 引擎仪表盘默认固定', 'pinEngine=' + (pinEngine ? pinEngine.textContent : 'missing'));
    // 固定：点「计算评估」右上角「固定」→ 键变 ✕
    if (pinAna) pinAna.click();
    if (pinAna && pinAna.textContent.indexOf('\u2715') >= 0)
      P('★ 点「固定」后该键变 ✕（已固定态）', pinAna.textContent);
    else F('★ 点「固定」后该键变 ✕', 'pinAna=' + (pinAna ? pinAna.textContent : 'missing'));
    // ★ 2026-09-28（用户要求，**反转旧口径**）：固定后两卡同时罗列，次序 = **选择次序** ——
    //   先选的「计算评估」在最上面，后选的「对局设置」排在本栏最后（谁先选择谁放到最前面）。
    if (bSetup) bSetup.click();
    var visCards = dr ? [].filter.call(dr.querySelectorAll('.card'), function (c) { return !c.hidden; }) : [];
    var orderStr = visCards.map(function (c) { return c.getAttribute('data-id'); }).join('>');
    if (anaCard && !anaCard.hidden && setupCard && !setupCard.hidden &&
        visCards[0] && visCards[0].getAttribute('data-id') === 'analysis' &&
        visCards[visCards.length - 1] && visCards[visCards.length - 1].getAttribute('data-id') === 'setup')
      P('★ 固定后两卡同时罗列，次序 = 选择次序（先选的在最上面，新卡排最后）', orderStr);
    else F('★ 固定后两卡同时罗列 + 次序=选择次序',
      'ana=' + (anaCard && anaCard.hidden) + ' setup=' + (setupCard && setupCard.hidden) +
      ' order=' + orderStr);
    // 固定键（此刻显示 ✕）→ 取消固定并关闭这张卡
    if (pinAna) pinAna.click();
    if (anaCard && anaCard.hidden)
      P('★ 固定键变「✕」后点击 = 取消固定并关闭卡片', 'closed');
    else F('★ 固定键 ✕ 关闭卡片', 'ana.hidden=' + (anaCard ? anaCard.hidden : 'missing'));
    // ★ 2026-09-28（用户要求）：关掉 = 连固定一起撤 → 再打开时键必须回到「固定」（两态不混乱）
    if (bAna) bAna.click();
    if (anaCard && !anaCard.hidden && pinAna && pinAna.textContent.indexOf('固定') >= 0)
      P('★ 关掉再打开：卡片回来且键回到「固定」（固定态已被撤）', pinAna.textContent);
    else F('★ 关掉再开回到未固定态',
      'ana.hidden=' + (anaCard && anaCard.hidden) + ' pin=' + (pinAna ? pinAna.textContent : 'missing'));
    if (bAna) bAna.click();   // 收回去，不干扰后面的断言
    if (setPop) setPop.hidden = true;
    // 量核心数/哈希前把「对局设置」卡打开（默认收起）
    if (setupCard && setupCard.hidden && btnSet && setPop) {
      btnSet.click(); if (bSetup) bSetup.click(); setPop.hidden = true;
    }

    // 评估曲线已并入引擎仪表盘：直接量画布高度（引擎卡默认显示，不用再先叫出来）
    (function () {
      var cvEl = document.getElementById('curve');
      var rootFs2 = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var wantH = Math.round(16 * rootFs2);
      var gotH = cvEl ? Math.round(cvEl.getBoundingClientRect().height) : -1;
      if (Math.abs(gotH - wantH) <= 2) P('★ 评估曲线画布锁在 16rem 舒适高度（已并入仪表盘卡）', gotH + ' / 期望 ' + wantH);
      else F('★ 评估曲线画布锁在 16rem 舒适高度（已并入仪表盘卡）', gotH + ' / 期望 ' + wantH);
    })();

    var sc = document.getElementById('sel_cores'), sh = document.getElementById('sel_hash');
    if (sc && sh && setupCard) {
      var cw = rr(setupCard).width;
      var sw = Math.max(rr(sc).width, rr(sh).width);
      if (rr(sc).top !== rr(sh).top) P('核心数 / 哈希表各占一行（不再并排挤成两行）', 'y=' + Math.round(rr(sc).top) + '/' + Math.round(rr(sh).top));
      else F('核心数 / 哈希表各占一行（不再并排挤成两行）', 'same row');
      if (sw < cw * 0.62) P('核心数/哈希表下拉按内容宽（不拉满整行）', Math.round(sw) + 'px / 卡宽 ' + Math.round(cw));
      else F('核心数/哈希表下拉按内容宽（不拉满整行）', Math.round(sw) + 'px / 卡宽 ' + Math.round(cw));
    }

    // ★ 2026-09-27：底部文字框已删 —— 改验底栏三段布局与居中。
    var foot = document.getElementById('boardFoot');
    var br = row.getBoundingClientRect();
    var fr = foot.getBoundingClientRect();
    // ★ 2026-09-28（用户要求，反转上一版）：底部文字框**恢复**，且最多两行
    var tp = document.getElementById('turnPill');
    var tpRow = document.getElementById('turnPillRow');
    var tpClamp = tp ? getComputedStyle(tp).webkitLineClamp : '';
    if (tp && tpRow && tpRow.closest('.card[data-id="engine"]') && tpClamp === '2')
      P('★ 引擎仪表盘下方文字框恢复（在 engine 卡内 + 最多两行 clamp=2）', 'restored');
    else F('★ 文字框恢复', 'pill=' + !!tp + ' row=' + !!tpRow +
      ' inEngineCard=' + !!(tpRow && tpRow.closest('.card[data-id="engine"]')) + ' clamp=' + tpClamp);
    if (!document.getElementById('calcPill'))
      P('★ 标题后「空闲/计算中」小胶囊已删除', 'removed');
    else F('★ 小胶囊已删除', 'still there');
    var bfL = document.querySelector('#boardFoot .bf-l'), bfR = document.querySelector('#boardFoot .bf-r');
    var liveBtn = document.getElementById('btn_live'), aiBtn = document.getElementById('btn_aiside'), setBtn = document.getElementById('btn_set');
    if (bfL && bfR && liveBtn && aiBtn && setBtn &&
        rr(bfL).right <= br.left + 2 && rr(bfR).left >= br.right - 2)
      P('★ 底栏三段布局：分析计算在左、AI 执子/设置在右、对局按键居中', 'ok');
    else F('★ 底栏三段布局',
      'L.right=' + (bfL ? Math.round(rr(bfL).right) : 'x') + ' mid=' + Math.round(br.left) + '..' + Math.round(br.right) +
      ' R.left=' + (bfR ? Math.round(rr(bfR).left) : 'x'));
    // ★ 2026-09-28（用户要求「堆叠就换行」）：居中判据从「中段自己居中」改成
    //   「**整条内容**（左段左缘 … 右段的右缘）在底栏里居中」——因为左右两段现在不再等宽
    //   （左段一个键、右段两个键），硬按中段对齐反而会把整体推偏。
    var groupMid = (rr(bfL).left + rr(bfR).right) / 2, midFoot = (fr.left + fr.right) / 2;
    if (Math.abs(groupMid - midFoot) <= 4)
      P('★ 底栏整条内容居中（左段左缘…右段右缘 与底栏中线对齐）', 'Δ=' + Math.round(groupMid - midFoot));
    else F('★ 底栏整条内容居中', 'Δ=' + Math.round(groupMid - midFoot));
    // ★ 2026-09-28（用户要求）：窄窗口「堆叠」= 键被压扁 / 互相压住。这里直接量三件事：
    //   ① 底栏本身与中段都不横向溢出（scrollWidth ≤ clientWidth + 1）；
    //   ② 没有哪颗键比自己的容器还宽（被裁掉）；
    //   ③ ‹ › 比邻键**高一点**（用户要的「按钮稍微高一点，符号就会大一点」）。
    var overflowFoot = foot.scrollWidth - foot.clientWidth, overflowBtns = row.scrollWidth - row.clientWidth;
    var clipped = 0;
    [foot, row].forEach(function (host) {          // row = #boardBtns（不是 br，br 是它的 rect）
      if (!host || !host.children) return;
      Array.prototype.forEach.call(host.children, function (c) {
        if (c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1) clipped++;
      });
    });
    if (overflowFoot <= 1 && overflowBtns <= 1 && clipped === 0)
      P('★ 底栏不堆叠：无横向溢出、没有键被容器裁掉', 'of=' + overflowFoot + '/' + overflowBtns + ' clipped=' + clipped);
    else F('★ 底栏不堆叠', 'of=' + overflowFoot + '/' + overflowBtns + ' clipped=' + clipped);
    var hPrev = rr(document.getElementById('btn_prev')).height;
    var hReset = rr(document.getElementById('btn_reset')).height;
    if (hPrev > hReset + 2 && hPrev < hReset * 1.8)
      P('★ ‹ › 按键比邻键高一点（符号随之大一号但不夸张）',
        Math.round(hPrev) + ' vs ' + Math.round(hReset) + ' (' + (hPrev / hReset).toFixed(2) + '×)');
    else F('★ ‹ › 按键比邻键高一点', Math.round(hPrev) + ' vs ' + Math.round(hReset));
    if (getComputedStyle(foot).flexWrap === 'wrap' && getComputedStyle(row).flexWrap === 'wrap')
      P('★ 底栏与按键组都允许换行（窄窗口堆叠时整颗键挪到下一行）', 'wrap/wrap');
    else F('★ 底栏允许换行', getComputedStyle(foot).flexWrap + '/' + getComputedStyle(row).flexWrap);

    // ★ 复盘键整组在主窗口里不显示 —— 它们只属于复盘窗口（?rv=1）
    if (getComputedStyle(document.getElementById('rvBar')).display === 'none')
      P('主窗口里复盘键整组不显示（#rvBar 只在复盘窗口出现）', 'none');
    else F('主窗口里复盘键整组不显示（#rvBar 只在复盘窗口出现）',
      getComputedStyle(document.getElementById('rvBar')).display);

    // ★ 2026-09-19（用户要求）：「思考时间」输入框要与「人机 / 黑（先手）」功能键**对齐**。
    //   量的是左右两条边（用户看到的就是这两条边），不是 CSS 里写了什么。
    //   分段键那一行也是 label(5.4rem) + 控件，所以两条边应当各差 ≤2px。
    //   ★ 又一轮（用户要求）：框长「变为原来的一半」→ 量的是**列**（.field / .numbox 的外层），
    //     列仍与分段键同位同宽；再单独量「框宽 ≈ 半列宽」（50% ± 容差）。
    // ★ 三十二轮：模式 / AI 执子 改成**标题一行 + 按键一行**的虚线组框后，那一列不再与
    //   turnRow 同起点（这正是用户要的「给按键让出横向空间」）。所以这里改量两件事：
    //     ① 组框内部：标题在下-按键在上的**两行**（且按键整行铺满 → 文字不被截短）；
    //     ② 思考时间那一列仍落在**标准控件列**上：左缘 = 标签列右缘 + gap（与「规则」下拉
    //        同一条竖线），右缘 = 整行右缘。
    var numEl = document.getElementById('num_turn');
    var boxWrap = numEl ? numEl.closest('.numbox') : null;
    var colEl = boxWrap ? boxWrap.parentNode : numEl;      // .field = 与 .seg 对齐的那一列
    var segMode = document.getElementById('seg_mode'), segSide = document.getElementById('seg_side');
    if (numEl && colEl && segMode) {
      var nrr = colEl.getBoundingClientRect();
      [['modeGrp', '#seg_mode button'], ['sideGrp', '#seg_side button']].forEach(function (pair) {
        var grp = document.getElementById(pair[0]);
        if (!grp) return;
        var gs = getComputedStyle(grp);
        var lbl = grp.querySelector('label'), seg0 = grp.querySelector('.seg');
        if (gs.borderTopStyle === 'dashed' && gs.borderLeftStyle === 'dashed')
          P('★ 「' + pair[0] + '」有虚线框', 'border=' + gs.borderTopStyle + ' ' + gs.borderTopWidth);
        else F('★ 「' + pair[0] + '」有虚线框', 'border=' + gs.borderTopStyle);
        if (!lbl || !seg0) { F('★ 「' + pair[0] + '」标题一行 / 按键一行', 'missing'); return; }
        var lr = lbl.getBoundingClientRect(), sr = seg0.getBoundingClientRect();
        if (Math.round(lr.bottom) <= Math.round(sr.top) + 1)
          P('★ 「' + pair[0] + '」标题独占一行、按键另起一行', 'lbl.bottom=' + Math.round(lr.bottom) + ' seg.top=' + Math.round(sr.top));
        else F('★ 「' + pair[0] + '」标题独占一行、按键另起一行', 'lbl.bottom=' + Math.round(lr.bottom) + ' seg.top=' + Math.round(sr.top));
        // 按键拿满这一行的宽度（比原来「让给标题 5.4rem」宽出一大截）→ 文字不再被截短
        var row0 = seg0.parentNode;
        if (sr.width >= row0.clientWidth - 2)
          P('★ 「' + pair[0] + '」按键铺满整行（文字有空间）', Math.round(sr.width) + ' / 行宽 ' + row0.clientWidth);
        else F('★ 「' + pair[0] + '」按键铺满整行（文字有空间）', Math.round(sr.width) + ' / 行宽 ' + row0.clientWidth);
        // 文字真的没被 ellipsis 截掉：scrollWidth 不许超过 clientWidth
        var btns = grp.querySelectorAll(pair[1]);
        var clipped = [];
        for (var i = 0; i < btns.length; i++) if (btns[i].scrollWidth > btns[i].clientWidth + 1) clipped.push(btns[i].textContent);
        if (!clipped.length) P('★ 「' + pair[0] + '」按键文字完整显示（无截断）', btns.length + ' 键');
        else F('★ 「' + pair[0] + '」按键文字完整显示（无截断）', clipped.join(','));
      });
      // 参照用「核心数」那一行（标签+控件的标准两列；下拉窄，不会换行错位的那一类）
      var turnRow = document.getElementById('turnRow'), selCores = document.getElementById('sel_cores');
      if (turnRow && selCores) {
        var rrr = turnRow.getBoundingClientRect(), srr2 = selCores.getBoundingClientRect();
        var dl2 = Math.round(nrr.left - srr2.left), dr2 = Math.round(nrr.right - rrr.right);
        if (Math.abs(dl2) <= 2 && Math.abs(dr2) <= 2)
          P('★ 思考时间输入框仍落在标准控件列（左起同「规则」、右抵行尾）', 'LΔ=' + dl2 + ' RΔ=' + dr2);
        else F('★ 思考时间输入框仍落在标准控件列（左起同「规则」、右抵行尾）', 'LΔ=' + dl2 + ' RΔ=' + dr2);
      }
      var dh = Math.round(nrr.height - segMode.getBoundingClientRect().height);
      if (Math.abs(dh) <= 2) P('★ 思考时间输入框与分段键高度齐平', 'Δh=' + dh);
      else F('★ 思考时间输入框与分段键高度齐平', 'Δh=' + dh);
      // ★ 框长 = 原来的一半：框宽应当 ≈ 这一列的 50%（用户原话「变为原来的一半」）
      var bwr = numEl.getBoundingClientRect().width, cwr = nrr.width;
      var ratio = cwr ? (bwr / cwr) : 0;
      if (ratio > 0.44 && ratio < 0.56)
        P('★ 思考时间输入框只占这一列的一半（框长减半）',
          '框=' + Math.round(bwr) + ' 列=' + Math.round(cwr) + ' 比例=' + ratio.toFixed(2));
      else F('★ 思考时间输入框只占这一列的一半（框长减半）',
        '框=' + Math.round(bwr) + ' 列=' + Math.round(cwr) + ' 比例=' + ratio.toFixed(2));
      // 单位是框内后缀：单位右缘必须落在**框**里（不能跑到列右边去）
      var unitEl = numEl.parentNode ? numEl.parentNode.querySelector('.unit') : null;
      if (unitEl) {
        var urr = unitEl.getBoundingClientRect();
        if (urr.right <= numEl.getBoundingClientRect().right + 1 && urr.left >= numEl.getBoundingClientRect().left)
          P('★ 单位「s」在框内（框内后缀，不占额外宽度）', 'unit.right=' + Math.round(urr.right));
        else F('★ 单位「s」在框内（框内后缀，不占额外宽度）',
          'unit=' + Math.round(urr.left) + '..' + Math.round(urr.right) +
          ' box=' + Math.round(numEl.getBoundingClientRect().left) + '..' + Math.round(numEl.getBoundingClientRect().right));
      }
      // 单位是「秒」：输入框的 value 应当是 2（秒，★09-27 默认 2 秒），不是 2000（毫秒）
      var tv = String(numEl.value);
      if (tv === '2') P('★ 思考时间框里的读数是秒（默认 2 = 2 秒，不是 2000）', 'value=' + tv);
      else F('★ 思考时间框里的读数是秒（默认 2 = 2 秒，不是 2000）', 'value=' + tv);
      // 0.2 ~ 300 秒的钳位真的生效（直接调 setTurn 的入口：改 value + 派发 change）
      var chk = function (inp, want) {
        numEl.value = inp;
        numEl.dispatchEvent(new Event('change', { bubbles: true }));
        return String(numEl.value) === want;
      };
      if (chk('400', '300') && chk('0.05', '0.2') && chk('2.375', '2.375'))
        P('★ 秒制范围 0.2 ~ 300 且最多三位小数（400→300 / 0.05→0.2 / 2.375 保留）',
          '300 / 0.2 / 2.375');
      else F('★ 秒制范围 0.2 ~ 300 且最多三位小数（400→300 / 0.05→0.2 / 2.375 保留）',
        'now=' + numEl.value);
      numEl.value = '5';
      numEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ★ 板块控制键（▲▼◀▶）已删掉，每张卡片只剩一根小横杠作拖动提示
    //   （2026-09-27 起是 3 张卡：对局设置 / 计算评估 / 引擎仪表盘 —— 曲线已并入仪表盘）
    var dbtnN = document.querySelectorAll('.dbtn').length;
    var dashN = document.querySelectorAll('.card-h .dash').length;
    if (dbtnN === 0 && dashN === 3)
      P('板块控制键已删除，每张卡片只剩一根小横杠', 'dash=' + dashN);
    else F('板块控制键已删除，每张卡片只剩一根小横杠', 'dbtn=' + dbtnN + ' dash=' + dashN);

    // 暂停键图标必须是 ▶ 或 ❚❚ 之一（状态驱动的来回切换）
    var pauseTxt = document.getElementById('btn_pause').textContent;
    if (pauseTxt === '▶' || pauseTxt === '❚❚') P('暂停键图标是 ▶/❚❚ 之一', pauseTxt);
    else F('暂停键图标是 ▶/❚❚ 之一', pauseTxt);

    // 取消拖动改尺寸：页面里不该再有 split / gripbar / grip
    if (!document.querySelector('.split, .gripbar, .grip')) P('页面里已无任何拉伸改尺寸句柄', 'true');
    else F('页面里已无任何拉伸改尺寸句柄', 'still there');

    // 整页不滚动（全屏适配、板块不向下延伸）
    var docOver = document.documentElement.scrollHeight - window.innerHeight;
    if (docOver <= 1) P('整页没有竖向溢出（无滑动条）', 'overflow=' + docOver);
    else F('整页没有竖向溢出（无滑动条）', 'overflow=' + docOver);

      // 局面代码实时镜像棋盘：自由摆盘连点两手 → 代码跟着变长
      (function () {
        var segs = document.querySelectorAll('#seg_mode button');
        if (segs.length < 2) return;
        segs[1].click();                                  // 自由摆盘：AI 不插手
        var inp = document.getElementById('inp_code');
        var r0 = cv.getBoundingClientRect();
        // 与 calc.js geom() 完全一致的换算，保证点中的正是 (i,j) 这个交叉点
        var ax0 = Math.max(14, r0.width * 0.055);
        var pad0 = ax0 + Math.max(4, r0.width * 0.012);
        var gap0 = (r0.width - pad0 * 2) / 14;
        function clickAt(i, j) {
          cv.dispatchEvent(new MouseEvent('click', {
            clientX: r0.left + pad0 + i * gap0, clientY: r0.top + pad0 + j * gap0, bubbles: true,
          }));
        }
        var before = inp.value;
        clickAt(2, 2); clickAt(3, 2);                     // 空盘区两连点 → c13 d13
        var code1 = inp.value;
        if (code1 === before + 'c13d13')
          P('局面代码实时跟随棋盘（新落两手立刻追加 c13d13）', code1);
        else F('局面代码实时跟随棋盘（新落两手立刻追加 c13d13）', JSON.stringify(code1));
        // 粘贴 → 自动载入：把代码塞进输入框后点「载入」，棋盘应当按该局面重排
        inp.value = 'a1b1a2b2a3b3a4b4a5';
        document.getElementById('btn_load').click();
        var code2 = inp.value;
        if (/^a1b1a2b2a3b3a4b4a5$/.test(code2))
          P('粘贴/载入局面代码生效（黑方连成五子的第 9 手读入即停）', code2);
        else F('粘贴/载入局面代码生效（黑方连成五子的第 9 手读入即停）', JSON.stringify(code2));
        segs[0].click();                                  // 回到人机
      })();

    // ★ 2026-09-19（用户要求）：复盘 = **独立窗口**。主窗口这边只剩「把活儿交给宿主」：
    //   点顶栏「复盘」→ 发一条 {type:'openReview', record:{…}} 给宿主；
    //   主窗口自己**一点都不能变**（棋盘、局面代码、历史、仪表盘全在原地）——
    //   用户抱怨的「还是会有连接的情况」就是老版本在这里把主窗口的棋盘换掉了。
    function boardSig() {
      var GG = window.G || {};
      return JSON.stringify(GG.board || null) + '#' + ((GG.moves || []).length) +
             '#' + (GG.review ? 'rv' : '-') + '#' + (GG.loaded ? 'L' : '-');
    }
    var msgsBase = window.__msgs.length;
    var sigBefore = boardSig();
    var codeBefore = document.getElementById('inp_code').value;
    var histN0 = document.querySelectorAll('#drList .item').length;
    document.getElementById('btn_review').click();
    var sent = window.__msgs.slice(msgsBase);
    var openMsg = sent.filter(function (s) { return /"openReview"/.test(s); })[0] || '';
    if (openMsg) P('★ 点顶栏「复盘」把活儿交给宿主（发 openReview；真开窗由宿主做）', openMsg.slice(0, 96));
    else F('★ 点顶栏「复盘」把活儿交给宿主（发 openReview；真开窗由宿主做）',
           (sent.join(' | ') || '(没发任何消息)').slice(0, 140));
    if (/"moves":\\[\\[/.test(openMsg))
      P('从当前棋盘开复盘会带上当前这几手（复盘窗据此背诵/回顾）', openMsg.slice(0, 96));
    else F('从当前棋盘开复盘会带上当前这几手（复盘窗据此背诵/回顾）',
           openMsg ? openMsg.slice(0, 120) : 'no moves');
    if (boardSig() === sigBefore && document.getElementById('inp_code').value === codeBefore &&
        document.querySelectorAll('#drList .item').length === histN0 &&
        !document.getElementById('boardBtns').hidden &&
        getComputedStyle(document.getElementById('dockL')).display !== 'none')
      P('★ 开复盘不动主窗口：棋盘 / 局面代码 / 历史 / 仪表盘全部原样', 'unchanged');
    else F('★ 开复盘不动主窗口：棋盘 / 局面代码 / 历史 / 仪表盘全部原样',
           'sig=' + (boardSig() === sigBefore) +
           ' code=' + (document.getElementById('inp_code').value === codeBefore) +
           ' hist=' + document.querySelectorAll('#drList .item').length + '/' + histN0);

    // 从**历史**里点一局 → 也是开复盘窗口（不是把这一局摆到主棋盘上「接着下」）
    var item = document.querySelector('#drList .item');
    if (!item) { F('历史里有可打开的条目', '0 条'); }
    else {
      var sigH = boardSig(), codeH = document.getElementById('inp_code').value;
      msgsBase = window.__msgs.length;
      item.click();
      var hiMsg = window.__msgs.slice(msgsBase).filter(function (s) { return /"openReview"/.test(s); })[0] || '';
      if (/"moves":\\[\\[/.test(hiMsg)) P('★ 历史点开一局 = 也开复盘窗口，并带上那一局的 moves', hiMsg.slice(0, 96));
      else F('★ 历史点开一局 = 也开复盘窗口，并带上那一局的 moves', hiMsg ? hiMsg.slice(0, 120) : '没有 openReview');
      if (boardSig() === sigH && document.getElementById('inp_code').value === codeH)
        P('★ 历史复盘不改写主窗口棋盘（局面与代码都没动）', 'unchanged');
      else F('★ 历史复盘不改写主窗口棋盘（局面与代码都没动）', 'mutated');
    }

    // ★ 2026-09-19（用户要求）：「可以让用户自己更改某条历史的名字……右击鼠标可以有一个选择栏，
    //   里面有删除、重命名等一些功能」+「历史可以导出导入通过 txt 中的代码」。
    (function () {
      var HKEY = 'gbcalc.history.v1', SKEY = 'gbcalc.saved.v1';
      function items() { return document.querySelectorAll('#drList .item'); }
      function hist() { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; } }
      function nmOf(i) { var it = items()[i]; var n = it ? it.querySelector('.nm') : null; return n ? n.textContent : '(none)'; }
      function openMenu(i) {
        items()[i].dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 40, clientY: 60,
        }));
      }
      var mn = document.getElementById('ctxMenu');
      localStorage.setItem(SKEY, '[]');
      localStorage.setItem(HKEY, JSON.stringify([
        { ts: 1700000000000, src: 'local', rule: 0,
          moves: [[7,7,1],[8,7,2],[7,8,1],[8,8,2],[7,9,1],[8,9,2],[7,10,1],[8,10,2],[7,11,1]] },
        { ts: 1700000001000, src: 'local', rule: 0, name: '我的白棋局',
          moves: [[0,0,1],[1,0,2],[0,1,1]] },
      ]));
      document.getElementById('btn_history').click();          // 重新渲染抽屉

      if (items().length === 2) P('历史抽屉列出两局', items().length + ' 条');
      else F('历史抽屉列出两局', items().length + ' 条');
      // 列表是**倒序**渲染的：items[0] = 最新那条（带名字），items[1] = 没名字那条
      if (nmOf(0) === '我的白棋局') P('历史条目的名字显示在 #N 之后', nmOf(0));
      else F('历史条目的名字显示在 #N 之后', nmOf(0));
      if (nmOf(1) === '') P('没名字的条目不留任何占位文字', 'empty');
      else F('没名字的条目不留任何占位文字', JSON.stringify(nmOf(1)));

      // ---- 右击 → 自绘菜单（宿主已关掉 WebView2 的默认右键菜单，所以这个必须自己画）----
      openMenu(1);
      var labels = [].map.call(mn.querySelectorAll('button'), function (b) { return b.textContent; });
      var want = '打开复盘,重命名,导出这一局,存入「保存历史」,删除';
      if (!mn.hidden && labels.join(',') === want)
        P('★ 右击历史条目弹出选择栏（打开复盘 / 重命名 / 导出这一局 / 存入「保存历史」/ 删除）', labels.join(','));
      else F('★ 右击历史条目弹出选择栏（打开复盘 / 重命名 / 导出这一局 / 存入「保存历史」/ 删除）',
        'hidden=' + mn.hidden + ' [' + labels.join(',') + ']');
      var mr = mn.getBoundingClientRect();
      if (!mn.hidden && mr.width > 60 && mr.height > 60 && mr.left >= 0 && mr.top >= 0)
        P('菜单真的占位可见（贴在鼠标附近、没跑到屏幕外）',
          Math.round(mr.left) + ',' + Math.round(mr.top) + ' ' + Math.round(mr.width) + '×' + Math.round(mr.height));
      else F('菜单真的占位可见（贴在鼠标附近、没跑到屏幕外）',
        'hidden=' + mn.hidden + ' ' + Math.round(mr.width) + '×' + Math.round(mr.height));

      // ---- 菜单「重命名」→ 行内输入框 → 回车存下 ----
      mn.querySelectorAll('button')[1].click();
      var rn = document.querySelector('#drList .item input.rn');
      if (rn && mn.hidden) P('★ 菜单「重命名」→ 该条名字变成行内输入框（菜单自己收起）', 'input.rn');
      else F('★ 菜单「重命名」→ 该条名字变成行内输入框（菜单自己收起）',
        'rn=' + !!rn + ' menuHidden=' + mn.hidden);
      if (rn) {
        rn.value = '重命名测试';
        rn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        if (hist()[0] && hist()[0].name === '重命名测试' && nmOf(1) === '重命名测试')
          P('★ 改名真的存进了历史（localStorage 与列表同步）', 'name=' + hist()[0].name);
        else F('★ 改名真的存进了历史（localStorage 与列表同步）',
          'json=' + (hist()[0] ? hist()[0].name : '?') + ' ui=' + nmOf(1));
      }
      // Esc = 撤销这次改名（原名字保留、输入框撤掉）
      openMenu(1);
      mn.querySelectorAll('button')[1].click();
      var rn2 = document.querySelector('#drList .item input.rn');
      if (rn2) {
        rn2.value = '不该被存下';
        rn2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
      if (hist()[0] && hist()[0].name === '重命名测试' && !document.querySelector('#drList input.rn'))
        P('改名按 Esc 撤销（原名保留、输入框撤掉）', 'name=' + hist()[0].name);
      else F('改名按 Esc 撤销（原名保留、输入框撤掉）',
        'name=' + (hist()[0] ? hist()[0].name : '?') + ' rn=' + !!document.querySelector('#drList input.rn'));

      // ---- 导出：交给宿主弹「另存为」；有勾选只导勾选的，没勾选导当前页全部 ----
      // 刚才的右键顺手把 items[1] 选成了唯一选中 → 这一次导出应当只有一局
      function sendTxt() {
        var m = window.__msgs.length;
        document.getElementById('dr_exp').click();
        var s = window.__msgs.slice(m).filter(function (x) { return /"saveTxt"/.test(x); })[0] || '';
        try { return JSON.parse(s); } catch (e) { return null; }
      }
      function bodyOf(p) {
        var ls = (p ? String(p.data) : '').split('\\n');
        return { lines: ls, body: ls.filter(function (l) { return l && l.charAt(0) !== '#'; }) };
      }
      var p1 = sendTxt(), b1 = bodyOf(p1);
      if (p1 && p1.n === 1 && p1.name === '重命名测试.txt' && b1.body.length === 1 &&
          b1.body[0].split('\\t')[1] === 'h8i8h7i7h6i6h5i5h4')
        P('★ 导出：有勾选 → 只导出勾选的那一局（文件名 = 那局的名字）', 'n=1 ' + p1.name);
      else F('★ 导出：有勾选 → 只导出勾选的那一局（文件名 = 那局的名字）',
        'n=' + (p1 && p1.n) + ' name=' + (p1 && p1.name) + ' body=' + b1.body.join('/').slice(0, 90));
      document.getElementById('btn_history').click();   // 重开抽屉 = 清掉勾选
      var p2 = sendTxt(), b2 = bodyOf(p2);
      var c0 = (b2.body[0] || '').split('\\t'), c1 = (b2.body[1] || '').split('\\t');
      if (p2 && p2.n === 2 && /^#/.test(b2.lines[0]) && b2.body.length === 2 &&
          c0[0] === '重命名测试' && c0[1] === 'h8i8h7i7h6i6h5i5h4' &&
          c1[0] === '我的白棋局' && c1[1] === 'a15b15a14')
        P('★ 导出：没勾选 → 导出当前页全部；txt = 注释头 + 每行「名字<TAB>局面代码」',
          'n=' + p2.n + ' 正文行=' + b2.body.length + ' 第二行=' + c1.join('|'));
      else F('★ 导出：没勾选 → 导出当前页全部；txt = 注释头 + 每行「名字<TAB>局面代码」',
        'n=' + (p2 && p2.n) + ' 正文行=' + b2.body.length +
        ' c0=' + c0.join('|') + ' c1=' + c1.join('|'));

      // ---- 导入：点「导入」→ 宿主「打开」对话框 → 回推文本 → 入库 ----
      var m1 = window.__msgs.length;
      document.getElementById('dr_imp').click();
      var askTxt = window.__msgs.slice(m1).join(' | ');
      if (/"openTxt"/.test(askTxt)) P('★ 导入走宿主「打开」对话框（发 openTxt）', 'openTxt');
      else F('★ 导入走宿主「打开」对话框（发 openTxt）', askTxt.slice(0, 110) || '(没发任何消息)');
      var imported = '导入回来的一局\\th8i8h7i7h6i6\\n' +
                     '\\n' +                       // 空行忽略
                     '# 注释行忽略\\n' +
                     'a1b1a2\\n' +                 // 没名字、纯代码也能读
                     'zzz\\n';                     // 读不出着法 → 丢弃
      if (typeof window.__handler === 'function') {
        window.__handler({ data: { type: 'histTxt', text: imported } });
      }
      var h2 = hist();
      var okImp = h2.length === 4 && h2[2] && h2[2].name === '导入回来的一局' &&
                  h2[2].moves.length === 6 && h2[3] && h2[3].moves.length === 3 && !h2[3].name;
      if (okImp) P('★ 导入的 txt 真的入库（名字 + 着法都在；空行/注释/坏行被丢掉）',
        '共 ' + h2.length + ' 局，末两局 ' + h2[2].name + '(' + h2[2].moves.length + '手) / 无名(' + h2[3].moves.length + '手)');
      else F('★ 导入的 txt 真的入库（名字 + 着法都在；空行/注释/坏行被丢掉）',
        JSON.stringify(h2).slice(0, 150));
      // ★ 2026-09-19：回调内发出的回执走**延迟投递**（WebView2 会丢回调里的同步 post）→ 推迟一拍再断言
      setTimeout(function () {
        var ack = window.__msgs.filter(function (s) { return /"histImported"/.test(s); }).pop() || '';
        if (/"n":2/.test(ack) && /导入回来的一局=h8i8h7i7h6i6/.test(ack))
          P('★ 导入后回执给宿主（几局 + 每局「名字=代码」指纹）', ack.slice(0, 110));
        else F('★ 导入后回执给宿主（几局 + 每局「名字=代码」指纹）', ack.slice(0, 110) || '(无回执)');
      }, 0);

      // ---- 右键「删除」：把刚才导入的第一条删掉 ----
      var before = hist().length;
      openMenu(0);                                    // items[0] = 最新那条 = 刚导入的无名局
      var delBtn = mn.querySelectorAll('button')[mn.querySelectorAll('button').length - 1];
      delBtn.click();
      if (hist().length === before - 1 && items().length === before - 1)
        P('★ 右键「删除」真的把这一条删了（存盘 + 列表同步）', before + ' → ' + hist().length);
      else F('★ 右键「删除」真的把这一条删了（存盘 + 列表同步）',
        before + ' → ' + hist().length + ' ui=' + items().length);

      // ---- 右键「存入「保存历史」」：搬进永久区 ----
      var hLen = hist().length;
      openMenu(0);
      var toSaved = mn.querySelectorAll('button')[3];   // 历史页里顺序：打开/重命名/导出/存入保存历史/删除
      if (toSaved && toSaved.textContent === '存入「保存历史」') {
        toSaved.click();
        var sv = [];
        try { sv = JSON.parse(localStorage.getItem(SKEY) || '[]'); } catch (e) {}
        if (sv.length === 1 && hist().length === hLen - 1)
          P('★ 右键「存入「保存历史」」把这局搬进永久区', 'saved=' + sv.length + ' hist=' + hist().length);
        else F('★ 右键「存入「保存历史」」把这局搬进永久区',
          'saved=' + sv.length + ' hist=' + hist().length);
      } else F('★ 右键「存入「保存历史」」把这局搬进永久区',
        'menu=' + (toSaved ? toSaved.textContent : '(无这一项)'));

      localStorage.setItem(HKEY, '[]');
      localStorage.setItem(SKEY, '[]');
      document.getElementById('dr_close').click();
    })();

    // 曲线容器：轴固定画布 + 绘图区画布，两块都要真画出东西
    var ax = document.getElementById('curveAxis'), sc = document.getElementById('curveScroll');
    if (ax && ax.width > 0 && document.getElementById('curve').width > 0) P('评估曲线已绘制（轴 + 绘图区）', 'true');
    else F('评估曲线已绘制（轴 + 绘图区）', 'false');
    // 轴必须在滚动容器「之外」、且在它左边 —— 这样滚多远轴都不动
    var okAxis = ax && sc && !sc.contains(ax) &&
                 ax.getBoundingClientRect().right <= sc.getBoundingClientRect().left + 2;
    if (okAxis) P('纵轴画布在滚动区之外、左侧固定', 'true');
    else F('纵轴画布在滚动区之外、左侧固定', 'false');

    // 拉伸键：已按用户要求整体取消 → 页面里不该再有这些句柄
    if (!document.querySelector('.split, .gripbar, .grip')) P('拉伸改尺寸句柄已全部移除', 'true');
    else F('拉伸改尺寸句柄已全部移除', 'false');

    // ---- 显示序号（2026-09-19 用户要求）----
    (function () {
      var chk = document.getElementById('chk_num');
      if (!chk) { F('★ 对局设置卡有「显示序号」勾选键', 'missing'); return; }
      P('★ 对局设置卡有「显示序号」勾选键', chk.id);
      // 摆两手（走公开入口：载入局面代码），再开开关 → 棋子上就该出现「1」「2」
      var inp = document.getElementById('inp_code');
      inp.value = 'h8i7';
      document.getElementById('btn_load').click();
      var cv2 = document.getElementById('board'), c2 = cv2.getContext('2d');
      chk.checked = false; if (chk.onchange) chk.onchange();
      var a = c2.getImageData(0, 0, cv2.width, cv2.height).data.slice();
      chk.checked = true; if (chk.onchange) chk.onchange();
      var b = c2.getImageData(0, 0, cv2.width, cv2.height).data;
      var diff = 0;
      for (var i = 0; i < a.length; i += 4) if (a[i] !== b[i]) diff++;
      if (diff > 20) P('★ 勾选「显示序号」后棋子上真的多出数字（像素变了）', 'diff=' + diff);
      else F('★ 勾选「显示序号」后棋子上真的多出数字（像素变了）', 'diff=' + diff);
      chk.checked = false; if (chk.onchange) chk.onchange();
    })();

    // ---- 英文模式（2026-09-19 用户要求「英文模式要更全面一点」）----
    (function () {
      document.getElementById('btn_lang').click();          // → en
      var ops = [].map.call(document.querySelectorAll('#sel_rule option'), function (o) { return o.textContent; });
      var cjk = /[\u4e00-\u9fff]/;
      var allEn = ops.length > 0 && ops.every(function (t) { return !cjk.test(t); });
      if (allEn) P('★ 英文模式：规则下拉 6 项全英文', ops.join(' / '));
      else F('★ 英文模式：规则下拉 6 项全英文', ops.join(' / '));
      if (document.title === 'Gomoku Trainer') P('★ 英文模式：窗口标题也是英文', document.title);
      else F('★ 英文模式：窗口标题也是英文', document.title);
      var dash = document.querySelector('.dash');
      if (dash && /Drag the title bar/.test(dash.title)) P('★ 英文模式：悬浮提示也翻译了', dash.title);
      else F('★ 英文模式：悬浮提示也翻译了', dash ? dash.title : 'missing');
      var sn = document.getElementById('t_showNum');
      if (sn && /Move numbers/.test(sn.textContent)) P('★ 英文模式：「显示序号」也是英文', sn.textContent);
      else F('★ 英文模式：「显示序号」也是英文', sn ? sn.textContent : 'missing');
      document.getElementById('btn_lang').click();          // 还原 zh
    })();

    // ---- 对局结束后不再出热力图（2026-09-19 用户要求）----
    (function () {
      var inp = document.getElementById('inp_code');
      inp.value = 'a1b1a2b2a3b3a4b4a5';                      // 黑方连五 → 终局
      document.getElementById('btn_load').click();
      if (G.over) P('★ 载入连五局面 → 终局锁生效', 'G.over=true');
      else F('★ 载入连五局面 → 终局锁生效', 'G.over=' + G.over);
      // 终局 → refreshHeat 的闸门为假 → 立刻 clearHeat()（同步就能看出来）
      S.heat = true; G.over = true;
      G.heat = [{ x: 3, y: 3, tier: 1, ev: '+10' }];
      refreshHeat(true);
      if (G.heat.length === 0) P('★ 终局后再叫刷新热力 → 热力被清掉（一次评估都不发）', 'heat=0');
      else F('★ 终局后再叫刷新热力 → 热力被清掉（一次评估都不发）', 'heat=' + G.heat.length);
      // 反证：没终局时不该被清（说明上面那条真的是「终局」挡的，不是别的）
      G.over = false;
      G.heat = [{ x: 3, y: 3, tier: 1, ev: '+10' }];
      refreshHeat(true);
      if (G.heat.length === 1) P('★ 反证：未终局时同一份热力不会被清', 'heat=1');
      else F('★ 反证：未终局时同一份热力不会被清', 'heat=' + G.heat.length);
      G.heat = []; S.heat = false; G.over = false;
    })();

    // ---- ★ AI 视图按思考时间分档 + 鼠标悬浮格提示（2026-09-20 用户要求）----
    (function () {
      // ① 档位阈值：直接跑真函数（heatProfile 是页面里的全局函数）
      var keep = S.turnMs;
      S.turnMs = 2000; var p1 = heatProfile();
      S.turnMs = 4000; var p2 = heatProfile();
      S.turnMs = 5000; var p3 = heatProfile();
      S.turnMs = keep;
      var ptxt = JSON.stringify([p1, p2, p3]);
      if (p1.colors === 2 && p1.topN === 3 && p2.colors === 3 && p2.topN === 6 &&
          p3.colors === 4 && p3.topN === 8)
        P('★ 档位阈值：<3s→2色/3点，3~4.5s→3色/6点，>4.5s→4色/8点', ptxt);
      else F('★ 档位阈值：<3s→2色/3点，3~4.5s→3色/6点，>4.5s→4色/8点', ptxt);

      // ② 图例裁档：2 色档 → data-colors="2"（CSS 把「一般/劣势」两档裁掉）
      var lg = document.getElementById('heatLegend');
      var keepCoach = S.coach;
      S.coach = false;
      G.heat = [{ x: 5, y: 5, tier: 1, ev: '+10' }, { x: 6, y: 6, tier: 2, ev: '+5' }];
      G.heatColors = 2; paint();
      var dc = lg ? lg.getAttribute('data-colors') : '(无图例)';
      G.heat = []; paint();
      if (dc === '2') P('★ 2 色档时图例 data-colors=2（超出档位的「一般/劣势」被裁掉）', dc);
      else F('★ 2 色档时图例 data-colors=2（超出档位的「一般/劣势」被裁掉）', String(dc));

      // ③ 鼠标悬浮：真发 mousemove → G.hover 落在「最近交叉点」上
      var cv3 = document.getElementById('board'), g3 = geom(), r3 = cv3.getBoundingClientRect();
      var evx = r3.left + g3.pad + 8 * g3.gap + g3.gap * 0.3;   // (8,8) 交叉点偏 0.3 格
      var evy = r3.top + g3.pad + 8 * g3.gap - g3.gap * 0.2;
      cv3.dispatchEvent(new MouseEvent('mousemove', { clientX: evx, clientY: evy, bubbles: true }));
      var hh = G.hover;
      if (hh && hh.x === 8 && hh.y === 8) P('★ 悬浮在 (8,8) 附近 → G.hover=(8,8)（与点击同源）', JSON.stringify(hh));
      else F('★ 悬浮在 (8,8) 附近 → G.hover=(8,8)（与点击同源）', JSON.stringify(hh));
      // 像素证据：关掉/打开悬浮，那一块必须真的变了（圆角方框画出来了）
      G.hover = null; paint();
      var pa = cv3.getContext('2d').getImageData(0, 0, cv3.width, cv3.height).data.slice();
      G.hover = { x: 8, y: 8 }; paint();
      var pb = cv3.getContext('2d').getImageData(0, 0, cv3.width, cv3.height).data;
      var d = 0; for (var i2 = 0; i2 < pa.length; i2 += 4) if (pa[i2] !== pb[i2]) d++;
      if (d > 20) P('★ 悬浮提示真的画出来了（浅灰蓝圆角方框：像素变化）', 'diff=' + d);
      else F('★ 悬浮提示真的画出来了（浅灰蓝圆角方框：像素变化）', 'diff=' + d);
      // 出盘 → 提示消失
      cv3.dispatchEvent(new MouseEvent('mousemove', { clientX: r3.left - 40, clientY: r3.top - 40, bubbles: true }));
      if (!G.hover) P('★ 指针移出棋盘 → 悬浮提示消失', 'null');
      else F('★ 指针移出棋盘 → 悬浮提示消失', JSON.stringify(G.hover));
      cv3.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      S.coach = keepCoach; G.hover = null; paint();
    })();

    // ---- ★ 计算评估（2026-09-20 用户要求）：六键要真接上；结果要**画在棋盘上** ----
    (function () {
      var anaC = document.querySelector('.card[data-id="analysis"]');
      if (!anaC) { F('计算评估卡在页面里', 'missing'); return; }
      var ids = ['btn_an_nbest', 'btn_an_defend', 'btn_an_bal1', 'btn_an_bal2', 'btn_an_stop'];
      var miss = ids.filter(function (id) { return !document.getElementById(id); });
      var txt = ids.map(function (id) { var e = document.getElementById(id); return e ? e.textContent : '?'; });
      if (!miss.length && txt.join(',') === '多点分析,扫描防守,平衡一,平衡二,计算')
        P('★ 计算评估五键齐全且文案正确（多点分析+扫描防守 / 平衡一+平衡二 / 计算独占一行）', txt.join(','));
      else F('★ 计算评估五键齐全', 'miss=' + miss.join(',') + ' txt=' + txt.join(','));
      // ★ 2026-09-20 二轮（用户反馈）：「计算和停止计算里面的文字是活动的」—— 同一颗键：
      //   闲 = 文字「计算」、可点、不高亮；忙 = 文字「停止计算」、点亮；算完自动回「计算」。
      var st0 = document.getElementById('btn_an_stop');
      if (st0 && st0.disabled === false && st0.textContent === '计算' && !st0.classList.contains('on'))
        P('★ 闲着：键文字是「计算」、可点、不高亮', st0.textContent);
      else F('★ 闲着：键文字是「计算」、可点、不高亮',
        st0 ? 'disabled=' + st0.disabled + ' txt=' + st0.textContent : 'missing');
      G.ana.busy = true; anaCalcUI();      // 造一个「跑着」的态 → 文字变「停止计算」+ 点亮
      if (st0 && st0.disabled === false && st0.textContent === '停止计算' && st0.classList.contains('on'))
        P('★ 跑着：文字自动变「停止计算」+ 键点亮（可点 = 中断）', st0.textContent);
      else F('★ 跑着：文字自动变「停止计算」+ 键点亮',
        st0 ? 'txt=' + st0.textContent + ' on=' + st0.classList.contains('on') : 'missing');
      G.ana.busy = false; anaCalcUI();     // 收尾回「计算」，别污染后面的用例
      var nb = document.getElementById('num_nbest');
      if (nb && nb.type === 'number' && nb.min === '2' && nb.max === '8')
        P('★ 多点分析点数输入框 2 ~ 8', nb.value);
      else F('★ 多点分析点数输入框 2 ~ 8', nb ? nb.type + ' ' + nb.min + '~' + nb.max : 'missing');
      // ★ 2026-09-20 修复：原来 onchange 里 S.nbest = anaIp() 自己读自己 → 永远弹回 4。
      nb.value = '6'; nb.dispatchEvent(new Event('change', { bubbles: true }));
      if (S.nbest === 6 && nb.value === '6')
        P('★ 分析点数真的可调（输入 6 → S.nbest=6，不再弹回 4）', String(S.nbest));
      else F('★ 分析点数真的可调', 'S.nbest=' + S.nbest + ' nb=' + nb.value);
      nb.value = '9'; nb.dispatchEvent(new Event('change', { bubbles: true }));
      if (S.nbest === 8) P('★ 超上限钳到 8', String(S.nbest));
      else F('★ 超上限钳到 8', String(S.nbest));
      nb.value = '4'; nb.dispatchEvent(new Event('change', { bubbles: true }));

      // 六键真的绑上了（点「停止计算」→ 状态文字更新 + 棋盘标注与清单一起清空）
      G.ana.marks = [{ x: 7, y: 7, badge: '1', label: '+12', tier: 0 }];
      G.ana.rows = [{ i: 0, badge: '1', coord: 'H8', eval: '+12', pv: '' }];
      renderAna('x'); paint();
      G.ana.busy = true; anaCalcUI();      // 文字变「停止计算」；键本来就 enabled，可直接点
      document.getElementById('btn_an_stop').click();
      var st = document.getElementById('anStatus');
      var listIt = document.querySelectorAll('#anList .it').length;
      if (st && st.textContent && G.ana.marks.length === 0 && listIt === 0)
        P('★ 「停止计算」键真的接上了：状态文字更新 + 棋盘标注与清单一起清空', st.textContent);
      else F('★ 「停止计算」键真的接上了',
        'status=' + (st ? st.textContent : 'missing') + ' marks=' + G.ana.marks.length + ' list=' + listIt);

      // ★ 核心要求：「多点分析、计算之类的，应该在棋盘上有数字或者说其他数字加字母的表示方式」
      var cvA = document.getElementById('board'), cA = cvA.getContext('2d');
      G.ana.marks = []; renderAna(''); paint();
      var p0 = cA.getImageData(0, 0, cvA.width, cvA.height).data.slice();
      G.ana.marks = [
        { x: 7, y: 7, badge: '1', label: '+350', tier: 0 },
        { x: 8, y: 8, badge: '2', label: '-20', tier: 1 },
        { x: 6, y: 8, badge: '≡', label: '0', tier: -1 },
      ];
      G.ana.rows = [
        { i: 0, badge: '1', coord: 'H8', eval: '+350', pv: 'I9 J7' },
        { i: 1, badge: '2', coord: 'I9', eval: '-20', pv: '' },
      ];
      renderAna('');
      paint();
      var p1 = cA.getImageData(0, 0, cvA.width, cvA.height).data;
      var dd = 0; for (var i3 = 0; i3 < p0.length; i3 += 4) if (p0[i3] !== p1[i3]) dd++;
      var it2 = document.querySelectorAll('#anList .it').length;
      if (dd > 200 && it2 === 2)
        P('★ 分析结果画在棋盘上：数字/≡ 徽标 + 评估分标签（像素变化）+ 卡片清单 2 条',
          'diff=' + dd + ' list=' + it2);
      else F('★ 分析结果画在棋盘上（数字徽标 + 评估分标签）', 'diff=' + dd + ' list=' + it2);
      G.ana.marks = []; G.ana.rows = []; renderAna(''); paint();

      // ★ 2026-09-20（用户反馈）：扫描防守回归 —— 在对手刚落那一手周围 9×9 逐点打分，
      //   同步出结果：徽标 + 全部点铺小字 + 右侧清单。
      G.moves.push({ x: 7, y: 7, c: 1 }); G.board[7][7] = 1;
      anaDefend();
      var dm = G.ana.marks || [], dr2 = G.ana.rows || [];
      var hasRank = dm.length > 0 && dm[0].badge === '1';   // 没杀形 → 徽标是名次数字（A/B/C 已退场）
      var hasPlain = dm.some(function (m) { return m.plain; });
      var st3 = document.getElementById('anStatus');
      if (hasRank && hasPlain && dr2.length > 0 && st3 && st3.textContent.indexOf('扫') >= 0)
        P('★ 扫描防守：9×9 邻域逐点打分 → 徽标 + 百分比铺棋盘 + 清单', st3.textContent);
      else F('★ 扫描防守', 'marks=' + dm.length + ' b0=' + (dm[0] ? dm[0].badge : '-') +
        ' plain=' + hasPlain + ' rows=' + dr2.length + ' st=' + (st3 ? st3.textContent : '-'));
      G.moves.pop(); G.board[7][7] = 0; G.ana.marks = []; G.ana.rows = []; renderAna(''); paint();

      // ★ 2026-09-20 三轮（用户要求）：徽标 = **最短杀记法**（照 rapfi）——
      //   ★ 五轮起记号从 ±M 改 **Yixin 的 W/L**：W = 距离赢几步、L = 距离输几步。
      //   白（对手）活三 (3,7)(4,7)(5,7)：(2,7)/(6,7) 一落就成活四 → 徽标 L4（不挡 4 步就输）；
      //   黑（我方）活三 (3,9)(4,9)(5,9)：(2,9)/(6,9) 一落也成活四 → 徽标 W3（3 步赢）。
      // ★ 盘面先清干净：前面「终局锁」用例载入的连五局面还留在盘上 —— 白 b1–b4 在 x=1 列
      //   是现成活四，(1,10) 恰在扫描窗内会算出 L2（白一落成五）抢走榜首，W3 被挤出前三圈层。
      for (var yy = 0; yy < G.board.length; yy++)
        for (var xx = 0; xx < G.board.length; xx++) G.board[yy][xx] = 0;
      [[3, 7], [4, 7], [5, 7], [3, 9], [4, 9], [5, 9]].forEach(function (p) { G.board[p[1]][p[0]] = (p[1] === 7 ? 2 : 1); });
      G.moves.push({ x: 5, y: 7, c: 2 });
      anaDefend();
      var dm2 = G.ana.marks || [];
      var m4 = dm2.filter(function (m) { return m.badge === 'L4'; }).length;
      var m3 = dm2.filter(function (m) { return m.badge === 'W3'; }).length;
      var noABC = dm2.every(function (m) { return !/^[A-H]$/.test(m.badge); });
      // ★ 五轮：前三名 = inline 双行徽标（W/L 在上、百分比在下融进徽标本体）
      var inl3 = dm2.filter(function (m, i) { return i < 3 && m.inline && /%$/.test(m.label || ''); }).length;
      if (m4 >= 2 && m3 >= 1 && noABC && inl3 === 3)
        P('★ 扫描防守徽标 = W/L 记法 + 前三名 inline 双行胶囊（L4×2 / W3，字母退场）',
          dm2.slice(0, 4).map(function (m) { return m.badge + (m.inline ? '⌗' + m.label : ''); }).join(','));
      else F('★ 扫描防守徽标 = W/L 记法 + inline',
        'L4=' + m4 + ' W3=' + m3 + ' abc=' + !noABC + ' inline3=' + inl3 +
        ' top=' + JSON.stringify(dm2.slice(0, 5).map(function (m) { return m.badge; })));
      [[3, 7], [4, 7], [5, 7], [3, 9], [4, 9], [5, 9]].forEach(function (p) { G.board[p[1]][p[0]] = 0; });
      G.moves.pop(); G.ana.marks = []; G.ana.rows = []; renderAna(''); paint();
    })();

    // ---- ★ 卡片折叠：真鼠标手势点标题栏右上角的小横杠（2026-09-20 用户要求）----
    //   ★ 用「计算评估」卡来测：它是**默认可见**的。以前这段拿「引擎仪表盘」做样本，
    //     而那张卡 2026-09-20 起默认是收起的（要它出现得走「卡片」键）→ 量到的
    //     卡片高/正文高全是 0，折叠前后都是 0 就判不出来（假红）。
    (function () {
      var card = document.querySelector('.card[data-id="analysis"]');
      // ★ 2026-09-27：分析卡默认收起（设置里开）—— 折叠测试前先把它显示出来
      if (card && card.hidden) {
        var _bs = document.getElementById('btn_set'), _sp = document.getElementById('setPop');
        if (_bs && _sp) {
          _bs.click();
          var _ab = _sp.querySelector('button[data-card="analysis"]');
          if (_ab) _ab.click();
          _sp.hidden = true;
        }
      }
      var dash = card ? card.querySelector('.card-h .dash') : null;
      var b = card ? card.querySelector('.card-b') : null;
      if (!card || !dash || !b) { F('★ 卡片右上角的小横杠是折叠开关', 'no card/dash/body'); return; }
      var hOpen = Math.round(card.getBoundingClientRect().height);
      var visOpen = Math.round(b.getBoundingClientRect().height);
      // 真手势：mousedown + mouseup + click（绕开 .click() 的假绿 —— 顺便验 onCardDown 不吃它）
      function realClick(el) {
        var r = el.getBoundingClientRect();
        var o = {
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          bubbles: true, cancelable: true,
        };
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.dispatchEvent(new MouseEvent('click', o));
      }
      var dr = dash.getBoundingClientRect();
      var under = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2 + 4);
      if (under && under.closest && under.closest('.dash') === dash)
        P('★ 横杠的点击区比那根细线大（线下方 4px 仍命中它，点得准）', 'hit=' + under.className);
      else F('★ 横杠的点击区比那根细线大（线下方 4px 仍命中它，点得准）',
        'hit=' + (under ? under.className || under.tagName : 'null'));

      realClick(dash);                                  // ① 点一下 → 折叠
      var hFold = Math.round(card.getBoundingClientRect().height);
      var visFold = Math.round(b.getBoundingClientRect().height);
      var rad = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0;
      if (!document.body.classList.contains('dragging') && !document.querySelector('.ph'))
        P('反证：点横杠不会把卡片抓起来拖动（没进 dragging / 没插占位块）', 'ok');
      else F('反证：点横杠不会把卡片抓起来拖动（没进 dragging / 没插占位块）',
        'dragging=' + document.body.classList.contains('dragging') + ' ph=' + !!document.querySelector('.ph'));
      if (card.classList.contains('collapsed') && visFold === 0 && hFold < hOpen - 40 &&
          rad >= hFold / 2 - 1)
        P('★ 点横杠 → 卡片收成一条长条圆角矩形（正文整块撤掉、高度骤减、半高胶囊圆角）',
          'h ' + hOpen + '→' + hFold + ' 圆角=' + Math.round(rad) + ' 正文=' + visOpen + '→' + visFold);
      else F('★ 点横杠 → 卡片收成一条长条圆角矩形（正文整块撤掉、高度骤减、半高胶囊圆角）',
        'cls=' + card.classList.contains('collapsed') + ' 正文=' + visFold +
        ' h=' + hOpen + '→' + hFold + ' 圆角=' + Math.round(rad));
      function lay() {
        try { return JSON.parse(localStorage.getItem('gbcalc.layout.v7') || '{}'); } catch (e) { return {}; }
      }
      var c1 = lay().collapsed || {};
      if (c1.analysis === 1) P('★ 折叠态写进布局（重开窗口仍是收着的）', JSON.stringify(c1));
      else F('★ 折叠态写进布局（重开窗口仍是收着的）', JSON.stringify(c1));

      realClick(dash);                                  // ② 再点一下 → 展开
      var c2 = lay().collapsed || {};
      if (!card.classList.contains('collapsed') &&
          Math.round(b.getBoundingClientRect().height) === visOpen && !c2.analysis)
        P('★ 再点横杠 → 卡片完全复原（正文回来、高度回到原值、布局里的折叠标记清掉）',
          'h=' + Math.round(card.getBoundingClientRect().height) + ' collapsed=' + JSON.stringify(c2));
      else F('★ 再点横杠 → 卡片完全复原（正文回来、高度回到原值、布局里的折叠标记清掉）',
        'cls=' + card.classList.contains('collapsed') +
        ' 正文=' + Math.round(b.getBoundingClientRect().height) + '/' + visOpen +
        ' collapsed=' + JSON.stringify(c2));
      if (c2.analysis === undefined && c2.setup === undefined)
        P('反证：展开的卡片不占折叠表（只记「收起来的」）', JSON.stringify(c2));
      else F('反证：展开的卡片不占折叠表（只记「收起来的」）', JSON.stringify(c2));
    })();

    finish();
  }
  // ★ 兜底：done() 里任何一步抛异常都不能让它「半路死掉」——那样页面一个字都不回传，
  //   父进程只看到「页面无回传」，根因被吞掉（本次就是被这条坑了）。包一层，把真实堆栈报出来。
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      try { done(); }
      catch (e) {
        F('TEST_JS 中途异常（已兜底捕获）', String((e && e.stack) || e));
        finish();
      }
    }, 900);
  });
})();
</script>
`;

function main() {
  let browser = null;
  for (const b of BROWSERS) { if (fs.existsSync(b)) { browser = b; break; } }
  if (!browser) { console.log('  (未找到 Edge/Chrome，跳过 B 段 UI 冒烟)'); return finishAll(); }

  for (const [name, src] of [['SHELL_JS', SHELL_JS], ['TEST_JS', TEST_JS]]) {
    const body = src.replace(/^\s*<script>\s*/, '').replace(/<\/script>\s*$/, '');
    try { new vm.Script(body); } catch (e) { console.error(name + ' 语法错误：' + e.message); process.exit(1); }
  }
  let html = fs.readFileSync(CALC_HTML, 'utf8');
  const atShell = html.indexOf('<script src="calc.js">');
  if (atShell < 0) { console.error('找不到 calc.js 引用'); process.exit(1); }
  html = html.slice(0, atShell) + SHELL_JS + html.slice(atShell);
  const atEnd = html.lastIndexOf('</body>');
  html = html.slice(0, atEnd) + TEST_JS + html.slice(atEnd);
  fs.writeFileSync(HARNESS, html, 'utf8');

  // ★ GB_SMOKE_ONLY=1：只产出 harness（SHELL_JS + TEST_JS 注入后的 calc.html），
  //   不 spawn 浏览器 —— 本沙箱环境 node 的 spawn 一律 EBUSY，B 段由外部驱动
  //   （playwright/无头 Edge）加载同一份 harness 复跑，断言口径不变。
  if (process.env.GB_SMOKE_ONLY) {
    const out = process.env.GB_SMOKE_ONLY === '1' ? HARNESS + '.out.html' : process.env.GB_SMOKE_ONLY;
    fs.copyFileSync(HARNESS, out);
    try { fs.unlinkSync(HARNESS); } catch (x) {}
    console.log('== B. 真实浏览器 UI 冒烟（GB_SMOKE_ONLY：harness 已写到 ' + out + '）==');
    return finishAll();
  }

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(UI_DIR, rel);
    if (!f.startsWith(UI_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    const ext = path.extname(f);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/css';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/' + path.basename(HARNESS);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-calc-'));
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--user-data-dir=' + profile, '--window-size=1280,860',
      '--virtual-time-budget=12000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { dom += d; });
    const finish = (why) => {
      server.close();
      try { fs.unlinkSync(HARNESS); } catch (x) {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {}
      console.log('== B. 真实浏览器 UI 冒烟（' + why + '）==');
      if (!dom.trim()) { console.log('  ✗ 浏览器无回传'); fail++; return finishAll(); }
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
      if (!m) { console.log('  ✗ 页面无回传'); fail++; return finishAll(); }
      for (const line of m[1].split('\n')) {
        const t = line.trim();
        if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
        else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
      }
      finishAll();
    };
    const killer = setTimeout(() => { try { child.kill(); } catch (x) {} finish('超时'); }, 90000);
    child.on('exit', (code) => { clearTimeout(killer); finish('exit=' + code); });
  });
}

// ★★ 2026-09-23 十五轮（用户要求）：残局模式 + VC 编辑放开 + 弹窗高亮 + 首手全局计算 + i18n 修补
ok('★ 十五轮残局：模式第三项「残局」+ 棋盘下方摆盘行（顺序/任意 + 圆角选色框）+ AI 全程不参与',
  /<button data-mode="endgame">残局<\/button>/.test(HTML) &&
  HTML.indexOf('data-mode="endgame"') > HTML.indexOf('data-mode="place"') &&        // 排在自由摆盘后
  /<div class="seg s3" id="seg_mode">/.test(HTML) &&
  /<div id="egBar" hidden>/.test(HTML) &&
  /id="btn_eg_seq"/.test(HTML) && /id="btn_eg_free"/.test(HTML) &&
  /<span id="egKeys" hidden>/.test(HTML) && /id="btn_eg_b"/.test(HTML) && /id="btn_eg_w"/.test(HTML),
  'egBar/egKeys 默认 hidden；残局键在自由摆盘之后');
ok('★ 十五轮残局逻辑：任意摆盘 = 摆选定色（不限数量顺序）+ AI/热力/指导全闸 + 药丸提示 + 交换手流程不开',
  /var c = \(S\.mode === 'endgame' && !S\.egSeq\) \? \(S\.egColor \|\| 1\) : curColor\(\);/.test(JS) &&
  /if \(S\.mode === 'place' \|\| S\.mode === 'endgame'\) \{\s*(?:\/\/[^\n]*\n\s*)*paint\(\); return;\s*\}/.test(JS) &&
  /S\.mode === 'place' \|\| S\.mode === 'endgame'\) return;/.test(JS) &&                    // aiAssistOnce
  /S\.mode !== 'place' && S\.mode !== 'endgame'/.test(JS) &&                                // 热力/指导/图例闸
  /\} else if \(S\.mode === 'endgame'\) \{/.test(JS) &&                                     // 药丸分支
  // ★★ 2026-09-25（用户要求）：正中那颗键在 AI 自打时**不再变灰** —— 它就是自动对弈的开关键
  //   （❚❚ 停手 / ▶ 继续，与播放器同款）；只有「摆盘 / 残局」才禁用（那两个模式不自动落子）。
  /els\.btn_pause\.disabled = \(S\.mode === 'place' \|\| S\.mode === 'endgame'\);/.test(JS) &&
  !/els\.btn_pause\.disabled = \(S\.mode === 'place' \|\| S\.mode === 'endgame' \|\| aiVsAi\(\)\);/.test(JS) &&
  /S\.mode !== 'pve' && S\.mode !== 'place' && S\.mode !== 'endgame'\) S\.mode = 'place';/.test(JS) &&
  /if \(S\.mode === 'endgame'\) setStat\(null, S\.egLocked \? T\('egLockedHint'\) : T\('egHint'\)\);/.test(JS) &&
  /if \(S\.mode === 'endgame'\) return;/.test(JS) &&                                        // openStart 不开交换
  /o\.disabled = \(S\.mode === 'endgame'\)/.test(JS) &&                                     // ★ 交换手规则变灰
  /els\.btn_eg_seq\.onclick/.test(JS) && /els\.btn_eg_b\.onclick/.test(JS));
ok('★ 三十轮流式演算（智子式）：扫描防守精修链窗口=思考时间4.5×（连轴刷新、收敛定格）+ 多点分析连轴探针',
  /function streamWindowMs\(\)/.test(JS) && /function streamGapMs\(\)/.test(JS) &&          // 总窗口 + 轮间喘息
  /G\.moves\.length !== mvN/.test(JS) &&                                                    // 在途轮遇新局面 → 草稿作废
  /G\.ana\.defWinUntil = Date\.now\(\) \+ streamWindowMs\(\)/.test(JS) &&                   // 扫描防守开窗
  /G\.ana\.defRefining = true/.test(JS) && /G\.ana\.defRefining = false/.test(JS) &&        // 精修在途标记（续拍等它收尾）
  /function defendScheduleNext\(/.test(JS) && /function defendTick\(\)/.test(JS) &&         // 防守流内续拍
  /if \(stable\) return 'stable';/.test(JS) &&                                              // 精修收敛 → 上报定格
  /if \(res === 'stable' \|\| res === 'stop'\) return;/.test(JS) &&                         // 收敛/引擎离线 → 停流
  /try \{ anaDefend\(true\); \} catch \(e\) \{\}/.test(JS) &&                                // 落子重扫 = 重开窗口
  /async function anaNbest\(\)/.test(JS) && /for \(var rd = 1; ; rd\+\+\)/.test(JS) &&      // 多点分析 = 连轴探针循环
  /anDraft: '演算中…第 \{r\} 轮草稿'/.test(JS) && /anDraft: 'Drafting… round \{r\}'/.test(JS) &&  // 演算中草稿文案（中英）
  /if \(budget < 250\) break;/.test(JS) &&                                                  // 窗口余量不足 → 定格
  /anDefendStable: '已收敛，结论稳定'/.test(JS));                                           // 收敛 = 定格不再复扫
ok('★ 廿九轮扫描防守动态刷新：随落子重扫 + 周期复扫（思考时间 3.5×）+ 定局（五连/活四）停显',
  /autoDefend: false, defTimer: null \}/.test(JS) &&
  /G\.ana\.autoDefend = true;/.test(JS) &&                                                  // 首次点击扫描防守 → 开启
  /if \(G\.ana\.autoDefend && !G\.ana\.busy && !G\.over && !boardDecided\(\)\) \{ try \{ anaDefend\(true\); \} catch \(e\) \{\} \}/.test(JS) &&  // afterMove 随落子重扫（定局除外）
  /function defendTick\(\)/.test(JS) &&                                                     // ★ 三十轮：流内续拍表
  /function boardDecided\(\)/.test(JS) && /if \(n >= 5\) return true;/.test(JS) &&          // 五子连珠 → 定局
  /if \(n === 4\) \{/.test(JS) && /!b\[ey\]\[ex\]/.test(JS) &&                              // 活四（两端空）→ 定局
  /G\.ana\.autoDefend = false;\s*\/\/ ★ 2026-09-26：清除标记/.test(JS) &&
  /G\.ana\.autoDefend = false;\s*\/\/ ★ 2026-09-26：重开/.test(JS));
// ★★ 2026-09-28（用户：原生引擎棋力只剩一半）：落子决策链回归引擎本体 ——
//   pfPick（粒子滤波历史众数覆盖）与 simVerify（160ms 浅模拟否决）两层全部撤除；
//   引擎终榜 best 直接落子，只留 mustAnswer 必应护栏（能连五 / 对手将成五必堵，纯战术兜底）。
ok('★ 智力回归：决策链只剩引擎 best + 必应护栏（pfPick / simVerify 干扰层全部撤除）',
  !/pfPick|pfObserve|pfReset|MOVE_PF/.test(JS) &&
  !/simVerify|simPlayout|SIM_CFG/.test(JS) &&
  !/tagSim/.test(JS) &&
  /var gd = mustAnswer\(G\.board, curColor\(\), cs, winPoints\(G\.board, 3 - curColor\(\), engineRule\(\)\), null, 1\);/.test(JS) &&
  /if \(gd\) best = \[gd\.x, gd\.y\];/.test(JS) &&
  !/placeEval|evalShow|chk_evalshow/.test(JS));
ok('★ 三十二轮对局设置分块：模式 / AI 执子 各套虚线框（标题一行、按键一行）+ 黑白双色开关',
  /<div class="grp" id="modeGrp">/.test(HTML) &&   /<div class="grp" id="sideGrp">/.test(HTML) &&                                              // AI 执子组框
  /<div class="row head"><label id="t_mode">模式<\/label>/.test(HTML) &&                      // 标题独占一行
  /<div class="row head"><label id="t_side">AI 执子<\/label>/.test(HTML) &&
  /\.grp\{[\s\S]{0,120}?border:1px dashed var\(--border\)/.test(CSS) &&                           // 虚线框本体
  /\.card \.row\.head\{flex-direction:column/.test(CSS) &&                                        // 标题与按键**分两行**
  /#seg_side \.tglbtn\[data-ai="b"\]\.on\{background:var\(--side-b-bg\)/.test(CSS) &&             // AI 执黑 = 浅紫
  /#seg_side \.tglbtn\[data-ai="w"\]\.on\{background:var\(--side-w-bg\)/.test(CSS) &&             // AI 执白 = 浅蓝
  /--side-b-bg:#f2e9fd; --side-b-bd:#cbb2ef; --side-b-tgl:#8b5cf6;/.test(CSS) &&                  // 浅色主题两套色
  /--side-w-bg:#e6f2fd; --side-w-bd:#a9cfea; --side-w-tgl:#3b9ae1;/.test(CSS) &&
  /\[data-theme="dark"\]\{[\s\S]{0,200}?--side-b-bg:rgba\(139,92,246,\.30\)/.test(CSS));          // 深色主题同步
ok('★ 十五轮残局 i18n：modeEndgame/egSeq/egFree/egB/egW/egHint 中英齐全 + applyLang 同步',
  /modeEndgame: '残局'/.test(JS) && /egSeq: '顺序摆盘', egFree: '任意摆盘', egB: '黑子', egW: '白子'/.test(JS) &&
  /egHint: '残局模式：AI 不参与/.test(JS) &&
  /modeEndgame: 'Endgame'/.test(JS) && /egSeq: 'Sequential'/.test(JS) && /egHint: 'Endgame mode: no AI involved/.test(JS) &&
  /mm\[2\]\.textContent = S\.lang === 'en' \? 'Endgame' : '残局';/.test(JS) && /els\.btn_eg_seq\.textContent = d\.egSeq;/.test(JS));
ok('★ 十五轮 VC 编辑放开：补充不限数量（闸门跳过）+ 删除任意子 + 左侧文字栏详细说明（中英）',
  /var canB = VIS\.vc \? true : \(c\.b <= c\.w\);/.test(JS) &&
  /var canW = VIS\.vc \? true : \(c\.w < c\.b\);/.test(JS) &&
  /if \(!VIS\.vc\) \{[\s\S]*?veFillBFull[\s\S]*?veFillWFull/.test(JS) &&
  /if \(!VIS\.vc\) \{[\s\S]*?fc === 1 && fc0\.b > fc0\.w/.test(JS) &&
  /if \(VIS\.vc\) \{[\s\S]*?G\.board\[y\]\[x\] = 0;[\s\S]*?veDelDone/.test(JS) &&          // VC 任意删
  /veDelVcHint: 'VC 模式 · 删除棋子/.test(JS) && /veFillVcHint: 'VC 模式 · 补子/.test(JS) &&
  /visVcEditTip: 'VC 模式已开：黑白子数\*\*不必相等\*\*/.test(JS) &&
  /veDelVcHint: 'VC mode · Remove:/.test(JS) && /visVcEditTip: 'VC mode is on:/.test(JS) &&
  /visEditHint\(VIS\.vc \? T\('visVcEditTip'\)/.test(JS) &&                                // 进修改即说明
  /visMsg\(T\(VIS\.vc \? 'visVcEditTip' : 'visVcOff'\)\);/.test(JS));                      // VC 开关即说明
ok('★ 十五轮弹窗高亮：黑子开始=浅紫(.sel-b)、白子开始=浅白蓝(.sel-w)，退出选色熄灭；残局框同款',
  /els\.btn_ve_addb\.classList\.toggle\('sel-b', kind === 'addb'\);/.test(JS) &&
  /els\.btn_ve_addw\.classList\.toggle\('sel-w', kind === 'addw'\);/.test(JS) &&
  /els\.btn_ve_addb\.classList\.remove\('sel-b'\);/.test(JS) &&
  /els\.btn_ve_addw\.classList\.remove\('sel-w'\);/.test(JS) &&
  /\.btn\.sel-b\{background:#dcc5f5/.test(CSS) && /\.btn\.sel-w\{background:#d7e8fb/.test(CSS) &&
  /\.btn\.eg-on\{background:#9fd2f2/.test(CSS) && /#egBar\{display:flex/.test(CSS) &&
  /#egKeys\{display:inline-flex/.test(CSS) && /#egKeys\[hidden\]\{display:none\}/.test(CSS));
ok('★ 十五轮首手加强 + VC 残局首帧 + i18n 修补：第一手全局深算 / VC 载入切残局 / 历史整盘首帧 / 清除标记英文 / 日期随语言',
  /var firstDeep = \(step === 0\);/.test(JS) &&
  /Math\.max\(4000, Math\.min\(60000, \(S\.turnMs \|\| 400\) \* 4\)\)/.test(JS) &&   // ★09-27：首手封顶放宽 60s
  /fwdEta: '计算中 · 首手预计 \{d\} 秒内给出/.test(JS) &&
  /anEta: '计算中… 预计 \{s\} 秒内给出',/.test(JS) &&
  /var calcMs = Math\.min\(60000, Math\.round\(\(S\.turnMs \|\| 2000\) \* 1\.6\)\);/.test(JS) &&   // 计算评估封顶放宽 60s（09-27）
  /renderAna\(T\('anEta'\)\.replace\('\{s\}', String\(Math\.ceil\(calcMs \/ 1000\)\)\)\);/.test(JS) &&
  /topN: firstDeep \? Math\.max\(4, S\.nbest \|\| 4\) : \(of\.length \? 4 : 1\)/.test(JS) &&
  /if \(o\.vc\) \{[\s\S]*?S\.mode = 'endgame'/.test(JS) &&                                 // VC 载入 → 残局模式
  /first: 'b', moves: mv, vc: !!o\.vc \}/.test(JS) &&                                      // 记录带 vc 标记
  /vc: !!VIS\.vc,/.test(JS) &&                                                             // 识图保存历史也带
  /if \(h\.vc && !RV_MODE && S\.mode !== 'endgame'\) \{/.test(JS) &&                       // 主窗打开切残局
  /var egFirst = !!\(rec && rec\.vc\) && mv\.length > 0;/.test(JS) &&                      // 复盘窗整盘首帧
  /els\.btn_recite\.hidden = egFirst;/.test(JS) &&                                         // 残局不背诵
  /els\.btn_fwd_clear\.textContent = d\.fwdClear;/.test(JS) &&                             // ★ 清除标记英文
  /toLocaleString\(S\.lang === 'en' \? 'en-US' : 'zh-CN'\)/.test(JS));                     // ★ 日期样式随语言

// ★★ 2026-09-23 十六轮（用户三点要求）：
//   ① 残局「确定」键：定下残局 → 重新开始回到它、历史首帧也是它；
//   ② 首手预算 6→4 + 提示给出预计耗时区间；
//   ③ 攻防算法修正：显式行棋方（子数不均衡不再站到对面）+ 必应校验（连五 / 堵五 / 活三必应）。
ok('★ 十六轮残局「确定」键：egBar 最左一颗 + 锁定态文案/浅绿高亮 + 基准快照 + 离开模式即清',
  /<button id="btn_eg_ok" class="btn">确定<\/button>/.test(HTML) &&                        // 最左边一颗
  /'egBar','btn_eg_ok','btn_eg_seq','btn_eg_free','egKeys','btn_eg_b','btn_eg_w'/.test(JS) &&
  /egLocked: false, egBase: null,/.test(JS) &&                                             // 持久化字段
  /els\.btn_eg_ok\.onclick = function \(\) \{/.test(JS) &&
  /S\.egBase = G\.moves\.map\(function \(m\) \{ return \[m\.x, m\.y, m\.c\]; \}\);/.test(JS) &&
  /S\.egLocked = true;/.test(JS) &&
  /els\.btn_eg_ok\.textContent = S\.egLocked \? T\('egOkOn'\) : T\('egOk'\);/.test(JS) &&
  /els\.btn_eg_ok\.classList\.toggle\('eg-ok', !!S\.egLocked\);/.test(JS) &&
  /\.btn\.eg-ok\{background:#cbe8d2/.test(CSS) &&                                          // 已确定 = 浅绿
  /if \(S\.mode === 'endgame'\) \{ S\.egLocked = false; S\.egBase = null; \}/.test(JS) &&     // ★十八轮：进残局 = 重新摆（清基准）
  /S\.mode = 'place';/.test(JS) &&                                                   // 确定后自动跳「摆盘」
  /egLockedHint: '残局已确定，已自动切到「摆盘」/.test(JS) &&
  /egOk: '确定', egOkOn: '已确定',/.test(JS) && /egOk: 'Confirm', egOkOn: 'Confirmed',/.test(JS) &&
  /egLockedHint: '残局已确定/.test(JS) && /egLockedHint: 'Endgame confirmed/.test(JS) &&
  /if \(els\.btn_eg_ok\) els\.btn_eg_ok\.textContent = S\.egLocked \? d\.egOkOn : d\.egOk;/.test(JS));
ok('★ 十九轮「重新开始」= 整个局面消失（这局已存进历史）；打开历史才重新展开残局',
  !/function egRestoreBase\(/.test(JS) &&                                        // 十九轮：不再把基准铺回棋盘
  /S\.egLocked = false; S\.egBase = null;\n  if \(!keepLoaded\) G\.loaded = null;/.test(JS) &&  // resetGame 里清基准（不 restore）
  /if \(S\.egLocked\) return;/.test(JS) &&                                       // 确定过的残局不开交换流程
  /else if \(S\.mode === 'endgame'\) \{ rec\.eg = true; rec\.egLen = G\.moves\.length; \}/.test(JS) &&  // ★十九轮：残局模式直接存的记录也是残局
  /egLen = S\.egBase\.length; \}/.test(JS));                                     // 确定过的 = egBase 长度
ok('★ 二十轮：历史抽屉「保存历史」右边加「全部选中」（全选中时变「取消全选」）',
  /<button id="dr_all" class="btn dr-allbtn">全部选中<\/button>/.test(HTML) &&
  HTML.indexOf('id="dr_all"') > HTML.indexOf('id="t_saved"') &&                  // 位置：保存历史页签右边
  /'drawer','drList','drCount','dr_save','dr_open','dr_del','dr_close','dr_all',/.test(JS) &&
  /function drAllSelected\(\) \{/.test(JS) &&
  /if \(els\.dr_all\) els\.dr_all\.onclick = function \(\) \{/.test(JS) &&
  /els\.dr_all\.textContent = drAllSelected\(\) \? T\('selNone'\) : T\('selAll'\);/.test(JS) &&
  /selAll: '全部选中', selNone: '取消全选',/.test(JS) &&
  /selAll: 'Select all', selNone: 'Clear',/.test(JS) &&
  /\.dr-allbtn\{padding:\.3rem \.55rem; font-size:\.8rem; margin-left:\.35rem\}/.test(CSS));
ok('★ 十七轮首手预算随思考时间（09-27 放宽 60s 防呆上限）+ 首手预计秒数与全程区间（前瞻 + 计算评估）',
  /Math\.max\(4000, Math\.min\(60000, \(S\.turnMs \|\| 400\) \* 4\)\)/.test(JS) &&
  /fwdEta: '计算中 · 首手预计 \{d\} 秒内给出/.test(JS) &&
  /fwdEta: 'Computing - first move within \{d\}s/.test(JS) &&
  /var deepMs = Math\.max\(4000, Math\.min\(60000, \(S\.turnMs \|\| 400\) \* 4\)\);/.test(JS) &&
  /var loS = Math\.round\(\(deepMs \+ thinkMs \* 8\) \/ 1000\);/.test(JS) &&
  /var hiS = Math\.round\(\(deepMs \+ thinkMs \* 40\) \/ 1000\);/.test(JS) &&
  /msg\.textContent = T\('fwdEta'\)\.replace\('\{d\}', String\(Math\.ceil\(deepMs \/ 1000\)\)\)/.test(JS) &&
  /anEta: '计算中… 预计 \{s\} 秒内给出',/.test(JS) &&
  /anEta: 'Computing… expect within \{s\}s',/.test(JS) &&
  /var calcMs = Math\.min\(60000, Math\.round\(\(S\.turnMs \|\| 2000\) \* 1\.6\)\);/.test(JS) &&
  /renderAna\(T\('anEta'\)\.replace\('\{s\}', String\(Math\.ceil\(calcMs \/ 1000\)\)\)\);/.test(JS));
ok('★ 十六轮攻防修正：显式行棋方（引擎不再站到对面）+ 末子反色重排 + 引擎侧两处同款',
  /async function analyze\(turnMs, topN, lane, side, tag\) \{/.test(JS) &&
  /lane: lane \|\| 'main', side: \(side === 1 \|\| side === 2\) \? side : 0,/.test(JS) &&
  // ★ 2026-09-25：这两个入口的预算改走 aiTurnBudget()（关键局面加权，基准仍是 S.turnMs）
  // ★ 三十三轮：两个入口再升级为 analyzeVote 票箱（moveVoteSkip 给热力图让出 sub 车道）
  /var r = await analyzeVote\(aiTurnBudget\(\), 1, curColor\(\), warm, null, T\('tagAiMove'\)\);/.test(JS) &&   // aiMove
  /var r = await analyzeVote\(aiTurnBudget\(\), 1, curColor\(\), awarm, null, T\('tagAssist'\)\);[\s\S]{0,600}?var gd2 = mustAnswer/.test(JS) &&
  /analyze\(Math\.max\(400, Math\.min\(900, S\.turnMs\)\), 1, 'sub', 3 - curColor\(\), T\('tagTen'\)\)/.test(JS) &&   // 十打虚拟子后轮到对手
  /cid: 'defA-' \+ gen \+ '-' \+ r, lane: 'fwd', side: me,/.test(JS) &&
  /cid: 'defB-' \+ gen \+ '-' \+ r, lane: 'fwd', side: 3 - me,/.test(JS) &&
  /analyze\(probeMs, 2, 'sub', 3 - mine, T\('tagBal2'\)\)/.test(JS) &&
  /function applySideToMove\(out, side\) \{[\s\S]*?var wantLast = 3 - side;[\s\S]*?out\.push\(m\);/.test(ENGINEJS) &&
  /toEngineMoveList\(board, body\.moveList, side\)/.test(ENGINEJS) &&
  /var moves = toEngineMoveList\(board, body\.moveList, side\);/.test(ENGINEJS));
ok('★ 十六轮必应校验（权威攻防次序）：连五 → 堵成五点 → 活三必应 → 否则听引擎',
  /function winPoints\(b, c, rule\) \{/.test(JS) &&
  /function fourPoints\(b, c, rule\) \{/.test(JS) &&
  /function openFourPoints\(b, c, rule\) \{/.test(JS) &&
  /function nearAnyStone\(b, x, y\) \{/.test(JS) &&
  /function mustAnswer\(b, cc, cands, op, of, myFour\) \{/.test(JS) &&
  /var i, j, w = winPoints\(b, cc, engineRule\(\)\);[\s\S]{0,200}?if \(w\.length\) return \{ x: w\[0\]\.x, y: w\[0\]\.y, why: 'win' \};/.test(JS) &&
  /return \{ x: op\[0\]\.x, y: op\[0\]\.y, why: 'block5' \};/.test(JS) &&
  /if \(of && of\.length && !myFour\) \{/.test(JS) &&
  /return \{ x: of\[0\]\.x, y: of\[0\]\.y, why: 'block4' \};/.test(JS) &&
  /var pick = quick\.length \? \{ x: quick\[0\]\.x, y: quick\[0\]\.y, why: 'win' \}/.test(JS) &&      // 推演接入
  /var gd = mustAnswer\(G\.board, curColor\(\), cs, winPoints\(G\.board, 3 - curColor\(\), engineRule\(\)\), null, 1\);/.test(JS) &&
  /if \(gd\) best = \[gd\.x, gd\.y\];/.test(JS) &&                                          // aiMove 接入
  /if \(gd2\) best = \[gd2\.x, gd2\.y\];/.test(JS));                                        // 辅助一手接入
ok('★ 十六轮推演：能连五直接连（省一次搜索）+ 落子前算好 op/of/myFour + 无四才让引擎选点',
  /quick = winPoints\(b, cc, engineRule\(\)\);/.test(JS) &&
  /if \(!quick\.length\) \{[\s\S]{0,400}?op = winPoints\(b, 3 - cc, engineRule\(\)\);[\s\S]{0,400}?of = openFourPoints\(b, 3 - cc, engineRule\(\)\);/.test(JS) &&
  /if \(of\.length\) myFour = fourPoints\(b, cc, engineRule\(\)\)\.length;/.test(JS) &&
  /if \(!quick\.length\) \{                                          \/\/ 能连五 → 不必再问引擎/.test(JS) &&
  /G\.fwd\.line\.push\(\{ x: pick\.x, y: pick\.y, c: cc \}\);/.test(JS));
ok('★ 廿二轮：算杀线截到「连五那一手」为止（五子已定，不再多一手防守方堵子）',
  /var cut = vcx\.line\.length;/.test(JS) &&
  /if \(winCheck\(bb, m\.x, m\.y, m\.c\)\) \{ cut = i \+ 1; break; \}/.test(JS) &&
  /var line = vcx\.line\.slice\(0, cut\);/.test(JS) &&
  /G\.fwd\.vcxMarks = fwdVcxMarks\(b, line, from\);/.test(JS) &&
  /for \(var j = 0; j < line\.length; j\+\+\) G\.fwd\.line\.push\(line\[j\]\);/.test(JS));
ok('★ 廿一轮：撤销「唯一堵点跳过引擎」—— 每一手都问引擎，必应judge放在候选之后',
  !/\bforced = op\[0\]/.test(JS) &&                                     // 十七轮的强制落子已删
  !/if \(!quick\.length && !forced\)/.test(JS) &&
  /if \(!quick\.length\) \{                                          \/\/ 能连五 → 不必再问引擎/.test(JS) &&
  /var pick = quick\.length \? \{ x: quick\[0\]\.x, y: quick\[0\]\.y, why: 'win' \}\n              : mustAnswer\(b, cc, cands, op, of, myFour\);/.test(JS));
ok('★ 廿一轮：连五判据按**当前规则**（不再硬编码自由局）+ 已连五时不再去堵',
  (JS.match(/findWinLine\(b, engineRule\(\)\)/g) || []).length >= 2 &&
  !/findWinLine\(b, 0\)/.test(JS) &&
  // mustAnswer 开头：盘面已有连五 → 一律交回引擎，绝不主动堵
  /if \(findWinLine\(b, engineRule\(\)\)\) return null;/.test(JS) &&
  // ② 只在唯一必堵点改手（两个以上成五点 = 已被双杀，尊重引擎选择）
  /if \(op && op\.length === 1\) \{/.test(JS));
// ★★ 廿三轮（用户报「VCF / VCT 有一点小瑕疵」＋「对齐 Rapfi 官方算法」）：
//   Rapfi 的 VCF / VCT 是**威胁空间搜索** —— 根节点必须由**进攻方执子**。旧版把回探放在
//   攻方刚落完一手之后（那时其实轮到防守方）→ 搜出来的是「攻方连走两手」的非法线
//   （真机实证：F4 黑 → F2 黑 两连手；而 F4 已成四，本该轮到白方在 F2 必应）。
//   修法：① 回探提前到**攻方行棋之前**（第 0 手除外，开局分析已查过）；
//        ② 算杀器两个入口都加「不是进攻方的回合 → 直接判无解」的守卫（非法问法连问都不给）。
//   行为回归见 tools/test-vcx-rules.js（纯 JS，逐手复演校验：颜色交替 / 每手冲四 / 守方被迫）。
{
  var _pushIdx = JS.indexOf('G.fwd.line.push({ x: pick.x, y: pick.y, c: cc });');
  ok('★ 廿三轮：算杀根节点必须轮进攻方（回探在引擎取点之前 + 两处入口守卫）',
    /if \(wantVcx && step > 0 && cc === atkFix\) \{/.test(JS) &&
    JS.indexOf('if (wantVcx && step > 0 && cc === atkFix)') < JS.indexOf('r = await LocalAI.analyze({ board: b') &&
    (JS.match(/if \(atkSel && atkSel !== toMove\) return null;/g) || []).length === 1 &&
    (JS.match(/if \(atkSel && atkSel !== toMove\) \{ resolve\(null\); return; \}/g) || []).length === 1 &&
    (JS.match(/var toMove = \(total % 2 === 0\) \? 1 : 2;/g) || []).length >= 2 &&      // 同步/异步两处同口径
    _pushIdx > 0 && JS.indexOf('fwdTryVcx', _pushIdx) < 0 &&                            // 落子之后不再有算杀回探
    /VCF \/ VCT 是威胁空间搜索/.test(JS));
}
ok('★ 廿三轮：算杀器的「成五」口径跟随规则（标准规则下长连不算赢）',
  (JS.match(/VCX_EXACT_1 = exactFiveFor\(rule, 1\);/g) || []).length === 1 &&            // 同步入口
  (JS.match(/var ex1 = exactFiveFor\(rule, 1\), ex2 = exactFiveFor\(rule, 2\);/g) || []).length === 1 &&
  /VCX_EXACT_1=!!d\.ex1;VCX_EXACT_2=!!d\.ex2;/.test(JS) &&                              // Worker 注入
  /',VCX_EXACT_1=' \+ \(ex1 \? 'true' : 'false'\) \+/.test(JS) &&
  /ex1: ex1, ex2: ex2,/.test(JS) &&                                                     // 随消息下发
  /if \(c === 1 \? VCX_EXACT_1 : VCX_EXACT_2\) \{/.test(JS) &&                          // vcxAnalyze
  /if \(def === 1 \? VCX_EXACT_1 : VCX_EXACT_2\) \{/.test(JS));                         // vcxDefCanFive
// ★★ 廿三轮（用户要求）：「有残局状态存进历史 → 打开这个历史，第一眼应该是**还没有额外落子前**的
//   残局布局」。此前 recordForReview 只搬 moves，eg/egLen/vc 全被丢掉 → 复盘窗第一眼是空盘、
//   背诵/回顾从第一颗子开始（reviewLoad 的 egLen 分支形同虚设）。
// ★★ 廿四轮（用户要求）：「不管是在识别的图片，还是在抽屉里面，双击这个图片会引起系统里面的
//   默认图片软件打开」—— 页面手里只有 dataURL（WebView2 没文件系统/「打开方式」），
//   所以双击 → tellHost openImage → 宿主落 %TEMP%\gbvis-open-<n>.<ext> + ShellExecuteW("open")。
ok('★ 廿四轮：双击图片 = 用系统默认看图软件打开（识图窗大图 + 抽屉缩略图两条路）',
  /function visOpenImage\(i\) \{/.test(JS) && /function visImageExt\(d\) \{/.test(JS) &&
  /els\.visImg\.ondblclick = function \(\) \{ visOpenImage\(VIS\.idx\); \};/.test(JS) &&
  /d\.ondblclick = function \(ev\) \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); visOpenImage\(i\); \};/.test(JS) &&
  /tellHost\(\{ type: 'openImage', idx: i \+ 1, ext: ext, data: it\.d \}\);/.test(JS) &&
  /\[T\('visOpenApp'\), false, function \(\) \{ visOpenImage\(i\); \}\]/.test(JS) &&      // 右键菜单等价入口
  /visOpenApp: '用系统看图软件打开'/.test(JS) && /visOpenApp: 'Open in the system image viewer'/.test(JS) &&
  // 宿主侧：报文分支 + 落盘 + ShellExecuteW("open") + 测试钩子
  /if \(s\.find\("\\"openImage\\""\) != std::string::npos\) \{/.test(HOST) &&
  /static void OpenImageFromPage\(const std::string& s\) \{/.test(HOST) &&
  /gbvis-open-/.test(HOST) &&
  /ShellExecuteW\(nullptr, L"open", path\.c_str\(\), nullptr, nullptr, SW_SHOWNORMAL\)/.test(HOST) &&
  /TestFlag\("GB_TEST_OPEN_IMAGE"\)/.test(HOST));
ok('★ 廿三轮：残局/VC 标记随记录一起投到复盘窗（eg/egLen/vc 不再被丢）',
  /eg: !!\(h && h\.eg\), egLen: \(h && h\.egLen\) \|\| 0, vc: !!\(h && h\.vc\),/.test(JS) &&
  /var egLen = \(rec && rec\.eg && rec\.egLen > 0\) \? Math\.min\(rec\.egLen, mv\.length\) : 0;/.test(JS) &&
  /if \(egFirst \|\| egLen > 0\) \{/.test(JS) &&                                        // 首帧 = 前 egLen 手（残局）
  /var k0 = \(G\.loaded\.egLen > 0\) \? G\.loaded\.egLen : 0;/.test(JS));               // 背诵/回顾从残局之后数起
ok('★ 十七轮：开机热身（页面内 wasm + :8964 服务端都做）—— 冷启动开销前置，首次计算不再慢',
  /cid: 'warmup', lane: sp\.lane\.name, side: 1 \}, sp\.lane\)/.test(ENGINEJS) &&
  /laneSerial\(sp\.lane, function \(\) \{/.test(ENGINEJS) &&
  /cid: 'warmup', lane: lw\.name, side: 1 \}, lw\)/.test(SERVERJS) &&
  /for \(const lw of \[LANES\.main, LANES\.sub, LANES\.fwd\]\)/.test(SERVERJS));
ok('★ 十八轮：残局「确定」→ 自动跳「摆盘」；进残局=重新摆；历史记录带 eg/egLen 并标 Endgame',
  /S\.egBase = G\.moves\.map\(function \(m\) \{ return \[m\.x, m\.y, m\.c\]; \}\);/.test(JS) &&
  /S\.mode = 'place';[\s\S]{0,220}?x\.classList\.toggle\('on', x\.getAttribute\('data-mode'\) === 'place'\);/.test(JS) &&
  /if \(S\.mode === 'endgame'\) \{ S\.egLocked = false; S\.egBase = null; \}/.test(JS) &&
  /rec\.eg = true; rec\.egLen = S\.egBase\.length;/.test(JS) &&                             // 重新开始自动存历史
  /\{ rec\.eg = true; rec\.egLen = S\.egBase\.length; \}/.test(JS) &&                       // 保存历史同款
  /egTag\.className = 'tag'; egTag\.textContent = 'Endgame';/.test(JS) &&                   // 历史徽标
  /\.dr-list \.item \.tag\{font-size:\.72rem; padding:\.08rem \.34rem; border-radius:5px;/.test(CSS) &&
  /if \(h\.eg && !RV_MODE\) \{/.test(JS) &&                                                  // 主窗打开=摆盘+基准就位
  /S\.egBase = mv\.slice\(0, baseN\)\.map\(function \(m\) \{ return \[m\.x, m\.y, m\.c\]; \}\);/.test(JS));
ok('★ 十八轮：复盘背诵/回顾从「确定的残局」开始（egLen 首帧），不从第一颗子起',
  /var egLen = \(rec && rec\.eg && rec\.egLen > 0\) \? Math\.min\(rec\.egLen, mv\.length\) : 0;/.test(JS) &&
  /egLen: egLen \}/.test(JS) &&                                                            // loaded 带 egLen
  /mv\.slice\(0, egFirst \? mv\.length : egLen\)\.forEach/.test(JS) &&                      // 首帧=整个残局
  /var k0 = \(G\.loaded\.egLen > 0\) \? G\.loaded\.egLen : 0;/.test(JS) &&
  /G\.review = \{ kind: 'recite', k: k0, miss: 0, missAt: \{\} \};/.test(JS) &&
  /G\.review = \{ kind: 'replay', k: k0, miss: 0, missAt: \{\} \};/.test(JS));

// ---------------------------------------------------------------- 新引擎连接后端（2026-09-25）
// 用户要求：「用合理高效的手段重新构建连接的后端，更好的连接原生引擎」。
// 旧后端 = Worker 每 15ms fetch :8965/engine/out 轮询（三车道 ≈ 200 次 HTTP/秒常驻）+ 每次
// 发令一个 POST。新后端 = 事件驱动推模式：宿主读线程 → PostMessage → 宿主主线程 →
// PostWebMessageAsJson → 页面主线程 → postMessage → Worker。零 HTTP、零轮询。
ok('★ 新引擎后端：宿主把引擎输出**推**给页面（PostMessage 触发 flush，不再轮询）',
  /kMsgEngineFlush = WM_APP \+ 10/.test(HOST) &&
  /g_engineFlushPending\.exchange\(true\)/.test(HOST) &&   // 合并：同一窗口内的多行只排一次
  /case kMsgEngineFlush:/.test(HOST) &&
  /nativeeng::FlushToPage\(\);/.test(HOST) &&
  /RequestEngineFlush\(\);/.test(HOST) &&                  // 读线程拿到新行就请求推
  /\{\\"type\\":\\"engineOut\\",\\"lanes\\":\[/.test(HOST));
ok('★ 新引擎后端：页面→引擎走 WebView 消息（cmd/ensure/reset/status 一次一批命令）',
  /\\"engine\\"/.test(HOST) && /\\"op\\":/.test(HOST) &&
  /JsonStrArray\(s, /.test(HOST) &&                       // 命令按 JSON 数组传（不塞 \n 单串）
  /nativeeng::HandlePageCmd\(op, idx, cmds, id\)/.test(HOST) &&
  /type\\":\\"engineAck/.test(HOST) &&
  /static std::vector<std::string> JsonStrArray/.test(HOST));
ok('★ 新引擎后端：Worker 走主线程转发（__host / __relay），RELAY 打开时停掉 HTTP 轮询',
  /var RELAY = false;/.test(JS_AI) &&
  /function relayPost\(op, lane, cmds\) \{/.test(JS_AI) &&
  /self\.postMessage\(\{ type: '__host', payload: \{ type: 'engine', op: op, lane: lane\.name,/.test(JS_AI) &&
  /if \(stopped \|\| RELAY\) return;/.test(JS_AI) &&          // ★ 走通道后不再轮询
  /RELAY = !!d\.relay;/.test(JS_AI) &&
  /d\.type === '__relay'/.test(JS_AI) &&
  /relay: function \(m\) \{/.test(JS) &&                      // 主线程转发宿主回推
  /LocalAI\.relay\(m\);/.test(JS) &&
  /wk\.postMessage\(\{ type: 'boot', threads: cfgT, hashKB: cfgKB, relay: HOST \}\);/.test(JS));
// ★ 棋力根因之一（实测到）：main 车道是唯一决定落子强度的车道，旧比例只给 60% 再减 2
//   → 16 核/CFG.threads=12 时 main=7；而 WASM 版 cpuAll-1=15 → main=9。**算力更强的原生版
//   主力搜索反而少 2 个线程**，这就是「网页版算力低却更强」的直接来源。
// ★★ 2026-09-27 深夜（用户要求「取消投票，单实例满线程」）：main 吃满所选核心数，sub/fwd 各 1 线程
ok('★ 车道线程向 main（落子强度车道）满编：main = cpuN（用户所选），sub/fwd 各 1 线程视图小实例',
  /var mainT = cpuN;/.test(JS_AI) &&
  /var subT = 1;/.test(JS_AI) &&
  /var fwdT = 1;/.test(JS_AI) &&
  !/var reserve/.test(JS_AI));
ok('★ 车道哈希向 main 满编（boot 与热改哈希同一套口径：sub/fwd 各 64MB、其余归 main）',
  /var auxH = \(hashKB >= 3 \* 65536\) \? 65536/.test(JS_AI) &&
  /var mainH = Math\.max\(64, hashKB - 2 \* auxH\);/.test(JS_AI) &&
  /var aux = \(total >= 3 \* 65536\) \? 65536/.test(JS_AI) &&
  /return Math\.max\(64, total - 2 \* aux\);/.test(JS_AI));

// ★★ 2026-09-25（用户澄清「禁手模式中，不能下的位置是红叉」）：红叉 = **模式属性**，
//   连珠系规则一开就常驻（旧版只在「轮到黑方」时画，白方回合完全没有叉）；
//   轮到白方时整批减淡（那些点只对黑方是禁手）+ 对弈模式点上去**真的下不了** + 悬停变红框。
ok('★ 禁手红叉常驻（不再限「轮到黑方」）+ 轮白减淡 + 对弈点击拦截 + 悬停红框',
  /function forbiddenMarks\(\) \{/.test(JS) &&
  /if \(RV_MODE \|\| !renjuRule\(\) \|\| G\.over\) return \[\];/.test(JS) &&   // ★ 不再看 curColor()
  !/curColor\(\) !== 1\) return \[\];/.test(JS) &&                            // 旧口径已删除
  /ctx\.globalAlpha = \(curColor\(\) === 1\) \? 1 : 0\.45;/.test(JS) &&       // 轮白减淡
  /function forbiddenAt\(x, y\) \{/.test(JS) &&                               // 命中测试复用缓存
  /if \(S\.mode === 'pve' && curColor\(\) === 1 && renjuRule\(\) && forbiddenAt\(x, y\)\) \{/.test(JS) &&
  /setStat\(null, T\('fbBlocked'\)\); paint\(\); return;/.test(JS) &&
  /fbBlocked: '禁手：黑方不能下在这里/.test(JS) &&
  /fbBlocked: 'Forbidden: Black may not play here/.test(JS) &&
  /var hForbid = \(!VIS && !RV_MODE && renjuRule\(\) && forbiddenAt\(G\.hover\.x, G\.hover\.y\)\);/.test(JS));

// 同上：红叉画在哪里必须由判定说了算 —— 真跑一遍 vcxForbidden（RIF / gomocalc 口径：
// 禁手**只有**长连 / 四四 / 三三 三类，四三合法，成五永远合法）。
// 改坏了不报错，只会悄悄把「能下的点」画成叉 / 把禁手漏掉。
ok('★ 禁手判定数值回归：三三 / 四四 / 长连 = 禁手；四三 / 成五 / 单活三 / 普通点 = 合法',
  (() => {
    try {
      // ★ 2026-09-25（完整 RIF 移植）：vcxForbidden 依赖同片区的常量与 vcxLineOf/vcxLinePat/
      //   vcxLinePatWin/vcxFused4 —— 提取范围必须从常量块起点切到函数尾（缺一即 ReferenceError）。
      const i = JS.indexOf('var VCX_PAT_DEAD = 0');
      const iv = JS.indexOf('function vcxForbidden(b, x, y) {');
      if (i < 0 || iv < 0 || iv < i) return false;
      let d = 0, end = -1;
      for (let k = JS.indexOf('{', iv); k < JS.length; k++) {
        if (JS[k] === '{') d++;
        else if (JS[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
      }
      if (end < 0) return false;
      const N = 15;
      const vcxForbidden = new Function('N', JS.slice(i, end) + '; return vcxForbidden;')(N);
      const mk = (pts, wpts) => {
        const b = [];
        for (let y = 0; y < N; y++) { b.push([]); for (let x = 0; x < N; x++) b[y].push(0); }
        pts.forEach((p) => { b[p[1]][p[0]] = 1; });
        (wpts || []).forEach((p) => { b[p[1]][p[0]] = 2; });
        return b;
      };
      // ★ 2026-09-25（用户贴 gomocalc 截图报「错了」）：这就是截图里的局面（可见 17 手），
      //   那两个红叉 (5,6) / (6,4) 落黑都是「冲四 + 活三」= **四三**。
      //   RIF / gomocalc 判**合法**（旧代码把四三也当禁手 → 红叉 + 拦住落子 + VCF 漏杀）。
      const SH_B = [[4,5],[5,5],[4,6],[6,6],[7,6],[6,7],[4,8],[6,8],[8,8]];
      const SH_W = [[3,5],[7,5],[8,6],[4,7],[5,7],[7,7],[5,8],[4,9]];
      return [
        [mk([[5,7],[6,7],[7,5],[7,6]]), 7, 7, true],    // 三三
        [mk([[4,7],[5,7],[6,7],[7,4],[7,5],[7,6]]), 7, 7, true], // 四四
        [mk([[4,7],[5,7],[6,7],[8,7],[9,7]]), 7, 7, true],       // 长连
        [mk([[5,7],[6,7],[8,7],[9,7]]), 7, 7, false],   // 正好成五（合法）
        [mk([[5,7],[6,7]]), 7, 7, false],               // 单个活三（合法）
        [mk([[7,7]]), 8, 8, false],                     // 普通点
        [mk(SH_B, SH_W), 5, 6, false],                  // ★ 截图红叉①：四三（合法）
        [mk(SH_B, SH_W), 6, 4, false],                  // ★ 截图红叉②：四三（合法）
      ].every((c) => vcxForbidden(c[0], c[1], c[2]) === c[3]);
    } catch (e) { return false; }
  })());
// 同一局面整体扫一遍：截图里那两个点必须是**唯一**被误标的两个（修复后应为 0 个禁手点）。
ok('★ 截图局面禁手点扫描：四三被误标已清零（该局面 RIF 禁手点 = 0）',
  (() => {
    try {
      const i = JS.indexOf('var VCX_PAT_DEAD = 0');
      const iv = JS.indexOf('function vcxForbidden(b, x, y) {');
      if (i < 0 || iv < 0 || iv < i) return false;
      let d = 0, end = -1;
      for (let k = JS.indexOf('{', iv); k < JS.length; k++) {
        if (JS[k] === '{') d++;
        else if (JS[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
      }
      if (end < 0) return false;
      const N = 15;
      const vcxForbidden = new Function('N', JS.slice(i, end) + '; return vcxForbidden;')(N);
      const b = [];
      for (let y = 0; y < N; y++) { b.push([]); for (let x = 0; x < N; x++) b[y].push(0); }
      [[4,5],[5,5],[4,6],[6,6],[7,6],[6,7],[4,8],[6,8],[8,8]].forEach((p) => { b[p[1]][p[0]] = 1; });
      [[3,5],[7,5],[8,6],[4,7],[5,7],[7,7],[5,8],[4,9]].forEach((p) => { b[p[1]][p[0]] = 2; });
      const hits = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (b[y][x]) continue;
        let near = false;
        for (let yy = Math.max(0, y - 2); yy <= Math.min(N - 1, y + 2) && !near; yy++)
          for (let xx = Math.max(0, x - 2); xx <= Math.min(N - 1, x + 2); xx++)
            if (b[yy][xx]) { near = true; break; }
        if (!near) continue;
        if (vcxForbidden(b, x, y)) hits.push(x + ',' + y);
      }
      return hits.filter((h) => h === '5,6' || h === '6,4').length === 0 && hits.length === 0;
    } catch (e) { return false; }
  })());

function finishAll() {
  console.log('\n== test-calculator: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
}

main();
