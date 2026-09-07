import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { AppRouter } from './router';

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('#root missing');

createRoot(rootEl).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
