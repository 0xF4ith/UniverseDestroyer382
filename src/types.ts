export type Platform = 'pump' | 'pump-amm' | 'other';

/** One market update for a token, from the PumpPortal stream or the bonding-curve poller. */
export interface MarketTick {
  mint: string;
  mcapSol: number;       // market cap in SOL
  volSol: number;        // SOL volume in this update (for the 5-minute window)
  ts: number;            // ms
  complete?: boolean;    // bonding curve finished (migrated)
  supply?: number;       // total supply in whole tokens, when known
  vSol?: number;         // virtual SOL reserves, when known
  vTokens?: number;      // virtual token reserves, when known
}

export interface NewToken {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  bondingCurve: string;
  createdAt: number;
  mcapSol: number;
}

export interface TierHit { level: number; mcapUsd: number; tokens: number; sol: number; gasSol: number; ts: number; sig?: string }

export type PosStatus = 'open' | 'closed' | 'dust';

export interface Position {
  mint: string;
  symbol: string;
  openedAt: number;
  entryMcapUsd: number;
  entrySol: number;          // SOL spent on the swap itself
  entryGasSol: number;       // priority fee + Jito tip + network fee
  rentSol: number;           // token account rent paid on the first buy
  tokensInitial: number;     // whole tokens received
  tokensLeft: number;
  supply: number;            // total supply in whole tokens (pump.fun: 1,000,000,000)
  tiersHit: TierHit[];
  realizedSol: number;       // SOL received from sells (after slippage + platform fee)
  exitGasSol: number;
  rentBackSol: number;
  lastMcapUsd: number;
  peakMcapUsd: number;
  status: PosStatus;
  closedAt?: number;
  closeReason?: string;
  tokenProgram?: string;
  buySig?: string;
}

export interface SellOrder { mint: string; tokens: number; reason: string; levels: number[]; sellAll: boolean }
