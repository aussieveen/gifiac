import { hasFeature } from './features'
import type { CurrentUser } from './types'
import { useCanEdit } from './useCanEdit'

/** `desktop` at 1024px and up for everyone; below that, `mobile` for users
 * with the `mobileEdit` feature and `unavailable` ("needs a bigger screen")
 * for everyone else. Re-evaluates live as the window crosses 1024px. */
export type EditorLayout = 'desktop' | 'mobile' | 'unavailable'

export function useEditorLayout(user: Pick<CurrentUser, 'role'> | null | undefined): EditorLayout {
  const isWide = useCanEdit()
  if (isWide) return 'desktop'
  return hasFeature(user, 'mobileEdit') ? 'mobile' : 'unavailable'
}
