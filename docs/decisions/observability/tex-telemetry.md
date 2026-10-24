# Tex telemetry: every turn says where it came from and what it cost (2026-10-24)

On 2026-10-24 the owner asked for a dashboard of how Tex is doing: how many
texts it handles, what people ask it to do, tokens, spend, tool use, the
self-review scores ([self-review](../texting-assistant/self-review.md)), model
performance, frustration and how many texts a task takes, with filters to
slice any of them ("see what tasks people get frustrated with"). The approved
concept is a staff console tab with an overview and an Explore view whose
filters are compact dropdowns, never rows of chips.

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

## The Tex tab (step 3)

The staff console's Tex tab (`apps/mobile/features/admin/TexSection.tsx`) is
the dashboard: texts handled by where they came from, spend by day and by
model, tools, the scorecard, what frustrates people by task, and Explore.
`texReport` (`functions/lib/adminFns/texReport.ts`) sends the window's turn
figures already summed, and the window's scored conversations as rows.

**Explore slices on the page.** The rows are anonymous codes and numbers, a
few thousand at most, so every filter, measure and rows-by-columns table is
computed in the browser (`features/admin/tex.ts`) rather than as a query per
slice. Filters are dropdown menus, one button per field, never rows of chips
(the owner, 2026-10-24). A cell under three conversations is drawn faint.

What a simplification would cost: a query per slice would make every change of
filter a round trip and need an index per field. `__tests__/adminTexRender.test.ts`
fails if the Task dropdown stops narrowing the table.
