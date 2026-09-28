/*
 * verify-release-enc.js —— 直接还原发布目录里的 resources/bookmarklet.enc，
 * 核对里面就是源工程最新代码（不经过 HTTP，排除服务端缓存/陈旧文件的干扰）。
 *
 * 新混淆方案格式：{ magic:'GBOBF1', seed2, shift, data }
 * 还原 = base64 解码 → 右移 shift → 双层异或（周期密钥 + 双种子交错）→ UTF-8
 *
 * 用法: node tools/verify-release-enc.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require('./obfuscator.js');

const ROOT = path.resolve(__dirname, '..');
const encPath = path.join(ROOT, 'Meter engine-server', 'resources', 'bookmarklet.enc');
const serverPath = (function () {
  // engine-server.js 是构建中间产物，被 build-release.js 的禁入名单挡在最终目录之外 →
  // 优先读留档（build-release.js 删暂存前会抄一份到 _lastwrap/）；
  // 老布局（暂存还在时）再读暂存；都没有才退回发布目录。
  const lastwrap = path.join(ROOT, 'build-release', '_lastwrap', 'engine-server.js');
  const stage = path.join(ROOT, 'build-release', 'Meter engine-server', 'engine-server.js');
  return require('fs').existsSync(lastwrap) ? lastwrap
       : require('fs').existsSync(stage) ? stage
       : path.join(ROOT, 'Meter engine-server', 'engine-server.js');
})();
const srcPath = path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js');

// 1) 从发布版 engine-server.js 的包装里取出密钥表，拼回主密钥
//    （完全模拟发布版自己的运行路径，不依赖 tools 里的任何密钥文件）
const wrap = fs.readFileSync(serverPath, 'utf8');
let KEY = '';
try {
  const m = wrap.match(/var KT=(\[[\s\S]*?\]),S2=/);
  if (!m) throw new Error('包装里找不到密钥表 KT');
  const KT = JSON.parse(m[1]);
  const [a, b, pA, pB, order] = KT;
  const out = new Array(order.length);
  let ia = 0, ib = 0;
  for (let i = 0; i < order.length; i++) {
    if (order[i] === 0) out[pA[ia]] = a.charAt(ia++);
    else out[pB[ib]] = b.charAt(ib++);
  }
  KEY = out.join('');
} catch (e) {
  console.error('FAIL 无法从发布版包装里拼回密钥: ' + e.message);
  process.exit(1);
}
let fail = 0;
function ok(n, c, e) {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '   ' + e : ''));
  if (!c) fail++;
}
console.log('[info] 从发布版包装拼回主密钥：长度 ' + KEY.length + '，字符集 ' +
  (/^[A-Za-z0-9]{32}$/.test(KEY) ? 'A-Za-z0-9 ✓' : '异常 ✗'));
ok('发布版主密钥为 32 字符', KEY.length === 32, KEY.length + '');
ok('发布版主密钥仅含 A-Za-z0-9', /^[A-Za-z0-9]{32}$/.test(KEY));

// 2) 读密文并还原
const j = JSON.parse(fs.readFileSync(encPath, 'utf8'));
ok('密文 magic 为 GBOBF1', j.magic === 'GBOBF1', j.magic);
ok('密文带 seed2 / shift / data', typeof j.seed2 === 'number' &&
  typeof j.shift === 'number' && typeof j.data === 'string');
ok('shift 在 0..7', j.shift >= 0 && j.shift <= 7, j.shift + '');
const plain = O.deobfuscate(j.data, j.seed2, j.shift, KEY);
console.log('[ok] bookmarklet.enc 还原成功，' + plain.length + ' 字符');
ok('密文本体不含明文关键词（静态不可读）', j.data.indexOf('history') < 0);

// 3) 与源工程逐特征比对
const src = fs.readFileSync(srcPath, 'utf8');
const marks = [
  'function evalToMine(evStr, myIsSideToMove)',
  'function pushHistPoint(ply, value)',
  'var CHART_FIT = 15;',
  'var viewW = (csc && csc.clientWidth) ? csc.clientWidth : 0;',
  'var denom = (n <= CHART_FIT) ? Math.max(1, n - 1) : (CHART_FIT - 1);',
  'matePly: 0, valid: false',
  'myEval: S.myEval',
  'if (pv != null) pushHistPoint(plyNow, pv);',
  'if (!ourTurn) {',                                     // 轮对手守卫（对所有模式生效）
  'if (S.matePly === 1)',
  // ★ 本轮（2026-09-15 晚）四项修复的特征
  '五连即停算（用户明确要求）',                            // 盘面五连前置闸
  'var _myFive = maxLineLen(board, _mC) >= 5;',
  'var myColor0 = myColorCode();',                        // 颜色一律走唯一事实来源
  'var oppColor0 = oppColorCode();',
  'if (fresh !== false && !haltForNewGame) {',            // 停止评估 = 曲线封口
  'function stabilizeBest(best, cands, fpKey, scoreOf) {', // 最佳落点稳定器
  'setInterval(runOppEval, 700)',                         // 对手评估提速
  'function kickOppEval() {',
  // ★ 对手预测圈改为「局面的纯函数」（修「3/4 只出青、1/4 青绿同出」的不确定观感）
  'function boardHasFive(b) { return maxLineLen(b, 1) >= 5 || maxLineLen(b, 2) >= 5; }',
  'function computeOppRings(reqBoard, myC, oppC, cands, rule) {',
  'if (boardHasFive(reqBoard)) return [];',                // 终局 → 0 圈
  'return pts.slice(0, 2).map(',                           // 必防点最多 2（闭四1/活四2）
  'lastOppRings = null; lastOppKey = null;',               // 清层连带作废（防同帧重投影复活）
  '!boardHasFive(board)',                                  // 重投影的终局闸
  'boardHasFive(lastGoodBoard || board)',                  // 回包后重判终局（竞态闸）
  'if (haltForNewGame) return;',
  // ★ 本轮新增：终局权威闸（我方落第 5 子后彻底停算）+ 持久化终局锁
  '【★ 终局权威闸（本轮新增 · 最高优先级）★】',              // 盘面五连 → 轮次判断前短路
  'var haltReason = \'\';',
  'function setGameOverLock(reason) {',
  'function clearGameOverLock() {',
  'function gameOverLocked() {',
  'if (n === 0 && !gameOverLocked()) {',
  'halt: haltForNewGame, hr: haltReason',
  "haltReason = ''; clearGameOverLock();  // 新局",
  "if (!already) { haltForNewGame = false; haltReason = ''; clearGameOverLock(); }",
  // ★ 本轮新增：开局行棋方权威（修「新开局白子错乱下子」）
  'function openingSideToMove(board) {',
  'function isOurTurnOn(board, stm) {',
  'var stmColor = openingSideToMove(board);',
  'var ourTurn = ((stmColor === 1) === ourIsBlack);',
  'openingSideToMove mismatch: bCnt='
];
for (const m of marks) {
  const a = src.indexOf(m) >= 0, b = plain.indexOf(m) >= 0;
  ok('同步: ' + m, a === b);
}
// 旧实现必须彻底不存在
const gone = [
  ['旧固定间距 var MIN_PLIES = 18', 'var MIN_PLIES = 18'],
  ['旧固定间距 var pointW = 11', 'var pointW = 11'],
  ['旧 isNaN 跳过式入点', 'if (!isNaN(numEv) &&'],
  ['旧评估栏读 rawEval', 'var dispEv = (typeof S.rawEval'],
  ['旧 11px 点距公式 px(ply)', 'var px = function (ply) { return padL + ply * pointW; };'],
  // ★ 旧守卫（仅自动模式生效）绝不能作为【代码】残留（注释里提到历史写法是允许的）
  ['旧的「仅自动模式」轮对手守卫（代码）', 'if (S.autoPlay && !ourTurn) {'],
  // ★ 本轮被替换掉的旧参数/旧写法
  ['旧曲线阈值 var CHART_FIT = 30', 'var CHART_FIT = 30;'],
  ['旧对手周期 setInterval(runOppEval, 1200)', 'setInterval(runOppEval, 1200)'],
  ['旧的「前 2 名候选」硬编码循环', 'd.candidates.length && rings.length < 2; ci++'],
  ['旧的 ourIsBlack 反推我方颜色码（主路径）', 'var myColor0 = ourIsBlack === true ? 1 : 2;'],
  // ★ 本轮被「computeOppRings 纯函数」取代的三个内联分支 —— 它们正是圈数不确定的来源
  ['旧内联 needDefend 枚举', 'var needDefend = [];'],
  ['旧 uniqueMust 分支', 'var uniqueMust = ('],
  ['旧 maxRings 变量', 'var maxRings = uniqueMust'],
  // ★ 本轮被「开局行棋方权威」取代的旧代数式轮次（空盘时 0===0 → 判轮白 → 白子错乱下子）
  ['旧轮次代数式 var toMoveIsBlack = (bCnt === wCnt);', 'var toMoveIsBlack = (bCnt === wCnt);'],
  ['旧指纹轮次代数式 var fpToMoveIsBlack = (fpB === fpW);', 'var fpToMoveIsBlack = (fpB === fpW);'],
  ['旧 ourTurn 代数式 var ourTurn = (ourIsBlack === toMoveIsBlack);', 'var ourTurn = (ourIsBlack === toMoveIsBlack);']
];
for (const [label, m] of gone) ok('已清除: ' + label, plain.indexOf(m) < 0);
// 旧 AES 容器字段不得残留
ok('已清除: 旧 AES 容器字段 salt/iv/comp', !('salt' in j) && !('iv' in j) && !('comp' in j));
ok('包装里不含连续 32 字符密钥串', wrap.indexOf(KEY) < 0);

// 4) 与源工程整体等长 + 逐字节一致（最强判据）
ok('还原文本与源工程完全等长（' + src.length + ' 字符）', plain.length === src.length,
  plain.length + ' vs ' + src.length);
ok('还原文本与源工程逐字节一致', plain === src);

console.log('\n--- enc 内容核对: ' + (fail === 0 ? 'OK ✓ 发布版就是最新代码' : fail + ' 项失败 ✗') + ' ---');
process.exit(fail ? 1 : 0);
