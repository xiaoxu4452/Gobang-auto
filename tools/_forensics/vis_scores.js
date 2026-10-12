/* 视觉验证：每个阶段截图，确认评分色块是否可见 */
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { place(7, 7); afterMove(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { place(8, 8); afterMove(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { place(9, 9); afterMove(); });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: 'tools/_forensics/vis_1_scores.png' });

  await page.evaluate(() => { anaCalc(); });
  await page.waitForTimeout(13500);
  await page.screenshot({ path: 'tools/_forensics/vis_2_after_calc.png' });

  await page.evaluate(() => { anaNbest(); });
  await page.waitForTimeout(17000);
  await page.screenshot({ path: 'tools/_forensics/vis_3_after_nbest.png' });

  await page.evaluate(() => { anaDefend(true); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'tools/_forensics/vis_4_after_defend.png' });

  await browser.close();
  console.log('DONE');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
