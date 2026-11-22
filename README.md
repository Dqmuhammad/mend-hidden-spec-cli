# mend-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dqmuhammad/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies a unified diff (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, or text-editor tool calls as JSON to a tree of text files, finding the lines each edit names at the first of three matching tiers and changing every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or standard input when absent or `-`. `--format=unified|search-replace|v4a|json|auto` picks the format (auto-detected by default), `--check` previews without writing, and `--strict` matches lines exactly. Node 22, standard library only; `SPEC.md` is the whole contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zq30hw4j&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
