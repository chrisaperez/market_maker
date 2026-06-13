import { useEffect, useRef, useState } from 'react';
import type { OptionBook, Trade } from '@mm/shared';
import { DEFAULT_SCRIPT, ScriptRunner, type ScriptState } from '../lib/scriptRunner';

export function ScriptsPanel({
  options,
  books,
  positions,
  cashCents,
  trades,
  canTrade,
  onOrder,
  onCancel,
}: {
  options: { id: string; label: string }[];
  books: Record<string, OptionBook>;
  positions: Record<string, number>;
  cashCents: number;
  trades: Trade[];
  canTrade: boolean;
  onOrder: (optionId: string, side: 'buy' | 'sell', shares: number, price: number | null) => void;
  onCancel: (orderId: string) => void;
}) {
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const onOrderRef = useRef(onOrder);
  onOrderRef.current = onOrder;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const lastTradeLen = useRef(trades.length);

  const runnerRef = useRef<ScriptRunner | null>(null);
  if (!runnerRef.current) {
    runnerRef.current = new ScriptRunner({
      onLog: (text) => setLog((l) => [...l.slice(-150), text]),
      onOrder: (id, side, shares, price) => onOrderRef.current(id, side, shares, price),
      onCancel: (id) => onCancelRef.current(id),
    });
  }

  const buildState = (): ScriptState => ({
    options: options.map((o) => ({ id: o.id, label: o.label })),
    books: Object.fromEntries(
      options.map((o) => {
        const b = books[o.id];
        return [
          o.id,
          {
            bids: (b?.bids ?? []).map((l) => ({ price: l.priceCents / 100, qty: l.quantity })),
            asks: (b?.asks ?? []).map((l) => ({ price: l.priceCents / 100, qty: l.quantity })),
            last: b?.lastPriceCents == null ? null : b.lastPriceCents / 100,
          },
        ];
      }),
    ),
    positions,
    cash: cashCents / 100,
  });

  // Keep the running script's view of the market fresh.
  useEffect(() => {
    if (running) runnerRef.current!.feedState(buildState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, books, positions, cashCents]);

  // Fire the script's trade handlers on new trades.
  useEffect(() => {
    if (!running) {
      lastTradeLen.current = trades.length;
      return;
    }
    if (trades.length > lastTradeLen.current) {
      const st = buildState();
      for (const t of trades.slice(lastTradeLen.current)) {
        runnerRef.current!.feedTrade({ optionId: t.optionId, price: t.priceCents / 100, shares: t.shares }, st);
      }
    }
    lastTradeLen.current = trades.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, running]);

  // ~2s tick handlers.
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => runnerRef.current!.tick(), 2000);
    return () => clearInterval(iv);
  }, [running]);

  useEffect(() => () => runnerRef.current?.stop(), []);

  const run = () => {
    setLog([]);
    lastTradeLen.current = trades.length;
    runnerRef.current!.start(code, buildState());
    setRunning(true);
  };
  const stop = () => {
    runnerRef.current!.stop();
    setRunning(false);
    setLog((l) => [...l, '■ stopped']);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-white/50">
        Write a strategy that trades for you. It runs sandboxed in your browser (no network access)
        and places orders through your own account.
      </p>
      <textarea
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="h-56 w-full rounded-lg border border-white/10 bg-black/50 p-3 font-mono text-xs leading-relaxed text-white/90 outline-none transition focus:border-orange-500/70"
      />
      <div className="flex items-center gap-2">
        {running ? (
          <button
            onClick={stop}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:text-white"
          >
            ■ Stop
          </button>
        ) : (
          <button onClick={run} disabled={!canTrade} className="btn-primary">
            ▶ Run script
          </button>
        )}
        <button onClick={() => setLog([])} className="text-xs text-white/40 hover:text-white">
          clear log
        </button>
        {!canTrade && <span className="text-xs text-amber-300">Trading isn't open.</span>}
        {running && <span className="text-xs text-emerald-400">running</span>}
      </div>
      <div className="h-40 overflow-auto rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-xs text-white/70">
        {log.length === 0 ? (
          <span className="text-white/30">log output…</span>
        ) : (
          log.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
