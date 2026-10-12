# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))

hp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"; bom, h = load(hp)
old = ("  if (key == g_lastBoardKey) return;\n"
       "  // ★ 2026-10-07（用户：「识别逻辑要和桌面助手一样」）：盘面采纳稳定闸（助手 STABLE_FRAMES")
new = ("  if (key == g_lastBoardKey) return;\n"
       "  // ★ 2026-10-07（用户：初始识别几个字一直刷新）：区域未收紧锁定（!g_lselGrown）前不采纳棋子——\n"
       "  //   先框选/自动确认锁定网格，再识别棋子，杜绝初始全屏噪点上小棋盘闪烁。\n"
       "  if (!g_lselGrown) { g_linkRescanSoon.store(true); return; }\n"
       "  // ★ 2026-10-07（用户：「识别逻辑要和桌面助手一样」）：盘面采纳稳定闸（助手 STABLE_FRAMES")
n = h.count(old); print("count:", n); assert n == 1
h = h.replace(old, new)
save(hp, bom, h)
print("PATCHED")
