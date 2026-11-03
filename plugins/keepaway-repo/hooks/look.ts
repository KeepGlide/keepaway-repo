import type { Priority } from '../types'

// The pane's look: theme keys and glyphs only, no colour value. The pane takes the engine's own text colours and
// background; the one fill it draws is the details block of this window's row, which takes the engine's user-message
// background (the engine resolves it for the effective theme, light or dark). The emoji of the pane live in
// hooks/action-icons.ts, the one module the look gate exempts from its emoji scan.
export const DETAILS_FILL = 'userMessageBackground' as const

// The mark before a clickable row or link: a small square, drawn dim. With the Desktop's own link look, a clickable
// row reads as a link, as a native one does.
export const LINK_MARK = '▪' as const

// The cells of a milestone's progress bar: filled for the closed share, empty for the rest (plain characters, not emoji).
export const BAR_FILLED = '▰' as const
export const BAR_EMPTY = '▱' as const

// The branch glyphs of the derived rows: a child that is not the last one, and the last child.
export const BRANCH_GLYPH = { middle: '├', last: '└' } as const

// The disclosure marks of the legend's button: closed and open. Text glyphs, not emoji (the look gate scans for emoji only).
export const DISCLOSURE_CLOSED = '▸' as const
export const DISCLOSURE_OPEN = '▾' as const

// The priorities whose issue row draws bold. The look has no colour for it: bold is the emphasis the pane already uses for titles.
export const EMPHASISED_PRIORITIES: readonly Priority[] = ['P0', 'P1']
