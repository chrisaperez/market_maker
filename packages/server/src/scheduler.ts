import { db } from './db.js';
import { freezeMarket } from './settlement.js';

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Arms (or re-arms) the auto-freeze for a market at its window close time. */
export function scheduleFreeze(marketId: string, closesAt: number): void {
  const existing = timers.get(marketId);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, closesAt - Date.now());
  const t = setTimeout(() => {
    timers.delete(marketId);
    try {
      freezeMarket(marketId);
    } catch (err) {
      console.error('[freeze]', err);
    }
  }, delay);
  if (typeof t.unref === 'function') t.unref();
  timers.set(marketId, t);
}

export function cancelFreeze(marketId: string): void {
  const t = timers.get(marketId);
  if (t) {
    clearTimeout(t);
    timers.delete(marketId);
  }
}

/** On boot, re-arm freeze timers for any markets still inside their window. */
export function armOpenMarketTimers(): void {
  const rows = db
    .prepare("SELECT id, closes_at FROM markets WHERE status = 'open'")
    .all() as unknown as { id: string; closes_at: number | null }[];
  for (const r of rows) {
    if (r.closes_at != null) scheduleFreeze(r.id, r.closes_at);
  }
}
