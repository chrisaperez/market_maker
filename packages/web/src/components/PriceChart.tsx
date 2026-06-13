import { useEffect, useMemo, useRef } from 'react';
import type { Trade } from '@mm/shared';

interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Buckets sparse trades into OHLC candles (in dollars). */
function toCandles(trades: Trade[]): Candle[] {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort((a, b) => a.timestampMs - b.timestampMs);
  const first = sorted[0]!.timestampMs;
  const last = sorted[sorted.length - 1]!.timestampMs;
  const span = Math.max(1, last - first);
  const bucketMs = Math.max(1000, Math.ceil(span / 40 / 1000) * 1000);

  const buckets = new Map<number, Candle>();
  for (const t of sorted) {
    const key = Math.floor(t.timestampMs / bucketMs) * bucketMs;
    const price = t.priceCents / 100;
    const c = buckets.get(key);
    if (!c) buckets.set(key, { time: Math.floor(key / 1000), open: price, high: price, low: price, close: price });
    else {
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

const UP = '#22c55e';
const DOWN = '#ef4444';

/** Self-contained canvas candlestick chart — no third-party charting library. */
export function PriceChart({ trades, height = 260 }: { trades: Trade[]; height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const candles = useMemo(() => toCandles(trades), [trades]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = height;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (candles.length === 0) return;

      const padTop = 8;
      const padLeft = 8;
      const padRight = 54;
      const padBottom = 22;
      const plotW = w - padLeft - padRight;
      const plotH = h - padTop - padBottom;

      let lo = Infinity;
      let hi = -Infinity;
      for (const c of candles) {
        lo = Math.min(lo, c.low);
        hi = Math.max(hi, c.high);
      }
      if (lo === hi) {
        lo -= 0.05;
        hi += 0.05;
      }
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
      const span = hi - lo || 1;
      const yOf = (v: number) => padTop + (1 - (v - lo) / span) * plotH;

      const n = candles.length;
      const slot = plotW / n;
      const bodyW = Math.max(1, Math.min(slot * 0.7, 14));
      const xOf = (i: number) => padLeft + slot * (i + 0.5);

      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';

      // horizontal gridlines + price axis (right)
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const val = lo + span * (i / ticks);
        const y = yOf(val);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText(`$${val.toFixed(2)}`, padLeft + plotW + 6, y);
      }

      // time axis (bottom)
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      const fmt = (sec: number) =>
        new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      for (const idx of [0, Math.floor(n / 2), n - 1]) {
        if (idx < 0 || idx >= n) continue;
        ctx.textAlign = idx === 0 ? 'left' : idx === n - 1 ? 'right' : 'center';
        const x = Math.min(Math.max(xOf(idx), padLeft), padLeft + plotW);
        ctx.fillText(fmt(candles[idx]!.time), x, padTop + plotH + 6);
      }

      // candles
      for (let i = 0; i < n; i++) {
        const c = candles[i]!;
        const x = xOf(i);
        const color = c.close >= c.open ? UP : DOWN;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yOf(c.high));
        ctx.lineTo(x, yOf(c.low));
        ctx.stroke();
        const top = Math.min(yOf(c.open), yOf(c.close));
        ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, Math.abs(yOf(c.close) - yOf(c.open))));
      }

      // last price line + tag
      const lastC = candles[n - 1]!;
      const lastY = yOf(lastC.close);
      const color = lastC.close >= lastC.open ? UP : DOWN;
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padLeft, lastY);
      ctx.lineTo(padLeft + plotW, lastY);
      ctx.stroke();
      ctx.setLineDash([]);
      const tag = `$${lastC.close.toFixed(2)}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const tagW = ctx.measureText(tag).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(padLeft + plotW + 2, lastY - 9, tagW, 18);
      ctx.fillStyle = '#0a0a0b';
      ctx.fillText(tag, padLeft + plotW + 7, lastY);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [candles, height]);

  return (
    <div ref={wrapRef} className="relative" style={{ height }}>
      <canvas ref={canvasRef} />
      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/30">
          No trades yet — place the first order to start the chart.
        </div>
      )}
    </div>
  );
}
