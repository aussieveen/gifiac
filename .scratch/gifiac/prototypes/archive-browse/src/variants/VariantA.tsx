import { useMemo, useState } from "react";
import { mockGifs } from "../mockData";
import { copyLink, download, useHoverCycle, useToast } from "../hooks";
import type { GifEntry } from "../types";

// Variant A — Giphy/Tenor-style card grid. Hover a card to see it "animate"
// (color-cycle stand-in) and reveal copy-link / download icon buttons in
// the corner. Actions are hidden until hover.

function Card({ gif, onCopy, onDownload }: { gif: GifEntry; onCopy: () => void; onDownload: () => void }) {
  const cycle = useHoverCycle(gif.color);
  return (
    <div className="aa-card">
      <div className="aa-thumb-wrap" onMouseEnter={cycle.onMouseEnter} onMouseLeave={cycle.onMouseLeave}>
        <div className="thumb" style={{ background: cycle.color }}>
          {cycle.hovering && <span className="thumb-label">▶ preview</span>}
        </div>
        <div className="aa-overlay">
          <button className="aa-icon-btn" title="Copy link" onClick={onCopy}>🔗</button>
          <button className="aa-icon-btn" title="Download" onClick={onDownload}>⬇</button>
        </div>
      </div>
      <div className="aa-card-name">{gif.name}</div>
      <div className="aa-card-caption">{gif.captionText}</div>
    </div>
  );
}

export function VariantA() {
  const gifs = useMemo(mockGifs, []);
  const [query, setQuery] = useState("");
  const toast = useToast();

  const filtered = gifs.filter(
    (g) => g.name.toLowerCase().includes(query.toLowerCase()) || g.captionText.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="page">
      <h1>Gifiac — Archive (Variant A)</h1>
      <p className="subtitle">Card grid. Hover a card to preview and reveal actions.</p>

      <input className="search-bar" placeholder="Search by name or caption text…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="result-count">{filtered.length} of {gifs.length} GIFs</div>

      <div className="aa-grid">
        {filtered.map((g) => (
          <Card key={g.id} gif={g} onCopy={() => copyLink(g.id, toast.show)} onDownload={() => download(g.id, g.name, toast.show)} />
        ))}
      </div>

      {toast.message && <div className="toast">{toast.message}</div>}
    </div>
  );
}
