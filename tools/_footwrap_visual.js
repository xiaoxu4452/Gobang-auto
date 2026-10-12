/* 临时可视化：把 calc.html 里的**棋盘底栏**单独放到一个最小页面里渲染（不带 calc.js，
   没有异步/时间差），于是「某个容器宽度下底栏长什么样」是确定性的，可以逐宽度截图看。
   用法：node tools/_footwrap_visual.js  // 输出 tools/_footshots/bar_<w>.png
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const UI = path.join(ROOT, 'desktop-calculator', 'ui');
const OUT = path.join(ROOT, 'tools', '_footshots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const WIDTHS = process.argv.slice(2).length ? process.argv.slice(2) : ['1400', '1100', '900', '820', '760', '700', '620', '560'];

function extractFoot(rawHtml) {
  // 先剥掉 HTML 注释（里面会出现 `#boardFoot` 之类的文字，数 <div> 时会被误导）
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');
  const i = html.indexOf('<div id="boardFoot">');
  if (i < 0) throw new Error('no #boardFoot');
  let depth = 0, j = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = i;                       // ★ 必须从底栏起点开始数，否则会数到文档里的第一个 </div>
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { j = re.lastIndex; break; }
  }
  if (!j) throw new Error('unbalanced #boardFoot');
  return html.slice(i, j);
}

function buildPage(foot) {
  let css = fs.readFileSync(path.join(UI, 'calc.css'), 'utf8');
  const probe = [
    '<script>',
    'function R(e){var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};}',
    'window.addEventListener("load",function(){',
    ' var f=document.getElementById("boardFoot");',
    ' var cs=[].map.call(f.children,function(c){return (c.id||c.className)+":"+R(c).x+","+R(c).y+" "+R(c).w+"x"+R(c).h;});',
    ' var b=document.getElementById("boardBtns");',
    ' var bs=[].map.call(b.children,function(c){return (c.id||c.className)+":"+R(c).x+","+R(c).y+" "+R(c).w+"x"+R(c).h;});',
    ' var p=document.getElementById("btn_prev"),q=document.getElementById("btn_reset");',
    ' var ov=document.createElement("pre");ov.id="GBN";',
    ' ov.style.cssText="position:fixed;left:2px;top:2px;width:100%;font:11px monospace;background:#fff;color:#000;z-index:9;margin:0;white-space:pre-wrap";',
    ' ov.textContent="FOOT "+R(f).w+"x"+R(f).h+"\\n"+cs.join("\\n")+"\\nBTNS\\n"+bs.join("\\n")+"\\nprev "+R(p).w+"x"+R(p).h+" fs="+getComputedStyle(p).fontSize+"  reset "+R(q).w+"x"+R(q).h;',
    ' document.body.appendChild(ov);',
    '});',
    '</script>',
  ].join('\n');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<style>', css, '</style>',
    '<style>',
    // 只留底栏：把棋盘、顶栏、左右停靠栏全部收掉，让 #boardFoot 的容器宽度 = 窗口宽度
    '#hdr,#dockL,#dockR,#openBar,#swapPop,#mirrorPop,#shiftPop,#aiSidePop,#setPop,#drawer,#rvBar,#egBar{display:none !important}',
    '#boardWrap{min-height:40px}',
    'body{padding-top:132px}',            // 给上面的探针文字留位置，底栏本体在下面看得见
    '</style></head><body data-theme="light">',
    probe,
    '<div id="boardCol">', foot, '</div>',
    '</body></html>',
  ].join('\n');
}

function serve(html) {
  return new Promise((res) => {
    const srv = http.createServer((req, r2) => {
      if (/__bar\.html/.test(req.url)) { r2.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r2.end(html); return; }
      r2.writeHead(404); r2.end('nf');
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

function shot(url, W) {
  return new Promise((res) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-bar-'));
    const child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--user-data-dir=' + profile, '--window-size=' + W + ',300',
      '--virtual-time-budget=3000', '--screenshot=' + path.join(OUT, 'bar_' + W + '.png'), url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} done(); }, 40000);
    function done() { clearTimeout(t); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} res(err.slice(-300)); }
    child.on('exit', done);
  });
}

(async function main() {
  const html = buildPage(extractFoot(fs.readFileSync(path.join(UI, 'calc.html'), 'utf8')));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tools', '_footshots', '_bar_harness.html'), html, 'utf8');
  const { srv, port } = await serve(html);
  const url = 'http://127.0.0.1:' + port + '/__bar.html';
  for (const W of WIDTHS) {
    await shot(url, W);
    console.log('shot bar_' + W + '.png');
  }
  srv.close();
})();
