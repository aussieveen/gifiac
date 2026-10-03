// PROTOTYPE — throwaway UI exploration for wayfinder gifiac#41 (child of
// map #40). Three radically different takes on how a logged-out-visible
// home page relates to the existing Global Library (`/explore`). Sub-shape
// B (new throwaway route, `/prototype/home-ia`) since there's genuinely no
// existing page this slots into — it's a routing gap, not an existing
// page to adjust. All three variants render the REAL `Library` component
// (it already tolerates `user: null`), not a mockup grid, so the review
// is against real data/behaviour. Delete this whole directory (and the
// route in main.tsx) once a variant wins or the losing variants are
// folded away — see NOTES-home-ia.md.

import { Link } from 'react-router-dom'
import lockup from '../assets/brand/strewthgif-lockup-on-dark.svg'
import { ArrowLeftIcon, LogInIcon, MailIcon } from '../icons'
import { Library } from '../Library'

function SignUpCta({ compact }: { compact?: boolean }) {
  return (
    <div className={compact ? 'home-ia-cta-compact' : 'home-ia-cta'}>
      <a className="btn btn-primary" href="/api/auth/login/google">
        <LogInIcon size={16} />
        Continue with Google
      </a>
      <button type="button" className="btn btn-secondary">
        <MailIcon size={16} />
        Continue with email
      </button>
    </div>
  )
}

// ---------- Variant A: unified — the Global Library IS the home page, full stop ----------

function VariantA() {
  return (
    <div className="home-ia-variant-a">
      <div className="home-ia-banner">
        <span className="home-ia-banner-text">Like what you see? Sign up to start making your own.</span>
        <SignUpCta compact />
      </div>
      <Library />
    </div>
  )
}

// ---------- Variant B: twin page — new route, own header + CTA, same grid component as /explore ----------

function VariantB() {
  return (
    <div className="home-ia-variant-b">
      <header className="home-ia-header-b">
        <Link to="/" className="app-header-brand" aria-label="StrewthGif">
          <img src={lockup} alt="StrewthGif" />
        </Link>
        <SignUpCta />
      </header>
      <Library />
    </div>
  )
}

// ---------- Variant C: marketing landing — hero first, full library below the fold ----------

function VariantC() {
  return (
    <div className="home-ia-variant-c">
      <div className="home-ia-hero">
        <h1 className="home-ia-hero-headline">
          <span className="caption-text home-ia-hero-line1">STREWTH!</span>
          <span className="caption-text home-ia-hero-line2">THERE'S A GIF FOR THAT.</span>
        </h1>
        <p className="home-ia-hero-subline">Clip it, caption it, send it. Browse what people are making below.</p>
        <SignUpCta />
      </div>
      <Library />
    </div>
  )
}

const VARIANTS = {
  A: { Component: VariantA, name: 'Unified — Global Library is the home page' },
  B: { Component: VariantB, name: 'Twin page — new route, same grid' },
  C: { Component: VariantC, name: 'Marketing landing — hero + library below' },
} as const

export type VariantKey = keyof typeof VARIANTS

export function HomeIaPrototype() {
  const params = new URLSearchParams(window.location.search)
  const variant = (params.get('variant') as VariantKey) ?? 'A'
  const { Component } = VARIANTS[variant]
  const keys = Object.keys(VARIANTS) as VariantKey[]
  const idx = keys.indexOf(variant)

  function go(v: VariantKey) {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', v)
    window.location.href = url.toString()
  }

  return (
    <div className="home-ia-page">
      <Component />
      <div className="home-ia-switcher">
        <Link to="/" className="home-ia-switcher-exit" aria-label="Exit prototype">
          <ArrowLeftIcon size={14} />
        </Link>
        <button type="button" className="home-ia-switcher-arrow" onClick={() => go(keys[(idx - 1 + keys.length) % keys.length])}>
          ←
        </button>
        <span className="home-ia-switcher-label">
          {variant} — {VARIANTS[variant].name}
        </span>
        <button type="button" className="home-ia-switcher-arrow" onClick={() => go(keys[(idx + 1) % keys.length])}>
          →
        </button>
      </div>
    </div>
  )
}
