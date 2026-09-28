// 通过 CDP 连宿主 WebView2，抓 gbcalc.local 页面的 console / 状态。
'use strict';
process.env.NODE_PATH = 'C:/Users/harve/.workbuddy/binaries/node/workspace/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright-core');
const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); })
      .on('error', reject);
  });
}

(async () => {
  // 等 CDP 端口起来
  let targets = null;
  for (let i = 0; i < 20; i++) {
    try { targets = await getJson('http://127.0.0.1:9333/json/list'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!targets) { console.log('CDP port never came up'); process.exit(1); }
  const pageTarget = targets.find((t) => t.type === 'page' && /gbcalc\.local/.test(t.url));
  console.log('targets:', targets.map((t) => t.type + ' ' + t.url.slice(0, 60)).join(' | '));
  if (!pageTarget) { console.log('no gbcalc.local page target'); process.exit(1); }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => /gbcalc\.local/.test(p.url())) || pages[0];
  page.on('console', (m) => console.log('[console:' + m.type() + ']', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e && e.stack || e).slice(0, 800)));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure() && r.failure().errorText));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http' + r.status() + ']', r.url().slice(0, 120)); });
  page.on('worker', (w) => {
    console.log('[worker] attached url=' + w.url().slice(0, 100));
    w.on('pageerror', (e) => console.log('[wpageerror]', String(e && e.stack || e).slice(0, 500)));
  });

  await new Promise((r) => setTimeout(r, 15000));
  const st = await page.evaluate(`({
    url: location.href,
    crossOriginIsolated: self.crossOriginIsolated,
    hasLocalAI: typeof LocalAI,
    workerReady: (typeof LocalAI !== 'undefined') && LocalAI.isReady(),
    boardPx: !!document.getElementById('board'),
    bodyChildren: document.body ? document.body.children.length : -1,
  })`).catch((e) => 'eval failed: ' + e.message);
  console.log('STATE', JSON.stringify(st));
  process.exit(0);
})().catch((e) => { console.error('driver failed:', e && e.message); process.exit(1); });
