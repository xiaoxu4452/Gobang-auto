'use strict';
const http = require('http');
const cp = require('child_process');
const path = require('path');

const CWD = path.join(__dirname, '..', 'engine-server');
const srv = cp.spawn(process.execPath, ['engine-server.js'], { cwd: CWD, stdio: 'ignore' });

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 8964, path: p }, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  });
}
(async () => {
  let html = '';
  for (let i = 0; i < 60; i++) {
    try { html = await get('/'); if (html.length > 500) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  let bm = '';
  try { bm = await get('/bookmarklet.js'); } catch (e) {}
  const checks = [
    ['启动器: 交换棋提示', html.indexOf('交换棋提示') >= 0],
    ['启动器: 一键复制书签代码', html.indexOf('一键复制书签代码') >= 0],
    ['启动器: 代码框标题栏', html.indexOf('codeBar') >= 0],
    ['启动器: 关闭按钮', html.indexOf('gb_code_close') >= 0],
    ['启动器: hideCode 逻辑', html.indexOf('function hideCode') >= 0],
    ['启动器: max-height 限高', html.indexOf('max-height:320px') >= 0],
    ['启动器: codeBox 内嵌于面板', html.indexOf('gb_code_panel') >= 0],
    ['面板: sideIsManual()', bm.indexOf('sideIsManual') >= 0],
    ['面板: clampSide 自愈', bm.indexOf('clampSide') >= 0],
    ['面板: __gb_side_txt 读数', bm.indexOf('__gb_side_txt') >= 0],
    ['面板: 锁定文案', bm.indexOf('已锁定我执') >= 0],
    ['面板: sideStatusText()', bm.indexOf('sideStatusText') >= 0],
    ['面板: 先后手看门狗', bm.indexOf('先后手不变式看门狗') >= 0],
    ['面板: 重新识别保留手动选择', bm.indexOf('已保留') >= 0],
    ['面板: 未选先后手则不动', bm.indexOf('点选<b>黑</b>或<b>白</b>后再开始') >= 0],
    ['面板: AUTO_SIDE 关闭', bm.indexOf('var AUTO_SIDE = false;') >= 0],
    ['面板: 长度>0', bm.length > 100000],
  ];
  let ok = 0;
  checks.forEach(([n, v]) => { if (v) ok++; console.log((v ? 'PASS ' : 'FAIL ') + n); });
  console.log('--- ' + ok + '/' + checks.length + '  bookmarklet bytes=' + bm.length);
  try { srv.kill(); } catch (e) {}
  process.exit(ok === checks.length ? 0 : 1);
})();
