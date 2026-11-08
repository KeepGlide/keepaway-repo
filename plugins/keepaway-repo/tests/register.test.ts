// Tests of the hooks module (hooks/register.tsx): the poll runs only while the pane is open and a close stops it, the gh
// failures draw their lines and keep the sessions, a failed git call is asked again, the /keepaway command writes and
// clears the override, and no record content reaches the log.
// The host is stubbed beneath the plugin, as askaway's race tests do: Desktop records, git and gh answer from memory, and
// gh and git are never run. The drawn pane is read through a mounted drawing.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { actionIconEmoji } from '../hooks/action-icons'
import { RECORD_MAX_BYTES, WAITING_WINDOW_MS } from '../hooks/model'
import { TURN_MAX_AGE_MS } from '../hooks/turn'
import { SUMMARY_RETRY_MS } from '../hooks/summary'
import { TOOL_NAME_MAX, resetDesktopConfigCache, resetLegendMemory, resetLogoMemory, resetStepMemory, resetSummaryMemory } from '../hooks/register'
import {
  AVATAR_FETCH_SCRIPT,
  LOGO_FOLDERS,
  LOGO_LOCK_MS,
  LOGO_RETRY_MS,
  LOGO_STORE_MAX,
  LOGO_TTL_MS,
  logoLockKeyOf,
  logoStoreKeyOf,
} from '../hooks/repo-logo'

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
// How many of the first git remote reads of the failing common dir fail (the membership read and the candidate read of one poll).
const FIRST_READS_FAILING = 2
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
// The store key of the repo's logo (the page of acme/app's GitHub remote).
const LOGO_STORE_KEY = logoStoreKeyOf('github.com/acme/app')

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
  // The answer of `gh issue view` (its comments included); absent: ISSUE_VIEW_JSON.
  issueView?: string
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
  // The repo logo lookups (SPEC section 11). Absent, the repo's logo is stored as none and never ages out, so the poll tests above make
  // no lookup; lookLogos runs them for real.
  lookLogos?: boolean
  // ssh -G of an alias answers its `hostname` as sshHosts names it (an alias it does not name answers itself, as ssh does); sshFails
  // makes ssh missing, so every alias lookup fails (SPEC section 16).
  sshHosts?: Record<string, string>
  sshFails?: boolean
  // ssh -G runs out of time: the call is rejected, as the engine rejects a process that times out.
  sshTimesOut?: boolean
  // The files of the session's checkout (REPO_ROOT), by path: fs.list lists them, fs.read gives their text or, as bytes, their base64.
  checkout?: Record<string, Uint8Array>
  // The files GitHub's contents answers for, by path (a path the repo does not hold answers 404).
  contents?: Record<string, Uint8Array>
  // The stderr of every contents call that fails, e.g. 'gh: Server Error (HTTP 500)'.
  contentsFailure?: string
  // The owner's account (`gh api users/<owner>`): its type (default User) and its avatar URL.
  ownerType?: 'Organization' | 'User'
  ownerAvatarUrl?: string
  // What the avatar fetch (curl through base64) answers: the base64 of the picture; absent, the fetch failed and answers nothing.
  avatarBase64?: string
  // The listed entries that are symbolic links, by path: a link is never a logo (the engine's FsEntry isLink).
  links?: string[]
  // The store refuses every read, write and delete of a logo key (logo:, logo-lock:): the pane must go on.
  logoStoreRefuses?: boolean
  // The store refuses every read, write and delete of the legend's open state (legendOpen): the pane draws the legend closed and goes on.
  legendStoreRefuses?: boolean
  // `glab --version` times out (the engine's process timeout): the answer is asked again, not kept.
  glabTimesOut?: boolean
  // glab is installed, answers the project's JSON with `glabAvatarUrl`, or fails (`glabFails`).
  glabInstalled?: boolean
  glabFails?: boolean
  glabAvatarUrl?: string
  // The transcripts of the Desktop, by path: `head -c N` answers their first N characters; a path not given is missing (exit 1).
  transcripts?: Record<string, string>
  // The head read of a transcript is refused (a timeout, the engine's rejection).
  transcriptRefuses?: boolean
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
  resetLogoMemory()
  resetSummaryMemory()
  resetStepMemory()
  resetLegendMemory()
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
  // The checkout: its files are listed in their folder, and every logo folder lists as empty, not refused.
  const checkoutFiles = options.checkout ?? {}
  for (const folder of [REPO_ROOT, ...LOGO_FOLDERS.filter(name => name !== '.').map(name => `${REPO_ROOT}/${name}`)]) {
    folders.set(folder, folders.get(folder) ?? [])
  }
  for (const path of Object.keys(checkoutFiles)) {
    const folder = path.slice(0, path.lastIndexOf('/'))
    folders.set(folder, [...(folders.get(folder) ?? []), { name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' }])
  }
  mock.env(on, { HOME, KEEPAWAY_DESKTOP_SESSIONS: RECORDS, ...options.env })
  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('session.start', (_$, event) => ({ cwd: event.cwd }))
  // Without lookLogos the repo's logo reads as stored none that never ages out, kept out of host.store so the store keeps what the test wrote.
  const seededLogo = { source: null, at: Number.MAX_SAFE_INTEGER, failed: false }
  // The logo keys (logo: and logo-lock:) are refused when the test says so; every other key is kept as before.
  const refusesKey = (key: string): boolean =>
    (options.logoStoreRefuses === true && key.startsWith('logo')) || (options.legendStoreRefuses === true && key === 'legendOpen')
  on('store.get', (_$, event) => {
    if (refusesKey(event.key)) return refuse('logo store unavailable')
    return {
      value: host.store.get(event.key) ?? (options.lookLogos !== true && event.key === LOGO_STORE_KEY ? seededLogo : undefined),
    }
  })
  on('store.set', (_$, event) => {
    if (refusesKey(event.key)) return refuse('logo store unavailable')
    host.store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.delete', (_$, event) => {
    if (refusesKey(event.key)) return refuse('logo store unavailable')
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
    const isLinkOf = (name: string): boolean => options.links?.includes(`${event.path}/${name}`) === true
    return { value: entries.map(entry => ({ ...entry, size: sizeOf(entry.name), mtimeMs: mtimeOf(entry.name), isLink: isLinkOf(entry.name) })) }
  })
  on('fs.read', (_$, event) => {
    host.reads += 1
    host.readPaths.push(event.path)
    const checkoutBytes = checkoutFiles[event.path]
    if (checkoutBytes !== undefined) {
      return { value: event.as === 'bytes' ? { base64: base64Of(checkoutBytes) } : new TextDecoder().decode(checkoutBytes) }
    }
    const content =
      event.path === DESKTOP_CONFIG_PATH ? options.desktopConfig : files.get(event.path)
    if (content === undefined || options.unreadable?.includes(event.path) === true) return refuse(`fs.read refused: ${event.path}`)
    return { value: content }
  })
  on('fs.exists', (_$, event) => ({ value: files.has(event.path) || folders.has(event.path) }))
  const failedReads = new Map<string, number>()
  on('process.run', async (_$, event) => {
    const argv = [...event.argv]
    host.argvs.push(argv)
    if (argv[0] === 'head') {
      if (options.transcriptRefuses === true) return refuse(REJECTION_OF.timeout)
      const text = options.transcripts?.[argv[3] ?? '']
      return text === undefined
        ? valueOr(argv, processOutput('', 1, 'head: cannot open the file'))
        : valueOr(argv, processOutput(text.slice(0, Number(argv[2]))))
    }
    if (argv[0] === 'tail') {
      const text = options.transcripts?.[argv[3] ?? '']
      return text === undefined
        ? valueOr(argv, processOutput('', 1, 'tail: cannot open the file'))
        : valueOr(argv, processOutput(text.slice(Number((argv[2] ?? '+1').slice(1)) - 1)))
    }
    if (argv[0] === 'date') {
      if (options.dateMissing === true) return refuse('Executable not found in $PATH: "date"')
      return valueOr(argv, processOutput(options.utcOffset ?? '+0000\n'))
    }
    if (argv[0] === 'ssh') {
      if (options.sshFails === true) return refuse('Executable not found in $PATH: "ssh"')
      if (options.sshTimesOut === true) return refuse(REJECTION_OF.timeout)
      const alias = argv[2] ?? ''
      return valueOr(argv, processOutput(`user git\nhostname ${options.sshHosts?.[alias] ?? alias}\nport 22\n`))
    }
    if (argv[0] === 'gh' && (options.gh === 'missing' || options.gh === 'timeout')) return refuse(REJECTION_OF[options.gh])
    if (argv[0] === 'glab') {
      if (options.glabTimesOut === true && argv[1] === '--version') return refuse(REJECTION_OF.timeout)
      return valueOr(argv, glabAnswerOf(argv, options))
    }
    // The avatar fetch: curl through base64, so the answer is the base64 text (empty when the fetch failed).
    if (argv[0] === 'sh') {
      return options.avatarBase64 === undefined
        ? valueOr(argv, processOutput('', 0, 'curl: (6) Could not resolve host'))
        : valueOr(argv, processOutput(options.avatarBase64))
    }
    if (argv[0] === 'gh') {
      const answer = await ghAnswerOf(argv, options)
      return valueOr(argv, options.gh === 'cut' && answer !== undefined ? { ...answer, isStdoutTruncated: true } : answer)
    }
    const gitDir = argv[argv.indexOf('--git-dir') + 1]
    if (gitDir === options.failFirstRemoteOf && argv.includes('get-url') && (failedReads.get(gitDir) ?? 0) < FIRST_READS_FAILING) {
      failedReads.set(gitDir, (failedReads.get(gitDir) ?? 0) + 1)
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

// glab on the host: `glab --version` finds it, `glab api` answers the project's JSON (or fails). Without glab the call is refused (undefined).
function glabAnswerOf(argv: readonly string[], options: StubOptions): ProcessOutput | undefined {
  if (options.glabInstalled !== true) return undefined
  if (argv[1] === '--version') return processOutput('glab version 1.0.0\n')
  if (options.glabFails === true) return processOutput('', 1, 'glab: 401 Unauthorized')
  return processOutput(JSON.stringify({ path: 'app', avatar_url: options.glabAvatarUrl ?? null }))
}
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
  if (argv.includes('view')) return processOutput(options.issueView ?? ISSUE_VIEW_JSON)
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
  const contentsPath = /repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(argv[2] ?? '')
  if (argv[1] === 'api' && contentsPath !== null) return contentsAnswerOf(contentsPath[1] ?? '', options)
  if (argv[1] === 'api' && (argv[2] ?? '').startsWith('users/')) return ownerAnswerOf(argv, options)
  if (argv[1] === 'api') return processOutput(options.milestones ?? '[]')
  return undefined
}

// Base64 of bytes, with btoa, since the test runtime has no Node Buffer.
const base64Of = (bytes: ArrayLike<number>): string => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
// GitHub's contents answer for a path: the file as base64 JSON when the test gives it, else 404 (a path the repo does not hold).
function contentsAnswerOf(path: string, options: StubOptions) {
  if (options.contentsFailure !== undefined) return processOutput('', 1, options.contentsFailure)
  const bytes = options.contents?.[path]
  if (bytes === undefined) return processOutput('', 1, 'gh: Not Found (HTTP 404)')
  const content = base64Of(bytes)
  return processOutput(JSON.stringify({ type: 'file', size: bytes.byteLength, encoding: 'base64', content }))
}

// The owner's account answer: its type for `--jq .type`, its avatar URL for `--jq .avatar_url`.
function ownerAnswerOf(argv: readonly string[], options: StubOptions) {
  if (argv.includes('.type')) return processOutput(`${options.ownerType ?? 'User'}\n`)
  return processOutput(`${options.ownerAvatarUrl ?? 'https://avatars.githubusercontent.com/u/1?v=4'}\n`)
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
    plugin: 'keepaway-repo',
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
    const drawn = await drawnPane($)
    expect(drawn).toContain(line)
    expect(drawn).toContain('Fix disk full')
  })
}

test('/keepaway issue <n> sets this window override, issue none clears it', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'issue 106', ...COMMAND_CONTEXT })
  const stored = host.store.get(`override:${SESSION_ID}`) as { issue: number } | undefined
  expect(stored?.issue).toBe(106)
  await $.command.run({ command: 'keepaway', args: 'issue none', ...COMMAND_CONTEXT })
  expect(host.store.has(`override:${SESSION_ID}`)).toBe(false)
  expect(host.toasts).toEqual([])
})

// The usage toast, in English (hooks/i18n.ts toast.usage).
const USAGE_TOAST = 'Usage: /keepaway open | issue <n> | issue none | lang en|pt-BR|auto | summary on|off'

test('a bad /keepaway argument toasts and changes nothing', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'issue abc', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keepaway', args: 'frobnicate', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual([USAGE_TOAST, USAGE_TOAST])
  expect([...host.store.keys()]).toEqual([])
})

test('/keepaway issue in a window that is not a Desktop session toasts and sets nothing', async ($: Engine, on) => {
  const host = stubHost(on, { cliId: 'sess-unknown' })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'issue 106', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual(['This window is not a Desktop session: nothing to set'])
  expect([...host.store.keys()]).toEqual([])
})

test('/keepaway lang stores the choice and draws the pane in it; auto removes the choice', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'lang pt-BR', ...COMMAND_CONTEXT })
  expect(host.store.get('lang')).toBe('pt')
  // The pane is drawn in Portuguese: its loading line, or its footer once the poll has landed.
  expect(await drawnPane($)).toMatch(/Carregando o repo|Atualizado/)
  await $.command.run({ command: 'keepaway', args: 'lang auto', ...COMMAND_CONTEXT })
  expect(host.store.has('lang')).toBe(false)
})

test('a window that maps to an issue asks gh for it in a fifth call', async ($: Engine, on) => {
  const host = stubHost(on)
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(5)
  expect(host.argvs.filter(argv => argv.includes('view'))).toEqual([ISSUE_VIEW_ARGV])
})

test('a window that maps to no issue makes no fifth gh call', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('1 of 2 issues closed')
})

test('pm1-8: more than 500 open issues flag the list partial, and the milestone totals still come from GraphQL', async ($: Engine, on) => {
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 0, closed_issues: 0, due_on: null }])
  // The list is cut at 500 rows; the milestone's 600 open issues are counted by GraphQL, not by the cut list.
  const host = stubHost(on, { issues: issueList(501), milestones, milestoneCounts: [{ number: 23, open: 600, closed: 4 }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('5 of 10 items closed')
  expect(host.logs.some(line => line.startsWith('keepaway: gh api call failed'))).toBe(true)
})

test('pm1-9: all closed is drawn only from exact counts, never from a REST zero or a failed totals query', async ($: Engine, on) => {
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 0, closed_issues: 2, due_on: null }])
  const options: StubOptions = { milestones, milestoneCounts: 'fail' }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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

test('KEEPAWAY_BAND_POLL_MS sets the closed cadence', async ($: Engine, on) => {
  const host = stubHost(on, { env: { KEEPAWAY_BAND_POLL_MS: '120000' } })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The next poll waits at its `gh issue view` (106), past the point where it has read the override.
  options.viewGate = gate
  await host.clock.advance(POLL_MS)
  await $.command.run({ command: 'keepaway', args: 'issue 8', ...COMMAND_CONTEXT })
  options.viewGate = undefined
  release()
  await host.clock.settle()
  expect(viewedIssues(host)).toContain('8')
})

test('st-6: a session that starts with a failed repo read polls no repo of the session before it', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = gate
  // Two polls hang past their deadline (at one and two minutes); the poll at three minutes is skipped.
  await host.clock.advance(3 * POLL_MS)
  expect(host.logs.some(line => line.startsWith('keepaway: poll skipped ('))).toBe(true)
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await $.session.start(SESSION)
  options.gate = NEVER()
  // The first poll fails at its deadline, after the session changed; the new session's poll hangs too, so no snapshot exists.
  await host.clock.advance(POLL_DEADLINE_MS)
  await host.clock.settle()
  expect(host.logs).toContain('keepaway: poll failed (PollDeadline)')
  const drawn = await drawnPane($)
  expect(drawn).toContain('Loading the repo...')
  expect(drawn).not.toContain('Could not read the repo: state unknown')
})

// KEEPAWAY_POLL_MS: a value that is not a whole number of at least MIN_POLL_MS (1 s) falls back to the one-minute cadence (sp-5).
for (const raw of ['500', '1.5', '']) {
  test(`sp-5: KEEPAWAY_POLL_MS='${raw}' falls back to the one-minute cadence`, async ($: Engine, on) => {
    const host = stubHost(on, { env: { KEEPAWAY_POLL_MS: raw } })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect(ghCalls(host)).toBe(4)
    await host.clock.advance(POLL_MS - 1)
    expect(ghCalls(host)).toBe(4)
    await host.clock.advance(1)
    expect(ghCalls(host)).toBe(8)
  })
}

test('sp-5: a valid KEEPAWAY_POLL_MS sets the open cadence', async ($: Engine, on) => {
  const host = stubHost(on, { env: { KEEPAWAY_POLL_MS: '120000' } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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

test('a remote read that succeeds is cached: the next poll asks git nothing for it', async ($: Engine, on) => {
  const cached = recordOf('local_7f3a0010', { title: 'Cached worktree session', cwd: '/work/cached', gitAnchors: [{ commonDir: '/work/cached/.git' }] })
  const host = stubHost(on, { records: [OWN_RECORD, cached] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const asksAtOpen = remoteAsks(host, '/work/cached/.git')
  expect(asksAtOpen).toBeGreaterThan(0)
  await host.clock.advance(POLL_MS)
  expect(remoteAsks(host, '/work/cached/.git')).toBe(asksAtOpen)
})

test('CR1: a record whose cwd is outside any git repo is not a candidate and sets no git-failed', async ($: Engine, on) => {
  const loose = recordOf('local_7f3a0005', { title: 'Loose chat in Documents', cwd: '/home/u/Documents', gitAnchors: [] })
  const host = stubHost(on, { records: [OWN_RECORD, loose], nonRepoCwds: ['/home/u/Documents'] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Broken config session')
  expect(drawn).toContain(GIT_FAILED_LINE)
  expect(await bandDrawn($)).toContain('data error')
})

test('ux4-2: a first poll with no repo context draws the failure line, not Loading', async ($: Engine, on) => {
  const host = stubHost(on, { repoDenies: true })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Milestone Old ✅ · closed')
  expect(drawn).toContain('Issue of a closed milestone')
  expect(drawn).not.toContain('No milestone / issue')
})

test('the override prune keeps the override of a session in another repo, since its record is still in the folder', async ($: Engine, on) => {
  const other = recordOf('local_7f3a0500', { title: 'Other repo session', cwd: '/work/other', gitAnchors: [{ commonDir: OTHER_COMMON_DIR }] })
  const host = stubHost(on, { records: [OWN_RECORD, other], remotes: { [OTHER_COMMON_DIR]: OTHER_REMOTE } })
  host.store.set('override:local_7f3a0500', { issue: 9, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.store.has('override:local_7f3a0500')).toBe(true)
  // The other repo's session is listed by its own window, not this one.
  expect(await drawnPane($)).not.toContain('Other repo session')
})

test('gh takes owner and name as strings (-f, W2)', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect([...host.store.keys()].filter(key => key.startsWith('override:'))).toEqual([`override:${SESSION_ID}`])
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(0)
  expect(await drawnPane($)).toContain('no GitHub remote for this repo')
})

test('S1: at most 2000 Desktop files are read per poll', async ($: Engine, on) => {
  const many = Array.from({ length: 2100 }, (_, index) => recordOf(`local_${String(index).padStart(8, '0')}`))
  const host = stubHost(on, { records: many })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  const drawn = await drawnPane($)
  expect(drawn).toContain('evil')
  expect(drawn.includes('\\u001b')).toBe(false)
  expect(drawn.includes('\\u0007')).toBe(false)
})

// Each log line names a failure only: no record title, remote or records path.
function expectNoRecordContent(host: Host): void {
  expect(host.logs.length).toBeGreaterThan(0)
  for (const line of host.logs) {
    expect(line).toMatch(/^keepaway: [\w ()-]+$/)
    expect(line.includes(SECRET_TITLE) || line.includes(REMOTE) || line.includes(RECORDS)).toBe(false)
  }
}

test('no record content reaches the log: each line names only a failure', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'timeout', records: [recordOf(SESSION_ID, { cliSessionId: SELF, title: SECRET_TITLE })] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expectNoRecordContent(host)
  })
}

// The band as the engine draws it now, as JSON text (the terminal surface).
async function bandDrawn($: Engine): Promise<string> {
  const band = await $.ui.mount({ plugin: 'keepaway-repo', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  const drawn = JSON.stringify(await band.drawn())
  await band.unmount()
  return drawn
}

// The kit cannot raise turn.start or turn.complete (tests/turn.test.ts), so no turn runs here: this checks the agents alone.
test('two agents still running draw the working icon with 2 agents, and the idle icon once they finish (no turn event is raised)', async ($: Engine, on) => {
  const agents = [
    { id: 'agent-1', status: 'running' },
    { id: 'agent-2', status: 'running' },
  ]
  const host = stubHost(on, { agents })
  await $.session.start(SESSION)
  await host.clock.settle()
  await host.clock.advance(BAND_TICK_MS)
  const running = await bandDrawn($)
  expect(running).toContain(actionIconEmoji('working'))
  expect(running).toContain('2 agents')
  for (const agent of agents) agent.status = 'completed'
  await host.clock.advance(BAND_TICK_MS)
  const idle = await bandDrawn($)
  expect(idle).toContain(actionIconEmoji('idle'))
  expect(idle).not.toContain(actionIconEmoji('working'))
})

test('a repo whose only remote is named github is read from it: the poll runs and the pane names no missing remote', async ($: Engine, on) => {
  const host = stubHost(on, { noOrigin: { name: 'github', url: 'git@github-claude-global:acme/app.git' } })
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).not.toContain('no GitHub remote for this repo')
})

test('a band draw starts the poll when no session.start ran in this module instance (a reloaded module)', async ($: Engine, on) => {
  const host = stubHost(on)
  const band = await $.ui.mount({ plugin: 'keepaway-repo', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await band.unmount()
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  await host.clock.advance(BAND_POLL_MS)
  expect(ghCalls(host)).toBe(8)
})

test('state2-2: a new session drops the previous session\'s turn, so the band draws the idle icon', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  expect(await bandDrawn($)).toContain(actionIconEmoji('working'))
  await $.session.start(SESSION)
  await host.clock.settle()
  const idle = await bandDrawn($)
  expect(idle).toContain(actionIconEmoji('idle'))
  expect(idle).not.toContain(actionIconEmoji('working'))
})

test('state2-2: a tool call with no turn start infers a running turn', async ($: Engine, on) => {
  stubHost(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash' })
  expect(await bandDrawn($)).toContain(actionIconEmoji('working'))
})

test('state2-2: a turn past TURN_MAX_AGE_MS with no end event draws the idle icon on the band tick', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await host.clock.advance(TURN_MAX_AGE_MS - BAND_TICK_MS)
  expect(await bandDrawn($)).toContain(actionIconEmoji('working'))
  await host.clock.advance(2 * BAND_TICK_MS)
  const idle = await bandDrawn($)
  expect(idle).toContain(actionIconEmoji('idle'))
  expect(idle).not.toContain(actionIconEmoji('working'))
})

test('the band redraws each minute while idle, so the time since the last turn moves', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await host.clock.settle()
  const drawnBefore = await bandDrawn($)
  const before = host.redraws
  await host.clock.advance(60_000)
  expect(host.redraws).toBeGreaterThan(before)
  // No turn ends here (these tests raise no turn end: tests/turn.test.ts), so the idle band has no last turn yet: it draws the idle
  // icon alone before and after the minute. The time since a last turn moving at the minute is pinned in tests/band.test.ts.
  for (const drawn of [drawnBefore, await bandDrawn($)]) {
    expect(drawn).toContain(actionIconEmoji('idle'))
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  expect(await drawnPane($)).toContain('list is partial')
})

test('F02: a failed session.repo read keeps the last repo context: the poll goes on and no no-remote line appears', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  const drawn = await drawnPane($)
  expect(drawn).toContain('Old live session')
  expect(drawn).not.toContain('Archived one')
})

test('F07: a poll whose call never settles fails at its deadline, keeps the last sessions and logs the failure name', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = NEVER()
  await host.clock.advance(POLL_MS)
  expect(ghCalls(host)).toBe(8)
  await host.clock.advance(POLL_DEADLINE_MS)
  expect(host.logs).toContain('keepaway: poll failed (PollDeadline)')
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).toContain('data error')
})

test('a clean snapshot draws no data error flag', async ($: Engine, on) => {
  stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).not.toContain('data error')
})

test('a snapshot whose only error is no-remote draws no data error in the band', async ($: Engine, on) => {
  const host = stubHost(on, { rootRemote: OTHER_REMOTE })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain(NO_REMOTE_LINE)
  expect(await bandDrawn($)).not.toContain('data error')
})

test('waiting: the band draws the waiting icon while the engine asks the person about a tool call, and drops it when the call runs', async ($: Engine, on) => {
  const options: StubOptions = { permission: 'ask' }
  stubHost(on, options)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(await bandDrawn($)).toContain(actionIconEmoji('waiting'))
  // The person approves: the engine's own check of the call now allows it, and the call runs.
  options.permission = 'allow'
  await $.tool.call({ tool: 'Bash' })
  expect(await bandDrawn($)).not.toContain(actionIconEmoji('waiting'))
})

test('waiting: a verdict other than ask clears the flag, so an answered question does not keep the waiting icon', async ($: Engine, on) => {
  const options: StubOptions = { permission: 'ask' }
  stubHost(on, options)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(await bandDrawn($)).toContain(actionIconEmoji('waiting'))
  options.permission = 'allow'
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(await bandDrawn($)).not.toContain(actionIconEmoji('waiting'))
})

test('waiting: no Askaway folder is read, so an Askaway question cannot light the band', async ($: Engine, on) => {
  const host = stubHost(on, {})
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.listed.some(path => path.includes('askaway'))).toBe(false)
  expect(host.readPaths.some(path => path.includes('askaway'))).toBe(false)
  expect(await bandDrawn($)).not.toContain(actionIconEmoji('waiting'))
})

// D7: a Desktop record's postTurnSummary (Desktop-internal and undocumented) makes another session wait for the person while its
// last activity is within 24 h; its needs line is drawn under it.
const STOPPED_SUMMARY = { status_category: 'blocked', status_detail: 'Waiting', needs_action: 'Approve the migration', summarizes_uuid: 'turn-1' }

test('D7: another session whose summary says it stopped blocked, within 24 h, draws its waiting icon and its needs line', async ($: Engine, on) => {
  const stopped = recordOf('local_7f3a0020', { title: 'Stopped session', cliSessionId: 'sess-stopped', postTurnSummary: STOPPED_SUMMARY })
  const host = stubHost(on, { records: [OWN_RECORD, stopped] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain(`Stopped session ${actionIconEmoji('waiting')}`)
  expect(drawn).toContain('Needs you: Approve the migration')
  await expectClean(host, $)
})

test('D7: a malformed summary is no data: the session draws as an ordinary row with no needs line, and the poll does not fail', async ($: Engine, on) => {
  const malformed = [
    recordOf('local_7f3a0021', { title: 'Summary as text', cliSessionId: 'sess-a', postTurnSummary: 'blocked' }),
    recordOf('local_7f3a0022', { title: 'Summary with no status', cliSessionId: 'sess-b', postTurnSummary: { needs_action: 'Approve' } }),
    recordOf('local_7f3a0023', { title: 'Summary with no text', cliSessionId: 'sess-c', postTurnSummary: { status_category: 'blocked', needs_action: 7 } }),
  ]
  const host = stubHost(on, { records: [OWN_RECORD, ...malformed] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('Summary as text')
  expect(drawn).toContain('Summary with no status')
  expect(drawn).not.toContain(`Summary as text ${actionIconEmoji('waiting')}`)
  expect(drawn).not.toContain(`Summary with no status ${actionIconEmoji('waiting')}`)
  // A blocked summary whose needs text is not a string still makes the session wait, with no line.
  expect(drawn).toContain(`Summary with no text ${actionIconEmoji('waiting')}`)
  expect(drawn).not.toContain('Needs you')
  await expectClean(host, $)
})

test('D7: a stopped session older than 24 h takes the normal rule: no waiting icon and no needs line', async ($: Engine, on) => {
  const stopped = recordOf('local_7f3a0024', { title: 'Old stopped session', cliSessionId: 'sess-d', postTurnSummary: STOPPED_SUMMARY })
  const host = stubHost(on, { records: [OWN_RECORD, stopped] })
  // The clock moves past the window before the pane opens: a poll per minute while open would make the advance slow.
  await host.clock.advance(WAITING_WINDOW_MS + POLL_MS)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain(`Old stopped session ${actionIconEmoji('idle')}`)
  expect(drawn).not.toContain(`Old stopped session ${actionIconEmoji('waiting')}`)
  expect(drawn).not.toContain('Needs you')
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
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect(await drawnPane($)).toContain(line)
    expect(await bandDrawn($)).not.toContain('data error')
  })
}

test('F07: a poll that throws before its snapshot write logs the failure name, not silence', async ($: Engine, on) => {
  const host = stubHost(on, { storeKeysDenies: true })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.logs.some(line => line.startsWith('keepaway: poll failed ('))).toBe(true)
})

test('F14: a poll that failed at its deadline clears the polling flag, so the next tick polls again', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(ghCalls(host)).toBe(4)
  options.gate = NEVER()
  // At 60 s a render starts the poll that hangs; the tick at 70 s starts nothing beside it, and its deadline falls at 90 s.
  await host.clock.advance(50_000)
  await drawnPane($)
  await host.clock.advance(POLL_DEADLINE_MS)
  expect(ghCalls(host)).toBe(8)
  expect(host.logs).toContain('keepaway: poll failed (PollDeadline)')
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('1 open issue')
  options.gh = 'timeout'
  await host.clock.advance(POLL_MS)
  const drawn = await drawnPane($)
  expect(drawn).toContain('1 open issue')
  expect(drawn).toContain('GitHub did not answer in time')
  expect(host.logs).toContain('keepaway: gh issue call failed (timeout)')
})

// The log names each gh failure's kind, and never its stderr (F03).
const GH_FAILURE_KINDS: [string, GhMode][] = [
  ['network/DNS', { exitCode: 1, stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com' }],
  ['network/DNS', { exitCode: 1, stderr: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host' }],
  ['login', { exitCode: 1, stderr: 'To get started with GitHub CLI, please run: gh auth login' }],
  ['rate limit', { exitCode: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 1.' }],
  ['invalid token', { exitCode: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }],
  ['connection cut', { exitCode: 1, stderr: 'Post "https://api.github.com/graphql": unexpected EOF' }],
  ['connection cut', { exitCode: 1, stderr: 'Post "https://api.github.com/graphql": context deadline exceeded' }],
  ['HTTP 5xx', { exitCode: 1, stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' }],
  ['GraphQL', { exitCode: 1, stderr: 'GraphQL: Something went wrong while executing your query.' }],
  ['GraphQL', { exitCode: 1, stderr: 'GraphQL: Could not resolve to an Issue with the number of 99999. (repository.issue)' }],
  ['HTTP 4xx', { exitCode: 1, stderr: 'HTTP 404: Not Found (https://api.github.com/repos/o/r/milestones)' }],
  ['other', { exitCode: 1, stderr: 'synthetic failure' }],
  ['timeout', 'timeout'],
  ['gh missing', 'missing'],
]

for (const [kind, gh] of GH_FAILURE_KINDS) {
  test(`a gh failure logs its kind: ${kind}`, async ($: Engine, on) => {
    const host = stubHost(on, { gh })
    await $.session.start(SESSION)
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    expect(host.logs).toContain(`keepaway: gh issue call failed (${kind})`)
    expect(host.logs).toContain(`keepaway: gh api call failed (${kind})`)
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
  expect(host.logs.some(line => line.startsWith('keepaway: agent list failed ('))).toBe(true)
})

test('a file in the records folder that is not a session record is ignored: no data error beside valid records', async ($: Engine, on) => {
  stubHost(on, { records: [OWN_RECORD], strayFiles: ['scheduled-tasks.json', 'deleted_0a1b2c3d'] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  expect(await bandDrawn($)).not.toContain('data error')
  expect(await drawnPane($)).not.toContain('could not be read')
})

test('F18: a records folder that cannot be listed draws no records line', async ($: Engine, on) => {
  const host = stubHost(on, { unlistable: [`${RECORDS}/org/user`] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  expect([...host.store.keys()].filter(key => key.startsWith('override:'))).toEqual([`override:${SESSION_ID}`])
})

test('F08: a window that maps to an issue whose view fails reads #106 in the band, never no issue', async ($: Engine, on) => {
  const host = stubHost(on, { gh: { exitCode: 1, stderr: 'synthetic failure' } })
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('GitHub did not answer as expected: showing the last data')
  expect(drawn).toContain('Fix disk full')
})

test('R2-03: a failing poll keeps the cadence, so renders between two polls do not poll again', async ($: Engine, on) => {
  const options: StubOptions = {}
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.advance(POLL_DEADLINE_MS)
  expect(host.logs).toContain('keepaway: poll failed (PollDeadline)')
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  options.gate = gate
  // Two stuck polls make 6 gh calls; the polls after them are skipped with a log line, however long the hang lasts.
  await host.clock.advance(20 * POLL_MS)
  expect(ghCalls(host)).toBe(12)
  expect(host.logs.some(line => line.startsWith('keepaway: poll skipped ('))).toBe(true)
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The header counts the listed sessions; the cap hides rows past 20. 65: this window, the 63 newest others and the old session its open PR keeps.
  expect(await drawnPane($)).toContain('65 sessions')
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
    await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
    await host.clock.settle()
    // As DL7: the header counts the listed sessions, which the row cap does not change (65 with the old session, 64 without).
    expect(await drawnPane($)).toContain(`${drawn ? 65 : 64} sessions`)
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('view') && argv.includes(String(ISSUE)))).toBe(false)
})

test('DL10: exactly 500 open issues draw no partial-list line, since gh is asked for one more', async ($: Engine, on) => {
  const host = stubHost(on, { issues: issueList(500) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('list') && argv.includes('501'))).toBe(true)
  expect(await drawnPane($)).not.toContain('list is partial')
})

test('DL10: 501 open issues draw the partial-list line with the first 500 kept', async ($: Engine, on) => {
  const host = stubHost(on, { issues: issueList(501) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('list is partial (first 500)')
})

test('DL11: a tag named like the checked-out branch does not make it heads/<name>, so the default branch reads no commits', async ($: Engine, on) => {
  const host = stubHost(on, { branches: { [REPO_ROOT]: 'main' }, tags: ['main'] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('log'))).toBe(false)
})

test('DL11: an unborn branch is not a git failure', async ($: Engine, on) => {
  const host = stubHost(on, { branches: { [REPO_ROOT]: 'main' }, unborn: [REPO_ROOT] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).not.toContain('git failed')
})

test('DL11: a detached HEAD is no branch and no git failure', async ($: Engine, on) => {
  const host = stubHost(on, { detached: [REPO_ROOT] })
  // An issue for this window draws its details, whose Branch line shows the branch the poll read.
  host.store.set(`override:${SESSION_ID}`, { issue: ISSUE, ts: 0 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const branchReads = host.argvs.filter(argv => argv.includes('symbolic-ref') && argv.at(-1) === 'HEAD')
  expect(branchReads.map(argv => argv[argv.indexOf('-C') + 1])).toContain(REPO_ROOT)
  expect(textIn(keyedIn(await drawnTree($), 'detail-branch'))).toBe('Branch:no branch')
  expect(await drawnPane($)).not.toContain('git failed')
})

test('DL13: a last commit with an empty subject is still a commit', async ($: Engine, on) => {
  const host = stubHost(on, { log: `${'a'.repeat(40)}\t1700000000\t` })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // Each timeline row is keyed by its session and index: the session's start, plus the commit.
  const rows = (await drawnPane($)).split(`event-${SESSION_ID}-`).length - 1
  expect(rows).toBe(2)
})

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const COMMIT_LINK = `](https://github.com/acme/app/commit/${COMMIT_SHA})`

// The window's session drawn with the given git log answer: the timeline of this window, after a `/keepaway open`.
async function drawnAfterOpen(on: On, $: Engine, surface: 'desktop' | 'terminal', log: string): Promise<string> {
  const host = stubHost(on, { log })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  return drawnPane($, surface)
}

test('a commit id from git log reaches its commit link: the 40-hex id read with %H links to /commit/<id> on the desktop', async ($: Engine, on) => {
  const host = stubHost(on, { log: `${COMMIT_SHA}\t1700000000\tfix the thing` })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.argvs.some(argv => argv.includes('--format=%H%x09%ct%x09%s'))).toBe(true)
  expect(await drawnPane($, 'desktop')).toContain(COMMIT_LINK)
})

test('a tab inside a commit subject survives the git log parse: its words are drawn, the id and the time stay put', async ($: Engine, on) => {
  const drawn = await drawnAfterOpen(on, $, 'terminal', `${COMMIT_SHA}\t1700000000\tfix\tthe thing`)
  expect(drawn).toContain('fix the thing')
})

test('a 7-char commit id gives no commit link on the desktop; its commit row is still drawn', async ($: Engine, on) => {
  const drawn = await drawnAfterOpen(on, $, 'desktop', `${COMMIT_SHA.slice(0, 7)}\t1700000000\tshort id`)
  expect(drawn).toContain('short id')
  expect(drawn).not.toContain('/commit/')
})

test('a 64-hex commit id (SHA-256 repo) links to its commit page on the desktop', async ($: Engine, on) => {
  const sha256 = `${COMMIT_SHA}${COMMIT_SHA.slice(0, 24)}`
  const drawn = await drawnAfterOpen(on, $, 'desktop', `${sha256}\t1700000000\tlong id`)
  expect(drawn).toContain('long id')
  expect(drawn).toContain(`/commit/${sha256}`)
})

test('a 52-hex commit id is no full hash: no commit link; its commit row is still drawn', async ($: Engine, on) => {
  const drawn = await drawnAfterOpen(on, $, 'desktop', `${COMMIT_SHA}${COMMIT_SHA.slice(0, 12)}\t1700000000\todd id`)
  expect(drawn).toContain('odd id')
  expect(drawn).not.toContain('/commit/')
})

test('two sessions with two origins: each title opens its own session, and neither title links to a repo page', async ($: Engine, on) => {
  const OTHER_FOLDER = '/work/app-b'
  const OTHER = recordOf('local_7f3a0002', {
    title: 'Second origin',
    cwd: OTHER_FOLDER,
    gitAnchors: [{ commonDir: `${OTHER_FOLDER}/.git` }],
  })
  const host = stubHost(on, { records: [OWN_RECORD, OTHER], remotes: { [`${OTHER_FOLDER}/.git`]: 'https://github.com/Acme/App.git' } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const desktop = await drawnPane($, 'desktop')
  expect(desktop).toContain('[Second origin](#local_7f3a0002)')
  expect(desktop).toMatch(/\[Fix disk full\]\(#local_[0-9a-z-]+\)/)
  expect(desktop).not.toContain('](https://github.com/Acme/App)')
  expect(desktop).not.toContain('](https://github.com/acme/app)')
})

test('SP5-1: /keepaway open or issue with extra words toasts usage and changes nothing', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open extra', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keepaway', args: 'issue 106 extra', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(prQueryOf(host)).toContain('closingIssuesReferences(first: 50) { totalCount nodes { number repository { nameWithOwner } } }')
  expect(viewedIssues(host)).toEqual([])
})

test('DL9: a PR with 11 closing issues links the lowest, the 11th, since the page holds 50', async ($: Engine, on) => {
  const closes = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 12]
  const host = stubHost(on, { openPrs: [{ number: 5, title: 'Wide PR', headRefName: 'feature/disk', closes }] })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(prQueryOf(host)).toContain('closingIssuesReferences(first: 50)')
  expect(viewedIssues(host)).toEqual(['12'])
})

test('RB1-4: the open milestones are read with --paginate, so a repo past 100 open milestones is not cut silently', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const milestoneCalls = host.argvs.filter(argv => argv[0] === 'gh' && argv.some(arg => arg.includes('/milestones')))
  expect(milestoneCalls).toEqual([['gh', 'api', '--paginate', 'repos/acme/app/milestones?state=open&per_page=100']])
})

test('RB1-5: a malformed issue item is dropped and counted in the log, and the rest is drawn with no failure line', async ($: Engine, on) => {
  const issues = JSON.stringify([...(JSON.parse(ISSUE_LIST_JSON) as unknown[]), MALFORMED_ISSUE])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.logs).toEqual(['keepaway: gh issue items not readable (1)'])
  const drawn = await drawnPane($)
  expect(drawn).toContain('1 open issue')
  expect(drawn).not.toContain(GH_FAILED_LINE)
  expect(host.logs.some(line => line.includes(MALFORMED_ISSUE.title))).toBe(false)
})

test('RB1-5: an issue list whose every item is malformed is an unreadable answer: the gh-failed line', async ($: Engine, on) => {
  const host = stubHost(on, { issues: JSON.stringify([MALFORMED_ISSUE, MALFORMED_ISSUE]) })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain(GH_FAILED_LINE)
  expect(host.logs).toContain('keepaway: gh issue answer not readable')
})

test('RB1-5: a dropped item does not hide the 501st item, so the partial-list line still shows', async ($: Engine, on) => {
  const issues = JSON.stringify([...(JSON.parse(issueList(500)) as unknown[]), MALFORMED_ISSUE])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(await drawnPane($)).toContain('list is partial (first 500)')
})

test('SE3: a gh answer the engine cut at its stdout cap is unreadable: the gh-failed line, nothing parsed', async ($: Engine, on) => {
  const host = stubHost(on, { gh: 'cut', issues: ISSUE_LIST_JSON })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain(GH_FAILED_LINE)
  expect(drawn).not.toContain('1 open issue')
  expect(host.logs).toContain('keepaway: gh issue answer not readable')
})

test('SE3: a gh answer over the byte cap, counted in UTF-8 bytes, is unreadable before it is parsed', async ($: Engine, on) => {
  // Two bytes per character: under the cap in UTF-16 units, over it in bytes.
  const [issue] = JSON.parse(ISSUE_LIST_JSON) as Record<string, unknown>[]
  const issues = JSON.stringify([{ ...issue, body: 'é'.repeat(GH_OUTPUT_MAX_BYTES / 2 + 1) }])
  const host = stubHost(on, { issues })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain(GH_FAILED_LINE)
  expect(drawn).not.toContain('1 open issue')
})

test('SP3-1: both the issue list and the PR list cut draw one partial-list line each, with its own limit', async ($: Engine, on) => {
  const host = stubHost(on, { issues: issueList(501), prTotal: 101 })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  // The engine refuses the whole draw when two Markdown elements share a key, so the tree is the proof it was drawn.
  const tree = await drawnTree($, 'desktop')
  expect(keyedIn(tree, `title-${SESSION_ID}`)?.props?.text).toContain(`](#${SESSION_ID})`)
  expect(keyedIn(tree, `title-${otherId}`)?.props?.text).toContain(`](#${otherId})`)
  const markdowns = nodesOf(tree).filter(node => node.type === 'Markdown')
  const texts = markdowns.map(node => String(node.props?.text))
  for (const number of [1, 2]) {
    expect(texts.filter(text => text.startsWith(`[🛠️ #${number}](https://github.com/acme/app/issues/${number})`))).toHaveLength(1)
  }
  for (const number of [3, 4]) {
    expect(texts.filter(text => text.endsWith(`[#${number} Issue ${number} ↗](https://github.com/acme/app/issues/${number})`))).toHaveLength(1)
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
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
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

// ---- repo logos (SPEC section 11): the lookup, its cache and its drawing ----

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const LOGO_BYTES = Uint8Array.from(atob(TINY_PNG), char => char.charCodeAt(0))
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>'
const SVG_BYTES = new TextEncoder().encode(LOGO_SVG)
const TRUNCATED_PNG = LOGO_BYTES.slice(0, -4)
// The drawn picture of TINY_PNG: the frame pictureDocumentOf builds around it.
const LOGO_FRAME = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="data:image/png;base64,${TINY_PNG}" width="1" height="1"/></svg>`
const openPane = async ($: Engine): Promise<void> => {
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
}
// The repo logo's drawn picture: the Svg the desktop draws with the logo's alt text (the KeepGlide mark is another Svg).
const repoLogoOf = (tree: DrawnNode): DrawnNode[] => nodesOf(tree).filter(node => node.type === 'Svg' && node.props?.alt === 'acme/app logo')
// The gh calls that ask GitHub for a path's contents (the logo lookup's, not the poll's).
const contentsCalls = (host: Host): number =>
  host.argvs.filter(argv => argv[0] === 'gh' && (argv[2] ?? '').includes('/contents/')).length
// The logo store lines the window logged: each operation once.
const logoStoreLogs = (host: Host): string[] => host.logs.filter(line => line.startsWith('keepaway: logo store'))

test('a logo file in the checkout is drawn before the title on the desktop, and GitHub is not asked', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, checkout: { [`${REPO_ROOT}/logo.png`]: LOGO_BYTES } })
  await openPane($)
  await host.clock.settle()
  const logo = repoLogoOf(await drawnTree($, 'desktop'))[0]
  expect(logo?.type).toBe('Svg')
  expect(logo?.props).toMatchObject({ source: LOGO_FRAME, alt: 'acme/app logo', width: 32, height: 32 })
  expect(contentsCalls(host)).toBe(0)
  expect(host.denies).toEqual([])
  expect(host.logs).toEqual([])
})

test('the terminal draws no logo, though the checkout has one', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, checkout: { [`${REPO_ROOT}/logo.png`]: LOGO_BYTES } })
  await openPane($)
  await host.clock.settle()
  expect(repoLogoOf(await drawnTree($, 'terminal'))).toEqual([])
  expect(await drawnPane($)).toContain('Fix disk full')
})

test('a logo the checkout lacks comes from GitHub at the root, the first name it holds, in three calls at most', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, contents: { 'logo.jpeg': JPEG_BYTES } })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(3)
  expect(repoLogoOf(await drawnTree($, 'desktop'))[0]?.props).toMatchObject({ source: expect.stringContaining('data:image/jpeg;base64,') })
})

test('GitHub is asked for the first three names only: a logo under assets/ is found in the checkout, not on GitHub', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, contents: { 'assets/logo.png': LOGO_BYTES } })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(3)
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
})

test('a repo with no logo is stored as none, and not asked again on each poll', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(3)
  expect(host.store.get(LOGO_STORE_KEY)).toMatchObject({ source: null, failed: false })
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(3)
})

test('an SVG in the checkout is ignored, and the lookup goes on to GitHub', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, checkout: { [`${REPO_ROOT}/logo.svg`]: SVG_BYTES } })
  await openPane($)
  await host.clock.settle()
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
  expect(contentsCalls(host)).toBe(3)
})

test('a truncated PNG in the checkout is not drawn, and the lookup goes on to GitHub', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, checkout: { [`${REPO_ROOT}/logo.png`]: TRUNCATED_PNG } })
  await openPane($)
  await host.clock.settle()
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
  expect(contentsCalls(host)).toBe(3)
})

test('a symbolic link named as a logo is never read: the lookup goes on to GitHub', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, checkout: { [`${REPO_ROOT}/logo.png`]: LOGO_BYTES }, links: [`${REPO_ROOT}/logo.png`] })
  await openPane($)
  await host.clock.settle()
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
  expect(host.readPaths).not.toContain(`${REPO_ROOT}/logo.png`)
  expect(contentsCalls(host)).toBe(3)
})

test('the store key is the remote in lower case, the github.com page is not its key on an enterprise host', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, rootRemote: 'git@github.com:Acme/App.git' })
  await openPane($)
  await host.clock.settle()
  expect(host.store.has('logo:github.com/acme/app')).toBe(true)
})

test('an enterprise GitHub remote asks GitHub for no logo: its key is its own host, and no owner or contents call runs', async ($: Engine, on) => {
  const host = stubHost(on, {
    lookLogos: true,
    remotes: { [`${REPO_ROOT}/.git`]: 'git@github.example.test:acme/app.git' },
    ownerType: 'Organization',
    ownerAvatarUrl: ORG_AVATAR,
    avatarBase64: TINY_PNG,
  })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(0)
  expect(host.argvs.some(argv => argv[0] === 'gh' && (argv[2] ?? '').startsWith('users/'))).toBe(false)
  expect(host.store.has('logo:github.example.test/acme/app')).toBe(true)
})

test('a failed lookup is logged by its kind, kept for an hour, and the pane still draws its sessions', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, contentsFailure: 'gh: Server Error (HTTP 500)' })
  await openPane($)
  await host.clock.settle()
  expect(host.logs).toContain('keepaway: logo lookup failed (HTTP 5xx)')
  expect(contentsCalls(host)).toBe(1)
  expect(host.store.get(LOGO_STORE_KEY)).toMatchObject({ source: null, failed: true })
  expect(await drawnPane($)).toContain('Fix disk full')
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(1)
  await host.clock.advance(LOGO_RETRY_MS)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(2)
})

test('a store that refuses its writes and reads is logged once per operation, and the pane still draws; no lookup repeats', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, logoStoreRefuses: true })
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Fix disk full')
  const lines = logoStoreLogs(host)
  expect(lines.length).toBeGreaterThan(0)
  expect(new Set(lines).size).toBe(lines.length)
  expect(contentsCalls(host)).toBe(3)
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(3)
  expect(logoStoreLogs(host)).toEqual(lines)
})

// The Pane mounted on a surface: the caller reads or presses it, then unmounts it (the engine keeps no other copy).
const mountPane = ($: Engine, surface: 'desktop' | 'terminal' = 'terminal') =>
  $.ui.mount({ plugin: 'keepaway-repo', surface, component: 'Pane', requestId: PANE_ID, props: {} as never })
// The legend's button and its table in a mounted Pane.
const legendButtonLabelOf = async (mounted: Awaited<ReturnType<typeof mountPane>>): Promise<string | undefined> =>
  (await mounted.find({ type: 'Button', key: 'legend-toggle' }))?.props.label as string | undefined
// The legend's store lines the window logged.
const legendStoreLogs = (host: Host): string[] => host.logs.filter(line => line.startsWith('keepaway: legend store'))

// SPEC section 19: the legend is an accordion, closed by default. A press opens it and stores `legendOpen`; the next press closes it and
// removes the key. The state is read from the store on every draw, so a reload draws the same state.
for (const surface of ['desktop', 'terminal'] as const) {
  test(`the legend on the ${surface} is closed by default, a press opens it and stores the state, a second press closes it and removes the key`, async ($: Engine, on) => {
    const host = stubHost(on)
    await openPane($)
    await host.clock.settle()
    const closed = await mountPane($, surface)
    expect(await legendButtonLabelOf(closed)).toBe('▸ Labels Descriptions')
    expect(await closed.find({ type: 'Box', key: 'legend' })).toBeFalsy()
    await closed.press({ key: 'legend-toggle' })
    await host.clock.settle()
    await closed.unmount()
    expect(host.store.get('legendOpen')).toBe(true)

    const opened = await mountPane($, surface)
    expect(await legendButtonLabelOf(opened)).toBe('▾ Labels Descriptions')
    expect(await opened.find({ type: 'Box', key: 'legend' })).toBeTruthy()
    await opened.press({ key: 'legend-toggle' })
    await host.clock.settle()
    await opened.unmount()
    expect(host.store.get('legendOpen')).toBeUndefined()

    const reclosed = await mountPane($, surface)
    expect(await legendButtonLabelOf(reclosed)).toBe('▸ Labels Descriptions')
    expect(await reclosed.find({ type: 'Box', key: 'legend' })).toBeFalsy()
    await reclosed.unmount()
    await expectClean(host, $)
  })
}

test('a legend the store holds open draws its table on the next draw, before any press', async ($: Engine, on) => {
  const host = stubHost(on)
  host.store.set('legendOpen', true)
  await openPane($)
  await host.clock.settle()
  const mounted = await mountPane($)
  expect(await legendButtonLabelOf(mounted)).toBe('▾ Labels Descriptions')
  expect(await mounted.find({ type: 'Box', key: 'legend' })).toBeTruthy()
  await mounted.unmount()
  await expectClean(host, $)
})

test('a store that refuses the legend state is logged once, the legend draws closed and the pane goes on', async ($: Engine, on) => {
  const host = stubHost(on, { legendStoreRefuses: true })
  await openPane($)
  await host.clock.settle()
  const mounted = await mountPane($)
  expect(await legendButtonLabelOf(mounted)).toBe('▸ Labels Descriptions')
  await mounted.press({ key: 'legend-toggle' })
  await host.clock.settle()
  await mounted.press({ key: 'legend-toggle' })
  await host.clock.settle()
  expect(await legendButtonLabelOf(mounted)).toBe('▸ Labels Descriptions')
  await mounted.unmount()
  expect(await drawnPane($)).toContain('Fix disk full')
  const lines = legendStoreLogs(host)
  expect(lines.length).toBeGreaterThan(0)
  expect(new Set(lines).size).toBe(lines.length)
})

test('the store keeps at most LOGO_STORE_MAX repo logos: the oldest ones of the other repos go first', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true })
  // Twenty-one other repos, each fresh: the one written first is the oldest.
  for (let index = 0; index <= LOGO_STORE_MAX; index += 1) {
    host.store.set(`logo:github.com/old/repo-${index}`, { source: null, at: Number.MAX_SAFE_INTEGER - 100 + index, failed: false })
  }
  await openPane($)
  await host.clock.settle()
  expect(host.store.has('logo:github.com/old/repo-0')).toBe(false)
  expect(host.store.has('logo:github.com/old/repo-1')).toBe(false)
  expect(host.store.has('logo:github.com/old/repo-2')).toBe(true)
  expect(host.store.has(LOGO_STORE_KEY)).toBe(true)
})

test('a stored logo of a repo this window no longer shows is dropped once it has expired', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true })
  host.store.set('logo:github.com/old/repo', { source: null, at: -LOGO_TTL_MS, failed: false })
  host.store.set('logo:github.com/kept/repo', { source: null, at: Number.MAX_SAFE_INTEGER, failed: false })
  await openPane($)
  await host.clock.settle()
  expect(host.store.has('logo:github.com/old/repo')).toBe(false)
  expect(host.store.has('logo:github.com/kept/repo')).toBe(true)
})

test('a lock another window holds is respected until it is two minutes old; this window deletes its own lock after a lookup', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, contents: { 'logo.png': LOGO_BYTES } })
  host.store.set(logoLockKeyOf('github.com/acme/app'), { at: Number.MAX_SAFE_INTEGER })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(0)
  host.store.set(logoLockKeyOf('github.com/acme/app'), { at: -LOGO_LOCK_MS * 2 })
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(1)
  expect(host.store.has(logoLockKeyOf('github.com/acme/app'))).toBe(false)
})

test('this window\'s issue view is reused while its updatedAt is unchanged, and asked again when it moves', async ($: Engine, on) => {
  const options: StubOptions = {
    issues: JSON.stringify([{ number: ISSUE, title: 'Synthetic issue', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/106', milestone: null, labels: [] }]),
  }
  const host = stubHost(on, options)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'issue 106', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const viewCalls = (): number => host.argvs.filter(argv => argv[0] === 'gh' && argv.includes('view')).length
  expect(viewCalls()).toBe(1)
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(viewCalls()).toBe(1)
  options.issues = JSON.stringify([{ number: ISSUE, title: 'Synthetic issue', updatedAt: '2026-10-21T09:00:00Z', url: 'https://github.com/acme/app/issues/106', milestone: null, labels: [] }])
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(viewCalls()).toBe(2)
})

test('the GitLab project avatar: glab is asked on the remote host, and its avatar is drawn', async ($: Engine, on) => {
  const host = stubHost(on, {
    lookLogos: true,
    remotes: { [`${REPO_ROOT}/.git`]: OTHER_REMOTE },
    glabInstalled: true,
    glabAvatarUrl: 'https://gitlab.example.test/uploads/app.png',
    avatarBase64: TINY_PNG,
  })
  await openPane($)
  await host.clock.settle()
  expect(host.argvs.find(argv => argv[0] === 'glab' && argv[1] === 'api')).toEqual([
    'glab',
    'api',
    'projects/acme%2Fapp',
    '--hostname',
    'gitlab.example.test',
  ])
  expect(avatarCalls(host)).toEqual(['https://gitlab.example.test/uploads/app.png'])
})

test('a glab that times out fails its lookup: kept an hour and logged, and the pane still draws its sessions', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, remotes: { [`${REPO_ROOT}/.git`]: OTHER_REMOTE }, glabTimesOut: true })
  await openPane($)
  await host.clock.settle()
  expect(host.argvs.filter(argv => argv[0] === 'glab' && argv[1] === '--version')).toHaveLength(1)
  expect(host.logs).toContain('keepaway: logo lookup failed (glab)')
  expect(host.store.get(logoStoreKeyOf('gitlab.example.test/acme/app'))).toMatchObject({ source: null, failed: true })
  expect(await drawnPane($)).toContain('Fix disk full')
})

test('a stored logo past its day is looked up again on the next poll, and a fresh one is not', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, contents: { 'logo.png': LOGO_BYTES } })
  host.store.set(LOGO_STORE_KEY, { source: null, at: -LOGO_TTL_MS, failed: false })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(1)
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(1)
})

test('a glab that times out is retried after its hour: the next lookup asks glab again and draws the avatar', async ($: Engine, on) => {
  const options: StubOptions = {
    lookLogos: true,
    remotes: { [`${REPO_ROOT}/.git`]: OTHER_REMOTE },
    glabTimesOut: true,
    glabInstalled: true,
    glabAvatarUrl: 'https://gitlab.example.test/uploads/app.png',
    avatarBase64: TINY_PNG,
  }
  const host = stubHost(on, options)
  const glabVersionCalls = (): number => host.argvs.filter(argv => argv[0] === 'glab' && argv[1] === '--version').length
  await openPane($)
  await host.clock.settle()
  expect(glabVersionCalls()).toBe(1)
  expect(avatarCalls(host)).toEqual([])
  options.glabTimesOut = false
  await host.clock.advance(LOGO_RETRY_MS)
  await host.clock.settle()
  expect(glabVersionCalls()).toBe(2)
  expect(avatarCalls(host)).toEqual(['https://gitlab.example.test/uploads/app.png'])
})

// ---- ssh aliases (SPEC section 16): a remote host with no dot is an alias ssh resolves; the real host feeds the logo, its key and the links ----

const sshCalls = (host: Host): string[][] => host.argvs.filter(argv => argv[0] === 'ssh')

test('an ssh alias that resolves to github.com is GitHub: its logo comes from gh under github.com, its alt names the repo, and ssh is asked once', async ($: Engine, on) => {
  const ALIAS = 'git@github-keepglide:acme/app.git'
  const host = stubHost(on, {
    lookLogos: true,
    rootRemote: ALIAS,
    remotes: { [`${REPO_ROOT}/.git`]: ALIAS },
    sshHosts: { 'github-keepglide': 'github.com' },
    contents: { 'logo.png': LOGO_BYTES },
  })
  await openPane($)
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(sshCalls(host)).toEqual([['ssh', '-G', 'github-keepglide']])
  expect(contentsCalls(host)).toBe(1)
  expect(host.store.has(LOGO_STORE_KEY)).toBe(true)
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toHaveLength(1)
  expect(await drawnPane($, 'desktop')).toContain('acme/app logo')
})

test('an ssh alias that resolves to gitlab.com takes the GitLab path with the real host: glab is asked on gitlab.com', async ($: Engine, on) => {
  const ALIAS = 'git@gitlab-work:acme/app.git'
  const host = stubHost(on, {
    lookLogos: true,
    rootRemote: ALIAS,
    remotes: { [`${REPO_ROOT}/.git`]: ALIAS },
    sshHosts: { 'gitlab-work': 'gitlab.com' },
    glabInstalled: true,
    glabAvatarUrl: 'https://gitlab.com/uploads/app.png',
    avatarBase64: TINY_PNG,
  })
  await openPane($)
  await host.clock.settle()
  expect(sshCalls(host)).toEqual([['ssh', '-G', 'gitlab-work']])
  expect(host.argvs.find(argv => argv[0] === 'glab' && argv[1] === 'api')).toEqual([
    'glab',
    'api',
    'projects/acme%2Fapp',
    '--hostname',
    'gitlab.com',
  ])
  expect(avatarCalls(host)).toEqual(['https://gitlab.com/uploads/app.png'])
  expect(host.store.has(logoStoreKeyOf('gitlab.com/acme/app'))).toBe(true)
})

test('an ssh alias ssh cannot resolve keeps the alias: no gh logo lookup, the pane draws, and the failure is logged once', async ($: Engine, on) => {
  const ALIAS = 'git@github-keepglide:acme/app.git'
  const host = stubHost(on, {
    lookLogos: true,
    rootRemote: ALIAS,
    remotes: { [`${REPO_ROOT}/.git`]: ALIAS },
    sshFails: true,
    contents: { 'logo.png': LOGO_BYTES },
  })
  await openPane($)
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(sshCalls(host)).toHaveLength(1)
  expect(contentsCalls(host)).toBe(0)
  expect(host.logs.filter(line => line.includes('ssh alias lookup failed'))).toHaveLength(1)
  expect(await drawnPane($)).toContain('Fix disk full')
})

test('a dotted host named like GitHub is no alias: no ssh call, no gh logo lookup, and its key keeps the host', async ($: Engine, on) => {
  const DOTTED = 'git@github.corp.example:acme/app.git'
  const host = stubHost(on, {
    lookLogos: true,
    rootRemote: DOTTED,
    remotes: { [`${REPO_ROOT}/.git`]: DOTTED },
    contents: { 'logo.png': LOGO_BYTES },
  })
  await openPane($)
  await host.clock.settle()
  expect(sshCalls(host)).toEqual([])
  expect(contentsCalls(host)).toBe(0)
  expect(host.store.has('logo:github.corp.example/acme/app')).toBe(true)
})

test('an ssh alias whose ssh -G times out keeps the alias, logs the failure by its name, and the pane still draws', async ($: Engine, on) => {
  const ALIAS = 'git@github-keepglide:acme/app.git'
  const host = stubHost(on, {
    lookLogos: true,
    rootRemote: ALIAS,
    remotes: { [`${REPO_ROOT}/.git`]: ALIAS },
    sshTimesOut: true,
    contents: { 'logo.png': LOGO_BYTES },
  })
  await openPane($)
  await host.clock.settle()
  expect(sshCalls(host)).toHaveLength(1)
  expect(contentsCalls(host)).toBe(0)
  expect(host.logs).toContain('keepaway: ssh alias lookup failed (HooksError)')
  expect(await drawnPane($)).toContain('Fix disk full')
})

test('a failed ssh alias lookup is asked again after LOGO_RETRY_MS, not before, and then its GitHub host draws the logo', async ($: Engine, on) => {
  const ALIAS = 'git@github-keepglide:acme/app.git'
  const options: StubOptions = {
    lookLogos: true,
    rootRemote: ALIAS,
    remotes: { [`${REPO_ROOT}/.git`]: ALIAS },
    sshFails: true,
    sshHosts: { 'github-keepglide': 'github.com' },
    contents: { 'logo.png': LOGO_BYTES },
  }
  const host = stubHost(on, options)
  await openPane($)
  await host.clock.settle()
  expect(sshCalls(host)).toHaveLength(1)
  options.sshFails = false
  await host.clock.advance(LOGO_RETRY_MS - 1)
  await host.clock.settle()
  expect(sshCalls(host)).toHaveLength(1)
  await host.clock.advance(1)
  await host.clock.settle()
  expect(sshCalls(host)).toHaveLength(2)
  expect(contentsCalls(host)).toBe(1)
  expect(await drawnPane($, 'desktop')).toContain('acme/app logo')
})

test('a remote whose host starts with a dash is no remote: no ssh or glab call names it, and the pane still draws', async ($: Engine, on) => {
  const DASHED = 'git@-gitlab:acme/app.git'
  const host = stubHost(on, {
    lookLogos: true,
    rootRemote: DASHED,
    remotes: { [`${REPO_ROOT}/.git`]: DASHED },
    glabInstalled: true,
    glabAvatarUrl: 'https://gitlab.example.test/uploads/app.png',
  })
  await openPane($)
  await host.clock.settle()
  expect(sshCalls(host)).toEqual([])
  expect(host.argvs.filter(argv => argv[0] === 'glab')).toEqual([])
  expect(host.argvs.filter(argv => argv.some(part => part.includes('-gitlab')))).toEqual([])
  expect(await drawnPane($)).toContain('Fix disk full')
})

// ---- the avatars (SPEC section 11, sources 3 and 4): GitHub's organization avatar, and the GitLab project's through glab ----

// A 1 by 1 PNG, as base64 (the fetch answers base64 text, so the test gives the text itself).
const ORG_AVATAR = 'https://avatars.githubusercontent.com/u/9001?v=4'
const ORG_AVATAR_SIZED = 'https://avatars.githubusercontent.com/u/9001?v=4&s=32'
// The URL of each avatar fetch: the fetch's argv is [sh, -c, script, name, url], so the URL is its fifth entry.
const avatarCalls = (host: Host): string[] => host.argvs.filter(argv => argv[0] === 'sh').map(argv => argv[4] ?? '')

test('an organization owner avatar is drawn when the checkout and the contents hold no logo: fetched as a PNG at 32 px, the URL as the one argument', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, ownerType: 'Organization', ownerAvatarUrl: ORG_AVATAR, avatarBase64: TINY_PNG })
  await openPane($)
  await host.clock.settle()
  expect(contentsCalls(host)).toBe(3)
  expect(host.argvs.find(argv => argv[0] === 'sh')).toEqual(['sh', '-c', AVATAR_FETCH_SCRIPT, 'keepaway-logo', ORG_AVATAR_SIZED])
  const logo = repoLogoOf(await drawnTree($, 'desktop'))[0]
  expect(logo?.props).toMatchObject({ alt: 'acme/app logo', width: 32, height: 32 })
  expect(String(logo?.props?.source)).toContain(`data:image/png;base64,${TINY_PNG}`)
  expect(host.store.get(LOGO_STORE_KEY)).toMatchObject({ failed: false })
  expect(host.denies).toEqual([])
})

test('a user owner draws no avatar: only the account type is asked, and no fetch runs', async ($: Engine, on) => {
  const host = stubHost(on, { lookLogos: true, ownerType: 'User', ownerAvatarUrl: ORG_AVATAR, avatarBase64: TINY_PNG })
  await openPane($)
  await host.clock.settle()
  const accountCalls = host.argvs.filter(argv => argv[0] === 'gh' && (argv[2] ?? '').startsWith('users/')).map(argv => argv.at(-1))
  expect(accountCalls).toEqual(['.type'])
  expect(avatarCalls(host)).toEqual([])
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
  expect(host.store.get(LOGO_STORE_KEY)).toMatchObject({ source: null, failed: false })
})

test('an avatar URL that is not https is never fetched', async ($: Engine, on) => {
  const host = stubHost(on, {
    lookLogos: true,
    ownerType: 'Organization',
    ownerAvatarUrl: 'http://avatars.githubusercontent.com/u/9001?v=4',
    avatarBase64: TINY_PNG,
  })
  await openPane($)
  await host.clock.settle()
  expect(avatarCalls(host)).toEqual([])
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
})

test('an avatar URL on a host other than the avatar host is never fetched', async ($: Engine, on) => {
  const host = stubHost(on, {
    lookLogos: true,
    ownerType: 'Organization',
    ownerAvatarUrl: 'https://evil.example.test/u/9001.png',
    avatarBase64: TINY_PNG,
  })
  await openPane($)
  await host.clock.settle()
  expect(avatarCalls(host)).toEqual([])
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
})

test('an avatar that is not a PNG or a JPEG is not drawn, and is kept as no logo (an SVG is refused)', async ($: Engine, on) => {
  const host = stubHost(on, {
    lookLogos: true,
    ownerType: 'Organization',
    ownerAvatarUrl: ORG_AVATAR,
    avatarBase64: base64Of(new TextEncoder().encode(LOGO_SVG)),
  })
  await openPane($)
  await host.clock.settle()
  expect(avatarCalls(host)).toHaveLength(1)
  expect(repoLogoOf(await drawnTree($, 'desktop'))).toEqual([])
  expect(host.logs).toEqual([])
  expect(host.store.get(LOGO_STORE_KEY)).toMatchObject({ source: null, failed: false })
})

test('a failed avatar fetch is logged once, kept for an hour, and the pane still draws its sessions', async ($: Engine, on) => {
  // No avatarBase64: the fetch answers nothing, as curl does when it is missing or fails.
  const host = stubHost(on, { lookLogos: true, ownerType: 'Organization', ownerAvatarUrl: ORG_AVATAR })
  await openPane($)
  await host.clock.settle()
  expect(host.logs).toEqual(['keepaway: logo lookup failed (avatar fetch)'])
  expect(host.store.get(LOGO_STORE_KEY)).toMatchObject({ source: null, failed: true })
  expect(await drawnPane($)).toContain('Fix disk full')
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(avatarCalls(host)).toHaveLength(1)
  await host.clock.advance(LOGO_RETRY_MS)
  await host.clock.settle()
  expect(avatarCalls(host)).toHaveLength(2)
})

// ---- session summaries (SPEC section 21) ----

// The transcript of this window's session: its folder is the cwd (REPO_ROOT) with every non-alphanumeric character as '-'.
const TRANSCRIPT_OWN = `${HOME}/.claude/projects/-work-app/${SELF}.jsonl`
// One newline-ended transcript line: a user message with this content.
const userLine = (content: unknown): string => `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
const headCalls = (host: Host): string[][] => host.argvs.filter(argv => argv[0] === 'head')
const summaryKeys = (host: Host): string[] => [...host.store.keys()].filter(key => key.startsWith('summary:'))

test('a session row draws its summary from the head of its transcript, read by head and never by fs.read (SPEC section 21)', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('Fix the disk full error') } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Fix the disk full error')
  expect(host.argvs).toContainEqual(['head', '-c', '262144', TRANSCRIPT_OWN])
  expect(host.readPaths).not.toContain(TRANSCRIPT_OWN)
  expect(summaryKeys(host)).toEqual([])
  await expectClean(host, $)
})

test('a transcript over 4 MiB gives its summary from the head alone', async ($: Engine, on) => {
  const huge = userLine('Map the store writes') + 'x'.repeat(5 * 1024 * 1024)
  expect(huge.length).toBeGreaterThan(4 * 1024 * 1024)
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: huge } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Map the store writes')
  expect(host.argvs).toContainEqual(['head', '-c', '262144', TRANSCRIPT_OWN])
  expect(host.readPaths).not.toContain(TRANSCRIPT_OWN)
  await expectClean(host, $)
})

test('a session summary is read once: a later poll reads no transcript again', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('Fix the disk full error') } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(1)
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(1)
  expect(await drawnPane($)).toContain('Fix the disk full error')
})

test('at most five transcripts are read per poll; the rest are read on a later poll, each one once', async ($: Engine, on) => {
  const many = Array.from({ length: 7 }, (_, index) => recordOf(`local_bbbb000${index}`, { cliSessionId: `sess-${index}` }))
  const transcripts = Object.fromEntries(many.map((_, index) => [`${HOME}/.claude/projects/-work-app/sess-${index}.jsonl`, userLine(`Prompt ${index}`)]))
  const host = stubHost(on, { records: [OWN_RECORD, ...many], transcripts: { ...transcripts, [TRANSCRIPT_OWN]: userLine('Own prompt') } })
  // The session start polls alone (the pane is closed): one poll, so at most five transcripts.
  await $.session.start(SESSION)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(5)
  // The band's slow cadence polls again and reads the three that waited.
  await host.clock.advance(BAND_POLL_MS)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(8)
  expect(new Set(headCalls(host).map(argv => argv[3])).size).toBe(8)
  await openPane($)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(8)
  expect(await drawnPane($)).toContain('Prompt 6')
})

test('a transcript with no prompt draws no summary line', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('<system-reminder>Context only</system-reminder>') } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).not.toContain('Context only')
  expect(summaryKeys(host)).toEqual([])
  await expectClean(host, $)
})

test('/keepaway summary off hides the lines and stops transcript reads; on draws them again', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('Fix the disk full error') } })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'summary off', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual(['Session summary lines: off'])
  expect(host.store.get('summary')).toBe(false)
  await openPane($)
  await host.clock.settle()
  expect(headCalls(host)).toEqual([])
  expect(await drawnPane($)).not.toContain('Summary:')
  await $.command.run({ command: 'keepaway', args: 'summary on', ...COMMAND_CONTEXT })
  await host.clock.settle()
  expect(host.toasts.at(-1)).toBe('Session summary lines: on')
  expect(await drawnPane($)).toContain('Fix the disk full error')
  await expectClean(host, $)
})

test('/keepaway summary with another word toasts the usage line and stores nothing', async ($: Engine, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'summary maybe', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keepaway', args: 'summary on off', ...COMMAND_CONTEXT })
  expect(host.toasts).toEqual([USAGE_TOAST, USAGE_TOAST])
  expect(host.store.has('summary')).toBe(false)
})

test('summaries are never stored: the summary:<id> keys an earlier build left are deleted once, and the setting key stays', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('Fix the disk full error') } })
  host.store.set('summary:old-1', { text: 'Prompt text of an earlier build', ts: 1 })
  host.store.set('summary', true)
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(host.store.has('summary:old-1')).toBe(false)
  expect(summaryKeys(host)).toEqual([])
  expect(host.store.get('summary')).toBe(true)
  expect(await drawnPane($)).toContain('Fix the disk full error')
  await expectClean(host, $)
})

// ---- plan steps (SPEC section 22) ----

const planLine = (time: string, items: unknown): string =>
  `${JSON.stringify({ type: 'assistant', timestamp: time, message: { content: [{ type: 'tool_use', name: 'mcp__ccd_turn__update_plan', input: { items } }] } })}\n`
const tailCalls = (host: Host): string[][] => host.argvs.filter(argv => argv[0] === 'tail')

test('a session row draws its plan steps, read from its transcript with tail from the first byte', async ($: Engine, on) => {
  const transcript =
    userLine('Fix the disk full error') +
    planLine('2026-11-02T10:19:00Z', [
      { content: 'Check the repository', status: 'completed' },
      { content: 'Patch the cleaner', status: 'in_progress' },
    ])
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: transcript } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  const pane = await drawnPane($)
  expect(pane).toContain('Patch the cleaner')
  expect(pane).toContain('Check the repository')
  expect(tailCalls(host)[0]).toEqual(['tail', '-c', '+1', TRANSCRIPT_OWN])
  expect(host.readPaths).not.toContain(TRANSCRIPT_OWN)
})

test('a session with no activity since its last read is not read again', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('Fix it') } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  const first = tailCalls(host).length
  expect(first).toBe(1)
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(tailCalls(host)).toHaveLength(first)
})

test('a transcript whose last line has no newline yet keeps that line for the next read', async ($: Engine, on) => {
  const whole = userLine('Fix it')
  const half = planLine('2026-11-02T10:19:00Z', [{ content: 'Half written', status: 'in_progress' }]).slice(0, -1)
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: whole + half } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).not.toContain('Half written')
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(tailCalls(host)[1]).toEqual(['tail', '-c', `+${new TextEncoder().encode(whole).length + 1}`, TRANSCRIPT_OWN])
})

test('a session\'s Earlier button opens its older events, stores the session under timelineOpen, and a second press removes the key', async ($: Engine, on) => {
  const steps = Array.from({ length: 7 }, (_, index) => ({ content: `Step ${index + 1}`, status: 'completed' }))
  const transcript = userLine('Fix it') + steps.map((step, index) => planLine(`2026-11-02T10:0${index}:00Z`, steps.slice(0, index + 1))).join('')
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: transcript } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  const key = `earlier-${SESSION_ID}`
  const closed = await mountPane($)
  const button = await closed.find({ type: 'Button', key })
  expect(button?.props.label).toMatch(/^▸ Earlier \(\d+\)$/)
  await closed.press({ key })
  await host.clock.settle()
  await closed.unmount()
  expect(host.store.get('timelineOpen')).toEqual([SESSION_ID])

  const opened = await mountPane($)
  expect((await opened.find({ type: 'Button', key }))?.props.label).toMatch(/^▾ Earlier/)
  await opened.press({ key })
  await host.clock.settle()
  await opened.unmount()
  expect(host.store.get('timelineOpen')).toBeUndefined()
})

// ---- condensed lines of long prompts (SPEC section 21, owner's review 2026-11-02) ----

const LONG_PROMPT = `1. Header Repository: /work/app · date: 2026-11-01 ${'context '.repeat(60)}`
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
// Answers every model call with this reply and records each request.
function stubModel(on: On, reply: { isAnswered: true; text: string } | { isAnswered: false; reason: string }): Array<{ model: string; prompt: string }> {
  const calls: Array<{ model: string; prompt: string }> = []
  on('model.complete', (_$, event) => {
    calls.push({ model: event.model, prompt: event.prompt })
    return {
      value: reply.isAnswered
        ? { isAnswered: true, text: reply.text, usage: NO_USAGE }
        : { isAnswered: false, reason: reply.reason, status: 500, error: 'api_error', usage: NO_USAGE },
    }
  })
  return calls
}

test('a long first prompt is condensed by Haiku once: its line replaces the cut prompt and only the line is stored', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine(LONG_PROMPT) } })
  const calls = stubModel(on, { isAnswered: true, text: 'Handoff: verify the beta.21 layout and ship beta.22' })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  await host.clock.settle()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.model).toBe('haiku')
  expect(await drawnPane($)).toContain('Handoff: verify the beta.21 layout and ship beta.22')
  const stored = JSON.stringify(host.store.get('briefs'))
  expect(stored).toContain('Handoff: verify the beta.21 layout')
  expect(stored).not.toContain('Header Repository')
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(calls).toHaveLength(1)
})

test('a stored condensed line is drawn with no model call', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine(LONG_PROMPT) } })
  host.store.set('briefs', { [OWN_RECORD.sessionId]: { text: 'Handoff: stored goal line', at: 1 } })
  const calls = stubModel(on, { isAnswered: true, text: 'never asked' })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).toContain('Handoff: stored goal line')
  expect(calls).toHaveLength(0)
})

test('a failed condensing keeps the cut prompt, is logged once by its reason, and is asked again after SUMMARY_RETRY_MS', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine(LONG_PROMPT) } })
  const calls = stubModel(on, { isAnswered: false, reason: 'api-error' })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(await drawnPane($)).toContain('1. Header Repository')
  expect(host.logs).toEqual(['keepaway: session brief failed (api-error)'])
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(calls).toHaveLength(1)
  await host.clock.advance(SUMMARY_RETRY_MS)
  await host.clock.settle()
  expect(calls).toHaveLength(2)
  expect(host.logs).toHaveLength(1)
})

test('a prompt that fits PROMPT_SHOWN_MAX is drawn whole and makes no model call', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('Fix the disk full error') } })
  const calls = stubModel(on, { isAnswered: true, text: 'never asked' })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(calls).toHaveLength(0)
  expect(await drawnPane($)).toContain('Fix the disk full error')
})

test('a refused transcript read is logged once by its name, keeps the other lines, and is not read again', async ($: Engine, on) => {
  const host = stubHost(on, { transcriptRefuses: true })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(host.logs).toHaveLength(1)
  expect(host.logs[0]).toMatch(/^keepaway: session summary failed \(\w+\)$/)
  expect(host.logs.join('\n')).not.toContain(TRANSCRIPT_OWN)
  expect(headCalls(host)).toHaveLength(1)
  expect(await drawnPane($)).not.toContain('Fix the disk full error')
  expect(await drawnPane($)).toContain('Fix disk full')
})

// ---- this window's decision and the milestone objective (Mock S deltas 8 and 9) ----

const OBJECTIVE = 'Preflight before install: refuse a full disk and a read-only mount, then install the store and check every write path again.'
// OBJECTIVE cut at the last space before 100 characters, the ellipsis counted (cutAtWord).
const OBJECTIVE_CUT = 'Preflight before install: refuse a full disk and a read-only mount, then install the store and…'

test('the window draws the newest "Decision:" comment as Decided, and the milestone description cut as its Objective (Mock S deltas 8 and 9)', async ($: Engine, on) => {
  const issueView = JSON.stringify({
    number: ISSUE,
    title: 'Synthetic issue',
    url: 'https://github.com/acme/app/issues/106',
    state: 'OPEN',
    milestone: { number: 23, title: 'Milestone B' },
    comments: [
      { author: { login: 'dev-one' }, authorAssociation: 'OWNER', createdAt: '2026-10-20T16:00:00Z', body: 'Decision: the old call' },
      { author: { login: 'rafa-tavares' }, authorAssociation: 'MEMBER', createdAt: '2026-10-20T17:00:00Z', body: 'Decisão: DISK_FULL also in backup_receipt' },
      { author: { login: 'dev-one' }, authorAssociation: 'OWNER', createdAt: '2026-10-20T18:00:00Z', body: 'a later comment that is no decision' },
      { author: { login: 'outsider' }, authorAssociation: 'NONE', createdAt: '2026-10-20T19:00:00Z', body: '**Decision:** spoofed call' },
    ],
  })
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 1, closed_issues: 0, due_on: null, description: OBJECTIVE }])
  const issues = JSON.stringify([{ number: 1, title: 'Open one', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/1', milestone: { number: 23 }, labels: [] }])
  const host = stubHost(on, { issueView, issues, milestones })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'issue 106', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  // The terminal draws each label and value as its own text node, so the heading and the value are checked apart.
  expect(drawn).toContain('"Decided:"')
  expect(drawn).toContain('DISK_FULL also in backup_receipt')
  expect(drawn).not.toContain('the old call')
  expect(drawn).toContain(`Objective: ${OBJECTIVE_CUT}`)
  expect(drawn).not.toContain(OBJECTIVE)
  await expectClean(host, $)
})

test('no decision comment and no description draw neither the Decided line nor the Objective line', async ($: Engine, on) => {
  const milestones = JSON.stringify([{ number: 23, title: 'Milestone B', open_issues: 1, closed_issues: 0, due_on: null, description: '  ' }])
  const issues = JSON.stringify([{ number: 1, title: 'Open one', updatedAt: '2026-10-20T16:00:00Z', url: 'https://github.com/acme/app/issues/1', milestone: { number: 23 }, labels: [] }])
  const host = stubHost(on, { issues, milestones })
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'issue 106', ...COMMAND_CONTEXT })
  await $.command.run({ command: 'keepaway', args: 'open', ...COMMAND_CONTEXT })
  await host.clock.settle()
  const drawn = await drawnPane($)
  expect(drawn).toContain('"Last comment:"')
  expect(drawn).not.toContain('"Decided:"')
  expect(drawn).not.toContain('Objective:')
  await expectClean(host, $)
})

// ---- a summary that is not final is read again after ten minutes, never stored (Mock S delta 7, the summary cache) ----

test('a transcript that is missing is not stored: it is read again after ten minutes, and its prompt then shows', async ($: Engine, on) => {
  const transcripts: Record<string, string> = {}
  const host = stubHost(on, { transcripts })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(1)
  expect(summaryKeys(host)).toHaveLength(0)
  expect(await drawnPane($)).not.toContain('Fix the disk full error')
  // The transcript appears after the session started: no read before the retry time, then the prompt is read and stored.
  transcripts[TRANSCRIPT_OWN] = userLine('Fix the disk full error')
  await host.clock.advance(SUMMARY_RETRY_MS - POLL_MS)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(1)
  await host.clock.advance(POLL_MS)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(2)
  expect(await drawnPane($)).toContain('Fix the disk full error')
  expect(summaryKeys(host)).toEqual([])
  await expectClean(host, $)
})

test('a transcript with no user line yet is not stored, and is read again after ten minutes', async ($: Engine, on) => {
  const transcripts: Record<string, string> = { [TRANSCRIPT_OWN]: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n` }
  const host = stubHost(on, { transcripts })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(summaryKeys(host)).toHaveLength(0)
  transcripts[TRANSCRIPT_OWN] = userLine('Fix the disk full error')
  await host.clock.advance(SUMMARY_RETRY_MS)
  await host.clock.settle()
  expect(headCalls(host).length).toBeGreaterThanOrEqual(2)
  expect(await drawnPane($)).toContain('Fix the disk full error')
  expect(summaryKeys(host)).toEqual([])
})

test('a user line with no usable text is final: it is kept for the window life, and the transcript is never read again', async ($: Engine, on) => {
  const host = stubHost(on, { transcripts: { [TRANSCRIPT_OWN]: userLine('<system-reminder>Context only</system-reminder>') } })
  await $.session.start(SESSION)
  await openPane($)
  await host.clock.settle()
  expect(summaryKeys(host)).toEqual([])
  await host.clock.advance(SUMMARY_RETRY_MS * 2)
  await host.clock.settle()
  expect(headCalls(host)).toHaveLength(1)
  expect(await drawnPane($)).not.toContain('Fix the disk full error')
})
