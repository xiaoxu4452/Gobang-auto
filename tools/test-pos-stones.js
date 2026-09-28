#!/usr/bin/env node
/**
 * 「局面」小窗的**真实报文**端到端护栏：识别服务 JSON → 宿主解析 → 局面代码 → 剪贴板。
 *
 * 为什么必须单独有一条：
 *   用户 2026-09-18 报「局面的小棋盘并没有正确展示识别出当前的棋盘以及代码」。
 *   根因是宿主 ParseStonesForPos 死抠字面量 `"black":[`（冒号后**紧贴**方括号），
 *   而识别服务那边是 Python `json.dumps(obj, ensure_ascii=False)`，默认分隔符是
 *   `", "` / `": "`，真实报文长这样：`"black": [{"x": 7, "y": 7}, ...]`（冒号后有一个空格）
 *   → 永远匹配不上 → g_posBoard 恒为空 → 局面小窗恒显示空盘、代码恒为空，
 *   而**面板与引擎完全正常**（它们拿的是同一帧 JSON，走页面自己的解析器）。
 *   现场表现就是「面板有推荐落点、局面小窗却是空盘」。
 *
 *   这条链路以前**一条断言都没有**：唯一被覆盖的是 GB_TEST_DEMO_POS 那条「演示注入」，
 *   它直接写 g_posBoard，把要测的解析步骤整段绕过去了 —— 所以这个 bug 能在全绿套件下活到今天。
 *
 * 本测试的做法（全程走真实链路，不注入任何棋盘）：
 *   ① 起一个**假的识别服务**，监听 GB_SCAN_PORT，回一帧用 Python `json.dumps`
 *      真正序列化出来的报文（分隔符与线上逐字一致 —— 这是本测试成立的前提，已断言）；
 *   ② 拉真 exe，靠 GB_TEST_COPY_POS 在「真实报文解析成功」后自动点一次「复制代码」；
 *   ③ 用 PowerShell 的 Get-Clipboard 读**真实剪贴板**，逐字比对。
 *
 * ★ 本文件全程 async/await —— 不能用 spawnSync 当 sleep：那会把 Node 事件循环按死，
 *   假识别服务就永远回不了请求（第一版正是这么写的，表现为「服务起了但 hits=0」）。
 *
 * 断言：
 *   · 日志出现 `[pos] stones updated: B=3 W=3 (recognized=1)` —— 6 颗子真的被解析进了
 *     g_posBoard（旧实现在这里是 B=0 W=0，即「有棋盘、没棋子」：面板有推荐、小窗是空盘）
 *   · 剪贴板内容**恰好等于总代码** `H10I8K8H7J7I6`（黑白合并、连写、无前缀）
 *   · 剪贴板里**不许**出现 `Gomoku15` / `A: ` / `B: ` / `W: ` / 换行 ——
 *     用户 2026-09-18：「点击复制代码，只复制总代码（连一块的棋盘局势代码）」
 *   · 「保存局面」仍是完整四行：由 test-guide-layer.js 的源码断言守住
 *     （这里不去点保存按钮 —— 会弹模态文件对话框，自动化下必卡）
 *
 * ⚠️ 会短暂弹出覆盖层面板/局面小窗（与 test-overlay-pos-render 同一性质），跑完 taskkill 整树回收。
 *
 * 用法：node tools/test-pos-stones.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
const BUILD = path.join(ROOT, 'desktop-overlay', 'build');
const PY = path.join(ROOT, 'tools', 'python-bundle', 'runtime', 'python.exe');
const PORT = 18971;                       // 与用户真实识别服务 8971 完全隔离

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : ' | ' + extra)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 一帧「线上格式」报文
// 必须由 Python json.dumps 生成：默认分隔符是 ", " / ": "，冒号后**有空格**。
// 用 JSON.stringify 拼出来的报文是紧贴写法（`"black":[{...}]`），恰好能被旧代码匹配上，
// 那样这条测试就失去了意义 —— 所以这里坚持用真 Python 序列化。
const PY_PAYLOAD = [
  'import json, sys',
  'x_lines = [100.0 + 57.1 * i for i in range(15)]',
  'y_lines = [100.0 + 57.1 * i for i in range(15)]',
  'd = {',
  '  "ok": True, "found": True, "offset": [0, 0],',
  '  "board_rect": {"x": 100.0, "y": 100.0, "w": 799.4, "h": 799.4},',
  '  "geometry": {"x_lines": x_lines, "y_lines": y_lines, "spacing": 57.1, "size": 15},',
  '  "black": [{"x": 7, "y": 8}, {"x": 9, "y": 8}, {"x": 8, "y": 9}],',
  '  "white": [{"x": 7, "y": 5}, {"x": 8, "y": 7}, {"x": 10, "y": 7}],',
  '  "suspect": False, "multi_board": 1,',
  '  "diag": {"method": "adaptive", "black": 3, "white": 3, "total": 6, "suspect": False},',
  '}',
  'sys.stdout.write(json.dumps(d, ensure_ascii=False))',
].join('\n');
const gen = spawnSync(PY, ['-c', PY_PAYLOAD], { encoding: 'utf8', maxBuffer: 8 << 20 });
const PAYLOAD = gen.stdout || '';

// ---------------------------------------------------------------- 期望值（自己按规范算）
// 坐标口径与 host.cpp BuildPositionCode 一致：列 = 'A'+x，行 = 15-y。
const STONES = [[7, 5, 2], [8, 7, 2], [10, 7, 2], [7, 8, 1], [9, 8, 1], [8, 9, 1]];
const coord = (x, y) => String.fromCharCode(65 + x) + (15 - y);
let WANT_TOTAL = '';
for (let y = 0; y < 15; y++) {
  for (let x = 0; x < 15; x++) {
    if (STONES.some((t) => t[0] === x && t[1] === y)) WANT_TOTAL += coord(x, y);
  }
}

const log = path.join(BUILD, 'posstones-' + process.pid + '.log');
const clipFile = path.join(BUILD, 'posstones-clip-' + process.pid + '.txt');
function readLog() { try { return fs.readFileSync(log, 'utf8'); } catch (e) { return ''; } }
async function waitFor(pred, capMs) {
  const t0 = Date.now();
  for (;;) {
    const txt = readLog();
    if (pred(txt)) return { hit: true, txt };
    if (Date.now() - t0 > capMs) return { hit: false, txt };
    await sleep(700);
  }
}

let child = null, server = null, logText = '', hits = 0;

async function main() {
  console.log('== test-pos-stones ==');
  if (gen.error || !PAYLOAD) {
    ok('能生成假报文（需要便携 Python）', false, String(gen.error || gen.stderr));
    return;
  }
  ok('假识别服务回的是 json.dumps 默认分隔符（冒号后有空格）—— 本测试成立的前提',
    PAYLOAD.indexOf('"black": [') >= 0 && PAYLOAD.indexOf('"found": true') >= 0 &&
    PAYLOAD.indexOf('"suspect": false') >= 0, PAYLOAD.slice(0, 70));
  ok('找不到覆盖层 exe 就没法测', fs.existsSync(EXE), EXE);

  for (const f of [log, clipFile]) { try { fs.unlinkSync(f); } catch (e) { /* 首次不存在 */ } }

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(PAYLOAD);
    });
  });
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(PORT, '127.0.0.1', res);
  });
  ok('假识别服务已在 127.0.0.1:' + PORT + ' 监听', server.listening === true);

  // ★ 先清残留实例：局面小窗是 TOPMOST，残留实例会挡在同一个位置
  spawnSync('taskkill', ['/IM', 'Desktop GomokuOverlay.exe', '/F'], { stdio: 'ignore' });

  const env = Object.assign({}, process.env, {
    GB_SCAN_PORT: String(PORT),
    GB_TEST_OPEN_POS: '1',           // 自动打开局面小窗
    GB_TEST_COPY_POS: '1',           // 解析成功后自动点一次「复制代码」
    GB_LOG_FILE: log,
    GB_INSTANCE_ID: 'posstones-' + process.pid,
  });
  child = spawn(EXE, [], { env, stdio: 'ignore', detached: false });
  ok('已拉起覆盖层（GB_SCAN_PORT=' + PORT + '，GB_TEST_COPY_POS=1）', !!child.pid);

  // ① 6 颗子真的进了 g_posBoard（旧实现在这里永远是 B=0 W=0）
  //    用 `[pos] stones updated` 而不是 `[pos] paint ... board=1`：后者每种尺寸只打两次、
  //    永远拍在「窗口刚开、还没扫到盘」的时刻（这正是用户排查时被带偏的那两行）。
  const r1 = await waitFor((t) => /\[pos\] stones updated: B=3 W=3 \(recognized=1\)/.test(t), 160000);
  logText = r1.txt;
  ok('★ 真实报文被解析：局面小窗收到 B=3 W=3（3 黑 3 白；旧实现在这里是 B=0 W=0）', r1.hit,
    (logText.match(/\[pos\] stones updated[^\n]*/g) || []).join(' | ') || '(没有 stones updated 行)');
  ok('假识别服务确实被请求过（走的是真扫描链路，不是注入）', hits > 0, 'hits=' + hits);

  // ② 复制动作发生
  const r2 = await waitFor((t) => t.indexOf('total code copied to clipboard') >= 0, 40000);
  logText = r2.txt;
  ok('★ 「复制代码」把总代码放进剪贴板（日志确认）', r2.hit,
    (logText.match(/\[pos\][^\n]*cop[^\n]*/g) || []).slice(-1)[0] || '(没有 copy 行)');

  // ③ 读真实剪贴板
  const ps = [
    '$t = Get-Clipboard -Raw',
    "if ($null -eq $t) { $t = '' }",
    '[IO.File]::WriteAllText(' + JSON.stringify(clipFile) + ', [string]$t, [Text.UTF8Encoding]::new($false))',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  let clip = '';
  try { clip = fs.readFileSync(clipFile, 'utf8'); } catch (e) { clip = ''; }
  ok('能用 PowerShell 读到剪贴板', r.status === 0 && fs.existsSync(clipFile),
    (r.stderr || '').trim().slice(0, 120));
  ok('★ 剪贴板内容**恰好等于总代码**：' + WANT_TOTAL, clip === WANT_TOTAL,
    'clipboard=' + JSON.stringify(clip));
  ok('★ 剪贴板里没有表头/分段前缀（Gomoku15 / A: / B: / W:）',
    clip.indexOf('Gomoku15') < 0 && clip.indexOf('A:') < 0 &&
    clip.indexOf('B:') < 0 && clip.indexOf('W:') < 0, JSON.stringify(clip));
  ok('★ 剪贴板里没有换行（只有连成一块的一串坐标）',
    clip.indexOf('\n') < 0 && clip.indexOf('\r') < 0, JSON.stringify(clip));
  ok('没有「空盘就不复制」的误伤（棋盘有 6 子，必须真的复制了）',
    clip.length === WANT_TOTAL.length && clip.length > 0);
}

main().catch((e) => { fail++; console.log('  ✗ 异常: ' + (e && e.stack || e)); })
  .then(() => {
    if (server) { try { server.close(); } catch (e) { /* 已关 */ } }
    if (child && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    spawnSync('taskkill', ['/IM', 'Desktop GomokuOverlay.exe', '/F'], { stdio: 'ignore' });
    if (fail === 0) {
      for (const f of [log, clipFile]) { try { fs.unlinkSync(f); } catch (e) { /* 无所谓 */ } }
    } else {
      console.log('  (保留现场：' + log + ' / ' + clipFile + ')');
    }
    console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
    process.exit(fail ? 1 : 0);
  });
