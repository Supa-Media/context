/**
 * Mail copied into notes again, only for people with the `mail.in-notes`
 * feature flag (owner, 2026-11-08). The look and its reasons are
 * `lib/googleSync/mailCopy.ts`; this registers it for `crons.ts`.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { startFlaggedMailPasses } from "./lib/googleSync/mailCopy";

export const startFlagged = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => await startFlaggedMailPasses(ctx, Date.now()),
});
