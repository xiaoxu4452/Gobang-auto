# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))

# ---- calc.js：识图复制按钮 i18n ----
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"; bom, j = load(jp)
oldj = ("  els.btn_load.textContent = d.load;\n"
        "  els.btn_recite.textContent = d.recite;")
newj = ("  els.btn_load.textContent = d.load;\n"
        "  if (els.btn_vis_codecopy) els.btn_vis_codecopy.textContent = d.copy;   // ★ 识图「复制」i18n\n"
        "  els.btn_recite.textContent = d.recite;")
n = j.count(oldj); print("js count:", n); assert n == 1
j = j.replace(oldj, newj); save(jp, bom, j)

# ---- calc.css：局面代码行窄屏换行铺开 ----
cp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.css"; bomc, c = load(cp)
oldc = ".codeHead{display:flex; align-items:center; gap:.32rem}"
newc = (".codeHead{display:flex; flex-wrap:wrap; align-items:center; gap:.32rem; row-gap:.3rem}\n"
        "/* ★ 2026-10-07（用户：英文/超窄窗 Position code 按钮堆叠、Load 被截断）：标签不断字不收缩，\n"
        "   窄屏时复制/粘贴/载入整体换到第二行左对齐铺开。 */\n"
        ".codeHead #t_code{white-space:nowrap; flex:0 0 auto}")
n = c.count(oldc); print("css count:", n); assert n == 1
c = c.replace(oldc, newc); save(cp, bomc, c)
print("PATCHED")
