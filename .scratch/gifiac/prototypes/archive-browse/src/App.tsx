import { useState } from "react";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import { VariantA } from "./variants/VariantA";
import { VariantB } from "./variants/VariantB";
import { VariantC } from "./variants/VariantC";

// PROTOTYPE — throwaway. Answers: "Archive/browse UX" (Gifiac wayfinder map).
// Three structurally different takes on the archive/library view. Switch
// with the bottom bar or ← / → arrow keys.

const VARIANTS = [
  { key: "A", label: "Card grid (hover actions)" },
  { key: "B", label: "Data list (explicit actions)" },
  { key: "C", label: "Grid + detail panel" },
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
