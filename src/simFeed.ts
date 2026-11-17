import { EventEmitter } from 'node:events';
import { Keypair } from '@solana/web3.js';
import { quoteBuy, quoteSell, PUMP_SUPPLY } from './curve.js';
import type { FilterResult } from './filters.js';
import type { MarketTick, NewToken } from './types.js';

/**
 * OFFLINE SIMULATOR (SIM_FEED=true, demo mode only). Invents token launches and trades on a
 * pump.fun-style curve so you can watch the bot and the terminal work without any network.
 * Nothing here is real market data.
 */
const SYL = ['ka', 'zu', 'mo', 'ri', 'pe', 'lo', 'fi', 'ga', 'to', 'ne', 'wa', 'bi', 'xo', 'du', 'sha', 'ki'];
type Fate = 'dead' | 'rug' | 'slow' | 'runner' | 'moon';

interface SimTok { tok: NewToken; vSol: number; vTokens: number; fate: Fate; peakTarget: number; age: number; hold: { holders: number; top10: number; dev: number; auth: boolean } }

export class SimFeed extends EventEmitter {
  readonly tradesEnabled = true;
  private toks = new Map<string, SimTok>();
  private timers: NodeJS.Timeout[] = [];
  private seed = 1337;
  constructor(private solUsd: () => number, private speed = 1) { super(); }
  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }

  connect() {
    this.timers.push(setInterval(() => this.launch(), 2600 / this.speed));
    this.timers.push(setInterval(() => this.step(), 400 / this.speed));
    for (let i = 0; i < 6; i++) this.launch();
  }
  close() { this.timers.forEach(clearInterval); }
  watch() {}
  unwatch() {}

  private launch() {
    const sym = (SYL[Math.floor(this.rnd() * SYL.length)] + SYL[Math.floor(this.rnd() * SYL.length)]).toUpperCase();
    const r = this.rnd();
    const fate: Fate = r < 0.38 ? 'dead' : r < 0.6 ? 'rug' : r < 0.78 ? 'slow' : r < 0.94 ? 'runner' : 'moon';
    const peakUsd = { dead: 8200, rug: 9500, slow: 16000, runner: 30000 + this.rnd() * 60000, moon: 170000 + this.rnd() * 80000 }[fate];
    const key = () => Keypair.generate().publicKey.toBase58();
    const tok: NewToken = { mint: key(), symbol: sym, name: sym, creator: key(), bondingCurve: key(), createdAt: Date.now(), mcapSol: 0 };
    const good = this.rnd() < 0.55;
    const s: SimTok = {
      tok, vSol: 30, vTokens: 1_073_000_000, fate, peakTarget: peakUsd, age: 0,
      hold: good
        ? { holders: 16 + Math.floor(this.rnd() * 60), top10: 9 + this.rnd() * 14, dev: this.rnd() * 4.5, auth: false }
        : { holders: 4 + Math.floor(this.rnd() * 30), top10: 14 + this.rnd() * 40, dev: this.rnd() * 14, auth: this.rnd() < 0.15 },
    };
    this.toks.set(tok.mint, s);
    this.trade(s, 0.4 + this.rnd() * 1.4);
    tok.mcapSol = this.mcapSol(s);
    this.emit('newToken', tok);
  }

  private mcapSol(s: SimTok) { return (s.vSol / s.vTokens) * PUMP_SUPPLY; }

  private trade(s: SimTok, sol: number) {
    if (sol > 0) { const out = quoteBuy(s.vSol, s.vTokens, sol); s.vSol += sol; s.vTokens -= out; }
    else { const tokens = Math.min(s.vTokens * 0.2, (-sol / (s.vSol / s.vTokens))); const out = quoteSell(s.vSol, s.vTokens, tokens); s.vSol = Math.max(28, s.vSol - out); s.vTokens += tokens; }
    const t: MarketTick = { mint: s.tok.mint, mcapSol: this.mcapSol(s), volSol: Math.abs(sol), ts: Date.now(), supply: PUMP_SUPPLY, vSol: s.vSol, vTokens: s.vTokens };
    this.emit('tick', t);
  }

  private step() {
    for (const s of this.toks.values()) {
      s.age++;
      const usd = this.mcapSol(s) * this.solUsd();
      const goingUp = usd < s.peakTarget && !(s.fate === 'rug' && s.age > 30);
      const fading = s.age > 220 || (s.fate === 'dead' && s.age > 60);
      if (fading && this.rnd() < 0.7) continue;           // volume dries up
      if (this.rnd() < 0.55) {
        const size = (0.1 + this.rnd() * 1.6) * (s.fate === 'moon' ? 1.6 : 1);
        const up = goingUp ? this.rnd() < 0.68 : this.rnd() < 0.3;
        this.trade(s, up ? size : -size * (s.fate === 'rug' && !goingUp ? 3 : 1));
      }
      if (s.age > 600) this.toks.delete(s.tok.mint);
    }
  }

  /** Simulated holder checks for the simulated tokens. */
  filter = async (t: NewToken): Promise<FilterResult> => {
    await new Promise((r) => setTimeout(r, 250));
    const h = this.toks.get(t.mint)?.hold ?? { holders: 3, top10: 80, dev: 30, auth: true };
    const reasons: string[] = [];
    if (h.holders < 15) reasons.push(`only ${h.holders} holders (need 15)`);
    if (h.top10 >= 25) reasons.push(`top 10 hold ${h.top10.toFixed(1)}% (max 25%)`);
    if (h.dev > 5) reasons.push(`creator holds ${h.dev.toFixed(1)}% (max 5%)`);
    if (h.auth) reasons.push('mint authority still active');
    return { pass: !reasons.length, reasons, holders: h.holders, top10Pct: h.top10, creatorPct: h.dev, mintAuthority: h.auth ? 'x' : null, freezeAuthority: null, tokenProgram: 'sim' };
  };
}
