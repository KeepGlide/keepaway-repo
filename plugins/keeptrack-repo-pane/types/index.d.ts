// The contracts of the KeepTrack pane (repo-work-pane-design-spec.md section 2.6), read by hooks/model.ts, hooks/register.tsx and
// hooks/pane.tsx. The record fields are the ones repo-work-pane-design-spec.md section 2.7 reads and no others.

// countsExact: openIssues and closedIssues count the issues only, from GraphQL; false when they are REST's counts (PRs included) or
// missing. Only an exact zero of open issues reads as all closed.
// description: the milestone's objective (plain text, cut to OBJECTIVE_MAX); null when GitHub has none (Mock S delta 9).
export type Milestone = {
  number: number; title: string; openIssues: number; closedIssues: number; dueOn: string | null; countsExact: boolean
  description: string | null
}

// milestoneTitle: the title of the issue's own milestone from the issue list (open or closed), null with none (pm1-9).
export type Issue = {
  number: number; title: string; milestone: number | null; milestoneTitle: string | null; labels: string[]; updatedAt: string; url: string
}

// The priority an issue's labels name (model.ts priorityOf): P0 is critical, P3 low. Drawn as a tag on the issue row.
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export type PullRequest = {
  number: number; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; url: string; createdAt: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  closes: number[]; checks: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null
}

// The Desktop's post-turn summary of a record (Desktop-internal, undocumented; SPEC section 7): blocked when the session stopped for the
// person, and the needs text the pane draws under its row (cut to NEEDS_ACTION_MAX), null when there is none.
// detail: the summary's status_detail as plain text, the session's current task when its transcript names no plan step (SPEC section 22).
export type PostTurnSummary = { blocked: boolean; needsAction: string | null; detail?: string | null }

// The session's summary line (SPEC section 21): the first prompt of its transcript, cut to SUMMARY_MAX; text null when the transcript
// has no prompt. A session with no SessionSummary draws no line (unknown yet, or the setting is off).
export type SessionSummary = { text: string | null }

export type ProjectedRecord = {
  sessionId: string; cliSessionId: string; title: string; createdAt: number; lastActivityAt: number
  isArchived: boolean; parentId: string | null; parentKind: 'fork' | 'spawn' | null; parentTitle: string | null
  commonDir: string | null; cwd: string | null   // cwd and commonDir: used for git only, never stored or logged
  // The issue the uncut title names (DL15): `title` is cut for display, so a reference past the cut is read here first. Absent on
  // an input not projected from a record, which reads the drawn title instead.
  titleIssue?: number | null
  // The post-turn summary (PostTurnSummary); null when the record has none or it is malformed. Absent on an input not projected from a
  // record, which reads as null.
  postTurn?: PostTurnSummary | null
}

export type IssueRef = { number: number; source: 'override' | 'pr' | 'branch' | 'title' | 'parent' }

// url: the commit's or the PR's web page, null when the event has none (a session event, or no repo page).
// A 'step' event is a plan step the session started (SPEC section 22); it has no icon and no page.
export type TimelineEvent = { at: number; kind: 'commit' | 'pr' | 'session' | 'step'; text: string; url: string | null }

// A session's plan steps read from its transcript (SPEC section 22): the step events, newest first, and the step in progress.
export type SessionSteps = { events: { at: number; text: string }[]; current: string | null }

// A repo's remote as the mod reads it: the host (lower case), owner and name. Never drawn; a link is built from it.
export type RepoRemote = { host: string; owner: string; name: string }

// What the breadcrumb of a session row reads from its issue: the GitHub page and the milestone title, both from the open issues
// list (an issue outside that list has no entry). noMilestone is true only when the issue has no milestone; a null title with
// noMilestone false means the title is unknown, so the trail omits the part (ux-1).
export type IssueFacts = { url: string; milestoneTitle: string | null; noMilestone: boolean; milestoneNumber: number | null }

// The group a tree top is drawn under: a Desktop sidebar Group (the session's, else its family root's), else Recents.
export type SessionGroup = {
  key: string                  // Desktop Group id, else RECENTS_KEY ('recents'; reserved)
  label: string                // Group name (plain, LABEL_MAX); '' for Recents (the pane draws i18n group.recents)
  kind: 'desktop' | 'recents'
}

export type SessionNode = {
  id: string; title: string; isThisWindow: boolean; kind: 'root' | 'fork' | 'spawn'; depth: number
  parentId: string | null; createdAt: number; lastActivityAt: number; branch: string | null; issue: IssueRef | null
  milestoneTitle: string | null; milestoneNumber: number | null; noMilestone: boolean; issueUrl: string | null
  // repoPage: the web page of the session's repo (GitHub or GitLab), null without a known remote; the title links to it.
  repoPage: string | null
  // logoKey: the store key of the repo's logo (host, owner and name, lowercased, from the remote); null without a repo page.
  logoKey: string | null
  state: 'working' | 'idle' | 'waiting'
  // needsAction: the needs line under a session that stopped for the person (another session, not this window); null otherwise.
  needsAction: string | null
  // summary: the summary line under the title (SessionSummary); null when the line is not drawn.
  summary: SessionSummary | null
  // currentTask: the plan step in progress, else the Desktop summary's status detail; null when neither is known.
  currentTask: string | null
  timeline: TimelineEvent[]; children: SessionNode[]
  group: SessionGroup | null   // set on every top of snapshot.sessions, null on derived nodes
}

// milestone null with closedTitle null = "Sem milestone / issue". closedTitle set = the issues of a closed milestone, drawn under its
// title and marked closed (pm1-9; its counts are not read, so no milestone record). claimsLinked: the one-line "all in sessions" claim
// may be drawn, since the list is complete and holds every open issue the milestone counts (rev-g1-5). closedNumber: that closed
// milestone's number, which its heading links to; null whenever closedTitle is null.
export type IssueGroup = {
  milestone: Milestone | null
  closedTitle: string | null
  closedNumber: number | null
  issues: Issue[]
  claimsLinked: boolean
}

export type PaneError = 'gh-missing' | 'gh-auth' | 'gh-rate-limit' | 'gh-timeout' | 'gh-failed' | 'no-remote' | 'records-unreadable' | 'git-failed'

// The details of this window's issue (repo-work-pane-design-spec.md D5, as built). Present only when this window's session maps to an issue.
// `checks` is null in v1: GitHub Actions is off in the repos, so the pane draws "no CI".
export type IssueDetails = {
  number: number; title: string; url: string; state: 'open' | 'closed'; milestoneTitle: string | null
  branch: string | null
  pr: { number: number; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; reviewDecision: PullRequest['reviewDecision']; url: string } | null
  // url: the commit's web page, null without a repo page (the line links to it on the desktop).
  lastCommit: { at: number; subject: string; url: string | null } | null
  checks: string | null
  lastComment: { author: string; at: number; body: string } | null
  // decision: the text of the newest comment by the owner, a member or a collaborator that starts with "Decisão:" or "Decision:" (bold or
  // not), plain, cut to DECISION_MAX; null when none (Mock S delta 8).
  decision: string | null
  startedAt: number
}

export type Snapshot = {
  fetchedAt: number; mode: 'github' | 'no-github'; repo: { owner: string; name: string } | null
  sessions: SessionNode[]; milestones: Milestone[]; issueGroups: IssueGroup[]; openIssueCount: number
  // thisIssueNumber: the window's issue number whenever the window maps to one, even when thisIssue is null (a failed view).
  thisIssue: IssueDetails | null; thisIssueNumber: number | null; unreadableCount: number
  errors: PaneError[]; stale: boolean; truncated: boolean
  // The limit of each list that was cut, the issues first: 500 for issues, 100 for PRs; empty when none was (SP3-1).
  truncatedLimits: number[]
}

// The input of buildTree: a projected record with what register.tsx resolves for it. `commits` are the branch's own
// commits (newest first, at most 5), empty when the branch is the default branch or git is unavailable.
export type SessionInput = ProjectedRecord & {
  branch: string | null
  pr: PullRequest | null
  override: number | null
  waiting: boolean
  commits: { at: number; subject: string; sha?: string | null }[]
  // The session's own repo remote (its common git dir's origin), null when none is known.
  remote?: RepoRemote | null
  // The session's summary this poll has (SessionSummary); absent or null draws no line.
  summary?: SessionSummary | null
  // The session's plan steps this poll has (SessionSteps); absent or null adds no step event and no current task.
  steps?: SessionSteps | null
}

// The drawn state the hooks module reads and writes (see hooks/register.tsx).
declare module 'claude-code' {
  interface PluginState {
    'keeptrack-repo-pane': {
      // The last poll's result, or null before the first poll.
      snapshot: Snapshot | null
      // Whether the pane is open (set by the command and by ui.close).
      open: boolean
      // The language in use: the stored choice, else the environment's.
      lang: 'en' | 'pt'
      // The host's UTC offset in minutes east of UTC, from `date +%z` (hooks/register.tsx); the pane draws clock times in it.
      utcOffset: number
      // The main loop's turn the band reads (hooks/turn.ts): when it started (null when none runs), when the last one ended, and
      // the tool the running turn last called.
      turn: { startedAt: number | null; endedAt: number | null; tool: string | null; endedTurnStart?: number | null }
      // The agents that have not ended (pending, running or waiting), as $.agent.list() counted them, and when their run began.
      agentRun: { count: number; since: number | null }
      // Whether this window's session waits for the person (the engine asked about a tool call), set by the tool.check hook (hooks/register.tsx).
      waiting: boolean
      // Whether the first poll settled with no snapshot to show (no repo context): the pane draws the failure line, not Loading (ux4-2).
      loadFailed: boolean
    }
  }
}
