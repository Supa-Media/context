/**
 * A stub where `decide.js` was before Tex's turn moved to `packages/tex/gateway/agent/`. The Test Set runs main's
 * harness over a pull request's tree, and main's harness from before the move reads this path
 * (`apps/mcp/bench/setsRun.mjs`). From the move on, the harness reads the new place first, so a later pull request
 * deletes these stubs.
 */
export * from "../../../../packages/tex/gateway/agent/decide.js";
