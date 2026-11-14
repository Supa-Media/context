# AI costs are read from Cloudflare's count, by step and by who paid (2026-11-14)

Dev2 asked (2026-11-14, comments 3 and 4 on the staff console redesign) for the console's AI costs page to split
Tex's replies by step (front door, advisor, reply reviewer, Clef's decide and the rest, as `texConfig.json` names
them) and to show who paid: the dev and dev2 Anthropic credits with what is left of each, the Claude plan's credit,
and what came out of pocket through Cloudflare's Unified Billing.

## Where the numbers come from

- **One source, Cloudflare's own count.** `consoleAi.costs` (`apps/convex/functions/lib/adminFns/consoleCosts.ts`)
  asks AI Gateway's analytics for the window and the window before it, grouped by the labels every call already
  carries (`feature`, `client`) and by `wholesale` (1 when Unified Billing paid). `metadataValue(key: ...)` is a
  groupable dimension, so no per-request log is kept or read: calls still say `cf-aig-collect-log: false`. Workers
  AI (Clef, GLM, bge-m3, Whisper) is priced from its neurons, as the older AI costs check did.
- **Steps from labels.** `consoleCostsMap.ts` maps a call's feature, client and model to a `texConfig.json` step id:
  a texted turn on Haiku is the front door, `advisor` the advisor, `job-check` the job check, `reviewer` the reply
  reviewer, `threads` the classifier, and so on; Clef is Decide and GLM the fallback. A background job's calls look
  like the front door's to the gateway, so their share comes from our own meter (`agentTurns` of kind `job`) and is
  moved off the front door. A test fails when the step list drifts from `texConfig.json`.
- **Who paid from a `payer` label.** Every gateway attempt now carries a fifth label, `payer`: the stored key's
  alias, `plan` for the plan's key, or `cloudflare` for the keyless attempt (`attemptMetadataHeader`,
  `apps/mcp/src/agent/aiGateway.js`). A caller's own labels are capped at four so it is never dropped. Calls from
  before the label are attributed by time: the plan's key before the aliases were stored (2026-11-13 16:57 UTC),
  the first unspent alias after. The credits' sizes ($100 dev, $200 dev2, spent) are written in code, as the
  aliases are: they are not secrets (Dev2, 2026-11-13: no new secrets for non-secret config).
- **Lab test runs** (`feature` `benchmark` or `bench`) are shown apart and kept out of the people total.

## What a simplification would cost

Reading spend from our own meter instead would miss what the meter never sees (Workers AI, refused keyed attempts,
staging) and could not say who paid; dropping the `payer` label would put Who paid back to guessing from time.
`apps/convex/__tests__/consoleCosts.test.ts` and the payer checks in `apps/mcp/test/agentGateway.test.mjs` fail if
either is undone.
