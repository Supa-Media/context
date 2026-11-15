# Developers work on Tex from their own MCP session, live in the Lab (2026-11-15)

Dev2, 2026-11-15: "developers on Tex could use their MCPs ... to continue developing on Tex, and have access to the
rendered UI", "essentially everything that can be done in the UI, or seen in the UI, should be able to be done or seen
through the MCP as well", and to probe a turn: "what was the reasoning, what was the context that it loaded, what were
the inputs and outputs, the exact order different nodes were run". Design
(https://claude.ai/artifact/1nwVCYrrvYzRzJTGLYKGvk), with Dev2 taking every recommended option.

**A seventh tool, `tex_dev`, for people who edit `@context-lc`'s AI setup.** It is in `STAFF_ONLY_TOOLS` with
`run_model`: a connection whose person is not an owner or editor of the pinned context is still offered six tools, and
Tex is never offered it (`WITHHELD_TOOLS`, `SOMEBODYS_ALONE`). The control plane decides again on every call that
reads a draft or a chat (`functions/texLabDrafts.ts` `texDeveloper`): a live grant of an AI client of the person's
own, never one of Context's `context_*` clients, so Tex's grants can never reach it, and a person who is staff too,
as the Lab's own `requireAdmin` asks, so this door is never wider than the Lab's. One tool with an `action`, like
the v2 tools, so a new action is not a schema change a client's cached copy would strip; `guide` lists them.

**A draft is a saved Lab version, edited with small edits by both sides.** `packages/shared/src/texLabOps.cjs` is the
one definition of an edit (set a step's field, move, add, remove, wire, unwire, a module's edit, a conversation
setting, put the whole graph); the Lab, the control plane and the gateway run it. Every batch raises the version's
revision and records the pieces it touched (`texLabChanges`). A batch made against an older revision lands unless a
revision since touched the same piece; then it is refused with what is there now. Last-write-wins was rejected
because it drops the other side's edits without either seeing it; a shared typing room (the notes' Yjs) was rejected
because the Lab's state is not a shared document and the graph is small. Every answer carries what the other side
changed, and `changes` with `wait` (at most 50 seconds) lets an AI listen. The Lab saves a live draft on every edit
(`features/tex/lab/engine/live.ts`), shows who is in it and a list of changes, and opens `/lab?v=<draft>`.

**A snapshot is the Lab's own drawing.** The canvas is drawn by DOM-free code (`views/canvas/render.ts`); it is
bundled for the gateway as `apps/mcp/src/texDev/canvas.generated.js` by `scripts/tex-dev-canvas.mjs` (CI fails when
it is stale) and photographed by the site-shots worker's `/render`. A screenshot of the whole Lab page was rejected
because a headless browser would need a new way past staff sign-in.

**Probing reads what ran, from the chat's history file.** `chats`, `turns`, `turn` and `entries` read the same
ledger the Lab's Replay and the Tex page's History read, for the person's own one-to-one and the group chats they are
in (the control plane's `pageForUser`, as for the Tex page). A turn is every entry it wrote, in order, with inputs,
outputs, thinking, tool calls, models, milliseconds and failures, and a summary of the slowest steps. Nothing is
estimated (Dev2, 2026-11-14: replay shows only what ran).

**What the Lab computes in the browser, the MCP computes with the Lab's own code** (Dev2, 2026-11-15: "anything that
can be done inside of the lab should be able to be done inside of the MCP ... check all the gaps"). `sim` is the Speed
and cost view (and the Node panel's reads, cache share and output, and its "Use this log"); `compare` is Compare;
`config` is Run: its changes and how each ships, its areas and warnings, its prompt, and its config JSON as a block of
its own, the `lab.json` that `pnpm ai lab run --config` takes; `bench` is Test cases with the draft's picks and the
shared case edits, its test panel, who runs it and the bench's workspaces; `modules` is Modules and its word diff;
`reference` is the catalogues (tools, what each step logs and writes, the ledger, areas, models, wires, sources and
the conversation settings, and the Tools tab's count of a pasted record). `snapshot` with a `test` draws each step's
time and the stats chip as the canvas does, and `get`'s `vsMain` names the modules' words and conversation settings
a draft changes, as the Lab's nav tags do. All of it is the Lab's `engine/forMcp.ts`, bundled for the gateway as
`apps/mcp/src/texDev/lab.generated.js` by `scripts/tex-dev-lab.mjs` (CI fails when it is stale), with the state each
Lab function reads put in place for the call and taken back after. A second implementation in the gateway was
rejected because it would drift from the page the person is looking at; the views' arithmetic that lived inside
React components (the run warnings, the Compare's latest scores, the test panel, the modules' sections, the
workspace tree) moved into pure modules the views and the bundle share. The simulation is an estimate, and every
answer says which test it traced; what really ran is still `turn`. `compare` reads every version through the
control plane's `versions`, which does not mark the AI as in each draft.

**Nothing here changes live Tex.** `promote` is the Lab's Promote: a pull request that merges only through CI and the
replay gate. A draft changes config; a node's code or a new kind of step still needs a pull request.

*What a "simplification" would cost:* offering it to everyone, or to Tex, hands Tex's own wiring and every chat's
turns to callers who may not see them (`apps/convex/__tests__/controlPlane/texLabDrafts.test.ts` "a stranger, a plain
member ... are refused", `apps/mcp/test/texDev.test.mjs` "never offered to Tex"). Dropping the revision check lets two
editors overwrite each other silently ("the later edit to the same field is refused"). Answering a Lab tab from
anything but the Lab's own functions lets the MCP and the page disagree (`apps/mcp/test/texDevLab.test.mjs`, which
holds each action against the bundled function on the same input, and the `tex-dev-lab.mjs --check` step in CI).
