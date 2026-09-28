// 批量跑离线测试套件（在 PortableGit shim 缺 ls/head/tail 的环境下用 node 自己调度）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const toolsDir = __dirname;

// 离线套件（不需要真实 exe / 不需要 8964 端口）
const OFFLINE = [
  'test-color-guard',
  'test-side',
  'test-eval',
  'test-perspective',
  'test-evalcurve',
  'test-live-fixes',
  'test-obfuscator',
  'test-obf-roundtrip',
  'test-e2e-five',
  'test-terminal-five',
  'test-opening-side',
  'test-opp-rings',
  'test-anchor',
  'test-m1-finish',
  'test-cross-game',
  'test-gomocalc-align',
  'test-recognize-adaptive',
  'test-screen-board',
  // ★ 2026-09-20 补进套件：识别服务已从「随包 Python + OpenCV」换成自包含的 C++ 单文件
  //   GomokuVision.exe（官方 OpenCV，core/imgproc/imgcodecs 静态链接，零依赖，发布包因此
  //   少了 193MB）。上面两条测的是**Python 参考实现**（仓库保留、只用于开发期对拍），
  //   真正守住「对外发布的那份实现」的是下面这两条：
  //   · test-vision-service —— C++ 源码契约（移植时最怕把防护分支丢了）+ 产物契约 +
  //     发布包「不许再有 python/」+ 现场截图离线端到端；
  //   · test-vision-parity —— 预防针矩阵 A~J 逐子对拍（C++ vs Python 参考），全离线。
  'test-vision-service',
  'test-vision-parity',
  // ★ 2026-09-18 补进套件：拟真「光泽棋子」基准（五林五子棋现场截图）。
  //   这种棋子没有清晰的边，白子在亮木底上的对比一路渐隐到 0，而木纹盘的全局阈值
  //   thr≈71 > 白子内部最大偏离 49 —— 只靠全局阈值白子会整颗消失，靠的是「逐格中位数」。
  //   基准自测把「结果对」和「机理没退（余量 2.8 倍）」一起钉住。
  'test-wulin-gloss',
  // 桌面覆盖层：纯源码/文本契约，不需要起进程
  'test-side-buttons',
  // 桌面覆盖层：直角弹窗 / 屏幕指导层（蓝圈+热力块）/ 绝不自动落子 —— 源码契约护栏
  'test-guide-layer',
  // 桌面覆盖层：真实 Edge 无头加载 panel.html 走行为级断言（临时端口，不碰 8964/8971）
  'test-desktop-controls',
  // 桌面覆盖层：「局面」键点击 → openPos → 宿主开窗 的端到端。
  // ★ 2026-09-18 补进套件：它一直躺在 tools/ 外面没人跑，而且老版本只断言「.click() 后
  //   有没有发出 openPos」—— 而 .click() 是程序化调用，**绕过命中测试**，按钮被裁到视口外
  //   照样绿。用户「局面点不动」查了两轮没结论，就是因为这条假绿。现在它同时断言
  //   elementFromPoint 命中与视口可见性，并且跟套件一起跑。
  'test-openpos-click',
  // 五子棋练习器（第三个 EXE）：宿主契约 + 真实 Edge 加载 calc.html 的 UI 冒烟
  'test-calculator',
];
// 需要真实 exe 的套件（串行跑，各自负责清干净自己起的进程）
const LIVE = [
  'test-live-semantics',
  'test-parallel-lanes',
  'test-release',
  // 桌面覆盖层（会起 GomokuOverlay.exe + 依赖的 8964/8971，taskkill /T 整树回收）
  'test-backend-no-browser',
  'test-overlay-isolation',
  'test-overlay-panel-pos',
  // 桌面覆盖层：局面小窗的**像素级**回归（截图 + 分带统计，四轮：不透明 / 空盘 / 25% / 深色）。
  // ★ 2026-09-17 补进套件：这条本来是漏在外面的 —— 于是「测试底色被角框压在下面、
  //   定位被带到 y=1、截图整体裁偏 79px」这个真 bug 在外头红了好几轮，每次收尾跑
  //   _runall 都是绿的，谁也没发现。现在它跟着套件一起跑，红就是红。
  'test-overlay-pos-render',
  // 桌面覆盖层：「局面」小窗的**真实报文**端到端护栏（假识别服务 + 真 exe + 真剪贴板）。
  // ★ 2026-09-18 补进套件：ParseStonesForPos 死抠 `"black":[`（json.dumps 的冒号后有空格的
  //   报文匹配不上）→ 局面小窗恒空盘，而面板/引擎全正常，只有这条链路零覆盖。
  //   它顺带钉住「复制代码只复制总代码」。
  'test-pos-stones',
  'test-overlay-smoke',
  // 五子棋练习器：复盘**独立窗口**（用户 2026-09-19 的三条要求）。
  //   A 源码契约 —— `?rv=1` 那条启动路径不碰设置 / 存档 / 停靠栏 / 引擎档位；
  //   B 真实 Edge 加载 calc.html?rv=1 —— 主窗口那一套全收起、只留一行复盘键、
  //     **零引擎请求**、用户能自行落子、连珠处出现**天蓝标线**、背诵 / 回顾各自走通；
  //   C 真实 exe 端到端 —— 真开出 class=GbCalcReview 的顶层窗口、真投递局面并收到回执、
  //     「保存局面」真走系统「另存为」（测试里用 GB_TEST_SAVE_PNG 指路，不弹框）并落盘成 PNG。
  // ★ 与其它 LIVE 套件不同：它**不要求 :8964 空闲** —— 训练器发现已有引擎就复用、
  //   没有就自己起一个，而它只回收「本次新起」的那个。放在 LIVE 末尾，
  //   这样万一没回收干净也只影响下一次全量，不会污染别的套件。
  'test-trainer-review',
  // 五子棋练习器：历史（导出 / 导入 txt、改名、右键菜单）—— 用户 2026-09-19 要求。
  //   A 源码契约 —— txt 行格式（`#` 注释 + `<名字>\t<局面代码>`）、宿主必须**严格**解码
  //     JSON 字符串（简易版会把换行变成字母 n、制表符变成字母 t，导出的文件直接废掉）；
  //   C 真实 exe 端到端 —— GB_TEST_HIST_ROUNDTRIP=1：页面塞两局（带名字）→ 导出（宿主走
  //     「另存为」，被 GB_TEST_SAVE_TXT 接管、真写盘）→ 宿主回 testHistNowImport →
  //     页面把**同一个文件**读回来导入；判据包含「文件里的制表符/换行是真字符」
  //     与「回执指纹与文件内容逐字对上」——只看局数是抓不到内容被改坏的。
  //   与 test-trainer-review 一样**不要求 :8964 空闲**（只回收本次新起的引擎）。
  'test-trainer-history',
];
// 需要「已有一个引擎在 :8964 上跑」的套件（与上面 LIVE 相反：LIVE 要求 8964 **空闲**）。
// 故意不并进套件自动跑，否则会把「引擎必须空闲」这条不变量弄脏 —— 想验证热力分流/及时性时单独跑：
//   node tools/test-heat-lane.js     并行两条车道的墙钟对比（sub 先回、总耗时≈max 而非 sum）
//   node tools/test-heat-live.js     无头浏览器里的热力格/分数/档位/不压子
const SKIP_LIVE = !!process.env.GB_SKIP_LIVE;

let totalPass = 0, totalFail = 0;
const failed = [];

function run(name) {
  const file = path.join(toolsDir, name + '.js');
  if (!fs.existsSync(file)) { console.log(`-- ${name}: (不存在，跳过)`.padEnd(64) + 'SKIP'); return; }
  const r = spawnSync(NODE, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  // 各套件汇总格式不统一，逐个尝试：
  //   "ALL PASS — 26 passed, 0 failed"       (test-color-guard / test-side / test-eval)
  //   "--- 69 passed, 0 failed ---"          (test-evalcurve / test-obfuscator / test-obf-roundtrip)
  //   "test-live-fixes: 64 passed, 0 failed  (total 64)"
  //   "--- 65/65  bookmarklet bytes=228303"  (test-release 用 通过/总数 形式)
  //   "60 passed, 2 failed"                  (裸汇总)
  let pass = 0, fail = 0, found = false;
  let m;
  if ((m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/))) { pass = +m[1]; fail = +m[2]; found = true; }
  else if ((m = out.match(/---\s+(\d+)\/(\d+)\s/)))        { pass = +m[1]; fail = +m[2] - +m[1]; found = true; }
  // ✓/✗ 计数兜底（没有汇总行时自己数）
  if (!found) {
    const ok = (out.match(/^\s*(PASS|✓)/gm) || []).length;
    const no = (out.match(/^\s*(FAIL|✗)/gm) || []).length;
    if (ok + no > 0) { pass = ok; fail = no; found = true; }
  }
  const allPass = fail === 0 && found && r.status === 0;
  totalPass += pass; totalFail += fail;
  if (!allPass) failed.push(`${name} (${pass}/${pass + fail}, exit=${r.status})`);
  console.log(`== ${name}`.padEnd(36) + (allPass ? 'ALL PASS' : 'FAILED').padEnd(12) + `${pass} passed, ${fail} failed`);
  if (!allPass) {
    out.split('\n').filter(l => /FAIL|Error:|✗/.test(l)).slice(0, 8).forEach(l => console.log('     ' + l.trim()));
  }
}

console.log('--- 离线套件 ---');
OFFLINE.forEach(run);
console.log('--- 真实 exe 套件（需 8964 空闲）---');
if (SKIP_LIVE) console.log('(已跳过：GB_SKIP_LIVE=1 —— 本次只跑离线套件)');
else LIVE.forEach(run);

console.log('\n==================================================');
console.log(`总计: ${totalPass} passed, ${totalFail} failed`);
if (failed.length) { console.log('未通过: ' + failed.join(', ')); process.exit(1); }
console.log('全部套件通过 ✓');
