# The turn after the door runs on the config's graph (2026-11-14)

_Part of [the texting assistant](../texting-assistant.md). Decided by Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the connections between node to be code. They should be predefined". The same day Dev2 also decided that the door is eleven nodes in one group, that every node runs in the gateway, that the wire mode `behind` is renamed `background`, and that the runner logs every node run, so no step logs by hand._

## What it is

Tex's turn is one run of `texConfig.json`'s graph. The runner is `packages/shared/src/texGraph.cjs`. The gateway gives it the nodes, one code function per node id, in `apps/mcp/src/agent/graph/gatewayNodes.js`, and `apps/mcp/src/agent/graph/turnGraph.js` starts it at `readTheText`. `texEntryPoint.js` calls that run and keeps its old recovery path for a turn that fails after the front door has begun.

- **Each door step is a node.** The door is eleven nodes in group `door`: Read the text, Run a routine, Check the question, Settle a yes or no, Watch what leaves, Check it may run, Read the history, Open the web, Read the setup, Bookkeeping and Prepare the answer. Each node's code is its file under `apps/mcp/src/agent/texEntryPoint/`, wrapped by `graph/doorNode.js`. A step reads and extends the turn so far, `t`, which the run shares as context and never logs.
- **An early answer is a wire, not code.** A door step that answers the turn (a refusal, a settled yes or no, a routine that needs no model, a paused routine) leaves the answer in `t.response` and is tagged `answered`. Five steps have an `answered` wire to Text them: Read the text, Run a routine, Check the question, Settle a yes or no and Check it may run. Every other step is tagged `next` and its `next` wire goes to the following door step. The code of a step never chooses the next step.
- **The front door stops at each draft.** The front door node `fd` runs the model loop of `turn.js` `runTurn` through `texEntryPoint/runTheModel.js`. Its check of a draft is not a call into another node. `graph/draftBridge.js` holds the loop at each draft and `fd` returns that draft as its output. The wire `fd` to Answer checks (`checks`) takes it on. Answer checks sends a draft back to the front door through its `loop` wire, and the front door resumes the same model loop with the notice. A draft that Answer checks let through and that the Reply reviewer (`reviewer`) sends back goes through the `loop` wire to the front door, and then through Answer checks again before the reviewer reads the rewrite, as before. Both loops allow 30 rounds, the most a front-door turn has (`progress.js` `LONG_MAX_ROUNDS`).
- **Tools and the models around the front door are reached through its `uses` wires.** `fd` reaches `tools` when the model acts (`action`), `advisor` when it is stuck (`stuck`), `fallback` when its model is down (`down`) and `planner` for a big ask (`big`). `tools` reaches the Mail checker (`mail`) and the Card check (`card`) through its own `uses` wires. Each call the runner makes is logged as that node's run, under the turn, with its input and output as the config's schema names them.
- **Background wires run after the reply.** Text them (`send`) fires two background wires: the Classifier (`classifier`) when the turn read the chat's threads (tag `threads`), and Self-review (`selfreview`) when a reply went (tag `sent`). Nothing waits for either, and the runner flushes the turn's log after each one finishes.
- **A setup that names its own models turns nodes on or off, for that turn only.** `graph/turnGraph.js` makes a copy of the config for each turn. A setup that names a model for the big-ask planner, the Reply reviewer, the advisor or the fallback sets that node on or off in the copy, and `readTheSetup` writes which switches it made in its log as `variant` (for example "reviewer off"). Live Tex's setup names no models, so for live Tex the switches are empty. This is for bench variants only.
- **Every node run is logged.** The runner writes each run as a `node` entry of the chat's ledger (`ledger.js` `nodeEntry`), kept while the door steps run and written with one ledger write when the run ends. A node's code never logs by hand. The output is logged as its `outSchema` names it.

### Not on the runner yet, and why

- **Router.** The node is in the config, but `on` is `false`, and `apps/mcp/src/agent/texConfig.js` refuses a step that is on and has no way to run. Its wire `prepareTheAnswer` to `router` to `fd` stays off until the router has a node.
- **Mail checker and Card check.** Both are called from inside a tool call (`send_email`, and the picture makers), so they move with those tools: the Card check with the picture maker in the step that gives the hidden steps their nodes, the Mail checker after it.
- **Starts from outside the door.** A job, a check-in, a routine and a notify start (`checkin`, `routine`, `notify`, `job`) still begin in their own code and hand the turn to the door. Moving those starts onto the runner is step 4.
- **Triage (Decide, React and Queue).** These run in the texting Worker before a text reaches the door. Moving them onto the runner is step 3.

## Why

A turn's order, its early answers and its loops were code, in `texEntryPoint.js` and the files it called. A change to who checks a draft, or to what a background step waits for, was a change to code that the Lab could not show and the replay could not read. Now the connections are in `texConfig.json`, which the Lab opens and promotes by pull request, and the code of each node is one function with a clear input and output. The runner writes each run to the chat's record, so a turn's settings, branches and calls can be read from the chat without reading the code.

The owner's rule was that the code of a node may be code, and that the connections may not. That is why `doorNode.js` returns a tag and never names the next step, and why `draftBridge.js` is plumbing that decides nothing about a draft.

## What a simplification would cost

- Putting a branch back into a door step (for example, `readTheText` calling the send itself on a refusal) would hide that branch from the config. The Lab would draw a path that is not a wire, and the replay would not show the early answer as a branch.
- Letting a node call another node by name, instead of through `io.use`, `io.back` or `io.job`, would let a node reach what its wires do not show. The runner refuses such a call with a `GraphError`.
- Letting a background step block the reply would add its time to the person's wait. Classifier and Self-review are kept off that path.
- Dropping the runner's log of a node run would leave the chat's record without the settings a turn ran with, and the Replay would have nothing to show.
- Letting a node's output drift from its `outSchema` would let the log and the Lab show a shape the code no longer gives. The runner fails a node whose input or output does not match its schema (owner's decision, strict from the start), and these nodes' schemas are proven by the tests below and by replay before they merge.

## Tests

The tests that fail if this is reversed:

- `apps/mcp/test/texGraphDoor.test.mjs`: the door schemas list the eleven steps, every node file exists, a step that returns nothing goes on, a step that answers the turn stops it and keeps the answer on the turn, and each step's input schema is the previous step's output schema.
- `apps/mcp/test/texGraphTurn.test.mjs`: the draft bridge stops at each draft and rejects the stop it waits on when a run throws; a draft that Answer checks send back is rewritten and checked again before the one let go reaches the reviewer; a draft the reviewer sends back passes Answer checks again before the reviewer reads it; with no review the reviewer never runs; and send answers before any model when a door step ended the turn.
- `apps/mcp/test/chatLedgerWrites.test.mjs`: a texted turn keeps its thinking, each tool call with its result and its reply, and every step of a texted turn leaves its time and outcome in the chat's ledger under the turn.
- `apps/mcp/test/replay/cases/door-settings-logged.mjs`: each door step is a `node` entry in the chat's record under the turn, and the front door's entry names the model, effort, reviewer, advisor, planner and fallback the turn ran with.
- `scripts/tex-diagram-check.mjs` (`graphSteps`): the steps the page draws in order are the steps the graph runs, so a door step that moves without the drawing fails CI.

Related: the drawing is [`docs/architecture/tex.md`](../../architecture/tex.md), and its section "How a turn runs: the config's graph" shows these wires. The architecture change is recorded in [the architecture diagram](./architecture-diagram.md).
