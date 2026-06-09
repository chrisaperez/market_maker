import type { MarketSnapshot, PricePoint } from '@mm/shared';
import { buildOptionBook, getMarketTrades, getMyOpenOrders } from './engine/index.js';
import { getCash, getPositions } from './engine/ledger.js';
import { getMarket } from './markets.js';
import { listMembers, listPendingRequests } from './membership.js';
import { getSettlementInfo } from './settlement.js';

/** Full point-in-time view a client gets when it subscribes to a market. */
export function buildSnapshot(marketId: string, userId: string): MarketSnapshot | null {
  const market = getMarket(marketId);
  if (!market) return null;

  const books = market.options.map((o) => buildOptionBook(marketId, o.id));
  const recentTrades = getMarketTrades(marketId);
  const priceHistory: PricePoint[] = recentTrades.map((t) => ({
    optionId: t.optionId,
    priceCents: t.priceCents,
    timestampMs: t.timestampMs,
  }));
  const isCreator = market.creatorId === userId;

  return {
    market,
    members: listMembers(marketId),
    books,
    recentTrades,
    priceHistory,
    myOrders: getMyOpenOrders(marketId, userId),
    myCashCents: getCash(marketId, userId),
    myPositions: getPositions(marketId, userId),
    pendingRequests: isCreator ? listPendingRequests(marketId) : [],
    settlement: getSettlementInfo(marketId),
  };
}
