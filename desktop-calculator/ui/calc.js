/* ============================================================================
 * 五子棋计算器 —— 页面逻辑（左棋盘 / 右仪表盘）
 *
 * 同一套页面被**两个窗口**共用（宿主把 calc/ 目录映射给两个 WebView2）：
 *   · 主窗口   https://gbcalc.local/calc.html      人机 / 自由摆盘 + 仪表盘 + 历史；
 *   · 复盘窗口 https://gbcalc.local/calc.html?rv=1 **纯棋盘** + 一行复盘功能键（见 RV_MODE）。
 * 两者靠 body.rv 类（CSS）+ RV_MODE（JS）分流，缺一不可 —— 复盘窗里绝不会出现
 * 顶栏 / 左右仪表盘 / AI / 禁手规则，也从不向引擎发一个请求。
 *
 * 四条外部契约：
 *   ① 引擎  页面内 Worker（engine-ai.js）直接跑 rapfi wasm —— 无 :8964、无独立引擎进程
 *      （2026-09-19 架构改造；COOP/COEP 下 SAB 多线程，棋力与原 :8964 同源）
 *      → {candidates:[{x,y,eval,depth,speed,nodes,line}], best:[x,y]}
 *      （引擎由宿主 host.cpp 拉起，改核心数/哈希表时宿主会按新档位重启它）
 *      ★ 只有主窗口走这条路；复盘窗口一次都不发。
 *   ② 宿主 → 页面  window.chrome.webview.addEventListener('message')
 *      · {type:'host', cpu, threadsDefault, threadsMax}   本机核心档位
 *      · {type:'external', payload:"<json>"}              覆盖层「复盘」映射进来的棋盘
 *      · {type:'historyInbox', text:"<json>"}             识别器存档（书签端 POST :8972 / 桌面端落盘）
 *      · {type:'reviewData', record:{…}}                  复盘窗口：宿主投递要复盘的那一局
 *      · {type:'histTxt', text:"…"}                        宿主读到的历史 txt 全文（导入）
 *      · {type:'clip', text:"…"}                          宿主读到的系统剪贴板文本
 *   ③ 页面 → 宿主  postMessage({type:'engineConfig', threads, hashMB})  档位
 *      · {type:'openReview', record:{…}}  主窗口开/更新**复盘独立窗口**（宿主建第二个窗口）
 *      · {type:'closeReview'}             复盘窗口请求关闭自己
 *      · {type:'savePng', name:"…", data:"data:image/png;base64,…"}
 *        保存局面：宿主弹**系统「另存为」对话框**由用户挑路径（不再是默认下载目录）
 * ==========================================================================*/
'use strict';

window.__gbTop = true;   // 诊断标记：calc.js 顶层执行过（宿主 GB_TEST_DIAG 回读）

var N = 15;

// 是否跑在**复盘窗口**里（宿主把窗口导航到 calc.html?rv=1）。
// ★ 只认自己这一个参数：`?rv=1`。复盘窗的所有分支都挂在它上面。
var RV_MODE = /(?:^|[?&])rv=1(?:&|$)/.test(window.location.search || '');

// ★ 2026-09-21：识图窗口（宿主 GbCalcVis，calc.html?vis=1）。
//   左 = 图片面板（上传/截屏/翻页/识别），右 = 棋盘显示识别结果；
//   与复盘窗同款「不连 AI」：G.board 只作为识别结果的展示面，不发任何引擎请求。
var VIS_MODE = /(?:^|[?&])vis=1(?:&|$)/.test(window.location.search || '');

var HOST = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
// ★ 2026-09-19：在宿主消息回调里**同步** postMessage 会被 WebView2 整条丢掉
//   （与宿主侧 WebMessageReceived 里同步 post 会被丢是同一个坑）→ 回调期间 tellHost 走延迟。
//   回调之外一律同步（测试的 shim / 页面自己的事件处理器都依赖同步语义，别动）。
var tellHostDefer = false;
function tellHost(o) {
  if (!HOST) return;
  if (tellHostDefer) { setTimeout(function () { window.chrome.webview.postMessage(o); }, 0); return; }
  window.chrome.webview.postMessage(o);
}

// 端到端测试钩子用的一局固定棋：黑在 x=7 列连成五（y=7..11），白在 x=8 列陪四手。
// 宿主在 GB_TEST_OPEN_REVIEW=1 时会发 {type:'testOpenReview'}，页面据此走一遍
// 「开复盘窗口 → 投递这一局 → 复盘窗回执」的完整链路（见 tools/test-trainer-review.js）。
var TEST_RV_RECORD = {
  ts: 0, src: 'local', hist: true,      // hist=true：按「从历史打开」那条路走（要露出背诵/回顾键）
  moves: [[7, 7, 1], [8, 7, 2], [7, 8, 1], [8, 8, 2], [7, 9, 1],
          [8, 9, 2], [7, 10, 1], [8, 10, 2], [7, 11, 1]],
};

// ---------------------------------------------------------------- 文案
var I18N = {
  zh: {
    title: '五子棋练习器',
    setup: '对局设置', mode: '模式', side: 'AI 执子', level: '难度', turn: '思考时间',
    rule: '规则', cores: '核心数', hash: '哈希表', heat: 'AI视图',
    heatHint: 'AI 思考时只标出它准备下的那一点，落子即消失',
    coach: '指导视图', coachHint: '方形四色热力：AI 帮你算最佳落点，落子即消失',
    heatBest: '最佳', heatGood: '良好', heatFair: '一般', heatPoor: '劣势',
    // ★ 2026-09-20（用户要求）：原来这里是「我执 黑（先手）/白（后手）」+ 一个「AI 先手」勾选框。
    //   现在合并且换词：先后手那一栏直接说「黑先 / 白先」（黑先 = 我执黑、我开第一手；
    //   白先 = 我执白、AI 执黑开第一手），另加一行**纯展示**的「对局双方」（只写 用户 / AI，
    //   各带一个棋子色圆点，不出现「黑 / 白」二字）。
    // ★★ 2026-09-24（用户要求）：「先后手」二选一 → 两个**独立开关**「AI 执黑 / AI 执白」；
    //   两个都开 = AI 自打，两个都关 = 你自己下黑白双方。
    sideAiB: 'AI 执黑', sideAiW: 'AI 执白',
    // ★ 2026-09-24：纯训练器版不再带 WASM —— 本机不支持原生引擎（需 AVX2 以上）时给明确提示
    noNativeEngine: '本机不支持原生 AI 引擎（需要支持 AVX2 指令集的 CPU），AI 功能不可用',
    sideHintB: 'AI 执黑先走，你执白',
    sideHintW: 'AI 执白后走，你执黑（你开第一手）',
    sideHintBoth: 'AI 自打：黑白双方都由 AI 走，你只旁观 —— 棋盘正中那颗键就是开关键（❚❚ 停手 / ▶ 继续）',
    sideHintBothPlace: 'AI 自打已就绪，但「自由摆盘」是摆盘用的、不会自动走子 —— 切到「对弈」就自动下起来',
    spPause: '停手（暂停自动对弈）',
    spResume: '继续自动对弈',
    sideHintNone: '两个都不开：没有 AI，黑白双方都由你自己下',
    turnAiBoth: 'AI 自打 · 轮到{c}',
    turnYouBoth: '轮到你 · {c}（双方都你下）',
    showNum: '显示序号', showNumHint: '棋子上标出第几手',
    // ★ 三十三轮：后台预热；★ 2026-09-27 深夜（用户要求）：多引擎投票整块撤销 —— 单实例满线程才是智力上限
    // ★ 2026-09-28：preheatHint 整条删除（用户要求：关于后台预热的提示文字不要了）
    preheat: '后台预热',
    // ★ 2026-09-25（用户要求）：复盘窗的「序号」功能键 + 复盘键盘操控提示
    rvNum: '序号', rvNumHint: '在棋子上标出它是第几手',
    rvKeyHint: 'Ctrl+Z 上一手 · Ctrl+R 重来（回到开局）',
    preview: '预览框', previewHint: '鼠标悬停时显示的圆角方框',
    fwd: '前瞻',
    fwdIdle: '点「前瞻」，从当前残局自动推演到五子连珠',
    fwdRunning: '推演中… 已推 {k} 手',
    // ★ 十七/十八轮（用户要求）：首手预算封顶 12 秒；提示给出**首手预计秒数** + 全程区间；
    //   进攻方黑/白框改为**不可点的指示框**（自动判定：轮走方 / 算杀题面子多一方）。
    fwdEta: '计算中 · 首手预计 {d} 秒内给出（加强全局计算），全程预计 {a} 秒 ~ {b} 秒',
    anEta: '计算中… 预计 {s} 秒内给出',
    fwdDone: '已模拟推演到五子连珠（共 {n} 手）——引擎模拟线，非算杀必胜：悬浮代码预览、点击确定到那个局势',
    fwdCap: '推演停在 {n} 手：引擎这一步没给出可下的点（引擎模拟线，非算杀必胜；局面变了会自动重推）',
    fwdFull: '棋盘已铺满（共 {n} 手）仍未连五 —— 和棋（引擎模拟线，非算杀必胜）',
    fwdVcf: 'VCF 算杀成功：{n} 手连续冲四必胜（防守每手都被迫）——悬浮代码预览、点击确定',
    fwdVct: 'VCT 算杀成功：{n} 手连续威胁（冲四/活三）必胜——悬浮代码预览、点击确定',
    // ★ 七轮（用户要求）：命中/无解文案 —— 命中带「进攻方：xx棋」+ 序号奇偶说明；
    //   无解 = 弹窗与状态行同一句「当前局面，所选进攻方不存在……」
    fwdVcfHit: '找到VCF杀，共{n}手；进攻方：{c}（序号：奇数=进攻方落子，偶数=防守方落子）',
    fwdVctHit: '找到VCT杀，共{n}手；进攻方：{c}（序号：奇数=进攻方落子，偶数=防守方落子）',
    fwdVcfNone: '当前局面，{c}（所选进攻方）不存在VCF强制连续冲四杀棋',
    fwdVctNone: '当前局面，{c}（所选进攻方）不存在VCT强制连续冲四杀棋',
    fwdClear: '清除标记',
    // ★ 2026-09-25（用户要求）：「清除标记」泛化成「清掉计算评估里任意项目的棋盘标记」
    //   之后，给它一句统一的反馈文案（点完立刻知道生效了）。
    markCleared: '已清除棋盘上的所有分析标记（计算 / 多点分析 / 平衡一 / 平衡二 / 扫描防守 / 前瞻 · VCF · VCT）',
    vcxPopTitle: '算杀结果',
    fwdAtkAuto: '进攻方：自动 —— 轮走方（算杀题面按惯例 = 子多的一方）。黑/白框只是**指示框，不可点**',
    fwdAtkB: '进攻方：黑棋（自动判定）',
    fwdAtkW: '进攻方：白棋（自动判定）',
    // ★ 五轮（用户要求）：键名去掉「查找」二字；无解提示直说「没有」
    fwdFindVcf: 'VCF', fwdFindVct: 'VCT',
    fwdFindRun: '正在查找{k}……（多线程并行 + 迭代加深）',
    // ★ 十轮（用户要求）：算杀模式 = 边走边算 —— 开局分析 / 中途接手 / 走完没用上
    fwdProbing: '正在分析突破口：{r} ……（首次分析可能稍慢，随后逐手向前走；能接手就切进杀棋序列）',
    fwdVcxLater: '前瞻推进 {k} 手后，进攻方出现 {r} 杀（{n} 手）——已并入推演线，一路走到五连',
    fwdFiveNoVcx: '已五子连珠（共 {n} 手）—— 全程未出现{c}的 VCF / VCT 进攻可能，也未用到算杀（引擎推演线）',
    fwdBlack: '黑子', fwdWhite: '白子',
    fwdOk: '确定',
    fwdLegend: '进攻方指示框（不可点）：紫框 = 黑子，浅蓝框 = 白子；自动 = 轮走方（算杀题面 = 子多一方）',
    ten: '十打（叫 10 个候选点）',
    docTitle: '五子棋练习器 · Gomoku Trainer',
    dragCard: '按住标题栏可拖动换位；点击小横杠折叠 / 展开卡片',
    codeTip: '局面代码：小写列字母 + 行号，逐手拼接（与 gomocalc.com 同格式）',
    nMoves: '{n} 手',
    about: '关于', aboutClose: '关闭',
    aboutTip: '版本、使用方法、功能与开源许可',
    aboutGuide: '使用方法',
    aboutGuideList: [
      { t: '一、开始一盘棋', ps: [
        '顶部「对局设置」里选模式：对弈（AI 自动应答）/ 摆盘（自由摆子，AI 完全不参与）/ 残局（自己摆一个局面来研究）。',
        '「思考时间」= AI 每手思考多少秒（内部按毫秒交给引擎）；时间越长棋力越强，热力与指导视图的色档也随它变化。',
        '「AI 执子」是两个独立开关：只开「AI 执黑」→ 你执白；只开「AI 执白」→ 你执黑并开第一手；两个都开 → AI 与 AI 自打；两个都关 → 没有 AI，黑白双方都由你自己下。',
        '「后台预热」（默认关闭，勾选后走微小官方 ponder 档）：轮到你思考时，AI 沿自己上一搜的主变量线「向前多看一步」预测你要下的点，并替自己预搜好应手 —— 你落子命中预测就秒答，未命中置换表也是热的；引擎为单实例，吃满「核心数」里选的全部线程，算力集中一路 = 智力上限。',
        '棋盘上直接点击落子。中间那颗 ▶ / ❚❚ 键：空闲时点它 = 让 AI 立刻替当前行棋方算一手并落下；AI 正在思考时点它 = 暂停。',
        '「重新开始」先把当前这局自动存进历史再清盘；「保存局面」手动把当前盘面存入历史。',
      ]},
      { t: '二、残局模式（自己摆一个局面来研究）', ps: [
        '棋盘下方三个键：「确定」/「顺序摆盘」/「任意摆盘」。顺序摆盘 = 黑白轮流落子；任意摆盘 = 点开右边的圆角小框，选「黑子」或「白子」后可连续摆这一色，数量与顺序都不限（比如 30 个黑子 + 10 个白子）。',
        '选中「黑子」键变浅紫、「白子」键变浅白蓝，一眼看得出正在摆哪一色。',
        '摆好后点最左边的「确定」→ 残局定下来，键变浅绿并显示「已确定」；此后「重新开始」会回到这个局面，存进历史时它也是首帧。再点一次「已确定」即解除，可重新摆。',
        '残局模式下 AI 全程不参与（辅助一手、热力、指导视图都停摆），交换手类规则自动变灰 —— 摆盘研究不需要换先。',
      ]},
      { t: '三、计算评估', ps: [
        '「计算」= 单路深搜当前局面并把最佳点标在棋盘上（再点一次 = 停止计算）；「多点分析」按「分析点数」一次给出 2~8 个候选，圆圈里是名次与评估分。',
        '「平衡一」= 在候选里挑评估最接近 0 的一手（最均衡）；「平衡二」= 先把候选逐个虚拟落子、再看对手的应手，挑最稳的一手；「扫描防守」= 在 9×9 邻域逐个空点打分，给出该防的点（W = 距赢几步，L = 距输几步），徽标颜色按危险度连续渐变 —— 越危险越红、安全的一头是青；点过一次后随落子**自动重扫**（Yixin 式动态刷新），「清除标记」或重开才停。',
        '「AI 视图」= AI 思考期间在棋盘上铺它的候选点（圆形、格内是评估分），AI 一落子就撤掉；「指导视图」= 轮到你时用方形四色提示最佳落点，你一落子就消失。',
        '「分析计算」= 棋盘下方的开关型功能键：开启后在**主车道**持续深算当前局面，铺出引擎当前榜单（最佳点+候选，最多 8 个）；随搜索加深自然微变并收敛，用户落子 / 悔棋自动重开会话，仪表盘用时跨轮累加；再点一次 = 停止。摆盘 / 残局 / 双人手动对弈同样可用。',
        '「清除标记」与「计算」并排：一键擦掉**本卡里任意项目**留在棋盘上的标记 —— 计算 / 多点分析 / 平衡一 / 平衡二的徽标与评估分、扫描防守的百分比与 W/L 徽标，以及前瞻 · VCF · VCT 的序号、虚线与代码链；只清标记，不动局面本身。',
        '仪表盘同步给出深度、速度、节点、用时与评估分；下方评估曲线按黑 / 白两条记录整局走势（纵轴随分数自动进位）。',
      ]},
      { t: '四、前瞻 / VCF / VCT', ps: [
        '「前瞻」从当前局面逐手推演，一路走到盘面真的五子连珠才结束 —— 不凭引擎的胜负判断提前定性（最坏情况是铺满棋盘判和）。第一手会加强全局计算来找突破口，提示栏同时给出预计耗时区间。',
        '「VCF」= 连续冲四必胜搜索；「VCT」= 冲四 + 活三连续威胁搜索。两者都跑本地算杀器（多线程并行 + 迭代加深），命中即给出必胜线；没命中会明确告知「所选进攻方不存在该强制杀」。选了 VCF / VCT 时边走边回探，一能接手就切进杀棋序列。',
        '点「黑子 / 白子」框 = 指定算杀的进攻方（进攻训练选己方色，防守预判选对手色），再点一下取消。',
        '推演子是半透明的：数字 = 第几手；悬浮代码链可预览到那一手，点击代码选中、「确定」把这一段落到棋盘（之后还能接着往下确定）。',
        '推演每一步都做必应校验：能连五就连五、对手只差一手成五就必堵、对手活三而自己无四则必应 —— 防守方不会白白送掉杀棋。',
      ]},
      { t: '五、复盘与历史', ps: [
        '「历史」抽屉列出保存的局面：单击选中（↑↓ 移动、Enter 打开），右键菜单可打开复盘 / 重命名 / 导出这一局 / 存入「保存历史」/ 删除；支持 Ctrl / Shift 多选与 txt 导入导出。',
        '顶栏「复盘」= 打开一个只有棋盘的独立窗口（不连 AI，也不参与主窗的其他功能）；从历史打开的一局可以用「背诵复盘 / 回顾复盘」逐手走。VC / 残局记录打开时以整盘为首帧，不必从第一手重放。',
      ]},
      { t: '六、识图（Gomoku Vision）', ps: [
        '「上传图片 / 截图」→ 选框自动贴住棋盘（并向外多留约棋盘 1/30 的余量，边缘棋子完整进图）→「识别」；结果同步成局面代码，可复制、也可载入练习。',
        '「修改」= 人工微调：交换黑白子（点一黑一白即互换）、删除棋子、补充黑子 / 白子；Ctrl+Z 撤销。',
        '「VC 模式」= 算杀题模式：黑白子数可以不等，补充黑 / 白子不限数量、删除棋子任意删，左侧提示栏逐条说明。载入练习后自动切成残局模式，只预设进攻方（子多的一方），算杀不会自动开 —— 点「VCF」或「VCT」由你自己决定。',
        '「裁剪」可在识别前先框选图片区域；每次上传的图片自动进「图片抽屉」（超过 150 张清最老），支持多选、删除与复制。',
      ]},
      { t: '七、规则与外观', ps: [
        '规则：自由局（无禁手）/ 长连不赢 / 连珠（三三、四四、长连禁手）/ 一手交换 / 山口 / 塔拉山口10；前瞻与算杀都跟随所选规则。交换类规则开局会弹小窗让你选先手或后手。',
        '「EN / 中」一键切换全界面语言（含识图截图框的按键与历史日期格式）；「颜色」打开调色窗（棋盘 / 页面底色 + 深浅主题 + 预制色）；右栏卡片可拖动换位、点小横杠折叠，布局自动记忆。',
      ]},
    ],
    aboutVer: '版本', aboutFeat: '功能', aboutOss: '开源组件', aboutLic: '许可',
    aboutUpdates: '最近更新',
    aboutUpdateList: [
      '智力回归：落子决策链撤除「浅模拟否决」与「历史众数覆盖」两层干扰 —— 引擎最佳点直接落子，只保留必应护栏（连五 / 堵五），原生引擎恢复满血棋力',
      '分析计算重做（gomocalc 式持续分析）：主车道满血持续深算、无时间窗口，最佳点随搜索加深自然微变并收敛；用时跨轮累加，落子 / 悔棋自动重开；摆盘 / 残局 / 双人手动同样可用',
      '摆棋评分下架：对局设置中的开关移除，盘面评估统一由「分析计算」接管（主车道深算取代 1 线程浅评分）',
      '引擎仪表盘实时化：任意计算（AI 落子 / 计算评估 / 多点分析 / 平衡 / 扫描防守 / 热力 / 前瞻 / 后台预热）期间，速度与节点**边算边跳**；标题栏状态胶囊改青 / 浅天蓝色系：青点脉冲 = 计算中（并标注正在算的项目），绿点 = 空闲',
      '推荐选点改用卡塔狗名次色：1 选蓝、2 选绿、3 选黄（4 橙、5 之后红）——不再与扫描防守的红黄青互相串色',
      '棋子数字随棋盘缩放：序号 / 评估分 / 各类徽标的字号不再有 14px 封顶，高分辨率最大化窗口下也清晰可读',
      '计算时间与思考时间对齐：计算评估放开 12 秒封顶（1.6× 思考时间）、前瞻首手加强计算放开 12 秒封顶（4× 思考时间），每一步推演本就随思考时间走',
      '后台预热（默认关闭，勾选开启）：对手思考时 AI 在后台持续预演你的应手 —— 落子后命中即秒答，未命中置换表也是热的，同样的时间能搜得更深',
      '多引擎投票已移除（算力集中一路 = 智力上限）：引擎为单实例、吃满「核心数」所选全部线程；裁决层只保留必应护栏（连五 / 堵五 / 活三）与引擎头名，选点更稳',
      '扫描防守配色升级：徽标与清单从五档名次色改为青→绿→黄→橙→红的连续渐变（%越高越红）',
      '识图强化：密集局面识别失败时按锁定网线整盘外推重建（不再 no-grid）；识别窗口向外扩约棋盘 1/30，边缘棋子读得更全',
      '「清除标记」搬家并泛化：键从「前瞻」框移到「计算评估」卡、与「计算」并排（各占半宽），一次点击可擦掉**任意项目**留下的棋盘标记（计算 / 多点分析 / 平衡一 / 平衡二 / 扫描防守 / 前瞻 · VCF · VCT）',
      '新增「残局」模式：顺序摆盘 / 任意摆盘（数量与顺序都不限），并用「确定」键把局面定下来 —— 重新开始回到它，存进历史时它就是首帧',
      '识图「VC 模式」放开：补充黑 / 白子不限数量、删除棋子任意删，左侧提示栏逐条说明',
      'VCF / VCT 标记精简：只留蓝色虚线杀路 + 五（深蓝双环）/ 四（天蓝方框），不再满盘花',
      '前瞻首手改为加强全局计算找突破口，首次预算从 ×6 降到 ×4；提示栏新增预计耗时区间（秒 ~ 秒）',
      '攻防算法修正：行棋方显式传给引擎（子数不均衡不再站到对面去算），并加必应校验 —— 连五优先、对手成五必堵、活三必应',
      'VC / 残局记录打开即以整盘为首帧，不必再从第一手重放；残局模式下交换手规则变灰',
      '三个模式键缩短为两字（对弈 / 摆盘 / 残局）；英文模式补齐「清除标记」等文案，历史日期随语言',
      '截图自动贴盘的外扩修正：改为向外扩约棋盘 1/30（原先扩到了框内侧，边缘棋子被压住）',
    ],
    aboutApp: '五子棋练习器 · Gomoku Trainer',
    aboutFeatList: [
      '三种模式：对弈（AI 执黑 / AI 执白可自由开关，两个都开即 AI 自打）/ 自由摆盘 / 残局（自摆局面 + 「确定」定盘，重新开始回到该局面）',
      '后台预热（微小官方 ponder）：对手思考时沿 AI 上一搜主变量线向前多看一步、预搜应手 —— 命中秒答，未命中置换表也热；引擎单实例吃满所选核心数，后手应招更稳',
      '前瞻推演：一路走到盘面真的五子连珠；VCF / VCT 本地算杀（多线程并行 + 迭代加深）',
      '计算评估：计算 / 清除标记 / 多点分析 / 平衡一 / 平衡二 / 扫描防守，另配 AI 视图与指导视图',
      '评估曲线：纵轴随分数动态进位，最大可到 ±1200；仪表盘给出深度 / 速度 / 节点 / 用时',
      '六种规则：自由局 / 长连不赢 / 连珠禁手 / 一手交换 / 山口 / 塔拉山口10',
      '识图：截图或上传自动贴盘识别，VC 算杀题模式，人工修改（换色 / 删子 / 补子 / 裁剪）与图片抽屉',
      '历史与复盘：txt 导入导出、重命名、右键菜单、独立复盘窗口（背诵 / 回顾，VC 记录整盘首帧）',
    ],
    aboutOssList: [
      ['Rapfi', '五子棋 / 连珠引擎内核（编译为 WebAssembly，随本软件分发）', 'GPL-3.0'],
      ['OpenCV', '棋盘与棋子识别（静态链入 GomokuVision.exe，不额外分发 DLL）', 'Apache-2.0'],
      ['Microsoft WebView2 Runtime', '桌面界面运行时（由 Windows / Edge 提供，本软件不分发）', '专有'],
    ],
    aboutOssNote: '说明：上表只列随本软件分发、或运行时必需的第三方组件。开发期用来对拍的脚本与其依赖（NumPy、Pillow 等）只在本机跑，不随本软件分发，因此不在此列。',
    aboutLicText: '本软件自身的界面与配套代码以 MIT 许可发布。棋力内核 Rapfi 以 GPL-3.0 发布，本软件以编译后的 WebAssembly（页面内 Worker）或独立进程的方式调用它，双方只通过消息与本地端口通信，不与其合并为同一作品；随本软件分发 Rapfi 时，须一并保留它的许可证与源码获取方式（可从其上游仓库 dhbloo/rapfi 取得对应源码）。识别所用的 OpenCV 以 Apache-2.0 静态链入 GomokuVision.exe。界面运行时 Microsoft WebView2 由 Windows / Edge 提供，按其自身条款使用，不随本软件分发。以上各组件的著作权与许可均归各自作者所有。',
    engine: '引擎仪表盘', depth: '深度', speed: '速度', nodes: '节点', time: '用时',
    calcOn: '计算中', calcIdle: '空闲',   // ★ 2026-09-27：仪表盘状态胶囊（是否在算一眼可见）
    // ★ 2026-09-27：live 状态胶囊里的功能名（「计算中 · ××」）
    tagAiMove: 'AI 落子', tagAssist: '辅助建议', tagHeat: '热力图', tagCoach: '教练',
tagDefend: '扫描防守', tagCalc: '计算评估', tagNbest: '多点分析',
    tagLiveAna: '分析计算', liveAna: '分析计算', liveAnaStop: '停止分析',
    btnAiside: 'AI 执子', btnSet: '设置', pinFix: '固定',
    pinFixTtl: '固定这张卡片：设置里开其它卡片时它不再被收起',
    pinCloseTtl: '取消固定并关闭这张卡片',
    aiSideB: 'AI 执黑', aiSideW: 'AI 执白', aiTurnLbl: '思考时间',
    tagBal1: '一手平衡', tagBal2: '二手平衡', tagFwd: '前瞻推演', tagPreheat: '后台预热', tagTen: '十打选点',
    eval: '评估', best: '最佳', curve: '评估曲线', blackCurve: '黑子', whiteCurve: '白子',
    // ★ 2026-09-19（用户要求）：「指导」卡片 —— AI 站在用户视角评价上一手。
    history: '历史', saved: '保存历史', openDrawer: '历史',
    saveSel: '保存选中', delSel: '删除', openSel: '打开', closeDr: '关闭',
    selAll: '全部选中', selNone: '取消全选',
    drTip: '勾选若干局，点「保存选中」→ 永久存入「保存历史」',
    // ★ 2026-09-19（用户要求）：「历史可以导出导入通过 txt 中的代码」「可以让用户自己更改某条
    //   历史的名字……右击鼠标可以有一个选择栏，里面有删除、重命名等功能」。
    drExp: '导出', drImp: '导入',
    ctxOpen: '打开复盘', ctxRename: '重命名', ctxExport: '导出这一局',
    ctxToSaved: '存入「保存历史」', ctxDel: '删除',
    namePh: '给这局起个名字',
    expNone: '没有可导出的历史',
    expOne: '已导出 1 局为 txt（在「另存为」里选路径）',
    expDone: '已导出 {n} 局为 txt（在「另存为」里选路径）',
    impDone: '已导入 {n} 局到历史',
    impNone: '这段文本里没有能识别的局面代码（每行形如 h8h9g7…）',
    impFail: '读取 txt 失败',
    renamed: '已重命名',
    code: '局面代码', copy: '复制', paste: '粘贴', load: '载入',
    copied: '局面代码已复制', codeLoaded: '局面代码已载入棋盘', clipEmpty: '剪贴板里没有文本',
    codeBad: '局面代码读不出来：形如 h8h9g7（小写列字母 + 行号，逐手拼接）',
    reset: '重新开始', redo: '重来',
    play: '播放', pause: '暂停',
    recite: '背诵复盘', replay: '回顾复盘', exit: '退出复盘',
    review: '复盘', prev: '上一步', next: '下一步', savePos: '保存局面',
    rotTtl: '整体棋子顺时针旋转 90°（坐标轴不动）', mirrorTtl: '翻转棋子布局',
    shiftTtl: '局面平移', shiftBtnTtl: '局面步进（整体平移一格）',
    mvFv: '左右', mvFh: '上下', mvD1: '╲', mvD2: '╱',
    mvFvT: '左右翻转', mvFhT: '上下翻转',
    mvD1T: '对角翻转（左上↔右下）', mvD2T: '对角翻转（右上↔左下）',
    mvUpT: '整体向上平移一格', mvDownT: '整体向下平移一格',
    mvLeftT: '整体向左平移一格', mvRightT: '整体向右平移一格', closeTtl: '关闭',
    layoutRV: '复盘模式下不能调整布局', layoutBusy: 'AI 思考中，请稍候再调整布局',
    shiftOOB: '有棋子会被移出棋盘，无法向该方向平移',
    posSaved: '局面已保存为 PNG 图片', posSaveFail: '局面保存失败',
    pause: '暂停', resume: '继续', assistHint: '点击：AI 辅助计算一次并落子一着',
    reciteHint: '背诵复盘：凭记忆把下一手落在棋盘上，错了会用粉红圈标出。',
    miss: '背错', turnBlack: '轮到黑棋', turnWhite: '轮到白棋',
    // ★ 2026-09-20（用户要求）：「AI……和用户……，分别显示 AI 与用户，不显示黑白」。
    //   人机模式下的状态药丸一律说「轮到你 / 轮到 AI」；自由摆盘（没有 AI 参与）才说黑/白。
    turnYou: '轮到你', turnAi: '轮到 AI',
    over: '对局结束', thinking: 'AI 思考中…', paused: '已暂停', youWin: '你赢了', youLose: 'AI 获胜',
    analyzing: '分析模式：不自动落子，只看候选与热力',
    modePlace: '自由摆盘',
    // ★ 2026-09-23（用户要求）：残局模式（对局设置 · 模式第三项）
    modeEndgame: '残局',
    egSeq: '顺序摆盘', egFree: '任意摆盘', egB: '黑子', egW: '白子',
    egFreeOn: '任意摆 {c}',
    egHint: '残局模式：AI 不参与，你摆什么它就是什么。「顺序摆盘」= 黑白轮流落子；「任意摆盘」= 弹出圆角小框选黑子或白子，选中一色后可在棋盘上连续摆放（不限数量、不限顺序，比如 30 黑 + 10 白）。摆好的盘面就是首帧，可直接保存到历史或开始研究。',
    // ★ 十六轮（用户要求）：残局「确定」键 —— 定下来之后「重新开始」回到这个局面，历史首帧也是它
    egOk: '确定', egOkOn: '已确定',
    egLockedHint: '残局已确定，已自动切到「摆盘」：「重新开始」会回到这个残局，存进历史时它就是首帧（历史里标 Endgame），背诵复盘也从残局开始。要重摆就回「残局」模式。',
    offline: 'AI 引擎还没就绪（首次启动要加载模型，几秒）。马上自动重试。',
    offlinePill: '引擎未连接 · 正在重试…',
    rvFree: '复盘 · 自由摆盘，不连 AI',
    // 复盘窗口（独立窗口，?rv=1）—— 用户要求「只有棋盘 + 几个复盘功能键，不参与任何功能连接」
    rvWindow: '复盘 · 纯棋盘',
    rvPure: '复盘 · 自己落子（没有 AI，也没有禁手/规则）',
    rvFromHist: '复盘 · 从历史打开的一局',
    // ★ 2026-09-19（用户要求）：这里原来还有一句「开复盘了」的状态提示文案，用户明确要求删掉 ——
    //   复盘窗自己会弹出来，主窗口不必再喊一句。（连 i18n 的键一起删了，不留死文案。）
    rvNothing: '棋盘还是空的：先在棋盘上摆几手，或去历史里挑一局',
    srcLocal: '本机', srcDesktop: '桌面', srcBookmark: '书签',
    theme: '深色', theme2: '浅色', themeCustom: '自定义',
    // ★ 2026-09-20（用户要求）：「把之前的深色改成颜色，点击颜色后会有一个弹窗……」→ 顶栏那个键
    //   变成**调色窗入口**，深浅主题两键搬进弹窗里；弹窗内还有调色盘 / RGB 滑条 / RGB 代码框。
    color: '颜色', cpClose: '关闭', cpReset: '恢复默认',
    cpTheme: '主题', cpTarget: '调色对象', cpBoard: '棋盘', cpPage: '背景',
    cpHex: 'RGB 代码', cpPreset: '预制色',
    cpHintB: '调的是棋盘底色；网格线、星位、坐标轴会自动跟着深浅变化',
    cpHintP: '调的是页面底色；卡片与文字会自动按明暗跟随',
    cpBad: '色值读不出来：要 #rrggbb，或 rgb(r,g,b)',
    // 「卡片」功能键（用户要求）：点它勾选显示在棋盘右边的面板
    cards: '卡片', cardsHint: '选择显示的面板',
    cardSideL: '左', cardSideR: '右',
    // 计算评估（用户要求：参考亦心棋盘 Rapfi 整合包那一套功能键）
    analysis: '计算评估',
    // ★ 2026-09-20 二轮（用户要求）：只留 多点分析 / 平衡一 / 平衡二 / 停止计算 ——
    //   「计算」与「扫描防守」下线（用户原话：那两个主要是给 AI 连珠用的）。
    anCalc: '计算', anStop: '停止计算', anDefend: '扫描防守',
    anNbest: '多点分析', anBal1: '平衡一', anBal2: '平衡二',
    anDefendDone: '扫 {c} 点：%越高越要防，W=距赢 L=距输',
    anDefendRefine: '精修中…第 {r}/{t} 轮',
    anDefendStable: '已收敛，结论稳定',
    // ★ 识图（2026-09-21）：顶栏「识图」键 + 独立识图窗口（?vis=1）的全部文案
    vis: '识图',
    visTitle: '识图 · 把棋盘图片变成局面',
    visTtl: '把棋盘图片变成局面',
    visHint: '支持一次选多张（至多 150 张）；白框里可直接 Ctrl+V 粘贴图片，截屏弹出三键选择',
    visUpload: '上传图片', visShot: '屏幕截图',
    // ★ 十二轮（用户要求）：图片裁剪
    visCrop: '裁剪', visCropTitle: '裁剪图片', visCropHint: '拖动鼠标框选要保留的区域',
    visCropReset: '重置', visCropCancel: '取消', visCropOk: '确定',
    visCropNone: '当前没有图片可裁剪 —— 先「上传图片」或「屏幕截图」',
    visCropSmall: '框选区域太小，请拖一个大一点的矩形',
    visCropDone: '已裁剪（{w} × {h}）', visCropFail: '裁剪失败，图片可能已损坏',
    visRec: '重新识别', visSave: '保存到历史', visLoad: '加载到练习',
    visShotBusy: '请选择截图方式（屏幕上弹窗）…',
    visShotFail: '截屏失败：屏幕上没有可截取的内容',
    visWorking: '识别中…',
    visBad: '暂时没识别出棋盘和棋子：图片可能太模糊、棋盘占图太小；换一张更清晰、棋盘更大的图片试试',
    visNoStones: '识别到了棋盘，但没有读出棋子：图片可能模糊，或棋子与棋盘对比度太低',
    visLowRes: '图片分辨率较低（{w}×{h}），识别可能不准确',
    visOk: '识别到 {b} 颗黑子、{w} 颗白子',
    visSuspect: '当前图片可能模糊，识别不准确，请人工核对；',
    visPartial: '当前棋盘可能不完整（残盘），已按棋子排布居中加载；',
    visNone: '先上传图片或截屏，再来识别',
    visSaved: '已保存到历史（主窗口「历史」里可见）',
    visLoaded: '已发送到练习窗口接着下',
    visName: '识图局面',
    visSrc: '识图',
    // ★ 2026-09-21（用户要求）：胶囊数字键 = 图片抽屉的入口；抽屉标题 / 提示 / 移除键
    visPillTip: '点这里打开图片抽屉（选一张 / 移除）',
    visDelTitle: '移除这张',
    visDrawerTtl: '图片',
    visDrawerClose: '收起抽屉',
    visVdTip: '点缩略图选中 · ✕ 移除 · 点空白上传',
    // ★ 2026-09-22（用户要求）：抽屉多选管理 + 「修改」功能
    visSel: '选择', visSelAll: '全选', visDelSel: '删除',
    visSelOn: '多选：开', visSelOff: '选择',
    visSelTip: '点选 = 勾选 · Ctrl+点 = 多选 · Shift+点 = 范围选 · Ctrl+A = 全选',
    visCopied: '已复制图片到剪贴板',
    visCopyFail: '复制失败：这张不是图片',
    // ★ 廿四轮（用户要求）：双击图片 = 用系统默认看图软件打开这张
    visOpenApp: '用系统看图软件打开',
    visOpenTip: '双击图片 = 用系统默认看图软件打开这一张',
    visNoSel: '先勾选图片（「选择」或 Ctrl+点缩略图）',
    visDelDone: '已删除 {n} 张图片',
    visEdit: '修改',
    veSwap: '交换黑白子', veDel: '删除棋子', veAdd: '添加黑白子',
    veAddB: '黑子开始', veAddW: '白子开始',
    veUndo: '撤销', veUndoNone: '没有可撤销的操作（每步落定后才能撤）',   // ★ 七轮：撤销 + Ctrl+Z
    visCountBad: '★ 黑白数异常（黑 {b} / 白 {w}）—— 已禁用「保存到历史 / 加载到练习」，请用「修改」修正后再试',   // ★ 八轮
    visVc: 'VC 模式', visVcTip: '算杀题模式：黑白子数不统一也可保存/加载（VCF/VCT 题面常见黑远多于白）；加载到练习后只预设进攻方，算杀由你点「VCF / VCT」自己开',   // ★ 十二轮
    visVcOn: 'VC 模式开：黑白子数不统一也可保存/加载；加载后请自己点「VCF」或「VCT」开始算杀（默认进攻方 = 子多一方）',
    visVcOff: 'VC 模式关：恢复黑白子数校验（黑=白 或 黑=白+1）',
    visVcPass: '★ VC 模式放行：黑 {b} / 白 {w}（子数不统一），可直接保存/加载',
    visVcArm: 'VC 模式已就绪：进攻方已预设为子数占优的一色 —— 点「VCF」或「VCT」开始算杀（不会自动开）',   // ★ 十二轮
    veSwapHint: '交换模式：点一颗黑子，再点一颗白子 → 这两子互换颜色；可连续交换，再点本键或按 Esc 退出',
    veSwapNext: '已选中 1 颗 —— 再点一颗对面颜色的子即互换',
    veSwapDone: '已互换 · 黑 {b} / 白 {w} · 可继续点选交换',
    veDelHint: '删除棋子：黑比白多一时可单删黑子，白与黑齐平时可单删白子；其余情况点对面颜色成对删',
    // ★ 2026-09-23（用户要求）：VC 模式编辑放开 —— 补充/删除都不限数量，左侧文字栏详细说明
    veDelVcHint: 'VC 模式 · 删除棋子：点击任意棋子**立即删除**，不限颜色、不限数量（撤销键可回退）',
    veFillVcHint: 'VC 模式 · 补子：点空点即落该色棋子，**不限数量**（黑子白子想补多少补多少，撤销键可回退）',
    visVcEditTip: 'VC 模式已开：黑白子数**不必相等**也可保存/加载；修改模式里「补充黑子 / 补充白子」**不限数量**、想补多少补多少，「删除棋子」**点哪删哪**（不再要求黑白数配平）。摆好的残局可保存到历史，打开即整盘首帧。',
    veDelPair: '这颗不能单删 —— 再点一颗**对面颜色**的子成对删除（再点它取消）',
    veDelDone: '已删除 {x} 处（黑 {b} / 白 {w}）',
    veGhost1: '已放预览{c}子 —— 再点一个空点放对面颜色',
    veGhost2: '再点任意空点 = 落定这一对并开始下一对；点棋盘外空白 = 只落定',
    veGhostB: '黑', veGhostW: '白',
    veAddBHint: '黑子开始：点空点放半透明黑子 → 再点空点放白子 → 点第三处/空白落定',
    veAddWHint: '白子开始：点空点放半透明白子 → 再点空点放黑子 → 点第三处/空白落定',
    veEdited: '已修改（黑 {b} / 白 {w}）· 可重新识别或直接加载到练习',
    veEditOn: '修改模式：右键棋盘也能弹出功能菜单',
    veEditOff: '已退出修改',
    veRightMenu: '右键菜单：选中后点这里的功能项',
    // ★ 三轮（用户要求）：补充黑子 / 补充白子 = 某色缺子时单补（一点一颗，受数量规则约束）
    veFillB: '补充黑子', veFillW: '补充白子',
    veFillBHint: '补充黑子：点击空交叉点，一点补一颗黑子（补到黑与白齐平或多一为止）',
    veFillWHint: '补充白子：点击空交叉点，一点补一颗白子（补到白与黑齐平为止）',
    veFillBFull: '黑子已不比白子少，不用再补黑子（可改用「删除棋子」或「补充白子」）',
    veFillWFull: '白子已与黑子齐平，不能再补白子（再补就比黑子多了）',
    // ★ 四轮（用户要求）：某方多 → 引导点对面补充键；键「缺谁亮谁」，齐平时禁另一边
    veFillGuideB: '白子比黑子多 {d} 颗 → 请点「补充黑子」补齐（一点补一颗）',
    veFillGuideW: '黑子比白子多 {d} 颗 → 请点「补充白子」补齐（一点补一颗）',
    // ★ 五轮（用户要求）：棋盘代码框（功能键与提示文字之间）；「自动吸附」键删除
    visCode: '棋盘代码',
    visCodeCopied: '棋盘代码已复制',
    // 计算对象（用户 / AI）：多点分析 / 平衡一 / 平衡二 按它决定算哪一方的最优
    nbest: '分析点数', nbestHint: '至多 8 点（引擎按局面给点，未必给满）',
    anIdle: '选一个功能键开始计算，结果会标在棋盘上',
    anRunning: '计算中…', anStopped: '已停止计算', anEmpty: '棋盘还是空的：先落几手再算',
    anDraft: '演算中…第 {r} 轮草稿',
    anDone: '第 {n} 手 · {ev} · 深度 {d}',
    anBest: '最佳', anBalance: '平衡',
    anBal1Done: '最均衡的一手：{ev}',
    anBal2Done: '两手后最均衡的一对：{ev}',
    anAfter: '两手后',
    guideYama: '黑1 → 白2 → 黑3', guideYamaEn: 'B1 → W2 → B3',
    guideSwap: '等待换色决定', guideSwapEn: 'awaiting swap',
    swapTtl: '交换完成 · 请选择你的先后手',
    swapFirst: '先手 · 执黑', swapSecond: '后手 · 执白',
    ruleName: {
      0: '无禁手', 1: '无禁手 · 长连不赢', 2: '连珠（有禁手）',
      5: '一手交换', 6: '山口规则（Yamaguchi）', 7: '塔拉山口规则（Taraguchi）',
    },
    ruleHint: {
      0: '无禁手：连成五子（含长连）即胜。最自由。',
      1: '标准：长连不算赢，必须正好五子。',
      2: '连珠：黑方有禁手（三三/四四/长连），白方无禁手。',
      5: '一手交换：黑下第 1 手后，白可选择是否与黑交换颜色。',
      6: '山口规则：黑方连摆 3 子（黑1白2黑3），对方选执黑/执白。',
      7: '塔拉山口10：黑1天元、白2限3×3、黑3限5×5、白4限7×7；第5手直接下（9×9）或十打叫10点由对方挑，随后对方选色。',
    },
    // ★ 2026-09-24（用户要求）：盘上有子时换规则**不清空棋盘** —— 状态行说明这件事
    ruleKept: '规则已切换为「{r}」：保留当前棋盘布局，直接按新规则继续（终局判定与禁手标记已重算）',
    // ★ 2026-09-25（用户澄清「禁手模式中，不能下的位置是红叉」）：点了红叉的说明
    fbBlocked: '禁手：黑方不能下在这里（三三 / 四四 / 长连）—— 盘上画红叉的点就是禁手点',
  },
  en: {
    title: 'Gomoku Trainer',
    setup: 'Game setup', mode: 'Mode', side: 'AI plays', level: 'Level', turn: 'Think time',
    rule: 'Rules', cores: 'Cores', hash: 'Hash', heat: 'AI view',
    heatHint: 'While the AI thinks, only its intended move is marked; clears on its move',
    coach: 'Coach view', coachHint: 'Square 4-colour heat: AI computes your best spots; clears on move',
    heatBest: 'Best', heatGood: 'Good', heatFair: 'Fair', heatPoor: 'Poor',
    // ★ 2026-09-20: 「先后手」两键 + 「对局双方」只列 用户 / AI（圆点表色，不写 black/white）
    sideAiB: 'AI plays Black', sideAiW: 'AI plays White',
    noNativeEngine: 'This machine does not support the native AI engine (a CPU with AVX2 is required); AI is unavailable',
    sideHintB: 'AI plays Black and opens; you play White',
    sideHintW: 'AI plays White; you play Black and open',
    sideHintBoth: 'AI vs AI: the AI plays both colours, you just watch - the centre button is the switch (stop / resume)',
    sideHintBothPlace: 'AI vs AI is armed, but the board-setup mode never moves on its own - switch to "Match" and it starts',
    spPause: 'Stop (pause AI self-play)',
    spResume: 'Resume AI self-play',
    sideHintNone: 'Both off: no AI — you play both colours yourself',
    turnAiBoth: 'AI vs AI · {c} to move',
    turnYouBoth: 'Your turn · {c} (both sides)',
    showNum: 'Move numbers', showNumHint: 'Mark each stone with its move number',
    // ★ Round 33: background pre-heat; ★ 2026-09-27: multi-engine voting removed (single instance full threads)
    preheat: 'Background',
    // ★ 2026-09-25: review-window "Numbers" toggle + review keyboard shortcuts
    rvNum: 'Numbers', rvNumHint: 'Mark each stone with its move number',
    rvKeyHint: 'Ctrl+Z previous · Ctrl+R restart',
    preview: 'Hover box', previewHint: 'Rounded box shown when hovering the board',
    fwd: 'Look-ahead',
    fwdIdle: 'Press "Look-ahead" to auto-play from this position to five-in-a-row',
    fwdRunning: 'Deriving… {k} moves',
    // ★ Round 17/18 (user request): first move capped at 12s; hint carries the first-move
    //   estimate plus the whole-run range; attacker frames are indicators (not clickable).
    fwdEta: 'Computing - first move within {d}s (deeper global search), whole run {a}s ~ {b}s',
    anEta: 'Computing… expect within {s}s',
    fwdDone: 'Simulated to five-in-a-row ({n} moves) - engine self-play line, not a forced mate: hover a code to preview, click to commit',
    fwdCap: 'Stopped at {n} moves: the engine gave no legal point here (engine self-play line, not a forced mate; re-derives when the position changes)',
    fwdFull: 'Board is full after {n} moves without a five - a draw (engine self-play line, not a forced mate)',
    fwdVcf: 'VCF solved: {n} forcing fours win (every defence is forced) - hover a code to preview, click to commit',
    fwdVct: 'VCT solved: {n} continuous threats (fours / open threes) win - hover a code to preview, click to commit',
    // ★ 七轮（用户要求）：hit text carries the attacker colour; miss = explicit "not exists" popup
    fwdVcfHit: 'VCF win found: {n} moves; attacker: {c} (odd numbers = attacker, even = defender)',
    fwdVctHit: 'VCT win found: {n} moves; attacker: {c} (odd numbers = attacker, even = defender)',
    fwdVcfNone: 'No VCF (forcing fours) win exists for {c} (the chosen attacker) in this position',
    fwdVctNone: 'No VCT (continuous threats) win exists for {c} (the chosen attacker) in this position',
    fwdClear: 'Clear marks',
    markCleared: 'Cleared every analysis mark on the board (Calculating / Multi-point / Balance 1 / Balance 2 / Scan def / Lookahead \u00b7 VCF \u00b7 VCT)',
    vcxPopTitle: 'Solver result',
    fwdAtkAuto: 'Attacker: auto - the side to move (mate puzzles: the majority side, as usual). The black/white frames are indicators only, not clickable',
    fwdAtkB: 'Attacker: Black (auto)',
    fwdAtkW: 'Attacker: White (auto)',
    fwdFindVcf: 'VCF', fwdFindVct: 'VCT',
    fwdFindRun: 'Searching {k}… (multi-worker + iterative deepening)',
    // ★ 十轮：kill mode = keep deriving while probing the solver every step
    fwdProbing: 'Analysing the breakthrough: {r} ... (the first pass may take a moment, then it walks on; it switches to the kill sequence as soon as one exists)',
    fwdVcxLater: 'After {k} moves the attacker has a {r} win ({n} moves) - merged into the line, running on to five in a row',
    fwdFiveNoVcx: 'Reached five in a row in {n} moves - no VCF / VCT attacking chance for {c} ever appeared (engine line throughout)',
    fwdBlack: 'Black', fwdWhite: 'White',
    fwdOk: 'Commit',
    fwdLegend: 'Attacker indicators (not clickable): purple = black, light blue = white; auto = side to move (majority side in mate puzzles)',
    ten: 'Ten-call (10 candidates)',
    docTitle: 'Gomoku Trainer',
    dragCard: 'Drag the title bar to move it; click the bar to fold / unfold the card',
    codeTip: 'Position code: lowercase column letter + row, moves concatenated (same format as gomocalc.com)',
    nMoves: '{n} moves',
    about: 'About', aboutClose: 'Close',
    aboutTip: 'Version, how to use, features and open-source licences',
    aboutGuide: 'How to Use',
    aboutGuideList: [
      { t: '1. Start a game', ps: [
        'Pick a mode in Game Setup: AI (the engine replies) / Free setup (you place stones, no AI at all) / Endgame (set up a position and study it).',
        'Thinking time = how many seconds the AI gets per move (sent to the engine in milliseconds). Longer time means a stronger move; the heat and coach views also widen with it.',
        'Two independent switches choose the AI sides: only "AI plays Black" -> you play White; only "AI plays White" -> you play Black and open the game; both on -> AI vs AI; both off -> no AI at all, you play both colours yourself.',
        '"Background warm-up" (on by default): while it is your turn to think, the AI keeps rehearsing your most likely moves in the background - it answers faster and searches deeper once you move. "Parallel engines" runs 1-3 Rapfi instances with different thread counts and hash sizes at the same time and picks the best move by thread-share-weighted voting - moves and every item in Evaluation share the same ballot box.',
        'Click the board to place a stone. The centre button: when idle it asks the AI to play one move for whoever is on turn; while the AI is thinking it pauses.',
        '"Restart" auto-saves the current game into History first, then clears the board; "Save" stores the position into History by hand.',
      ]},
      { t: '2. Endgame mode (set up a position and study it)', ps: [
        'Three keys appear under the board: Confirm / Sequential / Free colour. Sequential = black and white alternate; Free colour = open the rounded box, pick Black or White and keep placing that colour - any count, any order (e.g. 30 black + 10 white).',
        'The picked colour key lights up: Black turns light purple, White turns light blue-white.',
        'Press Confirm (leftmost) to lock the position in: the key turns light green and reads "Confirmed"; from then on Restart returns to this position, and it is the first frame when saved to History. Press it again to release and re-place.',
        'The AI never joins endgame mode (assist, heat and coach views are all off), and swap-style rules are greyed out - a set-up position needs no swap.',
      ]},
      { t: '3. Evaluation', ps: [
        '"Compute" deep-searches the position and marks the best point (press again to stop); "Multi-point" returns 2-8 candidates with rank and score in each badge.',
        '"Balanced 1" picks the candidate whose evaluation is closest to zero; "Balanced 2" plays each candidate out and reads the reply before choosing; "Defense scan" scores every empty point in a 9x9 neighbourhood (W = moves to a win, L = moves to a loss), with badge colours on a continuous gradient - the more dangerous, the redder; safe points stay cyan.',
        '"AI view" shows the AI candidates (circles with scores) only while it thinks, and clears the moment it moves; "Coach view" hints your best move in four colours and disappears as soon as you play.',
        '"Clear marks" sits next to "Compute": one press wipes whatever any card item left on the board - badges and scores from Compute / Multi-point / Balanced 1 / Balanced 2, the percentages and W/L badges of Defense scan, and the numbers, dashed lines and code chain of Look-ahead / VCF / VCT. It clears marks only, never the position.',
        'The dashboard shows depth, speed, nodes, time and evaluation; the curve below tracks the whole game for both colours (the axis rescales itself).',
      ]},
      { t: '4. Look-ahead / VCF / VCT', ps: [
        '"Look-ahead" derives move by move and only ends when a real five-in-a-row appears - it never stops early on the engine verdict (worst case: the board fills up as a draw). The first move gets a deeper global search to find the breakthrough, and the hint shows an expected duration range.',
        '"VCF" = continuous-four mate search; "VCT" = four + open-three threat search. Both run the local solver (multi-worker, iterative deepening): a hit gives a forced win line, a miss says plainly that no such forced mate exists. With VCF/VCT selected it re-probes at every step and switches into the kill sequence as soon as one exists.',
        'Click the Black / White badge to force the attacker (your colour for attack training, the opponent for defence drills); click again to cancel.',
        'Preview stones are translucent and numbered; hover the code chain to preview up to that move, click a code to select it, then OK commits that stretch onto the board.',
        'Every derived move passes a must-answer check: complete a five if one exists, block the opponent five, and answer an open three when you have no four of your own - the defence never hands you a free win.',
      ]},
      { t: '5. Review & history', ps: [
        'The History drawer lists saved positions: click to select (arrow keys move, Enter opens), right-click for open-review / rename / export / store into Saved / delete; Ctrl/Shift multi-select and txt import/export are supported.',
        'The "Review" button opens a separate board-only window (no AI, no other main-window features). A game opened from History can be walked through with "Recite" / "Replay". VC and endgame records open with the whole board as the first frame instead of replaying from move one.',
      ]},
      { t: '6. Vision (Gomoku Vision)', ps: [
        'Upload or screenshot - the frame snaps to the board automatically, leaving a ~1/30 board margin so edge stones stay inside - then Recognize; the result is mirrored into a board code you can copy or load into practice.',
        '"Edit" fine-tunes by hand: swap B/W (click one black + one white), remove stones, fill black/white; Ctrl+Z undoes.',
        '"VC Mode" = mate-puzzle mode: unbalanced black/white counts are allowed, filling is unlimited and removal is free, with every rule spelled out in the left hint bar. Loading into practice switches to Endgame and only presets the attacker (the majority side) - the mate search never starts by itself, you press VCF or VCT.',
        '"Crop" lets you frame the picture before recognition; every upload is auto-saved into the picture drawer (oldest dropped past 150), with multi-select, delete and copy.',
      ]},
      { t: '7. Rules & appearance', ps: [
        'Rules: free-style (no forbidden), overline does not win, Renju (double-three / double-four / overline forbidden), Swap-1, Yamaguchi and Taraguchi-10; look-ahead and mates follow the chosen rule. Swap-style rules open a small popup to pick first or second.',
        '"EN / 中" switches the whole UI (including the screenshot-box buttons and the date format in History); "Colour" opens the palette (board / page plus themes and presets); right-side cards can be dragged to reorder and folded with the dash, and the layout is remembered.',
      ]},
    ],
    aboutVer: 'Version', aboutFeat: 'Features', aboutOss: 'Open-source components', aboutLic: 'Licence',
    aboutUpdates: 'Recent updates',
    aboutUpdateList: [
      'Strength restored: the move-decision chain drops the shallow-simulation veto and the history-mode override - the engine best move is now played directly, keeping only the must-answer guard (win / block), so the native engine plays at full power again',
      'Live analysis rebuilt (gomocalc style): continuous full-lane deep search with no time window; the best point varies naturally with search depth and converges; elapsed time accumulates across rounds and the session restarts on every move; works in setup / endgame / two-player modes too',
      'Setup scores retired: the settings switch is removed - board evaluation is now handled entirely by the Live analysis button (full-lane deep search instead of a 1-thread shallow probe)',
      'Live engine dashboard: every calculation (AI move / Evaluate / Multi-point / Balanced / Defense scan / Heat map / Look-ahead / Preheat) now streams speed and node counts WHILE it runs - parallel lanes are summed so the total throughput of the vote is visible; a status pill on the card header pulses red while computing (naming the active item) and shows a green dot when idle',
      'Candidate colours now follow KataGo: 1st choice blue, 2nd green, 3rd yellow (4th orange, 5th+ red) - no more clashing with the defence scan palette',
      'Stone numbers scale with the board: move numbers, eval digits and all badge fonts no longer cap at 14px, so they stay readable on high-resolution maximised windows',
      'Compute budgets now match the thinking time: Evaluate drops its 12s cap (1.6x thinking time), the look-ahead opening search drops its 12s cap (4x thinking time); every look-ahead step already follows the setting',
      'Background warm-up (on by default): while you think, the AI keeps rehearsing your likely replies in the background - a hit answers instantly, and even a miss leaves the hash table warm so the same time budget searches deeper',
      'Parallel engines voting has been removed (all compute on one instance = peak strength): the engine runs as a single instance using every thread chosen in Core count; the decision layer keeps only the must-answer guard (win / block-five / open-four) and the engine top choice',
      'Defense scan colours upgraded: badges and the list now use a continuous cyan -> green -> yellow -> orange -> red gradient (the higher the %, the redder)',
      'Vision hardened: dense positions rebuild the whole grid by extrapolating the locked lines (no more no-grid); the capture window expands outward by ~1/30 of the board so edge stones are read fully',
      '"Clear marks" moved and generalised: it now sits next to "Compute" inside the Evaluation card, half width each, and one press wipes the board marks left by ANY card item (Compute / Multi-point / Balanced 1 / Balanced 2 / Defense scan / Look-ahead, VCF, VCT)',
      'New Endgame mode: sequential / free-colour placement (any count, any order) plus a Confirm key that locks the position in - Restart returns to it and it becomes the first frame in History',
      'Vision "VC Mode" relaxed: unlimited stone filling, free removal, with every rule spelled out in the left hint bar',
      'VCF / VCT markers simplified to a blue dashed kill line plus a deep-blue double ring (five) and a sky-blue square (four)',
      'Look-ahead first move now uses a deeper global search to find the breakthrough (budget lowered from x6 to x4), and the hint shows an expected duration range',
      'Play corrected: the side to move is now passed to the engine explicitly (unbalanced stone counts no longer make it play for the wrong side), plus a must-answer check - win first, block a five, answer an open three',
      'VC / endgame records open with the whole board as the first frame; swap-style rules are greyed out in endgame mode',
      'Mode buttons shortened to two characters; English mode fixed for "Clear marks" and other labels, History dates follow the language',
      'Auto-snap margin corrected: it now expands outward by ~1/30 of the board instead of inward, so edge stones stay inside the frame',
    ],
    aboutApp: 'Gomoku Trainer',
    aboutFeatList: [
      'Three modes: play the AI / free placement / endgame (set up a position and Confirm it; Restart returns to it)',
      'Background warm-up + parallel engines: keep computing while the opponent thinks; 1-3 engines with different threads / hash vote for the best move (moves and all annotations)',
      'Look-ahead that runs to a real five-in-a-row; local VCF / VCT mate solver (multi-worker, iterative deepening)',
      'Evaluation: Compute / Clear marks / Multi-point / Balanced 1 / Balanced 2 / Defense scan, plus AI view and Coach view',
      'Eval curve with a self-rescaling axis up to +/-1200; dashboard with depth / speed / nodes / time',
      'Six rules: free-style / overline-loses / Renju forbidden / Swap-1 / Yamaguchi / Taraguchi-10',
      'Vision: screenshot or upload with auto board snapping, VC mate-puzzle mode, manual editing (swap / remove / fill / crop) and a picture drawer',
      'History & review: txt import/export, rename, right-click menu, separate review window (recite / replay, VC records open on the full board)',
    ],
    aboutOssList: [
      ['Rapfi', 'Gomoku / Renju engine core (compiled to WebAssembly, distributed with this app)', 'GPL-3.0'],
      ['OpenCV', 'Board and stone recognition (statically linked into GomokuVision.exe, no extra DLL)', 'Apache-2.0'],
      ['Microsoft WebView2 Runtime', 'Desktop UI runtime (provided by Windows / Edge, not distributed with this app)', 'Proprietary'],
    ],
    aboutOssNote: 'Note: the table lists only third-party components that ship with this app or are required at runtime. Development-only scripts and their dependencies (NumPy, Pillow, ...) run on the build machine and are not distributed with this app, so they are not listed here.',
    aboutLicText: 'The interface and companion code of this app are released under the MIT licence. The playing core Rapfi is released under GPL-3.0; this app calls it as compiled WebAssembly (an in-page worker) or as a separate process, communicating only through messages and a local port, and is not merged with it into a single work. When redistributing Rapfi together with this app you must keep its licence and the way to obtain its source (available from its upstream repository, dhbloo/rapfi). OpenCV, used for recognition, is statically linked into GomokuVision.exe under Apache-2.0. The Microsoft WebView2 Runtime is provided by Windows / Edge under its own terms and is not distributed with this app. Copyright and licensing of each component above remain with its respective authors.',
    engine: 'Engine', depth: 'Depth', speed: 'Speed', nodes: 'Nodes', time: 'Time',
    calcOn: 'Thinking', calcIdle: 'Idle',   // ★ 2026-09-27: dashboard status pill
    tagAiMove: 'AI move', tagAssist: 'Hint', tagHeat: 'Heat map', tagCoach: 'Coach',
tagDefend: 'Defence scan', tagCalc: 'Evaluate', tagNbest: 'N-best',
    tagLiveAna: 'Live analysis', liveAna: 'Analyze', liveAnaStop: 'Stop analysis',
    btnAiside: 'AI side', btnSet: 'Settings', pinFix: 'Pin',
    pinFixTtl: 'Pin this card: it stays when other cards are opened from Settings',
    pinCloseTtl: 'Unpin and close this card',
    aiSideB: 'AI Black', aiSideW: 'AI White', aiTurnLbl: 'Think time',
    tagBal1: 'Balance 1', tagBal2: 'Balance 2', tagFwd: 'Look-ahead', tagPreheat: 'Preheat', tagTen: 'Ten-call',
    eval: 'Eval', best: 'Best', curve: 'Eval curve', blackCurve: 'Black', whiteCurve: 'White',
    history: 'History', saved: 'Saved', openDrawer: 'History',
    saveSel: 'Save selected', delSel: 'Delete', openSel: 'Open', closeDr: 'Close',
    selAll: 'Select all', selNone: 'Clear',
    drTip: 'Tick some games, then "Save selected" -> they live forever under "Saved"',
    drExp: 'Export', drImp: 'Import',
    ctxOpen: 'Open in review', ctxRename: 'Rename', ctxExport: 'Export this game',
    ctxToSaved: 'Move to "Saved"', ctxDel: 'Delete',
    namePh: 'Name this game',
    expNone: 'Nothing to export',
    expOne: 'Exported 1 game as txt (choose the path in "Save as")',
    expDone: 'Exported {n} games as txt (choose the path in "Save as")',
    impDone: 'Imported {n} games into history',
    impNone: 'No readable position code in that text (one game per line, like h8h9g7…)',
    impFail: 'Cannot read that txt',
    renamed: 'Renamed',
    code: 'Position code', copy: 'Copy', paste: 'Paste', load: 'Load',
    copied: 'Position code copied', codeLoaded: 'Position code loaded', clipEmpty: 'Clipboard is empty',
    codeBad: 'Cannot read the position code: it looks like h8h9g7 (lowercase column letter + row, moves concatenated)',
    reset: 'Restart', redo: 'Redo',
    play: 'Play', pause: 'Pause',
    recite: 'Recite', replay: 'Replay', exit: 'Exit review',
    review: 'Review', prev: 'Back', next: 'Forward', savePos: 'Save position',
    rotTtl: 'Rotate stones 90° clockwise (axes stay put)', mirrorTtl: 'Flip stone layout',
    shiftTtl: 'Shift position', shiftBtnTtl: 'Shift position (move all stones by one cell)',
    mvFv: 'L·R', mvFh: 'U·D', mvD1: '╲', mvD2: '╱',
    mvFvT: 'Flip left-right', mvFhT: 'Flip up-down',
    mvD1T: 'Diagonal flip (top-left↔bottom-right)', mvD2T: 'Diagonal flip (top-right↔bottom-left)',
    mvUpT: 'Shift all stones up by one cell', mvDownT: 'Shift all stones down by one cell',
    mvLeftT: 'Shift all stones left by one cell', mvRightT: 'Shift all stones right by one cell',
    closeTtl: 'Close',
    layoutRV: 'Cannot change layout in review mode', layoutBusy: 'AI is thinking — try again shortly',
    shiftOOB: 'A stone would leave the board — cannot shift that way',
    posSaved: 'Position saved as PNG', posSaveFail: 'Save failed',
    pause: 'Pause', resume: 'Resume', assistHint: 'Click: AI computes and plays one move for you',
    reciteHint: 'Recite mode: place the next move from memory; mistakes get a pink ring.',
    miss: 'Missed', turnBlack: 'Black to move', turnWhite: 'White to move',
    turnYou: 'Your turn', turnAi: 'AI to move',
    over: 'Game over', thinking: 'AI thinking…', paused: 'Paused', youWin: 'You win', youLose: 'AI wins',
    analyzing: 'Analyze mode: no auto-move, candidates + heatmap only',
    modePlace: 'Free placement',
    // ★ 2026-09-23: Endgame mode (3rd item in Mode)
    modeEndgame: 'Endgame',
    egSeq: 'Sequential', egFree: 'Free color', egB: 'Black', egW: 'White',
    egFreeOn: 'Free {c}',
    egHint: 'Endgame mode: no AI involved - the board is exactly what you place. "Sequential" = black and white alternate; "Free color" = pick black or white in the small rounded box and keep placing that colour (any count, any order - e.g. 30 black + 10 white). The placed position is the first frame; save it to History or start studying right away.',
    // ★ Round 16 (user request): endgame "Confirm" - once confirmed, Restart returns to this position
    egOk: 'Confirm', egOkOn: 'Confirmed',
    egLockedHint: 'Endgame confirmed and switched to Free setup: "Restart" returns to this position, it is the first frame in History (marked Endgame), and Recite starts from it. Go back to Endgame mode to re-place.',
    offline: 'AI engine not ready yet (first start loads the model). Retrying automatically.',
    offlinePill: 'Engine offline · retrying…',
    rvFree: 'Review · free placement (no AI)',
    rvWindow: 'Review · board only',
    rvPure: 'Review · place stones yourself (no AI, no forbidden-move rules)',
    rvFromHist: 'Review · game opened from history',
    rvNothing: 'Board is empty: place a few stones first, or pick a game in History',
    srcLocal: 'Local', srcDesktop: 'Desktop', srcBookmark: 'Bookmark',
    theme: 'Dark', theme2: 'Light', themeCustom: 'Custom',
    color: 'Colours', cpClose: 'Close', cpReset: 'Reset',
    cpTheme: 'Theme', cpTarget: 'Apply to', cpBoard: 'Board', cpPage: 'Background',
    cpHex: 'RGB code', cpPreset: 'Presets',
    cpHintB: 'Tuning the board colour; grid, star points and axes follow automatically',
    cpHintP: 'Tuning the page background; cards and text follow the brightness',
    cpBad: 'Cannot read that colour: use #rrggbb or rgb(r,g,b)',
    cards: 'Cards', cardsHint: 'Pick the panels shown right of the board',
    cardSideL: 'L', cardSideR: 'R',
    analysis: 'Analysis',
    anCalc: 'Compute', anStop: 'Stop', anDefend: 'Defend scan',
    anNbest: 'Multi-point', anBal1: 'Balance 1', anBal2: 'Balance 2',
    anDefendDone: 'Scanned {c} points: higher % = more urgent (W = to win, L = to lose)',
    anDefendRefine: 'Refining… round {r}/{t}',
    anDefendStable: 'Converged: result stable',
    // ★ Vision window (2026-09-21): header button + the standalone vision window (?vis=1)
    vis: 'Vision',
    visTitle: 'Vision · turn board pictures into positions',
    visTtl: 'Turn board pictures into positions',
    visHint: 'Multi-select supported (up to 150); paste with Ctrl+V in the preview frame; a small picker pops up for screenshots',
    visBoxHint: 'Type or paste a position code here (e.g. h8h9g7…, Enter to load)\nor paste a board image with Ctrl+V',
    visBoxHintCode: 'Position code (edit + Enter to re-parse; Ctrl+V for an image)',
    visCodeBad: 'Code not recognized: expected "letter+number" pairs like h8h9g7i6',
    visDelTitle: 'Remove current',
    visUpload: 'Upload images', visShot: 'Screenshot',
    // ★ 12th round: crop
    visCrop: 'Crop', visCropTitle: 'Crop image', visCropHint: 'Drag to select the region to keep',
    visCropReset: 'Reset', visCropCancel: 'Cancel', visCropOk: 'OK',
    visCropNone: 'No image to crop - upload one or take a screenshot first',
    visCropSmall: 'Selection too small - drag a larger rectangle',
    visCropDone: 'Cropped ({w} x {h})', visCropFail: 'Crop failed - the image may be broken',
    visRec: 'Re-recognize', visSave: 'Save to history', visLoad: 'Load to practice',
    visShotBusy: 'Pick a capture mode (popup on screen)…',
    visShotFail: 'Capture failed: nothing to grab on screen',
    visWorking: 'Recognizing…',
    visBad: 'No board or stones found: the picture may be blurry or the board too small; try a sharper one where the board fills more of the frame',
    visNoStones: 'Board found but no stones read: the picture may be blurry, or stones lack contrast against the board',
    visLowRes: 'Low-resolution picture ({w}×{h}); recognition may be inaccurate',
    visOk: 'Recognized {b} black and {w} white stones',
    visCountBad: 'Imbalanced stones (black {b} / white {w}): Save / Load disabled - use Edit to make black=white or black=white+1',   // ★ 8th round
    visVc: 'VC Mode', visVcTip: 'Mate-puzzle mode: unbalanced stone counts may be saved/loaded (VCF/VCT diagrams often have far more black than white); loading only presets the attacker - you start the mate search yourself with VCF / VCT',   // 12th round
    visVcOn: 'VC Mode ON: unbalanced counts may be saved/loaded; after loading, press VCF or VCT yourself to start the mate search (attacker defaults to the majority side)',
    visVcOff: 'VC Mode OFF: stone-count check restored (black=white or black=white+1)',
    visVcPass: 'VC Mode allows: black {b} / white {w} (unbalanced) - save/load enabled',
    visVcArm: 'VC Mode ready: attacker preset to the majority colour - press VCF or VCT to start the mate search (nothing runs automatically)',   // 12th round
    visSuspect: 'The picture may be blurry — result may be inaccurate, please double-check; ',
    visPartial: 'The board may be incomplete (partial view), stones loaded centered; ',
    visNone: 'Upload a picture or take a screenshot first',
    visSaved: 'Saved to history (visible in the main window under History)',
    visLoaded: 'Sent to the practice window',
    visName: 'Vision capture',
    visSrc: 'Vision',
    // Vision window (2026-09-21): the count pill opens the picture drawer
    visPillTip: 'Open the picture drawer (pick / remove)',
    visDrawerTtl: 'Pictures',
    visDrawerClose: 'Close drawer',
    visVdTip: 'Click a thumbnail to select · ✕ removes · click blank to upload',
    // Vision window (2026-09-22): drawer multi-select + manual "Edit" tools
    visSel: 'Select', visSelAll: 'All', visDelSel: 'Delete',
    visSelOn: 'Multi: on', visSelOff: 'Select',
    visSelTip: 'Click = check · Ctrl+click = multi · Shift+click = range · Ctrl+A = all',
    visCopy: 'Copy picture',
    visCopied: 'Picture copied to clipboard',
    visCopyFail: 'Copy failed: not a picture',
    // ★ Round 24 (user request): double-click a picture = open it in the system default viewer
    visOpenApp: 'Open in the system image viewer',
    visOpenTip: 'Double-click a picture to open it in the system default viewer',
    visNoSel: 'Check some pictures first ("Select" or Ctrl+click)',
    visDelDone: 'Deleted {n} picture(s)',
    visEdit: 'Edit',
    veSwap: 'Swap B/W', veDel: 'Remove stones', veAdd: 'Add stones',
    veAddB: 'Black first', veAddW: 'White first',
    veSwapHint: 'Swap mode: click a black stone, then a white stone - the two swap colors; repeat as you like; click this button again or press Esc to exit',
    veSwapNext: '1 selected - click a stone of the other color to swap',
    veSwapDone: 'Swapped - black {b} / white {w} - keep clicking to swap more',
    veUndo: 'Undo', veUndoNone: 'Nothing to undo',
    veDelHint: 'Remove stones: single black allowed when black = white+1, single white allowed when white = black; otherwise click the opposite color to remove a pair',
    // ★ 2026-09-23: VC mode edit unlock — unlimited add / free delete
    veDelVcHint: 'VC mode · Remove: click ANY stone to delete it at once - any colour, any count (Undo to revert)',
    veFillVcHint: 'VC mode · Add: click an empty point to drop that colour - as many as you like (Undo to revert)',
    visVcEditTip: 'VC mode is on: black/white counts need NOT match to save/load; in Edit mode "Add black / Add white" are UNLIMITED and "Remove stones" deletes ANY stone (no balancing required). Save the endgame to History - it opens as a full-board first frame.',
    veDelPair: 'This stone cannot go alone - click a stone of the OPPOSITE color to remove the pair (click it again to cancel)',
    veDelDone: 'Removed {x} spot(s) (black {b} / white {w})',
    veGhost1: 'Ghost {c} placed - click an empty point for the opposite color',
    veGhost2: 'Click any empty point to commit this pair and start the next; click outside the grid to commit only',
    veGhostB: 'black', veGhostW: 'white',
    veAddBHint: 'Black first: click an empty point for a ghost black - another for white - a third point / blank commits',
    veAddWHint: 'White first: click an empty point for a ghost white - another for black - a third point / blank commits',
    veFillB: 'Add black', veFillW: 'Add white',
    veFillBHint: 'Add black: click empty intersections to add black stones one by one (until black = white or white + 1)',
    veFillWHint: 'Add white: click empty intersections to add white stones one by one (until white = black)',
    veFillBFull: 'Black already outnumbers white - no more black needed (try Remove stones or Add white)',
    veFillWFull: 'White is level with black - cannot add more white',
    veFillGuideB: 'White has {d} more than black - click "Add black" to fill in (one per click)',
    veFillGuideW: 'Black has {d} more than white - click "Add white" to fill in (one per click)',
    visCode: 'Board code',
    visCodeCopied: 'Board code copied',
    veEdited: 'Edited (black {b} / white {w}) · re-recognize or load to practice',
    veEditOn: 'Edit mode: right-click the board for the same menu',
    veEditOff: 'Edit mode off',
    veRightMenu: 'Right-click menu: pick an action',
    nbest: 'Points', nbestHint: 'Up to 8 (engine may return fewer)',
    anIdle: 'Pick a button to compute; results are drawn on the board',
    anRunning: 'Computing…', anStopped: 'Stopped', anEmpty: 'Board is empty: place a few stones first',
    anDraft: 'Drafting… round {r}',
    anDone: 'Move {n} · {ev} · depth {d}',
    anBest: 'Best', anBalance: 'Balance',
    anBal1Done: 'Most balanced move: {ev}',
    anBal2Done: 'Most balanced pair after two plies: {ev}',
    anAfter: 'after 2 plies',
    guideYama: 'B1 → W2 → B3', guideYamaEn: 'B1 → W2 → B3',
    guideSwap: 'Waiting for the colour swap', guideSwapEn: 'awaiting swap',
    swapTtl: 'Swap finished · pick first or second',
    swapFirst: 'First · Black', swapSecond: 'Second · White',
    ruleName: {
      0: 'Freestyle', 1: 'Freestyle · overline loses', 2: 'Renju (forbidden)',
      5: 'Swap1', 6: 'Yamaguchi', 7: 'Taraguchi-10',
    },
    ruleHint: {
      0: 'Freestyle: five or more in a row wins.',
      1: 'Standard: overlines do not win - exactly five.',
      2: 'Renju: black is forbidden (3-3 / 4-4 / overline), white is not.',
      5: 'Swap1: after black`s first stone, white may swap colours.',
      6: 'Yamaguchi: place 3 opening stones (B1 W2 B3), then the opponent picks a colour.',
      7: 'Taraguchi-10: B1 centre, W2 within 3x3, B3 5x5, W4 7x7; black plays the 5th (9x9) or calls ten, white picks one, then white picks a colour.',
    },
    ruleKept: 'Rule switched to "{r}": the current board is kept as-is and play continues under the new rule (result and forbidden marks recomputed)',
    fbBlocked: 'Forbidden: Black may not play here (3-3 / 4-4 / overline) - the red crosses on the board are exactly those points',
  },
};
function T(k) { var d = I18N[S.lang] || I18N.zh; return d[k] !== undefined ? d[k] : k; }

// ---------------------------------------------------------------- 状态
var S = {
  lang: 'zh', theme: 'light',
  mode: 'pve',                 // pve = 人机，place = 自由摆盘（AI 完全不参与，自己与自己下），
                               // endgame = 残局（★ 2026-09-23 用户要求：AI 不参与；顺序/任意摆盘）
  // ★ 2026-09-23（用户要求）：残局模式子状态 —— egSeq=true「顺序摆盘」（黑白轮流）；
  //   egSeq=false「任意摆盘」（egColor 指定的色**连续摆放**，不限数量不限顺序，如 30 黑 + 10 白）
  egSeq: true, egColor: 1,
  // ★ 2026-09-23 十六轮（用户要求）：残局「确定」—— egBase = 定下来的那一瞬间的盘面
  //   （[[x,y,c],…]）；egLocked=true 时「重新开始」回到这个局面，存进历史它也是首帧。
  egLocked: false, egBase: null,
  // ★★ 2026-09-24（用户要求）：「先后手二选一」→ **两个独立开关** AI 执黑 / AI 执白。
  //   aiB = AI 执黑，aiW = AI 执白；**两个都开 = AI 与 AI 自打**，两个都关 = 你自己把黑白都下。
  //   ★ 2026-09-26（用户要求）：**默认两个都不开** —— 打开就是用户自己下黑白双方。
  //   `side` 保留为**派生值**（旧存档 / 旧测试 / 落盘格式都认它）：单开时 aiB→side='w'、
  //   aiW→side='b'；两开或两关时 side 退化成 ''（旧口径表达不了，仅作兼容占位）。
  aiB: false, aiW: false,
  side: '',                    // 派生：我执色 'b'/'w'（''= 用户不执单一色，见上）
  // ★ 09-28（用户要求）：摆棋评分下架，「评估分数」总开关一并移除 ——
  //   盘面评估统一走「分析计算」键（主车道持续深算）。
  //   关 = 立刻撤块并停后台评估；这块评分也归「清除标记」管，清后再落子自动重铺。
  // ★ 三十三轮：「在对手思考的时间持续计算，提高智力」= 后台预热。
  //   ★ 2026-09-28（用户最终口径）：**默认关** —— 大预热不默认跑；勾选后才启用，
  //   启用后走「微小官方 ponder」档（沿 AI 上一搜主变量线向前多看一步预测你的应手，
  //   全深度、零探测成本）。undefined（旧存档）也按「关」处理（见 preheatOn）。
  preheat: false,
  level: 1,                    // 0 简单 1 普通 2 困难
  turnMs: 2000,               // ★ 2026-09-27（用户要求）：默认思考时间 2 秒
  rule: 0,
  cores: 0, hashMB: 0,
  // ★ 2026-09-20：原来这里有 `aiFirst`（「我执白时由 AI 开第一手」的勾选框）——
  //   那个开关已随「先后手（黑先 / 白先）」合并掉了（白先 = AI 执黑先走），字段与勾选框一起删。
  heat: false, coach: false,
  // ★ 2026-09-19（用户要求）：对局设置卡里的「显示序号」—— 在棋子上标出它是第几手。
  showNum: false,
  // ★ 2026-09-25（用户要求）：**复盘窗**自己的「序号」键（rvBar 里那颗）。
  //   与主窗口的 showNum 分开：主窗那颗刻意不在复盘窗生效（背诵复盘时序号 = 答案），
  //   复盘窗要不要显示由用户**当场**按这颗键决定。
  rvNum: false,
  rvSpeedSec: 1,               // 复盘「回顾复盘」自动播放的单步间隔（0.5~5 秒，用户可调、随设置持久化）
  paused: false,
  // ★ 2026-09-20（用户要求）：「选择棋盘的颜色以及背景的颜色进行自定义调色并持久化」
  //   · boardColor / pageBgColor：用户挑的颜色（'' = 用 calc.css 里那套默认护眼黄 / 默认底色）；
  //   · cssVars：由它俩**派生出来的一整套 CSS 变量**（网格线、星位、卡片、文字…），
  //     一并持久化 —— 于是 calc.html 里那段内联启动脚本能**原样回放**，
  //     重开窗口的第一帧就是对的颜色，不会先闪一下默认色再跳过去。
  boardColor: '', pageBgColor: '', cssVars: null,
  // ★ 五轮（用户要求）：「自定义的颜色应该要保存用户之前自定义的颜色」——
  //   切去深色/浅色时手调的棋盘色/背景色**不丢**，先存进这个记忆槽；再点「自定义」原样还原。
  //   （「恢复默认」仍会连记忆槽一起清 —— 那才是真正的从零开始。）
  customColors: { board: '', page: '' },
  // ★ 五轮（用户要求）：「预览框」= 棋盘上鼠标悬停出现的蓝色圆角方块开关（默认开）。
  previewOn: true,
  customBase: 'light',         // ★ custom 档的壳底子（dark/light）：动色顶到 custom 时壳不再变浅
  nbest: 4,                    // 多点分析点数（2~8；引擎那侧 topN 硬上限就是 8）
  // ★ 2026-09-20（用户反馈，二轮）：「计算对象是活动的」—— 手动开关已删，分析恒按**行棋方**算
  //   （轮到谁就替谁算，随「先后手」自然交替），不再有 'user' / 'ai' 视角设置。
  cards: null,                 // 「卡片」功能键的面板显隐表（null = 用 DEFAULT_CARDS）
};

var G = {
  moves: [],                   // [{x,y,c}]  c:1 黑 2 白
  board: null,                 // N×N
  busy: false,
  engineOffline: false,        // 引擎（:8964）没应答：不再永远转「AI 思考中…」，改喊人+自动重试
  retryTimer: 0,               // 引擎离线时的自动重试定时器
  retryLeft: null,             // 还能重试几次（引擎回来/用户落子会重置）
  over: false,                 // 终局锁：有人连五后棋盘封盘（无禁手长连也算，≥5 即胜）
  lastStat: null,
  curve: [],                   // [{i, b, w}]
  heat: [],                    // [{x,y,tier,score,ev}] tier 1..4=名次档；ev=格内显示的评估分
  heatGen: 0,                  // 热力请求代数：局面一变/新请求一出，旧结果一律丢弃
  heatColors: 2,               // ★ 本份 AI 视图用了几色（2/3/4）—— 思考时间档位决定，paint 据此选调色板
  // ★ 2026-09-19（用户要求）：「指导视图」= 方形四色热力，AI 帮**用户**算最佳落点。
  //   与 G.heat（AI 方面：圆形、1~2 色）分开存、分开算、分开清 —— 生命周期不同：
  //   heat 随 AI 落子消失，coach 随用户落子消失。
  coach: [],                   // [{x,y,tier,ev}] 方形四色热力（指导视图专用）
  coachGen: 0,                 // 指导视图请求代数（同 heatGen 的防过期闸）
  heatLen: -1,                 // 这份热力对应的手数（AI 落子后据此沿用，不重算）
  nums: [],                    // 候选点位置（AI 计算时闪动的「计算点」用）
  think: [],                   // AI 计算时闪动的「计算点」
  missRings: [],               // 背诵复盘：背错的位置
  redo: [],                    // 「下一步」可重放的着法块（[{moves:[…]},…]）
  rvRecord: null,              // 复盘窗口：宿主投递进来的那一局（{moves,src,rule}）；null = 纯空盘自己摆
  loaded: null,                // 载入的历史/外部局面 {moves:[[x,y,c]..], src}
  review: null,                // 复盘窗口：{kind:'replay'|'recite', k:0, miss:0}
  rvPlaying: false,            // 复盘「回顾复盘」自动播放中（▶/⏸ 与空格键共同控制）
  rvTimer: 0,                  // 自动播放的下一手定时器（暂停/退出/换局一律 clearTimeout）
  // ★ 2026-09-24（用户要求）：宿主报文还带 memMB（物理内存 MB）与 native（旁边有没有原生引擎）——
  //   哈希下拉靠它们决定「能不能开到 6GB」以及「6GB 档要不要变灰」。
  host: { cpu: 4, threadsDefault: 2, threadsMax: 3, memMB: 4096, native: false },
  hover: null,                 // ★ 鼠标悬浮的交叉格 {x,y}（浅蓝圆角方框提示）；null = 指针不在盘上
  animId: 0,
  // ★ 2026-09-20（用户要求）：「计算评估」的结果 —— 计算 / 多点分析 / 扫描防守 / 平衡一 / 平衡二
  //   全部落在这里，paint() 据此在棋盘上画「名次徽标 + 评估分」（亦心那种数字标示），
  //   同时 renderAna 把同一批数据列成卡片里那份「名次 坐标 分数 最佳线」清单。
  //   gen 与 heatGen/coachGen 同款防过期闸：局面一变 / 用户点了别的键 / 按了停止，
  //   在途的那一发结果回来时一律作废（引擎那边无法真正中断，只能在客户端丢弃）。
  ana: { gen: 0, busy: false, kind: '', marks: [], rows: [],
         // ★ 2026-09-26（用户要求）：「扫描防守」点过一次后随落子自动重扫（Yixin 式动态刷新），
         //   直到「清除标记」/ 重开 / 载入才停。放在 ana 里跟着 gen 闸一起走。
         //   ★ 三十轮（口径修正）：不是「每 3.5× 才刷一拍」，而是**总窗口 = 思考时间 3~4×**
         //     （defWinUntil = 窗口截止时刻），窗口内一轮算完**立刻**接下一轮（像边思考边把
         //     草稿打上盘面，节奏随引擎计算快慢有密有疏）；窗口一到 → 在途轮收尾即定格。
         //     defTimer = 流内续拍句柄；defRefining = 精修在途（续拍等它收尾，不中途掐死）。
         //     定局（五连/活四）立即停表并撤标。
         defWinUntil: 0, defRefining: false, autoDefend: false, defTimer: null },
  // ★ 2026-09-26（用户要求，参考 Rapfi+Yixin 界面）：「AI 先手 / 后手都不开」= 用户自己摆棋子 ——
  //   每摆一子就对【下一手方】（摆的是黑子 → 下一手是白子）做一次浅搜，把上一手周围
  //   候选点的评估分数直接铺在格子里：格内只显示分数数字，底色按分数连续渐变 ——
  //   分数越高越青 / 越蓝（优势越大），越低越红。items = [{x,y,label,t}]，t=0..1 强度。
  //   ★ 三十轮（口径修正）：**总窗口 = 思考时间 3~4×**（winUntil = 窗口截止时刻），
  //     窗口内反复评估**连轴转**（一轮算完立刻下一轮，节奏随引擎快慢），取「出现次数
  //     最多」的稳定分数上格子（平滑单次浅搜的噪声）；窗口一到 → 在途轮收尾即定格。
  //     timer = 流内续拍句柄，hist/histKey = 本手内的评估累积表。
  // ★ 五轮（用户要求）：前瞻 —— 从当前残局自动推演到五子连珠终局。
  //   on = 开关；line = 推演出的着法（不落真盘，只做透明预览）；idx = < > 步进的浏览位
  //   （-1 = 只看当前局面）；hover = 悬浮某枚代码时的临时预览位；gen = 作废闸。
  // ★ 六轮（用户要求）：committed = 已「确定」上盘到的代码下标（-1 = 还没确定过）；
  //   hold = 确定过之后「冻结」当前推演结果 —— 局面变了也不自动重算，再点「前瞻」键才重算；
  //   sel = 当前选中的代码下标（点击代码只是选中，右侧「确定」键才落盘）；hoverTimer = 悬停保持定时器
  //   （代码链之间挪鼠标时不闪回全盘布局 —— 阶段性渲染：离开旧代码后短暂保持旧布局）。
  fwd: { on: false, gen: 0, line: [], idx: -1, hover: -1, busy: false, timer: 0,
         committed: -1, hold: false, sel: -1, hoverTimer: 0, base: 0, kind: '', atk: 0,   // ★ 七轮：atk = 指定算杀进攻方（0=自动/轮走方 1=黑 2=白）
         // ★ 十轮（用户要求）：算杀模式 = 「边走边算」一条线 ——
         //   wantVcx = 是否处于 VCF/VCT 模式；want/want2 = 首选规则 + 兜底规则；
         //   vcxAt = 算杀段第一手在整条推演线里的下标（-1 = 这条线还没有算杀段）；
         //   vcxMarks = 算杀段每手的威胁标记（供棋盘画虚线环：连五/冲四/活三）。
         wantVcx: false, want: '', want2: '', vcxAt: -1, vcxMarks: [] },
};

function newBoard() {
  var m = [], y, x, row;
  for (y = 0; y < N; y++) { row = []; for (x = 0; x < N; x++) row.push(0); m.push(row); }
  return m;
}
function hideReviewNav() {
  els.btn_rv_prev.hidden = els.btn_rv_next.hidden = els.rvPos.hidden = els.btn_rv_exit.hidden = true;
  // 播放/暂停与速度档只属于「回顾复盘」，离开这模式（退出/换局/重来）先停播再藏键
  rvStopPlay();
  if (els.btn_rv_play) els.btn_rv_play.hidden = true;
  if (els.rvSpeed) els.rvSpeed.hidden = true;
}
function setMissBox() {
  var n = G.review ? G.review.miss : 0;
  els.rvMiss.textContent = T('miss') + ' ' + n;
}
function resetGame(keepLoaded) {
  G.moves = []; G.board = newBoard(); G.curve = [];
  clearHeat();                                 // 清热力 + 作废在途请求（重开也必须作废）
  clearCoach();                                // 指导视图同清
  anaReset();                                  // 计算评估的标注同清（见 place 注释）
  G.ana.autoDefend = false;                    // ★ 2026-09-26：重开 = 扫描防守动态重扫一并停止
  if (els.swapPop) els.swapPop.hidden = true;  // 交换先后手弹窗同收
  G.missRings = []; G.redo = []; G.review = null; G.lastStat = null;
  G.over = false;                              // 重开 = 解除终局锁
  // ★★ 十九轮（用户要求，取代十六/十八轮的「重开回残局」）：重新开始 = **整个局面消失** ——
  //   这一局刚刚已经自动存进历史（残局记录带 eg/egLen），要重看就打开历史；
  //   残局基准随之清掉（要重摆就回「残局」模式），棋盘是真正的空白。
  S.egLocked = false; S.egBase = null;
  if (!keepLoaded) G.loaded = null;
  els.dockL.style.display = '';
  els.dockR.style.display = '';
  hideReviewNav();
  setMissBox();
  persistGame();
  paint();
}
function curColor() { return (G.moves.length % 2 === 0) ? 1 : 2; }   // 黑先
/** 用户执色：1 黑 / 2 白 / **0 = 用户不执单一色**。
 *  ★★ 2026-09-24（用户要求）：「AI 执黑 / AI 执白」两个**独立开关** ——
 *    · 只开 AI 执黑 → 用户执白（2）；只开 AI 执白 → 用户执黑（1）；
 *    · 两个都开（AI 自打）/ 两个都关（用户两边都下）→ 没有「用户执色」这个概念，返回 0。
 *  凡是「把 0 当颜色用」的地方（3-myColor()、与 curColor() 比较）都必须改走
 *  isAiColor(c) / isUserColor(c) —— 见下面三个派生谓词。 */
function myColor() { return (!!S.aiB === !!S.aiW) ? 0 : (S.aiB ? 2 : 1); }
/** 这一色是不是由 AI 来走（AI 自打时两色都是）。 */
function isAiColor(c) { return (c === 1) ? !!S.aiB : !!S.aiW; }
/** 这一色是不是由用户来走（两个开关都关时两色都是）。 */
function isUserColor(c) { return !isAiColor(c); }
/** AI 自打：两色都交给 AI（用户只旁观）。 */
function aiVsAi() { return !!S.aiB && !!S.aiW; }
/** 两个开关都关：没有 AI，用户自己把黑白双方都下了。 */
function humanBoth() { return !S.aiB && !S.aiW; }
/** 「AI 视图 / 热力图」关注的那一方颜色：
 *   · 只开一个开关 → 就是 AI 那一色；
 *   · AI 自打 → 跟着回合走（两色都是 AI）；
 *   · 两个都关 → 对手色（热力图此时的含义是「对方会怎么应」，与旧版「我执单色」时的观感一致）。 */
function heatTargetColor() {
  if (S.aiB !== S.aiW) return S.aiB ? 1 : 2;
  return aiVsAi() ? curColor() : (3 - curColor());
}
/** 设置「AI 执哪几个色」（唯一写入口：开关点击 / 交换开局流程 / 旧存档迁移都走它）。 */
function setAiSides(b, w) {
  S.aiB = !!b; S.aiW = !!w;
  S.side = (S.aiB === S.aiW) ? '' : (S.aiB ? 'w' : 'b');   // 派生，供旧口径读取
}

// ---------------------------------------------------------------- DOM
var els = {};
function grab() {
  ['t_title','btn_history','btn_lang','btn_color','btn_about','about','ab_body','ab_close','t_about',
   'board','boardWrap',
   'btn_pause','btn_prev','btn_next','btn_reset','btn_save','boardBtns',
   'btn_rot','btn_mirror','btn_shift','mirrorPop','shiftPop','t_mirrorTtl','t_shiftTtl',
   'btn_mv_fv','btn_mv_fh','btn_mv_d1','btn_mv_d2','btn_mv_close',
   'btn_mv_up','btn_mv_down','btn_mv_left','btn_mv_right','btn_shift_close',
   'btn_ten','openBar','openHint','boardFoot','swapPop','t_swapTtl','btn_swap_first','btn_swap_second',
   't_code','inp_code','btn_copy','btn_paste','btn_load',
   'btn_review','rvBar','rvGroup','btn_recite','btn_replay','rvMiss',   // ★ 十八轮：复盘窗「关闭」键已删
   'btn_rv_prev','btn_rv_next','btn_rv_exit','rvPos','btn_redo_rv','btn_save_rv','btn_rv_hist',
   'btn_rv_play','rvSpeed',
   // ★ 2026-09-21 识图窗：顶栏入口键 + ?vis=1 页面的整套面板
   // ★ 图片抽屉（用户要求 2026-09-21）：visDrawer / vdList / vdCount / btn_vd_close
   'btn_vis','visPane','visView','visBox','visInput','visImg','visPos','btn_vis_del',
   'btn_vis_prev','btn_vis_next','btn_vis_upload','btn_vis_shot',
   'btn_vis_rec','btn_vis_save','btn_vis_load','btn_vis_vc','visMsg','file_vis',
   // ★ 2026-09-22 十二轮（用户要求）：识图窗「裁剪」键 + 裁剪浮层
   'btn_vis_crop','visCrop','cropStage','cropCanvas','t_visCropTitle','t_visCropHint','t_visCropSize',
   'btn_crop_reset','btn_crop_cancel','btn_crop_ok',
   // ★ 2026-09-22（用户要求）：「修改」键 + 棋盘下方修改功能条；抽屉 选择/全选/删除
   // ★ 三轮（用户要求）：补充黑子/补充白子 单补键；veHint 取消（提示统一走 visMsg）
   // ★ 五轮（用户要求）：「自动吸附」键删除（吸附恒开 + 外扩棋盘 1/30）；新增棋盘代码框
   'btn_vis_edit','visEditBar','btn_ve_swap','btn_ve_del','btn_ve_add','btn_ve_addb',
   'btn_ve_addw','veAddKeys','btn_ve_fillb','btn_ve_fillw','btn_ve_undo',
   'visCodeBar','visCode','btn_vis_codecopy','t_visCode',
   'btn_vd_sel','btn_vd_all','btn_vd_del',
   'visDrawer','vdList','vdCount','btn_vd_close','t_visDrawer','t_vdTip',
   'stage','dockL','dockR','boardCol',
   't_setup','seg_mode','seg_side','t_mode','t_side','t_turn','sideHint',
   't_preheat','chk_preheat',   // ★ 09-28：t_preheatHint 已删（后台预热提示文字去掉）
   'egBar','btn_eg_ok','btn_eg_seq','btn_eg_free','egKeys','btn_eg_b','btn_eg_w',   // ★ 十四轮：残局摆盘行（十六轮加 btn_eg_ok）
   'num_turn','t_rule','sel_rule','ruleHint',
   't_cores','sel_cores','t_hash','sel_hash','t_heat','chk_heat','t_heatHint',
   't_coach','chk_coach','t_coachHint',
   'heatLegend','t_heatBest','t_heatGood','t_heatFair','t_heatPoor',
   't_showNum','chk_num','t_showNumHint',
   'btn_rv_num',                                   // ★ 2026-09-25：复盘窗「序号」键
   't_preview','chk_preview','t_previewHint',
   'fwdBox','btn_fwd','btn_fwd_vcf','btn_fwd_vct','btn_fwd_ok','btn_fwd_prev','btn_fwd_next','fwdBody','fwdMsg','fwdSeq','fwdLg','fwdLgB','fwdLgW','btn_fwd_clear',
   'vcxPop','vcxPopBody','vcxPop_close','t_vcxPop',
   't_engine','t_depth','t_speed','t_nodes','t_time','t_eval','t_best',
   'st_depth','st_speed','st_nodes','st_time','st_eval','st_best','st_line',
   // ★ 09-28：calcPill/calcPillTxt 已删（标题后「空闲」胶囊去掉）；仪表盘下方文字框 turnPill **恢复**
  'turnPillRow','turnPill',
   't_curve','t_curveTtl','curve','curveAxis','curveScroll','curveWrap','t_blackCurve','t_whiteCurve',
   'drawer','drList','drCount','dr_save','dr_open','dr_del','dr_close','dr_all',
   'dr_exp','dr_imp','ctxMenu','file_imp',
   // ★ 2026-09-20（用户要求）：调色窗（顶栏「颜色」键打开）、「卡片」功能键、计算评估卡片
   'btn_color','colorPop','t_color','cp_close','cp_theme','cp_target','cp_sv','cp_hue',
   'cp_r','cp_g','cp_b','cp_rn','cp_gn','cp_bn','cp_hex','cp_presets','cp_prev','cp_hint','cp_reset',
   'cpPresetRow',
   't_cpTheme','t_cpTarget','t_cpHex','t_cpPreset',
   'btn_set','setPop','btn_aiside','aiSidePop','btn_ai_close',   // ★ 2026-09-27：设置/AI 执子弹窗
   'ai_side_b','ai_side_w','t_aiTurn','num_turn2','btn_live',
   't_analysis','btn_an_stop','btn_an_nbest','btn_an_bal1','btn_an_bal2','btn_an_defend',
   'num_nbest','t_nbest','t_nbestHint','anStatus','anList','anStatusRow',
   't_history','t_saved','t_drTip'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });
}

// ---------------------------------------------------------------- 棋盘绘制
function layoutBoard() {
  var box = els.boardWrap.getBoundingClientRect();
  // 棋盘再大一点（用户嫌偏小）：外框内边距压到最小，几乎把整块可用区域吃满
  var pad = 4;
  var side = Math.max(160, Math.min(box.width, box.height) - pad * 2);
  var dpr = window.devicePixelRatio || 1;
  els.board.style.width = side + 'px';
  els.board.style.height = side + 'px';
  els.board.width = Math.round(side * dpr);
  els.board.height = Math.round(side * dpr);
  paint();
  drawCurve();
}

function css(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/** 棋盘几何：留出四周坐标轴的宽度。 */
function geom() {
  var cv = els.board, dpr = window.devicePixelRatio || 1;
  var size = cv.width / dpr;
  var axis = Math.max(14, size * 0.055);
  var pad = axis + Math.max(4, size * 0.012);
  var gap = (size - pad * 2) / (N - 1);
  return { size: size, dpr: dpr, axis: axis, pad: pad, gap: gap };
}

/** 「显示序号」的**统一判据**（2026-09-25）：
 *  · 主窗口 —— 对局设置里那颗「显示序号」（S.showNum）；
 *  · 复盘窗 —— rvBar 里那颗「序号」（S.rvNum，用户当场按）。
 *  两个开关互不相干：主窗那颗刻意不进复盘窗（背诵复盘时序号等于把答案印在盘上），
 *  复盘窗要不要显示由用户自己按那颗键决定 —— 所以这里按 RV_MODE 分流，不共用同一个字段。 */
function numShown() { return RV_MODE ? !!S.rvNum : !!S.showNum; }

// ---------------------------------------------------------------- 棋子布局变换（2026-09-25 二轮澄清）
// ★ 用户澄清：↻ / ⇄ / ✥ 变换的是**棋子布局**，不是画面 —— 棋盘线、字母数字坐标轴
//   纹丝不动，动的只有棋子（连同历史 / 重放块 / 残局基面 / 载入局面一起映射）。
//   引擎侧无需任何同步：每次请求都从 moveList **全量**重建 YXBOARD，
//   布局一换，下一次思考自动按新布局算。
function pxy(p) { return p.x !== undefined ? [p.x, p.y] : [p[0], p[1]]; }
function pset(p, x, y) { if (p.x !== undefined) { p.x = x; p.y = y; } else { p[0] = x; p[1] = y; } }
/** 布局变换的三道闸：复盘窗（只读）/ AI 思考中（盘面正在被引擎使用）→ 拦下。
 *  ★ 2026-09-25（用户反馈「三个布局键没效果」）：拦截时只把提示写进引擎仪表盘的状态胶囊，
 *    用户根本注意不到 —— 现在同时在**棋盘底栏上方**浮出一条短提示（1.8 秒自动消散），
 *    被拦下的原因一眼可见；能变换时棋子布局立即重排。 */
function layoutTip(msg) {
  setStat(null, msg);
  var host = document.getElementById('boardCol');
  if (!host) return;
  var old = document.getElementById('layTip');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var d = document.createElement('div');
  d.id = 'layTip'; d.className = 'laytip'; d.textContent = msg;
  host.appendChild(d);
  setTimeout(function () { if (d && d.parentNode) d.parentNode.removeChild(d); }, 1800);
}
function layoutAlive() {
  if (RV_MODE || G.review) { layoutTip(T('layoutRV')); return false; }
  if (G.busy) { layoutTip(T('layoutBusy')); return false; }
  return true;
}
/** 把映射 map(x,y)→[nx,ny] 作用于**全部布局数据**（先验后改：任一子越界 = 整体不动）。
 *  覆盖：G.moves（含 c）· G.redo 各重放块 · S.egBase（残局基面）· G.loaded（载入局面）。
 *  派生层随后重建/作废：G.board 重算；热力 / 计算点 / 指导 / 分析标注 / 背错圈随旧布局
 *  作废（都是一键可重算的瞬态层）；前瞻开着且未冻结 → 自动重推（与 place() 同一套闸）。 */
function layoutApply(map) {
  if (!layoutAlive()) return false;
  var lists = [G.moves], r, i, p, q;
  if (G.redo) for (r = 0; r < G.redo.length; r++) lists.push(G.redo[r].moves);
  if (S.egBase) lists.push(S.egBase);
  if (G.loaded && G.loaded.moves) lists.push(G.loaded.moves);
  for (r = 0; r < lists.length; r++)
    for (i = 0; i < lists[r].length; i++) {
      q = map.apply(null, pxy(lists[r][i]));
      if (q[0] < 0 || q[1] < 0 || q[0] >= N || q[1] >= N) { setStat(null, T('shiftOOB')); return false; }
    }
  for (r = 0; r < lists.length; r++)
    for (i = 0; i < lists[r].length; i++) {
      p = lists[r][i]; q = map.apply(null, pxy(p)); pset(p, q[0], q[1]);
    }
  G.board = newBoard();
  for (i = 0; i < G.moves.length; i++) { p = G.moves[i]; G.board[p.y][p.x] = p.c; }
  G.hover = null;
  clearHeat();                        // 热力 / 计算点 / nums
  G.coach = []; G.coachGen++;         // 指导视图
  anaReset();                         // 计算评估标注 + 卡片
  G.missRings = [];                   // 背诵背错圈
  if (G.fwd && G.fwd.on && !G.fwd.hold) fwdQueue();
  paint();
  return true;
}
/** 五种对称 + 四向平移。命名按「棋子往哪边看」：FLIP_H = 左右翻转（纵向镜像）。 */
var ROT_CW  = function (x, y) { return [N - 1 - y, x]; };
var FLIP_H  = function (x, y) { return [N - 1 - x, y]; };
var FLIP_V  = function (x, y) { return [x, N - 1 - y]; };
var DIAG_1  = function (x, y) { return [y, x]; };                  // 左上↔右下
var DIAG_2  = function (x, y) { return [N - 1 - y, N - 1 - x]; };  // 右上↔左下
var SHIFT_U = function (x, y) { return [x, y - 1]; };
var SHIFT_D = function (x, y) { return [x, y + 1]; };
var SHIFT_L = function (x, y) { return [x - 1, y]; };
var SHIFT_R = function (x, y) { return [x + 1, y]; };

/** 屏幕像素 (px,py) → 最近交叉点 {x,y}；出盘 = null。**所有**棋盘点击/悬停的唯一入口。
 *  ★ 布局变换（二轮澄清）后画面与数据同系，命中就是简单的「取最近交叉点」。 */
function cellAt(px, py) {
  var g = geom();
  var x = Math.round((px - g.pad) / g.gap), y = Math.round((py - g.pad) / g.gap);
  if (x < 0 || y < 0 || x >= N || y >= N) return null;
  return { x: x, y: y };
}

function paint() {
  var cv = els.board, ctx = cv.getContext('2d');
  var g = geom(), dpr = g.dpr, size = g.size, pad = g.pad, gap = g.gap;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.scale(dpr, dpr);

  ctx.fillStyle = css('--board');
  ctx.fillRect(0, 0, size, size);

  // ★ 2026-09-25 二轮澄清：布局变换改在**数据层**（layoutApply 映射 G.moves），
  //   paint 恒按原始盘坐标画 —— 棋盘线、字母数字坐标轴从此纹丝不动。

  // 网格线
  ctx.strokeStyle = css('--line');
  ctx.lineWidth = Math.max(1, size / 700);
  ctx.beginPath();
  for (var i = 0; i < N; i++) {
    var p = pad + i * gap;
    ctx.moveTo(pad, p); ctx.lineTo(pad + gap * (N - 1), p);
    ctx.moveTo(p, pad); ctx.lineTo(p, pad + gap * (N - 1));
  }
  ctx.stroke();

  // 坐标轴：上/下 A..O，左/右 15..1（与 coordName 的「字母 + 15-y」一致）
  ctx.fillStyle = css('--axis');
  ctx.font = Math.max(7, g.axis * 0.5) + 'px "Segoe UI",system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (i = 0; i < N; i++) {
    var cx = pad + i * gap;
    var letter = String.fromCharCode(65 + i);
    ctx.fillText(letter, cx, g.axis * 0.5);
    ctx.fillText(letter, cx, size - g.axis * 0.5);
    var num = String(N - i);
    ctx.fillText(num, g.axis * 0.5, cx);
    ctx.fillText(num, size - g.axis * 0.5, cx);
  }
  // 星位
  ctx.fillStyle = css('--star');
  [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]].forEach(function (s) {
    ctx.beginPath();
    ctx.arc(pad + s[0] * gap, pad + s[1] * gap, Math.max(1.6, gap * 0.09), 0, Math.PI * 2);
    ctx.fill();
  });

  // 热力 / 指导视图色块。
  // ★ 2026-09-19（用户要求）：两种铺法**分开** ——
  //   · AI 视图（AI 方面，G.heat）= **圆形**；色档随**思考时间**变（2/3/4 色，见 heatProfile），
  //     数字仍显示在圆内；AI 落子后整片消失（clearHeat 已有）；
  //   · 指导视图（用户方面，G.coach）= **方形** + 原四色名次档（全展示带数字），
  //     用户落子即消失，等 AI 落定后轮到用户再铺 —— 依次循环；
  //   · 五子连珠（G.over）后两者都不再评估、不再出现（refreshHeat / refreshCoach 闸门）。
  var HEAT4 = HEAT_PAL[2];                                 // 指导视图固定四色
  G.coach.forEach(function (h) {
    ctx.fillStyle = HEAT4[Math.max(0, Math.min(3, h.tier - 1))];
    var s = gap * 0.86;
    ctx.fillRect(pad + h.x * gap - s / 2, pad + h.y * gap - s / 2, s, s);
  });
  // AI 视图（圆形）：**调色板随思考时间档位变** —— 2 色 / 3 色 / 4 色（G.heatColors，见 heatProfile）。
  var hpal = HEAT_PAL[Math.max(0, Math.min(2, (G.heatColors || 2) - 2))];
  G.heat.forEach(function (h) {
    ctx.fillStyle = hpal[Math.max(0, Math.min(hpal.length - 1, h.tier - 1))];
    ctx.beginPath();
    ctx.arc(pad + h.x * gap, pad + h.y * gap, gap * 0.42, 0, Math.PI * 2);
    ctx.fill();
  });
  // 图例只显示**当前真会用到的档数**：指导视图开着 = 四色；否则跟着 AI 视图的档位（2/3/4）。
  // （否则 2 色档时图例里还挂着「一般 / 劣势」两档，永远不会有格子是那个颜色。）
  if (els.heatLegend) {
    var lgN = S.coach ? 4 : (G.heat.length ? (G.heatColors || 2) : 0);
    if (lgN && els.heatLegend.getAttribute('data-colors') !== String(lgN))
      els.heatLegend.setAttribute('data-colors', String(lgN));
  }

  // ★ 2026-09-20（用户要求）：**鼠标悬浮格提示** —— 指针压在某交叉点周围时，用**浅灰蓝半透明圆角方框**
  //   框住那个格子（提示「点下去就落在这里」；主窗与复盘窗都画）。
  //   · 颜色取**浅灰蓝**（#96A8C4 系）：浅木色 / 深色两套棋盘底色上都看得清，又不抢棋子与热力；
  //   · 坐标换算与 onBoardClick 完全同源（Math.round 取最近交叉点）→ 提示格 = 落子格；
  //   · 画在**棋子之前**：空点上的提示永远清晰，已有子的格子由棋子本身指示，两者不互相盖；
  //   · 纯视觉，不参与命中测试（点击仍走 onBoardClick）。
  //   · ★ 五轮（用户要求）：对局设置新增「预览框」勾选（默认开）—— 关掉就不画这个悬停方块。
  if (G.hover && S.previewOn !== false) {
    var hsz = gap * 0.92, hr = Math.max(2.5, gap * 0.16);
    var hx = pad + G.hover.x * gap - hsz / 2, hy = pad + G.hover.y * gap - hsz / 2;
    ctx.beginPath();
    ctx.moveTo(hx + hr, hy);
    ctx.lineTo(hx + hsz - hr, hy);
    ctx.quadraticCurveTo(hx + hsz, hy, hx + hsz, hy + hr);
    ctx.lineTo(hx + hsz, hy + hsz - hr);
    ctx.quadraticCurveTo(hx + hsz, hy + hsz, hx + hsz - hr, hy + hsz);
    ctx.lineTo(hx + hr, hy + hsz);
    ctx.quadraticCurveTo(hx, hy + hsz, hx, hy + hsz - hr);
    ctx.lineTo(hx, hy + hr);
    ctx.quadraticCurveTo(hx, hy, hx + hr, hy);
    ctx.closePath();
    // ★ 2026-09-22 二轮（用户要求）：识图窗的「修改」模式下，预览框变**浅紫色** ——
    //   一眼区分「现在是在改识别结果，不是在落子」；其余窗口照旧浅灰蓝。
    var hPurple = !!(VIS && VIS.edit);
    // ★ 2026-09-25（用户澄清「不能下的位置是红叉」）：鼠标压在禁手点上 → 预览框变**红色**，
    //   指上去就知道这一手下不了，不用等点了才弹提示。
    var hForbid = (!VIS && !RV_MODE && renjuRule() && forbiddenAt(G.hover.x, G.hover.y));
    ctx.fillStyle = hPurple ? 'rgba(186,152,255,.28)'
      : (hForbid ? 'rgba(226,59,46,.26)' : 'rgba(150,168,196,.20)');
    ctx.fill();
    ctx.strokeStyle = hPurple ? 'rgba(158,120,246,.80)'
      : (hForbid ? 'rgba(226,59,46,.88)' : 'rgba(150,168,196,.66)');
    ctx.lineWidth = Math.max(1.4, gap * 0.055);
    ctx.stroke();
  }

  // 棋子
  // ★ 六轮（用户要求）：棋子稍微变大一点、棋子之间的空隙更小 —— 半径 0.44→0.47 格
  //   （直径占格 88%→94%，相邻棋子间隙 12%→6%），描边/序号/标注仍按比例缩放不受影响。
  var r = gap * 0.47;
  for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
    var c = G.board[y][x];
    if (!c) continue;
    var px = pad + x * gap, py = pad + y * gap;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    if (c === 1) { ctx.fillStyle = css('--blk'); ctx.fill(); ctx.strokeStyle = css('--blk-edge'); }
    else { ctx.fillStyle = css('--wht'); ctx.fill(); ctx.strokeStyle = css('--wht-edge'); }
    // ★ 2026-09-20：棋盘色深浅两套主题**共用同一块**（用户要求：「深色、浅色都用一种棋盘颜色」），
    //   黑子的浅色轮廓自然也就跟主题无关了（见 calc.css 里那段说明）——
    //   统一成一档线宽，两个主题下的棋子长得一模一样，不再按 S.theme 分叉。
    //   ★ 五轮（用户要求，参考 rapfi/Gomocalc）：黑子白边、白子灰边都**再细一档** ——
    //   官方棋子的轮廓只有一发细线（约半径的 3%），描边粗了会显得「描出来」的假。
    ctx.lineWidth = (c === 1) ? Math.max(0.9, gap * 0.026) : Math.max(0.7, gap * 0.016);
    ctx.stroke();
  }

  // ★ 识图「修改」模式的临时图形（2026-09-22 二轮，用户要求；VIS 只在识图窗有内容）：
  //   · 加子流程的**半透明预览子**（VIS.ghosts，0..2 颗，45% 透明度一眼知道还没落定）；
  //   · 两颗齐了 → **虚线框**把它们一起框住（=「再点一下就落定这一对」）；
  //   · 交换模式已选中的第一颗子 → **琥珀色圈**（等对面颜色的第二颗）。
  if (typeof VIS !== 'undefined' && VIS.edit) {
    (VIS.ghosts || []).forEach(function (gp) {
      var px = pad + gp.x * gap, py = pad + gp.y * gap;
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      if (gp.c === 1) { ctx.fillStyle = css('--blk'); ctx.fill(); ctx.strokeStyle = css('--blk-edge'); }
      else { ctx.fillStyle = css('--wht'); ctx.fill(); ctx.strokeStyle = css('--wht-edge'); }
      ctx.lineWidth = Math.max(0.9, gap * 0.026);
      ctx.stroke();
      ctx.restore();
    });
    if (VIS.ghosts && VIS.ghosts.length === 2) {
      var gx = [VIS.ghosts[0].x, VIS.ghosts[1].x], gy = [VIS.ghosts[0].y, VIS.ghosts[1].y];
      var bx0 = pad + Math.min.apply(null, gx) * gap - r - gap * 0.10;
      var by0 = pad + Math.min.apply(null, gy) * gap - r - gap * 0.10;
      var bx1 = pad + Math.max.apply(null, gx) * gap + r + gap * 0.10;
      var by1 = pad + Math.max.apply(null, gy) * gap + r + gap * 0.10;
      ctx.save();
      ctx.setLineDash([Math.max(4, gap * 0.16), Math.max(3, gap * 0.10)]);
      ctx.strokeStyle = '#b58cff';
      ctx.lineWidth = Math.max(1.6, gap * 0.06);
      ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
      ctx.restore();
    }
    if (VIS.swapSel) {
      ctx.save();
      ctx.strokeStyle = '#f0a63c';
      ctx.lineWidth = Math.max(2, gap * 0.08);
      ctx.beginPath();
      ctx.arc(pad + VIS.swapSel.x * gap, pad + VIS.swapSel.y * gap, r * 1.18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ★ 连珠标线（用户要求 2026-09-19，二轮精修）：五子连珠（含长连）后用**天蓝色**标线
  //   把这段连珠连起来。
  //   · ★ 线长 = **首子圆心 → 末子圆心**（二轮要求：不再像初版那样两端外伸 0.9r）；
  //   · ★ 更浅、半透明、更细（globalAlpha 0.68 + 线宽减半）—— 只是点缀，不抢棋子的视觉；
  //   · ★ 图层在「显示序号」的**下面**：这段代码在序号之前绘制，数字压在标线之上；
  //   · 全盘扫（见 findWinLine 注释）→ 复盘窗口里用户自己摆出来的五连同样会标；
  //   · 圆头；颜色取 CSS 变量 --winline（2026-09-20 起深浅共用一档：棋盘色本身与主题无关）。
  var wl = findWinLine(G.board, ruleForRender());
  if (wl) {
    var w0 = wl.cells[0], w1 = wl.cells[wl.cells.length - 1];
    ctx.save();
    ctx.globalAlpha = 0.68;
    ctx.lineCap = 'round';
    ctx.strokeStyle = css('--winline');
    ctx.lineWidth = Math.max(2, gap * 0.07);
    ctx.beginPath();
    ctx.moveTo(pad + w0.x * gap, pad + w0.y * gap);
    ctx.lineTo(pad + w1.x * gap, pad + w1.y * gap);
    ctx.stroke();
    ctx.restore();
  }

  // ★★ 2026-09-24（用户要求）：「在有禁手的规则下，三三、四四以及长连禁手，**不能下的位置
  //   用红色叉来标记**」。只在**连珠系规则（rule 2/6/7）**且**轮到黑方**时画 ——
  //   禁手是黑方独有的限制，轮到白方时那些点白方照下不误，标上去只会误导。
  //   · 判据复用算杀器里那份 RIF 一级判定（vcxForbidden：长连 / 四四 / 三三 / 四三）；
  //   · 只在「贴子点」（切比雪夫 ≤2 内有子）上算 —— 远点不可能是禁手，省掉 200 次全盘扫描；
  //   · 结果按「规则 + 轮到谁 + 棋盘指纹」缓存，paint() 每帧都调也只算一次。
  drawForbiddenMarks(ctx, g);

  // ★ 显示序号（用户要求 2026-09-19）：在棋子上标出它是第几手。
  //   · 只在**主窗口**画（!RV_MODE）：复盘窗刻意不画 —— 「背诵复盘」时序号等于把答案印在盘上；
  //   · 黑子上写白字、白子上写黑字，任何主题下都读得清；
  //   · 号数按 G.moves 的下标 +1，所以悔棋 / 重放之后序号跟着**当前盘面**走；
  //   · 画在连珠标线**之后** → 序号数字压在标线上面（用户二轮要求：标线图层在序号下面）。
  if (numShown() && G.moves.length) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // ★ 2026-09-27（用户意见①）：字号只随格子（gap）走、**去掉 14px 封顶** ——
    //   高分辨率最大化时棋盘格子很大，序号若被钳在 14px 就小得看不清。
    ctx.font = '600 ' + Math.max(7, gap * 0.42) + 'px "Segoe UI",system-ui,sans-serif';
    G.moves.forEach(function (m, i) {
      // ★ 2026-09-22（用户要求）：最后一子的序号不在渐变小字层画 —— 它单独放大、
      //   蓝色、带白描边（见下方「最后一手标记」），与普通序号一眼区分。
      if (i === G.moves.length - 1) return;
      var sx = pad + m.x * gap, sy = pad + m.y * gap;
      // ★ 六轮补丁（用户要求）：「渐变数字挺好看，一同适配到显示序号」——
      //   黑子上浅蓝→浅紫、白子上深青→蓝紫（与前瞻推演子同一族渐变，明度按子色反差调）。
      // ★ 2026-09-27（用户要求）：黑子里**白色**数字、白子里**黑色**数字（渐变彩色作废）
      ctx.fillStyle = (m.c === 1) ? '#ffffff' : '#1a1a1a';
      ctx.fillText(String(i + 1), sx, sy);
    });
  }

  // 热力/指导视图格里的数字 = **评估分数**（用户要求：数字就是评估分数，智子式热力风味）。
  // 画在棋子之后：热力格本来就在空点上，压不掉任何棋子，后画还能保证不被盖住。
  // 字号压到 gap*0.26（钳 8..13）：分数是 3~5 个字符（+350 / -1200 / M3），
  // 比原来只画名次（1 个字）宽得多，不压小就会溢出格子。
  if ((G.heat.length || G.coach.length) && S.mode !== 'place' && S.mode !== 'endgame' && aiDecorOn()) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // ★ 2026-09-27（用户意见①）：去掉 13px 封顶 —— 评估分数字随格子缩放。
    ctx.font = '500 ' + Math.max(8, gap * 0.26) + 'px "Segoe UI",system-ui,sans-serif';
    ctx.lineJoin = 'round';
    var drawHeatNum = function (h) {
      if (!h.ev) return;
      var px = pad + h.x * gap, py = pad + h.y * gap;
      ctx.lineWidth = Math.max(2.4, gap * 0.1);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';    // 白色描边：四档底色上都读得清
      ctx.strokeText(h.ev, px, py);
      ctx.fillStyle = '#241f1a';
      ctx.fillText(h.ev, px, py);
    };
    G.coach.forEach(drawHeatNum);                  // 指导视图（方形）里的数字
    G.heat.forEach(drawHeatNum);                   // 热力图（圆形）里的数字
  }

  // ★ 分析计算（2026-09-27，用户要求）：持续落点评估 —— 空点上：最佳点 = 青色实心圆 +
  //   胶囊边框框住；其余按名次走青→红四色渐变（越差越红、填充越浅），格内小字 = 评估分。
  if (LIVE_AN.items.length && aiDecorOn()) {
    var ln = LIVE_AN.items.length;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    LIVE_AN.items.forEach(function (it, li) {
      var lpx = pad + it.x * gap, lpy = pad + it.y * gap;
      var lpal = LIVE_PAL[liveTier(li, ln)];
      var lcr = r * 0.72;
      ctx.beginPath(); ctx.arc(lpx, lpy, lcr, 0, Math.PI * 2);
      ctx.fillStyle = lpal.fill; ctx.fill();
      if (li === 0) {
        // ★ 2026-09-28（用户要求）：最佳点 = 浅蓝 + 白色描边的**圆形**轮廓（不再用胶囊矩形）
        var lrr = lcr * 1.22;
        ctx.strokeStyle = lpal.ring;                 // 浅蓝
        ctx.lineWidth = Math.max(2.4, gap * 0.10);
        ctx.beginPath(); ctx.arc(lpx, lpy, lrr, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.85)';    // 白色内层，保对比
        ctx.lineWidth = Math.max(1.2, gap * 0.04);
        ctx.beginPath(); ctx.arc(lpx, lpy, lrr, 0, Math.PI * 2); ctx.stroke();
      }
      if (it.ev) {
        ctx.font = '500 ' + Math.max(8, gap * 0.24) + 'px "Segoe UI",system-ui,sans-serif';
        ctx.lineWidth = Math.max(2.2, gap * 0.09);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.strokeText(it.ev, lpx, lpy);
        ctx.fillStyle = '#1d2b30';
        ctx.fillText(it.ev, lpx, lpy);
      }
    });
  }

  // AI 计算中：闪动的「计算点」。复盘是纯摆盘、与 AI 无关 → 一律不画。
  if (G.busy && G.think.length && aiDecorOn()) {
    var t = (Date.now() % 1200) / 1200;
    ctx.strokeStyle = '#7a5af8';
    ctx.lineWidth = Math.max(1.6, gap * 0.07);
    G.think.forEach(function (p, i) {
      var a = 0.25 + 0.6 * (0.5 + 0.5 * Math.sin((t + i / G.think.length) * Math.PI * 2));
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(pad + p.x * gap, pad + p.y * gap, gap * 0.3, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  // ★ 最后一手标记（2026-09-22 用户要求改版）：
  //   · 不显示序号 → **天蓝色实心小圆点**（r*0.22，不遮住棋子本身）；
  //   · 显示序号   → 最后一子的序号**单独放大**、蓝色、白描边（压在小字序号层之上，
  //                  一眼看得出「刚下的是第几手」）。
  if (G.moves.length) {
    var lm = G.moves[G.moves.length - 1];
    var lx = pad + lm.x * gap, ly = pad + lm.y * gap;
    if (numShown()) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      // ★ 2026-09-22 二轮（用户要求）：序号**不要太大** —— 字号与普通序号同档
      //   （gap*0.34），但保留蓝色 + 白描边以示「这是刚下的」；
      //   textAlign/baseline 都是 center/middle，数字就落在棋子正中心。
      //   ★ 2026-09-27（用户意见①）：同样去掉 14px 封顶，随格子缩放。
      ctx.font = '700 ' + Math.max(9, gap * 0.42) + 'px "Segoe UI",system-ui,sans-serif';
      ctx.lineWidth = Math.max(1.6, gap * 0.05);
      ctx.strokeStyle = 'rgba(15,40,60,.35)';   // 极淡暗描边：天蓝字在黑/白子上都读得清
      ctx.strokeText(String(G.moves.length), lx, ly);
      // ★ 2026-09-28（用户要求）：末手数字直接是**天蓝色**（不再白描边 + 黑白填充）
      ctx.fillStyle = css('--winline');
      ctx.fillText(String(G.moves.length), lx, ly);
    } else {
      ctx.fillStyle = css('--winline');             // 天蓝色（与连珠标线同色系）
      ctx.beginPath();
      ctx.arc(lx, ly, Math.max(2.2, r * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 十打：已叫出的候选点（青圈 + 序号，方便数够 10 个）。复盘里不许出现（属开局流程）。
  if (openActive() && aiDecorOn() && OPEN.kind === 'tar' && OPEN.tar && OPEN.tar.called.length) {
    ctx.strokeStyle = '#00bfa5';
    ctx.lineWidth = Math.max(1.6, gap * 0.06);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.max(8, gap * 0.3) + 'px "Segoe UI",system-ui,sans-serif';
    OPEN.tar.called.forEach(function (p, i) {
      var px = pad + p[0] * gap, py = pad + p[1] * gap;
      ctx.beginPath(); ctx.arc(px, py, r * 0.62, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#00bfa5';
      ctx.fillText(String(i + 1), px, py);
    });
  }
  // 背诵复盘：背错位置的粉红圈
  G.missRings.forEach(function (p) {
    ctx.strokeStyle = css('--miss');
    ctx.lineWidth = Math.max(2, gap * 0.09);
    ctx.beginPath();
    ctx.arc(pad + p.x * gap, pad + p.y * gap, r * 1.25, 0, Math.PI * 2);
    ctx.stroke();
  });
  // 开局流程（交换手/山口/塔拉山口）：虚线引导 + 标点。**复盘里一律不画** ——
  // 复盘是与主窗口无关的独立摆盘功能，不该带出「交换手」之类的开局提示（用户要求）。
  if (openActive() && aiDecorOn()) drawOpenGuide(ctx, g, r);

  // ★ 2026-09-20（用户要求）：「计算评估……棋盘上要有一个数字或者说其他数字加字母的表示方式，
  //   看起来是优美的，直观的，简洁的」。
  //   画法照亦心棋盘那一套：每个候选点一枚**实心圆徽标**（名次数字 / 字母 / ≡）+ 圆下方
  //   一枚**评估分小标签**（+458 / -120 / M3）。名次越靠前颜色越暖（红 → 橙 → 琥珀 → 青 → 灰蓝），
  //   一眼分得出「最优 / 次优 / 其它」；白描边保证在牛皮纸黄底上永远清晰。
  //   图层放在**最后**：它是此刻操作的焦点，不该被任何别的东西压住。
  //   复盘窗不画（RV_MODE 由 aiDecorOn 挡掉）—— 那个窗口「不连 AI」，计算评估不在那里跑。
  // ★ 五轮：前瞻推演子画在标注层**下面**——半透明 + 浅色渐变描边（未真正落盘，只是预览）。
  //   浏览位：悬浮某枚代码 > < > 步进 > 全部推演子。
  if (G.fwd && G.fwd.on && G.fwd.line.length && aiDecorOn()) {
    var show = fwdShowIdx();
    // ★ 五轮（用户要求）：算杀（VCF/VCT）有解 → 用**虚线**把杀路逐手串起来标注，
    //   一眼看出这条链怎么走；虚线压在推演子下面，确定过的一段（真子）不再串。
    // ★ 十轮：杀路只串「算杀段」（vcxAt 起）—— 前面引擎推演的那一段不是算杀，不串。
    // ★ 十三轮（用户要求「vcf/vct 的标线利用蓝色，蓝绿色系」）：整族标记换进蓝/蓝绿系 ——
    //   杀路串线 = 蓝、连五 = 深蓝双环、冲四 = 天蓝方框、活三 = 蓝绿圆环（防守手保持极浅灰）。
    if (G.fwd.kind && G.fwd.vcxAt >= 0) {
      ctx.save();
      ctx.setLineDash([Math.max(3, gap * 0.16), Math.max(2.5, gap * 0.12)]);
      ctx.lineWidth = Math.max(1.4, gap * 0.05);
      ctx.strokeStyle = 'rgba(96,146,248,.85)';        // 蓝色杀路串线（蓝/蓝绿系主色）
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      var dashStarted = false;
      var dFrom = Math.max(G.fwd.committed + 1, G.fwd.vcxAt);   // ★ 十轮：从算杀段第一手起串
      for (var di = dFrom; di <= show && di < G.fwd.line.length; di++) {
        var dm = G.fwd.line[di];
        var dxp = pad + dm.x * gap, dyp = pad + dm.y * gap;
        if (!dashStarted) { ctx.moveTo(dxp, dyp); dashStarted = true; }
        else ctx.lineTo(dxp, dyp);
      }
      if (dashStarted) ctx.stroke();
      ctx.restore();
    }
    // ★ 十轮（用户要求「科学的虚线或者其他形状的辅助标记」）★ 十二轮（虚线/方形/圆形浅勾画）
    //   ★★ 十五轮（用户要求「标识简洁一点、参考开源项目/协会的 VCF/VCT 标注」）：**做减法** ——
    //   每颗推演子上本来就印着**手数序号**，杀路走向有蓝色虚线串着，形状再多就乱了。
    //   现在只保留两类**关键威胁**标记（协会杀棋图的习惯：编号 + 只标关键点）：
    //     · 连五(5) → 深蓝**虚线双环**（终点，必标）；
    //     · 冲四(4) → 天蓝**虚线方框**（强制威胁，必标）；
    //     · 活三(3) / 防守应手(0) → **不再画圈**（序号 + 虚线已足够读懂）。
    if (G.fwd.vcxAt >= 0 && G.fwd.vcxMarks.length) {
      for (var mi = 0; mi < G.fwd.vcxMarks.length; mi++) {
        var mk0 = G.fwd.vcxMarks[mi];
        if (mk0.i < G.fwd.vcxAt || mk0.i > show || mk0.i <= G.fwd.committed) continue;
        if (mk0.t < 4) continue;                               // ★ 十五轮：活三/防守手不画圈
        var mpx = pad + mk0.x * gap, mpy = pad + mk0.y * gap;
        ctx.save();
        if (mk0.t >= 5) {                                      // 连五：深蓝虚线双环
          ctx.setLineDash([Math.max(4, gap * 0.30), Math.max(3, gap * 0.18)]);
          ctx.lineWidth = Math.max(1.8, gap * 0.06);
          ctx.strokeStyle = 'rgba(59,108,242,.68)';
          ctx.beginPath(); ctx.arc(mpx, mpy, r * 1.72, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.arc(mpx, mpy, r * 1.22, 0, Math.PI * 2); ctx.stroke();
        } else {                                               // 冲四：天蓝虚线方框
          ctx.setLineDash([Math.max(3.5, gap * 0.22), Math.max(2.5, gap * 0.14)]);
          ctx.lineWidth = Math.max(1.5, gap * 0.052);
          ctx.strokeStyle = 'rgba(88,164,246,.60)';
          var hw = r * 1.62;
          ctx.beginPath(); ctx.rect(mpx - hw, mpy - hw, hw * 2, hw * 2); ctx.stroke();
        }
        ctx.restore();
      }
    }
    for (var fi = 0; fi <= show && fi < G.fwd.line.length; fi++) {
      // ★ 六轮：已经「确定」落上盘的那一段（≤ committed）是真子，不再叠透明推演子；
      //   只画 committed 之后的（它们就是「接下来会怎么走」的预览）。
      if (fi <= G.fwd.committed) continue;
      var fm = G.fwd.line[fi];
      var fx = pad + fm.x * gap, fy = pad + fm.y * gap;
      // ★ 七轮（用户要求）：VCF/VCT 结果 = 复盘序号同款的**标注**（奇数=进攻方，偶数=防守方），
      //   画得更实（0.8）一眼读得出第几手；普通前瞻推演仍用半透明 0.52。
      ctx.globalAlpha = (G.fwd.vcxAt >= 0 && fi >= G.fwd.vcxAt) ? 0.8 : 0.52;   // ★ 十轮：只有算杀段画实
      ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.fillStyle = css(fm.c === 1 ? '--blk' : '--wht'); ctx.fill();
      var gr = ctx.createLinearGradient(fx - r, fy - r, fx + r, fy + r);
      if (fm.c === 1) { gr.addColorStop(0, 'rgba(140,200,255,.95)'); gr.addColorStop(1, 'rgba(190,150,255,.95)'); }
      else { gr.addColorStop(0, 'rgba(120,220,235,.95)'); gr.addColorStop(1, 'rgba(170,190,255,.95)'); }
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = gr;
      ctx.lineWidth = Math.max(1.2, gap * 0.035);
      ctx.stroke();
      // ★ 六轮（用户要求）：推演子上标**手顺序号**，数字本身用渐变色（与描边同族渐变）——
      //   半透明子上一眼读出「第几手」，不用再去代码链里数。
      //   ★ 六轮补丁：「显示序号」开着 → 直接显示它**应有的手数序号**（= 真子的编号规则，
      //     base + 第几手），字号/配色与真子序号同一套（更大也更合理）；关着才用小渐变序号。
      ctx.globalAlpha = 0.98;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (S.showNum) {
        // ★ 2026-09-27（用户意见①）：去掉 14px 封顶
        ctx.font = '600 ' + Math.max(7, gap * 0.42) + 'px "Segoe UI",system-ui,sans-serif';
        var ng2 = ctx.createLinearGradient(fx - r, fy - r, fx + r, fy + r);
        if (fm.c === 1) { ng2.addColorStop(0, '#8ec9ff'); ng2.addColorStop(1, '#d0a8ff'); }
        else { ng2.addColorStop(0, '#17b3d4'); ng2.addColorStop(1, '#7d8fe2'); }
        ctx.fillStyle = ng2;
        ctx.fillText(String(G.fwd.base + fi + 1), fx, fy + 0.5);
      } else {
        ctx.font = '700 ' + Math.max(9, Math.round(r * 0.95)) + 'px "Segoe UI",system-ui,sans-serif';
        var ng = ctx.createLinearGradient(fx - r, fy - r, fx + r, fy + r);
        if (fm.c === 1) { ng.addColorStop(0, '#8ec9ff'); ng.addColorStop(1, '#d0a8ff'); }
        else { ng.addColorStop(0, '#4fd4ea'); ng.addColorStop(1, '#9fb2ff'); }
        ctx.fillStyle = ng;
        ctx.fillText(String(fi + 1), fx, fy + 0.5);
      }
      ctx.globalAlpha = 1;
    }
  }
  if (G.ana.marks.length && aiDecorOn()) {
    // ★ 2026-09-21（用户要求）：「进行计算以及多点分析在棋盘上出现的一些标记应该合理布局，
    //   将这个标记和数字合理归拢，避免与多个标记重叠」。
    //   做法：先把所有徽标圆登记成已占矩形，再给每枚评估分标签在「下 / 上 / 右 / 左」
    //   四个候选位里挑第一个不撞的；四个都撞才回退到下方（此时至少有白描边压得住）。
    var mr = Math.max(6, gap * 0.40);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    var taken = [];
    function hits(a, b) {
      return !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);
    }
    G.ana.marks.forEach(function (mk) {
      if (mk.plain) return;                       // 百分比小字在第二遍统一画（不占圈、不占框）
      var px = pad + mk.x * gap, py = pad + mk.y * gap;
      // ★ 四轮：名次色回归全部圆圈（平衡 ≡ 走紫色档 ANA_BAL）—— 三轮的
      //   「多点分析中性乳白圈」按用户要求作废，多彩才分得出名次。
      //   ★ 五轮：色板曾换「青蓝（1）→ 深红（末）」渐变档。
      //   ★ 2026-09-27（用户意见②）：再换**卡塔狗名次色** —— 1 蓝 / 2 绿 / 3 黄 / 4 橙 / 5+ 红。
      //   ★ 2026-09-27：扫描防守带自定义 col（连续渐变 defendColor），其余标注仍走名次色板。
      var pal = (mk.tier < 0) ? ANA_BAL : ANA_PAL[Math.max(0, Math.min(ANA_PAL.length - 1, mk.tier))];
      if (mk.col) pal = { badge: mk.col, ring: 'rgba(255,255,255,.94)' };
      // ★ 四轮：+M4 / -M6 这类**多字徽标**画成横向胶囊（圆里装不下四个字）；单字徽标仍是圆。
      //   ★ 五轮：inline 双行（徽标 + 评估/百分比同框）走共用度量 —— 胶囊宽按两行文字取 max。
      var mt = mk.inline ? anaInlineMetrics(ctx, mk, mr) : null;
      var multi = mt ? mt.multi : (String(mk.badge).length > 1);
      var pw = mt ? mt.pw : mr * 2, ph = mt ? mt.ph : mr * 2;
      if (!mt && multi) {                          // 非 inline 的老路径：胶囊按徽标文字宽
        // ★ 2026-09-27（用户意见①）：去掉 12px 封顶
        ctx.font = '700 ' + Math.max(8, mr * 0.9) + 'px "Segoe UI",system-ui,sans-serif';
        pw = ctx.measureText(mk.badge).width + mr * 0.9;
        ph = mr * 1.6;
      }
      ctx.beginPath();
      if (multi) {
        if (ctx.roundRect) ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, ph / 2);
        else ctx.rect(px - pw / 2, py - ph / 2, pw, ph);
      } else {
        ctx.arc(px, py, mr, 0, Math.PI * 2);
      }
      ctx.fillStyle = pal.badge; ctx.fill();
      ctx.lineWidth = Math.max(1.6, gap * 0.07);
      ctx.strokeStyle = pal.ring; ctx.stroke();
      taken.push({ x1: px - pw / 2 - 1, y1: py - ph / 2 - 1, x2: px + pw / 2 + 1, y2: py + ph / 2 + 1 });
    });
    G.ana.marks.forEach(function (mk) {
      var px = pad + mk.x * gap, py = pad + mk.y * gap;
      if (mk.plain) {
        // ★ 扫描防守铺的百分比小字：不画圈、以格心为中心，字色冷暖跟估值走，白描边压底
        var pf = Math.max(7, gap * 0.24);
        ctx.font = '600 ' + pf + 'px "Segoe UI",system-ui,sans-serif';
        var palP = (mk.tier < 0) ? ANA_BAL : ANA_PAL[Math.max(0, Math.min(ANA_PAL.length - 1, mk.tier))];
        if (mk.col) palP = { badge: mk.col };   // ★ 2026-09-27：扫描防守小字同走连续渐变
        ctx.lineWidth = Math.max(2, gap * 0.09);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.strokeText(mk.label, px, py);
        ctx.fillStyle = palP.badge;
        ctx.fillText(mk.label, px, py);
        return;
      }
      // ★ 四轮：多点分析的「数字融入评估圆圈」—— 一枚圆里上下两行：名次数字小字在上、
      //   评估小字在下（官方 Gomocalc 的格内遮罩语言，不再圈外飘字）。
      //   ★ 五轮：度量走共用 anaInlineMetrics（与第一遍一字不差），胶囊/圆都支持双行。
      if (mk.inline) {
        var mt = anaInlineMetrics(ctx, mk, mr);
        ctx.fillStyle = '#ffffff';
        if (mk.label) {
          ctx.font = '700 ' + mt.rf + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py - mt.ph * 0.19);
          ctx.font = '600 ' + mt.ef + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.label, px, py + mt.ph * 0.24);
        } else {
          // ★ 2026-09-27（用户意见①）：去掉 14px 封顶
          ctx.font = '700 ' + Math.max(9, mr * 0.9) + 'px "Segoe UI",system-ui,sans-serif';
          ctx.fillText(mk.badge, px, py + 0.5);
        }
        return;
      }
      // 多字徽标字号收一档（与上面画胶囊时的测量同一个公式，字才装得进胶囊）
      // ★ 2026-09-27（用户意见①）：去掉 12/14px 封顶，随徽标半径（=格子）缩放。
      ctx.font = '700 ' + Math.max(8, mr * 0.9) + 'px "Segoe UI",system-ui,sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(mk.badge, px, py + 0.5);
      if (!mk.label) return;
      // ★ 2026-09-27（用户意见①）：去掉 13px 封顶
      var fs = Math.max(8, gap * 0.28);
      ctx.font = '600 ' + fs + 'px "Segoe UI",system-ui,sans-serif';
      var tw = ctx.measureText(mk.label).width, th = fs * 1.1;
      var off = Math.max(4, gap * 0.18);
      var cands = [
        { x: px, y: py + mr + off + th * 0.5 },            // 下
        { x: px, y: py - mr - off - th * 0.5 },            // 上
        { x: px + mr + off + tw / 2, y: py },              // 右
        { x: px - mr - off - tw / 2, y: py },              // 左
      ];
      var pick = null;
      for (var i = 0; i < cands.length && !pick; i++) {
        var c = cands[i];
        var box = { x1: c.x - tw / 2 - 1, y1: c.y - th * 0.62, x2: c.x + tw / 2 + 1, y2: c.y + th * 0.62 };
        var clash = false;
        for (var j = 0; j < taken.length; j++) if (hits(box, taken[j])) { clash = true; break; }
        if (!clash) { pick = c; taken.push(box); }
      }
      if (!pick) pick = cands[0];
      ctx.lineWidth = Math.max(2.6, gap * 0.11);
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.strokeText(mk.label, pick.x, pick.y);
      ctx.fillStyle = '#241f1a';
      ctx.fillText(mk.label, pick.x, pick.y);
    });
  }

}

/** 棋盘上那些「与 AI / 开局流程有关」的装饰要不要画。
 *  ★ 复盘窗口（独立窗口，RV_MODE）是**纯棋盘**：不连 AI，也不该带开局引导 →
 *    整块装饰一律不画（用户要求那个窗口「没有 AI 和规则干扰」）。
 *  ★ 复盘窗里的背诵/回顾（G.review）同理：只画棋盘 + 背错粉红圈。 */
function aiDecorOn() { return !RV_MODE && !G.review; }

/** 交换手规则的棋盘引导（参考现有连珠对局软件的画法）：
 *  · 塔拉山口：虚线方框 = 下一手允许的天元邻域（3×3/5×5/7×7/9×9）+ 角刻线 + 尺寸标注；
 *    十打阶段再从天元向每个已叫候选点拉细虚线，一眼看清「叫点」；
 *  · 山口：天元参考圈 + 黑1→白2→黑3 顺序标注；
 *  · 一手交换：围绕黑 1 画虚线环 + ⇄，示意等待换色决定。 */
function drawOpenGuide(ctx, g, r) {
  var pad = g.pad, gap = g.gap, n = G.moves.length;
  var gc = (css('--guide') || '#3aa0e8');
  var zh = (S.lang !== 'en');
  ctx.save();
  ctx.strokeStyle = gc; ctx.fillStyle = gc;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = Math.max(1.3, gap * 0.045);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '600 ' + Math.max(9, gap * 0.3) + 'px "Segoe UI",system-ui,sans-serif';
  if (OPEN.kind === 'tar') {
    var calling = OPEN.tar && (OPEN.tar.phase === 'call10' || OPEN.tar.phase === 'pickCall');
    var reg = calling ? 4 : tarRegion(n + 1);
    var a = pad + (7 - reg) * gap, b = pad + (7 + reg) * gap;
    ctx.strokeRect(a, a, b - a, b - a);
    ctx.setLineDash([]);                       // 四角刻线（实线短角，标出方框范围）
    var tick = gap * 0.24;
    [[a, a, 1, 1], [b, a, -1, 1], [a, b, 1, -1], [b, b, -1, -1]].forEach(function (c) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1] + c[3] * tick); ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0] + c[2] * tick, c[1]);
      ctx.stroke();
    });
    ctx.fillText((reg * 2 + 1) + '×' + (reg * 2 + 1), pad + 7 * gap, Math.max(g.axis * 0.5, a - gap * 0.55));
    if (OPEN.tar && OPEN.tar.called.length) {  // 十打：天元 → 已叫点的细虚线
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 4]);
      OPEN.tar.called.forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(pad + 7 * gap, pad + 7 * gap);
        ctx.lineTo(pad + p[0] * gap, pad + p[1] * gap);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
  } else if (OPEN.kind === 'yama') {
    ctx.beginPath();
    ctx.arc(pad + 7 * gap, pad + 7 * gap, r * 1.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(zh ? T('guideYama') : T('guideYamaEn'),
                 pad + 7 * gap, Math.max(g.axis * 0.5, pad + 7 * gap - r * 1.6 - gap * 0.55));
  } else if (OPEN.kind === 'swap1' && n >= 1) {
    var f = G.moves[0];
    ctx.beginPath();
    ctx.arc(pad + f.x * gap, pad + f.y * gap, r * 1.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText('\u21c4', pad + f.x * gap, pad + f.y * gap - r * 2.05);
    ctx.fillText(zh ? T('guideSwap') : T('guideSwapEn'), pad + 7 * gap, g.axis * 0.5);
  }
  ctx.restore();
}

/** AI 计算期间跑一个小动画，让「计算点」闪起来。 */
function pulse() {
  if (!G.busy) { G.animId = 0; return; }
  paint();
  G.animId = requestAnimationFrame(pulse);
}
function startPulse() { if (!G.animId) G.animId = requestAnimationFrame(pulse); }

// ---------------------------------------------------------------- 规则 / 胜负
/** 渲染这张棋盘时按**哪条规则**判「长连算不算赢」。
 *  主窗口 = 用户当前选的那条规则；**复盘窗口永远按无禁手（0）** —— 用户明确要求那个窗口
 *  「没有禁手 / 无禁手功能」，所以它一个规则都不读：≥5 就是连珠（"无禁手连珠后也要标"）。 */
function ruleForRender() { return RV_MODE ? 0 : +S.rule; }
/** 某个颜色一手是否要求「**正好五子**」（长连不算赢）。与参考站 gomocalc.com 判定一致：
 *    rule 0/5 自由（长连算赢）；rule 1 标准（长连不算）；rule 2/6/7 连珠（只有黑方长连不算）。
 *  山口 / 塔拉山口走完开局就是普通连珠 → 同 rule 2。 */
function exactFiveFor(rule, moverColor) {
  if (rule === 1) return true;                             // 标准：长连不算赢
  if (rule === 2 || rule === 6 || rule === 7) return moverColor === 1;   // 连珠系：只有黑方长连不算赢
  return false;                                            // 自由（0）/ 一手交换（5）：长连算赢
}
function exactFiveRule(moverColor) { return exactFiveFor(ruleForRender(), moverColor); }
function winAt(b, x, y, c, exactlyFive) {
  var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], d, n, sx, sy, k;
  for (d = 0; d < 4; d++) {
    n = 1;
    for (k = 1; k < N; k++) {
      sx = x + dirs[d][0] * k; sy = y + dirs[d][1] * k;
      if (sx < 0 || sy < 0 || sx >= N || sy >= N || b[sy][sx] !== c) break;
      n++;
    }
    for (k = 1; k < N; k++) {
      sx = x - dirs[d][0] * k; sy = y - dirs[d][1] * k;
      if (sx < 0 || sy < 0 || sx >= N || sy >= N || b[sy][sx] !== c) break;
      n++;
    }
    // 参考站：exactlyFive ? (n === 5) : (n >= 5)
    if (exactlyFive ? (n === 5) : (n >= 5)) return true;
  }
  return false;
}
/** 结算用封装：按当前（复盘窗 = 无禁手）规则自动决定要不要卡「正好五子」。 */
function winCheck(b, x, y, c) { return winAt(b, x, y, c, exactFiveFor(ruleForRender(), c)); }

/** 全盘扫出「成五的那一段」—— 给**天蓝色的连珠标线**用（用户要求：
 *  「五子连珠后、或者说无禁手连珠后，用天蓝色的标线标记这个连珠」）。
 *  返回 {c, dir:[dx,dy], cells:[{x,y}…]}；没有连珠则 null。
 *
 *  ★ 为什么**全盘扫**而不是只看最后一手：复盘窗口的棋盘是从空盘一手手摆出来 / 重放出来的，
 *    也可能是用户自己随手摆出的五连，那时「最后一手」未必是制胜手（重放中途、悔棋后更常见）。
 *  ★ 每个方向只从**段首**起算（前一颗同色子不在这一线上才算段首），所以同一段只统计一次；
 *    长连（例：6 子）按规则决定算不算 —— 算的话整段 6 子都落在标线上（用户说的「无禁手连珠」）。
 *  ★ 规则用 ruleForRender()：主窗口按用户选的规则（连珠黑长连不赢就不画线），
 *    复盘窗口按无禁手（≥5 都画）。 */
function findWinLine(b, rule) {
  var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], d, c, x, y, k, sx, sy, cells, n;
  for (d = 0; d < 4; d++) {
    var dx = dirs[d][0], dy = dirs[d][1];
    for (c = 1; c <= 2; c++) {
      for (y = 0; y < N; y++) {
        for (x = 0; x < N; x++) {
          if (b[y][x] !== c) continue;
          sx = x - dx; sy = y - dy;                     // 段首判定：前一格不在这条线上
          if (sx >= 0 && sy >= 0 && sx < N && sy < N && b[sy][sx] === c) continue;
          cells = [{ x: x, y: y }];
          for (k = 1; k < N; k++) {
            sx = x + dx * k; sy = y + dy * k;
            if (sx < 0 || sy < 0 || sx >= N || sy >= N || b[sy][sx] !== c) break;
            cells.push({ x: sx, y: sy });
          }
          n = cells.length;
          if (exactFiveFor(rule, c) ? (n === 5) : (n >= 5)) return { c: c, dir: [dx, dy], cells: cells };
        }
      }
    }
  }
  return null;
}
/* ---------------------------------------------------------------- 禁手红叉（2026-09-24 用户要求）
 * 「在有禁手的规则下，三三、四四以及长连禁手，不能下的位置用红色叉来标记」。
 *   ★★ 2026-09-25（用户澄清）：**禁手模式里「不能下的位置」= 红叉** —— 这是**模式属性**，
 *   不是「轮到谁」的属性：只要开着连珠系规则，黑方那些禁手点**永远**画红叉，
 *   轮到白方时也照画（它们只是对白方暂时合法，棋手仍需要看见「黑方在这里下不了」）。
 *   轮到白方时整批叉**减淡**（alpha 0.45）作区分：实心 = 这一手就不能走，
 *   淡的 = 黑方受限、白方不受限。
 *   · 只有**连珠系规则**（2 连珠 / 6 山口 / 7 塔拉山口）里黑方才有禁手；
 *     复盘窗（RV_MODE，恒无禁手口径）与终局盘一个叉都不画。
 *   · 判据直接复用算杀器里那份 RIF 一级判定 `vcxForbidden`（长连 ≥6 / 四四 / 三三 / 四三）——
 *     与 VCF/VCT 的避禁手口径**同源**，不会出现「算杀说这里不能下、棋盘上却不说」。
 *   · 只在「贴子点」（切比雪夫 ≤2 内有子）上算：远点不可能是禁手，省掉整盘 225 次扫描；
 *   · 结果按「规则 + 棋盘指纹」缓存，paint() 每帧都调也只算一次。 */
var FB_MARKS = null, FB_KEY = '';
/** 连珠系规则（黑方有禁手）。山口 / 塔拉山口走完开局流程就是普通连珠 → 同 2。 */
function renjuRule() { var r = ruleForRender(); return r === 2 || r === 6 || r === 7; }
/** 当前局面下黑方**不能下**的点：[[x,y],…]；不适用时恒 []。
 *  ★ 2026-09-25：不再要求「轮到黑方」—— 禁手模式一开就标（见上方说明）。 */
function forbiddenMarks() {
  if (RV_MODE || !renjuRule() || G.over) return [];
  var key = S.rule + '#' + boardFp();
  if (FB_MARKS && FB_KEY === key) return FB_MARKS;
  var out = [], b = G.board;
  for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
    if (b[y][x]) continue;
    if (!vcxNearStone(b, x, y)) continue;
    if (vcxForbidden(b, x, y)) out.push([x, y]);
  }
  FB_MARKS = out; FB_KEY = key;
  return out;
}
/** 换规则 / 载入局面后强制重算（缓存键里已有规则与指纹，这里给一个显式作废口子）。 */
function forbiddenMarksInvalidate() { FB_MARKS = null; FB_KEY = ''; }
/** 一把红叉（白描边打底，木底 / 深色底上都读得清）。 */
function drawCross(ctx, cx, cy, e) {
  ctx.beginPath();
  ctx.moveTo(cx - e, cy - e); ctx.lineTo(cx + e, cy + e);
  ctx.moveTo(cx + e, cy - e); ctx.lineTo(cx - e, cy + e);
  ctx.stroke();
}
/** 点 (x,y) 是不是「黑方不能下」的禁手点（复用同一份缓存，零额外计算）。 */
function forbiddenAt(x, y) {
  var mk = forbiddenMarks();
  for (var i = 0; i < mk.length; i++) if (mk[i][0] === x && mk[i][1] === y) return true;
  return false;
}
/** 把禁手点画成红叉（画在棋子/标线之后、序号之前）。
 *  ★ 2026-09-25：轮到白方时整批减淡 —— 那些点对**黑方**是禁手，对白方仍可落子。 */
function drawForbiddenMarks(ctx, g) {
  var mk = forbiddenMarks();
  if (!mk.length) return;
  var pad = g.pad, gap = g.gap, e = Math.max(4, gap * 0.25);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.globalAlpha = (curColor() === 1) ? 1 : 0.45;
  for (var i = 0; i < mk.length; i++) {
    var cx = pad + mk[i][0] * gap, cy = pad + mk[i][1] * gap;
    ctx.strokeStyle = 'rgba(255,255,255,.82)';      // 白描边打底
    ctx.lineWidth = Math.max(3.4, gap * 0.15);
    drawCross(ctx, cx, cy, e);
    ctx.strokeStyle = '#e23b2e';                    // 红叉本体
    ctx.lineWidth = Math.max(2.2, gap * 0.095);
    drawCross(ctx, cx, cy, e);
  }
  ctx.restore();
}

function coordName(x, y) { return String.fromCharCode(97 + x) + (N - y); }

// ---------------------------------------------------------------- ★ 十六轮：攻防必应（权威五子棋次序）
/** 空点 p 是否满足「c 落上去立刻成五」。复用 winAt（四方向连子长度）。 */
function winPoints(b, c, rule) {
  var out = [], x, y, ex = exactFiveFor(rule, c);
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    if (b[y][x]) continue;
    if (winAt(b, x, y, c, ex)) out.push({ x: x, y: y });
  }
  return out;
}
/** 空点 p：c 落上去后**至少还有一个成五点** = 造出了「四」（冲四 / 活四都算）。 */
function fourPoints(b, c, rule) {
  var out = [], x, y;
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    if (b[y][x] || !nearAnyStone(b, x, y)) continue;
    b[y][x] = c;
    var w = winPoints(b, c, rule);
    b[y][x] = 0;
    if (w.length) out.push({ x: x, y: y });
  }
  return out;
}
/** 空点 p：c 落上去造成**活四**（≥2 个成五点）→ 说明 c 已有活三，防守方必须提前占掉其一。
 *  这就是权威次序里的「活三必应」：不应的话对手下一手活四，两头堵不住。 */
function openFourPoints(b, c, rule) {
  var out = [], x, y;
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    if (b[y][x] || !nearAnyStone(b, x, y)) continue;
    b[y][x] = c;
    var w = winPoints(b, c, rule);
    b[y][x] = 0;
    if (w.length >= 2) out.push({ x: x, y: y });
  }
  return out;
}
/** 空点周围 4 格内有子才纳入候选（省算力；成五/成四必然贴着已有棋子）。 */
function nearAnyStone(b, x, y) {
  for (var dy = -4; dy <= 4; dy++) {
    var sy = y + dy;
    if (sy < 0 || sy >= N) continue;
    for (var dx = -4; dx <= 4; dx++) {
      var sx = x + dx;
      if (sx < 0 || sx >= N) continue;
      if (b[sy][sx]) return true;
    }
  }
  return false;
}
/** ★ 落子前的**必应校验**（用户报「点击黑子，白子就让着黑子去赢」的算法修正）：
 *  按五子棋公认的攻防优先级，只有引擎真的漏了才纠正它，绝不喧宾夺主：
 *   ① 自己能连五 → 立刻连（这一手必胜，无需搜索）；
 *   ② 对手有**成五点** → 必须堵（>1 个 = 已被双杀，也只能堵一个）；
 *   ③ 对手一手能造**活四**（即对手已有活三）而自己连四都没有 → 活三必应，占掉其一；
 *   ④ 其余一律听引擎的（保持它的全局判断）。
 *  cands = 引擎候选（按引擎自己的好坏排序），op / of / myFour 由调用方预先算好（省重复扫描）。
 *  返回 {x,y,why} 表示要改走这一点；返回 null 表示沿用引擎候选。 */
function mustAnswer(b, cc, cands, op, of, myFour) {
  // ★★ 廿一轮（用户报「有一方已经五子连珠了，它还在堵」）：**盘面已经有连五 = 胜负已定**，
  //   此时任何「堵」都是无意义的（把已成的五连再延长一点也算“能成五”，会让下面的判断误触发），
  //   一律交回引擎/调用方，绝不主动去堵。
  if (findWinLine(b, engineRule())) return null;
  var i, j, w = winPoints(b, cc, engineRule());
  if (w.length) return { x: w[0].x, y: w[0].y, why: 'win' };            // ①
  // ② 只在**唯一**必堵点时改手（对手有两个以上成五点 = 已被双杀，堵哪个都不改变结果，
  //    那种局面尊重引擎自己的选择；引擎正好选了其中之一就不动它）。
  if (op && op.length === 1) {
    for (i = 0; i < cands.length; i++) {
      if (cands[i].x === op[0].x && cands[i].y === op[0].y) return null;
    }
    return { x: op[0].x, y: op[0].y, why: 'block5' };
  }
  if (of && of.length && !myFour) {                                      // ③
    for (i = 0; i < cands.length; i++) {
      for (j = 0; j < of.length; j++) if (cands[i].x === of[j].x && cands[i].y === of[j].y) return null;
    }
    return { x: of[0].x, y: of[0].y, why: 'block4' };
  }
  return null;                                                           // ④
}

// ---------------------------------------------------------------- 引擎（页面内 AI 桥）
/** ★ AI 后端开关（独立版 / 三件套版共用同一份源码，构建期注入，互不影响）：
 *  · 独立版（默认，无 GB_AI_REMOTE）：页面内 Worker 跑 rapfi wasm（LocalAI），无 :8964；
 *  · 三件套版（build-calculator.js --suite 在 calc.js 顶部注入 var GB_AI_REMOTE = true）：
 *    **保留三件套原本的相互连接逻辑** —— AI 走 HTTP :8964 /api/analyze，与遮罩盘共用
 *    同一个 Web GomokuEngine.exe 后端（引擎由宿主拉起/复用，见 host.cpp 的 GB_SUITE_ENGINE
 *    EnsureEngine）。:8964 响应带 CORS * + PNA 头，跨源 fetch 可直接用。
 *    线程/哈希下拉在远端模式是**共享引擎进程级**配置，训练器不再单独设置（no-op）。 */
var AI_REMOTE = (typeof GB_AI_REMOTE !== 'undefined') && !!GB_AI_REMOTE;
var AI_REMOTE_URL = 'http://127.0.0.1:8964/api/analyze';
/** LocalAI：engine-ai.js（Worker）的主线程桥。
 *  · analyze(body, ms)  → 与原 :8964 /api/analyze 同一返回形状 {candidates,best,forbid,...}；
 *  · Worker 没起来/脚本缺失（测试壳、异常环境）→ 直接 reject → 走原有 engineOffline 路径；
 *  · boot() 在页面就绪时就调（预热：等用户落第一手时引擎早已 boot 完，对齐原 :8964 常驻）；
 *  · 线程档位变更 = terminate 重建 Worker（干净回收全部搜索线程）；哈希 = 引擎热收。 */
var LocalAI = (function () {
  var wk = null, booted = false, lastFail = 0, seq = 0;
  var pend = {};                       // id -> {res, rej, timer}
  var cfgT = 0, cfgKB = 0;             // 与 S.cores / S.hashMB 同步（0 = 自动）
  function failAll(err) {
    for (var k in pend) { clearTimeout(pend[k].timer); try { pend[k].rej(err); } catch (e) {} }
    pend = {};
  }
  function ensure() {
    if (window.__GB_TEST__) return false;    // 测试壳：不起真引擎（等价旧 fetch stub）
    if (wk) return true;
    if (booted && Date.now() - lastFail < 3000) return false;   // 失败 3s 内不反复重建
    booted = true;
    try { wk = new Worker('engine-ai.js'); }
    catch (e) { lastFail = Date.now(); return false; }
    wk.onmessage = function (e) {
      var d = e.data || {};
      if (d.type === 'done' && pend[d.id]) {
        clearTimeout(pend[d.id].timer);
        var r = pend[d.id].res; delete pend[d.id]; r(d.result);
      } else if (d.type === 'fail' && pend[d.id]) {
        clearTimeout(pend[d.id].timer);
        var j = pend[d.id].rej; delete pend[d.id]; j(new Error(d.message || 'engine error'));
      }
      // ★ 2026-09-27（用户要求「仪表盘要有速度和节点等的表示」）：Worker 搜索期间的实时
      //   状态帧（速度/节点/深度/最佳点）—— 交给 onEngineLive 聚合三车道并刷仪表盘。
      else if (d.type === 'live') {
        try { onEngineLive(d); } catch (e2) {}
      }
      // 'ready' 不单独处理：analyze 会等车道 boot 闸。'bootfail' 在纯训练器版（GB_NO_WASM）
      // 有一个必须让用户看见的情况：本机没有原生引擎、也没有 WASM 可回落（引擎资源已按用户
      // 要求移除）→ toast 明确提示一次，别让用户只看到「AI 不动」。
      else if (d.type === '__host') {
        // ★ 新引擎后端：Worker 要发给宿主的引擎命令，由主线程经 chrome.webview 转发
        //   （Worker 里拿不到 chrome.webview，见 engine-ai.js 顶部注释）。
        try { tellHost(d.payload); } catch (e) {}
      } else if (d.type === 'bootfail') {
        booted = false; lastFail = Date.now();
        if (String(d.message || '').indexOf('NO_NATIVE_NO_WASM') >= 0 && !window.__GB_noNativeShown__) {
          window.__GB_noNativeShown__ = true;
          try { toast(T('noNativeEngine')); } catch (e) {}
        }
      }
    };
    wk.onerror = function () {
      failAll(new Error('engine worker failed'));
      try { wk.terminate(); } catch (e) {}
      wk = null; booted = false; lastFail = Date.now();
    };
    // ★ 新引擎后端：把「本机能不能走 WebView 消息通道」带给 Worker —— 能走就不再用
    //   HTTP 轮询取引擎输出（见 engine-ai.js 顶部「新连接后端」注释）。
    wk.postMessage({ type: 'boot', threads: cfgT, hashKB: cfgKB, relay: HOST });
    return true;
  }
  /** 三件套版远端后端：直接 POST :8964 /api/analyze（与原书签版同一条通道）。
   *  返回形状与 LocalAI 完全一致（引擎同一套协议），上层 analyze() 无感。 */
  function remoteAnalyze(body, ms) {
    return new Promise(function (res, rej) {
      if (window.__GB_TEST__) { rej(new Error('stub: no engine in test')); return; }
      var done = false, ctl = null;
      try { ctl = new AbortController(); } catch (e) { ctl = null; }
      var t = setTimeout(function () {
        if (done) return; done = true;
        try { if (ctl) ctl.abort(); } catch (e) {}
        rej(new Error('timeout'));
      }, ms || 20000);
      fetch(AI_REMOTE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      }).then(function (r) {
        if (!r.ok) throw new Error('engine http ' + r.status);
        return r.json();
      }).then(function (j) {
        if (done) return; done = true; clearTimeout(t); res(j);
      }).catch(function (e) {
        if (done) return; done = true; clearTimeout(t); rej(e);
      });
    });
  }
  var liveSeq = 0;
  return {
    boot: AI_REMOTE ? function () {} : ensure,          // 远端：引擎是共享进程，页面无需预热
    isReady: function () { return AI_REMOTE ? true : !!wk; },
    /** ★ 2026-09-27：live 实时帧的关联 id —— analyze() 每次请求取一个，Worker 回帧原样带回。 */
    nextLiveId: function () { return ++liveSeq; },
    analyze: function (body, ms) {
      if (AI_REMOTE) return remoteAnalyze(body, ms);
      return new Promise(function (res, rej) {
        if (window.__GB_TEST__) { rej(new Error('stub: no engine in test')); return; }
        if (!ensure()) { rej(new Error('engine unavailable')); return; }
        var id = ++seq;
        var t = setTimeout(function () {
          if (pend[id]) { delete pend[id]; rej(new Error('timeout')); }
        }, ms || 20000);
        pend[id] = { res: res, rej: rej, timer: t };
        try { wk.postMessage({ type: 'analyze', id: id, body: body }); }
        catch (e) { clearTimeout(t); delete pend[id]; rej(e); }
      });
    },
    config: function (threads, hashMB) {
      if (AI_REMOTE) return;   // 远端共享引擎：线程/哈希是引擎进程级配置，训练器不单独设
      var tChanged = (threads || 0) !== cfgT;
      cfgT = threads || 0; cfgKB = (hashMB || 0) * 1024;
      if (!wk) return;
      if (tChanged) {
        // 线程数变更必须重建（原架构 = 重启引擎进程，等价迁移）
        failAll(new Error('engine restarting'));
        try { wk.terminate(); } catch (e) {}
        wk = null; booted = false;
        ensure();
      } else {
        try { wk.postMessage({ type: 'hash', hashKB: cfgKB }); } catch (e) {}
      }
    },
    /** ★ 新引擎后端：把宿主推来的引擎消息（输出 / 回执）转发进 Worker。
     *  Worker 收不到 chrome.webview 的 message 事件，必须经主线程这一跳。 */
    relay: function (m) {
      if (!wk) return;
      try { wk.postMessage({ type: '__relay', payload: m }); } catch (e) {}
    },
  };
})();

/** ★★ Rapfi 官方分值口径（依据 tools/rapfi-src/Rapfi/core/types.h + core/iohelper.cpp，
 *  并对本机原生引擎实测过：`INFO EVAL -223` / `+M15` 就是这两种输出）：
 *   · VALUE_MATE = 30000；VALUE_MATE_IN_MAX_PLY = 29500（给最长杀留 500 步余量）；
 *   · 非杀棋评估钳在 **±6000**（VALUE_EVAL_MAX / VALUE_EVAL_MIN），这是官方的上限；
 *   · 杀棋按官方记法输出：`+M12` = 30000-12（自己还有 12 步赢）、`-M6` = -(30000-6)；
 *     `+M*` / `-M*` = 开局库里查到的杀（= VALUE_MATE_FROM_DATABASE = 30000-500）。
 *  ⇒ 以前自造的「+M12 → 1012」是拍脑袋换算：它和真实评估撞车（真实 +1012 与「12 步杀」
 *    画在曲线上同一个点），还把纵轴死死压在 ±1250 里 —— 官方非杀棋能到 ±6000，
 *    于是大半条曲线被钳在轴顶/轴底画成一条直线（这也是「曲线效果一般」的一半原因）。
 *  现在一律用官方编码；纵轴的档位也照官方 ±6000 放开（见 CURVE_TIERS）。 */
var RAPFI_MATE = 30000;          // VALUE_MATE
var RAPFI_MATE_MAX_PLY = 500;    // VALUE_MATE - VALUE_MATE_IN_MAX_PLY
var RAPFI_EVAL_MAX = 6000;       // VALUE_EVAL_MAX（官方非杀棋评估上限）
function evalNum(ev) {
  if (ev === null || ev === undefined) return NaN;
  var s = String(ev).trim();
  if (!s || /^(VAL_NONE|VAL_INF|-VAL_INF)$/i.test(s)) return NaN;
  var m = /^([+-]?)M(\d+|\*)$/i.exec(s);
  if (m) {
    var ply = (m[2] === '*') ? RAPFI_MATE_MAX_PLY
                             : Math.max(1, Math.min(RAPFI_MATE_MAX_PLY, parseInt(m[2], 10)));
    var mv = RAPFI_MATE - ply;
    return (m[1] === '-') ? -mv : mv;
  }
  var v = parseFloat(s.replace('+', ''));
  if (isNaN(v)) return NaN;
  return Math.max(-RAPFI_EVAL_MAX, Math.min(RAPFI_EVAL_MAX, v));
}

/** 局面指纹：热力请求回来时用它判断「这盘还是不是当初那盘」。
 *  只取手数 + 最后一手坐标，够用且零成本（撤销后改下别处也能识别出来）。 */
function boardFp() {
  var n = G.moves.length, l = n ? G.moves[n - 1] : null;
  return n + ':' + (l ? l.x + ',' + l.y : '-');
}
/** 把引擎的 eval 字符串压成**格内可显示的分数字**（用户要求：热力格里的数字 = 评估分数）。
 *  数值 → 带符号整数（+350 / -120）；杀棋照 rapfi 原本的记法保留步数：
 *  +M12 = 还有 12 步赢、-M6 = 还有 6 步输（2026-09-20 三轮用户要求：+ 号要留着）。 */
function fmtEval(ev) {
  var s = String(ev == null ? '' : ev).trim();
  if (!s) return '';
  var m = /^([+-]?)M(\d+)$/i.exec(s);
  if (m) return (m[1] === '-' ? '-' : '+') + 'M' + m[2];
  var n = parseFloat(s.replace('+', ''));
  if (isNaN(n)) return s.slice(0, 5);
  return (n > 0 ? '+' : '') + Math.round(n);
}
function pushCurve(ply, vFromMover, moverIsBlack) {
  var b = moverIsBlack ? vFromMover : -vFromMover;
  G.curve = G.curve.filter(function (p) { return p.i !== ply; });
  G.curve.push({ i: ply, b: b, w: -b });
  G.curve.sort(function (a, c) { return a.i - c.i; });
}

/** 给引擎的规则号。山口 / 塔拉山口只是**开局流程**，流程走完就是普通连珠（有禁手）→ 2。 */
function engineRule() {
  var r = +S.rule;
  if (r === 6 || r === 7) return 2;
  return (r === 0 || r === 1 || r === 2 || r === 5) ? r : 0;
}

/** ★ 十六轮新增第 4 参 side（1 黑 / 2 白；不传 = 0 → 引擎沿用老口径）：
 *  残局自由摆盘 / 识图 VC 补充子会让黑白子数不均衡（例 30 黑 + 10 白），
 *  此时引擎按「末子反色」推出的行棋方与界面的「总子数奇偶」相反（实测 bn=30/wn=10 →
 *  引擎报 -M6，即它以为轮到白走）。显式 side 可让引擎与界面口径强制一致 ——
 *  「白子让着黑子去赢」的根因修复，见 engine-ai.js 的 applySideToMove 长注释。 */
/** ★ 2026-09-27 新增第 5 参 tag（「AI 落子」「多点分析」这类功能名，可空）：
 *  随 body 下发 → Worker 的 live 实时帧原样带回 → 引擎仪表盘显示「计算中 · <功能名>」，
 *  多实例并行时速度/节点自动累加（主搜 + 视图小实例的算力一目了然）。 */
async function analyze(turnMs, topN, lane, side, tag) {
  var ply = G.moves.length;
  try {
    var r = await LocalAI.analyze({
      board: G.board, moveList: [],
      matchMs: 600000, turnMs: turnMs, timeUsedMs: 0,
      topN: topN, rule: engineRule(), cid: 'calc-' + ply + (lane ? '-' + lane : ''),
      lane: lane || 'main', side: (side === 1 || side === 2) ? side : 0,
      liveId: LocalAI.nextLiveId(), tag: tag || '',
    }, Math.max(9000, turnMs + 9000));
    if (G.engineOffline) { G.engineOffline = false; G.retryLeft = null; refreshUI(); }   // 引擎又活了
    return r;
  } catch (e) {
    // ★ 引擎没应答：以前这里只是让 aiMove 的 catch 报一句「未连接」，而 refreshUI 又会
    //   因为「轮到 AI」把药丸写回「AI 思考中…」→ 看着像永远在思考（用户实测症状）。
    //   现在统一在这里记离线 + 喊宿主补拉 + 安排自动重试。
    if (!RV_MODE && !G.review) noteEngineDown();
    throw e;
  }
}

/* ==================== 引擎裁决层（★ 2026-09-27 深夜：多引擎投票撤销，单实例满线程） ==================== */
/**
 * ★ 用户要求原文（2026-09-27 深夜）：
 *   「取消多选的投票的按键以及这个功能，直接单实例满线程加预热」；
 *   「加强对于裁决层的稳定性的优化，这是突破整合包智力的关键」；
 *   「根据一些比较好的开源项目，用的是新版本的原生引擎」「以及后手的稳定性的注重」；
 *   「默认时通过微小官方的预热方法来增加后手稳定性」。
 *
 * 现口径（对齐 Rapfi / KataGo「算力集中一路」的结论）：
 *  · 引擎 = **单实例**（main 车道）吃满「核心数」里用户选的全部线程与大哈希
 *    （engine-ai.js / engine-server.js 的 laneSpecs）；sub / fwd 降为各 1 线程的小实例，
 *    专供热力图 / 指导视图 / 前瞻推演实时铺显（用户选定保留，总线程仅 +2）。
 *  · **裁决层只做确定性裁定**：① 引擎头名；② 必应护栏（能连五就连五 → 对手成五必堵 →
 *    活三必应，见 mustAnswer）；③ 预热命中直接采用。不再有任何投票/合票 ——
 *    弱车道浅搜再也不能掀翻主力深搜的头名，选点从「会跳」变成「钉死」。
 *  · analyzeVote 退化为薄壳（函数名与调用点保留，skip 参删除）：
 *    预热命中（ponder hit）直接用成品 —— 零等待；否则原路单发 analyze。
 */
async function analyzeVote(turnMs, topN, side, warm, lone, tag) {
  if (warm && warm.candidates && warm.candidates.length) return warm;
  return analyze(turnMs, topN || 1, lone || null, side, tag);
}

/* ---------------- 后台预热（对手思考时持续计算） ---------------- */
/** 「后台预热」是否真的该跑：默认开；只有明确关掉的场合不跑。 */
function preheatOn() {
  if (S.preheat !== true) return false;    // ★ 09-28 口径：默认关（大预热），勾选后才跑（微小官方 ponder）
  if (RV_MODE || G.review || G.over || G.busy) return false;
  if (S.mode !== 'pve' || S.paused) return false;
  if (openActive() || G.engineOffline) return false;
  if (!LocalAI.isReady()) return false;
  return true;
}
/**
 * preheatOn = **硬门槛**（开关被关／不在对弈／轮不到）→ 触发必然撤掉轮询。
 * preheatWanted = 硬门槛 **加「礼让」**：用户此刻正在自己做正经计算时不抢。
 *   · G.ana.busy        —— 计算评估里任一项目（计算 / 多点分析 / 平衡 / 扫描防守）在跑；
 *   · G.ana.defRefining —— 扫描防守的引擎精修链（占着 fwd 车道）；
 *   · G.fwd.busy        —— 前瞻推演（同样占着 fwd 车道）。
 *   礼让与撤表分开处理：轮询照常跳（只是这一拍不出手），等用户那份算完立刻自动续上 ——
 *   不能像旧写法那样一见 wanted=false 就停表，否则点一次「计算」就把本回合的预热报废了。
 */
function preheatWanted() {
  if (!preheatOn()) return false;
  if (aiVsAi() || humanBoth()) return false;
  if (G.ana.busy || G.ana.defRefining) return false;
  if (LIVE_AN.on) return false;             // ★ 09-28 晚：分析计算占用主车道 → 预热让位
  if (G.fwd && G.fwd.busy) return false;
  return !isAiColor(curColor());
}
/** 复制盘面并落一子（不碰真实棋局） */
function boardStone(b, x, y, c) {
  var nb = [];
  for (var i = 0; i < N; i++) nb.push(b[i].slice(0));
  nb[y][x] = c;
  return nb;
}
var PREHEAT = { gen: 0, busy: false, cache: {}, timer: 0, lastPv: null };   // ★ lastPv = AI 上一搜 PV 预测的应手（ponder 种子）
/**
 * 预热一轮（★ 2026-09-27 深夜：微小官方 ponder 版）。
 *   ① **预测应手** —— 主源 = AI 上一搜主变量（PV）的第 2 步：AI 落子时它的搜索线早已
 *      「向前多看几步」，线里第 2 步就是它预计你要下的点。全深度、零成本 —— 这正是
 *      Rapfi / gomocalc 的官方 ponder 思路（不再像旧版那样先花 1/4 预算浅探一轮）。
 *      无 PV 可用（开局首手 / 悔棋 / 载入）才退回旧探测。
 *   ② **替 AI 预搜应手** —— 对预测点之后的局面用微小预算深搜（PREHEAT_MAX_MS 封顶），
 *      按应手点缓存；命中（你真下这点）= ponder hit，AI 秒答；未命中缓存作废，
 *      但置换表是热的 —— 正式搜索同样提速。主打**后手稳定性**：后手每手冷启动，
 *      ponder 的收益对白方尤其明显。
 * ★★ 预热跑在 main 车道（单实例架构下就是唯一主搜实例）：只有它的置换表会被 AI 落子那手
 *     用到；每轮预算封顶 PREHEAT_MAX_MS，由空闲轮询反复发起 —— 多轮叠加等效加深，
 *     任何时刻被打断的最坏代价只有一轮（laneSerial 无取消接口）。
 */
var PREHEAT_MAX_MS = 4000;
/** PV 应手点校验：必须是当前手数下、盘面上的空点（防过期 / 防占位）。 */
function preheatPvPick(ply0) {
  var pv = PREHEAT.lastPv;
  if (!pv || pv.ply !== ply0) return null;
  var p = pv.pick;
  if (!p || p.x < 0 || p.y < 0 || p.x >= N || p.y >= N || G.board[p.y][p.x]) return null;
  return p;
}
async function preheatRound() {
  if (!preheatWanted() || PREHEAT.busy) return;
  PREHEAT.busy = true;
  var my = ++PREHEAT.gen;
  try {
    var opp = curColor(), mine = 3 - opp;
    var ply0 = G.moves.length;
    if (!ply0) return;                             // 空盘：没有「对手正在思考」这一说
    // ① 预测应手：先吃 PV 种子（零成本），没有才花一次浅探（预算 1/4，兜底用）
    var picks = [];
    var pvPick = preheatPvPick(ply0);
    if (pvPick) {
      picks.push({ x: pvPick.x, y: pvPick.y });
    } else {
      var probeMs = Math.max(400, Math.min(2500, Math.round((S.turnMs || 2000) * 0.25)));
      // ⚠ 用 LocalAI.analyze 而不是 analyze()：后者失败会 noteEngineDown() → 空闲期
      //   一次预热失败就把药丸写成「引擎未连接」，那是对用户的谎报。预热失败静默即可。
      var r0 = await LocalAI.analyze({
        board: G.board, moveList: [], matchMs: 600000, turnMs: probeMs, timeUsedMs: 0,
        topN: 3, rule: engineRule(), cid: 'preheat-probe-' + ply0, lane: 'main', side: opp,
        liveId: LocalAI.nextLiveId(), tag: T('tagPreheat'),
      }, Math.max(9000, probeMs + 9000)).catch(function () { return null; });
      if (my !== PREHEAT.gen || !preheatWanted()) return;
      if (G.moves.length !== ply0) return;
      picks = ((r0 && r0.candidates) || []).slice(0, 2).filter(function (c) {
        return c.x >= 0 && c.y >= 0 && c.x < N && c.y < N && !G.board[c.y][c.x];
      });
    }
    if (!picks.length) return;
    // ② 对预测应手之后的局面替 AI 预搜（★ 09-28 口径：**收敛式渐进升级**，不再「算到一半
    //    就重头再来」）：同一预测点的多轮预热逐轮升级 —— 预算从 0.9× 起步、每轮 ×2、封顶
    //    PREHEAT_MAX_MS；同一实例的置换表在轮间持续变热 → 后一轮等效更深；结果**只升不降**
    //    （新结果更深才替换缓存，否则保留旧结果继续加深）。
    for (var i = 0; i < picks.length; i++) {
      if (my !== PREHEAT.gen || !preheatWanted()) return;
      var pk = picks[i];
      if (G.moves.length !== ply0 || G.board[pk.y][pk.x]) return;   // 局面已经变了 → 整轮作废
      var prev = PREHEAT.cache[pk.x + ',' + pk.y];
      var round = (prev && prev.ply === ply0) ? Math.min(8, prev.round || 1) : 1;
      var deep = Math.max(900, Math.min(PREHEAT_MAX_MS, Math.round((S.turnMs || 2000) * 0.9) * round));
      var nb = boardStone(G.board, pk.x, pk.y, opp);
      var rr = await LocalAI.analyze({
        board: nb, moveList: [], matchMs: 600000, turnMs: deep, timeUsedMs: 0,
        topN: 2, rule: engineRule(),
        cid: 'preheat-' + (ply0 + 1) + '-' + pk.x + ',' + pk.y + '-' + round,
        lane: 'main', side: mine,
        liveId: LocalAI.nextLiveId(), tag: T('tagPreheat'),
      }, Math.max(9000, deep + 9000)).catch(function () { return null; });
      if (my !== PREHEAT.gen || !preheatWanted()) return;
      if (rr && rr.candidates && rr.candidates.length) {
        var newD = (rr.candidates[0] && rr.candidates[0].depth) || 0;
        var oldD = (prev && prev.r && prev.r.candidates && prev.r.candidates[0] && prev.r.candidates[0].depth) || -1;
        if (newD >= oldD) PREHEAT.cache[pk.x + ',' + pk.y] = { ply: ply0, after: [pk.x, pk.y], r: rr, ts: Date.now(), round: round + 1 };
        else if (prev) { prev.ts = Date.now(); prev.round = round + 1; }   // 新结果反而浅 → 保旧继续加深
      }
    }
  } catch (e) { /* 预热失败不影响对局 —— 静默 */ }
  finally { PREHEAT.busy = false; }
}

/** 开局 —— 何时放行已经在 preheatWanted() 里判完了，这里只负责「起来并保持运行」。
 *  采用**空闲轮询**（每 700ms 看一眼）而不是 promise 链递归：中间用户可以随时落子，
 *  任何一处状态变化都会让 preheatWanted() 转为 false，循环自行退出。 */
function maybePreheat() {
  if (!preheatWanted() || PREHEAT.timer) return;
  PREHEAT.gen++; PREHEAT.cache = {};
  PREHEAT.timer = setInterval(function () {
    // 硬门槛没了（开关关掉 / 换模式 / 轮到 AI）→ 收摊；
    // 只是暂时礼让（用户在算东西）→ 表不停，下一拍再看 —— 见 preheatWanted 的注释。
    if (!preheatOn()) { preheatStop(false); return; }
    if (!PREHEAT.busy && preheatWanted()) preheatRound();
  }, 700);
  preheatRound();
}
function preheatStop(drop) {
  if (PREHEAT.timer) { clearInterval(PREHEAT.timer); PREHEAT.timer = 0; }
  PREHEAT.gen++;                       // 让还在飞的那一轮作废
  if (drop) PREHEAT.cache = {};
}
/** 对手真的落到这里了吗？是 → 把预热好的成品交出去（形如 analyze 的返回）。
 *  ⚠ 必须同时对上**手数**与**坐标**：任一不符都说明盘面已经不是当初预热的那一个了。
 *  ⚠ 取走即销毁：这份答案是给「紧接着的这一手」用的，留着下次用会过期。 */
function preheatTake(x, y) {
  var c = PREHEAT.cache[x + ',' + y];
  if (!c) return null;
  PREHEAT.cache = {};                                  // 同ply 的其它分支一并作废
  if (c.ply + 1 !== G.moves.length) return null;
  if (Date.now() - c.ts > 120000) return null;   // 放太久，局面的参考价值已打折
  return c.r;
}

/** ★ 2026-09-25（**算法层**的时间分配，不是堆算力）：AI 落子这一手**该想多久**。
 *
 *  背景（读 Rapfi 源码得出的结论，别再凭感觉调）：
 *  · Rapfi 自带一套按局面重要度分配时间的机制 —— `search/timecontrol.cpp` 里的
 *    `moveImportance(ply)`、最佳着稳定性（`bestMoveInstability`）、评估振荡（`fallingFactor`）；
 *  · 但那条支路**只在 `ampleMatchTime == false` 时才生效**，判据是
 *      `turnTime × min(剩余手数, moveHorizon=64) < 比赛剩余时间`；
 *    我们每手都发 `TIMEOUT_MATCH 600000`（10 分钟），5000ms × 64 = 32 万 < 60 万
 *    ⇒ **恒为真** ⇒ 引擎的自适应时间管理**从来没启用过**，每一手都机械地用掉同样多的时间。
 *  · 那能不能改小 matchMs 去启用它？不能 —— 启用后 `turn = maximumTime / 1.7 × moveImportance`
 *    会把单手时间压到约 0.59×turnMs，再被 `maximumTime / timeDivisor(depth)` 封到 1~2 秒，
 *    **反而更少**（实测它只在「最佳着已经稳定」时省时间，关键手却因 depth 项被封顶）。
 *    所以正确做法是：**保持 ample 模式（把时间用满）+ 由应用层补上重要度加权**。
 *
 *  于是这里按**对方的威胁等级**加权（用现成的、已被大量回归覆盖的威胁检测，不新造轮子）：
 *    ① 对手**已成四**（下一手就能连五）→ 必须算清堵哪一点：×1.5；
 *    ② 对手有**活三**（再走一手就活四）→ 活三必应：×1.25；
 *    ③ 我方已成四 / 有活四 = 轮到我们收官，引擎一搜就有 → ×0.8，把省下的时间让给 ①②；
 *    ④ 其余局面就是用户设的那个值。
 *  · ★ **有增有减、均值守恒**：不能只增 —— 「只增」试过，`fourPoints()`（对手有三）在中局
 *    几乎每手都非空，加成会退化成「全局 ×1.35」，那就只是偷偷把用户设的思考时间调大了
 *    （实测自动对弈同样 24 秒只走 13 手，原来 19~21 手 —— 是变慢，不是变强）。
 *    现在「被叫杀时多想、收官时少想」，平均下来仍 ≈ 用户设的值。
 *  · 全部是 O(空点) 的棋盘扫描（单次 < 1ms），相对几秒的搜索可以忽略。
 */
function aiTurnBudget() {
  var base = Math.max(300, S.turnMs || 2000);
  var me = curColor(), op = 3 - me, rule = engineRule();
  if (winPoints(G.board, op, rule).length) return Math.round(base * 1.5);
  if (openFourPoints(G.board, op, rule).length) return Math.round(base * 1.25);
  if (winPoints(G.board, me, rule).length || openFourPoints(G.board, me, rule).length)
    return Math.round(base * 0.8);
  return base;
}

/** 热力图时间预算。照书签版的分流：**落子走 main 车道（全额 turnMs 深搜）**，
 *  热力走 sub 车道（只给一半、钳 900~4000ms）→ 热力图总在 AI 还在深搜时就先回来。 */
function heatBudget() {
  var base = (S.turnMs || 2000) * 0.5;
  return Math.max(900, Math.min(4000, Math.round(base)));
}

/** ★ 2026-09-20（用户要求）：AI 视图按**思考时间**自适应档位 —— 时间短就少色少点（保证智力与速度），
 *  时间长的档位才铺满四色、放宽范围、评估的落点相应变多（对标 https://www.gomocalc.com/#/ ）：
 *   · turnMs < 3.0s → 2 色 / 最多 3 个落点。多数时候只有 1~2 个：可能就一个「确定的一手」，
 *                     也可能两三个旗鼓相当的落点 —— 引擎给几个就画几个，不硬凑颜色。
 *   · 3.0 ~ 4.5s   → 3 色 / 最多 6 个落点（过渡档）。
 *   · > 4.5s       → 4 色 / 最多 8 个落点（范围放大，落点更多）。
 *  档位只决定「画几个点、用几种颜色」；热力依旧在 AI **思考期间**就铺到棋盘上（边想边算），
 *  数值就是该点的评估分，AI 落子即消失（refreshHeat / clearHeat 的生命周期不变）。 */
function heatProfile() {
  var t = S.turnMs || 2000;
  if (t < 3000) return { colors: 2, topN: 3 };
  if (t <= 4500) return { colors: 3, topN: 6 };
  return { colors: 4, topN: 8 };
}

/** AI 视图（圆形热力）的调色板：下标 = 用几色（2/3/4）；四色那一档与指导视图同色。 */
var HEAT_PAL = [
  ['rgba(0,191,165,.66)', 'rgba(120,200,80,.50)'],
  ['rgba(0,191,165,.66)', 'rgba(120,200,80,.50)', 'rgba(255,179,193,.55)'],
  ['rgba(0,191,165,.60)', 'rgba(120,200,80,.55)', 'rgba(255,179,193,.55)', 'rgba(255,200,215,.42)'],
];

/** ★ 2026-09-27（用户意见②）：「推荐选点的颜色区分非常混乱……建议模仿卡塔狗的颜色设定，
 *  1选为蓝色、2选为绿色、3选为黄色」—— 名次色板整体换成 KataGo/Lizzie 同款：
 *  1 蓝 → 2 绿 → 3 黄 → 4 橙 → 5 及以后深红。前三名高辨识三色，低名次自然过渡到暖色，
 *  与扫描防守的青→红「危险度渐变」各说各的事，不再互相串色。
 *  ring 是徽标外圈的白描边（牛皮纸黄底上，只有描边才能保证任何色块都看得清）。
 *  ANA_BAL 是「平衡」专用的一档（≡ 徽标，不占名次色）—— 旧绿色与 2 选撞色，改紫。 */
var ANA_PAL = [
  { badge: 'rgba(25,118,210,.95)',  ring: 'rgba(255,255,255,.95)' },   // 1 选 · 蓝（KataGo 名次色）
  { badge: 'rgba(56,142,60,.95)',   ring: 'rgba(255,255,255,.95)' },   // 2 选 · 绿
  { badge: 'rgba(235,180,20,.95)',  ring: 'rgba(255,255,255,.95)' },   // 3 选 · 黄
  { badge: 'rgba(224,110,20,.95)',  ring: 'rgba(255,255,255,.95)' },   // 4 选 · 橙
  { badge: 'rgba(176,32,32,.95)',   ring: 'rgba(255,255,255,.95)' },   // 5+ · 深红
];
var ANA_BAL = { badge: 'rgba(124,77,255,.95)', ring: 'rgba(255,255,255,.95)' };

/** ★ 五轮：inline 双行徽标的**共用度量**（paint 两遍都要用它，字号/盒宽必须算得一字不差）。
 *  · 单字徽标（多点分析的名次数字）→ 圆，双行 = 数字在上、评估在下；
 *  · 多字徽标（扫描防守的 W4/L6）→ **胶囊**，双行 = W/L 在上、百分比在下
 *    （用户要求：前三名「更靠近胶囊型和圆形」，百分比融进徽标本体，不再圈外飘字）。
 *  返回 { multi, rf, ef, pw, ph }：rf/ef = 两行字号，pw/ph = 占位盒尺寸。 */
function anaInlineMetrics(ctx, mk, mr) {
  var multi = String(mk.badge).length > 1;
  // ★ 2026-09-27（用户意见①）：去掉 10/11px 封顶 —— 两行字随徽标半径（=格子）缩放；
  //   收字下限也随 mr 放大（ef > mr*0.32），高分辨率下胶囊字不会被钳在 7px。
  var rf = Math.max(7, mr * 0.5);
  var ef = Math.max(7, mr * 0.58);
  var efMin = Math.max(7, mr * 0.32);
  // ★ 六轮（用户要求「有文字堆叠就合理布局」）：胶囊最宽**不超过 0.94 格**（mr*2.35）——
  //   相邻两枚胶囊（最坏 0.47+0.47 格）也不会横向相撞；标签字超宽就提前收字号。
  var lim = multi ? mr * 2.2 : mr * 1.7;
  ctx.font = '600 ' + ef + 'px "Segoe UI",system-ui,sans-serif';
  while (mk.label && ef > efMin && ctx.measureText(mk.label).width > lim) {
    ef -= 0.5;
    ctx.font = '600 ' + ef + 'px "Segoe UI",system-ui,sans-serif';
  }
  var bw = 0, lw = 0;
  ctx.font = '700 ' + rf + 'px "Segoe UI",system-ui,sans-serif';
  bw = ctx.measureText(mk.badge).width;
  if (mk.label) {
    ctx.font = '600 ' + ef + 'px "Segoe UI",system-ui,sans-serif';
    lw = ctx.measureText(mk.label).width;
  }
  var pw, ph;
  if (multi) { pw = Math.min(Math.max(bw, lw) + mr * 0.9, mr * 2.35); ph = mr * 1.9; }
  else { pw = mr * 2; ph = mr * 2; }
  return { multi: multi, rf: rf, ef: ef, pw: pw, ph: ph };
}

/** 「瞬间」那一发热力的预算（毫秒）。
 *  ★ 用户 2026-09-18 要求：对标 gomocalc —— **用户落完子的那一瞬间**热力图与分数就要
 *    铺在棋盘上。所以热力拆成两发：第一发只讨 260ms（Rapfi 冷启动后这个量级足够出候选，
 *    实测 sub 车道 250~400ms 回包），先把「有内容」画出来；第二发再按完整预算重算，
 *    结果回来覆盖上去（动态刷新）。两发都受「代数 + 局面指纹」双闸保护，谁过期谁作废。 */
var HEAT_FAST_MS = 260;

/** 单发热力请求：问出「AI 那一方的候选」并落到 G.heat / G.nums 上（不负责 paint）。
 *  返回 true = 这次的结果有效并已采纳；false = 过期/无候选（调用方据此决定要不要继续）。
 *
 *  · 轮到我方走 → 先虚拟一手我方最优（极短预算），再问 AI 会怎么应，拿到的才是 AI 侧候选；
 *  · 正好轮到 AI → 直接问，候选本身就是 AI 的候选（最常用路径，零额外请求）；
 *  · 候选不足 4 条时按书签版做法补搜一次（补搜只发生在「完整预算」那一发，避免拖慢第一发）。 */
async function heatPass(gen, fp, ms, allowTopUp) {
  var prof = heatProfile();     // ★ 思考时间档位：画几色、最多几个落点（见 heatProfile 注释）
  var aiColor = heatTargetColor();   // ★ 2026-09-24：AI 执子改为双开关后，用统一的「AI 那一方」判定
  var virtual = null;
  try {
    if (curColor() !== aiColor) {
      var r1 = await analyze(Math.max(400, Math.min(1000, Math.round(ms * 0.6))), 1, 'main', curColor(), T('tagHeat'));
      if (gen !== G.heatGen) return false;
      var c1 = (r1 && r1.candidates) || [];
      if (!c1.length) return false;
      if (G.board[c1[0].y] && !G.board[c1[0].y][c1[0].x]) {
        virtual = { x: c1[0].x, y: c1[0].y };
        G.board[virtual.y][virtual.x] = curColor();
      }
    }
    // ★ 十六轮：显式行棋方 —— 落过虚拟子就是 AI 方，没落就是当前行棋方（两条路都是 aiColor）
    // ★ 三十三轮：票箱版 —— AI 闲着（载入/换局补铺的那份）时多车道一起投；
    //   固定走 sub 视图小实例，与主搜并行互不排队（深夜口径：sub = 1 线程热力专用道）。
    var r = await analyzeVote(ms, prof.topN, aiColor, null, 'sub', T('tagHeat'));
    var cs = (r && r.candidates) || [];
    if (virtual) { G.board[virtual.y][virtual.x] = 0; virtual = null; }
    if (gen !== G.heatGen || fp !== boardFp()) return false;    // 局面已变 → 丢弃
    if (!cs.length) return false;
    if (allowTopUp && prof.colors > 2 && cs.length < prof.colors) {   // 四色档候选不够 → 加预算补搜一次
      try {
        var r2 = await analyze(Math.min(6000, heatBudget() + 1500), prof.topN, 'sub', aiColor, T('tagHeat'));
        var cs2 = (r2 && r2.candidates) || [];
        if (gen !== G.heatGen || fp !== boardFp()) return false;
        if (cs2.length > cs.length) cs = cs2;
      } catch (e2) {}
    }
    // 档位切法见 heatProfile：短思考 2 色、中等 3 色、长思考 4 色（与分数是否聚集无关）；
    // 格内数字用**评估分数**（用户要求：数字 = 评估的分数，智子式热力风味）。
    var n = Math.min(cs.length, prof.topN);      // ★ 落点数上限由档位决定（≤3 / ≤6 / ≤8）
    G.heat = cs.slice(0, n).map(function (c, i) {
      // 档位切法：点数 ≤ 颜色数 → **一名一档**（1 个点就是「确定的一手」，2 色时正好最佳 + 次优）；
      //           点数 > 颜色数 → 按名次均分（8 点 4 色 = 1,1,2,2,3,3,4,4）。
      var tier = (n <= prof.colors) ? (1 + i)
                                    : (1 + Math.floor(i * prof.colors / n));
      return { x: c.x, y: c.y, tier: tier, score: evalNum(c.eval), ev: fmtEval(c.eval) };
    });
    G.heatColors = prof.colors;                  // 供 paint 选调色板（2/3/4 色）
    G.nums = cs.slice(0, prof.topN).map(function (c, i) {
      return { x: c.x, y: c.y, rank: i + 1, eval: c.eval };
    });
    G.heatLen = G.moves.length;              // 仅供排查/自检：这份热力对应第几手局面
    return true;
  } catch (e) {
    if (virtual) { G.board[virtual.y][virtual.x] = 0; virtual = null; }
    return false;
  }
}

/** 清掉热力（含作废在途结果）。
 *  ★ 用户 2026-09-18 要求：**AI 完整评估并落子之后，热力图就消失** —— 那几格是
 *    「AI 正在考虑的点」，AI 已经落定了，留着就是过期信息。清空的同时必须把代数 +1，
 *    否则还在路上的第一发/第二发结果会在几百毫秒后把热力又贴回来（用户看到的就是「明明
 *    落子了热力图还闪一下」）。 */
function clearHeat() {
  G.heatGen++;
  G.heat = [];
  G.nums = [];
  G.think = [];
}

/** 刷新热力图。语义与时机都对齐用户要求（+ 书签版的分流方式）：
 *   · **是 AI 那一方**：热力格 = AI 的候选点（不是用户自己的候选）；
 *   · **瞬间**：AI 开始思考的瞬间发第一发（HEAT_FAST_MS 极短预算）铺上棋盘；
 *   · **动态刷新**：第一发一到就画，随后完整预算的第二发回来再覆盖一次（越算越准）；
 *   · **分流**：热力请求走 lane 'sub'，AI 落子走 lane 'main' —— 引擎里是**两个独立 Rapfi
 *     实例**，两条请求互不排队（书签端 refreshOverlayCands 就是这么分流的）。
 *  ★ 2026-09-19（用户新语义）：热力图（AI 方面、圆形两色）**只在 AI 思考期间展示** ——
 *   AI 一落子由 aiMove 里的 clearHeat() 撤掉；玩家回合不再铺（那是指导视图的舞台）。
 *  另外用「局面指纹 + 代数」双闸：任何时刻局面一变，旧结果一律丢弃，绝不画到新盘面上。 */
async function refreshHeat(force) {
  // ★ 2026-09-19（用户要求）：「对局结束不可再次进行热力图评估展示」。
  //   有人连五之后**一次热力评估都不再发**：对局都结束了，「AI 正在考虑的点」没有任何意义，
  //   留着只会让人以为还在算。这里把 G.over 加进闸门（旧的发不出来），
  //   settleMove() 里再 clearHeat() 一把（已经画上的立刻撤掉）。
  var want = S.heat && S.mode !== 'place' && S.mode !== 'endgame' && !G.review && !RV_MODE && !G.over;
  if (!want) { clearHeat(); return; }
  var gen = ++G.heatGen;
  var fp = boardFp();
  // 第一发：极短预算 → 落子瞬间就有东西可看（预算只有 260ms，不需要「沿用上一份」）
  var got = await heatPass(gen, fp, HEAT_FAST_MS, false);
  if (gen !== G.heatGen) return;
  if (got) paint();
  // 第二发：完整预算 → 动态刷新成更准的评估（候选不足 4 条时允许补搜）
  await heatPass(gen, fp, heatBudget(), true);
  if (gen !== G.heatGen) return;
  paint();
}

/** 清掉指导视图（方形四色热力）。代数 +1 作废在途请求（与 clearHeat 同一防闪回手法）。
 *  ★ 用户要求：**用户落子即消失**，等 AI 下完轮回用户再铺 —— 依次循环；
 *  五子连珠后不再评估、不再出现（refreshCoach 的 G.over 闸门负责）。 */
function clearCoach() {
  G.coachGen++;
  G.coach = [];
}

/** 指导视图单发：直接问**当前行棋方（= 用户）**的候选 —— 不需要虚拟一手
 *  （热力图问的是 AI 方，要先虚拟用户的最优；指导视图问的就是用户自己）。
 *  ★ 三十三轮：票箱版 —— 用户思考期正好是预热占着 main 的时候，票自动落在闲置的
 *    sub + fwd 两条车道上（预热关着时三条全投）；预热的探测那发也在 main，互不干扰。
 *  lone='sub'：退回单发时仍走原车道，与三十三轮前的时效一致。 */
async function coachPass(gen, fp, ms) {
  try {
    var r = await analyzeVote(ms, 8, curColor(), null, 'sub', T('tagCoach'));
    var cs = (r && r.candidates) || [];
    if (gen !== G.coachGen || fp !== boardFp()) return false;   // 局面已变 → 丢弃
    if (!cs.length) return false;
    G.coach = cs.map(function (c, i) {
      return { x: c.x, y: c.y, tier: 1 + Math.floor(i * 4 / cs.length), ev: fmtEval(c.eval) };
    });
    return true;
  } catch (e) { return false; }
}

/** 刷新指导视图。循环语义（用户要求）：
 *   · 只在**轮到用户**时铺（AI 回合是热力图/主搜的舞台，指导视图让路）；
 *   · 用户落子 → afterMove / aiMove / aiAssistOnce 里 clearCoach()；
 *   · AI 落定 → aiMove 末尾再叫一次 refreshCoach → 轮回用户又铺上，依次循环；
 *   · G.over（五子连珠）→ 永久停发。两发节奏与热力图一致（先 260ms 快铺、后完整预算覆盖）。 */
async function refreshCoach() {
  var want = S.coach && S.mode !== 'place' && S.mode !== 'endgame' && !G.review && !RV_MODE && !G.over;
  if (!want) { clearCoach(); return; }
  if (isAiColor(curColor())) { clearCoach(); return; }        // 轮到 AI（或 AI 自打）→ 不指导
  if (G.busy) return;                                       // 辅助一手/搜索进行中不打扰
  var gen = ++G.coachGen;
  var fp = boardFp();
  var got = await coachPass(gen, fp, HEAT_FAST_MS);
  if (gen !== G.coachGen) return;
  if (got) paint();
  await coachPass(gen, fp, heatBudget());
  if (gen !== G.coachGen) return;
  paint();
}

async function aiMove() {
  if (G.busy) return;
  G.busy = true;
  G.think = G.nums.length ? G.nums.map(function (n) { return { x: n.x, y: n.y }; }) : [];
  startPulse();
  setTurnPill(T('thinking'));
  // ★ 2026-09-19（用户新语义）：热力图（AI 方面、圆形两色）在 **AI 思考期间**展示 ——
  //   走独立 sub 车道与主搜并行；AI 一落子由下面的 clearHeat() 撤掉，玩家回合不再铺。
  if (S.heat && !G.over) refreshHeat(true).then(paint);
  try {
    var t0 = Date.now();                        // ★ 用时 = 本次主搜实测（请求发出 → 回包）
    // ★ 十六轮：显式行棋方（子数不均衡的残局/VC 盘面，引擎自己推的会和界面相反）
    // ★ 2026-09-25：预算走 aiTurnBudget()（关键局面加权，见它的长注释）——
    //   平稳局面 = 用户设的值；被叫杀 / 要应招的手自动多想一会儿。
    // ★ 单实例裁决层：先看**后台预热**有没有为上一手备好的 ponder 成品（preheatTake 会对手数与
    //   坐标双向校验，对不上就是 null），命中 = 秒答 —— 对手思考期没有一分钟白算。
    var pv0 = G.moves[G.moves.length - 1];
    var warm = pv0 ? preheatTake(pv0.x, pv0.y) : null;
    var r = await analyzeVote(aiTurnBudget(), 1, curColor(), warm, null, T('tagAiMove'));
    // ★★ 暂停护栏（用户报「发出暂停指令 AI 还是走了一步」）：思考中途被叫停 →
    //   引擎这一搜没有取消接口，但结果**作废**，绝不落子；恢复（▶）由 maybeAi 重新起一手。
    if (S.paused) { G.think = []; G.busy = false; setTurnPill(T('paused')); refreshUI(); return; }
    var cs = (r && r.candidates) || [];
    if (!cs.length) { setStat(null, T('offline')); G.busy = false; refreshUI(); return; }
    var c0 = cs[0];
    c0.timeMs = Date.now() - t0;                // 仪表盘「用时 x.xxx s」的数据源
    var best = r.best || [c0.x, c0.y];
    // ★★ 2026-09-28（用户：原生引擎棋力只剩一半，决策链回归引擎本体）：
    //   「粒子滤波历史众数」与「160ms 浅模拟否决」两层覆盖**全部撤除** ——
    //   浅模拟战术盲区会把引擎的最佳点（深杀/双重威胁）误判成「输」而换次选，这就是棋力腰斩的根源。
    //   决策链只剩：引擎终榜 best + mustAnswer 必应护栏（只干预「能连五 / 对手将成五必堵」纯战术）。
    var gd = mustAnswer(G.board, curColor(), cs, winPoints(G.board, 3 - curColor(), engineRule()), null, 1);
    if (gd) best = [gd.x, gd.y];
    G.lastStat = c0;
    var moverIsBlack = (G.moves.length % 2 === 0);
    pushCurve(G.moves.length, evalNum(c0.eval), moverIsBlack);
    G.redo = [];                            // AI 落子后旧分支不可重放
    place(best[0], best[1]);
    // ★★ 微小官方 ponder 种子：AI 上一搜主变量线的第 2 步 = 它预计的用户应手（全深度、
    //   零成本）。「向前多看几步」的落点就在这；必应覆盖（gd）时盘面与 PV 首步不一致 → 不种。
    var pvLine = (c0.line && c0.line.length >= 2) ? c0.line[1] : null;
    PREHEAT.lastPv = (!gd && pvLine && pvLine[0] >= 0 && pvLine[1] >= 0 &&
                      pvLine[0] < N && pvLine[1] < N && !G.board[pvLine[1]][pvLine[0]])
      ? { ply: G.moves.length, pick: { x: pvLine[0], y: pvLine[1] } } : null;
    setStat(c0, null);
    // ★ 用户要求：AI「评估完整的最佳位置并下完」→ 热力图消失（见 clearHeat 的注释）。
    //   必须在 place 之后立刻清：此时热力格描述的是**上一手之前**的局面，已经过期。
    //   指导视图同样清（AI 的落子也改变了盘面，方形格已过期；下一拍在下面 refreshCoach）。
    clearHeat();
    clearCoach();
    if (settleMove()) { G.busy = false; paint(); return; }   // ★ AI 这一手也可能连五
    paint();
  } catch (e) {
    setStat(null, T('offline'));
  }
  G.busy = false;
  refreshUI();
  // ★ 2026-09-19（用户新语义）：AI 落定 → 热力图已经清掉且**不再为玩家回合重铺**
  //   （旧的「AI 落定后补铺一份」就是用户看到的「AI 下完子热力还在显示」—— 已删）。
  // ★ 指导视图循环（用户要求）：AI 展示和操作完 → 轮到用户 → 方形四色热力再铺上，
  //   用户落子后消失（afterMove 里 clearCoach），如此依次循环；终局后停发。
  if (S.coach && !G.over) refreshCoach().then(paint);
  chainAiIfNeeded();                          // ★ 2026-09-24：AI 自打时接力下一手
  maybePreheat();                             // ★ 三十三轮：AI 落定 = 进入对手思考期 → 起后台预热
}

/** ★★ 2026-09-24（用户要求「两个都选 = AI 与 AI 自打」）：AI 落子后**接力** ——
 *  正常流程里「AI 再走一手」是靠用户落子触发的（onBoardClick → afterMove → maybeAi），
 *  AI 自打时没有用户落子这个事件，所以 AI 走完必须自己叫下一手，否则自打会在第 2 手停住。
 *  条件：轮到的颜色仍是 AI（两色都开时恒真）+ 模式是 pve + 没暂停 / 终局 / 复盘 / 开局流程。
 *  220ms 的间隔既让界面看清上一步，也避免同步递归。 */
function chainAiIfNeeded() {
  if (RV_MODE || S.mode !== 'pve' || S.paused || G.review || G.over || G.busy) return;
  if (openActive()) return;                   // 开局流程（交换 / 十打）自己会接上
  if (!isAiColor(curColor())) return;
  setTimeout(function () {
    if (RV_MODE || S.mode !== 'pve' || S.paused || G.review || G.over || G.busy) return;
    if (!isAiColor(curColor())) return;
    aiMove();
  }, 220);
}

/** 「辅助一手」：平时点一下图标键，让 AI 立刻为**当前行棋方**计算并落子一着。
 *  不管这手轮到谁 —— 轮到玩家也照下（这正是「辅助」的含义）。 */
async function aiAssistOnce() {
  // ★ 2026-09-23：残局与自由摆盘一样，AI 完全不参与（辅助键一并禁掉，见 refreshUI）
  if (G.busy || G.review || G.over || openActive() ||
      S.mode === 'place' || S.mode === 'endgame') return;
  // 轮到 AI 自己时直接走常规通道，避免和自动行棋抢跑
  if (S.mode === 'pve' && isAiColor(curColor())) { aiMove(); return; }
  G.busy = true;
  G.think = G.nums.length ? G.nums.map(function (n) { return { x: n.x, y: n.y }; }) : [];
  startPulse();
  setTurnPill(T('thinking'));
  try {
    var t0 = Date.now();                        // ★ 辅助一手同样给「用时 x.xxx s」
    // ★ 与 aiMove 同款 —— 先兑后台预热的 ponder 成品，再走单实例裁决层。
    var av0 = G.moves[G.moves.length - 1];
    var awarm = av0 ? preheatTake(av0.x, av0.y) : null;
    var r = await analyzeVote(aiTurnBudget(), 1, curColor(), awarm, null, T('tagAssist'));   // ★ 关键局面加权由 aiTurnBudget 负责
    if (S.paused) { G.think = []; G.busy = false; setTurnPill(T('paused')); refreshUI(); return; }   // ★ 暂停护栏（同 aiMove）
    var cs = (r && r.candidates) || [];
    if (!cs.length) { setStat(null, T('offline')); G.busy = false; refreshUI(); return; }
    var c0 = cs[0];
    c0.timeMs = Date.now() - t0;
    var best = r.best || [c0.x, c0.y];
    // ★ 2026-09-28：与 aiMove 同款 —— 两层覆盖撤除，引擎 best + 必应护栏兜底
    var gd2 = mustAnswer(G.board, curColor(), cs, winPoints(G.board, 3 - curColor(), engineRule()), null, 1);
    if (gd2) best = [gd2.x, gd2.y];              // ★ 十六轮：与 aiMove 同款的必应校验
    G.lastStat = c0;
    var moverIsBlack = (G.moves.length % 2 === 0);
    pushCurve(G.moves.length, evalNum(c0.eval), moverIsBlack);
    G.redo = [];
    place(best[0], best[1]);
    // ★ 与 aiMove 同款：存 ponder 种子（gd2 覆盖时盘面与 PV 首步不一致 → 不种）
    var pvLine2 = (c0.line && c0.line.length >= 2) ? c0.line[1] : null;
    PREHEAT.lastPv = (!gd2 && pvLine2 && pvLine2[0] >= 0 && pvLine2[1] >= 0 &&
                      pvLine2[0] < N && pvLine2[1] < N && !G.board[pvLine2[1]][pvLine2[0]])
      ? { ply: G.moves.length, pick: { x: pvLine2[0], y: pvLine2[1] } } : null;
    setStat(c0, null);
    clearHeat();                              // 与 aiMove 同规：算完落定 → 热力消失
    clearCoach();
    if (settleMove()) { G.busy = false; paint(); return; }   // ★ 辅助这一手也可能连五
    paint();
  } catch (e) {
    setStat(null, T('offline'));
  }
  G.busy = false;
  refreshUI();
  if (S.coach && !G.over) refreshCoach().then(paint);   // 辅助完若轮到用户 → 指导视图跟上
}

// ---------------------------------------------------------------- 落子
function place(x, y) {
  if (x < 0 || y < 0 || x >= N || y >= N) return false;
  if (G.board[y][x]) return false;
  // ★ 2026-09-23（用户要求）：残局 +「任意摆盘」= 摆的是**选定的颜色**（egColor），
  //   黑白数量与顺序都不限制（可摆 30 黑 + 10 白）；顺序摆盘仍走 curColor() 黑白轮流。
  var c = (S.mode === 'endgame' && !S.egSeq) ? (S.egColor || 1) : curColor();
  G.board[y][x] = c;
  G.moves.push({ x: x, y: y, c: c });
  // 新落的这一手会盖住某个热力格 → 立刻把它从热力列表里摘掉（不重算，避免闪烁）
  G.heat = G.heat.filter(function (h) { return !G.board[h.y][h.x]; });
  // ★ 2026-09-20：落子 = 局面变了 → 「计算评估」那一批标注**立刻作废**
  //   （它们描述的已经是上一手之前的盘面；与热力/指导视图同一个道理，见 clearHeat 注释）。
  anaReset();
  paint();
  // ★ 五轮：前瞻开着 → 局面变了自动重推（去抖 300ms，见 fwdQueue）
  //   ★ 六轮：hold（确定过、结果冻结）期间**不重推** —— 用户要求「不要重复计算前瞻，
  //     等到用户再次点击前瞻，就重新计算」。
  if (G.fwd && G.fwd.on && !G.fwd.hold) fwdQueue();
  return true;
}

/** ★ 2026-09-20（用户要求）：鼠标悬浮提示 —— 指针压在某个交叉点周围时，记下那个格子，
 *  paint() 用**浅蓝半透明圆角方框**把它框出来，提示「点下去就落在这里」。
 *  · 坐标换算与 onBoardClick **完全同源**（Math.round 取最近交叉点）→ 提示格 = 落子格，
 *    不会出现「框着一个点、点下去却落到旁边」；
 *  · 出盘（含落在坐标轴区域外）→ null（提示消失）；
 *  · 同一格内移动不重绘（只在格子变化时 paint 一次，15×15 全量重绘也就一帧的事）。 */
function hoverFromEvent(ev) {
  var rect = els.board.getBoundingClientRect();
  // ★ 2026-09-25：棋盘视图变换后命中必须过逆矩阵（cellAt 统一入口，正映射在 paint 里）
  return cellAt(ev.clientX - rect.left, ev.clientY - rect.top);
}
function bindBoardHover() {
  els.board.addEventListener('mousemove', function (ev) {
    var h = hoverFromEvent(ev), c = G.hover;
    if (!h && !c) return;
    if (h && c && h.x === c.x && h.y === c.y) return;      // 同一格 → 不重绘
    G.hover = h; paint();
  });
  els.board.addEventListener('mouseleave', function () {
    if (!G.hover) return;
    G.hover = null; paint();
  });
}

function onBoardClick(ev) {
  var rect = els.board.getBoundingClientRect();
  var g = geom();
  var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
  var hit = cellAt(px, py);
  if (!hit) return;
  var x = hit.x, y = hit.y;

  // 背诵复盘：凭记忆落子，错了画粉红圈
  if (G.review && G.review.kind === 'recite') { reciteStep(x, y); return; }
  if (G.review) return;                       // 回顾复盘里棋盘只读
  if (G.busy) return;
  if (G.over) return;                         // 终局锁：对局结束后棋盘只读
  // ★ 2026-09-24（AI 自打）：两色都归 AI → 棋盘点击不生效（否则会插出一手打乱轮次）。
  //   想接手就关掉其中一个开关，或先按暂停（▶ / ❚❚ 键在 AI 自打时是灰的，只能改开关）。
  if (S.mode === 'pve' && aiVsAi()) { setStat(null, T('sideHintBoth')); return; }
  // ★★ 2026-09-25（用户澄清「禁手模式里，不能下的位置是红叉」）：红叉点 = 黑方**真的下不了** ——
  //   对弈模式下轮到黑方点上去 → 给一句提示并拦下，不落子。
  //   摆盘 / 残局模式**不拦**：那两个模式本来就是「造局面」用的（有时就是要摆出禁手点来研究）。
  if (S.mode === 'pve' && curColor() === 1 && renjuRule() && forbiddenAt(x, y)) {
    setStat(null, T('fbBlocked')); paint(); return;
  }
  if (!place(x, y)) return;
  G.redo = [];                                // 新走一手 → 旧分支不可再「下一步」
  afterMove();
}

/** 落子后的**统一收尾**：判胜 → 终局锁 → 持久化。返回 true = 这一手已终结对局。
 *  ★ 关键修复（用户报「白子快连成 10 个了还没结束」）：aiMove / aiAssistOnce 以前
 *    拿到引擎结果就直接 place() 收场，**从不调用 winAt** —— 于是只有玩家自己落的那一手
 *    才可能触发终局；玩家执黑时，白棋（AI）连成五个甚至十个都不会结束。
 *    现在所有落子路径（玩家点击 / AI 自动 / AI 辅助）都从这里出终局判定。 */
function settleMove() {
  var last = G.moves[G.moves.length - 1];
  if (last && winCheck(G.board, last.x, last.y, last.c)) {
    G.over = true;
    G.think = [];
    clearHeat();      // 终局 → 热力立刻撤掉（配合 refreshHeat 的 G.over 闸门）
    setStat(G.lastStat, T('over') + ' · ' + winTextFor(last.c));
    persistGame();
    refreshUI();
    return true;
  }
  persistGame();
  return false;
}

/** 终局文案：谁赢了。
 *  ★ 2026-09-24：AI 执子改成双开关后，「我赢 / 我输」不再是二分 ——
 *   AI 自打（两色都是 AI）与「两个都关」（两色都是用户）都必须点名**颜色**而不是「你」。 */
function winTextFor(winColor) {
  var my = myColor();
  if (my === 1 || my === 2) return (winColor === my) ? T('youWin') : T('youLose');
  return (winColor === 1 ? T('fwdBlack') : T('fwdWhite')) + ' ' + T('youWin');
}

function afterMove() {
  clearCoach();   // 用户落子 → 指导视图立刻消失（循环的下一拍：AI 落定后 aiMove 末尾再铺）
  if (settleMove()) { paint(); return; }
  refreshUI();
  G.retryLeft = null;        // 用户又落了一手 → 引擎重试配额重置（离线时能继续自愈）
  if (openActive() && openStep()) { paint(); return; }   // 开局流程接管（交换 / 选色 / 十打）
  if (S.paused) return;
  // ★ 廿九轮（用户要求）：定局（五连 / 活四）→ 静默评估与多点防守**都停止显示**：
  //   立刻撤掉防守标注 + 停掉扫描防守的周期表。放在模式分支之前 —— 摆盘/对弈两条路都要过这道闸。
  if (boardDecided() && (G.ana.marks.length || G.ana.defCells)) {
    G.ana.gen++; G.ana.busy = false;
    if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }
    G.ana.autoDefend = false;
    G.ana.marks = []; G.ana.rows = []; G.ana.defCells = null;
    anaMark(null); renderAna(T('anIdle'));
  }
  if (S.mode === 'place' || S.mode === 'endgame') {
    paint(); return;
  }   // 自由摆盘/残局：AI 完全不参与自动落子（评估走「分析计算」键）
  // ★ 2026-09-26（用户要求）：「扫描防守」点过一次后 → 随落子动态重扫（Yixin 式），清除标记/重开才停
  if (G.ana.autoDefend && !G.ana.busy && !G.over && !boardDecided()) { try { anaDefend(true); } catch (e) {} }
  // ★ 三十三轮：后台预热 —— 轮到 AI ≡ 「对手思考期」结束 → 收起定时器（缓存留给 aiMove 兑）；
  //   轮到人对局方 ≡ 进入等待期 → 立刻起预热循环（条件都在 preheatWanted 里判了）。
  if (isAiColor(curColor())) { preheatStop(false); aiMove(); }
  else maybePreheat();
}
/** 落子后持久化局面：关掉软件再打开还是这盘（用户要求）。 */
function persistGame() {
  try {
    var mv = G.moves.map(function (m) { return [m.x, m.y, m.c]; });
    localStorage.setItem('gbcalc.game.v1', JSON.stringify({ moves: mv, rule: S.rule,
      side: S.side, aiB: S.aiB, aiW: S.aiW, mode: S.mode, ts: Date.now() }));
  } catch (e) {}
}
/** 启动时把上次关闭前的局面接着摆回来。 */
function restoreGame() {
  var o = null;
  try { o = JSON.parse(localStorage.getItem('gbcalc.game.v1') || 'null'); } catch (e) { o = null; }
  if (!o || !Array.isArray(o.moves) || !o.moves.length) return false;
  G.board = newBoard(); G.moves = []; G.curve = []; G.heat = []; G.nums = []; G.coach = [];
  o.moves.forEach(function (a) {
    var c = a[2] || ((G.moves.length % 2 === 0) ? 1 : 2);
    if (a[0] < 0 || a[1] < 0 || a[0] >= N || a[1] >= N) return;
    if (G.board[a[1]][a[0]]) return;
    G.board[a[1]][a[0]] = c;
    G.moves.push({ x: a[0], y: a[1], c: c });
  });
  recomputeOver();
  paint();
  refreshHeat(true);                          // 恢复局面后也补一份热力（开关开着才有用）
  refreshCoach();                             // 指导视图同样补一份（轮到用户且开关开着才有用）
  return true;
}
/** 从当前棋盘重新判定终局：载入的历史局面里可能**早就连五了**，
 *  不重判的话用户还能在已分胜负的盘面上继续下（用户报的 bug）。 */
function recomputeOver() {
  var over = false;
  for (var i = G.moves.length - 1; i >= 0 && !over; i--) {
    var m = G.moves[i];
    if (winCheck(G.board, m.x, m.y, m.c)) over = true;
  }
  G.over = over;
  return over;
}

/* ---------------------------------------------------------------- 开局规则
 * 复杂交换规则照参考站（gomoku-ai-play）的思路实现：规则只管**开局流程**，
 * 流程结束后统一转成普通连珠（引擎 rule=2）继续下。
 *
 *   · 5 一手交换（swap1）   ：黑下第 1 手后，白方（AI）决定要不要换色。
 *   · 6 山口规则（Yamaguchi）：摆局方连摆 3 子（黑1白2黑3），然后对方（AI）选执黑/执白。
 *   · 7 塔拉山口10（Taraguchi-10）：黑1 固定天元；白2 限 3×3、黑3 限 5×5、白4 限 7×7；
 *       接着黑方二选一 —— 直接下第 5 手（限 9×9），或「十打」叫出 10 个第 5 手候选点
 *       由白方挑一个；第 5 手落定后白方选色；6 手之后转正常连珠。
 *       十打有**对称禁例**：互为对称等价（8 个二面体变换）的点算同一个候选。
 */
var OPEN = null;

function cheb(x, y) { return Math.max(Math.abs(x - 7), Math.abs(y - 7)); }
/** 第 n 手（1-based）允许离天元的切比雪夫距离上限：黑1=0(仅天元) 白2=1 黑3=2 白4=3 黑5=4 */
function tarRegion(n) { return [0, 1, 2, 3, 4][n - 1]; }
function symTransforms(x, y) {
  var cx = x - 7, cy = y - 7;
  return [[cx, cy], [-cx, cy], [cx, -cy], [-cx, -cy],
          [cy, cx], [-cy, cx], [cy, -cx], [-cy, -cx]].map(function (p) {
    return [p[0] + 7, p[1] + 7];
  });
}
function symEquivInSet(p, set) {
  var tr = symTransforms(p[0], p[1]);
  for (var i = 0; i < set.length; i++) {
    for (var j = 0; j < tr.length; j++) {
      if (tr[j][0] === set[i][0] && tr[j][1] === set[i][1]) return true;
    }
  }
  return false;
}
function openActive() { return !!OPEN && !OPEN.finished; }

function openStart() {
  OPEN = null;
  els.btn_ten.hidden = true;
  els.openBar.hidden = true;
  if (els.swapPop) els.swapPop.hidden = true;   // 重开/换规则 → 收起先后手弹窗
  // ★ 2026-09-23（用户要求）：残局模式不开任何交换手流程 —— 摆盘研究不需要换先
  if (S.mode === 'endgame') return;
  if (S.egLocked) return;              // ★ 十八轮：已确定的残局上不开任何交换流程
  if (S.rule === 5) OPEN = { kind: 'swap1' };
  else if (S.rule === 6) OPEN = { kind: 'yama' };
  else if (S.rule === 7) OPEN = { kind: 'tar', tar: null };
  if (OPEN && OPEN.kind === 'tar' && !G.moves.length) {
    place(7, 7);                       // 黑 1 固定天元
    afterMove();
  } else {
    openHint();
  }
}
function openHint() {
  if (!openActive() || RV_MODE) { els.openBar.hidden = true; return; }
  // ★ 交换完成、等用户在小弹窗里选先手/后手：openBar 藏掉（弹窗本身就是提示）
  if (OPEN.choice) { els.openBar.hidden = true; els.btn_ten.hidden = true; return; }
  var n = G.moves.length, t = '';
  if (OPEN.kind === 'swap1') {
    t = (S.lang === 'en') ? 'Swap1: waiting for the reply side to decide' : '一手交换：等待对方决定是否换色';
  } else if (OPEN.kind === 'yama') {
    t = (S.lang === 'en') ? ('Yamaguchi: place ' + (3 - n) + ' more opening stone(s)')
                          : ('山口规则：还需摆 ' + (3 - n) + ' 子（黑1白2黑3）');
  } else if (OPEN.kind === 'tar') {
    if (OPEN.tar && OPEN.tar.phase === 'call10') {
      t = (S.lang === 'en')
        ? ('Ten-call: pick ' + (10 - OPEN.tar.called.length) + ' more candidate(s)')
        : ('十打：还需叫 ' + (10 - OPEN.tar.called.length) + ' 个候选点（对称点不可重复）');
    } else if (OPEN.tar && OPEN.tar.phase === 'pickCall') {
      t = (S.lang === 'en') ? 'Ten-call: the other side picks one' : '十打：对方正在挑点';
    } else if (n < 4) {
      var r = tarRegion(n + 1);
      t = (S.lang === 'en')
        ? ('Taraguchi: move ' + (n + 1) + ' within ' + (r * 2 + 1) + '×' + (r * 2 + 1) + ' of centre')
        : ('塔拉山口：第 ' + (n + 1) + ' 手限天元周围 ' + (r * 2 + 1) + '×' + (r * 2 + 1));
    } else if (n === 4) {
      t = (S.lang === 'en') ? 'Taraguchi: play the 5th stone, or use Ten-call'
                            : '塔拉山口：直接下第 5 手（9×9 内），或点「十打」';
    }
  }
  els.openHint.textContent = t;
  els.openBar.hidden = !t;
  els.btn_ten.hidden = !(OPEN.kind === 'tar' && n === 4 && !(OPEN.tar && OPEN.tar.phase));
}

/** 每落一手（或每次流程推进）后调用：决定下一步是继续开局流程还是转正常对局。 */
function openStep() {
  if (!openActive()) return false;
  var n = G.moves.length;
  if (OPEN.kind === 'swap1') {
    if (n === 1 && !OPEN.done) { showSwapChoice(); return true; }
    OPEN.finished = true; openHint(); return false;
  }
  if (OPEN.kind === 'yama') {
    if (n < 3) { openHint(); return true; }
    if (!OPEN.done) { showSwapChoice(); return true; }
    OPEN.finished = true; openHint(); return false;
  }
  if (OPEN.kind === 'tar') {
    if (OPEN.tar && OPEN.tar.phase === 'call10') { openHint(); return true; }
    if (n >= 6) { OPEN.finished = true; openHint(); return false; }
    if (n === 5 && OPEN.tar && OPEN.tar.phase === 'pickCall' && !OPEN.picked) { aiPickCall(); return true; }
    if (n === 5 && !OPEN.done) { showSwapChoice(); return true; }
    if (n === 5 && OPEN.done) { OPEN.finished = true; openHint(); return false; }
    openHint(); return true;
  }
  return false;
}
/** 开局流程里是否禁止在某点落子（塔拉山口的区域限制）。 */
function openForbid(x, y) {
  if (!openActive() || OPEN.kind !== 'tar') return false;
  var n = G.moves.length + 1;                 // 即将落的是第几手
  if (n > 5) return false;
  return cheb(x, y) > tarRegion(n);
}
/** 交换完成（一手交换第 1 手后 / 山口 3 子后 / 塔拉山口第 5 手后）——
 *  ★ 2026-09-19（用户要求）：不再由 AI 私自定色 —— 在棋盘下方弹出精致小弹窗，
 *  让**用户**亲自选先手（执黑）还是后手（执白）；AI 自动执另一色。
 *  流程在此暂停（OPEN.choice = true，openStep/openHint 都会让路），选完继续。 */
function showSwapChoice() {
  OPEN.choice = true;
  if (RV_MODE || S.mode !== 'pve') {          // 复盘/摆盘没有 AI 接管 → 维持现色直接过
    chooseSwapSide((curColor() === 1) ? 'b' : 'w', true);
    return;
  }
  els.swapPop.hidden = false;
  openHint(); paint();
}
/** 用户点「先手 · 执黑」/「后手 · 执白」：定色 → 收弹窗 → 走完开局流程 →
 *  AI 自动执另一色并立刻开始计算（轮到 AI 就 aiMove；轮到用户就铺热力/指导视图）。 */
function chooseSwapSide(side, silent) {
  // ★ 2026-09-24：用户选「先手·执黑 / 后手·执白」→ 换算成「AI 执另一色」的双开关。
  setAiSides(side !== 'b', side !== 'w');
  syncSideUI(); save();
  if (els.swapPop) els.swapPop.hidden = true;
  OPEN.choice = false;
  OPEN.done = true;
  openStep();                                 // done → finished，开局流程收尾
  refreshUI();
  if (!silent) paint();
  refreshHeat(true);                          // 交换结束 = 转正常对局：该铺的视图补上
  refreshCoach();
  maybeAi();                                  // 轮到 AI 就让它算（AI 已自动执另一色）
}
/** 十打：黑方叫完 10 点后，白方从中挑一个作为第 5 手。 */
async function aiPickCall() {
  var pts = OPEN.tar.called.slice();
  if (!pts.length) { OPEN.finished = true; return; }
  var pick = pts[0], bestV = null;
  for (var i = 0; i < pts.length; i++) {
    G.board[pts[i][1]][pts[i][0]] = curColor();
    var r = null;
    // 虚拟落了 curColor 的子 → 此刻轮到**对手**说话，显式告诉引擎（十六轮）
    try { r = await analyze(Math.max(400, Math.min(900, S.turnMs)), 1, 'sub', 3 - curColor(), T('tagTen')); } catch (e) {}
    G.board[pts[i][1]][pts[i][0]] = 0;
    var cs = (r && r.candidates) || [];
    var v = cs.length ? evalNum(cs[0].eval) : 0;
    // 轮到对手走：对手视角评估越负 → 对我方越好 → 这个点越该被挑走（留给自己）
    if (bestV === null || v < bestV) { bestV = v; pick = pts[i]; }
  }
  OPEN.picked = true;
  OPEN.tar.phase = 'done';
  place(pick[0], pick[1]);
  afterMove();
}
function startTenCall() {
  OPEN.tar = { phase: 'call10', called: [] };
  openHint(); paint();
}
function toggleCall(x, y) {
  var t = OPEN.tar, i, found = -1;
  for (i = 0; i < t.called.length; i++) {
    if (t.called[i][0] === x && t.called[i][1] === y) { found = i; break; }
  }
  if (found >= 0) { t.called.splice(found, 1); }
  else if (t.called.length >= 10) { return; }
  else if (symEquivInSet([x, y], t.called)) { return; }   // 对称禁例
  else { t.called.push([x, y]); }
  if (t.called.length === 10) { t.phase = 'pickCall'; }
  openHint(); paint();
}
/** ★ 2026-09-24（用户要求）：「AI 执黑 / AI 执白」两个**独立开关**的键态同步 ——
 *  两个可以同时点亮（= AI 自打），也可以都不点（= 用户双方都下）。 */
function syncSideUI() {
  var map = { b: !!S.aiB, w: !!S.aiW };
  [].forEach.call(els.seg_side.querySelectorAll('button'), function (b) {
    var key = b.getAttribute('data-ai');
    b.classList.toggle('on', !!map[key]);
    b.setAttribute('aria-pressed', map[key] ? 'true' : 'false');
  });
}

// ---------------------------------------------------------------- 仪表盘
/** ★ 2026-09-27（用户意见①③「仪表盘要有速度和节点等的表示」「是否在计算不够直观」）：
 *  引擎实时状态聚合器 —— Worker 的 live 帧按车道收进来，主线程聚合三车道后刷新仪表盘：
 *  · 速度/节点 = 多实例**累加**（主搜 + 视图小实例的总算力一眼可见）；
 *  · 深度 = 取最深；用时 = 最早开算的那条车道起到现在；
 *  · 状态胶囊：任一车道在算 → 青点脉冲 + 「计算中 · 功能名」；全空闲 → 绿点「空闲」。
 *  终结帧（searching:false）摘除车道；本地功能结束（G.ana/G.fwd/G.busy 清零）也会兜底熄灯。 */
var LIVE_LANES = {};
function onEngineLive(d) {
  if (!d || !d.lane) return;
  if (d.searching === false) {
    // ★ 09-28 晚：分析计算会话中，轮间 ~120ms 喘息的终结帧**不摘**主车道（胶囊/读数不闪断）；
    //   会话真正结束由 liveAnaClear 统一摘除。
    if (!(LIVE_AN.on && d.lane === 'main')) delete LIVE_LANES[d.lane];
    paintLiveDash(); return;
  }
  LIVE_LANES[d.lane] = {
    t0: d.t0 || Date.now(), speed: +d.speed || 0, nodes: +d.nodes || 0,
    depth: +d.depth || 0, eval: d.eval || '', tag: d.tag || '', best: d.best || null,
  };
  paintLiveDash();
}
function liveAgg() {
  var keys = Object.keys(LIVE_LANES);
  if (!keys.length) return null;
  var a = { speed: 0, nodes: 0, depth: 0, t0: Infinity, tag: '', n: 0 };
  for (var i = 0; i < keys.length; i++) {
    var L = LIVE_LANES[keys[i]];
    a.speed += L.speed || 0; a.nodes += L.nodes || 0; a.n++;
    if ((L.depth || 0) > a.depth) a.depth = L.depth || 0;
    if ((L.t0 || Infinity) < a.t0) a.t0 = L.t0;
    if (!a.tag && L.tag) a.tag = L.tag;
  }
  return a;
}
/** 速度列的显示口径：Rapfi 的 SPEED 单位是 nps。
 *  ★ 2026-09-28（用户要求）：**1000 万以下把位数显示全**（不再缩写 k / M，用户要能核对真实量级）；
 *  超过 1000 万才缩写，且**保留三位小数**（如 12.345 M）—— 既要一眼看出量级，又不丢精度。 */
function fmtSpeed(nps) {
  if (!nps || nps < 0) return '-';
  if (nps >= 1e7) return (nps / 1e6).toFixed(3) + ' M';
  return String(Math.round(nps));      // < 1000 万：完整位数，原样显示
}
function fmtNodes(n) { return fmtSpeed(n); }   // 节点同口径（合计数）
/** 把 live 聚合写进仪表盘（只在有活跃车道时；结束后的最终值由 setStat(c0) 覆盖）。 */
function paintLiveDash() {
  if (RV_MODE) return;
  var a = liveAgg();
  var busyUI = !!(a || G.busy || G.ana.busy || (G.fwd && G.fwd.busy) || (LIVE_AN.on && LIVE_AN.t0));
  // ★ 09-28：标题后的「空闲 / 计算中」胶囊已删 —— 是否在算改由卡片下方文字框（#turnPill）承载，
  //   只在**确实在算**时补一行说明，空闲时不动它（避免覆盖「轮到谁」这类常驻提示）。
  if (busyUI && a && a.tag) els.st_line.textContent = T('calcOn') + ' · ' + a.tag;
  if (!a) return;
  if (a.depth) els.st_depth.textContent = String(a.depth);
  els.st_speed.textContent = fmtSpeed(a.speed);
  els.st_nodes.textContent = fmtNodes(a.nodes);
  // ★ 09-28 晚：分析计算会话的用时 = **会话起点**累加（跨轮不清零，用户要求「用时上会持续累加」）
  var tShow = (LIVE_AN.on && LIVE_AN.t0) ? LIVE_AN.t0 : a.t0;
  els.st_time.textContent = ((Date.now() - tShow) / 1000).toFixed(1) + ' s';
  if (a.tag) els.st_line.textContent = T('calcOn') + ' · ' + a.tag;
}

function setStat(c0, msg) {
  if (c0) {
    els.st_depth.textContent = c0.depth != null ? c0.depth : '-';
    // ★ 09-28：终值也走同一套格式化（原来这里直接吐原始数字 —— 大数会顶破格子，且与
    //   实时刷新时的口径不一致，同一个数在「计算中」和「算完」长得不一样）。
    els.st_speed.textContent = c0.speed != null ? fmtSpeed(+c0.speed) : '-';
    els.st_nodes.textContent = c0.nodes != null ? fmtNodes(+c0.nodes) : '-';
    // ★ 用时（用户要求 2026-09-19）：仪表盘一直空着不显示 —— 现在由调用方把**本次
    //   主搜实测耗时**（毫秒）挂在 c0.timeMs 上，这里统一格式化成「x.xxx s」（三位小数）。
    els.st_time.textContent = (c0.timeMs != null)
      ? (c0.timeMs / 1000).toFixed(3) + ' s' : '-';
    els.st_eval.textContent = c0.eval != null ? c0.eval : '-';
    els.st_best.textContent = (c0.x != null) ? coordName(c0.x, c0.y) : '-';
    els.st_line.textContent = (c0.line && c0.line.length)
      ? c0.line.map(function (p) { return coordName(p[0], p[1]); }).join(' ')
      : '';
  } else {
    els.st_line.textContent = msg || '';
  }
}
/** ★ 2026-09-28（用户要求）：引擎仪表盘最下面那个文字框**恢复** —— 「轮到谁 / AI 思考中 /
 *  暂停 / 终局 / 背诵…」都落在这里；样式上**最多两行**（见 CSS 的 -webkit-line-clamp:2）。 */
function setTurnPill(txt) { if (els.turnPill) els.turnPill.textContent = txt || ''; }

function refreshUI() {
  // ★ 复盘窗口是**另一套界面**（只有棋盘 + 一行复盘键），元素集合与主窗口不同 →
  //   走 refreshRvUI() 这条独立支路，绝不去算主窗口的暂停图标 / 重开文案 / 曲线。
  if (RV_MODE) { refreshRvUI(); return; }
  var c = curColor();
  if (G.review) {
    setTurnPill(G.review.kind === 'recite' ? T('recite') : T('replay'));
  } else if (S.paused) {
    setTurnPill(T('paused'));
  } else if (G.over) {
    setTurnPill(T('over'));
  } else if (S.mode === 'place') {
    setTurnPill((c === 1 ? T('turnBlack') : T('turnWhite')) + ' · ' + T('modePlace'));
  } else if (S.mode === 'endgame') {
    // ★ 2026-09-23（用户要求）：残局模式 —— 药丸说明当前该摆哪色 / 正处于哪种摆法
    var egTxt = S.egSeq ? T('egSeq')
      : T('egFreeOn').replace('{c}', S.egColor === 1 ? T('egB') : T('egW'));
    setTurnPill((c === 1 ? T('turnBlack') : T('turnWhite')) + ' · ' + T('modeEndgame') +
                ' · ' + egTxt);
  } else {
    // ★ 2026-09-20（用户要求）：「AI……和用户……分别显示 AI 与用户，不显示黑白」
    //   ⇒ 人机模式的状态药丸只说「轮到你 / 轮到 AI」（黑/白只在自由摆盘里说，
    //     那个模式根本没有 AI，说黑白才是准确的）。
    // ★★ 2026-09-24（用户要求，AI 执子双开关）：多了两种组合 ——
    //   · AI 自打（两色都是 AI）→ 药丸点名「AI 自打 · 轮到黑子 / 白子」；
    //   · 两个都关（两色都是用户）→ 药丸说「轮到你（双方都由你下）」。
    var colorName = (c === 1 ? T('fwdBlack') : T('fwdWhite'));
    if (aiVsAi()) setTurnPill(T('turnAiBoth').replace('{c}', colorName));
    else if (humanBoth()) setTurnPill(T('turnYouBoth').replace('{c}', colorName));
    else setTurnPill(isAiColor(c) ? (G.engineOffline ? T('offlinePill') : T('thinking')) : T('turnYou'));
  }
  // 图标键：AI 计算 / 行棋中 = 双竖杠 ❚❚（点它暂停）；暂停中或空闲 = 三角 ▶。
  // 状态在变，图标就**来回切换**（用户要求「这个键是活动的」），并且它是整行的正中间一个。
  var aiRunning = G.busy || (!S.paused && !G.over && !G.review &&
                             S.mode === 'pve' && isAiColor(curColor()));
  els.btn_pause.textContent = (S.paused || !aiRunning) ? '▶' : '❚❚';
  // ★★ 2026-09-25（用户要求）：「AI 执黑 + AI 执白」都选中 = AI 自打，这颗正中键就是那个
  //   **开关键** —— 语义与播放电影的播放/暂停完全一致：❚❚ = 正在自动对弈（点一下停手）、
  //   ▶ = 已停手（点一下继续）。旧版在自打时把它 disabled 掉了，用户根本停不下来。
  els.btn_pause.title = S.paused
    ? (aiVsAi() ? T('spResume') : T('resume'))
    : (aiVsAi() ? T('spPause') : (aiRunning ? T('pause') : T('assistHint')));
  // 残局/自由摆盘：AI 不参与（自打也一样 —— 摆盘模式下任何情况都不自动落子）。
  els.btn_pause.disabled = (S.mode === 'place' || S.mode === 'endgame');
  // ★ 2026-09-24：AI 执子那一行的提示（开关组合的语义 + AI 自打时的临时停手办法）
  //   ★ 2026-09-25：「摆盘 / 残局」模式下自打不会走子 —— 提示换成会点明这一点的说法。
  if (els.sideHint) {
    els.sideHint.textContent = aiVsAi()
      ? (S.mode === 'pve' ? T('sideHintBoth') : T('sideHintBothPlace'))
      : humanBoth() ? T('sideHintNone')
      : (S.aiB ? T('sideHintB') : T('sideHintW'));
  }
  // ★ 2026-09-23（用户要求）：残局摆盘行只在残局模式下显示；键态随 S.egSeq / S.egColor 走
  if (els.egBar) {
    var egOn = (S.mode === 'endgame');
    els.egBar.hidden = !egOn;
    if (egOn) {
      // ★ 十六轮：最左「确定 / 已确定」—— 已确定时点亮浅绿
      els.btn_eg_ok.textContent = S.egLocked ? T('egOkOn') : T('egOk');
      els.btn_eg_ok.classList.toggle('eg-ok', !!S.egLocked);
      els.btn_eg_seq.classList.toggle('eg-on', !!S.egSeq);
      els.btn_eg_free.classList.toggle('eg-on', !S.egSeq);
      if (els.egKeys) els.egKeys.hidden = !!S.egSeq;      // 顺序摆盘不弹选色框
      els.btn_eg_b.classList.toggle('sel-b', !S.egSeq && S.egColor === 1);
      els.btn_eg_w.classList.toggle('sel-w', !S.egSeq && S.egColor === 2);
    }
  }
  // ★ 主窗口里**没有任何复盘按键**（复盘搬去独立窗口了）：底栏就是一行居中的对局按键。
  //   这里只保留「重来 / 重新开始」的文案区分所需的那一个开关位（复盘窗走 refreshRvUI）。
  els.btn_reset.textContent = T('reset');
  if (els.heatLegend) els.heatLegend.hidden = !((S.heat || S.coach) && S.mode !== 'place' && S.mode !== 'endgame');
  // ★ 2026-09-23（用户要求）：残局模式（含 VC 载入的残局）下交换手规则不适用 → 下拉里**变灰禁用**
  if (els.sel_rule) {
    [].forEach.call(els.sel_rule.querySelectorAll('option'), function (o) {
      if (o.value === '5' || o.value === '6' || o.value === '7') o.disabled = (S.mode === 'endgame');
    });
  }
  els.btn_prev.disabled = openActive() || G.moves.length === 0;
  els.btn_next.disabled = openActive() || !G.redo.length;
  // 局面代码**实时镜像**当前棋盘。原来只「输入框为空时填一次」，结果填过一次以后
  // 再也不更新 —— 这就是「局面代码不能正确显示棋盘局面」的根因。用户正在框里编辑时不打断。
  if (document.activeElement !== els.inp_code) {
    var codeTxt = buildCode();
    if (els.inp_code.value !== codeTxt) els.inp_code.value = codeTxt;
  }
  drawCurve();
}

// ---------------------------------------------------------------- 评估曲线（贝塞尔平滑 + 活动的纵轴量程）
// 纵坐标**固定**在左边：轴是块独立画布，永远不随绘图区的横向滚动而动（用户要求）。
// ★ 2026-09-19（用户要求）：纵轴量程改成**活动**的 ——
//   「初始的时候正负 10 的范围，随着评估分数越来越高，坐标轴也应该变得越来越大
//    （随着分数收紧坐标轴，就是单位坐标轴进位要变大）…… 可能到最后会出现正负 1200」。
//   CURVE_TIERS = [量程, 刻度步长] 的阶梯表：分数冲上去就跳档，**量程和进位一起变大**；
//   分数回落则退档（带 0.8 的死区，免得在档位边界来回跳、曲线跟着抖）。
// ★ 2026-09-25（用户要求「评估分数依靠 rapfi 官方」）：量程上限由自定的 ±1250 改成
//   **Rapfi 官方的非杀棋评估上限 ±6000**（VALUE_EVAL_MAX，见 evalNum 的注释）。
//   原来封在 ±1250，而官方评估动辄 ±2000~±6000 —— 大半条曲线被钳在轴顶/轴底画成直线，
//   这也是「曲线效果一般」的一半原因。现在按官方量程放档，±1200 仍在 [2000,500] 档里。
//   杀棋（官方编码 ±(30000-n)）**不计入档位**，由 yOf 压进最外侧窄带 —— 否则一个
//   29988 的杀棋分会把整条评估曲线压成一条贴着 0 分线的直线。
var CURVE_TIERS = [
  [10, 2], [20, 5], [50, 10], [100, 25], [200, 50], [500, 100],
  [1000, 250], [2000, 500], [4000, 1000], [6000, 1500],
];
var curveTier = 0;                 // 当前档位；跨帧保留 = 曲线自己的「记忆」
/** 刻度标签：万位以上压成 20k（轴宽只有 30px，六位数会顶出轴外）。 */
function cvLabel(v) {
  var s = (Math.abs(v) >= 10000) ? (v / 1000).toFixed(0) + 'k' : String(v);
  return (v > 0 ? '+' : '') + s;
}
function drawCurve() {
  var cv = els.curve, scroll = els.curveScroll, ax = els.curveAxis;
  if (!cv || !scroll || !ax) return;
  var dpr = window.devicePixelRatio || 1;
  // 逻辑高度：轴与绘图区必须一致，刻度才对得上。
  // ★ 2026-09-19（用户要求）：「这个卡片有一个较为舒适的高度」。
  //   高度原来是**量出来**的（= 左列「对局设置」卡高 − 仪表盘卡高 − 间距 − 卡内边距），
  //   于是左列卡一高（窄栏里标签换行，卡被撑到 700px+），这条曲线就被一路拉到 ~490px，
  //   刻度线间隔 60px、中间一大片空白 —— 用户连着两轮说「不要太过高，要适中舒服」。
  //   ⇒ 改成**锁死一个舒适档**：16rem（按 root 字号跟随窗口缩放）。
  //     root 18.5px 时约 296px，9~11 条刻度线的间隔 ~27px，读起来正好。
  //   代价：右列（仪表盘 + 曲线）不再与左列等高 —— 用户 2026-09-19 明确选的就是这一档。
  var rootFs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  var H = Math.round(16 * rootFs);
  var padT = 10, padB = 18;
  var y0 = padT, y1 = H - padB;
  // ---- 纵轴量程：活动档位（阶梯表见文件上方 CURVE_TIERS 的说明）----
  var peak = 0;
  G.curve.forEach(function (p) {
    var vb = Math.abs(p.b || 0), vw = Math.abs(p.w || 0);
    if (vb > RAPFI_EVAL_MAX || vw > RAPFI_EVAL_MAX) return;   // 杀棋不参与定档（见上方注释）
    peak = Math.max(peak, vb, vw);
  });
  if (!G.curve.length) curveTier = 0;                 // 空盘 / 换局 → 回到最初那一档（±10）
  var ti = 0;
  while (ti < CURVE_TIERS.length - 1 && peak > CURVE_TIERS[ti][0]) ti++;
  if (ti > curveTier) curveTier = ti;                                        // 升档：立刻
  else if (ti < curveTier && peak <= CURVE_TIERS[ti][0] * 0.8) curveTier = ti;  // 降档：跌到 80% 才退
  var RANGE = CURVE_TIERS[curveTier][0], STEP = CURVE_TIERS[curveTier][1];
  function yOf(v) {
    // 杀棋（|v| > 官方 ±6000）：压进最外侧 8% 的窄带里，越短杀越贴边（M1 贴边、M* 靠内）。
    // 这样既保留了官方编码（步数仍看得出来），又不会把整条评估曲线压扁。
    if (Math.abs(v) > RAPFI_EVAL_MAX) {
      var d = Math.max(0, Math.min(1,
        (Math.abs(v) - RAPFI_EVAL_MAX) / (RAPFI_MATE - RAPFI_EVAL_MAX)));
      var band = 0.08 * (1 - d);
      return y0 + (y1 - y0) * ((v > 0) ? band : (1 - band));
    }
    var t = (RANGE - v) / (2 * RANGE);
    return y0 + (y1 - y0) * Math.max(0, Math.min(1, t));
  }
  // 轴宽：量程到 4000+ 时标签是 5 位（+6000），30px 放不下 → 加宽到 36px。
  var AXW = (RANGE >= 1000) ? 36 : 30;

  // ---- ① 左侧纵轴：固定不滚动 ----
  ax.style.width = AXW + 'px';
  ax.style.height = H + 'px';
  ax.width = Math.round(AXW * dpr);
  ax.height = Math.round(H * dpr);
  var ac = ax.getContext('2d');
  ac.setTransform(1, 0, 0, 1, 0, 0);
  ac.clearRect(0, 0, ax.width, ax.height);
  ac.scale(dpr, dpr);
  ac.font = '9px sans-serif';
  ac.textBaseline = 'middle';
  ac.textAlign = 'right';
  for (var g = -RANGE; g <= RANGE; g += STEP) {
    var gy = yOf(g);
    ac.strokeStyle = (g === 0) ? css('--sub') : css('--border');
    ac.lineWidth = (g === 0) ? 1.4 : 1;
    ac.beginPath(); ac.moveTo(AXW - 6, gy); ac.lineTo(AXW, gy); ac.stroke();
    ac.fillStyle = css('--sub');
    ac.fillText((g > 0 ? '+' : '') + g, AXW - 8, gy);
  }

  // ---- ② 右侧绘图区：向后延伸（画布随点数变宽，容器横向滚动） ----
  var availW = Math.max(160, scroll.clientWidth - 2);
  var step = 18;
  // ★ 2026-09-20 修复：x 坐标改用**手数**（p.i）而不是数组下标 —— 悔棋/重下会造成 ply 缺口，
  //   按下标压缩会把曲线挤变形（用户看到的「又变得不连贯」的另一半原因）。
  var maxPly = 0;
  G.curve.forEach(function (p) { maxPly = Math.max(maxPly, p.i || 0); });
  var need = 16 + Math.max(0, maxPly) * step + 16;
  var w = Math.max(availW, need);
  var padL = 6, padR = 14;
  var x0 = padL, x1 = w - padR;
  cv.style.width = w + 'px';
  cv.style.height = H + 'px';
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(H * dpr);
  var ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.scale(dpr, dpr);

  ctx.lineWidth = 1;                          // 横网格线与左边轴的刻度一一对齐
  for (var g2 = -RANGE; g2 <= RANGE; g2 += STEP) {
    var gy2 = yOf(g2);
    ctx.strokeStyle = (g2 === 0) ? css('--sub') : css('--border');
    ctx.lineWidth = (g2 === 0) ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(x0, gy2); ctx.lineTo(x1, gy2); ctx.stroke();
  }

  if (G.curve.length < 1) {
    ctx.fillStyle = css('--sub');
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(T('curve'), x0 + 8, (y0 + y1) / 2);
    return;
  }

  /** ★ 2026-09-20（用户反馈）：「评估曲线又变得不连贯了，并且面积填充的也不好」。
   *  两个根因 + 修法：
   *  ① 个别点的估值不是有限数（引擎离线那一手 / 历史导入）→ NaN 把贝塞尔整段打断 ⇒
   *     画之前先过滤非有限值，曲线永不断开；
   *  ② 面积原来用「曲线 + 两根到 0 轴的直线」围一个大多边形，曲线穿过 0 轴时就成了
   *     蝴蝶结（自交），填充东漏一块西补一块 ⇒ 改成**逐段梯形**：把贝塞尔离散成密集
   *     折线，每小段与 0 轴围一个四边形分别填 —— 穿轴也严丝合缝。 */
  function plot(key, color) {
    var pts = [];
    G.curve.forEach(function (p) {
      var v = p[key];
      if (typeof v !== 'number' || !isFinite(v)) return;   // NaN / undefined 一律跳过
      pts.push({
        x: x0 + (x1 - x0) * (maxPly <= 1 ? 0 : (p.i / maxPly)),
        y: yOf(Math.max(-RANGE, Math.min(RANGE, v))),
      });
    });
    if (!pts.length) return;
    var yz = yOf(0);
    function trace() {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) { ctx.lineTo(pts[0].x + 0.1, pts[0].y); return; }
      for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
                          p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
                          p2.x, p2.y);
      }
    }
    // 面积路径 = **单路径闭合填充**（2026-09-21 定稿：要平滑、不能「一条一条」的，
    //   填充以 0 分线为基准）。做法：把每段三次贝塞尔按 t **密集采样**（28 点/段，与 stroke
    //   的 trace() 同参数 → 填充严丝合缝贴着曲线走），整条「曲线折线 + 0 轴回程」闭成
    //   **一个**路径 —— 无接缝、穿 0 轴也不漏。填色见下面「逐层收缩」处的说明（2026-09-25
    //   由「垂直渐变」改为「按曲线↔0分线的比例逐层收缩」：由曲线向 0 分线由深到浅，正负同规）。
    function rgba(hex, a) {
      return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' +
             parseInt(hex.slice(5, 7), 16) + ',' + a + ')';
    }
    var flat = [];
    for (var s = 0; s < pts.length - 1; s++) {
      var p0 = pts[s - 1] || pts[s], p1 = pts[s], p2 = pts[s + 1], p3 = pts[s + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      for (var t2 = 0; t2 < 28; t2++) {
        var u = t2 / 28, v = 1 - u;
        // ★★ 2026-09-25 真因修复：原来这里是 `w1=u*u*u … w4=v*v*v`，而 **w1 乘的是 P1、
        //   w4 乘的是 P2** —— 与三次贝塞尔的 Bernstein 权重正好互换：
        //     B(t) = (1-t)³P1 + 3(1-t)²t·C1 + 3(1-t)t²·C2 + t³P2
        //   互换后等价于 Bezier(P2, C2, C1, P1) = 同一条曲线**倒着走**：于是每段采样都是
        //   P2 → P1，`flat` 变成「pts[1]→pts[0]，再跳 pts[2]→pts[1]，再跳 pts[3]→pts[2]…」
        //   的**来回折返锯齿**。描边 trace() 用的是真 bezierCurveTo（所以线一直是顺的），
        //   而面积填充走的正是这条折返多边形 —— 这就是「填充不贴曲线 / 不平滑」的根因。
        //   改成正确的 Bernstein 权重后，flat 与 trace() 逐点重合，填充严丝合缝。
        var w1 = v * v * v, w2 = 3 * v * v * u, w3 = 3 * v * u * u, w4 = u * u * u;
        flat.push({ x: w1 * p1.x + w2 * c1x + w3 * c2x + w4 * p2.x,
                    y: w1 * p1.y + w2 * c1y + w3 * c2y + w4 * p2.y });
      }
    }
    flat.push(pts[pts.length - 1]);

    /** ★★ 2026-09-25（用户定稿）：曲形面积的渐变 = **从曲线向 0 横坐标轴由深到浅，
     *  正负两侧同一套**（曲线在轴上方就在上方往轴淡，在下方就在下方往轴淡）。
     *  为什么不能用「垂直渐变」：垂直渐变只认**屏幕纵坐标**，于是黑线（轴上方）是
     *  「上浓下淡」，白线（轴下方）就变成「上淡下浓」—— 浓淡方向跟着屏幕走而不是跟着
     *  曲线走，正负两侧必然相反，而且曲线凹下去靠近轴的地方边缘几乎透明。
     *  正确做法 —— **按「该点在『曲线 ↔ 0 分线』这条竖线段里的位置比例」上色**：
     *    把整条曲线朝 0 分线做**等比收缩** y(s) = yz + (y_曲线 − yz)·s，s∈[0,1]
     *    （s=1 就是曲线本身，s=0 就是 0 分线）。第 j 层填「曲线」与「收缩到 s=j/N 的副本」
     *    之间的那条带，由 s=0（整片区域）一层层叠到 s→1（贴着曲线的窄带）。
     *    任一点被覆盖的层数 ∝ 它的 s 值 ⇒ **贴曲线处最浓、越靠 0 分线越淡**，
     *    而且判定只跟「曲线 ↔ 轴」的比例有关 —— **曲线在轴上方还是下方完全无差别**，
     *    正负两侧自动同一套浓淡方向；曲线穿过 0 分线时也严丝合缝（不会像旧版那样自交漏色）。
     *  每层都是**一整条闭合路径**一次 fill —— 没有逐条描边的接缝，也没有色带断层。 */
    function scaledY(q, s) { return yz + (q.y - yz) * s; }
    function areaPath() {
      ctx.beginPath();
      ctx.moveTo(flat[0].x, yz);                 // 左端从 0 分线起笔
      for (var f2 = 0; f2 < flat.length; f2++) ctx.lineTo(flat[f2].x, flat[f2].y);
      ctx.lineTo(flat[flat.length - 1].x, yz);   // 右端下到 0 分线
      ctx.closePath();                           // 沿 0 分线走回左端，闭成一个整体
    }
    // ① 最淡的底：整片区域铺一层（保证远离曲线处也看得见颜色，不至于全透明）
    areaPath();
    ctx.fillStyle = rgba(color, 0.05);
    ctx.fill();
    // ② 由 0 分线侧向曲线侧一层层叠：层数越多越平滑（24 层的台阶肉眼不可辨）
    var AREA_LAYERS = 24, AREA_STEP = 0.010;
    for (var li = 0; li < AREA_LAYERS; li++) {
      var sIn = li / AREA_LAYERS;
      ctx.beginPath();
      ctx.moveTo(flat[0].x, flat[0].y);
      for (var f4 = 1; f4 < flat.length; f4++) ctx.lineTo(flat[f4].x, flat[f4].y);
      for (var f5 = flat.length - 1; f5 >= 0; f5--) ctx.lineTo(flat[f5].x, scaledY(flat[f5], sIn));
      ctx.closePath();
      ctx.fillStyle = rgba(color, AREA_STEP);
      ctx.fill();
    }
    ctx.strokeStyle = color;                 // ★ 不按正负变色：黑子恒紫、白子恒浅蓝
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    trace();
    ctx.stroke();
    ctx.fillStyle = color;
    pts.forEach(function (p) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2); ctx.fill();
    });
  }
  plot('b', '#7a5af8');
  // ★ 2026-09-19（用户要求）：白子曲线由原来的蓝（#7fb0ef）改成**再浅一点**的蓝 ——
  //   保持同一色相、只提亮度，深浅两套主题下都不与网格线混淆。
  plot('w', '#aecdf5');
  // 自动跟到最右端（"可以向后延伸"）；只有绘图区滚动，左边轴纹丝不动
  if (w > availW) scroll.scrollLeft = w;
}

// ---------------------------------------------------------------- 历史 / 保存历史
var HIST_KEY = 'gbcalc.history.v1';
var SAVED_KEY = 'gbcalc.saved.v1';
var HIST_MAX = 150;

function loadHist() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
}
function saveHist(list) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch (e) {}
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; }
}
function saveSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (e) {}
}
function addRecord(rec) {
  var list = loadHist();
  list.push(rec);
  while (list.length > HIST_MAX) list.shift();
  saveHist(list);
}
function saveCurrent() {
  if (!G.moves.length) return;
  var rec = { ts: Date.now(), src: 'local', rule: S.rule, first: S.side,
              moves: G.moves.map(function (m) { return [m.x, m.y, m.c]; }) };
  // ★ 十八/十九轮：残局记录 → 带 eg/egLen（历史标 Endgame、打开即展开残局）。
  //   确定过的 = egBase 长度；残局模式里直接存的 = 整个摆好的局面就是残局。
  if (S.egLocked && S.egBase && S.egBase.length) { rec.eg = true; rec.egLen = S.egBase.length; }
  else if (S.mode === 'endgame') { rec.eg = true; rec.egLen = G.moves.length; }
  addRecord(rec);
}

// ---- 抽屉 ----
var DR = { tab: 'hist', sel: {}, kb: -1 };   // ★ kb：方向键高亮的条目下标（八轮）
function openDrawer(tab) {
  DR.tab = tab || DR.tab;
  DR.sel = {};
  DR.kb = -1;                          // ★ 八轮：重开抽屉清掉方向键高亮
  if (els.dr_all) els.dr_all.textContent = T('selAll');   // ★ 二十轮：重开抽屉选择清空 → 键文字复位
  els.drawer.hidden = false;
  [].forEach.call(els.drawer.querySelectorAll('.tab'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-tab') === DR.tab);
  });
  // 「保存选中」只在「历史」页有意义：用 ghost-slot（visibility:hidden）藏 ——
  // 不能用 [hidden]（display:none 会让 2×3 网格重排，删除/关闭就跑出最右列了）。
  els.dr_save.classList.toggle('ghost-slot', DR.tab !== 'hist');
  renderDrawer();
}
function closeDrawer() { els.drawer.hidden = true; closeCtx(); }
/** 当前页（历史 / 保存历史）的正序数组 —— 改名 / 导出 / 删除都按这个下标来。 */
function listOfTab() { return (DR.tab === 'hist') ? loadHist() : loadSaved(); }
function renderDrawer() {
  if (els.t_drTip) els.t_drTip.textContent = T('drTip');   // 上一句提示（如「已导入 3 局」）复位
  var list = listOfTab();
  els.drCount.textContent = list.length + (DR.tab === 'hist' ? ' / ' + HIST_MAX : '');
  els.drList.innerHTML = '';
  // ★ 二十轮：「全部选中 / 取消全选」文字跟着实际勾选状态走
  if (els.dr_all) els.dr_all.textContent = drAllSelected() ? T('selNone') : T('selAll');
  if (!list.length) {
    els.drList.innerHTML = '<div class="empty">—</div>';
    return;
  }
  list.slice().reverse().forEach(function (h, ri) {
    var idx = list.length - 1 - ri;          // 正序下标，删/存都用它
    var d = document.createElement('div');
    d.className = 'item' + (DR.sel[idx] ? ' sel' : '');
    d.setAttribute('data-idx', String(idx)); // 改名时据它把行内输入框挂回这一条
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!DR.sel[idx];
    cb.onclick = function (e) {
      e.stopPropagation();
      DR.sel[idx] = cb.checked;
      d.classList.toggle('sel', cb.checked);
    };
    var srcTxt = h.src === 'desktop' ? T('srcDesktop')
               : (h.src === 'bookmark' ? T('srcBookmark')
               : (h.src === 'vis' ? T('visSrc') : T('srcLocal')));
    var no = document.createElement('span');
    no.className = 'no'; no.textContent = '#' + (idx + 1);
    // ★ 2026-09-19（用户要求）：「可以让用户自己更改某条历史的名字」。
    //   名字是可选的：没名字时 .nm 是空的（CSS 用 :empty 收掉，不占位也不显示「未命名」噪声）。
    var nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = h.name || '';
    var src = document.createElement('span');
    src.className = 'src'; src.textContent = srcTxt;
    // ★ 十八轮（用户要求）：确定过的残局记录 → 在历史里标「Endgame」（英文状态）
    var egTag = null;
    if (h.eg) {
      egTag = document.createElement('span');
      egTag.className = 'tag'; egTag.textContent = 'Endgame';
    }
    var ts = document.createElement('span');
    // ★ 2026-09-23（用户报）：英文模式下历史条目的时间戳跟随系统 locale，冒出「上午/下午」
    //   中文样式 —— 改为**跟着界面语言**走（en → en-US，zh → zh-CN）。
    ts.textContent = (h.ts ? new Date(h.ts).toLocaleString(S.lang === 'en' ? 'en-US' : 'zh-CN') : '');
    var m = document.createElement('span');
    var mn = (h.moves && h.moves.length) || 0;
    m.className = 'm'; m.textContent = T('nMoves').replace('{n}', String(mn));
    d.appendChild(cb); d.appendChild(no); d.appendChild(nm); d.appendChild(src);
    if (egTag) d.appendChild(egTag);           // ★ 十八轮：Endgame 徽标（来源之后、时间之前）
    d.appendChild(ts); d.appendChild(m);
    // ★ 2026-09-19（用户要求）：「在历史中打开某一个历史也是一个复盘也是一个新窗口」——
    //   点历史条目 = 开**独立复盘窗口**，绝不把这一局摆到主窗口棋盘上「接着下」。
    //   （老版本这里调的是 openRecord(h, true)，正是用户说的「还是会有连接的情况」。）
    //   hist=true → 复盘窗里会露出「背诵复盘 / 回顾复盘」那一组键。
    d.onclick = function () { openFromHistoryIndex(idx); };
    // ★ 2026-09-19（用户要求）：「用户选择了某个历史，右击了鼠标，可以有一个选择栏，
    //   里面有删除、重命名等一些功能」。宿主已经把 WebView2 的默认右键菜单关掉了
    //   （AreDefaultContextMenusEnabled=FALSE），所以这个菜单必须自己画 —— 见 showCtx()。
    d.oncontextmenu = function (e) {
      e.preventDefault();
      // 右键 = 顺手把这一条选成「唯一选中」（不然右键出来的菜单和左边勾选状态会打架）
      DR.sel = {};
      DR.sel[idx] = true;
      [].forEach.call(els.drList.querySelectorAll('.item'), function (n) {
        var on = (n === d);
        n.classList.toggle('sel', on);
        var c = n.querySelector('input[type=checkbox]');
        if (c) c.checked = on;
      });
      showCtx(e, idx);
    };
    els.drList.appendChild(d);
  });
}
function selectedIdx() {
  return Object.keys(DR.sel).filter(function (k) { return DR.sel[k]; })
    .map(function (k) { return +k; }).sort(function (a, b) { return a - b; });
}

// ★ 八轮（用户要求）：两个抽屉都支持**方向键选择** ——
//  · 历史/保存历史抽屉：↑↓（←→ 同效）移动高亮（↑ = 更新一条），回车打开该局复盘；
//  · 图片抽屉（识图窗）：←→（↑↓ 同效）移动高亮，回车载入该张图识别。
//  前瞻开着的 ←/→ 步进优先；焦点在输入框/代码框里不抢。
function drKbPaint() {
  [].forEach.call(els.drList.querySelectorAll('.item'), function (n) {
    var idx = +(n.getAttribute('data-idx') || -1);
    var on = idx === DR.kb;
    n.classList.toggle('kb', on);
    if (on && n.scrollIntoView) { try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  });
}
function drKeyNav(d) {
  var list = listOfTab();
  if (!els.drList || !list.length) return;
  if (DR.kb < 0 || DR.kb >= list.length) DR.kb = list.length - 1;   // 默认落在最新一条
  DR.kb = Math.max(0, Math.min(list.length - 1, DR.kb + d));
  drKbPaint();
}
function drKbEnter() {
  if (DR.kb >= 0 && DR.kb < listOfTab().length) openFromHistoryIndex(DR.kb);
}
function visKbPaint() {
  if (!els.vdList) return;
  [].forEach.call(els.vdList.querySelectorAll('.vd-item'), function (n) {
    var idx = +(n.getAttribute('data-idx') || -1);
    var on = idx === VIS.kb;
    n.classList.toggle('kb', on);
    if (on && n.scrollIntoView) { try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  });
}
function visKeyNav(d) {
  if (!els.vdList || !VIS.list.length) return;
  if (VIS.kb < 0 || VIS.kb >= VIS.list.length) VIS.kb = VIS.idx;    // 默认落在当前那张
  VIS.kb = Math.max(0, Math.min(VIS.list.length - 1, VIS.kb + d));
  visKbPaint();
}
function visKbEnter() {
  if (VIS.kb >= 0 && VIS.kb < VIS.list.length) { VIS.idx = VIS.kb; VIS.kb = -1; visRefreshView(); }
}
document.addEventListener('keydown', function (e) {
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (G.fwd && G.fwd.on && G.fwd.line.length) return;               // 前瞻步进优先
  var visOpen = !!(els.visDrawer && !els.visDrawer.hidden);
  var drOpen = !!(els.drawer && !els.drawer.hidden);
  if (visOpen && !drOpen) {                                         // 图片抽屉
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { visKeyNav(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { visKeyNav(-1); e.preventDefault(); }
    else if (e.key === 'Enter') { visKbEnter(); e.preventDefault(); }
    return;
  }
  if (drOpen) {                                                     // 历史/保存历史抽屉
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { drKeyNav(1); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { drKeyNav(-1); e.preventDefault(); }
    else if (e.key === 'Enter') { drKbEnter(); e.preventDefault(); }
    return;
  }
  // ★ 2026-09-25（用户要求）：主窗口 ←/→ 方向键 = 上一步 / 下一步（与 ‹ › 两键同效）。
  //   输入框 / 图片抽屉 / 历史抽屉 / 前瞻步进都优先（前面各分支已接手或已 return）；
  //   复盘窗口另有自己的左右键口径（回顾播放），不在这条里生效。
  if (!RV_MODE && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key === 'ArrowLeft') { stepBack(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { stepForward(); e.preventDefault(); }
  }
});

// ---------------------------------------------------------------- 改名（用户要求）
/** 改某一局的名字。空名字 = 删掉 name 字段（列表里那一段就空出来）。 */
function renameRecord(idx, val) {
  var list = listOfTab();
  if (!list[idx]) return false;
  var nm = String(val == null ? '' : val).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
  if (nm) list[idx].name = nm; else delete list[idx].name;
  if (DR.tab === 'hist') saveHist(list); else saveSaved(list);
  renderDrawer();
  toast(T('renamed'));
  return true;
}
/** 行内改名：把这一条的名字那一段换成输入框，回车/失焦 = 存，Esc = 撤。
 *  改完走 renameRecord → renderDrawer，整行重建（所以这里只用管这一次输入）。 */
function beginRename(idx) {
  var item = els.drList.querySelector('.item[data-idx="' + idx + '"]');
  var span = item ? item.querySelector('.nm') : null;
  if (!span) return false;
  var rec = listOfTab()[idx] || {};
  var inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'rn'; inp.maxLength = 40;
  inp.value = rec.name || '';
  inp.placeholder = T('namePh');
  var settled = false;
  function settle(keep) {
    if (settled) return;                    // renderDrawer 会把输入框拆掉 → blur 会再进来一次
    settled = true;
    if (keep) renameRecord(idx, inp.value); else renderDrawer();
  }
  inp.onkeydown = function (e) {
    e.stopPropagation();                    // 别让 Esc/回车冒到全局
    if (e.key === 'Enter') { e.preventDefault(); settle(true); }
    else if (e.key === 'Escape') { e.preventDefault(); settle(false); }
  };
  inp.onblur = function () { settle(true); };
  inp.onclick = function (e) { e.stopPropagation(); };
  span.textContent = '';                    // .nm:empty 的那条 display:none 随即失效 → 输入框可见
  span.appendChild(inp);
  inp.focus();
  try { inp.select(); } catch (e) {}
  return true;
}

// ---------------------------------------------------------------- 历史条目的右键菜单
var CTX = { idx: -1 };
function closeCtx() { if (els.ctxMenu) els.ctxMenu.hidden = true; CTX.idx = -1; }
/** 在鼠标处弹菜单。菜单项按当前页（hist / saved）现拼：
 *   打开复盘 / 重命名 / 导出这一局 / （历史里还有）存入「保存历史」/ 删除。 */
function showCtx(ev, idx) {
  var m = els.ctxMenu;
  if (!m) return;
  CTX.idx = idx;
  m.innerHTML = '';
  var items = [
    [T('ctxOpen'), false, function () { openFromHistoryIndex(idx); }],
    [T('ctxRename'), false, function () { beginRename(idx); }],
    [T('ctxExport'), false, function () { exportRecords([listOfTab()[idx]], exportNameOf(idx)); }],
  ];
  if (DR.tab === 'hist') items.push([T('ctxToSaved'), false, function () { moveToSaved([idx]); }]);
  items.push([T('ctxDel'), true, function () { deleteIndexes([idx]); }]);
  items.forEach(function (it) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = it[0];
    if (it[1]) b.className = 'danger';
    b.onclick = function (e) { e.stopPropagation(); closeCtx(); it[2](); };
    m.appendChild(b);
  });
  m.hidden = false;
  var w = m.offsetWidth, h = m.offsetHeight;               // 先显后量才拿得到尺寸
  m.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(ev.clientY, window.innerHeight - h - 6)) + 'px';
  return true;
}
function exportNameOf(idx) {
  var h = listOfTab()[idx] || {};
  return (h.name ? h.name : 'gomoku-game-' + (idx + 1)) + '.txt';
}

// ---------------------------------------------------------------- 增删 / 搬运
/** 按正序下标删若干条（右键「删除」与抽屉「删除」共用）。 */
function deleteIndexes(idxs) {
  idxs = (idxs || []).slice().sort(function (a, b) { return a - b; });
  if (!idxs.length) return 0;
  var list = listOfTab().filter(function (_, i) { return idxs.indexOf(i) < 0; });
  if (DR.tab === 'hist') saveHist(list); else saveSaved(list);
  DR.sel = {};
  renderDrawer();
  return idxs.length;
}
/** 把历史里的若干条搬进「保存历史」（右键菜单那一条；抽屉「保存选中」走同一套）。 */
function moveToSaved(idxs) {
  var hist = loadHist(), picked = [];
  (idxs || []).forEach(function (i) { if (hist[i]) picked.push(hist[i]); });
  if (!picked.length) return 0;
  saveSaved(loadSaved().concat(picked));
  saveHist(hist.filter(function (_, i) { return idxs.indexOf(i) < 0; }));
  DR.sel = {};
  openDrawer('saved');
  return picked.length;
}
/** 打开历史里的第 idx 局。
 *  · 主窗口 → 交给宿主开**独立复盘窗口**（hist=true → 那边露背诵/回顾）；
 *  · 复盘窗口里自己点 → 直接就地载入（不用再绕宿主开一个窗口）。 */
function openFromHistoryIndex(idx) {
  var h = listOfTab()[idx];
  if (!h) return false;
  closeCtx();
  if (RV_MODE) { reviewLoad(recordForReview(h, true)); closeDrawer(); return true; }
  openReviewWindow(h, true);
  closeDrawer();
  return true;
}

// ---------------------------------------------------------------- 历史导出 / 导入（txt）
// ★ 2026-09-19（用户要求）：「历史记录中的历史可以导出导入通过 txt 中的代码」。
//   txt 就是**局面代码**的集合（与 gomocalc.com 同格式），一行一局，行首可带名字：
//       <名字>\t<局面代码>
//   —— 用 **TAB** 分隔名字与代码（名字里出现字母+数字也不会被解析成着法）；
//      没有 TAB 的整行就按纯粹的局面代码读（手写的 txt 也能用）。
//      「#」开头的行是注释，导入时跳过。文件是 UTF-8（宿主写盘带 BOM，中文记事本才不乱码）。
// ★ 表头是**注释**，所以可以（也应该）跟着语言走：英文模式下导出的是英文说明。
var HIST_TXT_HEAD = {
  zh: '# 五子棋练习器 · 历史导出 v1\n' +
      '# 每行一局：<名字>\\t<局面代码>（名字可空；代码 = 小写列字母 + 行号，逐手拼接，与 gomocalc.com 同格式）\n' +
      '# 「#」开头的行是注释，导入时跳过。\n',
  en: '# Gomoku Trainer · history export v1\n' +
      '# One game per line: <name>\\t<position code> (name optional; code = lowercase column letter + row, moves concatenated, same format as gomocalc.com)\n' +
      '# Lines starting with "#" are comments and are skipped on import.\n',
};
function histTxtOf(list) {
  var head = HIST_TXT_HEAD[S.lang] || HIST_TXT_HEAD.zh;
  return head + (list || []).map(function (h) {
    var nm = String((h && h.name) || '').replace(/[\r\n\t]+/g, ' ');
    return nm + '\t' + movesToCode(h && h.moves);
  }).join('\n') + '\n';
}
/** 导出若干局。宿主在 → 弹系统「另存为」由用户挑路径（同「保存局面」的套路）；
 *  浏览器里（没有宿主）退回 Blob 下载。返回导出的局数（0 = 没东西可导）。 */
function exportRecords(list, fname) {
  list = (list || []).filter(Boolean);
  if (!list.length) { toast(T('expNone')); return 0; }
  var txt = histTxtOf(list);
  var name = fname || ('gomoku-history-' + list.length + '.txt');
  if (HOST) {
    tellHost({ type: 'saveTxt', name: name, data: txt, n: list.length });
    return list.length;
  }
  try {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 4000);
  } catch (e) { return 0; }
  toast(T('expDone').replace('{n}', String(list.length)));
  return list.length;
}
/** 抽屉「导出」：有勾选就导出勾选的，没勾选就导出当前页全部。 */
function exportSelected() {
  var list = listOfTab(), idx = selectedIdx();
  var picked = idx.length ? idx.map(function (i) { return list[i]; }) : list;
  var nm = (picked.length === 1 && picked[0] && picked[0].name) ? picked[0].name : '';
  return exportRecords(picked, nm ? nm + '.txt' : '');
}
/** 解析导入的 txt → 记录数组。一行一局；空行与「#」注释跳过；认不出着法的行丢弃。 */
function parseHistTxt(text) {
  var out = [];
  var lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    var name = '', code = line;
    var tab = line.indexOf('\t');
    if (tab >= 0) { name = line.slice(0, tab).trim(); code = line.slice(tab + 1); }
    var mv = parseCode(code);
    if (!mv.length) continue;
    var rec = { ts: Date.now() + i, src: 'local', rule: S.rule,
                moves: mv.map(function (m) { return [m[0], m[1], m[2]]; }) };
    name = name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
    if (name) rec.name = name;
    out.push(rec);
  }
  return out;
}
/** 导入一段 txt：解析出来的局**追加**进历史（上限 HIST_MAX，最旧的被挤掉）。返回入库局数。 */
function importHist(text) {
  if (text == null) { toast(T('impFail')); return 0; }
  var recs = parseHistTxt(text);
  if (!recs.length) { toast(T('impNone')); return 0; }
  var list = loadHist().concat(recs);
  while (list.length > HIST_MAX) list.shift();
  saveHist(list);
  if (DR.tab === 'hist') renderDrawer();
  toast(T('impDone').replace('{n}', String(recs.length)));
  // 回执给宿主（端到端测试据它确认入库）：n = 局数，fp = 每局「名字=代码」的指纹 ——
  // 于是「文件里写的」和「库里存的」可以逐字节对上，光看局数会漏掉内容被改坏。
  tellHost({ type: 'histImported', n: recs.length,
             fp: recs.map(function (r) {
               return (r.name || '') + '=' + movesToCode(r.moves);
             }).join(' | ') });
  return recs.length;
}
/** 端到端测试用（宿主 GB_TEST_HIST_ROUNDTRIP=1 时才被调到）：
 *  先往历史里塞两局（**都带名字**，其中一局是黑连五的九手），再走一次导出。
 *  宿主写盘后会回一条 testHistNowImport → 页面紧接着把它读回来，于是
 *  「导出 → 文件 → 导入 → 入库」这条闭环在真实 exe 上被完整走了一遍。 */
function testHistExport() {
  var seed = [
    { ts: 1700000000000, src: 'local', name: '导出样本A', rule: 0,
      moves: [[7, 7, 1], [8, 7, 2], [7, 8, 1], [8, 8, 2], [7, 9, 1],
              [8, 9, 2], [7, 10, 1], [8, 10, 2], [7, 11, 1]] },
    { ts: 1700000001000, src: 'local', rule: 0, moves: [[0, 0, 1], [1, 0, 2], [0, 1, 1]] },
  ];
  saveHist(seed);
  renderDrawer();
  return exportRecords(seed, 'gb-hist-roundtrip.txt');
}

/** 让宿主弹系统「打开」对话框读 txt；浏览器里退回 <input type=file>。 */
function pickImport() {
  if (HOST) { tellHost({ type: 'openTxt' }); return true; }
  if (els.file_imp) { els.file_imp.value = ''; els.file_imp.click(); return true; }
  return false;
}
/** 一句反馈：主窗口写仪表盘的状态行；复盘窗没有仪表盘 → 写在抽屉的提示行上。 */
function toast(msg) {
  if (!msg) return;
  if (RV_MODE) { if (els.t_drTip) els.t_drTip.textContent = msg; return; }
  setStat(null, msg);
}

// ---------------------------------------------------------------- 抽屉接线（两个窗口共用）
/** 抽屉的接线**只写这一处**：主窗口与复盘窗都要用（复盘窗里点「历史」也能挑一局），
 *  两边的差别只有一处 —— 「打开一局」往哪儿去（openFromHistoryIndex 里按 RV_MODE 分流）。 */
/* ------------------------------------------------------------------ 「关于」浮层
 * ★ 2026-09-19（用户要求）：版本号 + 功能介绍 + 用到的开源组件 + MIT 许可。
 *   两个要点：
 *   ① 版本号只有一个来源 —— 下面的 APP_VERSION，改这里就行（网页启动器那边另有一份，同步改）。
 *   ② 开源组件**逐个**标真实许可证。引擎内核 Rapfi 是 GPL-3.0，笼统写成 MIT 是错的。
 *   ★ 2026-09-27（用户要求）：版本对齐套件口径 —— 4.30 → **4.31**（识别器启动器关于页同步）。
 *   ★ 2026-09-27 二批（用户意见①②③）：4.31 → **4.32**（实时仪表盘 / 卡塔狗名次色 / 字号随格缩放）。
 */
var APP_VERSION = '4.33';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderAbout() {
  if (!els.about || !els.ab_body) return;
  var h = '';
  h += '<div class="ab-app">' + escHtml(T('aboutApp')) + '</div>';
  h += '<div class="ab-ver">' + escHtml(T('aboutVer')) + ' <b>v' + escHtml(APP_VERSION) + '</b></div>';

  // ★ 十六轮（用户要求）：顺序改为 **使用方法 → 功能 → 开源组件 → 许可 → 最近更新** ——
  //   先教怎么用，最后才放更新日志（更新只留主要功能 / 新功能 / 优化，不再堆细枝末节）。
  // ★ 九轮（用户要求）：中英双语保姆级「使用方法」—— 分节 + 段落，随语言切换重画
  h += '<div class="ab-h2">' + escHtml(T('aboutGuide')) + '</div>';
  (T('aboutGuideList') || []).forEach(function (sec) {
    h += '<div class="ab-g-sec"><div class="ab-g-t">' + escHtml(sec.t) + '</div>';
    (sec.ps || []).forEach(function (p) { h += '<p class="ab-g-p">' + escHtml(p) + '</p>'; });
    h += '</div>';
  });

  h += '<div class="ab-h2">' + escHtml(T('aboutFeat')) + '</div><ul class="ab-ul">';
  (T('aboutFeatList') || []).forEach(function (x) { h += '<li>' + escHtml(x) + '</li>'; });
  h += '</ul>';

  h += '<div class="ab-h2">' + escHtml(T('aboutOss')) + '</div>';
  h += '<table class="ab-tb"><tbody>';
  (T('aboutOssList') || []).forEach(function (r) {
    h += '<tr><td class="ab-n">' + escHtml(r[0]) + '</td><td class="ab-d">' + escHtml(r[1]) +
         '</td><td class="ab-l">' + escHtml(r[2]) + '</td></tr>';
  });
  h += '</tbody></table>';
  h += '<div class="ab-lic">' + escHtml(T('aboutOssNote')) + '</div>';

  h += '<div class="ab-h2">' + escHtml(T('aboutLic')) + '</div>';
  h += '<div class="ab-lic">' + escHtml(T('aboutLicText')) + '</div>';

  // ★ 2026-09-21（用户要求）：「最近更新」—— 十六轮起挪到**最后**一节
  h += '<div class="ab-h2">' + escHtml(T('aboutUpdates')) + '</div><ul class="ab-ul ab-news">';
  (T('aboutUpdateList') || []).forEach(function (x) { h += '<li>' + escHtml(x) + '</li>'; });
  h += '</ul>';
  els.ab_body.innerHTML = h;
}
function openAbout() { renderAbout(); if (els.about) els.about.hidden = false; }
function closeAbout() { if (els.about) els.about.hidden = true; }
function wireAbout() {
  if (els.btn_about) els.btn_about.onclick = openAbout;
  if (els.ab_close) els.ab_close.onclick = closeAbout;
  if (els.about) els.about.addEventListener('click', function (e) {
    if (e.target === els.about) closeAbout();          // 点遮罩空白处 = 关闭
  });
}

/** 当前页是否已经全部勾选（「全部选中」键切换文字用；applyLang 也用它）。 */
function drAllSelected() {
  var list = listOfTab();
  if (!list.length) return false;
  for (var i = 0; i < list.length; i++) if (!DR.sel[i]) return false;
  return true;
}
function wireDrawer() {
  [].forEach.call(els.drawer.querySelectorAll('.tab'), function (b) {
    b.onclick = function () { openDrawer(b.getAttribute('data-tab')); };
  });
  // ★ 二十轮（用户要求）：「全部选中」= 一键勾选当前页全部条目；全部已选中时再点 = 取消全选
  if (els.dr_all) els.dr_all.onclick = function () {
    var list = listOfTab();
    if (!list.length) return;
    if (drAllSelected()) { DR.sel = {}; }
    else { DR.sel = {}; for (var j = 0; j < list.length; j++) DR.sel[j] = true; }
    els.dr_all.textContent = drAllSelected() ? T('selNone') : T('selAll');
    renderDrawer();
  };
  els.dr_close.onclick = closeDrawer;
  // ★ 2026-09-19（用户要求）：点抽屉**外面**的任何地方 → 抽屉自动收起。
  //   只认左键；抽屉内部（列表、改名框、右键菜单）不算「外面」；
  //   「历史」开关键也豁免 —— 它自己是 toggle，先被这里收起再被 click 翻开等于没关。
  //   ★ 2026-09-21（六轮，真凶修复）：#ctxMenu 是 body 顶层的浮层，**不在 #drawer 里**！
  //     不豁免它的话，点菜单项的 mousedown 先到 → 整个抽屉被收起（菜单随之 display:none）
  //     → click 落空 → 右键菜单「能弹出但功能全部失效、一点就退出」（用户实测复现的正是这个）。
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || els.drawer.hidden) return;
    if (els.drawer.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('#btn_history')) return;
    if (e.target && e.target.closest && e.target.closest('#ctxMenu')) return;
    closeDrawer();
  });
  els.dr_exp.onclick = exportSelected;
  els.dr_imp.onclick = pickImport;
  els.dr_save.onclick = function () { moveToSaved(selectedIdx()); };
  els.dr_del.onclick = function () { deleteIndexes(selectedIdx()); };
  els.dr_open.onclick = function () {
    var idx = selectedIdx();
    if (!idx.length) return;
    openFromHistoryIndex(idx[0]);
  };
  if (els.file_imp) {
    els.file_imp.onchange = function () {
      var f = els.file_imp.files && els.file_imp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { importHist(String(fr.result || '')); };
      fr.onerror = function () { toast(T('impFail')); };
      fr.readAsText(f, 'utf-8');
    };
  }
  // 菜单的关闭时机：点别处 / 翻列表 / 按 Esc（点菜单项自己会先 closeCtx）
  document.addEventListener('click', function (e) {
    if (els.ctxMenu && !els.ctxMenu.hidden && !els.ctxMenu.contains(e.target)) closeCtx();
  }, true);
  document.addEventListener('contextmenu', function (e) {
    // 右键点空白处（不是历史条目）→ 把菜单收掉
    var t = e.target;
    var onItem = !!(t && t.closest && t.closest('.item, #ctxMenu'));
    if (els.ctxMenu && !els.ctxMenu.hidden && !onItem) closeCtx();
  }, true);
  // ★ 五轮（用户反馈）：「右击选中某一个历史进行操作的功能全部失效」—— 源码逐条接线查证完好，
  //   这里再补一层**事件委托**兜底：条目里任何子元素（勾选框 / 序号 / 名字 / 手数）上右键
  //   都能命中最近的 .item，杜绝个别子元素把事件拦掉导致整条失效。
  els.drList.addEventListener('contextmenu', function (e) {
    var it = e.target && e.target.closest ? e.target.closest('.item') : null;
    if (!it) return;
    var idx = +it.getAttribute('data-idx');
    if (isNaN(idx)) return;
    e.preventDefault();
    e.stopPropagation();
    DR.sel = {};
    DR.sel[idx] = true;
    [].forEach.call(els.drList.querySelectorAll('.item'), function (n) {
      var on = (n === it);
      n.classList.toggle('sel', on);
      var c = n.querySelector('input[type=checkbox]');
      if (c) c.checked = on;
    });
    showCtx(e, idx);
  });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCtx(); });
  els.drList.addEventListener('scroll', closeCtx);
}

// ---------------------------------------------------------------- 打开一局 / 复盘
// ★ 2026-09-19 用户要求（本轮核心改动，原文）：
//   「打开复盘，弹出一个新的窗口，就是一个新的窗口，这个窗口只有一个棋盘和下面的几个控制键，
//     不参与任何功能的连接，比如说 AI 功能以及有禁手、无禁手功能」
//   「在历史中打开某一个历史也是一个复盘也是一个新窗口，因为现在还是会有连接的情况」
//   「点击复盘的时候，是一个特别简单的框，就是没有任何功能（没有 AI 和规则干扰的第三方纯棋盘框），
//     只能用户自行落子，只有一个棋盘和复盘功能相关的几个功能键」
//   ⇒ 复盘**整体搬出主窗口**：主窗口只管对局；复盘由宿主开**第二个顶层窗口**
//     （host.cpp 的 GbCalcReview），页面在那边以 RV_MODE 跑，一个引擎请求都不发。
//     这也就消掉了用户说的「还是会有连接的情况」—— 老版本是**在主窗口里**换棋盘，
//     于是复盘时会冒出「轮到黑棋」这种对局语义，还顺手把主窗口的对局暂存/恢复了一遍。

/** 历史 / 外部记录 → 复盘窗口要用的精简记录。
 *  复盘窗不认规则（用户要求），所以这里只带 moves：够背诵/回顾用就行。
 *  ★ `hist` = 这局**是不是从历史里挑的**。复盘窗据此决定要不要露出「背诵 / 回顾 / 背错」
 *    那一组键（用户要求：主界面点「复盘」进来只留「重来 / 保存局面 / 关闭」）。 */
function recordForReview(h, hist) {
  // 没显式给 hist 就看记录自己带没带（TEST_RV_RECORD 这类固定样本就自带 hist:true）
  var fromHist = (hist === undefined) ? !!(h && h.hist) : !!hist;
  return {
    ts: (h && h.ts) || Date.now(),
    src: (h && h.src) || 'local',
    hist: fromHist,
    // ★★ 廿三轮（用户要求）：「有残局状态存进历史的话，打开这个历史，第一眼应该是这个
    //   **还没有额外落子前的残局**的黑白子布局」—— 记录上的**残局标记必须一起投到复盘窗**：
    //     · eg/egLen = 确定过的残局（前 egLen 手就是那个残局；其后的手是研究着法）；
    //     · vc       = 识图 VC 题面（整盘就是题面）。
    //   此前这里只搬 moves，eg/egLen/vc 全被丢掉 → 复盘窗第一眼是**空盘**、
    //   背诵/回顾还从**记录的第一颗子**开始（reviewLoad 里的 egLen 分支形同虚设）。
    eg: !!(h && h.eg), egLen: (h && h.egLen) || 0, vc: !!(h && h.vc),
    moves: ((h && h.moves) || []).map(function (a) { return [a[0], a[1], a[2] || 0]; })
      .filter(function (a) { return a[0] != null && a[1] != null; }),
  };
}

/** 打开（或复用）**复盘独立窗口** —— 宿主负责建窗口，这里只把要复盘的记录递过去。
 *  · `rec` + `hist=true`  = 从历史打开的那一局（复盘窗里露出「背诵 / 回顾」）；
 *  · 其余（含顶栏「复盘」）= 纯空棋盘自己摆，复盘窗里只有「重来 / 保存局面 / 关闭」。
 *  ★ **主窗口原样不动**：不碰 G.moves / G.board、不收仪表盘、不清热力 ——
 *    老版本这些「暂存 + 恢复」正是用户抱怨的那份耦合。
 *  ★ 不再往状态栏写「开复盘了」那句提示（用户要求删掉）：复盘窗自己会弹出来，
 *    主窗口喊这一句是多余的。 */
function openReviewWindow(rec, hist) {
  var payload = rec ? recordForReview(rec, hist)
                    : { ts: Date.now(), src: 'local', hist: !!hist, moves: [] };
  if (HOST) {
    tellHost({ type: 'openReview', record: payload });
    return true;
  }
  // 浏览器里没有宿主 → 用 localStorage 把记录递给新窗口（同源共享；写在 open 之前，无竞态）
  try { localStorage.setItem('gbcalc.review.pending', JSON.stringify(payload)); } catch (e) {}
  var w = window.open('calc.html?rv=1', 'gb_review');
  return !!w;
}

/** 顶栏「复盘」：把**当前棋盘**送去复盘窗口。
 *  ★ 注意 `hist=false`（用户要求）：这条入口进来的是**纯棋盘** ——
 *    复盘窗里只留「重来 / 保存局面 / 关闭」，不露背诵/回顾那一组；
 *    想看背诵/回顾就用历史里点一局（那条路 `hist=true`）。 */
function openReviewFromBoard() {
  openReviewWindow(G.moves.length ? {
    ts: Date.now(), src: 'local',
    moves: G.moves.map(function (m) { return [m.x, m.y, m.c]; }),
  } : null, false);
}

/** 把一局摆到**主窗口棋盘**上（外部识别到的局面：覆盖层「复盘」键 / 书签端识别存档）。
 *  ★ 这条跟「复盘窗口」是两件事：这里要的是**接着下**，所以必须落在主窗口的棋盘上。
 *    复盘窗口那边是「只看 / 只摆」，两者互不影响。 */
function openRecord(h) {
  var mv = (h.moves || []).map(function (a) {
    return { x: a[0], y: a[1], c: a[2] || 0 };
  }).filter(function (m) { return m.x != null && m.y != null; });
  G.loaded = { moves: mv, src: h.src || 'local' };
  G.board = newBoard();
  G.moves = [];
  mv.forEach(function (m) {
    var c = m.c || ((G.moves.length % 2 === 0) ? 1 : 2);
    m.c = c;
    G.board[m.y][m.x] = c; G.moves.push({ x: m.x, y: m.y, c: c });
  });
  G.curve = []; G.heat = []; G.nums = []; G.missRings = []; G.redo = []; G.review = null;
  recomputeOver();                            // 历史局面可能已经连五 → 直接封盘
  // ★★ 2026-09-23（用户要求）：VC 记录 = 残局 —— 主窗口打开即**整盘首帧**（黑白子一次全摆上，
  //    openRecord 本来就是整盘落好），模式切到「残局」：交换手规则随之灰掉、AI 不参与。
  if (h.vc && !RV_MODE && S.mode !== 'endgame') {
    // ★ 十八轮：VC 记录也是「进残局 = 重新摆」→ 清旧基准
    S.egLocked = false; S.egBase = null;
    S.mode = 'endgame';
    [].forEach.call(els.seg_mode.querySelectorAll('button'), function (x) {
      x.classList.toggle('on', x.getAttribute('data-mode') === 'endgame');
    });
    save();
  }
  // ★★ 十八轮（用户要求）：确定过的残局记录 → 主窗打开 = **摆盘模式 + 基准就位**：
  //     前 egLen 手就是那个残局（重新开始回到它），后续是研究着法。
  if (h.eg && !RV_MODE) {
    var baseN = Math.max(0, Math.min(h.egLen || mv.length, mv.length));
    S.egBase = mv.slice(0, baseN).map(function (m) { return [m.x, m.y, m.c]; });
    S.egLocked = S.egBase.length > 0;
    if (S.mode !== 'place') {
      S.mode = 'place';
      [].forEach.call(els.seg_mode.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-mode') === 'place');
      });
    }
    save();
  }
  hideReviewNav();
  setMissBox();
  closeDrawer();
  paint();
  refreshUI();
  refreshHeat(true);                          // 载入新局 → 立刻按 AI 视角刷一份热力
  refreshCoach();                             // 指导视图同刷（轮到用户且开关开着才有用）
}

// ---------------------------------------------------------------- 复盘窗口（独立窗口，?rv=1）
// 这个窗口里只有：一张棋盘 + 下面一行复盘功能键。没有顶栏、没有仪表盘、没有 AI，
// 也**从不**向引擎（:8964）发请求（RV_MODE 在 maybeAi / refreshHeat / scheduleEngineRetry 里早退）。
//   · 从历史打开一局 → 露出「背诵复盘 / 回顾复盘 / 背错 N / ◀ n/m ▶ / 退出」；
//   · 顶栏「复盘」进来 → 中间是空的：纯空棋盘，用户自己落子。
//   · ★ 2026-09-19（用户要求）：「打开复盘这个独立窗口，**再选择历史**，背诵复盘、回顾复盘
//     这几个按键又会重新出现」⇒ 复盘窗多了一个「历史」键，点开的是**同一套抽屉**（wireDrawer），
//     在里面挑一局 → 就地 reviewLoad（hist=true）→ rvGroup 露出来。
//     注意这与「不参与任何功能的连接」不冲突：抽屉只读 localStorage 的历史、只把记录摆进本窗口，
//     不碰 AI、不碰规则、不碰主窗口。
// 进场一律是**全新空棋盘**（用户要求，从老版本一直保留到现在）——
// 记录只作为背诵/回顾的数据源，绝不预先摆满。

// ---------------------------------------------------------------- 识图窗口（独立窗口，?vis=1）
// ★ 2026-09-21（用户要求）：宿主克隆复盘窗机制开 GbCalcVis（calc.html?vis=1）。
//   左 = 图片面板（初始居中两颗大键：上传图片 / 屏幕截图；选图后变 翻页 + 预览 +
//   识别/保存到历史/加载到练习），右 = 棋盘（#boardCol）显示识别结果。
//   与复盘窗同款「不参与功能连接」：不发引擎请求；识别走宿主的
//   GomokuVision.exe 子进程离线链路（--recognize-image / --scan-image）。
//   · 上传：多选 ≤150 张，左右箭头翻页（到头变灰）；
//   · 截屏：宿主 GDI 抓全屏（先最小化练习器/复盘/识图三个窗口，抓完恢复）；
//   · 识别：宿主把**原始图片字节**写临时文件喂给 GomokuVision.exe，stdout 的 JSON
//     原样回投页面（black/white 的 x,y 就是面板坐标，y=0 顶 —— 与覆盖层同口径）；
//   · 保存到历史：localStorage 与主窗同源共享，直接 addRecord（带名字，历史抽屉可见）；
//   · 加载到练习：宿主把 {black,white} 转投主窗口的 external 通道 → ingestExternal
//     （它本来就会「合成着手序列 + 入库 + 摆上主窗棋盘接着下」）。
var VIS_LIST_MAX = 150;
// ★ 2026-09-22（用户要求）：
//   · sel / anchor = 抽屉多选（Ctrl 点选 / Shift 范围选 / Ctrl+A / 右键菜单）；
//   · edit / pick   = 「修改」模式（pick: 'del' 删子 | 'swap' 逐对交换 | 'addb'/'addw' 加子流程）；
//   · delPts        = 删除棋子模式里待配对的棋子（画粉红圈标记）；
//   · swapSel       = 交换模式里已选中的第一颗子（画琥珀圈）；
//   · ghosts        = 加子流程的半透明预览子（0..2 颗；齐两颗画虚线框）；
//   · saveTmr       = IndexedDB 持久化的防抖计时器。
var VIS = { list: [], idx: 0, busy: false, result: null, seq: 0, queued: false, tmr: 0,
            sel: null, anchor: -1, edit: false, pick: null, delPts: [], swapSel: null,
            ghosts: [], saveTmr: 0, addOpen: false, undoStack: [], kb: -1,
            vc: false, gateBad: false };   // ★ 九轮：vc=VC 模式开关；gateBad=原始校验结果（放行提示用）

function visSelSet() { if (!VIS.sel) VIS.sel = new Set(); return VIS.sel; }

function visMsg(t) { if (els.visMsg) els.visMsg.textContent = t || ''; }

/** 把识别结果（{black:[{x,y}],white:[{x,y}]}）合成一条可回放的着手序列。
 *  静态盘面推不出真实次序 —— 与 ingestExternal 同口径交替合成（黑先、缺色补位），
 *  最终盘面与识别结果逐子一致；复盘窗回放顺序只是视觉上略有不同。 */
function visSynthMoves(bl, wh) {
  var bs = [], ws = [];
  (bl || []).forEach(function (p) { bs.push({ x: p.x, y: p.y, c: 1 }); });
  (wh || []).forEach(function (p) { ws.push({ x: p.x, y: p.y, c: 2 }); });
  var mv = [], bi = 0, wi = 0;
  for (var i = 0; i < bs.length + ws.length; i++) {
    var takeB = (i % 2 === 0);
    var p = takeB ? bs[bi++] : ws[wi++];
    if (!p) p = takeB ? ws[wi++] : bs[bi++];
    if (!p) break;
    mv.push([p.x, p.y, p.c]);
  }
  return mv;
}

/** 把「着手序列」摆上**本窗口**的棋盘（纯展示：不触发热力/AI/曲线，直接画）。 */
function visShowMoves(mv) {
  var b = newBoard();
  (mv || []).forEach(function (m) { b[m[1]][m[0]] = m[2]; });
  G.board = b;
  G.moves = (mv || []).map(function (a) { return { x: a[0], y: a[1], c: a[2] }; });
  G.over = false; G.loaded = null; G.review = null;
  G.heat = []; G.coach = []; G.curve = []; G.missRings = []; G.redo = [];
  VIS.ghosts = []; VIS.swapSel = null; VIS.delPts = [];   // 换图/重识别 → 修改模式的临时图形全清
  paint();
  visUpdateCode();                       // ★ 五轮：识别代码框跟着盘面走
}

/** ★ 五轮（用户要求）：识别的**棋盘代码框** —— 夹在功能键与提示文字之间，
 *  识别 / 修改落定后自动同步（movesToCode 与主窗「局面代码」同一格式，可直接复用）；
 *  盘面没子时整条隐藏。 */
function visUpdateCode() {
  if (!els.visCodeBar || !els.visCode) return;
  var has = !!(G.moves && G.moves.length);
  els.visCodeBar.hidden = !has;
  if (has) els.visCode.value = movesToCode(G.moves);
}

/** 识别结果摆上**本窗口**的棋盘（visShowMoves 的 {black,white} 版）。 */
function visShowResult(r) {
  visShowMoves(visSynthMoves((r && r.black) || [], (r && r.white) || []));
}

/** ★ 输入框视图（用户定稿 2026-09-21）：白框 = 输入框（闪烁光标 + 空态提示）与
 *  图片预览二合一；✕ 单个移除当前条目；高度 ≈ 半个棋盘（visLayout 设定）。
 *  条目两种：{t:'img', d:dataURL} | {t:'code', code, moves} */
function visRefreshView() {
  var has = VIS.list.length > 0;
  var it = VIS.list[VIS.idx];
  var isImg = !!it && it.t === 'img';
  els.visImg.hidden = !isImg;
  els.visInput.hidden = isImg;                 // 图片态藏输入框；代码态/空态显示
  els.btn_vis_del.hidden = !has;
  els.btn_vis_prev.disabled = !has || VIS.idx <= 0;
  els.btn_vis_next.disabled = !has || VIS.idx >= VIS.list.length - 1;
  if (isImg) {
    els.visImg.src = it.d;
    // ★ 低分辨率探测（用户要求「更多提示语」）：条目第一次露脸时量一次尺寸，
    //   存 it.w/it.h；识别完成后 visHandleResult 据此追加「分辨率较低」的提醒。
    if (!it.w) {
      var probe = new Image();
      probe.onload = function () { it.w = probe.naturalWidth; it.h = probe.naturalHeight; };
      probe.src = it.d;
    }
  } else {
    els.visImg.removeAttribute('src');
    els.visInput.value = it ? it.code : '';
    els.visInput.placeholder = has ? T('visBoxHintCode') : T('visBoxHint');
    if (has && document.activeElement !== els.visInput) els.visInput.focus();
  }
  els.visPos.textContent = has ? (VIS.idx + 1) + ' / ' + VIS.list.length : '0 / 0';
  els.visPos.title = T('visPillTip');
  if (els.vdCount) els.vdCount.textContent = String(VIS.list.length);
  if (els.t_vdTip) els.t_vdTip.textContent = T('visVdTip');
  visRenderDrawer();                         // ★ 抽屉开着就同步重画（缩略图选中态）
  visUpdateCode();                           // ★ 五轮：翻页/空态时代码框跟盘面走
  visAutoRecognize();                        // ★ 换图/上传/删除后自动识别（用户要求）
}

/** ★ 自动识别（用户要求 2026-09-21）：图片条目上传/翻页后自动跑识别，不用手点；
 *  代码条目直接重摆棋盘。防抖 200ms；引擎忙则排队（识别一般 <1s，冲突很少）。 */
function visAutoRecognize() {
  var it = VIS.list[VIS.idx];
  if (!it) return;
  if (it.t === 'code') { visShowMoves(it.moves); return; }
  if (VIS.tmr) clearTimeout(VIS.tmr);
  VIS.tmr = setTimeout(function () {
    VIS.tmr = 0;
    if (VIS.busy) { VIS.queued = true; return; }
    visRecognize();
  }, 200);
}

/** 输入框高度 = 半个棋盘（用户要求），夹在 150..420。layoutBoard 之后调。 */
function visLayout() {
  if (!els.visBox || !els.board) return;
  var h = Math.round((els.board.clientHeight || 480) * 0.56);   // ★ 九轮：0.5→0.56 识别框加高
  if (h < 170) h = 170;
  if (h > 460) h = 460;
  els.visBox.style.height = h + 'px';
}

/** ★ 容量管理（2026-09-22 用户要求改为「自动删最老」）：超过 150 张不再拒绝上传，
 *  而是自动删掉最老的图片腾位置；下标整体前移，多选状态清空。 */
function visMakeRoom() {
  var dropped = false;
  while (VIS.list.length >= VIS_LIST_MAX) {
    VIS.list.shift();
    if (VIS.idx > 0) VIS.idx--;
    VIS.anchor = -1;
    if (VIS.sel) VIS.sel.clear();
    dropped = true;
  }
  return dropped;
}

/** ★ 抽屉持久化（2026-09-22 用户要求「默认保存每一次上传的图片」）：
 *  IndexedDB（localStorage 塞不下 150 张 dataURL），单记录整表存，改动防抖 400ms。 */
var VIS_DB = null;
function visDb() {
  if (VIS_DB) return VIS_DB;
  VIS_DB = new Promise(function (res) {
    try {
      var rq = indexedDB.open('gbcalc-vis', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { res(null); };
    } catch (e) { res(null); }
  });
  return VIS_DB;
}
function visPersist() {
  if (VIS.saveTmr) clearTimeout(VIS.saveTmr);
  VIS.saveTmr = setTimeout(function () {
    VIS.saveTmr = 0;
    visDb().then(function (db) {
      if (!db) return;
      try { db.transaction('kv', 'readwrite').objectStore('kv').put(VIS.list.slice(), 'items'); }
      catch (e) {}
    });
  }, 400);
}
function visRestore(cb) {
  visDb().then(function (db) {
    if (!db) { cb(); return; }
    try {
      var rq = db.transaction('kv').objectStore('kv').get('items');
      rq.onsuccess = function () {
        var items = rq.result;
        if (Array.isArray(items)) {
          VIS.list = items.filter(function (it) {
            return it && (it.t === 'img' || it.t === 'code');
          }).slice(-VIS_LIST_MAX);
        }
        cb();
      };
      rq.onerror = function () { cb(); };
    } catch (e) { cb(); }
  });
}

function visAddImage(dataUrl, select) {
  if (!dataUrl || String(dataUrl).indexOf('data:image') !== 0) return false;
  visMakeRoom();
  VIS.list.push({ t: 'img', d: String(dataUrl) });
  if (select) VIS.idx = VIS.list.length - 1;
  visPersist();
  visRefreshView();
  return true;
}

/** ★ 代码条目：粘贴/输入局面代码 → 直接解析成局面（不用等引擎）。 */
function visAddCode(txt, select) {
  var code = String(txt || '').trim();
  var mv = parseCode(code);
  if (!mv.length) { visMsg(T('visCodeBad')); return false; }
  visMakeRoom();
  // 当前条目本来就是代码 → 原地更新；否则新增一条
  var cur = VIS.list[VIS.idx];
  if (cur && cur.t === 'code' && select === 'replace') {
    cur.code = code; cur.moves = mv;
  } else {
    VIS.list.push({ t: 'code', code: code, moves: mv });
    VIS.idx = VIS.list.length - 1;
  }
  visRefreshView();
  visShowMoves(mv);
  visMsg('');
  return true;
}

// ---- ★★ 十二轮（用户要求）：图片裁剪 ----------------------------------------
/** 「屏幕截图」右边那块空档的「裁剪」键 → 浮层里拖矩形框选 → 「确定」把**当前这张图就地裁成框内内容**。
 *  状态：open=浮层开着；img=原图 Image；sel={x,y,w,h}=**CSS 像素**选区；scale=CSS px/图片px；
 *  cssW/cssH=画布逻辑尺寸；dpr=设备像素比；drag=拖拽起点。 */
var CROP = { open: false, img: null, sel: null, drag: null, scale: 1, cssW: 1, cssH: 1, dpr: 1 };

/** 打开裁剪浮层：当前条目必须是图片 → 载入 → 按窗口可用面积算缩放 → 画进画布。
 *  ★ 2026-09-25（用户要求）：弹窗更大（90% 窗宽 / 84% 窗高）；画布位图按 **DPR** 建、
 *   ctx.setTransform(dpr) 后照常画 —— 高分屏上显示的是 1:1 物理像素，不再被拉伸发糊；
 *   逻辑坐标（选区/鼠标/裁剪换算）全部仍是 CSS 像素，行为与坐标语义不变。 */
function cropOpen() {
  var it = VIS.list[VIS.idx];
  if (!it || it.t !== 'img') { visMsg(T('visCropNone')); return; }
  var im = new Image();
  im.onload = function () {
    if (!im.naturalWidth || !im.naturalHeight) { visMsg(T('visCropFail')); return; }
    CROP.img = im; CROP.sel = null; CROP.drag = null;
    // 可用区域：原图分辨率高于屏幕（窗口）时**等比缩到合适大小**；小图绝不放大（原样显示）。
    var maxW = Math.max(240, window.innerWidth * 0.9);
    var maxH = Math.max(200, window.innerHeight * 0.84);
    CROP.scale = Math.min(maxW / im.naturalWidth, maxH / im.naturalHeight, 1);
    CROP.dpr = Math.max(1, window.devicePixelRatio || 1);
    CROP.cssW = Math.max(1, Math.round(im.naturalWidth * CROP.scale));
    CROP.cssH = Math.max(1, Math.round(im.naturalHeight * CROP.scale));
    var cv = els.cropCanvas;
    cv.width = Math.max(1, Math.round(CROP.cssW * CROP.dpr));    // 位图 = 物理（ sharper ）
    cv.height = Math.max(1, Math.round(CROP.cssH * CROP.dpr));
    cv.style.width = CROP.cssW + 'px';                           // 显示 = CSS 像素
    cv.style.height = CROP.cssH + 'px';
    CROP.open = true;
    els.visCrop.hidden = false;
    cropDraw(); cropSizeText();
  };
  im.onerror = function () { visMsg(T('visCropFail')); };
  im.src = it.d;
}

/** 重绘画布：原图 + 框外压暗 + 选区描边 / 三分参考线 / 四角把手。
 *  ★ 2026-09-25：位图含 DPR 倍率 → 先 setTransform(dpr)，此后所有坐标照常写 CSS 像素。 */
function cropDraw() {
  var cv = els.cropCanvas, ctx = cv.getContext('2d');
  var W = CROP.cssW, H = CROP.cssH;
  ctx.setTransform(CROP.dpr, 0, 0, CROP.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (CROP.img) ctx.drawImage(CROP.img, 0, 0, W, H);
  var s = CROP.sel;
  if (!s || s.w < 1 || s.h < 1) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.45)';          // 框外压暗（evenodd 挖空选区）
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(s.x, s.y, s.w, s.h);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(90,190,255,.98)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(s.x + .5, s.y + .5, s.w - 1, s.h - 1);
  ctx.strokeStyle = 'rgba(90,190,255,.42)';   // 三分参考线（构图用）
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (var k = 1; k <= 2; k++) {
    ctx.moveTo(s.x + s.w * k / 3, s.y); ctx.lineTo(s.x + s.w * k / 3, s.y + s.h);
    ctx.moveTo(s.x, s.y + s.h * k / 3); ctx.lineTo(s.x + s.w, s.y + s.h * k / 3);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(90,190,255,.98)';     // 四角把手
  var hs = 3.5;
  [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h]].forEach(function (p) {
    ctx.fillRect(p[0] - hs, p[1] - hs, hs * 2, hs * 2);
  });
  ctx.restore();
}

/** 标题行右侧实时显示选区对应的**原图像素**尺寸。 */
function cropSizeText() {
  if (!els.t_visCropSize) return;
  var s = CROP.sel;
  if (!s || s.w < 1 || s.h < 1 || !CROP.img) { els.t_visCropSize.textContent = ''; return; }
  els.t_visCropSize.textContent = Math.round(s.w / CROP.scale) + ' × ' + Math.round(s.h / CROP.scale);
}

function cropClose() {
  CROP.open = false; CROP.drag = null;
  if (els.visCrop) els.visCrop.hidden = true;
}
function cropReset() { CROP.sel = null; cropDraw(); cropSizeText(); }

/** 拖拽可能反向/出界 → 归一化并夹在画布**逻辑**尺寸内（CSS 像素，与鼠标坐标同系）。 */
function cropNorm(a, b) {
  var x1 = Math.max(0, Math.min(CROP.cssW, Math.min(a.x, b.x)));
  var y1 = Math.max(0, Math.min(CROP.cssH, Math.min(a.y, b.y)));
  var x2 = Math.max(0, Math.min(CROP.cssW, Math.max(a.x, b.x)));
  var y2 = Math.max(0, Math.min(CROP.cssH, Math.max(a.y, b.y)));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function cropPos(ev) {
  var r = els.cropCanvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

/** 确定 = 裁剪：按**原图像素**把框内区域重绘到离屏 canvas → 就地替换当前条目 → 刷新。
 *  ★ 不新增条目（用户要的是「把这张裁一下」），旧识别结果一并作废。 */
function cropApply() {
  var s = CROP.sel, im = CROP.img;
  if (!s || !im) { visMsg(T('visCropSmall')); return; }
  var sw = Math.round(s.w / CROP.scale), sh = Math.round(s.h / CROP.scale);
  if (sw < 8 || sh < 8) { visMsg(T('visCropSmall')); return; }
  var sx = Math.max(0, Math.round(s.x / CROP.scale)), sy = Math.max(0, Math.round(s.y / CROP.scale));
  sw = Math.max(1, Math.min(sw, im.naturalWidth - sx));
  sh = Math.max(1, Math.min(sh, im.naturalHeight - sy));
  var cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  cv.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
  var url = '';
  try { url = cv.toDataURL('image/png'); } catch (e) { url = ''; }
  if (!url || url.indexOf('data:image') !== 0) { visMsg(T('visCropFail')); return; }
  var it = VIS.list[VIS.idx];
  if (!it || it.t !== 'img') { visMsg(T('visCropNone')); return; }
  it.d = url;
  VIS.result = null;
  visPersist();
  visRefreshView();
  cropClose();
  visMsg(T('visCropDone').replace('{w}', String(sw)).replace('{h}', String(sh)));
}

/** 事件接线（识图窗 boot 里调一次）。 */
function wireCrop() {
  if (!els.cropCanvas) return;
  els.cropCanvas.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    CROP.drag = cropPos(ev);
    CROP.sel = { x: CROP.drag.x, y: CROP.drag.y, w: 0, h: 0 };
    cropDraw(); cropSizeText();
  });
  window.addEventListener('mousemove', function (ev) {
    if (!CROP.open || !CROP.drag) return;
    CROP.sel = cropNorm(CROP.drag, cropPos(ev));
    cropDraw(); cropSizeText();
  });
  window.addEventListener('mouseup', function () {
    if (!CROP.drag) return;
    CROP.drag = null;
    if (CROP.sel && (CROP.sel.w < 3 || CROP.sel.h < 3)) { CROP.sel = null; cropDraw(); cropSizeText(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (CROP.open && ev.key === 'Escape') { ev.preventDefault(); cropClose(); }
  });
  if (els.btn_crop_reset) els.btn_crop_reset.onclick = cropReset;
  if (els.btn_crop_cancel) els.btn_crop_cancel.onclick = cropClose;
  if (els.btn_crop_ok) els.btn_crop_ok.onclick = cropApply;
  if (els.visCrop) els.visCrop.addEventListener('mousedown', function (ev) {
    if (ev.target === els.visCrop) cropClose();          // 点遮罩空白 = 取消
  });
}

/** ★ 单个移除（用户要求 2026-09-21）：✕ 删当前条目，列表收拢。 */
function visRemoveCurrent() { visRemoveAt(VIS.idx); }

/** ★ 按索引移除（抽屉里每张缩略图的 ✕ 也走这里）：删掉、夹住 idx、重画视图。 */
function visRemoveAt(i) {
  if (i < 0 || i >= VIS.list.length) return;
  VIS.list.splice(i, 1);
  if (VIS.idx >= VIS.list.length) VIS.idx = Math.max(0, VIS.list.length - 1);
  VIS.anchor = -1;
  if (VIS.sel) VIS.sel.clear();
  VIS.result = null;
  visMsg('');
  visPersist();
  if (!VIS.list.length) {
    visRefreshView();
    G.board = newBoard(); G.moves = []; paint();
    if (els.visInput) els.visInput.focus();
    return;
  }
  visRefreshView();
  var it = VIS.list[VIS.idx];
  if (it.t === 'code') visShowMoves(it.moves);
}

/** ★ 多选删除（2026-09-22 用户要求）：删掉抽屉里勾选的全部图片。 */
function visRemoveSelected() {
  var sel = VIS.sel && VIS.sel.size ? Array.from(VIS.sel) : [];
  if (!sel.length) { visMsg(T('visNoSel')); return; }
  var n = sel.length;
  sel.sort(function (a, b) { return b - a; }).forEach(function (i) {
    if (i >= 0 && i < VIS.list.length) VIS.list.splice(i, 1);
  });
  VIS.sel = null; VIS.anchor = -1;
  if (VIS.idx >= VIS.list.length) VIS.idx = Math.max(0, VIS.list.length - 1);
  VIS.result = null;
  visMsg(T('visDelDone').replace('{n}', String(n)));
  visPersist();
  if (!VIS.list.length) {
    visRefreshView();
    G.board = newBoard(); G.moves = []; paint();
    return;
  }
  visRefreshView();
  var it = VIS.list[VIS.idx];
  if (it && it.t === 'code') visShowMoves(it.moves);
}

/** dataURL 的图片扩展名（系统按扩展名挑默认看图软件）。 */
function visImageExt(d) {
  var m = /^data:image\/([a-z0-9.+-]+)/i.exec(String(d || ''));
  var e = m ? m[1].toLowerCase() : 'png';
  if (e === 'jpeg' || e === 'jpg') e = 'jpg';
  else if (e === 'svg+xml') e = 'svg';
  else if (e.indexOf('+') >= 0) e = 'png';        // 其它 +xml 之类的兜底成 png（内容本来就是位图）
  return e;
}

/** ★★ 廿四轮（用户要求）：**双击图片 = 用系统默认看图软件打开这一张** ——
 *  识图窗里的大图（当前那张）与图片抽屉里的缩略图**都走这里**。
 *  为什么必须借宿主：页面手里只有 dataURL（图片是上传 / 屏幕截图 / 识别得到的字节），
 *  WebView2 里既没有文件系统也没有「打开方式」入口 —— 所以把字节 + 扩展名 + 序号递上去，
 *  宿主落一个 %TEMP%\gbvis-open-<n>.<ext> 再 ShellExecuteW("open")，系统按扩展名挑默认程序。
 *  浏览器里（没有宿主）退化成「下载这张图」：结果同样是把图交到系统手里。
 *  返回 true = 已经交出去（宿主或浏览器都算成功）。 */
function visOpenImage(i) {
  var it = VIS.list[i];
  if (!it || it.t !== 'img' || !it.d) return false;
  var ext = visImageExt(it.d);
  if (HOST) {
    tellHost({ type: 'openImage', idx: i + 1, ext: ext, data: it.d });
    return true;
  }
  try {
    var a = document.createElement('a');
    a.href = it.d;
    a.download = 'gomoku-vision-' + (i + 1) + '.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) { return false; }
  return true;
}

/** ★ 复制图片（2026-09-22 用户要求）：把勾选的（没有则当前的）图片以 PNG 写进剪贴板。 */
function visCopyImage(idx) {
  var it = (typeof idx === 'number' && VIS.list[idx]) ? VIS.list[idx] : null;
  if (!it && VIS.sel && VIS.sel.size) {
    var first = Array.from(VIS.sel).sort(function (a, b) { return a - b; })[0];
    it = VIS.list[first] || null;
  }
  if (!it) it = VIS.list[VIS.idx];
  if (!it || it.t !== 'img') { visMsg(T('visCopyFail')); return; }
  var im = new Image();
  im.onload = function () {
    try {
      var cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      cv.getContext('2d').drawImage(im, 0, 0);
      cv.toBlob(function (blob) {
        if (!blob) { visMsg(T('visCopyFail')); return; }
        try {
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            .then(function () { visMsg(T('visCopied')); })
            .catch(function () { visMsg(T('visCopyFail')); });
        } catch (e) { visMsg(T('visCopyFail')); }
      }, 'image/png');
    } catch (e) { visMsg(T('visCopyFail')); }
  };
  im.src = it.d;
}

/** ★ 图片抽屉（用户要求 2026-09-21）：点「n / m」胶囊弹出 —— 重画全部缩略图
 *  （图片条 → 缩略图；代码条 → 代码文本），当前选中的描天蓝边。
 *  ★ 2026-09-22（用户要求）多选管理：勾选态（chk 勾角标）；点缩略图 = 选中该张，
 *  Ctrl+点 = 勾选/取消，Shift+点 = 范围勾选，「选择」键开着时普通点也 = 勾选；
 *  右键缩略图 = 功能菜单（选择 / 全选 / 复制图片 / 删除）。 */
function visRenderDrawer() {
  if (!els.vdList || !els.visDrawer || els.visDrawer.hidden) return;
  els.vdList.textContent = '';
  var sel = VIS.sel || new Set();
  var selMode = !!(els.btn_vd_sel && els.btn_vd_sel.classList.contains('accent'));
  VIS.list.forEach(function (it, i) {
    var d = document.createElement('button');
    d.type = 'button';
    d.setAttribute('data-idx', String(i));
    d.className = 'vd-item' + (i === VIS.idx ? ' sel' : '') + (sel.has(i) ? ' chk' : '');
    if (it.t === 'img') {
      var im = document.createElement('img');
      im.src = it.d; im.alt = '';
      d.appendChild(im);
    } else {
      var c = document.createElement('span');
      c.className = 'vd-code';
      c.textContent = it.code;
      d.appendChild(c);
    }
    var n = document.createElement('span');
    n.className = 'idx';
    n.textContent = String(i + 1);
    d.appendChild(n);
    var chk = document.createElement('span');
    chk.className = 'vd-chk';
    chk.textContent = '✓';
    d.appendChild(chk);
    var del = document.createElement('span');
    del.className = 'vd-del';
    del.textContent = '✕';
    del.title = T('visDelTitle');
    del.onclick = function (ev) { ev.stopPropagation(); visRemoveAt(i); };
    d.appendChild(del);
    d.onclick = function (ev) { visItemClick(ev, i); };
    // ★ 廿四轮（用户要求）：抽屉里的缩略图**双击 = 用系统默认看图软件打开这张**
    //   （单击照旧是选中/勾选；双击前的那两次单击先把它选中，正好顺眼）
    d.ondblclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); visOpenImage(i); };
    if (it.t === 'img') d.title = T('visOpenTip');
    d.oncontextmenu = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();                    // 别让 document 的收起逻辑把菜单又关掉
      visShowMenu(ev, [
        [T('visSel') + (sel.has(i) ? ' ✓' : ''), false, function () {
          var s = visSelSet();
          if (s.has(i)) s.delete(i); else { s.add(i); VIS.anchor = i; }
          visRenderDrawer();
        }],
        [T('visSelAll'), false, function () {
          var s = visSelSet();
          VIS.list.forEach(function (_, k) { s.add(k); });
          visRenderDrawer();
        }],
        // ★ 廿四轮（用户要求）：右键也能「用系统看图软件打开」这张（双击的等价入口）
        [T('visOpenApp'), false, function () { visOpenImage(i); }],
        [T('visCopy'), false, function () { visCopyImage(i); }],
        [T('visDelSel'), true, function () {
          var s = visSelSet();
          s.clear(); s.add(i);
          visRemoveSelected();
        }],
      ]);
    };
    d._selMode = selMode;
    els.vdList.appendChild(d);
  });
  if (els.vdCount) els.vdCount.textContent = String(VIS.list.length);
}

/** 缩略图点击：普通 = 选中该张；Ctrl/元键或「选择」开着 = 勾选切换；
 *  Shift+点 = 从锚点起范围勾选（2026-09-22 用户要求）。 */
function visItemClick(ev, i) {
  var sel = visSelSet();
  var selMode = !!(els.btn_vd_sel && els.btn_vd_sel.classList.contains('accent'));
  if (ev.shiftKey && VIS.anchor >= 0) {
    var lo = Math.min(VIS.anchor, i), hi = Math.max(VIS.anchor, i);
    for (var k = lo; k <= hi; k++) sel.add(k);
  } else if (ev.ctrlKey || ev.metaKey || selMode) {
    if (sel.has(i)) sel.delete(i);
    else { sel.add(i); VIS.anchor = i; }
  } else {
    if (sel.size) sel.clear();                 // 普通点击清掉多选
    VIS.anchor = i;
    if (VIS.idx !== i) VIS.idx = i;
  }
  visRefreshView();
}

/** 通用右键菜单（与主窗历史抽屉的 #ctxMenu 同一颗浮层，内容现拼）。 */
function visShowMenu(ev, items) {
  var m = els.ctxMenu;
  if (!m) return;
  m.innerHTML = '';
  items.forEach(function (it) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = it[0];
    if (it[1]) b.className = 'danger';
    b.onclick = function (e) { e.stopPropagation(); closeCtx(); it[2](); };
    m.appendChild(b);
  });
  m.hidden = false;
  var w = m.offsetWidth, h = m.offsetHeight;               // 先显后量才拿得到尺寸
  m.style.left = Math.max(6, Math.min(ev.clientX, window.innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(ev.clientY, window.innerHeight - h - 6)) + 'px';
}

/** 「上传图片」：多选文件 → dataURL（FileReader 读原始字节，宿主再写盘喂给识别引擎）。
 *  ★ 2026-09-22：超过 150 张不再拒绝 —— 自动删掉最老的腾位置（visMakeRoom）。 */
function visAddFiles(files) {
  var arr = [].slice.call(files || []);
  if (!arr.length) return;
  visMakeRoom();
  var pending = Math.min(arr.length, VIS_LIST_MAX), done = 0, firstAt = VIS.list.length;
  arr.slice(0, pending).forEach(function (f) {
    var rd = new FileReader();
    rd.onload = function () {
      visMakeRoom();                          // 并行读入也可能超限，逐张兜
      VIS.list.push({ t: 'img', d: String(rd.result || '') });
      if (++done === pending) {
        VIS.idx = firstAt;                       // 停在新选的第一张上
        if (VIS.idx >= VIS.list.length) VIS.idx = VIS.list.length - 1;
        visPersist();
        visRefreshView();
        visMsg('');
      }
    };
    rd.readAsDataURL(f);
  });
}

/** 「识别 / 重新识别」：图片条目 → 宿主 GomokuVision.exe 离线识别（带 seq，
 *  翻页后旧结果回来直接丢弃）；代码条目 → 直接解析（不过引擎）。 */
function visRecognize() {
  var it = VIS.list[VIS.idx];
  if (!it) { visMsg(T('visNone')); return; }
  if (it.t === 'code') {
    visShowMoves(it.moves);
    var b = 0, w = 0;
    it.moves.forEach(function (m) { if (m[2] === 1) b++; else w++; });
    visMsg(T('visOk').replace('{b}', String(b)).replace('{w}', String(w)));
    return;
  }
  if (VIS.busy) return;
  VIS.busy = true;
  VIS.seq++;
  VIS.reqSeq = VIS.seq;
  if (els.btn_vis_rec) els.btn_vis_rec.disabled = true;
  visMsg(T('visWorking'));
  // ★ 五轮（用户要求）：「自动吸附」键删除 —— 吸附恒开（引擎只在核心结果不可信时
  //   才吸附重试，且裁剪外扩棋盘 1/30 保细节），不再有 nosnap 开关链路。
  tellHost({ type: 'visRecognize', mode: 'image', data: it.d, seq: VIS.reqSeq });
}

function visRecognizeDone() {
  var was = VIS.busy;
  VIS.busy = false;
  if (els.btn_vis_rec) els.btn_vis_rec.disabled = false;
  if (was && VIS.queued) { VIS.queued = false; visAutoRecognize(); }
}

/** 宿主回投的识别结果：过期（翻页后旧请求）直接丢弃；摆盘 + 状态行。
 *  ★ 2026-09-21（用户要求）：提示语更细 —— 棋盘没认出 / 认出棋盘但没读出棋子 /
 *  图片可能模糊 / 分辨率较低，各说各的话，不再笼统一句「没识别到」。 */
function visHandleResult(m) {
  visRecognizeDone();
  if (typeof m.seq === 'number' && m.seq !== VIS.seq) return;   // 过期结果（已换图）
  var r = m.result || {};
  if (!r.ok) { visMsg(T('visBad') + (r.err ? ' (' + r.err + ')' : '')); return; }
  var bl = r.black || [], wh = r.white || [];
  if (!bl.length && !wh.length) { visMsg(T('visNoStones')); return; }
  VIS.result = { black: bl, white: wh };
  visShowResult(r);
  var msg = (r.suspect ? T('visSuspect') : '') + (r.partial ? T('visPartial') : '') +
            T('visOk').replace('{b}', String(bl.length)).replace('{w}', String(wh.length));
  var it = VIS.list[VIS.idx];
  if (it && it.t === 'img' && it.w && Math.min(it.w, it.h) < 320) {
    msg += ' ' + T('visLowRes').replace('{w}', String(it.w)).replace('{h}', String(it.h));
  }
  visMsg(msg);
  visFillGuide();                          // ★ 四轮：新结果进来先摆好补充键的可用态
  // ★ 八轮（用户要求）：黑白子数异常 → 保存/加载整键禁用 + 明确提示
  if (visGate()) visMsg(T('visCountBad')
    .replace('{b}', String(bl.length)).replace('{w}', String(wh.length)));
  else if (VIS.vc && VIS.gateBad) visMsg(T('visVcPass')
    .replace('{b}', String(bl.length)).replace('{w}', String(wh.length)));   // ★ 九轮
}

/** 「保存到历史」：与主窗共用同一 localStorage（同源），直接入库。
 *  名字默认「识图局面」，可在主窗抽屉里右键重命名。 */
function visSaveHist() {
  if (!VIS.result || !G.moves.length) { visMsg(T('visNone')); return; }
  if (visGate()) { visMsg(T('visCountBad')
    .replace('{b}', String(visCounts().b)).replace('{w}', String(visCounts().w))); return; }  // ★ 八轮
  addRecord({
    ts: Date.now(), src: 'vis', rule: 0, first: 'b',
    name: T('visName') + ' ' +
          new Date().toLocaleString(S.lang === 'en' ? 'en-US' : 'zh-CN'),   // ★ 日期样式跟界面语言
    moves: G.moves.map(function (m) { return [m.x, m.y, m.c]; }),
    vc: !!VIS.vc,                                   // ★ 十四轮：VC 记录带标记（历史打开按残局首帧）
  });
  visMsg(T('visSaved'));
}

/** 「加载到练习」：宿主把 {black,white} 转投主窗口 external 通道 →
 *  ingestExternal 合成着手、入库并摆上**主窗口**的棋盘接着下。 */
function visLoadPractice() {
  if (!VIS.result) { visMsg(T('visNone')); return; }
  if (visGate()) { visMsg(T('visCountBad')
    .replace('{b}', String(visCounts().b)).replace('{w}', String(visCounts().w))); return; }  // ★ 八轮
  if (HOST) {
    tellHost({ type: 'visToTrainer', payload: { src: 'vis', black: VIS.result.black, white: VIS.result.white, vc: !!VIS.vc } });   // ★ 九轮：vc 随行
    visMsg(T('visLoaded'));
  } else {
    try { localStorage.setItem('gbcalc.vis.pending', JSON.stringify({ black: VIS.result.black, white: VIS.result.white, vc: !!VIS.vc })); } catch (e) {}   // ★ 九轮
    window.open('calc.html');
  }
}

// ---------------------------------------------------------------- 识图「修改」（2026-09-22）
// ★ 用户要求：机器识别偶尔不准 —— 「加载到练习」右边一颗「修改」键，点开后棋盘下方
//   出功能条：交换黑白子 / 删除棋子（点两颗成对删）/ 添加黑白子（展开 加黑子 / 加白子，
//   黑可以比白多一：黑已多一就不再让加黑，白齐平就不能再加白）；右键点棋盘 = 同款菜单。

function visCounts() {
  var b = 0, w = 0;
  for (var y = 0; y < N; y++)
    for (var x = 0; x < N; x++) {
      if (G.board[y][x] === 1) b++;
      else if (G.board[y][x] === 2) w++;
    }
  return { b: b, w: w };
}

/** 棋盘是唯一事实：改完把着手序列与 VIS.result 都按盘面重建（保存/加载用的就是它）。 */
function visSyncResult() {
  var mv = [], bl = [], wh = [];
  for (var y = 0; y < N; y++)
    for (var x = 0; x < N; x++) {
      var v = G.board[y][x];
      if (!v) continue;
      mv.push({ x: x, y: y, c: v });
      if (v === 1) bl.push({ x: x, y: y }); else wh.push({ x: x, y: y });
    }
  G.moves = mv;
  VIS.result = { black: bl, white: wh };
  visFillGuide();                          // ★ 四轮：编辑落定后补充键跟着黑白缺口走
  visUpdateCode();                         // ★ 五轮：修改落定后代码框同步
  visGate();                               // ★ 八轮：黑白数异常 → 禁保存/加载
}

/** ★ 三轮（用户要求）：修改模式的**所有提示文字统一走左侧文字栏**（#visMsg，
 *  CSS 里识图窗稍大一号），功能条本身只留按键、整行居中在棋盘正下方。 */
function visEditHint(t) { visMsg(t); }

/** ★ 四轮（用户要求）补充键「缺谁亮谁」：
 *  · 黑子比白子多 → 只能补白（「补充黑子」变灰禁用）；
 *  · 白子比黑子多 / 两色齐平 → 只能补黑（「补充白子」变灰禁用）；
 *  可用的那个键点亮成引导色，缺口时左侧文字栏直接提示该点哪个。
 *  修改开关 / 每次编辑落定 / 新识别结果 后都会调一遍。 */
function visFillGuide() {
  if (!els.btn_ve_fillb || !els.btn_ve_fillw) return;
  var c = visCounts();
  // ★ 2026-09-23（用户要求）：VC 模式 = 补充黑子/白子**不限数量**，两个键都常亮可用
  var canB = VIS.vc ? true : (c.b <= c.w);   // 补黑：黑不比白多就允许（补到齐平/多一）
  var canW = VIS.vc ? true : (c.w < c.b);    // 补白：白比黑少才允许（补到齐平）
  els.btn_ve_fillb.disabled = !canB;
  els.btn_ve_fillw.disabled = !canW;
  els.btn_ve_fillb.classList.toggle('accent', canB);   // 引导 = 只亮能用的那个
  els.btn_ve_fillw.classList.toggle('accent', canW);
  if (VIS.edit && !VIS.vc && !VIS.pick) {
    if (c.w < c.b) visEditHint(T('veFillGuideW').replace('{d}', String(c.b - c.w)));
    else if (c.b < c.w) visEditHint(T('veFillGuideB').replace('{d}', String(c.w - c.b)));
  }
}

function visEditExitPick() {
  VIS.pick = null; VIS.delPts = []; VIS.swapSel = null; VIS.ghosts = []; G.missRings = [];
  // ★ 2026-09-23（用户要求）：退出选色 → 黑子开始/白子开始 的高亮一并熄灭
  if (els.btn_ve_addb) els.btn_ve_addb.classList.remove('sel-b');
  if (els.btn_ve_addw) els.btn_ve_addw.classList.remove('sel-w');
  paint();
}

function visEditToggle() {
  VIS.edit = !VIS.edit;
  if (!VIS.edit) VIS.undoStack = [];   // ★ 七轮：退出修改清空撤销栈
  if (!VIS.edit) { VIS.addOpen = false; if (els.btn_ve_add) els.btn_ve_add.classList.remove('add-on'); }
  if (els.visEditBar) els.visEditBar.hidden = !VIS.edit;
  if (els.btn_vis_edit) els.btn_vis_edit.classList.toggle('accent', VIS.edit);
  if (els.veAddKeys) els.veAddKeys.hidden = true;
  if (VIS.edit) {
    var c = visCounts();
    // ★ 2026-09-23（用户要求）：VC 模式下进修改 → 左侧文字栏详细说明放开的编辑规则
    visEditHint(VIS.vc ? T('visVcEditTip')
      : T('veEditOn') + ' · ' + T('visOk').replace('{b}', String(c.b)).replace('{w}', String(c.w)));
  } else {
    visEditHint('');
    visEditExitPick();
  }
  paint();
}

/** ★ 2026-09-22 二轮（用户要求）：交换不再「全部黑白对调」，而是**逐对交换** ——
 *  点本键进入交换模式：点一颗黑子 → 再点一颗白子 → 这两子互换颜色；
 *  模式一直保持，可以连续换很多对，直到再点本键 / 按 Esc 退出。 */
function visEditSwap() {
  if (VIS.pick === 'swap') { visEditExitPick(); visEditHint(T('veEditOn')); return; }
  VIS.pick = 'swap'; VIS.swapSel = null; VIS.delPts = []; VIS.ghosts = []; G.missRings = [];
  visEditHint(T('veSwapHint'));
  paint();
}

function visEditPick(kind) {
  // ★ 四轮：补充键按数量规则闸门 —— 缺谁才能补谁（右键菜单同受闸），并给引导提示
  //   ★ 2026-09-23（用户要求）：VC 模式下闸门全部放开（补黑/补白不限数量）
  var c0 = visCounts();
  if (!VIS.vc) {
    if (kind === 'fillb' && c0.b > c0.w) { visEditHint(T('veFillBFull')); visFillGuide(); return; }
    if (kind === 'fillw' && c0.w >= c0.b) { visEditHint(T('veFillWFull')); visFillGuide(); return; }
  }
  VIS.pick = kind; VIS.delPts = []; VIS.swapSel = null; VIS.ghosts = []; G.missRings = [];
  // ★ 2026-09-23（用户要求）：「黑子开始」点中 → 按钮变**浅紫色**；「白子开始」→ **浅白蓝色**；
  //   两者互斥，退出选色/换选另一色时由 visEditExitPick / 这里的 toggle 自然纠正
  if (els.btn_ve_addb) els.btn_ve_addb.classList.toggle('sel-b', kind === 'addb');
  if (els.btn_ve_addw) els.btn_ve_addw.classList.toggle('sel-w', kind === 'addw');
  visEditHint(kind === 'del' ? T(VIS.vc ? 'veDelVcHint' : 'veDelHint')
    : kind === 'fillb' ? T(VIS.vc ? 'veFillVcHint' : 'veFillBHint')
    : kind === 'fillw' ? T(VIS.vc ? 'veFillVcHint' : 'veFillWHint')
    : kind === 'addb' ? T('veAddBHint') : T('veAddWHint'));
  paint();
}

/** ★ 七轮（用户要求）：「添加黑白子」下拉开关 —— 点本键：按钮浅蓝高亮 + 弹出小矩形框
 *  （黑子开始/白子开始）；再点一次收起并熄灭。右键菜单走同款展开态。 */
function visAddToggle() {
  VIS.addOpen = !VIS.addOpen;
  if (els.btn_ve_add) els.btn_ve_add.classList.toggle('add-on', VIS.addOpen);
  if (els.veAddKeys) els.veAddKeys.hidden = !VIS.addOpen;
  if (VIS.addOpen) visEditPick('addb');
  else if (VIS.pick === 'addb' || VIS.pick === 'addw') visEditExitPick();
}

/** ★ 七轮（用户要求）：撤销快照 —— 修改模式下每一步「落定」前压栈（封顶 100 步）。 */
function visSnapPush() {
  if (!VIS.edit) return;
  VIS.undoStack.push(G.board.map(function (row) { return row.slice(); }));
  if (VIS.undoStack.length > 100) VIS.undoStack.shift();
}

/** ★ 七轮（用户要求）：撤销（键 / Ctrl+Z / 右键菜单）—— 弹出最近一份盘面快照。 */
function visUndo() {
  if (!VIS.edit || !VIS.undoStack.length) {
    if (VIS.edit) visEditHint(T('veUndoNone'));
    return;
  }
  G.board = VIS.undoStack.pop();
  VIS.ghosts = []; VIS.delPts = []; VIS.swapSel = null; G.missRings = [];
  visSyncResult();
  var c = visCounts();
  visEditHint(T('veEdited').replace('{b}', String(c.b)).replace('{w}', String(c.w)));
  paint();
}

/** ★ 八轮（用户要求）：黑白数异常闸门 —— 白>黑 或 黑>白+1 = 识别异常：
 *  禁用「保存到历史 / 加载到练习」并提示，编辑修正后才恢复。 */
function visGate() {
  var c = visCounts();
  var bad = (c.w > c.b) || (c.b - c.w > 1);
  VIS.gateBad = bad;                     // ★ 九轮：原始校验结果（VC 放行提示用）
  if (VIS.vc) bad = false;               // ★ 九轮：VC 模式放行 —— 算杀题面黑白常不统一
  if (els.btn_vis_save) els.btn_vis_save.disabled = bad;
  if (els.btn_vis_load) els.btn_vis_load.disabled = bad;
  return bad;
}
/** ★ 九轮（用户要求）：识图窗「VC 模式」开关 —— 开：黑白子数不统一也可保存/加载，
 *  加载到练习后自动以子多一方为进攻方跑 VCF/VCT 模拟（与前瞻同一条展示链路）；
 *  关：恢复八轮校验。键点亮 = 开（accent 同「修改」键）。 */
function visVcToggle() {
  VIS.vc = !VIS.vc;
  if (els.btn_vis_vc) els.btn_vis_vc.classList.toggle('accent', VIS.vc);
  visGate();
  visFillGuide();                        // ★ 十四轮：VC 开 → 补充键立即全部放开（关 → 恢复闸门）
  // ★ 2026-09-23（用户要求）：开 VC → 左侧文字栏**详细说明**编辑放开的规则
  visMsg(T(VIS.vc ? 'visVcEditTip' : 'visVcOff'));
}

/** 加子流程落定：把虚线框里的两颗预览子写进棋盘（一黑一白 → 黑白数差不变，恒合法）。 */
function visGhostsCommit() {
  var gs = VIS.ghosts || [];
  VIS.ghosts = [];
  if (gs.length < 2) { paint(); return; }      // 不满一对 = 取消本次预览
  visSnapPush();                               // ★ 七轮：撤销快照
  gs.forEach(function (p) { G.board[p.y][p.x] = p.c; });
  visSyncResult();
  var c = visCounts();
  visEditHint(T('veEdited').replace('{b}', String(c.b)).replace('{w}', String(c.w)));
  paint();
}

/** 修改模式下的棋盘点击（识图窗棋盘本来只读，这里接管修改模式的三类操作）。
 *  ★ 二轮（用户要求）：
 *    · 删除：黑=白+1 可单删黑子；白=黑 可单删白子；其余情况点对面颜色成对删；
 *    · 加子：「黑子开始 / 白子开始」→ 点空点放半透明子 → 再点空点放对面色 →
 *      两颗用虚线框住 → 点第三处（落定并开新一轮）或点棋盘外空白（只落定）；
 *    · 交换：见 visEditSwap。 */
function visBoardClick(ev) {
  if (!VIS.edit || !VIS.pick) return;
  var rect = els.board.getBoundingClientRect();
  var g = geom();
  var hit = cellAt(ev.clientX - rect.left, ev.clientY - rect.top);   // 视图逆映射
  var x = hit ? hit.x : -1, y = hit ? hit.y : -1;
  var inside = x >= 0 && y >= 0 && x < N && y < N;

  // ---- 加子流程（黑子开始 / 白子开始） ----
  if (VIS.pick === 'addb' || VIS.pick === 'addw') {
    var startC = (VIS.pick === 'addb') ? 1 : 2;
    if (!inside) { visGhostsCommit(); return; }              // 点棋盘外空白 = 落定
    if (G.board[y][x]) return;                               // 已有实子 → 不响应
    var gs = VIS.ghosts;
    if (gs.length >= 2) {                                    // 第三个点 = 落定 + 开新一轮
      visGhostsCommit();
      if (!G.board[y][x]) { VIS.ghosts = [{ x: x, y: y, c: startC }]; visEditHint(T('veGhost2')); }
      paint();
      return;
    }
    if (gs.length === 1 && gs[0].x === x && gs[0].y === y) { VIS.ghosts = []; paint(); return; } // 再点同格取消
    gs.push({ x: x, y: y, c: gs.length ? (3 - startC) : startC });
    visEditHint(gs.length === 1
      ? T('veGhost1').replace('{c}', startC === 1 ? T('veGhostB') : T('veGhostW'))
      : T('veGhost2'));
    paint();
    return;
  }

  if (!inside) return;

  // ---- 补充黑子 / 补充白子（三轮，用户要求：某色缺子时一点补一颗）
  //  ★ 四轮修复：这里原来把判断写反了（空点直接 return）→ 点空点永远没反应、
  //    点已有棋子反而覆盖 —— 「补充键完全用不了」的根因。
  if (VIS.pick === 'fillb' || VIS.pick === 'fillw') {
    if (G.board[y][x]) return;                               // 只落空点
    var fc = (VIS.pick === 'fillb') ? 1 : 2;
    var fc0 = visCounts();
    // 数量规则：黑 = 白 或 黑 = 白 + 1。补黑允许到「黑齐平/多一」；补白允许到「白齐平」
    // ★ 2026-09-23（用户要求）：VC 模式下不限数量 —— 闸门跳过
    if (!VIS.vc) {
      if (fc === 1 && fc0.b > fc0.w) { visEditHint(T('veFillBFull')); visFillGuide(); return; }
      if (fc === 2 && fc0.w >= fc0.b) { visEditHint(T('veFillWFull')); visFillGuide(); return; }
    }
    visSnapPush();                             // ★ 七轮：撤销快照
    G.board[y][x] = fc;
    visSyncResult();
    var fc1 = visCounts();
    visEditHint(T('veEdited').replace('{b}', String(fc1.b)).replace('{w}', String(fc1.w)));
    paint();
    return;
  }

  // ---- 删除棋子（单删 / 成对删自适应） ----
  if (VIS.pick === 'del') {
    if (!G.board[y][x]) return;
    var col = G.board[y][x];
    // ★ 2026-09-23（用户要求）：VC 模式 = **任意删除** —— 点哪颗删哪颗，不限颜色不限数量
    if (VIS.vc) {
      visSnapPush();                             // 撤销快照
      G.board[y][x] = 0;
      visSyncResult(); VIS.delPts = []; G.missRings = [];
      var cvc = visCounts();
      visEditHint(T('veDelDone').replace('{x}', '1').replace('{b}', String(cvc.b)).replace('{w}', String(cvc.w)));
      paint();
      return;
    }
    var cnt0 = visCounts();
    // 单删后仍满足「黑=白 或 黑=白+1」才允许：黑=白+1 时可单删黑；白=黑 时可单删白
    var singleOk = (col === 1) ? (cnt0.b === cnt0.w + 1) : (cnt0.b === cnt0.w);
    var dup = -1;
    for (var i = 0; i < VIS.delPts.length; i++)
      if (VIS.delPts[i].x === x && VIS.delPts[i].y === y) dup = i;
    if (dup >= 0) { VIS.delPts.splice(dup, 1); G.missRings = VIS.delPts.slice(); paint(); return; }
    if (VIS.delPts.length && G.board[VIS.delPts[0].y][VIS.delPts[0].x] !== col) {
      // 待定子 + 这颗异色 → 成对删除
      visSnapPush();                           // ★ 七轮：撤销快照
      G.board[VIS.delPts[0].y][VIS.delPts[0].x] = 0;
      G.board[y][x] = 0;
      visSyncResult(); VIS.delPts = []; G.missRings = [];
      var c = visCounts();
      visEditHint(T('veDelDone').replace('{x}', '2').replace('{b}', String(c.b)).replace('{w}', String(c.w)));
      paint();
      return;
    }
    if (singleOk) {
      visSnapPush();                             // ★ 七轮：撤销快照
      G.board[y][x] = 0;
      visSyncResult(); VIS.delPts = []; G.missRings = [];
      var c1 = visCounts();
      visEditHint(T('veDelDone').replace('{x}', '1').replace('{b}', String(c1.b)).replace('{w}', String(c1.w)));
      paint();
      return;
    }
    VIS.delPts = [{ x: x, y: y }];             // 不能单删 → 待定，等对面颜色
    G.missRings = VIS.delPts.slice();
    visEditHint(T('veDelPair'));
    paint();
    return;
  }

  // ---- 逐对交换 ----
  if (VIS.pick === 'swap') {
    if (!G.board[y][x]) return;
    var col2 = G.board[y][x];
    if (!VIS.swapSel) {
      VIS.swapSel = { x: x, y: y };
      visEditHint(T('veSwapNext'));
      paint();
      return;
    }
    if (VIS.swapSel.x === x && VIS.swapSel.y === y) { VIS.swapSel = null; paint(); return; } // 取消选中
    var s = VIS.swapSel, sc = G.board[s.y][s.x];
    if (sc === col2) { VIS.swapSel = { x: x, y: y }; paint(); return; }  // 同色 → 改选这颗
    visSnapPush();                               // ★ 七轮：撤销快照
    G.board[s.y][s.x] = col2;                    // 互换两子颜色（数量不变，恒合法）
    G.board[y][x] = sc;
    visSyncResult();
    VIS.swapSel = null;
    var c3 = visCounts();
    visEditHint(T('veSwapDone').replace('{b}', String(c3.b)).replace('{w}', String(c3.w)));
    paint();
    return;
  }
}

/** 修改模式下右键棋盘 = 弹出与功能条一样的菜单（用户要求）。 */
function visBoardCtx(ev) {
  if (!VIS.edit) return;
  ev.preventDefault();
  ev.stopPropagation();                        // document 层的收起逻辑别把它关掉
  visShowMenu(ev, [
    [T('veSwap'), false, visEditSwap],
    [T('veDel'), false, function () { visEditPick('del'); }],
    [T('veFillB'), false, function () { visEditPick('fillb'); }],
    [T('veFillW'), false, function () { visEditPick('fillw'); }],
    [T('veAdd'), false, function () {
      VIS.addOpen = true;                        // ★ 七轮：右键菜单同样走下拉展开态
      if (els.btn_ve_add) els.btn_ve_add.classList.add('add-on');
      if (els.veAddKeys) els.veAddKeys.hidden = false;
      visEditHint(T('veAddBHint') + ' / ' + T('veAddWHint'));
    }],
    [T('veUndo'), false, visUndo],               // ★ 七轮：右键菜单也能撤销
  ]);
}

/** 识图窗口启动（宿主把窗口导航到 calc.html?vis=1）。
 *  与 bootReview 同款骨架：只恢复主题/颜色（两窗口必须同一块棋盘底色），
 *  不读设置、不恢复局面、不建停靠栏、不发引擎请求。 */
function bootVis() {
  try {
    var st = JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}');
    if (st && st.theme) S.theme = (st.theme === 'light') ? 'light' : 'dark';
    if (st && st.lang) S.lang = (st.lang === 'en') ? 'en' : 'zh';
    if (st && st.boardColor) S.boardColor = st.boardColor;
    if (st && st.pageBgColor) S.pageBgColor = st.pageBgColor;
    if (st && st.cssVars) { S.cssVars = st.cssVars; applyColorVars(st.cssVars); }
  } catch (e) {}
  document.body.setAttribute('data-theme', S.theme);
  document.body.classList.add('vis');
  document.title = T('visTitle');
  grab();
  if (!G.board) G.board = newBoard();
  els.visPane.hidden = false;
  els.btn_vis_upload.onclick = function () { els.file_vis.click(); };
  els.file_vis.onchange = function () {
    visAddFiles(els.file_vis.files);
    els.file_vis.value = '';                    // 允许下一次选同一批文件也触发 onchange
  };
  els.btn_vis_shot.onclick = visTakeShot;
  // ★ 十二轮（用户要求）：裁剪键 + 裁剪浮层接线（拖框选 → 确定裁剪）
  if (els.btn_vis_crop) els.btn_vis_crop.onclick = cropOpen;
  wireCrop();
  els.btn_vis_prev.onclick = function () { if (VIS.idx > 0) { VIS.idx--; visRefreshView(); } };
  els.btn_vis_next.onclick = function () { if (VIS.idx < VIS.list.length - 1) { VIS.idx++; visRefreshView(); } };
  // ★★ 廿四轮（用户要求）：识图窗里**双击大图** = 用系统默认看图软件打开这一张
  //   （抽屉里的缩略图同理，见 visRenderDrawer 的 ondblclick；两处都调 visOpenImage）
  if (els.visImg) {
    els.visImg.ondblclick = function () { visOpenImage(VIS.idx); };
    els.visImg.title = T('visOpenTip');
  }
  els.btn_vis_rec.onclick = visRecognize;
  els.btn_vis_save.onclick = visSaveHist;
  els.btn_vis_load.onclick = visLoadPractice;
  if (els.btn_vis_vc) els.btn_vis_vc.onclick = visVcToggle;   // ★ 九轮：VC 模式（算杀题放行）
  // ★ 单个移除（✕，2026-09-21）
  els.btn_vis_del.onclick = visRemoveCurrent;
  // ★ 图片抽屉（用户要求 2026-09-21）：点「n / m」胶囊开关左边的抽屉；✕ / ESC 收起。
  //   抽屉开着时换图/删除会由 visRefreshView → visRenderDrawer 自动同步。
  els.visPos.onclick = function () {
    if (!els.visDrawer) return;
    els.visDrawer.hidden = !els.visDrawer.hidden;
    visRenderDrawer();
  };
  if (els.btn_vd_close) els.btn_vd_close.onclick = function () {
    if (els.visDrawer) els.visDrawer.hidden = true;
  };
  // ★ 2026-09-22（用户要求）：抽屉顶部三小键 —— 选择（多选模式开关）/ 全选 / 删除；
  //   Ctrl+A 全选（抽屉开着时）；右键缩略图见 visRenderDrawer 里的菜单。
  if (els.btn_vd_sel) els.btn_vd_sel.onclick = function () {
    var on = els.btn_vd_sel.classList.toggle('accent');
    els.btn_vd_sel.textContent = on ? T('visSelOn') : T('visSelOff');
    visMsg(on ? T('visSelTip') : '');
  };
  if (els.btn_vd_all) els.btn_vd_all.onclick = function () {
    var sel = visSelSet();
    VIS.list.forEach(function (_, i) { sel.add(i); });
    visRenderDrawer();
    visMsg(T('visSelTip'));
  };
  if (els.btn_vd_del) els.btn_vd_del.onclick = visRemoveSelected;
  // ★ 2026-09-22（用户要求）：「修改」键 + 棋盘下方功能条 + 棋盘右键同款菜单
  if (els.btn_vis_edit) els.btn_vis_edit.onclick = visEditToggle;
  if (els.btn_ve_swap) els.btn_ve_swap.onclick = visEditSwap;
  if (els.btn_ve_del) els.btn_ve_del.onclick = function () { visEditPick('del'); };
  if (els.btn_ve_add) els.btn_ve_add.onclick = function () { visAddToggle(); };   // ★ 七轮：下拉开关
  if (els.btn_ve_addb) els.btn_ve_addb.onclick = function () { visEditPick('addb'); };
  if (els.btn_ve_addw) els.btn_ve_addw.onclick = function () { visEditPick('addw'); };
  if (els.btn_ve_undo) els.btn_ve_undo.onclick = function () { visUndo(); };      // ★ 七轮：撤销
  // ★ 七轮（用户要求）：Ctrl+Z = 撤销（只在识图窗修改模式生效；焦点在输入框/代码框不抢）
  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'z') return;
    if (!VIS.edit) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    visUndo();
  });
  // ★ 三轮（用户要求）：补充黑子 / 补充白子 = 单补模式（一点补一颗）
  if (els.btn_ve_fillb) els.btn_ve_fillb.onclick = function () { visEditPick('fillb'); };
  if (els.btn_ve_fillw) els.btn_ve_fillw.onclick = function () { visEditPick('fillw'); };
  // ★ 五轮（用户要求）：「自动吸附」开关删除 —— 吸附恒开，无需用户操心（引擎侧
  //   只在核心结果不可信时才吸附重试 + 外扩保细节；nosnap 请求链路一并下线）。
  // ★ 五轮（用户要求）：棋盘代码框「复制」键 —— 与主窗局面代码同格式，一键进剪贴板
  if (els.btn_vis_codecopy) {
    els.btn_vis_codecopy.onclick = function () {
      var txt = els.visCode ? els.visCode.value : '';
      if (!txt) return;
      var done = function () { visMsg(T('visCodeCopied')); };
      var legacy = function () {
        try {
          els.visCode.removeAttribute('readonly');
          els.visCode.select();
          document.execCommand('copy');
          els.visCode.setAttribute('readonly', '');
          window.getSelection && window.getSelection().removeAllRanges();
        } catch (e) {}
        done();
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(done, legacy);
      else legacy();
    };
  }
  els.board.addEventListener('click', visBoardClick);
  els.board.addEventListener('contextmenu', visBoardCtx);
  // ★ 2026-09-22 二轮（用户要求）：修改模式下棋盘也要有**预览框**（悬停格提示），
  //   颜色变浅紫（见 paint 悬停框分支的 VIS.edit 分叉）；bindBoardHover 与主窗同源。
  bindBoardHover();
  // #ctxMenu 是 body 顶层浮层：点别处 / 右键别处都要收起（与主窗抽屉同款规则）。
  document.addEventListener('click', function (e) {
    if (els.ctxMenu && !els.ctxMenu.hidden && !els.ctxMenu.contains(e.target)) closeCtx();
  });
  document.addEventListener('contextmenu', function (e) {
    if (e.defaultPrevented) return;            // 棋盘/缩略图自己弹的菜单不动
    var onItem = !!(e.target && e.target.closest && e.target.closest('#ctxMenu'));
    if (els.ctxMenu && !els.ctxMenu.hidden && !onItem) closeCtx();
  });
  // ★ 点抽屉空白 = 也走「上传本地图片」（用户要求 2026-09-21）：
  //   空白 = 抽屉自身、列表的空底、底部提示行；缩略图/✕/收起键照常各自的逻辑。
  if (els.visDrawer) els.visDrawer.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t === els.visDrawer || t === els.vdList || (t && t.id === 't_vdTip')) {
      els.file_vis.click();
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (els.ctxMenu && !els.ctxMenu.hidden) closeCtx();
      if (VIS.edit && VIS.pick) { visEditExitPick(); visEditHint(T('veEditOn')); return; }
      if (els.visDrawer && !els.visDrawer.hidden) { els.visDrawer.hidden = true; }
      return;
    }
    // ★ 2026-09-22（用户要求）：抽屉里 Ctrl+A = 全选（输入框里不抢）
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A') &&
        els.visDrawer && !els.visDrawer.hidden &&
        document.activeElement !== els.visInput) {
      ev.preventDefault();
      var sel = visSelSet();
      VIS.list.forEach(function (_, i) { sel.add(i); });
      visRenderDrawer();
    }
  });
  // ★ 动态棋盘（用户要求 2026-09-21）：窗口拉大拉小时棋盘跟着变 —— 但
  //   「图片加载框的大小不变」（visLayout 只在启动时按当时的棋盘量一次，这里不再调它）。
  window.addEventListener('resize', function () { fitFont(); layoutBoard(); });
  if (window.ResizeObserver) {
    new ResizeObserver(function () { fitFont(); layoutBoard(); }).observe(els.boardWrap);
  }
  // ★ 输入框（白框）= 局面代码 + 图片二合一（用户定稿 2026-09-21）：
  //   · 粘贴图片 → 加入图片条目（走识别引擎）
  //   · 粘贴/输入局面代码 + 回车 → 直接解析成局面（不过引擎，与主窗「粘贴直接载入」同口径）
  els.visInput.addEventListener('paste', function (ev) {
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    var hit = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type && items[i].type.indexOf('image/') === 0) { hit = items[i]; break; }
    }
    if (hit) {
      ev.preventDefault();
      var f = hit.getAsFile();
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        if (visAddImage(String(rd.result || ''), true)) visMsg('');
        else visMsg(T('visNone'));
      };
      rd.readAsDataURL(f);
      return;
    }
    var txt = ev.clipboardData ? ev.clipboardData.getData('text') : '';
    if (txt && txt.trim()) {
      ev.preventDefault();
      var cur = VIS.list[VIS.idx];
      visAddCode(txt, cur && cur.t === 'code' ? 'replace' : undefined);
    }
  });
  els.visInput.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    var txt = els.visInput.value;
    if (!txt.trim()) return;
    var cur = VIS.list[VIS.idx];
    visAddCode(txt, cur && cur.t === 'code' ? 'replace' : undefined);
  });
  // 兜底：焦点不在输入框时（比如刚点完按钮），Ctrl+V 的图片也能进来
  document.addEventListener('paste', function (ev) {
    if (document.activeElement === els.visInput) return;   // 输入框自己的 paste 已处理
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    var hit = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type && items[i].type.indexOf('image/') === 0) { hit = items[i]; break; }
    }
    if (!hit) return;
    ev.preventDefault();
    var f = hit.getAsFile();
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      if (visAddImage(String(rd.result || ''), true)) visMsg('');
      else visMsg(T('visNone'));
    };
    rd.readAsDataURL(f);
  });
  // ★ 2026-09-22（用户要求「抽屉默认保存每一次上传的图片」）：先摆空盘渲染，
  //  再异步从 IndexedDB 恢复上次的图片条目（>150 张的老图已在保存时被裁掉）。
  visRestore(function () {
    visRefreshView();
    layoutBoard();
    visLayout();
    refreshUI();
  });
  visRefreshView();
  layoutBoard();
  visLayout();
  refreshUI();

  /** 「屏幕截图」：宿主先收起训练器、弹三键小弹窗（整个应用/整个屏幕/自由截取）。 */
  function visTakeShot() {
    visMsg(T('visShotBusy'));
    tellHost({ type: 'visShot' });
  }

  /** 识图窗的宿主报文处理体（try/finally 包 tellHostDefer —— 与复盘窗同款）。 */
  function onVisHostMsg(ev) {
    var m = ev.data; if (!m) return;
    if (m.type === 'visShotData') { visAddImage(m.data, true); visMsg(''); }
    else if (m.type === 'visShotFail') visMsg(T('visShotFail'));
    else if (m.type === 'visShotCancel') visMsg('');
    else if (m.type === 'visResult') visHandleResult(m);
    else if (m.type === 'uiTheme') {
      S.theme = (m.theme === 'light') ? 'light' : 'dark';
      document.body.setAttribute('data-theme', S.theme);
      if (m.cssVars !== undefined) { S.cssVars = m.cssVars || null; applyColorVars(S.cssVars); }
      paint();
    }
  }

  if (HOST) {
    window.chrome.webview.addEventListener('message', function (ev) {
      tellHostDefer = true;
      try { onVisHostMsg(ev); } finally { tellHostDefer = false; }
    });
    window.chrome.webview.postMessage({ type: 'ready', theme: themeKey(), bg: pageBgHex(), lang: S.lang });
  }
  applyLang();
  bootDone();
}

/** 主窗口顶栏「识图」：打开（或复用）独立识图窗口 —— 窗口创建全在宿主，页面只发一条消息。 */
function openVisWindow() {
  if (HOST) { tellHost({ type: 'openVis' }); return true; }
  var w = window.open('calc.html?vis=1', 'gb_vis');
  return !!w;
}

/** 页面当前底色（#rrggbb）。宿主拿它当 WebView2 的 DefaultBackgroundColor ——
 *  复盘窗**画好之前**露出来的那一层就是它，于是看不到黑/白的一闪。 */
function pageBgHex() {
  var c = getComputedStyle(document.body).backgroundColor;
  if (!c || c === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) {
    c = getComputedStyle(document.documentElement).backgroundColor;
  }
  var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
  if (!m) return '';
  function h(n) { return ('0' + (+n).toString(16)).slice(-2); }
  return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}

/** 复盘窗口启动（宿主把窗口导航到 calc.html?rv=1）。
 *  ★ 与主窗口的 boot() 完全分开：不读设置、不恢复上次局面、不建停靠栏、不问引擎档位、
 *    不落局、不分析 —— 那个窗口「不参与任何功能的连接」。 */
function bootReview() {
  // ★ 主题跟随修复（2026-09-19 用户反馈「复盘窗深色状态下有时出现浅色」）：
  //   旧逻辑只有「主窗切主题 → 宿主转发 uiTheme」这一条路；复盘窗**自己启动**时从不
  //   读主题 → body 永远是默认浅色。主窗开深色 → 点「复盘」→ 复盘窗浅色，正是症状。
  //   这里只从 localStorage 取 theme 这**一项**（两个窗口共用同一 localStorage），
  //   其余设置照旧不恢复 —— 不违反「复盘窗不做设置恢复」的约定。
  try {
    var rvst = JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}');
    if (rvst && rvst.theme) S.theme = (rvst.theme === 'light') ? 'light' : 'dark';
    // ★ 2026-09-20：棋盘 / 页面自定义色也跟着主窗走 —— 用户要求「深色、浅色都用一种棋盘颜色」，
    //   复盘窗与主窗显然也得是同一块（否则开复盘就换了个棋盘）。这里只读颜色那几项，
    //   其余设置照旧不恢复（不违反「复盘窗不做设置恢复」的约定）。
    if (rvst && rvst.boardColor) S.boardColor = rvst.boardColor;
    if (rvst && rvst.pageBgColor) S.pageBgColor = rvst.pageBgColor;
    if (rvst && rvst.cssVars) { S.cssVars = rvst.cssVars; applyColorVars(rvst.cssVars); }
    // ★ 2026-09-21（用户要求）：对局设置里的「预览框」开关也跟主窗走 —— 选中/未选中
    //   同步到复盘窗的棋盘（悬浮格提示画不画由它决定，paint() 统一读 S.previewOn）。
    if (rvst && typeof rvst.previewOn === 'boolean') S.previewOn = rvst.previewOn;
    // ★ 2026-09-25（用户要求）：复盘窗「序号」键的开/关也跟着主窗那份设置走（纯显示偏好，
    //   与 previewOn 同类）—— 主窗没这颗键，所以这项永远是复盘窗自己写、自己读。
    if (rvst && typeof rvst.rvNum === 'boolean') S.rvNum = rvst.rvNum;
  } catch (e) {}
  // ★ 2026-09-21（用户要求）：主窗切「预览框」时复盘窗**实时**跟进 —— localStorage 的
  //   storage 事件在同源窗口间广播，这里只认 previewOn 一项（其余设置依旧不恢复，
  //   不违反「复盘窗不做设置恢复」的约定）。
  window.addEventListener('storage', function (ev) {
    if (ev.key !== 'gbcalc.settings.v1' || !ev.newValue) return;
    try {
      var st = JSON.parse(ev.newValue);
      if (typeof st.previewOn === 'boolean' && st.previewOn !== S.previewOn) {
        S.previewOn = st.previewOn;
        paint();
      }
    } catch (e) {}
  });
  document.body.setAttribute('data-theme', S.theme);
  document.body.classList.add('rv');
  document.title = T('rvWindow');
  grab();
  if (!G.board) G.board = newBoard();
  // ★ 把复盘那一行**显出来**：#rvBar 在 HTML 里带 `hidden`（主窗口永不显示它），
  //   CSS 那条 `body.rv #rvBar:not([hidden]){display:flex}` 要求这里把属性摘掉；
  //   只加 body.rv 而不摘 hidden 的话，整行按键在复盘窗里**依然是隐藏的**
  //   （而且它的子键 getComputedStyle 仍报 inline-block —— 测试很容易在这里假绿，
  //    所以 test-trainer-review 里对这几个键用的是「真的占位了吗」而不是 display）。
  els.rvBar.hidden = false;
  els.board.addEventListener('click', onRvBoardClick);
  bindBoardHover();          // ★ 复盘窗也要有悬浮格提示（见 hoverFromEvent 注释）
  window.addEventListener('resize', function () { fitFont(); layoutBoard(); visLayout(); });
  if (window.ResizeObserver) {
    new ResizeObserver(function () { fitFont(); layoutBoard(); }).observe(els.boardWrap);
  }

  els.btn_recite.onclick = startRecite;
  els.btn_replay.onclick = startReplay;
  els.btn_rv_prev.onclick = function () { rvGoTo(G.review ? G.review.k - 1 : 0); };
  els.btn_rv_next.onclick = function () {
    rvGoTo(G.review ? G.review.k + 1 : 0);
  };
  // ★ 2026-09-25（用户要求）：复盘窗「序号」键 —— 棋盘上的每颗子标出它是第几手。
  //   与主窗口的「显示序号」**两个独立开关**（见 numShown 的说明）：背诵复盘时序号就是答案，
  //   所以主窗那颗不进复盘窗；这里由用户当场决定开不开，状态随设置持久化。
  els.btn_rv_num.onclick = function () { S.rvNum = !S.rvNum; save(); syncRvNumBtn(); paint(); };
  // ★ 播放/暂停（用户要求 2026-09-19）：点键或按空格都能切换；中途改速度下一手生效
  els.btn_rv_play.onclick = function () { rvSetPlaying(!G.rvPlaying); };
  els.rvSpeed.onchange = function () {
    S.rvSpeedSec = +els.rvSpeed.value || 1;
    save();
    if (G.rvPlaying) rvSetPlaying(true);           // 播放中改速度：用新间隔重排下一手
  };
  els.btn_rv_exit.onclick = exitReview;
  // ★ 键盘操控（用户要求 2026-09-19）：「打开回顾复盘这个功能键，利用键盘上的方向键
  //   也可以操控，上一子下一子」——← 上一子、→ 下一子；空格 播放/暂停。
  //   只在**回顾复盘**里生效（背诵要凭记忆落子，方向键一按就把答案走出来了）；
  //   焦点在下拉/输入框里时不抢（否则改速度的 ↑↓/空格会被键盘劫持）。
  //   空格处理**必须 preventDefault**：按钮被点过就有焦点，默认行为会把「空格」变成
  //   「再点一下那个按钮」→ 播放键刚被空格暂停又被焦点重触发，看起来就是「失灵」。
  window.addEventListener('keydown', function (e) {
    if (!G.review) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    var handled = true;
    var kc = String(e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;
    // ★ 2026-09-25（用户要求）：**Ctrl+Z = 上一手、Ctrl+R = 重来**。
    //   · 两种复盘（背诵 / 回顾）都认 —— 背诵时也能退回去看；
    //   · Ctrl+R 在浏览器里默认是「刷新页面」—— **必须 preventDefault**，
    //     否则一按就把整个复盘窗刷掉、回到空盘（WebView2 同样会吃这个组合键）。
    //     没有进行中的复盘（G.review 为 null，例如刚点了「重来」）时不拦，
    //     这时的 Ctrl+R 就是正常的刷新窗口，符合直觉。
    if (mod && kc === 'z') {
      rvGoTo(G.review.k - 1);
    } else if (mod && kc === 'r') {
      rvSetPlaying(false);                           // 重来 = 停手 + 回到开局第 0 手
      rvGoTo(0);
    } else if (G.review.kind !== 'replay') {
      handled = false;                               // 方向键 / 空格 只在「回顾复盘」里生效
    } else if (e.key === 'ArrowLeft') {
      rvGoTo(G.review.k - 1);
    } else if (e.key === 'ArrowRight') {
      rvGoTo(G.review.k + 1);
    } else if (e.key === ' ' || e.code === 'Space') {
      rvSetPlaying(!G.rvPlaying);                    // 空格 = 播放/暂停（用户补充要求：所有播放键都适配空格）
    } else {
      handled = false;
    }
    if (handled) e.preventDefault();
  });
  els.btn_redo_rv.onclick = redoReview;             // 「重来」：只清空，**不写历史**
  els.btn_save_rv.onclick = savePos;
  // ★ 「历史」：就地打开同一套抽屉（不是再开一个窗口）——
  //   在里面挑一局 → openFromHistoryIndex 认出 RV_MODE → reviewLoad(hist=true)。
  //   于是「打开复盘这个独立窗口，再选择历史，背诵复盘/回顾复盘又出现」这条路径就通了。
  els.btn_rv_hist.onclick = function () {
    if (els.drawer.hidden) openDrawer('hist'); else closeDrawer();
  };
  // ★ 十八轮（用户要求）：复盘窗的「关闭」键删除 —— 关窗右上角系统按钮就够了，这一颗是冗余。
  wireDrawer();                                     // 抽屉接线与主窗口共用（差别在 openFromHistoryIndex）
  wireAbout();

  hideReviewNav();
  setMissBox();
  els.rvMiss.title = T('reciteHint');               // 复盘窗没有仪表盘，提示挂在「背错」上
  layoutBoard();
  refreshUI();

  /** 复盘窗的宿主报文处理体（真实回调把它包进 try/finally —— 见 tellHostDefer 的说明）。 */
  function onRvHostMsg(ev) {
    var m = ev.data; if (!m) return;
    if (m.type === 'reviewData') reviewLoad(m.record || null);
    // 导入历史读回来的 txt：复盘窗里点抽屉「导入」也走这条路
    else if (m.type === 'histTxt') importHist(m.text == null ? '' : String(m.text));
    else if (m.type === 'histExported') toast(T('expDone').replace('{n}', String(m.n || 0)));
    // ★ 任一窗口切了深/浅 → 宿主转发过来 → 复盘窗跟着换（用户要求「复盘窗也适配深浅主题」）
    else if (m.type === 'uiTheme') {
      S.theme = (m.theme === 'light') ? 'light' : 'dark';
      document.body.setAttribute('data-theme', S.theme);
      // ★ 2026-09-20：棋盘 / 页面自定义色一起跟过来 —— 主窗换了棋盘色，复盘窗必须是同一块
      //   （用户要求「深色、浅色都用一种棋盘颜色」，两个窗口当然也不能各一块）。
      if (m.cssVars !== undefined) { S.cssVars = m.cssVars || null; applyColorVars(S.cssVars); }
      paint();
    }
  }

  if (HOST) {
    window.chrome.webview.addEventListener('message', function (ev) {
      tellHostDefer = true;                    // ★ 回调内 tellHost 走延迟（见函数头注释）
      try { onRvHostMsg(ev); } finally { tellHostDefer = false; }
    });
    // 报到 → 宿主把记录投过来。
    // ★ 一并把**页面底色**报上去：宿主用它设 WebView2 的 DefaultBackgroundColor，
    //   并且在收到这一条之前**不 ShowWindow** —— 于是窗口一露面就是画好的复盘盘面，
    //   不会先黑一块/白一块（用户反馈「打开时会黑一会」就是这个）。
    window.chrome.webview.postMessage({ type: 'ready', theme: themeKey(), bg: pageBgHex(), lang: S.lang });
  } else {
    // 浏览器里直开（无宿主）：记录从 localStorage 拿（主窗口 openReviewWindow 写的）
    var txt = null;
    try { txt = localStorage.getItem('gbcalc.review.pending'); } catch (e) {}
    try { localStorage.removeItem('gbcalc.review.pending'); } catch (e) {}
    if (txt) { try { reviewLoad(JSON.parse(txt)); } catch (e) {} }
  }
  bootDone();
}

/** 载入要复盘的那一局。**棋盘仍然从空盘开始**：记录只进 G.loaded 当数据源。
 *  ★ 2026-09-19（用户要求）：只有**从历史打开**（`rec.hist === true`）才露出
 *    「背诵复盘 / 回顾复盘 / 背错 / ◀ n/m ▶」那一组；
 *    顶栏「复盘」进来的纯棋盘（hist=false / 没有记录）只留「重来 / 保存局面 / 关闭」。
 *    这正是用户那句「如果不通过历史在主界面上打开复盘，复盘里就只有那三个键；
 *    打开复盘窗口后再（在历史里）选一局，背诵/回顾这些键又会重新出现」。 */
function reviewLoad(rec) {
  var mv = ((rec && rec.moves) || []).map(function (a) {
    return { x: a[0], y: a[1], c: a[2] || 0 };
  }).filter(function (m) { return m.x != null && m.y != null; });
  var fromHist = !!(rec && rec.hist) && mv.length > 0;
  // ★★ 2026-09-23（用户要求）：VC / 残局记录 —— 打开就是**残局的模样**：所有黑子白子
  //    一次摆上棋盘作为**首帧**，复盘不需要从第一个子开始逐步回放；
  //    「背诵复盘」依赖真实次序，对合成的残局没有意义 → 藏掉。
  var egFirst = !!(rec && rec.vc) && mv.length > 0;
  // ★★ 十八轮（用户要求）：确定过的残局记录（eg/egLen）—— 背诵/回顾**从残局开始**：
  //     前 egLen 手（= 确定好的整个残局）先一次摆上作为第一帧，背诵的第一个子从它之后数起，
  //     绝不从记录的第一颗子开始。
  var egLen = (rec && rec.eg && rec.egLen > 0) ? Math.min(rec.egLen, mv.length) : 0;
  G.rvRecord = rec || null;
  // 不是从历史来的 → 这局数据对复盘没用（没有背诵/回顾可点），干脆不留在 G.loaded 里
  G.loaded = fromHist ? { moves: mv, src: (rec && rec.src) || 'local', egLen: egLen } : null;
  G.board = newBoard(); G.moves = []; G.heat = []; G.nums = []; G.curve = [];
  G.missRings = []; G.review = null; G.redo = []; G.over = false;
  if (egFirst || egLen > 0) {
    mv.slice(0, egFirst ? mv.length : egLen).forEach(function (m) {
      var c = m.c || 1;
      G.board[m.y][m.x] = c;
      G.moves.push({ x: m.x, y: m.y, c: c });
    });
  }
  hideReviewNav();
  setMissBox();
  if (els.rvGroup) els.rvGroup.hidden = !(fromHist || egFirst || egLen > 0);
  if (els.btn_recite) els.btn_recite.hidden = egFirst;   // VC 题面没有「背」的意义；eg 记录保留背诵
  // 回执给宿主：端到端测试据这一行确认「记录确实到达了复盘窗口」
  if (HOST) tellHost({ type: 'reviewAck', moves: mv.length });
  paint();
  refreshUI();
}

/** 复盘窗的按键/状态刷新。**只碰复盘窗里有的东西** —— 主窗口那一套（暂停图标、
 *  「重新开始」文案、评估曲线…）在这里全都被 body.rv 收掉了，不去算也不去改。 */
function refreshRvUI() {
  var rvKind = G.review ? G.review.kind : '';
  if (els.btn_recite) els.btn_recite.classList.toggle('on', rvKind === 'recite');
  if (els.btn_replay) els.btn_replay.classList.toggle('on', rvKind === 'replay');
  if (els.rvBar) els.rvBar.classList.toggle('stepping', rvKind === 'replay');
  els.btn_redo_rv.textContent = T('redo');
  els.btn_save_rv.textContent = T('savePos');
  els.btn_rv_hist.textContent = T('history');     // 「历史」：就地挑一局（见 bootReview）
  syncRvNumBtn();                                 // ★ 2026-09-25：复盘「序号」键（文案 + 开/关高亮 + 键盘提示）
  // 抽屉里那几个键（复盘窗只有这一条路翻历史，文案也得跟着语言走）
  els.t_history.textContent = T('history');
  els.t_saved.textContent = T('saved');
  els.dr_save.textContent = T('saveSel');
  els.dr_open.textContent = T('openSel');
  els.dr_exp.textContent = T('drExp');
  els.dr_imp.textContent = T('drImp');
  els.dr_del.textContent = T('delSel');
  els.dr_close.textContent = T('closeDr');
  if (els.dr_all) els.dr_all.textContent = drAllSelected() ? T('selNone') : T('selAll');   // ★ 二十轮
  // 播放键文案跟语言走（播放中显示「暂停」）；速度档在 startReplay 里选中当前档
  if (els.btn_rv_play && !els.btn_rv_play.hidden)
    els.btn_rv_play.textContent = G.rvPlaying ? T('pause') : T('play');
  setMissBox();
}

/** 复盘窗的落子：**只有用户在落子**，AI 一律不参与（用户要求「只能用户自行落子」）。
 *  · 背诵复盘：落对了自动前进；落错了记一次「背错」并把正确的一手补上；
 *  · 其余情况：自由落子（黑先交替）—— 纯摆盘，摆出连珠就会看到天蓝标线。 */
function onRvBoardClick(ev) {
  var rect = els.board.getBoundingClientRect();
  var g = geom();
  var hit = cellAt(ev.clientX - rect.left, ev.clientY - rect.top);   // 视图逆映射
  if (!hit) return;
  var x = hit.x, y = hit.y;
  if (G.review && G.review.kind === 'recite') { reciteStep(x, y); return; }
  if (G.review) return;                             // 回顾复盘里棋盘只读
  if (G.board[y][x]) return;                        // 已有子
  place(x, y);
  refreshUI();
}

/** 背诵 / 回顾的数据源 = 宿主投递进来的那一局。
 *  ★ 不复用主窗口的 G.moves：复盘窗的棋盘是从空盘开始的，退回 G.moves 就又变成耦合了。 */
function ensureLoadedForReview() {
  return !!(G.loaded && G.loaded.moves && G.loaded.moves.length);
}
/** 「回顾复盘」：从第 0 手开始，用 ◀ ▶ 一手手走（用户要求：回顾时「只能操控左右」）。
 *  ★ 十八轮：确定过的残局记录（egLen>0）**从残局开始** —— 初始就是整个残局摆好的样子。 */
function startReplay() {
  if (!ensureLoadedForReview()) return;
  var k0 = (G.loaded.egLen > 0) ? G.loaded.egLen : 0;
  G.review = { kind: 'replay', k: k0, miss: 0, missAt: {} };
  G.board = newBoard(); G.moves = []; G.missRings = [];
  els.btn_rv_prev.hidden = els.btn_rv_next.hidden = els.rvPos.hidden = els.btn_rv_exit.hidden = false;
  // ★ 播放/暂停键 + 速度选择（用户要求 2026-09-19）：只在回顾复盘里露出。
  //   进入时先选中当前设置的速度档；若上局还挂着自动播放，先停干净。
  rvStopPlay();
  if (els.rvSpeed) els.rvSpeed.value = String(rvStepSec());
  if (els.btn_rv_play) els.btn_rv_play.hidden = false;
  if (els.rvSpeed) els.rvSpeed.hidden = false;
  applyReviewStep();
}
/** 「背诵复盘」：凭记忆把下一手落在棋盘上，错了画粉红圈。
 *  ★ 十八轮（用户要求）：确定过的残局记录 —— 背诵的**第一个画面就是整个确定好的残局**
 *    （k 从 egLen 起步），背诵的第一个子是残局之后的第一手，绝不从记录第一颗子开始。 */
function startRecite() {
  if (!ensureLoadedForReview()) return;
  var k0 = (G.loaded.egLen > 0) ? G.loaded.egLen : 0;
  G.review = { kind: 'recite', k: k0, miss: 0, missAt: {} };
  G.board = newBoard(); G.moves = []; G.missRings = [];
  els.btn_rv_prev.hidden = els.btn_rv_next.hidden = els.rvPos.hidden = false;
  // 自动播放只属于「回顾复盘」；背诵要凭记忆落子，进来先收掉播放键与速度档
  rvStopPlay();
  if (els.btn_rv_play) els.btn_rv_play.hidden = true;
  if (els.rvSpeed) els.rvSpeed.hidden = true;
  els.btn_rv_exit.hidden = false;
  setMissBox();
  applyReviewStep();
}
/** ---------------- 复盘自动播放（用户要求 2026-09-19）----------------
 *  「回顾复盘」里点「播放」（或按空格）就按所选间隔自动一手手走；
 *  方向键 ←/→ 逐子操控；速度档 0.5~5 秒随设置持久化。
 *  播放到最后一手自动停（键回「播放」）；暂停/退出/换局/切背诵一律先停干净。 */

/** 当前所选单步间隔（秒），异常值兜底回 1 秒。 */
function rvStepSec() {
  var v = +S.rvSpeedSec;
  if (!(v >= 0.5) || !(v <= 5)) v = 1;
  return v;
}
function rvStepMs() { return Math.round(rvStepSec() * 1000); }

/** 播放/暂停的总开关。on=true 时用 setTimeout 链一手手推进（每手都重新取间隔，
 *  用户中途改速度下一手就生效）；手动前进/后退也会经这里重置计时，不会连跳。 */
/** 复盘「跳到第 k 手」的唯一入口（2026-09-25）：◀ / ▶ 两颗键、方向键 ←/→、
 *  Ctrl+Z（上一手）、Ctrl+R（重来 = 回到开局第 0 手）全都走这里 ——
 *  以前四处各写一遍「改 k → applyReviewStep → 播放中则重排」的同一段，
 *  改一处漏三处就会出「按钮动了、键盘没动」这类半边失灵。
 *  · k 会夹到 [0, 总手数]：◀ 在第 0 手、▶ 在末手都安全空转；
 *  · 正在自动播放时改 k → 用新位置重排下一手（rvSetPlaying(true)），不会卡在旧节拍上。 */
function rvGoTo(k) {
  if (!G.review) return;
  var total = (G.loaded && G.loaded.moves) ? G.loaded.moves.length : 0;
  var nk = Math.max(0, Math.min(total, k | 0));
  if (nk === G.review.k) return;
  G.review.k = nk;
  applyReviewStep();
  if (G.rvPlaying) rvSetPlaying(true);
}
/** 「序号」键的键面（2026-09-25）：开了加 .on 高亮，并在 title 里带上键盘提示。 */
function syncRvNumBtn() {
  if (!els.btn_rv_num) return;
  els.btn_rv_num.textContent = T('rvNum');
  els.btn_rv_num.classList.toggle('on', !!S.rvNum);
  els.btn_rv_num.title = T('rvNumHint') + ' · ' + T('rvKeyHint');
}
function rvSetPlaying(on) {
  if (!G.review || G.review.kind !== 'replay') { rvStopPlay(); return; }
  G.rvPlaying = !!on;
  if (els.btn_rv_play) {
    els.btn_rv_play.textContent = G.rvPlaying ? T('pause') : T('play');
    els.btn_rv_play.classList.toggle('on', G.rvPlaying);
  }
  clearTimeout(G.rvTimer);
  if (!G.rvPlaying) { G.rvTimer = 0; return; }
  var step = function () {
    if (!G.review || G.review.kind !== 'replay' || !G.rvPlaying) return;
    if (G.review.k >= G.loaded.moves.length) { rvStopPlay(); return; }   // 播完自动停
    G.review.k++;
    applyReviewStep();
    G.rvTimer = setTimeout(step, rvStepMs());
  };
  G.rvTimer = setTimeout(step, rvStepMs());
}
/** 停止播放并复位键面（不算「暂停态」，再点「播放」从头续走当前手之后）。 */
function rvStopPlay() {
  G.rvPlaying = false;
  clearTimeout(G.rvTimer);
  G.rvTimer = 0;
  if (els.btn_rv_play) {
    els.btn_rv_play.textContent = T('play');
    els.btn_rv_play.classList.remove('on');
  }
}

/** 按「第几手」重建棋盘与背错标记。
 *  ★ 背错记录从 G.review.missAt = {手数: {x,y}} 里派生，所以「上一步 / 下一步」
 *    来回走时粉红圈和「背错 N」都会跟着回到对应状态 —— 修复用户报的
 *    「点击历史复盘并不能记录哪个子是错的，错了又没法回退重看」。 */
function applyReviewStep() {
  if (!G.review) return;
  var mv = G.loaded.moves, k = G.review.k;
  G.board = newBoard(); G.moves = []; G.missRings = [];
  for (var i = 0; i < k && i < mv.length; i++) {
    var m = mv[i];
    G.board[m.y][m.x] = m.c;
    G.moves.push({ x: m.x, y: m.y, c: m.c });
  }
  var n = 0;
  for (var key in G.review.missAt) {
    var idx = +key;
    if (idx < k) { n++; G.missRings.push(G.review.missAt[key]); }
  }
  G.review.miss = n;
  els.rvPos.textContent = k + ' / ' + mv.length;
  setMissBox();
  paint();
  refreshUI();
}
function reciteStep(x, y) {
  var mv = G.loaded.moves, k = G.review.k;
  if (k >= mv.length) return;
  var want = mv[k];
  if (want.x === x && want.y === y) {
    G.review.k++;
    applyReviewStep();
    return;
  }
  // 背错：按手数记下错点（不是全局数组，这样回退再前进能复原），并把正确的一手补上
  G.review.missAt[k] = { x: x, y: y };
  G.review.k++;
  applyReviewStep();
}
/** 退出背诵 / 回顾 → 回到复盘选择界面：仍是**全新空棋盘**（不沿用内容）。 */
function exitReview() {
  if (!G.review) return;
  G.review = null;
  G.missRings = [];
  hideReviewNav();
  setMissBox();
  G.board = newBoard(); G.moves = [];
  paint();
  refreshUI();
}
/** 复盘窗的「重来」：**不写历史**，只是把局面清空（用户要求）。
 *  与主窗口「重新开始（会自动存进历史）」语义不同，所以按键文字也跟着换成「重来」，
 *  免得用户以为「重来一下又被记了一次历史」。 */
function redoReview() {
  G.review = null; G.missRings = [];
  G.board = newBoard(); G.moves = [];
  G.curve = []; G.heat = []; G.nums = [];
  G.over = false;
  hideReviewNav();
  setMissBox();
  paint();
  refreshUI();
}
// ---------------------------------------------------------------- 局面代码
// 格式与参考站 gomocalc.com **完全一致**（两边可以互相复制粘贴）：
//   编码 = 每一手取「小写列字母 + (棋盘尺寸 - 行号)」，直接拼接、**没有分隔符**，
//          例如 h8h9g7；颜色按落子先后黑白交替。
function buildCode() {
  return movesToCode(G.moves);
}
/** 一手序列 → 局面代码。**同时吃两种形状**（棋盘上是 {x,y,c}，历史里存的是 [x,y,c]）：
 *  导出历史时要用它逐局编码，所以不能只看 G.moves 那一种。 */
function movesToCode(mv) {
  return (mv || []).map(function (m) {
    if (m == null) return '';
    var x = (m.x != null) ? m.x : m[0];
    var y = (m.y != null) ? m.y : m[1];
    if (x == null || y == null) return '';
    return coordName(x, y);
  }).join('');
}
/** 解析局面代码 —— 逐条对齐参考站的 setPosStr：
 *    · 先 trim + 转小写（大小写不敏感）；
 *    · 用 /([a-z])(\d+)/g 切出「字母+数字」串（空格、逗号等一律忽略）；
 *    · 落在已占格子上的一手直接跳过（参考站 makeMove 返回 false，不改行棋方）；
 *    · ★ 一旦有人成五就**立即停止读入**（参考站的 break）——
 *      于是粘贴「赢棋之后还多写了几手」的代码也不会出现五连后还在落子。 */
function parseCode(txt) {
  var low = String(txt || '').trim().toLowerCase();
  var toks = low.match(/([a-z])(\d+)/g);
  if (!toks) return [];
  var mv = [], board = newBoard();
  for (var i = 0; i < toks.length; i++) {
    var tm = /([a-z])(\d+)/.exec(toks[i]);
    if (!tm) continue;
    var x = tm[1].charCodeAt(0) - 97;
    var y = N - parseInt(tm[2], 10);
    if (x < 0 || x >= N || y < 0 || y >= N) continue;
    if (board[y][x]) continue;                         // 该点已有子 → 跳过
    var c = (mv.length % 2 === 0) ? 1 : 2;
    board[y][x] = c;
    mv.push([x, y, c]);
    if (winAt(board, x, y, c, exactFiveRule(c))) break;  // ★ 成五即止
  }
  return mv;
}
/** 把一段文本当作局面代码载入棋盘（粘贴 / 载入两个键共用）。 */
function loadFromCode(txt) {
  var mv = parseCode(txt);
  if (!mv.length) { setStat(null, T('codeBad')); return false; }
  openRecord({ ts: Date.now(), src: 'local', rule: S.rule, first: 'b', moves: mv });
  setStat(null, T('codeLoaded'));
  return true;
}
/** 粘贴到输入框并**直接载入**（用户要求：粘贴代码后棋盘就出现该局面）。 */
function applyCodeText(t) {
  var txt = String(t == null ? '' : t).trim();
  if (!txt) { setStat(null, T('clipEmpty')); return; }
  els.inp_code.value = txt;
  loadFromCode(txt);
}

// ---------------------------------------------------------------- 保存局面（PNG）
// 原「保存 GIF」改为「保存局面」（用户要求）：把当前棋盘导出成 PNG 图片，
// 同时把局面代码填进输入框，方便图片 + 代码一起留档。
// ★ 2026-09-19 用户要求：「点击保存局面，会有一个系统里面的资源管理器弹出来，
//   提示用户要保存到哪里，不要默认保存」。页面侧做不到「让用户挑路径」——
//   浏览器的下载只能落进默认下载目录；所以把 PNG 交给**宿主**：
//   宿主弹 Win32 的「另存为」对话框，用户挑完路径后由宿主写盘（见 host.cpp SavePng）。
//   浏览器里（没有宿主）才退回原来的 <a download> 行为。
function savePos() {
  var url;
  try {
    var code = buildCode();
    if (els.inp_code) els.inp_code.value = code;
    url = els.board.toDataURL('image/png');
  } catch (e) {
    setStat(null, T('posSaveFail') + (e && e.message ? '：' + e.message : ''));
    return;
  }
  var name = 'gomoku-' + G.moves.length + '-' + Date.now() + '.png';
  if (HOST) {
    tellHost({ type: 'savePng', name: name, data: url });    // 宿主弹「另存为」对话框
    return;
  }
  try {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); }, 4000);
    setStat(null, T('posSaved'));
  } catch (e2) {
    setStat(null, T('posSaveFail') + (e2 && e2.message ? '：' + e2.message : ''));
  }
}

// ---------------------------------------------------------------- 上一步 / 下一步
// 悔棋拆成两个按键（用户要求）：上一步 = 撤回，下一步 = 重放被撤回的着法。
// 人机模式一次撤回「我 + AI」两手（撤完仍轮到用户），自由/分析一次一手。
function stepBack() {
  if (G.review || openActive() || !G.moves.length) return;
  var n = (S.mode === 'pve' && G.moves.length >= 2) ? 2 : 1;
  var chunk = [];
  for (var i = 0; i < n && G.moves.length; i++) {
    var m = G.moves.pop();
    G.board[m.y][m.x] = 0;
    chunk.unshift(m);
  }
  G.redo.push(chunk);
  G.over = false;                             // 悔棋回到终局前 → 解锁继续下
  G.curve = G.curve.filter(function (p) { return p.i < G.moves.length; });
  G.heat = []; G.nums = [];
  recomputeOver(); persistGame();
  paint(); refreshUI();
  refreshHeat(true);
  refreshCoach();
}
function stepForward() {
  if (G.review || openActive() || !G.redo.length) return;
  var chunk = G.redo.pop();
  chunk.forEach(function (m) { place(m.x, m.y); });
  recomputeOver(); persistGame();             // 重放也可能正好是制胜一手 → 重新判定终局
  paint(); refreshUI();
  refreshHeat(true);
  refreshCoach();
}

// ---------------------------------------------------------------- 外部接入
function ingestExternal(text) {
  var o;
  try { o = JSON.parse(text); } catch (e) { return false; }
  if (o && Array.isArray(o.records)) { o.records.forEach(function (r) { r.src = r.src || 'desktop'; addRecord(r); }); renderDrawer(); return true; }
  var mv = null;
  if (o && Array.isArray(o.moves)) {
    mv = o.moves.map(function (a) { return [a[0], a[1], a[2] || 0]; });
  } else if (o && (o.black || o.white)) {
    mv = [];
    var tmp = [];
    (o.black || []).forEach(function (p) { tmp.push({ x: p.x, y: p.y, c: 1 }); });
    (o.white || []).forEach(function (p) { tmp.push({ x: p.x, y: p.y, c: 2 }); });
    var bi = 0, wi = 0;
    var blacks = tmp.filter(function (p) { return p.c === 1; });
    var whites = tmp.filter(function (p) { return p.c === 2; });
    for (var i = 0; i < tmp.length; i++) {
      var takeBlack = (i % 2 === 0);
      var p = takeBlack ? blacks[bi++] : whites[wi++];
      if (!p) p = takeBlack ? whites[wi++] : blacks[bi++];
      if (!p) break;
      mv.push([p.x, p.y, p.c]);
    }
  }
  if (!mv || !mv.length) return false;
  // ★ 2026-09-21（用户要求）：识图「加载到练习」进的是**静态盘面**（推不出真实次序、
  // 也不该触发 AI 接管）—— 若当前是人机模式，自动切到「自由摆盘」再摆上来。
  // ★★ 2026-09-23（用户要求）：VC 载入 = **残局** —— 盘面就是首帧（黑白子数不限），
  //   交换手规则也不适用；非 VC 仍进自由摆盘。
  if (o.vc) {
    // ★ 十八轮：进残局 = 重新摆 → 清掉上一次确定的基准（与 seg_mode 切模式同一口径）
    S.egLocked = false; S.egBase = null;
    if (S.mode !== 'endgame') {
      S.mode = 'endgame';
      [].forEach.call(els.seg_mode.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-mode') === 'endgame');
      });
      G.heat = []; G.nums = [];
      save();
    }
  } else if (S.mode !== 'place') {
    S.mode = 'place';
    [].forEach.call(els.seg_mode.querySelectorAll('button'), function (x) {
      x.classList.toggle('on', x.getAttribute('data-mode') === 'place');
    });
    G.heat = []; G.nums = [];
    save();
    refreshUI();
  }
  var rec = { ts: Date.now(), src: o.src || 'desktop', rule: (o.rule != null ? o.rule : S.rule),
              first: 'b', moves: mv, vc: !!o.vc };   // ★ 十四轮：记录带 vc 标记（历史打开按残局首帧处理）
  addRecord(rec);
  openRecord(rec);
  renderDrawer();
  // ★★ 十二轮（用户要求）：VC 模式加载后**不自动开算杀** —— 只把「进攻方」预设成子数占优的一色，
  //   然后提示用户自己去点「VCF」或「VCT」。用户原话：「进入之后不要自动，让用户进行选择，
  //   无论是 VCF/VCT 都不自动，让用户自己进行选择」。
  if (o.vc) setTimeout(visVcArm, 450);
  return true;
}

// ---------------------------------------------------------------- 面板：拖动 / 停靠
// ★ 2026-09-18 用户要求：**取消板块「拖动改变尺寸」的功能**。
//   原 `.grip`（右下角改宽高）/ `.gripbar`（底边整条改高）/ `.split`（棋盘↔模块之间改栏宽）
//   以及它们的 mousedown 处理、尺寸持久化全部删除。模块尺寸改由 CSS 决定：
//   摊在窗口里、不向下延伸、整页不出现滑动条。
//   保留的是**搬运**（标题栏拖动换位置 / 在左右停靠栏之间搬、◀ ▶ 一键固定），这与尺寸无关。
// ★ 2026-09-20：v4 → **v5**。这一版默认布局变了（默认可见集合改成「对局设置 + 计算评估」、
//   两块都在**右栏**，见 defaultLayout），旧 v4 里存的 order 会把 setup 拉回左栏、还会漏掉
//   analysis —— 直接换 key 作废旧布局，重开就是新默认（项目里一直用这个办法，见 v1→v4）。
var LAY_KEY = 'gbcalc.layout.v7';   // ★ 2026-09-27：v6→v7（曲线并入仪表盘、默认只显示引擎仪表盘，旧布局作废）
function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LAY_KEY) || '{}'); } catch (e) { return {}; }
}
function saveLayout(l) { try { localStorage.setItem(LAY_KEY, JSON.stringify(l)); } catch (e) {} }
/** 停靠栏的「有没有卡片」同步到类上，**尺寸与排版全交给 CSS**。
 *  ★ 关键：有卡片才 .has。空栏必须收成 0 宽 —— 否则卡片全搬到左边后右栏照样占位，
 *    棋盘被挤扁、右边留一大块空白（用户说的「移到左边尺寸不协调」就是这个）。
 *  ★ 每侧**只有一列**（用户 2026-09-18 明确要求）：以前「一栏里有 ≥2 个板块就摊成双列」，
 *    结果出现「左边两列 + 右边一列」/「右边两列 + 左边一列」这种不对称版面。
 *    现在 .two 这个类不再使用，栏内永远是单列竖直排布。 */
function syncDocks() {
  [els.dockL, els.dockR].forEach(function (dock) {
    if (!dock) return;
    // ★ 2026-09-20：只数**没被隐藏**的卡片（面板显隐由「卡片」功能键控制），
    //   并且「卡片」功能条自己也算占位 —— 否则用户把所有面板都关掉时右栏会塌成 0 宽，
    //   那颗键跟着消失，他就再也点不回来了。
    var live = [].filter.call(dock.querySelectorAll('.card'), function (c) { return !c.hidden; });
    dock.classList.toggle('has', live.length > 0 || !!dock.querySelector('.cardbar'));
  });
}
/** 首次打开（没有存过布局）时的默认分布。
 *  ★ 2026-09-20（用户要求）：「默认显示对局设置和计算评估的视图，初始都放到棋盘右边」
 *    ⇒ 对局设置 + 计算评估留在**右栏**（HTML 里本来就在 #dockR）。
 *  ★ 2026-09-25（用户要求）：默认 4 张卡全开，且「引擎仪表盘放左上、评估曲线放左下」
 *    ⇒ 引擎仪表盘 + 评估曲线进**左栏**（engine 在前 = 上，curve 在后 = 下）。
 *    布局 key 从 v5 升到 v6，旧布局自动作废（见 LAY_KEY 注释）。 */
function defaultLayout() {
  if (!els.dockR) return;
  // 左栏：引擎仪表盘（评估曲线已并入本卡）；右栏：对局设置 → 计算评估（默认都收起）
  ['engine'].forEach(function (id) {
    var c = document.querySelector('.card[data-id="' + id + '"]');
    if (c) els.dockL.appendChild(c);
  });
  CARD_IDS.forEach(function (id) {
    var c = document.querySelector('.card[data-id="' + id + '"]');
    if (c && c.parentNode !== els.dockR && c.parentNode !== els.dockL) els.dockR.appendChild(c);
  });
}
function applyLayout() {
  var l = loadLayout();
  var order = l.order || {};
  var fresh = !order.L && !order.R;
  // 按存下来的 id 顺序挂回去（顺序也持久化，否则「上下调序」重开就白调了）
  ['dockL', 'dockR'].forEach(function (dn) {
    var list = order[dn === 'dockL' ? 'L' : 'R'];
    if (!list || !els[dn]) return;
    list.forEach(function (id) {
      var card = document.querySelector('.card[data-id="' + id + '"]');
      if (card) els[dn].appendChild(card);
    });
  });
  // ★ 老布局里可能残留已移除的卡片 id（如 2026-09-19 当天加过又下线的「指导」）：
  //   querySelector 找不到对应 DOM 就自然跳过，不用清历史 order。
  if (fresh) defaultLayout();
  // ★ 2026-09-20（用户要求）：折叠态一并持久化 —— 收起来的卡片重开仍是收着的。
  //   silent=true：启动期画布还没量过尺寸，别在这里触发布局重算（boot 后面会自己 layoutBoard）。
  var col = l.collapsed || {};
  [].forEach.call(document.querySelectorAll('.card'), function (card) {
    setCardFolded(card, !!col[card.getAttribute('data-id')], true);
  });
  // ★ 2026-09-20：**顺序挂完再套显隐** —— applyCardVis 会把隐藏的卡片打上 hidden 并重算
  //   停靠栏的 has 类（顺序不重要，但必须在这里收口，否则首帧会闪一下全部面板）。
  applyCardVis();
}
function persistLayout() {
  var l = { order: {} };
  ['dockL', 'dockR'].forEach(function (dn) {
    l.order[dn === 'dockL' ? 'L' : 'R'] = [].map.call(els[dn].querySelectorAll('.card'),
      function (c) { return c.getAttribute('data-id'); });
  });
  // ★ 2026-09-20：折叠态跟布局一起存（只记「收起来的」，展开的不占位）
  l.collapsed = {};
  [].forEach.call(document.querySelectorAll('.card'), function (c) {
    if (c.classList.contains('collapsed')) l.collapsed[c.getAttribute('data-id')] = 1;
  });
  saveLayout(l);
  syncDocks();
  // ★ 2026-09-20：卡片换栏之后，「卡片」菜单里那个「左 / 右」小字要跟着改
  buildCardMenu();
}

/** ★ 4 个板块控制键（▲▼◀▶）已**全部删除**（用户要求：改用一根小横杠作提示）：
 *  换栏、调序全都走「按住标题栏拖动」这一条路（见 onCardDown/onCardMove/onCardUp），
 *  拖动时用占位块 .ph 给出落点，松手即写入布局，功能一点没少。 */
/** ★ 2026-09-20（用户要求）：**点标题栏右上角那根小横杠折叠这张卡片** ——
 *  折叠后整张卡收成一条**长条圆角矩形**（只剩标题行 + 横杠），再点一次展开。
 *  · 收放全靠 CSS（.card.collapsed 把 .card-b 整块撤掉），JS 只切类、存布局；
 *  · 展开时卡里的画布（评估曲线）要重新量尺寸 → layoutBoard()（它顺手重画棋盘与曲线）；
 *  · silent=true 只在启动期（applyLayout）用：那时画布还没准备好，不能去量；
 *  · 折叠态写进布局的 collapsed 表，重开窗口仍是收着的（见 persistLayout）。 */
function setCardFolded(card, on, silent) {
  if (!card) return;
  card.classList.toggle('collapsed', !!on);
  if (!silent) layoutBoard();
}
function toggleCardFold(card) {
  if (!card) return;
  setCardFolded(card, !card.classList.contains('collapsed'));
  persistLayout();
}

var drag = null;
function initPanels() {
  [].forEach.call(document.querySelectorAll('.card'), function (card) {
    var h = card.querySelector('.card-h');
    if (h) h.addEventListener('mousedown', onCardDown);
    // 右上角的小横杠 = 折叠开关（单击即折叠/展开；它不参与拖动，见 onCardDown）
    var dash = card.querySelector('.card-h .dash');
    if (dash) dash.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleCardFold(card);
    });
    // ★ 2026-09-28（用户要求，恢复两态）：卡片右上角是「固定 / ✕」小键 ——
    //   未固定显示「固定」，点击 = 固定这张卡（键变 ✕）；已固定显示 ✕，点击 = 取消固定并关闭。
    var pk = card.querySelector('.card-h .pinkey');
    if (pk) pk.addEventListener('click', function (e) {
      e.stopPropagation();
      var id = card.getAttribute('data-id');
      if (CARD_PIN[id]) {                     // 已固定 → 取消固定并关闭这张卡
        delete CARD_PIN[id];
        var v = cardVis(); v[id] = 0; save();
        applyCardVis(); layoutBoard();
      } else {                                // 未固定 → 固定这张卡，键变成 ✕
        CARD_PIN[id] = true;
        pinKeySync(pk, id);
      }
    });
  });
}
function onCardDown(e) {
  var card = e.target.closest('.card');
  if (!card) return;
  // 标题栏里的按键/输入框不该触发拖动；★ 右上角那根小横杠是**折叠开关**，
  //   按它只折叠、绝不拖动（少了这条，点横杠会先把卡片抓起来变成拖动）。
  if (e.target.closest('button, input, select, a, .dash')) return;
  var r = card.getBoundingClientRect();
  var ph = document.createElement('div');
  ph.className = 'ph';
  ph.style.height = r.height + 'px';
  card.parentNode.insertBefore(ph, card);
  card.classList.add('floating');
  card.style.position = 'fixed';
  card.style.left = r.left + 'px';
  card.style.top = r.top + 'px';
  card.style.width = r.width + 'px';
  card.style.zIndex = 60;
  card.style.pointerEvents = 'none';
  document.body.classList.add('dragging');
  drag = { card: card, ph: ph, dx: e.clientX - r.left, dy: e.clientY - r.top };
  document.addEventListener('mousemove', onCardMove);
  document.addEventListener('mouseup', onCardUp);
  e.preventDefault();
}
function onCardMove(e) {
  if (!drag) return;
  drag.card.style.left = (e.clientX - drag.dx) + 'px';
  drag.card.style.top = (e.clientY - drag.dy) + 'px';
  var docks = [els.dockL, els.dockR], tgt = els.dockR, best = 1e9;
  docks.forEach(function (d) {
    var r = d.getBoundingClientRect(), cx = (r.left + r.right) / 2;
    var dist = Math.abs(e.clientX - cx);
    if (dist < best) { best = dist; tgt = d; }
  });
  var kids = [].filter.call(tgt.children, function (c) {
    return c.classList.contains('card') || c.classList.contains('ph');
  });
  var ref = null;
  for (var i = 0; i < kids.length; i++) {
    var r = kids[i].getBoundingClientRect();
    if (e.clientY < (r.top + r.bottom) / 2) { ref = kids[i]; break; }
  }
  if (drag.ph.parentNode !== tgt || drag.ph.nextSibling !== ref) tgt.insertBefore(drag.ph, ref);
}
function onCardUp() {
  if (!drag) return;
  var card = drag.card, ph = drag.ph;
  card.classList.remove('floating');
  card.style.position = ''; card.style.left = ''; card.style.top = '';
  card.style.width = ''; card.style.zIndex = ''; card.style.pointerEvents = '';
  document.body.classList.remove('dragging');
  ph.parentNode.insertBefore(card, ph);
  if (ph.parentNode) ph.parentNode.removeChild(ph);
  document.removeEventListener('mousemove', onCardMove);
  document.removeEventListener('mouseup', onCardUp);
  drag = null;
  layoutBoard(); persistLayout();
}

// ---------------------------------------------------------------- 设置
function applyLang() {
  var d = I18N[S.lang];
  ['title','setup','mode','side','level','turn','rule','cores','hash','heat','heatHint',
   'showNum','showNumHint','preview','previewHint','engine','depth','speed','nodes','time','eval','best','curve',
   'blackCurve','whiteCurve','curveHint','reciteHint','code','drTip',
   'heatBest','heatGood','heatFair','heatPoor','coach','coachHint',
   'swapTtl','swapFirst','swapSecond'].forEach(function (k) {
    var el = els['t_' + k];
    if (el) el.textContent = d[k];
  });
  els.btn_reset.textContent = d.reset;
  els.btn_pause.textContent = S.paused ? '▶' : '❚❚';
  els.btn_pause.title = S.paused ? (aiVsAi() ? d.spResume : d.resume)
                                 : (aiVsAi() ? d.spPause : d.assistHint);
  // ★ 2026-09-25（用户要求）：‹ › 是图标键，文案只进 title（textContent 保持 ‹ › 不被覆盖）
  els.btn_prev.title = d.prev;
  els.btn_next.title = d.next;
  els.btn_rot.title = d.rotTtl;
  els.btn_mirror.title = d.mirrorTtl;
  els.btn_shift.title = d.shiftBtnTtl;
  els.t_mirrorTtl.textContent = d.mirrorTtl;
  els.t_shiftTtl.textContent = d.shiftTtl;
  els.btn_mv_fv.textContent = d.mvFv; els.btn_mv_fv.title = d.mvFvT;
  els.btn_mv_fh.textContent = d.mvFh; els.btn_mv_fh.title = d.mvFhT;
  els.btn_mv_d1.textContent = d.mvD1; els.btn_mv_d1.title = d.mvD1T;
  els.btn_mv_d2.textContent = d.mvD2; els.btn_mv_d2.title = d.mvD2T;
  els.btn_mv_close.title = d.closeTtl;
  els.btn_shift_close.title = d.closeTtl;
  els.btn_mv_up.title = d.mvUpT; els.btn_mv_down.title = d.mvDownT;
  els.btn_mv_left.title = d.mvLeftT; els.btn_mv_right.title = d.mvRightT;
  els.btn_save.textContent = d.savePos;
  els.btn_review.textContent = d.review;
  els.btn_copy.textContent = d.copy;
  els.btn_paste.textContent = d.paste;
  els.btn_load.textContent = d.load;
  els.btn_recite.textContent = d.recite;
  els.btn_replay.textContent = d.replay;
  els.btn_rv_exit.textContent = d.exit;
  els.btn_redo_rv.textContent = d.redo;      // 复盘里「重来」并入这一行（用户要求）
  els.btn_save_rv.textContent = d.savePos;
  els.btn_history.textContent = d.openDrawer;
  // ★ 2026-09-20（用户要求）：顶栏「深色 / 浅色」两态键 → 一颗「颜色」键（打开调色窗）；
  //   深浅主题两键搬进弹窗里（文案仍走 theme / theme2 这两个老键）。
  if (!RV_MODE) {
    els.btn_color.textContent = d.color;
    els.t_color.textContent = d.color;
    els.cp_close.textContent = d.cpClose;
    els.cp_reset.textContent = d.cpReset;
    els.t_cpTheme.textContent = d.cpTheme;
    els.t_cpTarget.textContent = d.cpTarget;
    els.t_cpHex.textContent = d.cpHex;
    els.t_cpPreset.textContent = d.cpPreset;
    var ctp = els.cp_theme.querySelectorAll('button');
    if (ctp[0]) ctp[0].textContent = d.theme2;      // 浅色
    if (ctp[1]) ctp[1].textContent = d.theme;       // 深色
    if (ctp[2]) ctp[2].textContent = d.themeCustom; // 自定义
    var ctt = els.cp_target.querySelectorAll('button');
    if (ctt[0]) ctt[0].textContent = d.cpBoard;
    if (ctt[1]) ctt[1].textContent = d.cpPage;
    // ★ 2026-09-27：「卡片」键取消 —— 换成棋盘下的「设置 / AI 执子 / 分析计算」三颗键
    if (els.btn_set) els.btn_set.textContent = d.btnSet;
    if (els.btn_aiside) els.btn_aiside.textContent = d.btnAiside;
    if (els.ai_side_b && els.ai_side_b.querySelector('.tgl-txt')) els.ai_side_b.querySelector('.tgl-txt').textContent = d.aiSideB;
    if (els.ai_side_w && els.ai_side_w.querySelector('.tgl-txt')) els.ai_side_w.querySelector('.tgl-txt').textContent = d.aiSideW;
    if (els.t_aiTurn) els.t_aiTurn.textContent = d.aiTurnLbl;
    [].forEach.call(document.querySelectorAll('.pinkey'), function (pk) {
      var cd = pk.closest('.card');
      pinKeySync(pk, cd ? cd.getAttribute('data-id') : '');
    });
    if (els.btn_live) liveAnaUI();          // 分析计算键的文字跟状态走
    els.t_analysis.textContent = d.analysis;
    if (els.t_curveTtl) els.t_curveTtl.textContent = d.curve;   // ★ 2026-09-28：评估曲线标题
    els.btn_an_nbest.textContent = (G.ana.busy && G.ana.kind === 'nbest') ? d.anStop : d.anNbest;   // ★ 深夜：运行中显示「停止计算」
    els.btn_an_defend.textContent = d.anDefend;
    els.btn_an_bal1.textContent = d.anBal1;
    els.btn_an_bal2.textContent = d.anBal2;
    // ★ 五轮：前瞻键文案（< > 箭头字符是符号，不用换语言）
    //   ★ 六轮补丁（用户要求）：确定键文案 + 图例 title 也要跟语言走；
    //     body 上挂 data-lang（英文模式 CSS 用小一号字体适配，见 calc.css）。
    if (els.btn_fwd) els.btn_fwd.textContent = d.fwd;
    if (els.btn_fwd_ok) els.btn_fwd_ok.textContent = d.fwdOk;
    if (els.fwdLg) {
      els.fwdLg.title = d.fwdLegend;
      // ★ 六轮补丁：图例文字（黑子/白子）也要跟语言走 —— 实拍抓出 EN 模式下残留中文
      var lgEms = els.fwdLg.querySelectorAll('em');
      if (lgEms[0]) lgEms[0].textContent = d.fwdBlack;
      if (lgEms[1]) lgEms[1].textContent = d.fwdWhite;
    }
    document.body.setAttribute('data-lang', S.lang || 'zh');
    if (els.fwdMsg && !G.fwd.busy && !(G.fwd.line && G.fwd.line.length)) els.fwdMsg.textContent = d.fwdIdle;
    anaCalcUI();                      // 计算/停止计算的文字跟状态走，不在这里写死
    els.t_nbest.textContent = d.nbest;
    els.t_nbestHint.textContent = d.nbestHint;
    cpSyncSegs();
    applyCardVis();                                   // 菜单里的面板名与小字也要跟着语言走
    if (!G.ana.busy && !G.ana.rows.length) renderAna(d.anIdle);
  }
  els.t_history.textContent = d.history;
  els.t_saved.textContent = d.saved;
  els.dr_save.textContent = d.saveSel;
  els.dr_open.textContent = d.openSel;
  els.dr_exp.textContent = d.drExp;
  els.dr_imp.textContent = d.drImp;
  els.dr_del.textContent = d.delSel;
  els.dr_close.textContent = d.closeDr;
  // ★ 二十轮：「全部选中 / 取消全选」跟语言走（选择状态没变，这里只按当前状态刷文字）
  if (els.dr_all) els.dr_all.textContent = drAllSelected() ? d.selNone : d.selAll;
  els.btn_rv_hist.textContent = d.history;
  document.documentElement.lang = S.lang;
  var mm = els.seg_mode.querySelectorAll('button');
  // ★ 2026-09-23（用户要求）：三个模式键统一**两个字**（人机 / 摆盘 / 残局）才放得下；
  //   完整名称保留在 i18n 的 modePlace/modeEndgame 里（状态药丸等处仍用全称）。
  if (mm[0]) mm[0].textContent = S.lang === 'en' ? 'Play' : '对弈';
  if (mm[1]) mm[1].textContent = S.lang === 'en' ? 'Free' : '摆盘';
  if (mm[2]) mm[2].textContent = S.lang === 'en' ? 'Endgame' : '残局';
  // ★ 十四轮：残局摆盘键 / 选色小框的文案也要跟语言走
  // ★ 十六轮：残局「确定 / 已确定」的文字也随语言（状态由 refreshUI 维护，这里只补一次切语言时的刷新）
  if (els.btn_eg_ok) els.btn_eg_ok.textContent = S.egLocked ? d.egOkOn : d.egOk;
  if (els.btn_eg_seq) els.btn_eg_seq.textContent = d.egSeq;
  if (els.btn_eg_free) els.btn_eg_free.textContent = d.egFree;
  if (els.btn_eg_b) els.btn_eg_b.textContent = d.egB;
  if (els.btn_eg_w) els.btn_eg_w.textContent = d.egW;
  var ss = els.seg_side.querySelectorAll('button');
  // ★ 三十一轮（★ 关键修复）：拨动开关按钮 = <span class="tgl">轨道</span> + <span class="tgl-txt">文字</span>。
  //   原来这里 `ss[i].textContent = …` 会把按钮内部结构**整个覆写成纯文字** —— 胶囊轨道被抹掉，
  //   拨动开关一启动/一切语言就退化回普通按钮（用户看到的一直是它！）。现在只改 .tgl-txt 子节点。
  if (ss[0]) { var t0 = ss[0].querySelector('.tgl-txt'); if (t0) t0.textContent = d.sideAiB; else ss[0].textContent = d.sideAiB; }
  if (ss[1]) { var t1 = ss[1].querySelector('.tgl-txt'); if (t1) t1.textContent = d.sideAiW; else ss[1].textContent = d.sideAiW; }
  // ★ 三十三轮：后台预热 / 并行引擎（标题 + 提示都随语言走，跟上面那两行同款）
  if (els.t_preheat) els.t_preheat.textContent = d.preheat;

  if (els.sideHint) els.sideHint.textContent = aiVsAi()
    ? (S.mode === 'pve' ? d.sideHintBoth : d.sideHintBothPlace)
    : humanBoth() ? d.sideHintNone : (S.aiB ? d.sideHintB : d.sideHintW);
  // 规则下拉的 6 个选项也是文案（原来写死在 HTML 里 → 英文模式下还是一屏中文）
  var rn = I18N[S.lang].ruleName || {};
  [].forEach.call(els.sel_rule.querySelectorAll('option'), function (o) {
    if (rn[o.value]) o.textContent = rn[o.value];
  });
  els.btn_ten.textContent = d.ten;
  if (els.btn_about) els.btn_about.textContent = T('about');
  if (els.t_about) els.t_about.textContent = T('about');
  if (els.ab_close) els.ab_close.textContent = T('aboutClose');
  renderAbout();                                   // 正文是纯文案 → 切语言要重画
  // 悬浮提示：HTML 里的 title= 也是文案 → 打 data-tip 标记，统一在这里翻译
  [].forEach.call(document.querySelectorAll('[data-tip]'), function (e) {
    var k = e.getAttribute('data-tip');
    if (k && d[k]) e.title = d[k];
  });
  // 复盘/识图窗保持自己的窗口标题，不跟主窗的 docTitle 走
  if (!RV_MODE && !VIS_MODE) document.title = T('docTitle');
  // ★ 识图键 + 识图窗文案（三处窗口都要翻译；vis 窗里主窗专用块不跑也不影响这些）
  if (els.btn_vis) els.btn_vis.textContent = d.vis;
  if (els.t_visTtl) els.t_visTtl.textContent = d.visTtl;
  if (els.t_visHint) els.t_visHint.textContent = d.visHint;
  if (els.btn_vis_upload) els.btn_vis_upload.textContent = d.visUpload;
  if (els.btn_vis_shot) els.btn_vis_shot.textContent = d.visShot;
  // ★ 十二轮：裁剪键与浮层文案
  if (els.btn_vis_crop) els.btn_vis_crop.textContent = d.visCrop;
  if (els.t_visCropTitle) els.t_visCropTitle.textContent = d.visCropTitle;
  if (els.t_visCropHint) els.t_visCropHint.textContent = d.visCropHint;
  if (els.btn_crop_reset) els.btn_crop_reset.textContent = d.visCropReset;
  if (els.btn_crop_cancel) els.btn_crop_cancel.textContent = d.visCropCancel;
  if (els.btn_crop_ok) els.btn_crop_ok.textContent = d.visCropOk;
  if (els.btn_vis_del) els.btn_vis_del.title = d.visDelTitle;
  // ★ 识图图片抽屉（2026-09-21）：标题 / 收起键 / 底部提示 / 胶囊悬浮提示都跟着语言走
  if (els.t_visDrawer) els.t_visDrawer.textContent = d.visDrawerTtl;
  if (els.t_vdTip) els.t_vdTip.textContent = d.visVdTip;
  if (els.visPos) els.visPos.title = d.visPillTip;
  if (VIS_MODE && els.visInput && document.activeElement !== els.visInput) els.visInput.placeholder = T('visBoxHintCode');
  if (els.btn_vis_rec) els.btn_vis_rec.textContent = d.visRec;
  if (els.btn_vis_save) els.btn_vis_save.textContent = d.visSave;
  if (els.btn_vis_load) els.btn_vis_load.textContent = d.visLoad;
  // ★ 2026-09-22（用户要求）：「修改」功能条 + 抽屉三小键跟着语言走
  if (els.btn_vis_edit) els.btn_vis_edit.textContent = d.visEdit;
  if (els.btn_vis_vc) { els.btn_vis_vc.textContent = d.visVc; els.btn_vis_vc.title = d.visVcTip; }   // ★ 九轮
  if (els.btn_ve_swap) els.btn_ve_swap.textContent = d.veSwap;
  if (els.btn_ve_del) els.btn_ve_del.textContent = d.veDel;
  if (els.btn_ve_add) els.btn_ve_add.textContent = d.veAdd;
  if (els.btn_ve_addb) els.btn_ve_addb.textContent = d.veAddB;
  if (els.btn_ve_addw) els.btn_ve_addw.textContent = d.veAddW;
  if (els.btn_ve_undo) els.btn_ve_undo.textContent = d.veUndo;    // ★ 七轮
  if (els.t_vcxPop) els.t_vcxPop.textContent = d.vcxPopTitle;     // ★ 七轮：算杀弹窗标题
  if (els.vcxPop_close) els.vcxPop_close.textContent = d.aboutClose;
  // ★ 三轮（用户要求）：补充键 + 吸附开关 + 前瞻查找键跟着语言走
  if (els.btn_ve_fillb) els.btn_ve_fillb.textContent = d.veFillB;
  if (els.btn_ve_fillw) els.btn_ve_fillw.textContent = d.veFillW;
  if (els.t_visCode) els.t_visCode.textContent = d.visCode;
  if (els.btn_fwd_vcf) els.btn_fwd_vcf.textContent = d.fwdFindVcf;
  if (els.btn_fwd_vct) els.btn_fwd_vct.textContent = d.fwdFindVct;
  // ★ 2026-09-23（用户报）：「清除标记」在英文模式下一直是中文 —— i18n 键早就有（fwdClear），
  //   只是 applyLang 从没同步过这颗键的文字。补上。
  if (els.btn_fwd_clear) els.btn_fwd_clear.textContent = d.fwdClear;
  if (els.btn_vd_sel) els.btn_vd_sel.textContent =
    els.btn_vd_sel.classList.contains('accent') ? d.visSelOn : d.visSelOff;
  if (els.btn_vd_all) els.btn_vd_all.textContent = d.visSelAll;
  if (els.btn_vd_del) els.btn_vd_del.textContent = d.visDelSel;
  if (VIS_MODE) document.title = T('visTitle');
  // ★ 2026-09-21 收官（用户要求）：切语言也要报给宿主 —— 天蓝截图框的按键/标题是宿主用
  //   GDI+ 画的，它只认宿主里的语言开关；不上报的话页面已经是英文、框上还是中文。
  if (HOST) tellHost({ type: 'uiTheme', theme: themeKey(), bg: pageBgHex(), lang: S.lang, cssVars: S.cssVars });
  applyRuleHint();
  renderDrawer();
  drawCurve();
}
function applyRuleHint() {
  var h = (I18N[S.lang].ruleHint || {})[+S.rule];
  els.ruleHint.textContent = h || '';
}
/** 宿主只认 light / dark 两种外壳色；「自定义」是**配色档位**，外壳仍按浅色走
 *  （棋盘/底色那套变量由 applyColors() 单独写到 body 行内样式上）。 */
// ★ 2026-09-20（用户反馈，三轮）：「其他背景颜色的时候，棋盘选择预制色不要变回浅色」——
//   原来 custom 被硬编码归一到 light：深色壳下一点预制色/动一下取色器，S.theme 顶成 custom，
//   整个页面壳立刻回浅色。现在 custom 跟 S.customBase（最后选的深/浅）走；
//   宿主收到的仍是 light/dark（归一化语义不变，标题栏不用改）。
function themeKey() { return (S.theme === 'custom') ? (S.customBase === 'dark' ? 'dark' : 'light')
                                                    : (S.theme || 'light'); }
function applyTheme() {
  document.body.setAttribute('data-theme', themeKey());
  // ★ 2026-09-20（用户要求）：自定义色（棋盘 / 页面底色）在每个换肤口都重落一遍。
  //   行内样式本来就压得过 [data-theme]，这里重落是为了「恢复默认」能立刻生效（清掉行内值）。
  applyColors();
  paint();
  drawCurve();
  if (els.btn_color) els.btn_color.title = T('color');
  cpSyncSegs();
  // ★ 2026-09-19（用户要求）：复盘窗也要跟着深浅主题。
  //   宿主收到这条 → ① 两个窗口的系统标题栏一起变 ② 主题写进 ui 文件（下次启动遮罩用它）
  //   ③ 转发给复盘窗页面（它自己换 CSS 变量）。
  //   ★ 2026-09-20：这条报文顺带把**自定义色的整套变量**（cssVars）也发过去 —— 复盘窗据此换
  //   同一块棋盘色（两个窗口共用一块牛皮纸黄，是用户要求；不带这个字段就只换了外壳色）。
  if (HOST) tellHost({ type: 'uiTheme', theme: themeKey(), bg: pageBgHex(), lang: S.lang, cssVars: S.cssVars });
}
function applyEngineConfig() {
  LocalAI.config(S.cores, S.hashMB);       // 页面内 AI：线程=重建 Worker / 哈希=引擎热收
  // ★ 2026-09-24：把定下来的档位**同步告诉宿主**。这条通道在文件头 ③ 一直写着，但页面从来没发过，
  //   于是宿主的 g_threads / g_hashMB 恒为 0 —— 端到端测试没法证明「引擎实际拿到的是哪一档」。
  //   宿主收到只记录 + 打一行 [ai] engineConfig 日志（进程由页面 Worker 起，宿主无活可干）。
  tellHost({ type: 'engineConfig', threads: S.cores || 0, hashMB: S.hashMB || 0 });
}

// ================================================================ 配色（棋盘 / 页面底色）
/* ★ 2026-09-20（用户要求）：「点击颜色后会有一个弹窗……选择棋盘的颜色以及背景的颜色进行
 *   自定义调色并持久化」。
 *   · 默认（S.boardColor / S.pageBgColor 为空）= 直接用 calc.css 里那一套（牛皮纸护眼黄）；
 *   · 用户调过之后，本模块把他挑的那**一个**颜色折算成**一整套 CSS 变量**，写进
 *     document.body 的**行内样式** —— 行内样式优先级高于任何样式表规则（含 [data-theme="dark"]），
 *     所以一改就全局生效，而且**深浅两套主题同时跟着变**（棋盘色本来就该与主题无关，这是要求）；
 *   · 派生量一并存进 S.cssVars，让 calc.html 里那段内联启动脚本能**原样回放**（首帧即对色）；
 *   · 棋盘色 → 网格线 / 星位 / 坐标轴（同色相、按明度推开，保证任何底色下都看得清）；
 *     页面底色 → 卡片 / 浅槽 / 描边 / 正文字（按底色明暗自动选深字还是浅字）。
 *   ⚠ 只认「一个」基准色：派生量全由它算出来，所以永远不会出现「线比底还浅、看不清」这种事。 */

// ---- 颜色小工具（hex ↔ rgb ↔ hsv）----
function hexToRgb255(hex) {
  var s = String(hex == null ? '' : hex).trim();
  var m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) { var v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  // 也认 rgb(r,g,b) / rgba(...)：用户从别处拷色值时经常是这个形态
  var m3 = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  return m3 ? [+m3[1], +m3[2], +m3[3]] : null;
}
function rgbToHex(r, g, b) {
  function h(n) { n = Math.max(0, Math.min(255, Math.round(n))); return ('0' + n.toString(16)).slice(-2); }
  return '#' + h(r) + h(g) + h(b);
}
function mixHex(hex, other, t) {
  var a = hexToRgb255(hex), b = hexToRgb255(other);
  if (!a || !b) return hex;
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}
/** RGB → HSV。**灰色（d=0）时 h 返回 -1**：调用方据此保留原来的色相，
 *  否则把调色盘拖到最左边（饱和度 0）时色相会跳回 0（纯红），手感很怪。 */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = -1;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h: h, s: mx ? d / mx : 0, v: mx };
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  var t = (h < 60) ? [c, x, 0] : (h < 120) ? [x, c, 0] : (h < 180) ? [0, c, x]
        : (h < 240) ? [0, x, c] : (h < 300) ? [x, 0, c] : [c, 0, x];
  return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
}
function lum255(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; }

/** 棋盘底色 → 一整套「画在棋盘上」用的颜色。亮底往暗里推线，暗底往亮里推。 */
function boardVarsFrom(hex) {
  var rgb = hexToRgb255(hex);
  if (!rgb) return null;
  var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  var f = (hsv.v < 0.55) ? 1 : -1;             // 亮底压暗 / 暗底提亮
  function shade(dv, ds) {
    return rgbToHex.apply(null, hsvToRgb(hsv.h, Math.max(0.08, Math.min(0.92, hsv.s + ds)),
                                        Math.max(0.08, Math.min(0.98, hsv.v + f * dv))));
  }
  return {
    '--board': rgbToHex(rgb[0], rgb[1], rgb[2]),
    '--line': shade(0.20, 0.06),     // 网格线：同色相、深一档，够看清又不抢棋子
    '--star': shade(0.34, 0.08),     // 星位：再深一档
    '--axis': shade(0.28, 0.06),     // 坐标轴：介于两者之间
  };
}
/** 页面底色 → 卡片 / 浅槽 / 描边 / 正文字 / 次要字（按明暗自动选深字还是浅字）。 */
function pageVarsFrom(hex) {
  var rgb = hexToRgb255(hex);
  if (!rgb) return null;
  var base = rgbToHex(rgb[0], rgb[1], rgb[2]);
  if (lum255(rgb) < 0.5) {
    return {
      '--bg': base, '--card': mixHex(base, '#ffffff', 0.07), '--chip': mixHex(base, '#ffffff', 0.13),
      '--border': mixHex(base, '#ffffff', 0.22), '--ink': '#e7e9ec', '--sub': '#9aa0a6',
      '--chip-on': '#e7e9ec', '--chip-on-ink': mixHex(base, '#000000', 0.3),
    };
  }
  return {
    '--bg': base, '--card': mixHex(base, '#ffffff', 0.55), '--chip': mixHex(base, '#ffffff', 0.3),
    '--border': mixHex(base, '#000000', 0.12), '--ink': '#191919', '--sub': '#8a8a86',
    '--chip-on': '#191919', '--chip-on-ink': '#ffffff',
  };
}

/** 全部可能被用户色覆盖的变量名（重置时按这张表逐个 removeProperty）。 */
var COLOR_VARS = ['--board', '--line', '--star', '--axis',
                  '--bg', '--card', '--chip', '--border', '--ink', '--sub',
                  '--chip-on', '--chip-on-ink'];

function computeColorVars() {
  var vars = {}, k;
  var b = boardVarsFrom(S.boardColor); if (b) for (k in b) vars[k] = b[k];
  var p = pageVarsFrom(S.pageBgColor); if (p) for (k in p) vars[k] = p[k];
  S.cssVars = Object.keys(vars).length ? vars : null;
  return S.cssVars;
}
/** 把整套变量写进 body 行内样式（先清后写：没设的必须被清掉，否则「恢复默认」会失效）。 */
function applyColorVars(vars) {
  COLOR_VARS.forEach(function (n) { document.body.style.removeProperty(n); });
  if (vars) for (var k in vars) document.body.style.setProperty(k, vars[k]);
}
function applyColors() { applyColorVars(computeColorVars()); }

// ---- 取色器（仿 Photoshop）：色相条 + 饱和/明度方块 + RGB 滑条 + 代码框 + 预制色块 ----
var CP = { h: 40, s: 0.45, v: 0.85, target: 'board', drag: 0 };
/** 几个「好看的正式棋盘色」预制（用户要求：「挑几个好看的棋盘色，用颜色方块表示」）。
 *  第一个是默认的牛皮纸护眼黄 —— 与 calc.css 里 --board 的值一致，点它 = 回到默认那份色。 */
var CP_PRESETS = ['#d9b878', '#e3be6f', '#ecdcbb', '#c3cbb4', '#a5804e'];

function cpRGB() { var c = hsvToRgb(CP.h, CP.s, CP.v); return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]; }
function cpCurrentHex() {
  var fallback = (CP.target === 'page') ? css('--bg') : css('--board');
  var pick = (CP.target === 'page') ? S.pageBgColor : S.boardColor;
  return hexToRgb255(pick) ? pick : (hexToRgb255(fallback) ? fallback : '#d9b878');
}
/** ★ 2026-09-21（用户要求）：「选色板做的比较粗糙，定位点和选动条有明显的低像素的感觉」。
 *  根因：canvas 的**后备缓冲**写死 288×150，被 CSS 拉满宽度后是**放大**显示
 *  （Windows 上 dpr 常是 1.5 / 2）→ 渐变台阶和 1px 描边全被放大成锯齿；
 *  色相条原来只有 7 个色标（6 段线性渐变），肉眼直接看得出色带。
 *  ⇒ ① 后备缓冲按 dpr 放大、绘图上下文整体 scale(dpr)（所有描边落在设备像素上）；
 *    ② 色相条逐**设备像素**铺满 360 色相；③ 定位圈改成外黑内白双层圆环。 */
function cpRender() {
  var sv = els.cp_sv, hue = els.cp_hue;
  if (!sv || !hue) return;
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  var W = Math.round(sv.clientWidth || 288), H = Math.round(sv.clientHeight || 150);
  var HW = Math.round(hue.clientWidth || W), HH = Math.round(hue.clientHeight || 16);
  if (W < 16) W = 288; if (H < 16) H = 150;          // 弹窗还藏着时量不到 → 用设计值
  if (HW < 16) HW = W; if (HH < 6) HH = 16;
  [[sv, W, H], [hue, HW, HH]].forEach(function (t) {
    var bw = Math.round(t[1] * dpr), bh = Math.round(t[2] * dpr);
    if (t[0].width !== bw || t[0].height !== bh) { t[0].width = bw; t[0].height = bh; }
  });
  var sc = sv.getContext('2d'), hc = hue.getContext('2d');
  sc.setTransform(dpr, 0, 0, dpr, 0, 0); hc.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 「饱和度（左→右）× 明度（上→下）」方块：白→纯色相，再叠一层黑渐变
  var base = hsvToRgb(CP.h, 1, 1);
  var g = sc.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, rgbToHex(base[0], base[1], base[2]));
  sc.fillStyle = g; sc.fillRect(0, 0, W, H);
  var g2 = sc.createLinearGradient(0, 0, 0, H);
  g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)');
  sc.fillStyle = g2; sc.fillRect(0, 0, W, H);
  // 定位圈：外黑内白双层圆环（任何底色上都锐利、都看得见）
  var cx = CP.s * W, cy = (1 - CP.v) * H;
  sc.lineJoin = 'round';
  sc.lineWidth = 1.6; sc.strokeStyle = 'rgba(0,0,0,.55)';
  sc.beginPath(); sc.arc(cx, cy, 6.7, 0, Math.PI * 2); sc.stroke();
  sc.lineWidth = 2.2; sc.strokeStyle = 'rgba(255,255,255,.98)';
  sc.beginPath(); sc.arc(cx, cy, 5.3, 0, Math.PI * 2); sc.stroke();
  // 色相条：逐设备像素铺 360 段（原来是 7 个色标 = 6 段，能看见色带）
  var hg = hc.createLinearGradient(0, 0, HW, 0);
  var steps = Math.max(24, Math.min(360, Math.round(HW * dpr)));
  for (var i = 0; i <= steps; i++) {
    var c = hsvToRgb((i / steps) * 360, 1, 1);
    hg.addColorStop(i / steps, rgbToHex(c[0], c[1], c[2]));
  }
  hc.fillStyle = hg; hc.fillRect(0, 0, HW, HH);
  // 色相游标：白色竖条 + 深色描边（1 设备像素级锐利）
  var hx = Math.max(1.5, Math.min(HW - 1.5, (CP.h / 360) * HW));
  hc.fillStyle = 'rgba(255,255,255,.98)'; hc.fillRect(hx - 1.5, 0, 3, HH);
  hc.lineWidth = 1; hc.strokeStyle = 'rgba(0,0,0,.45)'; hc.strokeRect(hx - 1.5, 0.5, 3, HH - 1);
  cpSyncFields();
}
function cpSyncFields() {
  var rgb = cpRGB(), hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
  if (els.cp_r) els.cp_r.value = rgb[0];
  if (els.cp_g) els.cp_g.value = rgb[1];
  if (els.cp_b) els.cp_b.value = rgb[2];
  els.cp_rn.value = rgb[0]; els.cp_gn.value = rgb[1]; els.cp_bn.value = rgb[2];
  if (document.activeElement !== els.cp_hex) els.cp_hex.value = hex;
  els.cp_prev.style.background = hex;
  [].forEach.call(els.cp_presets.querySelectorAll('button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-c') === hex);
  });
}
/** 拖动 / 输入过程中：只刷自己 + 棋盘，**不惊动宿主**（一条 mousemove 一次 IPC 太浪费）。 */
function cpLive() {
  // ★ 2026-09-21（用户要求）：「但凡改变颜色了，就会自动切换为自定义的颜色和按键」
  //   → 一动色就把主题档位顶到「自定义」（并让那颗键亮起来），写盘在 cpCommit() 里。
  if (S.theme !== 'custom') { S.customBase = (S.theme === 'dark') ? 'dark' : 'light'; S.theme = 'custom'; cpSyncSegs(); }
  // ★ 2026-09-20（用户反馈）修复：「调色盘与调色条没有办法选中和移动」——
  //   原来这里只调 cpSyncFields()（刷 RGB 框 / 预览块），**从不重画两块 canvas**：
  //   CP.s / CP.v / CP.h 明明在变，可盘上的定位圈、条上的游标纹丝不动，
  //   看上去就是「点了没反应、拖了不动」。改成 cpRender()（它内部就带着 cpSyncFields），
  //   拖动/输入过程中调色盘与色相条跟着手走。
  cpRender();
  var hex = rgbToHex.apply(null, cpRGB());
  if (CP.target === 'page') { S.pageBgColor = hex; S.customColors.page = hex; }
  else { S.boardColor = hex; S.customColors.board = hex; }
  applyColors(); paint();
}
/** 松手 / 输入框改完：写盘 + 全量刷新（含宿主 —— 复盘窗与系统标题栏都要跟着走）。
 *  ★ 六轮（用户要求）：**预制色不跳「自定义」**（keepTheme=true）—— 预制色范围很广，
 *    深色 / 浅色壳都可以直接搭配预制色的棋盘（行内变量本来就压得过 [data-theme]）；
 *    手动拖取色器 / 输 RGB 仍然顶到「自定义」（那是上午用户自己要求的语义，不回退）。 */
function cpCommit(keepTheme) {
  if (!keepTheme && S.theme !== 'custom') { S.customBase = (S.theme === 'dark') ? 'dark' : 'light'; S.theme = 'custom'; cpSyncSegs(); }
  var hex = rgbToHex.apply(null, cpRGB());
  if (CP.target === 'page') { S.pageBgColor = hex; S.customColors.page = hex; }
  else { S.boardColor = hex; S.customColors.board = hex; }
  // ★ 顺序不能反：applyColors() 才是**算出 S.cssVars 的那一步**（computeColorVars 写在它里面）。
  //   先 save() 会把上一轮的 cssVars 存进盘里 —— 表现为「点了色块当场变了，重开窗口又变回去」
  //   （内联启动脚本回放的是旧 cssVars）。必须先算色、再落盘。
  applyColors();
  save();
  applyTheme();
}
function cpSyncSegs() {
  if (els.cp_theme) [].forEach.call(els.cp_theme.querySelectorAll('button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-th') === (S.theme || 'light'));
  });
  // ★ 2026-09-21（用户要求）：预制色只给**棋盘**用 —— 调色对象切到「背景」时整行藏起来。
  if (els.cpPresetRow) els.cpPresetRow.hidden = (CP.target === 'page');
  if (els.cp_target) [].forEach.call(els.cp_target.querySelectorAll('button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-tg') === CP.target);
  });
  if (els.cp_hint) els.cp_hint.textContent = (CP.target === 'page') ? T('cpHintP') : T('cpHintB');
}
function cpFromColor(hex) {
  var rgb = hexToRgb255(hex);
  if (!rgb) return false;
  var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  if (hsv.h >= 0) CP.h = hsv.h;      // 灰（无色相）时保留原色相，别跳回纯红
  CP.s = hsv.s; CP.v = hsv.v;
  cpRender();
  return true;
}
function cpFromRGB(r, g, b) {
  var hsv = rgbToHsv(Math.max(0, Math.min(255, +r || 0)),
                     Math.max(0, Math.min(255, +g || 0)),
                     Math.max(0, Math.min(255, +b || 0)));
  if (hsv.h >= 0) CP.h = hsv.h;
  CP.s = hsv.s; CP.v = hsv.v;
  cpRender();
}
/** 一块画布上的拖拽（两个轴向都归一化到 0..1；move 走 cpLive、松手走 cpCommit）。 */
function cpBindDrag(cv, name, onPos) {
  if (!cv) return;
  function at(e) {
    var r = cv.getBoundingClientRect();
    onPos(Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))),
          Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))));
  }
  cv.addEventListener('mousedown', function (e) { CP.drag = name; at(e); e.preventDefault(); });
  window.addEventListener('mousemove', function (e) { if (CP.drag === name) at(e); });
  window.addEventListener('mouseup', function () { if (CP.drag === name) { CP.drag = 0; cpCommit(); } });
}
function openColorPop() {
  if (els.colorPop) els.colorPop.hidden = false;
  cpSyncSegs();
  cpFromColor(cpCurrentHex());
}
function closeColorPop() { if (els.colorPop) els.colorPop.hidden = true; }
function wireColors() {
  if (!els.btn_color) return;
  els.btn_color.onclick = function () { openColorPop(); };
  els.cp_close.onclick = closeColorPop;
  els.colorPop.addEventListener('click', function (e) { if (e.target === els.colorPop) closeColorPop(); });
  els.cp_theme.onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var th = b.getAttribute('data-th');
    S.theme = (th === 'dark' || th === 'custom') ? th : 'light';
    if (th !== 'custom') S.customBase = th;   // ★ custom 底子（见 themeKey）：壳跟最后选的深/浅走
    // ★ 2026-09-20（用户反馈，三轮）：自定义过颜色后再点「深色 / 浅色」→ **整个恢复默认**的深/浅
    //   （自定义棋盘色 / 背景色一并清掉）——只有「自定义」档保留手调的那口色。
    //   ★ 五轮（用户要求）：清掉之前先把手调色**存进记忆槽 S.customColors**（随设置持久化），
    //     再点「自定义」时原样还原 —— 切主题不再让自定义色失忆。
    //   ⚠ 顺序照 cpCommit 的教训：先 applyTheme()（内部 applyColors 重算 S.cssVars）再 save()，
    //     反过来会把旧的派生变量写进盘，重开窗口又跳回旧色。
    if (th !== 'custom') {
      if (S.boardColor) S.customColors.board = S.boardColor;
      if (S.pageBgColor) S.customColors.page = S.pageBgColor;
      S.boardColor = ''; S.pageBgColor = '';
    }
    // 点「自定义」：优先**还原记忆槽**里上次的自定义色；记忆槽也是空的才退回取色器当前那口色。
    if (th === 'custom' && !S.boardColor && !S.pageBgColor) {
      if (S.customColors.board || S.customColors.page) {
        S.boardColor = S.customColors.board;
        S.pageBgColor = S.customColors.page;
      } else {
        var hex0 = rgbToHex.apply(null, cpRGB());
        if (CP.target === 'page') { S.pageBgColor = hex0; S.customColors.page = hex0; }
        else { S.boardColor = hex0; S.customColors.board = hex0; }
      }
    }
    applyTheme(); cpSyncSegs();
    if (th !== 'custom') cpFromColor(cpCurrentHex());   // 取色器/预览同步回默认色
    save();
  };
  els.cp_target.onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    CP.target = (b.getAttribute('data-tg') === 'page') ? 'page' : 'board';
    cpSyncSegs();
    cpFromColor(cpCurrentHex());
  };
  // 预制色块（用户要求：用颜色方块表示）
  els.cp_presets.innerHTML = CP_PRESETS.map(function (c) {
    return '<button type="button" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
  }).join('');
  [].forEach.call(els.cp_presets.querySelectorAll('button'), function (b) {
    // ★ 六轮：预制色 keepTheme —— 不跳「自定义」，深/浅壳照旧，直接叠预制棋盘色
    b.onclick = function () { cpFromColor(b.getAttribute('data-c')); cpCommit(true); };
  });
  cpBindDrag(els.cp_sv, 'sv', function (x, y) {
    CP.s = x; CP.v = 1 - y; cpLive();
  });
  cpBindDrag(els.cp_hue, 'hue', function (x) {
    CP.h = x * 360; cpLive();
  });
  // R / G / B：滑条与数字框同源同向（滑条 oninput 实时，数字框 onchange 收口）
  [['cp_r', 'cp_rn', 0], ['cp_g', 'cp_gn', 1], ['cp_b', 'cp_bn', 2]].forEach(function (t) {
    var s = els[t[0]], n = els[t[1]], idx = t[2];
    function set(v, commit) {
      var rgb = cpRGB(); rgb[idx] = Math.max(0, Math.min(255, Math.round(+v || 0)));
      cpFromRGB(rgb[0], rgb[1], rgb[2]);
      if (commit) cpCommit(); else cpLive();
    }
    if (s) {
      s.oninput = function () { set(s.value, false); };
      s.onchange = function () { set(s.value, true); };
    }
    if (n) n.onchange = function () { set(n.value, true); };
  });
  els.cp_hex.onchange = function () {
    var rgb = hexToRgb255(els.cp_hex.value);
    if (!rgb) { toast(T('cpBad')); cpSyncFields(); return; }
    cpFromRGB(rgb[0], rgb[1], rgb[2]);
    cpCommit();
  };
  els.cp_reset.onclick = function () {
    S.boardColor = ''; S.pageBgColor = '';
    // ★ 五轮：「恢复默认」= 连记忆槽里的自定义色一起清（那才是真正的从零开始）。
    S.customColors.board = ''; S.customColors.page = '';
    // 「恢复默认」= 自定义色也一并作废 → 主题档位从「自定义」退回浅色（否则那颗键还亮着，
    //   但盘里其实已经没有自定义色了，键与事实不符）。
    if (S.theme === 'custom') { S.theme = 'light'; S.customBase = 'light'; }
    // ★ 同 cpCommit：先把色算出来（applyColors 顺手把 S.cssVars 清成 null）再 save(),
    //   否则「恢复默认」只清了当场画面，盘里还留着旧 cssVars → 下次启动又回放成自定义色。
    applyColors();
    save();
    applyTheme();
    cpFromColor(cpCurrentHex());
    toast(T('cpReset'));
  };
}

// ================================================================ 「卡片」功能键（面板显隐）
/* ★ 2026-09-20（用户要求）：「在棋盘的右面添加一个卡片这个功能键，点击之后会有几个选项，
 *   分别是显示的窗口：引擎仪表盘，评估曲线，计算评估」+「默认显示对局设置和计算评估的视图，
 *   初始都放到棋盘右边」。
 *   ⇒ 停靠栏顶上那颗「卡片」键弹出一张勾选菜单，勾中的面板才显示在棋盘右边；
 *     默认只开「对局设置 + 计算评估」，引擎仪表盘与评估曲线默认收起（菜单里随时能叫回来）。
 *   注意「面板在左栏还是右栏」是**另一件事**（标题栏拖动能换栏，见 onCardUp）——
 *   菜单右侧那个小字如实标出每块现在停在哪一栏，免得用户以为它消失了。 */
var CARD_IDS = ['setup', 'analysis', 'engine'];   // ★ 2026-09-27：评估曲线并入引擎仪表盘（三卡）
var DEFAULT_CARDS = { setup: 0, analysis: 0, engine: 1 };   // ★ 2026-09-27（用户要求）：引擎仪表盘默认显示；对局设置/计算评估默认收起（棋盘下「设置」键里开）
// 卡片「固定」态（会话内有效：固定后不被互斥收起、新开卡片堆到它上面）
// ★ 2026-09-28（用户要求）：**引擎仪表盘默认固定** —— 它一直在，开别的卡也不会被顶掉；
//   其余卡片初始未固定（标题键显示「固定」，点一下才转成固定并显示 ✕）。
var CARD_PIN = { engine: true };
function cardVis() {
  // ★ 2026-09-27：旧存档的显隐表带着已并入的 curve 键 → 整表作废，按新默认起（三卡新口径）
  if (S.cards && S.cards.curve !== undefined) S.cards = null;
  if (!S.cards || typeof S.cards !== 'object') S.cards = {};
  CARD_IDS.forEach(function (id) {
    if (S.cards[id] === undefined) S.cards[id] = DEFAULT_CARDS[id];
  });
  return S.cards;
}
function applyCardVis() {
  var v = cardVis();
  CARD_IDS.forEach(function (id) {
    var el = document.querySelector('.card[data-id="' + id + '"]');
    if (el) el.hidden = !v[id];
  });
  buildCardMenu();
  syncDocks();
  // ★ 2026-09-28（用户要求）：显隐一变就把「固定 / ✕」两态重新同步一遍 ——
  //   否则「✕ 关掉卡片」之后那张卡（隐藏着）的键还留着 ✕，再打开时看着像还固定着。
  syncPinKeys();
}
/** ★ 2026-09-27（用户要求）：「设置」弹窗三键的文案与点亮态同步（复用旧名 buildCardMenu ——
 *  applyCardVis / persistLayout / applyLang 的调用点都不用改）。 */
function buildCardMenu() {
  if (!els.setPop) return;
  [].forEach.call(els.setPop.querySelectorAll('button[data-card]'), function (b) {
    var id = b.getAttribute('data-card');
    b.textContent = T(id);
    b.classList.toggle('on', !!cardVis()[id]);
  });
}
function toggleSetPop() {
  if (!els.setPop) return;
  // ★ 2026-09-28（用户要求）：点「设置」时若 AI 执子弹窗还开着，则**替换为**设置弹窗
  if (els.aiSidePop && !els.aiSidePop.hidden) {
    els.aiSidePop.hidden = true;
    if (els.btn_aiside) els.btn_aiside.classList.remove('on');
  }
  els.setPop.hidden = !els.setPop.hidden;
  buildCardMenu();
  if (els.btn_set) els.btn_set.classList.toggle('on', !els.setPop.hidden);
}
/** ★ 2026-09-28（用户要求，**反转上一版**）：卡片在栏内的次序 = **选择的次序**（谁先选中谁在上）。
 *  用户原话：「如果固定了，可以同时选择这三个卡片都罗列上去，并且谁先选择，谁放到最前面（最上面）」。
 *  ⇒ 新打开的卡片一律排到**本栏最后**（不是插到固定卡上面）。
 *  旧版 `bringAbovePinned` 是把新卡插到第一张固定卡前面 —— 结果每次开关一张卡，两卡上下就翻一次
 *  （实测 R 栏 setup>analysis → analysis>setup 来回跳），正是用户说的「逻辑混乱」。
 *  ★ 拖动改序（onCardUp → persistLayout）仍然有效：手动调过的次序会被存下来，重开窗口照旧。 */
function cardOrderBySelect(id) {
  var card = document.querySelector('.card[data-id="' + id + '"]');
  if (!card || card.hidden || !card.parentNode) return;
  card.parentNode.appendChild(card);     // 同栏内排到最后 = 最后一次选中
}
/** 卡片右上角「固定 / ✕」两态的文字同步（对所有卡片都跑一遍，任何显隐变化后都调它）。 */
function syncPinKeys() {
  [].forEach.call(document.querySelectorAll('.card'), function (c) {
    var pk = c.querySelector('.card-h .pinkey');
    if (pk) pinKeySync(pk, c.getAttribute('data-id'));
  });
}
/** 「设置」弹窗里点某一卡：开 = 显示、再点 = 收起。
 *  · 开「对局设置 / 计算评估」时：另一个**未固定**的同类卡收起（用户：点击对局设置则
 *    计算评估消失）；引擎仪表盘独立开关，不受互斥影响；
 *  · 固定着的卡**不被**互斥收起 ⇒ 三张卡都固定时可以**同时罗列**（用户要求）；
 *  · ★ 关掉任意一张卡 ⇒ **连固定一起撤**，再显示时得重新点「固定」（用户：关闭这个卡片需要重新固定）。 */
function toggleCardFromMenu(id) {
  var v = cardVis();
  var opening = !v[id];
  v[id] = opening ? 1 : 0;
  if (!opening) delete CARD_PIN[id];   // ★ 关闭 = 取消固定（否则再开又是 ✕，用户报的「逻辑混乱」）
  save();
  if (opening && (id === 'setup' || id === 'analysis')) {
    var other = (id === 'setup') ? 'analysis' : 'setup';
    if (v[other] && !CARD_PIN[other]) v[other] = 0;
  }
  applyCardVis();
  if (opening) cardOrderBySelect(id);   // 新开的排到本栏最后（先选的在最上面）
  syncPinKeys();                        // 键的两态跟着显隐走（关过再开 = 「固定」）
  persistLayout();
  layoutBoard();
}
/** 卡片右上角的「固定 / ✕」小键（用户 2026-09-27）：
 *  · 未固定：显示「固定」，点击 = 固定这张卡（设置里开别的卡它不再被互斥收起），文字变「✕」；
 *  · 已固定：显示「✕」，点击 = 取消固定**并关闭**这张卡。
 *  折叠横杠仍在它左边（DOM 顺序：dash 在前、pinkey 在后，横杠自然左移腾位）。 */
function pinKeySync(pk, id) {
  if (!pk) return;
  if (CARD_PIN[id]) {                       // 已固定 → 显示 ✕（点击 = 取消固定并关闭）
    pk.textContent = '\u2715';
    pk.title = T('pinCloseTtl');
  } else {                                  // 未固定 → 显示「固定」（点击 = 固定这张卡）
    pk.textContent = T('pinFix');
    pk.title = T('pinFixTtl');
  }
}
function wireCards() {
  // ★ 2026-09-27（用户要求）：顶栏「卡片」键整颗取消 —— 面板显隐统一收进棋盘下的「设置」弹窗。
  //   函数名保留：boot() 的显式调用与测试源码契约都认它。
  if (els.btn_set) {
    els.btn_set.onclick = function (e) { e.stopPropagation(); toggleSetPop(); };
  }
  if (els.setPop) {
    [].forEach.call(els.setPop.querySelectorAll('button[data-card]'), function (b) {
      b.onclick = function () { toggleCardFromMenu(b.getAttribute('data-card')); };
    });
  }
  function outside(e) {
    if (!els.setPop || els.setPop.hidden) return;
    if (els.setPop.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('#btn_set')) return;
    els.setPop.hidden = true;
    if (els.btn_set) els.btn_set.classList.remove('on');
  }
  document.addEventListener('mousedown', outside);
  document.addEventListener('click', outside);
}

// ================================================================ 计算评估（亦心那一套）
/* ★ 2026-09-20（用户要求）：「计算评估：里面有计算、扫描防守、停止计算、多点分析、平衡一、
 *   平衡二，这些功能，一定要参考这种现有的亦心棋盘思路……把它给摘取下来」。
 *   命令语义照搬 Rapfi+Yixin 的侧边栏配置（参考包 function/toolbar*.txt）：
 *     · 计算      = thinking start（toolbar6）
 *     · 停止计算  = thinking stop（toolbar5）
 *     · 扫描防守  = searchdefend（toolbar7）
 *     · 多点分析  = nbest（toolbar8）—— 引擎同时输出 N 个最佳点及各自估值
 *     · 平衡一 / 平衡二 = balance1 / balance2（toolbar13/14）＝ 一手平衡 / 二手平衡
 *       （Rapfi 整合包使用说明：「使用引擎的『一手平衡』即『二手平衡』功能计算平衡局面」）
 *   ★ 与 AI 对局的那套热力彻底分开：这里全是**用户主动点**的一次性分析，结果放在 G.ana，
 *     paint() 把它画成「名次徽标 + 评估分」，renderAna 把它列成卡片里的清单。
 *   ★ 引擎那边无法真正中断一次搜索，所以「停止计算」= 代数 +1 把在途结果**作废** + 清标注。
 */

function anaTierOf(i) { return Math.min(ANA_PAL.length - 1, i); }
function pvText(line) {
  if (!line || !line.length) return '';
  return line.slice(1, 9).map(function (p) { return coordName(p[0], p[1]); }).join(' ');
}
/** 三个分析键互斥高亮 + 停止键跟着 busy 亮/暗。
 *  ★ 2026-09-20（用户要求）：「在点击多点分析、平衡一、平衡二时，这停止计算键是亮起的，
 *    在不使用时，这个停止计算键是暗的」⇒ 停止键只跟 G.ana.busy 走，不参与互斥高亮。 */
function anaMark(btn) {
  [els.btn_an_nbest, els.btn_an_bal1, els.btn_an_bal2, els.btn_an_defend].forEach(function (b) {
    if (b) b.classList.toggle('on', !!btn && b === btn);
  });
  anaCalcUI();
}
/** ★ 2026-09-20（用户反馈）：「计算和停止计算里面的文字是活动的，没有计算的时候，
 *  它会显示计算，计算的时候它会显示停止计算」—— 同一颗键（btn_an_stop），状态机：
 *    闲            → 文案「计算」、不高亮（点它 = 开始算当前局面最佳）
 *    忙（含分析键）→ 文案「停止计算」、点亮（点它 = 中断）
 *    自然算完      → finally 里 busy=false → 自动变回「计算」 */
function anaCalcUI() {
  if (!els.btn_an_stop) return;
  var busy = !!G.ana.busy;
  els.btn_an_stop.disabled = false;                    // 闲时也要能点 = 开始计算
  els.btn_an_stop.classList.toggle('on', busy);
  els.btn_an_stop.textContent = busy ? T('anStop') : T('anCalc');
  if (els.btn_an_nbest) {   // ★ 深夜：多点分析运行中 = 文案变「停止计算」（再点即取消）
    els.btn_an_nbest.textContent = (busy && G.ana.kind === 'nbest') ? T('anStop') : T('anNbest');
  }
}
/** 扫描防守的打分器（页面内形状启发式，不走引擎）。
 *  口径与连珠教材一致：在这个空点落 c 色，四条线上各数「连子数 + 两端开闭」，查表加分。
 *  防守视角 = 对手在这落子的价值为主、我方进攻价值为辅（Yixin 的扫描防守就是这个意思）。 */
var ANA_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function anaLineScore(cnt, open) {
  if (cnt >= 5) return 100000;
  if (cnt === 4) return open >= 2 ? 10000 : (open === 1 ? 1200 : 0);
  if (cnt === 3) return open >= 2 ? 1500 : (open === 1 ? 150 : 0);
  if (cnt === 2) return open >= 2 ? 120 : (open === 1 ? 20 : 0);
  return open >= 2 ? 15 : (open === 1 ? 3 : 0);
}
/** 把 (x,y) 四条线上的「连子数 + 两端开闭」都取出来 —— 打分（cellScore）与估杀
 *  （defendMateAt）共用这一份，口径永远一致。 */
function cellLines(board, x, y, c) {
  var SZ = board.length, out = [];
  for (var d = 0; d < 4; d++) {
    var dx = ANA_DIRS[d][0], dy = ANA_DIRS[d][1], cnt = 1, open = 0;
    for (var s = -1; s <= 1; s += 2) {
      var i = 1;
      for (;;) {
        var px = x + dx * i * s, py = y + dy * i * s;
        if (px < 0 || py < 0 || px >= SZ || py >= SZ) break;
        var v = board[py][px];
        if (v === c) { cnt++; i++; continue; }
        if (v === 0) open++;
        break;
      }
    }
    out.push({ cnt: cnt, open: open });
  }
  return out;
}
function cellScore(board, x, y, c) {
  var total = 0;
  cellLines(board, x, y, c).forEach(function (l) { total += anaLineScore(l.cnt, l.open); });
  return total;
}
function renderAna(msg) {
  if (els.anStatus) els.anStatus.textContent = msg || '';
  if (!els.anList) return;
  els.anList.innerHTML = G.ana.rows.map(function (r) {
    var pal = (r.tier < 0) ? ANA_BAL : ANA_PAL[anaTierOf(r.i)];
    if (r.col) pal = { badge: r.col };      // ★ 2026-09-27：扫描防守清单同走连续渐变（与棋盘一致）
    return '<div class="it"><span class="rk" style="background:' + pal.badge + '">' + escHtml(r.badge) + '</span>' +
           '<span class="co">' + escHtml(r.coord) + '</span>' +
           '<span class="ev">' + escHtml(r.eval) + '</span>' +
           (r.pv ? '<span class="pv">' + escHtml(r.pv) + '</span>' : '') + '</div>';
  }).join('');
}
/** 局面一变（落子 / 重开 / 载入）→ 旧标注立刻作废（与热力、指导视图同一个道理）。 */
function anaReset() {
  G.ana.gen++;
  if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }  // ★ 三十轮：停流式续拍
  G.ana.defWinUntil = 0; G.ana.defRefining = false;                             // ★ 三十轮：窗口同清
  G.ana.busy = false; G.ana.kind = '';
  G.ana.marks = []; G.ana.rows = [];
  anaMark(null);
  renderAna(T('anIdle'));
}
function anaGuard(minStones) {
  if (RV_MODE || G.review) return false;
  if (LIVE_AN.on) liveAnaToggle();          // ★ 09-28 晚：显式计算键接管主车道 → 持续分析让位关闭
  if (G.ana.busy) { toast(T('anRunning')); return false; }
  if (G.moves.length < (minStones || 0)) { renderAna(T('anEmpty')); return false; }
  return true;
}
function anaIp() { return Math.max(2, Math.min(8, Math.round(+S.nbest || 4))); }

/** 计算：当前局面的最佳一手（顺带把仪表盘也填上，跟 AI 落子时看到的是同一套读数）。
 *  ★ 2026-09-20：这颗「计算」与「停止计算」是同一颗键（文字随状态走，见 anaCalcUI）。 */
async function anaCalc() {
  if (!anaGuard(0)) return;
  var gen = ++G.ana.gen;
  G.ana.busy = true; G.ana.kind = 'calc';
  anaMark(els.btn_an_stop);
  try {
    // ★ 2026-09-21（用户：少路强计算 + 计算评估适当多申请性能）：「计算」本来就是
    //   topN=1 的单路深搜 —— 把时间预算放大 1.6 倍，同样的线程全砸一条 PV 上，
    //   中后盘的杀棋/防守看得更深；用户主动点「计算」，多等这几秒是值得的。
    //   ★ 十七轮（用户要求）：**首次计算封顶 12 秒**，状态行给出预计秒数（anEta）。
    // ★ 2026-09-27（用户要求「计算评估要与对局设置中思考时间相匹配」）：去掉 12s 封顶 ——
    //   预算 = 1.6×思考时间（上限放宽到 60s 防呆）。思考时间设 30s 时计算评估真用 48s，
    //   不再被旧封顶偷偷砍成 12s；「预估 x s」的提示文案随 calcMs 走，所见即所得。
    var calcMs = Math.min(60000, Math.round((S.turnMs || 2000) * 1.6));
    renderAna(T('anEta').replace('{s}', String(Math.ceil(calcMs / 1000))));
    var r = await analyzeVote(calcMs, 1, curColor(), null, null, T('tagCalc'));
    if (gen !== G.ana.gen) return;
    var cs = (r && r.candidates) || [];
    if (!cs.length) { renderAna(T('anEmpty')); return; }
    var c0 = cs[0];
    c0.timeMs = (r.elapsed != null) ? r.elapsed : null;
    G.ana.marks = [{ x: c0.x, y: c0.y, badge: '1', label: fmtEval(c0.eval), tier: 0 }];
    G.ana.rows = [{ i: 0, badge: '1', coord: coordName(c0.x, c0.y), eval: fmtEval(c0.eval), pv: pvText(c0.line) }];
    G.lastStat = c0;
    setStat(c0, null);
    renderAna(T('anDone').replace('{n}', String(G.moves.length + 1))
             .replace('{ev}', fmtEval(c0.eval))
             .replace('{d}', String(c0.depth != null ? c0.depth : '-')));
    paint();
  } catch (e) {
    if (gen === G.ana.gen) renderAna(T('offline'));
  } finally {
    if (gen === G.ana.gen) { G.ana.busy = false; anaMark(null); }   // 算完自动变回「计算」
  }
}

/** 扫描防守（照亦心/Yixin 的「扫描防守」）：在**对手刚落那一手**周围 N×M 个格子里逐点打分，
 *  换成百分比铺在棋盘上 —— %越高 = 对手在这里能长出的形状越凶 = 越需要防。
 *  打分是**页面内的形状启发式**（cellScore），不走引擎 —— 一次扫 ~80 个点当场出结果，
 *  走引擎一来一回就是一分钟起步，没法用。 */
/** ★ 2026-09-20 三轮（用户要求）：扫描防守的徽标改用**最短杀记法**（照 rapfi 原本）：
 *  W12 = 还有 12 步赢、L6 = 还有 6 步输，取代原来的 A/B/C 字母（五轮起记号从 ±M 改 W/L）。
 *  启发式没有真搜索，步数按形状表估（现在轮到我走，ply 从现在起算）：
 *    我在此落子：成五 → W1；成活四（两头都开，挡一头还有另一头）→ W3。
 *    对手下一手在此落子：成五 → L2；成活四 → L4；成活三 → L6（不挡就连杀）。
 *    ★ 四轮（用户要求 ±M 范围大一点，只取连珠定式里**确定**的两档，不编深水数字）：
 *      四三（冲四 + 活三）→ 5 步赢；双活三 → 7 步赢（必胜但节奏留一拍余量）。对手侧同形状
 *      都折算进既有档位，不另开档。更深的 15/23 步只能来自引擎级强制杀搜索（每点一发查询，
 *      页面扫 81 个点不现实）—— 用户同意：不合理就算了，启发式绝不编造假精度的步数。
 *    ★ 五轮（用户要求）：记法从 ±M 换成 **Yixin 的 W/L**（±M 概念模糊，W/L 直白）：
 *      W = 距离赢还有几步（W1 = 一手成五）、L = 距离输还有几步（L2 = 对手一手成五）。
 *      数字含义与原 ±M 完全一致，只是符号更人话。
 *  两边都估不出杀（眠三/眠四这类挡掉就完的）→ 返回 ''，那枚点照旧铺百分比小字。
 *  「最佳的就是附近高评分点」：排序仍按威胁分（%），徽标只是把「多凶」说成步数。 */
function defendMateAt(board, x, y, me, opp) {
  var INF = 99, ourBest = INF, oppBest = INF;
  var ourFours = 0, ourThrees = 0;   // 冲四（活四另算）/ 活三 计数 —— 四三、双活三要凑这两样
  cellLines(board, x, y, me).forEach(function (l) {
    if (l.cnt >= 5) ourBest = Math.min(ourBest, 1);
    else if (l.cnt === 4 && l.open >= 2) ourBest = Math.min(ourBest, 3);
    else if (l.cnt === 4 && l.open === 1) ourFours++;
    else if (l.cnt === 3 && l.open >= 2) ourThrees++;
  });
  if (ourFours > 0 && ourThrees > 0) ourBest = Math.min(ourBest, 5);   // 四三定式
  if (ourThrees >= 2) ourBest = Math.min(ourBest, 7);                  // 双活三
  cellLines(board, x, y, opp).forEach(function (l) {
    if (l.cnt >= 5) oppBest = Math.min(oppBest, 2);
    else if (l.cnt === 4 && l.open >= 2) oppBest = Math.min(oppBest, 4);
    else if (l.cnt === 3 && l.open >= 2) oppBest = Math.min(oppBest, 6);
  });
  if (ourBest < oppBest) return 'W' + ourBest;       // ★ 五轮：W = 距离赢（Yixin 记法）
  if (oppBest < INF) return 'L' + oppBest;           // ★ 五轮：L = 距离输
  return '';
}
function anaDefend(renew) {
  if (!anaGuard(1)) return;
  var gen = ++G.ana.gen;
  // ★ 三十轮：新局面（落子/手动点键）→ 重开总窗口；流内续拍进来的不重开（窗口不续命）
  if (renew || !(G.ana.defWinUntil > Date.now())) G.ana.defWinUntil = Date.now() + streamWindowMs();
  G.ana.busy = true; G.ana.kind = 'defend';
  anaMark(els.btn_an_defend);
  var SZ = G.board.length;
  var last = G.moves[G.moves.length - 1];
  var cx = last ? last.x : (SZ - 1) / 2, cy = last ? last.y : (SZ - 1) / 2;
  var N = 9, M = 9, hx = (N - 1) / 2, hy = (M - 1) / 2;   // ★ 用户：「在周围 N 乘 M 数个方块中扫描」
  var me = curColor(), opp = (me === 1) ? 2 : 1;
  var cells = [];
  for (var y = Math.max(0, cy - hy); y <= Math.min(SZ - 1, cy + hy); y++) {
    for (var x = Math.max(0, cx - hx); x <= Math.min(SZ - 1, cx + hx); x++) {
      if (G.board[y][x]) continue;
      var sOpp = cellScore(G.board, x, y, opp);   // 对手在这落子能成的形 —— 防守看的就是它
      var sMe = cellScore(G.board, x, y, me);     // 我在这的进攻价值（顺带参考）
      cells.push({ x: x, y: y, s: sOpp + sMe * 0.55,
                   mate: defendMateAt(G.board, x, y, me, opp) });
    }
  }
  if (!cells.length) { G.ana.busy = false; anaMark(null); renderAna(T('anEmpty')); return; }
  var mx = 0;
  cells.forEach(function (c) { if (c.s > mx) mx = c.s; });
  cells.forEach(function (c) { c.pct = mx > 0 ? Math.round(c.s / mx * 100) : 0; });
  cells.sort(function (a, b) { return b.pct - a.pct; });
  // ★ 五轮：前三名改 **inline 双行徽标**（W/L 在上、百分比在下：多字 = 胶囊、单字 = 圆，
  //   用户要求「更靠近胶囊型和圆形」，百分比融进徽标本体、不再圈外飘字）。
  renderDefendMarks(cells);
  renderAna(T('anDefendDone').replace('{c}', String(cells.length)));
  G.ana.busy = false;
  anaMark(null);                        // 扫完即闲 → 键文字回「计算」
  paint();
  G.ana.autoDefend = true;              // ★ 2026-09-26（用户要求）：点过一次 → 之后随落子动态重扫
  // ★ 三十轮：启发式秒出（草稿已上盘）→ 引擎精修在后台逐轮刷新；**精修整链收尾**才续拍
  //   下一轮（中途不掐 —— 精修自身就是逐轮加深的演算流）。收敛（stable）或窗口已关 → 定格。
  G.ana.defRefining = true;
  anaDefendRefine(gen).catch(function () {}).then(function (res) {
    G.ana.defRefining = false;
    if (gen !== G.ana.gen) return;                    // 局面已换：新链自己管自己
    if (res === 'stable' || res === 'stop') return;   // 收敛 / 引擎不在 → 定格停流
    if (Date.now() < G.ana.defWinUntil) defendScheduleNext();
  });
}

/**
 * ★ 2026-09-27（用户要求）：扫描防守的徽标配色从「五档名次色」换成**连续渐变带** ——
 * 「同样扫描防守也是从青色到红色要有更丰富的渐变系」（与摆棋评分同一条渐变家族，方向相反：
 *   摆棋评分 = 分高越优越青/蓝；扫描防守 = %越高越危险越红，安全的那头是青）。
 * 色相沿途：青(196°) → 绿(140°) → 黄(88°) → 橙(38°) → 红(5°) —— 正好是原五档名次色的连续版，
 * 老用户看到的档位顺序不变，只是档与档之间多了过渡。
 * @param t 危险度 0..1（pct/100 归一）。
 *  ⚠ 开 **0.6 次幂**（凹映射）而不是线性：pct 本来就是「相对最危险点」的比值，线性直读时
 *    大半张棋盘都会挤在青色端（15% → 0.15，几乎看不出差别）；开根后 15% → 0.39（黄绿）、
 *    35% → 0.59（黄橙）、60% → 0.77（橙红），与旧五档的阈值手感（60/35/15）一一对上。
 */
function defendColor(t) {
  var ST = [[0, 196], [0.25, 140], [0.5, 88], [0.75, 38], [1, 5]];
  var v = Math.pow(Math.max(0, Math.min(1, t)), 0.6);
  for (var i = 1; i < ST.length; i++) {
    if (v <= ST[i][0]) {
      var k = (v - ST[i - 1][0]) / (ST[i][0] - ST[i - 1][0]);
      var hue = ST[i - 1][1] + (ST[i][1] - ST[i - 1][1]) * k;
      return 'hsl(' + hue.toFixed(0) + ',74%,50%)';
    }
  }
  return 'hsl(5,74%,50%)';
}

/** 扫描防守的标注渲染（启发式轮与引擎精修轮**共用同一出口**，两轮形状永远一致）。
 *  ★ 2026-09-27（用户要求）：徽标/小字颜色改由 **pct 连续渐变**（defendColor）给出 ——
 *  棋盘与清单用同一份 col，颜色不再按名次分档；tier 仍保留作兼容（清单等旧渲染路径）。 */
function renderDefendMarks(cells) {
  G.ana.defCells = cells;               // 留给精修轮做合并底稿
  var top = Math.min(3, cells.length);
  G.ana.marks = cells.map(function (c, i) {
    var col = defendColor((c.pct || 0) / 100);
    if (i < top) return { x: c.x, y: c.y, badge: c.badge || c.mate || String(i + 1),
                          label: c.pct + '%', tier: i, inline: true, col: col };
    return {                            // 其余只铺小字（不画圈）
      x: c.x, y: c.y, badge: '', label: c.badge || c.mate || (c.pct + '%'), plain: true,
      tier: c.pct >= 60 ? 0 : (c.pct >= 35 ? 1 : (c.pct >= 15 ? 3 : 4)),
      col: col,
    };
  });
  G.ana.rows = cells.slice(0, 8).map(function (c, i) {
    return { i: i, badge: c.badge || c.mate || String(i + 1),
             coord: coordName(c.x, c.y), eval: c.pct + '%', pv: '',
             col: defendColor((c.pct || 0) / 100) };
  });
}

// ============================================================================
// ★ 2026-09-26（用户要求，参考升级包「Rapfi+Yixin 界面」的同类功能）：
// 【摆棋评分】「AI 先手 / 后手都不开」= 用户自己摆棋子 —— 每摆一子就对【下一手方】
//   （当前摆的是黑子 → 下一手就是白子）做一次浅搜，把上一手周围几个候选点的
//   评估分数直接铺在格子里：格内只显示分数数字，底色按分数连续渐变 ——
//   分数越高越青 / 越蓝（优势越大），越低越红。
// 设计要点：
//   · 触发 = 每次盘面真正多了一子（afterMove / stepBack / stepForward）；
//   · 走 sub 车道 0.9s 浅搜（摆盘参考用，主车道留给对弈 AI，绝不抢核）；
//   · 候选过滤：先取距上一手切比雪夫距离 ≤3 的点（「周围几个点」），不足 4 个
//     再用其余候选补齐（远点也算参考），最多铺 8 个；
//   · 颜色 = 组内 min-max 归一化（span<30 视为等优，全按最优色，避免噪声放大成假渐变）；
//   · gen 闸与热力/指导视图同款：局面一变 / 模式切换 / 清除标记 → 在途结果作废。
// ============================================================================
/* ---------------- 分析计算（2026-09-27 持续落点评估；★ 2026-09-28 晚口径二修：gomocalc 式持续分析） ----------------
 * ★★ 2026-09-28 晚（用户要求，对标 gomocalc / Rapfi 官方分析，目标：智力超过 gomocalc）：
 *   ① **主车道满血算**：不再用 sub 视图小实例浅评分（1 线程浅搜 = 鸡肋评分的根源）——
 *      分析计算直接占用 main 车道 topN=8；AI 落子 / 显式计算键 / 预热要用车道时自动让位暂停。
 *   ② **没有时间窗口**：持续算到用户主动停止 / 落子 / 悔棋为止（旧「4.5×思考时间后定格」已删）。
 *      同一实例的置换表轮间持续变热 → 每轮等效更深，深度与分数自然收敛。
 *   ③ **显示 = 引擎当前视角**：每轮直接展示该轮榜单（不做人为加权平均 / 迟滞换位 —— 用户原话
 *      「有点机械，有点鸡肋」）。Rapfi 的最佳点随搜索加深本就「有些许变化，但不是一直在变」，
 *      这是搜索自身的稳定性，人为钉死反而失真。
 *   ④ **用时持续累加**：仪表盘用时 = 本局面会话起点到现在（跨轮累加，见 paintLiveDash 的 LIVE_AN.t0）。
 *   ⑤ **用户落子 → 会话重开**：key（手数:行棋方）一变，轮数/起点清零，重新计算（用户要求）。
 *   ⑥ 摆棋评分已下架，本功能接管其职责：摆盘 / 残局 / 双人手动对弈里同样可用
 *      （行棋方按数子判定 sideByCount，任意摆盘乱序颜色也不出错）。 */
var LIVE_AN = { on: false, gen: 0, busy: false, items: [], timer: 0, key: '', t0: 0, rounds: 0 };
function liveAnaWanted() { return LIVE_AN.on && !RV_MODE && !G.review && !G.over && aiDecorOn(); }
function liveAnaClear() {
  LIVE_AN.gen++;
  LIVE_AN.items = [];
  LIVE_AN.key = ''; LIVE_AN.t0 = 0; LIVE_AN.rounds = 0;
  if (LIVE_AN.timer) { clearTimeout(LIVE_AN.timer); LIVE_AN.timer = 0; }
  delete LIVE_LANES.main;                     // 会话结束 → 摘掉主车道 live 残留（胶囊熄灯）
  paintLiveDash();
  paint();
}
function liveAnaUI() {
  if (!els.btn_live) return;
  els.btn_live.classList.toggle('on', LIVE_AN.on);
  els.btn_live.textContent = LIVE_AN.on ? T('liveAnaStop') : T('liveAna');
}
function liveAnaToggle() {
  LIVE_AN.on = !LIVE_AN.on;
  liveAnaUI();
  if (LIVE_AN.on) liveAnaTick();
  else liveAnaClear();
}
/** 对弈里 AI 会接手行棋 → 分析轮随时可能被 AI 落子打断，轮预算压短（上限 4s，置换表变热仍逐轮加深）；
 *  摆盘 / 残局 / 双人手动 → 没有抢车道的一方，轮预算逐轮 ×1.3 加深（封顶 20s），越算越深。 */
function liveAnaAiPending() { return S.mode === 'pve' && (isAiColor(1) || isAiColor(2)); }
function liveAnaRoundMs() {
  if (liveAnaAiPending()) return Math.max(1500, Math.min(4000, Math.round((S.turnMs || 2000) * 0.8)));
  var ms = Math.max(2500, Math.round((S.turnMs || 2000) * 1.2)) * Math.pow(1.3, LIVE_AN.rounds);
  return Math.round(Math.min(20000, ms));
}
/** 一轮：替**当前行棋方**要 8 个候选（main 车道满血），引擎本轮榜单直接上棋盘。
 *  局面一变（落子/悔棋/换手）由 key 重开会话；gen/手数闸作废旧结果；引擎离线退避 1.2s 再试。 */
async function liveAnaTick() {
  if (!liveAnaWanted()) { LIVE_AN.on = false; liveAnaUI(); liveAnaClear(); return; }
  // ★ 让位：AI 落子 / 显式计算在主车道忙 → 500ms 后重试（分析排队等，不抢主搜）
  if (G.busy || G.ana.busy) {
    if (LIVE_AN.timer) clearTimeout(LIVE_AN.timer);
    LIVE_AN.timer = setTimeout(liveAnaTick, 500);
    return;
  }
  var gen = ++LIVE_AN.gen;
  var mvN = G.moves.length;
  var side = sideByCount();                   // ★ 数子判行棋方（任意摆盘乱序颜色也不出错）
  var hk = mvN + ':' + side;
  if (LIVE_AN.key !== hk) {                   // 用户落子 / 悔棋 / 换手 → 会话重开，重新计算
    LIVE_AN.key = hk; LIVE_AN.t0 = Date.now(); LIVE_AN.rounds = 0;
  }
  LIVE_AN.busy = true;
  try {
    var r = await analyzeVote(liveAnaRoundMs(), 8, side, null, null, T('tagLiveAna'));
    if (gen !== LIVE_AN.gen || G.moves.length !== mvN) return;
    LIVE_AN.rounds++;
    var cs = ((r && r.candidates) || []).slice(0, 8).filter(function (c) {
      return c && c.x >= 0 && c.y >= 0 && !(G.board[c.y] && G.board[c.y][c.x]);
    });
    // ★ 引擎本轮榜单本体（第 1 名 = 引擎当前最佳点）—— 自然微变，不人为钉死
    LIVE_AN.items = cs.map(function (c, i) {
      return { x: c.x, y: c.y, ev: fmtEval(c.eval), rank: i };
    });
    paint();
  } catch (e) { gen = -1; }                   // 引擎离线等：退避重试（见 finally）
  finally {
    LIVE_AN.busy = false;
    if (LIVE_AN.on && liveAnaWanted()) {
      if (LIVE_AN.timer) clearTimeout(LIVE_AN.timer);
      LIVE_AN.timer = setTimeout(liveAnaTick, (gen === -1) ? 1200 : streamGapMs());
    }
  }
}
/** 「分析计算」四色档（用户要求：青→红四色渐变；最佳=青色+胶囊边框，越差越红、填充越浅）。 */
/** 「分析计算」四色档（用户要求：青→绿→橙→红 渐变；最佳=青色，越差越红、填充越浅）。 */
var LIVE_PAL = [
  { fill: 'rgba(0,194,201,.92)',   ring: 'rgba(150,205,255,.98)' },    // 1 青色（最佳）
  { fill: 'rgba(96,200,120,.82)',  ring: 'rgba(255,255,255,.92)' },    // 2 绿色
  { fill: 'rgba(255,176,102,.68)', ring: 'rgba(255,255,255,.9)' },     // 3 橙色
  { fill: 'rgba(255,102,102,.42)', ring: 'rgba(255,255,255,.85)' },    // 4 红色（最差）
];
function liveTier(i, n) {
  if (i <= 0) return 0;
  if (n <= 2) return Math.min(3, i);
  return Math.max(1, Math.min(3, Math.ceil(i * 3 / (n - 1))));
}
/** ★ 2026-09-26（用户要求）：盘面已「定局」= 任一色已成五（≥5 连）**或已成活四**
 *  （四连两头都空，下一步必成五）—— 此时静默评估与多点防守都该停止显示。 */
function boardDecided() {
  var b = G.board, N2 = b.length;
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var y = 0; y < N2; y++) for (var x = 0; x < N2; x++) {
    var c = b[y][x];
    if (!c) continue;
    for (var d = 0; d < 4; d++) {
      var dx = DIR[d][0], dy = DIR[d][1];
      if (y - dy >= 0 && y - dy < N2 && x - dx >= 0 && x - dx < N2 && b[y - dy][x - dx] === c) continue;
      var n = 0, px = x, py = y;
      while (px >= 0 && py >= 0 && px < N2 && py < N2 && b[py][px] === c) { n++; px += dx; py += dy; }
      if (n >= 5) return true;                        // 已经五子连珠
      if (n === 4) {                                  // 活四 = 四连的两端都是空点
        var ex = x - dx, ey = y - dy;
        if (ex >= 0 && ey >= 0 && ex < N2 && ey < N2 && !b[ey][ex] &&
            px >= 0 && py >= 0 && px < N2 && py < N2 && !b[py][px]) return true;
      }
    }
  }
  return false;
}
/** 归一化强度 t(0..1) → 底色：多段渐变 红(5°)→橙(38°)→黄(88°)→绿(140°)→青(196°)→蓝(225°) ——
 *  ★ 2026-09-26（用户要求）：「从蓝到红、渐变更丰富（颜色更多一点）」—— 比原先单段色相
 *  多出橙/黄/绿三个色停，高分蓝、低分红、中间层次分明，同组内一眼分出优劣次序。 */
/** 下一手方（按盘面黑白子数判，黑先交替）：黑子多 → 轮白；否则轮黑。
 *  摆盘/残局的「任意摆盘」颜色可乱序 → 不能用手数奇偶，必须数子。 */
function sideByCount() {
  var bn = 0, wn = 0;
  for (var y = 0; y < G.board.length; y++) for (var x = 0; x < G.board.length; x++) {
    if (G.board[y][x] === 1) bn++; else if (G.board[y][x] === 2) wn++;
  }
  return bn > wn ? 2 : 1;
}
/** 总刷新窗口（思考时间 ×4.5、下限 4s）：扫描防守精修链（defWinUntil）与前瞻规划用。 */
function streamWindowMs() { return Math.round(Math.max(4000, (S.turnMs || 2000) * 4.5)); }
function streamGapMs() { return 120; }
/** ★ 五轮（用户要求）：「扫描防守应该持续计算和刷新，到最后趋于一个最为确定的值就停止」。
 *  做法（rapfi 多 PV 的语言）：每轮 ① 引擎讨「我方最佳一手」**虚拟落上**当锚点；
 *  ② topN=8 问「对手最凶的回应」—— 候选的 eval（对手视角）就是那点的危险度，
 *     对手 +Mn → 我方 L(n+1)（从我方下一手算起多一拍）；③ 与启发式点集合并、按危险度
 *  重排 top3、重算 %，立即刷上棋盘。相邻两轮 top3 完全一致 = 收敛 → 状态栏报「已稳定」并停。
 *  全程 gen 闸：落子/换局立即作废在途轮次。
 *  ★ 六轮（用户要求「对照 rapfi 官方 + 强 AI 时代做得更好」）：
 *    · W/L 语义核对：rapfi 官方 ±M 按 **ply** 计（+M1 = 立即成五），我们的 W_n ≡ +M_n、
 *      L_n ≡ -M_n（描述「在该点先动手的那一方」），映射口径与官方一致；
 *    · 精修从 sub 车道挪到**专用 fwd 车道**（独立 Rapfi 实例，不再和热力图/指导视图抢核）；
 *    · 预算逐轮加深到 400/900/1600ms —— 有车道余量，让引擎真正算到杀。 */
async function anaDefendRefine(gen) {
  // ★ 廿八轮（用户要求「计算习惯匹配原生引擎」）：三轮精修预算从 400/900/1600 加深到
  //   600/1400/2600 —— fwd 车道是独立引擎实例（不与主搜/热力抢核），原生多线程下这个
  //   量级照样秒级回包，扫描防守的收敛值更准。
  var RD = [600, 1400, 2600];
  var prevSig = null;
  for (var r = 0; r < RD.length; r++) {
    if (gen !== G.ana.gen || boardDecided()) return;   // ★ 定局（五连/活四）→ 精修立刻收场
    var me = curColor();
    var anchor = null;
    try {
      var ra = await LocalAI.analyze({ board: G.board, moveList: [], matchMs: 600000,
        turnMs: RD[r], timeUsedMs: 0, topN: 1, rule: engineRule(),
        cid: 'defA-' + gen + '-' + r, lane: 'fwd', side: me,
        liveId: LocalAI.nextLiveId(), tag: T('tagDefend') }, RD[r] + 9000);
      anchor = ra && ra.candidates && ra.candidates[0];
    } catch (e) { return 'stop'; }       // 引擎不在：启发式结果已可用，静默收场（不再续拍）
    if (gen !== G.ana.gen || !anchor || G.board[anchor.y][anchor.x]) return;
    G.board[anchor.y][anchor.x] = me;    // 虚拟落我方最佳一手（盘面轮到对手说话）
    var cands = null;
    try {
      var rr = await LocalAI.analyze({ board: G.board, moveList: [], matchMs: 600000,
        turnMs: RD[r], timeUsedMs: 0, topN: 8, rule: engineRule(),
        cid: 'defB-' + gen + '-' + r, lane: 'fwd', side: 3 - me,   // 虚拟子后轮到对手
        liveId: LocalAI.nextLiveId(), tag: T('tagDefend') }, RD[r] + 9000);
      cands = (rr && rr.candidates) || null;
    } catch (e) { cands = null; }
    G.board[anchor.y][anchor.x] = 0;     // 立刻撤回虚拟子（无论成败）
    if (gen !== G.ana.gen) return;
    if (!cands || !cands.length) return;
    // 换算：对手视角 eval → L 步数 + 危险度
    var mx = 0;
    cands.forEach(function (c) {
      var v = evalNum(c.eval);
      c.danger = (isNaN(v) || v < 0) ? 0 : v;      // 对手越优 = 我们越危险
      var mn = /^M(\d+)$/i.exec(String(c.eval == null ? '' : c.eval).replace('+', ''));
      c.L = (mn && v > 0) ? (+mn[1] + 1) : 0;      // 对手 +Mn → 我方 L(n+1)
      if (c.danger > mx) mx = c.danger;
    });
    cands.forEach(function (c) { c.pct = mx > 0 ? Math.round(c.danger / mx * 100) : 0; });
    // 合并进启发式点集：被精修的点覆盖徽标/%，并按「精修危险度优先」重排
    var map = {};
    cands.forEach(function (c) { map[c.x + ',' + c.y] = c; });
    var merged = (G.ana.defCells || []).map(function (c) {
      var f = map[c.x + ',' + c.y];
      if (!f) return c;
      // ★ 只有「真有威胁」（有 L 步数或危险度 > 0）的精修点才顶到最前；
      //   引擎确认无害的点（W3 那类）保持启发式原位，否则 0% 会占走榜首。
      return { x: c.x, y: c.y, pct: f.pct, badge: f.L ? ('L' + f.L) : (c.badge || c.mate || ''),
               prio: (f.L || f.danger > 0) ? (100000 + f.danger) : (c.prio || c.pct) };
    });
    merged.sort(function (a, b) { return (b.prio || b.pct) - (a.prio || a.pct); });
    var sig = merged.slice(0, 3).map(function (c) {
      return c.x + ',' + c.y + ':' + (c.badge || '') + '/' + c.pct;
    }).join('|');
    var stable = (prevSig !== null && sig === prevSig);
    prevSig = sig;
    if (gen !== G.ana.gen) return;
    renderDefendMarks(merged);
    renderAna(stable ? T('anDefendStable')
                     : T('anDefendRefine').replace('{r}', String(r + 1)).replace('{t}', String(RD.length)));
    paint();
    if (stable) return 'stable';         // ★ 三十轮：收敛 → 上报，续拍链定格停流
  }
}

/** ★ 三十轮（用户要求，口径修正）：扫描防守的「持续更新」= **总窗口 = 思考时间 3~4×**
 *  （defWinUntil），窗口内一整轮（启发式 + 精修演算流）收尾就**立刻**接下一轮 —— 节奏随
 *  计算快慢有密有疏，像边思考边把草稿打上盘面；窗口一到（或精修收敛）→ 定格最稳结论。
 *  在途轮没收尾（busy / defRefining）→ 只短喘息等它，绝不中途掐死引擎搜索。
 *  停表时机：清除标记 / 重开 / 载入 / 定局（五连或活四）/ 用户喊停。 */
function defendScheduleNext(ms) {
  if (G.ana.defTimer) clearTimeout(G.ana.defTimer);
  G.ana.defTimer = setTimeout(defendTick, ms == null ? streamGapMs() : ms);
}
function defendTick() {
  G.ana.defTimer = null;
  if (!G.ana.autoDefend || RV_MODE || G.review || S.paused) return;
  if (G.over || boardDecided()) return;                    // 定局 → 停止复扫（标注另行撤除）
  if (G.ana.busy || G.ana.defRefining) { defendScheduleNext(); return; }   // 在途轮收尾再续
  if (Date.now() >= G.ana.defWinUntil) return;             // 窗口关 → 定格收敛结果
  try { anaDefend(); } catch (e) { defendScheduleNext(); }
}

// ---------------------------------------------------------------- VCF / VCT 算杀器（2026-09-22，用户要求）
// ★ 背景（用户反馈：残局题里的复杂 VCF / VCT 前瞻会算错）+ 调研结论：
//   · Rapfi（上游 C++）：VCF 作为 AB 搜索叶节点的静态延伸（类 quiescence），走法生成器
//     自带 VCF/VCT 类型过滤，但**不对外输出必胜序列** —— 逐手问引擎的残局题会漏解；
//   · Katagomo（KataGo → 五子棋移植）：MCTS + 神经网络，无显式算杀器，靠搜索深度硬扛；
//   · 开源通行做法（Alpha-Cerberus、xeblog 算杀、Gomocup 各引擎）：**威胁空间搜索** ——
//     VCF = 进攻方只走冲四（防守方每手被迫堵唯一应点，一直逼到成五）；
//     VCT = 冲四 + 活三（防守方多了「反四」这个选项），极小极大 + 迭代加深 + 候选排序。
//   ⇒ 本地实现纯 JS 算杀器接到「前瞻」：先算杀、命中必胜序列就直接按序列推演，
//     未命中再走引擎逐手推演的老路。窗口判定天然覆盖缺口四（XX_XX）这类棋形。
// ★ 二轮（用户要求）：「科学增加预算和并行速度，保证相当高的智力和准度」——
//   · **迭代加深**：VCF/VCT 都从浅到深逐档搜（先给最短必胜链，浅层先命中 = 更准更短）；
//   · **Web Worker 并行**：1 个工人跑 VCF 全树 + (n-1) 个工人把 VCT 根候选按模分片
//     同时搜（n = 硬件线程，2~4）；每个工人独立满预算，总算力 ≈ n 倍；
//     任何工人先出解即采纳（VCF 与 VCT 谁先算出来都算数），8s 硬超时兜底；
//   · Worker 不可用（异常环境）→ 自动回落单线程同步 vcxSolve（同一套函数
//     Function.prototype.toString 注入 blob；发布加密链路不影响 —— 运行时已是解密明文）。
//   · 棋理口径：与 fwdRun 同为无禁手口径（findWinLine(b,0)，≥5 即胜）；
//     连珠规则（rule=2）下黑方有禁手而本地不做禁手判定 → 只替白方算杀，
//     黑方回落引擎老路（宁可不算，不给非法序列）。

var VCX_BUDGET = 600000;              // 每个工人的 analyzePoint 预算（实测 ≈ 1s 内）
// ★ 七轮（用户要求「支持 100 手以上」）：深度上限大幅放宽 —— VCF 64 手冲四（整链 ≈ 129 手）、
//   VCT 32 手进攻（整链 ≈ 63 手）；实际多深仍受 VCX_BUDGET 预算与超时约束，浅解先命中先出。
var VCX_VCF_DEPTH = 64;               // VCF：进攻方最多连续冲四手数（迭代加深上限）
var VCX_VCT_DEPTH = 32;               // VCT：进攻方最多走子手数（迭代加深上限）
var VCX_VCT_ATK_MAX = 16;             // VCT 每个进攻节点最多尝试的「活三」候选手数（冲四候选不截断）
var VCX_WORKER_TIMEOUT = 8000;        // 并行算杀硬超时（ms）——前瞻自动档
var VCX_WORKER_DEEP = 30000;          // ★ 七轮：「查找VCF / 查找VCT」显式档 = 30s（长杀链）
var VCX_STEP_TIMEOUT = 2500;          // ★ 十轮：推演途中**每步回探**算杀的单次预算（安静局面毫秒级返回）。
                                      //   ★ 廿八轮：1500→2500（原生多线程下深杀链 1.5s 常探不到底）。
// ★★ 2026-09-24（用户再次强调「对齐 Rapfi 官方算法 + 适配有禁手/无禁手规则」）：
//   这面旗的含义从「**黑方**进攻时避禁手」扩成「**本局按连珠规则**（rule 2）—— 黑方
//   **任何一手**（进攻方也好、防守方也好）都要过禁手闸」。理由：
//     · Rapfi 的 renju 规则下 black forbidden 是**全局约束**，与「谁在进攻」无关；
//     · 旧口径只在「黑方进攻」时滤禁手 → 白方进攻、黑方防守时会把**黑方根本走不出来**的
//       禁手点当成有效应手写进解线（非法线）。
//   注意：**只对黑方生效**（白方在连珠下无禁手）—— 所有使用点都必须写 `VCX_FORBID && c === 1`。
var VCX_FORBID = false;               // ★ 连珠规则闸：黑方落子必须非禁手（rule 2 时为 true）
// ★★ 廿三轮（对齐 Rapfi 的 RULE）：算杀器内部的「成五」是**自由局口径**（某条 5 格窗被填满即胜）。
//   「标准」规则（rule 1）下长连不算赢 —— 该口径必须跟着规则走，否则会把一条 6 连长连
//   当成杀棋报给用户（与引擎/界面判定相反）。两个开关由 vcxSolve / vcxSolveAsync 用
//   exactFiveFor(rule, 色) 填（与主程序同一份规则表），Worker 侧随消息下发。
var VCX_EXACT_1 = false;              // 黑方要求「正好五子」（标准 = true；连珠 = true；自由 = false）
var VCX_EXACT_2 = false;              // 白方要求「正好五子」（标准 = true；连珠 = false）
var vcxUsed = 0;                      // 本次求解已消耗的预算

/** 落 (x,y) 为 c 后，扫 4 个方向所有含该点的 5 格窗口：
 *  · 全己方             → win（立刻成五）；
 *  · 4 己 + 1 空（本格算己方）→ 冲四威胁，空点 = 对方必须堵的应点；
 *  返回 { win, threats:[q...] }（q 编码 y*N+x，去重）。 */
function vcxAnalyze(b, x, y, c) {
  vcxUsed++;
  var threats = [], seen = {}, win = false;
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var d = 0; d < 4; d++) {
    var dx = DIR[d][0], dy = DIR[d][1];
    for (var k = -4; k <= 0; k++) {
      var x0 = x + dx * k, y0 = y + dy * k;
      var xe = x0 + dx * 4, ye = y0 + dy * 4;                    // 窗口两端都要钳住（反斜向防越界）
      if (x0 < 0 || y0 < 0 || xe < 0 || ye < 0 || x0 >= N || y0 >= N || xe >= N || ye >= N) continue;
      var nC = 1, dead = false;                                  // 本格落子后先记 1 颗己方
      var qs = [];
      for (var m = 0; m < 5; m++) {
        if (m === -k) continue;                                  // 跳过自己
        var cx = x0 + dx * m, cy = y0 + dy * m;
        var v = b[cy][cx];
        if (v === c) nC++;
        else if (v === 0) qs.push(cy * N + cx);
        else { dead = true; break; }
      }
      if (dead) continue;
      if (nC === 5) {
        // ★ 廿三轮：规则要求「正好五子」时，看这窗里的连续子数是不是真 5（≥6 = 长连 → 不是胜）
        if (c === 1 ? VCX_EXACT_1 : VCX_EXACT_2) {
          var rl = 1, s1, cxx, cyy;
          for (s1 = 1; s1 <= 5; s1++) { cxx = x + dx * s1; cyy = y + dy * s1; if (cxx < 0 || cyy < 0 || cxx >= N || cyy >= N || b[cyy][cxx] !== c) break; rl++; }
          for (s1 = 1; s1 <= 5; s1++) { cxx = x - dx * s1; cyy = y - dy * s1; if (cxx < 0 || cyy < 0 || cxx >= N || cyy >= N || b[cyy][cxx] !== c) break; rl++; }
          if (rl !== 5) continue;                                  // 长连 → 这一窗不算胜，继续找
        }
        win = true; return { win: true, threats: threats };
      }
      if (nC === 4 && qs.length === 1 && !seen[qs[0]]) { seen[qs[0]] = 1; threats.push(qs[0]); }
    }
  }
  return { win: win, threats: threats };
}

/** 防守方有没有「下一手直接成五」的点（早退：找到一个就返回 true）。 */
function vcxDefCanFive(b, def) {
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
    if (b[y][x]) continue;
    vcxUsed++;
    for (var d = 0; d < 4; d++) {
      var dx = DIR[d][0], dy = DIR[d][1];
      for (var k = -4; k <= 0; k++) {
        var x0 = x + dx * k, y0 = y + dy * k;
        var xe2 = x0 + dx * 4, ye2 = y0 + dy * 4;
        if (x0 < 0 || y0 < 0 || xe2 < 0 || ye2 < 0 || x0 >= N || y0 >= N || xe2 >= N || ye2 >= N) continue;
        var nC = 1, dead = false;
        for (var m = 0; m < 5; m++) {
          if (m === -k) continue;
          var v = b[y0 + dy * m][x0 + dx * m];
          if (v === def) nC++;
          else if (v !== 0) { dead = true; break; }
        }
        if (!dead && nC === 5) {
          // ★ 廿三轮：与 vcxAnalyze 同款 —— 规则要求「正好五子」时长连不算成五
          if (def === 1 ? VCX_EXACT_1 : VCX_EXACT_2) {
            var rl2 = 1, s2, cx2b, cy2b;
            for (s2 = 1; s2 <= 5; s2++) { cx2b = x + dx * s2; cy2b = y + dy * s2; if (cx2b < 0 || cy2b < 0 || cx2b >= N || cy2b >= N || b[cy2b][cx2b] !== def) break; rl2++; }
            for (s2 = 1; s2 <= 5; s2++) { cx2b = x - dx * s2; cy2b = y - dy * s2; if (cx2b < 0 || cy2b < 0 || cx2b >= N || cy2b >= N || b[cy2b][cx2b] !== def) break; rl2++; }
            if (rl2 !== 5) continue;
          }
          return true;
        }
      }
    }
  }
  return false;
}

/** 空点 (x,y) 是否「贴子」（切比雪夫距离 ≤2 内有子）—— 算杀候选点范围。 */
function vcxNearStone(b, x, y) {
  for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
    var nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < N && ny < N && b[ny][nx]) return true;
  }
  return false;
}

// ★ 七轮（用户要求「VCF、VCT 支持有禁手」）：连珠禁手本地判定（此前连珠+轮黑直接
//   不算杀 → 用户看到的「VCF/VCT 点了没反应」就是这里短路）。一级判定口径（训练器够用）：
//   · 长连（≥6）→ 禁；
//   · 正好成五 → 永远合法（五连必胜优先于一切禁手）；
//   · 同一手造 ≥2 个「四」（按方向去重，活四算一个四）→ 四四禁；
//   · 同一手造 ≥2 个「活三」（按方向去重）→ 三三禁；
//   · 四 + 活三同时 → 禁。
//   不做「活三只能靠禁手点成四」的递归禁手（RIF 全量规则），偏保守：个别假禁手点会
//   被跳过 —— 宁可少算一步杀，不给非法序列。

/** 落 q（已编码 y*N+x）为颜色 c 之后，该点上的**最长连续同色长度**（≥6 = 长连）。 */
function vcxRunLenAt(b, q, c) {
  c = c || 1;
  var x = q % N, y = (q / N) | 0, DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  b[y][x] = c;
  var best = 1;
  for (var d = 0; d < 4; d++) {
    var dx = DIR[d][0], dy = DIR[d][1], run = 1, s;
    for (s = 1; s <= 5; s++) { var cx = x + dx * s, cy = y + dy * s; if (cx < 0 || cy < 0 || cx >= N || cy >= N || b[cy][cx] !== c) break; run++; }
    for (s = 1; s <= 5; s++) { var cx2 = x - dx * s, cy2 = y - dy * s; if (cx2 < 0 || cy2 < 0 || cx2 >= N || cy2 >= N || b[cy2][cx2] !== c) break; run++; }
    if (run > best) best = run;
  }
  b[y][x] = 0;
  return best;
}

/** 黑方落 q 后是否形成长连（≥6）—— 连珠下这种「成五点」是假的（禁手堵不住也走不得）。 */
function vcxOverlineAt(b, q) { return vcxRunLenAt(b, q, 1) >= 6; }

/** ★★ 2026-09-24（用户要求「适配有禁手和无禁手的规则 / 有时会出现长连」）：
 *  落 q 为 c **是否真的按当前规则成五** —— 这是「威胁点」的最终判据。
 *  旧实现只看「某条 5 格窗被填满」，于是「一落下去其实是 6 连长连」的点也被当成成五点：
 *    · 自由局（rule 0）下长连算赢 → 恰好正确；
 *    · 但 **rule 1（标准 / 长连不算赢）与 rule 2 的白方**下长连**不算赢** →
 *      旧代码会把一个并不会赢的点当成杀着写进 VCF/VCT 解线（= 用户看到的「有时出现长连」）。
 *  这里统一按 exactFiveFor 的语义判定：要么自由局口径（≥5 即胜），要么必须**正好 5 连**。 */
function vcxFiveReal(b, q, c) {
  var x = q % N, y = (q / N) | 0;
  if (x < 0 || y < 0 || x >= N || y >= N || b[y][x]) return false;
  var need = (c === 1) ? VCX_EXACT_1 : VCX_EXACT_2;
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  b[y][x] = c;
  var hit = false;
  for (var d = 0; d < 4 && !hit; d++) {
    var dx = DIR[d][0], dy = DIR[d][1];
    for (var k = -4; k <= 0; k++) {
      var x0 = x + dx * k, y0 = y + dy * k, xe = x0 + dx * 4, ye = y0 + dy * 4;
      if (x0 < 0 || y0 < 0 || xe < 0 || ye < 0 || x0 >= N || y0 >= N || xe >= N || ye >= N) continue;
      var full = true;
      for (var m = 0; m < 5; m++) if (b[y0 + dy * m][x0 + dx * m] !== c) { full = false; break; }
      if (full) { hit = true; break; }
    }
  }
  b[y][x] = 0;
  if (!hit) return false;
  if (!need) return true;                                  // 自由局：≥5 即胜
  return vcxRunLenAt(b, q, c) === 5;                       // 长连不赢的规则：必须正好 5 连
}

/** 威胁点过滤（**按规则与颜色**判，不再是「只在连珠黑方进攻时过滤」）：
 *  一个「4 己 + 1 空」的窗被填满**不等于**取胜 —— 落下去是长连而规则又要求正好五子时，
 *  这个点根本不是威胁（对方不用堵、攻方也不该走）。同时，连珠规则下**黑方**的禁手点
 *  同样不能作威胁点（是非法着法）。
 *  ★★ 关键：威胁点是「**落完本手 (ax,ay) 之后**」才成立的 —— 判定时必须把本手先摆上去
 *  （`vcxAnalyze` 内部就是这么算的），否则 `vcxFiveReal` 看到的窗永远差一颗子、
 *  会把**所有**威胁都误杀成 0 个。ax 省略 = 已经摆在盘上了（调用方自己摆好）。
 *  返回过滤后的 q 列表（自由局 + 无禁手 = 原样返回，零开销）。 */
function vcxRealThreats(b, arr, c, ax, ay) {
  c = c || 1;
  var need = (c === 1) ? VCX_EXACT_1 : VCX_EXACT_2;
  var forbid = VCX_FORBID && c === 1;
  if (!need && !forbid) return arr;                        // 自由局口径 + 无禁手 → 直接返回
  var anchored = (ax != null && ax >= 0);
  if (anchored) b[ay][ax] = c;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var q = arr[i];
    if (forbid && vcxForbidden(b, q % N, (q / N) | 0)) continue;   // 黑方禁手点不能作威胁
    if (vcxFiveReal(b, q, c)) out.push(q);
  }
  if (anchored) b[ay][ax] = 0;
  return out;
}

/** 连珠禁手判定（仅黑方）：空点 (x,y) 落黑是否违规。
 *  ★★ 2026-09-25（用户要求「完全按照 gomocalc 官方」）：gomocalc 的红叉**不是前端算的**，
 *   而是 Rapfi 引擎经 `YXSHOWFORBID` → `Board::checkForbiddenPoint`（game/board.cpp）
 *   直接下发 FORBID 列表。本组函数 = 该算法的逐行 JS 移植（另有 tools 对拍脚本直接
 *   对着引擎逐点比对）：
 *     ① 单方向档位 vcxLinePat（= pattern.cpp getPattern 动态规划）：realLen≥6 → OL（长连）；
 *        =5 → F5（成五）；span 内空点逐一试落递归：≥2 个 F5 点 → F4（活四，RENJU 黑特判
 *        两个 F5 点相距 <5 = 一线双四 → OL）；=1 → 堵住后线上仍 ≥B3 → B4S，否则 B4；
 *        ≥2 个 F4 点 → F3S（跳活三）；=1 → F3；往下 B3S/B3/F2B/F2A/F2/B2/F1/B1/DEAD。
 *     ② 融合档位 vcxFused4（= getPattern4<Forbid>）：任方向 F5 → 合法；OL → 禁；
 *        四(B4/B4S/F4) ≥2 → 禁；活三(F3/F3S) ≥2 → 禁候选。
 *     ③ 双三递归复核（= checkForbiddenPoint 后半）：候选禁手里只有「双三」可能是假阳性
 *        （某三的成四点若本身是禁手，该三不算）—— 摆上本手后，对每个活三方向两侧跳过黑子
 *        找到的第一个空点试落：该点融合档为 B_FLEX4（能成活四/双冲四）或 F5 → 三成立；
 *        或「stage-1 FORBID 但递归复核非禁手且该方向为 F4」→ 三成立；两个方向成立 → 真禁手。
 *   禁手只有三类：长连 / 四四 / 三三；**四三完全合法**（RIF 9.2，gomocalc 同口径）。
 *   旧版一级判定（无递归假三消除）已废弃 —— 假禁手会多标红叉 + 白白剔掉 VCF/VCT 杀点。 */
// Pattern 枚举数值照抄 Rapfi core/types.h（`>= B3` 的枚举序比较依赖这个顺序）。
var VCX_PAT_DEAD = 0, VCX_PAT_OL = 1, VCX_PAT_B1 = 2, VCX_PAT_F1 = 3, VCX_PAT_B2 = 4,
    VCX_PAT_F2 = 5, VCX_PAT_F2A = 6, VCX_PAT_F2B = 7, VCX_PAT_B3 = 8, VCX_PAT_B3S = 9,
    VCX_PAT_F3 = 10, VCX_PAT_F3S = 11, VCX_PAT_B4 = 12, VCX_PAT_B4S = 13, VCX_PAT_F4 = 14,
    VCX_PAT_F5 = 15;
// 融合档位只保留 checkForbiddenPoint 用得到的四档（数值随意，不参与枚举序比较）。
var VCX_P4_NONE = 0, VCX_P4_FORBID = 4, VCX_P4_FIVE = 5, VCX_P4_BFLEX4 = 13;
var VCX_PAT_MEMO = new Map();                        // 线串|中心 → 档位（跨调用累积缓存）

/** 取 (x,y) 方向 d 的**整条线**：{ a: 1黑/2白/0空 数组, m: 中心下标 }（线外 = 对方子）。 */
function vcxLineOf(b, x, y, d) {
  var a = [], k;
  if (d === 0) { for (k = 0; k < N; k++) a.push(b[y][k]); return { a: a, m: x }; }
  if (d === 1) { for (k = 0; k < N; k++) a.push(b[k][x]); return { a: a, m: y }; }
  if (d === 2) {                                     // 主对角 (1,1)
    var sx = x, sy = y;
    while (sx > 0 && sy > 0) { sx--; sy--; }
    while (sx < N && sy < N) { a.push(b[sy][sx]); sx++; sy++; }
    return { a: a, m: x - (sx - a.length) };
  }
  var tx = x, ty = y;                                // 反对角 (1,-1)
  while (tx > 0 && ty < N - 1) { tx--; ty++; }
  while (tx < N && ty >= 0) { a.push(b[ty][tx]); tx++; ty--; }
  return { a: a, m: x - (tx - a.length) };
}

/** Rapfi getPattern 的 JS 移植（CheckOverline 恒真 —— 只服务 RENJU 黑方禁手判定）。
 *  ★ Rapfi 的线不是整条 15 格线，而是**以被分类点为中心的 11 格窗（HalfLineLen=5，±5）**，
 *   且 DP 递归试落空点时 shiftLine 会把窗**平移到新中心**（窗外一律视为对方子/墙）——
 *   窗外 5 格外的子不可见（对拍实测：中心线上距 6 格的黑参与不了 f5 组合）。 */
var VCX_LINE_HALF = 5;                               // RENJU：HalfLineLen = 5 → 窗长 11

function vcxLinePat(line, m) {                       // 入口：line = 整条线，m = 中心下标
  var win = [];
  for (var j = -VCX_LINE_HALF; j <= VCX_LINE_HALF; j++) {
    var idx = m + j;
    win.push(idx >= 0 && idx < line.length ? line[idx] : 2);
  }
  return vcxLinePatWin(win);
}

function vcxLinePatWin(win) {                        // win 长度 11，中心恒在下标 5
  var key = win.join('');
  var hit = VCX_PAT_MEMO.get(key);
  if (hit !== undefined) return hit;
  var L = win.length, realLen = 1, fullLen = 1, inc = 1, start = 5, end = 5, i, j, p;
  for (i = 4; i >= 0; i--) {                         // ← countLine 左半（跳空后连续中断）
    if (win[i] === 1) { if (inc) realLen++; }
    else if (win[i] === 2) break;
    else inc = 0;
    fullLen++; start = i;
  }
  inc = 1;
  for (i = 6; i < L; i++) {                          // ← countLine 右半
    if (win[i] === 1) { if (inc) realLen++; }
    else if (win[i] === 2) break;
    else inc = 0;
    fullLen++; end = i;
  }
  if (realLen >= 6) p = VCX_PAT_OL;                  // 长连
  else if (realLen >= 5) p = VCX_PAT_F5;             // 成五
  else if (fullLen < 5) p = VCX_PAT_DEAD;            // 跨度不足 5：永无五望
  else {
    var cnt = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var f5a = -1, f5b = -1;
    for (i = start; i <= end; i++) {                 // span 内空点逐一试落（shiftLine 平移窗）
      if (win[i] !== 0) continue;
      win[i] = 1;
      var w2 = [];
      for (j = -VCX_LINE_HALF; j <= VCX_LINE_HALF; j++) {
        var t = i + j;
        w2.push(t >= 0 && t < L ? win[t] : 2);       // = shiftLine：窗随新中心平移
      }
      var sp = vcxLinePatWin(w2);
      win[i] = 0;
      if (sp === VCX_PAT_F5) { if (f5a < 0) f5a = i; else if (f5b < 0) f5b = i; }
      cnt[sp]++;
    }
    if (cnt[VCX_PAT_F5] >= 2) {
      p = VCX_PAT_F4;                                // 活四（≥2 个真成五点）
      if (f5b >= 0 && f5b - f5a < 5) p = VCX_PAT_OL; // RENJU 黑特判：一线双四 = 禁手型
    } else if (cnt[VCX_PAT_F5] === 1) {              // 唯一成五点：堵住再看线上还剩不剩四
      win[f5a] = 2;
      p = vcxLinePatWin(win) >= VCX_PAT_B3 ? VCX_PAT_B4S : VCX_PAT_B4;
      win[f5a] = 0;
    }
    else if (cnt[VCX_PAT_F4] >= 2) p = VCX_PAT_F3S;  // 两个成活四点 → 跳活三
    else if (cnt[VCX_PAT_F4]) p = VCX_PAT_F3;
    else if (cnt[VCX_PAT_B4S]) p = VCX_PAT_B3S;
    else if (cnt[VCX_PAT_B4]) p = VCX_PAT_B3;
    else if (cnt[VCX_PAT_F3S] + cnt[VCX_PAT_F3] >= 4) p = VCX_PAT_F2B;
    else if (cnt[VCX_PAT_F3S] + cnt[VCX_PAT_F3] >= 3) p = VCX_PAT_F2A;
    else if (cnt[VCX_PAT_F3S] + cnt[VCX_PAT_F3]) p = VCX_PAT_F2;
    else if (cnt[VCX_PAT_B3S] + cnt[VCX_PAT_B3]) p = VCX_PAT_B2;
    else if (cnt[VCX_PAT_F2B] + cnt[VCX_PAT_F2A] + cnt[VCX_PAT_F2]) p = VCX_PAT_F1;
    else if (cnt[VCX_PAT_B2]) p = VCX_PAT_B1;
    else p = VCX_PAT_DEAD;
  }
  VCX_PAT_MEMO.set(key, p);
  return p;
}

/** getPattern4<Forbid> 的融合分类（RENJU 黑方）。只保留 checkForbiddenPoint 问的档位。 */
function vcxFused4(pats) {
  var nF5 = 0, nOL = 0, nB4 = 0, nF4 = 0, nF3 = 0;
  for (var d = 0; d < 4; d++) {
    var p = pats[d];
    if (p === VCX_PAT_F5) nF5++;
    else if (p === VCX_PAT_OL) nOL++;
    else if (p === VCX_PAT_B4 || p === VCX_PAT_B4S) nB4++;
    else if (p === VCX_PAT_F4) nF4++;
    else if (p === VCX_PAT_F3 || p === VCX_PAT_F3S) nF3++;
  }
  if (nF5) return VCX_P4_FIVE;                       // A_FIVE（优先级最高，覆盖一切）
  if (nOL) return VCX_P4_FORBID;
  if (nB4 + nF4 >= 2) return VCX_P4_FORBID;          // 四四
  if (nF3 >= 2) return VCX_P4_FORBID;                // 三三（stage-1 候选，待复核）
  if (nF4) return VCX_P4_BFLEX4;                     // 过了禁手闸后 B_FLEX4 ⟺ n[F4]≥1
  return VCX_P4_NONE;
}

function vcxForbidden(b, x, y) {
  var VCXDIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  b[y][x] = 1;
  var pats = [];
  for (var d = 0; d < 4; d++) {
    var ln = vcxLineOf(b, x, y, d);
    pats.push(vcxLinePat(ln.a, ln.m));
  }
  b[y][x] = 0;
  var nF5 = 0, nOL = 0, fours = 0, threes = [];
  for (d = 0; d < 4; d++) {
    var p = pats[d];
    if (p === VCX_PAT_F5) nF5++;
    else if (p === VCX_PAT_OL) nOL++;
    else if (p >= VCX_PAT_B4) fours++;               // B4 / B4S / F4 —— stage-2 必真
    else if (p === VCX_PAT_F3 || p === VCX_PAT_F3S) threes.push(d);
  }
  if (nF5) return false;                             // A_FIVE：成五合法（先于一切禁手）
  if (nOL) return true;                              // 长连：必真
  if (fours >= 2) return true;                       // 双四：必真
  if (threes.length < 2) return false;               // stage-1 不够格 → 一定合法
  // —— 双三递归复核（board.cpp checkForbiddenPoint 后半，MaxFindDist = 4）——
  var win3 = 0;
  b[y][x] = 1;
  for (var t = 0; t < threes.length && win3 < 2; t++) {
    var dd = threes[t], dx = VCXDIR[dd][0], dy = VCXDIR[dd][1];
    for (var sg = -1; sg <= 1; sg += 2) {            // 先负向、再正向（照 C++ 顺序）
      var hit = false;
      for (var k = 1; k <= 4; k++) {
        var px = x + dx * k * sg, py = y + dy * k * sg;
        if (px < 0 || py < 0 || px >= N || py >= N) break;
        var v = b[py][px];
        if (v === 2) break;                          // 对方子 → 停（墙 = 数组端点外，同停）
        if (v === 0) {                               // 两侧各自第一个空点：试落
          b[py][px] = 1;
          var ln2 = vcxLineOf(b, px, py, dd);
          var pd = vcxLinePat(ln2.a, ln2.m);
          var patsE = [];
          for (var q = 0; q < 4; q++) {
            var le = vcxLineOf(b, px, py, q);
            patsE.push(vcxLinePat(le.a, le.m));
          }
          var f4 = vcxFused4(patsE);
          var ok = f4 === VCX_P4_BFLEX4 || pd === VCX_PAT_F5;
          if (!ok && f4 === VCX_P4_FORBID && pd === VCX_PAT_F4) {
            b[py][px] = 0;                           // 还原后递归（= C++ ScopedMove 语义）
            ok = !vcxForbidden(b, px, py);
            b[py][px] = 1;
          }
          b[py][px] = 0;
          hit = ok;
          break;                                     // 空点只查第一个（照 C++）
        }
        // 黑子 → 继续外扩
      }
      if (hit) { win3++; break; }                    // = C++ goto next_direction
    }
  }
  b[y][x] = 0;
  return win3 >= 2;
}

/** VCF 单个候选手的处理：落子 → 对方反五检查 → 递归。返回 [冲四手, 逼堵手, ...后续] 或 null。 */
function vcxVcfTry(b, mv, atk, dLeft) {
  var def = 3 - atk, line = null;
  b[mv.y][mv.x] = atk;
  if (!vcxDefCanFive(b, def)) {                                // 对方下一手能成五 → 这手白下
    if (mv.live) {                                             // 活四/双四：对方堵一头，另一头成五
      var q0 = mv.threats[0], q1 = mv.threats[1];
      // ★ 2026-09-24：防守方是连珠黑方时，堵点若是禁手则他**堵不了** —— 把写在解线里的
      //   那一手换成另一个成五点（攻方仍在空出来的那头成五），线照样合法且必胜。
      //   两个堵点都是黑方禁手 → 无法写出合法的防守手 ⇒ 保守判本手失败。
      if (VCX_FORBID && def === 1) {
        var f0 = vcxForbidden(b, q0 % N, (q0 / N) | 0), f1 = vcxForbidden(b, q1 % N, (q1 / N) | 0);
        if (f0 && f1) { b[mv.y][mv.x] = 0; return null; }
        if (f0) { var tq = q0; q0 = q1; q1 = tq; }
      }
      line = [{ x: mv.x, y: mv.y, c: atk },
              { x: q0 % N, y: (q0 / N) | 0, c: def },
              { x: q1 % N, y: (q1 / N) | 0, c: atk }];
    } else {
      // ★ 五轮修复（用户报「黑白叠一块」根因）：递归前必须把防守的逼堵子**真落到临时盘**
      //   —— 此前漏放，递归在堵点还空着的盘上搜 → 攻方直接在堵点「成五」→
      //   序列末端变成「白堵 q + 黑也走 q」同格两子叠一块，而且整条「必胜」是假的。
      var qx = mv.q % N, qy = (mv.q / N) | 0;
      // ★ 2026-09-24：唯一堵点是黑方禁手 → 黑方堵不了（他只能走别的，随后攻方在此成五）。
      //   本可判「攻方胜」，但那要求枚举黑方全部替代着法；这里先按**保守**处理（判本手失败），
      //   绝不产出「黑方落在禁手点」的非法线。
      if (VCX_FORBID && def === 1 && vcxForbidden(b, qx, qy)) { b[mv.y][mv.x] = 0; return null; }
      b[qy][qx] = def;
      var sub = vcxVcfLoop(b, atk, dLeft - 1, 0, 1);
      b[qy][qx] = 0;
      if (sub) line = [{ x: mv.x, y: mv.y, c: atk },
                       { x: qx, y: qy, c: def }].concat(sub);
    }
  }
  b[mv.y][mv.x] = 0;
  return line;
}

/** VCF 主循环（skip/mod 供并行分片用）。活四/双四只是「优先试的候选」——若对方下一手能
 *  反五，这一手作废但别的冲四仍可能成功（顺手堵住对方成五点的冲四），不能整树放弃。 */
function vcxVcfLoop(b, atk, dLeft, skip, mod) {
  if (dLeft <= 0 || vcxUsed > VCX_BUDGET) return null;
  var cands = [], liveFour = null;
  for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
    if (b[y][x] || !vcxNearStone(b, x, y)) continue;
    if (VCX_FORBID && atk === 1 && vcxForbidden(b, x, y)) continue;   // ★ 连珠下黑方禁手点不能作进攻点（白方不受限）
    var a = vcxAnalyze(b, x, y, atk);
    if (a.win) return [{ x: x, y: y, c: atk }];
    var th = vcxRealThreats(b, a.threats, atk, x, y);            // ★ 按规则过滤「长连假成五点」+ 黑方禁手点
    if (th.length >= 2) { if (!liveFour) liveFour = { live: true, x: x, y: y, threats: th }; }
    else if (th.length === 1) cands.push({ live: false, x: x, y: y, q: th[0] });
  }
  var tries = [];
  if (liveFour) tries.push(liveFour);
  for (var i = 0; i < cands.length; i++) tries.push(cands[i]);
  for (var t = (skip || 0); t < tries.length; t += (mod || 1)) {
    var line = vcxVcfTry(b, tries[t], atk, dLeft);
    if (line) return line;
    if (vcxUsed > VCX_BUDGET) return null;
  }
  return null;
}

/** VCT 的进攻方候选：冲四点 + 活三点（活三 = 落子后存在某空点能成「活四」，即 threats≥2）。
 *  返回按优先级排序的候选数组（成五 > 活四 > 冲四 > 活三），最多 atkMax 个。 */
function vcxVctCands(b, atk, atkMax) {
  var fours = [], threes = [];
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
    if (b[y][x] || !vcxNearStone(b, x, y)) continue;
    if (VCX_FORBID && atk === 1 && vcxForbidden(b, x, y)) continue;   // ★ 连珠下黑方禁手点不能作进攻点（白方不受限）
    var a = vcxAnalyze(b, x, y, atk);
    if (a.win) return [{ x: x, y: y, w: 3, threats: [] }];
    var th = vcxRealThreats(b, a.threats, atk, x, y);            // ★ 按规则过滤「长连假成五点」+ 黑方禁手点
    if (th.length >= 2) fours.unshift({ x: x, y: y, w: 2, threats: th });   // 活四排最前
    else if (th.length === 1) fours.push({ x: x, y: y, w: 1, threats: th });
    else {                                                       // 活三探测：落 p 后，p 沿 4 向 ±4 内
      var live = false;                                          // 的空点里存在「能成活四（threats≥2）」的点
      b[y][x] = atk;
      for (var d = 0; d < 4 && !live; d++)
        for (var k = -4; k <= 4 && !live; k++) {
          if (k === 0) continue;
          var qx = x + DIR[d][0] * k, qy = y + DIR[d][1] * k;
          if (qx < 0 || qy < 0 || qx >= N || qy >= N || b[qy][qx]) continue;
          var a3 = vcxAnalyze(b, qx, qy, atk);
          if (vcxRealThreats(b, a3.threats, atk, qx, qy).length >= 2) live = true;
        }
      b[y][x] = 0;
      if (live) threes.push({ x: x, y: y, w: 0, threats: [] });
    }
  }
  // ★ 十二轮：**冲四候选一个都不许丢**（冲四是 VCF/VCT 的骨干，丢了就是「假无解」）；
  //   只对较弱的「活三」候选按 atkMax 截断（活三多而弱，截断只损完备性、不损正确性）。
  return fours.concat(threes.slice(0, atkMax));
}

/** VCT 单个候选手的处理（活三分支：防守方可堵可反四，所有应手都输才算赢）。 */
function vcxVctTry(b, mv, atk, dLeft) {
  var def = 3 - atk, line = null;
  if (mv.w === 3) return [{ x: mv.x, y: mv.y, c: atk }];         // 直接成五
  b[mv.y][mv.x] = atk;
  if (mv.w === 2) {                                              // 活四：对方堵一头，另一头成五
    if (!vcxDefCanFive(b, def)) {
      var q0 = mv.threats[0], q1 = mv.threats[1];
      // ★ 2026-09-24：与 vcxVcfTry 同款 —— 黑方防守方的堵点若是禁手就换个合法的写进线里
      if (VCX_FORBID && def === 1) {
        var g0 = vcxForbidden(b, q0 % N, (q0 / N) | 0), g1 = vcxForbidden(b, q1 % N, (q1 / N) | 0);
        if (g0 && g1) { b[mv.y][mv.x] = 0; return null; }
        if (g0) { var tq2 = q0; q0 = q1; q1 = tq2; }
      }
      line = [{ x: mv.x, y: mv.y, c: atk },
              { x: q0 % N, y: (q0 / N) | 0, c: def },
              { x: q1 % N, y: (q1 / N) | 0, c: atk }];
    }
  } else if (mv.w === 1) {                                       // 冲四：防守被迫堵（对方反五则此路死）
    if (!vcxDefCanFive(b, def)) {
      var qx = mv.threats[0] % N, qy = (mv.threats[0] / N) | 0;
      // ★ 2026-09-24：唯一堵点是黑方禁手 → 保守判本手失败（不写非法应手）
      if (VCX_FORBID && def === 1 && vcxForbidden(b, qx, qy)) { b[mv.y][mv.x] = 0; return null; }
      b[qy][qx] = def;
      var sub = vcxVctLoop(b, atk, dLeft - 1, 0, 1);
      b[qy][qx] = 0;
      if (sub) line = [{ x: mv.x, y: mv.y, c: atk }, { x: qx, y: qy, c: def }].concat(sub);
    }
  } else {                                                       // 活三：防守方堵点 / 反四；能反五则此路死
    if (!vcxDefCanFive(b, def)) {
      var replies = vcxDefReplies(b, mv.x, mv.y, atk);
      var allLose = replies.length > 0, best = null;
      for (var r = 0; r < replies.length; r++) {
        var rp = replies[r];
        b[rp.y][rp.x] = def;
        var sub2 = vcxVctLoop(b, atk, dLeft - 1, 0, 1);
        b[rp.y][rp.x] = 0;
        if (!sub2) { allLose = false; break; }                   // 防守有活路 → 这手活三失败
        if (!best) best = { rp: rp, sub: sub2 };
        if (vcxUsed > VCX_BUDGET) break;
      }
      if (allLose && best)
        line = [{ x: mv.x, y: mv.y, c: atk },
                { x: best.rp.x, y: best.rp.y, c: def }].concat(best.sub);
    }
  }
  b[mv.y][mv.x] = 0;
  return line;
}

/** VCT 主循环（skip/mod 供并行分片用）。 */
function vcxVctLoop(b, atk, dLeft, skip, mod) {
  if (dLeft <= 0 || vcxUsed > VCX_BUDGET) return null;
  var cands = vcxVctCands(b, atk, VCX_VCT_ATK_MAX);
  for (var i = (skip || 0); i < cands.length; i += (mod || 1)) {
    if (vcxUsed > VCX_BUDGET) return null;
    var line = vcxVctTry(b, cands[i], atk, dLeft);
    if (line) return line;
  }
  return null;
}

/** 活三/冲四后防守方的**完整最小**应手集合（★ 十二轮按标准威胁空间搜索重写）。
 *  · 旧版：以攻击点为心 ±4 的所有空点，排序后**截断到 10 个** —— 截断会把真正的防守资源
 *    切掉 → 防守被稻草人化 → **假必胜**（旧注释里的血泪教训）；
 *  · 标准口径：防守方只有两类应手有意义，其余任何点都挡不住攻方下一手活四：
 *      ① 必堵点：攻方落这里能成活四（threats ≥ 2）或直接成五 —— 不堵就死；
 *      ② 反四点：防守方落这里造出自己的「四」（threats ≥ 1）—— 攻方必须回防。
 *    这两类之外的点必然是输着 ⇒ 集合天然又小又完备，**不需要截断**（既不假胜也不漏防）。 */
function vcxDefReplies(b, px, py, atk) {
  var def = 3 - atk, set = {}, list = [];
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var d = 0; d < 4; d++)
    for (var k = -4; k <= 4; k++) {
      if (k === 0) continue;
      var nx = px + DIR[d][0] * k, ny = py + DIR[d][1] * k;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || b[ny][nx]) continue;
      var key = ny * N + nx;
      if (set[key]) continue;
      set[key] = 1;
      var aA = vcxAnalyze(b, nx, ny, atk);                                  // 攻方落这里会怎样
      var mustBlock = aA.win || vcxRealThreats(b, aA.threats, atk, nx, ny).length >= 2;  // ① 必堵
      var counter = false;
      if (!mustBlock) {                                                     // ② 反四（只在非必堵时才需要算）
        var aD = vcxAnalyze(b, nx, ny, def);
        counter = aD.win || vcxRealThreats(b, aD.threats, def, nx, ny).length >= 1;
      }
      if (!mustBlock && !counter) continue;                                 // 挡不住活四 → 不必考虑
      // ★★ 2026-09-24（适配有禁手规则）：**防守方是黑方**（白方进攻）时，黑方的禁手点
      //   是**走不出来**的着法 —— 不能当成有效应手写进解线（旧版会把这种非法应手当防守）。
      //   过滤掉即可：若过滤后集合为空，调用方按「无解」处理（保守，绝不产出非法线）。
      if (VCX_FORBID && def === 1 && vcxForbidden(b, nx, ny)) continue;
      list.push({ x: nx, y: ny, w: counter ? 0 : 1, d: Math.max(Math.abs(nx - px), Math.abs(ny - py)) });
    }
  list.sort(function (a, c) { return (a.w - c.w) || (a.d - c.d); });
  return list;                                                              // ★ 不截断：集合本身已是最小必要集
}

/** 攻方的**被迫应手**说明（★ 十二轮，留档：**不要**为此加专门的搜索分支）。
 *  防守方上一手若造出「下一手成五」的威胁，攻方只有一条活路：去占那个成五点。
 *  · 若这一手**同时是冲四**（占点后自己成四）—— 它本来就在攻方的候选里（`vcxAnalyze` 的
 *    threats≥1），`vcxVcfTry`/`vcxVctTry` 的 `vcxDefCanFive` 闸门会自动放行它、堵掉别的候选；
 *    「回防 + 继续连冲」这条线**不需要任何额外代码**就已经算得到。
 *  · 若这一手**不成四** —— 攻方回防后防守方就拿到自由手，连续威胁链**真的断了**，返回 null 是对的。
 *  ⇒ 2026-09-22 十二轮曾在这里加过一个「先落回防手、再递归」的分支，结果产出的序列**颜色不交替**
 *    （攻方连走两手）＝非法线。行为探针（tools/_tmp_vcx_probe.js 的逐手复演）当场抓住，
 *    已整段回退。**别再加回来**：让候选扫描 + 闸门去做这件事。 */

/** 迭代加深包装：从 d0 到 dMax 逐档搜，返回最短必胜序列（浅层先命中 = 更准也更短）。 */
function vcxId(loopFn, b, atk, d0, dMax) {
  for (var d = d0; d <= dMax; d++) {
    var line = loopFn(b, atk, d, 0, 1);
    if (line) return line;
    if (vcxUsed > VCX_BUDGET) return null;
  }
  return null;
}

/** ★★ 2026-09-24（对齐 Rapfi：**只交付逐手复演成立的解**）：把算杀器给出的线在盘上
 *  复演一遍，任何一条不满足就判「无解」。这是防「长连算什么赢 / 黑方落在禁手点 /
 *  颜色不交替」这类口径错漏的最后一道闸 —— 与其交付一条假的必胜线，不如老实说没找到。
 *  判据：
 *    ① 颜色严格交替，且第一手是进攻方（= Rapfi 的威胁空间搜索前提）；
 *    ② 每一手都落在**空点**（不叠子）；
 *    ③ 连珠规则下**黑方每一手都不是禁手**（攻防双方都算）；
 *    ④ 末手是进攻方，且按本题规则**真的成五**（长连不算赢的规则下 6 连 = 不算）。
 *  入参口径显式化（renju/ex1/ex2）—— 主线程与 Worker 各自有一份 VCX_* 常量，直接透传即可，
 *  避免 Worker 里为了取规则再算一遍 exactFiveFor。 */
function vcxAudit(b0, line, renju, ex1, ex2, atk) {
  if (!line || !line.length) return false;
  var tb = b0.map(function (row) { return row.slice(); });
  var expect = atk;
  for (var i = 0; i < line.length; i++) {
    var m = line[i];
    if (!m || m.x < 0 || m.y < 0 || m.x >= N || m.y >= N) return false;
    if (m.c !== expect) return false;                     // ① 颜色必须交替
    if (tb[m.y][m.x] !== 0) return false;                 // ② 不许叠子
    if (renju && m.c === 1 && vcxForbidden(tb, m.x, m.y)) return false;   // ③ 黑方禁手
    tb[m.y][m.x] = m.c;
    expect = 3 - expect;
  }
  var last = line[line.length - 1];
  if (last.c !== atk) return false;
  // ④ 末手成五（按规则）—— 这里末手已经落在 tb 上，直接扫含它的 5 格窗
  var need = (last.c === 1) ? ex1 : ex2;
  var DIR = [[1, 0], [0, 1], [1, 1], [1, -1]], hit = false;
  for (var d = 0; d < 4 && !hit; d++) {
    var dx = DIR[d][0], dy = DIR[d][1];
    for (var k = -4; k <= 0; k++) {
      var x0 = last.x + dx * k, y0 = last.y + dy * k, xe = x0 + dx * 4, ye = y0 + dy * 4;
      if (x0 < 0 || y0 < 0 || xe < 0 || ye < 0 || x0 >= N || y0 >= N || xe >= N || ye >= N) continue;
      var full = true;
      for (var m2 = 0; m2 < 5; m2++) if (tb[y0 + dy * m2][x0 + dx * m2] !== last.c) { full = false; break; }
      if (full) { hit = true; break; }
    }
  }
  if (!hit) return false;
  if (need) {                                             // 长连不赢的规则：必须正好 5 连
    var best = 1;
    for (var d2 = 0; d2 < 4; d2++) {
      var rx = DIR[d2][0], ry = DIR[d2][1], r0 = 1, s2;
      for (s2 = 1; s2 < N; s2++) { var ax = last.x + rx * s2, ay = last.y + ry * s2; if (ax < 0 || ay < 0 || ax >= N || ay >= N || tb[ay][ax] !== last.c) break; r0++; }
      for (s2 = 1; s2 < N; s2++) { var bx = last.x - rx * s2, by = last.y - ry * s2; if (bx < 0 || by < 0 || bx >= N || by >= N || tb[by][bx] !== last.c) break; r0++; }
      if (r0 > best) best = r0;
    }
    if (best !== 5) return false;
  }
  return true;
}

/** 同步入口（Worker 不可用时兜底）：进攻方 = atkSel（★ 七轮：黑框/白框点选），
 *  不选则由子数奇偶决定（与 fwdRun 同口径）。返回 { kind:'VCF'|'VCT', line:[...] } 或 null。
 *  ★ 七轮：连珠（rule=2）黑方进攻 → 全程避禁手（vcxForbidden），不再直接放弃算杀。
 *  ★★ 廿三轮（对齐 Rapfi 官方算法）：**算杀只在「轮进攻方行棋」的局面上有意义** ——
 *   VCF / VCT 是威胁空间搜索（只有进攻方逐手逼杀），根节点必须由进攻方执子；若指定了进攻方
 *   而此刻轮到的是对方，任何「必胜序列」都只能是「进攻方连走两手」的非法线
 *   （真机事故：F4 黑 → F2 黑 两连手，而 F4 已成四、本该轮到白方在 F2 必应）。
 *   ⇒ 这种问法一律 return null；调用侧本来也不该这么问（见 fwdRun 里回探的位置）。 */
function vcxSolve(b, rule, mode, atkSel) {
  mode = mode || 'auto';
  var total = 0;
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) if (b[i][j]) total++;
  if (total === 0) return null;
  var toMove = (total % 2 === 0) ? 1 : 2;                        // 黑先：偶数子 = 轮黑
  if (atkSel && atkSel !== toMove) return null;                  // ★ 廿三轮：不是进攻方的回合 → 不算
  var side = atkSel || toMove;
  var renju = (rule === 2);
  VCX_FORBID = (renju && side === 1);                            // ★ 七轮：连珠黑方有禁手闸
  VCX_EXACT_1 = exactFiveFor(rule, 1);                           // ★ 廿三轮：成五口径跟规则走
  VCX_EXACT_2 = exactFiveFor(rule, 2);
  vcxUsed = 0;
  if (mode !== 'vct') {                                          // 'auto' / 'vcf'
    var tmp = b.map(function (row) { return row.slice(); });
    var line = vcxId(vcxVcfLoop, tmp, side, 2, VCX_VCF_DEPTH);
    // ★★ 廿四轮：交付前**逐手复演**（对齐 Rapfi「只报可复演成立的杀」）——
    //   长连当赢 / 黑方落禁手点 / 颜色不交替 这类口径错漏一律拦在这里，判「无解」。
    if (line && line.length && vcxAudit(b, line, renju, VCX_EXACT_1, VCX_EXACT_2, side))
      return { kind: 'VCF', line: line };
  }
  if (mode !== 'vcf' && vcxUsed <= VCX_BUDGET) {                 // 'auto' / 'vct'
    var tmp2 = b.map(function (row) { return row.slice(); });
    var line2 = vcxId(vcxVctLoop, tmp2, side, 2, VCX_VCT_DEPTH);
    if (line2 && line2.length && vcxAudit(b, line2, renju, VCX_EXACT_1, VCX_EXACT_2, side))
      return { kind: 'VCT', line: line2 };
  }
  return null;
}

/** 并行入口（二轮，用户要求）：Worker 池 = 1 个 VCF 全树 + (n-1) 个 VCT 根候选模分片。
 *  返回 Promise<{kind,line}|null>；超时 / 全部工人无解 → resolve null（回落引擎推演）。 */
/** 并行入口：mode = 'auto'（VCF+VCT 一起，前瞻默认）/ 'vcf' / 'vct'（三轮用户要求：
 *  「查找VCF / 查找VCT」只跑指定类型，把全部工人让给这一种）。
 *  Worker 池：auto = 1 个 VCF 全树 + (n-1) 个 VCT 根候选模分片；
 *  vcf = 全部工人按根候选模分片跑 VCF；vct = 全部工人模分片跑 VCT。
 *  返回 Promise<{kind,line}|null>；8s 超时 / Worker 挂掉 → 回落同步 vcxSolve。 */
function vcxSolveAsync(b, rule, mode) {
  var atkSel = arguments.length > 3 ? arguments[3] : 0;   // ★ 七轮：黑框/白框指定进攻方（fwdFind 4 参调用）
  var tOutArg = arguments.length > 4 ? arguments[4] : 0;  // ★ 十轮：调用方指定超时（推演途中回探用 1.5s 短预算）
  mode = mode || 'auto';
  return new Promise(function (resolve) {
    var total = 0;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) if (b[i][j]) total++;
    if (total === 0) { resolve(null); return; }
    var toMove = (total % 2 === 0) ? 1 : 2;                      // 黑先：偶数子 = 轮黑
    // ★★ 廿三轮（对齐 Rapfi 官方算法）：算杀只在**进攻方行棋**的局面上有意义 ——
    //   指定了进攻方而此刻轮到对方（或对方正被将军式的必应）→ 直接判定「无解」，
    //   绝不产出一条「进攻方连走两手」的非法线（见 vcxSolve 同名说明）。
    if (atkSel && atkSel !== toMove) { resolve(null); return; }
    var side = atkSel || toMove;                                 // ★ 七轮：黑框/白框点选进攻方
    var rj = (rule === 2 && side === 1);                         // ★ 七轮：连珠黑方有禁手 → 全程避禁手
    VCX_FORBID = rj;
    var ex1 = exactFiveFor(rule, 1), ex2 = exactFiveFor(rule, 2);   // ★ 廿三轮：成五口径跟规则走
    VCX_EXACT_1 = ex1; VCX_EXACT_2 = ex2;
    var tOut = tOutArg || ((mode === 'auto') ? VCX_WORKER_TIMEOUT : VCX_WORKER_DEEP);   // ★ 十轮：可由调用方覆盖
    var nCore = Math.min(4, Math.max(2, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
    var src = 'var N=' + N + ',VCX_BUDGET=' + VCX_BUDGET + ',VCX_VCF_DEPTH=' + VCX_VCF_DEPTH +
              ',VCX_VCT_DEPTH=' + VCX_VCT_DEPTH + ',VCX_VCT_ATK_MAX=' + VCX_VCT_ATK_MAX +
              ',VCX_FORBID=' + (rj ? 'true' : 'false') +
              ',VCX_EXACT_1=' + (ex1 ? 'true' : 'false') +
              ',VCX_EXACT_2=' + (ex2 ? 'true' : 'false') +
              ',vcxUsed=0;\n' +
              // ★ 禁手判定（Rapfi checkForbiddenPoint 移植）依赖的全局常量与 memo ——
              //   vcxForbidden 在 Worker 里被 VCF/VCT 调用，缺一个就 ReferenceError 静默无解。
              'var VCX_PAT_DEAD=0,VCX_PAT_OL=1,VCX_PAT_B1=2,VCX_PAT_F1=3,VCX_PAT_B2=4,' +
              'VCX_PAT_F2=5,VCX_PAT_F2A=6,VCX_PAT_F2B=7,VCX_PAT_B3=8,VCX_PAT_B3S=9,' +
              'VCX_PAT_F3=10,VCX_PAT_F3S=11,VCX_PAT_B4=12,VCX_PAT_B4S=13,VCX_PAT_F4=14,' +
              'VCX_PAT_F5=15,VCX_P4_NONE=0,VCX_P4_FORBID=4,VCX_P4_FIVE=5,VCX_P4_BFLEX4=13,' +
              'VCX_PAT_MEMO=new Map();\n' +
              // ★★ 十二轮：**注入列表必须与算杀器函数集合严格同步** —— 少注入一个函数，
              //   Worker 里就会 ReferenceError → 被下面的 try/catch 吞掉 → 静默返回「无解」，
              //   表现为「点了 VCF/VCT 没反应」，极难排查。**加/删算杀器函数必同步这里。**
              // ★★ 廿四轮：注入列表 = 算杀器**全部**函数的超集（连精确成五口径 exactFiveFor
              //   一起注入，供 Worker 内 vcxAudit 复演校验用）。测试 tools/test-vcx-rules.js
              //   会静态核对「定义 ⊆ 注入」，禁止再漏。
              [vcxAnalyze, vcxDefCanFive, vcxNearStone, vcxOverlineAt, vcxRealThreats,
               vcxRunLenAt, vcxFiveReal, vcxAudit,
               vcxLineOf, vcxLinePat, vcxFused4, vcxForbidden, vcxVcfTry, vcxVcfLoop,
               vcxVctCands, vcxVctTry, vcxVctLoop, vcxDefReplies,
               exactFiveFor].map(function (f) { return f.toString(); }).join('\n') +
              '\n;onmessage=function(e){var d=e.data,atk=d.atk,vcxUsed=0;' +
              // b0 = 原始局面（复演校验用，绝不让搜索过程弄脏它）；b = 搜索用的可写副本。
              'var b0=d.board.map(function(r){return r.slice();});' +
              'var b=b0.map(function(r){return r.slice();});' +
              'VCX_FORBID=!!d.forbid;VCX_EXACT_1=!!d.ex1;VCX_EXACT_2=!!d.ex2;' +
              'var line=null;try{' +
              'if(d.task==="vcf"){for(var dd=2;dd<=' + VCX_VCF_DEPTH + ';dd++){line=vcxVcfLoop(b,atk,dd,d.skip,d.mod);if(line)break;}}' +
              'else{for(var dd2=2;dd2<=' + VCX_VCT_DEPTH + ';dd2++){line=vcxVctLoop(b,atk,dd2,d.skip,d.mod);if(line)break;}}' +
              '}catch(err){line=null;}' +
              // ★★ 廿四轮：Worker 侧同样过复演闸 —— 口径错漏的线宁可不报（主线程还会再校一次）。
              'if(line&&line.length&&!vcxAudit(b0,line,!!d.forbid,!!d.ex1,!!d.ex2,atk))line=null;' +
              'postMessage({task:d.task,line:line||null,used:vcxUsed});};';
    var workers = [], done = false, got = 0, expect = 0, fallenBack = false;
    function finish(res) {
      if (done) return;
      done = true;
      workers.forEach(function (w) { try { w.terminate(); } catch (e) {} });
      resolve(res);
    }
    var timer = setTimeout(function () { finish(null); }, tOut);   // ★ 七轮：auto 8s / 显式档 30s
    function settleOne() {
      got++;
      if (got >= expect && !done) { clearTimeout(timer); finish(null); }
    }
    try {
      var blob = new Blob([src], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      var tasks = [];
      if (mode !== 'vct') {
        if (mode === 'vcf') {                      // 只查 VCF：全部工人模分片
          for (var v = 0; v < nCore; v++) tasks.push({ task: 'vcf', skip: v, mod: nCore });
        } else {
          tasks.push({ task: 'vcf', skip: 0, mod: 1 });
        }
      }
      if (mode !== 'vcf') {                        // auto 用 nCore-1；只查 VCT 用满 nCore
        var nw = (mode === 'vct') ? nCore : nCore - 1;
        for (var w = 0; w < Math.max(1, nw); w++) tasks.push({ task: 'vct', skip: w, mod: Math.max(1, nw) });
      }
      expect = tasks.length;
      tasks.forEach(function (t) {
        var wk = new Worker(url);
        wk.onmessage = function (ev) {
          if (done) return;
          var r = ev.data;
          if (r && r.line && r.line.length) {
            clearTimeout(timer);
            finish({ kind: r.task.toUpperCase(), line: r.line });
            return;
          }
          settleOne();
        };
        wk.onerror = function () { settleOne(); };
        wk.postMessage({ task: t.task, skip: t.skip, mod: t.mod, atk: side,
                         forbid: rj,                                 // ★ 七轮：禁手闸随消息下发
                         ex1: ex1, ex2: ex2,                         // ★ 廿三轮：成五口径随消息下发
                         board: b.map(function (row) { return row.slice(); }) });
        workers.push(wk);
      });
    } catch (e) {
      if (fallenBack) return;
      fallenBack = true;
      clearTimeout(timer);
      finish(vcxSolve(b, rule, mode, atkSel));                     // Worker 不可用 → 同步兜底
    }
  });
}

// ---------------------------------------------------------------- 前瞻（五轮，用户要求）
/** ★ 五轮（用户要求）：前瞻 —— 「根据当前的残局直接自动推到最后五子连珠结束」。
 *  · 「前瞻」键点击一次变色（开启）→ 引擎在临时盘上逐手取最佳点，**绝不碰真盘**；
 *  · 推演出的未落之子画在棋盘上：半透明 + 边缘浅色渐变描边（见 paint 的 fwd 段）；
 *  · 框下代码链：黑子 = 紫框白字、白子 = 浅蓝框深字；悬浮某枚 = 预览到那手为止的局势；
 *    点击某枚 = **确定到那个局势**（真落上盘，终局/AI 照常接管，可继续改变）；
 *  · < > 箭头 = 在推演序列里逐手步进预览；
 *  · 局面一变（用户落子 / AI 落子）→ 旧推演作废，前瞻开着就自动重推（300ms 去抖）。 */
/** ★ 六轮语义：前瞻键三态 ——
 *  · 关 → 开：变色 + 从当前残局开始推演；
 *  · 开 且结果已被「确定」冻结（hold）→ **重新计算**（用户要求：不要重复算，
 *    等到用户再次点击前瞻，就重新计算）；
 *  · 开 且结果新鲜 → 关。 */
/** ★ 三轮（用户要求）：「查找VCF / 查找VCT」= 只跑本地算杀器、不逐手问引擎。
 *  命中 → 与前瞻同一套展示（半透明铺盘 + 代码链 + 确定落盘）；未命中 → 明确告知。
 *  kind = 'VCF' | 'VCT'。 */
/** ★ 四轮（用户要求）：「查找VCF / 查找VCT」点击后变**粉紫色** ——
 *  查找中 / 命中展示期间点亮对应键（G.fwd.kind = 'VCF'|'VCT'）；
 *  换普通前瞻 / 关前瞻 / 未命中时熄灭。 */
function fwdFindUi() {
  var k = G.fwd.kind || '';
  if (els.btn_fwd_vcf) els.btn_fwd_vcf.classList.toggle('find-on', k === 'VCF');
  if (els.btn_fwd_vct) els.btn_fwd_vct.classList.toggle('find-on', k === 'VCT');
}

/** ★ 十轮：**一次算杀探测** —— 「此刻轮到的一方能靠 X 规则杀棋吗」。
 *  kind = 'vcf' | 'vct' | 'auto'；budgetMs 由调用方给（开局分析给足、途中回探给短预算）。
 *  ★ 必须喂副本：算杀器内部会在盘上落子/回退（五轮「堵子真落盘」），绝不把真盘或推演盘借出去。 */
async function fwdTryVcx(b, kind, budgetMs) {
  var bb = b.map(function (row) { return row.slice(); });
  var k = (kind === 'auto') ? 'auto' : String(kind).toLowerCase();
  var r = await vcxSolveAsync(bb, engineRule(), k, G.fwd.atk, budgetMs);
  return (r && r.line && r.line.length) ? r : null;
}

/** ★ 十轮（用户要求「科学的虚线或者其他形状的辅助标记」）：给算杀段每一手算出**威胁类型**
 *  —— 连五(5) / 冲四(4) / 活三(3)，棋盘上按类型套不同虚线形状，一眼看出这条杀棋是怎么一步一步
 *  逼死对手的。b = **算杀段之前**的局面（本函数只在副本上落子，不动调用方的盘）。
 *  ★ 十二轮：防守应手也一并记成 t=0（极浅灰虚线小圈）—— 只画攻方的话「定式」是残缺的。
 *  返回 [{ i, x, y, c, t }]：i = 该手在整条推演线里的下标；t = 威胁等级（3/4/5），0 = 防守应手。 */
function fwdVcxMarks(b, line, startIdx) {
  var marks = [];
  if (!line || !line.length) return marks;
  var t = b.map(function (row) { return row.slice(); });
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  // ★ 十二轮：进攻方以**算杀序列第一手**的颜色为准（G.fwd.atk 可能是 0=自动）。
  var atk = (line[0] && line[0].c) || G.fwd.atk || 0;
  for (var i = 0; i < line.length; i++) {
    var m = line[i];
    if (m.y < 0 || m.y >= N || m.x < 0 || m.x >= N) continue;
    t[m.y][m.x] = m.c;
    if (atk && m.c !== atk) { marks.push({ i: startIdx + i, x: m.x, y: m.y, c: m.c, t: 0 }); continue; }
    var best = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1], run = 1;
      for (var s = 1; s < 6; s++) { var y1 = m.y + dy * s, x1 = m.x + dx * s; if (y1 < 0 || y1 >= N || x1 < 0 || x1 >= N || t[y1][x1] !== m.c) break; run++; }
      for (var s2 = 1; s2 < 6; s2++) { var y2 = m.y - dy * s2, x2 = m.x - dx * s2; if (y2 < 0 || y2 >= N || x2 < 0 || x2 >= N || t[y2][x2] !== m.c) break; run++; }
      if (run > best) best = run;
    }
    if (best < 3) continue;                        // 不成威胁的手不标（算杀链里不该有，保险）
    marks.push({ i: startIdx + i, x: m.x, y: m.y, c: m.c, t: Math.min(5, best) });
  }
  return marks;
}

/** ★ 十轮：把算杀段**并进同一条推演线**（统一入口）—— 落线、记起点、算威胁标记。
 *  b = 算杀段之前的局面；vcx = {kind,line}；from = 该段第一手在整条线里的下标。
 *  ★★ 廿二轮（用户要求「与今天 11 点相互结合」＋「连成 5 个子，堵一下，这个是有点错的」）：
 *   算杀线只保留到**连五那一手**为止 —— 五子已成、胜负已定，后面再接一手「防守方再堵一下」
 *   既没有意义，也不是 Rapfi 的语义（VCF/VCT 的解在成五那一步就结束了）。 */
function fwdAdoptVcx(b, vcx, from) {
  G.fwd.kind = vcx.kind;
  G.fwd.vcxAt = from;
  var bb = b.map(function (row) { return row.slice(); });
  var cut = vcx.line.length;
  for (var i = 0; i < vcx.line.length; i++) {
    var m = vcx.line[i];
    if (bb[m.y] && !bb[m.y][m.x]) bb[m.y][m.x] = m.c;
    if (winCheck(bb, m.x, m.y, m.c)) { cut = i + 1; break; }   // 这一手成五 → 线到此为止
  }
  var line = vcx.line.slice(0, cut);
  G.fwd.vcxMarks = fwdVcxMarks(b, line, from);
  for (var j = 0; j < line.length; j++) G.fwd.line.push(line[j]);
}

/** ★ 十轮（用户要求）：点「VCF / VCT」= **进入该算杀模式的连续推演**（不再是只查一手）：
 *  先用分析算出突破口（首次分析可能费点时间），然后引擎一路向前走，走到某一步这套规则
 *  真能接手就切进杀棋序列（蓝色虚线杀路 + 威胁虚线环），一直走到五连；
 *  全程没用到该规则却已经连五 → 状态行明说「已五子连珠，本次未用到 VCF / VCT」。 */
async function fwdFind(kind) {
  if (RV_MODE || G.review || G.over) return false;
  if (!G.fwd.on) {                     // 前瞻没开就先开（键变浅紫），共用展示链路
    G.fwd.on = true;
    if (els.btn_fwd) els.btn_fwd.classList.add('on');
  }
  G.fwd.wantVcx = true;
  G.fwd.want = kind;
  G.fwd.want2 = (kind === 'VCF') ? 'VCT' : 'VCF';
  G.fwd.kind = kind;                   // 键立刻亮粉紫：这个模式正在跑（fwdFindUi 认 kind）
  fwdFindUi();
  await fwdRun();
  return !!(G.fwd.line && G.fwd.line.length);
}

/** ★★ 十二轮（用户要求）：识图 VC 模式加载后**只做「准备」，绝不自动开算杀**。
 *  用户原话：「进入之后不要自动，让用户进行选择，无论是 VCF/VCT 都不自动，让用户自己进行选择」。
 *  所以这里只把**进攻方**预设成子数占优的一色（VCF/VCT 题面里子多的一边就是进攻方），
 *  再在状态行提示「点 VCF 或 VCT 开始」；真正开算必须由用户点那两个键（→ fwdFind）。 */
function visVcArm() {
  if (RV_MODE || G.review || G.over || G.fwd.busy) return;
  var nb = 0, nw = 0;
  for (var ai = 0; ai < N; ai++) for (var aj = 0; aj < N; aj++) {
    if (G.board[ai][aj] === 1) nb++; else if (G.board[ai][aj] === 2) nw++;
  }
  G.fwd.atk = (nb > nw) ? 1 : (nw > nb ? 2 : 0);
  fwdAtkUi();
  if (els.fwdMsg) els.fwdMsg.textContent = T('visVcArm');
}

/** ★ 七轮（用户要求）：算杀无解 → 弹窗提示（不能只靠状态行小字，一眼要看见）。
 *  文案：「当前局面，所选进攻方不存在VCF强制连续冲四杀棋」（VCT 同理）。 */
function vcxPopShow(text) {
  if (!els.vcxPop) return;
  if (els.vcxPopBody) els.vcxPopBody.textContent = text || '';
  els.vcxPop.hidden = false;
}

/** ★ 七轮（用户要求）：一键【清除杀棋标记】—— 擦掉 VCF/VCT 序号标注、虚线路线与代码链，
 *  回到原始局面；前瞻仍开着，可以立刻重新算。 */
function fwdClearMarks() {
  G.fwd.gen++;                             // 作废在途算杀（回调按 gen 闸丢弃）
  if (G.fwd.timer) { clearTimeout(G.fwd.timer); G.fwd.timer = 0; }
  fwdHoverCancel();
  G.fwd.busy = false; G.fwd.line = []; G.fwd.idx = -1; G.fwd.hover = -1;
  G.fwd.committed = -1; G.fwd.hold = false; G.fwd.sel = -1; G.fwd.kind = '';
  G.fwd.vcxAt = -1; G.fwd.vcxMarks = [];                     // ★ 十轮：算杀段标记一并擦掉
  fwdFindUi(); fwdOkUI();
  renderFwdSeq(); paint();
}

/** ★ 2026-09-25（用户要求）：「清除标记」键从「前瞻」框搬到「计算评估」卡、与「计算」
 *  并排之后，语义随之**泛化** —— 不再只管前瞻的杀棋标注，而是**一次擦掉计算评估里
 *  任何一个项目在棋盘上留下的标记**：
 *    · 前瞻 / VCF / VCT —— 半透明推演子、序号、虚线杀路、代码链（走 fwdClearMarks）；
 *    · 计算 / 多点分析 / 平衡一 / 平衡二 —— 名次徽标 + 评估分标签（G.ana.marks）；
 *    · 扫描防守 —— 百分比小字 + W/L 徽标（同样落在 G.ana.marks，标 plain/inline）。
 *  两块都靠 gen 代数闸作废在途结果，所以点完不会被「还没回来的旧算例」重新涂上盘。
 *  ⚠ 只清标记，**不动**局面本身，也不关「AI视图 / 指导视图」这两盏显示开关
 *    （它们是独立的显示开关，不是某次计算的产物）。 */
function clearAllMarks() {
  fwdClearMarks();                          // 前瞻 + 算杀：序号 / 虚线 / 代码链 / 推演子
  anaReset();                               // 计算评估：gen++ 作废在途 + marks/rows 全清 + 清单复位 + renderAna
  G.ana.defCells = null;                    // 扫描防守的合并底稿（精修轮还会读它）
  G.ana.autoDefend = false;                 // ★ 2026-09-26：清除标记 = 同时停掉扫描防守的动态重扫
  paint();
  toast(T('markCleared'));
}

function fwdAtkUi() {
  if (els.fwdLgB) els.fwdLgB.classList.toggle('sel', G.fwd.atk === 1);
  if (els.fwdLgW) els.fwdLgW.classList.toggle('sel', G.fwd.atk === 2);
}

function fwdToggle() {
  if (G.fwd.on) {
    if (G.fwd.hold) { G.fwd.hold = false; G.fwd.committed = -1; G.fwd.sel = -1; fwdRun(); return; }
    fwdOff(); return;
  }
  if (G.over) { toast(T('over')); return; }
  if (RV_MODE || G.review) return;
  // ★ 十轮：普通前瞻键 = 清掉算杀模式（要边走边算得点 VCF / VCT 键）
  G.fwd.wantVcx = false; G.fwd.want = ''; G.fwd.want2 = '';
  G.fwd.on = true;
  if (els.btn_fwd) els.btn_fwd.classList.add('on');   // 点击一次就变色
  fwdRun();
}
function fwdOff() {
  G.fwd.gen++;
  if (G.fwd.timer) { clearTimeout(G.fwd.timer); G.fwd.timer = 0; }
  fwdHoverCancel();
  G.fwd.on = false; G.fwd.line = []; G.fwd.idx = -1; G.fwd.hover = -1; G.fwd.busy = false;
  G.fwd.committed = -1; G.fwd.hold = false; G.fwd.sel = -1; G.fwd.kind = '';
  // ★ 十轮：关前瞻 = 退出算杀模式（下次开是普通前瞻，要算杀得再点 VCF / VCT 键）
  G.fwd.wantVcx = false; G.fwd.want = ''; G.fwd.want2 = '';
  G.fwd.vcxAt = -1; G.fwd.vcxMarks = [];
  fwdFindUi();                           // ★ 四轮：关前瞻 → 查找键粉紫一并熄灭
  if (els.btn_fwd) els.btn_fwd.classList.remove('on');
  fwdOkUI();
  renderFwdSeq(); paint();
}
/** 局面变了 → 前瞻开着就自动重推（place() 末尾会调这里；去抖防连击）。
 *  ★ 六轮：hold（确定过、结果冻结）期间一律不重推 —— 定时器回调也要认闸。 */
function fwdQueue() {
  if (!G.fwd.on || G.fwd.hold) return;
  if (G.fwd.timer) clearTimeout(G.fwd.timer);
  G.fwd.timer = setTimeout(function () {
    G.fwd.timer = 0;
    if (G.fwd.on && !G.fwd.hold && !G.over) fwdRun();
  }, 300);
}
/** 推演主循环：临时盘逐手问引擎最佳点，直到五连 / 手数上限 / 局面变更。
 *  ★ 六轮（用户要求）：前瞻走**专用 fwd 车道**（引擎里第三个独立 Rapfi 实例，与
 *    main/sub 互不排队）+ 每手预算翻倍（强单线）—— 推演的智力不再和热力图抢车道。 */
async function fwdRun() {
  if (RV_MODE || G.review || G.over) return;
  var gen = ++G.fwd.gen;
  if (G.fwd.timer) { clearTimeout(G.fwd.timer); G.fwd.timer = 0; }
  fwdHoverCancel();
  // ★ 十轮（用户要求）：前瞻 = **一条连续推演线**。算杀模式（wantVcx = 点了 VCF / VCT）下：
  //   ① 先用分析算出突破口（首次分析可能费点时间 —— 用户明确说这个代价可以接受）；
  //   ② 之后引擎逐手向前走，**每一步都回探**「这套算杀规则此刻能不能接手」；
  //   ③ 一旦能接手 → 杀棋序列并进**同一条线**（粉紫虚线杀路 + 威胁虚线环），一路走到五连；
  //   ④ 全程没用上该规则却已经连五 → 明说「已五子连珠，本次未用到 VCF / VCT」。
  var wantVcx = !!G.fwd.wantVcx;
  var wantA = wantVcx ? (G.fwd.want || 'VCF') : '';
  var wantB = wantVcx ? (G.fwd.want2 || (wantA === 'VCF' ? 'VCT' : 'VCF')) : '';
  G.fwd.line = []; G.fwd.idx = -1; G.fwd.hover = -1; G.fwd.busy = true;
  G.fwd.committed = -1; G.fwd.hold = false; G.fwd.sel = -1;
  G.fwd.vcxAt = -1; G.fwd.vcxMarks = [];
  G.fwd.kind = wantVcx ? wantA : '';       // ★ 十轮：算杀模式全程点亮对应键；普通前瞻熄灭
  fwdFindUi();
  fwdOkUI();
  var baseMoves = G.moves.length;
  G.fwd.base = baseMoves;                    // ★ 六轮补丁：显示序号时推演子按「应有的手数」编号
  var b = G.board.map(function (row) { return row.slice(); });   // 临时盘：绝不碰真盘
  function fwdCount() {
    var t = 0;
    for (var ti = 0; ti < N; ti++) for (var tj = 0; tj < N; tj++) if (b[ti][tj]) t++;
    return t;
  }
  function fwdSide() { return (fwdCount() % 2 === 0) ? 1 : 2; }   // 临时盘手数奇偶定色（同 curColor）
  // ★ 十轮：进攻方在**一次推演里锁定**（点了黑框/白框就听它，否则锁「开局轮走方」）——
  //   不锁的话「谁走谁算进攻方」，算杀探测会去问防守方，杀棋线也没法与推演线对齐。
  var baseStones = fwdCount();          // ★ 十轮：开局盘面已有子数（决定推演最多还能走几手）
  var maxSteps = N * N - baseStones;    // ★ 十轮（用户要求）：不设子数上限 —— 最多铺满棋盘
  var atkFix = G.fwd.atk || fwdSide();
  // ★ 廿八轮（2026-09-24 用户要求）：前瞻后期每手的思考时间 = **用户在对局设置里选的思考时间**
  //   （S.turnMs，默认 5000ms）—— 九轮那段「×2 但封顶 1.2 秒」撤销：设置里选 5 秒，推演后期
  //   每手就按 5 秒想，不再偷偷压到 1.2 秒（那是「前瞻不如对局深思」的来源）。下限 300ms 只防
  //   误设过低。首手加强（封顶 12 秒）与途中回探的短预算（VCX_STEP_TIMEOUT）不动。
  var thinkMs = Math.max(300, S.turnMs || 2000);
  var msg = els.fwdMsg;
  function vcxHitText(kind, n, atkC) {
    return T(kind === 'VCF' ? 'fwdVcfHit' : 'fwdVctHit')
      .replace('{n}', String(n)).replace('{c}', T(atkC === 1 ? 'fwdBlack' : 'fwdWhite'));
  }
  // ---- ① 开局分析：算杀模式按指定规则查（首选未中再兜另一套）；普通前瞻沿用 auto 老行为。
  //      算杀模式下若此刻不是进攻方的回合，就先不查 —— 先往前走，轮到它再算（用户：走到出现再利用）。
  if (!wantVcx || fwdSide() === atkFix) {
    if (msg) msg.textContent = wantVcx
      ? T('fwdProbing').replace('{r}', wantA)
      : T('fwdFindRun').replace('{k}', 'VCF/VCT');
    var r1 = await fwdTryVcx(b, wantVcx ? wantA : 'auto', wantVcx ? VCX_WORKER_DEEP : VCX_WORKER_TIMEOUT);
    if (gen !== G.fwd.gen) return;
    if (!r1 && wantVcx) { r1 = await fwdTryVcx(b, wantB, VCX_WORKER_DEEP); if (gen !== G.fwd.gen) return; }
    if (r1) {
      fwdAdoptVcx(b, r1, 0);                 // 开局就能杀 → 整条线都是算杀序列
      G.fwd.busy = false;
      if (msg) msg.textContent = vcxHitText(r1.kind, r1.line.length, G.fwd.atk || atkFix);
      fwdFindUi(); renderFwdSeq(); paint();
      return;
    }
  }
  G.fwd.kind = wantVcx ? wantA : '';
  fwdFindUi();
  // ★★ 十一轮（用户要求，务必保住）：**唯一的终局判据 = 临时盘上真的连五**。
  //   把九轮那段「引擎一报 ±M 或 |eval|≥1000 就提前收工」**整段删掉** —— 用户原话：
  //   「推演思维上有错误，不可能一两手就定性的，可能整个前瞻都给构建错了，他需要一直走到
  //     五子连珠才结束」。所以：引擎说一万次「已胜势」也不停，一路落子到盘面出现连五为止；
  //   最坏情况 = 铺满棋盘仍无五（fwdFull，和棋）。
  function fwdReportFive() {
    G.fwd.busy = false;
    // 算杀模式下「一路走到五连但压根没用上这套规则」→ 明说（十轮要求）；
    // ★ 十八轮（用户要求）：顺带点名进攻方 —— 「到最后也没有出现这一方进攻的可能性」。
    if (msg) msg.textContent = wantVcx
      ? T('fwdFiveNoVcx').replace('{n}', String(G.fwd.line.length))
        .replace('{c}', T(atkFix === 1 ? 'fwdBlack' : 'fwdWhite'))
      : T('fwdDone').replace('{n}', String(G.fwd.line.length));
    renderFwdSeq(); paint();
  }
  for (var step = 0; step < maxSteps; step++) {   // ★ 十轮：不设子数上限（最坏就是铺满棋盘）
    if (gen !== G.fwd.gen) return;
    if (G.moves.length !== baseMoves) {                          // 局面被动了 → 作废重推
      // ★ 六轮：hold（用户已「确定」并冻结）时**不许清**——推演结果是用户点名保留的
      if (!G.fwd.hold) {
        G.fwd.line = []; G.fwd.idx = -1; G.fwd.hover = -1;
        renderFwdSeq();
      }
      G.fwd.busy = false;
      return;
    }
    // ★ 廿一轮（用户报「规则有点错」）：连五判据必须按**当前规则**判 —— 连珠/标准下长连不算赢、
    //   黑方禁手也要照规则，硬编码 rule 0（自由局）会把这些局面判错。
    if (findWinLine(b, engineRule())) { fwdReportFive(); return; }   // 开局盘面已连五（保险）
    // 本手的行棋方：临时盘手数奇偶定色（与真盘的 curColor 同一口径）—— 必须先于引擎调用算出来，
    // 因为下面要把它**显式告诉引擎**（side），否则子数不均衡时引擎会站到对面去算（十六轮根因）。
    var total = 0;
    for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) if (b[i][j]) total++;
    var cc = (total % 2 === 0) ? 1 : 2;
    // ★ 十六轮（用户报「白子让着黑子去赢」）：落子前先做**必应校验** ——
    //   ① 自己能连五 → 直接连（省一次搜索，也绝不会漏杀）；
    //   ② 对手已成四（有成五点）→ 必须堵；③ 对手活三 → 我方无四可走时必应。
    var op = [], of = [], myFour = 0, quick = null;
    quick = winPoints(b, cc, engineRule());
    if (!quick.length) {
      op = winPoints(b, 3 - cc, engineRule());
      if (!op.length) {
        of = openFourPoints(b, 3 - cc, engineRule());
        if (of.length) myFour = fourPoints(b, cc, engineRule()).length;
      }
      // ★★ 廿一轮：这里原本是十七轮加的「对手唯一成五点 = 强制应手、直接落、跳过引擎」——
      //   **已撤销**。用户实测那之后推演会机械地「堵」（已经五子连珠了还在堵）：省掉引擎这一问
      //   之后，剩下的只是几何上的堵点，没有引擎对全局的判断（有没有反杀、有没有更狠的一手）。
      //   回到 11 点那版的做法：**每一手都问引擎**，必应判断放在引擎给出候选**之后**
      //   （见 mustAnswer），只在它明显漏了「连五 / 唯一必堵」时才纠正。
    }
    // ★★ 廿三轮（用户报「VCF / VCT 有一点小瑕疵」＋「对齐 Rapfi 官方算法」）：
    //   **算杀回探必须发生在「进攻方行棋的那一刻」**，而不是攻方刚落完一手之后。
    //   Rapfi 的 VCF / VCT 是威胁空间搜索（威胁空间 = 只能由进攻方执子、逐手逼杀）——
    //   根节点必须由**行棋方 = 进攻方**，出来的序列第一手就是进攻方的杀棋手。
    //   旧版把回探放在落子之后（`cc === atkFix` 判的是「刚走的那手是攻方的」），那时其实
    //   轮到**防守方** —— 搜出来的是「攻方连走两手」的非法线（真机实证：F4 黑 → F2 黑 两连手，
    //   而 F4 已成四、本该轮到白方在 F2 必应；棋盘上就多出一手同色）。提前到行棋前探测后：
    //   命中即把整条杀棋线并进推演线，颜色天然交替，防守方的必应手由算杀器自己带上。
    //   ★ step>0：第 0 手已在上面的「开局分析」里查过（且预算更足），不重复查。
    if (wantVcx && step > 0 && cc === atkFix) {
      var rp = await fwdTryVcx(b, wantA, VCX_STEP_TIMEOUT);
      if (gen !== G.fwd.gen) return;
      if (!rp) { rp = await fwdTryVcx(b, wantB, VCX_STEP_TIMEOUT); if (gen !== G.fwd.gen) return; }
      if (rp) {
        var from = G.fwd.line.length;
        fwdAdoptVcx(b, rp, from);            // 从这一手起 = 算杀段（虚线 + 环从 from 开始画）
        G.fwd.busy = false;
        if (msg) msg.textContent = T('fwdVcxLater')
          .replace('{k}', String(from)).replace('{r}', rp.kind).replace('{n}', String(rp.line.length));
        fwdFindUi(); renderFwdSeq(); paint();
        return;
      }
    }
    if (step === 0 && msg) {
      // ★ 十七轮（用户要求）：首次计算预算封顶 **12 秒**；提示里给出**首手预计秒数**与全程区间
      //   （首手加强计算 deepMs，其后每手约 thinkMs；按 8~40 手的常见长度估区间）。
      // ★ 2026-09-27（用户要求「前瞻每一步也要与思考时间相匹配」）：首手加强预算的 12s 封顶
      //   放宽到 60s —— 思考时间设得长的用户，前瞻首手的全局计算也按 ×4 真给足。
      var deepMs = Math.max(4000, Math.min(60000, (S.turnMs || 400) * 4));
      var loS = Math.round((deepMs + thinkMs * 8) / 1000);
      var hiS = Math.round((deepMs + thinkMs * 40) / 1000);
      msg.textContent = T('fwdEta').replace('{d}', String(Math.ceil(deepMs / 1000)))
                                  .replace('{a}', String(loS)).replace('{b}', String(hiS));
    } else if (msg) {
      msg.textContent = T('fwdRunning').replace('{k}', String(step + 1));
    }
    var r = null, c = null;
    if (!quick.length) {                                          // 能连五 → 不必再问引擎
      // ★★ 2026-09-23（用户要求）推演**第一手 = 加强全局计算**：像 KataGo 全局面评估那样，
      //   给引擎加大的时间预算与更宽的候选面（topN 4~8），让它通盘衡量后挑出**突破口**；
      //   从第二手起恢复常规逐手预算。★ 十七轮：首次计算**封顶 12 秒**（用户要求）。
      var firstDeep = (step === 0);
      // ★ 2026-09-27：首手封顶同步放宽（与 deepMs 一致）；后续每手 = thinkMs（= 思考时间设置）。
      var tms = firstDeep ? Math.max(4000, Math.min(60000, (S.turnMs || 400) * 4)) : thinkMs;
      try {
        r = await LocalAI.analyze({ board: b, moveList: [], matchMs: 600000,
          turnMs: tms, timeUsedMs: 0,
          topN: firstDeep ? Math.max(4, S.nbest || 4) : (of.length ? 4 : 1),
          rule: engineRule(), cid: 'fwd-' + gen + '-' + step, lane: 'fwd', side: cc,
          liveId: LocalAI.nextLiveId(), tag: T('tagFwd') }, tms + 9000);
      } catch (e) { r = null; }
      if (gen !== G.fwd.gen) return;
      var c0 = r && r.candidates && r.candidates[0];
      if (c0 && !(c0.y < 0 || c0.y >= N || c0.x < 0 || c0.x >= N || b[c0.y][c0.x])) c = c0;
    }
    // 引擎候选（已排好序）→ 必应校验决定是否改走别处
    var cands = (r && r.candidates) ? r.candidates.filter(function (q) {
      return q && !(q.y < 0 || q.y >= N || q.x < 0 || q.x >= N || b[q.y][q.x]);
    }) : [];
    var pick = quick.length ? { x: quick[0].x, y: quick[0].y, why: 'win' }
              : mustAnswer(b, cc, cands, op, of, myFour);
    if (!pick && !c) break;                                       // 引擎没给出可下的点
    if (!pick) pick = { x: c.x, y: c.y, why: 'engine' };
    b[pick.y][pick.x] = cc;
    G.fwd.line.push({ x: pick.x, y: pick.y, c: cc });
    renderFwdSeq(); paint();                                     // 逐手实时上盘（透明推演子）
    // ★★ 十一轮（用户要求）：落子后**立刻**看盘面 —— 真的连五了就结束（这是唯一的结束条件）。
    //   放在算杀回探之前：这一步既然已经连五，杀棋线就没意义了。
    if (findWinLine(b, engineRule())) { fwdReportFive(); return; }   // ★ 廿一轮：按当前规则判连五
    // ★★ 十一轮（用户要求）：这里原本是九轮加的「引擎 ±M / |eval|≥1000 → 提前收工并播报
    //   『胜势已定』」——**已整段删除**。用户明确：不可能一两手就定性，必须一路走到盘面连五。
    //   引擎说多少次「已胜势」都不停，循环继续往下一手走。
  }
  G.fwd.busy = false;
  // ★ 十轮（用户要求）：没有子数上限 —— 走到这里是「铺满棋盘仍未连五」（和棋，极罕见）；
  //   中途 break 出来的则是「引擎这一步没给出可下的点」，两种情形分开说。
  var boardFull = (G.fwd.line.length >= maxSteps);
  if (msg) msg.textContent = T(boardFull ? 'fwdFull' : 'fwdCap').replace('{n}', String(G.fwd.line.length));
  // ★ 十轮：算杀模式走满仍没等到算杀接手 → 沿用七轮「无解弹窗」把结论摆到眼前；
  //   ★ 十八轮（用户要求）：弹窗里**点名进攻方颜色**（自动判定的那一位）——
  //   「到最后也没有出现这一方进攻的可能性」就明说，不让人猜。
  if (wantVcx) vcxPopShow(T(wantA === 'VCF' ? 'fwdVcfNone' : 'fwdVctNone')
    .replace('{c}', T(atkFix === 1 ? 'fwdBlack' : 'fwdWhite')));
  renderFwdSeq(); paint();
}
/** 推演序列的浏览位：hover 优先（悬浮临时看），否则 idx（< > 步进 / 选中），
 *  再否则已确定位（committed），都没有 = 全部推演子。 */
function fwdShowIdx() {
  if (G.fwd.hover >= 0) return G.fwd.hover;
  if (G.fwd.idx >= 0) return G.fwd.idx;
  if (G.fwd.committed >= 0) return G.fwd.committed;
  return G.fwd.line.length - 1;
}
// ---- 阶段性渲染（六轮，用户要求「悬浮代码之间不要闪烁」）：
//  · rAF 合帧：同一帧内多次 hover 变化只画一次，画的时候棋盘上**仍是上一个布局**
//    （canvas 不清屏就保持旧帧 → 新帧一次画完直接替换，没有中间空白帧）；
//  · 离开旧代码后先「保持旧布局」一小会儿（140ms）再退回全盘 —— 代码链上挪鼠标
//    经过缝隙时不会闪一下「全部推演子」的中间态。
var FWD_HOLD_MS = 140;
var fwdPaintPend = false;
function fwdPaintSoon() {
  if (fwdPaintPend) return;
  fwdPaintPend = true;
  (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
    fwdPaintPend = false; paint();
  });
}
function fwdHover(i) {
  if (G.fwd.hoverTimer) { clearTimeout(G.fwd.hoverTimer); G.fwd.hoverTimer = 0; }
  if (G.fwd.hover === i) return;
  G.fwd.hover = i;
  fwdPaintSoon();
}
function fwdHoverRelease() {
  if (G.fwd.hoverTimer) clearTimeout(G.fwd.hoverTimer);
  G.fwd.hoverTimer = setTimeout(function () {
    G.fwd.hoverTimer = 0;
    if (G.fwd.hover >= 0) { G.fwd.hover = -1; fwdPaintSoon(); }
  }, FWD_HOLD_MS);
}
function fwdHoverCancel() {
  if (G.fwd.hoverTimer) { clearTimeout(G.fwd.hoverTimer); G.fwd.hoverTimer = 0; }
  G.fwd.hover = -1;
}
/** 「确定」键的可用态：有选中项才点亮（六轮：点击代码 = 选中，确定键变色提示）。 */
function fwdOkUI() {
  if (!els.btn_fwd_ok) return;
  els.btn_fwd_ok.classList.toggle('on', G.fwd.sel >= 0 && G.fwd.sel < (G.fwd.line || []).length);
}
/** 框下代码链：黑子紫框 / 白子浅蓝框；悬浮 = 阶段性预览（不闪），
 *  点击 = **选中**（确定键变色），点「确定」才推进棋盘（六轮语义）。
 *  已确定位之后的代码变浅（.dim）但**仍可点击再选**——不重算，接着往下确定。 */
function renderFwdSeq() {
  var seq = els.fwdSeq;
  if (!seq) return;
  var line = G.fwd.line || [];
  seq.innerHTML = '';
  var show = fwdShowIdx();
  line.forEach(function (m, i) {
    var s = document.createElement('button');
    s.type = 'button';
    s.className = 'fwc ' + (m.c === 1 ? 'b' : 'w')
      + (i === show ? ' cur' : '')
      + (i === G.fwd.sel ? ' sel' : '')
      + (G.fwd.committed >= 0 && i > G.fwd.committed ? ' dim' : '');
    s.textContent = coordName(m.x, m.y);
    s.title = (m.c === 1 ? T('fwdBlack') : T('fwdWhite')) + ' · ' + (i + 1);
    s.onmouseenter = function () { fwdHover(i); };
    s.onmouseleave = function () { fwdHoverRelease(); };
    s.onclick = function () { fwdSelect(i); };
    seq.appendChild(s);
  });
  if (!line.length && !G.fwd.busy && els.fwdMsg) els.fwdMsg.textContent = T('fwdIdle');
}
/** 点击某枚代码 = 选中（不落盘）：棋盘预览到那手为止 + 确定键变色（六轮）。 */
function fwdSelect(i) {
  if (!G.fwd.on || !G.fwd.line.length) return;
  if (i < 0 || i >= G.fwd.line.length) return;
  if (G.fwd.committed >= 0 && i <= G.fwd.committed) {
    // 选中的是已确定过的一段：只回看，不重复落盘（局面已经在这里了）
    G.fwd.sel = -1; G.fwd.idx = i; fwdOkUI(); renderFwdSeq(); paint(); return;
  }
  G.fwd.sel = i; G.fwd.idx = i;
  fwdOkUI(); renderFwdSeq(); paint();
}
function fwdStep(d) {
  if (!G.fwd.on || !G.fwd.line.length) return;
  var len = G.fwd.line.length;
  var cur = (G.fwd.idx >= 0) ? G.fwd.idx : len - 1;
  G.fwd.idx = Math.max(-1, Math.min(len - 1, cur + d));
  fwdHoverCancel();
  renderFwdSeq(); paint();
}
/** 点「确定」= 把**选中的那一手**（含已确定之后的每一步）真正落上盘：
 *  · 前瞻结果**不消失**：已确定位之后的代码变浅仍可再选再确定；
 *  · **不重算**（hold 冻结）：局面变了也不自动重推，再点「前瞻」键才重新计算。 */
function fwdCommit() {
  var i = G.fwd.sel;
  if (i < 0 || i >= (G.fwd.line || []).length) return;
  var line = G.fwd.line.slice(0, i + 1);
  var from = G.fwd.committed + 1;                 // 只落还没确定的那一段（可多次累进确定）
  G.fwd.committed = i; G.fwd.sel = -1; G.fwd.idx = i;
  G.fwd.hold = true;                              // 冻结：place 触发的 fwdQueue 会被闸掉
  fwdHoverCancel();
  fwdOkUI(); renderFwdSeq();
  for (var k = from; k < line.length; k++) {
    if (!place(line[k].x, line[k].y)) break;      // place = 真落子（含 anaReset / paint）
  }
  if (!G.fwd.on) { paint(); return; }
  afterMove();                                    // 终局判定 / AI 接管（「同样也可以改变」）
  paint();
  // ★ 六轮：不 fwdQueue —— 等用户再点「前瞻」才重新计算。
}

/** 停止计算：作废在途结果 + 清标注（引擎那次搜索本身停不掉，靠 gen 闸丢弃）。
 *  ★ 三十轮：顺带关掉扫描防守的流式窗口与续拍表（用户喊停 = 真停；再点扫描防守会重启）。 */
function anaStop() {
  G.ana.gen++;
  if (G.ana.defTimer) { clearTimeout(G.ana.defTimer); G.ana.defTimer = null; }
  G.ana.defWinUntil = 0; G.ana.defRefining = false;
  G.ana.busy = false; G.ana.kind = '';
  G.ana.marks = []; G.ana.rows = [];
  anaMark(null);
  renderAna(T('anStopped'));
  paint();
}

/** 多点分析（nbest）：一次问出前 N 个最佳点及各自估值，标成 1..N。
 *  ★ 三十轮（用户要求）：改成**演算可视化** —— 点开立刻开始算，总窗口 = 思考时间 3~4×，
 *  窗口内一轮接一轮连轴探针（节奏随引擎计算快慢有密有疏），**每轮草稿立即上盘**
 *  （名次圈 + 清单 + 仪表全量重铺，像看引擎边思考边打草稿）；窗口一到 →
 *  最后一轮（算得最久、最稳）定格为最终结论。gen 闸：局面一变/再点/停止即作废。 */
async function anaNbest() {
  if (!anaGuard(0)) return;
  var gen = ++G.ana.gen, N = anaIp();
  G.ana.busy = true; G.ana.kind = 'nbest';
  anaMark(els.btn_an_nbest);
  var winUntil = Date.now() + streamWindowMs();
  var last = null;
  try {
    for (var rd = 1; ; rd++) {
      if (gen !== G.ana.gen) return;
      var budget = Math.min(S.turnMs || 2000, winUntil - Date.now());
      if (budget < 250) break;                        // 窗口余量不足 → 上一轮结果定格
      renderAna(T('anDraft').replace('{r}', String(rd)));
      // ★ 2026-09-27 深夜（单实例裁决层）：每一轮草稿都是一次单路深搜；窗口快关的几轮
      //   （budget 很小）照跑，形状由 analyzeVote 薄壳统一。
      var r = await analyzeVote(budget, N, curColor(), null, null, T('tagNbest'));
      if (gen !== G.ana.gen) return;
      var cs = ((r && r.candidates) || []).slice(0, N);
      if (!cs.length) { if (!last) { renderAna(T('anEmpty')); return; } break; }
      last = cs;
      // 草稿即时上盘（与最终结论同一套渲染 —— 智子式的逐轮逼近）
      G.ana.marks = []; G.ana.rows = [];
      cs.forEach(function (c, i) {
        // ★ 2026-09-20（三轮→四轮修订，用户要求）：吸收官方 Gomocalc 的候选呈现 ——
        //   ① 圆圈**多彩名次色**（2026-09-27 起为卡塔狗名次色：1 蓝 → 2 绿 → 3 黄 → 4 橙 → 5+ 红，
        //     一眼分得出名次，三轮的「中性乳白圈」作废）；② 名次数字**融进评估圆圈**
        //     （inline：数字小字在上、评估小字在下，官方的格内遮罩语言）。
        G.ana.marks.push({ x: c.x, y: c.y, badge: String(i + 1), label: fmtEval(c.eval), tier: anaTierOf(i), inline: true });
        G.ana.rows.push({ i: i, badge: String(i + 1), coord: coordName(c.x, c.y), eval: fmtEval(c.eval), pv: pvText(c.line) });
      });
      if (cs[0].depth != null) {
        els.st_depth.textContent = cs[0].depth;
        els.st_eval.textContent = cs[0].eval;
      }
      paint();
      if (Date.now() >= winUntil) break;              // 窗口尽 → 本轮即定格结论
    }
    if (!last) { renderAna(T('anEmpty')); return; }
    renderAna(T('anDone').replace('{n}', String(G.moves.length + 1))
             .replace('{ev}', fmtEval(last[0].eval))
             .replace('{d}', String(last[0].depth != null ? last[0].depth : '-')));
    paint();
  } catch (e) {
    if (gen === G.ana.gen) renderAna(T('offline'));
  } finally {
    if (gen === G.ana.gen) { G.ana.busy = false; anaMark(null); }
  }
}

/** 扫描防守（searchdefend）。
 *  引擎的「行棋方」是靠落子奇偶推出来的（黑先交替 → 末子反色），所以**先把我方最佳一手虚拟
 *  落上去**，盘面才轮到对手说话 —— 这时问出来的候选就是「对手最凶的几个点」，也就是我要防的点。
 *  虚拟子落的是**真实最佳点**而不是随便一个空点，所以这个探针是干净、可解释的
 *  （与 refreshHeat 里那手虚拟子同一手法）；算完立刻撤回，用户看不到这一步。 */
/** 平衡一（一手平衡）：把前 N 个候选全算出来，挑 |评估| 最小的那一手 —— 越接近 0 越均衡。
 *  棋盘上把这一手用紫色 ≡ 徽标标出（2026-09-27：旧绿色与 2 选撞色），其余候选仍按名次列出，方便横向比较。 */
async function anaBal1() {
  if (!anaGuard(0)) return;
  var gen = ++G.ana.gen, N = Math.max(4, anaIp());
  G.ana.busy = true; G.ana.kind = 'bal1';
  anaMark(els.btn_an_bal1);
  renderAna(T('anRunning'));
  try {
    // ★ 三十三轮：票箱版 —— 平衡一要在「前 N 个候选」里挑 |eval| 最小的一手，
    //   融合后的候选面天然带名次与票数，比单路的排序更有说服力。
    var r = await analyzeVote(S.turnMs, Math.min(8, N), curColor(), null, null, T('tagBal1'));
    if (gen !== G.ana.gen) return;
    var cs = (r && r.candidates) || [];
    if (!cs.length) { renderAna(T('anEmpty')); return; }
    var bi = 0, bv = Infinity;
    cs.forEach(function (c, i) {
      var v = evalNum(c.eval);
      if (!isNaN(v) && Math.abs(v) < bv) { bv = Math.abs(v); bi = i; }
    });
    G.ana.marks = []; G.ana.rows = [];
    cs.forEach(function (c, i) {
      var isBal = (i === bi);
      G.ana.marks.push({
        x: c.x, y: c.y, badge: isBal ? '≡' : String(i + 1),
        label: fmtEval(c.eval), tier: isBal ? -1 : anaTierOf(i),
      });
      G.ana.rows.push({
        i: i, badge: isBal ? '≡' : String(i + 1), coord: coordName(c.x, c.y),
        eval: fmtEval(c.eval), pv: pvText(c.line), tier: isBal ? -1 : undefined,
      });
    });
    renderAna(T('anBal1Done').replace('{ev}', fmtEval(cs[bi].eval)));
    paint();
  } catch (e) {
    if (gen === G.ana.gen) renderAna(T('offline'));
  } finally {
    if (gen === G.ana.gen) { G.ana.busy = false; anaMark(null); }
  }
}

/** 平衡二（二手平衡）：对前 K 个候选**逐个虚拟落子**，再问对手最强的一手，
 *  取「走完这两手之后 |评估| 最小」的那一对 —— 也就是两手之后局面最接近均势的开局。
 *  引擎的 eval 是**行棋方视角**，虚拟落子之后行棋方变成对手 → 取负才是**我方**视角
 *  （与 pushCurve 的处理一致，勿弄反）。 */
async function anaBal2() {
  if (!anaGuard(1)) return;
  var gen = ++G.ana.gen;
  G.ana.busy = true; G.ana.kind = 'bal2';
  anaMark(els.btn_an_bal2);
  renderAna(T('anRunning'));
  var K = Math.max(3, Math.min(6, anaIp()));
  // ★ 廿八轮（用户要求「计算习惯匹配原生引擎」）：原生 Rapfi 多线程算力下探针放宽 ——
  //   WASM 时代「×0.5 且封顶 2.2s」的保守值撤销；每个候选的探针 = 用户设置×0.6（封顶 5s）。
  //   ★ 三十三轮：主探针（选开局候选那一步）走票箱；环内逐个候选的二次回探仍是
  //     sub 单发 —— 一轮要连发 K 次，票箱三倍算力不值得（见下方 r2 处注释）。
  var probeMs = Math.max(700, Math.min(5000, Math.round((S.turnMs || 2000) * 0.6)));
  try {
    var r = await analyzeVote(probeMs, K, curColor(), null, null, T('tagBal2'));
    if (gen !== G.ana.gen) return;
    var cs = ((r && r.candidates) || []).slice(0, K);
    if (!cs.length) { renderAna(T('anEmpty')); return; }
    var mine = curColor();
    var best = null;
    G.ana.rows = [];
    for (var i = 0; i < cs.length; i++) {
      if (gen !== G.ana.gen) return;
      var c = cs[i];
      if (!G.board[c.y] || G.board[c.y][c.x]) continue;
      G.board[c.y][c.x] = mine;
      var r2 = null;
      // ★ 三十三轮：这一发是环内逐候选的**二次回探**（每轮最多 K 次）—— 票箱三倍算力
      //   不划算，而且各候选统一走 sub 单发，相互之间的 |eval| 才可比（同一把尺子）。
      try { r2 = await analyze(probeMs, 2, 'sub', 3 - mine, T('tagBal2')); } catch (e2) {}   // 虚拟子后轮到对手
      G.board[c.y][c.x] = 0;
      if (gen !== G.ana.gen) return;
      var cs2 = (r2 && r2.candidates) || [];
      var after = cs2.length ? -evalNum(cs2[0].eval) : evalNum(c.eval);   // 翻成我方视角
      G.ana.rows.push({
        i: i, badge: String(i + 1), coord: coordName(c.x, c.y), eval: fmtEval(after),
        pv: cs2.length ? (T('anAfter') + ' ' + coordName(cs2[0].x, cs2[0].y)) : '',
      });
      if (isNaN(after)) continue;
      if (!best || Math.abs(after) < Math.abs(best.after)) best = { c: c, opp: cs2[0] || null, after: after, i: i };
    }
    if (!best) { renderAna(T('anEmpty')); return; }
    G.ana.marks = [{ x: best.c.x, y: best.c.y, badge: '≡', label: fmtEval(best.after), tier: -1 }];
    if (best.opp) {
      G.ana.marks.push({
        x: best.opp.x, y: best.opp.y, badge: '↩',
        label: fmtEval(-evalNum(best.opp.eval)), tier: 4,
      });
    }
    // 把选中的那一对提到清单最前（其余仍列在后面，方便看差别）
    G.ana.rows.sort(function (a, b) { return (a.i === best.i ? -1 : (b.i === best.i ? 1 : a.i - b.i)); });
    renderAna(T('anBal2Done').replace('{ev}', fmtEval(best.after)));
    paint();
  } catch (e) {
    if (gen === G.ana.gen) renderAna(T('offline'));
  } finally {
    if (gen === G.ana.gen) { G.ana.busy = false; anaMark(null); }
  }
}

function wireAnalysis() {
  if (!els.btn_an_nbest) return;
  // ★ 2026-09-20：计算/停止计算同键 —— 闲着点它 = 开始算，跑着点它 = 中断。
  els.btn_an_stop.onclick = function () { if (G.ana.busy) anaStop(); else anaCalc(); };
  // ★ 2026-09-27 深夜（用户报「多点分析运行中无法取消」）：运行中再点 = 取消（与「停止计算」同效）。
  els.btn_an_nbest.onclick = function () { if (G.ana.busy && G.ana.kind === 'nbest') { anaStop(); return; } anaNbest(); };
  // ★ 五轮：前瞻框接线（开关键 + < > 步进；代码链的悬浮/点击在 renderFwdSeq 里逐枚绑）
  //   ★ 六轮：确定键 —— 代码链点选后再点它才真正落盘（fwdCommit 读 G.fwd.sel）
  els.btn_fwd.onclick = function () { fwdToggle(); };
  // ★ 三轮（用户要求）：查找VCF / 查找VCT = 只算杀不逐手推演
  if (els.btn_fwd_vcf) els.btn_fwd_vcf.onclick = function () { fwdFind('VCF'); };
  if (els.btn_fwd_vct) els.btn_fwd_vct.onclick = function () { fwdFind('VCT'); };
  els.btn_fwd_ok.onclick = function () { fwdCommit(); };
  els.btn_fwd_prev.onclick = function () { fwdStep(-1); };
  els.btn_fwd_next.onclick = function () { fwdStep(1); };
  // ★ 十八轮（用户要求）：黑/白框 = 进攻方指示框（不可点）。
  // ★ 2026-09-25（用户要求）：键挪到「计算评估」卡、与「计算」并排（仍是 btn_fwd_clear），
  //   点击 = clearAllMarks() —— 清掉计算评估里**任意项目**留下的棋盘标记（见其注释）。
  if (els.btn_fwd_clear) els.btn_fwd_clear.onclick = function () { clearAllMarks(); };
  if (els.vcxPop_close) els.vcxPop_close.onclick = function () { if (els.vcxPop) els.vcxPop.hidden = true; };
  // ★ 六轮补丁（用户要求）：键盘 ← / → 也能控制前瞻的 < > 步进预览。
  //  · 只在**前瞻开着且有推演序列**时生效；复盘窗/回顾复盘不抢（那边方向键另有用途）；
  //  · 焦点在输入框/下拉里不抢（否则改名框、局面代码框里没法移动光标）；
  //  · 语义完全复用 < > 键的 fwdStep（含 hold 冻结期间的浏览）。
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!G.fwd || !G.fwd.on || !G.fwd.line.length) return;
    if (RV_MODE || G.review) return;
    var t = e.target;
    if (t && t.tagName && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    fwdStep(e.key === 'ArrowLeft' ? -1 : 1);
    e.preventDefault();
  });
  els.btn_an_defend.onclick = function () { anaDefend(true); };
  els.btn_an_bal1.onclick = function () { anaBal1(); };
  els.btn_an_bal2.onclick = function () { anaBal2(); };
  els.num_nbest.onchange = function () {
    // ★ 2026-09-20 修复：原来写的是 `S.nbest = anaIp()` —— 而 anaIp() 读的正是 S.nbest，
    //   自己读自己 → 无论输几都弹回 4。必须从**输入框**取值再钳到 2~8。
    S.nbest = Math.max(2, Math.min(8, Math.round(+els.num_nbest.value || 4)));
    els.num_nbest.value = String(S.nbest);
    save();
  };
  els.num_nbest.value = String(anaIp());
  renderAna(T('anIdle'));
}

function buildSelects() {
  var host = G.host || {};
  var maxT = Math.max(1, host.threadsMax || 1);
  // ★ 2026-09-19（用户要求「即使是 0.5 秒，实力也应该非常强」）：默认档位从「半核」提到
  //   **全部可用核**。threadsMax = 总核数按机器规模给系统留余量（见 host.cpp ThreadsMax()）：
  //     · 总核 ≥ 16 → 留 4（16 核 → 上限 12）
  //     · 总核 ≥  8 → 留 2（8 核 → 上限 6）
  //     · 其余     → 留 1（4 核 → 上限 3）
  //   短时限搜索里线程数是棋力最直接的杠杆，所以默认就顶到上限，用户仍可在下拉里手动调低。
  if (!S.cores || S.cores > maxT)
    S.cores = maxT || host.threadsDefault || 1;
  var html = '';
  for (var t = 1; t <= maxT; t++) {
    html += '<option value="' + t + '"' + (t === S.cores ? ' selected' : '') + '>' + t + '</option>';
  }
  els.sel_cores.innerHTML = html;

  // ★★ 2026-09-24（用户要求）：置换表可选范围 **256MB → 6GB**；并且**物理内存不足 8GB 的机器上
  //   6GB 这一档变灰不可选**（内存装不下）。两条硬约束：
  //     · 6GB 只有**原生引擎**吃得住 —— 页面内 WASM 是 wasm32 地址空间，硬上限 2GB。不带
  //       rapfi-native/ 的版本（三合一）因此干脆不出 3072/4096/6144 三档，免得选了被静默夹到 2GB。
  //     · ★ 2026-09-25（用户定档）：默认 **1024MB** 固定档（旧口径「内存 1/4 自动」作废——
  //       32GB 机自动给 6GB 太激进）。存过档的用户仍用自己存过的值。
  var native = !!host.native;
  var memMB = host.memMB | 0;
  var maxH = native ? 6144 : 2048;
  var hs = [256, 512, 768, 1024, 1536, 2048];
  if (maxH > 2048) hs = hs.concat([3072, 4096, 6144]);
  // 6GB 档可用条件：有原生引擎 且 内存 ≥ 8GB（memMB=0 表示宿主没报，按可用处理）
  var allow6 = native && (memMB <= 0 || memMB >= 8192);
  if (S.hashMB === 6144 && !allow6) S.hashMB = 0;    // 旧存档在本机已选不了 6GB → 回落默认档
  if (!S.hashMB || hs.indexOf(S.hashMB) < 0) S.hashMB = 1024;   // 默认 1024MB（两份档位表都含此档）
  els.sel_hash.innerHTML = hs.map(function (h) {
    var off = (h === 6144 && !allow6);
    return '<option value="' + h + '"' + (h === S.hashMB ? ' selected' : '') +
           (off ? ' disabled' : '') + '>' + h + ' MB</option>';
  }).join('');

  // ★★ 2026-09-24：把定下来的档位**立刻推给引擎**。此前只有下拉的 onchange 会推，
  //   于是开机那一刻 Worker 是拿 cfgT/cfgKB = 0（自动档）起的 —— 页面显示「12 线程 / 6144MB」，
  //   引擎实际按 auto 跑（16 核机上等于 15 线程），两边对不上，用户设的上限形同虚设。
  //   放在这里之后：宿主报文先到 → 这里只记下 cfgT/cfgKB，boot() 里的 LocalAI.boot() 直接用对的值起。
  applyEngineConfig();
}


// ---------------------------------------------------------------- 启动
function boot() {
  grab();
  LocalAI.boot();              // ★ 页面内 AI 预热：Worker 加载 rapfi（几秒）与 UI 初始化并行，
                               //   用户落第一手时引擎早已 boot 完（对齐原 :8964 常驻体验）
  try {
    var st = JSON.parse(localStorage.getItem('gbcalc.settings.v1') || '{}');
    for (var k in st) if (S.hasOwnProperty(k)) S[k] = st[k];
    // 旧版本存过 'analyze' / 'free' 两个模式 → 统一迁移到「自由摆盘」
    if (S.mode !== 'pve' && S.mode !== 'place' && S.mode !== 'endgame') S.mode = 'place';   // ★ 十四轮：残局也是合法持久化模式
    // ★★ 2026-09-24（用户要求）：旧存档迁移 —— 老版本只有 S.side（'b' 我执黑 / 'w' 我执白），
    //   新版是「AI 执黑 / AI 执白」两个独立开关。只在「存过 side、没存过 aiB/aiW」的老档里换算：
    //     我执黑（side='b'）⇒ AI 执白；我执白（side='w'）⇒ AI 执黑。
    //   新档（有 aiB/aiW）原样接受，只借 setAiSides 归一化并回写派生 side。
    if (st.aiB === undefined && st.aiW === undefined && st.side !== undefined) {
      setAiSides(st.side !== 'b', st.side !== 'w');
    } else {
      setAiSides(S.aiB, S.aiW);
    }
    // ★★ 2026-09-25（用户要求「两色都选中就自动在棋盘上下棋」）：开机时若两个 AI 执子开关
    //   本来就都是开着的（存档就是自打局面），那把上一局的「停手」状态**清掉** —— 否则会停在
    //   「两个开关都亮着、棋盘却一动不动」的哑火状态，用户必须再去点一次正中那颗键才走。
    //   「停手」是观棋时的临时动作，不该跨进程留着。（摆盘/残局模式下 maybeAi() 自己会拦住。）
    if (aiVsAi()) S.paused = false;
  } catch (e) {}

  if (!G.board) G.board = newBoard();
  initPanels();
  applyLayout();
  // ★ 2026-09-20：「颜色」弹窗 / 「卡片」功能键 / 计算评估面板三块的接线 —— 漏掉这一行的时候
  //   页面**不报错**（onerror 一条都没有）但全都不响应：调色窗点不开、预制色块是空的、
  //   计算评估的六个键全是死的。测试里就是被这条坑成「open=false … 0 块」的，务必留在这里。
  wireColors();
  wireCards();
  wireAnalysis();

  els.board.addEventListener('click', onBoardClick);
  bindBoardHover();          // ★ 鼠标悬浮格提示（浅蓝圆角方框，见 hoverFromEvent 注释）
  window.addEventListener('resize', function () { fitFont(); layoutBoard(); visLayout(); });
  if (window.ResizeObserver) new ResizeObserver(function () { fitFont(); layoutBoard(); }).observe(els.boardWrap);

  els.btn_lang.onclick = function () { S.lang = (S.lang === 'zh') ? 'en' : 'zh'; save(); applyLang(); refreshUI(); };
  // ★ 2026-09-20（用户要求）：顶栏那个「深色 / 浅色」两态键没了 —— 换肤与自定义色统一收在
  //   「颜色」弹窗里（见 wireColors 的 cp_theme），这里不再挂 onclick。
  // 图标键（整行正中间那个）三态可用：
  //   · AI 正在计算/行棋 → ❚❚，点它 = 暂停；
  //   · 已暂停 → ▶，点它 = 继续；
  //   · 空闲 → ▶，点它 = 让 AI 立刻辅助计算一手并落子（原「暂停键」语义保留）。
  // 于是「三角 / 双竖杠」是**真的会来回变换**的（用户要求这个键是活动的）。
  els.btn_pause.onclick = function () {
    // ★★ 2026-09-25（用户要求）：AI 自打（AI 执黑 + AI 执白都选中）时，棋盘正中这颗键
    //   就是**自动对弈的开关键** —— 和播放电影的播放/暂停一样：
    //     正在自动对弈 → 点一下**停手**（局面保留，随时能接着走）；已停手 → 点一下**继续**。
    //   这里不与下面的「辅助一手」混用：自打时 AI 自己会走每一步，辅助一手没有意义。
    if (aiVsAi()) {
      S.paused = !S.paused;
      save();
      refreshUI();
      if (!S.paused) maybeAi();          // 继续 → 立刻接着走下一手
      return;
    }
    if (G.busy) { S.paused = true; save(); refreshUI(); return; }
    if (S.paused) { S.paused = false; save(); refreshUI(); maybeAi(); return; }
    aiAssistOnce();
  };
  els.btn_prev.onclick = stepBack;
  els.btn_next.onclick = stepForward;
  // 主界面「重新开始」：先把这一局自动存进历史（用户要求「重新开始自动保存历史」），再清盘。
  // （复盘窗里对应的「重来」不写历史，那个键归 bootReview 管。）
  els.btn_reset.onclick = function () {
    if (G.moves.length >= 2) {
      var rec = { ts: Date.now(), src: 'local', rule: S.rule, side: S.side,
                  moves: G.moves.map(function (m) { return [m.x, m.y, m.c]; }) };
      // ★ 十八轮（用户要求）：确定过的残局 → 记录带 eg/egLen（历史标 Endgame、背诵从残局开始）
      if (S.egLocked && S.egBase && S.egBase.length) {
        rec.eg = true; rec.egLen = S.egBase.length;
      }
      addRecord(rec);
      renderDrawer();
    }
    resetGame(false);
    openStart();
    refreshUI();
    // ★ 2026-09-21（用户要求，六轮）：「在对局设置中，用户选择的后手，每一次重新开始
    //   机械自动下天元，或者其他开始」—— 重开后轮到 AI（用户执后手）就让它直接开局：
    //   空盘引擎的最优点就是天元，不需要写死坐标；其他规则的开局流程照旧接管。
    maybeAi();
  };
  els.btn_save.onclick = savePos;
  els.btn_save_rv.onclick = savePos;          // 复盘窗里的「保存局面」同语义（主窗口里它不可见）
  // ★ 2026-09-25（用户要求）：↻ = 整体棋子顺时针转 90°；⇄ = 翻转棋子布局小弹窗；
  //   ✥ = 局面步进小弹窗（四向平移一格）。★ 二轮澄清：全部变换**棋子布局**（数据层），
  //   棋盘线 / 字母数字坐标轴不动；引擎每次请求从 moveList 全量重建 → 无需额外同步。
  els.btn_rot.onclick = function () { layoutApply(ROT_CW); };
  // ★ 2026-09-25（用户要求）：⇄ 与 ✥ 两个小弹窗**互斥替换** —— 打开其中一个就把另一个收起，
  //   不出现两个弹窗并排/叠着；再点同一个键 = 收起自己的弹窗。
  els.btn_shift.onclick = function (e) {
    e.stopPropagation();
    els.mirrorPop.hidden = true;
    els.shiftPop.hidden = !els.shiftPop.hidden;
  };
  els.btn_mirror.onclick = function (e) {
    e.stopPropagation();
    els.shiftPop.hidden = true;
    els.mirrorPop.hidden = !els.mirrorPop.hidden;
  };
  els.btn_mv_fv.onclick = function () { layoutApply(FLIP_H); };   // 左右翻转
  els.btn_mv_fh.onclick = function () { layoutApply(FLIP_V); };   // 上下翻转
  els.btn_mv_d1.onclick = function () { layoutApply(DIAG_1); };   // 左上↔右下
  els.btn_mv_d2.onclick = function () { layoutApply(DIAG_2); };   // 右上↔左下
  els.btn_mv_up.onclick = function () { layoutApply(SHIFT_U); };
  els.btn_mv_down.onclick = function () { layoutApply(SHIFT_D); };
  els.btn_mv_left.onclick = function () { layoutApply(SHIFT_L); };
  els.btn_mv_right.onclick = function () { layoutApply(SHIFT_R); };
  els.btn_mv_close.onclick = function () { els.mirrorPop.hidden = true; };      // ✕
  els.btn_shift_close.onclick = function () { els.shiftPop.hidden = true; };    // ✕
  document.addEventListener('click', function (e) {
    if (els.mirrorPop && !els.mirrorPop.hidden &&
        !els.mirrorPop.contains(e.target) && e.target !== els.btn_mirror) {
      els.mirrorPop.hidden = true;
    }
    if (els.shiftPop && !els.shiftPop.hidden &&
        !els.shiftPop.contains(e.target) && e.target !== els.btn_shift) {
      els.shiftPop.hidden = true;
    }
  });
  // ★ 顶栏「复盘」= 在**另一个窗口**里开一张纯棋盘（用户要求）：
  //   主窗口这边一点都不动 —— 不暂存对局、不收仪表盘、不清热力。
  els.btn_review.onclick = openReviewFromBoard;
  // ★ 顶栏「识图」（2026-09-21，用户要求：在「复盘」左边）：打开独立识图窗口。
  els.btn_vis.onclick = openVisWindow;
  els.btn_ten.onclick = function () { if (openActive() && OPEN.kind === 'tar') startTenCall(); };
  // ★ 交换先后手小弹窗（用户要求）：先手 = 执黑，后手 = 执白；AI 自动执另一色并开始计算
  els.btn_swap_first.onclick = function () { if (OPEN && OPEN.choice) chooseSwapSide('b'); };
  els.btn_swap_second.onclick = function () { if (OPEN && OPEN.choice) chooseSwapSide('w'); };

  els.btn_history.onclick = function () { openDrawer('hist'); };
  // ★ 抽屉的接线统一在 wireDrawer()（复盘窗也要用同一套），这里只按窗口补各自的「取记录」出口。
  wireDrawer();
  wireAbout();

  els.btn_copy.onclick = function () {
    els.inp_code.value = buildCode();
    els.inp_code.select();
    try { document.execCommand('copy'); } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(els.inp_code.value).catch(function () {});
    }
    tellHost({ type: 'copy', text: els.inp_code.value });   // 宿主再用 Win32 剪贴板兜一层
    setStat(null, T('copied'));
  };
  els.btn_paste.onclick = function () {
    // ★ 以前只走 navigator.clipboard.readText()，在 WebView2 里会被权限直接拒绝 →
    //   点了「粘贴」毫无反应（用户报的 bug）。现在改成：宿主侧用 Win32 读系统剪贴板，
    //   读回来走 clip 消息回填；浏览器里则回落到异步剪贴板 API。
    if (HOST) tellHost({ type: 'paste' });
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(applyCodeText)
        .catch(function () { if (!HOST) els.inp_code.focus(); });
    } else if (!HOST) {
      els.inp_code.focus();                                 // 退路：聚焦后 Ctrl+V 手贴
    }
  };
  els.btn_load.onclick = function () { loadFromCode(els.inp_code.value); };

  els.seg_mode.onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.mode = b.getAttribute('data-mode');
    [].forEach.call(els.seg_mode.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
    // ★ 十八轮（用户要求）：**进「残局」模式 = 重新开始摆** —— 清掉上一次确定的基准；
    //   确定后自动跳去「摆盘」，基准继续生效（重新开始回到残局 / 历史首帧即它）。
    if (S.mode === 'endgame') { S.egLocked = false; S.egBase = null; }
    save();
    // ★ 2026-09-23：残局与自由摆盘一样清热力/数字 —— AI 完全不问
    if (S.mode === 'place' || S.mode === 'endgame') { G.heat = []; G.nums = []; }
    refreshUI();
    paint();
    // ★ 2026-09-23（用户要求）：进残局 → 左侧提示栏把玩法一次讲清楚
    // ★ 十六轮：已确定过的残局 → 提示改说「已确定」那一套（含重新开始/历史首帧的语义）
    if (S.mode === 'endgame') setStat(null, S.egLocked ? T('egLockedHint') : T('egHint'));
    if (S.mode === 'pve') { refreshHeat(true); refreshCoach(); maybeAi(); }
  };
  // ★ 2026-09-23（用户要求）：残局摆盘键 —— 顺序摆盘 / 任意摆盘（弹圆角框选黑子或白子，
  //   选中后该色可连续摆放，不限数量不限顺序）；选中键高亮（黑子=浅紫、白子=浅白蓝）
  // ★ 十六/十八轮（用户要求）：残局「确定」—— 把当前盘面定成这个残局的基准局面，
  //   然后**自动切到「摆盘」模式**继续研究：「重新开始」回到这个残局、存进历史时它就是首帧
  //   （历史条目标 Endgame），背诵复盘也从残局开始。再点一次（按钮还在 egBar 上，摆盘模式下
  //   egBar 收起）→ 回「残局」模式重摆即可（进残局 = 清基准）。
  els.btn_eg_ok.onclick = function () {
    if (S.egLocked) {
      S.egLocked = false; S.egBase = null;
      setStat(null, T('egHint'));
    } else {
      S.egBase = G.moves.map(function (m) { return [m.x, m.y, m.c]; });
      S.egLocked = true;
      S.mode = 'place';
      [].forEach.call(els.seg_mode.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x.getAttribute('data-mode') === 'place');
      });
      setStat(null, T('egLockedHint'));
    }
    save(); refreshUI();
  };
  els.btn_eg_seq.onclick = function () { S.egSeq = true; save(); refreshUI(); };
  els.btn_eg_free.onclick = function () { S.egSeq = false; save(); refreshUI(); };
  els.btn_eg_b.onclick = function () { S.egColor = 1; save(); refreshUI(); };
  els.btn_eg_w.onclick = function () { S.egColor = 2; save(); refreshUI(); };
  // ★★ 2026-09-24（用户要求）：两个**开关型**按键（可同时开、可同时关）——
  //    AI 执黑 / AI 执白：
  //      · 只开黑 → 你执白；只开白 → 你执黑；
  //      · 两个都开 → **AI 与 AI 自打**（AI 自动接力落子，棋盘点击不再生效）；
  //      · 两个都关 → 没有 AI，你自己把黑白双方都下（辅助键随之置灰）。
  // ★ 2026-09-27（用户要求）：AI 执黑 / AI 执白的切换逻辑抽成具名函数 ——
  //   对局设置卡里的两个开关与「AI 执子」弹窗里的两个键共用同一份（「把对局设置里面的抄下来」）。
  function aiSideToggle(key) {
    var bOn = (key === 'b') ? !S.aiB : S.aiB;
    var wOn = (key === 'w') ? !S.aiW : S.aiW;
    setAiSides(bOn, wOn);
    // ★★ 2026-09-25（用户要求）：两个都选中 = 要 AI **自动**对弈 → 顺手解除「停手」，
    //   不用再让用户去点一次棋盘正中的 ▶。想停手时点那颗键（播放/暂停同款）。
    if (aiVsAi()) S.paused = false;
    syncSideUI();
    syncAiSidePop();
    save();
    refreshUI();
    refreshHeat(true);
    refreshCoach();
    // ★ 交换类开局流程还没走完时不动 AI —— 那一步由 chooseSwapSide 定色（这里只改设置）。
    if (!openActive()) maybeAi();
  }
  els.seg_side.onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var key = b.getAttribute('data-ai');
    if (!key) return;
    aiSideToggle(key);
  };
  // ★ 2026-09-27（用户要求）：「AI 执子」弹窗 —— 棋盘下右侧那颗键弹出的小横条：
  //   AI 执黑 / AI 执白 / 思考时间+数字框 / ✕ 关闭；前三个键各套虚线框；没有多余提示文字。
  function syncAiSidePop() {
    if (els.ai_side_b) els.ai_side_b.classList.toggle('on', !!S.aiB);
    if (els.ai_side_w) els.ai_side_w.classList.toggle('on', !!S.aiW);
    if (els.num_turn2) els.num_turn2.value = turnSecs();
  }
  if (els.ai_side_b) els.ai_side_b.onclick = function () { aiSideToggle('b'); };
  if (els.ai_side_w) els.ai_side_w.onclick = function () { aiSideToggle('w'); };
  if (els.num_turn2) {
    els.num_turn2.onchange = function () { setTurn(els.num_turn2.value); };
  }
  if (els.btn_aiside) {
    els.btn_aiside.onclick = function (e) {
      e.stopPropagation();
      if (els.aiSidePop) {
        var willOpen = els.aiSidePop.hidden;          // 点之前是收起的 → 这一下是「打开」
        els.aiSidePop.hidden = !els.aiSidePop.hidden;
        // ★ 2026-09-28（用户要求）：点开「AI 执子」时，若黑白两边都还没指定 → **默认落在 AI 执黑**
        //   （否则弹窗里两颗键都不亮，用户第一眼不知道该点哪颗）。已选过则完全尊重用户的选择。
        if (willOpen && !S.aiB && !S.aiW) {
          setAiSides(true, false);
          if (aiVsAi()) S.paused = false;
          syncSideUI(); save(); refreshUI(); refreshHeat(true); refreshCoach();
          if (!openActive()) maybeAi();
        }
        syncAiSidePop();
        els.btn_aiside.classList.toggle('on', !els.aiSidePop.hidden);
      }
    };
  }
  if (els.btn_ai_close) {
    els.btn_ai_close.onclick = function () {
      if (els.aiSidePop) els.aiSidePop.hidden = true;
      if (els.btn_aiside) els.btn_aiside.classList.remove('on');
    };
  }
  // ★ 2026-09-28（用户要求）：AI 执子弹窗改为**常驻 + 与界面融合** —— 不点「✕」就一直显示，
  //   且可以操作弹窗之外的任意按键（非模态）。故**移除**点弹窗外自动收起的逻辑。
  function turnSecs() { return +(S.turnMs / 1000).toFixed(3); }
  function setTurn(v) {
    // ★ 2026-09-19（用户要求）：输入框改成**秒**（原来是毫秒），范围 0.2 ~ 300 秒，
    //   最多保留三位小数。内部 S.turnMs 仍然存**毫秒**（引擎 /api/analyze 收的就是 ms，
    //   老设置里存的也是 ms，这样既不用迁移、也不会在两处各存一份）。
    var secs = Math.round((+v || 2) * 1000) / 1000;      // 先收到三位小数（+v||2：0/NaN 一律当 2 秒 ★ 默认 2s）
    secs = Math.max(0.2, Math.min(300, secs));           // 用户给的范围 0.2 ~ 300 秒
    S.turnMs = Math.round(secs * 1000);
    els.num_turn.value = String(secs);
    if (els.num_turn2) els.num_turn2.value = String(secs);   // ★ 2026-09-27：「AI 执子」弹窗里的输入框同步
    save();
  }
  els.num_turn.onchange = function () { setTurn(els.num_turn.value); };
  els.sel_rule.onchange = function () {
    var prev = +S.rule;
    S.rule = +els.sel_rule.value; save(); applyRuleHint();
    if (+S.rule === prev) { refreshUI(); return; }
    // ★★ 2026-09-24（用户要求）：「规则中如果在有子的情况下选择其他规则，**先不要清空棋盘**，
    //   以当前子的布局进行这个新的规则」。
    //   ⇒ 盘上有子就只换规则、保留布局，并把跟随规则的一切**就地重算**：
    //     · 终局判定（长连不赢 ↔ 长连算赢，或连珠黑方的长连从「赢」变「禁手不赢」）；
    //     · 禁手红叉（连珠系才画）；
    //     · 热力 / 指导视图（引擎拿到的 rule 变了，旧候选过期）；
    //     · 交换类开局流程（OPEN）直接作废 —— 它只能从空盘起跑，盘上有子时它没有意义。
    if (G.moves.length) {
      if (openActive()) OPEN = null;
      G.heat = []; G.nums = []; G.coach = [];
      forbiddenMarksInvalidate();
      recomputeOver();
      refreshUI();
      paint();
      setStat(null, T('ruleKept').replace('{r}', ((I18N[S.lang].ruleName || {})[+S.rule]) || ''));
      refreshHeat(true);
      refreshCoach();
      if (!G.over) maybeAi();           // 换完规则若轮到 AI（新规则下）→ 接着走
      return;
    }
    resetGame(false); openStart(); refreshUI();   // 空盘：照旧重开一局 + 重跑开局流程
  };
  els.sel_cores.onchange = function () { S.cores = +els.sel_cores.value; save(); applyEngineConfig(); };
  els.sel_hash.onchange = function () { S.hashMB = +els.sel_hash.value; save(); applyEngineConfig(); };
  els.chk_heat.onchange = function () { S.heat = !!els.chk_heat.checked; save(); refreshHeat(true).then(paint); };
  // ★ 指导视图开关（用户要求）：打开 → 立刻为当前局面铺方形四色热力（轮到用户才算）；
  //   关闭 → 立刻撤掉。
  els.chk_coach.onchange = function () {
    S.coach = !!els.chk_coach.checked; save();
    if (S.coach) refreshCoach().then(paint);
    else { clearCoach(); paint(); }
  };
  els.chk_num.onchange = function () { S.showNum = !!els.chk_num.checked; save(); paint(); };
  // ★ 三十三轮（用户要求）：「后台预热」—— 对手思考时后台持续计算。
  //   关 → 立刻停掉正在跑的预热并作废缓存（缓存是给 AI 那一手用的，脏了必须丢）；
  //   开 → 如果此刻正轮到对手思考，立刻起一轮（不必等下一次落子才生效）。
  els.chk_preheat.onchange = function () {
    S.preheat = !!els.chk_preheat.checked; save();
    if (!S.preheat) { preheatStop(true); if (S.coach) refreshCoach().then(paint); }
    else maybePreheat();
    refreshUI();
  };
  // ★ 五轮（用户要求）：「预览框」= 棋盘上鼠标悬停出现的蓝色圆角方块开关（默认开，见 S.previewOn）
  els.chk_preview.onchange = function () { S.previewOn = !!els.chk_preview.checked; save(); paint(); };
  // ★ 2026-09-27（用户要求）：「分析计算」= 摆棋评分的持续刷新强化版（开关型）：
  //   开 → 棋盘上持续计算落点评估（最佳点青色胶囊+边框，其余青→红四色渐变、越差越红越浅）；
  //   关 → 键文字变回「分析计算」，棋盘上所有评估标记消失。键文字由 liveAnaUI() 随状态走。
  if (els.btn_live) els.btn_live.onclick = liveAnaToggle;

  els.btn_save_rv.onclick = savePos;          // 复盘窗的键；主窗口里不可见（接线在 bootReview 里重设）

  // 初值回填（思考时间框里显示的是**秒**，内部 S.turnMs 仍是毫秒 —— 见 setTurn 的注释）
  els.num_turn.value = turnSecs();
  els.sel_rule.value = String(S.rule);
  els.chk_heat.checked = !!S.heat;
  els.chk_coach.checked = !!S.coach;
  els.chk_num.checked = !!S.showNum;
  els.chk_preview.checked = S.previewOn !== false;   // ★ 五轮：预览框开关（默认开）
  if (els.chk_preheat) els.chk_preheat.checked = S.preheat === true;   // ★ 09-28 口径：后台预热默认关（勾选开启）
  [].forEach.call(els.seg_mode.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === S.mode); });
  syncSideUI();                              // ★ 2026-09-24：AI 执黑 / AI 执白 两个开关的初值
  restoreGame();                              // 持久化：接着上次关闭前的局面

  if (HOST) {
    window.chrome.webview.addEventListener('message', function (ev) {
      tellHostDefer = true;                    // ★ 回调内 tellHost 走延迟（见函数头注释）
      try { onHostMsg(ev); } finally { tellHostDefer = false; }
    });
    window.__gbReadySent = true;   // 诊断标记（宿主 GB_TEST_DIAG 回读：ready 发出没有）
    window.chrome.webview.postMessage({ type: 'ready', theme: themeKey(), bg: pageBgHex(), lang: S.lang });
  } else {
    buildSelects();
  }

  /** 主窗口的宿主报文处理体（真实回调把它包进 try/finally —— 见 tellHostDefer 的说明）。 */
  function onHostMsg(ev) {
    var m = ev.data; if (!m) return;
    // ★ 新引擎后端：宿主**推**来的引擎输出 / 回执，直接转进 Worker（见 LocalAI.relay 注释）。
    //   这是 hot path（搜索时每秒几百行），只做一次转发，绝不在这里做任何解析。
    if (m.type === 'engineOut' || m.type === 'engineAck') {
      try { LocalAI.relay(m); } catch (e) {}
      return;
    }
    if (m.type === 'host') {
      G.host = {
        cpu: m.cpu || 4, threadsDefault: m.threadsDefault || 2, threadsMax: m.threadsMax || 3,
        memMB: m.memMB || 0, native: !!m.native
      };
      buildSelects();
    } else if (m.type === 'external') {
      ingestExternal(m.payload || '');
    } else if (m.type === 'historyInbox') {
      var t = m.text || '';
      if (t.charAt(0) === '"') { try { t = JSON.parse(t); } catch (e) {} }
      ingestExternal(t);
    } else if (m.type === 'clip') {
      // 宿主用 Win32 读到了系统剪贴板 → 回填并直接载入局面
      applyCodeText(m.text || '');
    } else if (m.type === 'histTxt') {
      // 宿主从「打开」对话框里读回了历史 txt → 入库（导入）
      importHist(m.text == null ? '' : String(m.text));
    } else if (m.type === 'histExported') {
      // 宿主真的把 txt 写盘了 → 状态行回一句（用户挑了路径之后才有这一条）
      setStat(null, T('expDone').replace('{n}', String(m.n || 0)));
    } else if (m.type === 'testHistRoundtrip') {
      // 端到端测试钩子（宿主 GB_TEST_HIST_ROUNDTRIP=1）→ 先塞两条历史再导出
      try { testHistExport(); }
      catch (e) { tellHost({ type: 'dbg', where: 'hook-threw', err: String((e && e.stack) || e) }); }
    } else if (m.type === 'testHistNowImport') {
      // 宿主写完那个 txt → 页面紧接着把它读回来（导入），形成完整的「导出 → 导入」闭环
      pickImport();
    } else if (m.type === 'testOpenReview') {
      // 端到端测试钩子（宿主 GB_TEST_OPEN_REVIEW=1）→ 真走一遍开复盘窗口的链路
      openReviewWindow(TEST_RV_RECORD, true);   // hist=true：按「从历史打开」那条路走
    } else if (m.type === 'testSavePos') {
      // 端到端测试钩子（宿主 GB_TEST_SAVE_POS=1）→ 真走一遍「保存局面 → 另存为」
      savePos();
    } else if (m.type === 'testAiBoth') {
      // 端到端测试钩子（宿主 GB_TEST_AI_BOTH=1）→ 真走一遍「AI 自动对弈」全流程
      testAiBoth();
    }
  }

  /** 端到端自检：**真点击**（不是直接改 S）走完 AI 自动对弈的整条路 ——
   *  「对弈」模式 → 重开空盘 → 两个 AI 执子开关都选中 → 棋盘正中那颗键停手 → 再继续。
   *  每一步都把手数 / 暂停态 / 正中键图标回传给宿主（宿主落进 %TEMP%\GomokuTrainer.log
   *  的 [msg] 行），于是「有没有真的自动下起来 / 能不能停 / 能不能续」在日志里可直接读。
   *  只在 GB_TEST_AI_BOTH=1 时由宿主发消息触发，正常使用碰不到。 */
  function testAiBoth() {
    var rep = function (tag) {
      tellHost({
        type: 'testSelfPlay', tag: tag, moves: G.moves.length,
        paused: !!S.paused, mode: S.mode, busy: !!G.busy,
        icon: els.btn_pause ? els.btn_pause.textContent : '',
        disabled: !!(els.btn_pause && els.btn_pause.disabled),
        ai: (S.aiB ? 'B' : '-') + (S.aiW ? 'W' : '-'),
      });
    };
    var bs = els.seg_side.querySelectorAll('button');
    var mb = els.seg_mode.querySelector('button[data-mode="pve"]');
    if (mb && S.mode !== 'pve') mb.click();          // ① 切「对弈」模式（摆盘模式下不走子）
    // ② 思考时间压到 1 秒 —— 否则默认 5 秒一手，观察窗里走不了几手（走真实输入框，不直接改 S）
    els.num_turn.value = '1';
    els.num_turn.onchange();
    els.btn_reset.click();                           // ③ 重开 → 空盘
    // ④ 让「两色都选中」这个**跳变真实发生**（若本来就是两色都开，先点掉黑再开回来）——
    //    否则点了个 no-op，就测不到「选中两色 → 自动开局」那一段。
    if (S.aiB && S.aiW) bs[0].click();               // 黑 off（此时只开白、轮黑，AI 不会动）
    if (!S.aiW) bs[1].click();
    if (!S.aiB) bs[0].click();                       // 黑 on → 两色都开 ⇒ 走自动开局分支
    rep('start');
    var iv = setInterval(function () { rep('tick'); }, 1000);
    setTimeout(function () { els.btn_pause.click(); rep('click-stop'); }, 9000);
    setTimeout(function () { els.btn_pause.click(); rep('click-resume'); }, 16000);
    setTimeout(function () { clearInterval(iv); rep('end'); }, 24000);
  }

  // ★ 2026-09-20：先把用户自定义的棋盘/页面色落成行内变量，再 applyTheme ——
  //   这样第一帧画出来就是他要的颜色，不会先闪一下默认护眼黄再跳过去。
  applyColors();
  applyTheme();
  applyLang();
  layoutBoard();
  refreshUI();
  // ★ 09-28（用户要求「页面初始化不能慢，界面直接到开局面」）：对齐 gomocalc 等开源实现的
  //   「界面先出」—— 首帧即棋盘对局态，启动遮罩立刻撤；历史抽屉渲染等重活让路到下一拍，
  //   不再挡在首帧前面（引擎 boot 本就与 UI 并行，见 LocalAI.boot 的注释）。
  bootDone();
  setTimeout(function () { renderDrawer(); }, 0);

  if ([5, 6, 7].indexOf(+S.rule) >= 0 && !G.moves.length) openStart();
  else openHint();

  // ★ 2026-09-20：「白先」（我执白）时开局第一手就该 AI 走 —— 原来这件事由「AI 先手」勾选框
  //   管（`S.aiFirst && …`），现在那个开关并进了「先后手」那一栏，于是这里统一交给 maybeAi()
  //   （它自己会判模式 / 复盘 / 终局 / 开局流程，并把「轮到 AI」才算的逻辑收在一处）。
  maybeAi();
}

/** 撤掉启动遮罩（HTML 里那块静态 #boot）。
 *  宿主窗口一出来铺的是原生「加载中…」（host.cpp 的 PaintSplash），页面这一层跟它无缝接上：
 *  boot() / bootReview() 把活干完才淡出移除 —— 于是「黑屏」的那段永远写着「加载中…」，
 *  而不是一片纯黑（用户要求）。 */
function bootDone() {
  var b = document.getElementById('boot');
  if (!b) return;
  b.classList.add('off');                    // CSS 里 .boot.off{opacity:0} —— 淡出而不是硬切
  setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 260);
}

function maybeAi() {
  if (RV_MODE || S.mode !== 'pve' || S.paused || G.review || G.over) return;
  // ★ 2026-09-24（AI 执子双开关）：轮到 AI 执的那一色就走 —— AI 自打时两色都自动接力。
  // ★ 三十三轮：轮到对手 → 收起预热计数器（缓存留给 aiMove）；
  //             没轮到 AI → 现在就是「对手思考期」，把后台预热拉起来。
  if (isAiColor(curColor())) { preheatStop(false); aiMove(); }
  else maybePreheat();
}

/** 引擎没应答 → 记离线、喊宿主补拉、安排自动重试。
 *  ★ 不再「一直停在 AI 思考中…」：药丸会明确显示「引擎未连接 · 正在重试…」，
 *    并且每 2.5s 自动再试一次，引擎一回来就自己接上。 */
function noteEngineDown() {
  G.engineOffline = true;
  LocalAI.boot();                          // 页面内 AI：自己重试 Worker（宿主已无引擎进程）
  scheduleEngineRetry();
  refreshUI();
}
/** 引擎离线期间的自动重试。最多 60 次（约 2.5 分钟）后停手 —— 再落子会重新触发。 */
function scheduleEngineRetry() {
  if (G.retryTimer || !G.engineOffline) return;
  if ((G.retryLeft = (G.retryLeft == null ? 60 : G.retryLeft - 1)) <= 0) return;
  G.retryTimer = setTimeout(function () {
    G.retryTimer = 0;
    if (!G.engineOffline || RV_MODE || G.review) return;
    if (S.mode !== 'pve' || S.paused || G.over) { G.retryLeft = null; return; }
    if (isAiColor(curColor())) aiMove();           // 轮到 AI → 再试一手（开跑即铺热力）
    else if (S.coach) refreshCoach();              // 轮到我方 → 只补指导视图（AI 热力不重铺，见 aiMove 注释）
    else scheduleEngineRetry();                    // 都不适用 → 只维持心跳
  }, 2500);
}

/** 字号随窗口缩放：棋盘与文字一起变大变小（用户要求）。 */
function fitFont() {
  var w = window.innerWidth, h = window.innerHeight;
  var px = Math.max(12, Math.min(20, Math.min(w / 95, h / 48)));
  document.documentElement.style.fontSize = px.toFixed(2) + 'px';
}
function save() { try { localStorage.setItem('gbcalc.settings.v1', JSON.stringify(S)); } catch (e) {} }

// 固定界面比例：Ctrl+滚轮 / Ctrl +- 0 一律不缩放（宿主侧也已关掉 WebView2 的缩放控制）
window.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', function (e) {
  if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) e.preventDefault();
}, false);

fitFont();
// ★ 同一个页面被三个窗口共用：带 ?rv=1 的是**复盘窗口**（纯棋盘 + 一行复盘键），
//   带 ?vis=1 的是**识图窗口**（左图片面板 + 右棋盘结果），
//   不带参数的是主窗口（人机 / 自由摆盘 + 仪表盘 + 历史）。三条启动路径完全分开。
var GB_BOOT = VIS_MODE ? bootVis : (RV_MODE ? bootReview : boot);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', GB_BOOT);
} else {
  GB_BOOT();
}
