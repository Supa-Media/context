# Every failed Tex tool call is kept with why it failed (2026-11-10)

The owner, 2026-11-10: "whenever there is a tool call failure, I want it
logged and visible for us to understand why, that way as time goes on we are
looking at why tool calls fail and fix".

Before this, the turn log (`agentTurns`) kept `ok: false` on a failed tool
step and the dashboard showed a failure percentage per tool, but nothing said
*why*. A tool that threw was told to the model as "That call failed" and its
error was dropped everywhere. The chat's own history kept the result, but only
for whoever can read that one chat.

**One place sees every failure.** Every Tex model that holds tools runs
`runTurn` (`packages/tex/gateway/agent/turn.js`): the front door, a job's turns, a
routine, a check-in, housekeeping, a dream, the app's assistant. The advisor
and the judges hold none. So `runTurn` records each failure there
(`packages/tex/gateway/agent/toolFailures.js`) as:

- `tool`: the tool's name, or the name the model wrote when it named none it had;
- `cause`: a code: `refused` (the tool answered with an error), `threw`,
  `timed_out`, `out_of_time` (the turn's tool time was spent), `not_offered`,
  `no_such_action`, `repeated` (a write already made this turn);
- `why`: the reason in one line with every value taken out (`failureShape`):
  a path, a quote, a link, an address, a handle or a number becomes `<path>`,
  `<q>`, `<url>`, `<email>`, `<@>` or `<n>`. What is left is the sentence our
  code wrote, so the same failure reads the same in every chat and they group.
  A thrown error's class and shaped message are kept here, and still never
  reach the model.

A call held for the person's yes is not a failure. A designed send-back is
not one either (2026-11-17): a page with no picture asks for a scene
(`SCENE_ASK` in `visuals/pageDrawing.js`, marked `ask`). The model still
reads that as an error and draws again, the chat's ledger still shows the
call as not done so a later check does not skip the cover, and it does not
send the next round back to the planner. The turn log counts it as a call
that worked (`ok`, with `ask`), so the Lab's tool stats do not call it an
error. Counting it was most of the fast `draw_visual` failures.

**Where it goes.** A `tex_tool_failed` line in the gateway's logs at once, with
the client and workspace like every other log line. After the answer, the
run's failures (at most 20) go to `/gateway/tool-failures`, which keeps them in
`texToolFailures` for 90 days: tool, cause, why, model, where it ran (`one`,
`group`, `job`, `routine`, `app`, `check_in`), and the hour. **The row names
nobody**: no workspace, grant, chat or person, and the hour rather than the
moment, so it cannot be laid beside a turn row. The control plane shapes `why`
again (`keptWhy`) rather than trusting the gateway alone. tex.lc/admin shows
them as "Why tools fail": failures a day, and each reason with its tool,
cause, count, when last and where it ran, most first. Turns from texts, jobs,
routines and the app report through `texEntryPoint`; check-ins report from
`heartbeat.js`. Housekeeping, dreams and reflection log the line only.

**Not covered:** a job on a person's own computer runs Claude Code or Codex
there, whose tool calls never pass through `runTurn`.

What a simplification would cost: keeping the raw reason would put note names,
searches and page text into a table every staff member reads; keeping the
workspace on the row would tie a person to what failed for them; dropping the
shape would leave one row per path and nothing would group. Tests:
`apps/mcp/test/toolFailures.test.mjs` ("a tool that says no is kept as refused,
with its reason shaped", "a tool that throws is kept as threw…") and
`apps/convex/__tests__/texToolFailures.test.ts` ("a row names nobody…").

## A failed MCP call is a short code to its caller and a logged route

Decided 2026-11-20 (Dev2), after a job on a person's computer failed to save a
note three times and the group chat was told "control plane unavailable", with
no code to quote and no log of which call failed.

- Every control-plane call that gives no usable answer logs one
  `control_plane_failed` line: its route, its status (or `null` for a transport
  failure), a short reason and its code, and how long it took
  (`apps/mcp/src/controlPlane/client.js`). An answer a method reads and cannot
  use (`{served: false}`) is the same error, with its route.
- A call a client made through `/mcp` that fails inside the gateway logs one
  `mcp_call_failed` line (method, tool, code, route, status) and answers a
  plain sentence carrying a short code, such as `CP-NOTE-IDS-ADOPT-NOT-SERVED`
  (`apps/mcp/src/mcp/publicError.js`). The error's own words never reach the
  client: they can carry a path or a value, and the caller may be on the
  internet.

What a simplification would cost: relaying the message hands internal text to
an AI client and a person, and logging nothing leaves a failure no one can
trace. Tests: `apps/mcp/test/publicError.test.mjs`.
