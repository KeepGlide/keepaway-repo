// Synthetic data in the shape of the design's sample (repo-work-pane-design-spec.md section 3.5, sample-data.json): three milestones, eight
// open issues, six sessions nested as in the mock. Every name, number and path here is invented; no real record is copied.
import type { Issue, IssueDetails, Milestone, PullRequest, SessionInput } from '../../types'
import { issueFactsOf } from '../../hooks/model'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const NOW = Date.parse('2026-10-20T17:00:00Z')

// A session input with neutral defaults: an active, unarchived root with no branch, PR, override or commits.
export function makeRecord(overrides: Partial<SessionInput> & { sessionId: string }): SessionInput {
  return {
    cliSessionId: 'cli-' + overrides.sessionId,
    title: 'Synthetic session',
    createdAt: NOW - 2 * HOUR,
    lastActivityAt: NOW - HOUR,
    isArchived: false,
    parentId: null,
    parentKind: null,
    parentTitle: null,
    commonDir: null,
    cwd: null,
    branch: null,
    pr: null,
    override: null,
    waiting: false,
    commits: [],
    ...overrides,
  }
}

// A pull request with neutral defaults: open, no closing reference, no checks.
export function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 110,
    title: 'Synthetic change',
    state: 'OPEN',
    headRefName: 'feature/synthetic',
    url: 'https://example.invalid/pull/110',
    createdAt: '2026-10-20T10:00:00Z',
    reviewDecision: null,
    closes: [],
    checks: null,
    ...overrides,
  }
}

// Three open milestones: one with open issues, one with a single open issue, one with none (ready to close).
export const SAMPLE_MILESTONES: Milestone[] = [
  { number: 23, title: 'Milestone B', openIssues: 6, closedIssues: 10, dueOn: null, countsExact: true, description: null },
  { number: 22, title: 'Milestone A', openIssues: 1, closedIssues: 0, dueOn: '2026-10-31', countsExact: true, description: null },
  { number: 21, title: 'Milestone Z', openIssues: 0, closedIssues: 1, dueOn: null, countsExact: true, description: null },
]

function issueOf(number: number, milestone: number | null, updatedAt: string): Issue {
  return {
    number,
    title: 'Synthetic issue ' + String(number),
    milestone,
    milestoneTitle: SAMPLE_MILESTONES.find(each => each.number === milestone)?.title ?? null,
    labels: ['type:bug'],
    updatedAt,
    url: 'https://github.com/synthetic-owner/synthetic-repo/issues/' + String(number),
  }
}

// Eight open issues; 106, 97 and 103 are the ones the sample sessions show (SAMPLE_LINKED).
export const SAMPLE_ISSUES: Issue[] = [
  issueOf(106, 23, '2026-10-20T17:20:00Z'),
  issueOf(97, 23, '2026-10-20T16:58:00Z'),
  issueOf(103, 23, '2026-10-20T15:10:00Z'),
  issueOf(105, 23, '2026-10-18T08:27:57Z'),
  issueOf(107, 23, '2026-10-18T07:18:47Z'),
  issueOf(108, 23, '2026-10-18T07:31:26Z'),
  issueOf(90, 22, '2026-10-17T20:22:17Z'),
  issueOf(15, null, '2026-10-17T20:19:16Z'),
]

export const SAMPLE_LINKED: ReadonlySet<number> = new Set([106, 97, 103])

// The breadcrumb facts of the open issues: their page, and the title of their open milestone.
export const SAMPLE_ISSUE_FACTS = issueFactsOf(SAMPLE_MILESTONES, SAMPLE_ISSUES)

// The details of this window's issue 106 (the window's session maps to it by override): a branch, no PR, a last commit,
// a last comment that carries markup (drawn as plain text), nothing blocking, started three hours ago.
export const SAMPLE_THIS_ISSUE: IssueDetails = {
  number: 106,
  title: 'Synthetic issue 106',
  url: 'https://github.com/synthetic-owner/synthetic-repo/issues/106',
  state: 'open',
  milestoneTitle: 'Milestone B',
  branch: 'fix/guard-write-sites',
  pr: null,
  lastCommit: { at: NOW - 12 * MINUTE, subject: 'fix(store): map ENOSPC at backup_receipt writes' },
  checks: null,
  lastComment: { author: 'dev-one', at: NOW - HOUR, body: 'keep *this* [markup](x) as text' },
  startedAt: NOW - 3 * HOUR,
}

// The six sessions of the sample: this window (root) with a fork, a root with an open PR, a root waiting for a person,
// a root with a spawned child, and a root without an issue.
export function sampleSessions(): SessionInput[] {
  return [
    makeRecord({
      sessionId: 'local_7f3a0001',
      cliSessionId: 'cli-this',
      title: 'Synthetic session one',
      createdAt: NOW - 3 * HOUR,
      lastActivityAt: NOW - 2 * MINUTE,
      branch: 'fix/guard-write-sites',
      override: 106,
    }),
    makeRecord({
      sessionId: 'local_c21d0002',
      title: 'Synthetic fork',
      createdAt: NOW - 40 * MINUTE,
      lastActivityAt: NOW - 3 * MINUTE,
      parentId: 'local_7f3a0001',
      parentKind: 'fork',
    }),
    makeRecord({
      sessionId: 'local_9b040003',
      title: 'Synthetic session three',
      createdAt: NOW - 9 * HOUR,
      lastActivityAt: NOW - 5 * HOUR,
      branch: 'fix/config-revision',
      pr: makePr({ number: 111, headRefName: 'fix/config-revision', closes: [97] }),
    }),
    makeRecord({
      sessionId: 'local_e77f0004',
      title: 'Synthetic session four',
      createdAt: NOW - 7 * HOUR,
      lastActivityAt: NOW - 25 * MINUTE,
      branch: 'fix/103-orphan-cancel',
      waiting: true,
    }),
    makeRecord({
      sessionId: 'local_1a2b0005',
      title: 'Synthetic docs',
      createdAt: NOW - 3 * HOUR,
      lastActivityAt: NOW - HOUR,
    }),
    makeRecord({
      sessionId: 'local_55c00006',
      title: 'Synthetic spawn',
      createdAt: NOW - 45 * MINUTE,
      lastActivityAt: NOW - 15 * MINUTE,
      parentId: 'local_1a2b0005',
      parentKind: 'spawn',
      parentTitle: 'Synthetic docs',
    }),
  ]
}

// A raw Desktop record as the reader parses it: the fields section 2.7 reads, plus fields the projection must drop.
export function makeRawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'local_0a1b2c3d',
    cliSessionId: 'cli-0a1b2c3d',
    title: 'Synthetic raw session',
    createdAt: NOW - 2 * HOUR,
    lastActivityAt: NOW - HOUR,
    isArchived: false,
    gitAnchors: [{ commonDir: '/srv/synthetic/repo/.git' }],
    cwd: '/srv/synthetic/repo',
    prompts: ['synthetic prompt, never read'],
    lastTurnReport: { synthetic: true },
    ...overrides,
  }
}
