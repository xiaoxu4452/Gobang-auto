#!/usr/bin/env node
'use strict';
// 查 w64devkit / winlibs 的真实 release 资产 URL（之前 404 很可能是版本号猜错），并测速。
const https = require('https');

function get(url, depth) {
  if ((depth || 0) > 6) return Promise.reject(new Error('redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'gobang', accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, (depth || 0) + 1).then(resolve, reject);
      }
      const b = [];
      res.on('data', (c) => b.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(b).toString('utf8') }));
    }).on('error', reject).setTimeout(25000, function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function rate(url, bytes) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'user-agent': 'gobang' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ code: res.statusCode }); }
      let got = 0; const t = Date.now();
      res.on('data', (c) => {
        got += c.length;
        if (got >= bytes) { res.destroy(); resolve({ code: 200, total: +res.headers['content-length'] || 0, rate: (got / 1048576) / ((Date.now() - t) / 1000) }); }
      });
      res.on('end', () => resolve({ code: 200, total: +res.headers['content-length'] || 0, got, rate: (got / 1048576) / Math.max(0.2, (Date.now() - t) / 1000) }));
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ err: 'timeout' }); });
  });
}

(async () => {
  for (const repo of ['skeeto/w64devkit', 'brechtsanders/winlibs_mingw']) {
    try {
      const r = await get('https://api.github.com/repos/' + repo + '/releases/latest');
      if (r.code !== 200) { console.log(repo + ' → HTTP ' + r.code); continue; }
      const j = JSON.parse(r.body);
      console.log('### ' + repo + ' 最新 ' + j.tag_name);
      for (const a of j.assets.slice(0, 6)) {
        console.log('    ' + (a.size / 1048576).toFixed(1) + 'MB  ' + a.name);
        console.log('        ' + a.browser_download_url);
      }
    } catch (e) { console.log(repo + ' → ' + e.message); }
  }

  console.log('\n=== 对最有希望的资产测速（前 2MB）===');
  const cands = [
    ['w64devkit-2.2.0', 'https://github.com/skeeto/w64devkit/releases/download/v2.2.0/w64devkit-2.2.0.zip'],
    ['w64devkit-2.1.0', 'https://github.com/skeeto/w64devkit/releases/download/v2.1.0/w64devkit-2.1.0.zip'],
  ];
  for (const [n, u] of cands) {
    const r = await rate(u, 2 * 1048576);
    console.log('  ' + n.padEnd(18) + (r.err ? '失败 ' + r.err : 'HTTP ' + r.code + '  总=' + (r.total / 1048576).toFixed(1) + 'MB  速度=' + (r.rate || 0).toFixed(2) + 'MB/s'));
  }
})();
