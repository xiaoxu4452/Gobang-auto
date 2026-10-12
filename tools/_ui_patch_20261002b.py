#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-10-02 UI 批次补丁（#115/#117 + 去除深算）：
  extract-panel-ui.js:
    R1-R3  三处行定位锚 id="__gb_deep" → id="__gb_analyze"
    R4-R5  平衡行插入点 → 「哈希表」行后（挪位），自检同步改
    R6-R7  按钮 padding 5px→3px（调矮）
    R8     注释更新
    R9     「交换平衡」→「交换平衡点」
    R10-R11 交换评估配色拆分（琥珀橙）
    R12    顺序自检改（哈希表 < 平衡 < 落子 < 交换 < 规则）
    R13    新增增量⑬：摘除深算按钮
  bridge.js:
    B1-B3  swBalBtn 改名（中英）
    B4     删深算绑定
    B5     注释去深算提法
"""
import shutil, sys, io

def patch(path, pairs):
    shutil.copy2(path, path + '.bak-ui20261002')
    s = io.open(path, 'r', encoding='utf-8').read()
    for i, (old, new) in enumerate(pairs, 1):
        n = s.count(old)
        if n != 1:
            print('FAIL %s R%d: count=%d' % (path, i, n))
            sys.exit(1)
        s = s.replace(old, new)
        print('ok   %s R%d' % (path, i))
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('WROTE', path)

# ============ extract-panel-ui.js ============
EP = 'tools/extract-panel-ui.js'
ep = []

ep.append((
    "  const iDeep = htmlOut.indexOf('id=\"__gb_deep\"');\n"
    "  if (iDeep < 0) throw new Error('找不到「深算」按钮，无法确定「局面」键的插入位置');",
    "  const iDeep = htmlOut.indexOf('id=\"__gb_analyze\"');\n"
    "  if (iDeep < 0) throw new Error('找不到「分析」按钮，无法确定「局面」键的插入位置');",
))

ep.append((
    "  const iDeep2 = htmlOut.indexOf('id=\"__gb_deep\"');",
    "  const iDeep2 = htmlOut.indexOf('id=\"__gb_analyze\"');",
))

ep.append((
    "  const iDeep3 = htmlOut.indexOf('id=\"__gb_deep\"');\n"
    "  if (iDeep3 < 0) throw new Error('找不到「深算」按钮，无法插入平衡选点行');",
    "  const iDeep3 = htmlOut.indexOf('id=\"__gb_analyze\"');\n"
    "  if (iDeep3 < 0) throw new Error('找不到「分析」按钮，无法插入平衡选点行');",
))

ep.append((
    "  // 插在三键行闭合之后（仍在 #__gb_bottombar 内、局面行之前）\n"
    "  const at = rowEnd3 + '</div>'.length;\n"
    "  htmlOut = htmlOut.slice(0, at) + BAL_STYLE + BAL_ROW + htmlOut.slice(at);",
    "  // ★ 2026-10-02（用户）：平衡/自动落子/交换三行挪出底栏常驻板块 →\n"
    "  //   插到「哈希表」行之后、「规则」标题之前（用户指定位置；代价是面板折叠时\n"
    "  //   这三行会随滚动区收起 —— 用户明确要求，尊重）。\n"
    "  const iHashRow = htmlOut.indexOf('data-i18n=\"hash\"');\n"
    "  if (iHashRow < 0) throw new Error('找不到「哈希表」行，无法插入平衡选点行');\n"
    "  const hashRowEnd = htmlOut.indexOf('</div>', iHashRow);\n"
    "  if (hashRowEnd < 0) throw new Error('「哈希表」行未闭合');\n"
    "  const at = hashRowEnd + '</div>'.length;\n"
    "  htmlOut = htmlOut.slice(0, at) + BAL_STYLE + BAL_ROW + htmlOut.slice(at);",
))

ep.append((
    "  // 必须在底栏板块里（常驻可见），且在局面行之前 —— 落进滚动区就是退化\n"
    "  const bs2 = htmlOut.indexOf('id=\"__gb_bottombar\"');\n"
    "  const bal1 = htmlOut.indexOf('id=\"__gb_bal1\"');\n"
    "  const fb = htmlOut.indexOf('id=\"__gb_footbar\"');\n"
    "  if (!(bs2 >= 0 && bal1 > bs2 && fb > bal1)) {\n"
    "    throw new Error('平衡选点行不在底栏板块内（应在三键行与局面行之间）');\n"
    "  }",
    "  // 必须在「哈希表」行后、「规则」标题前（2026-10-02 用户指定位置）\n"
    "  const iRuleChk = htmlOut.indexOf('data-i18n=\"rule\"');\n"
    "  const bal1 = htmlOut.indexOf('id=\"__gb_bal1\"');\n"
    "  if (!(iHashRow >= 0 && bal1 > iHashRow && iRuleChk > bal1)) {\n"
    "    throw new Error('平衡选点行不在「哈希表」与「规则」之间');\n"
    "  }",
))

ep.append((
    "'#__gb_bal1,#__gb_bal2{flex:1;padding:5px 0;border-radius:6px;cursor:pointer;box-sizing:border-box;}' +",
    "'#__gb_bal1,#__gb_bal2{flex:1;padding:3px 0;border-radius:6px;cursor:pointer;box-sizing:border-box;}' +",
))

ep.append((
    "'#__gb_autodrop,#__gb_adcount,#__gb_swbal,#__gb_sweval{padding:5px 0;border-radius:6px;cursor:pointer;box-sizing:border-box;}' +",
    "'#__gb_autodrop,#__gb_adcount,#__gb_swbal,#__gb_sweval{padding:3px 0;border-radius:6px;cursor:pointer;box-sizing:border-box;}' +",
))

ep.append((
    "// 位置：平衡选点行（__gb_balrow）之后、局面行之前 —— 同属底栏常驻板块。",
    "// 位置：平衡选点行（__gb_balrow）之后 —— 2026-10-02 起三行都挪到「哈希表」行后。",
))

ep.append((
    "'<button id=\"__gb_swbal\" title=\"交换平衡：空盘摆出 1 白 + 2 黑三个平衡点（浅蓝=白、浅紫=黑）；已有棋子给一对（1 白 + 1 黑）。配合自动落子可自动摆完\" ' +\n"
    "    'style=\"flex:1;cursor:pointer;\">交换平衡</button>' +",
    "'<button id=\"__gb_swbal\" title=\"交换平衡点：空盘摆出 1 白 + 2 黑三个平衡点（浅蓝=白、浅紫=黑）；已有棋子给一对（1 白 + 1 黑）。配合自动落子可自动摆完\" ' +\n"
    "    'style=\"flex:1;cursor:pointer;\">交换平衡点</button>' +",
))

ep.append((
    "    // 交换手行：青蓝系（白子浅蓝/黑子浅紫语义的延伸；与平衡行的紫区分开）\n"
    "    '#__gb_swbal,#__gb_sweval{flex:1;background:#fff!important;color:#0e7490!important;' +\n"
    "    'border:1px solid #67c3d8!important}' +\n"
    "    '#__gb_swbal:hover,#__gb_sweval:hover{background:#f0fafc!important;filter:none}' +",
    "    // 交换手行：交换平衡=青蓝系（白子浅蓝/黑子浅紫语义的延伸）；\n"
    "    //   交换评估=琥珀橙系（2026-10-02 用户：浅色模式下两个键不能同色）\n"
    "    '#__gb_swbal{flex:1;background:#fff!important;color:#0e7490!important;' +\n"
    "    'border:1px solid #67c3d8!important}' +\n"
    "    '#__gb_swbal:hover{background:#f0fafc!important;filter:none}' +\n"
    "    '#__gb_sweval{flex:1;background:#fff!important;color:#b45309!important;' +\n"
    "    'border:1px solid #e8a96f!important}' +\n"
    "    '#__gb_sweval:hover{background:#fdf6ec!important;filter:none}' +",
))

ep.append((
    "    '[data-dark=\"1\"] #__gb_swbal,#__gb_sweval{background:#122a33!important;color:#8fd4e8!important;' +\n"
    "    'border-color:#2f6b7f!important}' +\n"
    "    '[data-dark=\"1\"] #__gb_swbal:hover,#__gb_sweval:hover{background:#183743!important}' +",
    "    '[data-dark=\"1\"] #__gb_swbal{background:#122a33!important;color:#8fd4e8!important;' +\n"
    "    'border-color:#2f6b7f!important}' +\n"
    "    '[data-dark=\"1\"] #__gb_swbal:hover{background:#183743!important}' +\n"
    "    '[data-dark=\"1\"] #__gb_sweval{background:#2a1f10!important;color:#f0b26e!important;' +\n"
    "    'border-color:#6b4a26!important}' +\n"
    "    '[data-dark=\"1\"] #__gb_sweval:hover{background:#382818!important}' +",
))

ep.append((
    "  // 顺序：平衡行 → 自动落子行 → 交换行 → 局面行，全在底栏常驻板块\n"
    "  const bs3 = htmlOut.indexOf('id=\"__gb_bottombar\"');\n"
    "  const bal1p = htmlOut.indexOf('id=\"__gb_balrow\"');\n"
    "  const adr = htmlOut.indexOf('id=\"__gb_adrow\"');\n"
    "  const swr = htmlOut.indexOf('id=\"__gb_swaprow\"');\n"
    "  const fb2 = htmlOut.indexOf('id=\"__gb_footbar\"');\n"
    "  if (!(bs3 >= 0 && bal1p > bs3 && adr > bal1p && swr > adr && fb2 > swr)) {\n"
    "    throw new Error('自动落子/交换手行不在底栏板块内的正确位置');\n"
    "  }",
    "  // 顺序：哈希表行 → 平衡行 → 自动落子行 → 交换行 → 「规则」标题（2026-10-02 起挪出底栏）\n"
    "  const iHashChk2 = htmlOut.indexOf('data-i18n=\"hash\"');\n"
    "  const ruleChk2 = htmlOut.indexOf('data-i18n=\"rule\"');\n"
    "  const bal1p = htmlOut.indexOf('id=\"__gb_balrow\"');\n"
    "  const adr = htmlOut.indexOf('id=\"__gb_adrow\"');\n"
    "  const swr = htmlOut.indexOf('id=\"__gb_swaprow\"');\n"
    "  if (!(iHashChk2 >= 0 && bal1p > iHashChk2 && adr > bal1p && swr > adr && ruleChk2 > swr)) {\n"
    "    throw new Error('自动落子/交换手行不在「哈希表」之后的正确位置');\n"
    "  }",
))

ep.append((
    "// ---------- 桌面版增量 ⑦：取消「对手落点评估」，四色图例挪到「热力图」按钮后面 ----------",
    "// ---------- 桌面版增量 ⑬：摘除「深算」键（2026-10-02，用户：去除深算这个功能） ----------\n"
    "// 只改桌面版产物：bridge.js 的 30 秒深算绑定同步删除；书签源码一字不动（书签版保留深算）。\n"
    "// 前置：增量⑥/⑩原先借「深算」按钮做行定位锚，已全部改为借「分析」按钮（__gb_analyze）。\n"
    "{\n"
    "  const iDp = htmlOut.indexOf('id=\"__gb_deep\"');\n"
    "  if (iDp < 0) throw new Error('找不到「深算」按钮，无法摘除');\n"
    "  const bS = htmlOut.lastIndexOf('<button', iDp);\n"
    "  const bE = htmlOut.indexOf('</button>', iDp);\n"
    "  if (bS < 0 || bE < 0) throw new Error('「深算」按钮标签未闭合，无法安全摘除');\n"
    "  htmlOut = htmlOut.slice(0, bS) + htmlOut.slice(bE + '</button>'.length);\n"
    "  if (htmlOut.indexOf('__gb_deep') >= 0) throw new Error('桌面版仍残留 __gb_deep 控件');\n"
    "  if (htmlOut.indexOf('id=\"__gb_rec\"') < 0 || htmlOut.indexOf('id=\"__gb_analyze\"') < 0) {\n"
    "    throw new Error('摘除深算后「重新识别/分析」按钮丢失');\n"
    "  }\n"
    "}\n"
    "\n"
    "// ---------- 桌面版增量 ⑦：取消「对手落点评估」，四色图例挪到「热力图」按钮后面 ----------",
))

patch(EP, ep)

# ============ bridge.js ============
BR = 'desktop-overlay/ui/bridge.js'
br = []

br.append((
    "    adBtn: '自动落子', swBalBtn: '交换平衡', swEvalBtn: '交换评估',",
    "    adBtn: '自动落子', swBalBtn: '交换平衡点', swEvalBtn: '交换评估',",
))

br.append((
    "    swEvalEmpty: '棋盘上还没有子 —— 等对手摆完（或先点「交换平衡」）再评估',",
    "    swEvalEmpty: '棋盘上还没有子 —— 等对手摆完（或先点「交换平衡点」）再评估',",
))

br.append((
    "    adBtn: 'Auto drop', swBalBtn: 'Swap balance', swEvalBtn: 'Swap eval',",
    "    adBtn: 'Auto drop', swBalBtn: 'Swap balance point', swEvalBtn: 'Swap eval',",
))

br.append((
    "  on('__gb_deep', 'click', function () {\n"
    "    var old = S.turnMs;\n"
    "    S.turnMs = 30000;\n"
    "    ui('setStatus', '深算中（30 秒）…');\n"
    "    var k = lastBoardKey; lastBoardKey = ''; forceScan = true;\n"
    "    tick().finally(function () { S.turnMs = old; lastBoardKey = k; });\n"
    "  });\n"
    "\n",
    "",
))

br.append((
    "  // 与分析/深算不同：不走 handleScan 的「轮到对手/我执未选」闸 —— 直接用最近一帧盘面。",
    "  // 与分析不同：不走 handleScan 的「轮到对手/我执未选」闸 —— 直接用最近一帧盘面。",
))

patch(BR, br)
print('ALL PATCHES APPLIED')
