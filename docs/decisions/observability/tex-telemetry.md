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
