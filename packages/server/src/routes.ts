import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { computeFairness } from '@mm/shared';
import { getUser, setUsername, userIdOf } from './auth.js';
import {
  approveMember,
  createInviteToken,
  denyMember,
  getMembership,
  listMembers,
  listPendingRequests,
  requestJoin,
  verifyInviteToken,
} from './membership.js';
import { createMarket, getMarket, listMarketsForUser } from './markets.js';
import { openMarket } from './engine/index.js';
import { declareWinner, voteSettlement } from './settlement.js';

export const router = Router();

function me(res: Response) {
  const userId = userIdOf(res);
  return { userId, username: getUser(userId)?.username ?? null };
}

router.post('/auth/init', (_req, res) => {
  res.json(me(res));
});

router.get('/me', (_req, res) => {
  res.json(me(res));
});

const usernameSchema = z.object({ username: z.string() });
router.post('/auth/username', (req, res) => {
  const { username } = usernameSchema.parse(req.body);
  const user = setUsername(userIdOf(res), username);
  res.json({ userId: user.id, username: user.username });
});

const createSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  buyInCents: z.number().int().positive(),
  sharesPerOption: z.number().int().positive(),
  windowSeconds: z.number().int().min(10),
  options: z.array(z.string().min(1).max(80)).min(2).max(50),
});

router.post('/markets', (req, res) => {
  const input = createSchema.parse(req.body);
  const market = createMarket(userIdOf(res), input);
  res.json({ market });
});

router.get('/markets', (_req, res) => {
  res.json({ markets: listMarketsForUser(userIdOf(res)) });
});

/** Market detail. Full access for members; invite-token holders get meta only. */
router.get('/markets/:id', (req: Request, res: Response) => {
  const userId = userIdOf(res);
  const market = getMarket(String(req.params.id));
  if (!market) return res.status(404).json({ error: 'Market not found.' });

  const membership = getMembership(market.id, userId);
  const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
  const hasInvite = invite ? verifyInviteToken(invite, market.id) : false;

  if (!membership && !hasInvite) {
    return res.status(403).json({ error: 'You need an invite to view this market.' });
  }

  const isCreator = market.creatorId === userId;
  const isMember = membership?.status === 'active' || isCreator;
  res.json({
    market,
    fairness: computeFairness({
      buyInCents: market.buyInCents,
      sharesPerOption: market.sharesPerOption,
    }),
    myStatus: membership?.status ?? 'none',
    role: membership?.role ?? null,
    members: isMember ? listMembers(market.id) : undefined,
    inviteToken: isCreator ? createInviteToken(market.id) : undefined,
    pendingRequests: isCreator ? listPendingRequests(market.id) : undefined,
  });
});

router.post('/markets/:id/open', (req, res) => {
  const market = openMarket(String(req.params.id), userIdOf(res));
  res.json({ market });
});

const declareSchema = z.object({ winningOptionId: z.string() });
router.post('/markets/:id/declare', (req, res) => {
  const { winningOptionId } = declareSchema.parse(req.body);
  const market = declareWinner(String(req.params.id), userIdOf(res), winningOptionId);
  res.json({ market });
});

const voteSchema = z.object({ agree: z.boolean() });
router.post('/markets/:id/vote', (req, res) => {
  const { agree } = voteSchema.parse(req.body);
  voteSettlement(String(req.params.id), userIdOf(res), agree);
  res.json({ ok: true });
});

router.post('/markets/:id/invite', (req, res) => {
  const userId = userIdOf(res);
  const market = getMarket(String(req.params.id));
  if (!market) return res.status(404).json({ error: 'Market not found.' });
  if (market.creatorId !== userId) {
    return res.status(403).json({ error: 'Only the creator can create invites.' });
  }
  res.json({ token: createInviteToken(market.id), marketId: market.id });
});

const joinSchema = z.object({ username: z.string(), invite: z.string() });
router.post('/markets/:id/join', (req, res) => {
  const { username, invite } = joinSchema.parse(req.body);
  const member = requestJoin(String(req.params.id), userIdOf(res), username, invite);
  res.json({ membership: member });
});

router.post('/markets/:id/members/:userId/approve', (req, res) => {
  const member = approveMember(String(req.params.id), userIdOf(res), String(req.params.userId));
  res.json({ member });
});

router.post('/markets/:id/members/:userId/deny', (req, res) => {
  const member = denyMember(String(req.params.id), userIdOf(res), String(req.params.userId));
  res.json({ member });
});
