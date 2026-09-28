#!/usr/bin/env node
/**
 * 回归护栏：五子棋练习器的**历史**功能（导出 / 导入 txt、改名、右键菜单）。
 *
 * 用户 2026-09-19 的原话：
 *   「历史记录中的历史可以导出导入通过 txt 中的代码，以及可以让用户自己更改某条历史的名字，
 *     就比如说用户选择了某个历史，右击了鼠标，可以有一个选择栏，里面有删除、重命名等一些功能；
 *     一定要记住，如果用户还没有选择历史，直接打开复盘，就没有背诵复盘这几个功能键，
 *     就只有重来、保存局面和关闭这三个按钮」
 *
 * 这个文件专管「历史 + txt」那一条链路，分两段：
 *   A. 源码契约 —— txt 的行格式（`#` 注释 + `<名字>\t<局面代码>`）、宿主必须**严格解码**
 *      JSON 字符串（否则换行会变成字母 n、制表符变成字母 t，导出的文件直接废掉）、
 *      两个窗口都认 saveTxt / openTxt、改名与右键菜单的接线；
 *   C. 真实 exe 端到端（GB_TEST_HIST_ROUNDTRIP=1）——
 *      页面塞两局（带名字）→ 导出（宿主弹「另存为」，被 GB_TEST_SAVE_TXT 接管并**真写盘**）
 *      → 宿主回 testHistNowImport → 页面把**同一个文件**读回来导入。
 *      判据：① 文件里每行是「名字<TAB>代码」，制表符与换行都是**真字符**；
 *            ② 日志里 [hist] txt written / [hist] txt read 都在；
 *            ③ 页面回执 [hist] imported n=2 fp=… 与文件内容逐字对上
 *               （只对局数是不够的：内容被改坏时局数照样是 2）。
 *
 * 用法：node tools/test-trainer-history.js
 *   GB_RV_EXE="Desktop version/Desktop GomokuTrainer.exe" node tools/test-trainer-history.js
 *     → 验发布版（发布目录的 exe 与 calc/ 另有一套路径，是最容易「本地对、发布错」的地方）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = process.env.GB_RV_EXE
  ? path.resolve(ROOT, process.env.GB_RV_EXE)
  : path.join(ROOT, 'desktop-calculator', 'build', 'Desktop GomokuTrainer.exe');
const UI_DIR = path.join(ROOT, 'desktop-calculator', 'ui');
const HOST_CPP = path.join(ROOT, 'desktop-calculator', 'src', 'host.cpp');
const LOG = path.join(os.tmpdir(), 'GomokuTrainer.log');
const TMP_TXT = path.join(os.tmpdir(), 'gb-hist-roundtrip-' + process.pid + '.txt');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ A. 源码契约
console.log('== A. 历史 txt 的格式与宿主解码（源码契约）==');
const JS = fs.readFileSync(path.join(UI_DIR, 'calc.js'), 'utf8');
const HTML = fs.readFileSync(path.join(UI_DIR, 'calc.html'), 'utf8');
const HOST = fs.readFileSync(HOST_CPP, 'utf8');
// SaveTxtFromPage 那一段：判据只在这段里查（JsonStrAfter 在 base64 的 PNG 那边仍然合法）
const SAVE_TXT_SEG = HOST.slice(HOST.indexOf('static TxtSaveResult SaveTxtFromPage'),
                                HOST.indexOf('static std::string ReadTxtMessage'));

ok('txt 头是「#」注释（人打开文件能看懂格式），正文一行一局',
  /var HIST_TXT_HEAD =/.test(JS) &&
  /'# 五子棋练习器 · 历史导出 v1\\n'/.test(JS) &&
  /'# 每行一局：<名字>\\\\t<局面代码>/.test(JS) &&
  /if \(!line \|\| \/\^\\s\*#\/\.test\(line\)\) continue;/.test(JS));
ok('★ 名字与局面代码之间是**真 TAB**（名字里出现字母+数字也不会被当成着法）',
  /return nm \+ '\\t' \+ movesToCode\(h && h\.moves\);/.test(JS) &&
  /var tab = line\.indexOf\('\\t'\);/.test(JS) &&
  /if \(tab >= 0\) \{ name = line\.slice\(0, tab\)\.trim\(\); code = line\.slice\(tab \+ 1\); \}/.test(JS));
// ★ 关键：宿主不能拿 JsonStrAfter（「见到反斜杠就跳过」那个简易版）去取 txt ——
//   它会把 "\n" 变成字母 n、"\t" 变成字母 t，导出的文件就成了一整行「名字t代码」。
//   所以 txt 的负载必须走 JsonStrAfterDecoded（\n \t \r \" \\ \/ \uXXXX 一律真还原）。
//   （判据只取 SaveTxtFromPage 那一段 —— JsonStrAfter 在别处（base64 的 PNG）仍然合法。）
ok('★ 宿主用**严格** JSON 解码取 txt（简易版会把 \\n 变成字母 n、\\t 变成字母 t）',
  /static std::string JsonStrAfterDecoded\(const std::string& s, const char\* key\)/.test(HOST) &&
  /case 'n':  o \+= '\\n'; break;/.test(HOST) &&
  /case 't':  o \+= '\\t'; break;/.test(HOST) &&
  /case 'u': \{/.test(HOST) &&
  /static void AppendUtf8ForCodePoint\(std::string& o, unsigned cp\)/.test(HOST) &&
  // SaveTxtFromPage 用的是严格版，而且**不是**简易版
  /std::string data = JsonStrAfterDecoded\(s, "\\"data\\":"\);/.test(SAVE_TXT_SEG) &&
  !/JsonStrAfter\(s, "\\"data\\":"\)/.test(SAVE_TXT_SEG) &&
  /std::string name = JsonStrAfterDecoded\(s, "\\"name\\":"\);/.test(SAVE_TXT_SEG));
ok('导出落盘是 UTF-8 + BOM（中文记事本才认得出编码）',
  /const unsigned char bom\[3\] = \{ 0xEF, 0xBB, 0xBF \};/.test(HOST) &&
  /fwrite\(bom, 1, sizeof\(bom\), f\);/.test(HOST) &&
  // 页面解析时要把 BOM 去掉，否则第一条的代码会被 BOM 挡坏
  /replace\(\/\^\\uFEFF\/, ''\)/.test(JS));
ok('两个窗口（主窗 + 复盘窗）都认 saveTxt / openTxt',
  (HOST.match(/s\.find\("\\"saveTxt\\""\)/g) || []).length >= 2 &&
  (HOST.match(/s\.find\("\\"openTxt\\""\)/g) || []).length >= 2 &&
  /static void PostToOwner\(HWND owner, const std::string& json\) \{/.test(HOST));
ok('★ 改名：name 字段 + 行内输入框（回车存 / Esc 撤），空名字就删掉字段',
  /function renameRecord\(idx, val\) \{/.test(JS) &&
  /if \(nm\) list\[idx\]\.name = nm; else delete list\[idx\]\.name;/.test(JS) &&
  /function beginRename\(idx\) \{/.test(JS) &&
  /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); settle\(true\); \}/.test(JS) &&
  /else if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); settle\(false\); \}/.test(JS));
ok('★ 右键菜单：删除 / 重命名 / 打开复盘 / 导出这一局 / 存入「保存历史」',
  /<div id="ctxMenu" class="ctx" hidden><\/div>/.test(HTML) &&
  /function showCtx\(ev, idx\) \{/.test(JS) &&
  /d\.oncontextmenu = function \(e\) \{/.test(JS) &&
  /\[T\('ctxDel'\), true, function \(\) \{ deleteIndexes\(\[idx\]\); \}\]/.test(JS) &&
  /\[T\('ctxRename'\), false, function \(\) \{ beginRename\(idx\); \}\]/.test(JS) &&
  // 宿主侧默认右键菜单是关掉的（所以必须自绘）
  /put_AreDefaultContextMenusEnabled\(FALSE\)/.test(HOST));
ok('★ 「没选历史 → 复盘窗只有 重来 / 保存局面（+ 历史）」这条分流没被历史功能改动',
  /var fromHist = !!\(rec && rec\.hist\) && mv\.length > 0;/.test(JS) &&
  /if \(els\.rvGroup\) els\.rvGroup\.hidden = !\(fromHist \|\| egFirst \|\| egLen > 0\);/.test(JS) &&
  // 「历史 / 重来 / 保存局面」这三个是常驻键，#rvGroup 之外的；★十八轮「关闭」键已删
  HTML.indexOf('id="btn_redo_rv"') > HTML.indexOf('id="rvGroup"') &&
  HTML.indexOf('id="btn_rv_hist"') > HTML.indexOf('id="rvGroup"') &&
  HTML.indexOf('id="btn_save_rv"') > HTML.indexOf('id="rvGroup"') &&
  !/id="btn_rv_close"/.test(HTML));
// ★ 廿三轮（用户要求）：残局记录打开历史 → 第一眼就是**还没有额外落子前**的残局布局
ok('★ 残局记录投到复盘窗时 eg/egLen/vc 必须一起带过去（否则第一眼是空盘、背诵从第一颗子开始）',
  /eg: !!\(h && h\.eg\), egLen: \(h && h\.egLen\) \|\| 0, vc: !!\(h && h\.vc\),/.test(JS) &&
  /var egLen = \(rec && rec\.eg && rec\.egLen > 0\) \? Math\.min\(rec\.egLen, mv\.length\) : 0;/.test(JS) &&
  /if \(egFirst \|\| egLen > 0\) \{/.test(JS));

// ============================================================ C. 真实 exe 端到端
function pidsOf(name) {
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8' }).stdout || '';
    const a = [];
    for (const line of out.split(/\r?\n/)) {
      const mm = line.match(new RegExp('^"' + name.replace('.', '\\.') + '","(\\d+)"', 'i'));
      if (mm) a.push(Number(mm[1]));
    }
    return a;
  } catch (e) { return []; }
}
function killExe() { spawnSync('taskkill', ['/IM', 'Desktop GomokuTrainer.exe', '/F', '/T'], { stdio: 'ignore' }); }
function portPid(port) {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
    const re = new RegExp(':' + port + '(?!\\d)');
    for (const line of out.split(/\r?\n/)) {
      if (!re.test(line) || !/LISTENING/i.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) return Number(pid);
    }
  } catch (e) {}
  return 0;
}
function tailLog(from) {
  try { return fs.readFileSync(LOG).slice(from).toString('utf8'); } catch (e) { return ''; }
}

async function runRoundTrip() {
  console.log('== C. 真实 exe 端到端（历史导出成 txt → 再把同一个文件导入回来）==');
  if (!fs.existsSync(EXE)) { ok('找到 Desktop GomokuTrainer.exe', false, EXE); return; }
  ok('找到 Desktop GomokuTrainer.exe', true, path.relative(ROOT, EXE));

  killExe();
  await sleep(600);
  try { fs.unlinkSync(TMP_TXT); } catch (e) {}

  let from = 0;
  try { from = fs.statSync(LOG).size; } catch (e) { from = 0; }
  const engineBefore = portPid(8964);

  const child = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, {
      GB_TEST_HIST_ROUNDTRIP: '1',   // 让页面塞两条历史并导出
      GB_TEST_SAVE_TXT: TMP_TXT,     // 「另存为」不弹框，直接写这个路径
      GB_TEST_OPEN_TXT: TMP_TXT,     // 「打开」也不弹框，直接读这个路径
    }),
  });
  child.unref();

  // WebView2 首帧偶发 LAUNCH_FAILED → 宿主自愈重启（~23s）；不许死等固定秒数，轮询到判据为止。
  let log = '', written = null, readBack = false, imported = null;
  for (let i = 0; i < 150; i++) {
    await sleep(500);
    log = tailLog(from);
    const wm = log.match(/\[hist\] txt written: ([^\r\n(]+)\((\d+) bytes, (\d+) games\)/);
    if (wm) written = { path: wm[1].trim(), bytes: +wm[2], games: +wm[3] };
    readBack = readBack || /\[hist\] txt read: /.test(log);
    const im = log.match(/\[hist\] imported n=(\d+) fp=([^\r\n]*)/);
    if (im) imported = { n: +im[1], fp: im[2].trim() };
    if (imported) break;
  }

  ok('宿主页面侧钩子生效（要求页面把历史导出成 txt）',
    /\[hist\] test hook: asked the page to export the history as txt/.test(log));
  ok('★ 导出真的走「另存为」链路并写盘（[hist] txt written，2 局）',
    !!written && written.games === 2,
    written ? written.bytes + ' bytes · ' + written.games + ' games' : '(日志里没有 [hist] txt written)');

  // ---- ① 文件内容：真 TAB、真换行、BOM ----
  let raw = '', lines = [], body = [];
  if (written) {
    try { raw = fs.readFileSync(TMP_TXT, 'utf8'); } catch (e) {}
    ok('★ 落盘的 txt 带 UTF-8 BOM（中文记事本不乱码）', raw.charCodeAt(0) === 0xFEFF,
      '0x' + raw.charCodeAt(0).toString(16));
    const noBom = raw.replace(/^\uFEFF/, '');
    lines = noBom.split('\n');
    body = lines.filter((l) => l && l.charAt(0) !== '#');
    const c0 = (body[0] || '').split('\t');
    const c1 = (body[1] || '').split('\t');
    ok('★ 每行是「名字<TAB>局面代码」——制表符与换行都是**真字符**（严格解码的护栏）',
      body.length === 2 && c0.length === 2 && c1.length === 2 &&
      c0[0] === '导出样本A' && c0[1] === 'h8i8h7i7h6i6h5i5h4' &&
      c1[0] === '' && c1[1] === 'a15b15a14',
      body.length === 2 ? JSON.stringify(body) : ('正文行=' + body.length + ' raw=' + noBom.slice(0, 90)));
    ok('头几行是可读的格式说明（# 注释），不是被压成一行的乱码',
      /^# 五子棋练习器/.test(lines[0]) && /^# 每行一局/.test(lines[1]) && lines.length >= 4,
      lines.length + ' 行');
  }

  // ---- ② 读回来 → 入库 ----
  ok('★ 宿主把同一个 txt 读回来了（[hist] txt read）', readBack, readBack ? '' : '(日志里没有 [hist] txt read)');
  ok('★ 页面把读回来的内容**解析入库**并回执（[hist] imported n=2）',
    !!imported && imported.n === 2,
    imported ? 'n=' + imported.n : '(日志里没有 [hist] imported)');
  ok('★ 回执里的指纹与文件内容逐字对上（名字 + 局面代码都活着，不只是局数对）',
    !!imported && imported.fp === '导出样本A=h8i8h7i7h6i6h5i5h4 | =a15b15a14',
    imported ? imported.fp : '(无回执)');

  try { child.kill(); } catch (e) {}
  killExe();
  await sleep(400);
  ok('收尾：实例已清干净', pidsOf('Desktop GomokuTrainer.exe').length === 0);
  const engineAfter = portPid(8964);
  if (!engineBefore && engineAfter) {
    try { spawnSync('taskkill', ['/PID', String(engineAfter), '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(500);
  }
  ok('收尾：本次新起的引擎已回收（起跑前 :8964 ' +
     (engineBefore ? '已有 pid=' + engineBefore + '，不碰它' : '空闲') + '）',
    !(!engineBefore && portPid(8964)),
    engineBefore ? '' : (portPid(8964) ? '仍然占着 ' + portPid(8964) : '已空闲'));
  try { fs.unlinkSync(TMP_TXT); } catch (e) {}
}

(async () => {
  await runRoundTrip();
  console.log('\n== test-trainer-history: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
})();
