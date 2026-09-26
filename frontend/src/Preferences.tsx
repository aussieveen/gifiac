import { useState } from 'react'
import { updatePreferences } from './api'
import type { CurrentUser } from './types'
import { useToast } from './useToast'

// The Preferences page (new — first option: "disable gif autoplay").
// Account-backed, not a local-only toggle: `user`/`onUserChange` come from
// App's own `useCurrentUser()`, same pattern `HandlePicker` uses to hand a
// freshly updated `CurrentUser` back up without a redundant re-fetch.
export function Preferences({
  user,
  onUserChange,
}: {
  user: CurrentUser
  onUserChange: (user: CurrentUser) => void
}) {
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  async function toggleDisableAutoplay() {
    const next = !user.preferences.disableGifAutoplay
    setSaving(true)
    try {
      const preferences = await updatePreferences({ disableGifAutoplay: next })
      onUserChange({ ...user, preferences })
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">Preferences</h1>

      <div className="preferences-list">
        <label className="preferences-row">
          <div className="preferences-row-text">
            <span className="preferences-row-title">Disable gif autoplay</span>
            <span className="va-hint">
              Gifs in grid views stay paused on a static frame until you hover over them (or tap, on a touch
              device, to open the full preview). The full-size preview always plays normally.
            </span>
          </div>
          <input
            type="checkbox"
            checked={user.preferences.disableGifAutoplay}
            disabled={saving}
            onChange={toggleDisableAutoplay}
          />
        </label>
      </div>

      {toast.message && (
        <div className="archive-toast">
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  )
}
