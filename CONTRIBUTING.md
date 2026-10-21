# Contributing to KeepTrack

Thanks for helping. In short: branch from `main`, keep the change small, run the test suite, and open a pull request.

## Run the tests

From the repository root:

```bash
claude plugin test plugins/keeptrack-repo-pane
```

The look gate checks that the drawn code has no hex colour, colour function or emoji:

```bash
bash plugins/keeptrack-repo-pane/scripts/keeptrack-look-check.sh
```

## Layout

| Path | Contents |
|---|---|
| `plugins/keeptrack-repo-pane/` | The mod: manifest, hooks, scripts, tests and the spec. |
| `plugins/keeptrack-repo-pane/SPEC.md` | The spec of what the code does now, and where it differs from the design record. |
| `assets/` | The KeepTrack icon. |
| `docs/screenshots/` | The images both READMEs show. |

## Rules for changes

- Code, identifiers, comments and file names are in English. The README has a pt-BR twin, and both change in the same commit.
- Every user-facing change updates `CHANGELOG.md` under `[Unreleased]`, and the tests table in both READMEs.
- GitHub Actions is off for this repository. Do not add `.github/workflows/`.
