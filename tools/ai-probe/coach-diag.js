// 指导视图 / 热力图端到端验证（真 Chromium + 真页面内 AI）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = 'C:/Users/harve/Desktop/Gobang auto';
const OUT = path.join(ROOT, 'tools', '_coach_diag.txt');
const L = [];
function log(s) { L.push(s); }

(async () => {
  const exe = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true }); }
  catch (e) { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { window.__GB_TEST__ = true; });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/error/i.test(m.type())) log('[console.error] ' + m.text().slice(0, 160)); });
  page.on('pageerror', (e) => log('[pageerror] ' + String(e).slice(0, 200)));

  await page.goto('http://127.0.0.1:8990/calc.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.LocalAI, null, { timeout: 15000 });
  log('page loaded, LocalAI present');

  // 等引擎就绪（worker boot：START → 1.5s → INFO → ready）
  await page.waitForFunction(() => window.LocalAI && LocalAI.isReady(), null, { timeout: 60000 });
  log('workerReady = true');

  // 勾上「指导视图」→ 等 G.coach 铺上方形四色热力（含数字）
  await page.evaluate(() => {
    const c = document.getElementById('chk_coach');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
  });
  try {
    await page.waitForFunction(() => window.G && G.coach && G.coach.length > 0, null, { timeout: 30000 });
    const info = await page.evaluate(() => ({
      coachLen: G.coach.length,
      tiers: G.coach.map((h) => h.tier),
      evSample: G.coach.slice(0, 3).map((h) => h.ev),
      legendVisible: !document.getElementById('heatLegend').hidden,
      persisted: (JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}') || {}).coach === true,
    }));
    log('coach view OK: ' + JSON.stringify(info));
  } catch (e) { log('COACH TIMEOUT: G.coach stayed empty'); }

  // 勾上「热力图」→ AI 方面 = 圆形两色（数据同为非空即可，形状由渲染层保证）
  await page.evaluate(() => {
    const c = document.getElementById('chk_heat');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
  });
  try {
    await page.waitForFunction(() => window.G && G.heat && G.heat.length > 0, null, { timeout: 30000 });
    const info = await page.evaluate(() => ({ heatLen: G.heat.length, evSample: G.heat.slice(0, 2).map((h) => h.ev) }));
    log('heat OK: ' + JSON.stringify(info));
  } catch (e) { log('HEAT TIMEOUT: G.heat stayed empty'); }

  // 评估曲线：塞几个点进去，确认 drawCurve 不抛错（贝塞尔面积路径）
  const curveOk = await page.evaluate(() => {
    try {
      G.curve = [{ i: 1, b: 30, w: -30 }, { i: 2, b: -80, w: 80 }, { i: 3, b: 260, w: -260 }, { i: 4, b: -40, w: 40 }];
      drawCurve();
      return true;
    } catch (e) { return 'ERR ' + e.message; }
  });
  log('drawCurve smoke: ' + curveOk);

  // 用户落子 → 指导视图立刻消失（循环语义第一步）
  await page.evaluate(() => { afterMove && (window.__hadCoach = G.coach.length); });
  const cleared = await page.evaluate(() => { clearCoach(); return G.coach.length === 0; });
  log('clearCoach works: ' + cleared);

  await browser.close();
  fs.writeFileSync(OUT, L.join('\n'));
  console.log('DIAG DONE');
})().catch((e) => { L.push('FATAL ' + String(e).slice(0, 300)); fs.writeFileSync(OUT, L.join('\n')); console.log('DIAG FATAL'); });
