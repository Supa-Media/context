# The front door's nearest examples (2026-11-18)

**Decided by the owner, 2026-11-18**: the front door may read the Training moments closest to the text it is answering,
picked per text by meaning, behind a switch that ships off.

- **Why moments, not conversations.** The front door reads `train:fd:all:100000`: every Training conversation with a
  front-door label, whole. On 2026-11-18 that was 5 conversations, 57,600 characters, all inside the cap, so choosing
  among whole conversations changes nothing. The unit picked is the labelled moment (99 that day), shown as a short
  example (`texTraining.cjs` `exampleText`).
- **The index is Tex's own.** One Vectorize index, `tex-examples` (bge-m3, 1,024 dimensions, cosine), never named
  `context-meaning-<id>`, so the meaning census and a workspace's cleanup never take it for a workspace's. Only
  Training moments go in, as `<chat>#<at>`. The control plane fills it after each deploy
  (`apps/convex/functions/texExamplesIndex.ts`, run by `deploy-convex.yml`), never per text.
- **Off by default.** The node `examples` is on the shelf (`texNodeShelf.json`). A Lab draft turns it on with a wire
  `fd -> examples` (`uses`). With no wire the front door's prompt is byte for byte what it was.
- **Never slower.** The front door starts the node as it starts, beside the router, and waits at most the node's `ms`
  (100 by default) before its first prompt. Late, failed or without an index, the fixed examples stand: nothing extra
  when the step already reads them, else its whole conversations. Every wait is traced (`kind: "examples"`: found, how
  many, ms, why). The nearest moments go in the per-text preamble, so the cached prompt is untouched.
- **A scored chat never sees itself.** The chat a bench process holds out or cuts (`TEX_TRAINING_HOLD_OUT`,
  `TEX_TRAINING_UNTIL`) is never a candidate, its past or its future, and an id the index returns that is not a
  candidate is dropped (`texExamples.cjs` `candidates`, `pickNearest`).

Reversing any of these: `apps/mcp/test/texExamples.test.mjs`, `apps/mcp/test/examplesNode.test.mjs` and
`apps/convex/__tests__/texExamplesIndex.test.ts` fail.
