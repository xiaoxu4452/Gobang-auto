/* 热力图真机验证（需要引擎在 :8964 上跑）
 * ----------------------------------------------------------------------------
 * 为什么要有这个脚本：热力图的三个要求（及时 / 分车道 / 数字=评估分）**都只能靠真引擎验证** ——
 * 源码断言只能证明「代码写了」，证明不了「引擎真的在 AI 深搜的同时把 8 条候选喂回来了」。
 *
 * 做法：真实 Edge 无头加载 calc.html（本机 HTTP 起，避免 file:// 的 null origin），
 *   1) 打开「热力图」开关；
 *   2) 点棋盘正中落一子（人机模式 → 触发 afterMove）；
 *   3) 等 1.2s 拍一张快照（此刻 AI 还在深搜）→ 看热力是否**已经**铺上（=「及时」）；
 *   4) 再等 6s 拍终态 → 看格内数字是不是评估分（+350 / -120 / M3 这种）、档位是否 4 档齐全。
 *
 * 用法：先起引擎（Web GomokuEngine.exe --as-backend），再 node tools/test-heat-live.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'desktop-calculator', 'ui');
const HARNESS = path.join(UI_DIR, '_heat_live.html');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const PROBE_JS = `
<script>
(function () {
  var out = [];
  function P(label, v) { out.push('PASS | ' + label + ' | ' + v); }
  function F(label, v) { out.push('FAIL | ' + label + ' | ' + v); }
  function heatDump() {
    var h = (window.G && window.G.heat) || [];
    return h.map(function (c) { return c.x + ',' + c.y + '=' + c.ev + '/t' + c.tier; }).join(' ');
  }
  function snap(tag, early) {
    var G = window.G, h = (G && G.heat) || [];
    var rows = [];
    rows.push(tag + ' moves=' + (G ? G.moves.length : -1) + ' busy=' + (G ? G.busy : -1) +
              ' heat=' + h.length + ' heatLen=' + (G ? G.heatLen : -1));
    rows.push('  cells: ' + heatDump());
    return rows.join('\\n');
  }
  function done() {
    var G = window.G;
    var log = [];
    log.push(snap('T+1.2s', true));
    // ---- 及时性：AI 还在深搜时热力就该已经铺好 ----
    if (G.heat.length > 0) P('落子瞬间热力已铺上（AI 尚未落子/仍在深搜）', G.heat.length + ' 格');
    else F('落子瞬间热力已铺上（AI 尚未落子/仍在深搜）', '0 格');

    setTimeout(function () {
      log.push(snap('T+7s', false));
      var h = G.heat;
      if (h.length > 0) P('热力格存在', h.length + ' 格');
      else F('热力格存在', '0 格');
      var withEv = h.filter(function (c) { return c.ev && /^[-+]?(M\\d+|\\d+)$/.test(c.ev); });
      if (h.length && withEv.length === h.length)
        P('每格数字都是评估分（+350 / -120 / M3 形态）', h.map(function (c) { return c.ev; }).join(' '));
      else F('每格数字都是评估分（+350 / -120 / M3 形态）', withEv.length + '/' + h.length);
      var tiers = {};
      h.forEach(function (c) { tiers[c.tier] = 1; });
      if (h.length >= 4 && Object.keys(tiers).length >= 3)
        P('档位铺开（4 档色带，不是整盘一色）', 'tiers=' + Object.keys(tiers).join(','));
      else F('档位铺开（4 档色带，不是整盘一色）', 'tiers=' + Object.keys(tiers).join(',') + ' n=' + h.length);
      if (G.moves.length >= 2) P('同时 AI 也落了子（两条请求确实并行跑完）', G.moves.length + ' 手');
      else F('同时 AI 也落了子（两条请求确实并行跑完）', G.moves.length + ' 手');
      // 热力格不该压在已有棋子上
      var bad = h.filter(function (c) { return G.board[c.y][c.x] !== 0; });
      if (!bad.length) P('热力格都在空点上（被占的格子已摘掉）', 'true');
      else F('热力格都在空点上（被占的格子已摘掉）', bad.length + ' 格压着子');
      log.forEach(function (l) { out.push('INFO | ' + l); });
      finish();
    }, 6400);
  }
  function finish() {
    var pre = document.createElement('pre');
    pre.id = '__test_out';
    var B = '<<' + 'GBRES' + '>>', E = '<<' + 'GBEND' + '>>';
    pre.textContent = '\\n' + B + '\\n' + out.join('\\n') + '\\n' + E + '\\n';
    document.body.appendChild(pre);
  }
  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      // 打开热力图开关
      var cb = document.getElementById('chk_heat');
      if (cb && !cb.checked) cb.click();
      // 落一子（棋盘正中；人机模式，我执黑 → 落完轮到 AI）
      var cv = document.getElementById('board');
      var r = cv.getBoundingClientRect();
      var ax = Math.max(14, r.width * 0.055);
      var pad = ax + Math.max(4, r.width * 0.012);
      var gap = (r.width - pad * 2) / 14;
      cv.dispatchEvent(new MouseEvent('click', {
        clientX: r.left + pad + 7 * gap, clientY: r.top + pad + 7 * gap, bubbles: true,
      }));
      setTimeout(done, 1200);
    }, 1200);
  });
})();
</script>
`;

function main() {
  let browser = null;
  for (const b of BROWSERS) { if (fs.existsSync(b)) { browser = b; break; } }
  if (!browser) { console.error('找不到 Edge/Chrome'); process.exit(1); }
  const body = PROBE_JS.replace(/^\s*<script>\s*/, '').replace(/<\/script>\s*$/, '');
  try { new vm.Script(body); } catch (e) { console.error('探针语法错误：' + e.message); process.exit(1); }

  let html = fs.readFileSync(path.join(UI_DIR, 'calc.html'), 'utf8');
  const atEnd = html.lastIndexOf('</body>');
  html = html.slice(0, atEnd) + PROBE_JS + html.slice(atEnd);
  fs.writeFileSync(HARNESS, html, 'utf8');

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(UI_DIR, rel);
    if (!f.startsWith(UI_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    const ext = path.extname(f);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/' + path.basename(HARNESS);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-heat-'));
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--user-data-dir=' + profile, '--virtual-time-budget=20000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { dom += d; });
    const finish = () => {
      server.close();
      try { fs.unlinkSync(HARNESS); } catch (x) {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {}
      if (!dom.trim()) { console.error('浏览器无回传'); process.exit(1); }
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
      if (!m) { console.error('页面无回传（引擎没起？页面报错了？）'); process.exit(1); }
      let pass = 0, fail = 0;
      for (const line of m[1].split('\n')) {
        const t = line.trim();
        if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
        else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
        else if (t.indexOf('INFO |') === 0) console.log('    · ' + t.slice(7));
      }
      console.log('--- test-heat-live: ' + pass + ' passed, ' + fail + ' failed ---');
      process.exit(fail ? 1 : 0);
    };
    const killer = setTimeout(() => { try { child.kill(); } catch (x) {} finish(); }, 120000);
    child.on('exit', () => { clearTimeout(killer); finish(); });
  });
}
main();
