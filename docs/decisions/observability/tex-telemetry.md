# Tex telemetry: every turn says where it came from and what it cost (2026-10-24)

On 2026-10-24 the owner asked for a dashboard of how Tex is doing: how many
texts it handles, what people ask it to do, tokens, spend, tool use, the
self-review scores ([self-review](../texting-assistant/self-review.md)), model
performance, frustration and how many texts a task takes, with filters to
slice any of them ("see what tasks people get frustrated with"). The approved
concept is a page of its own at tex.lc/admin, with an overview and an Explore
view whose filters are compact dropdowns, never rows of chips.

**The turn log is the base.** `agentTurns` already kept each `/agent` turn's
model, outcome, times, rounds and trace (`functions/agentTurns.ts`). It now
also keeps:

- `kind`: `one` (a person's own texts), `group`, `job`, `routine` or `app`,
  decided by the gateway from the route (`turnKind`, `apps/mcp/src/agent/turnLog.js`).
  `client` stays as it was for older readers; it called a group or a routine
  turn `app`.
- each model's own token counts, cache reads and writes included (`models`),
  and the turn's list-price cost in millionths of a dollar (`costMicroUsd`),
  priced in the control plane from `MODEL_USD_PER_MTOK` (`lib/jev/meter.ts`),
  never by the gateway.

**Opus and Sonnet are priced.** Before this, the price table had no row for
`anthropic/claude-opus-5-5` or `anthropic/claude-sonnet-5-5`, so the meter
priced a planned turn's thinking rounds at GLM's rates, a fiftieth of their
list price or less, and the AI costs tab under-reported Tex. Anthropic's list
prices, 2026-10-24: Opus $4 / $20 per million in and out, $0.20 cache reads,
$5 cache writes; Sonnet $2 / $10, $0.20, $2.50.

**Still names and numbers.** The row's shape is pinned by validators; a model
name must look like one, a usage list is at most four models, and anything the
gateway sends that the handler does not know is dropped before the mutation.

What a simplification would cost: pricing in the gateway would put a second
price table beside the meter's, and the two would drift; dropping `kind` would
put group chats and routines back under `app`. `__tests__/agentTurns.test.ts`
("priced at its own list price") fails if the Opus row goes.

## What a conversation was for, and what frustrated them (step 2)

The self-review (`texReviewScores`, [self-review](../texting-assistant/self-review.md))
is where a whole conversation is judged, so it is where the dashboard's slices
live. The same Haiku call that scores it now also names:

- `task`: what it was mainly for, one code from `TASK_CODES` (email, calendar,
  web_errand, notes, research, reminders, messaging, purchase, setup, chat,
  other);
- `signals`: what showed frustration, codes from `SIGNAL_CODES` (repeated,
  try_again, cant_first, gave_up, swore, corrected, fix_this);

and the gateway adds `texts`, how many texts the person sent. The control
plane adds `who` (`staff`, `new` for an account under a week old, `other`) and
what the conversation's turns cost and whether any ran on the thinking tier,
read from the grant's newest `texts` turns of the last day
(`conversationSpend`, `functions/texReviews.ts`).

**Codes on the anonymous row, never words, never on the turn rows.** The row
still names nobody. Putting the task on `agentTurns` instead would tie a
person's workspace to what they asked for. A code outside the closed sets is
dropped in the gateway and again in the route, and never costs the scores.

**Time of day is not a slice.** Nothing knows the person's local time when the
review runs, and UTC hours would mislead; it waits until it can be done right.

What a simplification would cost: free-text categories would leak what people
asked for into an anonymous table. `__tests__/controlPlane/texReviews.test.ts`
("a review keeps what it was for…") fails if the spend reads another grant's
turns, and "a scores row names nobody" pins the row's keys.

## The dashboard is its own page: tex.lc/admin (step 3)

The dashboard is a page of its own at tex.lc/admin, not a tab in the staff
console: a first cut shipped as a console tab and the owner rejected it the
same day ("an entirely new page, not another tab within the admin page").
tex.lc serves the same app as context.lc, so `/admin` decides by host
(`app/(app)/admin/index.tsx`, as `/` does in `features/home/RootScreen.tsx`):
on tex.lc it draws `features/tex/dashboard/TexDashboard.web.tsx`, on
context.lc it is still the console's redirect to Growth. It sits under
`(app)` so the session gate applies, and `texReport` is staff only on the
server (`requireAdmin`); the page asks `amIAdmin` only to say "Staff only"
kindly instead of drawing an error.

It follows the approved concept: a dark hero with texts, spend, typical answer
time, frustration and the goal score, each with a sparkline; how conversations
feel; frustration by day and what set it off; texts to finish; model
performance; texts and spend by day; tasks and tools; what needs a look; and
Explore. `texReport` (`functions/lib/adminFns/texReport.ts`) sends the
window's turn figures already summed, the model performance read from each
turn's trace (`texPerformance.ts`: rounds, failures, retries, running out of
room, fallbacks, round and answer times, the router's thinking share), and the
window's scored conversations as rows. Like tex.lc's other pages it is plain
web markup with one stylesheet in tex.lc's own look (paper, a Libron
headline, Instrument Sans, Tex blue as the one accent; the owner asked for
"our context/tex style" over the first cut's dark-slate concept), its colours
in `features/design/tokens/texDashboardColors.ts`.

**Day by day comes first.** Under the headline numbers, every figure is a line
with one point per day and the change from the day before
(`features/tex/dashboard/trends.ts`), with a Task dropdown for the
conversation figures, because the owner's question is whether a bad day gets
better the next (2026-10-24). A day with nothing to measure is a gap, never a
zero.

**Spend is what Cloudflare billed.** Every model call goes through the AI
gateway with a `feature`/`client` label, and the gateway prices each one
itself, cache reads and writes at their own rates, keeping the cost per day,
model and label in its analytics even though no words are logged.
`functions/texSpend.ts` (staff only) reads those for Tex's labels
(`lib/adminFns/texSpend.ts`), never asking for the workspace label, with the
test suites' `benchmark` label counted apart. Cloudflare answers at most about
a month per question and keeps about two, so a 90-day window is asked in
30-day pieces from the oldest day it keeps, and earlier days are blank, not
free. It is the whole account, staging included. Our own estimate from token
counts (`agentTurns.costMicroUsd`) stays beside it as a check and stands in
when the analytics token is not set. On 2026-10-24 the two differed by about
10x over a week, because the estimate began that day and never saw side calls.

**Explore slices on the page.** The rows are anonymous codes and numbers, a
few thousand at most, so every filter, measure and rows-by-columns table is
computed in the browser (`features/tex/dashboard/model.ts`) rather than as a
query per slice. Filters are dropdown menus, one button per field, never rows
of chips (the owner, 2026-10-24). A cell under three conversations is drawn
faint. Tapping a task card filters Explore to it.

What a simplification would cost: folding it back into the console is the
thing the owner rejected; a query per slice would make every change of filter
a round trip and need an index per field. `__tests__/texDashboardRender.test.ts`
fails if tex.lc/admin stops drawing the page, if the Task dropdown stops
narrowing the table, if the report is asked for before the staff check, or if
spend stops being the billed figure; `apps/convex/__tests__/texSpend.test.ts`
fails if anything but Tex's labels is counted or a window is asked in one
question Cloudflare refuses.
