/*
 * test-parallel-lanes.js —— 双通道并行（main 落子深搜 / sub 评估）回归验证
 *
 * 背景：单实例 Rapfi + engineSerial 全局串行锁会让「落子深搜」与「评估（热力图/对手圈）」
 * 互相排队 → 主搜索被副评估拖慢。本轮改为两套独立 Rapfi 实例（lane），线程/哈希 2:1 拆分。
 *
 * 验证：
 *  A. 源码守卫：lane 化结构齐备、旧 engineSerial 已消失、boot 双实例、2:1 拆分、面板分派；
 *  B. 真实引擎：/health 显示 main+sub 均就绪；并发 main+sub 均返回候选；并行耗时 < 串行耗时。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8');
const BM  = fs.readFileSync(path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '   ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '   ' + extra : '')); }
}

// ============ A. 源码守卫 ============
ok('engine-server 含 makeLane 通道工厂', /function makeLane\(name\)/.test(SRV));
ok('engine-server 建 main/sub 两通道', /LANES = \{ main: makeLane\('main'\), sub: makeLane\('sub'\) \}/.test(SRV));
ok('engine-server 含 pickLane 分派', /function pickLane\(name\)/.test(SRV));
ok('每通道独立串行锁 laneSerial', /function laneSerial\(lane, action\)/.test(SRV));
ok('命令按通道发送 sendLane', /function sendLane\(lane, cmd\)/.test(SRV));
ok('旧全局单实例串行锁 engineSerial 已移除', !/function engineSerial\(/.test(SRV) && !/\bengineSerial\(/.test(SRV));
ok('doAnalyze 带 lane 参数', /async function doAnalyze\(body, lane\)/.test(SRV));
ok('waitForMove 带 lane 参数', /function waitForMove\(lane, budgetMs, wantTopN\)/.test(SRV));
ok('createLaneEngine 为每通道独立建实例', /async function createLaneEngine\(lane\)/.test(SRV));
ok('boot 建 main+sub 两实例规格', /specs = \[[\s\S]{0,120}?lane: LANES\.main[\s\S]{0,120}?lane: LANES\.sub/.test(SRV));
ok('线程 2:1 拆分 mainT/subT（合计=cpuN）', /var mainT = Math\.max\(1, Math\.min\(cpuN - 1, Math\.round\(cpuN \* 2 \/ 3\)\)\);/.test(SRV) && /var subT  = Math\.max\(1, cpuN - mainT\);/.test(SRV));
ok('哈希 2:1 拆分 mainH/subH（合计≈hashMB）', /var mainH = Math\.max\(64, Math\.round\(hashMB \* 2 \/ 3\)\)/.test(SRV) && /var subH  = Math\.max\(64, hashMB - mainH\)/.test(SRV));
ok('/api/analyze 按 body.lane 分派到对应通道', /const lane = pickLane\(body\.lane\);\s*\n\s*const out = await laneSerial\(lane, \(\) => doAnalyze\(body, lane\)\);/.test(SRV));
ok('/health 暴露 lanes.main/sub 状态', /lanes: \{ main: !!LANES\.main\.engine, sub: !!LANES\.sub\.engine \}/.test(SRV));
ok('每通道独立 outBuf/liveState/captureLine', /outBuf: '',/.test(SRV) && /liveState: null,/.test(SRV) && /captureLine: null,/.test(SRV));

// 面板分派
ok('面板主分析 lane=main', /topN: liveTopN, cid: CLIENT_ID, lane: 'main' \}/.test(BM));
ok('面板热力图补充搜索 lane=sub', /topN: 8, cid: CLIENT_ID, lane: 'sub' \}/.test(BM));
ok('面板对手圈评估 lane=sub', /topN: 3, cid: CLIENT_ID \+ '-opp', lane: 'sub' \}/.test(BM));
ok('/api/status 轮询指定 lane=main', /'\/api\/status\?cid=' \+ CLIENT_ID \+ '&lane=main'/.test(BM));
ok('主分析不再等待副线（并行调度）', /主搜索立即进入下一轮/.test(BM));

// ---- 本轮配套改动守卫：启动器提示 / 默认值 / 热力图多色稳定性 ----
ok('启动器含淡天蓝提示（连续两局执黑 + 学习用途声明）', /background:#e6f4fb/.test(SRV) && /连续两局我方执的都是黑子/.test(SRV));
ok('面板迁移 v6：默认关闭自动落子', /if \(s\.__v < 6\) \{ s\.autoPlay = false; s\.__v = 6; \}/.test(BM));
ok('热力图候选不足时自动补搜（多色稳定性）', /data\.candidates\.length < 4 && !haltForNewGame/.test(BM));

// ============ B. 真实引擎并行 ============
const PORT = parseInt(process.env.GB_TEST_PORT || '18964', 10);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 60000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { let j = s; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); r.on('timeout', () => { try { r.destroy(new Error('timeout')); } catch (e) {} });
    if (data) r.write(data); r.end();
  });
}
function emptyBoard() { const b = []; for (let y = 0; y < 15; y++) b.push(new Array(15).fill(0)); return b; }
function inBoard(m) { return Array.isArray(m) && m.length === 2 && m[0] >= 0 && m[0] < 15 && m[1] >= 0 && m[1] < 15; }

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'engine-server', 'engine-server.js')],
    { env: Object.assign({}, process.env, { GB_PORT: String(PORT) }), stdio: 'ignore', windowsHide: true });
  try {
    let h = null;
    for (let i = 0; i < 90; i++) {
      try { const r = await req('GET', '/health'); h = r.body; if (h && h.ready && h.lanes && h.lanes.main && h.lanes.sub) break; } catch (e) {}
      await new Promise(r => setTimeout(r, 500));
    }
    ok('真实引擎：/health 显示 main+sub 双通道均就绪', !!(h && h.lanes && h.lanes.main && h.lanes.sub), JSON.stringify(h && h.lanes));

    const b = emptyBoard(); b[7][7] = 1;   // 黑天元
    const mk = (lane, topN, cid) => ({ board: b, rule: 0, matchMs: 6000000, turnMs: 3000, timeUsedMs: 0, topN, cid, lane });

    const t0 = Date.now();
    const [m, s] = await Promise.all([req('POST', '/api/analyze', mk('main', 1, 'T-main')), req('POST', '/api/analyze', mk('sub', 8, 'T-sub'))]);
    const parMs = Date.now() - t0;
    ok('并行：main 通道返回合法 best', m.status === 200 && inBoard(m.body && m.body.best), m.status + ' ' + JSON.stringify(m.body && m.body.best));
    ok('并行：sub 通道返回 ≥2 候选', s.status === 200 && !!(s.body && s.body.candidates && s.body.candidates.length >= 2), s.status + ' cands=' + ((s.body && s.body.candidates && s.body.candidates.length) || 0));

    const t1 = Date.now();
    await req('POST', '/api/analyze', mk('main', 1, 'T-m2'));
    await req('POST', '/api/analyze', mk('sub', 8, 'T-s2'));
    const serMs = Date.now() - t1;
    ok('并行耗时 < 串行耗时（两通道真并行）', parMs < serMs, 'par=' + parMs + 'ms ser=' + serMs + 'ms');
  } finally {
    try { child.kill(); } catch (e) {}
    try { require('child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { windowsHide: true }); } catch (e) {}
  }

  console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
