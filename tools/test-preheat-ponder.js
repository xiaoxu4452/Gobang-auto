/* test-preheat-ponder.js —— 2026-09-27 深夜改版的行为回归（纯 Node，秒级，无需引擎）
 * 覆盖：
 *  A. 源码契约：投票删除 / 单实例满线程 / 预热默认开（微小官方 ponder）/ PV 种子 /
 *     暂停护栏 / 粒子滤波 / postLive pvs / 胶囊配色 / 多点分析可取消。
 *  B. 行为仿真：切片 calc.js 预热段 + 桩 LocalAI，逐条验证
 *     PV 种子直用（跳过探测）、probe 兜底、preheatTake 命中即取即毁、开关与暂停门槛、
 *     PV 过期/被占回退探测。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name); }
}
const load = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const JS = load('desktop-calculator/ui/calc.js');
const HTML = load('desktop-calculator/ui/calc.html');
const CSS = load('desktop-calculator/ui/calc.css');
const EAI = load('desktop-calculator/ui/engine-ai.js');
const ES = load('engine-server/engine-server.js');

console.log('== A. 源码契约 ==');
ok('A1 并行引擎按键已删（html 无 sel_ensN / t_ensN / 双引擎）',
  HTML.indexOf('sel_ensN') < 0 && HTML.indexOf('t_ensN') < 0 && HTML.indexOf('双引擎') < 0);
ok('A2 投票机器已删（fuseVotes / votePickBest / ENS_LANES / ensTopN / busyLanes … 全部不在）',
  ['fuseVotes', 'votePickBest', 'ENS_LANES', 'ensTopN', 'busyLanes', 'moveVoteSkip', 'heatVoteSkip',
   'ensCount', 'ensLanes', 'voteTopN', 'applyEnsLabels', 'S.ensN', 'sel_ensN']
    .every((k) => JS.indexOf(k) < 0));
ok('A3 analyzeVote 薄壳：warm 直用 + 单发 analyze（签名去 skip 参）',
  JS.indexOf('async function analyzeVote(turnMs, topN, side, warm, lone, tag) {') >= 0 &&
  JS.indexOf('if (warm && warm.candidates && warm.candidates.length) return warm;') >= 0 &&
  JS.indexOf('return analyze(turnMs, topN || 1, lone || null, side, tag);') >= 0);
ok('A4 单实例满线程：engine-ai main=cpuN、sub=fwd=1、旧 60% 拆分已删',
  EAI.indexOf('var mainT = cpuN;') >= 0 && EAI.indexOf('var subT = 1;') >= 0 &&
  EAI.indexOf('var fwdT = 1;') >= 0 && EAI.indexOf('Math.round(cpuN * 0.6)') < 0 &&
  EAI.indexOf('cpuN - reserve') < 0);
ok('A5 单实例满线程：engine-server 同口径 + 哈希 main 大头（sub/fwd 各 64MB）',
  ES.indexOf('var mainT = cpuN;') >= 0 && ES.indexOf('var subT  = 1;') >= 0 &&
  ES.indexOf('var mainH = Math.max(65536, hashKB - 2 * auxH);') >= 0);
ok('A6 预热默认关（09-28 口径：大预热不默认跑）+ 勾选后启用门槛',
  /preheat: false,/.test(JS) && /if \(S\.preheat !== true\) return false;/.test(JS) &&
  /els\.chk_preheat\.checked = S\.preheat === true;/.test(JS));
ok('A7 PV 种子：aiMove/assist 落子后存 lastPv（必应覆盖时不种）',
  JS.indexOf('PREHEAT.lastPv = (!gd && pvLine') >= 0 && JS.indexOf('PREHEAT.lastPv = (!gd2 && pvLine2') >= 0);
ok('A8 暂停护栏：思考中途被叫停 → 结果作废不落子（aiMove + assist 两处）',
  /await analyzeVote\(aiTurnBudget\(\), 1, curColor\(\), warm, null, T\('tagAiMove'\)\);[\s\S]{0,220}?if \(S\.paused\) \{ G\.think = \[\]; G\.busy = false; setTurnPill\(T\('paused'\)\); refreshUI\(\); return; \}/.test(JS) &&
  /await analyzeVote\(aiTurnBudget\(\), 1, curColor\(\), awarm, null, T\('tagAssist'\)\);[\s\S]{0,140}?if \(S\.paused\) \{/.test(JS));
ok('A9 粒子滤波：pfObserve/pfPick + 实时帧观测挂钩 + aiMove/assist 裁决',
  JS.indexOf('function pfObserve(ply, cands) {') >= 0 &&
  JS.indexOf('function pfPick(finalCands, engineBest) {') >= 0 &&
  JS.indexOf("if (d.lane === 'main' && (d.tag === T('tagAiMove') || d.tag === T('tagAssist'))) {") >= 0 &&
  JS.indexOf('var pfB = pfPick(cs, best);') >= 0 && JS.indexOf('var pfB2 = pfPick(cs, best);') >= 0);
ok('A10 实时帧带候选列表（engine-ai postLive 增加 pvs 字段）',
  EAI.indexOf('pvs: (lane.liveState && lane.liveState.pvs) || [],') >= 0);
ok('A11 「计算中」胶囊红 → 青/浅天蓝（青点 #2fc1d8、深青字 #137f98、淡青底）',
  CSS.indexOf('.calc-pill[data-on="1"]{background:rgba(88,197,224,.16); color:#137f98}') >= 0 &&
  CSS.indexOf('background:#2fc1d8') >= 0 && CSS.indexOf('#e24444') < 0 && CSS.indexOf('rgba(226,68,68,.14)') < 0);
ok('A12 多点分析可取消：运行中再点 = anaStop；文案随状态切「停止计算」',
  JS.indexOf("els.btn_an_nbest.onclick = function () { if (G.ana.busy && G.ana.kind === 'nbest') { anaStop(); return; } anaNbest(); };") >= 0 &&
  JS.indexOf("els.btn_an_nbest.textContent = (busy && G.ana.kind === 'nbest') ? T('anStop') : T('anNbest');") >= 0);
ok('A13 全局演算验证（粒子滤波·全局链路版）：simVerify/simPlayout + aiMove 挂钩（必应手不模拟）',
  JS.indexOf('async function simVerify(board0, cands, best, color) {') >= 0 &&
  JS.indexOf('async function simPlayout(board0, first, color, simMs, totalMs) {') >= 0 &&
  JS.indexOf('if (!gd) {\n      var simB = await simVerify(G.board, cs, best, curColor());') >= 0);
ok('A14 页面初始化界面先出：bootDone 提前 + renderDrawer 让路下一拍',
  JS.indexOf('  bootDone();\n  setTimeout(function () { renderDrawer(); }, 0);') >= 0 &&
  JS.indexOf('  maybeAi();\n  bootDone();\n}') < 0);
ok('A15 收敛式渐进升级：deep 预算按轮次翻倍 + 结果只升不降',
  JS.indexOf('var deep = Math.max(900, Math.min(PREHEAT_MAX_MS, Math.round((S.turnMs || 2000) * 0.9) * round));') >= 0 &&
  JS.indexOf("if (newD >= oldD) PREHEAT.cache[pk.x + ',' + pk.y] = { ply: ply0, after: [pk.x, pk.y], r: rr, ts: Date.now(), round: round + 1 };") >= 0);

console.log('== B. 行为仿真（切片预热段 + 桩 LocalAI）==');
const segStart = JS.indexOf('function preheatOn()');
const segEnd = JS.indexOf('/** ★ 2026-09-25（**算法层**的时间分配');
ok('B0 预热切片可定位（preheatOn → preheatTake）', segStart >= 0 && segEnd > segStart);

if (segStart >= 0 && segEnd > segStart) {
  const seg = JS.slice(segStart, segEnd);
  const N = 15;
  const mkBoard = () => Array.from({ length: N }, () => new Array(N).fill(0));
  function makeEnv(o) {
    o = o || {};
    let seq = 0; const calls = [];
    const env = {
      N, RV_MODE: false,
      S: { preheat: o.preheat !== false, turnMs: 2000, mode: 'pve', paused: !!o.paused },
      G: {
        moves: o.moves || [{ x: 3, y: 3, c: 1 }, { x: 4, y: 4, c: 2 }, { x: 5, y: 3, c: 1 }],
        board: o.board || mkBoard(),
        ana: { busy: false, defRefining: false }, fwd: null, over: false, review: false, busy: false,
      },
      curColor: () => 2, isAiColor: () => false, aiVsAi: () => false, humanBoth: () => false,
      openActive: () => false, engineRule: () => 0, T: (s) => s, refreshUI: () => {},
      LocalAI: {
        isReady: () => true, nextLiveId: () => ++seq,
        analyze(body) {
          calls.push(JSON.parse(JSON.stringify(body)));
          const rep = (body.cid.indexOf('probe') >= 0) ? env.__probe : env.__deep;
          return Promise.resolve(rep ? JSON.parse(JSON.stringify(rep)) : { candidates: [] });
        },
      },
    };
    env.__probe = { candidates: [{ x: 5, y: 5, depth: 6 }, { x: 6, y: 6, depth: 6 }] };
    env.__deep = { candidates: [{ x: 8, y: 8, depth: 10 }], forbid: [] };
    const fn = new Function(...Object.keys(env), seg + '\n;return { PREHEAT, preheatRound, preheatTake, preheatWanted, preheatStop };');
    const api = fn.apply(null, Object.values(env));
    return { api, calls, env };
  }

  (async () => {
    // B1 默认开 + 无 PV → 走 probe 兜底：1 探 + 2 深搜，缓存 2 个应手点
    {
      const { api, calls } = makeEnv();
      ok('B1 预热默认开启（preheatWanted=true）', api.preheatWanted() === true);
      await api.preheatRound();
      ok('B1 无 PV → probe 兜底（1 探 + 2 深 = 3 次调用）', calls.length === 3 && calls[0].cid.indexOf('probe') >= 0);
      ok('B1 probe 用当前盘面、side=行棋方(2)', calls[0].side === 2 && calls[0].lane === 'main');
      ok('B1 deep 预搜的盘面 = 预测应手落子后、side=AI(1)',
        calls[1].side === 1 && calls[1].board[5][5] === 2 && calls[1].cid.indexOf('preheat-4-5,5-') === 0);
      ok('B1 缓存按应手点建立', !!api.PREHEAT.cache['5,5'] && !!api.PREHEAT.cache['6,6']);
    }
    // B2 PV 种子直用（微小官方 ponder 主路径）：跳过 probe，只发 1 发深搜
    {
      const { api, calls } = makeEnv();
      api.PREHEAT.lastPv = { ply: 3, pick: { x: 7, y: 7 } };
      await api.preheatRound();
      ok('B2 PV 种子直用（仅 1 次调用、无 probe）', calls.length === 1 && calls[0].cid.indexOf('probe') < 0);
      ok('B2 预搜盘面 = PV 预测应手落子后、cid 带坐标', calls[0].board[7][7] === 2 && calls[0].cid.indexOf('preheat-4-7,7-') === 0);
      ok('B2 缓存键 = PV 预测点', !!api.PREHEAT.cache['7,7']);
    }
    // B8 收敛式渐进升级：同一预测点第二轮预算翻倍（0.9×→1.8×）、缓存轮次递增
    {
      const { api, calls } = makeEnv();
      api.PREHEAT.lastPv = { ply: 3, pick: { x: 7, y: 7 } };
      await api.preheatRound();
      const firstMs = calls[0].turnMs;
      await api.preheatRound();                          // 用户还在想 → 轮询再跑一轮
      ok('B8 第二轮预算翻倍（' + firstMs + 'ms → ' + calls[1].turnMs + 'ms）',
        calls.length === 2 && calls[1].turnMs === Math.min(4000, firstMs * 2));
      ok('B8 缓存轮次递增（下一轮继续升级）', api.PREHEAT.cache['7,7'] && api.PREHEAT.cache['7,7'].round === 3);
    }
    // B3 preheatTake：用户真落了预测点之后兑取（ply+1 校验）——ponder hit 零等待的数据源
    {
      const { api, env } = makeEnv();
      api.PREHEAT.lastPv = { ply: 3, pick: { x: 7, y: 7 } };
      await api.preheatRound();
      ok('B3 非预测点兑取 = null（且不清掉预测点的缓存）', api.preheatTake(6, 6) === null && !!api.PREHEAT.cache['7,7']);
      env.G.moves.push({ x: 7, y: 7, c: 2 });          // 用户真的下了预测点 → ply 3→4
      const r = api.preheatTake(7, 7);
      ok('B3 用户落预测点后兑取 → 返回成品（含 candidates）', !!r && r.candidates && r.candidates.length === 1);
      ok('B3 取走即销毁（第二次取 = null）', api.preheatTake(7, 7) === null);
    }
    // B4 预热关闭 → 一次调用都不发
    {
      const { api, calls } = makeEnv({ preheat: false });
      await api.preheatRound();
      ok('B4 预热关 → 零调用', calls.length === 0 && api.preheatWanted() === false);
    }
    // B5 暂停 → 零调用
    {
      const { api, calls } = makeEnv({ paused: true });
      await api.preheatRound();
      ok('B5 暂停中 → 零调用（预热不抢暂停局面）', calls.length === 0);
    }
    // B6 PV 过期（ply 不符）→ 回退 probe
    {
      const { api, calls } = makeEnv();
      api.PREHEAT.lastPv = { ply: 2, pick: { x: 7, y: 7 } };
      await api.preheatRound();
      ok('B6 PV 过期 → 回退探测（首调用是 probe）', calls.length === 3 && calls[0].cid.indexOf('probe') >= 0);
    }
    // B7 PV 点被占（用户已在那落子 / 非法）→ 回退 probe
    {
      const board = mkBoard(); board[7][7] = 1;
      const { api, calls } = makeEnv({ board });
      api.PREHEAT.lastPv = { ply: 3, pick: { x: 7, y: 7 } };
      await api.preheatRound();
      ok('B7 PV 点被占 → 回退探测（不往占了的点上预搜）', calls.length === 3 && calls[0].cid.indexOf('probe') >= 0);
    }
  })().then(() => {
    console.log('\n== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==');
    if (fail) { fails.forEach((f) => console.log('  FAIL: ' + f)); process.exit(1); }
    process.exit(0);
  }).catch((e) => { console.error('runner error', e); process.exit(1); });
  return;
}
console.log('\n== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==');
process.exit(fail ? 1 : 0);
