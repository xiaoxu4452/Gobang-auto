#!/usr/bin/env node
/**
 * 回归护栏：浮动面板「拖得动」且「重启还在原位」。
 *
 * 用户明确要求过两次「这个浮动窗口应该是可移动的才对」，而这件事横跨两个进程、一个存档文件，
 * 只靠肉眼看结果很难在改动后确认没退化。本脚本把这条链路拆成可断言的两段：
 *   ① 拖动结束 → 把窗口位置换算成「距右下角偏移」写进 panel-pos.txt
 *   ② 下次启动 → 读回该文件，窗口出现在同一位置
 *
 * 真实拖动由系统的模态移动循环驱动，自动化注入不了鼠标；因此宿主提供了一个仅在
 * GB_TEST_DRAG_TO=x,y 时生效的开关：把窗口挪到指定坐标后调用 OnPanelDragEnd()，
 * 与用户拖完松开走的是**同一条代码路径**。
 *
 * 断言用的是「逻辑位置」而不是偏移数值，于是与 DPI 无关：
 * 摆到 (300,420) → 存偏移 → 重启读回 → 仍应是 (300,420)。
 *
 * 用法：node tools/test-overlay-panel-pos.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// ★ 2026-09-19 修正：exe 早已改名带 Desktop 前缀（与网页端 Web GomokuEngine.exe 区分）。
//   这里原来还写着旧名 GomokuOverlay.exe，而 build 目录里**恰好留着一个 2026-09-17 的旧二进制**，
//   于是本测试一直在测那个陈旧产物 —— 断言全绿、测的却是上一个月的代码（本项目最贵的一类假绿）。
const EXE = path.join(ROOT, 'desktop-overlay', 'build', 'Desktop GomokuOverlay.exe');
const EXE_NAME = 'Desktop GomokuOverlay.exe';
const LOG = path.join(ROOT, 'desktop-overlay', 'build', 'overlay.log');
const LOCAL = process.env.LOCALAPPDATA || '';
// 实例命名空间：互斥体与位置存档都带这个后缀。
// 这样测试既不碰用户正在用的实例，也不会因为「机器上还留着一个实例」而以
// 「已有实例在运行」这种与本次改动无关的理由挂掉。
const ID = 'postest' + process.pid;
const POS = LOCAL ? path.join(LOCAL, 'GomokuOverlay', 'panel-pos_' + ID + '.txt') : '';

const TARGET = { x: 300, y: 420 };

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pids(name) {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ' + name + '" /FO CSV /NH', { encoding: 'utf8' });
    const a = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(new RegExp('^"' + name.replace('.', '\\.') + '","(\\d+)"', 'i'));
      if (m) a.push(Number(m[1]));
    }
    return a;
  } catch (e) { return []; }
}

/** 结束所有覆盖层实例，并等到「连续多次都快照为空」再返回。
 *  只杀一次 / 只看一次快照都不行：兼容模式自愈会在旧进程退出后的空档里重启自己，
 *  只看一眼就会误判「已经清理干净」，下一个用例随即撞上「已有实例在运行」的弹窗而超时。
 *  配合 GB_NO_SAFE_RETRY=1 使用，则一个启动对应一个进程，完全确定。 */
async function killAllOverlayAndWait() {
  let emptyStreak = 0;
  for (let round = 0; round < 40; round++) {
    const list = pids(EXE_NAME);
    if (!list.length) {
      if (++emptyStreak >= 4) return true;          // 连续 4 次（约 1.6s）都没有才算干净
    } else {
      emptyStreak = 0;
      for (const pid of list) {
        try { execSync('taskkill /PID ' + pid + '/F /T', { stdio: 'ignore' }); } catch (e) {}
      }
    }
    await sleep(400);
  }
  return pids(EXE_NAME).length === 0;
}

/** 按端口结束服务：比按进程名删更精确（不会碰用户自己开的别的程序）。 */
function killPorts(ports) {
  let out = '';
  try { out = execSync('netstat -ano -p tcp', { encoding: 'utf8' }); } catch (e) { return; }
  for (const p of ports) {
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(':' + p) || !/LISTENING/i.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (!/^\d+$/.test(pid)) continue;
      try { execSync('taskkill /PID ' + pid + '/F /T', { stdio: 'ignore' }); } catch (e) {}
    }
  }
}

function readLog() {
  try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; }
}

/** 启动一次覆盖层，等它自己的日志出现「启动位置」行后返回该行的解析结果。
 *  每次启动都用**独立的日志文件**（GB_LOG_FILE）：两个实例的日志互不干扰，
 *  断言不会被另一个实例的输出串味。 */
async function launchAndReadStartPos(env, logPath, label) {
  try { fs.unlinkSync(logPath); } catch (e) {}
  const c = spawn(EXE, [], {
    detached: true, stdio: 'ignore', cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, env || {}, { GB_LOG_FILE: logPath }),
  });
  c.unref();
  const read = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch (e) { return ''; } };
  // 「启动位置」在窗口创建处就写了，不必等 WebView2 那一大套起来。
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const log = read();
    const m = log.match(/\[panel\] launch position \((\d+),(\d+)\) (\d+)x(\d+)\s+bottom-right offset=\((-?\d+),(-?\d+)\)([^\n]*)/);
    if (m) {
      return {
        pid: c.pid, logPath: logPath,
        x: +m[1], y: +m[2], w: +m[3], h: +m[4],
        offX: +m[5], offY: +m[6], note: m[7] || '',
        log: log, label: label, read: read,
      };
    }
  }
  return { pid: c.pid, logPath: logPath, x: NaN, y: NaN, log: read(), label: label, timeout: true, read: read };
}

(async () => {
  console.log('== 面板可移动 / 位置持久化 ==');
  if (!fs.existsSync(EXE)) { console.error('找不到 ' + EXE + '，请先 node tools/build-overlay.js'); process.exit(1); }
  if (!POS) { console.error('拿不到 LOCALAPPDATA，无法定位 panel-pos.txt'); process.exit(1); }

  try { fs.unlinkSync(POS); } catch (e) {}
  check('起点：位置存档已清除', !fs.existsSync(POS), POS);

  // 每次启动用**不同的实例 id + 不同的日志文件**，但共用**同一份位置存档**：
  //   · 不同 id → 互斥体不同，第二次启动绝不会被第一次「占着」而拒绝启动
  //     （沙箱里 tasklist 看不到这些进程，靠杀进程来腾位置是不可靠的）
  //   · 同一份存档 → 正好验证「拖完存盘 → 重启读回」这条链路
  // 关掉「兼容模式自动重启」：本用例要的是「一次启动 = 一个进程」。
  function env(id, o) {
    return Object.assign({
      GB_NO_SAFE_RETRY: '1',
      GB_INSTANCE_ID: id,
      GB_PANEL_POS_FILE: POS,
    }, o || {});
  }
  const LOG_A = path.join(path.dirname(LOG), 'overlay-pos-a.log');
  const LOG_B = path.join(path.dirname(LOG), 'overlay-pos-b.log');

  // ---- ① 模拟一次拖动，应写入存档 ----
  const a = await launchAndReadStartPos(
    env(ID + 'a', { GB_TEST_DRAG_TO: TARGET.x + ',' + TARGET.y }), LOG_A, '第一次');
  check('第一次启动拿到了位置', !a.timeout, '位置=(' + a.x + ',' + a.y + ')');
  check('无存档时走默认偏移', /no saved position/.test(a.note), (a.note || '').trim());
  await sleep(800);                      // 拖动挂钩在窗口建好之后才跑，等它把日志写完
  check('测试挂钩触发了拖动存盘', /simulated drag to target position and triggered save/.test(a.read()));

  // 存档可能在触发落盘后才可读，稍等一下
  // ★ 2026-09-19 起存档是**三个**字段：`offX offY userHeight`（第三个 = 用户拖出来的面板高度，
  //   0 = 跟着内容自动）。所以这里必须容忍第三段存在，否则会误判成「存档没生成」。
  let saved = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    try {
      const t = fs.readFileSync(POS, 'utf8').trim();
      const m = t.match(/^(-?\d+)\s+(-?\d+)(?:\s+(-?\d+))?\s*$/);
      if (m) { saved = { offX: +m[1], offY: +m[2], userH: m[3] === undefined ? null : +m[3] }; break; }
    } catch (e) {}
  }
  check('拖动后生成了位置存档', !!saved, saved ? JSON.stringify(saved) : '未生成');
  check('存档偏移为正（窗口在屏幕内）', !!saved && saved.offX > 0 && saved.offY > 0,
    saved ? 'offset=' + saved.offX + ',' + saved.offY : '');
  // 第三条只是「高度」这一路的占位：本用例只拖了位置，没拖高度 → 必须是 0（跟着内容自动）。
  // 若哪天有人把高度也写进第一/第二字段，这条会立刻红。
  check('存档第三个字段 = 面板高度（本次没拖高度 → 0，代表跟着内容自动）',
    !!saved && saved.userH === 0, saved ? '第三字段=' + saved.userH : '');

  // ---- ② 另起一个实例（不同互斥体、同一份存档），应回到同一位置 ----
  const b = await launchAndReadStartPos(env(ID + 'b'), LOG_B, '第二次');
  check('第二次启动拿到了位置', !b.timeout, '位置=(' + b.x + ',' + b.y + ')');
  check('重启后读的是存档而不是默认值', /read from save/.test(b.note), (b.note || '').trim());
  check('重启后回到拖动后的位置（DPI 无关断言）',
    b.x === TARGET.x && b.y === TARGET.y,
    '期望 (' + TARGET.x + ',' + TARGET.y + ') 实际 (' + b.x + ',' + b.y + ')');
  check('两次启动的偏移一致（存档被真正复用）',
    !!saved && b.offX === saved.offX && b.offY === saved.offY,
    '存档 ' + (saved && (saved.offX + ',' + saved.offY)) + ' vs 读回 ' + b.offX + ',' + b.offY);

  // 清理：按自己 spawn 的 pid 结束（不依赖 tasklist 是否看得见）
  for (const x of [a, b]) {
    if (x && x.pid) { try { execSync('taskkill /PID ' + x.pid + '/F /T', { stdio: 'ignore' }); } catch (e) {} }
  }
  killPorts([8964, 8971]);
  await sleep(600);
  try { fs.unlinkSync(POS); } catch (e) {}
  for (const f of [LOG_A, LOG_B]) { try { fs.unlinkSync(f); } catch (e) {} }

  console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + e.message);
  process.exit(1);
});
