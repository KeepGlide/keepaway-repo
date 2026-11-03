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
