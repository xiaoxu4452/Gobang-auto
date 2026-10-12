'use strict';
const http = require('http');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

const CWD = path.join(__dirname, '..', 'Meter engine-server');
// 网页端 exe 已改名带 Web 前缀（与桌面端 Desktop GomokuOverlay.exe 区分）
const EXE = path.join(CWD, 'Web GomokuEngine.exe');
const srv = cp.spawn(EXE, [], { cwd: CWD, stdio: 'ignore' });

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 8964, path: p }, (r) => {
      // 【勿逐块 += 转字符串】HTTP 分块会把多字节中文切在块边界上，逐块 toString()
      // 会把它变成替换符、凭空多出字符（曾让「源 250478 / 发布 250479」看起来差 1 字节，
      // 其实发布版和源逐字节一致）。必须 Buffer.concat 后再解码。这里直接返回 Buffer，
      // 让调用方既能取字符串、也能做逐字节比对。
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => res(Buffer.concat(c)));
    }).on('error', rej);
  });
}
(async () => {
  let html = '';
  for (let i = 0; i < 120; i++) {
    try { html = (await get('/')).toString('utf8'); if (html.length > 500) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  let bmBuf = null;
  try { bmBuf = await get('/bookmarklet.js'); } catch (e) {}
  const bm = bmBuf ? bmBuf.toString('utf8') : '';
  // 【发布版必须与源工程一致】——历史反复出现「本地 debug 版是对的，发布版还是老的」。
  // 根因是构建期内嵌了陈旧产物 / SEA blob 未真正刷新。这里做一道硬核对：
  // 把「源工程 bookmarklet.js」与「发布版实际下发的 bookmarklet.js」逐项比对关键特征，
  // 任何一项对不上都直接 FAIL，避免又交付一个跑旧代码的发布包。
  let srcBm = '';
  try { srcBm = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js'), 'utf8'); } catch (e) {}

  // 逐字节硬核对（最强的一条：包与源必须一模一样）
  let srcBuf = null;
  try { srcBuf = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js')); } catch (e) {}
  let byteExact = false, byteMsg = '';
  if (srcBuf && bmBuf) {
    byteExact = srcBuf.length === bmBuf.length && srcBuf.equals(bmBuf);
    if (byteExact) byteMsg = '（' + srcBuf.length + ' bytes 完全一致）';
    else {
      let i = 0; const n = Math.min(srcBuf.length, bmBuf.length);
      while (i < n && srcBuf[i] === bmBuf[i]) i++;
      byteMsg = '（源 ' + srcBuf.length + ' / 发布 ' + bmBuf.length + ' bytes，首个不同字节 @' + i + '）';
    }
  } else {
    byteMsg = '（取源文件或下发内容失败）';
  }
  console.log('--- 源工程 bookmarklet ' + (srcBuf ? srcBuf.length : 0) + ' bytes / 发布版下发 ' +
    (bmBuf ? bmBuf.length : 0) + ' bytes  byte-equal=' + byteExact);
  // 计算一致性结果（checks 声明后再 push，见下方）
  let releaseSyncOk = false, releaseSyncMsg = '';
  if (srcBm.length) {
    const marks = [
      ['evalToMine 我方视角归一', 'function evalToMine(evStr, myIsSideToMove)'],
      ['pushHistPoint 统一入点', 'function pushHistPoint(ply, value)'],
      ['曲线阈值 CHART_FIT=15', 'var CHART_FIT = 15;'],
      ['曲线按可视宽度取基准', 'var viewW = (csc && csc.clientWidth) ? csc.clientWidth : 0;'],
      ['evalToScore valid 标记', 'matePly: 0, valid: false'],
      ['M 值也入点（无 isNaN 跳过）', null],
      ['持久化含 myEval', 'myEval: S.myEval'],
      ['轮到对手不评估 return（不限模式）', 'if (!ourTurn) {'],
      ['落子强单路 topN=1', 'var liveTopN = 1;'],
    ];
    let same = 0, tot = 0;
    const miss = [];
    marks.forEach(([label, needle]) => {
      tot++;
      const inSrc = needle === null ? (srcBm.indexOf('if (!isNaN(numEv) &&') < 0) : srcBm.indexOf(needle) >= 0;
      const inRel = needle === null ? (bm.indexOf('if (!isNaN(numEv) &&') < 0) : bm.indexOf(needle) >= 0;
      if (inSrc === inRel) same++; else miss.push(label + '(src=' + inSrc + ',rel=' + inRel + ')');
    });
    releaseSyncOk = (same === tot);
    releaseSyncMsg = ' (' + same + '/' + tot + ')' + (miss.length ? ' ⚠ 不一致: ' + miss.join('; ') : '');
  }
  // 取出 .copyBtn 规则本体（到下一个选择器为止），只针对按钮本身判定配色
  const cbAt = html.indexOf('.copyBtn{');
  const copyBtnRule = cbAt < 0 ? '' : html.slice(cbAt, html.indexOf('}', cbAt) + 1);
  // 包内文件卫生：直接在磁盘上 stat 发布目录（不信任构建脚本的自我报告）
  // 必须在 checks 数组之前算好 —— 数组字面量会立刻求值，放后面会踩 TDZ。
  const hygiene = { intermediates: [], stale: [], plain: [], junk: [] };
  try {
    for (const f of ['engine.blob', 'sea-config.json', 'engine-server.js']) {
      if (fs.existsSync(path.join(CWD, f))) hygiene.intermediates.push(f);
    }
    for (const f of fs.readdirSync(CWD)) {
      if (/\.(old|bak)$/i.test(f)) hygiene.stale.push(f);
      if (/\.(log|tmp|ts)$/i.test(f)) hygiene.junk.push(f);
    }
    for (const f of ['panel.html', 'panel-ui.js', 'bridge.js']) {
      if (fs.existsSync(path.join(CWD, 'overlay', f))) hygiene.plain.push('overlay/' + f);
    }
  } catch (e) { hygiene.intermediates.push('readdir 失败: ' + e.message); }

  const checks = [
    ['exe 可访问', html.length > 500],
    // 启动页
    ['启动页: 代码框标题栏 codeBar', html.indexOf('codeBar') >= 0],
    ['启动页: 关闭按钮 gb_code_close', html.indexOf('gb_code_close') >= 0],
    ['启动页: hideCode 逻辑', html.indexOf('function hideCode') >= 0],
    ['启动页: max-height 限高', html.indexOf('max-height:320px') >= 0],
    ['启动页: 已去掉「可拖动下边缘」文案', html.indexOf('可拖动下边缘') < 0],
    ['启动页: 交换棋提示仍在', html.indexOf('交换棋提示') >= 0],
    ['启动页: 一键复制按钮', html.indexOf('一键复制书签代码') >= 0],
    // 启动页 · 英文模式完整适配
    ['启动页 EN: 书签按钮有英文文案', html.indexOf('>Gomoku Assistant<') >= 0],
    ['启动页 EN: 复制按钮有英文文案', html.indexOf('>Copy bookmarklet code<') >= 0],
    ['启动页 EN: 复制反馈有英文文案', html.indexOf("done:'Copied") >= 0 && html.indexOf("manual:'Press Ctrl+C'") >= 0],
    ['启动页 EN: close 标签同步', html.indexOf('syncCloseLabel') >= 0],
    ['启动页: 复制按钮为浅蓝 #7ea9e8', copyBtnRule.indexOf('#7ea9e8') >= 0],
    ['启动页: 复制按钮已无旧深蓝 #3574d4', copyBtnRule.indexOf('#3574d4') < 0],
    // 面板
    ['面板: sideIsManual()', bm.indexOf('sideIsManual') >= 0],
    ['面板: clampSide 自愈', bm.indexOf('clampSide') >= 0],
    ['面板: __gb_side_txt 读数', bm.indexOf('__gb_side_txt') >= 0],
    ['面板: sideStatusText()', bm.indexOf('sideStatusText') >= 0],
    ['面板: 未选先后手则不动', bm.indexOf('点选<b>黑</b>或<b>白</b>后再开始') >= 0],
    ['面板: AUTO_SIDE 自动识别已关闭', bm.indexOf('var AUTO_SIDE = false;') >= 0],
    ['面板: 白子按钮无蓝色轮廓', bm.indexOf('0 0 0 2px #3b7dd8') < 0],
    ['面板: 收官闸（下完最后一子）', bm.indexOf('【收官闸】') >= 0],
    ['面板: 曲线入点同手覆盖（不重复加点）',
      bm.indexOf('if (lastP && lastP.i === ply) { lastP.v = v; return; }') >= 0],
    ['面板: 存在 pushHistPoint 统一入点', bm.indexOf('function pushHistPoint(ply, value)') >= 0],
    // 面板 · 只评估用户所选那一手（不跨黑白）
    ['面板: 颜色指纹 fp 含我执色', bm.indexOf("myColorCode() + '#'") >= 0],
    ['面板: 请求快照 reqOurIsBlack', bm.indexOf('var reqOurIsBlack = ourIsBlack') >= 0],
    ['面板: 颜色一致性丢弃闸', bm.indexOf('reqOurIsBlack !== ourIsBlack') >= 0],
    ['面板: M1 停算闸', bm.indexOf('【M1 停算闸】') >= 0],
    ['面板: M1 后停止评估文案', bm.indexOf('已停止评估，等待下一局') >= 0],
    ['面板: 换手后清空旧色产物', bm.indexOf('lastOppGeom = null') >= 0],
    // 面板 · 评估栏与曲线（形态参考 gomocalc，视角/入点为本项目定制，见 test-evalcurve.js 头注）
    ['面板: 评估栏走 rawEvalText()', bm.indexOf('function rawEvalText()') >= 0],
    ['面板: 评估栏不再自拼 +M/-M', bm.indexOf("if (S.verdict === 'win') ev = '+M'") < 0],
    ['面板: evalToScore 旧 log10 幅度公式已删', bm.indexOf('1000 - 500 * Math.log10(nMV)') < 0],
    // ★ 我方视角：评估值与评估曲线都是「我们执子」的评估
    ['面板: 存在 evalToMine 我方视角归一', bm.indexOf('function evalToMine(evStr, myIsSideToMove)') >= 0],
    ['面板: 面板评估栏读 myEval（我方视角）', bm.indexOf('var s = S.myEval;') >= 0],
    ['面板: 状态栏评估读 myEval', bm.indexOf('(typeof S.myEval === \'string\' && S.myEval.length) ? S.myEval') >= 0],
    ['面板: 实时轮询归一我方视角', bm.indexOf('var lMine = lRaw ? evalToMine(lRaw, myIsSideToMove) : \'\';') >= 0],
    ['面板: 主分析写入 myEval', bm.indexOf('S.myEval = S.rawEval ? evalToMine(S.rawEval, myIsSideToMove) : \'\';') >= 0],
    // ★ 每一子都要有曲线映射（M/-M 归一到 ±1000，不再跳过）
    ['面板: M 值也入点（旧的 isNaN 跳过已删）', bm.indexOf('if (!isNaN(numEv) &&') < 0],
    ['面板: 无条件入点 pushHistPoint', bm.indexOf('if (pv != null) pushHistPoint(plyNow, pv);') >= 0],
    ['面板: evalToScore 带 valid 标记', bm.indexOf('matePly: 0, valid: false') >= 0],
    ['面板: 曲线点结构 {i:手数, v:分值}', bm.indexOf('S.history.push({ i: ply, v: v })') >= 0],
    // ★ 曲线动态：≤15 铺满 → >15 延伸（用户要求「满 15 个坐标点向后延伸」）
    ['面板: 曲线阈值 CHART_FIT=15', bm.indexOf('var CHART_FIT = 15;') >= 0],
    ['面板: 曲线按可视宽度取基准', bm.indexOf('var viewW = (csc && csc.clientWidth) ? csc.clientWidth : 0;') >= 0],
    ['面板: 曲线点距动态（≤15 铺满 / >15 锁定）',
      bm.indexOf('var denom = (n <= CHART_FIT) ? Math.max(1, n - 1) : (CHART_FIT - 1);') >= 0],
    ['面板: 曲线 px 以点序为自变量', bm.indexOf('var px = function (k) {') >= 0],
    ['面板: 曲线旧「固定 11px/手」实现已删',
      bm.indexOf('var MIN_PLIES = 18') < 0 && bm.indexOf('var pointW = 11') < 0],
    ['面板: 曲线旧「拉伸铺满」公式已删',
      bm.indexOf('return padL + (i / Math.max(1, n - 1)) * innerW;') < 0],
    // ★ 不评估对手：守卫必须对所有模式生效（本轮修复：手动模式轮对手时也不得重算 eval/推曲线）
    ['面板: 轮到对手不评估（等待即 return，且不限自动模式）',
      bm.indexOf('if (!ourTurn) {') >= 0 &&
      bm.indexOf('等待对手落子…') >= 0 &&
      /if \(!ourTurn\) \{[\s\S]{0,360}?return;\s*\}/.test(bm)],
    ['面板: 旧的「仅自动模式」守卫已移除', bm.indexOf('if (S.autoPlay && !ourTurn) { setStatus') < 0],
    // ★ 落子走「强单路」、评估走「多路」：主分析 topN 永远=1（单路深搜，落子 best 最稳）；
    //   多路 topN=8 交给独立补充搜索 refreshOverlayCands 出热图/对手圈（与落子决策解耦，不借主搜索顺带出图）。
    ['面板: 主分析 topN 恒为单路 1（落子=强单路思考）', bm.indexOf('var liveTopN = 1;') >= 0 &&
      bm.indexOf('topN: liveTopN, cid: CLIENT_ID') >= 0],
    ['面板: 多路 topN=8 由补充搜索承担（热图/对手圈评估）', bm.indexOf('topN: 8, cid: CLIENT_ID') >= 0],
    ['面板: 自动落子时落子决策留足算力（turnMs 下限 2.5s）', bm.indexOf('var moveTurnMs = (S.autoPlay ? Math.max(effTurn, 2500) : effTurn);') >= 0],
    // ★ 对手圈与热力图同帧：drawOverlay 末尾重投影对手层
    //   【本轮收紧】重投影必须带终局闸 `!boardHasFive(board)`（五连后棋局结束 → 绝不再投影）
    ['面板: 对手圈与热力图同帧（drawOverlay 末尾重投影 + 终局闸）',
      /if \(S\.oppMoves && lastOppRings && lastOppRings\.length && cal && cv && !boardHasFive\(board\)\) \{[\s\S]{0,140}?drawOppSvg\(cal, board, lastOppRings\)/.test(bm)],
    ['面板: 清层连带作废 lastOppRings/lastOppKey（防旧圈被重投影复活）',
      bm.indexOf('lastOppRings = null; lastOppKey = null;') >= 0],
    // ★ 对手评估提速：700ms 周期 + 盘面变化即刻 kick（用户反馈「慢了一点」）
    ['面板: 对手评估周期收紧到 700ms',
      bm.indexOf('setInterval(runOppEval, 700)') >= 0 && bm.indexOf('setInterval(runOppEval, 1200)') < 0],
    ['面板: 对手评估支持盘面变化即刻触发', bm.indexOf('function kickOppEval() {') >= 0 &&
      bm.indexOf('kickOppEval();') >= 0],
    // ★ 本轮新语义：五连即停算 + 唯一必防点只画一个 + 最佳落点稳定器
    ['面板: 五连即停算闸（纯盘面判定）', bm.indexOf('【★ 五连即停算（用户明确要求）★】') >= 0 &&
      bm.indexOf('已停止评估，等待下一局') >= 0],
    // ★ 本轮新增：终局权威闸（我方落第 5 子后彻底停算）
    //   位置契约：必须在 myColor0 解析之后、`if (!ourTurn)` 之前 —— 旧的五连闸在 ourTurn
    //   之后，终局那手轮次一翻转（转对手）就执行不到，用户看到"第五子下完了还在评估"。
    ['面板: 终局权威闸（盘面五连 → 轮次判断前短路）',
      bm.indexOf('【★ 终局权威闸（本轮新增 · 最高优先级）★】') >= 0 &&
      bm.indexOf('【★ 终局权威闸（本轮新增 · 最高优先级）★】') < bm.indexOf('if (!ourTurn) {') &&
      bm.indexOf('【★ 终局权威闸（本轮新增 · 最高优先级）★】') > bm.indexOf('var myColor0 = myColorCode();')],
    ['面板: 终局权威闸上持久化锁（只有新局/手动换色才解）',
      bm.indexOf('function setGameOverLock(reason)') >= 0 &&
      bm.indexOf('function clearGameOverLock()') >= 0 &&
      bm.indexOf('function gameOverLocked()') >= 0 &&
      bm.indexOf('if (n === 0 && !gameOverLocked())') >= 0 &&
      bm.indexOf("haltReason = ''; clearGameOverLock();  // 新局") >= 0],
    ['面板: 停算原因随曲线落盘（跨会话续停算）',
      bm.indexOf('halt: haltForNewGame, hr: haltReason') >= 0 &&
      bm.indexOf("if (haltReason === 'five-my' || haltReason === 'five-opp') setGameOverLock(haltReason)") >= 0],
    // ★ 本轮新增：开局行棋方权威（修「新开局白子错乱下子」）
    ['面板: 开局行棋方权威 openingSideToMove（空盘恒黑先）',
      bm.indexOf('function openingSideToMove(board)') >= 0 &&
      bm.indexOf('if (bn === 0 && wn === 0) return 1;') >= 0],
    ['面板: isOurTurnOn 单点定义（颜色未定 → 绝不当成轮我方）',
      bm.indexOf('function isOurTurnOn(board, stm)') >= 0 &&
      bm.indexOf('if (me === 0) return false;') >= 0],
    ['面板: 轮次/指纹/ourTurn 全部改走权威函数（旧代数式已清除）',
      bm.indexOf('var toMoveIsBlack = (bCnt === wCnt);') < 0 &&
      bm.indexOf('var fpToMoveIsBlack = (fpB === fpW);') < 0 &&
      // ★ 2026-09-26：权威函数已从 openingSideToMove 进化为 stmFromDiff（帧差分轮次锚定，
      //   含 openingSideToMove 语义作为回落）—— 断言跟随新权威形态，旧代数式仍必须清除。
      (bm.indexOf('var stmColor = stmFromDiff(board, bCnt, wCnt, prevFrameBoard, lastStmColor);') >= 0 ||
       bm.indexOf('var stmColor = openingSideToMove(board);') >= 0) &&
      bm.indexOf('var toMoveIsBlack = (stmColor === 1);') >= 0 &&
      bm.indexOf('var ourTurn = ((stmColor === 1) === ourIsBlack);') >= 0],
    // ★ 对手圈 = 局面的纯函数（本轮重构：取代旧的 needDefend/uniqueMust/maxRings 三分支）
    //   —— 闭四 1 个青圈 / 活四 2 个青+绿 / 终局 0 个；与缓存时点、候选顺序无关。
    ['面板: 对手圈由 computeOppRings 纯函数产出', bm.indexOf('function computeOppRings(reqBoard, myC, oppC, cands, rule)') >= 0 &&
      bm.indexOf('allImmediateFiveCells') >= 0 &&
      bm.indexOf('if (boardHasFive(reqBoard)) return [];') >= 0],
    ['面板: 必防点最多 2（闭四 1 / 活四 2）且确定性排序',
      bm.indexOf('return pts.slice(0, 2).map(') >= 0 &&
      bm.indexOf('pts.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });') >= 0],
    ['面板: 旧的内联三分支已清除（圈数不再随时序变化）',
      bm.indexOf('var uniqueMust =') < 0 && bm.indexOf('var maxRings =') < 0 && bm.indexOf('var needDefend = [];') < 0],
    ['面板: 回包后重判终局（竞态闸：我方刚落制胜手时不重画旧圈）',
      bm.indexOf('if (haltForNewGame) return;') >= 0 && bm.indexOf('boardHasFive(lastGoodBoard || board)') >= 0],
    ['面板: 我方最佳落点在指纹内稳定（不跳坐标）',
      bm.indexOf('function stabilizeBest(best, cands, fpKey, scoreOf)') >= 0 &&
      bm.indexOf('if (board) {') >= 0],
    ['面板: myColor0/oppColor0 单点定义（不再重复 var）',
      (bm.match(/var myColor0 = myColorCode\(\);/g) || []).length === 1],
    ['面板: drawChart 为无参', bm.indexOf('function drawChart() {') >= 0 &&
      !/drawChart\((?!\))[^)]+\)/.test(bm)],
    ['面板: 曲线持久化格式 v2', bm.indexOf('__v: 2, h: S.history') >= 0],
    ['面板: 持久化含 myEval', bm.indexOf('myEval: S.myEval') >= 0],
    ['面板: 旧数字数组可迁移', bm.indexOf('if (typeof p === \'number\') return { i: idx, v: p };') >= 0],
    ['面板: 新局清空 myEval', bm.indexOf("S.rawEval = ''; S.myEval = '';") >= 0],
    ['面板: 内容非空', bm.length > 100000],
    // ★ 发布版必须与源工程同步（防「本地 debug 版是对的，发布版还是老的」）
    ['发布版与源工程特征一致' + releaseSyncMsg, releaseSyncOk],
    // ★ 最强的一条：下发的 bookmarklet 与源工程逐字节一致（防陈旧内嵌 / blob 未刷新）
    ['发布版下发的 bookmarklet 与源工程逐字节一致 ' + byteMsg, byteExact],
    // ★ 包内文件卫生：构建中间产物 / 旧 exe 备份 / 明文面板资源都不许随包发货
    ['发布目录无引擎构建中间产物（engine.blob / sea-config.json / engine-server.js）',
      hygiene.intermediates.length === 0,
      hygiene.intermediates.join(', ')],
    ['发布目录无旧版残留（*.old / *.bak）',
      hygiene.stale.length === 0,
      hygiene.stale.join(', ')],
    ['发布目录 overlay/ 只有密文，没有明文面板资源',
      hygiene.plain.length === 0,
      hygiene.plain.join(', ')],
    ['发布目录不含调试日志/临时文件',
      hygiene.junk.length === 0,
      hygiene.junk.join(', ')],
  ];
  let ok = 0;
  checks.forEach(([n, v, detail]) => {
    if (v) ok++;
    console.log((v ? 'PASS ' : 'FAIL ') + n + ((!v && detail) ? '   ↳ ' + detail : ''));
  });
  console.log('--- ' + ok + '/' + checks.length + '  bookmarklet bytes=' + (bmBuf ? bmBuf.length : 0));
  try { srv.kill(); } catch (e) {}
  process.exit(ok === checks.length ? 0 : 1);
})();
