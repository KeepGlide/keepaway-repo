// Tests of the hooks module (hooks/register.tsx): the poll runs only while the pane is open and a close stops it, the gh
// failures draw their lines and keep the sessions, a failed git call is asked again, the /keeptrack command writes and
// clears the override, and no record content reaches the log.
// The host is stubbed beneath the plugin, as askaway's race tests do: Desktop records, git and gh answer from memory, and
// gh and git are never run. The drawn pane is read through a mounted drawing.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { RECORD_MAX_BYTES } from '../hooks/model'
import { TURN_MAX_AGE_MS } from '../hooks/turn'
import { TOOL_NAME_MAX, resetDesktopConfigCache } from '../hooks/register'

const HOME = '/test-home'
const RECORDS = '/test-records'
const REPO_ROOT = '/work/app'
const REMOTE = 'git@github.com:acme/app.git'
const OTHER_COMMON_DIR = '/work/other/.git'
const OTHER_REMOTE = 'https://gitlab.example.test/acme/app.git'
const SIBLING_COMMON_DIR = '/work/sibling/.git'
const STALE_COMMON_DIR = '/test-stale/.git'
const BROKEN_COMMON_DIR = '/work/broken/.git'
const SELF = 'sess-self'
const SESSION_ID = 'local_7f3a0001'
const SESSION = { cwd: REPO_ROOT, surface: 'terminal', isInteractive: true } as const
const COMMAND_CONTEXT = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const PANE_ID = 'repo-work'
const POLL_MS = 60_000
const BAND_POLL_MS = 300_000
const DAY_MS = 24 * 60 * 60 * 1000
const BAND_TICK_MS = 30_000
const ISSUE = 106
const ISSUE_VIEW_ARGV = ['gh', 'issue', 'view', String(ISSUE), '--repo', 'acme/app', '--json', 'number,title,url,state,milestone,comments']
const ISSUE_VIEW_JSON = JSON.stringify({
  number: ISSUE,
  title: 'Synthetic issue',
  url: 'https://github.com/acme/app/issues/106',
  state: 'OPEN',
  milestone: { number: 23, title: 'Milestone B' },
  comments: [{ author: { login: 'dev-one' }, createdAt: '2026-10-20T16:00:00Z', body: 'a comment' }],
})
const SECRET_TITLE = 'Keep this secret title out of the log'
// The Desktop config under HOME, read for its sidebar Groups.
const DESKTOP_CONFIG_DIR = `${HOME}/.config/Claude`
const DESKTOP_CONFIG_NAME = 'claude_desktop_config.json'
const DESKTOP_CONFIG_PATH = `${DESKTOP_CONFIG_DIR}/${DESKTOP_CONFIG_NAME}`

type RawRecord = Record<string, unknown>
// 'cut': gh answers as usual, but the engine says it cut the stdout at its cap (isStdoutTruncated).
type GhMode = 'ok' | 'missing' | 'timeout' | 'unreadable' | 'cut' | { exitCode: number; stderr: string }
type StubOptions = {
  gh?: GhMode
  records?: RawRecord[]
  cliId?: string
  rootRemote?: string
  remotes?: Record<string, string>
  gate?: Promise<void>
  placed?: boolean
  // The first `git remote get-url origin` of this common dir fails (a timeout), then answers as usual.
  failFirstRemoteOf?: string
  // Environment values beyond the defaults (the poll overrides).
  env?: Record<string, string>
  // A repo with no origin: its one remote is `name`, at `url`; the engine's session.repo names no remote.
  noOrigin?: { name: string; url: string }
  // The agents `$.agent.list()` answers (the test may change their status between two ticks).
  agents?: { id: string; status: string }[]
  // The fakes read these at each call, so a test may change them between two polls.
  issues?: string
  // The open milestones `gh api` answers (REST shape: open_issues and closed_issues count PRs too, pm1-8).
  milestones?: string
  // The issue counts GraphQL answers for the open milestones (issues only, no PRs); 'fail' is a refused query. Absent: no count answers,
  // so every milestone keeps its REST counts, not exact.
  milestoneCounts?: { number: number; open: number; closed: number }[] | 'fail'
  prTotal?: number
  // The open PRs the GraphQL call lists, and the branch each folder's `rev-parse --abbrev-ref HEAD` answers (default feature/disk).
  // A PR's `closes` are the closing references on the page, `closesTotal` the count GitHub holds (default: the page's).
  // isCrossRepository marks a PR from a fork (gh3-2).
  openPrs?: {
    number: number
    title: string
    headRefName: string
    closes?: number[]
    // Issues of another repo the PR closes: its references name that repo, so they are no issue of this one (gh3-5).
    closesOther?: number[]
    closesTotal?: number
    isCrossRepository?: boolean
  }[]
  branches?: Record<string, string>
  // Git answers as git gives them: a tag named like a branch shortens it to heads/<name>; a detached or unborn HEAD by folder; log stdout.
  tags?: string[]
  detached?: string[]
  unborn?: string[]
  log?: string
  repoDenies?: boolean
  originTimesOut?: boolean
  // Folders that are not git repositories: every git call in them exits 128 with git's not-a-repository message.
  nonRepoCwds?: string[]
  // Git calls against these common dirs exit 128 with the given stderr: a not-a-repository message, or another failure.
  gitErrors?: Record<string, string>
  unlistable?: string[]
  // Record files the folder lists but fs.read refuses, by path.
  unreadable?: string[]
  // The size and the mtime fs.list gives a file, by path (default 100 bytes, mtime 1), read at each call.
  sizes?: Record<string, number>
  mtimes?: Record<string, number>
  // The text of the Desktop config, read at each call; absent: its folder lists no config.
  desktopConfig?: string
  agentsDenied?: boolean
  // Each `$.agent.list()` call takes the next hold, if any, after it has read the agents, so the test sets its read order.
  agentHolds?: Promise<void>[]
  storeKeysDenies?: boolean
  // The engine's verdict on a tool check (tool.check) when a test gives one: ask puts the call to the person.
  permission?: 'allow' | 'ask' | 'deny'
  // The `gh issue view` calls wait for this promise, so a test can change the override while a poll is at its window issue (st-5).
  viewGate?: Promise<void>
  // Files in the records folder that are not session records (Desktop's scheduled tasks list, deleted_<id> tombstones).
  strayFiles?: string[]
  // The answer of `date +%z`, the host's UTC offset; `dateMissing` makes the host refuse the call (no date binary).
  utcOffset?: string
  dateMissing?: boolean
}
type Host = {
  argvs: string[][]
  toasts: string[]
  logs: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  reads: number
  placed: boolean
  // The band redraws the engine was asked for (`ui.invalidate` of `ui.render`).
  redraws: number
  // The denies the stub answered, in order: a happy path asserts none (R2-07).
  denies: string[]
  // The paths of every fs.list and fs.read call, in order.
  listed: string[]
  readPaths: string[]
}
type FsStub = { name: string; kind: 'file' | 'dir' }

const recordOf = (sessionId: string, overrides: RawRecord = {}): RawRecord => ({
  sessionId,
  cliSessionId: `cli-${sessionId}`,
  title: 'Fix disk full',
  createdAt: 0,
  lastActivityAt: 0,
  isArchived: false,
  cwd: REPO_ROOT,
  gitAnchors: [{ commonDir: `${REPO_ROOT}/.git` }],
  ...overrides,
})
const OWN_RECORD = recordOf(SESSION_ID, { cliSessionId: SELF })
const recordPath = (sessionId: string): string => `${RECORDS}/org/user/${sessionId}.json`

// Answers the module's calls from memory: the Desktop records given, a GitHub remote, and empty gh lists.
function stubHost(on: On, options: StubOptions = {}): Host {
  // The Desktop config cache belongs to one host: a test starts with none, so no test reads another test's config.
  resetDesktopConfigCache()
  const records = options.records ?? [OWN_RECORD]
  const host: Host = {
    argvs: [],
    toasts: [],
    logs: [],
    store: new Map(),
    clock: mock.clock(on),
    reads: 0,
    placed: options.placed ?? true,
    redraws: 0,
    denies: [],
    listed: [],
    readPaths: [],
  }
  // Every deny the stub answers goes through here, so host.denies keeps it (R2-07).
  const refuse = (text: string) => {
    host.denies.push(text)
    return { deny: text }
  }
  // A call no test expects is refused, so the module sees a rejection, not an empty success.
  const valueOr = (argv: readonly string[], answer: ProcessOutput | undefined) =>
    answer === undefined ? refuse(`unexpected call: ${argv.join(' ')}`) : { value: answer }
  const files = new Map([
    ...records.map(record => [recordPath(String(record.sessionId)), JSON.stringify(record)] as const),
    ...(options.strayFiles ?? []).map(name => [`${RECORDS}/org/user/${name}`, '[{"id":"task-1"}]'] as const),
  ])
  const folders = new Map<string, FsStub[]>([
    [RECORDS, [{ name: 'org', kind: 'dir' }]],
    [`${RECORDS}/org`, [{ name: 'user', kind: 'dir' }]],
    [
      `${RECORDS}/org/user`,
      [...files.keys()].map(path => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' as const })),
    ],
  ])
  mock.env(on, { HOME, KEEPTRACK_DESKTOP_SESSIONS: RECORDS, ...options.env })
  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('session.start', (_$, event) => ({ cwd: event.cwd }))
  on('store.get', (_$, event) => ({ value: host.store.get(event.key) }))
  on('store.set', (_$, event) => {
    host.store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.delete', (_$, event) => {
    host.store.delete(event.key)
    return { value: undefined }
  })
  on('store.keys', () => (options.storeKeysDenies === true ? refuse('store unavailable') :{ value: [...host.store.keys()] }))
  on('session.id', () => ({ value: options.cliId ?? SELF }))
  on('session.repo', () =>
    options.repoDenies === true
      ? refuse('session repo unavailable')
      : {
          value: {
            root: REPO_ROOT,
            remote: options.noOrigin !== undefined ? null : (options.rootRemote ?? REMOTE),
            internal: false,
            name: 'acme/app',
            id: 'repo',
          },
        },
  )
  on('agent.list', async () => {
    const agents = options.agents ?? []
    const hold = options.agentHolds?.shift()
    if (hold !== undefined) await hold
    return options.agentsDenied === true ? refuse('agent list unavailable') : { value: agents as never }
  })
  // The engine's own answers under the plugins' turn and tool hooks (the kit has no default for them).
  on('turn.start', (_$, event) => ({ turnId: event.turnId }))
  on('tool.call', () => ({ result: undefined }))
  on('tool.check', () => ({ decision: options.permission ?? 'allow' }))
  on('ui.invalidate', (_$, event) => {
    if (event.event === 'ui.render') host.redraws += 1
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: host.placed } }))
  // The engine's close, answered beneath the plugins: the kit has no bottom for ui.close of its own.
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, event) => {
    host.toasts.push(event.text)
    return { value: undefined }
  })
  on('ui.log', (_$, event) => {
    host.logs.push(event.text)
    return { value: undefined }
  })
  // The Desktop config folder exists; it holds the config only while the test gives one.
  const configEntries = (): FsStub[] =>
    options.desktopConfig === undefined ? [] : [{ name: DESKTOP_CONFIG_NAME, kind: 'file' }]
  // A folder no test names is a deny, not an empty listing: the module sees a rejection, and the output shows whether it mattered.
  on('fs.list', async (_$, event) => {
    host.listed.push(event.path)
    const entries = event.path === DESKTOP_CONFIG_DIR ? configEntries() : folders.get(event.path)
    if (entries === undefined || options.unlistable?.includes(event.path) === true) {
      return refuse(`fs.list refused: ${event.path}`)
    }
    const sizeOf = (name: string): number => options.sizes?.[`${event.path}/${name}`] ?? 100
    const mtimeOf = (name: string): number => options.mtimes?.[`${event.path}/${name}`] ?? 1
    return { value: entries.map(entry => ({ ...entry, size: sizeOf(entry.name), mtimeMs: mtimeOf(entry.name), isLink: false })) }
  })
  on('fs.read', (_$, event) => {
    host.reads += 1
    host.readPaths.push(event.path)
    const content =
      event.path === DESKTOP_CONFIG_PATH ? options.desktopConfig : files.get(event.path)
    if (content === undefined || options.unreadable?.includes(event.path) === true) return refuse(`fs.read refused: ${event.path}`)
    return { value: content }
  })
  on('fs.exists', (_$, event) => ({ value: files.has(event.path) || folders.has(event.path) }))
  const failedOnce = new Set<string>()
  on('process.run', async (_$, event) => {
    const argv = [...event.argv]
    host.argvs.push(argv)
    if (argv[0] === 'date') {
      if (options.dateMissing === true) return refuse('Executable not found in $PATH: "date"')
      return valueOr(argv, processOutput(options.utcOffset ?? '+0000\n'))
    }
    if (argv[0] === 'gh' && (options.gh === 'missing' || options.gh === 'timeout')) return refuse(REJECTION_OF[options.gh])
    if (argv[0] === 'gh') {
      const answer = await ghAnswerOf(argv, options)
      return valueOr(argv, options.gh === 'cut' && answer !== undefined ? { ...answer, isStdoutTruncated: true } : answer)
    }
    const gitDir = argv[argv.indexOf('--git-dir') + 1]
    if (gitDir === options.failFirstRemoteOf && argv.includes('get-url') && !failedOnce.has(gitDir)) {
      failedOnce.add(gitDir)
      return refuse('process timed out after 5000 ms')
    }
    if (options.originTimesOut === true && argv.includes('get-url') && argv.at(-1) === 'origin') {
      return refuse(REJECTION_OF.timeout)
    }
    return valueOr(argv, answerOf(argv, options))
  })
  return host
}

type ProcessOutput = ReturnType<typeof processOutput>
// A host command that cannot start or runs out of time rejects its call (the engine's process.run contract). A hook that
// throws is skipped instead, and the kit then rejects with "no implementation", so the rejection is answered with a deny,
// which rejects the caller with its text. The missing-binary text is the runtime's own spawn error.
const REJECTION_OF = {
  missing: 'Executable not found in $PATH: "gh"',
  timeout: 'process timed out after 15000 ms',
} as const

const processOutput = (stdout: string, exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The GraphQL answer to MILESTONE_QUERY: the counts the test gives, or the refusal gh prints for a failed query.
function milestoneCountsOf(options: StubOptions): ProcessOutput {
  if (options.milestoneCounts === 'fail') return processOutput('', 1, 'GraphQL: Something went wrong while executing your query')
  const nodes = (options.milestoneCounts ?? []).map(({ number, open, closed }) => ({
    number,
    open: { totalCount: open },
    closed: { totalCount: closed },
  }))
  return processOutput(JSON.stringify({ data: { repository: { milestones: { nodes } } } }))
}

// The result of a gh call under the mode the test chose; undefined for a call no test expects. `gh api` answers the milestones.
async function ghAnswerOf(argv: readonly string[], options: StubOptions): Promise<ProcessOutput | undefined> {
  if (options.gate !== undefined) await options.gate
  if (options.viewGate !== undefined && argv.includes('view')) await options.viewGate
  if (typeof options.gh === 'object') return processOutput('', options.gh.exitCode, options.gh.stderr)
  if (options.gh === 'unreadable') return processOutput('<html>not JSON</html>')
  if (argv.includes('view')) return processOutput(ISSUE_VIEW_JSON)
  if (argv.some(arg => arg.includes('milestones('))) return milestoneCountsOf(options)
  if (argv.includes('graphql')) {
    const nodes = (options.openPrs ?? []).map(({ closes = [], closesOther = [], closesTotal, isCrossRepository = false, ...pr }) => ({
      ...pr,
      state: 'OPEN',
      url: `https://github.com/acme/app/pull/${pr.number}`,
      createdAt: '2026-10-20T10:00:00Z',
      reviewDecision: null,
      isCrossRepository,
      closingIssuesReferences: {
        totalCount: closesTotal ?? closes.length + closesOther.length,
        nodes: [
          ...closes.map(number => ({ number, repository: { nameWithOwner: 'acme/app' } })),
          ...closesOther.map(number => ({ number, repository: { nameWithOwner: 'acme/other' } })),
        ],
      },
      commits: { nodes: [] },
    }))
    return processOutput(JSON.stringify({ data: { repository: { pullRequests: { totalCount: options.prTotal ?? nodes.length, nodes } } } }))
  }
  if (argv.includes('list')) return processOutput(options.issues ?? '[]')
  if (argv[1] === 'api') return processOutput(options.milestones ?? '[]')
  return undefined
}

// The stdout of a git call the module makes, for the argv of that call.
function answerOf(argv: readonly string[], options: StubOptions) {
  const gitError = options.gitErrors?.[argv[argv.indexOf('--git-dir') + 1] ?? '']
  if (gitError !== undefined) return processOutput('', 128, gitError)
  const remotes = options.remotes ?? {}
  const named = options.noOrigin
  const cwdAt = argv.indexOf('-C') + 1
  if (cwdAt > 0 && options.nonRepoCwds?.includes(argv[cwdAt] ?? '') === true) {
    return processOutput('', 128, 'fatal: not a git repository (or any parent up to mount point /)')
  }
  if (named !== undefined && argv.includes('get-url') && argv.at(-1) === 'origin') {
    return processOutput('', 2, "error: No such remote 'origin'")
  }
  if (named !== undefined && argv.at(-1) === 'remote') return processOutput(named.name)
  if (named !== undefined && argv.includes('get-url') && argv.at(-1) === named.name) return processOutput(named.url)
  if (argv.includes('--git-common-dir')) return processOutput(`${REPO_ROOT}/.git`)
  const cwd = argv[cwdAt] ?? ''
  const branch = options.branches?.[cwd] ?? 'feature/disk'
  // As git answers: a tag named like the branch makes its short name heads/<name>; an unborn HEAD fails rev-parse only.
  const shortName = options.tags?.includes(branch) === true ? `heads/${branch}` : branch
  if (argv.includes('--abbrev-ref')) {
    if (options.unborn?.includes(cwd) === true) return processOutput('', 128, "fatal: ambiguous argument 'HEAD': unknown revision")
    return processOutput(options.detached?.includes(cwd) === true ? 'HEAD' : shortName)
  }
  if (argv.at(-1) === 'HEAD' && argv.includes('symbolic-ref')) {
    if (options.detached?.includes(cwd) === true) return processOutput('', 1)
    return processOutput(argv.includes('--short') ? shortName : `refs/heads/${branch}`)
  }
  if (argv.includes('get-url')) return processOutput(remotes[argv[argv.indexOf('--git-dir') + 1] ?? ''] ?? REMOTE)
  // The default branch of the origin, and the log of a branch: no commits beyond it unless the test gives some.
  if (argv.includes('symbolic-ref')) return processOutput('origin/main')
  if (argv.includes('log')) return processOutput(options.log ?? '')
  return undefined
}

const ghCalls = (host: Host): number => host.argvs.filter(argv => argv[0] === 'gh').length
const remoteAsks = (host: Host, commonDir: string): number =>
  host.argvs.filter(argv => argv.includes('get-url') && argv[argv.indexOf('--git-dir') + 1] === commonDir).length

// The pane as the engine draws it now, as JSON text (the terminal surface unless the test names another). The drawing is
// unmounted after the read, so a test may take the pane again later.
async function drawnPane($: Engine, surface: 'desktop' | 'terminal' = 'terminal'): Promise<string> {
  const mounted = await $.ui.mount({
    plugin: 'keeptrack-repo-pane',
    surface,
    component: 'Pane',
    requestId: PANE_ID,
    props: {} as never,
  })
  const drawn = JSON.stringify(await mounted.drawn())
  await mounted.unmount()
  return drawn
}

// The drawn pane as nodes ({ type, props, children }): a Box or a Markdown keeps its key in props, a Text keeps none.
type DrawnNode = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const drawnTree = async ($: Engine, surface: 'desktop' | 'terminal' = 'terminal'): Promise<DrawnNode> =>
  JSON.parse(await drawnPane($, surface))

// Every node of a drawn tree, depth first, the root first.
const nodesOf = (node: unknown): DrawnNode[] => {
  if (typeof node !== 'object' || node === null) return []
  const drawn = node as DrawnNode
  return [drawn, ...(drawn.children ?? []).flatMap(nodesOf)]
}
const keyedIn = (tree: unknown, key: string): DrawnNode | undefined => nodesOf(tree).find(node => node.props?.key === key)
// The strings a node holds, nested, joined.
const textIn = (node: unknown): string => {
  if (typeof node === 'string') return node
  return typeof node === 'object' && node !== null ? ((node as DrawnNode).children ?? []).map(textIn).join('') : ''
}

// A group's label line: the first node of its Box (a Desktop Group's id, else 'recents', is the group's key).
const groupLabelIn = (tree: unknown, groupKey: string): DrawnNode | undefined =>
  keyedIn(tree, `group-${groupKey}`)?.children?.[0] as DrawnNode | undefined
// Whether a session's title line is drawn in the group with this key.
const isInGroup = (tree: unknown, groupKey: string, sessionId: string): boolean =>
  keyedIn(keyedIn(tree, `group-${groupKey}`), `head-${sessionId}`) !== undefined
// The branch glyph that starts a session's title line: "├" or "└" (every row draws one), null when the line starts with
// another glyph; undefined when the session has no row.
function branchOf(tree: unknown, sessionId: string): string | null | undefined {
  const head = keyedIn(tree, `head-${sessionId}`)
  if (head === undefined) return undefined
  const first = textIn(head.children?.[0])
  return first === '├' || first === '└' ? first : null
}

// The start of each failure line the pane can draw, in English (hooks/i18n.ts).
const FAILURE_LINE_STARTS = [
  'gh not found',
  'gh is not signed in',
  'no GitHub remote',
  'GitHub rate limit',
  'GitHub did not answer',
  'session records could not be read',
  'list is partial',
  'git failed in this folder',
]

// A happy path answers no deny, logs nothing and draws no failure line (R2-07).
async function expectClean(host: Host, $: Engine): Promise<void> {
  expect(host.denies).toEqual([])
  expect(host.logs).toEqual([])
  const drawn = await drawnPane($)
  for (const start of FAILURE_LINE_STARTS) expect(drawn).not.toContain(start)
}

test('the poll runs at open and on each minute while the pane is open', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const atOpen = ghCalls(host)
  expect(atOpen).toBe(4)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(atOpen + 4)
  await expectClean(host, $)
})

test('gh missing keeps the sessions and draws its line', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'missing' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  const drawn = await drawnPane($)
  expect(drawn).toContain('gh not found: showing sessions only')
  expect(drawn).toContain('Fix disk full')
})

const GH_FAILURES: [string, GhMode, string][] = [
  ['gh-auth', { exitCode: 1, stderr: 'To get started with GitHub CLI, please run: gh auth login' }, 'gh is not signed in'],
  ['gh-rate-limit', { exitCode: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' }, 'GitHub rate limit: showing the last data'],
  ['gh-timeout', 'timeout', 'GitHub did not answer in time'],
]

for (const [name, gh, line] of GH_FAILURES) {
  test(`${name}: its failure draws its line and the sessions stay`, async ($: Engine, on) => {
    stubHost(on, { gh })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    const drawn = await drawnPane($)
    expect(drawn).toContain(line)
    expect(drawn).toContain('Fix disk full')
  })
}

test('/keeptrack issue <n> sets this window override, issue none clears it', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'issue 106', ...COMMAND_CONTEXT })
  const stored = host.store.get(`override:${SESSION_ID}`) as { issue: number } | undefined
  expect(stored?.issue).toBe(106)
  await $.command.run({ command: 'keeptrack', args: 'issue none', ...COMMAND_CONTEXT })
  expect(host.store.has(`override:${SESSION_ID}`)).toBe(false)
  expect(host.toasts).toEqual([])
})

// The usage toast, in English (hooks/i18n.ts toast.usage).
const USAGE_TOAST = 'Usage: /keeptrack open | issue <n> | issue none | lang en|pt-BR|auto'

test('a bad /keeptrack argument toasts and changes nothing', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'issue abc', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keeptrack', args: 'frobnicate', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual([USAGE_TOAST, USAGE_TOAST])
  expect([...host.store.keys()]).toEqual([])
})

test('/keeptrack issue in a window that is not a Desktop session toasts and sets nothing', async ($: Engine, on) => {
  const host = stubHost(on, { cliId: 'sess-unknown' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'issue 106', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual(['This window is not a Desktop session: nothing to set'])
  expect([...host.store.keys()]).toEqual([])
})

test('/keeptrack lang stores the choice and draws the pane in it; auto removes the choice', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'lang pt-BR', ...COMMAND_CONTEXT })
  expect(host.store.get('lang')).toBe('pt')
  expect(await drawnPane($)).toContain('KeepTrack')
  await $.command.run({ command: 'keeptrack', args: 'lang auto', ...COMMAND_CONTEXT })
  expect(host.store.has('lang')).toBe(false)
})

test('a window that maps to an issue asks gh for it in a fifth call', async ($: Engine, on) => {
  const host = stubHost(on)
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(5)
  expect(host.argvs.filter(argv => argv.includes('view'))).toEqual([ISSUE_VIEW_ARGV])
})

test('a window that maps to no issue makes no fifth gh call', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  expect(host.argvs.some(argv => argv.includes('view'))).toBe(false)
})

test('pm1-8: a milestone counts its issues from GraphQL, not from REST, which counts the PRs too', async ($: Engine, on) => {
  const issues = JSON.stringify([
    {
      number: 1,
      title: 'Open one',
      updatedAt: '2026-10-20T16:00:00Z',
      url: 'https://github.com/acme/app/issues/1',
      milestone: { number: 23 },
      labels: [],
    },
  ])
  // REST counts five open and five closed, the PRs of the milestone included: the pane must not read them.
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 5, closed_issues: 5, due_on: null }])
  // GraphQL counts one open and one closed issue, no PR: the pane reads these.
  const host = stubHost(on, { issues, milestones, milestoneCounts: [{ number: 23, open: 1, closed: 1 }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('1 of 2 issues closed')
})

test('pm1-8: more than 500 open issues flag the list partial, and the milestone totals still come from GraphQL', async ($: Engine, on) => {
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 0, closed_issues: 0, due_on: null }])
  // The list is cut at 500 rows; the milestone's 600 open issues are counted by GraphQL, not by the cut list.
  const host = stubHost(on, { issues: issueList(501), milestones, milestoneCounts: [{ number: 23, open: 600, closed: 4 }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('list is partial (first 500)')
  expect(drawn).toContain('4 of 604 issues closed')
  expect(drawn).not.toContain('all closed')
})

test('pm1-8: when the milestone totals query fails, the milestone keeps its REST counts and the failed call is logged', async ($: Engine, on) => {
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 5, closed_issues: 5, due_on: null }])
  const host = stubHost(on, { milestones, milestoneCounts: 'fail' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('5 of 10 items closed')
  expect(host.logs).toContain('keeptrack: gh api call failed')
})

test('pm1-9: all closed is drawn only from exact counts, never from a REST zero or a failed totals query', async ($: Engine, on) => {
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 0, closed_issues: 2, due_on: null }])
  const options: StubOptions = { milestones, milestoneCounts: 'fail' }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).not.toContain('all closed')
  options.milestoneCounts = [{ number: 23, open: 0, closed: 2 }]
  await host.clock.advance(POLL_MS)
  expect(await drawnPane($)).toContain('all closed')
})

test('gh3-5: a PR that closes an issue of another repo maps no issue here: no view of that number', async ($: Engine, on) => {
  const host = stubHost(on, {
    openPrs: [{ number: 40, title: 'Closes elsewhere', headRefName: 'feature/disk', closesOther: [12] }],
  })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  expect(host.argvs.some(argv => argv.includes('view'))).toBe(false)
})

test('the closed pane polls on the band cadence: once at session start, then every 5 minutes, never each minute', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(POLL_MS * 2)
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(BAND_POLL_MS - POLL_MS * 2)
  expect(ghCalls(host)).toBe(8)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(12)
})

test('state2-3: a session.start during a poll in flight polls for the new session once that poll settles', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let releaseNewer: () => void = () => undefined
  const newerGate = new Promise<void>(resolve => {
    releaseNewer = resolve
  })
  const options: StubOptions = { issues: ISSUE_LIST_JSON }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The old poll reads 'Old issue' while it is in flight; the new session's poll is held until the old one has settled.
  options.issues = JSON.stringify([
    { number: 8, title: 'Old issue', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/8', milestone: null, labels: [] },
  ])
  options.gate = gate
  await host.clock.advance(POLL_MS)
  await $.session.start(SESSION)
  options.gate = newerGate
  release()
  await host.clock.settle()
  // The old poll settled and wrote nothing: the snapshot still holds the last one (state2-6).
  const settled = await drawnPane($)
  expect(settled).toContain('Open issue')
  expect(settled).not.toContain('Old issue')
  options.issues = JSON.stringify([
    { number: 9, title: 'Newer issue', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/9', milestone: null, labels: [] },
  ])
  releaseNewer()
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Newer issue')
  expect(await drawnPane($)).not.toContain('Old issue')
})

test('state2-3: a new session polls at once, though the last poll is within the closed cadence', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(BAND_TICK_MS)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(8)
})

test('KEEPTRACK_BAND_POLL_MS sets the closed cadence', async ($: Engine, on) => {
  const host = stubHost(on, { env: { KEEPTRACK_BAND_POLL_MS: '120000' } })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(POLL_MS * 2)
  expect(ghCalls(host)).toBe(8)
})

test('st-1: a session.start clears the window issue the band reads, before its poll settles', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await bandDrawn($)).toContain(`#${ISSUE}`)
  options.gate = NEVER()
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(await bandDrawn($)).not.toContain(`#${ISSUE}`)
})

test('st-4: an agent read that began under the previous session writes no count into the new one', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = { agents: [{ id: 'agent-1', status: 'running' }] }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.agentHolds = [hold]
  // The band tick reads one running agent and waits on its hold; the session ends before that read is released.
  await host.clock.advance(BAND_TICK_MS)
  await $.session.start(SESSION)
  release()
  await host.clock.settle()
  expect(await bandDrawn($)).not.toContain('1 agent')
})

test('st-5: an override set while a poll is at its window issue is polled again once that poll settles', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = {}
  const host = stubHost(on, options)
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The next poll waits at its `gh issue view` (106), past the point where it has read the override.
  options.viewGate = gate
  await host.clock.advance(POLL_MS)
  await $.command.run({ command: 'keeptrack', args: 'issue 8', ...COMMAND_CONTEXT })
  options.viewGate = undefined
  release()
  await host.clock.settle()
  expect(viewedIssues(host)).toContain('8')
})

test('st-6: a session that starts with a failed repo read polls no repo of the session before it', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const before = ghCalls(host)
  options.repoDenies = true
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(before)
})

test('st-8: a session that starts while two abandoned polls hold the slots polls once one of them settles', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = gate
  // Two polls hang past their deadline (at one and two minutes); the poll at three minutes is skipped.
  await host.clock.advance(3 * POLL_MS)
  expect(host.logs.some(line => line.startsWith('keeptrack: poll skipped ('))).toBe(true)
  await $.session.start(SESSION)
  const before = ghCalls(host)
  release()
  await host.clock.settle()
  // The new session's poll starts as soon as one abandoned poll settles, with no clock advance.
  expect(ghCalls(host)).toBe(before + 4)
})

test('sp-3: a poll that fails late, after a session.start, draws no failure line for the new session', async ($: Engine, on) => {
  const options: StubOptions = { gate: NEVER() }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await $.session.start(SESSION)
  options.gate = NEVER()
  // The first poll fails at its deadline, after the session changed; the new session's poll hangs too, so no snapshot exists.
  await host.clock.advance(POLL_DEADLINE_MS)
  await host.clock.settle()
  expect(host.logs).toContain('keeptrack: poll failed (PollDeadline)')
  const drawn = await drawnPane($)
  expect(drawn).toContain('Loading the repo...')
  expect(drawn).not.toContain('Could not read the repo: state unknown')
})

// KEEPTRACK_POLL_MS: a value that is not a whole number of at least MIN_POLL_MS (1 s) falls back to the one-minute cadence (sp-5).
for (const raw of ['500', '1.5', '']) {
  test(`sp-5: KEEPTRACK_POLL_MS='${raw}' falls back to the one-minute cadence`, async ($: Engine, on) => {
    const host = stubHost(on, { env: { KEEPTRACK_POLL_MS: raw } })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect(ghCalls(host)).toBe(4)
    await host.clock.advance(POLL_MS - 1)
    expect(ghCalls(host)).toBe(4)
    await host.clock.advance(1)
    expect(ghCalls(host)).toBe(8)
  })
}

test('sp-5: a valid KEEPTRACK_POLL_MS sets the open cadence', async ($: Engine, on) => {
  const host = stubHost(on, { env: { KEEPTRACK_POLL_MS: '120000' } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
})

// Stands in for the person's close: a second plugin closes the pane with $.ui.close, which the engine raises as ui.close.
// The pane's own close hook runs in that chain. Self-contained, as a plugin's register must be.
const closer = {
  name: 'pane-closer',
  register(on: On) {
    on('command.run', { command: 'close-pane' }, async $ => {
      await $.ui.close({ id: 'repo-work' })
      return { text: 'closed' }
    })
  },
}

test('B1: closing the pane stops its timer, so no poll runs while it is closed', { plugins: [closer] }, async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
  await $.command.run({ command: 'close-pane', args: '', ...COMMAND_CONTEXT })
  await host.clock.advance(POLL_MS * 2)
  expect(ghCalls(host)).toBe(8)
})

test('an open pane moves the timer to the pane cadence of one minute, and the band cadence returns on close', { plugins: [closer] }, async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
  await host.clock.advance(POLL_MS * 4)
  expect(ghCalls(host)).toBe(24)
  await $.command.run({ command: 'close-pane', args: '', ...COMMAND_CONTEXT })
  await host.clock.advance(POLL_MS * 4)
  expect(ghCalls(host)).toBe(24)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(28)
})

test('no overlapping polls: a tick during a slow poll starts nothing', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const host = stubHost(on, { gate })
  // The first poll starts at session start and waits on the gate. Opening the pane asks for a poll during it: none starts.
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  // The gate holds for less than the poll deadline (F07), so the poll is still running at the next tick, and that tick starts nothing.
  await host.clock.advance(30_000)
  expect(ghCalls(host)).toBe(4)
  release()
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
})

test('W5: a pane the engine does not place starts once a render places it', async ($: Engine, on) => {
  const host = stubHost(on, { placed: false })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  host.placed = true
  await drawnPane($)
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
})

test('W3: a git call that failed is asked again on the next poll, not kept as a definite no-remote', async ($: Engine, on) => {
  const sibling = recordOf('local_7f3a0004', {
    title: 'Sibling worktree session',
    cwd: '/work/sibling',
    gitAnchors: [{ commonDir: SIBLING_COMMON_DIR }],
  })
  const host = stubHost(on, { records: [OWN_RECORD, sibling], failFirstRemoteOf: SIBLING_COMMON_DIR })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const asksAtOpen = remoteAsks(host, SIBLING_COMMON_DIR)
  expect(asksAtOpen).toBeGreaterThan(0)
  // The failed read keeps the candidate, marked git-failed, instead of dropping it or making it a definite no-remote (F02, F04).
  const atOpen = await drawnPane($)
  expect(atOpen).toContain('Sibling worktree session')
  expect(atOpen).toContain(GIT_FAILED_LINE)
  await host.clock.advance(POLL_MS)
  expect(remoteAsks(host, SIBLING_COMMON_DIR)).toBeGreaterThan(asksAtOpen)
  const later = await drawnPane($)
  expect(later).toContain('Sibling worktree session')
  expect(later).not.toContain(GIT_FAILED_LINE)
})

test('CR1: a record whose cwd is outside any git repo is not a candidate and sets no git-failed', async ($: Engine, on) => {
  const loose = recordOf('local_7f3a0005', { title: 'Loose chat in Documents', cwd: '/home/u/Documents', gitAnchors: [] })
  const host = stubHost(on, { records: [OWN_RECORD, loose], nonRepoCwds: ['/home/u/Documents'] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Fix disk full')
  expect(drawn).not.toContain('Loose chat in Documents')
  expect(drawn).not.toContain(GIT_FAILED_LINE)
})

test('a record whose common dir git says is not a repository is left out: no git-failed and no data error', async ($: Engine, on) => {
  const stale = recordOf('local_7f3a0006', {
    title: 'Stale scratch session',
    cwd: '/test-stale/scratch',
    gitAnchors: [{ commonDir: STALE_COMMON_DIR }],
  })
  const host = stubHost(on, {
    records: [OWN_RECORD, stale],
    gitErrors: { [STALE_COMMON_DIR]: `fatal: not a git repository: '${STALE_COMMON_DIR}'` },
  })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Fix disk full')
  expect(drawn).not.toContain('Stale scratch session')
  expect(drawn).not.toContain(GIT_FAILED_LINE)
  expect(await bandDrawn($)).not.toContain('data error')
})

test('a git failure that is not a not-a-repository answer still gives git-failed and data error', async ($: Engine, on) => {
  const broken = recordOf('local_7f3a0007', {
    title: 'Broken config session',
    cwd: '/test-broken',
    gitAnchors: [{ commonDir: BROKEN_COMMON_DIR }],
  })
  const host = stubHost(on, {
    records: [OWN_RECORD, broken],
    gitErrors: { [BROKEN_COMMON_DIR]: `fatal: bad config line 1 in file ${BROKEN_COMMON_DIR}` },
  })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Broken config session')
  expect(drawn).toContain(GIT_FAILED_LINE)
  expect(await bandDrawn($)).toContain('data error')
})

test('ux4-2: a first poll with no repo context draws the failure line, not Loading', async ($: Engine, on) => {
  const host = stubHost(on, { repoDenies: true })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Could not read the repo: state unknown')
  expect(drawn).not.toContain('Loading the repo...')
})

test('pm1-9: an open issue of a closed milestone is drawn under that milestone title, marked closed', async ($: Engine, on) => {
  const issues = JSON.stringify([
    {
      number: 3,
      title: 'Issue of a closed milestone',
      updatedAt: '2026-10-20T16:00:00Z',
      url: 'https://github.com/acme/app/issues/3',
      milestone: { number: 50, title: 'Milestone Old' },
      labels: [],
      state: 'OPEN',
    },
  ])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Milestone Old · closed')
  expect(drawn).toContain('Issue of a closed milestone')
  expect(drawn).not.toContain('No milestone / issue')
})

test('the override prune keeps the override of a session in another repo, since its record is still in the folder', async ($: Engine, on) => {
  const other = recordOf('local_7f3a0500', { title: 'Other repo session', cwd: '/work/other', gitAnchors: [{ commonDir: OTHER_COMMON_DIR }] })
  const host = stubHost(on, { records: [OWN_RECORD, other], remotes: { [OTHER_COMMON_DIR]: OTHER_REMOTE } })
  host.store.set('override:local_7f3a0500', { issue: 9, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.store.has('override:local_7f3a0500')).toBe(true)
  // The other repo's session is listed by its own window, not this one.
  expect(await drawnPane($)).not.toContain('Other repo session')
})

test('gh takes owner and name as strings (-f, W2)', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const graphql = host.argvs.find(argv => argv.includes('graphql'))
  expect(graphql).toContain('owner=acme')
  expect(graphql).toContain('name=app')
  expect(graphql?.includes('-F')).toBe(false)
})

test('S6: an override whose session no record lists, or that is 30 days old, is dropped', async ($: Engine, on) => {
  const host = stubHost(on, { records: [OWN_RECORD, recordOf('local_7f3a0002', { cliSessionId: 'sess-two' })] })
  host.store.set('override:local_ffff9999', { issue: 5, ts: 0 })
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  host.store.set('override:local_7f3a0002', { issue: 7, ts: -31 * DAY_MS })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect([...host.store.keys()]).toEqual([`override:${SESSION_ID}`])
})

test('S4: a remote on another host with the same owner and name is not this repo', async ($: Engine, on) => {
  const other = recordOf('local_7f3a0003', {
    title: 'Other host session',
    cwd: '/work/other',
    gitAnchors: [{ commonDir: OTHER_COMMON_DIR }],
  })
  // The positive control: the same owner and name on github.com, in another clone, is this repo.
  const sibling = recordOf('local_7f3a0004', {
    title: 'GitHub sibling session',
    cwd: '/work/sibling',
    gitAnchors: [{ commonDir: SIBLING_COMMON_DIR }],
  })
  const host = stubHost(on, {
    records: [OWN_RECORD, other, sibling],
    remotes: { [OTHER_COMMON_DIR]: OTHER_REMOTE, [SIBLING_COMMON_DIR]: 'https://github.com/acme/app.git' },
  })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The poll ran: the GitHub root asked gh for its three lists, and git was asked once for each other record's origin.
  expect(ghCalls(host)).toBe(4)
  expect(remoteAsks(host, OTHER_COMMON_DIR)).toBe(1)
  expect(remoteAsks(host, SIBLING_COMMON_DIR)).toBe(1)
  const drawn = await drawnPane($)
  expect(drawn).toContain('GitHub sibling session')
  expect(drawn).not.toContain('Other host session')
})

test('S4: a root origin that is not on GitHub is no-github mode: no gh call and the no-remote line', async ($: Engine, on) => {
  const host = stubHost(on, { rootRemote: OTHER_REMOTE })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(0)
  expect(await drawnPane($)).toContain('no GitHub remote for this repo')
})

test('S1: at most 2000 Desktop files are read per poll', async ($: Engine, on) => {
  const many = Array.from({ length: 2100 }, (_, index) => recordOf(`local_${String(index).padStart(8, '0')}`))
  const host = stubHost(on, { records: many })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.reads).toBeLessThan(2001)
  // One poll ran, and it read exactly the cap (DESKTOP_SCAN_MAX): no fewer files than the cap allows.
  expect(ghCalls(host)).toBe(4)
  expect(host.reads).toBe(2000)
})

// The newest 64 candidates, plus the other members of the scan window (4 x 64 others), keep their branch read; this window adds one.
test('S1: at most 4 x 64 others plus this window are read for their branch per poll', async ($: Engine, on) => {
  const many = Array.from({ length: 300 }, (_, index) =>
    recordOf(`local_${String(index).padStart(8, '0')}`, { lastActivityAt: index, cwd: `/work/app-${index}` }),
  )
  const host = stubHost(on, { records: [OWN_RECORD, ...many] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const branchReads = host.argvs.filter(argv => argv.includes('symbolic-ref') && argv.at(-1) === 'HEAD')
  expect(branchReads.length).toBeLessThanOrEqual(4 * 64 + 1)
  // Exactly the scan window (CANDIDATE_MAX 64 x MEMBERSHIP_SCAN_FACTOR 4): the 256 newest others, each once, and this window.
  const newest = many.slice(-4 * 64).map(record => String(record.cwd))
  expect(branchReads.map(argv => argv[argv.indexOf('-C') + 1]).sort()).toEqual([REPO_ROOT, ...newest].sort())
})

test('S1: a record file over RECORD_MAX_BYTES is skipped unread and not counted unreadable, and the partial scan keeps its override', async ($: Engine, on) => {
  const atCap = recordOf('local_7f3a0010', { title: 'Record at the size cap' })
  const overCap = recordOf('local_7f3a0011', { title: 'Record over the size cap' })
  const host = stubHost(on, {
    records: [OWN_RECORD, atCap, overCap],
    sizes: { [recordPath('local_7f3a0010')]: RECORD_MAX_BYTES, [recordPath('local_7f3a0011')]: RECORD_MAX_BYTES + 1 },
  })
  host.store.set('override:local_7f3a0011', { issue: 7, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // This window's record and the one at the cap are read; the one over it is not.
  expect(host.reads).toBe(2)
  const drawn = await drawnPane($)
  expect(drawn).toContain('Record at the size cap')
  expect(drawn).not.toContain('Record over the size cap')
  expect(drawn).not.toContain('could not be read')
  expect(await bandDrawn($)).not.toContain('data error')
  // A skipped file leaves the scan partial, so no override is pruned (R2-01).
  expect(host.store.has('override:local_7f3a0011')).toBe(true)
})

test('an archived session of this repo within 72 h is not drawn, even with an open PR, and git is not asked about it', async ($: Engine, on) => {
  const archivedCommonDir = '/work/archived/.git'
  const archived = recordOf('local_7f3a0300', {
    title: 'Archived one',
    isArchived: true,
    lastActivityAt: 0,
    cwd: '/work/archived',
    gitAnchors: [{ commonDir: archivedCommonDir }],
  })
  const host = stubHost(on, {
    records: [OWN_RECORD, archived],
    branches: { '/work/archived': 'feature/archived' },
    openPrs: [{ number: 78, title: 'Archived PR', headRefName: 'feature/archived' }],
  })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Fix disk full')
  expect(drawn).not.toContain('Archived one')
  // Neither its membership nor its branch is asked of git.
  expect(remoteAsks(host, archivedCommonDir)).toBe(0)
  expect(host.argvs.some(argv => argv.includes('symbolic-ref') && argv.at(-1) === 'HEAD' && argv.includes('/work/archived'))).toBe(false)
})

test('W6: an archived parent is not drawn as a row nor as a label, and its live spawn is a └ row of Recents whose timeline names it', async ($: Engine, on) => {
  const parentCommonDir = '/work/parent/.git'
  const parent = recordOf('local_7f3a0009', {
    title: 'Archived parent',
    isArchived: true,
    cwd: '/work/parent',
    gitAnchors: [{ commonDir: parentCommonDir }],
  })
  const child = { ...OWN_RECORD, spawnedFrom: { sessionId: 'local_7f3a0009', title: 'Archived parent' } }
  const host = stubHost(on, { records: [parent, child] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // No membership check asked git for the parent's origin.
  expect(remoteAsks(host, parentCommonDir)).toBe(0)
  const tree = await drawnTree($, 'desktop')
  // The label line is Recents, plain Text, not the parent's title.
  const label = groupLabelIn(tree, 'recents')
  expect(label?.type).toBe('Text')
  expect(textIn(label)).toBe('Recents')
  // The spawn is the group's last row, and its timeline names the parent.
  expect(isInGroup(tree, 'recents', SESSION_ID)).toBe(true)
  expect(branchOf(tree, SESSION_ID)).toBe('└')
  const drawn = JSON.stringify(tree)
  expect(drawn).toContain('spawned from Archived parent')
  // The parent has no row of its own (no title line, no state glyph): its title is drawn once, in the timeline.
  expect(branchOf(tree, 'local_7f3a0009')).toBeUndefined()
  expect(drawn.split('Archived parent').length - 1).toBe(1)
})

test('P4: an archived parent\'s live fork is a └ row of Recents whose timeline names the parent', async ($: Engine, on) => {
  const parentId = 'local_7f3a0430'
  const parentCwd = '/work/ended-fork-parent'
  const parent = recordOf(parentId, {
    title: 'Ended fork parent',
    isArchived: true,
    cwd: parentCwd,
    gitAnchors: [{ commonDir: `${parentCwd}/.git` }],
  })
  // The fork link carries no title: the parent's own record names it in the fork's timeline.
  const fork = { ...OWN_RECORD, forkedFromSessionId: parentId }
  const host = stubHost(on, { records: [parent, fork] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const tree = await drawnTree($, 'desktop')
  // The label line is Recents, plain Text: the parent's title is no label and no link.
  const label = groupLabelIn(tree, 'recents')
  expect(label?.type).toBe('Text')
  expect(textIn(label)).toBe('Recents')
  expect(isInGroup(tree, 'recents', SESSION_ID)).toBe(true)
  expect(branchOf(tree, SESSION_ID)).toBe('└')
  expect(JSON.stringify(tree)).toContain('forked from Ended fork parent')
  // The archived parent has no state row.
  expect(branchOf(tree, parentId)).toBeUndefined()
  // Neither its origin (get-url) nor its branch (symbolic-ref) is asked of git.
  const asksParent = (argv: string[]): boolean =>
    (argv.includes('get-url') || argv.includes('symbolic-ref')) && argv.some(arg => arg.startsWith(parentCwd))
  expect(host.argvs.some(asksParent)).toBe(false)
  await expectClean(host, $)
})

test('P2: an archived parent is a context ancestor: its live spawn is a └ row of Recents whose timeline names it, and git is not asked about it', async ($: Engine, on) => {
  const parent = recordOf('local_7f3a0401', {
    title: 'Ended parent',
    isArchived: true,
    cwd: '/work/ended',
    gitAnchors: [{ commonDir: '/work/ended/.git' }],
  })
  // The spawn link carries no title: only the parent's own record can name it.
  const child = { ...OWN_RECORD, spawnedFrom: { sessionId: 'local_7f3a0401' } }
  const host = stubHost(on, { records: [parent, child] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const tree = await drawnTree($)
  expect(JSON.stringify(tree)).toContain('spawned from Ended parent')
  // The spawn is a └ row under Recents, and the parent has no row.
  expect(textIn(groupLabelIn(tree, 'recents'))).toBe('Recents')
  expect(isInGroup(tree, 'recents', SESSION_ID)).toBe(true)
  expect(branchOf(tree, SESSION_ID)).toBe('└')
  expect(branchOf(tree, 'local_7f3a0401')).toBeUndefined()
  // Neither its origin (get-url) nor its branch (symbolic-ref) is asked of git.
  expect(host.argvs.some(argv => argv.includes('/work/ended') || argv.includes('/work/ended/.git'))).toBe(false)
  await expectClean(host, $)
})

test('P2: a fork of an archived session hangs under the nearest listed ancestor, and its timeline names the archived one', async ($: Engine, on) => {
  const grandparent = recordOf('local_7f3a0410', { title: 'Listed grandparent' })
  const middle = recordOf('local_7f3a0411', { title: 'Ended middle', isArchived: true, forkedFromSessionId: 'local_7f3a0410' })
  const child = { ...OWN_RECORD, forkedFromSessionId: 'local_7f3a0411' }
  const host = stubHost(on, { records: [grandparent, middle, child] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Listed grandparent')
  expect(drawn).toContain('forked from Ended middle')
  expect(drawn).toContain('└')
  await expectClean(host, $)
})

test('P2: a live parent of another repo is a context ancestor too: the spawn is a └ row of Recents whose timeline names it', async ($: Engine, on) => {
  const parent = recordOf('local_7f3a0412', { title: 'Other repo parent', cwd: '/work/other', gitAnchors: [{ commonDir: OTHER_COMMON_DIR }] })
  const child = { ...OWN_RECORD, spawnedFrom: { sessionId: 'local_7f3a0412' } }
  const host = stubHost(on, { records: [parent, child], remotes: { [OTHER_COMMON_DIR]: OTHER_REMOTE } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const tree = await drawnTree($)
  expect(JSON.stringify(tree)).toContain('spawned from Other repo parent')
  expect(textIn(groupLabelIn(tree, 'recents'))).toBe('Recents')
  expect(isInGroup(tree, 'recents', SESSION_ID)).toBe(true)
  expect(branchOf(tree, SESSION_ID)).toBe('└')
  expect(branchOf(tree, 'local_7f3a0412')).toBeUndefined()
  await expectClean(host, $)
})

// The Desktop sidebar Groups, as claude_desktop_config.json files them (preferences.epitaxyPrefs, the Desktop's own shape).
const DESKTOP_GROUPS = [
  { id: 'g-1', name: 'Alpha group' },
  { id: 'g-2', name: 'Beta group' },
]
const desktopConfigOf = (assignments: Record<string, string>): string =>
  JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'acc/org': { groups: DESKTOP_GROUPS, assignments } } } } })
const FORK_ID = 'local_7f3a0420'
const FORK = recordOf(FORK_ID, { title: 'Forked child', forkedFromSessionId: SESSION_ID })
// The fork filed in another Group than its parent (this window's session).
const CUT_CONFIG = desktopConfigOf({ [`code:${SESSION_ID}`]: 'g-1', [`code:${FORK_ID}`]: 'g-2' })
const configReads = (host: Host): number => host.readPaths.filter(path => path === DESKTOP_CONFIG_PATH).length

test('P2: a fork filed in another Desktop Group than its parent is cut to a titled row under that Group\'s label; with no config it hangs under its parent in Recents', async ($: Engine, on) => {
  const options: StubOptions = { records: [OWN_RECORD, FORK] }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const uncut = await drawnTree($)
  expect(isInGroup(uncut, 'recents', FORK_ID)).toBe(true)
  expect(branchOf(uncut, FORK_ID)).toBe('└')
  options.desktopConfig = CUT_CONFIG
  await host.clock.advance(POLL_MS)
  const tree = await drawnTree($, 'desktop')
  // The Group's name labels the fork's group in plain bold Text, never Markdown, and the fork's row there carries its title.
  const label = groupLabelIn(tree, 'g-2')
  expect(label?.type).toBe('Text')
  expect(label?.props?.bold).toBe(true)
  expect(textIn(label)).toBe('Beta group')
  expect(isInGroup(tree, 'g-2', FORK_ID)).toBe(true)
  expect(isInGroup(tree, 'g-1', FORK_ID)).toBe(false)
  expect(branchOf(tree, FORK_ID)).toBe('└')
  expect(JSON.stringify(keyedIn(tree, `head-${FORK_ID}`))).toContain('Forked child')
  await expectClean(host, $)
})

test('P2: the Desktop config is read once while its mtime holds, and again when it changes', async ($: Engine, on) => {
  const options: StubOptions = { records: [OWN_RECORD, FORK], desktopConfig: CUT_CONFIG }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(configReads(host)).toBe(1)
  const cut = await drawnTree($)
  expect(textIn(groupLabelIn(cut, 'g-2'))).toBe('Beta group')
  expect(isInGroup(cut, 'g-2', FORK_ID)).toBe(true)
  await host.clock.advance(POLL_MS)
  // The second poll ran, and the unchanged config was not read again.
  expect(ghCalls(host)).toBe(8)
  expect(configReads(host)).toBe(1)
  // The fork is filed back with its parent's Group, under a new mtime.
  options.desktopConfig = desktopConfigOf({ [`code:${SESSION_ID}`]: 'g-1', [`code:${FORK_ID}`]: 'g-1' })
  options.mtimes = { [DESKTOP_CONFIG_PATH]: 2 }
  await host.clock.advance(POLL_MS)
  expect(configReads(host)).toBe(2)
  // The fork is drawn with its parent in the Alpha group, and the Beta group is gone.
  const refiled = await drawnTree($)
  expect(isInGroup(refiled, 'g-1', FORK_ID)).toBe(true)
  expect(keyedIn(refiled, 'group-g-2')).toBeUndefined()
  await expectClean(host, $)
})

// Each config that names no Group, and how many times the poll reads it: a missing file and one over the cap are never read.
const DESKTOP_CONFIG_MAX_BYTES = 4 * 1024 * 1024
const NO_GROUP_CONFIGS: [string, StubOptions, number][] = [
  ['a missing config', {}, 0],
  ['a config over 4 MiB in its listing', { desktopConfig: CUT_CONFIG, sizes: { [DESKTOP_CONFIG_PATH]: DESKTOP_CONFIG_MAX_BYTES + 1 } }, 0],
  ['an unparsable config', { desktopConfig: '{"preferences": ' }, 1],
]
// Whether the fork's row is drawn among its parent's children: no Group cut it from this window's session.
const isForkUnderParent = (tree: unknown): boolean => keyedIn(keyedIn(tree, `children-${SESSION_ID}`), `head-${FORK_ID}`) !== undefined

for (const [name, config, reads] of NO_GROUP_CONFIGS) {
  test(`P2: ${name} gives no Groups, with no error line, log line or toast`, async ($: Engine, on) => {
    const host = stubHost(on, { records: [OWN_RECORD, FORK], ...config })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    // The poll looked for the config in its folder.
    expect(host.listed).toContain(DESKTOP_CONFIG_DIR)
    expect(configReads(host)).toBe(reads)
    expect(isForkUnderParent(await drawnTree($))).toBe(true)
    expect(host.toasts).toEqual([])
    await expectClean(host, $)
  })
}

test('P2: a config folder whose listing fails keeps the last Groups read, with no error line, log line or toast', async ($: Engine, on) => {
  const options: StubOptions = { records: [OWN_RECORD, FORK], desktopConfig: CUT_CONFIG }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(isInGroup(await drawnTree($), 'g-2', FORK_ID)).toBe(true)
  options.unlistable = [DESKTOP_CONFIG_DIR]
  await host.clock.advance(POLL_MS)
  // The next poll was refused the folder, and the cut of the first poll stays: the Group's name still labels the fork's group.
  expect([...new Set(host.denies)]).toEqual([`fs.list refused: ${DESKTOP_CONFIG_DIR}`])
  const tree = await drawnTree($)
  expect(textIn(groupLabelIn(tree, 'g-2'))).toBe('Beta group')
  expect(isInGroup(tree, 'g-2', FORK_ID)).toBe(true)
  const drawn = JSON.stringify(tree)
  for (const start of FAILURE_LINE_STARTS) expect(drawn).not.toContain(start)
  expect(host.logs).toEqual([])
  expect(host.toasts).toEqual([])
})

test('P2: no content of the Desktop config reaches the log', async ($: Engine, on) => {
  const secretGroup = 'Keep this group name out of the log'
  const secretSetting = 'keep-this-mcp-setting-out'
  // The file also holds the MCP settings.
  const desktopConfig = JSON.stringify({
    mcpServers: { vault: { env: { SETTING: secretSetting } } },
    preferences: {
      epitaxyPrefs: {
        'dframe-group-scopes': { 'acc/org': { groups: [{ id: 'g-9', name: secretGroup }], assignments: { [`code:${FORK_ID}`]: 'g-9' } } },
      },
    },
  })
  // gh times out, so the poll logs its failure lines.
  const host = stubHost(on, { gh: 'timeout', records: [OWN_RECORD, FORK], desktopConfig })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The config was read and used: the pane still draws, with the Group's name as a label, and only the pane holds it.
  expect(await drawnPane($)).toContain(secretGroup)
  expectNoRecordContent(host)
  for (const line of host.logs) expect(line.includes(secretGroup) || line.includes(secretSetting)).toBe(false)
  expect(host.toasts).toEqual([])
})

test('S2: control characters in a record title never reach the drawn pane', async ($: Engine, on) => {
  stubHost(on, { records: [recordOf(SESSION_ID, { cliSessionId: SELF, title: '\u001b]0;evil\u0007Title' })] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  const drawn = await drawnPane($)
  expect(drawn).toContain('evil')
  expect(drawn.includes('\\u001b')).toBe(false)
  expect(drawn.includes('\\u0007')).toBe(false)
})

// Each log line names a failure only: no record title, remote or records path.
function expectNoRecordContent(host: Host): void {
  expect(host.logs.length).toBeGreaterThan(0)
  for (const line of host.logs) {
    expect(line).toMatch(/^keeptrack: [\w ()-]+$/)
    expect(line.includes(SECRET_TITLE) || line.includes(REMOTE) || line.includes(RECORDS)).toBe(false)
  }
}

test('no record content reaches the log: each line names only a failure', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'timeout', records: [recordOf(SESSION_ID, { cliSessionId: SELF, title: SECRET_TITLE })] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expectNoRecordContent(host)
})

// More failure paths for the same rule. A second record carries the secret title too; its file cannot be read where the case says so.
const SECRET_RECORD = recordOf('local_7f3a0013', { title: SECRET_TITLE })
const LOG_FAILURES: [string, StubOptions][] = [
  ['a gh failure whose stderr echoes a record', { gh: { exitCode: 1, stderr: `${SECRET_TITLE} at ${recordPath(SESSION_ID)}` } }],
  ['an unreadable record beside a gh answer that cannot be read', { gh: 'unreadable', unreadable: [recordPath('local_7f3a0013')] }],
  ['a poll that throws', { storeKeysDenies: true }],
]

for (const [name, failure] of LOG_FAILURES) {
  test(`no record content reaches the log on ${name}`, async ($: Engine, on) => {
    const records = [recordOf(SESSION_ID, { cliSessionId: SELF, title: SECRET_TITLE }), SECRET_RECORD]
    const host = stubHost(on, { ...failure, records })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expectNoRecordContent(host)
  })
}

// The band as the engine draws it now, as JSON text (the terminal surface).
async function bandDrawn($: Engine): Promise<string> {
  const band = await $.ui.mount({ plugin: 'keeptrack-repo-pane', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  const drawn = JSON.stringify(await band.drawn())
  await band.unmount()
  return drawn
}

// The kit cannot raise turn.start or turn.complete (tests/turn.test.ts), so no turn runs here: this checks the agents alone.
test('two agents still running read Running with 2 agents, and Idle once they finish (no turn event is raised)', async ($: Engine, on) => {
  const agents = [
    { id: 'agent-1', status: 'running' },
    { id: 'agent-2', status: 'running' },
  ]
  const host = stubHost(on, { agents })
  await $.session.start(SESSION)
  await host.clock.settle()
  await host.clock.advance(BAND_TICK_MS)
  const running = await bandDrawn($)
  expect(running).toContain('Running')
  expect(running).toContain('2 agents')
  for (const agent of agents) agent.status = 'completed'
  await host.clock.advance(BAND_TICK_MS)
  expect(await bandDrawn($)).toContain('Idle')
})

test('a repo whose only remote is named github is read from it: the poll runs and the pane names no missing remote', async ($: Engine, on) => {
  const host = stubHost(on, { noOrigin: { name: 'github', url: 'git@github-claude-global:acme/app.git' } })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).not.toContain('no GitHub remote for this repo')
})

test('a band draw starts the poll when no session.start ran in this module instance (a reloaded module)', async ($: Engine, on) => {
  const host = stubHost(on)
  const band = await $.ui.mount({ plugin: 'keeptrack-repo-pane', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await band.unmount()
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(8)
})

test('state2-2: a new session drops the previous session\'s turn, so the band reads Idle', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(await bandDrawn($)).toContain('Running')
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(await bandDrawn($)).toContain('Idle')
})

test('state2-2: a tool call with no turn start infers a running turn', async ($: Engine, on) => {
  stubHost(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash' })
  expect(await bandDrawn($)).toContain('Running')
})

test('state2-2: a turn past TURN_MAX_AGE_MS with no end event reads Idle on the band tick', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await host.clock.advance(TURN_MAX_AGE_MS - BAND_TICK_MS)
  expect(await bandDrawn($)).toContain('Running')
  await host.clock.advance(2 * BAND_TICK_MS)
  expect(await bandDrawn($)).toContain('Idle')
})

test('the band redraws each minute while idle, so the time since the last turn moves', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  const drawnBefore = await bandDrawn($)
  const before = host.redraws
  await host.clock.advance(60_000)
  expect(host.redraws).toBeGreaterThan(before)
  // No turn ends here (these tests raise no turn end: tests/turn.test.ts), so the idle band has no last turn yet: it reads Idle
  // alone before and after the minute. The time since a last turn moving at the minute is pinned in tests/band.test.ts.
  for (const drawn of [drawnBefore, await bandDrawn($)]) {
    expect(drawn).toContain('"Idle"')
    expect(drawn).not.toContain('just now')
    expect(drawn).not.toContain(' ago')
  }
})

// ---- The gauntlet round 1 findings (F01 to F21): each test pins the behaviour the source has now ----
// Not pinned by a test: F06 (the turn.abort agentId guard), because the test engine has no $.turn.abort, so no test can raise
// that event. F01 and F03 are pinned on the pane side by tests/pane.test.ts; F08 by its own test below.

// The poll deadline of hooks/register.tsx (POLL_DEADLINE_MS).
const POLL_DEADLINE_MS = 30_000
const SLOW_ISSUE = { number: 9, title: 'Slow issue', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/9', milestone: null, labels: [] }
const GIT_FAILED_LINE = 'git failed in this folder · sessions shown without branch'
const NO_REMOTE_LINE = 'no GitHub remote for this repo'
const ISSUE_LIST_JSON = JSON.stringify([
  { number: 7, title: 'Open issue', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/7', milestone: null, labels: [] },
])
const NEVER = (): Promise<void> => new Promise<void>(() => undefined)

test('F01: only the 100-PR cap was hit, and the snapshot is truncated so the partial-list line is drawn', async ($: Engine, on) => {
  stubHost(on, { prTotal: 101 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).toContain('list is partial')
})

test('F02: a failed session.repo read keeps the last repo context: the poll goes on and no no-remote line appears', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const before = ghCalls(host)
  options.repoDenies = true
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBeGreaterThan(before)
  const drawn = await drawnPane($)
  expect(drawn).not.toContain(NO_REMOTE_LINE)
  expect(drawn).toContain('Fix disk full')
})

test('F02: a git timeout reading the origin keeps the last repo context: no no-remote line', async ($: Engine, on) => {
  const options: StubOptions = { noOrigin: { name: 'github', url: 'git@github-claude-global:acme/app.git' } }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).not.toContain(NO_REMOTE_LINE)
  const rootAsks = (last: string): number =>
    host.argvs.filter(argv => argv.includes('-C') && argv[argv.indexOf('-C') + 1] === REPO_ROOT && argv.at(-1) === last).length
  expect(rootAsks('origin')).toBe(1)
  expect(rootAsks('remote')).toBe(1)
  options.originTimesOut = true
  await host.clock.advance(POLL_MS)
  // The poll after the change asked git for the origin once, and its timeout is not read as no origin: no remote listing follows.
  expect(rootAsks('origin')).toBe(2)
  expect(rootAsks('remote')).toBe(1)
  const drawn = await drawnPane($)
  expect(drawn).not.toContain(NO_REMOTE_LINE)
  expect(drawn).toContain('Fix disk full')
})

test('F05: archived records take no candidate slot, so a live session behind 100 archived ones is still drawn', async ($: Engine, on) => {
  const archived = Array.from({ length: 100 }, (_, index) =>
    recordOf(`local_${String(index).padStart(8, '0')}`, { title: 'Archived one', isArchived: true, lastActivityAt: 1_000 + index }),
  )
  const live = recordOf('local_7f3a0100', { title: 'Old live session', lastActivityAt: 0 })
  stubHost(on, { records: [OWN_RECORD, live, ...archived] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  const drawn = await drawnPane($)
  expect(drawn).toContain('Old live session')
  expect(drawn).not.toContain('Archived one')
})

test('F07: a poll whose call never settles fails at its deadline, keeps the last sessions and logs the failure name', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = NEVER()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
  await host.clock.advance(POLL_DEADLINE_MS)
  expect(host.logs).toContain('keeptrack: poll failed (PollDeadline)')
  expect(await drawnPane($)).toContain('Fix disk full')
})

test('F07: a poll slower than its 30 s deadline is abandoned, and its late result still lands when no newer poll wrote', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = gate
  await host.clock.advance(POLL_MS)
  await host.clock.advance(50_000)
  options.issues = JSON.stringify([SLOW_ISSUE])
  release()
  await host.clock.settle()
  expect(host.logs.some(line => line.includes('poll failed'))).toBe(true)
  expect(await drawnPane($)).toContain('Slow issue')
})

test('the band flags a snapshot with errors as data error', async ($: Engine, on) => {
  stubHost(on, { gh: { exitCode: 1, stderr: 'boom' } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).toContain('data error')
})

test('a clean snapshot draws no data error flag', async ($: Engine, on) => {
  stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).not.toContain('data error')
})

test('a snapshot whose only error is no-remote draws no data error in the band', async ($: Engine, on) => {
  const host = stubHost(on, { rootRemote: OTHER_REMOTE })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain(NO_REMOTE_LINE)
  expect(await bandDrawn($)).not.toContain('data error')
})

test('waiting: the band says waiting for you while the engine asks the person about a tool call, and clears when the call runs', async ($: Engine, on) => {
  const options: StubOptions = { permission: 'ask' }
  stubHost(on, options)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(await bandDrawn($)).toContain('waiting for you')
  await $.tool.call({ tool: 'Bash' })
  expect(await bandDrawn($)).not.toContain('waiting for you')
})

test('waiting: a verdict other than ask clears the flag, so an answered question does not stay waiting', async ($: Engine, on) => {
  const options: StubOptions = { permission: 'ask' }
  stubHost(on, options)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(await bandDrawn($)).toContain('waiting for you')
  options.permission = 'allow'
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(await bandDrawn($)).not.toContain('waiting for you')
})

test('waiting: no Askaway folder is read, so an Askaway question cannot light the band', async ($: Engine, on) => {
  const host = stubHost(on, {})
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.listed.some(path => path.includes('askaway'))).toBe(false)
  expect(host.readPaths.some(path => path.includes('askaway'))).toBe(false)
  expect(await bandDrawn($)).not.toContain('waiting for you')
})

// ux-8: a gh that is missing or not signed in draws its pane line, and no data error in the band (the pane already says which).
const UNFLAGGED_GH_CASES: [string, GhMode, string][] = [
  ['gh-missing', 'missing', 'gh not found: showing sessions only'],
  ['gh-auth', { exitCode: 1, stderr: 'To get started with GitHub CLI, please run: gh auth login' }, 'gh is not signed in'],
]
for (const [error, gh, line] of UNFLAGGED_GH_CASES) {
  test(`ux-8: a ${error} draws no data error in the band`, async ($: Engine, on) => {
    const host = stubHost(on, { gh })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect(await drawnPane($)).toContain(line)
    expect(await bandDrawn($)).not.toContain('data error')
  })
}

test('F07: a poll that throws before its snapshot write logs the failure name, not silence', async ($: Engine, on) => {
  const host = stubHost(on, { storeKeysDenies: true })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.logs.some(line => line.startsWith('keeptrack: poll failed ('))).toBe(true)
})

test('F14: a poll that failed at its deadline clears the polling flag, so the next tick polls again', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = NEVER()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
  await host.clock.advance(POLL_DEADLINE_MS)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(12)
})

// A render polls when a full cadence has passed since the last poll began (resumePolling), so after a deadline it retries too.
test('F14: after a poll failed at its deadline, a render a full cadence after that poll began polls again, before the next tick', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await host.clock.settle()
  // The pane opens 10 s after the first poll: its ticks fall at 70 s and 130 s, and the open starts no poll.
  await host.clock.advance(10_000)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  options.gate = NEVER()
  // At 60 s a render starts the poll that hangs; the tick at 70 s starts nothing beside it, and its deadline falls at 90 s.
  await host.clock.advance(50_000)
  await drawnPane($)
  await host.clock.advance(POLL_DEADLINE_MS)
  expect(ghCalls(host)).toBe(8)
  expect(host.logs).toContain('keeptrack: poll failed (PollDeadline)')
  await host.clock.advance(30_000)
  expect(ghCalls(host)).toBe(8)
  // At 120 s, before the tick at 130 s, a render finds a full cadence since the failed poll began and polls again.
  await drawnPane($)
  await host.clock.advance(0)
  expect(ghCalls(host)).toBe(12)
})

test('F11: a running tool name is drawn without control characters and within its length cap', async ($: Engine, on) => {
  stubHost(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.call({ tool: `mcp__vendor\u001b]0;evil\u0007__${'z'.repeat(200)}` })
  const band = await bandDrawn($)
  expect(band).toContain('MCP vendor')
  expect(band.includes('\\u001b')).toBe(false)
  expect(band.includes('z'.repeat(TOOL_NAME_MAX))).toBe(false)
  // A tool that is not MCP is drawn by its name: control characters made spaces, then cut to exactly TOOL_NAME_MAX characters,
  // the last one plain's ellipsis.
  await $.tool.call({ tool: `Bash\u001b]0;evil\u0007${'y'.repeat(200)}` })
  const cut = `${`Bash ]0;evil ${'y'.repeat(200)}`.slice(0, TOOL_NAME_MAX - 1)}…`
  expect(Array.from(cut).length).toBe(TOOL_NAME_MAX)
  expect(await bandDrawn($)).toContain(JSON.stringify(cut))
})

test('F13: a gh timeout after a good poll keeps the last good issues and draws its line', async ($: Engine, on) => {
  const options: StubOptions = { issues: ISSUE_LIST_JSON }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('1 open issue')
  options.gh = 'timeout'
  await host.clock.advance(POLL_MS)
  const drawn = await drawnPane($)
  expect(drawn).toContain('1 open issue')
  expect(drawn).toContain('GitHub did not answer in time')
  expect(host.logs).toContain('keeptrack: gh issue call failed (timeout)')
})

// The log names each gh failure's kind, and never its stderr (F03).
const GH_FAILURE_KINDS: [string, GhMode][] = [
  ['network/DNS', { exitCode: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com' }],
  ['network/DNS', { exitCode: 1, stderr: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host' }],
  ['login', { exitCode: 1, stderr: 'To get started with GitHub CLI, please run: gh auth login' }],
  ['rate limit', { exitCode: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' }],
  ['other', { exitCode: 1, stderr: 'synthetic failure' }],
  ['timeout', 'timeout'],
  ['gh missing', 'missing'],
]

for (const [kind, gh] of GH_FAILURE_KINDS) {
  test(`a gh failure logs its kind: ${kind}`, async ($: Engine, on) => {
    const host = stubHost(on, { gh })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect(host.logs).toContain(`keeptrack: gh issue call failed (${kind})`)
    expect(host.logs).toContain(`keeptrack: gh api call failed (${kind})`)
    if (typeof gh === 'object') for (const line of host.logs) expect(line.includes(gh.stderr)).toBe(false)
  })
}

test('F17: an agent list that rejects still lets the band redraw on its tick, and logs the failure name', async ($: Engine, on) => {
  const options: StubOptions = { agents: [{ id: 'agent-1', status: 'running' }] }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await host.clock.settle()
  await host.clock.advance(BAND_TICK_MS)
  const before = host.redraws
  options.agentsDenied = true
  await host.clock.advance(BAND_TICK_MS)
  expect(host.redraws).toBeGreaterThan(before)
  expect(host.logs.some(line => line.startsWith('keeptrack: agent list failed ('))).toBe(true)
})

test('a file in the records folder that is not a session record is ignored: no data error beside valid records', async ($: Engine, on) => {
  stubHost(on, { records: [OWN_RECORD], strayFiles: ['scheduled-tasks.json', 'deleted_0a1b2c3d'] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).not.toContain('data error')
  expect(await drawnPane($)).not.toContain('could not be read')
})

test('F18: a records folder that cannot be listed draws no records line', async ($: Engine, on) => {
  const host = stubHost(on, { unlistable: [`${RECORDS}/org/user`] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The scan reached the folder and was refused: no line because nothing could be read, not because no scan ran.
  expect(host.denies).toContain(`fs.list refused: ${RECORDS}/org/user`)
  const drawn = await drawnPane($)
  expect(drawn).not.toContain('session records could not be read')
  expect(drawn).not.toContain('session record could not be read')
})

// The other half of F18: a record in a folder that was listed, whose file cannot be read, is counted and draws the records line.
test('F18: a listed record file that cannot be read draws the records line, and the band flags it', async ($: Engine, on) => {
  const host = stubHost(on, { records: [OWN_RECORD, recordOf('local_7f3a0012')], unreadable: [recordPath('local_7f3a0012')] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('1 session record could not be read')
  expect(drawn).toContain('Fix disk full')
  expect(await bandDrawn($)).toContain('data error')
})

test('F21: an override stamped after the poll started survives its prune, and a negative time expires', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const records = [OWN_RECORD, recordOf('local_7f3a0002', { cliSessionId: 'sess-two' })]
  const host = stubHost(on, { records, gate })
  host.store.set('override:local_7f3a0002', { issue: 7, ts: -1 })
  await $.session.start(SESSION)
  // The mock clock starts at 0, so the poll starts at 0. The override is stamped at 1, while the poll waits on its gh calls:
  // after the poll's start, and before the poll prunes the store.
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 1 })
  await host.clock.advance(1_000)
  release()
  await host.clock.settle()
  expect([...host.store.keys()]).toEqual([`override:${SESSION_ID}`])
})

test('F08: a window that maps to an issue whose view fails reads #106 in the band, never no issue', async ($: Engine, on) => {
  const host = stubHost(on, { gh: { exitCode: 1, stderr: 'synthetic failure' } })
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const band = await bandDrawn($)
  expect(band).toContain('#106')
  expect(band).not.toContain('no issue')
  // The line the user sees in the pane for that failure (CR4).
  expect(await drawnPane($)).toContain('GitHub did not answer as expected: showing the last data')
})

test('R2-01: an override is kept while a record cannot be read, since the scan is partial', async ($: Engine, on) => {
  const unreadable = recordOf('local_7f3a0009', { title: 'x'.repeat(5000) })
  const host = stubHost(on, { records: [OWN_RECORD, unreadable] })
  host.store.set('override:local_7f3a0009', { issue: 7, ts: 0 })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(host.store.has('override:local_7f3a0009')).toBe(true)
})

test('R2-01: an override of a record past the 2000-file cap is kept', async ($: Engine, on) => {
  const many = Array.from({ length: 2100 }, (_, index) => recordOf(`local_${String(index).padStart(8, '0')}`))
  const host = stubHost(on, { records: many })
  host.store.set('override:local_00002050', { issue: 7, ts: 0 })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(host.store.has('override:local_00002050')).toBe(true)
})

test('R2-02: a gh call that exits 0 with unreadable stdout draws the gh-failed line', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'unreadable' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('GitHub did not answer as expected: showing the last data')
  expect(drawn).toContain('Fix disk full')
})

test('R2-03: a failing poll keeps the cadence, so renders between two polls do not poll again', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  options.storeKeysDenies = true
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
  for (let draw = 0; draw < 3; draw += 1) {
    await drawnPane($)
    await host.clock.settle()
  }
  expect(ghCalls(host)).toBe(8)
})

const LATE_ISSUE = {
  number: 9,
  title: 'Late issue',
  updatedAt: '2026-10-20T16:00:00Z',
  url: 'https://github.com/acme/app/issues/9',
  milestone: null,
  labels: [],
}

test('R2-04: a poll that misses its deadline writes its late result when no newer poll wrote', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = { gate }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.advance(POLL_DEADLINE_MS)
  expect(host.logs).toContain('keeptrack: poll failed (PollDeadline)')
  options.issues = JSON.stringify([LATE_ISSUE])
  release()
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Late issue')
  options.gh = { exitCode: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' }
  await host.clock.advance(POLL_MS)
  const drawn = await drawnPane($)
  expect(drawn).toContain('GitHub rate limit: showing the last data')
  expect(drawn).toContain('Late issue')
})

const NEWER_ISSUE = {
  number: 8,
  title: 'Newer issue',
  updatedAt: '2026-10-20T16:00:00Z',
  url: 'https://github.com/acme/app/issues/8',
  milestone: null,
  labels: [],
}

test('R2-04: a late poll result is discarded when a newer poll already wrote', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = gate
  await host.clock.advance(POLL_MS)
  // The held poll has made its gh calls. The polls after it run at once, and the first of them writes the newer list.
  options.gate = undefined
  options.issues = JSON.stringify([NEWER_ISSUE])
  await host.clock.advance(POLL_DEADLINE_MS + 2 * POLL_MS)
  expect(await drawnPane($)).toContain('Newer issue')
  options.issues = JSON.stringify([LATE_ISSUE])
  release()
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Newer issue')
  expect(drawn).not.toContain('Late issue')
})

test('a poll past its deadline is abandoned, and at most two abandoned polls run before the next poll is skipped', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = gate
  // Two stuck polls make 6 gh calls; the polls after them are skipped with a log line, however long the hang lasts.
  await host.clock.advance(20 * POLL_MS)
  expect(ghCalls(host)).toBe(12)
  expect(host.logs.some(line => line.startsWith('keeptrack: poll skipped ('))).toBe(true)
  await host.clock.advance(20 * POLL_MS)
  expect(ghCalls(host)).toBe(12)
  release()
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBeGreaterThan(9)
})

test('a band read that finishes after a newer read is discarded, so an ended agent is not counted again', async ($: Engine, on) => {
  let release: () => void = () => undefined
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const options: StubOptions = { agents: [{ id: 'agent-1', status: 'running' }] }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.agentHolds = [hold]
  // The band tick reads the list while it still shows one running agent, and the read waits on its hold.
  await host.clock.advance(BAND_TICK_MS)
  options.agents = []
  await $.turn.start({ text: 'work', turnId: 't1' })
  release()
  await host.clock.settle()
  // The stale read would draw the count of one running agent: '1 agent' (band.agentsOne).
  expect(await bandDrawn($)).not.toContain('1 agent')
})

test('DL7: a session with an open PR is drawn even when it is older than the 64 newest candidates', async ($: Engine, on) => {
  const newer = Array.from({ length: 64 }, (_, index) =>
    recordOf(`local_${String(index).padStart(8, '0')}`, { lastActivityAt: index + 10 }),
  )
  const old = recordOf('local_00000999', { title: 'Old PR session', lastActivityAt: 1, cwd: '/work/old' })
  const host = stubHost(on, {
    records: [OWN_RECORD, ...newer, old],
    branches: { '/work/old': 'feature/old' },
    openPrs: [{ number: 77, title: 'Old PR', headRefName: 'feature/old' }],
  })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Old PR session')
})

test('gh3-2: the PR list asks GraphQL for isCrossRepository', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.some(part => part.includes('isCrossRepository')))).toBe(true)
})

for (const [name, fork, drawn] of [
  ['a same-repo PR keeps an older session of its branch drawn', false, true],
  ['a fork PR on the same branch name does not keep an older session drawn', true, false],
] as const) {
  test(`gh3-2: ${name}`, async ($: Engine, on) => {
    // As DL7: 64 newer candidates push the old session past the cap, so only an open PR of its branch keeps it.
    const newer = Array.from({ length: 64 }, (_, index) =>
      recordOf(`local_${String(index).padStart(8, '0')}`, { lastActivityAt: index + 10 }),
    )
    const old = recordOf('local_00000999', { title: 'Old PR session', lastActivityAt: 1, cwd: '/work/old' })
    const host = stubHost(on, {
      records: [OWN_RECORD, ...newer, old],
      branches: { '/work/old': 'feature/old' },
      openPrs: [{ number: 77, title: 'Old PR', headRefName: 'feature/old', isCrossRepository: fork }],
    })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect((await drawnPane($)).includes('Old PR session')).toBe(drawn)
  })
}

const issueList = (count: number): string =>
  JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      updatedAt: '2026-10-20T10:00:00Z',
      url: `https://github.com/acme/app/issues/${index + 1}`,
      milestone: null,
      labels: [],
    })),
  )

test('DL8: an override past its 30-day TTL is not used when the scan failed', async ($: Engine, on) => {
  const unreadable = recordOf('local_7f3a0009', { title: 'x'.repeat(5000) })
  const host = stubHost(on, { records: [OWN_RECORD, unreadable] })
  // The clock moves on before any timer runs, so the override set at time 0 is 31 days old when the poll reads it.
  await host.clock.advance(31 * DAY_MS)
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('view') && argv.includes(String(ISSUE)))).toBe(false)
})

test('DL10: exactly 500 open issues draw no partial-list line, since gh is asked for one more', async ($: Engine, on) => {
  const host = stubHost(on, { issues: issueList(500) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('list') && argv.includes('501'))).toBe(true)
  expect(await drawnPane($)).not.toContain('list is partial')
})

test('DL10: 501 open issues draw the partial-list line with the first 500 kept', async ($: Engine, on) => {
  const host = stubHost(on, { issues: issueList(501) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('list is partial (first 500)')
})

test('DL11: a tag named like the checked-out branch does not make it heads/<name>, so the default branch reads no commits', async ($: Engine, on) => {
  const host = stubHost(on, { branches: { [REPO_ROOT]: 'main' }, tags: ['main'] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('log'))).toBe(false)
})

test('DL11: an unborn branch is not a git failure', async ($: Engine, on) => {
  const host = stubHost(on, { branches: { [REPO_ROOT]: 'main' }, unborn: [REPO_ROOT] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).not.toContain('git failed')
})

test('DL11: a detached HEAD is no branch and no git failure', async ($: Engine, on) => {
  const host = stubHost(on, { detached: [REPO_ROOT] })
  // An issue for this window draws its details, whose Branch line shows the branch the poll read.
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const branchReads = host.argvs.filter(argv => argv.includes('symbolic-ref') && argv.at(-1) === 'HEAD')
  expect(branchReads.map(argv => argv[argv.indexOf('-C') + 1])).toContain(REPO_ROOT)
  expect(textIn(keyedIn(await drawnTree($), 'detail-branch'))).toBe('Branch:no branch')
  expect(await drawnPane($)).not.toContain('git failed')
})

test('DL13: a last commit with an empty subject is still a commit', async ($: Engine, on) => {
  const host = stubHost(on, { log: '1700000000\t' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // Each timeline row is keyed by its session and index: the session's start, plus the commit.
  const rows = (await drawnPane($)).split(`event-${SESSION_ID}-`).length - 1
  expect(rows).toBe(2)
})

test('SP5-1: /keeptrack open or issue with extra words toasts usage and changes nothing', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open extra', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keeptrack', args: 'issue 106 extra', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual([USAGE_TOAST, USAGE_TOAST])
  expect([...host.store.keys()]).toEqual([])
})

// Poll 2 fails at its deadline before poll 3 starts, so its failure never races a newer write: this proves only that the
// newer poll draws its data after that failure. The race itself (`failedPoll` against a newer write) needs the snapshot atom
// held between its read and its write, which the test kit cannot do (SPEC section 9, ST3).
test('ST3 guard: a newer poll after a deadline failure draws its data', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = NEVER()
  await host.clock.advance(POLL_MS)
  await host.clock.advance(POLL_DEADLINE_MS)
  options.gate = undefined
  options.issues = JSON.stringify([NEWER_ISSUE])
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Newer issue')
})

// ---- Package A2: the gh data minors (DL9, RB1-4, RB1-5, SE3, SP3-1) ----

// The engine's stdout cap of $.process.run, which register.tsx also takes as its gh answer cap (GH_OUTPUT_MAX_BYTES).
const GH_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
const GH_FAILED_LINE = 'GitHub did not answer as expected: showing the last data'
// An issue item with no url: issueOf cannot read it.
const MALFORMED_ISSUE = { number: 8, title: 'Issue with no url', updatedAt: '2026-10-20T16:00:00Z', milestone: null, labels: [] }
// The query text of the GraphQL call the poll made.
const prQueryOf = (host: Host): string =>
  host.argvs.find(argv => argv.includes('graphql'))?.find(arg => arg.startsWith('query=')) ?? ''
// The issue numbers the poll asked gh to view, in order.
const viewedIssues = (host: Host): string[] => host.argvs.filter(argv => argv.includes('view')).map(argv => argv[3] ?? '')

test('DL9: a PR closing more issues than the page holds links no issue, since its lowest is not known', async ($: Engine, on) => {
  // The page holds 50 references, 17 the lowest of them; GitHub holds 60, so a lower one may sit past the page.
  const closes = Array.from({ length: 50 }, (_, index) => index + 17)
  const host = stubHost(on, { openPrs: [{ number: 5, title: 'Wide PR', headRefName: 'feature/disk', closes, closesTotal: 60 }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(prQueryOf(host)).toContain('closingIssuesReferences(first: 50) { totalCount nodes { number repository { nameWithOwner } } }')
  expect(viewedIssues(host)).toEqual([])
})

test('DL9: a PR with 11 closing issues links the lowest, the 11th, since the page holds 50', async ($: Engine, on) => {
  const closes = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 12]
  const host = stubHost(on, { openPrs: [{ number: 5, title: 'Wide PR', headRefName: 'feature/disk', closes }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(prQueryOf(host)).toContain('closingIssuesReferences(first: 50)')
  expect(viewedIssues(host)).toEqual(['12'])
})

test('RB1-4: the open milestones are read with --paginate, so a repo past 100 open milestones is not cut silently', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const milestoneCalls = host.argvs.filter(argv => argv[0] === 'gh' && argv.some(arg => arg.includes('/milestones')))
  expect(milestoneCalls).toEqual([['gh', 'api', '--paginate', 'repos/acme/app/milestones?state=open&per_page=100']])
})

test('RB1-5: a malformed issue item is dropped and counted in the log, and the rest is drawn with no failure line', async ($: Engine, on) => {
  const issues = JSON.stringify([...(JSON.parse(ISSUE_LIST_JSON) as unknown[]), MALFORMED_ISSUE])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.logs).toEqual(['keeptrack: gh issue items not readable (1)'])
  const drawn = await drawnPane($)
  expect(drawn).toContain('1 open issue')
  expect(drawn).not.toContain(GH_FAILED_LINE)
  expect(host.logs.some(line => line.includes(MALFORMED_ISSUE.title))).toBe(false)
})

test('RB1-5: an issue list whose every item is malformed is an unreadable answer: the gh-failed line', async ($: Engine, on) => {
  const host = stubHost(on, { issues: JSON.stringify([MALFORMED_ISSUE, MALFORMED_ISSUE]) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain(GH_FAILED_LINE)
  expect(host.logs).toContain('keeptrack: gh issue answer not readable')
})

test('RB1-5: a dropped item does not hide the 501st item, so the partial-list line still shows', async ($: Engine, on) => {
  const issues = JSON.stringify([...(JSON.parse(issueList(500)) as unknown[]), MALFORMED_ISSUE])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('list is partial (first 500)')
})

test('SE3: a gh answer the engine cut at its stdout cap is unreadable: the gh-failed line, nothing parsed', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'cut', issues: ISSUE_LIST_JSON })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain(GH_FAILED_LINE)
  expect(drawn).not.toContain('1 open issue')
  expect(host.logs).toContain('keeptrack: gh issue answer not readable')
})

test('SE3: a gh answer over the byte cap, counted in UTF-8 bytes, is unreadable before it is parsed', async ($: Engine, on) => {
  // Two bytes per character: under the cap in UTF-16 units, over it in bytes.
  const [issue] = JSON.parse(ISSUE_LIST_JSON) as Record<string, unknown>[]
  const issues = JSON.stringify([{ ...issue, body: 'é'.repeat(GH_OUTPUT_MAX_BYTES / 2 + 1) }])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain(GH_FAILED_LINE)
  expect(drawn).not.toContain('1 open issue')
})

test('SP3-1: both the issue list and the PR list cut draw one partial-list line each, with its own limit', async ($: Engine, on) => {
  const host = stubHost(on, { issues: issueList(501), prTotal: 101 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('list is partial (first 500)')
  expect(drawn).toContain('list is partial (first 100)')
})

test('F: a pane with two sessions under Recents, two open issues and two issue breadcrumbs is drawn on the desktop, each Markdown with a key of its own', async ($: Engine, on) => {
  const otherId = 'local_7f3a0440'
  // Each session names an issue in its title, so its breadcrumb links to that issue's page; issues 3 and 4 sit on no
  // session, so the issue list draws them.
  const records = [{ ...OWN_RECORD, title: 'Fix disk full #1' }, recordOf(otherId, { title: 'Other family #2' })]
  const host = stubHost(on, { records, issues: issueList(4) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The engine refuses the whole draw when two Markdown elements share a key, so the tree is the proof it was drawn.
  const tree = await drawnTree($, 'desktop')
  expect(keyedIn(tree, `title-${SESSION_ID}`)?.props?.text).toContain(`](#${SESSION_ID})`)
  expect(keyedIn(tree, `title-${otherId}`)?.props?.text).toContain(`](#${otherId})`)
  const markdowns = nodesOf(tree).filter(node => node.type === 'Markdown')
  const texts = markdowns.map(node => String(node.props?.text))
  for (const number of [1, 2]) {
    expect(texts.filter(text => text.startsWith(`[#${number}](https://github.com/acme/app/issues/${number})`))).toHaveLength(1)
  }
  for (const number of [3, 4]) {
    expect(texts.filter(text => text.endsWith(`[#${number} Issue ${number}](https://github.com/acme/app/issues/${number})`))).toHaveLength(1)
  }
  const keys = markdowns.map(node => node.props?.key)
  expect(new Set(keys).size).toBe(keys.length)
})

// The clock the pane draws for the session record at epoch 0 (the fixture's createdAt), in a zone with this UTC offset.
const clockAtEpochZeroIn = (utcOffsetMinutes: number): string => new Date(utcOffsetMinutes * 60_000).toISOString().slice(11, 16)

test('the host UTC offset comes from date +%z at session.start and on each poll; a refused or unreadable answer falls back to the runtime offset', async ($: Engine, on) => {
  const runtimeOffset = -new Date().getTimezoneOffset()
  const options: StubOptions = { utcOffset: '-0300\n' }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs).toContainEqual(['date', '+%z'])
  expect(await drawnPane($)).toContain(clockAtEpochZeroIn(-180))
  options.utcOffset = '+0530\n'
  await host.clock.advance(POLL_MS)
  expect(await drawnPane($)).toContain(clockAtEpochZeroIn(330))
  options.utcOffset = 'UTC\n'
  await host.clock.advance(POLL_MS)
  expect(await drawnPane($)).toContain(clockAtEpochZeroIn(runtimeOffset))
  options.utcOffset = '-0300\n'
  options.dateMissing = true
  await host.clock.advance(POLL_MS)
  expect(await drawnPane($)).toContain(clockAtEpochZeroIn(runtimeOffset))
})
