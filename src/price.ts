import { cfg } from './config.js';
import { log } from './logger.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const base = () => (cfg.jupApiKey ? 'https://api.jup.ag/price/v3' : 'https://lite-api.jup.ag/price/v3');
const headers = () => (cfg.jupApiKey ? { 'x-api-key': cfg.jupApiKey } : undefined);

/** Jupiter Price API v3: { "<mint>": { "usdPrice": number, ... } } */
export async function jupUsdPrices(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < mints.length; i += 50) {
    const ids = mints.slice(i, i + 50).join(',');
    const r = await fetch(`${base()}?ids=${ids}`, { headers: headers() });
    if (!r.ok) throw new Error(`Jupiter price ${r.status}`);
    const j = (await r.json()) as Record<string, { usdPrice?: number } | null>;
    for (const [m, v] of Object.entries(j)) if (v && typeof v.usdPrice === 'number') out[m] = v.usdPrice;
  }
  return out;
}

/** SOL/USD, refreshed every minute. Market caps from the stream come in SOL; the ladder works in USD. */
export class SolPrice {
  usd = cfg.solUsdFallback;
  updatedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  async refresh() {
    try {
      const p = (await jupUsdPrices([SOL_MINT]))[SOL_MINT];
      if (p && p > 1) { this.usd = p; this.updatedAt = Date.now(); }
    } catch (e) { log.warn(`SOL price refresh failed, using $${this.usd.toFixed(2)}:`, (e as Error).message); }
  }
  async start() { await this.refresh(); this.timer = setInterval(() => void this.refresh(), 60_000); }
  stop() { if (this.timer) clearInterval(this.timer); }
}
