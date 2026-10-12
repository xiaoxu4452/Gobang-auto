/*
 * verify-release-server.js —— 解密发布目录的 engine-server.js（自解密包装），
 * 拿到真正的服务端源码，核对它是源工程最新版本。
 *
 * 方案：32 字符随机密钥 + 双层异或（两种子交错）+ 字符位移 + base64。
 * 包装里带 KT(密钥表)/S2(seed2)/SH(shift)/B64(密文)/F(文件名)。
 * 本脚本复刻三步逆运算（逆位移 → 逆异或 → utf8），不执行服务端代码。
 *
 * 用法: node tools/verify-release-server.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// engine-server.js 是构建中间产物，被 build-release.js 的禁入名单挡在最终发布目录之外 →
// 优先读暂存目录；finish 正常清理后暂存也没有 → 退回 build-release/_lastwrap/（构建前留档）。
const SERVER = (function () {
  const stage = path.join(ROOT, 'build-release', 'Meter engine-server', 'engine-server.js');
  if (fs.existsSync(stage)) return stage;
  const lastwrap = path.join(ROOT, 'build-release', '_lastwrap', 'engine-server.js');
  if (fs.existsSync(lastwrap)) return lastwrap;
  return path.join(ROOT, 'Meter engine-server', 'engine-server.js');
})();
const SRC_SERVER = path.join(ROOT, 'engine-server', 'engine-server.js');

const wrap = fs.readFileSync(SERVER, 'utf8');
let fail = 0;
function ok(n, c, e) {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '   ' + e : ''));
  if (!c) fail++;
}

// --- 从包装里抽出运行时参数 ---
function pick(re, name) {
  const m = wrap.match(re);
  if (!m) throw new Error('包装里找不到 ' + name);
  return m[1];
}
const KT = JSON.parse(pick(/var KT=(\[[\s\S]*?\]),S2=/, 'KT'));
const S2 = parseInt(pick(/S2=(\d+)/, 'S2'), 10);
const SH = parseInt(pick(/SH=(\d+)/, 'SH'), 10);
const B64 = pick(/B=Buffer\.from\("([A-Za-z0-9+/=]+)"/, 'B');
const F = pick(/F="([^"]*)"/, 'F');

ok('包装内密钥表结构完整（a/b/posA/posB/order）', Array.isArray(KT) && KT.length === 5, 'len=' + (Array.isArray(KT) ? KT.length : 'n/a'));
ok('seed2 为 32 位无符号整数', Number.isFinite(S2) && S2 >= 0 && S2 <= 0xffffffff, 'S2=' + S2);
ok('shift 落在 0..7', SH >= 0 && SH <= 7, 'SH=' + SH);
ok('包装目标文件名为 engine-server.js', F === 'engine-server.js', 'F=' + F);

// --- 复刻包装第一步：按 order/posA/posB 拼回 32 字符密钥（与 obfuscator.splitKey 逆操作）---
function joinKey(t) {
  const a = t[0], b = t[1], posA = t[2], posB = t[3], order = t[4];
  const out = new Array(order.length);
  let ia = 0, ib = 0;
  for (let i = 0; i < order.length; i++) {
    if (order[i] === 0) out[posA[ia]] = a.charAt(ia++);
    else out[posB[ib]] = b.charAt(ib++);
  }
  return out.join('');
}
const K = joinKey(KT);
ok('包装内密钥可拼回 32 字符（' + K.length + ' 位）', K.length === 32, 'K=' + K);
ok('密钥字符集合法（A-Za-z0-9）', /^[A-Za-z0-9]{32}$/.test(K));

// --- 复刻包装第二、三步：逆位移 + 逆异或 ---
function lcgNext(s) { return (Math.imul(s, 1103515245) + 12345) >>> 0; }
function seedFromKey(keyStr) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < keyStr.length; i++) { h ^= keyStr.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function rotate(buf, shift, inverse) {
  const s = ((shift % 8) + 8) % 8;
  if (s === 0) return buf;
  const amt = inverse ? (8 - s) : s;
  if (amt === 0) return buf;
  for (let i = 0; i < buf.length; i++) buf[i] = ((buf[i] << amt) | (buf[i] >> (8 - amt))) & 0xff;
  return buf;
}
function unxor(buf, keyStr, seed2) {
  const klen = keyStr.length;
  if (!klen) throw new Error('unxor: 密钥为空');
  let s1 = seedFromKey(keyStr), s2 = seed2 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    let mix;
    if (i % 2 === 0) { s1 = lcgNext(s1); mix = (s1 >>> 24) & 0xff; }
    else { s2 = lcgNext(s2); mix = (s2 >>> 24) & 0xff; }
    buf[i] = (buf[i] ^ keyStr.charCodeAt(i % klen) ^ mix) & 0xff;
  }
  return buf;
}
let buf = Buffer.from(B64, 'base64');
rotate(buf, SH, true);
unxor(buf, K, S2);
const serverSrc = buf.toString('utf8');
ok('engine-server.js 解密成功（' + serverSrc.length + ' 字节）', serverSrc.length > 5000);

// --- 与源工程比对 ---
const src = fs.readFileSync(SRC_SERVER, 'utf8');
const marks = [
  'gb_code_close',
  'function hideCode',
  'max-height:320px',
  'codeBar',
  '#7ea9e8',
  "done:'Copied",
  'syncCloseLabel',
  'function gbUnxor',
  'function gbRotate',
  'function gbKeyTable',
  // ★ 行棋方/评估视角根治：YXBOARD 序列必须「黑先严格交替」，绝不再「同色连写」
  'SideFlag { SELF = 1, OPPO = 2, WALL = 3 }',
  'const expSide = (bn0 > wn0) ? 2 : 1;',
  'const seqSide = (moves.length % 2 === 1) ? 2 : 1;',
  'seq.push(1)',
];
let same = 0;
for (const m of marks) {
  const a = src.indexOf(m) >= 0, b = serverSrc.indexOf(m) >= 0;
  if (a === b) { same++; console.log('  PASS  同步: ' + m); }
  else console.log('  FAIL  不同步(src=' + a + ', rel=' + b + '): ' + m);
}
ok('服务端源码与源工程特征一致 (' + same + '/' + marks.length + ')', same === marks.length);

// --- 占位与等长核对 ---
ok('密钥占位 @@GB_KEY_SRC@@ 已被替换为字面量', serverSrc.indexOf('@@GB_KEY_SRC@@') < 0);
ok('发布版 GB_KEY_SRC 已是字面量数组', serverSrc.indexOf('var GB_KEY_SRC = [') >= 0);
ok('源工程仍保留 @@GB_KEY_SRC@@ 占位（构建依赖）', src.indexOf('@@GB_KEY_SRC@@') >= 0);

// --- 密文里不得出现明文特征串 / 连续密钥 ---
ok('密文不含连续 32 位密钥串', wrap.indexOf(K) < 0);
ok('密文不含明文关键词（gbUnxor）', B64.indexOf(Buffer.from('function gbUnxor').toString('base64').replace(/=+$/, '')) < 0);

// --- 等长 + 逐字节一致（最强核对）---
// 发布版 = 源工程把 `var GB_KEY_SRC = null;   // @@GB_KEY_SRC@@` 换成密钥字面量后的结果。
// 注意：splitKey 内含随机打乱，无法由密钥重算出同一个字面量，
// 因此从「解密结果」里把注入的字面量抽出来，逐段核对。
const PL = 'var GB_KEY_SRC = null;   // @@GB_KEY_SRC@@';
const pi = src.indexOf(PL);
ok('源工程含密钥占位整行', pi >= 0);
// ★ 2026-09-19：engine-server.js 现在是 CRLF（曾为 LF）→ 换行符必须无关，别写死 \n
const litMatch = serverSrc.match(/var GB_KEY_SRC = (\[[\s\S]*?\]);\r?\n/);
ok('解密结果里 GB_KEY_SRC 已替换为字面量数组', !!litMatch);
const innerKT = litMatch ? JSON.parse(litMatch[1]) : null;
ok('注入的密钥表能拼回 32 字符且与包装一致', innerKT ? joinKey(innerKT) === K : false,
  innerKT ? joinKey(innerKT) : 'n/a');
// 除去注入差异后应逐字节一致（按实际命中的换行还原，CRLF/LF 都对得上）
const eol = litMatch ? (litMatch[0].endsWith('\r\n') ? '\r\n' : '\n') : '\n';
const rest = litMatch
  ? serverSrc.slice(0, litMatch.index) + PL + eol + serverSrc.slice(litMatch.index + litMatch[0].length)
  : '';
ok('解密结果（还原占位后）与源工程逐字节一致', !!litMatch && rest === src,
  litMatch ? ('len ' + rest.length + ' vs ' + src.length) : 'n/a');
ok('源工程长度 + 注入字面量 == 解密长度（' + src.length + ' + ' + (litMatch ? litMatch[0].length - PL.length - eol.length : 0) + '）',
  !!litMatch && serverSrc.length === src.length + (litMatch[0].length - PL.length - eol.length));

console.log('\n--- engine-server.js 核对: ' + (fail === 0 ? 'OK \u2713' : fail + ' \u9879\u5931\u8d25 \u2717') + ' ---');
process.exit(fail ? 1 : 0);
