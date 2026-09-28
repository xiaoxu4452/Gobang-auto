/*
 * test-obfuscator.js —— 混淆方案正确性自测
 * 关键点：加解密必须【严格互逆】，包括各种边界（空串、二进制、中文、超长、shift=0）。
 * 任何一处不互逆 → 发布版面板会解出乱码/报错，且极难排查，所以这里必须全绿。
 */
'use strict';
const O = require('./obfuscator.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
}

console.log('=== 1. 密钥形态 ===');
const k = O.randomKey();
ok('32 字符', k.length === 32, k.length + '');
ok('仅含 A-Za-z0-9', /^[A-Za-z0-9]+$/.test(k), k);
ok('两次 randomKey 不同', O.randomKey() !== O.randomKey());
ok('字母表长度 62', O.KEY_ALPHABET.length === 62);

console.log('');
console.log('=== 2. 往返一致性（多种输入 × 固定密钥）===');
const KEY = 'Ab3xY9Qw7Zt2Lm5Kp8Rc4Vd6Ns1Hg0Uj';   // 固定 32 字符密钥
ok('固定密钥长度 32', KEY.length === 32);
const cases = [
  ['普通 ASCII', 'var a = 1; console.log("hello");'],
  ['中文（UTF-8 多字节）', '前方高能：评估值 = +350，五子连珠！'],
  ['emoji（4 字节）', 'win 🎉 黑子胜 🖤 白子胜 🤍'],
  ['单字符', 'x'],
  ['空串', ''],
  ['纯换行', '\n\n\r\n'],
  ['含 null 字节', 'a\u0000b\u0000c'],
  ['长文本 200KB', 'ABCDEFGHIJ'.repeat(20000)],
  ['源码片段（含引号/反斜杠）', 'var s="a\\"b\\\'c"; // 注释\\n'],
];
for (const [label, text] of cases) {
  const enc = O.obfuscate(text, KEY);
  const dec = O.deobfuscate(enc.b64, enc.seed2, enc.shift, KEY);
  ok('往返: ' + label + ' (' + Buffer.byteLength(text, 'utf8') + 'B)', dec === text,
    dec === text ? '' : '解出长度 ' + dec.length + ' 期望 ' + text.length);
}

console.log('');
console.log('=== 3. 随机密钥往返 200 次 ===');
let allOk = true, badSample = '';
for (let i = 0; i < 200; i++) {
  const text = 'round#' + i + ' 中文🎯 ' + Math.random().toString(36);
  const enc = O.obfuscate(text);
  const dec = O.deobfuscate(enc.b64, enc.seed2, enc.shift, enc.key);
  if (dec !== text) { allOk = false; badSample = 'i=' + i; break; }
}
ok('200 次随机密钥全部往返成功', allOk, badSample);

console.log('');
console.log('=== 4. shift 覆盖 0..7 全部可逆 ===');
let shiftOk = true, shiftBad = '';
for (let s = 0; s < 8; s++) {
  const text = 'shift-' + s + ' 中文测试';
  // 直接构造 shift=s 的密文：手工走一遍加密流程
  const buf = Buffer.from(text, 'utf8');
  const seed2 = 12345678;
  O.xorshiftBytes(buf, KEY, seed2, 'enc');
  O.shiftBytes(buf, s, false);
  const b64 = buf.toString('base64');
  const dec = O.deobfuscate(b64, seed2, s, KEY);
  if (dec !== text) { shiftOk = false; shiftBad = 's=' + s + ' got=' + dec; break; }
}
ok('shift 0..7 全部可逆', shiftOk, shiftBad);

console.log('');
console.log('=== 5. 密文与明文不可区分（基本统计）===');
const plain = 'var S={history:[],rawEval:""};// 评估曲线';
const encPlain = O.obfuscate(plain, KEY);
ok('密文中不含明文关键词', encPlain.b64.indexOf('history') < 0 && encPlain.b64.indexOf('评估') < 0);
ok('密文中不含密钥明文', encPlain.b64.indexOf(KEY.slice(0, 8)) < 0);
ok('base64 只含合法字符', /^[A-Za-z0-9+/=]*$/.test(encPlain.b64));
// 密文随 seed2 / shift 变化（同一明文同密钥两次加密结果应不同）
const e1 = O.obfuscate('same text', KEY), e2 = O.obfuscate('same text', KEY);
ok('每次加密结果不同（seed2 随机）', e1.b64 !== e2.b64 || e1.seed2 !== e2.seed2);

console.log('');
console.log('=== 6. 错误的密钥/种子必须解不出原文（防误用）===');
const good = O.obfuscate('绝密内容 SECRET-12345', KEY);
const wrongKey = 'ZZ3xY9Qw7Zt2Lm5Kp8Rc4Vd6Ns1Hg0Uj';
const dWrongKey = O.deobfuscate(good.b64, good.seed2, good.shift, wrongKey);
ok('换密钥 → 解不出原文', dWrongKey !== '绝密内容 SECRET-12345');
const dWrongSeed = O.deobfuscate(good.b64, (good.seed2 ^ 1) >>> 0, good.shift, KEY);
ok('换 seed2 → 解不出原文', dWrongSeed !== '绝密内容 SECRET-12345');
const dWrongShift = O.deobfuscate(good.b64, good.seed2, (good.shift + 1) % 8, KEY);
ok('换 shift → 解不出原文', dWrongShift !== '绝密内容 SECRET-12345');

console.log('');
console.log('=== 7. 密钥拆分/还原 ===');
const pack = O.splitKey(KEY);
ok('拆成两段', typeof pack.a === 'string' && typeof pack.b === 'string');
ok('两段拼不回连续密钥串（打乱过）', (pack.a + pack.b) !== KEY);
ok('还原 == 原密钥', O.joinKey(pack) === KEY);
ok('段长合理（a+b 共 32 字符）', pack.a.length + pack.b.length === 32, pack.a.length + '+' + pack.b.length);
ok('order 长度 32', pack.order.length === 32);
// 多轮随机密钥拆分还原
let splitOk = true;
for (let i = 0; i < 100; i++) {
  const rk = O.randomKey();
  if (O.joinKey(O.splitKey(rk)) !== rk) { splitOk = false; break; }
}
ok('100 次随机密钥拆分 → 还原全部正确', splitOk);

console.log('');
console.log('=== 8. LCG 与 Math.imul（跨端一致性关键）===');
ok('lcgNext 返回 32 位无符号', O.lcgNext(0) === 12345 && O.lcgNext(0) >>> 0 === O.lcgNext(0));
ok('lcgByte 取高 8 位', O.lcgByte(0xff000000) === 0xff, O.lcgByte(0xff000000) + '');
// 与 Math.imul 之外的写法对比：确认没有浮点漂移（大状态值仍精确）
let s = 0xdeadbeef;
let drifted = false;
for (let i = 0; i < 100000; i++) {
  s = O.lcgNext(s);
  if (!Number.isInteger(s) || s < 0 || s > 0xffffffff) { drifted = true; break; }
}
ok('100k 次 LCG 递推无浮点漂移', !drifted);

console.log('');
console.log('=== 9. seedFromKey 稳定性 ===');
ok('同密钥同种子', O.seedFromKey(KEY) === O.seedFromKey(KEY));
ok('不同密钥不同种子', O.seedFromKey(KEY) !== O.seedFromKey(wrongKey));
ok('种子为 32 位无符号', O.seedFromKey(KEY) >>> 0 === O.seedFromKey(KEY));

console.log('');
console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
