# Opus plans, Haiku drives: a routed turn may change model after its first rounds (2026-10-17)

**Decided by the owner (2026-10-17):** "for browser tasks we should make sure
opus is the brains but haiku is the driver, especially on driving the browser,
it will be much cheaper that way", and "in general, this is how it should
always be. Like, Opus does the thinking, Haiku executes the task, small level
thinking, like, oh, what element should I click, or how can I, you know,
summarize this thing, right? But Opus should be doing the broader strokes
thinking. And that should conserve tokens by a lot. Like, I feel like we
should have, like, a target percentage of, like, 20% Opus, 80% Haiku."

Until now a `think` pick ran the whole turn on the thinking model, so a website
job (a golden task) was ten rounds of Opus at about $0.10 to $0.13 an answer.
A setup with a router may now name `models.think_rounds` (`production.js`), a
whole number 1 to 9; without a router the file is refused, as `route_at` is.
When it is set and the router picked `think`, rounds 0 to `think_rounds - 1`
run on `think` (it reads the question, plans and makes the first calls) and
every later round runs on `main` (`src/agent/modelPlan.js`). A round whose tool
calls included a failure (a refusal, an unknown tool, a call that threw or
timed out) sends the next round back to `think` once: a driver that just hit a
wall is when the planner is worth paying for. A call the egress gate held for
the person's yes (`held: true`) is not a failure and never escalates; a call
refused because the turn is out of time does not either, since the next round
must answer anyway. Absent, a routed turn is exactly what it was.

- **A switch is the fallback's switch** (`turn.js` `switchTo`): the prompt is
  rebuilt for the model now answering (it is told which model it is), and the
  earlier rounds' thinking blocks are dropped; their words and tool calls stay.
  The fallback is now taken once a turn, and once taken the turn stays on it:
  a plan would otherwise send it back to the model that failed, and the
  fallback would loop.
- **A mixed turn is priced by model.** `runTurn` returns `usageByModel` beside
  the summed `usage`; `model` is the model that wrote the final answer (on an
  exhausted turn, the last one that ran). `/agent` and Try it meter one report
  per model (`meterParts`), the answering model last, with the router's
  decision tokens and the duration on that last report only. The benchmark
  world sums a text's reports, and `bench/report.mjs` prices a run model by
  model (`runPriceUsd`).
- **Each model round in the trace names its model**, and the turn log keeps it
  (`apps/convex/functions/agentTurns.ts`). Under each routed setup the result
  note's summary says `Think share: <setup> ran N of M model rounds (x%) and
  $a of $b model spend (y%) on <think>`, against the owner's target of about
  20%, so the loop can tune `think_rounds` from it.

**What a simplification would cost:** pricing a mixed turn at the answering
model's rate makes a planned turn look like all-Haiku (cheaper than it is) or
all-Opus (dearer), which is the comparison the loop exists to make; a plan
that ignored failures leaves Haiku stuck at the wall it cannot see past; a
held call counted as a failure would pay Opus for every approval; letting the
plan outlive the fallback loops a turn whose main model is down. **Known costs,
measured by the benchmark rather than assumed:** the planner's thinking does
not reach the driver (only what it wrote and called), so a plan that lives
only in thinking is lost; every switch starts a new prompt cache (caches are
per model, and the history changes as thinking is dropped); `effort` and
`think_effort` still apply per model.

Tests (`apps/mcp/test/agentThinkRounds.test.mjs`, `bench/test/world.test.mjs`,
`bench/test/report.test.mjs`, `apps/convex/__tests__/agentTurns.test.ts`):
"without think_rounds, a text routed to think stays on think for the whole
turn, as before", "think_rounds 1: round 0 plans on think, every later round
drives on main", "a failed call sends the next round to think, once, then main
drives again", "a call held for the person's yes does not escalate", "the
switch drops the planner's thinking and re-tells the model who it is",
"per-model usage adds up to the turn's total, and the meter gets one report per
model", "the fallback still takes over mid-plan, and the turn stays on it",
"parseSetup refuses think_rounds without a router, or that is not a whole
number 1 to 9", "a planned setup's turn records each model's rounds and spend,
and the answering model", "a planned setup is priced model by model, and the
summary says the think model's share of rounds and spend", "each model round
keeps the model that ran it, so a planned turn shows its Opus and Haiku
rounds".

## A planner without a router: jobs plan on Opus (2026-10-31)

**Approved by the owner (2026-10-31)**, from the review of Tex's slowdown: the
production setup moved to Haiku answering every text with Opus as its advisor
and dropped the router (`haiku-advisor`), so no setup named a thinking model
and every part of every background job ran on Haiku. A Mercor job was called
done on a promise. The owner's split is still the rule: Opus plans, Haiku
carries it out, about 20/80, and jobs and judgment run on Opus.

A setup may now name `models.think` with `models.think_rounds` and **no**
router (`production.js` `planner`). Then a turn already marked `planned` (a
background job's turn, or a texted spreadsheet; `route.js`) plans on `think`
for `think_rounds` rounds and drives on `main`, with the same escalation after
a failed call; every other text stays on `main` with no router step, an
opinion text included, because in this shape judgment on an ordinary text is
the advisor's (`advisor.js`), not a whole-turn switch. `think_rounds` is
required here: a bare `think` with no router would put whole jobs on Opus, so
the file is refused. `turnRouter` (`modelPlan.js`) builds either a router or
this planner (`jobsOnly`, never a decision engine) for `/agent` and Try it.

**What a simplification would cost:** treating `think` without a router as a
router again would send pushback texts to Opus and slow the replies the front
door made fast; dropping the required `think_rounds` lets one missing line put
every job round on Opus at about ten times Haiku's price.

Tests (`apps/mcp/test/agentJobPlanner.test.mjs`): "a job's turn plans on
think, then main drives", "an ordinary text stays on main", "an opinion text
stays on main too: it asks the advisor, not a planner", "parseSetup reads a
planner (think and think_rounds, no router), and refuses one without
think_rounds".
