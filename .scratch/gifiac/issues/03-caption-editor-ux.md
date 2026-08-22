Type: prototype
Status: resolved
Assignee: claude (this session)

## Question

What exactly does the visual timeline caption editor look like and how does it behave? Inspired by Frinkiac's advanced editor (screenshot at ~/Pictures/screenshot-2026-08-21_20-55-07.png): a live preview frame top-left, each caption on its own draggable track row, a film-strip scrubber at the bottom.

Settle: how caption blocks are created, resized, and deleted; how the user scrubs to a frame; how the font, size, colour, and position of text is set; what the "Make GIF" trigger looks like; and what data structure (start-time, end-time, text, style) a caption block produces for the export pipeline.

Build a rough React prototype (no backend) showing the layout and interactions so the design can be reacted to. Link the prototype here.

## Prototype

`.scratch/gifiac/prototypes/caption-editor/` — Vite + React + TypeScript, three structurally different variants of the editor, switchable via `?variant=A|B|C` or the on-page arrow bar / ←→ keys.

Run: `cd .scratch/gifiac/prototypes/caption-editor && npm install && npm run dev`

- **A — Timeline lanes (Frinkiac-faithful)**: one draggable/resizable lane per caption below the preview, plus a separate film-strip scrubber with its own yellow-highlighted GIF in/out range.
- **B — Canvas drag + list**: no lanes. Captions are dragged directly on the video preview for position; start/end time are plain number fields on a sidebar card list; GIF range set via mark-in/mark-out buttons.
- **C — Storyboard grid + cards**: no continuous filmstrip. The clip is a grid of frame thumbnails; click-drag a cell range to either place a new caption or set the GIF range (mode toggle), with caption cards below for text/style editing.

All three end in a "Make GIF" button that dumps the caption-block JSON (`id, startTime, endTime, text, fontFamily, fontSize, color, align[, x, y]`) to the page and console — that's the candidate data structure for the export pipeline ticket.

## Answer

**Layout/interaction model: Variant A — timeline lanes.** One draggable/resizable track row per caption below the live preview: drag the pill body to move it in time, drag its left/right edges to resize. A `+` button adds a new caption at the current playhead; a red `✕` deletes a track. **One editor mode only** — no Simple/Advanced toggle.

**Scrubbing**: click/drag on the film-strip (below the lanes) moves the playhead. A separate yellow-highlighted, drag-handled range on that same film-strip sets the GIF export in/out points, independent of caption timing. Frame-strip density: one thumbnail every 0.25s (as prototyped), with zoom in/out controls for adjusting on the fly — this also settles the frame-strip shape left open by [Video ingest design](02-video-ingest-design.md) (generated on-demand, not at upload).

**Style panel** (right of the preview, edits whichever caption is selected): multi-line text box, font-family dropdown, size slider, color swatch, left/center/right alignment buttons, and an "All tracks" checkbox to apply the current style to every caption at once.

**Position**: draggable directly on the live preview (grafted from Variant B) — defaults to bottom-center on creation, user can drag it anywhere in the frame.

**Make GIF trigger**: a prominent button in the controls row beside the film-strip.

**Caption data structure** (feeds [Export pipeline design](04-export-pipeline-design.md) and [API surface design](05-api-surface-design.md)):
```
{ id, startTime, endTime, text, fontFamily, fontSize, color, align, x, y }
```
`startTime`/`endTime` in seconds relative to clip start; `x`/`y` are 0–1 fractional position within the frame.

Prototype: `.scratch/gifiac/prototypes/caption-editor/` (Variant A is the winning design; Variants B and C are reference-only now and can be deleted once the real editor is built).
