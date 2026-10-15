/* Meter Gomoku Trainer - in-page AI engine worker. Loads the native rapfi multi-thread build via importScripts and serves search/evaluation lanes to the overlay UI through a Worker message bridge. */


'use strict';

var SIZE = 15;

var AI_BASE = (function () {
  try { return new URL('/ai/', self.location.origin).href; }
  catch (e) { return '/ai/'; }
})();

var NATIVE = { probed: false, ok: false, variant: '', cpus: 0, engCPUs: 0, memMB: 0 };

var GB_NO_WASM = true;   
function probeNative() {
  if (NATIVE.probed) return Promise.resolve(NATIVE.ok);
  NATIVE.probed = true;
  return fetch('/engine/status', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      NATIVE.ok = !!(j && j.available);
      NATIVE.variant = (j && j.variant) || '';
      NATIVE.cpus = (j && j.cpus) | 0;
      
      NATIVE.engCPUs = (j && j.engineCPUs) | 0;
      NATIVE.memMB = (j && j.memMB) | 0;
      return NATIVE.ok;
    })
    .catch(function () { return false; });   
}

var RELAY = false;
var relaySeq = 0;
function relayPost(op, lane, cmds) {
  self.postMessage({ type: '__host', payload: { type: 'engine', op: op, lane: lane.name,
    cmds: cmds || [], id: ++relaySeq } });
}
function nativeCmd(lane, cmd) {
  if (RELAY) { relayPost('cmd', lane, String(cmd).split('\n')); return; }
  try {
    fetch('/engine/cmd?lane=' + encodeURIComponent(lane.name), { method: 'POST', body: cmd })
      .catch(function () {});
  } catch (e) {}
}

function makeNativeEngine(lane) {
  var cursor = 0, stopped = false, inFlight = 0, resets = 0, sawAlive = false;
  function feed(ls, alive) {
    for (var i = 0; i < ls.length; i++) {
      if (lane.captureLine) { try { if (lane.captureLine(ls[i]) === true) continue; } catch (e) {} }
      lane.outBuf += ls[i] + '\n';
    }
    if (alive === true) sawAlive = true;
    
    if (alive === false && sawAlive && resets < 3) {
      resets++; cursor = 0;
      if (RELAY) relayPost('ensure', lane, []);
      else try {
        fetch('/engine/ensure?lane=' + encodeURIComponent(lane.name), { method: 'POST', body: '' })
          .catch(function () {});
      } catch (e) {}
    }
  }
  function pump() {
    if (stopped || RELAY) return;      
    if (inFlight > 0) { setTimeout(pump, 6); return; }   
    inFlight++;
    fetch('/engine/out?lane=' + encodeURIComponent(lane.name) + '&since=' + cursor, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        inFlight--;
        cursor = j.seq;
        feed(j.lines || [], j.alive);
        setTimeout(pump, 15);
      })
      .catch(function () { inFlight--; setTimeout(pump, 250); });
  }
  pump();
  return {
    sendCommand: function (cmd) { if (!stopped) nativeCmd(lane, cmd); },
    terminate: function () { stopped = true; },
    __native: true,
    __feed: feed,          
  };
}

function makeLane(name) {
  return {
    name: name, engine: null, outBuf: '', captureLine: null,
    liveState: null, ready: false, waiters: [], tail: Promise.resolve(),
    bootOk: false,
  };
}
var LANES = { main: makeLane('main'), sub: makeLane('sub'), fwd: makeLane('fwd') };

function pickLane(name) { return (name === 'sub') ? LANES.sub : (name === 'fwd') ? LANES.fwd : LANES.main; }

var CFG = { threads: 0, hashKB: 0 };   
function hardwareThreads() {
  
  if (NATIVE.ok && NATIVE.cpus > 0) return NATIVE.cpus;
  var n = (navigator.hardwareConcurrency || 4) | 0;
  return Math.max(2, n || 4);
}
function totalMemKB() {
  
  if (NATIVE.ok && NATIVE.memMB > 0) return NATIVE.memMB * 1024;
  var gb = (navigator.deviceMemory || 8) | 0;
  if (gb < 2) gb = 2;
  return gb * 1024 * 1024;
}

function engineCoreBudget() {
  var all = hardwareThreads();
  if (NATIVE.ok && NATIVE.engCPUs > 0) return Math.max(2, Math.min(all, NATIVE.engCPUs));
  return all;
}

function fullCoreThreads() {
  
  var cpuAll = engineCoreBudget();
  return CFG.threads > 0 ? Math.max(2, Math.min(CFG.threads, cpuAll))
                         : Math.max(2, cpuAll);
}

function laneBusyT(lane) {
  return (lane && lane.liveState && lane.liveState.searching) ? Math.max(1, lane.curThreads || 1) : 0;
}

function planLaneThreads(lane) {
  if (!NATIVE.ok) return lane.bootThreads || 0;
  var all = [LANES.main, LANES.sub, LANES.fwd], busy = 0;
  for (var i = 0; i < all.length; i++) if (all[i] !== lane) busy += laneBusyT(all[i]);
  return Math.max(1, engineCoreBudget() - busy);
}

var HASH_FLOOR_KB = 65536;

var hashOwner = 'main';

var HASH_CLAIM_MIN_MS = 2000;

function hashBudgetKB() {
  // Shared large partition TT: effective hash = user choice x2 (one extra silent
  // table), floored at 128MB per engine thread so every core searches with room.
  var hashCapKB = NATIVE.ok ? 6291456 : 2097152;
  var hashDiv = NATIVE.ok ? 4 : 3;
  var cores = Math.max(1, (CFG.threads > 0 ? CFG.threads : engineCoreBudget()));
  var want = CFG.hashKB > 0 ? Math.max(65536, Math.min(hashCapKB, Math.max(CFG.hashKB * 2, cores * 131072)))
                            : Math.max(262144, Math.min(hashCapKB, Math.floor(totalMemKB() / hashDiv)));
  
  var ramCapKB = Math.max(262144, Math.floor(totalMemKB() / 3));
  return Math.min(want, ramCapKB);
}

function claimHash(lane) {
  var pre = [];
  var full = hashBudgetKB();
  hashOwner = lane.name;
  if (lane.curHashKB !== full) {
    lane.curHashKB = full;
    pre.push('INFO HASH_SIZE ' + full);
  }
  
  var all = [LANES.main, LANES.sub, LANES.fwd];
  for (var i = 0; i < all.length; i++) {
    var o = all[i];
    if (o === lane || !o.engine || !o.bootOk) continue;
    if (o.curHashKB === HASH_FLOOR_KB) continue;
    if (o.liveState && o.liveState.searching) continue;
    o.curHashKB = HASH_FLOOR_KB;
    try { o.engine.sendCommand('INFO HASH_SIZE ' + HASH_FLOOR_KB); } catch (e) {}
  }
  return pre;
}

function applyHashBudget() {
  var full = hashBudgetKB();
  var all = [LANES.main, LANES.sub, LANES.fwd];
  for (var i = 0; i < all.length; i++) {
    var o = all[i];
    if (!o.engine || !o.bootOk) continue;
    var want = (o.name === hashOwner) ? full : HASH_FLOOR_KB;
    if (o.curHashKB === want) continue;
    o.curHashKB = want;
    try { o.engine.sendCommand('INFO HASH_SIZE ' + want); } catch (e) {}
  }
}

function laneSpecs() {
  
  var cpuAll = engineCoreBudget();
  
  var mainT = CFG.threads > 0 ? Math.max(2, Math.min(CFG.threads, cpuAll))
                              : Math.max(2, cpuAll);
  
  return [
    { lane: LANES.main, threads: mainT, hashKB: hashBudgetKB() },
    { lane: LANES.sub,  threads: 1,     hashKB: HASH_FLOOR_KB },
  ];
}

function fwdLaneSpec() {
  return { lane: LANES.fwd, threads: 1, hashKB: HASH_FLOOR_KB };
}

function parseK(v) {
  v = String(v).trim();
  var m = v.match(/^([\d.]+)\s*([kKmM])?$/);
  if (!m) return 0;
  var n = parseFloat(m[1]);
  if (m[2] === 'k' || m[2] === 'K') return Math.round(n * 1000);
  if (m[2] === 'm' || m[2] === 'M') return Math.round(n * 1000000);
  return Math.round(n);
}
function parseForbidLine(line) {
  var t = String(line || '');
  var m = t.match(/^\s*FORBID\b(.*)$/i);
  if (!m) return null;
  var rest = m[1].trim();
  if (!rest || rest === '.') return [];
  var body = rest.replace(/\.\s*$/, '').replace(/\s+/g, '');
  var digits = body.replace(/[^0-9]/g, '');
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
      for (var k = 0; k < pts.length; k++) pvs.__forbid.push(pts[k]);
    }
  } else if (head === 'MESSAGE') {
    if (tail.startsWith('REALTIME')) {
      var r = tail.split(' ');
      if (r.length >= 3 && tail.startsWith('REALTIME BEST')) {
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
        
        for (var a = 0; a < parts.length; a++) {
          var mc = parts[a].match(/^([A-Za-z])(\d+)$/);
          if (mc) bl.push([mc[1].toUpperCase().charCodeAt(0) - 65, (+mc[2]) - 1]);
        }
        pv.bestline = bl;
      } else {
        var ms = tail.match(/^Depth\s+(\d+)(?:-(\d+))?\s*\|\s*Eval\s+([^\s|]+)\s*\|\s*Time\s+[\d.]+\s*ms\s*\|\s*(.+)$/);
        if (ms) {
          var bl2 = [];
          var parts2 = ms[4].trim().split(/\s+/);
          for (var b = 0; b < parts2.length; b++) {
            var mc2 = parts2[b].match(/^([A-Za-z])(\d+)$/);
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
    var pp = head.split(',').map(Number);
    pvs.__final = [pp[0], SIZE - 1 - pp[1]];
  }
}

function countStones(board) {
  var n = 0;
  for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) if (board[y][x] !== 0) n++;
  return n;
}

function toEngineMoveList(board, moveList, side) {
  
  var black = [], white = [];
  for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
    if (board[y][x] === 1) black.push([x, y]);
    else if (board[y][x] === 2) white.push([x, y]);
  }
  var usableList = Array.isArray(moveList) && moveList.length > 0;
  var used = {};
  var pick = function (color) {
    if (!usableList) return null;
    for (var i = 0; i < moveList.length; i++) {
      var m = moveList[i];
      if (m && typeof m.x === 'number' && typeof m.y === 'number' &&
          board[m.y] && board[m.y][m.x] === color) {
        var key = m.x + ',' + m.y;
        if (!used[key]) { used[key] = true; return [m.x, m.y]; }
      }
    }
    return null;
  };
  var bs = black.slice(), ws = white.slice();
  var seq = [];
  var maxLen = Math.max(bs.length, ws.length);
  for (var i2 = 0; i2 < maxLen; i2++) {
    if (i2 < bs.length) seq.push(1);
    if (i2 < ws.length) seq.push(2);
  }
  var out = [];
  for (var s = 0; s < seq.length; s++) {
    var color = seq[s];
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

function applySideToMove(out, side) {
  if (side !== 1 && side !== 2) return out;
  if (!out.length) return out;
  var wantLast = 3 - side;                       
  if (out[out.length - 1][2] === wantLast) return out;
  var idx = -1, i;
  for (i = out.length - 1; i >= 1; i--) {        
    if (out[i][2] === wantLast) { idx = i; break; }
  }
  if (idx < 0) return out;                       
  var m = out.splice(idx, 1)[0];
  out.push(m);
  return out;
}

function laneSerial(lane, action) {
  var run = lane.tail.then(action, action);
  lane.tail = run.catch(function () {});
  return run;
}

function sendLaneCmds(lane, cmds) {
  if (!cmds.length) return;
  if (lane.engine && lane.engine.__native) lane.engine.sendCommand(cmds.join('\n'));
  else for (var i = 0; i < cmds.length; i++) lane.engine.sendCommand(cmds[i]);
}
function whenBootReady(lane) {
  if (lane.ready) return Promise.resolve();
  return new Promise(function (resolve) { lane.waiters.push(resolve); });
}
function releaseLane(lane) {
  lane.ready = true;
  var wakers = lane.waiters; lane.waiters = [];
  for (var i = 0; i < wakers.length; i++) { try { wakers[i](); } catch (e) {} }
}

function waitForMove(lane, budgetMs, wantTopN, liveId, liveTag, retryBody) {
  return new Promise(function (resolve, reject) {
    var hardDeadline = Date.now() + Math.max(1000, budgetMs) + 8000;
    var pvs = { __cur: -1 };
    var lastLivePost = 0;                          
    var revived = false;                           
    lane.watching = true;                          
    function postLive(searching) {
      if (liveId == null) return;
      self.postMessage({
        type: 'live', id: liveId, lane: lane.name, tag: liveTag || '',
        searching: !!searching, t0: (lane.liveState && lane.liveState.t0) || Date.now(),
        cid: (lane.liveState && lane.liveState.cid) || '',
        speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0,
        depth: (pvs[0] && pvs[0].depth) || 0, eval: (pvs[0] && pvs[0].eval) || '',
        best: pvs.__best || null,
        pvs: (lane.liveState && lane.liveState.pvs) || [],
      });
    }
    var timer = setInterval(function () {
      var raw = lane.outBuf; lane.outBuf = '';
      var ls = raw.split('\n');
      for (var i = 0; i < ls.length; i++) parseLine(ls[i], pvs);

      if (lane.liveState && lane.liveState.searching) {
        var live = { searching: true, t0: lane.liveState.t0, cid: lane.liveState.cid, best: pvs.__best || null, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, pvs: [] };
        var lvTop = Math.max(1, Math.min(8, wantTopN || 8));
        var lvSeen = {};
        for (var li = 0; li < lvTop; li++) {
          var lvpv = pvs[li];
          var lvb0 = lvpv && lvpv.bestline && lvpv.bestline[0];
          if (lvpv && lvb0) {
            
            var lvKey = lvb0[0] + ',' + lvb0[1];
            if (lvSeen[lvKey]) continue;
            lvSeen[lvKey] = 1;
            live.pvs.push({ x: lvb0[0], y: lvb0[1], eval: lvpv.eval || '', depth: lvpv.depth || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || lvpv.nodes || 0, line: (lvpv.bestline || []).slice(0, 16) });
          }
        }
        lane.liveState = live;
        
        var nowMs = Date.now();
        if (liveId != null && nowMs - lastLivePost >= 140) {
          lastLivePost = nowMs;
          postLive(true);
        }
      }

      var out = [];
      var seenCand = {};                            
      for (var k = 0; k < wantTopN; k++) {
        var pv = pvs[k];
        var b0 = pv && pv.bestline && pv.bestline[0];
        if (pv && b0) {
          var ck = b0[0] + ',' + b0[1];
          if (seenCand[ck]) continue;
          seenCand[ck] = 1;
          out.push({ x: b0[0], y: b0[1], winrate: (pv.winrate !== undefined && pv.winrate > 0) ? pv.winrate : 0.5, eval: pv.eval || '', depth: pv.depth || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || pv.nodes || 0, line: (pv.bestline || []).slice(0, 16) });
        }
      }
      var mbest = raw.match(/\bbest\s+(\d+)\s+(\d+)/);
      
      var chosen = (mbest ? [+mbest[1], SIZE - 1 - (+mbest[2])] : null) || pvs.__final || pvs.__best;
      var done = !!mbest || !!pvs.__final || /^\s*REJECT\s*$/m.test(raw);
      if (done) {
        clearInterval(timer);
        lane.watching = false;
        if (lane.liveState) lane.liveState.searching = false;
        postLive(false);                            
        if (!chosen && out.length) chosen = [out[0].x, out[0].y];
        if (chosen && chosen.length === 2) {
          var found = -1;
          for (var q = 0; q < out.length; q++) if (out[q].x === chosen[0] && out[q].y === chosen[1]) { found = q; break; }
          if (found > 0) out.unshift(out.splice(found, 1)[0]);
          else if (found < 0) out.unshift({ x: chosen[0], y: chosen[1], winrate: 0.5, eval: (out[0] && out[0].eval) || '', depth: (out[0] && out[0].depth) || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, line: [] });
        } else if (!out.length && chosen && chosen.length === 2) {
          out.push({ x: chosen[0], y: chosen[1], winrate: 0.5, eval: '', depth: 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, line: [] });
        }
        resolve({ candidates: out, best: chosen });
      } else if (Date.now() > hardDeadline) {
        
        if (!revived && retryBody) {
          revived = true;
          lane.outBuf = '';
          try { if (lane.engine && lane.engine.sendCommand) lane.engine.sendCommand(retryBody); } catch (eR) {}
          hardDeadline = Date.now() + 5000;
          return;
        }
        clearInterval(timer);
        lane.watching = false;
        if (lane.liveState) lane.liveState.searching = false;
        postLive(false);                            
        if (chosen || out.length) {
          if (!chosen) chosen = [out[0].x, out[0].y];
          resolve({ candidates: out, best: chosen, timeout: true });
        } else reject(new Error('Engine did not return a move within time limit'));
      }
    }, 60);
  });
}

function armForbidCapture(lane) {
  var found = [];
  var settled = false;
  var poll = null, guard = null, settleTimer = null, resolveFn = null;
  var finish = function () {
    if (settled) return;
    settled = true;
    lane.captureLine = null;
    if (poll) clearInterval(poll);
    if (guard) clearTimeout(guard);
    if (settleTimer) clearTimeout(settleTimer);
    if (resolveFn) resolveFn(found);
  };
  var sawLine = false;
  lane.captureLine = function (line) {
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
  return { promise: new Promise(function (resolve) { resolveFn = resolve; }) };
}

var requestSeq = 0;

var PONDER_IDLE_MS = 10000;    
function armPonderWatchdog(lane) {
  if (lane.ponderTmr) clearTimeout(lane.ponderTmr);
  lane.ponderTmr = setTimeout(function () {
    lane.ponderTmr = null;
    if (lane.engine && lane.bootOk) {
      try { lane.engine.sendCommand('INFO PONDERING 0'); } catch (e) {}
    }
  }, PONDER_IDLE_MS);
}
function doAnalyze(body, lane) {
  var board = body.board;
  if (!Array.isArray(board) || board.length !== SIZE) return Promise.reject(new Error('board must be 15x15'));
  return whenBootReady(lane).then(function () {
    var matchMs = Math.max(1000, Math.min(30000 * 1000, body.matchMs || 6000000));
    var turnMs = Math.max(500, Math.min(6000 * 1000, body.turnMs || 7000));
    var timeUsedMs = Math.max(0, Math.min(matchMs - 1, body.timeUsedMs || 0));
    var timeLeft = Math.max(1, matchMs - timeUsedMs);
    var topN = Math.max(1, Math.min(8, body.topN || 3));
    var effTopN = topN;
    var rule = [0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0;
    
    var side = (body.side === 1 || body.side === 2) ? body.side : 0;

    var t0 = Date.now();
    lane.liveState = { searching: true, t0: t0, cid: body.cid || '', best: null, speed: 0, nodes: 0, pvs: [] };

    var moves = toEngineMoveList(board, body.moveList, side);
    var cmd = 'YXBOARD';
    for (var i = 0; i < moves.length; i++) cmd += ' ' + moves[i].join(',');
    cmd += ' DONE';
    lane.outBuf = '';

    var pre = [];
    var wantT = body.exclusive ? fullCoreThreads() : planLaneThreads(lane);
    if (wantT > 0 && lane.curThreads !== wantT) {
      lane.curThreads = wantT;
      pre.push('INFO THREAD_NUM ' + wantT);
    }
    
    var ponderOn = body.exclusive && lane.name === 'main' && turnMs >= 2000 && !body.noPonder;
    if (ponderOn) {
      pre.push('INFO PONDERING 1');
      armPonderWatchdog(lane);
    } else if (lane.ponderTmr) {
      clearTimeout(lane.ponderTmr); lane.ponderTmr = null;
      pre.push('INFO PONDERING 0');   
    }
    
    if (body.cid !== 'warmup' && (body.exclusive || turnMs >= HASH_CLAIM_MIN_MS))
      pre = pre.concat(claimHash(lane));
    
    var cmds = pre.concat(['INFO RULE ' + rule, 'INFO TIMEOUT_TURN ' + turnMs,
                'INFO TIMEOUT_MATCH ' + matchMs, 'INFO TIME_LEFT ' + timeLeft, cmd]);
    var forbidCap = null;
    if (rule === 2 || rule === 4) { cmds.push('YXSHOWFORBID'); forbidCap = armForbidCapture(lane); }
    cmds.push('YXNBEST ' + effTopN);
    var forbidP = forbidCap ? forbidCap.promise : Promise.resolve([]);
    sendLaneCmds(lane, cmds);
    
    var retryBody = cmds.join('\n');
    return forbidP.catch(function () { return []; }).then(function (forbid) {
      return waitForMove(lane, Math.min(timeLeft, turnMs + 1500), effTopN, body.liveId, body.tag, retryBody).then(function (result) {
        result.elapsed = Date.now() - t0;
        result.rule = rule;
        result.matchMs = matchMs;
        result.turnMs = turnMs;
        result.forbid = forbid || [];
        return result;
      });
    });
  });
}

function parseBalanceLine(line) {
  var t = String(line || '').trim();
  if (/^SWAP$/i.test(t)) return { swap: true, pts: [] };
  var m = t.match(/^(?:\d{1,2},\d{1,2})(?:\s+\d{1,2},\d{1,2})*$/);
  if (!m) return null;
  var pts = [];
  var parts = t.split(/\s+/);
  for (var i = 0; i < parts.length; i++) {
    var xy = parts[i].split(',').map(Number);
    var ex = xy[0], ey = xy[1];
    if (!(ex >= 0 && ex < SIZE && ey >= 0 && ey < SIZE)) return null;
    pts.push([ex, SIZE - 1 - ey]);
  }
  return { swap: false, pts: pts };
}

// 平衡搜索的**评估分**：引擎的 MESSAGE 行里带 "| Eval V |"（V = 平衡手落下后的局面分）。
// 刻度：ScalingFactor = 200 ⇒ 胜率 = sigmoid(V/200)；Rapfi 官方 balanceWindow = 50，
// 即 |V| ≤ 50 才算「平」（56% 胜率）。页面用这个值判定开局三手到底平不平 —— 之前
// 完全没看这个数，才会出现「对方一眼就看出谁占优」而程序毫不知情。
function parseEvalLine(line) {
  var m = /Eval\s+([-+]?M\d+|[-+]?\d+)\s*\|/.exec(String(line || ''));
  if (!m) return null;
  var s = m[1];
  if (/M\d+/i.test(s)) return (s.charAt(0) === '-' ? -1 : 1) * 90000;
  var v = parseInt(s.replace('+', ''), 10);
  return isNaN(v) ? null : v;
}

function fetchBalanceLine(lane, maxMs) {
  var settled = false, sawLine = false, out = null, ev = null;
  var poll = null, guard = null, settleTimer = null, resolveFn = null;
  var finish = function () {
    if (settled) return;
    settled = true;
    lane.captureLine = null;
    if (poll) clearInterval(poll);
    if (guard) clearTimeout(guard);
    if (settleTimer) clearTimeout(settleTimer);
    if (out) out.ev = ev;
    if (resolveFn) resolveFn(out);
  };
  lane.captureLine = function (line) {
    var e = parseEvalLine(line);
    if (e !== null) ev = e;
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
  return { promise: new Promise(function (resolve) { resolveFn = resolve; }) };
}

function doBalance(body, lane) {
  var board = body && body.board;
  if (!Array.isArray(board) || board.length !== SIZE) return Promise.reject(new Error('board must be 15x15'));
  return whenBootReady(lane).then(function () {
    var n = Math.max(1, Math.min(10, body.n || 2));
    var bias = Math.max(-2000, Math.min(2000, body.bias | 0));
    var two = body.mode === 'two';
    var turnMs = Math.max(200, Math.min(600000, body.turnMs || 5000));
    var matchMs = Math.max(turnMs + 1000, Math.min(30000 * 1000, body.matchMs || 6000000));
    var rule = [0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0;
    var reqSide = (body.side === 1 || body.side === 2) ? body.side : 0;
    var moves = toEngineMoveList(board, body.moveList, reqSide);
    var t0 = Date.now();
    lane.liveState = { searching: true, t0: t0, cid: body.cid || '', best: null, speed: 0, nodes: 0, pvs: [] };
    var pre = [];
    var wantT = (body.exclusive || body.boost || turnMs <= 1000) ? fullCoreThreads() : planLaneThreads(lane);
    if (wantT > 0 && lane.curThreads !== wantT) {
      lane.curThreads = wantT;
      pre.push('INFO THREAD_NUM ' + wantT);
    }
    pre.push('INFO RULE ' + rule, 'INFO TIMEOUT_TURN ' + turnMs,
             'INFO TIMEOUT_MATCH ' + matchMs, 'INFO TIME_LEFT ' + matchMs);
    var bc = 'YXBOARD';
    for (var i = 0; i < moves.length; i++) bc += ' ' + moves[i].join(',');
    bc += ' DONE';
    pre.push(bc, 'YXBLOCKRESET');
    // ★ 官方开局区间锁（zoneR>0 时启用）：把天元 (2*zoneR+1)² 之外的点全部 YXBLOCK 掉。
    //   ★★ 2026-10-13 二次修正：**页面默认不再传 zoneR**（=0 ⇒ 不加锁）。实测这把锁
    //   会把平衡搜索毁掉：把白 2 锁进天元 3×3 之后，禁手侧 YXBALANCETWO 直接给出
    //   |Eval| = M4（算出杀棋！），不锁时是 +25~43；无禁手同样，平衡对第 2 点（常在 d=3）
    //   被挤掉后 |eval| 从 14~44 劣化到 486。禁手 / 无禁手的区别改由 rule 参数体现
    //   （同 rule 下引擎的着法生成会自己剔掉黑方禁手点）—— 那才是规则该管的事。
    //   能力保留：zoneR>0 时仍按官方区间锁（只对「对的第 1 手」生效 —— generateRootMoves
    //   里 m2 不再查 blockMoves），留作日后需要严格 RIF 开局时用。
    var zoneR = Math.max(0, Math.min(7, body.zoneR | 0));
    if (zoneR > 0) {
      var zc = (SIZE - 1) >> 1, zbl = [];
      for (var zy = 0; zy < SIZE; zy++) {
        for (var zx = 0; zx < SIZE; zx++) {
          if (Math.max(Math.abs(zx - zc), Math.abs(zy - zc)) <= zoneR) continue;
          zbl.push(zx + ',' + (SIZE - 1 - zy));
        }
      }
      if (zbl.length) pre.push('YXBLOCK ' + zbl.join(' ') + ' DONE');
    }
    lane.outBuf = '';
    sendLaneCmds(lane, pre);
    var results = [], swap = false, lastEv = null;
    var waitMs = turnMs + 6000;
    var step = function (idx) {
      if (idx >= n) return Promise.resolve();
      var cap = fetchBalanceLine(lane, waitMs);
      sendLaneCmds(lane, [(two ? 'YXBALANCETWO ' : 'YXBALANCEONE ') + bias]);
      return cap.promise.then(function (r) {
        if (!r || (!r.swap && !r.pts.length)) return;
        if (r.ev != null) lastEv = r.ev;
        if (r.swap) { swap = true; return; }
        for (var k = 0; k < r.pts.length; k++) results.push(r.pts[k]);
        if (idx < n - 1) {
          var bcmd = 'YXBLOCK';
          for (var k2 = 0; k2 < r.pts.length; k2++) bcmd += ' ' + r.pts[k2][0] + ',' + (SIZE - 1 - r.pts[k2][1]);
          sendLaneCmds(lane, [bcmd + ' DONE']);
        }
        return step(idx + 1);
      });
    };
    return step(0).then(function () {
      sendLaneCmds(lane, ['YXBLOCKRESET']);
      if (lane.name === 'main') armPonderWatchdog(lane);
      lane.liveState = null;
      return { mode: two ? 'two' : 'one', n: n, bias: bias, swap: swap,
               moves: results, elapsed: Date.now() - t0, rule: rule, eval: lastEv };
    });
  });
}

var rapfiLoaded = false;
function ensureRapfiLoaded() {
  if (rapfiLoaded) return;
  importScripts(AI_BASE + 'rapfi-multi.js');
  rapfiLoaded = true;
}
function createLaneEngine(lane) {
  
  if (NATIVE.ok) {
    lane.engine = makeNativeEngine(lane);
    return Promise.resolve(lane.engine);
  }
  if (GB_NO_WASM) return Promise.reject(new Error('NO_NATIVE_NO_WASM'));   
  ensureRapfiLoaded();
  return Rapfi({
    locateFile: function (f) { return AI_BASE + f; },
    
    mainScriptUrlOrBlob: AI_BASE + 'rapfi-multi.js',
    onReceiveStdout: function (line) {
      if (lane.captureLine) { try { if (lane.captureLine(line) === true) return; } catch (e) {} }
      lane.outBuf += line + '\n';
    },
    onReceiveStderr: function () {},
    onExit: function () {},
    setStatus: function () {},
  }).then(function (mod) { lane.engine = mod; return mod; });
}

function bootSpec(sp) {
  return createLaneEngine(sp.lane).then(function () {
    
    return new Promise(function (r) { setTimeout(r, NATIVE.ok ? 60 : 1500); }).then(function () {
      if (!sp.lane.engine) return;
      
      var dbCfg = [];
      sendLaneCmds(sp.lane, ['START ' + SIZE,
        'INFO THREAD_NUM ' + sp.threads,
        'INFO CAUTION_FACTOR 3',
        'INFO STRENGTH 100',
        'INFO SHOW_DETAIL 3',
        'INFO PONDERING 0',
        'INFO SWAPABLE 0',
        'INFO HASH_SIZE ' + sp.hashKB].concat(dbCfg));
      
      sp.lane.bootThreads = sp.threads;
      sp.lane.curThreads = sp.threads;
      sp.lane.curHashKB = sp.hashKB;      
      sp.lane.bootOk = true;
      releaseLane(sp.lane);
      
      laneSerial(sp.lane, function () {
        var wb = [];
        for (var wy = 0; wy < SIZE; wy++) { var row = []; for (var wx = 0; wx < SIZE; wx++) row.push(0); wb.push(row); }
        return doAnalyze({ board: wb, moveList: [], matchMs: 600000, turnMs: 500, timeUsedMs: 0,
          topN: 1, rule: 0, cid: 'warmup', lane: sp.lane.name, side: 1 }, sp.lane)
          .catch(function () {});          
      });
    });
  }, function (e) {
    
    if (sp.lane === LANES.main) throw e;
  });
}

function bootAll() {
  var specs = laneSpecs();
  var pending = [];
  for (var i = 0; i < specs.length; i++) pending.push(bootSpec(specs[i]));
  return Promise.all(pending);
}

var lazyBooting = {};
function bootLazyLane(lane) {
  if (lane.ready) return Promise.resolve();
  if (lazyBooting[lane.name]) return lazyBooting[lane.name];
  var sp = (lane === LANES.fwd) ? fwdLaneSpec()
                                 : { lane: lane, threads: 1, hashKB: HASH_FLOOR_KB };
  var p = bootSpec(sp).then(function () {
    if (!lane.ready) { lazyBooting[lane.name] = null; throw new Error('车道引导失败：' + lane.name); }
  }, function (e) { lazyBooting[lane.name] = null; throw e; });
  lazyBooting[lane.name] = p;
  return p;
}

var booted = false;
self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'boot') {
    if (booted) return;
    booted = true;
    if (d.threads) CFG.threads = d.threads;
    if (d.hashKB) CFG.hashKB = d.hashKB;
    
    RELAY = !!d.relay;
    
    probeNative().then(function () {
      if (NATIVE.ok) self.postMessage({ type: 'native', variant: NATIVE.variant, cpus: NATIVE.cpus, memMB: NATIVE.memMB });
      else if (GB_NO_WASM) throw new Error('NO_NATIVE_NO_WASM');
      return bootAll();
    }).then(function () {
      self.postMessage({ type: 'ready' });
    }, function (err) {
      self.postMessage({ type: 'bootfail', message: String(err && err.message || err) });
    });
  } else if (d.type === 'analyze') {
    var lane = pickLane(d.body && d.body.lane);
    
    var pre = (lane !== LANES.main && lane !== LANES.sub && !lane.ready)
      ? bootLazyLane(lane) : Promise.resolve();
    pre.then(function () { return laneSerial(lane, function () { return doAnalyze(d.body, lane); }); })
      .then(function (result) { self.postMessage({ type: 'done', id: d.id, result: result }); },
            function (err) { self.postMessage({ type: 'fail', id: d.id, message: String(err && err.message || err) }); });
  } else if (d.type === 'balance') {
    var blane = pickLane(d.body && d.body.lane);
    var bpre = (blane !== LANES.main && blane !== LANES.sub && !blane.ready)
      ? bootLazyLane(blane) : Promise.resolve();
    bpre.then(function () { return laneSerial(blane, function () { return doBalance(d.body, blane); }); })
      .then(function (result) { self.postMessage({ type: 'done', id: d.id, result: result }); },
            function (err) { self.postMessage({ type: 'fail', id: d.id, message: String(err && err.message || err) }); });
  } else if (d.type === '__relay') {
    
    var pl = d.payload || {};
    if (pl.type === 'engineOut' && Array.isArray(pl.lanes)) {
      for (var ri = 0; ri < pl.lanes.length; ri++) {
        var ent = pl.lanes[ri];
        var ln = pickLane(ent && ent.lane);
        if (ln && ln.engine && ln.engine.__feed) ln.engine.__feed(ent.lines || [], ent.alive);
        else if (ln) {   
          for (var rj = 0; rj < (ent.lines || []).length; rj++) ln.outBuf += ent.lines[rj] + '\n';
        }
      }
    }
  } else if (d.type === 'hash') {
    
    CFG.hashKB = d.hashKB;
    applyHashBudget();
  }
  
};
