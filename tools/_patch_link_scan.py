# -*- coding: utf-8 -*-
def load(p):
    raw = open(p, "rb").read()
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    if bom: raw = raw[3:]
    return bom, raw.decode("utf-8")
def save(p, bom, text): open(p, "wb").write(bom + text.encode("utf-8"))
hp = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\src\host.cpp"; bom, h = load(hp)

# 1) 连线窗启动遮罩品牌词 Link -> Gomoku Link（标题栏 kLinkTitle 保持 Link 不动）
brand_old = 'static const wchar_t* kBrandNameLink = L"Link";'
brand_new = 'static const wchar_t* kBrandNameLink = L"Gomoku Link";'
n=h.count(brand_old); print("brand:",n); assert n==1; h=h.replace(brand_old,brand_new)

# 2) 未锁定阶段：在 fl 快档分支之后插入「手动框选有效区域 → 固定 200ms 快找、不降速」分支。
#    原有 miss>=3→1000 / auto→150 / else→1000 行保持不动；新分支排在它们之前，
#    于是手动框选（!auto 且 region 有效）即使连续 miss 也恒定 200ms，直到 2 帧锁定。
per_old = (
"        int period = 380;\n"
"        int fl = g_linkFastLeft.load();\n"
"        if (fl > 0) { period = 100; g_linkFastLeft.store(fl - 1); }\n")
per_new = (
"        int period = 1000;\n"
"        int fl = g_linkFastLeft.load();\n"
"        if (fl > 0) { period = 100; g_linkFastLeft.store(fl - 1); }\n"
"        // ★★ 2026-10-09（用户：「框选棋盘不能快速且正确地识别和框选」）：手动框选点「识别」后、\n"
"        //   首次收紧锁定前，旧逻辑落到 1s 静默档（1 秒才找一次），而锁定需连续 2 帧网格 ±4px\n"
"        //   一致 —— 既慢（2~4s 才变蓝绿）又易被落子动画打断、streak 反复归零。对齐桌面助手\n"
"        //   main.js 的 tick（固定节奏、在已知区域持续重定位、不因 miss 单方面降速）：只要用户\n"
"        //   已框定有效区域（非自动档），锁定前一律 200ms 在框内快找，连续 miss 也不降速。\n"
"        else if (!g_lselAuto &&\n"
"                 (g_scanRegion.right > g_scanRegion.left &&\n"
"                  g_scanRegion.bottom > g_scanRegion.top)) period = 200;\n")
per_old=per_old.replace("\n","\r\n"); per_new=per_new.replace("\n","\r\n")
n=h.count(per_old); print("period:",n); assert n==1; h=h.replace(per_old,per_new)

save(hp,bom,h); print("PATCHED")
