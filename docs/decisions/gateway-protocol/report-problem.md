# Gateway protocol: an agent reports a problem

## `report_problem` files through the bug button's intake, as the grant's person

An agent that hits a problem in Context (a tool that fails, returns something
wrong, or contradicts its own description) had no way to say so. The app's bug
button sends a signed-in person's report through the control plane to Sentry
(`functions/feedback.ts`), but that path accepts an app session only, and an
agent holds an MCP grant.

`report_problem { message }` sends a plain-text message and nothing else. The
gateway forwards it with the connection's own access token to
`POST /gateway/feedback`, which spends the same two proofs as every gateway
route: the gateway secret, and the token, resolved to its person by the
control plane. From there it is the app's intake: the same ten-a-day budget per
person, shared with the bug button, the same Sentry envelope, the report never
stored. The source is always `agent` and the envelope names the AI app from
the grant; the app's own intake refuses `agent`, so neither kind of report can
pass itself off as the other.

Decided with the maintainer (2026-09-30):

- **Every connection is offered it**, a read-only one included. It changes
  nothing in any workspace (`readOnlyHint`), and sends text outside Context
  (`openWorldHint`).
- **The agent sends without asking first.** The tool description tells it
  when to report and what to say.
- **Never note contents.** The description forbids note text, paths, names and
  anything else from the workspace. It cannot be enforced (a message is free
  text), which is the same trust the app's own report message carries; the
  daily budget bounds how much a misbehaving agent can send.

**What a "simplification" would cost.** A report filed as a person the gateway
names, rather than one the control plane resolves from the token, lets anyone
holding the gateway secret file reports as anybody. A separate budget for
agents doubles what one looping agent and one person can send. Accepting
`agent` in the app's intake lets a person's client label its reports as an
agent's.

**The tests that fail if it is reversed:**
`apps/convex/__tests__/controlPlane/feedback.test.ts` ("an unknown or revoked
token files nothing, and says only that", "the day's budget is the person's,
shared with the app's bug button", "an agent report cannot pass itself off as
the app's, nor the app's as an agent's") and
`apps/mcp/test/reportProblem.test.mjs` ("a report reaches the control plane
with the connection's own token and the message").
