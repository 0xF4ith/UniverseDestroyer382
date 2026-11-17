// Universe Destroyer 382 · full-screen terminal UI: red/black "personal terminal" look, folders on the left, data panels,
// the knight cat on CAM-01. Pure ANSI truecolor, no extra packages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import type { Bot } from './bot.js';
import { setSink, type Level } from './logger.js';
import { netPnl } from './positionManager.js';
import type { Position } from './types.js';

// ---------------------------------------------------------------- palette
const C = {
  black: 0x000000, ink: 0x050000, red: 0xe10600, red2: 0xff1a12, dark: 0x5a0000, dark2: 0x2a0000, line: 0xb31010,
  salmon: 0xff8a80, pink: 0xffb3ad, white: 0xf2f2f2, grey: 0x9a9a9a, dim: 0x5c5c5c, faint: 0x2c2c2c,
  green: 0x3ddc84, amber: 0xffc14d, metal1: 0x2f2f33, metal2: 0x4a4a50, metal3: 0x6b6b72, rivet: 0x8d8d95,
};
const rgb = (c: number) => `${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

// ---------------------------------------------------------------- screen buffer
class Screen {
  w = 0; h = 0;
  ch: string[] = []; fg: number[] = []; bg: number[] = []; bold: Uint8Array = new Uint8Array();
  private prev: string[] = [];
  resize(w: number, h: number) {
    this.w = w; this.h = h; const n = w * h;
    this.ch = new Array(n).fill(' '); this.fg = new Array(n).fill(C.white); this.bg = new Array(n).fill(C.black); this.bold = new Uint8Array(n);
    this.prev = [];
  }
  clear(bg = C.black) { this.ch.fill(' '); this.fg.fill(C.white); this.bg.fill(bg); this.bold.fill(0); }
  set(x: number, y: number, c: string, fg?: number, bg?: number, b = false) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x; this.ch[i] = c;
    if (fg !== undefined) this.fg[i] = fg; if (bg !== undefined) this.bg[i] = bg; this.bold[i] = b ? 1 : 0;
  }
  text(x: number, y: number, s: string, fg: number, bg?: number, b = false, maxW = 9999) {
    const arr = [...s].slice(0, Math.max(0, maxW));
    arr.forEach((c, k) => this.set(x + k, y, c, fg, bg, b));
    return arr.length;
  }
  fill(x: number, y: number, w: number, h: number, c: string, fg: number, bg: number) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, fg, bg);
  }
  /** Debug snapshot: the buffer as an HTML page (used to check the layout without a terminal). */
  toHtml(): string {
    const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
    let h = '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000}pre{margin:0;font:15px/18px "DejaVu Sans Mono",monospace;letter-spacing:0}span{display:inline-block;width:9px;height:18px;text-align:center;overflow:hidden;vertical-align:top}</style><pre>';
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x, c = this.ch[i];
        const esc = c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
        h += `<span style="color:${hex(this.fg[i])};background:${hex(this.bg[i])}${this.bold[i] ? ';font-weight:bold' : ''}">${esc}</span>`;
      }
      h += '\n';
    }
    return h + '</pre>';
  }
  /** Diff by row: only rows that changed get rewritten. */
  flush(): string {
    let out = '';
    for (let y = 0; y < this.h; y++) {
      let row = '', lf = -1, lb = -1, lbold = -1;
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (this.bold[i] !== lbold) { row += this.bold[i] ? '\x1b[1m' : '\x1b[22m'; lbold = this.bold[i]; }
        if (this.fg[i] !== lf) { row += `\x1b[38;2;${rgb(this.fg[i])}m`; lf = this.fg[i]; }
        if (this.bg[i] !== lb) { row += `\x1b[48;2;${rgb(this.bg[i])}m`; lb = this.bg[i]; }
        row += this.ch[i];
      }
      if (row !== this.prev[y]) { out += `\x1b[${y + 1};1H` + row; this.prev[y] = row; }
    }
    return out + '\x1b[0m';
  }
}

// ---------------------------------------------------------------- cat frames
interface CatData { w: number; h: number; fps: number; frames: Buffer[] }
function loadCat(): CatData | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '../assets/cat.json'), path.join(process.cwd(), 'assets/cat.json')]) {
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { w: number; h: number; fps: number; frames: string[] };
    return { w: j.w, h: j.h, fps: j.fps, frames: j.frames.map((f) => Buffer.from(f, 'base64')) };
  }
  return null;
}

// ---------------------------------------------------------------- banner font (dotted #, like the design)
const FONT: Record<string, string[]> = {
  L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######'],
  A: ['..###..', '.##.##.', '##...##', '##...##', '#######', '##...##', '##...##'],
  D: ['######.', '##...##', '##...##', '##...##', '##...##', '##...##', '######.'],
  E: ['#######', '##.....', '##.....', '#####..', '##.....', '##.....', '#######'],
  R: ['######.', '##...##', '##...##', '######.', '##.##..', '##..##.', '##...##'],
  U: ['##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
  '3': ['######.', '.....##', '.....##', '.#####.', '.....##', '.....##', '######.'],
  '8': ['.#####.', '##...##', '##...##', '.#####.', '##...##', '##...##', '.#####.'],
  '2': ['.#####.', '##...##', '.....##', '...###.', '.##....', '##.....', '#######'],
};
const banner = (word: string) => FONT.L.map((_, r) => '.' + [...word].map((ch) => FONT[ch]?.[r] ?? '.......').join('.') + '.');

// ---------------------------------------------------------------- UI state
const FOLDERS = ['POSITIONS', 'LIVE FEED', 'FILTERS', 'LADDER', 'RECLAIM', 'SYSTEM LOG'];
interface LogLine { t: number; level: Level; text: string }
interface FeedRow { mint: string; symbol: string; t: number }

export async function startTui(bot: Bot, opts: { sim: boolean; onQuit: () => void; snapshot?: { cols: number; rows: number; afterMs: number; file?: (folder: number) => string } }) {
  const scr = new Screen();
  const cat = loadCat();
  const logs: LogLine[] = [];
  const feed: FeedRow[] = [];
  const pnlSeries: number[] = [0];
  let folder = 0, sel = 0, confirmSell: string | null = null, frame = 0, started = Date.now();
  let caption = { text: 'standing guard', t: 0, hot: false };

  setSink((level, text) => {
    logs.push({ t: Date.now(), level, text });
    if (logs.length > 400) logs.shift();
    if (level === 'trade') caption = { text: text.startsWith('BUY') ? 'target acquired' : 'slash! ' + (text.match(/\+[\d.]+ SOL/)?.[0] ?? ''), t: Date.now(), hot: true };
  });
  bot.on('token', (t: { mint: string; symbol: string }) => { feed.unshift({ mint: t.mint, symbol: t.symbol, t: Date.now() }); if (feed.length > 200) feed.pop(); });

  const snap = opts.snapshot;
  const out = snap ? ({ write: () => true, on: () => out, columns: snap.cols, rows: snap.rows } as unknown as NodeJS.WriteStream) : process.stdout;
  const size = () => { scr.resize(Math.max(40, out.columns || 160), Math.max(20, out.rows || 48)); };
  size();
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  out.on('resize', () => { size(); out.write('\x1b[2J'); });
  const restore = () => out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  process.on('exit', restore);

  if (!snap && process.stdin.isTTY) process.stdin.setRawMode(true);
  if (!snap) process.stdin.resume();
  const onKey = (k: string) => {
    if (k === '\u0003' || k === 'q' || k === 'Q') { restore(); opts.onQuit(); return; }
    if (confirmSell) {
      if (k === 'y' || k === 'Y') { void bot.pm.manualSell(confirmSell); }
      confirmSell = null; return;
    }
    if (k >= '1' && k <= '6') { folder = Number(k) - 1; sel = 0; }
    else if (k === '\t') folder = (folder + 1) % FOLDERS.length;
    else if (k === '\x1b[A') sel = Math.max(0, sel - 1);
    else if (k === '\x1b[B') sel++;
    else if (k === 'p' || k === 'P') { bot.paused = !bot.paused; }
    else if ((k === 'x' || k === 'X') && folder === 0) { const p = bot.pm.open[sel]; if (p) confirmSell = p.mint; }
  };
  if (!snap) process.stdin.on('data', (d: Buffer) => onKey(d.toString()));

  await bot.start().catch((e) => { restore(); console.error((e as Error).message); process.exit(1); });

  // ------------------------------------------------------------ drawing helpers
  const box = (x: number, y: number, w: number, h: number, col: number, fillBg = C.black) => {
    scr.fill(x, y, w, h, ' ', C.white, fillBg);
    for (let i = 1; i < w - 1; i++) { scr.set(x + i, y, '─', col, fillBg); scr.set(x + i, y + h - 1, '─', col, fillBg); }
    for (let j = 1; j < h - 1; j++) { scr.set(x, y + j, '│', col, fillBg); scr.set(x + w - 1, y + j, '│', col, fillBg); }
    scr.set(x, y, '┌', col, fillBg); scr.set(x + w - 1, y, '┐', col, fillBg); scr.set(x, y + h - 1, '└', col, fillBg); scr.set(x + w - 1, y + h - 1, '┘', col, fillBg);
  };
  const center = (x: number, w: number, y: number, s: string, fg: number, bg?: number, b = false) => scr.text(x + Math.max(0, Math.floor((w - s.length) / 2)), y, s, fg, bg, b, w);
  const sol = (n: number, d = 4) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(d)}`;
  const usd = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `$${Math.round(n)}`);
  const ago = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`; };
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const rpad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padStart(n));
  const nowPrice = (p: Position) => { const c = bot.ctx.get(p.mint); return c ? c.mcapSol / c.supply : 0; };
  const unreal = (p: Position) => p.realizedSol + p.tokensLeft * nowPrice(p) - p.entrySol - p.entryGasSol - p.rentSol - p.exitGasSol + p.rentBackSol;

  // static noise field for the background (red asterisks like the reference)
  let noiseSeed = 7;
  const nrnd = () => ((noiseSeed = (noiseSeed * 16807) % 2147483647) / 2147483647);
  let noise: Array<[number, number, number, string]> = [];
  const buildNoise = () => {
    noise = []; noiseSeed = 7;
    for (let i = 0; i < scr.w * scr.h * 0.05; i++) noise.push([Math.floor(nrnd() * scr.w), Math.floor(nrnd() * scr.h), nrnd(), nrnd() < 0.85 ? '*' : nrnd() < 0.5 ? ',' : '.']);
  };
  let lastW = 0;

  // ------------------------------------------------------------ frame
  const draw = () => {
    frame++;
    if (scr.w !== lastW) { buildNoise(); lastW = scr.w; }
    const W = scr.w, H = scr.h;
    scr.clear(C.black);
    if (W < 110 || H < 34) {
      center(0, W, Math.floor(H / 2), 'make the terminal bigger: 110 x 34 or more', C.salmon);
      center(0, W, Math.floor(H / 2) + 1, `now ${W} x ${H}`, C.dim);
      out.write(scr.flush()); return;
    }
    // metal frame
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x > 1 && x < W - 2 && y > 0 && y < H - 1) continue;
      const v = ((x * 7 + y * 13) % 5) / 5;
      scr.set(x, y, (x + y) % 9 === 0 ? '▒' : ' ', C.metal3, mix(C.metal1, C.metal2, v));
    }
    for (const [x, y] of [[1, 0], [W - 2, 0], [1, H - 1], [W - 2, H - 1], [Math.floor(W / 2), 0], [Math.floor(W / 2), H - 1]]) scr.set(x, y, '◘', C.rivet, C.metal2);
    // background noise inside
    const t = Date.now() / 1000;
    for (const [x, y, v, c] of noise) {
      if (x < 2 || x >= W - 2 || y < 2 || y >= H - 1) continue;
      const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + v * 40);
      const col = v < 0.7 ? mix(C.black, C.red, 0.15 + 0.25 * tw) : mix(C.black, C.grey, 0.12 + 0.18 * tw);
      scr.set(x, y, c, col, C.black);
    }
    // title bar
    scr.fill(2, 1, W - 4, 1, ' ', C.black, C.red);
    const mode = bot.c.dryRun ? (opts.sim ? 'DEMO · SIMULATED FEED' : 'DEMO') : 'LIVE';
    scr.text(3, 1, `PERSONAL TERMINAL · UNIVERSE DESTROYER 382 · ${mode}`, C.black, C.red, true);
    scr.text(W - 5, 1, '✕', C.white, C.red, true);

    const top = 3, bottom = H - 3;               // body rows
    const L = 26, R = W >= 150 ? 50 : 0;
    const lx = 4, cx = lx + L + 2, cw = W - 4 - cx - (R ? R + 2 : 2), rx = cx + cw + 2;

    // ---- left: folders
    center(lx, L, top, 'FOLDERS', C.salmon, undefined, true);
    center(lx, L, top + 1, '‾‾‾‾‾‾‾', C.salmon);
    FOLDERS.forEach((f, i) => {
      const y = top + 3 + i * 4;
      if (i === folder) {
        scr.fill(lx, y, L, 3, ' ', C.white, C.white);
        scr.fill(lx + 2, y, L - 4, 3, ' ', C.salmon, 0x1e1e1e);
        center(lx + 2, L - 4, y + 1, `${i + 1}  ${f}`, C.salmon, 0x1e1e1e);
      } else { box(lx, y, L, 3, C.red); center(lx, L, y + 1, `${i + 1}  ${f}`, C.salmon); }
    });
    // quick stats under the folders
    const s = bot.summary();
    const qy = top + 3 + FOLDERS.length * 4 + 1;
    if (qy + 7 < bottom) {
      box(lx, qy, L, 8, C.line);
      const rows: Array<[string, string, number]> = [
        ['ENTRIES', bot.paused ? 'PAUSED' : 'ARMED', bot.paused ? C.amber : C.green],
        ['OPEN', `${s.open}/${bot.c.maxOpen}`, C.white],
        ['WATCHING', String(bot.watch.size), C.white],
        ['SOL/USD', `$${bot.sol.usd.toFixed(2)}`, C.white],
        ['NET PNL', sol(s.realized), s.realized >= 0 ? C.green : C.salmon],
        ['UPTIME', ago(started), C.grey],
      ];
      rows.forEach(([k, v, col], i) => { scr.text(lx + 2, qy + 1 + i, k, C.dim); scr.text(lx + L - 2 - v.length, qy + 1 + i, v, col, undefined, true); });
    }
    // corner badge: plain text (no logo); you can watch the bot's wallet on Axiom
    const by = bottom - 3;
    if (by > qy + 8) {
      box(lx, by, L, 4, C.grey, 0x0b0b0b);
      center(lx, L, by + 1, 'A X I O M', C.white, 0x0b0b0b, true);
      center(lx, L, by + 2, bot.kp ? 'track this wallet there' : 'watch the wallet there', C.dim, 0x0b0b0b);
    }

    // ---- center: header bar + content panel
    box(cx, top, cw, 3, 0xa84a4a, C.dark);
    center(cx, cw, top + 1, FOLDERS[folder].charAt(0) + FOLDERS[folder].slice(1).toLowerCase(), C.salmon, C.dark, true);
    const py = top + 4, ph = bottom - py + 1;
    box(cx, py, cw, ph, C.red2);
    scr.fill(cx, py, cw, 1, ' ', C.white, C.red2);
    const ix = cx + 2, iw = cw - 4, iy = py + 2, ih = ph - 3;
    // scanlines
    for (let j = 0; j < ih; j += 2) for (let i = 0; i < iw; i++) scr.set(ix + i, iy + j, scr.ch[(iy + j) * W + ix + i], undefined, C.ink);
    [drawPositions, drawFeed, drawFilters, drawLadder, drawReclaim, drawLog][folder](ix, iy, iw, ih);

    // ---- right column: wallet, cam, hex
    if (R) {
      const wy = top, wh = 9;
      scr.fill(rx, wy, R, 1, ' ', C.white, C.red);
      scr.text(rx + 1, wy, 'WALLET passphrase [_keySearch];', C.pink, C.red, true);
      box(rx, wy + 1, R, wh - 1, C.line, C.dark2);
      const wallet = bot.kp ? bot.kp.publicKey.toBase58() : 'demo wallet';
      const feedName = opts.sim ? 'SIMULATED' : bot.feed.tradesEnabled ? 'PUMPPORTAL + KEY' : 'PUMPPORTAL + CURVE';
      const wr: Array<[string, string, number]> = [
        ['MODE', bot.c.dryRun ? 'DEMO (DRY_RUN)' : 'LIVE', bot.c.dryRun ? C.amber : C.red2],
        ['FEED', feedName, C.white],
        ['WALLET', wallet.length > 20 ? wallet.slice(0, 6) + '…' + wallet.slice(-6) : wallet, C.white],
        ['CASH', `${s.cash.toFixed(4)} SOL`, C.white],
        ['IN POSITIONS', `${s.openValue.toFixed(4)} SOL`, C.white],
        ['GAS · RENT BACK', `${s.gas.toFixed(4)} · ${s.rentBack.toFixed(4)}`, C.grey],
        ['TP HITS', s.tiers.map((n, i) => `${i + 1}:${n}`).join(' '), C.salmon],
      ];
      wr.forEach(([k, v, col], i) => { scr.text(rx + 2, wy + 2 + i, k, C.dim, C.dark2); scr.text(rx + R - 2 - v.length, wy + 2 + i, v, col, C.dark2, true); });

      const hexH = Math.min(9, Math.max(0, bottom - (wy + wh) - 22));
      const camY = wy + wh + 1, camH = bottom - camY + 1 - (hexH ? hexH + 1 : 0);
      drawCam(rx, camY, R, camH);
      if (hexH) drawHex(rx, bottom - hexH + 1, R, hexH);
    }

    // ---- status bar
    const sb = H - 2;
    scr.fill(2, sb, W - 4, 1, ' ', C.grey, 0x140000);
    const help = confirmSell ? `SELL ALL of $${bot.pm.open.find((p) => p.mint === confirmSell)?.symbol ?? '?'} now?  [Y] yes   any other key cancels`
      : '[1-6] folders  [TAB] next  [↑↓] select  [X] sell selected  [P] pause entries  [Q] quit';
    scr.text(4, sb, help, confirmSell ? C.amber : C.grey, 0x140000, !!confirmSell);
    const right = `${bot.c.dryRun ? 'DEMO' : 'LIVE'} · ${new Date().toLocaleTimeString()}`;
    scr.text(W - 4 - right.length, sb, right, C.salmon, 0x140000);
    out.write(scr.flush());
  };

  // ------------------------------------------------------------ views
  function drawPositions(x: number, y: number, w: number, h: number) {
    const open = bot.pm.open;
    sel = Math.min(sel, Math.max(0, open.length - 1));
    // banner
    const b = banner('UD382');
    const bannerFits = b[0].length <= w && h > 24;
    let yy = y;
    if (bannerFits) {
      b.forEach((row, r) => center(x, w, yy + r, row, mix(C.white, C.red, r / 12)));
      yy += b.length + 1;
    }
    const cols = 'TOKEN       ENTRY     NOW     X     LADDER  AGE    KILL   PNL SOL';
    scr.fill(x, yy, w, 1, ' ', C.pink, C.dark); scr.text(x + 1, yy, cols, C.pink, C.dark, true, w - 2); yy++;
    if (!open.length) { scr.text(x + 1, yy + 1, bot.paused ? 'entries paused. press P to arm.' : 'no open positions. scanning for $6.8k-$7.5k entries…', C.dim); yy += 3; }
    open.slice(0, Math.max(1, Math.floor(h / 2))).forEach((p, i) => {
      const live = p.lastMcapUsd, mult = live / p.entryMcapUsd;
      const hit = new Set(p.tiersHit.map((t) => t.level));
      const ladder = [1, 2, 3, 4].map((l) => (hit.has(l) ? '■' : '□')).join(' ');
      const left = bot.c.killAfterMin * 60_000 - (Date.now() - p.openedAt);
      const kill = hit.has(1) ? 'safe' : left > 0 ? ago(Date.now() - left) : 'ARMED';
      const pnl = unreal(p);
      const isSel = i === sel, bg = isSel ? 0x7a0a0a : undefined;
      if (isSel) scr.fill(x, yy, w, 1, ' ', C.white, bg!);
      let cx2 = x + 1;
      const put = (s: string, n: number, col: number, r = false) => { scr.text(cx2, yy, r ? rpad(s, n) : pad(s, n), col, bg, isSel); cx2 += n + 1; };
      put('$' + (p.symbol || p.mint.slice(0, 5)), 10, C.white);
      put(usd(p.entryMcapUsd), 8, C.grey, true);
      put(usd(live), 8, mult >= 1 ? C.green : C.salmon, true);
      put(mult.toFixed(2) + 'x', 6, mult >= 3 ? C.green : C.white, true);
      put(ladder, 8, C.salmon);
      put(ago(p.openedAt), 6, C.grey, true);
      put(kill, 6, kill === 'ARMED' ? C.amber : C.grey, true);
      put(sol(pnl), 9, pnl >= 0 ? C.green : C.salmon, true);
      yy++;
    });
    // cumulative PnL chart (closed trades)
    const ch = y + h - yy - 2;
    if (ch >= 5) {
      const cy = yy + 1;
      scr.text(x + 1, cy, 'CUMULATIVE NET PNL · closed trades', C.dim);
      drawChart(x + 1, cy + 1, w - 2, ch - 1, pnlSeries);
    }
  }

  /** Line chart on a braille grid (2x4 dots per cell) for a smooth line, like the reference's white graph. */
  function drawChart(x: number, y: number, w: number, h: number, data: number[]) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i += 2) if (j % 2 === 0) scr.set(x + i, y + j, '·', C.faint);
    if (data.length < 2) { scr.text(x, y + Math.floor(h / 2), 'waiting for the first closed trade', C.dim); return; }
    const min = Math.min(0, ...data), max = Math.max(0.0001, ...data);
    const DW = w * 2, DH = h * 4, dots = new Uint8Array(w * h);
    const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
    const plot = (dx: number, dy: number) => { if (dx < 0 || dy < 0 || dx >= DW || dy >= DH) return; dots[Math.floor(dy / 4) * w + Math.floor(dx / 2)] |= BIT[dy % 4][dx % 2]; };
    const X = (i: number) => (i / (data.length - 1)) * (DW - 1), Y = (v: number) => (DH - 1) - ((v - min) / (max - min || 1)) * (DH - 1);
    const zeroRow = Math.floor(Y(0) / 4);
    for (let i = 0; i < w; i++) scr.set(x + i, y + zeroRow, '─', C.dim);
    for (let i = 1; i < data.length; i++) {
      const x0 = X(i - 1), y0 = Y(data[i - 1]), x1 = X(i), y1 = Y(data[i]);
      const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let k = 0; k <= n; k++) plot(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n));
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const d = dots[j * w + i];
      if (d) scr.set(x + i, y + j, String.fromCharCode(0x2800 + d), C.white, undefined, true);
    }
    const step = Math.max(1, Math.floor(data.length / 7));
    for (let i = 0; i < data.length; i++) if (i === data.length - 1 || i % step === 0) {
      scr.set(x + Math.round(X(i) / 2), y + Math.floor(Y(data[i]) / 4), '◉', data[i] >= 0 ? C.white : C.salmon, undefined, true);
    }
    const last = data.at(-1)!;
    scr.text(x + w - 12, y, rpad(sol(last), 11), last >= 0 ? C.green : C.salmon, undefined, true);
  }

  function drawFeed(x: number, y: number, w: number, h: number) {
    scr.fill(x, y, w, 1, ' ', C.pink, C.dark); scr.text(x + 1, y, 'AGE   TOKEN        MCAP      STATUS', C.pink, C.dark, true);
    feed.slice(0, h - 2).forEach((r, i) => {
      const c = bot.ctx.get(r.mint), mc = c ? c.mcapSol * bot.sol.usd : 0;
      const wch = bot.watch.get(r.mint), held = bot.pm.open.find((p) => p.mint === r.mint);
      let st = 'watching', col = C.dim;
      if (held) { st = 'HOLDING · ' + held.tiersHit.map((t) => 'TP' + t.level).join(' '); col = C.green; }
      else if (bot.pm.has(r.mint)) { st = 'traded'; col = C.grey; }
      else if (wch?.checking) { st = 'checking holders…'; col = C.amber; }
      else if (wch?.lastResult) { st = wch.lastResult.pass ? 'PASS' : 'REJECT · ' + wch.lastResult.reasons[0]; col = wch.lastResult.pass ? C.green : C.salmon; }
      else if (!wch) { st = 'dropped (too old)'; col = C.faint; }
      else if (mc >= bot.c.entryMcapMin && mc <= bot.c.entryMcapMax) { st = 'IN RANGE'; col = C.white; }
      const yy = y + 1 + i;
      scr.text(x + 1, yy, rpad(ago(r.t), 5), C.dim);
      scr.text(x + 7, yy, pad('$' + r.symbol, 12), C.white);
      scr.text(x + 20, yy, rpad(mc ? usd(mc) : '-', 8), mc >= bot.c.entryMcapMin && mc <= bot.c.entryMcapMax ? C.green : C.grey);
      scr.text(x + 30, yy, st, col, undefined, false, w - 31);
    });
  }

  function drawFilters(x: number, y: number, w: number, h: number) {
    const st = bot.stats;
    const funnel: Array<[string, number]> = [['seen', st.seen], ['in $ range', st.inRange], ['checked', st.checked], ['passed', st.passed], ['bought', st.bought]];
    scr.text(x + 1, y, 'FUNNEL', C.pink, undefined, true);
    const fmax = Math.max(1, ...funnel.map((f) => f[1]));
    funnel.forEach(([k, v], i) => {
      const bw = Math.round(((w - 26) * v) / fmax);
      scr.text(x + 1, y + 1 + i, pad(k, 11), C.grey);
      for (let j = 0; j < bw; j++) scr.set(x + 13 + j, y + 1 + i, '█', mix(C.white, C.red, j / Math.max(1, bw)));
      scr.text(x + 14 + bw, y + 1 + i, String(v), C.white, undefined, true);
    });
    let yy = y + 8;
    scr.text(x + 1, yy, 'RULES (all must pass)', C.pink, undefined, true); yy++;
    const rules = [
      `holders >= ${bot.c.minHolders}`, `top 10 < ${bot.c.top10MaxPct}% (bonding curve excluded)`, `creator <= ${bot.c.creatorMaxPct}%`,
      'mint authority revoked', 'freeze authority revoked', `entry mcap $${bot.c.entryMcapMin.toLocaleString()} - $${bot.c.entryMcapMax.toLocaleString()}`,
    ];
    rules.forEach((r, i) => { scr.text(x + 2, yy + i, '✓', C.green); scr.text(x + 4, yy + i, r, C.white); });
    yy += rules.length + 1;
    scr.text(x + 1, yy, 'REJECT REASONS', C.pink, undefined, true); yy++;
    const rej = Object.entries(st.rejected).sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, y + h - yy - 1));
    const rmax = Math.max(1, ...rej.map((r) => r[1]));
    rej.forEach(([k, v], i) => {
      const label = pad(k, 30), bw = Math.round(((w - 40) * v) / rmax);
      scr.text(x + 1, yy + i, label, C.grey);
      for (let j = 0; j < bw; j++) scr.set(x + 32 + j, yy + i, '▇', j % 2 ? C.white : C.grey);
      scr.text(x + 33 + bw, yy + i, String(v), C.salmon, undefined, true);
    });
    if (!rej.length) scr.text(x + 2, yy, 'nothing rejected yet', C.dim);
  }

  function drawLadder(x: number, y: number, w: number, h: number) {
    const lv = bot.c.tp;
    const lo = Math.log(bot.c.entryMcapMin * 0.8), hi = Math.log(lv[3].mcapUsd * 1.25);
    const gy = (m: number) => y + 1 + Math.round((1 - (Math.log(Math.max(m, 1)) - lo) / (hi - lo)) * (h - 4));
    const rail = x + 22;
    for (let j = y + 1; j < y + h - 2; j++) { scr.set(rail, j, '║', C.line); scr.set(rail + 16, j, '║', C.line); }
    const s2 = bot.summary();
    lv.forEach((t, i) => {
      const yy = gy(t.mcapUsd);
      for (let k = rail; k <= rail + 16; k++) scr.set(k, yy, '═', C.red2, undefined, true);
      scr.text(x + 1, yy, `TP${i + 1} ${usd(t.mcapUsd).padStart(6)}`, C.white, undefined, true);
      scr.text(rail + 18, yy, `sell ${t.pctOfInitial}% of bag · hit by ${s2.tiers[i]} trade${s2.tiers[i] === 1 ? '' : 's'}`, C.salmon);
    });
    const ey = gy((bot.c.entryMcapMin + bot.c.entryMcapMax) / 2);
    for (let k = rail; k <= rail + 16; k++) scr.set(k, ey, '┄', C.green);
    scr.text(x + 1, ey, `ENTRY ${usd(bot.c.entryMcapMin)}-${usd(bot.c.entryMcapMax)}`, C.green);
    // open positions climbing the ladder
    bot.pm.open.slice(0, 8).forEach((p, i) => {
      const yy = Math.max(y + 1, Math.min(y + h - 3, gy(p.lastMcapUsd)));
      const xx = rail + 2 + (i % 4) * 4;
      scr.text(xx, yy, '◆', C.white, undefined, true);
      scr.text(rail + 18, yy, `◆ $${p.symbol} ${usd(p.lastMcapUsd)}`, C.white);
    });
    scr.text(x + 1, y + h - 1, `kill switch: no TP1 within ${bot.c.killAfterMin}m and 5m volume < ${bot.c.killMinVol5mSol} SOL · no price stop loss`, C.dim, undefined, false, w - 2);
  }

  function drawReclaim(x: number, y: number, w: number, h: number) {
    const all = [...bot.db.data.closed, ...bot.db.data.positions];
    const paid = all.reduce((a, p) => a + p.rentSol, 0), back = all.reduce((a, p) => a + p.rentBackSol, 0);
    const lines: Array<[string, string, number]> = [
      ['token accounts opened', String(all.length), C.white],
      ['rent deposited', `${paid.toFixed(5)} SOL`, C.white],
      ['rent reclaimed', `${back.toFixed(5)} SOL`, C.green],
      ['waiting to close', String(bot.reclaimer.pending), bot.reclaimer.pending ? C.amber : C.grey],
      ['dust threshold', `< ${bot.c.dustSol} SOL: burn + close, never swap`, C.grey],
      ['batch size', `${bot.c.reclaimBatch} accounts / tx every ${bot.c.reclaimEverySec}s`, C.grey],
    ];
    lines.forEach(([k, v, col], i) => { scr.text(x + 1, y + i, pad(k, 24), C.dim); scr.text(x + 26, y + i, v, col, undefined, true); });
    let yy = y + lines.length + 1;
    scr.fill(x, yy, w, 1, ' ', C.pink, C.dark); scr.text(x + 1, yy, 'TOKEN        STATUS               REASON', C.pink, C.dark, true); yy++;
    const recent = [...bot.db.data.positions.filter((p) => p.status === 'dust'), ...bot.db.data.closed.slice().reverse()].slice(0, h - (yy - y) - 1);
    recent.forEach((p, i) => {
      scr.text(x + 1, yy + i, pad('$' + p.symbol, 12), C.white);
      scr.text(x + 14, yy + i, pad(p.status === 'dust' ? 'burn + close' : p.rentBackSol > 0 ? 'closed ✓ rent back' : 'closing…', 20), p.rentBackSol > 0 ? C.green : C.amber);
      scr.text(x + 35, yy + i, p.closeReason ?? '', C.grey, undefined, false, w - 36);
    });
  }

  function drawLog(x: number, y: number, w: number, h: number) {
    const col: Record<Level, number> = { info: C.grey, good: C.green, warn: C.amber, err: C.red2, trade: C.white };
    logs.slice(-h).forEach((l, i) => {
      scr.text(x + 1, y + i, new Date(l.t).toTimeString().slice(0, 8), C.dim);
      scr.text(x + 10, y + i, l.text, col[l.level], undefined, l.level === 'trade', w - 11);
    });
  }

  function drawCam(x: number, y: number, w: number, h: number) {
    scr.fill(x, y, w, 1, ' ', C.white, C.red);
    scr.text(x + 1, y, 'CAM-01 // SIR WHISKERS.feed', C.black, C.red, true);
    if (Math.floor(Date.now() / 600) % 2) scr.text(x + w - 7, y, '● REC', C.white, C.red, true);
    box(x, y + 1, w, h - 1, C.line);
    const iw = w - 2, ihRows = h - 4;
    const ox = x + 1, oy = y + 2;
    if (!cat) { center(ox, iw, oy + 2, 'assets/cat.json missing', C.dim); return; }
    const f = cat.frames[Math.floor((Date.now() / 1000) * cat.fps) % cat.frames.length];
    // fit the frame: half-block cells give two pixel rows per text row
    // fill the width; if the panel is too short, crop around the face (about 45% down the frame)
    const scale = iw / cat.w;
    const dw = iw, dh = Math.min(ihRows * 2, Math.floor((cat.h * scale) / 2) * 2);
    const visSrc = dh / scale, srcTop = Math.max(0, Math.min(cat.h - visSrc, cat.h * 0.47 - visSrc / 2));
    const offX = ox, offY = oy + Math.max(0, Math.floor((ihRows - dh / 2) / 2));
    const tnow = Date.now() / 1000;
    const flash = caption.hot && Date.now() - caption.t < 700 ? 1 - (Date.now() - caption.t) / 700 : 0;
    const px = (sx: number, sy: number) => {
      const xx = Math.min(cat.w - 1, Math.floor(sx / scale)), yy = Math.min(cat.h - 1, Math.floor(srcTop + sy / scale));
      const i = (yy * cat.w + xx) * 3;
      let c = (f[i] << 16) | (f[i + 1] << 8) | f[i + 2];
      // extra rain streaks
      const r = (sx * 3 + sy * 5 + Math.floor(tnow * 14) * 7) % 97;
      if (r === 0 && (sx + sy + Math.floor(tnow * 20)) % 3 === 0) c = mix(c, C.red2, 0.7);
      if (flash) c = mix(c, C.white, flash * 0.35);
      return c;
    };
    for (let ry = 0; ry < dh / 2; ry++) {
      const scan = ry % 2 ? 0.86 : 1;
      for (let rx2 = 0; rx2 < dw; rx2++) {
        const top = px(rx2, ry * 2), bot2 = px(rx2, ry * 2 + 1);
        scr.set(offX + rx2, offY + ry, '▀', mix(C.black, top, scan), mix(C.black, bot2, scan));
      }
    }
    const capY = y + h - 2;
    const capText = Date.now() - caption.t < 4000 ? caption.text : bot.pm.open.length ? `guarding ${bot.pm.open.length} position(s)` : 'standing guard';
    center(x + 1, w - 2, capY, `> ${capText}${Math.floor(Date.now() / 450) % 2 ? '_' : ' '}`, caption.hot && Date.now() - caption.t < 4000 ? C.white : C.salmon, undefined, true);
  }

  function drawHex(x: number, y: number, w: number, h: number) {
    scr.fill(x, y, w, 1, ' ', C.white, C.red);
    scr.text(x + 1, y, 'FILE >> ENCRYPTION // tx stream', C.black, C.red, true);
    box(x, y + 1, w, h - 1, C.line);
    const sigs = [...bot.db.data.events].reverse().map((e) => (e.data?.sig as string) || e.mint || '').filter((s) => s && !s.startsWith('demo')).slice(0, 4);
    const src = (sigs.length ? sigs : feed.slice(0, 4).map((f) => f.mint)).join('');
    let bytes: Uint8Array;
    try { bytes = bs58.decode(src.slice(0, 88) || '11111111'); } catch { bytes = Buffer.from(src); }
    const rowsN = h - 3, scroll = Math.floor(Date.now() / 700);
    for (let r = 0; r < rowsN; r++) {
      const off = ((scroll + r) * 8) % Math.max(8, bytes.length);
      const hex = Array.from({ length: 8 }, (_, k) => (bytes[(off + k) % bytes.length] ?? 0).toString(16).padStart(2, '0')).join(' ');
      scr.text(x + 2, y + 2 + r, ((scroll + r) * 8 + 0xe7c0).toString(16).padStart(8, '0'), C.dim);
      scr.text(x + 12, y + 2 + r, hex, r === rowsN - 1 ? C.white : C.grey, undefined, false, w - 14);
    }
  }

  // track the closed-trade PnL curve
  let closedSeen = -1;
  const trackPnl = () => {
    const closed = bot.db.data.closed;
    if (closed.length === closedSeen) return;
    closedSeen = closed.length; pnlSeries.length = 0; pnlSeries.push(0);
    let acc = 0; for (const p of closed) { acc += netPnl(p); pnlSeries.push(acc); }
  };

  const loop = setInterval(() => { trackPnl(); draw(); }, 100);
  draw();
  /** Remote control, used to record footage of the terminal. */
  const api = {
    key: onKey,
    stopLoop: () => clearInterval(loop),
    frame: () => { trackPnl(); draw(); return { w: scr.w, h: scr.h, ch: scr.ch.join(''), fg: [...scr.fg], bg: [...scr.bg], bold: Array.from(scr.bold) }; },
  };
  if (snap?.file) {
    setTimeout(() => {
      for (let f = 0; f < FOLDERS.length; f++) { folder = f; sel = 0; trackPnl(); draw(); fs.writeFileSync(snap.file!(f), scr.toHtml()); }
      opts.onQuit();
    }, snap.afterMs);
  }
  return api;
}
