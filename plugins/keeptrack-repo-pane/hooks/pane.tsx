// The KeepTrack pane: the header, the sessions by group (a bold label, a Desktop Group's name,
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
import { PAGE_URL, RECENTS_GROUP, TEXT_MAX, TIMELINE_LIMIT, isSessionLinkId, milestonePageOf, plain, priorityOf, repoPageOf } from './model'
import { BAR_EMPTY, BAR_FILLED, BRANCH_GLYPH, DETAILS_FILL, EMPHASISED_PRIORITIES, LINK_MARK } from './look'
import { KEEPGLIDE_HEADER_SIZE, renderKeepGlide, renderKeepTrackLogo, renderRepoLogo } from './logo-element'
import { repoLabelOf } from './repo-logo'

type Ui = Elements[RenderSurface]

export type PaneContext = {
  snapshot: Snapshot | null
  // True once the first poll settled with no snapshot to show (ux4-2): the pane draws the failure line instead of Loading.
  loadFailed?: boolean
  lang: Lang
  surface: string
  // The host's UTC offset in minutes east of UTC (register.tsx reads it with `date +%z`). Clock times and dates are drawn in it.
  utcOffsetMinutes: number
  // The stored SVG of each repo's logo, by SessionNode.logoKey (register.tsx reads the store); a repo with no entry draws no logo.
  logos?: ReadonlyMap<string, string>
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
const TITLE_SEPARATOR = ' · '
const MINUTE_MS = 60_000
// The date part of a GitHub due date (YYYY-MM-DD, then the time when GitHub sends one).
const DATE_LENGTH = 10
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MINUTE_MS
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
const TIMELINE_ICON: Readonly<Record<TimelineEvent['kind'], StatusIconKey>> = { commit: 'commit', pr: 'pr', session: 'session' }
const STATE_ICON: Readonly<Record<SessionNode['state'], ActionIconKey>> = { working: 'working', idle: 'idle', waiting: 'waiting' }
const PR_STATE_ICON: Readonly<Record<PullRequest['state'], StatusIconKey>> = { OPEN: 'pr', MERGED: 'done', CLOSED: 'closed' }
// The cells of a milestone's progress bar, and the scale of its percentage.
const BAR_CELLS = 10
const PERCENT_MAX = 100
// The text with its icon before it; an empty icon leaves the text as it is.
const withIcon = (icon: string, text: string): string => (icon === '' ? text : `${icon} ${text}`)
// The non-empty parts of a line, apart by one space: a title and the icons after it.
const joinWords = (parts: readonly string[]): string => parts.filter(part => part !== '').join(' ')
// The session title as the "open session" link names it: cut to SESSION_LABEL_MAX characters, with an ellipsis when cut.
const SESSION_LABEL_MAX = 40
const shortLabel = (title: string): string =>
  [...title].length > SESSION_LABEL_MAX ? `${[...title].slice(0, SESSION_LABEL_MAX - 1).join('')}…` : title
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
    utcOffsetMinutes: context.utcOffsetMinutes,
    thisIssue: snapshot?.thisIssue ?? null,
    repoPage: snapshot?.repo ? repoPageOf({ host: 'github.com', ...snapshot.repo }) : null,
    logos: context.logos ?? new Map(),
  }
  const { Box, Text } = elements
  return (
    <Box key="keeptrack-repo-pane" flexDirection="column" gap={1}>
      {renderHeader(view, snapshot)}
      {snapshot === null ? renderUnsettled(view, context.loadFailed === true) : renderSnapshot(view, snapshot)}
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
        {renderKeepTrackLogo(view.ui, view.desktop, '')}
        <Text key="heading" bold>{t(view.lang, 'pane.heading')}</Text>
      </Box>
      <Box key="header-end" flexDirection="row" alignItems="center" gap={1}>
        {snapshot !== null && <Text key="counter">{counterText(view, snapshot)}</Text>}
        {renderKeepGlide(view.ui, view.desktop, 'keepglide-header', KEEPGLIDE_HEADER_SIZE)}
      </Box>
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
  return nodes.reduce((total, node) => total + 1 + countSessions(node.children), 0)
}

// The body of a snapshot, top to bottom: the error lines above the groups, the sessions, the issues (github mode only),
// and the footer.
function renderSnapshot(view: View, snapshot: Snapshot): RenderElement[] {
  const issues = snapshot.mode === 'github' ? [renderIssuesSection(view, snapshot)] : []
  return [
    ...renderErrors(view, snapshot),
    ...renderSessionGroups(view, snapshot),
    ...issues,
    renderLegend(view),
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
// "├" and "└" on the last.
function renderGroup(view: View, run: GroupRun): RenderElement {
  const { group, tops } = run
  const lastIndex = tops.length - 1
  const { Box } = view.ui
  return (
    <Box key={`group-${group.key}`} flexDirection="column">
      {renderGroupLabel(view, group)}
      <Box key="group-rows" flexDirection="column" gap={1} paddingLeft={GROUP_INDENT}>
        {tops.map((node, index) =>
          renderSessionRow(view, node, {
            branch: index === lastIndex ? BRANCH_GLYPH.last : BRANCH_GLYPH.middle,
            parentIssue: null,
            level: 0,
          }),
        )}
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
      {renderTimeline(view, node, BODY_INDENT, true)}
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

// The title line (branch glyph, title with its icons after it) and the breadcrumb under it. The state is an icon alone, with no
// state word, on every row; the footer's legend names each icon (SPEC section 19).
function renderSessionHead(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key={`head-${node.id}`} flexDirection="row" gap={1}>
      <Text key="branch">{place.branch}</Text>
      <Box key="title-block" flexDirection="column" flexGrow={1}>
        {renderTitleLine(view, node, node.isThisWindow)}
        {renderCrumb(view, node, place)}
      </Box>
    </Box>
  )
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
  if (node.repoPage === null || node.logoKey === null) return false
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

// The title is a link where the Desktop draws Markdown and the id is a session id. With a repo page that passes PAGE_URL, the title links
// to the repo's page and a small "open session" link after the icons opens the session; without one, the title opens the session, as
// before. Elsewhere (the terminal, or an id that is not a session link) it is plain Text, without the arrow. The icons follow the title,
// outside the link: the state icon, then the active marker, then this window's words.
function renderSessionTitle(view: View, node: SessionNode, isThis: boolean): RenderElement {
  const { ui, lang } = view
  const icons = joinWords([actionIconEmoji(STATE_ICON[node.state]), activeMarkerOf(node)])
  const marker = isThis ? t(lang, 'session.thisWindow') : ''
  if (view.desktop && 'Markdown' in ui && isSessionLinkId(node.id)) {
    const { Markdown } = ui
    const repo = linkTargetOf(view, node.repoPage)
    const anchor = `[${escapeMarkdown(`${node.title} ↗`)}](${repo ?? `#${node.id}`})`
    const title = isThis ? `**${anchor}**` : anchor
    const sessionLink = repo === null ? '' : `[${escapeMarkdown(t(lang, 'link.session', { title: shortLabel(node.title) }))}](#${node.id})`
    return <Markdown key={`title-${node.id}`} text={joinWords([title, icons, escapeMarkdown(marker), sessionLink])} />
  }
  const { Text } = ui
  return <Text key={`title-${node.id}`} bold={isThis}>{joinWords([node.title, icons, marker])}</Text>
}

// The marker of an active row: this window's row (the activeWindow icon). Any other row carries none: its state icon already says working.
function activeMarkerOf(node: SessionNode): string {
  return node.isThisWindow ? statusIconEmoji('activeWindow') : ''
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

// The breadcrumb parts: the issue (linked to its page), the milestone part, then a derived session's origin (none for a root).
function crumbPartsOf(view: View, node: SessionNode, place: RowPlace): CrumbPart[] {
  const { lang } = view
  const issue: CrumbPart =
    node.issue === null
      ? { text: t(lang, 'crumb.noIssue'), url: null }
      : { text: withIcon(actionIconEmoji('inProgress'), `#${node.issue.number}`), url: node.issueUrl }
  const milestone = milestonePartOf(lang, node, view.repoPage)
  if (node.kind === 'root') return [issue, ...milestone]
  const origin =
    place.parentIssue === null
      ? t(lang, 'crumb.derived')
      : t(lang, 'crumb.derivedFrom', { number: place.parentIssue.number })
  return [issue, ...milestone, { text: origin, url: null }]
}

// The breadcrumb: "#n · milestone · origin". On the desktop each part with a page (the issue, the milestone) links to it when the address
// passes PAGE_URL; the rest is plain text.
function renderCrumb(view: View, node: SessionNode, place: RowPlace): RenderElement {
  const parts = crumbPartsOf(view, node, place)
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

// The timeline, newest first: time, kind glyph, text. Always drawn, at most TIMELINE_LIMIT events, never folded. Only this
// window's block takes the history heading: one per session would repeat it down the pane.
function renderTimeline(view: View, node: SessionNode, indent: number, heading = false): RenderElement {
  const { Box, Text } = view.ui
  const events = [...node.timeline].sort((a, b) => b.at - a.at).slice(0, TIMELINE_LIMIT)
  return (
    <Box key={`timeline-${node.id}`} flexDirection="column" gap={1} paddingLeft={indent}>
      {heading && events.length > 0 && <Text key="heading" bold>{withIcon(statusIconEmoji('history'), t(view.lang, 'timeline.heading'))}</Text>}
      {events.map((event, index) => (
        <Box key={`event-${node.id}-${index}`} flexDirection="row" gap={1}>
          <Text key="time">{clockOf(event.at, view.utcOffsetMinutes)}</Text>
          <Text key="glyph">{statusIconEmoji(TIMELINE_ICON[event.kind])}</Text>
          <Box key="text" flexGrow={1}>
            {renderTimelineText(view, node, event)}
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
  const name = milestone === null ? t(lang, 'group.noMilestone') : titleLabel(milestone.title)
  const issueRows = issues.map(issue => renderIssue(view, issue))
  // The issues of a closed milestone sit under its title, marked closed, the title linked to its milestone page. Its counts are not read,
  // so there is no progress line (pm1-9).
  if (closedTitle !== null) {
    const closedLabel = withIcon(statusIconEmoji('done'), t(lang, 'milestone.closed', { label: titleLabel(closedTitle) }))
    return [renderMilestoneHeading(view, `milestone-closed-${closedTitle}`, closedLabel, closedNumber, true), ...issueRows]
  }
  if (milestone === null) {
    return issues.length > 0 ? [<Text key={`milestone-${groupKey}`} bold>{name}</Text>, ...issueRows] : []
  }
  const heading = withIcon(actionIconEmoji('milestone'), name)
  // The count is the total. Exact counts name issues; inexact ones are REST's, which count PRs too, so they take the neutral noun
  // "items" (ux-5).
  const total = milestone.openIssues + milestone.closedIssues
  const progressKey = milestone.countsExact ? 'milestone.progress' : 'milestone.progressItems'
  const progress = (
    <Text key={`progress-${groupKey}`}>
      {progressLineOf(view, milestone, t(lang, progressKey, { closed: milestone.closedIssues, total, count: total }))}
    </Text>
  )
  if (issues.length > 0) return [renderMilestoneHeading(view, `milestone-${groupKey}`, heading, milestone.number, true), progress, ...issueRows]
  // "All closed" is drawn only from exact counts: REST's zero (PRs included) or a partial answer never says the milestone is done. An exact
  // zero of closed issues too has no issue at all, so it reads "no issues" (no done icon, nothing to close).
  if (milestone.countsExact && milestone.openIssues === 0) {
    const label =
      milestone.closedIssues > 0
        ? withIcon(statusIconEmoji('done'), t(lang, 'milestone.allClosed', { label: name }))
        : withIcon(actionIconEmoji('milestone'), t(lang, 'milestone.noIssues', { label: name }))
    return [renderMilestoneHeading(view, `milestone-${groupKey}`, label, milestone.number, false), progress]
  }
  // An open milestone whose open issues all sit on sessions says how many are open, so its remaining work stays visible in the pane
  // (pm1-2); that claim is drawn only when the issue list backs it (rev-g1-5).
  const title = group.claimsLinked
    ? withIcon(actionIconEmoji('milestone'), t(lang, 'milestone.allLinked', { label: name, count: milestone.openIssues }))
    : heading
  return [renderMilestoneHeading(view, `milestone-${groupKey}`, title, milestone.number, false), progress]
}

// The progress line: the text bar and its percentage (exact counts only), the count, the due date (its calendar date, from GitHub's own
// date, never shifted into the host's zone: pm1-4) and the overdue marker. The overdue marker needs exact counts and open issues left.
function progressLineOf(view: View, milestone: Milestone, count: string): string {
  const { lang, now, utcOffsetMinutes } = view
  const bar = milestone.countsExact ? progressBarOf(milestone.closedIssues, milestone.openIssues + milestone.closedIssues) : ''
  const due =
    milestone.dueOn === null
      ? ''
      : withIcon(statusIconEmoji('due'), t(lang, 'milestone.due', { date: milestone.dueOn.slice(0, DATE_LENGTH) }))
  const overdue =
    milestone.dueOn !== null && milestone.countsExact && milestone.openIssues > 0 && isOverdue(milestone.dueOn, now, utcOffsetMinutes)
      ? withIcon(statusIconEmoji('overdue'), t(lang, 'milestone.overdue'))
      : ''
  return [bar, count, due, overdue].filter(part => part !== '').join(TITLE_SEPARATOR)
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
    const link = `${LINK_MARK} [${escapeMarkdown(label)}](${target})`
    return <Markdown key={`line-${issue.number}`} text={emphasised ? `**${link}**` : link} />
  }
  const { Text } = ui
  return <Text key={`line-${issue.number}`} bold={emphasised}>{label}</Text>
}

// The footer's legend, a table headed Labels: one row per icon a snapshot draws, with its name and a sentence. The emoji are read from
// action-icons.ts by name, so the legend cannot drift from the table and holds no emoji of its own. The rows run in four groups:
// the session states, the work, the history, the project. The band-only icons (no issue, no remote, tools) are not listed, and
// neither are the loading and failure lines, which draw without the footer.
type LegendEntry = { id: string; icon: string; name: MessageKey; text: MessageKey }
// The emoji cell's width in terminal columns: one emoji (2 columns) and two of gap. Every legend row draws one emoji, priorities included.
const LEGEND_ICON_COLUMNS = 4
const LEGEND_ENTRIES: readonly LegendEntry[] = [
  { id: 'working', icon: actionIconEmoji('working'), name: 'legend.working.name', text: 'legend.working.text' },
  { id: 'waiting', icon: actionIconEmoji('waiting'), name: 'legend.waiting.name', text: 'legend.waiting.text' },
  { id: 'idle', icon: actionIconEmoji('idle'), name: 'legend.idle.name', text: 'legend.idle.text' },
  { id: 'this-window', icon: statusIconEmoji('activeWindow'), name: 'legend.thisWindow.name', text: 'legend.thisWindow.text' },
  { id: 'issues', icon: statusIconEmoji('issues'), name: 'legend.issues.name', text: 'legend.issues.text' },
  { id: 'issue', icon: actionIconEmoji('inProgress'), name: 'legend.issue.name', text: 'legend.issue.text' },
  { id: 'done', icon: statusIconEmoji('done'), name: 'legend.done.name', text: 'legend.done.text' },
  { id: 'closed', icon: statusIconEmoji('closed'), name: 'legend.closed.name', text: 'legend.closed.text' },
  { id: 'history', icon: statusIconEmoji('history'), name: 'legend.history.name', text: 'legend.history.text' },
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

// The legend: a bold heading, then a row per entry: the icon in a fixed-width cell, then the entry's name and a sentence on when it
// appears. Each key is the entry's id, so it is the same on every draw. The block is bordered, so the table reads as one unit.
// The icon cell never shrinks (flexShrink 0): a wrapped sentence otherwise squeezes it, and its text starts further left than the
// other rows'. Rows align to the top, so a two-line sentence keeps its icon on the first line.
function renderLegend(view: View): RenderElement {
  const { Box, Text } = view.ui
  return (
    <Box key="legend" flexDirection="column" borderStyle="round" borderDimColor paddingX={1} paddingY={1}>
      <Text key="legend-heading" bold>{t(view.lang, 'legend.title')}</Text>
      {LEGEND_ENTRIES.map(entry => (
        <Box key={`legend-${entry.id}`} flexDirection="row" alignItems="flex-start">
          <Box width={LEGEND_ICON_COLUMNS} flexShrink={0}>
            <Text>{entry.icon}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {renderLegendMeaning(view, entry)}
          </Box>
        </Box>
      ))}
    </Box>
  )
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
