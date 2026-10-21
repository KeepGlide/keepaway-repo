// The repo work logo as one drawing element, shared by the pane heading and the band row: the SVG on the desktop, the text
// glyph elsewhere. The desktop flag decides, not `'Svg' in ui` alone: the terminal's elements carry an Svg too, drawn empty.
// The KeepGlide mark (a local copy of askaway's) sits at the pane header's right edge, on the desktop only.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { KEEPGLIDE_ALT, keepglideSvg } from './keepglide'
import { LOGO_GLYPH, repoWorkLoadingSvg, repoWorkSvg } from './logo'

type Ui = Elements[RenderSurface]

const LOGO_SIZE = 16
// The KeepGlide mark in the pane header: the row's height, as askaway draws it beside its counter.
export const KEEPGLIDE_HEADER_SIZE = 24
// The band's leading text glyph on the terminal: running, and idle.
const RUNNING_GLYPH = '▶'
const IDLE_GLYPH = '○'

// `alt` is the picture's text for a screen reader; "" marks it decorative when a line beside it already names the pane.
export function renderRepoWorkLogo(ui: Ui, desktop: boolean, alt: string): RenderElement {
  if (desktop && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="logo" source={repoWorkSvg({ size: LOGO_SIZE })} alt={alt} width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  const { Text } = ui
  return <Text key="logo" bold>{LOGO_GLYPH}</Text>
}

// The reduced-motion choice of the person, read from the page when there is one (the engine may draw without a window).
function prefersReducedMotion(): boolean {
  const scope = globalThis as { matchMedia?: (query: string) => { matches: boolean } }
  return scope.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

// The band's leading mark: on the desktop the product mark, turning while the main loop runs and still when idle or when the
// person asks for reduced motion; on the terminal its text glyph, ▶ running and ○ idle.
export function renderRepoWorkMark(ui: Ui, desktop: boolean, running: boolean): RenderElement {
  if (desktop && 'Svg' in ui) {
    const { Svg } = ui
    const turning = running && !prefersReducedMotion()
    const source = turning ? repoWorkLoadingSvg({ size: LOGO_SIZE }) : repoWorkSvg({ size: LOGO_SIZE })
    return <Svg key="mark" source={source} alt="" width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  const { Text } = ui
  return <Text key="mark" bold>{running ? RUNNING_GLYPH : IDLE_GLYPH}</Text>
}

// The KeepGlide mark at `size` CSS pixels square. Desktop only: the terminal draws no picture, so it gets false.
export function renderKeepGlide(ui: Ui, desktop: boolean, key: string, size: number): RenderElement | false {
  if (!desktop || !('Svg' in ui)) return false
  const { Svg } = ui
  return <Svg key={key} source={keepglideSvg({ size })} alt={KEEPGLIDE_ALT} width={size} height={size} />
}
