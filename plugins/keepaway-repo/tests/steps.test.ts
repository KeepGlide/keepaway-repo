// Plan steps read from transcript lines (SPEC section 22): update_plan and TodoWrite calls become step events, newest first.
import { expect, test } from 'claude-code/testing'
import { EMPTY_CURSOR, STEP_KEEP_MAX, currentStepOf, stepsAfter } from '../hooks/steps'

const PLAN = 'mcp__ccd_turn__update_plan'
// One assistant transcript line at an ISO time, carrying one tool call.
const call = (time: string, name: string, input: unknown): string =>
  JSON.stringify({ type: 'assistant', timestamp: time, message: { content: [{ type: 'tool_use', name, input }] } })
const at = (time: string): number => Date.parse(time)

test('an update_plan list gives one event per step in progress or done, at its line time, newest first', () => {
  const cursor = stepsAfter(EMPTY_CURSOR, [
    call('2026-11-02T10:19:00Z', PLAN, { items: [{ content: 'Look around', status: 'in_progress' }, { content: 'Fix', status: 'pending' }] }),
    call('2026-11-02T10:25:00Z', PLAN, { items: [{ content: 'Look around', status: 'completed' }, { content: 'Fix', status: 'in_progress' }] }),
  ])
  expect(cursor.events).toEqual([
    { at: at('2026-11-02T10:25:00Z'), text: 'Fix' },
    { at: at('2026-11-02T10:19:00Z'), text: 'Look around' },
  ])
  expect(currentStepOf(cursor)).toBe('Fix')
})

test('advance, done and start move the last plan on; each newly started step gets its event', () => {
  const first = stepsAfter(EMPTY_CURSOR, [
    call('2026-11-02T10:00:00Z', PLAN, {
      items: [
        { content: 'One', status: 'in_progress' },
        { content: 'Two', status: 'pending' },
        { content: 'Three', status: 'pending' },
      ],
    }),
    call('2026-11-02T10:05:00Z', PLAN, { advance: true }),
  ])
  expect(currentStepOf(first)).toBe('Two')
  const moved = stepsAfter(first, [call('2026-11-02T10:09:00Z', PLAN, { done: [2], start: 3 })])
  expect(currentStepOf(moved)).toBe('Three')
  expect(moved.events.map(event => event.text)).toEqual(['Three', 'Two', 'One'])
})

test('a step seen only as done gets its event at that time, and a step named again adds none', () => {
  const cursor = stepsAfter(EMPTY_CURSOR, [
    call('2026-11-02T09:00:00Z', PLAN, { items: [{ content: 'Done already', status: 'completed' }] }),
    call('2026-11-02T09:30:00Z', PLAN, { items: [{ content: 'Done already', status: 'completed' }, { content: 'Next', status: 'pending' }] }),
  ])
  expect(cursor.events).toEqual([{ at: at('2026-11-02T09:00:00Z'), text: 'Done already' }])
  expect(currentStepOf(cursor)).toBeNull()
})

test('TodoWrite todos count as a plan too', () => {
  const cursor = stepsAfter(EMPTY_CURSOR, [
    call('2026-11-02T11:00:00Z', 'TodoWrite', { todos: [{ content: 'Run the tests', status: 'in_progress', activeForm: 'Running' }] }),
  ])
  expect(currentStepOf(cursor)).toBe('Run the tests')
  expect(cursor.events).toHaveLength(1)
})

test('lines with no plan call, no timestamp, another type, or bad JSON add nothing', () => {
  const items = { items: [{ content: 'Hidden', status: 'in_progress' }] }
  const cursor = stepsAfter(EMPTY_CURSOR, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: PLAN, input: items }] } }),
    JSON.stringify({ type: 'api-request-blob', timestamp: '2026-11-02T11:00:00Z', body: PLAN }),
    JSON.stringify({ type: 'user', timestamp: '2026-11-02T11:00:00Z', message: { content: PLAN } }),
    `{"type":"assistant", ${PLAN}`,
    call('2026-11-02T11:00:00Z', 'Bash', items),
  ])
  expect(cursor).toEqual({ ...EMPTY_CURSOR, seen: [] })
})

test('step text is plain: control characters and whitespace collapse', () => {
  const cursor = stepsAfter(EMPTY_CURSOR, [call('2026-11-02T11:00:00Z', PLAN, { items: [{ content: ' Fix\n\tthe  pane ', status: 'in_progress' }] })])
  expect(currentStepOf(cursor)).toBe('Fix the pane')
})

test('the events keep the STEP_KEEP_MAX newest', () => {
  const lines = Array.from({ length: STEP_KEEP_MAX + 5 }, (_, index) =>
    call(new Date(at('2026-11-02T00:00:00Z') + index * 60_000).toISOString(), PLAN, { items: [{ content: `Step ${index}`, status: 'in_progress' }] }),
  )
  const cursor = stepsAfter(EMPTY_CURSOR, lines)
  expect(cursor.events).toHaveLength(STEP_KEEP_MAX)
  expect(cursor.events[0]?.text).toBe(`Step ${STEP_KEEP_MAX + 4}`)
})
