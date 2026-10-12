/* 热力图「分流 / 及时」真机验证（需要引擎在 :8964 上跑）
 * ----------------------------------------------------------------------------
 * 为什么单独有这一个：test-heat-live.js 走的是无头浏览器 + 虚拟时钟，
 *   `--virtual-time-budget` 会在有未决 fetch 时**暂停虚拟时间** —— 于是它那个
 *   「T+1.2s」快照其实是在两条请求都回来之后才拍的（日志里 `T+1.2s moves=2`）。
 *   它能证明「热力格/分数/档位/不压子」都对，但**证不了「及时」**。
 *
 * 这里改用**引擎侧真实墙钟**来证明：
 *   · 并行：main 车道（AI 落子，turnMs=5000）与 sub 车道（热力，2500ms）**同时**发出
 *           → 总耗时 ≈ max(两者)，而不是两者之和（= 没有排队）；
 *   · 及时：sub 车道**先于** main 车道返回 → 热力一定铺在「AI 还在深搜」的时候；
 *   · 可用：sub 真能给出 ≥4 条带评估分的候选 → 四档色带铺得开、格内数字有内容。
 *
 * 用法：先起引擎（Web GomokuEngine.exe --as-backend），再 node tools/test-heat-lane.js
 */
'use strict';

const URL = 'http://127.0.0.1:8964/api/analyze';
const N = 15;
const MAIN_MS = 5000;
const SUB_MS = 2500;

let pass = 0, fail = 0;
function P(l, v) { pass++; console.log('  \u2713 ' + l + ' | ' + v); }
function F(l, v) { fail++; console.log('  \u2717 ' + l + ' | ' + v); }

function mkBoard() {
  const b = [];
  for (let y = 0; y < N; y++) { const r = []; for (let x = 0; x < N; x++) r.push(0); b.push(r); }
  b[7][7] = 1; // 我执黑，先手占天元 → 轮到 AI（白）
  return b;
}

async function req(board, turnMs, topN, lane) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board, moveList: [], matchMs: 600000, turnMs, timeUsedMs: 0,
        topN, rule: 0, cid: 'lane-' + lane + '-' + topN, lane,
      }),
      signal: ctl.signal,
    });
    const txt = await res.text();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let json = null; try { json = JSON.parse(txt); } catch (e) {}
    return { ms, json, txt };
  } finally { clearTimeout(t); }
}

async function main() {
  // 0) 引擎活着吗
  let probe;
  try { probe = await req(mkBoard(), 600, 1, 'main'); }
  catch (e) { console.error('引擎不可达 :8964 —— 先起 Web GomokuEngine.exe --as-backend'); process.exit(1); }
  if (!probe.json || !(probe.json.candidates || []).length) {
    console.error('引擎无候选返回：' + probe.txt.slice(0, 200)); process.exit(1);
  }
  console.log('  · 引擎就绪，探测耗时 ' + probe.ms.toFixed(0) + 'ms');

  // 1) 并行：两条车道同时发
  const t0 = process.hrtime.bigint();
  const [mainR, subR] = await Promise.all([
    req(mkBoard(), MAIN_MS, 1, 'main'),
    req(mkBoard(), SUB_MS, 8, 'sub'),
  ]);
  const parMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  · 并行 main=' + mainR.ms.toFixed(0) + 'ms sub=' + subR.ms.toFixed(0) + 'ms' +
              ' 总墙钟=' + parMs.toFixed(0) + 'ms');

  const mc = (mainR.json && mainR.json.candidates) || [];
  const sc = (subR.json && subR.json.candidates) || [];
  if (mc.length) P('main 车道（AI 落子）有候选', 'n=' + mc.length + ' eval=' + mc[0].eval); else F('main 车道（AI 落子）有候选', '0');

  // ★ 及时：热力必须先于 AI 深搜返回
  if (sc.length && subR.ms < mainR.ms) {
    P('热力（sub 车道）先于 AI 落子（main 车道）返回 → 铺在「AI 还在深搜」时',
      'sub ' + subR.ms.toFixed(0) + 'ms < main ' + mainR.ms.toFixed(0) + 'ms');
  } else {
    F('热力（sub 车道）先于 AI 落子（main 车道）返回 → 铺在「AI 还在深搜」时',
      'sub ' + subR.ms.toFixed(0) + 'ms vs main ' + mainR.ms.toFixed(0) + 'ms (n=' + sc.length + ')');
  }

  // ★ 并行不排队：总墙钟应接近 max，而不是 sum
  const sumOnly = mainR.ms + subR.ms;
  if (parMs < sumOnly * 0.8) {
    P('两条车道确实并行（总耗时≈max，不是 sum）',
      'parallel ' + parMs.toFixed(0) + 'ms << sequential ' + sumOnly.toFixed(0) + 'ms');
  } else {
    F('两条车道确实并行（总耗时≈max，不是 sum）',
      'parallel ' + parMs.toFixed(0) + 'ms vs sequential ' + sumOnly.toFixed(0) + 'ms');
  }

  // 2) 热力格数据可用：≥4 条、每条都有数值评估分
  if (sc.length >= 4) P('热力候选 ≥4 条 → 四档色带铺得开', 'n=' + sc.length);
  else F('热力候选 ≥4 条 → 四档色带铺得开', 'n=' + sc.length);
  const withEv = sc.filter((c) => typeof c.eval === 'number' || /^[-+]?(M\d+|\d+)$/.test(String(c.eval)));
  if (sc.length && withEv.length === sc.length) {
    P('每条热力候选都带数值评估分（格内数字 = 评估分）', sc.map((c) => c.eval).join(' '));
  } else {
    F('每条热力候选都带数值评估分（格内数字 = 评估分）', withEv.length + '/' + sc.length);
  }

  // 3) 顺序基线：再跑一遍「先 main 后 sub」，用来对比并行
  const s0 = process.hrtime.bigint();
  await req(mkBoard(), MAIN_MS, 1, 'main');
  await req(mkBoard(), SUB_MS, 8, 'sub');
  const seqMs = Number(process.hrtime.bigint() - s0) / 1e6;
  console.log('  · 顺序基线（main 完再 sub）=' + seqMs.toFixed(0) + 'ms');
  if (parMs < seqMs * 0.8) {
    P('并行比顺序显著更快（分车道真的省了时间）',
      'parallel ' + parMs.toFixed(0) + 'ms vs sequential ' + seqMs.toFixed(0) + 'ms');
  } else {
    F('并行比顺序显著更快（分车道真的省了时间）',
      'parallel ' + parMs.toFixed(0) + 'ms vs sequential ' + seqMs.toFixed(0) + 'ms');
  }

  console.log('--- test-heat-lane: ' + pass + ' passed, ' + fail + ' failed ---');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });
