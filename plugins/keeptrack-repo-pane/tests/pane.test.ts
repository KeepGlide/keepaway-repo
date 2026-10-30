import { expect, test } from 'claude-code/testing'
import { clockOf, dateOf, isOverdue, progressBarOf, renderPane, type PaneContext } from '../hooks/pane'
import { priorityEmoji, statusIconEmoji } from '../hooks/action-icons'
import { TEXT_MAX, buildTree, groupIssues, type DesktopGroups } from '../hooks/model'
import { t } from '../hooks/i18n'
import { DETAILS_FILL } from '../hooks/look'
import type { PaneError, SessionNode, Snapshot } from '../types'
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
  Text: fakeElement('Text'),
  Markdown: fakeElement('Markdown'),
  Svg: fakeElement('Svg'),
}
const TERMINAL = { Box: fakeElement('Box'), Text: fakeElement('Text') }

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

// Every text drawn, in order: one per Text, and one per Markdown block (its label).
const drawnTexts = (tree: unknown): string[] =>
  nodesOf(tree).flatMap(node => {
    if (node.tag === 'Text') return [textOf(node.props.children)]
    if (node.tag === 'Markdown') return [plainMarkdown(String(node.props.text))]
    return []
  })

// The Markdown blocks whose raw text carries a session link (`](#local_...)`).
const sessionLinksIn = (tree: unknown): string[] =>
  nodesOf(tree)
    .filter(node => node.tag === 'Markdown' && String(node.props.text).includes('](#local_'))
    .map(node => String(node.props.text))

// The element drawn with this key, if any.
const keyed = (tree: unknown, key: string): Drawn | undefined => nodesOf(tree).find(node => node.props.key === key)

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
  return { snapshot: snapshotWith(), lang: 'en', surface, utcOffsetMinutes: 0, ...overrides }
}

const drawDesktop = (overrides: Partial<PaneContext> = {}) =>
  renderPane(DESKTOP as never, contextWith('desktop', overrides))
const drawTerminal = (overrides: Partial<PaneContext> = {}) =>
  renderPane(TERMINAL as never, contextWith('terminal', overrides))

test('this window is the first session, in one highlighted block with its details and timeline', () => {
  const tree = drawDesktop()
  const texts = drawnTexts(tree)
  const firstTitle = texts.findIndex(text => text.startsWith('▶️ Synthetic session one'))
  const fork = texts.findIndex(text => text.startsWith('🔄 Synthetic fork'))
  expect(firstTitle).toBeGreaterThan(-1)
  expect(firstTitle < fork).toBe(true)

  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(block !== undefined).toBe(true)
  const blockTexts = drawnTexts(block)
  expect(texts).toContain('▶️ Synthetic session one ↗ ← this window')
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

// The header logo is decorative: the bold heading beside it already names the pane, so the picture has no alt text (ux4-14).
test('the header logo has an empty alt, since the heading beside it names the pane', () => {
  expect(keyed(drawDesktop(), 'logo')?.props.alt).toBe('')
})

// Session events in the timeline use their own glyph, not the link mark or the commit dot (ux4-20).
test('a session event in the timeline is drawn with the diamond glyph, not the link mark or the commit dot', () => {
  const glyphs = nodesOf(drawDesktop())
    .filter(node => node.props.key === 'glyph')
    .map(node => textOf(node.props.children))
  expect(glyphs).toContain('🚀')
  expect(glyphs).not.toContain('▪')
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
  expect(texts).toContain('🛠️ #106 · Milestone B · derived from #106')
  expect(texts).toContain('no issue · derived')

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
  expect(terminalTexts).toContain('▶️ Synthetic session one ← this window')
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
  expect(sessionLinksIn(tree)).toEqual(['🔄 [Fix \\[x\\]\\(y\\) \\*now\\* ↗](#local_aaaa1111)'])
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
  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))).toContain('Synthetic docs ↗')
  expect(drawnTexts(keyed(tree, 'head-local_9b040003'))[0]).toBe('└')
  expect(drawnTexts(keyed(tree, 'head-local_9b040003'))).toContain('Synthetic session three ↗')
  // Every session, a top or a derived one, is titled with its own link.
  expect(sessionLinksIn(tree).length).toBe(SIX_TITLES.length)
})

test('this window as a top of Recents: its titled row opens the highlighted block, with the glyphs and the marker', () => {
  const tree = drawDesktop()
  expect(sessionLinksIn(tree)[0]).toBe(`▶️ **[Synthetic session one ↗](#${THIS_WINDOW})** ← this window`)
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(drawnTexts(block).slice(0, 3)).toEqual(['├', '🟢 working', '▶️ Synthetic session one ↗ ← this window'])
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

  expect(drawnTexts(keyed(tree, `head-${THIS_WINDOW}`)).slice(0, 3)).toEqual([
    '├',
    '🟢 working',
    '▶️ Synthetic session one ↗ ← this window',
  ])
  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))[0]).toBe('└')
  expect(drawnTexts(keyed(tree, 'head-local_1a2b0005'))).toContain('Synthetic docs ↗')
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
  expect(sessionLinksIn(tree)).toEqual(['🔄 [Fork A ↗](#local_a0000002)', '🔄 [Spawn B ↗](#local_a0000003)'])
  expect(keyed(tree, 'session-local_a0000001') === undefined).toBe(true)
  expect(drawnTexts(keyed(tree, 'head-local_a0000002'))[0]).toBe('├')
  expect(drawnTexts(keyed(tree, 'head-local_a0000003'))[0]).toBe('└')
  expect(drawnTexts(keyed(tree, 'row-local_a0000002'))).toContain('forked from Archived planning')
  expect(drawnTexts(keyed(tree, 'row-local_a0000003'))).toContain('spawned from Archived planning')
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
  expect(sessionLinksIn(tree)).toEqual(['🔄 [Loose top ↗](#local_b0000003)'])
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
  expect(textOf(thisTitle?.props.children)).toBe('▶️ Synthetic session one ← this window')
})

test('this window is marked by its tree node alone, and a waiting window says so', () => {
  const sessions = buildTree(
    sampleSessions().map(record => (record.sessionId === THIS_WINDOW ? { ...record, waiting: true } : record)),
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS },
  )
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions }) })
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(drawnTexts(block)).toContain('waiting for you')
  expect(drawnTexts(tree).some(text => text.includes('← this window'))).toBe(true)
})

test('a derived session whose parent has no title says so without a name (W6)', () => {
  const orphan = buildTree([makeRecord({ sessionId: 'local_e0000001', parentId: 'local_e0000009', parentKind: 'fork' })], {
    now: NOW,
    cutoffMs: 24 * HOUR,
    thisCliSessionId: null,
  })
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ sessions: orphan }) }))
  expect(texts).toContain('forked')
  expect(texts.some(text => text.startsWith('forked from'))).toBe(false)
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
  expect(drawnTexts(tree)).toContain('▶️ Synthetic session one ↗ ← this window')
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

test('every session row pairs its state icon with the word of its own state, in both languages (ux4-1, rev-g1-7)', () => {
  for (const lang of ['en', 'pt'] as const) {
    const rows = nodesOf(drawDesktop({ lang }))
      .filter(node => node.tag === 'Text' && node.props.key === 'state')
      .map(node => textOf(node.props.children))
    const pairs = (Object.keys(STATE_KEYS) as (keyof typeof STATE_KEYS)[]).map(state => `${STATE_EMOJI[state]} ${t(lang, STATE_KEYS[state])}`)
    // The sample carries a working, an idle and a waiting session, so each pair must be drawn and no other pair may be.
    expect(rows.length).toBeGreaterThan(2)
    for (const pair of pairs) expect(rows).toContain(pair)
    for (const row of rows) expect(pairs).toContain(row)
  }
})

test('the records line names one unreadable record in the singular, in both languages (RP2)', () => {
  const snapshot = snapshotWith({ errors: ['records-unreadable'], unreadableCount: 1 })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('⚠️ 1 session record could not be read')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('⚠️ 1 registro de sessão não pôde ser lido')
})

test('issue groups: open milestones by due date, then by number, a milestone with no open issue as one line, no milestone last', () => {
  const texts = drawnTexts(drawDesktop())
  const at = (text: string): number => texts.indexOf(text)
  expect(at('🎯 Milestone B')).toBeGreaterThan(-1)
  expect(at('🎯 Milestone A')).toBeGreaterThan(-1)
  expect(at('✅ Milestone Z · all closed · ready to close')).toBeGreaterThan(-1)
  expect(at('Milestone Z')).toBe(-1)
  expect(at('🎯 Milestone A') < at('🎯 Milestone B')).toBe(true)
  expect(at('🎯 Milestone B') < at('✅ Milestone Z · all closed · ready to close')).toBe(true)
  expect(at('✅ Milestone Z · all closed · ready to close') < at('No milestone / issue')).toBe(true)
})

test('a milestone title is followed by its closed and total issues, in both languages (pm1-1)', () => {
  const texts = drawnTexts(drawDesktop())
  const at = (list: string[], text: string): number => list.indexOf(text)
  expect(texts[at(texts, '🎯 Milestone B') + 1]).toBe('▰▰▰▰▰▰▱▱▱▱ 63% · 10 of 16 issues closed')
  expect(texts[at(texts, '🎯 Milestone A') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 of 1 issue closed · 📅 due 2026-10-31')
  expect(texts[at(texts, '✅ Milestone Z · all closed · ready to close') + 1]).toBe('▰▰▰▰▰▰▰▰▰▰ 100% · 1 of 1 issue closed')
  const pt = drawnTexts(drawDesktop({ lang: 'pt' }))
  expect(pt[at(pt, '🎯 Milestone B') + 1]).toBe('▰▰▰▰▰▰▱▱▱▱ 63% · 10 de 16 issues fechadas')
  expect(pt[at(pt, '🎯 Milestone A') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 de 1 issue fechada · 📅 prazo 2026-10-31')
  expect(pt[at(pt, '✅ Milestone Z · todas fechadas · pronto para fechar') + 1]).toBe('▰▰▰▰▰▰▰▰▰▰ 100% · 1 de 1 issue fechada')
})

test('a milestone with one open issue on sessions reads its count in the singular, in both languages (ux4-16)', () => {
  const snapshot = snapshotWith({
    issueGroups: [
      {
        milestone: { number: 32, title: 'Milestone R', openIssues: 1, closedIssues: 0, dueOn: null, countsExact: true },
        closedTitle: null,
        issues: [],
        claimsLinked: true,
      },
    ],
  })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('🎯 Milestone R · 1 open, all in sessions')
  const pt = drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))
  expect(pt).toContain('🎯 Milestone R · 1 aberta, todas em sessões')
  expect(pt[pt.indexOf('🎯 Milestone R · 1 aberta, todas em sessões') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 de 1 issue fechada')
})

test('an open milestone whose open issues all sit on sessions names them, with its progress (pm1-2)', () => {
  const snapshot = snapshotWith({
    issueGroups: [
      {
        milestone: { number: 31, title: 'Milestone Q', openIssues: 2, closedIssues: 1, dueOn: null, countsExact: true },
        closedTitle: null,
        issues: [],
        claimsLinked: true,
      },
    ],
  })
  const texts = drawnTexts(drawDesktop({ snapshot }))
  const at = texts.indexOf('🎯 Milestone Q · 2 open, all in sessions')
  expect(at).toBeGreaterThan(-1)
  expect(texts[at + 1]).toBe('▰▰▰▱▱▱▱▱▱▱ 33% · 1 of 3 issues closed')
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))).toContain('🎯 Milestone Q · 2 abertas, todas em sessões')
})

test('rev-g1-5: a one-line milestone whose list does not back its count draws its title and progress, without the claim', () => {
  const snapshot = snapshotWith({
    issueGroups: [
      {
        milestone: { number: 33, title: 'Milestone S', openIssues: 2, closedIssues: 0, dueOn: null, countsExact: true },
        closedTitle: null,
        issues: [],
        claimsLinked: false,
      },
    ],
  })
  const texts = drawnTexts(drawDesktop({ snapshot }))
  expect(texts[texts.indexOf('🎯 Milestone S') + 1]).toBe('▱▱▱▱▱▱▱▱▱▱ 0% · 0 of 2 issues closed')
  expect(texts.some(text => text.includes('all in sessions'))).toBe(false)
  expect(drawnTexts(drawDesktop({ snapshot, lang: 'pt' })).some(text => text.includes('em sessões'))).toBe(false)
})

test('pm1-9: the issues of a closed milestone sit under its title, marked closed, in both languages', () => {
  const snapshot = snapshotWith({
    issueGroups: [{ milestone: null, closedTitle: 'Milestone Y', issues: SAMPLE_ISSUES.slice(0, 1), claimsLinked: false }],
  })
  expect(drawnTexts(drawDesktop({ snapshot }))).toContain('✅ Milestone Y · closed')
  const pt = drawnTexts(drawDesktop({ snapshot, lang: 'pt' }))
  expect(pt).toContain('✅ Milestone Y · fechado')
  expect(pt).not.toContain('Sem milestone / issue')
})

test('an issue row links to its https page on the desktop only', () => {
  const desktop = drawDesktop()
  const links = nodesOf(desktop).filter(node => node.tag === 'Markdown').map(node => String(node.props.text))
  expect(links).toContain('▪ [#105 Synthetic issue 105](https://github.com/synthetic-owner/synthetic-repo/issues/105)')
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
  expect(texts.some(text => text.startsWith('▶️ Synthetic session one'))).toBe(true)
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
  expect(texts).not.toContain('⏳ Loading the repo...')
  expect(drawnTexts(drawDesktop({ snapshot: null, loadFailed: true, lang: 'pt' }))).toContain('❌ Não foi possível ler o repo: estado desconhecido')
})

test('a snapshot not yet read draws the loading line only', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: null }))
  expect(texts).toContain('⏳ Loading the repo...')
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
  expect(texts.some(text => text.includes('open issue'))).toBe(false)
  expect(texts.some(text => /^\S+ \d+ sessions?$/.test(text))).toBe(true)
})

test('the open-issue count is marked "+" only when the issue list is cut (ux-4)', () => {
  const cut = drawnTexts(drawDesktop({ snapshot: snapshotWith({ openIssueCount: 500, truncated: true, truncatedLimits: [500] }) }))
  expect(cut.some(text => text.startsWith('📋 500+ open issues · '))).toBe(true)
  const whole = drawnTexts(drawDesktop({ snapshot: snapshotWith({ openIssueCount: 500 }) }))
  expect(whole.some(text => text.startsWith('📋 500 open issues · '))).toBe(true)
})

test('an inexact milestone count is counted in items, not issues, in both languages (ux-5)', () => {
  const inexact = [{ number: 40, title: 'Milestone I', openIssues: 6, closedIssues: 4, dueOn: null, countsExact: false }]
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
  return snapshotWith({ issueGroups: [{ milestone: null, closedTitle: null, issues, claimsLinked: false }] })
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
  const milestone = { number: 22, title: 'Milestone D', openIssues: 1, closedIssues: 0, dueOn: '2025-10-31T00:00:00Z', countsExact: true }
  const snapshot = snapshotWith({ issueGroups: [{ milestone, closedTitle: null, issues: [], claimsLinked: true }] })
  const texts = drawnTexts(drawDesktop({ snapshot, utcOffsetMinutes: -180 }))
  expect(texts.some(text => text.includes('2025-10-31'))).toBe(true)
  expect(texts.some(text => text.includes('2025-10-30'))).toBe(false)
})

// The icon vocabulary (action-icons.ts): the marker, the timeline, the due date and the priority tags are pinned by their emoji here.
test('active rows carry a marker: this window ▶️, a session working now 🔄, an idle row none', () => {
  const texts = drawnTexts(drawTerminal())
  expect(texts).toContain('▶️ Synthetic session one ← this window')
  expect(texts).toContain('🔄 Synthetic fork')
  expect(texts).toContain('Synthetic docs')
  expect(statusIconEmoji('activeWindow')).toBe('▶️')
  expect(statusIconEmoji('activeSession')).toBe('🔄')
})

test('the timeline has a 🕘 heading, and its events carry the icon of their kind: PR 🔀, session 🚀', () => {
  const texts = drawnTexts(drawTerminal())
  expect(texts).toContain('🕘 Timeline')
  expect(texts).toContain('🔀')
  expect(texts).toContain('🚀')
  expect(statusIconEmoji('history')).toBe('🕘')
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
    issueGroups: [{ milestone, closedTitle: null, issues: [], claimsLinked: false }],
  })

test('an open milestone past its due date reads ⚠️ overdue after its 📅 due date, with its bar; a future date does not (ux-overdue)', () => {
  const late = milestoneSnapshot({ number: 40, title: 'Milestone L', openIssues: 1, closedIssues: 1, dueOn: '2026-10-01', countsExact: true })
  expect(drawnTexts(drawDesktop({ snapshot: late }))).toContain('▰▰▰▰▰▱▱▱▱▱ 50% · 1 of 2 issues closed · 📅 due 2026-10-01 · ⚠️ overdue')
  const future = milestoneSnapshot({ number: 40, title: 'Milestone L', openIssues: 1, closedIssues: 1, dueOn: '2026-11-30', countsExact: true })
  const futureTexts = drawnTexts(drawDesktop({ snapshot: future }))
  expect(futureTexts).toContain('▰▰▰▰▰▱▱▱▱▱ 50% · 1 of 2 issues closed · 📅 due 2026-11-30')
  expect(futureTexts.some(text => text.includes('overdue'))).toBe(false)
})

test('a milestone with no open issue left, or with inexact counts, is never overdue, and inexact counts draw no bar', () => {
  const closed = milestoneSnapshot({ number: 41, title: 'Milestone C', openIssues: 0, closedIssues: 1, dueOn: '2026-10-01', countsExact: true })
  expect(drawnTexts(drawDesktop({ snapshot: closed })).some(text => text.includes('overdue'))).toBe(false)
  const inexact = milestoneSnapshot({ number: 42, title: 'Milestone I', openIssues: 1, closedIssues: 1, dueOn: '2026-10-01', countsExact: false })
  const inexactTexts = drawnTexts(drawDesktop({ snapshot: inexact }))
  expect(inexactTexts).toContain('1 of 2 items closed · 📅 due 2026-10-01')
  expect(inexactTexts.some(text => text.includes('▰') || text.includes('▱'))).toBe(false)
})
