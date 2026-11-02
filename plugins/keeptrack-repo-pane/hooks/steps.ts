// The task steps of a session (owner's review, 2026-11-02; SPEC section 22): the plan the session keeps with update_plan (the Desktop's
// task list) or TodoWrite (the terminal's), read from the new lines of its transcript. Pure rules only: hooks/register.tsx reads the
// bytes and keeps each session's cursor.
import { isObject, plain, TEXT_MAX } from './model'

// The step events a session keeps, newest first; older ones go.
export const STEP_KEEP_MAX = 50
// The tools whose input is a plan: the Desktop app's task list and the terminal's todo list.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const TODO_TOOL = 'TodoWrite'

// One plan step as the tools write it: its text and its status (pending, in_progress, completed).
export type PlanStep = { content: string; status: string }
// One step event: when the step started (or, for a step never seen started, when it was first seen done), and its text.
export type StepEvent = { at: number; text: string }
// What a session's transcript has said of its plan so far: the last plan, the events, newest first, and the texts that have an event.
export type StepCursor = { plan: PlanStep[]; events: StepEvent[]; seen: string[] }

export const EMPTY_CURSOR: StepCursor = { plan: [], events: [], seen: [] }

// The steps of a plan input, or null for an input that is not one.
function stepsOf(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw)) return null
  const steps: PlanStep[] = []
  for (const item of raw) {
    if (!isObject(item) || typeof item.content !== 'string' || typeof item.status !== 'string') continue
    const content = plain(item.content, TEXT_MAX)
    if (content !== '') steps.push({ content, status: item.status })
  }
  return steps
}

// The plan after one update_plan call: a whole new list (items), or the previous list moved on by advance, done and start.
function nextPlanOf(plan: readonly PlanStep[], input: Record<string, unknown>): PlanStep[] {
  const items = stepsOf(input.items)
  if (items !== null) return items
  const next = plan.map(step => ({ ...step }))
  if (input.advance === true) {
    const current = next.findIndex(step => step.status === 'in_progress')
    if (current !== -1) next[current] = { ...next[current]!, status: 'completed' }
    const pending = next.findIndex((step, index) => index > current && step.status === 'pending')
    if (pending !== -1) next[pending] = { ...next[pending]!, status: 'in_progress' }
  }
  if (Array.isArray(input.done)) {
    for (const number of input.done) {
      const step = typeof number === 'number' ? next[number - 1] : undefined
      if (step !== undefined) step.status = 'completed'
    }
  }
  if (typeof input.start === 'number') {
    const step = next[input.start - 1]
    if (step !== undefined) step.status = 'in_progress'
  }
  return next
}

// The plan inputs one transcript line carries, in order, with the line's time: assistant lines only, each tool_use of a plan tool.
// A line that is not JSON, not an assistant line, or has no ISO timestamp carries none.
function planInputsOf(line: string): { at: number; tool: string; input: Record<string, unknown> }[] {
  if (!line.includes(PLAN_TOOL) && !line.includes(TODO_TOOL)) return []
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObject(entry) || entry.type !== 'assistant' || typeof entry.timestamp !== 'string') return []
  const at = Date.parse(entry.timestamp)
  if (!Number.isFinite(at) || !isObject(entry.message) || !Array.isArray(entry.message.content)) return []
  return entry.message.content.flatMap(part =>
    isObject(part) && part.type === 'tool_use' && (part.name === PLAN_TOOL || part.name === TODO_TOOL) && isObject(part.input)
      ? [{ at, tool: part.name as string, input: part.input }]
      : [],
  )
}

// The cursor after some new transcript lines. A step gets one event, the first time it is seen in progress, or done if it was never
// seen in progress; a later plan that names the same text again adds none.
export function stepsAfter(cursor: StepCursor, lines: readonly string[]): StepCursor {
  let plan = cursor.plan
  const events = [...cursor.events]
  const seen = new Set(cursor.seen)
  for (const line of lines) {
    for (const call of planInputsOf(line)) {
      plan = call.tool === TODO_TOOL ? (stepsOf(call.input.todos) ?? plan) : nextPlanOf(plan, call.input)
      for (const step of plan) {
        if (seen.has(step.content) || (step.status !== 'in_progress' && step.status !== 'completed')) continue
        seen.add(step.content)
        events.unshift({ at: call.at, text: step.content })
      }
    }
  }
  const kept = events.sort((a, b) => b.at - a.at).slice(0, STEP_KEEP_MAX)
  return { plan, events: kept, seen: [...seen].slice(-STEP_KEEP_MAX * 2) }
}

// The step in progress, or null when none is.
export const currentStepOf = (cursor: StepCursor): string | null => cursor.plan.find(step => step.status === 'in_progress')?.content ?? null
