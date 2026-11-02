# KeepTrack: spec (as built, v0.2.0-beta.23)

Renamed from github-repo-work-pane on 2026-10-21: the product name is KeepTrack, the command is `/keeptrack`.

The mod draws, in a Claude Code pane, the work of the repository this session belongs to: the open milestones and their
open issues, the Desktop sessions working on each issue, and, for this window, its issue's details and timeline. Its design
record is the external private file `repo-work-pane-design-spec.md`, kept outside this repository (decisions D1 to D8); this file describes what the code does now and
where it differs from that record (section 9).

## 1. Purpose

- Show, at a glance, what this window is working on, which issue it belongs to and which milestone that issue is in.
- Show the other Desktop sessions of the same repo as a tree: the group on top (a Desktop sidebar Group, else
  `Recents`, the Desktop sidebar's label), then each top session and its derived sessions (fork or spawn). Ended sessions are never listed.
- Show the open issues that no session works on, grouped by open milestone; the issues of a closed milestone are grouped under
  that milestone's title and marked as closed.
- Read only. The pane writes these kinds of state: the open flag and the language (`$.store` `lang`), the issue
  override a `/keeptrack issue` command sets (`$.store` `override:<sessionId>`), and the summary setting (`$.store` `summary`,
  section 21). The summaries themselves are kept in this window's memory only (section 21).

## 2. Files

| File | Role |
|---|---|
| `.claude-plugin/plugin.json`, `hooks/hooks.json` | Manifest; the hooks module is `hooks/register.tsx`. |
| `hooks/register.tsx` | The only module that calls `$`: the poll timer, the atoms, the `/keeptrack` command, the close; the context ancestors (`ancestorsOf`) and the Desktop config read (`readDesktopGroups`). |
| `hooks/model.ts` | Pure rules: remote parsing, session-to-issue mapping, session tree with its groups (`parseDesktopGroups`, `familyOf`, `groupOf`, `cutAcrossGroups`, `sortTops`, `nearestKeptAncestorOf`), issue groups, timelines, state, record projection. |
| `hooks/steps.ts` | The plan steps' pure rules (section 22): update_plan and TodoWrite inputs from new transcript lines become step events and the current step. `hooks/register.tsx` reads the bytes. |
| `hooks/summary.ts` | The session summary's pure rules (section 21): the first prompt of a transcript head, cleaned and cut to 93 characters, and the transcript folder of a session. `hooks/register.tsx` reads the transcript. |
| `hooks/pane.tsx` | Draws one `Snapshot`; reads no state. The session groups: `groupsOf`, `renderGroup`, `renderGroupLabel`. |
| `hooks/band.tsx` | Draws the band row above the prompt: the status line, the repo context and the Open button (section 18); reads no state. |
| `hooks/logo-element.tsx` | The logo elements: the pane header's mark (`renderKeepTrackLogo`), the band's leading mark (`renderKeepTrackMark`) and the KeepGlide mark (`renderKeepGlide`), drawn from `logo.ts` and `keepglide.ts` (section 18). |
| `hooks/repo-logo.ts` | The repo logo's pure rules (section 11): the logo file names in priority order, the choice of a file, the size cap, the PNG and JPEG checks (magic bytes and trailer), the PNG frame, the stored entry and its age. No I/O. |
| `hooks/action-icons.ts` | Every emoji of KeepTrack: the band's action icons (emoji and SVG per key, section 18), the pane's status icons and the priority icons (section 19). |
| `hooks/turn.ts` | The pure transitions of the main loop's turn (turn.start, tool.call, turn.complete, turn.abort), written into the turn atom. |
| `hooks/keepglide.ts` | A local copy of askaway's KeepGlide mark, drawn 24 px at the pane header's right (section 17). |
| `hooks/held.ts` | Keeps the band's press handle across redraws: a local copy of askaway's `held.ts` (mods do not import each other). |
| `hooks/i18n.ts` | English and pt-BR dictionaries and `t()`; `group.recents` is `Recents` in both languages, the Desktop sidebar's own label (the app bundle has `Recents` 24 times and `Recentes` 0 times, counted on this machine on 2026-10-22, `/usr/lib/claude-desktop/version`: `44.9.0`). |
| `hooks/look.ts`, `hooks/logo.ts` | Theme keys and glyphs (`look.ts`); the one violet of the logo (`logo.ts`, exempt from the look gate). |
| `types/index.d.ts` | The contracts: records, issues, PRs, `SessionNode`, `IssueDetails`, `Snapshot`, the drawn state. |
| `scripts/keeptrack-look-check.sh` | Look gate: no hex colour, colour function or emoji in the drawn code (emoji only in `action-icons.ts`). |
| `scripts/keeptrack-look-selftest.sh` | Self-check of the gate on a copy: the real tree passes; an emoji outside `action-icons.ts` fails; one inside passes; a hex colour there fails. |
| `tests/*.test.ts`, `tests/fixtures/sample.ts` | Unit tests of the rules, the pane, the band, the i18n and the hooks module. |

## 3. Data flow

1. `session.start` sets the language, registers `/keeptrack`, drops the old timer and starts the band's tick (section 18). It resets
   the band's turn to idle, drops the waiting flag, the agent run, the window issue (`thisIssue`, `thisIssueNumber`) and the
   repo context (a failed repo read in the new session draws no old repo, st-6), and marks the snapshot stale. Then it starts the window's timer at its cadence and polls at once: the
   poll is not held back by the cadence or by the time of the last poll, since that poll belongs to the previous session. A poll still in flight at that session.start is not skipped: the new session's poll starts when that one settles (state2-3). A `/keeptrack issue` override set during a poll in flight is polled
   again the same way (st-5), and a poll asked for while abandoned polls fill every slot is queued until one settles (st-8). A reload (`/reload-plugins`) gives the module a new instance with no timers of its own: the engine drops the
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
      only remote is `github` is read from it). `parseRemote` gives owner and name, and the host an ssh alias resolves to (section 16).
   2. GitHub (4 gh calls, in parallel): milestones, open issues, open PRs, milestone totals (section 4).
   3. Desktop records: the records folder is listed to depth 2; only `local_<id>.json` files are records, and other files in the folder (for example `scheduled-tasks.json` and `deleted_<id>` tombstones) are ignored; files over 2 MiB are skipped; a file is read again only when
      its size or mtime changed. Records that fail to parse are counted.
   3b. Desktop Groups (`readDesktopGroups`, `parseDesktopGroups`): `$HOME/.config/Claude/claude_desktop_config.json`, found by one
      `$.fs.list` of its folder per poll. Only `preferences.epitaxyPrefs["dframe-group-scopes"][<scope>].groups[{id, name}]` and
      `.assignments["code:local_<uuid>"] → groupId` are taken. The file is read again only when its mtime changes. A file over
      4 MiB, one that cannot be parsed, a failed read and a failed listing keep the last Groups read; a missing file or an
      unknown shape gives no Groups. Nothing is logged and no toast is shown (Sophia, 2026-10-22, Askaway q-mvjqh5fa-8dc206,
      option A).
   4. Candidates: this window's record always; any other record whose git common dir has an origin that names this repo (match by host, owner and name, case-insensitive; the newest 63 others by activity, plus every other one among the newest 256 non-archived records by activity whose branch has an open PR; section 16). An archived record is never a candidate, except this window's own (section 9). The records up the parent chains of the candidates that are not candidates themselves, in any state (archived, of another repo, past the 64 cap), are context ancestors (`ancestorsOf`): they link and group the tree only, and are never listed, never counted, never asked of git and never read beyond the scan. A record with no `gitAnchors` derives its common dir with
      `git rev-parse --path-format=absolute --git-common-dir` in its cwd. A common dir that git reports as not a repository (exit 128, not-a-repository stderr) is a definite non-member: the record is left out and sets no `git-failed`.
   5. Branch of each member of the newest 4 × 64 others (the scan window; membership is checked there too): `git symbolic-ref --quiet HEAD` in its cwd, `refs/heads/` removed (detached HEAD gives no branch; section 4). The open-PR admission of step 4 needs these reads.
   6. Waiting: this window's flag comes from the engine's `tool.check` verdict (`ask`), see section 11 (the band) and the hook note in section 3. Another session waits for the person while its record's `postTurnSummary` says `blocked` and its last activity is within 24 h (section 7, D7). No Askaway file is read anywhere.
   7. Overrides: store keys `override:<sessionId>`.
   8. Tree (`buildTree`), Askaway's shape: group, then each top session, then its derived sessions.
      - Listing (`keptIds`): this window at any state, the live members (not archived, and active within 72 h or with an open
        PR) and every member ancestor of those that is not archived. An ended session (archived, or deleted) is never listed,
        except this window's own record. A first pass decides which sessions are listed; only those get commit reads.
      - Family (`familyOf`): the root id of the session's fork and spawn links, up to 8 hops, walked through the listed records
        and the context ancestors; it serves only to inherit the root's Desktop Group. At each hop the missing parent is read
        first, then the cap: a fork whose parent is missing, with no spawn title, keeps the top present ancestor as its root
        (8 hops up included); a missing root that a spawn link names by title is the root, by its missing id, while it is at
        most 8 hops up. A cycle, or a root more than 8 hops up, makes the session its own root.
      - Group (`groupOf`): the session's own Desktop Group, else its family root's (a Group with a blank name is skipped, and
        so is a Group whose id is `recents`), else `Recents` (key `recents`, reserved). A `SessionGroup` is
        `{ key, label, kind }`, `kind` `desktop` or `recents`; the Recents `label` is `''` and the pane draws the dictionary's
        `Recents` (`group.recents`).
      - Per-session Group rule (`cutAcrossGroups`): a session filed in another group than its parent is cut from it and is a
        top of its own group, as Askaway does. The sessions with no Group share the `recents` key, so none is cut from
        another: a chain past the 8-hop family cap stays nested while its listed depth is 8 or less, as in a shared Desktop
        Group.
      - Re-attachment (`nearestKeptAncestorOf`): the drawn parent is the nearest listed ancestor; with none the session is a
        top of its group. The issue inheritance follows the drawn parent (section 5); the timeline still names the session's own
        parent, an ended one included (section 10).
      - Sorting (`sortTops`): the group holding this window first, even when it is Recents; then the named Desktop Groups by
        the newest own activity of their tops, then by key (ties no longer keep the input order); Recents last otherwise.
        Inside a group, the top holding this window first, then a top whose session, or a session under it, waits for the person (section 7, D7; Q6, owner-approved 2026-10-30; the rank looks down the whole tree, so the first 20 tops of a group never hide a waiting session), then by activity, newest first, then by session id (Sophia,
        2026-10-22, Askaway q-mvjtulza-91d6af, option A).
      - Cycles: cut at one link (`cutCycleAbove`); the link left stands only when both members share a group (one Desktop
        Group, or Recents), since otherwise the Group rule cuts it.
      - Drawing (`renderGroup`): the label line, plain bold Text (`group-label-<key>`), never Markdown, with no link and no
        `← this window`: the Desktop Group's name, or `Recents`. Under it every top is a titled `├` or `└` row (its title on
        its own row), with its derived rows nested under it, at the 1/3/5 indent in every group, Recents included (W1,
        section 9). An ended root is not drawn: its live derived sessions are tops of their group (Recents when unfiled),
        ordered like any other top, and their timeline names it (`forked from <title>`, `spawned from <title>`).
   9. Commits of each kept session: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` (no network), then `git log -5` on its
      branch unless the branch is the default branch.
   10. This window's issue (section 6): one `gh issue view` call when the window maps to an issue.
   11. Snapshot: sessions, milestones, issue groups (issues no session shows), counters, `thisIssue`, `unreadableCount`,
      errors, `stale`, `truncated`, `truncatedLimits` (section 8).
5. `ui.render` draws the snapshot. Rendering reads the atom only; it calls no `$.process` and no `$.fs`. The band row above the prompt
   (section 18) reads the same atom and the open flag.
6. `ui.close` clears the open flag and moves the timer to the band's cadence: a closed pane polls every 5 minutes, never each minute.

## 4. The gh and git calls per poll

gh calls (argv arrays, no shell; cwd is the repo root; timeout 15 s each):

| # | Argv | When | Gives |
|---|---|---|---|
| 1 | `gh api --paginate repos/OWNER/NAME/milestones?state=open&per_page=100` | every poll | open milestones, every page (title, number, due date); their issue totals come from GraphQL (row 3) |
| 2 | `gh issue list --repo OWNER/NAME --state open --limit 501 --json number,title,milestone,labels,updatedAt,url` | every poll | open issues (the rows): gh is asked for `ISSUE_LIMIT + 1` (501) and the first 500 are kept; only a 501st issue sets `truncated`, so the truncation line shows only when more than 500 open issues exist. Each issue's milestone title comes from its own `milestone` field, so the issues of a closed milestone keep it (pm1-9) |
| 3 | `gh api graphql -f query=<milestone query> -f o=OWNER -f r=NAME` | every poll | the exact issue counts of each open milestone: `issues(states: OPEN)` and `issues(states: CLOSED)` `totalCount`, issues only, no PR (pm1-8); the first 100 open milestones; a failed or unreadable answer keeps the REST counts, not exact (see below) |
| 4 | `gh api graphql -f owner=OWNER -f name=NAME -f query=<PR query>` (`-f` for all of them: `-F` would turn a digit name into a number) | every poll | open PRs (`states: OPEN`, first 100, by update time) with `closingIssuesReferences` (first 50, and their `totalCount`), `reviewDecision`, last commit checks; more than 100 sets `truncated` |
| 5 | `gh issue view <n> --repo OWNER/NAME --json number,title,url,state,milestone,comments` | only when this window maps to issue `<n>`, and not again while the issue's `updatedAt` in the issue list is unchanged (the last view is reused) | the window's issue (section 6) |

The PR query is GraphQL because gh 2.45 has no `closingIssuesReferences` JSON field.

The milestone totals are one GraphQL call per poll (row 3): `repository.milestones(first: 100, states: OPEN)`, each with the `totalCount` of its open and of its closed issues. REST's `open_issues` and `closed_issues` count the PRs too, so they are the fallback only: a milestone the answer does not hold (a failed call, an unreadable node, a milestone past the first 100) keeps them and is marked not exact (`Milestone.countsExact` false). A failed call is logged (`gh api call failed`) and adds no pane error line, since the REST counts still stand. Only exact counts draw the `all closed` line.

Open milestones are read with `gh api --paginate` (100 per page); the gh answer cap and the 15 s timeout bound the read.

git calls (timeout 5 s each): `symbolic-ref --quiet HEAD` per candidate, with the `refs/heads/` prefix removed (`branchOf`): the full ref
is read, so a tag with the branch's name no longer yields `heads/<name>`; an unborn branch yields its name; a detached HEAD (exit 1, no
stderr) yields no branch and is not a failure; `rev-parse --path-format=absolute --git-common-dir` per cwd of a record
without `gitAnchors` and for the root when there is no GitHub remote (cached per cwd); `remote get-url origin` per distinct
common dir (cached per common dir; a not-a-repository answer is cached as no remote), and when origin is absent `remote` then `remote get-url <first>` (the same cache); the root
without an engine origin asks the same way on each poll. `symbolic-ref --quiet --short refs/remotes/origin/HEAD` and `log -5 --format=%ct%x09%s` per
kept session with a branch; the log is parsed from git's output as it comes, not trimmed, so a commit with an empty subject still counts.

Budget: four gh calls per minute while the pane is open, plus the fifth call (`gh issue view`) while this window maps to an issue. While the pane
is closed: four gh calls every 5 minutes (`KEEPTRACK_BAND_POLL_MS`), plus the fifth call when mapped, so at most 5 gh calls per 5
minutes per window, and one poll at session start (and one more when a session.start or a `/keeptrack issue` landed during a poll in flight, or while abandoned polls filled every slot). Git is local.

Logo lookups (section 11) are not poll calls: a repo's logo is looked up once per repo per TTL (24 h for a logo or none, 1 h after a failed lookup), never on each poll, and a lookup on github.com makes at most three `gh api repos/OWNER/NAME/contents/<path>` calls (`GITHUB_LOGO_CALLS`: the root's `logo.png`, `logo.jpg`, `logo.jpeg`), stopping at the first logo; with no logo found, a GitHub repo's lookup asks `gh api users/<owner>` for the type (and, for an organization, for its avatar URL once more), and its avatar fetch is one curl call (section 11), not a gh call. The checkout's logo folders are listed locally, at no gh cost.

Host clock (`date +%z`, `readUtcOffset` in `hooks/register.tsx`): the host's UTC offset is read through the process API, `$.process.run(['date', '+%z'], { timeoutMs: 2000 })`, once at session.start and once per poll, before the poll's other calls. The answer is `±HHMM` and `parseUtcOffset` (`hooks/model.ts`) turns it into minutes east of UTC. The offset is written to the `utcOffset` atom, and the pane reads it with its other inputs. Any failure falls back to the runtime's own offset (`-new Date().getTimezoneOffset()`): no `date` binary (Windows), a timeout, a non-zero exit, or an answer that is not `±HHMM`. A DST change reaches the pane at the next poll. Besides gh and git, the host is asked one more thing: the ssh alias lookup of section 16 (`ssh -G`).

## 5. Session to issue (first match wins, no merging)

1. Override: the store key `override:<sessionId>`, set by `/keeptrack issue <n>` in this window only.
2. PR: the open PR whose `headRefName` is the session's branch and whose `closingIssuesReferences` names issues. Several:
   the lowest number. A PR's closing references are read 50 at a time; when GitHub reports more than 50, the PR names no issue
   and the session maps by its branch, title or parent.
3. Branch: `^(?:[\w.-]+/)?(\d{1,5})-` on the branch, where a leading `YYYY-MM-DD-` date is skipped and is not taken as the number,
   else `issue-(\d{1,6})` (case-insensitive, word boundary); a number outside 1 to 999999 counts as no match. The prefix takes
   1 to 5 digits only: `fix/999999-big` (6 digits) matches neither rule and maps to no issue. The 5-digit cap (review gh3-4)
   keeps a long number at the start of a branch name from being read as an issue. Known leftover: a year-like prefix
   (`2024-cleanup`, `release/2026-q4`) still maps to #2024 or #2026. The date is not
   looked past: `2026-10-22-issue-123` maps to 123 by the `issue-` rule, while `2026-10-22-97-fix` maps to no issue.
4. Title: the first `#(\d{1,6})` in the uncut session title (`titleIssue`, section 7) that is a valid number: several valid
   references still take the first (`Refs #97, #103` → 97); a reference outside 1 to 999999 (such as `#0`) is skipped, so `#0 fixes #106` → 106.
5. Parent: only for a fork or a spawn, the issue of the drawn parent, the nearest listed ancestor (resolved first; section 3
   step 8). A hidden parent (an ended one, or a context ancestor) passes none: a session drawn as a top (no listed ancestor, or cut by
   the Group rule) inherits none.
6. None: the session shows `no issue` and is not in the issue groups.

The source that won is kept as `IssueRef.source`. Numbers are 1 to 999999.

## 6. This window's issue (`Snapshot.thisIssue`)

When this window's node has an issue, one gh call (section 4, call 4) fills `IssueDetails`:

- `number`, `title`, `url`, `state` (`open` or `closed`), `milestoneTitle` from the view.
- `branch`: the window's branch. `pr`: the open PR of that branch, or null.
- `lastCommit`: the window's newest commit (`commits[0]`), or null.
- `checks`: always null in v1; the pane draws `no CI`.
- `lastComment`: the newest comment (`newestCommentOf`), body previewed to 200 characters; or null. Only the newest comment of
  the issue is kept.
- `decision`: the text of the newest comment by the owner, a member or a collaborator (`authorAssociation` OWNER, MEMBER or COLLABORATOR; a comment by any other author is ignored) that starts with `Decisão:` or `Decision:` (case-insensitive, after leading whitespace, plain or in bold as `**Decisão:**`), the text after the prefix as plain text, cut to 200 characters (graphemes) with the ellipsis counted (`newestDecisionOf`); null when there is none, or when the prefix has no text after it. Only the newest decision is kept (Mock S delta 8).
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
| `createdAt`, `lastActivityAt` | Started time, recency (72 h cutoff), state (working within 5 min; waiting for another session within 24 h, see `postTurnSummary`) |
| `postTurnSummary` (Desktop-internal, undocumented) | `status_category` `blocked` makes another session wait for the person (state `waiting`, D7) while its `lastActivityAt` is within 24 h; any other value does not. `needs_action` is the plain-text line under that session's row (`Needs you:` / `Precisa de você:`), cut to 90 characters with the `…` counted, at the last space before the limit (a hard cut when there is none). This window's own row takes no line. Each field is guarded: a missing or malformed summary, or a `status_category` that is not a string, is no data (no waiting, no line); a `needs_action` that is not a string, is blank or is over 4096 characters gives no line and keeps the status. `status_detail` and `summarizes_uuid` are not read |
| `isArchived` | Ended: an archived session is never listed, at any age or with an open PR, except this window's own record. As an ancestor it is context only: it links the tree and lends its Desktop Group (Sophia, 2026-10-22) |
| `forkedFromSessionId` | Parent, kind fork |
| `spawnedFrom.sessionId`, `spawnedFrom.title` | Parent, kind spawn, and its title for the timeline |
| `gitAnchors[0].commonDir` | Repo match (absolute path only) |
| `cwd` | Git calls only, never stored |
| `claude_desktop_config.json` (not a record; section 3 step 3b) | Only the Groups (`groups[{id, name}]`) and the assignments (`code:local_<uuid>` → group id) of `preferences.epitaxyPrefs["dframe-group-scopes"]`. The rest, MCP settings included, is held only during the parse and never logged |

The projection also keeps `titleIssue`, the first valid #n reference of the uncut title (at most 4096 characters), read before the
title is cut to 200 characters; the title step of D1 uses it.

Not read: prompts, suggestions, MCP settings, turn reports, transcripts (except the head of a session's transcript, read for its first prompt: section 21), account and tool settings. A record over 2 MiB is
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
| `records-unreadable` | `{count}` session records could not be read (a count of 1: `1 session record could not be read`) | a record failed to parse; drawn only when `unreadableCount` is above 0 (N1). A folder that cannot be listed draws no line |
| `git-failed` | git failed in this folder · sessions shown without branch | git could not answer for a candidate's folder (a timeout, or stderr other than not-a-repository; a folder git reports as not a repository is not a failure) |
| truncated | `issues list is partial (first 500)`, `PRs list is partial (first 100)` (pt-BR `lista de issues parcial (primeiras 500)`, `lista de PRs parcial (primeiras 100)`) | more than 500 open issues (gh is asked for 501; section 4) or more than 100 PRs; one line per cut list (`Snapshot.truncatedLimits`, the issues first) |

Each cut list draws its own partial-list line: first 500 for issues, first 100 for PRs; both when both are cut. The limit names the list (`ISSUE_LIMIT` and `PR_LIMIT` in `hooks/register.tsx`, mirrored by `ISSUE_LIST_LIMIT` and `PR_LIST_LIMIT` in `hooks/pane.tsx`); a limit the pane does not know keeps the generic `list is partial (first N)` line (ux-4).

Before any snapshot exists the pane draws `Loading the repo...` (pt-BR `Carregando o repo...`), with no icon (section 19) only while the first poll has not settled. A first poll that settles with no repo context (no snapshot to show, `loadFailed`) draws `Could not read the repo: state unknown` (pt-BR `Não foi possível ler o repo: estado desconhecido`) instead, so the pane never stays on Loading (ux4-2).

A gh answer over 4 MiB (UTF-8 bytes), or cut by the engine, is not parsed: gh-failed.

An unreadable issue item is dropped and counted in one log line (count only); a non-empty list with no readable item is an
unreadable answer (gh-failed line); a dropped item still counts toward the 501st that marks the list partial.

Singular forms: a count of 1 takes the key's `.one` form (`t()` in `hooks/i18n.ts`), in English and pt-BR. Two lines use it: the
records line above (`error.records.one`) and the pane's counter line, `N open issues · N sessions` (`counter.issues.one`,
`counter.sessions.one`: `1 open issue`, `1 session`; pt-BR `1 issue aberta`, `1 sessão`). The counter counts the listed sessions only
(an ended root is not drawn and not counted). With no session listed it reads `N open issues · 0 sessions · nothing in progress`
(pt-BR `nada em andamento`): the counts stay in every case. The open-issue count comes from gh issue list (section 4, row 2); it reads `500+` when that list is cut (ux-4). In no-github mode the counter names the sessions only, `N sessions` (ux-3), with `nothing in progress` when none is listed. With every open issue on a session and no group built, the issues section reads `All open issues are in sessions` (pt-BR `Todas as issues abertas estão em sessões`), not `No open issues` (ux-2).

A poll never throws into the engine: a failed job is logged by its error name only (`poll failed (Name)`).

## 9. As built: deviations from the design record

| Design (external private record `repo-work-pane-design-spec.md`, kept outside this repository) | As built | Reason |
|---|---|---|
| D1: open or merged PR closes the issue | Only open PRs map: the GraphQL query asks for `OPEN` | Merged PRs are not in the query; adding them is a new query field, deferred |
| D2: open PR keeps an archived session | An ended session (archived, or deleted) drops out even with an open PR (this window excepted) | Sophia's rule, restated on 2026-10-22: KeepTrack does not list sessions that already ended (row "Ended sessions never listed" below); `buildTree` tests pin it |
| D4: milestones, one page of 100 | Every page (`gh api --paginate`, 100 per page), bounded by the 4 MiB answer cap and the 15 s timeout | RB1-4: one page drops every open milestone past the 100th |
| D4: `closingIssuesReferences(first: 10)` | First 50 with `totalCount`; more than 50: the PR names no issue | DL9: the lowest of a partial page may not be the lowest |
| D5: "Próximo passo" dropped | Drawn as `no next step` (pt-BR `nenhum registrado`) when no value exists; no snapshot field feeds it yet | Sophia's decision for this pane; a bare dash read as an empty value (ux4-21) |
| D5: "Checks" from the PR check rollup | Always `no CI` (`checks` null) | GitHub Actions is off in the repos (`17a`) |
| D5: "Último commit" from `git log -1` | Newest of `git log -5` (the same read the timeline uses) | One git call serves both |
| D5: "Estado" is the session state word | Session state word; `issue closed` is added when the issue is closed | An override may name a closed issue |
| D5: comment text | Plain Text: author, age, preview | Comments never render as Markdown (no fake session link) |
| Mock: "Estado" is hand-written issue prose | Computed from the session state (D7) | Records carry no issue prose |
| D7: waiting is this window's flag only | Another session also waits while its `postTurnSummary` says `blocked` and its last activity is within 24 h, with its needs line; the top of its group, after this window's top (Q5, Q6); a top whose session under it waits ranks the same (section 3) | Owner-approved 2026-10-30 (Q5 with the 24 h cutoff, Q6 ordering); the needs line is the Q14 limit of 90 characters |
| DESIGN 3.1: errors above groups | Same | none |
| Window without issue | No details block and no GitHub line; the breadcrumb reads `no issue` | Mock and Sophia's brief |
| Ended sessions never listed (D2, W6; 2026-10-22) | Ended = archived (`isArchived`) or deleted (the record is gone; its `deleted_<id>` tombstone is skipped). An ended record other than this window's is not matched, admitted, asked of git, listed or counted. As an ancestor it is context only: it links the tree, lends its Desktop Group and is named in the timeline of its derived sessions. This window's own archived record is still listed, with the state of its activity | Sophia's decision of 2026-10-22: "KeepTrack must not list sessions that already ended". It replaces the W6 rule (archived ancestors drawn idle). Her earlier request of the same day, finished rows with a ✓ glyph, was withdrawn by her |
| W6: an ended parent in the tree | An ended parent has no row and no label; its live fork or spawn is a top of its group (Recents when unfiled), whose timeline names it | The row above, drawn in Askaway's tree (row below) |
| Tree shape is Askaway's (group → session → derived) | One bold label per group (a Desktop sidebar Group, else `Recents`); each top a titled row, its derived rows nested; this window's group first, `Recents` last (section 3 step 8) | Sophia's decision of 2026-10-22 (Askaway q-mvjtulza-91d6af, option A): the sessions with no Group take the Desktop sidebar's own name, `Recents`. It withdraws the beta.7 family groups and their rule of derived sessions oldest first under the root's title as label |
| Released marker not read | The `*.desktop-released.json` markers are not read: ended means archived or deleted only | Checked on this machine on 2026-10-22: 287 markers, all `reason: "delete"`, none naming a live record's `cliSessionId`; 45 of 57 records archived, none with a marker, so archiving writes no marker; the 710 `deleted_<id>` tombstones are already skipped |
| Missing root differs from Askaway | A fork whose parent record is missing and that has no spawn title keeps the top present ancestor as its root, whose Desktop Group it inherits | `familyOf` reads only the records the scan holds (2026-10-22) |
| Remote host ignored | Only GitHub hosts count: `github.com`, or an alias whose host contains `github`; the host must match too. A `--repo` call and the no-remote line follow the same rule | S4: a same-named repo on another host is not this repo |
| Caps: none | Desktop files read 2000; candidate sessions 64 (newest activity first) plus every session with an open PR among the newest 256 records (DL7); membership checks and branch reads over the newest 4 × 64 others; git calls in flight 4 | S1: bounded reads and git calls per poll |
| Poll deadline: none | 30 s (section 16; chosen by Sophia on 2026-10-21; real polls measured 0.6 to 2.0 s over the last 15 days): a poll past it is abandoned and the flag is released; its late result writes unless a newer poll has written | F07, R2-04: a late poll must not overwrite a newer snapshot |
| Unused PR and issue fields `reviewRequests` and `assignees` | Not read, not projected (F26, Sophia's choice A) | Nothing drew them |
| Pane gets this window's id | Not passed: the tree marks this window by its CLI id (`isThisWindow`); the pane compares no id | N3: the id mismatch is gone and render reads no state |
| Derived indent | 1/3/5 in every group, Recents included (drawn level): a top sits 1 cell under the label, its children at 3, the next level at 5, and deeper levels stay at 5 (beta.7 drew a family root's children at 1, in the column of its untitled rows; 1/3/3 by tree depth under a listed root and 2/4/4 before that; the boxes add up) | W1, in Askaway's tree |
| Text of records | Titles, subjects, labels, names and comment bodies: control characters become spaces, capped (200 for text, 100 for labels and names) | S2: no escape sequence reaches a terminal |
| Timeline of a fork with no parent title | The text without a name: `forked`, `spawned` | W6 |
| `/keeptrack issue <n>` writes the override | `setIssue` checks the session id (`isSessionLinkId`) before it writes | SE4: defensive; the command cannot reach an invalid id (`projectRecord` drops a record whose `sessionId` lacks the `local_<id>` shape), so no test |
| A failed poll marks the snapshot stale | Only when it is the newest poll at write time (`isNewest` checked again inside the atom update, `failedPoll`), and only when the poll began under the current session (`failedPoll` epoch check, state2-6) | ST3: the test (`ST3 guard`, `tests/register.test.ts`) is a guard only: the test kit cannot hold the snapshot atom between the read and the write |
| Agents after turn.abort | turn.abort does not re-read the agents; the band tick re-reads them (section 18); the hook comment says so | SM2 |
| Element keys: none named | Each repeated element takes a key of its own, the same on the Markdown and the Text branch: `group-label-<group key>` (a plain Text label since beta.8), `crumb-<session id>`, `line-<issue number>` (titles were already `title-<session id>`); this window's GitHub `link` is drawn once and keeps its key | F (2026-10-22): the engine refuses the whole Pane draw when two Markdown elements share a key, so two families, two listed issues or two linked breadcrumbs drew nothing on the desktop; pinned by the `F:` test in `tests/register.test.ts` |

## 10. The breadcrumb and the timeline

- Breadcrumb: `#n · <milestone>`. A derived session carries no origin word or parent number: the tree's indentation already shows the
  derivation (ux-derived). With no issue: `no issue`. The milestone part is the title of the issue's milestone, open or closed; it is omitted when no title is known, never drawn as `no milestone` (ux-1).
  On the desktop `#n` links to the issue page when it is a https://github.com page; the milestone part links to the GitHub milestone page (`milestonePageOf`). The milestone is its title up to the first
  ` · `.
- Timeline: the session's events, newest first, up to 30 (`TIMELINE_LIMIT`). The 5 newest are always drawn; the rest sit behind the session's `Earlier (N)` button (section 22). A `Now: <task>` line comes first when the session has a current task (section 22). The timeline has no heading, in this window's block or in any other session's: its events are drawn as they are, each with its icon. Kinds, each with its icon: commit (`📝`, subject as plain text),
  plan step (no icon, the step's text, section 22), PR (`🔀`, `PR #n opened: <title>`, from the PR's `createdAt`), session (`🚀`, `started`, `forked from <title>`, or
  `spawned from <title>`, the title of the session's own parent, an ended one included). Commits are the branch's own last 5, newest first, empty on the default branch. On the desktop a commit event links to its commit page (GitHub `/commit/<sha>`, GitLab `/-/commit/<sha>`, the id read with `%H` from `git log`, which must be a full hash per `COMMIT_SHA`, 40 hex digits or 64 in a SHA-256 repo; an abbreviated id gets no link) and a PR event to its PR page; each link passes `PAGE_URL` (model.ts).

## 11. This window's block

Inside one highlighted block (the engine's user-message background, `DETAILS_FILL`):

1. Title row: on the desktop the session title links to its session (`#local_<id>`), bold on this window's row, with no arrow (the link colour already says it is clickable) and no separate `open session` link; plain text on the terminal. The state icon follows the title, outside the link. There is no active marker and no `← this window` words: the highlighted block already says which window it is (owner's review, 2026-11-02). On the desktop, a root session row whose repo has a logo draws it 32 px square before the title (`renderTitleLine`, `renderRepoLogo`); a derived session's row draws none, and the terminal draws none. The logo is the first raster logo file of the session's checkout (`logo.png`, `logo.jpg` or `logo.jpeg` at the root, then in `assets/`, `.github/`, `docs/` or `images/`, basename matched case-insensitively; a symbolic link is never read), else the first of the root's three names in GitHub's contents (`GITHUB_LOGO_CALLS`: a logo of a folder is found in the checkout only). Raster only: an SVG is drawn from no source (not the checkout, not GitHub's contents, not an avatar). A file over 64 KB, or a PNG or JPEG that does not open and close as one (the magic bytes at the start; the IEND chunk, or the `FF D9` end marker, at the end, so a truncated download is no logo), is not drawn. Each repo's logo is cached in the store under `logo:<host>/<owner>/<name>` (the remote's host, owner and name, in lower case; an enterprise host is its own key, never the github.com page's); the poll starts the lookup and never waits for it, and the pane redraws when it lands. A stored logo of a repo this window no longer shows is dropped once it has expired, since the store is shared by every window; past 20 repo logos the oldest of the others go first (`LOGO_STORE_MAX`). This window keeps the logos it reads or writes in memory, so a poll reads the store only on a miss. A store that refuses a read, a write or a delete is logged once per operation (`logo store <operation> failed (<error name>)`), and the pane goes on. A cross-window lock (`logo-lock:<key>`, a marker with its time `at`) makes a second window skip a lookup of the same repo while the marker is younger than 2 minutes, and this window deletes its own marker after its lookup. The owner's avatar comes next, for a GitHub repo on the host `github.com` (exactly that host, once an ssh alias is resolved to its real host (section 16); gh is never asked for an enterprise host) whose contents hold no logo: `gh api users/<owner> --jq .type`; only an `Organization` gets its `avatar_url` (`gh api users/<owner> --jq .avatar_url`), asked at `s=32`. A user owner draws none. The avatar is fetched through `sh -c` with curl and base64 (`AVATAR_FETCH_SCRIPT` in `hooks/repo-logo.ts`: https only (`--proto =https`), no redirects followed (no `-L`), the URL is the one positional argument, the 64 KB cap), and it is drawn only when its bytes are a complete PNG or JPEG (magic bytes and trailer); the avatar host is `avatars.githubusercontent.com` only. A failed fetch (curl missing, a non-200, a timeout, an empty answer) is a lookup failure, logged as `avatar fetch` and kept for an hour; an answer that is not a picture is no logo. The GitLab project avatar (`glab api projects/<owner%2Fname> --hostname <remote host>`, the `avatar_url` of its JSON, on the remote's host) is asked for a GitLab remote (a host with `gitlab` in it) once the checkout has no logo. glab is detected once on a definite answer (its exit code, or a missing binary); a timeout fails that lookup (`glab`: kept an hour like a failed gh lookup, then asked again). Without glab the avatar is silently skipped, with no failure. A repo with no folder (no `cwd`) gets no logo.
2. Breadcrumb (section 10).
3. Detail lines `Heading: text` (only when `thisIssue` is drawn): State, Branch, PR, Last commit, Checks, Last comment,
   Next step, Started, then Decided when the issue has a decision by the owner, a member or a collaborator (Mock S delta 8: pt-BR `Decidido:`). Each heading is bold; each line is a separate row. On the desktop the PR line links to the PR's page, and the Last commit line to its commit page (`commitPageOf`, as the timeline's commit events do). "Next step" reads `no next step` (pt-BR `nenhum registrado`) while no value exists, which is
   always so far, since no snapshot field feeds it. "Started" is `hh:mm · <age>`, or `YYYY-MM-DD hh:mm · <age>` once the start is over a day old (ux-9).
   Every clock time (Started and the timeline times, section 10) is the host's wall clock: `clockOf` and `dateOf` in `hooks/pane.tsx` shift the instant by the host's UTC offset (the `date +%z` read of section 4) and read the UTC getters, so the runtime's own zone never decides the digits. Ages (`N min ago`) are offset-free and unchanged.
4. Timeline (section 10).
5. The GitHub link as the last line: on the desktop `▪ Open #n on GitHub ↗`, a Markdown link to a https://github.com page (the arrow marks that it opens); on the terminal `▪ Open #n on GitHub`, plain text without the arrow (ux-7).

Nothing folds. Each group draws its label line, then each top as a titled row (`├`, and `└` on the last) with its derived
rows nested under it; deeper derived rows nest under their parent, indent capped at two levels (W1, section 9).

Each session row's title line reads the branch glyph, then the title, then the state icon (`🟢` working, `⏳` waiting for you, `💤` idle), on every row, and no other marker. A row carries no state word, in either language: the footer's legend names each icon (section 19). A session other than this window that stopped for the person (section 7) draws `⏳` and, under its title and breadcrumb, its needs line (`Needs you: <text>`, pt-BR `Precisa de você: <text>`); this window's row never draws one. The state word stays in this window's details (`State:`, item 3 above). The sessions section draws
nothing when no session is listed: no heading, no label, no empty row.

Below the sessions, the open issues that no session works on are drawn by milestone, under the heading `📋 Issues without session` (pt-BR `Issues sem sessão`). Each milestone group is bold, with its title
up to the first ` · `, then cut at 40 characters, the ellipsis counted, at the last space before the limit (`headingTitleOf`, Mock S delta 11; `Preflight antes da instalação em disco cheio … · v2` draws `Preflight antes da instalação em disco…`), then its objective when the milestone has a description (`Objective: <text>`, pt-BR `Objetivo: <text>`: the description as plain text, cut to 100 characters with the ellipsis counted, at the last space before the limit; Mock S delta 9), then a progress line `<closed> of <total> issues closed` (pt-BR `<closed> de <total> issues fechadas`, the
singular `issue closed` or `issue fechada` when the total is 1). When GitHub gives the milestone a due date, the line ends with
` · due YYYY-MM-DD` (pt-BR `prazo YYYY-MM-DD`). The date is a calendar date: it is the UTC date of GitHub's `dueOn` (`2025-10-31T00:00:00Z` draws `2025-10-31` in every zone), never shifted into the host's zone. The totals come from GraphQL (section 4, row 3); only a failed call leaves REST's counts, and those are not exact. An open milestone
whose open issues all sit on sessions draws one line instead of its issues, `<title> · N open, all in sessions` (pt-BR
`<title> · N abertas, todas em sessões`), then the progress line. That claim is drawn only when the issue list is complete and holds every open issue the milestone counts; otherwise the milestone draws its title and progress line only (rev-g1-5). An open milestone with no open issue left reads
`<title> · all closed · ready to close` (pt-BR `todas fechadas · pronto para fechar`), drawn only from exact counts (`Milestone.countsExact`); an exact milestone with no issue at all (no open and no closed issue) reads `<title> · no issues` (pt-BR `<title> · sem issues`), with no done icon and no ready-to-close claim; a milestone with inexact counts draws its title and progress line, with the noun `items` (`{closed} of {total} items closed`, pt-BR `{closed} de {total} itens fechados`), since REST's counts include PRs (ux-5). Issues with no milestone sit under
`No milestone / issue` (pt-BR `Sem milestone / issue`). The issues of a closed milestone are not in that group: they are grouped
under the closed milestone's title, marked `<title> · closed` (pt-BR `<title> · fechado`) with no progress line, the title read from
each issue's own milestone field (pm1-9). The heading reads the title first, then ↗ where the heading links (desktop, the page passes `PAGE_URL`; Mock S delta 10), then the icons: 🎯, then ⚠️ when overdue; the all-closed and closed headings put ✅ there (Mock S delta 11). On the desktop every milestone heading links to its GitHub milestone page (`milestonePageOf`):
the open, the all-closed and the closed one; a closed group's number is its issue's own milestone number (`IssueGroup.closedNumber`).

Open milestone groups sort by due date, earliest first (an overdue one leads), then by number, newest first. A milestone with no due date, or one whose date does not parse, comes after the dated ones, by number, newest first. Inside every group the issues sort by priority, P0 first and unlabelled last, then newest first (a stable sort, so the newest-first order holds within a priority). A priority comes from the issue's labels, case-insensitive: `P0` to `P3`, or `priority: critical|high|medium|low` with the `priority/…`, `priority-…` and `prio…` variants, read as P0 to P3 (critical is P0, low is P3); when several labels name one, the highest wins (`priorityOf`, `hooks/model.ts`). The row draws the priority icon and the tag before its number (`🟠 P1 #12 title`, icons in section 19); P0 and P1 rows draw bold (`EMPHASISED_PRIORITIES`, `hooks/look.ts`). The session line does not carry the tag: its breadcrumb reads IssueFacts, which would have to widen for it.

The pane's footer reads `Updated <age> · gh · <owner/name>` (pt-BR `Atualizado <age> · gh · <owner/name>`), the last line, below the legend (section 19). The age uses the same
scale as the rows: `just now` (pt-BR `agora`) under one minute, then `N min ago` (`há N min`), `N h ago` (`há N h`) or `N d ago`
(`há N d`).

## 12. Language

- Dictionaries: `hooks/i18n.ts`, `EN` and `PT`; `PT` is typed against the `EN` keys, so a missing key fails the compile.
  Tests check key parity, placeholder parity and that no message is empty.
- Choice: `/keeptrack lang en|pt-BR|auto` stores `lang` (auto removes it). Otherwise the first set variable of `LC_ALL`,
  `LC_MESSAGES`, `LANG`, `LANGUAGE` decides: `pt*` is pt, anything else is en.
- Model-facing text: none. Commit subjects, comment bodies, PR and session titles, labels and branch names are data, never
  translated.

## 13. Commands and state

- `/keeptrack open`: open the pane (no verb means open). The band's button (section 18) does the same. `/keeptrack issue <n>`: this window's override. `/keeptrack issue none`:
  clear it. `/keeptrack lang <choice>`. `/keeptrack summary on|off` (section 21). Any other argument: a toast with the usage line and no change. `/keeptrack open` and
  `/keeptrack issue <n>` followed by extra words also show the usage toast and change nothing.
- A window that is not a Desktop session (no record with its `cliSessionId`) cannot set an issue: a toast says so.
- Store keys: `override:<sessionId>` = `{ issue, ts }`, `lang`, `summary` (boolean, absent is on; section 21), `legendOpen` (`true` while the legend is open, absent when closed; section 19). Nothing else is persisted. The `summary:<sessionId>` keys an earlier build wrote are deleted once per window. An override is dropped on a poll when no record in the records folder names its session (any repo's: the store is shared by every window) or its `ts` is over 30 days old (not on a poll with an unreadable folder). The 30-day lifetime (`OVERRIDE_TTL_MS`) also applies on read: an expired override is ignored
  even when the record scan was partial and the prune did not run. Module memory holds the file read
  cache, git lookups and the last good gh data.
- The state lives in the mod's `$.store`, keyed by the plugin name (`keeptrack-repo-pane`), so the store of the old name
  `github-repo-work-pane` is not read. Checked on 2026-10-22: no store file existed under either name, so the rename lost nothing.
- The pane id stays `repo-work` (`PANE` in `hooks/register.tsx`) on purpose: the Desktop may remember a pane by its id, and renaming
  it could lose that (decided 2026-10-22). Functions use KeepTrack names, and some comments still cite the design record's file name; the pane id `repo-work` stays as it is on purpose, and the design
  record is the external private file `repo-work-pane-design-spec.md`, kept outside this repository.

## 14. Environment overrides (tests)

- `HOME`: the records root (`$HOME/.config/Claude/claude-code-sessions`).
- `KEEPTRACK_DESKTOP_SESSIONS`: the records root (tests).
- `KEEPTRACK_POLL_MS`: the poll interval while the pane is open, at least 1000 ms (tests); an invalid value falls back to the default 60000 (sp-5, tested).
- `KEEPTRACK_BAND_POLL_MS`: the poll interval while the pane is closed, at least 1000 ms (tests). The default is 300000.

## 15. Test protocol

Run from the mod folder:

1. `claude plugin validate .`: manifest, hooks and types. Pass with no error. Known warnings (the complete list; validation still passes): the `$` summary (types declare nothing on `$`), the state
   summary, and the gating-hook notes without `.catch` for `command.run`, `turn.abort`, `tool.call`, `agent.spawn` and `ui.close`.
2. `claude plugin test .`: the unit, pane, band, turn, i18n and hooks-module tests (fixtures are synthetic; no real record, remote or
   GitHub call). The register tests stub `$` in memory: gh and git never run.
3. `scripts/keeptrack-look-check.sh`: exit 0 means no hex colour, colour function or emoji in `hooks/*.ts(x)` except `logo.ts` and
   `keepglide.ts`, the two marks (the KeepTrack product mark and the KeepGlide mark), and `action-icons.ts`, which is exempt from the emoji scan only (it holds every emoji of KeepTrack). `scripts/keeptrack-look-selftest.sh` runs the gate on a copy and checks those cases.
4. `agentic-mod-release-tool.sh keeptrack-repo-pane --check` must pass before the mod is installed (CLAUDE.md rule 6a).
   The mod is published as 0.2.0-beta.23 and installed from `sophia-mods` (README, Installation).

Limits of the tests: the pane draws with the real clock, so age texts are checked by pattern; no test calls the real GitHub
or reads a real record. The clock tests pass a fixed offset (`clockOf`, `dateOf`, `parseUtcOffset`) and do not depend on the zone the test process runs in; the register test answers `date +%z` through the process stub, including a refused call.

## 16. Limits

| Limit | Value |
|---|---|
| Open issues per poll | 500 (gh is asked for 501; a 501st sets `truncated`) |
| Open PRs per poll | 100 (then `truncated`) |
| Closing references per PR | 50 (more: the PR names no issue) |
| gh answer | 4 MiB, UTF-8 bytes (over it, or cut by the engine: not parsed, `gh-failed`) |
| Title read for an issue reference | 4096 characters, uncut (`titleIssue`); the drawn title is cut to 200 |
| Record size | 2 MiB (skipped before parse) |
| Record text field | 4096 characters (record unreadable) |
| Session tree depth | 8 (a deeper session becomes a top of its group) |
| Timeline events per session | 30, the 5 newest drawn, the rest behind `Earlier (N)` |
| Plan step events kept per session | 50 (`STEP_KEEP_MAX`) |
| Transcripts read for plan steps per poll | 5; cursors of the 64 sessions read most recently kept |
| Branch commits read | 5 |
| Session cutoff | 72 h (an open PR keeps a session past it, only among the 256 newest records by activity (the DL7 exception); not for archived, which are never shown, except this window's own) |
| Working state window | 5 min after the last activity (heuristic) |
| Waiting window (another session that stopped for the person, D7) | 24 h after the last activity; older, the normal rule applies (owner-approved 2026-10-30) |
| Needs line | 90 characters, the `…` counted; cut at the last space before the limit, a hard cut when there is none |
| Summary line | 93 characters, the `…` counted; cut at the last space before the limit, a hard cut when there is none (section 21) |
| Transcript head read per session | 256 KiB (`head -c`); 5 transcripts read per poll; 200 summaries kept in the store and in memory |
| Milestone objective | 100 characters, the ellipsis counted (`OBJECTIVE_MAX`) |
| Milestone heading title | cut at the first ` · `, then 40 characters, the ellipsis counted (`MILESTONE_TITLE_MAX`, Mock S delta 11) |
| Top-level sessions per group | the first 20 are drawn, then one `+k more` line (pt-BR `+k mais`) for the rest; the header still counts every listed session (`SESSION_LIST_MAX`, Mock S Q7) |
| Decided line | 200 characters, the ellipsis counted (`DECISION_MAX`) |
| Summary retry (not final) | 10 minutes (`SUMMARY_RETRY_MS`) |
| Comment preview | 200 characters |
| Desktop files read per poll (records and questions) | 2000 (the rest are not read) |
| Candidate sessions | 64 newest by activity, plus every other session with an open PR, admitted only among the 256 newest records by activity (the DL7 exception, the scan window of `memberRecordsOf`) |
| Membership checks and branch reads | the newest 4 × 64 others (the scan window) |
| Git calls in flight | 4 |
| Override lifetime | 30 days |
| Repo logo file | 64 KB raw (`LOGO_MAX_BYTES`); a larger file is skipped, and the next path is tried |
| Repo logo GitHub calls | 3 per lookup (`GITHUB_LOGO_CALLS`); a path the repo lacks (HTTP 4xx) is the next one; any other failure ends the lookup, logged by its kind |
| Repo logo lifetime | 24 h for a logo or none (`LOGO_TTL_MS`); 1 h after a failed lookup (`LOGO_RETRY_MS`) |
| ssh alias lookup | one `ssh -G <alias>` per alias per window, 5 s (`SSH_TIMEOUT_MS`); a failure keeps the alias (section 16) |
| Repo logo markup | 131072 characters (the Svg element's limit); the raster rules are in section 11 |
| Band poll while the pane is closed | 5 min (`KEEPTRACK_BAND_POLL_MS`) |
| Band redraws for tool calls | 1 per second (a trailing redraw carries the last tool of a burst) |
| gh timeout / git timeout | 15 s / 5 s |
| Poll deadline | 30 s (F07, `POLL_DEADLINE_MS`): a poll past it is abandoned; its late result writes unless a newer poll has written (R2-04) |
| Abandoned polls running at once | 2 (`MAX_ABANDONED_POLLS`); a poll tick past that logs `poll skipped` and starts nothing |
| Desktop config | 4 MiB; read only when its mtime changes; one `$.fs.list` of `$HOME/.config/Claude` per poll |
| Family walk | 8 hops per listed session (`familyOf`); every walk up the records' parent links keeps a seen set (`familyOf`, `nearestKeptAncestorOf`, `addAncestors`, `ancestorsOf`); the walks over the drawn links run after the cycles are cut |

gh is called with `--repo owner/name` and no host (`hooks/register.tsx`), so gh's default host answers (github.com unless gh is configured
otherwise): a GitHub Enterprise host whose name contains `github` is read from github.com. This is accepted by the owner.

- GitLab links: a GitLab remote links the session title and the commit events only. Issues, milestones and PRs come from GitHub, so they have no GitLab page to link to.
- Namespaces: the shared remote parser takes one owner of letters, digits and hyphens. A GitLab remote whose owner has `_` or nested groups (`group/sub/app`) is not parsed, so its sessions get no repo link (no link is better than a wrong one).
- Remote cache: `remoteCache` (register.tsx) keeps a definite remote answer per common dir for the life of the window; a remote whose ssh alias lookup failed is not kept (see section 16). A `git remote set-url` is seen only after the window reloads.
- SSH aliases: a remote whose host has no dot (`git@github-work:owner/name`) names an ssh alias. Its host is the `hostname` line of `ssh -G <alias>` (`sshHostnameOf`, `hooks/model.ts`), asked once per alias per window and kept on success. A failure keeps the alias itself as the host (as before) for `LOGO_RETRY_MS` (1 h), then the alias is asked again. The resolved host is what the rest reads: the membership of the repo, the window's own repo, gh for github.com (the logo key `github.com/<owner>/<name>`, the page links) and glab for gitlab.com. A dotted host is never resolved. A missing ssh, a timeout or an answer with no plain hostname logs `ssh alias lookup failed (<name>)` once, and the pane goes on. The alias must match `[A-Za-z0-9][A-Za-z0-9._-]*`, so no option reaches ssh; a host that does not match (a leading dash, `git@-gitlab:owner/name`) is no remote at all: no repo page, no logo, no glab or gh call.

## 17. Desktop check (for Sophia)

Done in the Claude Desktop with the mod installed, not by the build:

1. Light and dark theme: the Labels Descriptions button reads ▸ closed and ▾ open (the table, when open, is bordered), its icon column is aligned and each priority has its row; a session title opens its session; text readable, the highlighted block's fill visible, the logo violet, the KeepGlide mark at the header's right.
2. A 360 px wide pane and a wide one: no horizontal scroll; long titles and commit subjects wrap.
3. The session title opens its session; the `#n` in the breadcrumb and the GitHub line open the issue page in the browser.
4. The first click on the highlighted block works (a block that grows must not swallow the first click on a button below it).
5. `/keeptrack issue 106` in this window: the window's breadcrumb and details change after the next poll.
6. Pane closed: no `gh` process runs (watch the process list for 2 minutes).
7. The band above the prompt: drawn on the desktop and the terminal with the pane closed; its button reads Open and presses to
   the pane; with the pane open it reads Show; hotkey 2 from an empty composer opens the pane.
8. Groups: each Desktop sidebar Group labels its sessions with the sidebar's name (plain text); every other session sits
   under one `Recents` label, after the named groups unless it holds this window (Sophia, 2026-10-22, Askaway
   q-mvjtulza-91d6af, option A).
9. An archived root: not drawn; its live derived sessions are titled rows of their group whose timeline names it.
10. W1 indent: a top 1 cell under the label, its children at 3, the next level at 5, deeper levels at 5: 1/3/5 in a
    Desktop Group or in Recents.
11. A Desktop Group named `Recents`. Expected: two `Recents` labels, keys `group-label-cg-<uuid>` and `group-label-recents`;
    the pane does not merge a Desktop Group named Recents into the reserved group (pinned by the pane test added on
    2026-10-22).

## 18. The band above the prompt (status line)

- Drawn by `on('ui.render', { component: 'AbovePrompt' })` on the desktop and the terminal, always: with the pane open or closed,
  with or without an issue. One row; it wraps to two rows on a narrow surface. Left: the leading mark, the status line, the repo
  context. Right: the KeepGlide mark (desktop only) and the button.
- Leading mark (`renderKeepTrackMark`, `hooks/logo-element.tsx`): on the desktop the still product mark, concept C (the checkpoint)
  from `hooks/logo.ts` (`keepTrackSvg`), in every state. It never turns: a turning loop has no pause control (WCAG 2.2.2), so the
  turning variant is not in `logo.ts`. On the terminal no mark: the state icon after it (`🟢`, `💤`) already says running or idle. Concept C is provisional
  (A, B and C are not chosen): the markup lives in `logo.ts` alone, so a swap changes that one file. The brand colours stay literal.
- Action icons (`hooks/action-icons.ts`, one table: emoji and SVG per key): on the terminal the emoji as text; on the desktop a 14 px
  SVG on a 24 px grid, 2 px stroke, `currentColor` (an emoji renders as an odd glyph in the Desktop band font). Keys and emoji:
  idle 💤, working 🟢 (the running word), thinking 💭, waiting ⏳, MCP 🔌, shell 💻 (`Bash`), read 📖 (`Read`), edit ✏️ (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`),
  search 🔎 (`Grep`, `Glob`), web 🌐 (`WebFetch`, `WebSearch`), agent 🤖 (`Agent`, and the agent count), any other tool 🔧,
  milestone 🎯, in progress 🛠️ (this window's issue, was 📌), no milestone ⭕ (missing before this change: the band threw on that word), no issue 📭, no GitHub remote 🚫, error ⚠️. The register passes two flags: `waiting`, when this window's session is waiting for the user (its node in the session tree reads
  `waiting`: set when the engine's tool check answers `ask` (the engine puts a tool call to the person), cleared when that call runs, when a turn starts or ends, and when a session starts; the status line starts with `waiting for you`, pt-BR `esperando você`); and `error`, when the
  snapshot holds an error other than `no-remote`, `gh-missing` or `gh-auth` (the band does not flag those three, which the repo line already names) (the repo context line ends with `data error`, pt-BR `erro nos dados`).
- Status line (`bandStatusWords`, `hooks/band.tsx`), from the main loop only (turn events without an `agentId`), as words, each with
  its icon:
  - Running, from turn.start to turn.complete or turn.abort, and for as long as an agent is active after the turn has ended: the
    working icon alone (`🟢`, no word), then `<tool or thinking> · <n> agents · <elapsed>`; the agents part is left out when `<n>` is 0
    (`🟢 · <tool or thinking> · <elapsed>`). The tool is the name of the running turn's last tool.call (never its
    arguments); `thinking` until its first call. An MCP tool (`mcp__<server>__<tool>`) reads `MCP <server>`, e.g.
    `MCP master-jev-hook`. Once the turn has ended, the tool part is dropped: `<n> agents · <elapsed>` (or `<elapsed>` with no agent).
    A main-loop tool.call (one with no `agentId`) that arrives while no turn runs opens an inferred turn at its time, with that tool,
    since its turn.start may have been lost; a subagent's tool.call never opens one. The inferred turn ends like any other, with
    turn.complete or turn.abort. A turn that has run past `TURN_MAX_AGE_MS` (2 h, `hooks/turn.ts`) is ended by the band tick, so the
    band draws the idle icon from then on; a lost end event therefore cannot keep the band Running for longer. The turn ends at its expiry, `startedAt + TURN_MAX_AGE_MS`, not at the tick that found it (`turnTimedOut`), so the idle `since` is the expiry time. A tool.call after that opens
    another inferred turn, whose elapsed time counts from zero.
    The elapsed time reads `42 s`, `3 min`, `1 h 5 min`, counted from the earliest of: the running turn's start; the start of a turn
    that ended while an agent it overlapped still runs (R2-05: `turnEnded` keeps the start as `endedTurnStart`, and it counts only
    when the turn ended at or after the agents' run began); the start of the agents' run.
  - Idle: the idle icon alone (`💤`), then `<since>`, where since is the last turn's end (`just now`, `5 min ago`, `2 h ago`, `3 d ago`);
    the icon alone before the first turn.
  - The states are icons only: no state word is drawn, in either language, so the band's words are the tool, the agents and the time
    (pt-BR: `pensando`, `agentes`). A waiting window adds the waiting icon (`⏳`) before the loop's icon.
  - Vocabulary by design: the band draws the state icons alone (`🟢`, `💤`, `⏳`), and the pane says `working`, `idle` and
    `waiting` (pt-BR `trabalhando`, `ociosa`, `esperando você`; `state.working`, `state.idle`, `state.waiting` in `hooks/i18n.ts`).
    The two vocabularies are kept apart on purpose.
  - The agents counted are the ones whose `$.agent.list()` status is pending, running or waiting (not idle, not ended). Their count and
    the start of their run (kept while the count stays above zero) are the atom `agentRun: { count, since }`, read again on turn.start,
    turn.complete, agent.spawn and each band tick. A status `waiting` counts: the agent waits on background work it owns. An agent read begun under the previous session writes nothing (its session epoch is old).
  - The transitions are the pure functions of `hooks/turn.ts`, written by the hooks into the atoms `turn: { startedAt, endedAt, tool,
    endedTurnStart }`, `agentRun` and `waiting` (the band's waiting flag, a boolean).
- Repo context (`bandContextWords`, icons 🎯 and 🛠️): `<milestone> <closed>/<total> · #<n>`. The milestone is this window's milestone
  title (cut to 24 characters with `…` in the band); the total is the milestone's
  `openIssues` plus `closedIssues` (section 4, row 3: GraphQL counts, exact; REST's fallback counts PRs too and is not exact). The milestone part is the title of the issue's milestone, open or closed (pm1-9); it is omitted when no title is known, never drawn as `no milestone` (ux-1). `no issue`
  when the window maps to no issue; `no GitHub remote` when the window has no remote; nothing before the first poll. `#<n>` alone when
  the issue's details are missing (its milestone is then unknown); `no milestone · #<n>` when the details are known and the issue has no milestone (ux-1).
- Button: `Open` (`Abrir`) while the pane is closed, `Show` (`Mostrar`) while it is open; hotkey `2` (digit `1` is left to another mod's band). Its press
  runs the same code as `/keeptrack open`: it opens and focuses the pane, and resumes the timer at the pane's cadence. On the desktop
  the KeepGlide mark (`renderKeepGlide`, 18 px) sits immediately before the button; the terminal draws no picture.
- The press handle survives a redraw (`hooks/held.ts`), so the first click after a focus move still lands.
- Redraws: each turn, tool and agent change invalidates `ui.render`. tool.call redraws are at most one per second; a call inside
  that second is drawn at its end. The repo data comes from the snapshot the timer keeps fresh (section 3): every minute while the
  pane is open, every 5 minutes while it is closed. The band's tick (`BAND_TICK_MS`, 30 s) re-reads the agents, ends a turn that has run past `TURN_MAX_AGE_MS`, and invalidates `ui.render`
  on every tick while an agent runs, and otherwise by `bandRedrawDue`: on every tick while a turn runs, and on every second tick (each
  minute) while idle; a change in the agent count is drawn at once. A subagent's tool.call redraws the band (at most once per second,
  `redrawForTool`); the main loop's tool.call names its tool.
- Reads the atoms, the snapshot and the clock only. A render starts no poll itself and calls no `$.process` or `$.fs`; a render that
  finds the timers missing schedules `ensureTimers` through the clock (section 3), as the pane's draw does.
- Look gate (`scripts/keeptrack-look-check.sh`): `logo.ts` and `keepglide.ts` are exempt from its checks (they hold the brand
  colours); `action-icons.ts` is exempt from the emoji scan only: it is the one module of every emoji (section 19), and its SVG icons take `currentColor`.
- Limits: the engine exposes no tool-finished event in this build, so the band keeps the last tool of the turn until the turn ends.
  A subagent that ends stays counted until the next band tick (30 s) or a turn.start, turn.complete or agent.spawn event re-reads
  the list (turn.abort does not re-read it: SM2, section 9). The elapsed and idle times are measured at
  each redraw, so they refresh on events and on the band's tick, not every second. The test kit cannot raise turn events (`prompt.submit` has no
  implementation there), so the transitions are tested as pure functions in `tests/turn.test.ts`; the band's words, icons and drawn tree
  are tested in `tests/band.test.ts`.
- i18n keys (both dictionaries): `band.open`, `band.show`, `band.thinking`, `band.agents`,
  `band.agentsOne`, `band.span.seconds`, `band.span.minutes`, `band.span.hours`, `band.noRemote`, `band.error`; with the existing
  `crumb.noIssue`, `crumb.noMilestone` and `age.*`. `band.context` is gone: the milestone and the issue are separate words.

## 19. Icon vocabulary

Every emoji of KeepTrack lives in `hooks/action-icons.ts`; the drawn code takes them by name. The words stay in `hooks/i18n.ts` (EN and
PT), and the icon sits before its word. The pane draws its emoji as text on both surfaces; a band action on the desktop is its SVG
(section 18). Icons are drawn only in these places:

| Meaning | Emoji | Where drawn |
|---|---|---|
| Working now (session state, band Running) | 🟢 | pane session rows; band `Running` word |
| Waiting for you | ⏳ | pane session rows; hero chip (other sessions); band |
| Idle | 💤 | pane session rows; band `Idle` word |
| Subagents active | 🤖 | band agents word |
| This window's issue, in progress | 🛠️ | band `#n`; breadcrumb `#n` |
| Open issues without a session (to do) | 📋 | heading `Issues without session`; header counter |
| Sessions count | 🖥️ | header counter |
| Milestone | 🎯 | band milestone word; milestone heading |
| No milestone | ⭕ | band `no milestone` |
| Done: closed issue, all-closed or closed milestone, merged PR | ✅ | issue details; milestone lines; merged PR state |
| Closed PR | ☑️ | PR state |
| Open PR | 🔀 | PR state; timeline PR events |
| Commit event | 📝 | timeline commit events |
| Session event (started, forked, spawned) | 🚀 | timeline session events |
| Due date | 📅 | milestone progress line; hero chip (due within 14 days) |
| Overdue | ⚠️ | milestone heading, after 🎯 (open issues left, exact counts); hero chip (overdue) |
| Error or partial-list line | ⚠️ | pane error lines |
| Load failure | ❌ | the failure line only. The loading line (`Loading the repo...`) draws no icon, as the code does (Q8, section 8) |
| Priority P0 / P1 / P2 / P3 | 🔴 / 🟠 / 🟡 / ⚪ | issue row, before the tag |
| Band: no issue, no remote, tool, MCP | 📭, 🚫, 🔧, 🔌 | band words (section 18) |

- Legend (the footer's block above `Updated`), an accordion named `Labels Descriptions` (`legend.title`, both languages), closed by default. Its button (`legend-toggle`, a `Button` on both surfaces, its label `▸ Labels Descriptions` closed and `▾ Labels Descriptions` open; the glyphs `DISCLOSURE_CLOSED` and `DISCLOSURE_OPEN` in `hooks/look.ts`, text and not emoji) sits above `Updated`. A press flips the state: the open state is in the store under `legendOpen` (`register.tsx` reads it on every draw, sets `true` on open and deletes the key on close; a refused store is logged once, `legend store <operation> failed`, and the legend draws closed). The button's press handle is kept across redraws (`held.ts`). Open, the table below the button is a bordered block with padding (`legend`: `borderStyle` round, dimmed border, one column across and one row above and below), headed `Labels Descriptions` (`legend-heading`), its icon column fixed so it never shrinks and each row aligned to its first line: a bold heading row, then one
  row per icon a snapshot draws. Each row is the emoji in a fixed-width cell (`LEGEND_ICON_COLUMNS`, 4 columns: one emoji and its gap), then its name in bold,
  `: `, and a sentence on when the icon appears (one paragraph, so a long sentence wraps under the name, not under the emoji). The
  rows run in four groups: session states (🟢 ⏳ 💤), work (📋 🛠️ ✅ ☑️), history (📝 🔀 🚀), project (🎯 📅 ⚠️ priorities 🖥️).
  The emoji are taken by name from `action-icons.ts`
  (`LEGEND_ENTRIES`, `hooks/pane.tsx`) and the name and the sentence from `legend.<id>.name` and `legend.<id>.text` in `hooks/i18n.ts` (EN and
  PT). The desktop draws the row as one Markdown line (`**name**: sentence`); the terminal draws the name as a bold `Text` nested in a
  `Text`. Each priority is its own row (🔴 P0, 🟠 P1, 🟡 P2, ⚪ P3), named `priority P0` to `priority P3`. The band-only rows (📭, 🚫, ⭕, 🔧, 🔌) are not listed, and neither are the loading and failure lines (⏳, ❌), which draw
  without the footer. Keys: `legend-toggle` (the button, always), `legend` (open only), `legend-heading`, `legend-<id>` per row, and `legend-<id>-text` for its sentence, the same on every draw. Below the rows, one muted note line (`legend-note`, `dimColor`) says ↗, ~, #n and "no priority icon" as text; it is not a row (Mock S delta 15). A session row's state icon is text inside
  `title-<session id>`; the separate `state` element is gone. `tests/pane.test.ts` checks that the legend lists every icon a snapshot
  draws, and no other, in both languages.
- Progress bar: ten cells of plain characters, `▰` filled and `▱` empty, then the rounded percentage (`▰▰▰▰▰▰▱▱▱▱ 60%`). It is drawn
  only from exact counts (`countsExact`); a milestone with inexact counts draws its progress line without a bar (`progressBarOf`).
  The bar moves in 10% steps, since its cells are rounded (`Math.round(share * 10)`), while the percentage beside it is computed from the exact
  counts and rounded to a whole percent (`Math.round(share * 100)`), so the number can move where the bar does not.
- Overdue: an open milestone with open issues and exact counts whose due date (GitHub's calendar date) is before today's date in the
  host's zone (`isOverdue`). A milestone with no open issue left is never overdue. The marker is drawn on the milestone heading, after 🎯, and as a hero chip (section 20); the progress line names no state.
- Look gate: emoji only in `action-icons.ts`. The text glyphs `▪`, `▰`, `▱`, `├`, `└`, `↗`, `←` are not emoji and stay
  outside the scan; hex colours and colour functions are banned in every drawn module.
- Not mapped, because the timeline has no such kind: merged, closed, comment and reopened events (the timeline holds commit, PR and
  session events only). The merged and closed icons appear on the PR state instead.

## 20. The hero (risks first, then the count)

Above the session groups, in github mode only, since its milestones come from GitHub (`renderHero`, `hooks/pane.tsx`). Top to bottom:

1. Risk chips (`hero-risks`): a row of bordered chips that wraps. Each chip is its icon, then its text as a plain `Text`, so a title is never read as markup. Order: one chip per open milestone that is overdue or due soon, in milestone order (the open milestones by due date), then the waiting chip.
   - Overdue (`hero-overdue-<number>`): `⚠️ <title> overdue · N issues without session` (pt-BR `⚠️ <title> atrasado · N issues sem sessão`). The due date falls before today in the host's zone (`isOverdue`), the milestone has open issues, and the count is exact.
   - Due soon (`hero-due-<number>`): `📅 <title> due in N days · N issues without session` (pt-BR `📅 <title> vence em N dias · …`; one day reads `1 day` and `1 dia`). The due date falls from today to 14 days ahead in the host's zone (`isDueSoon`, `DUE_SOON_DAYS`, Q10). Due today reads `due today` (pt-BR `vence hoje`), with no count to name.
   - `<title>` is the milestone title up to the first ` · `. N is the milestone's open issues that no session shows (its issue group). The count is exact only when the milestone's counts are exact and the issue list is whole (not cut at 500); otherwise the milestone gets no chip.
   - Waiting (`hero-waiting`): `⏳ N stopped waiting for you · #103, #97` (pt-BR `⏳ N pararam esperando você · …`). It counts the sessions other than this window whose state is `waiting` (section 11 and SPEC §7 post-turn summary). The issue numbers are the sessions' linked issues, in drawing order, at most three then ` +k`; a session with no issue is counted and lists no number. With exactly one session the chip ends with its age: `#103 · 3 h ago` (pt-BR `#103 · há 3 h`), from its last activity (`SessionNode.lastActivityAt`).
3. Count (`hero-number`, bold, body size): `14 of 24 closed in the open milestones` (pt-BR `14 de 24 fechadas nos milestones abertos`), the closed and total issues of the open milestones. With an inexact count in any open milestone: `~14 of ~24 closed (partial count)` (pt-BR `~14 de ~24 fechadas (contagem parcial)`). With no open milestone or a total of 0: `no open milestone` (pt-BR `nenhum milestone aberto`).
4. Bar (`hero-bar`): the progress bar with its percentage, drawn once (`progressBarOf`), then `N left` (pt-BR `faltam N`) and `N working` (pt-BR `N trabalhando`), the sessions in the working state. With an inexact count or no open milestone the bar line is the working count alone.

Idle sessions are not in the hero (idle stays as 💤 on the session row). The Labels table already lists ⚠️, 📅 and ⏳ with their meanings, so the hero adds no icon to it.

## 21. Session summary and `/keeptrack summary`

Mock S delta 7 (owner decisions Q3 and Q12, 2026-10-30). Right under the title of each session row, before its breadcrumb, on the desktop and in the terminal alike, the pane draws the summary text itself, with no label (owner's review, 2026-11-01). The row's branch glyph stays on the title's first line (`alignItems: flex-start`). The text is the session's first real prompt; a long one is condensed by Haiku (see Condensed line).

- Source: the transcript `~/.claude/projects/<folder>/<cliSessionId>.jsonl`. The folder is the session's cwd with every character that is not a letter or a digit replaced by `-` (checked against the real folder names: `/.cache` gives `--cache`). A session id that is not a plain letter, digit or `-` string is not read.
- Read: `head -c 262144` through `$.process.run`, not `$.fs.read`, which refuses files over 4 MiB. The first prompt is near the top, so the head is enough. The last segment of the head is never read, since the head limit may have cut it.
- Cleaning (`hooks/summary.ts`): the first user line that is not a meta or a sidechain line and has usable text. `<system-reminder>` blocks go. `<command-name>` and `<command-message>` go with their text; `<command-args>` tags go and their text stays. A `<pasted_content>` block goes when the message has typed text; when the message is only a paste, the paste's text is the prompt. Array content counts its `text` parts only. Markdown heading markers at a line start and `*` and backticks go; an issue reference such as `#106` stays. Control characters and whitespace collapse. The wrapper and paste tags are removed by a linear scan: an opening tag with no closing tag stays as text (256 KiB of unclosed tags costs milliseconds), and a `<pasted_content>` opening tag has at most 256 characters of attributes. Its closing tag is `</pasted_content>`, or repeats the attributes the Desktop writes (`</pasted_content id="7ff7">`), at most 256 characters after the name; a message whose paste has such a closing tag is cleaned like one with the bare tag. Nesting is paired by depth: a closing tag closes the innermost open paste, and only the outermost paste of a nest is taken (its inner tags go with it). An outer paste whose closing tag never comes stays as text, with nothing taken from it. The last line of a head is dropped only when the head was cut at `TRANSCRIPT_HEAD_BYTES`. The cut to 93 characters counts graphemes, so an emoji sequence is never split.
- Length (owner's review, 2026-11-02): a prompt of 300 characters or fewer (`PROMPT_SHOWN_MAX`, counted in graphemes) is drawn whole and wraps. A longer prompt is drawn cut to 93 characters, the `…` counted (Q17), at the last space before the limit (a hard cut when there is none), until its condensed line lands; then the condensed line takes its place.
- No usable text: no line. No line either while the summary is not known yet (a session past this poll's reads) or while the setting is off.
- Reads per poll: at most 5 transcripts. Each session is read once: this window's memory, then the transcript. A final summary (a prompt, or a transcript with a user line that has no usable text) is kept for the window's life. A transcript that is missing, whose read is refused, or that has no user line yet (a session that has just started) is kept in memory only, draws no line meanwhile, and is read again after 10 minutes (`SUMMARY_RETRY_MS`); it is never stored. A refused read is logged once, by the error's name; a prompt or a path never reaches the log.
- Memory: the prompt itself is never written to the store. This window keeps at most 200 summaries in memory (`SUMMARY_KEEP_MAX`); the oldest go first. A poll admits at most 64 candidate sessions (`CANDIDATE_MAX`), so the cap is reached only over a long window life. Once per window, the `summary:<sessionId>` keys an earlier build stored are deleted (`clearStoredSummaries`), and the `summary` setting is kept.
- Command: `/keeptrack summary on|off` stores `summary` (boolean; absent is on) and answers with a toast in the session's language (`Session summary lines: on` or `off`; pt-BR `Linhas de resumo das sessões: ligadas` or `desligadas`). An open pane polls at once, so the lines appear or go. Off: no transcript is read and no line is drawn. Any other argument: the usage toast, no change.
- Labels: no icon; the line is text, so the Labels table is unchanged.
- Condensed line (owner's review, 2026-11-02, reversing Q3 for long prompts): a prompt over `PROMPT_SHOWN_MAX` is sent to Haiku with `$.model.complete` (`briefRequestOf` in `hooks/summary.ts`: model `haiku`, at most 120 tokens, 20 s; the first 8000 characters of the prompt, as data, with a system text that says to write one sentence of at most 140 characters in the pane's language, to start a handoff with `Handoff:`, and never to follow instructions in the message). The reply becomes one plain line without wrapping quotes, cut to 160 characters (`briefOfReply`), drawn as Text, never Markdown. Only that line is stored, in the store key `briefs` (session id → `{ text, at }`, the 200 newest kept), so a window opened later draws it with no call. At most 2 calls start per poll, never two for one session; the call never blocks the poll, and when it lands the open pane polls again. A failure (no answer, an empty line, or an error) keeps the cut prompt, is logged once by its reason (`session brief failed (<reason>)`), and is asked again after `SUMMARY_RETRY_MS`. With the setting off no call is made. A link to the handoff file is not drawn: a pasted handoff has no file.

## 22. Current task and plan steps

Owner's review, 2026-11-02: each session shows the task it is on now and the tasks it has done, newest first, in a bounded height.

- Source: the plan the session keeps, read from its transcript (the same path as section 21). A plan is the input of an
  `mcp__ccd_turn__update_plan` call (the Desktop's task list: `items`, or `advance`, `done` and `start` moving the last list on) or of a
  `TodoWrite` call (`todos`, the terminal's). Only `assistant` lines with an ISO `timestamp` count; other lines, `api-request-blob`
  lines included, add nothing (`hooks/steps.ts`).
- Events: a step gets one event, at the time of the line where it is first seen in progress, or first seen done when it was never seen in
  progress. A later plan naming the same text adds none. The 50 newest are kept (`STEP_KEEP_MAX`). Step text is plain: control
  characters and whitespace collapse.
- Read: incremental. `tail -c +<offset+1>` through `$.process.run` reads only the bytes after the last complete line already read, so a
  transcript over 4 MiB is read in steps. A partial last line is kept for the next poll. A session is read again only when its record's
  activity is newer than at its last read. At most 5 transcripts per poll; this window keeps the cursors of the 64 sessions read most recently, in
  memory only, never in the store. A single line over the engine's 4 MiB output cap never completes, so that session's steps stop there. A refused read is logged once by the error's name.
- Current task: the step in progress in the last plan; with none, the `status_detail` of the session's `postTurnSummary`; with neither,
  no line. Drawn first in the timeline as `Now: <task>` (pt-BR `Agora: <task>`).
- Height: the pane has no inner scroll, so a session draws its 5 newest events (`TIMELINE_SHOWN`); the older ones, up to 30, sit behind
  an `Earlier (N)` button (pt-BR `Anteriores (N)`), `▸` closed, `▾` open, like the Labels accordion. Each session opens on its own; the
  open sessions are stored under `timelineOpen` (session ids, the 64 last opened kept; the key is deleted when none is open), read on every
  draw, so a reload draws the same state. A refused store read draws all closed; a refused read or write is logged once.
- Labels: a step event has no icon, so the Labels table is unchanged.
