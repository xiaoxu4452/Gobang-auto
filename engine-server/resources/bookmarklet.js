/*
 * 五子棋浮动助手（书签版）—— 无需油猴/脚本猫，拖到书签栏点一下即用
 * 自动识别网页里的棋盘（canvas），连本地引擎 http://127.0.0.1:8964
 * 规则/时间模型与 gomocalc.com 一致；面板可拖动、可自动落子。
 */
(function () {
  // 再次点书签：清掉旧面板/旧定时器/旧覆盖层，重新注入最新代码（无需 F5）
  if (window.__gbPanel) {
    try { clearInterval(window.__gbTimer); clearTimeout(window.__gbTo); } catch (e) {}
    var oldP = document.getElementById('__gb_panel'); if (oldP) oldP.remove();
    var oldO = document.getElementById('__gb_overlay'); if (oldO) oldO.remove();
    var oldC = document.getElementById('__gb_calib'); if (oldC) oldC.remove();
    var oldA = document.getElementById('__gb_adjbox'); if (oldA) oldA.remove();
    window.__gbPanel = null;
  }

  var N = 15;
  // 本地服务地址：优先 127.0.0.1。若页面是 HTTPS 且连 127.0.0.1 失败（混合内容/PNA），
  // 可自动尝试 localhost —— 部分浏览器对 localhost 作为“可信本地源”放行策略与 127 不同。
  var LOCAL_HOSTS = ['http://127.0.0.1:8964', 'http://localhost:8964'];
  var ENGINE = LOCAL_HOSTS[0];
  var ENGINE_FAILED = null;          // 上次引擎 fetch 失败原因；用于一键换 host 重试
  // JSONP 降级通道（2026-09-25 晚三）：fetch/XHR 被站点 CSP(connect-src)/PNA 整体拦截时，
  // 改走 <script src> GET 通道（no-cors，不受 connect-src/预检管辖）。服务端 /api/analyze、
  // /api/status、/api/hash 均有 cb= 变体。返回 ResponseLike（.json()/.url），调用方零改动。
  var jsonpSeq = 0;
  function jsonpLocal(hosts, path, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      // path 可能自带查询串（如 /api/status?cid=..&lane=..）→ 并进 params
      var p2 = params || {};
      var qPos = path.indexOf('?');
      if (qPos >= 0) {
        new URLSearchParams(path.slice(qPos + 1)).forEach(function (v, k) { if (!(k in p2)) p2[k] = v; });
        path = path.slice(0, qPos);
      }
      var lastErr = null;
      (function attempt(hi) {
        if (hi >= hosts.length) { reject(lastErr || new Error('jsonp no host')); return; }
        var cbName = '__gbjp' + (++jsonpSeq) + '_' + Date.now().toString(36);
        var q = [];
        for (var k in p2) if (p2[k] !== undefined) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(p2[k]));
        q.push('cb=' + cbName);
        var s = document.createElement('script');
        var done = false;
        var to = setTimeout(function () { cleanup(new Error('jsonp timeout')); }, timeoutMs || 30000);
        function cleanup(err) {
          if (done) return; done = true;
          clearTimeout(to);
          try { delete window[cbName]; } catch (e) { try { window[cbName] = undefined; } catch (e2) {} }
          if (s && s.parentNode) s.parentNode.removeChild(s);
          if (err) { lastErr = err; attempt(hi + 1); }
        }
        window[cbName] = function (data) {
          done = true; clearTimeout(to);
          try { delete window[cbName]; } catch (e) { try { window[cbName] = undefined; } catch (e2) {} }
          if (s && s.parentNode) s.parentNode.removeChild(s);
          resolve({ ok: true, status: 200, url: hosts[hi] + path, json: function () { return Promise.resolve(data); } });
        };
        s.onerror = function () { cleanup(new Error('jsonp blocked')); };
        s.charset = 'utf-8';
        s.src = hosts[hi] + path + '?' + q.join('&');
        (document.head || document.documentElement).appendChild(s);
      })(0);
    });
  }
  // 哪些请求可降级 JSONP：/api/analyze、/api/status、/api/hash（服务端有 cb 变体）。
  // 超时口径：analyze 按 body.turnMs+12s（与主链路兜底同量级），其余默认 30s。
  function jsonpPlan(path, init) {
    if (!document || !document.createElement) return null;
    var p = path.split('?')[0];
    if (p === '/api/analyze' && init && init.body) {
      var turnMs = 5000;
      try { turnMs = JSON.parse(init.body).turnMs || 5000; } catch (e) {}
      return { path: p, params: { d: init.body }, timeout: turnMs + 12000 };
    }
    if (p === '/api/status') return { path: p, params: {}, timeout: 8000 };
    if (p === '/api/hash' && init && init.body) return { path: p, params: { d: init.body }, timeout: 10000 };
    return null;   // 其余（如 PY_HOSTS /recognize）无 JSONP 服务端，不降级
  }
  // 本地服务智能请求：对列表中的 host 逐个尝试，成功则锁定该 host 并返回响应。
  // 解决 HTTPS 页面连 HTTP 内网 127.0.0.1 被混合内容/Private-Network-Access 拦、但连 localhost 能通的情况。
  // ★ 2026-09-25 晚三：fetch 全 host 失败且该 API 有 JSONP 变体 → 自动降级 script 通道（不再直接 throw）。
  var tryLocal =
    (typeof fetch === 'function')
      ? async function (hosts, path, init) {
          var lastErr = null;
          for (var hi = 0; hi < hosts.length; hi++) {
            try {
              var resp = await fetch(hosts[hi] + path, init);
              if (resp && (resp.status >= 200 && resp.status < 300)) return resp;
              lastErr = new Error('HTTP ' + (resp ? resp.status : '?'));
            } catch (e) { lastErr = e; }
          }
          var jp = jsonpPlan(path, init);
          if (jp) return jsonpLocal(hosts, path, jp.params, jp.timeout);
          throw lastErr || new Error('no local host');
        }
      : async function (hosts, path, init) {
          var jp = jsonpPlan(path, init);
          if (jp) return jsonpLocal(hosts, path, jp.params, jp.timeout);
          throw new Error('fetch unavailable');
        };
  function pickHost(list, cur) { var i = list.indexOf(cur); return list[(i + 1) % list.length] || list[0]; }
  // 本页面板实例的唯一标识：多网站/多标签同时挂面板时，引擎实时状态按此隔离，
  // 避免 A 页的分析数据串到 B 页的画面上（每个页面注入时各自生成，不共享、不持久化）。
  // 客户端 ID：多网页/多标签隔离引擎分析请求；时间戳+双随机确保永不冲突
  var CLIENT_ID = 'gb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
  // 识别诊断：控制台 window.__gbDiag=true 开启，输出棋盘识别各阶段信息，用于定位“哪一层失败”
  var diag = function (what) { try { if (window.__gbDiag) console.log('[GB-diag]', what); } catch (e) {} };
  try { if (localStorage.getItem('gb_diag') === '1') window.__gbDiag = true; } catch (e) {}

  // ---------- 状态 ----------
  var S = {
    rule: 0,            // 0无禁手(长连赢) 1标准(长连不赢) 2有禁手 5一手交换
    preset: '3min',     // custom | 3min | 5min | 15min
    matchMs: 6000000,   // 局时（默认6000秒）
    turnMs: 5000,       // 步时上限（默认5秒）
    side: -1,           // 我执棋：-1自动 0黑 1白
    userSide: -1,       // 自动模式下推断的“我方”颜色：-1未知 0黑 1白（新对局重置）
    autoPlay: false,
    heatmap: false,    // 落子热力图：按候选排名 4 档（青最佳→绿良好→粉红一般→浅粉劣势）叠加显示（默认关，可在面板开启）
    oppMoves: false,   // 对手落点评估：青(最优)/绿(差不多) 虚线圆环（默认关，可在面板开启）
    realClick: false,  // 落子方式：只用页面内合成事件，不移动系统鼠标（避免干扰用户）
    lang: 'zh',         // 界面语言 zh | en
    dark: false,        // 深色模式
    opacity: 100,       // 面板透明度（25~100%，100=不透明）
    blur: 50,           // 面板背景模糊度（5~100%，50≈9px 玻璃）
    hashMB: 0,          // 引擎哈希表 MB（0=自动：不动服务端档位，让原生引擎吃满内存 1/3 封顶 4GB；
                        //   ★ 2026-09-25 旧版默认 256 且 init 即 POST，把主车道 2GB 哈希压成 1/8 —— 正是
                        //   「书签版没吃满原生 Rapfi」的实锤。手动范围 128~4096，减到 0 回自动）
    customSec: 6000,    // 自定义局时(秒)
    customTurnSec: 5,   // 自定义步时(秒)
    lastFp: '',
    timeUsedGame: 0,
    analyzing: false,
    history: [],        // 【评估曲线数据】数组元素 = { i: 真实手数, v: 分点值 }（见 drawChart 注释）
    score: 0,           // 最近一次我方评估值（-1000..1000，0=均势）——仅供内部逻辑用，不用于显示
    rawEval: '',        // 引擎原始 eval 字符串（行棋方视角，仅供内部/排障，不直接显示）
    myEval: '',         // 【面板「评估」栏 + 状态栏的唯一显示源】已归一到「我方视角」的 eval 串
    verdict: 'none',    // 'win' | 'lose' | 'none'（M/-M 或盘面五连判定）
    matePly: 0,         // mate 步数（带符号的 M 数；1 表示已分胜负）
    moves: [],          // 落子坐标序列（小写，用于生成局面代码）
    candCache: [],
    lastStat: null,     // 最近一次引擎结果（用于语言/主题切换后重绘数据面板）
  };
  var haltForNewGame = false;   // 胜负已定(M1/-M1)后停止计算，等新局 reset 清掉
  // 停算原因：'' 未停 / 'm1' 引擎报杀 / 'five-my' 我方盘面五连 / 'five-opp' 对手盘面五连。
  // 只有 five-* 是"物理终局"，会同时上下面那把持久化锁（gameOverLocked()）。
  var haltReason = '';
  // ★【终局权威闸（本轮新增）★】haltForNewGame 的「来源」。它有两个入口：
  //   · 'engine' = 引擎报 ±M1（也许只是"理论上 1 步必杀"，盘上其实还没五连）；
  //   · 'five'   = 盘面已实打实五连（我方或对手）——**这才是不可逆的真终局**。
  //   区分原因的意义：只有 'five'（盘面五连）才允许"锁死不再解锁"，因为盘面五连是物理事实；
  //   而 'engine' 会被下面的【空盘解闸】重判定（判错色/读盘残留/对手重开都靠它自救）。
  //   本轮用户反馈的「我方执黑落下第五子」场景：那一手落下后**永远不该再有任何评估**
  //   （评估栏/曲线/热力图/对手圈/自动落子全部归零），而这个"永远"必须能跨帧、跨会话存活，
  //   否则任何一处遗漏（异步回包、重投影、localStorage 半写）都会让终局画面"复活"。
  //   故用 localStorage 单独记住"终局锁已上"，只有 resetNewGame（空盘/子数回退）和
  //   用户手动改「我执」才清除 —— 中间任何路径都休想解开。
  var GAME_OVER_LOCK_KEY = 'gb_gameover';
  function setGameOverLock(reason) {
    // reason: 'five-my' | 'five-opp' | 'm1' | ''
    try { localStorage.setItem(GAME_OVER_LOCK_KEY, JSON.stringify({ r: reason, t: Date.now() })); } catch (e) {}
  }
  function clearGameOverLock() { try { localStorage.removeItem(GAME_OVER_LOCK_KEY); } catch (e) {} }
  // 会话内 + 持久化双重判定；顺手清理"本来就没终局"的脏锁（空盘时）
  function gameOverLocked() {
    try {
      var d = JSON.parse(localStorage.getItem(GAME_OVER_LOCK_KEY) || 'null');
      if (!d || !d.r) return false;
      if (Date.now() - (d.t || 0) > 6 * 3600 * 1000) { clearGameOverLock(); return false; }   // 6h 过期，防陈旧
      return true;
    } catch (e) { return false; }
  }
  try {
    var s = JSON.parse(localStorage.getItem('gb_state') || '{}');
    if (!s.__v || s.__v < 4) { s.oppMoves = false; s.heatmap = false; s.__v = 4; }   // 迁移 v4：热力图+对手落点评估默认关闭（用户明确要求默认不开启）
    if (s.__v < 5) { if (s.rule === 5) s.rule = 0; s.__v = 5; }   // 迁移 v5：移除“无禁手一手交换”规则选项，旧存档回退无禁手
    if (s.__v < 6) { s.autoPlay = false; s.__v = 6; }             // 迁移 v6：默认关闭自动落子（首次启动不自动下棋，需要时再手动开启）
    if (s.__v < 7) { if (s.hashMB === 256) s.hashMB = 0; s.__v = 7; }   // 迁移 v7：256 是旧默认（init 即压引擎主车道哈希到 1/8）→ 归 0=自动吃满原生档位
    for (var k in s) if (k !== 'analyzing') S[k] = s[k];   // analyzing 绝不能从上次会话继承（否则永久卡死）
  } catch (e) {}
  S.analyzing = false;

  // 【按用户要求：取消自动识别先后手】
  // 自动推断（差分猜色 / 网络监听反推 / 空盘主动下探测子）误判率做不到零，一旦判错
  // 系统就会替对手下棋。故整条自动链路统一由本开关控制，默认关闭：先后手 100% 由
  // 用户在面板「我执 · 黑/白」手动指定，判定零误差。恢复自动只需改成 true。
  var AUTO_SIDE = false;

  // ---------- 先手/后手状态自愈（读取存档后立即执行） ----------
  // localStorage 里的 side / userSide 可能因旧版本存档、手工改动或 JSON 类型漂移变成
  //   "1"(字符串) / 2 / null / true 等非法值。此时 `S.side === 1` 恒为 false，
  //   mySideMask() 便退回读残留的 userSide（多为 0=黑）→ 用户明明点了「白」却按「黑」评估。
  // 这里统一夹到合法域 {-1,0,1}，并强制「手动指定」与「自动推断」互斥。
  function clampSide(v) {
    if (v === 0 || v === 1) return v;
    if (v === '0' || v === 'black') return 0;
    if (v === '1' || v === 'white') return 1;
    var n = (typeof v === 'number') ? v : parseInt(v, 10);
    return (n === 0 || n === 1) ? n : -1;
  }
  (function normalizeSideState() {
    S.side = clampSide(S.side);
    // 手动已指定、或自动识别已关闭 → userSide 一律清空（二者互斥，杜绝残留旧判定）
    if (!AUTO_SIDE || S.side === 0 || S.side === 1) S.userSide = -1;
    else S.userSide = clampSide(S.userSide);
  })();

  // ============================================================================
  // 我方颜色的【唯一事实来源】（Single Source of Truth）
  // ----------------------------------------------------------------------------
  // 历史 BUG：面板里同时存在 S.side（手动指定：-1自动/0黑/1白）与 S.userSide
  // （自动推断：-1未知/0黑/1白）两个字段，各处的判断表达式写法不一：
  //     · 2707/2968 用 (S.side===0) || (S.side===-1 && userSide∈{0,-1,…})  → 未知时默认「我执黑」
  //     · 3437/1432 用 (S.side===0) || (S.side===-1 && userSide===0)        → 未知时判「我执白」
  //     同一状态（side=-1 且 userSide=-1）下，一个说黑、一个说白 → 功能互相打架。
  // 更隐蔽的一处：用户【手动点白】只把 S.side 置 1，却从不清理上一局残留的
  //     S.userSide（往往还是 0=黑）。于是那些「没加 S.side===-1 守卫」的读取点
  //     （netGuess 的 160、canAutoOpen 的 3445、状态栏 3786）仍按残留的 userSide 当成
  //     「我执黑」→ 正是用户反馈的【点白子却按黑子评估、功能整体混乱】。
  //
  // 解决：统一由下面三个函数回答「我到底执什么颜色」，其余地方一律改调它们：
  //     mySideMask()  → 0黑 / 1白 / -1 仍未确定
  //     myColorCode() → 1黑 / 2白 / 0 未确定（对应棋盘上的格子值）
  //     oppColorCode()→ 2黑 / 1白 / 0 未确定（对手颜色，恒为我方反面）
  // 手动指定（S.side 为 0/1）永远优先；只有 S.side===-1 时才看自动推断的 S.userSide。
  // ============================================================================
  // （AUTO_SIDE 开关见上方「取消自动识别先后手」注释）
  function mySideMask() {
    if (S.side === 0 || S.side === 1) return S.side;          // 手动指定优先，绝不被动摇
    if (!AUTO_SIDE) return -1;                                // 自动识别已关闭 → 未手动指定就是「未确定」
    return (S.userSide === 0 || S.userSide === 1) ? S.userSide : -1;
  }
  function sideResolved() { return mySideMask() >= 0; }
  function myColorCode() { var s = mySideMask(); return s < 0 ? 0 : (s === 0 ? 1 : 2); }
  function oppColorCode() { var s = mySideMask(); return s < 0 ? 0 : (s === 0 ? 2 : 1); }
  // ========================================================================
  // 【★ 开局行棋方权威（本轮新增）★】——「新开局白子错乱下子」的根治
  // ========================================================================
  // 背景：五子棋/连珠规则下**黑方恒为先手**。新局第一步永远该是黑子。
  // 但盘面读数在开局阶段会抖动（残留子、差分漏读、识别未稳定），
  // `bn > wn` 这套「按子数推轮次」的推断在开局那几帧完全可能给出「轮白」，
  // 于是自动落子会**主动替白方落子**、评估轨迹也跟着走白方视角 →
  // 用户看到的就是「新开局白子错乱下子」（截图里盘上 1 黑 2 白、己方执黑，
  // 却给白子标了着法序号）。
  //
  // 为什么要单独抽一个函数（而不是在 analyze() 里就地写条件）：
  //   1) 「谁该走」必须能脱离浏览器上下文**单测** —— 它是纯函数：只吃 board，吐颜色码。
  //   2) 历史血债：这段逻辑曾在 analyze() 里被写了三遍（三支各判断一次），
  //      任何一支漏改就出现「一处认黑、一处认白」。单点定义 + 单测是唯一治本方式。
  //
  // 规则（按优先级）：
  //   ① 空盘            → 黑（黑先）
  //   ② 黑子数 == 白子数 → 黑（黑方刚落下/尚未落，轮到黑）
  //   ③ 黑子数 >  白子数 → 白
  //   ④ 白子数 >  黑子数 → 白方多一子 = 黑方多走了一手 = 仍轮白（非法态，稳一点不翻转）
  // 注意 ③④ 合并即「除非白方落后，否则轮白」—— 与 sideToMoveColor 同式，
  // 但入口处先纠正 ①② 两个开局特例。
  function openingSideToMove(board) {
    if (!board || !board.length) return 1;
    var bn = 0, wn = 0;
    for (var y = 0; y < board.length; y++) {
      var row = board[y];
      if (!row) continue;
      for (var x = 0; x < row.length; x++) { if (row[x] === 1) bn++; else if (row[x] === 2) wn++; }
    }
    if (bn === 0 && wn === 0) return 1;   // ① 空盘 → 黑先
    if (bn === wn) return 1;              // ② 黑白等数 → 轮到黑
    return 2;                             // ③④ 黑多于白 → 轮白
  }
  // ========================================================================
  // 【★ 轮次差分锚定（2026-09-25 用户报「一直等待对手落子」的根治）★】
  // ========================================================================
  // 病根：openingSideToMove 是纯子数奇偶判定 —— 识别只要**多读/误读一枚棋子**（幻影子、
  //   残留子、对手头像遮挡误判），bn-wn 就永久差 1 以上；用户每落一子差值继续涨，
  //   轮次**永远翻不回我方** → 状态栏恒「等待对手落子…」、不评估不落子（截图实证）。
  //   纯奇偶判定没有任何自愈通道：错一次 = 错一整局。
  // 治法：轮次不再只看绝对子数，改成【帧间差分锚定】——
  //   · 与上一帧逐格对比：恰好新增 1 子（色 C）→ C 刚落完 → 轮 3-C（落子事实，最可信）；
  //   · 与上一帧完全相同 → 轮次不变（沿用 lastStm，绝不重算）；
  //   · 多子变化（重读抖动/清子）→ 回落子数代数，但**仅限合法态**（黑先规则下只有
  //     diff=0→黑走、diff=1→白走两种）；非法态（|diff|≥2 或白多）→ **沿用上一帧轮次**，
  //     绝不凭空翻转 —— 幻影子最多污染一帧，随后被差分锚定拉回，整局自愈。
  //   lastStmColor 只在空盘/新局清盘时回 1（黑先）。
  function stmFromDiff(board, bCnt, wCnt, prevBoard, lastStm) {
    if (!board || !board.length) return 1;
    if (bCnt === 0 && wCnt === 0) return 1;                       // 空盘/新局 → 黑先
    if (prevBoard && prevBoard.length === board.length) {
      var addB = 0, addW = 0, other = 0;
      for (var y = 0; y < board.length; y++) {
        var pr = prevBoard[y], cr = board[y];
        if (!cr || !pr) { other++; continue; }                    // 行缺失 → 保守计数
        for (var x = 0; x < cr.length; x++) {
          var p = pr[x] | 0, c = cr[x] | 0;
          if (p === c) continue;
          if (p === 0 && c === 1) addB++;
          else if (p === 0 && c === 2) addW++;
          else other++;                                           // 消失/变色 = 重读抖动
        }
      }
      if (other === 0 && addB + addW === 1) return addB ? 2 : 1;  // 恰一手：落子方的对方走
      if (other === 0 && addB + addW === 0) return (lastStm === 2) ? 2 : 1;   // 盘面没变 → 轮次不变
      // 多子变化 → 掉到下面的子数代数（合法态才可信）
    }
    if (bCnt === wCnt) return 1;
    if (bCnt === wCnt + 1) return 2;
    return (lastStm === 1 || lastStm === 2) ? lastStm : 2;        // 非法态：沿用，绝不凭空翻
  }
  // 我方是否轮次 == 「棋盘当前该走的颜色是否就是我方颜色」
  // 传入 stm（可选）：调用方已算过轮次时直接复用，避免同帧算两次出现不一致。
  function isOurTurnOn(board, stm) {
    var m = mySideMask();
    var me = (m === 0) ? 1 : (m === 1 ? 2 : 0);
    if (me === 0) return false;                       // 颜色未定 → 绝不当成"轮到我方"（否则会替对手落子）
    var s = (stm === 1 || stm === 2) ? stm : openingSideToMove(board);
    return s === me;
  }
  // 是否由用户手动锁定（true = S.side 明确为 0/1，自动推断一律不得改写）
  function sideIsManual() { return S.side === 0 || S.side === 1; }
  // 自动推断的唯一写入口：手动锁定时直接吞掉写入，从根上杜绝「点白却被改成黑」
  function setUserSide(v) {
    if (!AUTO_SIDE || sideIsManual()) { S.userSide = -1; return false; }   // 自动识别关闭/手动锁定 → 永不写入
    S.userSide = (v === 0 || v === 1) ? v : -1;
    return true;
  }
  // 状态栏/面板用的先后手文案（区分 手动锁定 / 自动识别 / 待定）
  function sideStatusText() {
    var m = mySideMask();
    if (m < 0) return SF('me_pending');
    if (sideIsManual()) return SF(m === 0 ? 'me_black_m' : 'me_white_m');
    return SF(m === 0 ? 'me_black' : 'me_white');
  }

  function save() {
    try {
      var c = Object.assign({}, S);
      c.analyzing = false;   // 保存时清掉进行中标记
      localStorage.setItem('gb_state', JSON.stringify(c));
    } catch (e) {}
  }
  // 评估曲线持久化：刷新后回填，保留历史评估值/判定
  // 【格式 v2】S.history 由「数字数组」改为「{i: 手数, v: 分值} 对象数组」（X 轴按真实手数定位）。
  // 旧存档是纯数字数组 → 一次性迁移为 {i: 下标, v: 值}，保证刷新不丢曲线。
  function saveHistory() {
    try { localStorage.setItem('gb_history', JSON.stringify({ __v: 2, h: S.history, score: S.score, rawEval: S.rawEval, myEval: S.myEval, verdict: S.verdict, matePly: S.matePly, halt: haltForNewGame, hr: haltReason })); } catch (e) {}
  }
  function normalizeHistPoint(p, idx) {
    if (typeof p === 'number') return { i: idx, v: p };                                   // 旧格式：数字 → 按序补手数
    if (p && typeof p === 'object' && typeof p.v === 'number') return { i: (typeof p.i === 'number' ? p.i : idx), v: p.v };
    return null;
  }
  function loadHistory() {
    try {
      var d = JSON.parse(localStorage.getItem('gb_history') || 'null');
      if (d && Array.isArray(d.h) && d.h.length) {
        // 兼容更旧的 winrate-format：0~1 之间的非 0/1 值属旧胜率垃圾 → 丢弃不回流
        var anyOld = false;
        for (var hi = 0; hi < d.h.length; hi++) {
          var pv = (d.h[hi] && typeof d.h[hi] === 'object') ? d.h[hi].v : d.h[hi];
          if (typeof pv === 'number' && pv > 0 && pv < 1) { anyOld = true; break; }
        }
        if (!anyOld) {
          var norm = [];
          for (var hj = 0; hj < d.h.length; hj++) { var np = normalizeHistPoint(d.h[hj], hj); if (np) norm.push(np); }
          S.history = norm.slice(-400);
          S.score = d.score || 0; S.rawEval = (typeof d.rawEval === 'string') ? d.rawEval : '';
          S.myEval = (typeof d.myEval === 'string') ? d.myEval : '';
          S.verdict = d.verdict || 'none'; S.matePly = d.matePly || 0;
          haltForNewGame = !!d.halt;
          haltReason = (typeof d.hr === 'string') ? d.hr : (haltForNewGame ? 'm1' : '');
          // ★ 持久化终局锁：上一会话若停在「盘面五连」的真终局，刷新后必须继续停算。
          //   （haltReason 的 five-* 由 setGameOverLock 同步落盘，这里只做一致性回填）
          if (haltReason === 'five-my' || haltReason === 'five-opp') setGameOverLock(haltReason);
        } else {
          S.history = []; S.score = 0; S.rawEval = ''; S.myEval = ''; S.verdict = 'none'; S.matePly = 0;
          haltForNewGame = false; haltReason = ''; clearGameOverLock();
          try { localStorage.removeItem('gb_history'); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // ---------- 网络监听：从 gomocalc 后台数据取权威先后手 ----------
  // 书签与网站同一上下文，劫持 WebSocket(收发)/fetch/XHR，解析服务器对局数据，
  // 抽取【明确标注“我方”颜色】的字段判定先后手（0=黑 1=白）。拿不到权威信号就跳过，
  // 回退到现有“按落子位置”探测逻辑，互不干扰。JS 代码写在下方，仍需二次转义。
  var NET_SELF_HINTS = ['"me"', '"my"', "'me'", "'my'", 'yourcolor', 'mycolor', 'yourColor', 'myColor', 'your-side', 'your_side', 'my-side', 'my_side'];

  // 调试开关：在控制台执行 window.__gbNetLog = true 即可看到 gomocalc 拦截到的候选消息
  try { if (localStorage.getItem('gb_netlog') === '1') window.__gbNetLog = true; } catch (e) {}
  function netVal2Side(val) {
    var v = String(val).trim().toLowerCase();
    if (v === 'black' || v === 'b') return 0;
    if (v === 'white' || v === 'w') return 1;
    var num = parseInt(v, 10);
    if (num === 1 || num === 0) return 0;
    if (num === 2) return 1;
    return -1;
  }
  function netApply(side) {
    if (side !== 0 && side !== 1) return false;
    if (AUTO_SIDE && S.autoPlay && S.side === -1 && S.userSide < 0) {   // 自动识别已关闭 → 下一律不生效
      S.userSide = side;
      sideLockUntil = Date.now() + 4000;   // 网络判定同样进入稳定锁定期：首手阶段识别抖动不翻转黑白
      try { setStatus(S.lang === 'en' ? 'net: I play ' + (side === 0 ? 'Black' : 'White') : '网络监听判定我执<b>' + (side === 0 ? '黑' : '白') + '</b>'); } catch (e) {}
      try { save(); } catch (e) {}
      return true;
    }
    return false;
  }
  // 调试：把匹配到“颜色/先后手”的原始消息打到控制台，便于确认 gomocalc 的真实格式
  function netLog(what) {
    try {
      if (window.__gbNetLog) console.log('[GB-net]', what);
    } catch (e) {}
  }
  function netGuess(txt) {
    try {
      if (!txt || typeof txt !== 'string' || txt.length > 200000) return;
      var low = txt.toLowerCase();
      if (!(low.indexOf('color') >= 0 || low.indexOf('colour') >= 0 || low.indexOf('side') >= 0 ||
            low.indexOf('black') >= 0 || low.indexOf('white') >= 0 || low.indexOf('blacktomove') >= 0 ||
            low.indexOf('whitetomove') >= 0 || low.indexOf('you') >= 0)) return;
      // —— 探测期后台归属判定（用户设计：立即点击 → 监听后台确认点击归属）——
      // 点击后后台反馈“轮到对方”（我们已成功落子）→ 先手；反馈“仍轮到黑”（点击未生效/对方先手）→ 后手。
      // 只读 turn 类信号（blacktomove/whitetomove/turn/next/player），不干扰 self 颜色信号。
      if (AUTO_SIDE && probeOpen && S.side === -1 && S.userSide < 0) {
        var sinceP = Date.now() - probeOpen.since;
        var turnMatch = low.match(/\b(blacktomove|whitetomove)\b/) ||
                        txt.match(/(?:turn|next|tomove|player)\w*\s*[:=]\s*["']?\b(black|white|b|w)\b/i);
        if (turnMatch && sinceP > 250) {
          var tt = (turnMatch[1] || turnMatch[0]).toLowerCase();
          var turnIsBlack = (tt.indexOf('black') >= 0 || tt === 'b');
          if (!turnIsBlack) {
            // 点击后轮到白 → 黑子已落（我们的点击生效）→ 我执黑先手
            if (netApply(0)) { probeOpen = null; openWaitStart = 0; netLog('probe-turn: now White to move → I am Black'); }
          } else if (sinceP > 600) {
            // 点击后 ≥600ms 仍轮到黑 → 点击未生效（不是我们点击的/被拒）→ 我方后手，等对手先落
            if (netApply(1)) { probeOpen = null; openWaitStart = 0; netLog('probe-turn: still Black to move → I am White'); }
          }
        }
      }
      // 直接命中：playok/kurnik 等常见格式 you:b / you:w / "me":"black" / myColor:"white"
      var dm = txt.match(/(?:you|your|me|my)\w*\s*[:=]\s*["']?\b(black|white|b|w)\b/i);
      if (dm) {
        var sd = netVal2Side(dm[1]);
        netLog('direct match=' + dm[1] + ' side=' + sd);
        if (sd >= 0 && netApply(sd)) return;
      }
      // 只处理带引号/冒号的键值，语义匹配“我方=颜色”
      var lines = txt.split(/[,\n{}]/);
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var lw = ln.toLowerCase();
        if (lw.indexOf('color') < 0 && lw.indexOf('colour') < 0 && lw.indexOf('side') < 0 &&
            lw.indexOf('black') < 0 && lw.indexOf('white') < 0) continue;
        // 该键是否属于“我方”语境：只在同一键值对内找 self 提示（避免“player”全文误命中）
        var isSelf = false;
        for (var h = 0; h < NET_SELF_HINTS.length; h++) if (ln.toLowerCase().indexOf(NET_SELF_HINTS[h]) >= 0) { isSelf = true; break; }
        var m = ln.match(/[:=]\s*["']?([A-Za-z0-9]+)["']?\s*$/i);
        if (!m) continue;
        var sd = netVal2Side(m[1]);
        netLog('line=' + ln + ' side=' + sd + ' self=' + isSelf);
        if (sd >= 0 && isSelf && netApply(sd)) return;
      }
    } catch (e) {}
  }
  function installNetHook() {
    if (window.__gbNetDone) return; window.__gbNetDone = true;
    // WebSocket 发送
    if (window.WebSocket && !window.__gbWsS) {
      window.__gbWsS = WebSocket.prototype.send;
      var so = window.__gbWsS;
      WebSocket.prototype.send = function (d) { try { netGuess(String(d)); } catch (e) {} return so.call(this, d); };
    }
    // WebSocket 接收（包装 addEventListener 捕获 message，不破坏原有监听）
    if (window.WebSocket && window.__gbWsAE === undefined) {
      window.__gbWsAE = true;
      var oAEL = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (t, f, o) {
        if (t === 'message') {
          var self = this;
          return oAEL.call(this, t, function (ev) {
            try { netGuess(ev && ev.data !== undefined ? String(ev.data) : ''); } catch (e) {}
            return f.apply(this, arguments);
          }, o);
        }
        return oAEL.apply(this, arguments);
      };
      var oSR = WebSocket.prototype.removeEventListener;
      WebSocket.prototype.removeEventListener = function () { return oSR.apply(this, arguments); };
    }
    // fetch
    if (window.fetch && !window.__gbFetchW) {
      window.__gbFetchW = true;
      var of = window.fetch;
      window.fetch = function () {
        return of.apply(this, arguments).then(function (r) {
          try { r.clone().text().then(function (t) { netGuess(t); }).catch(function () {}); } catch (e) {}
          return r;
        });
      };
    }
    // XMLHttpRequest
    if (window.XMLHttpRequest && !window.__gbXhrW) {
      window.__gbXhrW = true;
      var oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function () { this.__gbU = arguments[1]; return oo.apply(this, arguments); };
      var os = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var self = this;
        var h = function () { if (self.readyState === 4) { try { netGuess(self.responseText || ''); } catch (e) {} } };
        this.addEventListener('readystatechange', h);
        return os.apply(this, arguments);
      };
    }
  }
  // 面板初始化完成后安装一次
  try { installNetHook(); } catch (e) {}

  // ---------- 多语言 ----------
  var I18N = {
    zh: {
      title: '五子棋助手', think: '思考时间', preset3: '快棋(一局约3分钟)', preset5: '中棋(一局约5分钟)',
      preset15: '慢棋(一局约15分钟)', custom: '自定义', turn: '步时(秒)', match: '局时(秒)',
      rule: '规则', rule0: '无禁手', rule1: '无禁手长连不赢', rule2: '有禁手', rule5: '无禁手一手交换',
      iplay: '我执', auto: '自动落子', autoOpt: '自动', black: '黑子', white: '白子', manual: '手动调节', dark: '深色模式', light: '浅色模式',
      opacity: '透明度', blur: '模糊度',
      heat: '热力图', heatBest: '最佳', heatGood: '较优', heatMid: '一般', heatLow: '较弱',
      oppMoves: '对手落点评估',
      hash: '哈希表', hashUnit: 'MB', hashAuto: '自动',
      reidentify: '重新识别', analyze: '分析', deep: '深算', lang: 'EN',
      connecting: '连接引擎…', curve: '思考后显示评估曲线',
      colDepth: '深度', colEval: '评估', colSpeed: '速度', colNodes: '节点',
      no_board: '未检测到棋盘（打开有棋盘的网页后点书签；若页面无可识别 canvas，请换用其它五子棋网站）',
      swapHint: '交换棋提示：塔拉尼科夫 / 塔拉山口-10 等交换类规则，请先关闭「自动落子」，手动完成交换后再点开自动下棋。',
      thinking: '思考中…', copied: '局面代码已复制', fenlabel: '局面',
      posBtn: '局面', posSave: '保存局面', posWinTtl: '局面',
      posEmpty: '还没有识别到棋盘，先「分析」一次再来看局面',
      posSaveOk: '局面图已保存', posSaveFail: '保存失败：', posCopy: '复制',
    },
    en: {
      title: 'Gomoku Assistant', think: 'Move Time', preset3: 'Blitz (~3 min)', preset5: 'Normal (~5 min)',
      preset15: 'Long (~15 min)', custom: 'Custom', turn: 'Turn (s)', match: 'Game (s)',
      rule: 'Rules', rule0: 'Freestyle', rule1: 'Freestyle (no overline)', rule2: 'Renju', rule5: 'Freestyle (swap)',
      iplay: 'Me', auto: 'Auto-play', autoOpt: 'Auto', black: 'Black', white: 'White', manual: 'Adjust', dark: 'Dark mode', light: 'Light mode',
      opacity: 'Opacity', blur: 'Blur',
      heat: 'Heatmap', heatBest: 'Best', heatGood: 'Good', heatMid: 'Fair', heatLow: 'Weak',
      oppMoves: 'Opp. eval',
      hash: 'Hash', hashUnit: 'MB', hashAuto: 'Auto',
      reidentify: 'Re-scan', analyze: 'Analyze', deep: 'Deep', lang: '中',
      connecting: 'Connecting engine…', curve: 'Eval curve after thinking',
      colDepth: 'Depth', colEval: 'Eval', colSpeed: 'Speed', colNodes: 'Nodes',
      no_board: 'No board detected. Open a Gomoku page and click the bookmark; if no readable canvas, try another site.',
      swapHint: 'Swap rules tip: for Tarannikov / Taraguchi-10 and other swap rules, turn OFF Auto-play first, do the swap manually, then turn Auto-play back on.',
      thinking: 'Thinking…', copied: 'Position code copied', fenlabel: 'Pos',
      posBtn: 'Position', posSave: 'Save position', posWinTtl: 'Position',
      posEmpty: 'No board recognized yet — run Analyze first',
      posSaveOk: 'Position image saved', posSaveFail: 'Save failed: ', posCopy: 'Copy',
    }
  };
  function T(k) { var d = I18N[S.lang === 'en' ? 'en' : 'zh']; return d[k] || (I18N.zh[k] || k); }
  // 状态栏文案（带占位符 {x}）
  var ST = {
    zh: {
      cv_ok: '已通过 OpenCV 识别棋盘（{src} 置信度 {c}% · {n} 子），分析中…',
      shot_ok: '已通过截屏识别到棋盘（{mode}），分析中…',
      no_image: '页面上没有可读的棋盘图像。请先让面板识别出棋盘后再手动调节',
      applied: '已应用手动调节的棋盘区域，重新分析…',
      cancelled: '已取消手动调节',
      corrected: '已自动校正棋盘网格（置信度 {c}%）',
      no_stone: '识别可能不准——棋盘上有棋子但一格未读出。请点「手动调节」把蓝色框对准棋盘网格再「应用 ✓」',
      off: '识别偏移导致读子不准（置信度 {c}%）——请点「手动调节」把蓝色框对准棋盘网格再「应用 ✓」',
      lowconf: '读子置信度 {c}%，自动落子已暂停——请点「手动调节」校准棋盘后自动恢复',
      me_black: ' · 自动识别我执<b>黑</b>', me_white: ' · 自动识别我执<b>白</b>', me_pending: ' · 识别我方中(手动落子后生效)',
      me_black_m: ' · 已锁定我执<b>黑</b>(手动)', me_white_m: ' · 已锁定我执<b>白</b>(手动)',
      side_manual: '锁定', side_auto: '自动', side_pending: '待定',
      adj_mid: '手动调节中——请先点「应用 ✓」或「取消」，再自动落子',
      fail: '识别到疑似棋盘但校准失败——点「手动调节」拖动蓝色框框住棋盘（松手自动磁吸），再点「应用 ✓」；或点「重新识别」',
    },
    en: {
      cv_ok: 'Board recognized via OpenCV ({src} · conf {c}% · {n} stones), analyzing…',
      shot_ok: 'Board recognized via screenshot ({mode}), analyzing…',
      no_image: 'No readable board on the page. Let the panel detect the board first, then use Adjust.',
      applied: 'Manual region applied, re-analyzing…',
      cancelled: 'Manual adjustment cancelled',
      corrected: 'Grid auto-corrected (confidence {c}%)',
      no_stone: 'Detection may be off — stones present but none read. Click Adjust, line the blue box up with the grid, then Apply ✓.',
      off: 'Detection offset, stones read poorly (confidence {c}%) — click Adjust and line the blue box up, then Apply ✓.',
      lowconf: 'Stone confidence {c}%, auto-move paused — click Adjust to calibrate and it resumes.',
      me_black: ' · auto: I play <b>Black</b>', me_white: ' · auto: I play <b>White</b>', me_pending: ' · detecting side (play a move)',
      me_black_m: ' · locked: I play <b>Black</b> (manual)', me_white_m: ' · locked: I play <b>White</b> (manual)',
      side_manual: 'locked', side_auto: 'auto', side_pending: 'pending',
      adj_mid: 'Adjusting — click Apply ✓ or Cancel before auto-moving.',
      fail: 'Board suspected but calibration failed — click Adjust, drag the blue box over the board (magnetizes on release), then Apply ✓; or Re-scan.',
    }
  };
  function SF(k) {
    var d = ST[S.lang === 'en' ? 'en' : 'zh'];
    var s = d[k] || ST.zh[k] || k;
    for (var i = 1; i < arguments.length; i += 2) s = s.split(arguments[i]).join(arguments[i + 1]);
    return s;
  }

  // 局时预设（与 gomocalc 一致：3分钟=180s/步时7s，15分钟=900s/步时40s；5分钟=300s/步时18s）
  var PRESETS = {
    '3min':  { label: '3分钟', matchMs: 180000,  turnMs: 7000 },
    '5min':  { label: '5分钟', matchMs: 300000,  turnMs: 18000 },
    '15min': { label: '15分钟', matchMs: 900000,  turnMs: 40000 },
  };

  // ---------- 棋盘自动识别 ----------
  var cachedCal = null;
  // 自动模式追踪：面板落子后的预期局面 / 用户最近点击 / 面板自身点击标记
var lastAutoFp = null, lastUserClick = null, panelClickFlag = false;
  // ---- 先后手识别 + 自动落子状态机（重建） ----
  var lastBoard = null, lastCount = 0;          // 上次棋盘快照（差分新落子、判定先后手）
  var emptyStreak = 0;                          // 连续空盘次数（仅「有子→连续空盘」用于新局检测）
  var openWaitStart = 0;                        // 空盘且我方颜色未知时，开始等待对手开手的时间戳
  var pendingClick = null;                      // 我方落子待确认 {cal,cv,i,j,color,pt,since,retries}
  var probeOpen = null;                          // 空盘先手试探 {since,i,j,color}：试着下黑子判定先后手
  var lastEngineFp = null, lastEngineAt = 0;    // 引擎分析节流（同一局面不反复算）
  var lastStmColor = 1;                         // ★ 2026-09-25：轮次差分锚定的持久状态（1黑/2白走）。空盘/新局回 1
  var deepMode = false, DEEP_MS = 30000;        // 深度计算模式：主分析预算 30s（对标 gomocalc 手动深算）
  var overlayRefreshBusy = false;               // 热力图/对手评估补充搜索的互斥锁（同一时刻只发一个）
  var overlayStale = false;                     // 我方落子完成后：旧评估圆圈一律不画，直到对手落子触发新一轮分析
  var lastOppRings = null;                      // 最近一次对手落点虚线圆数据 [{x,y}]：我方落子后保留显示，直到对手落子
  // 与 lastOppRings 同生命周期：指纹相同则跳过重算。**必须和 lastOppRings 一起作废**
  //（清层却留下 key/rings 会让 drawOverlay 的同帧重投影把旧圈复活 —— 见 clearOppSvgLayer 注释）。
  var lastOppKey = null;
var lastOppCands = null;                      // 最近一次黑白互换盘（对手视角）候选：轮到己方时画对手圈的数据源
  var lastOppGeom = null;                       // 记录画对手虚线圆时的棋盘几何（用于几何变化时防画偏）
  var lockedGeom = null;                        // 本局锁定的棋盘几何：防识别镜像/跳跃导致圆圈乱飞
  var oppSvg = null;                            // 对手评估独立 SVG 层：热力图每轮刷新不碰它，保留时间远长于热力图
  var oppRingsFp = null;                        // 画对手圈时的局面指纹：对手落子后旧圈失效并清除
  var oppRingsCount = 0;                        // 画对手圈时的棋子总数：只有棋子数增加（对手真正落子）才清圈，读盘抖动不清
  var autoHaltUntil = 0;                        // 落子反复失败后的暂停时间戳
  var openReanchorAt = 0;                       // 空盘新局开局落子失败后的几何重锚冷却（防重校准失败死循环）
  var badDiffCount = 0, badDiffSince = 0;        // 字数异常自愈：连续异常计数/起始时间
  // ---- 先后手识别稳定性（根治“自动模式先手/后手跳跃变换”）----
  var sideLockUntil = 0;                        // 先后手判定后的稳定锁定期：期内一致性冲突一律不重置（首手阶段读盘抖动常见）
  var sideConflictCount = 0;                    // 一致性冲突证据积累：连续 ≥2 次（且过锁定期）才真正重置重判，单帧误报不翻转黑白
  // ---- 自动识别「我执」的迟滞投票（根治“黑子 / 白子之间来回跳”）----
  // ★ 票按「手」计，绝不按「帧」计：recentUserCell 在用户点击后 4 秒内**每一帧**都返回同一个
  //   格子（那格已经落子了），于是同一份证据每秒能刷几十次票 —— 按帧计数的话 66ms 就攒满，
  //   迟滞形同虚设。只有棋盘真的多了一颗子（added.length）才配算一票。
  var sideVote = { color: -1, n: 0 };           // 当前票色 / 连续票数（-1 = 尚无票）
  var SIDE_VOTE_NEED = 2;                       // 连续几「手」同色才允许定色或改判
  var SIDE_LOCK_MS = 4000;                      // 每次落定后的锁定期，期内不接受反票/改判
  var shrinkStreak = 0;                         // 棋盘子数回退连续帧数：连续 2 帧才判定“新局”，一帧漏读不误判
  // 探测历史格 ±1 邻域判定：探测子可能被读在相邻格/延迟落成，邻域内新增黑子只可能是我们自己下的
  function nearProbeCells(p, c, r) {
    var cells = p && p.cells && p.cells.length ? p.cells : (p ? [{ i: p.i, j: p.j }] : []);
    for (var pz = 0; pz < cells.length; pz++) {
      if (Math.abs(c - cells[pz].i) <= 1 && Math.abs(r - cells[pz].j) <= 1) return true;
    }
    return false;
  }
  // 把 canvas 在其文档视口坐标换算到主文档视口（支持同源 iframe 里的棋盘）
  function toTopRect(el) {
    var r = el.getBoundingClientRect();
    var win = el.ownerDocument.defaultView;
    while (win && win !== window) {
      var fr = win.frameElement;
      if (!fr) break;
      var frr = fr.getBoundingClientRect();
      r = { left: r.left + frr.left, top: r.top + frr.top, right: r.right + frr.left, bottom: r.bottom + frr.top, width: r.width, height: r.height };
      win = fr.ownerDocument.defaultView;
    }
    return r;
  }
  // 候选 canvas：主文档 + 递归穿透同源 iframe（多层嵌套也支持）；显示尺寸够大即可
  function pickCandidates() {
    var list = [];
    function scan(doc, depth) {
      depth = depth || 0;
      if (depth > 4) return;  // 限制深度，防循环
      Array.prototype.slice.call(doc.querySelectorAll('canvas')).forEach(function (c) { list.push(c); });
      Array.prototype.slice.call(doc.querySelectorAll('iframe')).forEach(function (f) {
        try { if (f.contentDocument && f.contentDocument.body) scan(f.contentDocument, depth + 1); } catch (e) {}  // 跨域 iframe 抛错，跳过
      });
    }
    scan(document, 0);
    // ★ 自身免疫（2026-09-25）：面板本体与「局面」小窗里的 canvas 一律不当棋盘候选 ——
    //   局面小窗里就画着一张 15 路小棋盘，不豁免的话识别器会把自家窗口错认成对局棋盘。
    function inOwnUi(el) {
      for (var p = el; p; p = p.parentElement) {
        if (p.id === '__gb_panel' || p.id === '__gb_poswin') return true;
      }
      return false;
    }
    var cands = list.filter(function (c) {
      if (inOwnUi(c)) return false;
      var r = c.getBoundingClientRect();
      return r.width > 120 && r.height > 120;
    });
    // 优先接近方形、且在视口内的
    cands.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      var sqA = 1 - Math.abs(ra.width - ra.height) / Math.max(ra.width, ra.height);
      var sqB = 1 - Math.abs(rb.width - rb.height) / Math.max(rb.width, rb.height);
      return sqB - sqA;
    });
    return cands;
  }
  var cachedBoard = null; // {cv, cal}
  // 监听棋盘上的用户点击（用于自动模式推断“我方”颜色：用户手动落子 vs 对手应手）
  function attachClickWatch(cv, cal) {
    if (cv.__gbWatch) return;
    cv.__gbWatch = true;
    function onHit(e) {
      if (panelClickFlag) return;
      var r = cal.docRect || cal.topRect;
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      lastUserClick = { t: Date.now(), x: x, y: y };
    }
    ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(function (ev) {
      try { cv.addEventListener(ev, onHit, true); } catch (e) {}
    });
  }
  var lastScreenTry = 0;
  var screenDenied = false;    // 用户取消/拒绝过截屏授权 → 不再自动弹窗
  var screenAutoOff = false;   // 连续多次截屏都找不到棋盘 → 暂停自动重试
  var screenFails = 0;
  var lastBoardFail = 'none';  // 最近一次识别失败原因：canvas-calib | no-canvas
  var lastGoodCal = null;      // 最近一次通过置信度门槛、可正常分析的校准几何（镜像看门狗的参照）
var lastGoodBoard = null;    // 最近一次通过置信度门槛的棋盘（帧间镜像校验参照：正常对局每帧只差≤1子）
var lastMirrorFixAt = 0;     // 上次镜像纠偏时间戳：800ms 冷却内不重复纠偏重读，抑制“纵向镜像识别闪动”高频抖动
  function findBoard() {
    if (cachedBoard) {
      // 画布元素还在、尺寸没变、位置没动（未滚动/缩放）就复用；
      // 页面滚动/缩放会让棋盘视口几何变化，立即失效重校准
      var doc = cachedBoard.cv.ownerDocument;
      var r = cachedBoard.cv.getBoundingClientRect();
      var last = cachedBoard.lastRect;
      var moved = last && (Math.abs(r.left - last.left) > 2 || Math.abs(r.top - last.top) > 2 ||
        Math.abs(r.width - last.width) > 2 || Math.abs(r.height - last.height) > 2);
      if (!moved && r.width > 50 && doc.body && doc.body.contains(cachedBoard.cv)) {
        cachedBoard.lastRect = { left: r.left, top: r.top, width: r.width, height: r.height };
        drawCalibFrame(cachedBoard.cal, cachedBoard.cv);
        attachClickWatch(cachedBoard.cv, cachedBoard.cal);
        return cachedBoard;
      }
      cachedBoard = null;
    }
    var cands = pickCandidates();
    // 对每个候选 canvas 校准并打分（网格越统一分数越低），选最像 15×15 棋盘的，避免误选页面其它边框/画布
    var bestCal = null, bestCv = null, bestScore = 1e18;
    for (var i = 0; i < cands.length; i++) {
      var cal = calibrate(cands[i]);
      if (cal) {
        cal.docRect = cands[i].getBoundingClientRect();
        cal.topRect = toTopRect(cands[i]);
        cal.frameWin = cands[i].ownerDocument.defaultView || window;
        var sc = cal.gridScore != null ? cal.gridScore : 0;
        if (sc < bestScore) { bestScore = sc; bestCal = cal; bestCv = cands[i]; }
      }
    }
    if (bestCal) {
      var rr = bestCv.getBoundingClientRect();
      cachedBoard = { cv: bestCv, cal: bestCal, lastRect: { left: rr.left, top: rr.top, width: rr.width, height: rr.height } };
      drawCalibFrame(bestCal, bestCv);
      attachClickWatch(bestCv, bestCal);
      lastBoardFail = 'none';
      return cachedBoard;
    }
    // 校准全部失败：页面里有疑似棋盘 canvas → 网站内很可能可以直接自动操作（如 PlayOK），
    // 不弹截屏授权，引导用户「手动调节」框选棋盘即可在页面内自动落子
    if (cands.length > 0) {
      clearCalibFrame();
      lastBoardFail = 'canvas-calib';
      return null;
    }
    // 兜底：lizzieyzy 式截屏识别——页面完全没有棋盘 canvas 时，截取屏幕/标签页一帧在图像中找棋盘
    //（不限棋盘渲染方式：DOM/SVG/图片/WebGL 都能从图像识别；限频避免频繁弹授权）
    if (!screenDenied && !screenAutoOff && Date.now() - lastScreenTry > 5000) {
      lastScreenTry = Date.now();
      tryScreenBoard();
    }
    if (screenBoard) {
      drawCalibFrame(screenBoard.cal, screenBoard.cv);
      attachClickWatch(screenBoard.cv, screenBoard.cal);
      lastBoardFail = 'none';
      return { cv: screenBoard.cv, cal: screenBoard.cal, screenMode: true };
    }
    clearCalibFrame();
    lastBoardFail = 'no-canvas';
    return null;
  }

  // ========== Python OpenCV 识别优先（内嵌到 4 L 型 + 5 十字反馈层） ==========
  // 页面棋盘 canvas → 合成不透明底图 → POST 本地识别服务(8970) → 返回几何+黑白子
  // 替代旧 JS 投影校准（gomocalc 等数字标注棋盘上偏移），渲染/调节/磁吸/落子仍用旧链路
  var pyBoardCache = null;
  var PY_HOSTS = ['http://127.0.0.1:8970', 'http://localhost:8970'];
  function composeBoardImage(cands) {
    var w = 0, h = 0;
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].width > w) w = cands[ci].width;
      if (cands[ci].height > h) h = cands[ci].height;
    }
    if (!w || !h) return null;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return null; }
    // 从最大候选 canvas 采样众数主色（非透明像素）作为合成底色：
    // 透明底棋盘（gomocalc 等）填上底色后 OpenCV 才能稳定判线判子；白子/黑子与底色才有对比
    var main = cands[0];
    for (var ci2 = 1; ci2 < cands.length; ci2++) if (cands[ci2].width * cands[ci2].height > main.width * main.height) main = cands[ci2];
    var img = null;
    try {
      var mo = document.createElement('canvas'); mo.width = main.width; mo.height = main.height;
      var mctx = mo.getContext('2d', { willReadFrequently: true });
      mctx.drawImage(main, 0, 0);
      img = mctx.getImageData(0, 0, main.width, main.height).data;
    } catch (e) { img = null; }
    var hist = {}, bestK = null, bestC = 0;
    if (img) {
      for (var y = 0; y < main.height; y += 4) for (var x = 0; x < main.width; x += 4) {
        var o = (y * main.width + x) * 4;
        if (img[o + 3] < 96) continue;
        var key = ((img[o] >> 4) << 8) | ((img[o + 1] >> 4) << 4) | (img[o + 2] >> 4);
        hist[key] = (hist[key] || 0) + 1;
        if (hist[key] > bestC) { bestC = hist[key]; bestK = key; }
      }
    }
    if (bestK == null) { octx.fillStyle = '#ffffff'; }
    else {
      var mr = (((bestK >> 8) & 15) << 4) | 8, mg = (((bestK >> 4) & 15) << 4) | 8, mb = ((bestK & 15) << 4) | 8;
      octx.fillStyle = 'rgb(' + mr + ',' + mg + ',' + mb + ')';
    }
    octx.fillRect(0, 0, w, h);
    // 叠加所有候选 canvas（gomocalc 等棋盘=底图线层+棋子层，必须都画上）
    for (var ci3 = 0; ci3 < cands.length; ci3++) {
      try { octx.drawImage(cands[ci3], 0, 0); } catch (e) {}
    }
    return off.toDataURL('image/png');
  }
  // ========== 五林五子棋（renjuworld / Cocos WebGL）适配 ==========
  // WebGL canvas 无法被 drawImage 合成（页面架构问题），改为服务端截屏 + 校准几何直接读子。
  // 棋盘几何来自手动调节一次（应用√ 时保存到 localStorage），几何固定 → 无 Y 轴抖动。
  var WULIN_GEO_KEY = '__gb_wulin_geo_v1';
  function isWulinSite() {
    try {
      var gc = document.getElementById('GameCanvas');
      if (!gc) return false;
      if (!(window.cc || window._CCSettings || typeof cc !== 'undefined')) return false;
      var r = gc.getBoundingClientRect();
      return r.width > 100 && r.height > 100;
    } catch (e) { return false; }
  }
  function wulinGeoLoad() {
    try { var s = localStorage.getItem(WULIN_GEO_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function wulinGeoSave(g) {
    try { localStorage.setItem(WULIN_GEO_KEY, JSON.stringify(g)); } catch (e) {}
  }
  async function wulinFindBoard() {
    var gc = document.getElementById('GameCanvas');
    if (!gc) return null;
    var geo = wulinGeoLoad();
    if (!geo || !(geo.stepX > 1)) return null;
    var resp = await tryLocal(PY_HOSTS, '/recognize', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'wulin', size: 15,
        geo: { x0: geo.x0, y0: geo.y0, stepX: geo.stepX, stepY: geo.stepY || geo.stepX, grid: 15 },
        win: {
          screenX: window.screenX, screenY: window.screenY,
          topBorder: (window.outerHeight - window.innerHeight) || 0,
          innerWidth: window.innerWidth, innerHeight: window.innerHeight
        }
      })
    });
    var data = await resp.json();
    if (!data.ok) return null;
    var board = emptyBoard();
    (data.black || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 1; });
    (data.white || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 2; });
    var rr = gc.getBoundingClientRect();
    var cal = {
      x0: geo.x0 - rr.left, y0: geo.y0 - rr.top,      // canvas 图像系（相对 GameCanvas 左上）
      stepX: geo.stepX, stepY: geo.stepY || geo.stepX, cell: geo.stepX,
      bg: 200, gridScore: 0, docRect: rr, topRect: toTopRect(gc), frameWin: window,
      isScreen: false, mode: 'wulin'
    };
    var res = { cv: gc, cal: cal, board: board };
    pyBoardCache = { cv: gc, cal: cal, board: board, lastRect: { left: rr.left, top: rr.top, width: rr.width, height: rr.height }, t: Date.now() };
    cachedBoard = res;
    drawCalibFrame(cal, gc);
    attachClickWatch(gc, cal);
    lastBoardFail = 'none';
    setStatus(SF('cv_ok', '{src}', '五林·截屏', '{c}', 95, '{n}', board.reduce(function (a, r) { for (var i = 0; i < 15; i++) if (r[i]) a++; return a; }, 0)));
    return res;
  }
  async function pyFindBoard() {
    // 五林（Cocos/WebGL）优先走截屏读子；无校准几何时提示手动调节一次
    if (isWulinSite()) {
      try {
        var wb = await wulinFindBoard();
        if (wb) return wb;
        var wg = wulinGeoLoad();
        if (!wg || !(wg.stepX > 1)) {
          var hinted = false;
          try { hinted = localStorage.getItem('__gb_wulin_hinted') === '1'; } catch (e) {}
          if (!hinted) {
            try { localStorage.setItem('__gb_wulin_hinted', '1'); } catch (e) {}
            setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Wulin board: click Adjust and frame the board once; auto after that.' : '五林棋盘：请先点「手动调节」拖动蓝框框住棋盘一次，之后自动识别') + '</span>');
          }
        }
      } catch (e) {}
    }
    var cv = null;
    if (pyBoardCache && Date.now() - pyBoardCache.t < 2000) {
      cv = pyBoardCache.cv;
      var doc = cv.ownerDocument, r0 = cv.getBoundingClientRect(), last = pyBoardCache.lastRect;
      var moved = last && (Math.abs(r0.left - last.left) > 2 || Math.abs(r0.top - last.top) > 2 ||
        Math.abs(r0.width - last.width) > 2 || Math.abs(r0.height - last.height) > 2);
      if (!moved && r0.width > 50 && doc.body && doc.body.contains(cv)) {
        pyBoardCache.lastRect = { left: r0.left, top: r0.top, width: r0.width, height: r0.height };
        drawCalibFrame(pyBoardCache.cal, cv);
        attachClickWatch(cv, pyBoardCache.cal);
        cachedBoard = pyBoardCache;
        return pyBoardCache;
      }
      pyBoardCache = null;
    } else {
      pyBoardCache = null;   // 缓存过期 → 强制重新识别（棋盘内容可能已变化）
    }
    var cands = pickCandidates();
    // 只叠加“主棋盘层”：选可见面积最大的候选为基准，仅保留与其视口矩形基本重合的 canvas
    // （排除页面底部图表、离屏 buffer、小 UI 等——它们混入会让合成图基准错位导致 L 框偏移）
    var mainCv = null;
    for (var mi = 0; mi < cands.length; mi++) {
      var c0r = cands[mi].getBoundingClientRect();
      if (c0r.width < 100 || c0r.height < 100) continue;
      if (!mainCv || cands[mi].width * cands[mi].height > mainCv.width * mainCv.height) mainCv = cands[mi];
    }
    var boardCands = [];
    if (mainCv) {
      var mr = mainCv.getBoundingClientRect();
      boardCands = cands.filter(function (c) {
        var cr = c.getBoundingClientRect();
        return Math.abs(cr.width - mr.width) < 20 && Math.abs(cr.height - mr.height) < 20 &&
               Math.abs(cr.left - mr.left) < 20 && Math.abs(cr.top - mr.top) < 20;
      });
      if (!boardCands.length) boardCands = [mainCv];
    }
    if (!mainCv) return null;
    var best = null;   // 有棋子的候选优先（多 canvas 时底图层无子会被跳过）
    var b64 = null;
    try { b64 = composeBoardImage(boardCands); } catch (e) { b64 = null; }
    if (b64) {
      try {
        // 注意：不能带 Content-Type 头（会触发 CORS preflight 被部分网站拦截）
        var resp = await tryLocal(PY_HOSTS, '/recognize', {
          method: 'POST',
          body: JSON.stringify({ image: b64.split(',')[1], size: 15 })
        });
        var data = await resp.json();
        // suspect=true：识别服务自己的「棋理不变量」闸门判定本次读子不可信（黑白数失衡/
        // 整盘近乎同色）。宁可回退页面内 JS 读子，也不能把垃圾局面喂给引擎。
        if (data.ok && data.geometry && !data.suspect) {
          var stones = (data.black || []).length + (data.white || []).length;
          best = { data: data, cv: mainCv, stones: stones, conf: data.geometry.confidence || 0 };
          // 若合成结果 0 子，逐个棋盘层 canvas 单独识别（合成可能错位），选有子的
          if (stones === 0) {
            for (var i = 0; i < boardCands.length; i++) {
              var c = boardCands[i];
              if (c.width < 200 || c.height < 200) continue;
              var b1 = null;
              try { b1 = composeBoardImage([c]); } catch (e) { b1 = null; }
              if (!b1) continue;
              var r2 = await tryLocal(PY_HOSTS, '/recognize', {
                method: 'POST',
                body: JSON.stringify({ image: b1.split(',')[1], size: 15 })
              });
              var d2 = await r2.json();
              if (d2.ok && d2.geometry && !d2.suspect) {
                var s2 = (d2.black || []).length + (d2.white || []).length;
                if (s2 > best.stones) best = { data: d2, cv: c, stones: s2, conf: d2.geometry.confidence || 0 };
              }
            }
          }
        }
      } catch (e) { /* 服务不可用 → 回退旧校准 */ }
    }
    if (!best) return null;   // 全部失败 → 调用方回退旧 JS 校准
    {
      var c = best.cv, data = best.data;
      var g = data.geometry;
      // 最终防线（对任何版本的识别服务都生效）：整盘近乎同色、或黑白数严重失衡，
      // 必然是读崩了（历史故障：米色亮底上每个空点被判成白子 → 224 个假白子 →
      // 面板报「对手已五子连珠·我方落败」）。丢弃本次识别，回退页面内 JS 读子。
      var nb = (data.black || []).length, nw = (data.white || []).length;
      if ((nb + nw) >= 6 && (Math.abs(nb - nw) > 2 || Math.max(nb, nw) > N * N * 0.8)) {
        diag('py board rejected: black=' + nb + ' white=' + nw + ' (misread)');
        return null;
      }
      var board = emptyBoard();
      (data.black || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 1; });
      (data.white || []).forEach(function (s) { if (s.x >= 0 && s.x < 15 && s.y >= 0 && s.y < 15) board[s.y][s.x] = 2; });
      var rr = c.getBoundingClientRect();
      // 几何防抖：棋盘位置未变且识别几何与上次相差很小（识别噪声）→ 沿用上次几何，只更新棋子，
      // 避免网格线定位 ±1px 抖动导致标记/落点在 Y 轴来回跳。
      var oldCal0 = pyBoardCache && pyBoardCache.cal;
      var oldLast = pyBoardCache && pyBoardCache.lastRect;
      var geoStable = oldCal0 && !oldCal0.isScreen && oldCal0.mode !== 'wulin' &&
        Math.abs(oldCal0.x0 - g.x0) < 5 && Math.abs(oldCal0.y0 - g.y0) < 5 &&
        Math.abs(oldCal0.stepX - g.stepX) < 2 && Math.abs(oldCal0.stepY - g.stepY) < 2 &&
        oldLast && Math.abs(rr.left - oldLast.left) < 5 && Math.abs(rr.top - oldLast.top) < 5;
      var cal = geoStable ? oldCal0 : {
        x0: g.x0, y0: g.y0, stepX: g.stepX, stepY: g.stepY,
        bg: g.bg, cell: g.stepX, gridScore: 0,
        docRect: rr, topRect: toTopRect(c), frameWin: c.ownerDocument.defaultView || window,
        isScreen: false, mode: 'py'
      };
      pyBoardCache = { cv: c, cal: cal, board: board, lastRect: { left: rr.left, top: rr.top, width: rr.width, height: rr.height }, t: Date.now() };
      cachedBoard = pyBoardCache;
      drawCalibFrame(cal, c);
      attachClickWatch(c, cal);
      lastBoardFail = 'none';
      setStatus(SF('cv_ok', '{src}', g.source || '', '{c}', Math.round((g.confidence || 0) * 100), '{n}', best.stones));
      return pyBoardCache;
    }
  }

  // ========== lizzieyzy 式截屏识别（兜底） ==========
  var screenBoard = null;
  async function tryScreenBoard() {
    var sb;
    try { sb = await captureBoard(); } catch (e) { sb = null; }
    if (sb) {
      screenBoard = sb;
      screenFails = 0;
      setStatus(SF('shot_ok', '{mode}', (sb.cal.mode === 'tab') ? (S.lang==='en'?'tab':'标签页') : (S.lang==='en'?'screen':'屏幕')));
    } else {
      screenBoard = null;
      if (screenDenied) {
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'Screenshot permission denied. Click Re-scan to retry.' : '截屏授权已取消，不再自动弹出。点「重新识别」可再次尝试') + '</span>');
      } else if (++screenFails >= 2) {
        screenAutoOff = true;
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'No board in screenshot. Auto-retry paused; click Re-scan to retry.' : '截屏中未找到棋盘，已暂停自动重试。点「重新识别」手动重试') + '</span>');
      }
    }
  }
  async function captureBoard() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return null;
    var prevVis = root.style.visibility;
    root.style.visibility = 'hidden';   // 截屏时隐藏面板本体，避免干扰检测
    var pwEl = document.getElementById('__gb_poswin');
    var pwVis = pwEl ? pwEl.style.visibility : '';
    if (pwEl) pwEl.style.visibility = 'hidden';   // 局面小窗里就有棋盘图，一并隐藏
    var stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false }); }
    catch (e) {
      if (pwEl) pwEl.style.visibility = pwVis;
      root.style.visibility = prevVis;
      // 用户取消/拒绝授权 → 标记后不再自动弹窗（死循环弹窗修复）
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError' || e.name === 'SecurityError')) screenDenied = true;
      return null;
    }
    try {
      var video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise(function (res) {
        video.onloadeddata = res;
        if (video.readyState >= 2) res();
        setTimeout(res, 3000);
      });
      var cv = document.createElement('canvas');
      cv.width = video.videoWidth || 1280; cv.height = video.videoHeight || 720;
      var ctx = cv.getContext('2d');
      ctx.drawImage(video, 0, 0);
      var img;
      try { img = ctx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return null; }
      var settings = {};
      try { settings = video.getSettings ? video.getSettings() : {}; } catch (e) {}
      var mode = (settings.displaySurface === 'browser') ? 'tab' : 'screen';
      var cal = findBoardInImage(img, cv.width, cv.height);
      if (!cal) return null;
      // 帧坐标 → 页面 client 坐标：标签页模式帧即视口；屏幕模式减去窗口位置
      var dx = (mode === 'tab') ? 0 : (window.screenX || 0);
      var dy = (mode === 'tab') ? 0 : (window.screenY || 0);
      cal.isScreen = true;
      cal.mode = mode;
      cal.clientX0 = cal.x0 - dx;
      cal.clientY0 = cal.y0 - dy;
      cal.bw = cal.lastX - cal.x0; cal.bh = cal.lastY - cal.y0;
      cal.topRect = { left: cal.clientX0, top: cal.clientY0, width: cal.bw, height: cal.bh };
      cal.docRect = cal.topRect;
      cal.frameWin = window;
      return { cv: cv, cal: cal };
    } catch (e) { return null; }
    finally {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      if (pwEl) pwEl.style.visibility = pwVis;
      root.style.visibility = prevVis;
    }
  }
  // 在整屏图像中定位 15x15 棋盘：行/列暗线峰 → 等距 15 线组 → 近似方形的区域
  function findBoardInImage(img, w, h) {
    var sum = 0, n = 0;
    for (var y = 0; y < h; y += 4) for (var x = 0; x < w; x += 4) {
      var o = (y * w + x) * 4; if (img[o + 3] < 128) continue; sum += lumOf(img, o); n++;
    }
    if (!n) return null;
    var bg = sum / n;
    var diff = Math.max(12, Math.min(42, bg * 0.22));
    var rowSc = new Array(h), colSc = new Array(w);
    for (var y = 0; y < h; y++) {
      var dk = 0, t = 0;
      for (var x = 0; x < w; x += 2) {
        var o = (y * w + x) * 4; if (img[o + 3] < 128) continue; t++;
        if (bg - lumOf(img, o) > diff) dk++;
      }
      rowSc[y] = t ? dk / t : 0;
    }
    for (var x = 0; x < w; x++) {
      dk = 0; t = 0;
      for (var y = 0; y < h; y += 2) {
        var o = (y * w + x) * 4; if (img[o + 3] < 128) continue; t++;
        if (bg - lumOf(img, o) > diff) dk++;
      }
      colSc[x] = t ? dk / t : 0;
    }
    function peaks(score) {
      var out = [], inL = false;
      for (var i = 0; i < score.length; i++) {
        // 阈值 0.12：棋盘可能只占窗口一小部分，整行暗像素占比相应降低
        if (score[i] > 0.12) { if (!inL) { inL = true; out.push(i); } }
        else inL = false;
      }
      return out;
    }
    function findGrid(lines) {
      if (!lines || lines.length < 12) return null;
      var diffs = {};
      for (var i = 1; i < lines.length; i++) {
        var d = lines[i] - lines[i - 1];
        diffs[d] = (diffs[d] || 0) + 1;
      }
      var bestD = 0, bestC = 0;
      for (var d in diffs) { if (diffs[d] > bestC) { bestC = diffs[d]; bestD = +d; } }
      if (bestD < 8 || bestD > 220) return null;
      // 模板匹配：按众数间距滑动 15 线模板，匹配数优先、偏差和次之
      //（标题/工具栏等噪声峰值、短齐段都会被完整网格击败）
      var tol = Math.max(2, bestD * 0.10);
      var best = null, bestScore = 1e18;
      for (var off = lines[0] - bestD * 2; off <= lines[lines.length - 1] - bestD * 12; off += 2) {
        var matched = 0, devSum = 0;
        for (var k = 0; k < 15; k++) {
          var t = off + k * bestD, bd = 1e9;
          for (var j = 0; j < lines.length; j++) { var dd = Math.abs(lines[j] - t); if (dd < bd) bd = dd; }
          if (bd <= tol) { matched++; devSum += bd; }
        }
        if (matched >= 12) {
          var score = (15 - matched) * 1000 + devSum;
          if (score < bestScore) {
            bestScore = score;
            var g = [];
            for (var k2 = 0; k2 < 15; k2++) {
              var t2 = off + k2 * bestD, bd2 = 1e9, bi2 = -1;
              for (var j2 = 0; j2 < lines.length; j2++) { var dd2 = Math.abs(lines[j2] - t2); if (dd2 < bd2) { bd2 = dd2; bi2 = j2; } }
              if (bd2 <= tol) g.push(lines[bi2]);
            }
            if (g.length >= 12) {
              var step = (g[g.length - 1] - g[0]) / (g.length - 1);
              if (step >= 8 && step <= 220) best = { first: g[0], last: g[g.length - 1], step: step, count: g.length };
            }
          }
        }
      }
      return best;
    }
    var hg = findGrid(peaks(rowSc)), vg = findGrid(peaks(colSc));
    if (!hg || !vg) return null;
    var aspect = (vg.last - vg.first) / Math.max(1, (hg.last - hg.first));
    if (aspect < 0.7 || aspect > 1.45) return null;   // 五子棋棋盘近似方形
    return { x0: vg.first, y0: hg.first, lastX: vg.last, lastY: hg.last, stepX: vg.step, stepY: hg.step, bg: bg, cell: vg.step };
  }

  // =====================================================================
  //  棋盘识别（采用 Gobang.txt 的思路：角采样底色 + 行列暗线密度峰值定位网格 + 亮/暗像素占比判子）
  // =====================================================================
  var DET_CFG = {
    BOARD_SIZE: 15,
    GRID_LINE_THRESHOLD: 0.25,  // 该行/列暗像素占比超过此值才算网格线
    GRID_LINE_DIFF: 22,         // 比底色暗多少算"暗线像素"
    BG_SAMPLE_MARGIN: 0.06,     // 四角采样边距
    STONE_RADIUS_RATIO: 0.35,   // 子判定窗口半径（相对格宽）
  };

  function lumOf(img, i) { return 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]; }

  // 标定：角采样木色 → 行列暗线密度找网格线 → 返回几何（只跑一次，缓存）
  // 鲁棒性：跳过透明像素（gomocalc 等棋盘层 canvas 四角透明）；背景亮度自适应（亮/暗棋盘）；
  //         首次失败用更宽松参数重试一次。
  function calibrate(cv) {
    var w = cv.width, h = cv.height;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return null; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, w, h).data; } catch (e) { return null; }

    // 背景亮度（原 tryCal 第 1 步），带缓存：多轮 scanGrid 共用，避免重复全图扫描
    var bgBrightCache = null;
    function getBgBright() {
      if (bgBrightCache != null) return bgBrightCache;
      // 四角采样（跳过透明像素）；角区几乎全透明 → 用全图亮度众数兜底；
      // 透明占比高（背景是 CSS 画的，像素里只有线条/棋子）→ 直接用计算样式背景色。
      // 注意：CSS 兜底只在四角采样不足时触发——gomocalc 等棋盘四角有刻度/边框时
      // 计算样式背景是 rgba(0,0,0,0)，绝不能拿它当背景亮度
      var m = Math.max(2, (Math.min(w, h) * DET_CFG.BG_SAMPLE_MARGIN) | 0);
      var sum = 0, n = 0, tr2 = 0, tt2 = 0;
      var corners = [[m, m], [w - m, m], [m, h - m], [w - m, h - m]];
      for (var c = 0; c < corners.length; c++) {
        var cx0 = corners[c][0], cy0 = corners[c][1];
        for (var dy = -m; dy <= m; dy += 2) for (var dx = -m; dx <= m; dx += 2) {
          var sx = cx0 + dx, sy = cy0 + dy;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          var o = (sy * w + sx) * 4;
          tt2++;
          if (img[o + 3] < 96) { tr2++; continue; }
          if (img[o + 3] >= 128) { sum += lumOf(img, o); n++; }
        }
      }
      var bgBright;
      if (n >= 30) {
        // 四角采到真实背景（棋盘木色/底色）→ 直接用均值，不理会 CSS 背景
        bgBright = sum / n;
      } else {
      var hist = new Array(256).fill(0), tot = 0, tr = 0, ttot = 0;
        for (var yy = 0; yy < h; yy += 3) for (var xx = 0; xx < w; xx += 3) {
          var o2 = (yy * w + xx) * 4;
          ttot++;
          if (img[o2 + 3] < 96) { tr++; continue; }
          hist[(lumOf(img, o2) | 0)]++; tot++;
        }
        var bestK = 128, bestC = -1;
        for (var k = 0; k < 256; k++) if (hist[k] > bestC) { bestC = hist[k]; bestK = k; }
        bgBright = tot ? bestK : 128;
        // 兜底 2：canvas 背景大半透明（背景是 CSS 样式画的，像素里只有线条/棋子）
        // → 透明像素的亮度众数没有意义，改用计算样式背景色估算背景亮度
        if (ttot && tr / ttot > 0.30) {
          var csBg = '';
          try { csBg = getComputedStyle(cv).backgroundColor; } catch (e) {}
          var m2 = csBg && csBg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
          if (m2) bgBright = 0.299 * (+m2[1]) + 0.587 * (+m2[2]) + 0.114 * (+m2[3]);
        }
      }
      bgBrightCache = bgBright;
      return bgBright;
    }

    // 逐行/逐列统计暗像素占比（diff 随背景亮度自适应）
    function findLines(score, thr) {
      var lines = [], inLine = false, maxSc = 0, maxPos = 0;
      for (var i = 0; i < score.length; i++) {
        if (score[i] > thr) {
          if (!inLine) { inLine = true; maxSc = score[i]; maxPos = i; }
          else if (score[i] > maxSc) { maxSc = score[i]; maxPos = i; }
        } else if (inLine) { lines.push(maxPos); inLine = false; }
      }
      if (inLine) lines.push(maxPos);
      return lines;
    }

    // 在矩形内（或全图）做行/列暗线统计并匹配 15 线网格。
    // 矩形限定对 PlayOK 这类“整幅 canvas 里还画了玩家列表/聊天等 UI 线”的网站至关重要：
    // 全图统计会混入非棋盘线导致 15 线匹配偏移，先锁定棋盘底色矩形再统计只看到棋盘线。
    function scanGrid(diff, thr, rect) {
      var x0r = rect ? rect.x0 : 0, y0r = rect ? rect.y0 : 0;
      var x1r = rect ? rect.x1 : w - 1, y1r = rect ? rect.y1 : h - 1;
      var bgBright = getBgBright();
      var rowScore = new Array(h), colScore = new Array(w);
      for (var y = 0; y < h; y++) {
        var dark = 0, tot = 0;
        for (var x = 0; x < w; x += 2) {
          var o3 = (y * w + x) * 4;
          tot++;
          // 透明像素算“非暗”（当作背景），避免透明背景 canvas 上每行都被竖线采样点判成 100% 暗线
          if (img[o3 + 3] >= 96 && bgBright - lumOf(img, o3) > diff) dark++;
        }
        rowScore[y] = tot ? dark / tot : 0;
      }
      for (var x2 = 0; x2 < w; x2++) {
        dark = 0; tot = 0;
        for (var y2 = 0; y2 < h; y2 += 2) {
          var o4 = (y2 * w + x2) * 4;
          tot++;
          if (img[o4 + 3] >= 96 && bgBright - lumOf(img, o4) > diff) dark++;
        }
        colScore[x2] = tot ? dark / tot : 0;
      }
      var hLines = findLines(rowScore, thr), vLines = findLines(colScore, thr);
      // 等距筛选：检测结果可能混入棋盘边框/坐标刻度线（比网格线更靠边）。
      // 用“众数间距模板”在检测线上滑动匹配 15 线网格：匹配数优先、位置偏差和次之。
      // 返回多个候选（不同众数间距各取最优），由调用方按“横竖格距相近 + 棋盘线像素量”验证筛选——
      // 因为数字标注/棋子边缘等噪声线也可能等距匹配出 15 根，只返回一个最优会选错。
      function pickGrid(lines) {
        if (!lines || lines.length < 4) return [];
        var diffs = {};
        for (var i = 1; i < lines.length; i++) { var d = lines[i] - lines[i - 1]; diffs[d] = (diffs[d] || 0) + 1; }
        var ds = Object.keys(diffs).map(Number).sort(function (a, b) { return diffs[b] - diffs[a]; });
        var cands = [];
        for (var di = 0; di < Math.min(6, ds.length); di++) {
          var bestD = ds[di];
          if (bestD < 4 || bestD > 200) continue;
          var tol = Math.max(2, bestD * 0.10);
          var best = null, bestScore = 1e18;
          for (var off = lines[0] - bestD * 2; off <= lines[lines.length - 1] - bestD * 12; off += 2) {
            var matched = 0, devSum = 0;
            for (var k = 0; k < 15; k++) {
              var t = off + k * bestD, bd = 1e9;
              for (var j = 0; j < lines.length; j++) { var dd = Math.abs(lines[j] - t); if (dd < bd) bd = dd; }
              if (bd <= tol) { matched++; devSum += bd; }
            }
            if (matched >= 12) {
              var score = (15 - matched) * 1000 + devSum;
              if (score < bestScore) {
                bestScore = score;
                var g = [];
                for (var k2 = 0; k2 < 15; k2++) {
                  var t2 = off + k2 * bestD, bd2 = 1e9, bi2 = -1;
                  for (var j2 = 0; j2 < lines.length; j2++) { var dd2 = Math.abs(lines[j2] - t2); if (dd2 < bd2) { bd2 = dd2; bi2 = j2; } }
                  if (bd2 <= tol) g.push(lines[bi2]);
                }
                best = { first: g[0], last: g[g.length - 1], count: g.length, score: bestScore, d: bestD };
              }
            }
          }
          if (best) cands.push(best);
        }
        cands.sort(function (a, b) { return a.score - b.score; });
        return cands;
      }
      var hgList = pickGrid(hLines), vgList = pickGrid(vLines);
      // 横/竖候选逐一组合验证：横竖格距相近（方格）+ 棋盘线交点暗像素总量足（长线）+ 起点在画布内
      for (var hi = 0; hi < hgList.length; hi++) {
        for (var vi = 0; vi < vgList.length; vi++) {
          var hg = hgList[hi], vg = vgList[vi];
          var bx = vg.first, by = hg.first, bw = vg.last - vg.first, bh = hg.last - hg.first;
          var nx = vg.count, ny = hg.count;
          var stepX = bw / (nx - 1), stepY = bh / (ny - 1);
          if (stepX < 4 || stepX > 200) continue;
          var stepRatio = stepX / Math.max(1, stepY);
          if (stepRatio < 0.7 || stepRatio > 1.45) continue;
          if (bx < -2 || by < -2 || bx > w - stepX * 3 || by > h - stepY * 3) continue;
          var lineDark = 0;
          for (var k = 0; k < 15; k++) {
            var lx = bx + k * stepX, ly = by + k * stepY;
            for (var t = 0; t < 15; t++) {
              var px1 = Math.round(lx), py1 = Math.round(by + t * stepY);
              if (px1 >= 0 && px1 < w && py1 >= 0 && py1 < h) {
                var o1 = (py1 * w + px1) * 4;
                if (img[o1 + 3] >= 96 && bgBright - lumOf(img, o1) > diff) lineDark++;
              }
              var px2 = Math.round(bx + t * stepX), py2 = Math.round(ly);
              if (px2 >= 0 && px2 < w && py2 >= 0 && py2 < h) {
                var o2 = (py2 * w + px2) * 4;
                if (img[o2 + 3] >= 96 && bgBright - lumOf(img, o2) > diff) lineDark++;
              }
            }
          }
          if (lineDark < 200) continue;
          var gs = vg.score + hg.score;
          return { x0: bx, y0: by, stepX: stepX, stepY: stepY, bg: bgBright, cell: stepX, gridScore: gs };
        }
      }
      // 无横竖都匹配：用首尾线直接组装（最宽松兜底）
      if (hLines.length >= 2 && vLines.length >= 2) {
        var bx2 = vLines[0], by2 = hLines[0], bw2 = vLines[vLines.length - 1] - bx2, bh2 = hLines[hLines.length - 1] - by2;
        var nx2 = vLines.length, ny2 = hLines.length;
        var stepX2 = bw2 / (nx2 - 1), stepY2 = bh2 / (ny2 - 1);
        if (stepX2 >= 4 && stepX2 <= 200) {
          var stepRatio2 = stepX2 / Math.max(1, stepY2);
          if (stepRatio2 >= 0.7 && stepRatio2 <= 1.45) {
            var gs2 = 100000 + vLines.length + hLines.length;
            return { x0: bx2, y0: by2, stepX: stepX2, stepY: stepY2, bg: bgBright, cell: stepX2, gridScore: gs2 };
          }
        }
      }
      return null;   // 没有任何可信网格：不瞎猜，交由「手动调节」/截屏兜底
      // gridScore 越小 = 网格越统一（等距 15 线匹配越准）——多 canvas 时优先选真正的棋盘
      var gs = (vg && vg.score != null ? vg.score : 100000 + vLines.length) + (hg && hg.score != null ? hg.score : 100000 + hLines.length);
      return { x0: bx, y0: by, stepX: stepX, stepY: stepY, bg: bgBright, cell: stepX, gridScore: gs };
    }

    // 棋盘底色矩形：全图颜色直方图找主色（棋盘底色通常是整幅 canvas 里占比最大的连续色，
    // 中心采样在棋盘中央有棋子/标注时不可靠）+ 行/列主色占比最长连续段。
    // 整幅 canvas 内棋盘底色（木色/米色等）通常占比最大且集中成矩形，UI 区是别的颜色。
    function bgRect() {
      var hist = {}, bestK = null, bestC = 0, totS = 0;
      for (var y = 0; y < h; y += 4) for (var x = 0; x < w; x += 4) {
        var o = (y * w + x) * 4;
        totS++;
        if (img[o + 3] < 128) continue;
        var key = ((img[o] >> 5) << 10) | ((img[o + 1] >> 5) << 5) | (img[o + 2] >> 5);
        hist[key] = (hist[key] || 0) + 1;
        if (hist[key] > bestC) { bestC = hist[key]; bestK = key; }
      }
      if (!bestK || bestC < totS * 0.04) return null;
      var mr = (((bestK >> 10) & 31) << 5) | 16, mg = (((bestK >> 5) & 31) << 5) | 16, mb = ((bestK & 31) << 5) | 16;
      var tol = 30;
      var cnt = 0, tot = 0;
      for (var y = 0; y < h; y += 4) for (var x = 0; x < w; x += 4) {
        var o = (y * w + x) * 4; tot++;
        if (img[o + 3] >= 128 && Math.abs(img[o] - mr) < tol && Math.abs(img[o + 1] - mg) < tol && Math.abs(img[o + 2] - mb) < tol) cnt++;
      }
      if (!tot || cnt / tot < 0.04) return null;
      function segLen(score, t, len) {
        var best = null, cur = 0, curS = 0;
        for (var i = 0; i <= len; i++) {
          var on = i < len && score[i] > t;
          if (on) { if (cur === 0) curS = i; cur++; }
          else if (cur > 0) { if (!best || cur > best.len) best = { s: curS, e: i - 1, len: cur }; cur = 0; }
        }
        return best;
      }
      var rowScore = new Array(h), colScore = new Array(w);
      for (var y = 0; y < h; y++) {
        var rc = 0, rt = 0;
        for (var x = 0; x < w; x += 4) {
          var o = (y * w + x) * 4; rt++;
          if (img[o + 3] >= 128 && Math.abs(img[o] - mr) < tol && Math.abs(img[o + 1] - mg) < tol && Math.abs(img[o + 2] - mb) < tol) rc++;
        }
        rowScore[y] = rt ? rc / rt : 0;
      }
      for (var x = 0; x < w; x++) {
        var cc = 0, ct = 0;
        for (var y = 0; y < h; y += 4) {
          var o = (y * w + x) * 4; ct++;
          if (img[o + 3] >= 128 && Math.abs(img[o] - mr) < tol && Math.abs(img[o + 1] - mg) < tol && Math.abs(img[o + 2] - mb) < tol) cc++;
        }
        colScore[x] = ct ? cc / ct : 0;
      }
      var rs = segLen(rowScore, 0.55, h), cs = segLen(colScore, 0.55, w);
      if (!rs || !cs || rs.len < 60 || cs.len < 60) return null;
      var bw2 = cs.e - cs.s, bh2 = rs.e - rs.s;
      if (bw2 < 80 || bh2 < 80) return null;
      var asp = bh2 / bw2;
      if (asp < 0.7 || asp > 1.45) return null;
      return { x0: cs.s, y0: rs.s, x1: cs.e, y1: rs.e, color: [Math.round(mr), Math.round(mg), Math.round(mb)] };
    }

    // 优先：棋盘底色矩形内找 15 线（PlayOK 等 canvas 含 UI 干扰时最稳）
    var rect = bgRect();
    var r0 = null;
    if (rect) {
      r0 = scanGrid(DET_CFG.GRID_LINE_DIFF, 0.03, rect);
      if (r0) {
        try { window.__gbDebug = { rect: rect, got: 'rect', cal: r0 }; } catch (e) {}
        return r0;
      }
    }
    // 透明底棋盘 canvas（gomocalc 等：底色是 CSS，canvas 里只有线/子/标注）——
    // 线像素占比只有 2~5%，必须用很低的线检出阈值，靠 pickGrid 的 15 线等距匹配过滤噪声
    var r1 = scanGrid(DET_CFG.GRID_LINE_DIFF, 0.05, null);
    if (r1) {
      try { window.__gbDebug = { rect: rect, got: 'full', cal: r1 }; } catch (e) {}
      return r1;
    }
    // 放宽重试：更暗/更亮的棋盘、细线
    var r2 = scanGrid(Math.max(8, (DET_CFG.GRID_LINE_DIFF / 2) | 0), 0.03, null);
    try { window.__gbDebug = { rect: rect, got: r2 ? 'loose' : 'none', cal: r2 || null }; } catch (e) {}
    return r2;
  }

  function emptyBoard() {
    var b = [];
    for (var j = 0; j < N; j++) b.push(new Array(N).fill(0));
    return b;
  }

  // 读子：每次从实时画布一次性取整图；用“子窗口亮度均值 vs 环带本地底色”判黑白，
  // 阈值相对化（±22），对浅色/深色/带木纹的棋盘都比旧的“全局底色±50+占比”稳健，
  // 避免白子/黑子整片漏判导致引擎拿到残缺局面乱下。
  function readBoard(cal, cv) {
    var w = cv.width, h = cv.height;
    // 离屏 2D 绘制后再读取：兼容 WebGL 渲染的棋盘（直接对源 canvas 取 2d 上下文会返回 null）
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return emptyBoard(); }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, w, h).data; } catch (e) { return emptyBoard(); }
    var bx = cal.x0, by = cal.y0, stepX = cal.stepX, stepY = cal.stepY, bgBright = cal.bg;
    var board = emptyBoard();
    var winR = Math.max(2, Math.min(stepX, stepY) * DET_CFG.STONE_RADIUS_RATIO | 0);
    var rIn2 = winR * winR, r0 = winR * 1.4, r1 = winR * 1.9, rMax = Math.ceil(r1);
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var cx = (bx + c * stepX) | 0, cy = (by + r * stepY) | 0;
        var diskSum = 0, diskN = 0, bgSum = 0, bgN = 0;
        for (var dy = -rMax; dy <= rMax; dy++) {
          for (var dx = -rMax; dx <= rMax; dx++) {
            var d2 = dx * dx + dy * dy;
            var px = cx + dx, py = cy + dy;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            var o = (py * w + px) * 4;
            if (img[o + 3] < 128) continue;   // 透明像素（棋盘层外）不参与亮度统计
            var b = lumOf(img, o);
            if (d2 <= rIn2) { diskSum += b; diskN++; }
            else if (d2 >= r0 * r0 && d2 <= r1 * r1 && ((dx + dy) & 1) === 0) { bgSum += b; bgN++; }
          }
        }
        var localBg = bgN ? bgSum / bgN : bgBright;
        var diskLum = diskN ? diskSum / diskN : localBg;
        var dev = diskLum - localBg;
        // 绝对亮度过滤：子必须明显亮/暗于全局背景。网格线交叉/环带含线造成的
        // “假亮/假暗”（如粗线棋盘空交点被判白）会因此被排除，避免引擎拿到错误局面乱评估
        // 亮底适配：底色越亮，白子相对底色的**最大可能对比**越小（浅米色 #f2ead8 亮度 234
        // → 白子最多只亮 +21 灰阶）。固定 22 的判据会让亮底棋盘上永远读不到白子；
        // 阈值随 (255-底色) 收缩，暗底仍是 22（既有站点行为不变）。
        var bgTol = Math.max(10, Math.min(bgBright * 0.08, (255 - bgBright) * 0.5));
        var needDev = Math.min(22, Math.max(7, (255 - bgBright) * 0.35));
        if (diskLum < bgBright - bgTol && dev < -22) board[r][c] = 1;            // 明显暗于本地底色且暗于全局背景 → 黑
        else if (diskLum > bgBright + bgTol && dev > needDev) board[r][c] = 2;   // 明显亮于本地底色且亮于全局背景 → 白
      }
    }
    return board;
  }

  function countStones(b) {
    var n = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) if (b[j][i]) n++;
    return n;
  }
  // 检测某色是否已在棋盘上连成 >=len 子（含五连即定胜负）。返回达到连长的最大连数。
  function maxLineLen(b, color) {
    var best = 0;
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      if (b[r][c] !== color) continue;
      for (var d = 0; d < 4; d++) {
        var dr = dirs[d][0], dc = dirs[d][1];
        var pr = r - dr, pc = c - dc;                 // 前驱方向有同色则本起点已算过
        if (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === color) continue;
        var len = 1;
        for (var nr = r + dr, nc = c + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) len++;
        if (len > best) best = len;
      }
    }
    return best;
  }
  // 找到“落一子 color 后立即可连成 >=5”的全部空格（制胜手用：科学枚举全部候选，不再只取第一个）。
  // renjuBlack=true（有禁手规则下我方执黑）时只允许恰好五连——长连(>=6)是黑方禁手，落子即判负。
  function allImmediateFiveCells(b, color, renjuBlack) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    var out = [];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      if (b[r][c] !== 0) continue;
      for (var d = 0; d < 4; d++) {
        var dr = dirs[d][0], dc = dirs[d][1];
        // 正反向各数 color 连子
        var cnt = 1;
        for (var nr = r + dr, nc = c + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) cnt++;
        for (var nr = r - dr, nc = c - dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr -= dr, nc -= dc) cnt++;
        if (renjuBlack ? cnt === 5 : cnt >= 5) { out.push({ i: c, j: r }); break; }
      }
    }
    return out;
  }
  // 找到“落一子 color 后立即可连成 >=5”的空格（final step 用）。返回 {i,j} 或 null。
  function findImmediateFive(b, color) {
    var all = allImmediateFiveCells(b, color, false);
    return all.length ? all[0] : null;
  }

  // ============ 连珠（Renju）禁手判定：黑方 长连 / 双四 / 双三 ============
  // 依据连珠规则，黑方落子后若形成以下任一局面即为禁手（落下即判负）：
  //   · 长连(overline)：同一直线连成 6 子及以上；
  //   · 四四(double-four)：同时形成两个“四”（能再落一子成五的形态）；
  //   · 三三(double-three)：同时形成两个“活三”（两边都能发展成活四的三）。
  // 白方无禁手。
  //
  // 说明：引擎（YXSHOWFORBID）是权威来源，本函数是【自研兜底 + 用于自动落子过滤】——
  // 即使引擎未返回禁手列表（旧版引擎/命令未生效），面板也绝不会自动落下黑方禁手点。
  var DIRS4 = [[1, 0], [0, 1], [1, 1], [1, -1]];

  // 在 (x,y) 落 color 后，某方向上的连子长度与两端是否被封。
  // 返回 { len, openA, openB }：len=含落点的连续同色数；open=该端紧邻是否为空格。
  function lineInfoAt(b, color, x, y, dr, dc) {
    var len = 1, openA = false, openB = false;
    var nr = y + dr, nc = x + dc;
    while (nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color) { len++; nr += dr; nc += dc; }
    if (nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === 0) openA = true;
    var pr = y - dr, pc = x - dc;
    while (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === color) { len++; pr -= dr; pc -= dc; }
    if (pr >= 0 && pr < N && pc >= 0 && pc < N && b[pr][pc] === 0) openB = true;
    return { len: len, openA: openA, openB: openB };
  }

  // 判断在 (x,y) 落 color 后，该方向是否形成“四”（再落一子即可成五）。
  // 四的定义：存在一个同方向空格，落子后连成恰好(renju) 或 >=5 子。
  // 实现：把落点当成已成子，沿该方向两侧各扫 5 格内，找“再补一子能到 5”的空位。
  function isFourInDir(b, color, x, y, dr, dc) {
    var li = lineInfoAt(b, color, x, y, dr, dc);
    if (li.len >= 5) return false;              // 已五连/长连 → 不是“四”的定义（另判）
    if (li.len === 4) return li.openA || li.openB;   // 冲四或活四
    // len < 4：检查是否存在一个空格，补上后能连成 5（跳四/嵌五形态）
    var cnt = 0;
    for (var s = -4; s <= 4; s++) {
      if (s === 0) continue;
      var nx = x + dc * s, ny = y + dr * s;
      if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
      if (b[ny][nx] !== 0) continue;
      // 该空格落子后，穿过它的这条线上同色连子数是否达到 5
      var l2 = 1;
      for (var k = 1; k <= 5; k++) { var ax = nx + dc * k, ay = ny + dr * k; if (ax < 0 || ax >= N || ay < 0 || ay >= N || (b[ay][ax] !== color && !(ax === x && ay === y))) break; l2++; }
      for (var k2 = 1; k2 <= 5; k2++) { var bx2 = nx - dc * k2, by2 = ny - dr * k2; if (bx2 < 0 || bx2 >= N || by2 < 0 || by2 >= N || (b[by2][bx2] !== color && !(bx2 === x && by2 === y))) break; l2++; }
      if (l2 === 5) cnt++;
    }
    return cnt > 0;
  }

  // 判断在 (x,y) 落 color 后，该方向是否形成“活三”。
  // 活三的正确定义（连珠）：落子后存在【再落一手】能形成“活四”(两端皆空、可直接成五)的三。
  // 等价且更好实现的判别：在该方向的 6 格窗口内枚举一个“含落点的 3 连段”，
  // 满足 ① 段内 3 格全是 color（落点视作已落）② 段两端紧邻格为空（能延伸成活四）
  // ③ 该段外不紧邻再接同色子（否则实际是四/五/长连，由调用方另判）。
  // 这一判别天然覆盖“跳活三”(X_XX / XX_X 等)：跳三在检查时由窗口枚举自动识别。
  // 旧实现（补一个空格后数 len===3）会把竖线上仅 1 子、旁边恰有空格的局面误判为活三，
  // 造成“无三也报双三”的假禁手（黑方明明能下的点被拦下）。
  function isOpenThreeInDir(b, color, x, y, dr, dc) {
    var li = lineInfoAt(b, color, x, y, dr, dc);
    if (li.len >= 4) return false;                       // 已四连/更长 → 不是三（另判四/五/长连）
    // 沿方向取含落点的连续 6 格窗口（s = -3..2 与 -2..1 等由起始偏移枚举），
    // 只要任一“3 连段”满足条件即为活三。
    // 段起点偏移 st 从 -2 到 0（保证 3 连段 [st, st+2] 覆盖落点 s=0）。
    for (var st = -2; st <= 0; st++) {
      var segOk = true;
      // 段内 3 格必须均为 color 或正是落点
      for (var k = 0; k < 3; k++) {
        var s1 = st + k;
        var ax = x + dc * s1, ay = y + dr * s1;
        if (ax < 0 || ax >= N || ay < 0 || ay >= N) { segOk = false; break; }
        if (!(b[ay][ax] === color || (s1 === 0))) { segOk = false; break; }
      }
      if (!segOk) continue;
      // 段两端紧邻格必须为空（能发展成活四）
      var ex = x + dc * st, ey = y + dr * st;                    // 段起点
      var bx0 = ex - dc, by0 = ey - dr;                          // 段起点再往前一格
      var ex2 = x + dc * (st + 2), ey2 = y + dr * (st + 2);      // 段终点
      var bx1 = ex2 + dc, by1 = ey2 + dr;                        // 段终点再往后一格
      var openA = (bx0 >= 0 && bx0 < N && by0 >= 0 && by0 < N && b[by0][bx0] === 0);
      var openB = (bx1 >= 0 && bx1 < N && by1 >= 0 && by1 < N && b[by1][bx1] === 0);
      if (openA && openB) return true;
    }
    return false;
  }

  // 判定在 (x,y) 落【黑子】是否禁手。返回原因字符串（'' = 合法）。
  // 只在有禁手规则且落子方为黑时调用。
  function renjuBlackForbidden(b, x, y) {
    if (b[y][x] !== 0) return '';
    var d, fours = 0, threes = 0, overline = false;
    for (d = 0; d < 4; d++) {
      var dr = DIRS4[d][0], dc = DIRS4[d][1];
      var li = lineInfoAt(b, 1, x, y, dr, dc);
      if (li.len >= 6) { overline = true; continue; }         // 长连禁手（>=6）
      if (li.len === 5) continue;                             // 恰好五连 → 胜，不算禁手
      if (isFourInDir(b, 1, x, y, dr, dc)) fours++;
      else if (isOpenThreeInDir(b, 1, x, y, dr, dc)) threes++;
    }
    if (overline) return 'overline';
    if (fours >= 2) return 'double-four';
    if (threes >= 2) return 'double-three';
    return '';
  }

  // 黑方所有禁手点（自研兜底；引擎 YXSHOWFORBID 为权威来源，两者取并集更安全）。
  // 只扫已有棋子附近（禁手必与既有棋形相关），整盘 15x15 全扫也不贵（每点 4 方向 × O(1)）。
  function renjuForbiddenCells(b) {
    var out = [];
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
      if (b[r][c] !== 0) continue;
      if (renjuBlackForbidden(b, c, r)) out.push({ x: c, y: r });
    }
    return out;
  }

  // ============ 禁手点统一来源：引擎 YXSHOWFORBID（权威）+ 自研判定（兜底），取并集 ============
  // 历史问题：只做了长连过滤（cnt===5），双四/双三完全没管 → 有禁手规则下黑方自动落子
  // 落到双四/双三点「落下即判负」，表现为“黑子下子不顺/一落就输”。
  // 现在服务端每次分析都随 result.forbid 带回引擎权威禁手列表（面板坐标系），此处缓存；
  // 再用自研 renjuForbiddenCells 兜底（老引擎没实现 YXSHOWFORBID 时依然安全），两者并集。
  var engineForbidSet = null, engineForbidFp = null;

  // 记录本次分析带回的引擎禁手列表（result.forbid 为 [[x,y],...]，面板坐标）。
  function noteEngineForbid(data, fpKey) {
    if (data && data.forbid && data.forbid.length !== undefined) {
      engineForbidSet = {};
      for (var i = 0; i < data.forbid.length; i++) {
        var f = data.forbid[i];
        if (f && f.length === 2) engineForbidSet[f[0] + ',' + f[1]] = 1;
      }
      engineForbidFp = fpKey;
    } else if (fpKey !== engineForbidFp) {
      engineForbidSet = null;   // 新一轮但服务端没带禁手数据（旧引擎/非禁手规则）→ 清掉避免陈留
    }
  }

  // 统一禁手查询：某点是否为黑方禁手点。
  // rule 非 2(有禁手) 时恒 false（无禁手/长连不赢/一手交换规则下黑方无禁手概念）。
  // 只对黑方生效——白方在连珠规则下无禁手。
  function isForbiddenPoint(board, x, y, rule, color) {
    if (rule !== 2) return false;
    if (color !== 1) return false;                     // 只有黑方有禁手
    if (!board || !board[y] || board[y][x] !== 0) return false;
    if (engineForbidSet && engineForbidSet[x + ',' + y]) return true;   // 引擎权威
    return !!renjuBlackForbidden(board, x, y);                          // 自研兜底
  }

  // 从候选列表里剔除禁手点（保持原顺序）。用于自动落子前的最后一道闸。
  function filterForbiddenCands(board, list, rule, color) {
    if (rule !== 2 || color !== 1 || !list || !list.length) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c.x < 0 || c.y < 0 || c.x >= N || c.y >= N) continue;
      if (isForbiddenPoint(board, c.x, c.y, rule, color)) continue;
      out.push(c);
    }
    return out;
  }
  // 假设 color 在 (x,y) 落一子后，能形成的最大同色连子长度（用于“对手落此即五连”的终局点过滤）。
  // 只算穿过该点的四条线，不做全盘扫描（调用在绘制热路径上）。
  function maxLineLenAfter(b, color, x, y) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], best = 0;
    for (var d = 0; d < 4; d++) {
      var dr = dirs[d][0], dc = dirs[d][1], len = 1;
      for (var nr = y + dr, nc = x + dc; nr >= 0 && nr < N && nc >= 0 && nc < N && b[nr][nc] === color; nr += dr, nc += dc) len++;
      for (var nr2 = y - dr, nc2 = x - dc; nr2 >= 0 && nr2 < N && nc2 >= 0 && nc2 < N && b[nr2][nc2] === color; nr2 -= dr, nc2 -= dc) len++;
      if (len > best) best = len;
    }
    return best;
  }
  // 返回 true=轮到对手 / false=轮到我方 / null=我方颜色未知（无法判定，退回旧行为 line[1]）。
  function oppTurnNow(board) {
    var bc = 0, wc = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) { if (board[j][i] === 1) bc++; else if (board[j][i] === 2) wc++; }
    var toMoveBlack = (bc === wc);
    if (mySideMask() < 0) return null;
    var ourBlack = (mySideMask() === 0);
    return (ourBlack !== toMoveBlack);
  }
  // 把“当前行棋方视角的胜率 pv(0~1)”翻成“我方视角”(0~1)。myIsSideToMove=当前是否我方落子。
  function nego2My(pv, myIsSideToMove) { return myIsSideToMove ? pv : (1 - pv); }
  // 从 (i,j) 螺旋向外找最近的空格（制胜手目标格被占时的兜底，保证最后一子总能落下去）
  function nearestEmpty(b, i, j) {
    for (var rad = 1; rad < N; rad++) {
      for (var dy = -rad; dy <= rad; dy++) for (var dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        var x = i + dx, y = j + dy;
        if (x >= 0 && x < N && y >= 0 && y < N && b[y][x] === 0) return { i: x, j: y };
      }
    }
    return null;
  }
  // 就近找“非禁手的空格”（有禁手规则下自动落子的最后兜底）：从 (i,j) 向外一圈圈扫，
  // 跳过已占格与禁手点（isForbiddenPoint 内部已处理“非禁手规则恒 false”）。
  function nearestLegalEmpty(b, i, j, rule, color) {
    for (var rad = 1; rad < N; rad++) {
      for (var dy = -rad; dy <= rad; dy++) for (var dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        var x = i + dx, y = j + dy;
        if (x < 0 || x >= N || y < 0 || y >= N || b[y][x] !== 0) continue;
        if (isForbiddenPoint(b, x, y, rule, color)) continue;
        return { i: x, j: y };
      }
    }
    return null;
  }
  // ============================================================================
  // 【自动落子 · 开局锚点守卫】
  // 用户反馈：自动落子时白子/黑子“落点非常偏”（如 H11 这种离最近棋子 2~3 格的远点）。
  // 根因：Rapfi 在少子 + 浅层搜索（topN=8 × 1.5s）下，best 会周期性落到 H10/G10/H11
  // 这类离最近棋子 ≥3 格的远点（深度不足，分辨不出远点的坏处）。旧自动落子对 data.best
  // 照单全收 → 远点被照原样按下。
  // 五子棋不变量：任何合理着法都落在某颗已有棋子【切比雪夫距离 ≤2】之内
  //（距离 2 允许“跳/间空”连接；距离 ≥3 在少子局面下几乎必为误判）。
  // 故自动落子前做锚点校验，只决定【最终落点】，不影响评估/曲线/热力图/蓝圈显示：
  //   1) 引擎当次 best 合法、近石、非禁手 → 直接用（保留“引擎最新推荐”语义）；
  //   2) 否则从候选（引擎排序，最优在前）里挑【第一个】近石+空+非禁手落点；
  //   3) 候选全远（极少见，如主分析仅 topN=1 且 best 偏离）→ 退回离“已有棋子中心”
  //      最近的空格（螺旋搜索，天然贴近棋子，绝不偏离）；
  //   4) 终极兜底 → 退回原 best / 首候选（仅全盘空且无候选时触发，等价于旧行为）。
  function autoAnchorPick(board, data, candArr, forbidColor, opts) {
    var N = board.length;
    // ★ 2026-09-25 晚三（用户报「智力还不如旧版」）：近石守卫旧实现**无条件**把
    //   「距任意棋子 >2 格」的引擎 best 丢弃、换成贴子点 —— 但深搜（topN=1、≥2.5s）
    //   落远点往往是正着（做杀延诱、远距离防守），被强行拉回贴子 = 白扔引擎的最佳判断，
    //   是实打实的减智点。新契约：
    //   · 深搜结果（budgetMs ≥ 2500 或未指明）一律尊重引擎排序，只做禁手/占格过滤；
    //   · 浅搜（budgetMs < 2500，少子局面浅搜 best 易投远点的老毛病）保留近石守卫；
    //   · 威胁点（我方落此成五 / 对方落此成五的必堵点）任何情况下都不被守卫覆盖。
    var shallow = !!(opts && opts.budgetMs !== undefined && opts.budgetMs < 2500);
    function emptyCell(x, y) { return x >= 0 && y >= 0 && x < N && y < N && board[y] && board[y][x] === 0; }
    // 切比雪夫距离 ≤2 内存在任意棋子（含自身格非空不算，须先为空）
    function nearStone(x, y) {
      if (!emptyCell(x, y)) return false;
      for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
        var yy = y + dj, xx = x + di;
        if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
        if (board[yy][xx] !== 0) return true;
      }
      return false;
    }
    function ok(x, y) {
      if (!emptyCell(x, y)) return false;
      if (forbidColor && isForbiddenPoint(board, x, y, S.rule, forbidColor)) return false;
      return true;
    }
    // —— 威胁判定：在 (x,y) 落 color 是否形成 ≥5 连（含此点，四方向计数）——
    function makesFive(x, y, color) {
      var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (var d = 0; d < 4; d++) {
        var cnt = 1;
        for (var s = 1; s <= 4; s++) {
          var yy = y + dirs[d][1] * s, xx = x + dirs[d][0] * s;
          if (yy < 0 || xx < 0 || yy >= N || xx >= N || board[yy][xx] !== color) break;
          cnt++;
        }
        for (var t = 1; t <= 4; t++) {
          var y2 = y - dirs[d][1] * t, x2 = x - dirs[d][0] * t;
          if (y2 < 0 || x2 < 0 || y2 >= N || x2 >= N || board[y2][x2] !== color) break;
          cnt++;
        }
        if (cnt >= 5) return true;
      }
      return false;
    }
    // 我方落此成五（致胜）或对方落此成五（必堵）都算威胁点 —— 守卫永远给它们让路
    function isThreat(x, y, color) { return makesFive(x, y, color) || makesFive(x, y, color === 1 ? 2 : 1); }
    // ★【开局白子贴身（用户要求：根据 rapfi 白子开局贴近对手黑子）】
    //   落白子且处于开局（盘上总子数 ≤ 10）时，优先在引擎（rapfi）排序里挑
    //   「距对方黑子切比雪夫 ≤2」的点：候选顺序保持不动（尊重引擎评估），只在其上
    //   优先取贴黑者；若 rapfi best 本身贴石但不贴黑，先记为次选 —— 有贴黑候选则让位，
    //   没有则仍用 best（绝不因贴黑而落到引擎完全不看好的远点）。
    var hugOppColor = (forbidColor === 1) ? 2 : (forbidColor === 2 ? 1 : 0);
    var hugOpp = false;
    if (hugOppColor === 1) {
      var stones0 = 0;
      for (var y0 = 0; y0 < N; y0++) for (var x0 = 0; x0 < N; x0++) if (board[y0] && board[y0][x0] !== 0) stones0++;
      hugOpp = stones0 <= 10;
    }
    function nearOpp(x, y) {
      for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
        var yy = y + dj, xx = x + di;
        if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
        if (board[yy][xx] === hugOppColor) return true;
      }
      return false;
    }
    // 1) 引擎当次 best：合法 + 非禁手 → 基本直接用；仅「浅搜 + 非威胁 + 远石」才让位守卫
    //    （白子开局时还须贴黑，威胁点除外，否则记为次选）
    var hugFallback = null;
    if (data && data.best && data.best.length === 2 && data.best[0] >= 0 && data.best[1] >= 0) {
      var bx = data.best[0], by = data.best[1];
      if (ok(bx, by)) {
        var threat0 = isThreat(bx, by, forbidColor);
        if (!shallow || threat0 || nearStone(bx, by)) {
          if (!hugOpp || nearOpp(bx, by) || threat0) return [bx, by];
          hugFallback = [bx, by];
        }
      }
    }
    // 2) 从候选（引擎排序，最优在前）挑第一个合法 + 非禁手落点：
    //    深搜 → 直接取第一个合法候选（尊重引擎）；浅搜 → 仍先近石，威胁点例外。
    var src = (data && data.candidates && data.candidates.length) ? data.candidates
            : (candArr && candArr.length ? candArr : null);
    if (src) {
      if (hugOpp) {
        for (var k2 = 0; k2 < src.length; k2++) {
          var c2 = src[k2];
          if (c2 && c2.x >= 0 && c2.y >= 0 && ok(c2.x, c2.y) && nearStone(c2.x, c2.y) && nearOpp(c2.x, c2.y)) return [c2.x, c2.y];
        }
        if (hugFallback) return hugFallback;   // 无贴黑候选 → 尊重 rapfi 原始 best
      }
      if (shallow) {
        for (var k = 0; k < src.length; k++) {
          var c = src[k];
          if (c && c.x >= 0 && c.y >= 0 && ok(c.x, c.y) && (nearStone(c.x, c.y) || isThreat(c.x, c.y, forbidColor))) return [c.x, c.y];
        }
      } else {
        for (var k3 = 0; k3 < src.length; k3++) {
          var c3 = src[k3];
          if (c3 && c3.x >= 0 && c3.y >= 0 && ok(c3.x, c3.y)) return [c3.x, c3.y];
        }
      }
    }
    // 3) 候选全不可用（浅搜远点且无近石候选时才会走到）：退回离“已有棋子中心”最近的空格
    var sx = 0, sy = 0, cnt = 0, found = false;
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) if (board[y][x] !== 0) { sx += x; sy += y; cnt++; found = true; }
    if (found) {
      var cx = Math.round(sx / cnt), cy = Math.round(sy / cnt);
      var ne = nearestEmpty(board, cx, cy);
      if (ne && ok(ne.i, ne.j)) return [ne.i, ne.j];
    }
    // 4) 终极兜底：保留原 best / 首候选（等价于旧行为，几乎不触发）
    if (data && data.best && data.best.length === 2 && data.best[0] >= 0 && data.best[1] >= 0 && ok(data.best[0], data.best[1]))
      return [data.best[0], data.best[1]];
    if (src && src[0] && src[0].x >= 0 && src[0].y >= 0 && ok(src[0].x, src[0].y)) return [src[0].x, src[0].y];
    return null;
  }
  // ---- 评估值解析：把引擎 eval 转成“我方视角分值 score(-1000..1000) + 判定 verdict + matePly ----
  // 规则（用户要求：评估值 + 评估曲线都是「我们执子」的评估）：
  //   · 纯数字 E（当前行棋方视角）→ 转我方 = myIsSideToMove ? E : -E，clamp 到 [-1000,1000]。
  //   · +M n / -M n（杀棋标记）→ 按【我方视角】归一到 ±1000：我方将成杀 → +1000，我方被杀 → -1000。
  //     M 的「步数」只用于 matePly（±M1 停算闸），绝不换算成 600 分那种伪分值。
  //   · 显示串走 S.myEval（evalToMine 翻符号后的我方视角串）；S.rawEval 只留作内部排障。
  //
  // 【为什么不再把 M 换算成某个中间分数】
  //   旧实现用 `1000 - 500*log10(n)/log10(50)` 把 M 值映射到一个分数（+M17 → 638），
  //   结果这 638 被当普通分值画进 -1000..1000 的曲线，用户看到的就是「只有一手却冲到 600 分、
  //   之后一路平」的怪曲线。现在 M 只归一到 ±1000（曲线贴顶贴底，语义清晰），且【每一手都入点】。
  //
  // 【重要语义约定：score 恒为“我方视角”】
  //   引擎给出的 eval 是【当前行棋方视角】。若直接把行棋方视角的值画进评估曲线，
  //   就会出现“明明优势巨大，曲线却在 0 以下”—— 因为轮到对手走棋那一帧被整段反号了。
  //   evalToScore 已按 myIsSideToMove 换成我方视角（+ 我优 / − 我劣）。
  // out.valid：这次 eval 字符串【解析成功】了吗。曲线入点必须看它——
  // 解析失败（空串 / 非法串）时 score 恒为 0，若不看 valid 就会往曲线里塞一个假的 0 分点。
  function evalToScore(evStr, myIsSideToMove) {
    var out = { score: 0, verdict: 'none', matePly: 0, valid: false };   // verdict: 'win'|'lose'|'none'
    if (typeof evStr !== 'string' || !evStr.length) return out;
    var mN = evStr.match(/^\s*([+-]?)(\d+(?:\.\d+)?)\s*$/);
    var mM = evStr.match(/^\s*([+-]?)M(\d+)\s*$/i);
    if (mM) {
      out.valid = true;
      var negM = mM[1] === '-';
      var nMV = parseInt(mM[2], 10) || 1;
      out.matePly = nMV;
      // M 是“当前行棋方”能否成杀：当前行棋方=我方时 +M 我胜 / -M 我败；否则反转。
      var sideWins = (negM ? false : true);
      var myIsBenefited = (sideWins === myIsSideToMove);   // 对我方是否有利
      // score 只作内部「必胜/必败」标记用（±1000 贴边），不代表真实分值，不进曲线。
      out.score = myIsBenefited ? 1000 : -1000;
      out.verdict = myIsBenefited ? 'win' : 'lose';
    } else if (mN) {
      out.valid = true;
      var negN = mN[1] === '-';
      var E = (negN ? -1 : 1) * parseFloat(mN[2]);
      var mine = myIsSideToMove ? E : -E;                  // 当前行棋方视角 → 我方视角
      out.score = Math.max(-1000, Math.min(1000, mine));
      out.verdict = 'none';
    }
    return out;
  }
  // 【视角归一：把引擎 eval 字符串换算成「我方」视角的显示串】
  // 用户明确要求：「评估值和评估曲线都是我们执子的评估」。
  // 引擎给的 eval 是【当前行棋方】视角：轮到对手走时引擎 +350 表示【对手 +350 = 我方 -350】，
  // 若原样显示就会出现「我执白，却显示一个对我方为负的分数被当成好棋」——语义完全反了。
  // 归一规则（只翻符号，不动量级，绝不把 M 的步数换算成分值）：
  //   数值   E   →  myIsSideToMove ?  E : -E
  //   杀棋 ±MK   →  myIsSideToMove ? ±MK : ∓MK
  function evalToMine(evStr, myIsSideToMove) {
    var s = (typeof evStr === 'string') ? evStr.trim() : '';
    if (!s.length) return '';
    var mM = s.match(/^\s*([+-]?)M(\d+)\s*$/i);
    if (mM) {
      var sg = (mM[1] === '-') ? -1 : 1;
      var mine = myIsSideToMove ? sg : -sg;
      return (mine < 0 ? '-' : '+') + 'M' + mM[2];
    }
    var mN = s.match(/^\s*([+-]?)(\d+(?:\.\d+)?)\s*$/);
    if (mN) {
      var v = (mN[1] === '-' ? -1 : 1) * parseFloat(mN[2]);
      var mv = myIsSideToMove ? v : -v;
      return (mv > 0 ? '+' : '') + String(mv);
    }
    return s;          // 解析不了就原样显示，绝不臆造
  }
  // 粗校验：棋盘网格区域是否存在明显棋子暗/亮斑（读子读出 0 子但棋盘实际有子 → 识别偏移）
  // 读子置信度校验：抽检读出的每个棋子，其交点中心像素应与判定的棋子色一致。
  // 网格偏移/错选棋盘时读出的“棋子”中心往往没有棋子 → bad 比例高 → 提示手动调节，避免瞎评估
  // 判据与 readBoard 完全一致（窗口均值 vs 环带本地底色 + 绝对亮度），避免 3D 光泽棋子
  // （黑子高光/白子阴影）中心像素判色与整体判色不一致造成误报
  function verifyBoard(cal, cv, board) {
    var off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return 0; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return 0; }
    var winR = Math.max(2, Math.min(cal.stepX, cal.stepY) * DET_CFG.STONE_RADIUS_RATIO | 0);
    var rIn2 = winR * winR, r0 = winR * 1.4, r1 = winR * 1.9, rMax = Math.ceil(r1);
    var bgTol = Math.max(10, cal.bg * 0.08);
    var ok = 0, bad = 0;
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        if (!board[j][i]) continue;
        var cx = (cal.x0 + i * cal.stepX) | 0, cy = (cal.y0 + j * cal.stepY) | 0;
        var diskSum = 0, diskN = 0, bgSum = 0, bgN = 0;
        for (var dy = -rMax; dy <= rMax; dy++) {
          for (var dx = -rMax; dx <= rMax; dx++) {
            var d2 = dx * dx + dy * dy;
            var px = cx + dx, py = cy + dy;
            if (px < 0 || px >= cv.width || py < 0 || py >= cv.height) continue;
            var o = (py * cv.width + px) * 4;
            if (img[o + 3] < 128) continue;
            var b = lumOf(img, o);
            if (d2 <= rIn2) { diskSum += b; diskN++; }
            else if (d2 >= r0 * r0 && d2 <= r1 * r1 && ((dx + dy) & 1) === 0) { bgSum += b; bgN++; }
          }
        }
        var localBg = bgN ? bgSum / bgN : cal.bg;
        var diskLum = diskN ? diskSum / diskN : localBg;
        var dev = diskLum - localBg;
        var v = 0;
        if (diskLum < cal.bg - bgTol && dev < -22) v = 1;
        else if (diskLum > cal.bg + bgTol && dev > 22) v = 2;
        if (v === board[j][i]) ok++;
        else bad++;
      }
    }
    var tot = ok + bad;
    if (!tot) return 0;
    return ok / tot;
  }

  // 两盘逐格一致率（含空格）：衡量两个校准在“同一盘面”上的吻合程度。
  // 用于网格纠偏候选评分——旧实现用 verifyBoard(偏移后, 偏移后读数) 自比，任何偏移都≈1，
  // 会在 ±1 行间随机换锚。这里与【原始读盘】逐格比对：正确对齐≈1，错位偏移因棋子移位显著下降。
  function boardMatchRate(a, b) {
    var same = 0;
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) if (a[j][i] === b[j][i]) same++;
    return same / (N * N);
  }
  // 棋盘垂直翻转（上下镜像）：识别层（Python 锚定）偶发以棋盘另一侧为锚 → 数组上下颠倒。
  // 帧间校验判据比几何判据更可靠：正常对局相邻两帧只差≤1 子（匹配率≈≥90%），
  // 镜像帧与上一帧匹配率骤降、但垂直翻转后匹配率回升 → 判定镜像并修正。
  function flipBoardV(b) {
    var nb = emptyBoard();
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) nb[N - 1 - j][i] = b[j][i];
    return nb;
  }

  function roughStoneCheck(cal, cv) {
    var w = cv.width, h = cv.height;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return false; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, w, h).data; } catch (e) { return false; }
    var bg = cal.bg, diff = Math.max(16, bg * 0.30);
    var sx0 = cal.x0, sy0 = cal.y0, step = cal.stepX;
    var x0 = Math.max(0, sx0 | 0), y0 = Math.max(0, sy0 | 0);
    var x1 = Math.min(w, (sx0 + 14 * step) | 0), y1 = Math.min(h, (sy0 + 14 * step) | 0);
    // 跳过网格线附近的采样点（网格线/木纹/星位本身是暗的，但只有棋子是“成团的暗斑”）——
    // 否则空棋盘上的网格线会被误判成“有棋子”，导致读 0 子却提示识别不准
    var dark = 0, light = 0, tot = 0;
    for (var y = y0; y < y1; y += 3) {
      for (var x = x0; x < x1; x += 3) {
        var onLine = false;
        for (var k = 0; k < 15 && !onLine; k++) {
          var lx = sx0 + k * step, ly = sy0 + k * step;
          if (Math.abs(x - lx) <= 2 || Math.abs(y - ly) <= 2) onLine = true;
        }
        if (onLine) continue;
        var o = (y * w + x) * 4;
        if (img[o + 3] < 128) continue;
        var b = lumOf(img, o);
        tot++;
        if (b < bg - diff) dark++;
        else if (b > bg + diff) light++;
      }
    }
    if (!tot) return false;
    return (dark + light) / tot > 0.0015;   // 一枚棋子约占 0.2% 面积；星位点远小于此
  }
  function fingerprint(b) {
    return b.map(function (r) { return r.join(''); }).join('');
  }

  // ---------- 面板 UI（仿 gomocalc 设置页：分组列表 + 绿色勾选 + 步进器） ----------
  var root = document.createElement('div');
  root.id = '__gb_panel';
  root.style.cssText = 'position:fixed;z-index:2147483647;width:225px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
    'background:#fff;border:1px solid #e0e3e8;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
    'top:80px;right:20px;font-size:12px;color:#1d1d1f;overflow:hidden;';
  // 细滚动条样式（局面代码 / 长曲线横滚）
  if (!document.getElementById('__gb_scroll_css')) {
    var sc = document.createElement('style');
    sc.id = '__gb_scroll_css';
    sc.textContent = '#__gb_panel ::-webkit-scrollbar{height:5px;width:5px}#__gb_panel ::-webkit-scrollbar-thumb{background:#b8bdc6;border-radius:3px}#__gb_panel ::-webkit-scrollbar-track{background:transparent}';
    (document.head || document.documentElement).appendChild(sc);
  }

  function optRow(attr, val, label, i18nKey) {
    return '<div class="__gb_opt" ' + attr + '="' + val + '" style="display:flex;align-items:center;padding:4px 12px;border-bottom:1px solid #f0f0f0;cursor:pointer;text-align:left;">' +
      '<span data-i18n="' + i18nKey + '" style="flex:1;text-align:left;">' + label + '</span>' +
      '<span class="__gb_chk" style="color:#43a047;font-size:14px;visibility:hidden;">✓</span></div>';
  }
  var stepBtn = '<button class="__gb_step" data-dir="%d" style="width:26px;height:26px;border-radius:50%;border:1.5px solid #43a047;color:#43a047;background:#fff;font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;">%s</button>';

  root.innerHTML =
    '<div id="__gb_hdr" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#3b7dd8;color:#fff;cursor:move;user-select:none;">' +
      '<span style="flex:1;font-weight:600;" data-i18n="title">' + T('title') + '</span>' +
      '<button id="__gb_lang" title="Language" style="background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:#fff;font-size:11px;cursor:pointer;padding:1px 8px;border-radius:4px;">' + T('lang') + '</button>' +
      // ★ 2026-09-25（用户要求）：书签面板 / 桌面小窗口头部不再显示版本标志（v3.8 徽标删除）——
      //   版本信息只保留在「使用说明」与服务端关于页；extract-panel-ui.js 重跑后桌面版同步。
      '<button id="__gb_min" style="background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;">–</button>' +
      '<button id="__gb_close" style="background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;">×</button>' +
    '</div>' +
    '<div id="__gb_body">' +
      '<div style="font-size:11px;color:#9aa3ad;padding:4px 12px 0;" data-i18n="think">' + T('think') + '</div>' +
      '<div class="__gb_row" style="display:flex;align-items:center;padding:3px 12px;border-bottom:1px solid #f0f0f0;background:#fafbfc;">' +
        '<span class="__gb_lbl" style="flex:1;color:#555;" data-i18n="turn">' + T('turn') + '</span>' +
        stepBtn.replace('%d','turn-').replace('%s','−') +
        '<input id="__gb_turnval" type="number" min="1" max="120" step="1" value="5" ' +
          'style="width:52px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:2px 2px;font-size:12px;margin:0 2px;">' +
        stepBtn.replace('%d','turn+').replace('%s','+') +
      '</div>' +
      '<div class="__gb_row" style="display:flex;align-items:center;padding:3px 12px;border-bottom:1px solid #f0f0f0;background:#fafbfc;">' +
        '<span class="__gb_lbl" style="flex:1;color:#555;" data-i18n="match">' + T('match') + '</span>' +
        stepBtn.replace('%d','match-').replace('%s','−') +
        '<input id="__gb_matchval" type="number" min="30" max="9999" step="10" value="6000" ' +
          'style="width:52px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:2px 2px;font-size:12px;margin:0 2px;">' +
        stepBtn.replace('%d','match+').replace('%s','+') +
      '</div>' +
      '<div class="__gb_row" style="display:flex;align-items:center;padding:3px 12px;border-bottom:1px solid #f0f0f0;background:#fafbfc;">' +
        '<span class="__gb_lbl" style="flex:1;color:#555;" data-i18n="hash">' + T('hash') + '</span>' +
        stepBtn.replace('%d','hash-').replace('%s','−') +
        '<span id="__gb_hashval" style="min-width:48px;text-align:center;color:#333;font-size:12px;">' + T('hashAuto') + '</span>' +
        stepBtn.replace('%d','hash+').replace('%s','+') +
      '</div>' +
      '<div class="__gb_lbl2" style="font-size:11px;color:#9aa3ad;padding:4px 12px 0;" data-i18n="rule">' + T('rule') + '</div>' +
      optRow('data-rule', '0', T('rule0'), 'rule0') +
      optRow('data-rule', '1', T('rule1'), 'rule1') +
      optRow('data-rule', '2', T('rule2'), 'rule2') +
      '<div style="display:flex;align-items:center;gap:6px;padding:4px 12px;">' +
        '<span class="__gb_lbl" style="color:#555;flex:none;" data-i18n="iplay">' + T('iplay') + '</span>' +
        '<button id="__gb_side_black" title="我执黑子" style="padding:3px 10px;border:1px solid #666;border-radius:5px;background:#fff;color:#333;cursor:pointer;font-size:12px;font-weight:600;line-height:1.3;">黑子</button>' +
        '<button id="__gb_side_white" title="我执白子" style="padding:3px 10px;border:1px solid #666;border-radius:5px;background:#fff;color:#333;cursor:pointer;font-size:12px;font-weight:600;line-height:1.3;">白子</button>' +
        '<span id="__gb_side_txt" style="font-size:10px;color:#888;white-space:nowrap;letter-spacing:.2px;"></span>' +
        '<button id="__gb_auto" data-i18n="auto" style="margin-left:auto;padding:2px 7px;border:1px solid #3b7dd8;border-radius:5px;background:#fff;color:#3b7dd8;cursor:pointer;font-size:11px;flex:none;">' + T('auto') + '</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;padding:0 12px 4px;position:relative;">' +
        '<button id="__gb_adjust" style="padding:2px 8px;border:1px solid #e67e22;border-radius:5px;background:#fff;color:#e67e22;cursor:pointer;font-size:11px;">' + T('manual') + '</button>' +
        '<button id="__gb_opacity" data-i18n="opacity" style="position:absolute;left:50%;transform:translateX(-50%);padding:2px 8px;border:1px solid #7a90b8;border-radius:5px;background:#fff;color:#4a6a9a;cursor:pointer;font-size:11px;">' + T('opacity') + '</button>' +
        '<button id="__gb_dark" style="margin-left:auto;padding:2px 8px;border:1px solid #555;border-radius:5px;background:#fff;color:#555;cursor:pointer;font-size:11px;">' + T('dark') + '</button>' +
      '</div>' +
      '<div id="__gb_opacity_pop" style="display:none;flex-direction:column;gap:5px;padding:5px 12px 6px;font-size:11px;color:#666;border-bottom:1px solid #f0f0f0;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span data-i18n="opacity" style="flex:none;width:34px;">' + T('opacity') + '</span>' +
          '<input id="__gb_opacity_range" type="range" min="25" max="100" step="1" style="flex:1;min-width:0;">' +
          '<input id="__gb_opacity_num" type="number" min="25" max="100" step="1" style="width:40px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:1px 0;font-size:11px;">' +
          '<span style="color:#888;">%</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span data-i18n="blur" style="flex:none;width:34px;">' + T('blur') + '</span>' +
          '<input id="__gb_blur_range" type="range" min="5" max="100" step="1" style="flex:1;min-width:0;">' +
          '<input id="__gb_blur_num" type="number" min="5" max="100" step="1" style="width:40px;text-align:center;color:#333;border:1px solid #ccc;border-radius:5px;padding:1px 0;font-size:11px;">' +
          '<span style="color:#888;">%</span>' +
        '</div>' +
      '</div>' +
      '<style>' +
        '#__gb_opacity_range,#__gb_blur_range{-webkit-appearance:none;appearance:none;height:3px;border-radius:2px;background:#cbd2dc;outline:none;cursor:pointer;}' +
        '#__gb_opacity_range::-webkit-slider-thumb,#__gb_blur_range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#3b7dd8;border:none;cursor:pointer;}' +
        '#__gb_opacity_range::-moz-range-thumb,#__gb_blur_range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#3b7dd8;border:none;cursor:pointer;}' +
        '#__gb_panel input[type=number]::-webkit-inner-spin-button,#__gb_panel input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}' +
        '#__gb_panel input[type=number]{-moz-appearance:textfield;}' +
      '</style>' +
      '<div style="display:flex;align-items:center;gap:6px;padding:0 12px 6px;">' +
        '<button id="__gb_heat" data-i18n="heat" style="padding:2px 8px;border:1px solid #3b7dd8;border-radius:5px;background:#fff;color:#3b7dd8;cursor:pointer;font-size:11px;">' + T('heat') + '</button>' +
        '<button id="__gb_opp" style="margin-left:auto;padding:2px 10px;border:1px solid #A5B4FC;border-radius:5px;background:#fff;color:#A5B4FC;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:4px;">' +
          '<i id="__gb_opp_icon" style="width:9px;height:9px;border-radius:50%;border:1.5px dashed #A5B4FC;display:inline-block;"></i>' +
          '<span data-i18n="oppMoves">' + T('oppMoves') + '</span>' +
        '</button>' +
      '</div>' +
      '<div id="__gb_legend" style="display:none;align-items:center;gap:8px;padding:2px 12px 6px;font-size:10px;color:#888;border-bottom:1px solid #f0f0f0;user-select:none;">' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#00bfa5;display:inline-block;"></i><span data-i18n="heatBest">' + T('heatBest') + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#43a047;display:inline-block;"></i><span data-i18n="heatGood">' + T('heatGood') + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#ff7f9f;display:inline-block;"></i><span data-i18n="heatMid">' + T('heatMid') + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:3px;"><i style="width:9px;height:9px;border-radius:50%;background:#ffb3c1;display:inline-block;"></i><span data-i18n="heatLow">' + T('heatLow') + '</span></span>' +
      '</div>' +
      '<div id="__gb_status" style="font-size:11px;color:#666;line-height:1.45;border-top:1px solid #f0f0f0;padding:4px 12px 2px;min-height:48px;" data-i18n="connecting">' + T('connecting') + '</div>' +
      '<div id="__gb_stats" style="padding:6px 12px 2px;">' +
        '<table style="width:100%;border-collapse:collapse;text-align:center;font-size:11px;">' +
          '<tr style="color:#9aa3ad;font-size:10px;padding-bottom:2px;"><td data-i18n="colDepth">深度</td><td data-i18n="colEval">评估</td><td data-i18n="colSpeed">速度</td><td data-i18n="colNodes">节点</td></tr>' +
          '<tr style="font-weight:600;color:#1d1d1f;font-size:12px;padding-top:2px;"><td id="__gb_st_depth">-</td><td id="__gb_st_eval">-</td><td id="__gb_st_speed">-</td><td id="__gb_st_nodes">-</td></tr>' +
        '</table>' +
        '<div id="__gb_st_line" style="color:#666;margin-top:5px;margin-bottom:3px;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>' +
      '</div>' +
      '<div id="__gb_chart_wrap" style="display:flex;align-items:stretch;background:#fafbfc;border-top:1px solid #f0f0f0;">' +
        '<div id="__gb_yaxis" style="flex:none;width:26px;height:100px;position:relative;box-sizing:border-box;"></div>' +
        '<div id="__gb_chart_scroll" style="flex:1 1 auto;overflow-x:auto;overflow-y:hidden;min-width:0;">' +
          '<canvas id="__gb_chart" height="100" style="display:block;"></canvas>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;padding:8px 12px 12px;">' +
        '<button id="__gb_rec" style="flex:1;padding:5px 0;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;" data-i18n="reidentify">' + T('reidentify') + '</button>' +
        '<button id="__gb_analyze" style="flex:1;padding:5px 0;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;" data-i18n="analyze">' + T('analyze') + '</button>' +
        '<button id="__gb_deep" title="30s 深度计算（对标 gomocalc 手动深算）" style="flex:1;padding:5px 0;border:1px solid #8e44ad;border-radius:6px;background:#f5eefb;color:#8e44ad;cursor:pointer;font-size:11px;font-weight:600;">' + T('deep') + '</button>' +
      '</div>' +
      // ★ 2026-09-25（用户要求）：局面 / 保存局面 —— 与桌面版助手同款两个功能键移植进书签版。
      //   局面 = 打开一个浏览器内浮动小窗（识别出的棋盘渲染 + 局面代码，可复制；z-index 置顶、
      //   跟随深浅色与透明度/模糊度、窗口本体无版本号）；保存局面 = 把棋盘渲染成 PNG 下载。
      //   配色**全部走样式表**（行内只留布局）—— 与桌面版「局面键颜色只由 CSS 给」同一纪律，
      //   两套颜色（浅/深）随 applyDark 写在 root 上的 data-dark 属性自动翻转。
      '<style>' +
        '#__gb_footbar{display:flex;gap:6px;padding:0 12px 10px;}' +
        '#__gb_footbar>button{flex:1;padding:5px 0;border-radius:6px;cursor:pointer;box-sizing:border-box;font-size:11px;}' +
        '#__gb_pos{background:#2e7d32!important;color:#fff!important;border:1px solid #2e7d32!important;font-weight:600;}' +
        '#__gb_pos[data-on="1"]{background:#1b5e20!important;border-color:#123f16!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)!important}' +
        '#__gb_pos:hover{filter:brightness(1.08)}' +
        '[data-dark="1"] #__gb_pos{background:#1e3a26!important;color:#9bd6a2!important;border-color:#3f7a4a!important}' +
        '[data-dark="1"] #__gb_pos[data-on="1"]{background:#2c6b3a!important;color:#eafbe9!important;border-color:#5aa869!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)!important}' +
        '[data-dark="1"] #__gb_pos:hover{filter:brightness(1.12)}' +
        '#__gb_possave{background:#fff!important;color:#2e7d32!important;border:1px solid #7cb98a!important}' +
        '#__gb_possave:hover{background:#f2f9f3!important;filter:none}' +
        '[data-dark="1"] #__gb_possave{background:#232a3a!important;color:#9bd6a2!important;border-color:#3f7a4a!important}' +
        '[data-dark="1"] #__gb_possave:hover{background:#2b3346!important}' +
      '</style>' +
      '<div id="__gb_footbar">' +
        '<button id="__gb_pos" data-i18n="posBtn" title="打开局面窗口（识别出来的棋盘 + 局面代码）" style="flex:1;cursor:pointer;">' + T('posBtn') + '</button>' +
        '<button id="__gb_possave" data-i18n="posSave" title="保存局面（把识别到的棋盘渲染成 PNG 图片）" style="flex:1;cursor:pointer;">' + T('posSave') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);
  window.__gbPanel = { toggle: function () { var b = document.getElementById('__gb_body'); b.style.display = (b.style.display === 'none') ? '' : 'none'; } };

  // ★ 2026-09-25 晚（用户）：「关于」不再写在书签面板上 —— 统一挪到引擎启动器页面
  //   （http://127.0.0.1:8964/ 的「关于」区），书签面板只保留功能键，保持轻量。

  // ============================================================================
  // ★ 局面 / 保存局面（2026-09-25 用户要求：桌面版助手同款两键移植进书签版）。
  //   · 局面代码格式与桌面版局面小窗**逐字符同款**（Gomoku15 头 + A:/B:/W: 三行；
  //     坐标 = 列 A..O + 行号自下往上；总代码连写无分隔符）。
  //   · 局面小窗 = 浏览器内浮动窗：z-index 2147483647 置顶（自身免疫识别的一部分——
  //     它永远盖在页面上不会被误认为页面元素，同时识别器对它的 canvas 显式豁免，
  //     截屏识别期间临时隐藏）。
  //   · 窗口 chrome 跟随面板的深浅色 / 透明度 / 模糊度（applyDark / paintPanelBg 联动）；
  //     窗口本体**不显示版本号**（版本只在使用说明与服务端关于页，口径同头部）。
  //   ============================================================================
  var POS_N = 15;
  function buildPositionCode(board) {
    var coord = function (x, y) { return String.fromCharCode(65 + x) + (POS_N - y); };
    var nb = 0, nw = 0, sb = [], sw = [], sa = '';
    for (var y = 0; y < POS_N; y++) {
      for (var x = 0; x < POS_N; x++) {
        var v = board && board[y] ? board[y][x] : 0;
        if (!v) continue;
        var c = coord(x, y);
        sa += c;                                    // 总代码：连写无分隔符（桌面版同款）
        if (v === 1) { nb++; sb.push(c); } else { nw++; sw.push(c); }
      }
    }
    return 'Gomoku15  B:' + nb + '  W:' + nw + '\nA: ' + sa + '\nB: ' + sb.join(',') + '\nW: ' + sw.join(',');
  }
  function posBoardToUse() {
    // 与 analyze() 同源：优先截屏/页面识别里最近一次通过置信度门槛的棋盘
    if (lastGoodBoard) return lastGoodBoard;
    if (pyBoardCache && pyBoardCache.board) return pyBoardCache.board;
    return null;
  }
  function drawPosBoard(cv, board) {
    // ★ 2026-09-25：按设备像素比超采样 —— 固定 240×240 物理像素被 CSS 拉伸 + 高分屏放大
    //   就是「小棋盘模糊」的根因。逻辑坐标保持 240 基准不变，物理分辨率 = 显示宽 × dpr。
    var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    var cssW = cv.clientWidth;
    // 在 DOM 内：按显示宽 × dpr 超采样；离屏 canvas（保存局面导出用）：尊重调用方预设的分辨率
    var px = (cssW && cssW > 10) ? Math.max(240, Math.round(cssW * dpr))
           : (cv.width >= 240 ? cv.width : 240);
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    var ctx = cv.getContext('2d');
    var scale = px / 240;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    var size = 240, pad = 14;
    var step = (size - pad * 2) / (POS_N - 1);
    // 棋盘本体始终画成木色（棋盘是「实物」观感，不随深浅色翻色，防误读）
    ctx.fillStyle = '#dcb35c';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#6b4f2a';
    ctx.lineWidth = 1;
    for (var i = 0; i < POS_N; i++) {
      ctx.beginPath(); ctx.moveTo(pad, pad + i * step); ctx.lineTo(size - pad, pad + i * step); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad + i * step, pad); ctx.lineTo(pad + i * step, size - pad); ctx.stroke();
    }
    // 星位
    [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]].forEach(function (p) {
      ctx.beginPath(); ctx.arc(pad + p[0] * step, pad + p[1] * step, 2.5, 0, 6.284); ctx.fillStyle = '#6b4f2a'; ctx.fill();
    });
    if (board) {
      for (var y = 0; y < POS_N; y++) for (var x = 0; x < POS_N; x++) {
        var v = board[y][x];
        if (!v) continue;
        ctx.beginPath();
        ctx.arc(pad + x * step, pad + y * step, step * 0.44, 0, 6.284);
        ctx.fillStyle = v === 1 ? '#101010' : '#f7f7f7';
        ctx.fill();
        ctx.strokeStyle = v === 1 ? '#000' : '#999';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
  function ensurePosWin() {
    var w = document.getElementById('__gb_poswin');
    if (w) return w;
    w = document.createElement('div');
    w.id = '__gb_poswin';
    // 置顶（面板同款最大 z-index）；位置在面板左侧留出，不遮面板
    w.style.cssText = 'position:fixed;z-index:2147483647;width:262px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;' +
      'border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.22);font-size:12px;overflow:hidden;display:none;';
    w.innerHTML =
      '<div id="__gb_poswin_hd" style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:#2e7d32;color:#fff;cursor:move;user-select:none;">' +
        '<span style="flex:1;font-weight:600;" data-i18n="posWinTtl">' + T('posWinTtl') + '</span>' +
        '<span id="__gb_poswin_cnt" style="font-size:10.5px;opacity:.85;"></span>' +
        '<button id="__gb_poswin_x" style="background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 4px;">×</button>' +
      '</div>' +
      '<div style="padding:8px 10px 4px;"><canvas id="__gb_poswin_cv" width="240" height="240" style="width:100%;display:block;border-radius:6px;"></canvas></div>' +
      '<div style="padding:4px 10px 2px;display:flex;align-items:center;gap:6px;">' +
        '<span data-i18n="fenlabel" style="flex:none;font-size:11px;color:#888;">' + T('fenlabel') + '</span>' +
        '<button id="__gb_poswin_copy" data-i18n="posCopy" style="margin-left:auto;padding:2px 8px;border:1px solid #2e7d32;border-radius:5px;background:#fff;color:#2e7d32;cursor:pointer;font-size:11px;">' + T('posCopy') + '</button>' +
      '</div>' +
      '<pre id="__gb_poswin_code" style="margin:4px 10px 10px;padding:6px 8px;font-size:10.5px;line-height:1.5;border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:96px;overflow-y:auto;font-family:Consolas,monospace;"></pre>';
    document.body.appendChild(w);
    // 拖动（与面板同款：限制可视范围、pointer capture）
    (function () {
      var hd = document.getElementById('__gb_poswin_hd');
      var dragging = false, ox = 0, oy = 0;
      function clamp(x, y) {
        var ww = w.offsetWidth, hh = w.offsetHeight;
        return [Math.max(0, Math.min(x, window.innerWidth - ww)), Math.max(0, Math.min(y, window.innerHeight - hh))];
      }
      hd.addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'BUTTON') return;
        dragging = true;
        var r = w.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        if (hd.setPointerCapture) { try { hd.setPointerCapture(e.pointerId); } catch (err) {} }
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var p = clamp(e.clientX - ox, e.clientY - oy);
        w.style.left = p[0] + 'px'; w.style.top = p[1] + 'px'; w.style.right = 'auto';
      });
      window.addEventListener('mouseup', function () { dragging = false; });
    })();
    document.getElementById('__gb_poswin_x').addEventListener('click', function () { w.style.display = 'none'; });
    document.getElementById('__gb_poswin_copy').addEventListener('click', function () {
      var code = document.getElementById('__gb_poswin_code').textContent;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code);
        else {
          var ta = document.createElement('textarea');
          ta.value = code; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        }
        setStatus(T('copied'));
      } catch (e) {}
    });
    return w;
  }
  /** 局面小窗跟随面板的深浅色 / 透明度 / 模糊度（applyDark / paintPanelBg 末尾都会调）。 */
  function paintPosWin() {
    var w = document.getElementById('__gb_poswin');
    if (!w) return;
    var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
    var d = !!S.dark;
    var bp = (Math.max(5, Math.min(100, S.blur == null ? 50 : S.blur))) / 100;
    var aFrac = a, dFrac = d, bpFrac = bp;   // （命名避开桌面版提取自检的 blur 变量名）
    w.style.background = d ? 'rgba(31,35,48,' + a + ')' : 'rgba(255,255,255,' + a + ')';
    var blurCss = 'blur(' + (bp * 18).toFixed(1) + 'px) saturate(1.35)';
    w.style.backdropFilter = blurCss;
    w.style.webkitBackdropFilter = blurCss;
    w.style.borderColor = d ? '#000' : '#e2e5ea';
    w.style.color = d ? '#e6e8ee' : '#20242e';   // （浅色取近黑，避开桌面提取的灰字改写清单）
    var pre = document.getElementById('__gb_poswin_code');
    if (pre) {
      pre.style.background = d ? 'rgba(38,43,58,.62)' : 'rgba(250,251,252,.62)';
      pre.style.color = d ? '#c8ccd6' : '#3a3f46';
    }
    var cp = document.getElementById('__gb_poswin_copy');
    if (cp) {
      cp.style.background = d ? '#232a3a' : '#fff';
      cp.style.color = d ? '#9bd6a2' : '#2e7d32';
      cp.style.borderColor = d ? '#3f7a4a' : '#7cb98a';
    }
  }
  // ★ 2026-09-25：小窗开着才重画（识别每轮回调，未开窗时零开销）
  function refreshPosWinIfOpen() { if (document.getElementById('__gb_poswin')) refreshPosWin(); }
  function refreshPosWin() {
    var w = document.getElementById('__gb_poswin');
    if (!w || w.style.display === 'none') return;
    var b = posBoardToUse();
    var cv = document.getElementById('__gb_poswin_cv');
    drawPosBoard(cv, b);
    var codeEl = document.getElementById('__gb_poswin_code');
    var cntEl = document.getElementById('__gb_poswin_cnt');
    if (!b) {
      codeEl.textContent = T('posEmpty');
      cntEl.textContent = '';
    } else {
      var nb = 0, nw = 0;
      for (var y = 0; y < POS_N; y++) for (var x = 0; x < POS_N; x++) {
        if (b[y][x] === 1) nb++; else if (b[y][x] === 2) nw++;
      }
      codeEl.textContent = buildPositionCode(b);
      cntEl.textContent = 'B:' + nb + ' W:' + nw;
    }
    paintPosWin();
  }
  // ---- 保存局面：渲染 2x 高清 PNG → 浏览器下载（桌面版同语义）----
  function savePosImage() {
    var b = posBoardToUse();
    if (!b) { setStatus(T('posEmpty')); return; }
    try {
      var cv = document.createElement('canvas');
      // 导出 800×800：保存的 PNG 在高分屏/放大查看也不糊（用户定档，2026-09-25）
      cv.width = 800; cv.height = 800;
      drawPosBoard(cv, b);
      var done = function () { setStatus('<span style="color:#2e7d32;">' + T('posSaveOk') + '</span>'); };
      if (cv.toBlob) {
        cv.toBlob(function (blob) {
          if (!blob) { setStatus(T('posSaveFail') + 'toBlob'); return; }
          var url = URL.createObjectURL(blob);
          var aEl = document.createElement('a');
          aEl.href = url;
          aEl.download = 'gomoku-position-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png';
          document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          done();
        }, 'image/png');
      } else {
        var aEl2 = document.createElement('a');
        aEl2.href = cv.toDataURL('image/png');
        aEl2.download = 'gomoku-position.png';
        document.body.appendChild(aEl2); aEl2.click(); document.body.removeChild(aEl2);
        done();
      }
    } catch (e) { setStatus(T('posSaveFail') + (e.message || e)); }
  }
  (function () {
    var posBtn = document.getElementById('__gb_pos');
    var saveBtn = document.getElementById('__gb_possave');
    if (posBtn) posBtn.addEventListener('click', function () {
      var w = ensurePosWin();
      var show = w.style.display === 'none' || !w.style.display;
      w.style.display = show ? 'block' : 'none';
      if (show) {
        if (!w.style.left && !w.style.top) {
          var pr = root.getBoundingClientRect();
          w.style.left = Math.max(0, pr.left - 274) + 'px';
          w.style.top = Math.max(0, pr.top) + 'px';
        }
        refreshPosWin();
      }
    });
    if (saveBtn) saveBtn.addEventListener('click', savePosImage);
  })();
  // 拖动：限制在可视范围内（防止拖出窗口/卡到角落拖不回来），window 级监听保证 mouseup 不丢
  (function () {
    var dragging = false, ox = 0, oy = 0;
    // ★ 2026-09-25 晚补：删「关于」块时误删了这句声明（当时误判 hdr 无后续引用），
    //   拖动逻辑还靠它 —— 少了它标题栏拖动直接抛 ReferenceError（playwright CSP 测试抓到）。
    var hdr = document.getElementById('__gb_hdr');
    function clamp(x, y) {
      var w = root.offsetWidth, h = root.offsetHeight;
      var maxX = Math.max(0, window.innerWidth - w), maxY = Math.max(0, window.innerHeight - h);
      return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }
    hdr.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      var r = root.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      root.style.right = 'auto'; root.style.left = r.left + 'px'; root.style.top = r.top + 'px';
      if (hdr.setPointerCapture) { try { hdr.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var p = clamp(e.clientX - ox, e.clientY - oy);
      root.style.left = p[0] + 'px';
      root.style.top = p[1] + 'px';
    });
    function stop() { dragging = false; }
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  })();
  document.getElementById('__gb_min').onclick = function () { window.__gbPanel.toggle(); };
  document.getElementById('__gb_close').onclick = function () { overlay.innerHTML = ''; root.remove(); window.__gbPanel = null; };

  // ---------- 控件绑定 ----------
  var autoBtn = document.getElementById('__gb_auto');
  var darkBtn = document.getElementById('__gb_dark');
  var langBtn = document.getElementById('__gb_lang');

  // 开关型按钮（热力图/自动落子）：选中=蓝底白字，未选=白底蓝字（深色模式同款暗底浅字）
  function paintToggle(btn, on) {
    if (!btn) return;
    if (on) { btn.style.background = '#3b7dd8'; btn.style.color = '#fff'; btn.style.borderColor = '#3b7dd8'; }
    else if (S.dark) { btn.style.background = '#262b3a'; btn.style.color = '#c8ccd6'; btn.style.borderColor = '#4a5060'; }
    else { btn.style.background = '#fff'; btn.style.color = '#3b7dd8'; btn.style.borderColor = '#3b7dd8'; }
  }
  function paintAuto() { paintToggle(autoBtn, !!S.autoPlay); }
  function paintHeat() { paintToggle(document.getElementById('__gb_heat'), !!S.heatmap); }

  function applyDark() {
    root.setAttribute('data-dark', S.dark ? '1' : '0');
    darkBtn.textContent = S.dark ? T('light') : T('dark');
    var d = S.dark;
    root.style.borderColor = d ? '#000' : '#e2e5ea';
    // 面板正文：两档都显式给色，避免网站深色 CSS 让继承文字变白不可见
    var body = document.getElementById('__gb_body');
    if (body) body.style.color = d ? '#e6e8ee' : '#1d1d1f';
    // 选项行 / 分隔线
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_opt'), function (el) {
      el.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0';
      el.style.color = d ? '#c8ccd6' : '#333';
    });
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_lbl,.__gb_lbl2'), function (el) {
      el.style.color = d ? '#c8ccd6' : (el.classList.contains('__gb_lbl2') ? '#9aa3ad' : '#555');
    });
    var stEl = document.getElementById('__gb_status');
    if (stEl) stEl.style.color = d ? '#c8ccd6' : '#666';
    var lgEl = document.getElementById('__gb_legend');
    if (lgEl) { lgEl.style.color = '#888'; lgEl.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0'; }
    var st = document.getElementById('__gb_status');
    if (st) st.style.borderTopColor = d ? '#333846' : '#f0f0f0';
    // 自定义步时/局时行的浅色底（透明度：由 paintPanelBg 按透明度统一上色）
    // 输入框 / 下拉（数字栏数值显式给色，防网站 input 深色样式让数字变白）
    Array.prototype.forEach.call(root.querySelectorAll('input,select'), function (el) {
      if (el.type === 'range') return;   // 滑条轨道单独配色
      el.style.background = d ? '#171a24' : '#fff';
      el.style.color = d ? '#e6e8ee' : '#333';
      el.style.borderColor = d ? '#3a4050' : '#ccc';
    });
    var opRg = document.getElementById('__gb_opacity_range');
    if (opRg) opRg.style.background = d ? '#3a4050' : '#cbd2dc';
    var brRg = document.getElementById('__gb_blur_range');
    if (brRg) brRg.style.background = d ? '#3a4050' : '#cbd2dc';
    // 圆形步进按钮（+ / − 符号显式给色）
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_step'), function (el) {
      el.style.background = d ? '#262b3a' : '#fff';
      el.style.borderColor = d ? '#43a047' : '#43a047';
      el.style.color = d ? '#43a047' : '#43a047';
    });
    // 按钮（重新识别 / 分析 两键同款样式，两档都适配深色模式）
    var rec = document.getElementById('__gb_rec');
    if (rec) { rec.style.background = d ? '#262b3a' : '#fff'; rec.style.color = d ? '#e6e8ee' : '#1d1d1f'; rec.style.borderColor = d ? '#3a4050' : '#ddd'; }
    var an = document.getElementById('__gb_analyze');
    if (an) { an.style.background = d ? '#262b3a' : '#fff'; an.style.color = d ? '#e6e8ee' : '#1d1d1f'; an.style.borderColor = d ? '#3a4050' : '#ddd'; }
    var dp = document.getElementById('__gb_deep');
    if (dp) { dp.style.background = d ? '#1e2233' : '#f5eefb'; dp.style.color = d ? '#A5B4FC' : '#8e44ad'; dp.style.borderColor = d ? '#A5B4FC' : '#8e44ad'; }
    var ad = document.getElementById('__gb_adjust');
    if (ad) { ad.style.background = d ? 'transparent' : '#fff'; ad.style.color = '#e67e22'; ad.style.borderColor = '#e67e22'; }
    var opB = document.getElementById('__gb_opacity');
    if (opB) { opB.style.background = d ? '#262b3a' : '#fff'; opB.style.color = d ? '#c8ccd6' : '#4a6a9a'; opB.style.borderColor = d ? '#4a5060' : '#7a90b8'; }
    var opPopEl = document.getElementById('__gb_opacity_pop');
    if (opPopEl) { opPopEl.style.color = d ? '#c8ccd6' : '#666'; opPopEl.style.borderBottomColor = d ? '#2e3340' : '#f0f0f0'; }
    var db = document.getElementById('__gb_dark');
    if (db) { db.style.background = d ? '#262b3a' : '#fff'; db.style.color = d ? '#c8ccd6' : '#555'; db.style.borderColor = d ? '#4a5060' : '#555'; }
    var cvw = document.getElementById('__gb_chart_wrap');
    if (cvw) { cvw.style.borderTop = d ? '1px solid #333846' : '1px solid #f0f0f0'; }
    // 数据面板：表格数字 / 路线 / 局面代码 / 表头（数字栏两档都显式给色）
    Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td'), function (el) { el.style.color = d ? '#c8ccd6' : '#9aa3ad'; });
    Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td[id]'), function (el) { el.style.color = d ? '#e6e8ee' : '#1d1d1f'; });
    var stLine = document.getElementById('__gb_st_line');
    if (stLine) stLine.style.color = d ? '#9aa0ac' : '#666';
    var stFen = document.getElementById('__gb_st_fen');
    if (stFen) stFen.style.color = d ? '#7d8390' : '#9aa3ad';
    // 哈希表数值
    var hv = document.getElementById('__gb_hashval');
    if (hv) hv.style.color = d ? '#c8ccd6' : '#333';
    // 复选框那一行的文字（自动落子 / 热力图 等 label）
    Array.prototype.forEach.call(root.querySelectorAll('label'), function (el) {
      el.style.color = d ? '#c8ccd6' : '#333';
    });
    if (typeof paintOpp === 'function') paintOpp();
    if (typeof paintAuto === 'function') paintAuto();
    if (typeof paintHeat === 'function') paintHeat();
    if (typeof paintPanelBg === 'function') paintPanelBg();
    if (typeof paintSideBtns === 'function') paintSideBtns();   // 我执黑/白按钮随深色模式刷新
    drawChart();
    if (typeof applyLowOpacityText === 'function') applyLowOpacityText();   // 深色+低透明度：正文改黑色
    paintPosWin();
  }
  function applyLang() {
    langBtn.textContent = T('lang');
    // ★ 2026-10-02（用户报「局面窗口英文适配不全面」）：扫描范围必须是 **document 全域**。
    //   「局面」小窗挂在 document.body（ensurePosWin 里 appendChild 到 body，可拖出面板），
    //   旧写法只扫 root（主面板容器）→ 切英文后小窗的标题「局面」/「复制」按钮/「局面」
    //   label 永远停在创建时的语言。data-i18n 是本面板私有属性，全域扫描幂等且无副作用。
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) {
      var k = el.getAttribute('data-i18n');
      if (I18N[S.lang === 'en' ? 'en' : 'zh'][k] !== undefined) el.textContent = T(k);
    });
    darkBtn.textContent = S.dark ? T('light') : T('dark');
    var sbB = document.getElementById('__gb_side_black'), sbW = document.getElementById('__gb_side_white');
    // ★ 2026-10-03 用户要求：「黑和白这两功能键变成黑子和白子」（字号/内边距同步加大，
    //   见 innerHTML 生成处）。中文 黑子/白子；EN 保持 B/W 单字母（按钮宽度不变）。
    if (sbB) sbB.textContent = S.lang === 'en' ? 'B' : '黑子';
    if (sbW) sbW.textContent = S.lang === 'en' ? 'W' : '白子';
    var adBtn = document.getElementById('__gb_adjust');
    if (adBtn) adBtn.textContent = T('manual');
    // 哈希表单位与曲线占位文字随语言刷新
    var hv = document.getElementById('__gb_hashval');
    if (hv) hv.textContent = hashLabel();
    paintSel();
    refreshStatLang();
    drawChart();
  }

  function paintSel() {
    var tv = document.getElementById('__gb_turnval');
    if (tv && document.activeElement !== tv) tv.value = S.customTurnSec;
    var mv = document.getElementById('__gb_matchval');
    if (mv && document.activeElement !== mv) mv.value = S.customSec;
    // 规则
    Array.prototype.forEach.call(root.querySelectorAll('[data-rule]'), function (el) {
      el.querySelector('.__gb_chk').style.visibility = (+el.dataset.rule === S.rule) ? 'visible' : 'hidden';
    });
  }
  function applyPreset() {
    S.matchMs = S.customSec * 1000;
    S.turnMs = S.customTurnSec * 1000;
    save(); paintSel();
  }
  function applyHash() {
    var hv = document.getElementById('__gb_hashval');
    if (hv) hv.textContent = hashLabel();
    save();
    if (!S.hashMB) return;   // 0=自动：跟随引擎服务端档位（内存 1/3 封顶 4GB），不发请求
    try {
      tryLocal(LOCAL_HOSTS, '/api/hash', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mb: S.hashMB }),
      }).catch(function () {});
    } catch (e) {}
  }
  function hashLabel() {
    return S.hashMB ? (S.hashMB + ' ' + T('hashUnit')) : T('hashAuto');
  }
  Array.prototype.forEach.call(root.querySelectorAll('[data-rule]'), function (el) {
    el.onclick = function () { S.rule = +el.dataset.rule; save(); paintSel(); kickAnalyze(); };
  });
  Array.prototype.forEach.call(root.querySelectorAll('.__gb_step'), function (b) {
    b.onclick = function () {
      var d = b.dataset.dir;
      // 步时：0.25 秒步进，最小 0.5 秒（支持小数）；局时：10 秒步进
      if (d === 'turn+') S.customTurnSec = Math.min(6000, Math.round((S.customTurnSec + 0.25) * 100) / 100);
      else if (d === 'turn-') S.customTurnSec = Math.max(0.5, Math.round((S.customTurnSec - 0.25) * 100) / 100);
      else if (d === 'match+') S.customSec = Math.min(30000, S.customSec + 10);
      else if (d === 'match-') S.customSec = Math.max(10, S.customSec - 10);
      else if (d === 'hash+') { S.hashMB = Math.min(4096, S.hashMB + 128); applyHash(); }
      else if (d === 'hash-') { S.hashMB = Math.max(0, S.hashMB - 128); applyHash(); }
      applyPreset(); kickAnalyze();
    };
  });
  // 数字输入：步时 0.5~6000（最多两位小数）；局时 10~30000（整数，无小数）。
  // 实时过滤非法字符（字母/负号/小数点过多/特殊符号），失焦时钳制到合法范围。
  var turnInp = document.getElementById('__gb_turnval');
  var matchInp = document.getElementById('__gb_matchval');
  function sanitizeTurn(v) {
    v = v.replace(/[^\d.]/g, '');               // 只留数字和点
    var parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join(''); // 多个点只保留第一个
    if (v.indexOf('.') >= 0) {
      var h = v.split('.');
      v = h[0] + '.' + h[1].slice(0, 2);        // 小数最多两位
    }
    return v;
  }
  function sanitizeMatch(v) {
    return v.replace(/[^\d]/g, '');              // 只留整数数字
  }
  turnInp.addEventListener('input', function () { this.value = sanitizeTurn(this.value); });
  matchInp.addEventListener('input', function () { this.value = sanitizeMatch(this.value); });
  function readInputs() {
    var t = parseFloat(turnInp.value);
    if (isFinite(t)) S.customTurnSec = Math.min(6000, Math.max(0.5, Math.round(t * 100) / 100));
    var m = parseFloat(matchInp.value);
    if (isFinite(m)) S.customSec = Math.min(30000, Math.max(10, Math.round(m)));
    turnInp.value = S.customTurnSec;
    matchInp.value = S.customSec;
    applyPreset();
  }
  turnInp.addEventListener('change', readInputs);
  matchInp.addEventListener('change', readInputs);

  // ---------- 我执黑/白功能键（用户指定，替代自动识别以保证自动落子稳定） ----------
  // 点击黑 → S.side=0 黑子标亮、白子取消标亮；点击白 → S.side=1 白子标亮、黑子取消标亮。
  var sideBlack = document.getElementById('__gb_side_black');
  var sideWhite = document.getElementById('__gb_side_white');
  var sideTxtEl = document.getElementById('__gb_side_txt');
  // 选中态必须【一眼可辨】，但保持原来的极简观感（用户明确要求：白子不要蓝色轮廓）。
  //   黑选中：黑底白字（原样式）
  //   白选中：白底黑字 + 2px 黑边（靠"内缩的黑框"表示选中白）
  //   未选中：普通灰边，并降低不透明度
  function paintSideBtns() {
    if (!sideBlack || !sideWhite) return;
    var eff = mySideMask(), man = sideIsManual(), dk = S.dark, en = (S.lang === 'en');
    var baseBg = dk ? '#262b3a' : '#fff', baseFg = dk ? '#c8ccd6' : '#555', baseBd = dk ? '#5a6072' : '#999';
    function paint(el, isBlack, on) {
      if (on) {
        el.style.background = isBlack ? '#1a1a1a' : '#fff';
        el.style.color = isBlack ? '#fff' : '#111';
        el.style.border = '2px solid ' + (isBlack ? '#000' : '#111');
        el.style.boxShadow = isBlack ? '0 0 0 1.5px #fff inset' : 'none';
      } else {
        el.style.background = baseBg; el.style.color = baseFg;
        el.style.border = '1px solid ' + baseBd; el.style.boxShadow = 'none';
      }
      el.style.fontWeight = on ? '800' : '600';
      el.style.opacity = (!on && eff >= 0) ? '0.45' : '1';
      el.style.padding = on ? '1px 5px' : '2px 6px';
    }
    paint(sideBlack, true, eff === 0);
    paint(sideWhite, false, eff === 1);
    var unlockTip = en ? ' (locked — click again to unlock)' : '（已锁定，再点一次解除）';
    sideBlack.title = (en ? 'I play Black' : '我执黑') + ((eff === 0 && man) ? unlockTip : '');
    sideWhite.title = (en ? 'I play White' : '我执白') + ((eff === 1 && man) ? unlockTip : '');
    if (sideTxtEl) {
      if (eff < 0) { sideTxtEl.textContent = SF('side_pending'); sideTxtEl.style.color = '#e67e22'; }
      else {
        sideTxtEl.textContent = (man ? SF('side_manual') : SF('side_auto')) + '·' + (eff === 0 ? T('black') : T('white'));
        sideTxtEl.style.color = man ? '#2e7d32' : '#3b7dd8';
      }
    }
  }
  // 我执黑/白：手动指定后【清空自动推断残留】，避免 userSide 与 side 打架导致功能混乱。
  // 再点一次已选中的颜色 → 解除锁定回到自动判定。
  function pickSideManual(mask) {
    var already = (S.side === mask);
    S.side = already ? -1 : mask;        // 0黑 / 1白（-1 = 自动判定）
    S.userSide = -1;                     // 关键：干掉残留的自动推断，二者只能有一个生效
    probeOpen = null; pendingClick = null;   // 放弃正在进行的探测/落子确认（避免按旧颜色继续动作）
    sideConflictCount = 0; sideLockUntil = 0;
    sideVote = { color: -1, n: 0 };              // 换色/解锁：自动识别的票重新攒起
    // ---- 切换颜色 = 作废一切旧颜色的评估结果 ----
    // 用户明确要求：选了哪一手就一直评估那一手，绝不跨黑白。
    // 因此换色时必须把「引擎结果/评估曲线/热力图/对手圈」全部清掉重算：
    //   1) lastEngineFp 置空 → 下一步必然重新请求引擎（不被 fp 节流挡回）；
    //   2) S.candCache 清空 → 旧的候选（按旧颜色算出的洞察）不会再被渲染；
    //   3) overlayStale 置位 → 画布上的旧热力图/最佳圈立即失效；
    //   4) 曲线把最后一帧也换掉 → 曲线不会出现「前段是黑方数据、后段是白方数据」的跨色跳变。
    lastEngineFp = null; lastEngineAt = 0;
    S.candCache = [];
    overlayStale = true;
    lastOppRings = null; lastOppGeom = null;
    stabilizeBestReset();            // 换色：最佳落点稳定器也重置（避免沿用旧颜色的“稳定点”）
    // 换色 = 用户主动宣告"这不是刚才那盘/那一方" → 解除「盘面五连·真终局」的持久化锁。
    // （若不解除：上一局我方五连收官后，用户手动改「我执」开新局时会被锁住，永远不评估）
    if (!already) { haltForNewGame = false; haltReason = ''; clearGameOverLock(); }
    try { clearOverlay(); clearOppSvgLayer(); } catch (e) {}
    try { save(); } catch (e) {}
    paintSideBtns();
    setStatus('<span style="color:#3b7dd8;">' +
      (S.lang === 'en'
        ? (S.side < 0 ? 'Auto side mode — will not evaluate until you pick B/W.'
                      : 'Locked to ' + (S.side === 0 ? '<b>Black</b>' : '<b>White</b>') + ' — re-analyzing for this side only…')
        : (S.side < 0 ? '已取消我执颜色——未选定前不评估。'
                      : '已锁定我执<b>' + (S.side === 0 ? '黑' : '白') + '</b>——只按这一方重新评估…')) + '</span>');
    kickAnalyze();
  }
  sideBlack.onclick = function () { pickSideManual(0); };
  sideWhite.onclick = function () { pickSideManual(1); };
  paintSideBtns();
  if (autoBtn) autoBtn.onclick = function () {
    S.autoPlay = !S.autoPlay; save(); paintAuto();
    if (S.autoPlay) { S.lastFp = ''; analyze(); }   // 开启自动落子后立即按当前局面落子（若轮到我方）
  };
  var heatBtn = document.getElementById('__gb_heat');
  paintHeat();
  function applyHeat() {
    var lg = document.getElementById('__gb_legend');
    if (lg) lg.style.display = S.heatmap ? 'flex' : 'none';
  }
  if (heatBtn) heatBtn.onclick = function () {
    S.heatmap = !S.heatmap; save(); applyHeat(); paintHeat();
    S.candCache = [];                                 // 旧候选来自 topN=1，清掉强制按新档位重算
    kickAnalyze();
  };
  applyHeat();
  var oppBtn = document.getElementById('__gb_opp');
  var oppIcon = document.getElementById('__gb_opp_icon');
  function paintOpp() {
    if (!oppBtn) return;
    if (S.oppMoves) {
      oppBtn.style.background = '#7a5af8'; oppBtn.style.color = '#fff'; oppBtn.style.borderColor = '#7a5af8';
      if (oppIcon) oppIcon.style.borderColor = '#fff';
    } else {
      oppBtn.style.background = S.dark ? '#262b3a' : '#fff';
      oppBtn.style.color = S.dark ? '#c8ccd6' : '#A5B4FC';
      oppBtn.style.borderColor = '#A5B4FC';
      if (oppIcon) oppIcon.style.borderColor = S.dark ? '#c8ccd6' : '#A5B4FC';
    }
  }
  oppBtn.onclick = function () {
    S.oppMoves = !S.oppMoves; save(); paintOpp();
    if (S.oppMoves) startOppEval(); else stopOppEval();   // 独立后台任务随开关启停
    S.candCache = [];                                 // 换档位后强制重算（对手落点需要 topN=8 的 PV 线）
    kickAnalyze();
  };
  paintOpp();
  if (S.oppMoves) startOppEval();   // 开关默认开（迁移 v3）→ 启动独立对手评估后台任务
  darkBtn.onclick = function () { S.dark = !S.dark; save(); applyDark(); };
  langBtn.onclick = function () { S.lang = (S.lang === 'en') ? 'zh' : 'en'; save(); applyLang(); };

  // ---------- 窗口透明度：滑块(25~100) + 数值框(25~100) 同步调节面板透明度 ----------
  var opBtn = document.getElementById('__gb_opacity');
  var opPop = document.getElementById('__gb_opacity_pop');
  var opRange = document.getElementById('__gb_opacity_range');
  var opNum = document.getElementById('__gb_opacity_num');
  var blurRange = document.getElementById('__gb_blur_range');
  var blurNum = document.getElementById('__gb_blur_num');
  var _prevOp = (S.opacity >= 25 && S.opacity <= 100) ? S.opacity : 100;
  // 按键透明度：随窗口透明度等比下降约一半（25%→60%、50%→80%、100%→100%）
  function btnOpacityFor(w) {
    w = Math.max(25, Math.min(100, w));
    var b = (w <= 50) ? (0.8 * w + 40) : (0.4 * w + 60);
    return Math.max(60, Math.min(100, Math.round(b)));
  }
  function paintButtons() {
    // 按键透明度跟随面板透明度（btnOpacityFor 等比下降）：25%→60%、50%→80%、100%→100%
    var o = (btnOpacityFor(S.opacity || 100)) / 100;
    Array.prototype.forEach.call(root.querySelectorAll('button'), function (b) { b.style.opacity = o; });
  }
  // 深色模式 + 面板透明度 <50%：正文保持白色，用深灰色模糊文字阴影保证浅底上仍可读（按键文字不受影响）
  function applyLowOpacityText() {
    var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
    var sh = (!S.dark || a >= 0.5) ? 'none'
      : '0 1px 4px rgba(15,17,23,0.9), 0 0 10px rgba(15,17,23,0.6), 1px 1px 2px rgba(15,17,23,0.8)';
    var body = document.getElementById('__gb_body');
    if (body) body.style.textShadow = sh;
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_opt,.__gb_lbl,.__gb_lbl2,label'), function (el) { el.style.textShadow = sh; });
    var stEl = document.getElementById('__gb_status');
    if (stEl) stEl.style.textShadow = sh;
    var lgEl = document.getElementById('__gb_legend');
    if (lgEl) lgEl.style.textShadow = sh;
    Array.prototype.forEach.call(root.querySelectorAll('#__gb_stats td'), function (el) { el.style.textShadow = sh; });
    var stLine = document.getElementById('__gb_st_line'); if (stLine) stLine.style.textShadow = sh;
    var stFen = document.getElementById('__gb_st_fen'); if (stFen) stFen.style.textShadow = sh;
    var hv = document.getElementById('__gb_hashval'); if (hv) hv.style.textShadow = sh;
    var opPopEl = document.getElementById('__gb_opacity_pop');
    if (opPopEl) opPopEl.style.textShadow = sh;
  }
  // 玻璃态：面板背景半透明 + 背板模糊（通透效果），文字/数字始终保持不透明可读
  function paintPanelBg() {
    var a = (Math.max(25, Math.min(100, S.opacity || 100))) / 100;
    var d = !!S.dark;
    var bp = (Math.max(5, Math.min(100, S.blur == null ? 50 : S.blur))) / 100;
    var blur = 'blur(' + (bp * 18).toFixed(1) + 'px) saturate(1.35)';
    root.style.background = d ? 'rgba(31,35,48,' + a + ')' : 'rgba(255,255,255,' + a + ')';
    root.style.backdropFilter = blur;
    root.style.webkitBackdropFilter = blur;
    root.style.borderColor = d ? 'rgba(255,255,255,' + (0.10 + 0.12 * a).toFixed(3) + ')' : 'rgba(18,38,86,' + (0.08 + 0.14 * a).toFixed(3) + ')';
    Array.prototype.forEach.call(root.querySelectorAll('.__gb_row'), function (el) {
      el.style.background = d ? 'rgba(38,43,58,' + (a * 0.62).toFixed(3) + ')' : 'rgba(250,251,252,' + (a * 0.62).toFixed(3) + ')';
    });
    var cvw = document.getElementById('__gb_chart_wrap');
    if (cvw) cvw.style.background = d ? 'rgba(25,28,38,' + (0.50 * a).toFixed(3) + ')' : 'rgba(250,251,252,' + (0.50 * a).toFixed(3) + ')';
     paintPosWin();
  }
  function applyOpacity() {
    var v = parseInt(S.opacity, 10);
    if (!(v >= 25 && v <= 100)) v = 100;
    var cross = ((v < 50) !== (_prevOp < 50));
    S.opacity = v;
    _prevOp = v;
    paintPanelBg();
    paintButtons();
    if (opRange) opRange.value = v;
    if (opNum) opNum.value = v;
    // 深色模式下跨越 50% 阈值时切换正文颜色（低透明度→黑字；回 50%+→恢复浅色）
    if (S.dark && cross) {
      if (v < 50) applyLowOpacityText();
      else applyDark();
    }
    save();
  }
  function applyBlur() {
    var v = parseInt(S.blur, 10);
    if (!(v >= 5 && v <= 100)) v = 50;
    S.blur = v;
    paintPanelBg();
    if (blurRange) blurRange.value = v;
    if (blurNum) blurNum.value = v;
    save();
  }
  if (opBtn) opBtn.onclick = function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (opPop) opPop.style.display = (opPop.style.display === 'flex') ? 'none' : 'flex';
  };
  if (opRange) opRange.oninput = function () { S.opacity = +opRange.value; if (opNum) opNum.value = S.opacity; applyOpacity(); };
  if (opNum) opNum.onchange = function () {
    var v = parseInt(opNum.value, 10);
    if (!(v >= 25 && v <= 100)) { v = (S.opacity >= 25 && S.opacity <= 100) ? S.opacity : 100; opNum.value = v; }
    S.opacity = v; applyOpacity();
  };
  if (blurRange) blurRange.oninput = function () { S.blur = +blurRange.value; if (blurNum) blurNum.value = S.blur; applyBlur(); };
  if (blurNum) blurNum.onchange = function () {
    var v = parseInt(blurNum.value, 10);
    if (!(v >= 5 && v <= 100)) { v = (S.blur >= 5 && S.blur <= 100) ? S.blur : 50; blurNum.value = v; }
    S.blur = v; applyBlur();
  };
  // 点击面板其它区域关闭透明度弹层
  document.addEventListener('click', function (ev) {
    if (!opPop || opPop.style.display !== 'flex') return;
    if (!(ev.target && ev.target.closest && ev.target.closest('#__gb_opacity,#__gb_opacity_pop'))) opPop.style.display = 'none';
  });
  applyOpacity();
  applyBlur();
  paintSel();
  applyDark();
  applyLang();
  fillStatFromCache();

  // ---------- 推荐落子覆盖层 ----------
  var overlay = document.createElement('div');
  overlay.id = '__gb_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;';
  document.body.appendChild(overlay);

  // ---------- 棋盘识别反馈层（lizzieyzy 式）：天蓝四角 L 框 + 荧光绿星位十字 ----------
  var calib = document.createElement('div');
  calib.id = '__gb_calib';
  calib.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;';
  document.body.appendChild(calib);
  var svgNS2 = 'http://www.w3.org/2000/svg';
  function calibPt(cal, r, isScr, scaleX, scaleY, i, j) {
    return {
      x: (cal.x0 + i * cal.stepX - (isScr ? cal.x0 : 0)) * scaleX,
      y: (cal.y0 + j * cal.stepY - (isScr ? cal.y0 : 0)) * scaleY
    };
  }
  function calibLine(svg, x1, y1, x2, y2, color, width) {
    var l = document.createElementNS(svgNS2, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', color); l.setAttribute('stroke-width', width);
    l.setAttribute('stroke-linecap', 'round');
    svg.appendChild(l);
  }
  function drawCalibFrame(cal, cv) {
    calib.innerHTML = '';
    if (!cal) return;
    var r = cal.topRect || cv.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    var isScr = !!cal.isScreen;
    var scaleX = isScr ? 1 : r.width / cv.width;
    var scaleY = isScr ? 1 : r.height / cv.height;
    var cellPx = cal.cell * scaleX;
    var svg = document.createElementNS(svgNS2, 'svg');
    svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
    svg.style.position = 'absolute';
    calib.style.left = r.left + 'px'; calib.style.top = r.top + 'px';
    calib.style.width = r.width + 'px'; calib.style.height = r.height + 'px';
    // 四角天蓝色 L 形框（识别到的棋盘边界）：两边各一个格子长、稍粗
    var L = Math.max(10, cellPx);
    [[0, 0, 1, 1], [14, 0, -1, 1], [0, 14, 1, -1], [14, 14, -1, -1]].forEach(function (cn) {
      var p = calibPt(cal, r, isScr, scaleX, scaleY, cn[0], cn[1]);
      calibLine(svg, p.x, p.y, p.x + cn[2] * L, p.y, '#00c8ff', 5);
      calibLine(svg, p.x, p.y, p.x, p.y + cn[3] * L, '#00c8ff', 5);
    });
    // 五个星位（D4 D12 H8 L4 L12）荧光绿十字定位标记
    var sLen = Math.max(5, cellPx * 0.16);
    [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].forEach(function (s) {
      var p = calibPt(cal, r, isScr, scaleX, scaleY, s[0], s[1]);
      calibLine(svg, p.x - sLen, p.y, p.x + sLen, p.y, '#39ff14', 3);
      calibLine(svg, p.x, p.y - sLen, p.x, p.y + sLen, '#39ff14', 3);
    });
    calib.appendChild(svg);
  }
  function clearCalibFrame() { calib.innerHTML = ''; }

  // ---------- 手动调节识别区域（拖动/缩放 + 磁吸网格线） ----------
  var adjustMode = false;
  var adj = null;                 // {left, top, width, height} 视口 client 坐标
  var adjust = document.createElement('div');
  adjust.id = '__gb_adjbox';
  adjust.style.cssText = 'position:fixed;z-index:2147483647;display:none;box-sizing:border-box;' +
    'border:2px solid #00c8ff;background:rgba(0,200,255,0.06);cursor:move;pointer-events:auto;';
  document.body.appendChild(adjust);
  var adjHandles = [];
  for (var ahi = 0; ahi < 4; ahi++) {
    var hd = document.createElement('div');
    hd.className = '__gb_adjh';
    hd.style.cssText = 'position:absolute;width:16px;height:16px;background:#00c8ff;border:2px solid #fff;' +
      'border-radius:50%;box-sizing:border-box;cursor:nwse-resize;pointer-events:auto;';
    hd.dataset.corner = ahi;
    adjust.appendChild(hd);
    adjHandles.push(hd);
  }
  // 应用/取消小按钮（框右上角）
  var adjBar = document.createElement('div');
  adjBar.style.cssText = 'position:absolute;top:-30px;right:0;display:flex;gap:4px;';
  adjBar.innerHTML = '<button id="__gb_adjok" style="padding:3px 10px;border:none;border-radius:5px;background:#43a047;color:#fff;font-size:12px;cursor:pointer;">应用 ✓</button>' +
    '<button id="__gb_adjno" style="padding:3px 10px;border:none;border-radius:5px;background:#999;color:#fff;font-size:12px;cursor:pointer;">取消</button>';
  adjust.appendChild(adjBar);
  function layoutAdjustHandles() {
    var hs = adjust.querySelectorAll('.__gb_adjh');
    var set = [['left:-8px;top:-8px;cursor:nwse-resize;', 0], ['right:-8px;top:-8px;cursor:nesw-resize;', 1],
               ['left:-8px;bottom:-8px;cursor:nesw-resize;', 2], ['right:-8px;bottom:-8px;cursor:nwse-resize;', 3]];
    for (var i = 0; i < 4; i++) {
      hs[i].style.cssText = 'position:absolute;width:16px;height:16px;background:#00c8ff;border:2px solid #fff;' +
        'border-radius:50%;box-sizing:border-box;pointer-events:auto;' + set[i][0];
      hs[i].dataset.corner = set[i][1];
    }
  }
  function renderAdjust() {
    if (!adjustMode) return;
    adjust.style.display = 'block';
    adjust.style.left = adj.left + 'px';
    adjust.style.top = adj.top + 'px';
    adjust.style.width = Math.max(40, adj.width) + 'px';
    adjust.style.height = Math.max(40, adj.height) + 'px';
    layoutAdjustHandles();
  }
  // 相位吸附：只吸附“与棋盘网格相位一致”的线（网格线等距排布，模糊边框/刻度不在此相位上，不会误吸）
  // 相位基准 = 进入手动调节时框的左上角（当时框=已校准棋盘 → 在网格线上）；校准失败时退化为当前框的等距网格
  var adjStart = null;
  function magnetize() {
    var ref = cachedBoard || (screenBoard ? { cv: screenBoard.cv, cal: screenBoard.cal } : null);
    if (!ref || !adj) return;
    var cv = ref.cv, cal = ref.cal;
    var topR = cal.topRect || cv.getBoundingClientRect();
    var isScr = !!cal.isScreen;
    var scX = isScr ? 1 : topR.width / cv.width;
    var scY = isScr ? 1 : topR.height / cv.height;
    var off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    var octx;
    try { octx = off.getContext('2d', { willReadFrequently: true }); } catch (e) { return; }
    var img;
    try { octx.drawImage(cv, 0, 0); img = octx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return; }
    var bg = cal.bg, diff = Math.max(12, Math.min(42, bg * 0.22));
    var cx0 = (adj.left - topR.left) / scX, cy0 = (adj.top - topR.top) / scY;
    var cw = adj.width / scX, ch = adj.height / scY;
    // 格长：优先用已校准格长；否则用当前框估
    var cell = (cal.cell > 4 && cal.cell < 300) ? cal.cell : (cw / 14 + ch / 14) / 2;
    // 相位基准（canvas 坐标）：校准的网格第一条线位置最准；无校准信息时退化用进入调节时的框左上
    var pbX = (cal.x0 != null && cal.x0 > -9000) ? cal.x0 : (adjStart ? (adjStart.left - topR.left) / scX : cx0);
    var pbY = (cal.y0 != null && cal.y0 > -9000) ? cal.y0 : (adjStart ? (adjStart.top - topR.top) / scY : cy0);
    function lineLumAt(p, len0, len1, isVertical) {
      var dk = 0, t = 0;
      if (isVertical) {
        for (var y = Math.max(0, (len0 | 0)); y < Math.min(cv.height, len1); y += 2) {
          var o = (y * cv.width + p) * 4; if (img[o + 3] < 128) continue; t++;
          if (bg - lumOf(img, o) > diff) dk++;
        }
      } else {
        for (var x = Math.max(0, (len0 | 0)); x < Math.min(cv.width, len1); x += 2) {
          var o2 = (p * cv.width + x) * 4; if (img[o2 + 3] < 128) continue; t++;
          if (bg - lumOf(img, o2) > diff) dk++;
        }
      }
      return t ? dk / t : 0;
    }
    function snapPhase(center, base, step, len0, len1, isVertical) {
      // 候选相位 = base + k*step（k 取使 center 最近的整数 ±1），每个相位附近 ±2px 找实际暗线峰
      var k = Math.round((center - base) / step);
      var best = null, bestSc = 0.18;
      for (var dk = -1; dk <= 1; dk++) {
        var phase = base + (k + dk) * step;
        var lim = isVertical ? cv.width : cv.height;
        if (phase < 1 || phase >= lim - 1) continue;
        for (var p = Math.max(0, Math.floor(phase - 2)); p <= Math.min(lim - 1, Math.ceil(phase + 2)); p++) {
          var sc = lineLumAt(p, len0, len1, isVertical);
          if (sc > bestSc) { bestSc = sc; best = p; }
        }
      }
      return best;
    }
    // 1) 吸左上角（相位吸附）
    var mLeft = snapPhase(cx0, pbX, cell, cy0 - ch * 0.3, cy0 + ch * 1.3, true);
    var mTop = snapPhase(cy0, pbY, cell, cx0 - cw * 0.3, cx0 + cw * 1.3, false);
    if (mLeft != null) cx0 = mLeft;
    if (mTop != null) cy0 = mTop;
    // 2) 右/下边：相位吸附；结果离 14×cell 太远（相位外误吸）则按格长推出，保证正方形
    var mRight = snapPhase(cx0 + cw, pbX, cell, cy0 - ch * 0.3, cy0 + ch * 1.3, true);
    var mBottom = snapPhase(cy0 + ch, pbY, cell, cx0 - cw * 0.3, cx0 + cw * 1.3, false);
    var w14 = 14 * cell, h14 = 14 * cell;
    if (mRight != null && Math.abs((mRight - cx0) - w14) < cell * 0.5) cw = mRight - cx0;
    else cw = w14;
    if (mBottom != null && Math.abs((mBottom - cy0) - h14) < cell * 0.5) ch = mBottom - cy0;
    else ch = h14;
    if (cw >= 40 && ch >= 40) {
      adj.left = topR.left + cx0 * scX;
      adj.top = topR.top + cy0 * scY;
      adj.width = cw * scX;
      adj.height = ch * scY;
      renderAdjust();
    }
  }
  function applyAdjust() {
    var ref = cachedBoard || (screenBoard ? { cv: screenBoard.cv, cal: screenBoard.cal } : null);
    if (!ref) {
      // 校准失败但页面有棋盘 canvas：直接用用户框选的区域 + 该 canvas 读子（页面内操作，不走截屏）
      var cvs = pickCandidates();
      if (cvs.length) {
        var cv0 = cvs[0];
        ref = {
          cv: cv0,
          cal: {
            x0: 0, y0: 0, stepX: cv0.width / 14, stepY: cv0.height / 14, cell: cv0.width / 14,
            bg: 160, topRect: toTopRect(cv0), docRect: cv0.getBoundingClientRect(),
            frameWin: cv0.ownerDocument.defaultView || window, mode: 'tab'
          }
        };
      }
    }
    if (!ref) { setStatus(SF('no_image')); return; }
    var cv = ref.cv, oldCal = ref.cal;
    var topR = oldCal.topRect || cv.getBoundingClientRect();
    var isScr = !!oldCal.isScreen;
    var scX = isScr ? 1 : topR.width / cv.width;
    var scY = isScr ? 1 : topR.height / cv.height;
    var stp = (adj.width / scX / 14 + adj.height / scY / 14) / 2;   // 正方形格子
    var nCal = {
      x0: (adj.left - topR.left) / scX,
      y0: (adj.top - topR.top) / scY,
      stepX: stp,
      stepY: stp,
      cell: stp,
      bg: oldCal.bg,
      isScreen: isScr, mode: oldCal.mode || 'tab',
      clientX0: adj.left, clientY0: adj.top,
      bw: adj.width, bh: adj.height,
      docRect: oldCal.docRect || topR,   // iframe 内坐标（合成事件用）
      topRect: topR, frameWin: oldCal.frameWin || window
    };
    var cvr = cv.getBoundingClientRect();
    cachedBoard = { cv: cv, cal: nCal, lastRect: { left: cvr.left, top: cvr.top, width: cvr.width, height: cvr.height } };
    screenBoard = null;
    adjustMode = false;
    adjust.style.display = 'none';
    drawCalibFrame(nCal, cv);
    // 五林（Cocos/WebGL）：手动框选结果保存为页面坐标几何，供服务端截屏读子复用
    if (isWulinSite() && adj && adj.left != null && stp > 1) {
      wulinGeoSave({ x0: adj.left, y0: adj.top, stepX: stp * scX, stepY: stp * scY, grid: 15, t: Date.now() });
    }
    setStatus(SF('applied'));
    S.lastFp = '';
    analyze();
  }
  function cancelAdjust() {
    adjustMode = false;
    adjust.style.display = 'none';
    setStatus(SF('cancelled'));
  }
  function startAdjust() {
    var ref = cachedBoard || (screenBoard ? { cv: screenBoard.cv, cal: screenBoard.cal } : null);
    var r;
    if (ref) {
      var rr = ref.cal.topRect || ref.cv.getBoundingClientRect();
      r = { left: rr.left, top: rr.top, width: rr.width, height: rr.height };
    } else {
      var side = Math.min(window.innerWidth, window.innerHeight) * 0.55;
      r = { left: (window.innerWidth - side) / 2, top: (window.innerHeight - side) / 2, width: side, height: side };
    }
    adj = r;
    adjStart = { left: r.left, top: r.top };
    adjustMode = true;
    renderAdjust();
    setStatus(S.lang === 'en' ? 'Drag the blue box to move, drag corners to resize; it snaps to the grid on release. Click Apply ✓ when done.' : '拖动蓝色框移动、拖四角圆点缩放识别区域；松手自动磁吸网格线。满意后点「应用 ✓」');
  }
  // 拖动主体移动
  adjust.addEventListener('mousedown', function (e) {
    if (e.target.classList && e.target.classList.contains('__gb_adjh')) return;
    if (e.target.id === '__gb_adjok' || e.target.id === '__gb_adjno') return;
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY, orig = { left: adj.left, top: adj.top };
    function mv(ev) {
      adj.left = orig.left + (ev.clientX - sx);
      adj.top = orig.top + (ev.clientY - sy);
      renderAdjust();
    }
    function up() {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
      magnetize();
    }
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  });
  // 四角缩放
  adjHandles.forEach(function (hd) {
    hd.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var idx = +hd.dataset.corner;
      var sx = e.clientX, sy = e.clientY, orig = { left: adj.left, top: adj.top, width: adj.width, height: adj.height };
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        var n = { left: orig.left, top: orig.top, width: orig.width, height: orig.height };
        if (idx === 0) { n.left += dx; n.top += dy; n.width -= dx; n.height -= dy; }
        else if (idx === 1) { n.top += dy; n.width += dx; n.height -= dy; }
        else if (idx === 2) { n.left += dx; n.width -= dx; n.height += dy; }
        else { n.width += dx; n.height += dy; }
        if (n.width > 40 && n.height > 40) adj = n;
        renderAdjust();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        magnetize();
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  });
  document.getElementById('__gb_adjok').onclick = applyAdjust;
  document.getElementById('__gb_adjno').onclick = cancelAdjust;

  function clearOverlay() { overlay.innerHTML = ''; overlay.style.cssText = overlay.style.cssText; oppSvg = null; lastOppRings = null; oppRingsFp = null; oppRingsCount = 0; }

  // ---- 落子热力图（4 级）：青(最佳) → 绿(良好) → 粉红(一般) → 浅粉(劣势) ----
  var HEAT_COLORS = ['#00bfa5', '#43a047', '#ff7f9f', '#ffb3c1'];   // 4 档：青→绿→粉红→浅粉（用户指定，不加黄）
  var HEAT_RADII = [0.34, 0.29, 0.25, 0.21];     // 相对格宽的圆半径（逐级略小）
  var HEAT_OPAC = [0.95, 0.85, 0.78, 0.68];        // 逐级透明度
  var OPP_TIER_COLORS = ['#00bfa5', '#43a047'];   // 对手落点评估仅 2 档：青(最优) + 绿(差不多)；青色常出现、青绿同现概率不高
  // 热力图配色：按候选【排名】分 4 档（1=青 最佳 / 2=绿 良好 / 3=粉红 一般 / 4=浅粉 劣势）。
  // 语义 = “这些候选里哪个更好”，即智子/KaTrain 式策略热力图：帮你一眼看出主次。
  //
  // 历史根因（“一直出粉色、青色和其它颜色不同时出现”）：
  //   旧实现先取候选 eval 的 15~85 分位做裁剪，再 min-max 归一化成 0..1 查渐变色带。
  //   但引擎多 PV 候选的 eval 高度聚集（胜局里前 8 条常全是 +500 上下、败局全 -450 上下），
  //   分位裁剪后 hmSpan 极小，浮点噪声被放大成整段色带 → 大部分候选挤进 0.25~0.5 的粉红带，
  //   表现为“整盘只有粉色”。这是归一化对聚集数据不成立，不是颜色本身的问题。
  //
  // 现方案：直接按【分数排名】切档，用名次数而不是分差值来定档：
  //   · 与分数是否聚集无关 → 四色恒能出现，视觉信息量稳定；
  //   · 名次语义清晰：第 1 名=最佳(青)、末位=劣势(浅粉)，中间按比例落绿/粉红；
  //   · 候选越少（如只剩 2 条）也不会跳色到只剩青/粉——按比例均匀铺开。
  function heatTiers(list) {
    var n = list.length, out = [], i;
    if (!n) return out;
    if (n === 1) return [1];                       // 只有一个候选 → 就是最佳(青)
    for (i = 0; i < n; i++) {
      // 名次 0..n-1 → 档 1..4：按比例映射，n=2 时为 青/浅粉，n≥4 时四档齐出
      var t = 1 + Math.floor(i * 4 / n);
      out.push(Math.max(1, Math.min(4, t)));
    }
    return out;
  }
  // 渲染几何去抖：只要 lastGoodCal（已通过置信度门槛的稳定几何）与当前 cal 属于同一画布
  //（格距一致），就一律用 lastGoodCal 的 x0/y0/step 来换算像素坐标。桶状检测器偶发以棋盘
  // 另一侧为锚（上下/左右镜像）时，新 cal 的 y0 会偏离约 14 格但仍保有相同 step —— 若让这种
  // 镜像几何进入渲染，热力图/最佳圈/对手圈会先画在纵坐标镜像位、下一帧才纠正（用户反馈的
  // “圆圈先闪到镜像位置再弹回”）。统一用 lastGoodCal 渲染即可根治：镜像帧不再参与画布。
  function stableCalForRender(cal, cv) {
    if (lastGoodCal && !lastGoodCal.isScreen && !cal.isScreen &&
        lastGoodCal.stepX > 0 && cal.stepX > 0 && lastGoodCal.stepY > 0 && cal.stepY > 0) {
      var sDiff = Math.max(Math.abs(cal.stepX - lastGoodCal.stepX) / lastGoodCal.stepX,
                           Math.abs(cal.stepY - lastGoodCal.stepY) / lastGoodCal.stepY);
      if (sDiff < 0.15) return lastGoodCal;   // 同一画布、同一格距 → 用稳定几何渲染
    }
    return cal;
  }
  // 候选评估值 → 数值（统一到【我方视角】，供颜色分档与排序使用）。
  // 引擎候选的 eval 是【当前行棋方视角】：轮到我方时 +分=我优，轮到对手时 +分=对手优（=我劣）。
  // 旧实现硬编码 evalToScore(..., true) 假定“当前恒是我方走”，于是轮到对手走棋的那一帧
  // 所有评估都会被反号——我方明显占优的点被算成大劣 → 整片粉色/浅粉。
  // 现在按真实轮次传入 myIsSideToMove，保证不同轮次下颜色语义一致。
  function candScoreOf(c, myIsSideToMove) {
    if (c && typeof c.eval === 'string' && c.eval.length) return evalToScore(c.eval, myIsSideToMove !== false).score;
    return 0;
  }

  // 当前盘面“轮到走的一方”（黑先交替）：黑子多于白 → 轮到白(2)；相等/少于 → 黑(1)
  function sideToMoveColor(board) {
    var bn = 0, wn = 0;
    for (var y2 = 0; y2 < board.length; y2++) {
      var r2 = board[y2];
      for (var x2 = 0; x2 < r2.length; x2++) { if (r2[x2] === 1) bn++; else if (r2[x2] === 2) wn++; }
    }
    return (bn > wn) ? 2 : 1;
  }
  // 棋盘黑白互换（1↔2）：发给引擎后“轮到走方”反色，可让引擎从指定颜色视角出候选
  function swappedBoard(b) {
    return b.map(function (r) { return r.map(function (v) { return v === 1 ? 2 : (v === 2 ? 1 : 0); }); });
  }

  // ============================================================================
  // 【★ 我方最佳落点稳定器（抑制蓝圈坐标跳跃）★】
  // 用户反馈（原话）：「取消自动识别先后手了，应该是很稳定的，但是，我方要下的位置蓝色圆圈
  //                      还是会坐标跳跃」。
  //
  // 为什么会在【等价点】之间跳：
  //   引擎（尤其短步/浅搜索或多次 PV 分数接近时）对「同样好的几个点」的排序是不稳定的 ——
  //   同一局面连续几帧的 best 可能在 A / B / C 之间来回变（分数差常 < 30 分，属浮点/搜索噪声）。
  //   面板每次收到新 best 就把蓝圈直接挪过去 → 用户看到圆圈在两个格子间反复横跳。
  //
  // 做法（滞回 / hysteresis，只影响【显示】，绝不影响落子）：
  //   · 盘面指纹 + 轮次 + 我方颜色 完全相同（= 同一局面反复评估）时：
  //       - 新 best 与「当前稳定点」同格 → 原样保持；
  //       - 不同格 → 需要连续 STABLE_CONFIRM 次都指向新点，才允许切换；
  //       - 或者新点分数比当前稳定点高出 STABLE_MARGIN 分以上（明显更优）→ 立即切换（不拖慢真实好棋）。
  //   · 盘面一变（对手/我方落子）→ 立刻重置，用引擎新结果（不残留上一局的点）。
  //   返回值恒为「应当用于绘制的 best」，落子逻辑仍单独使用引擎当次返回的 data.best。
  // ============================================================================
  var STABLE_CONFIRM = 2;      // 连续几次推荐同一新点才切换（1 次太敏感，3 次偏慢）
  var STABLE_MARGIN = 120;     // 新点分数领先这么多即视为「明显更优」，立即切换
  var bestStable = { key: null, x: -1, y: -1, score: null, candX: -1, candY: -1, candN: 0 };
  function stabilizeBest(best, cands, fpKey, scoreOf) {
    if (!best || best.length !== 2 || best[0] < 0 || best[1] < 0 || best[0] >= N || best[1] >= N) return best;
    var bx = best[0], by = best[1];
    if (bestStable.key !== fpKey) {                 // 新局面 → 直接采纳，重置计数
      bestStable = { key: fpKey, x: bx, y: by, score: scoreOf ? scoreOf(bx, by) : null, candX: bx, candY: by, candN: 1 };
      return best;
    }
    if (bx === bestStable.x && by === bestStable.y) {  // 与稳定点一致 → 计数清零
      bestStable.candN = 0; bestStable.candX = -1; bestStable.candY = -1;
      bestStable.score = scoreOf ? scoreOf(bx, by) : null;
      return [bestStable.x, bestStable.y];
    }
    // 新点与稳定点不同：先看是否「明显更优」
    var newSc = scoreOf ? scoreOf(bx, by) : null;
    var oldSc = bestStable.score;
    if (newSc != null && oldSc != null && (newSc - oldSc) >= STABLE_MARGIN) {
      bestStable = { key: fpKey, x: bx, y: by, score: newSc, candX: bx, candY: by, candN: 1 };
      return best;
    }
    // 否则要求「连续 N 次都指向同一个新点」才切换
    if (bx === bestStable.candX && by === bestStable.candY) bestStable.candN++;
    else { bestStable.candX = bx; bestStable.candY = by; bestStable.candN = 1; }
    if (bestStable.candN >= STABLE_CONFIRM) {
      bestStable = { key: fpKey, x: bx, y: by, score: newSc, candX: -1, candY: -1, candN: 0 };
      return best;
    }
    return [bestStable.x, bestStable.y];            // 仍显示稳定点，抑制跳跃
  }
  function stabilizeBestReset() { bestStable = { key: null, x: -1, y: -1, score: null, candX: -1, candY: -1, candN: 0 }; }

  function drawOverlay(cal, cv, cands, best, board, myIsSideToMove) {
    // 我方刚落完子：旧盘面评估已由 clearOverlayKeepOpp 清空（对手虚线圆保留）。
    // 新盘面分析完成后热力图照常绘制——不再被 overlayStale 卡住（否则我方落子后热力图
    // 一直不画，表现为“有的颜色没有显示”，直到对手落子才恢复）。
    overlayStale = false;
    // 渲染几何去抖：同一画布先用 lastGoodCal 的稳定几何换算像素，避免镜像帧参与绘制
    //（否则热力图/最佳圈/对手圈先画在纵坐标镜像位、下一帧才纠正 → “圆圈闪到镜像再弹回”）。
    cal = stableCalForRender(cal, cv);
    // 视口矩形：坚持每次取最新 cv 的实时定位（滚动/缩放/页面重排后立即对齐），
    // 不依赖缓存 cal.topRect —— 缓存矩形在滚动后过期正是“圆圈时好时坏错位”的元凶。
    // 几何换算统一走 overlayGeom（与对手层同一套公式，杜绝两层错位）。
    var g = overlayGeom(cal, cv);
    if (!g) {
      var oh0 = overlay.querySelector('#__gb_heat_svg');
      if (oh0) { try { overlay.removeChild(oh0); } catch (e) {} }
      return;
    }
    var r = g.r, cellPx = g.cellPx, svgNS = 'http://www.w3.org/2000/svg';
    // 复用已有热力层容器：只清空 <circle> 子节点后重填，省掉 remove+createElement+append 三次重排
    //（250ms 实时轮询下这三次重排是热力图闪烁的主要来源）。
    var svg = overlay.querySelector('#__gb_heat_svg');
    if (svg) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
    } else {
      svg = document.createElementNS(svgNS, 'svg');
      svg.id = '__gb_heat_svg';
      svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
      svg.style.position = 'absolute';
      svg.style.zIndex = '10';   // 热力层在下；对手层 zIndex=20 恒在上——否则档1 青圆(半径0.34/透明度0.95)盖住对手虚线圆(半径0.26) → “圈不显示”
    }
    overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    var pt = g.pt;
    // ★ 最佳落点稳定化：抑制「我方要下的位置蓝圈坐标跳跃」（同局面反复评估时 best 在等价点间横跳）。
    //   只影响绘制用的 best；落子仍用引擎当次返回的 data.best。
    //   fpKey = 盘面指纹 + 轮次 + 我方颜色：任一变化（落子/换色/换轮次）即重置，不残留上一局的点。
    if (board) {
      var _sbKey = fingerprint(board) + '#' + (myIsSideToMove === false ? 'o' : 'm') + '#' + myColorCode();
      var _sbScore = function (x2, y2) {
        if (!cands) return null;
        for (var si = 0; si < cands.length; si++) {
          if (cands[si] && cands[si].x === x2 && cands[si].y === y2) return candScoreOf(cands[si], myIsSideToMove !== false);
        }
        return null;
      };
      best = stabilizeBest(best, cands, _sbKey, _sbScore);
    }
    // 候选 + 分级：热力图与对手落点共用同一套（对手虚线圆颜色随候选档位）
    // myIsSideToMove：请求分析的盘面里，当前行棋方是否就是我方。引擎 eval 是行棋方视角，
    // 必须据此换算成我方视角才能正确分档（见 candScoreOf 注释）。
    // 未显式传入（旧调用点）时按“我方走棋”处理，与历史行为一致。
    var isMyMove = (myIsSideToMove !== false);
    var list = null, tiers = null;
    if (S.heatmap || S.oppMoves) {
      list = [];
      for (var hi = 0; hi < cands.length; hi++) {
        var hc = cands[hi];
        if (!hc || hc.x < 0) continue;
        var hsc = candScoreOf(hc, isMyMove), hdup = -1;
        for (var hd2 = 0; hd2 < list.length; hd2++) if (list[hd2].c.x === hc.x && list[hd2].c.y === hc.y) { hdup = hd2; break; }
        if (hdup >= 0) { if (hsc > list[hdup].score) list[hdup] = { c: hc, score: hsc }; }   // 同点保留最高分
        else list.push({ c: hc, score: hsc });
      }
      // 最佳对齐目标：优先显式 best 参数；无效（null/越界）时回退到 cands[0]——
      // renderResult 的“推荐”显示正是 cands[0]，保证热力图档1+浅蓝描边与“推荐”恒为同一格，
      // 杜绝“状态栏推荐 D10、热力图最佳却描在 E9”这类坐标不一致（旧版只信 best 参数，
      // best 为 null/丢失时退回纯 score 排序，浅搜高分候选会顶替最佳档位）。
      var best0 = (best && best.length === 2 && best[0] >= 0 && best[1] >= 0 && best[0] < 15 && best[1] < 15) ? best : null;
      if (!best0 && cands && cands.length && cands[0] && cands[0].x >= 0) best0 = [cands[0].x, cands[0].y];
      list.sort(function (a, b) {
        var aB = (best0 && a.c.x === best0[0] && a.c.y === best0[1]) ? 1 : 0;
        var bB = (best0 && b.c.x === best0[0] && b.c.y === best0[1]) ? 1 : 0;
        if (aB !== bB) return bB - aB;
        return b.score - a.score;
      });
      tiers = heatTiers(list);
    }
    if (S.heatmap) {
      // ---- 落子热力图：绝对阈值 4 档配色（青/绿/粉红/浅粉）----
      // 档位由 heatTiers 按候选排名给出（见 heatTiers 注释）：
      // 不再做分位裁剪+min-max 归一化——那会把聚集的候选挤进粉红带（“整盘只有粉色”的根因）。
      // 弱→强顺序绘制（先浅粉后青），强的青盖在最上层，主次一目了然。
      var hmByStrong = [];
      for (var hi2 = 0; hi2 < list.length; hi2++) hmByStrong.push(hi2);
      hmByStrong.sort(function (a, b) { return (list[a].score - list[b].score); });   // 升序：弱在前
      for (var di = 0; di < hmByStrong.length; di++) {
        var li = hmByStrong[di];
        var hTier = tiers[li] || 1;                    // 1~4 档（1=青 最佳）
        var hc2 = list[li].c;
        if (board && board[hc2.y] && board[hc2.y][hc2.x] !== 0) continue;   // 已占格不画（对方/我方刚落下的子绝不被圈）
        var p = pt(hc2.x, hc2.y);
        var i5 = document.createElementNS(svgNS, 'circle');
        i5.setAttribute('cx', p.x); i5.setAttribute('cy', p.y);
        // 档位 → 半径/不透明度：最佳档更大更实、劣势档略小略透，主次一目了然
        i5.setAttribute('r', String(cellPx * HEAT_RADII[hTier - 1]));
        i5.setAttribute('fill', HEAT_COLORS[hTier - 1]);
        i5.setAttribute('opacity', String(HEAT_OPAC[hTier - 1]));
        // 最佳点（与 best0 同格）：浅蓝色描边，一眼定位引擎推荐落点
        if (best0 && list[li].c.x === best0[0] && list[li].c.y === best0[1]) {
          i5.setAttribute('stroke', '#9ad0ff');
          i5.setAttribute('stroke-width', String(Math.max(1.5, cellPx * 0.06)));
        }
        svg.appendChild(i5);
      }
    } else {
      // 关闭热力图：最佳位置 = 蓝色较粗的空心圆（不遮棋子、一眼定位）
      var c0 = cands[0];
      if (c0 && c0.x >= 0 && !(board && board[c0.y] && board[c0.y][c0.x] !== 0)) {
        var pb = pt(c0.x, c0.y);
        var bestR = document.createElementNS(svgNS, 'circle');
        bestR.setAttribute('cx', pb.x); bestR.setAttribute('cy', pb.y);
        bestR.setAttribute('r', cellPx * 0.30);
        bestR.setAttribute('fill', 'none');
        bestR.setAttribute('stroke', '#1e6fe8');
        bestR.setAttribute('stroke-width', String(Math.max(3, cellPx * 0.09)));
        svg.appendChild(bestR);
      }
    }
    // 对手落点评估已移至独立后台任务 runOppEval + 独立 SVG 层 #__gb_opp_svg（zIndex=20 恒在热力层上）：
    // 热力层不再画对手圈（避免同层绘制被 liveTimer 250ms 重画覆盖、以及数据源轮次混乱）。
    // 容器可能已被复用（仍在 overlay 内）→ 只在尚未挂载时才 append，避免重复 append 抛错。
    if (svg.parentNode !== overlay) overlay.appendChild(svg);
    // 对手层若存在，热力层 append 会把它压到下层 → 重新 append 对手层保证 zIndex 语义（对手圈恒在最上）。
    if (oppSvg && oppSvg.parentNode === overlay) overlay.appendChild(oppSvg);
    // 【★★ 对手圆环与热力图同帧出现（用户明确要求）★★】
    //   旧链路：热力图由主分析/实时轮询 250ms 重画，而对手圈由独立任务 runOppEval 每 2000ms
    //   才画一次 → 两者节奏差最多 2s。表现就是「热力图已经变了，对手圈还是上一帧的/慢半拍才出现」。
    //   现在：热力层每次重画后，立即用【最近一次算好的对手圈数据 lastOppRings】
    //   按当前几何重新投影一次对手层 → 两层的可见更新落在同一帧，节奏完全同步。
    //   注意这里只是「重投影已有数据」、不触发任何引擎请求，不会增加搜索负担、也不会抢引擎。
    // ★【终局闸 · 本轮修复】任一方已成五连 → 绝不投影对手圈。
    //   这是「圈乱出」的第二道保险：即使 lastOppRings 因任何原因残留（别的分支漏了作废、
    //   或 runOppEval 的飞行中实例抢先落笔），终局盘面上也永远不会再冒出预测圈。
    //   终局语义：五子连珠一成立，棋局结束 → "对手要下哪里"这个问题不再有答案，答案恒为 0 个圈。
    if (S.oppMoves && lastOppRings && lastOppRings.length && cal && cv && !boardHasFive(board)) {
      try { drawOppSvg(cal, board, lastOppRings); } catch (e) {}
    }
  }

  // ============ 对手落点评估：独立后台任务（用户方案：像 gomocalc 一样后台同时算双方执子） ============
  // 完全独立于主分析/热力图链路：自己的引擎请求、自己的绘制层（#__gb_opp_svg，zIndex=20 恒在热力层上）。
  // 每 3s 周期 + 主分析完成（refreshOverlayCands 后）立即触发；与主分析错峰（S.analyzing 时跳过），
  // 不抢引擎 → 热力图颜色不受影响、对手圈独立显示（历史根因：互换盘塞进热力链路 → 超时 abort → 颜色缺失+圈不显示）。
  var oppEvalBusy = false, oppEvalTimer = null;
  // 【★ 清层 = 数据一起失效（本轮修复「对手圈乱出」的根因之一）★】
  //   旧实现只摘掉 SVG 节点、**保留 lastOppRings/lastOppKey**。而 drawOverlay 末尾有一条
  //   「对手圈与热力图同帧」的重投影通道：
  //       if (S.oppMoves && lastOppRings && lastOppRings.length && cal && cv) drawOppSvg(cal, board, lastOppRings);
  //   它只看 lastOppRings 是否有数据 —— 于是【下一次热力层重画就会把刚清掉的圈原样复活】。
  //   终局那一刻（我方刚落下五连制胜手）表现就是「圈清了一下又冒出来」，而且冒出几个取决于
  //   lastOppRings 残留的是 1 个还是 2 个 —— 正是用户反馈的
  //   「3/4 概率只出青色圈、1/4 概率青色绿色同时出」这种按概率出现的观感
  //   （概率来自"热力层重画恰好落在哪个 250ms tick"）。
  //   改为：清层即数据失效 → 重投影通道自然关闭，终局之后一定是 0 个圈。
  function clearOppSvgLayer() {
    try { if (oppSvg && oppSvg.parentNode === overlay) overlay.removeChild(oppSvg); } catch (e) {}
    oppSvg = null; lastOppGeom = null;
    lastOppRings = null; lastOppKey = null;
  }
  function startOppEval() {
    // 周期 2000ms → 1200ms → 现在 700ms（用户反馈「对手评估有一点点慢了」）。
    // 为什么可以再收紧而不增加引擎请求数：runOppEval 开头有「指纹未变则直接 return」短路
    // （lastOppKey = 盘面 + 轮到走方 + 我方 best + 轮次），盘面静止时这层只是空转一次字符串比较，
    // 不产生任何引擎请求。周期变短只影响「盘面真的变了之后，多久跟上」。
    if (!oppEvalTimer) { oppEvalTimer = setInterval(runOppEval, 700); }
    runOppEval();
  }
  // 盘面刚变化时的「即刻触发」（不等下一个 tick）：
  // 我方/对手刚落完一子，主分析那边已经知道局面变了 → 立刻踢一次对手评估，
  // 使对手虚线圆与热力图在同一帧附近更新，彻底消除「慢半拍」的观感。
  // 用 120ms 防抖合并同一波落子的连续多帧变化（识别抖动会在一帧内连报几次）。
  var oppKickTimer = null;
  function kickOppEval() {
    if (!S.oppMoves || oppEvalBusy || haltForNewGame) return;
    if (oppKickTimer) return;                       // 已在防抖窗口内 → 合并，不重复排程
    oppKickTimer = setTimeout(function () {
      oppKickTimer = null;
      runOppEval();
    }, 120);
  }
  function stopOppEval() {
    if (oppEvalTimer) { clearInterval(oppEvalTimer); oppEvalTimer = null; }
    clearOppSvgLayer();
  }
  // ============ 渲染几何：热力层与对手层共用（避免两处重复的视口/缩放/坐标换算） ============
  // 返回 null 表示几何不可用（画布消失/矩形为零），调用方直接跳过绘制。
  // 抽出的目的：
  //   ① 去重——原先 drawOverlay / drawOppSvg 各自算一遍 r/scaleX/scaleY/cellPx/pt()，
  //      两边公式一旦不同步就会“热力图对齐、对手圈偏移”（历史错位问题的隐患）；
  //   ② 提速——一次算出全部几何，避免每帧重复 getBoundingClientRect() 链路（toTopRect 会走 iframe 逐级换算）。
  function overlayGeom(cal, cv) {
    var isScr = !!cal.isScreen;
    var r = isScr ? (cal.topRect || {}) : toTopRect(cv);
    if (!r || !r.width || !r.height) return null;
    var scaleX = isScr ? 1 : r.width / cv.width;
    var scaleY = isScr ? 1 : r.height / cv.height;
    var baseX = isScr ? cal.x0 : 0, baseY = isScr ? cal.y0 : 0;
    var x0 = cal.x0, y0 = cal.y0, stepX = cal.stepX, stepY = cal.stepY;
    return {
      isScr: isScr, r: r, scaleX: scaleX, scaleY: scaleY,
      cellPx: cal.cell * scaleX,
      // 交点 → 层内像素坐标（闭包捕获，避免每次调用重建对象）
      pt: function (i, j) {
        return {
          x: (x0 + i * stepX - baseX) * scaleX,
          y: (y0 + j * stepY - baseY) * scaleY
        };
      },
      // 几何指纹：仅当这些量变化时才有必要重建 SVG（否则原地复用节点）
      sig: x0.toFixed(2) + ',' + y0.toFixed(2) + ',' + stepX.toFixed(3) + ',' + stepY.toFixed(3) +
           ',' + r.width.toFixed(1) + ',' + r.height.toFixed(1) + ',' + r.left.toFixed(1) + ',' + r.top.toFixed(1)
    };
  }

  // 独立对手层绘制（zIndex=20 恒在热力层之上；白色衬底+加粗虚线；档1=最佳青色→档3）
  function drawOppSvg(cal, board, rings) {
    var cv = (cachedBoard && cachedBoard.cv) ? cachedBoard.cv : null;
    if (!cv && !cal.isScreen) return;
    if (!rings || !rings.length) {
      try { if (oppSvg && oppSvg.parentNode === overlay) overlay.removeChild(oppSvg); } catch (e) {}
      oppSvg = null; lastOppGeom = null; return;
    }
    cal = stableCalForRender(cal, cv);   // 同画布去抖：镜像帧不参与对手圈绘制
    var g = overlayGeom(cal, cv);
    if (!g) { try { if (oppSvg && oppSvg.parentNode === overlay) overlay.removeChild(oppSvg); } catch (e) {} oppSvg = null; lastOppGeom = null; return; }
    var svgNS = 'http://www.w3.org/2000/svg';
    // 几何未变且已有同层 SVG → 只重建 <circle> 子节点（DOM 结构复用，省掉整层 remove/add 引起的重排闪烁）
    var reuse = oppSvg && oppSvg.parentNode === overlay && lastOppGeom && lastOppGeom.sig === g.sig;
    var svg = reuse ? oppSvg : document.createElementNS(svgNS, 'svg');
    if (!reuse) {
      svg.id = '__gb_opp_svg';
      svg.setAttribute('width', g.r.width); svg.setAttribute('height', g.r.height);
      svg.style.position = 'absolute';
      svg.style.zIndex = '20';
      svg.style.pointerEvents = 'none';
    } else {
      while (svg.firstChild) svg.removeChild(svg.firstChild);   // 清空子节点，复用容器
    }
    overlay.style.left = g.r.left + 'px'; overlay.style.top = g.r.top + 'px';
    overlay.style.width = g.r.width + 'px'; overlay.style.height = g.r.height + 'px';
    var pt = g.pt, cellPx = g.cellPx;
    for (var i = 0; i < rings.length; i++) {
      var r0 = rings[i];
      if (board && board[r0.y] && board[r0.y][r0.x] !== 0) continue;   // 已占格不圈
      var pO = pt(r0.x, r0.y);
      var halo = document.createElementNS(svgNS, 'circle');
      halo.setAttribute('cx', pO.x); halo.setAttribute('cy', pO.y);
      halo.setAttribute('r', cellPx * 0.26);
      halo.setAttribute('fill', 'none');
      halo.setAttribute('stroke', '#ffffff');
      halo.setAttribute('stroke-width', String(Math.max(5, cellPx * 0.15)));
      halo.setAttribute('stroke-dasharray', String(Math.max(5, cellPx * 0.2)) + ',' + String(Math.max(3, cellPx * 0.12)));
      halo.setAttribute('opacity', '0.55');
      svg.appendChild(halo);
      var ring = document.createElementNS(svgNS, 'circle');
      ring.setAttribute('cx', pO.x); ring.setAttribute('cy', pO.y);
      ring.setAttribute('r', cellPx * 0.26);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', HEAT_COLORS[((r0.tier || 1) - 1) % HEAT_COLORS.length]);   // 1~3 档仿热力档位色
      ring.setAttribute('stroke-width', String(Math.max(4, cellPx * 0.11)));
      ring.setAttribute('stroke-dasharray', String(Math.max(5, cellPx * 0.2)) + ',' + String(Math.max(3, cellPx * 0.12)));
      ring.setAttribute('opacity', '1');
      svg.appendChild(ring);
    }
    if (svg.childNodes.length) {
      if (!reuse) overlay.appendChild(svg);
      oppSvg = svg;
      lastOppGeom = { x0: cal.x0, y0: cal.y0, stepX: cal.stepX, stepY: cal.stepY, sig: g.sig };
    } else if (!reuse) {
      oppSvg = null; lastOppGeom = null;
    }
  }
  // 独立后台评估（语义：虚线圆 =【对手视角下，对手下一步要下的位置】）：
  //   · 轮到走方=对手（我方已下完）→ 当前盘面就是对手在走 → 直接问引擎，候选即对手着法；
  //   · 轮到走方=我方（我方思考中）→ 先把「引擎推荐的我方着法」模拟落到盘上，盘面即变成
  //     对手在走 → 再问引擎，候选就是对手对我这步的应手（预测步数高我方一级）。
  //   两种情况最终都保证：请求盘面的【行棋方恒为对手】，因此候选天然是“对手要下的位置”。
  //   · 模拟所需 best 尚未算出（S.candCache 空）→ 本轮先按原盘问一次（作为近似），下轮有 best 自动精确；
  //   · 不清层只重建覆盖 → 圈持续显示不闪烁；盘面已有五连 → 清圈不再评估；
  //   · 指纹缓存：盘面与 best 均未变 → 直接复用上次结果（不重发请求不重画）→ 圈稳定不浮动。
  // 独立请求、独立层 #__gb_opp_svg（zIndex=20 恒在热力层上），不干扰热力图/主分析。
  // ============ 对手预测圈：位置的【纯函数】（本轮修复「圈乱出」的根因之二） ============
  // 用户原话：「我们先手的时候，应该下完最后一个棋子进行五子连珠，然后对手评估的圆圈
  //            3/4 的概率只出青色圈、1/4 的概率青色绿色同时出，这时你要做好科学的渲染了不要乱出」。
  // 旧实现的**圈的个数**取决于两个时序量，而不是局面本身：
  //   · best0 = S.candCache[0] 是否已算出来 → 决定 reqBoard 是"原盘"还是"我方落子后的盘"，
  //     两者的 needDefend 不同 → 圈数不同（1 个 / 2 个）；
  //   · needDefend.length===1 走"唯一必防点"分支（不过滤），≥2 走"候选前 2 名"分支（会过滤
  //     对手成五点）→ 两个分支的过滤规则不一致，同一局面可能落到不同分支给出不同结果。
  // 于是同一局面会因"引擎回包/定时器恰好落在哪一帧"而结果不同 → 概率性观感。
  // 现在改为：**圈 = 局面的纯函数**。入参只有 reqBoard / 双方颜色 / 引擎候选（仅作无战术点时的兜底），
  // 内部排序一律确定性（先战术必防点，再按分值→坐标），与缓存时点、轮询相位完全无关。
  function boardHasFive(b) { return maxLineLen(b, 1) >= 5 || maxLineLen(b, 2) >= 5; }

  function computeOppRings(reqBoard, myC, oppC, cands, rule) {
    // ---- 1) 终局：任一方已成五连 → 没有"对手要防的点"可预测 ----
    //   这里同时覆盖两种终局：
    //     · 盘面本来就有五连（对手已经赢了）；
    //     · 【本次反馈的核心】我方轮次时，上面把我们方 best 模拟落进 reqBoard 后**恰好连成五连**
    //       → 棋局在我方这一手就结束了，对手根本不存在"要下的位置" → 必须是 0 个圈。
    if (boardHasFive(reqBoard)) return [];
    // ---- 2) 战术必防点（纯盘面枚举，不看引擎）----
    //   · 我方"落一子即五连"的空格 → 对手必须去堵（用户此前明确要求：「冲4就只有一个必防位」）；
    //   · 对手"落一子即五连"的空格 → 对手当然会下这里。
    //   两者并集去重、确定性排序（y 优先、x 次之）→ 与引擎候选顺序无关。
    //   闭四 → 恰好 1 个点（1 个青色圈）；活四 → 2 个点（青 + 绿）。这是棋理上唯一正确的答案。
    var renjuB = (rule === 2);
    var pts = [];
    function collect(color, out) {
      var five = allImmediateFiveCells(reqBoard, color, renjuB && color === 1);
      for (var q = 0; q < five.length; q++) {
        var p = five[q], dup = false;
        for (var z = 0; z < out.length; z++) if (out[z].x === p.i && out[z].y === p.j) { dup = true; break; }
        if (!dup) out.push({ x: p.i, y: p.j });
      }
    }
    collect(myC, pts);
    collect(oppC, pts);
    if (pts.length) {
      pts.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
      return pts.slice(0, 2).map(function (p, k) { return { x: p.x, y: p.y, tier: k + 1 }; });
    }
    // ---- 3) 无战术必防点（常规中盘）→ 用引擎候选兜底：第 1 名青色、第 2 名绿色 ----
    //   先按候选分值降序、再按坐标升序排定 → 同一局面无论引擎回包顺序如何，都取到同样两个点。
    //   注：走到这里说明盘面上双方都没有"一步成五"的空格，因此引擎候选里也不可能存在终局点，
    //       旧代码那条 "对手落此即五连就跳过" 的过滤在此自然被覆盖，无需再单独判断。
    var list = [];
    for (var i = 0; i < (cands || []).length; i++) {
      var c = cands[i];
      if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') continue;
      if (c.x < 0 || c.x >= N || c.y < 0 || c.y >= N) continue;
      if (reqBoard[c.y] && reqBoard[c.y][c.x] !== 0) continue;      // 已占格（含我方模拟落点）不画
      list.push({ x: c.x, y: c.y, s: candScoreOf(c, true) });       // true = 行棋方(对手)视角，分值越高越可能下
    }
    list.sort(function (a, b) { return (b.s - a.s) || (a.y - b.y) || (a.x - b.x); });
    return list.slice(0, 2).map(function (p, k) { return { x: p.x, y: p.y, tier: k + 1 }; });
  }

  async function runOppEval() {
    if (!S.oppMoves || oppEvalBusy || haltForNewGame) return;
    if (!lastGoodBoard || !lastGoodCal) return;
    var board = lastGoodBoard;
    var n0 = countStones(board);
    if (n0 < 2) return;
    // 终局（盘面已有五连，引擎可能未报 M1）→ 清圈不再评估
    if (maxLineLen(board, 1) >= 5 || maxLineLen(board, 2) >= 5) { clearOppSvgLayer(); return; }
    // 我方/对手颜色：统一走唯一事实来源（未判定时返回 0 → 下方 _reqStm===_oppC 守卫会拦住不画圈）
    var _myC = myColorCode();
    var _oppC = oppColorCode();
    if (_myC === 0 || _oppC === 0) { clearOppSvgLayer(); return; }   // 颜色未定 → 宁可不画，也不画错
    var _stm = sideToMoveColor(board);
    var best0 = (S.candCache && S.candCache[0] && S.candCache[0].x >= 0 && S.candCache[0].y >= 0 && S.candCache[0].x < N && S.candCache[0].y < N) ? S.candCache[0] : null;
    var myTurn = (_stm === _myC);   // 当前轮到我方 → 需先模拟我方落子，才能看到对手应手
    // 指纹：盘面 + 轮到走方 + 我方 best + 轮次 → 全相同则不重算（防浮动、提速）
    var key = fingerprint(board) + '|' + _stm + '|' + (best0 ? (best0.x + ',' + best0.y) : 'nobest') + '|' + (myTurn ? 'own' : 'opp');
    if (key === lastOppKey && lastOppRings && lastOppRings.length) return;   // 没变化 → 圈保持原样不浮动
    oppEvalBusy = true;
    try {
      var cal = lastGoodCal;
      // 构造「行棋方=对手」的请求盘面 reqBoard：
      //   · 我方轮次 → 把我方 best 落到原盘 → 盘面转为对手走棋（best 未出时先按原盘近似）；
      //   · 对手轮次 → 原盘即对手走棋，直接原样发给引擎（不再互换盘——互换会翻转行棋方，
      //     导致候选变成“我方视角的着法”，正是用户反馈的“把我们要下的位置当成对手位置”）。
      var reqBoard, myMove = null;
      if (myTurn) {
        if (best0) {
          reqBoard = board.map(function (r) { return r.slice(); });
          if (reqBoard[best0.y][best0.x] === 0) { reqBoard[best0.y][best0.x] = _myC; myMove = { x: best0.x, y: best0.y }; }
        } else {
          reqBoard = board.map(function (r) { return r.slice(); });   // best 未出：原盘直问，下一轮有 best 自动精确
        }
      } else {
        reqBoard = board;     // 对手轮次：原盘行棋方就是对手，候选即对手着法
      }
      var ctrl = new AbortController();
      var to = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 7000);
      var r = await tryLocal(LOCAL_HOSTS, '/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: reqBoard, rule: S.rule, matchMs: S.matchMs, turnMs: 700, timeUsedMs: S.timeUsedGame || 0, topN: 3, cid: CLIENT_ID + '-opp', lane: 'sub' }),
        signal: ctrl.signal
      });
      clearTimeout(to);
      var d = await r.json();
      // ★【竞态闸 · 本轮修复】await 期间局面可能已经终局 —— 最典型的就是【我方刚落下五连制胜手】。
      //   那一刻 analyze() 的五连闸已 haltForNewGame=true 并清过层，但本函数是「飞行中」的旧实例，
      //   拿到的 d 是【上一帧局面】的结果；若继续往下跑，会把旧圈重新画到已经终局的盘面上。
      //   所以回包后必须重判一次：已终局 → 丢弃本次结果、绝不重画（保持 0 圈）。
      if (haltForNewGame) return;
      if (boardHasFive(lastGoodBoard || board)) { clearOppSvgLayer(); return; }
      if (!d || d.error || !d.candidates || !d.candidates.length) return;
      // 防御性校验：reqBoard 的行棋方必须是对手。颜色未判定/读数抖动导致失配时宁可不画，
      // 也不要把「我方要下的位置」错画成对手位置（用户明确指出的混淆点）。
      var _reqStm = sideToMoveColor(reqBoard);
      // 【★ 唯一决定圈数的地方：局面的纯函数（见 computeOppRings）★】
      //   终局 → 0 个；有冲四/活四 → 必防点（闭四 1 个青圈 / 活四 2 个青+绿）；
      //   常规中盘 → 引擎候选前 2 名（确定性排序）。
      //   与 S.candCache 是否已算出、定时器相位、引擎回包顺序【完全无关】。
      var rings = (_reqStm === _oppC) ? computeOppRings(reqBoard, _myC, _oppC, d.candidates, S.rule) : [];
      if (!rings.length) {
        // ★ 必须显式作废：旧代码这里是「什么都不做」，于是 lastOppRings 的旧值残留，
        //   会被 drawOverlay 末尾的「同帧重投影」复活 —— 正是用户看到的「圈乱出」。
        clearOppSvgLayer();
        return;
      }
      lastOppKey = key; lastOppRings = rings;
      drawOppSvg(cal, board, rings);   // 重建覆盖，不清层 → 不闪烁
    } catch (e) {}
    finally { oppEvalBusy = false; }
  }

  // 清空评估层（对手圈独立层 #__gb_opp_svg 保留——跟手性：不闪烁，几何变化时重投影）：
  // 我方刚落子/等待对手时只删热力层；对手圈由独立后台任务 runOppEval 持续重建覆盖。
  function clearOverlayKeepOpp(cal, cv, board) {
    var oldHeat = overlay.querySelector('#__gb_heat_svg');
    if (oldHeat) { try { overlay.removeChild(oldHeat); } catch (e) {} }
    // ★ 终局闸（同 drawOverlay）：任一方五连后不再重投影对手圈（见 drawOverlay 内注释）。
    if (S.oppMoves && oppSvg && cal && cv && lastOppRings && lastOppRings.length && !boardHasFive(board)) {
      var gOk = lastOppGeom && Math.abs(lastOppGeom.x0 - cal.x0) < 0.5 && Math.abs(lastOppGeom.y0 - cal.y0) < 0.5 &&
                Math.abs(lastOppGeom.stepX - cal.stepX) < 0.1 && Math.abs(lastOppGeom.stepY - cal.stepY) < 0.1;
      if (!gOk) drawOppSvg(cal, board, lastOppRings);   // 几何变化 → 按当前几何重投影对手层（不清除，避免闪烁）
    }
  }

  // ---------- 评估曲线（我方视角：0 轴居中，正=优势(蓝)，负=劣势(黄)；Catmull-Rom 平滑） ----------
  //
  // 【X 轴：动态铺满 → 超过阈值后向后延伸】（用户明确指定的语义，对齐 gomocalc 动态曲线）
  //   · 点数 ≤ CHART_FIT(15)：把已有各点【均匀铺满整个可视宽度】。
  //       开局只有 3 个子，也是一条占满整幅视图的曲线（不是缩在左边一小段）。
  //   · 点数 > 15：点距锁定为「15 点刚好铺满」时的像素宽，画布继续向右变宽
  //       → #__gb_chart_scroll 出现横向滚动条，曲线像 gomocalc 一样向后延伸。
  //   ★ CHART_FIT 由 30 改为 15（用户 2026-09-15 明确要求：「曲线图满 15 个坐标点向后延伸」）：
  //     15 手是一局五子棋的典型中盘规模，用 15 作阈值能让开局~中盘的曲线铺满得更饱满、
  //     读图分辨率更高；过了 15 手才出现横向滚动条向后延伸。
  //   更早的实现用「固定 11px/手 + MIN_PLIES=18 靠左生长」——开局只画左侧一小截，已被用户否决。
  //
  // 【每一子都有映射】S.history 每个元素 = 一手棋（按真实手数去重，见 renderResult 入点逻辑），
  //   所以第 k 个点就对应第 k 手棋：曲线上的点、评估栏的数值、盘上的子是严格一一对应的。
  //
  // 【Y 轴】-1000..1000，0 居中；±1000 / ±500 实线，250 步进虚线。
  var CHART_FIT = 15;              // 可视区内「铺满」容纳的最大点数（超过则画布向右延伸 + 滚动条）
  function drawChart() {
    var cv = document.getElementById('__gb_chart');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var H = 100;
    var padL = 4, padR = 4, padT = 5, padB = 8;
    var csc = document.getElementById('__gb_chart_scroll');
    var viewW = (csc && csc.clientWidth) ? csc.clientWidth : 0;
    if (viewW < 80) viewW = 195;                 // 面板隐藏 / 尚未布局时的兜底可视宽度
    var pts = S.history;                         // [{i: 真实手数, v: 我方视角分值}]
    var n = pts.length;
    var innerW0 = viewW - padL - padR;           // 可视区内宽
    // 点距：≤30 点 → 铺满整宽；>30 点 → 锁定为「30 点铺满」时的点距，画布向右延伸
    var denom = (n <= CHART_FIT) ? Math.max(1, n - 1) : (CHART_FIT - 1);
    var step = innerW0 / denom;
    var contentW = padL + padR + (n > 1 ? (n - 1) * step : 0);
    var W = Math.max(Math.round(viewW), Math.round(contentW));
    cv.width = W; cv.height = H;
    ctx.clearRect(0, 0, W, H);
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var midY = padT + innerH / 2;
    var labelCol = S.dark ? '#7d8390' : '#9aa3ad';
    // 评估值域 -1000..1000，0 居中（对齐五子棋计算器）。250 为进位虚线；±1000/±500 为强线。
    var RANGE = 1000;
    var yOf = function (v) { return midY - (v / RANGE) * innerH / 2; };
    // 标线：-1000,-750,...,0,...,750,1000
    ctx.lineWidth = 1;
    for (var g = -1000; g <= 1000; g += 250) {
      var gy = yOf(g);
      if (g === 0) { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.28)' : '#c2c8d0'; ctx.setLineDash([]); }
      else if (Math.abs(g) === 1000) { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.22)' : '#d8dde4'; ctx.setLineDash([]); }
      else if (Math.abs(g) === 500) { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.14)' : '#e8eaee'; ctx.setLineDash([]); }
      else { ctx.strokeStyle = S.dark ? 'rgba(255,255,255,.10)' : '#eef0f3'; ctx.setLineDash([3, 3]); }
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
    }
    ctx.setLineDash([]);
    // 左侧固定纵轴刻度：-1000..1000（250 步进，500 为粗刻度），0 一条
    var ya = document.getElementById('__gb_yaxis');
    if (ya) {
      ya.innerHTML = '';
      for (var g2 = -1000; g2 <= 1000; g2 += 250) {
        var gy2 = yOf(g2);
        var sp = document.createElement('span');
        sp.textContent = (g2 > 0 ? '+' : '') + g2;
        sp.style.cssText = 'position:absolute;right:2px;font-size:' + (g2 % 500 === 0 ? 8 : 7) + 'px;color:' + labelCol + ';line-height:1px;transform:translateY(-50%);' + (g2 % 500 !== 0 && g2 !== 0 ? 'opacity:.5;' : '');
        sp.style.top = gy2 + 'px';
        ya.appendChild(sp);
      }
    }

    if (n < 1) {
      ctx.fillStyle = S.dark ? '#8a90a0' : '#9aa5b1'; ctx.font = '10px sans-serif';
      ctx.fillText(T('curve'), padL + 6, midY + 3);
      return;
    }
    // X 轴：第 k 个点（第 k 手棋）的位置。1 个点时居中，≥2 个点时按动态点距均匀铺开。
    var px = function (k) { return (n <= 1) ? (padL + innerW0 / 2) : (padL + k * step); };
    var curV = Math.max(-1000, Math.min(1000, pts[n - 1].v));
    var py = yOf;
    // 评估值 <0 → 临近失败（黄）；≥0 → 临近成功（蓝）
    var lineColor = curV < 0 ? '#f1c40f' : '#3b7dd8';
    var fillColor = curV < 0 ? 'rgba(241,196,15,.22)' : 'rgba(59,125,216,.14)';
    // Catmull-Rom → 三次贝塞尔（X 用点序 k，Y 用分值）
    function tracePath() {
      ctx.beginPath();
      ctx.moveTo(px(0), py(pts[0].v));
      if (n === 2) { ctx.lineTo(px(1), py(pts[1].v)); return; }
      if (n < 3) return;
      for (var i = 0; i < n - 1; i++) {
        var p0 = pts[Math.max(0, i - 1)].v, p1 = pts[i].v, p2 = pts[i + 1].v, p3 = pts[Math.min(n - 1, i + 2)].v;
        var x1 = px(i), y1 = py(p1), x2 = px(i + 1), y2 = py(p2);
        var c1x = x1 + (px(Math.min(n - 1, i + 1)) - px(Math.max(0, i - 1))) / 6;
        var c1y = y1 + (py(p2) - py(p0)) / 6;
        var c2x = x2 - (px(Math.min(n - 1, i + 2)) - px(i)) / 6;
        var c2y = y2 - (py(p3) - py(p1)) / 6;
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2);
      }
    }
    tracePath();
    if (n >= 2) { ctx.lineTo(px(n - 1), py(0)); ctx.lineTo(px(0), py(0)); ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill(); }
    tracePath();
    if (n >= 2) { ctx.strokeStyle = lineColor; ctx.lineWidth = 1.8; ctx.stroke(); }
    ctx.fillStyle = lineColor;
    for (var i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(px(i), py(pts[i].v), 2.6, 0, 7); ctx.fill(); }
    // 曲线横滚条自动跟随到最新点（超过 30 点后画布变宽时才真正生效）
    if (csc) csc.scrollLeft = csc.scrollWidth;
  }

  var statusEl = document.getElementById('__gb_status');
  function setStatus(html) {
    // 复制成功提示期间（约3.5秒），普通轮询状态不覆盖它；错误色仍可覆盖
    if (window.__gbCopyUntil && Date.now() < window.__gbCopyUntil && html.indexOf('#c0392b') < 0) return;
    statusEl.innerHTML = html;
  }

  // ---------- 数据面板渲染（对齐 gomocalc：深度/评估/速度/节点/用时 + 路线 + 局面代码） ----------
  function fmtKMG(v) {
    v = Number(v) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }
  function coordLower(i, j) { return String.fromCharCode(97 + i) + (N - j); }
  // 【评估栏显示：我方视角的 eval 串】
  // 用户明确要求「评估值和评估曲线都是我们执子的评估」→ 显示前必须经 evalToMine 翻到我方视角。
  // 只翻符号、不动量级：绝不做 M↔分值 的双向换算 —— 「还有 17 步成杀」不能被显示成 "+638 分"。
  // 引擎给 +M17 且轮我方走 → 显示 +M17；轮对手走 → 显示 -M17（对手 17 步杀我）。
  function rawEvalText() {
    var s = S.myEval;
    if (typeof s === 'string' && s.length) return s.trim();
    s = S.rawEval;                                  // 兜底：归一值缺失时退回原始串
    if (typeof s === 'string' && s.length) return s.trim();
    return '-';
  }
  function setStatPanel(c0, elapsed) {
    function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
    set('__gb_st_depth', c0.depth ? c0.depth : '-');
    // 评估值：我方视角的 eval 串（+M17 / +350 / -1200 …）。
    var ev = rawEvalText();
    set('__gb_st_eval', ev);
    set('__gb_st_speed', c0.speed ? fmtKMG(c0.speed) : '-');
    set('__gb_st_nodes', c0.nodes ? fmtKMG(c0.nodes) : '-');
    var coords = '';
    var lineEl = document.getElementById('__gb_st_line');
    if (lineEl) {
      if (c0.line && c0.line.length) {
        coords = c0.line.slice(0, 14).map(function (p) { return String.fromCharCode(65 + p[0]) + (N - p[1]); }).join(' ');
        lineEl.textContent = (S.lang === 'en' ? 'PV ' : '路线 ') + coords;
      } else lineEl.textContent = '';
    }
    // 持久化：刷新后回填（localStorage 优先，失败用 window.name 兜底）
    var snap = JSON.stringify({
      depth: c0.depth || '-', eval: ev, speed: c0.speed ? fmtKMG(c0.speed) : '-',
      nodes: c0.nodes ? fmtKMG(c0.nodes) : '-', coords: coords
    });
    try { localStorage.setItem('gb_lastStat', snap); } catch (e) {}
    try { window.name = '__gb_lastStat=' + snap; } catch (e) {}
  }
  function fillStatFromCache() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem('gb_lastStat') || 'null'); } catch (e) {}
    if (!data && window.name && window.name.indexOf('__gb_lastStat=') === 0) {
      try { data = JSON.parse(window.name.slice('__gb_lastStat='.length)); } catch (e) {}
    }
    if (!data) return;
    function set(id, v) { var el = document.getElementById(id); if (el && v) el.textContent = v; }
    set('__gb_st_depth', data.depth); set('__gb_st_eval', data.eval);
    set('__gb_st_speed', data.speed); set('__gb_st_nodes', data.nodes);
    var lineEl = document.getElementById('__gb_st_line');
    if (lineEl && data.coords) lineEl.textContent = (S.lang === 'en' ? 'PV ' : '路线 ') + data.coords;
  }
  function setStatPanelThinking() {
    // 思考中：不清空已有数据，保持显示最近一次真实评估（避免面板大部分时间空着/闪烁成 …）。
    if (!S.lastStat) {
      function stSet(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
      stSet('__gb_st_depth', '…'); stSet('__gb_st_eval', '…');
      stSet('__gb_st_speed', '…'); stSet('__gb_st_nodes', '…');
    }
  }
  function refreshStatLang() {
    if (S.lastStat) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
  }

  // 设置/规则/时间变更后：释放分析锁、清缓存，立即按新设置重新分析
function kickAnalyze() {
    // 设置/规则/时间变更 → 失效分析缓存，下一次轮询立即按新设置分析
    lastEngineFp = null; lastEngineAt = 0;
    cachedBoard = null; pyBoardCache = null;
    lastBoard = null; lastCount = 0;
    scheduleNext();
  }

  // ---------- 热力图/对手评估的候选补充搜索 ----------
  // 主分析（topN=1 全力）只产出 1 条候选；热力图 4 级渐变与对手虚线圆需要 8 条 PV 候选。
  // 若把主分析直接改成 topN=8，多 PV 会分摊搜索算力、压浅主线深度 → 棋力下降。
  // 因此这里在主分析完成后再发一次【短预算 topN=8】的补充搜索：
  //   · 落子/评估/曲线/自动落子仍以主分析（深搜索）结果为准；
  //   · 补充搜索仅用于刷新热力图与对手落点候选显示（同批并行、同时出现）；
  //   · 对手落点评估与热力图同批返回，但画在独立 SVG 层——保留到对手再次落子。
  async function refreshOverlayCands(cal, cv, board, fp, bestMain, mainC0) {
    if (overlayRefreshBusy) return;
    overlayRefreshBusy = true;
    // 自动模式预算 2000ms：1200ms 太短——引擎在必胜/快结束局面 NUMPV=1 只出 1 条候选
    // （热力图只剩“最佳”档、对手圈无数据）；且预算越足多 PV 流越完整。纯显示用，异步不阻塞落子。
    var refreshMs = S.autoPlay ? 2000 : Math.max(1200, Math.min(4000, Math.round(((deepMode ? DEEP_MS : S.turnMs) || 5000) * 0.5)));
    try {
      var ctrl = new AbortController();
      var to = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, refreshMs + 6000);
      // 补充搜索(topN=8)：热力图与对手落点评估共用同一批数据（零额外请求 → 对手圈必显示）——
      // 对手评估 = “对方执子视角”（与我方热力图相反）：
      //   · 轮到走方=对手 → 补充搜索候选即对手视角要点（直接取前 3，档位=候选排序）；
      //   · 轮到走方=我方 → 引擎候选是我方着法 → 取主分析深搜 PV 线的对手应手（交替线对手色步）。
      // 数据全部来自同批响应，不存在“对手请求失败/串行超时→圈不显示”的路径。
      var rP = tryLocal(LOCAL_HOSTS, '/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: board, rule: S.rule, matchMs: S.matchMs, turnMs: refreshMs, timeUsedMs: S.timeUsedGame || 0, topN: 8, cid: CLIENT_ID, lane: 'sub' }),
        signal: ctrl.signal
      });
      var bn0 = 0, wn0 = 0;
      for (var by2 = 0; by2 < board.length; by2++) for (var bx2 = 0; bx2 < board[by2].length; bx2++) { if (board[by2][bx2] === 1) bn0++; else if (board[by2][bx2] === 2) wn0++; }
      // 我方颜色判定：统一走唯一事实来源（手动指定优先；自动模式用 userSide；未定默认黑先）
      var myBlack0 = (mySideMask() !== 1);   // -1(未定)/0(黑) → 视作黑先惯例
      var data = await rP.json();
      clearTimeout(to);
      if (!data || data.error || !data.candidates || !data.candidates.length) return;
      // 补充搜索期间局面已变（对手已落子 / 新一轮分析已开始）→ 丢弃，主循环会按新局面重绘
      if (fp !== lastEngineFp) return;
      // ---- 【热力图多色稳定性（本轮）】候选过少时自动补搜一次 ----
      // 引擎在简单局面 / 必胜局面下有效 PV 数（NUMPV）会退化到 1~3 条 → 热力图只剩 1~2 档颜色。
      // 这里若候选 < 4，就用「更长预算」在同一 sub 通道补搜一次（不动主通道、不影响落子），
      // 尽量凑齐 4 档颜色；补搜失败或仍不足则沿用原结果（绝不丢弃已有候选）。
      if (data.candidates.length < 4 && !haltForNewGame) {
        try {
          var ctrl2 = new AbortController();
          var to2 = setTimeout(function () { try { ctrl2.abort(); } catch (e) {} }, refreshMs + 8000);
          var rQ = tryLocal(LOCAL_HOSTS, '/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ board: board, rule: S.rule, matchMs: S.matchMs, turnMs: Math.min(6000, refreshMs + 1500), timeUsedMs: S.timeUsedGame || 0, topN: 8, cid: CLIENT_ID, lane: 'sub' }),
            signal: ctrl2.signal
          });
          var d2 = await rQ.json();
          clearTimeout(to2);
          if (fp === lastEngineFp && d2 && !d2.error && d2.candidates && d2.candidates.length > data.candidates.length) data = d2;
        } catch (e) {}
      }
      var cands = data.candidates.slice(0, 8);
      // 首候选对齐主分析终选（深搜索为准），并保留主分析的评估/深度/速度/节点/变化行，避免状态栏数字回退
      // bestMain 偶发缺失/非法时回退到 mainC0（主分析候选[0]）的坐标，保证“最佳”恒与主分析推荐同格
      if ((!bestMain || bestMain.length !== 2) && mainC0 && mainC0.x >= 0) bestMain = [mainC0.x, mainC0.y];
      // 【不插入虚构候选】bestMain 不在候选列表时，旧实现用 winrate:0.5 造一条假候选插到首位。
      // 这条假候选的 score 恒为 0（(0.5-0.5)*2000），会污染候选分数序列：
      //   · 它顶掉了真实的次强点，热力图少一个真实颜色；
      //   · 若真实候选都很强（如 +500 一片），凭空出现的 0 分格被分到粉红档 → “好局面却有个粉色点”；
      //   · 且它带 mainC0 的 eval 文本，candScoreOf 会据此算出真实分，与 winrate 兜底打架，排序错乱。
      // 现改为：只在候选里做真实重排（命中则提到首位）；未命中时不动列表——
      // 热力图与对手圈都只反映引擎真实给出的候选，best0 对齐靠 drawOverlay 的描边逻辑完成。
      if (bestMain && bestMain.length === 2) {
        var fIdx = -1;
        for (var k = 0; k < cands.length; k++) if (cands[k].x === bestMain[0] && cands[k].y === bestMain[1]) { fIdx = k; break; }
        if (fIdx > 0) cands.unshift(cands.splice(fIdx, 1)[0]);
      }
      if (mainC0 && cands.length) {
        // 主分析（深搜）评估更权威，覆盖到与之同格的那条候选上；不同格则不覆盖，
        // 否则首条候选的 eval 会与自身坐标不符 → 颜色档位判断错位。
        var sameAsMain = (cands[0].x === mainC0.x && cands[0].y === mainC0.y);
        if (sameAsMain) {
          cands[0].eval = mainC0.eval || cands[0].eval;
          cands[0].depth = mainC0.depth || cands[0].depth;
          cands[0].speed = mainC0.speed || cands[0].speed;
          cands[0].nodes = mainC0.nodes || cands[0].nodes;
          if (mainC0.line && mainC0.line.length) cands[0].line = mainC0.line;
        }
      }
      S.candCache = cands;
      // 对手落点评估已移至独立后台任务（runOppEval）——不再塞进热力链路：
      // 历史教训：在 refreshOverlayCands 内串联互换盘请求会拉长总时长 → 超时 abort → 整个
      // refreshOverlayCands 失败 → 热力图颜色缺失 + 对手圈不显示（用户多次反馈）。
      // 现在热力图/对手圈各自独立请求、独立绘制层，互不干扰。
      if (cal && cv) {
        // 该批候选来自【原盘】分析，其 eval 是“原盘行棋方”视角。热力图要把颜色统一成
        // 我方视角，必须告诉 drawOverlay 当前行棋方是不是我方（否则轮到对手那帧全部反号）。
        var myColorHere = myBlack0 ? 1 : 2;
        var isMyMoveNow = (sideToMoveColor(board) === myColorHere);
        drawOverlay(cal, cv, cands, bestMain, board, isMyMoveNow);
      }
    } catch (e) {}
    finally {
      overlayRefreshBusy = false;
    }
  }

  // ---------- 分析 ----------
async function analyze() {
    // =====================================================================
    //  重建的先后手识别 + 自动落子状态机
    //  核心思路：
    //   1) 先后手不再靠“猜子数”，而是“观察谁刚落子”：
    //      - 我方刚落子被确认 → 该子颜色即我执
    //      - 出现一颗非我方落下的新子 → 那是对方 → 反推我执
    //   2) 落子后进入“待确认”状态，目标格出现我方子才算成功；
    //      超时自动重试，连试失败才暂停（不再盲目续点）。
    //   3) 空盘开局：等到对手先下则我是白；等不到（2.5s）则我执黑先手。
    //   4) 那个“fp===lastFp 就永久不分析”的卡死口已移除——
    //      无论何种状态它都会持续轮询，随时能被新局面唤醒。
    // =====================================================================
    if (S.analyzing) return;
    S.analyzing = true;
    try {
      // ---- 先后手不变式看门狗：每轮扫描前强制「手动锁定」优先于「自动推断」 ----
      // 任何路径（差分识别、网络监听、探测块、一致性校验）只要试图在手动锁定状态下
      // 改写 userSide，都会在这里被立刻清掉，杜绝「用户点了白、系统偷偷按黑评估」。
      if (sideIsManual()) { if (S.userSide !== -1) S.userSide = -1; }
      else if (S.userSide !== 0 && S.userSide !== 1) S.userSide = -1;

      var found = await pyFindBoard();
      if (!found) found = findBoard();
      if (!found) {
        if (lastBoardFail === 'canvas-calib') setStatus('<span style="color:#e67e22;">' + SF('fail') + '</span>');
        else setStatus(T('no_board'));
        return;
      }
      var cv = found.cv, cal = found.cal;
      var board = found.board || readBoard(cal, cv);
      var n = countStones(board);
      var acc = found.board ? 1 : (n > 0 ? verifyBoard(cal, cv, board) : 0);

      // ===================== 几何稳定性看门狗（防热点/落子位置纵向坐标反转） =====================
      // 现象：检测器（py/JS/截屏）对同一棋盘绝大多数时候顶行锚定，但偶发会以棋盘另一侧
      // （底行/右列）为锚重定位，使新几何与上一轮可用几何互为镜像（y0/x0 偏移≈±14 格、格距相同），
      // 渲染出的热点分析、推荐落点、对手预测圈随之整体上下/左右镜像错位——“纵向坐标频繁反转”。
      // 处置：判定为误翻转时，沿用上一轮可用几何重读棋盘，并同步修正各缓存中的几何，
      // 确保镜像几何永远不进入渲染链路；棋盘被合法移动（滚动/缩放）时新几何与参照相差
      // 任意非镜像距离，不会被误伤，下一轮通过置信度门槛后参照自然更新。
      if (lastGoodCal && found.cal && Date.now() - lastMirrorFixAt > 150) {   // 冷却 150ms（原 800ms）：连续镜像时快速纠偏，几乎不闪
        var _lg = lastGoodCal;
        var _stepOk = _lg.stepY > 0 && cal.stepY > 0 && Math.abs(cal.stepY - _lg.stepY) / _lg.stepY < 0.20;   // 容差放宽：镜像帧 stepY 偶有噪声，过严会漏判 → 镜像进入渲染链路 → 标记纵轴跳跃
        var _yMirr = _stepOk && (Math.abs((_lg.y0 + 14 * _lg.stepY) - cal.y0) < cal.stepY * 0.45 ||
                                 Math.abs((_lg.y0 - 14 * _lg.stepY) - cal.y0) < cal.stepY * 0.45);
        var _xMirr = _stepOk && (Math.abs((_lg.x0 + 14 * _lg.stepX) - cal.x0) < cal.stepX * 0.45 ||
                                 Math.abs((_lg.x0 - 14 * _lg.stepX) - cal.x0) < cal.stepX * 0.45);
        if (_yMirr || _xMirr) {
          diag('geometry mirror vs last good cal -> revert geometry and re-read');
          lastMirrorFixAt = Date.now();   // 冷却：800ms 内不再重复纠偏重读（连续镜像时稳定在参照几何，不来回闪动）
          cal = _lg;
          board = readBoard(cal, cv);
          n = countStones(board);
          acc = n > 0 ? verifyBoard(cal, cv, board) : 0;
          if (pyBoardCache) pyBoardCache.cal = cal;
          if (cachedBoard) { cachedBoard.cal = cal; cachedBoard.board = board; }
          drawCalibFrame(cal, cv);   // 校准框同步回到正确几何，避免界面残留镜像网格
        }
      }
      // 帧间棋盘镜像校验（比几何判据更可靠，双保险，无冷却每次执行）：本帧与上一帧有效棋盘匹配率骤降、
      // 但垂直翻转后匹配率回升 → 识别层偶发上下镜像（Python 锚定翻转）→ 回退参照几何重读。
      // 阈值放宽（0.7/0.75）：正常对局相邻帧只差≤1子（匹配率≈≥0.93），放宽不会误伤，但能捕获
      // 更多镜像帧（连续镜像时上一帧已是镜像、几何看门狗又受冷却限制 → 这是最后防线）
      if (lastGoodBoard && lastGoodCal && n >= 2 && countStones(board) >= 2) {
        var _mrB = boardMatchRate(lastGoodBoard, board);
        var _fbB = flipBoardV(board);
        var _frB = boardMatchRate(lastGoodBoard, _fbB);
        if (_mrB < 0.7 && _frB > 0.75) {
          diag('board vertical mirror (match ' + _mrB.toFixed(2) + ' vs flipped ' + _frB.toFixed(2) + ') -> revert & re-read');
          lastMirrorFixAt = Date.now();
          cal = lastGoodCal;
          board = readBoard(cal, cv);
          n = countStones(board);
          acc = n > 0 ? verifyBoard(cal, cv, board) : 0;
          if (pyBoardCache) pyBoardCache.cal = cal;
          if (cachedBoard) { cachedBoard.cal = cal; cachedBoard.board = board; }
          drawCalibFrame(cal, cv);
        }
      }

      // 网格自动纠偏（与原逻辑一致）：半格/一格内取置信度最高对齐
      var needFix = (!found.board && n === 0 && roughStoneCheck(cal, cv)) || (n > 0 && acc > 0 && acc < 0.75);
      if (needFix) {
        var offs = [0, 0.5, -0.5, 1, -1], bestCal = null, bestAcc = acc, bestBoard = null;
        for (var oi = 0; oi < offs.length; oi++) for (var oj = 0; oj < offs.length; oj++) {
          if (oi === 0 && oj === 0) continue;
          var tc = { x0: cal.x0 + offs[oi] * cal.stepX, y0: cal.y0 + offs[oj] * cal.stepY, stepX: cal.stepX, stepY: cal.stepY, cell: cal.cell, bg: cal.bg, docRect: cal.docRect, topRect: cal.topRect, frameWin: cal.frameWin, isScreen: cal.isScreen, mode: cal.mode };
          var tb = readBoard(tc, cv);
          if (countStones(tb) <= 0) continue;
          var ta;
          if (n === 0) {
            // 空盘但有棋子可见 → 原几何完全错位：只要偏移后能读到子且自洽，就是更优对齐
            ta = 0.5 + 0.5 * verifyBoard(tc, cv, tb);
          } else {
            // 有子但读子噪声大：旧实现用 verifyBoard(偏移后, 偏移后读数) 自比，任何偏移自洽度都≈1，
            // 会在 ±1 行间随机换锚，表现为热点/落子位置整行跳变（用户反馈“坐标频繁反转”）。
            // 修正：与【原始读盘】逐格比对，且仅当子数足以分辨真实对齐、显著超过原始对齐时才换锚。
            if (n < 12) continue;
            ta = boardMatchRate(tb, board);
          }
          if (ta > bestAcc) { bestAcc = ta; bestCal = tc; bestBoard = tb; }
        }
        if (bestCal && (n === 0 ? bestAcc > 0.6 : (bestAcc > 0.9 && bestAcc > acc + 0.05))) {
          cal = bestCal; board = bestBoard; n = countStones(board); if (cachedBoard) cachedBoard.cal = cal; drawCalibFrame(cal, cv); acc = bestAcc; setStatus(SF('corrected', '{c}', Math.round(acc * 100))); }
      }

      // 指纹必须把「我执颜色」算进去：局面相同但用户切换了黑/白，也必须视为「变了」，
      // 否则会拿旧颜色的评估结果显示在新颜色下 —— 即用户反馈的“选了白却评估到黑上”。
      // 形式：棋盘落子串 + "#" + 我方颜色码(1黑/2白/0未定) + 轮次(1/2)
      // ★ 顺序坑（本轮修复）：旧代码把本行写在 `var toMoveIsBlack = ...` **之前**，
      //   而 `var` 会提升 → 此处 toMoveIsBlack 恒为 undefined → 指纹末尾恒为 '2'，
      //   轮次这一维实际上从未生效。轮次必须由 bCnt/wCnt 现算（两者之间的子数关系是纯函数），
      //   不能依赖尚未赋值的变量。
      var fpB = 0, fpW = 0;
      for (var fj = 0; fj < N; fj++) for (var fi = 0; fi < N; fi++) { if (board[fj][fi] === 1) fpB++; else if (board[fj][fi] === 2) fpW++; }
      // 指纹末维的轮次同样走【开局行棋方权威】：空盘必须算「黑先」，
      // 否则空盘指纹记为「轮白」，与下方 stmColor 不一致 → 换帧后指纹相同却轮次不同，
      // 会让节流闸误判「局面没变」而沿用过期的评估。
      var fpToMoveIsBlack = (openingSideToMove(board) === 1);
      var fpStones = fingerprint(board);
      var fp = fpStones + '#' + myColorCode() + '#' + (fpToMoveIsBlack ? 1 : 2);

      // 读子置信度过低 → 不动作，等稳定
      if (acc > 0 && acc < 0.6) { setStatus('<span style="color:#e67e22;">' + SF('off', '{c}', Math.round(acc * 100)) + '</span>'); clearOverlayKeepOpp(cal, cv, board); lastBoard = board.map(function (r) { return r.slice(); }); lastCount = n; return; }
      // 几何镜像卫兵（对 board-match 漏判的第二道防线）：同一画布、同一格距，但锚点(origin)
      // 跳到对侧(≈半盘以上格距) → 上下/左右镜像帧。此时禁止把镜像几何写入 lastGoodCal——
      // 否则渲染层 stableCalForRender 会用“刚被污染的镜像几何”，热力图/最佳圈/对手圈先画在
      // 镜像位、下一帧才回正（正是用户反馈的“先出现在纵坐标镜像位置再更新到对的位置”）。
      if (lastGoodCal && !lastGoodCal.isScreen && !cal.isScreen &&
          lastGoodCal.stepX > 0 && lastGoodCal.stepY > 0 && cal.stepX > 0 && cal.stepY > 0) {
        var pSame = Math.max(Math.abs(cal.stepX - lastGoodCal.stepX) / lastGoodCal.stepX,
                             Math.abs(cal.stepY - lastGoodCal.stepY) / lastGoodCal.stepY) < 0.15;
        var dyMir = Math.abs(cal.y0 - lastGoodCal.y0) > 7 * lastGoodCal.stepY;   // 垂直镜像：y0 跳约 N 格
        var dxMir = Math.abs(cal.x0 - lastGoodCal.x0) > 7 * lastGoodCal.stepX;   // 水平镜像：x0 跳约 N 格
        if (pSame && (dyMir || dxMir)) {
          diag('mirror anchor jump (' + (dyMir ? 'V' : '') + (dxMir ? 'H' : '') + ') -> revert to stable geom & re-read');
          cal = lastGoodCal;
          board = readBoard(cal, cv);
          n = countStones(board);
          acc = n > 0 ? verifyBoard(cal, cv, board) : 0;
          if (cachedBoard) { cachedBoard.cal = cal; cachedBoard.board = board; }
          drawCalibFrame(cal, cv);
        }
      }
      var prevFrameBoard = lastGoodBoard;   // ★ 上一帧棋盘快照（轮次差分锚定用）——必须在下方覆盖前取
      lastGoodCal = cal;   // 通过全部镜像卫兵后才更新稳定几何参照（镜像帧绝不写入，根治渲染先闪镜像位）
      lastGoodBoard = board;   // 通过置信度门槛 → 本帧棋盘作为下一轮帧间镜像校验的参照（正常对局每帧只差≤1子）
      if (typeof refreshPosWinIfOpen === 'function') refreshPosWinIfOpen();   // ★ 局面小窗开着 → 实时跟随识别布局（用户 2026-09-25 要求）

      // 子数、轮次
      var bCnt = 0, wCnt = 0;
      for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) { if (board[j][i] === 2) wCnt++; else if (board[j][i] === 1) bCnt++; }
      // ★【开局行棋方权威（本轮修复「新开局白子错乱下子」）★】
      //   原写法 `toMoveIsBlack = (bCnt === wCnt)` 在开局阶段有两个致命特例被漏掉：
      //     · bCnt === wCnt === 0（空盘）→ 判「轮白」→ 我执黑时 ourTurn=false → 自动落子卡死；
      //       更糟的是我执白时 ourTurn=true → **替黑方走第一手**（开局就替对手下棋）。
      //     · 开局读数抖动（残留子/差分漏读）导致 bCnt ≠ wCnt 时，直接翻转轮次 → 替白方落子。
      //   现统一由 openingSideToMove() 给出：空盘/子数相等 → 黑先；黑多于白 → 白。
      //   这样「新局第一手永远算黑方」不再是靠运气，而是规则。
      // ★ 2026-09-25 再升级（用户报「一直等待对手落子」）：纯奇偶判定对「幻影子」零自愈 ——
      //   多读一枚棋子 bn-wn 永久差 1，轮次整局翻不回来。改走 stmFromDiff 帧间差分锚定：
      //   恰一手 → 落子方对方走；盘面没变 → 沿用；非法态 → 沿用，绝不凭空翻。
      var stmColor = stmFromDiff(board, bCnt, wCnt, prevFrameBoard, lastStmColor);
      lastStmColor = stmColor;                              // 持久化：下一帧差分锚定的基准
      var toMoveIsBlack = (stmColor === 1);
      var stoneDiff = bCnt - wCnt;

      // ★ 夹逼自检：权威函数的结论必须与「子数代数」一致（唯一允许的例外是空盘 → 黑先）。
      //   不一致说明棋盘读数进入了非黑先的非法态（识别残留/漏读）→ 打诊断日志，
      //   便于排障时一眼看出是识别问题而不是逻辑问题。绝不影响主流程（权威函数说了算）。
      if (n > 0 && toMoveIsBlack !== (bCnt === wCnt)) {
        diag('openingSideToMove mismatch: bCnt=' + bCnt + ' wCnt=' + wCnt + ' stm=' + stmColor + ' (代数=' + (bCnt === wCnt ? '黑' : '白') + ')');
      }

      // ---- 新局检测（提前到「子数异常门」之前）：空盘 / 棋盘子数明显回退 → 立即清上一局状态 ----
      // 【★ 本轮修复「跨局故障：黑子下完最后一手后下一局乱下子」★】
      //   必须排在 stoneDiff 门控【之前】：旧位置在其之后，一旦某帧出现「黑-白≠0/1」的瞬时
      //   读数抖动（我们黑方下制胜第5子那一刻最易触发），stoneDiff 门会立刻 return，
      //   新局检测永远执行不到 → resetNewGame 永不触发 → 上一局终局锁/落子序列/几何残留到
      //   下一局 → 表现为「下一局乱下子」。提到最前后：只要棋盘子数断崖式回落（新开局），
      //   无条件先 reset，再谈一致性校验。
      //   另：任一方盘面子数异常但「已五连」时，下方 stoneDiff 门会让行（!fiveExists），
      //   交给我们(黑/先手)下完制胜第5子那一刻的「终局权威闸」去正确判定「我方五子连珠·停止评估」。
      var fiveExists = (maxLineLen(board, 1) >= 5 || maxLineLen(board, 2) >= 5);
      // ★ 计数条件必须含 (emptyStreak > 0)：首空帧在【本帧底部】就把 lastCount 清零，
      //   若只判 lastCount>0，第二空帧恒走 else → emptyStreak 永远到不了 2 →
      //   resetNewGame 从不触发（上一局曲线/推荐/+M3、gameOverLock 全部残留 →
      //   「空盘还在推荐 H13 +M3」「我执黑却不下天元」两症同源）。空盘连帧本身
      //   就是 2 帧确认：第 1 帧是「从有到空」须 lastCount>0 证明确实清过盘，
      //   第 2 帧起只要盘面仍空即累计；中途读到有子 → else 归零（抖动自愈）。
      if (n === 0 && (lastCount > 0 || emptyStreak > 0)) {
        emptyStreak++;
        // 连续 2 帧读到空盘才判定新局：识别抖动偶发漏读一帧 → 立即重置会清掉已判定的先后手、
        // 触发重新探测落子（“先手/后手跳跃变换”的直接来源之一）
        if (emptyStreak >= 2) resetNewGame(S.lang === 'en' ? 'board cleared' : '棋盘已清空');
      } else {
        emptyStreak = 0;
        // 棋盘子数比已记录落子少 ≥3：playok 等网站新开一局时不经过空盘，直接摆新盘。
        // 同样要求连续 2 帧（漏读 ≥4 子时单帧误判新局 → 重置 → 重新探测 → 跳跃）
        if (S.moves.length >= 4 && n > 0 && n < S.moves.length - 3) {
          shrinkStreak++;
          if (shrinkStreak >= 2) resetNewGame(S.lang === 'en' ? 'board reset' : '检测到新局');
        } else shrinkStreak = 0;
      }

      // 轮次一致性门控：只有 黑=白(轮黑) / 黑=白+1(轮白) 才推进，否则等稳定。
      // 借鉴 GomokuHelper 的即时有效性校验（is_effective_chessboard）：识别后立即校验黑白子数，
      // 不再只依赖“连续 4 次”慢节奏——首次异常立刻清缓存重定位一次（快棋/几何错位一轮自愈），
      // 重定位后仍异常才回到 4 次等待节奏（防无限重定位）。校验覆盖所有模式（含手动分析），
      // 保证引擎绝不拿黑白数不合法的局面做评估/出推荐。
      if (n > 0 && stoneDiff !== 0 && stoneDiff !== 1 && !fiveExists) {
        badDiffCount++;
        if (!badDiffSince) badDiffSince = Date.now();
        var dSince = Date.now() - badDiffSince;
        if (badDiffCount === 1 || (badDiffCount >= 4 && dSince > 1200)) {
          badDiffSince = Date.now();
          pyBoardCache = null; cachedBoard = null;
          diag('stone-diff -> immediate re-detect (#' + badDiffCount + ')');
          if (badDiffCount >= 4) { badDiffCount = 0; badDiffSince = 0; }
        }
        setStatus(S.lang === 'en' ? 'Board inconsistent, waiting…' : '棋盘子数异常，等待稳定…');
        lastBoard = board.map(function (r) { return r.slice(); }); lastCount = n; return;
      } else {
        badDiffCount = 0; badDiffSince = 0;
      }

      // ---- 新局检测实现（调用已提前到 stoneDiff 门之前，见上方）----
      function resetNewGame(reason) {
        if (S.side === -1) S.userSide = -1;
        lastAutoFp = null; pendingClick = null; openWaitStart = 0; probeOpen = null;
        lastBoard = null; lastCount = 0; emptyStreak = 0; autoHaltUntil = 0;
        lastEngineFp = null; lastEngineAt = 0;
        lastOppRings = null; lastOppGeom = null;                 // 新局：旧对手预测圈全部作废
        stabilizeBestReset();                                     // 新局：最佳落点稳定器重置
        sideLockUntil = 0; sideConflictCount = 0; shrinkStreak = 0;   // 新局：先后手稳定性状态清零，重新判定
        sideVote = { color: -1, n: 0 };                               // 新局：迟滞投票也要清零，上一局攒的票不能带进来
        haltForNewGame = false;               // 新局开始，恢复自动计算
        haltReason = ''; clearGameOverLock();  // 新局：解除「盘面五连·真终局」的持久化锁
        overlayStale = false;                 // 新局：允许重新绘制评估圆圈
        // 跨局【保留稳定几何】：同一页面、同一棋盘元素，网格几何在换局前后通常不变。
        // 保留 cachedBoard / screenBoard / lastGoodCal，让下一局开局首手直接复用上一局已验证的几何，
        // 彻底消除「空盘新局时被重新校准、又被纵向镜像/抖动带偏 → 天元点/落点纵向错开（乱放位置）
        // 或点击落点被判到棋盘外（卡死）」的旧问题。
        // 若棋盘在换局间真的发生位移/缩放，findBoard() 的 getBoundingClientRect 偏移检测会自行失效
        // 并重校准，无需在此清空——清空反而丢掉稳定几何、把抖动暴露到开局首手。
        pyBoardCache = null;
        lastGoodBoard = null; lastMirrorFixAt = 0;
        lastStmColor = 1;                     // 新局 → 轮次基准回黑先（差分锚定的持久状态）
        if (typeof refreshPosWinIfOpen === 'function') refreshPosWinIfOpen();   // 新局清盘 → 小窗同步清空
        S.history = []; S.moves = []; S.candCache = []; S.lastStat = null;
        S.score = 0; S.rawEval = ''; S.myEval = ''; S.verdict = 'none'; S.matePly = 0; saveHistory();
        clearOverlay(); drawChart(); refreshStatLang();
        setStatus('<span style="color:#3b7dd8;">' + (S.lang === 'en' ? 'New game — ' : '新局 — ') + reason + '</span>');
      }

      // ---- 逐格差分：本扫描与上一次快照相比新增的棋子（用于先后手 & 落子确认） ----
      var added = [];
      if (lastBoard) {
        for (var r0 = 0; r0 < N; r0++) for (var c0 = 0; c0 < N; c0++) {
          var oo = lastBoard[r0][c0], nn = board[r0][c0];
          if (oo === 0 && nn !== 0) added.push({ r: r0, c: c0, v: nn });
        }
      }

      // ---- 我方落子定位：待确认格(含容差) > 最近用户点击格 > 显著新增子 ----
      var myCell = null, myColorHere = null, oppColorHere = null;
      if (pendingClick) {
        if (board[pendingClick.j][pendingClick.i] === pendingClick.color) {
          myCell = { i: pendingClick.i, j: pendingClick.j }; myColorHere = pendingClick.color;
        } else {
          // 容差：目标格周围 1 格内出现我方颜色新子也算成功（网站磁吸/坐标微调时仍能确认）
          for (var k0 = 0; k0 < added.length && !myCell; k0++) {
            if (added[k0].v === pendingClick.color &&
                Math.abs(added[k0].c - pendingClick.i) <= 1 && Math.abs(added[k0].r - pendingClick.j) <= 1) {
              myCell = { i: added[k0].c, j: added[k0].r }; myColorHere = pendingClick.color;
            }
          }
        }
        if (!myCell) { var u0 = recentUserCell(cal, cv); if (u0 && board[u0.j][u0.i] !== 0) { myCell = u0; myColorHere = board[u0.j][u0.i]; } }
      } else {
        var uc = recentUserCell(cal, cv);
        if (uc && board[uc.j][uc.i] !== 0) { myCell = uc; myColorHere = board[uc.j][uc.i]; }
      }
      // 除我方落子格之外的新增子 → 视为对手应手（用其颜色反推我执）
      if (added.length) {
        for (var kA = 0; kA < added.length && oppColorHere == null; kA++) {
          if (myCell && added[kA].c === myCell.i && added[kA].r === myCell.j) continue;
          if (pendingClick && added[kA].c === pendingClick.i && added[kA].r === pendingClick.j) continue;
          // 探测历史格 ±1 都视为我方落子（探测点击不设 pendingClick；探测子被读在相邻格时，
          // 旧代码只跳过“精确格”→ 邻格黑子被误判成“对手黑子”→ 反推我执白 → 与探测块的
          // “我执黑”判定打架，正是先手/后手跳跃的根因），不据此反推我执
          if (probeOpen && nearProbeCells(probeOpen, added[kA].c, added[kA].r)) continue;
          oppColorHere = added[kA].v; overlayStale = false; lastOppRings = null; clearOverlay();   // 对手已落子 → 旧“对手预测圈”全部作废，下一轮按新局面重画
          kickOppEval();   // ★ 对手刚落子 → 立刻踢一次对手评估（不等 700ms tick），消除「慢半拍」
          break;
        }
      }
      // ================= 自动识别「我执」：带迟滞（hysteresis）的稳定判定 =================
      // 用户现场反馈：「软件一直在黑子白子间跳跃，稳定不下来……评估也是这样跳跃」。
      //
      // 根因是旧逻辑那两拍组合拳的**正反馈**：
      //   ① 未定 → 拿单帧证据**立刻**定色；
      //   ② 一致性冲突累计 ≥2 → 把 userSide **清成 -1** 去重判。
      //   抖动环因此闭合：定黑 → 某一帧读反 → 冲突×2 → 清空 → 下一帧拿新的噪声再定白 → 又冲突 → …
      //   症结从来不在「会不会偶尔判错」，而在**单帧噪声就能改写结论**，且清空后还能**瞬发重判**。
      //
      // 改法三条：
      //   A. 任何结论都要靠票 —— 连续 SIDE_VOTE_NEED 手（必须是**不同局面**）同色才写入或改判；
      //   B. 绝不先清空成「未定」再重判 —— 那个空窗就是跳跃的源头；反票够多时**直接改判**
      //      到相反色，一步到位，全程不经过任何一个「不知道我执谁」的瞬间；
      //   C. 刚定完的 SIDE_LOCK_MS 内不收反票（那一刻读盘最不稳）。
      if (AUTO_SIDE && S.side === -1 && added.length) {
        var evMy = (myColorHere != null) ? sideOfMyStone(myColorHere) : null;
        // 探测进行中不用「对手落子」反推：探测子被读在邻格会被当成对手黑子而反推我执白，
        // 与探测块自己的判定打架 —— 历史上先手/后手跳跃的元凶之一，这里必须让路。
        var evOpp = (oppColorHere != null && !probeOpen) ? sideOfOppStone(oppColorHere) : null;
        var observedSide = (evMy != null) ? evMy : evOpp;
        if (observedSide === 0 || observedSide === 1) {
          // 一手棋只投一票（外层的 added.length 已保证局面确实变了，见上方 SIDE_VOTE 注释）
          if (sideVote.color !== observedSide) sideVote = { color: observedSide, n: 1 };
          else sideVote.n++;
          var sideLocked = (Date.now() < sideLockUntil);
          var votesEnough = (sideVote.n >= SIDE_VOTE_NEED);
          if (S.userSide < 0) {
            // 未定 → 攒够票再定色（首手阶段读盘最抖，多一票更稳）
            if (votesEnough && !sideLocked) {
              S.userSide = observedSide; sideLockUntil = Date.now() + SIDE_LOCK_MS;
              sideVote.n = 0; sideConflictCount = 0;
              setStatus(S.lang === 'en' ? (S.userSide === 0 ? ' · auto: I play Black' : ' · auto: I play White') : (S.userSide === 0 ? ' · 自动识别我执<b>黑</b>' : ' · 自动识别我执<b>白</b>'));
            }
          } else if (S.userSide !== observedSide) {
            // 已定 → 反票够多才改判，且**直接切换**到另一色（不经过「未定」）
            if (votesEnough && !sideLocked) {
              S.userSide = observedSide; sideLockUntil = Date.now() + SIDE_LOCK_MS;
              sideVote.n = 0; sideConflictCount = 0;
              // 改判 = 换了一方：按旧颜色算出的引擎结果/候选/热力图全部作废重算，
              // 否则评估曲线会变成「前段黑方数据、后段白方数据」的跨色跳变 —— 正是用户说的评估乱跳。
              lastEngineFp = null; lastEngineAt = 0; S.candCache = []; overlayStale = true;
              lastOppRings = null; lastOppGeom = null;
              if (typeof stabilizeBestReset === 'function') stabilizeBestReset();
              setStatus('<span style="color:#e67e22;">' +
                (S.lang === 'en' ? 'Side re-detected: I play ' + (observedSide === 0 ? 'Black' : 'White')
                                 : '重新判定：我执<b>' + (observedSide === 0 ? '黑' : '白') + '</b>') + '</span>');
            }
          }
        }
      }
      // 先后手每次判定/变化后刷新「我执」按钮与文字读数，保证面板显示 == 引擎实际使用的颜色
      if (typeof paintSideBtns === 'function') paintSideBtns();
      // ---- 记录新增子到局面代码序列（局面 = 全部落子小写坐标串） ----
      if (added.length && S.moves.length < 400) {
        for (var kM = 0; kM < added.length; kM++) {
          var mv = coordLower(added[kM].c, added[kM].r);
          if (!S.moves.length || S.moves[S.moves.length - 1] !== mv) S.moves.push(mv);
        }
        refreshStatLang();
      }
      lastBoard = board.map(function (r) { return r.slice(); });
      lastCount = n;

      // ---- 我方落子确认：命中格/容差/新增子含我方落子色 均判成功（坐标微调、磁吸、识别偏差不影响确认）----
      if (pendingClick) {
        var pLanded = false;
        for (var pA = 0; pA < added.length && !pLanded; pA++) if (added[pA].v === pendingClick.color) pLanded = true;
        var pSuccess = myCell || pLanded;
        if (pSuccess) {
          var pCal = pendingClick.cal, pCv = pendingClick.cv;   // 落子棋盘引用：用于我方落子后保留对手虚线圆
          pendingClick = null;
          // 我方落子已生效：旧局面的热力图/最佳点作废；对手落点虚线圆保留到对手落子才消失/更新
          if (!oppColorHere) { overlayStale = true; clearOverlayKeepOpp(pCal, pCv, board); }
          // 成功落子后给 1.5s 冷却：等棋盘重绘，避免立刻重拍同一格被“打回”→误判失败卡住
          autoHaltUntil = Date.now() + 1500;
          setStatus(S.lang === 'en' ? 'Auto-move placed' : '自动落子已生效'); }
        else if (Date.now() - pendingClick.since > 3000) {
          pendingClick.retries++;
          if (pendingClick.retries < 3) { redispatchPending(pendingClick); pendingClick.since = Date.now(); setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Retrying move…' : '落子未生效，重试中…') + '</span>'); }
          else { setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? '自动落子未确认，暂停中——可手动点一下棋盘即自动恢复' : 'Auto-move unconfirmed, paused — click the board to auto-resume') + '</span>'); autoHaltUntil = Date.now() + 8000; pendingClick = null; }
        }
        return;
      }
      // ---- 手动干预自动恢复：非我方自动点击，却出现我方颜色落子（人工点了一子）且自动处于暂停 → 立即恢复自动落子 ----
      if (S.autoPlay && sideResolved() && !pendingClick && myColorHere != null &&
          myColorHere === myColorCode() && autoHaltUntil > Date.now()) {
        autoHaltUntil = 0;
        setStatus(S.lang === 'en' ? 'Manual move detected, auto-play resumed' : '已检测到我方落子，自动落子已恢复');
      }

      // ---- 自动模式：我方颜色未知 → 主动试探(天元周围8格随机) + 网络监听协同判定 ----
      // 策略（更灵活，且按“落子位置身份”判，与时间无关、不怕快手/慢手对手）：
      //   1) 若网络监听已写 userSide → 直接用，进下方先行首手/等待逻辑；
      //   2) 否则空盘主动落一颗黑子到天元周围8格随机作为“探测+首手”：
      //       探测格 ±1 内出现黑子 → 只可能是我们自己下的 → 判我执黑(先手)；
      //       黑子出现在探测格 ±1 之外 → 对方先行开局 → 判我执白(后手)，等对手开局；
      //       短暂(1.5s)内无动静，或对手白子已落而探测子未现 → 换另一随机格再试一次。
      // 科学性修正：判定带 ±1 格容差（读盘抖动/网格微偏会把我们的黑子读在邻格，
      // 旧代码按“精确格”判定会误以为“黑子在他处=对方开局”→ 判错我执白，正是快手对手时
      // “判断我方是白子”的根因）。
      if (AUTO_SIDE && S.autoPlay && S.side === -1 && S.userSide < 0) {   // 自动识别已关闭 → 下一律不生效
        // 网络监听优先：若已定色，交给下方逻辑（先手即开局，后手即等待）
        // —— 已有探测：用“落子位置身份”判定 ——
        var probeRetry = function () {
          if (probeOpen.retried) {
            probeOpen = null;
            setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Cannot detect - set 我执 (Black/White)' : '仍无法判定先后手——请点「我执」手动选黑/白') + '</span>');
            return;
          }
          probeOpen.retried = true; probeOpen.since = Date.now();
          if (!probeOpen.cells) probeOpen.cells = [{ i: probeOpen.i, j: probeOpen.j }];
          var offs2 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
          var p2 = offs2[(Math.random() * offs2.length) | 0];
          probeOpen.i = 7 + p2[0]; probeOpen.j = 7 + p2[1];
          probeOpen.cells.push({ i: probeOpen.i, j: probeOpen.j });   // 记住所有探测过的格：延迟落成的那颗也认作我方
          var pb2 = coordFor(cal, cv, probeOpen.i, probeOpen.j);
          if (pb2 && !pb2.blocked) { panelClickFlag = true; syntheticClick(cal, cv, probeOpen.i, probeOpen.j, pb2.x, pb2.y, pb2.pageX, pb2.pageY, pb2.frameWin); setTimeout(function () { panelClickFlag = false; }, 400); }
          setStatus(S.lang === 'en' ? '1st probe inert, retrying a nearby cell…' : '首试未落成，换周围格再试…');
        };
        if (probeOpen) {
          // 容差 ±1 + 探测历史格：探测子可能被读在相邻格、或延迟落成；
          // 任一探测过的格 ±1 内的黑子只可能是我们下的（旧代码按“精确格+单格”判定，
          // 抖动/延迟时会把我们的黑子误认成“对方开局”→ 判错我执白，正是快手对手时“判断我方是白子”的根因）。
          var probeCells = probeOpen.cells || [{ i: probeOpen.i, j: probeOpen.j }];
          var nearOur = null, farBlack = null, farWhite = null, nearWhite = null;
          var nearAnyProbe = function (c, r) {
            for (var pi = 0; pi < probeCells.length; pi++) {
              if (Math.abs(c - probeCells[pi].i) <= 1 && Math.abs(r - probeCells[pi].j) <= 1) return true;
            }
            return false;
          };
          for (var q0 = 0; q0 < added.length; q0++) {
            var qa = added[q0];
            var nearP = nearAnyProbe(qa.c, qa.r);
            if (qa.v === 1) { if (nearP) { if (!nearOur) nearOur = qa; } else if (!farBlack) farBlack = qa; }
            else if (qa.v === 2) {
              if (nearP) { if (!nearWhite) nearWhite = qa; }   // 探测格 ±1 内出现白子：网站把我们当白方、点击落白 → 我方执白
              else if (!farWhite) farWhite = qa;
            }
          }
          // 盘面兜底：任一探测格 ±1 内已有黑子（差分可能因上一轮已记录而漏报）→ 我方探测子已落成
          if (!nearOur) {
            for (var pi2 = 0; pi2 < probeCells.length && !nearOur; pi2++) {
              var pc0 = probeCells[pi2];
              for (var dr9 = -1; dr9 <= 1 && !nearOur; dr9++) for (var dc9 = -1; dc9 <= 1 && !nearOur; dc9++) {
                var r9 = pc0.j + dr9, c9 = pc0.i + dc9;
                if (r9 >= 0 && r9 < N && c9 >= 0 && c9 < N && board[r9][c9] === 1) nearOur = { r: r9, c: c9, v: 1 };
              }
            }
          }
          if (nearOur) {
            S.userSide = 0; probeOpen = null; sideLockUntil = Date.now() + 4000;
            setStatus(S.lang === 'en' ? 'Probe cell = my Black → I play first' : '探测格落黑子 → 判我执<b>黑</b>（先手）');
          } else if (nearWhite) {
            // 网站把我们当白方：探测点击落白子在探测格 ±1（旧代码 !nearP 条件让此路径永不命中 →
            // 我方执白时探测永远无法完成、反复重试），白子在探测格内 = 我方落子 → 判我执白
            S.userSide = 1; probeOpen = null; sideLockUntil = Date.now() + 4000;
            setStatus(S.lang === 'en' ? 'Probe cell = my White → I play second' : '探测格落白子 → 判我执<b>白</b>（后手）');
          } else if (farBlack) {
            S.userSide = 1; probeOpen = null; sideLockUntil = Date.now() + 4000;
            setStatus(S.lang === 'en' ? 'Opponent opened elsewhere → I play second' : '对方先开局 → 判我执<b>白</b>（后手）');
          } else if (farWhite) {
            // 对手白子已落、探测格及邻格未见黑子：探测子没落成（点击被吞/识别延迟）→ 换格再试
            probeRetry();
          } else if (Date.now() - probeOpen.since > 1500) {
            probeRetry();
          }
          drawChart(); clearOverlayKeepOpp(cal, cv, board);
          return;
        }
        // —— 空盘且未探测：立即点击探测（不等待、不费时）——
        if (n === 0) {
          // 点击前先看盘面：对手已抢在开局前落子（黑先规则首子必黑）→ 直接判白/黑，零点击
          if (added.length) {
            var fAdd = added[0];
            if (fAdd.v === 1) {
              S.userSide = 1; probeOpen = null; openWaitStart = 0; sideLockUntil = Date.now() + 4000;
              setStatus(S.lang === 'en' ? 'Opponent opened with Black → I play White' : '对手黑子开局 → 判我执<b>白</b>（后手）');
              drawChart(); clearOverlayKeepOpp(cal, cv, board);
              return;
            } else if (fAdd.v === 2) {
              // 首子为白（白先规则/读盘异常）→ 对手先手 → 我执黑
              S.userSide = 0; probeOpen = null; openWaitStart = 0; sideLockUntil = Date.now() + 4000;
              setStatus(S.lang === 'en' ? 'Opponent opened with White → I play Black' : '对手白子开局 → 判我执<b>黑</b>（先手）');
              drawChart(); clearOverlayKeepOpp(cal, cv, board);
              return;
            }
          }
          // 盘面仍空 → 立即点击天元周围随机格（黑先首手试探）：
          //   · 点击落黑 → 我们的点击成功 → 先手（判黑）
          //   · 点击落白 → 网站把我们当白方 → 后手（判白）
          //   · 网络后台同步监听（netGuess/netProbeTurn）确认点击归属：
          //       后台反馈“轮到对方/我方已落子” → 先手；反馈“轮到我们/点击未生效” → 后手
          var offsH = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];   // 天元周围8格（避开中心星位/识别干扰）
          var ph = offsH[(Math.random() * offsH.length) | 0];
          probeOpen = { since: Date.now(), i: 7 + ph[0], j: 7 + ph[1], color: 1, retried: false, cells: [{ i: 7 + ph[0], j: 7 + ph[1] }] };
          var pb1 = coordFor(cal, cv, probeOpen.i, probeOpen.j);
          if (pb1 && !pb1.blocked) { panelClickFlag = true; syntheticClick(cal, cv, probeOpen.i, probeOpen.j, pb1.x, pb1.y, pb1.pageX, pb1.pageY, pb1.frameWin); setTimeout(function () { panelClickFlag = false; }, 400); }
          setStatus(S.lang === 'en' ? 'Clicking to probe side (net + board confirm)…' : '立即点击试探判先后手（后台+盘面双重确认）…');
          drawChart(); clearOverlayKeepOpp(cal, cv, board);
          return;
        }
        // 非空盘仍未知：等差分/网络，或引导手动指定
        setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Side pending - will detect on next stone (or set 我执 manually)' : '先后手待定——对方落子后自动判定；也可在「我执」手动选择黑/白') + '</span>');
        drawChart(); clearOverlayKeepOpp(cal, cv, board); return;
      }

      // ---- 我执 / 轮次 ----
      // 空盘 = 新对局开始：解除上一局遗留的“胜负已定”停算锁（haltForNewGame 会从
      // localStorage 跨会话继承——上局 M1 结束后若不解除，先行首手、自动落子、对手圈刷新
      // 整条链路的 !haltForNewGame 条件全部失效 → “根本不会自动落子 + 对手圈不显示”）。
      // ★ 例外：盘面五连的【真终局】锁不解 —— 见下方【终局权威闸】。
      if (n === 0 && !gameOverLocked()) { haltForNewGame = false; haltReason = ''; }
      // ---- 关闭自动识别后：先后手一律由用户手动指定，未指定前【完全不动】 ----
      // 不再靠“猜子数 / 差分反推 / 谁先开局”去推断我方颜色 → 判定误差为零，
      // 也就不可能出现「替对手下棋」「点白却按黑评估」这类事故。
      if (mySideMask() < 0) {
        setStatus('<span style="color:#e67e22;">' + (S.lang === 'en'
          ? 'Pick your color first — click B or W in the "Me" row, then play.'
          : '请先在面板「我执」点选<b>黑</b>或<b>白</b>后再开始（不再自动猜先后手）') + '</span>');
        if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
        drawChart(); clearOverlayKeepOpp(cal, cv, board);
        return;
      }
      var ourIsBlack = (mySideMask() === 0);
      // 我方颜色未知时的轮次兜底（仅在开启自动识别时才有意义）：上一手是对手落子
      // （oppColorHere 非空）→ 当前必轮到我方，我方颜色由对手落子色反推（我执色 = 3 - oppColor）。
      if (AUTO_SIDE && mySideMask() < 0 && oppColorHere != null) {
        ourIsBlack = (oppColorHere === 2);
      }
      var canAutoOpen = S.autoPlay && ourIsBlack && (mySideMask() === 0);
      // 空盘：非自动，或我执白/未知 → 等对手先下
      if (n === 0 && !canAutoOpen) { setStatus(S.lang === 'en' ? 'Empty board, waiting…' : '空棋盘，等待落子…'); if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed); drawChart(); clearOverlayKeepOpp(cal, cv, board); return; }
      // 轮次判定：统一用 ourIsBlack（来自唯一事实来源），不再分三支各写一遍。
      // ★【本轮修复】改用【开局行棋方权威】的 stmColor（= openingSideToMove(board)）判定，
      //   而不是 `ourIsBlack === (bCnt===wCnt)`：
      //     · 空盘时 stmColor 恒为黑 → 我执黑才轮到我方（我执白 → ourTurn=false，等对手先下），
      //       杜绝「我执白却替黑方落下开局第一手」；
      //     · 开局读数抖动导致代数式给出「轮白」时，权威式仍按「黑先」定轮次。
      var ourTurn = ((stmColor === 1) === ourIsBlack);

      // ---- 我方/对手颜色码：唯一事实来源，本帧只解析一次 ----
      // 【★ 必须显式赋 var（本轮修 bug）★】旧版这两行写在下面「我方最佳落点」那一大段里，
      //   而下面的「制胜收子闸」先引用了它们 → 那时 `myColor0` 要么是 undefined、要么残留上一帧的值：
      //     · undefined → maxLineLen(board, undefined) 数不出我方连子 → 收子闸判空 → 制胜子落不下；
      //     · 残留旧值 → 换色后仍按旧颜色收官 → 落错颜色/落空。
      //   提到这里（收子闸之前）统一解析：整帧同源，谁都改不了。
      var myColor0 = myColorCode();          // 1 黑 / 2 白 / 0 未定
      var oppColor0 = oppColorCode();        // 对手颜色
      if (myColor0 === 0) {                  // 颜色未定时不再臆造：走「待定」分支（上方已拦截，双保险）
        myColor0 = ourIsBlack === true ? 1 : 2;
        oppColor0 = ourIsBlack === true ? 2 : 1;
      }

      // ====================================================================
      // 【★ 终局权威闸（本轮新增 · 最高优先级）★】
      //   用户明确要求：「我方是黑色的时候，下完最后第 5 个子，就不再有任何评估」。
      //   为什么必须是这一条独立的闸（而不是靠下面那个五连闸 / haltForNewGame）：
      //     1) 下面那把五连闸位于【轮次判定之后】——终局那一手落子后轮次会翻转，
      //        若翻到「轮到对手」，函数在第一道 `if (!ourTurn) return` 就返回了，
      //        五连闸**根本执行不到**：状态栏仍是「等待对手落子…」、曲线不封口、
      //        评估栏停留在倒数第二手 —— 用户看到的正是「第五子下完了但还在评估」。
      //     2) haltForNewGame 只有会话内布尔值 + 会被多处 `n===0` / resetNewGame 解开，
      //        任一帧的识别抖动（空盘误读、子数回退）都能把它解开 → 终局画面"复活"。
      //   做法：把「任一方盘面五连」当成**物理事实**，在整帧最开始（颜色解析完、轮次判断前）
      //   就判定并短路返回，且同时上 localStorage 持久化锁 —— 只有 resetNewGame
      //   （空盘/子数回退/用户改「我执」）才解得开。这样无论终局那一手是"我方落第 5 子"
      //   还是"对手落第 5 子"，无论落子后轮次翻到谁，画面都恒定停在最终判定。
      // ====================================================================
      if (maxLineLen(board, myColor0) >= 5 || maxLineLen(board, oppColor0) >= 5) {
        var _winMe = maxLineLen(board, myColor0) >= 5;
        haltForNewGame = true;
        haltReason = _winMe ? 'five-my' : 'five-opp';
        setGameOverLock(haltReason);
        var _fiveScore = _winMe ? 1000 : -1000;
        S.score = _fiveScore; S.verdict = _winMe ? 'win' : 'lose'; S.matePly = 1;   // 评估栏/曲线恒定按终判显示
        pushHistPoint((S.moves && S.moves.length) ? S.moves.length : 0, _fiveScore);  // 同手数覆盖 → 曲线封口，绝不再延伸
        saveHistory();
        clearOppSvgLayer();                                    // 对手预测圈：终局恒为空
        if (S.candCache && S.candCache.length) {
          renderResult(cal, cv, S.candCache, null, null, _fiveScore, S.verdict, false, board, ourIsBlack === toMoveIsBlack);
        }
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
          ? (_winMe ? 'Five in a row — I WIN. Evaluation stopped, waiting for next game…'
                    : 'Opponent five in a row — I LOSE. Evaluation stopped, waiting for next game…')
          : (_winMe ? '已五子连珠——<b>我方获胜</b>，已停止评估，等待下一局…'
                    : '对手已五子连珠——<b>我方落败</b>，已停止评估，等待下一局…')) + '</span>');
        drawChart();
        clearOverlayKeepOpp(cal, cv, board);                   // 只保留终局需要的绘制，热力图/推荐点全部撤下
        return;
      }

      // ---- 轮到对手：不评估、不落子，只等 ----
      // 【用户明确要求：不要评估对手】曲线/评估栏只对应「我方视角、我方该走」的那些手。
      // 下面所有 playMove 分支都带 ourTurn 条件，轮到对手时一个都不会触发。
      //
      // 【★★ 必须对所有模式生效，不能只挡自动模式（本轮修复的「符号反了」根因）★★】
      //   旧写法 `if (S.autoPlay && !ourTurn)` 只在【自动落子】模式下提前返回；
      //   手动模式下轮对手时**会继续往下走完整分析**，于是：
      //     · 引擎按「对手走棋」那一帧返回 eval（行棋方=对手）；
      //     · myIsSideToMove=false → evalToMine 翻符号 → 数值语义相对上一手反转；
      //     · fresh=true → 还把这一帧【推进了评估曲线】、覆盖了 S.myEval。
      //   用户看到的就是「对手落子后评估值/曲线符号突然反了、和我方该走时对不上」。
      //   现在无论自动还是手动，轮对手一律：不请求引擎、不动评估、不动曲线，
      //   只保留最近一次「我方该走」时算出的评估（与面板显示同源）。
      if (!ourTurn) {
        setStatus('<span style="color:#555;">' + (S.lang === 'en' ? 'Waiting for opponent…' : '等待对手落子…') + '</span>');
        if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
        drawChart();                                   // 曲线按已有历史重绘（不新增点）
        clearOverlayKeepOpp(cal, cv, board);
        return;
      }

      // ---- 【收官闸】轮到我方、且盘面存在“落一子立即成五”的空格 → 立即收官 ----
      // 【★ 位置约束（必须同时满足，本轮已校准）★】
      //   · 排在「轮到对手 → return」【之后】：收官的前提就是轮到我方，轮到对手时
      //     本函数必须立刻返回（否则会在对手回合替对手算杀），所以守卫必须在前；
      //   · 排在「引擎请求（needEngine / /api/analyze）」【之前】：不看 autoPlay、
      //     不看 autoHaltUntil、不等引擎返回。历史 BUG（用户反馈“下不完最后一个子”）：
      //     原先只有 autoPlay 开启时才收官，且要等引擎返回；手动模式下轮到我方制胜手时
      //     直接掉进“等待对手”分支 return，用户眼看着四连却怎么都下不出第五子。
      //     现在改为盘面自证：只要轮到我方且存在成五点，无条件落子。
      if (!haltForNewGame && ourTurn && Date.now() >= autoHaltUntil &&
          maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
        var winCellsEarly = allImmediateFiveCells(board, myColor0, (S.rule === 2 && myColor0 === 1));
        if (winCellsEarly.length) {
          var wc0 = winCellsEarly[0];
          if (board[wc0.j] && board[wc0.j][wc0.i] === 0) {
            if (playMove(cal, cv, wc0.i, wc0.j, myColor0)) {
              renderResult(cal, cv, S.candCache, [wc0.i, wc0.j], 0, 1000, 'win', false, board, true);
              setStatus(S.lang === 'en' ? 'Final move placed — win on board' : '已落制胜子，本局收官');
              drawChart();
              return;
            }
          }
        }
      }

      // ====================================================================
      // 【★ M1 收官补着（用户要求：评估完成后额外自动下完最后一个子，此过程不评估）★】
      //   场景：评估已到 +M1 并锁定（haltForNewGame=true, haltReason='m1'），但制胜子
      //   尚未落下 —— 锁定那一刻 autoHaltUntil 未到 / playMove 偶发失败。
      //   旧行为：halt 之后所有落子链路都被 !haltForNewGame 封死 → 「+M1 已锁定却永远
      //   不下最后一子」（截图场景：黑 F13-G12-H11-I10 四连、白 34 堵一端，
      //   面板恒停「推荐 E14 +M1 已锁定」不动）。
      //   本闸：m1 停算状态下、轮到我方、盘面仍有成五点 → 直接补下制胜子并解除 m1 停算
      //   （下一轮由【终局权威闸】确认盘面五连 → 持久化锁 + 曲线封口）。全程不请求引擎。
      // ====================================================================
      if (haltForNewGame && haltReason === 'm1' && !gameOverLocked() &&
          ourTurn && Date.now() >= autoHaltUntil && S.verdict === 'win' &&
          maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
        var m1wCells = allImmediateFiveCells(board, myColor0, (S.rule === 2 && myColor0 === 1));
        if (S.rule === 2 && myColor0 === 1 && m1wCells.length) {
          m1wCells = m1wCells.filter(function (wc) {
            return !isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0);
          });
        }
        if (m1wCells.length) {
          var m1w0 = m1wCells[0];
          if (board[m1w0.j] && board[m1w0.j][m1w0.i] === 0) {
            if (playMove(cal, cv, m1w0.i, m1w0.j, myColor0)) {
              haltForNewGame = false; haltReason = '';   // 解除 m1 停算：下一轮终局权威闸确认五连后彻底停算
              setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
                ? 'Final move placed per +M1 — five in a row, evaluation stopped'
                : '已按 +M1 判定补下制胜子——<b>五子连珠</b>，本局收官（不再评估）') + '</span>');
              drawChart();
              return;
            }
          }
        }
      }

      // ====================================================================
      // 【★ 五连即停算（用户明确要求）★】
      //   原话：「如果检测有一方五子连珠的话，就不用再评估了」。
      //   为什么必须放在这里（而不是只靠下方 matePly===1 闸）：
      //     · 引擎在「盘面已经五连」时**并不保证返回 ±M1** —— 实测截图盘面（黑已 F12..J12 五连）
      //       引擎返回的是 `-M6`（还有 6 步的"理论存活"），matePly=6 ≠ 1 → 旧闸不拦；
      //     · 于是面板继续按 250ms 实时轮询评估、曲线继续往后长点，
      //       用户看到的就是「五子连珠了还在评估、-1000 拉了一条平线还继续延伸」。
      //   本闸是【纯盘面判定】：不看引擎、不看 matePly、不看轮次、不看自动/手动模式。
      //   任一方五连 → 立即：渲染最终判定、置 haltForNewGame、清层、停止一切评估。
      //   颜色一律走 myColorCode()/oppColorCode()（与面板「我执」按钮同源），绝不反推。
      // ====================================================================
      {
        var _mC = myColorCode(), _oC = oppColorCode();
        if (_mC === 0) { _oC = 1; _mC = 2; }              // 颜色未定时的兜底（上方已拦，此处双保险）
        var _myFive = maxLineLen(board, _mC) >= 5;
        var _opFive = maxLineLen(board, _oC) >= 5;
        if (_myFive || _opFive) {
          var _fScore = _myFive ? 1000 : -1000;
          var _fVerd = _myFive ? 'win' : 'lose';
          haltForNewGame = true;                          // 彻底停算：下一轮起不再请求引擎
          haltReason = _myFive ? 'five-my' : 'five-opp';
          setGameOverLock(haltReason);                    // ★ 真终局锁：跨帧/跨会话都解不开，只有新局 reset 清
          S.score = _fScore; S.verdict = _fVerd; S.matePly = 1;
          // 曲线只入「终局这一手」一个点（同一手数覆盖刷新，不新增点）→ 五连之后绝不再延伸。
          pushHistPoint((S.moves && S.moves.length) ? S.moves.length : 0, _fScore);
          try { save(); } catch (e) {}
          saveHistory();
          clearOppSvgLayer();                             // 终局：对手预测圈已无意义
          if (S.candCache && S.candCache.length) {
            renderResult(cal, cv, S.candCache, null, null, _fScore, _fVerd, false, board, toMoveIsBlack === ourIsBlack);
          }
          setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
            ? (_myFive ? 'Five in a row — I WIN. Evaluation stopped, waiting for next game…'
                       : 'Opponent five in a row — I LOSE. Evaluation stopped, waiting for next game…')
            : (_myFive ? '已五子连珠——<b>我方获胜</b>，已停止评估，等待下一局…'
                       : '对手已五子连珠——<b>我方落败</b>，已停止评估，等待下一局…')) + '</span>');
          drawChart();
          clearOverlayKeepOpp(cal, cv, board);
          return;
        }
      }

      // ---- 先行首手：空盘、我执黑(先手)、轮到我 → 直接开局 (绕过引擎分析) ----
      // 先手开局统一落天元 (7,7)：无论是用户直接指定黑(side===0)还是自动判别为黑(userSide===0)，
      // 标准开局都下天元。旧版对自动判黑用了“90% 天元周围 8 格随机、10% 天元”以“避开中心星位识别干扰”，
      // 但随机偏移又叠加识别抖动 → 用户反馈“先手开局经常没下在天元”。故一律固定天元，稳定且规范。
      if (S.autoPlay && n === 0 && ourIsBlack && !haltForNewGame) {
        var opI = 7, opJ = 7;
        if (board[opJ] && board[opJ][opI] === 0) {
          var _ok = playMove(cal, cv, opI, opJ, 1);
          // 开局落子若失败（几何被纵向抖动带偏、点击落点被判出界/被遮挡）→ 立即丢弃旧几何、下一帧重校准，
          // 避免「空盘新局什么都不发生」的卡死。带 1.2s 冷却防止重校准失败时陷入死循环。
          if (!_ok && Date.now() - openReanchorAt > 1200) {
            openReanchorAt = Date.now();
            cachedBoard = null; screenBoard = null; lastGoodCal = null;
            diag('opening click failed -> re-anchor geometry');
          } else if (_ok) {
            setStatus(S.lang === 'en' ? 'Opening move placed (center)' : '已自动开局（天元）');
            drawChart(); clearOverlay();
          }
        }
        return;
      }

      // ---- 步调节流：只在“局面真正变化”时重新评估。局面静止 → 直接沿用缓存结果，
      //      不再循环算、不再往曲线重复加点；一旦对方落子导致 fp 变化，下一轮立即重算（灵活响应）。
      // 胜负已定(M1/-M1)时：haltForNewGame=true → 不再请求引擎、不再刷新曲线，静待新局。
      var needEngine = !haltForNewGame && (fp !== lastEngineFp);
      if (!needEngine) {
        if (S.candCache.length) renderResult(cal, cv, S.candCache, null, null, S.score, S.verdict, false, board, toMoveIsBlack === ourIsBlack);
        else if (S.lastStat && S.lastStat.c0) setStatPanel(S.lastStat.c0, S.lastStat.elapsed);
        // 终局/连续落子兜底：目标格若被识别残留/对方提前堵点占用，就近找空格落，
        // 避免自动落子反复点同一格而被网站拒绝、最后一子永远下不下去
        if (S.autoPlay && !haltForNewGame && ourTurn && Date.now() >= autoHaltUntil && S.candCache && S.candCache.length) {
          // 锚点守卫同样适用：缓存候选来自上一轮主车道深搜（≥2.5s）→ 按深搜口径尊重引擎排序，
          // 只过滤禁手/占格，不再因「远石」改判（旧守卫在这里同样会拉低深搜质量）
          var autoColor2 = toMoveIsBlack ? 1 : 2;
          var am2 = autoAnchorPick(board, null, S.candCache, autoColor2, { budgetMs: 99999 });
          if (am2) {
            var ax2 = am2[0], ay2 = am2[1];
            if (board[ay2][ax2] !== 0) { var ne2 = nearestEmpty(board, ax2, ay2); if (ne2) { ax2 = ne2.i; ay2 = ne2.j; } }
            if (ax2 >= 0 && ay2 >= 0 && board[ay2][ax2] === 0) playMove(cal, cv, ax2, ay2, toMoveIsBlack ? 1 : 2);
          }
        }
        return;
      }

      lastEngineFp = fp; lastEngineAt = Date.now();
      // 请求期间的「颜色快照」：响应回来必须核对用户没在我执上换过色。
      // 一旦不同 → 丢弃整包（见下方颜色一致性硬校验），绝不用旧颜色换算新结果。
      var reqFp = fp;
      var reqOurIsBlack = ourIsBlack;
      setStatus('<span style="color:#3b7dd8;">' + T('thinking') + '</span>');
      setStatPanelThinking();
      var t0 = Date.now();
      // ---- 实时刷新（仿 gomocalc）：搜索进行中每 250ms 轮询 /api/status，
      //      即时更新深度/评估/速度/节点、评估曲线与最佳落点，不再等整局算完才出数据 ----
      var myIsSideToMove = (toMoveIsBlack === ourIsBlack);
      var liveGen = 0;
      var liveTimer = setInterval(function () {
        var g = liveGen;
        (async function () {
          try {
            var rs = await tryLocal(LOCAL_HOSTS, '/api/status?cid=' + CLIENT_ID + '&lane=main', { method: 'GET', cache: 'no-store' });
            var st = await rs.json();
            if (g !== liveGen || !st || !st.searching || !st.pvs || !st.pvs.length) return;
            var pv0 = st.pvs[0];
            if (!pv0) return;
            var les = evalToScore(pv0.eval, myIsSideToMove);
            var lscore = les.score, lverd = les.verdict;
            function lset(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
            lset('__gb_st_depth', pv0.depth ? pv0.depth : '-');
            // 评估栏：归一到【我方视角】后再显示（用户要求：评估值必须是「我们执子」的评估）。
            var lRaw = (typeof pv0.eval === 'string' && pv0.eval.length) ? pv0.eval.trim() : '';
            S.rawEval = lRaw;
            var lMine = lRaw ? evalToMine(lRaw, myIsSideToMove) : '';
            S.myEval = lMine;
            lset('__gb_st_eval', lMine || '-');
            lset('__gb_st_speed', st.speed ? fmtKMG(st.speed) : '-');
            lset('__gb_st_nodes', st.nodes ? fmtKMG(st.nodes) : '-');
            var lCoord = String.fromCharCode(65 + pv0.x) + (N - pv0.y);
            var lCol, lLab;
            if (lverd === 'win') { lCol = '#3b7dd8'; lLab = S.lang === 'en' ? 'I WIN (M)' : '我方必胜'; }
            else if (lverd === 'lose') { lCol = '#e74c3c'; lLab = S.lang === 'en' ? 'I LOSE (-M)' : '我方必败'; }
            else if (lscore < -300) { lCol = '#e67e22'; lLab = S.lang === 'en' ? 'Bad' : '大劣'; }
            else if (lscore > 300) { lCol = '#2e7d32'; lLab = S.lang === 'en' ? 'Good' : '优势'; }
            else { lCol = '#7f8c8d'; lLab = S.lang === 'en' ? 'Even' : '均势'; }
            setStatus((S.lang === 'en' ? 'Depth ' : '深度 ') + '<b>' + (pv0.depth || '-') + '</b> · ' + (S.lang === 'en' ? 'Move ' : '推荐 ') + '<b style="color:#e53935">' + lCoord + '</b>　' + (S.lang === 'en' ? 'eval ' : '评估 ') + '<b style="color:' + lCol + '">' + (lMine || '-') + '</b> <b style="color:' + lCol + '">(' + lLab + ')</b>');
            drawChart();
            if (cal && cv) {
              var liveCands = [];
              for (var li = 0; li < st.pvs.length; li++) {
                var lc = st.pvs[li];
                liveCands.push({ x: lc.x, y: lc.y, eval: lc.eval || '', depth: lc.depth || 0, speed: st.speed || 0, nodes: st.nodes || 0, line: lc.line || [] });
              }
              drawOverlay(cal, cv, liveCands, (st.best && st.best.length === 2) ? st.best : null, board, myIsSideToMove);
            }
          } catch (e) {}
        })();
      }, 250);
      var ctrl = new AbortController();
      if (deepMode) setStatus(S.lang === 'en' ? '<span style="color:#A5B4FC;">Deep analyze (≈30s)…</span>' : '<span style="color:#A5B4FC;">深度计算中（约30秒）…</span>');
      // 客户端兜底超时放宽到 turnMs+8s（与服务端 waitForMove 余量一致）：复杂局面/深算绝不因超时被截断
      var effTurn = deepMode ? DEEP_MS : S.turnMs;
      var abt = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, Math.max(3000, effTurn + 8000));
      var data;
      try {
        // 【落子走「强单路」、评估走「多路」——用户明确要求】
        //   真正的落子位置：永远单路(topN=1)，算力全压主线 → 搜索最深、best 最稳。
        //   实测浅搜 topN=8 会在少子局面把 best 投到离棋子 2~3 格的远点（正是“白子落点非常偏”
        //   的根因）；单路深搜则稳定落近石点。再叠加 autoAnchorPick 近石守卫作最终兜底，落点不再偏。
        //   热图/对手圈等“其他评估”的多路(topN=8)交给独立的 refreshOverlayCands 完成，
        //   主搜索只回答“落子该下哪”，评估多路与落子决策解耦。
        //   代价：主搜索进行中实时热图只铺 1 色，补充搜索完成后即恢复 8 色完整热图。
        var liveTopN = 1;
        // 自动落子时给落子决策留足算力（强单路）：单步思考下限 2.5s，少子浅局也能深算到位。
        var moveTurnMs = (S.autoPlay ? Math.max(effTurn, 2500) : effTurn);
        var body0 = JSON.stringify({ board: board, rule: S.rule, matchMs: S.matchMs, turnMs: moveTurnMs, timeUsedMs: S.timeUsedGame || 0, topN: liveTopN, cid: CLIENT_ID, lane: 'main' });
        var r = await tryLocal(LOCAL_HOSTS, '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body0, signal: ctrl.signal });
        ENGINE = r.url ? r.url.split('/api/analyze')[0] : ENGINE;
        data = await r.json();
      } catch (e) {
        clearTimeout(abt);
        liveGen++; clearInterval(liveTimer);
        ENGINE_FAILED = e && e.message;
        // HTTPS 页面连不上本地 HTTP 属常见：给出混合内容/私网访问诊断，并提示换 host 已自动尝试
        var httpsHint = (location.protocol === 'https:') ? (S.lang === 'en' ? '<br>HTTPS page → local HTTP may be blocked. Tried both 127.0.0.1 and localhost.' : '<br>当前是 HTTPS 页面，访问本地 HTTP 可能被拦截；已自动尝试 127.0.0.1 与 localhost。') : '';
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'Cannot reach engine: ' + (e.message) + httpsHint + '<br>Run GomokuEngine.exe first.' : '连不上引擎：' + (e.message) + httpsHint + '<br>请先双击运行「GomokuEngine.exe」；如仍不行，检查浏览器是否拦截本机请求。') + '</span>');
        return;
      }
      clearTimeout(abt);
      liveGen++; clearInterval(liveTimer);   // 终止实时轮询，后续由最终结果统一渲染
      var wasDeep = deepMode; deepMode = false;   // 深算完成（或失败）后退出深算模式
      if (data.error) { setStatus('<span style="color:#c0392b;">' + data.error + '</span>'); return; }

      // ====================================================================
      // 【颜色一致性硬校验】——用户最核心的要求：
      //   「用户选了白子，你给评估到黑子上了」绝对不允许发生。
      // 原理：引擎 eval 是【请求时行棋方视角】。若在「发出请求 → 收到响应」之间用户切换了
      //   我执颜色（或局面轮次变了），再拿「响应抵达时的 ourIsBlack」去换算就会算错颜色。
      // 做法：请求前快照 reqFp / reqOurIsBlack；响应回来先核对颜色指纹没变，
      //   变了就整包丢弃、立刻按新颜色重算 —— 宁可少显示一帧，也绝不显示反色数据。
      // ====================================================================
      if (reqFp !== fp || reqOurIsBlack !== ourIsBlack) {
        lastEngineFp = null; lastEngineAt = 0;      // 让下一轮立即重算（不被步调节流挡住）
        setStatus('<span style="color:#3b7dd8;">' +
          (S.lang === 'en' ? 'Color changed — re-analyzing for the newly picked side…'
                           : '我执颜色已切换——正在按<b>新颜色</b>重新分析…') + '</span>');
        scheduleNext();
        return;
      }
      var elapsed = Date.now() - t0;
      if (!S.timeUsedGame) S.timeUsedGame = 0;
      S.timeUsedGame += elapsed;
      noteEngineForbid(data, fp);   // 缓存引擎权威禁手列表（有禁手规则下自动落子必须避开）
      S.candCache = data.candidates || [];
      // ---- 评估值：解析 eval 成“我方分值 score(-1000..1000) + 判定 verdict”，并保留原始字符串 ----
      var sideToMoveIsBlack = toMoveIsBlack;
      var myIsSideToMove = (sideToMoveIsBlack === ourIsBlack);
      var evStr = (data.candidates[0] && data.candidates[0].eval);
      var es = evalToScore(evStr, myIsSideToMove);
      var score = es.score, verdict = es.verdict, matePly = es.matePly;
      // 引擎原始 eval 字符串（+M17 / +350 / -1200 …）：行棋方视角，仅内部留存
      S.rawEval = (typeof evStr === 'string' && evStr.length) ? evStr.trim() : '';
      // 显示用：归一到【我方视角】（评估值 + 评估曲线都是「我们执子」的评估）
      S.myEval = S.rawEval ? evalToMine(S.rawEval, myIsSideToMove) : '';
      // 盘面五连硬判断（不依赖引擎）：对方成 5 → 必败-1000；我方成 5 → 必胜+1000。
      // ★★ 本轮致命 bug 修复：「由负转正、且不在合理思维内」的根因 ★★
      //   旧写法 `var myColor0 = ourIsBlack === true ? 1 : 2` 用 ourIsBlack 反推我方颜色码。
      //   ourIsBlack 是 analyze() 顶部的局部变量（由 mySideMask() 推出），字面上等价于
      //   myColorCode()===1；但它**是另一个变量**，一旦这两条链路出现任何不一致
      //  （手动/自动颜色切换、异步 await 跨帧、状态残留），
      //   就会出现「我执白，却把对手的黑五连当成我方五连」→ maxLineLen(board, 1)>=5
      //   → verdict='win'、score=+1000 → 曲线末端由负猛然转正。
      //   现在**一律只用唯一事实来源 myColorCode()/oppColorCode()**（与面板「我执」按钮同源），
      //   并额外加一道自证日志：两者若不一致 → 以 myColorCode() 为准并打 [WARN]。
      //   【注】myColor0 / oppColor0 已在函数上方（【收官闸】之前）统一定义，此处只做一致性自证，
      //         不再重复 `var`（重复声明会把上方那份覆盖掉，正是「蓝圈/曲线跨帧错乱」的来源）。
      if ((myColor0 === 1) !== (ourIsBlack === true)) {
        diag('color source mismatch: myColorCode=' + myColor0 + ' ourIsBlack=' + ourIsBlack +
             ' — 以 myColorCode()（面板同源）为准');
      }
      // 任一方五连即终局：我方五连=胜(+1000)、对手五连=负(-1000)。
      // 先判对手（对手成五则我方必败，优先级更高），再判我方。
      if (maxLineLen(board, oppColor0) >= 5) { score = -1000; verdict = 'lose'; matePly = 1; }
      else if (maxLineLen(board, myColor0) >= 5) { score = 1000; verdict = 'win'; matePly = 1; }
      // 持久化：评估值 + 判定 + 原始 eval
      S.score = score; S.verdict = verdict; S.matePly = matePly;
      try { save(); } catch (e) {}
      // ---- 制胜手执行（盘面直接验证，不依赖引擎是否报 +M1）----
      // 轮到我方、盘上尚无我方五连、且存在“落一子立即成五”的空格 → 直接落子收官。
      // 这比等引擎报 M1 更可靠：短步时/评估波动时也能稳稳把第五子下完（“五子连珠下不完最后一子”的根治）。
      if (S.autoPlay && ourTurn && !haltForNewGame && Date.now() >= autoHaltUntil &&
          maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
        var renjuBlackWin = (S.rule === 2 && myColor0 === 1);   // 有禁手规则下黑方只许恰好五连（长连是禁手）
        var winCells = allImmediateFiveCells(board, myColor0, renjuBlackWin);
        // 有禁手规则：即使某空格落子后恰好成五，若同时构成双四/双三（罕见但存在：成五的同一手里
        // 另一方向也成四/活三）→ 引擎判定为禁手，落子即判负。这里用统一禁手查询再滤一遍。
        if (renjuBlackWin && winCells.length) {
          winCells = winCells.filter(function (wc) {
            return !isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0);
          });
        }
        if (winCells.length) {
          var winCell2 = null;
          // 优先引擎推荐格（若恰是制胜格）；否则取第一个可成五的空格
          if (data.best && data.best.length === 2) {
            for (var wb = 0; wb < winCells.length && !winCell2; wb++) {
              if (winCells[wb].i === data.best[0] && winCells[wb].j === data.best[1]) winCell2 = { i: data.best[0], j: data.best[1] };
            }
          }
          if (!winCell2) winCell2 = winCells[0];
          var fi2 = winCell2.i, fj2 = winCell2.j;
          if (board[fj2][fi2] !== 0) {
            // 读盘显示制胜格已被占（识别残留/误读）而引擎仍判必胜 → 我方读盘与引擎矛盾：
            // 强制整盘重扫，绝不就近乱落（乱落永远成不了五，正是“最后一子下不完”的元凶）
            pyBoardCache = null; cachedBoard = null; lastBoard = null; lastCount = 0; lastEngineFp = null;
            setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Win cell reads occupied — re-scanning board…' : '制胜格读数异常，强制重扫棋盘…') + '</span>');
            return;
          }
          if (playMove(cal, cv, fi2, fj2, toMoveIsBlack ? 1 : 2)) {
            S.candCache = data.candidates || [];
            renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
            lastEngineFp = fp;
            haltForNewGame = false;               // 等落子生效后，下一轮确认盘面五连再停
            setStatus(S.lang === 'en' ? 'Final move placed — win on board' : '已落制胜子，本局收官');
            drawChart();
            return;
          }
          // playMove 被遮挡/无法点击：playMove 已提示手动点推荐红点，本回合不再动作
          return;
        }
      }
      // ---- 【M1 停算闸】引擎给出 ±M1 即已分胜负 → 立刻停算，等下一局 ----
      // 用户明确要求：「评估到 ±M1 就不再进行评估，等待下一局」。
      // matePly === 1 表示正好 1 步成杀：此时无论是否我方轮次、无论是否制胜手块已落子，
      // 都不再请求引擎、不再刷新曲线/热力图/对手圈，只保留最终判定。
      if (matePly === 1) {
        // ★【+M1 收官补完（用户要求：评估完成后额外自动下完最后一个子，此过程不评估）★】
        //   评估到我方必胜(+M1)且轮到我方 → 直接落下制胜子完成五连，不再请求引擎。
        //   为什么必须放在停算闸内部：早前的【收官闸】虽更靠前，但可能因 autoHaltUntil
        //   未到 / playMove 偶发失败而错过这一轮；若此处只停算不落子，haltForNewGame
        //   会把后面所有落子链路全部封死 → 「+M1 已锁定却永远不下最后一子」（截图场景）。
        //   落子成功后解除 m1 停算，下一轮由【终局权威闸】确认盘面五连 → 持久化锁 + 曲线封口。
        if (verdict === 'win' && ourTurn && Date.now() >= autoHaltUntil &&
            maxLineLen(board, myColor0) < 5 && maxLineLen(board, oppColor0) < 5) {
          var m1WinCells = allImmediateFiveCells(board, myColor0, (S.rule === 2 && myColor0 === 1));
          if (S.rule === 2 && myColor0 === 1 && m1WinCells.length) {
            m1WinCells = m1WinCells.filter(function (wc) {
              return !isForbiddenPoint(board, wc.i, wc.j, S.rule, myColor0);
            });
          }
          var m1Cell = null;
          // 优先引擎推荐的制胜格（+M1 的 best 正是成五点）；否则取第一个成五空格
          if (data.best && data.best.length === 2) {
            for (var mw = 0; mw < m1WinCells.length && !m1Cell; mw++) {
              if (m1WinCells[mw].i === data.best[0] && m1WinCells[mw].j === data.best[1]) m1Cell = { i: data.best[0], j: data.best[1] };
            }
          }
          if (!m1Cell && m1WinCells.length) m1Cell = m1WinCells[0];
          if (m1Cell && board[m1Cell.j] && board[m1Cell.j][m1Cell.i] === 0 &&
              playMove(cal, cv, m1Cell.i, m1Cell.j, myColor0)) {
            S.candCache = data.candidates || [];
            renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
            lastEngineFp = fp;
            haltForNewGame = false; haltReason = '';   // 等落子生效后，下一轮确认盘面五连再彻底停算
            setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
              ? '+M1 locked — final move placed, five in a row (evaluation stopped)'
              : '已按 +M1 判定自动落下制胜子——<b>五子连珠</b>，本局收官（不再评估）') + '</span>');
            drawChart();
            return;
          }
        }
        S.candCache = data.candidates || [];
        renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
        lastEngineFp = fp;
        haltForNewGame = true;
        haltReason = 'm1';
        saveHistory();
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
          ? (verdict === 'win' ? 'I WIN (+M1) — stopped, waiting for next game…' : 'I LOSE (-M1) — stopped, waiting for next game…')
          : (verdict === 'win' ? '我方已胜（+M1）——已停止评估，等待下一局…' : '我方已败（-M1）——已停止评估，等待下一局…')) + '</span>');
        drawChart();
        return;
      }
      // 兜底：matePly>1 但盘面已经出现对方五连（读盘直接确认胜负）→ 同样停算
      if (maxLineLen(board, oppColor0) >= 5 || maxLineLen(board, myColor0) >= 5) {
        S.candCache = data.candidates || [];
        renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
        lastEngineFp = fp;
        haltForNewGame = true;
        haltReason = (maxLineLen(board, myColor0) >= 5) ? 'five-my' : 'five-opp';
        setGameOverLock(haltReason);
        saveHistory();
        setStatus('<span style="color:#c0392b;">' + (S.lang === 'en'
          ? (maxLineLen(board, myColor0) >= 5 ? 'Five in a row — I WIN, waiting for next game…' : 'Five in a row — I LOSE, waiting for next game…')
          : (maxLineLen(board, myColor0) >= 5 ? '已五子连珠——我方获胜，等待下一局…' : '已五子连珠——我方落败，等待下一局…')) + '</span>');
        drawChart();
        return;
      }
      renderResult(cal, cv, S.candCache, data.best, elapsed, score, verdict, true, board, toMoveIsBlack === ourIsBlack);
      // ---- 自动落子：先做【开局锚点守卫】，避免落入 Rapfi 浅搜远点（白/黑子“落点非常偏”）----
      // 禁手闸与近石校验已内聚进 autoAnchorPick（forbidColor=autoColor 时自动绕开禁手点）。
      if (S.autoPlay && ourTurn && Date.now() >= autoHaltUntil) {
        var autoColor = toMoveIsBlack ? 1 : 2;
        // 传入本次主搜索的实际预算：自动落子时 moveTurnMs = max(effTurn,2500) ≥ 2500 → 深搜尊重引擎
        var am = autoAnchorPick(board, data, S.candCache, autoColor,
                                { budgetMs: (typeof moveTurnMs === 'number') ? moveTurnMs : (S.turnMs || 5000) });
        if (am) {
          var bx = am[0], by = am[1];
          // 兜底：目标格被识别残留/对方提前占用时就近找空格落，保证自动落子持续推进
          if (board[by][bx] !== 0) { var nb = nearestEmpty(board, bx, by); if (nb) { bx = nb.i; by = nb.j; } }
          if (bx >= 0 && by >= 0 && board[by][bx] === 0) playMove(cal, cv, bx, by, toMoveIsBlack ? 1 : 2);
        }
      }
      // 热力图/对手评估开启时：主分析（topN=1 深搜索）完成后，追加短预算 topN=8 补充搜索取候选，
      // 刷新热力图/对手虚线圆显示；不影响落子、评估与自动落子（以主分析结果为准）。
      // 【关键时序】_rcP 必须等待完成后才 scheduleNext：否则下一轮主分析立即启动，与补充搜索
      // 并发竞争引擎（串行队列）→ 补充搜索排队超时 abort → 热力图只剩主分析 1 档（“其他颜色
      // 没出现”）+ 对手圈无数据（“对手评估不显示”）——这正是此前“改了跟没改一样”的根因。
      var _rcP = null;
      if ((S.heatmap || S.oppMoves) && !haltForNewGame && data.candidates && data.candidates.length) {
        var _mainC0 = S.candCache && S.candCache[0] ? S.candCache[0] : null;
        // 对齐目标兜底：data.best 偶发缺失/非法时退回主分析候选[0]，保证补充搜索的首候选
        //（热力图“最佳”档位 + 状态栏“推荐”）始终与主分析推荐同格——否则 best 丢失时补充搜索
        // 候选按浅搜自排，热力图最佳档会与“推荐”错位（“落点标记坐标错误”）。
        var bestAlign = (data.best && data.best.length === 2 && data.best[0] >= 0 && data.best[1] >= 0) ? data.best
          : (data.candidates[0] ? [data.candidates[0].x, data.candidates[0].y] : null);
        _rcP = refreshOverlayCands(cal, cv, board, fp, bestAlign, _mainC0);
      }
    } finally {
      S.analyzing = false;
      // 【双通道并行（本轮）】补充搜索/对手评估走独立 sub 通道，与下一轮主分析（main 通道）不再竞争，
      // 因此无需等待 _rcP —— 主搜索立即进入下一轮，副评估在 sub 通道同时进行（主线不被副线拖慢 = 棋力提升）。
      // （旧时序依赖「引擎单实例串行」：必须等 _rcP 完成才 scheduleNext，否则补充搜索排队超时 →
      //   热力图只剩 1 档 / 对手圈不显示。现两通道各自独立实例与串行链，该顾虑已消除。）
      runOppEval();
      scheduleNext();
    }
  }

  // ---------- 先后手 / 落子状态机辅助函数 ----------
  function sideOfMyStone(color) { return (color === 1) ? 0 : 1; }   // 我方刚落子颜色 → 我执（黑/白）
  function sideOfOppStone(color) { return (color === 2) ? 0 : 1; }  // 对方刚落下子颜色 → 反推我执
  function coordText(i, j) { return String.fromCharCode(65 + i) + (N - j); }
  // 交点 → 页面坐标（合成事件用；兼容 iframe / 截屏模式）
  function coordFor(cal, cv, i, j) {
    var frameWin = cal.frameWin || window, x, y;
    if (cal.isScreen) { x = cal.clientX0 + i * cal.stepX; y = cal.clientY0 + j * cal.stepY; }
    else {
      var topR = cal.topRect || cv.getBoundingClientRect();
      var scX = topR.width / cv.width, scY = topR.height / cv.height;
      var docR = cal.docRect || topR;
      x = docR.left + (cal.x0 + i * cal.stepX) * scX;
      y = docR.top + (cal.y0 + j * cal.stepY) * scY;
    }
    return { cal: cal, cv: cv, x: x, y: y, pageX: (frameWin.scrollX || 0) + x, pageY: (frameWin.scrollY || 0) + y, frameWin: frameWin, blocked: !!(cal.isScreen && cal.mode !== 'tab') };
  }
  // 落一手：合成事件点击 + 登记待确认。返回 true=已派发点击；false=被遮挡/无法点击（调用方可据此不误报成功）
  function playMove(cal, cv, i, j, color) {
    var pt = coordFor(cal, cv, i, j);
    if (pt.blocked) { setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Board in another window - click the red dot manually' : '棋盘在其他窗口，请手动点击推荐的红点') + '</span>'); return false; }
    var atPoint = pt.frameWin.document.elementFromPoint(pt.x, pt.y);
    if (atPoint) {
      var pid = atPoint.id || '', pcls = (typeof atPoint.className === 'string') ? atPoint.className : '';
      if (pid === '__gb_adjbox' || pid === '__gb_panel' || pcls.indexOf('__gb_') === 0) {
        if (pid !== '__gb_adjbox') {
          // 落点被本面板盖住：把面板自动挪到对侧角落再重试（不跳过推荐手/制胜手，避免“最后一子下不下去”）
          var pan = document.getElementById('__gb_panel');
          if (pan) {
            var pr = pan.getBoundingClientRect();
            var iw = pt.frameWin.innerWidth || window.innerWidth;
            pan.style.left = (pt.x > iw / 2 ? 8 : Math.max(8, iw - pr.width - 8)) + 'px';
            pan.style.top = '8px';
          }
          atPoint = pt.frameWin.document.elementFromPoint(pt.x, pt.y);
          pid = atPoint ? (atPoint.id || '') : '';
          pcls = atPoint ? ((typeof atPoint.className === 'string') ? atPoint.className : '') : '';
        }
        if (pid === '__gb_adjbox' || pid === '__gb_panel' || pcls.indexOf('__gb_') === 0) { setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Point covered by panel - click the red dot manually' : '落子点被面板覆盖，自动落子已跳过——请手动点击推荐的红点') + '</span>'); return false; }
      }
    }
    panelClickFlag = true;
    syntheticClick(cal, cv, i, j, pt.x, pt.y, pt.pageX, pt.pageY, pt.frameWin);
    setTimeout(function () { panelClickFlag = false; }, 400);
    pendingClick = { cal: cal, cv: cv, i: i, j: j, color: color, pt: pt, since: Date.now(), retries: 0 };
    setStatus(S.lang === 'en' ? 'Auto-move ' + coordText(i, j) + '…' : '自动落子 ' + coordText(i, j) + '…');
    return true;
  }
  // 落子未确认时重发一次点击
  function redispatchPending(p) {
    panelClickFlag = true;
    syntheticClick(p.cal, p.cv, p.i, p.j, p.pt.x, p.pt.y, p.pt.pageX, p.pt.pageY, p.pt.frameWin);
    setTimeout(function () { panelClickFlag = false; }, 400);
  }
  // 最近一次用户手动点击所在棋盘格（用于非自动模式下识别我方先后手）
  function recentUserCell(cal, cv) {
    if (!lastUserClick || (Date.now() - lastUserClick.t) > 4000) return null;
    var topR = cal.topRect || cv.getBoundingClientRect();
    if (lastUserClick.x < topR.left - 2 || lastUserClick.x > topR.left + topR.width + 2 || lastUserClick.y < topR.top - 2 || lastUserClick.y > topR.top + topR.height + 2) return null;
    var ccx, ccy;
    if (cal.isScreen) { ccx = lastUserClick.x; ccy = lastUserClick.y; }
    else { var scX = topR.width / cv.width, scY = topR.height / cv.height; ccx = (lastUserClick.x - topR.left) / scX; ccy = (lastUserClick.y - topR.top) / scY; }
    var i = Math.round((ccx - cal.x0) / cal.stepX), j = Math.round((ccy - cal.y0) / cal.stepY);
    if (i < 0 || i >= N || j < 0 || j >= N) return null;
    return { i: i, j: j };
  }

  // myIsSideToMove：本次候选所属盘面的行棋方是否为我方。引擎 eval 是行棋方视角，
  // 热力图分档必须换算成我方视角（见 candScoreOf）。不传时按“我方走棋”处理（与历史一致）。
  //
  // 【评估曲线 / 评估栏 的数据契约（形态参考 gomocalc，视角按本项目要求改为「我方视角」）】
  // gomocalc app.js 参考代码（已反查其官方 bundle 确认）：
  //   · 曲线入点：var n = +t.outputs.pv[0].eval;
  //               isNaN(n) || t.evalData.push({ index: t.position.length, eval: n, piece: ... });
  //   · 评估栏：  i("td",{...},[e._v(e._s(e.outputs.pv[0].eval))])
  //   · 曲线种子：evalData: [{index:0,eval:0,piece:黑}, {index:0,eval:0,piece:白}]
  // 本项目在其形态上做了两处【有意的偏离】，均由用户明确要求驱动：
  //   △1 视角：gomocalc 原样打印行棋方视角的 eval；本项目一律换算成【我方视角】(evalToMine)。
  //   △2 入点：gomocalc 对 M/-M 直接跳过不入点；本项目【每一手都要有点】，M 归一到 ±1000。
  // 由此得到两条铁律，本项目一律遵守：
  //   ① 评估栏 / 状态栏显示【我方视角】的 eval（evalToMine 只翻符号、不动量级：
  //      +M17 就是 +M17，不是 +638；轮对手走时引擎的 +350 必须显示成 -350，因为那是对手的分）。
  //   ② 曲线一个元素 = 一手棋，按【真实手数】去重（同一手重复评估 → 覆盖，不新增点）。
  //
  // 【★★ 每一子都要有曲线映射（用户明确要求：gomocalc 做得好的那一点）★★】
  //   早期版本照抄 gomocalc 的 `isNaN(n) || push(...)`：只有纯数值才入点，
  //   +M1 / -M3 这类杀棋标记 Number() 为 NaN → 【整手不入点】。后果正是用户反复反馈的：
  //     · 中局一出现杀棋，曲线直接断一截；
  //     · 最致命：终局那一手必定是 ±M1 → 永远画不上曲线 → “下完最后一手曲线没反应”。
  //   现在改为：M / -M 按【我方视角】归一到 ±1000 入点（见 evalToScore），
  //   保证「从第一手到 ±M1 那一手，盘上每一子在曲线上都有且仅有一个点」。
  //   曲线 Y 值与面板「评估」栏用的是同一套「我方视角」换算，两者永远同号、语义一致。
  // 曲线入点：一手棋 = 一个点。同一手（同一手数）重复评估 → 覆盖刷新，不新增点（动态曲线）。
  function pushHistPoint(ply, value) {
    var v = Math.max(-1000, Math.min(1000, value));
    var lastP = S.history.length ? S.history[S.history.length - 1] : null;
    if (lastP && lastP.i === ply) { lastP.v = v; return; }
    S.history.push({ i: ply, v: v });
    if (S.history.length > 400) S.history.shift();
  }
  function renderResult(cal, cv, cands, best, elapsed, score, verdict, fresh, board, myIsSideToMove) {
    drawOverlay(cal, cv, cands, best, board, myIsSideToMove);
    var c0 = cands[0];
    if (c0) {
      if (score == null) score = S.score || 0;
      if (verdict == null) verdict = S.verdict || 'none';
      if (fresh !== false && !haltForNewGame) {
        // ★ 注意 `!haltForNewGame`（本轮新增）：一旦进入「胜负已定·停止评估」状态
        //   （matePly===1 / 盘面五连专属闸 / 引擎停算闸任一触发），就【绝不再往曲线追加点】。
        //   之前只有 matePly===1 与盘面五连两个闸各自 return，但 renderResult 仍可能被
        //   其它路径以 fresh=true 调用（例如收官闸落子后的回调、延迟到达的引擎响应），
        //   于是曲线在五连之后又长出了新点 —— 用户看到的「-1000 拉了一长条平线还在延伸」。
        //   把守卫收口在这里，从数据层保证：停止评估 = 曲线封口。
        // 【曲线入点：每一手都要有映射】数值 eval 直接用；M/-M 归一到 ±1000（不再整手跳过）。
        var rawEv = (typeof c0.eval === 'string') ? c0.eval.trim() : c0.eval;
        var plyNow = (S.moves && S.moves.length) ? S.moves.length : 0;   // 真实手数 = 盘上棋子数
        var esv = evalToScore(rawEv, myIsSideToMove);
        var pv = null;
        if (esv.valid) pv = esv.score;                    // 数值 / M 值 → 已换算成我方视角
        // 终局（±M1 或盘面五连）以终判为准，不受引擎 eval 字符串解析失败的干扰
        if (pv == null && S.matePly === 1) pv = (S.verdict === 'lose') ? -1000 : (S.verdict === 'win' ? 1000 : null);
        if (pv == null && verdict === 'win') pv = 1000;
        if (pv == null && verdict === 'lose') pv = -1000;
        if (pv != null) pushHistPoint(plyNow, pv);
        S.score = score; S.verdict = verdict;
        S.rawEval = (typeof rawEv === 'string' && rawEv.length) ? rawEv : '';
        S.myEval = S.rawEval ? evalToMine(S.rawEval, myIsSideToMove) : '';
        saveHistory();
      }
      var coord = String.fromCharCode(65 + c0.x) + (N - c0.y);
      // 【状态栏评估文本】与面板一致：我方视角的 eval 串。
      var dispEv = (typeof S.myEval === 'string' && S.myEval.length) ? S.myEval
                 : ((typeof S.rawEval === 'string' && S.rawEval.length) ? S.rawEval : '-');
      var vColor;
      var vLabel;
      if (verdict === 'win') { vColor = '#3b7dd8'; vLabel = S.lang==='en'?'I WIN (M)':'我方必胜'; }
      else if (verdict === 'lose') { vColor = '#e74c3c'; vLabel = S.lang==='en'?'I LOSE (-M)':'我方必败'; }
      else if (score < -300) { vColor = '#e67e22'; vLabel = S.lang==='en'?'Bad':'大劣'; }
      else if (score > 300) { vColor = '#2e7d32'; vLabel = S.lang==='en'?'Good':'优势'; }
      else { vColor = '#7f8c8d'; vLabel = S.lang==='en'?'Even':'均势'; }
      // 先后手一律显示（手动锁定 / 自动识别 / 待定），旧版只在自动模式下显示，
      // 用户手动选白后状态栏完全没有反馈，无法核对系统到底按哪一方在评估。
      var sideTxt = sideStatusText();
      var recLab = S.lang === 'en' ? 'Move' : '推荐';
      var evLab = S.lang === 'en' ? 'eval' : '评估';
      setStatus(
        recLab + ' <b style="color:#e53935">' + coord + '</b>　' + evLab + ' <b style="color:' + vColor + '">' + dispEv + '</b> <b style="color:' + vColor + '">(' + vLabel + ')</b>' + sideTxt
      );
      setStatPanel(c0, elapsed);
      S.lastStat = { c0: c0, elapsed: elapsed };
      drawChart();
    } else {
      setStatus('<span style="color:#c0392b;">' + (S.lang === 'en' ? 'No recommendation (game may be over, or waiting for opponent).' : '未得到推荐（棋局可能已结束，或等待对手应手）') + '</span>');
    }
  }

  // 自动落子：只用页面内合成事件（touch/pointer/mouse 全套），不使用系统级鼠标点击
  //（系统鼠标会移动真实光标并点击屏幕，容易干扰用户/造成卡死）
  // 视口(client)CSS坐标 -> 屏幕物理像素（交给 exe /api/click 做系统级真实鼠标点击）
  function viewportToScreenPhys(x, y) {
    var dpr = window.devicePixelRatio || 1;
    var chromeTop = window.outerHeight - window.innerHeight;
    var chromeLeft = Math.round((window.outerWidth - window.innerWidth) / 2);
    return [
      Math.round((window.screenX + chromeLeft + x) * dpr),
      Math.round((window.screenY + chromeTop + y) * dpr)
    ];
  }
  function pointBlockedByPanel(x, y) {
    var at = document.elementFromPoint(x, y);
    if (!at) return false;
    var id = at.id || '', cls = (typeof at.className === 'string') ? at.className : '';
    return id === '__gb_adjbox' || id === '__gb_panel' || cls.indexOf('__gb_') === 0;
  }
  async function doRealClick(x, y) {
    var sp = viewportToScreenPhys(x, y);
    try {
      var r = await fetch('http://127.0.0.1:8964/api/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: sp[0], y: sp[1] })
      });
      return !!r.ok;
    } catch (e) { return false; }
  }

  // 页面内合成事件（touch/pointer/mouse 全套），不移动系统鼠标
  function syntheticClick(cal, cv, i, j, x, y, sx, sy, frameWin) {
    frameWin = frameWin || window;
    var common = {
      bubbles: true, cancelable: true, composed: true, view: frameWin,
      clientX: x, clientY: y, pageX: sx, pageY: sy,
      screenX: (frameWin.screenX || 0) + x, screenY: (frameWin.screenY || 0) + y,
      button: 0, buttons: 1
    };
    var atPoint = frameWin.document.elementFromPoint(x, y);
    // 目标被面板/调节框/悬浮层挡住时，模拟点击到不了棋盘 → 跳过并提示手动点
    if (atPoint) {
      var apId = atPoint.id || '';
      var apCls = (typeof atPoint.className === 'string') ? atPoint.className : '';
      if (apId === '__gb_adjbox' || apId === '__gb_panel' || apCls.indexOf('__gb_') === 0) {
        setStatus('<span style="color:#e67e22;">' + (S.lang === 'en' ? 'Move point covered by panel - click the red dot manually' : '落子点被面板覆盖，自动落子已跳过——请手动点击推荐的红点') + '</span>');
        return;
      }
    }
    var target = (atPoint && atPoint !== document.documentElement) ? atPoint : cv;
    if (window.TouchEvent && window.Touch && typeof Touch === 'function') {
      try {
        var tch = new Touch({ identifier: 1, target: target, clientX: x, clientY: y, pageX: sx, pageY: sy });
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, composed: true, view: window, touches: [tch], targetTouches: [tch], changedTouches: [tch] }));
        target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, composed: true, view: window, touches: [], targetTouches: [], changedTouches: [tch] }));
      } catch (e) {}
    }
    if (window.PointerEvent) {
      var ptr = Object.assign({}, common, { pointerId: 1, pointerType: 'touch', isPrimary: true, pointercapture: true });
      target.dispatchEvent(new PointerEvent('pointerdown', ptr));
      target.dispatchEvent(new PointerEvent('pointerup', ptr));
    }
    target.dispatchEvent(new MouseEvent('mousedown', common));
    target.dispatchEvent(new MouseEvent('mouseup', common));
    target.dispatchEvent(new MouseEvent('click', common));
    if (target !== cv) {
      cv.dispatchEvent(new MouseEvent('click', common));
      if (window.PointerEvent) {
        var ptr2 = Object.assign({}, common, { pointerId: 2, pointerType: 'mouse', isPrimary: true });
        cv.dispatchEvent(new PointerEvent('pointerdown', ptr2));
        cv.dispatchEvent(new PointerEvent('pointerup', ptr2));
      }
    }
  }

document.getElementById('__gb_analyze').onclick = function () {
    // 分析：保留棋盘识别缓存，只强制引擎重算当前局面；结果回来后重绘评估曲线与上方四项参数(深度/评估/速度/节点)
    lastEngineFp = null; lastEngineAt = 0;
    setStatus(S.lang === 'en' ? 'Re-analyzing current board…' : '正在重新分析当前局面…');
    scheduleNext();
  };
  document.getElementById('__gb_deep').onclick = function () {
    // 深算：主分析预算提至 30s 深度计算当前局面（对标 gomocalc 手动深算）；
    // 热力图/对手圈补充搜索随之加深。深算中再点一次 → 取消深算，恢复常规预算立即重算。
    if (deepMode) {
      deepMode = false;
      lastEngineFp = null; lastEngineAt = 0;
      setStatus(S.lang === 'en' ? '<span style="color:#888;">Deep analyze cancelled — back to normal mode.</span>' : '<span style="color:#888;">已取消深算，恢复常规分析。</span>');
      scheduleNext();
      return;
    }
    deepMode = true;
    lastEngineFp = null; lastEngineAt = 0;
    setStatus(S.lang === 'en' ? '<span style="color:#A5B4FC;">Deep analyzing current board (≈30s)…</span>' : '<span style="color:#A5B4FC;">深度计算当前局面（约30秒）…</span>');
    scheduleNext();
  };
  document.getElementById('__gb_rec').onclick = function () {
    // 重新识别：整盘重扫 + 重新校准网格（自动识别先后手已取消，故【保留用户的手动选择】，
    // 否则每点一次都要重新选黑白，很烦；要换色直接再点一次当前色即可解除锁定）
    cachedBoard = null; pyBoardCache = null; screenBoard = null; lastScreenTry = 0; screenDenied = false; screenAutoOff = false; screenFails = 0; lastEngineFp = null; lastEngineAt = 0;
    S.userSide = -1; pendingClick = null; probeOpen = null; sideConflictCount = 0; sideLockUntil = 0;
    sideVote = { color: -1, n: 0 };
    try { save(); } catch (e) {}
    if (typeof paintSideBtns === 'function') paintSideBtns();
    setStatus('<span style="color:#3b7dd8;">' + (S.lang === 'en' ? 'Re-scan: re-detecting board (your manual color is kept)…' : '重新识别：重扫棋盘（<b>已保留</b>你手动选择的先后手）…') + '</span>');
    scheduleNext();
  };
  document.getElementById('__gb_adjust').onclick = startAdjust;

  // ---------- 轮询：状态机驱动，每 300ms 扫一次盘（不再被 lastFp 卡死） ----------
  function scheduleNext() {
    clearTimeout(window.__gbTo);
    window.__gbTo = setTimeout(analyze, 300);
  }
  // 滚动/缩放 → 棋盘视口几何变化 → 立即失效缓存并重扫
  function onLayoutChange() {
    if (adjustMode) return;
    cachedBoard = null; pyBoardCache = null; screenBoard = null; lastBoard = null; lastCount = 0;
    scheduleNext();
  }
  window.addEventListener('scroll', onLayoutChange, true);
  window.addEventListener('resize', onLayoutChange);
  // 跨网页/多标签稳定性：从其他标签切回本页时，后台节流期间局面可能已变多手，
  // 立即全盘重扫并重判轮次，避免差分/轮次状态与真实棋盘脱节
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && window.__gbPanel) {
      cachedBoard = null; pyBoardCache = null; screenBoard = null; lastBoard = null; lastCount = 0;
      scheduleNext();
    }
  });
  loadHistory();            // 刷新前回填评估曲线/判定/停算标记
  drawChart();
  applyHash();
  setStatus(S.lang === 'en' ? 'Ready · waiting for board changes' : '已就绪 · 等待棋盘变化自动分析');
  scheduleNext();
})();
