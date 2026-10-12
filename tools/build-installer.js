#!/usr/bin/env node
/**
 * build-installer.js —— 用 Inno Setup 打安装包。
 *
 *   node tools/build-installer.js              # 两个都打（推荐）
 *   node tools/build-installer.js --trainer    # 只打独立版（单训练器）
 *   node tools/build-installer.js --suite      # 只打三合一版
 *   node tools/build-installer.js --assistant  # 只打单桌面版助手（第三版本）
 *
 * 三个版本的 ISS（都在 installer/ 下，各自独立，互不影响）：
 *   ① MeterGomokuTrainer.iss  → installer/out/Meter GomokuTrainer_Setup.exe
 *        源 = 项目根「Meter GomokuTrainer」目录（独立版，页面内 AI + 自带 rapfi）
 *        快捷方式：「Meter 五子棋」（用户 2026-09-21 指定，勿改）
 *   ② MeterGomokuSuite.iss    → installer/out/Meter Gomoku Suite_Setup.exe
 *        源 = 项目根「Meter engine-server」目录（三合一：训练器 + 桌面识别器 + 网页识别器）
 *        快捷方式：五子棋训练器 / 桌面识别器 / 网页识别器（中文模式），
 *        安装最后一页让用户勾选保留哪些（默认三个全勾，都能取消）。
 *   ③ MeterGomokuAssistant.iss → installer/out/Meter GomokuAssistant_Setup.exe
 *        源 = 项目根「Meter GomokuAssistant」目录（2026-10-03 第三版本：单桌面版助手，
 *        GB_ASSISTANT_STANDALONE 单硬 C++ 连接，引擎+视觉+模型全随包）
 *        快捷方式：「Meter 五子棋助手」。
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
    // ★ 2026-10-02 跟上 #95/#110：视觉 exe+dll 成对在 Vision\ 子目录（顶层已不再放）
    // ★ 2026-10-02 整理：ISS 也装 User Guide.txt（英文手册），一并进护栏。
    mustHave: ['Desktop GomokuTrainer.exe', '使用说明.txt', 'User Guide.txt',
               path.join('Vision', 'GomokuVision.exe')],   // ★ 2026-10-05 训练器恢复老版静态识别（无 DLL，宿主回落 exe 链路）
    mustHaveDirs: [path.join('calc'), path.join('rapfi-native')],   // 2026-09-25：独立版走原生 Rapfi，resources/ 已废除
    uiDirs: [path.join('calc')],            // 这些目录里必须有 .enc（否则宿主起来黑屏）
  },
  {
    key: 'suite',
    iss: path.join(ROOT, 'installer', 'MeterGomokuSuite.iss'),
    srcDir: path.join(ROOT, 'Meter engine-server'),
    outName: 'Meter Gomoku Suite_Setup.exe',
    // ★ 2026-10-02 夜：ISS 的 [Files] 引用了 README_zh/en.md，但 sync-overlay.js 对「完整套装」
    //   会主动删掉这两个 md（视为夹带文件），删完没人补回来 → ISCC 报 "Source file does not exist"
    //   直接编译失败。所以这里把它们列进 mustHave，让护栏二提前拦下（而不是打到一半才炸）。
    mustHave: ['Desktop GomokuTrainer.exe', 'Desktop GomokuOverlay.exe', 'Web GomokuEngine.exe',
               '使用说明.txt', 'User Guide.txt', 'README_zh.md', 'README_en.md',
               path.join('Vision', 'GomokuVision.exe')],   // ★ 2026-10-05 训练器恢复老版静态识别（无 DLL，宿主回落 exe 链路）
    mustHaveDirs: [path.join('calc'), path.join('overlay'), path.join('resources'),
                   path.join('rapfi-native')],   // 2026-09-25：三合一版原生主路径 + WASM 兜底并存
    uiDirs: [path.join('calc'), path.join('overlay')],
  },
  {
    key: 'assistant',
    iss: path.join(ROOT, 'installer', 'MeterGomokuAssistant.iss'),
    srcDir: path.join(ROOT, 'Meter GomokuAssistant'),
    outName: 'Meter GomokuAssistant_Setup.exe',
    // 2026-10-03 第三版本：单桌面版助手（单硬 C++ 连接，引擎调度全面 C++ 化 ——
    // 无 Web GomokuEngine；引擎模型/视觉模型/中英手册/许可声明全随包）
    mustHave: ['Desktop GomokuAssistant.exe', '使用手册.txt', 'User Guide.txt',
               '开源许可与版权声明.txt', 'LICENSES & COPYRIGHT NOTICES.txt',
               path.join('Vision', 'GomokuVision.exe')],   // ★ 2026-10-05 训练器恢复老版静态识别（无 DLL，宿主回落 exe 链路）
    mustHaveDirs: [path.join('overlay'), path.join('rapfi-native')],
    uiDirs: [path.join('overlay')],
    // Node 调度器模式已废除：目录里混入 Web GomokuEngine.exe 直接判死
    mustNotHave: ['Web GomokuEngine.exe', 'README_zh.md', 'README_en.md'],
    // 助手宿主是 overlay 工程，新鲜度对照 desktop-overlay 的源码
    freshnessSrc: ['desktop-overlay/src', 'desktop-overlay/ui'],
    freshnessExe: 'Desktop GomokuAssistant.exe',
    // 单机版身份守断：宿主 exe 必须是 --standalone 编译的（含独有日志字符串）
    identityProbe: { exe: 'Desktop GomokuAssistant.exe', must: 'unknown engine route' },
  },
];

// ---- 参数 -------------------------------------------------------------------
const argv = process.argv.slice(2);
let picked = TARGETS;
if (argv.includes('--trainer')) picked = TARGETS.filter((t) => t.key === 'trainer');
else if (argv.includes('--suite')) picked = TARGETS.filter((t) => t.key === 'suite');
else if (argv.includes('--assistant')) picked = TARGETS.filter((t) => t.key === 'assistant');

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

/** UI / 宿主源码里最新的一处 mtime —— 用来判断发布目录里的 exe 是不是旧货。
 *  ★ 2026-10-03：支持按 target 指定源目录（assistant = desktop-overlay 工程）。 */
function newestSourceMtime(relDirs) {
  let newest = 0, name = '';
  for (const rel of (relDirs || ['desktop-calculator/ui', 'desktop-calculator/src'])) {
    const d = path.join(ROOT, rel);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      // ★ `_` 前缀是本项目的临时件约定（_heat_live.html 测试挂具、_screen_shot.py…），
      //   不随包发布 —— 不该拿来判「发布 exe 是旧货」（2026-10-03 实测误挡 suite 打包）。
      if (f.startsWith('_')) continue;
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
  // ★ 护栏二b（2026-10-03，assistant）：废除模式残留判死（Node 调度器 / 旧 README）
  if (t.mustNotHave) {
    const stale = t.mustNotHave.filter((f) => fs.existsSync(path.join(t.srcDir, f)));
    if (stale.length) {
      console.error('[installer] ! 发布目录存在已废除模式的残留文件：' + stale.join(', '));
      console.error('            删掉后重跑 node tools/build-assistant-release.js');
      process.exit(1);
    }
  }
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

  // ★ 护栏四（2026-10-02 事故守断）：训练器 exe 内嵌「下载页身份」必须与目录身份一致。
  //   kUpdateShareUrl 是编译期常量（GB_SUITE_ENGINE 分支，2026-09-30 用户定案两个版本
  //   各用各的蓝奏云地址）；把 suite 构建的 exe 拷进单训练器发布目录 → 用户在独立版里
  //   点「检查更新」看到的是三件套下载页（本次事故的根源就是一次无校验的手工拷贝）。
  {
    const SUITE_URL = 'b016l4d3id', TRAINER_URL = 'b016l49aqj';
    const exePath = path.join(t.srcDir, 'Desktop GomokuTrainer.exe');
    if (fs.existsSync(exePath)) {
      const buf = fs.readFileSync(exePath);
      const want = t.key === 'suite' ? SUITE_URL : TRAINER_URL;
      const forbid = t.key === 'suite' ? TRAINER_URL : SUITE_URL;
      if (!buf.includes(want) || buf.includes(forbid)) {
        console.error('[installer] ! ' + path.basename(t.srcDir) + '/Desktop GomokuTrainer.exe 的下载页身份不对：');
        console.error('            应内嵌 ' + want + (buf.includes(forbid) ? '，实际混入了 ' + forbid : '，但该串不存在'));
        console.error('            这个 exe 是另一版本（suite/独立）的构建 —— 重新构建正确宏的宿主再拷。');
        process.exit(1);
      }
      console.log('[installer] ✓ exe 下载页身份 = ' + want);
    }
  }

  // ★ 护栏五（2026-10-03，assistant）：单机版宿主 exe 必须是 --standalone 编译的。
  //   把三件套的 Desktop GomokuOverlay.exe 改名拷进来这类「假单机版」在这里现形 ——
  //   它没有引擎随宿主生死的 job 语义，装出去就是「重启连接失效」复发版。
  if (t.identityProbe) {
    const exePath = path.join(t.srcDir, t.identityProbe.exe);
    if (fs.existsSync(exePath)) {
      const buf = fs.readFileSync(exePath);
      if (!buf.includes(t.identityProbe.must)) {
        console.error('[installer] ! ' + t.identityProbe.exe + ' 不含单机版编译指纹（' +
                      t.identityProbe.must + '）—— 这不是 --standalone 构建的宿主。');
        console.error('            重跑：bash tools/build-overlay-msvc.sh --standalone && node tools/build-assistant-release.js');
        process.exit(1);
      }
      console.log('[installer] ✓ 单机版编译指纹在位');
    }
  }

  // ★ 护栏三：新鲜度 —— 发布目录里的 exe 不能比 UI/宿主源码旧
  const ns = newestSourceMtime(t.freshnessSrc);
  const anyExe = path.join(t.srcDir, t.freshnessExe || t.mustHave[0]);
  if (ns.mtime > fs.statSync(anyExe).mtimeMs + 60000) {
    console.error('[installer] ! 警告：' + ns.name + ' 比发布目录里的 exe 还新，');
    console.error('            现在打的包会是旧代码。先跑对应的 build-* --publish。');
    process.exit(1);
  }

  // ★ 护栏一：不许打日志
  if (!assertNoLogsInIss(t.iss)) process.exit(1);

  console.log('[installer] 源目录：' + path.relative(ROOT, t.srcDir));
  console.log('[installer] 编译器：' + iscc);
  // ★ 2026-10-02：spawnSync 偶发 EBUSY（exit null，本机环境病：cl/tasklist/netstat 同症）——
  //   失败先重试两次再判死，别把环境抖动当成编译失败。
  let r = null;
  for (let attempt = 1; attempt <= 3; ++attempt) {
    r = spawnSync(iscc, [t.iss], { encoding: 'buffer' });
    if (r.status !== null) break;
    console.log('[installer] ISCC spawn 中断（exit null，第 ' + attempt + ' 次）—— 重试…');
  }
  const text = (r.stdout || Buffer.alloc(0)).toString('utf8') + (r.stderr || Buffer.alloc(0)).toString('utf8');
  if (r.status !== 0) {
    console.error(text);
    if (r.status === null) {
      console.error('[installer] ISCC 连续 spawn 失败（exit null = 本机 spawnSync EBUSY 环境病，');
      console.error('            cl.exe/tasklist/cmd 同症）。绕过法：bash 直调 ISCC（已验证可用）：');
      console.error('            "' + iscc + '" "' + t.iss.replace(/\//g, '/') + '"');
    }
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
