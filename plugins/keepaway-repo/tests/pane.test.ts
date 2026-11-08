import { expect, test } from 'claude-code/testing'
import { clockOf, dateOf, daysUntilDue, isDueSoon, isOverdue, markOf, progressBarOf, renderPane, type PaneContext } from '../hooks/pane'
import { TIMELINE_MARK_SIZE, timelineMarkSvg, type MarkKind } from '../hooks/timeline-marks'
import { priorityEmoji, statusIconEmoji } from '../hooks/action-icons'
import { TEXT_MAX, WORKING_WINDOW_MS, buildTree, groupIssues, type DesktopGroups } from '../hooks/model'
import { t } from '../hooks/i18n'
import { DETAILS_FILL, DISCLOSURE_CLOSED, DISCLOSURE_OPEN } from '../hooks/look'
import { heldButtons } from '../hooks/held'
import type { Issue, Milestone, PaneError, SessionInput, SessionNode, Snapshot, TimelineEvent } from '../types'
import {
  HOUR,
  MINUTE,
  NOW,
  SAMPLE_ISSUE_FACTS,
  SAMPLE_ISSUES,
  SAMPLE_LINKED,
  SAMPLE_MILESTONES,
  SAMPLE_THIS_ISSUE,
  makeRecord,
  sampleSessions,
} from './fixtures/sample'

// The element table of a surface: each constructor returns the element it was given as plain data, so the tree can be read.
type Drawn = { tag: string; props: Record<string, unknown> }
const fakeElement = (tag: string) => (props: Record<string, unknown>): Drawn => ({ tag, props })
const DESKTOP = {
  Box: fakeElement('Box'),
  Button: fakeElement('Button'),
  Text: fakeElement('Text'),
  Markdown: fakeElement('Markdown'),
  Svg: fakeElement('Svg'),
}
const TERMINAL = { Box: fakeElement('Box'), Button: fakeElement('Button'), Text: fakeElement('Text') }

const SIX_TITLES = [
  'Synthetic session one',
  'Synthetic fork',
  'Synthetic session three',
  'Synthetic session four',
  'Synthetic docs',
  'Synthetic spawn',
]
const THIS_WINDOW = 'local_7f3a0001'

// Every element of a drawn tree, depth first, the root included.
const nodesOf = (node: unknown): Drawn[] => {
  if (Array.isArray(node)) return node.flatMap(nodesOf)
  if (typeof node !== 'object' || node === null) return []
  const drawn = node as Drawn
  return [drawn, ...nodesOf(drawn.props.children)]
}

// The text of a node's children, nested strings joined.
const textOf = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object' || node === null) return ''
  return textOf((node as Drawn).props.children)
}

// A Markdown text read as its label: the markup and the link target gone, the escapes undone.
const plainMarkdown = (markdown: string): string =>
  markdown.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\(.)/g, '$1')

// The indent above the element with this key: the paddingLeft of every box that holds it, added up (W1).
function indentBefore(node: unknown, key: string, inherited = 0): number | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = indentBefore(child, key, inherited)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null) return undefined
  const drawn = node as Drawn
  if (drawn.props.key === key) return inherited
  const padding = typeof drawn.props.paddingLeft === 'number' ? drawn.props.paddingLeft : 0
  return indentBefore(drawn.props.children, key, inherited + padding)
}

// The texts of some drawn nodes, in order: one per Text, and one per Markdown block (its label).
const textsOfNodes = (nodes: Drawn[]): string[] =>
  nodes.flatMap(node => {
    if (node.tag === 'Text') return [textOf(node.props.children)]
    if (node.tag === 'Markdown') return [plainMarkdown(String(node.props.text))]
    return []
  })

// Every text drawn, in order.
const drawnTexts = (tree: unknown): string[] => textsOfNodes(nodesOf(tree))

// The desktop line's rows as [time, title]: each row's Markdown reads **time** *title*, the title linked when it has a page.
const lineRowsOf = (tree: unknown): string[][] =>
  nodesOf(tree)
    .filter(node => node.tag === 'Markdown' && String(node.props.key).startsWith('tl-title-'))
    .map(node => {
      const [, time = '', title = ''] = /^\*\*(.*?)\*\* \*(.*)\*$/s.exec(String(node.props.text)) ?? []
      return [plainMarkdown(time), plainMarkdown(title)]
    })
const lineTitlesOf = (tree: unknown): string[] => lineRowsOf(tree).map(([, title = '']) => title)

// The Markdown blocks whose raw text carries a session link (`](#local_...)`).
const sessionLinksIn = (tree: unknown): string[] =>
  nodesOf(tree)
    .filter(node => node.tag === 'Markdown' && String(node.props.text).includes('](#local_'))
    .map(node => String(node.props.text))

// The element drawn with this key, if any.
const keyed = (tree: unknown, key: string): Drawn | undefined => nodesOf(tree).find(node => node.props.key === key)

// The drawn texts without the footer legend: the assertions on the body's rows and lines read these. The legend's own nodes are
// skipped by identity, so a body text that equals a legend icon (the commit emoji, say) is still read.
const bodyTextsOf = (tree: unknown): string[] => {
  const legend = new Set<Drawn>(nodesOf(keyed(tree, 'legend')))
  return textsOfNodes(nodesOf(tree).filter(node => !legend.has(node)))
}

function snapshotWith(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: NOW - 2 * MINUTE,
    mode: 'github',
    repo: { owner: 'synthetic-owner', name: 'synthetic-repo' },
    sessions: buildTree(sampleSessions(), {
      now: NOW,
      cutoffMs: 24 * HOUR,
      thisCliSessionId: 'cli-this',
      issueFacts: SAMPLE_ISSUE_FACTS,
    }),
    milestones: SAMPLE_MILESTONES,
    issueGroups: groupIssues(SAMPLE_MILESTONES, SAMPLE_ISSUES, SAMPLE_LINKED, false),
    openIssueCount: SAMPLE_ISSUES.length,
    thisIssue: SAMPLE_THIS_ISSUE,
    unreadableCount: 0,
    errors: [],
    stale: false,
    truncated: false,
    truncatedLimits: [],
    ...overrides,
  }
}

function contextWith(surface: string, overrides: Partial<PaneContext> = {}): PaneContext {
  return {
    snapshot: snapshotWith(),
    lang: 'en',
    surface,
    utcOffsetMinutes: 0,
    legendOpen: false,
    onLegendToggle: () => {},
    held: heldButtons(),
    ...overrides,
  }
}

const drawDesktop = (overrides: Partial<PaneContext> = {}) =>
  renderPane(DESKTOP as never, contextWith('desktop', overrides))
const drawTerminal = (overrides: Partial<PaneContext> = {}) =>
  renderPane(TERMINAL as never, contextWith('terminal', overrides))

test('this window is the first session, in one highlighted block with its details and timeline', () => {
  const tree = drawDesktop()
  const texts = drawnTexts(tree)
  const firstTitle = texts.findIndex(text => text.startsWith('Synthetic session one'))
  const fork = texts.findIndex(text => text.startsWith('Synthetic fork'))
  expect(firstTitle).toBeGreaterThan(-1)
  expect(firstTitle < fork).toBe(true)

  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(block !== undefined).toBe(true)
  const blockTexts = drawnTexts(block)
  expect(texts).toContain('Synthetic session one 🟢')
  expect(blockTexts).toContain('State:')
  expect(blockTexts).toContain('working')
  expect(blockTexts).toContain('Branch:')
  expect(blockTexts).toContain('fix/guard-write-sites')
  expect(blockTexts).toContain('Last commit:')
  expect(blockTexts.some(text => /^fix\(store\): map ENOSPC at backup_receipt writes · .+ ago$/.test(text))).toBe(true)
  expect(blockTexts).toContain('Started:')
  // The fixture's start is over a day old, so the date comes with the clock (ux-9).
  expect(blockTexts.some(text => /^\d{4}-\d\d-\d\d \d\d:\d\d · .+ ago$/.test(text))).toBe(true)
})

test('the details of this window follow the breadcrumb, in the order of the mock, then the timeline and the GitHub link', () => {
  const block = nodesOf(drawDesktop()).find(node => node.props.backgroundColor === DETAILS_FILL)
  const blockTexts = drawnTexts(block)
  const labels = ['State:', 'Branch:', 'PR:', 'Last commit:', 'Checks:', 'Last comment:', 'Next step:', 'Started:']
  const positions = labels.map(label => blockTexts.indexOf(label))
  expect(positions.every(position => position > -1)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  expect(blockTexts.indexOf('🛠️ #106 · Milestone B') < (positions[0] ?? -1)).toBe(true)
  expect(blockTexts).toContain('no PR')
  expect(blockTexts).toContain('no CI')
  expect(blockTexts).toContain('no next step')
  expect(blockTexts.some(text => /^dev-one · .+ ago · keep \*this\* \[markup\]\(x\) as text$/.test(text))).toBe(true)
  expect(blockTexts.indexOf('▪ Open #106 on GitHub ↗')).toBe(blockTexts.length - 1)
})

// With no next step recorded, the row names that state in words, not a dash (ux4-21).
test('the next step row says no next step in English and nenhum registrado in pt-BR', () => {
  for (const [lang, words] of [
    ['en', 'no next step'],
    ['pt', 'nenhum registrado'],
  ] as const) {
    const block = nodesOf(drawDesktop({ lang })).find(node => node.props.backgroundColor === DETAILS_FILL)
    expect(drawnTexts(block)).toContain(words)
  }
})

// With no session listed the pane draws no session block, so no blank line doubles up (rev-g1-13).
test('with no session listed the pane draws no empty session block, in both languages', () => {
  for (const lang of ['en', 'pt'] as const) {
    const tree = drawDesktop({ lang, snapshot: snapshotWith({ sessions: [] }) })
    const emptyBoxes = nodesOf(tree).filter(node => node.tag === 'Box' && [node.props.children].flat(Infinity).filter(Boolean).length === 0)
    expect(emptyBoxes.map(node => node.props.key)).toEqual([])
  }
})

// The header (owner, 2026-11-08): the heading names the window's repository, its owner muted; the logo's alt names the product.
test('the header heading is the repository name with its owner muted, and the logo alt is the product name', () => {
  const tree = drawDesktop()
  expect(keyed(tree, 'logo')?.props.alt).toBe('KeepAway Repo')
  expect(textOf(keyed(tree, 'repo'))).toBe('synthetic-repo')
  expect(keyed(tree, 'owner')?.props.dimColor).toBe(true)
  expect(textOf(keyed(tree, 'owner'))).toBe('synthetic-owner')
  expect(drawnTexts(drawTerminal())).toContain('synthetic-repo')
})

test('with no repository known, the header heading is the product name', () => {
  for (const lang of ['en', 'pt'] as const) {
    const heading = keyed(drawDesktop({ lang, snapshot: snapshotWith({ repo: null, mode: 'no-github' }) }), 'heading')
    expect(textOf(heading)).toBe('KeepAway Repo')
  }
})

// Session events in the timeline use their own glyph, not the link mark or the commit dot (ux4-20).
test('a session event in the timeline is drawn with the diamond glyph on the terminal and the session marker on the desktop line', () => {
  const glyphs = nodesOf(drawTerminal())
    .filter(node => node.props.key === 'glyph')
    .map(node => textOf(node.props.children))
  expect(glyphs).toContain('🚀')
  expect(glyphs).not.toContain('▪')
  const marks = nodesOf(drawDesktop()).filter(node => node.tag === 'Svg' && String(node.props.key).startsWith('mark-local_'))
  expect(marks.map(node => node.props.alt)).toContain('session')
  expect(nodesOf(drawDesktop()).some(node => node.props.key === 'glyph')).toBe(false)
})

test('the GitHub link of this window is a Markdown https link on the desktop and plain text on the terminal', () => {
  const desktopBlock = nodesOf(drawDesktop()).find(node => node.props.backgroundColor === DETAILS_FILL)
  // The window's own session link is its title, the first line of the block.
  expect(sessionLinksIn(desktopBlock).length).toBe(1)
  expect(drawnTexts(desktopBlock)).toContain('▪ Open #106 on GitHub ↗')
  expect(nodesOf(desktopBlock).some(node => node.tag === 'Markdown' && String(node.props.text) === '▪ [Open #106 on GitHub ↗](https://github.com/synthetic-owner/synthetic-repo/issues/106)')).toBe(true)

  const terminalTexts = drawnTexts(drawTerminal())
  // Nothing opens on the terminal, so the line carries no arrow (ux-7).
  expect(terminalTexts).toContain('▪ Open #106 on GitHub')
  expect(terminalTexts).not.toContain('▪ Open #106 on GitHub ↗')
  expect(terminalTexts.some(text => text.includes('https://'))).toBe(false)
})

test('the breadcrumb carries the issue, its milestone and the origin; a window with no issue has no details and no link', () => {
  const texts = drawnTexts(drawDesktop())
  expect(texts).toContain('🛠️ #106 · Milestone B')
  expect(texts).toContain('🛠️ #106 · Milestone B')
  expect(texts).toContain('no issue')

  const noIssue = buildTree(
    sampleSessions().map(record => (record.sessionId === THIS_WINDOW ? { ...record, override: null } : record)),
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS },
  )
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions: noIssue, thisIssue: null }) })
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  const blockTexts = drawnTexts(block)
  expect(blockTexts).toContain('no issue')
  expect(blockTexts).not.toContain('State:')
  expect(blockTexts.some(text => text.startsWith('▪ Open #'))).toBe(false)
})

test('an issue whose details are not fetched keeps its link and draws no details block', () => {
  const tree = drawDesktop({ snapshot: snapshotWith({ thisIssue: null }) })
  const blockTexts = drawnTexts(nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL))
  expect(blockTexts).not.toContain('Branch:')
  expect(blockTexts).toContain('▪ Open #106 on GitHub ↗')
})

test('a last comment is drawn as plain Text, never as Markdown', () => {
  const block = nodesOf(drawDesktop({ snapshot: snapshotWith() }))
    .find(node => node.props.backgroundColor === DETAILS_FILL)
  const plainTexts = nodesOf(block).filter(node => node.tag === 'Text').map(node => textOf(node.props.children))
  expect(plainTexts.some(text => /^dev-one · .+ ago · keep \*this\* \[markup\]\(x\) as text$/.test(text))).toBe(true)
  expect(nodesOf(block).filter(node => node.tag === 'Markdown').every(node => !String(node.props.text).includes('keep'))).toBe(true)
})

test('the six session titles are links on the desktop and plain text on the terminal', () => {
  const desktopTexts = drawnTexts(drawDesktop())
  expect(sessionLinksIn(drawDesktop()).length).toBe(SIX_TITLES.length)
  for (const title of SIX_TITLES) {
    expect(desktopTexts.some(text => text.includes(title))).toBe(true)
  }

  const terminal = drawTerminal()
  expect(nodesOf(terminal).some(node => node.tag === 'Markdown')).toBe(false)
  expect(sessionLinksIn(terminal).length).toBe(0)
  const terminalTexts = drawnTexts(terminal)
  expect(terminalTexts).toContain('Synthetic session one 🟢')
  for (const title of SIX_TITLES.slice(1)) {
    expect(terminalTexts.some(text => text.includes(title))).toBe(true)
  }
})

test('a session title is escaped before it goes into its link', () => {
  const tree = drawDesktop({
    snapshot: snapshotWith({
      sessions: buildTree(
        [makeRecord({ sessionId: 'local_aaaa1111', title: 'Fix [x](y) *now*', lastActivityAt: NOW - MINUTE })],
        { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null },
      ),
    }),
  })
  expect(sessionLinksIn(tree)).toEqual(['[Fix \\[x\\]\\(y\\) \\*now\\*](#local_aaaa1111) 🟢'])
})

test('derived rows nest under their parents, one level deeper, with branch glyphs', () => {
  const tree = drawDesktop()
  const texts = drawnTexts(tree)
  // The four tops of Recents carry ├ and └ on the last; the fork and the spawn are each the only child of their parent.
  expect(texts.filter(text => text === '└').length).toBe(3)
  expect(texts.filter(text => text === '├').length).toBe(3)
  // The tops sit one cell under the group's label, their derived rows two cells further.
  expect(indentBefore(tree, 'session-local_c21d0002')).toBe(3)
  expect(indentBefore(tree, 'session-local_55c00006')).toBe(3)
  expect(indentBefore(tree, `session-${THIS_WINDOW}`)).toBe(1)
})

// The indents of the rows of a fork chain d0 → d1 → d2 → d3 → d4, drawn on the desktop (W1).
function chainIndents(options: { rootArchived?: boolean; desktopGroups?: DesktopGroups } = {}): Map<number, number | undefined> {
  const chain = [0, 1, 2, 3, 4].map(index =>
    makeRecord({
      sessionId: `local_d${index}000000`,
      title: `Chain ${index}`,
      lastActivityAt: NOW - MINUTE,
      isArchived: index === 0 && options.rootArchived === true,
      parentId: index === 0 ? null : `local_d${index - 1}000000`,
      parentKind: index === 0 ? null : 'fork',
    }),
  )
  const sessions = buildTree(chain, { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null, desktopGroups: options.desktopGroups })
  const tree = renderPane(DESKTOP as never, contextWith('desktop', { snapshot: snapshotWith({ sessions }) }))
  return new Map([0, 1, 2, 3, 4].map(index => [index, indentBefore(tree, `session-local_d${index}000000`)] as const))
}

test('derived rows indent 1/3/5 by the level they are drawn at, and a fourth level stays at the two-level cap (W1)', () => {
  // The root is a top, one cell under its group's label; the two levels below it add two cells each, deeper levels none.
  const listed = chainIndents()
  expect([0, 1, 2, 3, 4].map(index => listed.get(index))).toEqual([1, 3, 5, 5, 5])
})

test('a chain whose root ended, and a chain in a Desktop Group, draw the same 1/3/5 (W1)', () => {
  // The ended root is not drawn: its child is a top of Recents.
  const ended = chainIndents({ rootArchived: true })
  expect([1, 2, 3, 4].map(index => ended.get(index))).toEqual([1, 3, 5, 5])
  // In a Desktop Group the root is a titled top, as under Recents.
  const desktopGroups: DesktopGroups = {
    names: new Map([['group-chain', 'Chain group']]),
    assignments: new Map([['local_d0000000', 'group-chain']]),
  }
  const grouped = chainIndents({ desktopGroups })
  expect([0, 1, 2, 3].map(index => grouped.get(index))).toEqual([1, 3, 5, 5])
})

// One session alone, as a top of Recents.
function oneTop(sessionId: string, title: string): SessionNode {
  const [top] = buildTree([makeRecord({ sessionId, title, lastActivityAt: NOW - MINUTE })], {
    now: NOW,
    cutoffMs: 24 * HOUR,
    thisCliSessionId: null,
  })
  if (top === undefined) throw new Error(`no top for ${sessionId}`)
  return top
}

// The label element of a drawn group.
const groupLabelIn = (tree: unknown, groupKey: string): Drawn | undefined =>
  keyed(keyed(tree, `group-${groupKey}`), `group-label-${groupKey}`)

test('the Recents label is bold Text, never Markdown, and its tops are titled ├/└ rows', () => {
  const tree = drawDesktop()
  const label = groupLabelIn(tree, 'recents')
  expect(label?.tag).toBe('Text')
  expect(label?.props.bold).toBe(true)
  expect(textOf(label?.props.children)).toBe('Recents')
  expect(nodesOf(tree).some(node => node.tag === 'Markdown' && String(node.props.text).includes('Recents'))).toBe(false)

  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))[0]).toBe('├')
  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))).toContain('Synthetic docs 💤')
  expect(drawnTexts(keyed(tree, 'head-local_9b040003'))[0]).toBe('└')
  expect(drawnTexts(keyed(tree, 'head-local_9b040003'))).toContain('Synthetic session three 💤')
  // Every session, a top or a derived one, is titled with its own link.
  expect(sessionLinksIn(tree).length).toBe(SIX_TITLES.length)
})

test('this window as a top of Recents: its titled row opens the highlighted block, with the glyphs and the marker', () => {
  const tree = drawDesktop()
  expect(sessionLinksIn(tree)[0]).toBe(`**[Synthetic session one](#${THIS_WINDOW})** 🟢`)
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(drawnTexts(block).slice(0, 2)).toEqual(['├', 'Synthetic session one 🟢'])
})

test('a Desktop Group label is plain bold Text, never Markdown, and its family roots are titled ├/└ rows with their children nested', () => {
  const desktopGroups: DesktopGroups = {
    names: new Map([['group-release', 'Release 0.3 [x](y)']]),
    assignments: new Map([
      [THIS_WINDOW, 'group-release'],
      ['local_1a2b0005', 'group-release'],
    ]),
  }
  const sessions = buildTree(sampleSessions(), {
    now: NOW,
    cutoffMs: 24 * HOUR,
    thisCliSessionId: 'cli-this',
    issueFacts: SAMPLE_ISSUE_FACTS,
    desktopGroups,
  })
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions }) })
  const label = groupLabelIn(tree, 'group-release')
  expect(label?.tag).toBe('Text')
  expect(label?.props.bold).toBe(true)
  expect(textOf(label?.props.children)).toBe('Release 0.3 [x](y)')
  expect(nodesOf(tree).some(node => node.tag === 'Markdown' && String(node.props.text).includes('Release'))).toBe(false)

  expect(drawnTexts(keyed(tree, `head-${THIS_WINDOW}`)).slice(0, 2)).toEqual(['├', 'Synthetic session one 🟢'])
  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))[0]).toBe('└')
  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))).toContain('Synthetic docs 💤')
  expect(drawnTexts(keyed(tree, 'head-local_c21d0002'))[0]).toBe('└')
  expect(indentBefore(tree, `session-${THIS_WINDOW}`)).toBe(1)
  expect(indentBefore(tree, 'session-local_c21d0002')).toBe(3)
  expect(indentBefore(tree, 'session-local_55c00006')).toBe(3)
  expect(sessionLinksIn(tree).length).toBe(SIX_TITLES.length)
  // The sessions with no Group follow under Recents, after the named Group.
  const labelKeys = nodesOf(tree).map(node => String(node.props.key)).filter(key => key.startsWith('group-label-'))
  expect(labelKeys).toEqual(['group-label-group-release', 'group-label-recents'])
})

test('a Desktop Group named Recents keeps its own label next to the Recents group: the pane does not merge the two', () => {
  const named: SessionNode = { ...oneTop('local_b0000004', 'Filed top'), group: { key: 'cg-x', label: 'Recents', kind: 'desktop' } }
  // A top of Recents: oneTop lists the session with no Desktop Group.
  const unfiled = oneTop('local_b0000005', 'Unfiled top')
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions: [named, unfiled] }) })
  const labels = nodesOf(tree).filter(node => String(node.props.key).startsWith('group-label-'))
  expect(labels.map(node => String(node.props.key))).toEqual(['group-label-cg-x', 'group-label-recents'])
  expect(labels.map(node => textOf(node.props.children))).toEqual(['Recents', 'Recents'])
})

test('an ended root draws no row and no label; its live derived sessions are titled ├/└ tops of Recents that name it, and only they are counted', () => {
  const sessions = buildTree(
    [
      makeRecord({ sessionId: 'local_a0000001', title: 'Archived planning', isArchived: true }),
      makeRecord({
        sessionId: 'local_a0000002',
        title: 'Fork A',
        createdAt: NOW - 50 * MINUTE,
        lastActivityAt: NOW - MINUTE,
        parentId: 'local_a0000001',
        parentKind: 'fork',
      }),
      makeRecord({
        sessionId: 'local_a0000003',
        title: 'Spawn B',
        createdAt: NOW - 30 * MINUTE,
        lastActivityAt: NOW - MINUTE,
        parentId: 'local_a0000001',
        parentKind: 'spawn',
      }),
    ],
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null },
  )
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions }) })
  expect(sessionLinksIn(tree)).toEqual(['[Fork A](#local_a0000002) 🟢', '[Spawn B](#local_a0000003) 🟢'])
  expect(keyed(tree, 'session-local_a0000001') === undefined).toBe(true)
  expect(drawnTexts(keyed(tree, 'head-local_a0000002'))[0]).toBe('├')
  expect(drawnTexts(keyed(tree, 'head-local_a0000003'))[0]).toBe('└')
  expect(lineTitlesOf(keyed(tree, 'row-local_a0000002'))).toContain('forked from Archived planning')
  expect(lineTitlesOf(keyed(tree, 'row-local_a0000003'))).toContain('spawned from Archived planning')
  expect(drawnTexts(tree)).toContain('📋 8 open issues · 🖥️ 2 sessions')
})

test('the Recents label reads Recents in both languages, as the Desktop sidebar names it', () => {
  for (const lang of ['en', 'pt'] as const) {
    expect(textOf(groupLabelIn(drawDesktop({ lang }), 'recents')?.props.children)).toBe('Recents')
  }
})

test('a top without a group is drawn under Recents as a titled └ row', () => {
  const loose: SessionNode = { ...oneTop('local_b0000003', 'Loose top'), group: null }
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions: [loose] }) })
  expect(textOf(groupLabelIn(tree, 'recents')?.props.children)).toBe('Recents')
  expect(drawnTexts(keyed(tree, 'head-local_b0000003'))[0]).toBe('└')
  expect(sessionLinksIn(tree)).toEqual(['[Loose top](#local_b0000003) 🟢'])
})

test("on the terminal the Recents label and this window's title are plain bold Text, with no link", () => {
  const tree = drawTerminal()
  expect(nodesOf(tree).some(node => node.tag === 'Markdown')).toBe(false)
  const recents = groupLabelIn(tree, 'recents')
  expect(recents?.tag).toBe('Text')
  expect(recents?.props.bold).toBe(true)
  expect(textOf(recents?.props.children)).toBe('Recents')
  const thisTitle = keyed(tree, `title-${THIS_WINDOW}`)
  expect(thisTitle?.tag).toBe('Text')
  expect(thisTitle?.props.bold).toBe(true)
  expect(textOf(thisTitle?.props.children)).toBe('Synthetic session one 🟢')
})

test('this window is marked by its highlighted block alone, with no marker words, and a waiting window says so', () => {
  const sessions = buildTree(
    sampleSessions().map(record => (record.sessionId === THIS_WINDOW ? { ...record, waiting: true } : record)),
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS },
  )
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions }) })
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(drawnTexts(block)).toContain('waiting for you')
  expect(drawnTexts(tree).some(text => text.includes('this window'))).toBe(false)
})

test('a session waiting for you draws its needs line under its title, in both languages, on both surfaces; no needs text, no line (D7, Q14)', () => {
  const stopped = buildTree(
    [makeRecord({ sessionId: 'local_aaaa0501', lastActivityAt: NOW - HOUR, postTurn: { blocked: true, needsAction: 'Approve the push' } })],
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null },
  )
  const silent = buildTree(
    [makeRecord({ sessionId: 'local_aaaa0502', lastActivityAt: NOW - HOUR, postTurn: { blocked: true, needsAction: null } })],
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null },
  )
  for (const [lang, line] of [['en', 'Needs you: Approve the push'], ['pt', 'Precisa de você: Approve the push']] as const) {
    for (const tree of [drawDesktop({ lang, snapshot: snapshotWith({ sessions: stopped }) }), drawTerminal({ lang, snapshot: snapshotWith({ sessions: stopped }) })]) {
      expect(drawnTexts(keyed(tree, 'needs-local_aaaa0501'))).toEqual([line])
    }
    expect(keyed(drawTerminal({ lang, snapshot: snapshotWith({ sessions: silent }) }), 'needs-local_aaaa0502')).toBeUndefined()
  }
})

test('a session row draws its summary under the title, in both languages, on both surfaces, with no label; no line when there is none or while unknown (Mock S delta 7)', () => {
  const summarized = buildTree(
    [
      makeRecord({ sessionId: 'local_aaaa0601', summary: { text: 'Fix the disk full error' } }),
      makeRecord({ sessionId: 'local_aaaa0602', summary: { text: null } }),
      makeRecord({ sessionId: 'local_aaaa0603' }),
    ],
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null },
  )
  for (const [lang, line] of [['en', 'Fix the disk full error'], ['pt', 'Fix the disk full error']] as const) {
    for (const tree of [drawDesktop({ lang, snapshot: snapshotWith({ sessions: summarized }) }), drawTerminal({ lang, snapshot: snapshotWith({ sessions: summarized }) })]) {
      expect(drawnTexts(keyed(tree, 'summary-local_aaaa0601'))).toEqual([line])
    }
  }
  const tree = drawTerminal({ snapshot: snapshotWith({ sessions: summarized }) })
  expect(keyed(tree, 'summary-local_aaaa0602')).toBeUndefined()
  expect(keyed(tree, 'summary-local_aaaa0603')).toBeUndefined()
})

// The owner's review of the live pane (2026-11-01): the branch glyph sits on the title's line, and the summary comes right under the title.
test('a session head keeps its branch glyph on the title line, and draws the summary right under the title, before the breadcrumb', () => {
  const sessions = buildTree([makeRecord({ sessionId: 'local_aaaa0611', summary: { text: 'Run a gauntlet loop' } })], {
    now: NOW,
    cutoffMs: 24 * HOUR,
    thisCliSessionId: null,
  })
  const tree = drawTerminal({ snapshot: snapshotWith({ sessions }) })
  expect(keyed(tree, 'head-local_aaaa0611')?.props.alignItems).toBe('flex-start')
  const lines = drawnTexts(keyed(tree, 'head-local_aaaa0611'))
  expect(lines.slice(1, 4)).toEqual([lines[1], 'Run a gauntlet loop', 'no issue'])
  expect(lines[0]).toBe('└')
})

test('a derived session whose parent has no title says so without a name (W6)', () => {
  const orphan = buildTree([makeRecord({ sessionId: 'local_e0000001', parentId: 'local_e0000009', parentKind: 'fork' })], {
    now: NOW,
    cutoffMs: 24 * HOUR,
    thisCliSessionId: null,
  })
  const titles = lineTitlesOf(drawDesktop({ snapshot: snapshotWith({ sessions: orphan }) }))
  expect(titles).toContain('forked')
  expect(titles.some(text => text.startsWith('forked from'))).toBe(false)
  const texts = drawnTexts(drawTerminal({ snapshot: snapshotWith({ sessions: orphan }) }))
  expect(texts).toContain('forked')
})

test('an issue or PR link goes only to a GitHub page; another https host is plain text (S4)', () => {
  const offHost = { ...SAMPLE_THIS_ISSUE, url: 'https://example.invalid/issues/106' }
  const tree = drawDesktop({ snapshot: snapshotWith({ thisIssue: offHost }) })
  expect(nodesOf(tree).some(node => node.tag === 'Markdown' && String(node.props.text).includes('example.invalid'))).toBe(false)
  // Another host opens nowhere, so its line is plain text without the arrow (ux-7).
  expect(drawnTexts(tree)).toContain('▪ Open #106 on GitHub')
  expect(drawnTexts(tree)).not.toContain('▪ Open #106 on GitHub ↗')
})

test('a GitHub URL with a character that breaks a markdown link is not drawn as a link (SE2)', () => {
  for (const character of ['[', ']', '(', ')', '"', "'", '<', '>']) {
    const url = `https://github.com/synthetic-owner/synthetic-repo/issues/106${character}x`
    const tree = drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, url } }) })
    expect(nodesOf(tree).some(node => node.tag === 'Markdown' && String(node.props.text).includes(url))).toBe(false)
  }
})

test('a plain GitHub page URL with a query, an anchor or a pull number is still a link (SE2)', () => {
  for (const url of [
    'https://github.com/synthetic-owner/synthetic-repo/pull/45',
    'https://github.com/synthetic-owner/synthetic-repo/issues/106?a=1&b=%20#top',
  ]) {
    const tree = drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, url } }) })
    expect(nodesOf(tree).some(node => node.tag === 'Markdown' && String(node.props.text).includes(`](${url})`))).toBe(true)
  }
})

test('an archived session is not drawn, and the counter counts only the sessions drawn', () => {
  const archived = makeRecord({ sessionId: 'local_7f3a0300', title: 'Synthetic archived', isArchived: true })
  const withArchived = snapshotWith({
    sessions: buildTree([...sampleSessions(), archived], {
      now: NOW,
      cutoffMs: 24 * HOUR,
      thisCliSessionId: 'cli-this',
      issueFacts: SAMPLE_ISSUE_FACTS,
    }),
  })
  const counterOf = (tree: unknown): string | undefined => drawnTexts(tree).find(text => text.includes('open issues'))
  const texts = drawnTexts(drawDesktop({ snapshot: withArchived }))
  expect(texts.some(text => text.includes('Synthetic archived'))).toBe(false)
  expect(counterOf(drawDesktop()) !== undefined).toBe(true)
  expect(counterOf(drawDesktop({ snapshot: withArchived }))).toBe(counterOf(drawDesktop()))
})

test('an archived window is still drawn, with the state of its activity in its details', () => {
  const sessions = sampleSessions().map(record => (record.cliSessionId === 'cli-this' ? { ...record, isArchived: true } : record))
  const snapshot = snapshotWith({
    sessions: buildTree(sessions, { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS }),
  })
  const tree = drawDesktop({ snapshot })
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(drawnTexts(tree)).toContain('Synthetic session one 🟢')
  expect(drawnTexts(block)).toContain('working')
})

test('the records line is drawn only when a record could not be read (N1)', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ errors: ['records-unreadable'], unreadableCount: 0 }) }))
  expect(texts.some(text => text.includes('could not be read'))).toBe(false)
})

test('the counter names one open issue and one session in the singular (RP1)', () => {
  const oneSession = buildTree([makeRecord({ sessionId: 'local_aaaa1111', lastActivityAt: NOW - MINUTE })], {
    now: NOW,
    cutoffMs: 24 * HOUR,
    thisCliSessionId: null,
  })
  expect(drawnTexts(drawDesktop({ snapshot: snapshotWith({ openIssueCount: 1, sessions: oneSession }) }))).toContain(
    '📋 1 open issue · 🖥️ 1 session',
  )
  expect(drawnTexts(drawDesktop({ snapshot: snapshotWith({ openIssueCount: 2, sessions: oneSession }) }))).toContain(
    '📋 2 open issues · 🖥️ 1 session',
  )
})

test('with no session listed the counter keeps the open issue count, then 0 sessions and nothing in progress (pm1-3, ux4-4)', () => {
  const snapshot = snapshotWith({ openIssueCount: 2, sessions: [] })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('📋 2 open issues · 🖥️ 0 sessions · nothing in progress')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('📋 2 issues abertas · 🖥️ 0 sessões · nada em andamento')
})

// Each state's word key and its icon: the vocabulary is pinned here, the drawn code takes the icon by name (action-icons.ts).
const STATE_KEYS = { working: 'state.working', idle: 'state.idle', waiting: 'state.waiting' } as const
const STATE_EMOJI = { working: '🟢', idle: '💤', waiting: '⏳' } as const

// The title of every session row, as drawn: the Markdown label on the desktop, the text on the terminal.
const titleRows = (tree: unknown): string[] =>
  nodesOf(tree)
    .filter(node => /^title-(?!block$)/.test(String(node.props.key)))
    .map(node => drawnTexts(node)[0] ?? '')

// Every emoji in the texts, the variation selector dropped (▶️ is one icon). Glyphs such as ▪, ↗ and ← are not emoji here.
const iconsIn = (texts: readonly string[]): string[] =>
  texts.flatMap(text => [...text.matchAll(/\p{Emoji_Presentation}|\p{Emoji}️/gu)].map(match => match[0].replace('️', '')))

// A snapshot that draws every icon of the footer's legend: the sample, plus an overdue milestone, an error line, a commit, a closed
// PR and the four priority tags.
function richSnapshot(): Snapshot {
  const milestones = SAMPLE_MILESTONES.map(each => (each.number === 22 ? { ...each, dueOn: '2026-10-01' } : each))
  const issues = SAMPLE_ISSUES.map((issue, index) => ({ ...issue, labels: [`P${index % 4}`] }))
  const records = sampleSessions().map(record =>
    record.sessionId === 'local_9b040003' ? { ...record, commits: [{ at: NOW - HOUR, subject: 'fix(synthetic): commit subject' }] } : record,
  )
  return snapshotWith({
    milestones,
    issueGroups: groupIssues(milestones, issues, SAMPLE_LINKED, false),
    sessions: buildTree(records, { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS }),
    thisIssue: {
      ...SAMPLE_THIS_ISSUE,
      pr: { number: 111, title: 'Synthetic change', state: 'CLOSED', reviewDecision: null, url: 'https://github.com/synthetic-owner/synthetic-repo/pull/111' },
    },
    errors: ['gh-failed'],
  })
}

test('a session row draws its state icon and no state word, in both languages (owner feedback, beta.13)', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const tree of [drawDesktop({ lang }), drawTerminal({ lang })]) {
      const rows = titleRows(tree)
      // The sample carries a working, an idle and a waiting session: each state icon is drawn, and no row names a state.
      for (const state of Object.keys(STATE_KEYS) as (keyof typeof STATE_KEYS)[]) {
        expect(rows.some(row => row.includes(STATE_EMOJI[state]))).toBe(true)
      }
      for (const row of rows) {
        for (const key of Object.values(STATE_KEYS)) expect(row).not.toContain(t(lang, key))
      }
    }
  }
})

test('a session row reads its title first, then its state icon and active marker, on both surfaces (owner feedback, beta.13)', () => {
  for (const tree of [drawDesktop(), drawTerminal()]) {
    const rows = titleRows(tree)
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) {
      const iconAt = row.search(/\p{Emoji_Presentation}|\p{Emoji}️/u)
      expect(iconAt).toBeGreaterThan(0)
      expect(row.slice(0, iconAt)).toMatch(/^Synthetic /)
    }
    // This window's head: the branch glyph first, then the title row.
    const head = drawnTexts(keyed(tree, `head-${THIS_WINDOW}`))
    expect(head[0]).toBe('├')
    expect(head[1]).toBe(drawnTexts(keyed(tree, `title-${THIS_WINDOW}`))[0])
  }
})

// The legend's rows in drawn order: each row is keyed legend-<id>; its sentence element (legend-<id>-text), the heading, the note and the
// button (legend-toggle) are not rows.
const LEGEND_ROW_KEY = /^legend-(?!heading$)(?!note$)(?!toggle$)(?!.*-text$)/
const legendRowsOf = (tree: unknown): Drawn[] => nodesOf(tree).filter(node => LEGEND_ROW_KEY.test(String(node.props.key)))

// Each legend row as [icon, name, sentence]. The desktop draws the name in Markdown's ** (the text, bold); the terminal nests a bold
// Text for the name in a Text, then the sentence after ": ".
const legendPartsOf = (tree: unknown): string[][] =>
  legendRowsOf(tree).map(row => {
    const [cell, text] = row.props.children as Drawn[]
    const meaning = ((text as Drawn).props.children as Drawn[])[0] as Drawn
    // A marker row's cell holds the line's marker, read as its alt in brackets.
    const mark = nodesOf(cell).find(node => node.tag === 'Svg')
    const icon = mark === undefined ? textOf(cell) : `[${String(mark.props.alt)}]`
    if (meaning.tag === 'Markdown') {
      const [, name = '', sentence = ''] = /^\*\*(.+?)\*\*: (.*)$/.exec(String(meaning.props.text)) ?? []
      return [icon, plainMarkdown(name), plainMarkdown(sentence)]
    }
    const [nameNode, rest] = meaning.props.children as [Drawn, string]
    expect(nameNode.props.bold).toBe(true)
    return [textOf(cell), textOf(nameNode), String(rest).replace(/^: /, '')]
  })

test('the legend is a Labels table: a bold heading, then one row per icon in group order, each with its bold name and a sentence, in English and pt-BR', () => {
  const english = [
    ['🟢', 'working', 'the session is running a turn or a tool right now.'],
    [
      '⏳',
      'waiting for you',
      "this window's session asked you to approve a tool and is paused until you answer, or another session stopped and needs your answer (last activity less than 24 hours ago).",
    ],
    ['💤', 'idle', 'no activity recorded in the Desktop app for more than 5 minutes.'],
    ['📋', 'open issues', 'GitHub issues still open; under "Issues without session", no session is on them yet (to do).'],
    ['🛠️', 'issue of a session', 'an issue a session is working on (in progress).'],
    ['✅', 'done', 'a closed issue, a merged PR, or a milestone with every issue closed.'],
    ['☑️', 'closed PR', 'a pull request closed without merging.'],
    ['📝', 'commit', "a commit made on the session's branch."],
    ['🔀', 'open PR', "a pull request opened from the session's branch."],
    ['🚀', 'session event', 'the session started, or was forked or spawned from another.'],
    ['🎯', 'milestone', 'a GitHub milestone, with the share of its issues already closed.'],
    ['📅', 'due date', "the milestone's deadline."],
    ['⚠️', 'attention', 'an error, a partial list, or a milestone past its due date with issues still open.'],
    ['🔴', 'priority P0', 'critical, from the issue labels.'],
    ['🟠', 'priority P1', 'high, from the issue labels.'],
    ['🟡', 'priority P2', 'medium, from the issue labels.'],
    ['⚪', 'priority P3', 'low, from the issue labels.'],
    ['🖥️', 'sessions', 'how many sessions of this repo are listed.'],
  ]
  const portuguese = [
    ['🟢', 'trabalhando', 'a sessão está executando um turno ou uma ferramenta agora.'],
    [
      '⏳',
      'esperando você',
      'a sessão desta janela pediu sua aprovação para uma ferramenta e está parada até você responder, ou outra sessão parou e precisa da sua resposta (última atividade há menos de 24 h).',
    ],
    ['💤', 'ociosa', 'sem atividade registrada no app Desktop há mais de 5 minutos.'],
    ['📋', 'issues abertas', 'issues do GitHub ainda abertas; em "Issues sem sessão", nenhuma sessão está nelas ainda (a fazer).'],
    ['🛠️', 'issue de uma sessão', 'uma issue em que uma sessão está trabalhando (em andamento).'],
    ['✅', 'feito', 'uma issue fechada, um PR mesclado ou um milestone com todas as issues fechadas.'],
    ['☑️', 'PR fechado', 'um pull request fechado sem ser mesclado.'],
    ['📝', 'commit', 'um commit feito no branch da sessão.'],
    ['🔀', 'PR aberto', 'um pull request aberto a partir do branch da sessão.'],
    ['🚀', 'evento de sessão', 'a sessão começou ou foi derivada (fork ou spawn) de outra.'],
    ['🎯', 'milestone', 'um milestone do GitHub, com a parte das issues já fechadas.'],
    ['📅', 'prazo', 'a data limite do milestone.'],
    ['⚠️', 'atenção', 'um erro, uma lista parcial ou um milestone com prazo vencido e issues ainda abertas.'],
    ['🔴', 'prioridade P0', 'crítica, pelos rótulos da issue.'],
    ['🟠', 'prioridade P1', 'alta, pelos rótulos da issue.'],
    ['🟡', 'prioridade P2', 'média, pelos rótulos da issue.'],
    ['⚪', 'prioridade P3', 'baixa, pelos rótulos da issue.'],
    ['🖥️', 'sessões', 'quantas sessões deste repositório estão listadas.'],
  ]
  // On the desktop the timeline's emoji rows (commit, open PR, session event) give way to the line's markers, in their place.
  const englishMarks = [
    ['[in progress]', 'now', 'the step the session is doing now.'],
    ['[release]', 'release', 'a release: a version published or a release commit.'],
    ['[commit]', 'commit', "a commit made on the session's branch."],
    ['[test]', 'test', 'a step that ran or wrote tests.'],
    ['[pull request]', 'open PR', "a pull request opened from the session's branch."],
    ['[session]', 'session event', 'the session started, or was forked or spawned from another.'],
    ['[step]', 'step', "another step of the session's plan."],
  ]
  const portugueseMarks = [
    ['[in progress]', 'agora', 'a etapa que a sessão está fazendo agora.'],
    ['[release]', 'release', 'um release: uma versão publicada ou um commit de release.'],
    ['[commit]', 'commit', 'um commit feito no branch da sessão.'],
    ['[test]', 'teste', 'uma etapa que rodou ou escreveu testes.'],
    ['[pull request]', 'PR aberto', 'um pull request aberto a partir do branch da sessão.'],
    ['[session]', 'evento de sessão', 'a sessão começou ou foi derivada (fork ou spawn) de outra.'],
    ['[step]', 'etapa', 'outra etapa do plano da sessão.'],
  ]
  const onDesktop = (rows: string[][], marks: string[][]): string[][] => [...rows.slice(0, 7), ...marks, ...rows.slice(10)]
  for (const [tree, rows] of [
    [drawDesktop({ lang: 'en', legendOpen: true }), onDesktop(english, englishMarks)],
    [drawTerminal({ lang: 'en', legendOpen: true }), english],
  ] as const) {
    expect(drawnTexts(keyed(tree, 'legend-heading'))).toEqual(['Labels Descriptions'])
    expect(keyed(tree, 'legend-heading')?.props.bold).toBe(true)
    expect(legendPartsOf(tree)).toEqual(rows)
  }
  for (const [tree, rows] of [
    [drawDesktop({ lang: 'pt', legendOpen: true }), onDesktop(portuguese, portugueseMarks)],
    [drawTerminal({ lang: 'pt', legendOpen: true }), portuguese],
  ] as const) {
    expect(drawnTexts(keyed(tree, 'legend-heading'))).toEqual(['Labels Descriptions'])
    expect(legendPartsOf(tree)).toEqual(rows)
  }
})

// Each row is a fixed-width icon cell, then its name and sentence (Markdown on the desktop, Text on the terminal), so the rows read as a
// table on both surfaces.
test('each legend row is a fixed-width icon cell, then its name and sentence, on both surfaces', () => {
  for (const tree of [drawDesktop({ legendOpen: true }), drawTerminal({ legendOpen: true })]) {
    for (const row of legendRowsOf(tree)) {
      const [cell, text] = row.props.children as Drawn[]
      expect(cell?.tag).toBe('Box')
      // One emoji (2 columns) and its gap fill the cell, and the cell never shrinks.
      expect(Number(cell?.props.width)).toBe(4)
      expect(cell?.props.flexShrink).toBe(0)
      expect(row.props.alignItems).toBe('flex-start')
      // The sentence sits in its own flexible column, so a wrapped sentence cannot squeeze the icon cell.
      expect(text?.props.flexGrow).toBe(1)
      expect(text?.props.flexShrink).toBe(1)
      const meaning = ((text as Drawn).props.children as Drawn[])[0] as Drawn
      expect(['Markdown', 'Text']).toContain(meaning.tag)
    }
  }
})

test('the legend is a bordered block with padding, on both surfaces', () => {
  for (const tree of [drawDesktop({ legendOpen: true }), drawTerminal({ legendOpen: true })]) {
    const block = keyed(tree, 'legend')
    expect(block?.props.borderStyle).toBe('round')
    expect(block?.props.borderDimColor).toBe(true)
    expect(Number(block?.props.paddingX)).toBeGreaterThanOrEqual(1)
    expect(Number(block?.props.paddingY)).toBeGreaterThanOrEqual(1)
  }
})

test('the legend lists every icon a snapshot draws, and no other, in both languages and on both surfaces', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const draw of [drawDesktop, drawTerminal]) {
      const tree = draw({ lang, snapshot: richSnapshot(), legendOpen: true })
      const legendTexts = drawnTexts(keyed(tree, 'legend'))
      const body = bodyTextsOf(tree)
      expect(new Set(iconsIn(legendTexts))).toEqual(new Set(iconsIn(body)))
    }
  }
})

test('the legend sits above the footer, which stays the last line; its keys are unique and the same on both surfaces', () => {
  const tree = drawDesktop({ legendOpen: true })
  const texts = drawnTexts(tree)
  const legend = drawnTexts(keyed(tree, 'legend'))
  expect(texts.at(-1)?.startsWith('Updated ')).toBe(true)
  expect(texts.slice(-legend.length - 1, -1)).toEqual(legend)
  const keysOf = (drawn: unknown): string[] => nodesOf(drawn).map(node => String(node.props.key)).filter(key => key.startsWith('legend-'))
  const keys = keysOf(drawDesktop({ legendOpen: true }))
  expect(keys.length).toBeGreaterThan(15)
  expect(new Set(keys).size).toBe(keys.length)
  // The surfaces differ only in the timeline's rows: the terminal's emoji rows, the desktop's marker rows.
  const timelineRow = /^legend-(commit|pr|session|mark-\w+)(-text)?$/
  expect(keysOf(drawTerminal({ legendOpen: true })).filter(key => !timelineRow.test(key))).toEqual(keys.filter(key => !timelineRow.test(key)))
})

test('the records line names one unreadable record in the singular, in both languages (RP2)', () => {
  const snapshot = snapshotWith({ errors: ['records-unreadable'], unreadableCount: 1 })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('⚠️ 1 session record could not be read')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('⚠️ 1 registro de sessão não pôde ser lido')
})

test('issue groups: open milestones by due date, then by number, a milestone with no open issue as one line, no milestone last', () => {
  const texts = drawnTexts(drawDesktop())
  const at = (text: string): number => texts.indexOf(text)
  expect(at('Milestone B ↗ 🎯')).toBeGreaterThan(-1)
  expect(at('Milestone A ↗ 🎯')).toBeGreaterThan(-1)
  expect(at('Milestone Z ↗ ✅ · all closed · ready to close')).toBeGreaterThan(-1)
  expect(at('Milestone Z')).toBe(-1)
  expect(at('Milestone A ↗ 🎯') < at('Milestone B ↗ 🎯')).toBe(true)
  expect(at('Milestone B ↗ 🎯') < at('Milestone Z ↗ ✅ · all closed · ready to close')).toBe(true)
  expect(at('Milestone Z ↗ ✅ · all closed · ready to close') < at('No milestone / issue')).toBe(true)
})

test('a milestone title is followed by its closed and total issues, in both languages (pm1-1)', () => {
  const texts = drawnTexts(drawDesktop())
  const at = (list: string[], text: string): number => list.indexOf(text)
  expect(texts[at(texts, 'Milestone B ↗ 🎯') + 1]).toBe('▰▰▰▰▰▰▱▱▱▱ 63% · 10 of 16 issues closed')
  expect(texts[at(texts, 'Milestone A ↗ 🎯') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 of 1 issue closed · 📅 due 2099-10-31')
  expect(texts[at(texts, 'Milestone Z ↗ ✅ · all closed · ready to close') + 1]).toBe('▰▰▰▰▰▰▰▰▰▰ 100% · 1 of 1 issue closed')
  const pt = drawnTexts(drawDesktop({ lang: 'pt' }))
  expect(pt[at(pt, 'Milestone B ↗ 🎯') + 1]).toBe('▰▰▰▰▰▰▱▱▱▱ 63% · 10 de 16 issues fechadas')
  expect(pt[at(pt, 'Milestone A ↗ 🎯') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 de 1 issue fechada · 📅 prazo 2099-10-31')
  expect(pt[at(pt, 'Milestone Z ↗ ✅ · todas fechadas · pronto para fechar') + 1]).toBe('▰▰▰▰▰▰▰▰▰▰ 100% · 1 de 1 issue fechada')
})

test('a milestone with one open issue on sessions reads its count in the singular, in both languages (ux4-16)', () => {
  const snapshot = snapshotWith({
    issueGroups: [
      {
        milestone: { number: 32, title: 'Milestone R', openIssues: 1, closedIssues: 0, dueOn: null, countsExact: true, description: null },
        closedTitle: null, closedNumber: null,
        issues: [],
        claimsLinked: true,
      },
    ],
  })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('Milestone R ↗ 🎯 · 1 open, all in sessions')
  const pt = drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))
  expect(pt).toContain('Milestone R ↗ 🎯 · 1 aberta, todas em sessões')
  expect(pt[pt.indexOf('Milestone R ↗ 🎯 · 1 aberta, todas em sessões') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 de 1 issue fechada')
})

test('an open milestone whose open issues all sit on sessions names them, with its progress (pm1-2)', () => {
  const snapshot = snapshotWith({
    issueGroups: [
      {
        milestone: { number: 31, title: 'Milestone Q', openIssues: 2, closedIssues: 1, dueOn: null, countsExact: true, description: null },
        closedTitle: null, closedNumber: null,
        issues: [],
        claimsLinked: true,
      },
    ],
  })
  const texts = drawnTexts(drawDesktop({ snapshot }))
  const at = texts.indexOf('Milestone Q ↗ 🎯 · 2 open, all in sessions')
  expect(at).toBeGreaterThan(-1)
  expect(texts[at + 1]).toBe('▰▰▰▱▱▱▱▱▱▱ 33% · 1 of 3 issues closed')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('Milestone Q ↗ 🎯 · 2 abertas, todas em sessões')
})

test('rev-g1-5: a one-line milestone whose list does not back its count draws its title and progress, without the claim', () => {
  const snapshot = snapshotWith({
    issueGroups: [
      {
        milestone: { number: 33, title: 'Milestone S', openIssues: 2, closedIssues: 0, dueOn: null, countsExact: true, description: null },
        closedTitle: null, closedNumber: null,
        issues: [],
        claimsLinked: false,
      },
    ],
  })
  const texts = drawnTexts(drawDesktop({ snapshot }))
  expect(texts[texts.indexOf('Milestone S ↗ 🎯') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 of 2 issues closed')
  expect(texts.some(text => text.includes('all in sessions'))).toBe(false)
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' })).some(text => text.includes('em sessões'))).toBe(false)
})

test('pm1-9: the issues of a closed milestone sit under its title, marked closed, in both languages', () => {
  const snapshot = snapshotWith({
    issueGroups: [{ milestone: null, closedTitle: 'Milestone Y', closedNumber: 40, issues: SAMPLE_ISSUES.slice(0, 1), claimsLinked: false }],
  })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('Milestone Y ↗ ✅ · closed')
  const pt = drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))
  expect(pt).toContain('Milestone Y ↗ ✅ · fechado')
  expect(pt).not.toContain('Sem milestone / issue')
})

test('an issue row links to its https page on the desktop only', () => {
  const desktop = drawDesktop()
  const links = nodesOf(desktop).filter(node => node.tag === 'Markdown').map(node => String(node.props.text))
  expect(links).toContain('▪ [#105 Synthetic issue 105 ↗](https://github.com/synthetic-owner/synthetic-repo/issues/105)')
  expect(drawnTexts(drawTerminal()).some(text => text.includes('https://'))).toBe(false)
})

test('the footer names the repo and the age of the snapshot', () => {
  // The pane reads the wall clock (Date.now()), so the snapshot is set two minutes old on that clock.
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ fetchedAt: Date.now() - 2 * MINUTE }) }))
  expect(texts).toContain('Updated 2 min ago · gh · synthetic-owner/synthetic-repo')
})

// The footer's age is the rows' age: "just now" in the first minute, not "0 min ago" (ux4-17).
test('the footer says just now in the first minute, as the rows do, in both languages', () => {
  const snapshot = snapshotWith({ fetchedAt: Date.now() - 10 * 1000 })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('Updated just now · gh · synthetic-owner/synthetic-repo')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('Atualizado agora · gh · synthetic-owner/synthetic-repo')
})

test('each pane error draws its line above the groups', () => {
  const errors: PaneError[] = [
    'gh-missing',
    'gh-auth',
    'gh-rate-limit',
    'gh-timeout',
    'no-remote',
    'records-unreadable',
    'git-failed',
  ]
  const lines = [
    '⚠️ gh not found: showing sessions only',
    '⚠️ gh is not signed in',
    '⚠️ GitHub rate limit: showing the last data',
    '⚠️ GitHub did not answer in time',
    '⚠️ no GitHub remote for this repo',
    '⚠️ 2 session records could not be read',
    '⚠️ git failed in this folder · sessions shown without branch',
  ]
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ errors, truncated: true, truncatedLimits: [100], unreadableCount: 2 }) }))
  for (const line of lines) expect(texts).toContain(line)
  expect(texts).toContain('⚠️ PRs list is partial (first 100)')
  // The groups open at their label: each error line sits above Recents, not merely above the first session row (rev-g1-6).
  const groupAt = texts.indexOf('Recents')
  expect(groupAt).toBeGreaterThan(-1)
  for (const line of lines) expect(texts.indexOf(line) < groupAt).toBe(true)
})

// The pane measures ages against the wall clock (renderPane reads Date.now()), so the snapshot's time is set from it here.
test('a stale snapshot keeps its last data, draws its failure line, and its footer gives the age of the last good read (CR4)', () => {
  const snapshot = snapshotWith({ stale: true, errors: ['gh-rate-limit'], fetchedAt: Date.now() - 5 * MINUTE })
  const texts = drawnTexts(drawDesktop({ snapshot }))
  expect(texts).toContain('⚠️ GitHub rate limit: showing the last data')
  expect(texts).toContain('Updated 5 min ago · gh · synthetic-owner/synthetic-repo')
  expect(texts.some(text => text.startsWith('Synthetic session one'))).toBe(true)
  expect(texts.join('\n')).toContain('Synthetic session one')
})

test('no-github mode draws the sessions and the no-remote line, and no issue section', () => {
  const texts = drawnTexts(
    drawDesktop({
      snapshot: snapshotWith({
        mode: 'no-github',
        repo: null,
        issueGroups: [],
        errors: ['no-remote'],
        fetchedAt: Date.now() - 2 * MINUTE,
      }),
    }),
  )
  expect(texts.some(text => text.startsWith('Synthetic session'))).toBe(true)
  expect(texts).toContain('⚠️ no GitHub remote for this repo')
  expect(texts).not.toContain('Issues without session')
  expect(texts).toContain('Updated 2 min ago · gh · —')
})

test('ux4-2: a first poll that settled with no snapshot draws the failure line, not Loading, in both languages', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: null, loadFailed: true }))
  expect(texts).toContain('❌ Could not read the repo: state unknown')
  expect(texts).not.toContain('Loading the repo...')
  expect(drawnTexts(drawDesktop({ snapshot: null, loadFailed: true, lang: 'pt' }))).toContain('❌ Não foi possível ler o repo: estado desconhecido')
})

test('a snapshot not yet read draws the loading line only', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: null }))
  expect(texts).toContain('Loading the repo...')
  expect(texts.some(text => text.startsWith('Synthetic session'))).toBe(false)
  expect(texts).not.toContain('Recents')
})

test('F01: the partial-list line names the cap that was hit (100 PRs), not the open-issue count', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ truncated: true, truncatedLimits: [100] }) }))
  expect(texts).toContain('⚠️ PRs list is partial (first 100)')
  expect(texts.some(text => text.includes('issues list'))).toBe(false)
})

test('SP3-1: an issue list and a PR list both cut draw one partial-list line each, with its own limit', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ truncated: true, truncatedLimits: [500, 100] }) }))
  expect(texts).toContain('⚠️ issues list is partial (first 500)')
  expect(texts).toContain('⚠️ PRs list is partial (first 100)')
})

test('F03: an unmapped gh failure draws its GitHub line and does not throw', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ errors: ['gh-failed'] }) }))
  expect(texts).toContain('⚠️ GitHub did not answer as expected: showing the last data')
})

test('F10: a branch name in the details is drawn as plain text, capped like a title', () => {
  const branch = `feature/${'b'.repeat(250)}`
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, branch } }) }))
  expect(texts).toContain(`${branch.slice(0, TEXT_MAX - 1)}…`)
  expect(texts).not.toContain(branch)
})

// Review fixes of the trail, the counters, the progress wording, the links and the start time (ux-1 to ux-9, sp-6).
test('the trail names the title of a closed milestone, says "no milestone" for an issue that has none, and omits the part when the title is unknown (ux-1)', () => {
  const treeWith = (facts: ReadonlyMap<number, { url: string; milestoneTitle: string | null }>) =>
    buildTree(sampleSessions(), { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: facts })
  const retitled = new Map([...SAMPLE_ISSUE_FACTS].map(([number, facts]) => [number, { ...facts, milestoneTitle: 'Closed Milestone' }] as const))
  expect(drawnTexts(drawDesktop({ snapshot: snapshotWith({ sessions: treeWith(retitled) }) }))).toContain('🛠️ #106 · Closed Milestone')
  const untitled = new Map([...SAMPLE_ISSUE_FACTS].map(([number, facts]) => [number, { ...facts, milestoneTitle: null }] as const))
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ sessions: treeWith(untitled) }) }))
  expect(texts.some(text => text.includes('no milestone'))).toBe(false)
  expect(texts.some(text => text.includes('🛠️ #106 · Milestone B'))).toBe(false)
  const bare = new Map([...SAMPLE_ISSUE_FACTS].map(([number, facts]) => [number, { ...facts, milestoneTitle: null, noMilestone: true }] as const))
  expect(drawnTexts(drawDesktop({ snapshot: snapshotWith({ sessions: treeWith(bare) }) }))).toContain('🛠️ #106 · no milestone')
})

test('with every open issue on a session and no group built, the issues line says they are in sessions (ux-2)', () => {
  const allLinked = snapshotWith({ issueGroups: [] })
  expect(drawnTexts(drawDesktop({ snapshot: allLinked }))).toContain('All open issues are in sessions')
  expect(drawnTexts(drawDesktop({ snapshot: allLinked }))).not.toContain('No open issues')
  expect(drawnTexts(drawDesktop({ snapshot: allLinked, lang: 'pt' }))).toContain('Todas as issues abertas estão em sessões')
  expect(drawnTexts(drawDesktop({ snapshot: snapshotWith({ issueGroups: [], openIssueCount: 0 }) }))).toContain('No open issues')
})

test('in no-github mode the counter names only the sessions (ux-3)', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ mode: 'no-github', openIssueCount: 3 }) }))
  expect(bodyTextsOf(drawDesktop({ snapshot: snapshotWith({ mode: 'no-github', openIssueCount: 3 }) })).some(text => text.includes('open issue'))).toBe(false)
  expect(texts.some(text => /^\S+ \d+ sessions?$/.test(text))).toBe(true)
})

test('the open-issue count is marked "+" only when the issue list is cut (ux-4)', () => {
  const cut = drawnTexts(drawDesktop({ snapshot: snapshotWith({ openIssueCount: 500, truncated: true, truncatedLimits: [500] }) }))
  expect(cut.some(text => text.startsWith('📋 500+ open issues · '))).toBe(true)
  const whole = drawnTexts(drawDesktop({ snapshot: snapshotWith({ openIssueCount: 500 }) }))
  expect(whole.some(text => text.startsWith('📋 500 open issues · '))).toBe(true)
})

test('an inexact milestone count is counted in items, not issues, in both languages (ux-5)', () => {
  const inexact = [{ number: 40, title: 'Milestone I', openIssues: 6, closedIssues: 4, dueOn: null, countsExact: false, description: null }]
  const snapshot = snapshotWith({ milestones: inexact, issueGroups: groupIssues(inexact, SAMPLE_ISSUES, SAMPLE_LINKED, false) })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('4 of 10 items closed')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('4 de 10 itens fechados')
})

test('the start of an issue carries its date with the clock once it is over a day old; a recent start keeps the clock alone (ux-9)', () => {
  const startedLine = (startedAt: number): string | undefined => {
    const block = nodesOf(drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, startedAt } }) })).find(
      node => node.props.backgroundColor === DETAILS_FILL,
    )
    return drawnTexts(block).find(text => /^(\d{4}-\d\d-\d\d )?\d\d:\d\d · /.test(text))
  }
  expect(startedLine(Date.now() - 2 * 24 * HOUR)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d · 2 d ago$/)
  expect(startedLine(Date.now() - 2 * HOUR)).toMatch(/^\d\d:\d\d · 2 h ago$/)
})

test('the pane never draws "on this machine", in either language (sp-6)', () => {
  for (const lang of ['en', 'pt'] as const) {
    const trees = [drawDesktop({ lang }), drawTerminal({ lang }), drawDesktop({ lang, snapshot: null })]
    const texts = trees.flatMap(tree => drawnTexts(tree))
    expect(texts.some(text => /on this machine|neste computador/i.test(text))).toBe(false)
  }
})

// A snapshot whose one open issue (the first sample issue) carries these labels, drawn in no milestone group.
const snapshotWithLabels = (labels: string[]): Snapshot => {
  const issues = SAMPLE_ISSUES.slice(0, 1).map(issue => ({ ...issue, labels }))
  return snapshotWith({ issueGroups: [{ milestone: null, closedTitle: null, closedNumber: null, issues, claimsLinked: false }] })
}

// The issue row of a drawn tree: the element keyed `line-<issue number>` (the only element whose key starts with `line-`).
const issueLineOf = (tree: unknown): Drawn | undefined => nodesOf(tree).find(node => String(node.props.key ?? '').startsWith('line-'))

test('the issue row leads with its priority tag: P0 and P1 are bold, P2 and an unlabelled row are not (terminal surface)', () => {
  const high = issueLineOf(drawTerminal({ snapshot: snapshotWithLabels(['priority: high']) }))
  expect(textOf(high?.props.children)).toMatch(/^🟠 P1 #\d+ /)
  expect(high?.props.bold).toBe(true)
  const critical = issueLineOf(drawTerminal({ snapshot: snapshotWithLabels(['P0']) }))
  expect(textOf(critical?.props.children)).toMatch(/^🔴 P0 #\d+ /)
  expect(critical?.props.bold).toBe(true)
  const medium = issueLineOf(drawTerminal({ snapshot: snapshotWithLabels(['priority/medium']) }))
  expect(textOf(medium?.props.children)).toMatch(/^🟡 P2 #\d+ /)
  expect(medium?.props.bold).toBe(false)
  const plain = issueLineOf(drawTerminal({ snapshot: snapshotWithLabels([]) }))
  expect(textOf(plain?.props.children)).toMatch(/^#\d+ /)
  expect(plain?.props.bold).toBe(false)
})

test('the issue row on the desktop draws its tag inside the link, bold for P0 and P1 only', () => {
  const high = issueLineOf(drawDesktop({ snapshot: snapshotWithLabels(['prio-high']) }))
  expect(String(high?.props.text)).toMatch(/^\*\*▪ \[🟠 P1 #\d+ /)
  const low = issueLineOf(drawDesktop({ snapshot: snapshotWithLabels(['priority: low']) }))
  expect(String(low?.props.text)).toMatch(/^▪ \[⚪ P3 #\d+ /)
})

test('clock times and dates are drawn in the host zone: the offset shifts the instant before the UTC getters read it', () => {
  const at = Date.parse('2025-10-26T16:06:00Z')
  expect(clockOf(at, -180)).toBe('13:06')
  expect(clockOf(at, 0)).toBe('16:06')
  expect(clockOf(at, 330)).toBe('21:36')
  expect(dateOf(Date.parse('2025-10-31T02:30:00Z'), -180)).toBe('2025-10-30')
  expect(dateOf(Date.parse('2025-10-31T02:30:00Z'), 0)).toBe('2025-10-31')
  expect(dateOf(Date.parse('2025-10-31T23:30:00Z'), 60)).toBe('2025-11-01')
})

test('the started line draws the host clock, with the host date once the start is over a day old', () => {
  const startedAt = Date.parse('2025-10-26T16:06:00Z')
  const startedLine = (utcOffsetMinutes: number): string | undefined => {
    const snapshot = snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, startedAt } })
    const block = nodesOf(drawDesktop({ snapshot, utcOffsetMinutes })).find(node => node.props.backgroundColor === DETAILS_FILL)
    return drawnTexts(block).find(text => /^(\d{4}-\d\d-\d\d )?\d\d:\d\d · /.test(text))
  }
  expect(startedLine(-180)).toMatch(/^2025-10-26 13:06 · /)
  expect(startedLine(0)).toMatch(/^2025-10-26 16:06 · /)
})

test('a GitHub due date is a calendar date: it is drawn from its UTC date, never shifted into the host zone', () => {
  const milestone = { number: 22, title: 'Milestone D', openIssues: 1, closedIssues: 0, dueOn: '2025-10-31T00:00:00Z', countsExact: true, description: null }
  const snapshot = snapshotWith({ issueGroups: [{ milestone, closedTitle: null, closedNumber: null, issues: [], claimsLinked: true }] })
  const texts = drawnTexts(drawDesktop({ snapshot, utcOffsetMinutes: -180 }))
  expect(texts.some(text => text.includes('2025-10-31'))).toBe(true)
  expect(texts.some(text => text.includes('2025-10-30'))).toBe(false)
})

// The icon vocabulary (action-icons.ts): the marker, the timeline, the due date and the priority tags are pinned by their emoji here.
test('no active marker: a session working now carries its 🟢 and no 🔄 or ▶️, an idle row 💤', () => {
  const texts = drawnTexts(drawTerminal())
  expect(texts).toContain('Synthetic session one 🟢')
  expect(texts).toContain('Synthetic fork 🟢')
  expect(texts).toContain('Synthetic docs 💤')
  expect(texts.some(text => text.includes('🔄'))).toBe(false)
  expect(texts.some(text => text.includes('▶️'))).toBe(false)
})

test('the title line carries no window marker or open-session link, on either surface, in English or pt-BR (owner, 2026-11-02)', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const tree of [drawDesktop({ lang }), drawTerminal({ lang })]) {
      const all = JSON.stringify(tree)
      for (const gone of ['▶️', '← this window', '← esta janela', 'open session', 'abrir sessão']) expect(all).not.toContain(gone)
    }
  }
})

test('the idle legend names the working window in minutes: no activity for more than that long', () => {
  const minutes = WORKING_WINDOW_MS / 60_000
  const texts = drawnTexts(drawTerminal({ legendOpen: true }))
  expect(texts.some(text => text.includes(`no activity recorded in the Desktop app for more than ${minutes} minutes.`))).toBe(true)
  expect(texts.some(text => text.includes('🔄') || text.includes('session working now'))).toBe(false)
})

test('the timeline draws no heading in either language, on either surface: no 🕘 and no Timeline word (owner, 2026-11-01)', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const tree of [drawDesktop({ lang }), drawTerminal({ lang })]) {
      const texts = drawnTexts(tree)
      expect(texts.some(text => text.includes('🕘') || text.includes('Timeline') || text.includes('Linha do tempo'))).toBe(false)
    }
  }
})

test('the timeline events keep the icon of their kind: PR 🔀, session 🚀, commit 📝', () => {
  const texts = drawnTexts(drawTerminal())
  expect(texts).toContain('🔀')
  expect(texts).toContain('🚀')
  expect(statusIconEmoji('commit')).toBe('📝')
})

test('each priority tag has its icon: P0 🔴, P1 🟠, P2 🟡, P3 ⚪', () => {
  expect(priorityEmoji('P0')).toBe('🔴')
  expect(priorityEmoji('P1')).toBe('🟠')
  expect(priorityEmoji('P2')).toBe('🟡')
  expect(priorityEmoji('P3')).toBe('⚪')
})

test('the progress bar has ten cells and the rounded percentage; no count to share draws nothing', () => {
  expect(progressBarOf(3, 5)).toBe('▰▰▰▰▰▰▱▱▱▱ 60%')
  expect(progressBarOf(0, 4)).toBe('▱▱▱▱▱▱▱▱▱▱ 0%')
  expect(progressBarOf(4, 4)).toBe('▰▰▰▰▰▰▰▰▰▰ 100%')
  expect(progressBarOf(0, 0)).toBe('')
})

test('isOverdue compares the due date with today in the host zone: an earlier date is overdue, today is not', () => {
  expect(isOverdue('2026-10-19', NOW, 0)).toBe(true)
  expect(isOverdue('2026-10-20', NOW, 0)).toBe(false)
  // 23:30 UTC on 20 Oct is already 21 Oct at UTC+2, so a due date of 20 Oct is overdue there.
  expect(isOverdue('2026-10-20', Date.parse('2026-10-20T23:30:00Z'), 120)).toBe(true)
})

// The overdue marker and the bar need exact counts: an inexact milestone draws neither, and a closed one is never overdue.
const milestoneSnapshot = (milestone: Snapshot['milestones'][number]): Snapshot =>
  snapshotWith({
    issueGroups: [{ milestone, closedTitle: null, closedNumber: null, issues: [], claimsLinked: false }],
  })

test('an open milestone past its due date reads ⚠️ overdue after its 📅 due date, with its bar; a future date does not (ux-overdue)', () => {
  const late = milestoneSnapshot({ number: 40, title: 'Milestone L', openIssues: 1, closedIssues: 1, dueOn: '2026-10-01', countsExact: true, description: null })
  const lateTree = drawDesktop({ snapshot: late })
  expect(drawnTexts(lateTree)).toContain('▰▰▰▰▰▱▱▱▱▱ 50% · 1 of 2 issues closed · 📅 due 2026-10-01')
  // The marker sits on the heading after 🎯, never on the progress line (Mock S, delta 2).
  expect(drawnTexts(keyed(lateTree, 'milestone-40')).join('')).toContain('Milestone L ↗ 🎯 ⚠️')
  const future = milestoneSnapshot({ number: 40, title: 'Milestone L', openIssues: 1, closedIssues: 1, dueOn: '2026-11-30', countsExact: true, description: null })
  const futureTexts = drawnTexts(drawDesktop({ snapshot: future }))
  expect(futureTexts).toContain('▰▰▰▰▰▱▱▱▱▱ 50% · 1 of 2 issues closed · 📅 due 2026-11-30')
  expect(bodyTextsOf(drawDesktop({ snapshot: future })).some(text => text.includes('overdue'))).toBe(false)
})

test('a milestone with no open issue left, or with inexact counts, is never overdue, and inexact counts draw no bar', () => {
  const closed = milestoneSnapshot({ number: 41, title: 'Milestone C', openIssues: 0, closedIssues: 1, dueOn: '2026-10-01', countsExact: true, description: null })
  expect(bodyTextsOf(drawDesktop({ snapshot: closed })).some(text => text.includes('overdue'))).toBe(false)
  const inexact = milestoneSnapshot({ number: 42, title: 'Milestone I', openIssues: 1, closedIssues: 1, dueOn: '2026-10-01', countsExact: false, description: null })
  const inexactTexts = drawnTexts(drawDesktop({ snapshot: inexact }))
  expect(inexactTexts).toContain('1 of 2 items closed · 📅 due 2026-10-01')
  // The milestone's own progress line draws no bar (the hero's bar reads the open milestones, not this one).
  expect(inexactTexts.filter(text => text.includes('items closed')).some(text => text.includes('▰') || text.includes('▱'))).toBe(false)
})

// The sample snapshot with every session's repo page set, as a repo with a known remote draws it.
const linkedSnapshot = (): Snapshot => {
  const withPage = (node: SessionNode): SessionNode => ({
    ...node,
    repoPage: 'https://github.com/acme/app',
    children: node.children.map(withPage),
  })
  const base = snapshotWith()
  return { ...base, sessions: base.sessions.map(withPage) }
}

test('a session title opens its session on the desktop even with a known repo page, with no open-session link; plain on the terminal', () => {
  const desktop = JSON.stringify(drawDesktop({ snapshot: linkedSnapshot() }))
  expect(desktop).not.toContain('Synthetic session one](https://github.com/acme/app)')
  expect(desktop).not.toContain('open session')
  expect(desktop).toContain('Synthetic session one](#local_7f3a0001)')
  const terminal = JSON.stringify(drawTerminal({ snapshot: linkedSnapshot() }))
  expect(terminal).not.toContain('https://github.com/acme/app')
  expect(terminal).not.toContain('open session')
})

test('without a known remote no repo link is drawn and the title keeps its session link, as before', () => {
  const desktop = JSON.stringify(drawDesktop())
  expect(desktop).not.toContain('[open session]')
  expect(desktop).not.toContain('](https://github.com/acme/app)')
  expect(desktop).toContain('](#local_7f3a0001)')
})

test('a milestone heading links to its GitHub milestone page on the desktop, and a plain bold Text on the terminal', () => {
  const desktop = JSON.stringify(drawDesktop())
  expect(desktop).toMatch(/\]\(https:\/\/github\.com\/synthetic-owner\/synthetic-repo\/milestone\/\d+\)/)
  const terminal = JSON.stringify(drawTerminal())
  expect(terminal).not.toContain('/milestone/')
})

const REPO_PAGE = 'https://github.com/synthetic-owner/synthetic-repo'
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const PR_URL = `${REPO_PAGE}/pull/7`
// Markup and a newline in a name: escaped in the link text, which keeps every character.
const HOSTILE = 'Ship [v1] (beta) *now* \\ back\nnext'
const ESCAPED = 'Ship \\[v1\\] \\(beta\\) \\*now\\* \\\\ back next'

// The raw text of every Markdown block drawn, in order.
const markdownTextsOf = (tree: unknown): string[] =>
  nodesOf(tree)
    .filter(node => node.tag === 'Markdown')
    .map(node => String(node.props.text))

// The sample snapshot with this window's timeline and PR replaced, so a test names the events it draws.
const withWindowTimeline = (timeline: TimelineEvent[], overrides: Partial<Snapshot> = {}): Snapshot => {
  const base = snapshotWith(overrides)
  const [first = base.sessions[0], ...rest] = base.sessions
  return { ...base, sessions: [{ ...first, timeline } as SessionNode, ...rest] }
}

test('each milestone heading links to its own milestone page on the desktop: open, all closed and closed (pm1-9)', () => {
  const [, open, allClosed] = SAMPLE_MILESTONES
  const snapshot = snapshotWith({
    issueGroups: [
      { milestone: open, closedTitle: null, closedNumber: null, issues: SAMPLE_ISSUES.slice(0, 1), claimsLinked: false },
      { milestone: allClosed, closedTitle: null, closedNumber: null, issues: [], claimsLinked: false },
      { milestone: null, closedTitle: 'Old milestone', closedNumber: 40, issues: SAMPLE_ISSUES.slice(1, 2), claimsLinked: false },
    ],
  })
  const desktop = drawDesktop({ snapshot })
  expect(String(keyed(desktop, 'milestone-22')?.props.text)).toContain(`](${REPO_PAGE}/milestone/22)`)
  expect(String(keyed(desktop, 'milestone-21')?.props.text)).toContain(`](${REPO_PAGE}/milestone/21)`)
  expect(String(keyed(desktop, 'milestone-closed-Old milestone')?.props.text)).toContain(`](${REPO_PAGE}/milestone/40)`)
  expect(JSON.stringify(drawTerminal({ snapshot }))).not.toContain('/milestone/')
})

test('a hostile milestone name, commit subject, PR title and crumb label are escaped in their link text; the target stays as built', () => {
  const [, open] = SAMPLE_MILESTONES
  const hostile = { ...open, title: HOSTILE }
  const snapshot = withWindowTimeline(
    [
      { at: NOW, kind: 'commit', text: HOSTILE, url: `${REPO_PAGE}/commit/${COMMIT_SHA}` },
      { at: NOW - 1, kind: 'pr', text: `7 ${HOSTILE}`, url: PR_URL },
    ],
    {
      milestones: [hostile],
      issueGroups: [{ milestone: hostile, closedTitle: null, closedNumber: null, issues: SAMPLE_ISSUES.slice(0, 1), claimsLinked: false }],
    },
  )
  const [first] = snapshot.sessions
  const windowSession = { ...first, milestoneTitle: HOSTILE, milestoneNumber: 22, repoPage: REPO_PAGE } as SessionNode
  const desktop = drawDesktop({ snapshot: { ...snapshot, sessions: [windowSession, ...snapshot.sessions.slice(1)] } })
  expect(String(keyed(desktop, 'milestone-22')?.props.text)).toContain(`${ESCAPED} ↗ 🎯](${REPO_PAGE}/milestone/22)`)
  const texts = markdownTextsOf(desktop).join('\n')
  expect(texts).toContain(ESCAPED)
  expect(texts).toContain(`](${REPO_PAGE}/commit/${COMMIT_SHA})`)
  expect(texts).toContain(`](${PR_URL})`)
  expect(String(keyed(desktop, `crumb-${THIS_WINDOW}`)?.props.text)).toContain(`[${ESCAPED}](${REPO_PAGE}/milestone/22)`)
})

test('desktop: the commit event, the PR event and the PR detail line each link to their page; the terminal draws them plain', () => {
  const snapshot = withWindowTimeline(
    [
      { at: NOW, kind: 'commit', text: 'Synthetic commit', url: `${REPO_PAGE}/commit/${COMMIT_SHA}` },
      { at: NOW - 1, kind: 'pr', text: '7 Synthetic PR', url: PR_URL },
    ],
    { thisIssue: { ...SAMPLE_THIS_ISSUE, pr: { number: 7, title: 'Synthetic PR', state: 'OPEN', reviewDecision: null, url: PR_URL } } },
  )
  const desktop = drawDesktop({ snapshot })
  const texts = markdownTextsOf(desktop).join('\n')
  expect(texts).toContain(`](${REPO_PAGE}/commit/${COMMIT_SHA})`)
  expect(texts).toContain(`](${PR_URL})`)
  const prValue = nodesOf(keyed(desktop, 'detail-pr')).find(node => node.props.key === 'value')
  expect(String(prValue?.props.text)).toContain('#7 Synthetic PR')
  expect(String(prValue?.props.text)).toContain(`](${PR_URL})`)
  const terminal = JSON.stringify(drawTerminal({ snapshot }))
  expect(terminal).not.toContain(PR_URL)
  expect(terminal).not.toContain(`/commit/${COMMIT_SHA}`)
})

test('with two sessions of two origins, each title still opens its own session and no title links to a repo page', () => {
  const pages: Record<string, string> = {
    'Synthetic session one': 'https://github.com/acme/app',
    'Synthetic docs': 'https://gitlab.example.test/acme/app',
  }
  const withPage = (node: SessionNode): SessionNode => ({ ...node, repoPage: pages[node.title] ?? null, children: node.children.map(withPage) })
  const base = snapshotWith()
  const texts = markdownTextsOf(drawDesktop({ snapshot: { ...base, sessions: base.sessions.map(withPage) } })).join('\n')
  expect(texts).toMatch(/\[Synthetic session one\]\(#local_[0-9a-z-]+\)/)
  expect(texts).toMatch(/\[Synthetic docs\]\(#local_[0-9a-z-]+\)/)
  expect(texts).not.toContain('](https://github.com/acme/app)')
  expect(texts).not.toContain('](https://gitlab.example.test/acme/app)')
})

test('an exact milestone with no issue at all reads "no issues" with no done icon and no ready to close; one with closed issues still reads all closed', () => {
  const empty = milestoneSnapshot({ number: 50, title: 'Milestone E', openIssues: 0, closedIssues: 0, dueOn: null, countsExact: true, description: null })
  const texts = drawnTexts(drawDesktop({ snapshot: empty }))
  expect(texts).toContain('Milestone E ↗ 🎯 · no issues')
  expect(texts.some(text => text.includes('Milestone E') && text.includes('ready to close'))).toBe(false)
  expect(texts.some(text => text.startsWith('Milestone E ↗ ✅'))).toBe(false)
  expect(drawnTexts(drawDesktop({ snapshot: empty, lang: 'pt' }))).toContain('Milestone E ↗ 🎯 · sem issues')
  const closed = milestoneSnapshot({ number: 51, title: 'Milestone F', openIssues: 0, closedIssues: 2, dueOn: null, countsExact: true, description: null })
  expect(drawnTexts(drawDesktop({ snapshot: closed }))).toContain('Milestone F ↗ ✅ · all closed · ready to close')
})

test('the Last commit line links to its commit page on the desktop, and is plain text on the terminal', () => {
  const sha = 'a'.repeat(40)
  const commitUrl = `${REPO_PAGE}/commit/${sha}`
  const snapshot = snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, lastCommit: { at: 1, subject: 'Synthetic commit', url: commitUrl } } })
  expect(JSON.stringify(drawDesktop({ snapshot }))).toContain(`](${commitUrl})`)
  expect(JSON.stringify(drawTerminal({ snapshot }))).not.toContain('/commit/')
})

// The hero (Mock S, deltas 1 to 5). The pane reads Date.now(), so the due dates are counted from the real day.
const DAY = 24 * HOUR
const dayAt = (days: number, utcOffsetMinutes = 0): string => dateOf(Date.now() + days * DAY, utcOffsetMinutes)
// The hero's drawn texts, in order: the kicker, the risk chips, the count line and the bar line.
const heroTextsOf = (tree: unknown): string[] => {
  const hero = keyed(tree, 'hero')
  return hero === undefined ? [] : drawnTexts(hero)
}
const issueIn = (number: number, milestone: number): Issue => ({
  number,
  title: `Synthetic issue ${number}`,
  milestone,
  milestoneTitle: 'W15',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  url: `https://github.com/synthetic-owner/synthetic-repo/issues/${number}`,
})
const milestoneOf = (overrides: Partial<Milestone>): Milestone => ({
  number: 30,
  title: 'W15',
  openIssues: 2,
  closedIssues: 3,
  dueOn: null,
  countsExact: true,
  description: null,
  ...overrides,
})
// A snapshot whose one open milestone carries the given unlinked issues (its group), with no session.
const oneMilestone = (milestone: Milestone, issues: Issue[] = [], overrides: Partial<Snapshot> = {}): Snapshot =>
  snapshotWith({
    milestones: [milestone],
    issueGroups: [{ milestone, closedTitle: null, closedNumber: null, issues, claimsLinked: false }],
    sessions: [],
    ...overrides,
  })
// Sessions built at the fixed clock NOW, as the pane reads them with its own `now` (the state and the age both come from it).
const liveSessions = (records: SessionInput[]): SessionNode[] =>
  buildTree(records, { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this' })
// A session that stopped for the person (its Desktop summary says blocked), `hoursAgo` hours before now, with an issue or none.
const stoppedSession = (sessionId: string, issue: number | null, hoursAgo: number): SessionInput =>
  makeRecord({
    sessionId,
    cliSessionId: `cli-${sessionId}`,
    lastActivityAt: NOW - hoursAgo * HOUR,
    override: issue,
    postTurn: { blocked: true, needsAction: 'Approve it' },
  })

test('the hero draws the count in bold, then the bar with its percentage once, the issues left and the working sessions', () => {
  const working = buildTree([makeRecord({ sessionId: 'local_aaaa0601', lastActivityAt: Date.now() - MINUTE })], {
    now: Date.now(),
    cutoffMs: 24 * HOUR,
    thisCliSessionId: null,
  })
  const milestones = [
    milestoneOf({ number: 23, title: 'W14', openIssues: 6, closedIssues: 10 }),
    milestoneOf({ number: 22, title: 'W15', openIssues: 1, closedIssues: 0 }),
  ]
  const snapshot = snapshotWith({ milestones, issueGroups: [], sessions: working })
  const tree = drawDesktop({ snapshot })
  expect(heroTextsOf(tree)).toEqual(['10 of 17 closed in the open milestones', '▰▰▰▰▰▰▱▱▱▱ 59% · 7 left · 1 working'])
  expect(keyed(tree, 'hero-number')?.props.bold).toBe(true)
  expect(heroTextsOf(drawDesktop({ snapshot, lang: 'pt' }))).toEqual([
    '10 de 17 fechadas nos milestones abertos',
    '▰▰▰▰▰▰▱▱▱▱ 59% · faltam 7 · 1 trabalhando',
  ])
  expect(heroTextsOf(drawTerminal({ snapshot }))).toEqual(heroTextsOf(tree))
})

test('no open milestone, or a total of 0, reads the empty wording and the working sessions on one plain line, with no bar (pt-BR too)', () => {
  const none = drawDesktop({ snapshot: snapshotWith({ milestones: [], issueGroups: [], sessions: [] }) })
  expect(heroTextsOf(none)).toEqual(['no open milestone · 0 working'])
  expect(keyed(none, 'hero-number')?.props.bold).toBeUndefined()
  const zero = drawDesktop({ snapshot: oneMilestone(milestoneOf({ openIssues: 0, closedIssues: 0 })) })
  expect(heroTextsOf(zero)).toEqual(['no open milestone · 0 working'])
  expect(heroTextsOf(zero).join(' ')).not.toMatch(/[▰▱%]/)
  const zeroPt = drawDesktop({ snapshot: oneMilestone(milestoneOf({ openIssues: 0, closedIssues: 0 })), lang: 'pt' })
  expect(heroTextsOf(zeroPt)).toEqual(['nenhum milestone aberto · 0 trabalhando'])
})

test('inexact counts read the partial count, with no bar, no percentage and no "faltam"', () => {
  const texts = heroTextsOf(drawDesktop({ snapshot: oneMilestone(milestoneOf({ countsExact: false, openIssues: 4, closedIssues: 10 })) }))
  expect(texts).toEqual(['~10 of ~14 closed (partial count)', '0 working'])
})

test('an overdue milestone with open issues reads a chip with its count; the progress line and the boundaries carry no chip (Mock S, delta 2)', () => {
  const issues = [issueIn(41, 30), issueIn(42, 30)]
  const tree = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(-1) }), issues) })
  expect(heroTextsOf(tree)).toContain('⚠️ W15 overdue · 2 issues without session')
  expect(drawnTexts(tree).filter(text => text.includes('issues closed')).every(text => !text.includes('overdue') && !text.includes('⚠️'))).toBe(true)
  expect(drawnTexts(keyed(tree, 'milestone-30')).join('')).toContain('W15 ↗ 🎯 ⚠️')
  const pt = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(-1) }), issues), lang: 'pt' })
  expect(heroTextsOf(pt)).toContain('⚠️ W15 atrasado · 2 issues sem sessão')
  // Due today is not overdue: the date must fall before today.
  const today = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(0) }), issues) })
  expect(heroTextsOf(today).some(text => text.includes('overdue'))).toBe(false)
  // No open issue left, inexact counts, or a cut issue list: no chip.
  const late = dayAt(-1)
  expect(heroTextsOf(drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: late, openIssues: 0, closedIssues: 3 })) })).some(text => text.includes('overdue'))).toBe(false)
  expect(heroTextsOf(drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: late, countsExact: false, description: null }), issues) })).some(text => text.includes('overdue'))).toBe(false)
  expect(heroTextsOf(drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: late }), issues, { truncatedLimits: [500] }) })).some(text => text.includes('overdue'))).toBe(false)
})

test('a milestone due within 14 days reads a due-soon chip; today and 14 days ahead have one, 15 days ahead has none', () => {
  const issues = [issueIn(41, 30), issueIn(42, 30)]
  for (const [days, phrase] of [
    [0, 'due today'],
    [1, 'due in 1 day'],
    [14, 'due in 14 days'],
  ] as const) {
    const tree = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(days) }), issues) })
    expect(heroTextsOf(tree)).toContain(`📅 W15 ${phrase} · 2 issues without session`)
    expect(heroTextsOf(tree).some(text => text.includes('due in 0 days'))).toBe(false)
  }
  const ptTree = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(14) }), issues), lang: 'pt' })
  expect(heroTextsOf(ptTree)).toContain('📅 W15 vence em 14 dias · 2 issues sem sessão')
  const ptToday = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(0) }), issues), lang: 'pt' })
  expect(heroTextsOf(ptToday)).toContain('📅 W15 vence hoje · 2 issues sem sessão')
  const far = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(15) }), issues) })
  expect(heroTextsOf(far).some(text => text.includes('due in'))).toBe(false)
  const closed = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(3), openIssues: 0, closedIssues: 3 })) })
  expect(heroTextsOf(closed).some(text => text.includes('due in'))).toBe(false)
  const inexact = drawDesktop({ snapshot: oneMilestone(milestoneOf({ dueOn: dayAt(3), countsExact: false, description: null }), issues) })
  expect(heroTextsOf(inexact).some(text => text.includes('due in'))).toBe(false)
})

test('the host zone decides the day for overdue and due soon, and the 14-day window is inclusive at both ends', () => {
  const now = Date.parse('2026-10-30T23:30:00Z')
  // At 23:30 UTC it is already the 31st in a zone one hour ahead of UTC, and still the 30th in UTC.
  expect(isDueSoon('2026-10-31', now, 60)).toBe(true)
  expect(daysUntilDue('2026-10-31', now, 60)).toBe(0)
  expect(daysUntilDue('2026-10-31', now, 0)).toBe(1)
  expect(isOverdue('2026-10-30', now, 60)).toBe(true)
  expect(isOverdue('2026-10-30', now, 0)).toBe(false)
  expect(isDueSoon('2026-11-13', now, 0)).toBe(true)
  expect(isDueSoon('2026-11-14', now, 0)).toBe(false)
  expect(isDueSoon('2026-10-29', now, 0)).toBe(false)
  expect(isDueSoon('not a date', now, 0)).toBe(false)
})

test('the waiting chip counts the other sessions that stopped for the person, lists up to three issue numbers then +k, and ages the one', () => {
  const drawLive = (records: SessionInput[], lang: 'en' | 'pt' = 'en') =>
    drawDesktop({ snapshot: snapshotWith({ milestones: [], issueGroups: [], sessions: liveSessions(records) }), lang, now: NOW })
  expect(heroTextsOf(drawLive([stoppedSession('local_aaaa0701', 103, 3)]))).toContain('⏳ 1 stopped waiting for you · #103 · 3 h ago')
  expect(heroTextsOf(drawLive([stoppedSession('local_aaaa0701', 103, 3)], 'pt'))).toContain('⏳ 1 parou esperando você · #103 · há 3 h')
  const pair = [stoppedSession('local_aaaa0702', 103, 1), stoppedSession('local_aaaa0703', 97, 2)]
  expect(heroTextsOf(drawLive(pair))).toContain('⏳ 2 stopped waiting for you · #103, #97')
  expect(heroTextsOf(drawLive(pair, 'pt'))).toContain('⏳ 2 pararam esperando você · #103, #97')
  const four = [
    stoppedSession('local_aaaa0704', 103, 1),
    stoppedSession('local_aaaa0705', 97, 2),
    stoppedSession('local_aaaa0706', 91, 3),
    stoppedSession('local_aaaa0707', 88, 4),
  ]
  expect(heroTextsOf(drawLive(four))).toContain('⏳ 4 stopped waiting for you · #103, #97, #91 +1')
  // A session with no issue is counted, and lists no number.
  expect(heroTextsOf(drawLive([stoppedSession('local_aaaa0708', 103, 1), stoppedSession('local_aaaa0709', null, 2)]))).toContain(
    '⏳ 2 stopped waiting for you · #103',
  )
  expect(heroTextsOf(drawLive([stoppedSession('local_aaaa0710', null, 3)]))).toContain('⏳ 1 stopped waiting for you · 3 h ago')
  // This window never counts here, and with no waiting session there is no chip.
  const thisWindow = makeRecord({
    sessionId: 'local_aaaa0713',
    cliSessionId: 'cli-this',
    lastActivityAt: NOW - HOUR,
    override: 103,
    postTurn: { blocked: true, needsAction: 'Approve it' },
  })
  expect(heroTextsOf(drawLive([thisWindow])).some(text => text.includes('stopped waiting'))).toBe(false)
  expect(heroTextsOf(drawLive([])).some(text => text.includes('waiting'))).toBe(false)
  // An idle session (active within the day, no stop) draws no chip: idle stays on its row only (Mock S, delta 4).
  const idle = drawLive([makeRecord({ sessionId: 'local_aaaa0711', lastActivityAt: NOW - 3 * HOUR })])
  expect(heroTextsOf(idle).join(' ')).not.toContain('💤')
  // The age reads the session's last activity, clamped to now.
  expect(liveSessions([stoppedSession('local_aaaa0712', 103, 3)])[0]?.lastActivityAt).toBe(NOW - 3 * HOUR)
})

test('the hero is drawn in github mode only', () => {
  expect(keyed(drawTerminal({ snapshot: snapshotWith({ mode: 'no-github' }) }), 'hero')).toBeUndefined()
  expect(keyed(drawTerminal(), 'hero')).toBeDefined()
})

test('Decided follows Started in the window block only when the issue has a decision, in both languages (Mock S delta 8)', () => {
  const blockOf = (lang: 'en' | 'pt', decision: string | null): string[] =>
    drawnTexts(
      nodesOf(drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, decision } }), lang })).find(
        node => node.props.backgroundColor === DETAILS_FILL,
      ),
    )
  const decided = blockOf('en', 'DISK_FULL also in backup_receipt')
  expect(decided.indexOf('Decided:')).toBeGreaterThan(decided.indexOf('Started:'))
  expect(decided).toContain('DISK_FULL also in backup_receipt')
  expect(blockOf('en', null)).not.toContain('Decided:')
  expect(blockOf('pt', 'DISK_FULL também em backup_receipt')).toContain('Decidido:')
})

test('the milestone objective draws under its heading, before the progress line; no line when it has no description (Mock S delta 9)', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: oneMilestone(milestoneOf({ description: 'Preflight before install.' }), [issueIn(41, 30)]) }))
  const objective = texts.indexOf('Objective: Preflight before install.')
  const heading = texts.findIndex(text => text.includes('W15'))
  const progress = texts.findIndex(text => text.includes('issues closed'))
  expect(objective).toBeGreaterThan(heading)
  expect(objective).toBeLessThan(progress)
  expect(drawnTexts(drawDesktop({ snapshot: oneMilestone(milestoneOf({ description: null }), [issueIn(41, 30)]) })).some(text => text.startsWith('Objective:'))).toBe(false)
  const pt = drawnTexts(drawDesktop({ snapshot: oneMilestone(milestoneOf({ description: 'Preflight antes da instalação.' }), [issueIn(41, 30)]), lang: 'pt' }))
  expect(pt).toContain('Objetivo: Preflight antes da instalação.')
})

// Mock S delta 10: a ↗ after the title of a milestone where its link is drawn; the terminal draws none.
test('a milestone heading ends its title with ↗ where its link is drawn, the desktop only (Mock S delta 10)', () => {
  const snapshot = milestoneSnapshot({ number: 40, title: 'Milestone L', openIssues: 1, closedIssues: 0, dueOn: null, countsExact: true, description: null })
  expect(String(keyed(drawDesktop({ snapshot }), 'milestone-40')?.props.text)).toContain(`[Milestone L ↗ 🎯](${REPO_PAGE}/milestone/40)`)
  expect(drawnTexts(keyed(drawTerminal({ snapshot }), 'milestone-40'))).toEqual(['Milestone L 🎯'])
})

// Mock S delta 11, Q9 and Q17: the title is cut at the first " · ", then at 40 characters with the ellipsis counted, at the last space.
test('a milestone heading draws its title first, cut at the first " · " and at 40 characters with the ellipsis counted, then its icons (Mock S delta 11)', () => {
  const long = milestoneSnapshot({ number: 60, title: 'Preflight antes da instalação em disco cheio e montagem somente leitura · v2', openIssues: 1, closedIssues: 0, dueOn: null, countsExact: true, description: null })
  expect(drawnTexts(keyed(drawTerminal({ snapshot: long }), 'milestone-60'))).toEqual(['Preflight antes da instalação em disco… 🎯'])
  expect(String(keyed(drawDesktop({ snapshot: long }), 'milestone-60')?.props.text)).toContain('[Preflight antes da instalação em disco… ↗ 🎯](')
  const short = milestoneSnapshot({ number: 61, title: 'Milestone B · v2', openIssues: 1, closedIssues: 0, dueOn: null, countsExact: true, description: null })
  expect(drawnTexts(keyed(drawTerminal({ snapshot: short }), 'milestone-61'))).toEqual(['Milestone B 🎯'])
})

// Mock S delta 15: one muted note line under the Labels table explains ↗, ~, #n and the missing priority icon, as text, not as a row.
test('the legend ends with one muted note line that explains ↗, ~, #n and the missing priority icon, in both languages (Mock S delta 15)', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const draw of [drawDesktop, drawTerminal]) {
      const note = keyed(draw({ lang, legendOpen: true }), 'legend-note')
      expect(drawnTexts(note)).toEqual([t(lang, 'legend.note')])
      expect(note?.props.dimColor).toBe(true)
    }
  }
  expect(drawnTexts(keyed(drawTerminal({ legendOpen: true }), 'legend-note'))[0]).toContain('no priority icon: the issue has no priority label.')
  expect(drawnTexts(keyed(drawTerminal({ lang: 'pt', legendOpen: true }), 'legend-note'))[0]).toContain(
    'sem ícone de prioridade: a issue não tem label de prioridade.',
  )
})

// Mock S delta 15: a closed PR keeps its ☑️ in the body and in the Labels table; ❌ is in no row.
test('a closed PR draws ☑️ with its state word, and the Labels table explains it; no row draws ❌ (Mock S delta 15)', () => {
  const tree = drawDesktop({ snapshot: richSnapshot(), legendOpen: true })
  expect(drawnTexts(keyed(tree, 'legend')).join('')).toContain('☑')
  expect(bodyTextsOf(tree).some(text => text.includes('#111 Synthetic change · ☑️ closed'))).toBe(true)
  expect(drawnTexts(keyed(tree, 'legend')).join('')).not.toContain('❌')
})

// The legend is an accordion (SPEC section 19): closed by default, its button reads ▸ and no table or row is drawn. Open, the button
// reads ▾ and the table follows it. The store and the press are the register's (register.test.ts); the button only calls onLegendToggle.
test('the legend is closed by default: its button reads ▸ with its title, and no table or row is drawn, on both surfaces and languages', () => {
  for (const lang of ['en', 'pt'] as const) {
    for (const draw of [drawDesktop, drawTerminal]) {
      const tree = draw({ lang })
      expect(keyed(tree, 'legend-toggle')?.tag).toBe('Button')
      expect(keyed(tree, 'legend-toggle')?.props.label).toBe(`${DISCLOSURE_CLOSED} ${t(lang, 'legend.title')}`)
      expect(keyed(tree, 'legend')).toBeUndefined()
      expect(legendRowsOf(tree)).toEqual([])
      expect(keyed(tree, 'legend-note')).toBeUndefined()
    }
  }
  expect(keyed(drawDesktop(), 'legend-toggle')?.props.label).toBe('▸ Labels Descriptions')
})

test('the open legend: its button reads ▾ with the same title, and the table follows it with one row per entry', () => {
  for (const draw of [drawDesktop, drawTerminal]) {
    const tree = draw({ legendOpen: true })
    expect(keyed(tree, 'legend-toggle')?.props.label).toBe(`${DISCLOSURE_OPEN} Labels Descriptions`)
    expect(keyed(tree, 'legend')).toBeDefined()
    // The desktop trades the 3 timeline emoji rows for the line's 7 markers.
    expect(legendRowsOf(tree)).toHaveLength(draw === drawDesktop ? 22 : 18)
  }
})

test('the legend button calls onLegendToggle when pressed, on both surfaces', () => {
  for (const draw of [drawDesktop, drawTerminal]) {
    let presses = 0
    const onPress = keyed(draw({ onLegendToggle: () => (presses += 1) }), 'legend-toggle')?.props.onPress
    if (typeof onPress !== 'function') throw new Error('the legend button has no press handler')
    onPress()
    expect(presses).toBe(1)
  }
})

test('a redraw keeps the legend button and its press handle, and a press runs the latest handler', () => {
  const held = heldButtons()
  let first = 0
  let second = 0
  const before = keyed(drawDesktop({ held, onLegendToggle: () => (first += 1) }), 'legend-toggle')
  const after = keyed(drawDesktop({ held, onLegendToggle: () => (second += 1) }), 'legend-toggle')
  expect(after).toBe(before)
  const onPress = after?.props.onPress
  if (typeof onPress !== 'function') throw new Error('the legend button has no press handler')
  onPress()
  expect([first, second]).toEqual([0, 1])
})

// Mock S Q7: a group draws its first 20 top-level sessions; the rest sit behind one "+k more" line (pt-BR "+k mais"). 20 or fewer draw none.
test('a group past 20 top-level sessions draws the first 20 and a "+k more" line; 20 or fewer draw none (Mock S Q7)', () => {
  const sessionsOf = (count: number): SessionNode[] =>
    buildTree(
      Array.from({ length: count }, (_, index) =>
        makeRecord({ sessionId: `local_d${String(index).padStart(7, '0')}`, title: `Cap session ${index}`, lastActivityAt: NOW - (index + 1) * MINUTE }),
      ),
      { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS },
    )
  const over = drawTerminal({ snapshot: snapshotWith({ sessions: sessionsOf(25) }) })
  expect(titleRows(over)).toHaveLength(20)
  // A row's title carries its state icon after the name, so the name is matched as a prefix.
  expect(titleRows(over).some(row => row.startsWith('Cap session 19 '))).toBe(true)
  expect(titleRows(over).some(row => row.startsWith('Cap session 20 '))).toBe(false)
  expect(drawnTexts(over)).toContain('+5 more')
  expect(drawnTexts(drawTerminal({ snapshot: snapshotWith({ sessions: sessionsOf(25) }), lang: 'pt' }))).toContain('+5 mais')
  const exact = drawTerminal({ snapshot: snapshotWith({ sessions: sessionsOf(20) }) })
  expect(titleRows(exact)).toHaveLength(20)
  expect(drawnTexts(exact).some(text => /^\+\d+ more$/.test(text))).toBe(false)
})

test('a session waiting for the person under the 21st top of a group is drawn: the top ranks with its waiting child (Mock S Q7)', () => {
  const records = Array.from({ length: 21 }, (_, index) =>
    makeRecord({ sessionId: `local_d${String(index).padStart(7, '0')}`, title: `Cap session ${index}`, lastActivityAt: NOW - (index + 1) * MINUTE }),
  )
  records.push(
    makeRecord({
      sessionId: 'local_d9999999',
      title: 'Blocked fork',
      parentId: 'local_d0000020',
      parentKind: 'fork',
      lastActivityAt: NOW - MINUTE,
      postTurn: { blocked: true, needsAction: 'Approve the push' },
    }),
  )
  const sessions = buildTree(records, { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS })
  const tree = drawTerminal({ snapshot: snapshotWith({ sessions }) })
  expect(titleRows(tree).some(row => row.startsWith('Cap session 20 '))).toBe(true)
  expect(titleRows(tree).some(row => row.startsWith('Cap session 19 '))).toBe(false)
  expect(titleRows(tree).some(row => row.startsWith('Blocked fork '))).toBe(true)
  expect(drawnTexts(tree).some(text => text.includes('Approve the push'))).toBe(true)
})

test('a milestone heading is its title up to the first " · ", cut at 40 characters with the ellipsis counted (Mock S Q9)', () => {
  const milestone = { ...SAMPLE_MILESTONES[1], title: 'Preflight before install: refuse a full disk · and a read-only mount' }
  const issueGroups = [{ milestone, closedTitle: null, closedNumber: null, issues: SAMPLE_ISSUES.slice(0, 1), claimsLinked: false }]
  const texts = drawnTexts(drawTerminal({ snapshot: snapshotWith({ issueGroups }) }))
  expect(texts.some(text => text.startsWith('Preflight before install: refuse a…'))).toBe(true)
  expect(texts.some(text => text.includes('full disk') || text.includes('read-only'))).toBe(false)
})

// The timeline's current task and its Earlier accordion (SPEC section 22; owner's review, 2026-11-02).
const stepEvents = (count: number): TimelineEvent[] =>
  Array.from({ length: count }, (_, index) => ({ at: NOW - (index + 1) * MINUTE, kind: 'step' as const, text: `Step ${index + 1}`, url: null }))
const withCurrentTask = (snapshot: Snapshot, currentTask: string | null): Snapshot => {
  const [first = snapshot.sessions[0], ...rest] = snapshot.sessions
  return { ...snapshot, sessions: [{ ...first, currentTask } as SessionNode, ...rest] }
}

test('the current task is drawn as Now: <task> in English and Agora: <task> in Portuguese, and no line when there is none', () => {
  const snapshot = withCurrentTask(withWindowTimeline(stepEvents(1)), 'Fix the pane')
  expect(drawnTexts(drawTerminal({ snapshot }))).toContain('Now: Fix the pane')
  // The desktop line draws it as its own top row, the time replaced by the word, with the green marker.
  const desktop = drawDesktop({ snapshot, lang: 'pt' })
  expect(lineRowsOf(desktop)[0]).toEqual(['Agora', 'Fix the pane'])
  expect(keyed(desktop, `mark-${THIS_WINDOW}-0`)?.props.alt).toBe('in progress')
  const none = drawnTexts(drawTerminal({ snapshot: withCurrentTask(snapshot, null) }))
  expect(none.some(text => text.startsWith('Now:'))).toBe(false)
})

test('a step event draws its time and text with no kind glyph', () => {
  const row = keyed(drawTerminal({ snapshot: withWindowTimeline(stepEvents(1)) }), `event-${THIS_WINDOW}-0`)
  expect(drawnTexts(row)).toContain('Step 1')
  expect(nodesOf(row).some(node => node.props.key === 'glyph')).toBe(false)
})

test('the 7 newest events are drawn and the rest sit behind a closed Earlier (N) button', () => {
  const tree = drawTerminal({ snapshot: withWindowTimeline(stepEvents(10)) })
  const texts = drawnTexts(tree)
  for (const step of ['Step 1', 'Step 7']) expect(texts).toContain(step)
  for (const step of ['Step 8', 'Step 10']) expect(texts).not.toContain(step)
  expect(keyed(tree, `earlier-${THIS_WINDOW}`)?.props.label).toBe(`${DISCLOSURE_CLOSED} Earlier (3)`)
  const pt = drawTerminal({ snapshot: withWindowTimeline(stepEvents(10)), lang: 'pt' })
  expect(keyed(pt, `earlier-${THIS_WINDOW}`)?.props.label).toBe(`${DISCLOSURE_CLOSED} Anteriores (3)`)
})

test('an open session draws every event after a ▾ Earlier button, and a press calls onTimelineToggle with its id', () => {
  const pressed: string[] = []
  const tree = drawDesktop({
    snapshot: withWindowTimeline(stepEvents(10)),
    timelineOpen: new Set([THIS_WINDOW]),
    onTimelineToggle: id => pressed.push(id),
  })
  expect(lineTitlesOf(tree)).toContain('Step 10')
  const button = keyed(tree, `earlier-${THIS_WINDOW}`)
  expect(button?.props.label).toBe(`${DISCLOSURE_OPEN} Earlier (3)`)
  const onPress = button?.props.onPress
  if (typeof onPress !== 'function') throw new Error('the Earlier button has no press handler')
  onPress()
  expect(pressed).toEqual([THIS_WINDOW])
})

test('five events or fewer draw no Earlier button', () => {
  expect(keyed(drawTerminal({ snapshot: withWindowTimeline(stepEvents(5)) }), `earlier-${THIS_WINDOW}`)).toBeUndefined()
})

// The desktop line (SPEC section 24): one row per event, newest first, each marked by its kind.
const markedEvents = (): TimelineEvent[] => [
  { at: NOW - MINUTE, kind: 'commit', text: 'Fix the pane', url: null },
  { at: NOW - 2 * MINUTE, kind: 'pr', text: '7 Synthetic PR', url: null },
  { at: NOW - 3 * MINUTE, kind: 'session', text: '', url: null },
  { at: NOW - 4 * MINUTE, kind: 'step', text: 'Run the tests', url: null },
  { at: NOW - 5 * MINUTE, kind: 'commit', text: 'Release 1.2.0', url: null },
]
const lineOf = (tree: unknown): Drawn | undefined => keyed(tree, `timeline-${THIS_WINDOW}`)

test('markOf: a PR and a session event keep their kind; a release word wins over the commit kind; a test, a commit word or a plain step is marked as such', () => {
  const cases: [TimelineEvent, MarkKind][] = [
    [{ at: NOW, kind: 'pr', text: '7 Release notes', url: null }, 'pr'],
    [{ at: NOW, kind: 'session', text: '', url: null }, 'session'],
    [{ at: NOW, kind: 'commit', text: 'Publish 1.2.0', url: null }, 'release'],
    [{ at: NOW, kind: 'step', text: 'Release the build', url: null }, 'release'],
    [{ at: NOW, kind: 'commit', text: 'Fix the pane', url: null }, 'commit'],
    [{ at: NOW, kind: 'step', text: 'Commit the fix', url: null }, 'commit'],
    [{ at: NOW, kind: 'step', text: 'Run the e2e suite', url: null }, 'test'],
    [{ at: NOW, kind: 'step', text: 'Tests pass', url: null }, 'test'],
    [{ at: NOW, kind: 'step', text: 'Protest the change', url: null }, 'step'],
    [{ at: NOW, kind: 'step', text: 'Read the spec', url: null }, 'step'],
  ]
  for (const [event, kind] of cases) expect(markOf(event)).toBe(kind)
})

test('the desktop line alternates its rows left and right, marks each row by its kind, and draws a rule under every row but the last', () => {
  const tree = drawDesktop({ snapshot: withCurrentTask(withWindowTimeline(markedEvents()), null) })
  const rows = markedEvents().map((_, index) => keyed(tree, `tl-row-${THIS_WINDOW}-${index}`))
  expect(rows).toHaveLength(5)
  rows.forEach((row, index) => {
    const side = index % 2 === 0 ? 'left' : 'right'
    const other = index % 2 === 0 ? 'right' : 'left'
    expect(nodesOf(nodesOf(row).find(node => node.props.key === side)).some(node => node.tag === 'Markdown')).toBe(true)
    expect(nodesOf(nodesOf(row).find(node => node.props.key === other)).some(node => node.tag === 'Markdown')).toBe(false)
    expect(nodesOf(row).some(node => node.props.key === 'rule')).toBe(index < rows.length - 1)
  })
  const alts = rows.map((_, index) => keyed(tree, `mark-${THIS_WINDOW}-${index}`)?.props.alt)
  expect(alts).toEqual(['commit', 'pull request', 'session', 'test', 'release'])
})

test('the step in progress is marked in progress, and a current task that is one of the steps adds no row of its own', () => {
  const events: TimelineEvent[] = [
    { at: NOW - MINUTE, kind: 'step', text: 'Fix the pane', url: null },
    { at: NOW - 2 * MINUTE, kind: 'step', text: 'Read the spec', url: null },
  ]
  const tree = drawDesktop({ snapshot: withCurrentTask(withWindowTimeline(events), 'Fix the pane') })
  expect(lineTitlesOf(lineOf(tree))).toEqual(['Fix the pane', 'Read the spec'])
  expect(keyed(tree, `mark-${THIS_WINDOW}-0`)?.props.alt).toBe('in progress')
  expect(keyed(tree, `mark-${THIS_WINDOW}-1`)?.props.alt).toBe('step')
})

test('a current task with no step of its own is the first row, read Now in English, and the shown events stay above the Earlier button', () => {
  const tree = drawDesktop({ snapshot: withCurrentTask(withWindowTimeline(stepEvents(10)), 'Fix the pane') })
  expect(lineRowsOf(lineOf(tree))[0]).toEqual(['Now', 'Fix the pane'])
  expect(lineTitlesOf(lineOf(tree))).toEqual(['Fix the pane', 'Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6', 'Step 7'])
  expect(keyed(tree, 'line-earlier')).toBeUndefined()
  expect(keyed(tree, `earlier-${THIS_WINDOW}`)?.props.label).toBe(`${DISCLOSURE_CLOSED} Earlier (3)`)
  expect(keyed(tree, `mark-${THIS_WINDOW}-0`)?.props.alt).toBe('in progress')
})

test('a row\'s time is bold and its title italic, linked when the event has a page; its detail is dim Text, and only when it has one', () => {
  const commitUrl = `${REPO_PAGE}/commit/${COMMIT_SHA}`
  const events: TimelineEvent[] = [
    { at: NOW, kind: 'commit', text: 'Synthetic commit', url: commitUrl, detail: 'It was the cache.' },
    { at: NOW - MINUTE, kind: 'step', text: 'Run the tests', url: null },
  ]
  const tree = drawDesktop({ snapshot: withCurrentTask(withWindowTimeline(events), null) })
  // The time's colon is escaped as Markdown punctuation, so the pattern takes an optional backslash before it.
  expect(String(keyed(tree, `tl-title-${THIS_WINDOW}-0`)?.props.text)).toMatch(/^\*\*\d{2}\\?:\d{2}\*\* \*\[Synthetic commit\]\(https:\/\/.+\)\*$/)
  expect(String(keyed(tree, `tl-title-${THIS_WINDOW}-1`)?.props.text)).toMatch(/^\*\*\d{2}\\?:\d{2}\*\* \*Run the tests\*$/)
  const detail = keyed(tree, `tl-detail-${THIS_WINDOW}-0`)
  expect(detail?.props.dimColor).toBe(true)
  expect(textOf(detail)).toBe('It was the cache.')
  expect(keyed(tree, `tl-detail-${THIS_WINDOW}-1`)).toBeUndefined()
})

test('a step text typed as a Markdown link is escaped in the row title: it is drawn as its words, never as a link', () => {
  const events: TimelineEvent[] = [{ at: NOW, kind: 'step', text: '[click](https://evil.example.test) *now*', url: null }]
  const tree = drawDesktop({ snapshot: withCurrentTask(withWindowTimeline(events), null) })
  const raw = String(keyed(tree, `tl-title-${THIS_WINDOW}-0`)?.props.text)
  expect(raw).not.toMatch(/(?<!\\)\]\(https:\/\/evil/)
  expect(raw).toContain('\\[click\\]')
})

test('the terminal row draws its detail dimmed under the head row, and a row with no detail draws none', () => {
  const events: TimelineEvent[] = [
    { at: NOW, kind: 'commit', text: 'Synthetic commit', url: null, detail: 'It was the cache.' },
    { at: NOW - MINUTE, kind: 'step', text: 'Run the tests', url: null },
  ]
  const tree = drawTerminal({ snapshot: withWindowTimeline(events) })
  const children = keyed(tree, `event-${THIS_WINDOW}-0`)?.props.children as Drawn[]
  expect(children.map(child => child.props.key)).toEqual(['head', 'detail'])
  expect(children[1]?.props.dimColor).toBe(true)
  expect(textOf(children[1])).toBe('It was the cache.')
  expect(nodesOf(keyed(tree, `event-${THIS_WINDOW}-1`)).some(node => node.props.key === 'detail')).toBe(false)
})

test('a row with no title draws its time alone, with no italic marks', () => {
  // A commit with an empty subject: a session event is titled by its word ("started"), so it never has an empty title.
  const tree = drawDesktop({ snapshot: withCurrentTask(withWindowTimeline([{ at: NOW, kind: 'commit', text: '', url: null }]), null) })
  expect(String(keyed(tree, `tl-title-${THIS_WINDOW}-0`)?.props.text)).toMatch(/^\*\*\d{2}\\?:\d{2}\*\*$/)
})

test('each typed marker is filled with its own colour at 26 px, white icon inside; the step dot and the green now keep theirs (owner choice C)', () => {
  expect(TIMELINE_MARK_SIZE).toBe(26)
  const fillOf = (kind: MarkKind): string => /<circle cx="12" cy="12" r="(?:11|5)" fill="(#[0-9a-f]{6})"/.exec(timelineMarkSvg(kind))?.[1] ?? ''
  const typed: MarkKind[] = ['release', 'commit', 'test', 'pr', 'session']
  const fills = typed.map(fillOf)
  expect(new Set(fills).size).toBe(typed.length)
  expect(fills).not.toContain(fillOf('now'))
  expect(fills).not.toContain(fillOf('step'))
  for (const kind of typed) {
    expect(timelineMarkSvg(kind)).toContain('width="26" height="26"')
    expect(timelineMarkSvg(kind)).toContain('stroke="#ffffff"')
  }
})

test('a rule sits right under the header, as in AskAway User: a 1px SVG line across the pane on the desktop, a row of ─ on the terminal', () => {
  for (const draw of [drawDesktop, drawTerminal]) {
    const root = draw() as Drawn
    const children = (root.props.children as unknown[]).filter((child): child is Drawn => typeof child === 'object' && child !== null)
    expect(children[0]?.props.key).toBe('header')
    expect(children[1]?.props.key).toBe('header-rule')
  }
  const svg = keyed(drawDesktop(), 'header-rule')
  expect(svg?.tag).toBe('Svg')
  expect(svg?.props.alt).toBe('')
  expect(svg?.props.height).toBe(1)
  expect(svg?.props.width).toBeUndefined()
  expect(String(svg?.props.source)).toContain('width="4000" height="1"')
  const text = keyed(drawTerminal(), 'header-rule')
  expect(text?.tag).toBe('Text')
  expect(text?.props.dimColor).toBe(true)
  expect(textOf(text?.props.children)).toBe('─'.repeat(40))
})

test('each milestone of the issues section sits in its own bordered block, its heading and issues inside, on both surfaces', () => {
  for (const draw of [drawDesktop, drawTerminal]) {
    const tree = draw()
    const blocks = nodesOf(tree).filter(node => String(node.props.key).startsWith('milestone-block-'))
    expect(blocks.length).toBeGreaterThan(2)
    expect(new Set(blocks.map(node => node.props.key)).size).toBe(blocks.length)
    for (const block of blocks) {
      expect(block.props.borderStyle).toBe('round')
      expect(block.props.borderDimColor).toBe(true)
      expect(drawnTexts(block).length).toBeGreaterThan(0)
    }
    const none = blocks.find(node => node.props.key === 'milestone-block-none')
    expect(drawnTexts(none)).toContain('No milestone / issue')
  }
})
