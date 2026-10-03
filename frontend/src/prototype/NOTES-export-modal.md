# Export progress modal — prototype notes

Wayfinder ticket: gifiac#39 (child of map #32).

**Question:** where should the export progress UI live? The row content itself was already locked by map #32's "Export UI shape" decision (rotating icon + live percentage → checkmark, one row per format) — what was open was placement, since `CaptionEditor.tsx` already has an existing `.editor-toast` idiom explicitly anchored near the Make GIF button (per a design-brief comment), unlike `NewGifPage` which had no prior art for the ingest modal.

**Verdict: Variant B — centered modal.** Chosen directly for consistency with the ingest modal's winning pattern (gifiac#38), over the two alternatives (an anchored panel evolving the existing toast idiom, and an inline morph of the Make GIF popover).

Retained as a design reference at [`ExportModalPrototype.tsx`](./ExportModalPrototype.tsx) (`ExportProgressModal`, styled via the `.export-modal-*` classes in `index.css`). **Not wired into the live export flow** — export doesn't encode gif/mp4/webm in parallel yet (today it's one sequential stage, relayed via `exportProgress` in `CaptionEditor.tsx`), so there's nothing real to drive the 3-row design off until the Lambda work from map #32 lands ("Parallel encoding" / "Progress state" decisions). The component takes a `progress: ExportProgressState` + `allDone` prop directly; `ExportProgressModalDemo` is only a fake-timer wrapper for eyeballing it in isolation and should be dropped when wiring this up for real.

When the parallel export backend lands: mount `<ExportProgressModal progress={...} allDone={...} />` in `CaptionEditor.tsx` (replacing the current single-stage `exportProgress` toast), fed by the real per-format status from the export job's SSE stream instead of the fake timer.
