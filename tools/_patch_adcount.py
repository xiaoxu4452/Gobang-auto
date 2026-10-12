# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text):
    open(p, "wb").write(bom + text.encode("utf-8"))

base = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui"

# ---- calc.css ----
cp = base + r"\calc.css"
bom, css = load(cp)
css_old = ".lk-btns .btn{flex:1 1 44%; white-space:nowrap; min-width:0; font-size:.76rem}"
css_new = (
".lk-btns .btn{flex:1 1 0; white-space:nowrap; min-width:0; font-size:.76rem}\n"
".lk-btns #lk_adcount{flex:0 0 2.7rem; padding:0; font-size:.8rem}"
)
print("css anchor:", css.count(css_old)); assert css.count(css_old) == 1
css = css.replace(css_old, css_new)
save(cp, bom, css)

# ---- calc.js ----
jp = base + r"\calc.js"
bom, js = load(jp)

# A) add visible button after lk_auto
a_old = (
"          '<button id=\"lk_auto\" class=\"btn lk-tgl\">' + lkL('自动落子', 'Auto Drop') + '</button>' +\n"
"        '</div>' +\n"
)
a_new = (
"          '<button id=\"lk_auto\" class=\"btn lk-tgl\">' + lkL('自动落子', 'Auto Drop') + '</button>' +\n"
"          '<button id=\"lk_adcount\" class=\"btn\" title=\"' + lkL('落子次数：每个落点连点几下（1~3 循环）', 'Clicks per move (cycles 1-3)') + '\">×1</button>' +\n"
"        '</div>' +\n"
)
print("A anchor:", js.count(a_old)); assert js.count(a_old) == 1
js = js.replace(a_old, a_new)

# B) in sc.onload: sync text via MutationObserver + forward clicks
b_old = (
"        lkBridgeRule((c.rule >= 0 && c.rule <= 2) ? c.rule : 0);\n"
"      } catch (e) {}\n"
)
b_new = (
"        lkBridgeRule((c.rule >= 0 && c.rule <= 2) ? c.rule : 0);\n"
"        var srcAC = document.getElementById('__gb_adcount'), dstAC = document.getElementById('lk_adcount');\n"
"        if (srcAC && dstAC) {\n"
"          dstAC.textContent = srcAC.textContent;\n"
"          new MutationObserver(function () { dstAC.textContent = srcAC.textContent; })\n"
"            .observe(srcAC, { childList: true, characterData: true, subtree: true });\n"
"          dstAC.onclick = function () { srcAC.click(); };\n"
"        }\n"
"      } catch (e) {}\n"
)
print("B anchor:", js.count(b_old)); assert js.count(b_old) == 1
js = js.replace(b_old, b_new)

save(jp, bom, js)
print("patched adcount OK")
