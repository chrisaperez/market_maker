import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { dollars, type Market } from '@mm/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { UsernameSetter } from '../components/UsernameSetter';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  lobby: 'Lobby',
  open: 'Trading',
  frozen: 'Frozen',
  settling: 'Settling',
  settled: 'Settled',
  cancelled: 'Cancelled',
};

export default function Home() {
  const username = useApp((s) => s.username);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listMarkets()
      .then((d) => setMarkets(d.markets))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [username]);

  return (
    <div className="flex flex-col gap-6">
      <UsernameSetter />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Your markets</h1>
        {username && (
          <Link to="/create" className="btn-primary">
            + New market
          </Link>
        )}
      </div>

      {loading ? (
        <p className="text-white/50">Loading…</p>
      ) : markets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-10 text-center text-white/55">
          No markets yet. Create one and share the invite link with friends.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {markets.map((m) => (
            <Link
              key={m.id}
              to={`/m/${m.id}`}
              className="card p-4 transition hover:border-orange-500/40 hover:bg-white/[0.05]"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{m.title}</span>
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
                  {STATUS_LABEL[m.status] ?? m.status}
                </span>
              </div>
              <div className="mt-2 text-sm text-white/50">
                {m.options.length} options · {dollars(m.buyInCents)} buy-in · {m.sharesPerOption}{' '}
                shares each
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
