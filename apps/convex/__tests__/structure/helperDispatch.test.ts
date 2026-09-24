import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  findViolations,
  realModules,
} from "./fixtures.helpers";
import { outsideImports } from "./analyzer/imports.helpers";
import {
  callerOf,
  DISPATCHING_HELPER,
  lib,
} from "./syntheticModules.helpers";

/**
 * WHAT THE IMPORT FOLLOWER REFUSES RATHER THAN FOLLOWS.
 *
 * Following static imports is only a closure if everything that is *not* a
 * static import fails. Each test below is one way to reach a function or a
 * module without writing its name where the analyzer reads names, and each
 * requires a violation on the public function whose reach includes it — the
 * attack does not have to be dangerous for the refusal to fire, because the
 * point is that the analyzer cannot tell. `helperImports.test.ts` has the
 * patterns it follows.
 */

const REAL = realModules();

/** The violations `caller` (plus any helpers) collects, as reason strings. */
function refusalsFor(caller: AnalyzedModule, ...helpers: AnalyzedModule[]) {
  return findViolations([...REAL, ...helpers, caller])
    .filter((violation) => violation.node === `${caller.reference}.fetchBucketConfig`)
    .map((violation) => violation.reason);
}

describe("the follower fails closed on dispatch it cannot resolve", () => {
  test("a dynamic import() of a module of this app", () => {
    const caller = callerOf(
      "lazy",
      "",
      `(await import("./lib/bucketConfig")).loadBucketConfig(ctx, args.workspaceId)`,
    );
    expect(refusalsFor(caller, lib("bucketConfig", DISPATCHING_HELPER))).toEqual([
      expect.stringMatching(/dynamic import\(\)/),
    ]);
  });

  test("a dynamic import() with a computed specifier, even of a package", () => {
    const caller = callerOf(
      "computedImport",
      "",
      "(await import(args.workspaceId)).default(ctx)",
    );
    expect(refusalsFor(caller)).toEqual([
      expect.stringMatching(/dynamic import\(\)/),
    ]);
  });

  test("a lazily loaded package is not a refusal", () => {
    // Non-vacuity for the rule above: a package cannot hold a reference into
    // this app's `internal` object, so a string-literal package import passes.
    const caller = callerOf(
      "satori",
      "",
      `(await import("some-package")).render(args.workspaceId)`,
    );
    expect(refusalsFor(caller)).toEqual([]);
  });

  test("require()", () => {
    const caller = callerOf(
      "required",
      "",
      `require("./lib/bucketConfig").loadBucketConfig(ctx, args.workspaceId)`,
    );
    expect(refusalsFor(caller)).toEqual([expect.stringMatching(/require\(\)/)]);
  });

  test("a namespace import indexed with a computed key", () => {
    const caller = callerOf(
      "indexed",
      `import * as config from "./lib/bucketConfig";`,
      "await config[args.workspaceId](ctx, args.workspaceId)",
    );
    const reasons = refusalsFor(caller, lib("bucketConfig", DISPATCHING_HELPER));
    expect(reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/indexes the namespace import/)]),
    );
  });

  test("a namespace import passed around as a value", () => {
    const caller = callerOf(
      "escaped",
      `import * as config from "./lib/bucketConfig";
import { pick } from "./lib/pick";`,
      "await pick(config)(ctx, args.workspaceId)",
    );
    const pick = lib(
      "pick",
      `export const pick = (m: any) => m[Object.keys(m)[0]];`,
    );
    expect(refusalsFor(caller, lib("bucketConfig", DISPATCHING_HELPER), pick)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/uses the namespace import config as a value/),
      ]),
    );
  });

  test("a lib helper whose ctx.run… target is a parameter, attributed to its caller", () => {
    const runner = lib(
      "runner",
      `export const run = (ctx: any, ref: any, args: any) => ctx.runAction(ref, args);`,
    );
    const caller = callerOf(
      "viaRunner",
      `import { internal } from "../_generated/api";
import { run } from "./lib/runner";`,
      "await run(ctx, internal.functions.files.authorizeFileAccess, args)",
    );
    expect(refusalsFor(caller, runner)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/calls ctx\.run…\(ref\).*in functions\/lib\/runner\.ts#run/),
      ]),
    );
  });

  test("a dispatch method taken off the context", () => {
    const destructured = callerOf(
      "destructured",
      `import { internal } from "../_generated/api";`,
      `{
    const { runAction } = ctx;
    return await runAction(internal.functions.storage.getBindingForGateway, args);
  }`,
    );
    const called = callerOf(
      "called",
      `import { internal } from "../_generated/api";`,
      "await ctx.runAction.call(ctx, internal.functions.files.authorizeFileAccess, args)",
    );
    const reflected = callerOf(
      "reflected",
      "",
      `await Reflect.get(ctx, "runAction")(args.workspaceId, args)`,
    );
    const bracketed = callerOf(
      "bracketed",
      "",
      `await (ctx as any)["runAction"](args.workspaceId, args)`,
    );
    const computed = callerOf(
      "computed",
      "",
      `{
    const method = ctx[args.workspaceId as "runAction"];
    return await method(args.workspaceId as any, args);
  }`,
    );
    expect(refusalsFor(computed)).toEqual(
      expect.arrayContaining([expect.stringMatching(/reads a computed member of ctx/)]),
    );
    expect(refusalsFor(destructured)).toEqual(
      expect.arrayContaining([expect.stringMatching(/destructures runAction/)]),
    );
    expect(refusalsFor(called)).toEqual(
      expect.arrayContaining([expect.stringMatching(/takes \.runAction/)]),
    );
    expect(refusalsFor(reflected)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/uses Reflect/),
        expect.stringMatching(/names "runAction" as a string/),
      ]),
    );
    expect(refusalsFor(bracketed)).toEqual(
      expect.arrayContaining([expect.stringMatching(/names "runAction" as a string/)]),
    );
  });

  test("a computed target hidden behind a type argument, which the text pattern misses", () => {
    const caller = callerOf(
      "generic",
      "",
      "await ctx.runQuery<any>(args.workspaceId as any, {})",
    );
    expect(refusalsFor(caller)).toEqual([
      expect.stringMatching(/calls \.runQuery\(…\) .* not a written-out internal\/api reference/),
    ]);
  });

  test("a written-out reference behind a cast is still a reference", () => {
    // Non-vacuity, and the shape `storage.ts` really uses: `as never`.
    const caller = callerOf(
      "cast",
      `import { internal } from "../_generated/api";`,
      "await ctx.runQuery(internal.functions.files.authorizeFileAccess as never, args)",
    );
    expect(refusalsFor(caller)).toEqual([]);
  });

  test("a call through a computed member of anything", () => {
    const caller = callerOf(
      "table",
      `import { table } from "./lib/table";`,
      "await table[args.workspaceId](ctx)",
    );
    const table = lib(
      "table",
      `export const table: Record<string, (ctx: any) => unknown> = {};`,
    );
    expect(refusalsFor(caller, table)).toEqual(
      expect.arrayContaining([expect.stringMatching(/calls a computed member/)]),
    );
  });

  test("a partial internal reference, indexed later", () => {
    const refs = lib(
      "refs",
      `import { internal } from "../../_generated/api";
export const storageFunctions = internal.functions.storage;`,
    );
    const caller = callerOf(
      "partial",
      `import { storageFunctions } from "./lib/refs";
import { runLater } from "some-package";`,
      "await runLater(ctx, (storageFunctions as any)[args.workspaceId])",
    );
    expect(refusalsFor(caller, refs)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/reference ending at "functions\.storage".*lib\/refs\.ts/),
      ]),
    );
  });

  test("the generated api renamed, imported whole, or re-exported", () => {
    const renamed = callerOf(
      "renamed",
      `import { internal as fns } from "../_generated/api";
import { runLater } from "some-package";`,
      "await runLater(ctx, fns.functions.storage.getBindingForGateway)",
    );
    const whole = callerOf(
      "whole",
      `import * as generated from "../_generated/api";
import { runLater } from "some-package";`,
      "await runLater(ctx, generated.internal.functions.storage.getBindingForGateway)",
    );
    const reexport = lib("api", `export { internal } from "../../_generated/api";`);
    const viaReexport = callerOf(
      "viaReexport",
      `import { internal as fns } from "./lib/api";
import { runLater } from "some-package";`,
      "await runLater(ctx, fns.functions.storage.getBindingForGateway)",
    );
    expect(refusalsFor(renamed)).toEqual(
      expect.arrayContaining([expect.stringMatching(/imports internal from \.\.\/_generated\/api as fns/)]),
    );
    expect(refusalsFor(whole)).toEqual(
      expect.arrayContaining([expect.stringMatching(/imports \.\.\/_generated\/api whole/)]),
    );
    expect(refusalsFor(viaReexport, reexport)).toEqual(
      expect.arrayContaining([expect.stringMatching(/re-exports \.\.\/\.\.\/_generated\/api.*lib\/api\.ts/)]),
    );
  });

  test("an import-equals alias", () => {
    const caller = callerOf(
      "aliased",
      `import config = require("./lib/bucketConfig");`,
      "await config.loadBucketConfig(ctx, args.workspaceId)",
    );
    // Followed like the namespace import it is — and so caught for what it
    // reaches, not refused for its spelling.
    expect(refusalsFor(caller, lib("bucketConfig", DISPATCHING_HELPER))).toEqual([
      expect.stringMatching(/PUBLIC Convex function .* decrypt path/),
    ]);
  });

  test("a relative import naming no module, and a name its module does not export", () => {
    const missingModule = callerOf(
      "missingModule",
      `import { loadBucketConfig } from "./lib/nowhere";`,
      "await loadBucketConfig(ctx, args.workspaceId)",
    );
    const missingName = callerOf(
      "missingName",
      `import { loadBucketConfigs } from "./lib/bucketConfig";`,
      "await loadBucketConfigs(ctx, args.workspaceId)",
    );
    expect(refusalsFor(missingModule)).toEqual([
      expect.stringMatching(/"\.\/lib\/nowhere" names no module/),
    ]);
    expect(refusalsFor(missingName, lib("bucketConfig", DISPATCHING_HELPER))).toEqual([
      expect.stringMatching(/does not export loadBucketConfigs/),
    ]);
  });

  test("a registered function's handler invoked directly", () => {
    const caller = callerOf(
      "inline",
      `import { getBindingForGateway } from "./storage";`,
      "await (getBindingForGateway as any)._handler(ctx, args)",
    );
    expect(refusalsFor(caller)).toEqual(
      expect.arrayContaining([expect.stringMatching(/touches \._handler/)]),
    );
  });
});

/**
 * WHAT THE FOLLOWER DOES NOT WALK, AND WHY THAT IS SAFE.
 *
 * A relative import that leaves `apps/convex` — the gateway's modules under
 * `apps/mcp/src`, `packages/*` — is treated like a package: not walked. That
 * is safe only if nothing such an import can land in is able to dispatch into
 * Convex or open an envelope, so this reads every file those imports reach,
 * transitively, and requires exactly that.
 */
describe("modules outside apps/convex that Convex code imports", () => {
  const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), "../../../.."));

  function resolveOnDisk(repoPath: string): string | null {
    const base = join(REPO_ROOT, repoPath);
    for (const candidate of [
      base,
      base.replace(/\.js$/, ".ts"),
      `${base}.ts`,
      `${base}.js`,
      join(base, "index.ts"),
      join(base, "index.js"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  function reachableFiles(): Map<string, string> {
    const files = new Map<string, string>();
    const queue = outsideImports(REAL).map((found) => found.repoPath);
    expect(queue.length, "no outside imports found — the rule is vacuous").toBeGreaterThan(0);
    while (queue.length > 0) {
      const repoPath = queue.pop()!;
      const file = resolveOnDisk(repoPath);
      expect(file, `${repoPath} does not resolve to a file`).not.toBeNull();
      if (file === null || files.has(file)) continue;
      const source = readFileSync(file, "utf8");
      files.set(file, source);
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        queue.push(
          normalize(join(dirname(file), match[1]!)).slice(REPO_ROOT.length + 1),
        );
      }
    }
    return files;
  }

  test("none of them can dispatch into Convex, open an envelope, or import back in", () => {
    const files = reachableFiles();
    const offenders: string[] = [];
    for (const [file, source] of files) {
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const relative = file.slice(REPO_ROOT.length + 1);
      if (relative.startsWith("apps/convex/")) offenders.push(`${relative} is Convex code`);
      if (/_generated\//.test(code)) offenders.push(`${relative} imports _generated`);
      if (/apps\/convex|\.\.\/convex\//.test(code)) offenders.push(`${relative} imports apps/convex`);
      if (/\bdecryptSecret\b/.test(code)) offenders.push(`${relative} names decryptSecret`);
      if (/\.run(?:Query|Mutation|Action|After|At)\b/.test(code)) {
        offenders.push(`${relative} dispatches a Convex function`);
      }
    }
    expect(files.size).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
