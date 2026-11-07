import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './styles.css';

/** True when answers written to localStorage survive a reload. */
function storageWorks(): boolean {
  try {
    const key = 'pwa-container:probe';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// A new version activates at once (skipWaiting + clientsClaim). The page keeps running the
// version it was loaded with and switches over by reloading only while it is in the background,
// where the draft and outbox bring the participant back to the same place. Without working
// storage a reload would lose the answers, so the switch then waits for the next visit.
function reloadWhenHidden(): void {
  if (!storageWorks()) return;
  if (document.visibilityState === 'hidden') {
    window.location.reload();
    return;
  }
  const onChange = () => {
    if (document.visibilityState !== 'hidden') return;
    document.removeEventListener('visibilitychange', onChange);
    window.location.reload();
  };
  document.addEventListener('visibilitychange', onChange);
}

registerSW({ immediate: true, onNeedReload: reloadWhenHidden });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
