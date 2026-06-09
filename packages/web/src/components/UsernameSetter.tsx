import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';

/** Inline gate: forces a username before the user can create or join markets. */
export function UsernameSetter({ title = 'Pick a username' }: { title?: string }) {
  const { username, setSession } = useApp();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (username) return null;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await api.setUsername(value);
      setSession(s.userId, s.username);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4">
      <h2 className="mb-1 font-medium">{title}</h2>
      <p className="mb-3 text-sm text-white/55">
        Your unique handle. Everyone in a market sees this next to your trades.
      </p>
      <div className="flex gap-2">
        <input
          className="input flex-1"
          placeholder="e.g. chris"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button onClick={submit} disabled={busy || value.trim().length < 3} className="btn-primary">
          Save
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
