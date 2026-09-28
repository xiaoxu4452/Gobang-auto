/* 临时探针：在多个视口宽度下量「棋盘底栏」的真实几何 ——
   ① 分成几行（#boardFoot 的直接子项有几个不同的 top = 几行）
   ② #boardBtns 内部是否换行
   ③ 有没有横向溢出（scrollWidth > clientWidth）
   ④ 每颗键的 rect（宽高），‹ › 的字号与键高
   用法：node tools/_footwrap_probe.js [宽度,宽度,...]
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.dirname(__dirname);
const UI = path.join(ROOT, 'desktop-calculator', 'ui');
const HTML = path.join(UI, 'calc.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const SNIP = [
  '<script>',
  '(function(){',
  'function R(el){var r=el.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};}',
  'function rows(host){var cs=Array.prototype.map.call(host.children,function(c){var r=R(c);return [c.id||c.className||c.tagName,r];}).filter(function(p){return p[1].w>0&&p[1].h>0;});',
  '  var lines=[];for(var i=0;i<cs.length;i++){var t=cs[i][1].y,b=cs[i][1].y+cs[i][1].h,put=null;',
  '    for(var j=0;j<lines.length;j++){var L=lines[j];if(t<L.b-1&&b>L.t+1){put=L;break;}}',
  '    if(put){put.t=Math.min(put.t,t);put.b=Math.max(put.b,b);put.n.push(cs[i][0]);}',
  '    else lines.push({t:t,b:b,n:[cs[i][0]]});}',
  '  return lines.map(function(L){return L.n.join("+");});}',
  'function list(sel){var host=document.querySelector(sel);if(!host)return [];return Array.prototype.map.call(host.children,function(c){var r=R(c);return (c.id||c.className||c.tagName)+"@"+r.x+","+r.y+" "+r.w+"x"+r.h;});}',
  'function kidsFit(sel){var host=document.querySelector(sel);if(!host)return null;var need=0,fail=0;',
  '  Array.prototype.forEach.call(host.children,function(c){var r=R(c);need+=r.w;});',
  '  var cs=getComputedStyle(host), gap=parseFloat(cs.columnGap)||0; need+=gap*(host.children.length-1);',
  '  Array.prototype.forEach.call(host.children,function(c){',
  '    if(c.scrollWidth>c.clientWidth+1||c.scrollHeight>c.clientHeight+1)fail++;});',
  '  return {need:Math.round(need),avail:Math.round(host.getBoundingClientRect().width),clipped:fail};}',
  'function overlap(sel){var host=document.querySelector(sel);if(!host)return [];var out=[];',
  '  var a=Array.prototype.map.call(host.children,function(c){var r=R(c);return [c.id||c.className||c.tagName,r];});',
  '  for(var i=0;i<a.length;i++)for(var j=i+1;j<a.length;j++){var p=a[i][1],q=a[j][1];',
  '    if(p.x<q.x+q.w-1&&q.x<p.x+p.w-1&&p.y<q.y+q.h-1&&q.y<p.y+p.h-1)out.push(a[i][0]+"~"+a[j][0]);}',
  '  return out;}',
  'window.addEventListener("load",function(){setTimeout(function(){try{',
  '  var o={vpos:[window.innerWidth,window.innerHeight],rootFont:getComputedStyle(document.documentElement).fontSize};',
  '  ["#boardWrap","#boardCol","#boardFoot","#boardBtns"].forEach(function(s){var e=document.querySelector(s);o[s]=e?R(e):null;});',
  '  var f=document.querySelector("#boardFoot");',
  '  o.footLines=rows(f); o.footOverflow=[f.scrollWidth,f.clientWidth]; o.footFit=kidsFit("#boardFoot"); o.footOverlap=overlap("#boardFoot");',
  '  var b=document.querySelector("#boardBtns");',
  '  o.btnsLines=rows(b); o.btnsOverflow=[b.scrollWidth,b.clientWidth]; o.btnsFit=kidsFit("#boardBtns"); o.btnsOverlap=overlap("#boardBtns");',
  '  var cl=document.querySelector("#boardFoot .bf-l"), cr=document.querySelector("#boardFoot .bf-r");',
  '  var lb=R(b),lf=R(f),lcl=cl?R(cl):null,lcr=cr?R(cr):null;',
  '  o.rowCenterDelta=Math.round(((lb.x+lb.w/2)) - ((lf.x+lf.w/2)));',
  '  o.groupCenterDelta=(lcl&&lcr)?Math.round(((lcl.x+lcr.x+lcr.w)/2) - ((lf.x+lf.w/2))):null;',
  '  o.btnsList=list("#boardBtns"); o.footChildren=list("#boardFoot");',
  '  ["btn_prev","btn_next","btn_reset","btn_save","btn_live","btn_aiside","btn_set"].forEach(function(id){var e=document.getElementById(id);if(!e)return;var cs=getComputedStyle(e);var r=R(e);o["k_"+id]=r.w+"x"+r.h+" fs="+cs.fontSize+" pad="+cs.padding;});',
  '  var p=document.getElementById("btn_prev"), pa=p?parseFloat(getComputedStyle(p).fontSize):0, pr=p?R(p):null;',
  '  o.prevFont=pa; o.prevBox=pr;',
  '  var T1="<<GBR"+"ES>>", T2="<<GBE"+"ND>>";',
  '  var pre=document.createElement("pre"); pre.id="GBRES";',
  '  pre.style.cssText="position:fixed;left:4px;top:58px;width:min(46vw,420px);max-height:120px;overflow:hidden;font:9px monospace;background:#fff;color:#000;z-index:99999;white-space:pre-wrap;margin:0;padding:2px";',
  '  o.sum="inner="+window.innerWidth+"x"+window.innerHeight+" foot="+o["#boardFoot"].w+"x"+o["#boardFoot"].h+" lines="+o.footLines.length+" ["+o.footLines.join(" | ")+"]";',
  '  pre.textContent=T1+o.sum+"\\n"+JSON.stringify(o,null,1)+T2;',
  '  document.body.appendChild(pre);',
  '}catch(e){var p2=document.createElement("pre");p2.id="GBRES";p2.textContent="<<GBR"+"ES>>ERR "+e.message+"<<GBE"+"ND>>";document.body.appendChild(p2);}},900);});',
  '})();',
  '</script>',
].join('\n');

const WIDTHS = process.argv.slice(2).length ? process.argv.slice(2) : ['1600', '1280', '1000', '860', '720', '640', '560', '480'];

function buildHarness() {
  let html = fs.readFileSync(HTML, 'utf8');
  const at = html.lastIndexOf('</body>');
  if (at < 0) throw new Error('no </body>');
  return html.slice(0, at) + SNIP + html.slice(at);
}

function serve(html) {
  return new Promise((res) => {
    const srv = http.createServer((req, res2) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      if (rel === '__probe.html') { res2.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res2.end(html); return; }
      const f = path.join(UI, rel);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res2.writeHead(404); res2.end('nf'); return; }
      const ext = path.extname(f);
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/css';
      res2.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      res2.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

function runOnce(browser, url, W, H) {
  return new Promise((res) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-foot-'));
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--user-data-dir=' + profile, '--window-size=' + W + ',' + H,
      '--virtual-time-budget=9000',
    ];
    const shot = process.env.GB_SHOT ? path.join(process.env.GB_SHOT, 'foot_' + W + '.png') : '';
    if (shot) args.push('--screenshot=' + shot);
    args.push('--dump-dom', url);
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { dom += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} fin(); }, 45000);
    function fin() {
      clearTimeout(t);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
      res(m ? m[1] : '<<no probes result>>');
    }
    child.on('exit', () => fin());
  });
}

(async function main() {
  const html = buildHarness();
  const { srv, port } = await serve(html);
  const url = 'http://127.0.0.1:' + port + '/__probe.html';
  for (const W of WIDTHS) {
    const out = await runOnce(EDGE, url, W, 900);
    let o = null;
    try {
      const body = String(out);
      const i = body.indexOf('\n');
      o = JSON.parse(i >= 0 ? body.slice(i + 1) : body);
    } catch (e) { console.log('  parse fail: ' + String(out).slice(0, 300)); return; }
    const kb = (id) => (o['k_' + id] || '-');
    console.log('  foot w=' + o['#boardFoot'].w + ' h=' + o['#boardFoot'].h +
      ' | footLine(s)=[' + o.footLines.join(' | ') + ']' +
      ' | btnsLine(s)=[' + o.btnsLines.join(' | ') + ']' +
      ' | overlap=' + (o.footOverlap.length + o.btnsOverlap.length) +
      ' | clipped=' + o.footFit.clipped + '/' + o.btnsFit.clipped +
      ' | rowΔ=' + o.rowCenterDelta + ' groupΔ=' + o.groupCenterDelta);
    console.log('  prev=' + kb('btn_prev') + '  reset=' + kb('btn_reset') + '  live=' + kb('btn_live'));
  }
  srv.close();
})();
