// The hooks module of the KeepTrack pane: the poll timer, the atoms the pane draws, the /keeptrack command and the close
// of the pane. The only module that calls $ (repo-work-pane-design-spec.md 3.3). The pure rules are in model.ts, the text in i18n.ts, and
// pane.tsx draws from the snapshot alone. Nothing here logs or stores a record's content, a remote URL or a title.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderSurface } from 'claude-code'

import { detectLang, resolveLang, t, type Lang, type LangEnv } from './i18n'
import { renderPane } from './pane'
import { renderBand, type BandIssue, type BandRepo } from './band'
import { heldButtons, type HeldButtons } from './held'
import { IDLE_TURN, bandRedrawDue, turnEnded, turnStarted, turnToolNamed } from './turn'
import {
  LABEL_MAX,
  NO_DESKTOP_GROUPS,
  RECORD_MAX_BYTES,
  TEXT_MAX,
  buildTree,
  groupIssues,
  isGithubHost,
  isSessionLinkId,
  issueFactsOf,
  mapLimited,
  newestCommentOf,
  parseDesktopGroups,
  parseRemote,
  plain,
  projectRecord,
  type DesktopGroups,
  type Remote,
} from './model'
import type {
  Issue,
  IssueDetails,
  IssueFacts,
  Milestone,
  PaneError,
  ProjectedRecord,
  PullRequest,
  SessionInput,
  SessionNode,
  Snapshot,
} from '../types'

const PANE = 'repo-work'
const COMMAND = 'keeptrack'
// The poll cadence while the pane is open (repo-work-pane-design-spec.md 2.5); KEEPTRACK_POLL_MS overrides it for tests.
const POLL_MS = 60_000
// The slow cadence while the pane is closed, which keeps the band's repo data fresh; KEEPTRACK_BAND_POLL_MS overrides it.
const BAND_POLL_MS = 300_000
// The band's own redraw tick: it redraws the elapsed and idle times between the events that change them (bandRedrawDue).
const BAND_TICK_MS = 30_000
// Both overrides are never below MIN_POLL_MS.
const MIN_POLL_MS = 1_000
// The band redraws for tool calls at most once per TOOL_REDRAW_MS (SPEC section 18).
const TOOL_REDRAW_MS = 1_000
// A session shows when it was active this recently, or when its branch has an open PR (repo-work-pane-design-spec.md D2).
const SESSION_CUTOFF_MS = 72 * 60 * 60 * 1000
const GH_TIMEOUT_MS = 15_000
const GIT_TIMEOUT_MS = 5_000
// The newest commits of a branch the timeline may draw (repo-work-pane-design-spec.md D6, SessionInput.commits).
const COMMIT_LIMIT = 5
// The limits of the three gh calls (repo-work-pane-design-spec.md D4); a result at the limit sets `truncated`.
const ISSUE_LIMIT = 500
const PR_LIMIT = 100
// The closing references read per PR; a PR that closes more links no issue, since its lowest is then not known (DL9).
const CLOSING_LIMIT = 50
// The largest gh answer parsed, in UTF-8 bytes: the engine's own stdout cut. An answer past it, or cut, is unreadable (SE3).
const GH_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
const ISSUE_NUMBER_MAX = 999_999
// The longest running tool name the band keeps (the main loop's tool, F11).
export const TOOL_NAME_MAX = 64
// The most Desktop files read per poll (askaway's DESKTOP_SCAN_MAX), the most candidate sessions git is asked about, and
// the most git calls in flight at once.
const DESKTOP_SCAN_MAX = 2000
const CANDIDATE_MAX = 64
const GIT_CONCURRENCY = 4
const MEMBERSHIP_SCAN_FACTOR = 4
// A poll not settled after this long is abandoned (F07): its flag is freed, so a newer poll may start. Its late result still writes
// unless a newer poll has written (R2-04). Every call has its own timeout (GH_TIMEOUT_MS, GIT_TIMEOUT_MS).
const POLL_DEADLINE_MS = 30_000
// The abandoned polls that may still run at once. Past this count the next poll is skipped with a log line, so a real hang
// cannot leak a promise chain every cadence.
const MAX_ABANDONED_POLLS = 2
// An override older than this is dropped on the next poll, as is one whose session no record lists (S6).
const OVERRIDE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const OVERRIDE_PREFIX = 'override:'
const LANG_KEY = 'lang'
// The depth of the Desktop records folder: root/<org>/<user>/<session>.json (checked on the local records).
const RECORD_FOLDER_DEPTH = 2
// A question id is used in a path under the askaway folder, so it must be a plain name.
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,128}$/
const ISSUE_FIELDS = 'number,title,milestone,labels,updatedAt,url'
// The open PRs with the issues they close and the last commit's checks (repo-work-pane-design-spec.md D4). gh 2.45 has no such JSON field.
const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PR_LIMIT}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title state headRefName url createdAt reviewDecision
        closingIssuesReferences(first: ${CLOSING_LIMIT}) { totalCount nodes { number } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`
const PR_STATES = ['OPEN', 'MERGED', 'CLOSED'] as const
const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const
const CHECK_STATES = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'] as const
// The /keeptrack language choices as typed (case does not matter); `auto` follows the environment.
const LANG_CHOICES: ReadonlyMap<string, Lang | 'auto'> = new Map<string, Lang | 'auto'>([
  ['en', 'en'],
  ['pt-br', 'pt'],
  ['auto', 'auto'],
])

// The drawn state the pane reads (PluginState in types/index.d.ts). The poll writes the snapshot; the handlers write the
// open flag and the language.
const snapshotAtom = atom({ plugin: 'keeptrack-repo-pane', key: 'snapshot' } as const, null as Snapshot | null)
const openAtom = atom({ plugin: 'keeptrack-repo-pane', key: 'open' } as const, false)
const langAtom = atom({ plugin: 'keeptrack-repo-pane', key: 'lang' } as const, 'en' as Lang)
// The main loop's turn, written by turn.start, tool.call, turn.complete and turn.abort: the band's status line reads it.
const turnAtom = atom({ plugin: 'keeptrack-repo-pane', key: 'turn' } as const, IDLE_TURN)
// The agents that have not ended, from $.agent.list(), and since when the current run of them began (readAgents).
type AgentRun = { count: number; since: number | null }
const agentRunAtom = atom({ plugin: 'keeptrack-repo-pane', key: 'agentRun' } as const, { count: 0, since: null } as AgentRun)
// The agent statuses that are still work: pending, running, and waiting on the background work it owns (AgentStatus).
const ACTIVE_AGENT_STATUSES: readonly string[] = ['pending', 'running', 'waiting']

// Module memory, never $.store: a file read cache (size and mtime), the git lookups, the last good gh data and the poll flag.
type Json = Readonly<Record<string, unknown>>
type Repo = Remote
type Entry = { path: string; size: number; mtimeMs: number }
// A file's projected value, kept while its size and mtime stay the same.
type Cached<T> = { size: number; mtimeMs: number; value: T }
type QuestionRef = { id: string; session: string; title: string }
type Timer = ReturnType<EngineInterface['clock']['every']>
type Commit = { at: number; subject: string }
type IssueComment = { author: string; at: number; body: string }
type GhOutcome = { ok: true; stdout: string; oversized: boolean } | { ok: false; error: PaneError }
type GithubMemory = {
  key: string
  milestones: Milestone[]
  issues: Issue[]
  prs: PullRequest[]
  issuesTruncated: boolean
  prsTruncated: boolean
}

let polling = false
// The poll sequence: a poll takes the next number when it starts. writtenSeq is the number of the last poll that wrote the snapshot;
// a result writes only while its number is above it, so a late poll never overwrites a newer one (R2-04, CR3).
let startedSeq = 0
let writtenSeq = 0
const isNewest = (seq: number): boolean => seq > writtenSeq
// The polls past their deadline that have not settled yet (at most MAX_ABANDONED_POLLS run at once).
let abandonedPolls = 0
// The agent reads started, and the number of the last one that wrote: a read that finishes after a newer one wrote is discarded.
let agentReadsStarted = 0
let agentReadsWritten = 0
// When the last poll started, failed or not: the cadence counts from it, so a failing poll is not repeated on each render (R2-03).
let attemptedAt = Number.NEGATIVE_INFINITY
// The window's poll timer (its cadence is pollerMs) and the tool-call redraw clock of the band.
let poller: Timer | undefined
let pollerMs = 0
let bandTick: Timer | undefined
let bandTicks = 0
let toolRedrawAt = Number.NEGATIVE_INFINITY
let toolRedrawPending = false
let recordCache = new Map<string, Cached<ProjectedRecord | null>>()
let questionCache = new Map<string, Cached<QuestionRef | null>>()
const remoteCache = new Map<string, Repo | null>()
const commonDirCache = new Map<string, string>()
let githubMemory: GithubMemory | null = null
// The repo context of the last poll that read it: a failed read keeps it (F02).
let lastRepoContext: RepoContext | null = null
// The Buttons the band drew last, per surface and request, so a redraw keeps their press handles (held.ts).
const heldTables = new Map<string, HeldButtons>()

// ---- small typed readers ----

const isJsonObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

const childOf = (value: unknown, key: string): unknown => (isJsonObject(value) ? value[key] : undefined)

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find(item => item === value) ?? null
}

// A JSON text as a value, or undefined when it is absent or does not parse.
function parseJsonText(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// ---- language and text ----

async function detectedLang($: EngineInterface): Promise<Lang> {
  const env: LangEnv = {
    LC_ALL: await $.env.get('LC_ALL'),
    LC_MESSAGES: await $.env.get('LC_MESSAGES'),
    LANG: await $.env.get('LANG'),
    LANGUAGE: await $.env.get('LANGUAGE'),
  }
  return detectLang(env)
}

async function currentLang($: EngineInterface): Promise<Lang> {
  return resolveLang(await $.store.get(LANG_KEY), await detectedLang($))
}

function logLine($: EngineInterface, text: string): void {
  $.ui.log(`keeptrack: ${text}`)
}

// A failure as the log carries it: its name only, since a message can carry a path or a URL.
const failureNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

// Runs a job the hook does not await; a failure is logged by its name only.
function report($: EngineInterface, job: Promise<unknown>): void {
  void job.catch((error: unknown) => logLine($, `poll failed (${failureNameOf(error)})`))
}

function heldFor(surface: RenderSurface, requestId: string): HeldButtons {
  const key = `${surface}:${requestId}`
  const known = heldTables.get(key)
  if (known !== undefined) return known
  const table = heldButtons()
  heldTables.set(key, table)
  return table
}

// ---- Desktop records and the askaway folder (read only) ----

// The records root: KEEPTRACK_DESKTOP_SESSIONS when set (tests), else the Desktop folder under HOME.
async function recordsRootOf($: EngineInterface): Promise<string | undefined> {
  const override = await $.env.get('KEEPTRACK_DESKTOP_SESSIONS')
  if (override) return override
  const home = await $.env.get('HOME')
  return home ? `${home}/.config/Claude/claude-code-sessions` : undefined
}

async function askawayFolderOf($: EngineInterface): Promise<string | undefined> {
  const custom = await $.env.get('ASKAWAY_HOME')
  if (custom) return custom
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/state/askaway` : undefined
}

// The Desktop config (claude_desktop_config.json) and its sidebar Groups, read as Askaway reads them: only when its mtime
// changes (the folder listing gives it). A file that is not there names no Group, and the tree groups by family. A file over
// DESKTOP_CONFIG_MAX_BYTES, one that cannot be read or parsed, or a folder whose listing fails keeps the last Groups read.
// No outcome is logged or toasted: a missing or odd config is normal, and the file also holds MCP settings. The cache is
// written only on a successful read.
const DESKTOP_CONFIG_MAX_BYTES = 4 * 1024 * 1024
let desktopConfigCache: { path: string; mtimeMs: number; groups: DesktopGroups } | undefined

// Forgets the cached config, so the next poll reads it again. The tests call it before each host starts.
export function resetDesktopConfigCache(): void {
  desktopConfigCache = undefined
}

async function desktopConfigPathOf($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.config/Claude/claude_desktop_config.json` : undefined
}

// The listing entry of a file in its folder, undefined when the file is not there. A failed listing rejects: that is an error,
// not an absent file.
async function desktopConfigEntryOf($: EngineInterface, path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  const slash = path.lastIndexOf('/')
  const entries = await $.fs.list(path.slice(0, slash))
  const entry = entries.find(one => one.kind === 'file' && one.name === path.slice(slash + 1))
  return entry === undefined ? undefined : { mtimeMs: entry.mtimeMs, size: entry.size }
}

const lastDesktopGroups = (): DesktopGroups => desktopConfigCache?.groups ?? NO_DESKTOP_GROUPS

async function readDesktopGroups($: EngineInterface): Promise<DesktopGroups> {
  try {
    const path = await desktopConfigPathOf($)
    const entry = path === undefined ? undefined : await desktopConfigEntryOf($, path)
    if (path === undefined || entry === undefined) {
      desktopConfigCache = undefined
      return NO_DESKTOP_GROUPS
    }
    if (desktopConfigCache?.path === path && desktopConfigCache.mtimeMs === entry.mtimeMs) return desktopConfigCache.groups
    if (entry.size > DESKTOP_CONFIG_MAX_BYTES) return lastDesktopGroups()
    const config = parseJsonText(await $.fs.read(path))
    if (config === undefined) return lastDesktopGroups()
    const groups = parseDesktopGroups(config)
    desktopConfigCache = { path, mtimeMs: entry.mtimeMs, groups }
    return groups
  } catch {
    return lastDesktopGroups()
  }
}

// The entries of a folder: [] when it does not exist, undefined when it exists and cannot be listed (the caller keeps
// what it knew). A folder the engine cannot check reads as present.
async function entriesOf($: EngineInterface, dir: string): Promise<FsEntry[] | undefined> {
  const entries = await $.fs.list(dir).catch(() => undefined)
  if (entries !== undefined) return entries
  return (await $.fs.exists(dir).catch(() => true)) ? undefined : []
}

type Listing = { entries: FsEntry[]; failed: boolean }

async function listingOf($: EngineInterface, dir: string): Promise<Listing> {
  const entries = await entriesOf($, dir)
  return entries === undefined ? { entries: [], failed: true } : { entries, failed: false }
}

const subfoldersOf = (entries: readonly FsEntry[]): FsEntry[] =>
  entries.filter(entry => entry.kind === 'dir' && !entry.isLink)

const isJsonName = (name: string): boolean => name.endsWith('.json')

// A session record is named local_<id>.json, with the id in the session link shape. Other files in the folder (scheduled-tasks.json,
// deleted_<id> tombstones) are not records: they are not read, counted or reported.
const isRecordName = (name: string): boolean => isJsonName(name) && isSessionLinkId(name.slice(0, -'.json'.length))

const filesOf = (entries: readonly FsEntry[], dir: string, keep: (name: string) => boolean): Entry[] =>
  entries
    .filter(entry => entry.kind === 'file' && !entry.isLink && keep(entry.name))
    .map(entry => ({ path: `${dir}/${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs }))

// The regular, non-link files whose name passes `keep`, `depth` folders below dir (0: dir itself). A folder that cannot be listed
// marks the result failed.
async function filesUnder(
  $: EngineInterface,
  dir: string,
  depth: number,
  keep: (name: string) => boolean,
): Promise<{ files: Entry[]; failed: boolean }> {
  const listing = await listingOf($, dir)
  if (depth === 0) return { files: filesOf(listing.entries, dir, keep), failed: listing.failed }
  const parts = await Promise.all(
    subfoldersOf(listing.entries).map(child => filesUnder($, `${dir}/${child.name}`, depth - 1, keep)),
  )
  return {
    files: parts.flatMap(part => part.files),
    failed: listing.failed || parts.some(part => part.failed),
  }
}

// The projected value of each file, from the cache when its size and mtime have not changed; the new cache keeps only these
// files. A file that could not be read is not cached, so it is read again on the next poll (W3).
async function cachedValues<T>(
  $: EngineInterface,
  files: readonly Entry[],
  cache: ReadonlyMap<string, Cached<T>>,
  project: (value: unknown) => T,
): Promise<{ values: T[]; kept: Map<string, Cached<T>> }> {
  const kept = new Map<string, Cached<T>>()
  const values: T[] = []
  for (const file of files) {
    const hit = cache.get(file.path)
    if (hit !== undefined && hit.size === file.size && hit.mtimeMs === file.mtimeMs) {
      kept.set(file.path, hit)
      values.push(hit.value)
      continue
    }
    const text = await $.fs.read(file.path).catch(() => undefined)
    const value = project(parseJsonText(text))
    if (text !== undefined) kept.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, value })
    values.push(value)
  }
  return { values, kept }
}

// `complete` is false when any file did not become a record: skipped for size, past the cap, unreadable or half-written, or in a
// folder that could not be listed. Only a complete scan may prune overrides (R2-01).
type RecordScan = { records: ProjectedRecord[]; unreadable: number; complete: boolean }

// The projected Desktop records under the root. A file over RECORD_MAX_BYTES is skipped before it is read.
async function scanRecords($: EngineInterface, root: string | undefined): Promise<RecordScan> {
  if (root === undefined) return { records: [], unreadable: 0, complete: false }
  const listing = await filesUnder($, root, RECORD_FOLDER_DEPTH, isRecordName)
  const sized = listing.files.filter(file => file.size <= RECORD_MAX_BYTES).slice(0, DESKTOP_SCAN_MAX)
  const { values, kept } = await cachedValues($, sized, recordCache, projectRecord)
  recordCache = kept
  return {
    records: values.filter(isPresent),
    unreadable: values.filter(item => item === null).length,
    complete: !listing.failed && sized.length === listing.files.length && values.every(isPresent),
  }
}

// The open askaway question of each Desktop session, by session id: its title (repo-work-pane-design-spec.md D5, D7). A question is open when
// its q/<id>.json has no a/<id>.json yet; desktop_session holds the local_ session id. A missing folder is no question.
async function blockersOf($: EngineInterface): Promise<Map<string, string>> {
  const blockers = new Map<string, string>()
  const folder = await askawayFolderOf($)
  if (folder === undefined) return blockers
  const listing = await filesUnder($, `${folder}/q`, 0, isJsonName)
  const sized = listing.files.filter(file => file.size <= RECORD_MAX_BYTES).slice(0, DESKTOP_SCAN_MAX)
  const { values, kept } = await cachedValues($, sized, questionCache, questionRefOf)
  questionCache = kept
  for (const question of values) {
    if (question === null || blockers.has(question.session)) continue
    const answered = await $.fs.exists(`${folder}/a/${question.id}.json`).catch(() => true)
    if (!answered) blockers.set(question.session, question.title)
  }
  return blockers
}

function questionRefOf(value: unknown): QuestionRef | null {
  const id = textOf(childOf(value, 'id'))
  const session = textOf(childOf(value, 'desktop_session'))
  const title = plain(textOf(childOf(value, 'title')) ?? '', TEXT_MAX)
  if (id === null || !QUESTION_ID.test(id) || session === null || !isSessionLinkId(session)) return null
  return { id, session, title }
}

// An override's time is live when it is a time from 0 up to now and no older than OVERRIDE_TTL_MS (SPEC 13); any other value is expired.
const overrideTimeLive = (ts: number | null, now: number): ts is number =>
  ts !== null && ts >= 0 && ts <= now && now - ts <= OVERRIDE_TTL_MS

// Drops the overrides with no time or a negative one, those set over OVERRIDE_TTL_MS ago (S6), and those whose session no listed
// record names. The clock is read here, not at the poll's start, so an override stamped during the poll is kept (F21). Called only
// with a complete scan, so a folder that could not be read never costs an override.
async function pruneOverrides($: EngineInterface, sessionIds: ReadonlySet<string>): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(OVERRIDE_PREFIX)) continue
    const ts = numberOf(childOf(await $.store.get(key), 'ts'))
    const expired = ts === null || ts < 0 || now - ts > OVERRIDE_TTL_MS
    if (expired || !sessionIds.has(key.slice(OVERRIDE_PREFIX.length))) await $.store.delete(key)
  }
}

// The issue overrides, from the store keys `override:<sessionId>` (repo-work-pane-design-spec.md 2.6).
async function overridesOf($: EngineInterface, now: number): Promise<Map<string, number>> {
  const overrides = new Map<string, number>()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(OVERRIDE_PREFIX)) continue
    const sessionId = key.slice(OVERRIDE_PREFIX.length)
    const value = await $.store.get(key)
    const issue = issueOfOverride(value)
    if (isSessionLinkId(sessionId) && issue !== null && overrideTimeLive(numberOf(childOf(value, 'ts')), now)) {
      overrides.set(sessionId, issue)
    }
  }
  return overrides
}

function issueOfOverride(value: unknown): number | null {
  return issueNumberOf(childOf(value, 'issue'))
}

// An issue number of 1 to ISSUE_NUMBER_MAX, else null.
function issueNumberOf(value: unknown): number | null {
  const number = numberOf(value)
  return number !== null && Number.isInteger(number) && number >= 1 && number <= ISSUE_NUMBER_MAX ? number : null
}

// ---- git (read only) ----

type GitRun = { exitCode: number; stdout: string; stderr: string }

// One git call's result, or null when it cannot start or times out.
async function gitRun($: EngineInterface, args: readonly string[]): Promise<GitRun | null> {
  try {
    return await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
  } catch {
    return null
  }
}

// Whether git says the folder is definitely not a repository: exit 128 with its not-a-repository message, or a `-C` folder that does
// not exist. Any other failure is a git failure, which the caller asks again on the next poll.
function notARepository(run: GitRun): boolean {
  return run.exitCode === 128 && /not a git repository|cannot change to .*No such file or directory/.test(run.stderr)
}

// The trimmed standard output of a git call, or null when it fails or cannot start.
async function gitOut($: EngineInterface, args: readonly string[]): Promise<string | null> {
  const run = await gitRun($, args)
  return run !== null && run.exitCode === 0 ? run.stdout.trim() : null
}

// The absolute common git dir of a working copy, cached once found. `ok` is false when git did not answer; `dir` is null with `ok`
// true when the folder is definitely not a repository.
async function commonDirOfCwd($: EngineInterface, cwd: string): Promise<{ ok: boolean; dir: string | null }> {
  const cached = commonDirCache.get(cwd)
  if (cached !== undefined) return { ok: true, dir: cached }
  const run = await gitRun($, ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (run !== null && notARepository(run)) return { ok: true, dir: null }
  const found = run !== null && run.exitCode === 0 ? run.stdout.trim() : ''
  if (!found.startsWith('/')) return { ok: false, dir: null }
  commonDirCache.set(cwd, found)
  return { ok: true, dir: found }
}

// The URL of a repo's remote, read with `repoArgs` (`-C <root>` or `--git-dir <dir>`): origin, or when the repo has none, the first
// remote git lists (a repo whose only remote is `github`). `ok` is false when git could not answer, so the caller asks again (W3).
async function remoteUrlOf($: EngineInterface, repoArgs: readonly string[]): Promise<{ ok: boolean; url: string | null }> {
  const origin = await gitRun($, [...repoArgs, 'remote', 'get-url', 'origin'])
  if (origin === null) return { ok: false, url: null }
  if (origin.exitCode === 0) return { ok: true, url: origin.stdout.trim() }
  // Not a repository (for example a stale common dir of a Desktop record): a definite answer, with no remote.
  if (notARepository(origin)) return { ok: true, url: null }
  if (!/No such remote/i.test(origin.stderr)) return { ok: false, url: null }
  const listed = await gitOut($, [...repoArgs, 'remote'])
  if (listed === null) return { ok: false, url: null }
  const name = listed.split('\n')[0]?.trim() ?? ''
  if (name === '') return { ok: true, url: null }
  const named = await gitRun($, [...repoArgs, 'remote', 'get-url', name])
  return named !== null && named.exitCode === 0 ? { ok: true, url: named.stdout.trim() } : { ok: false, url: null }
}

// The host, owner and name of the remote of a common git dir (repo-work-pane-design-spec.md D2b). Only a definite answer is cached: a
// remote, or none; a failed call is asked again on the next poll (W3).
async function remoteOf($: EngineInterface, commonDir: string): Promise<Repo | null | undefined> {
  const cached = remoteCache.get(commonDir)
  if (cached !== undefined) return cached
  const found = await remoteUrlOf($, ['--git-dir', commonDir])
  if (!found.ok) return undefined
  const remote = parseRemote(found.url)
  remoteCache.set(commonDir, remote)
  return remote
}

// The checked-out branch: null for a detached HEAD and for a folder that is not a repository. `failed` when git could not answer for
// the working copy. The full ref is read, not a short name: a tag named like the branch would shorten it to heads/<name>.
async function branchOf($: EngineInterface, cwd: string): Promise<{ branch: string | null; failed: boolean }> {
  const run = await gitRun($, ['-C', cwd, 'symbolic-ref', '--quiet', 'HEAD'])
  if (run !== null && notARepository(run)) return { branch: null, failed: false }
  // Exit 1 with no stderr is a detached HEAD: no branch, and not a failure.
  if (run !== null && run.exitCode === 1 && run.stderr.trim() === '') return { branch: null, failed: false }
  const ref = run !== null && run.exitCode === 0 ? run.stdout.trim() : null
  if (ref === null) return { branch: null, failed: true }
  const branch = ref.replace(/^refs\/heads\//, '')
  return { branch: branch === '' ? null : branch, failed: false }
}

// The newest commits of a branch, none when it is the default branch or git cannot tell which that is (repo-work-pane-design-spec.md D6).
async function commitsOf($: EngineInterface, cwd: string, branch: string): Promise<Commit[]> {
  const origin = await gitOut($, ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (origin === null || origin.replace(/^origin\//, '') === branch) return []
  // Not trimmed: a commit with an empty subject ends in its tab, and trimming would drop it (parseCommits needs the tab).
  const run = await gitRun($, ['-C', cwd, 'log', `-${COMMIT_LIMIT}`, '--format=%ct%x09%s'])
  return run !== null && run.exitCode === 0 ? parseCommits(run.stdout) : []
}

// Lines of `%ct<TAB>%s`: epoch seconds, then the subject (which may hold tabs of its own).
function parseCommits(text: string): Commit[] {
  return text.split('\n').flatMap(line => {
    const tab = line.indexOf('\t')
    const seconds = Number(line.slice(0, Math.max(tab, 0)))
    return tab > 0 && Number.isFinite(seconds) ? [{ at: seconds * 1000, subject: plain(line.slice(tab + 1), TEXT_MAX) }] : []
  })
}

// ---- repo and sessions ----

type RepoContext = { root: string | null; repo: Repo | null; rootCommonDir: string | null }

// The GitHub repo of this window: its origin when the origin is on GitHub (github.com or an alias that names it), else none.
// null when the engine or git could not answer: that is unknown, not a definite no-remote, and the caller keeps the last context (F02).
async function repoContextOf($: EngineInterface): Promise<RepoContext | null> {
  const info = await $.session.repo().catch(() => null)
  if (info === null) return null
  const root = info.root ?? null
  // The engine names the origin only: a repo without one is read from its first remote.
  let url = info.remote ?? null
  if (url === null && root !== null) {
    const read = await remoteUrlOf($, ['-C', root])
    if (!read.ok) return null
    url = read.url
  }
  const remote = parseRemote(url)
  const repo = remote !== null && isGithubHost(remote.host) ? remote : null
  if (repo !== null || root === null) return { root, repo, rootCommonDir: null }
  const rootCommonDir = (await commonDirOfCwd($, root)).dir
  return rootCommonDir === null ? null : { root, repo, rootCommonDir }
}

// The same host (lower case, as parseRemote gives it), owner and name, case-insensitively.
const sameRepo = (left: Repo, right: Repo): boolean =>
  left.host === right.host &&
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase()

// Whether a record belongs to this repo (repo-work-pane-design-spec.md D2b): its common git dir's origin names this repo. With no GitHub
// remote, the common dir must be the root's. `unknown` when git could not answer: the record stays for this poll (F04).
// `other` when the folder is definitely not a repository.
type Membership = 'member' | 'other' | 'unknown'

async function membershipOf($: EngineInterface, record: ProjectedRecord, context: RepoContext): Promise<Membership> {
  const known = record.commonDir !== null || record.cwd === null ? { ok: true, dir: record.commonDir } : await commonDirOfCwd($, record.cwd)
  if (!known.ok) return 'unknown'
  if (known.dir === null) return 'other'
  const commonDir = known.dir
  if (context.repo === null) return commonDir === context.rootCommonDir ? 'member' : 'other'
  const remote = await remoteOf($, commonDir)
  if (remote === undefined) return 'unknown'
  return remote !== null && sameRepo(remote, context.repo) ? 'member' : 'other'
}

type Candidate = { record: ProjectedRecord; branch: string | null; gitFailed: boolean }

// This window's record always, then the other live records of this repo by newest activity: the membership of the newest
// MEMBERSHIP_SCAN_FACTOR * CANDIDATE_MAX of them is checked, a bounded number of git calls (repo-work-pane-design-spec.md D2, D2b).
// Archived records are neither matched nor counted (F05).
async function memberRecordsOf(
  $: EngineInterface,
  records: readonly ProjectedRecord[],
  context: RepoContext,
  thisId: string | null,
): Promise<{ records: ProjectedRecord[]; membershipFailed: boolean }> {
  const thisRecords = records.filter(record => record.cliSessionId === thisId)
  const others = records
    .filter(record => record.cliSessionId !== thisId && !record.isArchived)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const scanned = others.slice(0, CANDIDATE_MAX * MEMBERSHIP_SCAN_FACTOR)
  const verdicts = await mapLimited(scanned, GIT_CONCURRENCY, record => membershipOf($, record, context))
  return {
    records: [...thisRecords, ...scanned.filter((_, index) => verdicts[index] !== 'other')],
    membershipFailed: verdicts.includes('unknown'),
  }
}

// The candidates the poll keeps: this window's, the newest CANDIDATE_MAX - 1 others, and every other whose branch has an open PR,
// among the membership scan window (repo-work-pane-design-spec.md 3.8 and 16). The branches are read first, so the PR test can see them (R2-09).
function admittedOf(entries: readonly Candidate[], openBranches: ReadonlySet<string>, thisId: string | null): Candidate[] {
  const own = entries.filter(entry => entry.record.cliSessionId === thisId)
  const room = CANDIDATE_MAX - own.length
  const kept = entries
    .filter(entry => entry.record.cliSessionId !== thisId)
    .filter((entry, index) => index < room || (entry.branch !== null && openBranches.has(entry.branch)))
  return [...own, ...kept]
}

// The context ancestors of the admitted sessions: every scanned record up their parent chains, in any state, that is not
// admitted itself (an admitted one is walked through). They only link and group the tree: no git call and no read for them.
function ancestorsOf(admitted: readonly ProjectedRecord[], records: readonly ProjectedRecord[]): ProjectedRecord[] {
  const byId = new Map(records.map(record => [record.sessionId, record]))
  const admittedIds = new Set(admitted.map(record => record.sessionId))
  const parentOf = (record: ProjectedRecord): ProjectedRecord | undefined =>
    record.parentId === null ? undefined : byId.get(record.parentId)
  const seen = new Set<string>()
  const ancestors: ProjectedRecord[] = []
  for (const record of admitted) {
    for (let parent = parentOf(record); parent !== undefined && !seen.has(parent.sessionId); parent = parentOf(parent)) {
      seen.add(parent.sessionId)
      if (!admittedIds.has(parent.sessionId)) ancestors.push(parent)
    }
  }
  return ancestors
}

// The branch of each candidate.
async function withBranches($: EngineInterface, records: readonly ProjectedRecord[]): Promise<Candidate[]> {
  return mapLimited(records, GIT_CONCURRENCY, async (record): Promise<Candidate> => {
    const { cwd } = record
    if (cwd === null) return { record, branch: null, gitFailed: false }
    const head = await branchOf($, cwd)
    return { record, branch: head.branch, gitFailed: head.failed }
  })
}

type TreeInputs = {
  now: number
  thisId: string | null
  prsByBranch: ReadonlyMap<string, PullRequest>
  overrides: ReadonlyMap<string, number>
  blockers: ReadonlyMap<string, string>
  issueFacts: ReadonlyMap<number, IssueFacts>
  // The records up the candidates' parent chains that are not listed, and the Desktop sidebar Groups.
  ancestors: readonly ProjectedRecord[]
  desktopGroups: DesktopGroups
}

function inputOf(entry: Candidate, inputs: TreeInputs, commits: ReadonlyMap<string, Commit[]>): SessionInput {
  const { record, branch } = entry
  return {
    ...record,
    branch,
    pr: branch === null ? null : (inputs.prsByBranch.get(branch) ?? null),
    override: inputs.overrides.get(record.sessionId) ?? null,
    waiting: inputs.blockers.has(record.sessionId),
    commits: commits.get(record.sessionId) ?? [],
  }
}

function treeOf(
  entries: readonly Candidate[],
  inputs: TreeInputs,
  commits: ReadonlyMap<string, Commit[]>,
): SessionNode[] {
  return buildTree(entries.map(entry => inputOf(entry, inputs, commits)), {
    now: inputs.now,
    cutoffMs: SESSION_CUTOFF_MS,
    thisCliSessionId: inputs.thisId,
    issueFacts: inputs.issueFacts,
    ancestors: inputs.ancestors,
    desktopGroups: inputs.desktopGroups,
  })
}

function flattenNodes(nodes: readonly SessionNode[]): SessionNode[] {
  return nodes.flatMap(node => [node, ...flattenNodes(node.children)])
}

// The commits of each kept session: only the sessions the tree keeps cost git calls (repo-work-pane-design-spec.md 2.1 step 4).
async function commitsOfKept(
  $: EngineInterface,
  entries: readonly Candidate[],
  keptIds: ReadonlySet<string>,
): Promise<Map<string, Commit[]>> {
  const pairs = await mapLimited(
    entries.filter(entry => keptIds.has(entry.record.sessionId)),
    GIT_CONCURRENCY,
    async entry => {
      const { cwd } = entry.record
      const commits = cwd === null || entry.branch === null ? [] : await commitsOf($, cwd, entry.branch)
      return [entry.record.sessionId, commits] as const
    },
  )
  return new Map(pairs)
}

type SessionsOutcome = {
  nodes: SessionNode[]
  gitFailed: boolean
  unreadable: number
  // The commits of each kept session (newest first) and the open askaway question of each waiting session.
  commits: ReadonlyMap<string, Commit[]>
  blockers: ReadonlyMap<string, string>
}

// The session tree of this repo (repo-work-pane-design-spec.md 2.1 steps 2 to 5). The first tree decides which sessions are kept, so the
// commits are read only for those; the second tree adds them.
async function sessionsOf(
  $: EngineInterface,
  context: RepoContext,
  github: GithubPart,
  now: number,
  thisId: string | null,
  seq: number,
): Promise<SessionsOutcome> {
  const scan = await scanRecords($, await recordsRootOf($))
  if (scan.complete && isNewest(seq)) await pruneOverrides($, new Set(scan.records.map(record => record.sessionId)))
  const members = await memberRecordsOf($, scan.records, context, thisId)
  const candidates = admittedOf(await withBranches($, members.records), new Set(github.prs.map(pr => pr.headRefName)), thisId)
  const blockers = await blockersOf($)
  const inputs: TreeInputs = {
    now,
    thisId,
    prsByBranch: pullRequestsByBranch(github.prs),
    overrides: await overridesOf($, now),
    blockers,
    issueFacts: issueFactsOf(github.milestones, github.issues),
    ancestors: ancestorsOf(candidates.map(entry => entry.record), scan.records),
    desktopGroups: await readDesktopGroups($),
  }
  const keptIds = new Set(flattenNodes(treeOf(candidates, inputs, new Map())).map(node => node.id))
  const commits = await commitsOfKept($, candidates, keptIds)
  return {
    nodes: treeOf(candidates, inputs, commits),
    gitFailed: members.membershipFailed || candidates.some(entry => entry.gitFailed),
    unreadable: scan.unreadable,
    commits,
    blockers,
  }
}

// The first PR of each branch, in the order gh lists them (most recently updated first).
function pullRequestsByBranch(prs: readonly PullRequest[]): Map<string, PullRequest> {
  const byBranch = new Map<string, PullRequest>()
  for (const pr of prs) if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr)
  return byBranch
}

// ---- gh: the three calls of repo-work-pane-design-spec.md D4 ----

const slugOf = (repo: Repo): string => `${repo.owner}/${repo.name}`

// gh that cannot start (ENOENT) is missing; the engine's timeout is a timeout. Any other failure is gh-failed (F03).
function ghStartError(error: unknown): PaneError {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/timed? ?out|timeout/i.test(text)) return 'gh-timeout'
  if (/ENOENT|not found|cannot start|spawn/i.test(text)) return 'gh-missing'
  return 'gh-failed'
}

// gh that ran and failed: a rate limit or a login problem has its own line; anything else is gh-failed (F03).
function ghExitError(stderr: string): PaneError {
  if (/rate limit/i.test(stderr)) return 'gh-rate-limit'
  if (/not logged|auth login|authentication/i.test(stderr)) return 'gh-auth'
  return 'gh-failed'
}

async function runGh($: EngineInterface, argv: readonly string[], cwd: string): Promise<GhOutcome> {
  try {
    const run = await $.process.run(['gh', ...argv], { cwd, timeoutMs: GH_TIMEOUT_MS })
    if (run.exitCode !== 0) return { ok: false, error: ghExitError(run.stderr) }
    const oversized = run.isStdoutTruncated || new TextEncoder().encode(run.stdout).byteLength > GH_OUTPUT_MAX_BYTES
    return { ok: true, stdout: run.stdout, oversized }
  } catch (error) {
    return { ok: false, error: ghStartError(error) }
  }
}

// One gh call: its parsed value, or undefined when it failed or answered with something unreadable: an oversized answer is
// never parsed (SE3).
async function fetchPart<T>(
  $: EngineInterface,
  argv: readonly string[],
  cwd: string,
  parse: (text: string) => T | null,
  errors: Set<PaneError>,
): Promise<T | undefined> {
  const outcome = await runGh($, argv, cwd)
  if (!outcome.ok) {
    errors.add(outcome.error)
    logLine($, `gh ${argv[0] ?? ''} call failed`)
    return undefined
  }
  const parsed = outcome.oversized ? null : parse(outcome.stdout)
  if (parsed === null) {
    errors.add('gh-failed')
    logLine($, `gh ${argv[0] ?? ''} answer not readable`)
  }
  return parsed ?? undefined
}

function milestoneOf(raw: unknown): Milestone | null {
  const number = numberOf(childOf(raw, 'number'))
  const rawTitle = textOf(childOf(raw, 'title'))
  const title = rawTitle === null ? null : plain(rawTitle, LABEL_MAX)
  const openIssues = numberOf(childOf(raw, 'open_issues'))
  const closedIssues = numberOf(childOf(raw, 'closed_issues'))
  if (number === null || title === null || openIssues === null || closedIssues === null) return null
  return { number, title, openIssues, closedIssues, dueOn: textOf(childOf(raw, 'due_on')) }
}

function parseMilestones(text: string): Milestone[] | null {
  const value = parseJsonText(text)
  return Array.isArray(value) ? value.map(milestoneOf).filter(isPresent) : null
}

// The names of a list field of gh's JSON (labels by name, assignees by login).
function namesOf(value: unknown, field: string): string[] {
  return asArray(value).flatMap(item => {
    const name = textOf(childOf(item, field))
    return name === null ? [] : [plain(name, LABEL_MAX)]
  })
}

function issueOf(raw: unknown): Issue | null {
  const number = numberOf(childOf(raw, 'number'))
  const title = textOf(childOf(raw, 'title'))
  const updatedAt = textOf(childOf(raw, 'updatedAt'))
  const url = textOf(childOf(raw, 'url'))
  if (number === null || title === null || updatedAt === null || url === null) return null
  return {
    number,
    title: plain(title, TEXT_MAX),
    milestone: numberOf(childOf(childOf(raw, 'milestone'), 'number')),
    labels: namesOf(childOf(raw, 'labels'), 'name'),
    updatedAt,
    url,
  }
}

// The issues of the list answer and the count of items that did not read (RB1-5). null when it is no list, or when no item of a
// non-empty list reads: that answer is as unreadable as text that does not parse.
type IssuePage = { issues: Issue[]; dropped: number }

function parseIssues(text: string): IssuePage | null {
  const value = parseJsonText(text)
  if (!Array.isArray(value)) return null
  const issues = value.map(issueOf).filter(isPresent)
  if (value.length > 0 && issues.length === 0) return null
  return { issues, dropped: value.length - issues.length }
}

// The issue numbers a list of nodes names: `closingIssuesReferences` and the like.
function nodeNumbersOf(value: unknown): number[] {
  return asArray(childOf(value, 'nodes')).flatMap(node => {
    const number = numberOf(childOf(node, 'number'))
    return number === null ? [] : [number]
  })
}

// The issues a PR closes; none when GitHub holds more than the page read, since the lowest of a partial page may not be the
// lowest (DL9): the session then maps by its next signal (repo-work-pane-design-spec.md D1).
function closingIssuesOf(references: unknown): number[] {
  const total = numberOf(childOf(references, 'totalCount'))
  return total !== null && total > CLOSING_LIMIT ? [] : nodeNumbersOf(references)
}

function checksOf(commits: unknown): PullRequest['checks'] {
  const [head] = asArray(childOf(commits, 'nodes'))
  return oneOf(childOf(childOf(childOf(head, 'commit'), 'statusCheckRollup'), 'state'), CHECK_STATES)
}

function pullRequestOf(raw: unknown): PullRequest | null {
  const number = numberOf(childOf(raw, 'number'))
  const title = textOf(childOf(raw, 'title'))
  const headRefName = textOf(childOf(raw, 'headRefName'))
  const url = textOf(childOf(raw, 'url'))
  const createdAt = textOf(childOf(raw, 'createdAt'))
  const state = oneOf(childOf(raw, 'state'), PR_STATES)
  if (number === null || title === null || headRefName === null || url === null || createdAt === null || state === null) {
    return null
  }
  return {
    number,
    title: plain(title, TEXT_MAX),
    state,
    headRefName,
    url,
    createdAt,
    reviewDecision: oneOf(childOf(raw, 'reviewDecision'), REVIEW_DECISIONS),
    closes: closingIssuesOf(childOf(raw, 'closingIssuesReferences')),
    checks: checksOf(childOf(raw, 'commits')),
  }
}

type PullRequestPage = { prs: PullRequest[]; total: number }

// The PR page of the GraphQL answer: data.repository.pullRequests.
function parsePullRequestPage(text: string): PullRequestPage | null {
  const pulls = childOf(childOf(childOf(parseJsonText(text), 'data'), 'repository'), 'pullRequests')
  if (!isJsonObject(pulls)) return null
  return {
    prs: asArray(pulls.nodes).map(pullRequestOf).filter(isPresent),
    total: numberOf(pulls.totalCount) ?? 0,
  }
}

// ---- gh: this window's issue (repo-work-pane-design-spec.md D5) ----

const ISSUE_VIEW_FIELDS = 'number,title,url,state,milestone,comments'

type IssueView = {
  number: number
  title: string
  url: string
  state: IssueDetails['state']
  milestoneTitle: string | null
  // Only the newest comment is kept, the one the pane draws (SE3).
  lastComment: IssueDetails['lastComment']
}

// One comment of `gh issue view --json comments`: its login, its time and its body; null when the time does not parse.
function commentOf(raw: unknown): IssueComment | null {
  const at = Date.parse(textOf(childOf(raw, 'createdAt')) ?? '')
  if (!Number.isFinite(at)) return null
  const author = plain(textOf(childOf(childOf(raw, 'author'), 'login')) ?? '', LABEL_MAX)
  return { author, at, body: textOf(childOf(raw, 'body')) ?? '' }
}

function issueViewOf(text: string): IssueView | null {
  const raw = parseJsonText(text)
  const number = numberOf(childOf(raw, 'number'))
  const title = textOf(childOf(raw, 'title'))
  const url = textOf(childOf(raw, 'url'))
  const state = textOf(childOf(raw, 'state'))
  if (number === null || title === null || url === null || state === null) return null
  return {
    number,
    title: plain(title, TEXT_MAX),
    url,
    state: state.toUpperCase() === 'OPEN' ? 'open' : 'closed',
    milestoneTitle: plain(textOf(childOf(childOf(raw, 'milestone'), 'title')) ?? '', LABEL_MAX) || null,
    lastComment: newestCommentOf(asArray(childOf(raw, 'comments')).map(commentOf).filter(isPresent)),
  }
}

// What the pane shows of this window's issue beside the issue view: its branch, its open PR, its last commit, its blocker.
type WindowFacts = {
  node: SessionNode
  pr: PullRequest | null
  lastCommit: Commit | null
  blockedBy: string | null
}

function detailsOf(view: IssueView, facts: WindowFacts): IssueDetails {
  const pr = facts.pr
  return {
    number: view.number,
    title: view.title,
    url: view.url,
    state: view.state,
    milestoneTitle: view.milestoneTitle,
    branch: facts.node.branch,
    pr:
      pr === null
        ? null
        : { number: pr.number, title: pr.title, state: pr.state, reviewDecision: pr.reviewDecision, url: pr.url },
    lastCommit: facts.lastCommit,
    checks: null,
    lastComment: view.lastComment,
    blockedBy: facts.blockedBy,
    startedAt: facts.node.createdAt,
  }
}

type WindowIssue = { details: IssueDetails | null; stale: boolean; errors: PaneError[] }

const NO_WINDOW_ISSUE: WindowIssue = { details: null, stale: false, errors: [] }

// This window's issue, by one gh call for its number (the same timeout and error mapping as the others). A failed call
// keeps no details and sets stale; the sessions never depend on it.
async function windowIssueOf($: EngineInterface, root: string, repo: Repo, facts: WindowFacts): Promise<WindowIssue> {
  const issue = facts.node.issue
  if (issue === null) return NO_WINDOW_ISSUE
  const errors = new Set<PaneError>()
  const argv = ['issue', 'view', String(issue.number), '--repo', slugOf(repo), '--json', ISSUE_VIEW_FIELDS]
  const view = await fetchPart($, argv, root, issueViewOf, errors)
  return view === undefined
    ? { details: null, stale: true, errors: [...errors] }
    : { details: detailsOf(view, facts), stale: false, errors: [] }
}

// The window's issue facts when its session is in this GitHub repo's tree; no call otherwise.
async function windowIssueFor(
  $: EngineInterface,
  context: RepoContext,
  github: GithubPart,
  sessions: SessionsOutcome,
): Promise<WindowIssue> {
  const node = flattenNodes(sessions.nodes).find(candidate => candidate.isThisWindow)
  const { repo, root } = context
  if (node === undefined || repo === null || root === null) return NO_WINDOW_ISSUE
  const pr = node.branch === null ? null : (github.prs.find(candidate => candidate.headRefName === node.branch) ?? null)
  const lastCommit = sessions.commits.get(node.id)?.[0] ?? null
  return windowIssueOf($, root, repo, { node, pr, lastCommit, blockedBy: sessions.blockers.get(node.id) ?? null })
}

type GithubPart = {
  milestones: Milestone[]
  issues: Issue[]
  prs: PullRequest[]
  truncatedLimits: number[]
  stale: boolean
  errors: PaneError[]
}

const emptyGithub = (): GithubPart => ({ milestones: [], issues: [], prs: [], truncatedLimits: [], stale: false, errors: [] })

// The memory of the last good gh data for this repo; a new repo starts empty.
function memoryFor(key: string): GithubMemory {
  if (githubMemory?.key !== key) {
    githubMemory = { key, milestones: [], issues: [], prs: [], issuesTruncated: false, prsTruncated: false }
  }
  return githubMemory
}

// The milestones, the open issues and the open PRs (repo-work-pane-design-spec.md D4). A call that fails keeps the last good data of its part
// and sets `stale`; the sessions never depend on it.
// Keeps the parts a gh call answered; a part that failed keeps its last good data (F13).
function rememberGithub(
  memory: GithubMemory,
  milestones: Milestone[] | undefined,
  issues: IssuePage | undefined,
  page: PullRequestPage | undefined,
): void {
  if (milestones !== undefined) memory.milestones = milestones
  if (issues !== undefined) {
    // gh is asked for one more than ISSUE_LIMIT: only that extra item marks the list partial, a dropped one included (RB1-5).
    memory.issues = issues.issues.slice(0, ISSUE_LIMIT)
    memory.issuesTruncated = issues.issues.length + issues.dropped > ISSUE_LIMIT
  }
  if (page !== undefined) {
    memory.prs = page.prs
    memory.prsTruncated = page.total > PR_LIMIT
  }
}

// The limit of each list that was cut, the issues first: one partial-list line each (SP3-1).
function truncatedLimitsOf(memory: GithubMemory): number[] {
  const limits: number[] = []
  if (memory.issuesTruncated) limits.push(ISSUE_LIMIT)
  if (memory.prsTruncated) limits.push(PR_LIMIT)
  return limits
}

async function githubOf($: EngineInterface, context: RepoContext, seq: number): Promise<GithubPart> {
  const { repo, root } = context
  if (repo === null || root === null) return emptyGithub()
  const slug = slugOf(repo)
  const memory = memoryFor(slug)
  const errors = new Set<PaneError>()
  const [milestones, issues, page] = await Promise.all([
    // Every page of open milestones, which gh merges into one list (RB1-4); GH_OUTPUT_MAX_BYTES and the timeout bound it.
    fetchPart($, ['api', '--paginate', `repos/${slug}/milestones?state=open&per_page=100`], root, parseMilestones, errors),
    fetchPart(
      $,
      ['issue', 'list', '--repo', slug, '--state', 'open', '--limit', String(ISSUE_LIMIT + 1), '--json', ISSUE_FIELDS],
      root,
      parseIssues,
      errors,
    ),
    fetchPart(
      $,
      ['api', 'graphql', '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-f', `query=${PR_QUERY}`],
      root,
      parsePullRequestPage,
      errors,
    ),
  ])
  // The count only: an item's text never reaches the log.
  if (issues !== undefined && issues.dropped > 0) logLine($, `gh issue items not readable (${issues.dropped})`)
  if (isNewest(seq)) rememberGithub(memory, milestones, issues, page)
  return {
    milestones: memory.milestones,
    issues: memory.issues,
    prs: memory.prs,
    truncatedLimits: truncatedLimitsOf(memory),
    stale: milestones === undefined || issues === undefined || page === undefined,
    errors: [...errors],
  }
}

// ---- the snapshot and the poll ----

async function currentSessionIdOf($: EngineInterface): Promise<string | null> {
  return $.session.id().catch(() => null)
}

// One poll: the repo, the gh data, the sessions and this window's issue, then the snapshot atom (repo-work-pane-design-spec.md 2.1).
// null while the repo context has never been read: the state stays unknown (F02).
async function buildSnapshot($: EngineInterface, seq: number): Promise<Snapshot | null> {
  const now = await $.clock.now()
  const read = await repoContextOf($)
  const context = read ?? lastRepoContext
  if (context === null) return null
  if (isNewest(seq)) lastRepoContext = context
  const thisId = await currentSessionIdOf($)
  const github = await githubOf($, context, seq)
  const sessions = await sessionsOf($, context, github, now, thisId, seq)
  const windowIssue = await windowIssueFor($, context, github, sessions)
  const linked = new Set(flattenNodes(sessions.nodes).flatMap(node => (node.issue === null ? [] : [node.issue.number])))
  const thisNode = flattenNodes(sessions.nodes).find(node => node.isThisWindow)
  const errors: PaneError[] = [...github.errors, ...windowIssue.errors]
  if (context.repo === null) errors.push('no-remote')
  if (sessions.unreadable > 0) errors.push('records-unreadable')
  if (sessions.gitFailed) errors.push('git-failed')
  return {
    fetchedAt: now,
    mode: context.repo === null ? 'no-github' : 'github',
    repo: context.repo,
    sessions: sessions.nodes,
    milestones: github.milestones,
    issueGroups: context.repo === null ? [] : groupIssues(github.milestones, github.issues, linked),
    openIssueCount: github.issues.length,
    thisIssue: windowIssue.details,
    thisIssueNumber: thisNode?.issue?.number ?? null,
    unreadableCount: sessions.unreadable,
    errors: [...new Set(errors)],
    stale: github.stale || windowIssue.stale,
    truncated: github.truncatedLimits.length > 0,
    truncatedLimits: github.truncatedLimits,
  }
}

// Writes the poll's snapshot, unless a newer poll has written (R2-04); a poll with no repo context yet writes nothing.
async function refresh($: EngineInterface, seq: number): Promise<void> {
  const snapshot = await buildSnapshot($, seq)
  if (snapshot === null || !isNewest(seq)) return
  writtenSeq = seq
  await update($, snapshotAtom, () => snapshot)
  $.ui.invalidate('ui.render')
}

// The poll under its deadline (F07): a poll not settled after POLL_DEADLINE_MS is abandoned, and its flag is freed. Its refresh goes
// on, and its result still writes unless a newer poll has written (R2-04). The deadline timer is cancelled once the poll settles.
async function refreshWithin($: EngineInterface, seq: number): Promise<void> {
  attemptedAt = await $.clock.now()
  return new Promise<void>((resolve, reject) => {
    let abandoned = false
    const deadline = $.clock.after(POLL_DEADLINE_MS, () => {
      abandoned = true
      abandonedPolls += 1
      reject(Object.assign(new Error('poll deadline'), { name: 'PollDeadline' }))
    })
    const settle = (): void => {
      if (abandoned) abandonedPolls -= 1
      else deadline.cancel()
    }
    refresh($, seq).then(
      () => {
        settle()
        resolve()
      },
      (error: unknown) => {
        settle()
        reject(error)
      },
    )
  })
}

// The empty snapshot of a repo whose poll failed before any data came: no sessions and no GitHub data (F07).
function emptySnapshotOf(context: RepoContext, now: number): Snapshot {
  return {
    fetchedAt: now,
    mode: context.repo === null ? 'no-github' : 'github',
    repo: context.repo,
    sessions: [],
    milestones: [],
    issueGroups: [],
    openIssueCount: 0,
    thisIssue: null,
    thisIssueNumber: null,
    unreadableCount: 0,
    errors: [],
    stale: false,
    truncated: false,
    truncatedLimits: [],
  }
}

// A poll that failed (a throw, or the deadline): the last snapshot stays, marked stale, and the error name is logged (F07). With no
// snapshot yet, the last known repo context gives an empty one, so the pane leaves Loading; with neither, the state stays unknown.
async function failedPoll($: EngineInterface, seq: number, error: unknown): Promise<void> {
  logLine($, `poll failed (${failureNameOf(error)})`)
  const previous = await read($, snapshotAtom)
  const base = previous ?? (lastRepoContext === null ? null : emptySnapshotOf(lastRepoContext, await $.clock.now()))
  // A newer poll has written: its snapshot stands, so this failure marks nothing (R2-04).
  if (base === null || !isNewest(seq)) return
  // The mark is set on the value stored at write time, and only while no newer poll has written (R2-04).
  await update($, snapshotAtom, current => (isNewest(seq) ? { ...(current ?? base), stale: true } : current))
  $.ui.invalidate('ui.render')
}

// One poll at a time: a tick that comes during a poll starts nothing (repo-work-pane-design-spec.md 2.5). After a deadline the flag is
// free, so the next tick may start a poll beside the abandoned one, up to MAX_ABANDONED_POLLS of them; past that, the tick logs a skip.
function startPoll($: EngineInterface): void {
  if (polling) return
  if (abandonedPolls >= MAX_ABANDONED_POLLS) {
    logLine($, `poll skipped (${abandonedPolls} polls past their deadline still running)`)
    return
  }
  polling = true
  startedSeq += 1
  const seq = startedSeq
  report(
    $,
    refreshWithin($, seq)
      .catch((error: unknown) => failedPoll($, seq, error))
      .finally(() => {
        polling = false
      }),
  )
}

// A poll interval from its environment value (a test override), or the fallback when unset, not an integer, or below MIN_POLL_MS.
function intervalOf(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return raw !== undefined && Number.isInteger(value) && value >= MIN_POLL_MS ? value : fallback
}

// The window's one timer: the pane's cadence while the pane is open, the band's slow cadence while it is closed
// (repo-work-pane-design-spec.md 2.5). The open flag is read last, after the awaits, so a close or open during an await
// is never missed (B1); the cadence is set in the same synchronous step, so no second timer can start beside it.
async function scheduleTimer($: EngineInterface): Promise<void> {
  const openMs = intervalOf(await $.env.get('KEEPTRACK_POLL_MS'), POLL_MS)
  const closedMs = intervalOf(await $.env.get('KEEPTRACK_BAND_POLL_MS'), BAND_POLL_MS)
  const everyMs = (await read($, openAtom)) ? openMs : closedMs
  if (poller !== undefined && pollerMs === everyMs) return
  stopTimer()
  pollerMs = everyMs
  poller = $.clock.every(everyMs, () => startPoll($))
}

function stopTimer(): void {
  poller?.cancel()
  poller = undefined
}

// Starts the window's timer at its cadence, and polls at once when no poll started within that cadence (the last attempt, or the
// snapshot's time when that is later). A poll that fails keeps its snapshot's old time, so this cadence check stops the re-polls (R2-03).
async function resumePolling($: EngineInterface): Promise<void> {
  await scheduleTimer($)
  const snapshot = await read($, snapshotAtom)
  const lastPoll = Math.max(attemptedAt, snapshot?.fetchedAt ?? Number.NEGATIVE_INFINITY)
  if ((await $.clock.now()) - lastPoll >= pollerMs) startPoll($)
}

// The band's tick: started once per module instance, so a reloaded instance starts its own (its timers die with the old one).
function startBandTick($: EngineInterface): void {
  if (bandTick !== undefined) return
  bandTick = $.clock.every(BAND_TICK_MS, () => report($, tickBand($)))
}

// The band's tick: it re-reads the agents, redraws on every tick while any runs, and otherwise on the cadence of bandRedrawDue.
// A count that changed is drawn at once, so the band shows Idle as soon as the last agent ends.
async function tickBand($: EngineInterface): Promise<void> {
  bandTicks += 1
  const before = await read($, agentRunAtom)
  await readAgents($).catch((error: unknown) => logLine($, `agent list failed (${failureNameOf(error)})`))
  const after = await read($, agentRunAtom)
  if (after.count !== before.count || after.count > 0 || bandRedrawDue(await read($, turnAtom), bandTicks)) {
    $.ui.invalidate('ui.render')
  }
}

// The window's timers, started by whichever hook runs first in this module instance: session.start, or a band draw that finds
// them missing (a reloaded instance whose session.start did not run). Idempotent: a timer that runs is never started twice.
async function ensureTimers($: EngineInterface): Promise<void> {
  startBandTick($)
  if (poller === undefined) await resumePolling($)
}

// The open pane's work: the pane's cadence and its poll (repo-work-pane-design-spec.md 2.5).
async function startIfOpen($: EngineInterface): Promise<void> {
  if (!(await read($, openAtom))) return
  await resumePolling($)
}

// Opens the pane. The open intent is recorded first, so a pane the engine does not place (a narrow terminal) starts once a
// render places it (W5).
async function openPane($: EngineInterface): Promise<void> {
  const lang = await read($, langAtom)
  await update($, openAtom, () => true)
  const opened = await $.ui.open({ id: PANE, title: t(lang, 'pane.title'), focus: true })
  $.ui.invalidate('ui.render')
  if (opened.isPlaced) await startIfOpen($)
}

// ---- the /keeptrack command ----

async function registerCommand($: EngineInterface, lang: Lang): Promise<void> {
  await $.command
    .register({ name: COMMAND, description: t(lang, 'command.describe') })
    .catch(() => logLine($, 'the /keeptrack command was not registered'))
}

async function toastUsage($: EngineInterface): Promise<void> {
  $.ui.toast(t(await read($, langAtom), 'toast.usage'))
}

// The Desktop session of this window: its local_ id from the record whose cliSessionId is the session id.
async function thisSessionLinkOf($: EngineInterface): Promise<string | null> {
  const cliId = await currentSessionIdOf($)
  if (cliId === null) return null
  const scan = await scanRecords($, await recordsRootOf($))
  return scan.records.find(record => record.cliSessionId === cliId)?.sessionId ?? null
}

// `none` or an issue number of 1 to ISSUE_NUMBER_MAX; anything else is not an issue argument.
function issueArgOf(value: string): number | 'none' | null {
  if (value === 'none') return 'none'
  return /^\d{1,6}$/.test(value) ? issueNumberOf(Number(value)) : null
}

// /keeptrack issue <n> sets this window's issue, /keeptrack issue none clears it (repo-work-pane-design-spec.md 2.6).
async function setIssue($: EngineInterface, value: string): Promise<void> {
  const issue = issueArgOf(value)
  if (issue === null) return toastUsage($)
  const sessionId = await thisSessionLinkOf($)
  if (sessionId === null || !isSessionLinkId(sessionId)) return $.ui.toast(t(await read($, langAtom), 'toast.noSession'))
  const key = `${OVERRIDE_PREFIX}${sessionId}`
  if (issue === 'none') await $.store.delete(key)
  else await $.store.set(key, { issue, ts: await $.clock.now() })
  if (await read($, openAtom)) startPoll($)
}

// /keeptrack lang en|pt-BR|auto: stores the choice (auto removes it) and switches the language at once.
async function setLanguage($: EngineInterface, value: string): Promise<void> {
  const choice = LANG_CHOICES.get(value.toLowerCase())
  if (choice === undefined) return toastUsage($)
  if (choice === 'auto') await $.store.delete(LANG_KEY)
  else await $.store.set(LANG_KEY, choice)
  const next = choice === 'auto' ? await detectedLang($) : choice
  await update($, langAtom, () => next)
  await registerCommand($, next)
}

// The repo the band names: GitHub when the snapshot has a remote, none when it has none, unknown before the first poll.
function bandRepoOf(snapshot: Snapshot | null): BandRepo {
  if (snapshot === null) return 'unknown'
  return snapshot.repo === null ? 'none' : 'github'
}

// This window's issue for the band, with its milestone's progress when the snapshot lists that milestone as open.
function bandIssueOf(snapshot: Snapshot | null): BandIssue | null {
  if (snapshot === null || snapshot.thisIssueNumber === null) return null
  const issue = snapshot.thisIssue
  if (issue === null) return { number: snapshot.thisIssueNumber, milestoneTitle: null, progress: null, detailsMissing: true }
  const milestone =
    issue.milestoneTitle === null ? undefined : snapshot.milestones.find(each => each.title === issue.milestoneTitle)
  return {
    number: issue.number,
    milestoneTitle: issue.milestoneTitle,
    progress:
      milestone === undefined ? null : { closed: milestone.closedIssues, total: milestone.openIssues + milestone.closedIssues },
  }
}

// The band's flags from the snapshot: the error flag when it holds an error other than no-remote (the repo line already names the
// missing remote), and the waiting flag when this window's session has an open askaway question (its node reads 'waiting' in the same poll).
function bandErrorOf(snapshot: Snapshot | null): boolean {
  return snapshot !== null && snapshot.errors.some(error => error !== 'no-remote')
}

function bandWaitingOf(snapshot: Snapshot | null): boolean {
  return snapshot !== null && flattenNodes(snapshot.sessions).some(node => node.isThisWindow && node.state === 'waiting')
}

// ---- the band's session state: the main loop's turn, its tool and the agents ----

// The main loop's turn starts: its start time, and no tool yet.
async function beginTurn($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, turnAtom, () => turnStarted(now))
  $.ui.invalidate('ui.render')
}

// The main loop's turn ends, completed or aborted: its end is the idle "since". An end with no turn running changes nothing.
async function finishTurn($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, turnAtom, prev => turnEnded(prev, now))
  $.ui.invalidate('ui.render')
}

// A tool call of the running turn: its name only, never its arguments.
async function noteTool($: EngineInterface, tool: string): Promise<void> {
  const name = plain(tool, TOOL_NAME_MAX)
  await update($, turnAtom, prev => turnToolNamed(prev, name))
  await redrawForTool($)
}

// Redraws the band for a tool call at most once per TOOL_REDRAW_MS. A call inside that second waits for the second's end,
// so the last tool of a burst is the one drawn.
async function redrawForTool($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const wait = toolRedrawAt + TOOL_REDRAW_MS - now
  if (wait <= 0) {
    toolRedrawAt = now
    $.ui.invalidate('ui.render')
    return
  }
  if (toolRedrawPending) return
  toolRedrawPending = true
  $.clock.after(wait, () => {
    toolRedrawPending = false
    report($, redrawForTool($))
  })
}

// Re-reads the agents (`$.agent.list()`): the count of the active ones, and the start of the run they are in (kept while it lasts).
// A read that finishes after a newer read has written is discarded: its list is older (the band tick and the turn events race).
async function readAgents($: EngineInterface): Promise<void> {
  agentReadsStarted += 1
  const readNumber = agentReadsStarted
  const agents = await $.agent.list()
  const now = await $.clock.now()
  if (readNumber < agentReadsWritten) return
  agentReadsWritten = readNumber
  const count = agents.filter(agent => ACTIVE_AGENT_STATUSES.includes(agent.status)).length
  await update($, agentRunAtom, prev => ({ count, since: count === 0 ? null : prev.count > 0 ? prev.since : now }))
}

// Re-reads the agents and redraws the band.
async function refreshAgents($: EngineInterface): Promise<void> {
  await readAgents($)
  $.ui.invalidate('ui.render')
}

// The command's arguments: the verb, then one value. No verb opens the pane; an unknown verb is a toast. $ is passed on
// at each call site (the engine follows $ only where it is spelled as $.noun or handed to a declared function).
async function runCommand($: EngineInterface, args: string): Promise<void> {
  const words = args.trim() === '' ? [] : args.trim().split(/\s+/)
  const [verb = 'open', value = ''] = words
  if (verb === 'open') return words.length > 1 ? toastUsage($) : openPane($)
  if (verb === 'issue') return words.length > 2 ? toastUsage($) : setIssue($, value)
  if (verb === 'lang') return setLanguage($, value)
  return toastUsage($)
}

export const register: Register = on => {
  // A new session drops the old timer and registers the command in the session's language.
  on('session.start', async ($, e, next) => {
    const lang = await currentLang($)
    await update($, langAtom, () => lang)
    await registerCommand($, lang)
    stopTimer()
    startBandTick($)
    await resumePolling($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await runCommand($, e.args).catch((error: unknown) => logLine($, `command failed (${failureNameOf(error)})`))
    return {}
  })

  // The pane draws from the snapshot atom only. A render writes no state: the open pane's work (its timer after a reload,
  // a poll when stale) runs after the draw, through the clock.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (await read($, openAtom)) $.clock.after(0, () => report($, startIfOpen($)))
    return renderPane($.ui.resolve(e), {
      snapshot: await read($, snapshotAtom),
      lang: await read($, langAtom),
      surface: e.surface,
    })
  })

  // The band row above the prompt, on the desktop and the terminal, always drawn from the snapshot atom alone. A render starts
  // no work: the poll that refreshes the band's text runs with the open pane (SPEC section 18).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    // A draw that finds the timers missing (a reloaded instance) starts them through the clock, as the pane's draw does.
    if (poller === undefined || bandTick === undefined) $.clock.after(0, () => report($, ensureTimers($)))
    const snapshot = await read($, snapshotAtom)
    const run = await read($, agentRunAtom)
    return renderBand(
      $.ui.resolve(e),
      {
        lang: await read($, langAtom),
        surface: e.surface,
        open: await read($, openAtom),
        repo: bandRepoOf(snapshot),
        issue: bandIssueOf(snapshot),
        waiting: bandWaitingOf(snapshot),
        error: bandErrorOf(snapshot),
        turn: await read($, turnAtom),
        agents: run.count,
        agentsSince: run.since,
        now: await $.clock.now(),
      },
      () => report($, openPane($)),
      heldFor(e.surface, e.requestId),
    )
  })

  // The band's session state. The main loop's turn starts, calls its tools and ends (completed or aborted); the agents are
  // re-read on turn.start, turn.complete and agent.spawn, and on the band's tick after an abort. Every hook passes the event on
  // unchanged (SPEC section 18).
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await beginTurn($)
    report($, refreshAgents($))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await finishTurn($)
    report($, refreshAgents($))
    return next(e)
  })
  on('turn.abort', async ($, e, next) => {
    if (e.agentId === undefined) await finishTurn($)
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    // The main loop's call names the band's tool; a subagent's call only redraws the band (at most once per second).
    if (e.agentId === undefined) await noteTool($, e.tool)
    else await redrawForTool($)
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    report($, refreshAgents($))
    return next(e)
  })

  // Closing the pane moves the timer to the band's slow cadence: the window's repo data stays fresh while the pane is closed.
  // The band's label follows the open flag.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, openAtom, () => false).catch((error: unknown) => logLine($, `close failed (${failureNameOf(error)})`))
    await scheduleTimer($)
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
