import { nanoid } from 'nanoid';
import {
  computeFairness,
  DEFAULT_MAX_OWE_PCT,
  MAX_OPTIONS,
  MIN_OPTIONS,
  validateEconomics,
  type Market,
  type MarketOption,
  type MarketStatus,
} from '@mm/shared';
import { db, transaction } from './db.js';

export interface CreateMarketInput {
  title: string;
  description?: string;
  buyInCents: number;
  sharesPerOption: number;
  windowSeconds: number;
  maxOwePct?: number;
  options: string[];
}

interface MarketRow {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  buy_in_cents: number;
  shares_per_option: number;
  par_value_cents: number;
  window_seconds: number;
  max_owe_pct: number;
  bot_enabled: number;
  status: string;
  opened_at: number | null;
  closes_at: number | null;
  winning_option_id: string | null;
  created_at: number;
}

interface OptionRow {
  id: string;
  market_id: string;
  label: string;
  sort_order: number;
}

const insertMarket = db.prepare(`
  INSERT INTO markets(id, creator_id, title, description, buy_in_cents, shares_per_option,
    par_value_cents, window_seconds, max_owe_pct, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
`);
const updateMarketRow = db.prepare(`
  UPDATE markets SET title = ?, description = ?, buy_in_cents = ?, shares_per_option = ?,
    par_value_cents = ?, window_seconds = ?, max_owe_pct = ? WHERE id = ?
`);
const deleteOptionsStmt = db.prepare('DELETE FROM market_options WHERE market_id = ?');
const deleteMembershipsStmt = db.prepare('DELETE FROM memberships WHERE market_id = ?');
const deleteMarketStmt = db.prepare('DELETE FROM markets WHERE id = ?');
const insertOption = db.prepare(
  'INSERT INTO market_options(id, market_id, label, sort_order) VALUES (?, ?, ?, ?)',
);
const insertMembership = db.prepare(
  'INSERT INTO memberships(market_id, user_id, role, status, joined_at) VALUES (?, ?, ?, ?, ?)',
);
const selectMarket = db.prepare('SELECT * FROM markets WHERE id = ?');
const selectOptions = db.prepare(
  'SELECT * FROM market_options WHERE market_id = ? ORDER BY sort_order',
);
const selectMarketsForUser = db.prepare(`
  SELECT m.* FROM markets m
  JOIN memberships mem ON mem.market_id = m.id
  WHERE mem.user_id = ? AND mem.status != 'denied'
  ORDER BY m.created_at DESC
`);
const updateStatus = db.prepare('UPDATE markets SET status = ? WHERE id = ?');
const updateOpen = db.prepare(
  "UPDATE markets SET status = 'open', opened_at = ?, closes_at = ? WHERE id = ?",
);
const updateWinner = db.prepare(
  "UPDATE markets SET status = ?, winning_option_id = ? WHERE id = ?",
);

export class MarketError extends Error {}

function loadOptions(marketId: string): MarketOption[] {
  return (selectOptions.all(marketId) as unknown as OptionRow[]).map((r) => ({
    id: r.id,
    marketId: r.market_id,
    label: r.label,
    sortOrder: r.sort_order,
  }));
}

function rowToMarket(r: MarketRow): Market {
  return {
    id: r.id,
    creatorId: r.creator_id,
    title: r.title,
    description: r.description,
    buyInCents: r.buy_in_cents,
    sharesPerOption: r.shares_per_option,
    parValueCents: r.par_value_cents,
    windowSeconds: r.window_seconds,
    maxOwePct: r.max_owe_pct,
    botEnabled: r.bot_enabled === 1,
    status: r.status as MarketStatus,
    openedAt: r.opened_at,
    closesAt: r.closes_at,
    winningOptionId: r.winning_option_id,
    createdAt: r.created_at,
    options: loadOptions(r.id),
  };
}

export function getMarket(id: string): Market | null {
  const r = selectMarket.get(id) as MarketRow | undefined;
  return r ? rowToMarket(r) : null;
}

export function listMarketsForUser(userId: string): Market[] {
  return (selectMarketsForUser.all(userId) as unknown as MarketRow[]).map(rowToMarket);
}

interface CleanMarketInput {
  title: string;
  description: string;
  labels: string[];
  parValueCents: number;
  maxOwePct: number;
}

function validateMarketInput(input: CreateMarketInput): CleanMarketInput {
  const econ = validateEconomics({
    buyInCents: input.buyInCents,
    sharesPerOption: input.sharesPerOption,
  });
  if (!econ.ok) throw new MarketError(econ.errors.join(' '));

  const labels = input.options.map((l) => l.trim()).filter(Boolean);
  if (labels.length < MIN_OPTIONS || labels.length > MAX_OPTIONS) {
    throw new MarketError(`A market needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`);
  }
  const lower = labels.map((l) => l.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    throw new MarketError('Option labels must be unique.');
  }
  const title = input.title.trim();
  if (!title) throw new MarketError('A market needs a title.');
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 10) {
    throw new MarketError('Trading window must be at least 10 seconds.');
  }
  const maxOwePct = input.maxOwePct ?? DEFAULT_MAX_OWE_PCT;
  if (!Number.isInteger(maxOwePct) || maxOwePct < 0 || maxOwePct > 1000) {
    throw new MarketError('Debt limit must be a whole percentage between 0 and 1000.');
  }
  const { parValueCents } = computeFairness({
    buyInCents: input.buyInCents,
    sharesPerOption: input.sharesPerOption,
  });
  return { title, description: input.description?.trim() ?? '', labels, parValueCents: Math.round(parValueCents), maxOwePct };
}

/** Creates a market in `draft` status — the creator edits it, then publishes. */
export function createMarket(creatorId: string, input: CreateMarketInput): Market {
  const v = validateMarketInput(input);
  const id = nanoid();
  const now = Date.now();
  transaction(() => {
    insertMarket.run(
      id, creatorId, v.title, v.description, input.buyInCents, input.sharesPerOption,
      v.parValueCents, input.windowSeconds, v.maxOwePct, now,
    );
    v.labels.forEach((label, i) => insertOption.run(nanoid(), id, label, i));
    insertMembership.run(id, creatorId, 'creator', 'active', now);
  });
  return getMarket(id)!;
}

function requireDraftCreator(marketId: string, actorId: string): Market {
  const market = getMarket(marketId);
  if (!market) throw new MarketError('Market not found.');
  if (market.creatorId !== actorId) throw new MarketError('Only the creator can do that.');
  if (market.status !== 'draft') throw new MarketError('Only draft markets can be edited.');
  return market;
}

/** Edits a draft's details + outcomes (replaces the option list). */
export function updateMarketDraft(marketId: string, actorId: string, input: CreateMarketInput): Market {
  requireDraftCreator(marketId, actorId);
  const v = validateMarketInput(input);
  transaction(() => {
    updateMarketRow.run(
      v.title, v.description, input.buyInCents, input.sharesPerOption,
      v.parValueCents, input.windowSeconds, v.maxOwePct, marketId,
    );
    deleteOptionsStmt.run(marketId);
    v.labels.forEach((label, i) => insertOption.run(nanoid(), marketId, label, i));
  });
  return getMarket(marketId)!;
}

/** Publishes a draft → `lobby` (now shareable, accepting members). */
export function publishMarket(marketId: string, actorId: string): Market {
  requireDraftCreator(marketId, actorId);
  setMarketStatus(marketId, 'lobby');
  return getMarket(marketId)!;
}

export function deleteDraft(marketId: string, actorId: string): void {
  requireDraftCreator(marketId, actorId);
  transaction(() => {
    deleteOptionsStmt.run(marketId);
    deleteMembershipsStmt.run(marketId);
    deleteMarketStmt.run(marketId);
  });
}

export function setMarketStatus(id: string, status: MarketStatus): void {
  updateStatus.run(status, id);
}

const updateBotEnabled = db.prepare('UPDATE markets SET bot_enabled = ? WHERE id = ?');
export function setBotEnabled(id: string, enabled: boolean): void {
  updateBotEnabled.run(enabled ? 1 : 0, id);
}

export function openMarketRow(id: string, openedAt: number, closesAt: number): void {
  updateOpen.run(openedAt, closesAt, id);
}

export function setWinner(id: string, status: MarketStatus, winningOptionId: string | null): void {
  updateWinner.run(status, winningOptionId, id);
}
