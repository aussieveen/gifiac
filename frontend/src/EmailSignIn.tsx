import { useEffect, useRef, useState } from 'react'
import { EmailAuthError, getConfig, startEmailLogin, verifyEmailCode } from './api'
import { AuthShell } from './AuthShell'
import { ArrowLeftIcon, LogInIcon } from './icons'
import type { CurrentUser } from './types'

// Cloudflare's widget API, loaded on demand (only when `/api/config`
// actually returns a site key — unset in local dev/test, where nothing
// tries to load this at all). Minimal ambient typing for just the calls
// this file makes.
declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void }): string
      remove(widgetId: string): void
      getResponse(widgetId: string): string | undefined
    }
  }
}

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
let turnstileScriptPromise: Promise<void> | null = null

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = TURNSTILE_SCRIPT_URL
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('failed to load Turnstile'))
      document.head.appendChild(script)
    })
  }
  return turnstileScriptPromise
}

/** Renders (and tears down) a Turnstile widget into `containerRef` once a
 * site key is known — returns the current verification token, or `null`
 * before the visitor has completed the challenge. `null` `siteKey` (the
 * `/api/config` default when `TURNSTILE_SECRET_KEY` isn't set — local
 * dev/test) renders nothing and the token stays permanently `null`,
 * matching the backend skipping verification in that same case.
 *
 * `getToken()` is what submit should actually call, not the `token`
 * state directly: Cloudflare's widget visibly flips to "Success!" and
 * writes its response into the DOM synchronously with completion, but
 * the registered `callback` — and so our `setToken` — can land a tick
 * later. A click right as "Success!" appears can otherwise race ahead of
 * the state update and submit an empty token despite the widget showing
 * success (reproduced in prod). `getResponse` reads the SDK's own
 * current value, sidestepping the race entirely; `token` state is kept
 * only to drive `required`/button-enabled rendering. */
function useTurnstile(siteKey: string | null) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [token, setToken] = useState<string | null>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!siteKey) return
    let cancelled = false

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (t) => setToken(t),
          'expired-callback': () => setToken(null),
        })
      })
      .catch(() => {
        // No Turnstile, no token — `/start` will then fail with a clear
        // "missing security check token" error rather than hanging.
      })

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current)
      widgetIdRef.current = null
    }
  }, [siteKey])

  function getToken(): string | null {
    const widgetId = widgetIdRef.current
    if (widgetId && window.turnstile) {
      const live = window.turnstile.getResponse(widgetId)
      if (live) return live
    }
    return token
  }

  return { containerRef, token, getToken, required: siteKey !== null }
}

type Step = { kind: 'email' } | { kind: 'code'; email: string }

interface EmailSignInProps {
  onBack: () => void
  onSignedIn: (user: CurrentUser) => void
}

/** The "Continue with email" flow (SPEC-EMAIL-AUTH.md) — reached from the
 * sign-in screen's own link. Two steps in one component (address entry,
 * then code entry) since neither is a real standalone route: the whole
 * pre-auth area isn't under react-router here (see App.tsx). */
export function EmailSignIn({ onBack, onSignedIn }: EmailSignInProps) {
  const [step, setStep] = useState<Step>({ kind: 'email' })
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getConfig()
      .then((config) => {
        if (!cancelled) setTurnstileSiteKey(config.turnstileSiteKey)
      })
      .catch(() => {
        // Sign-in should still work without Turnstile info — `/start`
        // itself is the source of truth on whether a token is required.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (step.kind === 'code') {
    return (
      <CodeStep
        email={step.email}
        onUseDifferentEmail={() => setStep({ kind: 'email' })}
        onSignedIn={onSignedIn}
      />
    )
  }

  return <EmailStep onBack={onBack} turnstileSiteKey={turnstileSiteKey} onCodeSent={(email) => setStep({ kind: 'code', email })} />
}

function EmailStep({
  onBack,
  turnstileSiteKey,
  onCodeSent,
}: {
  onBack: () => void
  turnstileSiteKey: string | null
  onCodeSent: (email: string) => void
}) {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const turnstile = useTurnstile(turnstileSiteKey)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)
    setError(null)
    try {
      await startEmailLogin(email.trim(), turnstile.getToken() ?? '')
      onCodeSent(email.trim())
    } catch (err) {
      setError(emailAuthErrorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const canSubmit = email.trim().length > 0 && !sending && (!turnstile.required || turnstile.token !== null)

  return (
    <AuthShell>
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeftIcon size={16} />
        Back
      </button>
      <h1 className="auth-heading">Continue with email</h1>
      <p className="auth-hint">
        Enter your email and we&rsquo;ll send you a 6-digit code. No passwords. New here? You&rsquo;ll pick a handle
        once you&rsquo;re in.
      </p>
      <form className="auth-form" onSubmit={submit}>
        <input
          className="auth-input"
          type="email"
          aria-label="Email address"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={sending}
          autoFocus
        />
        {turnstileSiteKey && <div ref={turnstile.containerRef} aria-label="Security check" />}
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          <LogInIcon size={18} />
          {sending ? 'Sending…' : 'Send code'}
        </button>
      </form>
      {error && <p className="export-error">{error}</p>}
    </AuthShell>
  )
}

const RESEND_COOLDOWN_SECONDS = 60

function CodeStep({
  email,
  onUseDifferentEmail,
  onSignedIn,
}: {
  email: string
  onUseDifferentEmail: () => void
  onSignedIn: (user: CurrentUser) => void
}) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null)
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS)
  const [resending, setResending] = useState(false)
  const submittedRef = useRef(false)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  async function submit(digits: string) {
    if (submittedRef.current) return
    submittedRef.current = true
    setSubmitting(true)
    setError(null)
    setAttemptsRemaining(null)
    try {
      const user = await verifyEmailCode(email, digits)
      onSignedIn(user)
    } catch (err) {
      setError(emailAuthErrorMessage(err))
      if (err instanceof EmailAuthError) setAttemptsRemaining(err.attemptsRemaining ?? null)
      setCode('')
    } finally {
      setSubmitting(false)
      submittedRef.current = false
    }
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    if (digits.length === 6) void submit(digits)
  }

  async function resend() {
    setResending(true)
    setError(null)
    try {
      // No Turnstile token on resend — the widget only lives on the email
      // step, and a resend is still the same already-validated attempt
      // cookie's address, not a fresh unauthenticated submission.
      await startEmailLogin(email, '')
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (err) {
      setError(emailAuthErrorMessage(err))
      if (err instanceof EmailAuthError && err.retryAfterSeconds) setCooldown(err.retryAfterSeconds)
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthShell>
      <button type="button" className="back-link" onClick={onUseDifferentEmail}>
        <ArrowLeftIcon size={16} />
        Use a different email
      </button>
      <h1 className="auth-heading">Check your email</h1>
      <p className="auth-hint">
        If <strong>{email}</strong> can sign in, we&rsquo;ve sent a 6-digit code to it. It expires in 10 minutes.
      </p>
      <form
        className="auth-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length === 6) void submit(code)
        }}
      >
        <input
          className="auth-input"
          aria-label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        <button type="submit" className="btn btn-primary" disabled={code.length !== 6 || submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {error && (
        <p className="export-error">
          {error}
          {attemptsRemaining !== null && <span> You have {attemptsRemaining} tries left with this code.</span>}
        </p>
      )}
      <p className="auth-hint">
        {cooldown > 0 ? (
          <>Resend code in {formatCooldown(cooldown)}</>
        ) : (
          <button type="button" className="back-link" onClick={resend} disabled={resending}>
            {resending ? 'Sending…' : 'Resend code'}
          </button>
        )}
      </p>
    </AuthShell>
  )
}

function formatCooldown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function emailAuthErrorMessage(err: unknown): string {
  if (err instanceof EmailAuthError) {
    switch (err.code) {
      case 'invalid_or_expired':
        return 'That code is incorrect or has expired.'
      case 'too_many_attempts':
        return 'Too many attempts. Request a new code.'
      default:
        if (err.retryAfterSeconds !== undefined) {
          return `Please wait ${err.retryAfterSeconds} seconds before requesting another code.`
        }
        return err.message
    }
  }
  return err instanceof Error ? err.message : String(err)
}
