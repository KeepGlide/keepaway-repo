# Security policy

## Supported versions

KeepAway Repo is pre-stable (`0.y.z`). Fixes land on the latest `0.2.0` beta.

| Version | Supported |
| ------- | --------- |
| `0.2.0-beta.26` (latest `0.2.0` beta) | ✅ |
| Older `0.2.0` betas | ❌ |

## Reporting a vulnerability

Do not open a public issue or pull request for a vulnerability. Report it privately to the owner, Sophia Phillipa (KeepGlide), through GitHub's private vulnerability reporting on [KeepGlide/keepaway-repo](https://github.com/KeepGlide/keepaway-repo/security). Include the affected version, the steps to reproduce and the impact you expect.

> Pending: private vulnerability reporting is not enabled on the repository yet. Until it is, report privately to the owner through the contact on [keepglide.com](https://keepglide.com).

## Response time

We acknowledge a report within 7 days and aim to publish a fix or a mitigation within 30 days, depending on severity.

## What the mod reads, sends and stores

The full list is in the README's [Security and privacy](README.md#-security-and-privacy) section (the [pt-BR](README.pt-BR.md#-segurança-e-privacidade) version mirrors it).

- **Sends:** `gh` calls to GitHub, with the account of the local `gh` login; `glab` calls to GitLab for GitLab repos; a `curl` download of a repo's avatar over https; and paid Haiku model calls for session summary lines and step explanations. The model calls are on by default and stop with `/keepaway summary off`.
- **Reads:** the git remote, branch and log of the repository and its sessions; Desktop session records and the Desktop config (sidebar Groups only); session transcripts under `~/.claude/projects/`; a checkout's logo files.
- **Stores:** only the mod's own state in its store, never the repository: the issue override, the language, the summary and legend and timeline flags, the newest one-line summaries and step explanations, and the logo lookup records. The prompt itself is never stored.

The mod writes nothing to GitHub or to the repository.
