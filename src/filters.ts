import { Connection, PublicKey, type ParsedAccountData } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import type { Config } from './config.js';
import type { NewToken } from './types.js';

export interface FilterResult {
  pass: boolean;
  reasons: string[];          // why it failed (empty when it passes)
  holders: number;
  top10Pct: number;
  creatorPct: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  tokenProgram: string;
}

export interface HolderRow { owner: string; amount: bigint }

/** Pure rule check, so it can be unit tested without an RPC. */
export function evaluateHolders(
  rows: HolderRow[], supplyRaw: bigint, creator: string, excludeOwners: Set<string>,
  auth: { mint: string | null; freeze: string | null }, c: Pick<Config, 'minHolders' | 'top10MaxPct' | 'creatorMaxPct'>,
): Omit<FilterResult, 'tokenProgram'> {
  const byOwner = new Map<string, bigint>();
  for (const r of rows) {
    if (r.amount <= 0n || excludeOwners.has(r.owner)) continue;
    byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0n) + r.amount);
  }
  const sorted = [...byOwner.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const pct = (x: bigint) => (supplyRaw > 0n ? Number((x * 1_000_000n) / supplyRaw) / 10_000 : 100);
  const top10Pct = pct(sorted.slice(0, 10).reduce((s, v) => s + v, 0n));
  const creatorPct = pct(byOwner.get(creator) ?? 0n);
  const holders = byOwner.size;
  const reasons: string[] = [];
  if (holders < c.minHolders) reasons.push(`only ${holders} holders (need ${c.minHolders})`);
  if (top10Pct >= c.top10MaxPct) reasons.push(`top 10 hold ${top10Pct.toFixed(1)}% (max ${c.top10MaxPct}%)`);
  if (creatorPct > c.creatorMaxPct) reasons.push(`creator holds ${creatorPct.toFixed(1)}% (max ${c.creatorMaxPct}%)`);
  if (auth.mint) reasons.push('mint authority still active');
  if (auth.freeze) reasons.push('freeze authority still active');
  return { pass: reasons.length === 0, reasons, holders, top10Pct, creatorPct, mintAuthority: auth.mint, freezeAuthority: auth.freeze };
}

/**
 * On-chain safety checks. All must pass:
 *  - at least MIN_HOLDERS unique holders
 *  - top 10 holders own < TOP10_MAX_PCT of supply, not counting the bonding curve
 *  - creator wallet owns <= CREATOR_MAX_PCT
 *  - mint and freeze authority both revoked
 * Uses getProgramAccounts on the token's own program (legacy SPL or Token-2022), so you need an
 * RPC that allows it (Helius, QuickNode, Triton; the public endpoint usually refuses).
 */
export async function checkToken(conn: Connection, tok: NewToken, c: Config): Promise<FilterResult> {
  const mint = new PublicKey(tok.mint);
  const info = await conn.getParsedAccountInfo(mint, 'confirmed');
  if (!info.value) throw new Error('mint account not found');
  const programId = info.value.owner;
  const isLegacy = programId.equals(TOKEN_PROGRAM_ID);
  if (!isLegacy && !programId.equals(TOKEN_2022_PROGRAM_ID)) throw new Error(`unknown token program ${programId.toBase58()}`);
  const parsed = (info.value.data as ParsedAccountData).parsed?.info ?? {};
  const supplyRaw = BigInt(parsed.supply ?? '0');
  const auth = { mint: (parsed.mintAuthority as string | null) ?? null, freeze: (parsed.freezeAuthority as string | null) ?? null };

  // token accounts for this mint: owner (32 bytes @32) + amount (u64 @64) -> slice [32, 72)
  const accts = await conn.getProgramAccounts(programId, {
    commitment: 'confirmed',
    dataSlice: { offset: 32, length: 40 },
    filters: [...(isLegacy ? [{ dataSize: 165 }] : []), { memcmp: { offset: 0, bytes: bs58.encode(mint.toBytes()) } }],
  });
  const rows: HolderRow[] = accts.map((a) => ({
    owner: new PublicKey(a.account.data.subarray(0, 32)).toBase58(),
    amount: a.account.data.readBigUInt64LE(32),
  }));
  const r = evaluateHolders(rows, supplyRaw, tok.creator, new Set([tok.bondingCurve]), auth, c);
  return { ...r, tokenProgram: programId.toBase58() };
}
