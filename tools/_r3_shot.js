// ★ 2026-09-20 三轮收尾：练习器交互截图（CDP 直连）。
// 起 EXE（带 CDP 端口 + no-sandbox），等主窗页面 ready，然后：
//   ① 主窗整页截图（anbtns 新布局 / 默认两卡 / 护眼底色）
//   ② 点「历史」开抽屉 → 截图（全高通底侧栏形态）
//   ③ 页面内摆「对手活三 + 我方活三」局面跑 anaDefend → 截图（-M4/-M4/+M3 徽标胶囊）
//   ④ 铺三枚中性圈（多点分析样式）→ 截图
// 全部走 CDP：Runtime.evaluate 点按钮/摆子，Page.captureScreenshot 出 PNG。
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = 'C:/Users/harve/Desktop/Gobang auto';
var EXE = path.join(ROOT, 'desktop-calculator/build/Desktop GomokuTrainer.exe');

function log(s) { console.log('[shot] ' + s); }
function killTrainer() {
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
}

function fetchTargets() {
  return new Promise(function (res) {
    var req = http.get({ host: '127.0.0.1', port: 9333, path: '/json/list', timeout: 2000 }, function (r) {
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
        setTimeout(loop, 700);
      });
    })();
  });
}

// ---- 最小 WebSocket 客户端（够 CDP 用：文本帧 + 掩码 + 长度扩展 + 分片续帧 + ping/pong）----
function wsConnect(url) {
  return new Promise(function (res, rej) {
    var key = crypto.randomBytes(16).toString('base64');
    var req = http.get(url.replace(/^ws:/, 'http:'), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', function (r, socket) {
      var buf = Buffer.alloc(0), fragments = null, fragOp = 0;
      var pending = {}, nid = 0, onmsg = null;
      function emit(obj) {
        if (obj.id && pending[obj.id]) { var f = pending[obj.id]; delete pending[obj.id]; f(obj); }
        else if (onmsg) onmsg(obj);
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
          if (op === 9) { socket.write(frame(10, payload)); continue; }        // ping → pong
          if (op === 8) { try { socket.end(); } catch (e) {} continue; }
          if (op === 1 || op === 2) {
            if (fragments) { fragments = null; }                               // 不完整分片后新帧：丢弃旧的
            if (buf[0] === undefined) {} // no-op
            handle(op, payload);
          } else if (op === 0) {
            if (fragments) { fragments = Buffer.concat([fragments, payload]); if (buf[0] !== undefined) {} }
            else fragments = payload;
            // 结束位
            if ((buf[0] & 0x80) !== 0 || true) {} // 简化：CDP 文本帧基本不分片，直接在 fin 位处理
            handle(fragOp || 1, fragments); fragments = null;
          }
        }
        function handle(op2, data) {
          var s = data.toString('utf8');
          try { emit(JSON.parse(s)); } catch (e) {}
        }
      }
      socket.on('data', feed);
      socket.on('error', function (e) { try { Object.keys(pending).forEach(function (k) { pending[k]({ error: { message: String(e) } }); }); } catch (x) {} });
      function frame(op, payload) {
        var mask = crypto.randomBytes(4), h;
        if (payload.length < 126) h = Buffer.from([0x80 | op, 0x80 | payload.length]);
        else if (payload.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(payload.length), 2); }
        var body = Buffer.from(payload);
        for (var i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        return Buffer.concat([h, mask, body]);
      }
      res({
        send: function (method, params, timeoutMs) {
          return new Promise(function (resolve, reject) {
            var id = ++nid; pending[id] = resolve;
            var timer = setTimeout(function () { delete pending[id]; reject(new Error('cdp timeout: ' + method)); }, timeoutMs || 15000);
            socket.write(frame(1, Buffer.from(JSON.stringify({ id: id, method: method, params: params || {} }), 'utf8')), function () {});
            // 包一层：resolve 时清 timer
            var orig = pending[id];
            pending[id] = function (r) { clearTimeout(timer); resolve(r); };
            void orig;
          });
        },
      });
    });
    req.on('error', rej);
    req.on('response', function (r) { rej(new Error('no upgrade: ' + r.statusCode)); });
  });
}

function evalJs(cdp, expr) {
  return cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 20000)
    .then(function (r) {
      var ro = r && r.result && r.result.result;         // CDP 响应：result.result = RemoteObject
      if (!ro || ro.value === undefined) log('evalJs raw: ' + JSON.stringify(r).slice(0, 500));
      return ro && ro.value;
    });
}
function shot(cdp, file) {
  return cdp.send('Page.captureScreenshot', { format: 'png' }, 30000).then(function (r) {
    var data = r && r.result && r.result.data;
    if (!data) { log('shot raw: ' + JSON.stringify(r).slice(0, 300)); throw new Error('no screenshot data'); }
    fs.writeFileSync(path.join(ROOT, 'tools', file), Buffer.from(data, 'base64'));
    log('saved ' + file);
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(function main() {
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333 --no-sandbox',
  });
  killTrainer();
  var child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env: env });
  child.unref();
  log('spawned pid=' + child.pid);
  sleep(2500).then(function () { return pollTargets(function (t) { return t.type === 'page' && /calc\.html/.test(t.url) && t.url.indexOf('rv=1') < 0; }, 45000); })
    .then(function (t) {
      log('main page target: ' + t.url);
      return sleep(3500).then(function () { return wsConnect(t.webSocketDebuggerUrl); });
    })
    .then(function (cdp) {
      return cdp.send('Page.enable', {}).then(function () { return cdp; });
    })
    .then(function (cdp) {
      return evalJs(cdp, '({t: document.title, ready: !!window.G, moves: window.G ? G.moves.length : -1})')
        .then(function (v) { log('page state: ' + JSON.stringify(v)); if (!v || !v.ready) throw new Error('page not booted'); })
        .then(function () { return shot(cdp, '_shot_1_main.png'); })
        .then(function () {
          return evalJs(cdp,
            '(function(){ return {' +
            '  hasBtn: !!document.getElementById("btn_history"),' +
            '  openDrawer: typeof openDrawer,' +
            '  closeDrawer: typeof closeDrawer,' +
            '  elsN: Object.keys(window.els||{}).length,' +
            '  elsHist: !!window.els || ("btn_history" in (window.els||{}))' +
            '}; })()');
        })
        .then(function (v) { log('diag: ' + JSON.stringify(v)); })
        .then(function () { return evalJs(cdp, 'openDrawer("hist"); "drawer-opened"'); })
        .then(function () { return sleep(900); })
        .then(function () { return shot(cdp, '_shot_2_drawer.png'); })
        .then(function () { return evalJs(cdp, 'closeDrawer(); "drawer-closed"'); })
        .then(function () { return sleep(400); })
        .then(function () {
          return evalJs(cdp,
            '(function(){' +
            '  for (var y=0;y<G.board.length;y++) for (var x=0;x<G.board.length;x++) G.board[y][x]=0;' +
            '  G.moves = [];' +
            '  [[3,7],[4,7],[5,7]].forEach(function(p){ G.board[p[1]][p[0]] = 2; });' +
            '  [[3,9],[4,9],[5,9]].forEach(function(p){ G.board[p[1]][p[0]] = 1; });' +
            '  G.moves.push({x:3,y:9,c:1}); G.moves.push({x:5,y:7,c:2});' +
            '  anaDefend(); paint();' +
            '  return (G.ana.marks||[]).slice(0,4).map(function(m){return m.badge+"@"+m.x+","+m.y}).join(" | ");' +
            '})()');
        })
        .then(function (v) { log('defend top4: ' + v); return sleep(600); })
        .then(function () { return shot(cdp, '_shot_3_defend.png'); })
        .then(function () {
          // ★ 四轮：真实跑一次 anaNbest（页面内 Worker 引擎）—— 验证 inline 多彩圆圈
          //   （名次数字在上、评估在下，融进同一枚圆；ANA_PAL 名次色回归）。
          return evalJs(cdp,
            '(function(){' +
            '  for (var y=0;y<G.board.length;y++) for (var x=0;x<G.board.length;x++) G.board[y][x]=0;' +
            '  G.moves = [];' +
            '  [[7,7],[8,8],[6,8]].forEach(function(p){ G.board[p[1]][p[0]] = 1; });' +
            '  [[6,6],[8,6]].forEach(function(p){ G.board[p[1]][p[0]] = 2; });' +
            '  [{x:7,y:7,c:1},{x:6,y:6,c:2},{x:8,y:8,c:1},{x:8,y:6,c:2},{x:6,y:8,c:1}]' +
            '    .forEach(function(m){ G.moves.push(m); });' +
            '  return anaNbest().then(function(){' +
            '    return G.ana.marks.map(function(m){' +
            '      return m.badge + "/" + m.label + "@" + m.x + "," + m.y + (m.inline ? "!inline" : "");' +
            '    }).join(" | ");' +
            '  });' +
            '})()');
        })
        .then(function (v) { log('nbest marks: ' + v); return sleep(600); })
        .then(function () { return shot(cdp, '_shot_4_nbest.png'); })
        .then(function () {
          // ★ 五轮：前瞻演示 —— 摆残局开前瞻，等推演子逐手铺开（六轮：专用 fwd 车道）
          return evalJs(cdp,
            '(function(){' +
            '  for (var y=0;y<G.board.length;y++) for (var x=0;x<G.board.length;x++) G.board[y][x]=0;' +
            '  G.moves = [];' +
            '  G.ana.marks = []; G.ana.rows = []; renderAna("");' +
            '  [[7,7,1],[7,8,2],[8,6,1],[6,8,2],[8,8,1],[6,6,2],[5,9,1]].forEach(function(p){' +
            '    G.board[p[1]][p[0]] = p[2]; G.moves.push({x:p[0],y:p[1],c:p[2]}); });' +
            '  var pre = {over: G.over, rv: RV_MODE, review: !!G.review, moves: G.moves.length,' +
            '    wasOn: G.fwd.on, paused: S.paused, mode: S.mode};' +
            '  fwdToggle();' +
            '  return JSON.stringify({pre: pre, post: {on: G.fwd.on, busy: G.fwd.busy,' +
            '    base: G.fwd.base}});' +
            '})()');
        })
        .then(function (v) { log('fwd toggle: ' + v); })
        .then(function () { return sleep(9000); })
        .then(function () {
          return evalJs(cdp, '({on: G.fwd.on, line: G.fwd.line.length,' +
            ' chips: document.querySelectorAll("#fwdSeq .fwc").length,' +
            ' msg: (document.getElementById("fwdMsg")||{}).textContent || ""})');
        })
        .then(function (v) { log('fwd state: ' + JSON.stringify(v)); })
        .then(function () { return shot(cdp, '_shot_5_fwd.png'); })
        .then(function () {
          // ★ 六轮：点击代码 = 选中（确定键变色）→ 点确定 → 后面的代码变浅、结果保留
          return evalJs(cdp,
            '(function(){' +
            '  var chips = document.querySelectorAll("#fwdSeq .fwc");' +
            '  if (!chips.length) return "no-chips";' +
            '  chips[Math.min(5, chips.length - 1)].click();' +   // 选中第 6 手
            '  return "selected";' +
            '})()');
        })
        .then(function (v) { log('fwd select: ' + v); return sleep(500); })
        .then(function () { return shot(cdp, '_shot_6_fwdsel.png'); })
        .then(function () {
          return evalJs(cdp,
            '(function(){' +
            '  var ok = document.getElementById("btn_fwd_ok");' +
            '  if (!ok) return "no-ok"; ok.click(); return "committed";' +
            '})()');
        })
        .then(function (v) { log('fwd commit: ' + v); return sleep(900); })
        .then(function () {
          return evalJs(cdp, '({moves: G.moves.length, committed: G.fwd.committed,' +
            ' hold: G.fwd.hold, line: G.fwd.line.length,' +
            ' dim: document.querySelectorAll("#fwdSeq .fwc.dim").length})');
        })
        .then(function (v) { log('fwd committed state: ' + JSON.stringify(v)); })
        .then(function () { return shot(cdp, '_shot_7_fwdcommit.png'); })
        .then(function () {
          // ★ 六轮补丁：键盘 ← / → 控制前瞻步进（dispatch 真实 keydown 验证）
          return evalJs(cdp,
            '(function(){' +
            '  var before = G.fwd.idx;' +
            '  window.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowLeft", bubbles: true}));' +
            '  var afterL = G.fwd.idx;' +
            '  window.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));' +
            '  var afterR = G.fwd.idx;' +
            '  return JSON.stringify({before: before, afterL: afterL, afterR: afterR});' +
            '})()');
        })
        .then(function (v) { log('fwd key: ' + v); })
        .then(function () {
          // ★ 六轮补丁：英文模式实拍（前瞻框小字号适配验证）
          return evalJs(cdp,
            '(function(){ S.lang="en"; applyLang(); return document.body.getAttribute("data-lang"); })()');
        })
        .then(function (v) { log('lang: ' + v); return sleep(400); })
        .then(function () { return shot(cdp, '_shot_8_en.png'); })
        .then(function () { log('ALL SHOTS DONE'); });
    })
    .then(function () { killTrainer(); process.exit(0); })
    .catch(function (e) { log('ERROR: ' + (e && e.message || e)); killTrainer(); process.exit(1); });
})();
