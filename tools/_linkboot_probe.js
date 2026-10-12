// _linkboot_probe.js —— 对**刚发布的** Meter Gomoku/Desktop GomokuTrainer.exe 做运行时开机自检：
//   ① 进程起得来、WebView2 导航到 calc.html、连线窗能开；
//   ② 引擎车道按实际口径引导（正常开机 = main + sub；fwd 按需，不预起）；
//   ③ 宿主日志里没有 one-side burst 判废、没有 ERROR、没有 crash。
// 用法：node tools/_linkboot_probe.js [--boot-lanes]
//   --boot-lanes → 额外带 GB_TEST_BOOT_LANES=1 再跑一遍，验**进程级**三车道契约。
'use strict';
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = path.join(__dirname, '..');
var EXE = path.join(ROOT, 'Meter Gomoku', 'Desktop GomokuTrainer.exe');
var LOG = path.join(process.env.TEMP || process.env.TMP || 'C:/Windows/Temp', 'GomokuTrainer.log');
var PORT = 9351;
var BOOT_LANES = process.argv.indexOf('--boot-lanes') >= 0;

function log(s) { console.log('[boot] ' + s); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function killAll() {
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
  try { cp.spawnSync('taskkill', ['/IM', 'GomokuVision.exe', '/F'], { stdio: 'ignore' }); } catch (e) {}
}
function get(url) {
  return new Promise(function (res) {
    var req = http.get(url, { timeout: 2000 }, function (r) {
      var b = ''; r.on('data', function (d) { b += d; }); r.on('end', function () { res(b); });
    });
    req.on('error', function () { res(null); }); req.on('timeout', function () { req.destroy(); res(null); });
  });
}
function targets() { return get('http://127.0.0.1:' + PORT + '/json/list').then(function (b) { try { return JSON.parse(b); } catch (e) { return null; } }); }
function pollTargets(want, ms) {
  var t0 = Date.now();
  return new Promise(function (res, rej) {
    (function loop() {
      targets().then(function (t) {
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
    .then(function (r) { var ro = r && r.result && r.result.result; return ro && ro.value; },
          function () { return null; });
}
function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } }
function grab(txt, re) { var out = [], m; var r = new RegExp(re.source, 'gm'); while ((m = r.exec(txt))) out.push(m[0]); return out; }
function pageState(cdp) {
  return evalJs(cdp, '(function(){ return { top: !!window.__gbTop, ready: !!window.__gbReadySent, hasBtn: !!document.getElementById("btn_link") }; })()');
}
/** ★ 2026-10-09：**轮询等待**，不要再用固定 sleep —— 页面 init 是异步的，机器忙（刚跑完
 *  编译/多次探针）时 2.5s 可能还没执行到 `__gbReadySent = true`（calc.js:10923），
 *  固定等待会把「还没加载完」误报成 FAIL。实测同一 exe 连跑三次：一真两假 —— 是探针竞态，
 *  不是产品回归（判据：`__gbTop` 真 + `hasBtn` 真 + `ready` 假 = 脚本跑到一半）。 */
function waitPageReady(cdp, timeoutMs, stepMs) {
  var t0 = Date.now();
  return (function loop() {
    return pageState(cdp).then(function (v) {
      if (v && v.ready === true) return v;
      if (Date.now() - t0 > (timeoutMs || 30000)) return v;
      return sleep(stepMs || 600).then(loop);
    });
  })();
}

var fails = [];
function check(name, cond, extra) {
  console.log((cond ? '  OK   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
  if (!cond) fails.push(name);
}

(function main() {
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT + ' --no-sandbox',
  });
  if (BOOT_LANES) env.GB_TEST_BOOT_LANES = '1';
  killAll();
  try { fs.writeFileSync(LOG, ''); } catch (e) {}
  var child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env: env });
  child.unref();
  log('spawned pid=' + child.pid + (BOOT_LANES ? '  (GB_TEST_BOOT_LANES=1)' : ''));

  sleep(BOOT_LANES ? 6000 : 2800)
    .then(function () { return pollTargets(function (t) { return t.type === 'page' && /calc\.html/.test(t.url) && t.url.indexOf('link=1') < 0 && t.url.indexOf('rv=1') < 0; }, 50000); })
    .then(function (t) {
      log('main target: ' + t.url.replace(/\?.*$/, ''));
      return sleep(800).then(function () { return wsConnect(t.webSocketDebuggerUrl); });
    })
    .then(function (cdp) {
      return cdp.send('Page.enable', {})
        .then(function () { return waitPageReady(cdp, 30000, 600); })
        .then(function (v) { log('page state: ' + JSON.stringify(v)); check('页面顶层脚本执行过（__gbTop）', v && v.top === true); check('ready 已上报（__gbReadySent）', v && v.ready === true); check('「连线」入口按钮在位', v && v.hasBtn === true); })
        .then(function () { return sleep(3500); })    // 给桥引导车道留时间
        .then(function () { log('--- 开连线窗 ---'); return evalJs(cdp, '(function(){ var b=document.getElementById("btn_link"); if(!b) return "no-btn"; b.click(); return "clicked"; })()'); })
        .then(function (v) { log('openLink: ' + v); return sleep(1500); })
        .then(function () { cdp.close(); });
    })
    .then(function () { return pollTargets(function (t) { return t.type === 'page' && /link=1/.test(t.url); }, 40000); })
    .then(function (t) { log('link target: ' + t.url.replace(/^(.*link=1).*$/, '$1')); return sleep(2000).then(function () { return wsConnect(t.webSocketDebuggerUrl); }); })
    .then(function (cdp) {
      return cdp.send('Page.enable', {})
        .then(function () { return evalJs(cdp, '(function(){ var s=document.getElementById("lkStatus"); return s?s.textContent:""; })()'); })
        .then(function (v) { log('lkStatus: ' + JSON.stringify(String(v).slice(0, 120))); })
        .then(function () { return evalJs(cdp, '(function(){ return ["lk_auto","lk_real","lk_bal","lk_eval","lk_select","lk_black","lk_white","lk_turn","lkStatus"].filter(function(i){return !document.getElementById(i);}).join(","); })()'); })
        .then(function (missing) { check('连线窗控件齐全（含本轮新增 lk_real 真实点击）', missing === '', missing ? ('缺: ' + missing) : '9/9'); })
        // ★★ 2026-10-09（用户：「用户打开真实点击，在关闭之后就还是恢复不了那种模拟的快速点击」）★★
        //   运行时证明**开关本身**的闭环：点 lk_real（开）→ 桥的唯一事实源 `__gb_realclick`
        //   必须带上 data-on；再点一次（关）→ 必须摘掉。宿主侧「关掉后还走 real」的自锁由
        //   test-calculator 的 useReal/prefEff 契约守着，这里只证明「关」这一个动作真的落到了桥上。
        //   跑完**还原**用户原本的开关状态，不留副作用。
        .then(function () {
          return evalJs(cdp, '(function(){' +
            'var rc=document.getElementById("__gb_realclick"), btn=document.getElementById("lk_real");' +
            'if(!rc||!btn) return JSON.stringify({err:"missing"});' +
            'var before = rc.getAttribute("data-on")==="1";' +
            'btn.click(); var mid = rc.getAttribute("data-on")==="1";' +
            'btn.click(); var after = rc.getAttribute("data-on")==="1";' +
            'var guard=0; while(((rc.getAttribute("data-on")==="1")!==before) && guard++<4) btn.click();' +
            'return JSON.stringify({before:before, mid:mid, after:after}); })()');
        })
        .then(function (v) {
          var o = {};
          try { o = JSON.parse(String(v)); } catch (e) { o = { err: String(v) }; }
          log('realclick toggle: ' + JSON.stringify(o) + '（断言按「相对翻转」写，与用户原本的开/关状态无关）');
          check('真实点击开关闭环：点一次 → 桥的唯一事实源 `__gb_realclick` 的 data-on 翻转',
            o && typeof o.before === 'boolean' && o.mid === !o.before, JSON.stringify(o));
          check('真实点击开关闭环：再点一次 → 翻回原状（**关得掉**）',
            o && typeof o.before === 'boolean' && o.after === o.before, JSON.stringify(o));
        })
        .then(function () { log('--- 探一次桥是否活着：调 GB_LINK_SWAPEVAL（无盘面时应提示「未检测到棋盘」而不是干等）---'); return evalJs(cdp, 'Promise.resolve(window.GB_LINK_SWAPEVAL && window.GB_LINK_SWAPEVAL()).then(function(){ var s=document.getElementById("lkStatus"); return s?s.textContent:""; })'); })
        .then(function (v) { log('swapeval status: ' + JSON.stringify(String(v).slice(0, 120))); check('连线窗桥活着（交换评估给出「未检测到棋盘」而非卡在「连接引擎…」）', /未检测到棋盘|No board detected/.test(String(v))); })
        .then(function () { log('--- 点「框选棋盘」（用户的第一个动作，触发引擎引导）---'); return evalJs(cdp, '(function(){ var b=document.getElementById("lk_select"); if(!b) return "no-btn"; b.click(); return "clicked"; })()'); })
        .then(function (v) { log('lk_select: ' + v); })
        .then(function () { log('--- 等引擎车道引导（ensure → START → INFO 配置）---'); return sleep(16000); })
        .then(function () { return evalJs(cdp, '(function(){ var s=document.getElementById("lkStatus"); return s?s.textContent:""; })()'); })
        .then(function (v) { log('lkStatus@16s: ' + JSON.stringify(String(v).slice(0, 120))); })
        .then(function () { cdp.close(); });
    })
    .then(function () { return sleep(1200); })
    .then(function () {
      var txt = readLog();
      console.log('\n--- 宿主日志关键行 ---');
      console.log('  （日志文件: ' + LOG + '，' + txt.length + ' 字节）');
      var laneLines = grab(txt, /^\[engine:.*$/m);
      laneLines.forEach(function (l) { console.log('  [log] ' + l.trim()); });
      var uiLines = grab(txt, /^\[bridge-ui\].*$/m);
      uiLines.slice(-12).forEach(function (l) { console.log('  [log] ' + l.trim()); });
      var errLines = grab(txt, /^.*ERROR.*$/m).slice(0, 8);
      errLines.forEach(function (l) { console.log('  [log!] ' + l.trim()); });
      console.log('');
      check('引擎车道已启动（main）', /\[engine:main\]\s*已启动/.test(txt));
      check('引擎车道已启动（sub）', /\[engine:sub\]\s*已启动/.test(txt));
      check('引擎变体与本机指令集匹配（avx2/avx512）', /\[engine\]\s*cpuid:/.test(txt) && /variant=[a-z0-9]+/.test(txt), (txt.match(/\[engine\]\s*原生 Rapfi 可用：variant=(\S+)/) || [])[1] || '');
      if (BOOT_LANES) {
        check('三车道契约（fwd 也已起）', /\[engine:fwd\]\s*已启动/.test(txt));
        check('GB_TEST_BOOT_LANES 自检行出现', /GB_TEST_BOOT_LANES: lanes ensured/.test(txt));
      } else {
        check('按需语义：正常开机 **不** 预起 fwd', !/\[engine:fwd\]\s*已启动/.test(txt));
      }
      check('日志无 one-side burst 判废', !/one-side burst/.test(txt));
      check('日志无 ERROR 行', errLines.length === 0, errLines.length ? '(' + errLines.length + ' 行)' : '');
      // 以下两项是**信息性**的：它们要等一次真实分析（盘面上有子）才会出现，
      // 本探针不投喂盘面，所以只打印、不计入判定。
      var q = (txt.match(/\[bridge-ui\] LINK_ENG_QUOTA[^\n]*/) || [])[0];
      var p = (txt.match(/\[bridge-ui\] LINK_PONDER_ON[^\n]*/) || [])[0];
      console.log('  [info] ' + (q || '(无 LINK_ENG_QUOTA —— 需一次真实引擎调用才会打印)'));
      console.log('  [info] ' + (p || '(无 LINK_PONDER_ON —— 需一次真实分析（盘面有子）才会打印)'));
      console.log('\n结果：' + (fails.length ? ('✗ ' + fails.length + ' 项未过 → ' + fails.join(' / ')) : '✓ 全部通过'));
      killAll(); setTimeout(function () { process.exit(fails.length ? 1 : 0); }, 400);
    })
    .catch(function (e) { log('FAIL: ' + (e && e.message || e)); killAll(); setTimeout(function () { process.exit(1); }, 400); });
})();
