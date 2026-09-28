#!/usr/bin/env bash
# 受控测量：干净环境下数清「每车道几个进程、几线程」，再手工改 THREAD_NUM 看是否跟着动。
set -u
export no_proxy='127.0.0.1,localhost'
export NO_PROXY='127.0.0.1,localhost'

ROOT="C:/Users/harve/Desktop/Gobang auto"
B="http://127.0.0.1:8965/engine"

echo "== 0) 先清干净"
taskkill //IM "Desktop GomokuTrainer.exe" //F >/dev/null 2>&1
taskkill //IM "RapfiEngine-avx512.exe" //F >/dev/null 2>&1
taskkill //IM "RapfiEngine-avx2.exe" //F >/dev/null 2>&1
sleep 2
count() {
  powershell -NoProfile -Command "
    \$p=@(Get-Process RapfiEngine-avx512,RapfiEngine-avx2 -ErrorAction SilentlyContinue)
    if(\$p.Count -eq 0){ '  (无进程)'; exit }
    \$p | Sort-Object Id | ForEach-Object { '  pid={0,-6} {1,-24} Threads={2}' -f \$_.Id, \$_.ProcessName, \$_.Threads.Count }
    '  → 共 {0} 个进程（三车道正常应为 3）' -f \$p.Count
  " 2>/dev/null
}
count

echo
echo "== 1) 起训练器（页面自己定档位）"
cd "$ROOT/Meter GomokuTrainer"
("./Desktop GomokuTrainer.exe" >/dev/null 2>&1 &)
sleep 10
curl -sS -m 10 --noproxy '*' "$B/status"; echo
count

echo
echo "== 2) 手工把 main 车道改成 THREAD_NUM 1（若真是活配置，线程数应立刻塌下来）"
curl -sS -m 10 --noproxy '*' -X POST --data-binary "START 15" "$B/cmd?lane=main" >/dev/null
curl -sS -m 10 --noproxy '*' -X POST --data-binary "INFO THREAD_NUM 1" "$B/cmd?lane=main" >/dev/null
curl -sS -m 10 --noproxy '*' -X POST --data-binary "INFO HASH_SIZE 65536" "$B/cmd?lane=main" >/dev/null
sleep 2
count

echo
echo "== 3) 收尾"
taskkill //IM "Desktop GomokuTrainer.exe" //F >/dev/null 2>&1
taskkill //IM "RapfiEngine-avx512.exe" //F >/dev/null 2>&1
echo done
