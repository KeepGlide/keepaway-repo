// The contracts of the repo work pane (repo-work-pane-design-spec.md section 2.6), read by hooks/model.ts, hooks/register.tsx and
// hooks/pane.tsx. The record fields are the ones repo-work-pane-design-spec.md section 2.7 reads and no others.

export type Milestone = { number: number; title: string; openIssues: number; closedIssues: number; dueOn: string | null }

export type Issue = { number: number; title: string; milestone: number | null; labels: string[]; updatedAt: string; url: string }

export type PullRequest = {
  number: number; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; url: string; createdAt: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  closes: number[]; checks: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null
}

export type ProjectedRecord = {
  sessionId: string; cliSessionId: string; title: string; createdAt: number; lastActivityAt: number
  isArchived: boolean; parentId: string | null; parentKind: 'fork' | 'spawn' | null; parentTitle: string | null
  commonDir: string | null; cwd: string | null   // cwd and commonDir: used for git only, never stored or logged
}

export type IssueRef = { number: number; source: 'override' | 'pr' | 'branch' | 'title' | 'parent' }

export type TimelineEvent = { at: number; kind: 'commit' | 'pr' | 'session'; text: string }

// What the breadcrumb of a session row reads from its issue: the milestone title and the GitHub page, both from the open
// issues list (null when the issue is not open, or its milestone is not open).
export type IssueFacts = { url: string; milestoneTitle: string | null }

export type SessionNode = {
  id: string; title: string; isThisWindow: boolean; kind: 'root' | 'fork' | 'spawn'; depth: number
  parentId: string | null; createdAt: number; branch: string | null; issue: IssueRef | null
  milestoneTitle: string | null; issueUrl: string | null
  state: 'working' | 'idle' | 'waiting'; timeline: TimelineEvent[]; children: SessionNode[]
}

export type IssueGroup = { milestone: Milestone | null; issues: Issue[] }   // milestone null = "Sem milestone / issue"

export type PaneError = 'gh-missing' | 'gh-auth' | 'gh-rate-limit' | 'gh-timeout' | 'gh-failed' | 'no-remote' | 'records-unreadable' | 'git-failed'

// The details of this window's issue (repo-work-pane-design-spec.md D5, as built). Present only when this window's session maps to an issue.
// `checks` is null in v1: GitHub Actions is off in the repos, so the pane draws "no CI".
export type IssueDetails = {
  number: number; title: string; url: string; state: 'open' | 'closed'; milestoneTitle: string | null
  branch: string | null
  pr: { number: number; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; reviewDecision: PullRequest['reviewDecision']; url: string } | null
  lastCommit: { at: number; subject: string } | null
  checks: string | null
  lastComment: { author: string; at: number; body: string } | null
  blockedBy: string | null
  startedAt: number
}

export type Snapshot = {
  fetchedAt: number; mode: 'github' | 'no-github'; repo: { owner: string; name: string } | null
  sessions: SessionNode[]; milestones: Milestone[]; issueGroups: IssueGroup[]; openIssueCount: number
  // thisIssueNumber: the window's issue number whenever the window maps to one, even when thisIssue is null (a failed view).
  thisIssue: IssueDetails | null; thisIssueNumber: number | null; unreadableCount: number
  errors: PaneError[]; stale: boolean; truncated: boolean
  // The limit of the list that was cut: 500 for issues, else 100 for PRs, else null.
  truncatedLimit: number | null
}

// The input of buildTree: a projected record with what register.tsx resolves for it. `commits` are the branch's own
// commits (newest first, at most 5), empty when the branch is the default branch or git is unavailable.
export type SessionInput = ProjectedRecord & {
  branch: string | null
  pr: PullRequest | null
  override: number | null
  waiting: boolean
  commits: { at: number; subject: string }[]
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
      // The main loop's turn the band reads (hooks/turn.ts): when it started (null when none runs), when the last one ended, and
      // the tool the running turn last called.
      turn: { startedAt: number | null; endedAt: number | null; tool: string | null }
      // The agents that have not ended (pending, running or waiting), as $.agent.list() counted them, and when their run began.
      agentRun: { count: number; since: number | null }
    }
  }
}
