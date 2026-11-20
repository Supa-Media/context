# @context/tex

Tex, the assistant people text. Its code was gathered here from the apps it used
to be spread across, one small move at a time with no change in behaviour
(2026-11-20).

- `src/`: what every part of Tex shares.
  - `texConfig.json`: Tex's one graph, every node and wire it runs, read only
    through `texConfig.cjs` / `texConfigSchema.cjs`; `texNodeShelf.json` holds
    merged-but-unwired nodes and `texGraphNotYet.json` the steps not yet nodes.
  - `texGraph`, `texSteps`, `texSettings`, `texNumber`, `texRouteSummary`,
    `texConfigStamp`: reading and checking the graph.
  - `texPrompt/*.md` and the generated `texPrompt.generated.json`: the prompt
    modules, word for word.
  - `textDecide` (the reply judge's examples), `texTraining`, `texExamples`,
    `texSets`: what Tex learns from.
  - `toolRules`: the four rules every Tex tool is held to.
- `worker/`: the texting Worker (the line in, the queue per sender, group
  turns, the line out). `apps/agent` keeps only its entry point and Wrangler
  config.
- `gateway/`: Tex's code that runs inside the gateway Worker.
  - `agent/`: the turn, its steps and nodes, the judges, history and the
    capability list (`agent/capabilities.js`).
  - `texStore/`, `texChat/`, `texJob*.js`: Tex's Durable Objects (a person's
    store, a group chat's object, a background job's object). The gateway's
    `src/index.js` still exports them, so their bindings do not move.
  - `seams.json`: the gateway files this code still imports by path. Each is a
    seam to cut, and the list may only shrink
    (`scripts/check-tex-gateway-seams.mjs`).

Tex's Convex functions stay in `apps/convex`, where Convex deploys them from and
where the decrypt-path check reads them.

The Lab (`packages/lab`) depends on this package; this package never depends on
the Lab. Apps keep thin entry points only where their deploy tool needs a file
in a fixed place (Convex `functions/`, a Worker's `main`).
