// Tests of the turn transitions the band reads (hooks/turn.ts): a turn that starts, calls a tool and completes; an aborted
// turn; a tool call or an end outside a turn that changes nothing; a turn that ends while an agent still runs keeps its start
// for the elapsed time (R2-05). The register writes these transitions into its atom on turn.start, tool.call, turn.complete and
// turn.abort; the test kit cannot raise a turn event, so the transitions are tested here.
import { expect, test } from 'claude-code/testing'
import { IDLE_TURN, bandRedrawDue, turnEnded, turnStarted, turnToolNamed } from '../hooks/turn'

test('a turn runs from its start through its tool to its completion', () => {
  const started = turnStarted(1_000)
  expect(started).toEqual({ startedAt: 1_000, endedAt: null, tool: null })
  const tooled = turnToolNamed(started, 'Bash')
  expect(tooled).toEqual({ startedAt: 1_000, endedAt: null, tool: 'Bash' })
  const again = turnToolNamed(tooled, 'Read')
  expect(again.tool).toBe('Read')
  expect(turnEnded(again, 5_000)).toEqual({ startedAt: null, endedAt: 5_000, tool: null, endedTurnStart: 1_000 })
})

test('an aborted turn ends the same way, and a second end changes nothing', () => {
  const ended = turnEnded(turnStarted(1_000), 2_000)
  expect(ended).toEqual({ startedAt: null, endedAt: 2_000, tool: null, endedTurnStart: 1_000 })
  expect(turnEnded(ended, 9_000)).toBe(ended)
})

test('a tool call outside a turn changes nothing, and a new turn starts without the old tool', () => {
  expect(turnToolNamed(IDLE_TURN, 'Bash')).toBe(IDLE_TURN)
  const ended = turnEnded(turnToolNamed(turnStarted(1_000), 'Bash'), 2_000)
  expect(turnStarted(3_000)).toEqual({ startedAt: 3_000, endedAt: null, tool: null })
  expect(ended.endedAt).toBe(2_000)
})

test('the idle state holds no start and no end before the first turn', () => {
  expect(IDLE_TURN).toEqual({ startedAt: null, endedAt: null, tool: null })
})

test('the band redraws on every tick while a turn runs, and on every second tick while idle', () => {
  const running = turnStarted(1_000)
  expect(bandRedrawDue(running, 1)).toBe(true)
  expect(bandRedrawDue(running, 2)).toBe(true)
  expect(bandRedrawDue(IDLE_TURN, 1)).toBe(false)
  expect(bandRedrawDue(IDLE_TURN, 2)).toBe(true)
})

test('R2-05: a turn that ends while an agent still runs keeps its start, and a call after the end or a new turn drops it', () => {
  const ended = turnEnded(turnToolNamed(turnStarted(1_000), 'Bash'), 5_000)
  expect(ended.endedTurnStart).toBe(1_000)
  expect(turnToolNamed(ended, 'Read')).toBe(ended)
  expect(turnEnded(ended, 9_000)).toBe(ended)
  expect(turnStarted(7_000).endedTurnStart).toBeUndefined()
})
