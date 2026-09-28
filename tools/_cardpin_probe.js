/* 临时探针：卡片「固定 / 关闭 / 罗列顺序」的真实行为（无头 Edge 里驱动页面的真函数）。
   用法：node tools/_cardpin_probe.js
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const UI = path.join(ROOT, 'desktop-calculator', 'ui');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const IDS = ['setup', 'analysis', 'engine'];

const SNIP = [
  '<script>',
  'window.addEventListener("load", function(){ setTimeout(function(){',
  '  var IDS=' + JSON.stringify(IDS) + ';',
  '  var out=[];',
  '  function card(id){ return document.querySelector(\'.card[data-id="\'+id+\'"]\'); }',
  '  function snap(tag){',
  '    var o={tag:tag, pins:Object.keys(CARD_PIN).sort(), vis:{}, key:{}};',
  '    IDS.forEach(function(id){ var c=card(id); var pk=c&&c.querySelector(".pinkey");',
  '      o.vis[id]=!!(c&&!c.hidden); o.key[id]=pk?pk.textContent:"-"; });',
  '    o.dockL=[].map.call(document.querySelectorAll("#dockL .card"),function(c){return c.getAttribute("data-id")+(c.hidden?"(h)":"");});',
  '    o.dockR=[].map.call(document.querySelectorAll("#dockR .card"),function(c){return c.getAttribute("data-id")+(c.hidden?"(h)":"");});',
  '    out.push(o); return o; }',
  '  function pin(id){ var pk=card(id).querySelector(".pinkey"); pk.click(); }',
  '  try{',
  '    snap("0 初始");',
  '    toggleCardFromMenu("setup"); snap("1 设置里开对局设置");',
  '    pin("setup"); snap("2 点它的「固定」");',
  '    toggleCardFromMenu("analysis"); snap("3 设置里开计算评估");',
  '    pin("analysis"); snap("4 也固定计算评估（三卡同列）");',
  '    toggleCardFromMenu("setup"); snap("5 弹窗里关掉已固定的对局设置");',
  '    toggleCardFromMenu("setup"); snap("6 再开回来（该卡右上的键是什么？）");',
  '    toggleCardFromMenu("analysis"); snap("7 弹窗里关掉已固定的计算评估");',
  '    toggleCardFromMenu("analysis"); snap("8 再开回来");',
  '    toggleCardFromMenu("engine"); snap("9 弹窗里关掉引擎仪表盘（默认固定）");',
  '    toggleCardFromMenu("engine"); snap("10 再开回引擎仪表盘");',
  '  }catch(e){ out.push({tag:"EXC", err:String(e && e.message)}); }',
  '  var pre=document.createElement("pre"); pre.id="GBCP"; pre.style.display="none";',
  '  pre.textContent="<<GBC"+"P>>"+JSON.stringify(out)+"<<GBC"+"PE>>";',
  '  document.body.appendChild(pre);',
  '},1600); });',
  '</script>',
].join('\n');

function buildHarness() {
  let html = fs.readFileSync(path.join(UI, 'calc.html'), 'utf8');
  const at = html.lastIndexOf('</body>');
  return html.slice(0, at) + SNIP + html.slice(at);
}

function serve(html) {
  return new Promise((res) => {
    const srv = http.createServer((req, r2) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      if (rel === '__cp.html') { r2.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r2.end(html); return; }
      const f = path.join(UI, rel);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r2.writeHead(404); r2.end('nf'); return; }
      const ext = path.extname(f);
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/css';
      r2.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      r2.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

(async function main() {
  const html = buildHarness();
  const { srv, port } = await serve(html);
  const url = 'http://127.0.0.1:' + port + '/__cp.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cp-'));
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--user-data-dir=' + profile, '--window-size=1280,900', '--virtual-time-budget=12000', '--dump-dom', url,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let dom = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { dom += d; });
  const done = () => {
    srv.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const m = /<<GBCP>>([\s\S]*?)<<GBCPE>>/.exec(unesc(dom));
    if (!m) { console.log('no result'); return; }
    JSON.parse(m[1]).forEach((o) => {
      if (o.tag === 'EXC') { console.log('EXC ' + o.err); return; }
      console.log(o.tag + ' | pins=[' + o.pins.join(',') + '] vis=' + IDS.map((i) => i + ':' + (o.vis[i] ? 1 : 0) + o.key[i]).join(' ') +
        ' | L=' + o.dockL.join('>') + ' R=' + o.dockR.join('>'));
    });
  };
  const t = setTimeout(() => { try { child.kill(); } catch (e) {} done(); }, 60000);
  child.on('exit', () => { clearTimeout(t); done(); });
})();
