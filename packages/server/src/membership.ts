import jwt from 'jsonwebtoken';
import type { JoinRequest, Member, MembershipStatus } from '@mm/shared';
import { getUser, setUsername } from './auth.js';
import { JWT_SECRET } from './config.js';
import { db } from './db.js';
import { fundMember } from './engine/ledger.js';
import { getMarket } from './markets.js';
import { hub } from './realtime.js';

interface MembershipRow {
  market_id: string;
  user_id: string;
  username: string | null;
  role: string;
  status: string;
  joined_at: number;
}

const selectMembership = db.prepare('SELECT * FROM memberships WHERE market_id = ? AND user_id = ?');
const insertPending = db.prepare(
  "INSERT INTO memberships(market_id, user_id, role, status, joined_at) VALUES (?, ?, 'member', 'pending', ?)",
);
const setMembershipStatus = db.prepare(
  'UPDATE memberships SET status = ? WHERE market_id = ? AND user_id = ?',
);
const selectMembers = db.prepare(`
  SELECT mem.market_id, mem.user_id, u.username AS username, mem.role, mem.status, mem.joined_at
  FROM memberships mem JOIN users u ON u.id = mem.user_id
  WHERE mem.market_id = ?
  ORDER BY mem.joined_at
`);

export class MembershipError extends Error {}

export function createInviteToken(marketId: string): string {
  return jwt.sign({ mid: marketId, kind: 'invite' }, JWT_SECRET);
}

export function verifyInviteToken(token: string, marketId: string): boolean {
  try {
    const p = jwt.verify(token, JWT_SECRET) as { mid?: string; kind?: string };
    return p.kind === 'invite' && p.mid === marketId;
  } catch {
    return false;
  }
}

function rowToMember(r: MembershipRow): Member {
  return {
    marketId: r.market_id,
    userId: r.user_id,
    username: r.username,
    role: r.role as Member['role'],
    status: r.status as MembershipStatus,
    joinedAt: r.joined_at,
  };
}

export function getMembership(marketId: string, userId: string): Member | null {
  const r = selectMembership.get(marketId, userId) as MembershipRow | undefined;
  if (!r) return null;
  const user = getUser(userId);
  return rowToMember({ ...r, username: user?.username ?? null });
}

export function listMembers(marketId: string): Member[] {
  return (selectMembers.all(marketId) as unknown as MembershipRow[]).map(rowToMember);
}

export function listPendingRequests(marketId: string): JoinRequest[] {
  return listMembers(marketId)
    .filter((m) => m.status === 'pending')
    .map((m) => ({
      marketId: m.marketId,
      userId: m.userId,
      username: m.username ?? 'unknown',
      requestedAt: m.joinedAt,
    }));
}

export function isActiveMember(marketId: string, userId: string): boolean {
  const m = getMembership(marketId, userId);
  return !!m && m.status === 'active';
}

/**
 * Records a request to join a market (the allowlist gate). Sets the user's
 * username on first join, then notifies the creator in real time.
 */
export function requestJoin(
  marketId: string,
  userId: string,
  username: string,
  inviteToken: string,
): Member {
  const market = getMarket(marketId);
  if (!market) throw new MembershipError('Market not found.');
  if (!verifyInviteToken(inviteToken, marketId)) {
    throw new MembershipError('This invite link is invalid.');
  }
  if (market.status === 'settled' || market.status === 'cancelled') {
    throw new MembershipError('This market is closed to new members.');
  }

  // Set username on first join; otherwise keep the user's existing identity.
  let user = getUser(userId)!;
  if (!user.username) user = setUsername(userId, username);

  const existing = selectMembership.get(marketId, userId) as MembershipRow | undefined;
  if (existing) {
    if (existing.status === 'active') return getMembership(marketId, userId)!;
    if (existing.status === 'denied') setMembershipStatus.run('pending', marketId, userId);
    // pending stays pending
  } else {
    insertPending.run(marketId, userId, Date.now());
  }

  const member = getMembership(marketId, userId)!;
  const request: JoinRequest = {
    marketId,
    userId,
    username: member.username ?? username,
    requestedAt: member.joinedAt,
  };
  // Ping the creator (all their open tabs), even if they aren't viewing this market.
  hub.sendToUser(market.creatorId, { type: 'join_request', marketId, request });
  return member;
}

function requireCreator(marketId: string, actorId: string): void {
  const market = getMarket(marketId);
  if (!market) throw new MembershipError('Market not found.');
  if (market.creatorId !== actorId) {
    throw new MembershipError('Only the market creator can do that.');
  }
}

export function approveMember(marketId: string, actorId: string, targetUserId: string): Member {
  requireCreator(marketId, actorId);
  const existing = selectMembership.get(marketId, targetUserId) as MembershipRow | undefined;
  if (!existing) throw new MembershipError('No such join request.');
  setMembershipStatus.run('active', marketId, targetUserId);
  // If the market is already trading, fund late arrivals so they can participate.
  const market = getMarket(marketId);
  if (market && market.status === 'open') fundMember(marketId, targetUserId);
  const member = getMembership(marketId, targetUserId)!;
  hub.sendToUser(targetUserId, { type: 'membership_update', marketId, member });
  hub.broadcast(marketId, { type: 'membership_update', marketId, member });
  return member;
}

export function denyMember(marketId: string, actorId: string, targetUserId: string): Member {
  requireCreator(marketId, actorId);
  setMembershipStatus.run('denied', marketId, targetUserId);
  const member = getMembership(marketId, targetUserId)!;
  hub.sendToUser(targetUserId, { type: 'membership_update', marketId, member });
  return member;
}
