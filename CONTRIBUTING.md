# Contributing to KeepAway Repo

Thanks for helping. In short: branch from `main`, keep the change small, run the test suite, and open a pull request.

## Run the tests

From the repository root:

```bash
claude plugin test plugins/keepaway-repo
```

The look gate checks that the drawn code has no hex colour, colour function or emoji (`action-icons.ts` is exempt from the emoji check only):

```bash
bash plugins/keepaway-repo/scripts/keepaway-look-check.sh
```

The version check fails, and names each place, when a version string differs from the version in `plugins/keepaway-repo/.claude-plugin/plugin.json`: the marketplace entry, the README badge, Status and Tests lines (both languages), the CHANGELOG header and its top released entry, and the supported version in SECURITY.md. Run it before a release. Its self-check plants a mismatch in a copy and expects a failure:

```bash
bash plugins/keepaway-repo/scripts/keepaway-version-check.sh
bash plugins/keepaway-repo/scripts/keepaway-version-selftest.sh
```

The docs check fails, and names each place, when the Security and privacy sections of both READMEs and SECURITY.md leave out a binary the hooks run (parsed from their source) or a model call. Its self-check plants a new binary and removes a named one in copies and expects a failure:

```bash
bash plugins/keepaway-repo/scripts/keepaway-docs-check.sh
bash plugins/keepaway-repo/scripts/keepaway-docs-selftest.sh
```

## Layout

| Path | Contents |
|---|---|
| `plugins/keepaway-repo/` | The mod: manifest, hooks, scripts, tests and the spec. |
| `plugins/keepaway-repo/SPEC.md` | The spec of what the code does now, and where it differs from the design record. |
| `assets/` | The KeepAway Repo icon. |
| `docs/screenshots/` | The images both READMEs show. |

## Rules for changes

- Code, identifiers, comments and file names are in English. The README has a pt-BR twin, and both change in the same commit.
- Every user-facing change updates `CHANGELOG.md` under `[Unreleased]`, and the tests table in both READMEs.
- GitHub Actions is off for this repository. Do not add `.github/workflows/`.

## Changelog and release

- Every `CHANGELOG.md` bullet opens with a bold feature name in plain words, for example `- **Timeline markers**: ...`.
- The public text of a bullet has no `SPEC-` ids, no `#issue` numbers, no milestone names and no file paths. The keepglide.com feed takes plain text only: no backticks and no URLs.
- Use one of the sections `Added`, `Changed`, `Fixed`, `Security`, `Performance` or `Documentation`.
- Release step: before the release, run the version check (see Run the tests). After the release, run the site exporter, `scripts/publish-changelogs.mjs` in `sophia-phillipa/keepglide-web`. Nothing is published until the beta ships.
