# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))

bj = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
bom, t = load(bj)

def rep(old, new, tag):
    global t
    n = t.count(old)
    print(tag, "count:", n); assert n == 1, tag
    t = t.replace(old, new)

# 1) pendingBal declaration
rep(
"  var swQueue = null, swIdx = 0;         // 交换摆点队列（棋盘格坐标数组）+ 游标\n",
"  var swQueue = null, swIdx = 0;         // 交换摆点队列（棋盘格坐标数组）+ 游标\n"
"  var pendingBal = null;                 // 落子关时评估的待摆平衡点（开自动落子按序补摆）\n",
"[decl]")

# 2) runSwapBal: always keep points; if adOn off -> pendingBal
rep(
"      if (adOn && parts.length === marks.length) {\n"
"        swQueue = marks.map(function (m) { return [m.p[0], m.p[1]]; });\n"
"        swIdx = 0;\n"
"        swBtnState();                             // 摆点开始 → 自动落子键灰显\n"
"        setTimeout(swAdvance, 200);\n"
"      }\n",
"      var balPts = marks.map(function (m) { return [m.p[0], m.p[1]]; });\n"
"      if (adOn && parts.length === marks.length) {\n"
"        swQueue = balPts; swIdx = 0;\n"
"        swBtnState();                             // 摆点开始 → 自动落子键灰显\n"
"        setTimeout(swAdvance, 200);\n"
"      } else {\n"
"        // 落子关：评估点保留为待摆（圈留着、评估引擎已停），开自动落子再按序补摆\n"
"        pendingBal = balPts;\n"
"      }\n",
"[runSwapBal]")

# 3) autodrop on: pendingBal takes priority
rep(
"    if (adOn && S.side === 0 && lastBl.length + lastWh.length === 0) {\n"
"      adMaybeFire((N - 1) >> 1, (N - 1) >> 1);\n"
"    }\n"
"    // ★ #120",
"    if (adOn && pendingBal && pendingBal.length) {\n"
"      // 先按序补摆之前评估好的平衡点：过滤已被占据的点\n"
"      var pmm = lastBoardMatrix();\n"
"      var ptodo = pendingBal.filter(function (p) { return !(pmm[p[1]] && pmm[p[1]][p[0]]); });\n"
"      pendingBal = null;\n"
"      if (ptodo.length) { swQueue = ptodo; swIdx = 0; swBtnState(); setTimeout(swAdvance, 200); }\n"
"    }\n"
"    else if (adOn && S.side === 0 && lastBl.length + lastWh.length === 0) {\n"
"      adMaybeFire((N - 1) >> 1, (N - 1) >> 1);\n"
"    }\n"
"    // ★ #120",
"[autodrop-pending]")

# 4) remove gray-out on swbal click
rep(
"  on('__gb_swbal', 'click', function () {\n"
"    // ★ 2026-10-04（用户：未开自动落子点交换平衡点 → 键灰显 + 提示手动摆，减少竞态）：\n"
"    //   交换平衡点自动摆完依赖自动落子；未开 → 不画圈不评估，引导用户先开自动落子\n"
"    //   或自己手动落子。\n"
"    if (!adOn) { ui('setStatus', swTipCol(LT('swBalNeedAd'), '#e67e22')); return; }\n"
"    runSwapBal();\n",
"  on('__gb_swbal', 'click', function () {\n"
"    // 2026-10-07: 取消「未开自动落子则灰显」。落子关也可评估画圈，点保留为待摆(pendingBal)，\n"
"    //   之后开自动落子即按序补摆（见 __gb_autodrop 处理器）。\n"
"    runSwapBal();\n",
"[swbal-gray]")

save(bj, bom, t)

# ---- calc.js: sync side when enabling autodrop ----
cj = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"
bom2, j = load(cj)
old = (
"  q('lk_auto').onclick = function () {\n"
"    c.auto = !(c.auto === true); lkSaveCfg(c);\n"
"    q('lk_auto').classList.toggle('on', c.auto === true); lkSendCfg();\n"
"    lkBridgeAuto(c.auto === true);           // ★ 桥 = 唯一事实源（adOn 开关）\n"
"  };\n"
)
new = (
"  q('lk_auto').onclick = function () {\n"
"    c.auto = !(c.auto === true); lkSaveCfg(c);\n"
"    q('lk_auto').classList.toggle('on', c.auto === true); lkSendCfg();\n"
"    if (c.auto === true) lkBridgeSide(c.aiB ? 0 : (c.aiW ? 1 : -1));  // 开落子：同步执色\n"
"    lkBridgeAuto(c.auto === true);           // 桥 = 唯一事实源（adOn 开关）\n"
"  };\n"
)
print("[calc lk_auto] count:", j.count(old)); assert j.count(old) == 1
j = j.replace(old, new)
save(cj, bom2, j)
print("ALL PATCHED")
