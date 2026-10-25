# Changelog

All notable changes to KeepTrack are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows
[SemVer](https://semver.org/); while the version is `0.y.z`, any release may change behavior.
The version in `plugins/keeptrack-repo-pane/.claude-plugin/plugin.json` is 0.2.0-beta.8.
Commit hashes name the change in `git log`.

## [Unreleased]

### Changed
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

### Fixed
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
