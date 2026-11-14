# Tex runs its config's graph: the wires are config, the nodes are code (2026-11-14)

On 2026-11-14 Dev2 found the Lab drawing a text going straight to the queue with no wire, and asked "where else is
there random code running". The audit found the config (`packages/shared/src/texConfig.json`) set only the model,
effort, time limit and on or off of the steps it drew, while code decided which step ran after which, and several
model calls ran with no node at all (the egress judge, the picture maker, the memory nudge, reflect, dreams, day
summaries, housekeeping, the thread reader, the claim check). Dev2 chose: "it's fine for node to be code, but it's not
fine for the connections between node to be code. They should be predefined", and approved the design artifact
("Tex Wiring Graph", 2026-11-14 19:14Z) with: "Please make sure you do not deviate from this plan."

**The rule.** `texConfig.json` is the graph: every node (a step) and every wire between nodes (`wait`, `background`,
`uses`, `loop`, `job`, with `when` tags). `packages/shared/src/texGraph.cjs` is its one interpreter: it decides what
runs, in what order, what waits for what and what runs in the background, from the wires alone. A node is one function,
`async (input, io) => output`; it reaches another node only through `io.use` (a `uses` wire), `io.back` (a `loop`
wire, at most its `rounds`, and the work goes back along the `wait` path to the sender) or `io.job` (a `job` wire),
and a handle with no wire throws. A node never imports another node's code.

**Shapes are strict** (Dev2's call on the artifact: "fail"). A node's `inSchema` and `outSchema` name every field it
takes and gives; a field is required unless `optional: true`, an unnamed field fails, and only `when` (the output's
routing tags) is exempt. A mismatch fails the node with a `GraphError` naming the field.

**The runner logs every node run itself**: node, input, output, milliseconds, ok or the error, and the wire that ran
it (`via`), written to the chat's ledger as a `step` entry `step: "node"` (`apps/mcp/src/agent/ledger.js` `nodeEntry`).
Replay reads those as each node's Got and Gave, so no node logs by hand and none runs unlogged.

**Where.** Every node runs in the gateway (Dev2's call on the artifact: "theres no way for this to all be in the same
place?"); the texting Worker becomes plumbing that hands the text in. The one graph is
`apps/mcp/src/agent/graph/gatewayGraph.js`, over `GATEWAY_NODES` (`gatewayNodes.js`). While the migration runs, code
not yet a node calls one with `runNode(id, input, ctx, via)` or over a config wire with `fire(from, to, …)`.

**"behind" is "background"** (Dev2, on the artifact: "why not call it background?"), in the config, the runner, the
Lab and Promote; a Lab version saved before the rename reads with the new name (`store.ts` `withCurrentModes`).

**The ratchet.** `packages/shared/src/texGraphNotYet.json` names every node whose code is not on the runner yet. A node
leaves it in the pull request that puts it in `GATEWAY_NODES`, and nothing goes back. The migration lands in six steps,
each its own pull request: the runner and guards; the turn after the door step (the door as eleven nodes in a group);
the Worker's head (triage, decide, lanes) moved into the gateway; jobs and starts; the missing nodes (egress judge,
picture maker, memory nudge, reflect, nightly dream and day summaries, housekeeping); and the Lab simulating on the same
runner. Promote may rewire live Tex, behind the replay gate (Dev2: "yes").

**What a simplification would cost.** Putting a wire back in code is shadow code: the Lab would draw one Tex and run
another, which is what Dev2 called "whack-a-mole". Tests that fail: `apps/mcp/test/texGraph.test.mjs` (the runner's
semantics, each with a sabotage record) and `apps/mcp/test/texGraphHome.test.mjs` (every node on the runner or in
`notYet`, never both; `notYet` only shrinks; no node imports a sibling; every run reaches the ledger).
