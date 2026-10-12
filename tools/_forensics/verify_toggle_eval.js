// 活体验证（新版训练器 :8965）：
//   ① AI 执黑/执白 = 拨动开关（胶囊轨道 .tgl 真在 DOM 里、on 态滑块右移）
//   ② 对局设置里有「评估分数」开关，默认开，关掉 → 摆棋评分立即消失
//   ③ AI 全关下跑「计算 / 多点分析 / 扫描防守」→ 摆棋评分**不消失**
//   ④ 清除标记 → 评分一起清；再落子 → 评分重新铺出
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/harve/Desktop/Gobang auto/tools/_forensics/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const pg = await b.newPage({ viewport: { width: 1400, height: 950 } });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2500);

  const ev = (fn, arg) => pg.evaluate(fn, arg);

  // ---------- ① 拨动开关结构 ----------
  const toggle = await ev(() => {
    const bs = [].slice.call(document.querySelectorAll('#seg_side button'));
    return bs.map((btn) => ({
      cls: btn.className,
      hasTrack: !!btn.querySelector('.tgl'),
      hasKnob: !!btn.querySelector('.tgl i'),
      txt: (btn.querySelector('.tgl-txt') || {}).textContent,
      on: btn.classList.contains('on'),
      w: Math.round(btn.getBoundingClientRect().width),
    }));
  });
  console.log('① 拨动开关:', JSON.stringify(toggle));

  // 点「AI 执黑」→ 应变 on
  await pg.click('#seg_side button[data-ai="b"]');
  await pg.waitForTimeout(400);
  const afterB = await ev(() => {
    const btn = document.querySelector('#seg_side button[data-ai="b"]');
    const knob = btn.querySelector('.tgl i');
    const track = btn.querySelector('.tgl');
    return {
      on: btn.classList.contains('on'),
      knobLeft: Math.round(knob.getBoundingClientRect().left - track.getBoundingClientRect().left),
      trackBg: getComputedStyle(track).backgroundColor,
      S: { aiB: window.S && S.aiB, aiW: window.S && S.aiW },
    };
  });
  console.log('① 点后 AI执黑:', JSON.stringify(afterB));
  await pg.click('#seg_side button[data-ai="b"]');   // 拨回：两个都关
  await pg.waitForTimeout(300);

  // ---------- ② 评估分数开关 ----------
  const evalTgl = await ev(() => {
    const btn = document.getElementById('btn_evalshow');
    if (!btn) return null;
    return {
      hasTrack: !!btn.querySelector('.tgl'),
      txt: (btn.querySelector('.tgl-txt') || {}).textContent,
      on: btn.classList.contains('on'),
      S: window.S && S.evalShow,
    };
  });
  console.log('② 评估分数开关:', JSON.stringify(evalTgl));

  // ---------- ③ 摆棋评分在计算后是否还在 ----------
  // 摆三子（对弈模式、AI 全关 → placeEvalWanted 为真）
  await ev(() => {
    try { if (typeof S !== 'undefined') { S.mode = 'pve'; S.aiB = false; S.aiW = false; } } catch (e) {}
    place(7, 7); afterMove();
  });
  await pg.waitForTimeout(2500);
  const s0 = await ev(() => ({ n: G.placeEval.items.length, wanted: placeEvalWanted(), moves: G.moves.length }));
  console.log('③ 摆 1 子后评分:', JSON.stringify(s0));

  await ev(() => { place(8, 8); afterMove(); });
  await pg.waitForTimeout(2500);
  await ev(() => { place(6, 6); afterMove(); });
  await pg.waitForTimeout(3000);
  const s1 = await ev(() => ({ n: G.placeEval.items.length, labels: G.placeEval.items.map((i) => i.label).join(',') }));
  console.log('③ 摆 3 子后评分:', JSON.stringify(s1));
  await pg.screenshot({ path: OUT + 'v1_scores.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  // 跑「计算」
  await ev(() => { anaCalc(); });
  await pg.waitForTimeout(9000);
  const s2 = await ev(() => ({ n: G.placeEval.items.length, wanted: placeEvalWanted(), anaKind: G.ana.kind }));
  console.log('③ 跑「计算」后评分:', JSON.stringify(s2));
  await pg.screenshot({ path: OUT + 'v2_after_calc.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  // 跑「多点分析」
  await ev(() => { if (typeof anaNbest === 'function') anaNbest(); });
  await pg.waitForTimeout(9000);
  const s3 = await ev(() => ({ n: G.placeEval.items.length, wanted: placeEvalWanted() }));
  console.log('③ 跑「多点分析」后评分:', JSON.stringify(s3));

  // ---------- ④ 清除标记 → 一起清；再落子 → 重铺 ----------
  await ev(() => { clearAllMarks(); });
  await pg.waitForTimeout(600);
  const s4 = await ev(() => ({ n: G.placeEval.items.length, marks: G.ana.marks.length }));
  console.log('④ 清除标记后:', JSON.stringify(s4));
  await pg.screenshot({ path: OUT + 'v3_after_clear.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  await ev(() => { place(9, 7); afterMove(); });
  await pg.waitForTimeout(3000);
  const s5 = await ev(() => ({ n: G.placeEval.items.length, moves: G.moves.length }));
  console.log('④ 再落子后重铺:', JSON.stringify(s5));
  await pg.screenshot({ path: OUT + 'v4_after_move.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  // ---------- ⑤ 关掉「评估分数」→ 立即撤分 ----------
  await pg.evaluate(() => { document.getElementById('btn_evalshow').click(); });
  await pg.waitForTimeout(800);
  const s6 = await ev(() => ({ n: G.placeEval.items.length, wanted: placeEvalWanted(), S: window.S && S.evalShow }));
  console.log('⑤ 关掉评估分数:', JSON.stringify(s6));

  // 再开 → 重铺
  await pg.evaluate(() => { document.getElementById('btn_evalshow').click(); });
  await pg.waitForTimeout(2500);
  const s7 = await ev(() => ({ n: G.placeEval.items.length, wanted: placeEvalWanted(), S: window.S && S.evalShow }));
  console.log('⑤ 再开评估分数:', JSON.stringify(s7));

  console.log('JS 异常:', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
