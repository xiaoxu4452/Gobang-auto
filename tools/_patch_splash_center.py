# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
hp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"; bom, h = load(hp)

# 修正 PaintSplash 水平居中：sm.cx（"Meter" 宽）只在 hasMeter 时计入总宽；
# rest 起点也只在 hasMeter 时右移 sm.cx。无 Meter 前缀的品牌词整段精确居中。
old1 = "    int tx = rc2.left + ((rc2.right - rc2.left) - (sm.cx + sr.cx)) / 2;"
new1 = (
"    // ★★ 2026-10-09（用户：「窗口启动的加载界面，文字直接居中对齐」）★★\n"
"    //   旧码把 sm.cx（\"Meter\" 的宽度）无条件算进水平总宽 —— 对没有 Meter 前缀的\n"
"    //   品牌词（Gomoku Link / Gomoku Review / Gomoku Vision）会整体偏右约半字 \"Meter\"，\n"
"    //   看起来就是「启动 logo 没居中」。现在只在 hasMeter 时把 Meter 宽度计入，\n"
"    //   无 Meter 前缀时按整段 sr.cx 精确居中；rest 起点同样只在 hasMeter 时右移。\n"
"    int totalW = hasMeter ? (sm.cx + sr.cx) : sr.cx;\n"
"    int tx = rc2.left + ((rc2.right - rc2.left) - totalW) / 2;"
)
old2 = "    TextOutW(dc, tx + sm.cx, ty, rest, (int)wcslen(rest));"
new2 = (
"    if (hasMeter) tx += sm.cx;   // 仅 Meter 前缀存在时，rest 从 Meter 之后起画\n"
"    TextOutW(dc, tx, ty, rest, (int)wcslen(rest));"
)
o1 = old1.replace("\n", "\r\n"); n1 = new1.replace("\n", "\r\n")
o2 = old2.replace("\n", "\r\n"); n2 = new2.replace("\n", "\r\n")
c1 = h.count(o1); c2 = h.count(o2)
print("tx:", c1, "rest:", c2)
assert c1 == 1 and c2 == 1
h = h.replace(o1, n1).replace(o2, n2)
save(hp, bom, h)
print("PATCHED")
