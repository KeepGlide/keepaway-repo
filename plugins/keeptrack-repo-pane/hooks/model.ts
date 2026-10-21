// Pure rules of the repo work pane: the GitHub remote, the session-to-issue mapping, the session tree, the issue
// groups, the timelines, the session state and the projection of a Desktop session record. Nothing here reads the host
// or the engine; register.tsx reads and calls, pane.tsx draws. Every function is unit-tested (tests/model.test.ts).
import type {
  Issue,
  IssueDetails,
  IssueFacts,
  IssueGroup,
  IssueRef,
  Milestone,
  ProjectedRecord,
  PullRequest,
  SessionInput,
  SessionNode,
  TimelineEvent,
} from '../types'

// A Desktop record over this size is skipped by the reader before it is parsed (repo-work-pane-design-spec.md section 2.7).
export const RECORD_MAX_BYTES = 2 * 1024 * 1024
// A text field longer than this marks the record oversized: projectRecord returns null for it.
export const FIELD_MAX_LENGTH = 4096
// The deepest a session sits under its root: the family hop cap of askaway (repo-work-pane-design-spec.md D2). Deeper sessions are roots.
export const MAX_DEPTH = 8
// The newest events a session's timeline keeps (repo-work-pane-design-spec.md D6).
export const TIMELINE_LIMIT = 6
// A session counts as working for this long after its last activity (repo-work-pane-design-spec.md D7, a heuristic).
export const WORKING_WINDOW_MS = 5 * 60 * 1000
// The longest comment preview the issue details draw, in characters, the last one an ellipsis (repo-work-pane-design-spec.md D5).
export const COMMENT_PREVIEW_MAX = 200
// The highest issue number an override, a branch or a title may name (repo-work-pane-design-spec.md D1).
const ISSUE_NUMBER_MAX = 999_999

// Full-match checks without an end anchor: a match counts only when it covers the whole text (match[0] === text).
const URL_REMOTE = /^(?:https|ssh):\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)(?::\d{1,5})?\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?/
const SCP_REMOTE = /^(?:[^@/:\s]+@)?([A-Za-z0-9._-]+):([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?/
const SESSION_LINK_ID = /^local_[A-Za-z0-9_-]{1,128}/
const BRANCH_NUMBER_PREFIX = /^(?:[\w.-]+\/)?(\d{1,6})-/
const BRANCH_ISSUE_WORD = /\bissue-(\d{1,6})\b/i
const TITLE_NUMBER = /#(\d{1,6})\b/

// Text length caps of what reaches the snapshot (see plain): a title or subject 200, a label or a name 100.
export const TEXT_MAX = 200
export const LABEL_MAX = 100

const GIT_SUFFIX = '.git'

// A remote: its host (lower case), its owner and its name.
export type Remote = { host: string; owner: string; name: string }

// Host, owner and name of a remote URL that matches one pattern in full, with credentials and the .git suffix dropped.
function remoteOf(text: string, pattern: RegExp): Remote | null {
  const match = pattern.exec(text)
  if (match === null || match[0] !== text) return null
  const host = (match[1] ?? '').toLowerCase()
  const owner = match[2] ?? ''
  const rawName = match[3] ?? ''
  const name = rawName.endsWith(GIT_SUFFIX) ? rawName.slice(0, -GIT_SUFFIX.length) : rawName
  if (host === '' || owner === '' || name === '' || name === '.' || name === '..') return null
  return { host, owner, name }
}

// The host, owner and name of a remote: https, ssh, or the scp-like form of any host or ssh alias. The result never carries
// the URL or its credentials, and nothing here logs it.
export function parseRemote(url: string | null): Remote | null {
  const text = url === null ? '' : url.trim()
  return remoteOf(text, URL_REMOTE) ?? remoteOf(text, SCP_REMOTE)
}

// A host the pane treats as GitHub: github.com, or an ssh alias that names GitHub (its host contains "github").
export const isGithubHost = (host: string): boolean => host === 'github.com' || host.includes('github')

// A C0 or C1 control character (the escape character included): a terminal acts on it. Also a format character (Unicode
// category Cf, bidi overrides and isolates included), which reorders what the terminal shows; the zero width joiner stays,
// emoji sequences need it.
const isControlCharacter = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code !== 0x200d && /\p{Cf}/u.test(character))
}

// One line of text as the pane may draw it: every control character becomes a space (so no terminal acts on it), runs
// of whitespace collapse, the ends are trimmed, and the text is capped at max characters, the last one an ellipsis.
export function plain(text: string, max: number): string {
  const spaced = Array.from(text, character => (isControlCharacter(character) ? ' ' : character)).join('')
  const cleaned = spaced.replace(/\s+/g, ' ').trim()
  const characters = Array.from(cleaned)
  return characters.length <= max ? cleaned : `${characters.slice(0, max - 1).join('')}…`
}

// The results of mapItem over the list, `limit` calls at a time, in order.
export async function mapLimited<T, R>(list: readonly T[], limit: number, mapItem: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < list.length; start += limit) {
    results.push(...(await Promise.all(list.slice(start, start + limit).map(mapItem))))
  }
  return results
}

// An issue number as written in a branch or a title: 1 to 999999, else null.
function issueNumberOf(digits: string): number | null {
  const value = Number(digits)
  return value >= 1 && value <= ISSUE_NUMBER_MAX ? value : null
}

// The issue a branch names (repo-work-pane-design-spec.md D1, step 3): a leading number after an optional prefix, else an issue-<n> word.
export function issueFromBranch(branch: string): number | null {
  const match = BRANCH_NUMBER_PREFIX.exec(branch) ?? BRANCH_ISSUE_WORD.exec(branch)
  return match === null ? null : issueNumberOf(match[1] ?? '')
}

// The first hash-number reference of a session title (repo-work-pane-design-spec.md D1, step 4).
export function issueFromTitle(title: string): number | null {
  const match = TITLE_NUMBER.exec(title)
  return match === null ? null : issueNumberOf(match[1] ?? '')
}

// The issue a pull request closes for this branch: only an open PR whose head is the branch. Several issues: the lowest
// number.
function closingIssueOf(pr: PullRequest | null, branch: string | null): number | null {
  if (pr === null || branch === null || pr.headRefName !== branch) return null
  if (pr.state !== 'OPEN') return null
  return pr.closes.length === 0 ? null : Math.min(...pr.closes)
}

// The issue of one session, first match wins (repo-work-pane-design-spec.md D1): override, PR closing reference, branch, title, then the
// parent's issue for a fork or spawn only.
export function issueOfSession(input: {
  override: number | null; pr: PullRequest | null; branch: string | null; title: string
  parentIssue: IssueRef | null; isDerived: boolean
}): IssueRef | null {
  if (input.override !== null) return { number: input.override, source: 'override' }
  const closed = closingIssueOf(input.pr, input.branch)
  if (closed !== null) return { number: closed, source: 'pr' }
  const branchIssue = input.branch === null ? null : issueFromBranch(input.branch)
  if (branchIssue !== null) return { number: branchIssue, source: 'branch' }
  const titleIssue = issueFromTitle(input.title)
  if (titleIssue !== null) return { number: titleIssue, source: 'title' }
  if (input.isDerived && input.parentIssue !== null) return { number: input.parentIssue.number, source: 'parent' }
  return null
}

const clampTo = (at: number, now: number): number => Math.min(at, now)

// The tree options: the reference time, the activity cutoff in ms, this window's Desktop session id, and the breadcrumb
// facts of the open issues by number (empty when there are none).
type TreeOptions = {
  now: number
  cutoffMs: number
  thisCliSessionId: string | null
  issueFacts?: ReadonlyMap<number, IssueFacts>
}

// The breadcrumb facts of each open issue: its page, and the title of its milestone when that milestone is open too.
export function issueFactsOf(milestones: readonly Milestone[], issues: readonly Issue[]): Map<number, IssueFacts> {
  const titles = new Map(milestones.map(milestone => [milestone.number, milestone.title] as const))
  return new Map(
    issues.map(issue => [
      issue.number,
      { url: issue.url, milestoneTitle: issue.milestone === null ? null : (titles.get(issue.milestone) ?? null) },
    ]),
  )
}

// A comment body as one preview line: whitespace collapsed, control characters removed, at most COMMENT_PREVIEW_MAX
// characters.
export function previewOf(body: string): string {
  return plain(body.replace(/\s+/g, ' '), COMMENT_PREVIEW_MAX)
}

// The newest of the comments of an issue (the first of equal times), previewed; null when there is none.
export function newestCommentOf(
  comments: readonly { author: string; at: number; body: string }[],
): IssueDetails['lastComment'] {
  let newest: (typeof comments)[number] | null = null
  for (const comment of comments) if (newest === null || comment.at > newest.at) newest = comment
  return newest === null ? null : { author: newest.author, at: newest.at, body: previewOf(newest.body) }
}

const isThisWindow = (record: SessionInput, thisCliSessionId: string | null): boolean =>
  thisCliSessionId !== null && record.cliSessionId === thisCliSessionId

// A session is shown when it is not archived and was active within the cutoff, or its branch has an open PR (any age).
function isLive(record: SessionInput, earliest: number, now: number): boolean {
  if (record.isArchived) return false
  return clampTo(record.lastActivityAt, now) >= earliest || record.pr?.state === 'OPEN'
}

// Adds every ancestor of a kept session that exists in the input, so a kept child never loses its parent.
function addAncestors(id: string, byId: ReadonlyMap<string, SessionInput>, kept: Set<string>): void {
  let parentId = byId.get(id)?.parentId ?? null
  while (parentId !== null && byId.has(parentId) && !kept.has(parentId)) {
    kept.add(parentId)
    parentId = byId.get(parentId)?.parentId ?? null
  }
}

// The sessions shown: this window's always (archived or not), the live ones, and the ancestors of all of them.
function keptIds(byId: ReadonlyMap<string, SessionInput>, options: TreeOptions): Set<string> {
  const earliest = options.now - options.cutoffMs
  const kept = new Set<string>()
  for (const record of byId.values()) {
    if (isThisWindow(record, options.thisCliSessionId) || isLive(record, earliest, options.now)) kept.add(record.sessionId)
  }
  for (const id of [...kept]) addAncestors(id, byId, kept)
  return kept
}

// A walk up from id that comes back to a node it already passed is a cycle: the node that closes it becomes a root.
function cutCycleAbove(id: string, parentOf: Map<string, string>): void {
  const seen = new Set<string>([id])
  let last = id
  let next = parentOf.get(last)
  while (next !== undefined) {
    if (seen.has(next)) {
      parentOf.delete(last)
      return
    }
    seen.add(next)
    last = next
    next = parentOf.get(last)
  }
}

// The ancestors a session has in the map (its depth, cycles already cut).
function ancestorCountOf(id: string, parentOf: ReadonlyMap<string, string>): number {
  let count = 0
  let next = parentOf.get(id)
  while (next !== undefined) {
    count += 1
    next = parentOf.get(next)
  }
  return count
}

// A session deeper than MAX_DEPTH becomes a root. Depths are measured on the map before any cut, so the result does not
// depend on the order of the sessions.
function cutTooDeep(kept: ReadonlySet<string>, parentOf: Map<string, string>): void {
  const deep = [...kept].filter(id => ancestorCountOf(id, parentOf) > MAX_DEPTH)
  for (const id of deep) parentOf.delete(id)
}

// The parent each shown session hangs under; a session absent from the map is a root.
function attachmentsOf(kept: ReadonlySet<string>, byId: ReadonlyMap<string, SessionInput>): Map<string, string> {
  const parentOf = new Map<string, string>()
  for (const id of kept) {
    const parentId = byId.get(id)?.parentId ?? null
    if (parentId !== null && kept.has(parentId)) parentOf.set(id, parentId)
  }
  for (const id of kept) cutCycleAbove(id, parentOf)
  cutTooDeep(kept, parentOf)
  return parentOf
}

// The root at the top of a session's chain (the chain is acyclic after attachmentsOf).
function rootIdOf(id: string, parentOf: ReadonlyMap<string, string>): string {
  let current = id
  let parentId = parentOf.get(current)
  while (parentId !== undefined) {
    current = parentId
    parentId = parentOf.get(current)
  }
  return current
}

type TreeContext = {
  now: number
  thisCliSessionId: string | null
  byId: ReadonlyMap<string, SessionInput>
  childrenOf: ReadonlyMap<string, readonly SessionInput[]>
  thisRootId: string | null
  issueFacts: ReadonlyMap<number, IssueFacts>
}

// The root whose tree holds this window comes first, then the rest by last activity, newest first.
function sortRoots(roots: readonly SessionInput[], context: TreeContext): SessionInput[] {
  const rank = (record: SessionInput): number => (record.sessionId === context.thisRootId ? 1 : 0)
  return [...roots].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      clampTo(b.lastActivityAt, context.now) - clampTo(a.lastActivityAt, context.now),
  )
}

// The children of a session, oldest first.
function sortChildren(children: readonly SessionInput[], now: number): SessionInput[] {
  return [...children].sort((a, b) => clampTo(a.createdAt, now) - clampTo(b.createdAt, now))
}

// One session as a node: its issue inherits from the parent node, its timeline reads the parent's title, its children
// are attached below it.
function attach(record: SessionInput, depth: number, parentNode: SessionNode | null, context: TreeContext): SessionNode {
  const createdAt = clampTo(record.createdAt, context.now)
  const lastActivityAt = clampTo(record.lastActivityAt, context.now)
  const kind = record.parentKind ?? 'root'
  const parentRecord = record.parentId === null ? undefined : context.byId.get(record.parentId)
  const issue = issueOfSession({
    override: record.override,
    pr: record.pr,
    branch: record.branch,
    title: record.title,
    parentIssue: parentNode?.issue ?? null,
    isDerived: record.parentKind !== null,
  })
  const facts = issue === null ? undefined : context.issueFacts.get(issue.number)
  const node: SessionNode = {
    id: record.sessionId,
    title: record.title,
    isThisWindow: isThisWindow(record, context.thisCliSessionId),
    kind,
    depth,
    parentId: parentNode?.id ?? null,
    createdAt,
    branch: record.branch,
    issue,
    milestoneTitle: facts?.milestoneTitle ?? null,
    issueUrl: facts?.url ?? null,
    // An archived session shown only as an ancestor is idle: its activity is not read.
    state: record.isArchived ? 'idle' : stateOf(lastActivityAt, context.now, record.waiting),
    timeline: timelineOf({
      createdAt,
      kind,
      parentTitle: parentRecord?.title ?? record.parentTitle,
      pr: record.pr,
      commits: record.commits,
    }),
    children: [],
  }
  node.children = sortChildren(context.childrenOf.get(record.sessionId) ?? [], context.now).map(child =>
    attach(child, depth + 1, node, context),
  )
  return node
}

// The session tree of the sessions shown (repo-work-pane-design-spec.md D2): this window's first, roots by last activity, derived sessions
// under their parent. Future timestamps are clamped to now; a cycle is cut at one link; a session deeper than MAX_DEPTH
// becomes a root. A parent that is not in the input promotes its child to a root (parentId null, kind kept).
export function buildTree(nodes: readonly SessionInput[], options: TreeOptions): SessionNode[] {
  const byId = new Map<string, SessionInput>(nodes.map(record => [record.sessionId, record]))
  const kept = keptIds(byId, options)
  const parentOf = attachmentsOf(kept, byId)
  const keptRecords = [...byId.values()].filter(record => kept.has(record.sessionId))
  const childrenOf = new Map<string, SessionInput[]>()
  const roots: SessionInput[] = []
  for (const record of keptRecords) {
    const parentId = parentOf.get(record.sessionId)
    if (parentId === undefined) roots.push(record)
    else childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), record])
  }
  const thisRecord = keptRecords.find(record => isThisWindow(record, options.thisCliSessionId))
  const context: TreeContext = {
    now: options.now,
    thisCliSessionId: options.thisCliSessionId,
    byId,
    childrenOf,
    thisRootId: thisRecord === undefined ? null : rootIdOf(thisRecord.sessionId, parentOf),
    issueFacts: options.issueFacts ?? new Map<number, IssueFacts>(),
  }
  return sortRoots(roots, context).map(root => attach(root, 0, null, context))
}

// Newest first by the parsed updatedAt; an unparsable date sorts as the oldest.
function newestFirst(issues: readonly Issue[]): Issue[] {
  const time = (issue: Issue): number => Date.parse(issue.updatedAt) || 0
  return [...issues].sort((a, b) => time(b) - time(a))
}

// The issue groups of the pane (repo-work-pane-design-spec.md D4): one group per milestone, by number descending, each with its issues that
// no session shows (`linked`). An open milestone with no such issue is a one-line group (issues empty). Issues without a
// milestone, or whose milestone is not in the list, form the last group, shown only when it has issues.
export function groupIssues(milestones: Milestone[], issues: Issue[], linked: ReadonlySet<number>): IssueGroup[] {
  const unlinked = issues.filter(issue => !linked.has(issue.number))
  const listed = new Set(milestones.map(milestone => milestone.number))
  const groups: IssueGroup[] = [...milestones]
    .sort((a, b) => b.number - a.number)
    .map(milestone => ({
      milestone,
      issues: newestFirst(unlinked.filter(issue => issue.milestone === milestone.number)),
    }))
  const loose = newestFirst(unlinked.filter(issue => issue.milestone === null || !listed.has(issue.milestone)))
  if (loose.length > 0) groups.push({ milestone: null, issues: loose })
  return groups
}

// The timeline of a session, newest first, at most `limit` events (repo-work-pane-design-spec.md D6). The text of each event is the variable
// part only, so the pane localises it (hooks/i18n.ts): a commit's subject; a PR's number, a single space, then its title;
// a session's parent title (empty for a root). The pane takes the kind of the event's session from its node.
export function timelineOf(
  input: {
    createdAt: number
    kind: 'root' | 'fork' | 'spawn'
    parentTitle: string | null
    pr: PullRequest | null
    commits: { at: number; subject: string }[]
  },
  limit: number = TIMELINE_LIMIT,
): TimelineEvent[] {
  const events: TimelineEvent[] = input.commits.map(commit => ({ at: commit.at, kind: 'commit' as const, text: commit.subject }))
  if (input.pr !== null) {
    const openedAt = Date.parse(input.pr.createdAt)
    if (Number.isFinite(openedAt)) {
      events.push({ at: openedAt, kind: 'pr', text: `${input.pr.number} ${plain(input.pr.title, TEXT_MAX)}` })
    }
  }
  const origin = input.kind === 'root' ? '' : plain(input.parentTitle ?? '', TEXT_MAX)
  events.push({ at: input.createdAt, kind: 'session', text: origin })
  return events.sort((a, b) => b.at - a.at).slice(0, limit)
}

// The state of a session (repo-work-pane-design-spec.md D7): waiting when an open askaway question names it; else working when its last
// activity is at most WORKING_WINDOW_MS old; else idle. A future activity counts as working.
export function stateOf(lastActivityAt: number, now: number, waiting: boolean): SessionNode['state'] {
  if (waiting) return 'waiting'
  return now - lastActivityAt <= WORKING_WINDOW_MS ? 'working' : 'idle'
}

// Whether an id has the shape of a Desktop session link (local_ and 1 to 128 characters). Anything else is not drawn as
// a link.
export function isSessionLinkId(id: string): boolean {
  const match = SESSION_LINK_ID.exec(id)
  return match !== null && match[0] === id
}

type JsonObject = Record<string, unknown>

const isObject = (raw: unknown): raw is JsonObject => typeof raw === 'object' && raw !== null && !Array.isArray(raw)

const isEpochMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

const isOversized = (value: unknown): boolean => typeof value === 'string' && Array.from(value).length > FIELD_MAX_LENGTH

// A parent link: a session id of the right shape, else none.
const linkOf = (value: unknown): string | null => (typeof value === 'string' && isSessionLinkId(value) ? value : null)

// A working copy path, when it is absolute: git runs in it, so a relative one is never used.
const absolutePathOf = (value: unknown): string | null => (typeof value === 'string' && value.startsWith('/') ? value : null)

// The first git anchor's common dir, when it is an absolute path.
function commonDirOf(gitAnchors: unknown): string | null {
  const anchor: unknown = Array.isArray(gitAnchors) ? gitAnchors[0] : undefined
  if (!isObject(anchor)) return null
  const commonDir = anchor.commonDir
  return typeof commonDir === 'string' && commonDir.startsWith('/') ? commonDir : null
}

// Projects one raw Desktop session record onto the fields the pane reads (repo-work-pane-design-spec.md section 2.7) and nothing else. Returns
// null for a record that is not an object, misses a required field, or carries an oversized text field.
export function projectRecord(raw: unknown): ProjectedRecord | null {
  if (!isObject(raw)) return null
  const spawned: JsonObject = isObject(raw.spawnedFrom) ? raw.spawnedFrom : {}
  const textFields = [raw.sessionId, raw.cliSessionId, raw.title, raw.forkedFromSessionId, raw.cwd, spawned.sessionId, spawned.title]
  if (textFields.some(isOversized) || isOversized(commonDirOf(raw.gitAnchors))) return null
  const { sessionId, cliSessionId, title, createdAt, lastActivityAt, isArchived } = raw
  if (typeof sessionId !== 'string' || !isSessionLinkId(sessionId)) return null
  if (typeof cliSessionId !== 'string' || cliSessionId === '') return null
  if (typeof title !== 'string' || !isEpochMs(createdAt) || !isEpochMs(lastActivityAt)) return null
  if (typeof isArchived !== 'boolean') return null
  const forkedFrom = linkOf(raw.forkedFromSessionId)
  const spawnedFrom = linkOf(spawned.sessionId)
  const parentKind: ProjectedRecord['parentKind'] = forkedFrom !== null ? 'fork' : spawnedFrom !== null ? 'spawn' : null
  return {
    sessionId,
    cliSessionId,
    title: plain(title, TEXT_MAX),
    createdAt,
    lastActivityAt,
    isArchived,
    parentId: forkedFrom ?? spawnedFrom,
    parentKind,
    parentTitle: parentKind === 'spawn' && typeof spawned.title === 'string' ? plain(spawned.title, TEXT_MAX) : null,
    commonDir: commonDirOf(raw.gitAnchors),
    cwd: absolutePathOf(raw.cwd),
  }
}
