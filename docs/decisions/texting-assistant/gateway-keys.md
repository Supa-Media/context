# Keys the AI gateway holds pay first (2026-11-13)

Decided by the owner, 2026-11-13. The plan key's credit ran out on 2026-11-12,
and every call after that was sent twice, once with the spent key and once on
Unified Billing, drawing down the Cloudflare credit balance. The owner stored
two Claude Console organizations' keys on the gateway's Provider Keys page
instead of in a GitHub secret.

- `AI_GATEWAY_KEY_ALIASES` names them, comma separated, in the order they are
  tried. The names are not secrets, so the workflows that deploy and bench
  write them out (the owner, 2026-11-13: no new secrets to add by hand). Each call names one with `cf-aig-byok-alias`; the key itself never
  leaves Cloudflare.
- Order: each stored key, then the plan key (`ANTHROPIC_CREDIT_KEY`), then no
  key, which Unified Billing pays. Each spent payer rests 15 minutes on its
  own. Since 2026-11-17 that rest is one Durable Object for the whole gateway
  (`CREDIT_REST`, `packages/tex/gateway/agent/creditRest.js`), not a map in the
  isolate: after the first call sees the credit spent, every other isolate
  skips that payer and the call is attempted once, on the next payer. When
  the rest ends, one caller probes the key and the others still skip it. A
  probe that the credit answers clears the record, so the monthly refill (the
  plan credit returns on the 21st) is picked up without anyone clearing it by
  hand. A read that fails tries the key, and never fails the turn. With the
  binding left out, each isolate keeps its own rest, as before.
- A stored key that is not the gateway's `default` is never used by a call
  without an alias, so the last, keyless call still lands on Unified Billing
  (seen live on 2026-11-13: keyless calls stayed `wholesale` after two aliased
  keys were stored). Naming a stored key `default` would end that fallback.
- A plain 400 on an alias moves to the next payer, since the gateway's answer
  for an alias it does not hold is not documented as a 401; it is logged as
  `ai_gateway_payer_refused` with the payer and status only.
- A benchmark call uses the same rest. The runner has no Durable Object
  binding, so it posts `claim`, `spent` and `clear` to `/credit-rest` on the
  gateway, with the gateway token it already holds. The body is an op and a
  payer name. A wrong token is a 404. The runner's clock is not trusted: a
  claim uses the worker's time, and a spent mark is stored at most one rest
  ahead of it. A larger finite `until` is clamped and logged as
  `credit_rest_clamped`. The object still stores the timestamp an in-worker
  caller sends, because that caller is the worker's own clock. A benchmark
  call never falls through to Unified Billing: when every credit payer is
  spent or refused, the call stops. People's texts still do, because a text
  has to be answered. The round's priced usage is written to the eval spend
  note, so the monthly, daily and replay caps count it. (2026-11-17)

Simplifying this away (back to one key on the request, or a rest that only
the isolate which saw the failure remembers) brings back the doubled calls
once that key's credit is spent. Passing the runner's `now` and `until`
straight into the object parks the plan payer on the runner's clock. Tests:
`apps/mcp/test/agentGatewayAliases.test.mjs`,
`apps/mcp/test/agentCreditRest.test.mjs`.
