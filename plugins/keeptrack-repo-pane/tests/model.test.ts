import { expect, test } from 'claude-code/testing'
import type { IssueRef, SessionNode } from '../types'
import {
  FIELD_MAX_LENGTH,
  MAX_DEPTH,
  RECORD_MAX_BYTES,
  WORKING_WINDOW_MS,
  buildTree,
  groupIssues,
  isSessionLinkId,
  issueFromBranch,
  issueFromTitle,
  isGithubHost,
  issueOfSession,
  mapLimited,
  parseRemote,
  plain,
  projectRecord,
  stateOf,
  timelineOf,
} from '../hooks/model'
import {
  HOUR,
  MINUTE,
  NOW,
  SAMPLE_ISSUES,
  SAMPLE_LINKED,
  SAMPLE_MILESTONES,
  makePr,
  makeRawRecord,
  makeRecord,
  sampleSessions,
} from './fixtures/sample'

const OPTS = { now: NOW, cutoffMs: 72 * HOUR, thisCliSessionId: null }

// Every node of a tree, parents before children.
const flatten = (nodes: SessionNode[]): SessionNode[] => nodes.flatMap(node => [node, ...flatten(node.children)])

// The issue numbers and milestone keys of each group, in order (null milestone = the last group).
const shapeOf = (groups: ReturnType<typeof groupIssues>): [number | null, number[]][] =>
  groups.map(group => [group.milestone?.number ?? null, group.issues.map(issue => issue.number)])

// parseRemote: https, ssh, scp-like, alias, credentials, port, .git on and off, and the invalid forms.
const REMOTE_CASES: [string | null, { owner: string; name: string } | null][] = [
  ['https://github.com/acme/widgets', { owner: 'acme', name: 'widgets' }],
  ['https://github.com/acme/widgets.git', { owner: 'acme', name: 'widgets' }],
  ['https://github.com/acme/widgets/', { owner: 'acme', name: 'widgets' }],
  ['https://github.com/acme/widgets.git/', { owner: 'acme', name: 'widgets' }],
  ['https://user:hunter2@github.com/acme/widgets.git', { owner: 'acme', name: 'widgets' }],
  ['https://token123@github.com/acme/widgets', { owner: 'acme', name: 'widgets' }],
  ['https://git.example.test:8443/acme/widgets', { owner: 'acme', name: 'widgets' }],
  ['ssh://git@github.com/acme/widgets.git', { owner: 'acme', name: 'widgets' }],
  ['ssh://git@github.com:2222/acme/widgets', { owner: 'acme', name: 'widgets' }],
  ['git@github.com:acme/widgets.git', { owner: 'acme', name: 'widgets' }],
  ['git@gh-work:acme/widgets', { owner: 'acme', name: 'widgets' }],
  ['work-alias:acme/widgets.git', { owner: 'acme', name: 'widgets' }],
  ['  https://github.com/acme/widgets.git\n', { owner: 'acme', name: 'widgets' }],
  [null, null],
  ['', null],
  ['http://github.com/acme/widgets', null],
  ['git://github.com/acme/widgets', null],
  ['https://github.com/acme', null],
  ['https://github.com/acme/widgets/extra', null],
  ['https://github.com/acme/..', null],
  ['/srv/git/widgets.git', null],
  ['https://github.com/acme/wid gets', null],
]

test('parseRemote reads owner and name from every accepted form and returns null for the rest', () => {
  for (const [url, expected] of REMOTE_CASES) {
    const remote = parseRemote(url)
    expect(remote === null ? null : { owner: remote.owner, name: remote.name }).toEqual(expected)
  }
})

test('parseRemote gives the host in lower case; a GitHub host is github.com or an alias that names it (S4)', () => {
  expect(parseRemote('https://GitHub.com/acme/widgets')?.host).toBe('github.com')
  expect(parseRemote('git@github-ask-sophia-now:acme/widgets.git')?.host).toBe('github-ask-sophia-now')
  expect(isGithubHost('github.com')).toBe(true)
  expect(isGithubHost('github-ask-sophia-now')).toBe(true)
  expect(isGithubHost('gh-work')).toBe(false)
  expect(isGithubHost('gitlab.example.test')).toBe(false)
})

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

test('plain removes control characters, escape and OSC sequences included, and caps the length (S2)', () => {
  const hostile = 'Fix\u001b]8;;https://evil.example/\u0007link\u001b]8;;\u0007 \u001b[31mred\u001b[0m\tdone\u009b'
  const text = plain(hostile, 200)
  expect(Array.from(text).some(isControl)).toBe(false)
  expect(text.includes('link') && text.endsWith('done')).toBe(true)
  expect(plain('a'.repeat(250), 200)).toBe('a'.repeat(199) + '…')
  expect(plain('  spaced\nout  ', 200)).toBe('spaced out')
})

test('plain removes Unicode format characters such as bidi overrides and isolates, and keeps the joiners of an emoji sequence (F09)', () => {
  expect(plain('abc\u202Edef', 200)).not.toContain('\u202E')
  expect(plain('x\u2066y\u2069z', 200)).not.toMatch(/[\u2066\u2069]/)
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
  expect(plain(family, 200)).toBe(family)
})

test('mapLimited runs at most the limit of calls at once and keeps the order of the results', async () => {
  let inFlight = 0
  let peak = 0
  const results = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async value => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await Promise.resolve()
    inFlight -= 1
    return value * 2
  })
  expect(results).toEqual([2, 4, 6, 8, 10, 12, 14])
  expect(peak).toBeLessThanOrEqual(3)
})

test('projectRecord keeps a working copy path only when it is absolute, and caps the title (S2, S5)', () => {
  expect(projectRecord(makeRawRecord({ cwd: 'relative/dir' }))?.cwd).toBeNull()
  expect(projectRecord(makeRawRecord({ cwd: '-c' }))?.cwd).toBeNull()
  const projected = projectRecord(makeRawRecord({ title: '\u001b]0;evil\u0007' + 'x'.repeat(300) }))
  expect(projected?.title.length).toBeLessThanOrEqual(200)
  expect(projected?.title.includes('\u001b')).toBe(false)
})

test('projectRecord counts a text field in characters, not UTF-16 units: 2100 emoji are kept (F20)', () => {
  const projected = projectRecord(makeRawRecord({ title: '\u{1F600}'.repeat(2100) }))
  expect(projected).not.toBeNull()
  expect(projected?.title).toBe('\u{1F600}'.repeat(199) + '…')
})

test('buildTree: an archived session shown as an ancestor is idle, even with recent activity (W6)', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0140', isArchived: true, lastActivityAt: NOW - MINUTE })
  const child = makeRecord({ sessionId: 'local_aaaa0141', parentId: 'local_aaaa0140', parentKind: 'fork' })
  const [root] = buildTree([parent, child], OPTS)
  expect(root?.state).toBe('idle')
  expect(root?.children[0]?.id).toBe('local_aaaa0141')
})

test('parseRemote never returns the credentials of a URL', () => {
  expect(JSON.stringify(parseRemote('https://user:hunter2@github.com/acme/widgets.git'))).not.toContain('hunter2')
})

// issueFromBranch: the leading number after an optional prefix, else an issue-<n> word.
const BRANCH_CASES: [string, number | null][] = [
  ['fix/106-disk-full', 106],
  ['106-fix', 106],
  ['user/42-thing', 42],
  ['feature/issue-97-x', 97],
  ['Issue-97', 97],
  ['fix/999999-big', 999999],
  ['fix/disk-full-write-sites', null],
  ['reissue-97', null],
  ['issue-97x', null],
  ['fix/1234567-x', null],
  ['fix/1000000-x', null],
  ['fix/0-x', null],
  ['release/v1.2-3', null],
  ['feature/x-106-y', null],
  ['', null],
]

test('issueFromBranch maps each branch shape to its issue number or null', () => {
  for (const [branch, expected] of BRANCH_CASES) expect(issueFromBranch(branch)).toBe(expected)
})

// issueFromTitle: the first hash-number reference of the title.
const TITLE_CASES: [string, number | null][] = [
  ['Fix #106 disk full', 106],
  ['Refs #97, #103', 97],
  ['issue#5', 5],
  ['#1234567', null],
  ['#0 nothing', null],
  ['Price #12abc', null],
  ['no reference here', null],
  ['', null],
]

test('issueFromTitle maps each title shape to its issue number or null', () => {
  for (const [title, expected] of TITLE_CASES) expect(issueFromTitle(title)).toBe(expected)
})

// issueOfSession precedence matrix (repo-work-pane-design-spec.md D1): each pair of conflicting signals, the first one wins.
const NONE = { override: null, pr: null, branch: null, title: 'Untitled', parentIssue: null, isDerived: false }
const PARENT_106: IssueRef = { number: 106, source: 'branch' }

test('issueOfSession: an override beats an open PR closing reference', () => {
  const pr = makePr({ headRefName: 'fix/x', closes: [106] })
  expect(issueOfSession({ ...NONE, override: 5, pr, branch: 'fix/x' })).toEqual({ number: 5, source: 'override' })
})

test('issueOfSession: a PR closing reference beats the branch number', () => {
  const pr = makePr({ headRefName: 'fix/200-y', closes: [106] })
  expect(issueOfSession({ ...NONE, pr, branch: 'fix/200-y' })).toEqual({ number: 106, source: 'pr' })
})

test('issueOfSession: several closed issues give the lowest number', () => {
  const pr = makePr({ headRefName: 'fix/x', closes: [120, 106] })
  expect(issueOfSession({ ...NONE, pr, branch: 'fix/x' })).toEqual({ number: 106, source: 'pr' })
})

test('issueOfSession: a merged PR gives no issue (F22); a closed PR and a PR on another head do not', () => {
  const merged = makePr({ state: 'MERGED', headRefName: 'fix/x', closes: [106] })
  expect(issueOfSession({ ...NONE, pr: merged, branch: 'fix/x' })).toBeNull()
  const closed = makePr({ state: 'CLOSED', headRefName: 'fix/x', closes: [106] })
  expect(issueOfSession({ ...NONE, pr: closed, branch: 'fix/200-y' })).toEqual({ number: 200, source: 'branch' })
  const other = makePr({ headRefName: 'other', closes: [106] })
  expect(issueOfSession({ ...NONE, pr: other, branch: 'fix/200-y' })).toEqual({ number: 200, source: 'branch' })
})

test('issueOfSession: a branch number beats a title reference', () => {
  expect(issueOfSession({ ...NONE, branch: 'fix/200-y', title: 'Ref #106' })).toEqual({ number: 200, source: 'branch' })
})

test('issueOfSession: a title reference is used when the branch names no issue', () => {
  expect(issueOfSession({ ...NONE, branch: 'fix/no-number', title: 'Ref #106' })).toEqual({ number: 106, source: 'title' })
})

test('issueOfSession: the parent issue is used only for a derived session', () => {
  expect(issueOfSession({ ...NONE, parentIssue: PARENT_106, isDerived: false })).toBeNull()
  expect(issueOfSession({ ...NONE, parentIssue: PARENT_106, isDerived: true })).toEqual({ number: 106, source: 'parent' })
})

test('issueOfSession: the own steps beat the parent, and the title beats the parent', () => {
  const derived = { ...NONE, parentIssue: PARENT_106, isDerived: true }
  expect(issueOfSession({ ...derived, branch: 'fix/200-y' })).toEqual({ number: 200, source: 'branch' })
  expect(issueOfSession({ ...derived, title: 'Ref #300' })).toEqual({ number: 300, source: 'title' })
  expect(issueOfSession({ ...derived, override: 7 })).toEqual({ number: 7, source: 'override' })
})

test('issueOfSession: nothing to map gives null, and a derived session without a parent issue too', () => {
  expect(issueOfSession(NONE)).toBeNull()
  expect(issueOfSession({ ...NONE, isDerived: true, parentIssue: null })).toBeNull()
})

test('buildTree: a root is a single node at depth 0 with no parent and no children', () => {
  const [root] = buildTree([makeRecord({ sessionId: 'local_aaaa0001' })], OPTS)
  expect(root?.kind).toBe('root')
  expect(root?.depth).toBe(0)
  expect(root?.parentId).toBeNull()
  expect(root?.children).toHaveLength(0)
  expect(buildTree([makeRecord({ sessionId: 'local_aaaa0001' })], OPTS)).toHaveLength(1)
})

test('buildTree: a fork nests under its parent with kind fork and depth 1', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0010' })
  const child = makeRecord({ sessionId: 'local_aaaa0011', parentId: 'local_aaaa0010', parentKind: 'fork' })
  const roots = buildTree([parent, child], OPTS)
  expect(roots).toHaveLength(1)
  expect(roots[0]?.id).toBe('local_aaaa0010')
  expect(roots[0]?.children[0]?.id).toBe('local_aaaa0011')
  expect(roots[0]?.children[0]?.kind).toBe('fork')
  expect(roots[0]?.children[0]?.depth).toBe(1)
  expect(roots[0]?.children[0]?.parentId).toBe('local_aaaa0010')
})

test('buildTree: a spawn nests under its parent with kind spawn', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0020', title: 'Synthetic docs' })
  const child = makeRecord({ sessionId: 'local_aaaa0021', parentId: 'local_aaaa0020', parentKind: 'spawn', parentTitle: 'Synthetic docs' })
  const roots = buildTree([parent, child], OPTS)
  expect(roots[0]?.children[0]?.kind).toBe('spawn')
  expect(roots[0]?.children[0]?.depth).toBe(1)
})

test('buildTree: an archived parent of a kept child is added, as the ancestor of the child', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0030', isArchived: true, lastActivityAt: NOW - 100 * HOUR })
  const child = makeRecord({ sessionId: 'local_aaaa0031', parentId: 'local_aaaa0030', parentKind: 'fork' })
  const roots = buildTree([parent, child], OPTS)
  expect(roots).toHaveLength(1)
  expect(roots[0]?.id).toBe('local_aaaa0030')
  expect(roots[0]?.children[0]?.id).toBe('local_aaaa0031')
})

test('buildTree: a parent missing from the input promotes the child to a root, keeping its kind', () => {
  const child = makeRecord({ sessionId: 'local_aaaa0040', parentId: 'local_aaaa9999', parentKind: 'fork' })
  const [root] = buildTree([child], OPTS)
  expect(root?.id).toBe('local_aaaa0040')
  expect(root?.parentId).toBeNull()
  expect(root?.depth).toBe(0)
  expect(root?.kind).toBe('fork')
})

test('buildTree: a cycle is cut at one link, every session appears once, and the walk ends', () => {
  const first = makeRecord({ sessionId: 'local_aaaa0050', parentId: 'local_aaaa0051', parentKind: 'fork' })
  const second = makeRecord({ sessionId: 'local_aaaa0051', parentId: 'local_aaaa0050', parentKind: 'fork' })
  const roots = buildTree([first, second], OPTS)
  expect(flatten(roots)).toHaveLength(2)
  expect(roots).toHaveLength(1)
})

test('buildTree: a chain deeper than MAX_DEPTH is cut: no node is deeper than MAX_DEPTH', () => {
  const chain = Array.from({ length: MAX_DEPTH + 2 }, (_, index) =>
    makeRecord({
      sessionId: 'local_c' + String(index).padStart(6, '0'),
      parentId: index === 0 ? null : 'local_c' + String(index - 1).padStart(6, '0'),
      parentKind: index === 0 ? null : 'fork',
    }),
  )
  const roots = buildTree(chain, OPTS)
  const nodes = flatten(roots)
  expect(nodes).toHaveLength(MAX_DEPTH + 2)
  expect(Math.max(...nodes.map(node => node.depth))).toBe(MAX_DEPTH)
  expect(roots).toHaveLength(2)
})

test('buildTree: this window\'s root comes first, whatever its activity', () => {
  const older = makeRecord({ sessionId: 'local_aaaa0060', lastActivityAt: NOW - HOUR })
  const mine = makeRecord({ sessionId: 'local_aaaa0061', cliSessionId: 'cli-this', lastActivityAt: NOW - 10 * HOUR })
  const roots = buildTree([older, mine], { ...OPTS, thisCliSessionId: 'cli-this' })
  expect(roots[0]?.id).toBe('local_aaaa0061')
  expect(roots[0]?.isThisWindow).toBe(true)
  expect(roots[1]?.isThisWindow).toBe(false)
})

test('buildTree: other roots are ordered by last activity, newest first', () => {
  const older = makeRecord({ sessionId: 'local_aaaa0070', lastActivityAt: NOW - 2 * HOUR })
  const newer = makeRecord({ sessionId: 'local_aaaa0071', lastActivityAt: NOW - HOUR })
  expect(buildTree([older, newer], OPTS).map(node => node.id)).toEqual(['local_aaaa0071', 'local_aaaa0070'])
})

test('buildTree: the cutoff keeps a session active within it and drops one older than it', () => {
  const inside = makeRecord({ sessionId: 'local_aaaa0080', lastActivityAt: NOW - 71 * HOUR })
  const outside = makeRecord({ sessionId: 'local_aaaa0081', lastActivityAt: NOW - 73 * HOUR })
  expect(buildTree([inside, outside], OPTS).map(node => node.id)).toEqual(['local_aaaa0080'])
})

test('buildTree: this window is kept at any age and when archived', () => {
  const mine = makeRecord({
    sessionId: 'local_aaaa0090',
    cliSessionId: 'cli-this',
    isArchived: true,
    lastActivityAt: NOW - 100 * HOUR,
  })
  const roots = buildTree([mine], { ...OPTS, thisCliSessionId: 'cli-this' })
  expect(roots.map(node => node.id)).toEqual(['local_aaaa0090'])
})

test('buildTree: an archived session is dropped, even with an open PR', () => {
  const archived = makeRecord({ sessionId: 'local_aaaa0091', isArchived: true, pr: makePr({ state: 'OPEN' }) })
  expect(buildTree([archived], OPTS)).toHaveLength(0)
})

test('buildTree: an open PR keeps a session at any age; a closed PR does not', () => {
  const open = makeRecord({ sessionId: 'local_aaaa0092', lastActivityAt: NOW - 200 * HOUR, pr: makePr({ state: 'OPEN' }) })
  const closed = makeRecord({ sessionId: 'local_aaaa0093', lastActivityAt: NOW - 200 * HOUR, pr: makePr({ state: 'CLOSED' }) })
  expect(buildTree([open, closed], OPTS).map(node => node.id)).toEqual(['local_aaaa0092'])
})

test('buildTree: a future timestamp is clamped to now, so the session counts as working', () => {
  const future = makeRecord({ sessionId: 'local_aaaa0100', createdAt: NOW + HOUR, lastActivityAt: NOW + HOUR })
  const [node] = buildTree([future], OPTS)
  expect(node?.createdAt).toBe(NOW)
  expect(node?.state).toBe('working')
})

test('buildTree: a session waiting for a person is drawn waiting', () => {
  const [node] = buildTree([makeRecord({ sessionId: 'local_aaaa0101', waiting: true })], OPTS)
  expect(node?.state).toBe('waiting')
})

test('buildTree: a derived session without its own issue takes the parent issue', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0110', branch: 'fix/106-x' })
  const child = makeRecord({ sessionId: 'local_aaaa0111', parentId: 'local_aaaa0110', parentKind: 'fork' })
  const roots = buildTree([parent, child], OPTS)
  expect(roots[0]?.children[0]?.issue).toEqual({ number: 106, source: 'parent' })
})

test('buildTree: the timeline of a fork names its parent by title', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0120', title: 'Synthetic parent' })
  const child = makeRecord({ sessionId: 'local_aaaa0121', parentId: 'local_aaaa0120', parentKind: 'fork' })
  const roots = buildTree([parent, child], OPTS)
  expect(roots[0]?.children[0]?.timeline).toEqual([{ at: NOW - 2 * HOUR, kind: 'session', text: 'Synthetic parent' }])
})

test('buildTree: children are ordered oldest first', () => {
  const parent = makeRecord({ sessionId: 'local_aaaa0130' })
  const newer = makeRecord({ sessionId: 'local_aaaa0131', createdAt: NOW - HOUR, parentId: 'local_aaaa0130', parentKind: 'fork' })
  const older = makeRecord({ sessionId: 'local_aaaa0132', createdAt: NOW - 3 * HOUR, parentId: 'local_aaaa0130', parentKind: 'fork' })
  const roots = buildTree([parent, newer, older], OPTS)
  expect(roots[0]?.children.map(node => node.id)).toEqual(['local_aaaa0132', 'local_aaaa0131'])
})

test('buildTree on the sample: roots, nesting and the issue of each session', () => {
  const roots = buildTree(sampleSessions(), { now: NOW, cutoffMs: 72 * HOUR, thisCliSessionId: 'cli-this' })
  expect(roots.map(node => node.id)).toEqual(['local_7f3a0001', 'local_e77f0004', 'local_1a2b0005', 'local_9b040003'])
  expect(roots[0]?.children.map(node => node.id)).toEqual(['local_c21d0002'])
  expect(roots[2]?.children.map(node => node.id)).toEqual(['local_55c00006'])
  expect(roots[0]?.issue).toEqual({ number: 106, source: 'override' })
  expect(roots[0]?.children[0]?.issue).toEqual({ number: 106, source: 'parent' })
  expect(roots[1]?.issue).toEqual({ number: 103, source: 'branch' })
  expect(roots[3]?.issue).toEqual({ number: 97, source: 'pr' })
  expect(roots[2]?.issue).toBeNull()
  expect(flatten(roots)).toHaveLength(6)
})

test('groupIssues on the sample shape: three milestones, the linked issues left out, the no-milestone group last', () => {
  const groups = groupIssues(SAMPLE_MILESTONES, SAMPLE_ISSUES, SAMPLE_LINKED)
  expect(shapeOf(groups)).toEqual([
    [23, [105, 108, 107]],
    [22, [90]],
    [21, []],
    [null, [15]],
  ])
})

test('groupIssues: an open milestone with no open issue gives a one-line group with its milestone set', () => {
  const groups = groupIssues(SAMPLE_MILESTONES, SAMPLE_ISSUES, new Set([90]))
  const oneLine = groups.find(group => group.milestone?.number === 22)
  expect(oneLine?.issues).toEqual([])
  expect(oneLine?.milestone?.openIssues).toBe(1)
  expect(groups.find(group => group.milestone?.number === 21)?.issues).toEqual([])
})

test('groupIssues: no no-milestone group when every unlinked issue has a milestone', () => {
  const withMilestone = SAMPLE_ISSUES.filter(issue => issue.milestone !== null)
  const groups = groupIssues(SAMPLE_MILESTONES, withMilestone, SAMPLE_LINKED)
  expect(groups.map(group => group.milestone?.number ?? null)).toEqual([23, 22, 21])
})

test('groupIssues: an issue whose milestone is not in the open list joins the no-milestone group', () => {
  const stray = { ...SAMPLE_ISSUES[0], number: 200, milestone: 99 } as (typeof SAMPLE_ISSUES)[number]
  const groups = groupIssues(SAMPLE_MILESTONES, [...SAMPLE_ISSUES, stray], SAMPLE_LINKED)
  // Issue 200 is updated at the newest time of the sample, so it leads the no-milestone group.
  expect(shapeOf(groups).at(-1)).toEqual([null, [200, 15]])
})

test('timelineOf: events come newest first, with the session creation last', () => {
  const events = timelineOf({
    createdAt: 100,
    kind: 'root',
    parentTitle: null,
    pr: null,
    commits: [{ at: 300, subject: 'third' }, { at: 200, subject: 'second' }],
  })
  expect(events.map(event => event.at)).toEqual([300, 200, 100])
  expect(events.map(event => event.kind)).toEqual(['commit', 'commit', 'session'])
  expect(events[0]?.text).toBe('third')
})

test('timelineOf: a PR event carries its number, a space and its title', () => {
  const pr = makePr({ number: 106, title: 'Synthetic fix', createdAt: new Date(50).toISOString() })
  const events = timelineOf({ createdAt: 10, kind: 'root', parentTitle: null, pr, commits: [] })
  expect(events[0]).toEqual({ at: 50, kind: 'pr', text: '106 Synthetic fix' })
})

test('timelineOf: the default cap keeps the 6 newest events and drops the oldest', () => {
  const commits = [14, 13, 12, 11, 10].map(at => ({ at, subject: 'c' + String(at) }))
  const pr = makePr({ createdAt: new Date(9).toISOString() })
  const events = timelineOf({ createdAt: 1, kind: 'root', parentTitle: null, pr, commits })
  expect(events.map(event => event.at)).toEqual([14, 13, 12, 11, 10, 9])
  expect(events.some(event => event.kind === 'session')).toBe(false)
})

test('timelineOf: an explicit limit is honoured', () => {
  const commits = [3, 2, 1].map(at => ({ at, subject: 'c' }))
  expect(timelineOf({ createdAt: 0, kind: 'root', parentTitle: null, pr: null, commits }, 2)).toHaveLength(2)
})

test('timelineOf: a PR with an unparsable date gives no PR event', () => {
  const pr = makePr({ createdAt: 'not a date' })
  const events = timelineOf({ createdAt: 10, kind: 'root', parentTitle: null, pr, commits: [] })
  expect(events.map(event => event.kind)).toEqual(['session'])
})

test('timelineOf: a session event names the parent for a fork or spawn, and is empty for a root', () => {
  expect(timelineOf({ createdAt: 1, kind: 'fork', parentTitle: 'Synthetic parent', pr: null, commits: [] })[0]?.text).toBe('Synthetic parent')
  expect(timelineOf({ createdAt: 1, kind: 'root', parentTitle: null, pr: null, commits: [] })[0]?.text).toBe('')
  expect(timelineOf({ createdAt: 1, kind: 'fork', parentTitle: null, pr: null, commits: [] })[0]?.text).toBe('')
})

test('stateOf: waiting wins over every activity time', () => {
  expect(stateOf(NOW, NOW, true)).toBe('waiting')
  expect(stateOf(NOW - 10 * HOUR, NOW, true)).toBe('waiting')
})

test('stateOf: working up to the 5 minute window, idle past it', () => {
  expect(stateOf(NOW - MINUTE, NOW, false)).toBe('working')
  expect(stateOf(NOW - WORKING_WINDOW_MS, NOW, false)).toBe('working')
  expect(stateOf(NOW - WORKING_WINDOW_MS - 1, NOW, false)).toBe('idle')
  expect(stateOf(NOW - HOUR, NOW, false)).toBe('idle')
})

test('stateOf: a future activity counts as working', () => {
  expect(stateOf(NOW + HOUR, NOW, false)).toBe('working')
})

test('isSessionLinkId accepts a local session id, a uuid form, and rejects the rest', () => {
  expect(isSessionLinkId('local_7f3a')).toBe(true)
  expect(isSessionLinkId('local_0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe(true)
  expect(isSessionLinkId('local_' + 'a'.repeat(128))).toBe(true)
  expect(isSessionLinkId('local_' + 'a'.repeat(129))).toBe(false)
  expect(isSessionLinkId('local_')).toBe(false)
  expect(isSessionLinkId('')).toBe(false)
  expect(isSessionLinkId('#106')).toBe(false)
  expect(isSessionLinkId('local_a b')).toBe(false)
  expect(isSessionLinkId('local_a)')).toBe(false)
  expect(isSessionLinkId('remote_abc')).toBe(false)
  expect(isSessionLinkId('LOCAL_abc')).toBe(false)
})

test('projectRecord keeps exactly the fields of section 2.7 and drops the rest', () => {
  const projected = projectRecord(makeRawRecord())
  expect(projected).toEqual({
    sessionId: 'local_0a1b2c3d',
    cliSessionId: 'cli-0a1b2c3d',
    title: 'Synthetic raw session',
    createdAt: NOW - 2 * HOUR,
    lastActivityAt: NOW - HOUR,
    isArchived: false,
    parentId: null,
    parentKind: null,
    parentTitle: null,
    commonDir: '/srv/synthetic/repo/.git',
    cwd: '/srv/synthetic/repo',
  })
  expect(Object.keys(projected ?? {})).toHaveLength(11)
})

test('projectRecord reads a fork parent from forkedFromSessionId and a spawn parent with its title', () => {
  const fork = projectRecord(makeRawRecord({ forkedFromSessionId: 'local_aaaa0001' }))
  expect(fork?.parentId).toBe('local_aaaa0001')
  expect(fork?.parentKind).toBe('fork')
  const spawn = projectRecord(makeRawRecord({ spawnedFrom: { sessionId: 'local_aaaa0002', title: 'Synthetic parent', sideSession: true } }))
  expect(spawn?.parentId).toBe('local_aaaa0002')
  expect(spawn?.parentKind).toBe('spawn')
  expect(spawn?.parentTitle).toBe('Synthetic parent')
  const both = projectRecord(makeRawRecord({ forkedFromSessionId: 'local_aaaa0001', spawnedFrom: { sessionId: 'local_aaaa0002', title: 'T' } }))
  expect(both?.parentKind).toBe('fork')
})

test('projectRecord ignores a malformed parent link and a relative or missing common dir', () => {
  const badParent = projectRecord(makeRawRecord({ forkedFromSessionId: 'not a link' }))
  expect(badParent?.parentId).toBeNull()
  expect(badParent?.parentKind).toBeNull()
  expect(projectRecord(makeRawRecord({ gitAnchors: [{ commonDir: 'relative/.git' }] }))?.commonDir).toBeNull()
  expect(projectRecord(makeRawRecord({ gitAnchors: [] }))?.commonDir).toBeNull()
  expect(projectRecord(makeRawRecord({ cwd: undefined }))?.cwd).toBeNull()
})

test('projectRecord returns null for a value that is not an object', () => {
  for (const raw of [null, undefined, [], 'text', 42]) expect(projectRecord(raw)).toBeNull()
})

test('projectRecord returns null for a record missing or mistyping a required field', () => {
  expect(projectRecord(makeRawRecord({ sessionId: undefined }))).toBeNull()
  expect(projectRecord(makeRawRecord({ sessionId: 'bad id' }))).toBeNull()
  expect(projectRecord(makeRawRecord({ cliSessionId: '' }))).toBeNull()
  expect(projectRecord(makeRawRecord({ title: 5 }))).toBeNull()
  expect(projectRecord(makeRawRecord({ createdAt: '2026' }))).toBeNull()
  expect(projectRecord(makeRawRecord({ lastActivityAt: Number.NaN }))).toBeNull()
  expect(projectRecord(makeRawRecord({ isArchived: 'no' }))).toBeNull()
})

test('projectRecord rejects an oversized text field: over the limit is null, at the limit is kept', () => {
  expect(projectRecord(makeRawRecord({ title: 'x'.repeat(FIELD_MAX_LENGTH + 1) }))).toBeNull()
  expect(projectRecord(makeRawRecord({ cwd: '/' + 'a'.repeat(FIELD_MAX_LENGTH) }))).toBeNull()
  expect(projectRecord(makeRawRecord({ gitAnchors: [{ commonDir: '/' + 'a'.repeat(FIELD_MAX_LENGTH) }] }))).toBeNull()
  expect(projectRecord(makeRawRecord({ title: 'x'.repeat(FIELD_MAX_LENGTH) }))).not.toBeNull()
})

test('the record size limit is 2 MiB', () => {
  expect(RECORD_MAX_BYTES).toBe(2 * 1024 * 1024)
})
