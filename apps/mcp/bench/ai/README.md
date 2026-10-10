# The benchmark folder

What `pnpm ai run` reads: the invented people and workspaces, and the tests.
The setups a round compares live in Context, in `@context-lc ai/setups/<job>/`,
beside the production files the gateway reads, and `pnpm ai pull <job>` brings
them here before a run (decided 2026-10-10: a setup is what a person edits and
promotes, so it lives where they can see it; a workspace or a question list
changes in the same commit as the code, so it lives here).

Everything here is invented. No customer note, name or address is ever in
this folder: it is public, like the rest of the repository.

- `workspaces/`: nine workspaces and `people.md`, which says who belongs to
  which. A `fluff.md` in a folder describes filler notes the run generates
  from `workspaces/_bank/`.
- `tests/<job>.md`: the questions, who asks them, what a good answer does, and
  the `every_answer` lines graded on every answer. `tests/search.md` is the
  search job: each question is one `search_notes` call and names the notes
  that should come back (`expect:`), scored with no judge (`pnpm ai search`).
- `setups/<job>/`: written by `pnpm ai pull <job>` and ignored by git. A
  setup is the complete package (model, settings, prompt) in the production
  file's format; a `setups/search/` file is a search setup: `job: search` and
  a `search:` section (`everywhere`, `min_score`, `extra_notes`,
  `snippet_chars`), the same section a texting setup may carry to search its
  way. Retired setups stay in `@context-lc ai/setups/retired/`.
- `results/`: written by a run and ignored by git. The Action uploads the
  result and the key as artifacts and writes the scores to
  `@context-lc ai/results/` (`pnpm ai publish`).

The runner's sign-in (`pnpm ai connect`, once, by a person; `pnpm ai signin`
from `BENCH_RUNNER_*` in the environment) is described in `bench/context.mjs`.
How a run, a judging and a score work: `@context-lc ai/README.md`, and
`docs/decisions/texting-assistant/benchmarks.md` in this repository.
