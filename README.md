# mend: one patch tool for every AI edit format

Entry for the make.fun bounty **"Build mend, one patch tool for every AI edit
format"** — https://make.fun/bounty/hidden-spec-cli-01-run-20261122
($100, 10 places × $10; ends Tue 24 Nov 2026 21:00 WIB / 14:00 UTC).

`mend` is a command-line tool that applies AI-written edits in four formats —
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches and JSON text-editor tool calls — to a tree of text files, following
`SPEC.md` exactly. Every file changes, or none does.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`. Implements all of `SPEC.md`: the command
  line (`--format`, `--check`, `--strict`, `--`, patch file or stdin), the
  output and exit codes (2 usage/no-patch/format/parse, 1 per-edit failures,
  0 with `A`/`D`/`M`/`R` rows), safe paths, format detection, the four
  formats, matching at three tiers (exact, trailing whitespace, leading and
  trailing whitespace, with tier-2 re-indentation), CRLF files, files without
  a final line break, and the all-or-nothing write.
- `runner.ts` — the kit's runner, unchanged. In a trial it reads the checks
  from the env and runs `main.ts` on each one. `main.ts` hands over to it
  when `MAKEFUN_ENV_URL` is set.
- `check.ts` — the practice set on your own machine (the kit's, unchanged).
- `SPEC.md` — the specification (version 1), as shipped in the kit.
- `LICENSE` — MIT.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). Absent, or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Tests

Practice set from the kit (`program/generator/practice.json`, 100 checks:
30 unified, 20 search_replace, 20 v4a, 15 json, 15 cli), run with the
grader's runtime, Node 22.23.4:

    node check.ts /path/to/practice.json
    100 of 100 passed: practice score 1000

The run was repeated and is deterministic. The same subset also passes on
the machine's system Node 24.

On top of the practice set, 43 extra edge cases derived from sentences of
`SPEC.md` that the practice set does not show were written and run
(`\` after a `-` vs a `+` line, creation without a final line break,
insertion at end of file with and without a final break, rename-only moves,
`/dev/null` creation/deletion, move-to-existing, explicit `--format` with a
mismatched patch, path inheritance between SEARCH/REPLACE blocks, empty
creates, V4A pure moves, V4A sections with no chunk, anchors that do not
match, body lines after `*** End of File`, overlapping JSON matches, CLI
usage errors, unsafe paths, several failures in patch order, CRLF
insertion): **43 of 43 passed**.

## Status

Local files only. Nothing here has been submitted to make.fun, no GitHub
repository has been created for this entry, no Solana wallet has been
connected, and no fee has been paid. Submitting would additionally need a
public GitHub repository (created after the competition opened, OSI licence),
the AI-session transcripts bundle, and a linked Solana wallet to sign the
entry — none of that is in this directory.

## Known limits

- The scored pool (300 checks, drawn after the deadline) includes kinds of
  check the practice set does not show; the entry follows `SPEC.md`
  sentence by sentence, but a sentence whose wording admits two readings
  (for example how strictly a `diff --git` line must be formed, or a second
  `---`/`+++` pair in one section header) can only be settled by the hidden
  checks.
- The house baseline is a strict (tier-0-only) applier; a reward needs a
  mean score strictly above it on the 3 scored instances.
