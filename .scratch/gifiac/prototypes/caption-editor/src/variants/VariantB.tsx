import { useRef, useState } from "react";
import type { CaptionBlock } from "../types";
import { CLIP_DURATION, FRAME_COUNT, frameColor, initialCaptions, nextCaptionId } from "../mockData";

// Variant B — no timeline lanes at all. Captions are dragged directly on
// the video preview to set position; start/end time are plain number
// inputs on a card in the sidebar, not a draggable lane. Tests whether the
// lane metaphor is necessary or whether a simpler list + direct
// manipulation is enough.

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

const FONTS = ["Impact, sans-serif", "Georgia, serif", "system-ui, sans-serif", "'Courier New', monospace"];

export function VariantB() {
  const [captions, setCaptions] = useState<CaptionBlock[]>(initialCaptions);
  const [selectedId, setSelectedId] = useState<string | null>("cap-2");
  const [currentTime, setCurrentTime] = useState(3);
  const [gifRange, setGifRange] = useState({ in: 2, out: 5 });
  const [output, setOutput] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string } | null>(null);

  const selected = captions.find((c) => c.id === selectedId) ?? null;
  const activeCaptions = captions.filter((c) => currentTime >= c.startTime && currentTime <= c.endTime);
  const currentFrame = Math.min(FRAME_COUNT - 1, Math.floor((currentTime / CLIP_DURATION) * FRAME_COUNT));

  function updateCaption(id: string, patch: Partial<CaptionBlock>) {
    setCaptions((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function startCanvasDrag(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setSelectedId(id);
    dragRef.current = { id };
    window.addEventListener("mousemove", onCanvasDrag);
    window.addEventListener("mouseup", endCanvasDrag);
  }

  function onCanvasDrag(e: MouseEvent) {
    const drag = dragRef.current;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    updateCaption(drag.id, { x, y });
  }

  function endCanvasDrag() {
    dragRef.current = null;
    window.removeEventListener("mousemove", onCanvasDrag);
    window.removeEventListener("mouseup", endCanvasDrag);
  }

  function addCaption() {
    const id = nextCaptionId();
    setCaptions((cs) => [
      ...cs,
      { id, startTime: currentTime, endTime: clamp(currentTime + 1, 0, CLIP_DURATION), text: "New caption", fontFamily: FONTS[0], fontSize: 24, color: "#ffffff", align: "center", x: 0.5, y: 0.5 },
    ]);
    setSelectedId(id);
  }

  function deleteCaption(id: string) {
    setCaptions((cs) => cs.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function makeGif() {
    const payload = {
      gifRange,
      captions: captions.map(({ id, startTime, endTime, text, fontFamily, fontSize, color, align, x, y }) => ({
        id, startTime, endTime, text, fontFamily, fontSize, color, align, x, y,
      })),
    };
    setOutput(JSON.stringify(payload, null, 2));
    console.log("Make GIF payload", payload);
  }

  return (
    <div className="page">
      <h1>Gifiac — Caption editor (Variant B)</h1>
      <p className="subtitle">No timeline lanes. Drag captions on the frame; set time via number fields on each card.</p>

      <div className="vb-layout">
        <div className="vb-canvas-col">
          <div ref={frameRef} className="preview-frame" style={{ background: frameColor(currentFrame) }}>
            <span>frame {currentFrame + 1}/{FRAME_COUNT} · t={currentTime.toFixed(2)}s</span>
            {activeCaptions.map((c) => (
              <div
                key={c.id}
                className={`vb-draggable-caption ${selectedId === c.id ? "selected" : ""}`}
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, fontFamily: c.fontFamily, fontSize: c.fontSize, color: c.color, textAlign: c.align }}
                onMouseDown={(e) => startCanvasDrag(e, c.id)}
              >
                {c.text}
              </div>
            ))}
          </div>

          <div className="vb-scrubber">
            <input type="range" min={0} max={CLIP_DURATION} step={0.05} value={currentTime} onChange={(e) => setCurrentTime(Number(e.target.value))} />
          </div>
          <div className="vb-mark-row">
            <button className="va-btn" onClick={() => setGifRange((r) => ({ ...r, in: Math.min(currentTime, r.out - 0.1) }))}>Mark in</button>
            <button className="va-btn" onClick={() => setGifRange((r) => ({ ...r, out: Math.max(currentTime, r.in + 0.1) }))}>Mark out</button>
            <span style={{ color: "#999" }}>
              GIF range: {gifRange.in.toFixed(2)}s – {gifRange.out.toFixed(2)}s
            </span>
          </div>

          {selected && (
            <div className="vb-style-panel" style={{ marginTop: 10, width: 480 }}>
              <select value={selected.fontFamily} onChange={(e) => updateCaption(selected.id, { fontFamily: e.target.value })}>
                {FONTS.map((f) => (
                  <option key={f} value={f}>{f.split(",")[0]}</option>
                ))}
              </select>
              <input type="range" min={12} max={48} value={selected.fontSize} onChange={(e) => updateCaption(selected.id, { fontSize: Number(e.target.value) })} />
              <input type="color" value={selected.color} onChange={(e) => updateCaption(selected.id, { color: e.target.value })} />
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={`va-align-btn ${selected.align === a ? "active" : ""}`} onClick={() => updateCaption(selected.id, { align: a })}>
                  {a}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="vb-sidebar">
          <button className="vb-add-btn" onClick={addCaption}>+ add caption</button>
          <div className="vb-card-list">
            {captions.map((c) => (
              <div key={c.id} className={`vb-card ${selectedId === c.id ? "selected" : ""}`} onClick={() => setSelectedId(c.id)}>
                <div className="vb-card-top">
                  <span>{c.id}</span>
                  <button onClick={(e) => { e.stopPropagation(); deleteCaption(c.id); }} style={{ background: "transparent", border: "none", color: "#d9534f" }}>✕</button>
                </div>
                <input
                  className="vb-card-text-input"
                  value={c.text}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateCaption(c.id, { text: e.target.value })}
                  style={{ width: "100%", marginTop: 4, background: "#0d0e12", border: "1px solid #2a2b33", color: "#fff", borderRadius: 4, padding: 5, fontSize: 13 }}
                />
                <div className="vb-card-times">
                  <input type="number" step={0.1} value={c.startTime} onClick={(e) => e.stopPropagation()} onChange={(e) => updateCaption(c.id, { startTime: Number(e.target.value) })} />
                  <span style={{ color: "#666" }}>–</span>
                  <input type="number" step={0.1} value={c.endTime} onClick={(e) => e.stopPropagation()} onChange={(e) => updateCaption(c.id, { endTime: Number(e.target.value) })} />
                </div>
              </div>
            ))}
          </div>
          <button className="vb-make-gif" onClick={makeGif}>Make GIF</button>
        </div>
      </div>

      {output && <pre className="output-json">{output}</pre>}
    </div>
  );
}
