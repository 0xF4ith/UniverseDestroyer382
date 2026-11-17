import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { log } from './logger.js';
import { quoteBuy, quoteSell } from './curve.js';

export interface MarketCtx { mcapSol: number; supply: number; vSol?: number; vTokens?: number }
export interface Fill {
  sig?: string;
  tokens: number;        // whole tokens bought / sold
  sol: number;           // SOL into the swap (buy) or out of it (sell), excluding gas and rent
  gasSol: number;        // network + priority fee + Jito tip actually paid
  rentSol: number;       // token-account rent paid (buy that opened the account)
  tokenProgram?: string;
}
export interface Executor {
  readonly live: boolean;
  init(): Promise<void>;
  balanceSol(): Promise<number>;
  buy(mint: string, solIn: number, ctx: MarketCtx): Promise<Fill>;
  sell(mint: string, tokens: number, sellAll: boolean, ctx: MarketCtx): Promise<Fill>;
}

export const ATA_RENT_SOL = 0.00203928;
const BASE_FEE_SOL = 0.000005;
// Jito's 8 tip accounts; refreshed from getTipAccounts at start-up
const DEFAULT_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  return Keypair.fromSecretKey(bs58.decode(s));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- live
export class LiveExecutor implements Executor {
  readonly live = true;
  private tipAccounts = DEFAULT_TIP_ACCOUNTS;
  constructor(private conn: Connection, private kp: Keypair, private c: Config) {}

  async init() {
    try {
      const r = await this.jito('getTipAccounts', []);
      if (Array.isArray(r) && r.length) this.tipAccounts = r as string[];
    } catch (e) { log.warn('Jito getTipAccounts failed, using the built-in list:', (e as Error).message); }
  }

  async balanceSol() { return (await this.conn.getBalance(this.kp.publicKey, 'confirmed')) / 1e9; }

  private async jito(method: string, params: unknown[]): Promise<unknown> {
    const r = await fetch(`${this.c.jitoUrl.replace(/\/$/, '')}/api/v1/bundles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(j.error.message ?? 'jito error');
    return j.result;
  }

  /** PumpPortal Local Transaction API: returns an unsigned VersionedTransaction (priority fee already inside). */
  private async portalTx(body: Record<string, unknown>): Promise<VersionedTransaction> {
    const r = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: this.kp.publicKey.toBase58(), slippage: this.c.slippagePct, priorityFee: this.c.priorityFeeSol, pool: this.c.pool, ...body }),
    });
    if (r.status !== 200) throw new Error(`PumpPortal trade-local ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
    tx.sign([this.kp]);
    return tx;
  }

  /** Bundle [swap, tip] to Jito, optionally also push the swap through the RPC; wait for it to confirm. */
  private async land(swap: VersionedTransaction): Promise<{ sig: string; tipPaid: boolean }> {
    const sig = bs58.encode(swap.signatures[0]);
    let tipSig: string | null = null;
    if (this.c.jitoTipSol > 0) {
      const tipTo = new PublicKey(this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]);
      const msg = new TransactionMessage({
        payerKey: this.kp.publicKey, recentBlockhash: swap.message.recentBlockhash,
        instructions: [SystemProgram.transfer({ fromPubkey: this.kp.publicKey, toPubkey: tipTo, lamports: Math.round(this.c.jitoTipSol * 1e9) })],
      }).compileToV0Message();
      const tip = new VersionedTransaction(msg);
      tip.sign([this.kp]);
      tipSig = bs58.encode(tip.signatures[0]);
      const b64 = (t: VersionedTransaction) => Buffer.from(t.serialize()).toString('base64');
      this.jito('sendBundle', [[b64(swap), b64(tip)], { encoding: 'base64' }]).catch((e) => log.warn('Jito sendBundle:', (e as Error).message));
    }
    if (this.c.alsoSendViaRpc || this.c.jitoTipSol <= 0) {
      this.conn.sendRawTransaction(swap.serialize(), { skipPreflight: true, maxRetries: 3 }).catch((e) => log.warn('RPC send:', (e as Error).message));
    }
    for (let i = 0; i < 40; i++) {
      await sleep(750);
      const st = (await this.conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`swap failed on-chain: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        let tipPaid = false;
        if (tipSig) { const ts = (await this.conn.getSignatureStatuses([tipSig])).value[0]; tipPaid = !!ts && !ts.err; }
        return { sig, tipPaid };
      }
    }
    throw new Error(`swap ${sig} not confirmed after 30s`);
  }

  /** Read what actually happened from the confirmed transaction. */
  private async settle(sig: string, mint: string, tipPaid: boolean) {
    let tx = null;
    for (let i = 0; i < 12 && !tx; i++) {
      tx = await this.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) await sleep(1000);
    }
    if (!tx?.meta) throw new Error(`could not read transaction ${sig}`);
    const me = this.kp.publicKey.toBase58();
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const meIdx = (() => { for (let i = 0; i < keys.length; i++) if (keys.get(i)?.toBase58() === me) return i; return 0; })();
    const walletDelta = (tx.meta.postBalances[meIdx] - tx.meta.preBalances[meIdx]) / 1e9;
    const fee = tx.meta.fee / 1e9;
    const mine = (arr: typeof tx.meta.preTokenBalances) => (arr ?? []).find((b) => b.owner === me && b.mint === mint);
    const pre = mine(tx.meta.preTokenBalances), post = mine(tx.meta.postTokenBalances);
    const dec = (post ?? pre)?.uiTokenAmount.decimals ?? 6;
    const raw = (b: typeof pre) => (b ? BigInt(b.uiTokenAmount.amount) : 0n);
    const tokenDelta = Number(raw(post) - raw(pre)) / 10 ** dec;
    const tokenProgram = (post ?? pre)?.programId;
    let rentSol = 0;
    if (!pre && post && tokenProgram) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), this.kp.publicKey, false, new PublicKey(tokenProgram));
      for (let i = 0; i < keys.length; i++) if (keys.get(i)?.equals(ata)) rentSol = tx.meta.postBalances[i] / 1e9;
    }
    return { walletDelta, fee, tokenDelta, rentSol, tokenProgram, gasSol: fee + (tipPaid ? this.c.jitoTipSol : 0) };
  }

  async buy(mint: string, solIn: number): Promise<Fill> {
    const tx = await this.portalTx({ action: 'buy', mint, amount: solIn, denominatedInSol: 'true' });
    const { sig, tipPaid } = await this.land(tx);
    const s = await this.settle(sig, mint, tipPaid);
    return { sig, tokens: s.tokenDelta, sol: -s.walletDelta - s.fee - s.rentSol, gasSol: s.gasSol, rentSol: s.rentSol, tokenProgram: s.tokenProgram };
  }

  async sell(mint: string, tokens: number, sellAll: boolean): Promise<Fill> {
    const amount = sellAll ? '100%' : Math.floor(tokens * 1e6) / 1e6;
    const tx = await this.portalTx({ action: 'sell', mint, amount, denominatedInSol: 'false' });
    const { sig, tipPaid } = await this.land(tx);
    const s = await this.settle(sig, mint, tipPaid);
    return { sig, tokens: -s.tokenDelta, sol: s.walletDelta + s.fee, gasSol: s.gasSol, rentSol: 0, tokenProgram: s.tokenProgram };
  }
}

// ---------------------------------------------------------------- demo
/** DRY_RUN: fills on the bonding-curve maths (or the market-cap price after migration), minus platform fee and SIM_SLIPPAGE_PCT. */
export class DemoExecutor implements Executor {
  readonly live = false;
  constructor(private db: Db, private c: Config) {}
  async init() {}
  async balanceSol() { return this.db.data.demoCashSol; }

  private gas() { return this.c.priorityFeeSol + this.c.jitoTipSol + BASE_FEE_SOL; }

  async buy(mint: string, solIn: number, ctx: MarketCtx): Promise<Fill> {
    const net = solIn * (1 - this.c.pumpFeePct / 100);
    const raw = ctx.vSol && ctx.vTokens ? quoteBuy(ctx.vSol, ctx.vTokens, net) : net / (ctx.mcapSol / ctx.supply);
    const tokens = raw * (1 - this.c.simSlippagePct / 100);
    const gasSol = this.gas();
    this.db.data.demoCashSol -= solIn + gasSol + ATA_RENT_SOL;
    return { sig: 'demo-' + Math.random().toString(36).slice(2, 10), tokens, sol: solIn, gasSol, rentSol: ATA_RENT_SOL, tokenProgram: 'demo' };
  }

  async sell(mint: string, tokens: number, _sellAll: boolean, ctx: MarketCtx): Promise<Fill> {
    const gross = ctx.vSol && ctx.vTokens ? quoteSell(ctx.vSol, ctx.vTokens, tokens) : tokens * (ctx.mcapSol / ctx.supply);
    const sol = gross * (1 - this.c.pumpFeePct / 100) * (1 - this.c.simSlippagePct / 100);
    const gasSol = this.gas();
    this.db.data.demoCashSol += sol - gasSol;
    return { sig: 'demo-' + Math.random().toString(36).slice(2, 10), tokens, sol, gasSol, rentSol: 0 };
  }
}
