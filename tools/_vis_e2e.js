// ★ 识图窗 e2e 探针：起 EXE → 点「识图」开窗 → 真图点「识别」→ 计时到结果/失败。
// 复现用户报告「识别很久然后失败」；顺带验证宿主 [vis] 日志路径。
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = 'C:/Users/harve/Desktop/Gobang auto';
var EXE = path.join(ROOT, 'desktop-calculator/build/Desktop GomokuTrainer.exe');

function log(s) { console.log('[vis-e2e] ' + s); }
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
function wsConnect(url) {
  return new Promise(function (res, rej) {
    var key = crypto.randomBytes(16).toString('base64');
    var req = http.get(url.replace(/^ws:/, 'http:'), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', function (r, socket) {
      var buf = Buffer.alloc(0), pending = {}, nid = 0;
      function frame(op2, pl) {
        var mask = crypto.randomBytes(4), h;
        if (pl.length < 126) h = Buffer.from([0x80 | op2, 0x80 | pl.length]);
        else if (pl.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op2; h[1] = 0x80 | 126; h.writeUInt16BE(pl.length, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x80 | op2; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(pl.length), 2); }
        var body = Buffer.from(pl);
        for (var i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        return Buffer.concat([h, mask, body]);
      }
      socket.on('data', function feed(chunk) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          var op = buf[0] & 0x0f, len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          var payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (op === 9) { socket.write(frame(10, payload)); continue; }
          if (op === 8) { try { socket.end(); } catch (e) {} continue; }
          if (op === 1 || op === 2) { try { emit(JSON.parse(payload.toString('utf8'))); } catch (e) {} }
        }
        function emit(obj) {
          if (obj.id && pending[obj.id]) { var f = pending[obj.id]; delete pending[obj.id]; f(obj); }
        }
      });
      res({
        send: function (method, params, timeoutMs) {
          return new Promise(function (resolve, reject) {
            var id = ++nid;
            var timer = setTimeout(function () { delete pending[id]; reject(new Error('cdp timeout: ' + method)); }, timeoutMs || 15000);
            pending[id] = function (r) { clearTimeout(timer); resolve(r); };
            socket.write(frame(1, Buffer.from(JSON.stringify({ id: id, method: method, params: params || {} }), 'utf8')), function () {});
          });
        },
      });
    });
    req.on('error', rej);
  });
}
function evalJs(cdp, expr, timeoutMs) {
  return cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs || 20000)
    .then(function (r) {
      var ro = r && r.result && r.result.result;
      if (r && r.result && r.result.exceptionDetails) log('EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return ro && ro.value;
    });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(function main() {
  // ★ 探针卫生：清掉 WebView2 的 HTTP 缓存（否则升级后的新 calc.js 可能被旧缓存压住，
  //   页面跑旧代码 —— 2026-09-21 实测两次）。这是 build 产物目录，删了会自动重建。
  var cacheDir = path.join(ROOT, 'desktop-calculator/build/GomokuTrainer resources/EBWebView');
  try { fs.rmSync(path.join(cacheDir, 'Default/Cache'), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(cacheDir, 'Default/Code Cache'), { recursive: true, force: true }); } catch (e) {}
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333 --no-sandbox',
  });
  killTrainer();
  var child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env: env });
  child.unref();
  log('spawned pid=' + child.pid);
  sleep(2500).then(function () {
    return pollTargets(function (t) { return t.type === 'page' && /calc\.html/.test(t.url) && t.url.indexOf('rv=1') < 0 && t.url.indexOf('vis=1') < 0; }, 45000);
  }).then(function (t) {
    log('main target: ' + t.url);
    return sleep(3000).then(function () { return wsConnect(t.webSocketDebuggerUrl); });
  }).then(function (cdp) {
    // 等 G 就绪 → 点「识图」
    return evalJs(cdp, '(function(){ if(!window.G) return "NO_G"; if(!els.btn_vis) return "NO_BTN"; els.btn_vis.click(); return "CLICKED"; })()');
  }).then(function (st) {
    log('main vis click: ' + st);
    return pollTargets(function (t) { return t.type === 'page' && /vis=1/.test(t.url); }, 30000);
  }).then(function (t) {
    log('vis target: ' + t.url);
    return sleep(2500).then(function () { return wsConnect(t.webSocketDebuggerUrl); });
  }).then(function (cdp) {
    return evalJs(cdp, '(function(){ if(!window.VIS) return "NO_VIS"; window.__t0 = Date.now(); return "OK busy=" + VIS.busy; })()').then(function (st) {
      log('vis page state: ' + st);
      if (st === 'NO_VIS') throw new Error('vis page not booted');
      return cdp;
    });
  }).then(function (cdp) {
    // 塞一张**带棋子**的图（_shot_3_defend.png，引擎直测 5 黑 3 白）→
    // ★ 不点任何键：自动识别（2026-09-21 新特性）应当直接开跑
    var b64 = fs.readFileSync(path.join(ROOT, 'tools/_shot_3_defend.png')).toString('base64');
    return evalJs(cdp, 'visAddImage("data:image/png;base64,' + b64 + '", true)').then(function (ok) {
      log('image added: ' + ok + ' (auto-recognize should kick in)');
    }).then(function () {
      function poll() {
        return evalJs(cdp, '(function(){ var m = document.getElementById("visMsg"); return {msg: m ? m.textContent : null, busy: VIS.busy, el: Date.now() - window.__t0}; })()').then(function (st) {
          log('poll ' + st.el + 'ms busy=' + st.busy + ' msg=' + st.msg);
          if (!st.busy && st.msg && st.msg.length) { log('DONE: ' + st.msg); return st; }
          if (st.el > 26000) { log('TIMEOUT-no-result'); return st; }
          return sleep(700).then(poll);
        });
      }
      return poll();
    });
  }).then(function (st) {
    log('result state: ' + JSON.stringify(st));
    console.log('[vis-e2e] PASS-THROUGH');
  }).catch(function (e) {
    console.log('[vis-e2e] FAIL: ' + e.message);
  });
})();
