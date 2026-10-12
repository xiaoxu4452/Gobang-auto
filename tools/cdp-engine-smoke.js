// 冒烟脚本：通过 CDP 在面板页内直接驱动 /engine/* 原生路由。
// 用法: node cdp-engine-smoke.js <step>   step ∈ status | ensure
const target = process.argv[3];
const step = process.argv[2] || 'status';

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) { console.error('NO-PAGE-TARGET'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await new Promise(r => { ws.onopen = r; });

  const expr = step === 'ensure'
    ? `fetch('/engine/ensure?lane=main').then(r => r.text())`
    : `Promise.all([fetch('/engine/status').then(r => r.text())]).then(v => v[0])`;

  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000,
  });
  if (r.exceptionDetails) console.error('PAGE-EXC:', JSON.stringify(r.exceptionDetails).slice(0, 500));
  console.log('RESULT:', r.result && r.result.value);
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
