/** Inline stroke SVG icons, sized/stroked to match (24px viewBox, 2.5px
 * stroke, round caps) so they drop in consistently wherever the redesign
 * calls for one — replacing the emoji (🔗, 🔒, ⬇️, 🔍, etc.) the app used
 * as icons before. `currentColor` throughout so each one inherits its
 * button's text color for free (including on hover/disabled). */

export interface IconProps {
  size?: number
  className?: string
}

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function LogInIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  )
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

export function LinkIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M10 14a4.8 4.8 0 0 0 7 0l3-3a4.95 4.95 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 10a4.8 4.8 0 0 0-7 0l-3 3a4.95 4.95 0 0 0 7 7l1.5-1.5" />
    </svg>
  )
}

export function LockIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

export function DownloadIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  )
}

export function ExternalLinkIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
    </svg>
  )
}

export function TrashIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

export function CodeIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M8 6l-6 6 6 6" />
      <path d="M16 6l6 6-6 6" />
    </svg>
  )
}

export function ArrowLeftIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M19 12H5" />
      <path d="M11 18l-6-6 6-6" />
    </svg>
  )
}

export function MinusIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M5 12h14" />
    </svg>
  )
}

/** A small filled diamond — the caption-in/caption-out buttons' icon,
 * echoing the timeline playhead's own diamond grip. */
export function PlayheadIcon({ size = 12, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width={size} height={size} className={className}>
      <path d="M12 2l10 10-10 10L2 12z" />
    </svg>
  )
}

export function PlayIcon({ size = 18, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width={size} height={size} className={className}>
      <path d="M6 3l16 9-16 9z" />
    </svg>
  )
}

export function PauseIcon({ size = 18, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width={size} height={size} className={className}>
      <rect x="5" y="3" width="5" height="18" rx="1" />
      <rect x="14" y="3" width="5" height="18" rx="1" />
    </svg>
  )
}

export function AlignLeftIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  )
}

export function AlignCenterIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M4 6h16M7 12h10M5.5 18h13" />
    </svg>
  )
}

export function AlignRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M4 6h16M10 12h10M7 18h13" />
    </svg>
  )
}

export function XIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

/** A saved-template badge (video picker card) — a bookmark, not the
 * clipboard emoji the app used to mark it with. */
export function BookmarkIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base} width={size} height={size} className={className}>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  )
}
