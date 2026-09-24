import { Link } from 'react-router-dom'
import { PublicTopBar } from './PublicTopBar'

// Public, unauthenticated privacy policy (main.tsx routes it outside
// App's auth gate, same as /u/:handle and /about). Every fact below is
// drawn from the actual implementation — OAuth scope (backend/src/auth.rs),
// storage (backend/src/storage.rs, Cloudflare R2), hosting (terraform/),
// and account/content semantics (SPEC-CLOUD.md §5/§7) — not invented.
export function PrivacyPage() {
  return (
    <div className="page">
      <PublicTopBar />

      <div className="public-page">
        <h1>Privacy Policy</h1>
        <p className="va-hint">Last updated: 24 September 2026</p>

        <p>
          StrewthGif ("we", "us") is a small, single-operator GIF creation and archival tool. This page explains
          what information we collect when you use it, how we use it, and how to contact us about your data.
        </p>

        <h2>Information we collect</h2>
        <p>
          When you sign in with Google, we receive your email address and basic profile information (name and
          profile picture) via Google's OAuth service — nothing more. We don't request access to your Gmail, Drive,
          contacts, or any other Google data; the sign-in scope is limited to <code>openid email profile</code>.
        </p>
        <p>
          Once signed in, you choose a public handle for your account. Your account record stores that handle, your
          Google-provided avatar image, and the content you create — videos you upload, GIFs and clips you export,
          and captions you write. Some of that content you may choose to make public (visible on your profile page
          and in the shared Global Library); everything else stays private to your account by default.
        </p>
        <p>
          We don't use any third-party analytics, advertising, or tracking services. There are no tracking cookies,
          and no data is shared with ad networks. We set a single first-party session cookie to keep you signed in.
        </p>

        <h2>How we use your information</h2>
        <p>
          Your Google account information (email, name, avatar) is used solely to identify your account and display
          your public handle/avatar on your profile if you choose to publish content. Uploaded videos and exported
          GIFs are used only to provide the core service — letting you clip, caption, and store your content, and,
          if you opt in, to display it publicly. We don't use your content or account data for advertising, and we
          don't sell or rent it to anyone.
        </p>

        <h2>Where your data is stored</h2>
        <p>
          The application runs on a single AWS-hosted server. Your uploaded videos, generated GIFs, and other media
          files are stored using Cloudflare R2 object storage. Account records, session information, and content
          metadata are stored in a database on the same AWS-hosted server. No data is stored with, or shared with,
          any provider beyond AWS (compute) and Cloudflare (media storage) — the infrastructure that runs the
          service itself.
        </p>

        <h2>Sharing with third parties</h2>
        <p>
          We do not sell, rent, or share your personal information or content with third parties for marketing or
          any other purpose. The only parties with access to your data are the infrastructure providers named above
          (AWS, Cloudflare), which host the application and store media on our behalf, and Google, which you
          interact with directly during sign-in.
        </p>

        <h2>Public content</h2>
        <p>
          Any GIF or clip you explicitly mark as public becomes visible to anyone on your public profile page and in
          the shared Global Library — including to people without an account. Content is private by default and
          only becomes public when you opt in. You can unpublish content you've made public at any time from within
          the app.
        </p>

        <h2>Your rights and data deletion</h2>
        <p>
          You can unpublish any content you've made public at any time from within the app. If you'd like your
          account disabled or your data deleted entirely, contact us at{' '}
          <a href="mailto:privacy@strewthgif.com">privacy@strewthgif.com</a> and we'll action the request. Disabling an
          account revokes sign-in access; it does not automatically remove content you've already made public, so
          let us know in your request if you'd also like specific public content taken down, and we'll remove it.
        </p>

        <h2>Children's privacy</h2>
        <p>StrewthGif is not directed at children, and we don't knowingly collect data from anyone under 13.</p>

        <h2>Changes to this policy</h2>
        <p>
          If this policy changes, we'll update the "Last updated" date above. Continued use of the app after a
          change means you accept the updated policy.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy or your data? Email <a href="mailto:privacy@strewthgif.com">privacy@strewthgif.com</a>.
        </p>

        <div className="public-page-footer">
          <Link to="/about">About StrewthGif</Link>
        </div>
      </div>
    </div>
  )
}
