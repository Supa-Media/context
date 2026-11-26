# Storage and credentials: whose Anthropic key pays

## One list of keys, by use, and a run may pick whose goes first

**Decided by the owner, 2026-11-26:** "we need a smarter way to route to the
different api tokens we have configured. we plan to use wide range of tokens,
need to be choose whose we are using." Picked: a key list in config with a
per-use order, plus a key picker on Lab and eval runs.

Anthropic keys live on the AI Gateway's Provider Keys page, never in this
repository, GitHub secrets or a Worker; a call names one with
`cf-aig-byok-alias` ([inference](./inference.md) and `aiGateway.js`). The
aliases are names, not secrets, so the one list of them is
`packages/tex/src/aiKeys.json`: each key's alias, owner, credit, use so far,
expiry, reset, `retiredUntil`, and the uses it serves (`prod`, `lab`,
`evals`). Each use tries the keys that can still pay soonest-expiring first
(Dev2, same day: "smartly always use the expiring key first before we go onto
the next, and also yes mark something as retired until the reset"), skipping
a retired, expired or used-up key, computed at call time. Deployed gateways
and GitHub runs name their use with `AI_KEY_USE`; the console's AI costs page
reads owners and caps from the same file. A Lab or eval run's picked key
(`key`, by owner or alias, kept on the run; `tex_dev` `keys` lists them) goes
first as `AI_KEY_PICK`, and the use's order follows it.

A key that answers "credit balance is too low" or "reached your specified API
usage limits" rests for every isolate (`creditRest.js`), until the date the
refusal names when it gives one, and the next key is tried; the probe after the rest picks the key up again when it refills. Before
this, a usage-limited key only fell through without resting, so every call
paid one wasted refusal, and the key list was a string pasted into ten
workflows with no owner, so a new person's key was never tried.

**Simplifying it back** to a pasted alias string per workflow drifts (the
`segun-claude-credits` key sat unused), and dropping the usage-limit match
costs one refused call per Claude call until the 1st. **The tests that fail:**
`apps/mcp/test/agentGatewayAliases.test.mjs` (usage limit rests the key until its
date; retired, expired and used-up keys; soonest expiry first; a pick by owner) and `apps/convex/__tests__/controlPlane/texLabRuns.test.ts`
(a run keeps only a listed key).

**Monthly credit (Dev2, same day):** "the expiriation and reset date is the same ... use it or loose it, but tomorrow he
gets a fresh $200". A key with `resetEvery: "month"` never expires: its credit lapses and refills on each monthly
anniversary of `resets`, the order ranks it by that period's end, and its `usedUsd` counts only when recorded inside
the current period. **Simplifying it** to one `expires` date drops a refilling key for good after its first lapse.
**The test that fails:** "a monthly key never expires" in `agentGatewayAliases.test.mjs`.
