import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from '../src/config.js';
import { Bot, type Feed } from '../src/bot.js';
import { setQuiet } from '../src/logger.js';
import { quoteBuy } from '../src/curve.js';
import type { FilterResult } from '../src/filters.js';
import type { NewToken } from '../src/types.js';

setQuiet(true);
class ScriptFeed extends EventEmitter implements Feed {
  readonly tradesEnabled = true;
  connect() {} close() {} watch() {} unwatch() {}
}
const SOL_USD = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pass: FilterResult = { pass: true, reasons: [], holders: 30, top10Pct: 15, creatorPct: 1, mintAuthority: null, freezeAuthority: null, tokenProgram: 'demo' };

// curve state that yields a given USD market cap
function curveAt(usd: number) {
  const mcapSol = usd / SOL_USD, k = 30 * 1_073_000_000;
  // mcapSol = vSol/vTok * 1e9 and vSol*vTok = k  ->  vSol = sqrt(mcapSol * k / 1e9)
  const vSol = Math.sqrt((mcapSol * k) / 1e9), vTokens = k / vSol;
  return { mcapSol, vSol, vTokens };
}

test('demo mode end to end: entry, 4-tier ladder, close, rent back; kill switch; dust', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
  const c = { ...cfg, dryRun: true, dbPath: path.join(dir, 'db.json'), solUsdFallback: SOL_USD, killAfterMin: 0.02, killMinVol5mSol: 1.5, reclaimEverySec: 1, rpcUrl: 'http://127.0.0.1:1' };
  const feed = new ScriptFeed();
  const bot = new Bot(c, { feed, filterFn: async () => pass });
  bot.sol.refresh = async () => {};           // offline: keep the fallback SOL price
  bot.poller.start = () => {};
  await bot.start();

  const tok = (mint: string): NewToken => ({ mint, symbol: mint, name: mint, creator: 'dev', bondingCurve: 'curve-' + mint, createdAt: Date.now(), mcapSol: 0 });
  const tick = (mint: string, usd: number, vol = 0.5) => feed.emit('tick', { mint, ...curveAt(usd), volSol: vol, ts: Date.now(), supply: 1e9 });

  // --- runner: enters at ~$7.1k and climbs the whole ladder
  feed.emit('newToken', tok('RUN'));
  tick('RUN', 5000); tick('RUN', 7100);
  await sleep(50);
  const p = bot.pm.open.find((x) => x.mint === 'RUN');
  assert.ok(p, 'bought inside the $6.8k-$7.5k window');
  const expectTokens = quoteBuy(curveAt(7100).vSol, curveAt(7100).vTokens, 0.03 * (1 - c.pumpFeePct / 100)) * (1 - c.simSlippagePct / 100);
  assert.ok(Math.abs(p.tokensInitial - expectTokens) / expectTokens < 1e-9, 'demo fill follows the curve');
  const init = p.tokensInitial;

  tick('RUN', 21500); await sleep(30);
  assert.deepEqual(p.tiersHit.map((t) => t.level), [1]);
  assert.ok(Math.abs(p.tokensLeft - init * 0.55) < 1e-6, 'TP1 sold 45%');
  tick('RUN', 52000); await sleep(30);
  assert.ok(Math.abs(p.tokensLeft - init * 0.30) < 1e-6, 'TP2 sold 25% of initial');
  tick('RUN', 101000); await sleep(30);
  assert.ok(Math.abs(p.tokensLeft - init * 0.10) < 1e-6, 'TP3 sold 20% of initial');
  tick('RUN', 151000); await sleep(30);
  assert.equal(p.status, 'closed'); assert.equal(p.tokensLeft, 0);
  assert.equal(p.closeReason, 'ladder done (TP4)');

  // --- out of range: never bought
  feed.emit('newToken', tok('HIGH'));
  tick('HIGH', 9000); await sleep(30);
  assert.equal(bot.pm.has('HIGH'), false, 'no entry above $7.5k');

  // --- dead token: kill switch after the (shortened) timer with low volume
  feed.emit('newToken', tok('DEAD'));
  tick('DEAD', 7000, 0); await sleep(50);
  assert.ok(bot.pm.open.find((x) => x.mint === 'DEAD'), 'DEAD bought');
  tick('DEAD', 6000, 0);
  await sleep(3600);                           // > killAfterMin (1.2s) + one 3s timer pass
  const dead = bot.db.data.closed.find((x) => x.mint === 'DEAD');
  assert.ok(dead, 'kill switch sold DEAD'); assert.equal(dead.closeReason, 'kill switch');

  // --- rug: value falls under 0.003 SOL -> burned + closed, never swapped
  feed.emit('newToken', tok('RUG'));
  tick('RUG', 7200); await sleep(50);
  const rug = bot.pm.open.find((x) => x.mint === 'RUG')!;
  assert.ok(rug);
  tick('RUG', 500); await sleep(30);
  assert.equal(rug.status, 'dust');
  assert.equal(rug.realizedSol, 0, 'no swap on dust');

  // --- rent reclaimer closes every account and credits the rent
  await sleep(1300);
  await bot.reclaimer.flush();
  for (const m of ['RUN', 'DEAD', 'RUG']) {
    const x = bot.db.data.closed.find((y) => y.mint === m)!;
    assert.ok(x, m + ' closed'); assert.ok(x.rentBackSol > 0.002, m + ' rent back');
  }
  const s = bot.summary();
  assert.equal(s.tiers[3], 1);
  assert.ok(s.realized > 0, 'the runner pays for the losers: ' + s.realized);
  bot.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
