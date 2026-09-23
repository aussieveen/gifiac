import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ProfilePage } from './ProfilePage.tsx'

// `/u/:handle` (SPEC-CLOUD.md §5) is the one route that renders outside
// App's own auth-gated shell (public profiles need no session) — every
// other path falls through to `*` and is matched by App's own nested
// `<Routes>` instead. Those nested routes use absolute (`/`-prefixed)
// paths, so they resolve the same regardless of being reached through
// this wildcard.
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
