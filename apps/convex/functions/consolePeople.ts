/**
 * The staff console's People page: one list of everyone, and the acts it
 * takes. Handlers live in `lib/adminFns/consolePeople.ts` and
 * `lib/adminFns/consolePeopleActs.ts`; this file only authorizes and delegates.
 */

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { consolePeopleValidator, everyoneHandler } from "./lib/adminFns/consolePeople";
import {
  closeInboxHandler,
  openInboxesHandler,
  restoreWaitlistHandler,
  tellLetInHandler,
} from "./lib/adminFns/consolePeopleActs";
import { mutation } from "./lib/rowWatch/mutations";

export const everyone = query({
  args: {},
  returns: consolePeopleValidator,
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await everyoneHandler(ctx);
  },
});

/** Text "You're in" to the untold phone rows among `ids`, once each. Not-untold ids are ignored. */
export const tellLetIn = mutation({
  args: { ids: v.array(v.id("waitlist")) },
  returns: v.object({ texted: v.number(), left: v.number() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await tellLetInHandler(ctx, args.ids);
  },
});

/** Undo Remove: removed rows go back to waiting. Nobody is told. */
export const restoreWaitlist = mutation({
  args: { ids: v.array(v.id("waitlist")) },
  returns: v.object({ changed: v.number() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await restoreWaitlistHandler(ctx, args.ids);
  },
});

/** Personal inboxes that take mail from anyone, by the account that holds each. */
export const openInboxes = query({
  args: {},
  returns: v.array(v.object({ userId: v.id("users"), workspaceSlug: v.string() })),
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    return await openInboxesHandler(ctx);
  },
});

/** Switch one account's inbox to known senders only. Audited. */
export const closeInbox = mutation({
  args: { userId: v.id("users") },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    let actor;
    try {
      actor = await requireAdmin(ctx);
    } catch (error) {
      throw toConvexError(error);
    }
    return await closeInboxHandler(ctx, args.userId, actor);
  },
});
