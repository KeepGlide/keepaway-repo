import { expect, test } from 'claude-code/testing'
import { renderPane, type PaneContext } from '../hooks/pane'
import { TEXT_MAX, buildTree, groupIssues } from '../hooks/model'
import { DETAILS_FILL } from '../hooks/look'
import type { PaneError, Snapshot } from '../types'
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
    issueGroups: groupIssues(SAMPLE_MILESTONES, SAMPLE_ISSUES, SAMPLE_LINKED),
    openIssueCount: SAMPLE_ISSUES.length,
    thisIssue: SAMPLE_THIS_ISSUE,
    unreadableCount: 0,
    errors: [],
    stale: false,
    truncated: false,
    truncatedLimit: null,
    ...overrides,
  }
}

function contextWith(surface: string, overrides: Partial<PaneContext> = {}): PaneContext {
  return { snapshot: snapshotWith(), lang: 'en', surface, ...overrides }
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
  expect(blockTexts).toContain('Synthetic session one ↗ ← this window')
  expect(blockTexts).toContain('State:')
  expect(blockTexts).toContain('working')
  expect(blockTexts).toContain('Branch:')
  expect(blockTexts).toContain('fix/guard-write-sites')
  expect(blockTexts).toContain('Last commit:')
  expect(blockTexts.some(text => /^fix\(store\): map ENOSPC at backup_receipt writes · .+ ago$/.test(text))).toBe(true)
  expect(blockTexts).toContain('Started:')
  expect(blockTexts.some(text => /^\d\d:\d\d · .+ ago$/.test(text))).toBe(true)
})

test('the details of this window follow the breadcrumb, in the order of the mock, then the timeline and the GitHub link', () => {
  const block = nodesOf(drawDesktop()).find(node => node.props.backgroundColor === DETAILS_FILL)
  const blockTexts = drawnTexts(block)
  const labels = ['State:', 'Branch:', 'PR:', 'Last commit:', 'Checks:', 'Last comment:', 'Blocked by:', 'Next step:', 'Started:']
  const positions = labels.map(label => blockTexts.indexOf(label))
  expect(positions.every(position => position > -1)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  expect(blockTexts.indexOf('#106 · Milestone B') < (positions[0] ?? -1)).toBe(true)
  expect(blockTexts).toContain('no PR')
  expect(blockTexts).toContain('no CI')
  expect(blockTexts).toContain('nothing')
  expect(blockTexts).toContain('—')
  expect(blockTexts.some(text => /^dev-one · .+ ago · keep \*this\* \[markup\]\(x\) as text$/.test(text))).toBe(true)
  expect(blockTexts.indexOf('▪ Open #106 on GitHub ↗')).toBe(blockTexts.length - 1)
})

test('the GitHub link of this window is a Markdown https link on the desktop and plain text on the terminal', () => {
  const desktopBlock = nodesOf(drawDesktop()).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(sessionLinksIn(desktopBlock).length).toBe(1)
  expect(drawnTexts(desktopBlock)).toContain('▪ Open #106 on GitHub ↗')
  expect(nodesOf(desktopBlock).some(node => node.tag === 'Markdown' && String(node.props.text) === '▪ [Open #106 on GitHub ↗](https://github.com/synthetic-owner/synthetic-repo/issues/106)')).toBe(true)

  const terminalTexts = drawnTexts(drawTerminal())
  expect(terminalTexts).toContain('▪ Open #106 on GitHub ↗')
  expect(terminalTexts.some(text => text.includes('https://'))).toBe(false)
})

test('the breadcrumb carries the issue, its milestone and the origin; a window with no issue has no details and no link', () => {
  const texts = drawnTexts(drawDesktop())
  expect(texts).toContain('#106 · Milestone B')
  expect(texts).toContain('#106 · Milestone B · derived from #106')
  expect(texts).toContain('no issue · no milestone · derived')

  const noIssue = buildTree(
    sampleSessions().map(record => (record.sessionId === THIS_WINDOW ? { ...record, override: null } : record)),
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS },
  )
  const tree = drawDesktop({ snapshot: snapshotWith({ sessions: noIssue, thisIssue: null }) })
  const block = nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL)
  const blockTexts = drawnTexts(block)
  expect(blockTexts).toContain('no issue · no milestone')
  expect(blockTexts).not.toContain('State:')
  expect(blockTexts.some(text => text.startsWith('▪ Open #'))).toBe(false)
})

test('an issue whose details are not fetched keeps its link and draws no details block', () => {
  const tree = drawDesktop({ snapshot: snapshotWith({ thisIssue: null }) })
  const blockTexts = drawnTexts(nodesOf(tree).find(node => node.props.backgroundColor === DETAILS_FILL))
  expect(blockTexts).not.toContain('Branch:')
  expect(blockTexts).toContain('▪ Open #106 on GitHub ↗')
})

test('a last comment or a blocker is drawn as plain Text, never as Markdown', () => {
  const block = nodesOf(drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, blockedBy: 'Keep [x](y)?' } }) }))
    .find(node => node.props.backgroundColor === DETAILS_FILL)
  const plainTexts = nodesOf(block).filter(node => node.tag === 'Text').map(node => textOf(node.props.children))
  expect(plainTexts).toContain('Keep [x](y)?')
  expect(plainTexts.some(text => /^dev-one · .+ ago · keep \*this\* \[markup\]\(x\) as text$/.test(text))).toBe(true)
  expect(nodesOf(block).filter(node => node.tag === 'Markdown').every(node => !String(node.props.text).includes('keep'))).toBe(true)
})

test('the six session titles are links on the desktop and plain text on the terminal', () => {
  const desktopTexts = drawnTexts(drawDesktop())
  expect(sessionLinksIn(drawDesktop()).length).toBe(SIX_TITLES.length)
  for (const title of SIX_TITLES) {
    expect(desktopTexts.some(text => text.startsWith(title))).toBe(true)
  }

  const terminal = drawTerminal()
  expect(nodesOf(terminal).some(node => node.tag === 'Markdown')).toBe(false)
  expect(sessionLinksIn(terminal).length).toBe(0)
  const terminalTexts = drawnTexts(terminal)
  expect(terminalTexts).toContain('Synthetic session one ← this window')
  for (const title of SIX_TITLES.slice(1)) {
    expect(terminalTexts).toContain(title)
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
  expect(sessionLinksIn(tree)).toEqual(['[Fix \\[x\\]\\(y\\) \\*now\\* ↗](#local_aaaa1111)'])
})

test('derived rows nest under their parents, one level deeper, with branch glyphs', () => {
  const tree = drawDesktop()
  const texts = drawnTexts(tree)
  // The fork and the spawn are each the only child of their parent, so both carry the last-child glyph.
  expect(texts.filter(text => text === '└').length).toBe(2)
  expect(indentBefore(tree, 'session-local_c21d0002')).toBe(2)
  expect(indentBefore(tree, 'session-local_55c00006')).toBe(2)
  expect(indentBefore(tree, `session-${THIS_WINDOW}`)).toBe(0)
})

test('derived rows indent two cells per level, and a third level stays at the two-level cap (W1)', () => {
  const chain = [0, 1, 2, 3].map(index =>
    makeRecord({
      sessionId: `local_d${index}000000`,
      title: `Chain ${index}`,
      lastActivityAt: NOW - MINUTE,
      parentId: index === 0 ? null : `local_d${index - 1}000000`,
      parentKind: index === 0 ? null : 'fork',
    }),
  )
  const sessions = buildTree(chain, { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: null })
  const tree = renderPane(DESKTOP as never, contextWith('desktop', { snapshot: snapshotWith({ sessions }) }))
  expect(indentBefore(tree, 'session-local_d1000000')).toBe(2)
  expect(indentBefore(tree, 'session-local_d2000000')).toBe(4)
  expect(indentBefore(tree, 'session-local_d3000000')).toBe(4)
})

test('this window is marked by its tree node alone, and a waiting window says so', () => {
  const sessions = buildTree(
    sampleSessions().map(record => (record.sessionId === THIS_WINDOW ? { ...record, waiting: true } : record)),
    { now: NOW, cutoffMs: 24 * HOUR, thisCliSessionId: 'cli-this', issueFacts: SAMPLE_ISSUE_FACTS },
  )
  const block = nodesOf(drawDesktop({ snapshot: snapshotWith({ sessions }) })).find(node => node.props.backgroundColor === DETAILS_FILL)
  expect(drawnTexts(block)).toContain('waiting for you')
  expect(drawnTexts(block).some(text => text.includes('← this window'))).toBe(true)
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
  expect(drawnTexts(tree)).toContain('▪ Open #106 on GitHub ↗')
})

test('the records line is drawn only when a record could not be read (N1)', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ errors: ['records-unreadable'], unreadableCount: 0 }) }))
  expect(texts.some(text => text.includes('could not be read'))).toBe(false)
})

test('issue groups: open milestones by number, a milestone with no open issue as one line, no milestone last', () => {
  const texts = drawnTexts(drawDesktop())
  const at = (text: string): number => texts.indexOf(text)
  expect(at('Milestone B')).toBeGreaterThan(-1)
  expect(at('Milestone A')).toBeGreaterThan(-1)
  expect(at('Milestone Z · all closed · ready to close')).toBeGreaterThan(-1)
  expect(at('Milestone Z')).toBe(-1)
  expect(at('Milestone B') < at('Milestone A')).toBe(true)
  expect(at('Milestone A') < at('Milestone Z · all closed · ready to close')).toBe(true)
  expect(at('Milestone Z · all closed · ready to close') < at('No milestone / issue')).toBe(true)
})

test('an issue row links to its https page on the desktop only', () => {
  const desktop = drawDesktop()
  const links = nodesOf(desktop).filter(node => node.tag === 'Markdown').map(node => String(node.props.text))
  expect(links).toContain('▪ [#105 Synthetic issue 105](https://github.com/synthetic-owner/synthetic-repo/issues/105)')
  expect(drawnTexts(drawTerminal()).some(text => text.includes('https://'))).toBe(false)
})

test('the footer names the repo and the age of the snapshot', () => {
  const texts = drawnTexts(drawDesktop())
  expect(texts.some(text => /^Updated \d+ min ago · gh · synthetic-owner\/synthetic-repo$/.test(text))).toBe(true)
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
    'gh not found: showing sessions only',
    'gh is not signed in',
    'GitHub rate limit: showing the last data',
    'GitHub did not answer in time',
    'no GitHub remote for this repo',
    '2 session records could not be read',
    'git failed in this folder · sessions shown without branch',
  ]
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ errors, truncated: true, truncatedLimit: 100, unreadableCount: 2 }) }))
  for (const line of lines) expect(texts).toContain(line)
  expect(texts).toContain('list is partial (first 100)')
  const groupAt = texts.indexOf('Sessions on this machine')
  for (const line of lines) expect(texts.indexOf(line) < groupAt).toBe(true)
})

test('no-github mode draws the sessions and the no-remote line, and no issue section', () => {
  const texts = drawnTexts(
    drawDesktop({ snapshot: snapshotWith({ mode: 'no-github', repo: null, issueGroups: [], errors: ['no-remote'] }) }),
  )
  expect(texts).toContain('Sessions on this machine')
  expect(texts).toContain('no GitHub remote for this repo')
  expect(texts).not.toContain('Issues without session')
  expect(texts.some(text => /^Updated \d+ min ago · gh · —$/.test(text))).toBe(true)
})

test('a snapshot not yet read draws the loading line only', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: null }))
  expect(texts).toContain('Loading the repo...')
  expect(texts).not.toContain('Sessions on this machine')
})

test('F01: the partial-list line names the cap that was hit (100 PRs), not the open-issue count', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ truncated: true, truncatedLimit: 100 }) }))
  expect(texts).toContain('list is partial (first 100)')
  expect(texts).not.toContain(`list is partial (first ${SAMPLE_ISSUES.length})`)
})

test('F03: an unmapped gh failure draws its GitHub line and does not throw', () => {
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ errors: ['gh-failed'] }) }))
  expect(texts).toContain('GitHub did not answer as expected: showing the last data')
})

test('F10: a branch name in the details is drawn as plain text, capped like a title', () => {
  const branch = `feature/${'b'.repeat(250)}`
  const texts = drawnTexts(drawDesktop({ snapshot: snapshotWith({ thisIssue: { ...SAMPLE_THIS_ISSUE, branch } }) }))
  expect(texts).toContain(`${branch.slice(0, TEXT_MAX - 1)}…`)
  expect(texts).not.toContain(branch)
})
