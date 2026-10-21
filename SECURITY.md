# Security policy

## Supported versions

KeepTrack is pre-stable (`0.y.z`). Fixes land on the latest `0.2.0` beta.

| Version | Supported |
| ------- | --------- |
| `0.2.0-beta.5` (latest `0.2.0` beta) | ✅ |
| Older `0.2.0` betas | ❌ |

## Reporting a vulnerability

Do not open a public issue or pull request for a vulnerability. Report it privately to the owner, Sophia Phillipa (KeepGlide), through GitHub's private vulnerability reporting on [KeepGlide/keeptrack](https://github.com/KeepGlide/keeptrack/security). Include the affected version, the steps to reproduce and the impact you expect.

> Pending: private vulnerability reporting is not enabled on the repository yet. Until it is, report privately to the owner through the contact on [keepglide.com](https://keepglide.com).

## Response time

We acknowledge a report within 7 days and aim to publish a fix or a mitigation within 30 days, depending on severity.

## What the mod reads

- `gh` calls to GitHub: milestones, open issues, open pull requests and one issue's details. The calls use the account of the local `gh` login.
- Local git: the remote, the branch and the log of the repository and of its sessions.
- Local Desktop session records, and the Askaway question folder (`ASKAWAY_HOME`, or `~/.claude/state/askaway`).

The mod writes only its own state (the open flag, the language and the issue set by the command). It makes no network calls of its own and writes nothing to GitHub.
