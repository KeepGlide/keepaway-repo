# Changelog

All notable changes to KeepTrack are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows
[SemVer](https://semver.org/); while the version is `0.y.z`, any release may change behavior.
The version in `plugins/keeptrack-repo-pane/.claude-plugin/plugin.json` is 0.2.0-beta.8.
Commit hashes name the change in `git log`.

## [Unreleased]

## [0.2.0-beta.18] - 2026-10-30

### Security
- Repo logos are raster only: PNG and JPEG. An SVG is no logo from the checkout, from GitHub's contents or from an avatar. A PNG or JPEG must open and close as one (magic bytes and trailer), so a truncated download is no logo. A symbolic link is never read as a logo.
- The avatar fetch follows no redirects (curl without `-L`; https only is kept). The logo cache key is the remote's host, owner and name in lower case, and gh is asked only for github.com.

### Added
- The Last commit line of this window's details links to its commit page on the desktop.
- An exact milestone with no issue at all reads `no issues` (pt-BR `sem issues`), with no done icon.
- A GitLab repo's project avatar is asked of glab on the remote's own host (`--hostname`); a glab timeout is not kept as missing.
- On the desktop, a repo with no logo file of its own shows its GitHub organization's avatar (32 px, PNG or JPEG, fetched over https only from `avatars.githubusercontent.com` through curl and base64, 64 KB cap). A user owner draws none. A failed fetch is kept for an hour (SPEC section 11).
- On the desktop, a session row shows its repo's logo, 16 px before the title, when the repo has one: the logo file of the session's checkout (`logo.png`, `logo.jpg` or `logo.jpeg` at the root, in `assets/`, `.github/`, `docs/` or `images/`), else GitHub's contents of the repo. The logo is sanitized, capped at 64 KB and cached per repo (24 h, 1 h after a failed lookup). A repo with no logo draws nothing; the terminal draws none.
- A remote whose host is an ssh alias (`git@github-work:owner/name`, no dot in the host) is read as the host ssh resolves it to (`ssh -G`, asked once per alias per window): its logo, its page links and its GitLab avatar follow the real host, so a GitHub alias gets the GitHub logo. A failed resolution keeps the alias as before, is logged once by its failure name and is asked again after an hour (SPEC section 16). A remote host with a leading dash is no remote.
### Changed
- Logo lookups: a logo is kept in memory as well as in the store, so a poll reads the store only on a miss; the store keeps at most 20 repo logos; a cross-window lock stops a second window's lookup of the same repo; a store refusal is logged once per operation and never fails the pane.
- This window's issue view is not asked again while the issue's `updatedAt` is unchanged.
- The 🔄 "session working now" marker is gone from the session rows and from the Labels legend: the 🟢 state icon already says working, and ▶️ still marks this window. Its legend row and its strings are removed in both languages (`hooks/pane.tsx`, `hooks/i18n.ts`, `hooks/action-icons.ts`).
- The Labels legend's idle sentence now reads "no activity recorded in the Desktop app for more than 5 minutes" (pt-BR "sem atividade registrada no app Desktop há mais de 5 minutos"), the `WORKING_WINDOW_MS` threshold of `hooks/model.ts`.
- SPEC section 19 notes that the progress bar moves in 10% steps (its cells are rounded), while the percentage beside it is computed from the exact counts.

## [0.2.0-beta.17] - 2026-10-30

### Added
- The `open session: <title>` link names its session (the title cut at 40 characters), so a screen reader tells the links apart.
- The pane's session titles link to the repo's GitHub or GitLab page when the session's remote is known. An `open session` link after the icons keeps the session openable; with no known remote the title opens the session, as before.
- On the desktop, milestone headings and the breadcrumb's milestone link to the GitHub milestone page; commit and PR timeline events link to their commit or PR page; the PR line of this window's details links to the PR.

### Changed
- The loading line is plain text: the ⏳ icon stays for waiting for you.
- The Labels legend is a bordered block with one row per priority (🔴 P0 to ⚪ P3). The icon column is four columns and never shrinks, so every row's text starts at the same x, a wrapped sentence keeps its icon on the first line, and the gap is small.

## [0.2.0-beta.16] - 2026-10-30

### Changed

- Each row of the footer's `Labels` table reads its name in bold, then `: ` and a sentence on when the icon appears, in English and pt-BR, so a row explains itself. The texts are `legend.<id>.name` and `legend.<id>.text` in `hooks/i18n.ts` (the old single `legend.<id>` meaning keys are gone). The desktop draws each row as one Markdown line, the terminal as a bold `Text` nested in a `Text`. Two names changed: `attention` (pt-BR `atenção`) for ⚠️ and `done` (pt-BR `feito`) for ✅. The README pair no longer says the band shows a state word.

## [0.2.0-beta.15] - 2026-10-30

### Changed

- The band draws its states as their icon alone: running `🟢`, idle `💤`, waiting `⏳`. The words `Running`, `Idle` (pt-BR `Executando`, `Parada`) and the `band.running` and `band.idle` keys are gone; the tool, agents and time stay as words (`hooks/band.tsx`, `hooks/i18n.ts`, SPEC section 18).
- The footer legend is a table headed `Labels` (pt-BR `Labels`): a bold heading row, then one row per icon, the emoji in a fixed-width cell and its meaning beside it. Rows run in four groups: session states, work, history, project (`hooks/pane.tsx`, SPEC section 19).

## [0.2.0-beta.14] - 2026-10-30

### Changed

- Session rows put the title first, then the state icon (🟢, ⏳, 💤) and the active marker (▶️, 🔄) after it. The state word is gone from the rows, in both languages; this window's details keep their `State` line (`hooks/pane.tsx`, SPEC section 11).

### Added

- A legend at the foot of the pane, above the `Updated` line: every icon the pane draws, with its meaning in English and pt-BR. The emoji come from `hooks/action-icons.ts`, so the legend cannot drift from the table (`hooks/pane.tsx`, `hooks/i18n.ts`, SPEC section 19).

## [0.2.0-beta.13] - 2026-10-30

### Changed

- The band on the terminal draws no leading `▶`/`○` mark: the state icon (`🟢`, `💤`) already says running or idle (`hooks/logo-element.tsx`, `hooks/band.tsx`).
- Only this window's block draws the `🕘 Timeline` heading; other sessions' timelines are drawn without it (`hooks/pane.tsx`).

## [0.2.0-beta.12] - 2026-10-30

### Added

- Icons before the words, all in `hooks/action-icons.ts` (the one module of emoji): session states 🟢 working, ⏳ waiting for you and 💤 idle; active rows marked ▶️ (this window) and 🔄 (a session working now); a 🕘 Timeline heading, with 📝 commit, 🔀 PR and 🚀 session icons; open issues under a 📋 heading, this window's issue with 🛠️; milestones 🎯 with a 📅 due date and a ⚠️ overdue marker; a text progress bar (`▰▰▰▰▰▰▱▱▱▱ 60%`) only from exact counts; priority tags 🔴 P0, 🟠 P1, 🟡 P2 and ⚪ P3; header counters 📋 and 🖥️; loading ⏳, load failure ❌ and error lines ⚠️; PR state icons. The vocabulary is SPEC section 19.
- The look gate's self-check, `scripts/keeptrack-look-selftest.sh`: the gate passes on the real tree, fails on an emoji outside `action-icons.ts` and on a hex colour, and passes an emoji inside it.

### Fixed

- Drawing the band for a window whose issue has no milestone threw: its `no milestone` word named an icon the table did not have. The table now has ⭕ for it, with a regression test that draws the band.

## [0.2.0-beta.11] - 2026-10-30

### Added
- Issues carry a priority tag read from their GitHub labels: `P0` to `P3`, or `priority: critical|high|medium|low` (also the `priority/…`, `priority-…` and `prio…` variants), case-insensitive; critical is P0 and low is P3. Inside each issue group the issues sort by priority, P0 first and unlabelled last, then newest first; the row draws the tag, and P0 and P1 rows draw bold (`hooks/model.ts` `priorityOf`, `hooks/pane.tsx`, `hooks/look.ts`).

### Changed
- Open milestone groups sort by due date, earliest first; a milestone with no due date comes after the dated ones, by number (`hooks/model.ts` `groupIssues`).
- KeepTrack no longer reads Askaway data: the `ASKAWAY_HOME` variable, the Askaway question folder and the "Blocked by" row of the issue details are removed. The waiting state now comes from the engine's own tool check for this window (`tool.check` answers `ask`), so it clears when the call runs or a turn ends. Other sessions no longer show waiting, since no Desktop record says so.
- The poll is scheduled at once on session start, and the snapshot is marked stale until the poll lands (`hooks/register.tsx`).
- Each session line draws its state word: working, idle or waiting (`hooks/pane.tsx`).
- A milestone line reads "X of Y issues closed" (`hooks/pane.tsx`).
- A milestone with open issues that all sessions work on reads "N open, all in sessions" (`hooks/pane.tsx`).
- The header counter keeps its counts when no session is listed: `N open issues · 0 sessions · nothing in progress` (`hooks/pane.tsx`).
- The "Sessions on this machine" heading is removed from the pane, by owner decision (`hooks/pane.tsx`).
- A milestone progress line ends with `· due YYYY-MM-DD` when GitHub gives the milestone a due date (`hooks/pane.tsx`).
- The footer age uses the rows' scale (`N min`, `N h`, `N d`) instead of a raw minute count (`hooks/pane.tsx`).
- The session timeline marks a session event with `◇`; `▪` now marks only a link (`hooks/pane.tsx`).
- The "Next step" line reads "no next step" (pt-BR "nenhum registrado") when no value exists (`hooks/pane.tsx`).
- The band's running line leaves out the agents word when there are 0 agents (`hooks/band.tsx`).
- The logo in the band is static and no longer turns while the loop runs, since a turning loop has no pause control (WCAG 2.2.2) (`hooks/logo-element.tsx`, `hooks/logo.ts`).
- The sessions section draws nothing when no session is listed (`hooks/pane.tsx`).
- The issue list reads open issues only, and the milestone totals come from one GraphQL call per poll, issues only, with REST's counts as the fallback (`hooks/register.tsx`, `types/index.d.ts`).
- The issues of a closed milestone are grouped under that milestone's title and marked as closed, not under "No milestone / issue" (`hooks/pane.tsx`, `hooks/model.ts`).
- Partial-list lines name the list that was cut: issues or PRs (`hooks/register.tsx`, `hooks/pane.tsx`).
- Inexact (REST) milestone progress reads "items" instead of "issues", since REST counts the PRs too (`hooks/pane.tsx`, `hooks/i18n.ts`).
- The pt-BR "all closed" line reads "pronto para fechar" (`hooks/i18n.ts`).
- The link arrow (↗) marks only a link that opens; the terminal line has no arrow (`hooks/pane.tsx`, `hooks/band.tsx`).
- "Started" shows the date once the session is more than a day old (`hooks/pane.tsx`).

### Fixed
- Clock times are drawn in the host's zone, not the mod runtime's: the Started line and the timeline times followed the runtime's offset, not the host's. The host's UTC offset is read with `date +%z` at session.start and on each poll; a missing `date` or a bad answer falls back to the runtime's offset (`hooks/register.tsx` `readUtcOffset`, `hooks/pane.tsx` `clockOf`/`dateOf`, `hooks/model.ts` `parseUtcOffset`). GitHub due dates stay calendar dates, never shifted.
- More than 500 open issues no longer undercount: the milestone totals are exact, and the list flags partial (`hooks/register.tsx`).
- "All closed" is drawn only from exact milestone counts, never from a REST zero or a failed totals call (`hooks/pane.tsx`).
- A session.start during a poll in flight polls for the new session once that poll settles (`hooks/register.tsx`).
- A poll that began under an earlier session, and a waiting-flag read it started before a session.start, write nothing (`hooks/register.tsx`).
- A turn ended by the 2 h age cap ends at its expiry, not at the tick that found it (`hooks/turn.ts`, `hooks/register.tsx`).
- The band's waiting flag is refreshed on the 30 s band tick, so a question shows within one tick (`hooks/register.tsx`, `waitingAtom`).
- The turn is reset at session start, so the previous session's turn is not counted (`hooks/register.tsx`).
- A tool call outside a turn starts an inferred turn, since its turn start may have been lost (`hooks/turn.ts`).
- A turn older than 2 hours (`TURN_MAX_AGE_MS`) ends on the band tick, so a lost end event no longer keeps the band Running (`hooks/turn.ts`, `hooks/register.tsx`).
- A pull request from a fork is no PR of this repository, so it no longer matches a local branch of the same name (`hooks/register.tsx`).
- The numeric prefix of a branch is read as an issue number only with 1 to 5 digits, so a longer number at the start of a branch name is no issue number; a date prefix is never one (`hooks/model.ts`).
- A first poll that settles with no repo context draws `Could not read the repo: state unknown` (pt-BR `Não foi possível ler o repo: estado desconhecido`) instead of `Loading the repo...` forever (`hooks/pane.tsx`, `hooks/register.tsx`, `hooks/i18n.ts`).
- The issues of a closed milestone take that milestone's title from the issue's own milestone field, so the group title and its label agree (`hooks/model.ts`, `hooks/register.tsx`, `types/index.d.ts`).
- The "N open, all in sessions" line is drawn only when the issue list is complete and holds every open issue the milestone counts; otherwise the milestone shows its title and progress only (`hooks/model.ts`, `hooks/pane.tsx`).
- The trail and the band name the title of a closed milestone, and say "no milestone" only for an issue that has none; an issue whose milestone title is unknown omits the part (`hooks/pane.tsx`, `hooks/band.tsx`, `hooks/model.ts`, `types/index.d.ts`).
- The header counter of a no-GitHub window counts sessions only (`hooks/pane.tsx`).
- The header counter reads `500+` open issues when the issue list is cut (`hooks/pane.tsx`).
- A session switch clears the window issue and the repo context, so no old repo is inherited on a failed repo read (`hooks/register.tsx`).
- The waiting flag is kept on an unknown answer: the question folder did not list, or holds more than 2000 files (`hooks/register.tsx`).
- A session.start or a `/keeptrack issue` during an in-flight poll, or while abandoned polls fill every slot, is polled again once one settles (`hooks/register.tsx`).
- Agent reads begun under the previous session write nothing (`hooks/register.tsx`).
- The band no longer reports a data error for a missing or unsigned gh, or for no GitHub remote (`hooks/register.tsx`).

### Tests
- Stronger band and register assertions: exact band lines for the no-milestone and unknown-milestone cases, and the "items" wording (`tests/band.test.ts`, `tests/register.test.ts`, `tests/pane.test.ts`, `tests/model.test.ts`).
- An invalid `KEEPTRACK_POLL_MS` falls back to the default cadence, and a valid one sets it (sp-5, `tests/register.test.ts`).
- Clock tests with a fixed host offset: `parseUtcOffset` (`tests/model.test.ts`), `clockOf`/`dateOf` across midnight, the Started line, the due date as a calendar date (`tests/pane.test.ts`), and the offset read at session.start, on each poll and after a refused `date` (`tests/register.test.ts`).

## [0.2.0-beta.8] - 2026-10-22

### Added
- Every session without a Desktop sidebar Group is listed under one single group labelled `Recents`, exactly as the Claude Code Desktop sidebar names them. Owner request, 2026-10-22 (Askaway q-mvjtulza-91d6af, option A).
- The label is `Recents` in both languages, because the Desktop app (44.9.0) has no translated label.
- A Desktop Group literally named "Recents" keeps its own label next to the `Recents` group (two labels, different keys).

### Changed
- The "family as a group" rule of beta.7 is withdrawn: a session without a Group no longer forms a group of its own labelled with its root's title.
- Group labels are plain bold text, with no link and no this-window marker.
- Every top session is a titled `├`/`└` row with its derived sessions nested at 1, 3 and 5 cells, in Desktop Groups and in `Recents` alike.
- Groups are drawn in this order: this window's group first (even when it is `Recents`), then the named Desktop Groups by newest activity, then `Recents` last.
- Inside a group, this window's session comes first, then the newest activity, then the session id.
- An ended (archived) root is not drawn: its live derived sessions are rows of their group (`Recents` when unfiled), with the parent's title in their timeline; the beta.7 rule "oldest first under the root's title" is withdrawn.
- Sessions with no Group share the `Recents` key, so a cycle with no Group keeps one link and a chain past the 8-hop family cap stays nested while its listed depth is 8 or less.
- Internal: `SessionGroup` is `{ key, label, kind: 'desktop' | 'recents' }`, `familyOf` returns only the root id, and dead helpers are removed.
- Tests: two new, 273 in total (model 81, pane 40); one model run proves the missing-parent-before-hop-cap rule under a filed root (mutation-checked), and one pane test pins a Desktop Group named "Recents".

### Migration needed
- No. Update the plugin and run `/reload-plugins` in open windows.

## [0.2.0-beta.7] - 2026-10-22

### Added
- The session tree has the shape of Askaway's: the group on top, then the session and its derived sessions. The group is the Desktop sidebar Group the session (or its family root) is filed under, labelled with the Group's name; otherwise the session family, labelled with the root's title and linked to it. The root's rows sit under the label with no repeated title; derived sessions follow as `├`/`└` rows. Owner request, 2026-10-22.
- Group names come from the Desktop's `claude_desktop_config.json` (only the groups and the session assignments are read, as Askaway does; read again only when the file changes, 4 MiB cap, nothing logged). Owner decision, 2026-10-22.
- A label with no title falls back to the first session of the group with one, then the repository name, then "the session" ("a sessão").

### Changed
- An archived root with live derived sessions keeps its title as the group's label only; the derived sessions are listed under it, oldest first (owner decision, 2026-10-22), and attach to the nearest listed ancestor when a middle session has ended.
- Ended means archived or deleted. The Desktop's `desktop-released.json` marker is not read: on this machine every marker belongs to a deleted session.
- A fork filed in another Desktop Group than its parent is listed under its own Group, as in Askaway.
- Derived rows indent by their drawn level in the group body: 1, 3 and 5 cells, the same in every group (owner decision, 2026-10-22), and sessions with the same activity sort by id instead of by scan order.

### Fixed
- The pane could be refused whole by the engine when two Markdown elements shared a key: two open issues in the list (since beta.5), two session breadcrumbs, or two group labels. Every repeated Markdown element now carries a key of its own.

## [0.2.0-beta.6] - 2026-10-22

### Added
- Singular forms when a count is 1, in the pane counter ("1 open issue", "1 session") and in the records line ("1 session record could not be read").
- README: install from the `sophia-mods` marketplace (`claude plugin install keeptrack-repo-pane@sophia-mods`), a manual path with `claude --plugin-dir`, the KeepTrack mark (`assets/keeptrack-icon.svg`) in the header, and screenshot slots marked pending Sophia's Desktop check (SPEC section 17).

### Changed
- The README pair now follows the KeepGlide README standard: centred banner and header, static badges, a contents block, a platform table, a full AI install spec, Updating and Uninstall sections, Troubleshooting and Known issues. No code change. (8bf4e07)
- Ended sessions are never listed: an archived Desktop session leaves the pane tree at once, parents included, unless it is this window's own session; the live sessions spawned from an archived parent are shown as roots, with the parent's title in their timeline. Owner decision, 2026-10-22 (it withdrew the same-day request for finished rows with a ✓ icon).
- Internal: the test suite is stronger, with more positive controls.

### Fixed
- A false "data error" in the band: the Desktop's `scheduled-tasks.json` and the `deleted_<id>` tombstones in the session records folder were read as session records. Only `local_<id>.json` files are read now.
- The branch read now uses `git symbolic-ref`, so a tag with the branch's name or an unborn branch no longer breaks it.
- A commit with an empty subject is no longer dropped.
- Exactly 500 open issues no longer shows the `list is partial` line.
- An expired issue override is ignored even when the record scan was partial.
- `/keeptrack open` and `/keeptrack issue <n>` followed by extra words show the usage toast instead of acting.
- Branch-to-issue mapping: a leading date in the branch name is no longer taken as the issue number (`2026-10-22-issue-123` maps to #123), while gh's `<n>-<slug>` branches keep their number.
- GitHub page links that contain brackets or quotes are no longer drawn as links.
- Milestones are read with `gh api --paginate`, so a repository with more than 30 milestones lists them all.
- An issue closed by more than 50 pull-request references is no longer mapped to one of them at random: the pane maps only sessions whose branch or PR closes at most 50 issues.
- A malformed entry in the gh issue list is dropped and counted in the log, instead of failing the whole list.
- A gh response above 4 MiB is treated as a failed read (the `GitHub read failed` line) instead of a cut JSON.
- The issue number in a session's title is read from the full title, not the clipped one drawn in the pane.
- One `list is partial` line per cut list (issues, milestones, closing references) instead of one for all.

### Migration needed
- No. Update the plugin and reload; no configuration change is needed.

## [0.2.0-beta.5] - 2026-10-21

First public content of the repository. The mod was renamed from github-repo-work-pane on 2026-10-21; the command is now `/keeptrack`.

### Added
- Pane (`/keeptrack`): this window's session first, with its issue's details and timeline; the other Desktop sessions of the same repository, nested under their parent when derived; open issues grouped by open milestone, with milestone progress.
- Band above the prompt: running or idle state, the current tool or MCP server with its icon, the agent count, the elapsed time, waiting-for-you and data-error states, milestone progress, the issue number, and an Open button with the KeepGlide mark.
- `/keeptrack issue <n>` and `/keeptrack issue none` to set or clear the issue of this window; `/keeptrack lang en|pt-BR|auto` for the language.
- English and Brazilian Portuguese dictionaries for the pane and the band.
- Poll on the open pane every 60 seconds and on the closed pane every 5 minutes (`KEEPTRACK_POLL_MS`, `KEEPTRACK_BAND_POLL_MS`), with a 30-second deadline per poll.
- Unit tests: 194 tests in six files, all passing (`claude plugin test plugins/keeptrack-repo-pane`).

### Fixed
- The band no longer shows "data error" for a Desktop session record whose git folder no longer exists: git's "not a repository" answer leaves that session out instead of counting as a git failure. "No GitHub remote" alone no longer raises "data error" in the band, which already says it in text.

### Migration needed
- No. This is the first public content; the mod was previously named github-repo-work-pane and has no users to migrate.
