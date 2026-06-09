// Shared domain types. All money is integer CENTS to avoid floating-point drift.

export type MarketStatus =
  | 'lobby' // accepting members; trading not started
  | 'open' // trading window active
  | 'frozen' // window closed; awaiting settlement
  | 'settling' // winner declared; collecting verification votes
  | 'settled' // finalized; balances available
  | 'cancelled';

export type MembershipRole = 'creator' | 'member';
export type MembershipStatus = 'pending' | 'active' | 'denied';
export type OrderSide = 'buy' | 'sell';

export interface User {
  id: string;
  username: string | null;
  createdAt: number;
}

export interface MarketOption {
  id: string;
  marketId: string;
  label: string;
  sortOrder: number;
}

export interface Market {
  id: string;
  creatorId: string;
  title: string;
  description: string;
  buyInCents: number;
  sharesPerOption: number;
  parValueCents: number;
  windowSeconds: number;
  status: MarketStatus;
  openedAt: number | null;
  closesAt: number | null;
  winningOptionId: string | null;
  createdAt: number;
  options: MarketOption[];
}

export interface Member {
  marketId: string;
  userId: string;
  username: string | null;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: number;
}

export interface JoinRequest {
  marketId: string;
  userId: string;
  username: string;
  requestedAt: number;
}

export interface Order {
  id: string;
  marketId: string;
  optionId: string;
  userId: string;
  side: OrderSide;
  priceCents: number;
  quantity: number; // original quantity (shares)
  remaining: number; // unfilled shares
  createdAt: number; // ms, server-authoritative — sets FIFO time priority
  status: 'open' | 'filled' | 'cancelled';
}

export interface Trade {
  id: string;
  marketId: string;
  optionId: string;
  buyerId: string;
  sellerId: string;
  priceCents: number;
  shares: number;
  totalCents: number;
  timestampMs: number; // exact server time
}

/** A user's ledger within one market. */
export interface Position {
  marketId: string;
  userId: string;
  optionId: string;
  shares: number;
}

export interface Balance {
  marketId: string;
  userId: string;
  cashCents: number; // may be negative ("owes the ledger")
}

export interface SettlementVote {
  marketId: string;
  userId: string;
  agree: boolean;
  votedAt: number;
}

/** Live state of a market's settlement (winner declared → verification → finalized). */
export interface SettlementInfo {
  winningOptionId: string | null;
  votes: SettlementVote[];
  required: number; // agree votes needed (≥ 50% of active members)
  agreeCount: number;
  results: SettlementResult[] | null; // populated once finalized
}

/** Final per-user result once a market is settled. */
export interface SettlementResult {
  userId: string;
  username: string | null;
  winningShares: number;
  payoutCents: number; // winningShares * parValue
  tradingCashCents: number; // cash from trading (excludes buy-in)
  buyInCents: number;
  finalBalanceCents: number; // payout + tradingCash - buyIn (owed if +, owes if -)
}

/** One point on an option's price chart (last trade price over time). */
export interface PricePoint {
  optionId: string;
  priceCents: number;
  timestampMs: number;
}

/** Aggregated resting depth at a single price level. */
export interface DepthLevel {
  priceCents: number;
  quantity: number;
}

export interface OptionBook {
  optionId: string;
  bids: DepthLevel[]; // sorted desc by price
  asks: DepthLevel[]; // sorted asc by price
  lastPriceCents: number | null;
  prevPriceCents: number | null; // for green/red direction
}
