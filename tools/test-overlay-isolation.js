/* 桌面覆盖层「进程隔离 / 稳定性 / 拖动」契约测试
 * ============================================================================
 * 这里守的是三件很容易被改回去的事：
 *
 *  ① 进程隔离：覆盖层必须与「网页书签启动器 GomokuEngine.exe」互不相干。
 *     历史问题：两者共用 Global\GomokuSuite_v1 互斥体 → 开着书签版就起不来桌面版，
 *     反之亦然（用户明确要求「分开进程，与浏览器的书签启动器不相干」）。
 *
 *  ② 稳定性：面板窗口异常销毁（WebView2 崩溃）时不能把整个程序带走。
 *     历史问题：面板 WM_DESTROY 里无条件 PostQuitMessage → 面板一崩，
 *     连全屏四角框 / 棋盘框 / 识别一起消失，用户看到「程序自己没了」。
 *     现在改为**跨进程计数**的自愈重启，且超过 3 次不再重启（绝不无限重启）。
 *
 *  ③ 拖动与置顶：拖动期间必须让开窗口操作（否则和系统模态移动循环抢位置 → 抖、不跟手），
 *     并且要定期重申置顶（否则被别的置顶窗口盖住就再也回不到上面）。
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOST = path.join(ROOT, 'desktop-overlay', 'src', 'host.cpp');
// ★ 2026-09-19 修正：exe 改名带 Desktop 前缀（与网页端 Web GomokuEngine.exe 区分）。
//   旧名在 build 目录里只剩一个 2026-09-17 的陈旧二进制，于是下面的「启动行为检查」一直在
//   被**静默跳过**（走了 existsSync 的 else 分支），看起来全绿其实什么都没验。
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
const EXE_NAME = 'Desktop GomokuOverlay.exe';
const LOG = path.join(ROOT, 'desktop-overlay', 'build', '_iso_test.log');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 剥掉注释再做源码断言。
 *  两个坑，都踩过：
 *   ① 这些改动都带「以前是 XX，为什么改成 YY」的说明注释，注释里会**原样出现旧实现的名字**
 *      （例如旧互斥体名）。不剥掉的话，一次正确的改写反而会被自己的说明文字判成「旧代码还在」。
 *   ② 绝不能用跨行的块注释正则（星号斜杠配对那种）：本文件里有一行注释写着
 *      「虚拟主机映射：https 冒号斜杠斜杠 gb.local 斜杠星号 → …」，那个「斜杠星号」
 *      会被当成块注释开头，一路吞到几十行之后的结束符，把中间真正的代码整段删掉，
 *      断言随即莫名其妙地失败。所以这里**逐行**处理：整行注释扔掉，行尾注释截断。
 *  实现上刻意不写正则字面量（斜杠在源码里太容易歧义），直接用 indexOf。 */
function stripComments(s) {
  const SLASH2 = '/' + '/';
  return s.split('\n').map((line) => {
    const t = line.trim();
    if (t.startsWith('/*') || t.startsWith('*') || t.startsWith(SLASH2)) return '';
    let i = line.indexOf(SLASH2);
    // 前一个字符是冒号 => 属于 URL 里的「http 冒号斜杠斜杠」，不是注释
    while (i > 0 && line.charAt(i - 1) === ':') i = line.indexOf(SLASH2, i + 2);
    return i < 0 ? line : line.slice(0, i);
  }).join('\n');
}

/** 取某处的源码片段。
 *  needle 一定要带函数体的左大括号（`static void Foo() {`），
 *  否则会先匹配到文件顶部的前向声明 `static void Foo();`，拿到的是一段无关代码。 */
function sliceFn(src, needle, len = 1800) {
  const i = src.indexOf(needle);
  return i < 0 ? '' : src.slice(i, i + len);
}
const sliceLast = (src, needle, len = 1200) => {
  const i = src.lastIndexOf(needle);
  return i < 0 ? '' : src.slice(i, i + len);
};

(async () => {
  console.log('== 覆盖层：进程隔离 / 稳定性 / 拖动 ==');
  if (!fs.existsSync(HOST)) { console.error('找不到 ' + HOST); process.exit(1); }
  const src = stripComments(fs.readFileSync(HOST, 'utf8'));

  // ---------------- ① 与网页书签启动器进程隔离 ----------------
  check('互斥体是覆盖层专属（Global\\GomokuOverlay_v1）',
    /Global\\\\GomokuOverlay_v1/.test(src),
    (src.match(/L"Global\\\\[A-Za-z0-9_]+/) || [''])[0]);
  check('不再共用两件套互斥体 GomokuSuite_v1',
    !/GomokuSuite_v1/.test(src),
    (src.match(/GomokuSuite_v1/) || ['无'])[0]);
  {
    // SuiteRoot 里 GomokuOverlay.exe 必须排在 GomokuEngine.exe **之前**：
    // 否则在只装了覆盖层的机器上会找不到资源根目录。
    const fn = sliceFn(src, 'static std::wstring SuiteRoot() {');
    // 判据必须是**资源目录**而不是 exe 自己：开发期 exe 在 desktop-overlay/build 里，
    // 拿它当判据会一上来就命中、永远回溯不到仓库根，于是找不到引擎与识别服务。
    const iRes = fn.indexOf('L"overlay');
    const iEng = fn.indexOf('GomokuEngine.exe');
    check('资源根目录以「自己的资源目录」为首要判据（先于 GomokuEngine.exe）',
      iRes >= 0 && iEng >= 0 && iRes < iEng, 'res@' + iRes + ' eng@' + iEng);
    check('不以 GomokuOverlay.exe 自身当资源根判据（否则开发期回溯不到仓库根）',
      !/Join\(d, L"GomokuOverlay\.exe"\)/.test(fn));
  }
  check('不再提示用户「两者只开其一」',
    !/请只打开其中一个|网页引擎 GomokuEngine\.exe/.test(src));
  {
    const fn = sliceFn(src, 'static void EnsureEngine() {', 1400);
    check('引擎按「无界面后端」拉起（--as-backend）', /--as-backend/.test(fn));
  // 网页端 exe 已改名「Web GomokuEngine.exe」，日志文案随之调整（旧名仍兼容）
  check('引擎起不来时覆盖层继续跑（只是记录日志，不退出）',
    /engine exe not found/.test(fn) && !/PostQuitMessage|exit\(/.test(fn));
  }

  // ---------------- ② 面板异常销毁 → 自愈，而不是整个退出 ----------------
  {
    const fn = sliceLast(src, 'case WM_DESTROY:', 1200);
    check('面板 WM_DESTROY 区分「主动退出」与「意外销毁」', /g_exiting/.test(fn));
    check('意外销毁走自愈而不是直接退出', /RestartForPanelRecovery\(\)/.test(fn));
  }
  {
    const fn = sliceFn(src, 'static void RestartForPanelRecovery() {', 2600);
    check('自愈有次数上限，不会无限重启', /MAX_RECOVER\s*=\s*3/.test(fn), 'MAX_RECOVER=3');
    check('超限后不退出（保留覆盖层与识别继续运行）',
      /g_panelRecoveries >= MAX_RECOVER/.test(fn) &&
      !/g_panelRecoveries >= MAX_RECOVER[\s\S]{0,300}PostQuitMessage/.test(fn));
    check('自愈次数**跨进程**传递（否则重启后计数归零 → 无限重启）',
      /GB_PANEL_RECOVER/.test(fn) && /SetEnvironmentVariableW\(L"GB_PANEL_RECOVER"/.test(fn));
    check('自愈重启前不提前释放互斥体（让新实例等，避免抢跑）',
      /GB_SAFE_RETRY/.test(fn) && !/ReleaseMutex/.test(fn));
  }
  check('启动时读回跨进程自愈计数',
    /GetEnvironmentVariableW\(L"GB_PANEL_RECOVER"/.test(src));

  // ---------------- ③ 拖动与置顶 ----------------
  {
    const fn = sliceFn(src, 'static void ApplyPanelRect() {', 600);
    check('拖动期间挂起窗口几何下发（不和系统模态移动循环抢位置）',
      /if \(g_panelDragging\) return;/.test(fn));
  }
  check('收到 WM_ENTERSIZEMOVE / WM_EXITSIZEMOVE（拖动起止）',
    /case WM_ENTERSIZEMOVE/.test(src) && /case WM_EXITSIZEMOVE/.test(src));
  {
    const fn = sliceFn(src, 'static void ReassertTopMost() {', 1200);
    check('定期重申置顶（防止被其它置顶窗口盖住后回不到上面）',
      /SetWindowPos\(g_overlay, HWND_TOPMOST/.test(fn) && /SetWindowPos\(g_panel, HWND_TOPMOST/.test(fn));
    check('重申置顶不移动、不改尺寸、不抢焦点',
      /SWP_NOMOVE/.test(fn) && /SWP_NOSIZE/.test(fn) && /SWP_NOACTIVATE/.test(fn));
    // 顺序：先覆盖层后面板 —— 否则全屏角框层会被抬到面板上面，角框画到面板上
    check('重申顺序为「先覆盖层、再面板」（面板保持在最上）',
      fn.indexOf('SetWindowPos(g_overlay') < fn.indexOf('SetWindowPos(g_panel'));
    check('拖动/退出期间跳过重申置顶', /if \(g_panelDragging \|\| g_exiting\) return;/.test(fn));
  }
  {
    const fn = sliceFn(src, 'case WM_TIMER:', 300);
    check('置顶保持挂在独立定时器上（w == 2）', /w == 2\) ReassertTopMost\(\)/.test(fn));
  }
  check('置顶定时器已创建', /SetTimer\(g_panel, 2, 4000, nullptr\)/.test(src));

  // ---------------- ④ 行为：隔离改造后仍能正常启动 ----------------
  if (fs.existsSync(EXE)) {
    try { fs.unlinkSync(LOG); } catch (e) {}
    const child = spawn(EXE, [], {
      detached: true, stdio: 'ignore', cwd: path.dirname(EXE),
      env: Object.assign({}, process.env, {
        GB_INSTANCE_ID: 'iso' + process.pid,
        GB_LOG_FILE: LOG,
        GB_NO_SAFE_RETRY: '1',        // 一次启动 = 一个进程，便于断言
      }),
    });
    child.unref();
    await sleep(3500);
    let alive = true;
    try { process.kill(child.pid, 0); } catch (e) { alive = false; }
    check('覆盖层能正常启动并存活（隔离改造没破坏启动链路）', alive, 'pid=' + child.pid);

    let log = '';
    try { log = fs.readFileSync(LOG, 'utf8'); } catch (e) {}
    check('启动日志说明互斥体归属（覆盖层专属）',
      /GomokuOverlay_v1|mutex acquired/.test(log));
    check('没有「已有实例在运行」而退出', !/an overlay instance is already running/.test(log));
    // 不能只断言「日志里有 [deps]」——「找不到 GomokuEngine.exe」也带 [deps]，
    // 那正是 SuiteRoot 判据写错时的表现（开发期回溯不到仓库根）。
    check('依赖被真正处理了（启动或复用，而不是「找不到」）',
      /\[deps\][^\n]*?(starting engine|starting recognition|already running, reusing)/.test(log) &&
      !/\[deps\] not found/.test(log),
      (log.match(/\[deps\][^\n]*/g) || []).join(' | ').slice(0, 140));

    try { execSync('taskkill /PID ' + child.pid + '/F /T', { stdio: 'ignore' }); } catch (e) {}
    await sleep(600);
  } else {
    console.log('  (跳过启动行为检查：还没有 desktop-overlay/build/' + EXE_NAME + ')');
  }

  console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
  process.exit(fail ? 1 : 0);
})();
