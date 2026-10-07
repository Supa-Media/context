# Gateway protocol: every grant is listed every write tool, and the call refuses

**Approved 2026-10-07.** Reverses the rule that a read-only grant is not shown
tools it cannot use.

**What broke.** A chat connected to Context could read, but `write_note`,
`save_context` and `remember` were missing. The same connection wrote normally
in other chats. `toolsForSession` hid every tool without `readOnlyHint: true`
from a grant that could write nowhere. A client caches `tools/list` for the
life of a chat, and this server sends no `listChanged` (`protocol.js`). So a
chat that listed tools while its grant was read-only kept that list after its
person reconnected with write access. This is the same mechanism as
[a new argument reaches a client that a new tool cannot](../gateway-protocol.md),
reached through the grant instead of a release.

**The rule now.** `tools/list` shows every write tool to every grant.
`callToolForSession` is the only write control, as it always had to be, since
a client can name a tool it was never shown. A read-only grant that calls one is
refused with "this connection holds a read-only grant. Reconnect the client with
write access from the Context dashboard." A listed tool that refuses with a
reason can be recovered from. A missing one cannot, because an agent cannot ask
for a tool it was never told about.

**What did not change.**

- `PRIVATE_TIER_ONLY_TOOLS` is still filtered from a team-tier listing. Tier is
  fixed at consent, so a cached list cannot go stale in the direction that
  hides a usable tool.
- A Context plugin that is turned off still removes its tools, and
  `UNLISTED_TOOLS` is still unlisted.
- The in-app assistant. `/agent` builds its list fresh on every turn, so it is
  not a cached client. The route narrows a read-only grant to read tools before
  `agentTools`, so that grant's assistant is still not offered `propose_note`.

**What this costs.** A client connected read-only on purpose now sees write
tools it can never use, and an agent may spend one call learning that. That is
the trade the old rule refused. It was the wrong one: the cost it avoided is
one refused call with a reason, and the cost it caused was a capability that
disappeared silently for the rest of a chat.

**Tests that fail if this is reversed:** `a connection whose grant holds no
write scope is offered them too` and `...and calling one is refused with how to
fix it` in `apps/mcp/test/crossContext/advertising.test.mjs`; `a read-only grant
is shown the write tools it is refused` in
`apps/mcp/test/tenancy/resolutionScopeRevocation.test.mjs`; `a read-only
connection is offered remember and cannot call it` in
`apps/mcp/test/remember.test.mjs`. `a read-only connection's agent is not
offered the proposal tool either` in `apps/mcp/test/agent.test.mjs` fails if
the agent route stops narrowing.
