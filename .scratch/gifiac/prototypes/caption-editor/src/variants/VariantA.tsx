import { useRef, useState } from "react";
import type { CaptionBlock } from "../types";
import { CLIP_DURATION, FRAME_COUNT, frameColor, initialCaptions, nextCaptionId } from "../mockData";

// Variant A — closest to the Frinkiac reference screenshot: a dedicated
// timeline lane per caption (drag to move, drag edges to resize), a
// separate film-strip scrubber below with its own yellow-highlighted
// in/out range for the GIF export, and a style panel that edits whichever
// caption is currently selected.

const TIMELINE_WIDTH = 700;
const MIN_DURATION = 0.25;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

const FONTS = ["Impact, sans-serif", "Georgia, serif", "system-ui, sans-serif", "'Courier New', monospace"];

export function VariantA() {
  const [captions, setCaptions] = useState<CaptionBlock[]>(initialCaptions);
  const [selectedId, setSelectedId] = useState<string | null>("cap-2");
  const [currentTime, setCurrentTime] = useState(3);
  const [gifRange, setGifRange] = useState({ in: 2, out: 5 });
  const [applyToAll, setApplyToAll] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const dragRef = useRef<{ kind: string; id: string; startX: number; orig: CaptionBlock } | null>(null);
  const rangeDragRef = useRef<{ edge: "in" | "out"; startX: number; orig: number } | null>(null);

  const selected = captions.find((c) => c.id === selectedId) ?? null;

  function timeToX(t: number) {
    return (t / CLIP_DURATION) * TIMELINE_WIDTH;
  }
  function xToTime(x: number) {
    return clamp((x / TIMELINE_WIDTH) * CLIP_DURATION, 0, CLIP_DURATION);
  }

  function updateCaption(id: string, patch: Partial<CaptionBlock>) {
    setCaptions((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function startPillDrag(e: React.MouseEvent, id: string, kind: "move" | "left" | "right") {
    e.stopPropagation();
    const cap = captions.find((c) => c.id === id)!;
    setSelectedId(id);
    dragRef.current = { kind, id, startX: e.clientX, orig: cap };
    window.addEventListener("mousemove", onPillDrag);
    window.addEventListener("mouseup", endPillDrag);
  }

  function onPillDrag(e: MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaT = ((e.clientX - drag.startX) / TIMELINE_WIDTH) * CLIP_DURATION;
    if (drag.kind === "move") {
      const dur = drag.orig.endTime - drag.orig.startTime;
      let newStart = clamp(drag.orig.startTime + deltaT, 0, CLIP_DURATION - dur);
      updateCaption(drag.id, { startTime: newStart, endTime: newStart + dur });
    } else if (drag.kind === "left") {
      const newStart = clamp(drag.orig.startTime + deltaT, 0, drag.orig.endTime - MIN_DURATION);
      updateCaption(drag.id, { startTime: newStart });
    } else if (drag.kind === "right") {
      const newEnd = clamp(drag.orig.endTime + deltaT, drag.orig.startTime + MIN_DURATION, CLIP_DURATION);
      updateCaption(drag.id, { endTime: newEnd });
    }
  }

  function endPillDrag() {
    dragRef.current = null;
    window.removeEventListener("mousemove", onPillDrag);
    window.removeEventListener("mouseup", endPillDrag);
  }

  function startRangeDrag(e: React.MouseEvent, edge: "in" | "out") {
    e.stopPropagation();
    rangeDragRef.current = { edge, startX: e.clientX, orig: gifRange[edge] };
    window.addEventListener("mousemove", onRangeDrag);
    window.addEventListener("mouseup", endRangeDrag);
  }

  function onRangeDrag(e: MouseEvent) {
    const drag = rangeDragRef.current;
    if (!drag) return;
    const deltaT = ((e.clientX - drag.startX) / TIMELINE_WIDTH) * CLIP_DURATION;
    const newVal = clamp(drag.orig + deltaT, 0, CLIP_DURATION);
    setGifRange((r) =>
      drag.edge === "in" ? { in: Math.min(newVal, r.out - 0.1), out: r.out } : { in: r.in, out: Math.max(newVal, r.in + 0.1) }
    );
  }

  function endRangeDrag() {
    rangeDragRef.current = null;
    window.removeEventListener("mousemove", onRangeDrag);
    window.removeEventListener("mouseup", endRangeDrag);
  }

  function scrubTo(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setCurrentTime(xToTime(e.clientX - rect.left));
  }

  function addCaption() {
    const id = nextCaptionId();
    const start = currentTime;
    const end = clamp(start + 1, 0, CLIP_DURATION);
    setCaptions((cs) => [
      ...cs,
      { id, startTime: start, endTime: end, text: "New caption", fontFamily: FONTS[0], fontSize: 24, color: "#ffffff", align: "center", x: 0.5, y: 0.88 },
    ]);
    setSelectedId(id);
  }

  function deleteCaption(id: string) {
    setCaptions((cs) => cs.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function patchStyle(patch: Partial<CaptionBlock>) {
    if (!selected) return;
    if (applyToAll) {
      setCaptions((cs) => cs.map((c) => ({ ...c, ...patch })));
    } else {
      updateCaption(selected.id, patch);
    }
  }

  const activeCaptions = captions.filter((c) => currentTime >= c.startTime && currentTime <= c.endTime);
  const currentFrame = Math.min(FRAME_COUNT - 1, Math.floor((currentTime / CLIP_DURATION) * FRAME_COUNT));

  function makeGif() {
    const payload = {
      gifRange,
      captions: captions.map(({ id, startTime, endTime, text, fontFamily, fontSize, color, align }) => ({
        id, startTime: Number(startTime.toFixed(2)), endTime: Number(endTime.toFixed(2)), text, fontFamily, fontSize, color, align,
      })),
    };
    setOutput(JSON.stringify(payload, null, 2));
    console.log("Make GIF payload", payload);
  }

  return (
    <div className="page">
      <h1>Gifiac — Caption editor (Variant A)</h1>
      <p className="subtitle">Timeline lanes, Frinkiac-faithful. Drag pills to move, edges to resize.</p>

      <div className="va-top">
        <div className="preview-frame" style={{ background: frameColor(currentFrame) }}>
          <span>frame {currentFrame + 1}/{FRAME_COUNT} · t={currentTime.toFixed(2)}s</span>
          {activeCaptions.map((c) => (
            <div
              key={c.id}
              className="preview-caption"
              style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, fontFamily: c.fontFamily, fontSize: c.fontSize, color: c.color, textAlign: c.align }}
            >
              {c.text}
            </div>
          ))}
        </div>

        <div className="va-style-panel">
          {selected ? (
            <>
              <textarea value={selected.text} onChange={(e) => patchStyle({ text: e.target.value })} />
              <div className="va-style-row">
                <select value={selected.fontFamily} onChange={(e) => patchStyle({ fontFamily: e.target.value })}>
                  {FONTS.map((f) => (
                    <option key={f} value={f}>{f.split(",")[0]}</option>
                  ))}
                </select>
                <input type="range" min={12} max={48} value={selected.fontSize} onChange={(e) => patchStyle({ fontSize: Number(e.target.value) })} />
                <span style={{ fontSize: 11, color: "#999" }}>{selected.fontSize}px</span>
              </div>
              <div className="va-style-row">
                <input type="color" value={selected.color} onChange={(e) => patchStyle({ color: e.target.value })} />
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} className={`va-align-btn ${selected.align === a ? "active" : ""}`} onClick={() => patchStyle({ align: a })}>
                    {a}
                  </button>
                ))}
              </div>
              <label style={{ fontSize: 12, color: "#999" }}>
                <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} /> All tracks
              </label>
            </>
          ) : (
            <span style={{ color: "#666", fontSize: 13 }}>Select a caption track to edit its style.</span>
          )}
        </div>
      </div>

      <div className="va-timeline" style={{ width: TIMELINE_WIDTH + 40 }}>
        {captions.map((c) => (
          <div key={c.id} className="va-track-row" style={{ width: TIMELINE_WIDTH }}>
            <div
              className={`va-track-pill ${selectedId === c.id ? "selected" : ""}`}
              style={{ left: timeToX(c.startTime), width: Math.max(4, timeToX(c.endTime) - timeToX(c.startTime)) }}
              onMouseDown={(e) => startPillDrag(e, c.id, "move")}
              onClick={() => setSelectedId(c.id)}
            >
              {c.text}
              <div className="va-track-handle left" onMouseDown={(e) => startPillDrag(e, c.id, "left")} />
              <div className="va-track-handle right" onMouseDown={(e) => startPillDrag(e, c.id, "right")} />
            </div>
            <button className="va-track-delete" onClick={() => deleteCaption(c.id)}>✕</button>
          </div>
        ))}
        <button className="va-add-track" onClick={addCaption}>+ add caption at playhead</button>

        <div className="va-filmstrip-wrap">
          <div className="va-filmstrip" style={{ width: TIMELINE_WIDTH }} onClick={scrubTo}>
            {Array.from({ length: FRAME_COUNT }).map((_, i) => (
              <div key={i} className="va-frame" style={{ background: frameColor(i) }} />
            ))}
            <div
              className="va-range-highlight"
              style={{ left: timeToX(gifRange.in), width: timeToX(gifRange.out) - timeToX(gifRange.in) }}
            >
              <div className="va-range-handle" style={{ left: -5 }} onMouseDown={(e) => startRangeDrag(e, "in")} />
              <div className="va-range-handle" style={{ right: -5 }} onMouseDown={(e) => startRangeDrag(e, "out")} />
            </div>
            <div className="va-playhead" style={{ left: timeToX(currentTime) }} />
          </div>
        </div>

        <div className="va-controls">
          <button className="va-btn">🔍−</button>
          <button className="va-btn">🔍+</button>
          <button className="va-btn">Detect loop</button>
          <span style={{ fontSize: 12, color: "#999" }}>
            GIF range: {gifRange.in.toFixed(2)}s – {gifRange.out.toFixed(2)}s ({(gifRange.out - gifRange.in).toFixed(2)}s)
          </span>
          <button className="va-make-gif" onClick={makeGif}>Make GIF</button>
        </div>
      </div>

      {output && <pre className="output-json">{output}</pre>}
    </div>
  );
}
