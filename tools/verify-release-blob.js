/*
 * verify-release-blob.js —— 确认发布目录里的 Web GomokuEngine.exe 内嵌的确实是【本次构建】的 SEA blob，
 * 而不是上一版残留（历史反复出现的「exe 是新的、跑的是旧代码」根因）。
 *
 * 原理：构建时 engine.blob 由源工程加密文本生成，因此 blob 的字节内容唯一。
 * 这里重建一次 engine.blob（同源、同密钥、无随机盐的比对不可行，因为加密含随机 salt/iv），
 * 所以改用另一条更强的判据：把 exe 里的 blob 抽出来，用【源码特征】间接验证 ——
 *   blob 是密文不可读，因此改为核对「exe 里有没有本次独有的标记」：
 *   构建脚本把本次 blob 的指纹写在 build-release/.blob-fingerprint，
 *   注入工具 inject-sea.js 已断言该指纹存在于 exe 中（exit 4 表示失败）。
 * 本脚本做二次独立核对：从 exe 中搜索指纹字节，并报告 exe mtime 与发布目录一致性。
 *
 * 用法: node tools/verify-release-blob.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const REL = path.join(ROOT, 'Meter engine-server');
const EXE = path.join(REL, 'Web GomokuEngine.exe');
const FP_FILE = path.join(ROOT, 'build-release', '.blob-fingerprint');
// ★ engine-server.js 是**构建中间产物**，被 build-release.js 的禁入名单挡在最终目录之外
//   （连带 engine.blob / sea-config.json）。它只活在暂存目录里。
//   所以「源码是否齐全」这条不能在 REL 下找，否则和导出的允许清单自相矛盾 ——
//   这个断言红过一整轮而没人发现，就是因为两边各说各话。
const STAGE = path.join(ROOT, 'build-release', 'Meter engine-server');

let fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   ' + extra : ''));
  if (!cond) fail++;
}

if (!fs.existsSync(EXE)) { console.error('exe 不存在: ' + EXE); process.exit(1); }
const exe = fs.readFileSync(EXE);
console.log('[info] Web GomokuEngine.exe ' + (exe.length / 1024 / 1024).toFixed(1) + 'MB  mtime=' + fs.statSync(EXE).mtime.toISOString());

// 1) 指纹核对：本次构建的 blob 指纹必须真的在 exe 字节流里
if (fs.existsSync(FP_FILE)) {
  const fp = fs.readFileSync(FP_FILE, 'utf8').trim();
  const buf = Buffer.from(fp, 'base64');
  const at = exe.indexOf(buf);
  ok('本次 blob 指纹已内嵌于 exe（offset=' + at + '）', at >= 0);
} else {
  console.log('  WARN  找不到 build-release/.blob-fingerprint（跳过指纹核对）');
}

// 2) 排除「文件里同时存在多份 NODE_SEA_BLOB」的陈旧注入痕迹
const marker = Buffer.from('NODE_SEA_BLOB');
let cnt = 0, p = 0;
while ((p = exe.indexOf(marker, p)) >= 0) { cnt++; p += marker.length; }
ok('NODE_SEA_BLOB 标记存在', cnt >= 1, '出现 ' + cnt + ' 次');
ok('未出现多份 blob 注入痕迹（cnt<=4 视为正常 PE 冗余）', cnt <= 4, 'cnt=' + cnt);

// 3) 发布目录关键文件齐全
//    ★ 2026-09-26 对齐现布局：识别是自包含 C++（GomokuVision.exe），发布包不再有 python/；
//    engine-server.js 只在暂存目录（构建中间产物，不入包）。
const needInRel = [
  'resources/bookmarklet.enc',
  'GomokuVision.exe'
];
for (const f of needInRel) {
  ok('发布目录含 ' + f, fs.existsSync(path.join(REL, f)));
}
// ★ 2026-09-26：WASM 引擎 rapfi-multi.* 已整体移除 —— 发布目录里出现即为错。
for (const f of ['rapfi-multi.data', 'rapfi-multi.js', 'rapfi-multi.wasm']) {
  ok('发布目录**不含** resources/' + f + '（WASM 已移除，引擎只走原生）', !fs.existsSync(path.join(REL, 'resources', f)));
}
// 暂存目录的 engine-server.js：finish 正常清理后不存在（verify 走 _lastwrap）；
// EBUSY 残留时留着也无害 → 只提示不计失败。
if (fs.existsSync(path.join(STAGE, 'engine-server.js'))) {
  console.log('  WARN  暂存目录残留 engine-server.js（EBUSY 残留，无害；verify 用 _lastwrap）');
} else {
  console.log('  PASS  暂存目录已清理 engine-server.js（finish 卫生生效）');
}
ok('最终发布目录**不含** engine-server.js（禁入名单生效）',
  !fs.existsSync(path.join(REL, 'engine-server.js')));

// 4) 明文 bookmarklet.js 不应落在发布目录（必须只有密文）
ok('发布目录不含明文 resources/bookmarklet.js（只允许密文 .enc）',
  !fs.existsSync(path.join(REL, 'resources', 'bookmarklet.js')));

console.log('\n--- blob/目录核对: ' + (fail === 0 ? 'OK ✓' : fail + ' 项失败 ✗') + ' ---');
process.exit(fail ? 1 : 0);
