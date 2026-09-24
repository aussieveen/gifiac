// Pure helpers for handle display/routing (SPEC-CLOUD.md §5) — kept
// dependency-free like timeline.ts, so link-building logic can be unit
// tested without mounting a component.

/** `/u/:slug` path for a profile link. `slug` must be the real, backend
 * -assigned slug (`CurrentUser.slug` / `LibraryEntry.owner_slug`) — never
 * derive one from the display handle (e.g. via `.toLowerCase()`): a
 * collision-suffixed slug ("sim_mc2") can diverge from that, and guessing
 * wrong silently 404s (see backend/migrations/0012_slug_column.sql). */
export function profileUrl(slug: string): string {
  return `/u/${slug}`
}
