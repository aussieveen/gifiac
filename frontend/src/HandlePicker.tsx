import { useState } from 'react'
import { setHandle } from './api'
import { AuthShell } from './AuthShell'
import type { CurrentUser } from './types'

interface HandlePickerProps {
  suggestedHandle: string | null
  onHandleSet: (user: CurrentUser) => void
}

// SPEC-CLOUD.md §5: shown once, right after first sign-in, until the user
// picks a handle — permanent once set, so this blocks the rest of the app
// exactly like the sign-in gate does, rather than letting it be skipped.
export function HandlePicker({ suggestedHandle, onHandleSet }: HandlePickerProps) {
  const [value, setValue] = useState(suggestedHandle ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const user = await setHandle(value.trim())
      onHandleSet(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthShell>
      <h1 className="auth-heading">Choose your handle</h1>
      <p className="auth-hint">
        This is permanent and can't be changed later. It's how others will find your public GIFs and templates.
      </p>
      <form className="auth-form" onSubmit={submit}>
        <input
          className="auth-input"
          aria-label="Handle"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
          autoFocus
        />
        <button type="submit" className="btn btn-primary" disabled={saving || value.trim().length === 0}>
          {saving ? 'Saving…' : 'Confirm handle'}
        </button>
      </form>
      {error && <p className="export-error">{error}</p>}
    </AuthShell>
  )
}
