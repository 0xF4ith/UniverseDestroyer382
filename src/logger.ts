const c = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { dim: c(2), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36) };

const ts = () => new Date().toISOString().slice(11, 19);
let quiet = false;
export const setQuiet = (q: boolean) => { quiet = q; };
export type Level = 'info' | 'good' | 'warn' | 'err' | 'trade';
/** When set (by the terminal UI), log lines go here instead of stdout. */
let sink: ((level: Level, text: string) => void) | null = null;
export const setSink = (f: typeof sink) => { sink = f; };
const str = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(' ');
const out = (level: Level, mark: string, a: unknown[], err = false) => {
  if (sink) return sink(level, str(a));
  if (quiet) return;
  (err ? console.error : console.log)(color.dim(ts()), ...(mark ? [mark] : []), ...a);
};

export const log = {
  info: (...a: unknown[]) => out('info', '', a),
  good: (...a: unknown[]) => out('good', color.green('✔'), a),
  warn: (...a: unknown[]) => out('warn', color.yellow('!'), a, true),
  err: (...a: unknown[]) => out('err', color.red('✖'), a, true),
  trade: (...a: unknown[]) => out('trade', color.magenta('$'), a),
};

export const fmtSol = (n: number) => `${n >= 0 ? '' : '-'}${Math.abs(n).toFixed(4)} SOL`;
export const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
