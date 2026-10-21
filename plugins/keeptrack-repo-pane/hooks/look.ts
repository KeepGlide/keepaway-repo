import type { SessionNode } from '../types'

// The pane's look: theme keys and glyphs only, no colour value. The pane takes the engine's own text colours and
// background; the one fill it draws is the details block of this window's row, which takes the engine's user-message
// background (the engine resolves it for the effective theme, light or dark).
export const DETAILS_FILL = 'userMessageBackground' as const

// The mark before a clickable row or link: a small square, drawn dim. With the Desktop's own link look, a clickable
// row reads as a link, as a native one does.
export const LINK_MARK = '▪' as const

// The state glyph of a session row (DESIGN D7): working, idle, waiting for the person.
export const STATE_GLYPH: Readonly<Record<SessionNode['state'], string>> = { working: '●', idle: '○', waiting: '◐' }

// The branch glyphs of the derived rows: a child that is not the last one, and the last child.
export const BRANCH_GLYPH = { middle: '├', last: '└' } as const
