import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import lockup from './assets/brand/strewthgif-lockup-on-dark.svg'

/** Shared centred, wordmark-only layout for every screen that renders
 * before the authenticated app shell exists — the initial session check,
 * sign-in, and the one-time handle picker (design brief §3) — so none of
 * them read as a different app from the rest of StrewthGif.
 *
 * The About/Privacy footer links live here rather than just on the
 * sign-in screen so they're always reachable pre-auth, not only in the
 * one state a visitor happens to land in. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <img src={lockup} alt="StrewthGif" className="auth-brand" />
      <div className="auth-center">{children}</div>
      <div className="auth-footer">
        <Link to="/about">About</Link>
        <Link to="/privacy">Privacy policy</Link>
      </div>
    </div>
  )
}
