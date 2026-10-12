#!/usr/bin/env node
/**
 * test-standalone-assistant.js —— 第三版本「单桌面版五子棋助手」守断测试。
 *
 *   node tools/test-standalone-assistant.js
 *
 * 2026-10-03 用户定案：借鉴单训练器，单机版助手用「更激进且完美的单硬 C++ 连接」——
 * 不像三件套那样分路线（收养/道别/皮带），引擎随宿主生、随宿主死。本测试守四道关：
 *   ① host.cpp 的 GB_ASSISTANT_STANDALONE 语义：引擎进 job、不收养、不道别、退出显式收尸；
 *   ② 构建脚本：--standalone 必须真的传 /DGB_ASSISTANT_STANDALONE 且产物名正确；
 *   ③ 发布目录 Meter GomokuAssistant：引擎/视觉/模型/UI 全随包且新鲜；
 *   ④ 安装脚本：AppId 独立、卸载清引擎、升级清旧货。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function rd(...p) { return fs.readFileSync(path.join(ROOT, ...p), 'utf8'); }

const HOST = rd('desktop-overlay', 'src', 'host.cpp');
// 面板产物（生成自 tools/extract-panel-ui.js）—— 用于断言「已下线的键确实不在面板里」
const PANEL = rd('desktop-overlay', 'ui', 'panel.html');
const BLD_SH = rd('tools', 'build-overlay-msvc.sh');
const BLD_JS = rd('tools', 'build-overlay.js');
const ASM = rd('tools', 'build-assistant-release.js');
const ISS = rd('installer', 'MeterGomokuAssistant.iss');

// == ① host.cpp：单机版语义（激进单硬连接） ==
console.log('== ① host.cpp GB_ASSISTANT_STANDALONE 语义 ==');
ok('引擎拉起：单机版 intoJob=true（KILL_ON_JOB_CLOSE 随宿主生死），三件套保持 false + GB_PARENT_PID',
  /#ifdef GB_ASSISTANT_STANDALONE\r?\n  g_engineProc = SpawnDetachedOwned\(exe, L"--as-backend", root, \/\*intoJob=\*\/true\);/.test(HOST) &&
  /#else\r?\n  SetEnvironmentVariableW\(L"GB_PARENT_PID"[\s\S]{0,140}SpawnDetachedOwned\(exe, L"--as-backend", root, \/\*intoJob=\*\/false\);/.test(HOST));
ok('孤儿引擎：单机版不过户不收养（没有 /api/adopt POST），三件套才有收养',
  /#ifdef GB_ASSISTANT_STANDALONE\r?\n {8}\/\/ 单机版：不过户、不收养[\s\S]{0,400}#else[\s\S]*?\/api\/adopt/.test(HOST));
ok('道别：单机版 NotifyEngineHostBye 直接 return（引擎随 job 走，无需 hostbye）',
  /static void NotifyEngineHostBye\(\) \{\r?\n#ifdef GB_ASSISTANT_STANDALONE[\s\S]{0,200}return;[\s\S]{0,80}#else/.test(HOST));
ok('退出收尸：单机版 KillOwnedDeps 调 nativeeng::ShutdownAllEngines（stdin EOF 优雅落盘 → 强杀兜底 → job 收漏网）',
  /#ifdef GB_ASSISTANT_STANDALONE[\s\S]{0,300}nativeeng::ShutdownAllEngines\(\);/.test(HOST) &&
  /if \(e\.hStdin\) \{ CloseHandle\(e\.hStdin\); e\.hStdin = nullptr; \} {2}\/\/ EOF → 正常退出（落盘 DB）/.test(HOST));
ok('三件套语义未被破坏：#else 分支保留收养 POST + hostbye + 只关句柄不杀',
  /HttpPost\(8964, L"\/api\/adopt", body\)/.test(HOST) &&
  /HttpRequest\(8964, L"POST", L"\/api\/hostbye"/.test(HOST) &&
  /#else\r?\n {2}\/\/ 三件套：引擎\*\*只关句柄不杀\*\*/.test(HOST));
ok('识别服务不受影响：vision 仍走默认 intoJob（崩溃路径 job 兜底）',
  /g_scanProc = SpawnDetachedOwned\(exe, L"--scan", cwd\);/.test(HOST));

// == ①b C++ 原生引擎桥（nativeeng 移植：调度全面 C++ 化，零 Node 零 TCP） ==
console.log('== ①b host.cpp nativeeng 引擎桥 ==');
ok('nativeeng 命名空间在位：五变体 ISA 探测 + 300ms 冒烟 + CPU 指纹缓存 + 自动降档',
  /namespace nativeeng \{[\s\S]{0,4000}CpuFingerprint[\s\S]*SmokeVariantOk[\s\S]*\.variant-ok/.test(HOST) &&
  /"avx512vnni", "avxvnni", "avx512", "avx2", "sse"/.test(HOST) &&
  /\.variant-ok/.test(HOST) && /0xC000001D[\s\S]{0,200}已自动降档/.test(HOST));
ok('跨机降档黑名单单调化（防「缺运行库时在变体间无限翻转」）：容器只增不删 + 耗尽即锁死',
  /static std::vector<std::string> g_badVariants;/.test(HOST) &&
  /static bool IsBadVariant\(const std::string& v\)/.test(HOST) &&
  /MarkBadVariant\(failed\)/.test(HOST) &&
  /if \(g_exhausted\) return;/.test(HOST) &&
  /g_exhausted = true;/.test(HOST) &&
  /Visual C\+\+ Redistributable x64/.test(HOST) &&
  // 旧实现是单字符串 g_badVariant（后写覆盖先写）——必须已不存在
  !/static std::string g_badVariant;/.test(HOST));
ok('兜底变体不污染缓存：冒烟未过就不写 .variant-ok，下次冷启动重新探测',
  /static bool g_smokePassed = false;/.test(HOST) &&
  /if \(g_smokePassed\) \{\s*\n\s*FILE\* f = _wfopen/.test(HOST) &&
  /所有变体冒烟均未通过/.test(HOST) &&
  /g_smokePassed = true;\s*\/\/ 缓存里是上次真跑通的结论/.test(HOST));
ok('reset 路由 = 自助恢复口（清黑名单 + 解锁 + 重挑），装完运行库无需重装软件',
  /static bool RespawnFresh\(int idx\)/.test(HOST) &&
  /ResetBadVariants\(\);\s*\n\s*g_exhausted = false;/.test(HOST) &&
  /route == "reset"[\s\S]{0,200}nativeeng::RespawnFresh\(idx\)/.test(HOST));
ok('引擎车道直系 spawn（stdio 管道 + CREATE_SUSPENDED 语义的 job 挂靠 + 代际号读线程）',
  /STARTF_USESTDHANDLES/.test(HOST) && /AssignProcessToJobObject\(jb, pi\.hProcess\)/.test(HOST) &&
  /std::thread\(ReaderThread, idx, outR, myGen\)\.detach\(\);/.test(HOST));
ok('引擎退出双保险：stdin EOF 优雅落盘 + 800ms 强杀 + KILL_ON_JOB_CLOSE 兜底',
  /ShutdownAllEngines[\s\S]{0,400}CloseHandle\(e\.hStdin\)[\s\S]{0,200}WaitForSingleObject\(e\.hProcess, 800\)[\s\S]{0,120}TerminateProcess\(e\.hProcess, 0\)/.test(HOST));
ok('/engine/* 进程内路由：cmd 原子 ensure+write / out 游标拉取 / status 变体与诊断',
  /route == "cmd"[\s\S]{0,200}WriteEnsured/.test(HOST) &&
  /route == "out"[\s\S]{0,200}Poll\(idx, since\)/.test(HOST) &&
  /available/.test(HOST) && /memMB/.test(HOST) && /diag/.test(HOST));
ok('ResHandler 拦截 /engine/*（gb.local 进程内直达，零 TCP）+ panel.html 注入 GB_STANDALONE/GB_NO_WASM',
  /upath\.rfind\(L"\/engine\/", 0\) == 0/.test(HOST) &&
  /var GB_STANDALONE=true;var GB_NO_WASM=true;/.test(HOST));
ok('单机版 EnsureEngine 整段不参与 ：8964（无 Web GomokuEngine 调度器）',
  /static void EnsureEngine\(\) \{\r?\n#ifdef GB_ASSISTANT_STANDALONE\r?\n {2}\/\/ 单机版：没有 Web GomokuEngine 调度器[\s\S]{0,200}return;/.test(HOST));

// == ①c 面板侧原生客户端（bridge.js NATENG：与 :8964/ws op 同形换传输） ==
console.log('== ①c bridge.js NATENG 客户端 ==');
const BRIDGE = rd('desktop-overlay', 'ui', 'bridge.js');
ok('wsCall 换传输不换逻辑：STANDALONE 时走 NATENG（analyze/balance/health 同形）',
  /var STANDALONE = \(typeof GB_STANDALONE !== 'undefined'\) && !!GB_STANDALONE;/.test(BRIDGE) &&
  /function wsCall\(api, body, timeoutMs\) \{\r?\n {4}if \(STANDALONE\) return natEng\(\)\.call\(api, body, timeoutMs\);/.test(BRIDGE));
ok('YXBOARD 黑先严格交替 + side-to-move 十六轮对齐（与 engine-server 同源）',
  /function toEngineMoveList\(board, moveList, side\)/.test(BRIDGE) &&
  /function applySideToMove\(out, side\)/.test(BRIDGE));
ok('SHOW_DETAIL PV 解析移植（MESSAGE (n) 文本着法行号 1 基顶原点的铁律）',
  /MESSAGE \(n\) 文本着法行号 1 基顶原点的铁律/.test(BRIDGE) &&
  /charCodeAt\(0\) - 65, \(\+mc\[2\]\) - 1/.test(BRIDGE));
ok('平衡选点：官方 YXBALANCEONE/TWO + YXBLOCK 迭代（零自造算法）',
  /function doBalance\(body, lane\)/.test(BRIDGE) &&
  /'YXBALANCETWO ' : 'YXBALANCEONE '/.test(BRIDGE) && /YXBLOCKRESET/.test(BRIDGE));
ok('跨机稳定：boot 走 /engine/status 诊断、失败给人话（diag 直达面板）',
  /function bootAll\(\)[\s\S]{0,600}engStatus\(\)[\s\S]{0,300}st\.diag/.test(BRIDGE));
ok('反复开关稳定：bootAll 失败必复位 booting（一次失败不再永久失效）',
  /booting = booting\.catch\(function \(err\) \{[\s\S]{0,400}booting = null;/.test(BRIDGE) &&
  /LANES\.main\.ready = false; LANES\.sub\.ready = false; LANES\.fwd\.ready = false;/.test(BRIDGE));
ok('反复开关稳定：inSearch 成功/失败两出口都复位（不卡死抢占）',
  /lane\.inSearch = false;\s*\/\/ ★ 失败出口同样复位/.test(BRIDGE) &&
  /\}, function \(err\) \{\s*\n\s*lane\.inSearch = false;/.test(BRIDGE));
ok('反复开关稳定：车道代际切换清缓冲（引擎重启后旧输出不污染新搜索）',
  /wasAlive === false && lane\.alive === true\)[\s\S]{0,400}lane\.outBuf = '';/.test(BRIDGE) &&
  /lane\.ready = false;/.test(BRIDGE) &&
  /var genAtStart = lane\.gen;/.test(BRIDGE));
ok('反复开关稳定：串行队列同类合并（狂点功能键不排长队），被取代者返回 superseded 而非崩',
  /function serialMerge\(lane, key, action\)/.test(BRIDGE) &&
  /run = serialMerge\(lane, 'analyze'/.test(BRIDGE) &&
  /run = serialMerge\(lane, 'balance'/.test(BRIDGE) &&
  /superseded: true, candidates: \[\], best: null/.test(BRIDGE) &&
  (BRIDGE.match(/res && res\.superseded/g) || []).length >= 1);
ok('合并范围按车道区分：main 交互车道跨类型合并，sub/fwd 后台并行通道只合并同 key',
  /var crossTypes = \(lane\.name === 'main'\);/.test(BRIDGE) &&
  /if \(sameKey \|\| crossTypes\)/.test(BRIDGE) &&
  /独立副通道不打断主分析/.test(BRIDGE));
ok('重启后引擎要重新配置：车道 ready 被复位时 bootAll 仍会再引导一次',
  /var lanesReady = LANES\.main\.ready && LANES\.sub\.ready && LANES\.fwd\.ready;/.test(BRIDGE) &&
  /if \(booted && lanesReady\) return Promise\.resolve\(\);/.test(BRIDGE));
ok('单机版不碰 :8964/ws（wsConnect 早退，重连风暴不存在）',
  /function wsConnect\(\) \{\r?\n {4}if \(STANDALONE\) return;/.test(BRIDGE));

ok('★ 终局判定对齐书签版：**真终局只有盘面五连**（2026-10-03 用户现场：对方活四时旧口径\n' +
   '   adNewGameOff() 把自动落子关掉 → 「我们并没有做最后的一子」）。活四只提示、不断局',
  /function hasFiveOnBoard\(m\)/.test(BRIDGE) &&
  /if \(hasFiveOnBoard\(mEnd\)\)/.test(BRIDGE) &&
  /本局已定局（五子连珠）/.test(BRIDGE) &&
  /function findOpenFour\(m\)/.test(BRIDGE) &&
  /对方活四/.test(BRIDGE) &&
  !/if \(boardDecided\(lastBoardMatrix\(\)\)\)/.test(BRIDGE) &&   // 旧口径（五连或活四）不得复活
  // 位置：终局闸必须在 myIsToMove 那道闸**之前**
  (function () {
    var d = BRIDGE.indexOf('if (hasFiveOnBoard(mEnd)) {');
    var m = BRIDGE.indexOf('if (!myIsToMove(bl, wh)) {');
    return d > 0 && m > 0 && d < m;
  })());
ok('定局时撤标齐全：停自动落子 + 撤推荐圈/热力图/平衡圈',
  /if \(adOn\) adNewGameOff\(\);/.test(BRIDGE) &&
  /if \(adTimer\) \{ clearTimeout\(adTimer\); adTimer = null; \}/.test(BRIDGE) &&
  /tellHost\(\{ type: 'heat', on: false \}\);[\s\S]{0,80}balOff\(\);/.test(BRIDGE));
ok('「平衡一手/两手」已下线（用户 2026-10-03 取消该功能）：面板无键、无绑定、无实现',
  !/on\('__gb_bal1'/.test(BRIDGE) &&
  !/async function runBalance/.test(BRIDGE) &&
  !/__gb_bal1/.test(PANEL) &&
  !/__gb_bal2/.test(PANEL));

// == ② 构建脚本 ==
console.log('== ② 构建脚本 --standalone ==');
ok('bash 脚本：--standalone → /DGB_ASSISTANT_STANDALONE + 产物 Desktop GomokuAssistant.exe',
  /"--standalone" \] && STANDALONE=1/.test(BLD_SH) &&
  /EXE="\$OUTDIR\/Desktop GomokuAssistant\.exe"\r?\n  DEFINE="\/DGB_ASSISTANT_STANDALONE"/.test(BLD_SH));
ok('bash 脚本：三件套默认路径产物名不变（Desktop GomokuOverlay.exe）',
  /EXE="\$OUTDIR\/Desktop GomokuOverlay\.exe"/.test(BLD_SH));
ok('node 脚本：--standalone 同语义（clArgs 注入宏 + exe 改名 + 发布目录切换）',
  /const STANDALONE = process\.argv\.includes\('--standalone'\);/.test(BLD_JS) &&
  /\.\.\.\(STANDALONE \? \['\/DGB_ASSISTANT_STANDALONE'\] : \[\]\),/.test(BLD_JS) &&
  /'Meter GomokuAssistant'/.test(BLD_JS));
ok('组装脚本：单机版编译指纹守断（拷错三件套 exe 在组装时就现形）',
  /hostBuf\.includes\('unknown engine route'\)/.test(ASM));
ok('组装脚本硬校验：视觉新鲜度 + 明文禁入 + Node 调度器残留判死 + 四份文档',
  /GomokuVision\.exe 比源码旧/.test(ASM) &&
  /die\('overlay\/ 里出现明文/.test(ASM) &&
  /Web GomokuEngine\.exe —— 单机版已废除 Node 调度器模式/.test(ASM) &&
  /LICENSES & COPYRIGHT NOTICES\.txt/.test(ASM));

// == ③ 发布目录（存在才查；未组装时提示而非红） ==
console.log('== ③ 发布目录 Meter GomokuAssistant ==');
{
  const dir = path.join(ROOT, 'Meter GomokuAssistant');
  if (!fs.existsSync(dir)) {
    console.log('  （发布目录未组装 —— 先跑 bash tools/build-overlay-msvc.sh --standalone --publish && node tools/build-assistant-release.js）');
  } else {
    const must = ['Desktop GomokuAssistant.exe',
                  path.join('Vision', 'GomokuVision.exe'), path.join('Vision', 'GomokuVision.dll'),
                  '使用手册.txt', 'User Guide.txt', '开源许可与版权声明.txt', 'LICENSES & COPYRIGHT NOTICES.txt'];
    for (const f of must) ok('随包文件：' + f, fs.existsSync(path.join(dir, f)));
    ok('引擎模型随包：rapfi-native 五变体锚点（avx512vnni）',
       fs.existsSync(path.join(dir, 'rapfi-native', 'RapfiEngine-avx512vnni.exe')));
    const ov = path.join(dir, 'overlay');
    const encs = fs.existsSync(ov) ? fs.readdirSync(ov).filter((f) => f.endsWith('.enc')) : [];
    ok('面板密文随包（≥3 个 .enc）', encs.length >= 3);
    const plain = fs.existsSync(ov) ? fs.readdirSync(ov).filter((f) => /\.(html|js|css)$/i.test(f)) : [];
    ok('面板明文一个不入库', plain.length === 0);
    const hostBuf = fs.readFileSync(path.join(dir, 'Desktop GomokuAssistant.exe'));
    ok('宿主 exe 是单机版编译（指纹 in-place）', hostBuf.includes('unknown engine route'));
    ok('Node 调度器模式已废除：无 Web GomokuEngine.exe、无 overlay README',
       !fs.existsSync(path.join(dir, 'Web GomokuEngine.exe')) &&
       !fs.existsSync(path.join(dir, 'README_zh.md')) &&
       !fs.existsSync(path.join(dir, 'README_en.md')));
  }
}

// == ④ 安装脚本 ==
console.log('== ④ installer/MeterGomokuAssistant.iss ==');
ok('AppId 独立 GUID（与训练器 7C3E9A54…、套件互不冲突）',
  /AppId=\{\{4E8B1C77-6A52-4D93-9F0B-1C7D5A24E931\}/.test(ISS) && !/7C3E9A54/.test(ISS));
ok('版本三处同步：iss 4.36 = host.cpp kSplashVer v4.36 = bridge GB_VER v4.36',
  /#define AppVersion     "4\.36"/.test(ISS) &&
  /kSplashVer = L"v4\.36"/.test(HOST) &&
  /var GB_VER = 'v4\.36';/.test(rd('desktop-overlay', 'ui', 'bridge.js')));
ok('随包 = 引擎模型 + 视觉 + 四份文档；无 Web GomokuEngine（Node 调度器废除）',
  /rapfi-native\\\*/.test(ISS) && /使用手册\.txt/.test(ISS) &&
  /LICENSES & COPYRIGHT NOTICES\.txt/.test(ISS) &&
  !/Source: "\{#SrcDir\}\\Web GomokuEngine\.exe"/.test(ISS) &&
  !/Source: "\{#SrcDir\}\\README_zh\.md"/.test(ISS));
ok('卸载三连杀：助手 + 引擎 + 视觉（残留进程会锁死卸载）',
  /KillAssistant"/.test(ISS) && /Web GomokuEngine\.exe"" \/F/.test(ISS) && /GomokuVision\.exe"" \/F/.test(ISS));
ok('升级清旧货：overlay/rapfi-native/Vision 旧目录 + 根目录旧 GomokuVision 全清',
  /Name: "\{app\}\\overlay"/.test(ISS) && /Name: "\{app\}\\rapfi-native"/.test(ISS) &&
  /Name: "\{app\}\\Vision"/.test(ISS));
ok('运行期产物卸载清理：WebView2Data + logs',
  /Name: "\{app\}\\WebView2Data"/.test(ISS) && /Name: "\{app\}\\logs"/.test(ISS));
ok('rapfi-native 随包排除 poisoned-bak（本地排障备份不发货）',
  /Excludes: "\*\.poisoned-bak"/.test(ISS));
ok('[Files] 无日志/无 dump（最小打包铁律）',
  !ISS.split(/\r?\n/).some((l) => /^Source\s*:/i.test(l.trim()) && /\.log\b|\.dmp\b/i.test(l)));

// == build-installer.js 目标注册 ==
console.log('== ⑤ build-installer.js --assistant 目标 ==');
{
  const BI = rd('tools', 'build-installer.js');
  ok('assistant 目标注册 + --assistant 参数路由',
     /key: 'assistant'/.test(BI) && /argv\.includes\('--assistant'\)/.test(BI));
  ok('单机版身份护栏（identityProbe: unknown engine route）',
     /identityProbe: \{ exe: 'Desktop GomokuAssistant\.exe', must: 'unknown engine route' \}/.test(BI));
  ok('新鲜度按 overlay 工程对照（freshnessSrc 指向 desktop-overlay）',
     /freshnessSrc: \['desktop-overlay\/src', 'desktop-overlay\/ui'\]/.test(BI));
}

console.log('\n== test-standalone-assistant: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
