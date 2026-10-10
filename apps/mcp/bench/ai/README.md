# The benchmark folder

What `pnpm ai run` reads: the invented people and workspaces, the tests, and
the setups the next run compares. Copied here from `@context-lc ai/` on
2026-10-09 so the GitHub Action can run a benchmark with nothing to fetch;
from that day this folder is the canonical copy and `@context-lc ai/` keeps
the process (`README.md`), the production files the gateway reads, and the
results.

Everything here is invented. No customer note, name or address is ever in
this folder: it is public, like the rest of the repository.

- `workspaces/`: nine workspaces and `people.md`, which says who belongs to
  which. A `fluff.md` in a folder describes filler notes the run generates
  from `workspaces/_bank/`.
- `tests/<job>.md`: the questions, who asks them, what a good answer does, and
  the `every_answer` lines graded on every answer. `tests/search.md` is the
  search job: each question is one `search_notes` call and names the notes
  that should come back (`expect:`), scored with no judge (`pnpm ai search`).
- `setups/<job>/`: the complete packages (model, settings, prompt) the next run
  compares. Retired setups stay in `@context-lc ai/setups/retired/`. A
  `setups/search/` file is a search setup: `job: search` and a `search:`
  section (`everywhere`, `min_score`, `extra_notes`, `snippet_chars`), the
  same section a texting setup may carry to search its way.
- `results/`: written by a run and ignored by git. A run's result and key go
  to `@context-lc ai/results/`.

How a run, a judging and a score work: `@context-lc ai/README.md`, and
`docs/decisions/texting-assistant/benchmarks.md` in this repository.
