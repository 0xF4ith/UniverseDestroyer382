import type { Config, TpLevel } from './config.js';
import type { Db } from './db.js';
import type { Executor, MarketCtx } from './executor.js';
import type { RentReclaimer } from './rentReclaimer.js';
import type { NewToken, Position, SellOrder } from './types.js';
import { fmtSol, fmtUsd, log } from './logger.js';

// ---------------------------------------------------------------- pure decisions (unit tested)

/**
 * Take-profit ladder on live market cap. Percentages are of the INITIAL bag. If the price jumps past
 * several levels between two updates, those levels are sold together in one swap. The last level
 * always sells whatever is left.
 */
export function decideTakeProfit(p: Position, mcapUsd: number, tp: TpLevel[]): SellOrder | null {
  const hit = new Set(p.tiersHit.map((t) => t.level));
  const levels: number[] = [];
  tp.forEach((t, i) => { if (!hit.has(i + 1) && mcapUsd >= t.mcapUsd) levels.push(i + 1); });
  if (!levels.length || p.tokensLeft <= 0) return null;
  const sellAll = levels.includes(tp.length);
  const pct = levels.reduce((s, l) => s + tp[l - 1].pctOfInitial, 0);
  const tokens = sellAll ? p.tokensLeft : Math.min(p.tokensLeft, (p.tokensInitial * pct) / 100);
  return { mint: p.mint, tokens, reason: `TP${levels.join('+')} at ${fmtUsd(mcapUsd)}`, levels, sellAll: sellAll || tokens >= p.tokensLeft };
}

/** Kill switch: no TP1 within KILL_AFTER_MIN minutes AND 5-minute volume under the floor. No price stop loss. */
export function shouldKill(p: Position, now: number, vol5mSol: number, c: Pick<Config, 'killAfterMin' | 'killMinVol5mSol'>): boolean {
  if (p.tiersHit.some((t) => t.level === 1)) return false;
  if (now - p.openedAt < c.killAfterMin * 60_000) return false;
  return vol5mSol < c.killMinVol5mSol;
}

/** Below DUST_SOL a swap costs more in gas than it returns: burn + close the account instead. */
export function isDust(p: Position, priceSol: number, dustSol: number): boolean {
  return p.tokensLeft > 0 && p.tokensLeft * priceSol < dustSol;
}

export function netPnl(p: Position): number {
  return p.realizedSol + p.rentBackSol - p.entrySol - p.entryGasSol - p.rentSol - p.exitGasSol;
}

// ---------------------------------------------------------------- manager

export class PositionManager {
  private busy = new Set<string>();
  private retryAt = new Map<string, number>();

  constructor(
    private c: Config,
    private db: Db,
    private ex: Executor,
    private reclaimer: RentReclaimer,
    private ctxOf: (mint: string) => MarketCtx | undefined,
    private solUsd: () => number,
  ) {}

  get open(): Position[] { return this.db.data.positions.filter((p) => p.status === 'open'); }
  has(mint: string) { return this.db.data.positions.some((p) => p.mint === mint) || this.db.data.closed.some((p) => p.mint === mint); }
  isBusy(mint: string) { return this.busy.has(mint); }

  /** Buy POSITION_SOL and open a position. Returns null if the buy failed. */
  async enter(tok: NewToken, ctx: MarketCtx): Promise<Position | null> {
    if (this.busy.has(tok.mint)) return null;
    this.busy.add(tok.mint);
    const mcapUsd = ctx.mcapSol * this.solUsd();
    try {
      const f = await this.ex.buy(tok.mint, this.c.positionSol, ctx);
      if (!(f.tokens > 0)) throw new Error('buy returned 0 tokens');
      const p: Position = {
        mint: tok.mint, symbol: tok.symbol, openedAt: Date.now(), entryMcapUsd: mcapUsd,
        entrySol: f.sol, entryGasSol: f.gasSol, rentSol: f.rentSol, tokensInitial: f.tokens, tokensLeft: f.tokens,
        supply: ctx.supply, tiersHit: [], realizedSol: 0, exitGasSol: 0, rentBackSol: 0,
        lastMcapUsd: mcapUsd, peakMcapUsd: mcapUsd, status: 'open', tokenProgram: f.tokenProgram, buySig: f.sig,
      };
      this.db.data.positions.push(p);
      this.db.event('buy', tok.mint, { symbol: tok.symbol, mcapUsd, sol: f.sol, tokens: f.tokens, gas: f.gasSol, rent: f.rentSol, sig: f.sig });
      log.trade(`BUY  $${tok.symbol || tok.mint.slice(0, 6)} ${fmtSol(f.sol)} at ${fmtUsd(mcapUsd)} mcap  (${this.open.length}/${this.c.maxOpen} open)`);
      return p;
    } catch (e) {
      log.err(`buy ${tok.mint} failed:`, (e as Error).message);
      this.db.event('buy_failed', tok.mint, { error: (e as Error).message });
      return null;
    } finally { this.busy.delete(tok.mint); }
  }

  /** Called on every market update for a held token. */
  async onTick(mint: string, now = Date.now()) {
    const p = this.open.find((x) => x.mint === mint);
    const ctx = this.ctxOf(mint);
    if (!p || !ctx || this.busy.has(mint) || (this.retryAt.get(mint) ?? 0) > now) return;
    const mcapUsd = ctx.mcapSol * this.solUsd();
    p.lastMcapUsd = mcapUsd; p.peakMcapUsd = Math.max(p.peakMcapUsd, mcapUsd);
    const order = decideTakeProfit(p, mcapUsd, this.c.tp);
    if (order) return this.sell(p, order, ctx);
    if (isDust(p, ctx.mcapSol / ctx.supply, this.c.dustSol)) this.toDust(p, 'value under dust threshold');
  }

  /** Every few seconds: kill switch + dust sweep. */
  async checkTimers(vol5m: (mint: string) => number, now = Date.now()) {
    for (const p of this.open) {
      if (this.busy.has(p.mint) || (this.retryAt.get(p.mint) ?? 0) > now) continue;
      const ctx = this.ctxOf(p.mint);
      const priceSol = ctx ? ctx.mcapSol / ctx.supply : 0;
      if (ctx && isDust(p, priceSol, this.c.dustSol)) { this.toDust(p, 'value under dust threshold'); continue; }
      if (shouldKill(p, now, vol5m(p.mint), this.c)) {
        if (!ctx || isDust(p, priceSol, this.c.dustSol)) { this.toDust(p, 'kill switch, worth less than gas'); continue; }
        await this.sell(p, { mint: p.mint, tokens: p.tokensLeft, reason: `kill switch: no TP1 in ${this.c.killAfterMin}m, 5m vol ${vol5m(p.mint).toFixed(2)} SOL`, levels: [], sellAll: true }, ctx);
      }
    }
  }

  /** Sell everything that's left, now (from the terminal UI). */
  async manualSell(mint: string) {
    const p = this.open.find((x) => x.mint === mint), ctx = this.ctxOf(mint);
    if (!p || !ctx || this.busy.has(mint)) return;
    if (isDust(p, ctx.mcapSol / ctx.supply, this.c.dustSol)) return this.toDust(p, 'manual close, worth less than gas');
    await this.sell(p, { mint, tokens: p.tokensLeft, reason: 'manual sell', levels: [], sellAll: true }, ctx);
  }

  private async sell(p: Position, o: SellOrder, ctx: MarketCtx) {
    this.busy.add(p.mint);
    try {
      const f = await this.ex.sell(p.mint, o.tokens, o.sellAll, ctx);
      const sold = o.sellAll ? p.tokensLeft : Math.min(p.tokensLeft, f.tokens || o.tokens);
      p.tokensLeft = o.sellAll ? 0 : Math.max(0, p.tokensLeft - sold);
      p.realizedSol += f.sol; p.exitGasSol += f.gasSol;
      const mcapUsd = ctx.mcapSol * this.solUsd();
      for (const l of o.levels) p.tiersHit.push({ level: l, mcapUsd, tokens: sold / o.levels.length, sol: f.sol / o.levels.length, gasSol: f.gasSol / o.levels.length, ts: Date.now(), sig: f.sig });
      this.retryAt.delete(p.mint);
      this.db.event(o.levels.length ? 'take_profit' : 'kill', p.mint, { reason: o.reason, sol: f.sol, tokens: sold, gas: f.gasSol, sig: f.sig });
      log.trade(`SELL $${p.symbol || p.mint.slice(0, 6)} ${o.reason}: +${fmtSol(f.sol)}`);
      if (p.tokensLeft <= 1e-9) this.close(p, o.levels.length ? `ladder done (TP${o.levels.at(-1)})` : o.reason === 'manual sell' ? 'manual sell' : 'kill switch');
      else this.db.save();
    } catch (e) {
      log.err(`sell ${p.mint} failed (${o.reason}):`, (e as Error).message);
      this.db.event('sell_failed', p.mint, { reason: o.reason, error: (e as Error).message });
      this.retryAt.set(p.mint, Date.now() + 5000);
    } finally { this.busy.delete(p.mint); }
  }

  private close(p: Position, reason: string) {
    p.status = 'closed'; p.closedAt = Date.now(); p.closeReason = reason;
    this.db.data.positions = this.db.data.positions.filter((x) => x !== p);
    this.db.data.closed.push(p);
    this.reclaimer.add(p.mint, p.tokenProgram);   // empty account: close it and get the rent back
    log.info(`closed $${p.symbol || p.mint.slice(0, 6)} (${reason}) net ${fmtSol(netPnl(p))} before rent refund`);
    this.db.save();
  }

  private toDust(p: Position, reason: string) {
    p.status = 'dust'; p.closeReason = reason;
    this.reclaimer.add(p.mint, p.tokenProgram);   // burn the dust + close the account
    this.db.event('dust', p.mint, { reason, tokensLeft: p.tokensLeft });
    log.info(`dust $${p.symbol || p.mint.slice(0, 6)}: ${reason}, queued for burn + close`);
    this.db.save();
  }

  /** Rent reclaimer callback. */
  onReclaimed(mint: string, rentSol: number) {
    const dust = this.db.data.positions.find((x) => x.mint === mint && x.status === 'dust');
    if (dust) {
      dust.rentBackSol += rentSol; dust.tokensLeft = 0; dust.status = 'closed'; dust.closedAt = Date.now();
      this.db.data.positions = this.db.data.positions.filter((x) => x !== dust);
      this.db.data.closed.push(dust);
    } else {
      const c = [...this.db.data.closed].reverse().find((x) => x.mint === mint);
      if (c) c.rentBackSol += rentSol;
    }
    this.db.save();
  }
}
