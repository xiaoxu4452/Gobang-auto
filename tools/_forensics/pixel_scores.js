// 像素级复核：跑完三种计算后，棋盘上那些评分色块**肉眼还在不在**
// （数据层 items 在，但若被分析标注盖住，用户看到的仍是「分数消失了」）。
// 做法：取每颗评分格中心像素，判断是否仍是 placeEvalColor 的饱和色（S 高、L≈50%）。
const { chromium } = require('playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/harve/Desktop/Gobang auto/tools/_forensics/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(pg, tag) {
  const r = await pg.evaluate(() => {
    const cv = document.getElementById('board');
    const ctx = cv.getContext('2d');
    const dpr = cv.width / cv.getBoundingClientRect().width;
    const items = G.placeEval.items || [];
    const G2 = geom();
    const g = { pad: G2.pad, gap: G2.gap };
    const out = [];
    items.forEach((it) => {
      const x = Math.round((g.pad + it.x * g.gap) * dpr);
      const y = Math.round((g.pad + it.y * g.gap - g.gap * 0.13) * dpr);   // 上沿：避开块中央的白色数字
      const d = ctx.getImageData(x, y, 1, 1).data;
      const mx = Math.max(d[0], d[1], d[2]), mn = Math.min(d[0], d[1], d[2]);
      const sat = mx ? (mx - mn) / mx : 0;
      out.push({ label: it.label, rgb: d[0] + ',' + d[1] + ',' + d[2], sat: +sat.toFixed(2), lum: mx });
    });
    return { n: items.length, cells: out };
  });
  const vis = r.cells.filter((c) => c.sat >= 0.45 && c.lum >= 90 && c.lum <= 245).length;
  console.log(tag + ' → items=' + r.n + ' 色块可见=' + vis + '  ' + r.cells.slice(0, 3).map((c) => c.label + '(' + c.rgb + ' sat' + c.sat + ')').join(' '));
  return vis;
}

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true });
  const pg = await b.newPage({ viewport: { width: 1400, height: 950 } });
  await pg.goto('http://127.0.0.1:8965/calc.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2500);
  await pg.evaluate(() => { S.mode = 'pve'; S.aiB = false; S.aiW = false; place(7, 7); afterMove(); });
  await pg.waitForTimeout(2500);
  await pg.evaluate(() => { place(8, 8); afterMove(); });
  await pg.waitForTimeout(3000);
  await probe(pg, '基线（摆 2 子）');
  await pg.screenshot({ path: OUT + 'p1_base.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  await pg.evaluate(() => { anaCalc(); });
  await pg.waitForTimeout(9000);
  await probe(pg, '跑「计算」');
  await pg.screenshot({ path: OUT + 'p2_calc.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  await pg.evaluate(() => { if (typeof anaNbest === 'function') anaNbest(); });
  await pg.waitForTimeout(10000);
  await probe(pg, '跑「多点分析」');
  await pg.screenshot({ path: OUT + 'p3_nbest.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  await pg.evaluate(() => { if (typeof anaDefend === 'function') anaDefend(true); });
  await pg.waitForTimeout(12000);
  await probe(pg, '跑「扫描防守」');
  await pg.screenshot({ path: OUT + 'p4_defend.png', clip: { x: 40, y: 40, width: 900, height: 880 } });

  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
