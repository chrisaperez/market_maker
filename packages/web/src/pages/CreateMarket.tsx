import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type CreateMarketBody } from '../lib/api';
import { useApp } from '../lib/store';
import { MarketForm } from '../components/MarketForm';
import { UsernameSetter } from '../components/UsernameSetter';

export default function CreateMarket() {
  const username = useApp((s) => s.username);
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!username) {
    return (
      <div className="mx-auto max-w-md">
        <UsernameSetter title="Pick a username to create a market" />
      </div>
    );
  }

  const submit = async (body: CreateMarketBody) => {
    setBusy(true);
    setError('');
    try {
      const { market } = await api.createMarket(body);
      navigate(`/m/${market.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create a market</h1>
      <p className="-mt-3 text-sm text-white/50">
        This starts as a private draft — you can tweak everything, then publish to share.
      </p>
      <MarketForm submitLabel="Create draft" busy={busy} error={error} onSubmit={submit} />
    </div>
  );
}
