# @context/tex

Tex, the assistant people text. This package is being gathered from the apps it
used to be spread across (`apps/agent`, the gateway's `texChat`/`texStore`/`texJob`
and `agent/`, Convex's `tex*` functions and `packages/shared`), one small move at
a time with no change in behaviour.

Here now (`src/`):

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

The Lab (`packages/lab`) depends on this package; this package never depends on
the Lab. Apps keep thin entry points only where their deploy tool needs a file
in a fixed place (Convex `functions/`, a Worker's `main`).
