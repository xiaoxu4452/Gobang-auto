#!/usr/bin/env node
'use strict';
// 探测便携 C++ 工具链的可获取性（不用 MSVC：本机 VS 未装 C++ 工作负载）。
// 只做「连通性 + 前若干 MB 的速度」测试，不下整包。
const https = require('https');
const t0 = Date.now();

function probe(url, bytes, depth) {
  if ((depth || 0) > 6) return Promise.resolve({ url, err: 'too many redirects' });
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'user-agent': 'gobang-probe' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(probe(res.headers.location, bytes, (depth || 0) + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ url, code: res.statusCode });
      }
      let got = 0;
      const start = Date.now();
      res.on('data', (c) => {
        got += c.length;
        if (got >= bytes) {
          const sec = (Date.now() - start) / 1000;
          res.destroy();
          resolve({ url, code: 200, size: res.headers['content-length'], rate: (got / 1048576) / Math.max(0.001, sec) });
        }
      });
      res.on('end', () => {
        const sec = (Date.now() - start) / 1000;
        resolve({ url, code: 200, size: res.headers['content-length'], rate: got ? (got / 1048576) / Math.max(0.001, sec) : 0, short: got });
      });
    });
    req.on('error', (e) => resolve({ url, err: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ url, err: 'timeout' }); });
  });
}

const targets = [
  // w64devkit：单 zip 便携 gcc/g++，无需安装
  ['w64devkit', 'https://github.com/skeeto/w64devkit/releases/download/v2.3.0/w64devkit-2.3.0.zip'],
  ['winlibs', 'https://github.com/brechtsanders/winlibs_mingw/releases/download/14.2.0posix-19.1.1-12.0.0-ucrt-r2/winlibs-x86_64-posix-seh-gcc-14.2.0-mingw-w64ucrt-12.0.0-r2.zip'],
  ['mingw-builds', 'https://github.com/niXman/mingw-builds-binaries/releases/download/14.2.0-rt_v12-rev0/x86_64-14.2.0-release-posix-seh-ucrt-rt_v12-rev0.7z'],
  ['gh-mirror-test', 'https://ghproxy.net/https://github.com/skeeto/w64devkit/releases/download/v2.3.0/w64devkit-2.3.0.zip'],
];

(async () => {
  for (const [name, url] of targets) {
    const r = await probe(url, 2 * 1048576);
    if (r.err) console.log(name.padEnd(16) + ' 失败: ' + r.err);
    else if (r.code !== 200) console.log(name.padEnd(16) + ' HTTP ' + r.code);
    else console.log(name.padEnd(16) + ' OK  总大小=' + ((+r.size || 0) / 1048576).toFixed(1) + 'MB  实测速度=' + r.rate.toFixed(2) + ' MB/s');
  }
  console.log('（探测耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
})();
