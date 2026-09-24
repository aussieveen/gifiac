import { Link } from 'react-router-dom'
import lockup from './assets/brand/strewthgif-lockup-on-dark.svg'
import { ArrowLeftIcon } from './icons'

/** Shared header for pages that live outside App's auth-gated shell
 * (profile, about, privacy — see main.tsx) — no persistent nav of their
 * own, but still carry the wordmark and a real button-styled back link
 * so they don't look like a different, unbranded app to someone arriving
 * from a shared link. "Back" always goes to "/" (App's default landing),
 * matching what these pages replace rather than nest inside. */
export function PublicTopBar() {
  return (
    <div className="profile-topbar">
      <Link to="/" className="app-header-brand" aria-label="StrewthGif">
        <img src={lockup} alt="StrewthGif" />
      </Link>
      <Link className="btn btn-secondary" to="/">
        <ArrowLeftIcon size={16} />
        Back
      </Link>
    </div>
  )
}
