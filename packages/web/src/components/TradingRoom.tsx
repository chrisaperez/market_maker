import { useEffect, useMemo, useRef, useState } from 'react';
import {
  dollars,
  maxDebtCents,
  type Holding,
  type Market,
  type Member,
  type OptionBook,
  type Order,
  type SettlementInfo,
  type Trade,
} from '@mm/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { wsClient } from '../lib/ws';
import { PriceChart } from './PriceChart';
import { Sparkline } from './Sparkline';

function booksFromArray(arr: OptionBook[]): Record<string, OptionBook> {
  return Object.fromEntries(arr.map((b) => [b.optionId, b]));
}
function posFromArray(arr: { optionId: string; shares: number }[]): Record<string, number> {
  return Object.fromEntries(arr.map((p) => [p.optionId, p.shares]));
}
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });

export function TradingRoom({
  market: initialMarket,
  members: initialMembers,
  isCreator,
}: {
  market: Market;
  members: Member[];
  isCreator: boolean;
}) {
  const myUserId = useApp((s) => s.userId);
  const [market, setMarket] = useState(initialMarket);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [books, setBooks] = useState<Record<string, OptionBook>>({});
  const [trades, setTrades] = useState<Trade[]>([]);
  const [myCash, setMyCash] = useState(0);
  const [myPos, setMyPos] = useState<Record<string, number>>({});
  const [openOrders, setOpenOrders] = useState<Order[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [bottomTab, setBottomTab] = useState<'trades' | 'orders' | 'holdings'>('trades');
  const [settlement, setSettlement] = useState<SettlementInfo | null>(null);
  const [flash, setFlash] = useState('');
  const flashTimer = useRef<number | null>(null);
  const mountedAt = useRef(Date.now()); // only flash trades that arrive after we load

  const marketId = market.id;
  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(''), 3500);
  };

  useEffect(() => {
    const off = wsClient.on((msg) => {
      if ('marketId' in msg && msg.marketId !== marketId) return;
      switch (msg.type) {
        case 'subscribed': {
          const s = msg.snapshot;
          setMarket(s.market);
          setMembers(s.members);
          setBooks(booksFromArray(s.books));
          setTrades(s.recentTrades);
          setMyCash(s.myCashCents);
          setMyPos(posFromArray(s.myPositions));
          setOpenOrders(s.openOrders);
          setHoldings(s.holdings);
          setSettlement(s.settlement);
          break;
        }
        case 'settlement_update':
          setMarket(msg.market);
          setSettlement(msg.settlement);
          break;
        case 'trade':
          setBooks((b) => ({ ...b, [msg.book.optionId]: msg.book }));
          setTrades((t) => [...t, msg.trade].slice(-300));
          break;
        case 'book':
          setBooks((b) => ({ ...b, [msg.book.optionId]: msg.book }));
          break;
        case 'balance':
          setMyCash(msg.cashCents);
          setMyPos(posFromArray(msg.positions));
          break;
        case 'holding_update':
          setHoldings((hs) => {
            const rest = hs.filter((h) => h.userId !== msg.holding.userId);
            return [...rest, msg.holding];
          });
          break;
        case 'order_update': {
          const o = msg.order;
          setOpenOrders((all) => {
            const rest = all.filter((x) => x.id !== o.id);
            return o.status === 'open' ? [...rest, o] : rest;
          });
          break;
        }
        case 'market_update':
          setMarket(msg.market);
          if (msg.market.status !== 'open') setOpenOrders([]); // book cleared on freeze
          break;
        case 'error':
          showFlash(msg.message);
          break;
      }
    });
    // Force a fresh snapshot now that we're rendering the trading room.
    wsClient.subscribeMarket(marketId);
    return off;
  }, [marketId, myUserId]);

  const nameOf = useMemo(() => {
    const map = new Map(members.map((m) => [m.userId, m.username ?? m.userId.slice(0, 6)]));
    return (id: string) => map.get(id) ?? id.slice(0, 6);
  }, [members]);
  const labelOf = useMemo(() => {
    const map = new Map(market.options.map((o) => [o.id, o.label]));
    return (id: string) => map.get(id) ?? id.slice(0, 6);
  }, [market.options]);

  // Per-option price series (oldest → newest) for the charts.
  const seriesByOption = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const t of trades) (m[t.optionId] ??= []).push(t.priceCents);
    return m;
  }, [trades]);
  const [selected, setSelected] = useState(market.options[0]?.id ?? '');
  const selectedTrades = useMemo(() => trades.filter((t) => t.optionId === selected), [trades, selected]);

  const place = (
    optionId: string,
    side: 'buy' | 'sell',
    priceCents: number,
    quantity: number,
    orderType: 'limit' | 'market' = 'limit',
  ) => {
    wsClient.send({
      type: 'place_order',
      marketId,
      optionId,
      side,
      priceCents,
      quantity,
      orderType,
      clientRef: Math.random().toString(36).slice(2),
    });
  };
  const cancel = (orderId: string) => wsClient.send({ type: 'cancel_order', marketId, orderId });
  // One-click "take": fill a resting order by crossing it with the opposite side.
  const take = (o: Order) =>
    place(o.optionId, o.side === 'sell' ? 'buy' : 'sell', o.priceCents, o.remaining, 'limit');

  const openMarket = async () => {
    try {
      await api.openMarket(marketId);
    } catch (e) {
      showFlash((e as Error).message);
    }
  };
  const declare = async (optionId: string) => {
    try {
      await api.declareWinner(marketId, optionId);
    } catch (e) {
      showFlash((e as Error).message);
    }
  };
  const vote = async (agree: boolean) => {
    try {
      await api.voteSettlement(marketId, agree);
    } catch (e) {
      showFlash((e as Error).message);
    }
  };

  // --- Pre-trading (lobby) ---
  if (market.status === 'lobby') {
    return (
      <section className="card p-5">
        {isCreator ? (
          <div className="flex flex-col gap-3">
            <div>
              <h2 className="font-medium">Ready to trade?</h2>
              <p className="text-sm text-white/60">
                Opening funds every member with {market.sharesPerOption} shares of each outcome and
                starts a {Math.round(market.windowSeconds / 60)}-minute trading window.
              </p>
            </div>
            <button onClick={openMarket} className="btn-primary self-start px-5 py-2.5 text-base">
              Open market for trading
            </button>
            {flash && <p className="text-sm text-amber-300">{flash}</p>}
          </div>
        ) : (
          <p className="text-white/60">Waiting for the creator to open trading…</p>
        )}
      </section>
    );
  }

  // Render only the most recent trades (newest first) to keep scrolling smooth.
  const sortedTrades = trades.slice(-60).reverse();

  return (
    <div className="flex flex-col gap-5">
      {flash && (
        <div className="rounded-lg bg-amber-500/15 border border-amber-500/30 px-4 py-2 text-sm text-amber-200">
          {flash}
        </div>
      )}

      {market.status === 'open' && market.closesAt != null && <Countdown closesAt={market.closesAt} />}

      {settlement && market.status !== 'open' && (
        <SettlementPanel
          market={market}
          settlement={settlement}
          isCreator={isCreator}
          myUserId={myUserId}
          nameOf={nameOf}
          labelOf={labelOf}
          onDeclare={declare}
          onVote={vote}
        />
      )}

      {/* Positions / cash */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs text-white/50 uppercase tracking-wide">Your cash</div>
            <div className={`text-xl font-semibold ${myCash < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {dollars(myCash)}
            </div>
            <div className="text-xs text-white/40">
              {myCash < 0 ? 'you owe the ledger' : 'available'} · can owe up to{' '}
              {dollars(maxDebtCents(market.buyInCents, market.maxOwePct))}
            </div>
          </div>
          <div className="flex gap-4 flex-wrap">
            {market.options.map((o) => (
              <div key={o.id} className="text-right">
                <div className="text-xs text-white/50">{o.label}</div>
                <div className="font-medium">{myPos[o.id] ?? 0} sh</div>
              </div>
            ))}
          </div>
        </div>
        {market.status !== 'open' && (
          <div className="mt-3 text-sm text-amber-300">
            Trading is {market.status}. {market.status === 'frozen' && 'Settlement comes in M4.'}
          </div>
        )}
      </section>

      {/* Price history chart */}
      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Price history</h2>
          <div className="flex flex-wrap gap-1">
            {market.options.map((o) => (
              <button
                key={o.id}
                onClick={() => setSelected(o.id)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                  selected === o.id
                    ? 'border-orange-500/50 bg-orange-500/15 text-orange-300'
                    : 'border-transparent bg-white/5 text-white/55 hover:text-white'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {(() => {
          const series = seriesByOption[selected] ?? [];
          const last = series[series.length - 1];
          const first = series[0];
          const up = last != null && first != null && last >= first;
          return (
            <>
              <div className="mb-2 flex items-baseline gap-2">
                <span className={`text-2xl font-semibold tabular-nums ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                  {last != null ? dollars(last) : '—'}
                </span>
                {last != null && first != null && (
                  <span className={`text-sm ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                    {up ? '▲' : '▼'} {dollars(Math.abs(last - first))} since open
                  </span>
                )}
              </div>
              <PriceChart trades={selectedTrades} height={260} />
            </>
          );
        })()}
      </section>

      {/* Per-option books + order entry */}
      <div className="grid gap-4 md:grid-cols-2">
        {market.options.map((o) => (
          <OptionCard
            key={o.id}
            label={o.label}
            book={books[o.id]}
            series={seriesByOption[o.id] ?? []}
            parCents={market.parValueCents}
            canTrade={market.status === 'open'}
            onPlace={(side, price, qty, orderType) => place(o.id, side, price, qty, orderType)}
          />
        ))}
      </div>

      {/* Tabbed panel: trade log / everyone's open orders / everyone's holdings */}
      <section className="card p-4">
        <div className="mb-3 flex gap-1 border-b border-white/10">
          {(
            [
              ['trades', 'Trade log'],
              ['orders', 'Open orders'],
              ['holdings', 'Holdings'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setBottomTab(key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                bottomTab === key
                  ? 'border-orange-500 text-white'
                  : 'border-transparent text-white/50 hover:text-white'
              }`}
            >
              {label}
              {key === 'orders' && openOrders.length > 0 ? ` (${openOrders.length})` : ''}
            </button>
          ))}
        </div>

        {bottomTab === 'trades' &&
          (sortedTrades.length === 0 ? (
            <p className="text-sm text-white/40">No trades yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-white/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-normal">Time</th>
                    <th className="px-3 py-2 text-left font-normal">Outcome</th>
                    <th className="px-3 py-2 text-left font-normal">Buyer ← Seller</th>
                    <th className="px-3 py-2 text-right font-normal">Shares</th>
                    <th className="px-3 py-2 text-right font-normal">Price</th>
                    <th className="px-3 py-2 text-right font-normal">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.map((t) => (
                    <tr
                      key={t.id}
                      className={`border-t border-white/5 ${t.timestampMs >= mountedAt.current ? 'row-flash' : ''}`}
                    >
                      <td className="px-3 py-1.5 tabular-nums text-white/50">{fmtTime(t.timestampMs)}</td>
                      <td className="px-3 py-1.5">{labelOf(t.optionId)}</td>
                      <td className="px-3 py-1.5">
                        <span className="text-emerald-300">@{nameOf(t.buyerId)}</span>
                        <span className="text-white/30"> ← </span>
                        <span className="text-red-300">@{nameOf(t.sellerId)}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{t.shares}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{dollars(t.priceCents)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{dollars(t.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {bottomTab === 'orders' && (
          <OpenOrdersTab
            orders={openOrders}
            tradingOpen={market.status === 'open'}
            myUserId={myUserId}
            nameOf={nameOf}
            labelOf={labelOf}
            onCancel={cancel}
            onTake={take}
          />
        )}

        {bottomTab === 'holdings' && (
          <HoldingsTab holdings={holdings} options={market.options} myUserId={myUserId} nameOf={nameOf} />
        )}
      </section>
    </div>
  );
}

function OpenOrdersTab({
  orders,
  tradingOpen,
  myUserId,
  nameOf,
  labelOf,
  onCancel,
  onTake,
}: {
  orders: Order[];
  tradingOpen: boolean;
  myUserId: string | null;
  nameOf: (id: string) => string;
  labelOf: (id: string) => string;
  onCancel: (orderId: string) => void;
  onTake: (order: Order) => void;
}) {
  if (!tradingOpen) return <p className="text-sm text-white/40">Trading is closed — no resting orders.</p>;
  if (orders.length === 0) return <p className="text-sm text-white/40">No resting orders right now.</p>;
  const sorted = [...orders].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="flex flex-col gap-1.5">
      {sorted.map((o) => (
        <div
          key={o.id}
          className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm"
        >
          <span>
            <span className={o.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}>
              {o.side.toUpperCase()}
            </span>{' '}
            <span className="text-white/80">{o.remaining}</span> {labelOf(o.optionId)} @{' '}
            {dollars(o.priceCents)}
            <span className="ml-2 text-white/40">
              @{nameOf(o.userId)}
              {o.userId === myUserId && <span className="text-orange-400"> (you)</span>}
            </span>
          </span>
          {o.userId === myUserId ? (
            <button onClick={() => onCancel(o.id)} className="text-white/50 transition hover:text-white">
              Cancel
            </button>
          ) : (
            <button
              onClick={() => onTake(o)}
              className="rounded-md bg-orange-500 px-3 py-1 text-xs font-medium text-black transition hover:bg-orange-400"
            >
              {o.side === 'sell' ? 'Buy' : 'Sell'} {o.remaining} @ {dollars(o.priceCents)}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function HoldingsTab({
  holdings,
  options,
  myUserId,
  nameOf,
}: {
  holdings: Holding[];
  options: { id: string; label: string }[];
  myUserId: string | null;
  nameOf: (id: string) => string;
}) {
  if (holdings.length === 0) return <p className="text-sm text-white/40">No holdings yet.</p>;
  const sorted = [...holdings].sort((a, b) => (a.username ?? '').localeCompare(b.username ?? ''));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-white/50">
          <tr>
            <th className="px-3 py-2 text-left font-normal">Member</th>
            {options.map((o) => (
              <th key={o.id} className="px-3 py-2 text-right font-normal">
                {o.label}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-normal">Cash</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((h) => {
            const byOption = Object.fromEntries(h.positions.map((p) => [p.optionId, p.shares]));
            return (
              <tr
                key={h.userId}
                className={`border-t border-white/5 ${h.userId === myUserId ? 'bg-white/5' : ''}`}
              >
                <td className="px-3 py-1.5">
                  @{h.username ?? nameOf(h.userId)}
                  {h.userId === myUserId && <span className="text-orange-400"> (you)</span>}
                </td>
                {options.map((o) => (
                  <td key={o.id} className="px-3 py-1.5 text-right tabular-nums">
                    {byOption[o.id] ?? 0}
                  </td>
                ))}
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${h.cashCents < 0 ? 'text-red-400' : 'text-emerald-400'}`}
                >
                  {dollars(h.cashCents)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Countdown({ closesAt }: { closesAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, closesAt - now);
  const totalSec = Math.floor(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const urgent = remaining < 30_000;
  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-4 py-2 text-sm ${
        urgent ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-orange-500/30 bg-orange-500/[0.07] text-orange-200'
      }`}
    >
      <span>⏱ Trading window</span>
      <span className="font-semibold tabular-nums">
        {remaining === 0 ? 'closing…' : `${mm}:${String(ss).padStart(2, '0')} left`}
      </span>
    </div>
  );
}

function SettlementPanel({
  market,
  settlement,
  isCreator,
  myUserId,
  nameOf,
  labelOf,
  onDeclare,
  onVote,
}: {
  market: Market;
  settlement: SettlementInfo;
  isCreator: boolean;
  myUserId: string | null;
  nameOf: (id: string) => string;
  labelOf: (id: string) => string;
  onDeclare: (optionId: string) => void;
  onVote: (agree: boolean) => void;
}) {
  const winnerLabel = settlement.winningOptionId ? labelOf(settlement.winningOptionId) : null;
  const myVote = settlement.votes.find((v) => v.userId === myUserId);

  if (market.status === 'frozen') {
    return (
      <section className="card border-orange-500/25 bg-orange-500/[0.05] p-5">
        <h2 className="mb-1 font-medium text-orange-300">Trading closed — time to settle</h2>
        {isCreator ? (
          <>
            <p className="mb-3 text-sm text-white/60">Declare the winning outcome. Members then verify it.</p>
            <div className="flex flex-wrap gap-2">
              {market.options.map((o) => (
                <button key={o.id} onClick={() => onDeclare(o.id)} className="btn-primary">
                  {o.label} won
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-white/60">Waiting for the creator to declare the winning outcome…</p>
        )}
      </section>
    );
  }

  if (market.status === 'settling') {
    return (
      <section className="card border-orange-500/25 bg-orange-500/[0.05] p-5">
        <h2 className="mb-1 font-medium text-orange-300">
          Verify the result: <span className="text-white">{winnerLabel}</span> won
        </h2>
        <p className="mb-3 text-sm text-white/60">
          {settlement.agreeCount} of {settlement.required} required verifications. Everyone settles once
          at least half agree.
        </p>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-orange-500 transition-all"
            style={{ width: `${Math.min(100, (settlement.agreeCount / settlement.required) * 100)}%` }}
          />
        </div>
        {!myVote || !myVote.agree ? (
          <div className="flex gap-2">
            <button onClick={() => onVote(true)} className="btn-primary">
              Verify “{winnerLabel}” won
            </button>
            <button onClick={() => onVote(false)} className="btn-ghost">
              Dispute
            </button>
          </div>
        ) : (
          <p className="text-sm text-emerald-300">You verified this result. Waiting on others…</p>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {settlement.votes.map((v) => (
            <span
              key={v.userId}
              className={`rounded-full px-2 py-0.5 ${v.agree ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}
            >
              {v.agree ? '✓' : '✕'} @{nameOf(v.userId)}
            </span>
          ))}
        </div>
        {isCreator && (
          <div className="mt-3 text-xs text-white/40">
            Wrong call?{' '}
            {market.options
              .filter((o) => o.id !== settlement.winningOptionId)
              .map((o) => (
                <button
                  key={o.id}
                  onClick={() => onDeclare(o.id)}
                  className="mr-2 text-orange-400/80 underline transition hover:text-orange-300"
                >
                  re-declare {o.label}
                </button>
              ))}
          </div>
        )}
      </section>
    );
  }

  // settled
  const results = settlement.results ?? [];
  const net = results.reduce((s, r) => s + r.finalBalanceCents, 0);
  return (
    <section className="card border-emerald-500/25 bg-emerald-500/[0.05] p-5">
      <h2 className="mb-1 font-medium text-emerald-300">
        Settled — <span className="text-white">{winnerLabel}</span> won
      </h2>
      <p className="mb-3 text-sm text-white/60">
        Winning shares redeemed at {dollars(market.parValueCents)} each. Final tally:
      </p>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-white/50">
            <tr>
              <th className="text-left font-normal px-3 py-2">Member</th>
              <th className="text-right font-normal px-3 py-2">{winnerLabel} shares</th>
              <th className="text-right font-normal px-3 py-2">Payout</th>
              <th className="text-right font-normal px-3 py-2">Trading cash</th>
              <th className="text-right font-normal px-3 py-2">Buy-in</th>
              <th className="text-right font-normal px-3 py-2">Net</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.userId} className={`border-t border-white/5 ${r.userId === myUserId ? 'bg-white/5' : ''}`}>
                <td className="px-3 py-1.5">
                  @{r.username ?? nameOf(r.userId)}
                  {r.userId === myUserId && <span className="text-emerald-400"> (you)</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.winningShares}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{dollars(r.payoutCents)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{dollars(r.tradingCashCents)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-white/50">−{dollars(r.buyInCents)}</td>
                <td
                  className={`px-3 py-1.5 text-right font-medium tabular-nums ${
                    r.finalBalanceCents > 0 ? 'text-emerald-400' : r.finalBalanceCents < 0 ? 'text-red-400' : 'text-white/60'
                  }`}
                >
                  {r.finalBalanceCents > 0 ? '+' : ''}
                  {dollars(r.finalBalanceCents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-white/10 text-white/50">
              <td className="px-3 py-1.5" colSpan={5}>
                Net across everyone (always balances to zero)
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{dollars(net)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function OptionCard({
  label,
  book,
  series,
  parCents,
  canTrade,
  onPlace,
}: {
  label: string;
  book: OptionBook | undefined;
  series: number[];
  parCents: number;
  canTrade: boolean;
  onPlace: (side: 'buy' | 'sell', priceCents: number, quantity: number, orderType: 'limit' | 'market') => void;
}) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [mode, setMode] = useState<'limit' | 'market'>('limit');
  const [priceStr, setPriceStr] = useState('');
  const [qtyStr, setQtyStr] = useState('');

  const last = book?.lastPriceCents ?? null;
  const prev = book?.prevPriceCents ?? null;
  const up = last != null && prev != null && last > prev;
  const down = last != null && prev != null && last < prev;
  const bestBid = book?.bids[0]?.priceCents ?? null;
  const bestAsk = book?.asks[0]?.priceCents ?? null;

  const submit = () => {
    const quantity = parseInt(qtyStr, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    if (mode === 'market') {
      onPlace(side, 0, quantity, 'market');
      setQtyStr('');
      return;
    }
    const priceCents = Math.round(parseFloat(priceStr) * 100);
    if (!Number.isFinite(priceCents) || priceCents <= 0) return;
    onPlace(side, priceCents, quantity, 'limit');
    setQtyStr('');
  };

  const priceColor = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-white/80';
  const arrow = up ? '▲' : down ? '▼' : '·';

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium">{label}</h3>
        <div className={`text-lg font-semibold tabular-nums ${priceColor}`}>
          {last != null ? dollars(last) : '—'} <span className="text-xs">{arrow}</span>
        </div>
      </div>

      <Sparkline points={series} width={300} height={44} className="w-full h-11" />

      {/* depth: asks (red) on top, bids (green) below */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-white/40 mb-1">Bids</div>
          {(book?.bids ?? []).slice(0, 4).map((l, i) => (
            <div key={i} className="flex justify-between text-emerald-300/90 tabular-nums">
              <span>{dollars(l.priceCents)}</span>
              <span className="text-white/40">{l.quantity}</span>
            </div>
          ))}
          {(book?.bids.length ?? 0) === 0 && <div className="text-white/25">—</div>}
        </div>
        <div>
          <div className="text-white/40 mb-1">Asks</div>
          {(book?.asks ?? []).slice(0, 4).map((l, i) => (
            <div key={i} className="flex justify-between text-red-300/90 tabular-nums">
              <span>{dollars(l.priceCents)}</span>
              <span className="text-white/40">{l.quantity}</span>
            </div>
          ))}
          {(book?.asks.length ?? 0) === 0 && <div className="text-white/25">—</div>}
        </div>
      </div>

      {canTrade && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
          <div className="flex gap-1">
            <button
              onClick={() => setSide('buy')}
              className={`flex-1 rounded-md py-1 text-sm ${side === 'buy' ? 'bg-emerald-600' : 'bg-white/5 text-white/60'}`}
            >
              Buy
            </button>
            <button
              onClick={() => setSide('sell')}
              className={`flex-1 rounded-md py-1 text-sm ${side === 'sell' ? 'bg-red-600' : 'bg-white/5 text-white/60'}`}
            >
              Sell
            </button>
          </div>
          <div className="flex items-center gap-1 text-xs">
            <button
              onClick={() => setMode('limit')}
              className={`rounded px-2 py-0.5 ${mode === 'limit' ? 'bg-orange-500/20 text-orange-300' : 'text-white/40 hover:text-white'}`}
            >
              Limit
            </button>
            <button
              onClick={() => setMode('market')}
              className={`rounded px-2 py-0.5 ${mode === 'market' ? 'bg-orange-500/20 text-orange-300' : 'text-white/40 hover:text-white'}`}
            >
              Market
            </button>
            <span className="ml-auto text-white/30">
              {mode === 'market' ? 'fills at best price' : 'set your price'}
            </span>
          </div>
          <div className="flex gap-2">
            {mode === 'limit' && (
              <input
                inputMode="decimal"
                placeholder={`$ (max ${dollars(parCents)})`}
                value={priceStr}
                onChange={(e) => setPriceStr(e.target.value)}
                className="w-1/2 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-sm outline-none transition focus:border-orange-500/70"
              />
            )}
            <input
              inputMode="numeric"
              placeholder="shares"
              value={qtyStr}
              onChange={(e) => setQtyStr(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              className={`${mode === 'limit' ? 'w-1/2' : 'w-full'} rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-sm outline-none transition focus:border-orange-500/70`}
            />
          </div>
          {mode === 'limit' && (
            <div className="flex items-center justify-between text-xs text-white/40">
              <button
                type="button"
                onClick={() => bestAsk != null && setPriceStr((bestAsk / 100).toFixed(2))}
                className="hover:text-white"
              >
                best ask {bestAsk != null ? dollars(bestAsk) : '—'}
              </button>
              <button
                type="button"
                onClick={() => bestBid != null && setPriceStr((bestBid / 100).toFixed(2))}
                className="hover:text-white"
              >
                best bid {bestBid != null ? dollars(bestBid) : '—'}
              </button>
            </div>
          )}
          <button
            onClick={submit}
            className={`rounded-md py-1.5 text-sm font-medium ${side === 'buy' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'}`}
          >
            {mode === 'market' ? `${side === 'buy' ? 'Buy' : 'Sell'} at best price` : `Place ${side} order`}
          </button>
        </div>
      )}
    </div>
  );
}
