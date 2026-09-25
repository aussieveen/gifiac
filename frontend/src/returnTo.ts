const RETURN_TO_KEY = 'strewthgif:return_to'

/** Only same-origin relative paths are accepted — `//evil.com` looks like a
 * path but browsers resolve it as protocol-relative, so it's rejected
 * alongside any absolute URL. */
function isSafeReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//')
}

/** Called right before navigating to the sign-in link, so a signed-out
 * visitor who followed a deep link (e.g. /library/<id>) lands back on it
 * after signing in instead of on the default library view. */
export function saveReturnTo(path: string): void {
  if (!isSafeReturnPath(path) || path === '/') return
  sessionStorage.setItem(RETURN_TO_KEY, path)
}

/** One-shot: reads and clears the stored path, so a later sign-out/sign-in
 * cycle doesn't replay a stale destination. */
export function consumeReturnTo(): string | null {
  const path = sessionStorage.getItem(RETURN_TO_KEY)
  sessionStorage.removeItem(RETURN_TO_KEY)
  return path && isSafeReturnPath(path) ? path : null
}
