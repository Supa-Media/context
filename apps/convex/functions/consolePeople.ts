/**
 * The staff console's People page: one list of everyone. Handlers live in
 * `lib/adminFns/consolePeople.ts`; this file only authorizes and delegates.
 */

import { query } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { consolePeopleValidator, everyoneHandler } from "./lib/adminFns/consolePeople";

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
