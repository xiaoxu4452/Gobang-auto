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

jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"; bom, j = load(jp)
j = rep(j,
"  if (!!G.linkOn === !!on) return;\n  // ① 当前设置存回**来源**档（正常改动只进正常档）",
"  if (!!G.linkOn === !!on) return;\n  // ★ 2026-10-07（深色进入连线被连线档旧浅色覆盖）：外观全局统一，切档前快照\n  var keepTheme = S.theme, keepCssVars = S.cssVars, keepCustomBase = S.customBase;\n  // ① 当前设置存回**来源**档（正常改动只进正常档）",
"[snapshot appearance]")
j = rep(j,
"  for (var k in st) if (S.hasOwnProperty(k)) S[k] = st[k];\n  // ★ 2026-10-07：档载入后重放连线页最后下发的配置",
"  for (var k in st) if (S.hasOwnProperty(k)) S[k] = st[k];\n  // ★ 恢复切档前外观（深浅主题/棋盘颜色全局一致，不被连线档旧值覆盖）\n  S.theme = keepTheme; S.cssVars = keepCssVars; S.customBase = keepCustomBase;\n  // ★ 2026-10-07：档载入后重放连线页最后下发的配置",
"[restore appearance]")
save(jp, bom, j)
print("PATCHED")
