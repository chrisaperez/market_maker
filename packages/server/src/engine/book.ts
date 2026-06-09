import type { OptionBook } from '@mm/shared';
import { db } from '../db.js';

const selectOpenForBook = db.prepare(`
  SELECT side, price_cents, remaining FROM orders
  WHERE market_id = ? AND option_id = ? AND status = 'open'
`);
const selectLastPrices = db.prepare(`
  SELECT price_cents FROM trades WHERE option_id = ? ORDER BY timestamp_ms DESC, rowid DESC LIMIT 2
`);
const cancelAllOpen = db.prepare(
  "UPDATE orders SET status = 'cancelled' WHERE market_id = ? AND status = 'open'",
);

/** Aggregates resting open orders into bid/ask depth plus last/previous price. */
export function buildOptionBook(marketId: string, optionId: string): OptionBook {
  const rows = selectOpenForBook.all(marketId, optionId) as unknown as {
    side: string;
    price_cents: number;
    remaining: number;
  }[];
  const bidMap = new Map<number, number>();
  const askMap = new Map<number, number>();
  for (const r of rows) {
    const map = r.side === 'buy' ? bidMap : askMap;
    map.set(r.price_cents, (map.get(r.price_cents) ?? 0) + r.remaining);
  }
  const bids = [...bidMap.entries()]
    .map(([priceCents, quantity]) => ({ priceCents, quantity }))
    .sort((a, b) => b.priceCents - a.priceCents);
  const asks = [...askMap.entries()]
    .map(([priceCents, quantity]) => ({ priceCents, quantity }))
    .sort((a, b) => a.priceCents - b.priceCents);
  const prices = selectLastPrices.all(optionId) as unknown as { price_cents: number }[];
  return {
    optionId,
    bids,
    asks,
    lastPriceCents: prices[0]?.price_cents ?? null,
    prevPriceCents: prices[1]?.price_cents ?? null,
  };
}

/** Cancels every resting order in a market (used when the trading window freezes). */
export function cancelAllOpenOrders(marketId: string): void {
  cancelAllOpen.run(marketId);
}
