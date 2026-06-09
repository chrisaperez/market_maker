import type { WebSocket } from 'ws';
import type { ClientMessage } from '@mm/shared';
import { hub } from '../realtime.js';
import { cancelOrder, OrderError, placeOrder } from './engine.js';

export { buildOptionBook } from './book.js';
export {
  getAllOpenOrders,
  getHoldings,
  getMarketTrades,
  getMyOpenOrders,
  openMarket,
  sendBalance,
} from './engine.js';

/** Routes trading messages (place/cancel) to the FIFO matching engine. */
export function handleOrderMessage(
  ws: WebSocket,
  userId: string,
  msg: Extract<ClientMessage, { type: 'place_order' | 'cancel_order' }>,
): void {
  const ref = msg.type === 'place_order' ? msg.clientRef : undefined;
  try {
    if (msg.type === 'place_order') {
      placeOrder(userId, {
        marketId: msg.marketId,
        optionId: msg.optionId,
        side: msg.side,
        priceCents: msg.priceCents,
        quantity: msg.quantity,
        orderType: msg.orderType,
      });
    } else {
      cancelOrder(userId, { marketId: msg.marketId, orderId: msg.orderId });
    }
  } catch (err) {
    const message = err instanceof OrderError ? err.message : 'Could not process your order.';
    if (!(err instanceof OrderError)) console.error('[engine]', err);
    hub.send(ws, { type: 'error', message, ref });
  }
}
