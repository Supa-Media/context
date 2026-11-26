# The repository's test is canonical; a Context copy only adds a test (2026-11-26)

Narrows [A round runs the live setup, the live skills and the tests edited in
Context](./benchmarks.md) (2026-10-16).

**In Dev2's eval-wiring plan (2026-11-26:
"note that the repo copy is canonical"; "figure everything out" on harness
choices).** Test edits had moved to pull requests, and the Context copies
fell behind: on 2026-11-26 `@context-lc ai/tests/handback.md` held 18 cases
to the repository's 20 and `heartbeat.md` 11 to 12, so every pulled round
silently graded main on the older list, while `meeting-summaries.md` (4 to 2)
and `search.md` (67 to 59) held cases the repository never got. Those cases
were copied into the repository the same day. Now `pnpm ai pull` writes
`ai/tests/<name>.md` only when the repository has no `tests/<name>.md`
(`attention` and `bug-reports` still come from Context alone), and names each
copy that differs, with both case counts, as a warning on the run
(`driftLine`). To change a test, change the repository's file.

**What a simplification would cost:** letting the Context copy win again
grades main's code on a list nobody reviewed and that can be behind the
repository's; failing the run on a drifted copy would turn every app edit
into a red nightly. Tests (`bench/test/context.test.mjs`): "pullSetups keeps
the repository's tests, pulls only tests Context alone has, and names each
copy that drifted", "a drifted copy names both case counts".
