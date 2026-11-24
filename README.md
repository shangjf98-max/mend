# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shangjf98-max/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/shangjf98-max/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats — unified diffs (even with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text
files, to the specification in `SPEC.md`. It finds the lines an edit names even when the
model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone; nothing is installed. The working directory is
the root of the tree; `PATCH` is the patch file (or `-` / absent for standard input).

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto`
  (the default) detects it.
- `--check` does everything but write: the same output and exit code, no file created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Matching is tried at three tiers — exact, trailing whitespace ignored, leading and
trailing whitespace ignored — and a unified hunk takes the occurrence nearest its (often
wrong) line number. Exit 0 lists what changed (`A`/`D`/`M`/`R`); exit 1 lists every edit
that failed and changes nothing; exit 2 is a usage, patch, format or parse error.
`SPEC.md` is the whole contract.

## Check it

The kit's practice set (100 checks) runs with the starter's checker:

```sh
node check.ts ../program/generator/practice.json
```

Practice score: **1000** (100 of 100 passed).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
