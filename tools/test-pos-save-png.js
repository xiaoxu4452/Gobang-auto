/* test-pos-save-png.js — 「保存局面」导出 PNG 的端到端测试（B2）
 * ----------------------------------------------------------------------------
 * 用户 2026-09-19：「在局面的右面添加一个保存局面这个按键，可以保存渲染出来的识别后的棋盘
 *   软件渲染的棋盘 png 图片文件」。
 *
 * 为什么需要这个测试：这条链路的每一段都**没有别的测试碰得到** ——
 *   · 页面那一段（点按钮 → tellHost(savePosPng)）在 test-openpos-click.js 里用真实 Chromium
 *     的假桥验；
 *   · 宿主这一段（渲染 → 编码 PNG → 落盘）此前一条断言都没有。而它恰恰最容易「看起来做了、
 *     其实没做成」：GDI+ 的编码器 CLSID 查错就是静默返回 false；比例忘了还原就把窗口版式带歪；
 *     导出的胶片如果只截屏幕，还会把覆盖层铺的绿底一起拍进去。
 *
 * 做法：宿主有一条**只给测试**的出口（GB_TEST_SAVE_POS_PNG=<路径>）：
 *   给出路径 = 不弹「另存为」对话框，并且启动时用 demo 局面自动存一次
 *   （见 host.cpp WinMain 的 GB_TEST_OPEN_POS 段）。于是不需要真棋盘、不需要假 /scan 服务、
 *   也不需要去点网页上的按钮，就能把「有棋盘 → 渲染 → 编码 → 落盘」整条跑完。
 *
 * 断言（全部读**产物字节**，不读源码）：
 *   · 日志出现 `[pos] board png saved:`
 *   · 文件真的是 PNG（8 字节签名）、尺寸 == kPosPngSize × kPosPngSize（800×800，用户 2026-09-19 追加要求）
 *   · 图里真的有棋子/网格/坐标（不是一张白纸）、且**没有覆盖层的绿底**
 *
 * 用法：node tools/test-pos-save-png.js
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
const WORK = path.join(ROOT, 'desktop-overlay', 'build');
const PY = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const ANALYZE = path.join(ROOT, 'tools', '_pospng_stats.py');

// host.cpp 的设计常量。导出尺寸由 kPosPngSize 直接钉死（用户 2026-09-19：「分辨率应为 800*800」），
// 不再按比例推 —— 老代码是 SCALE=2.4 得到 643×634，改成 800 后这里必须跟着走，
// 否则测试会拿旧期望去判新产物，红得毫无意义。
const POS_W = 268, POS_CARD_H = 240, POS_PAD = 12;
const PNG_SIZE = 800;
const WANT_W = PNG_SIZE, WANT_H = PNG_SIZE;
// 等比缩放系数（长边铺满 800）：胶片 268×264，长边 268 → 800/268 ≈ 2.985。
// 短边 264 缩放后 ≈ 788，与 800 差 12 px（上下各 6 px 白边）—— 这就是「等比 + 居中」的指纹。
const SCALE = PNG_SIZE / Math.max(POS_W, POS_CARD_H + POS_PAD * 2);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' | ' + extra)); }
}
const sleep = (ms) => execSync(process.platform === 'win32'
  ? 'ping -n ' + Math.max(1, Math.round(ms / 1000) + 1) + ' 127.0.0.1 >NUL'
  : 'sleep ' + Math.max(1, Math.round(ms / 1000)), { stdio: 'ignore' });

if (!fs.existsSync(EXE)) {
  console.error('找不到 ' + EXE + '，请先跑 node tools/build-overlay.js');
  process.exit(1);
}

// 残留实例会占着 userData / 抢 topmost，清干净再跑（与 pos-render 测试同一套护栏）
for (let i = 0; i < 4; i++) {
  try { execSync('taskkill /IM "Desktop GomokuOverlay.exe" /F', { stdio: 'ignore' }); } catch (e) {}
  sleep(1200);
  let out = '';
  try { out = execSync('tasklist /FI "IMAGENAME eq Desktop GomokuOverlay.exe"', { encoding: 'utf8' }); } catch (e) {}
  if (!/Desktop GomokuOverlay/.test(out)) break;
}

const stamp = process.pid + '-' + Date.now();
const log = path.join(WORK, 'possave-' + stamp + '.log');
const png = path.join(WORK, 'possave-' + stamp + '.png');
const pngStable = path.join(WORK, 'possave.png');

console.log('== 「保存局面」导出 PNG（B2）==');
const child = spawn(EXE, [], {
  detached: true, stdio: 'ignore', cwd: WORK,
  env: Object.assign({}, process.env, {
    GB_INSTANCE_ID: 'possave' + process.pid,      // 隔离 WebView2 userData
    GB_LOG_FILE: log,
    GB_TEST_OPEN_POS: 'demo',                    // 注入 5 子示例局面（含 3 黑 2 白）
    GB_TEST_SAVE_POS_PNG: png,                   // 给路径 = 不弹对话框 + 启动时自动存一次
  }),
});
child.unref();
console.log('  启动 pid=' + child.pid + '，导出到 ' + path.basename(png));

// 轮询等日志里的落盘回执（上限 40s：WebView2 首帧偶发 LAUNCH_FAILED 会触发宿主自愈重启，
// 但那与本测试无关 —— 导出发生在 boot 早期，这里给足时间只是为了不把环境慢当成产品坏）
let txt = '', waited = 0;
for (;;) {
  try { txt = fs.readFileSync(log, 'utf8'); } catch (e) {}
  if (/\[pos\] board png saved:/.test(txt)) break;
  if (waited >= 40000) break;
  sleep(1000);
  waited += 1000;
}
try { execSync('taskkill /PID ' + child.pid + ' /F /T', { stdio: 'ignore' }); } catch (e) {}
sleep(2000);

const savedLine = (/\[pos\] board png saved:[^\r\n]*/.exec(txt) || [''])[0];
ok('★ 宿主把棋盘导出成了 PNG（日志出现落盘回执）', !!savedLine,
  savedLine || ('等了 ' + waited + 'ms，日志里没有 [pos] board png saved（文件：' + png + '）'));
ok('★ 导出的是 demo 局面（有棋盘才允许导出，空盘会拒绝）',
  /\[pos\] \(test\) demo position injected \(5 stones\)/.test(txt));
ok('导出用的路径就是测试给的那条（没弹「另存为」对话框）',
  /\[pos\] \(test\) auto-saving board png/.test(txt) &&
  !/save png cancelled by user/.test(txt));
ok('没有出现「没棋盘就拒绝」那条日志（否则后面全是空的）',
  !/save png skipped: no board recognized yet/.test(txt) &&
  !/\[pos\] board png failed:/.test(txt));

ok('★ PNG 文件真的写出来了', fs.existsSync(png) && fs.statSync(png).size > 1024,
  fs.existsSync(png) ? (fs.statSync(png).size + ' 字节') : '文件不存在');

if (fs.existsSync(png)) {
  const buf = fs.readFileSync(png);
  const magic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  ok('★ 文件头是真正的 PNG 签名（不是把别的格式改了扩展名）',
    magic.every((b, i) => buf[i] === b),
    buf.slice(0, 8).toString('hex'));
  try { fs.copyFileSync(png, pngStable); } catch (e) {}

  let out = '';
  try {
    out = execSync('"' + PY + '" "' + ANALYZE + '" "' + png + '"', { encoding: 'utf8' });
  } catch (e) { out = 'PYERR ' + (e.stdout || '') + (e.stderr || '') + e.message; }
  let s = null;
  try { s = JSON.parse(out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()); }
  catch (e) { s = { err: out.slice(0, 300) }; }

  if (s && !s.err) {
    console.log('    ' + s.W + 'x' + s.H + '  black=' + s.black + ' white=' + s.white +
                ' grid=' + s.grid + ' coord=' + s.coord + ' uniq=' + s.uniq +
                ' green=' + s.green);
    const gb = s.gridBox;
    console.log('    gridBox=' + (gb ? (gb.w + 'x' + gb.h + ' @(' + gb.cx + ',' + gb.cy + ')') : 'null') +
                ' corner=' + JSON.stringify(s.corner));
    ok('★ 尺寸就是 800×800（用户 2026-09-19：「保存局面的 png 图片分辨率应为 800*800」）',
      s.W === WANT_W && s.H === WANT_H, s.W + 'x' + s.H + '（期望 ' + WANT_W + 'x' + WANT_H + '）');
    // ★ 800×800 是「等比缩放 + 居中」凑出来的，不是把 268×264 硬拉成正方形。
    //   判据：棋盘线是 210×210 设计单位的**正方形**，等比缩放下它在图上也必须方
    //   （老实现若改成拉伸，这里立刻变成 800:788 的长方形）。
    ok('★ 是等比缩放而非拉伸：棋盘外接矩形仍然是正方形（|宽−高| ≤ ' + 6 + '）',
      !!(gb && Math.abs(gb.w - gb.h) <= 6),
      gb ? (gb.w + 'x' + gb.h + '，差 ' + Math.abs(gb.w - gb.h)) : 'gridBox=null（棋盘线没认到）');
    ok('★ 棋盘水平居中（图宽 800 → 中心 400）',
      !!(gb && Math.abs(gb.cx - 400) <= 8), gb ? ('cx=' + gb.cx + '（期望 400±8）') : 'gridBox=null');
    ok('★ 四周留白、棋盘没被裁到边缘（等比缩放后短边多出的那点空白对半分）',
      !!(gb && gb.x0 >= 60 && gb.x1 <= 740 && gb.y0 >= 40 && gb.y1 <= 760),
      gb ? ('x[' + gb.x0 + ',' + gb.x1 + '] y[' + gb.y0 + ',' + gb.y1 + ']') : 'gridBox=null');
    ok('★ 棋盘真的画进去了（网格线 + 星位，成千上万像素）', s.grid > 3000, 'grid=' + s.grid);
    ok('★ 黑子真的画进去了（demo 局面 3 颗）', s.black > 500, 'black=' + s.black);
    ok('★ 白子真的画进去了（demo 局面 2 颗；底色也是白，所以只认 248..254 这一档）',
      s.white > 200, 'white=' + s.white);
    ok('★ 坐标标注也在（A..O / 1..15，导出的是完整卡片不是光秃秃的棋盘）',
      s.coord > 50, 'coord=' + s.coord);
    ok('★ 图里**没有**覆盖层铺底用的纯绿 —— 证明是「把卡片重画一遍」而不是「截屏幕上的一块」',
      s.green === 0, 'green=' + s.green);
    ok('不是一张纯色纸（抗锯齿产生了大量中间色）', s.uniq > 30, 'uniq=' + s.uniq);
  } else {
    ok('能解析导出的 PNG', false, (s && s.err) || out.slice(0, 200));
  }
}

console.log('\n== test-pos-save-png: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
