/*
 * test-obf-roundtrip.js —— 三端一致性测试（这是整套方案最容易出错的地方）
 *
 * 同一个算法必须在【三处独立实现】里逐位一致，否则发布版会解出乱码：
 *   ① 构建端：tools/obfuscator.js
 *   ② 运行时包装（engine-server.js 的混淆包装，SEA 里执行）
 *   ③ 服务端内存还原（engine-server.js 的 gbUnxor/gbRotate，还原面板密文）
 *
 * 本脚本：
 *   A. 用 obfuscator 混淆一段文本 → 生成真实包装 → 在子进程里 eval 包装，
 *      让「被执行的源码」把结果写进文件 → 核对等于原文（验证 ①②一致）
 *   B. 从源工程的 engine-server.js 里【抽取真实函数】gbUnxor/gbRotate，
 *      用它们还原面板密文 → 核对等于原文（验证 ①③一致）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const O = require('./obfuscator.js');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(n, c, e) {
  if (c) { pass++; console.log('PASS ' + n + (e ? '  ' + e : '')); }
  else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('未闭合 ' + name);
}

console.log('=== A. 包装（运行时自解混淆）与构建端一致 ===');
// 被测文本故意包含中文、引号、模板串、反斜杠——这些最容易在字符串转义上出错
const SECRET = [
  'var S = { rawEval: "+M17", note: "中文测试 🎯" };',
  'console.log("quote:\\"  backslash:\\\\  slash:/");',
  'var tpl = `tick ${1+1}`;',
  '__RESULT__ = "OBF_ROUNDTRIP_OK";'
].join('\n');

const KEY = 'Zq7Wm2Xv9Lk4Bd6Np1Tg8Rc3Ys5Hj0Fa';
ok('固定密钥 32 字符', KEY.length === 32);
const enc = O.obfuscate(SECRET, KEY);
const wrapper = O.buildWrapper(enc, 'engine-server.js');

// 把包装写盘并执行：包装最后会 vm.runInThisContext(还原出的源码)
// 为便于取回结果，我们在还原出的源码里已埋 __RESULT__ 赋值；
// 但包装不导出变量，因此改为：让被还原的源码把结果写文件。
const probe = SECRET.replace('__RESULT__ = "OBF_ROUNDTRIP_OK";',
  'require("fs").writeFileSync(' + JSON.stringify(path.join(os.tmpdir(), 'obf-probe.txt')) + ', "OBF_ROUNDTRIP_OK");');
const enc2 = O.obfuscate(probe, KEY);
const wrapper2 = O.buildWrapper(enc2, 'engine-server.js');
const wf = path.join(os.tmpdir(), 'obf-wrapper-test.js');
const probeOut = path.join(os.tmpdir(), 'obf-probe.txt');
try { fs.rmSync(probeOut, { force: true }); } catch (e) {}
fs.writeFileSync(wf, wrapper2, 'utf8');

const r = spawnSync(process.execPath, [wf], { encoding: 'utf8', cwd: ROOT });
ok('包装脚本可执行（exit 0）', r.status === 0, 'exit=' + r.status + ' ' + (r.stderr || '').split('\n')[0]);
let probeTxt = '';
try { probeTxt = fs.readFileSync(probeOut, 'utf8'); } catch (e) {}
ok('包装还原出的源码正确执行（写回探针值）', probeTxt === 'OBF_ROUNDTRIP_OK', '读到: ' + JSON.stringify(probeTxt));
// 顺带确认包装里没有明文密钥串
ok('包装内不含连续 32 字符密钥串', wrapper.indexOf(KEY) < 0);
ok('包装内不含明文源码片段', wrapper.indexOf('rawEval') < 0 && wrapper.indexOf('中文测试') < 0);

// 环境变量覆盖密钥路径也要能解开（同一 KEY，显式传 env 不改变结果）
const r2 = spawnSync(process.execPath, [wf], { encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { GB_MASTER_KEY: KEY }) });
try { fs.rmSync(probeOut, { force: true }); } catch (e) {}
spawnSync(process.execPath, [wf], { encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { GB_MASTER_KEY: KEY }) });
let probeTxt2 = '';
try { probeTxt2 = fs.readFileSync(probeOut, 'utf8'); } catch (e) {}
ok('GB_MASTER_KEY 覆盖为同一密钥时仍能解开', r2.status === 0 && probeTxt2 === 'OBF_ROUNDTRIP_OK', 'exit=' + r2.status);
// 换错误密钥必须解不出（不能静默产出垃圾源码）
try { fs.rmSync(probeOut, { force: true }); } catch (e) {}
const r3 = spawnSync(process.execPath, [wf], { encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { GB_MASTER_KEY: 'Qq7Wm2Xv9Lk4Bd6Np1Tg8Rc3Ys5Hj0Fz' }) });
let probeTxt3 = '';
try { probeTxt3 = fs.readFileSync(probeOut, 'utf8'); } catch (e) {}
ok('错误密钥 → 不会产出正确探针值', probeTxt3 !== 'OBF_ROUNDTRIP_OK', 'exit=' + r3.status);

try { fs.rmSync(wf, { force: true }); } catch (e) {}
try { fs.rmSync(probeOut, { force: true }); } catch (e) {}

console.log('');
console.log('=== B. 服务端内存还原（engine-server.js 真实函数）与构建端一致 ===');
const serverSrc = fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8');
ok('engine-server.js 已改为纯 JS 解混淆（无 crypto 解密）',
  serverSrc.indexOf('createDecipheriv') < 0);
ok('engine-server.js 有 gbUnxor', serverSrc.indexOf('function gbUnxor(') >= 0);
ok('engine-server.js 有 gbRotate', serverSrc.indexOf('function gbRotate(') >= 0);
ok('engine-server.js 有 gbSeedFromKey', serverSrc.indexOf('function gbSeedFromKey(') >= 0);
ok('engine-server.js 有 gbKeyTable', serverSrc.indexOf('function gbKeyTable(') >= 0);
ok('密文 magic 已改为 GBOBF1', serverSrc.indexOf("'GBOBF1'") >= 0);

// 抽取真实函数，塞进沙箱
// 注意：gbUnxor 内部会 `Buffer.from(keyStr,'utf8')` 取密钥字节 ——
// 抽取的单函数在 new Function 里拿不到外层作用域的 Buffer，必须显式作为参数传入。
const fns = ['gbLcgNext', 'gbSeedFromKey', 'gbUnxor', 'gbRotate'].map(n => grab(serverSrc, n)).join('\n');
const sandbox = {};
new Function('exports', 'Buffer', fns + '\nexports.gbUnxor=gbUnxor;exports.gbRotate=gbRotate;')(sandbox, Buffer);
const { gbUnxor, gbRotate } = sandbox;

// 复刻服务端 loadBookmarkletSource 的还原步骤，跑真实面板文本
const bmSrc = fs.readFileSync(path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');
const eBm = O.obfuscate(bmSrc, KEY);
const buf = Buffer.from(eBm.b64, 'base64');
gbRotate(buf, eBm.shift, true);
gbUnxor(buf, KEY, eBm.seed2);
const restored = buf.toString('utf8');
ok('服务端还原面板密文 == 源工程原文（' + bmSrc.length + ' 字符）', restored === bmSrc,
  restored === bmSrc ? '' : '还原长度 ' + restored.length);

// 200 轮随机，覆盖各种 shift/seed2
let allOk = true;
for (let i = 0; i < 200; i++) {
  const text = 'panel#' + i + ' 中文🎯 ' + Math.random().toString(36);
  const e = O.obfuscate(text);                       // 随机密钥
  const b = Buffer.from(e.b64, 'base64');
  gbRotate(b, e.shift, true);
  gbUnxor(b, e.key, e.seed2);
  if (b.toString('utf8') !== text) { allOk = false; break; }
}
ok('200 轮随机密钥 × 服务端真实函数还原全部正确', allOk);

console.log('');
console.log('=== C. 密钥表拼回（与包装/服务端两套实现一致）===');
const pack = O.splitKey(KEY);
ok('obfuscator.joinKey == 原密钥', O.joinKey(pack) === KEY);
// 复刻 engine-server 的 gbKeyTable 逻辑
function serverKeyTable(t) {
  const [a, b, posA, posB, order] = t;
  const out = new Array(order.length); let ia = 0, ib = 0;
  for (let i = 0; i < order.length; i++) {
    if (order[i] === 0) out[posA[ia]] = a.charAt(ia++);
    else out[posB[ib]] = b.charAt(ib++);
  }
  return out.join('');
}
ok('服务端 gbKeyTable 逻辑 == obfuscator.joinKey',
  serverKeyTable([pack.a, pack.b, pack.posA, pack.posB, pack.order]) === KEY);
// 复刻包装里的拼回逻辑
function wrapperKeyTable(t) {
  const a = t[0], b = t[1], pA = t[2], pB = t[3], order = t[4];
  const O2 = new Array(order.length); let ia = 0, ib = 0;
  for (let i = 0; i < order.length; i++) {
    if (order[i] === 0) { O2[pA[ia]] = a.charAt(ia); ia++; }
    else { O2[pB[ib]] = b.charAt(ib); ib++; }
  }
  return O2.join('');
}
ok('包装内拼回逻辑 == obfuscator.joinKey',
  wrapperKeyTable([pack.a, pack.b, pack.posA, pack.posB, pack.order]) === KEY);

console.log('');
console.log('=== D. 摘要指纹（发布版一致性核对用）===');
// 服务端还原出的文本长度应与源工程一致（发布版同步核对会用到）
ok('还原文本长度 == 源工程长度', restored.length === bmSrc.length,
  restored.length + ' vs ' + bmSrc.length);

console.log('');
console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail ? 1 : 0);
