# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
bp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"; bom, b = load(bp)

# 1) 中文译文：swBalNotEmpty -> swBalStage（正确的两次交换窗口语义）
zh_old = "    swBalNotEmpty: '交换平衡点仅在空棋盘有效（官方平衡开局，两黑一白）；棋盘上已有棋子，功能失效',\n"
zh_new = "    swBalStage: '交换平衡点只在空盘（两黑一白 3 点）或已有 3 子（一黑一白 2 点）时可用；当前手数不在交换窗口',\n"
n=b.count(zh_old); print("zh:",n); assert n==1; b=b.replace(zh_old,zh_new)

# 2) 英文译文
en_old = "    swBalNotEmpty: 'Swap balance only works on an empty board (official balanced openings, 2 black + 1 white); stones are already present, so it is unavailable',\n"
en_new = "    swBalStage: 'Swap balance only works on an empty board (2 black + 1 white, 3 points) or after 3 stones (a black-white pair, 2 points); the current move count is outside the swap window',\n"
n=b.count(en_old); print("en:",n); assert n==1; b=b.replace(en_old,en_new)

# 3) 拦截块：改为 ply==0 或 ply==3 放行，其余失效
g_old = (
"    // ★ 2026-10-08（用户）：交换平衡点仅空棋盘有效（官方 SWAP2 平衡开局，两黑一白 3 点）；\n"
"    //   棋盘已有子（含 3 手后第二次交换的一黑一白 2 点）一律失效，不评估、无副作用（不动执色）。\n"
"    if (lastBl.length + lastWh.length > 0) {\n"
"      ui('setStatus', swTipCol(LT('swBalNotEmpty'), '#e67e22'));\n"
"      return;\n"
"    }\n"
"    swBusy = true;\n")
g_new = (
"    // ★ 2026-10-08（用户澄清）：SWAP2 两次交换窗口——\n"
"    //   空盘 ply0：第一次交换，给两黑一白 3 点（官方平衡开局）；\n"
"    //   已有 3 子 ply3：对方选交换后的第二次交换，给一黑一白 2 点（第 4、5 手，\n"
"    //     走官方 YXBALANCETWO 平衡搜索：双方优势近 0，看不出哪方便宜）；\n"
"    //   其余手数（非 0/3）：不在交换窗口，失效且无副作用。\n"
"    var swPly = lastBl.length + lastWh.length;\n"
"    if (swPly !== 0 && swPly !== 3) {\n"
"      ui('setStatus', swTipCol(LT('swBalStage'), '#e67e22'));\n"
"      return;\n"
"    }\n"
"    swBusy = true;\n")
n=b.count(g_old); print("guard:",n); assert n==1; b=b.replace(g_old,g_new)

save(bp,bom,b); print("PATCHED2")
