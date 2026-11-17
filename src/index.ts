// npm start  -> terminal UI when run in a terminal, plain logs otherwise (or with --headless)
import { cfg, validateConfig } from './config.js';
import { Bot } from './bot.js';
import { log } from './logger.js';
import { SimFeed } from './simFeed.js';

const errs = validateConfig(cfg);
if (errs.length) { errs.forEach((e) => console.error('config: ' + e)); process.exit(1); }

const sim = ['1', 'true', 'yes'].includes((process.env.SIM_FEED ?? '').toLowerCase());
if (sim && !cfg.dryRun) { console.error('SIM_FEED only works in demo mode (DRY_RUN=true)'); process.exit(1); }
if (sim && cfg.dbPath === 'data/db.json') cfg.dbPath = 'data/sim-db.json';

let simFeed: SimFeed | undefined;
let bot: Bot;
if (sim) {
  let solUsd = () => cfg.solUsdFallback;
  simFeed = new SimFeed(() => solUsd(), Number(process.env.SIM_SPEED ?? 1));
  bot = new Bot(cfg, { feed: simFeed, filterFn: simFeed.filter });
  bot.poller.start = () => {};            // the simulator prices everything itself
  solUsd = () => bot.sol.usd;
} else bot = new Bot(cfg);

const headless = process.argv.includes('--headless') || !process.stdout.isTTY;
const shutdown = () => { bot.stop(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

if (headless) {
  if (!cfg.dryRun) log.warn('LIVE MODE: real SOL will be traded');
  if (sim) log.warn('SIM_FEED: offline simulated market, nothing here is real');
  bot.start().catch((e) => { log.err((e as Error).message); process.exit(1); });
  setInterval(() => {
    const s = bot.summary();
    log.info(`status · ${s.open} open · ${s.closed} closed · net ${s.realized.toFixed(4)} SOL · cash ${s.cash.toFixed(4)} SOL · watching ${bot.watch.size}`);
  }, 30_000);
} else {
  const { startTui } = await import('./tui.js');
  startTui(bot, { sim, onQuit: shutdown }).catch((e) => { console.error(e); process.exit(1); });
}
