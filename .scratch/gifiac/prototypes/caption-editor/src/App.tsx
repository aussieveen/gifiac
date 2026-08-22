import { useState } from "react";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { VariantA } from "./variants/VariantA";
import { VariantB } from "./variants/VariantB";
import { VariantC } from "./variants/VariantC";

// PROTOTYPE — throwaway. Answers: "Caption editor UX" (Gifiac wayfinder map).
// Three structurally different takes on the Frinkiac-style timeline caption
// editor. Switch with the bottom bar or ← / → arrow keys.

const VARIANTS = [
  { key: "A", label: "Timeline lanes (Frinkiac-faithful)" },
  { key: "B", label: "Canvas drag + list (no lanes)" },
  { key: "C", label: "Storyboard grid + cards" },
];

export default function App() {
  const [variant, setVariant] = useState<string>(
    () => new URLSearchParams(window.location.search).get("variant") ?? "A"
  );

  function change(key: string) {
    setVariant(key);
    const params = new URLSearchParams(window.location.search);
    params.set("variant", key);
    window.history.replaceState(null, "", `?${params.toString()}`);
  }

  return (
    <>
      {variant === "A" && <VariantA />}
      {variant === "B" && <VariantB />}
      {variant === "C" && <VariantC />}
      <PrototypeSwitcher variants={VARIANTS} current={variant} onChange={change} />
    </>
  );
}
