import { db } from '../db.js';
import { getMarket } from '../markets.js';

const getBalance = db.prepare('SELECT cash_cents, funded FROM balances WHERE market_id = ? AND user_id = ?');
const initBalance = db.prepare(
  'INSERT OR IGNORE INTO balances(market_id, user_id, cash_cents, funded) VALUES (?, ?, 0, 0)',
);
const markFunded = db.prepare('UPDATE balances SET funded = 1 WHERE market_id = ? AND user_id = ?');
const addCashStmt = db.prepare(
  'UPDATE balances SET cash_cents = cash_cents + ? WHERE market_id = ? AND user_id = ?',
);

const getPos = db.prepare(
  'SELECT shares FROM positions WHERE market_id = ? AND user_id = ? AND option_id = ?',
);
const allPos = db.prepare('SELECT option_id, shares FROM positions WHERE market_id = ? AND user_id = ?');
const initPos = db.prepare(
  'INSERT OR IGNORE INTO positions(market_id, user_id, option_id, shares) VALUES (?, ?, ?, 0)',
);
const setPos = db.prepare(
  'UPDATE positions SET shares = ? WHERE market_id = ? AND user_id = ? AND option_id = ?',
);
const addPosStmt = db.prepare(
  'UPDATE positions SET shares = shares + ? WHERE market_id = ? AND user_id = ? AND option_id = ?',
);

export function getCash(marketId: string, userId: string): number {
  const r = getBalance.get(marketId, userId) as { cash_cents: number } | undefined;
  return r?.cash_cents ?? 0;
}

export function isFunded(marketId: string, userId: string): boolean {
  const r = getBalance.get(marketId, userId) as { funded: number } | undefined;
  return !!r && r.funded === 1;
}

export function getPositionShares(marketId: string, userId: string, optionId: string): number {
  const r = getPos.get(marketId, userId, optionId) as { shares: number } | undefined;
  return r?.shares ?? 0;
}

export function getPositions(marketId: string, userId: string): { optionId: string; shares: number }[] {
  const rows = allPos.all(marketId, userId) as unknown as { option_id: string; shares: number }[];
  return rows.map((r) => ({ optionId: r.option_id, shares: r.shares }));
}

/**
 * Grants a member their starting allocation: `sharesPerOption` of every option and
 * a zero cash balance. Idempotent — only the first call per member has effect.
 */
export function fundMember(marketId: string, userId: string): void {
  const market = getMarket(marketId);
  if (!market) return;
  initBalance.run(marketId, userId);
  if (isFunded(marketId, userId)) return;
  for (const opt of market.options) {
    initPos.run(marketId, userId, opt.id);
    setPos.run(market.sharesPerOption, marketId, userId, opt.id);
  }
  markFunded.run(marketId, userId);
}

/** Applies one executed trade to both sides' positions and cash. Call inside a transaction. */
export function applyTrade(
  marketId: string,
  buyerId: string,
  sellerId: string,
  optionId: string,
  shares: number,
  totalCents: number,
): void {
  initPos.run(marketId, buyerId, optionId);
  initPos.run(marketId, sellerId, optionId);
  initBalance.run(marketId, buyerId);
  initBalance.run(marketId, sellerId);
  addPosStmt.run(shares, marketId, buyerId, optionId);
  addPosStmt.run(-shares, marketId, sellerId, optionId);
  addCashStmt.run(-totalCents, marketId, buyerId);
  addCashStmt.run(totalCents, marketId, sellerId);
}
