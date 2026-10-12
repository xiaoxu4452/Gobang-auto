#!/usr/bin/env node
/**
 * build-assistant-release.js —— 组装第三版本「单桌面版五子棋助手」发布目录。
 *
 *   node tools/build-assistant-release.js
 *
 * 定位（2026-10-03，用户定案）：借鉴单训练器的发布方案，把桌面助手独立成一个
 * 完整的第三个产品「Meter GomokuAssistant」：
 *   · 单硬 C++ 连接（GB_ASSISTANT_STANDALONE，见 host.cpp 头注释）—— 不像三件套
 *     那样还得分路线（8970/8971/8972/8973 收养道别），也不走 Web GomokuEngine
 *     （Node SEA 调度器）模式：**引擎调度全部 C++ 化**，宿主直接持有 RapfiEngine
 *     原生进程（stdio 管道 + job 随宿主生死），视觉同样直接持有 GomokuVision.exe；
 *   · 引擎模型（rapfi-native\ 五变体 + 权重）与视觉模型（Vision\ 成对）全随包适配；
 *   · 文档 = 中英两份论文式手册 + 中英开源许可与版权声明（2026-10-03 用户定案，
 *     不再带 overlay 的 README_zh/en）。
 *
 * 本脚本**不编译**任何东西 —— 它在所有构件就绪之后做「组装 + 硬校验」，正确顺序：
 *   1. bash tools/build-overlay-msvc.sh --standalone          # 助手宿主 exe（C++ 调度）
 *   2. node tools/encrypt-overlay-ui.js                       # 面板 .enc
 *   3. bash tools/build-vision-msvc.sh                        # 视觉组件（如源码动过）
 *   4. node tools/build-assistant-release.js                  # 本脚本
 *   5. node tools/build-installer.js --assistant              # 安装包
 *
 * 硬校验（打了坏包立刻死，绝不带病出货）：
 *   · 助手 exe 必须比 host.cpp 新 + 必须内嵌单机版编译指纹（unknown engine route）；
 *   · Vision exe/dll 必须比 desktop-vision/src 最新源码新；
 *   · 单机版**禁止**出现 Web GomokuEngine.exe（Node 调度器模式已废除，见上）；
 *   · overlay/ 至少 3 个 .enc、明文一个不许有；
 *   · rapfi-native 必须含 avx512vnni 变体（官方五变体的锚点）；
 *   · 四份文档齐备（使用手册 ×2 + 许可声明 ×2）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_HOST = path.join(ROOT, 'desktop-overlay', 'src', 'host.cpp');
const BUILD_OV = path.join(ROOT, 'desktop-overlay', 'build');
const BUILD_VIS = path.join(ROOT, 'desktop-vision', 'build');
const OUT = path.join(ROOT, 'Meter GomokuAssistant');

function die(m) { process.stderr.write('ERROR: ' + m + '\n'); process.exit(1); }
function log(m) { process.stdout.write(m + '\n'); }
function mb(n) { return (n / 1024 / 1024).toFixed(1) + 'MB'; }

function copyFile(a, b) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  let lastErr = null;
  for (let i = 0; i < 60; i++) {
    try { fs.copyFileSync(a, b); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (!/EBUSY|EPERM|EACCES/i.test(e.code || e.message)) break;
      const until = Date.now() + 500;
      while (Date.now() < until) { /* 忙等 0.5s */ }
    }
  }
  if (lastErr) throw lastErr;
  try { fs.chmodSync(b, 0o666); } catch (e) {}
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

function newestMtime(dir, exts) {
  let newest = 0, name = '';
  for (const f of fs.readdirSync(dir)) {
    if (!exts.some((e) => f.endsWith(e))) continue;
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (m > newest) { newest = m; name = f; }
  }
  return { mtime: newest, name };
}

// ============================================================ 1. 助手宿主 exe
log('== 1/5 助手宿主 Desktop GomokuAssistant.exe ==');
const hostExe = path.join(BUILD_OV, 'Desktop GomokuAssistant.exe');
if (!fs.existsSync(hostExe)) {
  die('缺少 ' + hostExe + '\n  先跑：bash tools/build-overlay-msvc.sh --standalone');
}
const hostSrcM = fs.statSync(SRC_HOST).mtimeMs;
if (hostSrcM > fs.statSync(hostExe).mtimeMs + 60000) {
  die('Desktop GomokuAssistant.exe 比 host.cpp 旧 —— 重跑：bash tools/build-overlay-msvc.sh --standalone');
}
// 单机版身份守断：exe 里必须内嵌 GB_ASSISTANT_STANDALONE 分支独有的日志字符串
//（编译期宏的产物指纹 —— 拷错成三件套版 exe 在这里现形）。
const hostBuf = fs.readFileSync(hostExe);
if (!hostBuf.includes('unknown engine route')) {
  die('Desktop GomokuAssistant.exe 不含单机版编译指纹（unknown engine route）——\n' +
      '  这是三件套版的 exe，重跑：bash tools/build-overlay-msvc.sh --standalone');
}
log('[ok] 助手宿主 ' + mb(hostBuf.length) + '，单机版编译指纹在位');

// ============================================================ 2. 视觉组件
log('== 2/5 视觉 Vision/GomokuVision.exe + dll ==');
const visExe = path.join(BUILD_VIS, 'GomokuVision.exe');
const visDll = path.join(BUILD_VIS, 'GomokuVision.dll');
if (!fs.existsSync(visExe)) die('缺少 GomokuVision.exe —— 先跑 node tools/build-vision.js');
if (!fs.existsSync(visDll)) die('缺少 GomokuVision.dll —— 先跑 bash tools/build-vision-msvc.sh');
const visSrc = newestMtime(path.join(ROOT, 'desktop-vision', 'src'), ['.cpp', '.h']);
if (visSrc.mtime > fs.statSync(visExe).mtimeMs + 60000) {
  die('GomokuVision.exe 比源码旧（最新源文件 ' + visSrc.name + '）—— 重跑视觉构建');
}
if (visSrc.mtime > fs.statSync(visDll).mtimeMs + 60000) {
  die('GomokuVision.dll 比源码旧（最新源文件 ' + visSrc.name + '）—— 重跑视觉构建');
}
log('[ok] 视觉组件新鲜度通过（exe ' + mb(fs.statSync(visExe).size) +
    ' / dll ' + mb(fs.statSync(visDll).size) + '）');

// ============================================================ 3. 文档（中英手册 ×2 + 许可声明 ×2）
log('== 3/5 文档（使用手册 ×2 + 开源许可与版权 ×2）==');
const DOCS = ['使用手册.txt', 'User Guide.txt', '开源许可与版权声明.txt', 'LICENSES & COPYRIGHT NOTICES.txt'];
for (const d of DOCS) {
  if (!fs.existsSync(path.join(ROOT, 'tools', 'assistant-docs', d))) {
    die('缺文档源 tools/assistant-docs/' + d);
  }
}
log('[ok] 四份文档源齐备（tools/assistant-docs/）');

// ============================================================ 4. 组装发布目录
log('== 4/5 组装 ' + path.basename(OUT) + ' ==');
fs.mkdirSync(OUT, { recursive: true });
copyFile(hostExe, path.join(OUT, 'Desktop GomokuAssistant.exe'));

// 引擎模型：rapfi-native 全变体 + 权重（引擎调度 C++ 化后，这就是随包的全部引擎形态）
const natSrc = path.join(ROOT, 'Meter GomokuTrainer', 'rapfi-native');
if (!fs.existsSync(path.join(natSrc, 'RapfiEngine-avx512vnni.exe'))) {
  die('rapfi-native 缺 avx512vnni 变体（查 Meter GomokuTrainer/rapfi-native）');
}
copyDir(natSrc, path.join(OUT, 'rapfi-native'));

// 视觉组件：exe+dll 成对进 Vision\ 子目录（宿主 EnsureScanServer 第一优先布局）
copyFile(visExe, path.join(OUT, 'Vision', 'GomokuVision.exe'));
copyFile(visDll, path.join(OUT, 'Vision', 'GomokuVision.dll'));

// 面板 UI：只带 .enc 密文
const uiSrc = path.join(ROOT, 'desktop-overlay', 'ui');
const ovDst = path.join(OUT, 'overlay');
fs.mkdirSync(ovDst, { recursive: true });
let nEnc = 0;
for (const f of fs.readdirSync(uiSrc)) {
  if (/\.(html|js|css)\.enc$/i.test(f)) { copyFile(path.join(uiSrc, f), path.join(ovDst, f)); nEnc++; }
}
if (nEnc < 3) die('overlay/ 密文不足（' + nEnc + ' < 3）—— 先跑 tools/encrypt-overlay-ui.js');
// 明文绝不入库
for (const f of fs.readdirSync(ovDst)) {
  if (/\.(html|js|css)$/i.test(f) && !f.endsWith('.enc')) {
    try { fs.rmSync(path.join(ovDst, f), { force: true }); } catch (e) {}
    die('overlay/ 里出现明文 ' + f + ' —— 已删除，请检查来源后重跑');
  }
}
// 文档（中英手册 + 中英许可）
for (const d of DOCS) copyFile(path.join(ROOT, 'tools', 'assistant-docs', d), path.join(OUT, d));

// ============================================================ 5. 硬校验落盘结果
log('== 5/5 硬校验 ==');
const mustHave = [
  'Desktop GomokuAssistant.exe',
  path.join('Vision', 'GomokuVision.exe'), path.join('Vision', 'GomokuVision.dll'),
].concat(DOCS);
for (const f of mustHave) {
  if (!fs.existsSync(path.join(OUT, f))) die('组装后缺文件：' + f);
}
for (const f of fs.readdirSync(path.join(OUT, 'overlay'))) {
  if (/\.(html|js|css)$/i.test(f) && !f.endsWith('.enc')) die('overlay/ 明文残留：' + f);
}
const natDst = path.join(OUT, 'rapfi-native');
const natN = fs.readdirSync(natDst).length;
if (natN < 10) die('rapfi-native 只有 ' + natN + ' 个文件（五变体+权重应 >10）—— 拷贝不完整');
// ★ Node 调度器模式已废除：单机版目录里出现 Web GomokuEngine.exe = 旧模式残留，判死
if (fs.existsSync(path.join(OUT, 'Web GomokuEngine.exe'))) {
  die('发布目录出现 Web GomokuEngine.exe —— 单机版已废除 Node 调度器模式（引擎调度 C++ 化），删掉它');
}
// 中间产物禁入
for (const f of fs.readdirSync(OUT)) {
  if (/\.(old|bak|blob)$/i.test(f) || f === 'sea-config.json' || f === 'engine-server.js') {
    die('发布目录混入构建产物：' + f);
  }
}
let total = 0;
for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  total += st.isDirectory() ? 0 : st.size;
}
log('[ok] 全部硬校验通过');
log('[out] ' + OUT + '  （顶层文件 ' + mb(total) + ' + rapfi-native ' + natN + ' 件 + overlay 密文 ×' + nEnc + '）');
log('下一步：node tools/build-installer.js --assistant');
