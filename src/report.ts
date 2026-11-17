// npm run report  -> summary of the demo (or live) trading database
import fs from 'node:fs';
import { cfg } from './config.js';
import type { DbShape } from './db.js';
import { netPnl } from './positionManager.js';
import { fmtSol, fmtUsd } from './logger.js';

const file = process.argv[2] ?? cfg.dbPath;
if (!fs.existsSync(file)) { console.log(`No database at ${file} yet. Run the bot first.`); process.exit(0); }
const db = JSON.parse(fs.readFileSync(file, 'utf8')) as DbShape;
const closed = db.closed, all = [...closed, ...db.positions];
const pnl = closed.map(netPnl);
const wins = pnl.filter((x) => x > 0).length;
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

console.log(`\nUniverse Destroyer 382 · ${db.mode.toUpperCase()} report · ${file} · since ${new Date(db.startedAt).toLocaleString()}`);
console.log('─'.repeat(72));
console.log(`positions       ${all.length} total · ${db.positions.filter((p) => p.status === 'open').length} open · ${closed.length} closed`);
console.log(`win rate        ${closed.length ? ((wins / closed.length) * 100).toFixed(1) : '0'}%  (${wins}W / ${closed.length - wins}L)`);
console.log(`net PnL         ${fmtSol(sum(pnl))}  (closed positions, after gas, rent refunded)`);
console.log(`gas paid        ${fmtSol(sum(all.map((p) => p.entryGasSol + p.exitGasSol)))}`);
console.log(`rent reclaimed  ${fmtSol(sum(all.map((p) => p.rentBackSol)))}`);
for (let l = 1; l <= 4; l++) console.log(`TP${l} reached     ${all.filter((p) => p.tiersHit.some((t) => t.level === l)).length}`);
console.log(`kill switch     ${closed.filter((p) => p.closeReason === 'kill switch').length}`);
console.log(`dust            ${all.filter((p) => (p.closeReason ?? '').includes('dust') || (p.closeReason ?? '').includes('worth less')).length}`);
if (db.mode === 'demo') console.log(`demo balance    ${fmtSol(db.demoCashSol)}`);
console.log('─'.repeat(72));
const best = [...closed].sort((a, b) => netPnl(b) - netPnl(a)).slice(0, 5);
if (best.length) {
  console.log('best trades');
  for (const p of best) console.log(`  $${(p.symbol || p.mint.slice(0, 6)).padEnd(12)} in ${fmtUsd(p.entryMcapUsd).padStart(8)} · peak ${fmtUsd(p.peakMcapUsd).padStart(9)} · ${p.tiersHit.map((t) => 'TP' + t.level).join(' ') || '-'} · ${fmtSol(netPnl(p))}`);
}
console.log('');
