# The texting assistant — benchmarks, routing and resilience

Split out of [texting-assistant.md](../texting-assistant.md) on 2026-10-09 when it grew past the review threshold. How a setup earns its way to people: the throwaway world the benchmark runs in, the router that picks a model per text, the voice the test grades, and what a turn does when its provider is busy or down.

### Setups are benchmarked in a throwaway world, on invented workspaces

Decided by the owner, 2026-10-08: a setup earns its way into the production
note by answering a test, and the test never sees a customer's notes. The
benchmark data (invented people, workspaces, questions, results) is plain
Markdown in `@context-lc` `ai/`; its README is the process.
`pnpm ai run <job> --dir <folder>` (`apps/mcp/bench/`) runs the real gateway
in process over the in-memory control plane and store the tests use: each
invented workspace is its own bucket with a real `privacy.md`, each invented
person a texting grant covering exactly the workspaces `people.md` gives them,
and the setup is written where the product reads it. Writes are read back as a
list of changes and never applied; the only traffic that leaves is the model
call, with the runner's own keys. Judging is a separate step any agent can do,
recorded under the judge's name.

**What a simplification would cost:** a runner that called the model with the
notes pasted in would score a setup that leaks a held-back note as one that
answers well; a world that could reach the network could text a real person.
The tests that fail are in `apps/mcp/bench/test/world.test.mjs` ("a member
never reads a note the workspace holds back", "the world lets no request out
except the model's").

**The world runs with the deployed search budget, and says which calls failed.**
The first run (2026-10-08) measured nothing: the world had no
`SEARCH_SUBREQUEST_BUDGET`, so a search spent the free-tier 40 on a bucket scan
and every `read_note`, `list_notes` and `orient` after it in the same turn was
refused, which every setup reported as "I couldn't find that" or "the note
won't open". The world now sets the budget `wrangler.toml` sets, and a result
note names each tool call that failed and counts them per setup, so a run that
is broken reads as broken rather than as a bad model. Test: `world.test.mjs`,
"after a search, reads, listing and orient in the same turn still work".

**The benchmark pins its day.** Decided by the owner, 2026-10-08: a test names
`today`, the world's clock reads that day at noon UTC and runs on from there,
and every fixture note's modified time comes from its own front matter
(`updated`, else `date`, else the start of `dates`, else two months before
today), so "untouched for a month" and "this weekend" mean the same thing on
every run and a stale-project rule can be graded. Without a pin the run uses
the real clock and the result note says `today: real`. Tests: `world.test.mjs`
(the clock and the note ages), `load.test.mjs` (a bad `today` is refused by
name).

**Fixtures grow by fluff files, never by hand.** Decided by the owner,
2026-10-08: the hand-written workspaces stay small and readable in
`@context-lc`, and a `fluff.md` in any folder says what filler to generate
there (`count`, `seed`, `from` a template folder under `workspaces/_bank/`, a
`name` pattern, a date range) and which hand-written notes to copy as older,
dated distractors. The run expands them deterministically from the seed, so two
runs on different days write identical notes; a fluff file is never served as a
note, `_bank` is never a workspace, and a distractor copy of a held-back note
stays held back. `--no-fluff` runs the hand-written notes alone. Tests:
`bench/test/fluff.test.mjs`, `load.test.mjs` ("fluff.md never appears in
files", "a distractor copy of a held-back note is held back").

**The world starts warm.** Decided by the owner, 2026-10-08. A cold world has
no search index, so every search is a bucket scan, which is the free-tier
first-minute of a fresh import and not the product people use. `pnpm ai run`
now warms every workspace once (`bench/warm.mjs`): each gets a search database
on the test suite's D1 stand-in, its owner searches it until the projection
reports nothing pending, and the bucket (index shards included) and the
database are snapshotted. Every conversation then starts from copies, so a
turn's write never reaches the next conversation and the first search is
answered from the index for a handful of store operations. `--cold` keeps the
old behaviour for the fresh-import case, and the result note says which
(`world: warm` or `cold`). Tests: `bench/test/warm.test.mjs` ("the first search
of a conversation is served from the index", "a turn's write in one
conversation never reaches the next", "a warmed world still holds back what the
workspace holds back").

**Judging is blind by construction.** Decided by the owner, 2026-10-08: any
model may judge, through the AI gateway or a chat connected to the MCP, so the
result note cannot be allowed to say who wrote an answer. The run names every
answer by a random four-word id and writes the id-to-setup key as a separate
file the judge never opens; the Answers section carries no setup name and
orders answers by id. `pnpm ai judge <result>` sends each answer with its
question's must, must-not, may and judge lines, never a setup or the key, and
appends a `## Judged by` section; `pnpm ai score <result>` joins the latest
judging to the key and appends per-setup scores, gates and the good-enough
bars. A privacy question counts only when its `mirror:` (the same fact asked by
someone allowed to see it) passed for that setup; otherwise it is untested, not
passed, because a setup that finds nothing looks perfectly private. Tests:
`bench/test/judge.test.mjs` (the judge payload names no setup),
`score.test.mjs` (mirror rule), `report.test.mjs` (ids, key).

**A judging says what it will cost before it spends, and spends as little as
the verdicts allow.** The first judging (2026-10-08) sent one request per
answer, 900 of them, to Claude Fable, with no estimate, no progress, nothing
saved until the end, and 150 of the answers were `model_unavailable` errors
with nothing to grade; the owner stopped it after about  of judge calls and
no verdicts written. Now: every answer to a question travels in one request
(50 for a 50-question run), answers the model never gave are recorded as
skipped without a call and fail their question in the score, the judge
defaults to Haiku, the request count and an estimate are printed first and a
judging over `--max-usd` (default ) is refused before the first call, each
question's verdicts are saved to a sidecar as they arrive so a stopped
judging resumes without paying twice, progress and spend are printed per
question, and four requests run at once. Tests: `judge.test.mjs` ("an answer
the model never gave is skipped, never sent to the judge", "a judging over
--max-usd is refused before any call", "a stopped judging resumes from its
sidecar"), `score.test.mjs` ("a run the judge skipped ... fails its question").


### A setup may route each text to a cheap or a smart model (2026-10-09)

**Decided by the owner (2026-10-09):** the next benchmark run compares a cheap
model on its own against the same cheap model with a "really smart" one
(Claude Opus 5.5) behind it for the texts that need real reasoning. A setup
therefore keeps `models.main` and may add `models.router` and `models.think`
(`src/agent/router.js`, `production.js`). Before the first round, the router
(Clef, the decision model `decide.js` already runs for the agent's computer)
reads the person's text and picks lookup, change or think; `think` runs the
whole turn on the thinking model, anything else on `main`. The pick, the
router's word and what it read are recorded in the turn's trace, the meter is
told the model that answered, and the benchmark's result note shows the pick
first on each answer's tools line and, under the summary, how many answers
each routed setup sent to its thinking model and at what price.
Whether a person can make an event is a `think` request: answering it may need
several commitments compared, even when the text is short. A plain request for
one appointment's time remains a lookup. Clef's low-confidence fallback still
uses `main`.

**Why Clef and not the cheap model, or a gateway route:** a model asked "do you
need help?" almost never says yes and the asking costs a whole round; a
gateway dynamic route (`dynamic/<name>`) never sees the text, so it can split
traffic and cap spend but cannot tell a lookup from a hard question. Clef
answers in tens of milliseconds for a fraction of a cent, stores nothing, and
its pick is a plain word that can be checked by hand.

**What a simplification would cost:** routing inside the prompt ("escalate when
unsure") is unmeasurable, since the result note cannot say which model
answered; pricing a routed run by the setup's main model would hide the whole
point. Tests (`apps/mcp/test/agentProduction.test.mjs`, `bench/test/world.test.mjs`,
`bench/test/report.test.mjs`): "a text the router calls think runs on the
thinking model, and the meter says so", "a low-confidence think, a word the
router does not know, or a failed router all stay on main", "a person's own key
is never routed", "a routed setup records the tier first on the tools line and
reports the model that answered".

### The router is tuned by shape and by a cutoff the setup sets, never by question (2026-10-10)

**Decided by the owner (2026-10-10):** after five rounds the cheap model's
misses were mostly one kind: it found one fact and stopped, where the answer
needed two put together (a deadline from a date, an order of events, a total,
something written in more than one notebook). The owner's direction was
"change the harness or routing to smarter models for some of these things",
and explicitly not prompt lines written for the test's questions: "we want a
general sense of intelligence here". So the two knobs are general:

- **Clef is told the shape.** The `think` criteria name a date worked out
  from another date, an order, a total or a comparison, and something that
  could sit in more than one notebook, as reasons to route; `lookup` says it
  is not a date that has to be worked out. No question's words appear.
- **The cutoff is the setup's.** `models.route_at` (0 to 1, three decimals at
  most, default 0.5, refused without a router) is the confidence a `think`
  pick needs; lower routes more texts to the thinking model. The router's
  confidence in a think pick rides the trace (`confidence`, a number) into the
  turn log whether or not it cleared the cutoff, so a benchmark's result note
  can say which questions a setup routed ("Routed: … questions 16, 27, 40 and
  53") and which think picks fell under its cutoff and at what confidence
  ("Said think but stayed on …"). The next setup's `route_at` is set from
  those near misses, not guessed. Two setups that differ only in `route_at`
  (`guide-haiku-opus`, `guide-haiku-opus-wide`) run side by side, and the price
  line says what the extra routed texts cost.

**What a simplification would cost:** a lower cutoff hard-coded in `router.js`
would change production with no round behind it, and a cutoff nobody can see
the near misses of is tuned blind. Prompt lines for the failing questions would
lift the score and nothing else. Tests (`apps/mcp/test/agentProduction.test.mjs`,
`bench/test/world.test.mjs`, `bench/test/report.test.mjs`,
`apps/convex/__tests__/agentTurns.test.ts`): "parseSetup reads the router's
cutoff, and refuses one outside 0 to 1 or without a router", "a think pick
under the default cutoff clears a setup's lower one, and the trace keeps the
confidence", "router tells Clef that a date worked out from another, an order
and a total are think questions", "a routed setup shows the router's
confidence, and a think pick under the cutoff as a near miss", "the routed
line names every routed question, and the think picks under the cutoff with
their confidence".

### The assistant texts like a capable friend, and the benchmark grades the voice (2026-10-09)

**Decided by the owner (2026-10-09):** "make sure that the text bot talks,
reacts, replies similarly to how Instinct does, very conversational and human
like", with a real Instinct thread as the reference. What that thread does,
distilled (the thread itself is personal and was not kept anywhere): short
replies in several bubbles, one idea each; the answer first, then at most a
line of context; what was done in a few words, never how or where; a caveat
in one clause; a real opinion in one line when asked; one clarifying question
at a time, then waiting; a draft shown before anything goes out; a reply that
ends on one next step or one question, never both; the person's own register,
contractions, an emoji only after theirs; a one-word reply where one word is
enough. Two Instinct habits do not transfer: a tapback reaction instead of
"got it" (Linq's client sends no reactions; `apps/agent/src/format.ts` has no
such path) and an "On it" text before slow work (a turn here is synchronous
and answers once).

**How it is held:** the setup prompt carries a "How you talk" section saying
the above (`@context-lc ai/setups/texting-assistant/guide-*`); the test file's
front matter gains `every_answer:`, a labelled map of judge lines graded on
every answer, and a `voice:` bar under `good_enough` (`bench/load.mjs`,
`bench/judge.mjs`, `bench/score.mjs`). The voice lines are judge lines: they
never pass or fail a question and never gate, so a setup cannot fail the
facts by being chatty or pass them by being terse. The share of voice lines
passed is the setup's voice, printed beside the judge-lines count and held to
the bar only when the test sets one. Nine conversational questions (a
greeting, thanks, an opinion, a clarifying question, a catch-up, an
emoji-toned ask, a correction, "are you a bot?", a short list) were added to
the test so the voice is measured on texts that have no fact to get right.

**What a simplification would cost:** grading voice inside each question's
must lines would make tone a pass or fail on facts, and every question would
carry the same five lines by hand; a voice bar that gates would let a chatty
but correct setup fail the run. Tests (`bench/test/load.test.mjs`,
`bench/test/judge.test.mjs`, `bench/test/score.test.mjs`): "parseTest reads
every_answer as a list of judge lines", "the test's every_answer lines reach
the judge as trailing judge lines on every question", "voice is the share of
judge lines passed; a voice bar holds a setup to it, and no bar only reports
it".

### A busy provider is retried, a failed one is replaced, and both are counted (2026-10-09)

**Decided by the owner (2026-10-09)**, reading round two of the benchmark:
29 of 708 answers were `model_unavailable`, every one a gateway or provider
status in a flaky window, and a person texting gets exactly the same. "We
should be retrying when possible, and when a fallback is used, since this is
the behaviour in production, it's all part of it: retries, the time, fallbacks
and everything. Note whenever a fallback is used and keep the reason."

**What it holds:**

- `aiGateway.js` sends a call once more after a short wait when the provider
  answered 429, 503 or 529, or the request never got through. A 400 or 500 is
  not retried (it would only fail twice) and a timed-out call is not either (it
  has spent the round's deadline). The answer says it was retried and after
  what status.
- A setup may name `models.fallback` (`production.js`): another model than
  `main`. When the model a turn is on fails after its retry, the turn goes on
  from the same messages on the fallback, once (`turn.js`); the trace records
  it with the status, the meter is told the model that answered, and the turn
  log keeps it. There is no second fallback.
- The turn log (`apps/convex/functions/agentTurns.ts`) takes `router` and
  `fallback` entries, a `retried` flag and a `status` on a `model` entry. Until
  this change a routed turn's report was refused whole by the log's validator,
  silently, because the router's entry was a kind it did not know. The wire
  shape carries kinds, names, numbers and flags: the router's own word and a
  provider's phrase stay in the worker's log line.
- `search` and `fetch`, ChatGPT's required pair, are withheld from the agent
  (`turn.js`), which has `search_notes` and `read_note`: a model offered both
  reached for `search` by its name and was refused 215 times in one run.
- The benchmark shows all of it: a retried round and a fallback on the tools
  line, the status beside an error, and "Retried:" and "Fell back:" lines under
  the summary, so a run says how often production would have waited or
  answered from the fallback, and the score says what those answers were worth.
  Retries and fallbacks count in an answer's time, because they are the
  person's time.
- The router's criteria (`router.js`) now call `think` anything that needs more
  than one place or one step: several notes or workspaces, a span of days, a
  judgement, an opinion, a change plus a message, a request that could mean two
  things. Round two routed 5 of 59 questions and missed the ones Haiku lost.

**What a simplification would cost:** a retry inside the turn loop would retry
a 500 and a timeout too, and would not know what it retried; a fallback chosen
by the gateway rather than the setup could not be benchmarked; dropping router
entries from the turn log to fit its validator would hide which tier a slow or
wrong answer came from, the reason the trace has the entry. Tests
(`test/agentGateway.test.mjs`, `test/agentFallback.test.mjs`,
`test/agentProduction.test.mjs`, `bench/test/world.test.mjs`,
`bench/test/report.test.mjs`, `apps/convex/__tests__/agentTurns.test.ts`): "a
529, a 503 or a 429 is retried once after a wait, and the answer says it was",
"a 400 or a 500 is not retried", "a main model that fails hands the turn to
the fallback, which answers, and the trace says so", "a fallback that fails too
is the end", "ChatGPT's search and fetch are never offered to the agent", "a
router's pick, a fallback and a retried round are kept with their status, and a
provider's words are not".

### The gate follows the lines, an error is not a run, and the bench has the web (2026-10-09)

**Decided by the owner (2026-10-09)**, going through round two's harness
faults one by one.

- **Plumbing writes are not changes.** The gateway rewrites `privacy.md` (and
  sometimes `activity.md`) on every save; the bench's diff of the bucket
  listed them as changes, and "must not change any other note" failed six
  change questions for every setup. `bench/world.mjs` skips them the way it
  skips dotfiles. A model that writes `index.md` or `todo.md` when it should
  not still shows.
- **The gate is derived, never asked.** A gate question (every privacy
  question, and a back-and-forth marked `gate:`) fails its gate when any of its
  must-not lines fails on an answered run (`bench/score.mjs`); the judge is no
  longer asked for a yes or no (`bench/judge.mjs`). Haiku's separate opinion
  had flagged answers with every line passed and missed "I'll text Ana". The
  owner's corollary: a must-not line on a gate question is kept for the dire
  things, a leak or a claim of having contacted someone; what is not dire on
  those questions became a must line in the test.
- **An error is not a run.** A run the model never answered is skipped by the
  judge and left out of the question, which is judged on its answered runs; a
  question with no answered run fails; the errors are a column of their own.
  The run command also reruns an errored answer once in a fresh world, after
  the gateway's retry and the setup's fallback have had their turn, and
  records the rerun with the error it replaced ("Reran after:", and a
  "Reran:" line under the summary). Round two's 29 errors cost
  guide-haiku-opus seven questions whose every answered run had passed.
- **The bench offers the web.** Production's texting assistant has
  `search_web` and `open_page` when the deployment holds a Brave key, so a
  texting-assistant run refuses to start without `BRAVE_SEARCH_API_KEY` (the
  owner: "this is an agent that should have access to the internet"), and the
  key reaches the world's environment. `--fake` runs without one. Web results
  vary between runs; none of the test's questions needs the web, so a web call
  on one is already a mark against the answer.

**What a simplification would cost:** keeping the judge's gate opinion would
keep a gate nobody can point at; failing a question on an error would keep
measuring the gateway's evening instead of the setup; running without the key
would keep measuring a tool list people do not get. Tests
(`bench/test/world.test.mjs`, `judge.test.mjs`, `score.test.mjs`,
`report.test.mjs`): "a write records the note written, never the privacy
manifest or activity log the gateway rewrites", "the judge is not asked for a
gate opinion", "a gate failure is a failed must-not line on a gate question",
"a run the model never answered is not a run", "an answer run again after an
error says so on its block, and the summary counts the reruns".

### The benchmark is a GitHub Action, and its fixtures live in the repository (2026-10-09)

**Decided by the owner (2026-10-09)**: "these tests should be a GitHub
Action that takes some parameters, that way anything that can run the GitHub
Actions can see it and see the results." Until then every round ran on the
owner's machine with keys from 1Password, handed to Codex by a written
prompt, with the result copied back by hand.

- **`ai-benchmark.yml`** is manual only (`workflow_dispatch`), in the
  production environment, which already held every key the bench needs but
  the Workers AI token (`CLOUDFLARE_AI_TOKEN`, now in the allowlist as
  optional: no deploy reads it). Inputs: job, setups, questions, runs,
  parallel, judge, `max_usd` (the judging's cap, default $1) and `fake`, which
  runs the whole pipeline on the scripted model and spends nothing. It runs,
  judges and scores, writes `pnpm ai summary` (the latest scores and the run's
  summary lines, never an answer or an id) to the run's summary page, and
  uploads the result and the key as two artifacts, the key on its own so a
  judge can be handed the result alone. No schedule: a schedule would spend
  money on nobody's say-so, and `check-workflow-triggers.mjs` keeps a branch
  from running it.
- **The fixtures moved into the repository**, at `apps/mcp/bench/ai/`
  (workspaces, tests, setups), which reverses the 2026-10-08 decision that
  they stay in `@context-lc`. A runner has no account, and the gateway has no
  machine credential by design (`oauth.js`: every connection is somebody's
  consent), so the folder the Action reads has to be one it can read without
  one. What stays in `@context-lc ai/` is what needs the product: the process
  README, the production files the gateway reads, the retired setups, and the
  results. `pnpm ai run`, `judge` and `score` default to the repository's
  folder when neither `--dir` nor `AI_BENCH_DIR` is set (`folder.mjs`).
  Everything in the folder is invented; it was already readable by every
  Context account, and the repository is public.
- **A judging that dies does not cost the round** (2026-10-10, after the
  first real Action round answered 708 conversations for about $7 and then
  died on "judge reply for question 32 is not JSON"). The judge asks a
  question again, up to three times, when the reply is not JSON, is cut off
  at `max_tokens`, or has the wrong shape (`JUDGE_ATTEMPTS`); and the Action
  takes a `judge_run_id`: it downloads that run's result, key and, when the
  judging stopped partway, its sidecar of verdicts, and judges and scores
  without answering again. The sidecar is uploaded as `benchmark-judging`
  only when a judging stopped, so the resume never pays for a verdict twice.
- **The judge's reply is typed by the API, not parsed from prose**
  (2026-10-10, the owner: "that wouldn't happen if we were using a type-safe
  AI"). The judge request carries `output_config.format` with a JSON schema
  (`JUDGE_SCHEMA`), so the model's reply is that shape or the call fails as a
  call; the three attempts remain for the failures a schema cannot rule out
  (a cut-off at `max_tokens`, a missing answer id). The judge runs eight
  requests at once and the Action answers in twelve processes by default:
  both wait on models, not on the runner.
- **A decision model is measured against the judge before it is trusted
  with anything** (2026-10-10, the owner: Clef or Jev as the judge "just to
  see the effect and the cost"). `pnpm ai calibrate` puts every answer of a
  judged result to a decision model, one yes-or-no per check, and reports
  agreement overall, by kind and by line, with the tokens read and the price;
  the Action runs it with `calibrate` and `judge_run_id`. Nothing is written
  to the result and nothing is scored by it. The judging of record stays
  Haiku's until a calibration says a decision model agrees with it on a kind
  of check, and then only for that kind.
- A round's result and key still belong in `@context-lc ai/results/`, copied
  from the artifacts by whoever reads the round; a benchmark-runner OAuth
  client with a stored refresh token would close that last hop and is the
  identity-and-access work to do if copying by hand turns out to be the
  bother the Action was meant to end.

**What a simplification would cost:** adding a schedule or a branch trigger
would spend the plan's credit, or run an unreviewed prompt with production's
keys, with nobody asking; reading the fixtures from `@context-lc` instead
would need a credential the gateway deliberately does not mint; writing
answers to the summary page would put a judge's input where a judge might
read it. Tests (`bench/test/folder.test.mjs`, `summary.test.mjs`): "--dir
wins, then AI_BENCH_DIR, then the repository's bench/ai", "the repository's
folder exists, loads, and holds the texting-assistant test and setups", "the
summary carries the latest scores and the run's summary lines, and nothing
else"; and `scripts/check-workflow-triggers.mjs` and
`check-secrets-allowlist.mjs` on every pull request.
