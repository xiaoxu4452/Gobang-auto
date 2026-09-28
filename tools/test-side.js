// 先后手（我执黑/白）判定回归测试
// 直接从 bookmarklet.js 里抠出真实源码片段执行，确保测的就是发布出去的那份逻辑。
// 当前产品策略：AUTO_SIDE=false —— 取消自动识别，先后手完全由用户手动指定。
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'engine-server', 'resources', 'bookmarklet.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return SRC.slice(a, b + endMarker.length);
}

const clampSrc = grab('function clampSide(v)', '})();');
const ssotSrc = grab('function mySideMask()', 'return SF(m === 0 ? \'me_black\' : \'me_white\');\n  }');

const ST = {
  zh: {
    me_black: 'AUTO-B', me_white: 'AUTO-W', me_pending: 'PENDING',
    me_black_m: 'LOCK-B', me_white_m: 'LOCK-W',
    side_manual: '锁定', side_auto: '自动', side_pending: '待定',
  },
};

function makeCtx(side, userSide, autoSide) {
  const S = { side: side, userSide: userSide, lang: 'zh' };
  const SF = (k) => ST.zh[k] || k;
  const T = (k) => k;
  const decl = 'var AUTO_SIDE = ' + (autoSide === undefined ? 'false' : String(autoSide)) + ';';
  const body = '"use strict";' + decl + '\n' + clampSrc + '\n' + ssotSrc +
    '\nreturn {S:S, AUTO_SIDE:AUTO_SIDE, mySideMask:mySideMask, myColorCode:myColorCode, oppColorCode:oppColorCode,' +
    ' sideIsManual:sideIsManual, setUserSide:setUserSide, sideStatusText:sideStatusText, sideResolved:sideResolved};';
  return new Function('S', 'SF', 'T', body)(S, SF, T);
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.log('  FAIL ' + name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}

console.log('=== 1. 自动识别默认关闭 ===');
eq('AUTO_SIDE 默认 false', makeCtx(-1, -1).AUTO_SIDE, false);

console.log('=== 2. 手动锁定优先（含残留 userSide 的脏状态） ===');
[[0, 0], [0, 1], [0, -1], [1, 0], [1, 1], [1, -1]].forEach(([sd, us]) => {
  const c = makeCtx(sd, us);
  eq(`side=${sd} userSide=${us} → mask`, c.mySideMask(), sd);
  eq(`side=${sd} userSide=${us} → color`, c.myColorCode(), sd === 0 ? 1 : 2);
  eq(`side=${sd} userSide=${us} → opp`, c.oppColorCode(), sd === 0 ? 2 : 1);
  eq(`side=${sd} userSide=${us} → manual`, c.sideIsManual(), true);
  eq(`side=${sd} userSide=${us} → 残留已清`, c.S.userSide, -1);
});

console.log('=== 3. 自动识别已关闭 → 未手动选择就是「未确定」，绝不猜 ===');
[[0], [1]].forEach(([us]) => {
  const c = makeCtx(-1, us);
  eq(`userSide=${us} 但 AUTO_SIDE=false → mask`, c.mySideMask(), -1);
  eq(`userSide=${us} → color 0`, c.myColorCode(), 0);
  eq(`userSide=${us} → opp 0`, c.oppColorCode(), 0);
  eq(`userSide=${us} → resolved false`, c.sideResolved(), false);
  eq(`userSide=${us} → 清空残留`, c.S.userSide, -1);
});

console.log('=== 4. 开启 AUTO_SIDE 时旧自动逻辑仍然可用（可逆性） ===');
eq('AUTO 黑', makeCtx(-1, 0, true).mySideMask(), 0);
eq('AUTO 白', makeCtx(-1, 1, true).mySideMask(), 1);
eq('AUTO 未定', makeCtx(-1, -1, true).mySideMask(), -1);
eq('手动优先于自动', makeCtx(1, 0, true).mySideMask(), 1);

console.log('=== 5. 存档类型漂移自愈（"1"/字符串/2/null/true） ===');
[['"1"', '1', 1], ['"0"', '0', 0], ['2', 2, -1], ['null', null, -1], ['true', true, -1], ['"white"', 'white', 1]].forEach(([label, raw, want]) => {
  eq(`side=${label} → 夹到`, makeCtx(raw, -1).S.side, want);
});
{
  const c = makeCtx('1', 0);
  eq('side="1"(字符串) 仍算手动锁定', c.sideIsManual(), true);
  eq('side="1" → mask=白', c.mySideMask(), 1);
  eq('side="1" → userSide 被清', c.S.userSide, -1);
}

console.log('=== 6. setUserSide 在自动识别关闭时绝不写入 ===');
{
  const c = makeCtx(-1, -1);
  eq('setUserSide(0) 返回 false', c.setUserSide(0), false);
  eq('userSide 仍为 -1', c.S.userSide, -1);
  eq('mask 仍为未定', c.mySideMask(), -1);
}
{
  const c = makeCtx(1, -1);
  eq('锁定白时 setUserSide(0) 返回 false', c.setUserSide(0), false);
  eq('锁定白时 mask 仍为白', c.mySideMask(), 1);
}

console.log('=== 7. sideStatusText ===');
eq('锁定黑', makeCtx(0, -1).sideStatusText(), 'LOCK-B');
eq('锁定白', makeCtx(1, -1).sideStatusText(), 'LOCK-W');
eq('未选择', makeCtx(-1, -1).sideStatusText(), 'PENDING');
eq('自动关闭时 userSide=0 也不算黑', makeCtx(-1, 0).sideStatusText(), 'PENDING');

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
