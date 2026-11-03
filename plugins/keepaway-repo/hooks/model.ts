// Pure rules of the KeepAway Repo pane: the GitHub remote, the session-to-issue mapping, the session tree, the issue
// groups, the timelines, the session state and the projection of a Desktop session record. Nothing here reads the host
// or the engine; register.tsx reads and calls, pane.tsx draws. Every function is unit-tested (tests/model.test.ts).
import type {
  Issue,
  IssueDetails,
  IssueFacts,
  IssueGroup,
  IssueRef,
  Milestone,
  PostTurnSummary,
  Priority,
  ProjectedRecord,
  PullRequest,
  RepoRemote,
  SessionGroup,
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
export const TIMELINE_LIMIT = 30
// A session counts as working for this long after its last activity (repo-work-pane-design-spec.md D7, a heuristic).
export const WORKING_WINDOW_MS = 5 * 60 * 1000
// A session other than this window waits for the person for this long after its last activity, while its Desktop summary says it stopped
// blocked (repo-work-pane-design-spec.md D7; owner-approved 2026-10-30). Older than this, the normal rule applies.
export const WAITING_WINDOW_MS = 24 * 60 * 60 * 1000
// The longest needs line of a session that waits for the person, in characters, the ellipsis included; cut at the last space before it.
export const NEEDS_ACTION_MAX = 90
// The longest comment preview the issue details draw, in characters, the last one an ellipsis (repo-work-pane-design-spec.md D5).
export const COMMENT_PREVIEW_MAX = 200
// The highest issue number an override, a branch or a title may name (repo-work-pane-design-spec.md D1).
const ISSUE_NUMBER_MAX = 999_999

// Full-match checks without an end anchor: a match counts only when it covers the whole text (match[0] === text).
const URL_REMOTE = /^(?:https|ssh):\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)(?::\d{1,5})?\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?/
const SCP_REMOTE = /^(?:[^@/:\s]+@)?([A-Za-z0-9._-]+):([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/?/
const SESSION_LINK_ID = /^local_[A-Za-z0-9_-]{1,128}/
const BRANCH_NUMBER_PREFIX = /^(?:[\w.-]+\/)?(?!\d{4}-\d{2}-\d{2}-)(\d{1,5})-/g
const BRANCH_ISSUE_WORD = /\bissue-(\d{1,6})\b/gi
const TITLE_NUMBER = /#(\d{1,6})\b/g

// Text length caps of what reaches the snapshot (see plain): a title or subject 200, a label or a name 100.
export const TEXT_MAX = 200
export const LABEL_MAX = 100
// The longest milestone objective (its GitHub description), in characters, the ellipsis counted (Mock S delta 9).
export const OBJECTIVE_MAX = 100
// The longest decision line of this window's issue, in characters, the ellipsis counted (Mock S delta 8, Q4).
export const DECISION_MAX = 200

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

// The host ssh connects to for an alias, from the `hostname` line of `ssh -G <alias>` (the alias itself when no Host block names it).
// Null when the answer has no such line or the value is not a plain host name (lower case, no leading dash, no colon, no space).
const SSH_HOSTNAME_KEY = 'hostname '
const SSH_HOST_NAME = /^[a-z0-9][a-z0-9._-]{0,252}$/
export function sshHostnameOf(text: string): string | null {
  const line = text.split('\n').find(entry => entry.startsWith(SSH_HOSTNAME_KEY))
  const host = (line ?? '').slice(SSH_HOSTNAME_KEY.length).trim().toLowerCase()
  return SSH_HOST_NAME.test(host) ? host : null
}

// A host the pane treats as GitHub: github.com, or an ssh alias that names GitHub (its host contains "github").
export const isGithubHost = (host: string): boolean => host === 'github.com' || host.includes('github')

// A host the pane treats as GitLab: gitlab.com, or a self-hosted one whose name contains "gitlab".
export const isGitlabHost = (host: string): boolean => host === 'gitlab.com' || host.includes('gitlab')

// A web page the pane may draw as a link: https on github.com, or on a GitLab host (isGitlabHost), with no character that could end the
// link's target. Every link target passes this check before it is drawn (pane.tsx).
export const PAGE_URL = /^https:\/\/(?:github\.com|(?:[a-z0-9-]+\.)*[a-z0-9-]*gitlab[a-z0-9-]*(?:\.[a-z0-9-]+)+)\/[^\s()<>[\]"']+$/

// The shape of a commit id: the full hash git log %H prints, 40 lowercase hex digits (SHA-1) or 64 (SHA-256 repos). The git reader
// (register.tsx) and the links share it.
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// The web page of a repo: https://github.com/<owner>/<name> for a GitHub remote, https://<host>/<owner>/<name> for a GitLab one; else null.
export function repoPageOf(remote: RepoRemote | null | undefined): string | null {
  if (remote === null || remote === undefined) return null
  const base = isGithubHost(remote.host) ? 'https://github.com' : isGitlabHost(remote.host) ? `https://${remote.host}` : null
  const page = base === null ? null : `${base}/${remote.owner}/${remote.name}`
  return page !== null && PAGE_URL.test(page) ? page : null
}

// The key of a repo's logo in the store: the remote's host, owner and name, lowercased, so the GitHub remote of an enterprise host never
// shares the github.com page's logo. Null when the remote has no repo page (repoPageOf), so it has no logo either.
export function logoKeyOf(remote: RepoRemote | null | undefined): string | null {
  if (remote === null || remote === undefined || repoPageOf(remote) === null) return null
  return `${remote.host}/${remote.owner}/${remote.name}`.toLowerCase()
}

// The commit page of a repo: GitHub's /commit/<sha>, GitLab's /-/commit/<sha>. null without a repo page or with an id that is not a commit.
export function commitPageOf(remote: RepoRemote | null | undefined, sha: string | null | undefined): string | null {
  const page = repoPageOf(remote)
  if (page === null || remote === null || remote === undefined || sha === undefined || sha === null || !COMMIT_SHA.test(sha)) return null
  const commit = `${page}${isGithubHost(remote.host) ? '' : '/-'}/commit/${sha}`
  return PAGE_URL.test(commit) ? commit : null
}

// The milestone page of a GitHub repo page: <repo page>/milestone/<number>. null without a GitHub page or a number.
export function milestonePageOf(repoPage: string | null, number: number | null): string | null {
  if (repoPage === null || number === null || !repoPage.startsWith('https://github.com/')) return null
  const page = `${repoPage}/milestone/${number}`
  return PAGE_URL.test(page) ? page : null
}

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

// The grapheme segmenter: a user-perceived character, so an emoji sequence joined by zero width joiners is one. Null where Intl.Segmenter
// is missing; then a character is a code point.
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

// The first `limit` characters of the text (graphemes, or code points without Intl.Segmenter). The scan stops at the limit, so a long text
// costs no more than the characters kept.
function leadingCharactersOf(text: string, limit: number): string[] {
  if (GRAPHEME_SEGMENTER === null) return Array.from(text).slice(0, limit)
  const found: string[] = []
  for (const part of GRAPHEME_SEGMENTER.segment(text)) {
    if (found.length === limit) break
    found.push(part.segment)
  }
  return found
}

// The text cut to max characters, the ellipsis included, at the last space before the limit; a hard cut when no space falls there.
// Text within the limit comes back as it is. A character is a grapheme, so a cut never splits an emoji sequence.
export function cutAtWord(text: string, max: number): string {
  const characters = leadingCharactersOf(text, max + 1)
  if (characters.length <= max) return text
  const head = characters.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > 0 ? head.slice(0, space) : head).join('')}…`
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

// The first number a pattern captures that is a valid issue number, or null: a number out of range is skipped, so a real reference after it counts.
function firstIssueOf(text: string, pattern: RegExp): number | null {
  for (const match of text.matchAll(pattern)) {
    const number = issueNumberOf(match[1] ?? '')
    if (number !== null) return number
  }
  return null
}

// The issue a branch names (repo-work-pane-design-spec.md D1, step 3): a leading number after an optional prefix first, as gh's
// <n>-<slug> names it, so an issue-<n> word in the slug does not win; a leading date such as 2026-10-22- is skipped, and a number of
// more than 5 digits names no issue. Else an
// issue-<n> word.
export function issueFromBranch(branch: string): number | null {
  return firstIssueOf(branch, BRANCH_NUMBER_PREFIX) ?? firstIssueOf(branch, BRANCH_ISSUE_WORD)
}

// The first valid hash-number reference of a session title (repo-work-pane-design-spec.md D1, step 4).
export function issueFromTitle(title: string): number | null {
  return firstIssueOf(title, TITLE_NUMBER)
}

// The issue a pull request closes for this branch: only an open PR whose head is the branch. Several issues: the lowest
// number.
function closingIssueOf(pr: PullRequest | null, branch: string | null): number | null {
  if (pr === null || branch === null || pr.headRefName !== branch) return null
  if (pr.state !== 'OPEN') return null
  return pr.closes.length === 0 ? null : Math.min(...pr.closes)
}

// The issue of one session, first match wins (repo-work-pane-design-spec.md D1): override, PR closing reference, branch, title, then the
// parent's issue for a fork or spawn only. The title step takes `titleIssue`, read from the uncut title, when it is given (DL15).
export function issueOfSession(input: {
  override: number | null; pr: PullRequest | null; branch: string | null; title: string; titleIssue?: number | null
  parentIssue: IssueRef | null; isDerived: boolean
}): IssueRef | null {
  if (input.override !== null) return { number: input.override, source: 'override' }
  const closed = closingIssueOf(input.pr, input.branch)
  if (closed !== null) return { number: closed, source: 'pr' }
  const branchIssue = input.branch === null ? null : issueFromBranch(input.branch)
  if (branchIssue !== null) return { number: branchIssue, source: 'branch' }
  const titleIssue = input.titleIssue === undefined ? issueFromTitle(input.title) : input.titleIssue
  if (titleIssue !== null) return { number: titleIssue, source: 'title' }
  if (input.isDerived && input.parentIssue !== null) return { number: input.parentIssue.number, source: 'parent' }
  return null
}

const clampTo = (at: number, now: number): number => Math.min(at, now)

// The tree options: the reference time, the activity cutoff in ms, this window's Desktop session id, the breadcrumb facts of
// the open issues by number (empty when there are none), the context ancestors (records up the parent chains that are not
// listed, in any state; none when absent) and the Desktop sidebar groups (none when absent).
type TreeOptions = {
  now: number
  cutoffMs: number
  thisCliSessionId: string | null
  issueFacts?: ReadonlyMap<number, IssueFacts>
  ancestors?: readonly ProjectedRecord[]
  desktopGroups?: DesktopGroups
}

// The breadcrumb facts of each open issue: its page, and the title of its milestone. The issue carries that title whether its
// milestone is open or closed (pm1-9); the open milestones' titles are the fallback. The title is null with no milestone or with an
// unknown title; noMilestone tells those two apart.
export function issueFactsOf(milestones: readonly Milestone[], issues: readonly Issue[]): Map<number, IssueFacts> {
  const titles = new Map(milestones.map(milestone => [milestone.number, milestone.title] as const))
  return new Map(
    issues.map(issue => [
      issue.number,
      {
        url: issue.url,
        milestoneTitle: issue.milestone === null ? null : (issue.milestoneTitle ?? titles.get(issue.milestone) ?? null),
        noMilestone: issue.milestone === null,
        milestoneNumber: issue.milestone,
      },
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

// A comment that carries a decision starts with this prefix, after its leading whitespace (English or Portuguese, any case), plain or in
// bold (`**Decisão:**`).
const DECISION_PREFIX = /^\s*(?:\*\*(?:decisão|decision):\*\*|(?:decisão|decision):)/i
// Only a comment by the repo's owner, a member or a collaborator can carry a decision: GitHub's authorAssociation names them so. Any other
// author's "Decision:" is someone else's text, not this issue's decision.
const DECISION_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// The text of the newest decision comment of an issue (the first of equal times): the text after its prefix, as plain text cut to
// DECISION_MAX. A comment by another author, a comment with the prefix and no text after it, is no decision. null when none is.
export function newestDecisionOf(comments: readonly { at: number; body: string; association: string }[]): string | null {
  let newest: { at: number; text: string } | null = null
  for (const comment of comments) {
    if (!DECISION_ASSOCIATIONS.has(comment.association) || !DECISION_PREFIX.test(comment.body)) continue
    const text = plain(comment.body.replace(DECISION_PREFIX, ''), Number.POSITIVE_INFINITY)
    if (text === '') continue
    if (newest === null || comment.at > newest.at) newest = { at: comment.at, text }
  }
  return newest === null ? null : cutAtWord(newest.text, DECISION_MAX)
}

const isThisWindow = (record: SessionInput, thisCliSessionId: string | null): boolean =>
  thisCliSessionId !== null && record.cliSessionId === thisCliSessionId

// Whether a session other than this window stopped for the person (D7): its Desktop summary says blocked, and its last activity is within
// WAITING_WINDOW_MS (a future activity counts as now). This window's own state keeps its live flag, so it never counts here.
function stoppedForYou(record: SessionInput, context: { now: number; thisCliSessionId: string | null }): boolean {
  if (isThisWindow(record, context.thisCliSessionId)) return false
  return record.postTurn?.blocked === true && context.now - clampTo(record.lastActivityAt, context.now) <= WAITING_WINDOW_MS
}

// A session is shown when it is not archived and was active within the cutoff, or its branch has an open PR (any age).
function isLive(record: SessionInput, earliest: number, now: number): boolean {
  if (record.isArchived) return false
  return clampTo(record.lastActivityAt, now) >= earliest || record.pr?.state === 'OPEN'
}

// Adds every listable ancestor of a kept session, so a kept child never loses a listed ancestor. The walk goes through a
// context ancestor (archived, or not admitted), which is never added, and stops at a missing id, a revisit or a kept one.
function addAncestors(
  id: string,
  byId: ReadonlyMap<string, SessionInput>,
  chain: ReadonlyMap<string, ProjectedRecord>,
  kept: Set<string>,
): void {
  const seen = new Set<string>([id])
  let parentId = chain.get(id)?.parentId ?? null
  while (parentId !== null && !seen.has(parentId) && !kept.has(parentId)) {
    seen.add(parentId)
    if (byId.has(parentId)) kept.add(parentId)
    parentId = chain.get(parentId)?.parentId ?? null
  }
}

// The sessions listed: this window's always (archived or not), the live ones, and every listable ancestor of all of them.
function keptIds(
  byId: ReadonlyMap<string, SessionInput>,
  chain: ReadonlyMap<string, ProjectedRecord>,
  options: TreeOptions,
): Set<string> {
  const earliest = options.now - options.cutoffMs
  const kept = new Set<string>()
  for (const record of byId.values()) {
    if (isThisWindow(record, options.thisCliSessionId) || isLive(record, earliest, options.now)) kept.add(record.sessionId)
  }
  for (const id of [...kept]) addAncestors(id, byId, chain, kept)
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

// The title a spawn link gives the session it names; '' for a fork, a root or a spawn link without a title.
const spawnTitleOf = (record: ProjectedRecord): string => (record.parentKind === 'spawn' ? (record.parentTitle ?? '') : '')

// The family root id of a session: the top of its fork and spawn links, at most MAX_DEPTH hops up. A
// missing root is named by the spawn link that names it, else the top present record is the root. The missing parent is read
// before the hop cap, so a top present record MAX_DEPTH hops up is still the root. A cycle, or a root more than MAX_DEPTH hops
// up, makes the session its own family.
function familyOf(id: string, chain: ReadonlyMap<string, ProjectedRecord>): string {
  const own = chain.get(id)
  if (own === undefined) return id
  const seen = new Set<string>([id])
  let current = own
  for (let hops = 0; ; hops += 1) {
    const parentId = current.parentId
    if (parentId === null) return current.sessionId
    const parent = chain.get(parentId)
    if (parent === undefined) {
      if (spawnTitleOf(current) === '') return current.sessionId
      // The root the spawn link names sits one hop above `current`, so at MAX_DEPTH hops it is past the cap.
      return hops < MAX_DEPTH ? parentId : id
    }
    if (hops === MAX_DEPTH || seen.has(parentId)) return id
    seen.add(parentId)
    current = parent
  }
}

// The key of the Recents group. Desktop Group ids are `cg-<uuid>`, so this key is reserved: a Group with this id is skipped.
export const RECENTS_KEY = 'recents'
// The group of every session with no Desktop Group, as the Desktop sidebar lists it; the pane draws its label (i18n group.recents).
export const RECENTS_GROUP: SessionGroup = { key: RECENTS_KEY, label: '', kind: 'recents' }

// The group a session is drawn under: its own named Desktop Group, else its family root's (a Group with a blank name, or with
// the reserved id RECENTS_KEY, is skipped), else Recents.
function groupOf(id: string, familyRootId: string, groups: DesktopGroups): SessionGroup {
  for (const groupId of [groups.assignments.get(id), groups.assignments.get(familyRootId)]) {
    const label = groupId === undefined ? '' : plain(groups.names.get(groupId) ?? '', LABEL_MAX)
    if (groupId !== undefined && groupId !== RECENTS_KEY && label !== '') return { key: groupId, label, kind: 'desktop' }
  }
  return RECENTS_GROUP
}

// The nearest kept ancestor of a session: the walk goes through the ancestors that are not kept, and gives null at a missing id
// or a revisit.
function nearestKeptAncestorOf(id: string, kept: ReadonlySet<string>, chain: ReadonlyMap<string, ProjectedRecord>): string | null {
  const seen = new Set<string>([id])
  let parentId = chain.get(id)?.parentId ?? null
  while (parentId !== null && !seen.has(parentId)) {
    if (kept.has(parentId)) return parentId
    seen.add(parentId)
    parentId = chain.get(parentId)?.parentId ?? null
  }
  return null
}

// The parent each listed session hangs under, its nearest listed ancestor; a session absent from the map is a top.
function attachmentsOf(kept: ReadonlySet<string>, chain: ReadonlyMap<string, ProjectedRecord>): Map<string, string> {
  const parentOf = new Map<string, string>()
  for (const id of kept) {
    const parentId = nearestKeptAncestorOf(id, kept, chain)
    if (parentId !== null) parentOf.set(id, parentId)
  }
  for (const id of kept) cutCycleAbove(id, parentOf)
  cutTooDeep(kept, parentOf)
  return parentOf
}

// A session in another group than its parent's (Recents counts as one group) is cut from it and becomes a top of its own group
// (the per-session Group rule).
function cutAcrossGroups(parentOf: Map<string, string>, groups: ReadonlyMap<string, SessionGroup>): void {
  for (const [id, parentId] of [...parentOf]) {
    if (groups.get(id)?.key !== groups.get(parentId)?.key) parentOf.delete(id)
  }
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
  chain: ReadonlyMap<string, ProjectedRecord>
  groups: ReadonlyMap<string, SessionGroup>
  childrenOf: ReadonlyMap<string, readonly SessionInput[]>
  thisRootId: string | null
  issueFacts: ReadonlyMap<number, IssueFacts>
}

// Whether a session waits for the person (D7), or a session under it does. A top is ranked by this, so the cut at the group's first 20
// tops (Mock S Q7) never hides a session that waits below it.
function treeWaits(record: SessionInput, context: TreeContext): boolean {
  if (record.waiting || stoppedForYou(record, context)) return true
  return (context.childrenOf.get(record.sessionId) ?? []).some(child => treeWaits(child, context))
}

// The tops of one group in order: the top that holds this window first, then a top whose session or a session under it waits for the
// person (D7, Q6), then the rest by last activity, newest first, then by session id.
function sortGroupTops(tops: readonly SessionInput[], context: TreeContext): SessionInput[] {
  const waiting = new Map(tops.map(top => [top.sessionId, treeWaits(top, context) ? 1 : 0] as const))
  const waits = (record: SessionInput): number => waiting.get(record.sessionId) ?? 0
  const rank = (record: SessionInput): number => (record.sessionId === context.thisRootId ? 1 : 0)
  return [...tops].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      waits(b) - waits(a) ||
      clampTo(b.lastActivityAt, context.now) - clampTo(a.lastActivityAt, context.now) ||
      (a.sessionId < b.sessionId ? -1 : 1),
  )
}

// The tops in drawing order, each group's tops together: the group holding this window first (Recents included), then the
// named Desktop Groups by their newest top, then by key, and Recents last.
function sortTops(tops: readonly SessionInput[], context: TreeContext): SessionInput[] {
  const byKey = new Map<string, SessionInput[]>()
  for (const top of tops) {
    const key = (context.groups.get(top.sessionId) ?? RECENTS_GROUP).key
    byKey.set(key, [...(byKey.get(key) ?? []), top])
  }
  const holdsThis = (list: readonly SessionInput[]): number => (list.some(top => top.sessionId === context.thisRootId) ? 1 : 0)
  const isRecents = (key: string): number => (key === RECENTS_KEY ? 1 : 0)
  const newest = (list: readonly SessionInput[]): number => Math.max(...list.map(top => clampTo(top.lastActivityAt, context.now)))
  return [...byKey]
    .sort(
      ([keyA, a], [keyB, b]) =>
        holdsThis(b) - holdsThis(a) || isRecents(keyA) - isRecents(keyB) || newest(b) - newest(a) || (keyA < keyB ? -1 : 1),
    )
    .flatMap(([, list]) => sortGroupTops(list, context))
}

// The children of a session, oldest first.
function sortChildren(children: readonly SessionInput[], now: number): SessionInput[] {
  return [...children].sort((a, b) => clampTo(a.createdAt, now) - clampTo(b.createdAt, now))
}

// One session as a node: its issue inherits from the drawn parent node, its timeline reads the title of its own parent (an
// ended one included), a top carries its group, its children are attached below it.
function attach(record: SessionInput, depth: number, parentNode: SessionNode | null, context: TreeContext): SessionNode {
  const createdAt = clampTo(record.createdAt, context.now)
  const lastActivityAt = clampTo(record.lastActivityAt, context.now)
  const kind = record.parentKind ?? 'root'
  const parentRecord = record.parentId === null ? undefined : context.chain.get(record.parentId)
  const issue = issueOfSession({
    override: record.override,
    pr: record.pr,
    branch: record.branch,
    title: record.title,
    titleIssue: record.titleIssue,
    parentIssue: parentNode?.issue ?? null,
    isDerived: record.parentKind !== null,
  })
  const facts = issue === null ? undefined : context.issueFacts.get(issue.number)
  const stopped = stoppedForYou(record, context)
  const node: SessionNode = {
    id: record.sessionId,
    title: record.title,
    isThisWindow: isThisWindow(record, context.thisCliSessionId),
    kind,
    depth,
    parentId: parentNode?.id ?? null,
    group: parentNode === null ? (context.groups.get(record.sessionId) ?? null) : null,
    createdAt,
    lastActivityAt,
    branch: record.branch,
    issue,
    milestoneTitle: facts?.milestoneTitle ?? null,
    noMilestone: facts?.noMilestone ?? false,
    issueUrl: facts?.url ?? null,
    milestoneNumber: facts?.milestoneNumber ?? null,
    repoPage: repoPageOf(record.remote),
    logoKey: logoKeyOf(record.remote),
    state: stateOf(lastActivityAt, context.now, record.waiting || stopped),
    needsAction: stopped ? (record.postTurn?.needsAction ?? null) : null,
    summary: record.summary ?? null,
    currentTask: record.steps?.current ?? record.postTurn?.detail ?? null,
    timeline: timelineOf({
      createdAt,
      kind,
      parentTitle: parentRecord?.title ?? record.parentTitle,
      pr: record.pr,
      commits: record.commits,
      remote: record.remote,
      steps: record.steps?.events ?? [],
    }),
    children: [],
  }
  node.children = sortChildren(context.childrenOf.get(record.sessionId) ?? [], context.now).map(child =>
    attach(child, depth + 1, node, context),
  )
  return node
}

// The session tree of the sessions listed (repo-work-pane-design-spec.md D2), each top under its group: a Desktop sidebar Group,
// else Recents. The group holding this window comes first, then the named groups by newest top, Recents last; derived sessions
// hang under their parent. Future timestamps are clamped to now; a cycle is cut at one link; a session deeper than MAX_DEPTH,
// or filed in another group than its parent, becomes a top. A parent that is not listed (missing, archived and not this
// window, or a context ancestor) is skipped: its child hangs under the nearest listed ancestor, else it is a top of its
// group (parentId null, kind kept). Context ancestors only link and group: they are never listed.
export function buildTree(nodes: readonly SessionInput[], options: TreeOptions): SessionNode[] {
  const listable = nodes.filter(record => !record.isArchived || isThisWindow(record, options.thisCliSessionId))
  const byId = new Map<string, SessionInput>(listable.map(record => [record.sessionId, record]))
  const chain = new Map<string, ProjectedRecord>([...(options.ancestors ?? []), ...nodes].map(record => [record.sessionId, record]))
  const kept = keptIds(byId, chain, options)
  const parentOf = attachmentsOf(kept, chain)
  const desktopGroups = options.desktopGroups ?? NO_DESKTOP_GROUPS
  const groups = new Map([...kept].map(id => [id, groupOf(id, familyOf(id, chain), desktopGroups)] as const))
  cutAcrossGroups(parentOf, groups)
  const keptRecords = [...byId.values()].filter(record => kept.has(record.sessionId))
  const childrenOf = new Map<string, SessionInput[]>()
  const tops: SessionInput[] = []
  for (const record of keptRecords) {
    const parentId = parentOf.get(record.sessionId)
    if (parentId === undefined) tops.push(record)
    else childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), record])
  }
  const thisRecord = keptRecords.find(record => isThisWindow(record, options.thisCliSessionId))
  const context: TreeContext = {
    now: options.now,
    thisCliSessionId: options.thisCliSessionId,
    chain,
    groups,
    childrenOf,
    thisRootId: thisRecord === undefined ? null : rootIdOf(thisRecord.sessionId, parentOf),
    issueFacts: options.issueFacts ?? new Map<number, IssueFacts>(),
  }
  return sortTops(tops, context).map(top => attach(top, 0, null, context))
}

// Newest first by the parsed updatedAt; an unparsable date sorts as the oldest.
function newestFirst(issues: readonly Issue[]): Issue[] {
  const time = (issue: Issue): number => Date.parse(issue.updatedAt) || 0
  return [...issues].sort((a, b) => time(b) - time(a))
}

// The priority tags by the label text in lower case: P0 to P3, and the word of a `priority` label (critical is P0, high P1,
// medium P2, low P3).
const PRIORITY_TAGS: Readonly<Record<string, Priority>> = {
  p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3', critical: 'P0', high: 'P1', medium: 'P2', low: 'P3',
}
// The priorities from the highest to the lowest.
const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']
// A label that names a priority, case-insensitive: `P0` to `P3`, or `priority` (or `prio`) then a separator (`:`, `/`, `-`, a space or
// none) and the word.
const PRIORITY_LABEL = /^(?:(p[0-3])|prio(?:rity)?\s*[:/_-]?\s*(critical|high|medium|low))$/i

// The priority the labels name, the highest one when several do; null when no label names one (an unlabelled issue).
export function priorityOf(labels: readonly string[]): Priority | null {
  const tags = labels.flatMap(label => {
    const match = PRIORITY_LABEL.exec(label.trim())
    const tag: Priority | undefined = match === null ? undefined : PRIORITY_TAGS[(match[1] ?? match[2] ?? '').toLowerCase()]
    return tag === undefined ? [] : [tag]
  })
  return PRIORITIES.find(priority => tags.includes(priority)) ?? null
}

// The order of the issues inside one group: priority first (P0 first, unlabelled last), then newest first. The sort is stable,
// so the newest-first order holds inside each priority.
function issueOrder(issues: readonly Issue[]): Issue[] {
  const rank = (issue: Issue): number => {
    const priority = priorityOf(issue.labels)
    return priority === null ? PRIORITIES.length : PRIORITIES.indexOf(priority)
  }
  return [...newestFirst(issues)].sort((a, b) => rank(a) - rank(b))
}

// A UTC offset as `date +%z` prints it (±HHMM), in minutes east of UTC; null for anything else (no sign, a minute past 59, an
// hour past 14, which no zone reaches).
const UTC_OFFSET_PATTERN = /^([+-])(\d{2})(\d{2})$/
const UTC_OFFSET_MAX_HOURS = 14
const MINUTES_PER_OFFSET_HOUR = 60
export function parseUtcOffset(text: string): number | null {
  const match = UTC_OFFSET_PATTERN.exec(text.trim())
  if (match === null) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > UTC_OFFSET_MAX_HOURS || minutes >= MINUTES_PER_OFFSET_HOUR) return null
  const east = hours * MINUTES_PER_OFFSET_HOUR + minutes
  return match[1] === '-' ? -east : east
}

// The due date of a milestone in epoch ms, null when GitHub sets none (or the date does not parse).
function dueTimeOf(milestone: Milestone): number | null {
  const time = Date.parse(milestone.dueOn ?? '')
  return Number.isNaN(time) ? null : time
}

// The order of the open milestone groups: the dated ones by due date, earliest first (an overdue one leads), then the undated ones.
// Ties, and the undated ones among themselves, go by number, newest first.
function byDueDate(a: Milestone, b: Milestone): number {
  const dueA = dueTimeOf(a)
  const dueB = dueTimeOf(b)
  if (dueA === null && dueB === null) return b.number - a.number
  if (dueA === null) return 1
  if (dueB === null) return -1
  return dueA - dueB || b.number - a.number
}

// The issue groups of the pane (repo-work-pane-design-spec.md D4): one group per open milestone, by due date (byDueDate), each with its issues
// that no session shows (`linked`), by priority then newest first (issueOrder). An open milestone with no such issue is a one-line group (issues empty): if its openIssues is above 0,
// its title shows that count of open issues, all in sessions, but only when the list is complete (`issuesPartial` false) and holds every
// open issue the milestone counts (claimsLinked, rev-g1-5). The issues of a closed milestone form one group per milestone, titled by the
// issue's own milestone field and marked closed (pm1-9). Issues without a milestone form the last group, shown only when it has issues.
export function groupIssues(milestones: Milestone[], issues: Issue[], linked: ReadonlySet<number>, issuesPartial: boolean): IssueGroup[] {
  const unlinked = issues.filter(issue => !linked.has(issue.number))
  const listed = new Set(milestones.map(milestone => milestone.number))
  const groups: IssueGroup[] = [...milestones]
    .sort(byDueDate)
    .map(milestone => ({
      milestone,
      closedTitle: null,
      closedNumber: null,
      issues: issueOrder(unlinked.filter(issue => issue.milestone === milestone.number)),
      claimsLinked: !issuesPartial && issues.filter(issue => issue.milestone === milestone.number).length === milestone.openIssues,
    }))
  groups.push(...closedGroupsOf(listed, unlinked))
  const loose = issueOrder(
    unlinked.filter(issue => issue.milestone === null || (!listed.has(issue.milestone) && issue.milestoneTitle === null)),
  )
  if (loose.length > 0) groups.push({ milestone: null, closedTitle: null, closedNumber: null, issues: loose, claimsLinked: false })
  return groups
}

// One group per closed milestone that holds an unlinked issue, by number descending. The title is the issue's own milestone title.
function closedGroupsOf(listed: ReadonlySet<number>, unlinked: readonly Issue[]): IssueGroup[] {
  const titles = new Map<number, string>()
  for (const issue of unlinked) {
    if (issue.milestone !== null && !listed.has(issue.milestone) && issue.milestoneTitle !== null) {
      titles.set(issue.milestone, issue.milestoneTitle)
    }
  }
  return [...titles]
    .sort(([a], [b]) => b - a)
    .map(([number, title]) => ({
      milestone: null,
      closedTitle: title,
      closedNumber: number,
      issues: issueOrder(unlinked.filter(issue => issue.milestone === number)),
      claimsLinked: false,
    }))
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
    commits: { at: number; subject: string; sha?: string | null }[]
    remote?: RepoRemote | null
    steps?: readonly { at: number; text: string }[]
  },
  limit: number = TIMELINE_LIMIT,
): TimelineEvent[] {
  const events: TimelineEvent[] = input.commits.map(commit => ({
    at: commit.at,
    kind: 'commit' as const,
    text: commit.subject,
    url: commitPageOf(input.remote, commit.sha),
  }))
  for (const step of input.steps ?? []) events.push({ at: step.at, kind: 'step', text: plain(step.text, TEXT_MAX), url: null })
  if (input.pr !== null) {
    const openedAt = Date.parse(input.pr.createdAt)
    if (Number.isFinite(openedAt)) {
      const url = PAGE_URL.test(input.pr.url) ? input.pr.url : null
      events.push({ at: openedAt, kind: 'pr', text: `${input.pr.number} ${plain(input.pr.title, TEXT_MAX)}`, url })
    }
  }
  const origin = input.kind === 'root' ? '' : plain(input.parentTitle ?? '', TEXT_MAX)
  events.push({ at: input.createdAt, kind: 'session', text: origin, url: null })
  return events.sort((a, b) => b.at - a.at).slice(0, limit)
}

// The state of a session (repo-work-pane-design-spec.md D7): waiting when this window's session waits for the person; else working when its last
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

export const isObject = (raw: unknown): raw is JsonObject => typeof raw === 'object' && raw !== null && !Array.isArray(raw)

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

// The needs line of a post-turn summary: its text as plain text, cut to NEEDS_ACTION_MAX; null when it has no text to show, or when the
// text is not a string or is over the field limit.
function needsActionOf(value: unknown): string | null {
  if (typeof value !== 'string' || isOversized(value)) return null
  const cleaned = plain(value, FIELD_MAX_LENGTH)
  return cleaned === '' ? null : cutAtWord(cleaned, NEEDS_ACTION_MAX)
}

// The Desktop's post-turn summary (Desktop-internal and undocumented, so each field is guarded): blocked when status_category is
// 'blocked'. No data (null) when the field is not an object or its status_category is not a string; a needs text that is missing or
// malformed gives no line but keeps the status.
function postTurnOf(value: unknown): PostTurnSummary | null {
  if (!isObject(value) || typeof value.status_category !== 'string') return null
  return { blocked: value.status_category === 'blocked', needsAction: needsActionOf(value.needs_action), detail: value.status_category === 'completed' ? null : needsActionOf(value.status_detail) }
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
    // Read before the cut, from the title FIELD_MAX_LENGTH already bounds (DL15).
    titleIssue: issueFromTitle(title),
    createdAt,
    lastActivityAt,
    isArchived,
    parentId: forkedFrom ?? spawnedFrom,
    parentKind,
    parentTitle: parentKind === 'spawn' && typeof spawned.title === 'string' ? plain(spawned.title, TEXT_MAX) : null,
    commonDir: commonDirOf(raw.gitAnchors),
    cwd: absolutePathOf(raw.cwd),
    postTurn: postTurnOf(raw.postTurnSummary),
  }
}

// The Desktop sidebar groups, read from the Desktop config (claude_desktop_config.json), each group's name
// by its id, and the group each Desktop session (local_<id>) is filed under. A config of any other shape names none.
export type DesktopGroups = { names: ReadonlyMap<string, string>; assignments: ReadonlyMap<string, string> }
export const NO_DESKTOP_GROUPS: DesktopGroups = { names: new Map(), assignments: new Map() }
const DESKTOP_CODE_PREFIX = 'code:'

// The groups and assignments of every scope of the config's dframe-group-scopes; only code: assignments name a session.
export function parseDesktopGroups(config: unknown): DesktopGroups {
  const scopes =
    isObject(config) && isObject(config.preferences) && isObject(config.preferences.epitaxyPrefs)
      ? config.preferences.epitaxyPrefs['dframe-group-scopes']
      : undefined
  if (!isObject(scopes)) return NO_DESKTOP_GROUPS
  const names = new Map<string, string>()
  const assignments = new Map<string, string>()
  for (const scope of Object.values(scopes)) {
    if (!isObject(scope)) continue
    for (const group of Array.isArray(scope.groups) ? scope.groups : []) {
      if (isObject(group) && typeof group.id === 'string' && typeof group.name === 'string') names.set(group.id, group.name)
    }
    if (!isObject(scope.assignments)) continue
    for (const [key, groupId] of Object.entries(scope.assignments)) {
      if (key.startsWith(DESKTOP_CODE_PREFIX) && typeof groupId === 'string') assignments.set(key.slice(DESKTOP_CODE_PREFIX.length), groupId)
    }
  }
  return { names, assignments }
}
