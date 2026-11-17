import fs from 'node:fs';
import path from 'node:path';
import type { Position } from './types.js';

export interface DbEvent { ts: number; kind: string; mint?: string; data?: Record<string, unknown> }
export interface DbShape {
  version: 1;
  mode: 'demo' | 'live';
  startedAt: number;
  demoCashSol: number;           // demo mode only: simulated wallet balance
  positions: Position[];         // open + dust (waiting for rent reclaim)
  closed: Position[];
  events: DbEvent[];
}

/** Tiny JSON store: atomic writes, debounced. Good enough for a single bot process. */
export class Db {
  data: DbShape;
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, mode: 'demo' | 'live', demoCash: number) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as DbShape;
      if (this.data.mode !== mode) throw new Error(`${file} holds ${this.data.mode} data; use another DB_PATH for ${mode} mode`);
    } else {
      this.data = { version: 1, mode, startedAt: Date.now(), demoCashSol: demoCash, positions: [], closed: [], events: [] };
      this.flush();
    }
  }
  event(kind: string, mint?: string, data?: Record<string, unknown>) {
    this.data.events.push({ ts: Date.now(), kind, mint, data });
    if (this.data.events.length > 20000) this.data.events.splice(0, 5000);
    this.save();
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
  }
  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
