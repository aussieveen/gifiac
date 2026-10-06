import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LOGIN_URL } from './api'
import { EmailSignIn } from './EmailSignIn'
import { LogInIcon, MailIcon } from './icons'
import { PublicTopBar } from './PublicTopBar'
import { useCurrentUser } from './useCurrentUser'

/** The two sign-in CTAs, or a link back into the app for a visitor who
 * already has a session — shown in both the hero and the footer below.
 * Hidden entirely while `useCurrentUser` is still resolving, so a
 * logged-in visitor doesn't see a flash of sign-in buttons. */
function SignInCta({ loading, loggedIn, onShowEmailSignIn }: { loading: boolean; loggedIn: boolean; onShowEmailSignIn: () => void }) {
  if (loading) return null
  if (loggedIn) {
    return (
      <Link className="btn btn-primary btn-hero" to="/">
        Go to your library
      </Link>
    )
  }
  return (
    <div className="auth-buttons">
      <a className="btn btn-primary btn-hero" href={LOGIN_URL}>
        <LogInIcon />
        Continue with Google
      </a>
      <button type="button" className="btn btn-secondary btn-hero" onClick={onShowEmailSignIn}>
        <MailIcon />
        Continue with email
      </button>
    </div>
  )
}

// Public, unauthenticated marketing page (main.tsx routes it outside
// App's auth gate, same as /u/:handle and /privacy) — this is the URL
// Google's OAuth consent screen points its "Homepage URL" at, so it has
// to actually explain the app and never require sign-in to view.
export function AboutPage() {
  const { user, loading } = useCurrentUser()
  const navigate = useNavigate()
  const [showEmailSignIn, setShowEmailSignIn] = useState(false)

  if (showEmailSignIn) {
    return <EmailSignIn onBack={() => setShowEmailSignIn(false)} onSignedIn={() => navigate('/')} />
  }

  return (
    <div className="page">
      <PublicTopBar />

      <div className="auth-center">
        <div className="auth-tiles">
          <div className="auth-tile auth-tile-left">
            <span className="caption-text auth-tile-caption">INDEED.</span>
          </div>
          <div className="auth-tile auth-tile-center">
            <span className="caption-text auth-tile-caption auth-tile-caption-accent">WELL. YES.</span>
          </div>
          <div className="auth-tile auth-tile-right">
            <span className="caption-text auth-tile-caption">FAIR.</span>
          </div>
        </div>
        <h1 className="auth-headline">
          <span className="caption-text auth-headline-line1 auth-headline-accent">STREWTH!</span>
          <span className="caption-text auth-headline-line2">THERE'S A GIF FOR THAT.</span>
        </h1>
        <p className="auth-subline">
          Clip a moment from any video, caption it, and share it — StrewthGif is a home for the GIFs you make, not
          just the ones you find.
        </p>
        <SignInCta loading={loading} loggedIn={user !== null} onShowEmailSignIn={() => setShowEmailSignIn(true)} />
      </div>

      <div className="public-page">
        <h2>What it does</h2>
        <p>
          StrewthGif turns any video into a captioned GIF, Frinkiac-style. Upload a clip, scrub to the exact moment,
          add a caption, and export it as a GIF, MP4, or WebM. Everything you make is saved straight to your own
          personal library. Sign in with a Google account, or just an email address — no Google account required.
        </p>

        <h2>Build an archive</h2>
        <p>
          Every GIF and clip you create lives in your library, searchable so you can find it again later. You can
          also bring in GIFs you already have from elsewhere — drag and drop files you've saved, or paste in links —
          so your archive is complete, not just what you've made here.
        </p>

        <h2>Share to the Global Library</h2>
        <p>
          Made something worth sharing? Opt any GIF into the Global Library and it appears on your public profile
          page, viewable by anyone — no account needed. Everything stays private until you choose to publish it, and
          you can unpublish at any time.
        </p>

        <h2>Who it's for</h2>
        <p>
          Streamers, meme-makers, Discord and Slack communities, or anyone who'd rather have a personal, searchable
          GIF archive than scattered downloads.
        </p>

        <h2>Get started</h2>
        <SignInCta loading={loading} loggedIn={user !== null} onShowEmailSignIn={() => setShowEmailSignIn(true)} />

        <div className="public-page-footer">
          <Link to="/privacy">Privacy policy</Link>
          <a href="mailto:support@strewthgif.com">support@strewthgif.com</a>
        </div>
      </div>
    </div>
  )
}
