import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  type Classification,
  analyze,
  BARRIER_FORBIDDEN_FIELDS,
  CREDENTIAL_BARRIERS,
  DELIBERATE_KEY_DISCLOSURES,
  DISCLOSED_KEY_FIELD,
  findViolations,
  LIVE_MODULES,
  realModules,
  referencePath,
} from "./fixtures.helpers";

/**
 * Split out of the original `structure.test.ts`. See `fixtures.helpers.ts` for the
 * analyzer this describe block drives and for the full header comment
 * explaining what the whole suite defends.
 */

/**
 * The credential barrier.
 *
 * `CREDENTIAL_BARRIERS` is the one place this file lets a public function
 * reach a decrypted credential, and an exemption nobody probed is
 * indistinguishable from a hole. These are the probes.
 */
describe("the credential barrier is a pin, not an amnesty", () => {
  /** Non-vacuity: a barrier that is not decrypt-capable proves nothing. */
  test("every barrier really does reach the decrypt path, and is internal", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    expect(CREDENTIAL_BARRIERS.size).toBeGreaterThan(0);
    for (const barrier of CREDENTIAL_BARRIERS) {
      expect(
        decryptCapable.has(barrier),
        `${barrier} is listed as a credential barrier but cannot reach a credential — either it is misnamed or the list is stale`,
      ).toBe(true);
      expect(classifications.get(barrier)).toEqual({
        kind: "action",
        isPublic: false,
        isInternal: true,
      });
    }
  });

  /**
   * A barrier's declared return type must not be able to carry a credential.
   *
   * The same check the public functions get, applied to the one internal
   * function public code is allowed to call. It is not a proof — a handler can
   * stuff a secret into a `v.string()` — but it makes the obvious mistake
   * impossible, and the behavioural half lives in `fileContent.test.ts`.
   */
  test("no barrier declares a credential field in its return validator", () => {
    const forbidden = BARRIER_FORBIDDEN_FIELDS;
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const node = `${referencePath(globKey)}.${name}`;
        if (!CREDENTIAL_BARRIERS.has(node)) continue;
        const exportReturns = (value as { exportReturns?: () => string })
          .exportReturns;
        expect(
          typeof exportReturns,
          `${node} must declare a return validator`,
        ).toBe("function");
        const returns = exportReturns!.call(value).toLowerCase();
        for (const field of forbidden) {
          if (
            field === DISCLOSED_KEY_FIELD &&
            DELIBERATE_KEY_DISCLOSURES.has(node)
          )
            continue;
          expect(
            returns.includes(`"${field}"`),
            `${node} returns a "${field}" field`,
          ).toBe(false);
        }
      }
    }
  });

  /** The whole point: the real console read path must be expressible. */
  test("a public function may call a barrier", () => {
    const caller: AnalyzedModule = {
      reference: "functions.console",
      path: "functions/console.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const read = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "read", path: args.path },
    }),
});
`,
      exports: { read: { kind: "action", isPublic: true, isInternal: false } },
    };

    expect(findViolations([...realModules(), caller])).toEqual([]);
  });

  /**
   * …and calling a decrypt-capable function that is *not* a barrier is still
   * the failure it always was. This is the attack the barrier could have
   * quietly legalised for every internal function at once.
   */
  test("a public function may not call a decrypt-capable non-barrier", () => {
    const attack: AnalyzedModule = {
      reference: "functions.probe",
      path: "functions/probe.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const reverify = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.provisioning.verifyStorageBinding, args),
});
`,
      exports: {
        reverify: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.probe.reverify");
  });

  /**
   * Being internal is not what makes something a barrier — being *listed* is.
   * A new internal action that opens a credential launders nothing.
   */
  test("a new internal function does not become a barrier by being internal", () => {
    const attack: AnalyzedModule = {
      reference: "functions.launder",
      path: "functions/launder.ts",
      source: `
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";

export const openStore = internalAction({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});

export const config = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.launder.openStore, args),
});
`,
      exports: {
        openStore: { kind: "action", isPublic: false, isInternal: true },
        config: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.launder.config");
  });

  /**
   * The hole the barrier set would otherwise open, and the reason the analyzer
   * now reads the module preamble.
   *
   * A helper above the first `export const` belongs to no export block. Before
   * this rule its `internal.…` reference was counted for nobody, so a public
   * action could reach a credential through a plain function and the graph saw
   * an empty edge list.
   */
  test("a module-level helper cannot hide a call to the decrypt path", () => {
    const attack: AnalyzedModule = {
      reference: "functions.helper",
      path: "functions/helper.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

async function openStore(ctx: any, workspaceId: any) {
  return await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId,
  });
}

export const peek = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const credential = await openStore(ctx, args.workspaceId);
    return credential.bucket;
  },
});
`,
      exports: { peek: { kind: "action", isPublic: true, isInternal: false } },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.helper.peek");
  });

  /**
   * THE SAME HELPER, MOVED FOUR LINES DOWN, WHICH USED TO BE ENOUGH.
   *
   * The test above places the helper above the first `export const`, which is
   * where the preamble rule looks. `exportBlocks` splits the file on
   * `export const`, so a helper written *after* an exported constant lands in
   * that constant's block instead — and a constant is not a registered Convex
   * function, so it is not a node, so its edge was dropped rather than
   * inherited. Same three lines, same public action, no violation.
   *
   * Found while writing `functions/fastSearchProvision.ts`, whose credential
   * read sits in exactly that position: the analyzer reported it reached no
   * decrypt, and it plainly did. `analyze` now treats every block belonging to
   * a non-function export as unattributed, alongside the preamble.
   *
   * The two tests are kept separate rather than parameterised because they
   * fail for different reasons and the second one is the subtle one: a fix to
   * the preamble rule that did not also cover this position would leave this
   * red and the other green.
   */
  test("a helper after a non-function export cannot hide one either", () => {
    const attack: AnalyzedModule = {
      reference: "functions.helper2",
      path: "functions/helper2.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const SOME_NAME = "not-a-convex-function";

async function openStore(ctx: any, workspaceId: any) {
  return await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId,
  });
}

export const peek = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const credential = await openStore(ctx, args.workspaceId);
    return credential.bucket;
  },
});
`,
      exports: { peek: { kind: "action", isPublic: true, isInternal: false } },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.helper2.peek");
  });

  /**
   * And the same for a `decryptSecret(` call rather than a call edge — the
   * other half of the fail-closed rule, which had the identical gap.
   */
  test("a decrypt after a non-function export taints the module too", () => {
    const attack: AnalyzedModule = {
      reference: "functions.helper3",
      path: "functions/helper3.ts",
      source: `
import { decryptSecret } from "./lib/crypto";
import { action } from "../_generated/server";

export const SOME_NAME = "not-a-convex-function";

async function open(envelope: string, keyset: any, context: any) {
  return await decryptSecret(envelope, keyset, context);
}

export const peek = action({
  args: {},
  handler: async () => await open("v2:…", null, null),
});
`,
      exports: { peek: { kind: "action", isPublic: true, isInternal: false } },
    };

    const { decryptCapable } = analyze([...realModules(), attack]);
    expect(decryptCapable.has("functions.helper3.peek")).toBe(true);
  });
});
