# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree
of files: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON. `SPEC.md` is the whole specification. The checks that
score it are drawn after the deadline from a pool nobody outside the house has seen; the practice
checks are public.

This entry is built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format" — see [make.fun](https://make.fun).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory; when it is absent or
  is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Every file is changed or nothing is: when any edit fails, no file is written, and the failures are
reported one line per failed edit.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
  It reads all four patch formats, finds the lines each edit names at the first of three matching
  tiers (exact, trailing whitespace ignored, leading and trailing whitespace ignored), and writes
  every change or none. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is
  set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts`
  on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the
  files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It
passes when the exit code, everything written to stdout and every file afterwards are exactly what
SPEC.md says. stderr is never compared, so write what you like there. Each run has 10 seconds; the
whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and
indentation, blank context lines without their leading space, prose and code fences around the
patch, CRLF files, files without a final line break, blocks that occur twice. Read SPEC.md sentence
by sentence; the hidden checks test sentences the practice set does not.
