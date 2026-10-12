'use strict';
/*
 * _proj_golden.js  --  one-shot parity harness for the "proj" recognizer port.
 *
 * Goal: prove that the C++ port (desktop-vision/src/gbproj.cpp, exposed as
 * GbvRecognizeJson mode="proj") reproduces the original APK JS pipeline
 * (assets_index.html scan* functions) cell-by-cell.
 *
 * Method (byte-identical inputs are the key):
 *   1. Render axis-aligned synthetic boards directly into a raw RGBA buffer.
 *      The SAME bytes feed both sides:
 *        - JS golden : the RGBA buffer is handed to scanImageArb() verbatim.
 *        - C++ port  : the buffer is encoded to an uncompressed 24-bit BMP
 *                      (lossless) and POSTed as base64 to /recognize.
 *   2. Compare the resulting 15x15 grid cell-by-cell.
 *
 * The node shim has no 2D canvas, so scanRotate() degrades to a no-op; the
 * fixtures are axis-aligned so scanAutoLevel() is a no-op on both sides.
 *
 * Usage:  node tools/_proj_golden.js
 * Exit code 0 == every fixture matched.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, '.tmp-apk-analysis', 'assets_index.html');
const EXE = path.join(ROOT, 'desktop-vision', 'build', 'GomokuVision.exe');
const OUTDIR = path.join(ROOT, 'tmp_proj_golden');
const PORT = 8977;
const SIZE = 15;
const W = 1200;

/* ------------------------------------------------------------------ */
/* 1) load the JS golden pipeline                                     */
/* ------------------------------------------------------------------ */
function loadGolden() {
  const html = fs.readFileSync(HTML, 'utf8');
  const startTok = '/* ---------- \u56fe\u7247\u8bc6\u8c31';
  const endTok = 'function applyScan(res) {';
  const i0 = html.indexOf(startTok);
  const i1 = html.indexOf(endTok);
  if (i0 < 0 || i1 < 0 || i1 <= i0) throw new Error('cannot locate scan* slice in assets_index.html');
  const slice = html.slice(i0, i1);

  class ImageDataShim {
    constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
  }
  // No 2D canvas in node -> scanRotate() catches and returns its input.
  const documentShim = { createElement() { throw new Error('no canvas in node shim'); } };

  const factory = new Function(
    'document', 'ImageData', 'N', 'EMPTY', 'BLACK', 'WHITE',
    slice + '\nreturn { scanImageArb: scanImageArb, scanImageOnce: scanImageOnce, scanImageCore: scanImageCore };'
  );
  return factory(documentShim, ImageDataShim, 15, 0, 1, 2);
}

/* ------------------------------------------------------------------ */
/* 2) deterministic board rendering into a raw RGBA buffer            */
/* ------------------------------------------------------------------ */
function newBuf() { return new Uint8Array(W * W * 4); }

function fill(buf, c) {
  for (let i = 0; i < W * W; i++) {
    const o = i * 4;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
  }
}
function setPx(buf, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const o = (y * W + x) * 4;
  buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
}
function hline(buf, y, x0, x1, c) { for (let x = x0; x <= x1; x++) setPx(buf, x, y, c); }
function vline(buf, x, y0, y1, c) { for (let y = y0; y <= y1; y++) setPx(buf, x, y, c); }
// filled disc (radius rad, color inner -> outer stroke ring of width sw)
function disc(buf, cx, cy, rad, inner, stroke, sw) {
  const r2 = rad * rad;
  const ri = Math.max(0, rad - sw); const ri2 = ri * ri;
  const x0 = Math.floor(cx - rad - 1), x1 = Math.ceil(cx + rad + 1);
  const y0 = Math.floor(cy - rad - 1), y1 = Math.ceil(cy + rad + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy; const d2 = dx * dx + dy * dy;
      if (d2 <= r2) setPx(buf, x, y, d2 <= ri2 ? inner : stroke);
    }
  }
}
function ring(buf, cx, cy, rad, w, c) {
  const ro2 = rad * rad, ri = Math.max(0, rad - w), ri2 = ri * ri;
  const x0 = Math.floor(cx - rad - 1), x1 = Math.ceil(cx + rad + 1);
  const y0 = Math.floor(cy - rad - 1), y1 = Math.ceil(cy + rad + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy; const d2 = dx * dx + dy * dy;
      if (d2 <= ro2 && d2 > ri2) setPx(buf, x, y, c);
    }
  }
}

function geomPx() {
  const cell = W / (SIZE + 1.2);
  const margin = cell;
  const px = (i) => margin + i * cell;
  return { cell, px };
}

// palette: { board, line, black, white, stroke }
function renderBoard(pal, stones, lastIdx, frame) {
  const { cell, px } = geomPx();
  const buf = newBuf();
  fill(buf, pal.board);
  if (frame) {
    // decorative dark frame band just outside the grid (lifts p5/p95 spread
    // so the low-contrast gate admits empty boards; exercises trim/border paths)
    const fw = 70;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        if (x < fw || y < fw || x >= W - fw || y >= W - fw) setPx(buf, x, y, frame);
      }
    }
  }
  const g0 = Math.round(px(0)), g1 = Math.round(px(SIZE - 1));
  for (let i = 0; i < SIZE; i++) {
    const p = Math.round(px(i));
    hline(buf, p, g0, g1, pal.line);
    vline(buf, p, g0, g1, pal.line);
  }
  const bw = 2;
  hline(buf, g0, g0, g1, pal.line); hline(buf, g0 + 1, g0, g1, pal.line);
  hline(buf, g1, g0, g1, pal.line); hline(buf, g1 - 1, g0, g1, pal.line);
  vline(buf, g0, g0, g1, pal.line); vline(buf, g0 + 1, g0, g1, pal.line);
  vline(buf, g1, g0, g1, pal.line); vline(buf, g1 - 1, g0, g1, pal.line);
  const sr = Math.max(2, Math.round(cell * 0.08));
  for (const s of [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]]) {
    disc(buf, px(s[0]), px(s[1]), sr, pal.line, pal.line, 0);
  }
  const r = cell * 0.44;
  const sw = Math.max(2, Math.round(cell * 0.09));
  stones.forEach((st, idx) => {
    const cx = px(st[1]), cy = px(st[0]);
    if (st[2] === 1) disc(buf, cx, cy, r, pal.black, pal.stroke, sw);
    else disc(buf, cx, cy, r, pal.white, pal.stroke, sw);
    if (lastIdx === idx) ring(buf, cx, cy, r + 1.5, Math.max(2, Math.round(cell * 0.06)), [214, 74, 58]);
  });
  return buf;
}

/* ------------------------------------------------------------------ */
/* 3) lossless 24-bit BMP writer (bottom-up rows, BGR)                */
/* ------------------------------------------------------------------ */
function writeBmp(file, buf) {
  const h = W, w = W;
  const rowRaw = w * 3;
  const pad = (4 - (rowRaw % 4)) % 4;
  const rowSz = rowRaw + pad;
  const pixSize = rowSz * h;
  const fileSize = 54 + pixSize;
  const b = Buffer.alloc(fileSize);
  b.write('BM', 0);
  b.writeUInt32LE(fileSize, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(pixSize, 34);
  b.writeInt32LE(2835, 38);
  b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    const off = 54 + y * rowSz;
    for (let x = 0; x < w; x++) {
      const o = (srcY * w + x) * 4;
      b[off + x * 3] = buf[o + 2];
      b[off + x * 3 + 1] = buf[o + 1];
      b[off + x * 3 + 2] = buf[o];
    }
  }
  fs.writeFileSync(file, b);
}

/* ------------------------------------------------------------------ */
/* 4) fixtures                                                        */
/* ------------------------------------------------------------------ */
const PAL_LIGHT = { board: [214, 178, 128], line: [96, 72, 40], black: [20, 20, 22], white: [250, 250, 248], stroke: [150, 130, 100] };
const PAL_DARK = { board: [28, 28, 34], line: [150, 150, 160], black: [6, 6, 10], white: [246, 248, 252], stroke: [170, 170, 180] };
const PAL_PALE = { board: [250, 248, 240], line: [150, 144, 128], black: [20, 20, 22], white: [255, 255, 255], stroke: [120, 118, 110] };

const MID_BLACK = [[7, 7], [7, 8], [8, 7], [6, 6], [9, 9], [5, 7]];
const MID_WHITE = [[7, 6], [8, 8], [6, 7], [9, 8], [8, 6]];

function buildFixtures() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const fixtures = [];

  function add(name, pal, stones, lastIdx, frame) {
    const buf = renderBoard(pal, stones, lastIdx, frame);
    const bmp = path.join(OUTDIR, name + '.bmp');
    writeBmp(bmp, buf);
    fixtures.push({ name: name, bmp: bmp, buf: buf, stones: stones });
  }

  add('empty_light', PAL_LIGHT, [], undefined);
  add('empty_dark', PAL_DARK, [], undefined);
  add('empty_light_framed', PAL_LIGHT, [], undefined, [60, 60, 62]);
  add('empty_dark_framed', PAL_DARK, [], undefined, [40, 40, 44]);
  add('pal', PAL_PALE, MID_BLACK.map(s => s.concat([1])).concat(MID_WHITE.map(s => s.concat([2]))), 0);
  add('mid_light', PAL_LIGHT, MID_BLACK.map(s => s.concat([1])).concat(MID_WHITE.map(s => s.concat([2]))), 3);
  add('mid_dark', PAL_DARK, MID_BLACK.map(s => s.concat([1])).concat(MID_WHITE.map(s => s.concat([2]))), 1);
  return fixtures;
}

/* ------------------------------------------------------------------ */
/* 5) compare                                                         */
/* ------------------------------------------------------------------ */
function gridFromLists(black, white) {
  const g = new Array(SIZE * SIZE).fill(0);
  for (const s of black) g[s.y * SIZE + s.x] = 1;
  for (const s of white) g[s.y * SIZE + s.x] = 2;
  return g;
}

function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await httpReq({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/health' });
      if (r.status === 200 || r.status === 503) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const golden = loadGolden();
  let fixtures = buildFixtures();
  if (process.env.GB_PROJ_ONLY) fixtures = fixtures.filter((f) => f.name === process.env.GB_PROJ_ONLY);
  const dbg = !!process.env.GB_PROJ_DEBUG;
  if (dbg) global.__dbgcc = [];

  const child = spawn(EXE, ['--recognize'], {
    cwd: path.dirname(EXE),
    env: Object.assign({}, process.env, { GB_RECOG_PORT: String(PORT), GB_PROJ_DEBUG: dbg ? '1' : '', GB_PROJ_DEBUG_CELLS: dbg ? '1' : '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d.toString(); });

  let pass = 0, fail = 0;
  let lastJsDbg = [];
  try {
    const up = await waitHealth();
    if (!up) {
      console.error('[golden] vision.exe did not become healthy on :' + PORT);
      console.error(childErr);
      process.exit(2);
    }

    for (const fx of fixtures) {
      // JS golden
      if (dbg) global.__dbgcc.length = 0;
      const jsRes = golden.scanImageArb({
        data: new Uint8ClampedArray(fx.buf), width: W, height: W,
      });
      if (dbg) lastJsDbg = global.__dbgcc.slice();
      const jsOk = !!(jsRes && jsRes.ok);
      if (dbg) {
        const cc = { E: 0, W: 0, B: 0 };
        for (const e of lastJsDbg) cc[e.c] = (cc[e.c] || 0) + 1;
        console.log('  JS entries=' + lastJsDbg.length + ' preC1=' + JSON.stringify(cc) + ' finalStats=' + JSON.stringify(jsRes.stats));
      }

      // C++ port
      const b64 = fs.readFileSync(fx.bmp).toString('base64');
      const reqBody = JSON.stringify({ mode: 'proj', size: 15, image: b64 });
      const resp = await httpReq({
        host: '127.0.0.1', port: PORT, method: 'POST', path: '/recognize',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
      }, reqBody);
      let cpp;
      try { cpp = JSON.parse(resp.body); } catch (e) {
        console.log('[golden] ' + fx.name + '  C++ bad json: ' + resp.body.slice(0, 200));
        fail++;
        continue;
      }
      const cppOk = !!(cpp && cpp.ok);

      if (jsOk !== cppOk) {
        fail++;
        console.log('[golden] ' + fx.name + '  OK-MISMATCH js.ok=' + jsOk + ' ('
          + (jsRes && jsRes.reason) + ') cpp.ok=' + cppOk + ' (' + (cpp && cpp.err) + ')');
        continue;
      }
      if (!jsOk) {
        pass++;
        console.log('[golden] ' + fx.name + '  MATCH(reject)  js="' + (jsRes && jsRes.reason) + '"');
        continue;
      }
      const jsGrid = jsRes.grid;
      const cppGrid = gridFromLists(cpp.black || [], cpp.white || []);

      const diffs = [];
      for (let k = 0; k < SIZE * SIZE; k++) {
        if (jsGrid[k] !== cppGrid[k]) diffs.push(k);
      }
      if (diffs.length === 0) {
        pass++;
        console.log('[golden] ' + fx.name + '  MATCH  (' + (cpp.diag && cpp.diag.stones) + ' stones)');
      } else {
        fail++;
        const cells = diffs.slice(0, 12).map((k) => '(' + (k % SIZE) + ',' + Math.floor(k / SIZE) + ') js=' + jsGrid[k] + ' cpp=' + cppGrid[k]);
        console.log('[golden] ' + fx.name + '  DIFF ' + diffs.length + ' cells: ' + cells.join(' '));
        console.log('  js  xy0=(' + jsRes.xs[0] + ',' + jsRes.ys[0] + ') xy14=(' + jsRes.xs[14] + ',' + jsRes.ys[14] + ') stats=' + JSON.stringify(jsRes.stats));
        console.log('  cpp xy0=(' + cpp.geometry.xs[0] + ',' + cpp.geometry.ys[0] + ') xy14=(' + cpp.geometry.xs[14] + ',' + cpp.geometry.ys[14] + ') diag=' + JSON.stringify(cpp.diag));
      }
    }
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }

  if (dbg) {
    const cppMap = new Map();
    for (const line of childErr.split(/\r?\n/)) {
      const m = line.match(/^CDBG (\d+) (\d+) (.*)$/);
      if (!m) continue;
      const f = m[3].trim().split(/\s+/);
      cppMap.set(m[1] + ',' + m[2], f);
    }
    const keys = ['bgLocal', 'dk', 'br', 'ctr', 'mid', 'midY', 'mctr', 'dd', 'bc', 'ws', 'sB', 'sW', 'le'];
    const idx = { bgLocal: 0, mG: 1, mB: 2, dk: 3, br: 4, ctr: 5, mid: 6, midY: 7, mctr: 8, dd: 9, bc: 10, ws: 11, sB: 12, sW: 13, le: 14 };
    let cellDiffs = 0, c1Diffs = 0;
    for (const e of lastJsDbg) {
      const f = cppMap.get(e.i + ',' + e.j);
      if (!f) { console.log('  cell (' + e.i + ',' + e.j + ') missing in cpp dump'); cellDiffs++; continue; }
      const bad = [];
      for (const k of keys) {
        const jv = e[k], cv = parseFloat(f[idx[k]]);
        if (!isFinite(jv) || !isFinite(cv)) continue;
        if (Math.abs(jv - cv) > 0.02) bad.push(k + ' js=' + jv + ' cpp=' + cv);
      }
      if (bad.length) { console.log('  cell (' + e.i + ',' + e.j + ') ' + bad.join('  ')); cellDiffs++; }
      // c1 is the last-but-one token region; JS field is e.c
      const cc = f[16];
      if (e.c !== cc) { c1Diffs++; if (c1Diffs <= 20) console.log('  c1 (' + e.i + ',' + e.j + ') js=' + e.c + ' cpp=' + cc + '  sB js=' + e.sB + ' cpp=' + f[12] + '  sW js=' + e.sW + ' cpp=' + f[13]); }
    }
    console.log('[golden] cell-diff mismatches: ' + cellDiffs + ' / ' + lastJsDbg.length + ' ; c1 mismatches: ' + c1Diffs);
  }

  if (process.env.GB_PROJ_DEBUG && childErr) console.log('--- cpp debug ---\n' + childErr.trim());
  console.log('[golden] pass=' + pass + ' fail=' + fail);
  if (fail === 0 && pass > 0) process.exit(0);
  process.exit(1);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(3); });
