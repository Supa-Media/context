import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  analyze,
  findViolations,
  realModules,
} from "./fixtures";

/**
 * LAUNDERING THROUGH A HELPER MODULE.
 *
 * The graph's nodes are registered Convex functions, and until this file the
 * edges between them were read only from the text of each registered
 * function's own export block. A plain module under `functions/lib/` registers
 * nothing, so a `ctx.runAction(internal.…)` or a `decryptSecret(` written
 * there belonged to no node: a public function that imported and called the
 * helper contained neither string, and passed.
 *
 * `DECRYPT_IMPORTERS` closed half of that for the decrypt itself, by
 * enumerating the modules allowed to import it. Nothing closed it for a call
 * edge — a helper dispatching to `getBindingForGateway` imports nothing but
 * `internal` — so the codebase avoided it by convention, and the convention is
 * what kept `storage.ts`, `shares.ts` and `http.ts` from being decomposed.
 *
 * These are synthetic modules run through the same analyzer as the real
 * codebase. Each one is the smallest version of an attack, and each asserts
 * the edge is attributed to the registered function that reaches it.
 */

const lib = (name: string, source: string): AnalyzedModule => ({
  reference: `functions.lib.${name}`,
  path: `functions/lib/${name}.ts`,
  source,
  exports: {},
});

const publicAction = (
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

describe("the analyzer follows static imports into helper modules", () => {
  test("a public function reaching the decrypting action through a lib helper is caught", () => {
    const helper = lib(
      "bucketConfig",
      `
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";

export async function loadBucketConfig(ctx: ActionCtx, workspaceId: string) {
  return await ctx.runAction(
    internal.functions.storage.getBindingForGateway,
    { workspaceId },
  );
}
`,
    );
    const caller = publicAction(
      "gateway",
      `
import { v } from "convex/values";
import { action } from "../_generated/server";
import { loadBucketConfig } from "./lib/bucketConfig";

export const fetchBucketConfig = action({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => await loadBucketConfig(ctx, args.workspaceId),
});
`,
    );

    const { violations, decryptCapable } = analyze([
      ...realModules(),
      helper,
      caller,
    ]);
    expect(decryptCapable.has("functions.gateway.fetchBucketConfig")).toBe(true);
    expect(violations.map((v) => v.node)).toContain(
      "functions.gateway.fetchBucketConfig",
    );
  });

  test("a public function calling a lib helper that decrypts inline is caught", () => {
    const helper = lib(
      "openEnvelope",
      `
import { decryptSecret, requireKeyset } from "./crypto";

export const openEnvelope = (envelope: string, workspaceId: string) =>
  decryptSecret(envelope, requireKeyset(), { workspaceId });
`,
    );
    const caller = publicAction(
      "health",
      `
import { v } from "convex/values";
import { action } from "../_generated/server";
import { openEnvelope } from "./lib/openEnvelope";

export const fetchBucketConfig = action({
  args: { envelope: v.string(), workspaceId: v.string() },
  handler: async (_ctx, args) =>
    await openEnvelope(args.envelope, args.workspaceId),
});
`,
    );

    expect(
      findViolations([...realModules(), helper, caller]).map((v) => v.node),
    ).toContain("functions.health.fetchBucketConfig");
  });
});
