// Tests of the turn transitions the band reads (hooks/turn.ts): a turn that starts, calls a tool and completes; an aborted
// turn; an end outside a turn that changes nothing; a tool call outside a turn that starts an inferred turn (its turn.start may be
// lost, state2-2); a turn that ends while an agent still runs keeps its start for the elapsed time (R2-05); a turn past its age cap
// has lost its end. The register writes these transitions into its atom on turn.start, tool.call, turn.complete and turn.abort.
// The test kit raises turn.start and tool.call ($.turn.start and $.tool.call in tests/register.test.ts), but no test
// there raises turn.complete, and the engine has no $.turn.abort (register.test.ts:766); so the pure transitions are tested here.
import { expect, test } from 'claude-code/testing'
import {
  IDLE_TURN,
  TURN_MAX_AGE_MS,
  bandRedrawDue,
  turnEnded,
  turnExpired,
  turnStarted,
  turnTimedOut,
  turnToolNamed,
} from '../hooks/turn'

test('a turn runs from its start through its tool to its completion', () => {
  const started = turnStarted(1_000)
  expect(started).toEqual({ startedAt: 1_000, endedAt: null, tool: null })
  const tooled = turnToolNamed(started, 'Bash', 1_500)
  expect(tooled).toEqual({ startedAt: 1_000, endedAt: null, tool: 'Bash' })
  const again = turnToolNamed(tooled, 'Read', 2_000)
  expect(again.tool).toBe('Read')
  expect(turnEnded(again, 5_000)).toEqual({ startedAt: null, endedAt: 5_000, tool: null, endedTurnStart: 1_000 })
})

test('an aborted turn ends the same way, and a second end changes nothing', () => {
  const ended = turnEnded(turnStarted(1_000), 2_000)
  expect(ended).toEqual({ startedAt: null, endedAt: 2_000, tool: null, endedTurnStart: 1_000 })
  expect(turnEnded(ended, 9_000)).toBe(ended)
})

test('a tool call outside a turn starts an inferred turn that carries the tool, and a new turn starts without the old tool', () => {
  expect(turnToolNamed(IDLE_TURN, 'Bash', 1_000)).toEqual({ startedAt: 1_000, endedAt: null, tool: 'Bash' })
  const running = turnToolNamed(turnStarted(1_000), 'Bash', 1_500)
  expect(running.tool).toBe('Bash')
  const ended = turnEnded(running, 2_000)
  expect(ended.tool).toBeNull()
  expect(ended.endedAt).toBe(2_000)
  expect(turnStarted(3_000)).toEqual({ startedAt: 3_000, endedAt: null, tool: null })
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

test('R2-05: a turn that ends while an agent still runs keeps its start, and a call after the end starts a turn with no old start', () => {
  const ended = turnEnded(turnToolNamed(turnStarted(1_000), 'Bash', 1_500), 5_000)
  expect(ended.endedTurnStart).toBe(1_000)
  expect(turnToolNamed(ended, 'Read', 6_000)).toEqual({ startedAt: 6_000, endedAt: null, tool: 'Read' })
  expect(turnEnded(ended, 9_000)).toBe(ended)
  expect(turnStarted(7_000).endedTurnStart).toBeUndefined()
})

test('state2-2: a turn past its age cap has lost its end, and a turn inside the cap or idle is not expired', () => {
  const started = turnStarted(1_000)
  expect(turnExpired(started, 1_000 + TURN_MAX_AGE_MS)).toBe(false)
  expect(turnExpired(started, 1_000 + TURN_MAX_AGE_MS + 1)).toBe(true)
  expect(turnExpired(IDLE_TURN, 1_000 + TURN_MAX_AGE_MS * 10)).toBe(false)
})

test('a turn timed out ends at its expiry, startedAt + TURN_MAX_AGE_MS, not at the tick that found it', () => {
  const ended = turnTimedOut(turnStarted(1_000))
  expect(ended).toEqual({ startedAt: null, endedAt: 1_000 + TURN_MAX_AGE_MS, tool: null, endedTurnStart: 1_000 })
  expect(turnTimedOut(IDLE_TURN)).toEqual(IDLE_TURN)
})
