# Tex's config is its graph: the wires are predefined, the nodes are code (2026-11-14)

Until 2026-11-14 the config (`packages/shared/src/texConfig.json`, the Tex
Architecture Lab's graph of main) set only each drawn step's model, effort,
time limit and on or off. Which step ran after which, what waited, and what ran
in the background were code. So code could run a step the drawing never showed.
The drawing and what Tex is told about itself could both be wrong, and no test
would fail. The owner's words on 2026-11-14: "it's fine for node to be code, but
it's not fine for the connections between node to be code. They should be
predefined."

The decision: **every node and every wire Tex runs is in the config.** A node is
code. A wire is data, and one shared runner reads it. Nothing else decides what
runs next.

## The config holds every wire, and every wire runs

The file is `packages/shared/src/texConfig.json`. Its top level is `texConfig`
(the version), `about`, `models` (a model key to its gateway id), `groups`
(folded boxes such as `door`), `nodes` and `edges`.

A node has an `id`, `label`, `goal`, `kind` (`input` for a start, `code`, `model`
or `tool`), `model` (a key of `models`, or `code`), `effort`, `on`, `rounds`,
`out`, `timeoutS`, `ms` (the estimate the Lab uses), `ctx` (the context modules it
reads, in prompt order; `p-<name>` is the prompt words in
`packages/shared/src/texPrompt/<name>.md`), `areas` (the replay areas it
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
`io.use` (a `uses` wire), `io.back` (a `loop` wire) or `io.job` (a `job` wire).
Each of those is a wire in the config, so a node can call only what its wires
reach. A node file that imports another node's file is refused.

**What a simplification would cost:** a direct import is a wire nobody drew, and
the drawing has no way to show it. Test: the import check in Fast repository
guards (`scripts/tex-diagram-check.mjs`), with the runner's coverage tests.

## One runner interprets the wires

`packages/shared/src/texGraph.cjs` is the only interpreter of `edges`. Its modes:

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
steps chain to each other with `when ["next"]`.

A node that is `on: false` never runs. A graph with a `wait` cycle, an unknown
mode, or a wire to a node that is not there is refused before any turn runs.

The config still says `behind` for the background wires until the rename lands.
The runner and the drawing read `behind` and `background` the same, so nothing
changes in the meantime.

**What a simplification would cost:** a runner that takes a mode it does not
know, or a cycle of waiting steps, lets a turn hang or run a step nobody drew.
Tests: `texGraph.test.mjs` ("a graph with a wait cycle, an unknown mode or a
dangling wire is refused"; "behind runs in the background, a node that is off
never runs").

## Output that does not match its schema fails

Each node's `inSchema` and `outSchema` name the typed fields it takes and gives.
An output that does not match its `outSchema` fails the node (decided by the
owner, 2026-11-14). The failure is logged, naming the field. Then the usual
failure path runs: the node is tried again, and if it fails again the person
gets the one failed line.

**What a simplification would cost:** a loose output reaches the next step as
a field that step did not expect, and the wrong answer is sent as if it were
right. Test: `texGraph.test.mjs`, the schema cases, which must fail a node whose
output names a field the schema does not give.

## The runner logs every node run

The runner writes one `node` ledger entry for every run: the node, its input and
output shaped by the schema, the milliseconds, ok or failed, the turn and the
commit. No node writes that line itself.

**What a simplification would cost:** a node that logs itself can skip the log
when it fails, which is when the log is needed. Test: "every node run is logged
by the runner" in `texGraph.test.mjs`, which breaks when the runner's `keep()`
call is removed.

## Where the nodes run

All nodes run in the gateway, on one graph (decided by the owner, 2026-11-14).
The texting Worker is plumbing only: it checks the webhook, hands the message
over and delivers the reply. The per-chat queues move into the gateway with the
nodes.

The move is staged. `packages/shared/src/texGraphHome.json` lists each node's
process. The `notYet` list names the nodes still wired by hand. Each node joins
its process's node table, and leaves `notYet`, in its own pull request. The list
only ever shrinks.

**What a simplification would cost:** a second graph in the Worker means two
places that decide what runs, which is the drift this decision removes. Test: the
coverage check in `texGraph.test.mjs` and the gateway's `texGraphHome.test.mjs`,
which fail when a config node has no code, or code has no config node.

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
2. `apps/mcp/src/agent/texArchitecture.generated.js`, which holds `TEX_MAP`: the
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

The runner (`packages/shared/src/texGraph.cjs`) adds, with its own tests in
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

**A new node.** On a branch, write its code in the node table of the process
that runs it, and its file. Add its config entry with `inSchema`, `outSchema`,
`ctx` and its wires. If it calls a model, add its role to `ROLES` in
`texArchitecture.js`. Run `node scripts/tex-architecture.mjs`. Add a replay case.
A node with no code cannot be promoted.

**Changing a node's code only.** The pull request changes the config too, or it
says `Tex diagram: unchanged because <reason>`.

## Related

- [One drawing of Tex](./architecture-diagram.md): the hand-drawn rule it replaces
  on 2026-11-14.
- [The Architecture Lab](./architecture-lab.md): the staff page that edits the
  config and promotes it.
- [One list of what Tex can do](./capabilities.md).
- [Tex changes merge only through the replay gate](../testing/replay-gate.md).
