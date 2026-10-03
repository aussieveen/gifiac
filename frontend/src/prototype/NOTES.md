# Ingest loading modal — prototype notes

Wayfinder ticket: gifiac#38 (child of map #32).

**Question:** what should the upload/ingest loading modal look like, across its three stages (Uploading → Analyzing → Building filmstrip)?

**Verdict: Variant A — centered modal + vertical stepper.** A blocking overlay dialog with a 3-step checklist (✓ done / spinner active / pending), one row per stage. Chosen directly over the two alternatives (a non-blocking tile morph, and a corner toast) with no further back-and-forth.

Retained as a design reference at [`IngestModalPrototype.tsx`](./IngestModalPrototype.tsx) (`IngestLoadingModal`, styled via the `.ingest-modal-*` classes in `index.css`). **Not wired into the live upload flow** — it has nothing real to drive off yet, since the ingest Lambda job and its stage-tracking SSE stream (gifiac#35's `ingest_jobs` table, map #32's "Ingest flow" decision) don't exist until that implementation work happens. The component takes a `stage: IngestStage` prop directly; `IngestLoadingModalDemo` is only a fake-timer wrapper for eyeballing it in isolation and should be dropped when wiring this up for real.

When the ingest job backend lands: mount `<IngestLoadingModal stage={...} />` in `NewGifPage.tsx` (replacing the current plain "Uploading…" text swap), fed by the real `stage` value from the ingest job's SSE stream instead of the fake timer.
