# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats, and `mend` reads all of them to one specification (`SPEC.md` in the kit's starter):

- a unified diff, often with wrong line numbers;
- SEARCH/REPLACE blocks;
- the V4A patch format;
- text-editor tool calls as JSON.

Each format is read as the specification says, and every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is absent
  or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` when the tree is written (one line per changed path, then `ok: <n> files`);
`1` when an edit failed (one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, and no file is written); `2` on a usage, no-patch, format or parse
error.

## Matching

An edit's old lines are found in the file at the first of three tiers at which they occur:
exact, then ignoring trailing spaces and tabs, then ignoring leading and trailing spaces and
tabs. A unified hunk takes the occurrence nearest its (possibly wrong) line number; a
SEARCH/REPLACE block fails as ambiguous when its old lines occur more than once; a V4A chunk
takes the first occurrence at or after its cursor, or at the anchor it names. Context lines are
always written as the file's own lines, and at the loosest tier new lines are re-indented to the
file's indentation. CRLF files keep their line breaks; files without a final line break keep
that, unless a hunk runs to the end of the file.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env and
  runs `main.ts` on each one.
- `check.ts`: the practice set on your own machine: `node check.ts ../program/generator/practice.json`
- `LICENSE`: MIT.

## Checks

    node check.ts <practice.json>

The kit's 100 public practice checks pass: `100 of 100 passed: practice score 1000`.
A local trial against the kit's env server scores the same: `score 1000 working 1 passed 100`
(unified 30, search_replace 20, v4a 20, json 15, cli 15).

## Entry

Built for [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on make.fun — $100, top 10 paid.
