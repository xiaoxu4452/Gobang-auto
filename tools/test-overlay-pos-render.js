#!/usr/bin/env node
/**
 * 「局面」小窗渲染回归测试 —— 把「弹窗里到底有没有棋盘」变成一个可断言的数字。
 *
 * 为什么需要它：用户 2026-09-17 两次反馈同一个现象
 *   「这个局面的弹窗…而且没有出现棋盘，按键较为粗糙」
 *   「棋盘的弹窗没有棋盘，按键要小一圈，按键字体大小和主程序的一致」
 * 而根因不在数据、在渲染路径：旧实现把内容画在 WM_PAINT 的客户区，同时又给窗口调了
 * SetLayeredWindowAttributes(LWA_ALPHA) —— 实测那个组合会让**父窗自己画的客户区在屏幕上
 * 完全不可见**（只有原生 EDIT/BUTTON 子控件还看得见），于是屏幕上就是「有按键、没棋盘」。
 * 现在整窗改成全自绘 + UpdateLayeredWindow 逐像素合成（与主覆盖层同一条路径）。
 *
 * 这类「画了但没显示」的问题肉眼很容易看错（窗口有边框、按钮也在，只有内容没了），
 * 所以必须读真实屏幕像素来判断：
 *
 *   A 轮（demo 局面 / 100% 不透明 / 覆盖层铺纯绿）
 *     · boardDark  ≈ 上千 —— 棋盘卡片区里真的出现了深色像素 = **黑子画出来了**
 *     · boardGrid  ≈ 上万 —— 网格线（浅模式 #b0b8c6）真的画出来了
 *     · boardUniq  >  40  —— 卡片区不是一块纯色（网格 + 棋子 + 抗锯齿边）
 *     · hdr        ≈ 品牌蓝 #3b7dd8 —— 标题栏画出来了（窗口整体确实渲染了）
 *     · btnBlue    ≈ 高 26 设计单位 × dpr —— 主按钮「小了一圈」且确实画出来了
 *     · coordLeft/coordRight/coordBottom > 0 —— 左右行号、下方列号真的画出来了
 *     · gridX0/X1/Y0/Y1 ≈ POS_OX/POS_OY/POS_GRID —— **量出棋盘的边界**，
 *       从而证明坐标栏（13）与内衬（4）确实落在棋盘之外、两者不堆叠
 *     · codeRowsLight ≥ 4 —— 代码卡片里是 4 行（含新增的「总代码」A: 行）
 *   B 轮（空局面 / 100% / 同样铺绿）—— 反面校验
 *     · boardDark  ≈ 0 —— 没棋子就没有深色像素，证明 A 轮那条数字真的在测棋子
 *     · boardGrid  >  上千 —— 网格仍在，说明 B 轮窗口确实正常渲染（不是整块没画）
 *   C 轮（demo / 25% 不透明）—— 「只调透明度」真的生效
 *     · 卡片区透出底下的纯绿（G 明显高于 R/B）：整窗 alpha 合成到桌面上了
 *     · alphaFromHdr ≈ 0.60 —— 小窗按「最低 60%」映射，而不是跟着面板降到 0.25
 *     · boardDark150 > 60 —— 低透明度下棋子还看得见（用 <150 这个档，见下）
 *   D 轮（demo / 深色 / 100%）—— 局面小窗跟着主面板换肤
 *     · 卡片区变暗（max(rgb) < 110）、深色网格线成片、标题栏仍是品牌蓝
 *     · codeRowsDark ≥ 4 —— 夜间配色下 4 行文字同样画出来
 *     ⚠ 这一轮曾经假绿过：日志里明明有 "dark":true、截图却还是浅色卡片。根因不在渲染，
 *       而在宿主解析 —— uiLook 里 dark 是 **JSON 布尔**，早先用 strtod 去取必然失败。
 *       现在由 test-guide-layer.js 的 §⑫ 源码断言 + 本轮的像素断言双向钉住。
 *
 * ★ 覆盖层铺纯绿（GB_TEST_BACKDROP）是本测试的「已知背景」：没有它，25% 那轮的合成结果
 *   取决于桌面壁纸，没法断言。用法与 test-overlay-alpha.js 完全一致。
 *
 * ★ 每轮开跑前都会 taskkill /IM 清掉残留实例，且**每轮用一个全新的日志文件名** ——
 *   局面窗是 TOPMOST 且每轮都落在同一坐标，残留实例叠上来会让「断言测的是上一轮的画面」；
 *   更阴的是旧进程握着日志句柄时 unlink 会**静默失败**，日志被追加，于是「上一轮的几何」
 *   混进本轮、断言读到的是旧窗口尺寸。改用唯一文件名后这两个坑一起消失
 *   （A 轮还专门断言「几何行恰好 1 条」，一旦真有残留实例立刻红）。
 *
 * 用法：node tools/test-overlay-pos-render.js
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
const WORK = path.join(ROOT, 'desktop-overlay', 'build');
const PY = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const SHOT = path.join(ROOT, 'tools', '_screen_shot.py');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' | ' + extra)); }
}
const sleep = (ms) => execSync(process.platform === 'win32'
  ? 'ping -n ' + Math.max(1, Math.round(ms / 1000) + 1) + ' 127.0.0.1 >NUL'
  : 'sleep ' + Math.max(1, Math.round(ms / 1000)), { stdio: 'ignore' });

/** 跑一轮：启动 exe（带测试环境变量）→ 从日志取局面窗矩形 → 截图并分带统计。
 *
 *  ★ 开跑前必须把**所有**残留实例杀干净（含上一轮没退干净的）：
 *    局面窗是 WS_EX_TOPMOST 且每轮都落在同一个坐标上，残留实例会和新实例叠在一起 ——
 *    截图截到的可能是**上一轮的窗口**（同样尺寸、同样的棋盘），于是「改了代码但断言没动」
 *    或者反过来的假象都会出现。旧进程还握着日志句柄时 unlink 还会静默失败、日志被追加。
 *    这是本文件最阴的一个坑：画面看着完全正常，只是看的不是本轮。 */
// ★ 必须**确认**清干净，不能只发一条 taskkill 就当没事了：
//   残留实例会压在本轮窗口上面（同一个默认坐标），截图截到的是上一轮的画面 ——
//   断言全绿、测的却是旧代码，是本文件最贵的一类假绿。
function killStrays() {
  for (let i = 0; i < 4; i++) {
    try { execSync('taskkill /IM "Desktop GomokuOverlay.exe" /F', { stdio: 'ignore' }); } catch (e) {}
    sleep(1500);
    let out = '';
    try { out = execSync('tasklist /FI "IMAGENAME eq Desktop GomokuOverlay.exe"', { encoding: 'utf8' }); } catch (e) {}
    if (!/Desktop GomokuOverlay/.test(out)) return true;
  }
  return false;
}

// 整个测试跑之前，把上一次留下的产物清掉（删不掉也无所谓：本轮用的是唯一文件名，
// 只是在 build 目录里攒垃圾）。明确只删本测试自己的 posrender-* 前缀，不碰别的。
function cleanOldArtifacts() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(WORK)) {
      if (/^posrender-[a-z](-full)?(-[\d-]+)?\.(log|png)$/.test(f)) {
        try { fs.unlinkSync(path.join(WORK, f)); n++; } catch (e) {}
      }
    }
  } catch (e) {}
  return n;
}

/** 轮询到「本轮该有的状态真的到位」为止（取代旧的固定 sleep(11000)）。
 *
 *  到位判据（四条全中才算）：
 *    ① 局面窗已开      —— 日志出现 `[pos] geometry window=`
 *    ② 覆盖层已铺底    —— 日志出现 `overlay window created`（GB_TEST_BACKDROP 才有意义）
 *    ③ 面板页已就绪    —— 日志出现 `"type":"uiLook"`（页面 boot 完成、外观通道打通）
 *    ④ 本轮要求的外观已生效 —— GB_TEST_OPACITY 的值 / GB_TEST_DARK=1 出现在 uiLook 里
 *  ④ 是 C/D 两轮的命门：它们测的就是「外观变化传到小窗」，页面还没生效就截图 → 必然假红。
 *  为什么不能死等固定秒数：WebView2 首帧渲染进程偶发 LAUNCH_FAILED（kind=4 reason=2）→
 *  宿主自愈「安全模式重启整个进程」→ 面板页 ~15s 才就绪，固定 11s 会拍在生效之前。 */
function waitReady(log, env, timeoutMs) {
  const t0 = Date.now();
  const wantOp = env.GB_TEST_OPACITY ? Number(env.GB_TEST_OPACITY) : null;
  const wantDark = String(env.GB_TEST_DARK || '') === '1';
  let why = '';
  for (;;) {
    let t = '';
    try { t = fs.readFileSync(log, 'utf8'); } catch (e) {}
    const hasPos = /\[pos\] geometry window=/.test(t);
    const hasOverlay = /overlay window created/.test(t);
    const hasPage = /"type":"uiLook"/.test(t);
    const opOk = wantOp === null || t.includes('"opacity":' + wantOp);
    const dkOk = !wantDark || t.includes('"dark":true');
    if (hasPos && hasOverlay && hasPage && opOk && dkOk) return { ok: true, waited: Date.now() - t0 };
    why = 'pos=' + hasPos + ' overlay=' + hasOverlay + ' page=' + hasPage +
          ' opacity=' + opOk + ' dark=' + dkOk;
    if (Date.now() - t0 >= timeoutMs) return { ok: false, waited: Date.now() - t0, why };
    sleep(1000);
  }
}

function runOnce(tag, env, posAt) {
  const cleared = killStrays();
  // ★ 唯一文件名：旧进程还握着同名文件时 unlink 会静默失败，日志被追加 →
  //   本轮的 [pos] geometry 会和上一轮混在一起，断言读到的是**旧窗口**的尺寸。
  const stamp = process.pid + '-' + Date.now();
  const log = path.join(WORK, 'posrender-' + tag + '-' + stamp + '.log');
  const png = path.join(WORK, 'posrender-' + tag + '-' + stamp + '.png');
  const pngStable = path.join(WORK, 'posrender-' + tag + '.png');   // 便给人看的稳定副本
  const pngFull = path.join(WORK, 'posrender-' + tag + '-full.png'); // 定位异常时的整屏证据

  const child = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: WORK,
    env: Object.assign({}, process.env, {
      GB_INSTANCE_ID: 'pos' + tag + process.pid,
      GB_LOG_FILE: log,
      // 每轮一个不同坐标：窗口「找到了但不在指定位置」= 有残留实例在抢屏，立刻红。
      GB_TEST_POS_AT: posAt,
    }, env),
  });
  child.unref();
  console.log('  启动 pid=' + child.pid + '（' + tag + '）…');

  // ★ 2026-09-18 改：**等状态到位**，不再死等固定秒数。
  //   死等 sleep(11000) 的实测后果：WebView2 首帧渲染进程偶发 LAUNCH_FAILED（kind=4 reason=2）
  //   → 宿主自愈「安全模式重启整个进程」（日志 restarting overlay process for self-heal），
  //   于是整套 boot 跑第二遍、面板页要到 ~15s 才就绪。11s 就截图 ⇒ 页面还没生效 ⇒
  //   C 轮（透明度 25）与 D 轮（深色）读到的还是默认外观，一堆「没传到小窗」的假红。
  //   现在轮询到「局面窗已开 + 面板页已上报 + 本轮期望的外观真的生效」为止（上限 30s）。
  // 40s：自愈重启要等前一个进程退出（实测 ~23s）之后才开始第二次 boot，
  // 再等 WebView2 起来 + 页面 boot + 外观生效。给足，别把环境慢当成产品坏。
  const ready = waitReady(log, env, 40000);
  console.log('    就绪等待 ' + ready.waited + 'ms' + (ready.ok ? '' : '  ⚠ 超时（后面若报红，先看这条）'));

  let txt = '';
  try { txt = fs.readFileSync(log, 'utf8'); } catch (e) {}
  const geo = [...txt.matchAll(/\[pos\] geometry window=\((-?\d+),(-?\d+)\) (\d+)x(\d+) dpr=([\d.]+)/g)];
  const g = geo.length ? geo[geo.length - 1] : null;
  const rect = g ? [Number(g[1]), Number(g[2]), Number(g[3]), Number(g[4])] : null;
  const dpr = g ? Number(g[5]) : 0;
  const painted = /\[pos\] paint W=\d+ H=\d+ dpr=/.test(txt);
  const painterLine = (/\[pos\] paint [^\r\n]*/.exec(txt) || [''])[0];
  const geoCount = geo.length;              // 日志是本轮全新的文件
  // ★ 宿主自愈重启会让整套 boot（含局面窗开窗）**再跑一遍** —— 那是已知且无害的：
  //   日志里有 "panel window destroyed abnormally -> restarting overlay process for self-heal"。
  //   所以配额 = 1 + 自愈次数。残留实例不会留下这条自愈行，护栏的牙一点没钝。
  const selfHeal = (txt.match(/restarting overlay process for self-heal/g) || []).length;
  const geoWant = 1 + selfHeal;
  // ★ 面板页彻底没起来（宿主回退到自绘 fallback）：这一轮**测不到面板相关的东西**
  //   （C/D 两轮的透明度/深色都靠页面 uiLook 下发），继续断言只会得到一堆环境噪声。
  //   见 runRound()：这种轮次直接重跑一次。
  const pageFallback = /switching to host fallback/.test(txt);
  const design = g ? ((/\(design (\d+)x(\d+)\)/.exec(g[0]) || [])[0] || '') : '';

  let stats = null;
  if (rect) {
    let out = '';
    try {
      // posinfo = 先按品牌蓝标题栏**自己定位**窗口，再产出分带统计。
      // 不直接用日志坐标裁：日志只记创建时的坐标，而主面板可能在截图前又移动过
      // （小窗默认贴在面板左侧），或上一次运行残留的实例还压在屏幕上。
      // pad=200 足够覆盖这类偏移，同时 loc.dx/dy 会把偏移量报出来当证据。
      // pad 只给 80：窗口位置是我们用 GB_TEST_POS_AT 钉死的，不该再漂。
      // 搜索框越小，越不可能把**别的窗口**当成局面窗截进来。
      out = execSync('"' + PY + '" "' + SHOT + '" posinfo ' + rect.join(' ') + ' 80 "' + png + '"',
        { encoding: 'utf8' });
    } catch (e) { out = 'PYERR ' + (e.stdout || '') + (e.stderr || '') + e.message; }
    const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
    try { stats = line ? JSON.parse(line) : { err: out.slice(0, 300) }; }
    catch (e) { stats = { err: out.slice(0, 300) }; }
    // ★ 定位失手 / 窗口不在指定位置时，**额外存一张整屏截图**。
    //   这一类失败最常见的原因不是渲染坏了，而是「屏幕上有别的 topmost 窗口」把定位带偏
    //   （本程序残留实例、或桌面上本来就开着的别的软件）。只留一张裁偏的小图根本看不出
    //   到底谁在抢屏；整屏图一眼就能定位。文件名固定带 tag，方便事后回看。
    const off = stats && stats.loc && (stats.loc.dx !== 0 || stats.loc.dy !== 0);
    if (!stats || stats.err || off) {
      try {
        execSync('"' + PY + '" "' + SHOT + '" full "' + pngFull + '"', { encoding: 'utf8' });
        console.log('    ⚠ 定位/偏移异常，已存整屏图 ' + pngFull);
      } catch (e) {}
    }
    // 稳定副本：唯一文件名便于「本轮一定新鲜」，但人看的时候需要一个固定路径。
    try { fs.copyFileSync(png, pngStable); } catch (e) {}
  }

  try { execSync('taskkill /PID ' + child.pid + ' /F /T', { stdio: 'ignore' }); } catch (e) {}
  sleep(3000);                        // 让 WebView2 子进程退干净，避免下一轮抢 userData
  return { rect, dpr, stats, png: pngStable, painterLine, painted, geoCount, geoWant, selfHeal,
           design, cleared, ready, pageFallback };
}

/** 跑一轮，**面板页没起来就重跑一次**。
 *
 *  为什么需要它：这台机器上 WebView2 首帧渲染进程会偶发 LAUNCH_FAILED
 *  （kind=4/6 reason=2 exitCode=1），宿主自愈「安全模式重启整个进程」需要 ~23s；
 *  而且安全模式**也可能**再失败一次，此时面板页永远是 about:blank、宿主回退到自绘
 *  fallback（日志 "panel page timed out, switching to host fallback"）。
 *  那一轮里「透明度/深色传到小窗」根本无从谈起 —— 断言只会报环境噪声，而不是产品问题。
 *  重跑一轮的代价（约 40s）远小于「一条假红把真问题埋掉」的代价。 */
function runRound(tag, env, posAt) {
  let r = runOnce(tag, env, posAt);
  if (!r.ready.ok && r.pageFallback) {
    console.log('    ⚠ 这一轮面板页没起来（宿主回退 fallback）—— 环境抖动，重跑一轮');
    r = runOnce(tag, env, posAt);
    r.retried = true;
  }
  return r;
}

if (!fs.existsSync(EXE)) {
  console.error('找不到 ' + EXE + '，请先跑 node tools/build-overlay.js');
  process.exit(1);
}
console.log('清掉上一次的产物：' + cleanOldArtifacts() + ' 个（删不掉的会被忽略，本轮用唯一文件名）');

// ================================================================ A 轮：demo 局面，100% 不透明
console.log('== A 轮：demo 局面 / 100% 不透明 —— 棋盘必须真的画在屏幕上 ==');
const A = runRound('a', {
  GB_TEST_OPEN_POS: 'demo',
  GB_TEST_BACKDROP: '00FF00',        // 覆盖层铺纯绿：给下面 C 轮一个已知背景
  GB_TEST_OPACITY: '100',
  // ★ 本测试靠**截屏**读像素，而生产版把本软件自己的窗口全排除出截图
  //   （覆盖层 WDA → GB_TEST_BACKDROP 的纯绿底衬拍不到，locate_window 会恒定偏
  //    (-80,-80)；小窗 WDA → 棋盘/标题栏像素全 0）。不给退出口的话本文件十几条
  //   断言会连锁假红。GB_TEST_CAPTURABLE=1 让三个自绘窗口都保持可截图，
  //   生产环境永远走排除路径（宿主的 SelfCaptureAllowedForTest()）。
  GB_TEST_CAPTURABLE: '1',
}, '200,80');
ok('局面小窗窗口建立并下发了几何（否则测的不是它）', !!A.rect,
  A.rect ? A.rect.join(',') + ' dpr=' + A.dpr : '日志里没有 [pos] geometry');
// ★ 「画面看着完全正常，只是看的不是本轮」是本文件最阴的一类假绿：
//   残留实例叠在同一个坐标上 + 旧日志被追加 → 断言其实在测上一轮的画面。
ok('★ 起跑前残留实例已清空（taskkill 后 tasklist 确认过）', A.cleared,
  A.cleared ? '' : '杀不干净：残留窗口会压在本轮窗口上面，下面所有像素断言都不可信');
ok('★ 本轮只有一个实例、日志是新鲜的（几何行恰好 1 条，宿主自愈重启另计）',
  A.geoCount === A.geoWant,
  A.geoCount + ' 条 ' + A.design + '（期望 ' + A.geoWant +
  '，自愈重启 ' + A.selfHeal + ' 次；超出 = 有残留实例/旧日志，结果不可信）');
if (A.selfHeal) console.log('    ℹ 本轮宿主自愈重启 ' + A.selfHeal +
  ' 次（WebView2 渲染进程偶发 LAUNCH_FAILED）—— 已按配额计入，不是残留实例');
ok('★ 截图前本轮该有的状态全部到位（局面窗 / 覆盖层 / 面板页 / 期望外观）',
  !!(A.ready && A.ready.ok),
  A.ready ? ('等待 ' + A.ready.waited + 'ms  ' + (A.ready.why || '')) : '(没等到)');
ok('宿主确实执行过 PaintPosition', A.painted, A.painterLine || '(没有 [pos] paint 行)');
if (A.stats && !A.stats.err) {
  const s = A.stats;
  console.log('    截图 ' + A.png + '  ' + s.W + 'x' + s.H +
              (s.loc ? '  实定位=(' + s.loc.x + ',' + s.loc.y + ') 偏移=(' + s.loc.dx + ',' + s.loc.dy + ')' : ''));
  console.log('    标题栏 rgb(' + s.hdr.join(',') + ')  棋盘卡片 rgb(' + s.board.join(',') + ')');
  console.log('    boardUniq=' + s.boardUniq + '  boardDark=' + s.boardDark +
              '  boardGrid=' + s.boardGrid + '  btnBluePx=' + s.btnBluePx);
  const hdrBlue = s.hdr[2] - Math.max(s.hdr[0], s.hdr[1]);
  ok('★ 能自己在截图里定位到窗口（证明窗口真的画出来了、且位置可信）',
    !!s.loc && Math.abs(s.loc.dx) <= 80 && Math.abs(s.loc.dy) <= 80 &&
    s.loc.spanY >= Math.round(s.H * 0.9),
    s.loc ? 'dx=' + s.loc.dx + ' dy=' + s.loc.dy + ' spanY=' + s.loc.spanY + '/' + s.H
          : '(没定位到)');
  // ★★ 位置是我们用 GB_TEST_POS_AT 钉死的（A 轮 = 200,80）。偏移必须为 0：
  //    偏移不为 0 只有两种可能 —— 宿主没听指令，或者**有别的窗口在这一带抢屏**
  //    （残留实例）。两种都必须当场红，否则后面所有像素断言都可能是在测别人。
  ok('★ 窗口正好落在指定位置（GB_TEST_POS_AT=200,80）—— 偏移不为 0 就是有东西在抢屏',
    !!s.loc && s.loc.dx === 0 && s.loc.dy === 0,
    s.loc ? '实定位=(' + s.loc.x + ',' + s.loc.y + ') 偏移=(' + s.loc.dx + ',' + s.loc.dy + ')'
          : '(没定位到)');
  ok('窗口整体确实渲染出来了（标题栏仍是品牌蓝 #3b7dd8）', hdrBlue > 30,
    'B-max(R,G)=' + hdrBlue + ' rgb(' + s.hdr.join(',') + ')');
  ok('100% 时整窗完全不透明（从标题栏纯色块反推 alpha ≈ 1.00）',
    s.alphaFromHdr >= 0.9, 'alphaFromHdr=' + s.alphaFromHdr + ' hdrFlat=' + s.hdrFlat.join(','));
  // ★★ 这一条就是用户反馈的「没有棋盘」
  ok('★ 棋盘卡片区出现了黑子（boardDark 上千）—— 棋盘真的画出来了', s.boardDark > 300,
    'boardDark=' + s.boardDark);
  ok('严格阈值下也认得出黑子（深色卡片不会误计数）', s.boardDeep > 300, 'boardDeep=' + s.boardDeep);
  ok('网格线也画出来了（浅模式 #b0b8c6，成千上万像素）', s.boardGrid > 2000,
    'boardGrid=' + s.boardGrid);
  ok('卡片区不是一块纯色（网格 + 棋子 + 抗锯齿边都在）', s.boardUniq > 40,
    'boardUniq=' + s.boardUniq);
  ok('浅色模式下卡片是浅底（不是误落进深色主题）',
    Math.min(s.board[0], s.board[1], s.board[2]) > 180, 'rgb(' + s.board.join(',') + ')');
  // 100% 不透明时不能透出覆盖层的绿
  {
    const bleed = s.board[1] - Math.max(s.board[0], s.board[2]);
    ok('100% 不透明时卡片区不透底下的绿（说明这轮测的是「自己画的东西」）', bleed <= 40,
      'G-max(R,B)=' + bleed);
  }
  // 按钮「小一圈」：从截图量主按钮的实际高度，换算回设计单位
  if (s.btnBlue) {
    const hDesign = A.dpr > 0 ? s.btnBlue.h / A.dpr : 0;
    console.log('    主按钮外接矩形 ' + s.btnBlue.w + 'x' + s.btnBlue.h + ' px = ' +
                hDesign.toFixed(1) + ' 设计单位高');
    ok('主按钮画出来了（实心品牌蓝的一片像素）', s.btnBluePx > 200, 'btnBluePx=' + s.btnBluePx);
    ok('★ 按钮高度 ≈ 26 设计单位（原 32 → 「小一圈」）',
      hDesign >= 22 && hDesign <= 30, hDesign.toFixed(1) + ' 设计单位');
  } else {
    ok('主按钮画出来了（实心品牌蓝的一片像素）', false, '按钮行里找不到品牌蓝');
  }
  // ★★ 用户 2026-09-17：「在棋盘的左右侧和下面写上坐标代码（细小的数字和字母），
  //    不要与棋盘堆叠，合理布局。左下角为坐标原点，纵轴 1~15，横轴 A~O」
  console.log('    坐标标注像素 左=' + s.coordLeft + ' 右=' + s.coordRight + ' 下=' + s.coordBottom);
  console.log('    棋盘线实测（设计单位）x ' + s.gridX0 + '..' + s.gridX1 +
              '  y ' + s.gridY0 + '..' + s.gridY1 +
              '  竖线 ' + s.gridVCount + ' 条 / 横线 ' + s.gridHCount + ' 条');
  ok('★ 左右两侧都画出了行号（1..15）', s.coordLeft > 20 && s.coordRight > 20,
    '左=' + s.coordLeft + ' 右=' + s.coordRight);
  ok('★ 下方画出了列号（A..O）', s.coordBottom > 20, '下=' + s.coordBottom);
  ok('左右两栏内容对称（同 15 个行号，像素量级相当）',
    Math.abs(s.coordLeft - s.coordRight) < Math.max(s.coordLeft, s.coordRight),
    '左=' + s.coordLeft + ' 右=' + s.coordRight);
  // ★★ 「标注与棋盘不堆叠」用**直接量棋盘**来证明，而不是数坐标栏里有没有网格色 ——
  //    坐标字的抗锯齿边缘会穿过网格色的邻域，那样数出来的两三百像素全是假阳性。
  //    这里改成量棋盘线本身：15 条竖线 / 15 条横线，且位置正好落在 POS_OX/POS_OY 上。
  ok('★ 棋盘 15 条竖线 + 15 条横线全都画出来了',
    s.gridVCount === 15 && s.gridHCount === 15,
    '竖 ' + s.gridVCount + ' 横 ' + s.gridHCount);
  ok('★ 棋盘左边界 = POS_OX(29) —— 坐标栏(13) 与左右内衬(4) 都在它左边，确实不堆叠',
    s.gridX0 !== null && Math.abs(s.gridX0 - 29) <= 1.5, '实测 x0=' + s.gridX0 + '（期望 29）');
  ok('★ 棋盘右边界 = POS_OX + POS_GRID(239)', s.gridX1 !== null && Math.abs(s.gridX1 - 239) <= 1.5,
    '实测 x1=' + s.gridX1 + '（期望 239）');
  ok('★ 棋盘上边界 = POS_OY(46)（上内衬 8 ≥ 半个字高，顶行「15」不会露到卡片外）',
    s.gridY0 !== null && Math.abs(s.gridY0 - 46) <= 1.5, '实测 y0=' + s.gridY0 + '（期望 46）');
  ok('★ 棋盘下边界 = POS_OY + POS_GRID(256)', s.gridY1 !== null && Math.abs(s.gridY1 - 256) <= 1.5,
    '实测 y1=' + s.gridY1 + '（期望 256）');
  // 用户 2026-09-17：「让棋盘稍微大一点点…左右和下边距稍微小一点」
  //   上一版棋盘 196、三条边距都是 24；现在棋盘 210、横 17 / 上 8 / 下 16。
  ok('★ 棋盘确实变大了（210 设计单位，上一版是 196）',
    s.gridX1 - s.gridX0 >= 206 && s.gridY1 - s.gridY0 >= 206,
    '宽 ' + Math.round(s.gridX1 - s.gridX0) + ' 高 ' + Math.round(s.gridY1 - s.gridY0));
  // ★★ 用户 2026-09-17：「代码不仅有专属黑色、白色的，也应该有『总代码』」
  //    「总代码」文本本身没法从像素里读字，但它的**行数**能读：卡片原本 3 行
  //    （抬头 + B: + W:），加了 A: 之后必须是 4 行。
  console.log('    代码卡片文字行数 = ' + s.codeRowsLight + '（3 行 = 只有 B/W，4 行 = 含总代码 A:）');
  ok('★ 代码卡片里画出了 4 行（含新增的「总代码」A: 行）', s.codeRowsLight >= 4,
    'codeRows=' + s.codeRowsLight);
} else {
  ok('A 轮截图与取样成功', false, JSON.stringify(A.stats));
}

// ================================================================ B 轮：空局面（反面校验）
console.log('== B 轮：空局面 / 100% —— 没有棋子就不该有深色像素（反面校验）==');
const B = runRound('b', {
  GB_TEST_OPEN_POS: 'open',          // 只开窗，不塞示例局面
  GB_TEST_BACKDROP: '00FF00',
  GB_TEST_OPACITY: '100',
  GB_TEST_CAPTURABLE: '1',           // 见 A 轮说明：测试要能拍到自己画的窗口
}, '300,80');
if (B.stats && !B.stats.err) {
  const s = B.stats;
  console.log('    boardDark=' + s.boardDark + '  boardDeep=' + s.boardDeep +
              '  boardGrid=' + s.boardGrid + '  boardUniq=' + s.boardUniq);
  ok('空局面下没有黑子（严格阈值 <25 必须是 0，证明 A 轮那条数字真的在测棋子）',
    s.boardDeep === 0, 'boardDeep=' + s.boardDeep);
  ok('空局面下网格仍在画（说明这一轮窗口本身正常，不是整块没渲染）', s.boardGrid > 2000,
    'boardGrid=' + s.boardGrid);
  ok('空局面上写了「尚未识别到棋盘」→ 卡片区颜色种类明显多于纯网格',
    s.boardUniq > 20, 'boardUniq=' + s.boardUniq);
} else {
  ok('B 轮截图与取样成功', false, JSON.stringify(B.stats));
}

// ================================================================ C 轮：面板 25% → 小窗最低 60%
console.log('== C 轮：面板 25% —— 小窗按「最低 60%」映射，且仍透出底下的绿 ==');
const C = runRound('c', {
  GB_TEST_OPEN_POS: 'demo',
  GB_TEST_BACKDROP: '00FF00',
  GB_TEST_OPACITY: '25',
  GB_TEST_CAPTURABLE: '1',           // 见 A 轮说明：测试要能拍到自己画的窗口
}, '400,80');
if (C.stats && !C.stats.err) {
  const s = C.stats;
  const bleed = s.board[1] - Math.max(s.board[0], s.board[2]);
  console.log('    棋盘卡片 rgb(' + s.board.join(',') + ')  标题栏纯色块 rgb(' + s.hdrFlat.join(',') + ')');
  console.log('    alphaFromHdr=' + s.alphaFromHdr + '  G-max(R,B)=' + bleed);
  // ★ 用户要求（2026-09-17）：「与背景少大概一半…比如用户选择 25%，棋盘透明度就是 60%，
  //   也就是最低 60%、最高 100%」。面板 25% 时小窗必须是 60%（而不是跟着降到 25%）。
  //   反推方式是直接读数：标题栏纯色块 = 品牌蓝 (59,125,216) 合成到覆盖层纯绿上，
  //   绿底 R=0 ⇒ 实测 R = 59×alpha ⇒ alpha = R/59。
  ok('★ 面板 25% 时小窗 alpha ≈ 0.60（用户要求的最低档，而不是跟着面板降到 0.25）',
    s.alphaFromHdr >= 0.53 && s.alphaFromHdr <= 0.68,
    'alphaFromHdr=' + s.alphaFromHdr + '（期望 ≈0.60）');
  ok('25% 档下棋盘仍清晰可读（比面板实一档，正是用户要的观感）',
    Math.min(s.board[0], s.board[1], s.board[2]) > 140, 'rgb(' + s.board.join(',') + ')');
  ok('★ 小窗确实合成到了桌面上（透出底下的纯绿，不是糊一层）', bleed > 60,
    'G-max(R,B)=' + bleed + '（透明度失效时≈0）');
  ok('透出来的不是「一片纯绿」（绿上面还压着棋盘自己画的格子）',
    s.board[0] > 20 || s.board[2] > 20, 'rgb(' + s.board.join(',') + ')');
  // 低透明度下不能用 boardDeep（<25）：整窗按 0.60 合成到**纯绿**底上时，
  // 黑子 (17,17,17) 会变成 (10,112,10) —— max=112，早就不是「深色」了。
  // 所以这一档改用 boardDark150（max(rgb) < 150）：它在绿底上只圈得住棋子
  // （网格线合成后 max≈212、卡片白=255），正好回答「棋子还在不在」。
  ok('低透明度下黑子仍可辨（用 <150 档；棋子被稀释成 ~112，网格/卡片不会误入）',
    s.boardDark150 > 60, 'boardDark150=' + s.boardDark150 + ' boardDeep=' + s.boardDeep);
} else {
  ok('C 轮截图与取样成功', false, JSON.stringify(C.stats));
}

// ================================================================ D 轮：深色模式适配
console.log('== D 轮：深色模式 —— 局面小窗必须跟着主面板换夜间配色 ==');
const D = runRound('d', {
  GB_TEST_OPEN_POS: 'demo',
  GB_TEST_DARK: '1',                 // 注入脚本点一下面板的「深色」键
  GB_TEST_BACKDROP: '00FF00',        // 同样铺底：定位窗口要用它做「非底色」判据
  GB_TEST_OPACITY: '100',
  GB_TEST_CAPTURABLE: '1',           // 见 A 轮说明：测试要能拍到自己画的窗口
}, '500,80');
if (D.stats && !D.stats.err) {
  const s = D.stats;
  const bmax = Math.max(s.board[0], s.board[1], s.board[2]);
  console.log('    棋盘卡片 rgb(' + s.board.join(',') + ')  标题栏纯色块 rgb(' + s.hdrFlat.join(',') + ')');
  console.log('    boardDeep=' + s.boardDeep + '  boardGridDark=' + s.boardGridDark);
  ok('★ 窗口正好落在指定位置（GB_TEST_POS_AT=500,80）—— 深色轮曾被残留实例坑过',
    !!s.loc && s.loc.dx === 0 && s.loc.dy === 0,
    s.loc ? '偏移=(' + s.loc.dx + ',' + s.loc.dy + ')' : '(没定位到)');
  ok('深色模式下卡片是暗色（浅模式的 255 白没跟过来）', bmax < 110,
    'max(rgb)=' + bmax + ' rgb(' + s.board.join(',') + ')');
  ok('深色模式下的网格线也画出来了（#60687e，偏冷中间调）', s.boardGridDark > 2000,
    'boardGridDark=' + s.boardGridDark);
  ok('深色模式下黑子仍在（严格阈值 <25，排除深色卡片本身）', s.boardDeep > 300,
    'boardDeep=' + s.boardDeep);
  ok('深色模式下标题栏仍是品牌蓝（只有内容换肤，标题栏不动）',
    s.hdr[2] - Math.max(s.hdr[0], s.hdr[1]) > 30,
    'rgb(' + s.hdr.join(',') + ')');
  // 深色下代码文字是亮的、卡片是暗的，所以这一档要数「亮行」
  ok('深色模式下代码卡片的 4 行文字同样画出来了', s.codeRowsDark >= 4,
    'codeRowsDark=' + s.codeRowsDark + '（亮行）');
} else {
  ok('D 轮截图与取样成功', false, JSON.stringify(D.stats));
}

console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
