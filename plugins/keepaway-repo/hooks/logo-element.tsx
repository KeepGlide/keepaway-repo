// The KeepAway Repo logo as one drawing element, shared by the pane heading and the band row: the SVG on the desktop, the text
// glyph elsewhere. The desktop flag decides, not `'Svg' in ui` alone: the terminal's elements carry an Svg too, drawn empty.
// The KeepGlide mark (a local copy of askaway's) sits at the pane header's right edge, on the desktop only.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { KEEPGLIDE_ALT, keepglideSvg } from './keepglide'
import { LOGO_GLYPH, keepAwaySvg } from './logo'

type Ui = Elements[RenderSurface]

const LOGO_SIZE = 16
const REPO_LOGO_SIZE = 32
// The KeepGlide mark in the pane header: the row's height, as askaway draws it beside its counter.
export const KEEPGLIDE_HEADER_SIZE = 24

// `alt` is the picture's text for a screen reader: the product name, since the heading beside it names the repository.
export function renderKeepAwayLogo(ui: Ui, desktop: boolean, alt: string): RenderElement {
  if (desktop && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="logo" source={keepAwaySvg({ size: LOGO_SIZE })} alt={alt} width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  const { Text } = ui
  return <Text key="logo" bold>{LOGO_GLYPH}</Text>
}

// The band's leading mark: on the desktop the still product mark, in every state (it never turns: a turning loop has no pause,
// WCAG 2.2.2, ux4-13). The terminal draws none: the state icon after it already says running or idle.
export function renderKeepAwayMark(ui: Ui, desktop: boolean): RenderElement | false {
  if (desktop && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key="mark" source={keepAwaySvg({ size: LOGO_SIZE })} alt="" width={LOGO_SIZE} height={LOGO_SIZE} />
  }
  return false
}

// A repo's own logo (repo-logo.ts) beside a root session's title, REPO_LOGO_SIZE pixels square. Desktop only: the terminal draws no picture.
export function renderRepoLogo(ui: Ui, desktop: boolean, source: string, alt: string): RenderElement | false {
  if (!desktop || !('Svg' in ui)) return false
  const { Svg } = ui
  return <Svg key="repo-logo" source={source} alt={alt} width={REPO_LOGO_SIZE} height={REPO_LOGO_SIZE} />
}

// The KeepGlide mark at `size` CSS pixels square. Desktop only: the terminal draws no picture, so it gets false.
export function renderKeepGlide(ui: Ui, desktop: boolean, key: string, size: number): RenderElement | false {
  if (!desktop || !('Svg' in ui)) return false
  const { Svg } = ui
  return <Svg key={key} source={keepglideSvg({ size })} alt={KEEPGLIDE_ALT} width={size} height={size} />
}
