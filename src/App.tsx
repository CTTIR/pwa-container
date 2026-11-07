import { useEffect, useState } from 'react';
import { SurveyApp } from './SurveyApp.tsx';
import { Shell } from './components/Shell.tsx';
import { browserStrings } from './i18n.ts';

const CONTEXT_KEY = 'pwa-container:context';

/** Survey id from a /s/<id> link, or from the host name when the survey has its own subdomain. */
function useSurveyId(): string | null | undefined {
  const match = window.location.pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{2,63})\/?$/);
  const [id, setId] = useState<string | null | undefined>(match ? match[1] : undefined);
  useEffect(() => {
    if (match) return;
    let cancelled = false;
    fetch('/api/context', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { app: { id: string; type: string } | null }) => {
        const next = body.app?.type === 'survey' ? body.app.id : null;
        try {
          if (next) window.localStorage.setItem(CONTEXT_KEY, next);
        } catch {
          /* ignore */
        }
        if (!cancelled) setId(next);
      })
      .catch(() => {
        // Offline: fall back to the survey this host served last time.
        let cached: string | null = null;
        try {
          cached = window.localStorage.getItem(CONTEXT_KEY);
        } catch {
          /* ignore */
        }
        if (!cancelled) setId(cached);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}

export default function App() {
  const id = useSurveyId();
  if (id === undefined) return <Shell><p className="status-text">{browserStrings().loading}</p></Shell>;
  if (id) return <SurveyApp surveyId={id} />;
  return (
    <Shell>
      <div className="panel"><p>{browserStrings().home}</p></div>
    </Shell>
  );
}
