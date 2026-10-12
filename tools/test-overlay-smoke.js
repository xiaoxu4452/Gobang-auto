#!/usr/bin/env node
/**
 * 桌面覆盖层冒烟测试：
 *   启动 GomokuOverlay.exe → 它应当自动拉起共用的引擎（:8964）与识别服务（:8971）、
 *   建立覆盖层与面板两个窗口。本脚本只做可观测的断言（进程存活 / 端口 / 日志），
 *   最后清理干净，不留后台进程。
 *
 * 用法：node tools/test-overlay-smoke.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
// ★ 每次运行一份**独立日志**（宿主 `LogMsg` 用的就是 `GB_LOG_FILE`，它自己的注释就写着
//   「自动化测试要每个实例一份日志，否则两边的输出会交织在同一个文件里，断言会被别人的行干扰」）。
//   踩过的坑：以前固定写 `build/overlay.log`，而宿主是**追加**模式（`_wfopen(path,"ab")`）——
//   只要上一轮的实例在 `unlinkSync` 那一刻还活着（unlink 会 EPERM 被 catch 吞掉），
//   本轮 `parseGeometry` 就会把**上一次启动的几何**一起读进来。症状极具迷惑性：
//   「5 次下发 / 3 种尺寸：421x1238, 421x1208, 421x1238, 421x1208, 421x1234」——
//   看着像窗口在抖，其实是两次启动各 2~3 次、被拼接成了一个序列。见 REF-traps。
const LOG = path.join(ROOT, 'desktop-overlay', 'build', 'overlay-smoke-' + process.pid + '.log');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    s.setTimeout(timeout);
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.on('timeout', () => fin(false));
  });
}

/** 当前在跑的 GomokuOverlay 进程 pid 列表。
 *  为什么不能只盯启动时拿到的 pid：WebView2 子进程反复 LAUNCH_FAILED 时
 *  覆盖层会以「兼容模式」重启自己（见 host.cpp 的 RelaunchInSafeMode），pid 会变。 */
function overlayPids() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Desktop GomokuOverlay.exe" /FO CSV /NH', { encoding: 'utf8' });
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"Desktop GomokuOverlay\.exe","(\d+)"/i);
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  } catch (e) { return []; }
}

/** 结束所有覆盖层实例，并**确认真的没有了**再返回。
 *  不能只杀一次：兼容模式自愈会在启动后几秒内重启自己，上一次的 tasklist 快照抓不到新进程。
 *  ★ 也不能「看见空列表就返回」：自愈重启可能发生在**我们这一轮杀掉之后**，
 *    中间会有一瞬间列表是空的 —— 那时返回就会留下一个刚起来的实例（实测跑完还留着
 *    一个 44MB 的宿主进程，几秒后才自己退）。所以要求**连续 3 轮都空**才算干净。 */
async function killAllOverlayAndWait() {
  let quiet = 0;
  let lastErr = '';
  for (let round = 0; round < 20; round++) {
    const list = overlayPids();
    if (!list.length) {
      if (++quiet >= 3) return true;
    } else {
      quiet = 0;
      for (const pid of list) {
        // ★ 这里**必须保留 2>&1 + 捕获输出**：以前写的是 `{ stdio: 'ignore' }`，
        //   taskkill 失败（例如「拒绝访问」）会被完全吞掉 —— 结果就是杀不掉也毫无线索，
        //   只能看到收尾时残留一个实例。抓到的最后一条错误会打在下面对账信息里。
        try { execSync('taskkill /PID ' + pid + ' /F /T 2>&1', { encoding: 'utf8' }); }
        catch (e) { lastErr = String(((e.stdout || '') + (e.stderr || '')).trim() || e.message).split(/\r?\n/).pop(); }
      }
    }
    await sleep(500);
  }
  const left = overlayPids();
  if (left.length) console.log('    ⚠ taskkill 未能结束：' + left.join(',') + (lastErr ? '（最后一条错误：' + lastErr + '）' : ''));
  return left.length === 0;
}

/** 回收「本次测试间接拉起的」依赖进程（引擎 / 识别服务）。
 *  为什么需要：覆盖层把引擎（:8964）与识别服务（:8971）用 DETACHED_PROCESS 拉起，
 *  **它们不随覆盖层退出而退出** —— 只杀覆盖层的话，这两个会继续占着 8964/8971 与内存，
 *  下一个套件（如 test-backend-no-browser）就会 EADDRINUSE 直接崩，或者被
 *  「already running, reusing it」骗过去、测了个旧进程。本文件头部写的就是「不留后台进程」。
 *  ★ 只杀**起跑时本来没在跑**的角色：万一用户自己开着引擎/识别服务，不能顺手关掉人家的。 */
async function killDepExe(imageName) {
  let lastErr = '';
  for (let round = 0; round < 6; round++) {
    // 与 killAllOverlayAndWait 同理：2>&1 + 捕获输出，别把 taskkill 的报错静默吞掉。
    // （这里按镜像名杀，不带 /T —— /T 是给 /PID 用的；引擎/识别服务本身没有子进程。）
    try { execSync('taskkill /IM "' + imageName + '" /F 2>&1', { encoding: 'utf8' }); }
    catch (e) { lastErr = String(((e.stdout || '') + (e.stderr || '')).trim() || e.message).split(/\r?\n/).pop(); }
    await sleep(400);
    let out = '';
    try { out = execSync('tasklist /FI "IMAGENAME eq ' + imageName + '" /FO CSV /NH', { encoding: 'utf8' }); } catch (e) {}
    if (!new RegExp(imageName.replace(/\./g, '\\.'), 'i').test(out)) return true;
  }
  console.log('    ⚠ 仍有 ' + imageName + ' 在跑' + (lastErr ? '（最后一条错误：' + lastErr + '）' : ''));
  return false;
}

/** 从日志里抓面板尺寸上报与宿主真正下发的窗口几何，用来验证「窗口几何收敛」。
 *  这条断言是有来历的：
 *    · 面板曾因为拿视口高度当 max-height 而形成正反馈，高度一路
 *      595→556→520→…→399 缩下去，直到面板缩成一条线。
 *    · 宿主曾每 700ms 无条件 SetWindowPos + SetWindowRgn（不管尺寸有没有变），
 *      等于持续重建窗口 region 并重绘 —— 这是「点按钮发顿」的主要来源。
 *      所以「已应用几何」的行数必须远少于上报次数。 */
function parseGeometry(log) {
  const rects = [];
  const reRect = /"type":"panelRect","w":(\d+),"h":(\d+),"hdrH":(\d+),"dpr":([\d.]+),"dragW":(\d+)/g;
  for (const m of log.matchAll(reRect)) {
    rects.push({ w: +m[1], h: +m[2], hdrH: +m[3], dpr: +m[4], dragW: +m[5] });
  }
  const applied = [];
  // ★ 2026-09-19（B3）：几何行尾部多了三个「高度由谁说了算」的字段（nat/min/userH）。
  //   面板改成 height:100% 之后 panelCSS 里的高是**自指值**（视口高 = 当前窗口高），
  //   不再等于内容高 —— 拿它当内容高断言会得出「差了 100 多 px」的假红。
  //   所以：nat 必须有（新 exe 一定打），panelCSS 只当参考。
  const reAp = /\[panel\] applied geometry window=\((-?\d+),(-?\d+)\) (\d+)x(\d+)\s+panelCSS=(\d+)x(\d+) dpr=([\d.]+)(?:\s+nat=(\d+) min=(-?\d+) userH=(-?\d+))?/g;
  for (const m of log.matchAll(reAp)) {
    applied.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], cssW: +m[5], cssH: +m[6], dpr: +m[7],
                   nat: m[8] === undefined ? null : +m[8],
                   min: m[9] === undefined ? null : +m[9],
                   userH: m[10] === undefined ? null : +m[10] });
  }
  return { rects, applied };
}

/** 等到这些端口都没人监听（有界）。返回实际等了多久毫秒。
 *  为什么需要：覆盖层被 /T 杀掉之后，它拉起的引擎与识别服务还要几秒才真正退出。
 *  若不等，下一个测试启动时会「复用」这些还没退的进程 —— 宿主就不会打「启动依赖」日志，
 *  断言随之偶发失败（这正是本套件在批量跑时 25/26 的原因）。 */
async function waitPortsClosed(ports, budgetMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    let any = false;
    for (const p of ports) { if (await portOpen(p, 400)) { any = true; break; } }
    if (!any) break;
    await sleep(500);
  }
  return Date.now() - t0;
}

(async () => {
  console.log('== 桌面覆盖层冒烟 ==');
  if (!fs.existsSync(EXE)) { console.error('找不到 ' + EXE + '，请先 node tools/build-overlay.js'); process.exit(1); }
  check('exe 体积', fs.statSync(EXE).size < 4 * 1048576,
    (fs.statSync(EXE).size / 1024).toFixed(1) + ' KB（复用系统 WebView2，未打包内核）');

  // 干净起见：先清掉上一次的残留实例与日志（尽力而为；测试实例自带命名空间，不依赖清理成功）
  // 上一轮的 pid 命名日志可能还攥在一个没退干净的实例手里删不掉 —— 所以**顺带扫掉同前缀的旧文件**，
  // 只保留本轮自己那一份（本轮的名字带的是当前 pid，绝不会撞上）。
  try {
    for (const f of fs.readdirSync(path.dirname(LOG))) {
      if (/^overlay-smoke-\d+\.log$/.test(f)) { try { fs.unlinkSync(path.join(path.dirname(LOG), f)); } catch (e) {} }
    }
  } catch (e) {}
  try { fs.unlinkSync(LOG); } catch (e) {}
  await killAllOverlayAndWait();
  await sleep(500);
  console.log('  当前同名实例数：' + overlayPids().length + '（测试实例使用独立命名空间，互不干扰）');
  const waitedDeps = await waitPortsClosed([8964, 8971]);
  if (waitedDeps > 500) console.log('  等待上一轮依赖进程退出：' + waitedDeps + 'ms');

  // 起跑前先记下「谁本来就在跑」：收尾只回收**本测试间接拉起**的那部分，不动用户自己的。
  const engineWasUp = await portOpen(8964, 600);
  const visionWasUp = (await portOpen(8971, 600)) || (await portOpen(8970, 600));
  if (engineWasUp || visionWasUp) {
    console.log('  依赖服务起跑前已在运行（引擎=' + engineWasUp + ' 识别=' + visionWasUp + '）→ 收尾不回收它们');
  }

  const t0 = Date.now();
  // 独立命名空间：万一机器上还有别的实例（用户在用 / 上一轮残留），本测试的实例也不会
  // 因为「已有实例在运行」而直接退出 —— 那类失败与本次改动毫无关系。
  const child = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, { GB_INSTANCE_ID: 'smoke' + process.pid, GB_LOG_FILE: LOG }),
  });
  child.unref();
  const pid = child.pid;
  console.log('  启动 pid=' + pid + '，等待依赖服务就绪…');

  await sleep(26000);

  const pids = overlayPids();
  check('覆盖层进程存活', pids.length > 0,
    pids.length ? 'pid=' + pids.join(',') + (pids.includes(pid) ? '' : '（已按兼容模式自愈重启，pid 变了）')
                : '启动时的 pid=' + pid + ' 已退出');

  const e8964 = await portOpen(8964);
  const e8971 = await portOpen(8971);
  check('引擎 :8964 已监听', e8964);
  check('识别服务 :8971 已监听', e8971);

  // 引擎健康检查（路径是 /health）
  if (e8964) {
    const r = spawnSync(process.execPath, ['-e', `
      const http=require('http');
      http.get({host:'127.0.0.1',port:8964,path:'/health',timeout:5000},s=>{
        let b='';s.on('data',c=>b+=c);s.on('end',()=>{console.log(s.statusCode+' '+b.slice(0,200));});
      }).on('error',e=>console.log('ERR '+e.message)).on('timeout',function(){this.destroy();console.log('TIMEOUT');});
    `], { encoding: 'utf8', timeout: 9000 });
    const out = (r.stdout || '').trim();
    check('引擎健康接口 /health', /200/.test(out), out);
  }

  // 识别服务实际扫一屏
  if (e8971) {
    const r = spawnSync(process.execPath, ['-e', `
      const http=require('http');
      const body=JSON.stringify({size:15});
      const q=http.request({host:'127.0.0.1',port:8971,path:'/scan',method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':body.length},timeout:15000},s=>{
        let b='';s.on('data',c=>b+=c);s.on('end',()=>{
          try{const j=JSON.parse(b);console.log(JSON.stringify({ok:j.ok,found:j.found,suspect:j.suspect,black:(j.black||[]).length,white:(j.white||[]).length}));}
          catch(e){console.log('BAD '+b.slice(0,120));}
        });
      });
      q.on('error',e=>console.log('ERR '+e.message)).on('timeout',function(){this.destroy();console.log('TIMEOUT');});
      q.write(body);q.end();
    `], { encoding: 'utf8', timeout: 20000 });
    const out = (r.stdout || '').trim();
    let j = null;
    try { j = JSON.parse(out); } catch (e) {}
    check('识别服务可扫屏', !!(j && j.ok), out);
  }

  // 日志：启动阶段应记录 UI 目录、依赖拉起，以及面板 UI 真的加载起来了
  if (fs.existsSync(LOG)) {
    const log = fs.readFileSync(LOG, 'utf8');
  check('日志记录了 UI 目录', /UI dir /.test(log), (log.match(/UI dir .*/) || [''])[0].slice(0, 100));
  check('日志记录了依赖启动',
    /\[deps\][^\n]*?(starting engine backend|starting recognition service|already running, reusing)/.test(log),
    (log.match(/\[deps\][^\n]*/) || [''])[0].slice(0, 90));
  check('两扇窗口已建立', /overlay window created/.test(log) && /panel window created/.test(log));
    check('WebView2 Runtime 可用', /Runtime \d+\./.test(log), (log.match(/Runtime [\d.]+/) || [''])[0]);
    // 测试实例必须连 WebView2 userData 一起隔离：否则上一个覆盖层实例的子进程还没退干净时，
    // 本实例会 LAUNCH_FAILED（渲染进程起不来 → 页面不加载 → 上报全无）。这就是本套件
    // **批量连跑**时偶发 13/18 的成因，单跑看不到。
    check('测试实例用独立 WebView2 userData（避免与上一实例抢目录锁）',
      /userData=.*WebView2_/.test(log),
      (log.match(/userData=[^\s]*/) || [''])[0].slice(0, 90));
    check('面板 UI 真的加载（JS 已运行）', /\[ui\] (panel JS ready|panel reported position)/.test(log),
      (log.match(/\[ui\].*/) || [''])[0].slice(0, 120));
    // bootStep 必须走到底：停在中间就是某一步把页面卡死了
    check('面板启动流程走完（收到 bootStep 13）', /bootStep","at":"13 /.test(log));
    // 诊断探针必须「就绪即停」：它每次都要走 COM + 写日志，永久每秒一次是白花 UI 线程
    const probeN = (log.match(/\[probe#\d+\]/g) || []).length;
    check('页面就绪后诊断探针已停（未长期空转）', probeN <= 12, probeN + ' 次探针');

    // ---- 窗口几何：必须收敛、不塌缩、不裁切、不做无用重设 ----
    const { rects, applied } = parseGeometry(log);
    check('面板有上报尺寸', rects.length > 0, rects.length + ' 次');
    if (rects.length) {
      const last = rects[rects.length - 1];
      const tail = rects.slice(-3).map((r) => r.h);
      const stable = tail.length >= 2 && Math.max(...tail) - Math.min(...tail) <= 2;
      check('面板高度已收敛（不再单调缩小）', stable, '末尾高度 ' + tail.join(' → '));
      check('面板高度未塌缩', last.h >= 200, 'h=' + last.h + ' hdrH=' + last.hdrH);
      check('页面自报 dpr 合法', last.dpr >= 0.5 && last.dpr <= 6, 'dpr=' + last.dpr);
      // 拖动区必须留出右侧按钮：dragW 明显小于面板宽度，否则「EN」这类按钮会被拖动吃掉
      check('标题栏拖动区已避让右侧按钮', last.dragW > 0 && last.dragW <= last.w - 20,
        'dragW=' + last.dragW + ' 面板宽=' + last.w);
      check('标题栏高度已实测上报', last.hdrH >= 16 && last.hdrH <= 120, 'hdrH=' + last.hdrH);
    }
    // 标题栏按钮占位：宿主据此把「整条标题栏」当拖动区、只挖掉按钮。
    // 这条链路断了的话，要么按钮点不动（被拖动区吃掉），要么整条标题栏都拖不动。
  const bm = log.match(/\[panel\] title-bar button hitboxes (\d+) \(CSS px\): ([^\s]+)/);
  check('标题栏按钮占位已上报给宿主', !!bm && +bm[1] >= 3, bm ? bm[1] + ' 个：' + bm[2] : '未上报');
  check('拖动区覆盖标题栏左侧（标题文字处可拖）',
    /\[panel\] title-bar button hitboxes \d+ /.test(log) && /drag zone = rest/.test(log));
    check('宿主确实下发过窗口几何', applied.length > 0, applied.length + ' 次');
    if (applied.length) {
      const a = applied[applied.length - 1];
      // ★ 契约（用户要求 2026-09-17：比例/字体/按键与网页书签版**一模一样**）：
      //   窗口 = 225 × 610 CSS px × dpr，zoom 恒 1 → 1 CSS px = dpr 物理像素。
      //   225 就是书签版面板的容器宽度（engine-server/resources/bookmarklet.js 里
      //   `#__gb_panel{width:225px}`），所以面板内容 1:1 呈现，字体不再被缩放补偿压小。
      const scr = (log.match(/screen=(\d+)x(\d+)/) || [])[0];
      const sw = scr ? Math.min(+scr.split('=')[1].split('x')[0], +scr.split('=')[1].split('x')[1]) : 0;
      check('窗口宽 ≈ 225×dpr（书签版设计宽）',
        Math.abs(a.w - 225 * a.dpr) <= Math.max(6, 225 * a.dpr * 0.06),
        '窗口宽 ' + a.w + ' 期望 ' + Math.round(225 * a.dpr) + '（dpr=' + a.dpr + '）');
      // ★ 2026-09-19（B3）：驱动窗口高度的是**页面实测的内容自然高 nat**（= 标题栏 +
      //   body.scrollHeight + 拖拽条），不是 panelCSS —— 面板 height:100% 之后
      //   panelCSS 里的高就是「当前窗口高」，拿它比等于自己跟自己比（必然假红）。
      const driven = (a.nat === null ? a.cssH : a.nat);
      check('窗口高 ≈ 页面实测的内容自然高 nat × dpr（高度向下延伸，不再锁死 0.618 / 610）',
        a.nat !== null && Math.abs(a.h - driven * a.dpr) <= Math.max(6, driven * a.dpr * 0.04),
        '窗口高 ' + a.h + ' nat=' + driven + ' CSS px × dpr ' + a.dpr
          + ' = ' + Math.round(driven * a.dpr) + (a.nat === null ? '（旧 exe 没有 nat 字段）' : ''));
      check('窗口高不再等于固定设计高（内容短了窗就短，不会留一大块空）',
        Math.abs(a.h - 610 * a.dpr) > 4 || driven > 600,
        '窗口高 ' + a.h + '（610×dpr=' + Math.round(610 * a.dpr) + '，内容高 ' + driven + '）');
      // 高度现在是「跟随页面内容」的：启动期内容还在长（状态栏文案换行、图例出现等），
      // 所以前几次下发看到 1236→1184 这类变化是**设计如此**。
      // 真正要守的是两件事：① 内容稳定后窗口不再漂移（否则面板每秒抖一下）；
      //                    ② 启动期不能反复来回乱跳（档位应当很少）。
      // ★ 旧断言（已废弃，2026-09-20）：「末尾两次下发完全一致」。
      //   它在宿主的**去重契约**下永远不可能成立 —— `ApplyPanelRect()` 只在矩形真的变了才写这条
      //   日志（`host.cpp` 里 `want == g_panelApplied` 就直接 return），而矩形是 (w,h) 的函数
      //   （右下角锚定，见 `PanelTopLeft`）：同 w/h ⇒ 同矩形 ⇒ 第二次直接被 return 掉。
      //   实测下来一次启动只下发 2~3 次（首帧估算 → 量准内容 → 图例出现各一次），末两次本来就该不同。
      //   这条红从 2026-09-17 起就一直在（当时记为「严格度问题」待办），与识别组件迁移无关。
      //   现在改为守**真正的**不变量：① 内容没变就不许动窗口（无同尺寸重复下发）；
      //                              ② 最后一次下发必须对齐收敛后的内容高（窗口不落后于内容）。
      const distinctApplied = new Set(applied.map((x) => x.w + 'x' + x.h)).size;
      check('没有同尺寸重复下发（内容高没变就绝不动窗口）',
        distinctApplied === applied.length,
        applied.length + ' 次下发 / ' + distinctApplied + ' 种尺寸：'
          + applied.map((x) => x.w + 'x' + x.h).join(', '));
      const lastApplied = applied[applied.length - 1];
      const lastRect = rects[rects.length - 1];
      // 同上：比的是「驱动窗口的那个数」（nat），不是自指的 panelCSS。
      const lastDriven = (lastApplied.nat === null ? lastApplied.cssH : lastApplied.nat);
      check('末尾下发已对齐收敛后的内容高（窗口不停在启动中间值）',
        rects.length > 0 && Math.abs(lastDriven - lastRect.h) <= 6,
        rects.length ? ('末尾下发 nat=' + lastDriven + ' vs 末次上报 h=' + lastRect.h)
                     : '一次上报都没有');
      const distinctH = Array.from(new Set(applied.map((x) => x.h)));
      check('启动期高度没有来回乱跳（不同档位 ≤3）', distinctH.length <= 3,
        '高度档位：' + distinctH.join(', '));
      check('窗口不再跟随页面 CSS 尺寸（固定尺寸模式）',
        /fixedSize=1/.test(log), '日志里应有 fixedSize=1');
      // 无谓重设护栏：面板每 700ms 上报一次，但真正动窗口的次数应当只是「布局稳定前的几次」
      check('未做周期性无谓重设（几何只下发少数几次）', applied.length <= 8,
        applied.length + ' 次下发 vs ' + rects.length + ' 次上报');
    }
    // 兼容模式自愈是否触发（触发不算失败，但必须看得到）
    if (/safe-mode restart/.test(log)) {
      console.log('    ℹ 已触发兼容模式自愈（默认参数下 WebView2 子进程 LAUNCH_FAILED）');
      check('兼容模式重启后带了兼容参数',
        /WebView2 args --no-sandbox/.test(log));
    }
    if (/failed|NOT FOUND/.test(log)) console.log('    ⚠ 日志含告警：' + (log.match(/.*(failed|NOT FOUND).*/g) || []).join(' | ').slice(0, 200));
  } else {
    check('日志文件生成', false, '未生成（可能目录不可写）');
  }

  console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');

  if (process.env.GB_KEEP_RUNNING !== '1') {
    // 收尾必须**如实报告**：以前这里无条件打印「已清理」，其实 killAllOverlayAndWait 的返回值
    // 被丢掉了 —— 覆盖层没杀干净也照样说「已清理」，于是下一轮在「已有实例」的状态下跑，
    // 残留实例还会把引擎/识别服务（看门狗）一起重新拉起来。现在按真实结果报告。
    if (await killAllOverlayAndWait()) console.log('  已清理覆盖层进程（GB_KEEP_RUNNING=1 可保留）');
    else console.log('    ⚠ 覆盖层没有清理干净（下一轮起跑会再杀一次；连跑时它会把依赖服务重新拉起）');
    // ★ 依赖进程（引擎 / 识别服务）是 DETACHED 拉起的，**不会**随覆盖层一起死。
    //   不收就会占着 8964/8971 一直活下去：下一个套件要么 EADDRINUSE 崩，要么被
    //   「already running, reusing it」拉去测旧进程。这里只回收「本来不在跑」的那些。
    if (!engineWasUp) await killDepExe('Web GomokuEngine.exe');
    if (!visionWasUp) await killDepExe('GomokuVision.exe');
    // 依赖收干净后再删日志：它们会把日志句柄攥到退出为止，早删会被静默重建。
    // 本轮日志是随进程号命名的**一次性**文件，删掉别在 build/ 里堆垃圾
    // （删不掉也无所谓：文件名带 pid，绝不会被下一轮读到）。
    try { fs.unlinkSync(LOG); } catch (e) {}
  } else {
    console.log('OVERLAY_PID=' + overlayPids().join(','));
    console.log('LOG=' + LOG);
  }
})().catch((e) => {
  console.error('冒烟异常：' + e.message);
  process.exit(1);
});
