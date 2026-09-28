// ★ 截图三键弹窗 e2e：识别页点「屏幕截图」→ 原生小弹窗出现 → 真实鼠标点击
//   「截取整个屏幕」→ 页面收到图片；再测「自由截取」→ 模拟拖框 → 页面收到图片。
//   前提：训练器已带 CDP(9333) 在跑（先用 _vis_e2e.js 起一轮）。
var fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), cp = require('child_process');
var ROOT = 'C:/Users/harve/Desktop/Gobang auto';
function log(s) { console.log('[shot-e2e] ' + s); }
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
    .then(function (r) { return r && r.result && r.result.result && r.result.result.value; });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---- 真实鼠标（PowerShell user32）----
function psMouse(kind, x, y) {
  var scr = 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class M { '
    + '[DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); '
    + '[DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }"; ';
  var act = '';
  if (kind === 'move') act = '[M]::SetCursorPos(' + x + ',' + y + ');';
  else if (kind === 'click') act = '[M]::SetCursorPos(' + x + ',' + y + '); Start-Sleep -m 80; [M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 60; [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero);';
  else if (kind === 'down') act = '[M]::SetCursorPos(' + x + ',' + y + '); Start-Sleep -m 60; [M]::mouse_event(2,0,0,0,[UIntPtr]::Zero);';
  else if (kind === 'up') act = '[M]::SetCursorPos(' + x + ',' + y + '); Start-Sleep -m 60; [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero);';
  return new Promise(function (res) {
    cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', scr + act + 'exit 0'], { stdio: 'ignore' })
      .on('exit', function () { setTimeout(res, 150); });
  });
}
function drag(x0, y0, x1, y1) {
  return psMouse('down', x0, y0)
    .then(function () { return psMouse('move', x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3); })
    .then(function () { return psMouse('move', x0 + (x1 - x0) * 0.6, y0 + (y1 - y0) * 0.6); })
    .then(function () { return psMouse('move', x1, y1); })
    .then(function () { return sleep(350); })          // 等选框重绘（虚线 + L 角）
    .then(function () { return psMouse('up', x1, y1); });
}
// 弹窗按钮点击：用 FindWindow 直接定位原生弹窗的**物理矩形**（页面 screen.* 是逻辑像素，
// DPI 缩放下对不上 —— 2026-09-21 实测）。按钮布局：3×124 + 4×10 间距，键高 40。
function psPickerRect() {
  var scr = 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public struct R { public int L,T,Rt,B; } '
    + 'public class W { [DllImport(\\"user32.dll\\", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string t); '
    + '[DllImport(\\"user32.dll\\")] public static extern bool GetWindowRect(IntPtr h, out R r); }"; '
    + '$h=[W]::FindWindowW("GbCalcVisPick",$null); if($h -eq [IntPtr]::Zero){exit 3}; $r=New-Object R; [W]::GetWindowRect($h,[ref]$r) | Out-Null; Write-Output "$($r.L),$($r.T)"';
  return new Promise(function (res) {
    cp.exec('powershell.exe -NoProfile -NonInteractive -Command "' + scr + '"',
            { encoding: 'utf8' }, function (err, so) { res(err ? null : String(so).trim()); });
  });
}
function pickBtn(which) {
  return psPickerRect().then(function (pos) {
    if (!pos) throw new Error('picker window not found');
    var parts = pos.split(',');
    var px = parseInt(parts[0], 10), py = parseInt(parts[1], 10);
    var bx = which === 'screen' ? px + 144 + 62 : (which === 'free' ? px + 278 + 62 : px + 10 + 62);
    log('picker at ' + px + ',' + py + ' -> click ' + which + ' at ' + bx + ',' + (py + 30));
    return psMouse('click', bx, py + 30);
  });
}

(function main() {
  // ★ 自己起训练器（bash 会话结束时整棵进程树会被回收 —— 探针必须与被测进程同生命周期）
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
  var cacheDir = path.join(ROOT, 'desktop-calculator/build/GomokuTrainer resources/EBWebView');
  try { fs.rmSync(path.join(cacheDir, 'Default/Cache'), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(cacheDir, 'Default/Code Cache'), { recursive: true, force: true }); } catch (e) {}
  var env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333 --no-sandbox',
  });
  var child = cp.spawn(path.join(ROOT, 'desktop-calculator/build/Desktop GomokuTrainer.exe'), [],
                       { detached: true, stdio: 'ignore', cwd: path.join(ROOT, 'desktop-calculator/build'), env: env });
  child.unref();
  log('spawned pid=' + child.pid);
  sleep(2500).then(function () {
    return pollTargets(function (t) { return t.type === 'page' && /calc\.html/.test(t.url) && t.url.indexOf('rv=1') < 0 && t.url.indexOf('vis=1') < 0; }, 45000);
  }).then(function (t) {
    log('main target: ' + t.url);
    return sleep(3000).then(function () { return wsConnect(t.webSocketDebuggerUrl); });
  }).then(function (cdp) {
    return evalJs(cdp, '(function(){ if(!window.G) return "NO_G"; els.btn_vis.click(); return "CLICKED"; })()');
  }).then(function (st) {
    log('main vis click: ' + st);
    return pollTargets(function (t) { return t.type === 'page' && /vis=1/.test(t.url); }, 30000);
  }).then(function (t) {
    log('vis target: ' + t.url);
    return sleep(2200).then(function () { return wsConnect(t.webSocketDebuggerUrl); });
  }).then(function (cdp) {
    return evalJs(cdp, '({n: VIS.list.length, w: screen.width, top: screen.availTop})').then(function (scr) {
      log('vis page: ' + JSON.stringify(scr));
      return evalJs(cdp, 'els.btn_vis_shot.click(); "SHOT_CLICKED"').then(function (st) {
        log('shot click: ' + st);
        return sleep(1800);                            // 最小化动画 + 弹窗出现
      }).then(function () {
        return pickBtn('screen');
      }).then(function () {
        function poll() {
          return evalJs(cdp, '({n: VIS.list.length, msg: document.getElementById("visMsg").textContent})').then(function (st) {
            log('screen-shot poll: ' + JSON.stringify(st));
            if (st.n >= 1) return st;
            return sleep(600).then(poll);
          });
        }
        return poll();
      });
    }).then(function () {
      // 自由截取：拖一个框 → 双击框内确认
      return evalJs(cdp, 'els.btn_vis_shot.click(); "FREE_CLICKED"').then(function () {
        return sleep(1800);
      }).then(function () {
        return pickBtn('free');
      }).then(function () {
        return sleep(1200);                            // 冻结选框出现（十字光标）
      }).then(function () {
        log('drag 400,300 -> 1100,720');
        return drag(400, 300, 1100, 720);
      }).then(function () {
        return sleep(500);                             // 进入调整态（角框可拖）
      }).then(function () {
        log('dblclick inside rect to confirm');
        return dblclick(750, 500);
      }).then(function () {
        function poll() {
          return evalJs(cdp, '({n: VIS.list.length, msg: document.getElementById("visMsg").textContent})').then(function (st) {
            log('free-shot poll: ' + JSON.stringify(st));
            if (st.n >= 2) return st;
            if (st.msg && /取消|失败/.test(st.msg)) return st;
            return sleep(600).then(poll);
          });
        }
        return poll();
      });
    }).then(function (st) {
      log('FINAL: ' + JSON.stringify(st));
      console.log('[shot-e2e] DONE');
    });
  }).catch(function (e) { console.log('[shot-e2e] FAIL: ' + e.message); });
})();
