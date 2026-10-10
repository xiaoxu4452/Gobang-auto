/* Gomoku local engine service - RapFi native engine via child-process pipe; HTTP analyze API for the bookmark edition. */


'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const RES  = path.join(__dirname, 'resources');

const GB_LOCK = path.join(require('os').tmpdir(), 'gomoku_suite.lock');
const GB_IS_BACKEND = (process.argv || []).indexOf('--as-backend') >= 0;
function gbLockInfo() {
  try { const j = JSON.parse(fs.readFileSync(GB_LOCK, 'utf8')); return (j && j.pid) ? j : null; }
  catch (e) { return null; }
}
function gbPidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

var gbParentPid = 0;
var gbHostGoneAt = 0;
var gbAdoptedAt = 0;   
var gbClientSeenAt = Date.now();
function gbAcquireLock() {
  const cur = gbLockInfo();
  if (cur && cur.pid !== process.pid && gbPidAlive(cur.pid)) return cur;
  try {
    fs.writeFileSync(GB_LOCK, JSON.stringify({ pid: process.pid, app: 'GomokuEngine', ts: Date.now() }));
  } catch (e) {}
  return null;
}
function gbReleaseLock() {
  const cur = gbLockInfo();
  if (cur && cur.pid === process.pid) { try { fs.unlinkSync(GB_LOCK); } catch (e) {} }
}
if (!GB_IS_BACKEND) {
  const _holder = gbAcquireLock();
  if (_holder) {
    
    const _who = (_holder.app === 'GomokuOverlay') ? 'desktop-overlay' : 'gomoku-engine';
    log('[boot] detected existing registration of ' + _who + ' (pid=' + _holder.pid + ') -- coexist policy, continuing.\n');
  }
}

function shutdownEngineProcesses() {
  for (const k of Object.keys(LANES)) {
    const e = LANES[k] && LANES[k].engine;
    try { if (e && typeof e.terminate === 'function') e.terminate(); } catch (err) {}
  }
  try { stopRecognitionChild(); } catch (err) {}   
  gbReleaseLock();
}
process.on('exit', shutdownEngineProcesses);
['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach(function (sig) {
  process.on(sig, function () { try { shutdownEngineProcesses(); } catch (e) {} process.exit(0); });
});

const PORT = (typeof process !== 'undefined' && process.env && process.env.GB_PORT) ? (parseInt(process.env.GB_PORT, 10) || 8964) : 8964;
const SIZE = 15;

function probeOwnPort() {
  return new Promise(function (resolve) {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = require('http').request(
        { host: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET' },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            let ours = false;
            try { ours = (res.statusCode === 200) && (JSON.parse(body).app === 'GomokuEngine'); } catch (e) {}
            finish({ state: ours ? 'ours' : 'foreign', code: res.statusCode });
          });
        });
      req.on('error', (e) => finish({ state: (e && e.code === 'ECONNREFUSED') ? 'free' : 'foreign', code: 0 }));
      req.setTimeout(1500, () => { try { req.destroy(); } catch (e) {} finish({ state: 'timeout' }); });
      req.end();
    } catch (e) { finish({ state: 'free' }); }
  });
}

function openLauncherPage() {
  try {
    require('child_process').exec('start "" "http://127.0.0.1:' + PORT + '/"');
    log('[boot] engine already running -> opened launcher page http://127.0.0.1:' + PORT + '/\n');
  } catch (e) {
    log('[boot] failed to open browser: ' + (e && e.message ? e.message : e) +
        '\n        please open http://127.0.0.1:' + PORT + '/ manually\n');
  }
}

function sayThenExit(lines, delayMs) {
  for (const l of lines) log(l + '\n');
  log('\n(this window closes automatically in ' + Math.round(delayMs / 1000) + 's)\n');
  
  setTimeout(() => process.exit(0), delayMs);
}

function makeLane(name) {
  return {
    name: name,
    engine: null,          
    outBuf: '',            
    captureLine: null,     
    liveState: null,       
    tail: Promise.resolve(),   
    ready: false,          
    waiters: [],
    engineGone: false,     
                           
  };
}
const LANES = { main: makeLane('main'), sub: makeLane('sub'), fwd: makeLane('fwd') };
function pickLane(name) { return (name === 'sub') ? LANES.sub : (name === 'fwd') ? LANES.fwd : LANES.main; }

const BOOT_GUARD_MS = 8000;
function armBootGuard(lane) {
  
  setTimeout(function forceBootReady() {
    if (lane.ready) return;
    log('[boot] [' + lane.name + '] ready flag timeout (' + BOOT_GUARD_MS + 'ms) — releasing waiting requests\n');
    lane.ready = true;
    const wakers = lane.waiters; lane.waiters = [];
    for (const w of wakers) { try { w(); } catch (e) {} }
  }, BOOT_GUARD_MS).unref();   
}
function whenBootReady(lane) {
  if (lane.ready) return Promise.resolve();
  return new Promise((resolve) => { lane.waiters.push(resolve); });
}

function parseK(v) {
  v = String(v).trim();
  const m = v.match(/^([\d.]+)\s*([kKmM])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (m[2] === 'k' || m[2] === 'K') return Math.round(n * 1000);
  if (m[2] === 'm' || m[2] === 'M') return Math.round(n * 1000000);
  return Math.round(n);
}

function laneSerial(lane, action) {
  const run = lane.tail.then(action, action);
  lane.tail = run.catch(function () {});   
  return run;
}
function log(msg) { process.stdout.write(msg); }

function quiesceLane(lane, maxMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let lastLen = -1, lastChange = Date.now();
    const timer = setInterval(() => {
      const len = lane.outBuf.length;
      if (len !== lastLen) { lastLen = len; lastChange = Date.now(); }
      else if (Date.now() - lastChange >= 120 || Date.now() - t0 > maxMs) { clearInterval(timer); resolve(); }
    }, 40);
  });
}

function preemptLane(lane, maxMs) {
  if (lane === LANES.main && lane.mayPonder && !(lane.liveState && lane.liveState.searching === true)) {
    try { sendLane(lane, 'STOP'); } catch (e) {}
  }
  return quiesceLane(lane, maxMs);
}

function sendLane(lane, cmd) {
  log('>>> [' + lane.name + '] ' + cmd + '\n');
  lane.engine.sendCommand(cmd);
}

function countStones(board) {
  let n = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (board[y][x] !== 0) n++;
  return n;
}
function toEngineMoveList(board, moveList, side) {
  
  const black = [], white = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (board[y][x] === 1) black.push([x, y]);
    else if (board[y][x] === 2) white.push([x, y]);
  }
  
  const usableList = Array.isArray(moveList) && moveList.length > 0;
  const pick = (color) => {
    if (!usableList) return null;
    for (const m of moveList) {
      if (m && typeof m.x === 'number' && typeof m.y === 'number' &&
          board[m.y] && board[m.y][m.x] === color) {
        if (!pick._used) pick._used = new Set();
        const key = m.x + ',' + m.y;
        if (!pick._used.has(key)) { pick._used.add(key); return [m.x, m.y]; }
      }
    }
    return null;
  };
  if (usableList) pick._used = new Set();
  const bs = black.slice(), ws = white.slice();
  
  const seq = [];
  const maxLen = Math.max(bs.length, ws.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < bs.length) seq.push(1);
    if (i < ws.length) seq.push(2);
  }
  
  const out = [];
  for (const color of seq) {
    let pos = usableList ? pick(color) : null;
    if (!pos) pos = (color === 1 ? bs.shift() : ws.shift());
    else { const src = (color === 1 ? bs : ws); const k = src.findIndex(([px, py]) => px === pos[0] && py === pos[1]); if (k >= 0) src.splice(k, 1); }
    if (!pos) continue;
    out.push([pos[0], SIZE - 1 - pos[1], color]);
  }
  return applySideToMove(out, side);
}

function applySideToMove(out, side) {
  if (side !== 1 && side !== 2) return out;
  if (!out.length) return out;
  const wantLast = 3 - side;
  if (out[out.length - 1][2] === wantLast) return out;
  let idx = -1;
  for (let i = out.length - 1; i >= 1; i--) { if (out[i][2] === wantLast) { idx = i; break; } }
  if (idx < 0) return out;
  const m = out.splice(idx, 1)[0];
  out.push(m);
  return out;
}

function parseLine(line, pvs) {
  if (!line || !line.trim()) return;
  const i = line.indexOf(' ');
  if (i === -1) {
    const t = line.trim();
    
    const pairs = t.match(/\d+,\d+/g);
    if (pairs && pairs.length) { const p = pairs[0].split(',').map(Number); pvs.__final = [p[0], SIZE - 1 - p[1]]; }
    return;
  }
  const head = line.substring(0, i);
  const tail = line.substring(i + 1);
  if (head === 'INFO') {
    const j = tail.indexOf(' ');
    const key = j === -1 ? tail : tail.substring(0, j);
    const val = j === -1 ? '' : tail.substring(j + 1);
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
      else if (key === 'BESTLINE') pvs[pvs.__cur].bestline = (val.match(/\d+,\d+/g) || []).map(s => { const p = s.split(',').map(Number); return [p[0], SIZE - 1 - p[1]]; });
    }
  } else if (head === 'FORBID') {
    
    const pts = parseForbidLine(line);
    if (pts && pts.length) {
      if (!pvs.__forbid) pvs.__forbid = [];
      for (const p of pts) pvs.__forbid.push(p);
    }
  } else if (head === 'MESSAGE') {
    if (tail.startsWith('REALTIME')) {
      const r = tail.split(' ');
      if (r.length >= 3 && tail.startsWith('REALTIME BEST')) {
        const c = r[2].split(',').map(Number);
        if (c.length === 2) pvs.__best = [c[0], SIZE - 1 - c[1]];
      }
    } else {
      
      const mpv = tail.match(/^\((\d+)\)\s+([^\s|]+)\s*\|\s*(\d+)(?:-(\d+))?\s*\|\s*(.*)$/);
      if (mpv) {
        const pvi = +mpv[1] - 1;
        pvs.__cur = pvi;
        if (!pvs[pvi]) pvs[pvi] = {};
        const pv = pvs[pvi];
        pv.eval = mpv[2];
        pv.depth = +mpv[3];
        if (mpv[4]) pv.seldepth = +mpv[4];
        const bl = [];
        const parts = mpv[5].trim().split(/\s+/);
        
        for (const t of parts) {
          const mc = t.match(/^([A-Za-z])(\d+)$/);
          if (mc) bl.push([mc[1].toUpperCase().charCodeAt(0) - 65, (+mc[2]) - 1]);
        }
        pv.bestline = bl;
      } else {
        
        const ms = tail.match(/^Depth\s+(\d+)(?:-(\d+))?\s*\|\s*Eval\s+([^\s|]+)\s*\|\s*Time\s+[\d.]+\s*ms\s*\|\s*(.+)$/);
        if (ms) {
          const bl = [];
          const parts2 = ms[4].trim().split(/\s+/);
          
          for (const t of parts2) {
            const mc = t.match(/^([A-Za-z])(\d+)$/);
            if (mc) bl.push([mc[1].toUpperCase().charCodeAt(0) - 65, (+mc[2]) - 1]);
          }
          if (bl.length) {
            if (!pvs[0]) pvs[0] = {};
            const newDepth = +ms[1];
            
            if (!pvs[0].bestline || !pvs[0].bestline.length || (pvs[0].depth || 0) <= newDepth) {
              pvs[0].bestline = bl;
              pvs[0].eval = ms[3];
              pvs[0].depth = newDepth;
              if (ms[2]) pvs[0].seldepth = +ms[2];
            }
          }
        }
        
        const spd = tail.match(/^Speed\s+([\d.]+[kKmM]?)\s*\|\s*Depth\s+(\d+)(?:-(\d+))?\s*\|\s*Eval\s+([^\s|]+)\s*\|\s*Node\s+([\d.]+[kKmM]?)\s*\|\s*Time\s+[\d.]+\s*ms/i);
        if (spd) {
          pvs.__speed = parseK(spd[1]);
          pvs.__totalnodes = parseK(spd[5]);
          if (pvs[0] && !pvs[0].eval) pvs[0].eval = spd[4];
          if (pvs[0] && !pvs[0].depth) pvs[0].depth = +spd[2];
        }
      }
    }
  } else if (head === 'best') {
    const c = tail.split(/\s+/).map(Number);
    if (c.length >= 2) pvs.__best = [c[0], SIZE - 1 - c[1]];
  } else if (/^\d+,\d+$/.test(head) && /^\d+,\d+$/.test(tail)) {
    
    const p = head.split(',').map(Number);
    pvs.__final = [p[0], SIZE - 1 - p[1]];
  }
}

function waitForMove(lane, budgetMs, wantTopN) {
  return new Promise((resolve, reject) => {
    
    const hardDeadline = Date.now() + Math.max(1000, budgetMs) + 8000;
    const pvs = { __cur: -1 };   
    const timer = setInterval(() => {
      const raw = lane.outBuf; lane.outBuf = '';
      for (const line of raw.split('\n')) parseLine(line, pvs);

      if (lane.liveState && lane.liveState.searching) {
        const live = { searching: true, t0: lane.liveState.t0, cid: lane.liveState.cid, best: pvs.__best || null, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, pvs: [] };
        const lvTop = Math.max(1, Math.min(8, wantTopN || 8));
        for (let li = 0; li < lvTop; li++) {
          const pv = pvs[li];
          const b0 = pv && pv.bestline && pv.bestline[0];
          if (pv && b0) live.pvs.push({
            x: b0[0], y: b0[1],
            eval: pv.eval || '',
            depth: pv.depth || 0,
            speed: pvs.__speed || 0,
            nodes: pvs.__totalnodes || pv.nodes || 0,
            line: (pv.bestline || []).slice(0, 16),
          });
        }
        lane.liveState = live;
      }

      const out = [];
      for (let i = 0; i < wantTopN; i++) {
        const pv = pvs[i];
        const b0 = pv && pv.bestline && pv.bestline[0];
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
      const mbest = raw.match(/\bbest\s+(\d+)\s+(\d+)/);
      let chosen = (mbest ? [+mbest[1], SIZE - 1 - (+mbest[2])] : null) || pvs.__best || pvs.__final;
      
      const done = !!mbest || !!pvs.__final || /^\s*REJECT\s*$/m.test(raw);
      if (done) {
        clearInterval(timer);
        if (lane.liveState) lane.liveState.searching = false;
        if (!chosen && out.length) chosen = [out[0].x, out[0].y];
        
        if (chosen && chosen.length === 2) {
          let found = -1;
          for (let k = 0; k < out.length; k++) if (out[k].x === chosen[0] && out[k].y === chosen[1]) { found = k; break; }
          if (found > 0) out.unshift(out.splice(found, 1)[0]);
          else if (found < 0) out.unshift({ x: chosen[0], y: chosen[1], winrate: 0.5, eval: (out[0] && out[0].eval) || '', depth: (out[0] && out[0].depth) || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, line: [] });
        } else if (!out.length && chosen && chosen.length === 2) {
          
          out.push({ x: chosen[0], y: chosen[1], winrate: 0.5, eval: '', depth: 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || 0, line: [] });
        }
        resolve({ candidates: out, best: chosen });
      } else if (Date.now() > hardDeadline) {
        clearInterval(timer);
        if (lane.liveState) lane.liveState.searching = false;
        if (chosen || out.length) {
          if (!chosen) chosen = [out[0].x, out[0].y];
          resolve({ candidates: out, best: chosen, timeout: true });
        } else reject(new Error('Engine did not return a move within time limit'));
      }
    }, 60);
  });
}

let requestSeq = 0;

function fullCoreThreads() {
  const cpuAll = Math.max(2, (require('os').cpus() || []).length || 4);
  if (process.env.GB_THREADS) return Math.max(1, Math.min(cpuAll, parseInt(process.env.GB_THREADS, 10) || cpuAll));
  return cpuAll;
}

function boostThreads() {
  if (process.env.GB_BOOST_NUM !== undefined) {
    const n = parseInt(process.env.GB_BOOST_NUM, 10) || 0;
    if (n > 0) return n;
    return fullCoreThreads();          
  }
  return Math.max(1, Math.floor(fullCoreThreads() * 2 / 3));
}
async function doAnalyze(body, lane) {
  const board = body.board;
  if (!Array.isArray(board) || board.length !== SIZE) throw new Error('board must be 15x15');
  
  if (!lane.ready) await whenBootReady(lane);
  
  if (lane === LANES.main) {
    lane.lastRequestAt = Date.now();
    if (lane.mayPonder) await preemptLane(lane, 1500);
  }
  const matchMs    = Math.max(1000, Math.min(30000 * 1000, body.matchMs || 6000000));
  
  const turnMs     = Math.max(200,  Math.min(6000 * 1000, body.turnMs || 7000));
  const timeUsedMs = Math.max(0,    Math.min(matchMs - 1, body.timeUsedMs || 0));
  const timeLeft   = Math.max(1, matchMs - timeUsedMs);
  const topN = Math.max(1, Math.min(8, body.topN || 3));
  
  const fastMode = turnMs <= 1500;
  
  const boost = !!body.exclusive || !!body.boost || turnMs <= 1000;
  const effTopN = topN;
  const RULE_NAMES = { 0: 'freestyle', 1: 'standard', 2: 'renju', 5: 'swap' };
  const rule = [0, 1, 2, 5].includes(body.rule) ? body.rule : 0;

  {
    const wantT = boost ? boostThreads() : (lane.bootThreads || 0);
    if (wantT > 0 && lane.curThreads !== wantT) {
      lane.curThreads = wantT;
      sendLane(lane, 'INFO THREAD_NUM ' + wantT);
    }
  }
  sendLane(lane, 'INFO RULE ' + rule);
  
  if (lane === LANES.main && process.env.GB_PONDER !== '0') sendLane(lane, 'INFO PONDERING 1');
  sendLane(lane, 'INFO TIMEOUT_TURN ' + turnMs);
  sendLane(lane, 'INFO TIMEOUT_MATCH ' + matchMs);
  sendLane(lane, 'INFO TIME_LEFT ' + timeLeft);

  const t0 = Date.now();
  lane.liveState = { searching: true, t0: t0, cid: body.cid || '', best: null, speed: 0, nodes: 0, pvs: [] };
  log('\n  [game#' + (++requestSeq) + '][' + lane.name + '] stones=' + countStones(board) + ' rule=' + (RULE_NAMES[rule] || rule) +
      ' match=' + (matchMs / 1000) + 's turn=' + (turnMs / 1000) + 's left=' + (timeLeft / 1000).toFixed(1) + 's' +
      (fastMode ? ' fast(top' + effTopN + ')' : '') +
      (boost && !body.exclusive ? ' boost(threads=' + boostThreads() + ')' : ''));

  const reqSide = (body.side === 1 || body.side === 2) ? body.side : 0;
  const moves = toEngineMoveList(board, body.moveList, reqSide);
  
  {
    let bn0 = 0, wn0 = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) { if (board[y][x] === 1) bn0++; else if (board[y][x] === 2) wn0++; }
    const expSide = reqSide || ((bn0 > wn0) ? 2 : 1);         
    const seqSide = moves.length ? (3 - moves[moves.length - 1][2]) : 1;   
    if (expSide !== seqSide) {
      log('  [WARN] side-to-move mismatch: board says ' + (expSide === 1 ? 'BLACK' : 'WHITE') +
          ' but sequence (len=' + moves.length + ') implies ' + (seqSide === 1 ? 'BLACK' : 'WHITE') +
          ' (bn=' + bn0 + ' wn=' + wn0 + ') -- stone-count anomaly (recognition noise), eval perspective may be unreliable\n');
    }
  }
  let cmd = 'YXBOARD';
  for (const m of moves) cmd += ' ' + m.join(',');
  cmd += ' DONE';
  sendLane(lane, cmd);
  lane.outBuf = '';
  
  let forbid = [];
  if (rule === 2 || rule === 4) {
    try { forbid = await fetchForbid(lane); } catch (e) { forbid = []; }
  }
  sendLane(lane, 'YXNBEST ' + effTopN);
  lane.inSearch = true;                     
  let result;
  try {
    result = await waitForMove(lane, Math.min(timeLeft, turnMs + 1500), effTopN);
  } finally {
    lane.inSearch = false;
    if (lane === LANES.main) { lane.mayPonder = true; lane.lastRequestAt = Date.now(); }
  }
  result.elapsed = Date.now() - t0;
  result.rule = rule;
  result.matchMs = matchMs;
  result.turnMs = turnMs;
  result.forbid = forbid;      
  log('\n  [game#' + requestSeq + '] done in ' + (result.elapsed / 1000).toFixed(2) + 's' +
      (forbid.length ? ' forbid=' + forbid.length : '') + '\n');
  return result;
}

function parseForbidLine(line) {
  const t = String(line || '');
  const m = t.match(/^\s*FORBID\b(.*)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest || rest === '.') return [];                 
  
  const body = rest.replace(/\.\s*$/, '').replace(/\s+/g, '');
  const digits = body.replace(/[^0-9]/g, '');
  const out = [];
  for (let i = 0; i + 4 <= digits.length; i += 4) {
    const x = parseInt(digits.slice(i, i + 2), 10);
    const y = parseInt(digits.slice(i + 2, i + 4), 10);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
    out.push([x, SIZE - 1 - y]);                        
  }
  return out;
}

function fetchForbid(lane) {
  return new Promise((resolve) => {
    const found = [];
    let settled = false;
    let poll = null, guard = null, settleTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      lane.captureLine = null;
      if (poll) clearInterval(poll);
      if (guard) clearTimeout(guard);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(found);
    };
    let sawLine = false;
    
    lane.captureLine = (line) => {
      const pts = parseForbidLine(line);
      if (pts === null) return false;                    
      sawLine = true;
      for (const p of pts) found.push(p);
      return true;                                       
    };
    sendLane(lane, 'YXSHOWFORBID');
    
    poll = setInterval(() => {
      if (sawLine && !settleTimer) settleTimer = setTimeout(finish, 25);
    }, 5);
    guard = setTimeout(finish, 900);
  });
}

function parseBalanceLine(line) {
  const t = String(line || '').trim();
  if (/^SWAP$/i.test(t)) return { swap: true, pts: [] };
  
  const m = t.match(/^(?:\d{1,2},\d{1,2})(?:\s+\d{1,2},\d{1,2})*$/);
  if (!m) return null;
  const pts = t.split(/\s+/).map(s => {
    const [ex, ey] = s.split(',').map(Number);
    if (!(ex >= 0 && ex < SIZE && ey >= 0 && ey < SIZE)) return null;
    return [ex, SIZE - 1 - ey];                       
  });
  if (pts.some(p => p === null)) return null;
  return { swap: false, pts: pts };
}

function fetchBalanceMove(lane, maxMs) {
  return new Promise((resolve) => {
    let settled = false, sawLine = false;
    let poll = null, guard = null, settleTimer = null, out = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      lane.captureLine = null;
      if (poll) clearInterval(poll);
      if (guard) clearTimeout(guard);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(out);
    };
    lane.captureLine = (line) => {
      const r = parseBalanceLine(line);
      if (r === null) return false;                   
      sawLine = true;
      out = r;
      return true;
    };
    poll = setInterval(() => {
      if (sawLine && !settleTimer) settleTimer = setTimeout(finish, 30);
    }, 5);
    guard = setTimeout(finish, maxMs);
  });
}

async function doBalance(body, lane) {
  const board = body.board;
  if (!Array.isArray(board) || board.length !== SIZE) throw new Error('board must be 15x15');
  if (!lane.ready) await whenBootReady(lane);
  if (lane === LANES.main) {
    lane.lastRequestAt = Date.now();
    if (lane.mayPonder) await preemptLane(lane, 1500);
  }
  const n    = Math.max(1, Math.min(10, body.n || 2));           
  const bias = Math.max(-2000, Math.min(2000, body.bias | 0));   
  const two  = body.mode === 'two';                              
  const turnMs = Math.max(200, Math.min(600000, body.turnMs || 5000));  
  const matchMs = Math.max(turnMs + 1000, Math.min(30000 * 1000, body.matchMs || 6000000));
  const rule = [0, 1, 2, 5].includes(body.rule) ? body.rule : 0;

  const wantT = (body.exclusive || body.boost || turnMs <= 1000) ? boostThreads() : (lane.bootThreads || 0);   
  if (wantT > 0 && lane.curThreads !== wantT) {
    lane.curThreads = wantT;
    sendLane(lane, 'INFO THREAD_NUM ' + wantT);
  }
  sendLane(lane, 'INFO RULE ' + rule);
  sendLane(lane, 'INFO TIMEOUT_TURN ' + turnMs);
  sendLane(lane, 'INFO TIMEOUT_MATCH ' + matchMs);
  sendLane(lane, 'INFO TIME_LEFT ' + matchMs);

  const t0 = Date.now();
  lane.liveState = { searching: true, t0: t0, cid: body.cid || '', best: null, speed: 0, nodes: 0, pvs: [] };
  log('\n  [balance#' + (++requestSeq) + '][' + lane.name + '] stones=' + countStones(board) +
      ' n=' + n + ' mode=' + (two ? 'two' : 'one') + ' bias=' + bias + ' turn=' + (turnMs / 1000) + 's');

  const reqSide = (body.side === 1 || body.side === 2) ? body.side : 0;
  const moves = toEngineMoveList(board, body.moveList, reqSide);
  let cmd = 'YXBOARD';
  for (const m of moves) cmd += ' ' + m.join(',');
  cmd += ' DONE';
  sendLane(lane, cmd);
  lane.outBuf = '';

  sendLane(lane, 'YXBLOCKRESET');                    
  const results = [];                                
  let swap = false;
  const waitMs = turnMs + 6000;                      
  lane.inSearch = true;
  try {
    for (let i = 0; i < n; i++) {
      const rp = fetchBalanceMove(lane, waitMs);
      sendLane(lane, (two ? 'YXBALANCETWO ' : 'YXBALANCEONE ') + bias);
      const r = await rp;
      if (!r || (!r.swap && !r.pts.length)) { log('  [balance] no reply (round ' + i + ')\n'); break; }
      if (r.swap) { swap = true; break; }            
      for (const p of r.pts) results.push(p);
      if (i < n - 1) {
        
        let bcmd = 'YXBLOCK';
        for (const p of r.pts) bcmd += ' ' + p[0] + ',' + (SIZE - 1 - p[1]);
        sendLane(lane, bcmd + ' DONE');
      }
    }
  } finally {
    lane.inSearch = false;
    sendLane(lane, 'YXBLOCKRESET');                  
    if (lane === LANES.main) { lane.mayPonder = true; lane.lastRequestAt = Date.now(); }
  }
  const elapsed = Date.now() - t0;
  log('\n  [balance#' + requestSeq + '] done in ' + (elapsed / 1000).toFixed(2) + 's pts=' +
      results.length + (swap ? ' SWAP' : '') + '\n');
  return { mode: two ? 'two' : 'one', n: n, bias: bias, swap: swap,
           moves: results, elapsed: elapsed, rule: rule };
}

var GB_KEY_SRC = null;   
function gbKeyTable() {
  if (!GB_KEY_SRC) return '';
  try {
    var a = GB_KEY_SRC[0], b = GB_KEY_SRC[1];
    var posA = GB_KEY_SRC[2], posB = GB_KEY_SRC[3], order = GB_KEY_SRC[4];
    var out = new Array(order.length), ia = 0, ib = 0;
    for (var i = 0; i < order.length; i++) {
      if (order[i] === 0) out[posA[ia]] = a.charAt(ia++);
      else out[posB[ib]] = b.charAt(ib++);
    }
    return out.join('');
  } catch (e) { return ''; }
}

function gbMasterKey() {
  if (process.env.GB_MASTER_KEY) return process.env.GB_MASTER_KEY;
  return gbKeyTable();
}

function gbLcgNext(s) { return (Math.imul(s, 1103515245) + 12345) >>> 0; }
function gbSeedFromKey(keyStr) {
  var h = 0x811c9dc5 >>> 0;
  for (var i = 0; i < keyStr.length; i++) {
    h ^= keyStr.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function gbUnxor(buf, keyStr, seed2) {
  var klen = keyStr.length;
  if (!klen) throw new Error('gbUnxor: empty key');
  var s1 = gbSeedFromKey(keyStr), s2 = seed2 >>> 0;
  for (var i = 0; i < buf.length; i++) {
    var mix;
    if (i % 2 === 0) { s1 = gbLcgNext(s1); mix = (s1 >>> 24) & 0xff; }
    else { s2 = gbLcgNext(s2); mix = (s2 >>> 24) & 0xff; }
    buf[i] = (buf[i] ^ keyStr.charCodeAt(i % klen) ^ mix) & 0xff;
  }
  return buf;
}

function gbRotate(buf, shift, inverse) {
  var s = ((shift % 8) + 8) % 8;
  if (s === 0) return buf;
  var amt = inverse ? (8 - s) : s;
  if (amt === 0) return buf;
  for (var i = 0; i < buf.length; i++) {
    buf[i] = ((buf[i] << amt) | (buf[i] >> (8 - amt))) & 0xff;
  }
  return buf;
}

function loadBookmarkletSource() {
  var encPath = path.join(RES, 'bookmarklet.enc');
  if (fs.existsSync(encPath)) {
    try {
      var j = JSON.parse(fs.readFileSync(encPath, 'utf8'));
      if (j.magic !== 'GBOBF1') throw new Error('unknown ciphertext format: ' + j.magic);
      var key = gbMasterKey();
      if (!key || key.length !== 32) throw new Error('bad key (length ' + (key ? key.length : 0) + ')');
      var buf = Buffer.from(j.data, 'base64');
      gbRotate(buf, j.shift, true);            
      gbUnxor(buf, key, j.seed2);              
      return buf.toString('utf8');
    } catch (e) {
      return 'document.title="panel decrypt failed";' +
        'try{alert("\\u9762\\u677f\\u89e3\\u5bc6\\u5931\\u8d25\\uff1a\\u8bf7\\u786e\\u8ba4\\u4f7f\\u7528\\u7684\\u662f\\u672c\\u53d1\\u5e03\\u5305\\u5185\\u7684 GomokuEngine.exe\\u3002")}catch(_){}';
    }
  }
  try { return fs.readFileSync(path.join(RES, 'bookmarklet.js'), 'utf8'); }
  catch (e) { return 'document.title="bookmarklet.js not found"'; }
}

function buildBookmarkletHref() {
  var u = 'http://127.0.0.1:' + PORT;
  return "javascript:(function(){" +
    "function say(m){try{alert('\\u4e94\\u5b50\\u68cb\\u52a9\\u624b\\uff1a'+m)}catch(e){}}" +
    "function run(t){" +
      "try{(0,eval)(t);return 1}catch(e){}" +
      "try{(new Function(t))();return 1}catch(e){}" +
      "return 0" +
    "}" +
    "function inj(src,cb){" +
      "var s=document.createElement('script');s.type='text/javascript';s.charset='utf-8';" +
      "s.onload=function(){cb(0)};s.onerror=function(){cb(1)};s.src=src;" +
      "(document.head||document.documentElement).appendChild(s);" +
    "}" +
    "function boot(t){" +
      "if(!t){say('\\u9762\\u677f\\u5185\\u5bb9\\u4e3a\\u7a7a\\u3002\\u8bf7\\u91cd\\u65b0\\u53cc\\u51fb GomokuEngine.exe \\u540e\\u518d\\u8bd5\\u3002');return}" +
      "if(!run(t)){say('\\u672c\\u7f51\\u7ad9\\u7684\\u5b89\\u5168\\u7b56\\u7565(CSP)\\u7981\\u6b62\\u6ce8\\u5165\\u811a\\u672c\\uff0c\\u6b64\\u7f51\\u7ad9\\u65e0\\u6cd5\\u4f7f\\u7528\\u3002');}" +
    "}" +
    "var url='" + u + "/bookmarklet.js?t='+new Date().getTime();" +
    "try{" +
      "var x=new XMLHttpRequest();x.open('GET',url,true);x.timeout=8000;" +
      "x.onreadystatechange=function(){" +
        "if(x.readyState!==4)return;" +
        "if(x.status>=200&&x.status<300&&x.responseText){boot(x.responseText);}" +
        "else{inj(url,function(err){if(err)say('\\u65e0\\u6cd5\\u4ece\\u672c\\u5730\\u5f15\\u64ce\\u52a0\\u8f7d\\u9762\\u677f\\u3002\\u8bf7\\u5148\\u53cc\\u51fb GomokuEngine.exe\\u3002');});}" +
      "};" +
      "x.ontimeout=function(){say('\\u8fde\\u63a5\\u672c\\u5730\\u5f15\\u64ce\\u8d85\\u65f6\\u3002\\u8bf7\\u786e\\u8ba4 GomokuEngine.exe \\u5df2\\u8fd0\\u884c\\u3002');};" +
      "x.send(null);" +
    "}catch(e){" +
      "inj(url,function(err){if(err)say('\\u5f15\\u64ce\\u4e0d\\u53ef\\u8fbe\\u3002\\u8bf7\\u5148\\u53cc\\u51fb GomokuEngine.exe\\u3002');});" +
    "}" +
  "})();void 0";
}

function installPage() {
  var href = buildBookmarkletHref();
  var hrefJson = JSON.stringify(href);          
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Gomoku Engine · Launcher</title>
<style>
*{-webkit-box-sizing:border-box;box-sizing:border-box;}
html,body{margin:0;padding:0;}
/* ★ 字体优先思源黑体（Source Han Sans / Noto Sans SC，SIL OFL —— 可商用），
   不首选微软雅黑：那个只能随 Windows 授权使用，不能跟着软件分发。 */
body{font-family:"Source Han Sans SC","Source Han Sans CN","Noto Sans SC","思源黑体","Source Han Sans","PingFang SC","Hiragino Sans GB","Segoe UI","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;
font-size:14px;line-height:1.6;color:#1f2937;min-height:100vh;
background:#eaf1fb;background:-webkit-linear-gradient(top left,#eef4fc,#dbe7fa);
background:linear-gradient(135deg,#eef4fc 0%,#e3edfb 50%,#dbe7fa 100%);
padding:32px 20px;}
.box{max-width:780px;margin:0 auto;background:#fff;background:rgba(255,255,255,.94);
border:1px solid rgba(147,178,220,.45);border-radius:16px;padding:32px 34px;
box-shadow:0 10px 40px rgba(59,110,200,.13);
-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);}
h1{margin:0 0 6px;font-size:23px;line-height:1.3;color:#1e3a66;font-weight:700;}
.sub{color:#64748b;margin-bottom:22px;font-size:13px;}
.ok{display:inline-block;background:#e6f7e9;color:#1a7f37;padding:3px 11px;border-radius:20px;
font-size:12px;font-weight:600;vertical-align:middle;margin-left:6px;white-space:nowrap;}
.dragHint{text-align:center;font-size:15px;color:#3574d4;font-weight:600;margin:22px 0 12px;}
.link{display:block;margin:0 auto;padding:17px;border:2px dashed #7aa8e6;border-radius:12px;
text-align:center;font-size:18px;color:#2c5aa0;text-decoration:none;font-weight:600;
cursor:-webkit-grab;cursor:grab;background:#f3f8ff;
box-shadow:0 4px 14px rgba(53,116,212,.10);
-webkit-transition:-webkit-transform .12s ease,box-shadow .12s ease;
transition:transform .12s ease,box-shadow .12s ease;
-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;}
.link:hover{-webkit-transform:translateY(-2px);transform:translateY(-2px);
box-shadow:0 8px 20px rgba(53,116,212,.20);}
.link:active{cursor:-webkit-grabbing;cursor:grabbing;}
ol{line-height:1.95;font-size:14px;color:#3b4a63;padding-left:22px;margin:14px 0;}
.tip{background:#eaf2fd;border:1px solid #d6e4fb;padding:11px 15px;border-radius:10px;
font-size:13px;color:#2c5aa0;margin-top:16px;}
.lg{text-align:right;margin:-6px 0 14px;}
.lg button{padding:4px 12px;border:1px solid #c7d3e4;background:#fff;border-radius:6px;
cursor:pointer;font-size:13px;color:#33415c;}
.lg button:hover{background:#f3f7fd;}
body[data-lang="en"] .zh{display:none;}
body[data-lang="zh"] .en{display:none;}
/* 一键复制区 */
.copyWrap{margin:16px 0 6px;}
.copyBtn{display:block;width:100%;min-height:44px;padding:12px 16px;border:0;border-radius:10px;
background:#7ea9e8;color:#fff;font-size:15px;font-weight:600;cursor:pointer;
box-shadow:0 3px 10px rgba(126,169,232,.26);-webkit-appearance:none;appearance:none;}
.copyBtn:hover{background:#6d9ae0;}
.copyBtn:active{background:#5e8cd6;}
.copyBtn.done{background:#6fbf8a;box-shadow:0 3px 10px rgba(111,191,138,.26);}
/* 代码框：带标题栏 + 关闭按钮，高度受限于 min/max，不会被拖到很长 */
.codePanel{display:none;margin-top:10px;border:1px solid #d6e4fb;border-radius:9px;background:#f7f9fc;overflow:hidden;}
.codePanel.show{display:block;}
.codeBar{display:flex;align-items:center;gap:6px;padding:5px 6px 5px 10px;background:#eaf1fb;border-bottom:1px solid #d6e4fb;}
.cbTitle{flex:1;font-size:11px;font-weight:600;color:#5b6b80;letter-spacing:.2px;}
.codeClose{flex:none;width:24px;height:22px;line-height:1;padding:0;border:1px solid #c3d3ea;border-radius:6px;
background:#fff;color:#6b7a8f;font-size:13px;cursor:pointer;-webkit-appearance:none;appearance:none;}
.codeClose:hover{background:#e24b4a;border-color:#e24b4a;color:#fff;}
.codeBox{display:block;width:100%;height:190px;min-height:80px;max-height:320px;padding:9px 10px;
font-size:11px;line-height:1.6;font-family:Consolas,Monaco,"Courier New",monospace;color:#33415c;background:#f7f9fc;
border:0;outline:none;resize:vertical;overflow:auto;word-break:break-all;overflow-wrap:anywhere;}
.mini{font-size:12px;color:#7b8797;margin-top:6px;text-align:center;}
/* 「关于」区 */
.ab{margin-top:22px;padding:16px 18px;border:1px solid #d6e4fb;border-radius:12px;background:#f8fbff;}
.abHead{font-size:16px;font-weight:700;color:#1e3a66;margin-bottom:8px;}
.abRow{display:flex;gap:10px;font-size:13px;margin-bottom:10px;}
.abK{flex:none;color:#64748b;}
.abV{flex:1;font-weight:600;color:#1f2937;}
.abH{margin:12px 0 5px;font-size:13px;font-weight:700;color:#1e3a66;
padding-bottom:4px;border-bottom:1px solid #e3edfb;}
.abUl{margin:0;padding-left:20px;font-size:13px;color:#3b4a63;line-height:1.75;}
.abTb{width:100%;border-collapse:collapse;font-size:12.5px;}
.abTb td{padding:4px 6px;border-bottom:1px solid #eaf1fb;vertical-align:top;}
.abTb tr:last-child td{border-bottom:0;}
.abTb .n{white-space:nowrap;font-weight:600;color:#1f2937;}
.abTb .d{color:#64748b;}
.abTb .l{text-align:right;white-space:nowrap;font-family:Consolas,Monaco,monospace;color:#33415c;}
.abTxt{font-size:12.5px;color:#4a5a72;line-height:1.75;}
</style></head><body data-lang="zh">
<div class="box">
<div class="lg"><button type="button" onclick="GB_LANG()">EN / 中</button></div>
<h1><span class="zh">五子棋引擎启动器</span><span class="en">Gomoku Engine Launcher</span><span class="ok">● <span class="zh">运行中</span><span class="en">Running</span></span></h1>
<div class="sub"><span class="zh">引擎：Rapfi · 端口 8964 · 双击本程序即可</span><span class="en">Engine: Rapfi · Port 8964 · Just double-click this app</span></div>
<div class="dragHint"><span class="zh">↓ 把下面按钮拖到书签栏，或点「一键复制」手动新建书签</span><span class="en">↓ Drag the button to your bookmarks bar, or use "Copy" to add a bookmark manually</span></div>
<a class="link" href="${href}" draggable="true"><span class="zh">五子棋助手</span><span class="en">Gomoku Assistant</span></a>
<div class="copyWrap">
  <button type="button" class="copyBtn" id="gb_copy"><span class="zh">一键复制书签代码</span><span class="en">Copy bookmarklet code</span></button>
  <div class="codePanel" id="gb_code_panel">
    <div class="codeBar">
      <span class="cbTitle zh">书签代码</span><span class="cbTitle en">Bookmarklet code</span>
      <button type="button" class="codeClose" id="gb_code_close" title="\u5173\u95ed" aria-label="\u5173\u95ed">&#10005;</button>
    </div>
    <textarea class="codeBox" id="gb_code" readonly="readonly" spellcheck="false"></textarea>
  </div>
  <div class="mini"><span class="zh">复制后：Ctrl+Shift+B 显示书签栏 → 右键「添加网页/书签」→ 名称随意 → 网址粘贴 → 保存</span><span class="en">After copying: Ctrl+Shift+B → right-click "Add bookmark" → paste into URL → Save</span></div>
</div>
<ol>
<li><span class="zh">按 <b>Ctrl+Shift+B</b> 显示书签栏。</span><span class="en">Press <b>Ctrl+Shift+B</b> to show the bookmarks bar.</span></li>
<li><span class="zh">把上面蓝色按钮<b>拖到书签栏</b>松手；若拖不动（新版浏览器会拦），就点「一键复制书签代码」再手动新建书签。</span><span class="en">Drag the blue button <b>onto the bookmarks bar</b>; if dragging is blocked by newer browsers, use "Copy" and add a bookmark manually.</span></li>
<li><span class="zh">打开任意五子棋网站，点一下书签，右侧出现<b>可拖动</b>浮动面板。</span><span class="en">Open any Gomoku site, click the bookmark; a <b>draggable</b> panel appears.</span></li>
<li><span class="zh">规则：无禁手/标准/有禁手；时间：步时与局时均可自行调整（默认步时 5 秒、局时 6000 秒）。</span><span class="en">Rules: freestyle / standard / renju; time: turn and game seconds are adjustable (default turn 5s, game 6000s).</span></li>
</ol>
<div class="tip" style="background:#fff3cd;border-color:#f0c24a;color:#7a5c00;"><span class="zh"><b style="color:#c77700;">交换棋提示：</b>下<b style="background:#ffe9a8;color:#8a5a00;padding:0 4px;border-radius:3px;">塔拉尼科夫 / 塔拉山口-10</b> 等交换类规则时，请先<b style="background:#ffe0e0;color:#d63031;padding:0 4px;border-radius:3px;">关闭「自动落子」</b>，手动完成交换后再点开自动下棋。</span><span class="en"><b style="color:#c77700;">Swap rules tip:</b> For <b style="background:#ffe9a8;color:#8a5a00;padding:0 4px;border-radius:3px;">Tarannikov / Taraguchi-10</b> etc., <b style="background:#ffe0e0;color:#d63031;padding:0 4px;border-radius:3px;">turn OFF Auto-play</b> first, do the swap manually, then re-enable.</span></div>
<div class="tip"><span class="zh">书签在大多数网站都能用；个别网站因识别限制可能不支持。面板标题栏可拖动。开"自动落子"后轮到你时自动落子。关闭本窗口即停止引擎。</span><span class="en">Works on most sites; a few may be limited. Drag the panel by its title bar. Enable Auto-play and it plays your moves automatically. Close this window to stop the engine.</span></div>
<div class="tip" style="background:#fff8e6;border-color:#f0d68a;color:#8a6d1a;"><span class="zh">为了保证AI引擎智力水平，希望每步步时设置不要低于1.75秒。</span><span class="en">For best engine strength, please keep the turn time at or above 1.75 seconds.</span></div>
<div class="tip" style="background:#e6f4fb;border-color:#9ed0ea;color:#25607f;"><span class="zh">如果连续两局我方执的都是黑子的话，建议重新关闭再开启「黑子」这个选项，或者重新关闭再开启「自动落子」。本软件仅供学习使用，希望不要把它当成作弊工具。</span><span class="en">If you are assigned Black for two games in a row, please toggle the "Black" option off and on, or toggle "Auto-play" off and on. This software is for learning only — please do not use it as a cheating tool.</span></div>
<!-- ★ 2026-09-19（用户要求）：「关于」区 —— 版本号 / 功能 / 开源组件 / 许可。
     ★ 2026-09-25 晚（用户）：「关于」统一写在这里（启动器页面），书签面板不再带关于块；
       版本升 v4.3。开源组件表已按**实际随包分发**修正：
       - 删 NumPy / Pillow（Python 识别时代组件，2026-09-20 起识别换成自包含 C++，包里早已没有）；
     ★ 2026-09-27（用户要求）：版本 v4.30 → **v4.31**（与训练器关于页同步）。
       - 删 Electron（覆盖层已是 C++/WebView2 宿主，不再用 Electron 打包）；
       - 补 Node.js（Web GomokuEngine.exe = SEA 打包的 Node.js 单文件运行时，MIT）。
     关于要科学：表里每个组件都必须真的随包分发。 -->
<div class="ab">
<div class="abHead"><span class="zh">关于</span><span class="en">About</span></div>
<div class="zh">
  <div class="abRow"><span class="abK">软件</span><span class="abV">五子棋引擎启动器 · Gomoku Engine Launcher</span></div>
  <div class="abRow"><span class="abK">版本</span><span class="abV">v4.31</span></div>
  <div class="abH">功能</div>
  <ul class="abUl">
    <li>启动内置五子棋引擎（端口 8964），浏览器里开箱即用</li>
    <li>生成一个书签按钮：任意五子棋网站点一下，右侧浮出可拖动面板</li>
    <li>规则：无禁手 / 标准 / 有禁手（连珠禁手）；步时与局时可自行调整</li>
    <li>自动落子、候选着法着色与评估分展示；局面查看与保存（局面代码 / PNG 图片）</li>
    <li>同套件另有：屏幕识别覆盖层（只指导不落子）与独立五子棋练习器</li>
  </ul>
  <div class="abH">开源组件</div>
  <table class="abTb"><tbody>
    <tr><td class="n">Rapfi</td><td class="d">五子棋引擎内核</td><td class="l">GPL-3.0</td></tr>
    <tr><td class="n">OpenCV</td><td class="d">屏幕识别（GomokuVision 识别服务的图形库）</td><td class="l">Apache-2.0</td></tr>
    <tr><td class="n">Node.js</td><td class="d">引擎服务运行时（SEA 单文件打包）</td><td class="l">MIT</td></tr>
    <tr><td class="n">Source Han Sans（思源黑体）</td><td class="d">界面字体</td><td class="l">SIL OFL 1.1</td></tr>
    <tr><td class="n">Microsoft WebView2 Runtime</td><td class="d">桌面界面运行时</td><td class="l">专有（随 Windows / Edge 分发）</td></tr>
  </tbody></table>
  <div class="abH">许可</div>
  <div class="abTxt">本软件自身的界面与配套代码以 MIT 许可发布。五子棋引擎 Rapfi 以独立进程方式被调用（只通过进程管道 / 本地端口通信，不与本软件链接为同一作品），因此仍按其自身的 GPL-3.0 分发；随本软件一同分发 Rapfi 时，须一并保留它的许可证与源码获取方式。</div>
</div>
<div class="en">
  <div class="abRow"><span class="abK">App</span><span class="abV">Gomoku Engine Launcher</span></div>
  <div class="abRow"><span class="abK">Version</span><span class="abV">v4.31</span></div>
  <div class="abH">Features</div>
  <ul class="abUl">
    <li>Starts the built-in Gomoku engine (port 8964) - ready to use in your browser</li>
    <li>Builds a bookmark button: click it on any Gomoku site and a draggable panel appears</li>
    <li>Rules: freestyle / standard / renju, with adjustable turn and game time</li>
    <li>Auto-play, candidate colouring and evaluation scores; position view &amp; save (code / PNG)</li>
    <li>The suite also ships a screen-recognition overlay (advice only) and a standalone Gomoku Trainer</li>
  </ul>
  <div class="abH">Open-source components</div>
  <table class="abTb"><tbody>
    <tr><td class="n">Rapfi</td><td class="d">Gomoku engine core</td><td class="l">GPL-3.0</td></tr>
    <tr><td class="n">OpenCV</td><td class="d">Screen recognition (imaging library of the GomokuVision service)</td><td class="l">Apache-2.0</td></tr>
    <tr><td class="n">Node.js</td><td class="d">Engine service runtime (single-file SEA bundle)</td><td class="l">MIT</td></tr>
    <tr><td class="n">Source Han Sans</td><td class="d">Interface font</td><td class="l">SIL OFL 1.1</td></tr>
    <tr><td class="n">Microsoft WebView2 Runtime</td><td class="d">Desktop UI runtime</td><td class="l">Proprietary (shipped with Windows / Edge)</td></tr>
  </tbody></table>
  <div class="abH">Licence</div>
  <div class="abTxt">The interface and accompanying code of this app are released under the MIT licence. The Rapfi engine is invoked as a separate process (talking over its process pipe / a local port only, never linked into a single work), so it stays under its own GPL-3.0; whenever Rapfi is distributed together with this app, its licence and a way to obtain its source must be shipped as well.</div>
</div>
</div>
</div>
<script>
/* 全部 ES5，避免老内核解析失败导致整页脚本失效 */
(function(){
  var BM = ${hrefJson};
  try{var l=localStorage.getItem('gb_launcher_lang');if(l)document.body.setAttribute('data-lang',l);}catch(e){}
  window.GB_LANG=function(){
    var d=document.body.getAttribute('data-lang')==='en'?'zh':'en';
    document.body.setAttribute('data-lang',d);
    try{localStorage.setItem('gb_launcher_lang',d);}catch(e){}
  };
  function showCode(){
    var p=document.getElementById('gb_code_panel');
    var t=document.getElementById('gb_code');
    if(!p||!t)return null;
    t.value=BM;p.className='codePanel show';
    try{t.focus();t.select();}catch(e){}
    return t;
  }
  function hideCode(){
    var p=document.getElementById('gb_code_panel');
    var t=document.getElementById('gb_code');
    if(!p)return;
    p.className='codePanel';
    if(t){try{t.value='';}catch(e){}}
    var b=document.getElementById('gb_copy');
    if(b){try{b.focus();}catch(e){}}
  }
  var cls=document.getElementById('gb_code_close');
  if(cls)cls.onclick=hideCode;
  try{
    document.addEventListener('keydown',function(ev){
      var pn=document.getElementById('gb_code_panel');
      if(ev.keyCode===27&&pn&&pn.className.indexOf('show')>=0)hideCode();
    });
  }catch(e){}
  // 复制按钮文案必须跟着语言走（旧版把中文写死在 innerHTML 里，
  // 英文模式下点一次「Copy」就弹回「一键复制书签代码」—— 用户反馈的"英文没全部适配"）。
  var L = {
    zh: { orig:'\u4e00\u952e\u590d\u5236\u4e66\u7b7e\u4ee3\u7801', done:'\u5df2\u590d\u5236 \u2713', manual:'\u8bf7\u624b\u52a8 Ctrl+C',
          close:'\u5173\u95ed' },
    en: { orig:'Copy bookmarklet code', done:'Copied \u2713', manual:'Press Ctrl+C',
          close:'Close' }
  };
  function curLang(){
    try{ return document.body.getAttribute('data-lang')==='en' ? 'en' : 'zh'; }catch(e){ return 'zh'; }
  }
  function T(k){ return L[curLang()][k] || L.zh[k]; }
  // 用两个 <span class="zh|en"> 承载文案，切换语言时 CSS 自动显示对应的一条，
  // 无需 JS 重写 DOM；未在复制反馈态时 innerHTML 恒为这个结构。
  function origHTML(){
    return '<span class="zh">'+L.zh.orig+'</span><span class="en">'+L.en.orig+'</span>';
  }
  function mark(btn,txt){
    btn.className='copyBtn done';
    btn.innerHTML='<span class="zh">'+txt.zh+'</span><span class="en">'+txt.en+'</span>';
    setTimeout(function(){btn.className='copyBtn';btn.innerHTML=origHTML();},2600);
  }
  var ORIG = origHTML();
  // 关闭按钮的 title/aria 也随语言更新
  function syncCloseLabel(){
    var c=document.getElementById('gb_code_close');
    if(!c)return;
    var s=T('close');
    c.title=s;c.setAttribute('aria-label',s);
  }
  window.GB_LANG = (function(orig){
    return function(){
      orig.apply(null,arguments);
      syncCloseLabel();
    };
  })(window.GB_LANG);
  syncCloseLabel();
  var btn=document.getElementById('gb_copy');
  if(!btn)return;
  btn.onclick=function(){
    var ta=showCode();
    // 一级：Clipboard API（需安全上下文；127.0.0.1 视为安全）
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(BM).then(function(){
        mark(btn,{zh:'\u5df2\u590d\u5236 \u2713',en:'Copied \u2713'});
      },function(){ fallback(ta,btn); });
    } else { fallback(ta,btn); }
  };
  // 二级：execCommand（老内核 / 权限被拒）
  function fallback(ta,btn){
    var okDone={zh:'\u5df2\u590d\u5236 \u2713',en:'Copied \u2713'};
    var okManual={zh:'\u8bf7\u624b\u52a8 Ctrl+C',en:'Press Ctrl+C'};
    try{
      if(ta&&ta.select){ ta.select(); ta.setSelectionRange(0,999999); }
      var ok=document.execCommand&&document.execCommand('copy');
      mark(btn, ok?okDone:okManual);
    }catch(e){ mark(btn,okManual); }
  }
})();
</script>
</body></html>`;
}

function laneAlive(l) { return !!(l.engine && !l.engineGone); }
function healthSnapshot() {
  const lm = laneAlive(LANES.main), ls = laneAlive(LANES.sub), lf = laneAlive(LANES.fwd);
  const out = {
    ok: true, app: 'GomokuEngine', pid: process.pid, port: PORT,
    ready: !!(lm || ls),
    lanes: { main: lm, sub: ls, fwd: lf },
    upMs: Math.round(process.uptime() * 1000)   
  };
  if (GB_IS_BACKEND) {
    out.backend = true;
    if (gbParentPid) { out.parentPid = gbParentPid; out.parentAlive = gbPidAlive(gbParentPid); }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  gbClientSeenAt = Date.now();          
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const pathname = (req.url.split('?')[0]);
  
  function jsonpOut(res, cb, obj) {
    const safe = String(cb).replace(/[^A-Za-z0-9_$.[\]]/g, '').slice(0, 80) || 'noop';
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(safe + '(' + JSON.stringify(obj) + ');');
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(installPage());
  }
  if (req.method === 'GET' && pathname === '/bookmarklet.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(loadBookmarkletSource());
  }
  
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(healthSnapshot()));
  }
  
  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(healthSnapshot()));
  }
  
  if (req.method === 'POST' && pathname === '/api/adopt' && GB_IS_BACKEND) {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 4096) res.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(d || '{}');
        const pid = parseInt(j.pid || '0', 10) || 0;
        if (pid > 0 && gbPidAlive(pid)) {
          gbParentPid = pid;
          gbHostGoneAt = 0;
          gbAdoptedAt = Date.now();   
          log('[lifecycle] adopted by new host overlay pid=' + pid + ' (orphan window closed)\n');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, adopted: pid }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'pid not alive' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }
  
  if (req.method === 'POST' && pathname === '/api/hostbye' && GB_IS_BACKEND) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
    
    const byeAt = Date.now();
    setTimeout(() => {
      if (gbAdoptedAt > byeAt) {
        log('[lifecycle] host said bye but a new host adopted us after bye -> staying\n');
        return;
      }
      const n = wsClients.size;
      if (n > 0) {
        log('[lifecycle] host said bye; ' + n + ' client(s) (bookmark) remain -> staying until quiet\n');
        if (!gbHostGoneAt) gbHostGoneAt = Date.now();
      } else {
        log('[lifecycle] host said bye and no clients -> exiting now (die with host)\n');
        try { process.exit(0); } catch (e) {}
      }
    }, 1500).unref();
    return;
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    
    const qs = (req.url.split('?')[1] || '');
    const qp = new URLSearchParams(qs);
    const cid = qp.get('cid') || '';
    const lane = pickLane(qp.get('lane'));
    let out = { searching: false };
    if (lane.liveState && lane.liveState.searching) {
      if (!lane.liveState.cid || !cid || lane.liveState.cid === cid) out = lane.liveState;
    }
    
    if (qp.get('cb')) return jsonpOut(res, qp.get('cb'), out);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method === 'POST' && pathname === '/api/analyze') {
    try {
      let d = '';
      req.on('data', c => { d += c; if (d.length > 5e6) { res.destroy(); } });
      req.on('end', async () => {
        try {
          const body = JSON.parse(d || '{}');
          const lane = pickLane(body.lane);
          const out = await laneSerial(lane, () => doAnalyze(body, lane));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  
  if (req.method === 'POST' && pathname === '/api/balance') {
    try {
      let d = '';
      req.on('data', c => { d += c; if (d.length > 5e6) { res.destroy(); } });
      req.on('end', async () => {
        try {
          const body = JSON.parse(d || '{}');
          const lane = pickLane(body.lane);
          const out = await laneSerial(lane, () => doBalance(body, lane));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message || e) }));
        }
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  
  if (req.method === 'POST' && pathname === '/api/click') {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => {
      try {
        const { x, y } = JSON.parse(d || '{}');
        const X = Math.round(+x), Y = Math.round(+y);
        if (!Number.isFinite(X) || !Number.isFinite(Y)) { res.writeHead(400); return res.end('bad coords'); }
        const ps = "Add-Type -AssemblyName System.Windows.Forms;" +
          "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);' -Name U -Namespace W;" +
          "[W.U]::SetCursorPos(" + X + "," + Y + ");" +
          "Start-Sleep -Milliseconds 40;" +
          "[W.U]::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 30;" +
          "[W.U]::mouse_event(0x0004,0,0,0,0);";
        require('child_process').spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, x: X, y: Y }));
      } catch (e) {
        res.writeHead(500); res.end(String(e.message || e));
      }
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/hash') {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => {
      try {
        const _b = JSON.parse(d || '{}');
        const _lane = pickLane(_b.lane);
        let mb = Math.round(+_b.mb || 256);
        
        mb = Math.max(128, Math.min(4096, mb));
        sendLane(_lane, 'INFO HASH_SIZE ' + (mb * 1024));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mb: mb }));
      } catch (e) {
        res.writeHead(500); res.end(String(e.message || e));
      }
    });
    return;
  }
  
  if (req.method === 'GET' && pathname === '/api/analyze') {
    const _q = new URLSearchParams(req.url.split('?')[1] || '');
    const _cb = _q.get('cb') || '';
    if (!_cb) { res.writeHead(400); return res.end('missing cb'); }
    let _body;
    try { _body = JSON.parse(_q.get('d') || '{}'); } catch (e) { _body = {}; }
    try {
      const _lane = pickLane(_body.lane);
      const out = await laneSerial(_lane, () => doAnalyze(_body, _lane));
      return jsonpOut(res, _cb, out);
    } catch (e) {
      return jsonpOut(res, _cb, { error: String(e.message || e) });
    }
  }
  if (req.method === 'GET' && pathname === '/api/hash') {
    const _q = new URLSearchParams(req.url.split('?')[1] || '');
    const _cb = _q.get('cb') || '';
    if (!_cb) { res.writeHead(400); return res.end('missing cb'); }
    try {
      const _b = JSON.parse(_q.get('d') || '{}');
      const _lane = pickLane(_b.lane);
      let mb = Math.round(+_b.mb || 256);
      mb = Math.max(128, Math.min(4096, mb));
      sendLane(_lane, 'INFO HASH_SIZE ' + (mb * 1024));
      return jsonpOut(res, _cb, { ok: true, mb: mb });
    } catch (e) {
      return jsonpOut(res, _cb, { ok: false, error: String(e.message || e) });
    }
  }
  res.writeHead(404); res.end('not found');
});

function findVisionExe() {
  const up = (p, n) => { for (let i = 0; i < n; i++) p = path.dirname(p); return p; };
  const cands = [
    path.join(__dirname, 'GomokuVision.exe'),                 
    path.join(__dirname, 'vision', 'GomokuVision.exe'),        
    path.join(up(__dirname, 1), 'desktop-vision', 'build', 'GomokuVision.exe'),  
  ];
  for (let i = 0; i < cands.length; i++) if (cands[i] && fs.existsSync(cands[i])) return cands[i];
  return null;
}

var gbVisionChild = null;
function startRecognitionAsync() {
  setImmediate(function () {
    try {
      const http = require('http');
      
      http.get({ host: '127.0.0.1', port: 8970, path: '/health', timeout: 800 }, (res) => {
        res.resume();
        log('[boot] OpenCV recognition service already running (:8970)\n');
      }).on('error', function () {
        const exe = findVisionExe();
        if (!exe) { log('[boot] GomokuVision.exe not found; using in-page detection\n'); return; }
        try {
          const ch = require('child_process').spawn(exe, ['--recognize'], {
            cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: true,
            env: Object.assign({}, process.env, {
              GB_RECOG_PORT: '8970',
              GB_PARENT_PID: String(process.pid),
            }),
          });
          ch.unref();
          gbVisionChild = ch;
          log('[boot] OpenCV recognition service started (:8970) <- ' + exe + '\n');
        } catch (e) { log('[boot] failed to spawn recognition service: ' + (e && e.message) + '\n'); }
      });
    } catch (e) { log('[boot] failed to start recognition service: ' + (e && e.message) + '\n'); }
  });
}

function stopRecognitionChild() {
  try {
    if (gbVisionChild && gbVisionChild.pid) {
      try { process.kill(gbVisionChild.pid); } catch (e) {}
      log('[bye] recognition service (:8970) terminated\n');
    }
  } catch (e) {}
  gbVisionChild = null;
}

const NATIVE_RAPFI = (function () {
  let probed;   

  function aliveProbe(exe, dir) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      let ch;
      try {
        ch = require('child_process').spawn(exe, [], { cwd: dir, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      } catch (e) { return fin(false); }
      ch.on('error', () => fin(false));
      ch.on('exit', () => fin(false));            
      const t = setTimeout(() => { fin(true); try { ch.kill(); } catch (e) {} }, 1500);
      if (t.unref) t.unref();
      try { ch.stdin.write('START 15\n'); } catch (e) {}
    });
  }

  function searchProbe(exe, dir) {
    return new Promise((resolve) => {
      let done = false, out = '', code = null;
      const fin = (v) => { if (!done) { done = true; try { ch.kill(); } catch (e) {} resolve(v); } };
      let ch;
      try {
        ch = require('child_process').spawn(exe, [], { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (e) { return resolve(false); }
      ch.stdout.on('data', (d) => { out += d.toString('utf8'); });
      ch.on('error', () => fin(false));
      ch.on('exit', (c) => { code = c; fin(false); });       
      const script = 'START 15\nINFO RULE 0\nINFO TIMEOUT_TURN 300\nINFO TIMEOUT_MATCH 5000\n' +
                     'INFO TIME_LEFT 5000\nYXBOARD 7,7,1 7,8,2 DONE\nYXNBEST 1\n';
      try { ch.stdin.write(script); } catch (e) { return fin(false); }
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (/^\s*\d+,\d+\s*$/m.test(out)) { clearInterval(iv); fin(true); }   
        else if (Date.now() - t0 > 5000) { clearInterval(iv); fin(code === null); }
      }, 60);
      if (iv.unref) iv.unref();
    });
  }

  function askCpuid(vision) {
    return new Promise((resolve) => {
      let ch;
      try {
        ch = require('child_process').spawn(vision, ['--cpuid'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) { return resolve(null); }
      let out = '';
      ch.stdout.on('data', (d) => { out += d.toString('utf8'); });
      ch.on('error', () => resolve(null));
      ch.on('exit', (code) => {
        try { resolve(code === 0 ? JSON.parse(out.trim().split('\n').pop()) : null); }
        catch (e) { resolve(null); }
      });
      setTimeout(() => { try { ch.kill(); } catch (e) {} resolve(null); }, 5000).unref();
    });
  }

  async function probe() {
    if (probed !== undefined) return probed;
    probed = null;
    try {
      const dir = path.join(__dirname, 'rapfi-native');
      if (!fs.existsSync(path.join(dir, 'config.toml'))) {
        log('[native] no rapfi-native/ beside (missing config.toml) -> engine unavailable\n');
        return probed;
      }
      
      const VARIANTS = [
        { name: 'avx512vnni', need: (c) => !!c.avx512vnni },
        { name: 'avxvnni', need: (c) => !!c.avxvnni },
        { name: 'avx512', need: (c) => !!c.avx512f },
        { name: 'avx2', need: (c) => !!c.avx2 },
        { name: 'sse', need: () => true },
      ];
      const present = VARIANTS.filter((v) => fs.existsSync(path.join(dir, 'RapfiEngine-' + v.name + '.exe')));
      if (!present.length) { log('[native] no engine exe in rapfi-native/ -> engine unavailable\n'); return probed; }

      let cid = null;
      const vision = findVisionExe();
      if (vision) {
        cid = await askCpuid(vision);
        if (cid) log('[native] cpuid via GomokuVision: avx2=' + !!cid.avx2 + ' avx512f=' + !!cid.avx512f +
                     ' avx512vnni=' + !!cid.avx512vnni + ' avxvnni=' + !!cid.avxvnni + '\n');
        else log('[native] --cpuid query failed -> conservative fallback\n');
      } else log('[native] no GomokuVision.exe to query cpuid -> conservative fallback\n');
      
      const caps = cid || { avx2: false, avx512f: false, avx512vnni: false, avxvnni: false };
      const ranked = present.filter((v) => v.need(caps));
      
      const order = ranked.length ? ranked : [present[present.length - 1]];

      let fallback = null;
      for (const v of order) {
        const exePath = path.join(dir, 'RapfiEngine-' + v.name + '.exe');
        
        const ok = (v.name === 'avx512vnni' || v.name === 'avxvnni')
          ? await searchProbe(exePath, dir)
          : await aliveProbe(exePath, dir);
        if (ok) { probed = { dir, exe: 'RapfiEngine-' + v.name + '.exe' }; break; }
        log('[native] variant ' + v.name + ' probe failed -> downgrade\n');
        if (!fallback) fallback = v.name;
      }
      if (!probed) {
        
        probed = { dir, exe: 'RapfiEngine-' + (fallback || order[0].name) + '.exe' };
        log('[native] all probes failed, falling back to ' + probed.exe + '\n');
      }
      log('[native] native Rapfi ready: ' + probed.exe + '\n');
      return probed;
    } catch (e) { log('[native] probe error (' + (e.message || e) + ') -> engine unavailable\n'); return probed = null; }
  }

  function createLaneEngineNative(lane, nat) {
    return new Promise((resolve, reject) => {
      let ch = null;
      let pending = '';
      let closing = false;

      const spawnEngine = () => {
        const c = require('child_process').spawn(nat.exe, [], {
          cwd: nat.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        c.stdout.on('data', (d) => {
          pending += d.toString('utf8');
          let i;
          while ((i = pending.indexOf('\n')) >= 0) {
            let line = pending.slice(0, i);
            pending = pending.slice(i + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            
            if (lane.captureLine) { try { if (lane.captureLine(line) === true) continue; } catch (e) {} }
            
            const quietLine = !lane.inSearch && (line.startsWith('INFO ') || line.startsWith('MESSAGE '));
            lane.outBuf += line + '\n';
            if (lane.outBuf.length > 131072) {
              const k = lane.outBuf.lastIndexOf('\n', lane.outBuf.length - 65536);
              if (k > 0) lane.outBuf = lane.outBuf.slice(k + 1);
            }
            if (!quietLine) log('[' + lane.name + '] ' + line + '\n');
          }
        });
        c.stderr.on('data', (d) => log('[err][' + lane.name + '] ' + d.toString('utf8') + '\n'));
        c.on('error', (e) => log('[engine][' + lane.name + '] spawn error: ' + (e.message || e) + '\n'));
        c.on('exit', (code) => {
          ch = null;
          lane.engineGone = true;
          log('[engine exit][' + lane.name + '] ' + code + (closing ? ' (clean exit)' : ' -- will auto-restart on next command\n'));
          
          if (!closing && GB_IS_BACKEND && lane.ready) {
            const parentOk = gbParentPid && gbPidAlive(gbParentPid);
            const clients = (typeof wsClients !== 'undefined') && wsClients.size > 0;
            if (parentOk || clients) {
              const t = setTimeout(() => {
                if (closing || ch) return;
                log('[engine][' + lane.name + '] auto-respawn (host/client present)\n');
                lane.engineGone = false;
                ch = spawnEngine();
              }, 1500);
              if (t.unref) t.unref();
            } else {
              log('[lifecycle] variant died with no host/clients -> exiting cleanly (no zombie)\n');
              const t = setTimeout(() => { try { process.exit(0); } catch (e2) {} }, 600);
              if (t.unref) t.unref();
            }
          }
        });
        return c;
      };

      ch = spawnEngine();
      lane.engineGone = false;
      const engine = {
        sendCommand(cmd) {
          if (!ch || ch.exitCode !== null || ch.killed) {
            log('[engine][' + lane.name + '] native engine gone -> respawning\n');
            ch = spawnEngine();
          }
          try { ch.stdin.write(cmd + '\n'); }
          catch (e) { log('[engine][' + lane.name + '] command write failed: ' + (e.message || e) + '\n'); }
        },
        terminate() { closing = true; try { if (ch) ch.kill(); } catch (e) {} },
      };
      
      const t = setTimeout(() => resolve(engine), 300);
      if (t.unref) t.unref();
      ch.on('error', () => { if (!closing) reject(new Error('native spawn failed')); });
    });
  }

  return { probe, createLaneEngineNative };
})();

async function createLaneEngine(lane) {
  const nat = await NATIVE_RAPFI.probe();
  if (!nat) throw new Error('native Rapfi unavailable (rapfi-native/ missing or probe failed; WASM fallback removed 2026-09-26)');
  lane.engine = await NATIVE_RAPFI.createLaneEngineNative(lane, nat);
  log('[engine][' + lane.name + '] native Rapfi attached (' + nat.exe + ')\n');
}

(async function boot() {
  
  {
    const pre = await probeOwnPort();
    if (pre.state === 'ours') {
      log('[boot] :' + PORT + ' already served by our own engine (reusing, not starting a second copy)\n');
      if (GB_IS_BACKEND) process.exit(0);
      openLauncherPage();
      
      setTimeout(() => process.exit(0), 1200);   
      return;
    }
    if (pre.state === 'foreign') {
      if (GB_IS_BACKEND) process.exit(0);
      sayThenExit([
        '',
        '[!] port ' + PORT + ' is occupied by another program (HTTP ' + (pre.code || 'no response') + ').',
        '    close the program holding the port, or set the GB_PORT env var and restart.'
      ], 4000);
      return;
    }
    if (pre.state === 'timeout') {
      log('[boot] port precheck timed out (possibly initializing elsewhere) -- continuing normal startup\n');
    }
  }

  startRecognitionAsync();

  var cpuAll = Math.max(2, (require('os').cpus() || []).length || 4);
  
  var engTotal = Math.max(3, Math.floor(cpuAll * 2 / 3));
  var mainT = Math.max(1, engTotal - 2);                  
  if (process.env.GB_THREADS) mainT = Math.max(1, Math.min(cpuAll, parseInt(process.env.GB_THREADS, 10) || mainT));
  var subT  = 1;
  var fwdT  = 1;
  var totalKB = Math.floor((require('os').totalmem() || 4 * 1024 * 1024 * 1024) / 1024);
  
  var hashKB = Math.max(262144, Math.min(4 * 1024 * 1024, Math.floor(totalKB / 3)));
  if (process.env.GB_HASH_MB) hashKB = Math.max(65536, Math.min(4 * 1024 * 1024, (parseInt(process.env.GB_HASH_MB, 10) || 0) * 1024));  
  var auxH  = 65536;                                      
  var mainH = Math.max(65536, hashKB - 2 * auxH);         
  var subH  = auxH;
  var fwdH  = auxH;

  var specs = [
    { lane: LANES.main, threads: mainT, hashKB: mainH },
    { lane: LANES.sub,  threads: subT,  hashKB: subH  },
    { lane: LANES.fwd,  threads: fwdT,  hashKB: fwdH  },
  ];
  for (var si = 0; si < specs.length; si++) {
    var sp = specs[si];
    armBootGuard(sp.lane);
    try {
      await createLaneEngine(sp.lane);
    } catch (e) {
      log('[engine init error][' + sp.lane.name + '] ' + (e && e.stack ? e.stack : e) + '\n');
      if (sp.lane === LANES.main) process.exit(1);   
      continue;                                       
    }
    sendLane(sp.lane, 'START ' + SIZE);
  }

  const PRIO = process.env.GB_PRIO || 'AboveNormal';
  try {
    require('child_process').spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden',
      '-Command', "(Get-Process -Id " + process.pid + ").PriorityClass='" + PRIO + "'"], { windowsHide: true });
    log('[boot] process priority set to ' + PRIO + ' (leave headroom for system stability; GB_PRIO to override)\n');
  } catch (e) {}

  setTimeout(function () {
    for (var sj = 0; sj < specs.length; sj++) {
      var lj = specs[sj].lane;
      if (!lj.engine) continue;
      sendLane(lj, 'INFO THREAD_NUM ' + specs[sj].threads);
      
      lj.bootThreads = specs[sj].threads;
      lj.curThreads = specs[sj].threads;
      
      if (lj === LANES.main) sendLane(lj, 'INFO USEDATABASE 1');
      sendLane(lj, 'INFO CAUTION_FACTOR 3');
      sendLane(lj, 'INFO STRENGTH 100');
      sendLane(lj, 'INFO SHOW_DETAIL 3');   
      
      var ponderOn = (lj === LANES.main) && (process.env.GB_PONDER !== '0');
      sendLane(lj, 'INFO PONDERING ' + (ponderOn ? 1 : 0));
      sendLane(lj, 'INFO SWAPABLE 0');
      sendLane(lj, 'INFO HASH_SIZE ' + specs[sj].hashKB);
      log('[boot] [' + lj.name + '] tier: threads=' + specs[sj].threads + ', hash=' + (specs[sj].hashKB / 1024).toFixed(0) + 'MB\n');
      
      lj.ready = true;
      const wakers = lj.waiters; lj.waiters = [];
      for (const w of wakers) { try { w(); } catch (e) {} }
    }
    
    setTimeout(function () {
      for (const lw of [LANES.main, LANES.sub, LANES.fwd]) {
        if (!lw.engine) continue;
        const wb = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
        laneSerial(lw, () => doAnalyze({ board: wb, moveList: [], matchMs: 600000, turnMs: 500,
          timeUsedMs: 0, topN: 1, rule: 0, cid: 'warmup', lane: lw.name, side: 1 }, lw).catch(() => {}));
      }
    }, 200);
    var fmtH = function (kb) { return kb >= 1048576 ? (kb / 1048576).toFixed(1) + 'GB' : (kb / 1024).toFixed(0) + 'MB'; };
    log('[boot] engine tiers: total threads=' + (mainT + subT + fwdT) + ' / ' + cpuAll + ' cores (search = cores - max(2, 25%), view lanes 1+1 — headroom for system stability; GB_THREADS to override), total hash='
        + fmtH(mainH + subH + fwdH)
        + '  -> main ' + mainT + 'thr/' + fmtH(mainH) + ' + sub ' + subT + 'thr/' + fmtH(subH) + ' + fwd ' + fwdT + 'thr/' + fmtH(fwdH)
        + '  (1/3 of RAM capped at 4GB; GB_THREADS / GB_HASH_MB to override)\n');
  }, 1500);

  const PONDER_WATCHDOG_MS = 10 * 60 * 1000;
  setInterval(function () {
    const ml = LANES.main;
    if (!ml || !ml.engine || !ml.mayPonder) return;
    if (ml.inSearch) { ml.lastRequestAt = Date.now(); return; }
    if (Date.now() - (ml.lastRequestAt || 0) > PONDER_WATCHDOG_MS) {
      ml.mayPonder = false;
      try { sendLane(ml, 'INFO PONDERING 0'); log('[ponder] idle ' + (PONDER_WATCHDOG_MS / 60000) + 'min -> stopped\n'); } catch (e) {}
    }
  }, 60 * 1000);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      
      probeOwnPort().then((pre) => {
        if (pre.state === 'ours') {
          log('\n[boot] port ' + PORT + ' already served by our own engine (another start won the race).\n');
          if (GB_IS_BACKEND) { process.exit(0); }
          openLauncherPage();
          setTimeout(() => process.exit(0), 1200);   
          return;
        }
        if (GB_IS_BACKEND) { process.exit(0); }
        sayThenExit([
          '',
          '[!] port ' + PORT + ' is occupied by another program (HTTP ' + (pre.code || 'no response') + ').',
          '    close the program holding the port, or set the GB_PORT env var and restart.'
        ], 4000);
      });
    } else {
      log('[server error] ' + e.message + '\n');
      process.exit(1);
    }
  });
  
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const wsClients = new Set();
  function wsTextFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    let header;
    if (payload.length < 126) { header = Buffer.from([0x81, payload.length]); }
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    return Buffer.concat([header, payload]);
  }
  
  function wsParseFrame(buf) {
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (len > 16 * 1024 * 1024) return { fin: true, opcode: 0x8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) }; 
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return null;
    let payload = buf.slice(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.slice(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    return { fin, opcode, payload, rest: buf.slice(off + maskLen + len) };
  }
  async function handleWsMessage(socket, msgBuf) {
    let msg = null;
    try { msg = JSON.parse(msgBuf.toString('utf8')); } catch (e) { return; }
    const seq = msg.seq;
    const api = String(msg.api || '');
    const body = msg.body || {};
    const send = (obj) => { try { socket.write(wsTextFrame(JSON.stringify(obj))); } catch (e) {} };
    try {
      if (api === 'health') {
        return send({ seq, result: healthSnapshot() });
      }
      if (api === 'analyze') {
        const lane = pickLane(body.lane);
        return send({ seq, result: await laneSerial(lane, () => doAnalyze(body, lane)) });
      }
      if (api === 'balance') {
        const lane = pickLane(body.lane);
        return send({ seq, result: await laneSerial(lane, () => doBalance(body, lane)) });
      }
      if (api === 'hash') {
        let mb = Math.max(128, Math.min(4096, Math.round(+body.mb || 256)));
        sendLane(pickLane(body.lane), 'INFO HASH_SIZE ' + (mb * 1024));
        return send({ seq, result: { ok: true, mb } });
      }
      send({ seq, error: 'unknown api: ' + api });
    } catch (e) {
      send({ seq, error: String(e.message || e) });
    }
  }
  server.on('upgrade', (req, socket) => {
    try {
      const pathname = (req.url || '').split('?')[0];
      if (pathname !== '/ws') { try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); } catch (e) {} return socket.destroy(); }
      const key = req.headers['sec-websocket-key'];
      if (!key) return socket.destroy();
      if (wsClients.size >= 8) return socket.destroy();          
      const accept = require('crypto').createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      socket.setNoDelay(true);
      socket.setTimeout(0);
      wsClients.add(socket);
      let buf = Buffer.alloc(0);
      let frag = null;                                            
      const cleanup = () => { wsClients.delete(socket); try { socket.destroy(); } catch (e) {} };
      socket.on('error', cleanup);
      socket.on('close', cleanup);
      socket.on('data', (chunk) => {
        gbClientSeenAt = Date.now();       
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (true) {
          const f = wsParseFrame(buf);
          if (!f) break;
          buf = f.rest;
          if (f.opcode === 0x8) {                                 
            try { socket.write(Buffer.from([0x88, 0x00])); } catch (e) {}
            return cleanup();
          }
          if (f.opcode === 0x9) {                                 
            try { socket.write(Buffer.concat([Buffer.from([0x8A, f.payload.length & 0x7f]), f.payload])); } catch (e) {}
            continue;
          }
          if (f.opcode === 0xA) continue;                         
          if (f.opcode === 0x1 || f.opcode === 0x2) {
            frag = f.fin ? Buffer.from(f.payload) : { chunks: [Buffer.from(f.payload)] };
          } else if (f.opcode === 0x0 && frag) {
            if (Buffer.isBuffer(frag)) { frag = Buffer.from(f.payload); } 
            else { frag.chunks.push(f.payload); }
          } else { continue; }
          if (Buffer.isBuffer(frag) && (f.fin || f.opcode === 0x1 || f.opcode === 0x2)) {
            const msg = frag; frag = null;
            handleWsMessage(socket, msg);
          } else if (frag && frag.chunks && f.fin && f.opcode === 0x0) {
            const msg = Buffer.concat(frag.chunks); frag = null;
            handleWsMessage(socket, msg);
          }
        }
      });
    } catch (e) { try { socket.destroy(); } catch (e2) {} }
  });
  
  setInterval(() => {
    for (const s of wsClients) {
      try { s.write(Buffer.from([0x89, 0x00])); } catch (e) { wsClients.delete(s); try { s.destroy(); } catch (e2) {} }
    }
  }, 20000).unref();

  gbParentPid = parseInt(process.env.GB_PARENT_PID || '0', 10) || 0;
  if (GB_IS_BACKEND && gbParentPid) {
    setInterval(() => {
      if (gbPidAlive(gbParentPid)) { gbHostGoneAt = 0; return; }
      if (!gbHostGoneAt) gbHostGoneAt = Date.now();
      if (Date.now() - gbClientSeenAt < 60000) { gbHostGoneAt = Date.now(); return; }  
      server.getConnections((err, n) => {
        if (err) return;
        if (n > 0) { gbHostGoneAt = Date.now(); return; }     
        if (Date.now() - gbHostGoneAt > 60000) {
          log('[lifecycle] host overlay is gone and no clients for 60s -> exiting\n');
          try { process.exit(0); } catch (eExit) {}
        }
      });
    }, 3000).unref();
    setInterval(() => {
      if (Date.now() - gbClientSeenAt > 15 * 60 * 1000) {
        log('[lifecycle] backend engine: no client traffic for 15min -> exiting (anti-zombie belt)\n');
        try { process.exit(0); } catch (eExit) {}
      }
    }, 60000).unref();
  }

  server.listen(PORT, '127.0.0.1', () => {
    log('\n==============================================================\n');
    log('  Gomoku engine running: http://127.0.0.1:' + PORT + '  (+ ws://…/ws)\n');
    log('==============================================================\n');
    
    if (!GB_IS_BACKEND) {
      try { require('child_process').exec('start "" "http://127.0.0.1:' + PORT + '/"' ); } catch (e) {}
    } else {
      log('[backend] spawned by desktop assistant in background, not opening browser\n');
    }
  });
})();
