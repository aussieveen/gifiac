import { useEffect, useRef, useState } from 'react'

export interface ToastAction {
  label: string
  onClick: () => void
}

/** Auto-dismisses after a beat, matching the archive prototype's toast —
 * shared by every screen with a "Copied"/"Deleted"/etc. confirmation
 * (My Library, Global Library). `opts.action`/`opts.durationMs` are used
 * by collection deletion's "Undo" toast (collections-design/
 * COLLECTIONS.md §4: an 8-second window); every other call site ignores
 * them and keeps the plain 2-second auto-dismiss. */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null)
  const [action, setAction] = useState<ToastAction | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function show(msg: string, opts?: { action?: ToastAction; durationMs?: number }) {
    setMessage(msg)
    setAction(opts?.action ?? null)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setMessage(null)
      setAction(null)
    }, opts?.durationMs ?? 2000)
  }

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  return { message, action, show }
}
