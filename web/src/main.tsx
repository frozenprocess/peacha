import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import peacha from './assets/peacha.png';
// Side-effect import: configures Monaco workers + monaco-yaml schema before the
// editor mounts. Must come before any component that renders <PolicyEditor>.
import './monacoSetup';
import './styles.css';
import { installActionColorVars } from './actionColors';

// Publish the action palette (--act-deny/allow/pass/log) so CSS matches the
// values TS uses for graph edges + policy-card borders.
installActionColorVars();

// Catch any uncaught render error so a crash shows a message + reload button
// instead of a blank white page. React's only supported mechanism for this is a
// class component with getDerivedStateFromError.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ display: 'flex', alignItems: 'stretch', gap: '1.5rem', maxWidth: 720, margin: '10vh auto', padding: '0 1.5rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}>
        <img src={peacha} alt="" style={{ alignSelf: 'stretch', width: 'auto', objectFit: 'contain' }} />
        <div>
          <h1 style={{ fontSize: '1.4rem' }}>Peacha went purr purr purr!</h1>
          <p>Peacha the editor hit an unexpected error.</p>
          <p> The issue is me not you, so hopefully reloading fixes it.</p>
          <button onClick={() => location.reload()} style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}>
            Reload
          </button>
          <pre style={{ marginTop: '1.5rem', padding: '0.75rem', background: 'rgba(127,127,127,0.15)', borderRadius: 6, overflow: 'auto', fontSize: '0.8rem' }}>
            {this.state.error.message}
          </pre>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
