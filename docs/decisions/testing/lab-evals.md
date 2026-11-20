# Public benchmarks test Context as a memory, not Tex

Decided by the owner, 2026-11-20: the Lab gets an **Evals** tab of public
benchmarks, LongMemEval first ("create an evals tab one of them being the
LongMemEval, and build out the adapter for this eval"). The first build ran
LongMemEval's histories through Tex's test chat; the owner corrected it the
same hour: "LongMemEval is primarily for context, its not supposed to test
tex". Of the ways a past session could reach Context, the owner chose **save
each session raw, then file** over a client that writes back as it chats
(which is a model turn per past session, far dearer) and over doing both.

## The rule

- **One question, one empty workspace.** Each question runs in its own
  throwaway bench world (`apps/mcp/bench/world.mjs`): the real gateway Worker
  in the process, over the in-memory control plane and buckets, one person,
  an empty personal workspace. Nothing a question saves reaches another.
- **Sessions are saved raw, at their own time.** Every past session is saved
  through the endpoint's own `write` `save_session`, as an AI client saves one,
  with the whole visible transcript, the clock set back to the session's date
  (`atEarlierTime`), so each note is dated when it happened. This is the input
  a memory layer gets in the published Mem0 and Zep numbers, so the score
  compares.
- **Context files it the way it files a person's.** Housekeeping
  (`src/agent/housekeeping.js`, PARA organizing) runs a bounded number of
  times across the history (4 by default, the last just before the question),
  not on a calendar: one question's history spans weeks to years, and each
  filing run is a model turn.
- **The world searches as production does.** Each question's workspace starts
  warm (`warm.mjs` `prepareRun`): an empty search database and meaning index,
  so every save is indexed whole and by meaning. A cold bench world searches
  by a budgeted scan and a note's first 2,048 characters, which no person's
  Context uses; the first 50-question slice (2026-11-20, 60%) ran cold, and
  replaying its misses' own searches offline found 32 of their 44 answer
  sessions warm against 25 cold.
- **A fresh reader answers with the endpoint only.** A new client (Haiku 5.5
  by default) gets the endpoint's own `initialize` instructions, its tools
  and the question's date, and nothing else; it searches and reads as any
  connected client does. Its answer is everything it said in the turn, as
  the person reads it: an answer followed by a write-back and "I saved that"
  is graded on the answer, not on the save notice.
- **LongMemEval grades with its own prompts.** The judge (Sonnet 5.5 by
  default) gets LongMemEval's `evaluate_qa.py` template for the question's
  type, word for word, and a verdict is right when it says yes. Scores are
  reported per ability (extraction, multi-session, temporal, knowledge
  update, abstention) and per question type.
- **The same n is the same slice.** `sliceOf` stratifies by type (abstention
  apart) and orders by hash, so two runs of one size are the same questions
  and a larger slice holds a smaller one.
- **Runs go to GitHub like Lab runs.** A run is a `labEvalRuns` row
  (`apps/convex/functions/labEvals.ts`) that dispatches
  `.github/workflows/lab-eval-run.yml` on main with `GH_ADMIN_TOKEN`. The
  workflow downloads the dataset from Hugging Face (cached), runs
  `apps/mcp/bench/evals/cli.mjs` on main's code or a same-repository pull
  request's or branch's, on the AI gateway or Claude Code, and reports rows in
  batches and the summary with the deploy key. Each run's cost is priced per
  phase (filing, reading, judging), with the whole benchmark's cost estimated
  from it. A Claude Code run costs no dollars and is never shown as $0: it
  reports its measured tokens (the CLI's own usage per call, summed by
  `evals/ccUsage.mjs`) and the share of the subscription's weekly limit it
  used, read from Claude Code's usage before and after the run (the account's
  figure, so other use meanwhile is in it; no percentage, with the reason,
  when the read is refused) (Dev2, 2026-11-20).
- **Runs start only when asked.** An agent builds and fixes the eval, but
  starts a run only when the owner asks for that run (Dev2, 2026-11-20): a
  Claude Code run spends the shared weekly limit.
- **Lab = MCP.** `tex_dev` `evals`, `eval_run` and `eval_remove` do all the
  tab does.
- **Public data only, and never a gate.** A row holds the benchmark's own
  question and answer and the reader's reply. Evals never read or write the
  Training, Dev or Test sets, and nothing here gates CI.

## What a simplification would cost

Running the histories through Tex again measures Tex's chat history, not the
product people connect. Writing every session into one shared workspace lets
one question's sessions answer another's. Scoring with a judge prompt of our
own makes the number incomparable with every published LongMemEval result.

## The test that fails

`apps/mcp/bench/test/longMemEval.test.mjs` (the slice, the judge's templates,
filing times, one question end to end through a real world) and
`apps/convex/__tests__/controlPlane/labEvals.test.ts` (who may start one, the
caps, the dispatch, the reports).

## Not built yet

The bench world keeps notes in buckets, not in a workspace object; a later
run should move it onto objects as production has. Filing sorts sessions
into folders but pulls no facts out of them, as Mem0 and Zep do at ingest.
