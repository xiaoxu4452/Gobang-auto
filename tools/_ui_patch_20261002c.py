#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-10-02 第二批补丁：
  bridge.js
    P1  #114 补强：自动落子开关点亮瞬间，空盘+我执黑 → 直落天元
        （原「空盘直落」只在 handleScan 盘面变化帧触发，先点开关后不变盘的场景永远轮不到）
    P2  #115：空盘三点组约束在天元附近 —— 黑1 预置天元±2(5×5)随机；
        白2/黑3 仍 YXBALANCEONE 原生搜索，出 7×7(±3) 时 bias 微扰(0/15/-15)重试至多3发
"""
import shutil, sys, io

P = 'desktop-overlay/ui/bridge.js'
shutil.copy2(P, P + '.bak-batch2')
s = io.open(P, 'r', encoding='utf-8').read()

# ---------------- P1：#114 开关点亮补触发 ----------------
o1 = """  on('__gb_autodrop', 'click', function () {
    adOn = !adOn;
    adLastPt = null; swQueue = null; adFail = 0; adDone = 0;
    if (!adOn && adTimer) { clearTimeout(adTimer); adTimer = null; adWaiting = false; }
    adBtnSync();
"""
n1 = """  on('__gb_autodrop', 'click', function () {
    adOn = !adOn;
    adLastPt = null; swQueue = null; adFail = 0; adDone = 0;
    if (!adOn && adTimer) { clearTimeout(adTimer); adTimer = null; adWaiting = false; }
    adBtnSync();
    // ★ #114 补强（2026-10-02 用户复报「每一次首次落子时点击自动落子并没有落子」）：
    //   「空盘直落天元」只在 handleScan 的盘面变化帧里触发 —— 用户先定位空盘、
    //   之后才点开关的场景下 handleScan 不会再进来，首步永远轮不到。这里补：
    //   开关点亮的瞬间若空盘且我执黑，直接把天元交给宿主点击（S.side===0 已排除未选边）。
    if (adOn && S.side === 0 && lastBl.length + lastWh.length === 0) {
      adMaybeFire((N - 1) >> 1, (N - 1) >> 1);
    }
"""
assert s.count(o1) == 1, 'P1 count=%d' % s.count(o1)
s = s.replace(o1, n1)
print('ok P1')

# ---------------- P2：runSwapBal 空盘三点组 zone 约束 ----------------
o2 = """      // 第 1 轮：官方 YXBALANCETWO —— 一手对（moves[0]=行棋方、moves[1]=对方应手）
      var j1 = await fetchJSON(BALANCE_URL, {
        board: boardMatrix(lastBl, lastWh), moveList: [], n: 1, mode: 'two', bias: 0,
        rule: rule, turnMs: turnMs, lane: 'main',
        cid: 'desktop-swbal2-' + (lastBl.length + lastWh.length),
        side: toBlack ? 1 : 2,
      }, turnMs + 30000);
      if (!j1 || j1.error) {
        ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') + ((j1 && j1.error) || 'no response') + '</span>');
        return;
      }
      if (j1.swap) { ui('setStatus', '<b style="color:#7c3aed">' + LT('swSwapNow') + '</b>'); return; }
      var pts1 = (j1.moves || []).slice(0, 2);
      if (pts1.length < 2) { ui('setStatus', '<span style="color:#c0392b">' + LT('balNone') + '</span>'); return; }
      // 第 1 手 = 行棋方、第 2 手 = 对方（BALANCE_TWO 的官方 pv 语义）
      var marks = [
        { p: pts1[0], color: toBlack ? 'b' : 'w' },
        { p: pts1[1], color: toBlack ? 'w' : 'b' },
      ];
      if (empty) {
        // 空盘：把前两手摆上（1 黑 1 白），YXBALANCEONE 给行棋方再搜一手 → 1 白 + 2 黑
        var b2 = boardMatrix(lastBl, lastWh);
        b2[pts1[0][1]][pts1[0][0]] = toBlack ? 1 : 2;
        b2[pts1[1][1]][pts1[1][0]] = toBlack ? 2 : 1;
        var j2 = await fetchJSON(BALANCE_URL, {
          board: b2, moveList: [], n: 1, mode: 'one', bias: 0,
          rule: rule, turnMs: turnMs, lane: 'main',
          cid: 'desktop-swbal1-' + (lastBl.length + lastWh.length),
          side: toBlack ? 1 : 2,           // 摆完 1黑1白 仍轮黑
        }, turnMs + 30000);
        if (j2 && !j2.error && !j2.swap && j2.moves && j2.moves.length) {
          marks.push({ p: j2.moves[0], color: toBlack ? 'b' : 'w' });
        }
        // j2 失败/换手 → 就摆已得的两点（仍然是一对合法平衡点）
      }
"""
n2 = """      var marks = [];
      if (empty) {
        // ★ #115（2026-10-02 用户「开局下的三个子几乎都是边界上的，要在天元为中心
        //   5*5 或者 7*7 范围内」）：空盘时任何一点的平衡性都相同（eval 全部贴 0），
        //   官方 YXBALANCE 空盘挑哪一点是搜索平票的偶然结果 —— 此前几乎总挑边界点。
        //   方案：黑1 直接预置在天元 ±2（5×5）内随机（swap2 先手摆中心的惯例，
        //   不破坏平衡性）；白2/黑3 仍由 YXBALANCEONE 原生搜索，只是落在 7×7（±3）
        //   之外时用 bias 微扰（0→15→-15）重试至多 3 发 —— bias 是「目标均势偏置」，
        //   ±30 以内不改变「绝对均势」语义，却能换来不同的平票挑选。
        var R1 = 2, R2 = 3, cx = (N - 1) >> 1, cy = (N - 1) >> 1;
        var inZone = function (p, R) {
          return Math.max(Math.abs(p[0] - cx), Math.abs(p[1] - cy)) <= R;
        };
        var m1 = [cx + Math.floor(Math.random() * (2 * R1 + 1)) - R1,
                  cy + Math.floor(Math.random() * (2 * R1 + 1)) - R1];
        var b2 = boardMatrix(lastBl, lastWh);
        b2[m1[1]][m1[0]] = toBlack ? 1 : 2;
        marks.push({ p: m1, color: toBlack ? 'b' : 'w' });
        // 白2 → 黑3：各一轮「至多 3 发」的 zone 约束搜索（盘面逐手摆上）
        var sides = [toBlack ? 2 : 1, toBlack ? 1 : 2];      // 先搜白方应手、再搜黑方应手
        var colors = [toBlack ? 'w' : 'b', toBlack ? 'b' : 'w'];
        for (var step = 0; step < 2; step++) {
          var pt2 = null;
          for (var tries = 0; tries < 3; tries++) {
            var jw = await fetchJSON(BALANCE_URL, {
              board: b2, moveList: [], n: 1, mode: 'one', bias: [0, 15, -15][tries],
              rule: rule, turnMs: turnMs, lane: 'main',
              cid: 'desktop-swbal1-' + (lastBl.length + lastWh.length) + '-' + step + '-' + tries,
              side: sides[step],
            }, turnMs + 30000);
            if (!jw || jw.error || jw.swap || !jw.moves || !jw.moves.length) { pt2 = null; break; }
            pt2 = jw.moves[0];
            if (inZone(pt2, R2)) break;                      // 7×7 内 → 收货
          }
          if (!pt2) break;                                   // 服务失败/换手 → 摆已得各点
          marks.push({ p: pt2, color: colors[step] });
          b2[pt2[1]][pt2[0]] = (colors[step] === 'b') ? 1 : 2;
        }
        // 白2/黑3 搜失败 → 就摆已得的点（与原「j2 失败就摆两点」同一兜底）
      } else {
        // 已有棋子：官方 YXBALANCETWO 一手对（moves[0]=行棋方、moves[1]=对方应手）
        var j1 = await fetchJSON(BALANCE_URL, {
          board: boardMatrix(lastBl, lastWh), moveList: [], n: 1, mode: 'two', bias: 0,
          rule: rule, turnMs: turnMs, lane: 'main',
          cid: 'desktop-swbal2-' + (lastBl.length + lastWh.length),
          side: toBlack ? 1 : 2,
        }, turnMs + 30000);
        if (!j1 || j1.error) {
          ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') + ((j1 && j1.error) || 'no response') + '</span>');
          return;
        }
        if (j1.swap) { ui('setStatus', '<b style="color:#7c3aed">' + LT('swSwapNow') + '</b>'); return; }
        var pts1 = (j1.moves || []).slice(0, 2);
        if (pts1.length < 2) { ui('setStatus', '<span style="color:#c0392b">' + LT('balNone') + '</span>'); return; }
        marks.push({ p: pts1[0], color: toBlack ? 'b' : 'w' });
        marks.push({ p: pts1[1], color: toBlack ? 'w' : 'b' });
      }
"""
assert s.count(o2) == 1, 'P2 count=%d' % s.count(o2)
s = s.replace(o2, n2)
print('ok P2')

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('WROTE', P)
