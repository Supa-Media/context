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
 * Build the graph and return every way a public function can reach a decrypt.
 *
 * Pure over its input so the same analyzer can be pointed at the real codebase
 * and at a synthetic attack module — see the final test.
 */
function findViolations(modules: AnalyzedModule[]): Violation[] {
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

      const targets: string[] = [];
      let match: RegExpExecArray | null;
      CONVEX_REFERENCE.lastIndex = 0;
      while ((match = CONVEX_REFERENCE.exec(body)) !== null) {
        const target = match[1].slice(1);
        if (knownNodes.has(target)) targets.push(target);
      }
      edges.set(node, targets);

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
      if (targets.some((target) => decryptCapable.has(target))) {
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

  return violations;
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
  test("the analyzer actually sees the whole control plane", () => {
    const modules = realModules();
    const paths = modules.map((m) => m.path);

    // If a module stops being globbed, every assertion below silently passes
    // over it. Pin the ones that must be in scope.
    expect(paths).toContain("functions/storage.ts");
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
