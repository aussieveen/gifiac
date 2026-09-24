import type { ReactNode } from 'react'

/** Shared centred, wordmark-only layout for every screen that renders
 * before the authenticated app shell exists — the initial session check,
 * sign-in, and the one-time handle picker (design brief §3) — so none of
 * them read as a different app from the rest of Gifiac. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <span className="auth-brand">Gifiac</span>
      <div className="auth-center">{children}</div>
    </div>
  )
}
