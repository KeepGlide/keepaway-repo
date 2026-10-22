// The KeepTrack product mark: concept C, the checkpoint (a Sky milestone ring crossed by the Teal kite, one Coral dot for the
// progress mark). Copied from keepglide-company's brand drafts of 2026-10-21: repo-work-c-checkpoint-mark-only.svg (still) and
// repo-work-c-checkpoint-loading.svg (the same drawing with a spinning ring, SMIL). The concept is provisional: Sophia has not
// picked between A, B and C, so a swap is a change to this file only. The mark keeps its brand colours in both themes, so this
// file is exempt from the look gate's colour check (scripts/keeptrack-look-check.sh), like keepglide.ts.

// The milestone ring and its Coral dot: the drawing the still and the loading mark share.
const RING =
  '<circle cx="512" cy="512" r="300" fill="none" stroke="#9AD9E6" stroke-width="64"/>' + '<circle cx="512" cy="212" r="56" fill="#F2715F"/>'

// The kite, clipped to its own shape so the Coral dots stay inside it.
const KITE =
  '<defs><clipPath id="kite-clip"><path d="M637.4 279.9 L671.7 455.7 L446.6 572.2 L464.2 318.3 Z"/></clipPath></defs>' +
  '<g transform="translate(700 330) scale(1.1) translate(-559.15 -426.05)">' +
  '<path d="M637.4 279.9 L464.2 318.3 L446.6 572.2 Z" fill="#2BB8AE"/>' +
  '<path d="M637.4 279.9 L671.7 455.7 L446.6 572.2 Z" fill="#7EE8DC"/>' +
  '<g clip-path="url(#kite-clip)" fill="#F2715F">' +
  '<circle cx="637.4" cy="279.9" r="43"/><circle cx="464.2" cy="318.3" r="36"/>' +
  '<circle cx="671.7" cy="455.7" r="36"/><circle cx="446.6" cy="572.2" r="74"/>' +
  '</g>' +
  '<g stroke="#3A4766" stroke-width="7" stroke-linecap="round" fill="none">' +
  '<line x1="637.4" y1="279.9" x2="446.6" y2="572.2"/>' +
  '<path d="M464.2 318.3 C602.6 353.3 607.4 378.2 671.7 455.7"/>' +
  '</g></g>'

// The loading mark turns its ring once per 2 s (the file's own markup; its title says 1.8 s).
const SPIN =
  '<animateTransform attributeName="transform" type="rotate" from="0 512 512" to="360 512 512" dur="2s" repeatCount="indefinite"/>'

// The terminal's stand-in for the logo in the pane heading.
export const LOGO_GLYPH = '⎇'

function svgDocument(size: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${body}</svg>`
}

// The still mark as an SVG document for the `Svg` element, `size` CSS pixels square.
export function keepTrackSvg({ size = 16 }: { size?: number } = {}): string {
  return svgDocument(size, `<g>${RING}</g>${KITE}`)
}

// The loading mark: the still mark with its ring turning. Shown while the main loop runs, on the desktop only.
export function keepTrackLoadingSvg({ size = 16 }: { size?: number } = {}): string {
  return svgDocument(size, `<g>${RING}${SPIN}</g>${KITE}`)
}
