// Every emoji of KeepTrack lives in this module, and the drawn code takes them by name (the look gate, scripts/keeptrack-look-check.sh,
// exempts this file from its emoji scan only). Three tables:
// - the band's action icons: each key has its terminal emoji and its desktop SVG, drawn on a 24 px grid with a 2 px stroke, round caps
//   and joins, and `currentColor`, so the icon takes the theme's own text colour on light and dark. The desktop draws the SVG, because an
//   emoji renders as an odd glyph in the Desktop band font; the terminal writes the emoji as text. The pane draws the same keys' emoji as text.
// - the pane's status icons: emoji only, drawn as text on both surfaces (active rows, history, the project counters, the due date).
// - the priority icons: one emoji per priority tag, drawn before the tag.

import type { Priority } from '../types'

export type ActionIconKey =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'waiting'
  | 'mcp'
  | 'shell'
  | 'read'
  | 'edit'
  | 'search'
  | 'web'
  | 'agent'
  | 'tool'
  | 'milestone'
  | 'inProgress'
  | 'noMilestone'
  | 'noIssue'
  | 'noRemote'
  | 'error'

export type StatusIconKey =
  | 'activeWindow'
  | 'activeSession'
  | 'issues'
  | 'sessions'
  | 'history'
  | 'commit'
  | 'pr'
  | 'session'
  | 'done'
  | 'closed'
  | 'due'
  | 'overdue'
  | 'loadFailed'

// The icon's size on the desktop, in CSS pixels: small beside the band's text.
export const ACTION_ICON_SIZE = 14

// The outline of a circle of radius 9 on the 24 px grid, shared by the icons that draw one.
const CIRCLE = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z'

const ICONS: Readonly<Record<ActionIconKey, { emoji: string; paths: readonly string[] }>> = {
  idle: { emoji: '💤', paths: ['M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z'] },
  working: { emoji: '🟢', paths: [CIRCLE, 'M10 8.5v7l5.5-3.5z'] },
  thinking: { emoji: '💭', paths: [CIRCLE, 'M7 12h0', 'M12 12h0', 'M17 12h0'] },
  waiting: { emoji: '⏳', paths: ['M7 3h10', 'M7 21h10', 'M8 3c0 5 8 5 8 9s-8 4-8 9', 'M16 3c0 5-8 5-8 9s8 4 8 9'] },
  mcp: { emoji: '🔌', paths: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z'] },
  shell: { emoji: '💻', paths: ['M4 17l6-6-6-6', 'M12 19h8'] },
  read: { emoji: '📖', paths: ['M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z', 'M20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z'] },
  edit: { emoji: '✏️', paths: ['M4 20l1-4L16 5l3 3L8 19z', 'M14 7l3 3'] },
  search: { emoji: '🔎', paths: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-4-4'] },
  web: { emoji: '🌐', paths: [CIRCLE, 'M3 12h18', 'M12 3c-2.5 3-2.5 15 0 18', 'M12 3c2.5 3 2.5 15 0 18'] },
  agent: { emoji: '🤖', paths: ['M5 8h14v12H5z', 'M12 4v4', 'M9 13h0', 'M15 13h0', 'M9 17h6'] },
  tool: { emoji: '🔧', paths: ['M5 5h14v14H5z'] },
  milestone: { emoji: '🎯', paths: [CIRCLE, 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z', 'M12 12h0'] },
  inProgress: {
    emoji: '🛠️',
    paths: ['M14.5 4.5a4.5 4.5 0 0 0-4.2 6.1L4 17a2 2 0 0 0 3 3l6.4-6.3a4.5 4.5 0 0 0 6.1-4.2l-2.6 2.6-2.8-.8-.8-2.8z'],
  },
  noMilestone: { emoji: '⭕', paths: [CIRCLE] },
  noIssue: {
    emoji: '📭',
    paths: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z'],
  },
  noRemote: { emoji: '🚫', paths: [CIRCLE, 'M5.6 5.6l12.8 12.8'] },
  error: { emoji: '⚠️', paths: ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h0'] },
}

const STATUS_EMOJI: Readonly<Record<StatusIconKey, string>> = {
  activeWindow: '▶️',
  activeSession: '🔄',
  issues: '📋',
  sessions: '🖥️',
  history: '🕘',
  commit: '📝',
  pr: '🔀',
  session: '🚀',
  done: '✅',
  closed: '☑️',
  due: '📅',
  overdue: '⚠️',
  loadFailed: '❌',
}

const PRIORITY_EMOJI: Readonly<Record<Priority, string>> = { P0: '🔴', P1: '🟠', P2: '🟡', P3: '⚪' }

// The emoji of a band action, or of a pane state, as text.
export function actionIconEmoji(key: ActionIconKey): string {
  return ICONS[key].emoji
}

// The desktop's picture for an action, as an SVG source for the `Svg` element, `size` CSS pixels square.
export function actionIconSvg(key: ActionIconKey, size: number = ACTION_ICON_SIZE): string {
  const paths = ICONS[key].paths.map(d => `<path d="${d}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  )
}

// The emoji of a pane status (active rows, history, counters, due date, loading, failure).
export function statusIconEmoji(key: StatusIconKey): string {
  return STATUS_EMOJI[key]
}

// The emoji of a priority tag: P0 red, P1 orange, P2 yellow, P3 white.
export function priorityEmoji(priority: Priority): string {
  return PRIORITY_EMOJI[priority]
}
