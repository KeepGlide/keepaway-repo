// The rule under the pane header (owner, 2026-11-08): a 1px line across the pane on the desktop, an SVG whose markup is wider than
// any pane, so its slot cuts it to the pane's width; the terminal draws a row of '─' instead (pane.tsx). AskAway User draws the same
// rule under its header (its own divider.ts): the design is shared, the code is copied, not imported. Like logo.ts, this module holds
// its own colour, so the look gate skips it; the colour is AskAway User's divider colour, a hairline on either theme.
const HEADER_RULE_COLOR = '#D1D5DB'
const HEADER_RULE_MARKUP_PX = 4000

// The rule's height in CSS pixels on the desktop, and its length in columns on the terminal, whose render event carries no width.
export const HEADER_RULE_HEIGHT = 1
export const HEADER_RULE_COLUMNS = 40

export const HEADER_RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${HEADER_RULE_MARKUP_PX}" height="${HEADER_RULE_HEIGHT}" ` +
  `viewBox="0 0 ${HEADER_RULE_MARKUP_PX} ${HEADER_RULE_HEIGHT}" preserveAspectRatio="none">` +
  `<rect x="0" y="0" width="${HEADER_RULE_MARKUP_PX}" height="${HEADER_RULE_HEIGHT}" fill="${HEADER_RULE_COLOR}"/></svg>`
