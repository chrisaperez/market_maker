import type { FairnessResult, JoinRequest, Market, Member, MembershipStatus } from '@mm/shared';

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `Request failed (${res.status})`);
  return data as T;
}

export interface Session {
  userId: string;
  username: string | null;
}

export interface MarketDetail {
  market: Market;
  fairness: FairnessResult;
  myStatus: MembershipStatus | 'none';
  role: 'creator' | 'member' | null;
  members?: Member[];
  inviteToken?: string;
  pendingRequests?: JoinRequest[];
}

export interface CreateMarketBody {
  title: string;
  description?: string;
  buyInCents: number;
  sharesPerOption: number;
  windowSeconds: number;
  maxOwePct?: number;
  options: string[];
}

export const api = {
  init: () => req<Session>('/api/auth/init', { method: 'POST' }),
  me: () => req<Session>('/api/me'),
  setUsername: (username: string) =>
    req<Session>('/api/auth/username', { method: 'POST', body: JSON.stringify({ username }) }),
  listMarkets: () => req<{ markets: Market[] }>('/api/markets'),
  openMarket: (id: string) => req<{ market: Market }>(`/api/markets/${id}/open`, { method: 'POST' }),
  setBot: (id: string, enabled: boolean) =>
    req<{ ok: boolean }>(`/api/markets/${id}/bot`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  declareWinner: (id: string, winningOptionId: string) =>
    req<{ market: Market }>(`/api/markets/${id}/declare`, {
      method: 'POST',
      body: JSON.stringify({ winningOptionId }),
    }),
  voteSettlement: (id: string, agree: boolean) =>
    req<{ ok: boolean }>(`/api/markets/${id}/vote`, { method: 'POST', body: JSON.stringify({ agree }) }),
  requestFreeze: (id: string) =>
    req<{ ok: boolean }>(`/api/markets/${id}/freeze-request`, { method: 'POST' }),
  voteFreeze: (id: string, agree: boolean) =>
    req<{ ok: boolean }>(`/api/markets/${id}/freeze-vote`, { method: 'POST', body: JSON.stringify({ agree }) }),
  createMarket: (body: CreateMarketBody) =>
    req<{ market: Market }>('/api/markets', { method: 'POST', body: JSON.stringify(body) }),
  updateMarket: (id: string, body: CreateMarketBody) =>
    req<{ market: Market }>(`/api/markets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  publishMarket: (id: string) =>
    req<{ market: Market }>(`/api/markets/${id}/publish`, { method: 'POST' }),
  deleteMarket: (id: string) => req<{ ok: boolean }>(`/api/markets/${id}`, { method: 'DELETE' }),
  getMarket: (id: string, invite?: string) =>
    req<MarketDetail>(`/api/markets/${id}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`),
  join: (id: string, username: string, invite: string) =>
    req<{ membership: Member }>(`/api/markets/${id}/join`, {
      method: 'POST',
      body: JSON.stringify({ username, invite }),
    }),
  approve: (id: string, userId: string) =>
    req<{ member: Member }>(`/api/markets/${id}/members/${userId}/approve`, { method: 'POST' }),
  deny: (id: string, userId: string) =>
    req<{ member: Member }>(`/api/markets/${id}/members/${userId}/deny`, { method: 'POST' }),
};
