#!/usr/bin/env node
/**
 * extract-rapfi-networks.js —— 从 WASM 版 rapfi 的 Emscripten 文件包里**还原官方网络权重**。
 *
 * 为什么这么做（而不是去 rapfi-networks 仓库再下一份）：
 *   · `tools/rapfi-wasm-src/rapfi-multi.{js,data}`（2026-09-26 起从 engine-server/resources
 *     归档至此 —— WASM 版已停止分发）里打包的正是当前网页/桌面版
 *     **正在用的那份**网络（mix9svq 系列 + config.toml）。原生引擎用同一份权重，
 *     棋力评估与 WASM 版**逐位同源**，速度提升就干净地来自「原生 + 多线程 + AVX512」，
 *     不存在"顺手换了张网，分数变了也说不清是谁的功劳"。
 *   · Emscripten 的 .data 就是各文件**顺序裸拼**，而 rapfi-multi.js 里带着
 *     `{files:[{filename,start,end}...]}` 偏移表 —— 有了它就能无损切出来。
 *
 * 用法：
 *   node tools/extract-rapfi-networks.js [--out <目录>]
 *   默认输出到 tools/rapfi-src/Networks/（即 CMake 里 NETWORKS_DIR 指向的位置）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_SRC = path.join(ROOT, 'tools', 'rapfi-wasm-src', 'rapfi-multi.js');
const DATA_SRC = path.join(ROOT, 'tools', 'rapfi-wasm-src', 'rapfi-multi.data');

const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 && process.argv[outArg + 1]
  ? path.resolve(process.argv[outArg + 1])
  : path.join(ROOT, 'tools', 'rapfi-src', 'Networks');

function die(msg) { console.error('[networks] ✗ ' + msg); process.exit(1); }

if (!fs.existsSync(JS_SRC)) die('缺少 ' + JS_SRC);
if (!fs.existsSync(DATA_SRC)) die('缺少 ' + DATA_SRC);

// ---- ① 从 loader JS 里取出文件偏移表（closure 压缩过，但这段结构是稳定的）----
const js = fs.readFileSync(JS_SRC, 'utf8');
const m = /files:\[(.*?)\],remote_package_size:(\d+)/s.exec(js);
if (!m) die('在 rapfi-multi.js 里找不到 {files:[...],remote_package_size:N} 元数据段');

const entries = [];
// ★ 别假设是纯单行紧凑格式：closure 压缩后个别条目会**跨行**，且 start/end 有时带引号
//   （`{filename:"x",start:1,"end":2}` 与 `{filename:"y",\nstart:3,end:4}` 两种都出现过）。
//   早期用严格单行正则，结果漏掉了 mix9svqrenju_bs15_black（黑方禁手网）—— 少一张网
//   棋力直接掉档，而且不报错，只在配置里悄悄少了权重。
const re = /\{filename:"([^"]+)"\s*,\s*"?start"?\s*:\s*(\d+)\s*,\s*"?end"?\s*:\s*(\d+)\s*\}/g;
let g;
while ((g = re.exec(m[1])) !== null) {
  entries.push({ name: g[1], start: Number(g[2]), end: Number(g[3]) });
}
if (!entries.length) die('元数据里没有解析出任何文件条目');

const declared = Number(m[2]);
const data = fs.readFileSync(DATA_SRC);
if (data.length !== declared) {
  die('rapfi-multi.data 大小 ' + data.length + ' 与元数据声明 ' + declared + ' 不一致（资源与 loader 不配套）');
}

// ---- ② 按偏移切分落盘 ----
fs.mkdirSync(OUT, { recursive: true });

let total = 0;
const rows = [];
for (const e of entries) {
  if (e.start < 0 || e.end > data.length || e.end <= e.start) die('条目偏移非法：' + JSON.stringify(e));
  const name = e.name.replace(/^\//, '');
  const buf = data.subarray(e.start, e.end);
  const dst = path.join(OUT, name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  total += buf.length;
  rows.push([name, buf.length]);
}

const w = Math.max(...rows.map((r) => r[0].length));
console.log('[networks] 从 rapfi-multi.data 还原 ' + rows.length + ' 个文件 → ' + path.relative(ROOT, OUT));
for (const [name, size] of rows) {
  console.log('  ' + name.padEnd(w) + '  ' + (size / 1048576).toFixed(2) + ' MB');
}
console.log('[networks] 合计 ' + (total / 1048576).toFixed(2) + ' MB（rapfi-multi.data 共 ' +
  (data.length / 1048576).toFixed(2) + ' MB）');

// ---- ③ 顺手把 config.toml 的网表打印出来，方便核对原生引擎会加载哪几张网 ----
const cfg = rows.find((r) => r[0] === 'config.toml');
if (cfg) {
  const txt = fs.readFileSync(path.join(OUT, 'config.toml'), 'utf8');
  const netLines = txt.split(/\r?\n/).filter((l) => /network|\.bin|\.lz4|model/i.test(l));
  if (netLines.length) {
    console.log('[networks] config.toml 里与网络相关的内容：');
    for (const l of netLines.slice(0, 40)) console.log('  | ' + l.trim());
  }
}
