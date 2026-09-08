import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';

const el = document.getElementById('root');
if (el === null) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/x" element={<div id="ok">works</div>} />
        <Route path="*" element={<div id="ok2">works too</div>} />
      </Routes>
    </HashRouter>
  </StrictMode>,
);
