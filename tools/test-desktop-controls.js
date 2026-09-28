/* 桌面面板「控件接线」行为级测试
 * ============================================================================
 * 为什么要有这个文件（而不是再写一份源码字面量比对）：
 *   test-side-buttons.js 那类测试只比对源码里的色值/字符串，**不能**发现
 *   「事件接上了、但逻辑接错了」的问题。实际就漏掉过一个：
 *     不透明度滑块绑的是  ui('applyOpacity')，而 applyOpacity() 读的是 S.opacity
 *     并把滑块重置回该值 —— 于是拖一下就弹回原位，看着完全没反应。
 *   源码级断言对这种 bug 全绿。
 *
 * 所以这里用**真实 Chromium（本机 Edge 无头模式）**加载真正的 panel.html，
 * 由页面自己驱动控件、把结果写回 DOM，再用 --dump-dom 取回来。
 * 覆盖：**落子键已彻底移除**（桌面版只做指导，不替用户落子）、两个滑块、两个数字框、
 *       六个步进键、两个输入框、三个规则勾选、热力图/对手落点/深色/语言开关，
 *       以及「无 JS 报错」。
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const vm = require('vm');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'desktop-overlay', 'ui');
const PANEL = path.join(UI_DIR, 'panel.html');
const HARNESS = path.join(UI_DIR, '_panel_controls_test.html');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// ---------------------------------------------------------------- 页面内的测试脚本
// 注入的时机有讲究：必须在 panel-ui.js / bridge.js **之前**，
// 因为 bridge.js 一开头就用 window.chrome.webview 判定「宿主模式」。
// 这里装一个假的 WebView2 桥，让面板按**生产时的宿主模式**跑：
// 不抓屏、不打网络，只有控件接线在动 —— 正是本测试要测的东西。
const SHELL_JS = `
<script>
(function () {
  window.__msgs = [];
  window.chrome = {
    webview: {
      // 把宿主的消息处理器**抓住**：热力图协议那一段要自己喂一帧"扫到棋盘"的推送，
      // 否则 handleScan 永远不会被触发（面板在宿主模式下只吃推送，不主动抓屏）。
      addEventListener: function (t, fn) { window.__handler = fn; },
      postMessage: function (s) { window.__msgs.push(String(s)); },
    },
  };
  window.fetch = function () { return Promise.reject(new Error('stub: 测试不联网')); };
})();
</script>
`;

const TEST_JS = `
<script>
(function () {
  var out = [], errs = [];
  window.addEventListener('error', function (e) { errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) {
    errs.push('未处理的 Promise 拒绝：' + ((e.reason && e.reason.message) || e.reason));
  });

  function ok(name, cond, extra) {
    out.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (extra === undefined ? '' : String(extra)));
  }
  function q(id) { return document.getElementById(id); }
  function fire(el, ev) { el.dispatchEvent(new Event(ev, { bubbles: true })); }
  function S() { return window.GB_S || {}; }
  function stepEl(dir) { return document.querySelector('.__gb_step[data-dir="' + dir + '"]'); }

  function finish() {
    var pre = document.createElement('pre');
    pre.id = '__test_out';
    // 标记必须**运行时拼**出来：--dump-dom 会把本段脚本源码也一起序列化进 DOM，
    // 若源码里直接写死标记，driver 的正则会先匹配到脚本里那一处（拿到空结果）。
    var B = '<<' + 'GBRES' + '>>', E = '<<' + 'GBEND' + '>>';
    pre.textContent = '\\n' + B + '\\n' + out.join('\\n') + '\\n' + E + '\\n';
    document.body.appendChild(pre);
  }

  // ---------------- 热力图协议测试：可控的 fetch 桩 + 一帧扫描 ----------------
  // 桩按请求的 lane 分派，**刻意模仿真实引擎的退化行为**：
  //   · 主分析（topN=1，无 lane）→ 1 条候选（单路深搜）
  //   · 热力图第一次（lane=sub, topN=8）→ 只有 2 条候选
  //     —— 引擎在必胜/简单局面下 NUMPV 就是会退化成 1~3 条，这正是"热力图只剩一两种颜色"的根因
  //   · 热力图的第二次（同一 sub 通道补搜，预算更长）→ 5 条候选，应当被采纳
  var heatReqs = [];
  function candsOf(n, base) {
    var a = [];
    for (var i = 0; i < n; i++) {
      a.push({ x: 7 + i, y: 7, eval: '+' + (base - i * 100), depth: 12, speed: 1, nodes: 1, line: [] });
    }
    return a;
  }
  function stubHeat() {
    window.__msgs.length = 0;
    heatReqs.length = 0;
    window.fetch = function (url, opt) {
      var body = {};
      try { body = JSON.parse((opt && opt.body) || '{}'); } catch (e) {}
      var isSub = body.lane === 'sub';
      heatReqs.push({ url: String(url), lane: body.lane || '', topN: body.topN, turnMs: body.turnMs });
      var nSub = 0;
      for (var k = 0; k < heatReqs.length; k++) if (heatReqs[k].lane === 'sub') nSub++;
      var n = isSub ? (nSub === 1 ? 2 : 5) : 1;
      var cands = candsOf(n, 600);
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ candidates: cands, best: [cands[0].x, cands[0].y] }); },
      });
    };
    // 热力图默认是关的 —— 关着时面板根本不会发 heat 消息，先点开。
    if (!S().heatmap) q('__gb_heat').click();
    // ★ 必须先选定「我执颜色」，否则整条评估链一步都不会走：
    //   未选定时 handleScan 走 haltNoSide() 直接 return（用户 2026-09-17 的要求：
    //   「两者都没选上…待用户选择黑白中的其中一个，这样可能会稳定一些」）——
    //   不选的话主分析/热力图都不会发请求，本文件下面那 15 条就全是假红
    //   （实测「0 次 sub 请求」、主分析一条都没有，就是踩在这里）。
    //   下面喂的盘面是 black 2 子 / white 1 子 → 轮白走，所以选「我执白」才轮到我方。
    if (S().side !== 0 && S().side !== 1) q('__gb_side_white').click();
    // 喂一帧"扫到棋盘"的推送。几何必须给全：boardToScreen 就靠 x_lines/y_lines 把
    // 棋盘坐标换成屏幕物理坐标，geometry 缺了整条指导层都会静默不画。
    var xs = [], ys = [];
    for (var i = 0; i < 15; i++) { xs.push(300 + i * 60); ys.push(300 + i * 60); }
    if (!window.__handler) throw new Error('没抓到宿主的消息处理器（SHELL_JS 没装好？）');
    window.__handler({ data: { type: 'scan', data: {
      ok: true, found: true, suspect: false,
      geometry: { size: 15, x_lines: xs, y_lines: ys },
      black: [{ x: 7, y: 7 }, { x: 8, y: 8 }], white: [{ x: 8, y: 7 }],
    } } });
  }

  function heatAsserts() {
    var subs = heatReqs.filter(function (r) { return r.lane === 'sub'; });
    var mains = heatReqs.filter(function (r) { return r.lane !== 'sub'; });
    ok('主分析走 topN=1（单路深搜，落子最稳）', mains.length >= 1 && mains[0].topN === 1,
      JSON.stringify(mains[0]));
    ok('热力图走 sub 副通道 + topN=8（多任务并行，不抢主分析算力）',
      subs.length >= 1 && subs[0].topN === 8, JSON.stringify(subs[0]));
    ok('热力图预算由步时推出（半步时，夹在 1200..4000）',
      subs.length >= 1 && subs[0].turnMs >= 1200 && subs[0].turnMs <= 4000,
      subs[0] && subs[0].turnMs);
    ok('★ 候选 <4 时在同一条 sub 通道补搜一次（凑齐档位颜色）',
      subs.length === 2, subs.length + ' 次 sub 请求');
    ok('补搜预算比首次更长',
      subs.length === 2 && subs[1].turnMs > subs[0].turnMs,
      subs.length === 2 ? subs[0].turnMs + ' -> ' + subs[1].turnMs : '');

    var heat = null;
    for (var i = window.__msgs.length - 1; i >= 0; i--) {
      if (window.__msgs[i].indexOf('"type":"heat"') >= 0) { heat = window.__msgs[i]; break; }
    }
    ok('面板把热力图发给了宿主（由宿主画在整屏上）', !!heat, (heat || '').slice(0, 96));
    var m = heat && /"cells":"([^"]*)"/.exec(heat);
    var cells = m ? m[1] : '';
    var list = cells ? cells.split(';') : [];
    ok('格子数 = 补搜采纳的 5 条候选', list.length === 5, list.length + ' 个');
    ok('格子分隔符是分号（标签里的字符不会把它截断）', cells.indexOf(';') > 0);
    var f0 = (list[0] || '').split(',');
    ok('每个格子 4 个字段：x,y,档位,评估数字', f0.length === 4, JSON.stringify(f0));
    ok('★ 格子里确实带上了评估数字（首格 +600）', f0[3] === '+600', JSON.stringify(f0));
    // ★ 第 3 字段是**档位 1..4**（青/绿/粉红/浅粉），不是 0~100 的归一化强度：
    //   归一化会把聚集候选挤进同一色带（整盘一种色的历史根因），已改为按名次分档。
    ok('最佳点档位 1（青）', f0[2] === '1', f0[2]);
    var fl = (list[list.length - 1] || '').split(',');
    ok('末位档位 4（浅粉）', fl[2] === '4', JSON.stringify(fl));
    ok('5 个候选的档位单调不降（1,1,2,3,4）',
      list.map(function (s) { return s.split(',')[2]; }).join('') === '11234',
      list.map(function (s) { return s.split(',')[2]; }).join(','));
    ok('坐标已换算成屏幕物理像素（geometry 300 + 7×60 = 720）',
      f0[0] === '720' && f0[1] === '720', f0[0] + ',' + f0[1]);
    ok('消息里带 gap（格距；宿主据此定色块边长与字号）', /"gap":60/.test(heat || ''));
  }

  // ---------------- ⑩ 「轮到对手不评估」回归护栏 ----------------
  // 用户严令：「确保评估就是用户选择的先后手」。书签版早有 !ourTurn 就 return 的闸
  // （bookmarklet.js「轮到对手：不评估、不落子，只等」），桌面版此前**漏了这道闸** ——
  // 对手一落子盘面就变，旧逻辑会再请求一次引擎，而那一帧引擎的行棋方是**对手**：
  // 返回的分数推进曲线、覆盖 S.myEval 之后，用户看到的就是
  // 「评估/曲线在黑白之间来回跳、和我方该走时算出来的值对不上」。
  var oppBefore = null;
  function geomLines() {
    var xs = [], ys = [];
    for (var i = 0; i < 15; i++) { xs.push(300 + i * 60); ys.push(300 + i * 60); }
    return { xs: xs, ys: ys };
  }
  function oppTurnProbe() {
    var gl = geomLines();
    var frame = { data: { type: 'scan', data: {
      ok: true, found: true, suspect: false,
      geometry: { size: 15, x_lines: gl.xs, y_lines: gl.ys },
      // 我执白（上面已点过），盘面 2:2 → 子数相等 → 轮黑 = 轮到**对手**走
      black: [{ x: 7, y: 7 }, { x: 8, y: 8 }], white: [{ x: 8, y: 7 }, { x: 9, y: 9 }],
    } } };
    oppBefore = { reqs: heatReqs.length, hist: (S().history || []).length,
                  myEval: S().myEval, msgs: window.__msgs.length };
    window.__handler(frame);
    // 抖动抑制要求「同一新盘面连续 2 帧一致」才认，所以补第二帧（busy 门要求隔开一拍）
    setTimeout(function () { window.__handler(frame); }, 400);
  }
  function oppTurnAsserts() {
    if (!oppBefore) { out.push('FAIL | 对手回合探针未执行 | 前置断言没跑到'); return; }
    ok('★ 轮到对手：一条引擎请求都不发（不动评估、不动曲线）',
      heatReqs.length === oppBefore.reqs, (heatReqs.length - oppBefore.reqs) + ' 次新请求');
    ok('★ 轮到对手：评估值保持「我方该走」那一次的读数',
      S().myEval === oppBefore.myEval, S().myEval + ' / 期望 ' + oppBefore.myEval);
    ok('★ 轮到对手：曲线不新增点',
      (S().history || []).length === oppBefore.hist,
      (S().history || []).length + ' / 期望 ' + oppBefore.hist);
    var st = String((q('__gb_status') || {}).textContent || '');
    // 注意：本文件前面点过语言键（zh->en），所以中英文都要认
    ok('轮到对手：状态栏提示「等待对手落子」',
      st.indexOf('等待对手') >= 0 || st.indexOf('Waiting for opponent') >= 0, st.slice(0, 48));
    var tail = window.__msgs.slice(oppBefore.msgs).join(' | ');
    ok('轮到对手：撤下热力图（发 heat on:false）',
      tail.indexOf('"type":"heat","on":false') >= 0, tail.slice(0, 90));
  }

  setTimeout(function () {
    try {
      // ---------- ① 桌面版**没有**落子按键（用户方案：只指导，不替用户落子）----------
      // 这批断言是「反向」的：以前这里测的是胶囊控件（左段开/关 + 右段 ×1/×2），
      // 现在功能被取消，控件必须**整段消失**。逐个点名，避免哪天又漏删一个。
      ok('面板里没有自动落子键 #__gb_auto', !q('__gb_auto'));
      ok('面板里没有点击次数键 #__gb_clickn', !q('__gb_clickn'));
      ok('面板里没有胶囊容器 #__gb_autocap', !q('__gb_autocap'));
      ok('面板里没有落子按钮的 i18n 键（data-i18n="auto"）', !document.querySelector('[data-i18n="auto"]'));
      var autoish = document.querySelectorAll('[id*="auto"]');
      ok('面板里没有任何 id 含 auto 的控件', autoish.length === 0, autoish.length + ' 个');
      // 注意：必须查 #__gb_panel 的文案，而不是 document.body —— 本测试脚本自己就贴在 body 里，
      // 它的源码里写着「自动落子」这几个字，用 body.textContent 会永远自我命中。
      var panelTxt = (q('__gb_panel') || document.body).textContent || '';
      ok('面板可见文案里没有「自动落子」', panelTxt.indexOf('自动落子') < 0);
      ok('存档里的自动落子开关处于关闭（不会因残留状态自己下棋）', !S().autoPlay, S().autoPlay);
      // ---------- ② 不透明度 / 模糊 滑块（「滑动功能」）----------
      var panel = q('__gb_panel');
      var opr = q('__gb_opacity_range'), opn = q('__gb_opacity_num');
      opr.value = '60'; fire(opr, 'input');
      ok('拖不透明度滑块：值写进了状态', S().opacity === 60, S().opacity);
      ok('拖不透明度滑块：滑块没有被弹回原位', opr.value === '60', opr.value);
      ok('拖不透明度滑块：数字框同步', opn.value === '60', opn.value);
      ok('拖不透明度滑块：面板背景真的半透明了', /rgba\\(255, 255, 255, 0\\.6/.test(panel.style.background || ''),
        panel.style.background);

      // ★ 模糊控件已**整体摘除**（用户需求 2026-09-17：「移除模糊度这个功能选项，
      //   只是单纯的调整透明度」）。桌面端面板背后的东西是真实桌面，没有网页可当 backdrop；
      //   真透明由宿主的**分层窗口**提供（WS_EX_LAYERED + WebView2 透明背景），
      //   不需要也不应该有模糊这一档。所以这里断言的是「模糊控件彻底不存在」。
      ok('面板背板不使用 CSS 模糊（backdrop-filter 为 none）',
        (panel.style.backdropFilter || panel.style.webkitBackdropFilter || 'none') === 'none',
        panel.style.backdropFilter || panel.style.webkitBackdropFilter || 'none');
      ok('面板里没有模糊滑块 #__gb_blur_range', !q('__gb_blur_range'));
      ok('面板里没有模糊数字框 #__gb_blur_num', !q('__gb_blur_num'));
      ok('面板里没有「模糊度」文案键（data-i18n="blur"）', !document.querySelector('[data-i18n="blur"]'));
      ok('模糊状态恒为 0（不参与合成，只剩透明度）', S().blur === 0, S().blur);
      // 有滑块还不够：必须真的把外观报给宿主，否则又是一个"拖了没反应"的控件
      ok('透明度/外观上报给宿主（uiLook 消息）',
        window.__msgs.some(function (m) { return m.indexOf('uiLook') >= 0; }),
        (window.__msgs.filter(function (m) { return m.indexOf('uiLook') >= 0; })[0] || '无').slice(0, 90));

      // 「局面」功能键：点了要通知宿主弹小窗（小窗本身是宿主的 Win32 窗口，不在页面里）
      ok('面板有「局面」功能键 #__gb_pos', !!q('__gb_pos'));
      (function () { var b = q('__gb_pos'); if (b) b.click(); })();
      ok('点「局面」会通知宿主开小窗（openPos 消息）',
        window.__msgs.some(function (m) { return m.indexOf('openPos') >= 0; }));

      // 数字框：**越界输入回落到上一个合法值**（不是硬钳到边界）——这是书签版的行为，
      // 桌面版要与之一致。所以这里必须记下当前值再断言「没被越界输入改坏」。
      opn.value = '999'; fire(opn, 'change');
      ok('不透明度数字框：越界（超上限）回落到上一个合法值', S().opacity === 60 && opn.value === '60',
        S().opacity + '/' + opn.value);
      opn.value = '5'; fire(opn, 'change');
      ok('不透明度数字框：越界（低于下限）同样回落', S().opacity === 60, S().opacity);
      // 模糊控件已整体摘除 → 这里不再有「模糊数字框」可测
      opn.value = '80'; fire(opn, 'change');
      ok('不透明度数字框：合法值正常生效', S().opacity === 80, S().opacity);

      // ---------- ③ 六个步进键 ----------
      var tv = q('__gb_turnval'), mv = q('__gb_matchval');
      var t0 = parseFloat(tv.value);
      stepEl('turn+').click();
      ok('步时 + 键：+0.25 秒', Math.abs(parseFloat(tv.value) - (t0 + 0.25)) < 1e-6, tv.value);
      ok('步时 + 键：turnMs 同步换算', S().turnMs === S().customTurnSec * 1000, S().turnMs);
      stepEl('turn-').click();
      ok('步时 − 键：−0.25 秒', Math.abs(parseFloat(tv.value) - t0) < 1e-6, tv.value);

      var m0 = parseInt(mv.value, 10);
      stepEl('match+').click();
      ok('局时 + 键：+10 秒', parseInt(mv.value, 10) === m0 + 10, mv.value);
      stepEl('match-').click();
      ok('局时 − 键：−10 秒', parseInt(mv.value, 10) === m0, mv.value);

      var h0 = parseInt(q('__gb_hashval').textContent, 10);
      stepEl('hash+').click();
      ok('哈希 + 键：+128MB（封顶 2048）',
        parseInt(q('__gb_hashval').textContent, 10) === Math.min(2048, h0 + 128),
        h0 + ' -> ' + q('__gb_hashval').textContent);
      stepEl('hash-').click();
      ok('哈希 − 键：−128MB（保底 128）',
        parseInt(q('__gb_hashval').textContent, 10) === Math.max(128, Math.min(2048, h0 + 128) - 128),
        q('__gb_hashval').textContent);

      // ---------- ④ 步时 / 局时输入框 ----------
      // 注意它们是 <input type="number">：非法字符在**浏览器层**就被拒（value 直接变空），
      // 所以「过滤非法字符」这件事实际由浏览器完成；我们负责的是失焦时把空值还原成合法值。
      tv.value = '1.2.3'; fire(tv, 'input');
      ok('步时输入框：非法输入被拒（number 输入框浏览器层就挡掉）', tv.value === '', JSON.stringify(tv.value));
      var keepTurn = S().customTurnSec;
      fire(tv, 'change');
      ok('步时输入框：失焦时还原为上一个合法值', S().customTurnSec === keepTurn, S().customTurnSec);
      tv.value = '99999'; fire(tv, 'change');
      ok('步时输入框：钳到上限 6000', S().customTurnSec === 6000, S().customTurnSec);
      tv.value = '0.1'; fire(tv, 'change');
      ok('步时输入框：钳到下限 0.5', S().customTurnSec === 0.5, S().customTurnSec);

      mv.value = 'a1b2'; fire(mv, 'input');
      ok('局时输入框：非法输入被拒（同上）', mv.value === '', JSON.stringify(mv.value));
      mv.value = '999999'; fire(mv, 'change');
      ok('局时输入框：钳到上限 30000', S().customSec === 30000, S().customSec);

      // ---------- ⑤ 规则勾选 ----------
      var r1 = document.querySelector('[data-rule="1"]');
      r1.click();
      ok('点规则项：写入 S.rule', S().rule === 1, S().rule);
      ok('点规则项：勾号随之可见', r1.querySelector('.__gb_chk').style.visibility === 'visible',
        r1.querySelector('.__gb_chk').style.visibility);
      var r0 = document.querySelector('[data-rule="0"]');
      ok('未选中的规则项：勾号隐藏', r0.querySelector('.__gb_chk').style.visibility === 'hidden',
        r0.querySelector('.__gb_chk').style.visibility);

      // ---------- ⑥ 热力图 + 四色图例（对手落点评估已在桌面版取消）----------
      var wasHeat = !!S().heatmap;
      q('__gb_heat').click();
      ok('点热力图键：开关翻转', !!S().heatmap === !wasHeat, S().heatmap);
      // ★ 用户要求（2026-09-17）：「取消对手评估这个功能」「热力图按键后面就是四种颜色的
      //   颜色展示标点」。所以契约反过来了：对手键必须**不存在**；图例必须常显、且紧跟热力图。
      ok('桌面版没有「对手落点评估」按钮（该功能已整体取消）', !q('__gb_opp'), '应查不到 #__gb_opp');
      ok('桌面版没有对手落点的图标节点', !q('__gb_opp_icon'), '应查不到 #__gb_opp_icon');
      var lg = q('__gb_legend');
      ok('四色图例存在', !!lg);
      ok('四色图例常显（不再随热力图开关显隐）', !!lg && getComputedStyle(lg).display !== 'none',
        lg ? getComputedStyle(lg).display : '(缺失)');
      ok('四色图例在 HTML 里就写死 display:flex（宿主/paintFrame 都不会再改成 none）',
        // ⚠ 两个坑叠在一起，都踩过了：
        //   ① 不能死抠 "display:flex"（无空格）：JS 里任何一次 el.style.xxx = ... 都会让浏览器
        //      重新序列化 style 属性，把 display:flex 规范成 "display: flex;"，于是正则假红。
        //   ② 本断言位于**模板字符串**里，单个反斜杠会被模板吃掉（反斜杠 s 变成 s），
        //      注入浏览器后就成了 /display:s*flex/ —— 永远不匹配。必须写双反斜杠。
        //   ⚠ 本段在模板字符串内部：**禁止出现反引号**，否则整个脚本语法直接崩。
        /id="__gb_legend"[^>]*display:\\s*flex/.test(panel.outerHTML),
        JSON.stringify(panel.outerHTML.substr(panel.outerHTML.indexOf('__gb_legend'), 90)));
      ok('四色图例有且只有四个色点', !!lg && lg.querySelectorAll('i').length === 4,
        lg ? lg.querySelectorAll('i').length : 0);
      ok('四色图例紧跟「热力图」按钮（同一个 flex 行内、在其右侧）',
        !!lg && lg.previousElementSibling && lg.previousElementSibling.id === '__gb_heat',
        lg && lg.previousElementSibling ? lg.previousElementSibling.id : '(无)');

      // ---------- ⑦ 深色 / 语言 ----------
      var wasDark = !!S().dark;
      q('__gb_dark').click();
      ok('点深色键：开关翻转', !!S().dark === !wasDark, S().dark);
      ok('点深色键：根元素 data-dark 同步', panel.getAttribute('data-dark') === (S().dark ? '1' : '0'),
        panel.getAttribute('data-dark'));
      q('__gb_dark').click();

      var wasLang = S().lang;
      q('__gb_lang').click();
      ok('点语言键：语言翻转', S().lang !== wasLang, wasLang + ' -> ' + S().lang);
      ok('点语言键：热力图键文案非空（data-i18n 刷新仍在生效）', q('__gb_heat').textContent.trim().length > 0,
        JSON.stringify(q('__gb_heat').textContent));
      // 语言一换按钮宽度就变 → 必须重报面板矩形，否则宿主拖动命中区会挡住新按钮位置
      var reported = window.__msgs.filter(function (s) { return /"type":"panelRect"/.test(s); }).length;
      ok('点语言键：重新上报了面板矩形（宿主拖动命中区要跟着更新）', reported >= 1, reported + ' 次');

      // ---------- ⑧ 整页无脚本错误 ----------
      ok('整页无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' / '));
    } catch (e) {
      out.push('FAIL | 测试脚本自身异常 | ' + (e && e.message));
    }

    // ---------- ⑨ 热力图协议（走 sub 副通道 + 格子带评估数字）----------
    // 这一步要等异步链路（扫描 → 主分析 → 热力图补充搜索）跑完，所以放到嵌套的 setTimeout 里，
    // 断言完再写结果。用虚拟时间跑，不需要真的等两秒。
    try { stubHeat(); } catch (e) { out.push('FAIL | 热力图桩装载失败 | ' + (e && e.message)); }
    setTimeout(function () {
      try { heatAsserts(); } catch (e) { out.push('FAIL | 热力图断言异常 | ' + (e && e.message)); }
      // ---------- ⑩ 轮到对手不评估（要等第二次推送走完抖动抑制）----------
      try { oppTurnProbe(); } catch (e) { out.push('FAIL | 对手回合探针装载失败 | ' + (e && e.message)); }
      setTimeout(function () {
        try { oppTurnAsserts(); } catch (e) { out.push('FAIL | 对手回合断言异常 | ' + (e && e.message)); }
        finish();
      }, 1600);
    }, 2500);
  }, 600);
})();
</script>
`;

function findBrowser() {
  for (const p of BROWSERS) { if (fs.existsSync(p)) return p; }
  return null;
}

function main() {
  console.log('== 桌面面板控件接线（真实浏览器行为级）==');
  if (!fs.existsSync(PANEL)) {
    console.error('找不到 ' + PANEL + '，请先 node tools/build-overlay.js');
    process.exit(1);
  }
  const browser = findBrowser();
  if (!browser) {
    // 本机没有 Chromium 系浏览器时不算失败：明确跳过，避免在没浏览器的机器上误报。
    console.log('  未找到 Edge/Chrome，跳过（本机无法做真实浏览器行为测试）');
    console.log('--- 0 passed, 0 failed ---');
    return;
  }

  // ★ 护栏：SHELL_JS / TEST_JS 都是**模板字面量**，里面那段 JS 的语法错误
  //   `node --check` 是看不见的（它只检查外层文件，模板内容对它就是一段字符串）。
  //   这个坑真踩过：在 TEST_JS 里写了一个反引号 → 模板提前闭合 → 注入脚本整段作废 →
  //   页面一条结果都回不来，而外层 --check 还是绿的。所以生成前把两段各编译一次。
  for (const [name, src] of [['SHELL_JS', SHELL_JS], ['TEST_JS', TEST_JS]]) {
    // 两段都自带 <script> 标签（要直接插进 HTML），编译前先把标签剥掉。
    const body = src.replace(/^\s*<script>\s*/, '').replace(/<\/script>\s*$/, '');
    try { new vm.Script(body); }
    catch (e) { console.error(name + ' 里的注入脚本语法错误：' + e.message); process.exit(1); }
  }

  // 把外壳脚本插到 panel-ui.js 之前，测试脚本插到 bridge.js 之后。
  let html = fs.readFileSync(PANEL, 'utf8');
  const atShell = html.indexOf('<script src="panel-ui.js">');
  if (atShell < 0) { console.error('panel.html 结构变了：找不到 panel-ui.js 引用'); process.exit(1); }
  html = html.slice(0, atShell) + SHELL_JS + html.slice(atShell);
  const atEnd = html.lastIndexOf('</body>');
  html = html.slice(0, atEnd) + TEST_JS + html.slice(atEnd);
  fs.writeFileSync(HARNESS, html, 'utf8');

  // 用 http 提供（不用 file://）：file:// 属于不透明源，localStorage / fetch 会直接抛错，
  // 面板的存档读写就跑不起来，测出来的行为不等于生产行为。
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(UI_DIR, rel);
    if (!f.startsWith(UI_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(f);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/' + path.basename(HARNESS);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ctl-'));
    // ★ 必须用异步 spawn，不能 execFileSync：
    //   本文件自己就是这台 HTTP 服务的宿主，同步执行会把 node 的事件循环整个堵死，
    //   服务端一个字节都发不出去 —— 浏览器一直等，最后 ETIMEDOUT（这个坑踩过一次）。
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox',
      '--user-data-dir=' + profile, '--virtual-time-budget=12000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { dom += d; });

    const finish = (why) => {
      server.close();
      try { fs.unlinkSync(HARNESS); } catch (x) {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {}
      if (!dom.trim()) {
        console.error('  浏览器没有回传 DOM（' + why + '）；本机 Edge 无头模式可能受限');
        process.exit(1);
      }
      // ★ 必须先反转义再找标记：--dump-dom 把文本里的 < > & 都转义了，
      //   不还原的话连标记本身都变成了 &lt;&lt;GBRES&gt;&gt;，永远匹配不上。
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
      if (!m) {
        // 排查用：把原始 DOM 落盘，否则「脚本为什么没跑完」只能靠猜。
        const dump = path.join(ROOT, 'desktop-overlay', 'build', '_panel_test_dom.txt');
        try { fs.mkdirSync(path.dirname(dump), { recursive: true }); fs.writeFileSync(dump, dom, 'utf8'); } catch (x) {}
        console.error('  页面没有回传测试结果（脚本可能没跑完，' + why + '）；原始 DOM 见 ' + dump);
        process.exit(1);
      }
      const body = m[1];
      let pass = 0, fail = 0;
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
        else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
      }
      console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
      process.exit(fail ? 1 : 0);
    };

    const killer = setTimeout(() => {
      try { child.kill(); } catch (x) {}
      finish('90 秒超时');
    }, 90000);
    child.on('exit', (code) => { clearTimeout(killer); finish('exit=' + code); });
  });
}

main();
