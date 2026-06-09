import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
}

interface AppState {
  userId: string | null;
  username: string | null;
  setSession: (userId: string, username: string | null) => void;
  toasts: Toast[];
  pushToast: (text: string) => void;
  dismissToast: (id: number) => void;
}

export const useApp = create<AppState>((set) => ({
  userId: null,
  username: null,
  setSession: (userId, username) => set({ userId, username }),
  toasts: [],
  pushToast: (text) =>
    set((s) => ({ toasts: [...s.toasts, { id: Date.now() + Math.random(), text }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
