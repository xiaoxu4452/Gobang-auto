// 截「对局设置」卡特写：AI 执黑 / AI 执白 / 摆棋评分 三颗拨动开关（中英两种文案）
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/harve/Desktop/Gobang auto/tools/_forensics/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const pg = await b.newPage({ viewport: { width: 1400, height: 950 } });
  await pg.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2500);
  const card = await pg.$('.card[data-id="setup"]');
  // 默认：三个都关（AI 黑白都不开）
  await pg.evaluate(() => { S.aiB = false; S.aiW = false; syncSideUI(); });
  await pg.waitForTimeout(400);
  await card.screenshot({ path: OUT + 't1_all_off.png' });
  // 开 AI 执白（= 你执黑）
  await pg.evaluate(() => { S.aiW = true; syncSideUI(); });
  await pg.waitForTimeout(500);
  await card.screenshot({ path: OUT + 't2_ai_white_on.png' });
  // 英文
  await pg.evaluate(() => { if (typeof setLang === 'function') setLang('en'); else { S.lang = 'en'; applyLang(); } });
  await pg.waitForTimeout(600);
  await card.screenshot({ path: OUT + 't3_en.png' });
  const rows = await pg.evaluate(() => {
    const r = [];
    document.querySelectorAll('#seg_side button, #btn_evalshow').forEach((b2) => {
      const t = b2.querySelector('.tgl-txt');
      r.push((t ? t.textContent : b2.textContent) + '|on=' + b2.classList.contains('on') + '|track=' + !!b2.querySelector('.tgl'));
    });
    return r;
  });
  console.log('英文态:', rows.join('  '));
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
