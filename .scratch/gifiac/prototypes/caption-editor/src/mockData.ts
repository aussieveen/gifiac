import type { CaptionBlock } from "./types";

// Stand-in for a real uploaded clip. Real ingest/probing decided in the
// Video ingest design ticket; this prototype only needs *a* duration to
// build the timeline/scrubber interactions against.
export const CLIP_DURATION = 8; // seconds

// The open question this prototype exists partly to settle: how many
// frames does the film-strip need, and at what interval? This mock uses
// one frame every 0.25s (32 frames for an 8s clip) as a starting guess —
// react to whether that's the right density.
export const FRAME_INTERVAL = 0.25;
export const FRAME_COUNT = Math.round(CLIP_DURATION / FRAME_INTERVAL);

const PALETTE = ["#2b6f6b", "#3a5a8f", "#8f5a3a", "#5a3a8f", "#3a8f5a", "#8f3a5a"];

export function frameColor(frameIndex: number): string {
  // Simulates scene changes so the strip doesn't look uniform.
  const scene = Math.floor(frameIndex / 6) % PALETTE.length;
  return PALETTE[scene];
}

export function initialCaptions(): CaptionBlock[] {
  return [
    {
      id: "cap-1",
      startTime: 0.5,
      endTime: 2.5,
      text: "and they have the ability to shock–",
      fontFamily: "Impact, sans-serif",
      fontSize: 28,
      color: "#ffffff",
      align: "center",
      x: 0.5,
      y: 0.88,
    },
    {
      id: "cap-2",
      startTime: 2.75,
      endTime: 4.25,
      text: "Just testing.",
      fontFamily: "Impact, sans-serif",
      fontSize: 28,
      color: "#ffffff",
      align: "center",
      x: 0.5,
      y: 0.88,
    },
    {
      id: "cap-3",
      startTime: 4.5,
      endTime: 5.5,
      text: "Whoa!",
      fontFamily: "Impact, sans-serif",
      fontSize: 28,
      color: "#ffffff",
      align: "center",
      x: 0.5,
      y: 0.88,
    },
  ];
}

let counter = 100;
export function nextCaptionId(): string {
  counter += 1;
  return `cap-${counter}`;
}
