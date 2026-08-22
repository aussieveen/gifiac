import { useEffect } from "react";

export interface VariantMeta {
  key: string;
  label: string;
}

interface Props {
  variants: VariantMeta[];
  current: string;
  onChange: (key: string) => void;
}

export function PrototypeSwitcher({ variants, current, onChange }: Props) {
  const index = variants.findIndex((v) => v.key === current);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    }
    function cycle(dir: number) {
      const next = (index + dir + variants.length) % variants.length;
      onChange(variants[next].key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, variants, onChange]);

  const meta = variants[index];

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#111",
        border: "1px solid #f5c518",
        borderRadius: 999,
        padding: "8px 16px",
        boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
        zIndex: 9999,
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        color: "#f5c518",
      }}
    >
      <button
        onClick={() => onChange(variants[(index - 1 + variants.length) % variants.length].key)}
        style={arrowStyle}
      >
        ←
      </button>
      <span style={{ minWidth: 220, textAlign: "center" }}>
        <strong>{meta.key}</strong> — {meta.label}
      </span>
      <button
        onClick={() => onChange(variants[(index + 1) % variants.length].key)}
        style={arrowStyle}
      >
        →
      </button>
    </div>
  );
}

const arrowStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #f5c518",
  color: "#f5c518",
  borderRadius: "50%",
  width: 28,
  height: 28,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};
