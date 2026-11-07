import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Dashboard } from './Dashboard.tsx';
import { Records } from './Records.tsx';
import { Results } from './Results.tsx';
import '../styles.css';
import './admin.css';

/**
 * /admin                    dashboard (administration host) or, on a survey's own host, its results
 * /admin/results/<id>       results, courses and codes of one survey
 * /admin/records/<id>       data records of one app
 */
function AdminRoot() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const [hostSurvey, setHostSurvey] = useState<string | null | undefined>(parts.length > 1 ? null : undefined);
  useEffect(() => {
    if (parts.length > 1) return;
    fetch('/api/context', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { app: null }))
      .then((body: { app: { id: string; type: string } | null }) => setHostSurvey(body.app?.type === 'survey' ? body.app.id : null))
      .catch(() => setHostSurvey(null));
  }, []);
  if (parts[1] === 'results' && parts[2]) return <Results surveyId={parts[2]} />;
  if (parts[1] === 'records' && parts[2]) return <Records appId={parts[2]} />;
  if (hostSurvey === undefined) return null;
  if (hostSurvey) return <Results surveyId={hostSurvey} />;
  return <Dashboard />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminRoot />
  </React.StrictMode>,
);
