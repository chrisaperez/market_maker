import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { computeFairness, dollars } from '@mm/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { UsernameSetter } from '../components/UsernameSetter';

const WINDOW_PRESETS = [
  { label: '5m', seconds: 300 },
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
  { label: '4h', seconds: 14400 },
  { label: '1d', seconds: 86400 },
];

function humanWindow(seconds: number): string {
  if (seconds % 86400 === 0 && seconds >= 86400) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export default function CreateMarket() {
  const username = useApp((s) => s.username);
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [buyInDollars, setBuyInDollars] = useState(10);
  const [sharesPerOption, setSharesPerOption] = useState(10);
  const [windowSeconds, setWindowSeconds] = useState(3600);
  const [customWindow, setCustomWindow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const buyInCents = Math.round(buyInDollars * 100);
  const fairness = useMemo(
    () => computeFairness({ buyInCents, sharesPerOption: Math.max(1, sharesPerOption) }),
    [buyInCents, sharesPerOption],
  );

  const setOption = (i: number, value: string) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  const addOption = () => setOptions((prev) => [...prev, '']);
  const removeOption = (i: number) =>
    setOptions((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const { market } = await api.createMarket({
        title,
        description,
        buyInCents,
        sharesPerOption,
        windowSeconds,
        options: options.map((o) => o.trim()).filter(Boolean),
      });
      navigate(`/m/${market.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!username) {
    return (
      <div className="mx-auto max-w-md">
        <UsernameSetter title="Pick a username to create a market" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create a market</h1>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-white/70">What are we betting on?</label>
        <input
          className="input"
          placeholder="e.g. What flavor does Alex get tonight?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="input"
          placeholder="Optional details / rules"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-white/70">Outcomes</label>
        {options.map((o, i) => (
          <div key={i} className="flex gap-2">
            <input
              className="input"
              placeholder={`Outcome ${i + 1}`}
              value={o}
              onChange={(e) => setOption(i, e.target.value)}
            />
            <button
              onClick={() => removeOption(i)}
              disabled={options.length <= 2}
              className="rounded-lg border border-white/10 px-3 text-white/50 transition hover:text-white disabled:opacity-25"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={addOption}
          className="self-start text-sm font-medium text-orange-400 transition hover:text-orange-300"
        >
          + Add outcome
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-white/70">Buy-in ($)</label>
          <input
            type="number"
            min={1}
            step={1}
            className="input mt-1"
            value={buyInDollars}
            onChange={(e) => setBuyInDollars(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="text-sm text-white/70">Shares / outcome</label>
          <input
            type="number"
            min={1}
            step={1}
            className="input mt-1"
            value={sharesPerOption}
            onChange={(e) => setSharesPerOption(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Editable trading-window presets */}
      <div className="flex flex-col gap-2">
        <label className="text-sm text-white/70">Trading window</label>
        <div className="flex flex-wrap gap-2">
          {WINDOW_PRESETS.map((p) => {
            const active = !customWindow && windowSeconds === p.seconds;
            return (
              <button
                key={p.label}
                onClick={() => {
                  setCustomWindow(false);
                  setWindowSeconds(p.seconds);
                }}
                className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition ${
                  active
                    ? 'border-orange-500 bg-orange-500/15 text-orange-300'
                    : 'border-white/10 bg-white/5 text-white/60 hover:text-white'
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <button
            onClick={() => setCustomWindow(true)}
            className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition ${
              customWindow
                ? 'border-orange-500 bg-orange-500/15 text-orange-300'
                : 'border-white/10 bg-white/5 text-white/60 hover:text-white'
            }`}
          >
            Custom
          </button>
        </div>
        {customWindow && (
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={0.2}
              step={0.5}
              className="input w-32"
              value={+(windowSeconds / 60).toFixed(2)}
              onChange={(e) => setWindowSeconds(Math.max(10, Math.round(Number(e.target.value) * 60)))}
            />
            <span className="text-sm text-white/50">minutes</span>
          </div>
        )}
        <p className="text-xs text-white/40">
          Once you open the market it trades for {humanWindow(windowSeconds)}, then freezes for
          settlement.
        </p>
      </div>

      <div className="rounded-xl border border-orange-500/25 bg-orange-500/[0.06] p-4 text-sm">
        <div className="mb-1 font-medium text-orange-300">
          Fair by design · {dollars(Math.round(fairness.parValueCents))}/share par value
        </div>
        <p className="text-white/70">{fairness.explanation}</p>
        {!fairness.exact && (
          <p className="mt-2 text-amber-300">
            Tip: pick a buy-in that divides evenly by shares (e.g. ${sharesPerOption} or a multiple) so
            every payout is a whole number of cents.
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        onClick={submit}
        disabled={busy || !title.trim() || options.filter((o) => o.trim()).length < 2}
        className="btn-primary py-3 text-base"
      >
        {busy ? 'Creating…' : 'Create market'}
      </button>
    </div>
  );
}
