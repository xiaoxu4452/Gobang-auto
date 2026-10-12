// =====================================================================================
//  UI 切片取景器（给软件说明 PDF 插图用）
//
//  为什么不用 `msedge --headless --screenshot`：本页面里的 AI Worker 会把 headless 的
//  虚拟时间卡死（tools/_trainer_shot.py 头注释记过：90~120s 被 SIGTERM、无产物）。
//  为什么不起真窗口再 PrintWindow：那截的是**整窗**，没法逐块切片。
//  ⇒ 走 CDP：起发布版 EXE（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开远程调试）→
//     强制一个确定的视口（deviceScaleFactor 2）→ 逐元素量 getBoundingClientRect →
//     Page.captureScreenshot 带 clip 直接出「恰好那个元素」的 2× 图。
//
//  ★ 每一条踩过的坑都写在这里，改脚本前先读：
//   ① **每一「揭示态」必须单独截一张**：历史抽屉是会盖住右半屏的浮层、颜色窗是带遮罩的
//      模态 —— 同一张整页图里同时揭开它们，rect 是对的，裁出来的像素却互相污染。
//      ⇒ 拆成若干 pass，一 pass 一图。
//   ② **绝不能写 `dockL.innerHTML=""`**：引擎卡当时正躺在左栏，会被连元素一起删掉
//      （第一版 m-engine 直接 MISS）。appendChild 会自动改父。
//   ③ **`.dock:not(.has)` 的 flex/width 都是 0** —— 不补 .has，三张卡量出来是
//      「x=1488 w=20 h=3268」的塌缩条（同一次踩到）。
//   ④ **clip.scale 是再乘一层**：视口 deviceScaleFactor 已经 2，这里必须写 1，
//      否则出图是 4×（第一版写成 scale:dsf，出 6000x224 而不是 3000x112）。
//   ⑤ **语言只认 DOM**：`#btn_lang` 键面上写的是「点了会切到哪种语言」——
//      键面 "EN" ⇔ 当前中文，键面 "中" ⇔ 当前英文。别去猜全局状态挂在哪个对象上
//      （发布版的 `window.GB_S` 在连上 target 的那一刻还不一定有）。
//
//  用法：
//    node tools/_make_ui_slices.js all  zh     # 主窗 + 连线窗，中文
//    node tools/_make_ui_slices.js all  en     # 主窗 + 连线窗，英文
//    node tools/_make_ui_slices.js main en
//    node tools/_make_ui_slices.js link zh
//  产物：tools/_ui_slices/<lang>/<name>.png          ← 成品（PDF 直接插图）
//        tools/_ui_slices/_full/_<pass>_full.png     ← 整页图，人工核对布局用
//        tools/_ui_slices/_full/_<pass>_rects.json   ← 量测清单
// =====================================================================================
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = 'C:/Users/harve/Desktop/Gobang auto';
var EXE = path.join(ROOT, 'Meter Gomoku', 'Desktop GomokuTrainer.exe');
var OUTD = path.join(ROOT, 'tools', '_ui_slices');
var FULLD = path.join(OUTD, '_full');
var WANT = process.argv[2] || 'all';
var LANG = (process.argv[3] || 'zh').toLowerCase();
var LANGD = path.join(OUTD, LANG);
var PORT = 9341;
var DSF = 2;                                       // 统一 2× 输出，PDF 里才不糊

// 一张真实感的中盘（gomocalc 口径：小写列字母 + 从下往上的行号，逐手拼接）。
// 黑方 f8-g8-h8-i8 四连（未成五）→ 截图里的评估 / 曲线 / 序号都有内容可看。
var DEMO_CODE = 'h8i7i8h7g9j8g7f6g8j6e9k7f8j9i9k5';

// ---------------------------------------------------------------------- pass 定义
//  items[].sel  = 目标元素；items[].up = 往上爬几层再量（取「那颗键所在的整行」）
var MAIN_PASSES = [
  {
    tag: 'm-basic', vw: 1500, vh: 1000, mode: 'main',
    items: [
      { name: 'm-topbar', sel: '#hdr' },
      { name: 'm-board', sel: '#boardCol' },
    ],
  },
  // ★ 卡片必须**一张一 pass**（p.scroll 先把目标滚进停靠栏可视区）：
  //   #dockR 是 `overflow-y:auto`，排在可视区之外的卡片虽然 getBoundingClientRect
  //   有正常坐标，但**根本没被绘制** —— captureBeyondViewport 也救不回来，
  //   裁出来是一张纯白图（2026-10-08 实测：分析卡 y=1269 全程空白）。
  //   对局设置卡整张 305×1182（≈1:3.9），裁成插图是一根细长条，字全挤没了，
  //   ⇒ 按卡内四个 .sec 板块分别取景，比例正常，也正好对上正文的四个小节。
  {
    tag: 'm-set-game', vw: 1500, vh: 1000, mode: 'main', scroll: '.card[data-id="setup"] .sec[data-sec="game"]',
    items: [{ name: 'm-set-game', sel: '.card[data-id="setup"] .sec[data-sec="game"]' }],
  },
  {
    tag: 'm-set-engine', vw: 1500, vh: 1000, mode: 'main', scroll: '.card[data-id="setup"] .sec[data-sec="engine"]',
    items: [{ name: 'm-set-engine', sel: '.card[data-id="setup"] .sec[data-sec="engine"]' }],
  },
  {
    tag: 'm-set-view', vw: 1500, vh: 1000, mode: 'main', scroll: '.card[data-id="setup"] .sec[data-sec="view"]',
    items: [{ name: 'm-set-view', sel: '.card[data-id="setup"] .sec[data-sec="view"]' }],
  },
  {
    tag: 'm-set-code', vw: 1500, vh: 1000, mode: 'main', scroll: '.card[data-id="setup"] .sec[data-sec="code"]',
    items: [{ name: 'm-set-code', sel: '.card[data-id="setup"] .sec[data-sec="code"]' }],
  },
  {
    tag: 'm-analysis', vw: 1500, vh: 1000, mode: 'main', scroll: '.card[data-id="analysis"]',
    items: [{ name: 'm-analysis', sel: '.card[data-id="analysis"]' }],
  },
  {
    tag: 'm-engine', vw: 1500, vh: 1000, mode: 'main', scroll: '.card[data-id="engine"]',
    items: [{ name: 'm-engine', sel: '.card[data-id="engine"]' }],
  },
  {
    tag: 'm-drawer', vw: 1500, vh: 1000, mode: 'main', reveal: '#drawer',
    items: [{ name: 'm-drawer', sel: '#drawer' }],
  },
  {
    tag: 'm-color', vw: 1500, vh: 1000, mode: 'main', reveal: '#colorPop',
    items: [{ name: 'm-color', sel: '#colorPop .modal-card' }],
  },
  {
    tag: 'm-aiside', vw: 1500, vh: 1000, mode: 'main', reveal: '#aiSidePop',
    items: [{ name: 'm-aiside', sel: '#aiSidePop' }],
  },
  {
    tag: 'm-vis', vw: 1240, vh: 900, mode: 'vis',
    items: [{ name: 'm-vis', sel: '#visPane' }],
  },
  {
    tag: 'm-rv', vw: 1100, vh: 950, mode: 'rv',
    items: [{ name: 'm-rv', sel: '#boardCol' }],
  },
];
var LINK_PASSES = [
  {
    tag: 'l-panel', vw: 340, vh: 740, mode: 'link',
    items: [
      { name: 'l-panel', sel: '.lk-panel' },
      { name: 'l-rule', sel: '#lk_rule' },
      { name: 'l-top', sel: '#lk_select', up: 1 },     // 框选棋盘 / 自动落子 / ×1
      { name: 'l-side', sel: '.lk-side' },
      { name: 'l-swap', sel: '#lk_bal', up: 1 },       // 交换平衡点 / 交换评估
      { name: 'l-stats', sel: '.lk-stats' },
      { name: 'l-status', sel: '#lkStatus' },
      { name: 'l-board', sel: '.lk-boardcol' },
      { name: 'l-window', sel: '#linkPane' },
    ],
  },
];

// ---------------------------------------------------------------------- 框架
function log(s) { console.log('[slice] ' + s); }
function killTrainer() {
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
}
function fetchTargets() {
  return new Promise(function (res) {
    var req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 2000 }, function (r) {
      var b = ''; r.on('data', function (d) { b += d; }); r.on('end', function () { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    });
    req.on('error', function () { res(null); }); req.on('timeout', function () { req.destroy(); res(null); });
  });
}
function pollTargets(want, ms) {
  var t0 = Date.now();
  return new Promise(function (res, rej) {
    (function loop() {
      fetchTargets().then(function (t) {
        var hit = t && t.filter(want)[0];
        if (hit) return res(hit);
        if (Date.now() - t0 > ms) return rej(new Error('target wait timeout'));
        setTimeout(loop, 600);
      });
    })();
  });
}
function wsConnect(url) {
  return new Promise(function (res, rej) {
    var key = crypto.randomBytes(16).toString('base64');
    var req = http.get(url.replace(/^ws:/, 'http:'), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', function (r, socket) {
      var buf = Buffer.alloc(0), pending = {}, nid = 0;
      function emit(obj) {
        if (obj.id && pending[obj.id]) { var f = pending[obj.id]; delete pending[obj.id]; f(obj); }
      }
      function frame(op, payload) {
        var mask = crypto.randomBytes(4), h;
        if (payload.length < 126) h = Buffer.from([0x80 | op, 0x80 | payload.length]);
        else if (payload.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(payload.length), 2); }
        var body = Buffer.from(payload);
        for (var i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        return Buffer.concat([h, mask, body]);
      }
      function feed(chunk) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          var op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0, len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (masked) off += 4;
          if (buf.length < off + len) return;
          var payload = buf.slice(off + (masked ? 4 : 0), off + len);
          if (masked) { var mk = buf.slice(off, off + 4); for (var i = 0; i < payload.length; i++) payload[i] ^= mk[i % 4]; }
          buf = buf.slice(off + len);
          if (op === 9) { socket.write(frame(10, payload)); continue; }
          if (op === 8) { try { socket.end(); } catch (e) {} continue; }
          if (op === 1 || op === 2) { try { emit(JSON.parse(payload.toString('utf8'))); } catch (e) {} }
        }
      }
      socket.on('data', feed);
      socket.on('error', function (e) { try { Object.keys(pending).forEach(function (k) { pending[k]({ error: { message: String(e) } }); }); } catch (x) {} });
      res({
        send: function (method, params, timeoutMs) {
          return new Promise(function (resolve, reject) {
            var id = ++nid;
            var timer = setTimeout(function () { delete pending[id]; reject(new Error('cdp timeout: ' + method)); }, timeoutMs || 15000);
            pending[id] = function (r) { clearTimeout(timer); resolve(r); };
            socket.write(frame(1, Buffer.from(JSON.stringify({ id: id, method: method, params: params || {} }), 'utf8')), function () {});
          });
        },
        close: function () { try { socket.end(); } catch (e) {} },
      });
    });
    req.on('error', rej);
    req.on('response', function (r) { rej(new Error('no upgrade: ' + r.statusCode)); });
  });
}
function evalJs(cdp, expr) {
  return cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 30000)
    .then(function (r) {
      if (r && r.result && r.result.exceptionDetails) log('eval EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240));
      var ro = r && r.result && r.result.result;
      return ro && ro.value;
    });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
/** 截图偶发超时（WebView2 在大 clip 上偶尔卡一拍）—— 统一重试 2 次再放弃。 */
function retry(fn, n, tag) {
  return fn().catch(function (e) {
    if (n <= 0) throw e;
    log('    retry(' + n + ') ' + tag + ': ' + (e && e.message || e));
    return sleep(1200).then(function () { return retry(fn, n - 1, tag); });
  });
}

// ---------------------------------------------------------------------- 页面侧脚本
var WANT_BTN = LANG === 'zh' ? 'EN' : '中';        // 键面写上「点了会切到的语言」
/** 语言只认 DOM（坑⑤）。返回键面文字，便于核对。 */
function PREP_LANG() {
  return '(function(){' +
    ' var lb = document.getElementById("btn_lang");' +
    ' for (var k = 0; k < 4 && lb && lb.textContent.trim() !== ' + JSON.stringify(WANT_BTN) + '; k++) lb.click();' +
    ' document.body.setAttribute("data-theme", "light");' +
    ' return lb ? lb.textContent.trim() : "no-btn"; })()';
}
/** 载入演示中盘（只在输入框为空时载，避免每次 pass 反复重开）+ 勾上「显示序号」。 */
function PREP_DEMO() {
  return '(function(){' +
    ' var ic = document.getElementById("inp_code");' +
    ' if (ic && !ic.value) { ic.value = ' + JSON.stringify(DEMO_CODE) + ';' +
    '   var bl = document.getElementById("btn_load"); if (bl) bl.click(); }' +
    ' var cn = document.getElementById("chk_num");' +
    ' if (cn && !cn.checked) { cn.click(); }' +            // 棋子上标手数 → 插图信息量更足
    ' return "codeLen=" + (ic ? ic.value.length : -1) + " showNum=" + (cn ? cn.checked : "-"); })()';
}
/** 跑一次「计算」，让仪表盘 / 曲线 / 推荐圈里有真数字（插图才不是一排 "-"）。
 *  计算本身不改局面，所以可以在所有 pass 之前只跑一次。 */
function PREP_CALC() {
  return '(function(){' +
    ' var b = document.getElementById("btn_an_stop");' +
    ' if (!b) return "no-calc-btn";' +
    ' if (b.textContent.indexOf("停止") < 0 && b.textContent.toLowerCase().indexOf("stop") < 0) b.click();' +
    ' return "calc clicked: " + b.textContent; })()';
}
/** 切到某个「揭示态」：main / vis / rv / link。每次 pass 前都调，保证幂等。 */
function PREP_MODE(mode, reveal) {
  return '(function(){' +
    ' var mode = ' + JSON.stringify(mode) + ', reveal = ' + JSON.stringify(reveal || '') + ';' +
    ' var b = document.body; b.setAttribute("data-theme", "light");' +
    ' b.classList.toggle("vis", mode === "vis");' +
    ' b.classList.toggle("rv", mode === "rv");' +
    ' b.classList.remove("link");' +
    // ① 先把所有可揭示块关回去（幂等的前提）
    ' ["#drawer", "#colorPop", "#visPane", "#aiSidePop", "#setPop"].forEach(function(s){' +
    '   var e = document.querySelector(s); if (!e) return; e.hidden = true; e.classList.remove("on"); });' +
    ' var cm = document.getElementById("cardmenu"); if (cm) cm.hidden = true;' +
    ' var vp = document.getElementById("visPane"); if (vp) vp.hidden = (mode !== "vis");' +
    ' var rvb = document.getElementById("rvBar"); if (rvb) rvb.hidden = (mode !== "rv");' +
    // ② 主窗态：三张卡都要显出来，但**必须走真实的显隐入口**（「设置」弹窗里的
    //    data-card 键），不能自己把 .card 的 hidden 摘掉 —— 手工摘 hidden 只会让卡
    //    的**外壳**出现，卡内四个 .sec 板块是空的（实测：对局设置卡 1180px 高，内容
    //    只有开头 300px，下面全是空框）。点真键才会顺手把板块内容渲染出来。
    //    ⚠ 顺带记牢：默认只显示「引擎仪表盘」，setup/analysis 出厂是 display:none。
    ' if (mode === "main") {' +
    '   var setBtn = document.getElementById("btn_set");' +
    '   if (setBtn) setBtn.click();' +                      // 先弹出「卡片」菜单
    '   ["setup", "analysis", "engine"].forEach(function(id){' +
    '     var c = document.querySelector(\'.card[data-id="\' + id + \'"]\');' +
    '     if (c && c.hasAttribute("hidden")) {' +
    '       var kb = document.querySelector(\'#setPop button[data-card="\' + id + \'"]\');' +
    '       if (kb) kb.click(); } });' +
    '   var spOpen = document.getElementById("setPop"); if (spOpen) spOpen.hidden = true;' +
    '   var dR2 = document.getElementById("dockR"); if (dR2) dR2.classList.add("has");' +
    '   var cards = document.querySelectorAll(".card[data-id]");' +
    '   for (var ci = 0; ci < cards.length; ci++) {' +
    '     var cf = cards[ci];' +
    '     cf.hidden = false; cf.removeAttribute("hidden");' +   // 折叠态也展开（折叠只剩一条）
    '     cf.classList.remove("collapsed"); cf.classList.remove("fold"); }' +
    ' }' +
    // ③ 本 pass 要揭示的那一块
    ' if (reveal) { var rv = document.querySelector(reveal);' +
    '   if (rv) { rv.hidden = false; rv.removeAttribute("hidden");' +
    '     if (reveal === "#colorPop") rv.classList.add("on"); } }' +
    ' window.scrollTo(0, 0);' +
    ' var dr = document.getElementById("dockR");' +
    ' return "mode=" + mode + " reveal=" + (reveal || "-") +' +
    '        " dockR=" + (dr ? Math.round(dr.getBoundingClientRect().width) : "-"); })()';
}
/** 量各元素的 rect（CSS px；clip 截图时 Chromium 自己乘 deviceScaleFactor）。
 *  items[].trim = true 时把高度收到「最后一个后代的下沿」——
 *  停靠栏里的 .card **连同 .card-b 都被 flex 拉伸**填满剩余高度（量 .card-b 下沿
 *  照样是 1180px），直接量整卡会带一大段空白。⇒ 扫全部后代取最大 bottom 再夹回卡高。 */
function measureFn(items) {
  var spec = items.map(function (it) { return { n: it.name, s: it.sel, u: it.up || 0, tr: !!it.trim }; });
  return '(function(){' +
    ' var out = [], spec = ' + JSON.stringify(spec) + ';' +
    ' spec.forEach(function(sp){' +
    '   var e = document.querySelector(sp.s), o = { name: sp.n, sel: sp.s };' +
    '   if (!e) { o.miss = 1; out.push(o); return; }' +
    '   var probe = e;' +
    '   for (var u = 0; u < sp.u && probe.parentElement; u++) probe = probe.parentElement;' +
    '   var r = probe.getBoundingClientRect();' +
    '   o.x = Math.max(0, Math.round(r.left)); o.y = Math.max(0, Math.round(r.top));' +
    '   o.w = Math.round(r.width); o.h = Math.round(r.height);' +
    '   if (sp.tr) {' +
    '     var mx = 0, all = probe.querySelectorAll("*"), who = [];' +
    '     for (var qi = 0; qi < all.length; qi++) {' +
    '       var cb = all[qi].getBoundingClientRect().bottom;' +
    '       if (cb > mx) { mx = cb; }' +
    '       if (cb > r.top + 24) who.push({ b: cb, k: all[qi].tagName + "." + (all[qi].className || "") + "#" + (all[qi].id || "") }); }' +
    '     who.sort(function(a, b) { return b.b - a.b; });' +
    '     o.dbg = who.slice(0, 4).map(function(x) { return Math.round(x.b - r.top) + ":" + String(x.k).slice(0, 40); }).join(" | ");' +
    '     if (mx > 0) o.h = Math.min(o.h, Math.max(24, Math.round(mx - r.top) + 2));' +
    '   }' +
    '   var cs = getComputedStyle(probe);' +
    '   o.vis = cs.visibility + "/" + cs.display + "/" + cs.opacity;' +
    '   out.push(o);' +
    ' });' +
    ' return JSON.stringify({ iw: window.innerWidth, ih: window.innerHeight,' +
    '   dpr: window.devicePixelRatio, slices: out }, null, 1); })()';
}

function shot(cdp, tag) {
  return retry(function () {
    return cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 60000);
  }, 2, 'full/' + tag)
    .then(function (r) {
      var d = r && r.result && r.result.data;
      if (!d) throw new Error('no screenshot data for ' + tag);
      var f = path.join(FULLD, '_' + tag + '_full.png');
      fs.writeFileSync(f, Buffer.from(d, 'base64'));
      log('    full ' + path.basename(f) + '  ' + fs.statSync(f).size + ' B');
      return f;
    });
}
/** PNG 的宽高（IHDR 固定在偏移 16..24）—— 用来验证 clip 真按元素尺寸出图。 */
function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

/** 逐元素 clip 截图：一次拿到「恰好是那个元素」的 2× 图，不需要外部裁剪。
 *  captureBeyondViewport 允许元素超出视口（对局设置卡 ~1189px 高 > 视口 1000px，靠它）。 */
function clipShot(cdp, name, x, y, w, h) {
  return retry(function () {
    return cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: x, y: y, width: w, height: h, scale: 1 },       // 坑④：scale 必须 1
    }, 60000);
  }, 2, 'clip/' + name).then(function (r) {
    var d = r && r.result && r.result.data;
    if (!d) throw new Error('no clip data for ' + name);
    var buf = Buffer.from(d, 'base64'), sz = pngSize(buf);
    fs.writeFileSync(path.join(LANGD, name + '.png'), buf);
    var want = { w: Math.round(w * DSF), h: Math.round(h * DSF) };
    var okpix = Math.abs(sz.w - want.w) <= 2 && Math.abs(sz.h - want.h) <= 2;
    log('    clip ' + name + '.png  ' + sz.w + 'x' + sz.h + (okpix ? '' : '  !!MISMATCH want ' + want.w + 'x' + want.h));
    return okpix;
  });
}

/** 在一个已连好的 target 上跑完一组 pass。
 *  ★ 2026-10-09：支持只跑指定 pass —— 环境变量 GB_SLICE_ONLY 给一个 tag 子串（或逗号分隔
 *    的多个子串），只跑匹配的那些。改一处界面（例如复盘栏某一颗键的文案）时不必整套重采
 *    （整套 main 有 12 个 pass，还要等演示局面载入 + 计算，几分钟起步）。 */
function runPasses(cdp, passes, kind) {
  var only = String(process.env.GB_SLICE_ONLY || '').split(',').filter(function (s) { return s.trim(); });
  if (only.length) {
    passes = passes.filter(function (p) {
      return only.some(function (k) { return p.tag.indexOf(k.trim()) >= 0; });
    });
    log('GB_SLICE_ONLY=' + only.join(',') + '  →  只跑 ' + passes.length + ' 个 pass');
  }
  var chain = Promise.resolve();
  passes.forEach(function (p) {
    chain = chain
      .then(function () {
        log('pass ' + p.tag + '  ' + p.vw + 'x' + p.vh + '@' + DSF + '  mode=' + p.mode);
        return cdp.send('Emulation.setDeviceMetricsOverride',
          { width: p.vw, height: p.vh, deviceScaleFactor: DSF, mobile: false }, 15000);
      })
      .then(function () { return sleep(650); })
      .then(function () { return evalJs(cdp, PREP_MODE(p.mode, p.reveal)); })
      // 把目标滚进停靠栏可视区（否则 overflow 裁掉、根本没画，裁出来是纯白）
      .then(function () {
        if (!p.scroll) return null;
        return evalJs(cdp, '(function(){ var e = document.querySelector(' + JSON.stringify(p.scroll) + ');' +
          ' if (!e) return "no-scroll-target";' +
          ' e.scrollIntoView({ block: "center", inline: "nearest" });' +
          ' return "scrolled"; })()')
          .then(function (v) { log('    scroll: ' + v + '  ' + p.scroll); });
      })
      .then(function () { return sleep(kind === 'main' && p.tag === 'm-basic' ? 2000 : 900); })
      .then(function () { return evalJs(cdp, measureFn(p.items)); })
      .then(function (v) {
        fs.writeFileSync(path.join(FULLD, '_' + p.tag + '_rects.json'), String(v));
        var m = JSON.parse(v);
        log('    viewport ' + m.iw + 'x' + m.ih + '  dpr=' + Number(m.dpr).toFixed(2));
        m.slices.forEach(function (s) {
          log('    ' + (s.miss ? 'MISS ' : 'rect ') + s.name.padEnd(9) +
              (s.miss ? s.sel : (s.x + ',' + s.y + '  ' + s.w + 'x' + s.h + '   ' + s.vis)));
        });
        return shot(cdp, p.tag).then(function () {
          var c2 = Promise.resolve();
          m.slices.forEach(function (s) {
            if (s.miss) return;
            c2 = c2.then(function () { return clipShot(cdp, s.name, s.x, s.y, s.w, s.h); });
          });
          return c2;
        });
      });
  });
  return chain;
}

// ---------------------------------------------------------------------- 主流程
function main() {
  [OUTD, FULLD, LANGD].forEach(function (d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT + ' --no-sandbox',
  });
  killTrainer();
  var child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env: env });
  child.unref();
  log('spawned pid=' + child.pid + '  want=' + WANT + '  lang=' + LANG);

  var MAIN_T = function (t) {
    return t.type === 'page' && /calc\.html/.test(t.url) &&
           t.url.indexOf('link=1') < 0 && t.url.indexOf('rv=1') < 0 && t.url.indexOf('vis=1') < 0;
  };
  var LINK_T = function (t) { return t.type === 'page' && /link=1/.test(t.url); };

  var cdps = [];
  sleep(2900)
    // ---- 主窗：先定语言（连线窗会继承），再逐 pass ----
    .then(function () {
      if (WANT === 'link') return null;
      return pollTargets(MAIN_T, 45000)
        .then(function (t) { log('main target: ' + t.url); return sleep(2200).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
        .then(function (cdp) {
          cdps.push(cdp);
          return cdp.send('Page.enable', {})
            .then(function () { return cdp.send('Runtime.enable', {}); })
            .then(function () { return cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: DSF, mobile: false }, 15000); })
            .then(function () { return sleep(800); })
            .then(function () { return evalJs(cdp, PREP_LANG()); })
            .then(function (v) { log('lang btn -> ' + v + '  (want "' + WANT_BTN + '")'); return sleep(700); })
            .then(function () { return evalJs(cdp, PREP_DEMO()); })
            .then(function (v) { log('demo: ' + v); return sleep(1500); })
            .then(function () { return evalJs(cdp, PREP_CALC()); })
            .then(function (v) { log('calc: ' + v); return sleep(2600); })
            .then(function () { return runPasses(cdp, MAIN_PASSES, 'main'); });
        });
    })
    // ---- 连线窗：先在主窗点「连线」把窗开出来（此时语言已是 LANG）----
    .then(function () {
      if (WANT === 'main') return null;
      var mainCdp = cdps[0];
      var opener = mainCdp
        ? Promise.resolve(mainCdp)
        : pollTargets(MAIN_T, 45000).then(function (t) { return wsConnect(t.webSocketDebuggerUrl); })
            .then(function (c) {
              cdps.push(c);
              return c.send('Page.enable', {})
                .then(function () { return c.send('Runtime.enable', {}); })
                .then(function () { return c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: DSF, mobile: false }, 15000); })
                .then(function () { return sleep(700); })
                .then(function () { return evalJs(c, PREP_LANG()); })
                .then(function (v) { log('lang btn -> ' + v + '  (want "' + WANT_BTN + '")'); return sleep(700); })
                // ⚠ 必须把 c 交出去：这里返回 evalJs 的结果会把字符串当 cdp 用，
                //   下一步就是 "Cannot read properties of undefined (reading 'send')"
                .then(function () { return c; });
            });
      return opener
        .then(function (c) { return evalJs(c, '(function(){ var b=document.getElementById("btn_link"); if(!b) return "no-btn"; b.click(); return "clicked"; })()'); })
        .then(function (v) { log('openLink: ' + v); return sleep(400); });
    })
    .then(function () {
      if (WANT === 'main') return null;
      return pollTargets(LINK_T, 45000)
        .then(function (t) { log('link target: ' + t.url); return sleep(3200).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
        .then(function (cdp) {
          cdps.push(cdp);
          return cdp.send('Page.enable', {})
            .then(function () { return cdp.send('Runtime.enable', {}); })
            .then(function () { return runPasses(cdp, LINK_PASSES, 'link'); });
        });
    })
    .then(function () { cdps.forEach(function (c) { try { c.close(); } catch (e) {} }); log('done -> ' + LANGD); killTrainer(); setTimeout(function () { process.exit(0); }, 400); })
    .catch(function (e) { log('FAIL: ' + (e && e.message || e)); cdps.forEach(function (c) { try { c.close(); } catch (x) {} }); killTrainer(); setTimeout(function () { process.exit(1); }, 400); });
}

main();
