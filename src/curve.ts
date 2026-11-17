import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_DECIMALS = 6;
export const PUMP_SUPPLY = 1_000_000_000; // whole tokens

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM)[0];
}

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

/** Bonding curve account: 8-byte discriminator, five u64s, then the `complete` flag. */
export function decodeCurve(data: Buffer): CurveState | null {
  if (data.length < 49) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] === 1,
  };
}

/** Price in SOL per whole token, and market cap in SOL. */
export function curvePrice(c: CurveState): { priceSol: number; mcapSol: number; supply: number; vSol: number; vTokens: number } {
  const vSol = Number(c.virtualSolReserves) / 1e9;
  const vTokens = Number(c.virtualTokenReserves) / 10 ** PUMP_DECIMALS;
  const supply = Number(c.tokenTotalSupply) / 10 ** PUMP_DECIMALS || PUMP_SUPPLY;
  const priceSol = vTokens > 0 ? vSol / vTokens : 0;
  return { priceSol, mcapSol: priceSol * supply, supply, vSol, vTokens };
}

/** Constant-product quote on the curve (used by demo mode). Returns whole tokens out. */
export function quoteBuy(vSol: number, vTokens: number, solIn: number): number {
  const k = vSol * vTokens;
  return vTokens - k / (vSol + solIn);
}
export function quoteSell(vSol: number, vTokens: number, tokensIn: number): number {
  const k = vSol * vTokens;
  return vSol - k / (vTokens + tokensIn);
}
