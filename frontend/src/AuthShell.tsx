import type { ReactNode } from 'react'
import lockup from './assets/brand/strewthgif-lockup-on-dark.svg'

/** Shared centred, wordmark-only layout for every screen that renders
 * before the authenticated app shell exists — the initial session check,
 * sign-in, and the one-time handle picker (design brief §3) — so none of
 * them read as a different app from the rest of StrewthGif. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <img src={lockup} alt="StrewthGif" className="auth-brand" />
      <div className="auth-center">{children}</div>
    </div>
  )
}
