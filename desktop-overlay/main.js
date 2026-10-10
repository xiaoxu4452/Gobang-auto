/* Electron main process. */


const { app, BrowserWindow, screen, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const APP_NAME = 'GomokuOverlay';
const SCAN_PORT = 8971;
const ENGINE_PORT = 8964;

function resolveShared() {
  
  const cands = [
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', 'Meter engine-server'),
  ];
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'GomokuEngine.exe'))) return c;
  }
  return cands[0];
}
const SHARED = resolveShared();
const PY = path.join(SHARED, 'python', 'runtime', 'python.exe');
const PY_FALLBACK = 'python';
const SCAN_SRV = path.join(SHARED, 'python', 'screen_scan_server.py');
const ENGINE_EXE = path.join(SHARED, 'GomokuEngine.exe');

const kids = [];
let win = null;
let cfg = { side: 'auto', auto: false, hz: 700 };

const LOCK = path.join(os.tmpdir(), 'gomoku_suite.lock');
function lockInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    return j && j.pid ? j : null;
  } catch (e) { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function acquireLock() {
  const cur = lockInfo();
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid)) return cur;   
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, app: APP_NAME, ts: Date.now() }));
  } catch (e) { return null; }
  return null;
}
function releaseLock() {
  const cur = lockInfo();
  if (cur && cur.pid === process.pid) { try { fs.unlinkSync(LOCK); } catch (e) {} }
}

function startScanServer() {
  const py = fs.existsSync(PY) ? PY : PY_FALLBACK;
  const src = fs.existsSync(SCAN_SRV)
    ? SCAN_SRV
    : path.join(__dirname, '..', 'engine-server', 'python', 'screen_scan_server.py');
  const k = spawn(py, [src], {
    cwd: path.dirname(src),
    env: Object.assign({}, process.env, { GB_SCAN_PORT: String(SCAN_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  k.stderr.on('data', (d) => process.stdout.write('[scan] ' + d));
  kids.push(k);
  return k;
}
function startEngine() {
  if (!fs.existsSync(ENGINE_EXE)) return null;
  
  const k = spawn(ENGINE_EXE, ['--as-backend'], { cwd: SHARED, stdio: 'ignore', detached: false });
  kids.push(k);
  return k;
}
function killKids() {
  kids.forEach((k) => { try { k.kill(); } catch (e) {} });
}

function post(port, urlPath, body) {
  return new Promise((res) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const r = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (resp) => {
      let b = '';
      resp.on('data', (c) => (b += c));
      resp.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } });
    });
    r.on('error', () => res(null));
    r.on('timeout', () => { r.destroy(); res(null); });
    r.write(data);
    r.end();
  });
}
function get(port, urlPath) {
  return new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 1500 }, (resp) => {
      let b = ''; resp.on('data', (c) => (b += c));
      resp.on('end', () => res({ ok: true, body: b }));
    });
    r.on('error', () => res(null));
    r.on('timeout', () => { r.destroy(); res(null); });
  });
}

let lastRect = null, busy = false, lastSig = '';

function buildBoard(black, white) {
  const b = Array.from({ length: 15 }, () => new Array(15).fill(0));
  (black || []).forEach((s) => { if (b[s.y] && s.x < 15) b[s.y][s.x] = 1; });
  (white || []).forEach((s) => { if (b[s.y] && s.x < 15) b[s.y][s.x] = 2; });
  return b;
}
function count(board) {
  let bn = 0, wn = 0;
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    if (board[y][x] === 1) bn++; else if (board[y][x] === 2) wn++;
  }
  return { bn, wn };
}

async function tick() {
  if (busy || !win) return;
  busy = true;
  try {
    const st = await post(SCAN_PORT, '/scan', lastRect ? { hint: lastRect } : {});
    if (!st) return;
    if (st.found) lastRect = st.board_rect;

    const board = buildBoard(st.black, st.white);
    const { bn, wn } = count(board);
    const toMoveIsBlack = (bn === wn);
    const ourIsBlack = cfg.side === 'auto'
      ? true                                   
      : (cfg.side === '1' || cfg.side === 1);
    const ourTurn = (toMoveIsBlack === ourIsBlack);

    let evalMine = null, best = null;
    
    if (st.found && ourTurn && !st.suspect) {
      const sig = JSON.stringify(board) + '|' + (ourIsBlack ? 'b' : 'w');
      if (sig !== lastSig) {
        lastSig = sig;
        const r = await post(ENGINE_PORT, '/api/analyze', {
          board, turnMs: 2500, topN: 1, rule: 0, lane: 'main',
        });
        if (r && !r.error) {
          if (typeof r.eval === 'number') evalMine = r.eval;   
          if (r.best) best = { x: r.best.x, y: r.best.y };
          if (cfg.auto && best && st.geometry) {
            const px = st.geometry.x_lines[best.x], py = st.geometry.y_lines[best.y];
            await post(ENGINE_PORT, '/api/click', { x: px, y: py });
          }
        }
      }
    }
    win.webContents.send('state', {
      found: st.found, offset: st.offset, board_rect: st.board_rect,
      geometry: st.geometry, black: st.black, white: st.white,
      suspect: st.suspect, eval: evalMine, best, turn: toMoveIsBlack ? 1 : 2,
    });
  } finally {
    busy = false;
  }
}

function createWindow() {
  const disp = screen.getAllDisplays().reduce((acc, d) => ({
    x: Math.min(acc.x, d.bounds.x), y: Math.min(acc.y, d.bounds.y),
    x2: Math.max(acc.x2, d.bounds.x + d.bounds.width),
    y2: Math.max(acc.y2, d.bounds.y + d.bounds.height),
  }), { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity });

  win = new BrowserWindow({
    x: disp.x, y: disp.y, width: disp.x2 - disp.x, height: disp.y2 - disp.y,
    transparent: true, frame: false, resizable: false, movable: false,
    hasShadow: false, skipTaskbar: true, focusable: true,
    alwaysOnTop: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });   
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.on('closed', () => { win = null; });
}

ipcMain.on('set-mouse', (_e, over) => {
  if (win) win.setIgnoreMouseEvents(!over, { forward: true });
});
ipcMain.on('close', () => { app.quit(); });
ipcMain.on('set-side', (_e, v) => { cfg.side = String(v); lastSig = ''; });
ipcMain.on('set-auto', (_e, v) => { cfg.auto = !!v; });
ipcMain.on('set-hz', (_e, v) => {
  cfg.hz = Math.max(200, Math.min(5000, +v || 700));
  if (timer) { clearInterval(timer); timer = setInterval(tick, cfg.hz); }
});

let timer = null;

app.disableHardwareAcceleration?.();   
app.whenReady().then(async () => {
  const holder = acquireLock();
  if (holder) {
    dialog.showMessageBox({
      type: 'warning',
      title: '无法启动',
      message: '另一个程序正在运行',
      detail: `检测到「${holder.app === 'GomokuEngine' ? '五子棋引擎 (GomokuEngine)' : '桌面覆盖层'}」已经启动。\n同一时间只能运行其中一个，请先关闭它再启动本程序。`,
      buttons: ['确定'],
    }).then(() => app.quit());
    return;
  }
  startScanServer();
  if (!await get(ENGINE_PORT, '/health')) startEngine();
  createWindow();
  timer = setInterval(tick, cfg.hz);
  setTimeout(tick, 800);
});

app.on('will-quit', () => {
  if (timer) clearInterval(timer);
  releaseLock();
  post(SCAN_PORT, '/quit', {}).catch?.(() => {});
  killKids();
});
app.on('window-all-closed', () => { app.quit(); });
