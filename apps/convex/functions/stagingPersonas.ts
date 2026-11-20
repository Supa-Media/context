/** Operator-only fixtures. No public seed endpoint and no production writes. */
import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { isIsolatedPreview } from "./lib/previewDeployment";
import { stagingStorageIsFree } from "./lib/managedStorage";
import { seedPersonaWorkspaces } from "./lib/personaSeed";

export { FIXTURES, PERSONAS } from "./lib/personaSeed";

export const prepare = internalMutation({
  args: { reset: v.optional(v.boolean()) },
  handler: async (ctx, { reset }) => {
    if (!stagingStorageIsFree() && !isIsolatedPreview()) throw new Error("Staging personas require the isolated staging deployment.");
    return await seedPersonaWorkspaces(ctx, { reset });
  },
});
