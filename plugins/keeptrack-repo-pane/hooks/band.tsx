// The band row above the prompt, the window's status line: the state of the main loop (running with its tool, its agents and
// the elapsed time, or idle since the last turn ended), the repo context (this window's milestone with its progress, and its
// issue), and a button that opens the pane (hotkey 2). The leading mark is the product mark on the desktop, turning while the
// loop runs, and a text glyph on the terminal. Each action has its icon: an SVG on the desktop, its emoji on the terminal
// (hooks/action-icons.ts). The KeepGlide mark sits before the button on the desktop. The register decides when the row is drawn
// (on the desktop and the terminal, always); this file only draws it, and wraps to two rows on a narrow surface.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { ACTION_ICON_SIZE, actionIconEmoji, actionIconSvg, type ActionIconKey } from './action-icons'
import type { HeldButtons } from './held'
import { t, type Lang } from './i18n'
import { renderKeepGlide, renderKeepTrackMark } from './logo-element'
import type { BandTurn } from './turn'

type Ui = Elements[RenderSurface]

// The repo the band names: a GitHub remote, none when the window has none, unknown before the first poll.
export type BandRepo = 'github' | 'none' | 'unknown'

// This window's issue as the snapshot knows it: the title of its milestone (null when it has none) and that milestone's
// progress (null when the milestone is not open, so the snapshot does not carry its counts).
export type BandIssue = {
  number: number
  milestoneTitle: string | null
  progress: { closed: number; total: number } | null
  // true when the issue's details are missing (its view failed): the band shows `#<n>` alone.
  detailsMissing?: boolean
}

export type BandView = {
  lang: Lang
  surface: RenderSurface
  // Whether the pane is open: the button then reads Show, and its press focuses the pane.
  open: boolean
  repo: BandRepo
  issue: BandIssue | null
  turn: BandTurn
  // The agents that have not ended (`$.agent.list()` active count, as the register last read it), and when their run began.
  agents: number
  agentsSince?: number | null
  // This window's session waits for the person (the engine asked about a tool call): the band reads that it waits.
  waiting?: boolean
  // The snapshot holds errors: the band flags the repo data as incomplete.
  error?: boolean
  // The clock of this draw, in ms: the elapsed and idle times are measured against it.
  now: number
}

// One word of the band's line: its text, and the action icon drawn before it (none for a plain word).
export type BandWord = { icon: ActionIconKey | null; text: string }

// Another mod's band may take the digit 1, so this band takes 2; both can show above the same prompt.
const BAND_HOTKEY = '2'
const SEPARATOR = ' · '
// A milestone title longer than this is cut in the band so the line keeps its place; the pane shows the whole title.
const MILESTONE_TITLE_MAX = 24
// The KeepGlide mark before the button: the band's height.
const KEEPGLIDE_BAND_SIZE = 18
const MCP_PREFIX = 'mcp__'
const SECOND_MS = 1_000
const MINUTE_MS = 60_000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

// The icon of each built-in tool; an MCP tool is told apart by its prefix, and any other tool gets the generic icon.
const TOOL_ICONS = new Map<string, ActionIconKey>([
  ['Bash', 'shell'],
  ['Read', 'read'],
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Grep', 'search'],
  ['Glob', 'search'],
  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['Agent', 'agent'],
])

const word = (text: string, icon: ActionIconKey | null = null): BandWord => ({ icon, text })

// A span of time as the running turn reads it: "42 s", "3 min", "1 h 5 min".
function spanText(lang: Lang, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND_MS))
  if (seconds < SECONDS_PER_MINUTE) return t(lang, 'band.span.seconds', { seconds })
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  if (minutes < MINUTES_PER_HOUR) return t(lang, 'band.span.minutes', { minutes })
  return t(lang, 'band.span.hours', { hours: Math.floor(minutes / MINUTES_PER_HOUR), minutes: minutes % MINUTES_PER_HOUR })
}

// How long ago a turn ended, in the pane's words: "just now", "5 min ago", "2 h ago", "3 d ago".
function agoText(lang: Lang, ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS)
  if (minutes < 1) return t(lang, 'age.now')
  if (minutes < MINUTES_PER_HOUR) return t(lang, 'age.min', { minutes })
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  return hours < HOURS_PER_DAY ? t(lang, 'age.h', { hours }) : t(lang, 'age.d', { days: Math.floor(hours / HOURS_PER_DAY) })
}

function agentsText(lang: Lang, count: number): string {
  return count === 1 ? t(lang, 'band.agentsOne') : t(lang, 'band.agents', { count })
}

// The running turn's last tool as a word: an MCP tool reads as its server ("MCP master-jev-hook"), the others by their name.
function toolWordOf(tool: string): BandWord {
  if (tool.startsWith(MCP_PREFIX)) return word(`MCP ${tool.split('__')[1] ?? ''}`.trimEnd(), 'mcp')
  return word(tool, TOOL_ICONS.get(tool) ?? 'tool')
}

// The main loop or an agent is active: the band reads Running.
function runningOf(view: BandView): boolean {
  return view.turn.startedAt !== null || view.agents > 0
}

// The start the elapsed time counts from, the earlier of: the running turn's start, or (R2-05) the start of a turn that ended while
// an agent still runs, and the agents' run start. A turn that ended before the agents' run began did not start them, so it does not count.
function elapsedOriginOf(view: BandView): number | null {
  const { turn } = view
  const agentsSince = view.agents > 0 ? (view.agentsSince ?? null) : null
  const endedOverlap = turn.endedAt !== null && agentsSince !== null && turn.endedAt >= agentsSince
  const turnStart = turn.startedAt ?? (endedOverlap ? (turn.endedTurnStart ?? null) : null)
  const starts = [turnStart, agentsSince].filter((at): at is number => at !== null)
  return starts.length > 0 ? Math.min(...starts) : null
}

// The band's line as words. While the turn or an agent runs: Running, the tool or thinking (only while the turn runs), the agents,
// the elapsed time. Otherwise: Idle, and the time since the last turn ended (nothing more before the first turn).
function loopWords(view: BandView): BandWord[] {
  const { lang, turn } = view
  if (!runningOf(view)) {
    const idle = word(t(lang, 'band.idle'), 'idle')
    return turn.endedAt === null ? [idle] : [idle, word(agoText(lang, view.now - turn.endedAt))]
  }
  const origin = elapsedOriginOf(view)
  const work = turn.startedAt === null ? [] : [turn.tool === null ? word(t(lang, 'band.thinking'), 'thinking') : toolWordOf(turn.tool)]
  return [
    word(t(lang, 'band.running'), 'working'),
    ...work,
    ...(view.agents > 0 ? [word(agentsText(lang, view.agents), 'agent')] : []),
    word(spanText(lang, view.now - (origin ?? view.now))),
  ]
}

// The band's status words: the waiting word first when this window's session waits for the user, then the loop's words.
export function bandStatusWords(view: BandView): BandWord[] {
  const loop = loopWords(view)
  return view.waiting === true ? [word(t(view.lang, 'state.waiting'), 'waiting'), ...loop] : loop
}

// The flag of a snapshot that holds errors: one word after the repo context, drawn with the error icon.
export function bandErrorWords(view: BandView): BandWord[] {
  return view.error === true ? [word(t(view.lang, 'band.error'), 'error')] : []
}

function shortTitleOf(title: string): string {
  const characters = Array.from(title)
  return characters.length <= MILESTONE_TITLE_MAX ? title : `${characters.slice(0, MILESTONE_TITLE_MAX - 1).join('')}…`
}

// The milestone of this window's issue, with its progress when the snapshot has it: "W16-hotfix 10/16". The issue's details are
// known here, so a null title means the issue has no milestone: "no milestone" (ux-1).
function milestoneWordOf(lang: Lang, issue: BandIssue): BandWord {
  if (issue.milestoneTitle === null) return word(t(lang, 'crumb.noMilestone'), 'noMilestone')
  const title = shortTitleOf(issue.milestoneTitle)
  return word(issue.progress === null ? title : `${title} ${issue.progress.closed}/${issue.progress.total}`, 'milestone')
}

// The repo context as words: the milestone, then the issue ("W16-hotfix 10/16", "#106"); "#106" alone when the issue's details are
// missing (the milestone is then unknown); "no milestone" for an issue with none; "no issue"; "no GitHub remote". Null before the first poll.
export function bandContextWords(view: BandView): BandWord[] | null {
  const { lang, repo, issue } = view
  if (repo === 'unknown') return null
  if (repo === 'none') return [word(t(lang, 'band.noRemote'), 'noRemote')]
  if (issue === null) return [word(t(lang, 'crumb.noIssue'), 'noIssue')]
  const number = word(`#${issue.number}`, 'inProgress')
  const milestone = issue.detailsMissing === true ? null : milestoneWordOf(lang, issue)
  return milestone === null ? [number] : [milestone, number]
}

// The words as plain text, apart by the separator: the line as a terminal without icons reads it.
export function bandWordsText(words: readonly BandWord[]): string {
  return words.map(item => item.text).join(SEPARATOR)
}

// The icon of a word in the drawn tree: the SVG on the desktop, its emoji as text on the terminal.
function iconNodeOf(ui: Ui, desktop: boolean, icon: ActionIconKey, key: string): RenderElement {
  if (desktop && 'Svg' in ui) {
    const { Svg } = ui
    return <Svg key={key} source={actionIconSvg(icon, ACTION_ICON_SIZE)} alt="" width={ACTION_ICON_SIZE} height={ACTION_ICON_SIZE} />
  }
  const { Text } = ui
  return <Text key={key}>{actionIconEmoji(icon)}</Text>
}

// The words in the drawn tree: each word is its icon and its text, the words apart by the separator. `prefix` keeps the keys of the
// two lines apart.
function wordNodes(ui: Ui, desktop: boolean, words: readonly BandWord[], prefix: string): RenderElement[] {
  const { Box, Text } = ui
  return words.flatMap((item, index) => {
    const separator = index === 0 ? [] : [<Text key={`${prefix}-sep-${index}`}>{SEPARATOR}</Text>]
    const icon = item.icon === null ? [] : [iconNodeOf(ui, desktop, item.icon, `${prefix}-icon-${index}`)]
    const text = <Text key={`${prefix}-text-${index}`}>{item.text}</Text>
    return [
      ...separator,
      <Box key={`${prefix}-word-${index}`} flexDirection="row" alignItems="center" gap={1}>
        {[...icon, text]}
      </Box>,
    ]
  })
}

// The band row. Its press handle is kept across redraws (held.ts), so a click that moves the focus still lands. On the desktop the
// KeepGlide mark sits immediately before the button.
export function renderBand(ui: Ui, view: BandView, onOpen: () => void, held: HeldButtons): RenderElement {
  const { Box, Button } = ui
  const desktop = view.surface === 'desktop'
  const label = t(view.lang, view.open ? 'band.show' : 'band.open')
  const context = bandContextWords(view)
  held.begin()
  const band = (
    <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
        {renderKeepTrackMark(ui, desktop)}
        <Box flexDirection="row" flexWrap="wrap" alignItems="center">
          {wordNodes(ui, desktop, bandStatusWords(view), 'status')}
        </Box>
        {context !== null && (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center">
            {wordNodes(ui, desktop, [...context, ...bandErrorWords(view)], 'context')}
          </Box>
        )}
      </Box>
      <Box flexDirection="row" alignItems="center" gap={1}>
        {renderKeepGlide(ui, desktop, 'keepglide', KEEPGLIDE_BAND_SIZE)}
        {held.hold('open', label, onOpen, press => (
          <Button key="open" label={label} hotkey={BAND_HOTKEY} variant="primary" onPress={press} />
        ))}
      </Box>
    </Box>
  )
  held.end()
  return band
}
