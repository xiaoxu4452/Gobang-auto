// 一次性补丁驱动：按行号区间(1-based,含)自底向上替换 bookmarklet.js
const fs = require('fs');
const os = require('os');
const base = 'c:/Users/harve/Desktop/Gobang auto/engine-server/resources/';
const target = base + 'bookmarklet.js';
const raw = fs.readFileSync(target, 'utf8');
const le = raw.includes('\r\n') ? '\r\n' : '\n';
let lines = raw.split(/\r?\n/);
// 丢弃可能因换行符产生的空尾巴（split 不会产生，除非以分割符结尾）
function load(fn) {
  let t = fs.readFileSync(base + fn, 'utf8');
  t = t.replace(/^\uFEFF/, '');
  if (t.endsWith('\r\n')) t = t.slice(0, -2);
  else if (t.endsWith('\n')) t = t.slice(0, -1);
  return t.split(/\r?\n/);
}
function rep(a, b, fn) {           // a,b: 1-based inclusive
  const ins = load(fn);
  lines.splice(a - 1, b - a + 1, ...ins);
}
// 自底向上替换，保证高层行号不被下层替换影响
rep(1995, 2049, '__newE.js');
rep(1635, 1826, '__newC.js');
rep(1628, 1632, '__newB.js');
rep(124, 127, '__newA.js');
fs.writeFileSync(target, lines.join(le), 'utf8');
console.log('patched ok, total lines now =', lines.length);