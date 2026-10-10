# Extension: a real three-way text merge in the plain-merge pool

Branch `feat/text-merge`. Browser port `4404`. Read `README.md` in this folder first.

## What it is

Compare view shows the same changes "merged by plain git" in a second repository. Today PM3
approximates git: a `replace` that no longer applies or a `write` whose base changed is counted as a
text conflict and skipped, and the page says "approximated". This extension merges each replayed change
with a real three-way line merge, as `git merge` does: a change conflicts only when both sides changed
overlapping lines, or added the same path with different content; otherwise it merges cleanly.

## The specification

`docs/spec/01-core.md` 11.7 (PM1 to PM7, PM3 in particular); `docs/spec/02-tidepool.md` pairs P4 and P5
(9.3) and their scenario rows; `docs/spec/03-floor.md` `plain.conflicts`, `plain.conflicts.tip` and the
word "approximated" (2.3, 3.6).

**Write the specification first.** Add PM3a to 11.7: the three-way merge (base, ours, theirs), what
counts as a conflict, how a merged file is written, and that with `features.text_merge` off PM3 holds as
before. Update the copy rows that say "approximated" so the page says it only while the switch is off.

## Before you build: one check

Find whether any of the 58 case vectors, or any scenario row, encodes PM3's approximation (for example
P5's count). If one does, the switch keeps it valid only while off; say so in your report. You may not
edit `docs/spec/premise-cases.json`.

## Stages

**Stage 1 (must).** A line-level diff and three-way merge in pure TypeScript under `src/core/plain/`
(no dependency; `src/core` stays synchronous and pure), with unit tests worked by hand from git's
documented diff3 behaviour: clean merges, overlapping edits, both sides adding one path, deletes, a
whole-file rewrite, CRLF. Then the replay of 11.7 uses it when `features.text_merge` is on, and
`plain.updated` counts and skips exactly the true conflicts. Acceptance: P4 is still a conflict; P5 and
the hero order 1 give the trees that real git gives for the same three versions (check with a scratch
repository and `git merge-file` in a test: `createScratchRepo` of `test/support/git.ts`).

## Paths

`src/core/plain/**`, `src/core/trunk/plain-apply.*`, `src/worker/trunk/plain-runner.*` if needed,
`test/tidepool/scenarios/**`, `test/integration/hero/**` for the plain trees, the Compare copy in
`src/copy/**`, `docs/spec/01-core.md` 11.7, `docs/spec/03-floor.md` for the copy rows, and the shared
files of `README.md`'s list.

## The lead's live checks

One canned hero run on `test` with the switch on: Compare view's right pool, its conflict count and its
tree against `git merge-file` on the same versions.
