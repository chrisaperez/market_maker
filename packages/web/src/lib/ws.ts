import type { ClientMessage, ServerMessage } from '@mm/shared';

type Handler = (msg: ServerMessage) => void;

/**
 * Singleton WebSocket client. Auto-connects on first use, queues messages sent
 * while offline, auto-reconnects, and re-subscribes to active market rooms after
 * a reconnect so live updates survive network blips.
 */
class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private queue: ClientMessage[] = [];
  private subs = new Set<string>();
  private reconnectTimer: number | null = null;

  private connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      for (const m of this.queue) ws.send(JSON.stringify(m));
      this.queue = [];
      for (const id of this.subs) ws.send(JSON.stringify({ type: 'subscribe', marketId: id }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.handlers.size > 0) this.connect();
    }, 1000);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else {
      this.queue.push(msg);
      this.connect();
    }
  }

  subscribeMarket(marketId: string): void {
    this.subs.add(marketId);
    this.send({ type: 'subscribe', marketId });
  }

  unsubscribeMarket(marketId: string): void {
    this.subs.delete(marketId);
    this.send({ type: 'unsubscribe', marketId });
  }

  /** Register a message handler. Returns an unsubscribe function. */
  on(handler: Handler): () => void {
    this.handlers.add(handler);
    this.connect();
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export const wsClient = new WsClient();
