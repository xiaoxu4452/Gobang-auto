// 探针驱动：用系统 Edge 打开 probe.html，等 PROBE_DONE，打印结果与诊断。
'use strict';
process.env.NODE_PATH = 'C:/Users/harve/.workbuddy/binaries/node/workspace/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[console:' + m.type() + ']', m.text().slice(0, 400)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e && e.stack || e).slice(0, 600)));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure() && r.failure().errorText));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http' + r.status() + ']', r.url()); });
  await page.goto('http://127.0.0.1:8990/probe.html', { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction('window.PROBE_DONE !== undefined', null, { timeout: 120000 });
    const r = await page.evaluate('window.PROBE_DONE');
    const iso = await page.evaluate('self.crossOriginIsolated');
    console.log('RESULT', JSON.stringify({ ...r, crossOriginIsolated: iso }));
  } catch (e) {
    console.log('TIMEOUT/ERROR', e.message);
    console.log('OUT TEXT >>>');
    console.log(await page.evaluate('document.getElementById("out").textContent'));
  }
  await browser.close();
})().catch((e) => { console.error('driver failed:', e && e.message); process.exit(1); });
