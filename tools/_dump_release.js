/* 把发布目录的 .enc 解密成明文页面临时目录，供浏览器功能实测 */
const fs = require('fs'), path = require('path');
const O = require('./obfuscator.js');
const KEY = 'GbClcUiK3y2026xQz9Wm8Pd5Rt2YvN7s';
const REL = process.argv[2] || 'Meter GomokuTrainer';
const OUT = path.join(__dirname, '_rel_check');
function decrypt(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const m2 = /SEED2=(\d+)/.exec(txt), mh = /SHIFT=(\d+)/.exec(txt);
  const b64 = txt.split('B64=')[1];
  if (!m2 || !mh || !b64) throw new Error('bad container: ' + p);
  return O.deobfuscate(b64.trim(), +m2[1], +mh[1], KEY);
}
fs.mkdirSync(OUT, { recursive: true });
for (const n of ['calc.html', 'calc.css', 'calc.js', 'engine-ai.js']) {
  const src = path.join('..', REL, 'calc', n + '.enc');
  const dst = path.join(OUT, n);
  fs.writeFileSync(dst, decrypt(src));
  console.log('dump', n, fs.statSync(dst).size);
}
