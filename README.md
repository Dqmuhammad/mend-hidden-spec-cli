# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads them all: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Each format is read exactly as `SPEC.md` says, and every file is
changed or nothing is.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly.
- `PATCH` is the path of the patch file, relative to the working directory. When
  it is absent or `-`, the patch is read from standard input.

Matching is tolerant the way model output is sloppy: a hunk's old lines are found
at the first of three tiers (exact, trailing whitespace ignored, leading and
trailing whitespace ignored, with re-indentation), at the occurrence nearest the
hunk's stated line number. A SEARCH/REPLACE block must match exactly once.
A V4A chunk follows an anchor and a cursor. JSON `str_replace` matches exactly
once, with CRLF files normalised before the match and restored after it.

Failures are reported per edit (`no-match`, `ambiguous`, `missing`, `exists`,
`unsafe`) and the patch is all or nothing: when any edit failed, no file is
written. `SPEC.md` is the whole specification.

Built for [make.fun](https://make.fun) — an entry for the "Build mend, one patch
tool for every AI edit format" bounty.
