# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
jp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.js"; bom, j = load(jp)

blocks = [
# 中文 featGuide 第八条
"""      { t: '八、全网搜索（内置微浏览器）', ps: [
        '关于页的「获取最新版」也打开同一个内嵌浏览器（直达蓝奏云下载页，密码在关于页）。',
      ]},
""",
# 中文 v4.35 四条更新
"""      'v4.35 微浏览器整颗重做：顶栏加返回 / 前进 / 刷新键与圆角搜索框、历史下拉，跟随主窗中 / 英与深浅色；下载文件每次弹系统「另存为」对话框',
      'v4.35 智力优化（保持 2000ms 思考不变）：落子后引擎在用户思考期预思，同样的两秒能搜得更深（Ponder 门槛 15s→2s，空闲 10s 自动停，对齐官方 rapfi 全开口径）',
      'v4.35 复盘独立窗口适配英文模式：语言随主窗实时切换，自己打开也按主窗语言恢复',
      'v4.35 「搜索」键移到「历史」与「关于」之间，打开的就是全新微浏览器',
""",
# 中文 featList 全网搜索条
"""      '全网搜索：内置微浏览器（必应搜索 / 直达网址、刷新与返回前进、历史下拉），跟随中英与深浅色，下载弹系统保存框',
""",
# 英文 featGuide 第八条
"""      { t: '8. Web search (built-in mini browser)', ps: [
        '"Get latest version" on the About page opens the same embedded browser (straight to the download page, password shown on About).',
      ]},
""",
# 英文 v4.35 四条更新
"""      'v4.35 Mini browser rebuilt: back / forward / refresh keys plus a rounded search box and history dropdown on the toolbar; follows the main window language and light/dark theme; every download opens the system "Save As" dialog',
      'v4.35 Strength tuning (still 2000ms per move): the engine ponders during your thinking time, so the same two seconds search deeper (Ponder threshold 15s->2s, auto-off after 10s idle)',
      'v4.35 Review window now supports English: it follows the main-window language live and restores it when opened by itself',
      'v4.35 The "Search" button moved between "History" and "About" - it opens the rebuilt mini browser',
""",
]
for i,b in enumerate(blocks):
    n=j.count(b); print(i,"count:",n); assert n==1
    j=j.replace(b,"")
save(jp,bom,j); print("PATCHED")
