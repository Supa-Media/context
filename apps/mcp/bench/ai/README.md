# The benchmark folder

What `pnpm ai run` reads: the invented people and workspaces, and the tests.
The setups a round compares live in Context, in `@context-lc ai/setups/<job>/`,
beside the production files the gateway reads, and `pnpm ai pull <job>` brings
them here before a run (decided 2026-10-10: a setup is what a person edits and
promotes, so it lives where they can see it; a workspace or a question list
changes in the same commit as the code, so it lives here).
Since 2026-10-16 it also brings the live setup (`ai/production/<job>.md`, run
as `production`), the live skills, and any test edited in `@context-lc
ai/tests/`, which replaces the test of the same name here
(`docs/decisions/texting-assistant/benchmarks.md`).

Everything here is invented. No customer note, name or address is ever in
this folder: it is public, like the rest of the repository.

- `workspaces/`: nine workspaces and `people.md`, which says who belongs to
  which. A `fluff.md` in a folder describes filler notes the run generates
  from `workspaces/_bank/`.
- `tests/<job>.md`: the questions, who asks them, what a good answer does, and
  the `every_answer` lines graded on every answer. `tests/search.md` is the
  search job: each question is one `search_notes` call and names the notes
  that should come back (`expect:`), scored with no judge (`pnpm ai search`).
- `tests/dream.md`, `tests/meeting-summaries.md`, `tests/meeting-transcription.md`
  and `tests/connected-ais.md` (2026-10-17): one very simple case each for the
  jobs that are one call, not a conversation, run with `pnpm ai check <job>`
  (`bench/check.mjs`). A case names the notes to place (`- note:` and a fenced
  block), its input (`- input:` and a fenced block), and words that must or
  must not come out; no judge. Fenced blocks keep their own headings.
- `tests/tasks.md`: the golden tasks (decided 2026-10-11), jobs the texting
  assistant must always get right: connect ChatGPT or Claude to Context, sign
  in to a site, save a login, find something on a site, set up a website,
  buy or connect its domain. Run it with
  `--test tasks`. Every task is a gate, and its `must call`, `must reach`,
  `must hand off`, `must type`, `must choose`, `must set`, `must publish`, `must connect` and `must write` lines are checked
  from the run's record (`bench/checks.mjs`), not by the judge.
- `tests/core.md`: the core set (decided by the owner 2026-10-14, reshaped
  2026-10-17), nineteen basics Tex must do, each a gate like a golden task: a
  lookup, two facts, a lookup across workspaces, a missing fact, a to-do list,
  a write, a tick-off, a correction, a greeting, "are you a bot", a one-off
  reminder, a weekday routine, a privacy question with its mirror, a request
  to contact someone else, an opinion, a date range, a vague ask and an
  emoji-toned ask. It is what `pnpm ai run texting-assistant` and the Action
  run when no test is named; `--test tasks` runs the golden tasks for a full
  round. The long set of 59 questions was retired on 2026-10-17. Its `must
  write: maya/tex/routines/once/ with at: 2026-10-09 9:00 am` lines are
  checked from the run's record too: a note written at that path (under it
  when it ends in `/`) with that front matter.
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

A case an AI drafted carries `- drafted: <who>` under its heading. `pnpm ai run` skips it, naming it on stderr, until a person has checked it and removed that line, so a drafted case never reaches a score. A scored result ends its `## Scored by` section with a `### Case by case` table (one row per question, one column per setup), placed after the setup table so a reader of the first table never takes a case for a setup.

The runner's sign-in (`pnpm ai connect`, once, by a person; `pnpm ai signin`
from `BENCH_RUNNER_*` in the environment) is described in `bench/context.mjs`.
How a run, a judging and a score work: `@context-lc ai/README.md`, and
`docs/decisions/texting-assistant/benchmarks.md` in this repository.
