# Logged-out home page IA — prototype notes

Wayfinder ticket: gifiac#41 (child of map #40).

**Question:** how should a logged-out-visible home page relate to the existing Global Library (`/explore`)?

**Variants**, at `/prototype/home-ia?variant=A|B|C` (all three render the real `Library` component, not a mockup grid):

- **A — Unified**: the Global Library *is* the home page — a thin top banner carries the sign-up CTA, the grid renders directly below with no distinct header of its own. Implies `/explore` disappears and merges into `/`.
- **B — Twin page**: a new route with its own branded header (wordmark + CTA buttons, same layout shape as the real authed app header but with sign-up instead of an account menu) sitting above the same `Library` grid component. Implies `/explore` and `/` stay as two separate routes rendering the same component, differing only in header/CTA.
- **C — Marketing landing**: the existing sign-in screen's hero treatment ("STREWTH! THERE'S A GIF FOR THAT.") up top, full (not teaser) Global Library below the fold.

**Verdict:** not yet chosen — pending your review. Once decided, resolving this also answers the map's other open questions (CTA placement/design, whether the logged-in `/` → `/library` redirect changes, whether `PublicTopBar` needs extending) — don't split those into separate tickets, they're facets of this same decision. Then:

- Delete the losing variants out of `HomeIaPrototype.tsx` and fold the winner into the real routing (`main.tsx`/`App.tsx`) — this one likely *can* be wired for real immediately, unlike the ffmpeg map's UI prototypes, since the backend (`list_library`) is already auth-optional today. No blocked backend work here.
- Delete this whole `frontend/src/prototype/` directory (if nothing else is using it) and the `/prototype/home-ia` route in `main.tsx`.
- Post the verdict as the resolution comment on gifiac#41 and close it.
