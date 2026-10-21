# Changelog

All notable changes to KeepTrack are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows
[SemVer](https://semver.org/); while the version is `0.y.z`, any release may change behavior.
The version in `plugins/keeptrack-repo-pane/.claude-plugin/plugin.json` is 0.2.0-beta.5.
Commit hashes name the change in `git log`.

## [Unreleased]

### Changed
- The README pair now follows the KeepGlide README standard: centred banner and header, static badges, a contents block, a platform table, a full AI install spec, Updating and Uninstall sections, Troubleshooting and Known issues. No code change.

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
