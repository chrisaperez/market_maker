import { db } from './db.js';
import { buildOptionBook } from './engine/book.js';
import { broadcastHolding, cancelOrder, placeOrder } from './engine/engine.js';
import { fundMember } from './engine/ledger.js';
import { getMarket, setBotEnabled } from './markets.js';
import { getMembership } from './membership.js';
import { hub } from './realtime.js';

/** A single synthetic user that provides liquidity in any market that enables it. */
export const BOT_USER_ID = '__liquidity_bot__';
export const BOT_USERNAME = 'liquidity-bot';

db.prepare('INSERT OR IGNORE INTO users(id, username, created_at) VALUES (?, ?, ?)').run(
  BOT_USER_ID,
  BOT_USERNAME,
  Date.now(),
);

const insertBotMember = db.prepare(
  "INSERT OR IGNORE INTO memberships(market_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)",
);
const deleteBotMember = db.prepare('DELETE FROM memberships WHERE market_id = ? AND user_id = ?');
const botOpenOrders = db.prepare(
  "SELECT id, side, price_cents, option_id FROM orders WHERE market_id = ? AND user_id = ? AND status = 'open'",
);
const botEnabledOpenMarkets = db.prepare(
  "SELECT id FROM markets WHERE bot_enabled = 1 AND status = 'open'",
);

const QUOTE_SIZE = 3;

function requireCreator(marketId: string, actorId: string) {
  const market = getMarket(marketId);
  if (!market) throw new Error('Market not found.');
  if (market.creatorId !== actorId) throw new Error('Only the creator can toggle the liquidity bot.');
  return market;
}

export function enableBot(marketId: string, actorId: string): void {
  const market = requireCreator(marketId, actorId);
  setBotEnabled(marketId, true);
  insertBotMember.run(marketId, BOT_USER_ID, Date.now());

  const member = getMembership(marketId, BOT_USER_ID);
  if (member) hub.broadcast(marketId, { type: 'membership_update', marketId, member });
  if (market.status === 'open') {
    fundMember(marketId, BOT_USER_ID);
    broadcastHolding(marketId, BOT_USER_ID);
    quoteMarket(marketId);
  }
  broadcastMarket(marketId);
}

export function disableBot(marketId: string, actorId: string): void {
  const market = requireCreator(marketId, actorId);
  setBotEnabled(marketId, false);
  cancelBotOrders(marketId);
  // If it never traded (still in lobby), remove the phantom member entirely.
  if (market.status === 'lobby' || market.status === 'draft') {
    deleteBotMember.run(marketId, BOT_USER_ID);
  }
  broadcastMarket(marketId);
}

function broadcastMarket(marketId: string): void {
  const updated = getMarket(marketId);
  if (updated) hub.broadcast(marketId, { type: 'market_update', marketId, market: updated });
}

function cancelBotOrders(marketId: string): void {
  const orders = botOpenOrders.all(marketId, BOT_USER_ID) as unknown as { id: string }[];
  for (const o of orders) {
    try {
      cancelOrder(BOT_USER_ID, { marketId, orderId: o.id });
    } catch {
      /* ignore */
    }
  }
}

/** Posts a bid + ask around the mid for every option, only re-quoting when needed. */
function quoteMarket(marketId: string): void {
  const market = getMarket(marketId);
  if (!market || market.status !== 'open' || !market.botEnabled) return;

  const existing = botOpenOrders.all(marketId, BOT_USER_ID) as unknown as {
    id: string;
    side: string;
    price_cents: number;
    option_id: string;
  }[];
  const spread = Math.max(2, Math.round(market.parValueCents * 0.08));

  for (const opt of market.options) {
    const book = buildOptionBook(marketId, opt.id);
    const mid = book.lastPriceCents ?? Math.round(market.parValueCents / 2);
    const bid = Math.max(1, mid - spread);
    const ask = Math.min(market.parValueCents, mid + spread);
    const mine = existing.filter((o) => o.option_id === opt.id);
    const hasBid = mine.some((o) => o.side === 'buy' && o.price_cents === bid);
    const hasAsk = mine.some((o) => o.side === 'sell' && o.price_cents === ask);
    if (hasBid && hasAsk) continue; // already quoting at the right prices

    for (const o of mine) {
      try {
        cancelOrder(BOT_USER_ID, { marketId, orderId: o.id });
      } catch {
        /* ignore */
      }
    }
    // Quote both sides; placeOrder enforces no-short + debt cap, so we just skip on failure.
    try {
      placeOrder(BOT_USER_ID, { marketId, optionId: opt.id, side: 'buy', priceCents: bid, quantity: QUOTE_SIZE, orderType: 'limit' });
    } catch {
      /* not enough budget — skip the bid */
    }
    try {
      placeOrder(BOT_USER_ID, { marketId, optionId: opt.id, side: 'sell', priceCents: ask, quantity: QUOTE_SIZE, orderType: 'limit' });
    } catch {
      /* not enough shares — skip the ask */
    }
  }
}

/** Re-quotes every bot-enabled open market on a timer. */
export function startBotLoop(): void {
  const tick = () => {
    const rows = botEnabledOpenMarkets.all() as unknown as { id: string }[];
    for (const r of rows) {
      try {
        quoteMarket(r.id);
      } catch (err) {
        console.error('[bot]', err);
      }
    }
  };
  setInterval(tick, 5000).unref();
}
