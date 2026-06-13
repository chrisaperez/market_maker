import {
  payoutCents,
  type FreezeInfo,
  type Market,
  type SettlementInfo,
  type SettlementResult,
  type SettlementVote,
} from '@mm/shared';
import { db } from './db.js';
import { buildOptionBook, cancelAllOpenOrders } from './engine/book.js';
import { getCash, getPositionShares } from './engine/ledger.js';
import { getMarket, setMarketStatus, setWinner } from './markets.js';
import { listMembers } from './membership.js';
import { hub } from './realtime.js';

export class SettlementError extends Error {}

const deleteVotes = db.prepare('DELETE FROM settlement_votes WHERE market_id = ?');
const upsertVote = db.prepare(`
  INSERT INTO settlement_votes(market_id, user_id, agree, voted_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(market_id, user_id) DO UPDATE SET agree = excluded.agree, voted_at = excluded.voted_at
`);
const selectVotes = db.prepare('SELECT user_id, agree, voted_at FROM settlement_votes WHERE market_id = ?');

const deleteFreezeVotes = db.prepare('DELETE FROM freeze_votes WHERE market_id = ?');
const upsertFreezeVote = db.prepare(`
  INSERT INTO freeze_votes(market_id, user_id, agree, voted_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(market_id, user_id) DO UPDATE SET agree = excluded.agree, voted_at = excluded.voted_at
`);
const selectFreezeVotes = db.prepare('SELECT user_id, agree, voted_at FROM freeze_votes WHERE market_id = ?');

function activeMembers(marketId: string) {
  return listMembers(marketId).filter((m) => m.status === 'active');
}

/** Agree votes needed: at least 50% of active members (and at least 1). */
function requiredVotes(marketId: string): number {
  return Math.max(1, Math.ceil(activeMembers(marketId).length / 2));
}

function getVotes(marketId: string): SettlementVote[] {
  const rows = selectVotes.all(marketId) as unknown as {
    user_id: string;
    agree: number;
    voted_at: number;
  }[];
  return rows.map((r) => ({ marketId, userId: r.user_id, agree: r.agree === 1, votedAt: r.voted_at }));
}

function computeResults(market: Market): SettlementResult[] {
  const econ = { buyInCents: market.buyInCents, sharesPerOption: market.sharesPerOption };
  return activeMembers(market.id).map((m) => {
    const winningShares = market.winningOptionId
      ? getPositionShares(market.id, m.userId, market.winningOptionId)
      : 0;
    const payout = payoutCents(winningShares, econ);
    const tradingCash = getCash(market.id, m.userId);
    return {
      userId: m.userId,
      username: m.username,
      winningShares,
      payoutCents: payout,
      tradingCashCents: tradingCash,
      buyInCents: market.buyInCents,
      finalBalanceCents: payout + tradingCash - market.buyInCents,
    };
  });
}

export function getSettlementInfo(marketId: string): SettlementInfo | null {
  const market = getMarket(marketId);
  if (!market) return null;
  if (!['frozen', 'settling', 'settled'].includes(market.status)) return null;
  const votes = getVotes(marketId);
  return {
    winningOptionId: market.winningOptionId,
    votes,
    required: requiredVotes(marketId),
    agreeCount: votes.filter((v) => v.agree).length,
    results: market.status === 'settled' ? computeResults(market) : null,
  };
}

function broadcastSettlement(market: Market): void {
  const info = getSettlementInfo(market.id);
  if (!info) return;
  const msg = { type: 'settlement_update' as const, marketId: market.id, market, settlement: info };
  hub.broadcast(market.id, msg);
  for (const m of activeMembers(market.id)) hub.sendToUser(m.userId, msg);
}

// ---- early-freeze voting (creator proposes; ≥50% must agree) ----

function getFreezeVotes(marketId: string): SettlementVote[] {
  const rows = selectFreezeVotes.all(marketId) as unknown as {
    user_id: string;
    agree: number;
    voted_at: number;
  }[];
  return rows.map((r) => ({ marketId, userId: r.user_id, agree: r.agree === 1, votedAt: r.voted_at }));
}

export function getFreezeInfo(marketId: string): FreezeInfo | null {
  const market = getMarket(marketId);
  if (!market || market.status !== 'open') return null;
  const votes = getFreezeVotes(marketId);
  if (votes.length === 0) return null; // no early freeze proposed
  return { votes, required: requiredVotes(marketId), agreeCount: votes.filter((v) => v.agree).length };
}

function broadcastFreeze(marketId: string): void {
  const msg = { type: 'freeze_update' as const, marketId, freeze: getFreezeInfo(marketId) };
  hub.broadcast(marketId, msg);
  for (const m of activeMembers(marketId)) hub.sendToUser(m.userId, msg);
}

/** Creator proposes ending the trading window early (their proposal counts as a vote). */
export function requestFreeze(marketId: string, actorId: string): void {
  const market = getMarket(marketId);
  if (!market) throw new SettlementError('Market not found.');
  if (market.creatorId !== actorId) throw new SettlementError('Only the creator can propose an early freeze.');
  if (market.status !== 'open') throw new SettlementError('Trading is not open.');
  deleteFreezeVotes.run(marketId);
  upsertFreezeVote.run(marketId, actorId, 1, Date.now());
  broadcastFreeze(marketId);
  maybeFreeze(marketId);
}

/** A member agrees to (or rejects) freezing early. */
export function voteFreeze(marketId: string, userId: string, agree: boolean): void {
  const market = getMarket(marketId);
  if (!market) throw new SettlementError('Market not found.');
  if (market.status !== 'open') throw new SettlementError('Trading is not open.');
  if (getFreezeVotes(marketId).length === 0) throw new SettlementError('No early freeze has been proposed.');
  if (!activeMembers(marketId).some((m) => m.userId === userId)) {
    throw new SettlementError('Only members can vote.');
  }
  upsertFreezeVote.run(marketId, userId, agree ? 1 : 0, Date.now());
  broadcastFreeze(marketId);
  maybeFreeze(marketId);
}

function maybeFreeze(marketId: string): void {
  const info = getFreezeInfo(marketId);
  if (info && info.agreeCount >= info.required) freezeMarket(marketId);
}

/** Freezes trading: cancels the book and moves the market to `frozen`. */
export function freezeMarket(marketId: string): void {
  const market = getMarket(marketId);
  if (!market || market.status !== 'open') return;
  cancelAllOpenOrders(marketId);
  deleteFreezeVotes.run(marketId);
  setMarketStatus(marketId, 'frozen');
  const updated = getMarket(marketId)!;
  hub.broadcast(marketId, { type: 'market_update', marketId, market: updated });
  for (const o of updated.options) {
    hub.broadcast(marketId, { type: 'book', marketId, book: buildOptionBook(marketId, o.id) });
  }
  broadcastSettlement(updated);
}

/** Creator declares the winning option and auto-verifies it; opens voting. */
export function declareWinner(marketId: string, actorId: string, winningOptionId: string): Market {
  const market = getMarket(marketId);
  if (!market) throw new SettlementError('Market not found.');
  if (market.creatorId !== actorId) throw new SettlementError('Only the creator can declare the result.');
  if (market.status !== 'frozen' && market.status !== 'settling') {
    throw new SettlementError('The market must be frozen before declaring a result.');
  }
  if (!market.options.some((o) => o.id === winningOptionId)) {
    throw new SettlementError('That option is not in this market.');
  }

  setWinner(marketId, 'settling', winningOptionId);
  // Fresh vote round; the creator's declaration counts as their own verification.
  deleteVotes.run(marketId);
  upsertVote.run(marketId, actorId, 1, Date.now());

  const updated = getMarket(marketId)!;
  broadcastSettlement(updated);
  hub.broadcast(marketId, { type: 'market_update', marketId, market: updated });
  maybeFinalize(marketId);
  return getMarket(marketId)!;
}

/** A member verifies (or disputes) the declared result. */
export function voteSettlement(marketId: string, userId: string, agree: boolean): void {
  const market = getMarket(marketId);
  if (!market) throw new SettlementError('Market not found.');
  if (market.status !== 'settling') throw new SettlementError('There is no result to verify yet.');
  if (!activeMembers(marketId).some((m) => m.userId === userId)) {
    throw new SettlementError('Only members can verify the result.');
  }
  upsertVote.run(marketId, userId, agree ? 1 : 0, Date.now());
  broadcastSettlement(getMarket(marketId)!);
  maybeFinalize(marketId);
}

function maybeFinalize(marketId: string): void {
  const info = getSettlementInfo(marketId);
  if (!info) return;
  if (info.agreeCount >= info.required) finalize(marketId);
}

function finalize(marketId: string): void {
  const market = getMarket(marketId);
  if (!market || market.status !== 'settling') return;
  setMarketStatus(marketId, 'settled');
  const settled = getMarket(marketId)!;
  broadcastSettlement(settled);
  hub.broadcast(marketId, { type: 'market_update', marketId, market: settled });
  for (const m of activeMembers(marketId)) {
    hub.sendToUser(m.userId, { type: 'market_update', marketId, market: settled });
  }
}
