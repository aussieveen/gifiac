import { useState } from "react";
import type { CaptionBlock } from "../types";
import { FRAME_COUNT, FRAME_INTERVAL, frameColor, initialCaptions, nextCaptionId } from "../mockData";

// Variant C — no continuous filmstrip scrubber at all. The clip is a
// storyboard grid of frame thumbnails; click-drag across cells selects a
// frame range, and a mode toggle decides whether that range becomes a new
// caption's time span or sets the GIF export in/out range. Captions are
// managed as cards with inline style controls rather than a persistent
// side panel. Tests a grid/spatial-selection metaphor instead of a
// horizontal timeline.

type Mode = "caption" | "gif";

const FONTS = ["Impact, sans-serif", "Georgia, serif", "system-ui, sans-serif", "'Courier New', monospace"];

function frameTime(i: number) {
  return i * FRAME_INTERVAL;
}

function frameInRange(i: number, start: number, end: number) {
  const t = frameTime(i);
  return t >= start && t < end;
}

export function VariantC() {
  const [captions, setCaptions] = useState<CaptionBlock[]>(initialCaptions);
  const [selectedId, setSelectedId] = useState<string | null>("cap-2");
  const [mode, setMode] = useState<Mode>("caption");
  const [gifRange, setGifRange] = useState({ in: 2, out: 5 });
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  function updateCaption(id: string, patch: Partial<CaptionBlock>) {
    setCaptions((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function deleteCaption(id: string) {
    setCaptions((cs) => cs.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function onCellDown(i: number) {
    setDrag({ start: i, end: i });
  }
  function onCellEnter(i: number) {
    setDrag((d) => (d ? { ...d, end: i } : d));
  }
  function onCellUp() {
    if (!drag) return;
    const lo = Math.min(drag.start, drag.end);
    const hi = Math.max(drag.start, drag.end);
    const start = frameTime(lo);
    const end = frameTime(hi) + FRAME_INTERVAL;
    if (mode === "caption") {
      const id = nextCaptionId();
      setCaptions((cs) => [
        ...cs,
        { id, startTime: start, endTime: end, text: "New caption", fontFamily: FONTS[0], fontSize: 24, color: "#ffffff", align: "center", x: 0.5, y: 0.88 },
      ]);
      setSelectedId(id);
    } else {
      setGifRange({ in: start, out: end });
    }
    setDrag(null);
  }

  function makeGif() {
    const payload = {
      gifRange,
      captions: captions.map(({ id, startTime, endTime, text, fontFamily, fontSize, color, align }) => ({
        id, startTime, endTime, text, fontFamily, fontSize, color, align,
      })),
    };
    setOutput(JSON.stringify(payload, null, 2));
    console.log("Make GIF payload", payload);
  }

  const selected = captions.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="page" onMouseUp={onCellUp}>
      <h1>Gifiac — Caption editor (Variant C)</h1>
      <p className="subtitle">No timeline. Click-drag a frame range on the grid to place a caption or set the GIF range.</p>

      <div className="vc-mode-row">
        <button className={`vc-mode-btn ${mode === "caption" ? "active" : ""}`} onClick={() => setMode("caption")}>
          Drag to: new caption
        </button>
        <button className={`vc-mode-btn ${mode === "gif" ? "active" : ""}`} onClick={() => setMode("gif")}>
          Drag to: set GIF range
        </button>
        <span style={{ color: "#999", marginLeft: 8 }}>
          GIF range: {gifRange.in.toFixed(2)}s – {gifRange.out.toFixed(2)}s
        </span>
      </div>

      <div className="vc-layout">
        <div className="vc-grid" onMouseLeave={() => setDrag(null)}>
          {Array.from({ length: FRAME_COUNT }).map((_, i) => {
            const inDragSel = drag && i >= Math.min(drag.start, drag.end) && i <= Math.max(drag.start, drag.end);
            const inGif = frameInRange(i, gifRange.in, gifRange.out);
            const inSelectedCaption = selected && frameInRange(i, selected.startTime, selected.endTime);
            const inAnyCaption = captions.some((c) => frameInRange(i, c.startTime, c.endTime));
            const classes = [
              "vc-cell",
              inDragSel ? "selected-drag" : "",
              inSelectedCaption ? "selected-caption-range" : inAnyCaption ? "in-caption-range" : "",
              inGif ? "in-gif-range" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={i}
                className={classes}
                style={{ background: frameColor(i) }}
                onMouseDown={() => onCellDown(i)}
                onMouseEnter={() => onCellEnter(i)}
                title={`t=${frameTime(i).toFixed(2)}s`}
              />
            );
          })}
        </div>

        <div className="vc-sidebar">
          {captions.map((c) => (
            <div key={c.id} className={`vc-card ${selectedId === c.id ? "selected" : ""}`} onClick={() => setSelectedId(c.id)}>
              <div className="vc-card-head">
                <span>{c.id} · {c.startTime.toFixed(2)}s–{c.endTime.toFixed(2)}s</span>
                <button onClick={(e) => { e.stopPropagation(); deleteCaption(c.id); }}>✕ delete</button>
              </div>
              <textarea value={c.text} onClick={(e) => e.stopPropagation()} onChange={(e) => updateCaption(c.id, { text: e.target.value })} />
              <div className="vc-inline-style" onClick={(e) => e.stopPropagation()}>
                <select value={c.fontFamily} onChange={(e) => updateCaption(c.id, { fontFamily: e.target.value })}>
                  {FONTS.map((f) => (
                    <option key={f} value={f}>{f.split(",")[0]}</option>
                  ))}
                </select>
                <input type="range" min={12} max={48} value={c.fontSize} onChange={(e) => updateCaption(c.id, { fontSize: Number(e.target.value) })} />
                <input type="color" value={c.color} onChange={(e) => updateCaption(c.id, { color: e.target.value })} />
                <select value={c.align} onChange={(e) => updateCaption(c.id, { align: e.target.value as CaptionBlock["align"] })}>
                  <option value="left">left</option>
                  <option value="center">center</option>
                  <option value="right">right</option>
                </select>
              </div>
            </div>
          ))}
          <button className="vc-make-gif" onClick={makeGif}>Make GIF</button>
        </div>
      </div>

      {output && <pre className="output-json">{output}</pre>}
    </div>
  );
}
