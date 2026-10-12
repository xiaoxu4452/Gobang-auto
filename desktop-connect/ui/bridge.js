/* Meter Gomoku Trainer - desktop overlay data bridge. Exposes page-facing APIs for board sync, engine analysis, balance-point suggestions and auto-move; the C++ host drives screen scanning and click injection. */


(function () {
  'use strict';

  var S = window.GB_S || (window.GB_S = {});

  var GB_VER = 'v4.39';
  var UI = window.GBUI || {};
  var N = 15;

  var SCAN_URL = 'http://127.0.0.1:8975/scan';
  var ANALYZE_URL = 'http://127.0.0.1:8964/api/analyze';
  var HASH_URL = 'http://127.0.0.1:8964/api/hash';
  
  var BALANCE_URL = 'http://127.0.0.1:8964/api/balance';

  var HOST = !!(window.chrome && window.chrome.webview && window.chrome.webview.addEventListener);

  var uiWarned = {};
  function ui(name, a, b) {
    var f = UI[name];
    if (typeof f !== 'function') return undefined;
    try { return f(a, b); } catch (e) {
      if (!uiWarned[name]) { uiWarned[name] = 1; console.warn('[bridge] UI.' + name + ' 失败：', e && e.message); }
      return undefined;
    }
  }
  function saveNow() { try { if (typeof UI.save === 'function') UI.save(); } catch (e) {} }
  function T(k) { try { return UI.T ? UI.T(k) : k; } catch (e) { return k; } }

  function tellHost(o) {
    try {
      var cv = window.chrome && window.chrome.webview;
      if (cv && cv.postMessage) cv.postMessage(JSON.stringify(o));
    } catch (e) {}
  }

  (function wrapStatusForDiag() {
    var orig = UI.setStatus;
    if (typeof orig !== 'function' || orig.__gbWrapped) return;
    var wrapped = function (html, tone) {
      try {
        var text = String(html == null ? '' : html)
          .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (text) tellHost({ type: 'status', text: text.slice(0, 160) });
      } catch (e) {}
      return orig.call(UI, html, tone);
    };
    wrapped.__gbWrapped = 1;
    UI.setStatus = wrapped;
  })();

  (function wrapLookForHost() {
    var FNS = ['applyDark', 'applyLang', 'applyOpacity', 'applyBlur'];
    function report() {
      try {
        tellHost({
          type: 'uiLook',
          dark: !!S.dark,
          lang: S.lang === 'en' ? 'en' : 'zh',
          opacity: (typeof S.opacity === 'number') ? S.opacity : 100,
          blur: (typeof S.blur === 'number') ? S.blur : 0,
        });
      } catch (e) {}
    }
    for (var i = 0; i < FNS.length; i++) {
      (function (name) {
        var orig = UI[name];
        if (typeof orig !== 'function' || orig.__gbWrapped) return;
        var w = function () { var r = orig.apply(UI, arguments); report(); return r; };
        w.__gbWrapped = 1;
        UI[name] = w;
      })(FNS[i]);
    }
    window.GB_REPORT_LOOK = report;
  })();

  var COL_SCREEN = '#2FD8FF';   
  var COL_BOARD = '#8B5CF6';    
  var frame = document.getElementById('__gb_frame');
  var fctx = frame.getContext('2d');
  
  if (HOST) frame.style.display = 'none';
  var boardRect = null;         
  var boardGeo = null;          

  function resizeCanvas() {
    bootStep('2a resizeCanvas 进入');
    
    if (HOST) { bootStep('2a0 宿主模式跳过页面画布'); return; }
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth, h = window.innerHeight;
    bootStep('2b 尺寸 w=' + w + ' h=' + h + ' dpr=' + dpr);
    frame.width = Math.round(w * dpr);
    frame.height = Math.round(h * dpr);
    bootStep('2c canvas 位图已设 ' + frame.width + 'x' + frame.height);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bootStep('2d setTransform 完成');
    paintFrame();
    bootStep('2e paintFrame 完成');
  }

  function drawLBracket(x0, y0, x1, y1, color, arm, thick, dash) {
    var w = x1 - x0, h = y1 - y0;
    var a = Math.min(arm, w / 2.4, h / 2.4);
    fctx.save();
    fctx.strokeStyle = color;
    fctx.lineCap = 'butt';
    fctx.globalAlpha = 0.55;
    fctx.lineWidth = 1;
    fctx.setLineDash(dash);
    fctx.beginPath();
    fctx.moveTo(x0 + a, y0); fctx.lineTo(x1 - a, y0);
    fctx.moveTo(x0 + a, y1); fctx.lineTo(x1 - a, y1);
    fctx.moveTo(x0, y0 + a); fctx.lineTo(x0, y1 - a);
    fctx.moveTo(x1, y0 + a); fctx.lineTo(x1, y1 - a);
    fctx.stroke();
    fctx.setLineDash([]);
    fctx.globalAlpha = 1;
    fctx.lineWidth = thick;
    fctx.shadowColor = color;
    fctx.shadowBlur = thick * 2.4;
    fctx.beginPath();
    fctx.moveTo(x0, y0 + a); fctx.lineTo(x0, y0); fctx.lineTo(x0 + a, y0);
    fctx.moveTo(x1 - a, y0); fctx.lineTo(x1, y0); fctx.lineTo(x1, y0 + a);
    fctx.moveTo(x1, y1 - a); fctx.lineTo(x1, y1); fctx.lineTo(x1 - a, y1);
    fctx.moveTo(x0 + a, y1); fctx.lineTo(x0, y1); fctx.lineTo(x0, y1 - a);
    fctx.stroke();
    fctx.restore();
  }

  function paintFrame() {
    if (HOST || !fctx) return;    
    var w = window.innerWidth, h = window.innerHeight;
    fctx.clearRect(0, 0, w, h);
    if (S.hideFrame) return;
    var m = 2;
    var arm = Math.max(64, Math.min(132, Math.min(w, h) * 0.075));
    drawLBracket(m, m, w - m, h - m, COL_SCREEN, arm, 3, [6, 9]);
    if (boardRect) {
      var r = boardRect, e = 6;
      
      drawLBracket(r.x0 - e, r.y0 - e, r.x1 + e, r.y1 + e, COL_BOARD,
        Math.max(26, Math.min(60, Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.17)), 3.4, [5, 7]);
    }
  }
  window.addEventListener('resize', function () { resizeCanvas(); reportPanelRect(); });

  var panel = document.getElementById('__gb_panel');

  var hdrEl = document.getElementById('__gb_hdr');

  function applyMaxHeight() {
    if (!panel) return;
    try {
      var avail = (window.screen && window.screen.availHeight) || 0;
      if (avail < 200) return;                    
      var want = Math.max(240, Math.round(avail + 240)) + 'px';
      if (panel.style.maxHeight !== want) panel.style.maxHeight = want;
    } catch (e) {}
  }

  function reportPanelRect() {
    if (!panel) return;
    applyMaxHeight();
    var r = panel.getBoundingClientRect();
    var hidden = (r.width < 4) || (panel.style.display === 'none');
    
    var hdrH = 34;
    try {
      if (hdrEl) { var hr = hdrEl.getBoundingClientRect(); if (hr.height >= 16 && hr.height <= 120) hdrH = hr.height; }
    } catch (e) {}
    
    var dpr = window.devicePixelRatio || 1;
    
    var dragW = 0, btnX = '';
    try {
      if (hdrEl) {
        var hr2 = hdrEl.getBoundingClientRect();
        var ctrls = hdrEl.querySelectorAll('button,select,input,[role="button"]');
        var minLeft = Infinity, parts = [];
        for (var i = 0; i < ctrls.length; i++) {
          var cr = ctrls[i].getBoundingClientRect();
          if (cr.width <= 0) continue;
          if (cr.left < minLeft) minLeft = cr.left;
          
          var l = Math.max(0, Math.round(cr.left - r.left - 2));
          var rr = Math.round(cr.right - r.left + 2);
          parts.push(l + ':' + rr);
        }
        dragW = (minLeft === Infinity)
          ? Math.max(40, hr2.width - 8)
          : Math.max(40, minLeft - r.left - 4);
        parts.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
        btnX = parts.join(',');
      }
    } catch (e) {}
    
    var hNat = 0, hMin = 0;
    try {
      var bodyEl = document.getElementById('__gb_body');
      var barEl = document.getElementById('__gb_bottombar');
      var hdrPx = hdrEl ? hdrEl.offsetHeight : 0;
      var barPx = barEl ? barEl.offsetHeight : 0;
      if (bodyEl && bodyEl.scrollHeight > 0) hNat = hdrPx + bodyEl.scrollHeight;
      
      var hashLbl = bodyEl ? bodyEl.querySelector('[data-i18n="hash"]') : null;
      var hashRow = (hashLbl && hashLbl.closest) ? hashLbl.closest('.__gb_row') : null;
      if (hashRow) {
        hMin = hdrPx + hashRow.offsetTop + hashRow.offsetHeight + barPx;
      } else if (bodyEl) {
        hMin = hdrPx + Math.round(bodyEl.scrollHeight * 0.45);   
      }
    } catch (e) {}
    var cv = window.chrome && window.chrome.webview;
    if (cv && cv.postMessage) {
      cv.postMessage(JSON.stringify({
        type: 'panelRect',
        w: Math.round(r.width), h: Math.round(r.height),
        hdrH: Math.round(hdrH), dpr: Math.round(dpr * 1000) / 1000,
        dragW: Math.round(dragW), btnX: btnX, hidden: hidden,
        hNat: Math.round(hNat), hMin: Math.round(hMin),
      }));
    }
  }

  try {
    if (hdrEl) {
      hdrEl.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        if (!HOST) return;                              
        
        var t = ev.target;
        if (t && t.closest && t.closest('button,select,input,textarea,a,[role="button"]')) return;
        if (ev.preventDefault) ev.preventDefault();     
        tellHost({ type: 'dragStart' });
      });
    }
  } catch (e) {}

var lastBoardKey = '';
var emptyStreak = 0;                 

var pendingKey = '';
var pendingN = 0;
var STABLE_FRAMES = 2;               
var forceScan = false;               
var busy = false, engineBusy = false;
var analyzeRetryTimer = null, analyzeRetryCount = 0;

var pendingEvalKey = null;
var analyzeRetryTimer = null;          

var lastBl = [], lastWh = [];        
var lastAdoptBl = [], lastAdoptWh = [];   

var balBusy = false;

var LBAL = {
  zh: {
    bal1: '平衡一手', bal2: '平衡两手',
    bal1ing: '平衡一手计算中（引擎官方平衡迭代）…', bal2ing: '平衡两手计算中（五手两打）…',
    balSwap: '引擎判定：此际应当换手（SWAP）——当前没有比换手更优的平衡点',
    balNone: '引擎未返回平衡点（盘面可能已无可选点）',
    balFail: '平衡选点失败：', balDone: '平衡点：',
    balPreview: '浏览器预览模式不画圈',
    
    balWon: '盘面已有成五点（%1）—— 必胜局面没有平衡可言，以上是引擎直接给出的必胜点',
    
    adBtn: '自动落子', swBalBtn: '交换平衡点', swEvalBtn: '交换评估',
    
    adOn: '自动落子已开启（盯推荐第一点）', adOff: '自动落子已关闭',
    
    adOffNewGame: '新的一局开始 —— 自动落子已关闭（需要时请重新点开）',
    
    engineBusyTimeout: '引擎等待超时（同一通道上还有别的算路在跑）——本次已放弃，盘面一变会自动重算',
    analyzeRetry: '引擎正忙（平衡/交换计算中）——评估稍候自动重试，无需操作',
    analyzeSlow: '引擎响应超时——评估稍候自动重试，无需操作',
    
    swBalNeedAd: '未开启自动落子：请先开启「自动落子」自动摆完平衡点，或对照圆圈在棋盘上手动落子',
    adBusyQueue: '平衡点摆点中，请稍候…',
    engineUnreachable: '连不上本地引擎（:8964）—— 桌面助手正在自动重启它，通常几秒内恢复；反复出现请检查安全软件是否拦截',
    
    swBalFilled: '（其中 %1 点为估算补位，引擎未在 4.5 秒内返回）',
    adCount: '落子次数：', adFired: '自动落子：', adDropped: '已自动落下',
    adRetry: 'PostMessage 未生效，改用系统级点击重试…',
    adRetryRound: '三种点击方式都没等到棋盘回帧，正在重试第 %1 轮（请让目标窗口保持在前台、不要最小化）…',
    adGiveUp: '自动落子连续 3 轮未生效，已暂停（请确认目标窗口在前台；若是自绘/防外挂窗口，先手动点一次再开）',
    adPtUnreachable: '这一手没落上（目标窗口是否在前台？）—— 等棋盘变化自动重试',
    
    swBalEmpty: '空盘交换平衡计算中（1 白 + 2 黑三点组）…', swBalPair: '交换平衡计算中（1 白 + 1 黑）…',
    swBalStage: '交换平衡点只在空盘（两黑一白 3 点）或已有 3 子（一黑一白 2 点）时可用；当前手数不在交换窗口',
    swBalDone: '交换平衡点已标出（浅蓝=白、浅紫=黑）：', swPlacing: '自动摆点：第 %1/%2 个（',
    swPlaced: '交换平衡摆子完成（%1 个点已自动落完）',
    swSwapNow: '引擎判定：此际应当换手（SWAP）——不摆子，直接换',
    swEvaling: '交换评估计算中…', swEvalBlack: '引擎评估：黑优（%1）—— 建议选黑更有优势',
    swEvalWhite: '引擎评估：白优（%1）—— 建议选白更有优势', swEvalEven: '引擎评估：两边接近（%1）—— 选黑选白差别不大',
    
    swAdvB: '黑优', swAdvW: '白优',
    swEvalEmpty: '棋盘上还没有子 —— 等对手摆完（或先点「交换平衡点」）再评估',
    swEvalFail: '交换评估失败：', swEvalDone: '交换评估完成：',
    swEvalLate: '已过交换窗口（超过 5 手）—— 交换评估只在开局阶段有意义',
  },
  en: {
    bal1: 'Balance move', bal2: 'Balance pair',
    bal1ing: 'Balancing (official engine iteration)…', bal2ing: 'Balancing pair (swap-two)…',
    balSwap: 'Engine says: SWAP now — no more balanced point to place',
    balNone: 'No balanced point returned (board may be exhausted)',
    balFail: 'Balance failed: ', balDone: 'Balance points: ',
    balPreview: 'no circles in browser preview',
    balWon: 'Board already has a winning five (%1) — no balance exists in a won position; these are the engine\'s direct winning points',
    
    adBtn: 'Auto drop', swBalBtn: 'Swap balance point', swEvalBtn: 'Swap eval',
    
    adOn: 'Auto-drop ON (watching top recommendation)', adOff: 'Auto-drop OFF',
    
    adOffNewGame: 'New game started — auto-drop is OFF (click it again when you need it)',
    engineBusyTimeout: 'Engine timed out (another search is still running on the same lane) — gave up this time; it re-runs on the next board change',
    analyzeRetry: 'Engine busy (balance/swap computing) — evaluation retries automatically in a moment',
    analyzeSlow: 'Engine response timed out — evaluation retries automatically in a moment',
    swBalNeedAd: 'Auto-drop is off: turn on Auto-drop to place the balance points automatically, or place them manually on the board',
    adBusyQueue: 'Placing balance points — please wait…',
    engineUnreachable: "Can't reach the local engine (:8964) — restarting it automatically; it usually recovers within seconds. If this keeps happening, check your antivirus",
    swBalFilled: ' (%1 point(s) estimated — engine did not answer within 4.5s)',
    adCount: 'Click count: ', adFired: 'Auto-drop: ', adDropped: 'dropped automatically',
    adRetry: 'PostMessage ignored — retrying with real click…',
    adRetryRound: 'No board change confirmed through any click method — retrying round %1 (keep the target window focused and visible)…',
    adGiveUp: 'Auto-drop failed 3 rounds, paused (make sure the target window is in the foreground; for custom-drawn/anti-macro windows, click once by hand first)',
    adPtUnreachable: 'Move did not land (is the target window in front?) — will retry when the board changes',
    
    swBalEmpty: 'Balancing 3-point swap set (1 white + 2 black)…', swBalPair: 'Balancing swap pair (1 white + 1 black)…',
    swBalStage: 'Swap balance only works on an empty board (2 black + 1 white, 3 points) or after 3 stones (a black-white pair, 2 points); the current move count is outside the swap window',
    swBalDone: 'Swap balance points marked (light blue=white, light purple=black): ', swPlacing: 'Auto-placing point %1/%2 (',
    swPlaced: 'Swap placement finished (%1 points dropped)',
    swSwapNow: 'Engine says: SWAP now — skip placing, take the swap',
    swEvaling: 'Evaluating swap…', swEvalBlack: 'Engine: Black is better (%1) — taking Black is advised',
    swEvalWhite: 'Engine: White is better (%1) — taking White is advised', swEvalEven: 'Engine: nearly even (%1) — either side is fine',
    swAdvB: 'Black is better', swAdvW: 'White is better',
    swEvalEmpty: 'Board is empty — place stones (or run Swap Balance) first',
    swEvalFail: 'Swap evaluation failed: ', swEvalDone: 'Swap evaluation: ',
    swEvalLate: 'Swap window has passed (over 5 moves) — swap evaluation only matters in the opening',
  }
};
function LT(k) { var d = LBAL[S.lang === 'en' ? 'en' : 'zh'] || LBAL.zh; return d[k] || k; }

  function resetForEmpty() {
    S.history = []; S.myEval = ''; S.lastStat = null; S.candCache = [];
    lastBest = null; lastMainC0 = null;
    balOff();                                 
    ui('drawChart');
  }

  function boardKey(bl, wh) {
    function fmt(a) { return a.map(function (p) { return p.x + ',' + p.y; }).sort().join(';'); }
    return bl.length + ':' + fmt(bl) + '|' + wh.length + ':' + fmt(wh);
  }
  
  function deltaStones(a, b) {
    var kb = {};
    for (var i = 0; i < b.length; i++) kb[b[i].x + ',' + b[i].y] = 1;
    var out = [];
    for (var j = 0; j < a.length; j++) {
      var k = a[j].x + ',' + a[j].y;
      if (!kb[k]) out.push(k);
    }
    return out;
  }

  function fetchJSON(url, body, timeoutMs) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeoutMs || 6000);
    var opt = { cache: 'no-store', signal: ctl.signal };
    if (body) {
      opt.method = 'POST';
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) { return r.json(); })
      .finally(function () { clearTimeout(t); });
  }

  var mainChain = Promise.resolve();
  function onMainLane(fn) {
    var run = mainChain.then(fn, fn);              
    mainChain = run.then(function () {}, function () {});
    return run;
  }

  var lastDepsPing = 0;
  function pingEnsureDeps() {
    if (!HOST) return;
    var now = Date.now();
    if (now - lastDepsPing < 5000) return;
    lastDepsPing = now;
    try { tellHost({ type: 'ensureDeps' }); } catch (ePing) {}
  }
  function errText(e) {
    var m = (e && e.message) ? e.message : String(e);
    
    if (isWaitTimeout(e)) return LT('engineBusyTimeout');
    if (e instanceof TypeError || /failed to fetch|fetch failed|networkerror|load failed/i.test(m)) {
      pingEnsureDeps();
      return LT('engineUnreachable');
    }
    if (/connection lost/i.test(m)) { pingEnsureDeps(); return LT('engineUnreachable'); }
    return m;
  }

  function isWaitTimeout(e) {
    if (e && e.name === 'AbortError') return true;
    var m = String((e && e.message) || e || '');
    return /abort|ws timeout/i.test(m);
  }

  var WS_URL = 'ws://127.0.0.1:8964/ws';
  var wsSock = null, wsSeq = 0, wsPending = {};
  var wsWant = false, wsRetryTimer = null, wsRetryDelay = 800;
  var wsToldDown = false, wsHealthFail = 0, wsHeartTimer = null;

  function wsConnect() {
    if (STANDALONE) return;   
    if (!window.WebSocket) return;
    wsWant = true;
    if (wsSock) { try { wsSock.onclose = null; wsSock.close(); } catch (eOld) {} wsSock = null; }
    var s;
    try { s = new WebSocket(WS_URL); } catch (eNew) { wsScheduleRetry(); return; }
    wsSock = s;
    s.onopen = function () {
      wsRetryDelay = 800; wsHealthFail = 0;
      if (wsToldDown) {                       
        wsToldDown = false;
        ui('setStatus', '<span style="color:#1e8e3e">' +
          (S.lang === 'en' ? 'Engine hard-link restored ✓' : '引擎硬连接已恢复 ✓') + '</span>');
      }
      wsStartHeart();
    };
    s.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (eParse) { return; }
      if (m.seq != null && wsPending[m.seq]) {
        var p = wsPending[m.seq]; delete wsPending[m.seq];
        clearTimeout(p.t);
        if (m.error != null) p.reject(new Error(m.error));
        else p.resolve(m.result);
      }
    };
    s.onclose = function () {
      if (wsSock !== s) return;               
      wsSock = null;
      wsFailAllPending(new Error('engine connection lost'));
      if (!wsWant) return;
      if (!wsToldDown) { wsToldDown = true; pingEnsureDeps(); }
      wsScheduleRetry();
    };
    s.onerror = function () { try { s.close(); } catch (eErr) {} };
  }
  function wsScheduleRetry() {
    if (!wsWant || wsRetryTimer) return;
    wsRetryTimer = setTimeout(function () { wsRetryTimer = null; wsConnect(); }, wsRetryDelay);
    wsRetryDelay = Math.min(5000, wsRetryDelay * 2);
  }
  function wsFailAllPending(err) {
    for (var k in wsPending) {
      clearTimeout(wsPending[k].t);
      wsPending[k].reject(err);
      delete wsPending[k];
    }
  }
  function wsStartHeart() {
    if (wsHeartTimer) return;
    wsHeartTimer = setInterval(function () {
      if (!wsReady()) return;
      wsCall('health', {}, 4000).then(function (r) {
        if (!r) { wsHealthFail++; if (wsHealthFail >= 2) { wsHealthFail = 0; try { wsSock.close(); } catch (eH) {} } }
        else wsHealthFail = 0;
      }).catch(function () {
        
        wsHealthFail++;
        if (wsHealthFail >= 2) { wsHealthFail = 0; try { wsSock && wsSock.close(); } catch (eH2) {} }
      });
    }, 3000);
  }
  function wsReady() { return !!(wsSock && wsSock.readyState === 1); }
  
  var STANDALONE = (typeof GB_STANDALONE !== 'undefined') && !!GB_STANDALONE;
  var NATENG = null;
  function natEng() {
    if (NATENG) return NATENG;
    NATENG = (function () {
      var SIZE = N;                              
      function engFetch(path, body) {
        var opt = { cache: 'no-store' };
        if (body !== undefined) { opt.method = 'POST'; opt.body = body; }
        return fetch(path, opt).then(function (r) { return r.json(); });
      }
      function engCmd(lane, text) { return engFetch('/engine/cmd?lane=' + lane, text); }
      function engEnsure(lane) { return engFetch('/engine/ensure?lane=' + lane, ''); }
      function engStatus() { return engFetch('/engine/status'); }

      function parseK(v) {
        v = String(v).trim();
        var m = v.match(/^([\d.]+)\s*([kKmM])?$/);
        if (!m) return 0;
        var n = parseFloat(m[1]);
        if (m[2] === 'k' || m[2] === 'K') return Math.round(n * 1000);
        if (m[2] === 'm' || m[2] === 'M') return Math.round(n * 1000000);
        return Math.round(n);
      }
      function countStones(board) {
        var n = 0;
        for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) if (board[y][x] !== 0) n++;
        return n;
      }
      
      function applySideToMove(out, side) {
        if (side !== 1 && side !== 2) return out;
        if (!out.length) return out;
        var wantLast = 3 - side;
        if (out[out.length - 1][2] === wantLast) return out;
        var idx = -1;
        for (var i = out.length - 1; i >= 1; i--) { if (out[i][2] === wantLast) { idx = i; break; } }
        if (idx < 0) return out;
        var m = out.splice(idx, 1)[0];
        out.push(m);
        return out;
      }
      function toEngineMoveList(board, moveList, side) {
        var black = [], white = [];
        for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
          if (board[y][x] === 1) black.push([x, y]);
          else if (board[y][x] === 2) white.push([x, y]);
        }
        var usableList = Array.isArray(moveList) && moveList.length > 0;
        function mkPick() { return { used: {} }; }
        var pickState = usableList ? mkPick() : null;
        function pick(color) {
          if (!usableList) return null;
          for (var mi = 0; mi < moveList.length; mi++) {
            var m = moveList[mi];
            if (m && typeof m.x === 'number' && typeof m.y === 'number' &&
                board[m.y] && board[m.y][m.x] === color) {
              var key = m.x + ',' + m.y;
              if (!pickState.used[key]) { pickState.used[key] = 1; return [m.x, m.y]; }
            }
          }
          return null;
        }
        var bs = black.slice(), ws = white.slice();
        var seq = [];
        var maxLen = Math.max(bs.length, ws.length);
        for (var i2 = 0; i2 < maxLen; i2++) {
          if (i2 < bs.length) seq.push(1);
          if (i2 < ws.length) seq.push(2);
        }
        var out = [];
        for (var si = 0; si < seq.length; si++) {
          var color = seq[si];
          var pos = usableList ? pick(color) : null;
          if (!pos) pos = (color === 1 ? bs.shift() : ws.shift());
          else {
            var src = (color === 1 ? bs : ws);
            for (var k = 0; k < src.length; k++) if (src[k][0] === pos[0] && src[k][1] === pos[1]) { src.splice(k, 1); break; }
          }
          if (!pos) continue;
          out.push([pos[0], SIZE - 1 - pos[1], color]);
        }
        return applySideToMove(out, side);
      }
      
      function parseLine(line, pvs) {
        if (!line || !line.trim()) return;
        var i = line.indexOf(' ');
        if (i === -1) {
          var t0 = line.trim();
          var pairs0 = t0.match(/\d+,\d+/g);
          if (pairs0 && pairs0.length) { var p0 = pairs0[0].split(',').map(Number); pvs.__final = [p0[0], SIZE - 1 - p0[1]]; }
          return;
        }
        var head = line.substring(0, i);
        var tail = line.substring(i + 1);
        if (head === 'INFO') {
          var j = tail.indexOf(' ');
          var key = j === -1 ? tail : tail.substring(0, j);
          var val = j === -1 ? '' : tail.substring(j + 1);
          if (key === 'PV') {
            if (val !== 'DONE') { pvs.__cur = +val; if (!pvs[pvs.__cur]) pvs[pvs.__cur] = {}; }
          } else if (key === 'NUMPV') { pvs.__numpv = +val; }
          else if (key === 'TOTALTIME') { pvs.__totaltime = +val; }
          else if (key === 'TOTALNODES') { pvs.__totalnodes = +val; }
          else if (key === 'SPEED') { pvs.__speed = +val; }
          else if (pvs.__cur >= 0 && pvs[pvs.__cur]) {
            if (key === 'DEPTH') pvs[pvs.__cur].depth = +val;
            else if (key === 'SELDEPTH') pvs[pvs.__cur].seldepth = +val;
            else if (key === 'NODES') pvs[pvs.__cur].nodes = +val;
            else if (key === 'EVAL') pvs[pvs.__cur].eval = val;
            else if (key === 'WINRATE') pvs[pvs.__cur].winrate = parseFloat(val);
            else if (key === 'BESTLINE') pvs[pvs.__cur].bestline = (val.match(/\d+,\d+/g) || []).map(function (s) { var p = s.split(',').map(Number); return [p[0], SIZE - 1 - p[1]]; });
          }
        } else if (head === 'FORBID') {
          var pts = parseForbidLine(line);
          if (pts && pts.length) {
            if (!pvs.__forbid) pvs.__forbid = [];
            for (var fi = 0; fi < pts.length; fi++) pvs.__forbid.push(pts[fi]);
          }
        } else if (head === 'MESSAGE') {
          if (tail.indexOf('REALTIME') === 0) {
            var r = tail.split(' ');
            if (r.length >= 3 && tail.indexOf('REALTIME BEST') === 0) {
              var c = r[2].split(',').map(Number);
              if (c.length === 2) pvs.__best = [c[0], SIZE - 1 - c[1]];
            }
          } else {
            var mpv = tail.match(/^\((\d+)\)\s+([^\s|]+)\s*\|\s*(\d+)(?:-(\d+))?\s*\|\s*(.*)$/);
            if (mpv) {
              var pvi = +mpv[1] - 1;
              pvs.__cur = pvi;
              if (!pvs[pvi]) pvs[pvi] = {};
              var pv = pvs[pvi];
              pv.eval = mpv[2];
              pv.depth = +mpv[3];
              if (mpv[4]) pv.seldepth = +mpv[4];
              var bl = [];
              var parts = mpv[5].trim().split(/\s+/);
              for (var ti = 0; ti < parts.length; ti++) {
                var mc = parts[ti].match(/^([A-Za-z])(\d+)$/);
                if (mc) bl.push([mc[1].toUpperCase().charCodeAt(0) - 65, (+mc[2]) - 1]);
              }
              pv.bestline = bl;
            } else {
              var ms = tail.match(/^Depth\s+(\d+)(?:-(\d+))?\s*\|\s*Eval\s+([^\s|]+)\s*\|\s*Time\s+[\d.]+\s*ms\s*\|\s*(.+)$/);
              if (ms) {
                var bl2 = [];
                var parts2 = ms[4].trim().split(/\s+/);
                for (var tj = 0; tj < parts2.length; tj++) {
                  var mc2 = parts2[tj].match(/^([A-Za-z])(\d+)$/);
                  if (mc2) bl2.push([mc2[1].toUpperCase().charCodeAt(0) - 65, (+mc2[2]) - 1]);
                }
                if (bl2.length) {
                  if (!pvs[0]) pvs[0] = {};
                  var newDepth = +ms[1];
                  if (!pvs[0].bestline || !pvs[0].bestline.length || (pvs[0].depth || 0) <= newDepth) {
                    pvs[0].bestline = bl2;
                    pvs[0].eval = ms[3];
                    pvs[0].depth = newDepth;
                    if (ms[2]) pvs[0].seldepth = +ms[2];
                  }
                }
              }
              var spd = tail.match(/^Speed\s+([\d.]+[kKmM]?)\s*\|\s*Depth\s+(\d+)(?:-(\d+))?\s*\|\s*Eval\s+([^\s|]+)\s*\|\s*Node\s+([\d.]+[kKmM]?)\s*\|\s*Time\s+[\d.]+\s*ms/i);
              if (spd) {
                pvs.__speed = parseK(spd[1]);
                pvs.__totalnodes = parseK(spd[5]);
                if (pvs[0] && !pvs[0].eval) pvs[0].eval = spd[4];
                if (pvs[0] && !pvs[0].depth) pvs[0].depth = +spd[2];
              }
            }
          }
        } else if (head === 'best') {
          var cc = tail.split(/\s+/).map(Number);
          if (cc.length >= 2) pvs.__best = [cc[0], SIZE - 1 - cc[1]];
        } else if (/^\d+,\d+$/.test(head) && /^\d+,\d+$/.test(tail)) {
          var p1 = head.split(',').map(Number);
          pvs.__final = [p1[0], SIZE - 1 - p1[1]];
        }
      }
      function parseForbidLine(line) {
        var t = String(line || '');
        var m = t.match(/^\s*FORBID\b(.*)$/i);
        if (!m) return null;
        var rest = m[1].trim();
        if (!rest || rest === '.') return [];
        var body0 = rest.replace(/\.\s*$/, '').replace(/\s+/g, '');
        var digits = body0.replace(/[^0-9]/g, '');
        var out = [];
        for (var i = 0; i + 4 <= digits.length; i += 4) {
          var x = parseInt(digits.slice(i, i + 2), 10);
          var y = parseInt(digits.slice(i + 2, i + 4), 10);
          if (Number.isNaN(x) || Number.isNaN(y)) continue;
          if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
          out.push([x, SIZE - 1 - y]);
        }
        return out;
      }
      function parseBalanceLine(line) {
        var t = String(line || '').trim();
        if (/^SWAP$/i.test(t)) return { swap: true, pts: [] };
        var m = t.match(/^(?:\d{1,2},\d{1,2})(?:\s+\d{1,2},\d{1,2})*$/);
        if (!m) return null;
        var pts = t.split(/\s+/).map(function (s) {
          var xy = s.split(',').map(Number);
          var ex = xy[0], ey = xy[1];
          if (!(ex >= 0 && ex < SIZE && ey >= 0 && ey < SIZE)) return null;
          return [ex, SIZE - 1 - ey];
        });
        if (pts.some(function (p) { return p === null; })) return null;
        return { swap: false, pts: pts };
      }
      
      var OUTBUF_CAP = 262144;
      function makeLane(name) {
        var lane = {
          name: name, outBuf: '', captureLine: null,
          tail: Promise.resolve(), ready: false, waiters: [],
          engineGone: false, alive: false, since: 0, gen: 0,
          bootThreads: 0, curThreads: 0, mayPonder: false, inSearch: false,
        };
        
        lane.pump = setInterval(function () {
          engFetch('/engine/out?lane=' + name + '&since=' + lane.since).then(function (r) {
            if (!r) return;
            
            var wasAlive = lane.alive;
            lane.alive = !!r.alive;
            if (wasAlive === true && lane.alive === false) {
              lane.gen = (lane.gen || 0) + 1;          
              lane.engineGone = true;
              lane.outBuf += '\n';                      
            } else if (wasAlive === false && lane.alive === true) {
              lane.engineGone = false;
              lane.outBuf = '';                         
              lane.captureLine = null;
              lane.since = 0;                           
              lane.dropped = 0;
              lane.inSearch = false;                    
              lane.mayPonder = false;
              lane.ready = false;                       
              lane.bootThreads = 0; lane.curThreads = 0;
              lane.bufTrim = 0;                         
            }
            if (r.dropped) lane.dropped = r.dropped;
            if (!lane.alive && !lane.engineGone && wasAlive !== false) {
              lane.engineGone = true;
              lane.outBuf += '\n';
            }
            lane.since = r.seq || lane.since;
            var ls = r.lines || [];
            for (var i = 0; i < ls.length; i++) {
              if (lane.captureLine && lane.captureLine(ls[i]) === true) continue;
              lane.outBuf += ls[i] + '\n';
            }
            
            if (lane.outBuf.length > OUTBUF_CAP) {
              var cut = lane.outBuf.length - OUTBUF_CAP;
              var nl = lane.outBuf.indexOf('\n', cut);
              lane.outBuf = (nl >= 0) ? lane.outBuf.slice(nl + 1) : lane.outBuf.slice(cut);
              lane.bufTrim = (lane.bufTrim || 0) + 1;
            }
          }).catch(function () {});
        }, 40);
        return lane;
      }
      var LANES = { main: makeLane('main'), sub: makeLane('sub'), fwd: makeLane('fwd') };
      function pickLane(name) { return (name === 'sub') ? LANES.sub : (name === 'fwd') ? LANES.fwd : LANES.main; }
      function laneSerial(lane, action) {
        var run = lane.tail.then(action, action);
        lane.tail = run.catch(function () {});
        return run;
      }
      
      var lanePending = { main: 0, sub: 0, fwd: 0 };
      function serialMerge(lane, key, action) {
        
        var crossTypes = (lane.name === 'main');
        var i, kk;
        for (kk in lane) {
          if (kk.slice(0, 3) !== '__m_') continue;
          var sameKey = (kk === '__m_' + key);
          if (sameKey || crossTypes) { try { lane[kk].cancelled = true; } catch (e) {} lane[kk] = null; }
        }
        var mark = { cancelled: false };
        lane['__m_' + key] = mark;
        var wrapped = function () {
          if (mark.cancelled) return { __cancelled: true };
          return action();
        };
        var run = laneSerial(lane, wrapped);
        lanePending[lane.name] = (lanePending[lane.name] || 0) + 1;
        var settle = function (v) {
          lanePending[lane.name] = Math.max(0, (lanePending[lane.name] || 1) - 1);
          if (lane['__m_' + key] === mark) lane['__m_' + key] = null;
          return v;
        };
        run = run.then(function (r) { return settle(r); },
                      function (e) { settle(); throw e; });
        return run;
      }
      function whenBootReady(lane) {
        if (lane.ready) return Promise.resolve();
        return new Promise(function (resolve) { lane.waiters.push(resolve); });
      }
      function armBootGuard(lane) {
        setTimeout(function () {
          if (lane.ready) return;
          lane.ready = true;
          var w = lane.waiters; lane.waiters = [];
          for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
        }, 8000);
      }
      function quiesceLane(lane, maxMs) {
        return new Promise(function (resolve) {
          var t0 = Date.now();
          var lastLen = -1, lastChange = Date.now();
          var timer = setInterval(function () {
            var len = lane.outBuf.length;
            if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
            else if (Date.now() - lastChange >= 120 || Date.now() - t0 > maxMs) { clearInterval(timer); resolve(); }
          }, 40);
        });
      }
      function preemptLane(lane, maxMs) {
        if (lane.name === 'main' && lane.mayPonder && !lane.inSearch) engCmd('main', 'STOP');
        return quiesceLane(lane, maxMs);
      }
      
      var PONDER_IDLE_MS = 20000;
      var ponderLogged = false;
      function armPonderPark(lane) {
        if (!lane || lane.name !== 'main') return;
        if (lane.ponderPark) { clearTimeout(lane.ponderPark); lane.ponderPark = null; }
        lane.ponderPark = setTimeout(function () {
          lane.ponderPark = null;
          if (lane.inSearch) return;                  
          try { engCmd('main', 'STOP'); } catch (eP1) {}
          try { engCmd('main', 'INFO PONDERING 0'); } catch (eP2) {}
          lane.mayPonder = false;
        }, PONDER_IDLE_MS);
      }
      
      var booted = false, booting = null;
      
      var engCPUs = 0, quotaLogged = false;
      
      var cfgThreads = 0, cfgHashMB = 0;   
      function fullCores() { return Math.max(2, (navigator.hardwareConcurrency || 4)); }
      
      function engBudget() {
        if (engCPUs > 0) return engCPUs;
        var all = fullCores();
        return cfgThreads > 0 ? Math.max(2, Math.min(cfgThreads, all)) : Math.max(2, all);
      }
      
      function boostThreads() { return engBudget(); }
      
      var cfgApplyBusy = false;
      function applyEngineCfgSoon() {
        if (cfgApplyBusy) return;
        if (!booted) return;                       
        cfgApplyBusy = true;
        var tries = 0;
        (function step() {
          if (LANES.main.inSearch || LANES.sub.inSearch || LANES.fwd.inSearch) {
            if (++tries > 30) { cfgApplyBusy = false; return; }   
            setTimeout(step, 2000);
            return;
          }
          cfgApplyBusy = false;
          booted = false;                          
          bootAll().catch(function () {});
        })();
      }

      function laneBusyT(lane) { return lane.inSearch ? Math.max(1, lane.curThreads || 1) : 0; }
      function othersBusyT(except) {
        var n = 0, all = [LANES.main, LANES.sub, LANES.fwd];
        for (var i = 0; i < all.length; i++) if (all[i] !== except) n += laneBusyT(all[i]);
        return n;
      }
      function bridgeDiag(text) {
        try { if (window.chrome && window.chrome.webview)
          window.chrome.webview.postMessage({ type: 'status', text: text }); } catch (e) {}
      }
      
      function planThreads(lane) {
        return Math.max(1, engBudget() - othersBusyT(lane));
      }
      
      function yieldAuxToMain() {
        var vs = [LANES.sub, LANES.fwd], n = 0;
        for (var i = 0; i < vs.length; i++) {
          if (!vs[i].inSearch) continue;
          n++;
          try { engCmd(vs[i].name, 'STOP'); } catch (e) {}
        }
        if (n) bridgeDiag('LINK_MAIN_EXCLUSIVE stoppedAux=' + n + ' budget=' + engBudget());
        return n;
      }
      function bootAll() {
        
        var lanesReady = LANES.main.ready && LANES.sub.ready;
        if (booted && lanesReady) return Promise.resolve();
        if (booting) return booting;
        booted = false;
        booting = engStatus().then(function (st) {
          if (!st || !st.available) {
            var d = (st && st.diag) ? st.diag : '原生引擎不可用（rapfi-native 缺失或被安全软件拦截）';
            throw new Error(d);
          }
          var cpuAll = fullCores();
          
          if (st && st.engineCPUs > 0) engCPUs = st.engineCPUs;
          
          if (st && st.engineThreads > 0) cfgThreads = st.engineThreads | 0;
          if (st && st.engineHashMB > 0) cfgHashMB = st.engineHashMB | 0;
          if (!quotaLogged) {
            quotaLogged = true;
            try {
              if (window.chrome && window.chrome.webview)
                window.chrome.webview.postMessage({ type: 'status', text:
                  'LINK_ENG_QUOTA engineCPUs=' + engCPUs + ' visCPUs=' + ((st && st.visionCPUs) || 0) +
                  ' split=' + ((st && st.cpuSplit) ? 1 : 0) + ' cpus=' + cpuAll });
            } catch (eQ) {}
          }
          var engTotal = engBudget();
          
          var mainT = Math.max(1, engTotal - 1);
          
          var memKB = (st && st.memMB > 0) ? (st.memMB * 1024)
                    : ((navigator.deviceMemory ? navigator.deviceMemory : 8) * 1024 * 1024);
          
          var wantMB = cfgHashMB > 0 ? cfgHashMB : (S.hashMB | 0);
          var hashKB = (wantMB > 0)
            ? Math.max(65536, Math.min(4 * 1024 * 1024, wantMB * 1024))
            
            : Math.max(262144, Math.min(6 * 1024 * 1024, Math.floor(memKB / 4)));
          var auxH = 65536;
          
          var ramCapKB = Math.max(262144, Math.floor(memKB / 3));
          hashKB = Math.min(hashKB, ramCapKB);
          
          var mainH = Math.max(65536, hashKB - auxH);
          
          var specs = [
            { lane: LANES.main, threads: mainT, hashKB: mainH },
            { lane: LANES.sub, threads: 1, hashKB: auxH },
          ];
          var p = Promise.resolve();
          specs.forEach(function (sp) {
            p = p.then(function () {
              armBootGuard(sp.lane);
              return engEnsure(sp.lane.name).then(function (r) {
                if (!r || !r.ok) throw new Error('引擎进程启动失败（' + sp.lane.name + ' 车道）');
                return engCmd(sp.lane.name, 'START ' + SIZE);
              });
            });
          });
          p = p.then(function () {
            return new Promise(function (res) { setTimeout(res, 1500); });   
          });
          specs.forEach(function (sp) {
            p = p.then(function () {
              var lane = sp.lane;
              var cmds = ['INFO THREAD_NUM ' + sp.threads,
                          'INFO CAUTION_FACTOR 3',
                          'INFO STRENGTH 100',
                          
                          'INFO SHOW_DETAIL 2',
                          'INFO HASH_SIZE ' + sp.hashKB];
              
              var q = Promise.resolve();
              cmds.forEach(function (c) { q = q.then(function () { return engCmd(lane.name, c); }); });
              return q.then(function () {
                lane.bootThreads = sp.threads;
                lane.curThreads = sp.threads;
                lane.ready = true;
                var w = lane.waiters; lane.waiters = [];
                for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
              });
            });
          });
          return p.then(function () { booted = true; });
        });
        
        booting = booting.catch(function (err) {
          booted = false;
          booting = null;
          
          LANES.main.ready = false; LANES.sub.ready = false; LANES.fwd.ready = false;
          LANES.main.waiters = []; LANES.sub.waiters = []; LANES.fwd.waiters = [];
          throw err;
        });
        return booting;
      }
      
      var fwdBooting = null;
      function bootFwdLane() {
        var lane = LANES.fwd;
        if (lane.ready) return Promise.resolve();
        if (fwdBooting) return fwdBooting;
        armBootGuard(lane);                      
        fwdBooting = engEnsure(lane.name).then(function (r) {
          if (!r || !r.ok) throw new Error('引擎进程启动失败（fwd 车道）');
          return engCmd(lane.name, 'START ' + SIZE);
        }).then(function () {
          return new Promise(function (res) { setTimeout(res, 1500); });   
        }).then(function () {
          var cmds = ['INFO THREAD_NUM 1', 'INFO CAUTION_FACTOR 3', 'INFO STRENGTH 100',
                      'INFO SHOW_DETAIL 2', 'INFO HASH_SIZE 65536'];
          var q = Promise.resolve();
          cmds.forEach(function (c) { q = q.then(function () { return engCmd(lane.name, c); }); });
          return q;
        }).then(function () {
          lane.bootThreads = 1; lane.curThreads = 1; lane.ready = true;
          var w = lane.waiters; lane.waiters = [];
          for (var i = 0; i < w.length; i++) { try { w[i](); } catch (e) {} }
        }).catch(function (e) {
          fwdBooting = null;                     
          throw e;
        });
        return fwdBooting;
      }
      
      function fetchForbid(lane) {
        return new Promise(function (resolve) {
          var found = [];
          var settled = false, sawLine = false;
          var poll = null, guard = null, settleTimer = null;
          
          var genAtStart = lane.gen;
          var finish = function () {
            if (settled) return;
            settled = true;
            lane.captureLine = null;
            if (poll) clearInterval(poll);
            if (guard) clearTimeout(guard);
            if (settleTimer) clearTimeout(settleTimer);
            resolve(found);
          };
          lane.captureLine = function (line) {
            if (lane.gen !== genAtStart) return false;   
            var pts = parseForbidLine(line);
            if (pts === null) return false;
            sawLine = true;
            for (var i = 0; i < pts.length; i++) found.push(pts[i]);
            return true;
          };
          poll = setInterval(function () {
            if (sawLine && !settleTimer) settleTimer = setTimeout(finish, 25);
          }, 5);
          guard = setTimeout(finish, 900);
        });
      }
      
      function waitForMove(lane, budgetMs, wantTopN, retryBody) {
        return new Promise(function (resolve, reject) {
          var hardDeadline = Date.now() + Math.max(1000, budgetMs) + 8000;
          var pvs = { __cur: -1 };
          var revives = 0;                 
          var probeWA = function (stage) {
            try { if (window.chrome && window.chrome.webview)
              window.chrome.webview.postMessage({ type: 'status', text: 'LINK_WAIT_TIMEOUT stage=' + stage }); } catch (eA) {}
          };
          var timer = setInterval(function () {
            var raw = lane.outBuf; lane.outBuf = '';
            var ls = raw.split('\n');
            for (var i = 0; i < ls.length; i++) parseLine(ls[i], pvs);
            var out = [];
            for (var li = 0; li < wantTopN; li++) {
              var pv = pvs[li];
              var b0 = pv && pv.bestline && pv.bestline[0];
              if (pv && b0) {
                out.push({
                  x: b0[0], y: b0[1],
                  winrate: (pv.winrate !== undefined && pv.winrate > 0) ? pv.winrate : 0.5,
                  eval: pv.eval || '',
                  depth: pv.depth || 0,
                  speed: pvs.__speed || 0,
                  nodes: pvs.__totalnodes || pv.nodes || 0,
                  line: (pv.bestline || []).slice(0, 16),
                });
              }
            }
            var mbest = raw.match(/\bbest\s+(\d+)\s+(\d+)/);
            var chosen = (mbest ? [+mbest[1], SIZE - 1 - (+mbest[2])] : null) || pvs.__best || pvs.__final;
            var done = !!mbest || !!pvs.__final || /^\s*REJECT\s*$/m.test(raw);
            if (done) {
              clearInterval(timer);
              if (!chosen && out.length) chosen = [out[0].x, out[0].y];
              if (chosen && chosen.length === 2) {
                var found = -1;
                for (var k = 0; k < out.length; k++) if (out[k].x === chosen[0] && out[k].y === chosen[1]) { found = k; break; }
                if (found > 0) out.unshift(out.splice(found, 1)[0]);
                else if (found < 0) out.unshift({ x: chosen[0], y: chosen[1], winrate: 0.5, eval: (out[0] && out[0].eval) || '', depth: (out[0] && out[0].depth) || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, line: [] });
              } else if (!out.length && chosen && chosen.length === 2) {
                out.push({ x: chosen[0], y: chosen[1], winrate: 0.5, eval: '', depth: 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, line: [] });
              }
              resolve({ candidates: out, best: chosen });
            } else if (Date.now() > hardDeadline) {
              if (chosen || out.length) {
                clearInterval(timer);
                if (!chosen) chosen = [out[0].x, out[0].y];
                resolve({ candidates: out, best: chosen, timeout: true });
                return;
              }
              
              probeWA(revives + 1);
              
              if (revives === 0 && retryBody && lane.ready && !lane.engineGone) {
                
                revives = 1;
                lane.outBuf = '';
                engCmd(lane.name, retryBody).catch(function () {});
                hardDeadline = Date.now() + 5000;
                return;
              }
              if (revives < 2 && retryBody) {
                
                revives = 2;
                if (console && console.warn) console.warn('[bridge] engine lane dead -> reset ' + lane.name);
                lane.outBuf = ''; lane.seq = 0; lane.mayPonder = false;
                try { engFetch('/engine/reset?lane=' + lane.name, '').catch(function () {}); } catch (eR) {}
                (function () {
                  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
                  wait(500).then(function () { return engCmd(lane.name, 'START ' + SIZE); })
                    .then(function () { return wait(300); })
                    .then(function () { lane.outBuf = ''; return engCmd(lane.name, retryBody); })
                    .catch(function () {});
                })();
                hardDeadline = Date.now() + 9000;
                return;
              }
              
              clearInterval(timer);
              lane.inSearch = false;
              lane.timedOut = (lane.timedOut || 0) + 1;
              if (lane.timedOut >= 2) {
                lane.timedOut = 0;
                lane.seq = 0; lane.outBuf = '';
                try { engFetch('/engine/reset?lane=' + lane.name, '').catch(function () {}); } catch (eR2) {}
                if (console && console.warn) console.warn('[bridge] engine lane dead -> reset ' + lane.name);
              }
              reject(new Error('Engine did not return a move within time limit'));
            }
          }, 60);
        });
      }
      function doAnalyze(body, lane) {
        var board = body.board;
        if (!Array.isArray(board) || board.length !== SIZE) return Promise.reject(new Error('board must be 15x15'));
        return whenBootReady(lane).then(function () {
          var prep = (lane.name === 'main') ? (lane.mayPonder ? preemptLane(lane, 1500) : quiesceLane(lane, 400)) : Promise.resolve();
          return prep.then(function () {
            var matchMs = Math.max(1000, Math.min(30000 * 1000, body.matchMs || 6000000));
            var turnMs = Math.max(200, Math.min(6000 * 1000, body.turnMs || 7000));
            var timeUsedMs = Math.max(0, Math.min(matchMs - 1, body.timeUsedMs || 0));
            var timeLeft = Math.max(1, matchMs - timeUsedMs);
            var topN = Math.max(1, Math.min(8, body.topN || 3));
            var boost = !!body.exclusive || !!body.boost || turnMs <= 1000;
            
            if (boost && lane.name === 'main') yieldAuxToMain();
            var rule = [0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0;
            var wantT = boost ? boostThreads() : planThreads(lane);
            var t0 = Date.now();
            var reqSide = (body.side === 1 || body.side === 2) ? body.side : 0;
            var moves = toEngineMoveList(board, body.moveList, reqSide);
            var cmd = 'YXBOARD';
            for (var mi = 0; mi < moves.length; mi++) cmd += ' ' + moves[mi].join(',');
            cmd += ' DONE';
            
            var batch = [];
            
            if (lane.name === 'main' && newGamePending) { newGamePending = false; batch.push('YXHASHCLEAR'); }
            if (wantT > 0 && lane.curThreads !== wantT) { lane.curThreads = wantT; batch.push('INFO THREAD_NUM ' + wantT); }
            batch.push('INFO RULE ' + rule);
            
            if (lane.name === 'main') {
              batch.push('INFO PONDERING 1'); armPonderPark(lane);
              
              if (!ponderLogged) {
                ponderLogged = true;
                try { if (window.chrome && window.chrome.webview)
                  window.chrome.webview.postMessage({ type: 'status', text:
                    'LINK_PONDER_ON idle_ms=' + PONDER_IDLE_MS + ' dboff=1 threads=' + lane.curThreads }); } catch (eP) {}
              }
            }
            batch.push('INFO TIMEOUT_TURN ' + turnMs,
                       'INFO TIMEOUT_MATCH ' + matchMs,
                       'INFO TIME_LEFT ' + timeLeft);
            batch.push(cmd);                         
            
            var forbidP = Promise.resolve([]);
            if (rule === 2 || rule === 4) {
              batch.push('YXSHOWFORBID');
              forbidP = fetchForbid(lane).catch(function () { return []; });
            }
            batch.push('YXNBEST ' + topN);
            
            var retryBody = batch.join('\n');
            lane.outBuf = '';
            var q = engCmd(lane.name, retryBody).then(function () {
              lane.inSearch = true;
              return forbidP.then(function (fb) {
                var forbid = fb || [];
                return waitForMove(lane, Math.min(timeLeft, turnMs + 1500), topN, retryBody).then(function (result) {
                  lane.inSearch = false;
                  
                  if (lane.name === 'main') { lane.mayPonder = true; armPonderPark(lane); }
                  result.elapsed = Date.now() - t0;
                  result.rule = rule;
                  result.matchMs = matchMs;
                  result.turnMs = turnMs;
                  result.forbid = forbid;
                  return result;
                }, function (err) {
                  lane.inSearch = false;      
                  if (lane.name === 'main') armPonderPark(lane);
                  throw err;
                });
              });
            });
            return q;
          });
        });
      }
      
      function fetchBalanceMove(lane, maxMs) {
        return new Promise(function (resolve) {
          var settled = false, sawLine = false;
          var poll = null, guard = null, settleTimer = null, out = null;
          var finish = function () {
            if (settled) return;
            settled = true;
            lane.captureLine = null;
            if (poll) clearInterval(poll);
            if (guard) clearTimeout(guard);
            if (settleTimer) clearTimeout(settleTimer);
            resolve(out);
          };
          lane.captureLine = function (line) {
            var r = parseBalanceLine(line);
            if (r === null) return false;
            sawLine = true;
            out = r;
            return true;
          };
          poll = setInterval(function () {
            if (sawLine && !settleTimer) settleTimer = setTimeout(finish, 30);
          }, 5);
          guard = setTimeout(finish, maxMs);
        });
      }
      function doBalance(body, lane) {
        var board = body.board;
        if (!Array.isArray(board) || board.length !== SIZE) return Promise.reject(new Error('board must be 15x15'));
        return whenBootReady(lane).then(function () {
          var n = Math.max(1, Math.min(10, body.n || 2));
          var bias = Math.max(-2000, Math.min(2000, body.bias | 0));
          var two = body.mode === 'two';
          var turnMs = Math.max(200, Math.min(600000, body.turnMs || 5000));
          var matchMs = Math.max(turnMs + 1000, Math.min(30000 * 1000, body.matchMs || 6000000));
          var rule = [0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0;
          
          var boostB = !!(body.exclusive || body.boost || turnMs <= 1000);
          if (boostB && lane.name === 'main') yieldAuxToMain();
          var wantT = boostB ? boostThreads() : planThreads(lane);
          var q = Promise.resolve();
          if (wantT > 0 && lane.curThreads !== wantT) {
            lane.curThreads = wantT;
            q = q.then(function () { return engCmd(lane.name, 'INFO THREAD_NUM ' + wantT); });
          }
          ['INFO RULE ' + rule, 'INFO TIMEOUT_TURN ' + turnMs, 'INFO TIMEOUT_MATCH ' + matchMs,
           'INFO TIME_LEFT ' + matchMs].forEach(function (c) { q = q.then(function () { return engCmd(lane.name, c); }); });
          var reqSide = (body.side === 1 || body.side === 2) ? body.side : 0;
          var moves = toEngineMoveList(board, body.moveList, reqSide);
          var cmd = 'YXBOARD';
          for (var mi = 0; mi < moves.length; mi++) cmd += ' ' + moves[mi].join(',');
          cmd += ' DONE';
          var t0 = Date.now();
          q = q.then(function () {
            engCmd(lane.name, cmd);
            lane.outBuf = '';
            engCmd(lane.name, 'YXBLOCKRESET');
            var results = [];
            var swap = false;
            var waitMs = turnMs + 6000;
            var round = Promise.resolve();
            var loop = function (i) {
              if (i >= n || swap) return Promise.resolve();
              round = round.then(function () {
                var rp = fetchBalanceMove(lane, waitMs);
                engCmd(lane.name, (two ? 'YXBALANCETWO ' : 'YXBALANCEONE ') + bias);
                return rp.then(function (r) {
                  if (!r || (!r.swap && !r.pts.length)) return;
                  if (r.swap) { swap = true; return; }
                  for (var pi = 0; pi < r.pts.length; pi++) results.push(r.pts[pi]);
                  if (i < n - 1) {
                    var bcmd = 'YXBLOCK';
                    for (var pj = 0; pj < r.pts.length; pj++) bcmd += ' ' + r.pts[pj][0] + ',' + (SIZE - 1 - r.pts[pj][1]);
                    engCmd(lane.name, bcmd + ' DONE');
                  }
                });
              });
              return round.then(function () { return loop(i + 1); });
            };
            return loop(0).then(function () {
              engCmd(lane.name, 'YXBLOCKRESET');
              
              if (lane.name === 'main') { lane.mayPonder = true; armPonderPark(lane); }
              return { mode: two ? 'two' : 'one', n: n, bias: bias, swap: swap,
                       moves: results, elapsed: Date.now() - t0, rule: rule };
            });
          });
          return q.then(function (r) {
            return r;
          }, function (e) {
            throw e;
          });
        });
      }
      
      function parseSwap2Line(line) {
        var t = String(line || '').trim();
        if (!t || /^MESSAGE/i.test(t) || /^OK$/i.test(t) || /^ERROR/i.test(t)) return null;
        var m = t.match(/^(?:\d{1,2},\d{1,2})(?:\s+\d{1,2},\d{1,2})*$/);
        if (!m) return null;
        var pts = t.split(/\s+/).map(function (s) {
          var xy = s.split(',').map(Number);
          if (!(xy[0] >= 0 && xy[0] < SIZE && xy[1] >= 0 && xy[1] < SIZE)) return null;
          return [xy[0], SIZE - 1 - xy[1]];           
        });
        if (pts.some(function (p) { return p === null; })) return null;
        return { pts: pts };
      }
      function doSwap2Board(lane) {
        return whenBootReady(lane).then(function () {
          return new Promise(function (resolve, reject) {
            var settled = false, out = null, poll = null, guard = null, settleTimer = null;
            var finish = function (ok, v) {
              if (settled) return;
              settled = true;
              lane.captureLine = null;
              if (poll) clearInterval(poll);
              if (guard) clearTimeout(guard);
              if (settleTimer) clearTimeout(settleTimer);
              if (ok) resolve(v); else reject(new Error(v || 'swap2board no answer'));
            };
            lane.captureLine = function (line) {
              var r = parseSwap2Line(line);
              if (r === null) return false;
              out = r;
              return true;
            };
            engCmd(lane.name, 'SWAP2BOARD').then(function () {
              return engCmd(lane.name, 'DONE');        
            });
            poll = setInterval(function () {
              if (out && !settleTimer) settleTimer = setTimeout(function () { finish(true, out); }, 30);
            }, 5);
            guard = setTimeout(function () { finish(false, 'swap2board timeout'); }, 8000);
          });
        });
      }
      
      function call(api, body, timeoutMs) {
        return new Promise(function (resolve, reject) {
          var done = false;
          var t = setTimeout(function () { if (!done) { done = true; reject(new Error('ws timeout')); } }, timeoutMs || 8000);
          function fin(fn, v) { if (!done) { done = true; clearTimeout(t); fn(v); } }
          if (api === 'health') {
            bootAll().then(function () {
              return engStatus().then(function (st) {
                fin(resolve, { ok: !!(st && st.available), variant: st && st.variant, diag: st && st.diag });
              });
            }).catch(function (e) { fin(resolve, { ok: false, diag: String(e && e.message || e) }); });
            return;
          }
          var lane = pickLane(body && body.lane);
          if (!lane.alive && !lane.ready) {
            
            bootAll().catch(function () {});
          }
          
          if (lane.name === 'fwd' && !lane.ready) bootFwdLane().catch(function () {});
          var run;
          if (api === 'analyze') run = serialMerge(lane, 'analyze', function () { return doAnalyze(body || {}, lane); });
          else if (api === 'balance') run = serialMerge(lane, 'balance', function () { return doBalance(body || {}, lane); });
          else if (api === 'swap2board') run = serialMerge(lane, 'swap2board', function () { return doSwap2Board(lane); });
          else { clearTimeout(t); reject(new Error('unknown engine api: ' + api)); return; }
          run.then(function (r) {
            
            if (r && r.__cancelled) { fin(resolve, { superseded: true, candidates: [], best: null }); return; }
            fin(resolve, r);
          }, function (e) { fin(reject, new Error(String(e && e.message || e))); });
        });
      }
      return { call: call, status: engStatus };
    })();
    return NATENG;
  }
  function wsCall(api, body, timeoutMs) {
    if (STANDALONE) return natEng().call(api, body, timeoutMs);
    return new Promise(function (resolve, reject) {
      if (!wsReady()) { reject(new Error('engine connection lost')); return; }
      var seq = ++wsSeq;
      var timer = setTimeout(function () {
        delete wsPending[seq];
        reject(new Error('ws timeout'));
      }, timeoutMs || 8000);
      wsPending[seq] = { resolve: resolve, reject: reject, t: timer };
      try { wsSock.send(JSON.stringify({ seq: seq, api: api, body: body || {} })); }
      catch (eSend) { clearTimeout(timer); delete wsPending[seq]; reject(new Error('engine connection lost')); }
    });
  }

  function suspectTip(res) {
    var nb = (res && res.black && res.black.length) || 0;
    var nw = (res && res.white && res.white.length) || 0;
    return '<span style="color:#c0392b">识别结果不可信（读到黑' + nb + '子/白' + nw +
           '子，黑白差过大），已忽略本帧</span>';
  }
  function applyScan(res) {
    if (!res || !res.ok) return false;
    if (res.suspect) { ui('setStatus', suspectTip(res)); return false; }
    var geo = res.geometry;
    if (!res.found || !geo || !geo.x_lines || !geo.y_lines) {
      boardRect = null; boardGeo = null;
      return false;
    }
    boardGeo = geo;
    
    var sc = 1 / (window.devicePixelRatio || 1);
    var xs = geo.x_lines.map(function (v) { return v * sc; });
    var ys = geo.y_lines.map(function (v) { return v * sc; });
    boardRect = {
      x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
      x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys),
    };
    
    var newSize = geo.size || 15;
    if (typeof N === 'number' && N !== newSize) {
      lastBest = null; lastMainC0 = null; S.candCache = [];
      S.history = [];
      forceScan = true;
    }
    N = newSize;
    if (UI.setN) UI.setN(N);
    return true;
  }

  function boardMatrix(bl, wh) {
    var m = [], x, y, row;
    for (y = 0; y < N; y++) { row = []; for (x = 0; x < N; x++) row.push(0); m.push(row); }
    bl.forEach(function (p) { if (m[p.y] && m[p.y][p.x] !== undefined) m[p.y][p.x] = 1; });
    wh.forEach(function (p) { if (m[p.y] && m[p.y][p.x] !== undefined) m[p.y][p.x] = 2; });
    return m;
  }

  function boardDecided(m) {
    var b = m || lastBoardMatrix();
    var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var c = b[y][x];
      if (!c) continue;
      for (var d = 0; d < 4; d++) {
        var dx = DIR[d][0], dy = DIR[d][1];
        
        if (y - dy >= 0 && y - dy < N && x - dx >= 0 && x - dx < N && b[y - dy][x - dx] === c) continue;
        var n = 0, px = x, py = y;
        while (px >= 0 && py >= 0 && px < N && py < N && b[py][px] === c) { n++; px += dx; py += dy; }
        if (n >= 5) return true;                        
        if (n === 4) {                                  
          var ex = x - dx, ey = y - dy;
          if (ex >= 0 && ey >= 0 && ex < N && ey < N && !b[ey][ex] &&
              px >= 0 && py >= 0 && px < N && py < N && !b[py][px]) return true;
        }
      }
    }
    return false;
  }
  
  function exactFiveFor(moverColor) {
    var rule = S.rule;
    if (rule === 1) return true;
    if (rule === 2 || rule === 6 || rule === 7 || rule === 8) return moverColor === 1;
    return false;
  }

  function hasFiveOnBoard(m) {
    var b = m || lastBoardMatrix();
    var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var c = b[y][x];
      if (!c) continue;
      for (var d = 0; d < 4; d++) {
        var dx = DIR[d][0], dy = DIR[d][1];
        if (y - dy >= 0 && y - dy < N && x - dx >= 0 && x - dx < N && b[y - dy][x - dx] === c) continue;
        var n = 0, px = x, py = y;
        while (px >= 0 && py >= 0 && px < N && py < N && b[py][px] === c) { n++; px += dx; py += dy; }
        if (exactFiveFor(c) ? (n === 5) : (n >= 5)) return true;
      }
    }
    return false;
  }

  function myColOf() { return (S.side === 0) ? 1 : 2; }

  function diag(text) { tellHost({ type: 'log', text: String(text) }); }
  
  function boardDumpText() {
    var m = lastBoardMatrix(), out = [], nb = 0, nw = 0;
    for (var y = N - 1; y >= 0; y--) {
      var row = '';
      for (var x = 0; x < N; x++) {
        var c = m[y][x];
        if (c === 1) { row += '#'; nb++; }
        else if (c === 2) { row += 'O'; nw++; }
        else row += '.';
      }
      out.push((y + 1) + ':' + row);
    }
    return 'board B=' + nb + ' W=' + nw + '\n' + out.join(' | ');
  }

  function findOpenFour(m) {
    var b = m || lastBoardMatrix();
    var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var c = b[y][x];
      if (!c) continue;
      for (var d = 0; d < 4; d++) {
        var dx = DIR[d][0], dy = DIR[d][1];
        if (y - dy >= 0 && y - dy < N && x - dx >= 0 && x - dx < N && b[y - dy][x - dx] === c) continue;
        var cells = [[x, y]], px = x + dx, py = y + dy;
        while (px >= 0 && py >= 0 && px < N && py < N && b[py][px] === c) {
          cells.push([px, py]); px += dx; py += dy;
        }
        if (cells.length !== 4) continue;
        var ex = x - dx, ey = y - dy;
        if (ex < 0 || ey < 0 || ex >= N || ey >= N || b[ey][ex]) continue;
        if (px < 0 || py < 0 || px >= N || py >= N || b[py][px]) continue;
        return { color: c, cells: cells };
      }
    }
    return null;
  }

  function lastBoardMatrix() {
    var m = [];
    for (var y = 0; y < N; y++) { m.push([]); for (var x = 0; x < N; x++) m[y].push(0); }
    (lastBl || []).forEach(function (p) { if (m[p.y] && m[p.y][p.x] !== undefined) m[p.y][p.x] = 1; });
    (lastWh || []).forEach(function (p) { if (m[p.y] && m[p.y][p.x] !== undefined) m[p.y][p.x] = 2; });
    return m;
  }

  function findWinningFive(m, side) {
    var out = [], DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
    function cnt(x, y, dx, dy, who) {
      var n = 0;
      while (x >= 0 && x < N && y >= 0 && y < N && m[y][x] === who) { n++; x += dx; y += dy; }
      return n;
    }
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (m[y][x] !== 0) continue;
      m[y][x] = side;
      var maxRun = 0;
      for (var d = 0; d < 4; d++) {
        var total = cnt(x, y, DIR[d][0], DIR[d][1], side) + cnt(x, y, -DIR[d][0], -DIR[d][1], side) - 1;
        if (total > maxRun) maxRun = total;
      }
      
      if (exactFiveFor(side) ? (maxRun === 5) : (maxRun >= 5)) out.push([x, y]);
      m[y][x] = 0;
    }
    return out;
  }

  function myIsToMove(bl, wh) {
    var toMoveIsBlack = bl.length <= wh.length;
    var iAmBlack = S.side === 0;
    return iAmBlack === toMoveIsBlack;
  }

  function evalForMe(rawEval, mine) {
    var s = (typeof rawEval === 'string') ? rawEval.trim() : '';
    if (!s) return '-';
    var mM = s.match(/^\s*([+-]?)M(\d+)\s*$/i);
    if (mM) {
      var sg = (mM[1] === '-') ? -1 : 1;
      var mv = mine ? sg : -sg;
      return (mv < 0 ? '-' : '+') + 'M' + mM[2];
    }
    var mN = s.match(/^\s*([+-]?)(\d+(?:\.\d+)?)\s*$/);
    if (mN) {
      var v = (mN[1] === '-' ? -1 : 1) * parseFloat(mN[2]);
      var mv2 = mine ? v : -v;
      
      return (mv2 > 0 ? '+' : '') + String(mv2);
    }
    return s;
  }

  function evalToNumber(s) {
    if (typeof s !== 'string') return 0;
    var m = /^([+-]?)M(\d+)/.exec(s.trim());
    if (m) return (m[1] === '-' ? -1 : 1) * 1000;
    var v = parseFloat(s.replace(/^\+/, ''));
    return isFinite(v) ? Math.max(-1000, Math.min(1000, v)) : 0;
  }

  function coordOf(x, y) { return String.fromCharCode(65 + x) + (N - y); }

  async function analyze(bl, wh) {
    var fpNow = boardKey(bl, wh);
    if (engineBusy) { pendingEvalKey = fpNow; return; }   
    engineBusy = true;
    try {
      var ply = bl.length + wh.length;
      var mine = myIsToMove(bl, wh);
      
      var turnMsNow = S.turnMs || (adOn ? 2000 : 5000);
      
      if (adOn && /^[+-]?M\d/.test(S.myEval || '')) turnMsNow = Math.min(turnMsNow, 120);
      
      var laneSlack = (swBusy || balBusy) ? (SWBAL_BUDGET_MS + 800) : 0;
      var res = await onMainLane(function () {
        
        return wsCall('analyze', {
          board: boardMatrix(bl, wh), moveList: [],
          matchMs: S.matchMs || 600000, turnMs: turnMsNow,
          timeUsedMs: 0, topN: 1, rule: S.rule, cid: 'desktop-' + ply,
          
          exclusive: true,
        }, Math.max(12000, turnMsNow + 12000) + laneSlack);
      });
      if (res && res.superseded) { postGuide(false); return; }   
      if (!res || res.error || !res.candidates || !res.candidates.length) {
        try { if (window.chrome && window.chrome.webview)
          window.chrome.webview.postMessage({ type: 'status', text: 'LINK_EVAL_EMPTY ' + (res && res.error ? String(res.error) : 'no candidates') });
        } catch (eD) {}
        ui('setStatus', '<span style="color:#c0392b">' +
          (S.lang === 'en' ? 'Engine returned no move' : '引擎未返回着法') +
          (res && res.error ? (S.lang === 'en' ? ': ' : '：') + res.error : '') + '</span>');
        postGuide(false);
        return;
      }
      
      if (fpNow !== boardKey(lastBl, lastWh)) return;
      var c0 = res.candidates[0];
      S.rawEval = c0.eval || '';
      S.myEval = evalForMe(c0.eval, mine);
      S.candCache = res.candidates;
      S.history = S.history.filter(function (p) { return p.i !== ply; });
      S.history.push({ i: ply, v: evalToNumber(S.myEval) });
      S.history.sort(function (a, b) { return a.i - b.i; });
      S.lastStat = { c0: { depth: c0.depth, speed: c0.speed, nodes: c0.nodes, line: (c0.line || []).map(function (p) { return [p[0], p[1]]; }) }, elapsed: 0 };
      ui('setStatPanel', S.lastStat.c0, 0);
      ui('drawChart');
      var best = res.best || [c0.x, c0.y];
      
      lastBest = best;
      lastMainC0 = c0;
      ui('setStatus', (S.lang === 'en' ? 'Best move ' : '推荐落点 ') +
        '<b>' + coordOf(best[0], best[1]) + '</b>' +
        (S.lang === 'en' ? ' (my eval ' : '（我方评估 ') + S.myEval +
        (S.lang === 'en' ? ') · depth ' : '）· 深度 ') + (c0.depth || '-'));
      
      postGuide(true, best[0], best[1]);
      
      if (adOn) adMaybeFire(best[0], best[1]);
    } catch (e) {
      
      var em = String((e && e.message) || e);
      
      if (isWaitTimeout(e)) {
        
        if (swBusy || balBusy) {
          ui('setStatus', '<span style="color:#e67e22">' + LT('analyzeRetry') + '</span>');
        } else {
          try { console.warn('[bridge] analyze wait timeout (silent retry):', em); } catch (eC) {}
        }
        postGuide(false);
        if (!analyzeRetryTimer) {
          var tryRetry = function () {
            analyzeRetryTimer = null;
            if (!engineBusy && !swBusy && !balBusy && boardGeo) {
              analyzeRetryCount = 0;
              analyze(lastBl, lastWh);
            } else if (boardGeo) {
              
              if (++analyzeRetryCount < 8) {
                analyzeRetryTimer = setTimeout(tryRetry, 1500);
              } else { analyzeRetryCount = 0; }
            }
          };
          analyzeRetryCount = 0;
          analyzeRetryTimer = setTimeout(tryRetry, 1500);
        }
      } else {
        try { if (window.chrome && window.chrome.webview)
          window.chrome.webview.postMessage({ type: 'status', text: 'LINK_EVAL_FAIL ' + String(errText(e)) });
        } catch (eD) {}
        
        ui('setStatus', '<span style="color:#c0392b">' +
          (S.lang === 'en' ? 'Analysis failed: ' : '分析失败：') + errText(e) + '</span>');
        postGuide(false);
      }
    } finally {
      engineBusy = false;
      
      if (pendingEvalKey && pendingEvalKey !== boardKey(lastBl, lastWh) && boardGeo) {
        var pk = pendingEvalKey; pendingEvalKey = null;
        analyze(lastBl, lastWh);
      } else {
        pendingEvalKey = null;
      }
    }
  }

  function boardToScreen(x, y) {
    if (!boardGeo) return null;
    var xs = boardGeo.x_lines, ys = boardGeo.y_lines;
    if (!xs || !ys || xs.length <= x || ys.length <= y) return null;
    return { x: Math.round(xs[x]), y: Math.round(ys[y]) };
  }

  function boardGap() {
    try {
      var xs = boardGeo && boardGeo.x_lines;
      if (xs && xs.length > 1) {
        var g = Math.abs(xs[1] - xs[0]);
        if (g > 4) return g;
      }
      if (boardGeo && boardGeo.spacing > 4) return boardGeo.spacing;
    } catch (e) {}
    return 0;
  }

  function postGuide(on, gx, gy) {
    if (!HOST) return;
    if (!on) { tellHost({ type: 'guide', on: false }); return; }
    var p = boardToScreen(gx, gy);
    if (!p) { tellHost({ type: 'guide', on: false }); return; }
    var gap = boardGap();
    tellHost({ type: 'guide', on: true, x: p.x, y: p.y, r: gap > 4 ? Math.round(gap * 0.46) : 0 });
  }

  var heatBusy = false;
  
  var lastBest = null;      
  var lastMainC0 = null;    

  function heatLabel(ev) {
    var s = String(ev == null ? '' : ev).trim().replace(/[^0-9A-Za-z+\-]/g, '');
    return s.length > 6 ? s.slice(0, 6) : s;
  }

  function heatTiers(list) {
    var n = list.length, out = [], i;
    if (!n) return out;
    if (n === 1) return [1];
    for (i = 0; i < n; i++) {
      var t = 1 + Math.floor(i * 4 / n);
      out.push(Math.max(1, Math.min(4, t)));
    }
    return out;
  }

  async function refreshHeatOverlay(bl, wh) {
    if (!HOST) return;
    if (!S.heatmap || !boardGeo || heatBusy) {
      if (!S.heatmap) tellHost({ type: 'heat', on: false });
      return;
    }
    heatBusy = true;
    var fp = boardKey(bl, wh);
    try {
      var refreshMs = Math.max(1200, Math.min(4000, Math.round((S.turnMs || 5000) * 0.5)));
      var ask = function (ms) {
        return wsCall('analyze', {
          board: boardMatrix(bl, wh), moveList: [],
          matchMs: S.matchMs || 600000, turnMs: ms, timeUsedMs: 0,
          topN: 8, rule: S.rule, cid: 'desktop-heat', lane: 'sub',
        }, ms + 6000);
      };
      var res = await ask(refreshMs);
      if (fp !== lastBoardKey) return;                 
      if (res && res.candidates && res.candidates.length < 4) {
        try {
          var res2 = await ask(Math.min(6000, refreshMs + 1500));
          if (fp === lastBoardKey && res2 && !res2.error && res2.candidates &&
              res2.candidates.length > res.candidates.length) res = res2;
        } catch (e2) {}
      }
      if (res && res.superseded) { tellHost({ type: 'heat', on: false }); return; }
      if (!S.heatmap || !res || res.error || !res.candidates || !res.candidates.length) {
        tellHost({ type: 'heat', on: false });
        return;
      }
      var cands = res.candidates.slice(0, 8);
      if (lastBest && lastBest.length === 2) {          
        for (var i = 1; i < cands.length; i++) {
          if (cands[i].x === lastBest[0] && cands[i].y === lastBest[1]) {
            cands.unshift(cands.splice(i, 1)[0]);
            break;
          }
        }
      }
      if (lastMainC0 && cands.length &&
          cands[0].x === lastMainC0.x && cands[0].y === lastMainC0.y) {
        if (lastMainC0.eval) cands[0].eval = lastMainC0.eval;
        if (lastMainC0.depth) cands[0].depth = lastMainC0.depth;
      }
      S.candCache = cands;
      var mine = myIsToMove(bl, wh);
      
      var tiers = heatTiers(cands);
      var parts = [];
      for (var ci = 0; ci < cands.length; ci++) {
        var c = cands[ci];
        var p = boardToScreen(c.x, c.y);
        if (!p) continue;
        var ev = evalForMe(c.eval, mine);
        
        parts.push(p.x + ',' + p.y + ',' + tiers[ci] + ',' + heatLabel(ev));
      }
      if (!parts.length) { tellHost({ type: 'heat', on: false }); return; }
      tellHost({ type: 'heat', on: true, gap: Math.round(boardGap()), cells: parts.join(';') });
    } catch (e) {
      try { tellHost({ type: 'heat', on: false }); } catch (e2) {}
    } finally { heatBusy = false; }
  }

  var balMarks = [];              
  var balSticky = false;          
  var balToggleArmed = false;     
  var lastOpen4Toast = 0;         
  var balLastKey = '';
  
  var balBaseB = 0, balBaseW = 0, balNeedB = 0, balNeedW = 0;
  function balSet(cells, sticky, key, colors) {
    balMarks = cells.map(function (c) { return { x: c[0], y: c[1] }; });
    balSticky = !!sticky;
    balToggleArmed = false;
    balLastKey = key || '';
    balBaseB = (lastBl || []).length;
    balBaseW = (lastWh || []).length;
    balNeedB = 0; balNeedW = 0;
    for (var bi = 0; bi < (colors ? colors.length : 0); bi++) {
      if (colors[bi] === 'b') balNeedB++;
      else if (colors[bi] === 'w') balNeedW++;
    }
  }
  
  function balOff() {
    balMarks = []; balSticky = false; balToggleArmed = false; balLastKey = '';
    balBaseB = balBaseW = balNeedB = balNeedW = 0;
    tellHost({ type: 'balance', on: false });
    swBtnState();                                 
  }
  
  function balOnBoardChanged(newBl, newWh) {
    if (!balMarks.length) return;
    if (!balSticky) { balOff(); return; }
    var nbNow = newBl ? newBl.length : 0, nwNow = newWh ? newWh.length : 0;
    var nM = balMarks.length;
    
    if (balNeedB + balNeedW > 0 &&
        (nbNow - balBaseB) >= balNeedB && (nwNow - balBaseW) >= balNeedW) { balOff(); return; }
    if (nM >= 3) {
      var tot = nbNow + nwNow;
      if (tot >= nM) { balOff(); return; }
    }
    var occ = {};
    for (var i = 0; i < (newBl ? newBl.length : 0); i++) occ[newBl[i][0] + ',' + newBl[i][1]] = 1;
    for (var j = 0; j < (newWh ? newWh.length : 0); j++) occ[newWh[j][0] + ',' + newWh[j][1]] = 1;
    var left = balMarks.filter(function (m) { return !occ[m.x + ',' + m.y]; });
    if (left.length !== balMarks.length) balMarks = left;
    if (!balMarks.length) balOff();     
  }

  var adOn = false, adCount = 1, adWaiting = false, adFail = 0, adTimer = null;
  
  var adStage = 0;
  
  var adRound = 0;                        
  var adDone = 0;                        
  var adLastPt = null;                   
  
  var lastAdPipe = '';
  var adHadStones = false;               
  try { var _adC = parseInt(localStorage.getItem('gb_ad_count') || '1', 10); if (_adC >= 1 && _adC <= 3) adCount = _adC; } catch (e) {}
  var adFailKey = null;                 
  var adRetryUsed = false;              
  var adRetryWatch = null, adRetryWatchN = 0; 
  var newGamePending = false;              
  var plyPrev = 0;                         

  function adBtnSync() {
    var b = document.getElementById('__gb_autodrop'), c = document.getElementById('__gb_adcount');
    if (b) b.setAttribute('data-ad-on', adOn ? '1' : '0');
    if (c) c.textContent = '×' + adCount;
    swBtnState();
  }

  function swBtnState() {
    var b1 = document.getElementById('__gb_swbal'), b2 = document.getElementById('__gb_autodrop');
    if (b1) b1.setAttribute('data-dis', adOn ? '0' : '1');
    if (b2) b2.setAttribute('data-dis', swQueue ? '1' : '0');
  }

  function adNewGameOff() {
    newGamePending = true;                 
    swQueue = null; swIdx = 0;
    if (!adOn) return;
    adOn = false;
    adWaiting = false; adFail = 0; adStage = 0; adRound = 0; adDone = 0; adLastPt = null; adFailKey = null; adRetryUsed = false;
    if (adRetryWatch) { clearTimeout(adRetryWatch); adRetryWatch = null; } adRetryWatchN = 0;
    if (adTimer) { clearTimeout(adTimer); adTimer = null; }
    adBtnSync();
    tellHost({ type: 'autodrop', on: false });
    ui('setStatus', '<b style="color:#555">' + LT('adOffNewGame') + '</b>');
  }

  function adArmTimeout() {
    if (adTimer) clearTimeout(adTimer);
    adTimer = setTimeout(function () {
      adTimer = null;
      if (!adWaiting) return;
      adWaiting = false;
      
      if (!adRetryUsed) {
        adRetryUsed = true;
        
        if (boardKey(lastBl, lastWh) !== lastBoardKey) { adLastPt = null; return; }
        ui('setStatus', '<span style="color:#e67e22;">' + LT('adRetry') + '</span>');
        if (swQueue) { adStage = Math.min(2, (adStage || 0) + 1); swAdvance(); }
        else if (adLastPt) adFire(adLastPt[0], adLastPt[1], false, false, adRealOnly() ? 2 : 1);
      } else {
        
        var curPt = adLastPt ? (adLastPt[0] + ',' + adLastPt[1]) : '';
        adLastPt = null;                 
        if (curPt && curPt === adFailKey) {
          ui('setStatus', '<span style="color:#c0392b">' + LT('adPtUnreachable') + '</span>');
        } else {
          adFailKey = curPt;
          adFail++;
          if (adFail >= 3) {
            adOn = false; swQueue = null; adBtnSync();
            ui('setStatus', '<span style="color:#c0392b">' + LT('adGiveUp') + '</span>');
          } else {
            ui('setStatus', '<span style="color:#c0392b">' + LT('adGiveUp') +
              ' (' + adFail + '/3)</span>');
          }
        }
        
        if (!adRetryWatch && adOn && boardGeo) {
          adRetryWatch = setTimeout(function () {
            adRetryWatch = null;
            if (!adOn || !boardGeo) return;
            if (++adRetryWatchN >= 3) { adRetryWatchN = 0; return; }
            ui('setStatus', '<span style="color:#e67e22;">' +
              (S.lang === 'en' ? 'Retrying this position…' : '重试当前局面…') + '</span>');
            analyze(lastBl, lastWh);
          }, 3000);
        }
      }
    }, 4000);
  }

  function adConfirm() {
    if (adTimer) { clearTimeout(adTimer); adTimer = null; }
    if (!adWaiting) return;
    adWaiting = false; adFail = 0; adRetryUsed = false;
    if (adRetryWatch) { clearTimeout(adRetryWatch); adRetryWatch = null; } adRetryWatchN = 0;
    
    if (lastAdPipe) tellHost({ type: 'adPipeOk', pipe: lastAdPipe });
    adStage = 0;
    adRound = 0; adFailKey = null;        
    if (swQueue) {                       
      swIdx++;
      if (swIdx >= swQueue.length) {
        var nAll = swQueue.length; swQueue = null;
        ui('setStatus', '<b style="color:#0e7490">' + LT('swPlaced').replace('%1', nAll) + '</b>');
        swBtnState();                            
      } else {
        setTimeout(swAdvance, 120);      
      }
      return;
    }
    adDone++;
    ui('setStatus', '<b style="color:#28a745">' + LT('adDropped') + ' ×' + adDone + '</b>');
  }

  function adMaybeFire(gx, gy) {
    if (!adOn || swQueue || adWaiting) return;
    if (adLastPt && adLastPt[0] === gx && adLastPt[1] === gy) return;
    adLastPt = [gx, gy];
    adFire(gx, gy, false);
  }
  
  function adRealOnly() {
    var c = document.getElementById('__gb_realclick');
    return !!(c && (c.checked === true || c.getAttribute('data-on') === '1'));
  }
  
  function adFire(gx, gy, force, once, stage) {
    var p = boardToScreen(gx, gy);
    if (!p) return;
    var cnt = once ? 1 : adCount;
    var realOnly = adRealOnly();
    
    var wantStage = (typeof stage === 'number') ? stage : (force ? 1 : 0);
    adStage = realOnly ? 2 : Math.min(1, wantStage);
    
    adRetryUsed = realOnly || !!force || (typeof stage === 'number' && stage >= 1);
    adWaiting = true;
    adArmTimeout();
    
    tellHost({ type: 'autodrop', on: true, x: p.x, y: p.y, count: cnt,
               force: adStage >= 1, real: adStage >= 2 });
    ui('setStatus', '<span style="color:#28a745">' + LT('adFired') + coordOf(gx, gy) +
      (adStage === 1 ? ' [input]' : (adStage === 2 ? ' [mouse]' : '')) + '</span>');
  }

  var swQueue = null, swIdx = 0;         
  var pendingBal = null;                 
  var swBusy = false, swEvalBusy = false;
  
  var swQuietSide = false;
  
  function sideHintMuted() { return swQuietSide; }
  
  var SWBAL_BUDGET_MS = 7500;      

  function swAdvance() {
    if (!swQueue || !adOn) return;
    if (swIdx >= swQueue.length) { swQueue = null; return; }
    var pt = swQueue[swIdx];
    var p = boardToScreen(pt[0], pt[1]);
    if (!p) { swQueue = null; return; }
    adWaiting = true;
    
    adRetryUsed = adRealOnly() || (adStage >= 1);
    adArmTimeout();
    
    adStage = stg;                        
    var stg = adRealOnly() ? 2 : Math.min(1, adStage);
    tellHost({ type: 'autodrop', on: true, x: p.x, y: p.y, count: adCount,
               force: stg >= 1, real: stg >= 2 });
    ui('setStatus', '<span style="color:#0e7490">' +
      LT('swPlacing').replace('%1', swIdx + 1).replace('%2', swQueue.length) +
      coordOf(pt[0], pt[1]) + ')</span>');
  }

  async function runSwapBal() {
    if (swBusy || balBusy) return;
    
    if (!boardGeo) { ui('setStatus', '<span style="color:#e67e22;">' + T('no_board') + '</span>'); return; }
    
    var swPly = lastBl.length + lastWh.length;
    if (swPly !== 0 && swPly !== 3) {
      ui('setStatus', swTipCol(LT('swBalStage'), '#e67e22'));
      return;
    }
    swBusy = true;
    
    swQuietSide = true;
    if (S.side !== -1) setSide(-1);
    balOff();
    var empty = (lastBl.length + lastWh.length === 0);
    var toBlack = lastBl.length <= lastWh.length;        
    
    var budget = Math.max(1500, Math.min(SWBAL_BUDGET_MS, Math.round((S.turnMs || 5000) * 1.5)));
    
    var turnMs = Math.max(2000, Math.min(S.turnMs || 5000, 4500));
    var rule = (S.rule === 0 || S.rule === 1 || S.rule === 2 || S.rule === 5) ? S.rule : 0;
    
    var t0 = Date.now();
    var leftMs = function () { return budget - (Date.now() - t0); };
    try {
      ui('setStatus', '<span style="color:#0e7490">' + LT(empty ? 'swBalEmpty' : 'swBalPair') + '</span>');
      var marks = [];
      var balFromEngine = 0;      
      if (empty) {
        
        var OFFICIAL_SWAP2 = [
          [[6, 7], [6, 4], [4, 2]],
          [[3, 3], [5, 5], [6, 6]],
          [[3, 2], [5, 4], [4, 5]],
          [[5, 2], [1, 5], [1, 6]],
          [[8, 5], [5, 8], [6, 7]],
          [[5, 5], [8, 8], [7, 7]],
          [[13, 12], [13, 9], [10, 12]],
          [[11, 7], [10, 6], [13, 5]],
          [[3, 7], [1, 8], [0, 4]],
        ];
        // Official 26 Renju openings (RIF three-move exchange, rule 2 = forbidden
        // moves): black1 on tengen (7,7), white2 on I9 (8,8, diagonal) or H9
        // (7,8, direct), black3 per the official opening table. Two black + one
        // white; the 8-symmetry expansion below covers all board orientations.
        var RENJU_OPENINGS = [
          // diagonal (indirect): white2 = I9 (8,8)
          [[7, 7], [8, 8], [9, 9]],   // 1. Chosei  long star  (J10)
          [[7, 7], [8, 8], [9, 8]],   // 2. Kyogetsu  gorge moon  (J9)
          [[7, 7], [8, 8], [9, 7]],   // 3. Kosei  fixed star  (J8)
          [[7, 7], [8, 8], [9, 6]],   // 4. Suigetsu  water moon  (J7)
          [[7, 7], [8, 8], [9, 5]],   // 5. Ryusei  meteor  (J6)
          [[7, 7], [8, 8], [8, 7]],   // 6. Ungetsu  cloud moon  (I8)
          [[7, 7], [8, 8], [8, 6]],   // 7. Pugetsu  shore moon  (I7)
          [[7, 7], [8, 8], [8, 5]],   // 8. Rangetsu  storm moon  (I6)
          [[7, 7], [8, 8], [7, 6]],   // 9. Gingetsu  silver moon  (H7)
          [[7, 7], [8, 8], [7, 5]],   // 10. Meisei  bright star  (H6)
          [[7, 7], [8, 8], [6, 6]],   // 11. Shagetsu  slant moon  (G7)
          [[7, 7], [8, 8], [6, 5]],   // 12. Meigetsu  famous moon  (G6)
          [[7, 7], [8, 8], [5, 5]],   // 13. Suisei  comet  (F6)
          // direct: white2 = H9 (7,8)
          [[7, 7], [7, 8], [7, 9]],   // 14. Kansai  cold star  (H10)
          [[7, 7], [7, 8], [9, 9]],   // 15. Sosei  sparse star  (J10)
          [[7, 7], [7, 8], [8, 8]],   // 16. Kagetsu  flower moon  (I9)
          [[7, 7], [7, 8], [9, 8]],   // 17. Zangetsu  waning moon  (J9)
          [[7, 7], [7, 8], [9, 7]],   // 18. Kinsei  gold star  (J8)
          [[7, 7], [7, 8], [7, 6]],   // 19. Shogetsu  pine moon  (H7)
          [[7, 7], [7, 8], [9, 6]],   // 20. Shingetsu  new moon  (J7)
          [[7, 7], [7, 8], [7, 5]],   // 21. Zuisei  lucky star  (H6)
          [[7, 7], [7, 8], [8, 5]],   // 22. Sangetsu  mountain moon  (I6)
          [[7, 7], [7, 8], [8, 9]],   // 23. Keigetsu  brook moon  (I10)
          [[7, 7], [7, 8], [8, 7]],   // 24. Ugetsu  rain moon  (I8)
          [[7, 7], [7, 8], [8, 6]],   // 25. Kyugetsu  hill moon  (I7)
          [[7, 7], [7, 8], [9, 5]],   // 26. Yusei  wander star  (J6)
        ];
        
        var SWAP2_SYM = [
          function (x, y) { return [x, y]; },                      
          function (x, y) { return [y, x]; },                      
          function (x, y) { return [N - 1 - x, y]; },              
          function (x, y) { return [x, N - 1 - y]; },              
          function (x, y) { return [N - 1 - x, N - 1 - y]; },      
          function (x, y) { return [N - 1 - y, x]; },              
          function (x, y) { return [y, N - 1 - x]; },              
          function (x, y) { return [N - 1 - y, N - 1 - x]; },      
        ];
        var OPENINGS = (rule === 2) ? RENJU_OPENINGS : OFFICIAL_SWAP2;
        var SYM_EXPAND = (function () {
          var out = [], seen = {};
          for (var oi = 0; oi < OPENINGS.length; oi++) {
            for (var tt = 0; tt < SWAP2_SYM.length; tt++) {
              var q = [], key = [], ok = true;
              for (var pi = 0; pi < 3; pi++) {
                var p = SWAP2_SYM[tt](OPENINGS[oi][pi][0], OPENINGS[oi][pi][1]);
                if (p[0] < 0 || p[0] >= N || p[1] < 0 || p[1] >= N) { ok = false; break; }
                q.push([p[0], p[1]]); key.push(p[0] + ',' + p[1]);
              }
              if (!ok) continue;
              var sig = key.slice().sort().join('|');
              if (seen[sig]) continue;
              seen[sig] = 1; out.push(q);
            }
          }
          return out;
        })();
        if (N === 15 && SYM_EXPAND.length > OPENINGS.length) OPENINGS = SYM_EXPAND;
        var LIB_FALLBACK = [[0, 0], [2, 1], [2, 4]];   
        var isLibFallback = function (pts) {
          for (var i = 0; i < 3; i++)
            if (pts[i][0] !== LIB_FALLBACK[i][0] || pts[i][1] !== LIB_FALLBACK[i][1]) return false;
          return true;
        };
        
        var takeLib = function (pts) {
          for (var i = 0; i < 3; i++)
            if (!pts[i] || pts[i][0] < 0 || pts[i][0] >= N || pts[i][1] < 0 || pts[i][1] >= N) return false;
          marks.length = 0;
          for (var j = 0; j < 3; j++)
            marks.push({ p: [pts[j][0], pts[j][1]], color: (j === 1 ? 'w' : 'b') });
          balFromEngine = 3;                    
          return true;
        };
        var libSource = 'none';
        try {
          // The opening book follows the ACTIVE rule: the engine's SWAP2BOARD
          // must run under INFO RULE <rule> (renju 2 = forbidden moves) or it
          // falls back to the freestyle book and the opening becomes wrong.
          await onMainLane(function () {
            return engCmd('main', 'INFO RULE ' + rule).then(function () {
              return engCmd('main', 'INFO THREAD_NUM ' + (S.threads || 4));
            });
          });
          var s2 = await onMainLane(function () { return wsCall('swap2board', {}, 8000); });
          if (s2 && s2.pts && s2.pts.length === 3 && !isLibFallback(s2.pts) && takeLib(s2.pts))
            libSource = 'engine';
        } catch (eS2) {  }
        if (libSource === 'none' && N === 15) {
          
          if (takeLib(OPENINGS[Math.floor(Math.random() * OPENINGS.length)]))
            libSource = 'local';
        }
        if (libSource === 'none') {
        
        var R1 = 2, R2 = 3, cx = (N - 1) >> 1, cy = (N - 1) >> 1;
        var inZone = function (p, R) {
          return Math.max(Math.abs(p[0] - cx), Math.abs(p[1] - cy)) <= R;
        };
        var m1 = [cx + Math.floor(Math.random() * (2 * R1 + 1)) - R1,
                  cy + Math.floor(Math.random() * (2 * R1 + 1)) - R1];
        var b2 = boardMatrix(lastBl, lastWh);
        b2[m1[1]][m1[0]] = toBlack ? 1 : 2;
        marks.push({ p: m1, color: toBlack ? 'b' : 'w' });
        
        var sides = [toBlack ? 2 : 1, toBlack ? 1 : 2];      
        var colors = [toBlack ? 'w' : 'b', toBlack ? 'b' : 'w'];
        for (var step = 0; step < 2; step++) {
          if (leftMs() < 400) break;                         
          var pt2 = null;
          for (var tries = 0; tries < 2; tries++) {
            if (leftMs() < 400) break;
            
            var ms = (tries === 0)
              ? Math.max(400, Math.min(turnMs, Math.floor(leftMs() * (step === 0 ? 0.55 : 0.85))))
              : Math.max(400, Math.min(turnMs, leftMs() - 500));
            if (ms < 400) break;
            
            var reqBody = {
              board: b2, moveList: [], n: 1, mode: 'one', bias: (tries === 0 ? 0 : 15),
              rule: rule, turnMs: ms, lane: 'main',
              cid: 'desktop-swbal1-' + (lastBl.length + lastWh.length) + '-' + step + '-' + tries,
              side: sides[step],
            };
            var jw = null;
            try {
              
              jw = await onMainLane(function () {
                return wsCall('balance', reqBody, ms + 6000);
              });
            } catch (eShot) { jw = null; }          
            if (!jw || jw.error || jw.swap || !jw.moves || !jw.moves.length) { pt2 = null; break; }
            pt2 = jw.moves[0];
            if (inZone(pt2, R2)) break;                      
          }
          if (!pt2) break;                                   
          marks.push({ p: pt2, color: colors[step] });
          b2[pt2[1]][pt2[0]] = (colors[step] === 'b') ? 1 : 2;
        }
        
        var firstFreeInZone = function (bb, R, ms) {
          var mx = (N - 1) >> 1, my = (N - 1) >> 1, used = {}, k;
          for (k = 0; k < ms.length; k++) used[ms[k].p[0] + ',' + ms[k].p[1]] = 1;
          var mir = [2 * mx - ms[0].p[0], 2 * my - ms[0].p[1]];
          if (!used[mir[0] + ',' + mir[1]] && bb[mir[1]][mir[0]] === 0 &&
              Math.max(Math.abs(mir[0] - mx), Math.abs(mir[1] - my)) <= R) return mir;
          var best = null, bd = 1e9;
          for (var y = my - R; y <= my + R; y++) {
            for (var x = mx - R; x <= mx + R; x++) {
              if (bb[y][x] !== 0 || used[x + ',' + y]) continue;
              var d = Math.max(Math.abs(x - mx), Math.abs(y - my)) * 10 +
                      (Math.abs(x - mx) + Math.abs(y - my));
              if (d < bd) { bd = d; best = [x, y]; }
            }
          }
          return best;
        };
        balFromEngine = marks.length;                        
        while (marks.length < 3) {
          var fp = firstFreeInZone(b2, R2, marks);
          if (!fp) break;
          var fc = colors[marks.length - 1];                 
          marks.push({ p: fp, color: fc });
          b2[fp[1]][fp[0]] = (fc === 'b') ? 1 : 2;
        }
        }   
      } else {
        
        var pairMs = Math.max(400, Math.min(turnMs, leftMs() - 300));
        var pairBody = {
          board: boardMatrix(lastBl, lastWh), moveList: [], n: 1, mode: 'two', bias: 0,
          rule: rule, turnMs: pairMs, lane: 'main',
          cid: 'desktop-swbal2-' + (lastBl.length + lastWh.length),
          side: toBlack ? 1 : 2,
        };
        var j1 = null;
        try {
          
          j1 = await onMainLane(function () {
            return wsCall('balance', pairBody, pairMs + 6000);
          });
        } catch (ePair) { j1 = null; }
        if (!j1 || j1.error) {
          ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') + ((j1 && j1.error) || 'no response') + '</span>');
          return;
        }
        if (j1.swap) { ui('setStatus', '<b style="color:#7c3aed">' + LT('swSwapNow') + '</b>'); return; }
        var pts1 = (j1.moves || []).slice(0, 2);
        if (pts1.length < 2) { ui('setStatus', '<span style="color:#c0392b">' + LT('balNone') + '</span>'); return; }
        marks.push({ p: pts1[0], color: toBlack ? 'b' : 'w' });
        marks.push({ p: pts1[1], color: toBlack ? 'w' : 'b' });
        balFromEngine = 2;
      }
      
      var parts = [], names = [];
      for (var i = 0; i < marks.length; i++) {
        var p = boardToScreen(marks[i].p[0], marks[i].p[1]);
        if (p) parts.push(p.x + ',' + p.y + ',' + (i + 1) + ',' + marks[i].color);
        names.push(coordOf(marks[i].p[0], marks[i].p[1]));
      }
      
      if (parts.length !== marks.length) {
        ui('setStatus', '<span style="color:#c0392b">' + T('no_board') + '</span>');
        balOff();
        return;
      }
      if (parts.length && HOST) {
        tellHost({ type: 'balance', on: true, gap: Math.round(boardGap()), cells: parts.join(';') });
      }
      
      balSet(marks.map(function (m) { return [m.p[0], m.p[1]]; }), true,
             'swap' + (empty ? '-empty' : '-pair'),
             marks.map(function (m) { return m.color; }));
      
      var filledN = marks.length - balFromEngine;
      ui('setStatus', '<b style="color:#0e7490">' + LT('swBalDone') + names.join('  ') + '</b>' +
        (filledN > 0 ? '<span style="color:#e67e22">' + LT('swBalFilled').replace('%1', filledN) + '</span>' : ''));
      
      var balPts = marks.map(function (m) { return [m.p[0], m.p[1]]; });
      if (adOn && parts.length === marks.length) {
        swQueue = balPts; swIdx = 0;
        swBtnState();                             
        setTimeout(swAdvance, 200);
      } else {
        
        pendingBal = balPts;
      }
    } catch (e) {
      ui('setStatus', '<span style="color:#c0392b">' + LT('balFail') +
        errText(e) + '</span>');
    } finally { swBusy = false; }
  }

  function swTip(h) {
    return '<span style="display:inline-block;font-size:15px;font-weight:600;line-height:1.35;' +
           'color:#0e7490;border:1px solid #33d6ff;border-radius:8px;padding:4px 12px;' +
           'background:rgba(51,214,255,0.08);box-shadow:0 0 6px rgba(51,214,255,0.25);">' + h + '</span>';
  }
  function swTipCol(h, c) {
    return '<span style="display:inline-block;font-size:15px;font-weight:600;line-height:1.35;' +
           'color:' + c + ';border:1px solid #33d6ff;border-radius:8px;padding:4px 12px;' +
           'background:rgba(51,214,255,0.08);box-shadow:0 0 6px rgba(51,214,255,0.25);">' + h + '</span>';
  }
  
  function swAdvColor(which) {
    try {
      var cs = getComputedStyle(document.body || document.documentElement);
      var v = cs.getPropertyValue(which === 'b' ? '--side-b-tgl' : '--side-w-tgl');
      if (v && v.trim()) return v.trim();
    } catch (e) {}
    if (which === 'b') return S.dark ? '#a78bfa' : '#8b5cf6';
    return S.dark ? '#58a6e0' : '#3b9ae1';
  }
  
  function swAdvHl(txt, which) {
    var tok = LT(which === 'b' ? 'swAdvB' : 'swAdvW');
    if (!tok || txt.indexOf(tok) < 0) return txt;
    return txt.replace(tok, '<b style="color:' + swAdvColor(which) +
                            ';font-weight:800;">' + tok + '</b>');
  }

  async function runSwapEval() {
    if (swEvalBusy) return;
    if (!boardGeo) { ui('setStatus', '<span style="color:#e67e22;">' + T('no_board') + '</span>'); return; }
    var ply = lastBl.length + lastWh.length;
    if (!ply) { ui('setStatus', swTipCol(LT('swEvalEmpty'), '#e67e22')); return; }
    if (ply > 5) {  
      ui('setStatus', swTipCol(LT('swEvalLate'), '#667'));
      return;
    }
    swEvalBusy = true;
    
    swQuietSide = true;
    if (S.side !== -1) setSide(-1);
    try {
      ui('setStatus', swTip(LT('swEvaling')));
      var toBlack = lastBl.length <= lastWh.length;
      var j = await wsCall('analyze', {
        board: boardMatrix(lastBl, lastWh), moveList: [],
        matchMs: 600000, turnMs: 2000, timeUsedMs: 0, topN: 1,
        rule: S.rule, lane: 'sub',
        cid: 'desktop-sweval-' + ply,
      }, 2000 + 15000);
      if (j && j.superseded) return;                 
      if (!j || j.error || !j.candidates || !j.candidates.length) {
        ui('setStatus', swTipCol(LT('swEvalFail') + ((j && j.error) || 'no candidates'), '#c0392b'));
        return;
      }
      var ev = j.candidates[0].eval || '';           
      var v = evalToNumber(ev);                       
      var blackView = toBlack ? v : -v;               
      var msg;
      
      if (Math.abs(blackView) < 50) msg = LT('swEvalEven').replace('%1', ev);
      else if (blackView > 0) msg = swAdvHl(LT('swEvalBlack').replace('%1', ev), 'b');
      else msg = swAdvHl(LT('swEvalWhite').replace('%1', ev), 'w');
      ui('setStatus', swTip(LT('swEvalDone') + msg));
    } catch (e) {
      ui('setStatus', swTipCol(LT('swEvalFail') + errText(e), '#c0392b'));
    } finally { swEvalBusy = false; }
  }

  async function handleScan(res) {
    var ok = applyScan(res);
    paintFrame();
    var bl = (res && res.black) || [], wh = (res && res.white) || [];
    if (!ok) {
      
      if (res && res.ok && res.suspect) {
        ui('setStatus', suspectTip(res));
        return;
      }
      
      if (lastBoardKey !== '__novis__') {
        lastBoardKey = '__novis__';
        emptyStreak = 0;
        pendingKey = ''; pendingN = 0;      
        resetForEmpty();
        postGuide(false);
        tellHost({ type: 'heat', on: false });
        balOff();
      }
      ui('setStatus', T('no_board'));
      return;
    }
    lastBl = bl; lastWh = wh;                  
    var key = boardKey(bl, wh);
    var emptyNow = (bl.length + wh.length === 0);
    if (emptyNow) emptyStreak++; else emptyStreak = 0;
    
    if (emptyNow && emptyStreak < 2) return;
    
    if (key === lastBoardKey) { pendingKey = ''; pendingN = 0; forceScan = false; return; }
    
    if (forceScan) {
      forceScan = false;                    
      pendingKey = ''; pendingN = 0;
    } else {
      
      if (key !== pendingKey) {
        var addB = deltaStones(bl, lastAdoptBl), addW = deltaStones(wh, lastAdoptWh);
        var rmB = deltaStones(lastAdoptBl, bl).length, rmW = deltaStones(lastAdoptWh, wh).length;
        if (addB.length + addW.length === 1 && rmB + rmW === 0) {
          pendingKey = ''; pendingN = 0;          
        } else {
          pendingKey = key; pendingN = 1; return;
        }
      } else {
        if (++pendingN < STABLE_FRAMES) return;
        pendingKey = ''; pendingN = 0;
      }
    }
    
    lastBoardKey = key;
    
    var rmPrev = deltaStones(lastAdoptBl, bl).length + deltaStones(lastAdoptWh, wh).length;
    if (rmPrev >= 2) newGamePending = true;
    lastAdoptBl = bl; lastAdoptWh = wh;      
    
    var plyNow = bl.length + wh.length;
    if ((emptyNow && plyPrev > 0) || (plyPrev - plyNow >= 4)) newGamePending = true;
    plyPrev = plyNow;
    if (emptyNow && adHadStones) adNewGameOff();
    adHadStones = !emptyNow;
    
    if (adOn) adConfirm();
    
    balOnBoardChanged(bl, wh);
    
    if (balMarks.length && balSticky) return;
    
    {
      var mEndPre = lastBoardMatrix();
      if (hasFiveOnBoard(mEndPre)) {
        if (adOn) adNewGameOff();
        if (adTimer) { clearTimeout(adTimer); adTimer = null; }
        adWaiting = false;
        engineBusy = false;
        analyzeRetryTimer = null;
        postGuide(false);
        tellHost({ type: 'heat', on: false });
        balOff();
        paintFrame();
        ui('setStatus', '<b style="color:#16a34a">' +
          (S.lang === 'en' ? 'Five in a row — game over, evaluation stopped.'
                            : '已经五子连珠 —— 本局结束，已停止评估。') + '</b>');
        return;
      }
    }
    
    if (sideUnset()) {
      haltNoSide();
      return;
    }
    
    {
      var mNow = lastBoardMatrix();
      if (!emptyNow && myIsToMove(bl, wh) && !hasFiveOnBoard(mNow)) {
        var myCol = myColOf();
        var winCells = findWinningFive(mNow, myCol);
        if (winCells.length) {
          var wc = winCells[0];
          postGuide(true, wc[0], wc[1]);         
          adLastPt = null;                       
          adFire(wc[0], wc[1], true, false);     
          diag('[finish] ' + (S.side === 0 ? 'B' : 'W') + ' wins at ' + coordOf(wc[0], wc[1]) + ' cells=' + winCells.length + ' | ' + boardDumpText());
          ui('setStatus', '<b style="color:#28a745">' +
            (S.lang === 'en'
              ? ('Winning move ' + coordOf(wc[0], wc[1]) + ' — five in a row, game over')
              : ('已落制胜子 ' + coordOf(wc[0], wc[1]) + ' —— 五子连珠，本局收官')) + '</b>');
          return;                                
        }
      }
    }
    
    {
      var mEnd = lastBoardMatrix();
      
      var o4 = findOpenFour(mEnd);
      if (o4 && o4.color !== myColOf() && Date.now() - lastOpen4Toast > 8000) {
        lastOpen4Toast = Date.now();
        diag('[open4] opponent open four ' + o4.cells.map(function (p) { return coordOf(p[0], p[1]); }).join(',') + ' | ' + boardDumpText());
        ui('setStatus', '<span style="color:#c0392b">' +
          (S.lang === 'en' ? 'Opponent open four (' : '对方活四（') +
          o4.cells.map(function (p) { return coordOf(p[0], p[1]); }).join('·') +
          (S.lang === 'en' ? ') — they win next move, respond now</span>'
                           : '）—— 下一手就赢，抓紧应对</span>'));
      }
    }
    
    if (!myIsToMove(bl, wh)) {
      waitOpponent();
      return;
    }
    if (emptyNow) {
      resetForEmpty();
      
      ui('setStatus', S.lang === 'en'
        ? 'Board located (empty) — analysis starts after the first move'
        : '已定位棋盘（空盘）· 落子后自动分析');
      postGuide(false);                     
      
      if (adOn && S.side === 0) {
        adLastPt = null;
        adFire((N - 1) >> 1, (N - 1) >> 1, true, true);
      }
    } else {
      
      analyze(bl, wh);
    }
    
    refreshHeatOverlay(bl, wh).catch(function () {});
  }

  function haltNoSide() {
    lastBest = null; lastMainC0 = null;
    S.candCache = [];
    S.rawEval = ''; S.myEval = '-'; S.lastStat = null;
    postGuide(false);
    tellHost({ type: 'heat', on: false });    
    balOff();                                 
    ['__gb_st_depth', '__gb_st_eval', '__gb_st_speed', '__gb_st_nodes', '__gb_st_line']
      .forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = '-'; });
    
    if (!sideHintMuted()) {
      ui('setStatus', '<span style="color:#e67e22;">' +
        (S.lang === 'en' ? 'I-play color not chosen — click Black or White to start evaluating.'
                         : '我执颜色未选定——请点「黑」或「白」开始评估（再点一次可取消）。') + '</span>');
    }
    paintFrame();
  }

  function waitOpponent() {
    ui('setStatus', '<span style="color:#555;">' +
      (S.lang === 'en' ? 'Waiting for opponent…' : '等待对手落子…') + '</span>');
    if (S.lastStat && S.lastStat.c0) ui('setStatPanel', S.lastStat.c0, S.lastStat.elapsed);
    ui('drawChart');                          
    postGuide(false);                         
    tellHost({ type: 'heat', on: false });    
    balOff();                                 
    paintFrame();
  }

  function offline() {
    boardRect = null; boardGeo = null;
    lastBest = null; lastMainC0 = null;
    paintFrame();
    postGuide(false);
    tellHost({ type: 'heat', on: false });
    balOff();
    pingEnsureDeps();                         
    
    ui('setStatus', '<span style="color:#c0392b">' +
      (S.lang === 'en'
        ? 'Not connected to the recognition service (localhost 8974/8975). This app restarts it automatically; if it stays down, check whether your security software is blocking it.'
        : '未连接到识别服务（本机 8974/8975）。本程序会自动重启它；若长时间不恢复，请检查是否被安全软件拦截。') +
      '</span>');
  }

  if (HOST) {
    window.chrome.webview.addEventListener('message', function (ev) {
      var msg = ev.data;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
      if (!msg) return;
      if (msg.type === 'scan') {
        if (busy) return;                       
        busy = true;
        Promise.resolve(handleScan(msg.data)).finally(function () { busy = false; });
      }
      else if (msg.type === 'offline') { offline(); }
      else if (msg.type === 'engineCfg') {
        
        cfgThreads = msg.threads | 0;
        cfgHashMB = msg.hashMB | 0;
        bridgeDiag('LINK_ENG_CFG threads=' + cfgThreads + ' hashMB=' + cfgHashMB + ' (follow main window)');
        applyEngineCfgSoon();
      }
      else if (msg.type === 'multiBoard') {
        
        var n = (msg && msg.n) ? msg.n : 2;
        
        ui('setStatus', '<span style="color:#e67e22;">' +
          (S.lang === 'en'
            ? (n + ' boards detected — close the others and keep only one')
            : ('检测到 ' + n + ' 个棋盘，请关闭其他棋盘，只保留一个')) +
          '</span>');
      }
      else if (msg.type === 'posState') {
        
        if (msg.open) { posConfirmed(); posBtnOn(true); }
        else { posBtnOn(false); }
      }
      else if (msg.type === 'posSave') {
        
        if (msg.ok) {
          ui('setStatus', (S.lang === 'en' ? 'Board image saved: ' : '棋盘图片已保存：') +
            '<span style="word-break:break-all">' + (msg.path || '') + '</span>');
        } else if (msg.reason === 'noboard') {
          ui('setStatus', S.lang === 'en'
            ? 'No board recognized yet — nothing to save'
            : '还没识别到棋盘，暂时没有可保存的局面');
        } else if (msg.reason === 'cancel') {
          
        } else {
          ui('setStatus', (S.lang === 'en' ? 'Save failed: ' : '保存失败：') + (msg.reason || '?'));
        }
      }
      else if (msg.type === 'autodropDone') {
        
        lastAdPipe = msg.pipeline || '';
        if (msg.pipeline === 'sendinput') {
          
        }
      }
      else if (msg.type === 'region') {
        
        if (msg.set) {
          ui('setStatus', S.lang === 'en'
            ? 'Scan region set — only this area is recognized'
            : '已设置识别区域（手动调节）：只在此区域内识别棋盘');
        } else {
          ui('setStatus', S.lang === 'en'
            ? 'Scan region cleared — full screen'
            : '已取消识别区域：恢复全屏自动找盘');
        }
      }
    });
  }

  async function tick() {
    if (busy || HOST) return;
    busy = true;
    try {
      var body = { size: N };
      // Locked-read fast path: once the board has been located, do not keep
      // re-searching the board on every frame. Reuse the locked geometry so
      // the vision service reads stones directly (~100ms). Only pressing the
      // recognize button (forceScan) clears the lock and re-locates the board.
      if (!forceScan && boardGeo && boardGeo.x_lines && boardGeo.y_lines &&
          boardGeo.x_lines.length === N && boardGeo.y_lines.length === N) {
        var xs = boardGeo.x_lines, ys = boardGeo.y_lines;
        var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
        var x1 = Math.max.apply(null, xs), y1 = Math.max.apply(null, ys);
        var sp = boardGeo.spacing > 0 ? boardGeo.spacing : 12;
        body.geometry = { x_lines: xs, y_lines: ys, spacing: sp };
        body.region = [Math.round(x0 - sp * 0.6), Math.round(y0 - sp * 0.6),
                       Math.round(x1 - x0 + sp * 1.2), Math.round(y1 - y0 + sp * 1.2)];
      }
      await handleScan(await fetchJSON(SCAN_URL, body, 9000));
    } catch (e) {
      offline();
    } finally { busy = false; }
  }

  function on(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }

  on('__gb_rec', 'click', function () { lastBoardKey = ''; forceScan = true; S.history = []; ui('drawChart'); tick(); });
  on('__gb_analyze', 'click', function () { var k = lastBoardKey; lastBoardKey = ''; forceScan = true; tick().then(function () { lastBoardKey = k; }); });
  
  on('__gb_autodrop', 'click', function () {
    
    if (swQueue) { ui('setStatus', swTipCol(LT('adBusyQueue'), '#0e7490')); return; }
    adOn = !adOn;
    adLastPt = null; swQueue = null; adFail = 0; adDone = 0;
    if (!adOn && adTimer) { clearTimeout(adTimer); adTimer = null; adWaiting = false; }
    adBtnSync();
    
    if (adOn && pendingBal && pendingBal.length) {
      
      var pmm = lastBoardMatrix();
      var ptodo = pendingBal.filter(function (p) { return !(pmm[p[1]] && pmm[p[1]][p[0]]); });
      pendingBal = null;
      if (ptodo.length) { swQueue = ptodo; swIdx = 0; adStage = 0; swBtnState(); setTimeout(swAdvance, 200); }
    }
    else if (adOn && S.side === 0 && lastBl.length + lastWh.length === 0) {
      adFire((N - 1) >> 1, (N - 1) >> 1, true, true);
    }
    
    else if (adOn && boardGeo && !sideUnset() &&
             lastBl.length + lastWh.length > 0 && myIsToMove(lastBl, lastWh)) {
      lastBoardKey = ''; pendingKey = ''; pendingN = 0; forceScan = true;
      if (!HOST) tick();
    }
    ui('setStatus', '<b style="color:' + (adOn ? '#28a745' : '#555') + '">' +
      LT(adOn ? 'adOn' : 'adOff') + '</b>');
  });
  on('__gb_adcount', 'click', function () {
    adCount = adCount % 3 + 1;                        
    try { localStorage.setItem('gb_ad_count', String(adCount)); } catch (e) {}
    adBtnSync();
    ui('setStatus', LT('adCount') + '×' + adCount);
  });

  on('__gb_swbal', 'click', function () {
    
    runSwapBal();
  });
  on('__gb_sweval', 'click', function () { runSwapEval(); });
  adBtnSync();                                        

  function posBtnLang() {
    var b = document.getElementById('__gb_pos');
    if (b) b.textContent = (S.lang === 'en') ? 'Position' : '局面';
    
    var sb = document.getElementById('__gb_possave');
    if (sb) sb.textContent = (S.lang === 'en') ? 'Save board' : '保存局面';
  }
  
  function balBtnLang() {  }
  
  function swBtnLang() {
    var b = document.getElementById('__gb_autodrop');
    var s1 = document.getElementById('__gb_swbal'), s2 = document.getElementById('__gb_sweval');
    if (b) b.textContent = LT('adBtn');
    if (s1) s1.textContent = LT('swBalBtn');
    if (s2) s2.textContent = LT('swEvalBtn');
  }
  
  function posBtnOn(on) {
    var b = document.getElementById('__gb_pos');
    if (!b) return;
    if (on) b.setAttribute('data-on', '1');
    else b.removeAttribute('data-on');
  }
  
  var FOOT_ACTIONS = {
    __gb_pos: function () { askPosition(); },
    
    __gb_possave: function () { tellHost({ type: 'savePosPng' }); },
    __gb_adjust: function () { tellHost({ type: 'startAdjust' }); },
  };
  
  var posRetry = null, posTries = 0;
  function askPosition() {
    posTries = 0;
    if (posRetry) { clearTimeout(posRetry); posRetry = null; }
    sendOpenPos();
  }
  function sendOpenPos() {
    tellHost({ type: 'openPos', try: posTries + 1 });
    posTries++;
    if (posRetry) clearTimeout(posRetry);
    if (posTries >= 3) { posRetry = null; return; }
    posRetry = setTimeout(function () { sendOpenPos(); }, 800);
  }
  function posConfirmed() {
    if (posRetry) { clearTimeout(posRetry); posRetry = null; }
  }
  
  function fireFoot(id, e) {
    if (!FOOT_ACTIONS[id]) return;
    if (e && e.__gbFootDone) return;
    if (e) e.__gbFootDone = true;
    
    tellHost({ type: 'footClick', id: id });
    FOOT_ACTIONS[id]();
  }
  function bindFootDirect() {
    Object.keys(FOOT_ACTIONS).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.__gbFootBound) return;
      el.__gbFootBound = true;
      el.addEventListener('click', function (e) { fireFoot(id, e); }, false);
    });
  }
  bindFootDirect();
  
  if (window.MutationObserver) {
    new MutationObserver(function () { bindFootDirect(); }).observe(document.documentElement,
      { childList: true, subtree: true });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      if (t.id && FOOT_ACTIONS[t.id]) { fireFoot(t.id, e); return; }
      t = t.parentElement;
    }
  }, false);
  
  function footProbeLine() {
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      var ids = Object.keys(FOOT_ACTIONS), rep = [];
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) { rep.push(id + '=MISSING'); return; }
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var hit = null;
        try { hit = document.elementFromPoint(cx, cy); } catch (e) {}
        var hitId = hit ? (hit.id || hit.tagName) : 'null';
        var inView = (r.top >= -1 && r.bottom <= vh + 1 && r.width > 0 && r.height > 0);
        rep.push(id + '=[' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
                 Math.round(r.width) + 'x' + Math.round(r.height) +
                 ' bottom=' + Math.round(r.bottom) +
                 (inView ? ' 在视口内' : ' 视口外!') +
                 ' hit=' + hitId + (hit === el ? '(OK)' : '(被挡!)') + ']');
      });
      var pan = document.getElementById('__gb_panel');
      var bod = document.getElementById('__gb_body');
      var pr = pan ? pan.getBoundingClientRect() : null;
      var extra = '';
      if (pr) extra += ' panel=' + Math.round(pr.width) + 'x' + Math.round(pr.height) +
                        ' bottom=' + Math.round(pr.bottom) + (pr.bottom > vh + 1 ? '(超视口!)' : '');
      if (bod) extra += ' body=' + bod.clientHeight + '/' + bod.scrollHeight +
                        '@' + Math.round(bod.scrollTop);
      tellHost({ type: 'footProbe', ids: rep.join(' | '),
                 vw: vw, vh: vh, extra: extra,
                 bar: !!document.getElementById('__gb_footbar') });
    } catch (e) {}
  }
  setTimeout(footProbeLine, 1200);
  setTimeout(footProbeLine, 3000);          

  function sideUnset() { return S.side !== 0 && S.side !== 1; }
  function applySideUI() {
    var b = document.getElementById('__gb_side_black'), w = document.getElementById('__gb_side_white');
    var txt = document.getElementById('__gb_side_txt');
    var dk = !!S.dark;
    var unset = sideUnset();
    var baseBg = dk ? '#262b3a' : '#fff';
    var baseFg = dk ? '#c8ccd6' : '#555';
    var baseBd = dk ? '#5a6072' : '#999';
    function paint(el, isBlack, on) {
      if (!el) return;
      if (on) {
        el.style.background = isBlack ? '#1a1a1a' : '#fff';
        el.style.color = isBlack ? '#fff' : '#111';
        el.style.border = '2px solid ' + (isBlack ? '#000' : '#111');
        el.style.boxShadow = isBlack ? '0 0 0 1.5px #fff inset' : 'none';
      } else {
        el.style.background = baseBg; el.style.color = baseFg;
        el.style.border = '1px solid ' + baseBd; el.style.boxShadow = 'none';
      }
      el.style.fontWeight = on ? '800' : '600';
      
      el.style.opacity = (on || unset) ? '1' : '0.45';
      el.style.padding = on ? '1px 5px' : '2px 6px';
    }
    paint(b, true, S.side === 0);
    paint(w, false, S.side === 1);
    var en = (S.lang === 'en');
    if (b) b.title = en ? 'I play Black (click again to unlock)' : '我执黑（再点一次取消）';
    if (w) w.title = en ? 'I play White (click again to unlock)' : '我执白（再点一次取消）';
    if (txt) {
      if (unset) {
        txt.textContent = en ? 'pick B/W' : '请选黑/白';
        txt.style.color = '#e67e22';
      } else {
        txt.textContent = (en ? 'locked' : '锁定') + '·' + T(S.side === 0 ? 'black' : 'white');
        txt.style.color = '#2e7d32';
      }
    }
  }
  
  function setSide(v) {
    
    var quiet = swQuietSide && v === -1;
    if (v !== -1) swQuietSide = false;
    S.side = (S.side === v) ? -1 : v;        
    S.candCache = [];
    lastBest = null; lastMainC0 = null;
    S.history = [];
    S.rawEval = ''; S.myEval = '-';
    lastBoardKey = ''; forceScan = true;
    saveNow(); applySideUI(); ui('drawChart');
    
    S.lastStat = null;
    ['__gb_st_depth', '__gb_st_eval', '__gb_st_speed', '__gb_st_nodes', '__gb_st_line']
      .forEach(function (id) { var el = document.getElementById(id); if (el) el.textContent = '-'; });
    tellHost({ type: 'heat', on: false });     
    balOff();                                  
    postGuide(false);                          
    if (!quiet) {
      ui('setStatus', sideUnset()
        ? '<span style="color:#e67e22;">' +
          (S.lang === 'en' ? 'Side unlocked — pick Black or White to start evaluating.'
                           : '已取消我执颜色——未选定前不评估，请点「黑」或「白」。') + '</span>'
        : '<span style="color:#3b7dd8;">' +
          (S.lang === 'en' ? 'Locked to ' + (S.side === 0 ? 'Black' : 'White') + ' — re-analyzing for this side only…'
                           : '已锁定我执' + (S.side === 0 ? '黑' : '白') + '——只按这一方重新评估…') + '</span>');
    }
    if (!HOST) tick();
  }
  on('__gb_side_black', 'click', function () { setSide(0); });
  on('__gb_side_white', 'click', function () { setSide(1); });

  function kickAnalyze() {
    lastBoardKey = '';
    forceScan = true;          
    S.candCache = [];
    if (!HOST) tick();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.__gb_step'), function (b) {
    b.addEventListener('click', function () {
      var d = b.getAttribute('data-dir');
      if (d === 'turn+') S.customTurnSec = Math.min(6000, Math.round((S.customTurnSec + 0.25) * 100) / 100);
      else if (d === 'turn-') S.customTurnSec = Math.max(0.5, Math.round((S.customTurnSec - 0.25) * 100) / 100);
      else if (d === 'match+') S.customSec = Math.min(30000, S.customSec + 10);
      else if (d === 'match-') S.customSec = Math.max(10, S.customSec - 10);
      else if (d === 'hash+') { S.hashMB = Math.min(4096, S.hashMB + 128); ui('applyHash'); }
      else if (d === 'hash-') { S.hashMB = Math.max(0, S.hashMB - 128); ui('applyHash'); }
      ui('applyPreset');
      kickAnalyze();
    });
  });

  var turnInp = document.getElementById('__gb_turnval');
  var matchInp = document.getElementById('__gb_matchval');
  function sanitizeTurn(v) {
    v = String(v).replace(/[^\d.]/g, '');               
    var p = v.split('.');
    if (p.length > 2) v = p[0] + '.' + p.slice(1).join('');   
    if (v.indexOf('.') >= 0) { var h = v.split('.'); v = h[0] + '.' + h[1].slice(0, 2); }  
    return v;
  }
  function sanitizeMatch(v) { return String(v).replace(/[^\d]/g, ''); }
  if (turnInp) {
    turnInp.addEventListener('input', function () { this.value = sanitizeTurn(this.value); });
    turnInp.addEventListener('change', function () {
      var t = parseFloat(turnInp.value);
      if (isFinite(t)) S.customTurnSec = Math.min(6000, Math.max(0.5, Math.round(t * 100) / 100));
      ui('applyPreset'); kickAnalyze();
    });
  }
  if (matchInp) {
    matchInp.addEventListener('input', function () { this.value = sanitizeMatch(this.value); });
    matchInp.addEventListener('change', function () {
      var m = parseFloat(matchInp.value);
      if (isFinite(m)) S.customSec = Math.min(30000, Math.max(10, Math.round(m)));
      ui('applyPreset'); kickAnalyze();
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-rule]'), function (el) {
    el.addEventListener('click', function () {
      S.rule = +el.getAttribute('data-rule');
      saveNow(); ui('paintSel'); kickAnalyze();
    });
  });

  on('__gb_heat', 'click', function () {
    S.heatmap = !S.heatmap; saveNow(); ui('paintHeat');
    kickAnalyze();
  });

  try {
    var verHdr = document.getElementById('__gb_hdr');
    if (verHdr && !document.getElementById('__gb_ver')) {
      var verEl = document.createElement('span');
      verEl.id = '__gb_ver';
      verEl.textContent = GB_VER;
      verEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,.78);letter-spacing:.3px;'
        + 'font-variant-numeric:tabular-nums;user-select:none;flex:none;margin:0 2px;line-height:1;';
      verHdr.insertBefore(verEl, document.getElementById('__gb_lang'));
    }
  } catch (e) {}

  on('__gb_dark', 'click', function () { S.dark = !S.dark; saveNow(); ui('applyDark'); ui('drawChart'); applySideUI(); });
  on('__gb_lang', 'click', function () {
    S.lang = (S.lang === 'en') ? 'zh' : 'en'; saveNow(); ui('applyLang'); applySideUI(); posBtnLang();
    balBtnLang();
    swBtnLang();
    
    setTimeout(reportPanelRect, 30);
  });
  
  var opRange = document.getElementById('__gb_opacity_range');
  var opNum = document.getElementById('__gb_opacity_num');
  var blurRange = document.getElementById('__gb_blur_range');
  var blurNum = document.getElementById('__gb_blur_num');
  if (opRange) opRange.addEventListener('input', function () {
    S.opacity = +opRange.value;
    if (opNum) opNum.value = S.opacity;
    ui('applyOpacity');
  });
  if (opNum) opNum.addEventListener('change', function () {
    var v = parseInt(opNum.value, 10);
    if (!(v >= 25 && v <= 100)) { v = (S.opacity >= 25 && S.opacity <= 100) ? S.opacity : 100; opNum.value = v; }
    S.opacity = v; ui('applyOpacity');
  });
  
  if (blurRange) blurRange.addEventListener('input', function () {
    S.blur = +blurRange.value;
    if (S.blur < 0) S.blur = 0;
    if (S.blur > 50) S.blur = 50;
    if (blurNum) blurNum.value = S.blur;
    ui('applyBlur');
  });
  if (blurNum) blurNum.addEventListener('change', function () {
    var v = parseInt(blurNum.value, 10);
    if (!(v >= 0 && v <= 50)) { v = (S.blur >= 0 && S.blur <= 50) ? S.blur : 15; blurNum.value = v; }
    S.blur = v; ui('applyBlur');
  });
  on('__gb_opacity', 'click', function (ev) {
    
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var pop = document.getElementById('__gb_opacity_pop');
    if (pop) pop.style.display = (pop.style.display === 'flex') ? 'none' : 'flex';
    setTimeout(reportPanelRect, 30);
  });
  
  document.addEventListener('click', function (ev) {
    var pop = document.getElementById('__gb_opacity_pop');
    if (!pop || pop.style.display !== 'flex') return;
    var t = ev.target;
    if (!(t && t.closest && t.closest('#__gb_opacity,#__gb_opacity_pop'))) {
      pop.style.display = 'none';
      setTimeout(reportPanelRect, 30);
    }
  });

  on('__gb_close', 'click', function () { tellHost({ type: 'quitApp' }); });
  
  on('__gb_min', 'click', function () { tellHost({ type: 'minToTaskbar' }); });

  function bootStep(tag) {
    try {
      var cv = window.chrome && window.chrome.webview;
      if (cv && cv.postMessage) cv.postMessage(JSON.stringify({ type: 'bootStep', at: tag }));
    } catch (e) {}
  }

  function boot() {
    bootStep('0 进入 boot');
    ui('initState');                 
    bootStep('1 initState 完成');
    
    if (S.side !== 0 && S.side !== 1) S.side = -1;
    
    bootStep('2 进入主流程（页面画布在宿主模式下交给覆盖层）');

    ui('applyDark'); bootStep('4 applyDark'); ui('applyLang'); bootStep('5 applyLang');
    ui('applyOpacity'); bootStep('6 applyOpacity'); ui('applyBlur'); bootStep('7 applyBlur');
    
    posBtnLang();
    balBtnLang();
    swBtnLang();
    ui('paintHeat'); ui('paintOpp'); ui('paintSel'); ui('paintToggle');
    bootStep('8 paint* 完成');
    applySideUI();
    bootStep('9 applySideUI 完成');
    
    ui('drawChart');
    bootStep('10 drawChart 完成');
    ui('setStatus', T('connecting') || '连接引擎…');
    bootStep('11 setStatus 完成');
    wsConnect();                              

    reportPanelRect();
    bootStep('12 已上报位置');
    
    var cv = window.chrome && window.chrome.webview;
    if (cv && cv.postMessage) {
      cv.postMessage(JSON.stringify({
        type: 'ready',
        uiFns: (UI.names || []).length,
        ids: document.querySelectorAll('[id^="__gb_"]').length,
      }));
    }
    bootStep('13 已发 ready');
    setInterval(reportPanelRect, 700);
    
    setTimeout(function () {
      try {
        resizeCanvas();
        bootStep('3 resizeCanvas 完成（延后）');
      } catch (e) {
        bootStep('2x resizeCanvas 异常：' + (e && e.message));
      }
    }, 0);
    if (!HOST) setInterval(tick, 900);
    tick();
  }
  
  window.GB_LINK_SWAPBAL = runSwapBal;
  window.GB_LINK_SWAPEVAL = runSwapEval;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
