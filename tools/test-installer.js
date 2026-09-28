#!/usr/bin/env node
/**
 * tools/test-installer.js —— 安装包（Inno Setup .iss）回归护栏。
 *
 *   node tools/test-installer.js           # 静态检查（秒级，不动系统）
 *   node tools/test-installer.js --e2e     # 追加：静默安装 + 回读 + 卸载（约 1 分钟，会真写系统）
 *
 * 为什么要有这个文件：2026-09-22 用户两次报「三合一版快捷方式出错」，两次都是
 * Inno 脚本层的**运行期**错误（编译期全过），靠肉眼看 .iss 根本看不出来：
 *   ① CreateShellLink 被当成 Boolean 用（`if CreateShellLink(...) then`）→
 *      运行到该句抛 "Runtime error: Type Mismatch"，异常中断整个 CurStepChanged，
 *      结果桌面只出现第一个 .lnk、后两个没了。官方契约其实是：
 *      返回 String（实际 .lnk 路径），**失败抛异常**。
 *   ② 自定义勾选页挂在 wpInstalling 后面 → 页面在安装完成之后才弹，
 *      勾选来不及生效（三个 .lnk 必建），向导还报错。正确插入点是 wpReady。
 * 这两条都是**只有跑一遍才知道**的，所以这里既做静态断言（快、进 CI），
 * 也保留一条 --e2e 真跑（慢、能抓住上面这类只在运行期炸的问题）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SUITE_ISS = path.join(ROOT, 'installer', 'MeterGomokuSuite.iss');
const TRAINER_ISS = path.join(ROOT, 'installer', 'MeterGomokuTrainer.iss');
const E2E = process.argv.includes('--e2e');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

/** 剥掉 Pascal 脚本的注释（{ } / (* *) / //），且**不碰字符串字面量**里的 '{app}' 之类。
 *  必要性：本文件的注释里就写着反例（`if CreateShellLink(...) then`），
 *  不剥注释的话断言会去匹配自己的注释 —— 第一次写就踩了。 */
function stripCode(text) {
  let out = '', i = 0, mode = null, sq = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (sq) { out += c; if (c === "'") sq = false; i++; continue; }
    if (mode === 'brace') { if (c === '}') mode = null; i++; continue; }
    if (mode === 'paren') { if (c === '*' && n === ')') { mode = null; i += 2; continue; } i++; continue; }
    if (mode === 'slash') { if (c === '\n') mode = null; i++; continue; }
    if (c === "'") { sq = true; out += c; i++; continue; }
    if (c === '{') { mode = 'brace'; i++; continue; }
    if (c === '(' && n === '*') { mode = 'paren'; i += 2; continue; }
    if (c === '/' && n === '/') { mode = 'slash'; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
/** 取某 section 的正文（按行扫，锚行首，避免命中文件头注释里的同名提及）。
 *  注意别用带 m 标志的惰性正则：`m` 下 `$` 每行都成立，区段会当场收口成空串。 */
function section(text, name) {
  const out = [];
  let on = false;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\[([^\]]+)\]/);
    if (h) { on = h[1].trim().toLowerCase() === name.toLowerCase(); continue; }
    if (on) out.push(line);
  }
  return out.join('\n');
}
/** 按顶层逗号切分实参。 */
function splitArgs(s) {
  const out = []; let depth = 0, sq = false, cur = '';
  for (const ch of s) {
    if (sq) { cur += ch; if (ch === "'") sq = false; continue; }
    if (ch === "'") { sq = true; cur += ch; continue; }
    if ('(['.includes(ch)) depth++;
    if (')]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim());
}
/** 收集代码里所有 name(...) 调用的实参数组（跳过注释与字符串里的括号）。 */
function callArgs(code, name) {
  const res = [];
  const needle = name + '(';
  let idx = 0;
  while ((idx = code.indexOf(needle, idx)) !== -1) {
    let depth = 1, j = idx + needle.length, sq = false;
    while (j < code.length && depth > 0) {
      const ch = code[j];
      if (sq) { if (ch === "'") sq = false; }
      else if (ch === "'") sq = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      j++;
    }
    res.push(splitArgs(code.slice(idx + needle.length, j - 1)));
    idx = j;
  }
  return res;
}

// ============================================================================
// 一、静态护栏
// ============================================================================
console.log('[test-installer] 静态检查');
ok(fs.existsSync(SUITE_ISS), '三合一 .iss 存在');
ok(fs.existsSync(TRAINER_ISS), '独立版 .iss 存在');
const suite = read(SUITE_ISS);
const suiteCode = stripCode(section(suite, 'Code'));   // ★ 只在剥掉注释后的代码上做断言

// ---- 坑 ② 勾选页插入点：必须 wpReady，绝不能 wpInstalling ----
ok(/CreateCustomPage\(wpReady\s*,/.test(suiteCode), '勾选页挂在 wpReady 之后（安装开始前）',
  '曾用 wpInstalling → 页在安装完成后才弹，勾选不生效且向导报错');
ok(!/CreateCustomPage\(wpInstalling/.test(suiteCode), '没有把自定义页挂到 wpInstalling');

// ---- 坑 ① CreateShellLink 的返回值：String，不是 Boolean ----
ok(!/if\s+CreateShellLink\s*\(/.test(suiteCode),
  '没有把 CreateShellLink 当布尔用（`if CreateShellLink(...) then`）',
  '该写法运行期抛 Type Mismatch，且中断 CurStepChanged');
ok(/try[\s\S]{0,60}?Made\s*:=\s*MakeDesktopLink\(i\)/.test(suiteCode),
  'CurStepChanged 用 try/except 逐条包住建链（一个失败不带走后两个）');
ok(/except[\s\S]{0,200}?GetExceptionMessage/.test(suiteCode),
  '失败分支记录 GetExceptionMessage（失败会抛异常，不是返回错误串）');
ok(/Log\('desktop shortcut ok: index '/.test(suiteCode), '成功日志前缀稳定：desktop shortcut ok: index');

// ---- CreateShellLink 调用：8 个实参、Filename 带 .lnk、Icon 用对应 exe ----
const csl = callArgs(suiteCode, 'CreateShellLink');
ok(csl.length === 1, 'CreateShellLink 收在一处（MakeDesktopLink），实际 ' + csl.length + ' 处');
if (csl.length) {
  const a = csl[0];
  ok(a.length === 8, '传满 8 个实参（官方签名），实际 ' + a.length);
  ok(/\.lnk'/.test(a[0] || ''),
    'Filename 拼了 .lnk（不带扩展名会生成无扩展名裸文件，图标空白、双击打不开）');
  ok(a[5] === 'Exe', 'IconFilename 传对应 exe（每个快捷方式用自己 exe 的内嵌图标）');
  ok(/SW_SHOWNORMAL/.test(a[7] || ''), 'ShowCmd 用 SW_SHOWNORMAL');
}

// ---- 坑 ①' AddCheckBox 形参个数/类型（第 7 参是 Boolean ACheckWhenParentChecked）----
const acb = callArgs(suiteCode, 'AddCheckBox');
ok(acb.length === 3, '三个 AddCheckBox（训练器 / 桌面识别器 / 网页识别器），实际 ' + acb.length);
const acbBad = acb.map((a, i) => (a.length === 8 && /^(True|False)$/i.test(a[6]))
  ? null : '#' + i + ' 参=' + a.length + ' 第7参=' + a[6]).filter(Boolean);
ok(acbBad.length === 0,
  'AddCheckBox 全是 8 参、第 7 参为布尔（官方签名没有 AChildCount 这个参数）', acbBad.join(' | '));
ok(acb.length === 3 && acb.every((a) => (a[0] || '').includes('{cm:Sc')),
  '三个勾选项的标题都走 {cm:} 双语消息（索引 0/1/2 = 训练器/桌面识别器/网页识别器）');

// ---- 桌面 .lnk 必须进 [UninstallDelete]（否则卸载留下死快捷方式）----
const ud = section(suite, 'UninstallDelete');
for (const n of ['五子棋训练器.lnk', '桌面识别器.lnk', '网页识别器.lnk',
                 'Gomoku Trainer.lnk', 'Desktop Recognizer.lnk', 'Web Recognizer.lnk']) {
  ok(ud.includes(n), '[UninstallDelete] 列了桌面快捷方式：' + n);
}
ok(/\{autodesktop\}/.test(ud), '[UninstallDelete] 用 {autodesktop} 定位桌面');

// ---- 最小打包护栏（与 build-installer.js 的护栏一致，这里再静态兜一层）----
for (const [tag, text] of [['三合一', suite], ['独立版', read(TRAINER_ISS)]]) {
  const bad = text.split(/\r?\n/).filter((l) => /^Source\s*:/i.test(l.trim()))
    .filter((l) => /\.log\b|\.dmp\b|\\logs\\|GomokuTrainer resources/i.test(l));
  ok(bad.length === 0, tag + ' .iss 的 [Files] 无日志/运行期产物', bad.join(' | '));
}

// ---- 独立版：走 [Icons] + Tasks（卸载器自动跟踪），不许引入 CreateShellLink ----
const trainer = read(TRAINER_ISS);
ok(!/CreateShellLink/.test(trainer), '独立版不走 CreateShellLink（用 [Icons]，卸载可跟踪）');
ok(/^Name:\s*"\{autodesktop\}\\{cm:IconName}".*Tasks:\s*desktopicon/m.test(trainer),
  '独立版桌面快捷方式 = [Icons] + desktopicon 任务');

// ============================================================================
// 二、端到端（--e2e）：真装一遍再卸一遍
// ============================================================================
if (E2E) {
  const SETUP = path.join(ROOT, 'installer', 'out', 'Meter Gomoku Suite_Setup.exe');
  const APPDIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'Meter Gomoku Suite');
  const DESK = path.join(process.env.USERPROFILE, 'Desktop');
  const GROUP = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Meter Gomoku Suite');
  const LOG = path.join(os.tmpdir(), 'gb_suite_install.log');
  const ULOG = path.join(os.tmpdir(), 'gb_suite_uninstall.log');
  const WANT = [
    ['五子棋训练器.lnk', 'Desktop GomokuTrainer.exe'],
    ['桌面识别器.lnk', 'Desktop GomokuOverlay.exe'],
    ['网页识别器.lnk', 'Web GomokuEngine.exe'],
  ];
  const ALL_LNK = WANT.map((w) => w[0]).concat(['Gomoku Trainer.lnk', 'Desktop Recognizer.lnk', 'Web Recognizer.lnk']);
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const waitGone = (p, t) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (!fs.existsSync(p)) return true; sleep(400); } return !fs.existsSync(p); };
  const lnkInfo = (f) => {
    if (!fs.existsSync(f)) return null;
    const buf = fs.readFileSync(f);
    const ascii = buf.toString('latin1'), u16 = buf.toString('utf16le');
    return { size: buf.length, magic: buf.length > 4 && buf.readUInt32LE(0) === 0x4C,
             has: (n) => ascii.includes(n) || u16.includes(n) };
  };

  console.log('\n[test-installer] 端到端（静默安装 → 回读 → 卸载）');
  ok(fs.existsSync(SETUP), '安装包已生成（先跑 node tools/build-installer.js --suite）');

  const unins = path.join(APPDIR, 'unins000.exe');
  if (fs.existsSync(unins)) {
    spawnSync(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { encoding: 'utf8', windowsHide: true });
    ok(waitGone(APPDIR, 30000), '旧安装已卸载');
  }
  for (const n of ALL_LNK) { const p = path.join(DESK, n); if (fs.existsSync(p)) fs.unlinkSync(p); }

  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  const r = spawnSync(SETUP, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LANG=zh', '/LOG=' + LOG],
    { encoding: 'utf8', windowsHide: true });
  ok(r.status === 0, '静默安装 exit=0', 'status=' + r.status);
  ok(fs.existsSync(APPDIR), '安装目录已创建');

  for (const [name, exe] of WANT) {
    const info = lnkInfo(path.join(DESK, name));
    ok(!!info, '桌面快捷方式存在：' + name);
    if (!info) continue;
    ok(info.magic, name + ' 是真 .lnk');
    ok(info.has(exe), name + ' 指向 ' + exe);
  }
  for (const bare of ['五子棋训练器', '桌面识别器', '网页识别器']) {
    ok(!fs.existsSync(path.join(DESK, bare)), '没有无扩展名的裸文件：' + bare);
  }
  ok(fs.existsSync(GROUP) && fs.readdirSync(GROUP).length === 4, '开始菜单组 4 项（三程序 + 卸载）');
  ok(!fs.existsSync(path.join(APPDIR, 'logs')) && !fs.existsSync(path.join(APPDIR, 'GomokuTrainer resources')),
    '安装目录无运行期产物（最小打包）');

  if (fs.existsSync(LOG)) {
    const text = read(LOG);
    ok((text.match(/desktop shortcut ok:/g) || []).length === 3,
      '日志 3 条 "desktop shortcut ok"（静默 = 三个都建）');
    ok(!/desktop shortcut (FAILED|skipped)/.test(text), '日志无 FAILED / skipped');
    ok(!/raised an exception|Runtime error/i.test(text), '★ 日志无运行期异常（Type Mismatch 回归护栏）');
  } else ok(false, '安装日志存在');

  if (fs.existsSync(ULOG)) fs.unlinkSync(ULOG);
  if (fs.existsSync(unins)) {
    spawnSync(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + ULOG],
      { encoding: 'utf8', windowsHide: true });
    ok(waitGone(APPDIR, 30000), '卸载后安装目录已删除');
  } else ok(false, '找到 unins000.exe');
  for (const [name] of WANT) ok(!fs.existsSync(path.join(DESK, name)), '卸载后桌面 .lnk 已清掉：' + name);
}

console.log('\n[test-installer] ===== ' + pass + ' passed, ' + fail + ' failed' +
  (E2E ? '' : '（静态；加 --e2e 跑真装/卸载）') + ' =====');
process.exit(fail ? 1 : 0);
