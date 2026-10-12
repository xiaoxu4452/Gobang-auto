// 连线窗排版取证：起 EXE（CDP）→ 主窗切英文 → 点「连线」→ 连上连线页 target →
//   ① 量测各区块 getBoundingClientRect（找堆叠/溢出的数值证据）
//   ② Page.captureScreenshot 出 PNG
// 用法：node tools/_link_shot.js <tag>     产出 tools/_link_<tag>.png / _link_<tag>.json
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = 'C:/Users/harve/Desktop/Gobang auto';
var EXE = path.join(ROOT, 'Meter Gomoku', 'Desktop GomokuTrainer.exe');
var TAG = process.argv[2] || 'x';
var PORT = 9337;

function log(s) { console.log('[lshot] ' + s); }
function killTrainer() {
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
}
function fetchTargets() {
  return new Promise(function (res) {
    var req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 2000 }, function (r) {
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
        setTimeout(loop, 600);
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
      function emit(obj) {
        if (obj.id && pending[obj.id]) { var f = pending[obj.id]; delete pending[obj.id]; f(obj); }
      }
      function frame(op, payload) {
        var mask = crypto.randomBytes(4), h;
        if (payload.length < 126) h = Buffer.from([0x80 | op, 0x80 | payload.length]);
        else if (payload.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); }
        else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(payload.length), 2); }
        var body = Buffer.from(payload);
        for (var i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        return Buffer.concat([h, mask, body]);
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
          if (op === 9) { socket.write(frame(10, payload)); continue; }
          if (op === 8) { try { socket.end(); } catch (e) {} continue; }
          if (op === 1 || op === 2) { try { emit(JSON.parse(payload.toString('utf8'))); } catch (e) {} }
        }
      }
      socket.on('data', feed);
      socket.on('error', function (e) { try { Object.keys(pending).forEach(function (k) { pending[k]({ error: { message: String(e) } }); }); } catch (x) {} });
      res({
        send: function (method, params, timeoutMs) {
          return new Promise(function (resolve, reject) {
            var id = ++nid;
            var timer = setTimeout(function () { delete pending[id]; reject(new Error('cdp timeout: ' + method)); }, timeoutMs || 15000);
            pending[id] = function (r) { clearTimeout(timer); resolve(r); };
            socket.write(frame(1, Buffer.from(JSON.stringify({ id: id, method: method, params: params || {} }), 'utf8')), function () {});
          });
        },
        close: function () { try { socket.end(); } catch (e) {} },
      });
    });
    req.on('error', rej);
    req.on('response', function (r) { rej(new Error('no upgrade: ' + r.statusCode)); });
  });
}
function evalJs(cdp, expr) {
  return cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 20000)
    .then(function (r) {
      var ro = r && r.result && r.result.result;
      if (!ro || ro.value === undefined) log('evalJs raw: ' + JSON.stringify(r).slice(0, 400));
      return ro && ro.value;
    });
}
function shot(cdp, file) {
  return cdp.send('Page.captureScreenshot', { format: 'png' }, 30000).then(function (r) {
    var d = r && r.result && r.result.data;
    if (!d) throw new Error('no screenshot data');
    fs.writeFileSync(path.join(ROOT, 'tools', file), Buffer.from(d, 'base64'));
    log('saved ' + file);
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var MEASURE = '(function(){' +
  'function R(sel){ var e=document.querySelector(sel); if(!e) return null; var r=e.getBoundingClientRect();' +
  '  return {y:Math.round(r.top), b:Math.round(r.bottom), w:Math.round(r.width), h:Math.round(r.height),' +
  '          sh:e.scrollHeight, ch:e.clientHeight, ov:e.offsetHeight}; }' +
  'return JSON.stringify({' +
  ' iw:window.innerWidth, ih:window.innerHeight, dpr:window.devicePixelRatio,' +
  ' ow:window.outerWidth, oh:window.outerHeight,' +
  ' scr:[screen.width, screen.height, screen.availWidth, screen.availHeight],' +
  ' fs:getComputedStyle(document.documentElement).fontSize, lang:(window.S||{}).lang,' +
  ' pane:R("#linkPane"), body:R(".lk-body"), panel:R(".lk-panel"), stats:R(".lk-stats"),' +
  ' status:R("#lkStatus"), boardcol:R(".lk-boardcol"), count:R("#lkCount"),' +
  ' board:R("#lkBoard"), brand:R(".lk-brand"),' +
  ' overlap:{ panel_overflow:R(".lk-panel")?R(".lk-panel").sh-R(".lk-panel").h:0,' +
  '   boardcol_overflow:R(".lk-boardcol")?R(".lk-boardcol").sh-R(".lk-boardcol").ch:0,' +
  '   status_vs_count:Math.round((R("#lkStatus")||{b:0}).b - (R("#lkCount")||{y:0}).y),' +
  '   board_vs_brand:Math.round((R("#lkBoard")||{b:0}).b - (R(".lk-brand")||{y:0}).y) },' +
  ' statusTxt:(document.getElementById("lkStatus")||{}).textContent||""' +
  '},null,1); })()';

(function main() {
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT + ' --no-sandbox',
  });
  killTrainer();
  var child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env: env });
  child.unref();
  log('spawned pid=' + child.pid);
  var mainCdp = null;
  sleep(2600)
    .then(function () { return pollTargets(function (t) { return t.type === 'page' && /calc\.html/.test(t.url) && t.url.indexOf('link=1') < 0 && t.url.indexOf('rv=1') < 0; }, 50000); })
    .then(function (t) { log('main target: ' + t.url); return sleep(3500).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
    .then(function (cdp) { mainCdp = cdp; return cdp.send('Page.enable', {}); })
    .then(function () { return evalJs(mainCdp, '(function(){ if((window.S||{}).lang!=="en"){ document.getElementById("btn_lang").click(); } return (window.S||{}).lang || "?"; })()'); })
    .then(function (v) { log('main lang -> ' + v); return sleep(700); })
    .then(function () { return evalJs(mainCdp, '(function(){ var b=document.getElementById("btn_link"); if(!b) return "no-btn"; b.click(); return "clicked"; })()'); })
    .then(function (v) { log('openLink: ' + v); })
    .then(function () { return pollTargets(function (t) { return t.type === 'page' && /link=1/.test(t.url); }, 40000); })
    .then(function (t) { log('link target: ' + t.url); return sleep(2600).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
    .then(function (cdp) {
      return cdp.send('Page.enable', {})
        .then(function () { return sleep(1500); })
        .then(function () { return evalJs(cdp, MEASURE); })
        .then(function (v) {
          log('measure:\n' + v);
          fs.writeFileSync(path.join(ROOT, 'tools', '_link_' + TAG + '.json'), String(v));
          return shot(cdp, '_link_' + TAG + '.png');
        })
        // ---- 低高清档：模拟矮屏视口（1366×768@125% → 客户区 ~580，再狠一点用 560/470）----
        .then(function () {
          var H = [560, 470, 400];
          var chain = Promise.resolve();
          H.forEach(function (hh) {
            chain = chain
              .then(function () { return cdp.send('Emulation.setDeviceMetricsOverride',
                { width: 272, height: hh, deviceScaleFactor: 1, mobile: false }, 10000); })
              .then(function () { return sleep(700); })
              .then(function () { return evalJs(cdp, MEASURE); })
              .then(function (v) {
                var o = JSON.parse(v);
                log('h=' + hh + ' → panelOv=' + o.overlap.panel_overflow +
                    ' boardcolOv=' + o.overlap.boardcol_overflow +
                    ' statusVsCount=' + o.overlap.status_vs_count +
                    ' boardVsBrand=' + o.overlap.board_vs_brand +
                    ' | status.h=' + (o.status ? o.status.h : '-') +
                    ' board=' + (o.board ? o.board.w + 'x' + o.board.h : '-') +
                    ' brand.y=' + (o.brand ? o.brand.y : '-') + '/' + hh);
                fs.writeFileSync(path.join(ROOT, 'tools', '_link_' + TAG + '_h' + hh + '.json'), v);
                return shot(cdp, '_link_' + TAG + '_h' + hh + '.png');
              });
          });
          return chain;
        })
        .then(function () { return cdp.send('Emulation.clearDeviceMetricsOverride', {}, 10000); })
        .then(function () { cdp.close(); });
    })
    .then(function () { log('done'); killTrainer(); setTimeout(function () { process.exit(0); }, 400); })
    .catch(function (e) { log('FAIL: ' + (e && e.message || e)); killTrainer(); setTimeout(function () { process.exit(1); }, 400); });
})();
