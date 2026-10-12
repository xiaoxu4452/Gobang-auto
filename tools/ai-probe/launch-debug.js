// 以带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 的环境启动练习器（CDP 诊断用）。
'use strict';
const { spawn } = require('child_process');
const exe = 'C:/Users/harve/Desktop/Gobang auto/desktop-calculator/build/Desktop GomokuTrainer.exe';
const child = spawn(exe, [], {
  cwd: 'C:/Users/harve/Desktop/Gobang auto/desktop-calculator/build',
  env: Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333',
  }),
  stdio: 'ignore',
  detached: false,
});
child.on('error', (e) => { console.error('spawn failed:', e.message); process.exit(1); });
child.on('exit', (c) => console.log('trainer exited', c));
console.log('launched pid=' + child.pid);
setTimeout(() => process.exit(0), 5000);
