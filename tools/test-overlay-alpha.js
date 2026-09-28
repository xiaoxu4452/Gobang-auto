#!/usr/bin/env node
/**
 * 主面板透明度回归测试 —— 把「到底透不透」变成一个可断言的数字。
 *
 * 为什么需要它：用户反复反馈「透明度失效了 / 透明模式都成黑色了，是不透光的黑」。
 * 这类问题肉眼很容易看错（面板白底、桌面也白 → 看不出），所以必须构造一个
 * **确定的背景色**，再读真实屏幕像素来判断。
 *
 * 原理：
 *   · 宿主带 GB_TEST_BACKDROP=00FF00 启动 → 覆盖层整屏涂成纯绿（面板压在其上）。
 *   · 宿主带 GB_TEST_OPACITY=25 启动   → 页面把面板底色调成 rgba(255,255,255,0.25)。
 *   · 于是面板「正文区」应当是 0.25 的白 ⊕ 纯绿 ≈ (64,255,64)：绿通道远超红/蓝。
 *     若透明失效（WebView2 的 alpha 被拍平在窗口这一层），面板会是白/灰 ——
 *     三个通道几乎相等，绿根本冒不出来。
 *   · 反面校验：同一位置在 GB_TEST_OPACITY=100 时必须**不透绿**（100% = 不透明），
 *     否则说明这条断言其实什么都没测到。
 *   · 另加一条「面板真的画出来了」的护栏：标题栏是不透明的 #3b7dd8，必须仍是蓝色。
 *     没有它的话，「面板整块没渲染 + 满屏纯绿」也会让上面那条假绿通过。
 *
 * 运行期间屏幕会被覆盖层铺成纯绿约 10 秒/轮 —— 这是**测试专用**模式（GB_TEST_BACKDROP），
 * 正常运行 exe 完全不受影响。
 *
 * 用法：node tools/test-overlay-alpha.js [--both]
 *   --both  额外跑一轮 100% 不透明度的反面校验（默认只跑 25% 那轮）
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
const WORK = path.join(ROOT, 'desktop-overlay', 'build');
const BOTH = process.argv.includes('--both');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' | ' + extra)); }
}


/** 跑一轮：启动覆盖层（带指定透明度）→ 截图面板区域 → 返回两条色带的均色。 */
function runOnce(opacity, tag) {
  const log = path.join(WORK, 'alpha-' + tag + '.log');
  const png = path.join(WORK, 'alpha-' + tag + '.png');
  try { fs.unlinkSync(log); } catch (e) {}
  try { fs.unlinkSync(png); } catch (e) {}

  const child = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: WORK,
    env: Object.assign({}, process.env, {
      GB_INSTANCE_ID: 'alpha' + tag + process.pid,
      GB_LOG_FILE: log,
      GB_TEST_BACKDROP: '00FF00',       // 面板底下铺纯绿
      GB_TEST_OPACITY: String(opacity), // 页面把面板底色调到该透明度
      // ★ 纯绿底衬是**覆盖层**画的，而覆盖层生产版设了 WDA_EXCLUDEFROMCAPTURE
      //   （不让自己的蓝圈/热力块污染识别）→ 截图里根本没有那块绿，本测试要反推的
      //   「合成后的颜色」就没了基准。这个变量让本进程的自绘窗口保持可截图。
      GB_TEST_CAPTURABLE: '1',
    }),
  });
  child.unref();
  console.log('  启动 pid=' + child.pid + '（面板透明度 ' + opacity + '%）…');

  // ★ 2026-09-18：等「面板真的下发了几何 + 期望的透明度已生效」，不再死等固定秒数。
  //   死等的后果实测过：WebView2 首帧渲染进程偶发 LAUNCH_FAILED → 宿主自愈「安全模式重启
  //   整个进程」要 ~23s → 面板页要到 15s 之后才 boot；12s 就截图 ⇒ 「日志里没有 applied
  //   geometry」直接判红，而渲染其实完全正常。这里轮询到就绪（上限 40s），拿不到再报红。
  const want = '"opacity":' + opacity;
  const t0 = Date.now();
  for (;;) {
    let cur = '';
    try { cur = fs.readFileSync(log, 'utf8'); } catch (e) {}
    if (/\[panel\] applied geometry window=/.test(cur) && cur.includes(want)) break;
    if (Date.now() - t0 >= 40000) break;
    execSync(process.platform === 'win32'
      ? 'ping -n 2 127.0.0.1 >NUL' : 'sleep 1', { stdio: 'ignore' });
  }

  let txt = '';
  try { txt = fs.readFileSync(log, 'utf8'); } catch (e) {}
  const geo = [...txt.matchAll(/\[panel\] applied geometry window=\((-?\d+),(-?\d+)\) (\d+)x(\d+)/g)];
  const rect = geo.length ? geo[geo.length - 1].slice(1).map(Number) : null;

  let stats = null;
  if (rect) {
    // 采样交给项目自带的 Python（PIL + numpy）—— **刻意不用 PowerShell + Add-Type**：
    // 那段 System.Drawing 截屏脚本会被杀软 AMSI 直接拦掉（"contains malicious content"），
    // 测试根本跑不起来。这也顺带印证了「总被杀毒软件查杀」那条反馈。
    // _screen_shot.py 先把自己标成 per-monitor DPI aware，于是截图坐标与宿主日志里的窗口
    // 坐标（物理像素）同处一个空间，直接按矩形裁就行 —— 多显示器也不用再猜缩放比。
    const py = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
    const shot = path.join(ROOT, 'tools', '_screen_shot.py');
    let out = '';
    try {
      out = execSync(
        '"' + py + '" "' + shot + '" crop ' + rect.join(' ') + ' "' + png + '" --stats',
        { encoding: 'utf8' });
    } catch (e) { out = 'PYERR ' + (e.stdout || '') + (e.stderr || '') + e.message; }
    const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
    if (line) {
      try {
        const j = JSON.parse(line);
        stats = j.err ? { err: JSON.stringify(j) } : { W: j.W, H: j.H, hdr: j.hdr, body: j.body };
      } catch (e) { stats = { err: out.slice(0, 300) }; }
    } else {
      stats = { err: out.slice(0, 300) };
    }
  }

  try { execSync('taskkill /PID ' + child.pid + ' /F /T', { stdio: 'ignore' }); } catch (e) {}
  // 给 WebView2 子进程一点时间退干净，免得下一轮抢 userData（LAUNCH_FAILED）
  try { execSync('ping -n 4 127.0.0.1 >NUL', { stdio: 'ignore' }); } catch (e) {}

  return { rect, stats, png, log, txt };
}

/** 跑一轮，**面板页没起来就重跑一次**。
 *  这台机器上 WebView2 首帧渲染进程会偶发 LAUNCH_FAILED（宿主自愈重启后安全模式**也可能**
 *  再失败一次），此时面板页永远是 about:blank、宿主回退到自绘 fallback
 *  （日志 "panel page timed out, switching to host fallback"）—— 那一轮里「透不透」根本
 *  无从谈起，断言只会报环境噪声。重跑一轮远好过让一条假红把真问题埋掉。 */
function runStable(opacity, tag) {
  let r = runOnce(opacity, tag);
  if (!r.rect && /switching to host fallback/.test(r.txt)) {
    console.log('    ⚠ 这一轮面板页没起来（宿主回退 fallback）—— 环境抖动，重跑一轮');
    r = runOnce(opacity, tag);
  }
  return r;
}

console.log('== 主面板透明度（真透出桌面，而不是糊一层）==');
if (!fs.existsSync(EXE)) { console.error('找不到 ' + EXE + '，请先跑 node tools/build-overlay.js'); process.exit(1); }

// ---------------- 第一轮：25% 透明度，必须透出底色 ----------------
console.log('[1/2] 25% 透明度 —— 面板底下铺纯绿，看绿能不能透上来');
const lo = runStable(25, 'lo');
ok('面板窗口真的建立并下发了几何（否则测的不是面板）', !!lo.rect,
  lo.rect ? lo.rect.join(',') : '日志里没有 applied geometry');
if (lo.stats && !lo.stats.err) {
  const [hR, hG, hB] = lo.stats.hdr;
  const [bR, bG, bB] = lo.stats.body;
  const hdrBlue = hB - Math.max(hR, hG);
  const bodyGreen = bG - Math.max(bR, bB);
  console.log('    截图 ' + lo.png + '  ' + lo.stats.W + 'x' + lo.stats.H);
  console.log('    标题栏均色 rgb(' + hR + ',' + hG + ',' + hB + ')  正文区均色 rgb(' + bR + ',' + bG + ',' + bB + ')');
  ok('面板确实渲染出来了（标题栏仍是品牌蓝 #3b7dd8）', hdrBlue > 30,
    'B-max(R,G)=' + hdrBlue);
  ok('25% 透明度下正文区透出了底下的纯绿（真透明）', bodyGreen > 60,
    'G-max(R,B)=' + bodyGreen + '（透明失效时≈0）');
  ok('透出来的不是「一片纯绿」（绿里还得有面板自己的白）', bR > 20 || bB > 20,
    'rgb(' + bR + ',' + bG + ',' + bB + ')');
} else {
  ok('截图与取样成功', false, JSON.stringify(lo.stats));
}

// ---------------- 第二轮（可选）：100% 透明度 = 不透明，不能透绿 ----------------
if (BOTH) {
  console.log('[2/2] 100% 透明度 —— 应当完全不透绿（反面校验）');
  const hi = runStable(100, 'hi');
  if (hi.stats && !hi.stats.err) {
    const [bR, bG, bB] = hi.stats.body;
    const bodyGreen = bG - Math.max(bR, bB);
    console.log('    正文区均色 rgb(' + bR + ',' + bG + ',' + bB + ')');
    ok('100% 时正文区不透绿（说明这条通路确实受透明度控制）', bodyGreen <= 60,
      'G-max(R,B)=' + bodyGreen);
  } else {
    ok('第二轮截图与取样成功', false, JSON.stringify(hi.stats));
  }
}

console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
