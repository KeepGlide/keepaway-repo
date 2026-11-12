// The hooks module of the KeepAway Repo pane: the poll timer, the atoms the pane draws, the /keepaway command and the close
// of the pane. The only module that calls $ (repo-work-pane-design-spec.md 3.3). The pure rules are in model.ts, the text in i18n.ts, and
// pane.tsx draws from the snapshot alone. Nothing here logs or stores a record's content, a remote URL or a title.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderSurface } from 'claude-code'

import { detectLang, resolveLang, t, type Lang, type LangEnv } from './i18n'
import { renderPane } from './pane'
import { EMPTY_CURSOR, currentStepOf, explainRequestOf, stepsAfter, type StepCursor, type StepEvent } from './steps'
import { renderBand, type BandIssue, type BandRepo } from './band'
import { heldButtons, type HeldButtons } from './held'
import { IDLE_TURN, bandRedrawDue, turnEnded, turnExpired, turnStarted, turnTimedOut, turnToolNamed } from './turn'
import {
  SUMMARY_KEEP_MAX,
  SUMMARY_RETRY_MS,
  TRANSCRIPT_HEAD_BYTES,
  briefOfReply,
  briefRequestOf,
  hasUserLine,
  needsBrief,
  promptOfTranscript,
  shownPromptOf,
  transcriptFolderOf,
} from './summary'
import {
  COMMIT_SHA,
  LABEL_MAX,
  NO_DESKTOP_GROUPS,
  OBJECTIVE_MAX,
  RECORD_MAX_BYTES,
  TEXT_MAX,
  buildTree,
  cutAtWord,
  groupIssues,
  commitPageOf,
  isGithubHost,
  isGitlabHost,
  isObject,
  isSessionLinkId,
  issueFactsOf,
  logoKeyOf,
  mapLimited,
  newestCommentOf,
  newestDecisionOf,
  detailOfBody,
  parseDesktopGroups,
  parseRemote,
  parseUtcOffset,
  plain,
  projectRecord,
  repoPageOf,
  sshHostnameOf,
  type DesktopGroups,
  type Remote,
} from './model'
import {
  AVATAR_FETCH_SCRIPT,
  AVATAR_SIZE_PX,
  GITHUB_AVATAR_HOST,
  GITHUB_LOGO_CALLS,
  LOGO_FOLDERS,
  LOGO_PATHS,
  LOGO_RETRY_MS,
  LOGO_STORE_MAX,
  avatarUrlOf,
  contentsLogoOf,
  isLogoFresh,
  isLogoLockLive,
  isLogoStoreKey,
  logoLockKeyOf,
  logoPathIn,
  logoStoreKeyOf,
  pictureDocumentOf,
  projectAvatarUrlOf,
  readStoredLogo,
  type StoredLogo,
} from './repo-logo'
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
  SessionSteps,
  SessionSummary,
  Snapshot,
} from '../types'

const PANE = 'repo-work'
const COMMAND = 'keepaway'
// The poll cadence while the pane is open (repo-work-pane-design-spec.md 2.5); KEEPAWAY_POLL_MS overrides it for tests.
const POLL_MS = 60_000
// The slow cadence while the pane is closed, which keeps the band's repo data fresh; KEEPAWAY_BAND_POLL_MS overrides it.
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
// The limits of the gh list calls (repo-work-pane-design-spec.md D4); a result at the limit sets `truncated`.
const ISSUE_LIMIT = 500
const PR_LIMIT = 100
// The closing references read per PR; a PR that closes more links no issue, since its lowest is then not known (DL9).
const CLOSING_LIMIT = 50
// The largest gh answer parsed, in UTF-8 bytes: the engine's own stdout cut. An answer past it, or cut, is unreadable (SE3).
const GH_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
const ISSUE_NUMBER_MAX = 999_999
// The longest running tool name the band keeps (the main loop's tool, F11).
export const TOOL_NAME_MAX = 64
// The most Desktop files read per poll (DESKTOP_SCAN_MAX), the most candidate sessions git is asked about, and
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
// The open issues: the rows of the pane, and each row's milestone (its number and title, for the closed-milestone groups).
const ISSUE_FIELDS = 'number,title,milestone,labels,updatedAt,url'
// The open PRs with the issues they close and the last commit's checks (repo-work-pane-design-spec.md D4). gh 2.45 has no such JSON field.
const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PR_LIMIT}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        number title state headRefName url createdAt reviewDecision isCrossRepository
        closingIssuesReferences(first: ${CLOSING_LIMIT}) { totalCount nodes { number repository { nameWithOwner } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`
// The exact issue counts of the open milestones, issues only: REST's open_issues and closed_issues count the PRs too (pm1-8). The first
// 100 open milestones; a milestone past them keeps its REST counts, marked not exact (countsExact).
const MILESTONE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    milestones(first: 100, states: OPEN) {
      nodes { number open: issues(states: OPEN) { totalCount } closed: issues(states: CLOSED) { totalCount } }
    }
  }
}`
const PR_STATES = ['OPEN', 'MERGED', 'CLOSED'] as const
const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const
const CHECK_STATES = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'] as const
// The /keepaway language choices as typed (case does not matter); `auto` follows the environment.
const LANG_CHOICES: ReadonlyMap<string, Lang | 'auto'> = new Map<string, Lang | 'auto'>([
  ['en', 'en'],
  ['pt-br', 'pt'],
  ['auto', 'auto'],
])

// The drawn state the pane reads (PluginState in types/index.d.ts). The poll writes the snapshot; the handlers write the
// open flag and the language.
const snapshotAtom = atom({ plugin: 'keepaway-repo', key: 'snapshot' } as const, null as Snapshot | null)
const openAtom = atom({ plugin: 'keepaway-repo', key: 'open' } as const, false)
// Set when the first poll settled with no snapshot to show, so the pane draws the failure line instead of Loading (ux4-2).
const loadFailedAtom = atom({ plugin: 'keepaway-repo', key: 'loadFailed' } as const, false)
const langAtom = atom({ plugin: 'keepaway-repo', key: 'lang' } as const, 'en' as Lang)
// The host's UTC offset in minutes east of UTC, read with `date +%z` at session.start and on each poll; the pane draws its clock times
// in it, since the runtime's own zone may not be the host's. Until a read lands it is the runtime's offset.
const utcOffsetAtom = atom({ plugin: 'keepaway-repo', key: 'utcOffset' } as const, runtimeUtcOffset())
// The main loop's turn, written by turn.start, tool.call, turn.complete and turn.abort: the band's status line reads it.
const turnAtom = atom({ plugin: 'keepaway-repo', key: 'turn' } as const, IDLE_TURN)
// Whether this window's session waits for the person: the engine asked about a tool call (tool.check answered ask) and the call has not run.
const waitingAtom = atom({ plugin: 'keepaway-repo', key: 'waiting' } as const, false)
// The agents that have not ended, from $.agent.list(), and since when the current run of them began (readAgents).
type AgentRun = { count: number; since: number | null }
const agentRunAtom = atom({ plugin: 'keepaway-repo', key: 'agentRun' } as const, { count: 0, since: null } as AgentRun)
// The agent statuses that are still work: pending, running, and waiting on the background work it owns (AgentStatus).
const ACTIVE_AGENT_STATUSES: readonly string[] = ['pending', 'running', 'waiting']

// Module memory, never $.store: a file read cache (size and mtime), the git lookups, the last good gh data and the poll flag.
type Json = Readonly<Record<string, unknown>>
type Repo = Remote
type Entry = { path: string; size: number; mtimeMs: number }
// A file's projected value, kept while its size and mtime stay the same.
type Cached<T> = { size: number; mtimeMs: number; value: T }
type Timer = ReturnType<EngineInterface['clock']['every']>
type Commit = { at: number; subject: string; sha: string | null; detail: string | null }
type IssueComment = { author: string; association: string; at: number; body: string }
type GhOutcome = { ok: true; stdout: string; oversized: boolean } | { ok: false; error: PaneError; kind: string }
type GithubMemory = {
  key: string
  milestones: Milestone[]
  issues: Issue[]
  prs: PullRequest[]
  issuesTruncated: boolean
  prsTruncated: boolean
}

let polling = false
// Set when a session.start lands during a poll: the new session's poll starts when that poll settles (state2-3, SPEC 2.5).
let repollOnSettle = false
// The poll sequence: a poll takes the next number when it starts. writtenSeq is the number of the last poll that wrote the snapshot;
// a result writes only while its number is above it, so a late poll never overwrites a newer one (R2-04, CR3).
let startedSeq = 0
let writtenSeq = 0
// The session the polls read: a session.start moves it on, and a poll that began under the old one writes nothing (state2-6).
let sessionEpoch = 0
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
const remoteCache = new Map<string, Repo | null>()
// The host each ssh alias resolves to (SPEC section 16), by alias: one `ssh -G` per alias while its answer is in flight or kept. A failed
// answer carries its time (failedAt) and is asked again once LOGO_RETRY_MS has passed; a success is kept for the window.
type SshHostEntry = { host: Promise<string>; failedAt: number | undefined }
const sshHostCache = new Map<string, SshHostEntry>()
// Whether a failed alias lookup has been logged in this window (once).
let sshFailureLogged = false
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
  $.ui.log(`keepaway: ${text}`)
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

// ---- Desktop records (read only) ----

// The records root: KEEPAWAY_DESKTOP_SESSIONS when set (tests), else the Desktop folder under HOME.
async function recordsRootOf($: EngineInterface): Promise<string | undefined> {
  const override = await $.env.get('KEEPAWAY_DESKTOP_SESSIONS')
  if (override) return override
  const home = await $.env.get('HOME')
  return home ? `${home}/.config/Claude/claude-code-sessions` : undefined
}

// The Desktop config (claude_desktop_config.json) and its sidebar Groups, read for the group names and the session assignments only, when its mtime
// changes (the folder listing gives it). A file that is not there names no Group, and every session sits under Recents. A file over
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

// ---- ssh aliases (SPEC section 16): a remote whose host has no dot names an ssh alias, which ssh resolves to the real host ----

// An alias as a remote URL may name it: no leading dash, so ssh never reads it as an option.
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SSH_TIMEOUT_MS = 5_000

// Logs a failed alias lookup once per window, by its failure only: the alias is part of a remote URL, which the log never carries.
function logSshFailureOnce($: EngineInterface, failure: string): void {
  if (sshFailureLogged) return
  sshFailureLogged = true
  logLine($, `ssh alias lookup failed (${failure})`)
}

// Asks ssh for the host an alias connects to. A failure (ssh missing, a timeout, no hostname line) answers the alias itself, as before,
// and is flagged so the answer is not kept.
async function resolveSshAlias($: EngineInterface, alias: string): Promise<{ host: string; failed: boolean }> {
  try {
    const run = await $.process.run(['ssh', '-G', alias], { timeoutMs: SSH_TIMEOUT_MS })
    const host = run.exitCode === 0 ? sshHostnameOf(run.stdout) : null
    if (host !== null) return { host, failed: false }
    logSshFailureOnce($, 'no hostname line')
  } catch (error) {
    logSshFailureOnce($, failureNameOf(error))
  }
  return { host: alias, failed: true }
}

// The host of an alias: concurrent reads share one `ssh -G` while it is in flight. A failure is kept from the lookup's start for
// LOGO_RETRY_MS, then asked again; a success is kept for the window.
async function sshHostOf($: EngineInterface, alias: string): Promise<string> {
  const now = await $.clock.now()
  const cached = sshHostCache.get(alias)
  if (cached !== undefined && (cached.failedAt === undefined || now - cached.failedAt < LOGO_RETRY_MS)) return cached.host
  const entry: SshHostEntry = {
    host: resolveSshAlias($, alias).then(answer => {
      if (answer.failed) entry.failedAt = now
      return answer.host
    }),
    failedAt: undefined,
  }
  sshHostCache.set(alias, entry)
  return entry.host
}

// The remote with its host resolved: a dotted host is kept as it is, an alias becomes the host ssh connects to (github.com for a GitHub alias).
// A host no ssh alias can be (a leading dash would reach glab or gh as an option) is no remote: no repo page, no logo, no lookup.
async function resolvedRemoteOf($: EngineInterface, remote: Repo | null): Promise<Repo | null> {
  if (remote === null || !SSH_ALIAS.test(remote.host)) return null
  if (remote.host.includes('.')) return remote
  const host = await sshHostOf($, remote.host)
  return host === remote.host ? remote : { ...remote, host }
}

// The host, owner and name of the remote of a common git dir (repo-work-pane-design-spec.md D2b). Only a definite answer is cached: a
// remote, or none; a failed call is asked again on the next poll (W3). A remote whose alias lookup failed is no definite answer either:
// it is used for now and asked again with the alias once LOGO_RETRY_MS has passed (SPEC section 16).
async function remoteOf($: EngineInterface, commonDir: string): Promise<Repo | null | undefined> {
  const cached = remoteCache.get(commonDir)
  if (cached !== undefined) return cached
  const found = await remoteUrlOf($, ['--git-dir', commonDir])
  if (!found.ok) return undefined
  const parsed = parseRemote(found.url)
  const remote = await resolvedRemoteOf($, parsed)
  if (parsed === null || sshHostCache.get(parsed.host)?.failedAt === undefined) remoteCache.set(commonDir, remote)
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
  const run = await gitRun($, ['-C', cwd, 'log', `-${COMMIT_LIMIT}`, `--format=${COMMIT_FORMAT}`])
  return run !== null && run.exitCode === 0 ? parseCommits(run.stdout) : []
}

// One commit per record: its full id, the commit time in seconds and the subject, tab-separated (the subject may hold tabs of its own),
// then a unit separator and the body; records end with a record separator. Output with no record separator (one commit, no body) is one
// record per line. A record whose time does not parse is skipped; an id that is not a commit id is kept empty, so its commit has no page
// to link to.
const COMMIT_FORMAT = '%H%x09%ct%x09%s%x1f%b%x1e'
function parseCommits(text: string): Commit[] {
  const records = text.includes('\x1e') ? text.split('\x1e') : text.split('\n')
  return records.flatMap(record => {
    const [head = '', body = ''] = record.replace(/^\n+/, '').split('\x1f')
    const [sha = '', seconds = '', ...subject] = head.split('\t')
    const at = Number(seconds)
    if (seconds === '' || !Number.isFinite(at)) return []
    return [{ at: at * 1000, subject: plain(subject.join('\t'), TEXT_MAX), sha: COMMIT_SHA.test(sha) ? sha : null, detail: detailOfBody(body) }]
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
  const remote = await resolvedRemoteOf($, parseRemote(url))
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

// The common git dir of a record's repo: the one the Desktop recorded, else git's answer for its folder (`ok` false when git could not
// answer). A record with neither a common dir nor a folder has no dir.
async function commonDirOfRecord($: EngineInterface, record: ProjectedRecord): Promise<{ ok: boolean; dir: string | null }> {
  if (record.commonDir !== null) return { ok: true, dir: record.commonDir }
  if (record.cwd === null) return { ok: true, dir: null }
  return commonDirOfCwd($, record.cwd)
}

async function membershipOf($: EngineInterface, record: ProjectedRecord, context: RepoContext): Promise<Membership> {
  const known = await commonDirOfRecord($, record)
  if (!known.ok) return 'unknown'
  if (known.dir === null) return 'other'
  const commonDir = known.dir
  if (context.repo === null) return commonDir === context.rootCommonDir ? 'member' : 'other'
  const remote = await remoteOf($, commonDir)
  if (remote === undefined) return 'unknown'
  return remote !== null && sameRepo(remote, context.repo) ? 'member' : 'other'
}

// The remote is the record's own repo's origin (remoteOfRecord), null when it has none or git could not answer.
type Candidate = { record: ProjectedRecord; branch: string | null; gitFailed: boolean; remote: Repo | null }

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
    const remote = await remoteOfRecord($, record)
    if (cwd === null) return { record, branch: null, gitFailed: false, remote }
    const head = await branchOf($, cwd)
    return { record, branch: head.branch, gitFailed: head.failed, remote }
  })
}

// The remote of a record's own repo: the origin of its common git dir (remoteOf, cached per dir). null when it has none or git could
// not answer, so the session keeps no repo link until a later poll reads it.
async function remoteOfRecord($: EngineInterface, record: ProjectedRecord): Promise<Repo | null> {
  const dir = (await commonDirOfRecord($, record)).dir
  if (dir === null) return null
  return (await remoteOf($, dir)) ?? null
}

type TreeInputs = {
  now: number
  thisId: string | null
  prsByBranch: ReadonlyMap<string, PullRequest>
  overrides: ReadonlyMap<string, number>
  // Whether this window's session waits for the person; only its own record can wait.
  ownWaiting: boolean
  issueFacts: ReadonlyMap<number, IssueFacts>
  // The records up the candidates' parent chains that are not listed, and the Desktop sidebar Groups.
  ancestors: readonly ProjectedRecord[]
  desktopGroups: DesktopGroups
  // The summary of each candidate session this poll has (SPEC section 21); a session with none is absent.
  summaries: ReadonlyMap<string, SessionSummary>
  // The plan steps of each candidate session read so far (SPEC section 22); a session with none is absent.
  steps: ReadonlyMap<string, SessionSteps>
}

function inputOf(entry: Candidate, inputs: TreeInputs, commits: ReadonlyMap<string, Commit[]>): SessionInput {
  const { record, branch } = entry
  return {
    ...record,
    branch,
    remote: entry.remote,
    pr: branch === null ? null : (inputs.prsByBranch.get(branch) ?? null),
    override: inputs.overrides.get(record.sessionId) ?? null,
    waiting: inputs.ownWaiting && record.cliSessionId === inputs.thisId,
    commits: commits.get(record.sessionId) ?? [],
    summary: inputs.summaries.get(record.sessionId) ?? null,
    steps: inputs.steps.get(record.sessionId) ?? null,
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
  // The commits of each kept session, newest first.
  commits: ReadonlyMap<string, Commit[]>
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
  // The overrides are pruned against every record in the folder, not this repo's only: the store is shared by every window, so
  // another repo's override must survive this window's poll.
  if (scan.complete && isNewest(seq)) await pruneOverrides($, new Set(scan.records.map(record => record.sessionId)))
  const members = await memberRecordsOf($, scan.records, context, thisId)
  const candidates = admittedOf(await withBranches($, members.records), new Set(github.prs.map(pr => pr.headRefName)), thisId)
  await requestRepoLogos($, candidates)
  const ownWaiting = await read($, waitingAtom)
  const inputs: TreeInputs = {
    now,
    thisId,
    prsByBranch: pullRequestsByBranch(github.prs),
    overrides: await overridesOf($, now),
    ownWaiting,
    issueFacts: issueFactsOf(github.milestones, github.issues),
    ancestors: ancestorsOf(candidates.map(entry => entry.record), scan.records),
    desktopGroups: await readDesktopGroups($),
    // A failing store or record read leaves the lines out; it never fails the poll.
    summaries: await summariesOf($, candidates.map(entry => entry.record)).catch((error: unknown) => {
      logSummaryFailureOnce($, error)
      return new Map<string, SessionSummary>()
    }),
    steps: await stepsOfSessions($, candidates.map(entry => entry.record)).catch((error: unknown) => {
      logStepsFailureOnce($, error)
      return new Map<string, SessionSteps>()
    }),
  }
  const keptIds = new Set(flattenNodes(treeOf(candidates, inputs, new Map())).map(node => node.id))
  const commits = await commitsOfKept($, candidates, keptIds)
  return {
    nodes: treeOf(candidates, inputs, commits),
    gitFailed: members.membershipFailed || candidates.some(entry => entry.gitFailed),
    unreadable: scan.unreadable,
    commits,
  }
}

// ---- session summaries (SPEC section 21): the first prompt of each session, read from the head of its transcript ----

// The setting in the store: `summary` is false when the person turned the lines off (`/keepaway summary off`); absent is on.
const SUMMARY_SETTING_KEY = 'summary'
// Summaries are never stored (SPEC section 21). A build that stored them left `summary:<sessionId>` keys, which this window deletes once.
const SUMMARY_KEY_PREFIX = 'summary:'
// The transcripts read per poll; the sessions past them wait for a later poll.
const SUMMARY_READS_PER_POLL = 5
const TRANSCRIPT_TIMEOUT_MS = 5_000
// A session id as a transcript file name: letters, digits and '-' only, so the path stays in its folder.
const TRANSCRIPT_ID = /^[0-9A-Za-z-]+$/
const SUMMARY_CHOICES: ReadonlyMap<string, boolean> = new Map([
  ['on', true],
  ['off', false],
])
// The condensed lines of long prompts, in the store by session id (`briefs`), so a window that opens later shows them without a model
// call. Only the model's line is kept, never the prompt (owner's review, 2026-11-02: this replaces the memory-only rule for these lines).
const BRIEFS_KEY = 'briefs'
// The most model calls started per poll, and the most condensed lines kept in the store (the oldest out).
const BRIEFS_PER_POLL = 2
const BRIEF_KEEP_MAX = 200
type StoredBrief = { text: string; at: number }
// The summaries this window holds, by session id. A final one (a prompt, or a user line with no usable text) lasts the window's life; one
// that is not final is read again once its retryAt has passed (null for a final one). `longPrompt` is a prompt too long to show whole
// whose condensed line is not known yet; null once it is, or for a prompt that fits.
type RememberedSummary = { summary: SessionSummary; retryAt: number | null; longPrompt?: string | null }
// The sessions whose condensed line is being asked for, and when a failed one may be asked again.
const briefsInFlight = new Set<string>()
const briefRetryAt = new Map<string, number>()
let briefFailureLogged = false
const summaryMemory = new Map<string, RememberedSummary>()
// Whether a summary failure has been logged in this window (once, by the error's name).
let summaryFailureLogged = false
// Whether the leftover `summary:` keys of an earlier build have been deleted in this window.
let storedSummariesCleared = false

// Forgets this window's summaries, its failure log and its cleanup flag. The tests call it before each host starts.
export function resetSummaryMemory(): void {
  summaryMemory.clear()
  briefsInFlight.clear()
  briefRetryAt.clear()
  briefFailureLogged = false
  summaryFailureLogged = false
  storedSummariesCleared = false
}

// A summary failure, logged once by the error's name: a prompt or a path never reaches the log.
function logSummaryFailureOnce($: EngineInterface, error: unknown): void {
  if (summaryFailureLogged) return
  summaryFailureLogged = true
  logLine($, `session summary failed (${failureNameOf(error)})`)
}

// Remembers a summary in this window's memory; the memory keeps SUMMARY_KEEP_MAX sessions, the oldest out.
function rememberSummary(sessionId: string, remembered: RememberedSummary): void {
  summaryMemory.delete(sessionId)
  summaryMemory.set(sessionId, remembered)
  const oldest = summaryMemory.keys().next()
  if (summaryMemory.size > SUMMARY_KEEP_MAX && !oldest.done) summaryMemory.delete(oldest.value)
}

// Deletes the `summary:<sessionId>` keys an earlier build stored, once per window. They hold prompt text, so they go; the setting key stays.
async function clearStoredSummaries($: EngineInterface): Promise<void> {
  if (storedSummariesCleared) return
  for (const key of await $.store.keys()) {
    if (key.startsWith(SUMMARY_KEY_PREFIX)) await $.store.delete(key)
  }
  storedSummariesCleared = true
}

// The head of a session's transcript (~/.claude/projects/<folder>/<cliSessionId>.jsonl), read with head, so a file over 4 MiB is read
// too. null when the session has no cwd or no id a file name can carry, the file is missing, or the read is refused (logged once).
async function transcriptHeadOf($: EngineInterface, record: ProjectedRecord): Promise<string | null> {
  const home = await $.env.get('HOME')
  if (!home || record.cwd === null || !TRANSCRIPT_ID.test(record.cliSessionId)) return null
  const path = `${home}/.claude/projects/${transcriptFolderOf(record.cwd)}/${record.cliSessionId}.jsonl`
  const run = await $.process
    .run(['head', '-c', String(TRANSCRIPT_HEAD_BYTES), path], { timeoutMs: TRANSCRIPT_TIMEOUT_MS })
    .catch((error: unknown) => {
      logSummaryFailureOnce($, error)
      return null
    })
  return run?.exitCode === 0 ? run.stdout : null
}

// A session's summary from its transcript, and whether it is final: the first prompt, cut, or no text when the transcript has a user line
// with none, which is final. A missing or refused transcript, or one with no user line yet (a session that has just started), is not:
// it is read again after SUMMARY_RETRY_MS.
async function readSummaryOf($: EngineInterface, record: ProjectedRecord): Promise<{ summary: SessionSummary; final: boolean; longPrompt: string | null }> {
  const head = await transcriptHeadOf($, record)
  if (head === null) return { summary: { text: null }, final: false, longPrompt: null }
  const prompt = promptOfTranscript(head)
  const text = prompt === null ? null : shownPromptOf(prompt)
  return { summary: { text }, final: text !== null || hasUserLine(head), longPrompt: prompt !== null && needsBrief(prompt) ? prompt : null }
}

// The stored condensed lines, by session id; anything malformed is left out.
async function storedBriefsOf($: EngineInterface): Promise<Record<string, StoredBrief>> {
  const raw = await $.store.get(BRIEFS_KEY)
  const briefs: Record<string, StoredBrief> = {}
  if (!isObject(raw)) return briefs
  for (const [id, value] of Object.entries(raw)) {
    if (isObject(value) && typeof value.text === 'string' && typeof value.at === 'number') briefs[id] = { text: value.text, at: value.at }
  }
  return briefs
}

// Stores one condensed line, keeping the BRIEF_KEEP_MAX newest.
async function storeBriefOf($: EngineInterface, sessionId: string, brief: StoredBrief): Promise<void> {
  const briefs = { ...(await storedBriefsOf($)), [sessionId]: brief }
  const kept = Object.entries(briefs)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, BRIEF_KEEP_MAX)
  await $.store.set(BRIEFS_KEY, Object.fromEntries(kept))
}

// A brief failure, logged once by its reason or the error's name: a prompt never reaches the log.
function logBriefFailureOnce($: EngineInterface, reason: string): void {
  if (briefFailureLogged) return
  briefFailureLogged = true
  logLine($, `session brief failed (${reason})`)
}

// Asks the model for one session's condensed line, without waiting: the line is stored and remembered and the pane polls again, so it
// is drawn. A failure keeps the cut prompt and is asked again after SUMMARY_RETRY_MS.
function startBrief($: EngineInterface, sessionId: string, prompt: string, now: number): void {
  if (briefsInFlight.has(sessionId)) return
  briefsInFlight.add(sessionId)
  const ask = async (): Promise<void> => {
    const reply = await $.model.complete(briefRequestOf(prompt, await read($, langAtom)))
    const text = reply.isAnswered ? briefOfReply(reply.text) : null
    if (text === null) {
      logBriefFailureOnce($, reply.isAnswered ? 'empty-reply' : reply.reason)
      briefRetryAt.set(sessionId, now + SUMMARY_RETRY_MS)
      return
    }
    await storeBriefOf($, sessionId, { text, at: await $.clock.now() })
    rememberBriefOf(sessionId, text)
    if (await read($, openAtom)) repollSoon($)
  }
  void ask()
    .catch((error: unknown) => {
      logBriefFailureOnce($, failureNameOf(error))
      briefRetryAt.set(sessionId, now + SUMMARY_RETRY_MS)
    })
    .finally(() => briefsInFlight.delete(sessionId))
}

// Puts a condensed line in place of a session's cut prompt in this window's memory.
function rememberBriefOf(sessionId: string, text: string): void {
  const remembered = summaryMemory.get(sessionId)
  if (remembered !== undefined) summaryMemory.set(sessionId, { ...remembered, summary: { text }, longPrompt: null })
}

// The condensed lines of this poll's long prompts: a stored one takes the cut prompt's place; a missing one is asked of the model, at
// most BRIEFS_PER_POLL per poll, never while one for the same session runs or before a failed one's retry time.
async function applyBriefs($: EngineInterface, summaries: Map<string, SessionSummary>, now: number): Promise<void> {
  const waiting = [...summaries.keys()].filter(id => (summaryMemory.get(id)?.longPrompt ?? null) !== null)
  if (waiting.length === 0) return
  const stored = await storedBriefsOf($)
  let started = 0
  for (const id of waiting) {
    const brief = stored[id]
    if (brief !== undefined) {
      rememberBriefOf(id, brief.text)
      summaries.set(id, { text: brief.text })
      continue
    }
    if (started >= BRIEFS_PER_POLL || briefsInFlight.has(id) || now < (briefRetryAt.get(id) ?? 0)) continue
    started += 1
    startBrief($, id, summaryMemory.get(id)?.longPrompt ?? '', now)
  }
}

// The summary of each candidate session this poll: from this window's memory, else from its transcript, which is read for at most
// SUMMARY_READS_PER_POLL sessions (the rest wait for a later poll). A remembered summary that is not final is read again once its retry
// time has passed. Nothing is stored. With the setting off nothing is read and no session has one.
async function summariesOf($: EngineInterface, records: readonly ProjectedRecord[]): Promise<Map<string, SessionSummary>> {
  const summaries = new Map<string, SessionSummary>()
  await clearStoredSummaries($)
  if ((await $.store.get(SUMMARY_SETTING_KEY)) === false) return summaries
  const now = await $.clock.now()
  const unknown: ProjectedRecord[] = []
  for (const record of records) {
    const remembered = summaryMemory.get(record.sessionId)
    if (remembered === undefined || (remembered.retryAt !== null && now >= remembered.retryAt)) unknown.push(record)
    else summaries.set(record.sessionId, remembered.summary)
  }
  for (const record of unknown.slice(0, SUMMARY_READS_PER_POLL)) {
    const read = await readSummaryOf($, record)
    rememberSummary(record.sessionId, { summary: read.summary, retryAt: read.final ? null : now + SUMMARY_RETRY_MS, longPrompt: read.longPrompt })
    summaries.set(record.sessionId, read.summary)
  }
  await applyBriefs($, summaries, now)
  return summaries
}

// ---- plan steps (SPEC section 22): each session's update_plan or TodoWrite calls, read from the new bytes of its transcript ----

// The sessions whose steps one poll reads, the sessions whose cursor this window keeps (the least recently read out), and the time limit
// of one read. A read takes the bytes after the session's offset; the engine cuts stdout at 4 MiB, so a longer file is read over polls.
const STEP_READS_PER_POLL = 5
const STEP_SESSIONS_MAX = 64
// One session's place in its transcript: the bytes read so far, its plan cursor, and the session's last activity when it was read.
type StepMemory = { offset: number; cursor: StepCursor; activityAt: number }
const stepMemory = new Map<string, StepMemory>()
let stepsFailureLogged = false

// Forgets this window's step cursors and its failure log. The tests call it before each host starts.
export function resetStepMemory(): void {
  stepMemory.clear()
  stepsFailureLogged = false
  explainsInFlight.clear()
  explainPausedUntil = 0
  explainFailureLogged = false
}

// A steps failure, logged once by the error's name: a path never reaches the log.
function logStepsFailureOnce($: EngineInterface, error: unknown): void {
  if (stepsFailureLogged) return
  stepsFailureLogged = true
  logLine($, `session steps failed (${failureNameOf(error)})`)
}

// The complete lines of a read and their size in bytes: a last segment with no newline after it may be half-written (or cut at the
// engine's limit), so it is left for the next read.
function completeLinesOf(text: string): { lines: string[]; bytes: number } {
  const end = text.lastIndexOf('\n')
  if (end === -1) return { lines: [], bytes: 0 }
  const whole = text.slice(0, end + 1)
  return { lines: whole.split('\n').slice(0, -1), bytes: new TextEncoder().encode(whole).length }
}

// The bytes of a session's transcript after an offset, read with tail; null when the session has no transcript path, or the read fails.
async function transcriptTailOf($: EngineInterface, record: ProjectedRecord, offset: number): Promise<string | null> {
  const home = await $.env.get('HOME')
  if (!home || record.cwd === null || !TRANSCRIPT_ID.test(record.cliSessionId)) return null
  const path = `${home}/.claude/projects/${transcriptFolderOf(record.cwd)}/${record.cliSessionId}.jsonl`
  const run = await $.process.run(['tail', '-c', `+${offset + 1}`, path], { timeoutMs: TRANSCRIPT_TIMEOUT_MS })
  return run.exitCode === 0 ? run.stdout : null
}

// Keeps one session's step memory; past STEP_SESSIONS_MAX the least recently read session goes.
function rememberSteps(sessionId: string, memory: StepMemory): void {
  stepMemory.delete(sessionId)
  stepMemory.set(sessionId, memory)
  const oldest = stepMemory.keys().next()
  if (stepMemory.size > STEP_SESSIONS_MAX && !oldest.done) stepMemory.delete(oldest.value)
}

// The plan steps of each candidate session. A session is read again only when it has had activity since its last read, at most
// STEP_READS_PER_POLL per poll, and only its new bytes: each session keeps its byte offset, so a long transcript costs one full read.
async function stepsOfSessions($: EngineInterface, records: readonly ProjectedRecord[]): Promise<Map<string, SessionSteps>> {
  const steps = new Map<string, SessionSteps>()
  let reads = 0
  for (const record of records) {
    const known = stepMemory.get(record.sessionId)
    let memory = known
    if (reads < STEP_READS_PER_POLL && (known === undefined || record.lastActivityAt > known.activityAt)) {
      reads += 1
      const offset = known?.offset ?? 0
      const text = await transcriptTailOf($, record, offset).catch((error: unknown) => {
        logStepsFailureOnce($, error)
        return null
      })
      if (text !== null) {
        const read = completeLinesOf(text)
        memory = {
          offset: offset + read.bytes,
          cursor: stepsAfter(known?.cursor ?? EMPTY_CURSOR, read.lines),
          // A read that left a partial line (half-written, or past the engine's cut) is read again on the next poll.
          activityAt: read.bytes === new TextEncoder().encode(text).length ? record.lastActivityAt : Number.NEGATIVE_INFINITY,
        }
        rememberSteps(record.sessionId, memory)
      }
    }
    if (memory !== undefined) steps.set(record.sessionId, { events: memory.cursor.events, current: currentStepOf(memory.cursor) })
  }
  return explainSteps($, steps, cursorsOf(steps))
}

// The step cursors of this poll's sessions, by session id.
function cursorsOf(steps: Map<string, SessionSteps>): Map<string, StepCursor> {
  return new Map([...steps.keys()].flatMap(id => {
    const cursor = stepMemory.get(id)?.cursor
    return cursor === undefined ? [] : [[id, cursor] as const]
  }))
}

// ---- step explanations (SPEC section 24): one sentence or two per plan step, written by Haiku from the step's title and the session's
// own words while it ran, stored under `explains` so a later window draws them with no call ----

const EXPLAINS_KEY = 'explains'
// The most model calls started per poll, the most explanations kept in the store (the oldest out), and the least context worth a call.
const EXPLAINS_PER_POLL = 2
const EXPLAIN_KEEP_MAX = 500
const EXPLAIN_CONTEXT_MIN = 40
// Only a session's newest steps are explained: those a closed timeline shows, and 64 sessions of them stay under EXPLAIN_KEEP_MAX, so
// no stored explanation is pushed out and asked again.
const EXPLAIN_NEWEST = 7
const explainsInFlight = new Set<string>()
// After a failure no step is asked before this time: a model that fails one step is likely down for all of them.
let explainPausedUntil = 0
let explainFailureLogged = false
// The explains store is read and written back one landed explanation at a time, so two landing together never overwrite each other.
let explainWrites: Promise<void> = Promise.resolve()

// The store key of one step's explanation: its session, its start time and its text.
const explainKeyOf = (sessionId: string, event: { at: number; text: string }): string => `${sessionId}|${event.at}|${event.text}`

// The stored explanations, by key; anything malformed is left out, and a refused read is none.
async function storedExplainsOf($: EngineInterface): Promise<Record<string, StoredBrief>> {
  const raw = await $.store.get(EXPLAINS_KEY).catch(() => null)
  const explains: Record<string, StoredBrief> = {}
  if (!isObject(raw)) return explains
  for (const [key, value] of Object.entries(raw)) {
    if (isObject(value) && typeof value.text === 'string' && typeof value.at === 'number') explains[key] = { text: value.text, at: value.at }
  }
  return explains
}

// An explanation failure, logged once by its reason or the error's name: a step's words never reach the log.
function logExplainFailureOnce($: EngineInterface, reason: string): void {
  if (explainFailureLogged) return
  explainFailureLogged = true
  logLine($, `step explanation failed (${reason})`)
}

// Asks the model for one step's explanation, without waiting: it is stored and drawn on the next poll (a poll of its own per explanation
// would spend the gh budget). A failure leaves the title alone and pauses every explanation for SUMMARY_RETRY_MS.
function startExplain($: EngineInterface, key: string, event: StepEvent, now: number): void {
  explainsInFlight.add(key)
  const ask = async (): Promise<void> => {
    const reply = await $.model.complete(explainRequestOf(event.text, event.context, await read($, langAtom)))
    const text = reply.isAnswered ? briefOfReply(reply.text) : null
    if (text === null) {
      logExplainFailureOnce($, reply.isAnswered ? 'empty-reply' : reply.reason)
      explainPausedUntil = now + SUMMARY_RETRY_MS
      return
    }
    const at = await $.clock.now()
    const write = explainWrites.then(async () => {
      const kept = Object.entries({ ...(await storedExplainsOf($)), [key]: { text, at } })
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, EXPLAIN_KEEP_MAX)
      await $.store.set(EXPLAINS_KEY, Object.fromEntries(kept))
    })
    explainWrites = write.catch(() => undefined)
    await write
  }
  void ask()
    .catch((error: unknown) => {
      logExplainFailureOnce($, failureNameOf(error))
      explainPausedUntil = now + SUMMARY_RETRY_MS
    })
    .finally(() => explainsInFlight.delete(key))
}

// Each step event with its stored explanation as its detail. Of a session's EXPLAIN_NEWEST newest steps, a finished one (not the one in
// progress, whose words still grow) with enough context and no explanation is asked of the model, newest first, at most
// EXPLAINS_PER_POLL per poll, never twice at once. No call is made while the pane is closed, the summary setting is off, or a failure
// has paused them.
async function explainSteps($: EngineInterface, steps: Map<string, SessionSteps>, cursors: Map<string, StepCursor>): Promise<Map<string, SessionSteps>> {
  if (steps.size === 0) return steps
  const stored = await storedExplainsOf($)
  const now = await $.clock.now()
  const calls =
    now >= explainPausedUntil && (await read($, openAtom)) && (await $.store.get(SUMMARY_SETTING_KEY).catch(() => undefined)) !== false
  let started = 0
  const explained = new Map<string, SessionSteps>()
  for (const [id, sessionSteps] of steps) {
    const cursor = cursors.get(id)
    explained.set(id, {
      ...sessionSteps,
      events: sessionSteps.events.map(event => ({ at: event.at, text: event.text, detail: stored[explainKeyOf(id, event)]?.text ?? null })),
    })
    for (const event of [...(cursor?.events ?? [])].sort((a, b) => b.at - a.at).slice(0, EXPLAIN_NEWEST)) {
      const key = explainKeyOf(id, event)
      if (!calls || started >= EXPLAINS_PER_POLL) break
      if (stored[key] !== undefined || event.text === sessionSteps.current || event.context.length < EXPLAIN_CONTEXT_MIN) continue
      if (explainsInFlight.has(key)) continue
      started += 1
      startExplain($, key, event, now)
    }
  }
  return explained
}

// The first PR of each branch, in the order gh lists them (most recently updated first).
function pullRequestsByBranch(prs: readonly PullRequest[]): Map<string, PullRequest> {
  const byBranch = new Map<string, PullRequest>()
  for (const pr of prs) if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr)
  return byBranch
}

// ---- the legend's accordion (SPEC section 19): open in the store under `legendOpen`, true when open and absent when closed ----

const LEGEND_OPEN_KEY = 'legendOpen'
// The legend store operations this window has logged a failure of, once each (the operation's name only).
const loggedLegendFailures = new Set<string>()

// Forgets this window's legend failure log. The tests call it before each host starts.
export function resetLegendMemory(): void {
  loggedLegendFailures.clear()
}

// A legend store failure: logged once per operation, by the error's name.
function logLegendStoreFailureOnce($: EngineInterface, operation: string, error: unknown): void {
  if (loggedLegendFailures.has(operation)) return
  loggedLegendFailures.add(operation)
  logLine($, `legend store ${operation} failed (${failureNameOf(error)})`)
}

// Whether the legend is open. A refused read draws it closed, logged once.
async function legendOpenOf($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(LEGEND_OPEN_KEY)) === true
  } catch (error) {
    logLegendStoreFailureOnce($, 'read', error)
    return false
  }
}

// Flips the legend from the store: opening stores `true`, closing deletes the key. A refused write is logged once, and the redraw goes on.
async function toggleLegend($: EngineInterface): Promise<void> {
  const open = await legendOpenOf($)
  try {
    if (open) await $.store.delete(LEGEND_OPEN_KEY)
    else await $.store.set(LEGEND_OPEN_KEY, true)
  } catch (error) {
    logLegendStoreFailureOnce($, open ? 'delete' : 'write', error)
  }
  $.ui.invalidate('ui.render')
}

// ---- each session's Earlier events (SPEC section 22): the sessions whose earlier events are open, in the store under `timelineOpen` ----

const TIMELINE_OPEN_KEY = 'timelineOpen'
// The open sessions the store keeps; past it the first opened goes.
const TIMELINE_OPEN_MAX = 64

// The sessions whose earlier events are open. A refused or malformed read draws them all closed (a refused read is logged once).
async function timelineOpenOf($: EngineInterface): Promise<Set<string>> {
  try {
    const raw = await $.store.get(TIMELINE_OPEN_KEY)
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [])
  } catch (error) {
    logLegendStoreFailureOnce($, 'timeline read', error)
    return new Set()
  }
}

// Opens or closes one session's earlier events in the store; the last one closed deletes the key. A refused write is logged once.
async function toggleTimeline($: EngineInterface, sessionId: string): Promise<void> {
  const open = await timelineOpenOf($)
  if (open.has(sessionId)) open.delete(sessionId)
  else open.add(sessionId)
  const kept = [...open].slice(-TIMELINE_OPEN_MAX)
  try {
    if (kept.length === 0) await $.store.delete(TIMELINE_OPEN_KEY)
    else await $.store.set(TIMELINE_OPEN_KEY, kept)
  } catch (error) {
    logLegendStoreFailureOnce($, 'timeline write', error)
  }
  $.ui.invalidate('ui.render')
}

// ---- repo logos (SPEC section 11): one lookup per repo per TTL, kept in the store and in this window's memory; the render reads them and starts nothing ----

// The store keys whose lookup runs now in this window: a repo is looked up one at a time, however many polls start meanwhile.
const logoLookups = new Set<string>()
// The logos this window has read or written, by store key, with their ages: a poll or a render reads the store only on a miss. A lookup
// that failed to write is still kept here, so the next poll does not look that repo up again.
const logoCache = new Map<string, StoredLogo>()
// The store operations this window has logged a failure of, once each (the error's name only).
const loggedLogoFailures = new Set<string>()
// This window's last issue view and the updatedAt it was read at: the same updatedAt means the same issue, so the call is not repeated.
let windowIssueMemory: { key: string; updatedAt: string; view: IssueView } | undefined
// Whether glab runs on this host, once a definite answer is in (a timeout is asked again).
let glabFound: boolean | undefined
// The host of gh's own GitHub: gh is asked only for it (an enterprise or alias host has no --hostname here).
const GITHUB_HOST = 'github.com'

// Forgets the logo, lock, glab, ssh alias, remote and issue-view memory of this window: a host (a test) starts with none.
export function resetLogoMemory(): void {
  logoLookups.clear()
  logoCache.clear()
  loggedLogoFailures.clear()
  windowIssueMemory = undefined
  glabFound = undefined
  sshHostCache.clear()
  sshFailureLogged = false
  remoteCache.clear()
}

// What one lookup reads: the repo's key, its remote (the host, and the gh slug) and the session's folder (the checkout).
type LogoTarget = { key: string; repo: Repo; cwd: string }
// The drawable SVG a lookup found (null for none) and the failure it hit (null when it got an answer).
type LogoFound = { source: string | null; failure: string | null }
const NO_LOGO: LogoFound = { source: null, failure: null }
// The avatar fetch's time limit: curl gives up at 8 s (AVATAR_FETCH_SCRIPT), the engine a little after.
const AVATAR_TIMEOUT_MS = 10_000

// A logo store failure: logged once per operation, by the error's name (a stored value never reaches the log).
function logLogoStoreFailureOnce($: EngineInterface, operation: string, error: unknown): void {
  if (loggedLogoFailures.has(operation)) return
  loggedLogoFailures.add(operation)
  logLine($, `logo store ${operation} failed (${failureNameOf(error)})`)
}

// A repo's stored logo: from memory, else from the store (kept in memory once read). A refused read is no entry, logged once.
async function storedLogoOf($: EngineInterface, storeKey: string): Promise<StoredLogo | undefined> {
  const cached = logoCache.get(storeKey)
  if (cached !== undefined) return cached
  try {
    const stored = readStoredLogo(await $.store.get(storeKey))
    if (stored !== undefined) logoCache.set(storeKey, stored)
    return stored
  } catch (error) {
    logLogoStoreFailureOnce($, 'read', error)
    return undefined
  }
}

// Keeps a repo's logo in memory and in the store. A refused write is logged once; the memory keeps the answer all the same.
async function rememberLogoOf($: EngineInterface, storeKey: string, stored: StoredLogo): Promise<void> {
  logoCache.set(storeKey, stored)
  try {
    await $.store.set(storeKey, stored)
  } catch (error) {
    logLogoStoreFailureOnce($, 'write', error)
  }
}

// Drops a repo's logo from memory and from the store. A refused delete is logged once.
async function forgetLogoOf($: EngineInterface, storeKey: string): Promise<void> {
  logoCache.delete(storeKey)
  try {
    await $.store.delete(storeKey)
  } catch (error) {
    logLogoStoreFailureOnce($, 'delete', error)
  }
}

// Whether another window's lookup of the repo holds the lock (a `logo-lock:<key>` marker younger than LOGO_LOCK_MS). A refused read holds none.
async function lockedElsewhereOf($: EngineInterface, key: string, now: number): Promise<boolean> {
  try {
    return isLogoLockLive(await $.store.get(logoLockKeyOf(key)), now)
  } catch (error) {
    logLogoStoreFailureOnce($, 'lock read', error)
    return false
  }
}

// Writes the lock marker of a lookup, or deletes it after; a refused call is logged once, and the lookup goes on without the lock.
async function writeLockOf($: EngineInterface, key: string, at: number): Promise<void> {
  try {
    await $.store.set(logoLockKeyOf(key), { at })
  } catch (error) {
    logLogoStoreFailureOnce($, 'lock write', error)
  }
}

async function deleteLockOf($: EngineInterface, key: string): Promise<void> {
  try {
    await $.store.delete(logoLockKeyOf(key))
  } catch (error) {
    logLogoStoreFailureOnce($, 'lock delete', error)
  }
}

// Starts a lookup for each repo of the admitted sessions whose stored logo is missing or stale, then prunes the stored logos of the
// repos this window does not show. It never waits for a lookup.
async function requestRepoLogos($: EngineInterface, candidates: readonly Candidate[]): Promise<void> {
  const now = await $.clock.now()
  const shown = new Set<string>()
  for (const { record, remote } of candidates) {
    const key = logoKeyOf(remote)
    if (key === null) continue
    const storeKey = logoStoreKeyOf(key)
    if (shown.has(storeKey)) continue
    shown.add(storeKey)
    const stored = await storedLogoOf($, storeKey)
    if (stored !== undefined && isLogoFresh(stored, now)) continue
    if (remote !== null && record.cwd !== null) startLogoLookup($, storeKey, { key, repo: remote, cwd: record.cwd })
  }
  await pruneLogos($, shown, now)
}

// Starts the lookup of a repo unless one runs for it already.
function startLogoLookup($: EngineInterface, storeKey: string, target: LogoTarget): void {
  if (logoLookups.has(storeKey)) return
  logoLookups.add(storeKey)
  void lookupLogo($, storeKey, target)
    .catch(() => undefined)
    .finally(() => logoLookups.delete(storeKey))
}

// One lookup, under the cross-window lock: its answer (the logo, none, or a failure) is kept and the pane is redrawn. A failure is logged
// by its kind and kept for LOGO_RETRY_MS; a lookup that throws is logged by the error's name only.
async function lookupLogo($: EngineInterface, storeKey: string, target: LogoTarget): Promise<void> {
  try {
    const now = await $.clock.now()
    if (await lockedElsewhereOf($, target.key, now)) return
    await writeLockOf($, target.key, now)
    try {
      const found = await logoOf($, target)
      if (found.failure !== null) logLine($, `logo lookup failed (${found.failure})`)
      await rememberLogoOf($, storeKey, { source: found.source, at: now, failed: found.failure !== null })
      $.ui.invalidate('ui.render')
    } finally {
      await deleteLockOf($, target.key)
    }
  } catch (error) {
    logLine($, `logo lookup failed (${failureNameOf(error)})`)
  }
}

// A repo's logo (SPEC section 11): the checkout's logo file first; else, for a repo on github.com, GitHub's contents and then the owner's
// avatar; else, for a GitLab repo, the project's avatar through glab. Any other host gets the checkout's logo only.
async function logoOf($: EngineInterface, target: LogoTarget): Promise<LogoFound> {
  const local = await localLogoOf($, target.cwd)
  if (local !== null) return { source: local, failure: null }
  if (target.repo.host === GITHUB_HOST) return githubLogoOf($, target)
  return isGitlabHost(target.repo.host) ? gitlabAvatarOf($, target) : NO_LOGO
}

// The checkout's logo file as a drawable SVG, or null when it holds none this module draws. Every logo folder is listed (a missing one
// lists as empty); the file is read only once it is chosen. Links are never read (logoPathIn).
async function localLogoOf($: EngineInterface, cwd: string): Promise<string | null> {
  const listings = new Map<string, readonly FsEntry[]>()
  await Promise.all(
    LOGO_FOLDERS.map(async folder => {
      listings.set(folder, await $.fs.list(folder === '.' ? cwd : `${cwd}/${folder}`).catch(() => []))
    }),
  )
  const path = logoPathIn(listings)
  if (path === null) return null
  const file = await $.fs.read(`${cwd}/${path}`, { as: 'bytes' }).catch(() => null)
  return file === null ? null : pictureDocumentOf(file.base64)
}

// A GitHub repo's logo: GitHub's contents first, then the owner's avatar when the contents hold no logo and no lookup failed.
async function githubLogoOf($: EngineInterface, target: LogoTarget): Promise<LogoFound> {
  const contents = await githubContentsLogoOf($, target)
  if (contents.source !== null || contents.failure !== null) return contents
  return ownerAvatarOf($, target)
}

// GitHub's contents of the first GITHUB_LOGO_CALLS paths, in order, stopping at the first logo. A path the repo does not hold (HTTP 4xx)
// is the next one; any other failure ends the lookup as a failure.
async function githubContentsLogoOf($: EngineInterface, target: LogoTarget): Promise<LogoFound> {
  for (const path of LOGO_PATHS.slice(0, GITHUB_LOGO_CALLS)) {
    const outcome = await runGh($, ['api', `repos/${slugOf(target.repo)}/contents/${path}`], target.cwd)
    if (!outcome.ok) {
      if (outcome.kind !== 'HTTP 4xx') return failedLookupOf(outcome)
      continue
    }
    const source = contentsLogoOf(parseJsonText(outcome.stdout))
    if (source !== null) return { source, failure: null }
  }
  return NO_LOGO
}

// A gh call that failed as a lookup result: an HTTP 4xx is an answer (the repo or owner has no such thing), any other failure is kept.
function failedLookupOf(outcome: { kind: string }): LogoFound {
  return outcome.kind === 'HTTP 4xx' ? NO_LOGO : { source: null, failure: outcome.kind }
}

// The owner's avatar of a GitHub repo, when the owner is an organization (`gh api users/<owner>`: its type, then its avatar URL). A user's
// avatar is not drawn. The avatar is asked at AVATAR_SIZE_PX.
async function ownerAvatarOf($: EngineInterface, target: LogoTarget): Promise<LogoFound> {
  const account = `users/${target.repo.owner}`
  const type = await runGh($, ['api', account, '--jq', '.type'], target.cwd)
  if (!type.ok) return failedLookupOf(type)
  if (type.stdout.trim() !== 'Organization') return NO_LOGO
  const avatar = await runGh($, ['api', account, '--jq', '.avatar_url'], target.cwd)
  if (!avatar.ok) return failedLookupOf(avatar)
  const url = avatarUrlOf(avatar.stdout.trim(), GITHUB_AVATAR_HOST, AVATAR_SIZE_PX)
  return url === null ? NO_LOGO : avatarLogoOf($, url)
}

// The GitLab project's avatar through glab, when glab is installed; without glab there is no GitLab avatar and no failure. The project is
// asked by its URL-encoded path, on its own host (--hostname); its avatar must be on that host too.
async function gitlabAvatarOf($: EngineInterface, target: LogoTarget): Promise<LogoFound> {
  const installed = await glabInstalled($)
  if (installed === 'timeout') return { source: null, failure: 'glab' }
  if (!installed) return NO_LOGO
  const project = encodeURIComponent(slugOf(target.repo))
  try {
    const run = await $.process.run(['glab', 'api', `projects/${project}`, '--hostname', target.repo.host], {
      cwd: target.cwd,
      timeoutMs: GH_TIMEOUT_MS,
    })
    if (run.exitCode !== 0) return { source: null, failure: 'glab' }
    const url = projectAvatarUrlOf(parseJsonText(run.stdout), target.repo.host)
    return url === null ? NO_LOGO : avatarLogoOf($, url)
  } catch {
    return { source: null, failure: 'glab' }
  }
}

// Whether glab runs on this host. A definite answer is kept (its exit code, or a missing binary); a timeout is 'timeout': no answer is
// kept, so the lookup fails (kept an hour, LOGO_RETRY_MS) and the next one asks glab again.
async function glabInstalled($: EngineInterface): Promise<boolean | 'timeout'> {
  if (glabFound !== undefined) return glabFound
  try {
    const run = await $.process.run(['glab', '--version'], { timeoutMs: GH_TIMEOUT_MS })
    glabFound = run.exitCode === 0
    return glabFound
  } catch (error) {
    if (ghStartError(error) === 'gh-timeout') return 'timeout'
    glabFound = false
    return false
  }
}

// A fetched avatar as a drawable SVG. The fetch is curl through base64 (AVATAR_FETCH_SCRIPT; the URL is its one argument). A fetch that
// fails (curl missing, a non-200, a timeout) is a failure, the same as a failed gh call; an answer that is not a PNG or a JPEG under the
// cap is no logo.
async function avatarLogoOf($: EngineInterface, url: string): Promise<LogoFound> {
  try {
    const run = await $.process.run(['sh', '-c', AVATAR_FETCH_SCRIPT, 'keepaway-logo', url], { timeoutMs: AVATAR_TIMEOUT_MS })
    if (run.exitCode !== 0 || run.stdout.trim() === '') return { source: null, failure: 'avatar fetch' }
    // An answer the engine cut at its own cap is over the logo cap as well: no logo.
    return { source: run.isStdoutTruncated ? null : pictureDocumentOf(run.stdout), failure: null }
  } catch {
    return { source: null, failure: 'avatar fetch' }
  }
}

// The store's keys, or none when the store refuses the listing (logged once).
async function logoKeysOf($: EngineInterface): Promise<string[]> {
  try {
    return await $.store.keys()
  } catch (error) {
    logLogoStoreFailureOnce($, 'keys', error)
    return []
  }
}

// Drops the stored logos of the repos this window does not show once they have expired (or are unreadable), then the oldest of the others
// past LOGO_STORE_MAX: the store is shared by every window. The keys are listed on each poll; a payload is read only on a miss.
async function pruneLogos($: EngineInterface, shown: ReadonlySet<string>, now: number): Promise<void> {
  const others: { key: string; at: number }[] = []
  for (const key of await logoKeysOf($)) {
    if (!isLogoStoreKey(key) || shown.has(key)) continue
    const stored = await storedLogoOf($, key)
    if (stored === undefined || !isLogoFresh(stored, now)) await forgetLogoOf($, key)
    else others.push({ key, at: stored.at })
  }
  const excess = others.length + shown.size - LOGO_STORE_MAX
  others.sort((first, second) => first.at - second.at)
  for (const { key } of others.slice(0, Math.max(0, excess))) await forgetLogoOf($, key)
}

// The drawn logos of the repos the snapshot's sessions show, by logoKey. Read from memory or the store: a render looks nothing up.
async function logosOf($: EngineInterface, snapshot: Snapshot | null): Promise<ReadonlyMap<string, string>> {
  const logos = new Map<string, string>()
  const seen = new Set<string>()
  for (const node of flattenNodes(snapshot?.sessions ?? [])) {
    if (node.logoKey === null || seen.has(node.logoKey)) continue
    seen.add(node.logoKey)
    const source = (await storedLogoOf($, logoStoreKeyOf(node.logoKey)))?.source
    if (source !== undefined && source !== null) logos.set(node.logoKey, source)
  }
  return logos
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

// gh's own wording when it cannot reach GitHub ("error connecting to api.github.com", a failed DNS lookup, a dropped link).
// "could not resolve host" only: GraphQL's "Could not resolve to an Issue" is an answer, not a DNS failure.
const GH_NETWORK = /error connecting|internet connection|could not resolve host|no such host|dial tcp|connection (refused|reset)|network is unreachable|i\/o timeout|tls handshake/i

// gh's wording for a token GitHub refuses, a link dropped mid-answer, a server error, a GraphQL error and a client error.
const GH_TOKEN = /bad credentials|HTTP 401/i
const GH_CUT = /unexpected EOF|context deadline exceeded|stream error|broken pipe/i
const GH_HTTP_5XX = /HTTP 5\d\d/
const GH_GRAPHQL = /GraphQL:/
const GH_HTTP_4XX = /HTTP 4\d\d/

// The kind of a gh failure as the log names it: never stderr itself, since it can carry a path or a URL.
function ghFailureKind(error: PaneError, stderr = ''): string {
  if (error === 'gh-auth') return 'login'
  if (error === 'gh-rate-limit') return 'rate limit'
  if (error === 'gh-timeout') return 'timeout'
  if (error === 'gh-missing') return 'gh missing'
  if (GH_TOKEN.test(stderr)) return 'invalid token'
  if (GH_NETWORK.test(stderr)) return 'network/DNS'
  if (GH_CUT.test(stderr)) return 'connection cut'
  if (GH_HTTP_5XX.test(stderr)) return 'HTTP 5xx'
  if (GH_GRAPHQL.test(stderr)) return 'GraphQL'
  if (GH_HTTP_4XX.test(stderr)) return 'HTTP 4xx'
  return 'other'
}

async function runGh($: EngineInterface, argv: readonly string[], cwd: string): Promise<GhOutcome> {
  try {
    const run = await $.process.run(['gh', ...argv], { cwd, timeoutMs: GH_TIMEOUT_MS })
    if (run.exitCode !== 0) {
      const error = ghExitError(run.stderr)
      return { ok: false, error, kind: ghFailureKind(error, run.stderr) }
    }
    const oversized = run.isStdoutTruncated || new TextEncoder().encode(run.stdout).byteLength > GH_OUTPUT_MAX_BYTES
    return { ok: true, stdout: run.stdout, oversized }
  } catch (error) {
    const paneError = ghStartError(error)
    return { ok: false, error: paneError, kind: ghFailureKind(paneError) }
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
    logLine($, `gh ${argv[0] ?? ''} call failed (${outcome.kind})`)
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
  // REST's counts (the PRs included) are not exact until milestonesCountedOf takes the GraphQL counts.
  return {
    number,
    title,
    openIssues,
    closedIssues,
    dueOn: textOf(childOf(raw, 'due_on')),
    countsExact: false,
    description: objectiveOf(textOf(childOf(raw, 'description'))),
  }
}

// A milestone's description as its objective: plain text, cut to OBJECTIVE_MAX at the last space before the limit; null when empty.
function objectiveOf(description: string | null): string | null {
  const text = plain(description ?? '', Number.POSITIVE_INFINITY)
  return text === '' ? null : cutAtWord(text, OBJECTIVE_MAX)
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
    milestoneTitle: plain(textOf(childOf(childOf(raw, 'milestone'), 'title')) ?? '', LABEL_MAX) || null,
    labels: namesOf(childOf(raw, 'labels'), 'name'),
    updatedAt,
    url,
  }
}

// The issue counts of one milestone: its open and its closed issues, from GraphQL (no PR is in them).
type IssueCount = { open: number; closed: number }
// The open issues (the rows), the items the list holds, and the items that did not read (RB1-5). null when it is no list, or when no
// item of a non-empty list reads: that answer is as unreadable as text that does not parse.
type IssuePage = { issues: Issue[]; listed: number; dropped: number }

function parseIssues(text: string): IssuePage | null {
  const value = parseJsonText(text)
  if (!Array.isArray(value)) return null
  const issues = value.map(issueOf).filter(isPresent)
  if (value.length > 0 && issues.length === 0) return null
  return { issues, listed: value.length, dropped: value.length - issues.length }
}

// The exact counts of each open milestone, by its number, from MILESTONE_QUERY. null when the answer holds no milestone list; a node that
// does not read is left out, so its milestone keeps its REST counts (not exact).
function parseMilestoneCounts(text: string): ReadonlyMap<number, IssueCount> | null {
  const nodes = childOf(childOf(childOf(childOf(parseJsonText(text), 'data'), 'repository'), 'milestones'), 'nodes')
  if (!Array.isArray(nodes)) return null
  const counts = new Map<number, IssueCount>()
  for (const node of nodes) {
    const number = numberOf(childOf(node, 'number'))
    const open = numberOf(childOf(childOf(node, 'open'), 'totalCount'))
    const closed = numberOf(childOf(childOf(node, 'closed'), 'totalCount'))
    if (number !== null && open !== null && closed !== null) counts.set(number, { open, closed })
  }
  return counts
}

// The issues a PR closes in this repo. A reference to another repo's issue names no issue here (gh3-5), so only the nodes whose
// repository is this repo count. None when GitHub holds more than the page read, since the lowest of a partial page may not be the
// lowest (DL9): the session then maps by its next signal (repo-work-pane-design-spec.md D1).
function closingIssuesOf(references: unknown, slug: string): number[] {
  const total = numberOf(childOf(references, 'totalCount'))
  if (total !== null && total > CLOSING_LIMIT) return []
  return asArray(childOf(references, 'nodes')).flatMap(node => {
    const number = numberOf(childOf(node, 'number'))
    const repository = textOf(childOf(childOf(node, 'repository'), 'nameWithOwner'))
    const isThisRepo = repository !== null && repository.toLowerCase() === slug.toLowerCase()
    return number === null || !isThisRepo ? [] : [number]
  })
}

function checksOf(commits: unknown): PullRequest['checks'] {
  const [head] = asArray(childOf(commits, 'nodes'))
  return oneOf(childOf(childOf(childOf(head, 'commit'), 'statusCheckRollup'), 'state'), CHECK_STATES)
}

function pullRequestOf(raw: unknown, slug: string): PullRequest | null {
  // A PR from a fork is no PR of this repo, though its head branch may share a name with a local branch (gh3-2).
  if (childOf(raw, 'isCrossRepository') === true) return null
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
    closes: closingIssuesOf(childOf(raw, 'closingIssuesReferences'), slug),
    checks: checksOf(childOf(raw, 'commits')),
  }
}

type PullRequestPage = { prs: PullRequest[]; total: number }

// The PR page of the GraphQL answer: data.repository.pullRequests.
function parsePullRequestPage(text: string, slug: string): PullRequestPage | null {
  const pulls = childOf(childOf(childOf(parseJsonText(text), 'data'), 'repository'), 'pullRequests')
  if (!isJsonObject(pulls)) return null
  return {
    prs: asArray(pulls.nodes)
      .map(node => pullRequestOf(node, slug))
      .filter(isPresent),
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
  // Only the newest comment is kept, the one the pane draws (SE3), and the newest decision (Mock S delta 8).
  lastComment: IssueDetails['lastComment']
  decision: IssueDetails['decision']
}

// One comment of `gh issue view --json comments`: its login, its author association (OWNER, MEMBER, COLLABORATOR, ...), its time and its
// body; null when the time does not parse.
function commentOf(raw: unknown): IssueComment | null {
  const at = Date.parse(textOf(childOf(raw, 'createdAt')) ?? '')
  if (!Number.isFinite(at)) return null
  const author = plain(textOf(childOf(childOf(raw, 'author'), 'login')) ?? '', LABEL_MAX)
  const association = textOf(childOf(raw, 'authorAssociation')) ?? ''
  return { author, association, at, body: textOf(childOf(raw, 'body')) ?? '' }
}

function issueViewOf(text: string): IssueView | null {
  const raw = parseJsonText(text)
  const number = numberOf(childOf(raw, 'number'))
  const title = textOf(childOf(raw, 'title'))
  const url = textOf(childOf(raw, 'url'))
  const state = textOf(childOf(raw, 'state'))
  if (number === null || title === null || url === null || state === null) return null
  const comments = asArray(childOf(raw, 'comments')).map(commentOf).filter(isPresent)
  return {
    number,
    title: plain(title, TEXT_MAX),
    url,
    state: state.toUpperCase() === 'OPEN' ? 'open' : 'closed',
    milestoneTitle: plain(textOf(childOf(childOf(raw, 'milestone'), 'title')) ?? '', LABEL_MAX) || null,
    lastComment: newestCommentOf(comments),
    decision: newestDecisionOf(comments),
  }
}

// What the pane shows of this window's issue beside the issue view: its branch, its open PR and its last commit.
type WindowFacts = {
  node: SessionNode
  pr: PullRequest | null
  lastCommit: IssueDetails['lastCommit']
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
    decision: view.decision,
    startedAt: facts.node.createdAt,
  }
}

type WindowIssue = { details: IssueDetails | null; stale: boolean; errors: PaneError[] }

const NO_WINDOW_ISSUE: WindowIssue = { details: null, stale: false, errors: [] }

// This window's issue, by one gh call for its number (the same timeout and error mapping as the others). A failed call
// keeps no details and sets stale; the sessions never depend on it.
async function windowIssueOf(
  $: EngineInterface,
  root: string,
  repo: Repo,
  facts: WindowFacts,
  updatedAt: string | undefined,
): Promise<WindowIssue> {
  const issue = facts.node.issue
  if (issue === null) return NO_WINDOW_ISSUE
  const errors = new Set<PaneError>()
  const view = await windowViewOf($, root, repo, issue.number, updatedAt, errors)
  return view === undefined
    ? { details: null, stale: true, errors: [...errors] }
    : { details: detailsOf(view, facts), stale: false, errors: [] }
}

// The issue view of this window's issue. The last one is reused while the issue's updatedAt has not changed (a comment or an edit moves
// it), so a poll that finds no change makes no call; an issue the open list does not hold (no updatedAt) is always asked.
async function windowViewOf(
  $: EngineInterface,
  root: string,
  repo: Repo,
  number: number,
  updatedAt: string | undefined,
  errors: Set<PaneError>,
): Promise<IssueView | undefined> {
  const key = `${slugOf(repo).toLowerCase()}#${number}`
  const last = windowIssueMemory
  if (updatedAt !== undefined && last?.key === key && last.updatedAt === updatedAt) return last.view
  const argv = ['issue', 'view', String(number), '--repo', slugOf(repo), '--json', ISSUE_VIEW_FIELDS]
  const view = await fetchPart($, argv, root, issueViewOf, errors)
  if (view !== undefined && updatedAt !== undefined) windowIssueMemory = { key, updatedAt, view }
  return view
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
  const commit = sessions.commits.get(node.id)?.[0] ?? null
  const lastCommit = commit === null ? null : { at: commit.at, subject: commit.subject, url: commitPageOf(repo, commit.sha) }
  const updatedAt = github.issues.find(issue => issue.number === node.issue?.number)?.updatedAt
  return windowIssueOf($, root, repo, { node, pr, lastCommit }, updatedAt)
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
    memory.issuesTruncated = issues.listed > ISSUE_LIMIT
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

// The milestones with their exact issue counts from GraphQL (pm1-8). A milestone the answer does not hold keeps its REST counts, which
// count the PRs too, and stays not exact.
function milestonesCountedOf(milestones: Milestone[], counts: ReadonlyMap<number, IssueCount> | undefined): Milestone[] {
  return milestones.map(milestone => {
    const count = counts?.get(milestone.number)
    return count === undefined ? milestone : { ...milestone, openIssues: count.open, closedIssues: count.closed, countsExact: true }
  })
}

async function githubOf($: EngineInterface, context: RepoContext, seq: number): Promise<GithubPart> {
  const { repo, root } = context
  if (repo === null || root === null) return emptyGithub()
  const slug = slugOf(repo)
  const memory = memoryFor(slug)
  const errors = new Set<PaneError>()
  const [milestones, issues, page, counts] = await Promise.all([
    // Every page of open milestones, which gh merges into one list (RB1-4); GH_OUTPUT_MAX_BYTES and the timeout bound it.
    fetchPart($, ['api', '--paginate', `repos/${slug}/milestones?state=open&per_page=100`], root, parseMilestones, errors),
    // The open issues only: the rows of the pane. Only the extra item past ISSUE_LIMIT marks the list partial.
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
      text => parsePullRequestPage(text, slug),
      errors,
    ),
    // The milestone totals, one call per poll. A failure is logged by fetchPart and keeps the REST counts: it is no pane error, since
    // those counts still stand (not exact), so the throwaway set takes nothing.
    fetchPart(
      $,
      ['api', 'graphql', '-f', `query=${MILESTONE_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`],
      root,
      parseMilestoneCounts,
      new Set<PaneError>(),
    ),
  ])
  // The count only: an item's text never reaches the log.
  if (issues !== undefined && issues.dropped > 0) logLine($, `gh issue items not readable (${issues.dropped})`)
  const counted = milestones === undefined ? undefined : milestonesCountedOf(milestones, counts)
  if (isNewest(seq)) rememberGithub(memory, counted, issues, page)
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

// ---- the host's UTC offset ----

// How long `date +%z` may take; a host that answers later falls back to the runtime's offset.
const UTC_OFFSET_TIMEOUT_MS = 2_000

// The runtime's own offset in minutes east of UTC: the fallback when the host cannot say (no `date` binary, a timeout, a bad answer).
function runtimeUtcOffset(): number {
  return -new Date().getTimezoneOffset()
}

// Reads the host's offset from `date +%z` (±HHMM) into the utcOffset atom. Any failure stores the runtime's offset.
async function refreshUtcOffset($: EngineInterface): Promise<void> {
  const utcOffset = await readUtcOffset($)
  await update($, utcOffsetAtom, () => utcOffset)
}

async function readUtcOffset($: EngineInterface): Promise<number> {
  try {
    const run = await $.process.run(['date', '+%z'], { timeoutMs: UTC_OFFSET_TIMEOUT_MS })
    const minutes = run.exitCode === 0 ? parseUtcOffset(run.stdout) : null
    return minutes ?? runtimeUtcOffset()
  } catch {
    return runtimeUtcOffset()
  }
}

// One poll: the repo, the gh data, the sessions and this window's issue, then the snapshot atom (repo-work-pane-design-spec.md 2.1).
// null while the repo context has never been read (F02); refresh then marks the failure for the pane (ux4-2).
async function buildSnapshot($: EngineInterface, seq: number, epoch: number): Promise<Snapshot | null> {
  await refreshUtcOffset($)
  const now = await $.clock.now()
  const read = await repoContextOf($)
  const context = read ?? lastRepoContext
  if (context === null) return null
  // A poll from an earlier session does not hand its repo to the new one (st-6).
  if (isNewest(seq) && epoch === sessionEpoch) lastRepoContext = context
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
    issueGroups:
      context.repo === null ? [] : groupIssues(github.milestones, github.issues, linked, github.truncatedLimits.includes(ISSUE_LIMIT)),
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

// Writes the poll's snapshot, unless a newer poll has written (R2-04); a poll with no repo context yet writes no snapshot.
async function refresh($: EngineInterface, seq: number, epoch: number): Promise<void> {
  const snapshot = await buildSnapshot($, seq, epoch)
  // A poll that began under an earlier session writes nothing: the session it read is gone (state2-6).
  if (!isNewest(seq) || epoch !== sessionEpoch) return
  if (snapshot === null) return markLoadFailed($)
  writtenSeq = seq
  await update($, snapshotAtom, () => snapshot)
  $.ui.invalidate('ui.render')
}

// The poll under its deadline (F07): a poll not settled after POLL_DEADLINE_MS is abandoned, and its flag is freed. Its refresh goes
// on, and its result still writes unless a newer poll has written (R2-04). The deadline timer is cancelled once the poll settles.
async function refreshWithin($: EngineInterface, seq: number, epoch: number): Promise<void> {
  attemptedAt = await $.clock.now()
  return new Promise<void>((resolve, reject) => {
    let abandoned = false
    const deadline = $.clock.after(POLL_DEADLINE_MS, () => {
      abandoned = true
      abandonedPolls += 1
      reject(Object.assign(new Error('poll deadline'), { name: 'PollDeadline' }))
    })
    const settle = (): void => {
      if (!abandoned) {
        deadline.cancel()
        return
      }
      abandonedPolls -= 1
      // A poll queued while the abandoned polls held every slot starts now that one has settled (st-8).
      if (repollOnSettle) startPoll($)
    }
    refresh($, seq, epoch).then(
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

// The pane's Loading line ends once a poll settles with no snapshot: the failure line is drawn instead (ux4-2). The flag is read only
// while no snapshot exists, so it is not cleared when a snapshot is written.
async function markLoadFailed($: EngineInterface): Promise<void> {
  await update($, loadFailedAtom, () => true)
  $.ui.invalidate('ui.render')
}

// A poll that failed (a throw, or the deadline): the last snapshot stays, marked stale, and the error name is logged (F07). With no
// snapshot yet, the last known repo context gives an empty one, so the pane leaves Loading; with neither, the failure line is drawn.
async function failedPoll($: EngineInterface, seq: number, epoch: number, error: unknown): Promise<void> {
  logLine($, `poll failed (${failureNameOf(error)})`)
  // A poll that began under an earlier session marks nothing: the snapshot now belongs to the session that replaced it (state2-6).
  if (epoch !== sessionEpoch) return
  const previous = await read($, snapshotAtom)
  const base = previous ?? (lastRepoContext === null ? null : emptySnapshotOf(lastRepoContext, await $.clock.now()))
  // A newer poll has written: its snapshot stands, so this failure marks nothing (R2-04).
  if (!isNewest(seq)) return
  if (base === null) return markLoadFailed($)
  // The mark is set on the value stored at write time, and only while no newer poll has written (R2-04).
  await update($, snapshotAtom, current => (isNewest(seq) ? { ...(current ?? base), stale: true } : current))
  $.ui.invalidate('ui.render')
}

// One poll at a time: a tick that comes during a poll starts nothing (repo-work-pane-design-spec.md 2.5). After a deadline the flag is
// free, so the next tick may start a poll beside the abandoned one, up to MAX_ABANDONED_POLLS of them; past that, the tick logs a skip.
// A skipped poll keeps repollOnSettle: the queued poll starts once a slot frees (st-8). A poll that starts has answered the queue.
function startPoll($: EngineInterface): void {
  if (polling) return
  if (abandonedPolls >= MAX_ABANDONED_POLLS) {
    logLine($, `poll skipped (${abandonedPolls} polls past their deadline still running)`)
    return
  }
  polling = true
  repollOnSettle = false
  startedSeq += 1
  const seq = startedSeq
  const epoch = sessionEpoch
  report(
    $,
    refreshWithin($, seq, epoch)
      .catch((error: unknown) => failedPoll($, seq, epoch, error))
      .finally(() => {
        polling = false
        if (repollOnSettle) startPoll($)
      }),
  )
}

// A poll the session asks for: at once when none can start, else queued for the poll in flight or for a free slot (state2-3, st-5, st-8).
function repollSoon($: EngineInterface): void {
  if (polling || abandonedPolls >= MAX_ABANDONED_POLLS) repollOnSettle = true
  else startPoll($)
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
  const openMs = intervalOf(await $.env.get('KEEPAWAY_POLL_MS'), POLL_MS)
  const closedMs = intervalOf(await $.env.get('KEEPAWAY_BAND_POLL_MS'), BAND_POLL_MS)
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

// The band's tick: it re-reads the agents, ends a turn that lost its end, redraws on every tick while any
// agent runs, and otherwise on the cadence of bandRedrawDue. A count that changed is drawn at once, so the band shows Idle as soon
// as the last agent ends.
async function tickBand($: EngineInterface): Promise<void> {
  bandTicks += 1
  const before = await read($, agentRunAtom)
  await readAgents($).catch((error: unknown) => logLine($, `agent list failed (${failureNameOf(error)})`))
  await endStaleTurn($)
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

// ---- the /keepaway command ----

async function registerCommand($: EngineInterface, lang: Lang): Promise<void> {
  await $.command
    .register({ name: COMMAND, description: t(lang, 'command.describe') })
    .catch(() => logLine($, 'the /keepaway command was not registered'))
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

// /keepaway issue <n> sets this window's issue, /keepaway issue none clears it (repo-work-pane-design-spec.md 2.6).
async function setIssue($: EngineInterface, value: string): Promise<void> {
  const issue = issueArgOf(value)
  if (issue === null) return toastUsage($)
  const sessionId = await thisSessionLinkOf($)
  if (sessionId === null || !isSessionLinkId(sessionId)) return $.ui.toast(t(await read($, langAtom), 'toast.noSession'))
  const key = `${OVERRIDE_PREFIX}${sessionId}`
  if (issue === 'none') await $.store.delete(key)
  else await $.store.set(key, { issue, ts: await $.clock.now() })
  // A poll in flight may have read the old override: the new one is polled once it settles (st-5).
  if (await read($, openAtom)) repollSoon($)
}

// /keepaway lang en|pt-BR|auto: stores the choice (auto removes it) and switches the language at once.
async function setLanguage($: EngineInterface, value: string): Promise<void> {
  const choice = LANG_CHOICES.get(value.toLowerCase())
  if (choice === undefined) return toastUsage($)
  if (choice === 'auto') await $.store.delete(LANG_KEY)
  else await $.store.set(LANG_KEY, choice)
  const next = choice === 'auto' ? await detectedLang($) : choice
  await update($, langAtom, () => next)
  await registerCommand($, next)
}

// /keepaway summary on|off: stores the setting and answers in the session's language. An open pane polls at once, so the lines are
// drawn or hidden without waiting for the next minute.
async function setSummary($: EngineInterface, value: string): Promise<void> {
  const choice = SUMMARY_CHOICES.get(value.toLowerCase())
  if (choice === undefined) return toastUsage($)
  await $.store.set(SUMMARY_SETTING_KEY, choice)
  $.ui.toast(t(await read($, langAtom), choice ? 'toast.summaryOn' : 'toast.summaryOff'))
  if (await read($, openAtom)) repollSoon($)
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

// The errors the band does not flag: the repo line names the missing remote, and the pane says that gh is missing or not signed in
// (ux-8).
const UNFLAGGED_BAND_ERRORS: readonly PaneError[] = ['no-remote', 'gh-missing', 'gh-auth']

// The band's error flag from the snapshot: an error the band does not leave unflagged (UNFLAGGED_BAND_ERRORS).
function bandErrorOf(snapshot: Snapshot | null): boolean {
  return snapshot?.errors.some(error => !UNFLAGGED_BAND_ERRORS.includes(error)) === true
}

// A turn past TURN_MAX_AGE_MS has lost its end event (a restart, a reload): it ends here, so the band does not count it forever.
// The band redraws at once when the end changes the turn, so the Running line does not wait for the next odd tick (state2-8, rev-g1-9).
async function endStaleTurn($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (!turnExpired(await read($, turnAtom), now)) return
  await update($, turnAtom, prev => (turnExpired(prev, now) ? turnTimedOut(prev) : prev))
  $.ui.invalidate('ui.render')
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
  const now = await $.clock.now()
  await update($, turnAtom, prev => turnToolNamed(prev, name, now))
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
  const epoch = sessionEpoch
  const agents = await $.agent.list()
  const now = await $.clock.now()
  // A read that began under an earlier session writes nothing: its agents belong to that session (st-4).
  if (readNumber < agentReadsWritten || epoch !== sessionEpoch) return
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
  if (verb === 'summary') return words.length > 2 ? toastUsage($) : setSummary($, value)
  return toastUsage($)
}

// The band's waiting flag: this window's session waits for the person while the engine has put a tool call to them (tool.check
// answers ask). It clears when the call runs, when a turn starts or ends, and when a session starts. A write from a session that was
// replaced in flight writes nothing (state2-7).
async function setWaiting($: EngineInterface, waiting: boolean, epoch: number): Promise<void> {
  if (epoch !== sessionEpoch) return
  try {
    if ((await read($, waitingAtom)) === waiting) return
    await update($, waitingAtom, () => waiting)
  } catch (error: unknown) {
    logLine($, `waiting flag failed (${failureNameOf(error)})`)
    return
  }
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  // A new session drops the old timer and registers the command in the session's language.
  on('session.start', async ($, e, next) => {
    sessionEpoch += 1
    const lang = await currentLang($)
    await update($, langAtom, () => lang)
    await registerCommand($, lang)
    stopTimer()
    startBandTick($)
    // The turn, the window's issue, the waiting flag, the agent run and the session list belong to the previous session: they are
    // dropped here, and a poll still in flight from it writes nothing (its epoch is old). The new session polls at once, since the
    // last poll's time may be within the cadence.
    await update($, turnAtom, () => IDLE_TURN)
    await update($, waitingAtom, () => false)
    await update($, agentRunAtom, () => ({ count: 0, since: null }))
    await update($, snapshotAtom, snapshot =>
      snapshot === null ? null : { ...snapshot, sessions: [], thisIssue: null, thisIssueNumber: null },
    )
    // The repo of the previous session is not carried over: a failed repo read in this session draws no old repo (st-6).
    lastRepoContext = null
    await refreshUtcOffset($)
    await scheduleTimer($)
    // A poll still in flight reads the previous session: the new session's poll starts when that one settles (state2-3, st-8).
    repollSoon($)
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
    const snapshot = await read($, snapshotAtom)
    return renderPane($.ui.resolve(e), {
      snapshot,
      logos: await logosOf($, snapshot),
      loadFailed: await read($, loadFailedAtom),
      lang: await read($, langAtom),
      surface: e.surface,
      utcOffsetMinutes: await read($, utcOffsetAtom),
      legendOpen: await legendOpenOf($),
      onLegendToggle: () => void toggleLegend($).catch((error: unknown) => logLine($, `legend toggle failed (${failureNameOf(error)})`)),
      held: heldFor(e.surface, e.requestId),
      timelineOpen: await timelineOpenOf($),
      onTimelineToggle: sessionId =>
        void toggleTimeline($, sessionId).catch((error: unknown) => logLine($, `timeline toggle failed (${failureNameOf(error)})`)),
    })
  })

  // The band row above the prompt, on the desktop and the terminal, drawn from its atoms alone. A render starts no work: the band's
  // repo text comes from the poll on the window's timer (POLL_MS open, BAND_POLL_MS closed), its turn from the band tick, its waiting flag from the tool.check hook
  // (SPEC section 18).
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
        waiting: await read($, waitingAtom),
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
    if (e.agentId === undefined) await setWaiting($, false, sessionEpoch)
    report($, refreshAgents($))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await finishTurn($)
    if (e.agentId === undefined) await setWaiting($, false, sessionEpoch)
    report($, refreshAgents($))
    return next(e)
  })
  on('turn.abort', async ($, e, next) => {
    if (e.agentId === undefined) await finishTurn($)
    if (e.agentId === undefined) await setWaiting($, false, sessionEpoch)
    return next(e)
  })
  // The engine asks the person about a tool call (decision ask): this window waits until the call runs, or a verdict clears the ask.
  on('tool.check', async ($, e, next) => {
    const epoch = sessionEpoch
    const verdict = await next(e)
    await setWaiting($, verdict.decision === 'ask', epoch)
    return verdict
  })
  on('tool.call', async ($, e, next) => {
    await setWaiting($, false, sessionEpoch)
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
