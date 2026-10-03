# Export progress modal — prototype notes

Wayfinder ticket: gifiac#39 (child of map #32).

**Question:** where should the export progress UI live? The row content itself was already locked by map #32's "Export UI shape" decision (rotating icon + live percentage → checkmark, one row per format) — what's open is placement, since `CaptionEditor.tsx` already has an existing `.editor-toast` idiom explicitly anchored near the Make GIF button (per a design-brief comment), unlike `NewGifPage` which had no prior art for the ingest modal.

**Variants**, switchable via `?exportVariant=A|B|C` on `/edit/:videoId` (dev-only, gated on `import.meta.env.DEV`):

- **A — Anchored panel**: evolves the existing `.editor-toast` idiom — a panel anchored under the Make GIF button, non-blocking.
- **B — Centered modal**: blocking overlay, consistent with the ingest modal's winning pattern (gifiac#38).
- **C — Inline in the Make GIF popover**: morphs the already-open popover in place instead of closing it.

**Verdict:** not yet chosen — pending your review. Once decided:

- Delete the losing variants out of `ExportModalPrototype.tsx` and fold the winner into `CaptionEditor.tsx` for real (rewritten to read the real per-format status from `exportProgress`/`subscribeExportProgress` — which will need to change shape once export becomes 3 parallel Lambda invocations instead of today's single sequential stage, per map #32's "Parallel encoding" and "Progress state" decisions).
- Delete this whole `frontend/src/prototype/` directory and the `?exportVariant=`/switcher wiring in `CaptionEditor.tsx`.
- Post the verdict as the resolution comment on gifiac#39 and close it.
