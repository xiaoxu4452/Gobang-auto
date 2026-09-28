/* ============================================================================
 * engine-ai.js —— 练习器**页面内** AI 引擎（2026-09-19 架构改造）
 * 把 engine-server.js（Node + :8964 HTTP）的核心原样搬进 WebView2 的 Worker：
 *   · importScripts 加载 rapfi-multi（pthreads wasm），COOP/COEP 下 SAB 多线程，
 *     棋力与原 :8964 引擎完全同源（同一份 wasm + 同一套命令/解析）。
 *   · 三车道：main = 单实例主搜（吃满所选核心数与大哈希），sub/fwd = 各 1 线程视图小实例。
 *   · 协议：START 15 → (1.5s 等 pthread 派生) → INFO 配置 → 每局 YXBOARD/YXNBEST。
 *   · 解析：INFO PV / MESSAGE (n) 流 / Depth 摘要 / Speed 汇总 / FORBID（含
 *     文本着法 1 基顶原点、数字底原点 0 基的两套坐标约定 —— 镜像坑见原文件）。
 * 主线程桥（calc.js 的 LocalAI）只做 new Worker + 消息收发；本文件不碰 UI。
 * 断线/失败：任何 boot 失败都会 postMessage 给主线程 → 主线程按「引擎未就绪」旧路径走。
 * ============================================================================
 */
'use strict';

var SIZE = 15;
// rapfi 资源基址：宿主 ResHandler 从 exe 旁 resources/ 供给（/ai/rapfi-multi.*）。
var AI_BASE = (function () {
  try { return new URL('/ai/', self.location.origin).href; }
  catch (e) { return '/ai/'; }
})();

// ---------------- 原生 Rapfi 车道（★ 仅纯训练器版）----------------
// 纯训练器版把页面里的 rapfi **WASM** 换成**原生 C++ rapfi**：宿主（Trainer exe）在 exe 旁的
// rapfi-native/ 里起 RapfiEngine-avx512.exe / -avx2.exe，并通过**同源 HTTP**（:8965）桥接命令行
// 与输出行（Worker 里拿不到 chrome.webview，所以走 HTTP 而不是 postMessage）。
//
// 为什么值得换（这也是「提升最高智力」的正路）：
//   · WASM 只有 simd128（128 位）+ SAB/pthread 调度开销 + wasm32 地址空间上限；
//   · 原生可用 AVX512+VNNI（本机 CPU 实测支持）、真 OS 线程、想吃多少哈希吃多少。
//   同样的时间预算下搜得更深 → 棋力更高。权重与 WASM 版**同一份**（同一套 mix9svq + config），
//   所以分数的提升干净地来自「原生 + SIMD + 线程 + 内存」，不是偷换了网络。
//
// 三合一版不部署 rapfi-native/ → status.available=false → 原样走下面的 WASM 路径。
var NATIVE = { probed: false, ok: false, variant: '', cpus: 0, memMB: 0 };
// ★ 廿八轮（2026-09-24 用户要求）：**纯训练器版不再带 WASM** —— 构建期往本文件顶部注入
//   `var GB_NO_WASM = true;`（见 tools/release-calculator.sh），原生引擎不可用时直接明确报
//   「本机不支持」，而不是静默回落到一份根本不存在的 WASM（404 → 半死不活）。三合一版不注入
//   （undefined → false），WASM 回落路径原样保留。
var GB_NO_WASM = (typeof GB_NO_WASM !== 'undefined') ? GB_NO_WASM : false;
function probeNative() {
  if (NATIVE.probed) return Promise.resolve(NATIVE.ok);
  NATIVE.probed = true;
  return fetch('/engine/status', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      NATIVE.ok = !!(j && j.available);
      NATIVE.variant = (j && j.variant) || '';
      NATIVE.cpus = (j && j.cpus) | 0;
      NATIVE.memMB = (j && j.memMB) | 0;
      return NATIVE.ok;
    })
    .catch(function () { return false; });   // 宿主没这条路由（旧 exe）→ 静默回落 WASM
}
/** ★★ 2026-09-25 新连接后端（用户要求「用合理高效的手段重新构建连接的后端」）。
 *  旧后端：Worker → HTTP POST :8965/engine/cmd 发令；Worker 每 **15ms** fetch
 *  /engine/out?since= 轮询取输出。纯训练器版 3 个车道 ≈ **200 次 HTTP/秒**常驻，
 *  每次都是 accept + 线程 + HTTP 解析 + JSON 编码 + fetch 往返；而且输出要等轮询才到
 *  （0~15ms + Worker 解析窗 0~60ms），引擎刚想完的那一手总是晚一拍才落到界面上。
 *  新后端：**事件驱动推模式** ——
 *    Worker --postMessage--> 主线程 --chrome.webview.postMessage--> 宿主
 *    宿主读线程拿到引擎输出 --PostMessage--> 宿主主线程 --PostWebMessageAsJson--> 页面
 *    → 主线程 --postMessage--> Worker（进 lane.outBuf）
 *  零 HTTP、零轮询、零常驻请求；引擎安静时一条消息都不产生，输出**到即推**。
 *  Worker 拿不到 chrome.webview，所以命令由主线程转发（`{type:'__host'}`），
 *  宿主回推的 engineOut 再由主线程转发回 Worker（`{type:'__relay'}`）。
 *  RELAY=false（浏览器里直接打开 / 老宿主）时自动退回原来的 HTTP 轮询，功能不丢。 */
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
/** 原生车道引擎：对外形状与 WASM 模块一致（sendCommand / terminate），输出行照老规矩进 lane.outBuf。 */
function makeNativeEngine(lane) {
  var cursor = 0, stopped = false, inFlight = 0, resets = 0, sawAlive = false;
  function feed(ls, alive) {
    for (var i = 0; i < ls.length; i++) {
      if (lane.captureLine) { try { if (lane.captureLine(ls[i]) === true) continue; } catch (e) {} }
      lane.outBuf += ls[i] + '\n';
    }
    if (alive === true) sawAlive = true;
    // ★ 只在「**曾经活过**、现在断了」时才恢复（引擎崩溃 / 被外部杀）：
    //   开机阶段 alive 恒为 false 是正常的（进程由 boot 的 START 拉起），
    //   过去无脑 reset 会与 boot 并发的 START/INFO 撞车 → 每车道各起 2 个进程（实测 6 个）。
    //   恢复也走 ensure（宿主侧有锁、已活则不重启），不再用强制重启的 reset。
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
    if (stopped || RELAY) return;      // ★ 走 WebView 通道后不再轮询
    if (inFlight > 0) { setTimeout(pump, 6); return; }   // 背压：同时只留一个在途请求
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
    __feed: feed,          // 主线程转发回来的 engineOut 由此入库
  };
}

// ---------------- 引擎实例与车道 ----------------
function makeLane(name) {
  return {
    name: name, engine: null, outBuf: '', captureLine: null,
    liveState: null, ready: false, waiters: [], tail: Promise.resolve(),
    bootOk: false,
  };
}
var LANES = { main: makeLane('main'), sub: makeLane('sub'), fwd: makeLane('fwd') };
// fwd = 前瞻推演专用车道（六轮，用户要求单独开任务加强智力）：独立实例互不排队
function pickLane(name) { return (name === 'sub') ? LANES.sub : (name === 'fwd') ? LANES.fwd : LANES.main; }

// ---------------- 配置（线程/哈希，单位与原 :8964 一致）----------------
var CFG = { threads: 0, hashKB: 0 };   // 0 = 按 CPU/内存自动
function hardwareThreads() {
  // 原生车道下用宿主报的**真实逻辑核数**（navigator.hardwareConcurrency 在 WebView2 里常被限流）
  if (NATIVE.ok && NATIVE.cpus > 0) return NATIVE.cpus;
  var n = (navigator.hardwareConcurrency || 4) | 0;
  return Math.max(2, n || 4);
}
function totalMemKB() {
  // navigator.deviceMemory 上限 8GB（Chrome 系约定）；原生车道可以问宿主拿真实物理内存，
  // 内存越大哈希越大 → 中后盘 / 长算杀越强，这正是原生版相对 WASM 的额外收益。
  if (NATIVE.ok && NATIVE.memMB > 0) return NATIVE.memMB * 1024;
  var gb = (navigator.deviceMemory || 8) | 0;
  if (gb < 2) gb = 2;
  return gb * 1024 * 1024;
}
function laneSpecs() {
  var cpuAll = hardwareThreads();
  // ★★ 2026-09-27 深夜（用户要求「取消投票，单实例满线程」—— 算力集中一路 = 智力上限）：
  //   main = **单实例主搜**，吃满用户在「核心数」里选的线程数（不再扣 reserve）；
  //   sub / fwd = 各 1 线程的小实例，专供热力 / 指导 / 前瞻等视图实时铺显（总线程仅 +2）。
  //   （历史：09-21 main 拿 60%；09-25 改「全核减 reserve」；本次更进一步 —— 满编。）
  var cpuN = CFG.threads > 0 ? Math.max(2, Math.min(CFG.threads, cpuAll))
                             : Math.max(2, cpuAll - 1);
  var mainT = cpuN;
  var subT = 1;
  var fwdT = 1;
  // ★ 原生车道：哈希上限从 2GB 提到 6GB，且只吃 1/4 物理内存（wasm 版是 1/3、上限 2GB）——
  //   原生进程没有 wasm32 地址空间天花板，但也不能把系统吃干，所以比例取更保守的 1/4。
  var hashCapKB = NATIVE.ok ? 6291456 : 2097152;
  var hashDiv = NATIVE.ok ? 4 : 3;
  var hashKB = CFG.hashKB > 0 ? Math.max(65536, Math.min(hashCapKB, CFG.hashKB))
                              : Math.max(262144, Math.min(hashCapKB, Math.floor(totalMemKB() / hashDiv)));
  // 哈希同样向 main 倾斜（★ 深夜口径：主搜吃满大头，视图小实例各 64MB）：
  // 置换表越大，中后盘重复局面命中越多 → 等效加深。
  var auxH = (hashKB >= 3 * 65536) ? 65536 : Math.max(64, Math.floor(hashKB / 3));
  var mainH = Math.max(64, hashKB - 2 * auxH);
  var subH = auxH;
  var fwdH = auxH;
  return [
    { lane: LANES.main, threads: mainT, hashKB: mainH },
    { lane: LANES.sub, threads: subT, hashKB: subH },
    { lane: LANES.fwd, threads: fwdT, hashKB: fwdH },
  ];
}

// ---------------- 输出解析（与 engine-server.js 逐字对齐）----------------
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
        // 文本着法 1 基顶原点（A1=左上）→ 面板 y = 行号-1（勿回退成 SIZE-n，镜像坑）
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

// ---------------- 棋盘工具 ----------------
function countStones(board) {
  var n = 0;
  for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) if (board[y][x] !== 0) n++;
  return n;
}
/** ★★ 2026-09-23 十六轮（用户报「白子让着黑子去赢」的根因修复）：
 *  YXBOARD 走完后 Rapfi 的 sideToMove = **最后一个 token 颜色的反色**。
 *  「黑先严格交替 + 多出子追加末尾」只在 |bn-wn| ≤ 1 的合法局面下与界面的
 *  「总子数奇偶定行棋方」一致；一旦子数不均衡（残局自由摆盘 / 识图 VC 补充子，
 *  例 30 黑 + 10 白），末尾必然是黑 → 引擎按**白方**出评估与着法，而界面把它
 *  标成黑子 —— 于是白方等于在替黑方行棋，「白子让着黑子赢」。
 *  实测（tools/_probe_stm.js，真实引擎）：bn=4/wn=4 → +M1（黑走 ✓）；
 *  bn=30/wn=10 → -M6（引擎认为白走，与界面相反 ✗）。
 *  修法：调用方显式给 side（1 黑 / 2 白），这里**重排 token 使末子颜色 = 3-side**，
 *  引擎的 sideToMove 就被强制等于 side。（0/undefined = 老行为，不动。） */
function toEngineMoveList(board, moveList, side) {
  // ★ 黑先严格交替 + 多出子追加末尾 + 引擎 y=0 在底（engineY = SIZE-1-panelY）。
  //   详细语义铁证见 engine-server.js 同名函数（SideFlag/PASS/评估视角，勿回退）。
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
/** 让引擎的 sideToMove = side：把**一个**颜色为 (3-side) 的 token 挪到末尾。
 *  · 末子颜色已经是 3-side → 原样返回；
 *  · 找不到该颜色的子（例：盘上只有黑子却要黑走）→ 做不到，原样返回（调用方须知情）；
 *  · 首 token 必须是黑（Rapfi 由它定 selfColor=BLACK），所以绝不挪走第 0 个。 */
function applySideToMove(out, side) {
  if (side !== 1 && side !== 2) return out;
  if (!out.length) return out;
  var wantLast = 3 - side;                       // 末子应为该色 → 引擎 stm = side
  if (out[out.length - 1][2] === wantLast) return out;
  var idx = -1, i;
  for (i = out.length - 1; i >= 1; i--) {        // 从后往前找（挪动最小），第 0 个留着定色
    if (out[i][2] === wantLast) { idx = i; break; }
  }
  if (idx < 0) return out;                       // 做不到 → 保持原样
  var m = out.splice(idx, 1)[0];
  out.push(m);
  return out;
}

// ---------------- 车道串行 / 发令 ----------------
function laneSerial(lane, action) {
  var run = lane.tail.then(action, action);
  lane.tail = run.catch(function () {});
  return run;
}
/** ★★ 廿七轮（2026-09-24）：一批命令必须**一次**发出去，绝不能逐条 fetch。
 *  为什么（这是「棋力不如网页版」+「禁手下白棋有概率下偏」的共同根因）：
 *  原生车道每条命令是一个独立 fetch POST —— 浏览器并发连接，**到达顺序不保证**。
 *  引擎侧（gomocup.cpp）`YXNBEST` 依赖 CheckBoardOK：boot 的 START 15 已建出 15x15 **空盘**，
 *  所以 YXNBEST 先到照样通过 → 引擎在**空盘**开始思考；随后 YXBOARD 才到 → 被
 *  `else if (thinking) return false` 拦截 → 这一手就是「空盘最佳点」≈ 天元附近（=「下偏」）。
 *  同理 INFO TIMEOUT_TURN / HASH_SIZE / RULE 乱序丢失 → 按错的时间/哈希/规则思考（棋力波动）。
 *  连珠（禁手）命令更多（RULE 切权重 + YXSHOWFORBID），乱序窗口更大 → 白棋「有概率」下偏。
 *  WASM 版命令是 Worker 内同步串行调用，零乱序 —— 这正是用户觉得原生版不如网页版的原因。
 *  修法：同一批命令 join('\n') 放进**一个** body 一次发（宿主 cmd 路由本来就是「\n 分隔一次写入」，
 *  WriteEnsured 顺序写 stdin，引擎按行顺序处理）。WASM 引擎没有乱序问题，保持逐条（接口语义不变）。 */
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

// ---------------- 等待搜索结果 ----------------
// ★ 2026-09-27（用户要求「仪表盘要有速度和节点等的表示」）：waitForMove 增加第 4/5 参
//   （liveId / liveTag）—— 搜索期间把引擎实时状态（速度 nps / 总节点 / 深度 / 最佳点）
//   **节流推送**给主线程（≥140ms 一帧，首帧立即），主线程的引擎仪表盘从此**边算边跳数**，
//   而不是等算完才一次性出结果。done / 超时之前再补一帧 searching:false 终结帧，
//   主线程据此把该车道从聚合里摘除。preheat 等后台任务传 liveTag 也能在仪表盘上标明身份。
function waitForMove(lane, budgetMs, wantTopN, liveId, liveTag) {
  return new Promise(function (resolve, reject) {
    var hardDeadline = Date.now() + Math.max(1000, budgetMs) + 8000;
    var pvs = { __cur: -1 };
    var lastLivePost = 0;                          // live 推送节流
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
        for (var li = 0; li < lvTop; li++) {
          var lvpv = pvs[li];
          var lvb0 = lvpv && lvpv.bestline && lvpv.bestline[0];
          if (lvpv && lvb0) live.pvs.push({ x: lvb0[0], y: lvb0[1], eval: lvpv.eval || '', depth: lvpv.depth || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || lvpv.nodes || 0, line: (lvpv.bestline || []).slice(0, 16) });
        }
        lane.liveState = live;
        // ★ 2026-09-27：实时仪表盘 —— 首帧立即、之后每 ≥140ms 一帧（postMessage 很轻，
        //   节流只为别让主线程 UI 刷新跟不上）。
        var nowMs = Date.now();
        if (liveId != null && nowMs - lastLivePost >= 140) {
          lastLivePost = nowMs;
          postLive(true);
        }
      }

      var out = [];
      for (var k = 0; k < wantTopN; k++) {
        var pv = pvs[k];
        var b0 = pv && pv.bestline && pv.bestline[0];
        if (pv && b0) {
          out.push({ x: b0[0], y: b0[1], winrate: (pv.winrate !== undefined && pv.winrate > 0) ? pv.winrate : 0.5, eval: pv.eval || '', depth: pv.depth || 0, speed: pvs.__speed || 0, nodes: pvs.__totalnodes || pv.nodes || 0, line: (pv.bestline || []).slice(0, 16) });
        }
      }
      var mbest = raw.match(/\bbest\s+(\d+)\s+(\d+)/);
      var chosen = (mbest ? [+mbest[1], SIZE - 1 - (+mbest[2])] : null) || pvs.__best || pvs.__final;
      var done = !!mbest || !!pvs.__final || /^\s*REJECT\s*$/m.test(raw);
      if (done) {
        clearInterval(timer);
        if (lane.liveState) lane.liveState.searching = false;
        postLive(false);                            // ★ 终结帧：主线程摘除本车道
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
        clearInterval(timer);
        if (lane.liveState) lane.liveState.searching = false;
        postLive(false);                            // ★ 终结帧（超时兜底路径）
        if (chosen || out.length) {
          if (!chosen) chosen = [out[0].x, out[0].y];
          resolve({ candidates: out, best: chosen, timeout: true });
        } else reject(new Error('Engine did not return a move within time limit'));
      }
    }, 60);
  });
}

// ---------------- 禁手点捕获 ----------------
// ★ 廿七轮：由「自己发 YXSHOWFORBID」改为「只挂 captureLine」—— YXSHOWFORBID 现在由 doAnalyze
//   并进主 body（顺序保证）。调用方必须**先**调本函数、**再**发送带 YXSHOWFORBID 的命令批。
//   返回 { promise }，resolve 时 captureLine 已摘除；FORBID 行迟迟不来也 900ms 兜底（给空数组）。
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

// ---------------- 分析 ----------------
var requestSeq = 0;
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
    // ★ 十六轮：显式行棋方（1 黑 / 2 白；0 = 老行为）——见 toEngineMoveList 的长注释。
    var side = (body.side === 1 || body.side === 2) ? body.side : 0;

    var t0 = Date.now();
    lane.liveState = { searching: true, t0: t0, cid: body.cid || '', best: null, speed: 0, nodes: 0, pvs: [] };

    var moves = toEngineMoveList(board, body.moveList, side);
    var cmd = 'YXBOARD';
    for (var i = 0; i < moves.length; i++) cmd += ' ' + moves[i].join(',');
    cmd += ' DONE';
    lane.outBuf = '';

    // ★ 一批命令**一次**发（顺序保证，见 sendLaneCmds 注释）：
    //   INFO×4 → YXBOARD → [YXSHOWFORBID] → YXNBEST。禁手查询并入主 body —— 过去 YXSHOWFORBID
    //   单独 fetch 是又一个乱序源；且 captureLine 必须先挂上再发送（FORBID 行在 YXNBEST
    //   开始搜索**之前**就由引擎输出了，晚了就错过，只能等 900ms 超时空手而归）。
    var cmds = ['INFO RULE ' + rule, 'INFO TIMEOUT_TURN ' + turnMs,
                'INFO TIMEOUT_MATCH ' + matchMs, 'INFO TIME_LEFT ' + timeLeft, cmd];
    var forbidCap = null;
    if (rule === 2 || rule === 4) { cmds.push('YXSHOWFORBID'); forbidCap = armForbidCapture(lane); }
    cmds.push('YXNBEST ' + effTopN);
    var forbidP = forbidCap ? forbidCap.promise : Promise.resolve([]);
    sendLaneCmds(lane, cmds);
    return forbidP.catch(function () { return []; }).then(function (forbid) {
      return waitForMove(lane, Math.min(timeLeft, turnMs + 1500), effTopN, body.liveId, body.tag).then(function (result) {
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

// ---------------- 启动（等价原 boot：START → 1.5s → INFO 配置 → ready）----------------
// ★ rapfi-multi.js 必须先 importScripts 进来 —— 它顶层 `var Rapfi=...` 定义工厂。
//   原 engine-server.js 在 Node 里用 eval+module 包装加载；Worker 里就是 importScripts。
//   缺了这一步 `Rapfi is not defined`，Worker 直接静默死掉（2026-09-19 实际踩过）。
// ★★ resources/rapfi-multi.wasm 必须是 **SIMD(v128)+pthreads** 构建（2026-09-21 用户明确
//   要求「AI 引擎使用强 SIMD 加速」）：COOP/COEP → SAB 共享内存多线程 + v128 向量化搜索。
//   换 wasm 时严禁换回非 SIMD 构建 —— test-calculator.js 有字节级断言（0xFD/0xFE 操作码
//   密度）守着这条。
var rapfiLoaded = false;
function ensureRapfiLoaded() {
  if (rapfiLoaded) return;
  importScripts(AI_BASE + 'rapfi-multi.js');
  rapfiLoaded = true;
}
function createLaneEngine(lane) {
  // ★ 原生优先：纯训练器版带 rapfi-native/ 时，页面**完全不再加载 WASM**（省掉 38MB 模型下载
  //   与 wasm 编译），直接连宿主的原生引擎进程。同理 native 也不需要 importScripts。
  if (NATIVE.ok) {
    lane.engine = makeNativeEngine(lane);
    return Promise.resolve(lane.engine);
  }
  if (GB_NO_WASM) return Promise.reject(new Error('NO_NATIVE_NO_WASM'));   // 本版没有 WASM 可回落
  ensureRapfiLoaded();
  return Rapfi({
    locateFile: function (f) { return AI_BASE + f; },
    // ★ pthread 子 worker 用同一份 rapfi js 起线程 —— 不指明的话 _scriptName 会指向
    //   本文件（engine-ai.js），pthread worker 就会错跑我们的消息协议（必须传）。
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

function bootAll() {
  var specs = laneSpecs();
  var pending = [];
  for (var i = 0; i < specs.length; i++) {
    (function (sp) {
      pending.push(
        createLaneEngine(sp.lane).then(function () {
          // 多线程 WASM 版要等 pthread worker 派生完再下发配置（engine-server 同款 1.5s）。
          // 原生进程没有这一步（线程由引擎自己起），只在启动瞬间留一点点余量。
          return new Promise(function (r) { setTimeout(r, NATIVE.ok ? 60 : 1500); }).then(function () {
            if (!sp.lane.engine) return;
            // ★ 一批配置一次发（顺序保证，见 sendLaneCmds 注释）：START 必须最先（引擎由它定盘面）。
            sendLaneCmds(sp.lane, ['START ' + SIZE,
              'INFO THREAD_NUM ' + sp.threads,
              'INFO CAUTION_FACTOR 3',
              'INFO STRENGTH 100',
              'INFO SHOW_DETAIL 3',
              'INFO PONDERING 0',
              'INFO SWAPABLE 0',
              'INFO HASH_SIZE ' + sp.hashKB]);
            sp.lane.bootOk = true;
            releaseLane(sp.lane);
            // ★★ 十七轮（用户报「首次加载/首次计算太慢」）：**开机热身** —— 空盘 0.5s 一手，
            //   把 NNUE 权重加载、哈希建页、首次搜索的初始化开销全部在启动期付掉；
            //   用户点的第一手就不再吃冷启动。这是把**固定开销前置**，不是堆算力。
            laneSerial(sp.lane, function () {
              var wb = [];
              for (var wy = 0; wy < SIZE; wy++) { var row = []; for (var wx = 0; wx < SIZE; wx++) row.push(0); wb.push(row); }
              return doAnalyze({ board: wb, moveList: [], matchMs: 600000, turnMs: 500, timeUsedMs: 0,
                topN: 1, rule: 0, cid: 'warmup', lane: sp.lane.name, side: 1 }, sp.lane)
                .catch(function () {});          // 热身失败无关紧要，别影响可用性
            });
          });
        }, function (e) {
          // main 失败致命（post 给主线程按未就绪处理）；sub 失败不致命
          if (sp.lane === LANES.main) throw e;
        })
      );
    })(specs[i]);
  }
  return Promise.all(pending);
}

// ---------------- 主线程消息协议 ----------------
var booted = false;
self.onmessage = function (e) {
  var d = e.data || {};
  if (d.type === 'boot') {
    if (booted) return;
    booted = true;
    if (d.threads) CFG.threads = d.threads;
    if (d.hashKB) CFG.hashKB = d.hashKB;
    // ★ 新后端：主线程把「能不能走 WebView 消息通道」随 boot 一起给下来。
    //   能走 → 命令与输出都走 push，HTTP 轮询那条 pump 直接不启动。
    RELAY = !!d.relay;
    // ★ 先问宿主有没有原生引擎（顺带拿到真实核数/内存，用于定线程与哈希），再决定走原生还是 WASM。
    //   纯训练器版（GB_NO_WASM）原生不可用 = 没有备用引擎 → 直接给出明确失败，让 UI 能提示用户，
    //   而不是走到 createLaneEngine 里 importScripts 一个 404 的 rapfi-multi.js 静默半死。
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
    laneSerial(lane, function () { return doAnalyze(d.body, lane); })
      .then(function (result) { self.postMessage({ type: 'done', id: d.id, result: result }); },
            function (err) { self.postMessage({ type: 'fail', id: d.id, message: String(err && err.message || err) }); });
  } else if (d.type === '__relay') {
    // ★ 新后端回程：宿主推来的引擎输出，按车道分发进各自的 outBuf（见 makeNativeEngine 注释）。
    var pl = d.payload || {};
    if (pl.type === 'engineOut' && Array.isArray(pl.lanes)) {
      for (var ri = 0; ri < pl.lanes.length; ri++) {
        var ent = pl.lanes[ri];
        var ln = pickLane(ent && ent.lane);
        if (ln && ln.engine && ln.engine.__feed) ln.engine.__feed(ent.lines || [], ent.alive);
        else if (ln) {   // 引擎对象还没建好（输出早于 boot）：先攒着，别丢
          for (var rj = 0; rj < (ent.lines || []).length; rj++) ln.outBuf += ent.lines[rj] + '\n';
        }
      }
    }
  } else if (d.type === 'hash') {
    // 热改哈希（线程数变更由主线程 terminate 重建 Worker 解决）
    // ★ 与 laneSpecs() 同一套比例（★ 深夜口径：main 吃满大头，sub/fwd 各 64MB）
    CFG.hashKB = d.hashKB;
    var total = Math.max(64, CFG.hashKB | 0);
    var splitOf = function (which) {
      var aux = (total >= 3 * 65536) ? 65536 : Math.max(64, Math.floor(total / 3));
      if (which === 'sub') return aux;
      if (which === 'fwd') return aux;
      return Math.max(64, total - 2 * aux);
    };
    [LANES.main, LANES.sub, LANES.fwd].forEach(function (lane) {
      if (lane.engine && lane.bootOk) {
        try { lane.engine.sendCommand('INFO HASH_SIZE ' + splitOf(lane.name)); } catch (err) {}
      }
    });
  }
};
