// WebSocket message protocol between web client and server.
import type {
  FreezeInfo,
  Holding,
  JoinRequest,
  Market,
  Member,
  OptionBook,
  Order,
  PricePoint,
  SettlementInfo,
  Trade,
} from './types.js';

// ---- Client -> Server ----
export type ClientMessage =
  | { type: 'subscribe'; marketId: string }
  | { type: 'unsubscribe'; marketId: string }
  | { type: 'ping' }
  | {
      type: 'place_order';
      marketId: string;
      optionId: string;
      side: 'buy' | 'sell';
      priceCents: number;
      quantity: number;
      orderType?: 'limit' | 'market'; // default 'limit'
      clientRef?: string;
    }
  | { type: 'cancel_order'; marketId: string; orderId: string };

// ---- Server -> Client ----
export interface MarketSnapshot {
  market: Market;
  members: Member[];
  books: OptionBook[];
  recentTrades: Trade[];
  priceHistory: PricePoint[];
  myOrders: Order[];
  myCashCents: number;
  myPositions: { optionId: string; shares: number }[];
  openOrders: Order[]; // every member's resting orders (transparent)
  holdings: Holding[]; // every member's shares + cash (transparent)
  pendingRequests: JoinRequest[]; // populated only for the creator
  freeze: FreezeInfo | null; // present while an early-freeze vote is open
  settlement: SettlementInfo | null; // present once the window freezes
}

export type ServerMessage =
  | { type: 'hello'; userId: string }
  | { type: 'subscribed'; marketId: string; snapshot: MarketSnapshot }
  | { type: 'pong' }
  | { type: 'error'; message: string; ref?: string }
  | { type: 'join_request'; marketId: string; request: JoinRequest }
  | { type: 'membership_update'; marketId: string; member: Member }
  | { type: 'market_update'; marketId: string; market: Market }
  | { type: 'trade'; marketId: string; trade: Trade; book: OptionBook }
  | { type: 'book'; marketId: string; book: OptionBook }
  | { type: 'order_update'; marketId: string; order: Order }
  | { type: 'balance'; marketId: string; cashCents: number; positions: { optionId: string; shares: number }[] }
  | { type: 'holding_update'; marketId: string; holding: Holding }
  | { type: 'freeze_update'; marketId: string; freeze: FreezeInfo | null }
  | { type: 'settlement_update'; marketId: string; market: Market; settlement: SettlementInfo };

export const WS_PATH = '/ws';
