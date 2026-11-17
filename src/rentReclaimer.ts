import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, createBurnInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, unpackAccount,
} from '@solana/spl-token';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ATA_RENT_SOL } from './executor.js';
import { fmtSol, log } from './logger.js';

interface Job { mint: string; tokenProgram?: string; tries: number }

/**
 * Burns leftover dust and closes empty token accounts in batches, returning the ~0.00204 SOL rent
 * deposit each one holds. Runs every RECLAIM_EVERY_SEC; RECLAIM_BATCH accounts per transaction.
 */
export class RentReclaimer {
  private q: Job[] = [];
  private running = false;
  onDone: (mint: string, rentSol: number) => void = () => {};

  constructor(private c: Config, private db: Db, private conn: Connection | null, private kp: Keypair | null) {}

  add(mint: string, tokenProgram?: string) {
    if (!this.q.some((j) => j.mint === mint)) this.q.push({ mint, tokenProgram, tries: 0 });
  }
  get pending() { return this.q.length; }

  async flush() {
    if (this.running || !this.q.length) return;
    this.running = true;
    try {
      while (this.q.length) {
        const batch = this.q.splice(0, this.c.reclaimBatch);
        if (!this.conn || !this.kp) { this.demo(batch); continue; }
        await this.live(batch);
      }
    } finally { this.running = false; }
  }

  private demo(batch: Job[]) {
    for (const j of batch) {
      this.db.data.demoCashSol += ATA_RENT_SOL;
      this.onDone(j.mint, ATA_RENT_SOL);
      this.db.event('rent_reclaimed', j.mint, { rent: ATA_RENT_SOL, demo: true });
    }
    log.info(`reclaimed rent on ${batch.length} account(s) +${fmtSol(ATA_RENT_SOL * batch.length)} (demo)`);
  }

  private async live(batch: Job[]) {
    const conn = this.conn!, kp = this.kp!;
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })];
    const done: Array<{ mint: string; rent: number }> = [];
    for (const j of batch) {
      try {
        const mint = new PublicKey(j.mint);
        const programId = j.tokenProgram ? new PublicKey(j.tokenProgram) : (await conn.getAccountInfo(mint))?.owner ?? TOKEN_PROGRAM_ID;
        const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, programId);
        const info = await conn.getAccountInfo(ata, 'confirmed');
        if (!info) { this.onDone(j.mint, 0); continue; } // already closed
        const acct = unpackAccount(ata, info, programId);
        if (acct.amount > 0n) ixs.push(createBurnInstruction(ata, mint, kp.publicKey, acct.amount, [], programId));
        ixs.push(createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey, [], programId));
        done.push({ mint: j.mint, rent: info.lamports / 1e9 });
      } catch (e) {
        if (++j.tries < 3) this.q.push(j);
        log.warn(`reclaim prep ${j.mint}:`, (e as Error).message);
      }
    }
    if (!done.length) return;
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
      tx.sign([kp]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      const total = done.reduce((s, d) => s + d.rent, 0);
      for (const d of done) { this.onDone(d.mint, d.rent); this.db.event('rent_reclaimed', d.mint, { rent: d.rent, sig }); }
      log.good(`closed ${done.length} token account(s), reclaimed ${fmtSol(total)}  ${sig}`);
    } catch (e) {
      log.warn('reclaim tx failed, will retry:', (e as Error).message);
      for (const d of done) { const j = batch.find((b) => b.mint === d.mint)!; if (++j.tries < 3) this.q.push(j); }
    }
  }
}
