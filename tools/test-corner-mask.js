// test-corner-mask.js —— 紫色 L 角框「不被自家识别拍进去」的几何回归测试
// =====================================================================
// 问题（2026-10-03 用户现场复报「角落又有字了」）：ScanLoop 下发给识别服务的
// exclude 掩膜带，负责把覆盖层自己画的紫色 L 角框抹掉。v2 改成「四条整边外扩带」
// 后，四条边中段确实被盖住了，但**四条带在四角没有交叠** —— 上带从 x=left-2 起、
// 左带从 y=top-2 起，于是「x<left-2 且 y<top-2」那块约 19x19px 的方区谁都没盖到。
// 而 DrawLBracket 用 LineJoinMiter，两条臂在角点相交时光晕遍的 miter 外角比直线段
// 再向外伸 thick*3/2*sqrt2 ≈ 7~8.5px，角点最外探到 -14.7~-16px，精准落在缺口里
// → 四个角的紫框露在截图上被读成黑子（现场症状：角上出现幽灵子/字）。
//
// 本测试把「绘制端几何」和「掩膜端几何」都按 host.cpp 的同源常量在 JS 里复刻，
// 逐点断言：角框的任何一个像素都必须落在某条掩膜带内，且掩膜带绝不越进网格包围盒
// （越进去会抹掉盘内真实棋子的外缘）。
//
// 运行：node tools/test-corner-mask.js
'use strict';
const path = require('path');

let failed = 0;
function check(cond, msg) {
  if (!cond) { failed++; console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

// ---- 覆盖层绘制端常量（host.cpp PaintOverlay，与源码同源）----
const EDGE = 6.0;                 // L 框相对棋盘包围盒的外扩量 e
const BAND_EDGE = 6;              // 掩膜端：框线外扩（与绘制端同源）
const BAND_SPAN = 15;             // 掩膜端：外扩带厚度
const BANDH = BAND_EDGE + BAND_SPAN - 1;   // 带厚 20px
const REACH = BAND_EDGE + BAND_SPAN + 2;   // v3：角部交叠伸出量

/** L 形角框的全部绘制线段（8 根臂 + 4 条腿间虚线），板坐标 */
function bracketSegments(bw, bh) {
  let barm = (Math.min(bw, bh) + 0.5) / 15.0;
  if (barm < 14) barm = 14;
  // 2026-10-03 用户「紫色 L 角框变窄一点儿」：host.cpp 同步 4.0→3.2 / 3.4→2.7
  const bth = barm > 50 ? 3.2 : 2.7;
  const x0 = -EDGE, y0 = -EDGE, x1 = bw + EDGE, y1 = bh + EDGE;
  let a = barm;
  if (a > bw / 2.4) a = bw / 2.4;
  if (a > bh / 2.4) a = bh / 2.4;
  const segs = [
    [x0, y0 + a, x0, y0], [x0, y0, x0 + a, y0],           // 左上角
    [x1 - a, y0, x1, y0], [x1, y0, x1, y0 + a],           // 右上角
    [x1, y1 - a, x1, y1], [x1, y1, x1 - a, y1],           // 右下角
    [x0 + a, y1, x0, y1], [x0, y1, x0, y1 - a],           // 左下角
    // 腿间虚线（连接线）
    [x0 + a, y0, x1 - a, y0], [x0 + a, y1, x1 - a, y1],
    [x0, y0 + a, x0, y1 - a], [x1, y0 + a, x1, y1 - a],
  ];
  return { segs, bth, x0, y0, x1, y1, a };
}

// ---- 掩膜端：ScanLoop 下发的四条带（v3 修复后的口径）----
function bands(bw, bh) {
  const L = 0, T = 0, R = bw, B = bh;
  return [
    [L - REACH, T - BAND_EDGE - BAND_SPAN, bw + 2 * REACH, BANDH],   // 上
    [L - REACH, B + 1, bw + 2 * REACH, BANDH],                       // 下
    [L - BAND_EDGE - BAND_SPAN, T - REACH, BANDH, bh + 2 * REACH],   // 左
    [R + 1, T - REACH, BANDH, bh + 2 * REACH],                       // 右
  ];
}

const covered = (bs, px, py) =>
  bs.some(([bx, by, bw2, bh2]) => bx <= px && px < bx + bw2 && by <= py && py < by + bh2);

// ---- 逐线段按「光晕最外缘」采样 ----
// DrawLBracket 画两遍：pass0 光晕线宽 thick*3、pass1 本体线宽 thick。
// 半宽最大的是 pass0：thick*3/2。角点用 LineJoinMiter，外角再伸 半宽*sqrt2。
// 采样时把半宽取到最坏值并加 1.5px 抗锯齿余量，宁可多采不可漏采。
function samplePoints(bw, bh) {
  const { segs, bth } = bracketSegments(bw, bh);
  const half = (bth * 3.0) / 2;          // 光晕遍半宽
  const AA = 1.5;                        // 抗锯齿余量
  const pts = [];
  for (const [ax, ay, bx2, by2] of segs) {
    const n = 240;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = ax + (bx2 - ax) * t;
      const py = ay + (by2 - ay) * t;
      // 沿线段的法向 ±(half+AA) 两侧采样，覆盖线宽
      const dx = bx2 - ax, dy = by2 - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      for (const s of [-(half + AA), 0, half + AA]) {
        pts.push([px + nx * s, py + ny * s]);
      }
    }
  }
  return pts;
}

console.log('== 紫色 L 角框掩膜几何回归 ==\n');

// 读子核心盘半径 = 0.44*格距；「平斑块」平台闸门外环 0.50~0.555 格距。
// 角框内侧光晕会越过最外圈网格线约 0.6~1.5px（见下方 sliver 计算）——
// 那条细缝抹不得（要切进网格就削掉边缘棋子外缘），但它必须远小于棋子尺度。
const SLIVER_TOL = 2.0;   // 容忍带：距包围盒边界 <= 2px 的像素允许不被掩膜

for (const [bw, bh, label] of [[560, 560, '15路 560px'], [840, 840, '15路 840px'],
                                [420, 420, '15路 420px'], [700, 700, '15路 700px']]) {
  const bs = bands(bw, bh);
  const pts = samplePoints(bw, bh);
  const { bth } = bracketSegments(bw, bh);
  const glowHalf = (bth * 3.0) / 2;
  const sliver = Math.max(0, -(EDGE - (glowHalf + 1.5)));   // >0 = 越进盒内
  const spacing = bw / 14, stoneR = spacing * 0.44;

  // ★ 真正要保证的不变量：**角框画在「包围盒外扩 SLIVER_TOL 之外」的每一个像素
  //   都必须在掩膜内** —— 因为读子窗口从网格线向内外各扩 0.62*格距，盒外像素
  //   一定落在某个边缘/角落交点的读子视野里，露出来就会被当成黑子。
  //   容忍带内的像素属于越界光晕细缝（见下方量化），填不满核心盘、够不到形状判据。
  const distOutside = ([px, py]) =>
    Math.max(-px, -py, px - bw, py - bh);          // >0 = 在盒外，距边界多少 px
  const mustCover = pts.filter(([px, py]) =>
    distOutside([px, py]) > SLIVER_TOL);
  const miss = mustCover.filter(([px, py]) => !covered(bs, px, py));

  console.log(`- ${label} (${bw}x${bh}) 采样 ${pts.length} 点`
              + `（须覆盖 ${mustCover.length} / 容忍带内 ${pts.length - mustCover.length}）`);
  check(miss.length === 0,
    `角框在包围盒外 ${SLIVER_TOL}px 之外的像素全部被掩膜（未盖 ${miss.length}` +
    (miss.length ? '，首个 ' + miss[0].map(v => v.toFixed(1)) : '') + '）');

  // 容忍带宽度必须与实际越界光晕同量级，且远小于棋子尺度。
  check(sliver <= SLIVER_TOL,
    `内侧光晕越进网格 ${sliver.toFixed(2)}px ≤ 容忍带 ${SLIVER_TOL}px`
    + `（棋子半径 ${stoneR.toFixed(1)}px 的 ${(sliver / stoneR * 100).toFixed(1)}%）`);

  // 掩膜带不得越进网格包围盒：带与包围盒的交集必须为空
  let intrude = 0;
  for (const [bx, by, bw2, bh2] of bs) {
    const ix0 = Math.max(bx, 0), iy0 = Math.max(by, 0);
    const ix1 = Math.min(bx + bw2, bw), iy1 = Math.min(by + bh2, bh);
    if (ix1 > ix0 && iy1 > iy0) intrude++;
  }
  check(intrude === 0, `掩膜带不越进网格包围盒（越进 ${intrude} 条，会抹掉盘内棋子外缘）`);

  // 四角必须被**至少两条**带交叠覆盖（这是 v2 缺失、v3 修复的不变量）
  const half = (bth * 3.0) / 2, mit = half * Math.SQRT2, AA = 1.5;
  const e = EDGE;
  const corners = [[-e - mit - AA, -e - mit - AA], [bw + e + mit + AA, -e - mit - AA],
                   [-e - mit - AA, bh + e + mit + AA], [bw + e + mit + AA, bh + e + mit + AA]];
  const layers = corners.map(([cx, cy]) => bs.filter(([bx, by, bw2, bh2]) =>
    bx <= cx && cx < bx + bw2 && by <= cy && cy < by + bh2).length);
  check(layers.every(n => n >= 2),
    `四个 miter 角点都被 >=2 条带交叠覆盖（实际层数 ${layers.join('/')}）`);
  console.log('');
}

console.log(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
