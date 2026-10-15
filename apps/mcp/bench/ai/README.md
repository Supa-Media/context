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
- `tests/tasks.md`: the golden tasks (decided 2026-10-11), jobs the texting
  assistant must always get right: connect ChatGPT or Claude to Context, sign
  in to a site, save a login, find something on a site, set up a website,
  buy or connect its domain. Run it with
  `--test tasks`. Every task is a gate, and its `must call`, `must reach`,
  `must hand off`, `must type`, `must choose`, `must set`, `must publish`, `must connect` and `must write` lines are checked
  from the run's record (`bench/checks.mjs`), not by the judge.
- `tests/core.md`: the core set (decided by the owner 2026-10-14), fifteen
  basics Tex must do, each a gate like a golden task: a lookup, two facts, a
  lookup across workspaces, a missing fact, a to-do list, a write, a tick-off,
  a correction, a greeting, "are you a bot", a web lookup, connecting ChatGPT,
  saving a login, a one-off reminder and a weekday routine. It is what
  `pnpm ai run texting-assistant` and the Action run when no test is named;
  `--test texting-assistant` (59 questions) and `--test tasks` are the long
  sets, kept for rounds. Its `must write: maya/tex/routines/once/ with at:
  2026-10-09 9:00 am` lines are checked from the run's record too: a note
  written at that path (under it when it ends in `/`) with that front matter.
- `sites/`: the scripted web a test with `web: scripted` runs on, one file per
  site (`bench/sites.mjs` says the format). Invented sites use `.example`.
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
