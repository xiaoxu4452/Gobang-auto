// 第二批：多行 log 尾部 + throw 错误消息里的中文 → 英文
const fs = require('fs');
const P = 'C:/Users/harve/Desktop/Gobang auto/engine-server/engine-server.js';
let s = fs.readFileSync(P, 'utf8');
const R = [
  ["if (!klen) throw new Error('gbUnxor: 密钥为空');",
   "if (!klen) throw new Error('gbUnxor: empty key');"],
  ["if (!key || key.length !== 32) throw new Error('密钥不可用（长度 ' + (key ? key.length : 0) + '）');",
   "if (!key || key.length !== 32) throw new Error('bad key (length ' + (key ? key.length : 0) + ')');"],
  ["if (j.magic !== 'GBOBF1') throw new Error('未知密文格式: ' + j.magic);",
   "if (j.magic !== 'GBOBF1') throw new Error('unknown ciphertext format: ' + j.magic);"],
  ["        '[!] 端口 ' + PORT + ' 已被**其他程序**占用（HTTP ' + (pre.code || '无响应') + '）。',",
   "        '[!] port ' + PORT + ' is occupied by another program (HTTP ' + (pre.code || 'no response') + ').',"],
  ["        '    请关闭占用该端口的程序；或用 GB_PORT 环境变量换一个端口再启动本程序。'",
   "        '    close the program holding the port, or set the GB_PORT env var and restart.'"],
  ["          '[!] 端口 ' + PORT + ' 已被其他程序占用（HTTP ' + (pre.code || '无响应') + '）。',",
   "          '[!] port ' + PORT + ' is occupied by another program (HTTP ' + (pre.code || 'no response') + ').',"],
  ["          '    请关闭占用该端口的程序；或用 GB_PORT 环境变量换一个端口再启动本程序。'",
   "          '    close the program holding the port, or set the GB_PORT env var and restart.'"],
  ["        + '  → main ' + mainT + '线程/' + fmtH(mainH) + ' + sub ' + subT + '线程/' + fmtH(subH) + ' + fwd ' + fwdT + '线程/' + fmtH(fwdH)",
   "        + '  -> main ' + mainT + 'thr/' + fmtH(mainH) + ' + sub ' + subT + 'thr/' + fmtH(subH) + ' + fwd ' + fwdT + 'thr/' + fmtH(fwdH)"],
  ["        + '  (内存 1/3 取，封顶 4GB；GB_THREADS / GB_HASH_MB 可覆盖)\\n');",
   "        + '  (1/3 of RAM capped at 4GB; GB_THREADS / GB_HASH_MB to override)\\n');"],
];
let bad = 0;
for (const [o, n] of R) {
  const c = s.split(o).length - 1;
  if (c !== 1) { console.log('!! match count ' + c + ' for: ' + o.slice(0, 50)); bad++; continue; }
  s = s.replace(o, n);
}
if (bad) { console.log('ABORT: ' + bad + ' unmatched'); process.exit(1); }
fs.writeFileSync(P, s);
console.log('OK batch2: ' + R.length);
// 终检：所有以引号结尾/拼接的中文行（排除纯注释、HTML 面板文案区）
const lines = s.split('\n');
const sus = [];
lines.forEach((l, i) => {
  if (!/[\u4e00-\u9fff]/.test(l)) return;
  const t = l.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
  // 运行时字符串嫌疑：包含中文且带引号包裹的段（粗筛人工过目）
  if (/'[^']*[\u4e00-\u9fff][^']*'/.test(l)) sus.push((i + 1) + ': ' + t.slice(0, 110));
});
console.log('remaining quoted-Han lines: ' + sus.length);
sus.forEach(x => console.log('  ' + x));
