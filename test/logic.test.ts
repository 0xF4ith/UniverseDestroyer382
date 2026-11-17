import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTakeProfit, shouldKill, isDust, netPnl } from '../src/positionManager.js';
import { evaluateHolders } from '../src/filters.js';
import { curvePrice, quoteBuy, quoteSell } from '../src/curve.js';
import type { Position } from '../src/types.js';

const TP = [
  { mcapUsd: 21000, pctOfInitial: 45 }, { mcapUsd: 50000, pctOfInitial: 25 },
  { mcapUsd: 100000, pctOfInitial: 20 }, { mcapUsd: 150000, pctOfInitial: 10 },
];
const pos = (o: Partial<Position> = {}): Position => ({
  mint: 'M', symbol: 'T', openedAt: 0, entryMcapUsd: 7000, entrySol: 0.03, entryGasSol: 0.001, rentSol: 0.00204,
  tokensInitial: 1000, tokensLeft: 1000, supply: 1e9, tiersHit: [], realizedSol: 0, exitGasSol: 0, rentBackSol: 0,
  lastMcapUsd: 7000, peakMcapUsd: 7000, status: 'open', ...o,
});

test('no sell below TP1', () => assert.equal(decideTakeProfit(pos(), 20999, TP), null));

test('TP1 sells 45% of the initial bag', () => {
  const o = decideTakeProfit(pos(), 21000, TP)!;
  assert.deepEqual(o.levels, [1]); assert.equal(o.tokens, 450); assert.equal(o.sellAll, false);
});

test('TP2 sells 25% of the INITIAL bag, not of what is left', () => {
  const o = decideTakeProfit(pos({ tokensLeft: 550, tiersHit: [{ level: 1, mcapUsd: 21000, tokens: 450, sol: 0, gasSol: 0, ts: 0 }] }), 52000, TP)!;
  assert.deepEqual(o.levels, [2]); assert.equal(o.tokens, 250);
});

test('a jump past TP1 and TP2 sells both in one order', () => {
  const o = decideTakeProfit(pos(), 60000, TP)!;
  assert.deepEqual(o.levels, [1, 2]); assert.equal(o.tokens, 700);
});

test('TP4 sells everything left', () => {
  const p = pos({ tokensLeft: 103, tiersHit: [1, 2, 3].map((l) => ({ level: l, mcapUsd: 0, tokens: 0, sol: 0, gasSol: 0, ts: 0 })) });
  const o = decideTakeProfit(p, 150000, TP)!;
  assert.deepEqual(o.levels, [4]); assert.equal(o.tokens, 103); assert.equal(o.sellAll, true);
});

test('a jump straight to 150k sells the whole bag', () => {
  const o = decideTakeProfit(pos(), 200000, TP)!;
  assert.deepEqual(o.levels, [1, 2, 3, 4]); assert.equal(o.tokens, 1000); assert.equal(o.sellAll, true);
});

test('levels already hit are not sold again', () => {
  const p = pos({ tokensLeft: 550, tiersHit: [{ level: 1, mcapUsd: 21000, tokens: 450, sol: 0, gasSol: 0, ts: 0 }] });
  assert.equal(decideTakeProfit(p, 30000, TP), null);
});

test('kill switch: only after 20 min, only without TP1, only on low volume', () => {
  const c = { killAfterMin: 20, killMinVol5mSol: 1.5 };
  const m20 = 20 * 60_000;
  assert.equal(shouldKill(pos(), m20 - 1, 0, c), false, 'too early');
  assert.equal(shouldKill(pos(), m20, 0.4, c), true, 'quiet after 20m');
  assert.equal(shouldKill(pos(), m20, 3, c), false, 'still busy');
  assert.equal(shouldKill(pos({ tiersHit: [{ level: 1, mcapUsd: 0, tokens: 0, sol: 0, gasSol: 0, ts: 0 }] }), m20 * 3, 0, c), false, 'TP1 reached');
});

test('dust: under 0.003 SOL of value', () => {
  assert.equal(isDust(pos({ tokensLeft: 1000 }), 0.0000029, 0.003), true);
  assert.equal(isDust(pos({ tokensLeft: 1000 }), 0.0000031, 0.003), false);
  assert.equal(isDust(pos({ tokensLeft: 0 }), 0, 0.003), false);
});

test('net PnL counts gas, rent and the refund', () => {
  const p = pos({ realizedSol: 0.1, exitGasSol: 0.004, rentBackSol: 0.00204 });
  assert.ok(Math.abs(netPnl(p) - (0.1 + 0.00204 - 0.03 - 0.001 - 0.00204 - 0.004)) < 1e-12);
});

test('holder filter: passes a healthy token, excludes the bonding curve', () => {
  const supply = 1_000_000_000_000_000n;
  const rows = [{ owner: 'CURVE', amount: (supply * 80n) / 100n }];
  for (let i = 0; i < 20; i++) rows.push({ owner: 'h' + i, amount: supply / 100n });
  const r = evaluateHolders(rows, supply, 'h0', new Set(['CURVE']), { mint: null, freeze: null }, { minHolders: 15, top10MaxPct: 25, creatorMaxPct: 5 });
  assert.equal(r.pass, true, r.reasons.join(', ')); assert.equal(r.holders, 20); assert.equal(r.top10Pct, 10); assert.equal(r.creatorPct, 1);
});

test('holder filter: every rule can fail', () => {
  const supply = 1000n;
  const rows = [{ owner: 'dev', amount: 300n }, { owner: 'a', amount: 10n }];
  const r = evaluateHolders(rows, supply, 'dev', new Set(), { mint: 'X', freeze: 'Y' }, { minHolders: 15, top10MaxPct: 25, creatorMaxPct: 5 });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.length, 5);
});

test('curve maths: price, mcap and round trip', () => {
  const c = curvePrice({ virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 0n, realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, complete: false });
  assert.ok(Math.abs(c.mcapSol - 27.96) < 0.01);
  const out = quoteBuy(30, 1_073_000_000, 1);
  const back = quoteSell(31, 1_073_000_000 - out, out);
  assert.ok(Math.abs(back - 1) < 1e-9);
});
