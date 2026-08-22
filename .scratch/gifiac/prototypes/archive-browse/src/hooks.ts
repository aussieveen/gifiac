import { useEffect, useRef, useState } from "react";
import { fakeUrl } from "./mockData";

const SHADES = ["", "22", "44", ""]; // cycles opacity-ish via hex alpha suffix, simulating motion

// Lower-level: cycles whenever `active` is true, regardless of what
// controls `active` (hover, selection, always-on, etc).
export function useColorCycle(baseColor: string, active: boolean) {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      intervalRef.current = window.setInterval(() => setFrame((f) => (f + 1) % SHADES.length), 180);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setFrame(0);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [active]);

  return baseColor + SHADES[frame];
}

// Hover-gated cycling, for grid cards that only animate on hover.
export function useHoverCycle(baseColor: string) {
  const [hovering, setHovering] = useState(false);
  const color = useColorCycle(baseColor, hovering);

  return {
    color,
    onMouseEnter: () => setHovering(true),
    onMouseLeave: () => setHovering(false),
    hovering,
  };
}

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  function show(msg: string) {
    setMessage(msg);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setMessage(null), 1600);
  }

  return { message, show };
}

export function copyLink(id: string, show: (m: string) => void) {
  const url = fakeUrl(id);
  navigator.clipboard.writeText(url).then(
    () => show(`Copied link: ${url}`),
    () => show(`Copy failed — ${url}`)
  );
}

export function download(id: string, name: string, show: (m: string) => void) {
  console.log(`Would download ${name}.gif (${id})`);
  show(`Downloading ${name}.gif…`);
}
