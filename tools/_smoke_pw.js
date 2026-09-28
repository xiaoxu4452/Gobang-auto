/* 用 playwright 驱动 Edge 加载 test-calculator.js 产出的 harness，解析 GBRES 断言 */
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright-core');
const UI_DIR = 'C:/Users/harve/Desktop/Gobang auto/desktop-calculator/ui';
const H = process.argv[2] || path.join(UI_DIR, '_calc_test.html.out.html');

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const f = path.normalize(path.join(UI_DIR, rel));
  if (!f.startsWith(path.normalize(UI_DIR)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { console.log('REQ 404:', req.url); res.writeHead(404); res.end('nf'); return; }
  console.log('REQ 200:', req.url, fs.statSync(f).size);
  const ext = path.extname(f);
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
  res.end(fs.readFileSync(f));
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/' + path.basename(H);
  let pass = 0, fail = 0;
  try {
    const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('pageerror', (e) => console.log('PAGEERROR:', String(e.message).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300)); });
    await page.goto(url);
    await page.waitForTimeout(6000);
    const info = await page.evaluate(() => ({
      pres: document.querySelectorAll('pre').length,
      gbres: document.body.innerHTML.indexOf('GBRES'),
      bodyLen: document.body.innerHTML.length,
    }));
    console.log('DEBUG', JSON.stringify(info));
    const dom = await page.evaluate(() => document.documentElement.outerHTML);
    await browser.close();
    const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
    if (!m) { console.log('  ✗ 页面无回传'); process.exitCode = 1; }
    else for (const line of m[1].split('\n')) {
      const t = line.trim();
      if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
      else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
    }
  } catch (e) { console.error('FATAL', e.message); process.exitCode = 1; }
  try { fs.unlinkSync(H); } catch (x) {}
  server.close();
  console.log('== B. 真实浏览器 UI 冒烟（playwright 复跑）==');
  console.log('  通过 ' + pass + '，失败 ' + fail);
  if (fail) process.exitCode = 1;
});
