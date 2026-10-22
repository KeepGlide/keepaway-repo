// The KeepTrack pane: the header, the sessions on this machine by group (Askaway's tree: a bold label, the family root's
// rows under it, then the derived sessions; this window's group first, the window highlighted with its issue details, its
// timeline and its GitHub link), the issues without a session by milestone, and the footer. It draws one Snapshot the
// register hands in and reads or writes no state. Nothing folds: every row, every detail and every timeline is always drawn.
// A title or a group label goes into a link only after escaping; a Desktop Group name, commit subjects, comments and labels
// stay plain Text.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type {
  Issue,
  IssueDetails,
  IssueGroup,
  IssueRef,
  PaneError,
  PullRequest,
  SessionGroup,
  SessionNode,
  Snapshot,
  TimelineEvent,
} from '../types'
import { t, type Lang, type MessageKey } from './i18n'
import { TEXT_MAX, TIMELINE_LIMIT, isSessionLinkId, plain } from './model'
import { BRANCH_GLYPH, DETAILS_FILL, LINK_MARK, STATE_GLYPH } from './look'
import { KEEPGLIDE_HEADER_SIZE, renderKeepGlide, renderKeepTrackLogo } from './logo-element'

type Ui = Elements[RenderSurface]

export type PaneContext = {
  snapshot: Snapshot | null
  lang: Lang
  surface: string
}

// What every drawing function reads: the element table, the language, the clock of this draw, the surface, and this
// window's issue details (null when not fetched).
type View = {
  ui: Ui
  lang: Lang
  desktop: boolean
  now: number
  thisIssue: IssueDetails | null
}

// Where a session row sits: its branch glyph under a parent ("├" or "└", null at the top), the parent's issue (breadcrumb),
// and the level it is drawn at below its group's rows (0 in the group body, whatever its depth in the tree; W1).
type RowPlace = { branch: string | null; parentIssue: IssueRef | null; level: number }

// The tops drawn under one label: a Desktop Group's, or a session family's (buildTree keeps a group's tops together).
type GroupRun = { group: SessionGroup; tops: SessionNode[] }

type DetailLine = { key: string; label: string; value: string }

// Derived rows indent two cells per level, at most two levels, so a 360 px pane holds them (repo-work-pane-design-spec.md section 2.4).
const INDENT_CELLS = 2
const MAX_INDENT_LEVELS = 2
// The indent of a row's body under its state glyph: the title starts after the glyph, and after the branch glyph too.
const BODY_INDENT_ROOT = 2
const BODY_INDENT_CHILD = 4
// The indent of a group's rows under its label (Askaway's ROOT_PLACE), and the place of a family root's rows there.
const GROUP_INDENT = 1
const ROOT_PLACE: RowPlace = { branch: null, parentIssue: null, level: 0 }
const TITLE_SEPARATOR = ' · '
const MINUTE_MS = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
// The drawn stand-in for a value the snapshot does not carry (no repo, no next step).
const NO_VALUE = '—'
// A clickable issue or PR links only to a GitHub page over https: nothing a title or a URL carries can break out of the link,
// and a remote on another host never becomes a link to github.com (S4).
const GITHUB_PAGE_URL = /^https:\/\/github\.com\/[^\s()<>[\]"']+$/
// Markdown punctuation that a title could carry; escaped before it goes into a link label.
const MARKDOWN_PUNCTUATION = /[\\`*_[\]()<>!|~&:.@]/g
const TIMELINE_GLYPH: Readonly<Record<TimelineEvent['kind'], string>> = { commit: '●', pr: '↗', session: '▪' }
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
    now: Date.now(),
    thisIssue: snapshot?.thisIssue ?? null,
  }
  const { Box, Text } = elements
  return (
    <Box key="keeptrack-repo-pane" flexDirection="column" gap={1}>
      {renderHeader(view, snapshot)}
      {snapshot === null ? <Text key="loading">{t(view.lang, 'pane.loading')}</Text> : renderSnapshot(view, snapshot)}
    </Box>
  )
}

// The header: the logo and the bold heading on the left; the counter and the KeepGlide mark on the right (askaway's header).
function renderHeader(view: View, snapshot: Snapshot | null): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key="header" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1}>
      <Box key="brand" flexDirection="row" alignItems="center" gap={1}>
        {renderKeepTrackLogo(view.ui, view.desktop, t(view.lang, 'pane.heading'))}
        <Text key="heading" bold>{t(view.lang, 'pane.heading')}</Text>
      </Box>
      <Box key="header-end" flexDirection="row" alignItems="center" gap={1}>
        {snapshot !== null && <Text key="counter">{counterText(view, snapshot)}</Text>}
        {renderKeepGlide(view.ui, view.desktop, 'keepglide-header', KEEPGLIDE_HEADER_SIZE)}
      </Box>
    </Box>
  )
}

function counterText(view: View, snapshot: Snapshot): string {
  const sessions = countSessions(snapshot.sessions)
  return sessions === 0
    ? t(view.lang, 'counter.none')
    : t(view.lang, 'counter.line', {
        issues: t(view.lang, 'counter.issues', { count: snapshot.openIssueCount }),
        sessions: t(view.lang, 'counter.sessions', { count: sessions }),
      })
}

function countSessions(nodes: readonly SessionNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countSessions(node.children), 0)
}

// The body of a snapshot, top to bottom: the error lines above the groups, the sessions, the issues (github mode only),
// and the footer.
function renderSnapshot(view: View, snapshot: Snapshot): RenderElement[] {
  const issues = snapshot.mode === 'github' ? [renderIssuesSection(view, snapshot)] : []
  return [
    ...renderErrors(view, snapshot),
    renderSessionsSection(view, snapshot),
    ...issues,
    renderFooter(view, snapshot),
  ]
}

function renderErrors(view: View, snapshot: Snapshot): RenderElement[] {
  // The records line only when a record could not be read (N1): a folder that failed alone draws no count.
  const lines = snapshot.errors
    .filter(error => error !== 'records-unreadable' || snapshot.unreadableCount > 0)
    .map(error => t(view.lang, ERROR_KEY[error], error === 'records-unreadable' ? { count: snapshot.unreadableCount } : {}))
  for (const count of snapshot.truncatedLimits) lines.push(t(view.lang, 'error.truncated', { count }))
  const { Text } = view.ui
  return lines.map((line, index) => <Text key={`error-${index}`}>{line}</Text>)
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

function renderSessionsSection(view: View, snapshot: Snapshot): RenderElement {
  const rows = groupsOf(snapshot.sessions).map(run => renderGroup(view, snapshot, run))
  return renderSection(view, 'sessions', t(view.lang, 'group.sessions'), rows)
}

// The tops in consecutive runs of one group key each. A top without a group is a family of its own.
function groupsOf(tops: readonly SessionNode[]): GroupRun[] {
  const runs: GroupRun[] = []
  for (const top of tops) {
    const group = top.group ?? { key: top.id, label: top.title, href: top.id, isDesktopGroup: false }
    const last = runs.at(-1)
    if (last?.group.key === group.key) last.tops.push(top)
    else runs.push({ group, tops: [top] })
  }
  return runs
}

// Whether a top is the root of its family group: its rows sit right under the label, which is its title.
const isFamilyRoot = (group: SessionGroup, node: SessionNode): boolean => !group.isDesktopGroup && node.id === group.key

// One group, drawn as Askaway draws a branch: the label in bold, the family root's rows right under it (the label is the
// root's title, so it is not drawn twice), then the derived rows, "├" and "└" on the last: the root's children, then the
// group's other tops. A family whose root ended, and a Desktop Group, have no root rows: each top is a titled derived row
// with its own children under it.
function renderGroup(view: View, snapshot: Snapshot, run: GroupRun): RenderElement {
  const { group, tops } = run
  const root = tops.find(top => isFamilyRoot(group, top))
  const derived = [
    ...(root?.children ?? []).map(node => ({ node, parentIssue: root?.issue ?? null })),
    ...tops.filter(top => top !== root).map(node => ({ node, parentIssue: null })),
  ]
  const lastIndex = derived.length - 1
  const { Box } = view.ui
  return (
    <Box key={`group-${group.key}`} flexDirection="column">
      {renderGroupLabel(view, groupLabelOf(view, snapshot, run), group, root?.isThisWindow === true)}
      <Box key="group-rows" flexDirection="column" gap={1} paddingLeft={GROUP_INDENT}>
        {root !== undefined && renderRootRows(view, root)}
        {derived.map(({ node, parentIssue }, index) =>
          renderSessionRow(view, node, {
            branch: index === lastIndex ? BRANCH_GLYPH.last : BRANCH_GLYPH.middle,
            parentIssue,
            level: 0,
          }),
        )}
      </Box>
    </Box>
  )
}

// The label of a group: its own, else the first of its tops' labels that is not blank, else the repo name, else
// "the session".
function groupLabelOf(view: View, snapshot: Snapshot, run: GroupRun): string {
  const labels = [run.group.label, ...run.tops.map(top => top.group?.label ?? ''), snapshot.repo?.name ?? '']
  return labels.find(label => label !== '') ?? t(view.lang, 'group.session')
}

// The label line of a group, bold. On the desktop a family's label links to its root session, escaped as a session title
// is, with this window's marker when the root is this window. A Desktop Group's name (the user's own text) and the terminal
// draw plain Text. The key carries the group's: the engine refuses a draw where two Markdown elements share one.
function renderGroupLabel(view: View, label: string, group: SessionGroup, isThis: boolean): RenderElement {
  const { ui, lang } = view
  const marker = isThis ? ` ${t(lang, 'session.thisWindow')}` : ''
  const key = `group-label-${group.key}`
  const href = group.isDesktopGroup ? null : group.href
  if (view.desktop && 'Markdown' in ui && href !== null && isSessionLinkId(href)) {
    const { Markdown } = ui
    return <Markdown key={key} text={`**[${escapeMarkdown(`${label} ↗`)}](#${href})**${escapeMarkdown(marker)}`} />
  }
  const { Text } = ui
  return <Text key={key} bold>{`${label}${marker}`}</Text>
}

// The rows of a family's root right under its group's label: untitled (the label is its title), and without its children,
// which the group draws as its derived rows.
function renderRootRows(view: View, node: SessionNode): RenderElement {
  const { Box } = view.ui
  return (
    <Box key={`session-${node.id}`} flexDirection="column">
      {node.isThisWindow ? renderThisWindow(view, node, ROOT_PLACE, false) : renderOtherSession(view, node, ROOT_PLACE, false)}
    </Box>
  )
}

function renderIssuesSection(view: View, snapshot: Snapshot): RenderElement {
  const rows = snapshot.issueGroups.flatMap(group => renderIssueGroup(view, group))
  const { Text } = view.ui
  const body = rows.length > 0 ? rows : [<Text key="issues-none">{t(view.lang, 'issues.none')}</Text>]
  return renderSection(view, 'issues', t(view.lang, 'group.issues'), body)
}

// A session row and, under it, its derived sessions (one level deeper, each with its branch glyph).
function renderSessionRow(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const { Box } = view.ui
  return (
    <Box key={`session-${node.id}`} flexDirection="column" gap={1}>
      {node.isThisWindow ? renderThisWindow(view, node, place, true) : renderOtherSession(view, node, place, true)}
      {renderChildren(view, node, place.level)}
    </Box>
  )
}

// This window's row: one highlighted block with its title (when titled) and breadcrumb, its details (Estado ... Iniciada)
// when its issue is fetched, its timeline, and the GitHub link as the last line. A window with no issue has no details and
// no link.
function renderThisWindow(view: View, node: SessionNode, place: RowPlace, titled: boolean): RenderElement {
  const { Box } = view.ui
  const indent = bodyIndentOf(place)
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
      {renderSessionHead(view, node, place, titled)}
      {node.issue !== null && thisIssue !== null && renderDetails(view, node, thisIssue, indent)}
      {renderTimeline(view, node, indent)}
      {node.issue !== null && renderGithubLink(view, node.issue.number, thisIssue?.url ?? node.issueUrl, indent)}
    </Box>
  )
}

// Another session's row: its title (when titled), its breadcrumb and its timeline.
function renderOtherSession(view: View, node: SessionNode, place: RowPlace, titled: boolean): RenderElement {
  const { Box } = view.ui
  return (
    <Box key={`row-${node.id}`} flexDirection="column" gap={1}>
      {renderSessionHead(view, node, place, titled)}
      {renderTimeline(view, node, bodyIndentOf(place))}
    </Box>
  )
}

function bodyIndentOf(place: RowPlace): number {
  return place.branch === null ? BODY_INDENT_ROOT : BODY_INDENT_CHILD
}

// The title line (branch glyph under a parent, state glyph, title) and the breadcrumb under it. An untitled row (a family
// root, whose group's label is its title) starts with the state glyph and the breadcrumb.
function renderSessionHead(view: View, node: SessionNode, place: RowPlace, titled: boolean): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`head-${node.id}`} flexDirection="row" gap={1}>
      {place.branch !== null && <Text key="branch">{place.branch}</Text>}
      <Text key="state">{STATE_GLYPH[node.state]}</Text>
      <Box key="title-block" flexDirection="column" flexGrow={1}>
        {titled && renderSessionTitle(view, node, node.isThisWindow)}
        {renderCrumb(view, node, place)}
      </Box>
    </Box>
  )
}

// The title is a link to the session where the Desktop draws Markdown and the id is a session id; the Desktop opens it.
// Elsewhere (the terminal, or an id that is not a session link) it is plain Text, without the arrow.
function renderSessionTitle(view: View, node: SessionNode, isThis: boolean): RenderElement {
  const { ui, lang } = view
  const marker = isThis ? t(lang, 'session.thisWindow') : ''
  if (view.desktop && 'Markdown' in ui && isSessionLinkId(node.id)) {
    const { Markdown } = ui
    const anchor = `[${escapeMarkdown(`${node.title} ↗`)}](#${node.id})`
    const linked = isThis ? `**${anchor}**` : anchor
    return <Markdown key={`title-${node.id}`} text={isThis ? `${linked} ${escapeMarkdown(marker)}` : linked} />
  }
  const { Text } = ui
  return <Text key={`title-${node.id}`} bold={isThis}>{isThis ? `${node.title} ${marker}` : node.title}</Text>
}

// The breadcrumb parts: the issue, the milestone (or "no milestone"), then a derived session's origin (none for a root).
function crumbPartsOf(lang: Lang, node: SessionNode, place: RowPlace): string[] {
  const issue = node.issue === null ? t(lang, 'crumb.noIssue') : `#${node.issue.number}`
  const milestone = node.milestoneTitle === null ? t(lang, 'crumb.noMilestone') : titleLabel(node.milestoneTitle)
  if (node.kind === 'root') return [issue, milestone]
  const origin =
    place.parentIssue === null
      ? t(lang, 'crumb.derived')
      : t(lang, 'crumb.derivedFrom', { number: place.parentIssue.number })
  return [issue, milestone, origin]
}

// The breadcrumb: "#n · milestone · origin". On the desktop #n links to the issue page when the address is a plain https one.
function renderCrumb(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const [issue = '', ...rest] = crumbPartsOf(view.lang, node, place)
  const { ui } = view
  if (view.desktop && 'Markdown' in ui && node.issueUrl !== null && GITHUB_PAGE_URL.test(node.issueUrl)) {
    const { Markdown } = ui
    const linkedIssue = `[${escapeMarkdown(issue)}](${node.issueUrl})`
    return <Markdown key={`crumb-${node.id}`} text={[linkedIssue, ...rest.map(escapeMarkdown)].join(TITLE_SEPARATOR)} />
  }
  const { Text } = ui
  return <Text key={`crumb-${node.id}`}>{[issue, ...rest].join(TITLE_SEPARATOR)}</Text>
}

// The indent the children of a row drawn at `level` add under it, while they are within MAX_INDENT_LEVELS (W1): the indents
// of the boxes between a row and its group's rows add up to the cap, never more. The level is the drawn one, so a listed
// root's children (depth 1, in the group body) and a group's other tops (depth 0) indent alike: 1/3/5 in every group.
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

// The details of this window's issue: "Heading: text" lines, each heading bold, always drawn (repo-work-pane-design-spec.md D5, as built).
function renderDetails(view: View, node: SessionNode, issue: IssueDetails, indent: number): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`details-${node.id}`} flexDirection="column" gap={1} paddingLeft={indent}>
      {detailLinesOf(view, node, issue).map(line => (
        <Box key={`detail-${line.key}`} flexDirection="row" flexWrap="wrap" gap={1}>
          <Text key="label" bold>{`${line.label}:`}</Text>
          <Text key="value">{line.value}</Text>
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
    { key: 'pr', label: t(lang, 'detail.pr'), value: prTextOf(lang, issue.pr) },
    { key: 'commit', label: t(lang, 'detail.lastCommit'), value: commitTextOf(lang, issue.lastCommit, now) },
    { key: 'checks', label: t(lang, 'detail.checks'), value: issue.checks ?? t(lang, 'detail.noCi') },
    { key: 'comment', label: t(lang, 'detail.lastComment'), value: commentTextOf(lang, issue.lastComment, now) },
    { key: 'blocked', label: t(lang, 'detail.blockedBy'), value: issue.blockedBy ?? t(lang, 'detail.nothing') },
    { key: 'next', label: t(lang, 'detail.nextStep'), value: NO_VALUE },
    {
      key: 'started',
      label: t(lang, 'detail.started'),
      value: `${clockOf(issue.startedAt)}${TITLE_SEPARATOR}${ageText(lang, issue.startedAt, now)}`,
    },
  ]
}

// The session state word, with the issue's state added when the issue is closed (an override may name one).
function stateTextOf(lang: Lang, state: SessionNode['state'], issueState: IssueDetails['state']): string {
  const word = t(lang, STATE_KEY[state])
  return issueState === 'closed' ? `${word}${TITLE_SEPARATOR}${t(lang, 'detail.issueClosed')}` : word
}

function prTextOf(lang: Lang, pr: IssueDetails['pr']): string {
  if (pr === null) return t(lang, 'detail.noPr')
  const review = pr.reviewDecision === null ? '' : `${TITLE_SEPARATOR}${t(lang, REVIEW_KEY[pr.reviewDecision])}`
  return `#${pr.number} ${pr.title}${TITLE_SEPARATOR}${t(lang, PR_STATE_KEY[pr.state])}${review}`
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

// The GitHub link of this window's issue: a Markdown link to its https page on the desktop, plain text elsewhere.
function renderGithubLink(view: View, number: number, url: string | null, indent: number): RenderElement {
  const { Box, Text } = view.ui
  const label = t(view.lang, 'link.github', { number })
  if (view.desktop && 'Markdown' in view.ui && url !== null && GITHUB_PAGE_URL.test(url)) {
    const { Markdown } = view.ui
    return (
      <Box key="github-link" paddingLeft={indent}>
        <Markdown key="link" text={`${LINK_MARK} [${escapeMarkdown(label)}](${url})`} />
      </Box>
    )
  }
  return (
    <Box key="github-link" paddingLeft={indent}>
      <Text key="link">{`${LINK_MARK} ${label}`}</Text>
    </Box>
  )
}

// The timeline, newest first: time, kind glyph, text. Always drawn, at most TIMELINE_LIMIT events, never folded.
function renderTimeline(view: View, node: SessionNode, indent: number): RenderElement {
  const { Box, Text } = view.ui
  const events = [...node.timeline].sort((a, b) => b.at - a.at).slice(0, TIMELINE_LIMIT)
  return (
    <Box key={`timeline-${node.id}`} flexDirection="column" gap={1} paddingLeft={indent}>
      {events.map((event, index) => (
        <Box key={`event-${node.id}-${index}`} flexDirection="row" gap={1}>
          <Text key="time">{clockOf(event.at)}</Text>
          <Text key="glyph">{TIMELINE_GLYPH[event.kind]}</Text>
          <Box key="text" flexGrow={1}>
            <Text>{timelineText(view.lang, node, event)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// The variable part of an event's text (repo-work-pane-design-spec.md section 3.2) drawn with its key. A commit subject and a PR's
// "<number> <title>" are plain values; a session event names its parent (fork, spawn) or nothing (root).
function timelineText(lang: Lang, node: SessionNode, event: TimelineEvent): string {
  if (event.kind === 'commit') return t(lang, 'timeline.commit', { subject: event.text })
  if (event.kind === 'pr') {
    const [number = '', ...words] = event.text.split(' ')
    return t(lang, 'timeline.pr', { number, title: words.join(' ') })
  }
  if (event.text === '') return t(lang, SESSION_EVENT_BARE_KEY[node.kind])
  return t(lang, SESSION_EVENT_KEY[node.kind], { title: event.text })
}

function renderIssueGroup(view: View, group: IssueGroup): RenderElement[] {
  const { lang } = view
  const { Text } = view.ui
  const groupKey = group.milestone === null ? 'none' : String(group.milestone.number)
  const label = group.milestone === null ? t(lang, 'group.noMilestone') : titleLabel(group.milestone.title)
  if (group.issues.length > 0) {
    return [
      <Text key={`milestone-${groupKey}`} bold>{label}</Text>,
      ...group.issues.map(issue => renderIssue(view, issue)),
    ]
  }
  // An open milestone with no open issue left is one line; one whose issues all sit on sessions has nothing to list.
  if (group.milestone !== null && group.milestone.openIssues === 0) {
    return [<Text key={`milestone-${groupKey}`}>{t(lang, 'milestone.allClosed', { label })}</Text>]
  }
  return []
}

// The milestone label: its title up to the first " · " (repo-work-pane-design-spec.md section 3.1).
function titleLabel(title: string): string {
  return title.split(TITLE_SEPARATOR)[0] ?? title
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
function renderIssueLine(view: View, issue: Issue): RenderElement {
  const { ui } = view
  const label = `#${issue.number} ${issue.title}`
  if (view.desktop && 'Markdown' in ui && GITHUB_PAGE_URL.test(issue.url)) {
    const { Markdown } = ui
    return <Markdown key={`line-${issue.number}`} text={`${LINK_MARK} [${escapeMarkdown(label)}](${issue.url})`} />
  }
  const { Text } = ui
  return <Text key={`line-${issue.number}`}>{label}</Text>
}

function renderFooter(view: View, snapshot: Snapshot): RenderElement {
  const { Text } = view.ui
  const repo = snapshot.repo === null ? NO_VALUE : `${snapshot.repo.owner}/${snapshot.repo.name}`
  const minutes = Math.max(0, Math.floor((view.now - snapshot.fetchedAt) / MINUTE_MS))
  return <Text key="footer">{t(view.lang, 'footer.updated', { minutes, repo })}</Text>
}

// Markdown punctuation in a title is escaped, so no title can become markup or a second link.
function escapeMarkdown(text: string): string {
  return text.replace(/[\t\n\r]+/g, ' ').replace(MARKDOWN_PUNCTUATION, '\\$&')
}

const pad = (value: number): string => String(value).padStart(2, '0')

function clockOf(at: number): string {
  const when = new Date(at)
  return `${pad(when.getHours())}:${pad(when.getMinutes())}`
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
