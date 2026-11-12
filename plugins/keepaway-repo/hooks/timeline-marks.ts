// The timeline's markers on the desktop (owner's mocks of 2026-11-08, SPEC section 24): a circle on the line with a white icon inside for
// a typed event, filled with its kind's colour (option C of the markers mock), a green circle for the step in progress, and a plain dark
// dot for any other step. Like logo.ts and keepglide.ts, this module holds the colours of its own drawings, so the look gate skips it; the
// drawn code takes the marks by kind.

// The kinds a timeline row is marked as.
export type MarkKind = 'now' | 'release' | 'commit' | 'test' | 'pr' | 'session' | 'step'

// The marker's size in CSS pixels; a plain step's dot is drawn smaller inside the same box, so every row keeps its line in one place.
export const TIMELINE_MARK_SIZE = 26

const STEP_FILL = '#1f2937'
const NOW_FILL = '#16a34a'
const ICON = '#ffffff'
// A light ring keeps the dark step dot visible on a dark pane; a typed marker's white ring sets its colour off the line.
const RING = '#e5e7eb'
// The icon's share of the circle and its stroke, in the 24 x 24 box.
const ICON_SCALE = 0.72
const ICON_STROKE = 2.6

type TypedKind = Exclude<MarkKind, 'now' | 'step'>

// Each typed kind's fill, so the kind reads before the icon does.
const KIND_FILL: Readonly<Record<TypedKind, string>> = {
  release: '#7c3aed',
  commit: '#2563eb',
  test: '#d97706',
  pr: '#db2777',
  session: '#0d9488',
}

// Each icon's strokes, in a 24 x 24 box centred in the circle.
const ICON_PATHS: Readonly<Record<TypedKind, string>> = {
  release: '<path d="M4 12.5V5h7.5L19 12.5 12.5 19z"/><circle cx="8.5" cy="8.5" r="1.3" fill="' + ICON + '"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3.5 12h5M15.5 12h5"/>',
  test: '<path d="M9.5 4h5M10.5 4v5.5L5.5 18a1.5 1.5 0 0 0 1.3 2.2h10.4a1.5 1.5 0 0 0 1.3-2.2l-5-8.5V4"/><path d="M8 15h8"/>',
  pr: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M7 8v8M17 16V10a3 3 0 0 0-3-3h-3"/>',
  session: '<path d="M12 20v-8M12 12c0-4 3-6 7-6 0 4-3 6-7 6zM12 15c0-3-2.5-5-6-5 0 3 2.5 5 6 5z"/>',
}

// The SVG document of one marker.
export function timelineMarkSvg(kind: MarkKind): string {
  const size = TIMELINE_MARK_SIZE
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">`
  if (kind === 'step') return `${open}<circle cx="12" cy="12" r="5" fill="${STEP_FILL}" stroke="${RING}" stroke-width="1"/></svg>`
  if (kind === 'now') return `${open}<circle cx="12" cy="12" r="11" fill="${NOW_FILL}"/><circle cx="12" cy="12" r="4" fill="${ICON}"/></svg>`
  const offset = 12 - 12 * ICON_SCALE
  const icon =
    `<g transform="translate(${offset} ${offset}) scale(${ICON_SCALE})" fill="none" stroke="${ICON}" stroke-width="${ICON_STROKE}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[kind]}</g>`
  return `${open}<circle cx="12" cy="12" r="11" fill="${KIND_FILL[kind]}" stroke="${ICON}" stroke-width="1"/>${icon}</svg>`
}

// What each marker says to a reader that cannot see it.
export const MARK_ALT: Readonly<Record<MarkKind, string>> = {
  now: 'in progress',
  release: 'release',
  commit: 'commit',
  test: 'test',
  pr: 'pull request',
  session: 'session',
  step: 'step',
}
