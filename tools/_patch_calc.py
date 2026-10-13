# -*- coding: utf-8 -*-
# Patch calc.js phase-1: rename Balance-1/2 -> Balance picks + Points (1..6),
# replace the two balance functions with anaBalPoints/renderBalMarks/balPN.
import io, sys

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
with io.open(p, "r", encoding="utf-8-sig") as f:
    s = f.read()

edits = []

# P1: els list
edits.append((
"   't_analysis','btn_an_stop','btn_an_nbest','btn_an_bal1','btn_an_bal2','btn_an_defend',",
"   't_analysis','btn_an_stop','btn_an_nbest','btn_an_bal','btn_an_baln','btn_an_defend',", False))

# P2: zh button names
edits.append((
"    anNbest: '多点分析', anBal1: '平衡一', anBal2: '平衡二',",
"    anNbest: '多点分析', anBal: '平衡点', anBaln: '点数',", False))

# P3: en button names
edits.append((
"    anNbest: 'Multi-point', anBal1: 'Balance 1', anBal2: 'Balance 2',",
"    anNbest: 'Multi-point', anBal: 'Balance picks', anBaln: 'Points',", False))

# P4: zh done strings
edits.append((
"""    anBal1Done: '最均衡的一手：{ev}',
    anBal2Done: '两手后最均衡的一对：{ev}',""",
"""    anBalBusy: '官方平衡搜索中…',
    anBalDone: '已给出 {n} 个平衡点：{list}',
    anBalFail: '平衡搜索失败：',
    anBalnSet: '平衡点数已设为 {n}（空盘固定 3）',
    anBalnHint: '平衡点数（1~6，空盘固定 3）',""", False))

# P5: en done strings
edits.append((
"""    anBal1Done: 'Most balanced move: {ev}',
    anBal2Done: 'Most balanced pair after two plies: {ev}',""",
"""    anBalBusy: 'Official balance search…',
    anBalDone: '{n} balanced points: {list}',
    anBalFail: 'Balance search failed: ',
    anBalnSet: 'Balance point count set to {n} (3 fixed on empty board)',
    anBalnHint: 'Balance point count (1-6, 3 fixed on empty board)',""", False))

# P6: zh markCleared + changelog fragment (two occurrences -> replace all)
edits.append((
"计算 / 多点分析 / 平衡一 / 平衡二 / 扫描防守 / 前瞻 · VCF · VCT）",
"计算 / 多点分析 / 平衡点 / 扫描防守 / 前瞻 · VCF · VCT）", True))

# P7: en markCleared (literal \u00b7 escapes in file)
edits.append((
r"(Calculating / Multi-point / Balance 1 / Balance 2 / Scan def / Lookahead \u00b7 VCF \u00b7 VCT)",
r"(Calculating / Multi-point / Balance picks / Scan def / Lookahead \u00b7 VCF \u00b7 VCT)", False))

# P8: zh help - balance description
edits.append((
"'「平衡一」= 在候选里挑评估最接近 0 的一手（最均衡）；「平衡二」= 先把候选逐个虚拟落子、再看对手的应手，挑最稳的一手；「扫描防守」=",
"'「平衡点」= 官方平衡搜索（YXBALANCE）按你选的「点数」一次给出黑白双方都没有明显优势的候选点；「点数」可在 1~6 之间切换（空盘固定 3 个，两黑一白官方定式）；「扫描防守」=", False))

# P9: zh help - clear marks
edits.append((
"计算 / 多点分析 / 平衡一 / 平衡二的徽标与评估分",
"计算 / 多点分析 / 平衡点的徽标与评估分", False))

# P10: zh help - swap balance
edits.append((
"'交换平衡点：点它的同时会自动取消已选的 AI 执黑 / 执白（避免相互干扰）。空盘点一次给出三个平衡点（两黑一白），棋盘上已有棋子给两个（一黑一白）；评估完成后标记留在识别框中，平衡评估引擎随即释放、不再占用算力。你把这几个子下完，标记自动消失。',",
"'交换平衡点：点它的同时会自动取消已选的 AI 执黑 / 执白（避免相互干扰）。空盘固定给出三个平衡点（两黑一白官方定式）；棋盘上已有棋子时，按你选的「点数」（1~6）评估出相应数量的最平衡候选，黑紫白天蓝，可反复点击重新评估。评估完成引擎随即释放；你把相应子数下完（不管下哪），标记自动消失，也可点「清除标记」关闭。',", False))

# P11: zh help - mark shapes
edits.append((
"'盘中标记：推荐落点为天蓝圈；交换平衡点为紫圈（黑）/ 蓝圈（白）并带 1、2、3 序号",
"'盘中标记：推荐落点为天蓝圈；平衡标记为圆形 —— 上半中空显示落子序号、下半半透明填充显示评估分，黑子紫、白子天蓝；全部直接画在识别框内的对应交点，位于截图识别不到的最上层（绝不会被误读成棋子）。", False))

# P13: zh changelog - card list
edits.append((
"计算评估：计算 / 清除标记 / 多点分析 / 平衡一 / 平衡二 / 扫描防守，另配 AI 视图与指导视图",
"计算评估：计算 / 清除标记 / 多点分析 / 平衡点 / 点数 / 扫描防守，另配 AI 视图与指导视图", False))

# P14: anaMark button group
edits.append((
"  [els.btn_an_nbest, els.btn_an_bal1, els.btn_an_bal2, els.btn_an_defend].forEach(function (b) {",
"  [els.btn_an_nbest, els.btn_an_bal, els.btn_an_baln, els.btn_an_defend].forEach(function (b) {", False))

NEW_FUNCS = r'''async function anaBalPoints() {
  if (!anaGuard(0)) return;
  evalQuietAi();
  var gen = ++G.ana.gen;
  G.ana.busy = true; G.ana.kind = 'bal';
  anaMark(els.btn_an_bal);
  renderAna(T('anRunning'));
  var turnMs = Math.max(2000, S.turnMs || 2000);
  var empty = !G.moves.length;
  var need = empty ? 3 : Math.max(1, Math.min(6, balPN()));
  try {
    if (AI_REMOTE && !empty) {
      // Any stone count: evaluate the user-chosen number of balanced
      // candidate points (1..6, default 2) through the official balance
      // search (YXBALANCEONE); each point is really placed before the next
      // one is searched, so colors alternate exactly like real moves.
      var bmB = G.board.map(function (r) { return r.slice(); });
      var plyB = G.moves.length;
      var marksArr = [], namesB = [];
      var qMs = Math.max(600, Math.min(1200, turnMs));
      for (var qi = 0; qi < need; qi++) {
        var curB = ((plyB + qi) % 2 === 0);
        var colQ = curB ? 'b' : 'w';
        var jQ = null;
        try {
          jQ = await apiBalance({
            board: bmB, moveList: [], n: 1, mode: 'one', rule: engineRule(),
            turnMs: qMs, lane: 'main', cid: 'calc-balpts-' + G.moves.length + '-' + qi,
            side: curB ? 1 : 2,
          }, qMs + 20000);
        } catch (eQ) { jQ = null; }
        if (gen !== G.ana.gen) return;
        if (jQ && jQ.swap) { renderAna(T('balSwapNow')); paint(); return; }
        var pQ = (jQ && jQ.moves && jQ.moves[0]) || null;
        if (!pQ) break;
        bmB[pQ[1]][pQ[0]] = colQ === 'b' ? 1 : 2;
        var evQ = '';
        try {
          var rEv = await analyze(280, 1, qi % 2 ? 'sub' : 'main', curB ? 1 : 2, T('tagBal1'), { board: bmB });
          if (gen !== G.ana.gen) return;
          if (rEv && rEv.candidates && rEv.candidates[0] && rEv.candidates[0].eval != null)
            evQ = rEv.candidates[0].eval;
        } catch (eEv) { evQ = ''; }
        marksArr.push({ x: pQ[0], y: pQ[1], color: colQ, ev: evQ, seq: String(qi + 1) });
        namesB.push(coordName(pQ[0], pQ[1]));
      }
      if (!marksArr.length) { renderAna(T('anEmpty')); return; }
      renderBalMarks(marksArr, T('anBalDone').replace('{n}', String(marksArr.length)).replace('{list}', namesB.join(', ')));
      return;
    }
    if (empty) {
      // Official balanced opening set: fixed 3 points (2 black + 1 white).
      // Evaluate every RIF balanced opening with the engine and keep the two
      // most balanced black-3 points plus their shared white-2.
      var probeE2 = Math.max(200, Math.min(400, Math.round(turnMs * 0.2)));
      var lanesE = ['main', 'sub', 'fwd'];
      var rsE = [];
      var tasksE = RIF_OPENINGS.map(function (op, i) {
        var bdE = newBoard();
        bdE[7][7] = 1; bdE[op.w[1]][op.w[0]] = 2; bdE[op.b[1]][op.b[0]] = 1;
        return analyze(probeE2, 1, lanesE[i % 3], 2, T('tagBal1'), { board: bdE }).then(function (rE) {
          var csE = (rE && rE.candidates) || [];
          if (csE.length) {
            var evE = evalNum(csE[0].eval);
            if (!isNaN(evE)) rsE.push({ x: op.b[0], y: op.b[1], w: op.w, ev: evE });
          }
        }).catch(function () {});
      });
      await Promise.all(tasksE);
      if (gen !== G.ana.gen) return;
      if (!rsE.length) { renderAna(T('anEmpty')); return; }
      rsE.sort(function (a, b) { return Math.abs(a.ev) - Math.abs(b.ev); });
      var topE = rsE.slice(0, 2);
      var marksE = [], namesE = [];
      topE.forEach(function (tE) {
        marksE.push({ x: tE.x, y: tE.y, color: 'b', ev: fmtEval(tE.ev), seq: '3' });
        namesE.push(coordName(tE.x, tE.y));
      });
      var w2 = topE[0].w || [8, 8];
      marksE.push({ x: w2[0], y: w2[1], color: 'w', ev: '', seq: '2' });
      namesE.push(coordName(w2[0], w2[1]));
      renderBalMarks(marksE, T('anBalDone').replace('{n}', '3').replace('{list}', namesE.join(', ')));
      return;
    }
    // local engine fallback: single balanced pick
    var r = await analyze(turnMs, Math.min(8, Math.max(4, anaIp())), null, curColor(), T('tagBal1'));
    if (gen !== G.ana.gen) return;
    var cs = (r && r.candidates) || [];
    if (!cs.length) { renderAna(T('anEmpty')); return; }
    var bi = 0, bv = Infinity;
    cs.forEach(function (c, i) {
      var v = evalNum(c.eval);
      if (!isNaN(v) && Math.abs(v) < bv) { bv = Math.abs(v); bi = i; }
    });
    renderBalMarks([{ x: cs[bi].x, y: cs[bi].y, color: curColor() === 1 ? 'b' : 'w', ev: cs[bi].eval, seq: '1' }],
                   T('anBalDone').replace('{n}', '1').replace('{list}', coordName(cs[bi].x, cs[bi].y)));
  } catch (e) {
    if (gen === G.ana.gen) renderAna(T('offline'));
  } finally {
    if (gen === G.ana.gen) { G.ana.busy = false; anaMark(null); }
  }
}

function renderBalMarks(arr, msg) {
  G.ana.marks = arr.map(function (m, i) {
    return { x: m.x, y: m.y, badge: m.seq, label: m.ev ? fmtEval(m.ev) : '', tier: -1, inline: true,
             col: m.color === 'b' ? null : 'rgba(70,190,255,.55)' };
  });
  G.ana.rows = arr.map(function (m, i) {
    return { i: i, badge: m.seq, coord: coordName(m.x, m.y), eval: m.ev ? fmtEval(m.ev) : '', pv: '', tier: -1 };
  });
  renderAna(msg);
  paint();
  if (linkSessionOn() && arr.length) {
    var gm2 = null;
    try { var bb = els.board.getBoundingClientRect(); gm2 = { gap: Math.round(bb.width / 14) }; } catch (e) { gm2 = { gap: 40 }; }
    var cellsP = arr.map(function (m) { return m.x + ',' + m.y + ',' + m.seq + ',' + m.color + ',' + (m.ev || ''); });
    tellHost({ type: 'balance', on: true, gap: gm2.gap, cells: cellsP.join(';') });
  }
}

function balPN() {
  var n = 2;
  try { var v = parseInt(localStorage.getItem('gb_bal_point_n') || '2', 10); if (v >= 1 && v <= 6) n = v; } catch (e) {}
  return n;
}

'''

ok = True
for i, (old, new, repl_all) in enumerate(edits):
    if old not in s:
        print("MISS #%d" % (i + 1)); ok = False; continue
    c = s.count(old)
    if c != 1 and not repl_all:
        print("AMB #%d count=%d" % (i + 1, c)); ok = False; continue
    s = s.replace(old, new) if repl_all else s.replace(old, new, 1)

i1 = s.find('async function anaBal1() {')
i2 = s.find('function wireAnalysis() {')
if i1 < 0 or i2 < 0 or i1 >= i2:
    print("SLICE MISS (i1=%d i2=%d)" % (i1, i2)); ok = False
else:
    s = s[:i1] + NEW_FUNCS + s[i2:]

if not ok:
    sys.exit(1)

with io.open(p, "w", encoding="utf-8-sig", newline="") as f:
    f.write(s)
print("calc.js phase-1 patched OK")
