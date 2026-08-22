export interface CaptionBlock {
  id: string;
  startTime: number; // seconds, relative to clip start
  endTime: number; // seconds
  text: string;
  fontFamily: string;
  fontSize: number; // px, relative to the preview frame's native size
  color: string; // hex
  align: "left" | "center" | "right";
  x: number; // 0-1 horizontal position fraction within the frame
  y: number; // 0-1 vertical position fraction within the frame
}
