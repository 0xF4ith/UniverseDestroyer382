import { EventEmitter } from 'node:events';
import { Connection, Keypair } from '@solana/web3.js';
import type { Config } from './config.js';
import { Db } from './db.js';
import { LiveExecutor, DemoExecutor, loadKeypair, ATA_RENT_SOL, type Executor, type MarketCtx } from './executor.js';
import { checkToken, type FilterResult } from './filters.js';
import { fmtSol, fmtUsd, log } from './logger.js';
import { PositionManager, netPnl } from './positionManager.js';
import { jupUsdPrices, SolPrice } from './price.js';
import { RentReclaimer } from './rentReclaimer.js';
import { CurvePoller, PumpStream, VolumeTracker } from './stream.js';
import { PUMP_SUPPLY } from './curve.js';
import type { MarketTick, NewToken, Position } from './types.js';

/** Anything that emits 'newToken' / 'tick' / 'migrated' like PumpStream (the offline SimFeed does too). */
export interface Feed extends EventEmitter {
  readonly tradesEnabled: boolean;
  connect(): void;
  close(): void;
  watch(mints: string[]): void;
  unwatch(mints: string[]): void;
}

interface Watched { tok: NewToken; lastCheck: number; checking: boolean; lastResult?: FilterResult }

export interface BotStats {
  seen: number; inRange: number; checked: number; passed: number; bought: number;
  rejected: Record<string, number>;
}

export class Bot extends EventEmitter {
  readonly db: Db;
  readonly ex: Executor;
  readonly pm: PositionManager;
  readonly reclaimer: RentReclaimer;
  readonly sol = new SolPrice();
  readonly vol = new VolumeTracker();
  readonly watch = new Map<string, Watched>();
  readonly ctx = new Map<string, MarketCtx & { ts: number; migrated?: boolean }>();
  readonly stats: BotStats = { seen: 0, inRange: 0, checked: 0, passed: 0, bought: 0, rejected: {} };
  readonly startedAt = Date.now();
  conn: Connection;
  kp: Keypair | null = null;
  feed: Feed;
  poller: CurvePoller;
  cash = 0;
  /** When true, no new entries (open positions keep being managed). */
  paused = false;
  private timers: NodeJS.Timeout[] = [];

  /** filterFn lets the offline simulator supply holder data; normally it is the on-chain checkToken. */
  constructor(readonly c: Config, opts: { feed?: Feed; filterFn?: (t: NewToken) => Promise<FilterResult> } = {}) {
    super();
    this.conn = new Connection(c.rpcUrl, 'confirmed');
    if (c.privateKey) this.kp = loadKeypair(c.privateKey);
    this.db = new Db(c.dbPath, c.dryRun ? 'demo' : 'live', c.demoBankrollSol);
    this.ex = c.dryRun ? new DemoExecutor(this.db, c) : new LiveExecutor(this.conn, this.kp!, c);
    this.reclaimer = new RentReclaimer(c, this.db, c.dryRun ? null : this.conn, c.dryRun ? null : this.kp);
    this.pm = new PositionManager(c, this.db, this.ex, this.reclaimer, (m) => this.ctx.get(m), () => this.sol.usd);
    this.reclaimer.onDone = (m, rent) => this.pm.onReclaimed(m, rent);
    this.feed = opts.feed ?? new PumpStream();
    this.poller = new CurvePoller(this.conn);
    this.filterFn = opts.filterFn ?? ((t) => checkToken(this.conn, t, this.c));
    // positions that were open when the bot last stopped: keep managing them
    for (const p of this.db.data.positions) if (p.status === 'dust') this.reclaimer.add(p.mint, p.tokenProgram);
  }
  private filterFn: (t: NewToken) => Promise<FilterResult>;

  async start() {
    await this.ex.init();
    await this.sol.start();
    this.cash = await this.ex.balanceSol();
    if (!this.c.dryRun && this.cash < this.c.minStartBalanceSol) {
      throw new Error(`wallet holds ${fmtSol(this.cash)}; MIN_START_BALANCE_SOL is ${this.c.minStartBalanceSol}`);
    }
    log.good(`Universe Destroyer 382 · ${this.c.dryRun ? 'DEMO' : 'LIVE'} mode · ${fmtSol(this.cash)} available · SOL $${this.sol.usd.toFixed(2)} · ${this.pm.open.length} open position(s)`);
    if (this.kp) log.info(`wallet ${this.kp.publicKey.toBase58()}`);

    this.feed.on('newToken', (t: NewToken) => this.onNewToken(t));
    this.feed.on('tick', (t: MarketTick) => this.onTick(t));
    this.feed.on('migrated', (m: string) => this.onMigrated(m));
    this.poller.on('tick', (t: MarketTick) => this.onTick(t));
    this.poller.on('migrated', (m: string) => this.onMigrated(m));
    for (const p of this.pm.open) { this.safePoll(p.mint); this.feed.watch([p.mint]); }
    this.feed.connect();
    this.poller.start();

    this.every(3000, () => this.pm.checkTimers((m) => this.vol.sum(m, Date.now())));
    this.every(this.c.reclaimEverySec * 1000, () => this.reclaimer.flush());
    this.every(10_000, () => this.prune());
    this.every(5000, () => this.priceMigrated());
    this.every(15_000, async () => { this.cash = await this.ex.balanceSol(); });
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.feed.close(); this.poller.stop(); this.sol.stop();
    this.db.flush();
  }

  private every(ms: number, fn: () => unknown) {
    this.timers.push(setInterval(() => { Promise.resolve(fn()).catch((e) => log.warn((e as Error).message)); }, ms));
  }

  // ------------------------------------------------------------ feed handlers
  private onNewToken(t: NewToken) {
    if (this.watch.has(t.mint)) return;
    this.stats.seen++;
    if (this.watch.size >= this.c.watchMax) {
      const oldest = [...this.watch.values()].sort((a, b) => a.tok.createdAt - b.tok.createdAt)[0];
      if (oldest) this.unwatch(oldest.tok.mint);
    }
    this.watch.set(t.mint, { tok: t, lastCheck: 0, checking: false });
    this.feed.watch([t.mint]);
    if (!this.feed.tradesEnabled) this.safePoll(t.mint, t.bondingCurve);
    this.emit('token', t);
  }

  private onTick(t: MarketTick) {
    const prev = this.ctx.get(t.mint);
    this.ctx.set(t.mint, {
      mcapSol: t.mcapSol, supply: t.supply ?? prev?.supply ?? PUMP_SUPPLY,
      vSol: t.vSol ?? prev?.vSol, vTokens: t.vTokens ?? prev?.vTokens, ts: t.ts, migrated: prev?.migrated,
    });
    this.vol.add(t.mint, t.volSol, t.ts);
    if (this.pm.open.some((p) => p.mint === t.mint)) { void this.pm.onTick(t.mint); return; }
    const w = this.watch.get(t.mint);
    if (w) void this.maybeEnter(w);
  }

  private onMigrated(mint: string) {
    const c = this.ctx.get(mint);
    if (c) { c.migrated = true; c.vSol = undefined; c.vTokens = undefined; }
    this.poller.remove(mint);
    if (!this.pm.open.some((p) => p.mint === mint)) this.unwatch(mint);
    else log.info(`$${this.pm.open.find((p) => p.mint === mint)?.symbol} migrated to PumpSwap, pricing via Jupiter`);
  }

  /** After migration the curve is gone: price held tokens from Jupiter. */
  private async priceMigrated() {
    const held = this.pm.open.filter((p) => this.ctx.get(p.mint)?.migrated);
    if (!held.length) return;
    const prices = await jupUsdPrices(held.map((p) => p.mint));
    for (const p of held) {
      const usd = prices[p.mint];
      if (!usd) continue;
      this.onTick({ mint: p.mint, mcapSol: (usd * p.supply) / this.sol.usd, volSol: 0, ts: Date.now(), supply: p.supply });
    }
  }

  private safePoll(mint: string, curve?: string) {
    try { this.poller.add(mint, curve); } catch { /* not a valid address: the stream still prices it */ }
  }

  private unwatch(mint: string) {
    this.watch.delete(mint);
    if (this.pm.open.some((p) => p.mint === mint)) return;
    this.feed.unwatch([mint]); this.poller.remove(mint); this.vol.drop(mint); this.ctx.delete(mint);
  }

  private prune() {
    const cutoff = Date.now() - this.c.watchMaxAgeMin * 60_000;
    for (const w of [...this.watch.values()]) if (w.tok.createdAt < cutoff) this.unwatch(w.tok.mint);
  }

  // ------------------------------------------------------------ entries
  private reject(reason: string) {
    const key = /holders \(/.test(reason) ? 'too few holders' : /top 10/.test(reason) ? 'top 10 too concentrated'
      : /creator/.test(reason) ? 'creator holds too much' : /authority/.test(reason) ? 'mint/freeze authority active' : reason;
    this.stats.rejected[key] = (this.stats.rejected[key] ?? 0) + 1;
  }

  private async maybeEnter(w: Watched) {
    const ctx = this.ctx.get(w.tok.mint);
    if (!ctx || w.checking || this.paused || this.pm.has(w.tok.mint)) return;
    const mcapUsd = ctx.mcapSol * this.sol.usd;
    if (mcapUsd < this.c.entryMcapMin || mcapUsd > this.c.entryMcapMax) return;
    const now = Date.now();
    if (now - w.lastCheck < 20_000) return;              // re-check a token at most every 20s
    if (this.pm.open.length >= this.c.maxOpen) return;
    const need = this.c.positionSol + this.c.priorityFeeSol + this.c.jitoTipSol + ATA_RENT_SOL + this.c.reserveSol;
    if (this.cash < need) return;
    this.stats.inRange++;
    w.checking = true; w.lastCheck = now;
    try {
      const r = await this.filterFn(w.tok);
      this.stats.checked++;
      w.lastResult = r;
      this.emit('filter', w.tok, r);
      if (!r.pass) { r.reasons.forEach((x) => this.reject(x)); return; }
      this.stats.passed++;
      // the market may have moved during the checks
      const now2 = this.ctx.get(w.tok.mint), mc2 = (now2?.mcapSol ?? 0) * this.sol.usd;
      if (!now2 || mc2 < this.c.entryMcapMin * 0.97 || mc2 > this.c.entryMcapMax * 1.03) { this.reject('left entry range during checks'); return; }
      if (this.pm.open.length >= this.c.maxOpen) return;
      log.info(`PASS $${w.tok.symbol} ${fmtUsd(mc2)} · ${r.holders} holders · top10 ${r.top10Pct.toFixed(1)}% · dev ${r.creatorPct.toFixed(1)}%`);
      const p = await this.pm.enter(w.tok, now2);
      if (p) { this.stats.bought++; this.cash = await this.ex.balanceSol(); this.safePoll(p.mint, w.tok.bondingCurve); this.emit('buy', p); }
    } catch (e) {
      this.reject('filter error');
      log.warn(`filters ${w.tok.symbol || w.tok.mint.slice(0, 6)}:`, (e as Error).message);
    } finally { w.checking = false; }
  }

  // ------------------------------------------------------------ reporting
  summary() {
    const all: Position[] = [...this.db.data.closed, ...this.db.data.positions];
    const closed = this.db.data.closed;
    const realized = closed.reduce((s, p) => s + netPnl(p), 0);
    const gas = all.reduce((s, p) => s + p.entryGasSol + p.exitGasSol, 0);
    const rentBack = all.reduce((s, p) => s + p.rentBackSol, 0);
    const wins = closed.filter((p) => netPnl(p) > 0).length;
    const tiers = [1, 2, 3, 4].map((l) => all.filter((p) => p.tiersHit.some((t) => t.level === l)).length);
    const openValue = this.pm.open.reduce((s, p) => { const c = this.ctx.get(p.mint); return s + (c ? p.tokensLeft * (c.mcapSol / c.supply) : 0); }, 0);
    return { trades: all.length, open: this.pm.open.length, closed: closed.length, wins, realized, gas, rentBack, tiers, openValue, cash: this.cash, pendingReclaim: this.reclaimer.pending };
  }
}
