/* 临时工具：解密覆盖层发布包里的 .enc，回出明文，用来核对「发布包里的页面到底是什么」。
 * 用法： node tools/_dec_enc.js <in.enc> <out.txt>
 * 背景：加密带随机 seed/shift，所以「重跑加密再逐字节比对」判不出新旧；
 *       唯一可靠的办法是解密发布包里的密文，直接看内容（本次就是靠它确认面板是否含__gb_pos）。
 */
const fs = require('fs');
const path = require('path');
const O = require(path.join(__dirname, 'obfuscator.js'));

const src = fs.readFileSync(path.join(__dirname, 'encrypt-overlay-ui.js'), 'utf8');
const km = /UI_KEY\s*=\s*(['"])([\s\S]*?)\1/.exec(src);
const KEY = km ? km[2] : null;

const text = fs.readFileSync(process.argv[2], 'utf8');
const pick = (re) => { const m = re.exec(text); return m ? m[1] : null; };
const seed2 = +pick(/SEED2=(\d+)/);
const shift = +pick(/SHIFT=(-?\d+)/);
const b64 = pick(/B64=([\s\S]*)$/).trim();
const out = O.deobfuscate(b64, seed2, shift, KEY);
fs.writeFileSync(process.argv[3], out, 'utf8');
console.log('decoded chars=' + out.length + ' keyFound=' + !!KEY);
