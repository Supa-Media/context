import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  analyze,
  findViolations,
  realModules,
} from "./fixtures.helpers";
import {
  callerOf,
  DISPATCHING_HELPER,
  lib,
  publicAction,
} from "./syntheticModules.helpers";

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
 * the edge is attributed to the registered function that reaches it. The
 * patterns the follower refuses rather than follows are in
 * `helperDispatch.test.ts`.
 */

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

  test("the edge is followed through several helpers, and a cycle between them ends", () => {
    const outer = lib(
      "outer",
      `
import { inner } from "./inner";
export async function outer(ctx: any, id: string, depth = 0): Promise<unknown> {
  return depth > 3 ? null : await inner(ctx, id, depth + 1);
}
`,
    );
    const inner = lib(
      "inner",
      `
import { internal } from "../../_generated/api";
import { outer } from "./outer";
export async function inner(ctx: any, id: string, depth: number): Promise<unknown> {
  if (depth % 2 === 0) return await outer(ctx, id, depth);
  return await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId: id,
  });
}
`,
    );
    const caller = callerOf(
      "chained",
      `import { outer } from "./lib/outer";`,
      "await outer(ctx, args.workspaceId)",
    );

    const { edges, violations } = analyze([
      ...realModules(),
      outer,
      inner,
      caller,
    ]);
    expect(edges.get("functions.chained.fetchBucketConfig")).toContain(
      "functions.storage.getBindingForGateway",
    );
    expect(violations.map((v) => v.node)).toContain(
      "functions.chained.fetchBucketConfig",
    );
  });

  test("a namespace import, a re-export and an `export *` all lead to the same body", () => {
    const helper = lib("bucketConfig", DISPATCHING_HELPER);
    const barrel = lib(
      "barrel",
      `
export { loadBucketConfig as load } from "./bucketConfig";
`,
    );
    const star = lib("star", `export * from "./barrel";`);
    const viaNamespace = callerOf(
      "viaNamespace",
      `import * as config from "./lib/bucketConfig";`,
      "await config.loadBucketConfig(ctx, args.workspaceId)",
    );
    const viaStar = callerOf(
      "viaStar",
      `import { load } from "./lib/star";`,
      "await load(ctx, args.workspaceId)",
    );

    const flagged = findViolations([
      ...realModules(),
      helper,
      barrel,
      star,
      viaNamespace,
      viaStar,
    ]).map((v) => v.node);
    expect(flagged).toContain("functions.viaNamespace.fetchBucketConfig");
    expect(flagged).toContain("functions.viaStar.fetchBucketConfig");
  });

  test("a renamed re-export of the decrypt itself is still the decrypt", () => {
    // Invisible to `importsDecrypt` (no `import { decryptSecret }`) and to
    // `DECRYPT_CALL` (no `decryptSecret(`) in either file that uses it.
    const rename = lib(
      "open",
      `export { decryptSecret as open, requireKeyset } from "./crypto";`,
    );
    const caller = callerOf(
      "renamed",
      `import { open, requireKeyset } from "./lib/open";`,
      "await open(args.workspaceId, requireKeyset(), { workspaceId: args.workspaceId })",
    );

    const { decryptCapable, violations } = analyze([
      ...realModules(),
      rename,
      caller,
    ]);
    expect(decryptCapable.has("functions.renamed.fetchBucketConfig")).toBe(true);
    expect(violations.map((v) => v.node)).toContain(
      "functions.renamed.fetchBucketConfig",
    );
  });

  test("a helper named after an Object.prototype member is still followed", () => {
    // `"valueOf" in {}` is true. A lookup written with `in` took this helper
    // for a registered function of its own module, recorded an edge to a node
    // that does not exist, and never read the body.
    const helper = lib(
      "prototypeNames",
      `
import { internal } from "../../_generated/api";
export async function valueOf(ctx: any, workspaceId: string) {
  return await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId,
  });
}
`,
    );
    const caller = callerOf(
      "prototypeCaller",
      `import { valueOf } from "./lib/prototypeNames";`,
      "await valueOf(ctx, args.workspaceId)",
    );

    expect(
      findViolations([...realModules(), helper, caller]).map((v) => v.node),
    ).toContain("functions.prototypeCaller.fetchBucketConfig");
  });

  test("the module-wide rule is not fooled by an export named after a prototype member either", () => {
    // The text rule's own version of the same lookup: a helper written after
    // `export const constructor` sat in that block, and `"constructor" in
    // exports` called the block a registered function's, so its text was
    // attributed to nobody. `fetchBucketConfig` never names the helper, so
    // only the module-wide rule can catch this one.
    const module: AnalyzedModule = {
      reference: "functions.protoBlock",
      path: "functions/protoBlock.ts",
      source: `
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const fetchBucketConfig = action({
  args: { workspaceId: v.string() },
  handler: async () => null,
});

export const constructor = "not a function";
async function openStore(ctx: any, workspaceId: string) {
  return await ctx.runAction(
    internal.functions.storage.getBindingForGateway,
    { workspaceId },
  );
}
`,
      exports: {
        fetchBucketConfig: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    expect(findViolations([...realModules(), module]).map((v) => v.node)).toContain(
      "functions.protoBlock.fetchBucketConfig",
    );
  });

  test("calling a registered function directly is an edge, without ctx.run…", () => {
    // Convex runs the handler of a registered function you call as a plain
    // function (it warns, and calls it). No `internal.` appears anywhere.
    const caller = callerOf(
      "direct",
      `import { getBindingForGateway } from "./storage";`,
      "await (getBindingForGateway as any)(ctx, args)",
    );

    const { edges, violations } = analyze([...realModules(), caller]);
    expect(edges.get("functions.direct.fetchBucketConfig")).toContain(
      "functions.storage.getBindingForGateway",
    );
    expect(violations.map((v) => v.node)).toContain(
      "functions.direct.fetchBucketConfig",
    );
  });

  test("a helper sitting inside another export's block is attributed to its callers", () => {
    // The text rule gives a helper written after an export to *that* export,
    // which is right for the module-wide fail-closed rule and wrong for the
    // function that actually calls it. It is the shape behind most of the
    // edges the follower added to the real graph — see
    // `docs/decisions/storage-and-credentials/credential-basics.md`.
    const module: AnalyzedModule = {
      reference: "functions.sameFile",
      path: "functions/sameFile.ts",
      source: `
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalQuery } from "../_generated/server";

export const harmless = internalQuery({
  args: {},
  handler: async () => null,
});

async function openStore(ctx: any, workspaceId: string) {
  return await ctx.runAction(
    internal.functions.storage.getBindingForGateway,
    { workspaceId },
  );
}

export const fetchBucketConfig = action({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => await openStore(ctx, args.workspaceId),
});
`,
      exports: {
        harmless: { kind: "query", isPublic: false, isInternal: true },
        fetchBucketConfig: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const { edges, violations } = analyze([...realModules(), module]);
    expect(edges.get("functions.sameFile.fetchBucketConfig")).toContain(
      "functions.storage.getBindingForGateway",
    );
    expect(violations.map((v) => v.node)).toContain(
      "functions.sameFile.fetchBucketConfig",
    );
  });

  test("reach is per declaration: a harmless helper beside a dangerous one stays harmless", () => {
    // Without this the follower would be the module-wide rule again, and a
    // module could never hold one credential helper and one ordinary one.
    const mixed = lib(
      "mixed",
      `${DISPATCHING_HELPER}
export function formatBucketName(name: string) {
  return name.trim().toLowerCase();
}
`,
    );
    const caller = callerOf(
      "tidy",
      `import { formatBucketName } from "./lib/mixed";`,
      "formatBucketName(args.workspaceId)",
    );

    const { edges, violations } = analyze([...realModules(), mixed, caller]);
    expect(edges.get("functions.tidy.fetchBucketConfig")).toEqual([]);
    expect(violations.map((v) => v.node)).not.toContain(
      "functions.tidy.fetchBucketConfig",
    );
  });

  test("on the real codebase, the follower is live: it finds an edge the text rule cannot", () => {
    // `submitForm`'s handler is one line calling `runForm`, a helper that sits
    // in `formActor`'s export block. Every one of its three edges comes from
    // following that name.
    const { edges, violations } = analyze(realModules());
    expect(edges.get("functions.forms.submitForm")).toEqual(
      expect.arrayContaining([
        "functions.files.authorizeFileAccess",
        "functions.forms.formActor",
        "functions.files.runFileOperation",
      ]),
    );
    expect(violations).toEqual([]);
  });
});
