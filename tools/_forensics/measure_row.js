// 量「对局设置」卡里各行的真实几何：为什么「AI 执子」行与「思考时间」列不对齐
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const pg = await b.newPage({ viewport: { width: 1280, height: 860 } });
  await pg.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2500);

  const r = await pg.evaluate(() => {
    const out = {};
    const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height), t: Math.round(b.top) }; };
    const card = document.querySelector('.card[data-id="setup"]');
    out.card = rect(card);
    out.rows = [];
    card.querySelectorAll('.row').forEach((row) => {
      const lab = row.querySelector('label');
      const ctrl = row.querySelector('.seg, .field, select, input');
      out.rows.push({
        id: (ctrl && ctrl.id) || (row.id) || '',
        row: rect(row), label: rect(lab), ctrl: rect(ctrl),
        labelTxt: lab ? lab.textContent.trim() : '',
      });
    });
    out.root = getComputedStyle(document.documentElement).fontSize;
    out.segSideBtns = [].map.call(document.querySelectorAll('#seg_side button'), (b) => {
      const bb = b.getBoundingClientRect();
      const tg = b.querySelector('.tgl');
      const tx = b.querySelector('.tgl-txt');
      return {
        w: Math.round(bb.width), h: Math.round(bb.height),
        tgl: tg ? Math.round(tg.getBoundingClientRect().width) : 0,
        txt: tx ? Math.round(tx.getBoundingClientRect().width) : 0,
        txtScroll: tx ? tx.scrollWidth : 0,
      };
    });
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
