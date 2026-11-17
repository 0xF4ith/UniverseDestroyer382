import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { cfg } from './config.js';
import { log } from './logger.js';
import { bondingCurvePda, curvePrice, decodeCurve } from './curve.js';
import type { MarketTick, NewToken } from './types.js';

/**
 * PumpPortal data stream (wss://pumpportal.fun/api/data).
 *  - subscribeNewToken is free and needs no key.
 *  - subscribeTokenTrade needs PUMPPORTAL_API_KEY (and a linked wallet with >= 0.02 SOL); it is metered.
 * PumpPortal asks for ONE connection: every subscription goes over this socket.
 *
 * Events: 'newToken' (NewToken), 'tick' (MarketTick), 'migrated' (mint)
 */
export class PumpStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private watched = new Set<string>();
  private retry = 0;
  private closed = false;
  readonly tradesEnabled = !!cfg.pumpPortalKey;

  connect() {
    const url = 'wss://pumpportal.fun/api/data' + (cfg.pumpPortalKey ? `?api-key=${encodeURIComponent(cfg.pumpPortalKey)}` : '');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      log.good(`PumpPortal stream connected${this.tradesEnabled ? ' (trade feed on)' : ' (new tokens only; curve poller supplies prices)'}`);
      this.send({ method: 'subscribeNewToken' });
      this.send({ method: 'subscribeMigration' });
      if (this.tradesEnabled && this.watched.size) this.send({ method: 'subscribeTokenTrade', keys: [...this.watched] });
    });
    ws.on('message', (raw) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      this.handle(m);
    });
    ws.on('close', () => {
      if (this.closed) return;
      const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
      log.warn(`PumpPortal stream closed, reconnecting in ${Math.round(wait / 1000)}s`);
      setTimeout(() => !this.closed && this.connect(), wait);
    });
    ws.on('error', (e) => log.warn('PumpPortal stream error:', e.message));
  }

  close() { this.closed = true; this.ws?.close(); }

  private send(o: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }

  watch(mints: string[]) {
    const add = mints.filter((m) => !this.watched.has(m));
    add.forEach((m) => this.watched.add(m));
    if (add.length && this.tradesEnabled) this.send({ method: 'subscribeTokenTrade', keys: add });
  }
  unwatch(mints: string[]) {
    const rm = mints.filter((m) => this.watched.delete(m));
    if (rm.length && this.tradesEnabled) this.send({ method: 'unsubscribeTokenTrade', keys: rm });
  }

  /** Message fields as PumpPortal sends them; parsed defensively since the schema is not formally documented. */
  handle(m: Record<string, unknown>) {
    const mint = typeof m.mint === 'string' ? m.mint : '';
    const txType = m.txType as string | undefined;
    if (!mint) return;
    if (txType === 'create') {
      const t: NewToken = {
        mint,
        symbol: String(m.symbol ?? ''),
        name: String(m.name ?? ''),
        creator: String(m.traderPublicKey ?? ''),
        bondingCurve: String(m.bondingCurveKey ?? bondingCurvePda(new PublicKey(mint)).toBase58()),
        createdAt: Date.now(),
        mcapSol: Number(m.marketCapSol ?? 0),
      };
      this.emit('newToken', t);
      // the creator's first buy is a trade too
      if (t.mcapSol > 0) this.emit('tick', { mint, mcapSol: t.mcapSol, volSol: Number(m.solAmount ?? 0), ts: Date.now() } satisfies MarketTick);
      return;
    }
    if (txType === 'buy' || txType === 'sell') {
      const mcapSol = Number(m.marketCapSol ?? 0);
      if (!(mcapSol > 0)) return;
      const tick: MarketTick = { mint, mcapSol, volSol: Math.abs(Number(m.solAmount ?? 0)), ts: Date.now() };
      if (m.vSolInBondingCurve !== undefined) tick.vSol = Number(m.vSolInBondingCurve);
      if (m.vTokensInBondingCurve !== undefined) tick.vTokens = Number(m.vTokensInBondingCurve);
      this.emit('tick', tick);
      return;
    }
    if (txType === 'migrate' || m.method === 'migration' || m.pool === 'pump-amm' && txType === undefined) this.emit('migrated', mint);
  }
}

/**
 * Free fallback / backup feed: reads each watched token's bonding curve account from your RPC.
 * Volume is estimated from how much the virtual SOL reserve moved between polls (a lower bound:
 * a buy and a sell inside one poll cancel out). Tokens whose curve is complete are flagged so the
 * caller can switch them to Jupiter pricing.
 */
export class CurvePoller extends EventEmitter {
  private mints = new Map<string, { curve: PublicKey; lastVSol?: number }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private conn: Connection) { super(); }

  add(mint: string, curve?: string) {
    if (this.mints.has(mint)) return;
    this.mints.set(mint, { curve: curve ? new PublicKey(curve) : bondingCurvePda(new PublicKey(mint)) });
  }
  remove(mint: string) { this.mints.delete(mint); }
  get size() { return this.mints.size; }

  start() { this.timer = setInterval(() => void this.poll(), cfg.pollMs); }
  stop() { if (this.timer) clearInterval(this.timer); }

  async poll() {
    if (this.busy || !this.mints.size) return;
    this.busy = true;
    try {
      const entries = [...this.mints.entries()];
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        const infos = await this.conn.getMultipleAccountsInfo(chunk.map(([, v]) => v.curve), 'confirmed');
        const now = Date.now();
        infos.forEach((info, k) => {
          const [mint, st] = chunk[k];
          if (!info) return;
          const c = decodeCurve(info.data);
          if (!c) return;
          const p = curvePrice(c);
          const vol = st.lastVSol === undefined ? 0 : Math.abs(p.vSol - st.lastVSol);
          st.lastVSol = p.vSol;
          if (c.complete) { this.emit('migrated', mint); return; }
          this.emit('tick', { mint, mcapSol: p.mcapSol, volSol: vol, ts: now, supply: p.supply, vSol: p.vSol, vTokens: p.vTokens } satisfies MarketTick);
        });
      }
    } catch (e) {
      log.warn('curve poll failed:', (e as Error).message);
    } finally { this.busy = false; }
  }
}

/** Rolling 5-minute SOL volume per token. */
export class VolumeTracker {
  private w = new Map<string, Array<[number, number]>>();
  add(mint: string, sol: number, ts: number) {
    if (!(sol > 0)) return;
    const a = this.w.get(mint) ?? [];
    a.push([ts, sol]);
    this.w.set(mint, a);
  }
  sum(mint: string, now: number, windowMs = 5 * 60_000): number {
    const a = this.w.get(mint);
    if (!a) return 0;
    while (a.length && a[0][0] < now - windowMs) a.shift();
    return a.reduce((s, [, v]) => s + v, 0);
  }
  drop(mint: string) { this.w.delete(mint); }
}
