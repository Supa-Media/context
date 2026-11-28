/**
 * The pinned workspace, addressed as a tool call would address it. Mirrors
 * `PINNED_CONTEXT_SLUG` in `packages/shared/src/pinnedContext.ts` (the gateway
 * takes no dependency on that package); a test holds the two together
 * (`apps/mcp/test/globalOrientNote.test.mjs`). The gateway's
 * `orient/globalNote.js` re-exports it, and Tex reads it here.
 */
"use strict";

const PINNED_CONTEXT_NAME = "@context-lc";

module.exports = { PINNED_CONTEXT_NAME };
