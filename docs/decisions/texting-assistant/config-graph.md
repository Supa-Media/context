# Tex's config is its graph: the wires are predefined, the nodes are code (2026-11-14)

Until 2026-11-14 the config (`packages/tex/src/texConfig.json`, the Tex
Architecture Lab's graph of main) set only each drawn step's model, effort,
time limit and on or off. Which step ran after which, what waited, and what ran
in the background were code. So code could run a step the drawing never showed.
The drawing and what Tex is told about itself could both be wrong, and no test
would fail. On 2026-11-14 Dev2 found the Lab drawing a text going straight to
the queue with no wire, and asked "where else is there random code running".
The audit found several model calls with no node at all (the egress judge, the
picture maker, the memory nudge, reflect, dreams, day summaries, housekeeping,
the thread reader, the claim check). Dev2 chose: "it's fine for node to be
code, but it's not fine for the connections between node to be code. They
should be predefined", and approved the design ("Tex Wiring Graph", 19:14Z)
with: "Please make sure you do not deviate from this plan."

The decision: **every node and every wire Tex runs is in the config.** A node is
code. A wire is data, and one shared runner reads it. Nothing else decides what
runs next.

## The config holds every wire, and every wire runs

The file is `packages/tex/src/texConfig.json`. Its top level is `texConfig`
(the version), `about`, `models` (a model key to its gateway id), `groups`
(folded boxes such as `door`), `nodes` and `edges`.

A node has an `id`, `label`, `goal`, `kind` (`input` for a start, `code`, `model`
or `tool`), `model` (a key of `models`, or `code`), `effort`, `on`, `rounds`,
`out`, `timeoutS`, `ms` (the estimate the Lab uses), `ctx` (the context modules it
reads, in prompt order; `p-<name>` is the prompt words in
`packages/tex/src/texPrompt/<name>.md`), `areas` (the replay areas it
belongs to), `file` (where its code lives), `group`, `inSchema` and `outSchema`
(the named, typed fields it takes and gives), `log`, `icon` and `x`/`y`.

A wire is `{from, to, mode, when}`.

**What a simplification would cost:** a wire written back into code, such as an
`if` that calls the next step, makes the drawing, the words Tex is given about
itself and the Lab's time and cost numbers describe a Tex that does not run.
Whack-a-mole returns: a step nobody drew runs on some Tuesday. Tests that fail
if this is reversed: `apps/mcp/test/texGraph.test.mjs` ("a node can call only
what its uses wires reach", "a wire's when picks the branch from the node's
output") and `apps/mcp/test/texArchitecture.test.mjs`.

## A node is code, and it never imports another node

A node is `async (input, io) => output`. It reaches another node only through
`io.use` (a `uses` wire), `io.back` (a `loop` wire; the work goes back along
the `wait` path to the sender) or `io.job` (a `job` wire). Each of those is a
wire in the config, so a node can call only what its wires reach, and a handle
with no wire throws. A node file that imports another node's file is refused.

**What a simplification would cost:** a direct import is a wire nobody drew, and
the drawing has no way to show it. Test: the import check in Fast repository
guards (`scripts/tex-diagram-check.mjs`), with the runner's coverage tests.

## One runner interprets the wires

`packages/tex/src/texGraph.cjs` is the only interpreter of `edges`. Its modes:

- `wait`: runs next on the source's output. A node fed by several wait wires
  runs once, after all of them, on their outputs merged.
- `uses`: the source may call the target through `io.use`. Each call is logged
  as the target's run.
- `background`: runs after the source; nobody waits. Renamed from `behind`.
- `loop`: the source may send work back to the target through `io.back`, at most
  the target's `rounds` times.
- `job`: the source may start the target as a background job through `io.job`.

A wire's `when` tags say when it fires: only when the source's output carries
the tag. `["*"]` means always. Early answers are wires. Each door step that can
end the turn has a `wait` wire to `send` with `when ["answered"]`, and door
steps chain to each other with `when ["next"]`. A wire hands on the output
without its `when`: the tags chose the wires and are no part of the next
node's input. How a whole turn runs on these wires is
[turn-graph](./turn-graph.md).

A node that is `on: false` never runs. A graph with a `wait` cycle, an unknown
mode, or a wire to a node that is not there is refused before any turn runs.

`behind` is `background` (Dev2, on the design: "why not call it background?"),
in the config, the runner, the Lab and Promote; a Lab version saved before the
rename reads with the new name (`store.ts` `withCurrentModes`).

**What a simplification would cost:** a runner that takes a mode it does not
know, or a cycle of waiting steps, lets a turn hang or run a step nobody drew.
Tests: `texGraph.test.mjs` ("a graph with a wait cycle, an unknown mode or a
dangling wire is refused"; "behind runs in the background, a node that is off
never runs").

## Output that does not match its schema fails

Each node's `inSchema` and `outSchema` name the typed fields it takes and gives.
A field is required unless `optional: true`, an unnamed field fails, and only
`when` (the output's routing tags) is exempt. An output that does not match its `outSchema` fails the node (decided by the
owner, 2026-11-14). The failure is logged, naming the field. Then the usual
failure path runs: the runner throws a `GraphError` naming the field, and the
turn's own failure handling takes over.

**What a simplification would cost:** a loose output reaches the next step as
a field that step did not expect, and the wrong answer is sent as if it were
right. Test: `texGraph.test.mjs`, the schema cases, which must fail a node whose
output names a field the schema does not give.

## The runner logs every node run

The runner writes one ledger entry for every run, a `step` entry with
`step: "node"` (`packages/tex/gateway/agent/ledger.js` `nodeEntry`): the node, its input
and output, the milliseconds, ok or the error, and the wire that ran it (`via`).
Replay reads those as each node's Got and Gave. No node writes that line itself.

**What a simplification would cost:** a node that logs itself can skip the log
when it fails, which is when the log is needed. Test: "every node run is logged
by the runner" in `texGraph.test.mjs`, which breaks when the runner's `keep()`
call is removed.

Each run's time is its own (decided 2026-11-15, after Dev2 saw Text them,
Answer checks, Memory nudge and Reflect at 0 s): `ms` is the whole run and `own`
is that less the time it waited on the nodes it called (`use`, `back`), so
Answer checks never carry the front door's rewrites. Replay draws `own`, takes
the reply's rounds only for a node the runner has no run for, and never times a
step as "what the others leave of the reply". Text them's delivery runs in the
texting Worker after the gateway answered, so the Worker keeps it as a `send`
step `of: "delivery"` under the turn, and Text them's time is the node plus
that. Code with no wait reads 0 on the Workers clock, which moves only across a
wait; Replay shows it as "<1 ms". Every canvas step names what its time measures
(`stepLogs.ts` `time`).

**What a simplification would cost:** a 0 or a doubled time passes a guard
that only asks whether a time was logged. Tests: "a node logs its whole run and
its own time" in `texGraph.test.mjs`, "every step's real time is its own, once"
in `texLabRealTimes.test.ts`, and the delivery tests in `inbox.test.ts` and
`groupToolTap.test.ts`.

## Where the nodes run

All nodes run in the gateway, on one graph (decided by the owner, 2026-11-14).
The texting Worker is plumbing only: it checks the webhook, hands the message
over and delivers the reply. The per-chat queues move into the gateway with the
nodes.

The one graph is `packages/tex/gateway/agent/graph/gatewayGraph.js`, over
`GATEWAY_NODES` (`gatewayNodes.js`). The move is staged:
`packages/tex/src/texGraphNotYet.json` names every node whose code is not on
the runner yet. A node leaves it in the pull request that puts it in
`GATEWAY_NODES`, and nothing goes back. Meanwhile code not yet a node calls one
with `runNode(id, input, ctx, via)`, or over a config wire with
`fire(from, to, ...)`. The migration lands in six steps, each its own pull
request: the runner and guards; the turn after the door (the door as eleven
nodes in a group); the Worker's head (triage, decide, lanes) moved into the
gateway; jobs and starts; the missing nodes; and the Lab simulating on the same
runner.

**What a simplification would cost:** a second graph in the Worker means two
places that decide what runs, which is the drift this decision removes. Test:
`texGraphHome.test.mjs`, which fails when a node is both on the runner and in
`notYet` or neither, when `notYet` grows, when a node imports a sibling, or
when a run does not reach the ledger.

## Starts decide with a tag, and a job's helpers are reached over its wires

A start is a node of `kind: "input"` whose code decides whether the run goes on: Check-in gives `to: "look"` or
`to: "done"` with the route's own answer, and Send through Tex gives `to: "send"` or `"quiet"`; the wires out of them
fire on those tags, so a quiet check-in is a branch in the config, not an early return in code. What the rest of a run
reads but must not log (changed notes, mail, the settings note) rides on `ctx`. Until a job's part is a node of its own
(step 4), the code that runs that part reaches Job check, the hand-back judge and the mail advisor only over the job's
wires (`graph/bridges.js`), so a wire the config lacks is refused.

**What a simplification would cost:** an early return in a start's code is a branch the Lab cannot draw. Tests that
fail: `apps/mcp/test/texGraphStartNodes.test.mjs` (each with a sabotage record).

A background job's object moves the way a chat's did: the gateway's `TexJob` runs the Worker's job code as it is, a
job lives where it was born (`packages/tex/worker/jobPlace.ts` asks `/job-here` before a steer, stop, resume or mail), and
`TEX_JOBS` turns the gateway on per environment, so a job running in the Worker is never moved mid-run. The job node is on the runner now: `TexJob` runs each pass through `graph/nodes/job.js`, and while a pass runs its Job
check, Hand-back judge and Advisor on job mail go over that node's own wires, lent through `graph/jobHandles.js`. The bridges
stay for a job the Worker runs. Production moved its new jobs on Dev2's go (2026-11-14), and the Worker's job code goes once none is left running there.

## The door steps are one group

The eleven door steps (`readTheText` through `prepareTheAnswer`) carry
`group: "door"`. The Lab shows the group folded as one Door steps box. Focus
opens all eleven. A group is a picture only: it changes no wire and no order.

**What a simplification would cost:** a folded group that also hides its wires
hides the early answers, which are the reason the door has eleven steps. Test:
`tex-diagram-check.mjs`, which fails when a `texEntryPoint` step is not a
node, or the nodes are out of the code's order, and draws every wire inside the
group.

## The Lab's Promote may rewire live Tex, behind the replay gate

The owner decided that a Lab version may rewire live Tex: `scripts/tex-lab-promote.mjs`
writes the config on a branch and opens a pull request. The pull request is the
only way in, and it goes through the replay gate
([replay-gate](../testing/replay-gate.md)).

Tex's words about itself (`TEX_MAP`) are generated from the config. So any
change to the config changes every Tex agent's prompt fingerprint, and the
change requires replay. Promote refuses a step the gateway has no code for. A
new node with no code needs its code on a branch first, then Promote.

**What a simplification would cost:** a Promote that writes to main, or skips
replay because "only the wires changed", ships a route nobody tested. The wires
are what changes the replay results most. Tests: `tex-lab-promote.mjs
--self-test` and the replay gate's cases.

## The drawing and what Tex is told are generated from the config

`scripts/tex-architecture.mjs` writes three things from the config alone, and
nobody edits them by hand:

1. The drawing in `docs/architecture/tex.md` (Mermaid: a box per node, its group
   as a subgraph, an arrow per wire drawn by its mode), and the steps table in
   the same page.
2. `packages/tex/gateway/agent/texArchitecture.generated.js`, which holds `TEX_MAP`: the
   same graph in words. `texArchitecture.js` puts it ahead of every Tex agent's
   prompt, with the one line naming the node that agent is. Its `ROLES` are keyed
   by node id.
3. The page's steps table (see 1).

**What a simplification would cost:** a drawing kept by hand drifts from the code
within days, as the 2026-10-30 and 2026-11-01 maps did
([architecture-diagram](./architecture-diagram.md)). A `TEX_MAP` written by hand
tells Tex a structure it does not run. Test: `tex-diagram-check.mjs`, which fails
when any of the three is stale.

## CI guards

In Fast repository guards, `scripts/tex-diagram-check.mjs` fails when:

- a generated file is not current (rerun `node scripts/tex-architecture.mjs`);
- a wire joins a node that is not in the config, or has a mode the runner does
  not know;
- a step `texEntryPoint.js` runs is not a config node or named by a node's
  `file`, or the door's steps are in the config in another order than the code
  runs them;
- a file that names a model id is neither a node's `file`, nor on the short
  `PLUMBING` list (carries calls for nodes), nor on the shrink-only
  `NOT_NODED_YET` list; and a `NOT_NODED_YET` entry that has its node, or names
  no model any more, must leave the list;
- a Tex agent's system prompt does not go through `withArchitecture`;
- a pull request changes a node's file and neither changes the config nor says
  `Tex diagram: unchanged because <reason>` in its description.

The runner (`packages/tex/src/texGraph.cjs`) adds, with its own tests in
`apps/mcp/test/texGraph.test.mjs` and `texGraphHome.test.mjs`: a cycle of
`wait` or `background` wires, a node in the config with no code or code for a
node not in the config, and a node file that imports another node's file.

Each check's self-test breaks it on purpose.

**What a simplification would cost:** each guard removed is a way for the
drawing, the config and the code to disagree while CI stays green. The
self-test is what shows each guard fails; a guard nobody has checked is not a
guard ([testing](../testing.md)).

## How to change Tex's graph

**A model, an effort, a time limit or a wire.** Edit `texConfig.json`, or promote
a Lab version. Run `node scripts/tex-architecture.mjs`. Add the replay case that
proves the change ([replay-gate](../testing/replay-gate.md)). Open the pull
request. If the change alters what a person can get Tex to do, the change also
edits its line in the capability list ([capabilities](./capabilities.md)).

**A new node: code first, on its own, then wire it** (decided by the owner,
2026-11-16: "for code changes, create the node inside the code first and merge
it to main, this should be simple and easy because the node is not used in any
config yet"). Step one is a pull request that only adds the node's code: its
file under `packages/tex/gateway/agent/graph/nodes/`, its entry in `GATEWAY_NODES`, its
unit test, and an entry on the shelf, `packages/tex/src/texNodeShelf.json`
(its id, its files and what it is for). The config does not change, so the
drawing, the map and every prompt stay byte for byte the same, no model area is
reached, and no replay case or Test set run is asked for
(`check-tex-change-has-case.mjs` passes a shelf-only change; the coverage test
and `tex-diagram-check.mjs` accept a shelf node's code with no config node). A
shelf node never runs: the runner runs only the config's nodes. Step two is a
Lab draft that wires it (with `inSchema`, `outSchema`, `ctx`, and a role in
`ROLES` in `texArchitecture.js` if it calls a model), tested with Lab runs on
main, and Promote: the promote script takes it off the shelf in the same pull
request that puts it in the config, and that pull request goes through the
replay gate like any rewiring. A draft can run on a pull request's code before
step one merges ([lab-runs](../testing/lab-runs.md)), but the code merges first.
A node with no code, on the shelf or in the config, cannot be promoted.

**A draft runs its shelf nodes** (2026-11-16, the simpler graph). A Lab test
chat or Lab run on a draft that draws a shelf node runs it: `withDraft`
(`packages/tex/gateway/agent/texConfig.js`) adds the draft's shelf nodes, and when every
wire of the draft names a node that can run, takes the draft's wires and each
node's input and output shapes. A main node the draft removes stays in the
turn's config only for the settings code reads off it; no wire reaches it, so it
never runs. Code that may meet either graph picks by the config's own wires
(`graph.wired(from, to)`, `"id" in io.use`) or by `texPick` for a folded node's
settings, so main's config always takes its existing path. What it costs to
undo: a draft that merges or removes steps runs main's steps again, and the Lab
cannot test it before Promote. `test/texDevDraftFit.test.mjs` fails if it is
reversed.

**Changing a node's code only.** The pull request changes the config too, or it
says `Tex diagram: unchanged because <reason>`.

## A step reads the turn's tools only when its ctx says "tools" (2026-11-16)

A job's log on 2026-11-16: the Advisor was handed the turn's tools by name
only (`fetch, send, ...`), and told a Haiku job to fetch an email with
`{ links: true }`, an argument no tool has, and to `read_back` earlier reads
its six tools never showed. The owner: "I'm confused how the advisor does not
have access to the tool set. That sounds like a harness issue."

**Decided (the owner, 2026-11-16):** what a step reads is the config's, never
code's. The Advisor (`advisor`) and Job check (`jobcheck`) are shown the turn's
real tools, each with its first paragraph, its parameters (type, enum, the
start of its description) and the actions and ids it lists, capped at 16,000
characters (`advisorToolList.js`), **only when their `ctx` names `"tools"`**,
in main's config or a Lab draft's (`readsTools`, threaded as `texConfigOf`).
Without it they see no tool list at all: the names-only list is gone. The code
merged unwired; wiring is a Lab draft that adds `"tools"` to those two steps'
`ctx`, then Promote. A draft that does is applied as drawn (`draftFit` reports
nothing unapplied). The fetch id `read:<ref>` (`sixTools.js`) opens an earlier
read (`read_back`), listed among fetch's ids exactly when the turn holds it, so
a turn shown read refs can always open them.

**What a "simplification" would cost.** Building the list whatever the config
says puts a prompt decision back in code; a names-only list lets the advisor
advise arguments that don't exist. `apps/mcp/test/agentAdvisorToolList.test.mjs`
and the `reads-back` replay fail if either is reversed.

## Related

- [One drawing of Tex](./architecture-diagram.md): the hand-drawn rule it replaces
  on 2026-11-14.
- [The Architecture Lab](./architecture-lab.md): the staff page that edits the
  config and promotes it.
- [One list of what Tex can do](./capabilities.md).
- [Tex changes merge only through the replay gate](../testing/replay-gate.md).
