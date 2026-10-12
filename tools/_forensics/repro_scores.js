/* 活体复现：AI 全关（默认）→ 摆子出评分 → 跑计算评估各项 → 看评分是否消失 */
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge', headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (e) => console.log('PAGE-ERROR:', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => ({
    mode: S.mode, aiB: S.aiB, aiW: S.aiW,
    wanted: placeEvalWanted(),
    engineOffline: G.engineOffline,
    moves: G.moves.length,
  }));
  console.log('BOOT:', JSON.stringify(info));

  // 摆三手（黑 H8, 白 I9, 黑 J10 —— 对角线附近，够引擎出候选）
  await page.evaluate(() => { place(7, 7); afterMove();; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { place(8, 8); afterMove();; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { place(9, 9); afterMove();; });

  // 等摆棋评分第一轮回来（analyze 900ms + 余量）
  await page.waitForTimeout(3500);
  let st = await page.evaluate(() => ({
    moves: G.moves.length, items: G.placeEval.items.length,
    busy: G.placeEval.busy, winUntilLeft: G.placeEval.winUntil - Date.now(),
    anaBusy: G.ana.busy, anaKind: G.ana.kind,
  }));
  console.log('AFTER-3-MOVES:', JSON.stringify(st));

  // 跑「计算」（anaCalc）
  await page.evaluate(() => { anaCalc(); });
  await page.waitForTimeout(1500);
  st = await page.evaluate(() => ({
    items: G.placeEval.items.length, busy: G.placeEval.busy,
    anaBusy: G.ana.busy, anaKind: G.ana.kind, marks: G.ana.marks.length,
  }));
  console.log('DURING-anaCalc:', JSON.stringify(st));
  await page.waitForTimeout(13000);
  st = await page.evaluate(() => ({
    items: G.placeEval.items.length, busy: G.placeEval.busy,
    anaBusy: G.ana.busy, anaKind: G.ana.kind, marks: G.ana.marks.length,
  }));
  console.log('AFTER-anaCalc:', JSON.stringify(st));

  // 跑「多点分析」（anaNbest）
  await page.evaluate(() => { anaNbest(); });
  await page.waitForTimeout(2000);
  st = await page.evaluate(() => ({
    items: G.placeEval.items.length, anaBusy: G.ana.busy, anaKind: G.ana.kind,
    marks: G.ana.marks.length, rows: G.ana.rows.length,
  }));
  console.log('DURING-anaNbest:', JSON.stringify(st));
  await page.waitForTimeout(16000);
  st = await page.evaluate(() => ({
    items: G.placeEval.items.length, anaBusy: G.ana.busy, anaKind: G.ana.kind, marks: G.ana.marks.length,
  }));
  console.log('AFTER-anaNbest:', JSON.stringify(st));

  // 跑「扫描防守」（anaDefend）
  await page.evaluate(() => { anaDefend(true); });
  await page.waitForTimeout(2000);
  st = await page.evaluate(() => ({
    items: G.placeEval.items.length, anaBusy: G.ana.busy, anaKind: G.ana.kind,
    marks: G.ana.marks.length, defCells: (G.ana.defCells || []).length,
  }));
  console.log('DURING-anaDefend:', JSON.stringify(st));
  await page.waitForTimeout(16000);
  st = await page.evaluate(() => ({
    items: G.placeEval.items.length, anaBusy: G.ana.busy, marks: G.ana.marks.length,
  }));
  console.log('AFTER-anaDefend:', JSON.stringify(st));

  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
