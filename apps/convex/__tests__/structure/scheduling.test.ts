import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  exportBlocks,
  findViolations,
  realModules,
} from "./fixtures";

/**
 * Split out of the original `structure.test.ts`. See `fixtures.ts` for the
 * analyzer this describe block drives and for the full header comment
 * explaining what the whole suite defends.
 */

/**
 * Scheduling versus calling.
 *
 * `applyBinding` queues `verifyStorageBinding`, which decrypts. The graph
 * treats that as a non-propagating edge, and these are the tests that say
 * exactly how far that exemption goes — because an exemption nobody probed is
 * indistinguishable from a hole.
 */
describe("a scheduled call is not a call", () => {
  /** The whole point: the real connect flow must be expressible. */
  test("a public function may schedule a decrypting internal function", () => {
    const scheduling: AnalyzedModule = {
      reference: "functions.connect",
      path: "functions/connect.ts",
      source: `
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";

export const connect = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.storage.getBindingForGateway,
      args,
    );
    return null;
  },
});
`,
      exports: {
        connect: { kind: "mutation", isPublic: true, isInternal: false },
      },
    };

    expect(findViolations([...realModules(), scheduling])).toEqual([]);
  });

  /**
   * The exemption is positional, not per-function. Naming the same target in
   * the scheduler's argument slot must not launder a real call to it
   * elsewhere in the same body.
   */
  test("scheduling a function does not excuse also calling it", () => {
    const attack: AnalyzedModule = {
      reference: "functions.both",
      path: "functions/both.ts",
      source: `
export const connect = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.storage.getBindingForGateway,
      args,
    );
    return await ctx.runAction(
      internal.functions.storage.getBindingForGateway,
      args,
    );
  },
});
`,
      exports: {
        connect: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.both.connect");
  });

  /** A scheduled target still has to be nameable. */
  test("refuses a scheduled target that cannot be resolved statically", () => {
    const attack: AnalyzedModule = {
      reference: "functions.dynamicSchedule",
      path: "functions/dynamicSchedule.ts",
      source: `
export const queue = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, (internal as any).functions.storage[args.name], {});
  },
});
`,
      exports: {
        queue: { kind: "mutation", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack])
        .map((v) => v.reason)
        .join(" "),
    ).toMatch(/not a statically resolvable internal function reference/);
  });

  /** …and it has to be internal. Scheduling a public function is not a thing. */
  test("refuses a scheduled target that is a public api reference", () => {
    const attack: AnalyzedModule = {
      reference: "functions.publicSchedule",
      path: "functions/publicSchedule.ts",
      source: `
export const queue = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, api.functions.storage.getStorageBinding, {});
  },
});
`,
      exports: {
        queue: { kind: "mutation", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack])
        .map((v) => v.reason)
        .join(" "),
    ).toMatch(/not a statically resolvable internal function reference/);
  });

  /**
   * Non-vacuity, again: the exemption is only meaningful if the target it
   * exempts really is decrypt-capable.
   */
  test("the function the real connect flow schedules does reach the decrypt path", () => {
    const modules = realModules();
    const storage = modules.find((m) => m.path === "functions/storage.ts");
    const { blocks } = exportBlocks(storage!.source);
    expect(blocks.get("applyBinding")).toMatch(
      /scheduler\.runAfter\(\s*0,\s*internal\.functions\.provisioning\.verifyStorageBinding/,
    );

    const provisioning = modules.find(
      (m) => m.path === "functions/provisioning.ts",
    );
    const provisioningBlocks = exportBlocks(provisioning!.source).blocks;
    // It reaches the decrypt path through `getBindingForGateway`…
    expect(provisioningBlocks.get("verifyStorageBinding")).toContain(
      "internal.functions.storage.getBindingForGateway",
    );
    // …and it is internal, so nothing but the scheduler can reach it.
    expect(provisioning!.exports.verifyStorageBinding).toEqual({
      kind: "action",
      isPublic: false,
      isInternal: true,
    });

    // Swap the schedule for a call — everything else about the module
    // identical — and the same analyzer rejects it. That is what makes the
    // exemption a distinction rather than a blanket amnesty for
    // `verifyStorageBinding`.
    const called: AnalyzedModule = {
      reference: "functions.storageCalling",
      path: "functions/storageCalling.ts",
      exports: storage!.exports,
      source: storage!.source
        .replace(/ctx\.scheduler\.runAfter\(\s*0,/, "ctx.runAction(")
        // Re-point the clone's internal references at itself, so the public
        // `bindStorage` reaches the clone's `applyBinding` and not the real
        // one, which still merely schedules.
        .split("internal.functions.storage.")
        .join("internal.functions.storageCalling."),
    };
    expect(
      findViolations([...realModules(), called]).map((v) => v.node),
    ).toContain("functions.storageCalling.bindStorage");
  });
});
