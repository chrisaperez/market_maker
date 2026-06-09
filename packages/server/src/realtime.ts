import type { WebSocket } from 'ws';
import type { ServerMessage } from '@mm/shared';

interface Conn {
  userId: string;
  subscriptions: Set<string>; // marketIds
}

/**
 * Tracks live WebSocket connections so we can push messages either to a
 * specific user (by userId, across all their tabs/devices) or broadcast to
 * everyone subscribed to a market room.
 */
class Hub {
  private conns = new Map<WebSocket, Conn>();
  private byUser = new Map<string, Set<WebSocket>>();
  private rooms = new Map<string, Set<WebSocket>>();

  add(ws: WebSocket, userId: string): void {
    this.conns.set(ws, { userId, subscriptions: new Set() });
    let set = this.byUser.get(userId);
    if (!set) this.byUser.set(userId, (set = new Set()));
    set.add(ws);
  }

  remove(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    for (const marketId of conn.subscriptions) {
      this.rooms.get(marketId)?.delete(ws);
    }
    this.byUser.get(conn.userId)?.delete(ws);
    this.conns.delete(ws);
  }

  userIdOf(ws: WebSocket): string | undefined {
    return this.conns.get(ws)?.userId;
  }

  subscribe(ws: WebSocket, marketId: string): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.subscriptions.add(marketId);
    let room = this.rooms.get(marketId);
    if (!room) this.rooms.set(marketId, (room = new Set()));
    room.add(ws);
  }

  unsubscribe(ws: WebSocket, marketId: string): void {
    this.conns.get(ws)?.subscriptions.delete(marketId);
    this.rooms.get(marketId)?.delete(ws);
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Push to every connection belonging to a user (all their open tabs). */
  sendToUser(userId: string, msg: ServerMessage): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const payload = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(payload);
  }

  /** Broadcast to everyone subscribed to a market room. */
  broadcast(marketId: string, msg: ServerMessage): void {
    const room = this.rooms.get(marketId);
    if (!room) return;
    const payload = JSON.stringify(msg);
    for (const ws of room) if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export const hub = new Hub();
