// 窄窗下前瞻标头换行验收：截图 + 量测 < > 是否与 前瞻/VCF/VCT 在不同行
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const UI = 'C:/Users/harve/Desktop/Gobang auto/desktop-calculator/ui';
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'calc.html';
  const f = path.normalize(path.join(UI, rel));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': (path.extname(f) === '.html' ? 'text/html' : path.extname(f) === '.js' ? 'application/javascript' : 'text/css') + '; charset=utf-8' });
  res.end(fs.readFileSync(f));
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });   // 特意压窄
  await page.goto('http://127.0.0.1:' + port + '/calc.html');
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    const box = document.getElementById('fwdBox');
    const r = (el) => { const b = el.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right) }; };
    const fwd = r(document.getElementById('btn_fwd'));
    const vcf = r(document.getElementById('btn_fwd_vcf'));
    const vct = r(document.getElementById('btn_fwd_vct'));
    const prev = r(document.getElementById('btn_fwd_prev'));
    const next = r(document.getElementById('btn_fwd_next'));
    const boxW = box.getBoundingClientRect().width;
    // 重叠检测：prev/next 与 fwd/vcf/vct 是否同 y 且 x 区间相交
    const overlap = (a, b) => Math.max(a.t, b.t) < Math.min(a.b, b.b) && Math.max(a.l, b.l) < Math.min(a.r, b.r);
    return {
      boxW: Math.round(boxW),
      sameRowAsFwd: overlap(fwd, prev) || overlap(fwd, next),
      sameRowAsVct: overlap(vct, prev),
      overlapAny: overlap(fwd, prev) || overlap(fwd, next) || overlap(vcf, prev) || overlap(vct, prev) || overlap(vcf, next) || overlap(vct, next),
      prevRow: prev.t, nextRow: next.t, vctRow: vct.t,
      vctRight: vct.r, prevLeft: prev.l, boxRight: Math.round(box.getBoundingClientRect().right),
    };
  });
  console.log(JSON.stringify(m));
  await page.screenshot({ path: 'C:/Users/harve/Desktop/Gobang auto/tools/_fwd_narrow.png', clip: { x: 0, y: 0, width: 560, height: 900 } });
  await browser.close(); srv.close();
});
