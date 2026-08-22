import { useState } from "react";
import { mockGifs } from "../mockData";
import { copyLink, download, useHoverCycle, useToast } from "../hooks";
import type { GifEntry } from "../types";

// Variant B — dense data list. No hover-gated actions: every row shows its
// thumbnail, editable name, caption snippet, date, and action buttons
// all the time. Tests a scan-and-act layout instead of a visual browse.

function Row({
  gif,
  onRename,
  onCopy,
  onDownload,
  onDelete,
}: {
  gif: GifEntry;
  onRename: (name: string) => void;
  onCopy: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const cycle = useHoverCycle(gif.color);
  return (
    <div className="ab-row">
      <div className="ab-thumb" onMouseEnter={cycle.onMouseEnter} onMouseLeave={cycle.onMouseLeave}>
        <div className="thumb" style={{ background: cycle.color }} />
      </div>
      <input className="ab-name-input" value={gif.name} onChange={(e) => onRename(e.target.value)} />
      <div className="ab-caption" title={gif.captionText}>{gif.captionText}</div>
      <div className="ab-date">{new Date(gif.createdAt).toLocaleDateString()}</div>
      <div className="ab-actions">
        <button className="ab-btn" onClick={onCopy}>Copy link</button>
        <button className="ab-btn" onClick={onDownload}>Download</button>
        <button className="ab-btn danger" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

export function VariantB() {
  const [gifs, setGifs] = useState<GifEntry[]>(mockGifs);
  const [query, setQuery] = useState("");
  const toast = useToast();

  const filtered = gifs.filter(
    (g) => g.name.toLowerCase().includes(query.toLowerCase()) || g.captionText.toLowerCase().includes(query.toLowerCase())
  );

  function rename(id: string, name: string) {
    setGifs((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  }
  function remove(id: string) {
    setGifs((gs) => gs.filter((g) => g.id !== id));
    toast.show("Deleted");
  }

  return (
    <div className="page">
      <h1>Gifiac — Archive (Variant B)</h1>
      <p className="subtitle">Data list. Every action is an always-visible button, no hover required.</p>

      <input className="search-bar" placeholder="Search by name or caption text…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="result-count">{filtered.length} of {gifs.length} GIFs</div>

      <div className="ab-table">
        {filtered.map((g) => (
          <Row
            key={g.id}
            gif={g}
            onRename={(name) => rename(g.id, name)}
            onCopy={() => copyLink(g.id, toast.show)}
            onDownload={() => download(g.id, g.name, toast.show)}
            onDelete={() => remove(g.id)}
          />
        ))}
      </div>

      {toast.message && <div className="toast">{toast.message}</div>}
    </div>
  );
}
