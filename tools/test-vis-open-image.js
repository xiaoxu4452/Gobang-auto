/* 「双击图片 → 用系统默认看图软件打开」真机端到端回归（廿四轮，用户要求）。
 *
 * 用户原话：「不管是在识别的图片，还是在抽屉里面，双击这个图片会引起系统里面的默认图片
 *          软件打开这个图片」。
 * 实现链路（页面手里只有 dataURL，WebView2 没有文件系统/「打开方式」）：
 *   页面 visOpenImage() → tellHost({type:'openImage', idx, ext, data})
 *   → 宿主 OpenImageFromPage()：base64 → %TEMP%\gbvis-open-<idx>.<ext> → ShellExecuteW("open")
 *
 * 判据（全程真链，不看页面说了什么）：
 *   ① 双击**识图窗大图** → 宿主日志出现 [vis] openImage，且 %TEMP% 里那张文件的字节
 *      与页面当前条目 it.d（dataURL）**逐字节一致**；
 *   ② 双击**抽屉里的缩略图** → 同样落盘 + 打开（同一张 → 同名文件，覆盖重开）；
 *   ③ 缩略图右键菜单里有「用系统看图软件打开」这一项。
 *
 * 跑法：node tools/test-vis-open-image.js
 * 前提：desktop-calculator/build/Desktop GomokuTrainer.exe 已构建（node tools/build-calculator.js）；
 *      跑完会自动结束训练器。测试钩子 GB_TEST_OPEN_IMAGE=1 让宿主只落盘、不真的拉看图软件。
 * ⚠️ 需要桌面会话（WebView2 + 窗口），属 LIVE 套件。 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-calculator', 'build', 'Desktop GomokuTrainer.exe');
const IMG = path.join(__dirname, '_shot_3_defend.png');     // 一张真图（识别不出也无所谓，本测试只看字节搬运）
const TMP = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
const HOST_LOG = path.join(TMP, 'GomokuTrainer.log');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' | ' + extra : '')); }
}
const log = (s) => console.log('[vis-open] ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 收尾杀进程时 WebSocket 可能抛 ECONNRESET —— 别让它掀翻汇总（测试结论自己会打印）
process.on('uncaughtException', (e) => log('uncaught: ' + ((e && e.message) || e)));

function killTrainer() {
  try { cp.spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
}
function fetchTargets() {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: 9333, path: '/json/list', timeout: 2000 }, (r) => {
      const b = []; r.on('data', (d) => b.push(d)); r.on('end', () => { try { res(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch (e) { res(null); } });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}
function pollTargets(want, ms) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    (function loop() {
      fetchTargets().then((t) => {
        const hit = t && t.filter(want)[0];
        if (hit) return res(hit);
        if (Date.now() - t0 > ms) return rej(new Error('target wait timeout'));
        setTimeout(loop, 700);
      });
    })();
  });
}
function frame(op, pl) {
  const mask = crypto.randomBytes(4);
  let h;
  if (pl.length < 126) h = Buffer.from([0x80 | op, 0x80 | pl.length]);
  else if (pl.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(pl.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(pl.length), 2); }
  const body = Buffer.from(pl);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([h, mask, body]);
}
function wsConnect(url) {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.get(url.replace(/^ws:/, 'http:'), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (r, socket) => {
      let buf = Buffer.alloc(0), nid = 0;
      const pending = {};
      socket.on('error', () => {});              // 训练器被杀时 socket 会 ECONNRESET —— 别让它掀翻整个测试
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          let op = buf[0] & 0x0f, len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (op === 9) { socket.write(frame(10, payload)); continue; }
          if (op === 8) { try { socket.end(); } catch (e) {} continue; }
          if (op === 1 || op === 2) {
            let obj = null;
            try { obj = JSON.parse(payload.toString('utf8')); } catch (e) {}
            if (obj && obj.id && pending[obj.id]) { const f = pending[obj.id]; delete pending[obj.id]; f(obj); }
          }
        }
      });
      res({
        send(method, params, timeoutMs) {
          return new Promise((resolve, reject) => {
            const id = ++nid;
            const timer = setTimeout(() => { delete pending[id]; reject(new Error('cdp timeout: ' + method)); }, timeoutMs || 20000);
            pending[id] = (r) => { clearTimeout(timer); resolve(r); };
            socket.write(frame(1, Buffer.from(JSON.stringify({ id, method, params: params || {} }), 'utf8')));
          });
        },
      });
    });
    req.on('error', rej);
  });
}
function evalJs(cdp, expr, timeoutMs) {
  return cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs || 20000)
    .then((r) => {
      if (r && r.result && r.result.exceptionDetails) log('EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 240));
      const ro = r && r.result && r.result.result;
      return ro && ro.value;
    });
}
function logTail(from) {
  try {
    const b = fs.readFileSync(HOST_LOG);
    return b.slice(from).toString('utf8');
  } catch (e) { return ''; }
}
/** 轮询页面直到表达式为真（页面 boot 完成 / els 就绪）。 */
async function waitTrue(cdp, expr, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalJs(cdp, expr);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(400);
  }
}

(async function main() {
  if (!fs.existsSync(EXE)) { console.log('✗ 没找到 ' + EXE + '（先 node tools/build-calculator.js）'); process.exit(1); }
  if (!fs.existsSync(IMG)) { console.log('✗ 测试图缺失：' + IMG); process.exit(1); }
  console.log('=== 双击图片 → 系统默认看图软件打开（真机端到端）===');

  killTrainer();
  // 清 WebView2 缓存：升级后的新 calc.js 被旧缓存压住 = 页面跑旧代码（老坑）
  const cache = path.join(ROOT, 'desktop-calculator', 'build', 'GomokuTrainer resources', 'EBWebView', 'Default');
  ['Cache', 'Code Cache'].forEach((d) => { try { fs.rmSync(path.join(cache, d), { recursive: true, force: true }); } catch (e) {} });

  const logFrom = (() => { try { return fs.statSync(HOST_LOG).size; } catch (e) { return 0; } })();
  // 预置一张「上一轮遗留」的同名临时文件，验证宿主确实**覆盖写**（不是碰巧命中旧文件）
  const stale = path.join(TMP, 'gbvis-open-1.png');
  fs.writeFileSync(stale, Buffer.from('STALE-NOT-THE-IMAGE'));

  const env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333 --no-sandbox',
    GB_TEST_OPEN_IMAGE: '1',                     // 宿主只落盘 + 记日志（不真的拉看图软件）
  });
  const child = cp.spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env });
  child.unref();
  log('spawned pid=' + child.pid);

  let visCdp = null, mainCdp = null;
  try {
    await sleep(2800);
    const tMain = await pollTargets((t) => t.type === 'page' && /calc\.html/.test(t.url) &&
      t.url.indexOf('rv=1') < 0 && t.url.indexOf('vis=1') < 0, 45000);
    mainCdp = await wsConnect(tMain.webSocketDebuggerUrl);
    const ready = await waitTrue(mainCdp, '(function(){ return !!(window.G && window.els && els.btn_vis); })()', 40000);
    ok('主窗 boot 完成（G / els 就绪）', !!ready);
    const clicked = await evalJs(mainCdp, '(function(){ els.btn_vis.click(); return "CLICKED"; })()');
    ok('主窗点「识图」→ 请求开识图窗', clicked === 'CLICKED', clicked);

    const tVis = await pollTargets((t) => t.type === 'page' && /vis=1/.test(t.url), 30000);
    visCdp = await wsConnect(tVis.webSocketDebuggerUrl);
    const visReady = await waitTrue(visCdp, '(function(){ return !!(window.VIS && els.visImg && window.visAddImage); })()', 40000);
    ok('识图窗已就绪（VIS / visAddImage 就绪）', !!visReady);
    // 清空上一轮残留的图片列表（识图窗是持久化的）→ 本测试只用自己塞的那一张，序号稳定从 1 起
    await evalJs(visCdp, '(function(){ VIS.list = []; VIS.idx = 0; VIS.sel = new Set(); visPersist(); visRefreshView(); return "CLEARED"; })()');

    // 塞一张真图（自动识别会顺带跑起来，与本测试无关）
    const b64 = fs.readFileSync(IMG).toString('base64');
    const add = await evalJs(visCdp, 'visAddImage("data:image/png;base64,' + b64 + '", true)');
    ok('把一张 PNG 放进识图窗（走页面自己的 visAddImage）', add === true, String(add));
    const idx = await evalJs(visCdp, '(function(){ return VIS.idx + 1; })()');

    // ① 双击**大图**
    const cur = await evalJs(visCdp, '(function(){ var it = VIS.list[VIS.idx]; return JSON.stringify({ n: VIS.list.length, d: it && it.d }); })()');
    const curObj = JSON.parse(cur || '{}');
    await evalJs(visCdp, '(function(){ els.visImg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return "SENT"; })()');
    await sleep(1500);
    let tail = logTail(logFrom);
    const bigLine = /\[vis\] openImage[^\n]*gbvis-open-(\d+)\.png/.exec(tail);
    ok('★ 双击识图窗大图 → 宿主收到 openImage 报文并落盘', !!bigLine,
       bigLine ? bigLine[0].slice(0, 120) : ('日志里没有 openImage：' + tail.split('\n').slice(-3).join(' / ').slice(0, 160)));
    const openFile = path.join(TMP, 'gbvis-open-' + (bigLine ? bigLine[1] : idx) + '.png');
    const wantBytes = Buffer.from(String(curObj.d || '').split('base64,')[1] || '', 'base64');
    const gotBytes = fs.existsSync(openFile) ? fs.readFileSync(openFile) : Buffer.alloc(0);
    ok('★ 落盘的图与页面里那张**逐字节一致**（不是同名旧文件）',
       wantBytes.length > 0 && gotBytes.length === wantBytes.length && gotBytes.equals(wantBytes),
       'page=' + wantBytes.length + 'B file=' + gotBytes.length + 'B @' + path.basename(openFile));

    // ② 双击**抽屉里的缩略图**
    await evalJs(visCdp, '(function(){ els.visPos.click(); return "OPEN"; })()');
    await sleep(600);
    const items = await evalJs(visCdp, '(function(){ return document.querySelectorAll("#vdList .vd-item").length; })()');
    const menuTxt = await evalJs(visCdp, '(function(){ var it = document.querySelector("#vdList .vd-item");' +
      ' if(!it) return ""; it.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));' +
      ' var m = document.getElementById("ctxMenu"); return m ? m.textContent : ""; })()');
    ok('缩略图右键菜单里有「' + '用系统看图软件打开' + '」这一项',
       /用系统看图软件打开/.test(String(menuTxt)), String(menuTxt).slice(0, 60));
    await evalJs(visCdp, '(function(){ var m=document.getElementById("ctxMenu"); if(m) m.hidden = true; return "CLOSED"; })()');
    const before2 = logTail(logFrom).split('[vis] openImage').length - 1;
    await evalJs(visCdp, '(function(){ var it = document.querySelector("#vdList .vd-item");' +
      ' if(!it) return "NO_ITEM"; it.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return "SENT"; })()');
    await sleep(1500);
    const tail2 = logTail(logFrom);
    const after2 = tail2.split('[vis] openImage').length - 1;
    ok('★ 双击抽屉缩略图（共 ' + items + ' 张）→ 同样落盘 + 打开（第 ' + after2 + ' 次）', after2 > before2,
       'openImage 次数 ' + before2 + ' → ' + after2);
    const m2 = /\[vis\] openImage[^\n]*hinst=0/.test(tail2);      // 测试钩子下不会有 hinst
    ok('测试钩子生效：宿主只落盘、没真拉看图软件（日志里没有 hinst= 启动结果）', !m2);
  } catch (e) {
    ok('端到端流程未抛异常', false, (e && e.message) || String(e));
  } finally {
    try { killTrainer(); } catch (e) {}
    await sleep(400);
  }
  console.log('\n== test-vis-open-image: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
})();
