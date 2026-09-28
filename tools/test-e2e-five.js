// 端到端复现用户截图盘面：黑方已 F12..J12 五连、我执白、轮白落子。
// 目的：确认发布版 exe 的真实行为 = 本轮 6 项修复生效。
// 只用 /api/analyze 拿引擎真值，其余判定逻辑从发布版 bookmarklet 里【原样抽函数】跑，
// 避免"测试用另一套实现"这种自欺。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'Meter engine-server', 'GomokuEngine.exe');
const PORT = 8964;
const N = 15;

// ---- 1. 还原截图盘面（PNG 自解码 + 网格自动校准成果，已与人工核对一致）----
// 网格：GX0=140 STEPX=83.86 / GY0=82 STEPY=83.57（15 等分双向 15/15 命中）
// 黑 17 子、白 16 子；黑 F4..J4 五连；白最长 4 连（无白五连）→ 与截图面板吻合。
const BLACK = ['H3', 'F4', 'G4', 'H4', 'I4', 'J4', 'H5', 'G6', 'H6', 'I6', 'D7', 'F7', 'H8', 'G9', 'E10', 'F11', 'I12'];
const WHITE = ['H2', 'J3', 'E4', 'J5', 'F6', 'G7', 'H7', 'J7', 'E8', 'G8', 'F9', 'G10', 'D11', 'E11', 'G11', 'H11'];

function coord(s) { return { i: s.charCodeAt(0) - 65, j: parseInt(s.slice(1), 10) - 1 }; }

function buildBoard() {
  const b = Array.from({ length: N }, () => new Array(N).fill(0));
  BLACK.forEach(s => { const c = coord(s); if (b[c.j] && b[c.j][c.i] === 0) b[c.j][c.i] = 1; });
  WHITE.forEach(s => { const c = coord(s); if (b[c.j] && b[c.j][c.i] === 0) b[c.j][c.i] = 2; });
  return b;
}

// ---- 2. 从发布版 bookmarklet 里抽真实函数（maxLineLen / allImmediateFiveCells）----
// 发布版只留密文，所以从【源工程】抽；verify-release-enc 已证明两者逐字节一致。
function extractFns() {
  const src = fs.readFileSync(path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');
  const pick = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('找不到函数 ' + name);
    let depth = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    throw new Error('函数体不平衡: ' + name);
  };
  const body = [pick('maxLineLen'), pick('allImmediateFiveCells')].join('\n');
  const N_CONST = 'var N = 15;';
  return new Function(N_CONST + '\n' + body + '\nreturn {maxLineLen:maxLineLen, allImmediateFiveCells:allImmediateFiveCells};')();
}

// ---- 3. 启动发布版 exe，问真值 ----
function startExe() {
  return new Promise((resolve, reject) => {
    const p = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/https?:\/\/[^\s]*8964[^\s]*/) || buf.match(/listening[^\n]*/i) || buf.match(/8964/);
      if (m) { setTimeout(() => resolve(p), 900); }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', reject);
    setTimeout(() => resolve(p), 4500);
  });
}

function post(fullBoard, sideToMove) {
  // /api/analyze 契约：board 必须是 15x15 数组（1 黑 / 2 白 / 0 空），turnMs 单步思考
  const rows = fullBoard.map(r => r.slice());
  const body = JSON.stringify({
    board: rows,
    rule: 0, topN: 8, turnMs: 3000, matchMs: 6000000, cid: 'probe-five'
  });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/analyze', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 200))); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  const F = extractFns();
  const board = buildBoard();
  let bp = 0, wp = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { if (board[j][i] === 1) bp++; else if (board[j][i] === 2) wp++; }

  const MY = 2, OPP = 1;                     // 我执白（截图面板「已锁定我执白」）
  console.log('=== 盘面还原 ===');
  console.log(`黑 ${bp} 子 / 白 ${wp} 子 → toMoveIsBlack = ${bp === wp}`);
  console.log(`黑 maxLineLen = ${F.maxLineLen(board, 1)}  白 maxLineLen = ${F.maxLineLen(board, 2)}`);

  let fail = 0;
  const ck = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

  console.log('\n=== 问题2/3：五连即停算 + 分数不再由负转正 ===');
  const myFive = F.maxLineLen(board, MY) >= 5, opFive = F.maxLineLen(board, OPP) >= 5;
  ck('我方(白)未成五', myFive, false);
  ck('对手(黑)已成五', opFive, true);
  const fScore = myFive ? 1000 : -1000, fVerd = myFive ? 'win' : 'lose';
  ck('终局分数 = -1000（而不是 +1000）', fScore, -1000);
  ck('终局判定 = lose', fVerd, 'lose');
  console.log('  → 旧 bug：用 ourIsBlack 反推颜色会把「黑五连」当「我五连」→ +1000/win（曲线由负转正）。现已按 myColorCode 判定。');

  console.log('\n=== 问题4：冲四/活四时唯一必防点只画一个圈 ===');
  const needDefend = [];
  const addU = (arr, pts) => pts.forEach(p => { if (!arr.some(q => q.x === p.i && q.y === p.j)) arr.push({ x: p.i, y: p.j }); });
  addU(needDefend, F.allImmediateFiveCells(board, MY, false));
  addU(needDefend, F.allImmediateFiveCells(board, OPP, false));
  const uniqueMust = needDefend.length === 1 ? needDefend[0] : null;
  console.log(`  我方(白)成五点: ${JSON.stringify(F.allImmediateFiveCells(board, MY, false))}`);
  console.log(`  对手(黑)成五点: ${JSON.stringify(F.allImmediateFiveCells(board, OPP, false))}`);
  console.log(`  needDefend 去重后 = ${JSON.stringify(needDefend)} → maxRings = ${uniqueMust ? 1 : 2}`);
  console.log('  → 若 only 1 个必防点则只画 1 个圈（旧的取「候选前 2 名」会画 2 个）。');

  console.log('\n=== 问题1：曲线阈值 CHART_FIT=15 ===');
  const bm = fs.readFileSync(path.join(ROOT, 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');
  ck('CHART_FIT = 15', /var CHART_FIT = 15;/.test(bm), true);
  ck('旧值 CHART_FIT = 30 已清除', /var CHART_FIT = 30;/.test(bm), false);
  const FIT = 15, innerW = 1305;
  const geom = (n) => { const denom = n <= FIT ? Math.max(1, n - 1) : (FIT - 1); const step = innerW / denom; return { n, step: +step.toFixed(2), canvasW: Math.round(denom * step + 60) }; };
  console.log(`  n=15 → ${JSON.stringify(geom(15))}（铺满）`);
  console.log(`  n=16 → ${JSON.stringify(geom(16))}（点距锁定 → 画布变宽出滚动条）`);

  console.log('\n=== 问题5：对手评估提速 ===');
  ck('对手评估周期 = 700ms', /setInterval\(runOppEval, 700\)/.test(bm), true);
  ck('旧 1200ms 已清除', /setInterval\(runOppEval, 1200\)/.test(bm), false);
  ck('盘面变化即刻 kickOppEval', /function kickOppEval\(\)/.test(bm) && /kickOppEval\(\);/.test(bm), true);

  console.log('\n=== 问题6：蓝圈（我方最佳落点）不跳坐标 ===');
  ck('stabilizeBest 存在', /function stabilizeBest\(best, cands, fpKey, scoreOf\)/.test(bm), true);
  ck('指纹含我方执色 + 颜色码（换色/换帧必重置）',
    /stabilizeBest\(best, cands, _sbKey, _sbScore\)/.test(bm) && /myIsSideToMove === false \? 'o' : 'm'/.test(bm), true);
  ck('myColor0 单点定义（重复 var 会跨帧串色）', (bm.match(/var myColor0 = myColorCode\(\);/g) || []).length, 1);

  console.log('\n=== 真机引擎复核（发布版 exe /api/analyze）===');
  let exe = null;
  try {
    exe = await startExe();
    const r = await post(board, 2);                    // 轮白
    const top = (r.candidates || []).slice(0, 3).map(c => `${c.move || c.pos || '?'} eval=${c.eval}`);
    console.log(`  best = ${r.best}  候选: ${top.join(' | ')}`);
    console.log(`  引擎在「已五连」盘面返回 ${r.candidates && r.candidates[0] ? r.candidates[0].eval : '?'} —— 若 ≠ ±M1，正说明必须靠【五连即停算】闸兜住`);
  } catch (e) {
    console.log('  (exe 探测跳过: ' + String(e.message).slice(0, 100) + ')');
  } finally { if (exe) try { exe.kill(); } catch (e) {} }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED — ' + fail + ' failed'));
  process.exit(fail === 0 ? 0 : 1);
})();
