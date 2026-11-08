// The KeepAway Repo pane: the header, the hero (risks first, then the count), the sessions by group (a bold label, a Desktop Group's name,
// else Recents, then its tops as titled rows with their derived sessions under them; this window's group first, the window
// highlighted with its issue details, its timeline and its GitHub link), the issues without a session by milestone, and the
// footer. It draws one Snapshot the register hands in and reads or writes no state. Nothing folds: every row, every detail and
// every timeline is always drawn. A title goes into a link only after escaping; group labels, commit subjects, comments and
// labels stay plain Text.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type {
  Issue,
  IssueDetails,
  IssueGroup,
  IssueRef,
  Milestone,
  PaneError,
  PullRequest,
  SessionGroup,
  SessionNode,
  Snapshot,
  TimelineEvent,
} from '../types'
import { actionIconEmoji, priorityEmoji, statusIconEmoji, type ActionIconKey, type StatusIconKey } from './action-icons'
import { t, type Lang, type MessageKey } from './i18n'
import { PAGE_URL, RECENTS_GROUP, TEXT_MAX, TIMELINE_LIMIT, cutAtWord, isSessionLinkId, milestonePageOf, plain, priorityOf, repoPageOf } from './model'
import { BAR_EMPTY, BAR_FILLED, BRANCH_GLYPH, DETAILS_FILL, DISCLOSURE_CLOSED, DISCLOSURE_OPEN, EMPHASISED_PRIORITIES, LINK_MARK } from './look'
import { KEEPGLIDE_HEADER_SIZE, renderKeepGlide, renderKeepAwayLogo, renderRepoLogo } from './logo-element'
import type { HeldButtons } from './held'
import { repoLabelOf } from './repo-logo'
import { MARK_ALT, TIMELINE_MARK_SIZE, timelineMarkSvg, type MarkKind } from './timeline-marks'

type Ui = Elements[RenderSurface]
// The desktop's table: the timeline's line draws Svg markers and Markdown titles, which only it has.
type DesktopUi = Elements['desktop']

export type PaneContext = {
  snapshot: Snapshot | null
  // The instant the pane reads as now; the wall clock when absent (the tests fix it).
  now?: number
  // True once the first poll settled with no snapshot to show (ux4-2): the pane draws the failure line instead of Loading.
  loadFailed?: boolean
  lang: Lang
  surface: string
  // The host's UTC offset in minutes east of UTC (register.tsx reads it with `date +%z`). Clock times and dates are drawn in it.
  utcOffsetMinutes: number
  // The stored SVG of each repo's logo, by SessionNode.logoKey (register.tsx reads the store); a repo with no entry draws no logo.
  logos?: ReadonlyMap<string, string>
  // The legend's accordion (SPEC section 19): open when true. Its button calls onLegendToggle; held keeps its press handle across redraws.
  legendOpen: boolean
  onLegendToggle: () => void
  held: HeldButtons
  // The sessions whose earlier timeline events are shown (SPEC section 22); a press on a session's Earlier button calls onTimelineToggle.
  timelineOpen?: ReadonlySet<string>
  onTimelineToggle?: (sessionId: string) => void
}

// What every drawing function reads: the element table, the language, the clock of this draw, the host's UTC offset, the surface,
// and this window's issue details (null when not fetched).
type View = {
  ui: Ui
  lang: Lang
  desktop: boolean
  now: number
  utcOffsetMinutes: number
  thisIssue: IssueDetails | null
  // The web page of the window's GitHub repo, null without one: the milestone headings and the crumbs link to it.
  repoPage: string | null
  // The drawn logo of each repo, by SessionNode.logoKey (PaneContext.logos).
  logos: ReadonlyMap<string, string>
  legendOpen: boolean
  onLegendToggle: () => void
  held: HeldButtons
  timelineOpen: ReadonlySet<string>
  onTimelineToggle: (sessionId: string) => void
}

// Where a session row sits: its branch glyph ("├" or "└"), the parent's issue (breadcrumb), and the level it is drawn at
// below its group's label (0 for a top, whatever its depth in the tree; W1).
type RowPlace = { branch: string; parentIssue: IssueRef | null; level: number }

// The tops drawn under one label: a Desktop Group's, or Recents' (buildTree keeps a group's tops together).
type GroupRun = { group: SessionGroup; tops: SessionNode[] }

// url: the page the value links to (the PR's), null or absent for a plain value.
type DetailLine = { key: string; label: string; value: string; url?: string | null }

// Derived rows indent two cells per level, at most two levels, so a 360 px pane holds them (repo-work-pane-design-spec.md section 2.4).
const INDENT_CELLS = 2
const MAX_INDENT_LEVELS = 2
// The indent of a row's body under its state glyph: the title starts after the branch glyph and the state glyph.
const BODY_INDENT = 4
// The indent of a group's rows under its label.
const GROUP_INDENT = 1
// The most top-level sessions one group draws (Mock S Q7); the rest sit behind a "+k more" line. A group puts this window and the sessions
// waiting for the person first, so the cut never hides them.
const SESSION_LIST_MAX = 20
// The longest milestone title on its heading, in characters, the ellipsis counted (Mock S delta 11, Q9, Q17).
const MILESTONE_TITLE_MAX = 40
const TITLE_SEPARATOR = ' · '
const MINUTE_MS = 60_000
// The date part of a GitHub due date (YYYY-MM-DD, then the time when GitHub sends one).
const DATE_LENGTH = 10
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MINUTE_MS
// The hero's due-soon chip covers the milestones due from today to this many days ahead (Q10), and its waiting chip lists at most this many
// issue numbers before "+k" (Mock S, delta 5).
const DUE_SOON_DAYS = 14
const WAITING_NUMBERS_MAX = 3
// The limits register.tsx cuts the two GitHub lists at (ISSUE_LIMIT, PR_LIMIT). The snapshot carries the limit, not the list's name,
// so the limit names the list; a limit it does not know keeps the generic partial line.
const ISSUE_LIST_LIMIT = 500
const PR_LIST_LIMIT = 100
const TRUNCATED_KEY: ReadonlyMap<number, MessageKey> = new Map<number, MessageKey>([
  [ISSUE_LIST_LIMIT, 'error.truncated.issues'],
  [PR_LIST_LIMIT, 'error.truncated.prs'],
])
// The drawn stand-in for a value the snapshot does not carry (no repo, no next step).
const NO_VALUE = '—'
// A clickable title, issue, PR, commit or milestone links only to a page PAGE_URL (model.ts) accepts: https on GitHub or GitLab. Nothing
// a title or a URL carries can break out of the link, and a remote on another host never becomes a link to github.com (S4).
// Markdown punctuation that a title could carry; escaped before it goes into a link label.
const MARKDOWN_PUNCTUATION = /[\\`*_[\]()<>!|~&:.@]/g
// The icon of each timeline kind (the history), of each session state, and of each PR state on a PR line.
// The timeline events drawn before a session's Earlier button.
const TIMELINE_SHOWN = 5
// A plan step (SPEC section 22) has no icon: its text says what the session did.
const TIMELINE_ICON: Readonly<Record<Exclude<TimelineEvent['kind'], 'step'>, StatusIconKey>> = { commit: 'commit', pr: 'pr', session: 'session' }
const STATE_ICON: Readonly<Record<SessionNode['state'], ActionIconKey>> = { working: 'working', idle: 'idle', waiting: 'waiting' }
const PR_STATE_ICON: Readonly<Record<PullRequest['state'], StatusIconKey>> = { OPEN: 'pr', MERGED: 'done', CLOSED: 'closed' }
// The cells of a milestone's progress bar, and the scale of its percentage.
const BAR_CELLS = 10
const PERCENT_MAX = 100
// The text with its icon before it; an empty icon leaves the text as it is.
const withIcon = (icon: string, text: string): string => (icon === '' ? text : `${icon} ${text}`)
// The non-empty parts of a line, apart by one space: a title and the icons after it.
const joinWords = (parts: readonly string[]): string => parts.filter(part => part !== '').join(' ')
const STATE_KEY: Readonly<Record<SessionNode['state'], MessageKey>> = {
  working: 'state.working',
  idle: 'state.idle',
  waiting: 'state.waiting',
}
const PR_STATE_KEY: Readonly<Record<PullRequest['state'], MessageKey>> = {
  OPEN: 'pr.open',
  MERGED: 'pr.merged',
  CLOSED: 'pr.closed',
}
const REVIEW_KEY: Readonly<Record<NonNullable<PullRequest['reviewDecision']>, MessageKey>> = {
  APPROVED: 'review.approved',
  CHANGES_REQUESTED: 'review.changes',
  REVIEW_REQUIRED: 'review.required',
}
const SESSION_EVENT_KEY: Readonly<Record<SessionNode['kind'], MessageKey>> = {
  root: 'timeline.session.root',
  fork: 'timeline.session.fork',
  spawn: 'timeline.session.spawn',
}
// The same kinds for a session whose parent has no title (W6): the text without the name.
const SESSION_EVENT_BARE_KEY: Readonly<Record<SessionNode['kind'], MessageKey>> = {
  root: 'timeline.session.root',
  fork: 'timeline.session.forkNoTitle',
  spawn: 'timeline.session.spawnNoTitle',
}
const ERROR_KEY: Readonly<Record<PaneError, MessageKey>> = {
  'gh-missing': 'error.ghMissing',
  'gh-auth': 'error.ghAuth',
  'gh-rate-limit': 'error.rateLimit',
  'gh-timeout': 'error.timeout',
  'gh-failed': 'error.ghFailed',
  'no-remote': 'error.noRemote',
  'records-unreadable': 'error.records',
  'git-failed': 'error.git-failed',
}

export function renderPane(elements: Ui, context: PaneContext): RenderElement {
  const { snapshot } = context
  const view: View = {
    ui: elements,
    lang: context.lang,
    desktop: context.surface === 'desktop',
    now: context.now ?? Date.now(),
    utcOffsetMinutes: context.utcOffsetMinutes,
    thisIssue: snapshot?.thisIssue ?? null,
    repoPage: snapshot?.repo ? repoPageOf({ host: 'github.com', ...snapshot.repo }) : null,
    logos: context.logos ?? new Map(),
    legendOpen: context.legendOpen,
    onLegendToggle: context.onLegendToggle,
    held: context.held,
    timelineOpen: context.timelineOpen ?? new Set(),
    onTimelineToggle: context.onTimelineToggle ?? (() => undefined),
  }
  const { Box, Text } = elements
  // Every Button of this draw is held between begin and end (held.ts): the legend's and each session's Earlier button.
  view.held.begin()
  const header = renderHeader(view, snapshot)
  const body = snapshot === null ? renderUnsettled(view, context.loadFailed === true) : renderSnapshot(view, snapshot)
  view.held.end()
  return (
    <Box key="keepaway-repo" flexDirection="column" gap={1}>
      {header}
      {body}
    </Box>
  )
}

// The pane before any snapshot: Loading while the first poll runs, the failure line once that poll settled with nothing to show (ux4-2).
function renderUnsettled(view: View, loadFailed: boolean): RenderElement {
  const { Text } = view.ui
  if (loadFailed) return <Text key="load-failed">{withIcon(statusIconEmoji('loadFailed'), t(view.lang, 'pane.loadFailed'))}</Text>
  return <Text key="loading">{t(view.lang, 'pane.loading')}</Text>
}

// The header: the logo and the bold heading on the left; the counter and the KeepGlide mark on the right (askaway's header).
function renderHeader(view: View, snapshot: Snapshot | null): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key="header" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1}>
      <Box key="brand" flexDirection="row" alignItems="center" gap={1}>
        {renderKeepAwayLogo(view.ui, view.desktop, t(view.lang, 'pane.title'))}
        {renderHeading(view, snapshot)}
      </Box>
      <Box key="header-end" flexDirection="row" alignItems="center" gap={1}>
        {snapshot !== null && <Text key="counter">{counterText(view, snapshot)}</Text>}
        {renderKeepGlide(view.ui, view.desktop, 'keepglide-header', KEEPGLIDE_HEADER_SIZE)}
      </Box>
    </Box>
  )
}

// The header's heading (owner, 2026-11-08): the window's repository name, bold, and its owner muted; the product name is the tab's title
// and the logo's alt. With no repository known yet, or no GitHub remote, the product name stands in.
function renderHeading(view: View, snapshot: Snapshot | null): RenderElement {
  const { Box, Text } = view.ui
  const repo = snapshot?.repo ?? null
  if (repo === null) return <Text key="heading" bold>{t(view.lang, 'pane.heading')}</Text>
  return (
    <Box key="heading" flexDirection="row" alignItems="center" gap={1}>
      <Text key="repo" bold>{repo.name}</Text>
      <Text key="owner" dimColor>{repo.owner}</Text>
    </Box>
  )
}

// The header counter: the open issues in github mode (none is read without GitHub, so only the sessions count there), the open
// issues marked "+" when their list is cut; with no session listed, "nothing in progress" follows (pm1-3, ux4-4, ux-3, ux-4).
function counterText(view: View, snapshot: Snapshot): string {
  const sessions = countSessions(snapshot.sessions)
  const sessionsText = withIcon(statusIconEmoji('sessions'), t(view.lang, 'counter.sessions', { count: sessions }))
  const line =
    snapshot.mode === 'github'
      ? t(view.lang, 'counter.line', { issues: issuesCountText(view, snapshot), sessions: sessionsText })
      : sessionsText
  return sessions === 0 ? `${line}${TITLE_SEPARATOR}${t(view.lang, 'counter.none')}` : line
}

function issuesCountText(view: View, snapshot: Snapshot): string {
  const cut = snapshot.truncatedLimits.includes(ISSUE_LIST_LIMIT)
  return withIcon(statusIconEmoji('issues'), t(view.lang, 'counter.issues', { count: cut ? `${snapshot.openIssueCount}+` : snapshot.openIssueCount }))
}

function countSessions(nodes: readonly SessionNode[]): number {
  return allSessionsOf(nodes).length
}

// The body of a snapshot, top to bottom: the error lines above the groups, the hero (github mode only), the sessions, the issues (github
// mode only), and the footer.
function renderSnapshot(view: View, snapshot: Snapshot): RenderElement[] {
  const issues = snapshot.mode === 'github' ? [renderIssuesSection(view, snapshot)] : []
  const hero = snapshot.mode === 'github' ? [renderHero(view, snapshot)] : []
  return [
    ...renderErrors(view, snapshot),
    ...hero,
    ...renderSessionGroups(view, snapshot),
    ...issues,
    ...renderLegend(view),
    renderFooter(view, snapshot),
  ]
}

function renderErrors(view: View, snapshot: Snapshot): RenderElement[] {
  // The records line only when a record could not be read (N1): a folder that failed alone draws no count.
  const lines = snapshot.errors
    .filter(error => error !== 'records-unreadable' || snapshot.unreadableCount > 0)
    .map(error => t(view.lang, ERROR_KEY[error], error === 'records-unreadable' ? { count: snapshot.unreadableCount } : {}))
  for (const limit of snapshot.truncatedLimits) {
    lines.push(t(view.lang, TRUNCATED_KEY.get(limit) ?? 'error.truncated', { count: limit }))
  }
  const { Text } = view.ui
  return lines.map((line, index) => <Text key={`error-${index}`}>{withIcon(actionIconEmoji('error'), line)}</Text>)
}

// The hero above the sessions (Mock S, deltas 1 to 5): the risk chips first, then the closed issues of the open milestones in bold, then the
// bar with its percentage, the issues left and the sessions working. The milestones come from GitHub, so it is drawn in github mode only.
function renderHero(view: View, snapshot: Snapshot): RenderElement {
  const { Box, Text } = view.ui
  const chips = [...riskChipsOf(view, snapshot), ...waitingChipOf(view, snapshot)]
  // With no open milestone there is no count to stress: the empty wording and the working sessions share one plain line.
  const empty = openTotalsOf(snapshot.milestones).total === 0
  return (
    <Box key="hero" flexDirection="column" gap={1}>
      {chips.length > 0 && <Box key="hero-risks" flexDirection="row" flexWrap="wrap" gap={1}>{chips}</Box>}
      {empty ? (
        <Text key="hero-number">{[countLineOf(view, snapshot), barLineOf(view, snapshot)].join(TITLE_SEPARATOR)}</Text>
      ) : (
        <Text key="hero-number" bold>{countLineOf(view, snapshot)}</Text>
      )}
      {!empty && <Text key="hero-bar">{barLineOf(view, snapshot)}</Text>}
    </Box>
  )
}

// One risk chip: a rounded box with its icon and its text. The text is a plain Text child, so a title is never read as markup.
function renderChip(view: View, key: string, icon: string, text: string): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={key} borderStyle="round" paddingX={1}>
      <Text>{withIcon(icon, text)}</Text>
    </Box>
  )
}

// The open issues of a milestone that no session shows: the count its risk chip names. Null unless the count is exact, that is the
// milestone's counts are exact and the issue list is whole (a cut list would miss issues).
function unlinkedCountOf(snapshot: Snapshot, milestone: Milestone): number | null {
  if (!milestone.countsExact || snapshot.truncatedLimits.includes(ISSUE_LIST_LIMIT)) return null
  const group = snapshot.issueGroups.find(each => each.milestone?.number === milestone.number)
  return group === undefined ? null : group.issues.length
}

// The overdue and due-soon chips: one per open milestone with open issues and a due date that is overdue, or due within DUE_SOON_DAYS.
// Each names its title and the count of its open issues with no session. A milestone with an inexact count gets no chip.
function riskChipsOf(view: View, snapshot: Snapshot): RenderElement[] {
  return snapshot.milestones.flatMap(milestone => riskChipOf(view, snapshot, milestone))
}

function riskChipOf(view: View, snapshot: Snapshot, milestone: Milestone): RenderElement[] {
  const { lang, now, utcOffsetMinutes } = view
  const unlinked = unlinkedCountOf(snapshot, milestone)
  if (unlinked === null || milestone.dueOn === null || milestone.openIssues <= 0) return []
  const label = titleLabel(milestone.title)
  const noSession = t(lang, 'hero.noSession', { count: unlinked })
  if (isOverdue(milestone.dueOn, now, utcOffsetMinutes)) {
    const text = `${t(lang, 'hero.overdue', { label })}${TITLE_SEPARATOR}${noSession}`
    return [renderChip(view, `hero-overdue-${milestone.number}`, statusIconEmoji('overdue'), text)]
  }
  if (!isDueSoon(milestone.dueOn, now, utcOffsetMinutes)) return []
  const days = daysUntilDue(milestone.dueOn, now, utcOffsetMinutes)
  // Due today has no count to name: "due today", not "due in 0 days" (the one-day form is the '.one' key of hero.dueSoon).
  const dueKey = days === 0 ? 'hero.dueToday' : 'hero.dueSoon'
  const text = `${t(lang, dueKey, { label, count: days })}${TITLE_SEPARATOR}${noSession}`
  return [renderChip(view, `hero-due-${milestone.number}`, statusIconEmoji('due'), text)]
}

// The waiting chip: the other sessions that stopped for the person (the waiting state of a session other than this window). It names
// their count, the issue numbers of those with one (three at most, then "+k"), and the age of the one session when there is only one.
function waitingChipOf(view: View, snapshot: Snapshot): RenderElement[] {
  const { lang, now } = view
  const waiting = allSessionsOf(snapshot.sessions).filter(node => !node.isThisWindow && node.state === 'waiting')
  if (waiting.length === 0) return []
  const numbers = waiting.flatMap(node => (node.issue === null ? [] : [node.issue.number]))
  const listed = numbers.slice(0, WAITING_NUMBERS_MAX)
  const more = numbers.length - listed.length
  const numbersText = listed.map(number => `#${number}`).join(', ') + (more > 0 ? ` +${more}` : '')
  const [only] = waiting
  const age = waiting.length === 1 && only !== undefined ? ageText(lang, only.lastActivityAt, now) : ''
  const text = [t(lang, 'hero.waiting', { count: waiting.length }), numbersText, age].filter(part => part !== '').join(TITLE_SEPARATOR)
  return [renderChip(view, 'hero-waiting', actionIconEmoji('waiting'), text)]
}

// Every session drawn, each top followed by its derived sessions, in drawing order.
function allSessionsOf(nodes: readonly SessionNode[]): SessionNode[] {
  return nodes.flatMap(node => [node, ...allSessionsOf(node.children)])
}

// The totals of the open milestones: the closed and the whole issues, and whether every count is exact (REST's counts include PRs).
type OpenTotals = { closed: number; total: number; exact: boolean }

function openTotalsOf(milestones: readonly Milestone[]): OpenTotals {
  const closed = milestones.reduce((sum, milestone) => sum + milestone.closedIssues, 0)
  const total = milestones.reduce((sum, milestone) => sum + milestone.openIssues + milestone.closedIssues, 0)
  return { closed, total, exact: milestones.every(milestone => milestone.countsExact) }
}

// The count line: "14 of 24 closed in the open milestones"; the partial wording when a count is inexact; "no open milestone" when there is
// none, or the total is 0.
function countLineOf(view: View, snapshot: Snapshot): string {
  const { lang } = view
  const { closed, total, exact } = openTotalsOf(snapshot.milestones)
  if (total === 0) return t(lang, 'hero.none')
  return t(lang, exact ? 'hero.count' : 'hero.countPartial', { closed, total })
}

// The bar line: the bar with its percentage (once), the issues left and the sessions working. Without exact counts it names the working
// sessions alone, and with no open milestone too.
function barLineOf(view: View, snapshot: Snapshot): string {
  const { lang } = view
  const { closed, total, exact } = openTotalsOf(snapshot.milestones)
  const working = allSessionsOf(snapshot.sessions).filter(node => node.state === 'working').length
  const workingText = t(lang, 'hero.working', { count: working })
  if (!exact || total === 0) return workingText
  return [progressBarOf(closed, total), t(lang, 'hero.left', { count: total - closed }), workingText].join(TITLE_SEPARATOR)
}

function renderSection(view: View, key: string, heading: string, rows: RenderElement[]): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`section-${key}`} flexDirection="column" gap={1}>
      <Text key="heading" bold>{heading}</Text>
      {rows}
    </Box>
  )
}

// No heading over the session groups: each group's bold label already names its rows. With no session listed, no element at all.
function renderSessionGroups(view: View, snapshot: Snapshot): RenderElement[] {
  return groupsOf(snapshot.sessions).map(run => renderGroup(view, run))
}

// The tops in consecutive runs of one group key each. A top without a group is drawn under Recents.
function groupsOf(tops: readonly SessionNode[]): GroupRun[] {
  const runs: GroupRun[] = []
  for (const top of tops) {
    const group = top.group ?? RECENTS_GROUP
    const last = runs.at(-1)
    if (last?.group.key === group.key) last.tops.push(top)
    else runs.push({ group, tops: [top] })
  }
  return runs
}

// One group, drawn as a branch: the label in bold, then each top as a titled row with its children under it,
// "├" and "└" on the last. Past SESSION_LIST_MAX tops, the group draws the first ones and a "+k more" line (Mock S Q7).
function renderGroup(view: View, run: GroupRun): RenderElement {
  const { group, tops } = run
  const shown = tops.slice(0, SESSION_LIST_MAX)
  const hidden = tops.length - shown.length
  const lastIndex = shown.length - 1
  const { Box, Text } = view.ui
  return (
    <Box key={`group-${group.key}`} flexDirection="column">
      {renderGroupLabel(view, group)}
      <Box key="group-rows" flexDirection="column" gap={1} paddingLeft={GROUP_INDENT}>
        {shown.map((node, index) =>
          renderSessionRow(view, node, {
            branch: index === lastIndex ? BRANCH_GLYPH.last : BRANCH_GLYPH.middle,
            parentIssue: null,
            level: 0,
          }),
        )}
        {hidden > 0 && <Text key={`group-more-${group.key}`}>{t(view.lang, 'group.more', { count: hidden })}</Text>}
      </Box>
    </Box>
  )
}

// The label line of a group: plain bold Text, a Desktop Group's name (the user's own text), else Recents in the pane's
// language. The key carries the group's, so every label of one draw has its own.
function renderGroupLabel(view: View, group: SessionGroup): RenderElement {
  const { Text } = view.ui
  const label = group.kind === 'recents' ? t(view.lang, 'group.recents') : group.label
  return <Text key={`group-label-${group.key}`} bold>{label}</Text>
}

function renderIssuesSection(view: View, snapshot: Snapshot): RenderElement {
  const rows = snapshot.issueGroups.flatMap(group => renderIssueGroup(view, group))
  const { Text } = view.ui
  // No group is built when every open issue sits on a session: then the header counts them, so the line says they are in sessions (ux-2).
  const emptyKey = snapshot.openIssueCount > 0 ? 'issues.allLinked' : 'issues.none'
  const body = rows.length > 0 ? rows : [<Text key="issues-none">{t(view.lang, emptyKey)}</Text>]
  return renderSection(view, 'issues', withIcon(statusIconEmoji('issues'), t(view.lang, 'group.issues')), body)
}

// A session row and, under it, its derived sessions (one level deeper, each with its branch glyph).
function renderSessionRow(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const { Box } = view.ui
  return (
    <Box key={`session-${node.id}`} flexDirection="column" gap={1}>
      {node.isThisWindow ? renderThisWindow(view, node, place) : renderOtherSession(view, node, place)}
      {renderChildren(view, node, place.level)}
    </Box>
  )
}

// This window's row: one highlighted block with its title and breadcrumb, its details (Estado ... Iniciada) when its issue
// is fetched, its timeline, and the GitHub link as the last line. A window with no issue has no details and no link.
function renderThisWindow(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const { Box } = view.ui
  const { thisIssue } = view
  return (
    <Box
      key={`this-${node.id}`}
      flexDirection="column"
      gap={1}
      backgroundColor={DETAILS_FILL}
      paddingX={1}
      paddingY={1}
    >
      {renderSessionHead(view, node, place)}
      {node.issue !== null && thisIssue !== null && renderDetails(view, node, thisIssue, BODY_INDENT)}
      {renderTimeline(view, node, BODY_INDENT)}
      {node.issue !== null && renderGithubLink(view, node.issue.number, thisIssue?.url ?? node.issueUrl, BODY_INDENT)}
    </Box>
  )
}

// Another session's row: its title, its breadcrumb and its timeline.
function renderOtherSession(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const { Box } = view.ui
  return (
    <Box key={`row-${node.id}`} flexDirection="column" gap={1}>
      {renderSessionHead(view, node, place)}
      {renderTimeline(view, node, BODY_INDENT)}
    </Box>
  )
}

// The title line (branch glyph, title with its icons after it), the summary and the breadcrumb under it; the glyph stays on the title's
// first line (alignItems flex-start), not in the middle of the block. The state is an icon alone, with no
// state word, on every row; the footer's legend names each icon (SPEC section 19).
function renderSessionHead(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`head-${node.id}`} flexDirection="row" alignItems="flex-start" gap={1}>
      <Text key="branch">{place.branch}</Text>
      <Box key="title-block" flexDirection="column" flexGrow={1}>
        {renderTitleLine(view, node, node.isThisWindow)}
        {renderSummaryLine(view, node)}
        {renderCrumb(view, node)}
        {renderNeedsLine(view, node)}
      </Box>
    </Box>
  )
}

// The summary line right under the title (Mock S delta 7, SPEC section 21): the session's first prompt, cut, as plain text with no label.
// No line when the transcript has no prompt, while the summary is unknown, or while the setting is off.
function renderSummaryLine(view: View, node: SessionNode): RenderElement | false {
  if (node.summary === null || node.summary.text === null) return false
  const { Text } = view.ui
  return <Text key={`summary-${node.id}`}>{node.summary.text}</Text>
}

// The needs line under a session that stopped for the person (D7, Q14): what its Desktop summary says it needs, as plain text; no line
// without that text.
function renderNeedsLine(view: View, node: SessionNode): RenderElement | false {
  if (node.needsAction === null) return false
  const { Text } = view.ui
  return <Text key={`needs-${node.id}`}>{t(view.lang, 'session.needsYou', { text: node.needsAction })}</Text>
}

// The title line: the repo's logo in front of the title when the desktop draws one (SPEC section 11), else the title alone, so the terminal's
// line is the one renderSessionTitle draws.
function renderTitleLine(view: View, node: SessionNode, isThis: boolean): RenderElement {
  const { Box } = view.ui
  const title = renderSessionTitle(view, node, isThis)
  const logo = repoLogoOf(view, node)
  if (logo === false) return title
  return (
    <Box key={`title-line-${node.id}`} flexDirection="row" gap={1}>
      {logo}
      {title}
    </Box>
  )
}

// The row's repo logo, drawn with its alt text ("owner/name logo"); false when the repo has none, or on the terminal.
function repoLogoOf(view: View, node: SessionNode): RenderElement | false {
  if (node.kind !== 'root' || node.repoPage === null || node.logoKey === null) return false
  const source = view.logos.get(node.logoKey)
  if (source === undefined) return false
  return renderRepoLogo(view.ui, view.desktop, source, t(view.lang, 'session.logoAlt', { repo: repoLabelOf(node.repoPage) }))
}

// The one link check of the pane: the address when the desktop draws Markdown and the address passes PAGE_URL (model.ts), else null.
// Every link the pane draws is decided here, so no branch can link to an address the check does not accept.
function linkTargetOf(view: View, url: string | null): string | null {
  return view.desktop && 'Markdown' in view.ui && url !== null && PAGE_URL.test(url) ? url : null
}

// The one link branch for a line whose only clickable part is its label: on the desktop a Markdown link to the target (bold when asked),
// else plain Text with the same label.
function linkedOrText(view: View, key: string, label: string, url: string | null, bold = false): RenderElement {
  const { ui } = view
  const target = linkTargetOf(view, url)
  if (target !== null && 'Markdown' in ui) {
    const { Markdown } = ui
    const link = `[${escapeMarkdown(label)}](${target})`
    return <Markdown key={key} text={bold ? `**${link}**` : link} />
  }
  const { Text } = ui
  return bold ? <Text key={key} bold>{label}</Text> : <Text key={key}>{label}</Text>
}

// The title opens its session where the Desktop draws Markdown and the id is a session id; elsewhere (the terminal, or an id that is not
// a session link) it is plain Text. The state icon follows the title, outside the link; this window's row is bold, with no marker, since
// its highlighted block already says which window it is (owner's review, 2026-11-02).
function renderSessionTitle(view: View, node: SessionNode, isThis: boolean): RenderElement {
  const { ui } = view
  const icon = actionIconEmoji(STATE_ICON[node.state])
  if (view.desktop && 'Markdown' in ui && isSessionLinkId(node.id)) {
    const { Markdown } = ui
    const anchor = `[${escapeMarkdown(node.title)}](#${node.id})`
    return <Markdown key={`title-${node.id}`} text={joinWords([isThis ? `**${anchor}**` : anchor, icon])} />
  }
  const { Text } = ui
  return <Text key={`title-${node.id}`} bold={isThis}>{joinWords([node.title, icon])}</Text>
}

// A breadcrumb part: its text, and the page it links to (null for none).
type CrumbPart = { text: string; url: string | null }

// The milestone part of a crumb: "no milestone" for an issue that has none, its title otherwise (linked to the milestone's page when the
// repo page is known), and omitted when the title is unknown (a closed milestone still has its title; an unknown one is never claimed as
// "no milestone", ux-1).
function milestonePartOf(lang: Lang, node: SessionNode, repoPage: string | null): CrumbPart[] {
  if (node.noMilestone) return [{ text: t(lang, 'crumb.noMilestone'), url: null }]
  if (node.milestoneTitle === null) return []
  return [{ text: titleLabel(node.milestoneTitle), url: milestonePageOf(repoPage, node.milestoneNumber) }]
}

// The breadcrumb parts: the issue (linked to its page) and the milestone part.
function crumbPartsOf(view: View, node: SessionNode): CrumbPart[] {
  const { lang } = view
  const issue: CrumbPart =
    node.issue === null
      ? { text: t(lang, 'crumb.noIssue'), url: null }
      : { text: withIcon(actionIconEmoji('inProgress'), `#${node.issue.number}`), url: node.issueUrl }
  return [issue, ...milestonePartOf(lang, node, view.repoPage)]
}

// The breadcrumb: "#n · milestone". On the desktop each part with a page (the issue, the milestone) links to it when the address
// passes PAGE_URL; the rest is plain text.
function renderCrumb(view: View, node: SessionNode): RenderElement {
  const parts = crumbPartsOf(view, node)
  const { ui } = view
  const linkOf = (part: CrumbPart): string | null => linkTargetOf(view, part.url)
  if ('Markdown' in ui && parts.some(part => linkOf(part) !== null)) {
    const { Markdown } = ui
    const text = parts
      .map(part => {
        const url = linkOf(part)
        return url === null ? escapeMarkdown(part.text) : `[${escapeMarkdown(part.text)}](${url})`
      })
      .join(TITLE_SEPARATOR)
    return <Markdown key={`crumb-${node.id}`} text={text} />
  }
  const { Text } = ui
  return <Text key={`crumb-${node.id}`}>{parts.map(part => part.text).join(TITLE_SEPARATOR)}</Text>
}

// The indent the children of a row drawn at `level` add under it, while they are within MAX_INDENT_LEVELS (W1): the indents
// of the boxes between a row and its group's rows add up to the cap, never more. A top sits at level 0, column 1 under its
// group's label; its children at column 3; theirs at 5, and deeper rows stay at 5.
const childIndentOf = (level: number): number => (level < MAX_INDENT_LEVELS ? INDENT_CELLS : 0)

function renderChildren(view: View, node: SessionNode, level: number): RenderElement | false {
  if (node.children.length === 0) return false
  const { Box } = view.ui
  const lastIndex = node.children.length - 1
  return (
    <Box key={`children-${node.id}`} flexDirection="column" gap={1} paddingLeft={childIndentOf(level)}>
      {node.children.map((child, index) =>
        renderSessionRow(view, child, {
          branch: index === lastIndex ? BRANCH_GLYPH.last : BRANCH_GLYPH.middle,
          parentIssue: node.issue,
          level: level + 1,
        }),
      )}
    </Box>
  )
}

// A detail value: a link to its page on the desktop when the line carries one that passes PAGE_URL; plain Text elsewhere.
function renderDetailValue(view: View, line: DetailLine): RenderElement {
  return linkedOrText(view, 'value', line.value, line.url ?? null)
}

// The details of this window's issue: "Heading: text" lines, each heading bold, always drawn (repo-work-pane-design-spec.md D5, as built).
function renderDetails(view: View, node: SessionNode, issue: IssueDetails, indent: number): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`details-${node.id}`} flexDirection="column" gap={1} paddingLeft={indent}>
      {detailLinesOf(view, node, issue).map(line => (
        <Box key={`detail-${line.key}`} flexDirection="row" flexWrap="wrap" gap={1}>
          <Text key="label" bold>{`${line.label}:`}</Text>
          {renderDetailValue(view, line)}
        </Box>
      ))}
    </Box>
  )
}

function detailLinesOf(view: View, node: SessionNode, issue: IssueDetails): DetailLine[] {
  const { lang, now } = view
  return [
    { key: 'state', label: t(lang, 'detail.state'), value: stateTextOf(lang, node.state, issue.state) },
    { key: 'branch', label: t(lang, 'detail.branch'), value: issue.branch === null ? t(lang, 'detail.noBranch') : plain(issue.branch, TEXT_MAX) },
    { key: 'pr', label: t(lang, 'detail.pr'), value: prTextOf(lang, issue.pr), url: issue.pr?.url ?? null },
    {
      key: 'commit',
      label: t(lang, 'detail.lastCommit'),
      value: commitTextOf(lang, issue.lastCommit, now),
      url: issue.lastCommit?.url ?? null,
    },
    { key: 'checks', label: t(lang, 'detail.checks'), value: issue.checks ?? t(lang, 'detail.noCi') },
    { key: 'comment', label: t(lang, 'detail.lastComment'), value: commentTextOf(lang, issue.lastComment, now) },
    { key: 'next', label: t(lang, 'detail.nextStep'), value: t(lang, 'detail.noNextStep') },
    {
      key: 'started',
      label: t(lang, 'detail.started'),
      value: startedTextOf(lang, issue.startedAt, now, view.utcOffsetMinutes),
    },
    // The decision of the issue's newest "Decisão:" comment, last, only when there is one (Mock S delta 8).
    ...(issue.decision === null ? [] : [{ key: 'decided', label: t(lang, 'detail.decided'), value: issue.decision }]),
  ]
}

// The start of the issue: its clock, with its date too once the start is over a day old, then its age (ux-9).
function startedTextOf(lang: Lang, at: number, now: number, utcOffsetMinutes: number): string {
  const clock = now - at > DAY_MS ? `${dateOf(at, utcOffsetMinutes)} ${clockOf(at, utcOffsetMinutes)}` : clockOf(at, utcOffsetMinutes)
  return `${clock}${TITLE_SEPARATOR}${ageText(lang, at, now)}`
}

// The session state word, with the issue's state added when the issue is closed (an override may name one).
function stateTextOf(lang: Lang, state: SessionNode['state'], issueState: IssueDetails['state']): string {
  const word = t(lang, STATE_KEY[state])
  return issueState === 'closed' ? `${word}${TITLE_SEPARATOR}${withIcon(statusIconEmoji('done'), t(lang, 'detail.issueClosed'))}` : word
}

function prTextOf(lang: Lang, pr: IssueDetails['pr']): string {
  if (pr === null) return t(lang, 'detail.noPr')
  const review = pr.reviewDecision === null ? '' : `${TITLE_SEPARATOR}${t(lang, REVIEW_KEY[pr.reviewDecision])}`
  const state = withIcon(statusIconEmoji(PR_STATE_ICON[pr.state]), t(lang, PR_STATE_KEY[pr.state]))
  return `#${pr.number} ${pr.title}${TITLE_SEPARATOR}${state}${review}`
}

function commitTextOf(lang: Lang, commit: IssueDetails['lastCommit'], now: number): string {
  if (commit === null) return t(lang, 'detail.noCommit')
  return `${commit.subject}${TITLE_SEPARATOR}${ageText(lang, commit.at, now)}`
}

// The newest comment: its author, its age and its preview, as plain Text (never Markdown).
function commentTextOf(lang: Lang, comment: IssueDetails['lastComment'], now: number): string {
  if (comment === null) return t(lang, 'detail.none')
  return `${comment.author}${TITLE_SEPARATOR}${ageText(lang, comment.at, now)}${TITLE_SEPARATOR}${comment.body}`
}

// The GitHub link of this window's issue: a Markdown link to its https page on the desktop, with the arrow that says it opens;
// plain text elsewhere, without the arrow, since nothing opens there (ux-7).
function renderGithubLink(view: View, number: number, url: string | null, indent: number): RenderElement {
  const { Box, Text } = view.ui
  const label = t(view.lang, 'link.github', { number })
  const target = linkTargetOf(view, url)
  if (target !== null && 'Markdown' in view.ui) {
    const { Markdown } = view.ui
    return (
      <Box key="github-link" paddingLeft={indent}>
        <Markdown key="link" text={`${LINK_MARK} [${escapeMarkdown(`${label} ↗`)}](${target})`} />
      </Box>
    )
  }
  return (
    <Box key="github-link" paddingLeft={indent}>
      <Text key="link">{`${LINK_MARK} ${label}`}</Text>
    </Box>
  )
}

// The timeline (SPEC sections 22 and 24): the events newest first. The TIMELINE_SHOWN newest are always drawn; the rest, up to
// TIMELINE_LIMIT, sit behind the session's Earlier (N) button, closed by default, since the pane has no inner scroll. The desktop draws
// them on a vertical line, alternating sides (owner's mock, 2026-11-08); the terminal keeps a flat list under a `Now:` line.
function renderTimeline(view: View, node: SessionNode, indent: number): RenderElement {
  const { Box, Text } = view.ui
  const events = [...node.timeline].sort((a, b) => b.at - a.at).slice(0, TIMELINE_LIMIT)
  const earlier = events.slice(TIMELINE_SHOWN)
  const open = view.timelineOpen.has(node.id)
  const drawn = open ? events : events.slice(0, TIMELINE_SHOWN)
  if (view.desktop && 'Svg' in view.ui && 'Markdown' in view.ui) return renderTimelineLine(view, node, indent, drawn, earlier.length, open)
  return (
    <Box key={`timeline-${node.id}`} flexDirection="column" gap={1} paddingLeft={indent}>
      {node.currentTask !== null && <Text key={`now-${node.id}`}>{t(view.lang, 'timeline.now', { task: node.currentTask })}</Text>}
      {drawn.slice(0, TIMELINE_SHOWN).map((event, index) => renderTimelineEvent(view, node, event, index))}
      {earlier.length > 0 && renderEarlierToggle(view, node, earlier.length, open)}
      {drawn.slice(TIMELINE_SHOWN).map((event, index) => renderTimelineEvent(view, node, event, index + TIMELINE_SHOWN))}
    </Box>
  )
}

// One terminal timeline row: its clock time, its kind glyph (a plan step has none), its text, and its detail dimmed under it.
function renderTimelineEvent(view: View, node: SessionNode, event: TimelineEvent, index: number): RenderElement {
  const { Box, Text } = view.ui
  const detail = event.detail ?? null
  return (
    <Box key={`event-${node.id}-${index}`} flexDirection="column">
      <Box key="head" flexDirection="row" gap={1}>
        <Text key="time">{clockOf(event.at, view.utcOffsetMinutes)}</Text>
        {event.kind !== 'step' && <Text key="glyph">{statusIconEmoji(TIMELINE_ICON[event.kind])}</Text>}
        <Box key="text" flexGrow={1}>
          {renderTimelineText(view, node, event)}
        </Box>
      </Box>
      {detail !== null && <Text key="detail" dimColor>{detail}</Text>}
    </Box>
  )
}

// What a timeline row is marked as on the line: a release, a commit, a test, a PR, a session event, or a plain step. A commit or a step
// whose words name a release is a release; a step naming a test or a commit is one.
export function markOf(event: TimelineEvent): MarkKind {
  if (event.kind === 'pr' || event.kind === 'session') return event.kind
  if (RELEASE_WORDS.test(event.text)) return 'release'
  if (event.kind === 'commit') return 'commit'
  if (TEST_WORDS.test(event.text)) return 'test'
  if (COMMIT_WORDS.test(event.text)) return 'commit'
  return 'step'
}
const RELEASE_WORDS = /\b(release|released|releasing|publish|published|lançamento|lançar|publicar)\b/i
const TEST_WORDS = /\b(tests?|testing|testes?|testar|e2e|qa)\b/i
const COMMIT_WORDS = /\b(commit|commits|committed)\b/i

// One row of the line: when it happened (null for the current task with no event of its own), its title, link and detail, and its mark.
type LineRow = { at: number | null; title: string; url: string | null; detail: string | null; mark: MarkKind }

// The desktop timeline: each row on one side of a vertical line, newest at the top, alternating left and right. The step in progress is
// marked green; a current task with no event of its own (the stop detail) is a row of its own at the top, with no time.
function renderTimelineLine(view: View, node: SessionNode, indent: number, drawn: readonly TimelineEvent[], earlier: number, open: boolean): RenderElement {
  const { Box } = view.ui
  const rows: LineRow[] = drawn.map(event => ({
    at: event.at,
    title: timelineText(view.lang, node, event),
    url: event.url,
    detail: event.detail ?? null,
    mark: event.kind === 'step' && event.text === node.currentTask ? 'now' : markOf(event),
  }))
  const synthetic = node.currentTask !== null && !rows.some(row => row.mark === 'now')
  if (synthetic) rows.unshift({ at: null, title: node.currentTask ?? '', url: null, detail: null, mark: 'now' })
  // The synthetic row sits above the shown events, so it never pushes one of them under the Earlier button.
  const split = TIMELINE_SHOWN + (synthetic ? 1 : 0)
  const [before, after] = [rows.slice(0, split), rows.slice(split)]
  return (
    <Box key={`timeline-${node.id}`} flexDirection="column" gap={1} paddingLeft={indent}>
      <Box key="line" flexDirection="column">
        {before.map((row, index) => renderLineRow(view, node, row, index, index === rows.length - 1))}
      </Box>
      {earlier > 0 && renderEarlierToggle(view, node, earlier, open)}
      {after.length > 0 && (
        <Box key="line-earlier" flexDirection="column">
          {after.map((row, index) => renderLineRow(view, node, row, index + split, index === after.length - 1))}
        </Box>
      )}
    </Box>
  )
}

// One row of the line: the text on its side (even rows left, odd rows right), the marker on the axis and the line under it down to the
// next row (none under the last). The rows sit with no gap, so the line runs on; the text's bottom padding spaces them.
function renderLineRow(view: View, node: SessionNode, row: LineRow, index: number, last: boolean): RenderElement {
  const { Box, Svg } = view.ui as DesktopUi
  const left = index % 2 === 0
  const text = renderLineText(view, node, row, index, left)
  return (
    <Box key={`tl-row-${node.id}-${index}`} flexDirection="row" alignItems="stretch">
      <Box key="left" width={LINE_SIDE_WIDTH} flexDirection="column" alignItems="flex-end" paddingRight={1} paddingBottom={1}>
        {left ? text : null}
      </Box>
      <Box key="axis" width={LINE_AXIS_COLUMNS} flexDirection="column" alignItems="center">
        <Svg key={`mark-${node.id}-${index}`} source={timelineMarkSvg(row.mark)} alt={MARK_ALT[row.mark]} width={TIMELINE_MARK_SIZE} height={TIMELINE_MARK_SIZE} />
        {!last && <Box key="rule" width={LINE_RULE_WIDTH} flexGrow={1} backgroundColor="subtle" />}
      </Box>
      <Box key="right" width={LINE_SIDE_WIDTH} flexDirection="column" alignItems="flex-start" paddingLeft={1} paddingBottom={1}>
        {left ? null : text}
      </Box>
    </Box>
  )
}

// A row's words: the time in bold and the title in italic (linked when it has a page), then its detail, one sentence or two, dimmed.
function renderLineText(view: View, node: SessionNode, row: LineRow, index: number, left: boolean): RenderElement {
  const { Box, Text, Markdown } = view.ui as DesktopUi
  // An empty title (a commit with no subject) draws no italic marks, which would read as a stray `**`.
  const title = row.title === '' ? '' : row.url === null ? ` *${escapeMarkdown(row.title)}*` : ` *[${escapeMarkdown(row.title)}](${row.url})*`
  const time = row.at === null ? t(view.lang, 'timeline.nowLabel') : clockOf(row.at, view.utcOffsetMinutes)
  return (
    <Box key={`tl-text-${node.id}-${index}`} flexDirection="column" alignItems={left ? 'flex-end' : 'flex-start'}>
      <Markdown key={`tl-title-${node.id}-${index}`} text={`**${escapeMarkdown(time)}**${title}`} />
      {row.detail !== null && <Text key={`tl-detail-${node.id}-${index}`} dimColor>{row.detail}</Text>}
    </Box>
  )
}

// The line's geometry: each side takes LINE_SIDE_WIDTH of the row, the axis LINE_AXIS_COLUMNS cells, and the rule a sliver of the axis.
const LINE_SIDE_WIDTH = '46%'
const LINE_AXIS_COLUMNS = 3
const LINE_RULE_WIDTH = '12%'

// A session's Earlier (N) button: ▸ closed, ▾ open, like the legend's. Its press handle is kept across redraws (held.ts).
function renderEarlierToggle(view: View, node: SessionNode, count: number, open: boolean): RenderElement {
  const { Button } = view.ui
  const key = `earlier-${node.id}`
  const label = `${open ? DISCLOSURE_OPEN : DISCLOSURE_CLOSED} ${t(view.lang, 'timeline.earlier', { count })}`
  return view.held.hold(key, label, () => view.onTimelineToggle(node.id), press => <Button key={key} label={label} onPress={press} />)
}

// The variable part of an event's text (repo-work-pane-design-spec.md section 3.2) drawn with its key. A commit subject and a PR's
// "<number> <title>" are plain values; a session event names its parent (fork, spawn) or nothing (root).
function timelineText(lang: Lang, node: SessionNode, event: TimelineEvent): string {
  if (event.kind === 'commit') return t(lang, 'timeline.commit', { subject: event.text })
  if (event.kind === 'step') return event.text
  if (event.kind === 'pr') {
    const [number = '', ...words] = event.text.split(' ')
    return t(lang, 'timeline.pr', { number, title: words.join(' ') })
  }
  if (event.text === '') return t(lang, SESSION_EVENT_BARE_KEY[node.kind])
  return t(lang, SESSION_EVENT_KEY[node.kind], { title: event.text })
}

// A milestone's heading: a link to its page on the desktop when the repo page is known, plain Text elsewhere.
function renderMilestoneHeading(view: View, key: string, text: string, number: number | null, bold: boolean): RenderElement {
  return linkedOrText(view, key, text, milestonePageOf(view.repoPage, number), bold)
}

// A timeline event's text: a link to its commit or PR page on the desktop when the event has a page that passes PAGE_URL; plain elsewhere.
function renderTimelineText(view: View, node: SessionNode, event: TimelineEvent): RenderElement {
  return linkedOrText(view, 'label', timelineText(view.lang, node, event), event.url)
}

// A milestone's title is followed by its closed and total issues (pm1-1); the total is the open plus the closed issues.
function renderIssueGroup(view: View, group: IssueGroup): RenderElement[] {
  const { lang } = view
  const { Text } = view.ui
  const { milestone, closedTitle, closedNumber, issues } = group
  const groupKey = milestone === null ? 'none' : String(milestone.number)
  const name = milestone === null ? t(lang, 'group.noMilestone') : headingTitleOf(milestone.title)
  const issueRows = issues.map(issue => renderIssue(view, issue))
  // The issues of a closed milestone sit under its title, marked closed, the title linked to its milestone page. Its counts are not read,
  // so there is no progress line (pm1-9).
  if (closedTitle !== null) {
    const closedLabel = t(lang, 'milestone.closed', {
      label: milestoneLabelOf(view, closedNumber, headingTitleOf(closedTitle), [statusIconEmoji('done')]),
    })
    return [renderMilestoneHeading(view, `milestone-closed-${closedTitle}`, closedLabel, closedNumber, true), ...issueRows]
  }
  if (milestone === null) {
    return issues.length > 0 ? [<Text key={`milestone-${groupKey}`} bold>{name}</Text>, ...issueRows] : []
  }
  // The heading reads the title, then its icons: the milestone icon, then the overdue icon when overdue (Mock S delta 11, SPEC section 19).
  const heading = milestoneLabelOf(view, milestone.number, name, [actionIconEmoji('milestone'), overdueIconOf(view, milestone)])
  // The count is the total. Exact counts name issues; inexact ones are REST's, which count PRs too, so they take the neutral noun
  // "items" (ux-5).
  const total = milestone.openIssues + milestone.closedIssues
  const progressKey = milestone.countsExact ? 'milestone.progress' : 'milestone.progressItems'
  const progress = (
    <Text key={`progress-${groupKey}`}>
      {progressLineOf(view, milestone, t(lang, progressKey, { closed: milestone.closedIssues, total, count: total }))}
    </Text>
  )
  const objective = objectiveLinesOf(view, milestone, groupKey)
  if (issues.length > 0)
    return [renderMilestoneHeading(view, `milestone-${groupKey}`, heading, milestone.number, true), ...objective, progress, ...issueRows]
  // "All closed" is drawn only from exact counts: REST's zero (PRs included) or a partial answer never says the milestone is done. An exact
  // zero of closed issues too has no issue at all, so it reads "no issues" (no done icon, nothing to close).
  if (milestone.countsExact && milestone.openIssues === 0) {
    const label =
      milestone.closedIssues > 0
        ? t(lang, 'milestone.allClosed', { label: milestoneLabelOf(view, milestone.number, name, [statusIconEmoji('done')]) })
        : t(lang, 'milestone.noIssues', { label: milestoneLabelOf(view, milestone.number, name, [actionIconEmoji('milestone')]) })
    return [renderMilestoneHeading(view, `milestone-${groupKey}`, label, milestone.number, false), ...objective, progress]
  }
  // An open milestone whose open issues all sit on sessions says how many are open, so its remaining work stays visible in the pane
  // (pm1-2); that claim is drawn only when the issue list backs it (rev-g1-5).
  const title = group.claimsLinked ? t(lang, 'milestone.allLinked', { label: heading, count: milestone.openIssues }) : heading
  return [renderMilestoneHeading(view, `milestone-${groupKey}`, title, milestone.number, false), ...objective, progress]
}

// The milestone's objective, its GitHub description as plain text, drawn under the heading; no line when the milestone has none (Mock S delta 9).
function objectiveLinesOf(view: View, milestone: Milestone, groupKey: string): RenderElement[] {
  if (!milestone.description) return []
  const { Text } = view.ui
  return [<Text key={`objective-${groupKey}`}>{t(view.lang, 'milestone.objective', { text: milestone.description })}</Text>]
}

// The progress line: the text bar and its percentage (exact counts only), the count and the due date (its calendar date, from GitHub's own
// date, never shifted into the host's zone: pm1-4). The overdue marker sits on the heading (overdueIconOf), so this line names no state.
function progressLineOf(view: View, milestone: Milestone, count: string): string {
  const { lang } = view
  const bar = milestone.countsExact ? progressBarOf(milestone.closedIssues, milestone.openIssues + milestone.closedIssues) : ''
  const due =
    milestone.dueOn === null
      ? ''
      : withIcon(statusIconEmoji('due'), t(lang, 'milestone.due', { date: milestone.dueOn.slice(0, DATE_LENGTH) }))
  return [bar, count, due].filter(part => part !== '').join(TITLE_SEPARATOR)
}

// The overdue icon after a milestone's heading: an open milestone with open issues, exact counts and a due date before today (isOverdue).
function overdueIconOf(view: View, milestone: Milestone): string {
  const { now, utcOffsetMinutes } = view
  const overdue =
    milestone.dueOn !== null && milestone.countsExact && milestone.openIssues > 0 && isOverdue(milestone.dueOn, now, utcOffsetMinutes)
  return overdue ? statusIconEmoji('overdue') : ''
}

// The milestone label: its title up to the first " · " (repo-work-pane-design-spec.md section 3.1).
function titleLabel(title: string): string {
  return title.split(TITLE_SEPARATOR)[0] ?? title
}

// A milestone's title on its heading: titleLabel, then cut at MILESTONE_TITLE_MAX characters, the ellipsis counted, at the last space before the
// limit (Mock S delta 11, Q9, Q17).
function headingTitleOf(title: string): string {
  return cutAtWord(titleLabel(title), MILESTONE_TITLE_MAX)
}

// A milestone's label on its heading: the title first, then " ↗" when the heading links to the milestone's page (Mock S delta 10), then the
// icons in order; an empty icon is left out.
function milestoneLabelOf(view: View, number: number | null, title: string, icons: readonly string[]): string {
  const linked = linkTargetOf(view, milestonePageOf(view.repoPage, number)) !== null
  return joinWords([linked ? `${title} ↗` : title, ...icons])
}

function renderIssue(view: View, issue: Issue): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`issue-${issue.number}`} flexDirection="column">
      {renderIssueLine(view, issue)}
      {issue.labels.length > 0 && <Text key="labels">{issue.labels.map(name => `[${name}]`).join(' ')}</Text>}
    </Box>
  )
}

// An issue row is a link to its GitHub page on the desktop, which opens it; the terminal and any address that is not a
// plain https one draw the row as plain Text.
// The priority tag ("P1") leads the row's text; P0 and P1 rows are drawn bold (EMPHASISED_PRIORITIES).
function renderIssueLine(view: View, issue: Issue): RenderElement {
  const { ui } = view
  const priority = priorityOf(issue.labels)
  const tag = priority === null ? '' : `${priorityEmoji(priority)} ${priority} `
  const label = `${tag}#${issue.number} ${issue.title}`
  const emphasised = priority !== null && EMPHASISED_PRIORITIES.includes(priority)
  const target = linkTargetOf(view, issue.url)
  if (target !== null && 'Markdown' in ui) {
    const { Markdown } = ui
    const link = `${LINK_MARK} [${escapeMarkdown(`${label} ↗`)}](${target})`
    return <Markdown key={`line-${issue.number}`} text={emphasised ? `**${link}**` : link} />
  }
  const { Text } = ui
  return <Text key={`line-${issue.number}`} bold={emphasised}>{label}</Text>
}

// The footer's legend, a table headed Labels: one row per icon the body draws, with its name and a sentence. The emoji are read from
// action-icons.ts by name, so the legend cannot drift from the table and holds no emoji of its own. The rows run in four groups:
// the session states, the work, the history, the project. The band-only icons (no issue, no remote, tools) are not listed, and
// neither are the loading and failure lines, which draw without the footer. The text glyphs and the missing priority icon are not rows:
// one note line under the table says them (renderLegendNote).
// A desktop row may show a timeline marker in place of the emoji (`mark`), since the desktop's timeline draws markers, not emoji.
type LegendEntry = { id: string; icon: string; mark?: MarkKind; name: MessageKey; text: MessageKey }
// The emoji cell's width in terminal columns: one emoji (2 columns) and two of gap. Every legend row draws one emoji, priorities included.
const LEGEND_ICON_COLUMNS = 4
const LEGEND_ENTRIES: readonly LegendEntry[] = [
  { id: 'working', icon: actionIconEmoji('working'), name: 'legend.working.name', text: 'legend.working.text' },
  { id: 'waiting', icon: actionIconEmoji('waiting'), name: 'legend.waiting.name', text: 'legend.waiting.text' },
  { id: 'idle', icon: actionIconEmoji('idle'), name: 'legend.idle.name', text: 'legend.idle.text' },
  { id: 'issues', icon: statusIconEmoji('issues'), name: 'legend.issues.name', text: 'legend.issues.text' },
  { id: 'issue', icon: actionIconEmoji('inProgress'), name: 'legend.issue.name', text: 'legend.issue.text' },
  { id: 'done', icon: statusIconEmoji('done'), name: 'legend.done.name', text: 'legend.done.text' },
  { id: 'closed', icon: statusIconEmoji('closed'), name: 'legend.closed.name', text: 'legend.closed.text' },
  { id: 'commit', icon: statusIconEmoji('commit'), name: 'legend.commit.name', text: 'legend.commit.text' },
  { id: 'pr', icon: statusIconEmoji('pr'), name: 'legend.pr.name', text: 'legend.pr.text' },
  { id: 'session', icon: statusIconEmoji('session'), name: 'legend.sessionEvent.name', text: 'legend.sessionEvent.text' },
  { id: 'milestone', icon: actionIconEmoji('milestone'), name: 'legend.milestone.name', text: 'legend.milestone.text' },
  { id: 'due', icon: statusIconEmoji('due'), name: 'legend.due.name', text: 'legend.due.text' },
  { id: 'warning', icon: actionIconEmoji('error'), name: 'legend.warning.name', text: 'legend.warning.text' },
  { id: 'priority-p0', icon: priorityEmoji('P0'), name: 'legend.priorityP0.name', text: 'legend.priorityP0.text' },
  { id: 'priority-p1', icon: priorityEmoji('P1'), name: 'legend.priorityP1.name', text: 'legend.priorityP1.text' },
  { id: 'priority-p2', icon: priorityEmoji('P2'), name: 'legend.priorityP2.name', text: 'legend.priorityP2.text' },
  { id: 'priority-p3', icon: priorityEmoji('P3'), name: 'legend.priorityP3.name', text: 'legend.priorityP3.text' },
  { id: 'sessions', icon: statusIconEmoji('sessions'), name: 'legend.sessions.name', text: 'legend.sessions.text' },
]
// The timeline's rows of the table: the terminal's emoji rows (commit, PR, session event), and on the desktop the markers of the line
// instead (SPEC section 24), in the order the legend reads them.
const TIMELINE_LEGEND_IDS: ReadonlySet<string> = new Set(['commit', 'pr', 'session'])
const MARK_LEGEND: readonly LegendEntry[] = [
  { id: 'mark-now', icon: '', mark: 'now', name: 'legend.now.name', text: 'legend.now.text' },
  { id: 'mark-release', icon: '', mark: 'release', name: 'legend.release.name', text: 'legend.release.text' },
  { id: 'mark-commit', icon: '', mark: 'commit', name: 'legend.commit.name', text: 'legend.commit.text' },
  { id: 'mark-test', icon: '', mark: 'test', name: 'legend.test.name', text: 'legend.test.text' },
  { id: 'mark-pr', icon: '', mark: 'pr', name: 'legend.pr.name', text: 'legend.pr.text' },
  { id: 'mark-session', icon: '', mark: 'session', name: 'legend.sessionEvent.name', text: 'legend.sessionEvent.text' },
  { id: 'mark-step', icon: '', mark: 'step', name: 'legend.step.name', text: 'legend.step.text' },
]

// The table's rows on a surface: on the desktop the timeline's emoji rows give way to its markers, at the place of the first of them.
function legendEntriesOf(view: View): readonly LegendEntry[] {
  if (!(view.desktop && 'Svg' in view.ui)) return LEGEND_ENTRIES
  return LEGEND_ENTRIES.flatMap(entry => (entry.id === 'commit' ? MARK_LEGEND : TIMELINE_LEGEND_IDS.has(entry.id) ? [] : [entry]))
}

// The legend, an accordion (SPEC section 19): a button that reads ▸ closed and ▾ open, then the bordered table while it is open. The
// button is drawn on every draw; the table only when open, so a closed legend draws no row.
function renderLegend(view: View): RenderElement[] {
  const toggle = renderLegendToggle(view)
  return view.legendOpen ? [toggle, renderLegendTable(view)] : [toggle]
}

// The legend's button. Its press handle is kept across redraws (held.ts), and its look is the label, so a state change makes a new one.
function renderLegendToggle(view: View): RenderElement {
  const { Button } = view.ui
  const glyph = view.legendOpen ? DISCLOSURE_OPEN : DISCLOSURE_CLOSED
  const label = `${glyph} ${t(view.lang, 'legend.title')}`
  return view.held.hold('legend-toggle', label, view.onLegendToggle, press => <Button key="legend-toggle" label={label} onPress={press} />)
}

// The table: a bold heading, then a row per entry: the icon in a fixed-width cell, then the entry's name and a sentence on when it
// appears. Each key is the entry's id, so it is the same on every draw. The block is bordered, so the table reads as one unit.
// The icon cell never shrinks (flexShrink 0): a wrapped sentence otherwise squeezes it, and its text starts further left than the
// other rows'. Rows align to the top, so a two-line sentence keeps its icon on the first line.
function renderLegendTable(view: View): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key="legend" flexDirection="column" borderStyle="round" borderDimColor paddingX={1} paddingY={1}>
      <Text key="legend-heading" bold>{t(view.lang, 'legend.title')}</Text>
      {legendEntriesOf(view).map(entry => (
        <Box key={`legend-${entry.id}`} flexDirection="row" alignItems="flex-start">
          <Box width={LEGEND_ICON_COLUMNS} flexShrink={0}>
            {entry.mark !== undefined && 'Svg' in view.ui ? renderLegendMark(view, entry.mark) : <Text>{entry.icon}</Text>}
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {renderLegendMeaning(view, entry)}
          </Box>
        </Box>
      ))}
      {renderLegendNote(view)}
    </Box>
  )
}

// A marker row's picture: the line's own marker, at its size.
function renderLegendMark(view: View, mark: MarkKind): RenderElement {
  const { Svg } = view.ui as DesktopUi
  return <Svg key={`mark-legend-${mark}`} source={timelineMarkSvg(mark)} alt={MARK_ALT[mark]} width={TIMELINE_MARK_SIZE} height={TIMELINE_MARK_SIZE} />
}

// The note under the table, muted: what ↗, ~, #n and a missing priority icon mean, as text (Mock S delta 15). It is not an icon row.
function renderLegendNote(view: View): RenderElement {
  const { Text } = view.ui
  return <Text key="legend-note" dimColor>{t(view.lang, 'legend.note')}</Text>
}

// The name in bold, then ": " and the sentence as one paragraph, so a long sentence wraps under the text column, not under the icon.
// The desktop draws it as Markdown (bold with **, as the issue lines do); the terminal nests a bold Text in a Text.
function renderLegendMeaning(view: View, entry: LegendEntry): RenderElement {
  const { Text } = view.ui
  const name = t(view.lang, entry.name)
  const sentence = t(view.lang, entry.text)
  if (view.desktop && 'Markdown' in view.ui) {
    const { Markdown } = view.ui
    return <Markdown key={`legend-${entry.id}-text`} text={`**${escapeMarkdown(name)}**: ${escapeMarkdown(sentence)}`} />
  }
  return (
    <Text key={`legend-${entry.id}-text`}>
      <Text bold>{name}</Text>
      {`: ${sentence}`}
    </Text>
  )
}

function renderFooter(view: View, snapshot: Snapshot): RenderElement {
  const { Text } = view.ui
  const repo = snapshot.repo === null ? NO_VALUE : `${snapshot.repo.owner}/${snapshot.repo.name}`
  const age = ageText(view.lang, snapshot.fetchedAt, view.now)
  return <Text key="footer">{t(view.lang, 'footer.updated', { age, repo })}</Text>
}

// Markdown punctuation in a title is escaped, so no title can become markup or a second link.
function escapeMarkdown(text: string): string {
  return text.replace(/[\t\n\r]+/g, ' ').replace(MARKDOWN_PUNCTUATION, '\\$&')
}

const pad = (value: number): string => String(value).padStart(2, '0')

// The instant shifted into the host's zone, read through the UTC getters: the runtime's own zone never decides the digits.
function hostWallClockOf(at: number, utcOffsetMinutes: number): Date {
  return new Date(at + utcOffsetMinutes * MINUTE_MS)
}

// The host's clock as HH:MM.
export function clockOf(at: number, utcOffsetMinutes: number): string {
  const when = hostWallClockOf(at, utcOffsetMinutes)
  return `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
}

// The host's date as YYYY-MM-DD, the form of a GitHub due date.
export function dateOf(at: number, utcOffsetMinutes: number): string {
  const when = hostWallClockOf(at, utcOffsetMinutes)
  return `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`
}

// A due date is overdue when it falls before today's date in the host's zone. Both are YYYY-MM-DD, so they compare as strings.
export function isOverdue(dueOn: string, now: number, utcOffsetMinutes: number): boolean {
  return dueOn.slice(0, DATE_LENGTH) < dateOf(now, utcOffsetMinutes)
}

// The whole days from today to a due date in the host's zone: 0 on the due day, negative after it. Both dates are read as UTC midnights, so
// the difference is a whole number of days.
export function daysUntilDue(dueOn: string, now: number, utcOffsetMinutes: number): number {
  const due = Date.parse(`${dueOn.slice(0, DATE_LENGTH)}T00:00:00Z`)
  const today = Date.parse(`${dateOf(now, utcOffsetMinutes)}T00:00:00Z`)
  return Math.round((due - today) / DAY_MS)
}

// A due date is due soon when it falls from today to DUE_SOON_DAYS days ahead, in the host's zone as isOverdue reads it. A due date past
// that window, or one that does not parse, is not due soon.
export function isDueSoon(dueOn: string, now: number, utcOffsetMinutes: number): boolean {
  const days = daysUntilDue(dueOn, now, utcOffsetMinutes)
  return days >= 0 && days <= DUE_SOON_DAYS
}

// The text bar of the closed share: BAR_CELLS cells, filled for the closed part, then the percentage ("▰▰▰▰▰▰▱▱▱▱ 60%"). Empty when there
// is no issue to count, so a milestone draws no bar without exact counts (the caller passes only exact ones).
export function progressBarOf(closed: number, total: number): string {
  if (total <= 0) return ''
  const share = closed / total
  const filled = Math.round(share * BAR_CELLS)
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(BAR_CELLS - filled)} ${Math.round(share * PERCENT_MAX)}%`
}

// "just now", "N min ago", "N h ago", "N d ago", in the language of the pane.
function ageText(lang: Lang, at: number, now: number): string {
  const minutes = Math.floor((now - at) / MINUTE_MS)
  if (minutes < 1) return t(lang, 'age.now')
  if (minutes < MINUTES_PER_HOUR) return t(lang, 'age.min', { minutes })
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  return hours < HOURS_PER_DAY
    ? t(lang, 'age.h', { hours })
    : t(lang, 'age.d', { days: Math.floor(hours / HOURS_PER_DAY) })
}
