/// <reference types="vite/client" />
/**
 * THE CREDENTIAL BOUNDARY, ENFORCED STRUCTURALLY.
 *
 * `SECURITY.md` commitment #2 says storage secrets are "decryptable only by
 * internal server code paths — never returned by any client-callable
 * function". This file is what makes that a property of the codebase rather
 * than a habit.
 *
 * ## What the previous guard was, and how it fell over
 *
 * It enumerated the exports of `functions/storage.ts` and asserted that no
 * *public* one had `secret`, `credential`, or `decrypt` in its **name**. Two
 * holes, and an adversarial review walked through both at once by adding a new
 * file:
 *
 * ```ts
 * // functions/gateway.ts
 * export const fetchBucketConfig = action({
 *   args: { workspaceId: v.id("workspaces") },
 *   handler: async (ctx, args) =>
 *     await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
 * });
 * ```
 *
 * An unauthenticated caller got a decrypted secret and the whole suite stayed
 * green: the loop never looked outside one file, and `fetchBucketConfig`
 * contains none of the three words. A guard a rename defeats is not a guard,
 * and a guard scoped to the file you already trust is not a guard either.
 *
 * ## What this asserts instead
 *
 * It walks **every** Convex module, classifies each exported function by what
 * Convex itself says it is (`isPublic` / `isInternal` — not by its name), and
 * builds the call graph from `ctx.runQuery/runMutation/runAction(internal.…)`
 * references. Then: **no public function may transitively reach the decrypt
 * path.** Rename anything you like; add any file you like; the reachability is
 * what fails.
 *
 * Two supporting rules make that closure honest:
 *
 *  - **No dynamic dispatch.** A `ctx.runAction(someComputedRef)` cannot be
 *    followed statically, so it is refused outright rather than assumed safe.
 *    Otherwise `ctx.runAction((internal as any).functions.storage[name])`
 *    walks straight through the graph.
 *  - **Fail closed on helpers.** If a module reaches `decryptSecret` from
 *    somewhere other than inside a single exported function's body, the whole
 *    module is treated as decrypt-capable. A false positive costs a
 *    restructure; a false negative costs a customer's bucket.
 *
 * And the analysis is proved non-vacuous: the last test feeds the reviewer's
 * exact attack module through the same analyzer and requires it to be caught.
 */

import { describe, expect, test } from "vitest";

// Every Convex module, twice: once as source to analyze, once as a live module
// so the public/internal classification comes from Convex rather than from a
// naming convention. The ignore list matches `test.setup.ts`.
const RAW_SOURCES = import.meta.glob(
  ["../**/*.ts", "!../__tests__/**", "!../node_modules/**", "!../*.config.ts", "!../*.setup.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const LIVE_MODULES = import.meta.glob(
  ["../**/*.ts", "!../__tests__/**", "!../node_modules/**", "!../*.config.ts", "!../*.setup.ts"],
  { eager: true },
) as Record<string, Record<string, unknown>>;

/** What Convex records on a registered function. */
interface Classification {
  isPublic: boolean;
  isInternal: boolean;
  kind: "query" | "mutation" | "action";
}

interface AnalyzedModule {
  /** Dotted reference path, e.g. `functions.storage`. */
  reference: string;
  /** Human-readable path for failure messages. */
  path: string;
  source: string;
  exports: Record<string, Classification>;
}

interface Violation {
  node: string;
  reason: string;
}

/** `../functions/lib/crypto.ts` → `functions.lib.crypto` */
function referencePath(globKey: string): string {
  return globKey
    .replace(/^\.\.\//, "")
    .replace(/\.ts$/, "")
    .split("/")
    .join(".");
}

function classify(value: unknown): Classification | null {
  const fn = value as {
    isQuery?: boolean;
    isMutation?: boolean;
    isAction?: boolean;
    isPublic?: boolean;
    isInternal?: boolean;
  } | null;
  // A registered Convex function is a *callable* carrying these flags, not a
  // plain object — checking only for "object" here silently classified
  // nothing, which is how a guard ends up passing vacuously.
  if (fn === null || (typeof fn !== "object" && typeof fn !== "function")) {
    return null;
  }
  const kind = fn.isQuery
    ? "query"
    : fn.isMutation
      ? "mutation"
      : fn.isAction
        ? "action"
        : null;
  if (kind === null) return null;
  return {
    kind,
    isPublic: fn.isPublic === true,
    isInternal: fn.isInternal === true,
  };
}

/**
 * Split a module's source into the block belonging to each `export const`.
 *
 * A block runs from its own declaration to the next one, so anything defined
 * between two exports is attributed to the earlier of the two. That is
 * deliberate: it over-attributes rather than under-attributes, and
 * over-attribution only ever produces a failing test.
 */
function exportBlocks(source: string): {
  preamble: string;
  blocks: Map<string, string>;
} {
  const declaration = /^export const (\w+)\s*=/gm;
  const found: { name: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    found.push({ name: match[1], index: match.index });
  }

  const preamble =
    found.length === 0 ? source : source.slice(0, found[0].index);
  const blocks = new Map<string, string>();
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].index : source.length;
    blocks.set(found[i].name, source.slice(found[i].index, end));
  }
  return { preamble, blocks };
}

/** Strip `import { … } from "…"` lines: importing a symbol is not calling it. */
function withoutImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
}

const DECRYPT_CALL = /\bdecryptSecret\s*\(/;
const CONVEX_REFERENCE = /\b(?:internal|api)((?:\.[A-Za-z_$][\w$]*)+)/g;
const RUN_CALL = /\.run(?:Query|Mutation|Action)\(\s*([^,)\s]*)/g;
/**
 * `ctx.scheduler.runAfter(delay, internal.x.y, …)` / `runAt(when, …)`.
 *
 * The delay expression is matched as "everything up to the first comma", so a
 * delay that itself contains a comma (`Math.max(0, n)`) will not match here.
 * That is a fail-closed miss, not a hole: with no scheduler span recorded, the
 * reference that follows is counted as an ordinary call edge and propagates
 * taint exactly as before.
 */
const SCHEDULE_CALL = /\.scheduler\.run(?:After|At)\(\s*[^,]*,\s*([^,)\s]*)/g;

/**
 * THE CREDENTIAL BARRIER SET.
 *
 * Every function here is decrypt-capable **and** may be called by a public
 * function. Taint stops at a barrier: its callers do not inherit it.
 *
 * That is a real relaxation of the property this file used to enforce — that
 * no public function could reach a credential *at all* — and it was added
 * deliberately, because the alternative is that a person can never read or
 * write their own bucket from the console. A read path has to obtain a
 * credential somewhere, and no static rule can prove that a function which
 * holds one does not leak it: a `returns: v.string()` handler could return
 * `credential.secretAccessKey` and satisfy any validator-based check.
 *
 * So the barrier is not a *proof*, it is a **pin**. What it buys:
 *
 *  - The set is enumerated here, by name. Adding a second one is a diff to
 *    this file that a reviewer sees, exactly like adding to the
 *    decrypt-capable list below.
 *  - Everything else is unchanged. A public function that calls
 *    `getBindingForGateway` directly — the reviewer's original attack — still
 *    fails, because that function is not a barrier. So does one that calls
 *    `verifyStorageBinding`, or any *new* internal function that opens a
 *    credential without being listed here.
 *  - The barrier's own return validator is checked for credential fields (see
 *    the test below), and `__tests__/fileContent.test.ts` asserts
 *    behaviourally that no credential and no note content reaches a caller,
 *    an audit row, or an error.
 *
 * A barrier earns its place by being small enough to read in one sitting and
 * by doing exactly one thing with the credential. `runFileOperation` builds one
 * `S3Store` and hands it to `lib/fileOps.ts`, which has no access to the
 * credential at all. **Do not add one without that property.**
 */
const CREDENTIAL_BARRIERS = new Set(["functions.files.runFileOperation"]);

/**
 * Build the graph and return every way a public function can reach a decrypt.
 *
 * Pure over its input so the same analyzer can be pointed at the real codebase
 * and at a synthetic attack module — see the final test.
 */
function analyze(modules: AnalyzedModule[]): {
  violations: Violation[];
  decryptCapable: Set<string>;
} {
  const violations: Violation[] = [];
  const decryptCapable = new Set<string>();
  const edges = new Map<string, string[]>();
  const classifications = new Map<string, Classification>();
  const knownNodes = new Set<string>();

  for (const module of modules) {
    for (const name of Object.keys(module.exports)) {
      knownNodes.add(`${module.reference}.${name}`);
    }
  }

  for (const module of modules) {
    const { preamble, blocks } = exportBlocks(module.source);

    // Fail closed: a decrypt reached from a module-level helper cannot be
    // attributed to one export, so every export in the module inherits it.
    const moduleWideTaint = DECRYPT_CALL.test(withoutImports(preamble));

    // Same fail-closed rule for *call edges*, and it is the hole the barrier
    // set would otherwise open. A module-level helper like
    //
    //   async function openStore(ctx, id) {
    //     return await ctx.runAction(internal.functions.storage.getBindingForGateway, …);
    //   }
    //
    // sits above the first `export const`, so it belongs to no export block and
    // its reference was previously counted for nobody — a public action could
    // call it and the graph would see nothing. Every export in the module now
    // inherits references found in the preamble.
    const preambleTargets: string[] = [];
    {
      const text = withoutImports(preamble);
      let found: RegExpExecArray | null;
      CONVEX_REFERENCE.lastIndex = 0;
      while ((found = CONVEX_REFERENCE.exec(text)) !== null) {
        const target = found[1].slice(1);
        if (knownNodes.has(target)) preambleTargets.push(target);
      }
    }

    for (const [name, classification] of Object.entries(module.exports)) {
      const node = `${module.reference}.${name}`;
      classifications.set(node, classification);

      // An export the block splitter cannot locate — `export const { a, b } =`
      // (how the auth framework re-exports its functions), or a
      // `const x = query(…); export { x }` — falls back to the whole module as
      // its body. Conservative on purpose: a function whose definition cannot
      // be pinpointed inherits everything its file reaches, so hiding a call
      // behind an indirect export makes the analysis *more* suspicious of it,
      // not blind to it.
      const body = blocks.get(name) ?? module.source;
      if (moduleWideTaint || DECRYPT_CALL.test(body)) decryptCapable.add(node);

      let match: RegExpExecArray | null;

      // Scheduling is not calling, and the difference is the whole reason the
      // connect flow can exist. `ctx.runQuery/runMutation/runAction` awaits a
      // value and hands it to the caller, so a public function that runs a
      // decrypting internal function has that credential in its own scope —
      // that is the edge this graph exists to forbid. `ctx.scheduler.runAfter`
      // enqueues a job in a *separate* transaction whose return value the
      // scheduler discards; there is no channel back to whoever queued it, so
      // it cannot hand a credential to a public caller.
      //
      // The distinction is load-bearing rather than a convenience: without it
      // no public function could ever trigger a bucket probe, and "verify the
      // credential the user just pasted" would have to be a polling cron
      // chosen to satisfy a static check rather than because it is the right
      // design.
      //
      // Two things keep it honest, both enforced below:
      //   - a scheduled target must still be a statically resolvable
      //     `internal.…` reference, so nothing hides behind a computed name
      //     or reaches a *public* function, and
      //   - only the reference in the scheduler's argument position is
      //     exempted. The same function named anywhere else in the same body
      //     is still an ordinary call edge.
      //
      // What it does not prove is that a scheduled job never *stores* a
      // plaintext credential somewhere a public query could read it. No static
      // rule can; `__tests__/provisioning.test.ts` asserts behaviourally that
      // the credential appears in no recorded error, audit event, or return
      // value, and the public return-validator check below is the second net.
      const scheduledSpans: [number, number][] = [];
      SCHEDULE_CALL.lastIndex = 0;
      while ((match = SCHEDULE_CALL.exec(body)) !== null) {
        const argument = match[1];
        const start = match.index + match[0].length - argument.length;
        scheduledSpans.push([start, start + argument.length]);
        if (!/^internal\./.test(argument)) {
          violations.push({
            node,
            reason: `schedules ${argument || "<unparsed>"}, which is not a statically resolvable internal function reference — a scheduled target must be nameable, or the credential-reachability graph cannot see what was queued`,
          });
        }
      }
      const isScheduledReference = (index: number) =>
        scheduledSpans.some(([start, end]) => index >= start && index < end);

      const targets: string[] = [];
      CONVEX_REFERENCE.lastIndex = 0;
      while ((match = CONVEX_REFERENCE.exec(body)) !== null) {
        const target = match[1].slice(1);
        if (!knownNodes.has(target)) continue;
        if (isScheduledReference(match.index)) continue;
        targets.push(target);
      }
      edges.set(node, [...targets, ...preambleTargets]);

      // Every `ctx.runX` must name a statically resolvable function, or the
      // graph above is a fiction.
      RUN_CALL.lastIndex = 0;
      while ((match = RUN_CALL.exec(body)) !== null) {
        const argument = match[1];
        if (!/^(internal|api)\./.test(argument)) {
          violations.push({
            node,
            reason: `calls ctx.run…(${argument || "<unparsed>"}), which cannot be resolved statically — the credential-reachability graph cannot see through it`,
          });
        }
      }
    }
  }

  // Propagate capability backwards until nothing new is tainted.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, targets] of edges) {
      if (decryptCapable.has(node)) continue;
      // Taint stops at a barrier — see CREDENTIAL_BARRIERS above for what
      // that buys and, just as importantly, what it does not.
      if (
        targets.some(
          (target) => decryptCapable.has(target) && !CREDENTIAL_BARRIERS.has(target),
        )
      ) {
        decryptCapable.add(node);
        changed = true;
      }
    }
  }

  for (const node of decryptCapable) {
    const classification = classifications.get(node);
    if (classification?.isPublic) {
      violations.push({
        node,
        reason:
          "is a PUBLIC Convex function that can transitively reach the storage-secret decrypt path",
      });
    }
  }

  return { violations, decryptCapable };
}

function findViolations(modules: AnalyzedModule[]): Violation[] {
  return analyze(modules).violations;
}

function realModules(): AnalyzedModule[] {
  return Object.keys(RAW_SOURCES).map((globKey) => {
    const exports: Record<string, Classification> = {};
    for (const [name, value] of Object.entries(LIVE_MODULES[globKey] ?? {})) {
      const classification = classify(value);
      if (classification !== null) exports[name] = classification;
    }
    return {
      reference: referencePath(globKey),
      path: globKey.replace(/^\.\.\//, ""),
      source: RAW_SOURCES[globKey],
      exports,
    };
  });
}

describe("no public function can reach a storage secret", () => {
/**
   * Pin the exact set of functions that can reach a decrypted credential.
   *
   * The scheduling exemption above is correct but load-bearing: a public
   * function may now *trigger* a decrypt, and no static rule can prove the
   * scheduled job never stores that plaintext somewhere a public query reads.
   * What remains checkable is the size of the blast radius — so the set is
   * enumerated here rather than merely bounded.
   *
   * If this test fails you have added a new way to reach a storage credential.
   * That may well be correct. It is not something to fix by editing the list
   * and moving on: whatever you added now holds other people's bucket keys, and
   * needs the same scrutiny `getBindingForGateway` got. Add it deliberately,
   * and say why in the commit.
   */
  test("only these functions can reach a decrypted credential", () => {
    const { decryptCapable } = analyze(realModules());

    expect([...decryptCapable].sort()).toEqual([
      // The decrypt itself. internalAction, so Convex refuses to route it
      // from a client.
      "functions.storage.getBindingForGateway",
      // Re-encrypts every binding during a key rotation. Reads plaintext by
      // definition; internal, batched, never client-reachable.
      "functions.storage.rekeyStorageBindings",
      // Builds a real S3Store to probe the bucket a user just connected.
      // Reached only by a schedule edge from bindStorage.
      "functions.provisioning.verifyStorageBinding",
      // THE FILE EDITOR'S CREDENTIAL BARRIER. Builds one S3Store for one
      // file operation and hands it to lib/fileOps.ts, which never sees the
      // credential. internalAction, and the only member of
      // CREDENTIAL_BARRIERS — read that comment before adding a second.
      "functions.files.runFileOperation",
    ].sort());
  });

  test("every decrypt-capable function is internal", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    // Belt to the violations check's braces: that test reports public
    // reachers, this one asserts the positive property directly, so a bug in
    // the reporting loop cannot make both pass.
    for (const node of decryptCapable) {
      expect(classifications.get(node)?.isPublic, `${node} must not be public`).toBe(false);
    }
  });

  test("the analyzer actually sees the whole control plane", () => {
    const modules = realModules();
    const paths = modules.map((m) => m.path);

    // If a module stops being globbed, every assertion below silently passes
    // over it. Pin the ones that must be in scope.
    expect(paths).toContain("functions/storage.ts");
    expect(paths).toContain("functions/provisioning.ts");
    expect(paths).toContain("functions/grants.ts");
    expect(paths).toContain("functions/audit.ts");
    expect(paths).toContain("functions/workspaces.ts");
    expect(paths).toContain("functions/names.ts");

    const total = modules.reduce(
      (sum, module) => sum + Object.keys(module.exports).length,
      0,
    );
    expect(total).toBeGreaterThan(15);
  });

  test("every Convex function is either public or internal, never neither", () => {
    for (const module of realModules()) {
      for (const [name, classification] of Object.entries(module.exports)) {
        expect(
          classification.isPublic !== classification.isInternal,
          `${module.path}#${name} is classified as neither public nor internal (or as both)`,
        ).toBe(true);
      }
    }
  });

  test("the decrypt path exists and is reachable only from internal functions", () => {
    const violations = findViolations(realModules());
    expect(
      violations.map((v) => `${v.node} ${v.reason}`),
      "a public Convex function can reach the credential decrypt path",
    ).toEqual([]);
  });

  /**
   * The graph must actually find the decrypt path, or the test above passes
   * because it found nothing at all.
   */
  test("the analysis is not vacuous — it locates the real decrypting function", () => {
    const modules = realModules();
    const storage = modules.find((m) => m.path === "functions/storage.ts");
    expect(storage).toBeDefined();

    const { blocks } = exportBlocks(storage!.source);
    expect(DECRYPT_CALL.test(blocks.get("getBindingForGateway") ?? "")).toBe(true);
    expect(storage!.exports.getBindingForGateway).toEqual({
      kind: "action",
      isPublic: false,
      isInternal: true,
    });
  });

  /**
   * No public function's declared return type may carry a credential field.
   *
   * A second, independent net: reachability catches a public function that
   * *calls* the decrypt path, this catches one that returns a credential it
   * obtained some other way (a raw envelope read straight off the row, say).
   * It reads the validator Convex will actually enforce, not the source.
   */
  test("no public function declares a credential field in its return validator", () => {
    const forbidden = ["secretaccesskey", "encryptedsecretaccesskey"];
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const classification = classify(value);
        if (classification === null || !classification.isPublic) continue;

        const exportReturns = (value as { exportReturns?: () => string })
          .exportReturns;
        if (typeof exportReturns !== "function") continue;

        const returns = exportReturns.call(value).toLowerCase();
        for (const field of forbidden) {
          expect(
            returns.includes(`"${field}"`),
            `${globKey}#${name} is public and returns a "${field}" field`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * The reviewer's attack, run through the same analyzer.
   *
   * This is the test that says what the guard is worth. `functions/gateway.ts`
   * below is the file that defeated the old name-based check verbatim: a
   * public action, innocuously named, that launders the internal decrypting
   * action for an unauthenticated caller.
   */
  test("catches a new public module that launders the internal decrypting action", () => {
    const attack: AnalyzedModule = {
      reference: "functions.gateway",
      path: "functions/gateway.ts",
      source: `
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const fetchBucketConfig = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});
`,
      exports: {
        fetchBucketConfig: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.gateway.fetchBucketConfig",
    );
    expect(violations[0].reason).toMatch(/decrypt path/);
  });

  /** The other way through: hide the call target behind a computed reference. */
  test("refuses a ctx.run… call whose target cannot be resolved statically", () => {
    const attack: AnalyzedModule = {
      reference: "functions.dynamic",
      path: "functions/dynamic.ts",
      source: `
export const passthrough = action({
  args: { name: v.string() },
  handler: async (ctx, args) =>
    await ctx.runAction((internal as any).functions.storage[args.name], {}),
});
`,
      exports: {
        passthrough: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.reason).join(" ")).toMatch(
      /cannot be resolved statically/,
    );
  });

  /** The fourth: launder it through an indirect export the splitter can't see. */
  test("catches a decrypt reached from a function that is not a plain `export const`", () => {
    const attack: AnalyzedModule = {
      reference: "functions.indirect",
      path: "functions/indirect.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

const passthrough = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});

export { passthrough };
`,
      exports: {
        passthrough: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.indirect.passthrough",
    );
  });

  /** And the fifth: a public function in the same file as the decrypt. */
  test("catches a public function that decrypts inline, whatever it is called", () => {
    const attack: AnalyzedModule = {
      reference: "functions.innocuous",
      path: "functions/innocuous.ts",
      source: `
import { decryptSecret, requireKeyset } from "./lib/crypto";

export const health = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("storageBindings").first();
    return await decryptSecret(row.encryptedSecretAccessKey, requireKeyset(), {
      workspaceId: args.workspaceId,
    });
  },
});
`,
      exports: { health: { kind: "query", isPublic: true, isInternal: false } },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain("functions.innocuous.health");
  });
});

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
      exports: { queue: { kind: "mutation", isPublic: true, isInternal: false } },
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
      exports: { queue: { kind: "mutation", isPublic: true, isInternal: false } },
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

    const provisioning = modules.find((m) => m.path === "functions/provisioning.ts");
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
      expect(decryptCapable.has(barrier), `${barrier} is listed as a credential barrier but cannot reach a credential — either it is misnamed or the list is stale`).toBe(true);
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
    const forbidden = ["secretaccesskey", "encryptedsecretaccesskey", "accesskeyid"];
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const node = `${referencePath(globKey)}.${name}`;
        if (!CREDENTIAL_BARRIERS.has(node)) continue;
        const exportReturns = (value as { exportReturns?: () => string }).exportReturns;
        expect(typeof exportReturns, `${node} must declare a return validator`).toBe(
          "function",
        );
        const returns = exportReturns!.call(value).toLowerCase();
        for (const field of forbidden) {
          expect(returns.includes(`"${field}"`), `${node} returns a "${field}" field`).toBe(
            false,
          );
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
      exports: { reverify: { kind: "action", isPublic: true, isInternal: false } },
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
});
