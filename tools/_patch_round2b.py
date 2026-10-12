# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
def rep(t, old, new, tag):
    n = t.count(old); print(tag, "count:", n); assert n == 1, tag
    return t.replace(old, new)

# ---- bridge.js: both tianyuan sites -> force physical click ----
bp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"; bom, b = load(bp)
b = rep(b,
"        adLastPt = null;\n        adMaybeFire((N - 1) >> 1, (N - 1) >> 1);",
"        adLastPt = null;\n        adFire((N - 1) >> 1, (N - 1) >> 1, true, true);",
"[tianyuan scan-frame]")
b = rep(b,
"    else if (adOn && S.side === 0 && lastBl.length + lastWh.length === 0) {\n      adMaybeFire((N - 1) >> 1, (N - 1) >> 1);",
"    else if (adOn && S.side === 0 && lastBl.length + lastWh.length === 0) {\n      adFire((N - 1) >> 1, (N - 1) >> 1, true, true);",
"[tianyuan toggle]")
save(bp, bom, b)

# ---- host.cpp: empty-board sync fallback ----
hp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"; bom, h = load(hp)
old = (
"      }\n"
"    }\n"
"    return;\n"
"  }\n"
"  if (g_lselAuto) { static int autoMiss = 0; autoMiss = 0; (void)autoMiss; }\n"
)
new = (
"      }\n"
"    }\n"
"    // 2026-10-07: locked region, 4 consecutive frames with no stone/grid -> adopt empty board\n"
"    // (distinct from a truly vanished board: auto mode keeps counting to 8 before fullscreen\n"
"    // re-search). If stones reappear next frame they are restored via the 2-frame stable gate.\n"
"    if (g_lselGrown) {\n"
"      static int s_emptyMiss = 0;\n"
"      if (++s_emptyMiss >= 4) {\n"
"        s_emptyMiss = 0; int anyStone = 0;\n"
"        for (int yy = 0; yy < 15; ++yy) for (int xx = 0; xx < 15; ++xx)\n"
"          if (g_linkBoard[yy][xx]) anyStone = 1;\n"
"        if (anyStone) {\n"
"          memset(g_linkBoard, 0, sizeof(g_linkBoard)); g_lastBoardKey = \"\";\n"
"          PostToLinkPageSoon(\"{\\\"type\\\":\\\"linkBoard\\\",\\\"black\\\":[],\\\"white\\\":[],\\\"b\\\":0,\\\"w\\\":0}\");\n"
"          PostToPageSoon(std::string(\"{\\\"type\\\":\\\"linkPos\\\",\\\"payload\\\":\") +\n"
"                         JsonQuote(\"{\\\"black\\\":[],\\\"white\\\":[]}\"));\n"
"          LogMsg(\"[link] empty board adopted after 4 misses (synced clear)\");\n"
"        }\n"
"      }\n"
"    }\n"
"    return;\n"
"  }\n"
"  if (g_lselAuto) { static int autoMiss = 0; autoMiss = 0; (void)autoMiss; }\n"
)
h = rep(h, old, new, "[empty fallback]")
save(hp, bom, h)
print("ALL PATCHED")
