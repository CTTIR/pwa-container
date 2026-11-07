import React from 'react';
import ReactDOM from 'react-dom/client';
import { Dashboard } from './Dashboard.tsx';
import { Results } from './Results.tsx';
import '../styles.css';
import './admin.css';

function AdminRoot() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[1] === 'results' && parts[2]) return <Results surveyId={parts[2]} />;
  return <Dashboard />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminRoot />
  </React.StrictMode>,
);
