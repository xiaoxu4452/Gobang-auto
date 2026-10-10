/* Meter Gomoku bookmark assistant (bookmark edition) - pure JS floating Gomoku helper; board recognition delegates to the local C++ vision service (GomokuVision) and the native RapFi engine. */


(function () {
  
  if (window.__gbPanel) {
    try { clearInterval(window.__gbTimer); clearTimeout(window.__gbTo); } catch (e) {}
    var oldP = document.getElementById('__gb_panel'); if (oldP) oldP.remove();
    var oldO = document.getElementById('__gb_overlay'); if (oldO) oldO.remove();
    var oldC = document.getElementById('__gb_calib'); if (oldC) oldC.remove();
    var oldA = document.getElementById('__gb_adjbox'); if (oldA) oldA.remove();
    window.__gbPanel = null;
  }

  var N = 15;
  
  var LOCAL_HOSTS = ['http://127.0.0.1:8964', 'http://localhost:8964'];
  var ENGINE = LOCAL_HOSTS[0];
  var ENGINE_FAILED = null;          
  
  var jsonpSeq = 0;
  function jsonpLocal(hosts, path, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      
      var p2 = params || {};
      var qPos = path.indexOf('?');
      if (qPos >= 0) {
        new URLSearchParams(path.slice(qPos + 1)).forEach(function (v, k) { if (!(k in p2)) p2[k] = v; });
        path = path.slice(0, qPos);
      }
      var lastErr = null;
      (function attempt(hi) {
        if (hi >= hosts.length) { reject(lastErr || new Error('jsonp no host')); return; }
        var cbName = '__gbjp' + (++jsonpSeq) + '_' + Date.now().toString(36);
        var q = [];
        for (var k in p2) if (p2[k] !== undefined) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(p2[k]));
        q.push('cb=' + cbName);
        var s = document.createElement('script');
        var done = false;
        var to = setTimeout(function () { cleanup(new Error('jsonp timeout')); }, timeoutMs || 30000);
        function cleanup(err) {
          if (done) return; done = true;
          clearTimeout(to);
          try { delete window[cbName]; } catch (e) { try { window[cbName] = undefined; } catch (e2) {} }
          if (s && s.parentNode) s.parentNode.removeChild(s);
          if (err) { lastErr = err; attempt(hi + 1); }
        }
        window[cbName] = function (data) {
          done = true; clearTimeout(to);
          try { delete window[cbName]; } catch (e) { try { window[cbName] = undefined; } catch (e2) {} }
          if (s && s.parentNode) s.parentNode.removeChild(s);
          resolve({ ok: true, status: 200, url: hosts[hi] + path, json: function () { return Promise.resolve(data); } });
        };
        s.onerror = function () { cleanup(new Error('jsonp blocked')); };
        s.charset = 'utf-8';
        s.src = hosts[hi] + path + '?' + q.join('&');
        (document.head || document.documentElement).appendChild(s);
      })(0);
    });
  }
  
  function jsonpPlan(path, init) {
    if (!document || !document.createElement) return null;
    var p = path.split('?')[0];
    if (p === '/api/analyze' && init && init.body) {
      var turnMs = 5000;
      try { turnMs = JSON.parse(init.body).turnMs || 5000; } catch (e) {}
      return { path: p, params: { d: init.body }, timeout: turnMs + 12000 };
    }
    if (p === '/api/status') return { path: p, params: {}, timeout: 8000 };
    if (p === '/api/hash' && init && init.body) return { path: p, params: { d: init.body }, timeout: 10000 };
    return null;   
  }
  
  var tryLocal =
    (typeof fetch === 'function')
      ? async function (hosts, path, init) {
          var lastErr = null;
          for (var hi = 0; hi < hosts.length; hi++) {
            try {
              var resp = await fetch(hosts[hi] + path, init);
              if (resp && (resp.status >= 200 && resp.status < 300)) return resp;
              lastErr = new Error('HTTP ' + (resp ? resp.status : '?'));
            } catch (e) { lastErr = e; }
          }
          var jp = jsonpPlan(path, init);
          if (jp) return jsonpLocal(hosts, path, jp.params, jp.timeout);
          throw lastErr || new Error('no local host');
        }
      : async function (hosts, path, init) {
          var jp = jsonpPlan(path, init);
          if (jp) return jsonpLocal(hosts, path, jp.params, jp.timeout);
          throw new Error('fetch unavailable');
        };
  function pickHost(list, cur) { var i = list.indexOf(cur); return list[(i + 1) % list.length] || list[0]; }
  
  var CLIENT_ID = 'gb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
  
  var diag = function (what) { try { if (window.__gbDiag) console.log('[GB-diag]', what); } catch (e) {} };
  try { if (localStorage.getItem('gb_diag') === '1') window.__gbDiag = true; } catch (e) {}

  var S = {
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
    blur: 50,           
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
  var haltForNewGame = false;   
  
  var haltReason = '';
  
  var GAME_OVER_LOCK_KEY = 'gb_gameover';
  function setGameOverLock(reason) {
    
    try { localStorage.setItem(GAME_OVER_LOCK_KEY, JSON.stringify({ r: reason, t: Date.now() })); } catch (e) {}
  }
  function clearGameOverLock() { try { localStorage.removeItem(GAME_OVER_LOCK_KEY); } catch (e) {} }
  
  function gameOverLocked() {
    try {
      var d = JSON.parse(localStorage.getItem(GAME_OVER_LOCK_KEY) || 'null');
      if (!d || !d.r) return false;
      if (Date.now() - (d.t || 0) > 6 * 3600 * 1000) { clearGameOverLock(); return false; }   
      return true;
    } catch (e) { return false; }
  }
  try {
    var s = JSON.parse(localStorage.getItem('gb_state') || '{}');
    if (!s.__v || s.__v < 4) { s.oppMoves = false; s.heatmap = false; s.__v = 4; }   
    if (s.__v < 5) { if (s.rule === 5) s.rule = 0; s.__v = 5; }   
    if (s.__v < 6) { s.autoPlay = false; s.__v = 6; }             
    if (s.__v < 7) { if (s.hashMB === 256) s.hashMB = 0; s.__v = 7; }   
    for (var k in s) if (k !== 'analyzing') S[k] = s[k];   
  } catch (e) {}
  S.analyzing = false;

  var AUTO_SIDE = false;

  function clampSide(v) {
    if (v === 0 || v === 1) return v;
    if (v === '0' || v === 'black') return 0;
    if (v === '1' || v === 'white') return 1;
    var n = (typeof v === 'number') ? v : parseInt(v, 10);
    return (n === 0 || n === 1) ? n : -1;
  }
  (function normalizeSideState() {
    S.side = clampSide(S.side);
    
    if (!AUTO_SIDE || S.side === 0 || S.side === 1) S.userSide = -1;
    else S.userSide = clampSide(S.userSide);
  })();

  function mySideMask() {
    if (S.side === 0 || S.side === 1) return S.side;          
    if (!AUTO_SIDE) return -1;                                
    return (S.userSide === 0 || S.userSide === 1) ? S.userSide : -1;
  }
  function sideResolved() { return mySideMask() >= 0; }
  function myColorCode() { var s = mySideMask(); return s < 0 ? 0 : (s === 0 ? 1 : 2); }
  function oppColorCode() { var s = mySideMask(); return s < 0 ? 0 : (s === 0 ? 2 : 1); }
  
  function openingSideToMove(board) {
    if (!board || !board.length) return 1;
    var bn = 0, wn = 0;
    for (var y = 0; y < board.length; y++) {
      var row = board[y];
      if (!row) continue;
      for (var x = 0; x < row.length; x++) { if (row[x] === 1) bn++; else if (row[x] === 2) wn++; }
    }
    if (bn === 0 && wn === 0) return 1;   
    if (bn === wn) return 1;              
    return 2;                             
  }
  
  function stmFromDiff(board, bCnt, wCnt, prevBoard, lastStm) {
    if (!board || !board.length) return 1;
    if (bCnt === 0 && wCnt === 0) return 1;                       
    if (prevBoard && prevBoard.length === board.length) {
      var addB = 0, addW = 0, other = 0;
      for (var y = 0; y < board.length; y++) {
        var pr = prevBoard[y], cr = board[y];
        if (!cr || !pr) { other++; continue; }                    
        for (var x = 0; x < cr.length; x++) {
          var p = pr[x] | 0, c = cr[x] | 0;
          if (p === c) continue;
          if (p === 0 && c === 1) addB++;
          else if (p === 0 && c === 2) addW++;
          else other++;                                           
        }
      }
      if (other === 0 && addB + addW === 1) return addB ? 2 : 1;  
      if (other === 0 && addB + addW === 0) return (lastStm === 2) ? 2 : 1;   
      
    }
    if (bCnt === wCnt) return 1;
    if (bCnt === wCnt + 1) return 2;
    return (lastStm === 1 || lastStm === 2) ? lastStm : 2;        
  }
  
  function isOurTurnOn(board, stm) {
    var m = mySideMask();
    var me = (m === 0) ? 1 : (m === 1 ? 2 : 0);
    if (me === 0) return false;                       
    var s = (stm === 1 || stm === 2) ? stm : openingSideToMove(board);
    return s === me;
  }
  
  function sideIsManual() { return S.side === 0 || S.side === 1; }
  
  function setUserSide(v) {
    if (!AUTO_SIDE || sideIsManual()) { S.userSide = -1; return false; }   
    S.userSide = (v === 0 || v === 1) ? v : -1;
    return true;
  }
  
  function sideStatusText() {
    var m = mySideMask();
    if (m < 0) return SF('me_pending');
    if (sideIsManual()) return SF(m === 0 ? 'me_black_m' : 'me_white_m');
    return SF(m === 0 ? 'me_black' : 'me_white');
  }

  function save() {
    try {
      var c = Object.assign({}, S);
      c.analyzing = false;   
      localStorage.setItem('gb_state', JSON.stringify(c));
    } catch (e) {}
  }
  
  function saveHistory() {
    try { localStorage.setItem('gb_history', JSON.stringify({ __v: 2, h: S.history, score: S.score, rawEval: S.rawEval, myEval: S.myEval, verdict: S.verdict, matePly: S.matePly, halt: haltForNewGame, hr: haltReason })); } catch (e) {}
  }
  function normalizeHistPoint(p, idx) {
    if (typeof p === 'number') return { i: idx, v: p };                                   
    if (p && typeof p === 'object' && typeof p.v === 'number') return { i: (typeof p.i === 'number' ? p.i : idx), v: p.v };
    return null;
  }
  function loadHistory() {
    try {
      var d = JSON.parse(localStorage.getItem('gb_history') || 'null');
      if (d && Array.isArray(d.h) && d.h.length) {
        
        var anyOld = false;
        for (var hi = 0; hi < d.h.length; hi++) {
          var pv = (d.h[hi] && typeof d.h[hi] === 'object') ? d.h[hi].v : d.h[hi];
          if (typeof pv === 'number' && pv > 0 && pv < 1) { anyOld = true; break; }
        }
        if (!anyOld) {
          var norm = [];
          for (var hj = 0; hj < d.h.length; hj++) { var np = normalizeHistPoint(d.h[hj], hj); if (np) norm.push(np); }
          S.history = norm.slice(-400);
          S.score = d.score || 0; S.rawEval = (typeof d.rawEval === 'string') ? d.rawEval : '';
          S.myEval = (typeof d.myEval === 'string') ? d.myEval : '';
          S.verdict = d.verdict || 'none'; S.matePly = d.matePly || 0;
          haltForNewGame = !!d.halt;
          haltReason = (typeof d.hr === 'string') ? d.hr : (haltForNewGame ? 'm1' : '');
          
          if (haltReason === 'five-my' || haltReason === 'five-opp') setGameOverLock(haltReason);
        } else {
          S.history = []; S.score = 0; S.rawEval = ''; S.myEval = ''; S.verdict = 'none'; S.matePly = 0;
          haltForNewGame = false; haltReason = ''; clearGameOverLock();
          try { localStorage.removeItem('gb_history'); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  var NET_SELF_HINTS = ['"me"', '"my"', "'me'", "'my'", 'yourcolor', 'mycolor', 'yourColor', 'myColor', 'your-side', 'your_side', 'my-side', 'my_side'];

  try { if (localStorage.getItem('gb_netlog') === '1') window.__gbNetLog = true; } catch (e) {}
  function netVal2Side(val) {
    var v = String(val).trim().toLowerCase();
    if (v === 'black' || v === 'b') return 0;
    if (v === 'white' || v === 'w') return 1;
    var num = parseInt(v, 10);
    if (num === 1 || num === 0) return 0;
    if (num === 2) return 1;
    return -1;
  }
  function netApply(side) {
    if (side !== 0 && side !== 1) return false;
    if (AUTO_SIDE && S.autoPlay && S.side === -1 && S.userSide < 0) {   
      S.userSide = side;
      sideLockUntil = Date.now() + 4000;   
      try { setStatus(S.lang === 'en' ? 'net: I play ' + (side === 0 ? 'Black' : 'White') : '网络监听判定我执<b>' + (side === 0 ? '黑' : '白') + '</b>'); } catch (e) {}
      try { save(); } catch (e) {}
      return true;
    }
    return false;
  }
  
  function netLog(what) {
    try {
      if (window.__gbNetLog) console.log('[GB-net]', what);
    } catch (e) {}
  }
  function netGuess(txt) {
    try {
      if (!txt || typeof txt !== 'string' || txt.length > 200000) return;
      var low = txt.toLowerCase();
      if (!(low.indexOf('color') >= 0 || low.indexOf('colour') >= 0 || low.indexOf('side') >= 0 ||
            low.indexOf('black') >= 0 || low.indexOf('white') >= 0 || low.indexOf('blacktomove') >= 0 ||
            low.indexOf('whitetomove') >= 0 || low.indexOf('you') >= 0)) return;
      
      if (AUTO_SIDE && probeOpen && S.side === -1 && S.userSide < 0) {
        var sinceP = Date.now() - probeOpen.since;
        var turnMatch = low.match(/\b(blacktomove|whitetomove)\b/) ||
                        txt.match(/(?:turn|next|tomove|player)\w*\s*[:=]\s*["']?\b(black|white|b|w)\b/i);
        if (turnMatch && sinceP > 250) {
          var tt = (turnMatch[1] || turnMatch[0]).toLowerCase();
          var turnIsBlack = (tt.indexOf('black') >= 0 || tt === 'b');
          if (!turnIsBlack) {
            
            if (netApply(0)) { probeOpen = null; openWaitStart = 0; netLog('probe-turn: now White to move → I am Black'); }
          } else if (sinceP > 600) {
            
            if (netApply(1)) { probeOpen = null; openWaitStart = 0; netLog('probe-turn: still Black to move → I am White'); }
          }
        }
      }
      
      var dm = txt.match(/(?:you|your|me|my)\w*\s*[:=]\s*["']?\b(black|white|b|w)\b/i);
      if (dm) {
        var sd = netVal2Side(dm[1]);
        netLog('direct match=' + dm[1] + ' side=' + sd);
        if (sd >= 0 && netApply(sd)) return;
      }
      
      var lines = txt.split(/[,\n{}]/);
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var lw = ln.toLowerCase();
        if (lw.indexOf('color') < 0 && lw.indexOf('colour') < 0 && lw.indexOf('side') < 0 &&
            lw.indexOf('black') < 0 && lw.indexOf('white') < 0) continue;
        
        var isSelf = false;
        for (var h = 0; h < NET_SELF_HINTS.length; h++) if (ln.toLowerCase().indexOf(NET_SELF_HINTS[h]) >= 0) { isSelf = true; break; }
        var m = ln.match(/[:=]\s*["']?([A-Za-z0-9]+)["']?\s*$/i);
        if (!m) continue;
        var sd = netVal2Side(m[1]);
        netLog('line=' + ln + ' side=' + sd + ' self=' + isSelf);
        if (sd >= 0 && isSelf && netApply(sd)) return;
      }
    } catch (e) {}
  }
  function installNetHook() {
    if (window.__gbNetDone) return; window.__gbNetDone = true;
    
    if (window.WebSocket && !window.__gbWsS) {
      window.__gbWsS = WebSocket.prototype.send;
      var so = window.__gbWsS;
      WebSocket.prototype.send = function (d) { try { netGuess(String(d)); } catch (e) {} return so.call(this, d); };
    }
    
    if (window.WebSocket && window.__gbWsAE === undefined) {
      window.__gbWsAE = true;
      var oAEL = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (t, f, o) {
        if (t === 'message') {
          var self = this;
          return oAEL.call(this, t, function (ev) {
            try { netGuess(ev && ev.data !== undefined ? String(ev.data) : ''); } catch (e) {}
            return f.apply(this, arguments);
          }, o);
        }
        return oAEL.apply(this, arguments);
      };
      var oSR = WebSocket.prototype.removeEventListener;
      WebSocket.prototype.removeEventListener = function () { return oSR.apply(this, arguments); };
    }
    
    if (window.fetch && !window.__gbFetchW) {
      window.__gbFetchW = true;
      var of = window.fetch;
      window.fetch = function () {
        return of.apply(this, arguments).then(function (r) {
          try { r.clone().text().then(function (t) { netGuess(t); }).catch(function () {}); } catch (e) {}
          return r;
        });
      };
    }
    
    if (window.XMLHttpRequest && !window.__gbXhrW) {
      window.__gbXhrW = true;
      var oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function () { this.__gbU = arguments[1]; return oo.apply(this, arguments); };
      var os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var self = this;
        var h = function () { if (self.readyState === 4) { try { netGuess(self.responseText || ''); } catch (e) {} } };
        this.addEventListener('readystatechange', h);
        return os.apply(this, arguments);
      };
    }
  }
  
  try { installNetHook(); } catch (e) {}

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
      no_board: '未检测到棋盘（打开有棋盘的网页后点书签；若页面无可识别 canvas，请换用其它五子棋网站）',
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
      no_board: 'No board detected. Open a Gomoku page and click the bookmark; if no readable canvas, try another site.',
      swapHint: 'Swap rules tip: for Tarannikov / Taraguchi-10 and other swap rules, turn OFF Auto-play first, do the swap manually, then turn Auto-play back on.',
      thinking: 'Thinking…', copied: 'Position code copied', fenlabel: 'Pos',
      posBtn: 'Position', posSave: 'Save position', posWinTtl: 'Position',
      posEmpty: 'No board recognized yet — run Analyze first',
      posSaveOk: 'Position image saved', posSaveFail: 'Save failed: ', posCopy: 'Copy',
    }
  };
  function T(k) { var d = I18N[S.lang === 'en' ? 'en' : 'zh']; return d[k] || (I18N.zh[k] || k); }
  
  var ST = {
    zh: {
      cv_ok: '已通过 OpenCV 识别棋盘（{src} 置信度 {c}% · {n} 子），分析中…',
      shot_ok: '已通过截屏识别到棋盘（{mode}），分析中…',
      no_image: '页面上没有可读的棋盘图像。请先让面板识别出棋盘后再手动调节',
      applied: '已应用手动调节的棋盘区域，重新分析…',
      cancelled: '已取消手动调节',
      corrected: '已自动校正棋盘网格（置信度 {c}%）',
      no_stone: '识别可能不准——棋盘上有棋子但一格未读出。请点「手动调节」把蓝色框对准棋盘网格再「应用 ✓」',
      off: '识别偏移导致读子不准（置信度 {c}%）——请点「手动调节」把蓝色框对准棋盘网格再「应用 ✓」',
      lowconf: '读子置信度 {c}%，自动落子已暂停——请点「手动调节」校准棋盘后自动恢复',
      me_black: ' · 自动识别我执<b>黑</b>', me_white: ' · 自动识别我执<b>白</b>', me_pending: ' · 识别我方中(手动落子后生效)',
      me_black_m: ' · 已锁定我执<b>黑</b>(手动)', me_white_m: ' · 已锁定我执<b>白</b>(手动)',
      side_manual: '锁定', side_auto: '自动', side_pending: '待定',
      adj_mid: '手动调节中——请先点「应用 ✓」或「取消」，再自动落子',
      fail: '识别到疑似棋盘但校准失败——点「手动调节」拖动蓝色框框住棋盘（松手自动磁吸），再点「应用 ✓」；或点「重新识别」',
    },
    en: {
      cv_ok: 'Board recognized via OpenCV ({src} · conf {c}% · {n} stones), analyzing…',
      shot_ok: 'Board recognized via screenshot ({mode}), analyzing…',
      no_image: 'No readable board on the page. Let the panel detect the board first, then use Adjust.',
      applied: 'Manual region applied, re-analyzing…',
      cancelled: 'Manual adjustment cancelled',
      corrected: 'Grid auto-corrected (confidence {c}%)',
      no_stone: 'Detection may be off — stones present but none read. Click Adjust, line the blue box up with the grid, then Apply ✓.',
      off: 'Detection offset, stones read poorly (confidence {c}%) — click Adjust and line the blue box up, then Apply ✓.',
      lowconf: 'Stone confidence {c}%, auto-move paused — click Adjust to calibrate and it resumes.',
      me_black: ' · auto: I play <b>Black</b>', me_white: ' · auto: I play <b>White</b>', me_pending: ' · detecting side (play a move)',
      me_black_m: ' · locked: I play <b>Black</b> (manual)', me_white_m: ' · locked: I play <b>White</b> (manual)',
      side_manual: 'locked', side_auto: 'auto', side_pending: 'pending',
      adj_mid: 'Adjusting — click Apply ✓ or Cancel before auto-moving.',
      fail: 'Board suspected but calibration failed — click Adjust, drag the blue box over the board (magnetizes on release), then Apply ✓; or Re-scan.',
    }
  };
  function SF(k) {
    var d = ST[S.lang === 'en' ? 'en' : 'zh'];
    var s = d[k] || ST.zh[k] || k;
    for (var i = 1; i < arguments.length; i += 2) s = s.split(arguments[i]).join(arguments[i + 1]);
    return s;
  }

  var PRESETS = {
    '3min':  { label: '3分钟', matchMs: 180000,  turnMs: 7000 },
    '5min':  { label: '5分钟', matchMs: 300000,  turnMs: 18000 },
    '15min': { label: '15分钟', matchMs: 900000,  turnMs: 40000 },
  };

  var cachedCal = null;
  
var lastAutoFp = null, lastUserClick = null, panelClickFlag = false;
  
  var lastBoard = null, lastCount = 0;          
  var emptyStreak = 0;                          
  var openWaitStart = 0;                        
  var pendingClick = null;                      
  var probeOpen = null;                          
  var lastEngineFp = null, lastEngineAt = 0;    
  var lastStmColor = 1;                         
  var deepMode = false, DEEP_MS = 30000;        
  var overlayRefreshBusy = false;               
  var overlayStale = false;                     
  var lastOppRings = null;                      
  
  var lastOppKey = null;
var lastOppCands = null;                      
  var lastOppGeom = null;                       
  var lockedGeom = null;                        
  var oppSvg = null;                            
  var oppRingsFp = null;                        
  var oppRingsCount = 0;                        
  var autoHaltUntil = 0;                        
  var openReanchorAt = 0;                       
  var badDiffCount = 0, badDiffSince = 0;        
  
  var sideLockUntil = 0;                        
  var sideConflictCount = 0;                    
  
  var sideVote = { color: -1, n: 0 };           
  var SIDE_VOTE_NEED = 2;                       
  var SIDE_LOCK_MS = 4000;                      
  var shrinkStreak = 0;                         
  
  function nearProbeCells(p, c, r) {
    var cells = p && p.cells && p.cells.length ? p.cells : (p ? [{ i: p.i, j: p.j }] : []);
    for (var pz = 0; pz < cells.length; pz++) {
      if (Math.abs(c - cells[pz].i) <= 1 && Math.abs(r - cells[pz].j) <= 1) return true;
    }
    return false;
  }
  
  function toTopRect(el) {
    var r = el.getBoundingClientRect();
    var win = el.ownerDocument.defaultView;
    while (win && win !== window) {
      var fr = win.frameElement;
      if (!fr) break;
      var frr = fr.getBoundingClientRect();
      r = { left: r.left + frr.left, top: r.top + frr.top, right: r.right + frr.left, bottom: r.bottom + frr.top, width: r.width, height: r.height };
      win = fr.ownerDocument.defaultView;
    }
    return r;
  }
  
  function pickCandidates() {
    var list = [];
    function scan(doc, depth) {
      depth = depth || 0;
      if (depth > 4) return;  
      Array.prototype.slice.call(doc.querySelectorAll('canvas')).forEach(function (c) { list.push(c); });
      Array.prototype.slice.call(doc.querySelectorAll('iframe')).forEach(function (f) {
        try { if (f.contentDocument && f.contentDocument.body) scan(f.contentDocument, depth + 1); } catch (e) {}  
      });
    }
    scan(document, 0);
    
    function inOwnUi(el) {
      for (var p = el; p; p = p.parentElement) {
        if (p.id === '__gb_panel' || p.id === '__gb_poswin') return true;
      }
      return false;
    }
    var cands = list.filter(function (c) {
      if (inOwnUi(c)) return false;
      var r = c.getBoundingClientRect();
      return r.width > 120 && r.height > 120;
    });
    
    cands.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var sqA = 1 - Math.abs(ra.width - ra.height) / Math.max(ra.width, ra.height);
      var sqB = 1 - Math.abs(rb.width - rb.height) / Math.max(rb.width, rb.height);
      return sqB - sqA;
    });
    return cands;
  }
  var cachedBoard = null; 
  
  function attachClickWatch(cv, cal) {
    if (cv.__gbWatch) return;
    cv.__gbWatch = true;
    function onHit(e) {
      if (panelClickFlag) return;
      var r = cal.docRect || cal.topRect;
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      lastUserClick = { t: Date.now(), x: x, y: y };
    }
    ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(function (ev) {
      try { cv.addEventListener(ev, onHit, true); } catch (e) {}
    });
  }
  var lastScreenTry = 0;
  var screenDenied = false;    
  var screenAutoOff = false;   
  var screenFails = 0;
  var lastBoardFail = 'none';  
  var lastGoodCal = null;      
var lastGoodBoard = null;    
var lastMirrorFixAt = 0;     
  function findBoard() {
    if (cachedBoard) {
      
      var doc = cachedBoard.cv.ownerDocument;
      var r = cachedBoard.cv.getBoundingClientRect();
      var last = cachedBoard.lastRect;
      var moved = last && (Math.abs(r.left - last.left) > 2 || Math.abs(r.top - last.top) > 2 ||
        Math.abs(r.width - last.width) > 2 || Math.abs(r.height - last.height) > 2);
      if (!moved && r.width > 50 && doc.body && doc.body.contains(cachedBoard.cv)) {
        cachedBoard.lastRect = { left: r.left, top: r.top, width: r.width, height: r.height };
        drawCalibFrame(cachedBoard.cal, cachedBoard.cv);
        attachClickWatch(cachedBoard.cv, cachedBoard.cal);
        return cachedBoard;
      }
      cachedBoard = null;
    }
    var cands = pickCandidates();
    
    var bestCal = null, bestCv = null, bestScore = 1e18;
    for (var i = 0; i < cands.length; i++) {
      var cal = calibrate(cands[i]);
      if (cal) {
        cal.docRect = cands[i].getBoundingClientRect();
        cal.topRect = toTopRect(cands[i]);
        cal.frameWin = cands[i].ownerDocument.defaultView || window;
        var sc = cal.gridScore != null ? cal.gridScore : 0;
        if (sc < bestScore) { bestScore = sc; bestCal = cal; bestCv = cands[i]; }
      }
    }
    if (bestCal) {
      var rr = bestCv.getBoundingClientRect();
      cachedBoard = { cv: bestCv, cal: bestCal, lastRect: { left: rr.left, top: rr.top, width: rr.width, height: rr.height } };
      drawCalibFrame(bestCal, bestCv);
      attachClickWatch(bestCv, bestCal);
      lastBoardFail = 'none';
      return cachedBoard;
    }
    
    if (cands.length > 0) {
      clearCalibFrame();
      lastBoardFail = 'canvas-calib';
      return null;
    }
    
    if (!screenDenied && !screenAutoOff && Date.now() - lastScreenTry > 5000) {
      lastScreenTry = Date.now();
      tryScreenBoard();
    }
    if (screenBoard) {
      drawCalibFrame(screenBoard.cal, screenBoard.cv);
      attachClickWatch(screenBoard.cv, screenBoard.cal);
      lastBoardFail = 'none';
      return { cv: screenBoard.cv, cal: screenBoard.cal, screenMode: true };
    }
    clearCalibFrame();
    lastBoardFail = 'no-canvas';
    return null;
  }

  var pyBoardCache = null;
  var PY_HOSTS = ['http://127.0.0.1:8970', 'http://localhost:8970'];
  function composeBoardImage(cands) {
    var w = 0, h = 0;
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].width > w) w = cands[ci].width;
      if (cands[ci].height > h) h = cands[ci].height;
    }
    if (!w || !h) return null;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return null; }
    
    var main = cands[0];
    for (var ci2 = 1; ci2 < cands.length; ci2++) if (cands[ci2].width * cands[ci2].height > main.width * main.height) main = cands[ci2];
    var img = null;
    try {
      var mo = document.createElement('canvas'); mo.width = main.width; mo.height = main.height;
      var mctx = mo.getContext('2d', { willReadFrequently: true });
      mctx.drawImage(main, 0, 0);
      img = mctx.getImageData(0, 0, main.width, main.height).data;
    } catch (e) { img = null; }
    var hist = {}, bestK = null, bestC = 0;
    if (img) {
      for (var y = 0; y < main.height; y += 4) for (var x = 0; x < main.width; x += 4) {
        var o = (y * main.width + x) * 4;
        if (img[o + 3] < 96) continue;
        var key = ((img[o] >> 4) << 8) | ((img[o + 1] >> 4) << 4) | (img[o + 2] >> 4);
        hist[key] = (hist[key] || 0) + 1;
        if (hist[key] > bestC) { bestC = hist[key]; bestK = key; }
      }
    }
    if (bestK == null) { octx.fillStyle = '#ffffff'; }
    else {
      var mr = (((bestK >> 8) & 15) << 4) | 8, mg = (((bestK >> 4) & 15) << 4) | 8, mb = ((bestK & 15) << 4) | 8;
      octx.fillStyle = 'rgb(' + mr + ',' + mg + ',' + mb + ')';
    }
    octx.fillRect(0, 0, w, h);
    
    for (var ci3 = 0; ci3 < cands.length; ci3++) {
      try { octx.drawImage(cands[ci3], 0, 0); } catch (e) {}
    }
    return off.toDataURL('image/png');
  }
  
  var WULIN_GEO_KEY = '__gb_wulin_geo_v1';
  function isWulinSite() {
    try {
      var gc = document.getElementById('GameCanvas');
      if (!gc) return false;
      if (!(window.cc || window._CCSettings || typeof cc !== 'undefined')) return false;
      var r = gc.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    } catch (e) { return false; }
  }
  function wulinGeoLoad() {
    try { var s = localStorage.getItem(WULIN_GEO_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function wulinGeoSave(g) {
    try { localStorage.setItem(WULIN_GEO_KEY, JSON.stringify(g)); } catch (e) {}
  }
  async function wulinFindBoard() {
    var gc = document.getElementById('GameCanvas');
    if (!gc) return null;
    var geo = wulinGeoLoad();
    if (!geo || !(geo.stepX > 1)) return null;
    var resp = await tryLocal(PY_HOSTS, '/recognize', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'wulin', size: 15,
        geo: { x0: geo.x0, y0: geo.y0, stepX: geo.stepX, stepY: geo.stepY || geo.stepX, grid: 15 },
        win: {
          screenX: window.screenX, screenY: window.screenY,
          topBorder: (window.outerHeight - window.innerHeight) || 0,
          innerWidth: window.innerWidth, innerHeight: window.innerHeight
        }
      })
    });
    var data = await resp.json();
    if (!data.ok) return null;
    var board = emptyBoard();
    (data.black || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 1; });
    (data.white || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 2; });
    var rr = gc.getBoundingClientRect();
    var cal = {
      x0: geo.x0 - rr.left, y0: geo.y0 - rr.top,      
      stepX: geo.stepX, stepY: geo.stepY || geo.stepX, cell: geo.stepX,
      bg: 200, gridScore: 0, docRect: rr, topRect: toTopRect(gc), frameWin: window,
      isScreen: false, mode: 'wulin'
    };
    var res = { cv: gc, cal: cal, board: board };
    pyBoardCache = { cv: gc, cal: cal, board: board, lastRect: { left: rr.left, top: rr.top, width: rr.width, height: rr.height }, t: Date.now() };
    cachedBoard = res;
    drawCalibFrame(cal, gc);
    attachClickWatch(gc, cal);
    lastBoardFail = 'none';
    setStatus(SF('cv_ok', '{src}', '五林·截屏', '{c}', 95, '{n}', board.reduce(function (a, r) { for (var i = 0; i < 15; i++) if (r[i]) a++; return a; }, 0)));
    return res;
  }
  async function pyFindBoard() {
    
    if (isWulinSite()) {
      try {
        var wb = await wulinFindBoard();
        if (wb) return wb;
        var wg = wulinGeoLoad();
        if (!wg || !(wg.stepX > 1)) {
          var hinted = false;
          try { hinted = localStorage.getItem('__gb_wulin_hinted') === '1'; } catch (e) {}
          if (!hinted) {
            try { localStorage.setItem('__gb_wulin_hinted', '1'); } catch (e) {}
            setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Wulin board: click Adjust and frame the board once; auto after that.' : '五林棋盘：请先点「手动调节」拖动蓝框框住棋盘一次，之后自动识别') + '</span>');
          }
        }
      } catch (e) {}
    }
    var cv = null;
    if (pyBoardCache && Date.now() - pyBoardCache.t < 2000) {
      cv = pyBoardCache.cv;
      var doc = cv.ownerDocument, r0 = cv.getBoundingClientRect(), last = pyBoardCache.lastRect;
      var moved = last && (Math.abs(r0.left - last.left) > 2 || Math.abs(r0.top - last.top) > 2 ||
        Math.abs(r0.width - last.width) > 2 || Math.abs(r0.height - last.height) > 2);
      if (!moved && r0.width > 50 && doc.body && doc.body.contains(cv)) {
        pyBoardCache.lastRect = { left: r0.left, top: r0.top, width: r0.width, height: r0.height };
        drawCalibFrame(pyBoardCache.cal, cv);
        attachClickWatch(cv, pyBoardCache.cal);
        cachedBoard = pyBoardCache;
        return pyBoardCache;
      }
      pyBoardCache = null;
    } else {
      pyBoardCache = null;   
    }
    var cands = pickCandidates();
    
    var mainCv = null;
    for (var mi = 0; mi < cands.length; mi++) {
      var c0r = cands[mi].getBoundingClientRect();
      if (c0r.width < 100 || c0r.height < 100) continue;
      if (!mainCv || cands[mi].width * cands[mi].height > mainCv.width * mainCv.height) mainCv = cands[mi];
    }
    var boardCands = [];
    if (mainCv) {
      var mr = mainCv.getBoundingClientRect();
      boardCands = cands.filter(function (c) {
        var cr = c.getBoundingClientRect();
        return Math.abs(cr.width - mr.width) < 20 && Math.abs(cr.height - mr.height) < 20 &&
               Math.abs(cr.left - mr.left) < 20 && Math.abs(cr.top - mr.top) < 20;
      });
      if (!boardCands.length) boardCands = [mainCv];
    }
    if (!mainCv) return null;
    var best = null;   
    var b64 = null;
    try { b64 = composeBoardImage(boardCands); } catch (e) { b64 = null; }
    if (b64) {
      try {
        
        var resp = await tryLocal(PY_HOSTS, '/recognize', {
          method: 'POST',
          body: JSON.stringify({ image: b64.split(',')[1], size: 15 })
        });
        var data = await resp.json();
        
        if (data.ok && data.geometry && !data.suspect) {
          var stones = (data.black || []).length + (data.white || []).length;
          best = { data: data, cv: mainCv, stones: stones, conf: data.geometry.confidence || 0 };
          
          if (stones === 0) {
            for (var i = 0; i < boardCands.length; i++) {
              var c = boardCands[i];
              if (c.width < 200 || c.height < 200) continue;
              var b1 = null;
              try { b1 = composeBoardImage([c]); } catch (e) { b1 = null; }
              if (!b1) continue;
              var r2 = await tryLocal(PY_HOSTS, '/recognize', {
                method: 'POST',
                body: JSON.stringify({ image: b1.split(',')[1], size: 15 })
              });
              var d2 = await r2.json();
              if (d2.ok && d2.geometry && !d2.suspect) {
                var s2 = (d2.black || []).length + (d2.white || []).length;
                if (s2 > best.stones) best = { data: d2, cv: c, stones: s2, conf: d2.geometry.confidence || 0 };
              }
            }
          }
        }
      } catch (e) {  }
    }
    if (!best) return null;   
    {
      var c = best.cv, data = best.data;
      var g = data.geometry;
      
      var nb = (data.black || []).length, nw = (data.white || []).length;
      if ((nb + nw) >= 6 && (Math.abs(nb - nw) > 2 || Math.max(nb, nw) > N * N * 0.8)) {
        diag('py board rejected: black=' + nb + ' white=' + nw + ' (misread)');
        return null;
      }
      var board = emptyBoard();
      (data.black || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 1; });
      (data.white || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 2; });
      var rr = c.getBoundingClientRect();
      
      var oldCal0 = pyBoardCache && pyBoardCache.cal;
      var oldLast = pyBoardCache && pyBoardCache.lastRect;
      var geoStable = oldCal0 && !oldCal0.isScreen && oldCal0.mode !== 'wulin' &&
        Math.abs(oldCal0.x0 - g.x0) < 5 && Math.abs(oldCal0.y0 - g.y0) < 5 &&
        Math.abs(oldCal0.stepX - g.stepX) < 2 && Math.abs(oldCal0.stepY - g.stepY) < 2 &&
        oldLast && Math.abs(rr.left - oldLast.left) < 5 && Math.abs(rr.top - oldLast.top) < 5;
      var cal = geoStable ? oldCal0 : {
        x0: g.x0, y0: g.y0, stepX: g.stepX, stepY: g.stepY,
        bg: g.bg, cell: g.stepX, gridScore: 0,
        docRect: rr, topRect: toTopRect(c), frameWin: c.ownerDocument.defaultView || window,
        isScreen: false, mode: 'py'
      };
      pyBoardCache = { cv: c, cal: cal, board: board, lastRect: { left: rr.left, top: rr.top, width: rr.width, height: rr.height }, t: Date.now() };
      cachedBoard = pyBoardCache;
      drawCalibFrame(cal, c);
      attachClickWatch(c, cal);
      lastBoardFail = 'none';
      setStatus(SF('cv_ok', '{src}', g.source || '', '{c}', Math.round((g.confidence || 0) * 100), '{n}', best.stones));
      return pyBoardCache;
    }
  }

  var screenBoard = null;
  async function tryScreenBoard() {
    var sb;
    try { sb = await captureBoard(); } catch (e) { sb = null; }
    if (sb) {
      screenBoard = sb;
      screenFails = 0;
      setStatus(SF('shot_ok', '{mode}', (sb.cal.mode === 'tab') ? (S.lang==='en'?'tab':'标签页') : (S.lang==='en'?'screen':'屏幕')));
    } else {
      screenBoard = null;
      if (screenDenied) {
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'Screenshot permission denied. Click Re-scan to retry.' : '截屏授权已取消，不再自动弹出。点「重新识别」可再次尝试') + '</span>');
      } else if (++screenFails >= 2) {
        screenAutoOff = true;
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'No board in screenshot. Auto-retry paused; click Re-scan to retry.' : '截屏中未找到棋盘，已暂停自动重试。点「重新识别」手动重试') + '</span>');
      }
    }
  }
  async function captureBoard() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return null;
    var prevVis = root.style.visibility;
    root.style.visibility = 'hidden';   
    var pwEl = document.getElementById('__gb_poswin');
    var pwVis = pwEl ? pwEl.style.visibility : '';
    if (pwEl) pwEl.style.visibility = 'hidden';   
    var stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false }); }
    catch (e) {
      if (pwEl) pwEl.style.visibility = pwVis;
      root.style.visibility = prevVis;
      
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError' || e.name === 'SecurityError')) screenDenied = true;
      return null;
    }
    try {
      var video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise(function (res) {
        video.onloadeddata = res;
        if (video.readyState >= 2) res();
        setTimeout(res, 3000);
      });
      var cv = document.createElement('canvas');
      cv.width = video.videoWidth || 1280; cv.height = video.videoHeight || 720;
      var ctx = cv.getContext('2d');
      ctx.drawImage(video, 0, 0);
      var img;
      try { img = ctx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return null; }
      var settings = {};
      try { settings = video.getSettings ? video.getSettings() : {}; } catch (e) {}
      var mode = (settings.displaySurface === 'browser') ? 'tab' : 'screen';
      var cal = findBoardInImage(img, cv.width, cv.height);
      if (!cal) return null;
      
      var dx = (mode === 'tab') ? 0 : (window.screenX || 0);
      var dy = (mode === 'tab') ? 0 : (window.screenY || 0);
      cal.isScreen = true;
      cal.mode = mode;
      cal.clientX0 = cal.x0 - dx;
      cal.clientY0 = cal.y0 - dy;
      cal.bw = cal.lastX - cal.x0; cal.bh = cal.lastY - cal.y0;
      cal.topRect = { left: cal.clientX0, top: cal.clientY0, width: cal.bw, height: cal.bh };
      cal.docRect = cal.topRect;
      cal.frameWin = window;
      return { cv: cv, cal: cal };
    } catch (e) { return null; }
    finally {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      if (pwEl) pwEl.style.visibility = pwVis;
      root.style.visibility = prevVis;
    }
  }
  
  function findBoardInImage(img, w, h) {
    var sum = 0, n = 0;
    for (var y = 0; y < h; y += 4) for (var x = 0; x < w; x += 4) {
      var o = (y * w + x) * 4; if (img[o + 3] < 128) continue; sum += lumOf(img, o); n++;
    }
    if (!n) return null;
    var bg = sum / n;
    var diff = Math.max(12, Math.min(42, bg * 0.22));
    var rowSc = new Array(h), colSc = new Array(w);
    for (var y = 0; y < h; y++) {
      var dk = 0, t = 0;
      for (var x = 0; x < w; x += 2) {
        var o = (y * w + x) * 4; if (img[o + 3] < 128) continue; t++;
        if (bg - lumOf(img, o) > diff) dk++;
      }
      rowSc[y] = t ? dk / t : 0;
    }
    for (var x = 0; x < w; x++) {
      dk = 0; t = 0;
      for (var y = 0; y < h; y += 2) {
        var o = (y * w + x) * 4; if (img[o + 3] < 128) continue; t++;
        if (bg - lumOf(img, o) > diff) dk++;
      }
      colSc[x] = t ? dk / t : 0;
    }
    function peaks(score) {
      var out = [], inL = false;
      for (var i = 0; i < score.length; i++) {
        
        if (score[i] > 0.12) { if (!inL) { inL = true; out.push(i); } }
        else inL = false;
      }
      return out;
    }
    function findGrid(lines) {
      if (!lines || lines.length < 12) return null;
      var diffs = {};
      for (var i = 1; i < lines.length; i++) {
        var d = lines[i] - lines[i - 1];
        diffs[d] = (diffs[d] || 0) + 1;
      }
      var bestD = 0, bestC = 0;
      for (var d in diffs) { if (diffs[d] > bestC) { bestC = diffs[d]; bestD = +d; } }
      if (bestD < 8 || bestD > 220) return null;
      
      var tol = Math.max(2, bestD * 0.10);
      var best = null, bestScore = 1e18;
      for (var off = lines[0] - bestD * 2; off <= lines[lines.length - 1] - bestD * 12; off += 2) {
        var matched = 0, devSum = 0;
        for (var k = 0; k < 15; k++) {
          var t = off + k * bestD, bd = 1e9;
          for (var j = 0; j < lines.length; j++) { var dd = Math.abs(lines[j] - t); if (dd < bd) bd = dd; }
          if (bd <= tol) { matched++; devSum += bd; }
        }
        if (matched >= 12) {
          var score = (15 - matched) * 1000 + devSum;
          if (score < bestScore) {
            bestScore = score;
            var g = [];
            for (var k2 = 0; k2 < 15; k2++) {
              var t2 = off + k2 * bestD, bd2 = 1e9, bi2 = -1;
              for (var j2 = 0; j2 < lines.length; j2++) { var dd2 = Math.abs(lines[j2] - t2); if (dd2 < bd2) { bd2 = dd2; bi2 = j2; } }
              if (bd2 <= tol) g.push(lines[bi2]);
            }
            if (g.length >= 12) {
              var step = (g[g.length - 1] - g[0]) / (g.length - 1);
              if (step >= 8 && step <= 220) best = { first: g[0], last: g[g.length - 1], step: step, count: g.length };
            }
          }
        }
      }
      return best;
    }
    var hg = findGrid(peaks(rowSc)), vg = findGrid(peaks(colSc));
    if (!hg || !vg) return null;
    var aspect = (vg.last - vg.first) / Math.max(1, (hg.last - hg.first));
    if (aspect < 0.7 || aspect > 1.45) return null;   
    return { x0: vg.first, y0: hg.first, lastX: vg.last, lastY: hg.last, stepX: vg.step, stepY: hg.step, bg: bg, cell: vg.step };
  }

  var DET_CFG = {
    BOARD_SIZE: 15,
    GRID_LINE_THRESHOLD: 0.25,  
    GRID_LINE_DIFF: 22,         
    BG_SAMPLE_MARGIN: 0.06,     
    STONE_RADIUS_RATIO: 0.35,   
  };

  function lumOf(img, i) { return 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]; }

  function calibrate(cv) {
    var w = cv.width, h = cv.height;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return null; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, w, h).data; } catch (e) { return null; }

    var bgBrightCache = null;
    function getBgBright() {
      if (bgBrightCache != null) return bgBrightCache;
      
      var m = Math.max(2, (Math.min(w, h) * DET_CFG.BG_SAMPLE_MARGIN) | 0);
      var sum = 0, n = 0, tr2 = 0, tt2 = 0;
      var corners = [[m, m], [w - m, m], [m, h - m], [w - m, h - m]];
      for (var c = 0; c < corners.length; c++) {
        var cx0 = corners[c][0], cy0 = corners[c][1];
        for (var dy = -m; dy <= m; dy += 2) for (var dx = -m; dx <= m; dx += 2) {
          var sx = cx0 + dx, sy = cy0 + dy;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          var o = (sy * w + sx) * 4;
          tt2++;
          if (img[o + 3] < 96) { tr2++; continue; }
          if (img[o + 3] >= 128) { sum += lumOf(img, o); n++; }
        }
      }
      var bgBright;
      if (n >= 30) {
        
        bgBright = sum / n;
      } else {
      var hist = new Array(256).fill(0), tot = 0, tr = 0, ttot = 0;
        for (var yy = 0; yy < h; yy += 3) for (var xx = 0; xx < w; xx += 3) {
          var o2 = (yy * w + xx) * 4;
          ttot++;
          if (img[o2 + 3] < 96) { tr++; continue; }
          hist[(lumOf(img, o2) | 0)]++; tot++;
        }
        var bestK = 128, bestC = -1;
        for (var k = 0; k < 256; k++) if (hist[k] > bestC) { bestC = hist[k]; bestK = k; }
        bgBright = tot ? bestK : 128;
        
        if (ttot && tr / ttot > 0.30) {
          var csBg = '';
          try { csBg = getComputedStyle(cv).backgroundColor; } catch (e) {}
          var m2 = csBg && csBg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
          if (m2) bgBright = 0.299 * (+m2[1]) + 0.587 * (+m2[2]) + 0.114 * (+m2[3]);
        }
      }
      bgBrightCache = bgBright;
      return bgBright;
    }

    function findLines(score, thr) {
      var lines = [], inLine = false, maxSc = 0, maxPos = 0;
      for (var i = 0; i < score.length; i++) {
        if (score[i] > thr) {
          if (!inLine) { inLine = true; maxSc = score[i]; maxPos = i; }
          else if (score[i] > maxSc) { maxSc = score[i]; maxPos = i; }
        } else if (inLine) { lines.push(maxPos); inLine = false; }
      }
      if (inLine) lines.push(maxPos);
      return lines;
    }

    function scanGrid(diff, thr, rect) {
      var x0r = rect ? rect.x0 : 0, y0r = rect ? rect.y0 : 0;
      var x1r = rect ? rect.x1 : w - 1, y1r = rect ? rect.y1 : h - 1;
      var bgBright = getBgBright();
      var rowScore = new Array(h), colScore = new Array(w);
      for (var y = 0; y < h; y++) {
        var dark = 0, tot = 0;
        for (var x = 0; x < w; x += 2) {
          var o3 = (y * w + x) * 4;
          tot++;
          
          if (img[o3 + 3] >= 96 && bgBright - lumOf(img, o3) > diff) dark++;
        }
        rowScore[y] = tot ? dark / tot : 0;
      }
      for (var x2 = 0; x2 < w; x2++) {
        dark = 0; tot = 0;
        for (var y2 = 0; y2 < h; y2 += 2) {
          var o4 = (y2 * w + x2) * 4;
          tot++;
          if (img[o4 + 3] >= 96 && bgBright - lumOf(img, o4) > diff) dark++;
        }
        colScore[x2] = tot ? dark / tot : 0;
      }
      var hLines = findLines(rowScore, thr), vLines = findLines(colScore, thr);
      
      function pickGrid(lines) {
        if (!lines || lines.length < 4) return [];
        var diffs = {};
        for (var i = 1; i < lines.length; i++) { var d = lines[i] - lines[i - 1]; diffs[d] = (diffs[d] || 0) + 1; }
        var ds = Object.keys(diffs).map(Number).sort(function (a, b) { return diffs[b] - diffs[a]; });
        var cands = [];
        for (var di = 0; di < Math.min(6, ds.length); di++) {
          var bestD = ds[di];
          if (bestD < 4 || bestD > 200) continue;
          var tol = Math.max(2, bestD * 0.10);
          var best = null, bestScore = 1e18;
          for (var off = lines[0] - bestD * 2; off <= lines[lines.length - 1] - bestD * 12; off += 2) {
            var matched = 0, devSum = 0;
            for (var k = 0; k < 15; k++) {
              var t = off + k * bestD, bd = 1e9;
              for (var j = 0; j < lines.length; j++) { var dd = Math.abs(lines[j] - t); if (dd < bd) bd = dd; }
              if (bd <= tol) { matched++; devSum += bd; }
            }
            if (matched >= 12) {
              var score = (15 - matched) * 1000 + devSum;
              if (score < bestScore) {
                bestScore = score;
                var g = [];
                for (var k2 = 0; k2 < 15; k2++) {
                  var t2 = off + k2 * bestD, bd2 = 1e9, bi2 = -1;
                  for (var j2 = 0; j2 < lines.length; j2++) { var dd2 = Math.abs(lines[j2] - t2); if (dd2 < bd2) { bd2 = dd2; bi2 = j2; } }
                  if (bd2 <= tol) g.push(lines[bi2]);
                }
                best = { first: g[0], last: g[g.length - 1], count: g.length, score: bestScore, d: bestD };
              }
            }
          }
          if (best) cands.push(best);
        }
        cands.sort(function (a, b) { return a.score - b.score; });
        return cands;
      }
      var hgList = pickGrid(hLines), vgList = pickGrid(vLines);
      
      for (var hi = 0; hi < hgList.length; hi++) {
        for (var vi = 0; vi < vgList.length; vi++) {
          var hg = hgList[hi], vg = vgList[vi];
          var bx = vg.first, by = hg.first, bw = vg.last - vg.first, bh = hg.last - hg.first;
          var nx = vg.count, ny = hg.count;
          var stepX = bw / (nx - 1), stepY = bh / (ny - 1);
          if (stepX < 4 || stepX > 200) continue;
          var stepRatio = stepX / Math.max(1, stepY);
          if (stepRatio < 0.7 || stepRatio > 1.45) continue;
          if (bx < -2 || by < -2 || bx > w - stepX * 3 || by > h - stepY * 3) continue;
          var lineDark = 0;
          for (var k = 0; k < 15; k++) {
            var lx = bx + k * stepX, ly = by + k * stepY;
            for (var t = 0; t < 15; t++) {
              var px1 = Math.round(lx), py1 = Math.round(by + t * stepY);
              if (px1 >= 0 && px1 < w && py1 >= 0 && py1 < h) {
                var o1 = (py1 * w + px1) * 4;
                if (img[o1 + 3] >= 96 && bgBright - lumOf(img, o1) > diff) lineDark++;
              }
              var px2 = Math.round(bx + t * stepX), py2 = Math.round(ly);
              if (px2 >= 0 && px2 < w && py2 >= 0 && py2 < h) {
                var o2 = (py2 * w + px2) * 4;
                if (img[o2 + 3] >= 96 && bgBright - lumOf(img, o2) > diff) lineDark++;
              }
            }
          }
          if (lineDark < 200) continue;
          var gs = vg.score + hg.score;
          return { x0: bx, y0: by, stepX: stepX, stepY: stepY, bg: bgBright, cell: stepX, gridScore: gs };
        }
      }
      
      if (hLines.length >= 2 && vLines.length >= 2) {
        var bx2 = vLines[0], by2 = hLines[0], bw2 = vLines[vLines.length - 1] - bx2, bh2 = hLines[hLines.length - 1] - by2;
        var nx2 = vLines.length, ny2 = hLines.length;
        var stepX2 = bw2 / (nx2 - 1), stepY2 = bh2 / (ny2 - 1);
        if (stepX2 >= 4 && stepX2 <= 200) {
          var stepRatio2 = stepX2 / Math.max(1, stepY2);
          if (stepRatio2 >= 0.7 && stepRatio2 <= 1.45) {
            var gs2 = 100000 + vLines.length + hLines.length;
            return { x0: bx2, y0: by2, stepX: stepX2, stepY: stepY2, bg: bgBright, cell: stepX2, gridScore: gs2 };
          }
        }
      }
      return null;   
      
      var gs = (vg && vg.score != null ? vg.score : 100000 + vLines.length) + (hg && hg.score != null ? hg.score : 100000 + hLines.length);
      return { x0: bx, y0: by, stepX: stepX, stepY: stepY, bg: bgBright, cell: stepX, gridScore: gs };
    }

    function bgRect() {
      var hist = {}, bestK = null, bestC = 0, totS = 0;
      for (var y = 0; y < h; y += 4) for (var x = 0; x < w; x += 4) {
        var o = (y * w + x) * 4;
        totS++;
        if (img[o + 3] < 128) continue;
        var key = ((img[o] >> 5) << 10) | ((img[o + 1] >> 5) << 5) | (img[o + 2] >> 5);
        hist[key] = (hist[key] || 0) + 1;
        if (hist[key] > bestC) { bestC = hist[key]; bestK = key; }
      }
      if (!bestK || bestC < totS * 0.04) return null;
      var mr = (((bestK >> 10) & 31) << 5) | 16, mg = (((bestK >> 5) & 31) << 5) | 16, mb = ((bestK & 31) << 5) | 16;
      var tol = 30;
      var cnt = 0, tot = 0;
      for (var y = 0; y < h; y += 4) for (var x = 0; x < w; x += 4) {
        var o = (y * w + x) * 4; tot++;
        if (img[o + 3] >= 128 && Math.abs(img[o] - mr) < tol && Math.abs(img[o + 1] - mg) < tol && Math.abs(img[o + 2] - mb) < tol) cnt++;
      }
      if (!tot || cnt / tot < 0.04) return null;
      function segLen(score, t, len) {
        var best = null, cur = 0, curS = 0;
        for (var i = 0; i <= len; i++) {
          var on = i < len && score[i] > t;
          if (on) { if (cur === 0) curS = i; cur++; }
          else if (cur > 0) { if (!best || cur > best.len) best = { s: curS, e: i - 1, len: cur }; cur = 0; }
        }
        return best;
      }
      var rowScore = new Array(h), colScore = new Array(w);
      for (var y = 0; y < h; y++) {
        var rc = 0, rt = 0;
        for (var x = 0; x < w; x += 4) {
          var o = (y * w + x) * 4; rt++;
          if (img[o + 3] >= 128 && Math.abs(img[o] - mr) < tol && Math.abs(img[o + 1] - mg) < tol && Math.abs(img[o + 2] - mb) < tol) rc++;
        }
        rowScore[y] = rt ? rc / rt : 0;
      }
      for (var x = 0; x < w; x++) {
        var cc = 0, ct = 0;
        for (var y = 0; y < h; y += 4) {
          var o = (y * w + x) * 4; ct++;
          if (img[o + 3] >= 128 && Math.abs(img[o] - mr) < tol && Math.abs(img[o + 1] - mg) < tol && Math.abs(img[o + 2] - mb) < tol) cc++;
        }
        colScore[x] = ct ? cc / ct : 0;
      }
      var rs = segLen(rowScore, 0.55, h), cs = segLen(colScore, 0.55, w);
      if (!rs || !cs || rs.len < 60 || cs.len < 60) return null;
      var bw2 = cs.e - cs.s, bh2 = rs.e - rs.s;
      if (bw2 < 80 || bh2 < 80) return null;
      var asp = bh2 / bw2;
      if (asp < 0.7 || asp > 1.45) return null;
      return { x0: cs.s, y0: rs.s, x1: cs.e, y1: rs.e, color: [Math.round(mr), Math.round(mg), Math.round(mb)] };
    }

    var rect = bgRect();
    var r0 = null;
    if (rect) {
      r0 = scanGrid(DET_CFG.GRID_LINE_DIFF, 0.03, rect);
      if (r0) {
        try { window.__gbDebug = { rect: rect, got: 'rect', cal: r0 }; } catch (e) {}
        return r0;
      }
    }
    
    var r1 = scanGrid(DET_CFG.GRID_LINE_DIFF, 0.05, null);
    if (r1) {
      try { window.__gbDebug = { rect: rect, got: 'full', cal: r1 }; } catch (e) {}
      return r1;
    }
    
    var r2 = scanGrid(Math.max(8, (DET_CFG.GRID_LINE_DIFF / 2) | 0), 0.03, null);
    try { window.__gbDebug = { rect: rect, got: r2 ? 'loose' : 'none', cal: r2 || null }; } catch (e) {}
    return r2;
  }

  function emptyBoard() {
    var b = [];
    for (var j = 0; j < N; j++) b.push(new Array(N).fill(0));
    return b;
  }

  function readBoard(cal, cv) {
    var w = cv.width, h = cv.height;
    
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return emptyBoard(); }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, w, h).data; } catch (e) { return emptyBoard(); }
    var bx = cal.x0, by = cal.y0, stepX = cal.stepX, stepY = cal.stepY, bgBright = cal.bg;
    var board = emptyBoard();
    var winR = Math.max(2, Math.min(stepX, stepY) * DET_CFG.STONE_RADIUS_RATIO | 0);
    var rIn2 = winR * winR, r0 = winR * 1.4, r1 = winR * 1.9, rMax = Math.ceil(r1);
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var cx = (bx + c * stepX) | 0, cy = (by + r * stepY) | 0;
        var diskSum = 0, diskN = 0, bgSum = 0, bgN = 0;
        for (var dy = -rMax; dy <= rMax; dy++) {
          for (var dx = -rMax; dx <= rMax; dx++) {
            var d2 = dx * dx + dy * dy;
            var px = cx + dx, py = cy + dy;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            var o = (py * w + px) * 4;
            if (img[o + 3] < 128) continue;   
            var b = lumOf(img, o);
            if (d2 <= rIn2) { diskSum += b; diskN++; }
            else if (d2 >= r0 * r0 && d2 <= r1 * r1 && ((dx + dy) & 1) === 0) { bgSum += b; bgN++; }
          }
        }
        var localBg = bgN ? bgSum / bgN : bgBright;
        var diskLum = diskN ? diskSum / diskN : localBg;
        var dev = diskLum - localBg;
        
        var bgTol = Math.max(10, Math.min(bgBright * 0.08, (255 - bgBright) * 0.5));
        var needDev = Math.min(22, Math.max(7, (255 - bgBright) * 0.35));
        if (diskLum < bgBright - bgTol && dev < -22) board[r][c] = 1;            
        else if (diskLum > bgBright + bgTol && dev > needDev) board[r][c] = 2;   
      }
    }
    return board;
  }

  function countStones(b) {
    var n = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) if (b[j][i]) n++;
    return n;
  }
  
  function maxLineLen(b, color) {
    var best = 0;
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      if (b[r][c] !== color) continue;
      for (var d = 0; d < 4; d++) {
        var dr = dirs[d][0], dc = dirs[d][1];
        var pr = r - dr, pc = c - dc;                 
        if (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === color) continue;
        var len = 1;
        for (var nr = r + dr, nc = c + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) len++;
        if (len > best) best = len;
      }
    }
    return best;
  }
  
  function allImmediateFiveCells(b, color, renjuBlack) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    var out = [];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      if (b[r][c] !== 0) continue;
      for (var d = 0; d < 4; d++) {
        var dr = dirs[d][0], dc = dirs[d][1];
        
        var cnt = 1;
        for (var nr = r + dr, nc = c + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) cnt++;
        for (var nr = r - dr, nc = c - dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr -= dr, nc -= dc) cnt++;
        if (renjuBlack ? cnt === 5 : cnt >= 5) { out.push({ i: c, j: r }); break; }
      }
    }
    return out;
  }
  
  function findImmediateFive(b, color) {
    var all = allImmediateFiveCells(b, color, false);
    return all.length ? all[0] : null;
  }

  var DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function lineInfoAt(b, color, x, y, dr, dc) {
    var len = 1, openA = false, openB = false;
    var nr = y + dr, nc = x + dc;
    while (nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color) { len++; nr += dr; nc += dc; }
    if (nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === 0) openA = true;
    var pr = y - dr, pc = x - dc;
    while (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === color) { len++; pr -= dr; pc -= dc; }
    if (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === 0) openB = true;
    return { len: len, openA: openA, openB: openB };
  }

  function isFourInDir(b, color, x, y, dr, dc) {
    var li = lineInfoAt(b, color, x, y, dr, dc);
    if (li.len >= 5) return false;              
    if (li.len === 4) return li.openA || li.openB;   
    
    var cnt = 0;
    for (var s = -4; s <= 4; s++) {
      if (s === 0) continue;
      var nx = x + dc * s, ny = y + dr * s;
      if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
      if (b[ny][nx] !== 0) continue;
      
      var l2 = 1;
      for (var k = 1; k <= 5; k++) { var ax = nx + dc * k, ay = ny + dr * k; if (ax < 0 || ax >= N || ay < 0 || ay >= N || (b[ay][ax] !== color && !(ax === x && ay === y))) break; l2++; }
      for (var k2 = 1; k2 <= 5; k2++) { var bx2 = nx - dc * k2, by2 = ny - dr * k2; if (bx2 < 0 || bx2 >= N || by2 < 0 || by2 >= N || (b[by2][bx2] !== color && !(bx2 === x && by2 === y))) break; l2++; }
      if (l2 === 5) cnt++;
    }
    return cnt > 0;
  }

  function isOpenThreeInDir(b, color, x, y, dr, dc) {
    var li = lineInfoAt(b, color, x, y, dr, dc);
    if (li.len >= 4) return false;                       
    
    for (var st = -2; st <= 0; st++) {
      var segOk = true;
      
      for (var k = 0; k < 3; k++) {
        var s1 = st + k;
        var ax = x + dc * s1, ay = y + dr * s1;
        if (ax < 0 || ax >= N || ay < 0 || ay >= N) { segOk = false; break; }
        if (!(b[ay][ax] === color || (s1 === 0))) { segOk = false; break; }
      }
      if (!segOk) continue;
      
      var ex = x + dc * st, ey = y + dr * st;                    
      var bx0 = ex - dc, by0 = ey - dr;                          
      var ex2 = x + dc * (st + 2), ey2 = y + dr * (st + 2);      
      var bx1 = ex2 + dc, by1 = ey2 + dr;                        
      var openA = (bx0 >= 0 && bx0 < N && by0 >= 0 && by0 < N && b[by0][bx0] === 0);
      var openB = (bx1 >= 0 && bx1 < N && by1 >= 0 && by1 < N && b[by1][bx1] === 0);
      if (openA && openB) return true;
    }
    return false;
  }

  function renjuBlackForbidden(b, x, y) {
    if (b[y][x] !== 0) return '';
    var d, fours = 0, threes = 0, overline = false;
    for (d = 0; d < 4; d++) {
      var dr = DIRS4[d][0], dc = DIRS4[d][1];
      var li = lineInfoAt(b, 1, x, y, dr, dc);
      if (li.len >= 6) { overline = true; continue; }         
      if (li.len === 5) continue;                             
      if (isFourInDir(b, 1, x, y, dr, dc)) fours++;
      else if (isOpenThreeInDir(b, 1, x, y, dr, dc)) threes++;
    }
    if (overline) return 'overline';
    if (fours >= 2) return 'double-four';
    if (threes >= 2) return 'double-three';
    return '';
  }

  function renjuForbiddenCells(b) {
    var out = [];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      if (b[r][c] !== 0) continue;
      if (renjuBlackForbidden(b, c, r)) out.push({ x: c, y: r });
    }
    return out;
  }

  var engineForbidSet = null, engineForbidFp = null;

  function noteEngineForbid(data, fpKey) {
    if (data && data.forbid && data.forbid.length !== undefined) {
      engineForbidSet = {};
      for (var i = 0; i < data.forbid.length; i++) {
        var f = data.forbid[i];
        if (f && f.length === 2) engineForbidSet[f[0] + ',' + f[1]] = 1;
      }
      engineForbidFp = fpKey;
    } else if (fpKey !== engineForbidFp) {
      engineForbidSet = null;   
    }
  }

  function isForbiddenPoint(board, x, y, rule, color) {
    if (rule !== 2) return false;
    if (color !== 1) return false;                     
    if (!board || !board[y] || board[y][x] !== 0) return false;
    if (engineForbidSet && engineForbidSet[x + ',' + y]) return true;   
    return !!renjuBlackForbidden(board, x, y);                          
  }

  function filterForbiddenCands(board, list, rule, color) {
    if (rule !== 2 || color !== 1 || !list || !list.length) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c.x < 0 || c.y < 0 || c.x >= N || c.y >= N) continue;
      if (isForbiddenPoint(board, c.x, c.y, rule, color)) continue;
      out.push(c);
    }
    return out;
  }
  
  function maxLineLenAfter(b, color, x, y) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], best = 0;
    for (var d = 0; d < 4; d++) {
      var dr = dirs[d][0], dc = dirs[d][1], len = 1;
      for (var nr = y + dr, nc = x + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) len++;
      for (var nr2 = y - dr, nc2 = x - dc; nr2 >= 0 && nr2 < N && nc2 >= 0 && nc2 < N && b[nr2][nc2] === color; nr2 -= dr, nc2 -= dc) len++;
      if (len > best) best = len;
    }
    return best;
  }
  
  function oppTurnNow(board) {
    var bc = 0, wc = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) { if (board[j][i] === 1) bc++; else if (board[j][i] === 2) wc++; }
    var toMoveBlack = (bc === wc);
    if (mySideMask() < 0) return null;
    var ourBlack = (mySideMask() === 0);
    return (ourBlack !== toMoveBlack);
  }
  
  function nego2My(pv, myIsSideToMove) { return myIsSideToMove ? pv : (1 - pv); }
  
  function nearestEmpty(b, i, j) {
    for (var rad = 1; rad < N; rad++) {
      for (var dy = -rad; dy <= rad; dy++) for (var dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        var x = i + dx, y = j + dy;
        if (x >= 0 && x < N && y >= 0 && y < N && b[y][x] === 0) return { i: x, j: y };
      }
    }
    return null;
  }
  
  function nearestLegalEmpty(b, i, j, rule, color) {
    for (var rad = 1; rad < N; rad++) {
      for (var dy = -rad; dy <= rad; dy++) for (var dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        var x = i + dx, y = j + dy;
        if (x < 0 || x >= N || y < 0 || y >= N || b[y][x] !== 0) continue;
        if (isForbiddenPoint(b, x, y, rule, color)) continue;
        return { i: x, j: y };
      }
    }
    return null;
  }
  
  function autoAnchorPick(board, data, candArr, forbidColor, opts) {
    var N = board.length;
    
    var shallow = !!(opts && opts.budgetMs !== undefined && opts.budgetMs < 2500);
    function emptyCell(x, y) { return x >= 0 && y >= 0 && x < N && y < N && board[y] && board[y][x] === 0; }
    
    function nearStone(x, y) {
      if (!emptyCell(x, y)) return false;
      for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
        var yy = y + dj, xx = x + di;
        if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
        if (board[yy][xx] !== 0) return true;
      }
      return false;
    }
    function ok(x, y) {
      if (!emptyCell(x, y)) return false;
      if (forbidColor && isForbiddenPoint(board, x, y, S.rule, forbidColor)) return false;
      return true;
    }
    
    function makesFive(x, y, color) {
      var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (var d = 0; d < 4; d++) {
        var cnt = 1;
        for (var s = 1; s <= 4; s++) {
          var yy = y + dirs[d][1] * s, xx = x + dirs[d][0] * s;
          if (yy < 0 || xx < 0 || yy >= N || xx >= N || board[yy][xx] !== color) break;
          cnt++;
        }
        for (var t = 1; t <= 4; t++) {
          var y2 = y - dirs[d][1] * t, x2 = x - dirs[d][0] * t;
          if (y2 < 0 || x2 < 0 || y2 >= N || x2 >= N || board[y2][x2] !== color) break;
          cnt++;
        }
        if (cnt >= 5) return true;
      }
      return false;
    }
    
    function isThreat(x, y, color) { return makesFive(x, y, color) || makesFive(x, y, color === 1 ? 2 : 1); }
    
    var hugOppColor = (forbidColor === 1) ? 2 : (forbidColor === 2 ? 1 : 0);
    var hugOpp = false;
    if (hugOppColor === 1) {
      var stones0 = 0;
      for (var y0 = 0; y0 < N; y0++) for (var x0 = 0; x0 < N; x0++) if (board[y0] && board[y0][x0] !== 0) stones0++;
      hugOpp = stones0 <= 10;
    }
    function nearOpp(x, y) {
      for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
        var yy = y + dj, xx = x + di;
        if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
        if (board[yy][xx] === hugOppColor) return true;
      }
      return false;
    }
    
    var hugFallback = null;
    if (data && data.best && data.best.length === 2 && data.best[0] >= 0 && data.best[1] >= 0) {
      var bx = data.best[0], by = data.best[1];
      if (ok(bx, by)) {
        var threat0 = isThreat(bx, by, forbidColor);
        if (!shallow || threat0 || nearStone(bx, by)) {
          if (!hugOpp || nearOpp(bx, by) || threat0) return [bx, by];
          hugFallback = [bx, by];
        }
      }
    }
    
    var src = (data && data.candidates && data.candidates.length) ? data.candidates
            : (candArr && candArr.length ? candArr : null);
    if (src) {
      if (hugOpp) {
        for (var k2 = 0; k2 < src.length; k2++) {
          var c2 = src[k2];
          if (c2 && c2.x >= 0 && c2.y >= 0 && ok(c2.x, c2.y) && nearStone(c2.x, c2.y) && nearOpp(c2.x, c2.y)) return [c2.x, c2.y];
        }
        if (hugFallback) return hugFallback;   
      }
      if (shallow) {
        for (var k = 0; k < src.length; k++) {
          var c = src[k];
          if (c && c.x >= 0 && c.y >= 0 && ok(c.x, c.y) && (nearStone(c.x, c.y) || isThreat(c.x, c.y, forbidColor))) return [c.x, c.y];
        }
      } else {
        for (var k3 = 0; k3 < src.length; k3++) {
          var c3 = src[k3];
          if (c3 && c3.x >= 0 && c3.y >= 0 && ok(c3.x, c3.y)) return [c3.x, c3.y];
        }
      }
    }
    
    var sx = 0, sy = 0, cnt = 0, found = false;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) if (board[y][x] !== 0) { sx += x; sy += y; cnt++; found = true; }
    if (found) {
      var cx = Math.round(sx / cnt), cy = Math.round(sy / cnt);
      var ne = nearestEmpty(board, cx, cy);
      if (ne && ok(ne.i, ne.j)) return [ne.i, ne.j];
    }
    
    if (data && data.best && data.best.length === 2 && data.best[0] >= 0 && data.best[1] >= 0 && ok(data.best[0], data.best[1]))
      return [data.best[0], data.best[1]];
    if (src && src[0] && src[0].x >= 0 && src[0].y >= 0 && ok(src[0].x, src[0].y)) return [src[0].x, src[0].y];
    return null;
  }
  
  function evalToScore(evStr, myIsSideToMove) {
    var out = { score: 0, verdict: 'none', matePly: 0, valid: false };   
    if (typeof evStr !== 'string' || !evStr.length) return out;
    var mN = evStr.match(/^\s*([+-]?)(\d+(?:\.\d+)?)\s*$/);
    var mM = evStr.match(/^\s*([+-]?)M(\d+)\s*$/i);
    if (mM) {
      out.valid = true;
      var negM = mM[1] === '-';
      var nMV = parseInt(mM[2], 10) || 1;
      out.matePly = nMV;
      
      var sideWins = (negM ? false : true);
      var myIsBenefited = (sideWins === myIsSideToMove);   
      
      out.score = myIsBenefited ? 1000 : -1000;
      out.verdict = myIsBenefited ? 'win' : 'lose';
    } else if (mN) {
      out.valid = true;
      var negN = mN[1] === '-';
      var E = (negN ? -1 : 1) * parseFloat(mN[2]);
      var mine = myIsSideToMove ? E : -E;                  
      out.score = Math.max(-1000, Math.min(1000, mine));
      out.verdict = 'none';
    }
    return out;
  }
  
  function evalToMine(evStr, myIsSideToMove) {
    var s = (typeof evStr === 'string') ? evStr.trim() : '';
    if (!s.length) return '';
    var mM = s.match(/^\s*([+-]?)M(\d+)\s*$/i);
    if (mM) {
      var sg = (mM[1] === '-') ? -1 : 1;
      var mine = myIsSideToMove ? sg : -sg;
      return (mine < 0 ? '-' : '+') + 'M' + mM[2];
    }
    var mN = s.match(/^\s*([+-]?)(\d+(?:\.\d+)?)\s*$/);
    if (mN) {
      var v = (mN[1] === '-' ? -1 : 1) * parseFloat(mN[2]);
      var mv = myIsSideToMove ? v : -v;
      return (mv > 0 ? '+' : '') + String(mv);
    }
    return s;          
  }
  
  function verifyBoard(cal, cv, board) {
    var off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return 0; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return 0; }
    var winR = Math.max(2, Math.min(cal.stepX, cal.stepY) * DET_CFG.STONE_RADIUS_RATIO | 0);
    var rIn2 = winR * winR, r0 = winR * 1.4, r1 = winR * 1.9, rMax = Math.ceil(r1);
    var bgTol = Math.max(10, cal.bg * 0.08);
    var ok = 0, bad = 0;
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        if (!board[j][i]) continue;
        var cx = (cal.x0 + i * cal.stepX) | 0, cy = (cal.y0 + j * cal.stepY) | 0;
        var diskSum = 0, diskN = 0, bgSum = 0, bgN = 0;
        for (var dy = -rMax; dy <= rMax; dy++) {
          for (var dx = -rMax; dx <= rMax; dx++) {
            var d2 = dx * dx + dy * dy;
            var px = cx + dx, py = cy + dy;
            if (px < 0 || px >= cv.width || py < 0 || py >= cv.height) continue;
            var o = (py * cv.width + px) * 4;
            if (img[o + 3] < 128) continue;
            var b = lumOf(img, o);
            if (d2 <= rIn2) { diskSum += b; diskN++; }
            else if (d2 >= r0 * r0 && d2 <= r1 * r1 && ((dx + dy) & 1) === 0) { bgSum += b; bgN++; }
          }
        }
        var localBg = bgN ? bgSum / bgN : cal.bg;
        var diskLum = diskN ? diskSum / diskN : localBg;
        var dev = diskLum - localBg;
        var v = 0;
        if (diskLum < cal.bg - bgTol && dev < -22) v = 1;
        else if (diskLum > cal.bg + bgTol && dev > 22) v = 2;
        if (v === board[j][i]) ok++;
        else bad++;
      }
    }
    var tot = ok + bad;
    if (!tot) return 0;
    return ok / tot;
  }

  function boardMatchRate(a, b) {
    var same = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) if (a[j][i] === b[j][i]) same++;
    return same / (N * N);
  }
  
  function flipBoardV(b) {
    var nb = emptyBoard();
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) nb[N - 1 - j][i] = b[j][i];
    return nb;
  }

  function roughStoneCheck(cal, cv) {
    var w = cv.width, h = cv.height;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return false; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, w, h).data; } catch (e) { return false; }
    var bg = cal.bg, diff = Math.max(16, bg * 0.30);
    var sx0 = cal.x0, sy0 = cal.y0, step = cal.stepX;
    var x0 = Math.max(0, sx0 | 0), y0 = Math.max(0, sy0 | 0);
    var x1 = Math.min(w, (sx0 + 14 * step) | 0), y1 = Math.min(h, (sy0 + 14 * step) | 0);
    
    var dark = 0, light = 0, tot = 0;
    for (var y = y0; y < y1; y += 3) {
      for (var x = x0; x < x1; x += 3) {
        var onLine = false;
        for (var k = 0; k < 15 && !onLine; k++) {
          var lx = sx0 + k * step, ly = sy0 + k * step;
          if (Math.abs(x - lx) <= 2 || Math.abs(y - ly) <= 2) onLine = true;
        }
        if (onLine) continue;
        var o = (y * w + x) * 4;
        if (img[o + 3] < 128) continue;
        var b = lumOf(img, o);
        tot++;
        if (b < bg - diff) dark++;
        else if (b > bg + diff) light++;
      }
    }
    if (!tot) return false;
    return (dark + light) / tot > 0.0015;   
  }
  function fingerprint(b) {
    return b.map(function (r) { return r.join(''); }).join('');
  }

  var root = document.createElement('div');
  root.id = '__gb_panel';
  root.style.cssText = 'position:fixed;z-index:2147483647;width:225px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
    'background:#fff;border:1px solid #e0e3e8;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
    'top:80px;right:20px;font-size:12px;color:#1d1d1f;overflow:hidden;';
  
  if (!document.getElementById('__gb_scroll_css')) {
    var sc = document.createElement('style');
    sc.id = '__gb_scroll_css';
    sc.textContent = '#__gb_panel ::-webkit-scrollbar{height:5px;width:5px}#__gb_panel ::-webkit-scrollbar-thumb{background:#b8bdc6;border-radius:3px}#__gb_panel ::-webkit-scrollbar-track{background:transparent}';
    (document.head || document.documentElement).appendChild(sc);
  }

  function optRow(attr, val, label, i18nKey) {
    return '<div class="__gb_opt" ' + attr + '="' + val + '" style="display:flex;align-items:center;padding:4px 12px;border-bottom:1px solid #f0f0f0;cursor:pointer;text-align:left;">' +
      '<span data-i18n="' + i18nKey + '" style="flex:1;text-align:left;">' + label + '</span>' +
      '<span class="__gb_chk" style="color:#43a047;font-size:14px;visibility:hidden;">✓</span></div>';
  }
  var stepBtn = '<button class="__gb_step" data-dir="%d" style="width:26px;height:26px;border-radius:50%;border:1.5px solid #43a047;color:#43a047;background:#fff;font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;">%s</button>';

  root.innerHTML =
    '<div id="__gb_hdr" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#3b7dd8;color:#fff;cursor:move;user-select:none;">' +
      '<span style="flex:1;font-weight:600;" data-i18n="title">' + T('title') + '</span>' +
      '<button id="__gb_lang" title="Language" style="background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:#fff;font-size:11px;cursor:pointer;padding:1px 8px;border-radius:4px;">' + T('lang') + '</button>' +
      
      '<button id="__gb_min" style="background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;">–</button>' +
      '<button id="__gb_close" style="background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;">×</button>' +
    '</div>' +
    '<div id="__gb_body">' +
      '<div style="font-size:11px;color:#9aa3ad;padding:4px 12px 0;" data-i18n="think">' + T('think') + '</div>' +
      '<div class="__gb_row" style="display:flex;align-items:center;padding:3px 12px;border-bottom:1px solid #f0f0f0;background:#fafbfc;">' +
        '<span class="__gb_lbl" style="flex:1;color:#555;" data-i18n="turn">' + T('turn') + '</span>' +
        stepBtn.replace('%d','turn-').replace('%s','−') +
        '<input id="__gb_turnval" type="number" min="1" max="120" step="1" value="5" ' +
          'style="width:52px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:2px 2px;font-size:12px;margin:0 2px;">' +
        stepBtn.replace('%d','turn+').replace('%s','+') +
      '</div>' +
      '<div class="__gb_row" style="display:flex;align-items:center;padding:3px 12px;border-bottom:1px solid #f0f0f0;background:#fafbfc;">' +
        '<span class="__gb_lbl" style="flex:1;color:#555;" data-i18n="match">' + T('match') + '</span>' +
        stepBtn.replace('%d','match-').replace('%s','−') +
        '<input id="__gb_matchval" type="number" min="30" max="9999" step="10" value="6000" ' +
          'style="width:52px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:2px 2px;font-size:12px;margin:0 2px;">' +
        stepBtn.replace('%d','match+').replace('%s','+') +
      '</div>' +
      '<div class="__gb_row" style="display:flex;align-items:center;padding:3px 12px;border-bottom:1px solid #f0f0f0;background:#fafbfc;">' +
        '<span class="__gb_lbl" style="flex:1;color:#555;" data-i18n="hash">' + T('hash') + '</span>' +
        stepBtn.replace('%d','hash-').replace('%s','−') +
        '<span id="__gb_hashval" style="min-width:48px;text-align:center;color:#333;font-size:12px;">' + T('hashAuto') + '</span>' +
        stepBtn.replace('%d','hash+').replace('%s','+') +
      '</div>' +
      '<div class="__gb_lbl2" style="font-size:11px;color:#9aa3ad;padding:4px 12px 0;" data-i18n="rule">' + T('rule') + '</div>' +
      optRow('data-rule', '0', T('rule0'), 'rule0') +
      optRow('data-rule', '1', T('rule1'), 'rule1') +
      optRow('data-rule', '2', T('rule2'), 'rule2') +
      '<div style="display:flex;align-items:center;gap:6px;padding:4px 12px;">' +
        '<span class="__gb_lbl" style="color:#555;flex:none;" data-i18n="iplay">' + T('iplay') + '</span>' +
        '<button id="__gb_side_black" title="我执黑子" style="padding:3px 10px;border:1px solid #666;border-radius:5px;background:#fff;color:#333;cursor:pointer;font-size:12px;font-weight:600;line-height:1.3;">黑子</button>' +
        '<button id="__gb_side_white" title="我执白子" style="padding:3px 10px;border:1px solid #666;border-radius:5px;background:#fff;color:#333;cursor:pointer;font-size:12px;font-weight:600;line-height:1.3;">白子</button>' +
        '<span id="__gb_side_txt" style="font-size:10px;color:#888;white-space:nowrap;letter-spacing:.2px;"></span>' +
        '<button id="__gb_auto" data-i18n="auto" style="margin-left:auto;padding:2px 7px;border:1px solid #3b7dd8;border-radius:5px;background:#fff;color:#3b7dd8;cursor:pointer;font-size:11px;flex:none;">' + T('auto') + '</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;padding:0 12px 4px;position:relative;">' +
        '<button id="__gb_adjust" style="padding:2px 8px;border:1px solid #e67e22;border-radius:5px;background:#fff;color:#e67e22;cursor:pointer;font-size:11px;">' + T('manual') + '</button>' +
        '<button id="__gb_opacity" data-i18n="opacity" style="position:absolute;left:50%;transform:translateX(-50%);padding:2px 8px;border:1px solid #7a90b8;border-radius:5px;background:#fff;color:#4a6a9a;cursor:pointer;font-size:11px;">' + T('opacity') + '</button>' +
        '<button id="__gb_dark" style="margin-left:auto;padding:2px 8px;border:1px solid #555;border-radius:5px;background:#fff;color:#555;cursor:pointer;font-size:11px;">' + T('dark') + '</button>' +
      '</div>' +
      '<div id="__gb_opacity_pop" style="display:none;flex-direction:column;gap:5px;padding:5px 12px 6px;font-size:11px;color:#666;border-bottom:1px solid #f0f0f0;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span data-i18n="opacity" style="flex:none;width:34px;">' + T('opacity') + '</span>' +
          '<input id="__gb_opacity_range" type="range" min="25" max="100" step="1" style="flex:1;min-width:0;">' +
          '<input id="__gb_opacity_num" type="number" min="25" max="100" step="1" style="width:40px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:1px 0;font-size:11px;">' +
          '<span style="color:#888;">%</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span data-i18n="blur" style="flex:none;width:34px;">' + T('blur') + '</span>' +
          '<input id="__gb_blur_range" type="range" min="5" max="100" step="1" style="flex:1;min-width:0;">' +
          '<input id="__gb_blur_num" type="number" min="5" max="100" step="1" style="width:40px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:1px 0;font-size:11px;">' +
          '<span style="color:#888;">%</span>' +
        '</div>' +
      '</div>' +
      '<style>' +
        '#__gb_opacity_range,#__gb_blur_range{-webkit-appearance:none;appearance:none;height:3px;border-radius:2px;background:#cbd2dc;outline:none;cursor:pointer;}' +
        '#__gb_opacity_range::-webkit-slider-thumb,#__gb_blur_range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#3b7dd8;border:none;cursor:pointer;}' +
        '#__gb_opacity_range::-moz-range-thumb,#__gb_blur_range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#3b7dd8;border:none;cursor:pointer;}' +
        '#__gb_panel input[type=number]::-webkit-inner-spin-button,#__gb_panel input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}' +
        '#__gb_panel input[type=number]{-moz-appearance:textfield;}' +
      '</style>' +
      '<div style="display:flex;align-items:center;gap:6px;padding:0 12px 6px;">' +
        '<button id="__gb_heat" data-i18n="heat" style="padding:2px 8px;border:1px solid #3b7dd8;border-radius:5px;background:#fff;color:#3b7dd8;cursor:pointer;font-size:11px;">' + T('heat') + '</button>' +
        '<button id="__gb_opp" style="margin-left:auto;padding:2px 10px;border:1px solid #A5B4FC;border-radius:5px;background:#fff;color:#A5B4FC;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:4px;">' +
          '<i id="__gb_opp_icon" style="width:9px;height:9px;border-radius:50%;border:1.5px dashed #A5B4FC;display:inline-block;"></i>' +
          '<span data-i18n="oppMoves">' + T('oppMoves') + '</span>' +
        '</button>' +
      '</div>' +
      '<div id="__gb_legend" style="display:none;align-items:center;gap:8px;padding:2px 12px 6px;font-size:10px;color:#888;border-bottom:1px solid #f0f0f0;user-select:none;">' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#00bfa5;display:inline-block;"></i><span data-i18n="heatBest">' + T('heatBest') + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#43a047;display:inline-block;"></i><span data-i18n="heatGood">' + T('heatGood') + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#ff7f9f;display:inline-block;"></i><span data-i18n="heatMid">' + T('heatMid') + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#ffb3c1;display:inline-block;"></i><span data-i18n="heatLow">' + T('heatLow') + '</span></span>' +
      '</div>' +
      '<div id="__gb_status" style="font-size:11px;color:#666;line-height:1.45;border-top:1px solid #f0f0f0;padding:4px 12px 2px;min-height:48px;" data-i18n="connecting">' + T('connecting') + '</div>' +
      '<div id="__gb_stats" style="padding:6px 12px 2px;">' +
        '<table style="width:100%;border-collapse:collapse;text-align:center;font-size:11px;">' +
          '<tr style="color:#9aa3ad;font-size:10px;padding-bottom:2px;"><td data-i18n="colDepth">深度</td><td data-i18n="colEval">评估</td><td data-i18n="colSpeed">速度</td><td data-i18n="colNodes">节点</td></tr>' +
          '<tr style="font-weight:600;color:#1d1d1f;font-size:12px;padding-top:2px;"><td id="__gb_st_depth">-</td><td id="__gb_st_eval">-</td><td id="__gb_st_speed">-</td><td id="__gb_st_nodes">-</td></tr>' +
        '</table>' +
        '<div id="__gb_st_line" style="color:#666;margin-top:5px;margin-bottom:3px;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>' +
      '</div>' +
      '<div id="__gb_chart_wrap" style="display:flex;align-items:stretch;background:#fafbfc;border-top:1px solid #f0f0f0;">' +
        '<div id="__gb_yaxis" style="flex:none;width:26px;height:100px;position:relative;box-sizing:border-box;"></div>' +
        '<div id="__gb_chart_scroll" style="flex:1 1 auto;overflow-x:auto;overflow-y:hidden;min-width:0;">' +
          '<canvas id="__gb_chart" height="100" style="display:block;"></canvas>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;padding:8px 12px 12px;">' +
        '<button id="__gb_rec" style="flex:1;padding:5px 0;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;" data-i18n="reidentify">' + T('reidentify') + '</button>' +
        '<button id="__gb_analyze" style="flex:1;padding:5px 0;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;" data-i18n="analyze">' + T('analyze') + '</button>' +
        '<button id="__gb_deep" title="30s 深度计算（对标 gomocalc 手动深算）" style="flex:1;padding:5px 0;border:1px solid #8e44ad;border-radius:6px;background:#f5eefb;color:#8e44ad;cursor:pointer;font-size:11px;font-weight:600;">' + T('deep') + '</button>' +
      '</div>' +
      
      '<style>' +
        '#__gb_footbar{display:flex;gap:6px;padding:0 12px 10px;}' +
        '#__gb_footbar>button{flex:1;padding:5px 0;border-radius:6px;cursor:pointer;box-sizing:border-box;font-size:11px;}' +
        '#__gb_pos{background:#2e7d32!important;color:#fff!important;border:1px solid #2e7d32!important;font-weight:600;}' +
        '#__gb_pos[data-on="1"]{background:#1b5e20!important;border-color:#123f16!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)!important}' +
        '#__gb_pos:hover{filter:brightness(1.08)}' +
        '[data-dark="1"] #__gb_pos{background:#1e3a26!important;color:#9bd6a2!important;border-color:#3f7a4a!important}' +
        '[data-dark="1"] #__gb_pos[data-on="1"]{background:#2c6b3a!important;color:#eafbe9!important;border-color:#5aa869!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)!important}' +
        '[data-dark="1"] #__gb_pos:hover{filter:brightness(1.12)}' +
        '#__gb_possave{background:#fff!important;color:#2e7d32!important;border:1px solid #7cb98a!important}' +
        '#__gb_possave:hover{background:#f2f9f3!important;filter:none}' +
        '[data-dark="1"] #__gb_possave{background:#232a3a!important;color:#9bd6a2!important;border-color:#3f7a4a!important}' +
        '[data-dark="1"] #__gb_possave:hover{background:#2b3346!important}' +
      '</style>' +
      '<div id="__gb_footbar">' +
        '<button id="__gb_pos" data-i18n="posBtn" title="打开局面窗口（识别出来的棋盘 + 局面代码）" style="flex:1;cursor:pointer;">' + T('posBtn') + '</button>' +
        '<button id="__gb_possave" data-i18n="posSave" title="保存局面（把识别到的棋盘渲染成 PNG 图片）" style="flex:1;cursor:pointer;">' + T('posSave') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);
  window.__gbPanel = { toggle: function () { var b = document.getElementById('__gb_body'); b.style.display = (b.style.display === 'none') ? '' : 'none'; } };

  var POS_N = 15;
  function buildPositionCode(board) {
    var coord = function (x, y) { return String.fromCharCode(65 + x) + (POS_N - y); };
    var nb = 0, nw = 0, sb = [], sw = [], sa = '';
    for (var y = 0; y < POS_N; y++) {
      for (var x = 0; x < POS_N; x++) {
        var v = board && board[y] ? board[y][x] : 0;
        if (!v) continue;
        var c = coord(x, y);
        sa += c;                                    
        if (v === 1) { nb++; sb.push(c); } else { nw++; sw.push(c); }
      }
    }
    return 'Gomoku15  B:' + nb + '  W:' + nw + '\nA: ' + sa + '\nB: ' + sb.join(',') + '\nW: ' + sw.join(',');
  }
  function posBoardToUse() {
    
    if (lastGoodBoard) return lastGoodBoard;
    if (pyBoardCache && pyBoardCache.board) return pyBoardCache.board;
    return null;
  }
  function drawPosBoard(cv, board) {
    
    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    var cssW = cv.clientWidth;
    
    var px = (cssW && cssW > 10) ? Math.max(240, Math.round(cssW * dpr))
           : (cv.width >= 240 ? cv.width : 240);
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    var ctx = cv.getContext('2d');
    var scale = px / 240;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    var size = 240, pad = 14;
    var step = (size - pad * 2) / (POS_N - 1);
    
    ctx.fillStyle = '#dcb35c';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#6b4f2a';
    ctx.lineWidth = 1;
    for (var i = 0; i < POS_N; i++) {
      ctx.beginPath(); ctx.moveTo(pad, pad + i * step); ctx.lineTo(size - pad, pad + i * step); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad + i * step, pad); ctx.lineTo(pad + i * step, size - pad); ctx.stroke();
    }
    
    [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]].forEach(function (p) {
      ctx.beginPath(); ctx.arc(pad + p[0] * step, pad + p[1] * step, 2.5, 0, 6.284); ctx.fillStyle = '#6b4f2a'; ctx.fill();
    });
    if (board) {
      for (var y = 0; y < POS_N; y++) for (var x = 0; x < POS_N; x++) {
        var v = board[y][x];
        if (!v) continue;
        ctx.beginPath();
        ctx.arc(pad + x * step, pad + y * step, step * 0.44, 0, 6.284);
        ctx.fillStyle = v === 1 ? '#101010' : '#f7f7f7';
        ctx.fill();
        ctx.strokeStyle = v === 1 ? '#000' : '#999';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
  function ensurePosWin() {
    var w = document.getElementById('__gb_poswin');
    if (w) return w;
    w = document.createElement('div');
    w.id = '__gb_poswin';
    
    w.style.cssText = 'position:fixed;z-index:2147483647;width:262px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
      'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.22);font-size:12px;overflow:hidden;display:none;';
    w.innerHTML =
      '<div id="__gb_poswin_hd" style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:#2e7d32;color:#fff;cursor:move;user-select:none;">' +
        '<span style="flex:1;font-weight:600;" data-i18n="posWinTtl">' + T('posWinTtl') + '</span>' +
        '<span id="__gb_poswin_cnt" style="font-size:10.5px;opacity:.85;"></span>' +
        '<button id="__gb_poswin_x" style="background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 4px;">×</button>' +
      '</div>' +
      '<div style="padding:8px 10px 4px;"><canvas id="__gb_poswin_cv" width="240" height="240" style="width:100%;display:block;border-radius:6px;"></canvas></div>' +
      '<div style="padding:4px 10px 2px;display:flex;align-items:center;gap:6px;">' +
        '<span data-i18n="fenlabel" style="flex:none;font-size:11px;color:#888;">' + T('fenlabel') + '</span>' +
        '<button id="__gb_poswin_copy" data-i18n="posCopy" style="margin-left:auto;padding:2px 8px;border:1px solid #2e7d32;border-radius:5px;background:#fff;color:#2e7d32;cursor:pointer;font-size:11px;">' + T('posCopy') + '</button>' +
      '</div>' +
      '<pre id="__gb_poswin_code" style="margin:4px 10px 10px;padding:6px 8px;font-size:10.5px;line-height:1.5;border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:96px;overflow-y:auto;font-family:Consolas,monospace;"></pre>';
    document.body.appendChild(w);
    
    (function () {
      var hd = document.getElementById('__gb_poswin_hd');
      var dragging = false, ox = 0, oy = 0;
      function clamp(x, y) {
        var ww = w.offsetWidth, hh = w.offsetHeight;
        return [Math.max(0, Math.min(x, window.innerWidth - ww)), Math.max(0, Math.min(y, window.innerHeight - hh))];
      }
      hd.addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        var r = w.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        if (hd.setPointerCapture) { try { hd.setPointerCapture(e.pointerId); } catch (err) {} }
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var p = clamp(e.clientX - ox, e.clientY - oy);
        w.style.left = p[0] + 'px'; w.style.top = p[1] + 'px'; w.style.right = 'auto';
      });
      window.addEventListener('mouseup', function () { dragging = false; });
    })();
    document.getElementById('__gb_poswin_x').addEventListener('click', function () { w.style.display = 'none'; });
    document.getElementById('__gb_poswin_copy').addEventListener('click', function () {
      var code = document.getElementById('__gb_poswin_code').textContent;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code);
        else {
          var ta = document.createElement('textarea');
          ta.value = code; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        }
        setStatus(T('copied'));
      } catch (e) {}
    });
    return w;
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
  
  function refreshPosWinIfOpen() { if (document.getElementById('__gb_poswin')) refreshPosWin(); }
  function refreshPosWin() {
    var w = document.getElementById('__gb_poswin');
    if (!w || w.style.display === 'none') return;
    var b = posBoardToUse();
    var cv = document.getElementById('__gb_poswin_cv');
    drawPosBoard(cv, b);
    var codeEl = document.getElementById('__gb_poswin_code');
    var cntEl = document.getElementById('__gb_poswin_cnt');
    if (!b) {
      codeEl.textContent = T('posEmpty');
      cntEl.textContent = '';
    } else {
      var nb = 0, nw = 0;
      for (var y = 0; y < POS_N; y++) for (var x = 0; x < POS_N; x++) {
        if (b[y][x] === 1) nb++; else if (b[y][x] === 2) nw++;
      }
      codeEl.textContent = buildPositionCode(b);
      cntEl.textContent = 'B:' + nb + ' W:' + nw;
    }
    paintPosWin();
  }
  
  function savePosImage() {
    var b = posBoardToUse();
    if (!b) { setStatus(T('posEmpty')); return; }
    try {
      var cv = document.createElement('canvas');
      
      cv.width = 800; cv.height = 800;
      drawPosBoard(cv, b);
      var done = function () { setStatus('<span style="color:#2e7d32;">' + T('posSaveOk') + '</span>'); };
      if (cv.toBlob) {
        cv.toBlob(function (blob) {
          if (!blob) { setStatus(T('posSaveFail') + 'toBlob'); return; }
          var url = URL.createObjectURL(blob);
          var aEl = document.createElement('a');
          aEl.href = url;
          aEl.download = 'gomoku-position-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png';
          document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          done();
        }, 'image/png');
      } else {
        var aEl2 = document.createElement('a');
        aEl2.href = cv.toDataURL('image/png');
        aEl2.download = 'gomoku-position.png';
        document.body.appendChild(aEl2); aEl2.click(); document.body.removeChild(aEl2);
        done();
      }
    } catch (e) { setStatus(T('posSaveFail') + (e.message || e)); }
  }
  (function () {
    var posBtn = document.getElementById('__gb_pos');
    var saveBtn = document.getElementById('__gb_possave');
    if (posBtn) posBtn.addEventListener('click', function () {
      var w = ensurePosWin();
      var show = w.style.display === 'none' || !w.style.display;
      w.style.display = show ? 'block' : 'none';
      if (show) {
        if (!w.style.left && !w.style.top) {
          var pr = root.getBoundingClientRect();
          w.style.left = Math.max(0, pr.left - 274) + 'px';
          w.style.top = Math.max(0, pr.top) + 'px';
        }
        refreshPosWin();
      }
    });
    if (saveBtn) saveBtn.addEventListener('click', savePosImage);
  })();
  
  (function () {
    var dragging = false, ox = 0, oy = 0;
    
    var hdr = document.getElementById('__gb_hdr');
    function clamp(x, y) {
      var w = root.offsetWidth, h = root.offsetHeight;
      var maxX = Math.max(0, window.innerWidth - w), maxY = Math.max(0, window.innerHeight - h);
      return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }
    hdr.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      var r = root.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      root.style.right = 'auto'; root.style.left = r.left + 'px'; root.style.top = r.top + 'px';
      if (hdr.setPointerCapture) { try { hdr.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var p = clamp(e.clientX - ox, e.clientY - oy);
      root.style.left = p[0] + 'px';
      root.style.top = p[1] + 'px';
    });
    function stop() { dragging = false; }
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  })();
  document.getElementById('__gb_min').onclick = function () { window.__gbPanel.toggle(); };
  document.getElementById('__gb_close').onclick = function () { overlay.innerHTML = ''; root.remove(); window.__gbPanel = null; };

  var autoBtn = document.getElementById('__gb_auto');
  var darkBtn = document.getElementById('__gb_dark');
  var langBtn = document.getElementById('__gb_lang');

  function paintToggle(btn, on) {
    if (!btn) return;
    if (on) { btn.style.background = '#3b7dd8'; btn.style.color = '#fff'; btn.style.borderColor = '#3b7dd8'; }
    else if (S.dark) { btn.style.background = '#262b3a'; btn.style.color = '#c8ccd6'; btn.style.borderColor = '#4a5060'; }
    else { btn.style.background = '#fff'; btn.style.color = '#3b7dd8'; btn.style.borderColor = '#3b7dd8'; }
  }
  function paintAuto() { paintToggle(autoBtn, !!S.autoPlay); }
  function paintHeat() { paintToggle(document.getElementById('__gb_heat'), !!S.heatmap); }

  function applyDark() {
    root.setAttribute('data-dark', S.dark ? '1' : '0');
    darkBtn.textContent = S.dark ? T('light') : T('dark');
    var d = S.dark;
    root.style.borderColor = d ? '#000' : '#e2e5ea';
    
    var body = document.getElementById('__gb_body');
    if (body) body.style.color = d ? '#e6e8ee' : '#1d1d1f';
    
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_opt'), function (el) {
      el.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0';
      el.style.color = d ? '#c8ccd6' : '#333';
    });
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_lbl,.__gb_lbl2'), function (el) {
      el.style.color = d ? '#c8ccd6' : (el.classList.contains('__gb_lbl2') ? '#9aa3ad' : '#555');
    });
    var stEl = document.getElementById('__gb_status');
    if (stEl) stEl.style.color = d ? '#c8ccd6' : '#666';
    var lgEl = document.getElementById('__gb_legend');
    if (lgEl) { lgEl.style.color = '#888'; lgEl.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0'; }
    var st = document.getElementById('__gb_status');
    if (st) st.style.borderTopColor = d ? '#333846' : '#f0f0f0';
    
    Array.prototype.forEach.call(root.querySelectorAll('input,select'), function (el) {
      if (el.type === 'range') return;   
      el.style.background = d ? '#171a24' : '#fff';
      el.style.color = d ? '#e6e8ee' : '#333';
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
    if (rec) { rec.style.background = d ? '#262b3a' : '#fff'; rec.style.color = d ? '#e6e8ee' : '#1d1d1f'; rec.style.borderColor = d ? '#3a4050' : '#ddd'; }
    var an = document.getElementById('__gb_analyze');
    if (an) { an.style.background = d ? '#262b3a' : '#fff'; an.style.color = d ? '#e6e8ee' : '#1d1d1f'; an.style.borderColor = d ? '#3a4050' : '#ddd'; }
    var dp = document.getElementById('__gb_deep');
    if (dp) { dp.style.background = d ? '#1e2233' : '#f5eefb'; dp.style.color = d ? '#A5B4FC' : '#8e44ad'; dp.style.borderColor = d ? '#A5B4FC' : '#8e44ad'; }
    var ad = document.getElementById('__gb_adjust');
    if (ad) { ad.style.background = d ? 'transparent' : '#fff'; ad.style.color = '#e67e22'; ad.style.borderColor = '#e67e22'; }
    var opB = document.getElementById('__gb_opacity');
    if (opB) { opB.style.background = d ? '#262b3a' : '#fff'; opB.style.color = d ? '#c8ccd6' : '#4a6a9a'; opB.style.borderColor = d ? '#4a5060' : '#7a90b8'; }
    var opPopEl = document.getElementById('__gb_opacity_pop');
    if (opPopEl) { opPopEl.style.color = d ? '#c8ccd6' : '#666'; opPopEl.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0'; }
    var db = document.getElementById('__gb_dark');
    if (db) { db.style.background = d ? '#262b3a' : '#fff'; db.style.color = d ? '#c8ccd6' : '#555'; db.style.borderColor = d ? '#4a5060' : '#555'; }
    var cvw = document.getElementById('__gb_chart_wrap');
    if (cvw) { cvw.style.borderTop = d ? '1px solid #333846' : '1px solid #f0f0f0'; }
    
    Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td'), function (el) { el.style.color = d ? '#c8ccd6' : '#9aa3ad'; });
    Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td[id]'), function (el) { el.style.color = d ? '#e6e8ee' : '#1d1d1f'; });
    var stLine = document.getElementById('__gb_st_line');
    if (stLine) stLine.style.color = d ? '#9aa0ac' : '#666';
    var stFen = document.getElementById('__gb_st_fen');
    if (stFen) stFen.style.color = d ? '#7d8390' : '#9aa3ad';
    
    var hv = document.getElementById('__gb_hashval');
    if (hv) hv.style.color = d ? '#c8ccd6' : '#333';
    
    Array.prototype.forEach.call(root.querySelectorAll('label'), function (el) {
      el.style.color = d ? '#c8ccd6' : '#333';
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
  Array.prototype.forEach.call(root.querySelectorAll('[data-rule]'), function (el) {
    el.onclick = function () { S.rule = +el.dataset.rule; save(); paintSel(); kickAnalyze(); };
  });
  Array.prototype.forEach.call(root.querySelectorAll('.__gb_step'), function (b) {
    b.onclick = function () {
      var d = b.dataset.dir;
      
      if (d === 'turn+') S.customTurnSec = Math.min(6000, Math.round((S.customTurnSec + 0.25) * 100) / 100);
      else if (d === 'turn-') S.customTurnSec = Math.max(0.5, Math.round((S.customTurnSec - 0.25) * 100) / 100);
      else if (d === 'match+') S.customSec = Math.min(30000, S.customSec + 10);
      else if (d === 'match-') S.customSec = Math.max(10, S.customSec - 10);
      else if (d === 'hash+') { S.hashMB = Math.min(4096, S.hashMB + 128); applyHash(); }
      else if (d === 'hash-') { S.hashMB = Math.max(0, S.hashMB - 128); applyHash(); }
      applyPreset(); kickAnalyze();
    };
  });
  
  var turnInp = document.getElementById('__gb_turnval');
  var matchInp = document.getElementById('__gb_matchval');
  function sanitizeTurn(v) {
    v = v.replace(/[^\d.]/g, '');               
    var parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join(''); 
    if (v.indexOf('.') >= 0) {
      var h = v.split('.');
      v = h[0] + '.' + h[1].slice(0, 2);        
    }
    return v;
  }
  function sanitizeMatch(v) {
    return v.replace(/[^\d]/g, '');              
  }
  turnInp.addEventListener('input', function () { this.value = sanitizeTurn(this.value); });
  matchInp.addEventListener('input', function () { this.value = sanitizeMatch(this.value); });
  function readInputs() {
    var t = parseFloat(turnInp.value);
    if (isFinite(t)) S.customTurnSec = Math.min(6000, Math.max(0.5, Math.round(t * 100) / 100));
    var m = parseFloat(matchInp.value);
    if (isFinite(m)) S.customSec = Math.min(30000, Math.max(10, Math.round(m)));
    turnInp.value = S.customTurnSec;
    matchInp.value = S.customSec;
    applyPreset();
  }
  turnInp.addEventListener('change', readInputs);
  matchInp.addEventListener('change', readInputs);

  var sideBlack = document.getElementById('__gb_side_black');
  var sideWhite = document.getElementById('__gb_side_white');
  var sideTxtEl = document.getElementById('__gb_side_txt');
  
  function paintSideBtns() {
    if (!sideBlack || !sideWhite) return;
    var eff = mySideMask(), man = sideIsManual(), dk = S.dark, en = (S.lang === 'en');
    var baseBg = dk ? '#262b3a' : '#fff', baseFg = dk ? '#c8ccd6' : '#555', baseBd = dk ? '#5a6072' : '#999';
    function paint(el, isBlack, on) {
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
      el.style.opacity = (!on && eff >= 0) ? '0.45' : '1';
      el.style.padding = on ? '1px 5px' : '2px 6px';
    }
    paint(sideBlack, true, eff === 0);
    paint(sideWhite, false, eff === 1);
    var unlockTip = en ? ' (locked — click again to unlock)' : '（已锁定，再点一次解除）';
    sideBlack.title = (en ? 'I play Black' : '我执黑') + ((eff === 0 && man) ? unlockTip : '');
    sideWhite.title = (en ? 'I play White' : '我执白') + ((eff === 1 && man) ? unlockTip : '');
    if (sideTxtEl) {
      if (eff < 0) { sideTxtEl.textContent = SF('side_pending'); sideTxtEl.style.color = '#e67e22'; }
      else {
        sideTxtEl.textContent = (man ? SF('side_manual') : SF('side_auto')) + '·' + (eff === 0 ? T('black') : T('white'));
        sideTxtEl.style.color = man ? '#2e7d32' : '#3b7dd8';
      }
    }
  }
  
  function pickSideManual(mask) {
    var already = (S.side === mask);
    S.side = already ? -1 : mask;        
    S.userSide = -1;                     
    probeOpen = null; pendingClick = null;   
    sideConflictCount = 0; sideLockUntil = 0;
    sideVote = { color: -1, n: 0 };              
    
    lastEngineFp = null; lastEngineAt = 0;
    S.candCache = [];
    overlayStale = true;
    lastOppRings = null; lastOppGeom = null;
    stabilizeBestReset();            
    
    if (!already) { haltForNewGame = false; haltReason = ''; clearGameOverLock(); }
    try { clearOverlay(); clearOppSvgLayer(); } catch (e) {}
    try { save(); } catch (e) {}
    paintSideBtns();
    setStatus('<span style="color:#3b7dd8;">' +
      (S.lang === 'en'
        ? (S.side < 0 ? 'Auto side mode — will not evaluate until you pick B/W.'
                      : 'Locked to ' + (S.side === 0 ? '<b>Black</b>' : '<b>White</b>') + ' — re-analyzing for this side only…')
        : (S.side < 0 ? '已取消我执颜色——未选定前不评估。'
                      : '已锁定我执<b>' + (S.side === 0 ? '黑' : '白') + '</b>——只按这一方重新评估…')) + '</span>');
    kickAnalyze();
  }
  sideBlack.onclick = function () { pickSideManual(0); };
  sideWhite.onclick = function () { pickSideManual(1); };
  paintSideBtns();
  if (autoBtn) autoBtn.onclick = function () {
    S.autoPlay = !S.autoPlay; save(); paintAuto();
    if (S.autoPlay) { S.lastFp = ''; analyze(); }   
  };
  var heatBtn = document.getElementById('__gb_heat');
  paintHeat();
  function applyHeat() {
    var lg = document.getElementById('__gb_legend');
    if (lg) lg.style.display = S.heatmap ? 'flex' : 'none';
  }
  if (heatBtn) heatBtn.onclick = function () {
    S.heatmap = !S.heatmap; save(); applyHeat(); paintHeat();
    S.candCache = [];                                 
    kickAnalyze();
  };
  applyHeat();
  var oppBtn = document.getElementById('__gb_opp');
  var oppIcon = document.getElementById('__gb_opp_icon');
  function paintOpp() {
    if (!oppBtn) return;
    if (S.oppMoves) {
      oppBtn.style.background = '#7a5af8'; oppBtn.style.color = '#fff'; oppBtn.style.borderColor = '#7a5af8';
      if (oppIcon) oppIcon.style.borderColor = '#fff';
    } else {
      oppBtn.style.background = S.dark ? '#262b3a' : '#fff';
      oppBtn.style.color = S.dark ? '#c8ccd6' : '#A5B4FC';
      oppBtn.style.borderColor = '#A5B4FC';
      if (oppIcon) oppIcon.style.borderColor = S.dark ? '#c8ccd6' : '#A5B4FC';
    }
  }
  oppBtn.onclick = function () {
    S.oppMoves = !S.oppMoves; save(); paintOpp();
    if (S.oppMoves) startOppEval(); else stopOppEval();   
    S.candCache = [];                                 
    kickAnalyze();
  };
  paintOpp();
  if (S.oppMoves) startOppEval();   
  darkBtn.onclick = function () { S.dark = !S.dark; save(); applyDark(); };
  langBtn.onclick = function () { S.lang = (S.lang === 'en') ? 'zh' : 'en'; save(); applyLang(); };

  var opBtn = document.getElementById('__gb_opacity');
  var opPop = document.getElementById('__gb_opacity_pop');
  var opRange = document.getElementById('__gb_opacity_range');
  var opNum = document.getElementById('__gb_opacity_num');
  var blurRange = document.getElementById('__gb_blur_range');
  var blurNum = document.getElementById('__gb_blur_num');
  var _prevOp = (S.opacity >= 25 && S.opacity <= 100) ? S.opacity : 100;
  
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
  
  function paintPanelBg() {
    var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
    var d = !!S.dark;
    var bp = (Math.max(5, Math.min(100, S.blur == null ? 50 : S.blur))) / 100;
    var blur = 'blur(' + (bp * 18).toFixed(1) + 'px) saturate(1.35)';
    root.style.background = d ? 'rgba(31,35,48,' + a + ')' : 'rgba(255,255,255,' + a + ')';
    root.style.backdropFilter = blur;
    root.style.webkitBackdropFilter = blur;
    root.style.borderColor = d ? 'rgba(255,255,255,' + (0.10 + 0.12 * a).toFixed(3) + ')' : 'rgba(18,38,86,' + (0.08 + 0.14 * a).toFixed(3) + ')';
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_row'), function (el) {
      el.style.background = d ? 'rgba(38,43,58,' + (a * 0.62).toFixed(3) + ')' : 'rgba(250,251,252,' + (a * 0.62).toFixed(3) + ')';
    });
    var cvw = document.getElementById('__gb_chart_wrap');
    if (cvw) cvw.style.background = d ? 'rgba(25,28,38,' + (0.50 * a).toFixed(3) + ')' : 'rgba(250,251,252,' + (0.50 * a).toFixed(3) + ')';
     paintPosWin();
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
    if (!(v >= 5 && v <= 100)) v = 50;
    S.blur = v;
    paintPanelBg();
    if (blurRange) blurRange.value = v;
    if (blurNum) blurNum.value = v;
    save();
  }
  if (opBtn) opBtn.onclick = function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (opPop) opPop.style.display = (opPop.style.display === 'flex') ? 'none' : 'flex';
  };
  if (opRange) opRange.oninput = function () { S.opacity = +opRange.value; if (opNum) opNum.value = S.opacity; applyOpacity(); };
  if (opNum) opNum.onchange = function () {
    var v = parseInt(opNum.value, 10);
    if (!(v >= 25 && v <= 100)) { v = (S.opacity >= 25 && S.opacity <= 100) ? S.opacity : 100; opNum.value = v; }
    S.opacity = v; applyOpacity();
  };
  if (blurRange) blurRange.oninput = function () { S.blur = +blurRange.value; if (blurNum) blurNum.value = S.blur; applyBlur(); };
  if (blurNum) blurNum.onchange = function () {
    var v = parseInt(blurNum.value, 10);
    if (!(v >= 5 && v <= 100)) { v = (S.blur >= 5 && S.blur <= 100) ? S.blur : 50; blurNum.value = v; }
    S.blur = v; applyBlur();
  };
  
  document.addEventListener('click', function (ev) {
    if (!opPop || opPop.style.display !== 'flex') return;
    if (!(ev.target && ev.target.closest && ev.target.closest('#__gb_opacity,#__gb_opacity_pop'))) opPop.style.display = 'none';
  });
  applyOpacity();
  applyBlur();
  paintSel();
  applyDark();
  applyLang();
  fillStatFromCache();

  var overlay = document.createElement('div');
  overlay.id = '__gb_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;';
  document.body.appendChild(overlay);

  var calib = document.createElement('div');
  calib.id = '__gb_calib';
  calib.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;';
  document.body.appendChild(calib);
  var svgNS2 = 'http://www.w3.org/2000/svg';
  function calibPt(cal, r, isScr, scaleX, scaleY, i, j) {
    return {
      x: (cal.x0 + i * cal.stepX - (isScr ? cal.x0 : 0)) * scaleX,
      y: (cal.y0 + j * cal.stepY - (isScr ? cal.y0 : 0)) * scaleY
    };
  }
  function calibLine(svg, x1, y1, x2, y2, color, width) {
    var l = document.createElementNS(svgNS2, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', color); l.setAttribute('stroke-width', width);
    l.setAttribute('stroke-linecap', 'round');
    svg.appendChild(l);
  }
  function drawCalibFrame(cal, cv) {
    calib.innerHTML = '';
    if (!cal) return;
    var r = cal.topRect || cv.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    var isScr = !!cal.isScreen;
    var scaleX = isScr ? 1 : r.width / cv.width;
    var scaleY = isScr ? 1 : r.height / cv.height;
    var cellPx = cal.cell * scaleX;
    var svg = document.createElementNS(svgNS2, 'svg');
    svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
    svg.style.position = 'absolute';
    calib.style.left = r.left + 'px'; calib.style.top = r.top + 'px';
    calib.style.width = r.width + 'px'; calib.style.height = r.height + 'px';
    
    var L = Math.max(10, cellPx);
    [[0, 0, 1, 1], [14, 0, -1, 1], [0, 14, 1, -1], [14, 14, -1, -1]].forEach(function (cn) {
      var p = calibPt(cal, r, isScr, scaleX, scaleY, cn[0], cn[1]);
      calibLine(svg, p.x, p.y, p.x + cn[2] * L, p.y, '#00c8ff', 5);
      calibLine(svg, p.x, p.y, p.x, p.y + cn[3] * L, '#00c8ff', 5);
    });
    
    var sLen = Math.max(5, cellPx * 0.16);
    [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].forEach(function (s) {
      var p = calibPt(cal, r, isScr, scaleX, scaleY, s[0], s[1]);
      calibLine(svg, p.x - sLen, p.y, p.x + sLen, p.y, '#39ff14', 3);
      calibLine(svg, p.x, p.y - sLen, p.x, p.y + sLen, '#39ff14', 3);
    });
    calib.appendChild(svg);
  }
  function clearCalibFrame() { calib.innerHTML = ''; }

  var adjustMode = false;
  var adj = null;                 
  var adjust = document.createElement('div');
  adjust.id = '__gb_adjbox';
  adjust.style.cssText = 'position:fixed;z-index:2147483647;display:none;box-sizing:border-box;' +
    'border:2px solid #00c8ff;background:rgba(0,200,255,0.06);cursor:move;pointer-events:auto;';
  document.body.appendChild(adjust);
  var adjHandles = [];
  for (var ahi = 0; ahi < 4; ahi++) {
    var hd = document.createElement('div');
    hd.className = '__gb_adjh';
    hd.style.cssText = 'position:absolute;width:16px;height:16px;background:#00c8ff;border:2px solid #fff;' +
      'border-radius:50%;box-sizing:border-box;cursor:nwse-resize;pointer-events:auto;';
    hd.dataset.corner = ahi;
    adjust.appendChild(hd);
    adjHandles.push(hd);
  }
  
  var adjBar = document.createElement('div');
  adjBar.style.cssText = 'position:absolute;top:-30px;right:0;display:flex;gap:4px;';
  adjBar.innerHTML = '<button id="__gb_adjok" style="padding:3px 10px;border:none;border-radius:5px;background:#43a047;color:#fff;font-size:12px;cursor:pointer;">应用 ✓</button>' +
    '<button id="__gb_adjno" style="padding:3px 10px;border:none;border-radius:5px;background:#999;color:#fff;font-size:12px;cursor:pointer;">取消</button>';
  adjust.appendChild(adjBar);
  function layoutAdjustHandles() {
    var hs = adjust.querySelectorAll('.__gb_adjh');
    var set = [['left:-8px;top:-8px;cursor:nwse-resize;', 0], ['right:-8px;top:-8px;cursor:nesw-resize;', 1],
               ['left:-8px;bottom:-8px;cursor:nesw-resize;', 2], ['right:-8px;bottom:-8px;cursor:nwse-resize;', 3]];
    for (var i = 0; i < 4; i++) {
      hs[i].style.cssText = 'position:absolute;width:16px;height:16px;background:#00c8ff;border:2px solid #fff;' +
        'border-radius:50%;box-sizing:border-box;pointer-events:auto;' + set[i][0];
      hs[i].dataset.corner = set[i][1];
    }
  }
  function renderAdjust() {
    if (!adjustMode) return;
    adjust.style.display = 'block';
    adjust.style.left = adj.left + 'px';
    adjust.style.top = adj.top + 'px';
    adjust.style.width = Math.max(40, adj.width) + 'px';
    adjust.style.height = Math.max(40, adj.height) + 'px';
    layoutAdjustHandles();
  }
  
  var adjStart = null;
  function magnetize() {
    var ref = cachedBoard || (screenBoard ? { cv: screenBoard.cv, cal: screenBoard.cal } : null);
    if (!ref || !adj) return;
    var cv = ref.cv, cal = ref.cal;
    var topR = cal.topRect || cv.getBoundingClientRect();
    var isScr = !!cal.isScreen;
    var scX = isScr ? 1 : topR.width / cv.width;
    var scY = isScr ? 1 : topR.height / cv.height;
    var off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return; }
    var bg = cal.bg, diff = Math.max(12, Math.min(42, bg * 0.22));
    var cx0 = (adj.left - topR.left) / scX, cy0 = (adj.top - topR.top) / scY;
    var cw = adj.width / scX, ch = adj.height / scY;
    
    var cell = (cal.cell > 4 && cal.cell < 300) ? cal.cell : (cw / 14 + ch / 14) / 2;
    
    var pbX = (cal.x0 != null && cal.x0 > -9000) ? cal.x0 : (adjStart ? (adjStart.left - topR.left) / scX : cx0);
    var pbY = (cal.y0 != null && cal.y0 > -9000) ? cal.y0 : (adjStart ? (adjStart.top - topR.top) / scY : cy0);
    function lineLumAt(p, len0, len1, isVertical) {
      var dk = 0, t = 0;
      if (isVertical) {
        for (var y = Math.max(0, (len0 | 0)); y < Math.min(cv.height, len1); y += 2) {
          var o = (y * cv.width + p) * 4; if (img[o + 3] < 128) continue; t++;
          if (bg - lumOf(img, o) > diff) dk++;
        }
      } else {
        for (var x = Math.max(0, (len0 | 0)); x < Math.min(cv.width, len1); x += 2) {
          var o2 = (p * cv.width + x) * 4; if (img[o2 + 3] < 128) continue; t++;
          if (bg - lumOf(img, o2) > diff) dk++;
        }
      }
      return t ? dk / t : 0;
    }
    function snapPhase(center, base, step, len0, len1, isVertical) {
      
      var k = Math.round((center - base) / step);
      var best = null, bestSc = 0.18;
      for (var dk = -1; dk <= 1; dk++) {
        var phase = base + (k + dk) * step;
        var lim = isVertical ? cv.width : cv.height;
        if (phase < 1 || phase >= lim - 1) continue;
        for (var p = Math.max(0, Math.floor(phase - 2)); p <= Math.min(lim - 1, Math.ceil(phase + 2)); p++) {
          var sc = lineLumAt(p, len0, len1, isVertical);
          if (sc > bestSc) { bestSc = sc; best = p; }
        }
      }
      return best;
    }
    
    var mLeft = snapPhase(cx0, pbX, cell, cy0 - ch * 0.3, cy0 + ch * 1.3, true);
    var mTop = snapPhase(cy0, pbY, cell, cx0 - cw * 0.3, cx0 + cw * 1.3, false);
    if (mLeft != null) cx0 = mLeft;
    if (mTop != null) cy0 = mTop;
    
    var mRight = snapPhase(cx0 + cw, pbX, cell, cy0 - ch * 0.3, cy0 + ch * 1.3, true);
    var mBottom = snapPhase(cy0 + ch, pbY, cell, cx0 - cw * 0.3, cx0 + cw * 1.3, false);
    var w14 = 14 * cell, h14 = 14 * cell;
    if (mRight != null && Math.abs((mRight - cx0) - w14) < cell * 0.5) cw = mRight - cx0;
    else cw = w14;
    if (mBottom != null && Math.abs((mBottom - cy0) - h14) < cell * 0.5) ch = mBottom - cy0;
    else ch = h14;
    if (cw >= 40 && ch >= 40) {
      adj.left = topR.left + cx0 * scX;
      adj.top = topR.top + cy0 * scY;
      adj.width = cw * scX;
      adj.height = ch * scY;
      renderAdjust();
    }
  }
  function applyAdjust() {
    var ref = cachedBoard || (screenBoard ? { cv: screenBoard.cv, cal: screenBoard.cal } : null);
    if (!ref) {
      
      var cvs = pickCandidates();
      if (cvs.length) {
        var cv0 = cvs[0];
        ref = {
          cv: cv0,
          cal: {
            x0: 0, y0: 0, stepX: cv0.width / 14, stepY: cv0.height / 14, cell: cv0.width / 14,
            bg: 160, topRect: toTopRect(cv0), docRect: cv0.getBoundingClientRect(),
            frameWin: cv0.ownerDocument.defaultView || window, mode: 'tab'
          }
        };
      }
    }
    if (!ref) { setStatus(SF('no_image')); return; }
    var cv = ref.cv, oldCal = ref.cal;
    var topR = oldCal.topRect || cv.getBoundingClientRect();
    var isScr = !!oldCal.isScreen;
    var scX = isScr ? 1 : topR.width / cv.width;
    var scY = isScr ? 1 : topR.height / cv.height;
    var stp = (adj.width / scX / 14 + adj.height / scY / 14) / 2;   
    var nCal = {
      x0: (adj.left - topR.left) / scX,
      y0: (adj.top - topR.top) / scY,
      stepX: stp,
      stepY: stp,
      cell: stp,
      bg: oldCal.bg,
      isScreen: isScr, mode: oldCal.mode || 'tab',
      clientX0: adj.left, clientY0: adj.top,
      bw: adj.width, bh: adj.height,
      docRect: oldCal.docRect || topR,   
      topRect: topR, frameWin: oldCal.frameWin || window
    };
    var cvr = cv.getBoundingClientRect();
    cachedBoard = { cv: cv, cal: nCal, lastRect: { left: cvr.left, top: cvr.top, width: cvr.width, height: cvr.height } };
    screenBoard = null;
    adjustMode = false;
    adjust.style.display = 'none';
    drawCalibFrame(nCal, cv);
    
    if (isWulinSite() && adj && adj.left != null && stp > 1) {
      wulinGeoSave({ x0: adj.left, y0: adj.top, stepX: stp * scX, stepY: stp * scY, grid: 15, t: Date.now() });
    }
    setStatus(SF('applied'));
    S.lastFp = '';
    analyze();
  }
  function cancelAdjust() {
    adjustMode = false;
    adjust.style.display = 'none';
    setStatus(SF('cancelled'));
  }
  function startAdjust() {
    var ref = cachedBoard || (screenBoard ? { cv: screenBoard.cv, cal: screenBoard.cal } : null);
    var r;
    if (ref) {
      var rr = ref.cal.topRect || ref.cv.getBoundingClientRect();
      r = { left: rr.left, top: rr.top, width: rr.width, height: rr.height };
    } else {
      var side = Math.min(window.innerWidth, window.innerHeight) * 0.55;
      r = { left: (window.innerWidth - side) / 2, top: (window.innerHeight - side) / 2, width: side, height: side };
    }
    adj = r;
    adjStart = { left: r.left, top: r.top };
    adjustMode = true;
    renderAdjust();
    setStatus(S.lang === 'en' ? 'Drag the blue box to move, drag corners to resize; it snaps to the grid on release. Click Apply ✓ when done.' : '拖动蓝色框移动、拖四角圆点缩放识别区域；松手自动磁吸网格线。满意后点「应用 ✓」');
  }
  
  adjust.addEventListener('mousedown', function (e) {
    if (e.target.classList && e.target.classList.contains('__gb_adjh')) return;
    if (e.target.id === '__gb_adjok' || e.target.id === '__gb_adjno') return;
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY, orig = { left: adj.left, top: adj.top };
    function mv(ev) {
      adj.left = orig.left + (ev.clientX - sx);
      adj.top = orig.top + (ev.clientY - sy);
      renderAdjust();
    }
    function up() {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      magnetize();
    }
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
  
  adjHandles.forEach(function (hd) {
    hd.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var idx = +hd.dataset.corner;
      var sx = e.clientX, sy = e.clientY, orig = { left: adj.left, top: adj.top, width: adj.width, height: adj.height };
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        var n = { left: orig.left, top: orig.top, width: orig.width, height: orig.height };
        if (idx === 0) { n.left += dx; n.top += dy; n.width -= dx; n.height -= dy; }
        else if (idx === 1) { n.top += dy; n.width += dx; n.height -= dy; }
        else if (idx === 2) { n.left += dx; n.width -= dx; n.height += dy; }
        else { n.width += dx; n.height += dy; }
        if (n.width > 40 && n.height > 40) adj = n;
        renderAdjust();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        magnetize();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  });
  document.getElementById('__gb_adjok').onclick = applyAdjust;
  document.getElementById('__gb_adjno').onclick = cancelAdjust;

  function clearOverlay() { overlay.innerHTML = ''; overlay.style.cssText = overlay.style.cssText; oppSvg = null; lastOppRings = null; oppRingsFp = null; oppRingsCount = 0; }

  var HEAT_COLORS = ['#00bfa5', '#43a047', '#ff7f9f', '#ffb3c1'];   
  var HEAT_RADII = [0.34, 0.29, 0.25, 0.21];     
  var HEAT_OPAC = [0.95, 0.85, 0.78, 0.68];        
  var OPP_TIER_COLORS = ['#00bfa5', '#43a047'];   
  
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
  
  function stableCalForRender(cal, cv) {
    if (lastGoodCal && !lastGoodCal.isScreen && !cal.isScreen &&
        lastGoodCal.stepX > 0 && cal.stepX > 0 && lastGoodCal.stepY > 0 && cal.stepY > 0) {
      var sDiff = Math.max(Math.abs(cal.stepX - lastGoodCal.stepX) / lastGoodCal.stepX,
                           Math.abs(cal.stepY - lastGoodCal.stepY) / lastGoodCal.stepY);
      if (sDiff < 0.15) return lastGoodCal;   
    }
    return cal;
  }
  
  function candScoreOf(c, myIsSideToMove) {
    if (c && typeof c.eval === 'string' && c.eval.length) return evalToScore(c.eval, myIsSideToMove !== false).score;
    return 0;
  }

  function sideToMoveColor(board) {
    var bn = 0, wn = 0;
    for (var y2 = 0; y2 < board.length; y2++) {
      var r2 = board[y2];
      for (var x2 = 0; x2 < r2.length; x2++) { if (r2[x2] === 1) bn++; else if (r2[x2] === 2) wn++; }
    }
    return (bn > wn) ? 2 : 1;
  }
  
  function swappedBoard(b) {
    return b.map(function (r) { return r.map(function (v) { return v === 1 ? 2 : (v === 2 ? 1 : 0); }); });
  }

  var STABLE_CONFIRM = 2;      
  var STABLE_MARGIN = 120;     
  var bestStable = { key: null, x: -1, y: -1, score: null, candX: -1, candY: -1, candN: 0 };
  function stabilizeBest(best, cands, fpKey, scoreOf) {
    if (!best || best.length !== 2 || best[0] < 0 || best[1] < 0 || best[0] >= N || best[1] >= N) return best;
    var bx = best[0], by = best[1];
    if (bestStable.key !== fpKey) {                 
      bestStable = { key: fpKey, x: bx, y: by, score: scoreOf ? scoreOf(bx, by) : null, candX: bx, candY: by, candN: 1 };
      return best;
    }
    if (bx === bestStable.x && by === bestStable.y) {  
      bestStable.candN = 0; bestStable.candX = -1; bestStable.candY = -1;
      bestStable.score = scoreOf ? scoreOf(bx, by) : null;
      return [bestStable.x, bestStable.y];
    }
    
    var newSc = scoreOf ? scoreOf(bx, by) : null;
    var oldSc = bestStable.score;
    if (newSc != null && oldSc != null && (newSc - oldSc) >= STABLE_MARGIN) {
      bestStable = { key: fpKey, x: bx, y: by, score: newSc, candX: bx, candY: by, candN: 1 };
      return best;
    }
    
    if (bx === bestStable.candX && by === bestStable.candY) bestStable.candN++;
    else { bestStable.candX = bx; bestStable.candY = by; bestStable.candN = 1; }
    if (bestStable.candN >= STABLE_CONFIRM) {
      bestStable = { key: fpKey, x: bx, y: by, score: newSc, candX: -1, candY: -1, candN: 0 };
      return best;
    }
    return [bestStable.x, bestStable.y];            
  }
  function stabilizeBestReset() { bestStable = { key: null, x: -1, y: -1, score: null, candX: -1, candY: -1, candN: 0 }; }

  function drawOverlay(cal, cv, cands, best, board, myIsSideToMove) {
    
    overlayStale = false;
    
    cal = stableCalForRender(cal, cv);
    
    var g = overlayGeom(cal, cv);
    if (!g) {
      var oh0 = overlay.querySelector('#__gb_heat_svg');
      if (oh0) { try { overlay.removeChild(oh0); } catch (e) {} }
      return;
    }
    var r = g.r, cellPx = g.cellPx, svgNS = 'http://www.w3.org/2000/svg';
    
    var svg = overlay.querySelector('#__gb_heat_svg');
    if (svg) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
    } else {
      svg = document.createElementNS(svgNS, 'svg');
      svg.id = '__gb_heat_svg';
      svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
      svg.style.position = 'absolute';
      svg.style.zIndex = '10';   
    }
    overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    var pt = g.pt;
    
    if (board) {
      var _sbKey = fingerprint(board) + '#' + (myIsSideToMove === false ? 'o' : 'm') + '#' + myColorCode();
      var _sbScore = function (x2, y2) {
        if (!cands) return null;
        for (var si = 0; si < cands.length; si++) {
          if (cands[si] && cands[si].x === x2 && cands[si].y === y2) return candScoreOf(cands[si], myIsSideToMove !== false);
        }
        return null;
      };
      best = stabilizeBest(best, cands, _sbKey, _sbScore);
    }
    
    var isMyMove = (myIsSideToMove !== false);
    var list = null, tiers = null;
    if (S.heatmap || S.oppMoves) {
      list = [];
      for (var hi = 0; hi < cands.length; hi++) {
        var hc = cands[hi];
        if (!hc || hc.x < 0) continue;
        var hsc = candScoreOf(hc, isMyMove), hdup = -1;
        for (var hd2 = 0; hd2 < list.length; hd2++) if (list[hd2].c.x === hc.x && list[hd2].c.y === hc.y) { hdup = hd2; break; }
        if (hdup >= 0) { if (hsc > list[hdup].score) list[hdup] = { c: hc, score: hsc }; }   
        else list.push({ c: hc, score: hsc });
      }
      
      var best0 = (best && best.length === 2 && best[0] >= 0 && best[1] >= 0 && best[0] < 15 && best[1] < 15) ? best : null;
      if (!best0 && cands && cands.length && cands[0] && cands[0].x >= 0) best0 = [cands[0].x, cands[0].y];
      list.sort(function (a, b) {
        var aB = (best0 && a.c.x === best0[0] && a.c.y === best0[1]) ? 1 : 0;
        var bB = (best0 && b.c.x === best0[0] && b.c.y === best0[1]) ? 1 : 0;
        if (aB !== bB) return bB - aB;
        return b.score - a.score;
      });
      tiers = heatTiers(list);
    }
    if (S.heatmap) {
      
      var hmByStrong = [];
      for (var hi2 = 0; hi2 < list.length; hi2++) hmByStrong.push(hi2);
      hmByStrong.sort(function (a, b) { return (list[a].score - list[b].score); });   
      for (var di = 0; di < hmByStrong.length; di++) {
        var li = hmByStrong[di];
        var hTier = tiers[li] || 1;                    
        var hc2 = list[li].c;
        if (board && board[hc2.y] && board[hc2.y][hc2.x] !== 0) continue;   
        var p = pt(hc2.x, hc2.y);
        var i5 = document.createElementNS(svgNS, 'circle');
        i5.setAttribute('cx', p.x); i5.setAttribute('cy', p.y);
        
        i5.setAttribute('r', String(cellPx * HEAT_RADII[hTier - 1]));
        i5.setAttribute('fill', HEAT_COLORS[hTier - 1]);
        i5.setAttribute('opacity', String(HEAT_OPAC[hTier - 1]));
        
        if (best0 && list[li].c.x === best0[0] && list[li].c.y === best0[1]) {
          i5.setAttribute('stroke', '#9ad0ff');
          i5.setAttribute('stroke-width', String(Math.max(1.5, cellPx * 0.06)));
        }
        svg.appendChild(i5);
      }
    } else {
      
      var c0 = cands[0];
      if (c0 && c0.x >= 0 && !(board && board[c0.y] && board[c0.y][c0.x] !== 0)) {
        var pb = pt(c0.x, c0.y);
        var bestR = document.createElementNS(svgNS, 'circle');
        bestR.setAttribute('cx', pb.x); bestR.setAttribute('cy', pb.y);
        bestR.setAttribute('r', cellPx * 0.30);
        bestR.setAttribute('fill', 'none');
        bestR.setAttribute('stroke', '#1e6fe8');
        bestR.setAttribute('stroke-width', String(Math.max(3, cellPx * 0.09)));
        svg.appendChild(bestR);
      }
    }
    
    if (svg.parentNode !== overlay) overlay.appendChild(svg);
    
    if (oppSvg && oppSvg.parentNode === overlay) overlay.appendChild(oppSvg);
    
    if (S.oppMoves && lastOppRings && lastOppRings.length && cal && cv && !boardHasFive(board)) {
      try { drawOppSvg(cal, board, lastOppRings); } catch (e) {}
    }
  }

  var oppEvalBusy = false, oppEvalTimer = null;
  
  function clearOppSvgLayer() {
    try { if (oppSvg && oppSvg.parentNode === overlay) overlay.removeChild(oppSvg); } catch (e) {}
    oppSvg = null; lastOppGeom = null;
    lastOppRings = null; lastOppKey = null;
  }
  function startOppEval() {
    
    if (!oppEvalTimer) { oppEvalTimer = setInterval(runOppEval, 700); }
    runOppEval();
  }
  
  var oppKickTimer = null;
  function kickOppEval() {
    if (!S.oppMoves || oppEvalBusy || haltForNewGame) return;
    if (oppKickTimer) return;                       
    oppKickTimer = setTimeout(function () {
      oppKickTimer = null;
      runOppEval();
    }, 120);
  }
  function stopOppEval() {
    if (oppEvalTimer) { clearInterval(oppEvalTimer); oppEvalTimer = null; }
    clearOppSvgLayer();
  }
  
  function overlayGeom(cal, cv) {
    var isScr = !!cal.isScreen;
    var r = isScr ? (cal.topRect || {}) : toTopRect(cv);
    if (!r || !r.width || !r.height) return null;
    var scaleX = isScr ? 1 : r.width / cv.width;
    var scaleY = isScr ? 1 : r.height / cv.height;
    var baseX = isScr ? cal.x0 : 0, baseY = isScr ? cal.y0 : 0;
    var x0 = cal.x0, y0 = cal.y0, stepX = cal.stepX, stepY = cal.stepY;
    return {
      isScr: isScr, r: r, scaleX: scaleX, scaleY: scaleY,
      cellPx: cal.cell * scaleX,
      
      pt: function (i, j) {
        return {
          x: (x0 + i * stepX - baseX) * scaleX,
          y: (y0 + j * stepY - baseY) * scaleY
        };
      },
      
      sig: x0.toFixed(2) + ',' + y0.toFixed(2) + ',' + stepX.toFixed(3) + ',' + stepY.toFixed(3) +
           ',' + r.width.toFixed(1) + ',' + r.height.toFixed(1) + ',' + r.left.toFixed(1) + ',' + r.top.toFixed(1)
    };
  }

  function drawOppSvg(cal, board, rings) {
    var cv = (cachedBoard && cachedBoard.cv) ? cachedBoard.cv : null;
    if (!cv && !cal.isScreen) return;
    if (!rings || !rings.length) {
      try { if (oppSvg && oppSvg.parentNode === overlay) overlay.removeChild(oppSvg); } catch (e) {}
      oppSvg = null; lastOppGeom = null; return;
    }
    cal = stableCalForRender(cal, cv);   
    var g = overlayGeom(cal, cv);
    if (!g) { try { if (oppSvg && oppSvg.parentNode === overlay) overlay.removeChild(oppSvg); } catch (e) {} oppSvg = null; lastOppGeom = null; return; }
    var svgNS = 'http://www.w3.org/2000/svg';
    
    var reuse = oppSvg && oppSvg.parentNode === overlay && lastOppGeom && lastOppGeom.sig === g.sig;
    var svg = reuse ? oppSvg : document.createElementNS(svgNS, 'svg');
    if (!reuse) {
      svg.id = '__gb_opp_svg';
      svg.setAttribute('width', g.r.width); svg.setAttribute('height', g.r.height);
      svg.style.position = 'absolute';
      svg.style.zIndex = '20';
      svg.style.pointerEvents = 'none';
    } else {
      while (svg.firstChild) svg.removeChild(svg.firstChild);   
    }
    overlay.style.left = g.r.left + 'px'; overlay.style.top = g.r.top + 'px';
    overlay.style.width = g.r.width + 'px'; overlay.style.height = g.r.height + 'px';
    var pt = g.pt, cellPx = g.cellPx;
    for (var i = 0; i < rings.length; i++) {
      var r0 = rings[i];
      if (board && board[r0.y] && board[r0.y][r0.x] !== 0) continue;   
      var pO = pt(r0.x, r0.y);
      var halo = document.createElementNS(svgNS, 'circle');
      halo.setAttribute('cx', pO.x); halo.setAttribute('cy', pO.y);
      halo.setAttribute('r', cellPx * 0.26);
      halo.setAttribute('fill', 'none');
      halo.setAttribute('stroke', '#ffffff');
      halo.setAttribute('stroke-width', String(Math.max(5, cellPx * 0.15)));
      halo.setAttribute('stroke-dasharray', String(Math.max(5, cellPx * 0.2)) + ',' + String(Math.max(3, cellPx * 0.12)));
      halo.setAttribute('opacity', '0.55');
      svg.appendChild(halo);
      var ring = document.createElementNS(svgNS, 'circle');
      ring.setAttribute('cx', pO.x); ring.setAttribute('cy', pO.y);
      ring.setAttribute('r', cellPx * 0.26);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', HEAT_COLORS[((r0.tier || 1) - 1) % HEAT_COLORS.length]);   
      ring.setAttribute('stroke-width', String(Math.max(4, cellPx * 0.11)));
      ring.setAttribute('stroke-dasharray', String(Math.max(5, cellPx * 0.2)) + ',' + String(Math.max(3, cellPx * 0.12)));
      ring.setAttribute('opacity', '1');
      svg.appendChild(ring);
    }
    if (svg.childNodes.length) {
      if (!reuse) overlay.appendChild(svg);
      oppSvg = svg;
      lastOppGeom = { x0: cal.x0, y0: cal.y0, stepX: cal.stepX, stepY: cal.stepY, sig: g.sig };
    } else if (!reuse) {
      oppSvg = null; lastOppGeom = null;
    }
  }
  
  function boardHasFive(b) { return maxLineLen(b, 1) >= 5 || maxLineLen(b, 2) >= 5; }

  function computeOppRings(reqBoard, myC, oppC, cands, rule) {
    
    if (boardHasFive(reqBoard)) return [];
    
    var renjuB = (rule === 2);
    var pts = [];
    function collect(color, out) {
      var five = allImmediateFiveCells(reqBoard, color, renjuB && color === 1);
      for (var q = 0; q < five.length; q++) {
        var p = five[q], dup = false;
        for (var z = 0; z < out.length; z++) if (out[z].x === p.i && out[z].y === p.j) { dup = true; break; }
        if (!dup) out.push({ x: p.i, y: p.j });
      }
    }
    collect(myC, pts);
    collect(oppC, pts);
    if (pts.length) {
      pts.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
      return pts.slice(0, 2).map(function (p, k) { return { x: p.x, y: p.y, tier: k + 1 }; });
    }
    
    var list = [];
    for (var i = 0; i < (cands || []).length; i++) {
      var c = cands[i];
      if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') continue;
      if (c.x < 0 || c.x >= N || c.y < 0 || c.y >= N) continue;
      if (reqBoard[c.y] && reqBoard[c.y][c.x] !== 0) continue;      
      list.push({ x: c.x, y: c.y, s: candScoreOf(c, true) });       
    }
    list.sort(function (a, b) { return (b.s - a.s) || (a.y - b.y) || (a.x - b.x); });
    return list.slice(0, 2).map(function (p, k) { return { x: p.x, y: p.y, tier: k + 1 }; });
  }

  async function runOppEval() {
    if (!S.oppMoves || oppEvalBusy || haltForNewGame) return;
    if (!lastGoodBoard || !lastGoodCal) return;
    var board = lastGoodBoard;
    var n0 = countStones(board);
    if (n0 < 2) return;
    
    if (maxLineLen(board, 1) >= 5 || maxLineLen(board, 2) >= 5) { clearOppSvgLayer(); return; }
    
    var _myC = myColorCode();
    var _oppC = oppColorCode();
    if (_myC === 0 || _oppC === 0) { clearOppSvgLayer(); return; }   
    var _stm = sideToMoveColor(board);
    var best0 = (S.candCache && S.candCache[0] && S.candCache[0].x >= 0 && S.candCache[0].y >= 0 && S.candCache[0].x < N && S.candCache[0].y < N) ? S.candCache[0] : null;
    var myTurn = (_stm === _myC);   
    
    var key = fingerprint(board) + '|' + _stm + '|' + (best0 ? (best0.x + ',' + best0.y) : 'nobest') + '|' + (myTurn ? 'own' : 'opp');
    if (key === lastOppKey && lastOppRings && lastOppRings.length) return;   
    oppEvalBusy = true;
    try {
      var cal = lastGoodCal;
      
      var reqBoard, myMove = null;
      if (myTurn) {
        if (best0) {
          reqBoard = board.map(function (r) { return r.slice(); });
          if (reqBoard[best0.y][best0.x] === 0) { reqBoard[best0.y][best0.x] = _myC; myMove = { x: best0.x, y: best0.y }; }
        } else {
          reqBoard = board.map(function (r) { return r.slice(); });   
        }
      } else {
        reqBoard = board;     
      }
      var ctrl = new AbortController();
      var to = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 7000);
      var r = await tryLocal(LOCAL_HOSTS, '/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: reqBoard, rule: S.rule, matchMs: S.matchMs, turnMs: 700, timeUsedMs: S.timeUsedGame || 0, topN: 3, cid: CLIENT_ID + '-opp', lane: 'sub' }),
        signal: ctrl.signal
      });
      clearTimeout(to);
      var d = await r.json();
      
      if (haltForNewGame) return;
      if (boardHasFive(lastGoodBoard || board)) { clearOppSvgLayer(); return; }
      if (!d || d.error || !d.candidates || !d.candidates.length) return;
      
      var _reqStm = sideToMoveColor(reqBoard);
      
      var rings = (_reqStm === _oppC) ? computeOppRings(reqBoard, _myC, _oppC, d.candidates, S.rule) : [];
      if (!rings.length) {
        
        clearOppSvgLayer();
        return;
      }
      lastOppKey = key; lastOppRings = rings;
      drawOppSvg(cal, board, rings);   
    } catch (e) {}
    finally { oppEvalBusy = false; }
  }

  function clearOverlayKeepOpp(cal, cv, board) {
    var oldHeat = overlay.querySelector('#__gb_heat_svg');
    if (oldHeat) { try { overlay.removeChild(oldHeat); } catch (e) {} }
    
    if (S.oppMoves && oppSvg && cal && cv && lastOppRings && lastOppRings.length && !boardHasFive(board)) {
      var gOk = lastOppGeom && Math.abs(lastOppGeom.x0 - cal.x0) < 0.5 && Math.abs(lastOppGeom.y0 - cal.y0) < 0.5 &&
                Math.abs(lastOppGeom.stepX - cal.stepX) < 0.1 && Math.abs(lastOppGeom.stepY - cal.stepY) < 0.1;
      if (!gOk) drawOppSvg(cal, board, lastOppRings);   
    }
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
    var labelCol = S.dark ? '#7d8390' : '#9aa3ad';
    
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

  var statusEl = document.getElementById('__gb_status');
  function setStatus(html) {
    
    if (window.__gbCopyUntil && Date.now() < window.__gbCopyUntil && html.indexOf('#c0392b') < 0) return;
    statusEl.innerHTML = html;
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

function kickAnalyze() {
    
    lastEngineFp = null; lastEngineAt = 0;
    cachedBoard = null; pyBoardCache = null;
    lastBoard = null; lastCount = 0;
    scheduleNext();
  }

  async function refreshOverlayCands(cal, cv, board, fp, bestMain, mainC0) {
    if (overlayRefreshBusy) return;
    overlayRefreshBusy = true;
    
    var refreshMs = S.autoPlay ? 2000 : Math.max(1200, Math.min(4000, Math.round(((deepMode ? DEEP_MS : S.turnMs) || 5000) * 0.5)));
    try {
      var ctrl = new AbortController();
      var to = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, refreshMs + 6000);
      
      var rP = tryLocal(LOCAL_HOSTS, '/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: board, rule: S.rule, matchMs: S.matchMs, turnMs: refreshMs, timeUsedMs: S.timeUsedGame || 0, topN: 8, cid: CLIENT_ID, lane: 'sub' }),
        signal: ctrl.signal
      });
      var bn0 = 0, wn0 = 0;
      for (var by2 = 0; by2 < board.length; by2++) for (var bx2 = 0; bx2 < board[by2].length; bx2++) { if (board[by2][bx2] === 1) bn0++; else if (board[by2][bx2] === 2) wn0++; }
      
      var myBlack0 = (mySideMask() !== 1);   
      var data = await rP.json();
      clearTimeout(to);
      if (!data || data.error || !data.candidates || !data.candidates.length) return;
      
      if (fp !== lastEngineFp) return;
      
      if (data.candidates.length < 4 && !haltForNewGame) {
        try {
          var ctrl2 = new AbortController();
          var to2 = setTimeout(function () { try { ctrl2.abort(); } catch (e) {} }, refreshMs + 8000);
          var rQ = tryLocal(LOCAL_HOSTS, '/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ board: board, rule: S.rule, matchMs: S.matchMs, turnMs: Math.min(6000, refreshMs + 1500), timeUsedMs: S.timeUsedGame || 0, topN: 8, cid: CLIENT_ID, lane: 'sub' }),
            signal: ctrl2.signal
          });
          var d2 = await rQ.json();
          clearTimeout(to2);
          if (fp === lastEngineFp && d2 && !d2.error && d2.candidates && d2.candidates.length > data.candidates.length) data = d2;
        } catch (e) {}
      }
      var cands = data.candidates.slice(0, 8);
      
      if ((!bestMain || bestMain.length !== 2) && mainC0 && mainC0.x >= 0) bestMain = [mainC0.x, mainC0.y];
      
      if (bestMain && bestMain.length === 2) {
        var fIdx = -1;
        for (var k = 0; k < cands.length; k++) if (cands[k].x === bestMain[0] && cands[k].y === bestMain[1]) { fIdx = k; break; }
        if (fIdx > 0) cands.unshift(cands.splice(fIdx, 1)[0]);
      }
      if (mainC0 && cands.length) {
        
        var sameAsMain = (cands[0].x === mainC0.x && cands[0].y === mainC0.y);
        if (sameAsMain) {
          cands[0].eval = mainC0.eval || cands[0].eval;
          cands[0].depth = mainC0.depth || cands[0].depth;
          cands[0].speed = mainC0.speed || cands[0].speed;
          cands[0].nodes = mainC0.nodes || cands[0].nodes;
          if (mainC0.line && mainC0.line.length) cands[0].line = mainC0.line;
        }
      }
      S.candCache = cands;
      
      if (cal && cv) {
        
        var myColorHere = myBlack0 ? 1 : 2;
        var isMyMoveNow = (sideToMoveColor(board) === myColorHere);
        drawOverlay(cal, cv, cands, bestMain, board, isMyMoveNow);
      }
    } catch (e) {}
    finally {
      overlayRefreshBusy = false;
    }
  }

async function analyze() {
    
    if (S.analyzing) return;
    S.analyzing = true;
    try {
      
      if (sideIsManual()) { if (S.userSide !== -1) S.userSide = -1; }
      else if (S.userSide !== 0 && S.userSide !== 1) S.userSide = -1;

      var found = await pyFindBoard();
      if (!found) found = findBoard();
      if (!found) {
        if (lastBoardFail === 'canvas-calib') setStatus('<span style="color:#e67e22;">' + SF('fail') + '</span>');
        else setStatus(T('no_board'));
        return;
      }
      var cv = found.cv, cal = found.cal;
      var board = found.board || readBoard(cal, cv);
      var n = countStones(board);
      var acc = found.board ? 1 : (n > 0 ? verifyBoard(cal, cv, board) : 0);

      if (lastGoodCal && found.cal && Date.now() - lastMirrorFixAt > 150) {   
        var _lg = lastGoodCal;
        var _stepOk = _lg.stepY > 0 && cal.stepY > 0 && Math.abs(cal.stepY - _lg.stepY) / _lg.stepY < 0.20;   
        var _yMirr = _stepOk && (Math.abs((_lg.y0 + 14 * _lg.stepY) - cal.y0) < cal.stepY * 0.45 ||
                                 Math.abs((_lg.y0 - 14 * _lg.stepY) - cal.y0) < cal.stepY * 0.45);
        var _xMirr = _stepOk && (Math.abs((_lg.x0 + 14 * _lg.stepX) - cal.x0) < cal.stepX * 0.45 ||
                                 Math.abs((_lg.x0 - 14 * _lg.stepX) - cal.x0) < cal.stepX * 0.45);
        if (_yMirr || _xMirr) {
          diag('geometry mirror vs last good cal -> revert geometry and re-read');
          lastMirrorFixAt = Date.now();   
          cal = _lg;
          board = readBoard(cal, cv);
          n = countStones(board);
          acc = n > 0 ? verifyBoard(cal, cv, board) : 0;
          if (pyBoardCache) pyBoardCache.cal = cal;
          if (cachedBoard) { cachedBoard.cal = cal; cachedBoard.board = board; }
          drawCalibFrame(cal, cv);   
        }
      }
      
      if (lastGoodBoard && lastGoodCal && n >= 2 && countStones(board) >= 2) {
        var _mrB = boardMatchRate(lastGoodBoard, board);
        var _fbB = flipBoardV(board);
        var _frB = boardMatchRate(lastGoodBoard, _fbB);
        if (_mrB < 0.7 && _frB > 0.75) {
          diag('board vertical mirror (match ' + _mrB.toFixed(2) + ' vs flipped ' + _frB.toFixed(2) + ') -> revert & re-read');
          lastMirrorFixAt = Date.now();
          cal = lastGoodCal;
          board = readBoard(cal, cv);
          n = countStones(board);
          acc = n > 0 ? verifyBoard(cal, cv, board) : 0;
          if (pyBoardCache) pyBoardCache.cal = cal;
          if (cachedBoard) { cachedBoard.cal = cal; cachedBoard.board = board; }
          drawCalibFrame(cal, cv);
        }
      }

      var needFix = (!found.board && n === 0 && roughStoneCheck(cal, cv)) || (n > 0 && acc > 0 && acc < 0.75);
      if (needFix) {
        var offs = [0, 0.5, -0.5, 1, -1], bestCal = null, bestAcc = acc, bestBoard = null;
        for (var oi = 0; oi < offs.length; oi++) for (var oj = 0; oj < offs.length; oj++) {
          if (oi === 0 && oj === 0) continue;
          var tc = { x0: cal.x0 + offs[oi] * cal.stepX, y0: cal.y0 + offs[oj] * cal.stepY, stepX: cal.stepX, stepY: cal.stepY, cell: cal.cell, bg: cal.bg, docRect: cal.docRect, topRect: cal.topRect, frameWin: cal.frameWin, isScreen: cal.isScreen, mode: cal.mode };
          var tb = readBoard(tc, cv);
          if (countStones(tb) <= 0) continue;
          var ta;
          if (n === 0) {
            
            ta = 0.5 + 0.5 * verifyBoard(tc, cv, tb);
          } else {
            
            if (n < 12) continue;
            ta = boardMatchRate(tb, board);
          }
          if (ta > bestAcc) { bestAcc = ta; bestCal = tc; bestBoard = tb; }
        }
        if (bestCal && (n === 0 ? bestAcc > 0.6 : (bestAcc > 0.9 && bestAcc > acc + 0.05))) {
          cal = bestCal; board = bestBoard; n = countStones(board); if (cachedBoard) cachedBoard.cal = cal; drawCalibFrame(cal, cv); acc = bestAcc; setStatus(SF('corrected', '{c}', Math.round(acc * 100))); }
      }

      var fpB = 0, fpW = 0;
      for (var fj = 0; fj < N; fj++) for (var fi = 0; fi < N; fi++) { if (board[fj][fi] === 1) fpB++; else if (board[fj][fi] === 2) fpW++; }
      
      var fpToMoveIsBlack = (openingSideToMove(board) === 1);
      var fpStones = fingerprint(board);
      var fp = fpStones + '#' + myColorCode() + '#' + (fpToMoveIsBlack ? 1 : 2);

      if (acc > 0 && acc < 0.6) { setStatus('<span style="color:#e67e22;">' + SF('off', '{c}', Math.round(acc * 100)) + '</span>'); clearOverlayKeepOpp(cal, cv, board); lastBoard = board.map(function (r) { return r.slice(); }); lastCount = n; return; }
      
      if (lastGoodCal && !lastGoodCal.isScreen && !cal.isScreen &&
          lastGoodCal.stepX > 0 && lastGoodCal.stepY > 0 && cal.stepX > 0 && cal.stepY > 0) {
        var pSame = Math.max(Math.abs(cal.stepX - lastGoodCal.stepX) / lastGoodCal.stepX,
                             Math.abs(cal.stepY - lastGoodCal.stepY) / lastGoodCal.stepY) < 0.15;
        var dyMir = Math.abs(cal.y0 - lastGoodCal.y0) > 7 * lastGoodCal.stepY;   
        var dxMir = Math.abs(cal.x0 - lastGoodCal.x0) > 7 * lastGoodCal.stepX;   
        if (pSame && (dyMir || dxMir)) {
          diag('mirror anchor jump (' + (dyMir ? 'V' : '') + (dxMir ? 'H' : '') + ') -> revert to stable geom & re-read');
          cal = lastGoodCal;
          board = readBoard(cal, cv);
          n = countStones(board);
          acc = n > 0 ? verifyBoard(cal, cv, board) : 0;
          if (cachedBoard) { cachedBoard.cal = cal; cachedBoard.board = board; }
          drawCalibFrame(cal, cv);
        }
      }
      var prevFrameBoard = lastGoodBoard;   
      lastGoodCal = cal;   
      lastGoodBoard = board;   
      if (typeof refreshPosWinIfOpen === 'function') refreshPosWinIfOpen();   

      var bCnt = 0, wCnt = 0;
      for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) { if (board[j][i] === 2) wCnt++; else if (board[j][i] === 1) bCnt++; }
      
      var stmColor = stmFromDiff(board, bCnt, wCnt, prevFrameBoard, lastStmColor);
      lastStmColor = stmColor;                              
      var toMoveIsBlack = (stmColor === 1);
      var stoneDiff = bCnt - wCnt;

      if (n > 0 && toMoveIsBlack !== (bCnt === wCnt)) {
        diag('openingSideToMove mismatch: bCnt=' + bCnt + ' wCnt=' + wCnt + ' stm=' + stmColor + ' (代数=' + (bCnt === wCnt ? '黑' : '白') + ')');
      }

      var fiveExists = (maxLineLen(board, 1) >= 5 || maxLineLen(board, 2) >= 5);
      
      if (n === 0 && (lastCount > 0 || emptyStreak > 0)) {
        emptyStreak++;
        
        if (emptyStreak >= 2) resetNewGame(S.lang === 'en' ? 'board cleared' : '棋盘已清空');
      } else {
        emptyStreak = 0;
        
        if (S.moves.length >= 4 && n > 0 && n < S.moves.length - 3) {
          shrinkStreak++;
          if (shrinkStreak >= 2) resetNewGame(S.lang === 'en' ? 'board reset' : '检测到新局');
        } else shrinkStreak = 0;
      }

      if (n > 0 && stoneDiff !== 0 && stoneDiff !== 1 && !fiveExists) {
        badDiffCount++;
        if (!badDiffSince) badDiffSince = Date.now();
        var dSince = Date.now() - badDiffSince;
        if (badDiffCount === 1 || (badDiffCount >= 4 && dSince > 1200)) {
          badDiffSince = Date.now();
          pyBoardCache = null; cachedBoard = null;
          diag('stone-diff -> immediate re-detect (#' + badDiffCount + ')');
          if (badDiffCount >= 4) { badDiffCount = 0; badDiffSince = 0; }
        }
        setStatus(S.lang === 'en' ? 'Board inconsistent, waiting…' : '棋盘子数异常，等待稳定…');
        lastBoard = board.map(function (r) { return r.slice(); }); lastCount = n; return;
      } else {
        badDiffCount = 0; badDiffSince = 0;
      }

      function resetNewGame(reason) {
        if (S.side === -1) S.userSide = -1;
        lastAutoFp = null; pendingClick = null; openWaitStart = 0; probeOpen = null;
        lastBoard = null; lastCount = 0; emptyStreak = 0; autoHaltUntil = 0;
        lastEngineFp = null; lastEngineAt = 0;
        lastOppRings = null; lastOppGeom = null;                 
        stabilizeBestReset();                                     
        sideLockUntil = 0; sideConflictCount = 0; shrinkStreak = 0;   
        sideVote = { color: -1, n: 0 };                               
        haltForNewGame = false;               
        haltReason = ''; clearGameOverLock();  
        overlayStale = false;                 
        
        pyBoardCache = null;
        lastGoodBoard = null; lastMirrorFixAt = 0;
        lastStmColor = 1;                     
        if (typeof refreshPosWinIfOpen === 'function') refreshPosWinIfOpen();   
        S.history = []; S.moves = []; S.candCache = []; S.lastStat = null;
        S.score = 0; S.rawEval = ''; S.myEval = ''; S.verdict = 'none'; S.matePly = 0; saveHistory();
        clearOverlay(); drawChart(); refreshStatLang();
        setStatus('<span style="color:#3b7dd8;">' + (S.lang === 'en' ? 'New game — ' : '新局 — ') + reason + '</span>');
      }

      var added = [];
      if (lastBoard) {
        for (var r0 = 0; r0 < N; r0++) for (var c0 = 0; c0 < N; c0++) {
          var oo = lastBoard[r0][c0], nn = board[r0][c0];
          if (oo === 0 && nn !== 0) added.push({ r: r0, c: c0, v: nn });
        }
      }

      var myCell = null, myColorHere = null, oppColorHere = null;
      if (pendingClick) {
        if (board[pendingClick.j][pendingClick.i] === pendingClick.color) {
          myCell = { i: pendingClick.i, j: pendingClick.j }; myColorHere = pendingClick.color;
        } else {
          
          for (var k0 = 0; k0 < added.length && !myCell; k0++) {
            if (added[k0].v === pendingClick.color &&
                Math.abs(added[k0].c - pendingClick.i) <= 1 && Math.abs(added[k0].r - pendingClick.j) <= 1) {
              myCell = { i: added[k0].c, j: added[k0].r }; myColorHere = pendingClick.color;
            }
          }
        }
        if (!myCell) { var u0 = recentUserCell(cal, cv); if (u0 && board[u0.j][u0.i] !== 0) { myCell = u0; myColorHere = board[u0.j][u0.i]; } }
      } else {
        var uc = recentUserCell(cal, cv);
        if (uc && board[uc.j][uc.i] !== 0) { myCell = uc; myColorHere = board[uc.j][uc.i]; }
      }
      
      if (added.length) {
        for (var kA = 0; kA < added.length && oppColorHere == null; kA++) {
          if (myCell && added[kA].c === myCell.i && added[kA].r === myCell.j) continue;
          if (pendingClick && added[kA].c === pendingClick.i && added[kA].r === pendingClick.j) continue;
          
          if (probeOpen && nearProbeCells(probeOpen, added[kA].c, added[kA].r)) continue;
          oppColorHere = added[kA].v; overlayStale = false; lastOppRings = null; clearOverlay();   
          kickOppEval();   
          break;
        }
      }
      
      if (AUTO_SIDE && S.side === -1 && added.length) {
        var evMy = (myColorHere != null) ? sideOfMyStone(myColorHere) : null;
        
        var evOpp = (oppColorHere != null && !probeOpen) ? sideOfOppStone(oppColorHere) : null;
        var observedSide = (evMy != null) ? evMy : evOpp;
        if (observedSide === 0 || observedSide === 1) {
          
          if (sideVote.color !== observedSide) sideVote = { color: observedSide, n: 1 };
          else sideVote.n++;
          var sideLocked = (Date.now() < sideLockUntil);
          var votesEnough = (sideVote.n >= SIDE_VOTE_NEED);
          if (S.userSide < 0) {
            
            if (votesEnough && !sideLocked) {
              S.userSide = observedSide; sideLockUntil = Date.now() + SIDE_LOCK_MS;
              sideVote.n = 0; sideConflictCount = 0;
              setStatus(S.lang === 'en' ? (S.userSide === 0 ? ' · auto: I play Black' : ' · auto: I play White') : (S.userSide === 0 ? ' · 自动识别我执<b>黑</b>' : ' · 自动识别我执<b>白</b>'));
            }
          } else if (S.userSide !== observedSide) {
            
            if (votesEnough && !sideLocked) {
              S.userSide = observedSide; sideLockUntil = Date.now() + SIDE_LOCK_MS;
              sideVote.n = 0; sideConflictCount = 0;
              
              lastEngineFp = null; lastEngineAt = 0; S.candCache = []; overlayStale = true;
              lastOppRings = null; lastOppGeom = null;
              if (typeof stabilizeBestReset === 'function') stabilizeBestReset();
              setStatus('<span style="color:#e67e22;">' +
                (S.lang === 'en' ? 'Side re-detected: I play ' + (observedSide === 0 ? 'Black' : 'White')
                                 : '重新判定：我执<b>' + (observedSide === 0 ? '黑' : '白') + '</b>') + '</span>');
            }
          }
        }
      }
      
      if (typeof paintSideBtns === 'function') paintSideBtns();
      
      if (added.length && S.moves.length < 400) {
        for (var kM = 0; kM < added.length; kM++) {
          var mv = coordLower(added[kM].c, added[kM].r);
          if (!S.moves.length || S.moves[S.moves.length - 1] !== mv) S.moves.push(mv);
        }
        refreshStatLang();
      }
      lastBoard = board.map(function (r) { return r.slice(); });
      lastCount = n;

      if (pendingClick) {
        var pLanded = false;
        for (var pA = 0; pA < added.length && !pLanded; pA++) if (added[pA].v === pendingClick.color) pLanded = true;
        var pSuccess = myCell || pLanded;
        if (pSuccess) {
          var pCal = pendingClick.cal, pCv = pendingClick.cv;   
          pendingClick = null;
          
          if (!oppColorHere) { overlayStale = true; clearOverlayKeepOpp(pCal, pCv, board); }
          
          autoHaltUntil = Date.now() + 1500;
          setStatus(S.lang === 'en' ? 'Auto-move placed' : '自动落子已生效'); }
        else if (Date.now() - pendingClick.since > 3000) {
          pendingClick.retries++;
          if (pendingClick.retries < 3) { redispatchPending(pendingClick); pendingClick.since = Date.now(); setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Retrying move…' : '落子未生效，重试中…') + '</span>'); }
          else { setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? '自动落子未确认，暂停中——可手动点一下棋盘即自动恢复' : 'Auto-move unconfirmed, paused — click the board to auto-resume') + '</span>'); autoHaltUntil = Date.now() + 8000; pendingClick = null; }
        }
        return;
      }
      
      if (S.autoPlay && sideResolved() && !pendingClick && myColorHere != null &&
          myColorHere === myColorCode() && autoHaltUntil > Date.now()) {
        autoHaltUntil = 0;
        setStatus(S.lang === 'en' ? 'Manual move detected, auto-play resumed' : '已检测到我方落子，自动落子已恢复');
      }

      if (AUTO_SIDE && S.autoPlay && S.side === -1 && S.userSide < 0) {   
        
        var probeRetry = function () {
          if (probeOpen.retried) {
            probeOpen = null;
            setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Cannot detect - set 我执 (Black/White)' : '仍无法判定先后手——请点「我执」手动选黑/白') + '</span>');
            return;
          }
          probeOpen.retried = true; probeOpen.since = Date.now();
          if (!probeOpen.cells) probeOpen.cells = [{ i: probeOpen.i, j: probeOpen.j }];
          var offs2 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
          var p2 = offs2[(Math.random() * offs2.length) | 0];
          probeOpen.i = 7 + p2[0]; probeOpen.j = 7 + p2[1];
          probeOpen.cells.push({ i: probeOpen.i, j: probeOpen.j });   
          var pb2 = coordFor(cal, cv, probeOpen.i, probeOpen.j);
          if (pb2 && !pb2.blocked) { panelClickFlag = true; syntheticClick(cal, cv, probeOpen.i, probeOpen.j, pb2.x, pb2.y, pb2.pageX, pb2.pageY, pb2.frameWin); setTimeout(function () { panelClickFlag = false; }, 400); }
          setStatus(S.lang === 'en' ? '1st probe inert, retrying a nearby cell…' : '首试未落成，换周围格再试…');
        };
        if (probeOpen) {
          
          var probeCells = probeOpen.cells || [{ i: probeOpen.i, j: probeOpen.j }];
          var nearOur = null, farBlack = null, farWhite = null, nearWhite = null;
          var nearAnyProbe = function (c, r) {
            for (var pi = 0; pi < probeCells.length; pi++) {
              if (Math.abs(c - probeCells[pi].i) <= 1 && Math.abs(r - probeCells[pi].j) <= 1) return true;
            }
            return false;
          };
          for (var q0 = 0; q0 < added.length; q0++) {
            var qa = added[q0];
            var nearP = nearAnyProbe(qa.c, qa.r);
            if (qa.v === 1) { if (nearP) { if (!nearOur) nearOur = qa; } else if (!farBlack) farBlack = qa; }
            else if (qa.v === 2) {
              if (nearP) { if (!nearWhite) nearWhite = qa; }   
              else if (!farWhite) farWhite = qa;
            }
          }
          
          if (!nearOur) {
            for (var pi2 = 0; pi2 < probeCells.length && !nearOur; pi2++) {
              var pc0 = probeCells[pi2];
              for (var dr9 = -1; dr9 <= 1 && !nearOur; dr9++) for (var dc9 = -1; dc9 <= 1 && !nearOur; dc9++) {
                var r9 = pc0.j + dr9, c9 = pc0.i + dc9;
                if (r9 >= 0 && r9 < N && c9 >= 0 && c9 < N && board[r9][c9] === 1) nearOur = { r: r9, c: c9, v: 1 };
              }
            }
          }
          if (nearOur) {
            S.userSide = 0; probeOpen = null; sideLockUntil = Date.now() + 4000;
            setStatus(S.lang === 'en' ? 'Probe cell = my Black → I play first' : '探测格落黑子 → 判我执<b>黑</b>（先手）');
          } else if (nearWhite) {
            
            S.userSide = 1; probeOpen = null; sideLockUntil = Date.now() + 4000;
            setStatus(S.lang === 'en' ? 'Probe cell = my White → I play second' : '探测格落白子 → 判我执<b>白</b>（后手）');
          } else if (farBlack) {
            S.userSide = 1; probeOpen = null; sideLockUntil = Date.now() + 4000;
            setStatus(S.lang === 'en' ? 'Opponent opened elsewhere → I play second' : '对方先开局 → 判我执<b>白</b>（后手）');
          } else if (farWhite) {
            
            probeRetry();
          } else if (Date.now() - probeOpen.since > 1500) {
            probeRetry();
          }
          drawChart(); clearOverlayKeepOpp(cal, cv, board);
          return;
        }
        
        if (n === 0) {
          
          if (added.length) {
            var fAdd = added[0];
            if (fAdd.v === 1) {
              S.userSide = 1; probeOpen = null; openWaitStart = 0; sideLockUntil = Date.now() + 4000;
              setStatus(S.lang === 'en' ? 'Opponent opened with Black → I play White' : '对手黑子开局 → 判我执<b>白</b>（后手）');
              drawChart(); clearOverlayKeepOpp(cal, cv, board);
              return;
            } else if (fAdd.v === 2) {
              
              S.userSide = 0; probeOpen = null; openWaitStart = 0; sideLockUntil = Date.now() + 4000;
              setStatus(S.lang === 'en' ? 'Opponent opened with White → I play Black' : '对手白子开局 → 判我执<b>黑</b>（先手）');
              drawChart(); clearOverlayKeepOpp(cal, cv, board);
              return;
            }
          }
          
          var offsH = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];   
          var ph = offsH[(Math.random() * offsH.length) | 0];
          probeOpen = { since: Date.now(), i: 7 + ph[0], j: 7 + ph[1], color: 1, retried: false, cells: [{ i: 7 + ph[0], j: 7 + ph[1] }] };
          var pb1 = coordFor(cal, cv, probeOpen.i, probeOpen.j);
          if (pb1 && !pb1.blocked) { panelClickFlag = true; syntheticClick(cal, cv, probeOpen.i, probeOpen.j, pb1.x, pb1.y, pb1.pageX, pb1.pageY, pb1.frameWin); setTimeout(function () { panelClickFlag = false; }, 400); }
          setStatus(S.lang === 'en' ? 'Clicking to probe side (net + board confirm)…' : '立即点击试探判先后手（后台+盘面双重确认）…');
          drawChart(); clearOverlayKeepOpp(cal, cv, board);
          return;
        }
        
        setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Side pending - will detect on next stone (or set 我执 manually)' : '先后手待定——对方落子后自动判定；也可在「我执」手动选择黑/白') + '</span>');
        drawChart(); clearOverlayKeepOpp(cal, cv, board); return;
      }

      if (n === 0 && !gameOverLocked()) { haltForNewGame = false; haltReason = ''; }
      
      if (mySideMask() < 0) {
        setStatus('<span style="color:#e67e22;">' + (S.lang === 'en'
          ? 'Pick your color first — click B or W in the "Me" row, then play.'
          : '请先在面板「我执」点选<b>黑</b>或<b>白</b>后再开始（不再自动猜先后手）') + '</span>');
        if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
        drawChart(); clearOverlayKeepOpp(cal, cv, board);
        return;
      }
      var ourIsBlack = (mySideMask() === 0);
      
      if (AUTO_SIDE && mySideMask() < 0 && oppColorHere != null) {
        ourIsBlack = (oppColorHere === 2);
      }
      var canAutoOpen = S.autoPlay && ourIsBlack && (mySideMask() === 0);
      
      if (n === 0 && !canAutoOpen) { setStatus(S.lang === 'en' ? 'Empty board, waiting…' : '空棋盘，等待落子…'); if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed); drawChart(); clearOverlayKeepOpp(cal, cv, board); return; }
      
      var ourTurn = ((stmColor === 1) === ourIsBlack);

      var myColor0 = myColorCode();          
      var oppColor0 = oppColorCode();        
      if (myColor0 === 0) {                  
        myColor0 = ourIsBlack === true ? 1 : 2;
        oppColor0 = ourIsBlack === true ? 2 : 1;
      }

      if (maxLineLen(board, myColor0) >= 5 || maxLineLen(board, oppColor0) >= 5) {
        var _winMe = maxLineLen(board, myColor0) >= 5;
        haltForNewGame = true;
        haltReason = _winMe ? 'five-my' : 'five-opp';
        setGameOverLock(haltReason);
        var _fiveScore = _winMe ? 1000 : -1000;
        S.score = _fiveScore; S.verdict = _winMe ? 'win' : 'lose'; S.matePly = 1;   
        pushHistPoint((S.moves && S.moves.length) ? S.moves.length : 0, _fiveScore);  
        saveHistory();
        clearOppSvgLayer();                                    
        if (S.candCache && S.candCache.length) {
          renderResult(cal, cv, S.candCache, null, null, _fiveScore, S.verdict, false, board, ourIsBlack === toMoveIsBlack);
        }
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
          ? (_winMe ? 'Five in a row — I WIN. Evaluation stopped, waiting for next game…'
                    : 'Opponent five in a row — I LOSE. Evaluation stopped, waiting for next game…')
          : (_winMe ? '已五子连珠——<b>我方获胜</b>，已停止评估，等待下一局…'
                    : '对手已五子连珠——<b>我方落败</b>，已停止评估，等待下一局…')) + '</span>');
        drawChart();
        clearOverlayKeepOpp(cal, cv, board);                   
        return;
      }

      if (!ourTurn) {
        setStatus('<span style="color:#555;">' + (S.lang === 'en' ? 'Waiting for opponent…' : '等待对手落子…') + '</span>');
        if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
        drawChart();                                   
        clearOverlayKeepOpp(cal, cv, board);
        return;
      }

      if (!haltForNewGame && ourTurn && Date.now() >= autoHaltUntil &&
          maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
        var winCellsEarly = allImmediateFiveCells(board, myColor0, (S.rule === 2 && myColor0 === 1));
        if (winCellsEarly.length) {
          var wc0 = winCellsEarly[0];
          if (board[wc0.j] && board[wc0.j][wc0.i] === 0) {
            if (playMove(cal, cv, wc0.i, wc0.j, myColor0)) {
              renderResult(cal, cv, S.candCache, [wc0.i, wc0.j], 0, 1000, 'win', false, board, true);
              setStatus(S.lang === 'en' ? 'Final move placed — win on board' : '已落制胜子，本局收官');
              drawChart();
              return;
            }
          }
        }
      }

      if (haltForNewGame && haltReason === 'm1' && !gameOverLocked() &&
          ourTurn && Date.now() >= autoHaltUntil && S.verdict === 'win' &&
          maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
        var m1wCells = allImmediateFiveCells(board, myColor0, (S.rule === 2 && myColor0 === 1));
        if (S.rule === 2 && myColor0 === 1 && m1wCells.length) {
          m1wCells = m1wCells.filter(function (wc) {
            return !isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0);
          });
        }
        if (m1wCells.length) {
          var m1w0 = m1wCells[0];
          if (board[m1w0.j] && board[m1w0.j][m1w0.i] === 0) {
            if (playMove(cal, cv, m1w0.i, m1w0.j, myColor0)) {
              haltForNewGame = false; haltReason = '';   
              setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
                ? 'Final move placed per +M1 — five in a row, evaluation stopped'
                : '已按 +M1 判定补下制胜子——<b>五子连珠</b>，本局收官（不再评估）') + '</span>');
              drawChart();
              return;
            }
          }
        }
      }

      {
        var _mC = myColorCode(), _oC = oppColorCode();
        if (_mC === 0) { _oC = 1; _mC = 2; }              
        var _myFive = maxLineLen(board, _mC) >= 5;
        var _opFive = maxLineLen(board, _oC) >= 5;
        if (_myFive || _opFive) {
          var _fScore = _myFive ? 1000 : -1000;
          var _fVerd = _myFive ? 'win' : 'lose';
          haltForNewGame = true;                          
          haltReason = _myFive ? 'five-my' : 'five-opp';
          setGameOverLock(haltReason);                    
          S.score = _fScore; S.verdict = _fVerd; S.matePly = 1;
          
          pushHistPoint((S.moves && S.moves.length) ? S.moves.length : 0, _fScore);
          try { save(); } catch (e) {}
          saveHistory();
          clearOppSvgLayer();                             
          if (S.candCache && S.candCache.length) {
            renderResult(cal, cv, S.candCache, null, null, _fScore, _fVerd, false, board, toMoveIsBlack === ourIsBlack);
          }
          setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
            ? (_myFive ? 'Five in a row — I WIN. Evaluation stopped, waiting for next game…'
                       : 'Opponent five in a row — I LOSE. Evaluation stopped, waiting for next game…')
            : (_myFive ? '已五子连珠——<b>我方获胜</b>，已停止评估，等待下一局…'
                       : '对手已五子连珠——<b>我方落败</b>，已停止评估，等待下一局…')) + '</span>');
          drawChart();
          clearOverlayKeepOpp(cal, cv, board);
          return;
        }
      }

      if (S.autoPlay && n === 0 && ourIsBlack && !haltForNewGame) {
        var opI = 7, opJ = 7;
        if (board[opJ] && board[opJ][opI] === 0) {
          var _ok = playMove(cal, cv, opI, opJ, 1);
          
          if (!_ok && Date.now() - openReanchorAt > 1200) {
            openReanchorAt = Date.now();
            cachedBoard = null; screenBoard = null; lastGoodCal = null;
            diag('opening click failed -> re-anchor geometry');
          } else if (_ok) {
            setStatus(S.lang === 'en' ? 'Opening move placed (center)' : '已自动开局（天元）');
            drawChart(); clearOverlay();
          }
        }
        return;
      }

      var needEngine = !haltForNewGame && (fp !== lastEngineFp);
      if (!needEngine) {
        if (S.candCache.length) renderResult(cal, cv, S.candCache, null, null, S.score, S.verdict, false, board, toMoveIsBlack === ourIsBlack);
        else if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
        
        if (S.autoPlay && !haltForNewGame && ourTurn && Date.now() >= autoHaltUntil && S.candCache && S.candCache.length) {
          
          var autoColor2 = toMoveIsBlack ? 1 : 2;
          var am2 = autoAnchorPick(board, null, S.candCache, autoColor2, { budgetMs: 99999 });
          if (am2) {
            var ax2 = am2[0], ay2 = am2[1];
            if (board[ay2][ax2] !== 0) { var ne2 = nearestEmpty(board, ax2, ay2); if (ne2) { ax2 = ne2.i; ay2 = ne2.j; } }
            if (ax2 >= 0 && ay2 >= 0 && board[ay2][ax2] === 0) playMove(cal, cv, ax2, ay2, toMoveIsBlack ? 1 : 2);
          }
        }
        return;
      }

      lastEngineFp = fp; lastEngineAt = Date.now();
      
      var reqFp = fp;
      var reqOurIsBlack = ourIsBlack;
      setStatus('<span style="color:#3b7dd8;">' + T('thinking') + '</span>');
      setStatPanelThinking();
      var t0 = Date.now();
      
      var myIsSideToMove = (toMoveIsBlack === ourIsBlack);
      var liveGen = 0;
      var liveTimer = setInterval(function () {
        var g = liveGen;
        (async function () {
          try {
            var rs = await tryLocal(LOCAL_HOSTS, '/api/status?cid=' + CLIENT_ID + '&lane=main', { method: 'GET', cache: 'no-store' });
            var st = await rs.json();
            if (g !== liveGen || !st || !st.searching || !st.pvs || !st.pvs.length) return;
            var pv0 = st.pvs[0];
            if (!pv0) return;
            var les = evalToScore(pv0.eval, myIsSideToMove);
            var lscore = les.score, lverd = les.verdict;
            function lset(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
            lset('__gb_st_depth', pv0.depth ? pv0.depth : '-');
            
            var lRaw = (typeof pv0.eval === 'string' && pv0.eval.length) ? pv0.eval.trim() : '';
            S.rawEval = lRaw;
            var lMine = lRaw ? evalToMine(lRaw, myIsSideToMove) : '';
            S.myEval = lMine;
            lset('__gb_st_eval', lMine || '-');
            lset('__gb_st_speed', st.speed ? fmtKMG(st.speed) : '-');
            lset('__gb_st_nodes', st.nodes ? fmtKMG(st.nodes) : '-');
            var lCoord = String.fromCharCode(65 + pv0.x) + (N - pv0.y);
            var lCol, lLab;
            if (lverd === 'win') { lCol = '#3b7dd8'; lLab = S.lang === 'en' ? 'I WIN (M)' : '我方必胜'; }
            else if (lverd === 'lose') { lCol = '#e74c3c'; lLab = S.lang === 'en' ? 'I LOSE (-M)' : '我方必败'; }
            else if (lscore < -300) { lCol = '#e67e22'; lLab = S.lang === 'en' ? 'Bad' : '大劣'; }
            else if (lscore > 300) { lCol = '#2e7d32'; lLab = S.lang === 'en' ? 'Good' : '优势'; }
            else { lCol = '#7f8c8d'; lLab = S.lang === 'en' ? 'Even' : '均势'; }
            setStatus((S.lang === 'en' ? 'Depth ' : '深度 ') + '<b>' + (pv0.depth || '-') + '</b> · ' + (S.lang === 'en' ? 'Move ' : '推荐 ') + '<b style="color:#e53935">' + lCoord + '</b>　' + (S.lang === 'en' ? 'eval ' : '评估 ') + '<b style="color:' + lCol + '">' + (lMine || '-') + '</b> <b style="color:' + lCol + '">(' + lLab + ')</b>');
            drawChart();
            if (cal && cv) {
              var liveCands = [];
              for (var li = 0; li < st.pvs.length; li++) {
                var lc = st.pvs[li];
                liveCands.push({ x: lc.x, y: lc.y, eval: lc.eval || '', depth: lc.depth || 0, speed: st.speed || 0, nodes: st.nodes || 0, line: lc.line || [] });
              }
              drawOverlay(cal, cv, liveCands, (st.best && st.best.length === 2) ? st.best : null, board, myIsSideToMove);
            }
          } catch (e) {}
        })();
      }, 250);
      var ctrl = new AbortController();
      if (deepMode) setStatus(S.lang === 'en' ? '<span style="color:#A5B4FC;">Deep analyze (≈30s)…</span>' : '<span style="color:#A5B4FC;">深度计算中（约30秒）…</span>');
      
      var effTurn = deepMode ? DEEP_MS : S.turnMs;
      var abt = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, Math.max(3000, effTurn + 8000));
      var data;
      try {
        
        var liveTopN = 1;
        
        var moveTurnMs = (S.autoPlay ? Math.max(effTurn, 2500) : effTurn);
        var body0 = JSON.stringify({ board: board, rule: S.rule, matchMs: S.matchMs, turnMs: moveTurnMs, timeUsedMs: S.timeUsedGame || 0, topN: liveTopN, cid: CLIENT_ID, lane: 'main' });
        var r = await tryLocal(LOCAL_HOSTS, '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body0, signal: ctrl.signal });
        ENGINE = r.url ? r.url.split('/api/analyze')[0] : ENGINE;
        data = await r.json();
      } catch (e) {
        clearTimeout(abt);
        liveGen++; clearInterval(liveTimer);
        ENGINE_FAILED = e && e.message;
        
        var httpsHint = (location.protocol === 'https:') ? (S.lang === 'en' ? '<br>HTTPS page → local HTTP may be blocked. Tried both 127.0.0.1 and localhost.' : '<br>当前是 HTTPS 页面，访问本地 HTTP 可能被拦截；已自动尝试 127.0.0.1 与 localhost。') : '';
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'Cannot reach engine: ' + (e.message) + httpsHint + '<br>Run GomokuEngine.exe first.' : '连不上引擎：' + (e.message) + httpsHint + '<br>请先双击运行「GomokuEngine.exe」；如仍不行，检查浏览器是否拦截本机请求。') + '</span>');
        return;
      }
      clearTimeout(abt);
      liveGen++; clearInterval(liveTimer);   
      var wasDeep = deepMode; deepMode = false;   
      if (data.error) { setStatus('<span style="color:#c0392b;">' + data.error + '</span>'); return; }

      if (reqFp !== fp || reqOurIsBlack !== ourIsBlack) {
        lastEngineFp = null; lastEngineAt = 0;      
        setStatus('<span style="color:#3b7dd8;">' +
          (S.lang === 'en' ? 'Color changed — re-analyzing for the newly picked side…'
                           : '我执颜色已切换——正在按<b>新颜色</b>重新分析…') + '</span>');
        scheduleNext();
        return;
      }
      var elapsed = Date.now() - t0;
      if (!S.timeUsedGame) S.timeUsedGame = 0;
      S.timeUsedGame += elapsed;
      noteEngineForbid(data, fp);   
      S.candCache = data.candidates || [];
      
      var sideToMoveIsBlack = toMoveIsBlack;
      var myIsSideToMove = (sideToMoveIsBlack === ourIsBlack);
      var evStr = (data.candidates[0] && data.candidates[0].eval);
      var es = evalToScore(evStr, myIsSideToMove);
      var score = es.score, verdict = es.verdict, matePly = es.matePly;
      
      S.rawEval = (typeof evStr === 'string' && evStr.length) ? evStr.trim() : '';
      
      S.myEval = S.rawEval ? evalToMine(S.rawEval, myIsSideToMove) : '';
      
      if ((myColor0 === 1) !== (ourIsBlack === true)) {
        diag('color source mismatch: myColorCode=' + myColor0 + ' ourIsBlack=' + ourIsBlack +
             ' — 以 myColorCode()（面板同源）为准');
      }
      
      if (maxLineLen(board, oppColor0) >= 5) { score = -1000; verdict = 'lose'; matePly = 1; }
      else if (maxLineLen(board, myColor0) >= 5) { score = 1000; verdict = 'win'; matePly = 1; }
      
      S.score = score; S.verdict = verdict; S.matePly = matePly;
      try { save(); } catch (e) {}
      
      if (S.autoPlay && ourTurn && !haltForNewGame && Date.now() >= autoHaltUntil &&
          maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
        var renjuBlackWin = (S.rule === 2 && myColor0 === 1);   
        var winCells = allImmediateFiveCells(board, myColor0, renjuBlackWin);
        
        if (renjuBlackWin && winCells.length) {
          winCells = winCells.filter(function (wc) {
            return !isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0);
          });
        }
        if (winCells.length) {
          var winCell2 = null;
          
          if (data.best && data.best.length === 2) {
            for (var wb = 0; wb < winCells.length && !winCell2; wb++) {
              if (winCells[wb].i === data.best[0] && winCells[wb].j === data.best[1]) winCell2 = { i: data.best[0], j: data.best[1] };
            }
          }
          if (!winCell2) winCell2 = winCells[0];
          var fi2 = winCell2.i, fj2 = winCell2.j;
          if (board[fj2][fi2] !== 0) {
            
            pyBoardCache = null; cachedBoard = null; lastBoard = null; lastCount = 0; lastEngineFp = null;
            setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Win cell reads occupied — re-scanning board…' : '制胜格读数异常，强制重扫棋盘…') + '</span>');
            return;
          }
          if (playMove(cal, cv, fi2, fj2, toMoveIsBlack ? 1 : 2)) {
            S.candCache = data.candidates || [];
            renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
            lastEngineFp = fp;
            haltForNewGame = false;               
            setStatus(S.lang === 'en' ? 'Final move placed — win on board' : '已落制胜子，本局收官');
            drawChart();
            return;
          }
          
          return;
        }
      }
      
      if (matePly === 1) {
        
        if (verdict === 'win' && ourTurn && Date.now() >= autoHaltUntil &&
            maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
          var m1WinCells = allImmediateFiveCells(board, myColor0, (S.rule === 2 && myColor0 === 1));
          if (S.rule === 2 && myColor0 === 1 && m1WinCells.length) {
            m1WinCells = m1WinCells.filter(function (wc) {
              return !isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0);
            });
          }
          var m1Cell = null;
          
          if (data.best && data.best.length === 2) {
            for (var mw = 0; mw < m1WinCells.length && !m1Cell; mw++) {
              if (m1WinCells[mw].i === data.best[0] && m1WinCells[mw].j === data.best[1]) m1Cell = { i: data.best[0], j: data.best[1] };
            }
          }
          if (!m1Cell && m1WinCells.length) m1Cell = m1WinCells[0];
          if (m1Cell && board[m1Cell.j] && board[m1Cell.j][m1Cell.i] === 0 &&
              playMove(cal, cv, m1Cell.i, m1Cell.j, myColor0)) {
            S.candCache = data.candidates || [];
            renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
            lastEngineFp = fp;
            haltForNewGame = false; haltReason = '';   
            setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
              ? '+M1 locked — final move placed, five in a row (evaluation stopped)'
              : '已按 +M1 判定自动落下制胜子——<b>五子连珠</b>，本局收官（不再评估）') + '</span>');
            drawChart();
            return;
          }
        }
        S.candCache = data.candidates || [];
        renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
        lastEngineFp = fp;
        haltForNewGame = true;
        haltReason = 'm1';
        saveHistory();
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
          ? (verdict === 'win' ? 'I WIN (+M1) — stopped, waiting for next game…' : 'I LOSE (-M1) — stopped, waiting for next game…')
          : (verdict === 'win' ? '我方已胜（+M1）——已停止评估，等待下一局…' : '我方已败（-M1）——已停止评估，等待下一局…')) + '</span>');
        drawChart();
        return;
      }
      
      if (maxLineLen(board, oppColor0) >= 5 || maxLineLen(board, myColor0) >= 5) {
        S.candCache = data.candidates || [];
        renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
        lastEngineFp = fp;
        haltForNewGame = true;
        haltReason = (maxLineLen(board, myColor0) >= 5) ? 'five-my' : 'five-opp';
        setGameOverLock(haltReason);
        saveHistory();
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
          ? (maxLineLen(board, myColor0) >= 5 ? 'Five in a row — I WIN, waiting for next game…' : 'Five in a row — I LOSE, waiting for next game…')
          : (maxLineLen(board, myColor0) >= 5 ? '已五子连珠——我方获胜，等待下一局…' : '已五子连珠——我方落败，等待下一局…')) + '</span>');
        drawChart();
        return;
      }
      renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
      
      if (S.autoPlay && ourTurn && Date.now() >= autoHaltUntil) {
        var autoColor = toMoveIsBlack ? 1 : 2;
        
        var am = autoAnchorPick(board, data, S.candCache, autoColor,
                                { budgetMs: (typeof moveTurnMs === 'number') ? moveTurnMs : (S.turnMs || 5000) });
        if (am) {
          var bx = am[0], by = am[1];
          
          if (board[by][bx] !== 0) { var nb = nearestEmpty(board, bx, by); if (nb) { bx = nb.i; by = nb.j; } }
          if (bx >= 0 && by >= 0 && board[by][bx] === 0) playMove(cal, cv, bx, by, toMoveIsBlack ? 1 : 2);
        }
      }
      
      var _rcP = null;
      if ((S.heatmap || S.oppMoves) && !haltForNewGame && data.candidates && data.candidates.length) {
        var _mainC0 = S.candCache && S.candCache[0] ? S.candCache[0] : null;
        
        var bestAlign = (data.best && data.best.length === 2 && data.best[0] >= 0 && data.best[1] >= 0) ? data.best
          : (data.candidates[0] ? [data.candidates[0].x, data.candidates[0].y] : null);
        _rcP = refreshOverlayCands(cal, cv, board, fp, bestAlign, _mainC0);
      }
    } finally {
      S.analyzing = false;
      
      runOppEval();
      scheduleNext();
    }
  }

  function sideOfMyStone(color) { return (color === 1) ? 0 : 1; }   
  function sideOfOppStone(color) { return (color === 2) ? 0 : 1; }  
  function coordText(i, j) { return String.fromCharCode(65 + i) + (N - j); }
  
  function coordFor(cal, cv, i, j) {
    var frameWin = cal.frameWin || window, x, y;
    if (cal.isScreen) { x = cal.clientX0 + i * cal.stepX; y = cal.clientY0 + j * cal.stepY; }
    else {
      var topR = cal.topRect || cv.getBoundingClientRect();
      var scX = topR.width / cv.width, scY = topR.height / cv.height;
      var docR = cal.docRect || topR;
      x = docR.left + (cal.x0 + i * cal.stepX) * scX;
      y = docR.top + (cal.y0 + j * cal.stepY) * scY;
    }
    return { cal: cal, cv: cv, x: x, y: y, pageX: (frameWin.scrollX || 0) + x, pageY: (frameWin.scrollY || 0) + y, frameWin: frameWin, blocked: !!(cal.isScreen && cal.mode !== 'tab') };
  }
  
  function playMove(cal, cv, i, j, color) {
    var pt = coordFor(cal, cv, i, j);
    if (pt.blocked) { setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Board in another window - click the red dot manually' : '棋盘在其他窗口，请手动点击推荐的红点') + '</span>'); return false; }
    var atPoint = pt.frameWin.document.elementFromPoint(pt.x, pt.y);
    if (atPoint) {
      var pid = atPoint.id || '', pcls = (typeof atPoint.className === 'string') ? atPoint.className : '';
      if (pid === '__gb_adjbox' || pid === '__gb_panel' || pcls.indexOf('__gb_') === 0) {
        if (pid !== '__gb_adjbox') {
          
          var pan = document.getElementById('__gb_panel');
          if (pan) {
            var pr = pan.getBoundingClientRect();
            var iw = pt.frameWin.innerWidth || window.innerWidth;
            pan.style.left = (pt.x > iw / 2 ? 8 : Math.max(8, iw - pr.width - 8)) + 'px';
            pan.style.top = '8px';
          }
          atPoint = pt.frameWin.document.elementFromPoint(pt.x, pt.y);
          pid = atPoint ? (atPoint.id || '') : '';
          pcls = atPoint ? ((typeof atPoint.className === 'string') ? atPoint.className : '') : '';
        }
        if (pid === '__gb_adjbox' || pid === '__gb_panel' || pcls.indexOf('__gb_') === 0) { setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Point covered by panel - click the red dot manually' : '落子点被面板覆盖，自动落子已跳过——请手动点击推荐的红点') + '</span>'); return false; }
      }
    }
    panelClickFlag = true;
    syntheticClick(cal, cv, i, j, pt.x, pt.y, pt.pageX, pt.pageY, pt.frameWin);
    setTimeout(function () { panelClickFlag = false; }, 400);
    pendingClick = { cal: cal, cv: cv, i: i, j: j, color: color, pt: pt, since: Date.now(), retries: 0 };
    setStatus(S.lang === 'en' ? 'Auto-move ' + coordText(i, j) + '…' : '自动落子 ' + coordText(i, j) + '…');
    return true;
  }
  
  function redispatchPending(p) {
    panelClickFlag = true;
    syntheticClick(p.cal, p.cv, p.i, p.j, p.pt.x, p.pt.y, p.pt.pageX, p.pt.pageY, p.pt.frameWin);
    setTimeout(function () { panelClickFlag = false; }, 400);
  }
  
  function recentUserCell(cal, cv) {
    if (!lastUserClick || (Date.now() - lastUserClick.t) > 4000) return null;
    var topR = cal.topRect || cv.getBoundingClientRect();
    if (lastUserClick.x < topR.left - 2 || lastUserClick.x > topR.left + topR.width + 2 || lastUserClick.y < topR.top - 2 || lastUserClick.y > topR.top + topR.height + 2) return null;
    var ccx, ccy;
    if (cal.isScreen) { ccx = lastUserClick.x; ccy = lastUserClick.y; }
    else { var scX = topR.width / cv.width, scY = topR.height / cv.height; ccx = (lastUserClick.x - topR.left) / scX; ccy = (lastUserClick.y - topR.top) / scY; }
    var i = Math.round((ccx - cal.x0) / cal.stepX), j = Math.round((ccy - cal.y0) / cal.stepY);
    if (i < 0 || i >= N || j < 0 || j >= N) return null;
    return { i: i, j: j };
  }

  function pushHistPoint(ply, value) {
    var v = Math.max(-1000, Math.min(1000, value));
    var lastP = S.history.length ? S.history[S.history.length - 1] : null;
    if (lastP && lastP.i === ply) { lastP.v = v; return; }
    S.history.push({ i: ply, v: v });
    if (S.history.length > 400) S.history.shift();
  }
  function renderResult(cal, cv, cands, best, elapsed, score, verdict, fresh, board, myIsSideToMove) {
    drawOverlay(cal, cv, cands, best, board, myIsSideToMove);
    var c0 = cands[0];
    if (c0) {
      if (score == null) score = S.score || 0;
      if (verdict == null) verdict = S.verdict || 'none';
      if (fresh !== false && !haltForNewGame) {
        
        var rawEv = (typeof c0.eval === 'string') ? c0.eval.trim() : c0.eval;
        var plyNow = (S.moves && S.moves.length) ? S.moves.length : 0;   
        var esv = evalToScore(rawEv, myIsSideToMove);
        var pv = null;
        if (esv.valid) pv = esv.score;                    
        
        if (pv == null && S.matePly === 1) pv = (S.verdict === 'lose') ? -1000 : (S.verdict === 'win' ? 1000 : null);
        if (pv == null && verdict === 'win') pv = 1000;
        if (pv == null && verdict === 'lose') pv = -1000;
        if (pv != null) pushHistPoint(plyNow, pv);
        S.score = score; S.verdict = verdict;
        S.rawEval = (typeof rawEv === 'string' && rawEv.length) ? rawEv : '';
        S.myEval = S.rawEval ? evalToMine(S.rawEval, myIsSideToMove) : '';
        saveHistory();
      }
      var coord = String.fromCharCode(65 + c0.x) + (N - c0.y);
      
      var dispEv = (typeof S.myEval === 'string' && S.myEval.length) ? S.myEval
                 : ((typeof S.rawEval === 'string' && S.rawEval.length) ? S.rawEval : '-');
      var vColor;
      var vLabel;
      if (verdict === 'win') { vColor = '#3b7dd8'; vLabel = S.lang==='en'?'I WIN (M)':'我方必胜'; }
      else if (verdict === 'lose') { vColor = '#e74c3c'; vLabel = S.lang==='en'?'I LOSE (-M)':'我方必败'; }
      else if (score < -300) { vColor = '#e67e22'; vLabel = S.lang==='en'?'Bad':'大劣'; }
      else if (score > 300) { vColor = '#2e7d32'; vLabel = S.lang==='en'?'Good':'优势'; }
      else { vColor = '#7f8c8d'; vLabel = S.lang==='en'?'Even':'均势'; }
      
      var sideTxt = sideStatusText();
      var recLab = S.lang === 'en' ? 'Move' : '推荐';
      var evLab = S.lang === 'en' ? 'eval' : '评估';
      setStatus(
        recLab + ' <b style="color:#e53935">' + coord + '</b>　' + evLab + ' <b style="color:' + vColor + '">' + dispEv + '</b> <b style="color:' + vColor + '">(' + vLabel + ')</b>' + sideTxt
      );
      setStatPanel(c0, elapsed);
      S.lastStat = { c0: c0, elapsed: elapsed };
      drawChart();
    } else {
      setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'No recommendation (game may be over, or waiting for opponent).' : '未得到推荐（棋局可能已结束，或等待对手应手）') + '</span>');
    }
  }

  function viewportToScreenPhys(x, y) {
    var dpr = window.devicePixelRatio || 1;
    var chromeTop = window.outerHeight - window.innerHeight;
    var chromeLeft = Math.round((window.outerWidth - window.innerWidth) / 2);
    return [
      Math.round((window.screenX + chromeLeft + x) * dpr),
      Math.round((window.screenY + chromeTop + y) * dpr)
    ];
  }
  function pointBlockedByPanel(x, y) {
    var at = document.elementFromPoint(x, y);
    if (!at) return false;
    var id = at.id || '', cls = (typeof at.className === 'string') ? at.className : '';
    return id === '__gb_adjbox' || id === '__gb_panel' || cls.indexOf('__gb_') === 0;
  }
  async function doRealClick(x, y) {
    var sp = viewportToScreenPhys(x, y);
    try {
      var r = await fetch('http://127.0.0.1:8964/api/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: sp[0], y: sp[1] })
      });
      return !!r.ok;
    } catch (e) { return false; }
  }

  function syntheticClick(cal, cv, i, j, x, y, sx, sy, frameWin) {
    frameWin = frameWin || window;
    var common = {
      bubbles: true, cancelable: true, composed: true, view: frameWin,
      clientX: x, clientY: y, pageX: sx, pageY: sy,
      screenX: (frameWin.screenX || 0) + x, screenY: (frameWin.screenY || 0) + y,
      button: 0, buttons: 1
    };
    var atPoint = frameWin.document.elementFromPoint(x, y);
    
    if (atPoint) {
      var apId = atPoint.id || '';
      var apCls = (typeof atPoint.className === 'string') ? atPoint.className : '';
      if (apId === '__gb_adjbox' || apId === '__gb_panel' || apCls.indexOf('__gb_') === 0) {
        setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Move point covered by panel - click the red dot manually' : '落子点被面板覆盖，自动落子已跳过——请手动点击推荐的红点') + '</span>');
        return;
      }
    }
    var target = (atPoint && atPoint !== document.documentElement) ? atPoint : cv;
    if (window.TouchEvent && window.Touch && typeof Touch === 'function') {
      try {
        var tch = new Touch({ identifier: 1, target: target, clientX: x, clientY: y, pageX: sx, pageY: sy });
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, composed: true, view: window, touches: [tch], targetTouches: [tch], changedTouches: [tch] }));
        target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, composed: true, view: window, touches: [], targetTouches: [], changedTouches: [tch] }));
      } catch (e) {}
    }
    if (window.PointerEvent) {
      var ptr = Object.assign({}, common, { pointerId: 1, pointerType: 'touch', isPrimary: true, pointercapture: true });
      target.dispatchEvent(new PointerEvent('pointerdown', ptr));
      target.dispatchEvent(new PointerEvent('pointerup', ptr));
    }
    target.dispatchEvent(new MouseEvent('mousedown', common));
    target.dispatchEvent(new MouseEvent('mouseup', common));
    target.dispatchEvent(new MouseEvent('click', common));
    if (target !== cv) {
      cv.dispatchEvent(new MouseEvent('click', common));
      if (window.PointerEvent) {
        var ptr2 = Object.assign({}, common, { pointerId: 2, pointerType: 'mouse', isPrimary: true });
        cv.dispatchEvent(new PointerEvent('pointerdown', ptr2));
        cv.dispatchEvent(new PointerEvent('pointerup', ptr2));
      }
    }
  }

document.getElementById('__gb_analyze').onclick = function () {
    
    lastEngineFp = null; lastEngineAt = 0;
    setStatus(S.lang === 'en' ? 'Re-analyzing current board…' : '正在重新分析当前局面…');
    scheduleNext();
  };
  document.getElementById('__gb_deep').onclick = function () {
    
    if (deepMode) {
      deepMode = false;
      lastEngineFp = null; lastEngineAt = 0;
      setStatus(S.lang === 'en' ? '<span style="color:#888;">Deep analyze cancelled — back to normal mode.</span>' : '<span style="color:#888;">已取消深算，恢复常规分析。</span>');
      scheduleNext();
      return;
    }
    deepMode = true;
    lastEngineFp = null; lastEngineAt = 0;
    setStatus(S.lang === 'en' ? '<span style="color:#A5B4FC;">Deep analyzing current board (≈30s)…</span>' : '<span style="color:#A5B4FC;">深度计算当前局面（约30秒）…</span>');
    scheduleNext();
  };
  document.getElementById('__gb_rec').onclick = function () {
    
    cachedBoard = null; pyBoardCache = null; screenBoard = null; lastScreenTry = 0; screenDenied = false; screenAutoOff = false; screenFails = 0; lastEngineFp = null; lastEngineAt = 0;
    S.userSide = -1; pendingClick = null; probeOpen = null; sideConflictCount = 0; sideLockUntil = 0;
    sideVote = { color: -1, n: 0 };
    try { save(); } catch (e) {}
    if (typeof paintSideBtns === 'function') paintSideBtns();
    setStatus('<span style="color:#3b7dd8;">' + (S.lang === 'en' ? 'Re-scan: re-detecting board (your manual color is kept)…' : '重新识别：重扫棋盘（<b>已保留</b>你手动选择的先后手）…') + '</span>');
    scheduleNext();
  };
  document.getElementById('__gb_adjust').onclick = startAdjust;

  function scheduleNext() {
    clearTimeout(window.__gbTo);
    window.__gbTo = setTimeout(analyze, 300);
  }
  
  function onLayoutChange() {
    if (adjustMode) return;
    cachedBoard = null; pyBoardCache = null; screenBoard = null; lastBoard = null; lastCount = 0;
    scheduleNext();
  }
  window.addEventListener('scroll', onLayoutChange, true);
  window.addEventListener('resize', onLayoutChange);
  
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && window.__gbPanel) {
      cachedBoard = null; pyBoardCache = null; screenBoard = null; lastBoard = null; lastCount = 0;
      scheduleNext();
    }
  });
  loadHistory();            
  drawChart();
  applyHash();
  setStatus(S.lang === 'en' ? 'Ready · waiting for board changes' : '已就绪 · 等待棋盘变化自动分析');
  scheduleNext();
})();
