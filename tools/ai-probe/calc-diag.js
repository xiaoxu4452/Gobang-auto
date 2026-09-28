// calc.html 页面启动诊断：无头 Edge + 控制台/异常捕获 + 状态探针（含 Worker）。
'use strict';
process.env.NODE_PATH = 'C:/Users/harve/.workbuddy/binaries/node/workspace/node_modules';
require('module').Module._initPaths();
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[console:' + m.type() + ']', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e && e.stack || e).slice(0, 800)));
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure() && r.failure().errorText));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http' + r.status() + ']', r.url()); });
  page.on('worker', (w) => {
    console.log('[worker] attached url=' + w.url());
    w.on('console', (m) => console.log('[wconsole:' + m.type() + ']', m.text().slice(0, 300)));
    w.on('pageerror', (e) => console.log('[wpageerror]', String(e && e.stack || e).slice(0, 800)));
    w.on('close', () => console.log('[worker] closed'));
  });
  await page.goto('http://127.0.0.1:8990/calc.html', { waitUntil: 'domcontentloaded' });
  // 主动触发 AI boot（有些入口只在用户操作时才 boot）
  await page.evaluate(() => { try { if (window.LocalAI && LocalAI.boot) LocalAI.boot(); } catch (e) { console.log('boot call failed: ' + e.message); } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 8000));
  // 真实落子验证：空盘让 AI 执黑走一步（turnMs 压到 2s 加快验证）
  const mv = await page.evaluate(async () => {
    const board = Array.from({ length: 15 }, () => Array(15).fill(0));
    const r = await LocalAI.analyze({ board: board, topN: 1, turnMs: 2000, matchMs: 60000, rule: 0, lane: 'main', cid: 'diag' }, 15000);
    return { best: r.best, cands: (r.candidates || []).slice(0, 3).map((c) => ({ x: c.x, y: c.y, eval: c.eval })) };
  }).catch((e) => 'analyze failed: ' + e.message);
  console.log('MOVE', JSON.stringify(mv));
  await new Promise((r) => setTimeout(r, 1000));
  const st = await page.evaluate(`({
    workerReady: (typeof LocalAI !== 'undefined') && LocalAI.isReady(),
    moves: (typeof G !== 'undefined') ? G.moves.length : -1,
    over: (typeof G !== 'undefined') ? G.over : null,
  })`).catch((e) => 'eval failed: ' + e.message);
  console.log('STATE', JSON.stringify(st));
  await browser.close();
})().catch((e) => { console.error('driver failed:', e && e.message); process.exit(1); });
