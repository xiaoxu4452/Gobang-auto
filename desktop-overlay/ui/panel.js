/* Panel logic. */


'use strict';

var N = 15;                      
var CHART_FIT = 15;              

var S = {
  lang: 'zh',
  rule: 0,
  mySide: 1,                     
  autoPlay: false,               
  heat: false,
  opp: false,
  dark: false,
  turnSec: 5,
  matchSec: 6000,
  hashMB: 256,
  history: [],                   
  lastStat: null,
  status: '正在连接…',
  scan: { found: false, black: 0, white: 0, suspect: false, ms: 0 },
  best: null
};

var I18N = {
  zh: {
    title: '五子棋助手', think: '思考时间 / 比赛时间', turn: '思考时间(秒)', match: '比赛时间(秒)',
    hash: '哈希', rule: '规则', rule0: '无禁手', rule1: '有禁手', rule2: '连珠规则',
    iplay: '我执', auto: '自动', manual: '重新识别', opacity: '透明度', blur: '模糊', dark: '深色',
    heat: '热力图', oppMoves: '对手预测', heatBest: '最佳', heatGood: '良好', heatMid: '一般', heatLow: '劣势',
    connecting: '正在连接…', reidentify: '重新识别', analyze: '分析', deep: '深算'
  },
  en: {
    title: 'Gomoku Assistant', think: 'Think / Match time', turn: 'Think (s)', match: 'Match (s)',
    hash: 'Hash', rule: 'Rule', rule0: 'Free', rule1: 'Renju', rule2: 'Pro',
    iplay: 'I play', auto: 'Auto', manual: 'Rescan', opacity: 'Opacity', blur: 'Blur', dark: 'Dark',
    heat: 'Heatmap', oppMoves: 'Opponent', heatBest: 'Best', heatGood: 'Good', heatMid: 'Fair', heatLow: 'Poor',
    connecting: 'Connecting…', reidentify: 'Rescan', analyze: 'Analyze', deep: 'Deep'
  }
};
function T(k) { return (I18N[S.lang] && I18N[S.lang][k]) || k; }
function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var k = el.getAttribute('data-i18n');
    if (T(k)) el.textContent = T(k);
  });
  applyTips();
}

var TIPS = {
  '__gb_autodrop': { zh: '自动落子：盯住推荐第一点，盘面刷新后自动点击落子（双管线送点击，物理鼠标不动）', en: 'Auto-drop: watch the recommended point and click it automatically when the board refreshes (dual-pipeline click, mouse stays still)' },
  '__gb_adcount': { zh: '落子次数：每个落点连点几下（1~3 循环），点一下切换，所有状态同步', en: 'Click count: clicks per move (1-3 loop); click to switch, all states sync' },
  '__gb_swbal': { zh: '交换平衡点：空盘摆出 1 白 + 2 黑三个平衡点（浅蓝=白、浅紫=黑）；已有棋子给一对（1 白 + 1 黑）。配合自动落子可自动摆完', en: 'Swap balance: empty board shows 3 balanced points (1 white + 2 black; light blue=white, light purple=black); with stones, one pair (1 white + 1 black). Works with auto-drop' },
  '__gb_sweval': { zh: '交换评估：按引擎对当前局面的评估，在状态栏提醒选黑还是选白交换更有优势（点击一次评估一次）', en: 'Swap evaluate: engine evaluates the current position and tells you which side (black/white) is better to swap (one click = one evaluation)' },
  '__gb_side_black': { zh: '我执黑子', en: 'I play black' },
  '__gb_side_white': { zh: '我执白子', en: 'I play white' },
  '__gb_pos': { zh: '打开局面窗口（识别出来的棋盘 + 局面代码）', en: 'Open position window (recognized board + position code)' },
  '__gb_possave': { zh: '保存局面（把识别到的棋盘渲染成 PNG 图片）', en: 'Save position (render the recognized board as PNG)' },
  '__gb_deep': { zh: '30s 深度计算（对标 gomocalc 手动深算）', en: '30s deep calculation (like gomocalc manual deep search)' },
  '__gb_bal1': { zh: '官方平衡一手：引擎迭代出最平衡的落点（三手交换 / 打点决策参考）', en: 'Official balanced move: engine iterates the most balanced point (swap3 / opening reference)' },
  '__gb_bal2': { zh: '官方平衡两手：五手两打的一对平衡点', en: 'Official balanced pair: two balanced points for swap2' },
  '__gb_grip': { zh: '按住上下拖动可调节面板高度', en: 'Drag up/down to resize panel height' }
};
function applyTips() {
  var lang = S.lang;
  for (var id in TIPS) {
    var el = document.getElementById(id);
    if (el && TIPS[id][lang]) el.title = TIPS[id][lang];
  }
  var legend = document.querySelectorAll('#__gb_legend i');
  var LZ = { zh: ['最佳', '较优', '一般', '较弱'], en: ['Best', 'Good', 'Fair', 'Poor'] };
  var lz = LZ[S.lang] || LZ.zh;
  if (legend.length === 4) for (var i = 0; i < 4; i++) legend[i].title = lz[i];
}

var host = (window.chrome && window.chrome.webview) ? window.chrome.webview : null;

function send(msg) {
  if (host) { try { host.postMessage(msg); } catch (e) {} }
  else if (window.external && window.external.notify) {           
    try { window.external.notify(JSON.stringify(msg)); } catch (e) {}
  }
  if (window.__DEBUG_NOHOST) console.log('[send]', msg);
}

function bind() {
  document.getElementById('close').onclick = function () { send({ cmd: 'close' }); };
  document.getElementById('min').onclick = function () {
    document.body.classList.toggle('collapsed');
    send({ cmd: 'collapse', value: document.body.classList.contains('collapsed') });
  };

  document.getElementById('lang').onclick = function () {
    S.lang = (S.lang === 'zh') ? 'en' : 'zh';
    applyLang(); renderStatus(); drawChart();
  };

  document.querySelectorAll('.step').forEach(function (b) {
    b.onclick = function () {
      var d = b.getAttribute('data-dir');
      if (d === 'turn-') S.turnSec = Math.max(1, S.turnSec - (S.turnSec > 20 ? 5 : 1));
      if (d === 'turn+') S.turnSec = Math.min(120, S.turnSec + (S.turnSec >= 20 ? 5 : 1));
      if (d === 'match-') S.matchSec = Math.max(30, S.matchSec - 10);
      if (d === 'match+') S.matchSec = Math.min(9999, S.matchSec + 10);
      if (d === 'hash-') S.hashMB = Math.max(64, S.hashMB / 2);
      if (d === 'hash+') S.hashMB = Math.min(2048, S.hashMB * 2);
      syncSettings(); send({ cmd: 'settings', s: settings() });
    };
  });
  ['turnval', 'matchval'].forEach(function (id) {
    document.getElementById(id).onchange = function () {
      var v = parseInt(this.value, 10);
      if (id === 'turnval') S.turnSec = Math.max(1, Math.min(120, v || 5));
      else S.matchSec = Math.max(30, Math.min(9999, v || 6000));
      syncSettings(); send({ cmd: 'settings', s: settings() });
    };
  });

  document.querySelectorAll('.opt').forEach(function (o) {
    o.onclick = function () {
      S.rule = parseInt(o.getAttribute('data-rule'), 10);
      syncSettings(); send({ cmd: 'settings', s: settings() });
    };
  });

  document.getElementById('side_black').onclick = function () { S.mySide = 1; syncSettings(); send({ cmd: 'settings', s: settings() }); };
  document.getElementById('side_white').onclick = function () { S.mySide = 2; syncSettings(); send({ cmd: 'settings', s: settings() }); };

  document.getElementById('auto').onclick = function () {
    S.autoPlay = !S.autoPlay; syncSettings();
    send({ cmd: 'settings', s: settings() });
  };

  document.getElementById('rescan').onclick = function () { send({ cmd: 'rescan' }); };
  document.getElementById('rec').onclick = function () { send({ cmd: 'rescan' }); };
  document.getElementById('analyze').onclick = function () { send({ cmd: 'analyze' }); };
  document.getElementById('deep').onclick = function () { send({ cmd: 'analyze', deep: true }); };

  document.getElementById('opacity').onclick = function () {
    document.getElementById('opacity_pop').classList.toggle('show');
  };
  var opR = document.getElementById('opacity_range'), opN = document.getElementById('opacity_num');
  opR.oninput = function () { opN.value = opR.value; send({ cmd: 'opacity', value: +opR.value }); };
  opN.onchange = function () { opR.value = opN.value; send({ cmd: 'opacity', value: +opN.value }); };
  var blR = document.getElementById('blur_range'), blN = document.getElementById('blur_num');
  blR.oninput = function () { blN.value = blR.value; send({ cmd: 'blur', value: +blR.value }); };
  blN.onchange = function () { blR.value = blN.value; send({ cmd: 'blur', value: +blN.value }); };

  document.getElementById('dark').onclick = function () {
    S.dark = !S.dark;
    document.body.classList.toggle('dark', S.dark);
    drawChart();
    send({ cmd: 'dark', value: S.dark });
  };
  document.getElementById('heat').onclick = function () {
    S.heat = !S.heat;
    this.classList.toggle('on', S.heat);
    document.getElementById('legend').classList.toggle('show', S.heat);
    send({ cmd: 'settings', s: settings() });
  };
  document.getElementById('opp').onclick = function () {
    S.opp = !S.opp;
    this.classList.toggle('on', S.opp);
    send({ cmd: 'settings', s: settings() });
  };
}

function settings() {
  return {
    rule: S.rule, mySide: S.mySide, autoPlay: S.autoPlay, heat: S.heat, opp: S.opp,
    turnSec: S.turnSec, matchSec: S.matchSec, hashMB: S.hashMB, lang: S.lang
  };
}

function syncSettings() {
  document.getElementById('turnval').value = S.turnSec;
  document.getElementById('matchval').value = S.matchSec;
  document.getElementById('hashval').textContent = S.hashMB + ' MB';
  document.querySelectorAll('.opt').forEach(function (o) {
    o.classList.toggle('on', parseInt(o.getAttribute('data-rule'), 10) === S.rule);
  });
  document.getElementById('side_black').classList.toggle('on', S.mySide === 1);
  document.getElementById('side_white').classList.toggle('on', S.mySide === 2);
  var a = document.getElementById('auto');
  a.classList.toggle('on', S.autoPlay);
  a.textContent = T('auto');
  document.getElementById('side_txt').textContent = '';
}

function renderStatus() {
  var el = document.getElementById('status');
  var sc = S.scan || {};
  var head;
  if (!sc.found) head = (S.lang === 'en' ? 'No board detected' : '未识别到棋盘');
  else head = (S.lang === 'en' ? 'Board ' : '棋盘 ') + (sc.black || 0) + '/' + (sc.white || 0) +
              (sc.suspect ? (S.lang === 'en' ? ' (uncertain)' : '（存疑）') : '');
  var ms = sc.ms ? (' · ' + sc.ms + 'ms') : '';
  el.innerHTML = '<div>' + head + ms + '</div><div>' + (S.status || '') + '</div>';
}

function fmtKMG(v) {
  v = Number(v) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}
function coordOf(p) { return String.fromCharCode(65 + p[0]) + (N - p[1]); }
function setStat(c0) {
  if (!c0) return;
  S.lastStat = c0;
  var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
  set('st_depth', c0.depth ? c0.depth : '-');
  set('st_eval', (typeof c0.eval === 'string' && c0.eval.length) ? c0.eval : '-');
  set('st_speed', c0.speed ? fmtKMG(c0.speed) : '-');
  set('st_nodes', c0.nodes ? fmtKMG(c0.nodes) : '-');
  var lineEl = document.getElementById('st_line');
  if (lineEl) {
    lineEl.textContent = (c0.line && c0.line.length)
      ? ((S.lang === 'en' ? 'PV ' : '路线 ') + c0.line.slice(0, 14).map(coordOf).join(' '))
      : '';
  }
}

function drawChart() {
  var cv = document.getElementById('chart');
  if (!cv) return;
  var ctx = cv.getContext('2d');
  var H = 100, padL = 4, padR = 4, padT = 5, padB = 8;
  var csc = document.getElementById('chart_scroll');
  var viewW = (csc && csc.clientWidth) ? csc.clientWidth : 0;
  if (viewW < 80) viewW = 195;
  var pts = S.history, n = pts.length;
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

  var ya = document.getElementById('yaxis');
  if (ya) {
    ya.innerHTML = '';
    for (var g2 = -1000; g2 <= 1000; g2 += 250) {
      var sp = document.createElement('span');
      sp.textContent = (g2 > 0 ? '+' : '') + g2;
      sp.style.cssText = 'position:absolute;right:2px;font-size:' + (g2 % 500 === 0 ? 8 : 7) + 'px;color:' + labelCol +
        ';line-height:1px;transform:translateY(-50%);' + (g2 % 500 !== 0 && g2 !== 0 ? 'opacity:.5;' : '');
      sp.style.top = yOf(g2) + 'px';
      ya.appendChild(sp);
    }
  }

  if (n < 1) {
    ctx.fillStyle = S.dark ? '#8a90a0' : '#9aa5b1'; ctx.font = '10px sans-serif';
    ctx.fillText(S.lang === 'en' ? 'Eval curve' : '评估曲线', padL + 6, midY + 3);
    return;
  }

  var px = function (k) { return (n <= 1) ? (padL + innerW0 / 2) : (padL + k * step); };
  var curV = Math.max(-1000, Math.min(1000, pts[n - 1].v));
  var lineColor = curV < 0 ? '#f1c40f' : '#3b7dd8';
  var fillColor = curV < 0 ? 'rgba(241,196,15,.22)' : 'rgba(59,125,216,.14)';

  function tracePath() {
    ctx.beginPath();
    ctx.moveTo(px(0), yOf(pts[0].v));
    if (n === 2) { ctx.lineTo(px(1), yOf(pts[1].v)); return; }
    if (n < 3) return;
    for (var i = 0; i < n - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)].v, p1 = pts[i].v, p2 = pts[i + 1].v, p3 = pts[Math.min(n - 1, i + 2)].v;
      var x1 = px(i), y1 = yOf(p1), x2 = px(i + 1), y2 = yOf(p2);
      var c1x = x1 + (px(Math.min(n - 1, i + 1)) - px(Math.max(0, i - 1))) / 6;
      var c1y = y1 + (yOf(p2) - yOf(p0)) / 6;
      var c2x = x2 - (px(Math.min(n - 1, i + 2)) - px(i)) / 6;
      var c2y = y2 - (yOf(p3) - yOf(p1)) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2);
    }
  }
  tracePath();
  if (n >= 2) { ctx.lineTo(px(n - 1), yOf(0)); ctx.lineTo(px(0), yOf(0)); ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill(); }
  tracePath();
  if (n >= 2) { ctx.strokeStyle = lineColor; ctx.lineWidth = 1.8; ctx.stroke(); }
  ctx.fillStyle = lineColor;
  for (var i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(px(i), yOf(pts[i].v), 2.6, 0, 7); ctx.fill(); }
  if (csc) csc.scrollLeft = csc.scrollWidth;
}

function applyState(st) {
  if (!st) return;
  if (st.scan) { S.scan = st.scan; }
  if (typeof st.status === 'string') S.status = st.status;
  if (st.stats) setStat(st.stats);
  if (st.history) S.history = st.history;
  if (st.best !== undefined) S.best = st.best;
  renderStatus();
  drawChart();
}

window.addEventListener('resize', drawChart);

(function init() {
  bind(); applyLang(); syncSettings(); renderStatus(); drawChart();
  if (host) {
    host.addEventListener('message', function (e) {
      try { applyState(e.data); } catch (err) {}
    });
  }
  send({ cmd: 'ready' });
})();
