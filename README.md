<div align="center">

<img src="assets/keeptrack-cover-1600x400.png" alt="KeepTrack: Your repo's work, beside the chat." width="100%" />

# 🧭 KeepTrack

[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-blue.svg)](README.md) [![🇧🇷 Português (Brasil)](https://img.shields.io/badge/%F0%9F%87%A7%F0%9F%87%B7-Portugu%C3%AAs%20(Brasil)-green.svg)](README.pt-BR.md)

**A Claude Code Desktop mod for people who run several sessions on one GitHub repository. It shows which issue each session works on, and what the repository is doing right now.**

[![Version](https://img.shields.io/badge/version-0.2.0--beta.5-2BB8AE.svg)](CHANGELOG.md) [![License: MIT](https://img.shields.io/badge/license-MIT-1E2A47.svg)](LICENSE) ![Platform](https://img.shields.io/badge/Claude%20Code%20Desktop-mod-1E2A47.svg)

[Installation](#-installation) · [Usage](#-usage) · [Changelog](CHANGELOG.md) · [Report a bug](https://github.com/KeepGlide/keeptrack/issues/new) · [Security](SECURITY.md)

</div>

<details>
<summary><strong>📑 Contents</strong></summary>

- [📌 Status](#-status)
- [💡 Why it exists](#-why-it-exists)
- [🎁 What it delivers](#-what-it-delivers)
- [📸 Screenshots](#-screenshots)
- [⚙️ How it works](#%EF%B8%8F-how-it-works)
- [📋 Prerequisites](#-prerequisites)
- [🚀 Installation](#-installation)
- [🤖 Install with an AI agent (spec)](#-install-with-an-ai-agent-spec)
- [🔄 Updating](#-updating)
- [🧹 Uninstall](#-uninstall)
- [🧭 Usage](#-usage)
- [🎛️ Configuration](#%EF%B8%8F-configuration)
- [📚 Documentation](#-documentation)
- [🔒 Security and privacy](#-security-and-privacy)
- [🩺 Troubleshooting](#-troubleshooting)
- [🐞 Known issues](#-known-issues)
- [🧪 Tests](#-tests)
- [🔧 Development](#-development)
- [🌿 Branching and releases](#-branching-and-releases)
- [📝 Changelog](#-changelog)
- [🤝 Contributing](#-contributing)
- [🧑‍🔧 Maintainer](#-maintainer)
- [📄 License](#-license)

</details>

## 📌 Status

Beta (`0.2.0-beta.5`). The project follows [SemVer](https://semver.org/): while the version is `0.y.z`, any release may change behavior without notice.

## 💡 Why it exists

When one repository has several Desktop sessions open at once, each session shows only its own conversation. Nothing tells you which session works on which issue, which issues no session touches, or whether a session is waiting for you. KeepTrack reads that information from GitHub and from this machine, and draws it in two places: a pane and a band above the prompt.

It is for one person on one machine: it reads that machine's session records.

It does **not** change anything on GitHub or in your repository. It does not track time, store reports, or sync between machines.

## 🎁 What it delivers

- **`/keeptrack`** opens the pane (`/keeptrack open` does the same). `/keeptrack issue <n>` sets the issue of this window, `/keeptrack issue none` clears it, and `/keeptrack lang en|pt-BR|auto` sets the language.
- **This window first**: the session of the window with its issue's details and timeline.
- **Nested sessions**: the other Desktop sessions of the same repository, under their parent when they are derived (fork or spawn). Each session title links to its Desktop session.
- **Open issues by milestone**: the open issues that no session works on, grouped by open milestone, with the milestone progress.
- **A band above the prompt** with the state of this window: running or idle, the current tool or MCP server with its icon, the number of agents, the elapsed time, a waiting-for-you state, a data-error state, the milestone progress and the issue number.
- **An Open button** on the band, with the KeepGlide mark before it (the mark shows on Desktop only).
- **English and Brazilian Portuguese** in the pane and the band.

## 📸 Screenshots

> [!NOTE]
> **Design mocks, not captures.** The two images below are the approved design mock of the session-first layout (light and dark), not screenshots of the running Desktop app. Real captures of the band and the pane come with the next release.

| Light | Dark |
|---|---|
| ![KeepTrack pane and band, light design mock](docs/screenshots/keeptrack-session-first-light.jpg) | ![KeepTrack pane and band, dark design mock](docs/screenshots/keeptrack-session-first-dark.jpg) |

## ⚙️ How it works

```mermaid
flowchart LR
    GH[GitHub via gh: milestones, issues, PRs] --> POLL
    GIT[Local git: remote, branch, log] --> POLL
    REC[Desktop session records] --> POLL
    ASK[Askaway question folder] --> POLL
    POLL[Poll every 60 s open, 5 min closed, 30 s deadline] --> SNAP[Snapshot in one atom]
    SNAP --> PANE[Pane: /keeptrack]
    SNAP --> BAND[Band above the prompt]
```

The main round trip of one poll:

```mermaid
sequenceDiagram
    participant T as Timer
    participant K as KeepTrack
    participant G as gh and git
    participant D as Desktop records
    T->>K: tick at the cadence of the open flag
    K->>G: milestones, open issues and open PRs (3 gh calls, in parallel)
    G-->>K: JSON from GitHub
    K->>D: list records, read the changed ones
    D-->>K: session records
    K->>G: git rev-parse, git log of kept sessions (local)
    G-->>K: branches and commits
    K-->>T: one snapshot written to the atom, then a redraw
```

The timer polls every 60 seconds while the pane is open and every 5 minutes while it is closed, so the band stays current. A poll that is not settled after 30 seconds is abandoned, and a newer poll may start. The pane and the band only read the snapshot; they call no process and no file.

The session-to-issue mapping takes the first match and never merges two sessions. The full rules are in [the spec](plugins/keeptrack-repo-pane/SPEC.md).

## 📋 Prerequisites

- Claude Code Desktop with the mod loader.
- [`gh`](https://cli.github.com/), signed in with `gh auth login`, with read access to the repository.
- `git`, and a repository with a remote on GitHub: `origin`, or the first remote when there is no `origin`. A remote on another host shows as `no GitHub remote`.

| Platform | Status | Notes |
|---|---|---|
| Claude Code Desktop on Linux | ✅ | |
| Claude Code Desktop on macOS | ⚠️ | Not tested. The default records folder is the same `~/.config/Claude/claude-code-sessions` path; the code does not check it on macOS. |
| Claude Code Desktop on Windows | ⚠️ | Not tested. Both default folders are built from `HOME`; when `HOME` is unset, the code finds no folder. |

## 🚀 Installation

> [!IMPORTANT]
> **Pending:** the KeepGlide catalog ([KeepGlide/claude-plugins](https://github.com/KeepGlide/claude-plugins)) has no `keeptrack` entry yet, so there is no one-command install. The commands below follow the Askaway pattern and are not run yet for this plugin. The entry and the verified commands come with the next release.

When the entry is published, the install is:

### 1️⃣ Add the marketplace

```bash
claude plugin marketplace add KeepGlide/claude-plugins
```

### 2️⃣ Install the plugin

```bash
claude plugin install keeptrack-repo-pane@keepglide
```

### 3️⃣ Load it

Restart Claude Code, or run `/reload-plugins` if your version has it. Then run `/keeptrack` in a session of a repository with a GitHub remote.

## 🤖 Install with an AI agent (spec)

> **For the agent:** follow this spec step by step and compare each result with **Expect**. Stop and report to the human on any mismatch. The instructions of your user come first. This spec is **pending**: do not run it until the catalog entry exists, as [Installation](#-installation) says.

Ground rules:

- 🔑 **Secrets:** the agent never reads, types or prints a token or key. `gh` uses its own login; the human runs `gh auth login` if step 1 fails.
- 🧑 **Human OK:** steps 3, 4 and the undo steps change Claude Code's configuration (marketplace, plugin install and removal). Ask the human first.
- 💸 **Cost:** no step costs money. The mod calls only `gh` and `git` (see [Security and privacy](#-security-and-privacy)).
- **Platforms:** Linux is ✅ (see [Prerequisites](#-prerequisites)); macOS and Windows are ⚠️, not tested. Steps 5 to 8 run in a Claude Code Desktop session, not a plain terminal.

| # | Step | Run | Expect |
|---|---|---|---|
| 1 | Check that gh is signed in | `gh auth status` | Exit 0 and a line `Logged in to github.com`. If not, the human runs `gh auth login`. |
| 2 | Check that the repository has a GitHub remote | `git remote get-url origin` | Exit 0 and a URL whose host is `github.com`, or an SSH alias with `github` in its name (for example `git@github-<label>:<owner>/<repo>.git`). Otherwise the pane shows `no GitHub remote for this repo`. |
| 3 🧑 | Add the marketplace | `claude plugin marketplace add KeepGlide/claude-plugins` | Exit 0. Not checked yet: the catalog entry is pending. |
| 4 🧑 | Install the plugin | `claude plugin install keeptrack-repo-pane@keepglide` | Exit 0. Not checked yet: the catalog entry is pending. |
| 5 | Check that the command is registered | In a Desktop session, `/keeptrack bogus` | A toast with the usage line `Usage: /keeptrack open \| issue <n> \| issue none \| lang en\|pt-BR\|auto` (`hooks/i18n.ts:28`). Nothing changes. |
| 6 | Open the pane | `/keeptrack` | A pane titled `KeepTrack` opens. It shows `Loading the repo...`, then the open issues by milestone, or an error line from [Troubleshooting](#-troubleshooting). |
| 7 | Switch the language to Portuguese | `/keeptrack lang pt-BR` | The pane and the band switch to Portuguese. While loading, the pane shows `Carregando o repo...` (`hooks/i18n.ts:96`). |
| 8 | Return to the automatic language | `/keeptrack lang auto` | The stored choice is removed. The language follows the first set variable of `LC_ALL`, `LC_MESSAGES`, `LANG` or `LANGUAGE`: `pt*` gives Portuguese, anything else gives English. |
| 9 | Check that gh reads the repository | `gh issue list -R <owner>/<repo> --state open --limit 1 --json number` | Exit 0 and a JSON array: `[]` or `[{"number":<n>}]`. |
| 10 | Hand back | none | Report to the human the result of each step, the output of step 9 and any skipped step. No token is printed. |

✅ **Done when:** steps 1, 2 and 9 match; steps 5 to 8 match in a Desktop session; steps 3 and 4 match once the catalog entry exists.

**Report:** the result of each step, the output of step 9, and every skipped step with its reason.

**Undo** (🧑 the human decides):

1. Run `/keeptrack lang auto` and `/keeptrack issue none` in each window where they were used.
2. Run `claude plugin uninstall keeptrack-repo-pane@keepglide`.
3. Run `claude plugin marketplace remove keepglide` only if no other plugin uses that marketplace.

## 🔄 Updating

> [!NOTE]
> Pending like the install: the update command below exists in the Claude Code CLI, but it has not been run against the catalog entry yet.

```bash
claude plugin update keeptrack-repo-pane@keepglide
```

Restart Claude Code, or run `/reload-plugins`, after an update, as after an install.

## 🧹 Uninstall

```bash
claude plugin uninstall keeptrack-repo-pane@keepglide
```

Restart Claude Code, or run `/reload-plugins`, afterwards. What the mod leaves behind:

| Item | Where | After uninstall |
|---|---|---|
| Plugin code and hooks | Claude Code's plugin installation | Removed by `claude plugin uninstall`. |
| Stored language (`lang`) and window issues (`override:<session id>`) | The mod's store in Claude Code | Stay. The mod has no step that deletes them. Overrides expire after 30 days, or earlier when no session record lists their session. To clear the language first, run `/keeptrack lang auto`. |
| Session records and the Askaway folder | `~/.config/Claude/claude-code-sessions` and `~/.claude/state/askaway` | Not touched. The mod only reads them. |
| GitHub and the repository | GitHub and your working tree | Not touched. The mod writes nothing there. |

## 🧭 Usage

| Command | What it does |
|---|---|
| `/keeptrack` or `/keeptrack open` | Opens the pane. It polls at once when the snapshot is older than one interval. The band's Open button does the same. |
| `/keeptrack issue <n>` | Sets the issue of this window, from 1 to 999999. Stored per session as `override:<session id>` for 30 days. Only a Desktop session can set it; any other window gets a toast. |
| `/keeptrack issue none` | Clears the issue of this window. |
| `/keeptrack lang en\|pt-BR\|auto` | Stores the language (case does not matter) and switches it at once. `auto` removes the stored choice and follows the environment. |
| Any other argument | A toast with the usage line. Nothing changes. |

## 🎛️ Configuration

| Name | Default | Effect |
|---|---|---|
| `KEEPTRACK_POLL_MS` | `60000` | Poll interval while the pane is open. A value below 1000, or one that is not a whole number, is ignored and the default is used. |
| `KEEPTRACK_BAND_POLL_MS` | `300000` | Poll interval while the pane is closed. Same rule as `KEEPTRACK_POLL_MS`. |
| `KEEPTRACK_DESKTOP_SESSIONS` | `$HOME/.config/Claude/claude-code-sessions` | Session records folder that is read (read only). Set for tests. |
| `ASKAWAY_HOME` | `$HOME/.claude/state/askaway` | Askaway state folder whose questions are read (read only). |
| `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE` | unset | Language when no choice is stored: the first one that is set decides. `pt*` gives Portuguese; anything else gives English. A stored `/keeptrack lang` choice always wins. |

Both default folders are built from `HOME`. When `HOME` is unset, the mod finds no records folder.

Fixed in the code, not configurable:

| Setting | Value | Where |
|---|---|---|
| Poll deadline | 30 s | `POLL_DEADLINE_MS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:73` |
| Band redraw tick | 30 s | `BAND_TICK_MS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:48` |
| gh call timeout | 15 s | `GH_TIMEOUT_MS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:55` |
| git call timeout | 5 s | `GIT_TIMEOUT_MS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:56` |
| Open issues per poll | 500 | `ISSUE_LIMIT`, `plugins/keeptrack-repo-pane/hooks/register.tsx:60` |
| Open pull requests per poll | 100 | `PR_LIMIT`, `plugins/keeptrack-repo-pane/hooks/register.tsx:61` |
| Session cutoff | 72 h | `SESSION_CUTOFF_MS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:54` |
| Issue override lifetime | 30 days | `OVERRIDE_TTL_MS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:78` |
| Abandoned polls allowed at once | 2 | `MAX_ABANDONED_POLLS`, `plugins/keeptrack-repo-pane/hooks/register.tsx:76` |
| Working-state window | 5 min after the last activity | `WORKING_WINDOW_MS`, `plugins/keeptrack-repo-pane/hooks/model.ts:27` |

## 📚 Documentation

- [SPEC.md](plugins/keeptrack-repo-pane/SPEC.md): what the code does now, and where it differs from the design record.
- [CONTRIBUTING.md](CONTRIBUTING.md): the repository layout and the test protocol.
- [CHANGELOG.md](CHANGELOG.md): every change, by version.

## 🔒 Security and privacy

- **What leaves the machine:** only `gh` calls to GitHub, to read milestones, open issues, open pull requests and one issue's details. There are no paid calls and no calls to other services.
- **What is read locally:** the git remote, branch and log of the repository and of its sessions, the Desktop session records, and the Askaway question folder (`ASKAWAY_HOME`, or `~/.claude/state/askaway`).
- **What is written:** only the state of the mod (the open flag, the language and the issue set by `/keeptrack issue`). Nothing is written to GitHub or to the repository.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `claude plugin install keeptrack-repo-pane@keepglide` finds no plugin | The catalog entry is not published yet (see [Installation](#-installation)). | Wait for the entry. |
| `gh not found: showing sessions only` | `gh` cannot start (not installed, or not on the path Claude Code sees). | Install [`gh`](https://cli.github.com/) and check it with `gh --version`. |
| `gh is not signed in` | `gh` exits with a login message. | Run `gh auth login`. The next poll uses it (60 s with the pane open, 5 min closed). |
| `GitHub rate limit: showing the last data` | GitHub's API rate limit was reached. | Wait. The last data stays on screen until a poll succeeds. |
| `GitHub did not answer in time` | A `gh` call ran longer than 15 s. | Check the network, and run the failing call by hand. The next poll retries. |
| `GitHub did not answer as expected: showing the last data` | A `gh` call failed without a known cause, or its output could not be read. | Run `gh issue list -R <owner>/<repo> --state open` by hand to see the error. |
| `no GitHub remote for this repo` | The repository has no remote on GitHub. | Check `git remote -v`. The remote must point to `github.com`, or to an SSH alias with `github` in its name. |
| `list is partial (first 500)` (or `first 100`) | The repository has more open issues (or pull requests) than one poll reads. | None in the mod. The list is partial by design. |
| `{count} session records could not be read` | A records file did not parse, or a text field is over 4096 characters. | The bad record is skipped and the other sessions are shown. |
| `git failed in this folder · sessions shown without branch` | `git` failed in a session's folder. | Check that the folder exists and that `git status` works there. |
| `This window is not a Desktop session: nothing to set` | `/keeptrack issue` ran in a window with no Desktop record. | Run it in a Desktop session window. |
| The pane stays on `Loading the repo...` | The first poll has not settled, or was abandoned after 30 s. | Wait one poll. The mod logs `poll skipped` when two abandoned polls are still running, and then starts nothing until one ends. |

## 🐞 Known issues

No known open issues as of 2026-10-21. Found one? [Open an issue](https://github.com/KeepGlide/keeptrack/issues/new).

Known limitations, as the code does them today:

- **A merged pull request does not link its issue.** Only open pull requests are queried, so an issue whose PR was merged does not show that PR. Workaround: `/keeptrack issue <n>` in the window sets the issue by hand.
- **Archived sessions are not shown as live.** An archived session is not shown as a live session, even when its branch has an open PR; an archived parent of a shown session is drawn as an idle ancestor. The window's own session is the exception. Workaround: none.
- **Checks always read `no CI`.** The mod reads the check rollup of open pull requests, but the Checks line always reads `no CI` because the issue details do not pass it through (register.tsx:926). The KeepGlide repositories run no GitHub Actions. Workaround: none.
- **The working state is a heuristic.** A session counts as working for 5 minutes after its last activity, so the band can lag the real state. Workaround: none.
- **Only GitHub remotes count.** A remote on another host shows as `no GitHub remote`. Workaround: none.
- **Lists are capped per poll.** 500 open issues and 100 open pull requests are read; past that the pane shows `list is partial`. Workaround: none.

## 🧪 Tests

| Category | Tests |
|---|---|
| Rules: remote parsing, session tree, issue groups, timelines, record projection (`tests/model.test.ts`) | 60 |
| Hooks module: poll, pane command, timers and close (`tests/register.test.ts`) | 61 |
| Band: status line, states and Open button (`tests/band.test.ts`) | 36 |
| Pane: snapshot drawing (`tests/pane.test.ts`) | 23 |
| Language: English and pt-BR dictionaries (`tests/i18n.test.ts`) | 8 |
| Turn transitions of the band (`tests/turn.test.ts`) | 6 |
| **Total** | **194** |

Counts from `claude plugin test plugins/keeptrack-repo-pane` (194 pass, 0 fail), run again on 2026-10-21 at commit `1787401`.

## 🔧 Development

From the repository root, validate the manifest, hooks and types:

```bash
claude plugin validate plugins/keeptrack-repo-pane
```

Run the tests:

```bash
claude plugin test plugins/keeptrack-repo-pane
```

Run the look check, which fails on any hex colour, colour function or emoji in the drawn code:

```bash
bash plugins/keeptrack-repo-pane/scripts/keeptrack-look-check.sh
```

The layout of the repository and the test protocol are in [CONTRIBUTING.md](CONTRIBUTING.md).

## 🌿 Branching and releases

`main` is the only long-lived branch. Make each change on a short branch from `main`, keep it small, run the tests, and open a pull request. Releases are SemVer tags on `main`, each with its entry in [CHANGELOG.md](CHANGELOG.md). No GitHub Release is published yet.

## 📝 Changelog

The changes of each version are in [CHANGELOG.md](CHANGELOG.md), in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The project follows SemVer.

## 🤝 Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## 🧑‍🔧 Maintainer

Sophia Phillipa (KeepGlide), [keepglide.com](https://keepglide.com).

## 📄 License

MIT. Copyright (c) 2026 Sophia Phillipa (KeepGlide). SPDX identifier: `MIT`. See [LICENSE](LICENSE).
