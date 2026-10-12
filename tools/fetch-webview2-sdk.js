#!/usr/bin/env node
/**
 * 取 WebView2 SDK（NuGet 包）并解出 C++ 宿主需要的三样东西：
 *   build/native/include/WebView2.h        （COM 接口声明）
 *   build/native/include/WebView2EnvironmentOptions.h
 *   build/native/x64/WebView2LoaderStatic.lib（静态链接，免发 WebView2Loader.dll）
 *
 * 产物落 tools/webview2-sdk/，由 build-overlay.js 编译时引用。
 * 幂等：已存在且版本一致则跳过下载。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'webview2-sdk');
const STAMP = path.join(OUT, 'VERSION');

function get(url, depth = 0) {
  if (depth > 6) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'gobang-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** 极简 zip 读取器（store + deflate 两种方法即可，NuGet 包不会用别的） */
function unzip(buf) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏 @' + off);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // 本地头：跳过它的 name/extra
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else data = null; // 不支持的方法，跳过
    if (data) out.push({ name, data, usize });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

(async () => {
  const index = JSON.parse((await get(
    'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json'
  )).toString('utf8'));
  const stable = index.versions.filter((v) => !/-/.test(v));
  const ver = stable[stable.length - 1];

  if (fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === ver) {
    console.log('[webview2-sdk] 已是 ' + ver + '，跳过');
    return;
  }

  console.log('[webview2-sdk] 下载 Microsoft.Web.WebView2 ' + ver + ' …');
  const url = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + ver +
    '/microsoft.web.webview2.' + ver + '.nupkg';
  const buf = await get(url);
  console.log('[webview2-sdk] 包大小 ' + (buf.length / 1048576).toFixed(2) + ' MB，解压中…');
  const entries = unzip(buf);

  const want = [
    ['build/native/include/WebView2.h', 'include/WebView2.h'],
    ['build/native/include/WebView2EnvironmentOptions.h', 'include/WebView2EnvironmentOptions.h'],
    ['build/native/x64/WebView2LoaderStatic.lib', 'lib/x64/WebView2LoaderStatic.lib'],
    ['build/native/x86/WebView2LoaderStatic.lib', 'lib/x86/WebView2LoaderStatic.lib'],
    ['build/native/arm64/WebView2LoaderStatic.lib', 'lib/arm64/WebView2LoaderStatic.lib'],
    ['build/native/x64/WebView2Loader.dll', 'bin/x64/WebView2Loader.dll'],
  ];
  const lower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  let got = 0;
  for (const [src, dst] of want) {
    const hit = lower.get(src.toLowerCase());
    if (!hit) { console.log('   缺: ' + src); continue; }
    const p = path.join(OUT, dst);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, hit.data);
    console.log('   ✓ ' + dst + '  ' + (hit.data.length / 1024).toFixed(1) + ' KB');
    got++;
  }
  if (!got) throw new Error('包里没找到任何需要的文件（结构变了？）');
  fs.writeFileSync(STAMP, ver);
  console.log('[webview2-sdk] 完成 → ' + OUT + '  (version ' + ver + ')');
})().catch((e) => {
  console.error('[webview2-sdk] 失败: ' + e.message);
  process.exit(1);
});
