/*
 * zip.js —— 最小 ZIP 打包器（deflate，无需外部依赖）
 *
 * 用法: node zip.js <源目录> <输出.zip>
 * 把 <源目录> 的「内容」按顶层目录名打包进去（与常见右键压缩行为一致）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [srcDir, outZip] = process.argv.slice(2);
if (!srcDir || !outZip) {
  console.error('usage: node zip.js <srcDir> <out.zip>');
  process.exit(1);
}

// 收集条目（目录名以 / 结尾，与常规 zip 一致）
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      out.push({ rel: rel + '/', full, dir: true });
      walk(full, rel, out);
    } else {
      out.push({ rel, full, dir: false });
    }
  }
}

const rootName = path.basename(srcDir);
const entries = [];
walk(srcDir, rootName, entries);

// CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// DOS 时间戳
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

const chunks = [];
const central = [];
let offset = 0;

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }

for (const e of entries) {
  const nameBuf = Buffer.from(e.rel, 'utf8');
  let data = Buffer.alloc(0);
  let method = 0, comp = Buffer.alloc(0), crc = 0, rawLen = 0;

  if (!e.dir) {
    data = fs.readFileSync(e.full);
    rawLen = data.length;
    crc = crc32(data);
    if (data.length > 0) {
      const d = zlib.deflateRawSync(data, { level: 9 });
      // 只有压缩确实更小才用 deflate（极小/已压缩文件用 store 更快）
      if (d.length < data.length) { method = 8; comp = d; } else { method = 0; comp = data; }
    }
  }

  const lh = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(method),
    u16(dosTime), u16(dosDate), u32(crc),
    u32(comp.length), u32(rawLen), u16(nameBuf.length), u16(0),
    nameBuf
  ]);
  chunks.push(lh, comp);

  central.push(Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(method),
    u16(dosTime), u16(dosDate), u32(crc),
    u32(comp.length), u32(rawLen), u16(nameBuf.length),
    u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
    nameBuf
  ]));
  offset += lh.length + comp.length;
}

const cd = Buffer.concat(central);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0),
  u16(entries.length), u16(entries.length),
  u32(cd.length), u32(offset), u16(0)
]);

fs.mkdirSync(path.dirname(outZip), { recursive: true });
const fd = fs.openSync(outZip, 'w');
fs.writeSync(fd, Buffer.concat(chunks));
fs.writeSync(fd, cd);
fs.writeSync(fd, eocd);
fs.closeSync(fd);
console.log('  ' + entries.length + ' 条目');
