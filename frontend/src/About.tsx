import { Link } from 'react-router-dom'
import { LOGIN_URL } from './api'
import { LogInIcon } from './icons'
import { PublicTopBar } from './PublicTopBar'

// Public, unauthenticated marketing page (main.tsx routes it outside
// App's auth gate, same as /u/:handle and /privacy) — this is the URL
// Google's OAuth consent screen points its "Homepage URL" at, so it has
// to actually explain the app and never require sign-in to view.
export function AboutPage() {
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
        <a className="btn btn-primary btn-hero" href={LOGIN_URL}>
          <LogInIcon />
          Sign in with Google
        </a>
      </div>

      <div className="public-page">
        <h2>What it does</h2>
        <p>
          StrewthGif turns any video into a captioned GIF, Frinkiac-style. Upload a clip, scrub to the exact moment,
          add a caption, and export it as a GIF, MP4, or WebM. Everything you make is saved straight to your own
          personal library.
        </p>

        <h2>Build an archive</h2>
        <p>
          Every GIF and clip you create lives in your library, searchable so you can find it again later. You can
          also bulk-import GIFs you already have from elsewhere (like Giphy), so your archive is complete — not just
          what you've made here.
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
        <a className="btn btn-primary btn-hero" href={LOGIN_URL}>
          <LogInIcon />
          Sign in with Google
        </a>

        <div className="public-page-footer">
          <Link to="/privacy">Privacy policy</Link>
          <a href="mailto:support@strewthgif.com">support@strewthgif.com</a>
        </div>
      </div>
    </div>
  )
}
