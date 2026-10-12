// 取证：连线版「识别」端到端 —— 起 EXE（CDP）→ 打开连线窗 → 点「框选棋盘」开出框窗 →
//       真鼠标点框窗的「自动」键 → 等 7s 让扫描循环跑 → 抓宿主日志里的 [link-scan] 行。
// 目的：证明纯硬链接（命名管道 OP_SCAN）真的通车（修前是 code=0 / scan=down）。
// 用法：node tools/_lsel_probe.js <tag>
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = 'C:/Users/harve/Desktop/Gobang auto';
var EXE = path.join(ROOT, 'Meter Gomoku', 'Desktop GomokuTrainer.exe');
var PY = 'C:/Python314/python.exe';
var LOG = 'C:/Users/harve/AppData/Local/Temp/GomokuTrainer.log';
var TAG = process.argv[2] || 'x';
var PORT = 9337;

function log(s) { console.log('[lsel] ' + s); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function killTrainer() {
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
  try { cp.spawnSync('taskkill', ['/IM', 'GomokuVision.exe', '/F'], { stdio: 'ignore' }); } catch (e) {}
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
      function emit(obj) { if (obj.id && pending[obj.id]) { var f = pending[obj.id]; delete pending[obj.id]; f(obj); } }
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
    .then(function (r) { var ro = r && r.result && r.result.result; return ro && ro.value; });
}
function dumpLog() {
  try {
    var txt = fs.readFileSync(LOG, 'latin1');
    var lines = txt.split(/\r?\n/).filter(function (l) {
      return /\[vis\]|\[link-scan\]|\[link\] auto|\[link\] scan|\[cpu\]/.test(l);
    });
    lines.slice(-16).forEach(function (l) { console.log('[log] ' + l); });
    fs.writeFileSync(path.join(ROOT, 'tools', '_lsel_' + TAG + '.log.txt'), lines.join('\n'));
  } catch (e) { log('log read failed: ' + e.message); }
}

(function main() {
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT + ' --no-sandbox',
  });
  killTrainer();
  try { fs.writeFileSync(LOG, ''); } catch (e) {}
  var child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env: env });
  child.unref();
  log('spawned pid=' + child.pid);
  var linkCdp = null;
  sleep(2600)
    .then(function () { return pollTargets(function (t) { return t.type === 'page' && /calc\.html/.test(t.url) && t.url.indexOf('link=1') < 0 && t.url.indexOf('rv=1') < 0; }, 50000); })
    .then(function (t) { log('main target ok'); return sleep(3200).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
    .then(function (cdp) { var m = cdp; return m.send('Page.enable', {}).then(function () { return evalJs(m, '(function(){ var b=document.getElementById("btn_link"); if(!b) return "no-btn"; b.click(); return "clicked"; })()'); }).then(function (v) { log('openLink: ' + v); m.close(); }); })
    .then(function () { return pollTargets(function (t) { return t.type === 'page' && /link=1/.test(t.url); }, 40000); })
    .then(function (t) { log('link target: ' + t.url); return sleep(2200).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
    .then(function (cdp) {
      linkCdp = cdp;
      return cdp.send('Page.enable', {})
        .then(function () { return evalJs(cdp, '(function(){ var b=document.getElementById("lk_select"); if(!b) return "no-lk_select"; b.click(); return "framed"; })()'); })
        .then(function (v) { log('frame open: ' + v); return sleep(1800); })
        .then(function () {
          // LSEL_NOCLICK=1：只把程序开到「框窗已弹出」并保持 NOCLICK_MS（默认 25s），
          // 由外部（Bash）下真鼠标点击 —— 某些沙箱里 node spawn python 会 EBUSY。
          if (process.env.LSEL_NOCLICK === '1') {
            var hold = parseInt(process.env.LSEL_HOLD_MS || '25000', 10);
            log('NOCLICK: holding ' + hold + 'ms —— 现在可用外部脚本点框窗的「自动」键');
            return sleep(hold);
          }
          log('--- 真鼠标点框窗「自动」键 ---');
          var out = cp.execFileSync(PY, [path.join(ROOT, 'tools', '_lsel_click.py'), 'auto'], { encoding: 'utf8' });
          out.split(/\r?\n/).forEach(function (l) { if (l.trim()) console.log('[py] ' + l); });
          return sleep(7000);
        })
        .then(function () {
          log('--- 状态栏文本 ---');
          return evalJs(cdp, '(function(){ var e=document.getElementById("lkStatus"); return e?e.textContent:"(no #lkStatus)"; })()');
        })
        .then(function (v) { log('status: ' + String(v).slice(0, 160)); })
        .then(function () { log('--- 宿主日志（关键行）---'); dumpLog(); })
        .then(function () { return cdp.send('Page.captureScreenshot', { format: 'png' }, 20000); })
        .then(function (r) {
          var d = r && r.result && r.result.data;
          if (d) { fs.writeFileSync(path.join(ROOT, 'tools', '_lsel_' + TAG + '.png'), Buffer.from(d, 'base64')); log('saved _lsel_' + TAG + '.png'); }
        })
        .then(function () { cdp.close(); });
    })
    .then(function () { log('done'); killTrainer(); setTimeout(function () { process.exit(0); }, 400); })
    .catch(function (e) { log('FAIL: ' + (e && e.message || e)); dumpLog(); killTrainer(); setTimeout(function () { process.exit(1); }, 400); });
})();
