# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"; bom, j = load(jp)
old = ("  function lkBrandHTML(){\n"
"    var sky='#38bdf8';\n"
"    return S.lang==='en'\n"
"      ? '<i><span style=\"color:'+sky+'\">Meter</span> Gomoku Link</i>'\n"
"      : '<i><span style=\"color:'+sky+'\">米特</span>五子棋连线</i>';\n"
"  }")
new = ("  function lkBrandHTML(){\n"
"    // 容器（.boot .brand / .lk-brand）整行斜体；仅「米特/Meter」包 <i>，由 CSS 涂天蓝 #3d9bd6\n"
"    return S.lang==='en'\n"
"      ? '<i>Meter</i> Gomoku Link'\n"
"      : '<i>米特</i>五子棋连线';\n"
"  }")
n = j.count(old); print("count:", n); assert n == 1
j = j.replace(old, new); save(jp, bom, j); print("PATCHED")
