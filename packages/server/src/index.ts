import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parse as parseCookie } from 'cookie';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { ZodError } from 'zod';
import { WS_PATH, type ClientMessage } from '@mm/shared';
import './db.js'; // initialize schema on import
import { ensureSession, verifyToken } from './auth.js';
import { COOKIE_NAME, PORT } from './config.js';
import { getMarket } from './markets.js';
import { isActiveMember } from './membership.js';
import { hub } from './realtime.js';
import { router } from './routes.js';
import { startBotLoop } from './bot.js';
import { armOpenMarketTimers } from './scheduler.js';
import { buildSnapshot } from './snapshot.js';
import { handleOrderMessage } from './engine/index.js';

const app = express();
app.set('trust proxy', 1); // behind Fly's TLS-terminating proxy in production
app.use(express.json());
app.use(cookieParser());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', ensureSession, router);

// In production the same server serves the built SPA (so API, WS and the app
// are same-origin — no CORS, cookies & WebSocket auth just work).
const webDist = path.resolve(import.meta.dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path === '/health') {
      return next();
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid input.', details: err.issues });
    return;
  }
  // Domain errors (MarketError/MembershipError/UsernameError) carry a safe message.
  const message = err instanceof Error ? err.message : 'Something went wrong.';
  console.error('[api error]', message);
  res.status(400).json({ error: message });
};
app.use(errorHandler);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  const cookies = parseCookie(req.headers.cookie ?? '');
  const userId =
    verifyToken(cookies[COOKIE_NAME]) ?? verifyToken(url.searchParams.get('token') ?? undefined);
  if (!userId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, userId);
  });
});

wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, userId: string) => {
  hub.add(ws, userId);
  hub.send(ws, { type: 'hello', userId });
  ws.on('message', (data) => handleMessage(ws, userId, data.toString()));
  ws.on('close', () => hub.remove(ws));
  ws.on('error', () => hub.remove(ws));
});

function handleMessage(ws: WebSocket, userId: string, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }
  switch (msg.type) {
    case 'ping':
      hub.send(ws, { type: 'pong' });
      return;
    case 'subscribe': {
      const market = getMarket(msg.marketId);
      if (!market) {
        hub.send(ws, { type: 'error', message: 'Market not found.' });
        return;
      }
      const allowed = market.creatorId === userId || isActiveMember(msg.marketId, userId);
      if (!allowed) {
        hub.send(ws, { type: 'error', message: 'You are not a member of this market.' });
        return;
      }
      hub.subscribe(ws, msg.marketId);
      const snapshot = buildSnapshot(msg.marketId, userId);
      if (snapshot) hub.send(ws, { type: 'subscribed', marketId: msg.marketId, snapshot });
      return;
    }
    case 'unsubscribe':
      hub.unsubscribe(ws, msg.marketId);
      return;
    case 'place_order':
    case 'cancel_order':
      handleOrderMessage(ws, userId, msg);
      return;
    default:
      return;
  }
}

// Keep idle connections alive through proxies.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.ping();
  }
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`[server] http + ws listening on http://localhost:${PORT}`);
  armOpenMarketTimers(); // re-arm freeze timers for markets still in their window
  startBotLoop(); // keep liquidity-bot quotes fresh in bot-enabled markets
});
