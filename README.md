# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write to a tree of
text files. It is my entry for the [make.fun](https://make.fun) competition
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
($100, top 10 paid).

Models write edits in four formats, and `mend` reads all four to one written
specification, [`SPEC.md`](SPEC.md):

- a unified diff, often with wrong line numbers;
- `SEARCH/REPLACE` blocks;
- the V4A patch format;
- text-editor tool calls as JSON.

It finds the lines an edit names even when the model drifted their whitespace or
indentation (three matching tiers, exact, then trailing whitespace, then both
sides), and it changes every file or none: a failed edit changes nothing, the
edits after it still run, and when any edit failed no file is written at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a
move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: <k> of <n> edits`. Exit 2 prints one line for a usage,
missing-patch, format or parse error. Standard error is never part of the
result.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set; keep them.
- `runner.ts` — the kit's runner, as it is. In a trial it reads the checks from
  the env, runs `node main.ts` on each one in a fresh directory, and posts what
  it did.
- `check.ts` — the practice set on your own machine:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score.
- `SPEC.md` — the specification. The whole contract.
- `LICENSE` — MIT.

## Practice

The kit carries 100 public practice checks. Run them with `check.ts` (see
above); the entry scores 1000 on them.
