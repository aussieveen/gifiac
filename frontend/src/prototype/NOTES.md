# Ingest loading modal — prototype notes

Wayfinder ticket: gifiac#38 (child of map #32).

**Question:** what should the upload/ingest loading modal look like, across its three stages (Uploading → Analyzing → Building filmstrip)?

**Variants**, switchable via `?variant=A|B|C` on `/new` (dev-only, gated on `import.meta.env.DEV`):

- **A — Centered modal + stepper.** A classic blocking overlay dialog with a vertical 3-step list (check / spinner / pending per step).
- **B — Tile morphs in place.** No overlay — the upload tile itself swaps its content for a spinner + stage label + progress dots, non-blocking.
- **C — Corner toast.** A small bottom-right notification card with a stage label and a filling progress bar; the rest of the page stays fully visible/usable.

**Verdict:** not yet chosen — pending your review. Flip through them on `/new` (needs a logged-in session; the dev server must be running) and pick one, or call out pieces of each to combine (e.g. "B's non-blocking feel with A's clearer step list"). Once decided:

- Delete the losing variants out of `IngestModalPrototype.tsx` and fold the winner's JSX/CSS into `NewGifPage.tsx` for real (rewritten without the fake timer — driven by the real ingest job's SSE stream once that's built).
- Delete this whole `frontend/src/prototype/` directory and the `?variant=`/switcher wiring in `NewGifPage.tsx`.
- Post the verdict as the resolution comment on gifiac#38 and close it.
