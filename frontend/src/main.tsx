import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import { AboutPage } from './About.tsx'
import App from './App.tsx'
import { PrivacyPage } from './Privacy.tsx'
import { ProfilePage } from './ProfilePage.tsx'

// `/u/:handle`, `/about`, and `/privacy` are the routes that render
// outside App's own auth-gated shell — public profiles, and the
// Google-OAuth-consent-screen homepage/privacy pages, all need no
// session. Every other path falls through to `*` and is matched by
// App's own nested `<Routes>` instead. Those nested routes use absolute
// (`/`-prefixed) paths, so they resolve the same regardless of being
// reached through this wildcard.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/u/:handle" element={<ProfilePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
