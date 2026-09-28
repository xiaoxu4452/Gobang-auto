/* 发布一致性审计（廿四轮，用户问「打包里面的文件版本有的都比较老了？」）。
 *
 * 基准 = **打包目录**（Meter GomokuTrainer / Desktop version / Meter engine-server）——
 * 安装包就是从这三个目录打的，所以「目录里是不是最新代码」= 用户装到的就是什么。
 *
 * ★ 为什么不能比 md5：这两种文件**每次构建都换字节**，同源两次构建本来就不一样 ——
 *   · `Desktop GomokuTrainer.exe` / `Web GomokuEngine.exe`：PE 头里带时间戳；
 *   · `calc/*.enc` / `bookmarklet.enc`：加密带随机种子（build-release 每次还换主密钥）。
 *   ⇒ 与 build 产物比 md5 会**天天假红**（廿四轮实测踩过）。
 *   正确的判据：**每个文件必须比它的源码新**（`mtime(file) >= mtime(源码)`）——
 *   这正是用户说的「版本老不老」。
 *
 * 另外两条成对/内容不变式：
 *   · 引擎 exe ↔ 面板密文必须成对：同一个 Web GomokuEngine.exe ⇒ bookmarklet.enc 逐字节相同
 *     （密钥随构建随机，混用 = 引擎解不开自己的面板；廿四轮实测 Desktop version 中招过）。
 *   · calc/*.enc 里到底是不是最新**代码**，由 tools/verify-calc-enc.js 负责（解明文查特征），
 *     书签面板由 tools/verify-release-enc.js 负责 —— 本脚本只管「新旧」这一维。
 *
 * 用法：node tools/audit-publish-freshness.js        （退出码 1 = 有陈旧文件）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const md5 = (p) => { try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; } };
const mt = (p) => { try { return fs.statSync(p).mtime; } catch (e) { return null; } };
const fmt = (d) => (d ? d.toISOString().slice(5, 16).replace('T', ' ') : '  --  ');
const list = (d, sub) => { try { return fs.readdirSync(path.join(d, sub || '')).filter((f) => fs.statSync(path.join(d, sub || '', f)).isFile()); } catch (e) { return []; } };
/** 一组文件里最晚的 mtime（源码更新的时间点）。 */
function newest(paths) {
  let best = null;
  for (const p of paths) { const d = mt(p); if (d && (!best || d > best)) best = d; }
  return best;
}
function srcList(dir) { try { return fs.readdirSync(dir)
  // ★ 排除测试专用文件：`_` 前缀 = 测试页/临时产物（发布脚本 copyUIEnc/copyUI 明确排除它们），
  //   `.out.` = GB_SMOKE_ONLY 生成的 harness（每次冒烟都重写 mtime）。
  //   不排除的话，跑一次冒烟 harness 一刷新，所有 calc enc 全被误判「陈旧」（2026-09-25 实测踩过）。
  .filter((f) => !f.startsWith('_') && !f.includes('.out.') && /\.(cpp|h|hpp|js|css|html)$/.test(f))
  .map((f) => path.join(dir, f)); } catch (e) { return []; } }

const BUILD = path.join(ROOT, 'desktop-calculator', 'build');
// 各文件的「源码」定义（改动这些源码就必须重新发布）
const SRC_HOST = [path.join(ROOT, 'desktop-calculator', 'src', 'host.cpp')].concat(
  srcList(path.join(ROOT, 'desktop-calculator', 'src')).filter((p) => /\.h$/.test(p)));
const SRC_UI = srcList(path.join(ROOT, 'desktop-calculator', 'ui'));
const SRC_VIS = srcList(path.join(ROOT, 'desktop-vision', 'src'));
const SRC_RES = srcList(path.join(ROOT, 'engine-server', 'resources'));
const SRC_ENGINE = [path.join(ROOT, 'engine-server', 'engine-server.js'),
  path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'),
  path.join(ROOT, 'tools', 'obfuscator.js')];
// ★ build-release.js 不进基准（2026-09-25 实测踩坑）：它只决定「怎么构建」，
//   改它（哪怕是发布后补一个文档清单）都会把刚出炉的 exe/enc 全判成「陈旧」——
//   内容基准只留真正进 exe/enc 的东西：引擎源码 / 书签源码 / 混淆器。

console.log('=== 源码最新时间');
console.log('  host.cpp        ' + fmt(newest(SRC_HOST)));
console.log('  calc UI 四件    ' + fmt(newest(SRC_UI)));
console.log('  识图算法源码    ' + fmt(newest(SRC_VIS)));
console.log('  rapfi 资源      ' + fmt(newest(SRC_RES)));
console.log('  引擎/面板源码   ' + fmt(newest(SRC_ENGINE)));

let stale = 0, ok = 0, abs_ = 0;
function chk(label, file, srcMtime, note) {
  const d = mt(file);
  if (!d) { stale++; console.log('  ✗ ' + label + '  —— 文件不存在'); return; }
  const fresh = srcMtime ? (d >= srcMtime) : true;
  if (!fresh) stale++; else ok++;
  console.log('  ' + (fresh ? '✓' : '✗') + ' ' + fmt(d) + '  ' + label + (note ? '  ' + note : '') +
    (fresh ? '' : ('   ← 源码 ' + fmt(srcMtime) + ' 更新过，这个还没重新发布')));
}

const TARGETS = ['Meter GomokuTrainer', 'Desktop version', 'Meter engine-server'];
for (const dir of TARGETS) {
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) { console.log('\n=== ' + dir + '（不存在，跳过）'); abs_++; continue; }
  console.log('\n=== ' + dir);
  chk('Desktop GomokuTrainer.exe', path.join(base, 'Desktop GomokuTrainer.exe'), newest(SRC_HOST));
  // ★ calc/ 整个目录消失必须抓出来（build-release 清空重导出后容易忘补；list() 对不存在目录
  //   返回空数组，不显式查的话「目录没了」会静默漏检 —— 2026-09-25 实测踩过）。
  if (!fs.existsSync(path.join(base, 'calc'))) {
    stale++;
    console.log('  ✗ calc/ —— 整个目录不存在（重跑 build-release.js 后忘补？跑 tools/release-calculator.sh 或手动拷 suite-ui-enc）');
  }
  for (const f of list(base, 'calc')) chk('calc/' + f, path.join(base, 'calc', f), newest(SRC_UI));
  chk('GomokuVision.exe', path.join(base, 'GomokuVision.exe'), newest(SRC_VIS));
  if (fs.existsSync(path.join(base, 'Web GomokuEngine.exe'))) {
    chk('Web GomokuEngine.exe', path.join(base, 'Web GomokuEngine.exe'), newest(SRC_ENGINE));
    chk('resources/bookmarklet.enc', path.join(base, 'resources', 'bookmarklet.enc'), newest(SRC_ENGINE));
  }
  // rapfi 模型 = **原样拷贝的数据**（不是构建产物，没有时间戳/随机种子噪音）→ 直接比 md5 最准。
  // ★ 2026-09-24（用户要求）：**纯训练器版不再带 WASM 引擎**。
  // ★ 2026-09-26（用户要求）：**三个目录全部禁带 WASM** —— 原生 rapfi-native/ 的 avx512/avx2
  //   两个变体已能适配绝大多数电脑，~40MB 的 WASM 死重量不再随包分发，出现即为错。
  const wasmFiles = list(base, 'resources').filter((x) => /^rapfi-multi/.test(x));
  if (wasmFiles.length) {
    stale++;
    console.log('  ✗ resources/rapfi-multi.* **不该存在**（2026-09-26 起三目录均禁带 WASM，引擎只走原生）：' + wasmFiles.join(' '));
  } else {
    ok++;
    console.log('  ✓ resources/ 无 WASM 引擎（只走原生，符合规定）');
  }

  // ★ 廿六轮：原生 Rapfi 引擎包 —— ★ 2026-09-25 改版：**三个目录都该有**（三合一版也接入原生
  //   Rapfi 了：engine-server 三车道 main/sub/fwd 各起一个原生进程，页面识别提速 + 引擎 4.5M nodes/s）。
  //   判据（都是精确比对，不像 exe 那样每次构建换字节，不会假红）：
  //     · 引擎 exe == tools/rapfi-build/<variant>/ 的产物（**重编译过引擎却忘了重新 pack** 会立刻现形）；
  //     · 权重 / config == tools/rapfi-src/Networks/ 的原样拷贝。
  const nativeDir = path.join(base, 'rapfi-native');
  const hasNative = fs.existsSync(nativeDir);
  const wantNative = true;
  if (hasNative !== wantNative) {
    stale++;
    console.log('  ✗ rapfi-native/ **缺失**（2026-09-25 起三目录都必须带原生 Rapfi，否则引擎回落 WASM）');
  } else {
    const nbuild = path.join(ROOT, 'tools', 'rapfi-build');
    if (!fs.existsSync(nbuild)) {
      console.log('  – 本机没有 tools/rapfi-build 构建缓存 → 跳过引擎 exe 的逐字节比对');
    } else {
      const badExe = [];
      for (const [variant, exeName] of [['avx512', 'RapfiEngine-avx512.exe'], ['avx2', 'RapfiEngine-avx2.exe']]) {
        const a = md5(path.join(nativeDir, exeName));
        const b = md5(path.join(nbuild, variant, exeName));
        if (!a || a !== b) badExe.push(exeName);
      }
      if (badExe.length) { stale++; console.log('  ✗ rapfi-native/ 引擎 exe 与 tools/rapfi-build 产物不同（重编译过引擎但没重新 pack？）：' + badExe.join(' ')); }
      else { ok++; console.log('  ✓ rapfi-native/ 两个引擎 exe 与 tools/rapfi-build 产物逐字节一致'); }
    }
    const net = path.join(ROOT, 'tools', 'rapfi-src', 'Networks');
    const wf = list(nativeDir).filter((x) => /\.(bin|lz4|toml)$/.test(x));
    const badW = wf.filter((f) => md5(path.join(nativeDir, f)) !== md5(path.join(net, f)));
    if (!wf.length) { stale++; console.log('  ✗ rapfi-native/ 里一个权重/config 都没有（页面起不来引擎）'); }
    else if (badW.length) { stale++; console.log('  ✗ rapfi-native/ 的权重或配置与 tools/rapfi-src/Networks 不同：' + badW.join(' ')); }
    else { ok++; console.log('  ✓ rapfi-native/ 权重与配置 ' + wf.length + ' 个文件与 tools/rapfi-src/Networks 逐字节一致'); }
  }
}

// ★ 成对性：同一引擎 exe ⇒ 同一份面板密文
{
  const A = path.join(ROOT, 'Meter engine-server'), B = path.join(ROOT, 'Desktop version');
  const ea = md5(path.join(A, 'Web GomokuEngine.exe')), eb = md5(path.join(B, 'Web GomokuEngine.exe'));
  const ba = md5(path.join(A, 'resources', 'bookmarklet.enc')), bb = md5(path.join(B, 'resources', 'bookmarklet.enc'));
  console.log('\n=== 引擎 ↔ 面板 成对性');
  if (ea && ea === eb) {
    const pair = ba && ba === bb;
    if (!pair) stale++; else ok++;
    console.log('  ' + (pair ? '✓' : '✗') + ' 两处引擎相同（' + String(ea).slice(0, 10) + '）→ 面板密文' +
      (pair ? '也相同（' + String(ba).slice(0, 10) + '）'
            : '**不同**：' + String(ba).slice(0, 10) + ' / ' + String(bb).slice(0, 10) +
              ' ⇒ 把 Meter engine-server/resources/bookmarklet.enc 复制到 Desktop version'));
  } else {
    console.log('  – 两个目录的引擎 exe 不同 → 各自成套，不做跨目录比对');
  }
}

console.log('\n=== 汇总：' + ok + ' 项比源码新 ✓，' + stale + ' 项陈旧 ✗' + (abs_ ? '，' + abs_ + ' 个目录缺失' : ''));
if (stale) {
  console.log('★ 重新发布：node tools/build-calculator.js --publish && node tools/build-calculator.js --suite --publish');
  console.log('  （引擎/面板变了还要 node tools/build-release.js --publish，并同步 Desktop version/）');
} else {
  console.log('★ 打包目录里的文件全部不比源码旧 —— 安装包就是当前代码');
}
console.log('（提示：calc/*.enc 的**内容**是否最新由 tools/verify-calc-enc.js 查特征；书签面板由 verify-release-enc.js）');
process.exit(stale ? 1 : 0);
