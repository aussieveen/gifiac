import type { GifEntry } from "./types";

const COLORS = ["#2b6f6b", "#3a5a8f", "#8f5a3a", "#5a3a8f", "#3a8f5a", "#8f3a5a", "#6b6f2b", "#2b5a6f"];

// Stand-in for real S3-backed GIFs. Real thumbnails/previews come from the
// actual GIF/MP4 files once export + S3 integration are wired up; this
// prototype only needs *something* to browse, search, and act on.
const RAW: Array<[string, string]> = [
  ["Bart shock testing", "and they have the ability to shock– Just testing."],
  ["Homer donut panic", "Mmm... donut. Not the bees!"],
  ["Skinner alternate universe", "Am I out of touch? No, it's the children who are wrong."],
  ["Nelson ha-ha", "Ha-ha!"],
  ["Milhouse everything is going according to plan", "Everything is going according to plan."],
  ["Ralph I'm in danger", "I'm in danger."],
  ["Moe rat's alley", "Ah, you must be from the city."],
  ["Comic Book Guy worst episode ever", "Worst. Episode. Ever."],
  ["Kent Brockman ants", "I, for one, welcome our new insect overlords."],
  ["Flanders okily dokily", "Okily dokily, neighbourino."],
  ["Sideshow Bob rake", "Sideshow Bob steps on a rake."],
  ["Lisa saxophone sadness", "This is the saddest thing I've ever seen."],
];

export function mockGifs(): GifEntry[] {
  return RAW.map(([name, captionText], i) => ({
    id: `gif-${i + 1}`,
    name,
    captionText,
    width: 480,
    height: [270, 360, 480][i % 3],
    createdAt: new Date(2026, 7, 22 - i, 10, 0).toISOString(),
    color: COLORS[i % COLORS.length],
  }));
}

export function fakeUrl(id: string): string {
  return `https://cdn.gifiac.example/gifs/${id}.gif`;
}
