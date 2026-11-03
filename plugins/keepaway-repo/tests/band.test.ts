// Tests of the band row above the prompt (hooks/band.tsx and its handler in hooks/register.tsx): its status line (running with
// the tool, the agents and the elapsed time, or idle with the time since the last turn), its repo context (the milestone with
// its progress and the issue, no issue, no GitHub remote), the icon of each state and action (an SVG on the desktop, the emoji on
// the terminal), the product mark (still in every state, never turning: ux4-13), the KeepGlide mark before the button
// on the desktop, its Open button with hotkey 2 on the desktop and the terminal, the press that opens the pane, the label that reads
// Show once it is open, the press handle kept across a redraw, and the elapsed time of an agent that outlives its turn (R2-05).
// The host is stubbed beneath the plugin as register.test.ts does: no record is read, and gh and git never run.
import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { ACTION_ICON_SIZE, actionIconEmoji, actionIconSvg, type ActionIconKey } from '../hooks/action-icons'
import { bandContextWords, bandStatusWords, bandErrorWords, bandWordsText, renderBand, type BandTurn, type BandView, type BandWord } from '../hooks/band'
import { heldButtons } from '../hooks/held'
import { KEEPGLIDE_ALT } from '../hooks/keepglide'
import { turnEnded, turnStarted, turnToolNamed } from '../hooks/turn'

const HOME = '/test-home'
const RECORDS = '/test-records'
const SESSION = { cwd: '/work/app', surface: 'terminal', isInteractive: true } as const
const COMMAND_CONTEXT = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const PANE_ID = 'repo-work'
const SECOND = 1_000
const MINUTE = 60_000
const NOW = 10_000_000
const LONG_TITLE = 'Sprint-with-a-very-long-milestone-title'
const ISSUE_VIEW = { number: 106, milestoneTitle: 'W16-hotfix', progress: { closed: 10, total: 16 } }
const IDLE: BandTurn = { startedAt: null, endedAt: null, tool: null }
const RUNNING: BandTurn = { startedAt: NOW - 3 * MINUTE, endedAt: null, tool: 'Bash' }
const ALL_ICON_KEYS: ActionIconKey[] = [
  'idle',
  'working',
  'thinking',
  'waiting',
  'mcp',
  'shell',
  'read',
  'edit',
  'search',
  'web',
  'agent',
  'tool',
  'milestone',
  'inProgress',
  'noMilestone',
  'noIssue',
  'noRemote',
  'error',
]

// The element table of a surface: each constructor returns the element it was given as plain data, so the tree can be read.
type Drawn = { tag: string; props: Record<string, unknown> }
const fakeElement = (tag: string) => (props: Record<string, unknown>): Drawn => ({ tag, props })
const DESKTOP = { Box: fakeElement('Box'), Button: fakeElement('Button'), Text: fakeElement('Text'), Svg: fakeElement('Svg') }
const TERMINAL = { Box: fakeElement('Box'), Button: fakeElement('Button'), Text: fakeElement('Text') }

// Every drawn element of a tree, the root first, in order.
function drawnNodes(node: unknown): Drawn[] {
  if (Array.isArray(node)) return node.flatMap(drawnNodes)
  if (typeof node !== 'object' || node === null || !('tag' in node)) return []
  const drawn = node as Drawn
  return [drawn, ...drawnNodes(drawn.props.children)]
}

const view = (overrides: Partial<BandView> = {}): BandView => ({
  lang: 'en',
  surface: 'terminal',
  open: false,
  repo: 'github',
  issue: ISSUE_VIEW,
  turn: IDLE,
  agents: 0,
  now: NOW,
  ...overrides,
})

const buttonsOf = (drawn: unknown): Drawn[] => drawnNodes(drawn).filter(node => node.tag === 'Button')

// Presses a drawn Button: its handler is the one the band gave it, and a missing one fails the test.
function pressOf(button: Drawn | undefined): void {
  const onPress = button?.props.onPress
  if (typeof onPress !== 'function') throw new Error('the button has no press handler')
  onPress()
}

// The engine stub: the store, the locale, the open calls, and no Desktop record, git or gh.
type Host = { opened: { id: string; focus: boolean | undefined }[]; clock: ReturnType<typeof mock.clock> }

function stubHost(on: On): Host {
  const store = new Map<string, unknown>()
  const host: Host = { opened: [], clock: mock.clock(on) }
  mock.env(on, { HOME, KEEPAWAY_DESKTOP_SESSIONS: RECORDS })
  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('session.start', (_$, event) => ({ cwd: event.cwd }))
  on('session.id', () => ({ value: 'sess-self' }))
  on('session.repo', () => ({ value: { root: null, remote: null, internal: false, name: 'acme/app', id: 'repo' } }))
  on('store.get', (_$, event) => ({ value: store.get(event.key) }))
  on('store.set', (_$, event) => {
    store.set(event.key, event.value)
    return { value: undefined }
  })
  on('store.delete', (_$, event) => {
    store.delete(event.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.open', (_$, event) => {
    host.opened.push({ id: event.id, focus: event.focus })
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', () => ({ deny: 'Executable not found in $PATH' }))
  return host
}

const mountBand = ($: Engine, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'keepaway-repo', surface, component: 'AbovePrompt', props: {} as never })

// The strings a drawn node holds, its children read in order (JSX hands a Text its children as an array).
function stringsOf(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(stringsOf)
  if (typeof node === 'object' && node !== null && 'props' in node) return stringsOf((node as Drawn).props.children)
  return []
}

const textsOf = (drawn: unknown): string[] =>
  drawnNodes(drawn).flatMap(node => (node.tag === 'Text' ? stringsOf(node.props.children) : []))

// The SVG sources a drawn tree holds, in order.
const svgSourcesOf = (drawn: unknown): string[] =>
  drawnNodes(drawn).flatMap(node => (node.tag === 'Svg' ? [String(node.props.source)] : []))

const lineOf = (words: BandWord[] | null): string | null => (words === null ? null : bandWordsText(words))

// The state icon of a surface, as the drawn tree holds it: its SVG source on the desktop, its emoji text on the terminal.
const stateIconOn = (surface: 'desktop' | 'terminal', icon: ActionIconKey): string =>
  surface === 'desktop' ? actionIconSvg(icon, ACTION_ICON_SIZE) : actionIconEmoji(icon)

// A text as it reads inside the JSON of the drawn tree (the quotes and backslashes escaped), without its outer quotes.
const jsonTextOf = (text: string): string => JSON.stringify(text).slice(1, -1)

test('the running status is the working icon alone, then the tool, the agents and the elapsed time, in each language', () => {
  expect(bandStatusWords(view({ turn: RUNNING, agents: 2 }))[0]).toEqual({ icon: 'working', text: '' })
  expect(lineOf(bandStatusWords(view({ turn: RUNNING, agents: 2 })))).toBe('Bash · 2 agents · 3 min')
  expect(lineOf(bandStatusWords(view({ turn: { ...RUNNING, tool: null }, agents: 1 })))).toBe('thinking · 1 agent · 3 min')
  expect(lineOf(bandStatusWords(view({ turn: { startedAt: NOW - 42 * SECOND, endedAt: null, tool: null } })))).toBe('thinking · 42 s')
  expect(lineOf(bandStatusWords(view({ turn: { startedAt: NOW - 61 * MINUTE, endedAt: null, tool: 'Read' } })))).toBe('Read · 1 h 1 min')
  expect(bandStatusWords(view({ lang: 'pt', turn: RUNNING, agents: 1 }))[0]).toEqual({ icon: 'working', text: '' })
  expect(lineOf(bandStatusWords(view({ lang: 'pt', turn: RUNNING, agents: 1 })))).toBe('Bash · 1 agente · 3 min')
  expect(lineOf(bandStatusWords(view({ lang: 'pt', turn: RUNNING, agents: 3 })))).toBe('Bash · 3 agentes · 3 min')
})

test('the idle status is the idle icon alone, then the time since the last turn ended, or nothing before the first turn', () => {
  expect(bandStatusWords(view())).toEqual([{ icon: 'idle', text: '' }])
  expect(lineOf(bandStatusWords(view({ turn: { startedAt: null, endedAt: NOW - 5 * MINUTE, tool: null } })))).toBe('5 min ago')
  expect(lineOf(bandStatusWords(view({ turn: { startedAt: null, endedAt: NOW - 10 * SECOND, tool: null } })))).toBe('just now')
  expect(lineOf(bandStatusWords(view({ lang: 'pt', turn: { startedAt: null, endedAt: NOW - 5 * MINUTE, tool: null } })))).toBe('há 5 min')
})

// The register redraws the idle band each minute with the clock's now (tests/register.test.ts); this is the text that redraw draws.
test('the idle band drawn a minute after the turn ended reads 1 min ago, where a second earlier it read just now', () => {
  const ended: BandTurn = { startedAt: null, endedAt: NOW - MINUTE, tool: null }
  const before = textsOf(renderBand(TERMINAL, view({ turn: ended, now: NOW - SECOND }), () => {}, heldButtons()))
  const after = textsOf(renderBand(TERMINAL, view({ turn: ended, now: NOW }), () => {}, heldButtons()))
  expect(before).toContain('just now')
  expect(before).not.toContain('1 min ago')
  expect(after).toContain('1 min ago')
  expect(after).not.toContain('just now')
})

test('the repo context names the milestone with its progress and the issue', () => {
  expect(lineOf(bandContextWords(view()))).toBe('W16-hotfix 10/16 · #106')
  expect(lineOf(bandContextWords(view({ issue: { number: 106, milestoneTitle: 'W16-hotfix', progress: null } })))).toBe('W16-hotfix · #106')
  // Details known, no milestone: the band says so (ux-1). Details missing: the milestone is unknown, so the word is omitted.
  expect(lineOf(bandContextWords(view({ issue: { number: 106, milestoneTitle: null, progress: null } })))).toBe('no milestone · #106')
  expect(lineOf(bandContextWords(view({ issue: { number: 106, milestoneTitle: null, progress: null, detailsMissing: true } })))).toBe('#106')
  expect(lineOf(bandContextWords(view({ issue: null })))).toBe('no issue')
  expect(lineOf(bandContextWords(view({ repo: 'none', issue: null })))).toBe('no GitHub remote')
  expect(lineOf(bandContextWords(view({ lang: 'pt', issue: null })))).toBe('sem issue')
  expect(bandContextWords(view({ repo: 'unknown' }))).toBeNull()
})

test('a long milestone title is cut to 24 characters in the band', () => {
  const issue = { number: 7, milestoneTitle: LONG_TITLE, progress: { closed: 2, total: 5 } }
  expect(lineOf(bandContextWords(view({ issue })))).toBe(`${LONG_TITLE.slice(0, 23)}… 2/5 · #7`)
})

for (const [surface, ui] of [['desktop', DESKTOP], ['terminal', TERMINAL]] as const) {
  test(`the band draws its working icon, its context and an Open button with hotkey 2 on the ${surface}`, () => {
    const drawn = renderBand(ui, view({ surface, turn: RUNNING, agents: 1 }), () => {}, heldButtons())
    const [button] = buttonsOf(drawn)
    expect(button?.props.label).toBe('Open')
    expect(button?.props.hotkey).toBe('2')
    expect(button?.props.variant).toBe('primary')
    const stateIcons = surface === 'desktop' ? svgSourcesOf(drawn) : textsOf(drawn)
    expect(stateIcons).toContain(stateIconOn(surface, 'working'))
    expect(textsOf(drawn)).toEqual(expect.arrayContaining(['Bash', '1 agent', '3 min', 'W16-hotfix 10/16', '#106']))
    expect(textsOf(drawn)).not.toContain('Running')
  })
}

test('the Open button runs its handler and reads Show when the pane is open', () => {
  const held = heldButtons()
  let presses = 0
  const [closed] = buttonsOf(renderBand(TERMINAL, view(), () => (presses += 1), held))
  expect(closed?.props.label).toBe('Open')
  pressOf(closed)
  expect(presses).toBe(1)
  const open = buttonsOf(renderBand(TERMINAL, view({ open: true }), () => (presses += 1), held))[0]
  expect(open?.props.label).toBe('Show')
})

test('a redraw keeps the press handle and runs the latest handler', () => {
  const held = heldButtons()
  const calls: string[] = []
  const [first] = buttonsOf(renderBand(TERMINAL, view(), () => calls.push('first'), held))
  const [second] = buttonsOf(renderBand(TERMINAL, view(), () => calls.push('second'), held))
  expect(second).toBe(first)
  pressOf(second)
  expect(calls).toEqual(['second'])
})

// The icon of each tool: a built-in tool by its kind, an MCP tool by its server, any other tool by the generic icon.
const TOOL_ICONS: [string, ActionIconKey][] = [
  ['Bash', 'shell'],
  ['Read', 'read'],
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['Grep', 'search'],
  ['Glob', 'search'],
  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['Agent', 'agent'],
  ['SomeOtherTool', 'tool'],
]

for (const [tool, icon] of TOOL_ICONS) {
  test(`the running tool ${tool} is written with the ${icon} icon`, () => {
    expect(bandStatusWords(view({ turn: { ...RUNNING, tool } }))[1]).toEqual({ icon, text: tool })
  })
}

test('an MCP tool reads as its server, with the mcp icon: "MCP master-jev-hook · 3 min"', () => {
  const turn = { ...RUNNING, tool: 'mcp__master-jev-hook__request_decision' }
  expect(lineOf(bandStatusWords(view({ turn })))).toBe('MCP master-jev-hook · 3 min')
  expect(bandStatusWords(view({ turn }))[1]).toEqual({ icon: 'mcp', text: 'MCP master-jev-hook' })
  expect(lineOf(bandStatusWords(view({ lang: 'pt', turn })))).toBe('MCP master-jev-hook · 3 min')
})

test('thinking, the agents and idle each carry their icon', () => {
  expect(bandStatusWords(view({ turn: { ...RUNNING, tool: null } }))[1]).toEqual({ icon: 'thinking', text: 'thinking' })
  expect(bandStatusWords(view({ turn: RUNNING, agents: 2 }))[2]).toEqual({ icon: 'agent', text: '2 agents' })
  expect(bandStatusWords(view())[0]).toEqual({ icon: 'idle', text: '' })
})

test('the running word carries the working icon, the green dot (🟢), and no text', () => {
  expect(bandStatusWords(view({ turn: RUNNING }))[0]).toEqual({ icon: 'working', text: '' })
})

test('the context carries the milestone, issue, no-issue and no-remote icons', () => {
  expect(bandContextWords(view())).toEqual([
    { icon: 'milestone', text: 'W16-hotfix 10/16' },
    { icon: 'inProgress', text: '#106' },
  ])
  expect(bandContextWords(view({ issue: null }))).toEqual([{ icon: 'noIssue', text: 'no issue' }])
  expect(bandContextWords(view({ issue: { number: 106, milestoneTitle: null, progress: null } }))).toEqual([
    { icon: 'noMilestone', text: 'no milestone' },
    { icon: 'inProgress', text: '#106' },
  ])
  expect(bandContextWords(view({ repo: 'none', issue: null }))).toEqual([{ icon: 'noRemote', text: 'no GitHub remote' }])
})

// The emoji each action draws on the terminal, key by key (action-icons.ts): a key that draws another icon fails here (sp-7).
const EXPECTED_EMOJI: Readonly<Record<ActionIconKey, string>> = {
  idle: '💤',
  working: '🟢',
  thinking: '💭',
  waiting: '⏳',
  mcp: '🔌',
  shell: '💻',
  read: '📖',
  edit: '✏️',
  search: '🔎',
  web: '🌐',
  agent: '🤖',
  tool: '🔧',
  milestone: '🎯',
  inProgress: '🛠️',
  noMilestone: '⭕',
  noIssue: '📭',
  noRemote: '🚫',
  error: '⚠️',
}

test('every action icon has its expected emoji for the terminal and an SVG for the desktop on the same grid', () => {
  for (const key of ALL_ICON_KEYS) {
    expect(actionIconEmoji(key)).toBe(EXPECTED_EMOJI[key])
    const svg = actionIconSvg(key, ACTION_ICON_SIZE)
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).toContain(`width="${ACTION_ICON_SIZE}"`)
  }
})

test('the product mark is the same still mark in every state on the desktop (sp-6)', () => {
  const states = [
    view({ surface: 'desktop' }),
    view({ surface: 'desktop', turn: RUNNING, agents: 2, agentsSince: NOW - 3 * MINUTE }),
    view({ surface: 'desktop', repo: 'none', issue: null }),
    view({ surface: 'desktop', error: true }),
  ]
  const marks = states.map(state => svgSourcesOf(renderBand(DESKTOP, state, () => {}, heldButtons()))[0])
  expect(new Set(marks).size).toBe(1)
  expect(marks[0]).not.toContain('animate')
})

test('on the desktop an action is drawn as its SVG; on the terminal the same action is its emoji text', () => {
  const turn = { ...RUNNING, tool: 'Bash' }
  const desktop = renderBand(DESKTOP, view({ surface: 'desktop', turn, agents: 1 }), () => {}, heldButtons())
  expect(svgSourcesOf(desktop)).toContain(actionIconSvg('shell', ACTION_ICON_SIZE))
  expect(svgSourcesOf(desktop)).toContain(actionIconSvg('agent', ACTION_ICON_SIZE))
  expect(textsOf(desktop)).not.toContain('💻')
  const terminal = renderBand(TERMINAL, view({ surface: 'terminal', turn, agents: 1 }), () => {}, heldButtons())
  expect(textsOf(terminal)).toEqual(expect.arrayContaining(['💻', '🤖']))
  expect(drawnNodes(terminal).some(node => node.tag === 'Svg')).toBe(false)
})

test('the product mark stays still in every state on the desktop; the terminal draws no mark, only the state icon', () => {
  const scope = globalThis as { matchMedia?: (query: string) => { matches: boolean } }
  const before = scope.matchMedia
  scope.matchMedia = () => ({ matches: false }) // a page that accepts motion: the mark still does not turn (ux4-13)
  try {
    const running = renderBand(DESKTOP, view({ surface: 'desktop', turn: RUNNING }), () => {}, heldButtons())
    const idle = renderBand(DESKTOP, view({ surface: 'desktop' }), () => {}, heldButtons())
    expect(svgSourcesOf(running)[0]).not.toContain('animateTransform')
    expect(svgSourcesOf(running)[0]).toBe(svgSourcesOf(idle)[0])
  } finally {
    scope.matchMedia = before
  }
  // The terminal draws no leading mark: the state icon already says running or idle.
  const runningTexts = textsOf(renderBand(TERMINAL, view({ turn: RUNNING }), () => {}, heldButtons()))
  const idleTexts = textsOf(renderBand(TERMINAL, view(), () => {}, heldButtons()))
  expect(runningTexts).not.toContain('▶')
  expect(idleTexts).not.toContain('○')
  expect(runningTexts).toContain('🟢')
  expect(idleTexts).toContain('💤')
})

// The mark never turns, with or without a page to ask: a turning mark with no pause breaks WCAG 2.2.2 (ux4-13).
test('without matchMedia the running mark stays still on the desktop', () => {
  const scope = globalThis as { matchMedia?: (query: string) => { matches: boolean } }
  const before = scope.matchMedia
  scope.matchMedia = undefined
  try {
    const drawn = renderBand(DESKTOP, view({ surface: 'desktop', turn: RUNNING }), () => {}, heldButtons())
    expect(svgSourcesOf(drawn)[0]).not.toContain('animateTransform')
  } finally {
    scope.matchMedia = before
  }
})

test('under reduced motion the running mark stays still', () => {
  const scope = globalThis as { matchMedia?: (query: string) => { matches: boolean } }
  const before = scope.matchMedia
  scope.matchMedia = () => ({ matches: true })
  try {
    const drawn = renderBand(DESKTOP, view({ surface: 'desktop', turn: RUNNING }), () => {}, heldButtons())
    expect(svgSourcesOf(drawn)[0]).not.toContain('animateTransform')
  } finally {
    scope.matchMedia = before
  }
})

test('the KeepGlide mark sits immediately before the Open button on the desktop only', () => {
  const desktop = drawnNodes(renderBand(DESKTOP, view({ surface: 'desktop' }), () => {}, heldButtons()))
  const keepglide = desktop.findIndex(node => node.tag === 'Svg' && node.props.alt === KEEPGLIDE_ALT)
  expect(keepglide).toBeGreaterThanOrEqual(0)
  expect(desktop[keepglide + 1]?.tag).toBe('Button')
  const terminal = drawnNodes(renderBand(TERMINAL, view(), () => {}, heldButtons()))
  expect(terminal.some(node => node.props.alt === KEEPGLIDE_ALT)).toBe(false)
})

test('R2-05: an agent still running after its turn ended counts the elapsed time from the turn start', () => {
  const turn = turnEnded(turnToolNamed(turnStarted(NOW - 3 * MINUTE), 'Bash'), NOW - MINUTE)
  const words = bandStatusWords(view({ turn, agents: 1, agentsSince: NOW - 2 * MINUTE }))
  expect(words[0]).toEqual({ icon: 'working', text: '' })
  expect(lineOf(words)).toBe('1 agent · 3 min')
})

test('R2-05: an agent that began after an earlier turn ended does not count that turn', () => {
  const turn = turnEnded(turnStarted(NOW - 10 * MINUTE), NOW - 5 * MINUTE)
  const words = bandStatusWords(view({ turn, agents: 1, agentsSince: NOW - MINUTE }))
  expect(words[0]).toEqual({ icon: 'working', text: '' })
  expect(lineOf(words)).toBe('1 agent · 1 min')
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the band on the ${surface} presses open the pane, and reads Show afterwards`, async ($, on) => {
    const host = stubHost(on)
    await $.session.start(SESSION)
    const band = await mountBand($, surface)
    expect(await band.find({ type: 'Button', key: 'open' })).toBeTruthy()
    expect((await band.find({ type: 'Button', key: 'open' }))?.props.hotkey).toBe('2')
    // Idle with no turn: the idle icon alone, drawn on this surface, and no state word.
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toContain(jsonTextOf(stateIconOn(surface, 'idle')))
    expect(drawn).not.toContain('"Idle"')
    await band.press({ key: 'open' })
    expect(host.opened).toEqual([{ id: PANE_ID, focus: true }])
    await host.clock.settle()
    await band.unmount()

    const again = await mountBand($, surface)
    expect((await again.find({ type: 'Button', key: 'open' }))?.props.label).toBe('Show')
    expect(await again.find({ type: 'Text', text: 'no GitHub remote' })).toBeTruthy()
    await again.press({ key: 'open' })
    expect(host.opened).toHaveLength(2)
    expect(host.opened[1]).toEqual({ id: PANE_ID, focus: true })
    await again.unmount()
  })
}

test('the band reads in the stored language', async ($, on) => {
  const host = stubHost(on)
  await $.session.start(SESSION)
  await $.command.run({ command: 'keepaway', args: 'lang pt-BR', ...COMMAND_CONTEXT })
  const band = await mountBand($, 'terminal')
  expect((await band.find({ type: 'Button', key: 'open' }))?.props.label).toBe('Abrir')
  await band.press({ key: 'open' })
  await host.clock.settle()
  await band.unmount()
  const opened = await mountBand($, 'terminal')
  expect(await opened.find({ type: 'Text', text: 'sem remote no GitHub' })).toBeTruthy()
  // The idle state is its icon alone in pt-BR too: the pt-BR word (Parada) is gone with the band's words.
  expect(await opened.find({ type: 'Text', text: actionIconEmoji('idle') })).toBeTruthy()
  expect(await opened.find({ type: 'Text', text: 'Parada' })).toBeFalsy()
  expect((await opened.find({ type: 'Button', key: 'open' }))?.props.label).toBe('Mostrar')
  await opened.unmount()
})

test('agents still running after the main turn ended: the working icon with their count and the time since they began', () => {
  const words = bandStatusWords(view({ turn: IDLE, agents: 2, agentsSince: NOW - 3 * MINUTE }))
  expect(words[0]).toEqual({ icon: 'working', text: '' })
  expect(lineOf(words)).toBe('2 agents · 3 min')
  expect(bandStatusWords(view({ turn: IDLE, agents: 0, agentsSince: null }))).toEqual([{ icon: 'idle', text: '' }])
})

test('F19: a milestone title is cut by characters, so an emoji is never split in the band', () => {
  const title = '🚀'.repeat(30)
  expect(lineOf(bandContextWords(view({ issue: { number: 7, milestoneTitle: title, progress: null } })))).toBe(`${'🚀'.repeat(23)}… · #7`)
})

test('F08: a window whose issue details are missing reads #<n> alone, never no issue', () => {
  expect(lineOf(bandContextWords(view({ issue: { number: 106, milestoneTitle: null, progress: null, detailsMissing: true } })))).toBe('#106')
})

test('a waiting window draws the waiting icon alone, before the loop words', () => {
  expect(bandStatusWords(view({ waiting: true }))).toEqual([
    { icon: 'waiting', text: '' },
    { icon: 'idle', text: '' },
  ])
  expect(bandStatusWords(view({ lang: 'pt', waiting: true, turn: RUNNING }))[0]).toEqual({ icon: 'waiting', text: '' })
  expect(lineOf(bandStatusWords(view({ lang: 'pt', waiting: true, turn: RUNNING })))).toBe('Bash · 3 min')
})

test('a snapshot with errors adds the data error word with the error icon, and no word when it is clean', () => {
  expect(bandErrorWords(view({ error: true }))).toEqual([{ icon: 'error', text: 'data error' }])
  expect(bandErrorWords(view())).toEqual([])
})

// Regression: the no-milestone word names its icon, which the table must hold; drawing the band with such an issue used to throw.
test('a band whose issue has no milestone draws the ⭕ icon before its words, and does not throw', () => {
  const noMilestone = { number: 106, milestoneTitle: null, progress: null }
  expect(textsOf(renderBand(TERMINAL, view({ issue: noMilestone }), () => {}, heldButtons()))).toContain('⭕')
  expect(textsOf(renderBand(TERMINAL, view({ issue: noMilestone }), () => {}, heldButtons()))).toContain('no milestone')
  expect(svgSourcesOf(renderBand(DESKTOP, view({ surface: 'desktop', issue: noMilestone }), () => {}, heldButtons())).length).toBeGreaterThan(0)
})
