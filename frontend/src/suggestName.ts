/** Turns a caption's raw text into a candidate GIF name: strips quote
 * characters (they'd look odd doubled up inside the "Use '…'" link),
 * sentence-cases it, and caps it at 40 characters so it stays a name, not
 * the whole caption. */
export function suggestNameFrom(text: string): string {
  const stripped = text.replace(/["'"'']/g, '').trim()
  if (!stripped) return ''
  const sentenceCased = stripped[0].toUpperCase() + stripped.slice(1).toLowerCase()
  return sentenceCased.length > 40 ? sentenceCased.slice(0, 40).trimEnd() : sentenceCased
}
