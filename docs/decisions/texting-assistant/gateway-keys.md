# Keys the AI gateway holds pay first (2026-11-13)

Decided by the owner, 2026-11-13. The plan key's credit ran out on 2026-11-12,
and every call after that was sent twice, once with the spent key and once on
Unified Billing, drawing down the Cloudflare credit balance. The owner stored
two Claude Console organizations' keys on the gateway's Provider Keys page
instead of in a GitHub secret.

- `AI_GATEWAY_KEY_ALIASES` names them, comma separated, in the order they are
  tried. Each call names one with `cf-aig-byok-alias`; the key itself never
  leaves Cloudflare.
- Order: each stored key, then the plan key (`ANTHROPIC_CREDIT_KEY`), then no
  key, which Unified Billing pays. Each spent payer rests 15 minutes on its
  own, per isolate.
- A stored key that is not the gateway's `default` is never used by a call
  without an alias, so the last, keyless call still lands on Unified Billing
  (seen live on 2026-11-13: keyless calls stayed `wholesale` after two aliased
  keys were stored). Naming a stored key `default` would end that fallback.
- A plain 400 on an alias moves to the next payer, since the gateway's answer
  for an alias it does not hold is not documented as a 401; it is logged as
  `ai_gateway_payer_refused` with the payer and status only.

Simplifying this away (back to one key on the request) brings back the doubled
calls once that key's credit is spent. Test:
`apps/mcp/test/agentGatewayAliases.test.mjs`.
