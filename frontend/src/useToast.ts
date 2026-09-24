import { useEffect, useRef, useState } from 'react'

/** Auto-dismisses after a beat, matching the archive prototype's toast —
 * shared by every screen with a "Copied"/"Deleted"/etc. confirmation
 * (My Library, Global Library). */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function show(msg: string) {
    setMessage(msg)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setMessage(null), 2000)
  }

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  return { message, show }
}
