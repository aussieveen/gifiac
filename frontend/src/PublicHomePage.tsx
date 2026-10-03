import { Link } from 'react-router-dom'
import { LOGIN_URL } from './api'
import { Library } from './Library'
import { LogInIcon, MailIcon } from './icons'

interface Props {
  /** Switches the pre-auth area over to the email sign-in screen (shared
   * with the rest of App's own logged-out flow) — this page's "Continue
   * with email" button feeds the same flow the full-screen sign-in
   * prompt's button does. */
  onShowEmailSignIn: () => void
}

/** The logged-out landing at `/` (design brief, wayfinder gifiac#41):
 * the hero from the old full-screen sign-in prompt, with the real
 * Global Library (same `Library` component `/` shows to a logged-in
 * visitor) browsable underneath instead of gated behind sign-in —
 * `list_library` is already auth-optional server-side. `hideHeader`
 * drops the "Global Library" title + count row, which would be
 * redundant with this page's own hero framing. */
export function PublicHomePage({ onShowEmailSignIn }: Props) {
  return (
    <div className="public-home">
      <div className="public-home-hero">
        <h1 className="public-home-hero-headline">
          <span className="caption-text public-home-hero-line1">STREWTH!</span>
          <span className="caption-text public-home-hero-line2">THERE'S A GIF FOR THAT.</span>
        </h1>
        <p className="public-home-hero-subline">Clip it, caption it, send it. Browse what people are making below.</p>
        <div className="public-home-hero-ctas">
          <a className="btn btn-primary" href={LOGIN_URL}>
            <LogInIcon size={16} />
            Continue with Google
          </a>
          <button type="button" className="btn btn-secondary" onClick={onShowEmailSignIn}>
            <MailIcon size={16} />
            Continue with email
          </button>
        </div>
      </div>
      <Library hideHeader />
      <div className="auth-footer">
        <Link to="/about">About</Link>
        <Link to="/privacy">Privacy policy</Link>
      </div>
    </div>
  )
}
