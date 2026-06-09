import { nanoid } from 'nanoid';
import { dollars, type Market, type OptionBook, type Order, type Trade } from '@mm/shared';
import { db, nextOrderSeq, transaction } from '../db.js';
import { getMarket, openMarketRow } from '../markets.js';
import { isActiveMember, listMembers } from '../membership.js';
import { hub } from '../realtime.js';
import { scheduleFreeze } from '../scheduler.js';
import { buildOptionBook } from './book.js';
import { applyTrade, fundMember, getCash, getPositions, getPositionShares } from './ledger.js';

export class OrderError extends Error {}

interface OrderRow {
  id: string;
  market_id: string;
  option_id: string;
  user_id: string;
  side: string;
  price_cents: number;
  quantity: number;
  remaining: number;
  status: string;
  created_at: number;
}

const insertOrder = db.prepare(`
  INSERT INTO orders(id, market_id, option_id, user_id, side, price_cents, quantity, remaining, status, created_at, seq)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
`);
const insertTrade = db.prepare(`
  INSERT INTO trades(id, market_id, option_id, buyer_id, seller_id, price_cents, shares, total_cents, timestamp_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateOrder = db.prepare('UPDATE orders SET remaining = ?, status = ? WHERE id = ?');
const selectOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
// Resting asks, best (lowest) price first, then FIFO by sequence.
const selectAsks = db.prepare(`
  SELECT * FROM orders
  WHERE market_id = ? AND option_id = ? AND side = 'sell' AND status = 'open' AND price_cents <= ?
  ORDER BY price_cents ASC, seq ASC
`);
// Resting bids, best (highest) price first, then FIFO by sequence.
const selectBids = db.prepare(`
  SELECT * FROM orders
  WHERE market_id = ? AND option_id = ? AND side = 'buy' AND status = 'open' AND price_cents >= ?
  ORDER BY price_cents DESC, seq ASC
`);
const lockedSells = db.prepare(`
  SELECT COALESCE(SUM(remaining), 0) AS s FROM orders
  WHERE market_id = ? AND option_id = ? AND user_id = ? AND side = 'sell' AND status = 'open'
`);
const selectMyOpenOrders = db.prepare(`
  SELECT * FROM orders WHERE market_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at
`);
const selectMarketTrades = db.prepare(`
  SELECT * FROM (
    SELECT *, rowid AS rid FROM trades WHERE market_id = ? ORDER BY timestamp_ms DESC, rowid DESC LIMIT 1000
  ) ORDER BY timestamp_ms ASC, rid ASC
`);

interface TradeRow {
  id: string;
  market_id: string;
  option_id: string;
  buyer_id: string;
  seller_id: string;
  price_cents: number;
  shares: number;
  total_cents: number;
  timestamp_ms: number;
}

function rowToOrder(r: OrderRow): Order {
  return {
    id: r.id,
    marketId: r.market_id,
    optionId: r.option_id,
    userId: r.user_id,
    side: r.side as Order['side'],
    priceCents: r.price_cents,
    quantity: r.quantity,
    remaining: r.remaining,
    createdAt: r.created_at,
    status: r.status as Order['status'],
  };
}

function rowToTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    marketId: r.market_id,
    optionId: r.option_id,
    buyerId: r.buyer_id,
    sellerId: r.seller_id,
    priceCents: r.price_cents,
    shares: r.shares,
    totalCents: r.total_cents,
    timestampMs: r.timestamp_ms,
  };
}

export function getMyOpenOrders(marketId: string, userId: string): Order[] {
  return (selectMyOpenOrders.all(marketId, userId) as unknown as OrderRow[]).map(rowToOrder);
}

export function getMarketTrades(marketId: string): Trade[] {
  return (selectMarketTrades.all(marketId) as unknown as TradeRow[]).map(rowToTrade);
}

/** Push a user's current cash + positions to all their connected tabs. */
export function sendBalance(marketId: string, userId: string): void {
  hub.sendToUser(userId, {
    type: 'balance',
    marketId,
    cashCents: getCash(marketId, userId),
    positions: getPositions(marketId, userId),
  });
}

function sendOrderUpdate(userId: string, order: Order): void {
  hub.sendToUser(userId, { type: 'order_update', marketId: order.marketId, order });
}

interface MatchResult {
  trades: Trade[];
  placedOrder: Order;
  touchedOrders: Order[]; // resting orders that changed (filled/reduced)
}

/**
 * Places a limit order and matches it against the book with strict price-time
 * (FIFO) priority. Runs atomically; on success broadcasts trades, book depth,
 * and per-user balance/order updates to the market room.
 */
export function placeOrder(
  userId: string,
  input: { marketId: string; optionId: string; side: 'buy' | 'sell'; priceCents: number; quantity: number },
): void {
  const { marketId, optionId, side, priceCents, quantity } = input;
  const market = getMarket(marketId);
  if (!market) throw new OrderError('Market not found.');
  if (market.status !== 'open') throw new OrderError('Trading is not open right now.');
  if (market.closesAt && Date.now() > market.closesAt) {
    throw new OrderError('The trading window has closed.');
  }
  if (!isActiveMember(marketId, userId)) throw new OrderError('You are not a member of this market.');
  if (!market.options.some((o) => o.id === optionId)) throw new OrderError('Unknown option.');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new OrderError('Quantity must be a positive whole number.');
  if (!Number.isInteger(priceCents) || priceCents <= 0) throw new OrderError('Price must be positive.');
  if (priceCents > market.parValueCents) {
    throw new OrderError(`Price can't exceed the par value of ${dollars(market.parValueCents)}/share.`);
  }

  const result = transaction<MatchResult>(() => {
    fundMember(marketId, userId);

    if (side === 'sell') {
      const have = getPositionShares(marketId, userId, optionId);
      const locked = (lockedSells.get(marketId, optionId, userId) as { s: number }).s;
      if (quantity > have - locked) {
        throw new OrderError('You can only sell shares you actually hold (no short selling).');
      }
    }

    const seq = nextOrderSeq();
    const orderId = nanoid();
    const createdAt = Date.now();
    insertOrder.run(orderId, marketId, optionId, userId, side, priceCents, quantity, quantity, createdAt, seq);

    let remaining = quantity;
    const trades: Trade[] = [];
    const touched: Order[] = [];
    const candidates = (
      side === 'buy'
        ? selectAsks.all(marketId, optionId, priceCents)
        : selectBids.all(marketId, optionId, priceCents)
    ) as unknown as OrderRow[];

    for (const c of candidates) {
      if (remaining <= 0) break;
      if (c.user_id === userId) continue; // never self-trade
      const fill = Math.min(remaining, c.remaining);
      const tradePrice = c.price_cents; // maker's resting price wins
      const total = fill * tradePrice;
      const buyerId = side === 'buy' ? userId : c.user_id;
      const sellerId = side === 'buy' ? c.user_id : userId;
      const ts = Date.now();
      const tradeId = nanoid();

      insertTrade.run(tradeId, marketId, optionId, buyerId, sellerId, tradePrice, fill, total, ts);
      applyTrade(marketId, buyerId, sellerId, optionId, fill, total);

      const candRemaining = c.remaining - fill;
      updateOrder.run(candRemaining, candRemaining === 0 ? 'filled' : 'open', c.id);
      remaining -= fill;

      trades.push({
        id: tradeId,
        marketId,
        optionId,
        buyerId,
        sellerId,
        priceCents: tradePrice,
        shares: fill,
        totalCents: total,
        timestampMs: ts,
      });
      touched.push(rowToOrder(selectOrder.get(c.id) as unknown as OrderRow));
    }

    updateOrder.run(remaining, remaining === 0 ? 'filled' : 'open', orderId);
    const placedOrder = rowToOrder(selectOrder.get(orderId) as unknown as OrderRow);
    return { trades, placedOrder, touchedOrders: touched };
  });

  broadcastAfterTrade(market, optionId, result);
}

function broadcastAfterTrade(market: Market, optionId: string, result: MatchResult): void {
  const book = buildOptionBook(market.id, optionId);

  if (result.trades.length === 0) {
    hub.broadcast(market.id, { type: 'book', marketId: market.id, book });
  } else {
    for (const trade of result.trades) {
      hub.broadcast(market.id, { type: 'trade', marketId: market.id, trade, book });
    }
  }

  // Per-user updates: everyone whose money or orders moved.
  const affected = new Set<string>([result.placedOrder.userId]);
  for (const t of result.trades) {
    affected.add(t.buyerId);
    affected.add(t.sellerId);
  }
  for (const uid of affected) sendBalance(market.id, uid);

  sendOrderUpdate(result.placedOrder.userId, result.placedOrder);
  for (const o of result.touchedOrders) sendOrderUpdate(o.userId, o);
}

export function cancelOrder(userId: string, input: { marketId: string; orderId: string }): void {
  const order = transaction<Order>(() => {
    const row = selectOrder.get(input.orderId) as OrderRow | undefined;
    if (!row) throw new OrderError('Order not found.');
    if (row.user_id !== userId) throw new OrderError('That is not your order.');
    if (row.status !== 'open') throw new OrderError('Order is no longer open.');
    updateOrder.run(row.remaining, 'cancelled', row.id);
    return rowToOrder(selectOrder.get(row.id) as unknown as OrderRow);
  });

  const book = buildOptionBook(input.marketId, order.optionId);
  hub.broadcast(input.marketId, { type: 'book', marketId: input.marketId, book });
  sendOrderUpdate(userId, order);
}

/**
 * Opens a market for trading: funds every active member with their starting
 * allocation and starts the trading window. (The countdown/auto-freeze timer
 * and settlement come in M4.)
 */
export function openMarket(marketId: string, actorId: string): Market {
  const market = getMarket(marketId);
  if (!market) throw new OrderError('Market not found.');
  if (market.creatorId !== actorId) throw new OrderError('Only the creator can open the market.');
  if (market.status !== 'lobby') throw new OrderError('Market can only be opened from the lobby.');

  const members = listMembers(marketId).filter((m) => m.status === 'active');
  const openedAt = Date.now();
  const closesAt = openedAt + market.windowSeconds * 1000;

  transaction(() => {
    openMarketRow(marketId, openedAt, closesAt);
    for (const m of members) fundMember(marketId, m.userId);
  });

  scheduleFreeze(marketId, closesAt);

  const updated = getMarket(marketId)!;
  hub.broadcast(marketId, { type: 'market_update', marketId, market: updated });
  for (const m of members) {
    hub.sendToUser(m.userId, { type: 'market_update', marketId, market: updated });
    sendBalance(marketId, m.userId);
  }
  return updated;
}
