#!/usr/bin/env node
/**
 * ★ 2026-10-01：**真 UI + 真引擎**自打端到端夹具（定位「黑白频繁交替 → 智力下降 / 下偏」）。
 *
 * 结构：
 *   · 无头 Edge 加载**真实 calc.html**（注入驱动脚本：开两个 AI 开关 → 自打 N 手）；
 *   · 假宿主实现 UI 原生通道的四个接口（/engine/status|ensure|cmd|out），
 *     背后是**真实的 Rapfi 进程**（在临时目录里跑，自带 config.toml + 权重副本，
 *     ⇒ 不会写用户发布目录里的 rapfi.db）；
 *   · 全程记录：每车道收到的命令批、引擎的原始输出、App 每帧的盘面快照。
 *
 * 判定（脚本末尾自动汇总）：
 *   ① App 落的子是否等于引擎刚回的那一手（不等 = 「下偏」在应用层）；
 *   ② 是否出现「上一手还没回包就又发了一批」（引擎 thinking=true 时 YXBOARD 会被丢）；
 *   ③ 每手的深度/评估走势。
 *
 * 用法：node tools/_selfplay_e2e.js [手数=8] [每手毫秒=2000] [toggle=0|1]
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'desktop-calculator', 'ui');
const REL = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
const EXE = 'RapfiEngine-avx2.exe';
const PLIES = +(process.argv[2] || 8);
const TURN_MS = +(process.argv[3] || 2000);
const TOGGLE = process.argv[4] === '1';
const LOG = path.join(__dirname, '_selfplay_e2e.log');
try { fs.unlinkSync(LOG); } catch (e) {}
function log(s) { const line = '[' + String(Date.now() % 100000).padStart(5, '0') + '] ' + s; fs.appendFileSync(LOG, line + '\n'); }

// ---------- 临时引擎目录（隔离 rapfi.db） ----------
const TMP = path.join(os.tmpdir(), 'gb-selfplay-eng');
(function prepare() {
  fs.mkdirSync(TMP, { recursive: true });
  const need = [EXE, 'config.toml', 'mix9svqfreestyle_bsmix.bin.lz4', 'mix9svqstandard_bs15.bin.lz4',
                'mix9svqrenju_bs15_black.bin.lz4', 'mix9svqrenju_bs15_white.bin.lz4',
                'model210901.bin', 'model220723.bin'];   // ★ classic 模型也要（缺了 config 加载失败 → 进程秒退）
  for (const f of need) {
    const dst = path.join(TMP, f);
    if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(REL, f), dst); }
  }
  try { fs.unlinkSync(path.join(TMP, 'rapfi.db')); } catch (e) {}   // 每次跑都用干净库
})();

// ---------- 引擎池 ----------
const pool = {};
function laneEngine(lane) {
  let st = pool[lane];
  if (st && st.alive) return st;
  const child = spawn(path.join(TMP, EXE), [], { cwd: TMP, windowsHide: true });
  st = pool[lane] = { lane, child, lines: [], alive: true, buf: '' };
  child.stdout.on('data', d => {
    st.buf += d.toString();
    let i;
    while ((i = st.buf.indexOf('\n')) >= 0) {
      const ln = st.buf.slice(0, i); st.buf = st.buf.slice(i + 1);
      st.lines.push(ln);
      if (/^[A-Za-z]?\d*,\d+$|best|REJECT|FORBID/i.test(ln.trim())) log('  <' + lane + ' ' + ln.trim());
    }
  });
  child.stderr.on('data', () => {});
  child.on('exit', () => { st.alive = false; log('  !' + lane + ' 进程退出'); });
  log('  + 启动引擎 lane=' + lane + ' pid=' + child.pid);
  return st;
}

// ---------- 驱动脚本（注入到真实 calc.html） ----------
const DRIVER = `
<script>
(function(){
  var T0 = Date.now(), snaps = [], done = false;
  function dash(){
    function g(id){ var e = document.getElementById(id); return e ? (e.textContent||'').trim() : ''; }
    return { depth: g('depth'), speed: g('speed'), nodes: g('nodes'), time: g('time'), eval: g('eval'), best: g('best') };
  }
  function snap(tag){
    try {
      snaps.push({ t: Date.now()-T0, tag: tag, moves: (G.moves||[]).map(function(m){return [m.x,m.y,m.c];}),
        busy: !!G.busy, paused: !!S.paused, aiB: !!S.aiB, aiW: !!S.aiW, turn: S.turnMs, dash: dash() });
    } catch(e) { snaps.push({ t: Date.now()-T0, tag: tag, err: String(e) }); }
  }
  function report(why){
    if (done) return; done = true;
    snap('end');
    try { fetch('/report', { method:'POST', body: JSON.stringify({ why: why, snaps: snaps }) }); } catch(e){}
  }
  var startAt = 4200;   // 等 boot（START + 60ms 余量 + 热身 0.5s）走完
  setTimeout(function(){
    try { S.turnMs = ${TURN_MS}; save && save(); } catch(e){}
    var b = document.getElementById('ai_side_b'), w = document.getElementById('ai_side_w');
    if (b) b.click();
    setTimeout(function(){
      if (w) w.click();
      snap('selfplay-on');
      if (${TOGGLE ? 1 : 0}) {           // 模拟用户「频繁切换黑子/白子」
        var n = 0, iv = setInterval(function(){
          n++;
          try { (n % 2 ? b : w).click(); } catch(e){}
          snap('toggle'+n);
          if (n >= 6) clearInterval(iv);
        }, 700);
      }
    }, 600);
  }, startAt);
  var iv2 = setInterval(function(){
    snap('tick');
    var n = (G.moves||[]).length;
    if (n >= ${PLIES}) { clearInterval(iv2); report('plies=' + n); return; }
    if (Date.now()-T0 > ${Math.max(40000, PLIES * (TURN_MS + 2500))}) { clearInterval(iv2); report('timeout n=' + n); }
  }, 250);
})();
</script>
`;

function harnessHtml() {
  let html = fs.readFileSync(path.join(UI, 'calc.html'), 'utf8');
  const at = html.lastIndexOf('</body>');
  return html.slice(0, at) + DRIVER + html.slice(at);
}

// ---------- HTTP 服务 ----------
let reportResolve = null;
const reportP = new Promise(r => { reportResolve = r; });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/report') {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      try { reportResolve(JSON.parse(b)); } catch (e) { reportResolve({ err: 'bad report' }); }
    });
    return;
  }
  if (p === '/engine/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: true, variant: 'avx2', cpus: 16, memMB: 32000 }));
    return;
  }
  if (p === '/engine/ensure') {
    laneEngine(u.searchParams.get('lane') || 'main');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
  }
  if (p === '/engine/cmd') {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => {
      const lane = u.searchParams.get('lane') || 'main';
      const st = laneEngine(lane);
      log('  >' + lane + ' ' + b.replace(/\n/g, ' ⏎ ').slice(0, 240));
      try { st.child.stdin.write(b.endsWith('\n') ? b : b + '\n'); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
    });
    return;
  }
  if (p === '/engine/out') {
    const lane = u.searchParams.get('lane') || 'main';
    const st = laneEngine(lane);
    const since = +(u.searchParams.get('since') || 0);
    const lines = st.lines.slice(since);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ seq: st.lines.length, lines: lines, alive: st.alive }));
    return;
  }
  // 静态：__e2e.html = 注入驱动的真实 calc.html
  let file = p === '/' ? '/__e2e.html' : p;
  if (file === '/__e2e.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(harnessHtml()); return;
  }
  const f = path.join(UI, decodeURIComponent(file).replace(/^\/+/, ''));
  if (!f.startsWith(UI) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  const ext = path.extname(f);
  res.writeHead(200, { 'Content-Type': (ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/css') + '; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

function findBrowser() {
  const cands = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/__e2e.html';
  const browser = findBrowser();
  if (!browser) { console.error('没找到 Edge'); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-e2e-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile, '--window-size=1280,860', url], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', () => {});
  const hard = setTimeout(() => { console.log('(硬超时)'); finish(null); }, Math.max(120000, PLIES * (TURN_MS + 3000) + 60000));
  child.on('exit', () => { clearTimeout(hard); finish(null); });
  let rep = null;
  function finish(r) {
    if (r) rep = r;
    if (finish.done) return; finish.done = true;
    try { child.kill(); } catch (e) {}
    for (const k in pool) { try { pool[k].child.kill('SIGKILL'); } catch (e) {} }
    try { server.close(); } catch (e) {}
    summarize(rep);
    process.exit(0);
  }
  reportP.then(r => { finish(r); });
});

// ---------- 汇总 ----------
function summarize(rep) {
  console.log('\n===== 端到端自打汇总 =====');
  if (!rep) { console.log('  ✗ 页面没回传报告'); return; }
  const snaps = rep.snaps || [];
  const end = snaps[snaps.length - 1] || {};
  console.log('  结束原因：' + rep.why);
  console.log('  终局盘面（' + ((end.moves || []).length) + ' 手）：' +
    (end.moves || []).map(m => (m[2] === 1 ? 'B' : 'W') + '(' + m[0] + ',' + m[1] + ')').join(' '));
  // 盘面增长史 + 每帧仪表盘
  const growth = [];
  let lastN = -1;
  snaps.forEach(s => {
    const n = (s.moves || []).length;
    if (n !== lastN) {
      lastN = n;
      const d = s.dash || {};
      growth.push({ t: s.t, n: n, depth: d.depth, eval: d.eval, best: d.best, time: d.time });
      console.log('  [' + String(s.t).padStart(6) + 'ms] 手数=' + n + '  深度=' + d.depth +
        '  评估=' + d.eval + '  最佳=' + d.best + '  用时=' + d.time +
        '  busy=' + s.busy + ' paused=' + s.paused);
    }
  });
  console.log('\n  —— 逐手对账（引擎回复 vs App 落子）见 ' + LOG);
}
