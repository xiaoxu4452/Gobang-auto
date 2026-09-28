#!/usr/bin/env node
/**
 * build-installer.js —— 用 Inno Setup 打安装包。
 *
 *   node tools/build-installer.js              # 两个都打（推荐）
 *   node tools/build-installer.js --trainer    # 只打独立版（单训练器）
 *   node tools/build-installer.js --suite      # 只打三合一版
 *
 * 两个版本的 ISS（都在 installer/ 下，各自独立，互不影响）：
 *   ① MeterGomokuTrainer.iss  → installer/out/Meter GomokuTrainer_Setup.exe
 *        源 = 项目根「Meter GomokuTrainer」目录（独立版，页面内 AI + 自带 rapfi）
 *        快捷方式：「Meter 五子棋」（用户 2026-09-21 指定，勿改）
 *   ② MeterGomokuSuite.iss    → installer/out/Meter Gomoku Suite_Setup.exe
 *        源 = 项目根「Desktop version」目录（三合一：训练器 + 桌面识别器 + 网页识别器）
 *        快捷方式：五子棋训练器 / 桌面识别器 / 网页识别器（中文模式），
 *        安装最后一页让用户勾选保留哪些（默认三个全勾，都能取消）。
 *
 * 定位：build-calculator.js / build-release.js 只负责把 exe/UI/模型铺进发布目录，
 * 安装包是**在发布目录之上**的第二次封装。所以正确顺序是：
 *     node tools/build-calculator.js --publish     # 独立版发布目录
 *     node tools/build-release.js --publish        # 三件套（Desktop version / Meter engine-server）
 *     node tools/build-calculator.js --suite --publish   # 三件套的练习器（GB_SUITE_ENGINE）
 *     node tools/build-installer.js                # 最后打两个安装包
 * 本脚本不会自己重建发布目录 —— 拿旧发布目录打包会得到「新界面壳 + 旧代码」的包，
 * 这正是过去踩过的坑，所以这里只做**校验 + 护栏**（见下面 3 条 guard）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// ---- 目标定义：一个版本一条 -------------------------------------------------
const TARGETS = [
  {
    key: 'trainer',
    iss: path.join(ROOT, 'installer', 'MeterGomokuTrainer.iss'),
    srcDir: path.join(ROOT, 'Meter GomokuTrainer'),
    outName: 'Meter GomokuTrainer_Setup.exe',
    // 该版本包里必须存在的关键文件（缺了就别打，打了也是坏包）
    mustHave: ['Desktop GomokuTrainer.exe', 'GomokuVision.exe', '使用说明.txt'],
    mustHaveDirs: [path.join('calc'), path.join('rapfi-native')],   // 2026-09-25：独立版走原生 Rapfi，resources/ 已废除
    uiDirs: [path.join('calc')],            // 这些目录里必须有 .enc（否则宿主起来黑屏）
  },
  {
    key: 'suite',
    iss: path.join(ROOT, 'installer', 'MeterGomokuSuite.iss'),
    srcDir: path.join(ROOT, 'Meter engine-server'),
    outName: 'Meter Gomoku Suite_Setup.exe',
    mustHave: ['Desktop GomokuTrainer.exe', 'Desktop GomokuOverlay.exe', 'Web GomokuEngine.exe',
               'GomokuVision.exe', '使用说明.txt'],
    mustHaveDirs: [path.join('calc'), path.join('overlay'), path.join('resources'),
                   path.join('rapfi-native')],   // 2026-09-25：三合一版原生主路径 + WASM 兜底并存
    uiDirs: [path.join('calc'), path.join('overlay')],
  },
];

// ---- 参数 -------------------------------------------------------------------
const argv = process.argv.slice(2);
let picked = TARGETS;
if (argv.includes('--trainer')) picked = TARGETS.filter((t) => t.key === 'trainer');
else if (argv.includes('--suite')) picked = TARGETS.filter((t) => t.key === 'suite');

// ---- 找 ISCC -----------------------------------------------------------------
const ISCC_CANDIDATES = [
  process.env.ISCC || '',
  'C:/Program Files/Inno Setup 7/ISCC.exe',
  'C:/Program Files (x86)/Inno Setup 7/ISCC.exe',
  'C:/Program Files/Inno Setup 6/ISCC.exe',
  'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
].filter(Boolean);
const iscc = ISCC_CANDIDATES.find((f) => fs.existsSync(f));
if (!iscc) {
  console.error('[installer] 找不到 ISCC.exe —— 需要安装 Inno Setup（6 或 7），');
  console.error('            或用环境变量 ISCC 指定完整路径。');
  process.exit(1);
}

/** UI / 宿主源码里最新的一处 mtime —— 用来判断发布目录里的 exe 是不是旧货。 */
function newestSourceMtime() {
  let newest = 0, name = '';
  for (const rel of ['desktop-calculator/ui', 'desktop-calculator/src']) {
    const d = path.join(ROOT, rel);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (/\.(cpp|h|rc|js|html|css)$/i.test(f)) {
        const m = fs.statSync(path.join(d, f)).mtimeMs;
        if (m > newest) { newest = m; name = rel + '/' + f; }
      }
    }
  }
  return { mtime: newest, name };
}

/**
 * ★ 护栏一：ISS 的 [Files] 里**不许出现任何日志**（用户 2026-09-22 明确要求）。
 *   命中 *.log / logs\ / GomokuTrainer resources 之类运行期产物就直接拒绝打包 ——
 *   这类文件体积大又毫无意义，混进安装包是最常见的「包越打越大」来源。
 */
function assertNoLogsInIss(issPath) {
  const text = fs.readFileSync(issPath, 'utf8');
  const bad = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!/^Source\s*:/i.test(t)) continue;                 // 只看 [Files] 的 Source 行
    if (/\.log\b|\.dmp\b|\\logs\\|[\\/]logs\b|GomokuTrainer resources/i.test(t)) bad.push(t);
  }
  if (bad.length) {
    console.error('[installer] ! ' + path.basename(issPath) + ' 的 [Files] 里出现了日志/运行期产物：');
    for (const b of bad) console.error('            ' + b);
    console.error('            「最小打包」原则：日志、缓存、dump 一律不得进安装包。');
    return false;
  }
  return true;
}

const results = [];

for (const t of picked) {
  console.log('\n[installer] ===== ' + t.key + ' =====');
  if (!fs.existsSync(t.iss)) { console.error('[installer] 缺安装脚本：' + t.iss); process.exit(1); }
  if (!fs.existsSync(t.srcDir)) {
    console.error('[installer] 发布目录不存在：' + t.srcDir);
    process.exit(1);
  }

  // ★ 护栏二：关键文件齐不齐（缺 GomokuVision / 缺 resources 都别打）
  const missing = [];
  for (const f of t.mustHave) if (!fs.existsSync(path.join(t.srcDir, f))) missing.push(f);
  for (const d of t.mustHaveDirs) if (!fs.existsSync(path.join(t.srcDir, d))) missing.push(d + path.sep);
  // 加密 UI 至少要有一个 .enc（只有 UI 目录要查；resources/ 里是 rapfi 模型，没有 .enc）
  for (const d of (t.uiDirs || [])) {
    const abs = path.join(t.srcDir, d);
    if (!fs.existsSync(abs)) continue;
    const encs = fs.readdirSync(abs).filter((f) => f.endsWith('.enc'));
    if (encs.length === 0) missing.push(d + path.sep + '*.enc');
  }
  if (missing.length) {
    console.error('[installer] 发布目录还没就绪（' + t.srcDir + '），缺：');
    for (const m of missing) console.error('            ' + m);
    console.error('            先跑：node tools/build-calculator.js --publish（独立版）');
    console.error('            或：  node tools/build-release.js --publish 等三件套序列');
    process.exit(1);
  }

  // ★ 护栏三：新鲜度 —— 发布目录里的 exe 不能比 UI/宿主源码旧
  const ns = newestSourceMtime();
  const anyExe = path.join(t.srcDir, t.mustHave[0]);
  if (ns.mtime > fs.statSync(anyExe).mtimeMs + 60000) {
    console.error('[installer] ! 警告：' + ns.name + ' 比发布目录里的 exe 还新，');
    console.error('            现在打的包会是旧代码。先跑对应的 build-* --publish。');
    process.exit(1);
  }

  // ★ 护栏一：不许打日志
  if (!assertNoLogsInIss(t.iss)) process.exit(1);

  console.log('[installer] 源目录：' + path.relative(ROOT, t.srcDir));
  console.log('[installer] 编译器：' + iscc);
  const r = spawnSync(iscc, [t.iss], { encoding: 'buffer' });
  const text = (r.stdout || Buffer.alloc(0)).toString('utf8') + (r.stderr || Buffer.alloc(0)).toString('utf8');
  if (r.status !== 0) {
    console.error(text);
    console.error('[installer] 编译失败（exit ' + r.status + '）');
    process.exit(1);
  }
  const out = path.join(ROOT, 'installer', 'out', t.outName);
  if (!fs.existsSync(out)) {
    console.error('[installer] 编译结束但没有产物：' + out);
    process.exit(1);
  }
  const buf = fs.readFileSync(out);
  const mb = (buf.length / 1048576).toFixed(1);
  console.log('[installer] ✓ ' + out);
  console.log('[installer]   ' + mb + ' MB   SHA256 ' +
    crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + '…');
  results.push({ name: t.outName, mb });
}

console.log('\n[installer] 完成 ' + results.length + ' 个安装包：');
for (const r of results) console.log('            ' + r.name + '  ' + r.mb + ' MB');
