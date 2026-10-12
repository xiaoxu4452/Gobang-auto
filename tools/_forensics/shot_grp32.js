const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/harve/Desktop/Gobang auto/tools/_forensics/';
(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await pg.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2200);
  await pg.click('#seg_side button[data-ai="b"]');
  await pg.click('#seg_side button[data-ai="w"]');
  await pg.waitForTimeout(600);
  const box = await pg.evaluate(() => {
    const c = document.querySelector('.card[data-id="setup"]').getBoundingClientRect();
    return { x: Math.max(0, Math.floor(c.left) - 6), y: Math.max(0, Math.floor(c.top) - 6), width: Math.ceil(c.width) + 12, height: Math.min(880, Math.ceil(c.height) + 12) };
  });
  await pg.screenshot({ path: OUT + 'g4_setup_card.png', clip: box });
  console.log('clip', JSON.stringify(box));
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
