/* 发布一致性审计（廿四轮，用户问「打包里面的文件版本有的都比较老了？」）。
 *
 * ★★ 2026-10-09（用户：「然后发布的新鲜度只针对我们这个版本的软件，其他的软件不要动」）★★
 *   默认基准 = **本版本打包目录 `Meter Gomoku`（连线版）一个**。三件套（Meter GomokuTrainer /
 *   Meter engine-server）源码不同树、发布节奏也不同，默认不再审计它们——它们的红字会干扰
 *   「连线版到底新不新」这个唯一诉求。要一起查时显式加 `--all`（见文件末尾的 TARGETS 说明）。
 *
 * 基准 = **打包目录**（安装包就是从这些目录打的，所以「目录里是不是最新代码」= 用户装到的就是什么）。
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
// ★ 2026-10-08（第 41 轮）：连线版（Meter Gomoku）与三件套**源码不同树** —— 它的宿主是
//   desktop-connect/src、UI 是 desktop-connect/ui。原先 TARGETS 只列了另两个目录，导致
//   「视觉服务只部署了 exe、漏了 dll」这类事故**没有任何闸门**（第 41 轮实际踩过：部署 dll
//   落后源码一整天，照样打完包发出去）。现在把连线版纳入审计，并用它**自己的源码**做基准。
const SRC_HOST_CONN = [path.join(ROOT, 'desktop-connect', 'src', 'host.cpp')].concat(
  srcList(path.join(ROOT, 'desktop-connect', 'src')).filter((p) => /\.h$/.test(p)));
const SRC_UI_CONN = srcList(path.join(ROOT, 'desktop-connect', 'ui'));
const SRC_VIS = srcList(path.join(ROOT, 'desktop-vision', 'src'));
const SRC_RES = srcList(path.join(ROOT, 'engine-server', 'resources'));
const SRC_ENGINE = [path.join(ROOT, 'engine-server', 'engine-server.js'),
  path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'),
  path.join(ROOT, 'tools', 'obfuscator.js')];
// ★ build-release.js 不进基准（2026-09-25 实测踩坑）：它只决定「怎么构建」，
//   改它（哪怕是发布后补一个文档清单）都会把刚出炉的 exe/enc 全判成「陈旧」——
//   内容基准只留真正进 exe/enc 的东西：引擎源码 / 书签源码 / 混淆器。

console.log('=== 源码最新时间');
console.log('  host.cpp(三件套) ' + fmt(newest(SRC_HOST)));
console.log('  calc UI 四件    ' + fmt(newest(SRC_UI)));
console.log('  host.cpp(连线)  ' + fmt(newest(SRC_HOST_CONN)));
console.log('  连线 UI 五件    ' + fmt(newest(SRC_UI_CONN)));
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

// ★ 2026-10-01（用户定案）：发布范围只有这两个 —— 老的 `Desktop version` 已退出发布，
//   不再审计它（留在盘上只是历史归档，别加回来，否则会把陈旧文件当漏发报红）。
// ★ 2026-10-08（第 41 轮）：**加入连线版 `Meter Gomoku`**（它有自己的安装包 MeterGomokuLink.iss）。
//   每个发布目录用**自己的源码树**做基准；`res` 为 null 的目录不做 WASM 盘点（连线版没有
//   resources/，它的 `GomokuTrainer resources/` 只是 WebView2 的用户数据目录）。
// ★★ 2026-10-09（用户：「发布的新鲜度只针对我们这个版本的软件，其他的软件不要动」）★★
//   ⇒ 默认只查 **Meter Gomoku（连线版）**。三件套与它**源码不同树**，一起报会淹没本版本的真实
//     结论；而且用户此刻只关心「发出去的连线版是不是当前代码」。想连三件套一起查时加 `--all`。
const ALL = process.argv.includes('--all');
const TARGETS = ALL ? [
  { dir: 'Meter GomokuTrainer',      host: SRC_HOST,      ui: SRC_UI,      res: 'resources', engine: true  },
  { dir: 'Meter engine-server',      host: SRC_HOST,      ui: SRC_UI,      res: 'resources', engine: true  },
  { dir: 'Meter Gomoku',             host: SRC_HOST_CONN, ui: SRC_UI_CONN, res: null,        engine: false },
] : [
  { dir: 'Meter Gomoku',             host: SRC_HOST_CONN, ui: SRC_UI_CONN, res: null,        engine: false },
];
if (!ALL) console.log('（默认只审计本版本 `Meter Gomoku`；要连三件套一起查，加 --all）');
for (const T of TARGETS) {
  const dir = T.dir;
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) { console.log('\n=== ' + dir + '（不存在，跳过）'); abs_++; continue; }
  console.log('\n=== ' + dir);
  chk('Desktop GomokuTrainer.exe', path.join(base, 'Desktop GomokuTrainer.exe'), newest(T.host));
  // ★ calc/ 整个目录消失必须抓出来（build-release 清空重导出后容易忘补；list() 对不存在目录
  //   返回空数组，不显式查的话「目录没了」会静默漏检 —— 2026-09-25 实测踩过）。
  if (!fs.existsSync(path.join(base, 'calc'))) {
    stale++;
    console.log('  ✗ calc/ —— 整个目录不存在（重跑 build-release.js 后忘补？跑 tools/release-calculator.sh 或手动拷 suite-ui-enc）');
  }
  for (const f of list(base, 'calc')) chk('calc/' + f, path.join(base, 'calc', f), newest(T.ui));
  // ★ 任务 #108：视觉程序独立 Vision\ 子文件夹（exe+dll 成对）—— 与宿主 FindVisionExe 同口径
  chk('Vision/GomokuVision.exe', path.join(base, 'Vision', 'GomokuVision.exe'), newest(SRC_VIS));
  chk('Vision/GomokuVision.dll', path.join(base, 'Vision', 'GomokuVision.dll'), newest(SRC_VIS));
  if (T.engine && fs.existsSync(path.join(base, 'Web GomokuEngine.exe'))) {
    chk('Web GomokuEngine.exe', path.join(base, 'Web GomokuEngine.exe'), newest(SRC_ENGINE));
    chk('resources/bookmarklet.enc', path.join(base, 'resources', 'bookmarklet.enc'), newest(SRC_ENGINE));
  }
  // rapfi 模型 = **原样拷贝的数据**（不是构建产物，没有时间戳/随机种子噪音）→ 直接比 md5 最准。
  // ★ 2026-09-24（用户要求）：**纯训练器版不再带 WASM 引擎**。
  // ★ 2026-09-26（用户要求）：**三个目录全部禁带 WASM** —— 原生 rapfi-native/ 的 avx512/avx2
  //   两个变体已能适配绝大多数电脑，~40MB 的 WASM 死重量不再随包分发，出现即为错。
  if (T.res) {
    const wasmFiles = list(base, T.res).filter((x) => /^rapfi-multi/.test(x));
    if (wasmFiles.length) {
      stale++;
      console.log('  ✗ ' + T.res + '/rapfi-multi.* **不该存在**（2026-09-26 起三目录均禁带 WASM，引擎只走原生）：' + wasmFiles.join(' '));
    } else {
      ok++;
      console.log('  ✓ ' + T.res + '/ 无 WASM 引擎（只走原生，符合规定）');
    }
  }

  // ★ 廿六轮：原生 Rapfi 引擎包 —— ★ 2026-09-25 改版：**三个目录都该有**（三合一版也接入原生
  //   Rapfi 了：engine-server 三车道 main/sub/fwd 各起一个原生进程，页面识别提速 + 引擎 4.5M nodes/s）。
  //   判据（都是精确比对，不像 exe 那样每次构建换字节，不会假红）：
  //   ★ 2026-09-29 改口径：rapfi-native/ 现在发的是**官方 250615 预编译 5 变体**，
  //     基准目录从 tools/rapfi-build/ 换成 tools/rapfi-official/（见 tools/pack-rapfi-native.js）：
  //     · 5 个引擎 exe == tools/rapfi-official/pbrain-rapfi-windows-*.exe（换变体没重新 pack 会现形）；
  //     · 权重 / config == Networks/，但 **model210901.bin 例外** —— 官方二进制只认
  //       tools/rapfi-official/ 那份旧格式（23 204 B），Networks/ 那份（30 109 B）是自编译 master
  //       用的新格式，两者**不能互换**（换错 = 引擎起来就 ERROR 退出）。
  const nativeDir = path.join(base, 'rapfi-native');
  const hasNative = fs.existsSync(nativeDir);
  const wantNative = true;
  if (hasNative !== wantNative) {
    stale++;
    console.log('  ✗ rapfi-native/ **缺失**（2026-09-25 起三目录都必须带原生 Rapfi，否则引擎回落 WASM）');
  } else {
    const noff = path.join(ROOT, 'tools', 'rapfi-official');
    if (!fs.existsSync(noff)) {
      console.log('  – 本机没有 tools/rapfi-official 官方包 → 跳过引擎 exe 的逐字节比对');
    } else {
      const badExe = [];
      for (const pair of [
        ['pbrain-rapfi-windows-avx512vnni.exe', 'RapfiEngine-avx512vnni.exe'],
        ['pbrain-rapfi-windows-avxvnni.exe', 'RapfiEngine-avxvnni.exe'],
        ['pbrain-rapfi-windows-avx512.exe', 'RapfiEngine-avx512.exe'],
        ['pbrain-rapfi-windows-avx2.exe', 'RapfiEngine-avx2.exe'],
        ['pbrain-rapfi-windows-sse.exe', 'RapfiEngine-sse.exe'],
      ]) {
        const a = md5(path.join(nativeDir, pair[1]));
        const b = md5(path.join(noff, pair[0]));
        if (!a || a !== b) badExe.push(pair[1]);
      }
      if (badExe.length) { stale++; console.log('  ✗ rapfi-native/ 引擎 exe 与 tools/rapfi-official 不同（换过变体却没重新 pack？）：' + badExe.join(' ')); }
      else { ok++; console.log('  ✓ rapfi-native/ 5 个引擎 exe 与 tools/rapfi-official 逐字节一致'); }
    }
    const net = path.join(ROOT, 'tools', 'rapfi-src', 'Networks');
    const wf = list(nativeDir).filter((x) => /\.(bin|lz4|toml)$/.test(x));
    const badW = wf.filter((f) => {
      const src = (f === 'model210901.bin') ? path.join(noff, f) : path.join(net, f);
      return md5(path.join(nativeDir, f)) !== md5(src);
    });
    if (!wf.length) { stale++; console.log('  ✗ rapfi-native/ 里一个权重/config 都没有（页面起不来引擎）'); }
    else if (badW.length) { stale++; console.log('  ✗ rapfi-native/ 的权重或配置与基准不同：' + badW.join(' ')); }
    else { ok++; console.log('  ✓ rapfi-native/ 权重与配置 ' + wf.length + ' 个文件与基准逐字节一致（model210901.bin 取官方旧格式）'); }
  }
}

// ★ 成对性：同一引擎 exe ⇒ 同一份面板密文
// ★ 2026-10-01：发布范围收缩后 `Desktop version` 不再是发布目标，跨目录成对性比对随之取消
//   （原本是 Meter engine-server ↔ Desktop version 两个三件套目录互比，现在只剩一个）。
//   —— 保留这段注释说明「为什么没了」，避免以后误以为漏检。

console.log('\n=== 汇总：' + ok + ' 项比源码新 ✓，' + stale + ' 项陈旧 ✗' + (abs_ ? '，' + abs_ + ' 个目录缺失' : ''));
if (stale) {
  console.log('★ 重新发布：node tools/build-calculator.js --publish && node tools/build-calculator.js --suite --publish');
  console.log('  （引擎/面板变了还要 node tools/build-release.js --publish）');
} else {
  console.log('★ 打包目录里的文件全部不比源码旧 —— 安装包就是当前代码');
}
console.log('（提示：calc/*.enc 的**内容**是否最新由 tools/verify-calc-enc.js 查特征；书签面板由 verify-release-enc.js）');
process.exit(stale ? 1 : 0);
