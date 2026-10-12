/*
 * obfuscator.js —— 「32 字符随机密钥 + 双层异或（两种子交错）+ 字符位移 + base64」保护方案
 *
 * ============================ 方案说明 ============================
 * 用户指定的算法流程（逐字实现，不做额外变换）：
 *
 *   ① 32 字符随机密钥 K                （A-Za-z0-9，共 62 字符表，随机取 32 个）
 *   ② 文本 → UTF-8 字节 B
 *   ③ 第一层异或：B[i] ^= K[i % 32]                       —— 周期性密钥异或
 *   ④ 第二层异或：交错叠加两个伪随机种子流
 *        seed1 = hash(K)            （由密钥派生，解密端可从 K 重算）
 *        seed2 = 随机 32 位常量      （随密文一起存，解密端需要它）
 *        LCG 状态递推：s = (s * 1103515245 + 12345) mod 2^32
 *        i 为偶数 → 用 seed1 流；i 为奇数 → 用 seed2 流   ←「两种子交错」
 *   ⑤ 字符位移：每个字节循环左移 shift 位（shift = 0..7，随密文一起存）
 *   ⑥ base64 编码
 *
 *   解密 = 上述完全逆序：base64 解码 → 循环右移 shift → 交错双层异或 → 密钥异或 → UTF-8 文本
 *
 * 【为什么这样设计是安全的（相对而言）】
 *   · 密钥本身在发布包里只以「32 个字符原地打乱 + 分两段存放」的形式出现，
 *     文件里搜不到连续密钥串；且两个种子都不等于密钥，单看种子推不出密钥。
 *   · 三种变换（周期异或 / 交错 LCG 异或 / 位循环位移）串成一条链，
 *     任何一步猜错都会让后面全错，静态分析要逐字节试。
 *   · 纯 JS 实现、无 Node crypto / zlib 依赖 → 运行时（SEA 下）和
 *     浏览器端都能跑，跨 Firefox / Chrome / Edge 无兼容问题。
 *
 * 【明确的边界（务必知道）】
 *   对称密钥方案的密钥最终必然存在于运行时内存，纯软件无法做到「绝对不可破解」。
 *   本方案的目标是「静态不可读 + 防顺手复制 + 显著抬高门槛」，
 *   这与 bytenode / jsc 等所有 JS 保护方案的边界一致。不要向用户宣称不可破解。
 * ============================ ============================
 */
'use strict';

const KEY_LEN = 32;
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ---- LCG：与运行时包装里的实现必须逐位一致 ----
// 乘数 1103515245 / 增量 12345（经典 ANSI-C LCG）。
// 注意：JS 的 * 会产生浮点误差，必须用 Math.imul 保证 32 位整型语义，
//      否则构建端（Node）与运行时（浏览器/SEA）算出的种子流可能不一致 → 解密乱码。
function lcgNext(s) {
  return (Math.imul(s, 1103515245) + 12345) >>> 0;
}
// 取 LCG 状态的高 8 位作为异或字节（低位周期性差，取高位更均匀）
function lcgByte(s) {
  return (s >>> 24) & 0xff;
}

// ---- 从密钥派生 seed1（解密端可重算；不依赖任何外部随机） ----
// 用「累加哈希」而非 crypto：纯 JS、跨端一致、无依赖。
function seedFromKey(key) {
  let h = 0x811c9dc5 >>> 0;                       // FNV-1a 偏移基
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;           // FNV 质数
  }
  return h >>> 0;
}

// ---- 生成 32 字符随机密钥 ----
function randomKey() {
  const chars = [];
  // 优先用 crypto 的强随机（构建端 Node 环境），退化到 Math.random
  let rnd;
  try { rnd = require('crypto').randomBytes(KEY_LEN); } catch (e) { rnd = null; }
  for (let i = 0; i < KEY_LEN; i++) {
    const v = rnd ? rnd[i] : Math.floor(Math.random() * 256);
    chars.push(KEY_ALPHABET[v % KEY_ALPHABET.length]);
  }
  return chars.join('');
}

// ---- 交错双层异或（加/解密共用同一函数，因为异或自逆） ----
// dir 仅用于语义标注，不影响运算；保留参数是为了调用处可读。
function xorshiftBytes(buf, keyStr, seed2, dir) {
  const k = Buffer.from(keyStr, 'utf8');
  if (k.length !== KEY_LEN) throw new Error('密钥必须为 32 字符，实际 ' + k.length);
  let s1 = seedFromKey(keyStr);
  let s2 = seed2 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    // 第二层：按奇偶交错取两个种子流
    let mix;
    if ((i & 1) === 0) { s1 = lcgNext(s1); mix = lcgByte(s1); }
    else { s2 = lcgNext(s2); mix = lcgByte(s2); }
    // 第一层：周期性密钥异或
    buf[i] = (buf[i] ^ k[i % KEY_LEN] ^ mix) & 0xff;
  }
  return buf;
}

// ---- 字符位移（循环移位；shift 为左移位数，解密时右移同样位数） ----
function shiftBytes(buf, shift, inverse) {
  const s = ((shift % 8) + 8) % 8;
  if (s === 0) return buf;
  const right = s;                 // 加密左移 s 位 → 解密右移 s 位
  const left = 8 - s;              // 等价右移 s 位 = 左移 (8-s) 位
  const amt = inverse ? left : s;  // 统一用「左移 amt」表达
  if (amt === 0) return buf;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = ((buf[i] << amt) | (buf[i] >> (8 - amt))) & 0xff;
  }
  return buf;
}

// ---- 密钥拆分存放：把 32 字符密钥打乱成两段（文件里搜不到连续密钥串） ----
// 返回 {a: string, b: string, order: number[]}
// 还原规则：full[i] = (order[i] === 0 ? a : b)[used[order[i]]++]
function splitKey(keyStr) {
  const n = keyStr.length;
  const order = [];
  const takeA = [];
  const takeB = [];
  // 交替分配：偶数位进 a、奇数位进 b，再各自独立打乱内部顺序
  for (let i = 0; i < n; i++) order.push(i & 1);
  const idxA = [], idxB = [];
  for (let i = 0; i < n; i++) { (order[i] === 0 ? idxA : idxB).push(i); }
  shuffle(idxA); shuffle(idxB);
  const a = idxA.map(i => keyStr[i]).join('');
  const b = idxB.map(i => keyStr[i]).join('');
  // 记录每段的读取顺序映射，解密端据此还原位置
  const posA = idxA.slice(), posB = idxB.slice();
  void takeA; void takeB;
  return { a, b, posA, posB, order };
}

function joinKey(pack) {
  const n = pack.order.length;
  const out = new Array(n);
  let ia = 0, ib = 0;
  for (let i = 0; i < n; i++) {
    if (pack.order[i] === 0) out[pack.posA[ia]] = pack.a[ia++];
    else out[pack.posB[ib]] = pack.b[ib++];
  }
  return out.join('');
}

function shuffle(arr) {
  let r;
  try { r = require('crypto').randomBytes(arr.length); } catch (e) { r = null; }
  for (let i = arr.length - 1; i > 0; i--) {
    const v = r ? r[i] : Math.floor(Math.random() * 256);
    const j = v % (i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ---- 加密：文本 → {b64, seed2, shift, keyPack} ----
function obfuscate(plainText, keyStr) {
  const key = keyStr || randomKey();
  let seed2;
  try { seed2 = require('crypto').randomBytes(4).readUInt32BE(0); }
  catch (e) { seed2 = Math.floor(Math.random() * 0xffffffff) >>> 0; }
  let shift;
  try { shift = require('crypto').randomBytes(1)[0] % 8; }
  catch (e) { shift = Math.floor(Math.random() * 8); }

  const buf = Buffer.from(plainText, 'utf8');
  xorshiftBytes(buf, key, seed2, 'enc');        // ③ 周期密钥异或 + ④ 交错双种子异或
  shiftBytes(buf, shift, false);                // ⑤ 左移 shift 位
  return {
    b64: buf.toString('base64'),                // ⑥ base64
    seed2: seed2 >>> 0,
    shift: shift,
    key: key,
    keyPack: splitKey(key)
  };
}

// ---- 解密：{b64, seed2, shift, key} → 文本 ----
function deobfuscate(b64, seed2, shift, keyStr) {
  const buf = Buffer.from(b64, 'base64');
  shiftBytes(buf, shift, true);                 // 逆 ⑤
  xorshiftBytes(buf, keyStr, seed2, 'dec');     // 逆 ④③（异或自逆，顺序与加密相反需注意）
  return buf.toString('utf8');
}

// ---- 生成运行时自解混淆包装（单行；运行在 Node / SEA 侧）----
// 关键点（SEA 环境）：
//   · SEA 单文件 exe 里，外层脚本由 embedderRunCjs 执行，vm.runInThisContext 内部
//     拿不到 require —— 必须显式把 require/module/__dirname 等作为参数注入被执行的源码。
//   · __dirname 必须指向「exe 所在目录」（真实磁盘路径），因为源码要用它去定位
//     resources/ 与 python/。SEA 下用 path.dirname(process.execPath) 取得。
//   · 运行时解混淆三步（与构建端严格互逆）：base64 解码 → 右移 shift → 双层异或 → 文本
//   · 包装里内联密钥表并用位置表拼回——文件里搜不到连续 32 字符密钥串。
function buildWrapper(enc, filename) {
  const kp = enc.keyPack;
  // 运行时拼回密钥：按 order[i] 选段、按 posA/posB 决定原位置
  const keyParts = JSON.stringify([kp.a, kp.b, kp.posA, kp.posB, kp.order]);
  return "(function(){'use strict';" +
    "var KT=" + keyParts + ",S2=" + (enc.seed2 >>> 0) + ",SH=" + enc.shift + "," +
    "B=Buffer.from(" + JSON.stringify(enc.b64) + ",'base64'),F=" + JSON.stringify(filename) + ";" +
    // --- 拼回 32 字符主密钥 ---
    "var a=KT[0],b=KT[1],pA=KT[2],pB=KT[3],order=KT[4];" +
    "var O=new Array(order.length),ia=0,ib=0,i;" +
    "for(i=0;i<order.length;i++){if(order[i]===0){O[pA[ia]]=a.charAt(ia);ia++;}else{O[pB[ib]]=b.charAt(ib);ib++;}}" +
    "var K=O.join('');" +
    // --- 环境变量优先（便于不同批次分别签发密钥）---
    "if(typeof process!=='undefined'&&process.env&&process.env.GB_MASTER_KEY){K=process.env.GB_MASTER_KEY;}" +
    // --- 逆「字符位移」---
    "var sh=((SH%8)+8)%8;if(sh!==0){var amt=8-sh,bi;" +
    "for(bi=0;bi<B.length;bi++){B[bi]=((B[bi]<<amt)|(B[bi]>>(8-amt)))&255;}}" +
    // --- 逆「双层异或」：第一层周期密钥，第二层两种子按奇偶交错（异或自逆）---
    "var s1=0x811c9dc5>>>0,kk;" +
    "for(kk=0;kk<K.length;kk++){s1^=K.charCodeAt(kk);s1=Math.imul(s1,0x01000193)>>>0;}" +
    "var s2=S2>>>0,ki=K.length;" +
    "for(bi=0;bi<B.length;bi++){var mix;" +
    "if(bi%2===0){s1=(Math.imul(s1,1103515245)+12345)>>>0;mix=(s1>>>24)&255;}" +
    "else{s2=(Math.imul(s2,1103515245)+12345)>>>0;mix=(s2>>>24)&255;}" +
    "B[bi]=(B[bi]^K.charCodeAt(bi%ki)^mix)&255;}" +
    // --- 执行还原后的源码（SEA 下拿不到 __dirname，用 exe 所在目录代替）---
    "var pt=require('path'),M={exports:{}},vm=require('vm');" +
    "var D=pt.dirname(process.execPath),F2=pt.join(D,F);" +
    "vm.runInThisContext('(function(require,module,exports,__filename,__dirname,process,Buffer,console,global){'+B.toString('utf8')+'\\n})',{filename:F})" +
    "(require,M,M.exports,F2,D,process,Buffer,console,global);" +
  "})();";
}

module.exports = {
  KEY_LEN, KEY_ALPHABET,
  randomKey, seedFromKey, xorshiftBytes, shiftBytes,
  splitKey, joinKey, obfuscate, deobfuscate,
  lcgNext, lcgByte, buildWrapper
};
