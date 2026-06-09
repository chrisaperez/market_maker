import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { dollars, type JoinRequest, type Member } from '@mm/shared';
import { api, type MarketDetail } from '../lib/api';
import { useApp } from '../lib/store';
import { wsClient } from '../lib/ws';
import { TradingRoom } from '../components/TradingRoom';

const STATUS_STYLE: Record<string, string> = {
  lobby: 'bg-sky-500/20 text-sky-300',
  open: 'bg-emerald-500/20 text-emerald-300',
  frozen: 'bg-amber-500/20 text-amber-300',
  settling: 'bg-violet-500/20 text-violet-300',
  settled: 'bg-white/15 text-white/70',
  cancelled: 'bg-red-500/20 text-red-300',
};

export default function Market() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const invite = params.get('invite') ?? '';
  const myUserId = useApp((s) => s.userId);

  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [pending, setPending] = useState<JoinRequest[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.getMarket(id, invite || undefined);
      setDetail(d);
      setPending(d.pendingRequests ?? []);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, invite]);

  useEffect(() => {
    load();
  }, [load]);

  // Live events for this market (approvals, new requests, status changes).
  useEffect(() => {
    if (!id) return;
    return wsClient.on((msg) => {
      if ('marketId' in msg && msg.marketId !== id) return;
      switch (msg.type) {
        case 'join_request':
          setPending((prev) =>
            prev.some((p) => p.userId === msg.request.userId) ? prev : [...prev, msg.request],
          );
          break;
        case 'subscribed':
          setDetail((d) => (d ? { ...d, members: msg.snapshot.members } : d));
          if (msg.snapshot.pendingRequests) setPending(msg.snapshot.pendingRequests);
          break;
        case 'membership_update':
        case 'market_update':
          load();
          break;
      }
    });
  }, [id, load]);

  // Subscribe to the room once we're allowed in (creator or active member).
  const canSubscribe = detail?.role === 'creator' || detail?.myStatus === 'active';
  useEffect(() => {
    if (!id || !canSubscribe) return;
    wsClient.subscribeMarket(id);
    return () => wsClient.unsubscribeMarket(id);
  }, [id, canSubscribe]);

  if (error && !detail) {
    return (
      <div className="max-w-md mx-auto rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-center">
        <p className="text-red-300">{error}</p>
      </div>
    );
  }
  if (!detail) return <p className="text-white/50">Loading…</p>;

  const { market, fairness, myStatus, role } = detail;
  const isCreator = role === 'creator';

  const approve = async (userId: string) => {
    await api.approve(id, userId);
    setPending((prev) => prev.filter((p) => p.userId !== userId));
    load();
  };
  const deny = async (userId: string) => {
    await api.deny(id, userId);
    setPending((prev) => prev.filter((p) => p.userId !== userId));
    load();
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{market.title}</h1>
          <span
            className={`text-xs rounded-full px-2 py-0.5 ${STATUS_STYLE[market.status] ?? 'bg-white/10'}`}
          >
            {market.status}
          </span>
        </div>
        {market.description && <p className="text-white/60 mt-1">{market.description}</p>}
        <div className="mt-2 text-sm text-white/50">
          {dollars(market.buyInCents)} buy-in → {market.sharesPerOption} shares of each option ·
          winner redeems {dollars(market.parValueCents)}/share
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {market.options.map((o) => (
            <span key={o.id} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-sm">
              {o.label}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-orange-500/20 bg-orange-500/[0.06] p-4 text-sm text-white/70">
        {fairness.explanation}
      </div>

      {myStatus === 'none' && (
        <JoinForm marketId={id} invite={invite} onJoined={load} />
      )}

      {myStatus === 'pending' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
          <p className="text-amber-200 font-medium">Waiting for the creator to approve you…</p>
          <p className="text-white/50 text-sm mt-1">
            This page updates automatically the moment you're let in.
          </p>
        </div>
      )}

      {myStatus === 'denied' && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-center text-red-300">
          Your request to join was declined.
        </div>
      )}

      {isCreator && <InvitePanel marketId={id} inviteToken={detail.inviteToken} />}

      {isCreator && (
        <section>
          <h2 className="font-medium mb-2">
            Join requests {pending.length > 0 && <span className="text-emerald-400">({pending.length})</span>}
          </h2>
          {pending.length === 0 ? (
            <p className="text-sm text-white/40">No pending requests.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {pending.map((r) => (
                <div
                  key={r.userId}
                  className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-2"
                >
                  <div>
                    <span className="font-medium">@{r.username}</span>
                    <span className="ml-2 text-xs text-white/40">id {r.userId.slice(0, 8)}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => approve(r.userId)}
                      className="rounded-md bg-orange-500 px-3 py-1 text-sm font-medium text-black transition hover:bg-orange-400"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => deny(r.userId)}
                      className="rounded-md border border-white/15 px-3 py-1 text-sm text-white/70 transition hover:text-white"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {(myStatus === 'active' || isCreator) && (
        <MemberList members={detail.members ?? []} myUserId={myUserId} />
      )}

      {(myStatus === 'active' || isCreator) && (
        <TradingRoom market={market} members={detail.members ?? []} isCreator={isCreator} />
      )}
    </div>
  );
}

function InvitePanel({ marketId, inviteToken }: { marketId: string; inviteToken?: string }) {
  const [copied, setCopied] = useState(false);
  if (!inviteToken) return null;
  const link = `${location.origin}/m/${marketId}?invite=${encodeURIComponent(inviteToken)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; the field is selectable */
    }
  };
  return (
    <section className="card p-4">
      <h2 className="mb-1 font-medium">Invite link</h2>
      <p className="mb-3 text-sm text-white/50">
        Share this with friends. Anyone who opens it must be approved by you before they can join.
      </p>
      <div className="flex gap-2">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="input flex-1 text-white/70"
        />
        <button onClick={copy} className="btn-primary whitespace-nowrap">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </section>
  );
}

function MemberList({ members, myUserId }: { members: Member[]; myUserId: string | null }) {
  return (
    <section>
      <h2 className="font-medium mb-2">Members ({members.filter((m) => m.status === 'active').length})</h2>
      <div className="flex flex-wrap gap-2">
        {members
          .filter((m) => m.status === 'active')
          .map((m) => (
            <span
              key={m.userId}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm"
            >
              {m.role === 'creator' ? '👑 ' : ''}@{m.username}
              {m.userId === myUserId && <span className="text-emerald-400"> (you)</span>}
            </span>
          ))}
      </div>
    </section>
  );
}

function JoinForm({
  marketId,
  invite,
  onJoined,
}: {
  marketId: string;
  invite: string;
  onJoined: () => void;
}) {
  const sessionUsername = useApp((s) => s.username);
  const setSession = useApp((s) => s.setSession);
  const [username, setUsername] = useState(sessionUsername ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      await api.join(marketId, username, invite);
      // Reflect the (possibly newly set) username locally.
      const me = await api.me();
      setSession(me.userId, me.username);
      onJoined();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-4">
      <h2 className="mb-1 font-medium">Request to join</h2>
      <p className="mb-3 text-sm text-white/50">
        Pick a username and send a request. The creator gets pinged to approve you.
      </p>
      <div className="flex gap-2">
        <input
          className="input flex-1"
          placeholder="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={!!sessionUsername}
        />
        <button
          onClick={join}
          disabled={busy || username.trim().length < 3}
          className="btn-primary whitespace-nowrap"
        >
          {busy ? 'Sending…' : 'Request to join'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
