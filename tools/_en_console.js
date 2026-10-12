// 把 engine-server.js 控制台输出的中文行全部翻成英文（挂控制台需求：全英文）
// 只动 log(...) 运行时字符串；注释/HTML 文案不动。
const fs = require('fs');
const P = 'C:/Users/harve/Desktop/Gobang auto/engine-server/engine-server.js';
let s = fs.readFileSync(P, 'utf8');
const N0 = s.length;
const R = [
  // [old, new] —— 逐条精确替换，替换数量必须恰好 1 次
  ["log('[boot] 检测到「' + _who + '」的登记（pid=' + _holder.pid + '）——按\"可共存\"策略继续。\\n')",
   "log('[boot] detected existing registration of ' + _who + ' (pid=' + _holder.pid + ') -- coexist policy, continuing.\\n')"],
  ["const _who = (_holder.app === 'GomokuOverlay') ? '桌面覆盖层' : '五子棋引擎';",
   "const _who = (_holder.app === 'GomokuOverlay') ? 'desktop-overlay' : 'gomoku-engine';"],
  ["log('[boot] 引擎已在运行 → 已为你打开启动器页面 http://127.0.0.1:' + PORT + '/\\n')",
   "log('[boot] engine already running -> opened launcher page http://127.0.0.1:' + PORT + '/\\n')"],
  ["log('[boot] 打开浏览器失败：' + (e && e.message ? e.message : e) +\n        '\\n        请手动访问 http://127.0.0.1:' + PORT + '/\\n')",
   "log('[boot] failed to open browser: ' + (e && e.message ? e.message : e) +\n        '\\n        please open http://127.0.0.1:' + PORT + '/ manually\\n')"],
  ["log('\\n（' + Math.round(delayMs / 1000) + ' 秒后自动关闭本窗口）\\n')",
   "log('\\n(this window closes automatically in ' + Math.round(delayMs / 1000) + 's)\\n')"],
  ["log('  [WARN] side-to-move mismatch: board says ' + (expSide === 1 ? 'BLACK' : 'WHITE') +\n          ' but sequence (len=' + moves.length + ') implies ' + (seqSide === 1 ? 'BLACK' : 'WHITE') +\n          ' (bn=' + bn0 + ' wn=' + wn0 + ') — 棋盘子数异常（识别噪声），评估视角可能不可靠\\n')",
   "log('  [WARN] side-to-move mismatch: board says ' + (expSide === 1 ? 'BLACK' : 'WHITE') +\n          ' but sequence (len=' + moves.length + ') implies ' + (seqSide === 1 ? 'BLACK' : 'WHITE') +\n          ' (bn=' + bn0 + ' wn=' + wn0 + ') -- stone-count anomaly (recognition noise), eval perspective may be unreliable\\n')"],
  ["log('[native] 旁边没有 rapfi-native/（缺 config.toml）→ 走 WASM\\n')",
   "log('[native] no rapfi-native/ beside (missing config.toml) -> falling back to WASM\\n')"],
  ["if (!has512 && !has2) { log('[native] rapfi-native/ 里没有引擎 exe → 走 WASM\\n'); return probed; }",
   "if (!has512 && !has2) { log('[native] no engine exe in rapfi-native/ -> falling back to WASM\\n'); return probed; }"],
  ["} else log('[native] --cpuid 查询失败 → 保守选 avx2\\n');",
   "} else log('[native] --cpuid query failed -> conservatively using avx2\\n');"],
  ["} else log('[native] 没有 GomokuVision.exe 可问 cpuid → 保守选 avx2\\n');",
   "} else log('[native] no GomokuVision.exe to query cpuid -> conservatively using avx2\\n');"],
  ["} else { log('[native] 引擎存活探针失败 → 走 WASM\\n'); return probed; }",
   "} else { log('[native] engine liveness probe failed -> falling back to WASM\\n'); return probed; }"],
  ["log('[native] 原生 Rapfi 就绪：' + probed.exe + '\\n')",
   "log('[native] native Rapfi ready: ' + probed.exe + '\\n')"],
  ["} catch (e) { log('[native] 探测异常（' + (e.message || e) + '）→ 走 WASM\\n'); return probed = null; }",
   "} catch (e) { log('[native] probe error (' + (e.message || e) + ') -> falling back to WASM\\n'); return probed = null; }"],
  ["log('[engine exit][' + lane.name + '] ' + code + (closing ? ' (正常退出)' : ' —— 下次发命令时自动重启\\n'))",
   "log('[engine exit][' + lane.name + '] ' + code + (closing ? ' (clean exit)' : ' -- will auto-restart on next command\\n'))"],
  ["log('[engine][' + lane.name + '] 原生引擎不在了 → 重新拉起\\n')",
   "log('[engine][' + lane.name + '] native engine gone -> respawning\\n')"],
  ["catch (e) { log('[engine][' + lane.name + '] 写命令失败：' + (e.message || e) + '\\n'); }",
   "catch (e) { log('[engine][' + lane.name + '] command write failed: ' + (e.message || e) + '\\n'); }"],
  ["log('[engine][' + lane.name + '] 原生 Rapfi 已挂接（' + nat.exe + '）\\n')",
   "log('[engine][' + lane.name + '] native Rapfi attached (' + nat.exe + ')\\n')"],
  ["log('[engine][' + lane.name + '] 原生挂接失败（' + (e.message || e) + '）→ 回落 WASM\\n')",
   "log('[engine][' + lane.name + '] native attach failed (' + (e.message || e) + ') -> falling back to WASM\\n')"],
  ["log('[boot] :' + PORT + ' 已经是我们自己的引擎在服务（复用，不再启动第二份）\\n')",
   "log('[boot] :' + PORT + ' already served by our own engine (reusing, not starting a second copy)\\n')"],
  ["log('[boot] 端口预检超时（可能正在被别的进程初始化）——继续按正常流程启动\\n')",
   "log('[boot] port precheck timed out (possibly initializing elsewhere) -- continuing normal startup\\n')"],
  ["log('[boot] [' + lj.name + '] 档位：threads=' + specs[sj].threads + ', hash=' + (specs[sj].hashKB / 1024).toFixed(0) + 'MB\\n')",
   "log('[boot] [' + lj.name + '] tier: threads=' + specs[sj].threads + ', hash=' + (specs[sj].hashKB / 1024).toFixed(0) + 'MB\\n')"],
  ["log('[boot] 引擎档位：总 threads=' + (mainT + subT + fwdT) + ' / ' + cpuAll + ' 核(按核心数分档默认：一半+0/1/2/4，GB_THREADS 可拉满), 总 hash='",
   "log('[boot] engine tiers: total threads=' + (mainT + subT + fwdT) + ' / ' + cpuAll + ' cores (default tiering: half+0/1/2/4 by cores, GB_THREADS to override), total hash='"],
  ["log('\\n[boot] 端口 ' + PORT + ' 上已经是我们自己的引擎在跑（另一次启动抢先了）。\\n')",
   "log('\\n[boot] port ' + PORT + ' already served by our own engine (another start won the race).\\n')"],
  ["log('[backend] 由桌面助手在后台拉起，不打开浏览器\\n')",
   "log('[backend] spawned by desktop assistant in background, not opening browser\\n')"],
];
let bad = 0;
for (const [o, n] of R) {
  const c = s.split(o).length - 1;
  if (c !== 1) { console.log('!! match count ' + c + ' for: ' + o.slice(0, 60)); bad++; continue; }
  s = s.replace(o, n);
}
if (bad) { console.log('ABORT: ' + bad + ' patterns unmatched'); process.exit(1); }
fs.writeFileSync(P, s);
console.log('OK: ' + R.length + ' replacements, size ' + N0 + ' -> ' + s.length);
// 复核：运行时 log 行不应再有中文
const left = s.split('\n').map((l, i) => [i + 1, l]).filter(([i, l]) =>
  /\blog\(/.test(l) && /[\u4e00-\u9fff]/.test(l) && !/^\s*\d+:\s*\/\//.test(l));
console.log('remaining log-lines with Han:', left.length);
left.forEach(([i, l]) => console.log('  ' + i + ': ' + l.trim().slice(0, 80)));
