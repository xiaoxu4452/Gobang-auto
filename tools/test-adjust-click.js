/* 手动调节按钮「点击 → startAdjust → 宿主弹选框」端到端测试（真实 Chromium 无头）
 * ----------------------------------------------------------------------------
 * 与 test-openpos-click.js 同款 harness：真实 Edge 加载真正的 panel.html（宿主模式，
 * 假的 WebView2 桥抓 postMessage），滚到 __gb_adjust、真实 .click()，
 * 看 window.__msgs 里有没有 {"type":"startAdjust"}。
 *
 * 诊断目的：用户 2026-09-18 新增「手动调节」——拖一个矩形圈定识别区域。
 * 本测试保证按钮可见可点、且点击真的把 startAdjust 报给宿主（宿主端据此弹全屏选框）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'desktop-overlay', 'ui');
const PANEL = path.join(UI_DIR, 'panel.html');
const HARNESS = path.join(UI_DIR, '_adjust_test.html');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const SHELL_JS = `
<script>
(function () {
  window.__msgs = [];
  window.chrome = {
    webview: {
      addEventListener: function (t, fn) { window.__handler = fn; },
      postMessage: function (s) { window.__msgs.push(String(s)); },
    },
  };
  window.fetch = function () { return Promise.reject(new Error('stub')); };
})();
</script>
`;

const TEST_JS = `
<script>
(function () {
  var out = [];
  function P(label, v) { out.push('PASS | ' + label + ' | ' + v); }
  function F(label, v) { out.push('FAIL | ' + label + ' | ' + v); }
  function finish() {
    var pre = document.createElement('pre');
    pre.id = '__test_out';
    var B = '<<' + 'GBRES' + '>>', E = '<<' + 'GBEND' + '>>';
    pre.textContent = '\\n' + B + '\\n' + out.join('\\n') + '\\n' + E + '\\n';
    document.body.appendChild(pre);
  }
  function done() {
    var btn = document.getElementById('__gb_adjust');
    if (!btn) { F('手动调节按钮存在', '找不到 #__gb_adjust'); finish(); return; }
    P('手动调节按钮存在', 'true');
    var r = btn.getBoundingClientRect();
    var body = document.getElementById('__gb_body');
    var panelH = document.getElementById('__gb_panel').getBoundingClientRect().height;
    var bodyBottom = body ? body.getBoundingClientRect().bottom : panelH;
    var visible = (r.top >= body.getBoundingClientRect().top - 1) && (r.bottom <= bodyBottom + 1);
    P('按钮几何', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    P('面板自然高度(px)', Math.round(panelH));
    P('按钮是否落在可见滚动区内', (visible ? '是(可见可点)' : '否(被裁掉)') + '  btn.bottom=' + Math.round(r.bottom) + ' body.bottom=' + Math.round(bodyBottom));
    P('点击前 startAdjust 数', String(window.__msgs.filter(function (m) { return m.indexOf('startAdjust') >= 0; }).length));
    try { btn.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { btn.click(); } catch (e) { F('点击抛出异常', e && e.message); finish(); return; }
    var n = window.__msgs.filter(function (m) { return m.indexOf('startAdjust') >= 0; }).length;
    if (n >= 1) P('点击后 startAdjust 已发出', String(n));
    else F('点击后 startAdjust 未发出', 'window.__msgs=' + JSON.stringify(window.__msgs.slice(0, 8)));
    finish();
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(done, 600);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(done, 600); });
})();
</script>
`;

function main() {
  let browser = null;
  for (const b of BROWSERS) { if (fs.existsSync(b)) { browser = b; break; } }
  if (!browser) { console.error('找不到 Edge/Chrome'); process.exit(1); }

  for (const [name, src] of [['SHELL_JS', SHELL_JS], ['TEST_JS', TEST_JS]]) {
    const body = src.replace(/^\s*<script>\s*/, '').replace(/<\/script>\s*$/, '');
    try { new vm.Script(body); } catch (e) { console.error(name + ' 语法错误：' + e.message); process.exit(1); }
  }

  let html = fs.readFileSync(PANEL, 'utf8');
  const atShell = html.indexOf('<script src="panel-ui.js">');
  if (atShell < 0) { console.error('找不到 panel-ui.js 引用'); process.exit(1); }
  html = html.slice(0, atShell) + SHELL_JS + html.slice(atShell);
  const atEnd = html.lastIndexOf('</body>');
  html = html.slice(0, atEnd) + TEST_JS + html.slice(atEnd);
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
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ad-'));
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--user-data-dir=' + profile, '--virtual-time-budget=12000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { dom += d; });
    const finish = (why) => {
      server.close();
      try { fs.unlinkSync(HARNESS); } catch (x) {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {}
      if (!dom.trim()) { console.error('浏览器无回传(' + why + ')'); process.exit(1); }
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
      if (!m) { console.error('页面无回传(' + why + ')'); process.exit(1); }
      const body = m[1];
      let pass = 0, fail = 0;
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
        else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
      }
      console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
      process.exit(fail ? 1 : 0);
    };
    const killer = setTimeout(() => { try { child.kill(); } catch (x) {} finish('超时'); }, 90000);
    child.on('exit', (code) => { clearTimeout(killer); finish('exit=' + code); });
  });
}
main();
