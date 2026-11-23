# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a
unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Each format is read as `SPEC.md` says, and every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is absent or is `-`,
  the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the
  default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created,
  changed or deleted.
- `--strict` matches lines exactly.

`main.ts` is the whole tool: Node 22 and its standard library alone. `SPEC.md` is the specification.
`runner.ts` runs the checks of a trial, and `check.ts` runs the practice set on your own machine:

    node check.ts ../program/generator/practice.json

## Licence

MIT — see `LICENSE`.
