import 'dotenv/config';

const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`.env: ${k} must be a number, got "${v}"`);
  return n;
};
const str = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k];
  if (v === undefined || v.trim() === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
};

export interface TpLevel { mcapUsd: number; pctOfInitial: number }

export const cfg = {
  dryRun: bool('DRY_RUN', true),

  // keys + endpoints (only read from .env)
  privateKey: str('PRIVATE_KEY'),
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  jitoUrl: str('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
  pumpPortalKey: str('PUMPPORTAL_API_KEY'),
  jupApiKey: str('JUP_API_KEY'),
  alsoSendViaRpc: bool('ALSO_SEND_VIA_RPC', true),

  // bankroll + sizing
  positionSol: num('POSITION_SOL', 0.03),
  maxOpen: num('MAX_OPEN_POSITIONS', 10),
  minStartBalanceSol: num('MIN_START_BALANCE_SOL', 1.0),
  reserveSol: num('RESERVE_SOL', 0.05),
  demoBankrollSol: num('DEMO_BANKROLL_SOL', 1.0),

  // entry window + safety filters
  entryMcapMin: num('ENTRY_MCAP_MIN_USD', 6800),
  entryMcapMax: num('ENTRY_MCAP_MAX_USD', 7500),
  minHolders: num('MIN_HOLDERS', 15),
  top10MaxPct: num('TOP10_MAX_PCT', 25),
  creatorMaxPct: num('CREATOR_MAX_PCT', 5),

  // fees + execution
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0005),
  jitoTipSol: num('JITO_TIP_SOL', 0.0005),
  slippagePct: num('SLIPPAGE_PCT', 18),
  pool: str('PUMPPORTAL_POOL', 'auto'),

  // exits
  tp: [
    { mcapUsd: num('TP1_MCAP_USD', 21000), pctOfInitial: num('TP1_SELL_PCT', 45) },
    { mcapUsd: num('TP2_MCAP_USD', 50000), pctOfInitial: num('TP2_SELL_PCT', 25) },
    { mcapUsd: num('TP3_MCAP_USD', 100000), pctOfInitial: num('TP3_SELL_PCT', 20) },
    { mcapUsd: num('TP4_MCAP_USD', 150000), pctOfInitial: num('TP4_SELL_PCT', 10) },
  ] as TpLevel[],
  killAfterMin: num('KILL_AFTER_MIN', 20),
  killMinVol5mSol: num('KILL_MIN_VOL_5M_SOL', 1.5),
  dustSol: num('DUST_SOL', 0.003),

  // rent reclaim
  reclaimBatch: num('RECLAIM_BATCH', 8),
  reclaimEverySec: num('RECLAIM_EVERY_SEC', 60),

  // watchlist + data
  watchMaxAgeMin: num('WATCH_MAX_AGE_MIN', 15),
  watchMax: num('WATCH_MAX', 150),
  pollMs: num('CURVE_POLL_MS', 2500),
  solUsdFallback: num('SOL_USD_FALLBACK', 150),

  // demo-mode fill model
  simSlippagePct: num('SIM_SLIPPAGE_PCT', 3),
  pumpFeePct: num('PUMP_FEE_PCT', 1.25),

  dbPath: str('DB_PATH', 'data/db.json'),
};

export type Config = typeof cfg;

export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  const sum = c.tp.reduce((a, t) => a + t.pctOfInitial, 0);
  if (Math.abs(sum - 100) > 0.001) errs.push(`TP sell percentages must add up to 100 (they add up to ${sum})`);
  for (let i = 1; i < c.tp.length; i++) if (c.tp[i].mcapUsd <= c.tp[i - 1].mcapUsd) errs.push('TP market caps must go up from TP1 to TP4');
  if (c.entryMcapMin >= c.entryMcapMax) errs.push('ENTRY_MCAP_MIN_USD must be below ENTRY_MCAP_MAX_USD');
  if (c.positionSol <= 0) errs.push('POSITION_SOL must be above 0');
  if (!c.dryRun && !c.privateKey) errs.push('PRIVATE_KEY is required when DRY_RUN=false');
  if (!c.dryRun && /api\.mainnet-beta\.solana\.com/.test(c.rpcUrl)) errs.push('Use your own RPC (Helius, QuickNode, Triton...) for live trading; the public endpoint rate-limits and blocks getProgramAccounts');
  return errs;
}
