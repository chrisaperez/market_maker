import { useEffect } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { useApp } from './lib/store';
import { wsClient } from './lib/ws';
import { ErrorBoundary } from './components/ErrorBoundary';
import Home from './pages/Home';
import CreateMarket from './pages/CreateMarket';
import Market from './pages/Market';

function Header() {
  const username = useApp((s) => s.username);
  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0c0c0e]">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-orange-500 text-black">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M2 11.5l3.5-4 2.5 2.5L14 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Market Maker</span>
        </Link>
        <div className="text-sm">
          {username ? (
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/80">
              @{username}
            </span>
          ) : (
            <span className="text-white/40">setting up…</span>
          )}
        </div>
      </div>
    </header>
  );
}

function Toaster() {
  const { toasts, dismissToast } = useApp();
  useEffect(() => {
    const last = toasts[toasts.length - 1];
    if (!last) return;
    const t = setTimeout(() => dismissToast(last.id), 5000);
    return () => clearTimeout(t);
  }, [toasts, dismissToast]);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className="cursor-pointer rounded-lg border border-orange-500/30 bg-neutral-900/95 px-4 py-2 text-sm shadow-xl shadow-black/40 backdrop-blur"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const { setSession, pushToast } = useApp();

  useEffect(() => {
    api
      .init()
      .then((s) => setSession(s.userId, s.username))
      .catch(() => undefined);
  }, [setSession]);

  useEffect(() => {
    return wsClient.on((msg) => {
      if (msg.type === 'join_request') {
        pushToast(`🙋 @${msg.request.username} wants to join a market`);
      }
    });
  }, [pushToast]);

  return (
    <div className="min-h-full">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/create" element={<CreateMarket />} />
            <Route path="/m/:id" element={<Market />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <Toaster />
    </div>
  );
}
