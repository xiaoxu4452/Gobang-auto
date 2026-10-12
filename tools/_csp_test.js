/* CSP 场景验证（2026-09-26 回归历史版加载器后重写）：
 * 起一个带 CSP 的测试页 —— script-src 允许自身/内联/127.0.0.1:8964 但 **不含 'unsafe-eval'**，
 * connect-src 允许 8964 —— 精确复现「XHR 能拉到代码、eval/new Function 被拦」的站点。
 * 书签码从 8964 安装页的 var BM = "..." 真实抓取；页面 <script> 内直接执行书签体
 * （等价于点书签）。★ 历史版加载器契约（恢复与备份/engine-server 同款，实测 playok 可用）：
 *   XHR 取文本 → eval/new Function 执行 → 全被拦时弹「CSP 禁止注入脚本」提示（优雅降级，不崩）。
 * 断言：① 书签体是历史形态（XHR 优先、无 /panel 窗口兜底）；② 执行后收到 CSP 提示弹窗；
 *       ③ 无未捕获异常（pageerror 为空）。
 * 前置：engine-server 已在 8964 运行（外部启动）。
 */
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright-core');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => resolve(s)); }).on('error', reject);
  });
}

(async () => {
  // 1. 从真实安装页抓书签码
  const page1 = await get('http://127.0.0.1:8964/');
  const m = page1.match(/var BM = ("(?:[^"\\]|\\.)*")/);
  if (!m) { console.log('FAIL: 安装页里没抓到 var BM'); process.exit(1); }
  const bm = JSON.parse(m[1]);
  const body = bm.replace(/^javascript:/, '');
  // ★ 2026-09-26 恢复历史版：XHR 优先、boot 里 CSP 提示、无 /panel 独立窗口
  const histForm =
    body.indexOf('XMLHttpRequest') > -1 &&
    body.indexOf('/panel') < 0 &&
    body.indexOf('if(!run(t)){say(') > -1;
  console.log('BM 长度:', bm.length, '| 历史版形态(XHR优先/无panel/含CSP提示):', histForm);

  // 2. CSP 测试页（拦 eval，放行本机 script 与 connect）
  const CSP = "default-src 'none'; script-src 'self' http://127.0.0.1:8964 'unsafe-inline'; connect-src http://127.0.0.1:8964; style-src 'unsafe-inline'; img-src * data:";
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<h1>CSP test page (no unsafe-eval)</h1>' +
    '<script>' + body + '</scr' + 'ipt>' +
    '</body></html>';

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    res.end(html);
  });
  await new Promise((r) => server.listen(8899, '127.0.0.1', r));

  // 3. playwright 验证：eval 被拦 → 应收到「CSP 禁止注入脚本」提示，且不崩
  const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const alerts = [];
  const pageErrors = [];
  page.on('dialog', async (d) => { alerts.push(d.message()); await d.dismiss(); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto('http://127.0.0.1:8899/');
  await page.waitForTimeout(4000); // 给 XHR + 弹窗留时间
  const cspAlert = alerts.find((a) => a.indexOf('安全策略') > -1 || a.indexOf('禁止注入') > -1);
  const okAll = histForm && cspAlert && pageErrors.length === 0;
  console.log('CSP 提示弹窗:', cspAlert ? '✓' : '✗', '| pageerror:', pageErrors.length ? pageErrors : '无');
  console.log(okAll ? 'PASS: 历史版加载器在 CSP 站点优雅降级（提示明确、不崩溃）' : 'FAIL');
  await browser.close();
  server.close();
  process.exit(okAll ? 0 : 1);
})().catch((e) => { console.log('TEST ERROR:', e.message); process.exit(1); });
