import { useEffect, useMemo, useRef } from 'react';
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Trade } from '@mm/shared';

/** Buckets sparse trades into OHLC candles (dollars) for a clean candlestick view. */
function toCandles(trades: Trade[]): CandlestickData[] {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort((a, b) => a.timestampMs - b.timestampMs);
  const first = sorted[0]!.timestampMs;
  const last = sorted[sorted.length - 1]!.timestampMs;
  const span = Math.max(1, last - first);
  // ~40 candles across the data, never finer than 1s (keeps candle times unique).
  const bucketMs = Math.max(1000, Math.ceil(span / 40 / 1000) * 1000);

  const buckets = new Map<number, { o: number; h: number; l: number; c: number }>();
  for (const t of sorted) {
    const key = Math.floor(t.timestampMs / bucketMs) * bucketMs;
    const price = t.priceCents / 100;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { o: price, h: price, l: price, c: price });
    else {
      b.h = Math.max(b.h, price);
      b.l = Math.min(b.l, price);
      b.c = price;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, b]) => ({
      time: Math.floor(ms / 1000) as UTCTimestamp,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    }));
}

export function PriceChart({ trades, height = 260 }: { trades: Trade[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const candles = useMemo(() => toCandles(trades), [trades]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.45)',
        fontSize: 11,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: 'rgba(249,115,22,0.5)', labelBackgroundColor: '#f97316' },
        horzLine: { color: 'rgba(249,115,22,0.5)', labelBackgroundColor: '#f97316' },
      },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(candles);
    if (candles.length > 0) chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/30">
          No trades yet — place the first order to start the chart.
        </div>
      )}
    </div>
  );
}
