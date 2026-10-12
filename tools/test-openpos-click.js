/* 局面按钮「点击 → openPos → 宿主开窗」端到端测试（真实 Chromium 无头）
 * ----------------------------------------------------------------------------
 * 诊断目的：用户反复报告「局面打不开」。本测试不依赖源码比对，而是用真实 Edge
 * 加载真正的 panel.html（宿主模式，假的 WebView2 桥抓 postMessage），
 *   ① 量出 __gb_pos 按钮在**自然版面**下的几何（是否落在可见视口内 / 是否被滚出折叠区）；
 *   ② 滚到它、真实 .click()，看 window.__msgs 里有没有 {"type":"openPos"}。
 * 结果直接回答两件事：
 *   - 若 openPos 没出现 → 绑定/派发真有 bug（面板侧）；
 *   - 若 openPos 出现、但按钮测出「bottom > 可见视口高度」→ 按钮被面板高度裁掉、
 *     用户根本点不到（布局 bug，不是派发 bug）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'desktop-overlay', 'ui');
const PANEL = path.join(UI_DIR, 'panel.html');
const HARNESS = path.join(UI_DIR, '_openpos_test.html');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const SHELL_JS = `
<script>
(function () {
  window.__msgs = [];
  window.chrome = {
    webview: {
      addEventListener: function (t, fn) { window.__handler = fn; },
      postMessage: function (s) { window.__msgs.push(String(s)); },
    },
  };
  window.fetch = function () { return Promise.reject(new Error('stub')); };
})();
</script>
`;

const TEST_JS = `
<script>
(function () {
  var out = [];
  // ?diag=1 → 视口偏矮，只诊断不断言（见 done() 里的说明）
  window.__gbDiagnoseOnly = location.search.indexOf('diag=1') >= 0;
  function P(label, v) { out.push('PASS | ' + label + ' | ' + v); }
  function F(label, v) { out.push('FAIL | ' + label + ' | ' + v); }
  function finish() {
    var pre = document.createElement('pre');
    pre.id = '__test_out';
    var B = '<<' + 'GBRES' + '>>', E = '<<' + 'GBEND' + '>>';
    pre.textContent = '\\n' + B + '\\n' + out.join('\\n') + '\\n' + E + '\\n';
    document.body.appendChild(pre);
  }
  function done() {
    var btn = document.getElementById('__gb_pos');
    if (!btn) { F('局面按钮存在', '找不到 #__gb_pos'); finish(); return; }
    P('局面按钮存在', 'true');
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = btn.getBoundingClientRect();
    var panel = document.getElementById('__gb_panel');
    var body = document.getElementById('__gb_body');
    var pr = panel.getBoundingClientRect();
    var br = body.getBoundingClientRect();
    P('视口 (innerWidth x innerHeight)', vw + ' x ' + vh);
    var cs = window.getComputedStyle(panel);
    var wrapEl = document.getElementById('__gb_panel_wrap');
    var cw = wrapEl ? window.getComputedStyle(wrapEl) : null;
    P('panel 计算样式', 'position=' + cs.position + ' height=' + cs.height +
      ' maxHeight=' + cs.maxHeight + ' display=' + cs.display +
      ' flexDir=' + cs.flexDirection + ' overflow=' + cs.overflow);
    P('docEl client / body client', document.documentElement.clientWidth + 'x' +
      document.documentElement.clientHeight + ' / ' + document.body.clientWidth + 'x' +
      document.body.clientHeight);
    if (cw) P('panel_wrap 计算样式', 'position=' + cw.position + ' height=' + cw.height +
      ' transform=' + cw.transform + ' contain=' + cw.contain);
    P('面板自然高度 / 底边', Math.round(pr.height) + ' / bottom=' + Math.round(pr.bottom));
    P('按钮几何', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top),
                                   w: Math.round(r.width), h: Math.round(r.height),
                                   bottom: Math.round(r.bottom) }));
    P('body clientHeight / scrollHeight / scrollTop',
      body.clientHeight + ' / ' + body.scrollHeight + ' / ' + Math.round(body.scrollTop));
    // 轴必须在滚动容器「之外」、且在它左边 —— 这样滚多远轴都不动
    var clippedByViewport = pr.bottom > vh + 1;
    var btnVisible = (r.top >= -1) && (r.bottom <= vh + 1);
    // ★ 视口偏矮的场景只做**诊断**，不当断言：headless 的 --window-size 会被 Chrome 的最小窗口
    //   尺寸改写（实测 240x504 拿到的是 510x361），根本没法忠实构造「视口 == 面板高度」这个
    //   生产条件。硬断言这两个场景等于拿一个构造不出来的条件去判红，只会制造噪声。
    //   真正的生产判据由 bridge.js 的运行期探针（footProbe：elementFromPoint + 视口/滚动量）
    //   在用户机器上给——见 host 日志的 "[probe] footbar keys:" 两行。
    var diagnose = window.__gbDiagnoseOnly === true;
    var tag = diagnose ? '（诊断，不断言）' : '';
    if (btnVisible) P('按钮整个落在视口之内' + tag, 'true (btn.bottom=' + Math.round(r.bottom) + ' vh=' + vh + ')');
    else if (diagnose) P('按钮整个落在视口之内' + tag,
      'false —— 视口 ' + vh + ' 比按钮底边 ' + Math.round(r.bottom) + ' 还矮（此场景由 headless 限制造成）');
    else F('按钮整个落在视口之内', 'false (btn.bottom=' + Math.round(r.bottom) + ' vh=' + vh +
        ' 被视口裁掉=' + (clippedByViewport ? '是' : '否') + ')');
    // 命中测试：按钮中心点最上层是不是它自己？被别的东西盖住会立刻暴露。
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var hit = null;
    try { hit = document.elementFromPoint(cx, cy); } catch (e) {}
    var hitId = hit ? (hit.id || hit.tagName + '.' + (hit.className || '')) : 'null';
    if (hit === btn) P('按钮中心点命中测试' + tag, '命中的就是按钮本身');
    else if (hit === null && diagnose) P('按钮中心点命中测试' + tag, 'null（该点落在视口之外）');
    else F('按钮中心点命中测试', '命中的是 ' + hitId + '（按钮被它盖住了）');
    P('点击前 openPos 数', String(window.__msgs.filter(function (m) { return m.indexOf('openPos') >= 0; }).length));
    var n0 = window.__msgs.length;
    try { btn.click(); } catch (e) { F('点击抛出异常', e && e.message); finish(); return; }
    var n = window.__msgs.filter(function (m) { return m.indexOf('openPos') >= 0; }).length;
    if (n >= 1) P('点击后 openPos 已发出', String(n));
    else F('点击后 openPos 未发出', 'window.__msgs=' + JSON.stringify(window.__msgs.slice(n0 - 1, n0 + 8)));
    // ★ B2（2026-09-19，用户）：「在局面的右面添加一个保存局面这个按键，可以保存渲染出来的
    //   识别后的棋盘软件渲染的棋盘 png 图片文件」。
    //   页面这一半的契约就是「点下去真的把 {"type":"savePosPng"} 递到宿主桥」——
    //   底栏的绑定与派发**只看 bridge.js 的 FOOT_ACTIONS 表**，漏登记的后果正是
    //   「按钮长得出来、点下去什么都没发生」（用户报过同类故障，见 FOOT_ACTIONS 的注释）。
    //   ⚠ 这不是「只断言点了有没有发消息」那种假绿：这里跑的是**真实 Chromium + 真 panel.html**，
    //     宿主那一半（渲染 → 编码 PNG → 落盘）由 tools/test-pos-save-png.js 用产物字节单独验。
    var sb = document.getElementById('__gb_possave');
    if (!sb) F('「保存局面」键存在', '找不到 #__gb_possave');
    else {
      P('「保存局面」键存在', 'true');
      var sbr = sb.getBoundingClientRect();
      P('「保存局面」键几何', JSON.stringify({ x: Math.round(sbr.left), y: Math.round(sbr.top),
                                               w: Math.round(sbr.width), h: Math.round(sbr.height) }));
      // 用户第五条：底栏两键「高度和上面的三个按钮一样」
      var rec = document.getElementById('__gb_rec');
      if (rec) {
        var rr2 = rec.getBoundingClientRect();
        // 盒子诊断：等高一旦不成立，光看两个高度数字是查不出原因的（padding？边框？行高？
        // 还是 flex 的 align-items 不一样）—— 把三者的盒子参数一次打出来。
        try {
          var boxOf = function (label, el) {
            if (!el) { P('盒子诊断 ' + label, 'MISSING'); return; }
            var c = window.getComputedStyle(el);
            var pc = window.getComputedStyle(el.parentElement);
            P('盒子诊断 ' + label,
              'h=' + Math.round(el.getBoundingClientRect().height) +
              ' pad=' + c.paddingTop + '/' + c.paddingBottom +
              ' bd=' + c.borderTopWidth + '/' + c.borderBottomWidth +
              ' fs=' + c.fontSize + ' fw=' + c.fontWeight + ' lh=' + c.lineHeight +
              ' box=' + c.boxSizing + ' | 父 align=' + pc.alignItems + ' 父h=' +
              Math.round(el.parentElement.getBoundingClientRect().height));
          };
          boxOf('重新识别', rec);
          boxOf('局面', document.getElementById('__gb_pos'));
          boxOf('保存局面', sb);
        } catch (e) {}
        if (Math.abs(rr2.height - sbr.height) <= 1)
          P('底栏两键与上排三键等高', '保存局面=' + Math.round(sbr.height) + 'px 重新识别=' + Math.round(rr2.height) + 'px');
        else F('底栏两键与上排三键等高', '保存局面=' + Math.round(sbr.height) + 'px vs 重新识别=' + Math.round(rr2.height) + 'px');
      } else F('上排三键还在（等高判据的参照物）', '找不到 #__gb_rec');
      // 用户第二条：它得在「局面」**右面**
      var pb2 = document.getElementById('__gb_pos');
      if (pb2) {
        var pbr = pb2.getBoundingClientRect();
        if (sbr.left >= pbr.right - 1)
          P('「保存局面」排在「局面」右边', 'pos.right=' + Math.round(pbr.right) + ' save.left=' + Math.round(sbr.left));
        else F('「保存局面」排在「局面」右边', 'pos.right=' + Math.round(pbr.right) + ' save.left=' + Math.round(sbr.left));
      } else F('「局面」键还在（左右顺序的参照物）', '找不到 #__gb_pos');
      var s0 = window.__msgs.filter(function (m) { return m.indexOf('savePosPng') >= 0; }).length;
      try { sb.click(); } catch (e) { F('点击「保存局面」抛出异常', e && e.message); }
      var s1 = window.__msgs.filter(function (m) { return m.indexOf('savePosPng') >= 0; }).length;
      if (s1 > s0) P('点击后 savePosPng 已发出', String(s1));
      else F('点击后 savePosPng 未发出', 'window.__msgs=' + JSON.stringify(window.__msgs.slice(-6)));
    }
    // 顺带验证诊断链路：footProbe 探针在 1.2s / 3s 各上报一次，必须能发出来
    // （这条断言是「下次用户跑起来就有据可查」的保障 —— 探针本身坏了就什么都查不到）
    var probe = window.__msgs.filter(function (m) { return m.indexOf('footProbe') >= 0; });
    if (probe.length >= 1) P('footProbe 探针已上报', String(probe.length) + ' 条');
    else F('footProbe 探针已上报', '0 条（诊断链路断了）');
    finish();
  }
  // 3.6s：必须晚于 footProbe 的第二枪（3s），否则断言的是「还没跑」而不是「没发」
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(done, 3600);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(done, 3600); });
})();
</script>
`;

/** 跑一轮：给定窗口尺寸，返回浏览器回传的完整 DOM。 */
function runOnce(browser, url, w, h) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-op-'));
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--window-size=' + w + ',' + h,
      '--user-data-dir=' + profile, '--virtual-time-budget=12000', '--dump-dom', url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let dom = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { dom += d; });
    const killer = setTimeout(() => { try { child.kill(); } catch (x) {} }, 60000);
    child.on('exit', () => {
      clearTimeout(killer);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (x) {}
      resolve(dom);
    });
  });
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function main() {
  let browser = null;
  for (const b of BROWSERS) { if (fs.existsSync(b)) { browser = b; break; } }
  if (!browser) { console.error('找不到 Edge/Chrome'); process.exit(1); }

  for (const [name, src] of [['SHELL_JS', SHELL_JS], ['TEST_JS', TEST_JS]]) {
    const body = src.replace(/^\s*<script>\s*/, '').replace(/<\/script>\s*$/, '');
    try { new vm.Script(body); } catch (e) { console.error(name + ' 语法错误：' + e.message); process.exit(1); }
  }

  let html = fs.readFileSync(PANEL, 'utf8');
  const atShell = html.indexOf('<script src="panel-ui.js">');
  if (atShell < 0) { console.error('找不到 panel-ui.js 引用'); process.exit(1); }
  html = html.slice(0, atShell) + SHELL_JS + html.slice(atShell);
  const atEnd = html.lastIndexOf('</body>');
  html = html.slice(0, atEnd) + TEST_JS + html.slice(atEnd);
  fs.writeFileSync(HARNESS, html, 'utf8');

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const f = path.join(UI_DIR, rel);
    if (!f.startsWith(UI_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    const ext = path.extname(f);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });

  server.listen(0, '127.0.0.1', async () => {
    const url = 'http://127.0.0.1:' + server.address().port + '/' + path.basename(HARNESS);
    let pass = 0, fail = 0, firstHeight = 0;

    // 场景一：大窗口 —— 先量出面板的自然高度，后面两个场景就照它来搭视口。
    const scenarios = [{ name: '视口远大于面板（普通大窗口）', w: 1200, h: 900, derived: false }];

    for (let i = 0; i < scenarios.length; i++) {
      const sc = scenarios[i];
      console.log('\n== ' + sc.name + '  (--window-size=' + sc.w + ',' + sc.h + ') ==');
      const dom = await runOnce(browser, url + (sc.diag ? '?diag=1' : ''), sc.w, sc.h);
      if (!dom.trim()) { console.error('  浏览器无回传（exit 早于输出）'); fail++; continue; }
      const m = /<<GBRES>>([\s\S]*?)<<GBEND>>/.exec(unesc(dom));
      if (!m) { console.error('  页面无回传（请检查 TEST_JS 是否抛异常）'); fail++; continue; }
      for (const line of m[1].split('\n')) {
        const t = line.trim();
        if (t.indexOf('PASS |') === 0) { pass++; console.log('  ✓ ' + t.slice(7)); }
        else if (t.indexOf('FAIL |') === 0) { fail++; console.log('  ✗ ' + t.slice(7)); }
      }
      if (i === 0) {
        // 从第一轮拿到面板自然高度 → 后两轮照它搭视口（== 和 略显不足）
        const mm = /面板自然高度 \/ 底边 \| (\d+)/.exec(m[1]);
        firstHeight = mm ? parseInt(mm[1], 10) : 645;
        scenarios.push({ name: '视口 == 面板自然高度（宿主现状，刚好贴边）—— 仅诊断',
                         w: 240, h: firstHeight, diag: true });
        scenarios.push({ name: '视口比面板矮 60px（内容被视口裁掉的情形）—— 仅诊断',
                         w: 240, h: Math.max(300, firstHeight - 60), diag: true });
      }
    }

    server.close();
    try { fs.unlinkSync(HARNESS); } catch (x) {}
    console.log('\n--- test-openpos-click: ' + pass + ' passed, ' + fail + ' failed ---');
    process.exit(fail ? 1 : 0);
  });
}
main();
