import type { AnalyzedModule } from "./fixtures.helpers";

/**
 * Builders for the synthetic modules `helperImports.test.ts` and
 * `helperDispatch.test.ts` feed through the analyzer beside the real
 * codebase. Each produces an `AnalyzedModule` exactly as `realModules()` does,
 * with the classification a live Convex registration would carry.
 */

export const lib = (name: string, source: string): AnalyzedModule => ({
  reference: `functions.lib.${name}`,
  path: `functions/lib/${name}.ts`,
  source,
  exports: {},
});

export const publicAction = (
  name: string,
  source: string,
  exportName = "fetchBucketConfig",
): AnalyzedModule => ({
  reference: `functions.${name}`,
  path: `functions/${name}.ts`,
  source,
  exports: {
    [exportName]: { kind: "action", isPublic: true, isInternal: false },
  },
});

/** A public action in `functions/<name>.ts` whose handler is `body`. */
export const callerOf = (name: string, imports: string, body: string) =>
  publicAction(
    name,
    `
import { v } from "convex/values";
import { action } from "../_generated/server";
${imports}

export const fetchBucketConfig = action({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => ${body},
});
`,
  );

export const DISPATCHING_HELPER = `
import { internal } from "../../_generated/api";

export async function loadBucketConfig(ctx: any, workspaceId: string) {
  return await ctx.runAction(
    internal.functions.storage.getBindingForGateway,
    { workspaceId },
  );
}
`;
