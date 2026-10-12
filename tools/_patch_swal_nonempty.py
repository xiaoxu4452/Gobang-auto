# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
bp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"; bom, b = load(bp)

# 1) 中文译文
zh_anchor = "    swBalEmpty: '空盘交换平衡计算中（1 白 + 2 黑三点组）…', swBalPair: '交换平衡计算中（1 白 + 1 黑）…',\n"
zh_add = zh_anchor + "    swBalNotEmpty: '交换平衡点仅在空棋盘有效（官方平衡开局，两黑一白）；棋盘上已有棋子，功能失效',\n"
n = b.count(zh_anchor); print("zh:", n); assert n == 1; b = b.replace(zh_anchor, zh_add)

# 2) 英文译文
en_anchor = "    swBalEmpty: 'Balancing 3-point swap set (1 white + 2 black)…', swBalPair: 'Balancing swap pair (1 white + 1 black)…',\n"
en_add = en_anchor + "    swBalNotEmpty: 'Swap balance only works on an empty board (official balanced openings, 2 black + 1 white); stones are already present, so it is unavailable',\n"
n = b.count(en_anchor); print("en:", n); assert n == 1; b = b.replace(en_anchor, en_add)

# 3) runSwapBal 开头拦截非空（在 boardGeo 检查后、swBusy/setSide 等副作用前）
guard_anchor = ("    if (!boardGeo) { ui('setStatus', '<span style=\"color:#e67e22;\">' + T('no_board') + '</span>'); return; }\n"
                "    swBusy = true;\n")
guard_new = ("    if (!boardGeo) { ui('setStatus', '<span style=\"color:#e67e22;\">' + T('no_board') + '</span>'); return; }\n"
"    // ★ 2026-10-08（用户）：交换平衡点仅空棋盘有效（官方 SWAP2 平衡开局，两黑一白 3 点）；\n"
"    //   棋盘已有子（含 3 手后第二次交换的一黑一白 2 点）一律失效，不评估、无副作用（不动执色）。\n"
"    if (lastBl.length + lastWh.length > 0) {\n"
"      ui('setStatus', swTipCol(LT('swBalNotEmpty'), '#e67e22'));\n"
"      return;\n"
"    }\n"
"    swBusy = true;\n")
n = b.count(guard_anchor); print("guard:", n); assert n == 1; b = b.replace(guard_anchor, guard_new)

save(bp, bom, b); print("PATCHED")
