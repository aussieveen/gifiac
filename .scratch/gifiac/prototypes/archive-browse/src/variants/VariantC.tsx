import { useState } from "react";
import { mockGifs } from "../mockData";
import { copyLink, download, useColorCycle, useToast } from "../hooks";
import type { GifEntry } from "../types";

// Variant C — master-detail. A compact thumbnail grid on the left; click
// one to open it in a detail panel on the right, where all actions
// (rename, copy link, download, delete) live centralized, instead of
// scattered per-card or per-row. Grid thumbnails stay static — the
// hover-to-preview animation only happens in the detail panel.

function GridThumb({ gif, selected, onClick }: { gif: GifEntry; selected: boolean; onClick: () => void }) {
  return (
    <div className={`ac-thumb-wrap ${selected ? "selected" : ""}`} onClick={onClick}>
      <div className="thumb" style={{ background: gif.color }} />
    </div>
  );
}

export function VariantC() {
  const [gifs, setGifs] = useState<GifEntry[]>(mockGifs);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toast = useToast();
  const panelColor = useColorCycle(gifs.find((g) => g.id === selectedId)?.color ?? "#333", selectedId !== null);

  const filtered = gifs.filter(
    (g) => g.name.toLowerCase().includes(query.toLowerCase()) || g.captionText.toLowerCase().includes(query.toLowerCase())
  );
  const selected = gifs.find((g) => g.id === selectedId) ?? null;

  function rename(name: string) {
    if (!selected) return;
    setGifs((gs) => gs.map((g) => (g.id === selected.id ? { ...g, name } : g)));
  }
  function remove() {
    if (!selected) return;
    setGifs((gs) => gs.filter((g) => g.id !== selected.id));
    setSelectedId(null);
    toast.show("Deleted");
  }

  return (
    <div className="page">
      <h1>Gifiac — Archive (Variant C)</h1>
      <p className="subtitle">Grid + detail panel. Select a GIF to act on it from one central panel.</p>

      <input className="search-bar" placeholder="Search by name or caption text…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="result-count">{filtered.length} of {gifs.length} GIFs</div>

      <div className="ac-layout">
        <div className="ac-grid">
          {filtered.map((g) => (
            <GridThumb key={g.id} gif={g} selected={g.id === selectedId} onClick={() => setSelectedId(g.id)} />
          ))}
        </div>

        <div className="ac-panel">
          {!selected ? (
            <div className="ac-panel-empty">Select a GIF to view details and actions.</div>
          ) : (
            <>
              <div className="ac-panel-thumb">
                <div className="thumb" style={{ background: panelColor }}>
                  <span className="thumb-label">▶ preview</span>
                </div>
              </div>
              <input className="ac-panel-name" value={selected.name} onChange={(e) => rename(e.target.value)} />
              <div className="ac-panel-caption">{selected.captionText}</div>
              <div className="ac-panel-date">{new Date(selected.createdAt).toLocaleString()}</div>
              <div className="ac-panel-actions">
                <button className="ac-panel-btn" onClick={() => copyLink(selected.id, toast.show)}>🔗 Copy link</button>
                <button className="ac-panel-btn" onClick={() => download(selected.id, selected.name, toast.show)}>⬇ Download</button>
                <button className="ac-panel-btn danger" onClick={remove}>✕ Delete</button>
              </div>
            </>
          )}
        </div>
      </div>

      {toast.message && <div className="toast">{toast.message}</div>}
    </div>
  );
}
