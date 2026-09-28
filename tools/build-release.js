/*
 * build-release.js —— 导出加密发布版
 *
 * 用法：
 *   node tools/build-release.js [--version 3.86] [--zip]
 *
 * 默认行为：直接把完整的加密发布版导出到
 *   C:\Users\harve\Desktop\Gobang auto\Meter engine-server\
 * （不出 zip）。加 --zip 才额外打一个压缩包。
 *
 * 做什么：
 *   1. 从「源工程」 engine-server/ 取最新代码（含禁手修复等）
 *   2. 生成 32 字符随机主密钥，用「双层异或（两种子交错）+ 字符位移 + base64」混淆：
 *        engine-server.js  → 混淆包装（SEA 下注入 require 执行）
 *        bookmarklet.js    → 混淆密文（服务端还原后经 http 下发给面板）
 *   3. 生成 sea-config 并调用 node --experimental-sea-config 产出 engine.blob
 *   4. 复制本机 node.exe 为 GomokuEngine.exe，用 postject 注入 blob
 *   5. 组装发布目录树（python 源码+requirements、resources、文档；不含不可移植的 .venv）
 *
 * 密钥处理：每次构建生成新的 32 字符随机密钥，拆成两段打乱后注入 engine-server.js，
 * 文件里搜不到连续密钥串。可用环境变量 GB_RELEASE_KEY=<32字符> 指定密钥以便复现构建。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const O = require('./obfuscator.js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'engine-server');                // 源工程（最新代码）
const OUTDIR = path.join(ROOT, 'build-release');             // 构建中间产物
const FINAL_DIR = path.join(ROOT, 'Meter engine-server');    // 最终发布目录（直接导出）

function log(m) { process.stdout.write(m + '\n'); }
function die(m) { process.stderr.write('ERROR: ' + m + '\n'); process.exit(1); }
function copyFile(a, b) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  // 同尺寸即视为已是同一份内容，跳过复制：便携 Python 运行时有 330MB（cv2 单文件 ~150MB），
  // 每次全量覆盖既慢，又容易撞上「目标文件被外部进程（实时防护扫描）短暂占用」的 EBUSY。
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.size === sb.size && sb.mtimeMs >= sa.mtimeMs) return;
  } catch (e) { /* 目标不存在等：照常复制 */ }
  // EBUSY 重试：Windows 上刚被写入/扫描的大文件会短暂锁住，最多等 ~6s
  let lastErr = null;
  for (let i = 0; i < 12; i++) {
    try {
      fs.copyFileSync(a, b);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!/EBUSY|EPERM|EACCES/i.test(e.code || e.message)) break;
      const until = Date.now() + 500;
      while (Date.now() < until) { /* 忙等 0.5s（本环境无 sleep 命令依赖） */ }
    }
  }
  if (lastErr) throw lastErr;
  try { fs.chmodSync(b, 0o666); } catch (e) {}   // 去掉只读位，保证后续可覆盖
}
function mb(n) { return (n / 1024 / 1024).toFixed(1) + 'MB'; }

// 递归复制目录，支持过滤
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (filter && !filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else copyFile(s, d);
  }
}

// 强制删除（处理 Windows 只读属性：历史发布包里的文件常带只读位，直接 rmSync 会 EPERM）
function forceRm(p) {
  if (!fs.existsSync(p)) return;
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  // 先去掉只读位，再递归；顺序很重要：只读文件本身要先可写才能删
  try { fs.chmodSync(p, 0o666); } catch (e) {}
  if (st.isDirectory()) {
    let kids = [];
    try { kids = fs.readdirSync(p); } catch (e) {}
    for (const f of kids) forceRm(path.join(p, f));
  }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

// ---- 参数 ----
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const VERSION = arg('version', '3.86');
const DOZIP = argv.includes('--zip');                        // 默认不打 zip
const OUTZIP = arg('out', path.join(ROOT, 'Meter engine-server' + VERSION + '.zip'));
const DIRNAME = 'Meter engine-server';
// ★ 2026-09-25：双阶段模式 —— 本沙箱/便携环境里 node 的 spawnSync 一律 EBUSY
//   （子进程起不来），SEA 生成 / postject 注入 / 换图标三步必须由外部 bash 直驱。
//   · --phase=stage  只做 1~3（混淆 + 暂存，零 spawn），然后提示外部命令后退出；
//   · --phase=finish 跳过 1~5，直接从第 6 步（清理中间产物 + 导出 + 硬校验）继续；
//   · 默认 all = 原有整条流水线（spawn 可用的机器上一条命令跑完）。
const PHASE = (argv.find((a) => a.startsWith('--phase=')) || '--phase=all').split('=')[1];

(async function main() {
  log('=== 导出混淆发布版 v' + VERSION + ' ===');
  log('源工程: ' + SRC);

  const srcEngine = path.join(SRC, 'engine-server.js');
  const srcBm = path.join(SRC, 'resources', 'bookmarklet.js');
  const projDir = path.join(OUTDIR, DIRNAME);              // 构建临时目录（两种阶段共用）
  const blobPath = path.join(projDir, 'engine.blob');
  const seaCfg = path.join(projDir, 'sea-config.json');

  // ★ --phase=finish：1~3 步（混淆+暂存）**必须整体跳过** —— 每次混淆都会生成**新的随机主密钥**，
  //   重跑会换掉 engine-server.js / bookmarklet.enc 的密钥，与外部 bash 已注入 exe 的 blob
  //   （旧密钥）失配 → 服务端解不开自己下发的面板。finish 只认外部三连的产物。
  if (PHASE === 'finish') {
    if (!fs.existsSync(blobPath)) die('phase=finish：engine.blob 不存在（外部 SEA 步骤没跑？）');
    const exePath = path.join(projDir, 'Web GomokuEngine.exe');
    if (!fs.existsSync(exePath)) die('phase=finish：Web GomokuEngine.exe 不存在（外部注入步骤没跑？）');
    const fp = fs.readFileSync(blobPath).slice(0, 64);
    if (!fs.readFileSync(exePath).includes(fp)) {
      die('phase=finish：exe 里没有本次 blob 的头部指纹 —— 注入未生效，别发这个包');
    }
    fs.writeFileSync(path.join(OUTDIR, '.blob-fingerprint'), fp.toString('base64'), 'utf8');
    log('[finish] blob 指纹已确认写入 exe（fp=' + fp.toString('base64').slice(0, 12) + '…）');
  } else {

  if (!fs.existsSync(srcEngine)) die('找不到 ' + srcEngine);
  if (!fs.existsSync(srcBm)) die('找不到 ' + srcBm);

  // ---- 1. 混淆 engine-server.js ----
  let engineText = fs.readFileSync(srcEngine, 'utf8');
  if (/^\s*\(function\(\)\{'use strict';/.test(engineText)) {
    die('源 engine-server.js 已是混淆包装，请用原始工程作源');
  }
  if (!engineText.includes('@@GB_KEY_SRC@@')) {
    die('源 engine-server.js 缺少 @@GB_KEY_SRC@@ 占位（无法注入发布密钥）');
  }
  // 32 字符随机主密钥（环境变量 GB_RELEASE_KEY 可指定，便于复现/多批次签发）
  const KEY = (process.env.GB_RELEASE_KEY && process.env.GB_RELEASE_KEY.length === 32)
    ? process.env.GB_RELEASE_KEY
    : O.randomKey();
  if (KEY.length !== 32) die('主密钥必须为 32 字符');
  log('[key] 32 字符随机主密钥已生成');
  // 把密钥拆成「两段打乱 + 位置表」，注入 engine-server.js —— 文件里搜不到连续密钥串
  const keyPack = O.splitKey(KEY);
  const keyLiteral = JSON.stringify([keyPack.a, keyPack.b, keyPack.posA, keyPack.posB, keyPack.order]);
  engineText = engineText.replace(/var GB_KEY_SRC = null;\s*\/\/ @@GB_KEY_SRC@@/, 'var GB_KEY_SRC = ' + keyLiteral + ';');
  if (engineText.includes('@@GB_KEY_SRC@@')) die('密钥占位替换未生效');
  const eEngine = O.obfuscate(engineText, KEY);
  const wrapped = O.buildWrapper(eEngine, 'engine-server.js');
  log('[obf] engine-server.js: ' + engineText.length + ' → 密文 ' + eEngine.b64.length + ' 字符，包装 ' + wrapped.length + ' 字节');
  log('[obf] 密钥已两段打乱注入（文件内不含连续密钥串）');

  // ---- 2. 混淆 bookmarklet.js（服务端还原后下发）----
  // 用同一个主密钥（服务端 GB_KEY_SRC 里已注入），面板密文自带 seed2/shift。
  const bmText = fs.readFileSync(srcBm, 'utf8');
  const eBm = O.obfuscate(bmText, KEY);
  const bmEncJson = JSON.stringify({
    magic: 'GBOBF1',
    seed2: eBm.seed2,
    shift: eBm.shift,
    data: eBm.b64
  });
  log('[obf] bookmarklet.js: ' + bmText.length + ' → 密文 ' + eBm.b64.length + ' 字符');

  // ---- 3. 组装发布目录 ----
  // 目标目录树（与历史发布包一致，单一顶层目录）：
  //   Meter engine-server/
  //     ├─ Web GomokuEngine.exe        （网页书签端：名称带 Web 前缀，与桌面端一眼分清）
  //     ├─ Desktop GomokuOverlay.exe   （桌面覆盖层）
  //     ├─ Desktop GomokuTrainer.exe   （桌面练习器）
  //     ├─ GomokuVision.exe            （识别服务：官方 OpenCV C++，零依赖）
  //     ├─ resources/  （bookmarklet.enc 密文；rapfi-multi.* 已移除，引擎只走原生）
  //     ├─ overlay/  （加密面板 .enc）
  //     └─ calc/  （练习器加密 UI）
  forceRm(OUTDIR);
  fs.mkdirSync(projDir, { recursive: true });

  // 3a. 加密后的服务端入口
  copyFile(path.join(__dirname, 'sea-config.json'), path.join(projDir, 'sea-config.json'));
  fs.writeFileSync(path.join(projDir, 'engine-server.js'), wrapped, 'utf8');
  log('[stage] engine-server.js（自解密包装）');

  // 3b. resources：bookmarklet 密文（2026-09-26 起 WASM 引擎 rapfi-multi.* 不再随包，
  //     引擎只走 exe 旁的 rapfi-native/ 原生进程）
  const resDir = path.join(projDir, 'resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'bookmarklet.enc'), bmEncJson, 'utf8');
  log('[stage] resources/bookmarklet.enc（密文，服务端解密下发）');
  // 说明：不再落盘明文 bookmarklet.js —— 面板脚本一律由服务端解密后经 /bookmarklet.js 下发，
  // 静态解压发布包只能看到 resources/bookmarklet.enc（密文）。

  // 3c. 识别服务：GomokuVision.exe（官方 OpenCV C++，三模块静态链接，单文件零依赖）
  // 【2026-09-20 换装】原来这里暂存的是 python/（源码 + requirements + 便携运行时，
  //   193MB、1700+ 碎文件，还要在别人电脑上现场装依赖）。现在整包只多一个约 6.7MB 的
  //   EXE —— 识别算法是原 Python 实现的逐句移植，由 tools/vision-parity.py 在预防针
  //   矩阵 A~J 上逐子对拍（47/47 全过）保证行为等价。
  //   仓库里的 engine-server/python/ 仍然保留：它是**行为参照**，只用于开发期对拍，
  //   绝不进发布包（用户要求彻底移除 Python 运行时）。
  {
    const visionExe = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');
    if (!fs.existsSync(visionExe)) {
      die('缺少 GomokuVision.exe（请先跑 node tools/build-vision.js 编译）');
    }
    // 新鲜度护栏：EXE 必须比它自己的源码新，否则会发一个「跑了旧识别逻辑」的包。
    const exeMt = fs.statSync(visionExe).mtimeMs;
    let newestSrc = 0, newestName = '';
    for (const f of fs.readdirSync(path.join(ROOT, 'desktop-vision', 'src'))) {
      if (!f.endsWith('.cpp') && !f.endsWith('.h')) continue;
      const m = fs.statSync(path.join(ROOT, 'desktop-vision', 'src', f)).mtimeMs;
      if (m > newestSrc) { newestSrc = m; newestName = f; }
    }
    if (newestSrc > exeMt) {
      die('GomokuVision.exe 比源码旧（最新源文件 ' + newestName + '）—— 请先跑 node tools/build-vision.js');
    }
    const dst = path.join(projDir, 'GomokuVision.exe');
    copyFile(visionExe, dst);
    log('[stage] GomokuVision.exe  ' + mb(fs.statSync(visionExe).size) + '（识别服务，零依赖）');
  }

  // 3d. 文档
  //     ★ 2026-09-25 晚补 README_zh/en.md —— iss（打包源=Meter engine-server）引用了它们，
  //       之前只靠手工往发布目录拷，forceRm 重建后一忘就打不了包。
  for (const f of ['User Guide.txt', '使用说明.txt', 'README_zh.md', 'README_en.md']) {
    const s = path.join(SRC, f);
    if (fs.existsSync(s)) copyFile(s, path.join(projDir, f));
    else {
      const s2 = path.join(ROOT, 'Meter engine-server', f);
      if (fs.existsSync(s2)) copyFile(s2, path.join(projDir, f));
    }
  }

  // 3e. 桌面覆盖层（GomokuOverlay.exe + overlay/ 面板资源）
  //     它与 GomokuEngine.exe 并排放在同一目录，于是两者共用同一份 resources/（Rapfi 引擎）
  //     与 python/（OpenCV 识别运行时）——桌面版因此不需要自带一份引擎与识别依赖。
  //     宿主按「exe 同目录下有 GomokuEngine.exe」识别出套装根目录，从而复用这些资源。
  // ★ 桌面端成品改名带 Desktop 前缀（与网页端 Web GomokuEngine.exe 对应）。
  //   覆盖层 overlay/ 只带**加密后的 .enc** —— 明文 UI 一个都不进发布包。
  const OV_EXE_NAME = 'Desktop GomokuOverlay.exe';
  const ovExe = path.join(ROOT, 'desktop-overlay', 'build', OV_EXE_NAME);
  if (fs.existsSync(ovExe)) {
    copyFile(ovExe, path.join(projDir, OV_EXE_NAME));
    log('[stage] ' + OV_EXE_NAME + '  ' + mb(fs.statSync(ovExe).size));
    const ovUi = path.join(ROOT, 'desktop-overlay', 'ui');
    const ovDst = path.join(projDir, 'overlay');
    fs.mkdirSync(ovDst, { recursive: true });
    let nEnc = 0;
    for (const f of ['panel.html', 'panel-ui.js', 'bridge.js']) {
      const src = path.join(ovUi, f);
      if (!fs.existsSync(src)) die('缺少面板资源 desktop-overlay/ui/' + f + '（请先跑 tools/build-overlay.js）');
      const enc = src + '.enc';
      if (!fs.existsSync(enc)) die('缺少加密面板资源 desktop-overlay/ui/' + f + '.enc（请先跑 tools/build-overlay.js）');
      copyFile(enc, path.join(ovDst, f + '.enc'));
      // 明文绝不落进发布目录
      try { fs.rmSync(path.join(ovDst, f), { force: true }); } catch (e) { /* 本来就没有 */ }
      nEnc++;
    }
    if (!nEnc) die('overlay/ 里没有任何加密面板资源');
    log('[stage] overlay/（面板 .enc 密文 ×' + nEnc + '，明文不入库）');
  } else {
    log('[warn] 未找到 desktop-overlay/build/' + OV_EXE_NAME + '（请先跑 tools/build-overlay.js）；本次发布不含桌面覆盖层');
  }

  // ---- 4. 生成 engine.blob（SEA）----
  // ★ --phase=stage 到此为止：外部 bash 接手（sea-config → 复制 node.exe → postject → seticon）
  if (PHASE === 'stage') {
    log('\n[stage] 暂存完成（phase=stage）。请在外部 shell 依次执行：');
    log('  cd "' + projDir + '"');
    log('  node --experimental-sea-config sea-config.json');
    log('  cp <node.exe> "Web GomokuEngine.exe"');
    log('  node <postject>/dist/cli.js "Web GomokuEngine.exe" NODE_SEA_BLOB engine.blob ' +
        '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite');
    log('  <tools/build/seticon.exe> "Web GomokuEngine.exe" <tools/build/GomokuWeb.ico>');
    log('  node tools/build-release.js --phase=finish');
    return;
  }
  }   // end else：phases 1~3 只属于 stage / all（finish 直接落到第 6 步）
  if (PHASE === 'all') {
  // ---- 4. 生成 engine.blob（SEA）----
  log('[sea] 生成 engine.blob ...');
  // 【防陈旧产物】先清掉可能残留的 blob，否则 sea-config 若因故失败，
  // 后面的注入会拿上一次的旧 blob 打进 exe —— 现象就是「发布版文件是新的，
  // 但跑起来还是旧代码」。必须保证每次都是全新生成。
  try { fs.rmSync(blobPath, { force: true }); } catch (e) {}
  const seaOut = spawnSync(process.execPath,
    ['--experimental-sea-config', seaCfg],
    { cwd: projDir, encoding: 'utf8' });
  if (seaOut.status !== 0) {
    die('sea-config 失败: ' + (seaOut.stderr || seaOut.stdout));
  }
  // sea-config 的 output 是相对 cwd 的 engine.blob
  if (!fs.existsSync(blobPath)) die('engine.blob 未生成');
  // 记录 blob 指纹，注入后核对 exe 里确实是这一份（而不是上一版的残留）
  const blobFp = fs.readFileSync(blobPath).slice(0, 64).toString('base64');
  fs.writeFileSync(path.join(OUTDIR, '.blob-fingerprint'), blobFp, 'utf8');
  log('[sea] engine.blob ' + mb(fs.statSync(blobPath).size) + '  fp=' + blobFp.slice(0, 12) + '…');

  // ---- 5. 生成 Web GomokuEngine.exe（复制 node.exe + 注入 blob + 换图标）----
  // ★ 名称带 Web 前缀：与桌面端 Desktop GomokuOverlay.exe 一眼分清哪个是网页端。
  const WEB_EXE_NAME = 'Web GomokuEngine.exe';
  const exePath = path.join(projDir, WEB_EXE_NAME);
  log('[exe] 复制 node.exe → ' + WEB_EXE_NAME + ' ...');
  fs.copyFileSync(process.execPath, exePath);
  log('[exe] 注入 SEA blob ...');
  const injector = path.join(__dirname, 'inject-sea.js');
  const inj = spawnSync(process.execPath, [injector, exePath, blobPath], { encoding: 'utf8' });
  if (inj.status !== 0) die('blob 注入失败: ' + (inj.stderr || inj.stdout));
  log('[exe] ' + WEB_EXE_NAME + ' ' + mb(fs.statSync(exePath).size));
  // 网页端图标（web.png 转出来的 .ico）：这个 exe 是 node.exe 的副本，
  // 没经过链接器，所以只能用 UpdateResource 事后把图标刻进去。
  {
    const ico = path.join(__dirname, 'build', 'GomokuWeb.ico');
    if (fs.existsSync(ico)) {
      const si = spawnSync(process.execPath, [path.join(__dirname, 'set-icon.js'), exePath, ico], { encoding: 'utf8' });
      const out = ((si.stdout || '') + (si.stderr || '')).trim();
      if (out) log(out.split('\n').map((l) => '  ' + l).join('\n'));
      if (si.status !== 0) die('网页端图标写入失败');
    } else {
      log('[warn] 未找到 tools/build/GomokuWeb.ico（跑一次 python tools/make-icons.py 生成）；本次发布沿用 node.exe 原图标');
    }
  }
  }   // end: PHASE === 'all'（SEA / 注入 / 图标三步只在新流水线里做）

  // ---- 6. 收尾：剔除中间产物，把成品导出到 桌面/Gobang auto/Meter engine-server ----
  // 【历史坑】这里原来是 `try { rmSync(...) } catch(e){}` —— 静默吞异常。
  // Windows 上删除「刚写完 / 刚被 postject 占用」的文件会抛 EPERM/EBUSY（杀软、索引器、
  // 残留进程都会造成），失败后没人知道，于是 engine.blob / sea-config.json /
  // engine-server.js 这些**只属于构建期**的东西跟着 copyDir 混进了发货目录。
  // 现在改为：删失败要报出来，并且导出时按「禁入名单」二次过滤（双保险）。
  // ★ 留档：删除前把自解密包装抄一份到 build-release/_lastwrap/ ——
  //   verify-release-enc.js 要从包装里拼回主密钥（密钥每次随机，包装是唯一来源）；
  //   暂存目录会被本次清理删掉、发布目录被禁入名单挡住，没有这份留档 verify 必 ENOENT
  //   （2026-09-25 实测踩过）。
  try {
    const lw = path.join(ROOT, 'build-release', '_lastwrap');
    fs.mkdirSync(lw, { recursive: true });
    fs.copyFileSync(path.join(projDir, 'engine-server.js'), path.join(lw, 'engine-server.js'));
  } catch (e) { log('[warn] engine-server.js 留档失败（verify-release-enc 将无法跑）: ' + e.message); }
  for (const p of [blobPath, seaCfg, path.join(projDir, 'engine-server.js')]) {
    try { fs.rmSync(p, { force: true }); }
    catch (e) { log('[warn] 中间产物删除失败（导出过滤会兜底）: ' + path.basename(p)); }
  }

  // 禁入名单：绝不随包发货
  const BANNED_PKG = new Set(['engine.blob', 'sea-config.json', 'engine-server.js']);
  let skipped = 0;
  const pkgFilter = (s, e) => {
    if (e.isDirectory()) return true;
    if (BANNED_PKG.has(e.name)) { skipped++; return false; }
    if (/\.(old|bak)$/i.test(e.name)) { skipped++; return false; }   // 旧 exe 备份这类残留
    return true;
  };

  // 直接导出到最终目录（覆盖旧版）。先清空目标，避免残留旧文件。
  // 旧发布包里的文件多为只读，必须用 forceRm 清掉只读位再删，否则 Windows 会 EPERM。
  forceRm(FINAL_DIR);
  copyDir(projDir, FINAL_DIR, pkgFilter);
  log('[out] 已导出发布目录 → ' + FINAL_DIR + (skipped ? '（按禁入名单过滤掉 ' + skipped + ' 个构建产物）' : ''));

  // ---- 6b. 硬校验：只信「复制完实际躺在磁盘上的东西」----
  // 上一步的返回值不可信（forceRm 内部是吞异常的），这里重新 stat 一遍。
  const bad = [];
  for (const f of ['engine.blob', 'sea-config.json', 'engine-server.js']) {
    if (fs.existsSync(path.join(FINAL_DIR, f))) bad.push(f);
  }
  for (const f of ['panel.html', 'panel-ui.js', 'bridge.js']) {   // 明文面板资源绝不入包
    if (fs.existsSync(path.join(FINAL_DIR, 'overlay', f))) bad.push('overlay/' + f + '（明文！）');
  }
  for (const f of fs.readdirSync(FINAL_DIR)) {
    if (/\.(old|bak)$/i.test(f)) bad.push(f + '（旧版残留）');
  }
  if (bad.length) {
    die('发布目录混入了不该出现的文件: ' + bad.join(', ') +
        '\n  多半是上一次构建的文件被进程占用删不掉 —— 关掉残留的 Web GomokuEngine.exe / ' +
        'Desktop GomokuOverlay.exe 后重跑');
  }
  log('[verify] 发布目录干净：无构建中间产物、无明文面板资源、无旧版残留');

  // ---- 7. 可选：打 zip（仅当显式 --zip）----
  if (DOZIP) {
    log('[zip] 打包 ...');
    const zipTool = path.join(__dirname, 'zip.js');
    const z = spawnSync(process.execPath, [zipTool, FINAL_DIR, OUTZIP], { encoding: 'utf8' });
    if (z.status !== 0) die('打包失败: ' + (z.stderr || z.stdout));
    log('[zip] ' + OUTZIP + '  ' + mb(fs.statSync(OUTZIP).size));
  }

  log('\n完成 ✓');
  log('  发布目录: ' + FINAL_DIR);
  if (DOZIP) log('  发布包:   ' + OUTZIP);
})().catch(e => die(e.stack || e.message));
