/*
 * test-live-semantics.js —— 回归测试：发布版「实时语义」契约，全部走真实引擎 + HTTP。
 *   ① 评估视角：引擎 eval 是【行棋方视角】（用可推理的必胜/必败盘面断言）
 *   ①c 【核心】YXBOARD 序列颜色顺序 → 行棋方与评估视角（黑先严格交替，绝不同色连写）
 *   ② 热力图「边计算边映射多彩定位点」：topN=8 时搜索中 liveState.pvs 能到多条（>1）
 *   ③ 对手圆环与热力图同帧：源码守卫（drawOverlay 末尾重投影对手层）
 *   ④ 服务端 moveList 序列构造：源码守卫 + 纯逻辑单测
 *
 * 默认 spawn 发布版 Web GomokuEngine.exe；设 GB_TEST_SRC_SERVER=1 则改用源工程
 * engine-server/engine-server.js（改完源码先验证逻辑、尚未重建 exe 时用）。
 * 自包含：spawn → 断言 → 收尸。一次 Bash 调用跑完。
 * 用法: node tools/test-live-semantics.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'Meter engine-server', 'Web GomokuEngine.exe');
const SRC = path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js');
const N = 15;
// 用哪个服务端？默认发布版 exe；GB_TEST_SRC_SERVER=1 → 源工程（node 直跑）
const useSrcServer = process.env.GB_TEST_SRC_SERVER === '1';
const NODE_BIN = process.execPath;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const srv = useSrcServer
  ? spawn(NODE_BIN, [path.join(ROOT, 'engine-server', 'engine-server.js')], { cwd: path.join(ROOT, 'engine-server'), stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);

function waitUp(port, maxMs) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, x => { x.resume(); clearInterval(t); res(); });
      r.on('error', () => { if (Date.now() - t0 > maxMs) { clearInterval(t); rej(new Error('engine never up')); } });
      r.on('timeout', () => r.destroy());
    }, 300);
  });
}
function post(p, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: 8964, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      x => { let b = ''; x.on('data', c => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({ raw: b }); } }); });
    r.on('error', rej); r.write(data); r.end();
  });
}
function getStatus(cid) {
  return new Promise(res => {
    http.get({ host: '127.0.0.1', port: 8964, path: '/api/status?cid=' + encodeURIComponent(cid) }, x => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    }).on('error', () => res(null));
  });
}
const empty = () => Array.from({ length: N }, () => new Array(N).fill(0));

// 从面板源码抽真实函数跑断言（与运行时同一份实现）
function grabFn(name) {
  const src = fs.readFileSync(SRC, 'utf8');
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  const s = src.slice(at);
  let d = 0, started = false;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '{') { d++; started = true; }
    else if (s[k] === '}') { d--; if (started && d === 0) return s.slice(0, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

(async () => {
  try {
    await waitUp(8964, 90000);

    // ---------- ① 评估视角：可推理的必胜/必败盘面 ----------
    section('1) 引擎 eval 是【行棋方视角】（可推理盘面断言）');
    {
      // T1：白活四、黑 4 废子 → 黑 4 白 4 → 轮黑；黑无法阻止白成五 → 黑必败 → 行棋方(黑)视角应为负
      const T1 = empty();
      for (let i = 0; i < 4; i++) T1[7][3 + i] = 2;                 // 白活四
      [[0, 0], [0, 2], [0, 4], [0, 6]].forEach(([x, y]) => T1[y][x] = 1);
      const d1 = await post('/api/analyze', { board: T1, rule: 0, matchMs: 6000000, turnMs: 1500, timeUsedMs: 0, topN: 1, cid: 'sem1' });
      const e1 = d1 && d1.candidates && d1.candidates[0] && d1.candidates[0].eval;
      ok('T1 白活四·轮黑·黑必败 → eval 为负（行棋方视角）', /^\s*-M\d+/.test(e1 || ''), 'eval=' + JSON.stringify(e1));

      // T2：黑活四 → 黑必胜 → 行棋方(黑)视角应为正
      const T2 = empty();
      for (let i = 0; i < 4; i++) T2[7][3 + i] = 1;
      [[0, 0], [0, 2], [0, 4], [0, 6]].forEach(([x, y]) => T2[y][x] = 2);
      const d2 = await post('/api/analyze', { board: T2, rule: 0, matchMs: 6000000, turnMs: 1500, timeUsedMs: 0, topN: 1, cid: 'sem2' });
      const e2 = d2 && d2.candidates && d2.candidates[0] && d2.candidates[0].eval;
      ok('T2 黑活四·轮黑·黑必胜 → eval 为正（行棋方视角）', /^\s*\+M\d+/.test(e2 || ''), 'eval=' + JSON.stringify(e2));
    }

    // ---------- ①c 【核心】YXBOARD 序列颜色顺序 → 行棋方与评估视角 ----------
    // 历史 BUG（用户多次反馈“我执白，评估分数和曲线却是黑子的”）：服务端重建 moveList 时把黑白子
    // “同色连写”（先全黑再全白）。Rapfi `getPosition()` 里序列第 3 字段是 SideFlag{1:SELF,2:OPPO}
    // 而非绝对颜色，且**落子方不匹配时会自动插 PASS 翻转行棋方**；同色连写导致 Rapfi 的
    // 最终 SideToMove 恒落在黑方 → 无论“我执”黑还是白，引擎一律按【黑方】出评估与着法。
    // 正确做法 = 黑先严格交替 B,W,B,W,…（多出的子追加在末尾），使
    //   SideToMove = (序列奇数长度 ? 白 : 黑)  ⇔  (bn > wn ? 白 : 黑)，与面板一致。
    //
    // 断言用「一方活四」这种可推理局面：活四拥有方若轮到他走 → 必胜(+M)；若轮对手走 → 必败(-M)。
    section('1c) YXBOARD 序列颜色顺序 → 行棋方/评估视角（活四可推理性断言）');
    {
      const F = [[3, 7], [4, 7], [5, 7], [6, 7]];           // x=3..6, board index y=7（第 8 行）；端点为 x=2 / x=7
      const mk = (fourColor, extra) => {
        const b = empty();
        F.forEach(([x, y]) => b[y][x] = fourColor);
        extra.forEach(([v, x, y]) => b[y][x] = v);
        return b;
      };
      const evOf = (d) => (d && d.candidates && d.candidates[0] && d.candidates[0].eval) || '';
      const isWin = (s) => /^\s*\+M\d+/.test(s);
      const isLose = (s) => /^\s*-M\d+/.test(s);
      // 注意：返回的 best/candidates 的 y 与面板 board[y][x] 同一约定（y=0 在顶部）。
      const atFourEnd = (d) => !!d && !!d.best && (d.best[0] === 2 || d.best[0] === 7) && d.best[1] === 7;

      // P1: 黑活四 + 5黑/4白 → bn>wn → 轮【白】走 → 白面对黑活四必败 → 负
      const P1 = mk(1, [[1, 0, 14], [2, 2, 12], [2, 4, 12], [2, 6, 12], [2, 8, 12]]);
      const d1 = await post('/api/analyze', { board: P1, rule: 1, matchMs: 6000000, turnMs: 1500, timeUsedMs: 0, topN: 2, cid: 'sem-p1' });
      ok('P1 黑活四·bn5>wn4 → 轮白 → 行棋方(白)必败 eval 为负', isLose(evOf(d1)), 'eval=' + JSON.stringify(evOf(d1)));
      ok('P1 推荐点为活四端点（唯一防守位），不是别处', atFourEnd(d1), 'best=' + JSON.stringify(d1 && d1.best));

      // P2: 白活四 + 5黑/4白 → bn>wn → 轮【白】走 → 白一步成五 → 正
      const P2 = mk(2, [[1, 0, 14], [1, 2, 12], [1, 4, 12], [1, 6, 12], [1, 8, 12]]);
      const d2 = await post('/api/analyze', { board: P2, rule: 1, matchMs: 6000000, turnMs: 1500, timeUsedMs: 0, topN: 2, cid: 'sem-p2' });
      ok('P2 白活四·bn5>wn4 → 轮白 → 行棋方(白)必胜 eval 为正', isWin(evOf(d2)), 'eval=' + JSON.stringify(evOf(d2)));
      ok('P2 推荐点为活四端点（成五）', atFourEnd(d2), 'best=' + JSON.stringify(d2 && d2.best));

      // P3: 黑活四 + 4黑/3白 → bn>wn → 轮【白】→ 白必败（与 P1 同结论，验证子数奇偶一致）
      const P3 = mk(1, [[1, 0, 14], [2, 2, 12], [2, 4, 12], [2, 6, 12]]);
      const d3 = await post('/api/analyze', { board: P3, rule: 1, matchMs: 6000000, turnMs: 1500, timeUsedMs: 0, topN: 2, cid: 'sem-p3' });
      ok('P3 黑活四·bn4>wn3 → 轮白 → eval 为负', isLose(evOf(d3)), 'eval=' + JSON.stringify(evOf(d3)));

      // P4: 白活四 + 3黑/4白 → bn<wn → 轮【黑】→ 黑面对白活四必败 → 负
      const P4 = mk(2, [[1, 2, 12], [1, 4, 12], [1, 6, 12]]);
      const d4 = await post('/api/analyze', { board: P4, rule: 1, matchMs: 6000000, turnMs: 1500, timeUsedMs: 0, topN: 2, cid: 'sem-p4' });
      ok('P4 白活四·bn3<wn4 → 轮黑 → eval 为负', isLose(evOf(d4)), 'eval=' + JSON.stringify(evOf(d4)));

      // 【回归铁证】用户截图那一局的真实盘面：黑 8 / 白 7 → 轮白（我执白）。
      // 同色连写旧实现会返回 +M1 且推荐 K3（黑方视角：黑一步成五）；修复后必须是【白方视角】的负值。
      // 注：败方的“最佳防守点”本身可以是任意点位，故只断言「视角」与「不再是黑方必胜」。
      const BLK = ['H8', 'H7', 'G7', 'H6', 'I6', 'I5', 'J6', 'J4'];
      const WHT = ['G9', 'I8', 'F8', 'K7', 'G6', 'H5', 'J5'];
      const SH = empty();
      const putAt = (c, l, v) => { SH[15 - l][c.charCodeAt(0) - 65] = v; };
      BLK.forEach(s => putAt(s[0], +s.slice(1), 1));
      WHT.forEach(s => putAt(s[0], +s.slice(1), 2));
      const d5 = await post('/api/analyze', { board: SH, rule: 1, matchMs: 6000000, turnMs: 2500, timeUsedMs: 0, topN: 3, cid: 'sem-shot' });
      const ev5 = evOf(d5);
      ok('截图盘面(黑8/白7) → 轮白 → 评估为「行棋方=白」视角（不再是黑方一步成五的 +M1）',
        !/^\s*\+M1\s*$/.test(ev5), 'eval=' + JSON.stringify(ev5));
      ok('截图盘面：评估是负值（白方劣势/被将死），即按“我执白”呈现',
        isLose(ev5), 'eval=' + JSON.stringify(ev5));
    }

    // ---------- ①b 我方视角换算：我优=正 ----------
    section('1b) 我方视角换算（我优=正）—— 用面板真实函数断言');
    {
      const fns = ['evalToScore', 'evalToMine', 'sideToMoveColor'].map(grabFn).join('\n');
      const sb = {};
      new Function('exports', 'N', fns + '\nexports.a=evalToScore;exports.b=evalToMine;exports.c=sideToMoveColor;')(sb, N);
      // 我执白(ourIsBlack=false) + 轮黑(toMoveIsBlack=true) → myIsSideToMove=false
      // 引擎(黑视角) -M5 = 黑将败 = 白(我)胜 → 我方视角应为 +M5
      ok('我执白·轮黑·引擎(黑视角)-M5 → 我方 +M5',
        sb.b('-M5', false) === '+M5', sb.b('-M5', false));
      // 我执白·轮白(对方刚落完，不是我们的手) —— 引擎(白视角)+M5 = 我胜 → +M5
      ok('我执白·轮白·引擎(白视角)+M5 → 我方 +M5',
        sb.b('+M5', true) === '+M5', sb.b('+M5', true));
      // 我执黑·轮白·引擎(白视角)+M9 = 白胜 = 我败 → 我方 -M9
      ok('我执黑·轮白·引擎(白视角)+M9 → 我方 -M9',
        sb.b('+M9', false) === '-M9', sb.b('+M9', false));
      const r = sb.a('-M5', false);
      ok('score 与 myEval 同号（+1000/win）', r.score === 1000 && r.verdict === 'win', JSON.stringify(r));
      ok('sideToMoveColor：黑多一子 → 轮白(2)', sb.c((() => { const b = empty(); b[7][7] = 1; return b; })()) === 2);
      ok('sideToMoveColor：等子数 → 轮黑(1)', sb.c((() => { const b = empty(); b[7][7] = 1; b[6][6] = 2; return b; })()) === 1);
    }

    // ---------- ② 热力图边算边铺多彩点：topN=8 时搜索中 pvs 多条 ----------
    section('2) 热力图「边计算边映射多彩定位点」：搜索中 pvs 条数');
    {
      // 均衡中盘（无一方接近五连）→ 搜索跑满预算，便于采样
      const bd = empty();
      [[7, 7], [5, 5], [9, 9], [4, 6], [10, 8], [6, 10], [8, 4]].forEach(([x, y]) => bd[y][x] = 1);
      [[7, 8], [5, 9], [9, 5], [6, 4], [8, 10], [10, 6], [4, 8]].forEach(([x, y]) => bd[y][x] = 2);
      // 黑 7 白 7 → 轮黑

      async function maxLivePvs(topN, cid) {
        const p = post('/api/analyze', { board: bd, rule: 0, matchMs: 6000000, turnMs: 4000, timeUsedMs: 0, topN: topN, cid: cid });
        let mx = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
          const st = await getStatus(cid);
          if (st && st.searching && st.pvs) mx = Math.max(mx, st.pvs.length);
          await new Promise(r => setTimeout(r, 50));
        }
        const d = await p;
        return { mx: mx, finalN: (d && d.candidates && d.candidates.length) || 0, best: d && d.best };
      }

      const a1 = await maxLivePvs(1, 'sem-top1');
      ok('topN=1：搜索中 pvs 恒为 1（旧行为基线）', a1.mx === 1, 'maxPvs=' + a1.mx);
      const a8 = await maxLivePvs(8, 'sem-top8');
      ok('topN=8：搜索中 pvs 能达到多条（>1）→ 可边算边铺多彩点', a8.mx > 1, 'maxPvs=' + a8.mx);
      ok('topN=8：首候选与终选一致（落子推荐未被多 PV 影响）',
        !!a1.best && !!a8.best && a1.best[0] === a8.best[0] && a1.best[1] === a8.best[1],
        'topN1=' + JSON.stringify(a1.best) + ' topN8=' + JSON.stringify(a8.best));
    }
  } catch (e) {
    fail++;
    console.log('  FAIL  FATAL ' + (e && e.stack || e));
  } finally {
    // ---------- ③ 对手圈与热力图同帧（源码守卫，不需要引擎） ----------
    section('3) 对手圆环与热力图同帧出现（源码守卫）');
    try {
      const src = fs.readFileSync(SRC, 'utf8');
      ok('drawOverlay 末尾用 lastOppRings 重投影对手层',
        /if \(S\.oppMoves && lastOppRings && lastOppRings\.length && cal && cv && !boardHasFive\(board\)\) \{[\s\S]{0,140}?drawOppSvg\(cal, board, lastOppRings\)/.test(src));
      ok('重投影带终局闸：五连后绝不投影对手圈（圈乱出的第二道保险）',
        /lastOppRings\.length && !boardHasFive\(board\)\)/.test(src));
      ok('对手圈 = 局面的纯函数（computeOppRings）',
        /function computeOppRings\(reqBoard, myC, oppC, cands, rule\)/.test(src));
      ok('终局 → 0 圈（computeOppRings 首行判 boardHasFive）',
        /function computeOppRings\([\s\S]{0,900}?if \(boardHasFive\(reqBoard\)\) return \[\];/.test(src));
      ok('清层连带作废 lastOppRings（否则同帧重投影会把旧圈复活）',
        /function clearOppSvgLayer\(\) \{[\s\S]{0,700}?lastOppRings = null;[\s\S]{0,80}?lastOppKey = null;/.test(src));
      ok('对手评估周期已收紧（700ms）', /setInterval\(runOppEval, 700\)/.test(src));
ok('对手评估盘面变化即刻触发（kickOppEval）', /function kickOppEval\(\)/.test(src));
      ok('轮对手守卫对所有模式生效（防评估符号按对手帧重算）', /if \(!ourTurn\) \{/.test(src));
      ok('主分析 topN 恒为单路 1（落子=强单路思考）', /var liveTopN = 1;/.test(src) && /topN: liveTopN, cid: CLIENT_ID/.test(src));
    } catch (e) { fail++; console.log('  FAIL  FATAL ' + (e && e.message)); }

    // ---------- ④ 服务端 YXBOARD 序列构造（源码守卫 + 纯逻辑单测） ----------
    section('4) 服务端 moveList 颜色顺序守卫（黑先严格交替，绝不同色连写）');
    try {
      const srvSrc = fs.readFileSync(path.join(ROOT, 'engine-server', 'engine-server.js'), 'utf8');
      ok('已删除「同色连写」重建分支',
        !/必须“同色连写”/.test(srvSrc) && !/for \(const b of black\) out\.push\(\[b\[0\], SIZE - 1 - b\[1\], 1\]\)/.test(srvSrc));
      ok('存在「黑先严格交替」序列构造（seq.push(1)/seq.push(2) 交错）',
        /for \(let i = 0; i < maxLen; i\+\+\) \{[\s\S]{0,120}?seq\.push\(1\)[\s\S]{0,80}?seq\.push\(2\)/.test(srvSrc));
      ok('新增行棋方自检（纯 JS 断言 expSide === seqSide）',
        /const expSide = \(bn0 > wn0\) \? 2 : 1;/.test(srvSrc) && /const seqSide = \(moves\.length % 2 === 1\) \? 2 : 1;/.test(srvSrc));
      ok('自检与面板 sideToMoveColor 同式（bn > wn ? 白 : 黑）',
        /return \(bn > wn\) \? 2 : 1;/.test(fs.readFileSync(SRC, 'utf8')));

      // 纯逻辑单测：从服务端源码抽出 toEngineMoveList 实跑
      // ⚠ 切片前必须把行尾归一成 LF：本文件在 Windows 上是 **CRLF**，而下面用的是
      //   '\n}\n' 这个模式 —— 不归一就永远匹配不到（indexOf 返回 -1），body 被切成空串，
      //   于是在调用处抛 "toEngineMoveList is not defined"。这个假红与引擎语义无关。
      const srvLf = srvSrc.replace(/\r\n/g, '\n');
      const at = srvLf.indexOf('function toEngineMoveList(');
      const body = srvLf.slice(at, srvLf.indexOf('\n}\n', at) + 3);
      if (at < 0 || body.length < 20) throw new Error('无法从 engine-server.js 抽出 toEngineMoveList');
      const fn = new Function('SIZE', body + '\nreturn toEngineMoveList;')(N);
      const mkBoard = (blk, wht) => {
        const b = empty();
        blk.forEach(s => { b[15 - (+s.slice(1))][s.charCodeAt(0) - 65] = 1; });
        wht.forEach(s => { b[15 - (+s.slice(1))][s.charCodeAt(0) - 65] = 2; });
        return b;
      };
      const cases = [
        ['空盘', [], []],
        ['1黑', ['H8'], []],
        ['1黑1白', ['H8'], ['G8']],
        ['2黑1白', ['H8', 'G7'], ['G8']],
        ['2黑2白', ['H8', 'G7'], ['G8', 'I8']],
        ['截图 8黑7白', ['G7', 'H6', 'H7', 'H8', 'I5', 'I6', 'J4', 'J6'], ['F8', 'G6', 'G9', 'H5', 'I8', 'J5', 'K7']],
      ];
      let allAlt = true, allParity = true, allColors = true, allUnique = true;
      for (const [, blk, wht] of cases) {
        const b = mkBoard(blk, wht);
        const out = fn(b, null);
        const bn = blk.length, wn = wht.length;
        // ① 首 token 必为黑（selfColor=BLACK）
        if (out.length && out[0][2] !== 1) allAlt = false;
        // ② 交错部分严格 1,2,1,2…（多出的子只在末尾重复）
        const pairs = Math.min(bn, wn);
        for (let i = 0; i < out.length; i++) {
          const expect = (i % 2 === 0) ? 1 : 2;
          if (i < pairs * 2) { if (out[i][2] !== expect) allAlt = false; }
        }
        // ③ 奇偶 → SideToMove 必须等于 (bn > wn ? 白 : 黑)
        const seqSide = (out.length % 2 === 1) ? 2 : 1;
        if (bn >= wn && bn - wn <= 1 || wn >= bn && wn - bn <= 1) {
          if (seqSide !== (bn > wn ? 2 : 1)) allParity = false;
        }
        // ④ 每 token 的颜色必须等于盘面该格颜色
        for (const t of out) { const py = 15 - 1 - t[1]; if (b[py][t[0]] !== t[2]) allColors = false; }
        // ⑤ 不重复落同一格，且覆盖全部棋子
        const seen = new Set();
        for (const t of out) seen.add(t[0] + ',' + t[1]);
        if (seen.size !== out.length || out.length !== bn + wn) allUnique = false;
      }
      ok('首 token 恒为黑 + 交错部分严格 1,2,1,2…', allAlt);
      ok('序列奇偶 → SideToMove 恒等于 (bn > wn ? 白 : 黑)', allParity);
      ok('token 颜色与盘面颜色逐格一致', allColors);
      ok('不重复落子且覆盖全部棋子', allUnique);
    } catch (e) { fail++; console.log('  FAIL  FATAL ' + (e && e.message)); }

    try { srv.kill('SIGKILL'); } catch (e) {}
    console.log('\n--- live-semantics: ' + pass + ' passed, ' + fail + ' failed ---');
    process.exit(fail ? 1 : 0);
  }
})();
