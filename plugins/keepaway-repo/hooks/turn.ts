// The main loop's turn as the band reads it: the pure transitions of the turn events (turn.start, tool.call, turn.complete,
// turn.abort). The register writes each transition into its atom; this module holds no state and reads no engine.
export type BandTurn = {
  startedAt: number | null
  endedAt: number | null
  tool: string | null
  // The start of the turn that ended (set by turnEnded, absent before): the band counts the elapsed time from it while an agent
  // that began during that turn still runs (R2-05). A new turn starts without it.
  endedTurnStart?: number | null
}

export const IDLE_TURN: BandTurn = { startedAt: null, endedAt: null, tool: null }

// A turn that has run this long is over: its end event was lost (a restart, a reload), so the band must not count it forever.
export const TURN_MAX_AGE_MS = 2 * 60 * 60 * 1000

// A turn starts at `now`, with no tool called yet.
export const turnStarted = (now: number): BandTurn => ({ startedAt: now, endedAt: null, tool: null })

// A turn ends, completed or aborted, at `now`: that end is the idle "since". An end with no turn running changes nothing.
export const turnEnded = (previous: BandTurn, now: number): BandTurn =>
  previous.startedAt === null ? previous : { startedAt: null, endedAt: now, tool: null, endedTurnStart: previous.startedAt }

// The running turn's tool is the one it last called, by name only. A call outside a turn starts an inferred turn at `now`, since its
// turn.start may have been lost.
export const turnToolNamed = (previous: BandTurn, tool: string, now: number): BandTurn =>
  previous.startedAt === null ? { ...turnStarted(now), tool } : { ...previous, tool }

// Whether a turn has run past TURN_MAX_AGE_MS. Idle is never expired.
export const turnExpired = (turn: BandTurn, now: number): boolean =>
  turn.startedAt !== null && now - turn.startedAt > TURN_MAX_AGE_MS

// A turn past its age cap ends at its expiry, startedAt + TURN_MAX_AGE_MS: its end was lost, and the idle "since" is when the cap ran out,
// not the tick that found it. A turn that is not running changes nothing.
export const turnTimedOut = (previous: BandTurn): BandTurn =>
  previous.startedAt === null ? previous : turnEnded(previous, previous.startedAt + TURN_MAX_AGE_MS)

// Whether the band redraws on a tick of its own clock (every 30 s): while a turn runs, on every tick, so the elapsed time moves; while
// idle, on every second tick, so the time since the last turn moves each minute.
export const bandRedrawDue = (turn: BandTurn, tick: number): boolean => turn.startedAt !== null || tick % 2 === 0
