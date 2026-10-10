/* Panel UI logic. */


(function () {
  'use strict';
  var S = window.GB_S = window.GB_S || {};   
  var N = 15;
  var I18N = {
      zh: {
        title: '五子棋助手', think: '思考时间', preset3: '快棋(一局约3分钟)', preset5: '中棋(一局约5分钟)',
        preset15: '慢棋(一局约15分钟)', custom: '自定义', turn: '步时(秒)', match: '局时(秒)',
        rule: '规则', rule0: '无禁手', rule1: '无禁手长连不赢', rule2: '有禁手', rule5: '无禁手一手交换',
        iplay: '我执', auto: '自动落子', autoOpt: '自动', black: '黑子', white: '白子', manual: '手动调节', dark: '深色模式', light: '浅色模式',
        opacity: '透明度', blur: '模糊度',
        heat: '热力图', heatBest: '最佳', heatGood: '较优', heatMid: '一般', heatLow: '较弱',
        oppMoves: '对手落点评估',
        hash: '哈希表', hashUnit: 'MB', hashAuto: '自动',
        reidentify: '重新识别', analyze: '分析', deep: '深算', lang: 'EN',
        connecting: '连接引擎…', curve: '思考后显示评估曲线',
        colDepth: '深度', colEval: '评估', colSpeed: '速度', colNodes: '节点',
        no_board: '未检测到棋盘（把棋盘显示在屏幕上、别让其它窗口挡住；点「重新识别」可立即重扫）',
        swapHint: '交换棋提示：塔拉尼科夫 / 塔拉山口-10 等交换类规则，请先关闭「自动落子」，手动完成交换后再点开自动下棋。',
        thinking: '思考中…', copied: '局面代码已复制', fenlabel: '局面',
        posBtn: '局面', posSave: '保存局面', posWinTtl: '局面',
        posEmpty: '还没有识别到棋盘，先「分析」一次再来看局面',
        posSaveOk: '局面图已保存', posSaveFail: '保存失败：', posCopy: '复制',
      },
      en: {
        title: 'Gomoku Assistant', think: 'Move Time', preset3: 'Blitz (~3 min)', preset5: 'Normal (~5 min)',
        preset15: 'Long (~15 min)', custom: 'Custom', turn: 'Turn (s)', match: 'Game (s)',
        rule: 'Rules', rule0: 'Freestyle', rule1: 'Freestyle (no overline)', rule2: 'Renju', rule5: 'Freestyle (swap)',
        iplay: 'Me', auto: 'Auto-play', autoOpt: 'Auto', black: 'Black', white: 'White', manual: 'Adjust', dark: 'Dark mode', light: 'Light mode',
        opacity: 'Opacity', blur: 'Blur',
        heat: 'Heatmap', heatBest: 'Best', heatGood: 'Good', heatMid: 'Fair', heatLow: 'Weak',
        oppMoves: 'Opp. eval',
        hash: 'Hash', hashUnit: 'MB', hashAuto: 'Auto',
        reidentify: 'Re-scan', analyze: 'Analyze', deep: 'Deep', lang: '中',
        connecting: 'Connecting engine…', curve: 'Eval curve after thinking',
        colDepth: 'Depth', colEval: 'Eval', colSpeed: 'Speed', colNodes: 'Nodes',
        no_board: 'No board detected. Keep the board visible on screen and not covered by other windows; press Re-scan to retry.',
        swapHint: 'Swap rules tip: for Tarannikov / Taraguchi-10 and other swap rules, turn OFF Auto-play first, do the swap manually, then turn Auto-play back on.',
        thinking: 'Thinking…', copied: 'Position code copied', fenlabel: 'Pos',
        posBtn: 'Position', posSave: 'Save position', posWinTtl: 'Position',
        posEmpty: 'No board recognized yet — run Analyze first',
        posSaveOk: 'Position image saved', posSaveFail: 'Save failed: ', posCopy: 'Copy',
      }
    };
    
  function T(k) { var d = I18N[S.lang === 'en' ? 'en' : 'zh']; return d[k] || (I18N.zh[k] || k); }
  var root = document.getElementById('__gb_panel');
  var statusEl = document.getElementById('__gb_status');
  var _prevOp = 100;
  var oldP = document.getElementById('__gb_panel');
  var oldO = document.getElementById('__gb_overlay');
  var oldC = document.getElementById('__gb_calib');
  var oldA = document.getElementById('__gb_adjbox');
  var pwEl = document.getElementById('__gb_poswin');
  var b = document.getElementById('__gb_body');
  var w = document.getElementById('__gb_poswin');
  var hd = document.getElementById('__gb_poswin_hd');
  var pre = document.getElementById('__gb_poswin_code');
  var cp = document.getElementById('__gb_poswin_copy');
  var cv = document.getElementById('__gb_poswin_cv');
  var codeEl = document.getElementById('__gb_poswin_code');
  var cntEl = document.getElementById('__gb_poswin_cnt');
  var posBtn = document.getElementById('__gb_pos');
  var saveBtn = document.getElementById('__gb_possave');
  var hdr = document.getElementById('__gb_hdr');
  var autoBtn = document.getElementById('__gb_auto');
  var darkBtn = document.getElementById('__gb_dark');
  var langBtn = document.getElementById('__gb_lang');
  var body = document.getElementById('__gb_body');
  var stEl = document.getElementById('__gb_status');
  var lgEl = document.getElementById('__gb_legend');
  var st = document.getElementById('__gb_status');
  var opRg = document.getElementById('__gb_opacity_range');
  var brRg = document.getElementById('__gb_blur_range');
  var rec = document.getElementById('__gb_rec');
  var an = document.getElementById('__gb_analyze');
  var dp = document.getElementById('__gb_deep');
  var ad = document.getElementById('__gb_adjust');
  var opB = document.getElementById('__gb_opacity');
  var opPopEl = document.getElementById('__gb_opacity_pop');
  var db = document.getElementById('__gb_dark');
  var cvw = document.getElementById('__gb_chart_wrap');
  var stLine = document.getElementById('__gb_st_line');
  var stFen = document.getElementById('__gb_st_fen');
  var hv = document.getElementById('__gb_hashval');
  var adBtn = document.getElementById('__gb_adjust');
  var tv = document.getElementById('__gb_turnval');
  var mv = document.getElementById('__gb_matchval');
  var turnInp = document.getElementById('__gb_turnval');
  var matchInp = document.getElementById('__gb_matchval');
  var sideBlack = document.getElementById('__gb_side_black');
  var sideWhite = document.getElementById('__gb_side_white');
  var sideTxtEl = document.getElementById('__gb_side_txt');
  var heatBtn = document.getElementById('__gb_heat');
  var lg = document.getElementById('__gb_legend');
  var oppBtn = document.getElementById('__gb_opp');
  var oppIcon = document.getElementById('__gb_opp_icon');
  var opBtn = document.getElementById('__gb_opacity');
  var opPop = document.getElementById('__gb_opacity_pop');
  var opRange = document.getElementById('__gb_opacity_range');
  var opNum = document.getElementById('__gb_opacity_num');
  var blurRange = document.getElementById('__gb_blur_range');
  var blurNum = document.getElementById('__gb_blur_num');
  var csc = document.getElementById('__gb_chart_scroll');
  var ya = document.getElementById('__gb_yaxis');
  var statusEl = document.getElementById('__gb_status');
  var lineEl = document.getElementById('__gb_st_line');
  var pan = document.getElementById('__gb_panel');
  var S_DEFAULTS = {
      rule: 0,            
      preset: '3min',     
      matchMs: 6000000,   
      turnMs: 5000,       
      side: -1,           
      userSide: -1,       
      autoPlay: false,
      heatmap: false,    
      oppMoves: false,   
      realClick: false,  
      lang: 'zh',         
      dark: false,        
      opacity: 100,       
      blur: 0,           
      hashMB: 0,          
                          
      customSec: 6000,    
      customTurnSec: 5,   
      lastFp: '',
      timeUsedGame: 0,
      analyzing: false,
      history: [],        
      score: 0,           
      rawEval: '',        
      myEval: '',         
      verdict: 'none',    
      matePly: 0,         
      moves: [],          
      candCache: [],
      lastStat: null,     
    };
  function initState() {
    for (var _k in S_DEFAULTS) if (S[_k] === undefined) S[_k] = S_DEFAULTS[_k];
    try {
        var s = JSON.parse(localStorage.getItem('gb_state') || '{}');
        if (!s.__v || s.__v < 4) { s.oppMoves = false; s.heatmap = false; s.__v = 4; }   
        if (s.__v < 5) { if (s.rule === 5) s.rule = 0; s.__v = 5; }   
        if (s.__v < 6) { s.autoPlay = false; s.__v = 6; }             
        if (s.__v < 7) { if (s.hashMB === 256) s.hashMB = 0; s.__v = 7; }   
        for (var k in s) if (k !== 'analyzing') S[k] = s[k];   
      } catch (e) {}
      S.analyzing = false;
  }

  function save() {
      try {
        var c = Object.assign({}, S);
        c.analyzing = false;   
        localStorage.setItem('gb_state', JSON.stringify(c));
      } catch (e) {}
    }

  var CHART_FIT = 15;

  function drawChart() {
      var cv = document.getElementById('__gb_chart');
      if (!cv) return;
      var ctx = cv.getContext('2d');
      var H = 100;
      var padL = 4, padR = 4, padT = 5, padB = 8;
      var csc = document.getElementById('__gb_chart_scroll');
      var viewW = (csc && csc.clientWidth) ? csc.clientWidth : 0;
      if (viewW < 80) viewW = 195;                 
      var pts = S.history;                         
      var n = pts.length;
      var innerW0 = viewW - padL - padR;           
      
      var denom = (n <= CHART_FIT) ? Math.max(1, n - 1) : (CHART_FIT - 1);
      var step = innerW0 / denom;
      var contentW = padL + padR + (n > 1 ? (n - 1) * step : 0);
      var W = Math.max(Math.round(viewW), Math.round(contentW));
      cv.width = W; cv.height = H;
      ctx.clearRect(0, 0, W, H);
      var innerW = W - padL - padR, innerH = H - padT - padB;
      var midY = padT + innerH / 2;
      var labelCol = S.dark ? '#7d8390' : '#000';
      
      var RANGE = 1000;
      var yOf = function (v) { return midY - (v / RANGE) * innerH / 2; };
      
      ctx.lineWidth = 1;
      for (var g = -1000; g <= 1000; g += 250) {
        var gy = yOf(g);
        if (g === 0) { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.28)' : '#c2c8d0'; ctx.setLineDash([]); }
        else if (Math.abs(g) === 1000) { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.22)' : '#d8dde4'; ctx.setLineDash([]); }
        else if (Math.abs(g) === 500) { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.14)' : '#e8eaee'; ctx.setLineDash([]); }
        else { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.10)' : '#eef0f3'; ctx.setLineDash([3, 3]); }
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      }
      ctx.setLineDash([]);
      
      var ya = document.getElementById('__gb_yaxis');
      if (ya) {
        ya.innerHTML = '';
        for (var g2 = -1000; g2 <= 1000; g2 += 250) {
          var gy2 = yOf(g2);
          var sp = document.createElement('span');
          sp.textContent = (g2 > 0 ? '+' : '') + g2;
          sp.style.cssText = 'position:absolute;right:2px;font-size:' + (g2 % 500 === 0 ? 8 : 7) + 'px;color:' + labelCol + ';line-height:1px;transform:translateY(-50%);' + (g2 % 500 !== 0 && g2 !== 0 ? 'opacity:.5;' : '');
          sp.style.top = gy2 + 'px';
          ya.appendChild(sp);
        }
      }

      if (n < 1) {
        ctx.fillStyle = S.dark ? '#8a90a0' : '#9aa5b1'; ctx.font = '10px sans-serif';
        ctx.fillText(T('curve'), padL + 6, midY + 3);
        return;
      }
      
      var px = function (k) { return (n <= 1) ? (padL + innerW0 / 2) : (padL + k * step); };
      var curV = Math.max(-1000, Math.min(1000, pts[n - 1].v));
      var py = yOf;
      
      var lineColor = curV < 0 ? '#f1c40f' : '#3b7dd8';
      var fillColor = curV < 0 ? 'rgba(241,196,15,.22)' : 'rgba(59,125,216,.14)';
      
      function tracePath() {
        ctx.beginPath();
        ctx.moveTo(px(0), py(pts[0].v));
        if (n === 2) { ctx.lineTo(px(1), py(pts[1].v)); return; }
        if (n < 3) return;
        for (var i = 0; i < n - 1; i++) {
          var p0 = pts[Math.max(0, i - 1)].v, p1 = pts[i].v, p2 = pts[i + 1].v, p3 = pts[Math.min(n - 1, i + 2)].v;
          var x1 = px(i), y1 = py(p1), x2 = px(i + 1), y2 = py(p2);
          var c1x = x1 + (px(Math.min(n - 1, i + 1)) - px(Math.max(0, i - 1))) / 6;
          var c1y = y1 + (py(p2) - py(p0)) / 6;
          var c2x = x2 - (px(Math.min(n - 1, i + 2)) - px(i)) / 6;
          var c2y = y2 - (py(p3) - py(p1)) / 6;
          ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2);
        }
      }
      tracePath();
      if (n >= 2) { ctx.lineTo(px(n - 1), py(0)); ctx.lineTo(px(0), py(0)); ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill(); }
      tracePath();
      if (n >= 2) { ctx.strokeStyle = lineColor; ctx.lineWidth = 1.8; ctx.stroke(); }
      ctx.fillStyle = lineColor;
      for (var i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(px(i), py(pts[i].v), 2.6, 0, 7); ctx.fill(); }
      
      if (csc) csc.scrollLeft = csc.scrollWidth;
    }

  function fmtKMG(v) {
      v = Number(v) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
      if (v >= 1e3) return Math.round(v / 1e3) + 'K';
      return String(Math.round(v));
    }

  function coordLower(i, j) { return String.fromCharCode(97 + i) + (N - j); }

  function rawEvalText() {
      var s = S.myEval;
      if (typeof s === 'string' && s.length) return s.trim();
      s = S.rawEval;                                  
      if (typeof s === 'string' && s.length) return s.trim();
      return '-';
    }

  function setStatus(html) {
      
      if (window.__gbCopyUntil && Date.now() < window.__gbCopyUntil && html.indexOf('#c0392b') < 0) return;
      statusEl.innerHTML = html;
    }

  function setStatPanel(c0, elapsed) {
      function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
      set('__gb_st_depth', c0.depth ? c0.depth : '-');
      
      var ev = rawEvalText();
      set('__gb_st_eval', ev);
      set('__gb_st_speed', c0.speed ? fmtKMG(c0.speed) : '-');
      set('__gb_st_nodes', c0.nodes ? fmtKMG(c0.nodes) : '-');
      var coords = '';
      var lineEl = document.getElementById('__gb_st_line');
      if (lineEl) {
        if (c0.line && c0.line.length) {
          coords = c0.line.slice(0, 14).map(function (p) { return String.fromCharCode(65 + p[0]) + (N - p[1]); }).join(' ');
          lineEl.textContent = (S.lang === 'en' ? 'PV ' : '路线 ') + coords;
        } else lineEl.textContent = '';
      }
      
      var snap = JSON.stringify({
        depth: c0.depth || '-', eval: ev, speed: c0.speed ? fmtKMG(c0.speed) : '-',
        nodes: c0.nodes ? fmtKMG(c0.nodes) : '-', coords: coords
      });
      try { localStorage.setItem('gb_lastStat', snap); } catch (e) {}
      try { window.name = '__gb_lastStat=' + snap; } catch (e) {}
    }

  function setStatPanelThinking() {
      
      if (!S.lastStat) {
        function stSet(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
        stSet('__gb_st_depth', '…'); stSet('__gb_st_eval', '…');
        stSet('__gb_st_speed', '…'); stSet('__gb_st_nodes', '…');
      }
    }

  function refreshStatLang() {
      if (S.lastStat) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
    }

  function fillStatFromCache() {
      var data = null;
      try { data = JSON.parse(localStorage.getItem('gb_lastStat') || 'null'); } catch (e) {}
      if (!data && window.name && window.name.indexOf('__gb_lastStat=') === 0) {
        try { data = JSON.parse(window.name.slice('__gb_lastStat='.length)); } catch (e) {}
      }
      if (!data) return;
      function set(id, v) { var el = document.getElementById(id); if (el && v) el.textContent = v; }
      set('__gb_st_depth', data.depth); set('__gb_st_eval', data.eval);
      set('__gb_st_speed', data.speed); set('__gb_st_nodes', data.nodes);
      var lineEl = document.getElementById('__gb_st_line');
      if (lineEl && data.coords) lineEl.textContent = (S.lang === 'en' ? 'PV ' : '路线 ') + data.coords;
    }

  function applyDark() {
      root.setAttribute('data-dark', S.dark ? '1' : '0');
      darkBtn.textContent = S.dark ? T('light') : T('dark');
      var d = S.dark;
      root.style.borderColor = d ? '#000' : '#e2e5ea';
      
      var body = document.getElementById('__gb_body');
      if (body) body.style.color = d ? '#e6e8ee' : '#000';
      
      Array.prototype.forEach.call(root.querySelectorAll('.__gb_opt'), function (el) {
        el.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0';
        el.style.color = d ? '#c8ccd6' : '#000';
      });
      Array.prototype.forEach.call(root.querySelectorAll('.__gb_lbl,.__gb_lbl2'), function (el) {
        el.style.color = d ? '#c8ccd6' : (el.classList.contains('__gb_lbl2') ? '#000' : '#000');
      });
      var stEl = document.getElementById('__gb_status');
      if (stEl) stEl.style.color = d ? '#c8ccd6' : '#000';
      var lgEl = document.getElementById('__gb_legend');
      if (lgEl) { lgEl.style.color = d ? '#888' : '#000'; lgEl.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0'; }
      var st = document.getElementById('__gb_status');
      if (st) st.style.borderTopColor = d ? '#333846' : '#f0f0f0';
      
      Array.prototype.forEach.call(root.querySelectorAll('input,select'), function (el) {
        if (el.type === 'range') return;   
        el.style.background = d ? '#171a24' : '#fff';
        el.style.color = d ? '#e6e8ee' : '#000';
        el.style.borderColor = d ? '#3a4050' : '#ccc';
      });
      var opRg = document.getElementById('__gb_opacity_range');
      if (opRg) opRg.style.background = d ? '#3a4050' : '#cbd2dc';
      var brRg = document.getElementById('__gb_blur_range');
      if (brRg) brRg.style.background = d ? '#3a4050' : '#cbd2dc';
      
      Array.prototype.forEach.call(root.querySelectorAll('.__gb_step'), function (el) {
        el.style.background = d ? '#262b3a' : '#fff';
        el.style.borderColor = d ? '#43a047' : '#43a047';
        el.style.color = d ? '#43a047' : '#43a047';
      });
      
      var rec = document.getElementById('__gb_rec');
      if (rec) { rec.style.background = d ? '#262b3a' : '#fff'; rec.style.color = d ? '#e6e8ee' : '#000'; rec.style.borderColor = d ? '#3a4050' : '#ddd'; }
      var an = document.getElementById('__gb_analyze');
      if (an) { an.style.background = d ? '#262b3a' : '#fff'; an.style.color = d ? '#e6e8ee' : '#000'; an.style.borderColor = d ? '#3a4050' : '#ddd'; }
      var dp = document.getElementById('__gb_deep');
      if (dp) { dp.style.background = d ? '#1e2233' : '#f5eefb'; dp.style.color = d ? '#A5B4FC' : '#8e44ad'; dp.style.borderColor = d ? '#A5B4FC' : '#8e44ad'; }
      var ad = document.getElementById('__gb_adjust');
      if (ad) { ad.style.background = d ? 'transparent' : '#fff'; ad.style.color = '#e67e22'; ad.style.borderColor = '#e67e22'; }
      var opB = document.getElementById('__gb_opacity');
      if (opB) { opB.style.background = d ? '#262b3a' : '#fff'; opB.style.color = d ? '#c8ccd6' : '#4a6a9a'; opB.style.borderColor = d ? '#4a5060' : '#7a90b8'; }
      var opPopEl = document.getElementById('__gb_opacity_pop');
      if (opPopEl) { opPopEl.style.color = d ? '#c8ccd6' : '#000'; opPopEl.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0'; }
      var db = document.getElementById('__gb_dark');
      if (db) { db.style.background = d ? '#262b3a' : '#fff'; db.style.color = d ? '#c8ccd6' : '#000'; db.style.borderColor = d ? '#4a5060' : '#555'; }
      var ab = document.getElementById('__gb_adjust');
      if (ab) { ab.style.background = d ? '#16233a' : '#eaf1fb'; ab.style.color = d ? '#7fb0ef' : '#3b7dd8'; ab.style.borderColor = d ? '#3a5a8a' : '#3b7dd8'; }
      var cvw = document.getElementById('__gb_chart_wrap');
      if (cvw) { cvw.style.borderTop = d ? '1px solid #333846' : '1px solid #f0f0f0'; }
      
      Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td'), function (el) { el.style.color = d ? '#c8ccd6' : '#000'; });
      Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td[id]'), function (el) { el.style.color = d ? '#e6e8ee' : '#000'; });
      var stLine = document.getElementById('__gb_st_line');
      if (stLine) stLine.style.color = d ? '#9aa0ac' : '#000';
      var stFen = document.getElementById('__gb_st_fen');
      if (stFen) stFen.style.color = d ? '#7d8390' : '#000';
      
      var hv = document.getElementById('__gb_hashval');
      if (hv) hv.style.color = d ? '#c8ccd6' : '#000';
      
      Array.prototype.forEach.call(root.querySelectorAll('label'), function (el) {
        el.style.color = d ? '#c8ccd6' : '#000';
      });
      if (typeof paintOpp === 'function') paintOpp();
      if (typeof paintAuto === 'function') paintAuto();
      if (typeof paintHeat === 'function') paintHeat();
      if (typeof paintPanelBg === 'function') paintPanelBg();
      if (typeof paintSideBtns === 'function') paintSideBtns();   
      drawChart();
      if (typeof applyLowOpacityText === 'function') applyLowOpacityText();   
      paintPosWin();
    }

  function applyLang() {
      langBtn.textContent = T('lang');
      
      Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
        var k = el.getAttribute('data-i18n');
        if (I18N[S.lang === 'en' ? 'en' : 'zh'][k] !== undefined) el.textContent = T(k);
      });
      darkBtn.textContent = S.dark ? T('light') : T('dark');
      var sbB = document.getElementById('__gb_side_black'), sbW = document.getElementById('__gb_side_white');
      
      if (sbB) sbB.textContent = S.lang === 'en' ? 'B' : '黑子';
      if (sbW) sbW.textContent = S.lang === 'en' ? 'W' : '白子';
      var adBtn = document.getElementById('__gb_adjust');
      if (adBtn) adBtn.textContent = T('manual');
      
      var hv = document.getElementById('__gb_hashval');
      if (hv) hv.textContent = hashLabel();
      paintSel();
      refreshStatLang();
      drawChart();
    }

  function applyOpacity() {
      var v = parseInt(S.opacity, 10);
      if (!(v >= 25 && v <= 100)) v = 100;
      var cross = ((v < 50) !== (_prevOp < 50));
      S.opacity = v;
      _prevOp = v;
      paintPanelBg();
      paintButtons();
      if (opRange) opRange.value = v;
      if (opNum) opNum.value = v;
      
      if (S.dark && cross) {
        if (v < 50) applyLowOpacityText();
        else applyDark();
      }
      save();
    }

  function applyBlur() {
      var v = parseInt(S.blur, 10);
      if (!(v >= 0 && v <= 50)) v = 0;
      S.blur = v;
      paintPanelBg();
      if (blurRange) blurRange.value = v;
      if (blurNum) blurNum.value = v;
      save();
    }

  function paintPanelBg() {
      var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
      var d = !!S.dark;
      
      root.style.background = d ? 'rgba(31,35,48,' + a + ')' : 'rgba(255,255,255,' + a + ')';
      root.style.backdropFilter = 'none';
      root.style.webkitBackdropFilter = 'none';
      root.style.borderColor = d ? 'rgba(255,255,255,' + (0.10 + 0.12 * a).toFixed(3) + ')' : 'rgba(18,38,86,' + (0.08 + 0.14 * a).toFixed(3) + ')';
      Array.prototype.forEach.call(root.querySelectorAll('.__gb_row'), function (el) {
        el.style.background = d ? 'rgba(38,43,58,' + (a * 0.62).toFixed(3) + ')' : 'rgba(250,251,252,' + (a * 0.62).toFixed(3) + ')';
      });
      var cvw = document.getElementById('__gb_chart_wrap');
      if (cvw) cvw.style.background = d ? 'rgba(25,28,38,' + (0.50 * a).toFixed(3) + ')' : 'rgba(250,251,252,' + (0.50 * a).toFixed(3) + ')';
       paintPosWin();
    }

  function btnOpacityFor(w) {
      w = Math.max(25, Math.min(100, w));
      var b = (w <= 50) ? (0.8 * w + 40) : (0.4 * w + 60);
      return Math.max(60, Math.min(100, Math.round(b)));
    }

  function paintButtons() {
      
      var o = (btnOpacityFor(S.opacity || 100)) / 100;
      Array.prototype.forEach.call(root.querySelectorAll('button'), function (b) { b.style.opacity = o; });
    }

  function applyLowOpacityText() {
      var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
      var sh = (!S.dark || a >= 0.5) ? 'none'
        : '0 1px 4px rgba(15,17,23,0.9), 0 0 10px rgba(15,17,23,0.6), 1px 1px 2px rgba(15,17,23,0.8)';
      var body = document.getElementById('__gb_body');
      if (body) body.style.textShadow = sh;
      Array.prototype.forEach.call(root.querySelectorAll('.__gb_opt,.__gb_lbl,.__gb_lbl2,label'), function (el) { el.style.textShadow = sh; });
      var stEl = document.getElementById('__gb_status');
      if (stEl) stEl.style.textShadow = sh;
      var lgEl = document.getElementById('__gb_legend');
      if (lgEl) lgEl.style.textShadow = sh;
      Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td'), function (el) { el.style.textShadow = sh; });
      var stLine = document.getElementById('__gb_st_line'); if (stLine) stLine.style.textShadow = sh;
      var stFen = document.getElementById('__gb_st_fen'); if (stFen) stFen.style.textShadow = sh;
      var hv = document.getElementById('__gb_hashval'); if (hv) hv.style.textShadow = sh;
      var opPopEl = document.getElementById('__gb_opacity_pop');
      if (opPopEl) opPopEl.style.textShadow = sh;
    }

  function paintPosWin() {
      var w = document.getElementById('__gb_poswin');
      if (!w) return;
      var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
      var d = !!S.dark;
      var bp = (Math.max(5, Math.min(100, S.blur == null ? 50 : S.blur))) / 100;
      var aFrac = a, dFrac = d, bpFrac = bp;   
      w.style.background = d ? 'rgba(31,35,48,' + a + ')' : 'rgba(255,255,255,' + a + ')';
      var blurCss = 'blur(' + (bp * 18).toFixed(1) + 'px) saturate(1.35)';
      w.style.backdropFilter = blurCss;
      w.style.webkitBackdropFilter = blurCss;
      w.style.borderColor = d ? '#000' : '#e2e5ea';
      w.style.color = d ? '#e6e8ee' : '#20242e';   
      var pre = document.getElementById('__gb_poswin_code');
      if (pre) {
        pre.style.background = d ? 'rgba(38,43,58,.62)' : 'rgba(250,251,252,.62)';
        pre.style.color = d ? '#c8ccd6' : '#3a3f46';
      }
      var cp = document.getElementById('__gb_poswin_copy');
      if (cp) {
        cp.style.background = d ? '#232a3a' : '#fff';
        cp.style.color = d ? '#9bd6a2' : '#2e7d32';
        cp.style.borderColor = d ? '#3f7a4a' : '#7cb98a';
      }
    }

  function paintToggle(btn, on) {
      if (!btn) return;
      if (on) { btn.style.background = '#3b7dd8'; btn.style.color = '#fff'; btn.style.borderColor = '#3b7dd8'; }
      else if (S.dark) { btn.style.background = '#262b3a'; btn.style.color = '#c8ccd6'; btn.style.borderColor = '#4a5060'; }
      else { btn.style.background = '#fff'; btn.style.color = '#3b7dd8'; btn.style.borderColor = '#3b7dd8'; }
    }

  function paintAuto() { paintToggle(autoBtn, !!S.autoPlay); }

  function paintHeat() { paintToggle(document.getElementById('__gb_heat'), !!S.heatmap); }

  function paintOpp() {
      if (!oppBtn) return;
      if (S.oppMoves) {
        oppBtn.style.background = '#7a5af8'; oppBtn.style.color = '#fff'; oppBtn.style.borderColor = '#7a5af8';
        if (oppIcon) oppIcon.style.borderColor = '#fff';
      } else {
        oppBtn.style.background = S.dark ? '#262b3a' : '#fff';
        oppBtn.style.color = S.dark ? '#c8ccd6' : '#000';
        oppBtn.style.borderColor = '#A5B4FC';
        if (oppIcon) oppIcon.style.borderColor = S.dark ? '#c8ccd6' : '#A5B4FC';
      }
    }

  function paintSel() {
      var tv = document.getElementById('__gb_turnval');
      if (tv && document.activeElement !== tv) tv.value = S.customTurnSec;
      var mv = document.getElementById('__gb_matchval');
      if (mv && document.activeElement !== mv) mv.value = S.customSec;
      
      Array.prototype.forEach.call(root.querySelectorAll('[data-rule]'), function (el) {
        el.querySelector('.__gb_chk').style.visibility = (+el.dataset.rule === S.rule) ? 'visible' : 'hidden';
      });
    }

  function applyPreset() {
      S.matchMs = S.customSec * 1000;
      S.turnMs = S.customTurnSec * 1000;
      save(); paintSel();
    }

  function applyHash() {
      var hv = document.getElementById('__gb_hashval');
      if (hv) hv.textContent = hashLabel();
      save();
      if (!S.hashMB) return;   
      try {
        tryLocal(LOCAL_HOSTS, '/api/hash', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mb: S.hashMB }),
        }).catch(function () {});
      } catch (e) {}
    }

  function hashLabel() {
      return S.hashMB ? (S.hashMB + ' ' + T('hashUnit')) : T('hashAuto');
    }

  function clamp(x, y) {
          var ww = w.offsetWidth, hh = w.offsetHeight;
          return [Math.max(0, Math.min(x, window.innerWidth - ww)), Math.max(0, Math.min(y, window.innerHeight - hh))];
        }

  window.GBUI = {
    names: ["CHART_FIT","drawChart","fmtKMG","coordLower","rawEvalText","setStatus","setStatPanel","setStatPanelThinking","refreshStatLang","fillStatFromCache","applyDark","applyLang","applyOpacity","applyBlur","paintPanelBg","btnOpacityFor","paintButtons","applyLowOpacityText","paintPosWin","paintToggle","paintAuto","paintHeat","paintOpp","paintSel","applyPreset","applyHash","hashLabel","clamp","save","initState"],
    setN: function (v) { N = v | 0 || 15; },
    T: T,                                   
    I18N: I18N,
    initState: initState,                   
    CHART_FIT: CHART_FIT,
    drawChart: drawChart,
    fmtKMG: fmtKMG,
    coordLower: coordLower,
    rawEvalText: rawEvalText,
    setStatus: setStatus,
    setStatPanel: setStatPanel,
    setStatPanelThinking: setStatPanelThinking,
    refreshStatLang: refreshStatLang,
    fillStatFromCache: fillStatFromCache,
    applyDark: applyDark,
    applyLang: applyLang,
    applyOpacity: applyOpacity,
    applyBlur: applyBlur,
    paintPanelBg: paintPanelBg,
    btnOpacityFor: btnOpacityFor,
    paintButtons: paintButtons,
    applyLowOpacityText: applyLowOpacityText,
    paintPosWin: paintPosWin,
    paintToggle: paintToggle,
    paintAuto: paintAuto,
    paintHeat: paintHeat,
    paintOpp: paintOpp,
    paintSel: paintSel,
    applyPreset: applyPreset,
    applyHash: applyHash,
    hashLabel: hashLabel,
    clamp: clamp,
    save: save,
  };
})();
