// 三十二轮活体验证（训练器 :8965）：
//   ① 「模式」「AI 执子」各套虚线框，标题一行 + 按键一行（窄窗口也不堆叠、文字不截断）
//   ② AI 执黑 开 = 浅紫、AI 执白 开 = 浅蓝（含深/浅主题）
//   ③ 点「计算评估」里任意功能键 → 棋盘上的摆棋评分**暂时消失**（items → 0）
//   ④ 评估分数那一行同样是「标签一行 + 开关一行」，窄栏不往后堆叠
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/harve/Desktop/Gobang auto/tools/_forensics/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2500);
  const ev = (fn, arg) => pg.evaluate(fn, arg);

  const probe = () => ev(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; };
    const grp = (id, sel) => {
      const g = document.getElementById(id);
      if (!g) return null;
      const lbl = g.querySelector('label'), seg = g.querySelector('.seg');
      const btns = [].slice.call(g.querySelectorAll(sel));
      return {
        dashed: getComputedStyle(g).borderTopStyle,
        twoLine: Math.round(lbl.getBoundingClientRect().bottom) <= Math.round(seg.getBoundingClientRect().top) + 1,
        fullRow: Math.round(seg.getBoundingClientRect().width) >= seg.parentNode.clientWidth - 2,
        clipped: btns.filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent.trim()).join(','),
        n: btns.length,
      };
    };
    const evRow = document.getElementById('chk_evalshow'), chNum = document.getElementById('chk_num');
    const evLbl = evRow ? evRow.parentNode.querySelector('label') : null;
    return {
      mode: grp('modeGrp', '#seg_mode button'),
      side: grp('sideGrp', '#seg_side button'),
      eval: evRow ? {
        type: evRow.type,
        checked: evRow.checked,
        lbl: evLbl ? evLbl.textContent.trim() : null,
        sameCol: chNum ? Math.round(evRow.getBoundingClientRect().left - chNum.getBoundingClientRect().left) : null,
        aboveNum: chNum ? evRow.getBoundingClientRect().top < chNum.getBoundingClientRect().top : null,
      } : null,
      scores: (window.G && G.placeEval) ? G.placeEval.items.length : null,
    };
  });

  console.log('① 布局（1280 宽）:', JSON.stringify(await probe(), null, 0));
  await pg.setViewportSize({ width: 900, height: 800 });
  await pg.waitForTimeout(600);
  console.log('① 布局（900 窄窗）:', JSON.stringify(await probe(), null, 0));
  await pg.screenshot({ path: OUT + 'g1_setup_narrow.png', clip: { x: 0, y: 0, width: 900, height: 700 } });
  await pg.setViewportSize({ width: 1280, height: 900 });
  await pg.waitForTimeout(400);

  // ---------- ② 开关键配色 ----------
  await pg.click('#seg_side button[data-ai="b"]');
  await pg.waitForTimeout(500);
  const cb = await ev(() => {
    const btn = document.querySelector('#seg_side button[data-ai="b"]');
    const t = btn.querySelector('.tgl');
    return { on: btn.classList.contains('on'), bg: getComputedStyle(btn).backgroundColor, track: getComputedStyle(t).backgroundColor };
  });
  console.log('② AI 执黑（开）:', JSON.stringify(cb));
  await pg.click('#seg_side button[data-ai="w"]');
  await pg.waitForTimeout(500);
  const cw = await ev(() => {
    const btn = document.querySelector('#seg_side button[data-ai="w"]');
    const t = btn.querySelector('.tgl');
    return { on: btn.classList.contains('on'), bg: getComputedStyle(btn).backgroundColor, track: getComputedStyle(t).backgroundColor };
  });
  console.log('② AI 执白（开）:', JSON.stringify(cw));
  await pg.screenshot({ path: OUT + 'g2_side_on.png', clip: { x: 0, y: 0, width: 520, height: 420 } });
  // 关回去（回到 AI 全关 → 才轮到「摆棋评分」自己算）
  await pg.click('#seg_side button[data-ai="b"]');
  await pg.click('#seg_side button[data-ai="w"]');
  await pg.waitForTimeout(400);

  // ---------- ③ 摆子出评分 → 点计算评估任一键 → 评分消失 ----------
  await ev(() => { try { S.mode = 'pve'; S.aiB = false; S.aiW = false; } catch (e) {} place(7, 7); afterMove(); });
  await pg.waitForTimeout(2500);
  await ev(() => { place(8, 8); afterMove(); });
  await pg.waitForTimeout(2500);
  await ev(() => { place(6, 6); afterMove(); });
  await pg.waitForTimeout(3000);
  const s1 = await ev(() => ({ scores: G.placeEval.items.length, wanted: placeEvalWanted(), moves: G.moves.length }));
  console.log('③ 摆 3 子后评分:', JSON.stringify(s1));

  const before = await ev(() => G.placeEval.items.length);
  await pg.click('#btn_an_defend');                     // 「扫描防守」= 计算评估里的功能键
  await pg.waitForTimeout(2500);
  const s2 = await ev(() => ({ scores: G.placeEval.items.length, timer: !!G.placeEval.timer, winUntil: G.placeEval.winUntil }));
  console.log('③ 点「扫描防守」后：', before, '→', JSON.stringify(s2));
  await pg.screenshot({ path: OUT + 'g3_after_defend.png', clip: { x: 0, y: 0, width: 1100, height: 900 } });

  // 再落子 → 应该重新评估并铺回来（只是「暂时」消失）
  await ev(() => { place(9, 7); afterMove(); });
  await pg.waitForTimeout(3000);
  const s3 = await ev(() => ({ scores: G.placeEval.items.length, moves: G.moves.length }));
  console.log('③ 再落子后重新铺回:', JSON.stringify(s3));

  // 多点分析 / 前瞻 也应清掉
  await pg.click('#btn_an_nbest');
  await pg.waitForTimeout(2500);
  console.log('③ 点「多点分析」后:', JSON.stringify(await ev(() => ({ scores: G.placeEval.items.length }))));
  await pg.click('#btn_fwd');
  await pg.waitForTimeout(1200);
  console.log('③ 点「前瞻」后:', JSON.stringify(await ev(() => ({ scores: G.placeEval.items.length }))));

  console.log('JS 异常:', errs.length ? errs.join(' | ') : '无');

  // ---------- ⑤ 勾选框：取消 → 评分消失；勾上 → 重铺 ----------
  await ev(() => { try { place(5, 5); afterMove(); } catch (e) {} });
  await pg.waitForTimeout(2500);
  console.log('⑤ 勾上（默认）评分:', JSON.stringify(await ev(() => ({
    checked: document.getElementById('chk_evalshow').checked, scores: G.placeEval.items.length, S: S.evalShow }))));
  await pg.uncheck('#chk_evalshow');
  await pg.waitForTimeout(800);
  console.log('⑤ 取消勾选:', JSON.stringify(await ev(() => ({
    checked: document.getElementById('chk_evalshow').checked, scores: G.placeEval.items.length, S: S.evalShow, wanted: placeEvalWanted() }))));
  await pg.check('#chk_evalshow');
  await pg.waitForTimeout(3000);
  console.log('⑤ 再勾上（重铺）:', JSON.stringify(await ev(() => ({
    checked: document.getElementById('chk_evalshow').checked, scores: G.placeEval.items.length, S: S.evalShow }))));
  const box = await pg.evaluate(() => {
    const c = document.querySelector('.card[data-id="setup"]').getBoundingClientRect();
    return { x: Math.max(0, Math.floor(c.left) - 6), y: Math.max(0, Math.floor(c.top) - 6), width: Math.ceil(c.width) + 12, height: Math.min(900, Math.ceil(c.height) + 12) };
  });
  await pg.screenshot({ path: OUT + 'g5_setup_checkbox.png', clip: box });
  console.log('JS 异常(终):', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
