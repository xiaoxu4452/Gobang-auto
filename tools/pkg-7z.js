#!/usr/bin/env node
/**
 * 把三个发布目录打成【名字 + 版本号】的 7z，供网盘上传：
 *   Meter GomokuTrainer4.33.7z / Desktop version4.33.7z / Meter engine-server4.33.7z
 *
 * ★ 版本号怎么来（三级兜底，优先「解析 EXE 文件」）：
 *   ① 读 exe 里的 VERSIONINFO 资源（自己解析 PE，零依赖）—— 由 tools/gen-appver-rc.js 编进去，
 *      源头是 calc.js 的 APP_VERSION，所以 exe / 关于页 / 压缩包名三者永远是同一个号；
 *   ② 读不出来（比如 exe 是旧版本编的）→ 退到 PowerShell 的 VersionInfo；
 *   ③ 还不行 → 直接抠 calc.js 的 `var APP_VERSION`。
 *
 * 用法：
 *   node tools/pkg-7z.js                          # 打三个目录 → 版本取自 exe
 *   node tools/pkg-7z.js --dirs "Meter GomokuTrainer"   # 只打一个
 *   node tools/pkg-7z.js --ver 4.33               # 强制版本号（改名不用重编 exe）
 *   node tools/pkg-7z.js --out dist               # 输出到 dist/（默认项目根目录）
 *   node tools/pkg-7z.js --dry                    # 只打印将要产出的文件名
 *
 * 压缩走 Python 的 py7zr（本机没装 7z CLI）；可用 7Z_BIN 环境变量指定 7z.exe 来加速。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PY = 'C:/Users/harve/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
// ★ 2026-10-01（用户定案）：打包范围跟发布范围一致 —— 只剩独立版 + 三件套版两个目录，
//   老的 `Desktop version` 不再打包（它是历史归档，里面的 exe 是旧代码，别混进发行包）。
const DEF_DIRS = ['Meter GomokuTrainer', 'Meter engine-server'];

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const dirs = val('--dirs') ? val('--dirs').split(',').map((s) => s.trim()).filter(Boolean) : DEF_DIRS;
const outDir = path.resolve(ROOT, val('--out', '.'));
// ★ 只认训练器 exe（它的 VERSIONINFO 是我们自己编进去的 APP_VERSION）。
//   Web GomokuEngine.exe 是 node 的 SEA 副本，版本资源里写的是 Node 的版本（22.x），
//   拿它当版本源会把压缩包命名成 22.22.2 —— 已经踩过一次，别再加回来。
const EXES = [
  path.join(ROOT, 'Meter GomokuTrainer', 'Desktop GomokuTrainer.exe'),
  path.join(ROOT, 'Meter engine-server', 'Desktop GomokuTrainer.exe'),
];

// ---------- ① 自己解析 PE 的 VERSIONINFO ----------
/**
 * 不走「PE 头 → 三层资源目录」那条路：MSVC 链接器会在 .rsrc 开头塞对齐填充，
 * 数据目录给的 RVA 与实际目录头对不齐（实测差 16 字节），遍历会直接读到 0 个条目。
 * ★ 改为：直接在文件里找 UTF-16 的 "VS_VERSION_INFO"（它只可能出现在资源里），
 *   从结构体开头按 VERSIONINFO 规范解析，稳且短。
 *   结构（每块）：wLength(2) wValueLength(2) wType(2) szKey(UTF-16+\0) [pad→4] [value] [pad→4] children...
 */
function parseVersionInfo(buf, base) {
  const total = buf.readUInt16LE(base);
  const end = Math.min(base + total, buf.length);
  const strings = {};
  const pad4 = (p) => base + (((p - base) + 3) & ~3);           // 填充相对结构起点
  const u16 = (p) => {
    let s = '';
    while (p + 2 <= buf.length) { const c = buf.readUInt16LE(p); if (!c) break; s += String.fromCharCode(c); p += 2; }
    return s;
  };
  (function walk(off, stop) {
    let p = off;
    for (let guard = 0; guard < 200 && p + 6 <= stop; guard++) {
      const wLen = buf.readUInt16LE(p);
      const wVal = buf.readUInt16LE(p + 2);
      const wType = buf.readUInt16LE(p + 4);
      if (wLen < 6 || p + wLen > stop) break;
      const key = u16(p + 6);
      let next = pad4(p + 6 + (key.length + 1) * 2);
      if (wType === 1 && wVal > 0) {                            // 字符串叶子（wVal = 字符数）
        const v = buf.slice(next, Math.min(next + wVal * 2, buf.length)).toString('utf16le').replace(/\0+$/, '');
        if (!(key in strings)) strings[key] = v;
      } else if (wVal > 0) {                                    // 二进制值（VS_FIXEDFILEINFO），值后面才是子块
        next = pad4(next + wVal);
        walk(next, p + wLen);
      } else {                                                  // 块：StringFileInfo / VarFileInfo / 语言块
        walk(next, p + wLen);
      }
      const np = pad4(p + wLen);
      if (np <= p) break;
      p = np;
    }
  })(pad4(base + 6 + ('VS_VERSION_INFO'.length + 1) * 2), end);
  return strings;
}
function peVersion(exePath) {
  try {
    const buf = fs.readFileSync(exePath);
    const e_lfanew = buf.readUInt32LE(0x3c);
    if (buf.toString('latin1', e_lfanew, e_lfanew + 4) !== 'PE\0\0') return null;
    const kw = buf.indexOf(Buffer.from('VS_VERSION_INFO\0', 'utf16le'));
    if (kw < 6) return null;
    const st = parseVersionInfo(buf, kw - 6);
    // 优先 ProductVersion（与 FileVersion 同值，取不到再退 FileVersion）
    for (const k of ['ProductVersion', 'FileVersion']) {
      if (st[k] && /^\d+(\.\d+){0,3}$/.test(st[k])) return st[k];
    }
    return null;
  } catch (e) { return null; }
}

// ---------- ② PowerShell 兜底 ----------
function psVersion(exePath) {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    let ch;
    try {
      ch = spawn('powershell', ['-NoProfile', '-Command',
        `(Get-Item -LiteralPath '${exePath}').VersionInfo.ProductVersion`], { windowsHide: true });
    } catch (e) { return fin(null); }
    let out = '';
    ch.stdout.on('data', (d) => { out += d.toString(); });
    ch.on('error', () => fin(null));
    ch.on('exit', () => {
      const m = out.match(/\d+(?:\.\d+){1,3}/);
      fin(m ? m[0] : null);
    });
    setTimeout(() => { try { ch.kill(); } catch (e) {} fin(null); }, 15000);
  });
}

// ---------- ③ calc.js 兜底 ----------
function calcVersion() {
  const s = fs.readFileSync(path.join(ROOT, 'desktop-calculator', 'ui', 'calc.js'), 'utf8');
  const m = s.match(/^\s*var\s+APP_VERSION\s*=\s*'([^']+)'\s*;/m);
  return m ? m[1] : null;
}

/** '4.33.0.0' → '4.33'（用户习惯只写两位：4.33；若三位如 4.3.30 则原样保留） */
function shortVer(v) {
  const p = String(v).split('.').map((x) => parseInt(x, 10));
  while (p.length > 2 && p[p.length - 1] === 0) p.pop();
  return p.join('.');
}

// ---------- 打包 ----------
function run(cmd, args, opts) {
  return new Promise((res) => {
    const ch = spawn(cmd, args, Object.assign({ windowsHide: true }, opts));
    let out = '';
    ch.stdout.on('data', (d) => { out += d.toString(); });
    ch.stderr.on('data', (d) => { out += d.toString(); });
    ch.on('error', (e) => res({ code: -1, out: String(e) }));
    ch.on('exit', (c) => res({ code: c, out }));
  });
}

const PY_SCRIPT = `
import sys, py7zr
src, out, arc = sys.argv[1], sys.argv[2], sys.argv[3]
f = [{"id": py7zr.FILTER_LZMA2, "preset": 7}]
with py7zr.SevenZipFile(out, "w", filters=f, dereference=False) as z:
    z.writeall(src, arc)
print("OK")
`;

async function main() {
  let ver = val('--ver', null);
  let srcNote = '--ver 手工指定';
  if (!ver) {
    for (const e of EXES) {
      if (!fs.existsSync(e)) continue;
      const v = peVersion(e);
      if (v) { ver = v; srcNote = 'PE 版本资源：' + path.basename(e); break; }
    }
  }
  if (!ver) {
    for (const e of EXES) {
      if (!fs.existsSync(e)) continue;
      const v = await psVersion(e);
      if (v) { ver = v; srcNote = 'PowerShell VersionInfo：' + path.basename(e); break; }
    }
  }
  if (!ver) { ver = calcVersion(); srcNote = 'calc.js 的 APP_VERSION'; }
  if (!ver) { console.error('[pkg-7z] 取不到版本号'); process.exit(1); }
  const short = shortVer(ver);
  console.log(`[pkg-7z] 版本号 ${ver} → 压缩包后缀 ${short}（来源：${srcNote}）`);

  if (has('--print-ver')) return;                 // 只想看版本：到此为止
  if (has('--dry')) { dirs.forEach((d) => console.log('  → ' + d + short + '.7z')); return; }

  const sevenZip = process.env.SEVEN_ZIP_BIN || process.env['7Z_BIN'] || null;
  fs.mkdirSync(outDir, { recursive: true });
  for (const d of dirs) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) { console.error('  ✗ 缺目录 ' + d); continue; }
    const out = path.join(outDir, d + short + '.7z');
    const t0 = Date.now();
    let r;
    if (sevenZip && fs.existsSync(sevenZip)) {
      if (fs.existsSync(out)) fs.unlinkSync(out);
      r = await run(sevenZip, ['a', '-t7z', '-mx=7', '-mmt=on', '-bso0', '-bsp0', out, path.join(src, '*')]);
      r = { code: r.code, out: r.out };
    } else {
      if (fs.existsSync(out)) fs.unlinkSync(out);
      const f = path.join(require('os').tmpdir(), '_pkg7z.py');
      fs.writeFileSync(f, PY_SCRIPT, 'utf8');
      r = await run(PY, [f, src, out, d]);
    }
    const sz = fs.existsSync(out) ? (fs.statSync(out).size / 1048576).toFixed(1) + ' MB' : '—';
    console.log(`  ${r.code === 0 ? '✓' : '✗'} ${d + short}.7z  ${sz}  ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (r.code !== 0 ? '\n    ' + r.out.slice(0, 400) : ''));
  }
}

module.exports = { peVersion, psVersion, calcVersion, shortVer };
if (require.main === module) main();
