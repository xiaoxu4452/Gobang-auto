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
# 1) applyLang 补四个分区标题
j = rep(j,
"   'heatBest','heatGood','heatFair','heatPoor','coach','coachHint',\n   'swapTtl','swapFirst','swapSecond'].forEach(function (k) {",
"   'heatBest','heatGood','heatFair','heatPoor','coach','coachHint',\n   'swapTtl','swapFirst','swapSecond',\n   'secGame','secEngine','secView','secCode'].forEach(function (k) {",
"[sec titles i18n]")
# 2) lkBrandHTML 函数定义
j = rep(j,
"  document.title = lkL('Link', 'Link');   // ★ 23 轮（用户：软件上面的名字就一个 Link）\n  var lkBootBrand = document.querySelector('#boot .brand');",
"  document.title = lkL('Link', 'Link');   // ★ 23 轮（用户：软件上面的名字就一个 Link）\n  // ★ 2026-10-07（用户：启动页/Link 界面均显示米特五子棋连线 logo，「米特/Meter」天蓝色，跟随中英）\n  function lkBrandHTML(){\n    var sky='#38bdf8';\n    return S.lang==='en'\n      ? '<i><span style=\"color:'+sky+'\">Meter</span> Gomoku Link</i>'\n      : '<i><span style=\"color:'+sky+'\">米特</span>五子棋连线</i>';\n  }\n  var lkBootBrand = document.querySelector('#boot .brand');",
"[lkBrandHTML def]")
# 3) boot brand 使用
j = rep(j,
"  if (lkBootBrand) lkBootBrand.innerHTML = '<i>Meter Gomoku Link</i>';",
"  if (lkBootBrand) lkBootBrand.innerHTML = lkBrandHTML();",
"[boot brand]")
# 4) lk-brand 静态加 id
j = rep(j,
"    '<div class=\"lk-brand\">Meter Gomoku Link</div>';",
"    '<div class=\"lk-brand\" id=\"lkBrandEl\"></div>';",
"[lk-brand id]")
# 5) appendChild 后初始化 logo
j = rep(j,
"  document.body.appendChild(pane);\n\n  var c = lkCfg();",
"  document.body.appendChild(pane);\n  var lkBrandEl = document.getElementById('lkBrandEl');\n  if (lkBrandEl) lkBrandEl.innerHTML = lkBrandHTML();\n\n  var c = lkCfg();",
"[lk-brand init]")
# 6) uiTheme 语言变化更新 logo
j = rep(j,
"      lkStatus(); lkSyncCount(); lkPaintBoard(); lkPaintCurve();\n      return;\n    }\n    if (m.type === 'linkState') {",
"      lkStatus(); lkSyncCount(); lkPaintBoard(); lkPaintCurve();\n      var lkBe = document.getElementById('lkBrandEl'); if (lkBe) lkBe.innerHTML = lkBrandHTML();\n      return;\n    }\n    if (m.type === 'linkState') {",
"[uiTheme brand]")
save(jp, bom, j)

cp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.css"; bom2, c = load(cp)
c = rep(c,
"body.linkOn #hdr .brand::after{\n  content:'· 连线中';\n  color:#3d9bd6; font-style:italic; font-weight:600;\n  font-size:.8em; margin-left:.4rem;\n}",
"body.linkOn #hdr .brand::after{\n  content:'· 连线中';\n  color:#3d9bd6; font-style:italic; font-weight:600;\n  font-size:.8em; margin-left:.4rem;\n}\nhtml[lang=\"en\"] body.linkOn #hdr .brand::after{ content:'· Linking'; }",
"[linking css i18n]")
save(cp, bom2, c)
print("PATCHED")
