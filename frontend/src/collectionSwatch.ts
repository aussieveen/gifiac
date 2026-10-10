// collections-design/COLLECTIONS.md §2: "derive the colour from the id,
// from a fixed palette of muted tones" — a small fixed set, picked
// deterministically per collection so its swatch doesn't change color
// across reloads/re-fetches. Shared by the sidebar, the "Save to
// collection" picker, and the detail panel's "In collections" chips so
// the same collection always gets the same dot everywhere it appears.
const SWATCH_COLORS = ['#5b9dff', '#f5c518', '#ff7b6b', '#6fcf97', '#bb86fc', '#4dd0e1', '#ffa94d', '#f06595']

export function swatchColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return SWATCH_COLORS[hash % SWATCH_COLORS.length]
}
