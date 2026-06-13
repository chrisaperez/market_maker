// Runs a user's trading script in a sandboxed Web Worker. The worker strips all
// network access, so a script can ONLY act through the `mm` API we provide
// (which routes orders through the user's own normal connection on the main
// thread). Scripts run off the main thread, so a bad loop can't freeze the UI.

export interface ScriptBook {
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
  last: number | null;
}
export interface ScriptState {
  options: { id: string; label: string }[];
  books: Record<string, ScriptBook>;
  positions: Record<string, number>;
  cash: number;
}
export interface ScriptTrade {
  optionId: string;
  price: number;
  shares: number;
}

interface Callbacks {
  onLog: (text: string) => void;
  onOrder: (optionId: string, side: 'buy' | 'sell', shares: number, price: number | null) => void;
  onCancel: (orderId: string) => void;
}

// The worker bootstrap. No ${} interpolation here — it's a literal program.
const WORKER_SRC = `
self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined;
self.importScripts = undefined; self.EventSource = undefined;
let state = { options: [], books: {}, positions: {}, cash: 0 };
const handlers = { trade: [], tick: [] };
const mm = {
  get options() { return state.options; },
  book: function(id) { return state.books[id] || { bids: [], asks: [], last: null }; },
  position: function(id) { return state.positions[id] || 0; },
  cash: function() { return state.cash; },
  buy: function(id, shares, price) { postMessage({ cmd: 'order', side: 'buy', optionId: id, shares: shares, price: (price == null ? null : price) }); },
  sell: function(id, shares, price) { postMessage({ cmd: 'order', side: 'sell', optionId: id, shares: shares, price: (price == null ? null : price) }); },
  cancel: function(orderId) { postMessage({ cmd: 'cancel', orderId: orderId }); },
  log: function() { postMessage({ cmd: 'log', text: Array.prototype.slice.call(arguments).map(String).join(' ') }); },
  on: function(ev, fn) { if (handlers[ev]) handlers[ev].push(fn); },
};
self.onmessage = function(e) {
  const m = e.data;
  if (m.type === 'state') { state = m.state; }
  else if (m.type === 'trade') {
    state = m.state;
    handlers.trade.forEach(function(fn){ try { fn(m.trade, mm); } catch(err){ mm.log('error:', err.message); } });
  }
  else if (m.type === 'tick') {
    handlers.tick.forEach(function(fn){ try { fn(mm); } catch(err){ mm.log('error:', err.message); } });
  }
  else if (m.type === 'run') {
    handlers.trade = []; handlers.tick = [];
    try { (new Function('mm', m.code))(mm); postMessage({ cmd: 'log', text: '▶ script running' }); }
    catch(err){ postMessage({ cmd: 'log', text: 'error: ' + err.message }); }
  }
};
`;

export class ScriptRunner {
  private worker: Worker | null = null;
  private url: string | null = null;

  constructor(private cb: Callbacks) {}

  get running(): boolean {
    return this.worker != null;
  }

  start(code: string, state: ScriptState): void {
    this.stop();
    this.url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    const w = new Worker(this.url);
    this.worker = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { cmd: string; [k: string]: unknown };
      if (m.cmd === 'log') this.cb.onLog(m.text as string);
      else if (m.cmd === 'order')
        this.cb.onOrder(
          m.optionId as string,
          m.side as 'buy' | 'sell',
          m.shares as number,
          (m.price as number | null) ?? null,
        );
      else if (m.cmd === 'cancel') this.cb.onCancel(m.orderId as string);
    };
    w.postMessage({ type: 'state', state });
    w.postMessage({ type: 'run', code });
  }

  feedState(state: ScriptState): void {
    this.worker?.postMessage({ type: 'state', state });
  }
  feedTrade(trade: ScriptTrade, state: ScriptState): void {
    this.worker?.postMessage({ type: 'trade', trade, state });
  }
  tick(): void {
    this.worker?.postMessage({ type: 'tick' });
  }

  stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}

export const DEFAULT_SCRIPT = `// Sandbox: you have a global \`mm\`. Network access is blocked; orders go
// through your own account. API:
//   mm.options            -> [{ id, label }]
//   mm.book(id)           -> { bids:[{price,qty}], asks:[...], last }
//   mm.position(id)       -> your shares      mm.cash() -> your cash ($)
//   mm.buy(id, shares, price?)   mm.sell(id, shares, price?)   // omit price = market order
//   mm.cancel(orderId)    mm.log(...)
//   mm.on('trade', (t, mm) => {...})   mm.on('tick', (mm) => {...})  // tick ~2s
const opt = mm.options[0];
mm.log('Watching', opt.label, '- last:', mm.book(opt.id).last);
mm.on('trade', (t) => mm.log('trade on', t.optionId, '@ $' + t.price, 'x' + t.shares));
`;
