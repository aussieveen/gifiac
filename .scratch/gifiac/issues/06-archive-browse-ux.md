Type: prototype
Status: resolved
Assignee: claude (this session)

## Question

What does the archive/library view look like and how does it behave? The archive lists all GIFs the user has made, supports search by name and caption text, and provides copy-link and download actions. Settle: grid vs list layout, how search is presented, how the GIF/MP4 is previewed inline (hover-to-play?), and how copy-link / download is surfaced per item. Build a rough React prototype (no backend) to react to. Link the prototype here.

## Prototype

`.scratch/gifiac/prototypes/archive-browse/` — Vite + React + TypeScript, three structurally different variants, switchable via `?variant=A|B|C` or the on-page arrow bar / ←→ keys.

Run: `cd .scratch/gifiac/prototypes/archive-browse && npm install && npm run dev`

- **A — Card grid**: Giphy/Tenor-style cards, hover to preview (color-cycle stand-in) and reveal copy-link/download icon buttons.
- **B — Data list**: dense rows, thumbnail + inline-editable name + caption snippet + date + always-visible action buttons, no hover required.
- **C — Grid + detail panel**: compact thumbnail grid on the left, click one to open a detail panel on the right with all actions centralized there.

All three have a live-filtering search bar (matches name + caption text, mirroring the real `?q=` API semantics) and a working copy-link (via `navigator.clipboard`, with toast feedback).

## Answer

**Layout: Variant C — master-detail.** A compact thumbnail grid on the left; clicking a thumbnail opens it in a detail panel on the right. Grid thumbnails stay static — no hover effect on the grid itself.

**Preview**: the animated preview (color-cycle stand-in for a playing GIF) lives only in the detail panel, and **auto-plays as soon as a GIF is selected** — not gated behind hover. Selecting a different item swaps the panel and its preview restarts.

**Actions**: centralized in the detail panel rather than scattered per-card or per-row — Copy link, Download, Delete, plus an inline-editable name field (rename without a full re-export, per `PATCH /api/gifs/{id}`).

**Search**: a single search bar filtering by name + caption text together, live as you type — matches the `GET /api/gifs?q={query}` contract from [API surface design](05-api-surface-design.md) exactly (one combined query param, no separate name/tag filters).

Prototype: `.scratch/gifiac/prototypes/archive-browse/` (Variant C is the winning design; Variants A and B are reference-only now and can be deleted once the real archive view is built).
