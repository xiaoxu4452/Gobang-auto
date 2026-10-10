/* Overlay logic. */


(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var svg = $('marks');
  var gScreen = $('g-screen'), gBoard = $('g-board'), gHint = $('g-hint');
  var SVGNS = 'http://www.w3.org/2000/svg';

  var S = {
    offset: { x: 0, y: 0 },     
    board: null,                
    best: null,                 
    stones: { b: 0, w: 0 },
    eval: null,
    turn: null,
    suspect: false,
    hz: 700,
    showScreen: true,
    showBoardMark: true
  };

  function el(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clear(g) { while (g.firstChild) g.removeChild(g.firstChild); }

  function wx(x) { return x - S.offset.x; }
  function wy(y) { return y - S.offset.y; }

  function corner(g, cls, x, y, dx, dy, len) {
    g.appendChild(el('path', {
      'class': cls,
      d: 'M ' + x + ' ' + (y + dy * len) + ' L ' + x + ' ' + y + ' L ' + (x + dx * len) + ' ' + y
    }));
  }

  function drawScreenFrame() {
    clear(gScreen);
    if (!S.showScreen) return;
    var W = window.innerWidth, H = window.innerHeight;
    var m = 10, len = 46;
    corner(gScreen, 'L', m, m, 1, 1, len);
    corner(gScreen, 'L', W - m, m, -1, 1, len);
    corner(gScreen, 'L', m, H - m, 1, -1, len);
    corner(gScreen, 'L', W - m, H - m, -1, -1, len);
    
    var edges = [
      [m + len, m, W - m - len, m],
      [m + len, H - m, W - m - len, H - m],
      [m, m + len, m, H - m - len],
      [W - m, m + len, W - m, H - m - len]
    ];
    edges.forEach(function (e) {
      gScreen.appendChild(el('line', { 'class': 'link', x1: e[0], y1: e[1], x2: e[2], y2: e[3] }));
    });
  }

  function drawBoardFrame() {
    clear(gBoard);
    clear(gHint);
    if (!S.showBoardMark || !S.board) return;
    var x0 = wx(S.board.x), y0 = wy(S.board.y);
    var x1 = wx(S.board.x + S.board.w), y1 = wy(S.board.y + S.board.h);
    var len = Math.max(16, Math.min(S.board.w, S.board.h) * 0.16);
    corner(gBoard, 'L', x0, y0, 1, 1, len);
    corner(gBoard, 'L', x1, y0, -1, 1, len);
    corner(gBoard, 'L', x0, y1, 1, -1, len);
    corner(gBoard, 'L', x1, y1, -1, -1, len);
    [[x0 + len, y0, x1 - len, y0], [x0 + len, y1, x1 - len, y1],
     [x0, y0 + len, x0, y1 - len], [x1, y0 + len, x1, y1 - len]].forEach(function (e) {
      gBoard.appendChild(el('line', { 'class': 'link', x1: e[0], y1: e[1], x2: e[2], y2: e[3] }));
    });
    drawBest();
  }

  function drawBest() {
    if (!S.best || !S.board) return;
    var geo = S.geo;
    if (!geo) return;
    var px = wx(geo.x_lines[S.best.x]), py = wy(geo.y_lines[S.best.y]);
    var r = Math.max(9, (S.board.w / 15) * 0.34);
    gHint.appendChild(el('circle', { 'class': 'bestbg', cx: px, cy: py, r: r }));
    gHint.appendChild(el('circle', { 'class': 'best', cx: px, cy: py, r: r }));
    var t = el('text', { 'class': 'txt', x: px, y: py });
    t.textContent = coordName(S.best.x, S.best.y);
    gHint.appendChild(t);
  }

  function coordName(x, y) { return String.fromCharCode(65 + x) + (15 - y); }

  function setText(id, v) { var e = $(id); if (e) e.textContent = v; }

  function renderPanel(st) {
    var dot = $('dot');
    if (!st || !st.found) { dot.className = 'dot warn'; setText('v-state', S.suspect ? '识别存疑' : '未找到棋盘'); }
    else { dot.className = 'dot on'; setText('v-state', '已锁定棋盘'); }
    setText('v-count', '黑 ' + S.stones.b + ' · 白 ' + S.stones.w);
    setText('v-turn', S.turn === 1 ? '黑方' : (S.turn === 2 ? '白方' : '—'));
    setText('v-eval', S.eval == null ? '—' : (S.eval > 0 ? '+' : '') + S.eval);
    setText('v-best', S.best ? coordName(S.best.x, S.best.y) : '—');
    drawCurve();
  }

  var hist = [];
  function drawCurve() {
    var c = $('curve'), ctx = c.getContext('2d');
    var w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    if (hist.length < 2) return;
    var pts = hist.slice(-15);
    var maxAbs = Math.max(60, Math.max.apply(null, pts.map(function (v) { return Math.abs(v); })));
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 1.6; ctx.beginPath();
    pts.forEach(function (v, i) {
      var x = pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * (w - 6) + 3;
      var y = h / 2 - (v / maxAbs) * (h / 2 - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function applyState(st) {
    if (!st) return;
    if (st.offset) S.offset = st.offset;
    S.board = st.board_rect || null;
    S.geo = st.geometry || null;
    S.best = st.best || null;
    S.suspect = !!st.suspect;
    S.stones.b = (st.black || []).length;
    S.stones.w = (st.white || []).length;
    if (S.stones.b || S.stones.w) {
      var same = S.stones.b === S.stones.w;
      S.turn = same ? 1 : (S.stones.b > S.stones.w ? 2 : 1);
    }
    if (typeof st.eval === 'number') {
      S.eval = st.eval;
      if (hist.length === 0 || hist[hist.length - 1] !== st.eval) {
        hist.push(st.eval);
        if (hist.length > 60) hist.shift();
      }
    }
    drawBoardFrame();
    renderPanel(st);
  }

  var panel = $('panel');
  function inPanel(x, y) {
    var r = panel.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  window.addEventListener('mousemove', function (e) {
    if (window.overlayAPI && window.overlayAPI.setMouse) {
      window.overlayAPI.setMouse(inPanel(e.clientX, e.clientY));
    }
  });

  $('btn-close').onclick = function () { if (window.overlayAPI) window.overlayAPI.close(); };
  $('btn-min').onclick = function () {
    var b = $('body'); b.className = b.className === 'fold' ? '' : 'fold';
  };
  ['side-b', 'side-w', 'side-auto'].forEach(function (id) {
    $(id).onclick = function () {
      ['side-b', 'side-w', 'side-auto'].forEach(function (o) { $(o).className = 'seg'; });
      this.className = 'seg on';
      if (window.overlayAPI) window.overlayAPI.setSide(this.getAttribute('data-side') || 'auto');
    };
  });
  $('opt-auto').onchange = function () {
    if (window.overlayAPI) window.overlayAPI.setAuto(this.checked);
  };
  $('opt-mark').onchange = function () { S.showScreen = this.checked; drawScreenFrame(); };
  $('opt-board').onchange = function () { S.showBoardMark = this.checked; drawBoardFrame(); };
  $('opt-hz').onchange = function () {
    S.hz = parseInt(this.value, 10);
    if (window.overlayAPI) window.overlayAPI.setHz(S.hz);
  };

  window.addEventListener('resize', function () { drawScreenFrame(); drawBoardFrame(); });
  drawScreenFrame();

  window.__applyState = applyState;
  if (window.overlayAPI && window.overlayAPI.onState) {
    window.overlayAPI.onState(applyState);
  } else if (!window.overlayAPI) {
    setInterval(function () {
      fetch('http://127.0.0.1:8971/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).then(function (r) { return r.json(); }).then(applyState).catch(function () {});
    }, 900);
  }
})();
