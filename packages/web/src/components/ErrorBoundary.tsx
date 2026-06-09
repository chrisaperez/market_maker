import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Stops a single component error from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[ui]', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-md rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-center">
          <p className="text-red-300 font-medium">Something went wrong rendering this view.</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-lg bg-white/10 hover:bg-white/15 px-4 py-2 text-sm"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
