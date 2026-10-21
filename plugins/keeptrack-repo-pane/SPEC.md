# KeepTrack: spec (as built, v0.2.0-beta.5)

Renamed from github-repo-work-pane on 2026-10-21: the product name is KeepTrack, the command is `/keeptrack`.

The mod draws, in a Claude Code pane, the work of the repository this session belongs to: the open milestones and their
open issues, the Desktop sessions working on each issue, and, for this window, its issue's details and timeline. Its design
record is `Dossier/mocks/keeptrack-pane-mocks/keeptrack-pane-design-spec.md` (decisions D1 to D8); this file describes what the code does now and
where it differs from that record (section 9).

## 1. Purpose

- Show, at a glance, what this window is working on, which issue it belongs to and which milestone that issue is in.
- Show the other Desktop sessions of the same repo, nested under their parent when they are derived (fork or spawn).
- Show the open issues that no session works on, grouped by open milestone.
- Read only. The pane writes two kinds of state: the open flag and the language (`$.store` `lang`), and the issue
  override a `/keeptrack issue` command sets (`$.store` `override:<sessionId>`).

## 2. Files

| File | Role |
|---|---|
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | Manifest; the hooks module is `hooks/register.tsx`. |
| `hooks/register.tsx` | The only module that calls `$`: the poll timer, the atoms, the `/keeptrack` command, the close. |
| `hooks/model.ts` | Pure rules: remote parsing, session-to-issue mapping, session tree, issue groups, timelines, state, record projection. |
| `hooks/pane.tsx` | Draws one `Snapshot`; reads no state. |
| `hooks/band.tsx` | Draws the band row above the prompt: the status line, the repo context and the Open button (section 18); reads no state. |
| `hooks/turn.ts` | The pure transitions of the main loop's turn (turn.start, tool.call, turn.complete, turn.abort), written into the turn atom. |
| `hooks/keepglide.ts` | A local copy of askaway's KeepGlide mark, drawn 24 px at the pane header's right (section 17). |
| `hooks/held.ts` | Keeps the band's press handle across redraws: a local copy of askaway's `held.ts` (mods do not import each other). |
| `hooks/i18n.ts` | English and pt-BR dictionaries and `t()`. |
| `hooks/look.ts`, `hooks/logo.ts` | Theme keys and glyphs (`look.ts`); the one violet of the logo (`logo.ts`, exempt from the look gate). |
| `types/index.d.ts` | The contracts: records, issues, PRs, `SessionNode`, `IssueDetails`, `Snapshot`, the drawn state. |
| `scripts/keeptrack-look-check.sh` | Look gate: no hex colour, colour function or emoji in the drawn code. |
| `tests/*.test.ts`, `tests/fixtures/sample.ts` | Unit tests of the rules, the pane, the band, the i18n and the hooks module. |

## 3. Data flow

1. `session.start` sets the language, registers `/keeptrack`, drops the old timer, starts the window's timer at its cadence and polls
   when no poll started within that cadence (the last attempt, or the snapshot's time when that is later; once, at start, while the pane is closed). It also starts the band's
   tick (section 18). A reload (`/reload-plugins`) gives the module a new instance with no timers of its own: the engine drops the
   old timers, and `session.start` runs again for the changed hooks. If an instance finds its timers missing at a band draw (no
   `session.start` ran in it), the draw schedules `ensureTimers` through the clock, which starts the tick and, when no poller runs,
   the poll at the cadence. Starting is idempotent: a running timer is never started twice.
2. `/keeptrack open` (or `/keeptrack` with no verb) calls `$.ui.open` for the pane. A placed pane starts the timer and polls
   at once when the snapshot is older than one interval.
3. `$.clock.every` runs `startPoll` at the cadence of the open flag: 60 s while the pane is open, 5 min (`KEEPTRACK_BAND_POLL_MS`)
   while it is closed. A poll that is still running starts nothing (`polling` flag). A poll not settled after 30 s (`POLL_DEADLINE_MS` in `hooks/register.tsx`) is abandoned: it is failed and the flag is released, so a newer poll may start beside it. Its late result still writes unless a newer poll has already written (`writtenSeq`); a result that is dropped reaches neither the snapshot, the GitHub memory, the override prune nor the last repo context. At most 2 abandoned polls run at once (`MAX_ABANDONED_POLLS`); a poll tick past that logs `poll skipped` and starts nothing.
4. A poll (`buildSnapshot`, one atom write, then `ui.invalidate`):
   1. Repo: `$.session.repo()` gives the root and the origin remote; when it names none (the engine reads origin only), the repo's
      remote is the first remote `git remote` lists (`remoteUrlOf`: origin when present, else the first by name, so a repo whose
      only remote is `github` is read from it). `parseRemote` gives owner and name.
   2. GitHub (3 gh calls, in parallel): milestones, open issues, open PRs (section 4).
   3. Desktop records: the records folder is listed to depth 2; files over 2 MiB are skipped; a file is read again only when
      its size or mtime changed. Records that fail to parse are counted.
   4. Candidates: this window's record always; any other record whose git common dir has an origin that names this repo (match by host, owner and name, case-insensitive; the newest 63 others by activity, plus every other one among the newest 256 records by activity whose branch has an open PR; section 16). An archived record is a candidate only as an ancestor (section 9). A record with no `gitAnchors` derives its common dir with
      `git rev-parse --git-common-dir` in its cwd. A common dir that git reports as not a repository (exit 128, not-a-repository stderr) is a definite non-member: the record is left out and sets no `git-failed`.
   5. Branch of each member of the newest 4 × 64 others (the scan window; membership is checked there too): `git rev-parse --abbrev-ref HEAD` in its cwd (detached HEAD gives no branch). The open-PR admission of step 4 needs these reads.
   6. Open askaway questions: `ASKAWAY_HOME` (or `~/.claude/state/askaway`), `q/*.json` with no `a/<id>.json` yet; the question's
      `desktop_session` names the session, its `title` is the blocker text. A missing folder is no question.
   7. Overrides: store keys `override:<sessionId>`.
   8. Tree: `buildTree` keeps this window, the live sessions (not archived and active within 72 h, or with an open PR) and
      the ancestors of all of them. A first pass decides which sessions are kept; only those get commit reads.
   9. Commits of each kept session: `git symbolic-ref refs/remotes/origin/HEAD` (no network), then `git log -5` on its
      branch unless the branch is the default branch.
   10. This window's issue (section 6): one `gh issue view` call when the window maps to an issue.
   11. Snapshot: sessions, milestones, issue groups (issues no session shows), counters, `thisIssue`, `unreadableCount`,
      errors, `stale`, `truncated`.
5. `ui.render` draws the snapshot. Rendering reads the atom only; it calls no `$.process` and no `$.fs`. The band row above the prompt
   (section 18) reads the same atom and the open flag.
6. `ui.close` clears the open flag and moves the timer to the band's cadence: a closed pane polls every 5 minutes, never each minute.

## 4. The gh and git calls per poll

gh calls (argv arrays, no shell; cwd is the repo root; timeout 15 s each):

| # | Argv | When | Gives |
|---|---|---|---|
| 1 | `gh api repos/OWNER/NAME/milestones?state=open&per_page=100` | every poll | open milestones, `open_issues`, `closed_issues` |
| 2 | `gh issue list --repo OWNER/NAME --state open --limit 500 --json number,title,milestone,labels,updatedAt,url` | every poll | open issues; 500 sets `truncated` |
| 3 | `gh api graphql -f owner=OWNER -f name=NAME -f query=<PR query>` (`-f` for all three: `-F` would turn a digit name into a number) | every poll | open PRs (`states: OPEN`, first 100, by update time) with `closingIssuesReferences`, `reviewDecision`, last commit checks; more than 100 sets `truncated` |
| 4 | `gh issue view <n> --repo OWNER/NAME --json number,title,url,state,milestone,comments` | only when this window maps to issue `<n>` | the window's issue (section 6) |

The PR query is GraphQL because gh 2.45 has no `closingIssuesReferences` JSON field.

git calls (timeout 5 s each): `rev-parse --abbrev-ref HEAD` per candidate; `rev-parse --git-common-dir` per cwd of a record
without `gitAnchors` and for the root when there is no GitHub remote (cached per cwd); `remote get-url origin` per distinct
common dir (cached per common dir; a not-a-repository answer is cached as no remote), and when origin is absent `remote` then `remote get-url <first>` (the same cache); the root
without an engine origin asks the same way on each poll. `symbolic-ref` and `log -5` per kept session with a branch.

Budget: three gh calls per minute while the pane is open, plus the fourth call while this window maps to an issue. While the pane
is closed: three gh calls every 5 minutes (`KEEPTRACK_BAND_POLL_MS`), plus the fourth call when mapped, so at most 4 gh calls per 5
minutes per window, and one poll at session start. Git is local.

## 5. Session to issue (first match wins, no merging)

1. Override: the store key `override:<sessionId>`, set by `/keeptrack issue <n>` in this window only.
2. PR: the open PR whose `headRefName` is the session's branch and whose `closingIssuesReferences` names issues. Several:
   the lowest number.
3. Branch: `^(?:[\w.-]+/)?(\d{1,6})-` on the branch, else `issue-(\d{1,6})` (case-insensitive, word boundary).
4. Title: the first `#(\d{1,6})` in the session title.
5. Parent: only for a fork or a spawn, the parent's issue (the parent is resolved first).
6. None: the session shows `no issue` and is not in the issue groups.

The source that won is kept as `IssueRef.source`. Numbers are 1 to 999999.

## 6. This window's issue (`Snapshot.thisIssue`)

When this window's node has an issue, one gh call (section 4, call 4) fills `IssueDetails`:

- `number`, `title`, `url`, `state` (`open` or `closed`), `milestoneTitle` from the view.
- `branch`: the window's branch. `pr`: the open PR of that branch, or null.
- `lastCommit`: the window's newest commit (`commits[0]`), or null.
- `checks`: always null in v1; the pane draws `no CI`.
- `lastComment`: the newest comment (`newestCommentOf`), body previewed to 200 characters; or null.
- `blockedBy`: the title of the open askaway question of this window, or null.
- `startedAt`: the record's `createdAt`.

A failed call keeps no details (`thisIssue` null), sets `stale`, and adds the error line for its failure. No call, and no
details, when the window maps to no issue or the repo is not a GitHub one.

## 7. The Desktop record fields read

Only these fields are projected (`projectRecord`); all others are dropped unread or unused:

| Field | Use |
|---|---|
| `sessionId` (`local_<id>`) | Session id; a link target only when it has this shape |
| `cliSessionId` | Matches this window (`$.session.id()`) |
| `title` | Row title (escaped before it goes into a link) |
| `createdAt`, `lastActivityAt` | Started time, recency (72 h cutoff), state (working within 5 min) |
| `isArchived` | Filter (archived sessions drop out, even with an open PR, except this window) |
| `forkedFromSessionId` | Parent, kind fork |
| `spawnedFrom.sessionId`, `spawnedFrom.title` | Parent, kind spawn, and its title for the timeline |
| `gitAnchors[0].commonDir` | Repo match (absolute path only) |
| `cwd` | Git calls only, never stored |

Not read: prompts, suggestions, MCP settings, turn reports, transcripts, account and tool settings. A record over 2 MiB is
skipped before it is parsed. A field longer than 4096 characters makes the record unreadable.

## 8. Failure lines

Each line is drawn above the groups, in the language of the pane. The sessions are drawn in every case.

| Error | Line (en) | When |
|---|---|---|
| `gh-missing` | gh not found: showing sessions only | gh cannot start (ENOENT) |
| `gh-auth` | gh is not signed in | gh exits non-zero with a login message |
| `gh-rate-limit` | GitHub rate limit: showing the last data | gh reports the API rate limit; the previous data is kept, `stale` set |
| `gh-timeout` | GitHub did not answer in time | the 15 s timeout |
| `gh-failed` | GitHub did not answer as expected: showing the last data | a gh call failed with no mapped cause, or exited 0 with output that cannot be read (R2-02); the last data is kept and `stale` is set |
| `no-remote` | no GitHub remote for this repo | the repo has no GitHub origin; mode `no-github`, no issue groups |
| `records-unreadable` | `{count}` session records could not be read | a record failed to parse; drawn only when `unreadableCount` is above 0 (N1). A folder that cannot be listed draws no line |
| `git-failed` | git failed in this folder · sessions shown without branch | git could not answer for a candidate's folder (a timeout, or stderr other than not-a-repository; a folder git reports as not a repository is not a failure) |
| truncated | list is partial (first `{count}`) | 500 issues or 100 PRs reached |

A poll never throws into the engine: a failed job is logged by its error name only (`poll failed (Name)`).

## 9. As built: deviations from the design record

| Design (repo-work-pane-design-spec.md) | As built | Reason |
|---|---|---|
| D1: open or merged PR closes the issue | Only open PRs map: the GraphQL query asks for `OPEN` | Merged PRs are not in the query; adding them is a new query field, deferred |
| D2: open PR keeps an archived session | Archived sessions drop out even with an open PR (this window excepted) | Sophia's rule for archived records; `buildTree` tests pin it |
| D5: "Próximo passo" dropped | Drawn as `—` | Sophia's decision for this pane |
| D5: "Checks" from the PR check rollup | Always `no CI` (`checks` null) | GitHub Actions is off in the repos (`17a`) |
| D5: "Último commit" from `git log -1` | Newest of `git log -5` (the same read the timeline uses) | One git call serves both |
| D5: "Estado" is the session state word | Session state word; `issue closed` is added when the issue is closed | An override may name a closed issue |
| D5: comment text | Plain Text: author, age, preview | Comments never render as Markdown (no fake session link) |
| Mock: "Estado" is hand-written issue prose | Computed from the session state (D7) | Records carry no issue prose |
| DESIGN 3.1: errors above groups | Same | none |
| Window without issue | No details block and no GitHub line; the breadcrumb reads `no issue · no milestone` | Mock and Sophia's brief |
| Archived sessions as ancestors only (D2 above) | Kept only as ancestors of a live session: state idle, no branch, no commits, no timeline read | W6: the rule never applied in production before |
| Remote host ignored | Only GitHub hosts count: `github.com`, or an alias whose host contains `github`; the host must match too. A `--repo` call and the no-remote line follow the same rule | S4: a same-named repo on another host is not this repo |
| Caps: none | Desktop files read 2000; candidate sessions 64 (newest activity first) plus every session with an open PR among the newest 256 records (DL7); membership checks and branch reads over the newest 4 × 64 others; git calls in flight 4 | S1: bounded reads and git calls per poll |
| Poll deadline: none | 30 s (section 16; chosen by Sophia on 2026-10-21; real polls measured 0.6 to 2.0 s over the last 15 days): a poll past it is abandoned and the flag is released; its late result writes unless a newer poll has written | F07, R2-04: a late poll must not overwrite a newer snapshot |
| Unused PR and issue fields `reviewRequests` and `assignees` | Not read, not projected (F26, Sophia's choice A) | Nothing drew them |
| Pane gets this window's id | Not passed: the tree marks this window by its CLI id (`isThisWindow`); the pane compares no id | N3: the id mismatch is gone and render reads no state |
| Derived indent | Each parent level adds 2 cells, only while the child is within two levels (the boxes add up) | W1 |
| Text of records | Titles, subjects, labels, names and comment bodies: control characters become spaces, capped (200 for text, 100 for labels and names) | S2: no escape sequence reaches a terminal |
| Timeline of a fork with no parent title | The text without a name: `forked`, `spawned` | W6 |

## 10. The breadcrumb and the timeline

- Breadcrumb: `#n · <milestone> · <origin>`. The origin is `derived from #m` (a derived session whose parent has an issue) or
  `derived` (a derived session whose parent has none); a root has no origin. With no issue: `no issue · no milestone`.
  On the desktop `#n` links to the issue page when it is a plain https address. The milestone is its title up to the first
  ` · `.
- Timeline: the 6 newest events of the session, always drawn, never folded. Kinds: commit (`●`, subject as plain text),
  PR (`↗`, `PR #n opened: <title>`, from the PR's `createdAt`), session (`▪`, `started`, `forked from <title>`, or
  `spawned from <title>`). Commits are the branch's own last 5, newest first, empty on the default branch.

## 11. This window's block

Inside one highlighted block (the engine's user-message background, `DETAILS_FILL`):

1. Title row: the session title as a link to `#local_<id>` on the desktop (plain text on the terminal), `← this window`.
2. Breadcrumb (section 10).
3. Detail lines `Heading: text` (only when `thisIssue` is drawn): State, Branch, PR, Last commit, Checks, Last comment,
   Blocked by, Next step, Started. Each heading is bold; each line is a separate row. "Blocked by" is `nothing` when no open
   question names the session. "Started" is `hh:mm · <age>`.
4. Timeline (section 10).
5. The GitHub link as the last line: `▪ Open #n on GitHub ↗`, a Markdown https link on the desktop, plain text on the terminal.

Nothing folds. Derived rows nest under their parent, indent capped at two levels, branch glyphs `├` and `└`.

## 12. Language

- Dictionaries: `hooks/i18n.ts`, `EN` and `PT`; `PT` is typed against the `EN` keys, so a missing key fails the compile.
  Tests check key parity, placeholder parity and that no message is empty.
- Choice: `/keeptrack lang en|pt-BR|auto` stores `lang` (auto removes it). Otherwise the first set variable of `LC_ALL`,
  `LC_MESSAGES`, `LANG`, `LANGUAGE` decides: `pt*` is pt, anything else is en.
- Model-facing text: none. Commit subjects, comment bodies, PR and session titles, labels and branch names are data, never
  translated.

## 13. Commands and state

- `/keeptrack open`: open the pane (no verb means open). The band's button (section 18) does the same. `/keeptrack issue <n>`: this window's override. `/keeptrack issue none`:
  clear it. `/keeptrack lang <choice>`. Any other argument: a toast with the usage line and no change.
- A window that is not a Desktop session (no record with its `cliSessionId`) cannot set an issue: a toast says so.
- Store keys: `override:<sessionId>` = `{ issue, ts }`, `lang`. Nothing else is persisted. An override is dropped on a poll when no listed record names its session or its `ts` is over 30 days old (not on a poll with an unreadable folder). Module memory holds the file read
  cache, git lookups and the last good gh data.

## 14. Environment overrides (tests)

- `HOME`: the records root (`$HOME/.config/Claude/claude-code-sessions`) and the askaway folder (`$HOME/.claude/state/askaway`).
- `KEEPTRACK_DESKTOP_SESSIONS`: the records root (tests).
- `ASKAWAY_HOME`: the askaway state folder.
- `KEEPTRACK_POLL_MS`: the poll interval while the pane is open, at least 1000 ms (tests). The default is 60000.
- `KEEPTRACK_BAND_POLL_MS`: the poll interval while the pane is closed, at least 1000 ms (tests). The default is 300000.

## 15. Test protocol

Run from the mod folder:

1. `claude plugin validate .`: manifest, hooks and types. Pass with no error. Known warnings: the `$` and state summaries, and
   the gating-hook notes for `command.run` and `ui.close` (see the report of the build).
2. `claude plugin test .`: the unit, pane, band, turn, i18n and hooks-module tests (fixtures are synthetic; no real record, remote or
   GitHub call). The register tests stub `$` in memory: gh and git never run.
3. `scripts/keeptrack-look-check.sh`: exit 0 means no hex colour, colour function or emoji in `hooks/*.ts(x)` except `logo.ts` and
   `keepglide.ts`, the two marks (the repo work violet and the KeepGlide mark).
4. `agentic-mod-release-tool.sh keeptrack-repo-pane --check` must pass before the mod is installed (CLAUDE.md rule 6a).
   This mod is not installed yet.

Limits of the tests: the pane draws with the real clock, so age texts are checked by pattern; no test calls the real GitHub
or reads a real record.

## 16. Limits

| Limit | Value |
|---|---|
| Open issues per poll | 500 (then `truncated`) |
| Open PRs per poll | 100 (then `truncated`) |
| Record size | 2 MiB (skipped before parse) |
| Record text field | 4096 characters (record unreadable) |
| Session tree depth | 8 (deeper sessions are roots) |
| Timeline events per session | 6 |
| Branch commits read | 5 |
| Session cutoff | 72 h (an open PR keeps a session past it, only among the 256 newest records by activity (the DL7 exception); not for archived) |
| Working state window | 5 min after the last activity (heuristic) |
| Comment preview | 200 characters |
| Desktop files read per poll (records and questions) | 2000 (the rest are not read) |
| Candidate sessions | 64 newest by activity, plus every other session with an open PR, admitted only among the 256 newest records by activity (the DL7 exception, the scan window of `memberRecordsOf`) |
| Membership checks and branch reads | the newest 4 × 64 others (the scan window) |
| Git calls in flight | 4 |
| Override lifetime | 30 days |
| Band poll while the pane is closed | 5 min (`KEEPTRACK_BAND_POLL_MS`) |
| Band redraws for tool calls | 1 per second (a trailing redraw carries the last tool of a burst) |
| gh timeout / git timeout | 15 s / 5 s |
| Poll deadline | 30 s (F07, `POLL_DEADLINE_MS`): a poll past it is abandoned; its late result writes unless a newer poll has written (R2-04) |
| Abandoned polls running at once | 2 (`MAX_ABANDONED_POLLS`); a poll tick past that logs `poll skipped` and starts nothing |

## 17. Desktop check (for Sophia)

Done in the Claude Desktop with the mod installed, not by the build:

1. Light and dark theme: text readable, the highlighted block's fill visible, the logo violet, the KeepGlide mark at the header's right.
2. A 360 px wide pane and a wide one: no horizontal scroll; long titles and commit subjects wrap.
3. The session title opens its session; the `#n` in the breadcrumb and the GitHub line open the issue page in the browser.
4. The first click on the highlighted block works (a block that grows must not swallow the first click on a button below it).
5. `/keeptrack issue 106` in this window: the window's breadcrumb and details change after the next poll.
6. Pane closed: no `gh` process runs (watch the process list for 2 minutes).
7. The band above the prompt: drawn on the desktop and the terminal with the pane closed; its button reads Open and presses to
   the pane; with the pane open it reads Show; hotkey 2 from an empty composer opens the pane.

## 18. The band above the prompt (status line)

- Drawn by `on('ui.render', { component: 'AbovePrompt' })` on the desktop and the terminal, always: with the pane open or closed,
  with or without an issue. One row; it wraps to two rows on a narrow surface. Left: the leading mark, the status line, the repo
  context. Right: the KeepGlide mark (desktop only) and the button.
- Leading mark (`renderRepoWorkMark`, `hooks/logo-element.tsx`): on the desktop the product mark, concept C (the checkpoint) from
  `hooks/logo.ts`: `repoWorkSvg` still, and `repoWorkLoadingSvg` (the same drawing with its ring turning, SMIL, 2 s). The turning
  mark shows while the main loop or an agent runs; the still mark when idle, and when the person asks for reduced motion (read from
  `prefers-reduced-motion` where the page offers it). On the terminal the text glyph: `▶` running, `○` idle. Concept C is provisional
  (A, B and C are not chosen): the markup lives in `logo.ts` alone, so a swap changes that one file. The brand colours stay literal.
- Action icons (`hooks/action-icons.ts`, one table: emoji and SVG per key): on the terminal the emoji as text; on the desktop a 14 px
  SVG on a 24 px grid, 2 px stroke, `currentColor` (an emoji renders as an odd glyph in the Desktop band font). Keys and emoji:
  idle 💤, thinking 💭, waiting ⏳, MCP 🔌, shell 💻 (`Bash`), read 📖 (`Read`), edit ✏️ (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`),
  search 🔎 (`Grep`, `Glob`), web 🌐 (`WebFetch`, `WebSearch`), agent 🤖 (`Agent`, and the agent count), any other tool 🔧,
  milestone 🎯, issue 📌, no issue 📭, no GitHub remote 🚫, error ⚠️. The register passes two flags: `waiting`, when this window's session is waiting for the user (its node in the session tree reads
  `waiting`, from an open askaway question; the status line starts with `waiting for you`, pt-BR `esperando você`); and `error`, when the
  snapshot holds an error other than `no-remote`, which the repo line already names (the repo context line ends with `data error`, pt-BR `erro nos dados`).
- Status line (`bandStatusWords`, `hooks/band.tsx`), from the main loop only (turn events without an `agentId`), as words, each with
  its icon:
  - Running, from turn.start to turn.complete or turn.abort, and for as long as an agent is active after the turn has ended:
    `Running · <tool or thinking> · <n> agents · <elapsed>`. The tool is the name of the running turn's last tool.call (never its
    arguments); `thinking` until its first call. An MCP tool (`mcp__<server>__<tool>`) reads `MCP <server>`, e.g.
    `Running · MCP master-jev-hook`. Once the turn has ended, the tool part is dropped: `Running · <n> agents · <elapsed>`.
    The elapsed time reads `42 s`, `3 min`, `1 h 5 min`, counted from the earliest of: the running turn's start; the start of a turn
    that ended while an agent it overlapped still runs (R2-05: `turnEnded` keeps the start as `endedTurnStart`, and it counts only
    when the turn ended at or after the agents' run began); the start of the agents' run.
  - Idle: `Idle · <since>`, where since is the last turn's end (`just now`, `5 min ago`, `2 h ago`, `3 d ago`); `Idle` before the
    first turn.
  - The state word and the agents are the band's own words; pt-BR: `Executando`, `Parada`, `pensando`, `agentes`.
  - The agents counted are the ones whose `$.agent.list()` status is pending, running or waiting (not idle, not ended). Their count and
    the start of their run (kept while the count stays above zero) are the atom `agentRun: { count, since }`, read again on turn.start,
    turn.complete, agent.spawn and each band tick. A status `waiting` counts: the agent waits on background work it owns.
  - The transitions are the pure functions of `hooks/turn.ts`, written by the hooks into the atoms `turn: { startedAt, endedAt, tool,
    endedTurnStart }` and `agentRun`.
- Repo context (`bandContextWords`, icons 🎯 and 📌): `<milestone> <closed>/<total> · #<n>`. The milestone is this window's milestone
  title (cut to 24 characters with `…` in the band); the total is open plus closed issues of that milestone from the snapshot's open
  milestones. The milestone reads `no milestone · #<n>` when the issue has none, and only its title when it is not open. `no issue`
  when the window maps to no issue; `no GitHub remote` when the window has no remote; nothing before the first poll. `#<n>` alone when
  the issue's details are missing.
- Button: `Open` (`Abrir`) while the pane is closed, `Show` (`Mostrar`) while it is open; hotkey `2` (askaway's band keeps `1`). Its press
  runs the same code as `/keeptrack open`: it opens and focuses the pane, and resumes the timer at the pane's cadence. On the desktop
  the KeepGlide mark (`renderKeepGlide`, 18 px) sits immediately before the button; the terminal draws no picture.
- The press handle survives a redraw (`hooks/held.ts`), so the first click after a focus move still lands.
- Redraws: each turn, tool and agent change invalidates `ui.render`. tool.call redraws are at most one per second; a call inside
  that second is drawn at its end. The repo data comes from the snapshot the timer keeps fresh (section 3): every minute while the
  pane is open, every 5 minutes while it is closed. The band's tick (`BAND_TICK_MS`, 30 s) re-reads the agents and invalidates `ui.render`
  on every tick while an agent runs, and otherwise by `bandRedrawDue`: on every tick while a turn runs, and on every second tick (each
  minute) while idle; a change in the agent count is drawn at once. A subagent's tool.call redraws the band (at most once per second,
  `redrawForTool`); the main loop's tool.call names its tool.
- Reads the atoms, the snapshot and the clock only. A render starts no poll itself and calls no `$.process` or `$.fs`; a render that
  finds the timers missing schedules `ensureTimers` through the clock (section 3), as the pane's draw does.
- Look gate (`scripts/keeptrack-look-check.sh`): `logo.ts` and `keepglide.ts` are exempt from its checks (they hold the brand
  colours); `action-icons.ts` is exempt from the emoji scan only (the terminal emoji), and its icons take `currentColor`.
- Limits: the engine exposes no tool-finished event in this build, so the band keeps the last tool of the turn until the turn ends.
  A subagent that ends stays counted until the next band tick (30 s) or turn or agent event re-reads the list. The elapsed and idle times are measured at
  each redraw, so they refresh on events and on the band's tick, not every second. The test kit cannot raise turn events (`prompt.submit` has no
  implementation there), so the transitions are tested as pure functions in `tests/turn.test.ts`; the band's words, icons and drawn tree
  are tested in `tests/band.test.ts`.
- i18n keys (both dictionaries): `band.open`, `band.show`, `band.running`, `band.idle`, `band.thinking`, `band.agents`,
  `band.agentsOne`, `band.span.seconds`, `band.span.minutes`, `band.span.hours`, `band.noRemote`, `band.error`; with the existing
  `crumb.noIssue`, `crumb.noMilestone` and `age.*`. `band.context` is gone: the milestone and the issue are separate words.
