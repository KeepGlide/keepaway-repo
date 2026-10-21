// Tests of the hooks module (hooks/register.tsx): the poll runs only while the pane is open and a close stops it, the gh
// failures draw their lines and keep the sessions, a failed git call is asked again, the /keeptrack command writes and
// clears the override, and no record content reaches the log.
// The host is stubbed beneath the plugin, as askaway's race tests do: Desktop records, git and gh answer from memory, and
// gh and git are never run. The drawn pane is read through a mounted drawing.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

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

type RawRecord = Record<string, unknown>
type GhMode = 'ok' | 'missing' | 'timeout' | 'unreadable' | { exitCode: number; stderr: string }
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
  prTotal?: number
  // The open PRs the GraphQL call lists, and the branch each folder's `rev-parse --abbrev-ref HEAD` answers (default feature/disk).
  openPrs?: { number: number; title: string; headRefName: string }[]
  branches?: Record<string, string>
  repoDenies?: boolean
  originTimesOut?: boolean
  // Folders that are not git repositories: every git call in them exits 128 with git's not-a-repository message.
  nonRepoCwds?: string[]
  // Git calls against these common dirs exit 128 with the given stderr: a not-a-repository message, or another failure.
  gitErrors?: Record<string, string>
  unlistable?: string[]
  agentsDenied?: boolean
  // Each `$.agent.list()` call takes the next hold, if any, after it has read the agents, so the test sets its read order.
  agentHolds?: Promise<void>[]
  storeKeysDenies?: boolean
  // An open askaway question of this window's session, with no answer.
  question?: { id: string; desktop_session: string; title: string }
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

// Answers the module's calls from memory: the Desktop records given, a GitHub remote, and empty gh lists.
function stubHost(on: On, options: StubOptions = {}): Host {
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
  }
  // Every deny the stub answers goes through here, so host.denies keeps it (R2-07).
  const refuse = (text: string) => {
    host.denies.push(text)
    return { deny: text }
  }
  // A call no test expects is refused, so the module sees a rejection, not an empty success.
  const valueOr = (argv: readonly string[], answer: ProcessOutput | undefined) =>
    answer === undefined ? refuse(`unexpected call: ${argv.join(' ')}`) : { value: answer }
  const files = new Map(
    records.map(record => [`${RECORDS}/org/user/${String(record.sessionId)}.json`, JSON.stringify(record)] as const),
  )
  const questionFolder = `${HOME}/.claude/state/askaway/q`
  const questions: FsStub[] = options.question === undefined ? [] : [{ name: `${options.question.id}.json`, kind: 'file' }]
  if (options.question !== undefined) files.set(`${questionFolder}/${options.question.id}.json`, JSON.stringify(options.question))
  const folders = new Map<string, FsStub[]>([
    // The askaway question folder exists; it holds the test's question, if any (a missing folder is no question, SPEC 3.6).
    [questionFolder, questions],
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
  // A folder no test names is a deny, not an empty listing: the module sees a rejection, and the output shows whether it mattered.
  on('fs.list', (_$, event) => {
    const entries = folders.get(event.path)
    if (entries === undefined || options.unlistable?.includes(event.path) === true) {
      return refuse(`fs.list refused: ${event.path}`)
    }
    return { value: entries.map(entry => ({ ...entry, size: 100, mtimeMs: 1, isLink: false })) }
  })
  on('fs.read', (_$, event) => {
    host.reads += 1
    const content = files.get(event.path)
    if (content === undefined) return refuse(`fs.read refused: ${event.path}`)
    return { value: content }
  })
  on('fs.exists', (_$, event) => ({ value: files.has(event.path) || folders.has(event.path) }))
  const failedOnce = new Set<string>()
  on('process.run', async (_$, event) => {
    const argv = [...event.argv]
    host.argvs.push(argv)
    if (argv[0] === 'gh' && (options.gh === 'missing' || options.gh === 'timeout')) return refuse(REJECTION_OF[options.gh])
    if (argv[0] === 'gh') return valueOr(argv, await ghAnswerOf(argv, options))
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

// The result of a gh call under the mode the test chose; undefined for a call no test expects. `gh api` answers the milestones.
async function ghAnswerOf(argv: readonly string[], options: StubOptions): Promise<ProcessOutput | undefined> {
  if (options.gate !== undefined) await options.gate
  if (typeof options.gh === 'object') return processOutput('', options.gh.exitCode, options.gh.stderr)
  if (options.gh === 'unreadable') return processOutput('<html>not JSON</html>')
  if (argv.includes('view')) return processOutput(ISSUE_VIEW_JSON)
  if (argv.includes('graphql')) {
    const nodes = (options.openPrs ?? []).map(pr => ({
      ...pr,
      state: 'OPEN',
      url: `https://github.com/acme/app/pull/${pr.number}`,
      createdAt: '2026-10-20T10:00:00Z',
      reviewDecision: null,
      closingIssuesReferences: { nodes: [] },
      commits: { nodes: [] },
    }))
    return processOutput(JSON.stringify({ data: { repository: { pullRequests: { totalCount: options.prTotal ?? nodes.length, nodes } } } }))
  }
  if (argv.includes('list')) return processOutput(options.issues ?? '[]')
  if (argv[1] === 'api') return processOutput('[]')
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
  if (argv.includes('--abbrev-ref')) return processOutput(options.branches?.[argv[cwdAt] ?? ''] ?? 'feature/disk')
  if (argv.includes('get-url')) return processOutput(remotes[argv[argv.indexOf('--git-dir') + 1] ?? ''] ?? REMOTE)
  // The default branch of the origin, and the log of a branch: no commits beyond it.
  if (argv.includes('symbolic-ref')) return processOutput('origin/main')
  if (argv.includes('log')) return processOutput('')
  return undefined
}

const ghCalls = (host: Host): number => host.argvs.filter(argv => argv[0] === 'gh').length
const remoteAsks = (host: Host, commonDir: string): number =>
  host.argvs.filter(argv => argv.includes('get-url') && argv[argv.indexOf('--git-dir') + 1] === commonDir).length

// The pane as the engine draws it now, as JSON text (the terminal surface). The drawing is unmounted after the read, so a
// test may take the pane again later.
async function drawnPane($: Engine): Promise<string> {
  const mounted = await $.ui.mount({
    plugin: 'keeptrack-repo-pane',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE_ID,
    props: {} as never,
  })
  const drawn = JSON.stringify(await mounted.drawn())
  await mounted.unmount()
  return drawn
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
  expect(atOpen).toBe(3)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(atOpen + 3)
  await expectClean(host, $)
})

test('gh missing keeps the sessions and draws its line', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'missing' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
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

test('a bad /keeptrack argument toasts and changes nothing', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'issue abc', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keeptrack', args: 'frobnicate', ...COMMAND_CONTEXT })
  expect(host.toasts.length).toBe(2)
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

test('a window that maps to an issue asks gh for it in a fourth call', async ($: Engine, on) => {
  const host = stubHost(on)
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  expect(host.argvs.filter(argv => argv.includes('view'))).toEqual([ISSUE_VIEW_ARGV])
})

test('a window that maps to no issue makes no fourth gh call', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  expect(host.argvs.some(argv => argv.includes('view'))).toBe(false)
})

test('the closed pane polls on the band cadence: once at session start, then every 5 minutes, never each minute', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  await host.clock.advance(POLL_MS * 2)
  expect(ghCalls(host)).toBe(3)
  await host.clock.advance(BAND_POLL_MS - POLL_MS * 2)
  expect(ghCalls(host)).toBe(6)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(9)
})

test('KEEPTRACK_BAND_POLL_MS sets the closed cadence', async ($: Engine, on) => {
  const host = stubHost(on, { env: { KEEPTRACK_BAND_POLL_MS: '120000' } })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  await host.clock.advance(POLL_MS * 2)
  expect(ghCalls(host)).toBe(6)
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
  expect(ghCalls(host)).toBe(6)
  await $.command.run({ command: 'close-pane', args: '', ...COMMAND_CONTEXT })
  await host.clock.advance(POLL_MS * 2)
  expect(ghCalls(host)).toBe(6)
})

test('an open pane moves the timer to the pane cadence of one minute, and the band cadence returns on close', { plugins: [closer] }, async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(6)
  await host.clock.advance(POLL_MS * 4)
  expect(ghCalls(host)).toBe(18)
  await $.command.run({ command: 'close-pane', args: '', ...COMMAND_CONTEXT })
  await host.clock.advance(POLL_MS * 4)
  expect(ghCalls(host)).toBe(18)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(21)
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
  expect(ghCalls(host)).toBe(3)
  release()
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(6)
})

test('W5: a pane the engine does not place starts once a render places it', async ($: Engine, on) => {
  const host = stubHost(on, { placed: false })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  host.placed = true
  await drawnPane($)
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(6)
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
  stubHost(on, { records: [OWN_RECORD, other], remotes: { [OTHER_COMMON_DIR]: OTHER_REMOTE } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).not.toContain('Other host session')
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
})

// The newest 64 candidates, plus the other members of the scan window (4 x 64 others), keep their branch read; this window adds one.
test('S1: at most 4 x 64 others plus this window are read for their branch per poll', async ($: Engine, on) => {
  const many = Array.from({ length: 300 }, (_, index) =>
    recordOf(`local_${String(index).padStart(8, '0')}`, { lastActivityAt: index }),
  )
  const host = stubHost(on, { records: [OWN_RECORD, ...many] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.filter(argv => argv.includes('--abbrev-ref')).length).toBeLessThanOrEqual(4 * 64 + 1)
})

test('W6: an archived parent of a live fork is drawn as its ancestor, with its title', async ($: Engine, on) => {
  const parent = recordOf('local_7f3a0009', { title: 'Archived parent', isArchived: true })
  stubHost(on, { records: [parent, { ...OWN_RECORD, forkedFromSessionId: 'local_7f3a0009' }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  const drawn = await drawnPane($)
  expect(drawn).toContain('Archived parent')
  expect(drawn).toContain('forked from Archived parent')
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

test('no record content reaches the log: each line names only a failure', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'timeout', records: [recordOf(SESSION_ID, { cliSessionId: SELF, title: SECRET_TITLE })] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.logs.length).toBeGreaterThan(0)
  for (const line of host.logs) {
    expect(line).toMatch(/^keeptrack: [\w ()-]+$/)
    expect(line.includes(SECRET_TITLE) || line.includes(REMOTE) || line.includes(RECORDS)).toBe(false)
  }
})

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
  expect(ghCalls(host)).toBe(3)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).not.toContain('no GitHub remote for this repo')
})

test('a band draw starts the poll when no session.start ran in this module instance (a reloaded module)', async ($: Engine, on) => {
  const host = stubHost(on)
  const band = await $.ui.mount({ plugin: 'keeptrack-repo-pane', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await band.unmount()
  await host.clock.settle()
  expect(ghCalls(host)).toBe(3)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(6)
})

test('the band redraws each minute while idle, so the time since the last turn moves', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  const before = host.redraws
  await host.clock.advance(60_000)
  expect(host.redraws).toBeGreaterThan(before)
})

// ---- The gauntlet round 1 findings (F01 to F21): each test pins the behaviour the source has now ----
// Not pinned by a test: F06 (the turn.abort agentId guard), because the test engine has no $.turn.abort, so no test can raise
// that event. F01 and F03 are pinned on the pane side by tests/pane.test.ts; F08 by its own test below.

// The poll deadline of hooks/register.tsx (POLL_DEADLINE_MS).
const POLL_DEADLINE_MS = 30_000
const SLOW_ISSUE = { number: 9, title: 'Slow issue', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/9', milestone: null, labels: [] }
const GIT_FAILED_LINE = 'git failed in this folder · sessions shown without branch'
const NO_REMOTE_LINE = 'no GitHub remote for this repo'
const TOOL_NAME_MAX = 64
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
  options.originTimesOut = true
  await host.clock.advance(POLL_MS)
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
  expect(await drawnPane($)).toContain('Old live session')
})

test('F07: a poll whose call never settles fails at its deadline, keeps the last sessions and logs the failure name', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = NEVER()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(6)
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
  stubHost(on, { gh: 'missing' })
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

test('the band says waiting for you while this window has an open askaway question', async ($: Engine, on) => {
  stubHost(on, { question: { id: 'q-1', desktop_session: SESSION_ID, title: 'Pick a branch' } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).toContain('waiting for you')
})

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
  expect(ghCalls(host)).toBe(6)
  await host.clock.advance(POLL_DEADLINE_MS)
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(9)
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
})

test('F13: a gh timeout after a good poll keeps the last good issues and draws its line', async ($: Engine, on) => {
  const options: StubOptions = { issues: ISSUE_LIST_JSON }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('1 open issues')
  options.gh = 'timeout'
  await host.clock.advance(POLL_MS)
  const drawn = await drawnPane($)
  expect(drawn).toContain('1 open issues')
  expect(drawn).toContain('GitHub did not answer in time')
  expect(host.logs).toContain('keeptrack: gh issue call failed')
})

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

test('F18: a records folder that cannot be listed draws no records line', async ($: Engine, on) => {
  stubHost(on, { unlistable: [`${RECORDS}/org/user`] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keeptrack', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).not.toContain('session records could not be read')
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
  expect(ghCalls(host)).toBe(3)
  options.storeKeysDenies = true
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(6)
  for (let draw = 0; draw < 3; draw += 1) {
    await drawnPane($)
    await host.clock.settle()
  }
  expect(ghCalls(host)).toBe(6)
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
  expect(ghCalls(host)).toBe(9)
  expect(host.logs.some(line => line.startsWith('keeptrack: poll skipped ('))).toBe(true)
  await host.clock.advance(20 * POLL_MS)
  expect(ghCalls(host)).toBe(9)
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
