#!/usr/bin/env bash
# 端到端：AI 执黑 + AI 执白 都选中 → 棋盘正中那颗键 = 自动对弈的开关键（可停 / 可续）。
# 页面自己走真实点击路径（切对弈模式 → 重开空盘 → 点两个开关 → 点正中键停手 → 再点继续），
# 每一步把手数回报给宿主；宿主写进 %TEMP%\GomokuTrainer.log 的 [msg] 行 —— 这里读日志判定。
set -u
export no_proxy='127.0.0.1,localhost'
export NO_PROXY='127.0.0.1,localhost'

ROOT="C:/Users/harve/Desktop/Gobang auto"
LOG="$(cygpath -u "$(cmd //c echo %TEMP% 2>/dev/null | tr -d '\r')" 2>/dev/null || echo "/c/Users/harve/AppData/Local/Temp")/GomokuTrainer.log"

echo "日志：$LOG"
: > "$LOG" 2>/dev/null || true

cd "$ROOT/Meter GomokuTrainer"
GB_TEST_AI_BOTH=1 "./Desktop GomokuTrainer.exe" >/dev/null 2>&1 &
sleep 32

echo
echo "== [msg] testSelfPlay 轨迹（手数应：开始后涨 → click-stop 后停住 → click-resume 后再涨）"
grep -a "testSelfPlay" "$LOG" | sed 's/^\[[0-9:.]*\] //' | head -40

echo
echo "== 原生引擎进程（三车道 → 应恰好 3 个；>3 即 spawn 竞态/泄漏）"
powershell -NoProfile -Command "
  \$p=@(Get-Process RapfiEngine-avx512,RapfiEngine-avx2 -ErrorAction SilentlyContinue)
  if(\$p.Count -eq 0){ '  (无进程)' } else {
    \$p | Sort-Object Id | ForEach-Object { '  pid={0,-6} {1,-24} Threads={2}' -f \$_.Id, \$_.ProcessName, \$_.Threads.Count }
    '  → 共 {0} 个进程' -f \$p.Count
  }
" 2>/dev/null

echo
echo "== 判定"
"C:/Users/harve/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" -e "
const fs=require('fs');
const txt=fs.readFileSync(process.argv[1],'latin1');
const rows=[];
for (const line of txt.split(/\r?\n/)) {
  const i=line.indexOf('{\"type\":\"testSelfPlay\"');
  if (i<0) continue;
  try { rows.push(JSON.parse(line.slice(i))); } catch(e){}
}
if (!rows.length) { console.log('✗ 一条 testSelfPlay 都没收到（钩子没跑到）'); process.exit(1); }
const at=(t)=>rows.filter(r=>r.tag===t).pop();
const start=at('start'), stop=at('click-stop'), resume=at('click-resume'), end=at('end');
const ticks=rows.filter(r=>r.tag==='tick');
console.log('start      : moves='+start.moves+' mode='+start.mode+' ai='+start.ai+' icon='+start.icon+' paused='+start.paused);
console.log('click-stop : moves='+stop.moves+' paused='+stop.paused+' icon='+stop.icon);
console.log('click-resume: moves='+resume.moves+' paused='+resume.paused+' icon='+resume.icon);
console.log('end        : moves='+end.moves+' paused='+end.paused+' icon='+end.icon);
const t=ticks.map(r=>r.moves);
console.log('各 tick 手数: '+t.join(' '));
// 判定：① 起手后手数真的在涨（自动对弈）；② 停手后手数不再涨；③ 继续后又开始涨。
const grew = (end.moves > start.moves);
const pauseHeld = (function(){
  // 取 click-stop 之后、click-resume 之前的 tick
  const si=rows.findIndex(r=>r.tag==='click-stop'), ri=rows.findIndex(r=>r.tag==='click-resume');
  if (si<0||ri<0) return false;
  const mid=rows.slice(si,ri).filter(r=>r.tag==='tick').map(r=>r.moves);
  if (mid.length<2) return false;
  // ★ 基线取「停手后的第一个 tick」而不是点击瞬间那次的 moves：点击与 tick 采样之间有几十毫秒，
  //   刚落下的那一手常常还没被 tick 采到（实测 click-stop 报 7、第一个 tick 已是 8），
  //   拿 stop.moves 当基线会把「确实停住了」误判成失败。要求此后每个 tick 都钉在同一手数。
  const base=mid[0];
  return mid.every(v=>v===base);
})();
const resumed = (end.moves > resume.moves);
// ★ 图标（▶ / ❚❚）不用字符比对：本脚本用 latin1 读日志（为了不炸多字节），日志里的 UTF-8 字节
//   到了这里就是乱码，`start.icon === '❚❚'` 永远不成立（假红）。开关键语义直接看 paused 更硬。
const iconOk = (start.paused === false) && (stop.paused === true) && (resume.paused === false);
console.log('---');
console.log((grew?'✓':'✗')+' 自动对弈真的在下子（'+start.moves+' → '+end.moves+'）');
console.log((pauseHeld?'✓':'✗')+' 点正中键 → 停手（停手后手数不再涨）');
console.log((resumed?'✓':'✗')+' 再点一下 → 继续自动对弈');
console.log((iconOk?'✓':'✗')+' 正中键状态机：走子 paused=false → 停手 true → 继续 false');
" "$LOG"

echo
echo "== 收尾"
taskkill //IM "Desktop GomokuTrainer.exe" //F >/dev/null 2>&1 || true
taskkill //IM "RapfiEngine-avx512.exe" //F >/dev/null 2>&1 || true
taskkill //IM "RapfiEngine-avx2.exe" //F >/dev/null 2>&1 || true
echo done
