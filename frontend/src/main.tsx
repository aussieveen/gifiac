import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ProfilePage } from './ProfilePage.tsx'

// SPEC-CLOUD.md §5: the first real route this app has (`/u/:handle`) —
// everything else still lives inside App's own view-switching, which is
// unchanged here; the full nav redesign is a later milestone (§9).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/u/:handle" element={<ProfilePage />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
