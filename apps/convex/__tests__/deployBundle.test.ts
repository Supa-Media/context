/**
 * Nothing under `__tests__/` is ever deployed as a Convex module.
 *
 * `convex deploy` bundles every file under `apps/convex` it recognises as an
 * entry point. It skips only a handful of shapes: `_generated/`, dotfiles,
 * `schema.ts`, names containing a space, and — the one this directory relies
 * on — any file whose name has more than one dot. `foo.test.ts` and
 * `foo.helpers.ts` are skipped; a plain `fixtures.ts` is not.
 *
 * That went wrong once: splitting the large test files put a `fixtures.ts`
 * beside each group, the deploy bundled them, and `test.setup.ts`'s
 * `import.meta` refused to load in the Convex runtime — every staging deploy
 * failed until they were renamed `fixtures.helpers.ts`. No unit test ran the
 * bundler, so CI stayed green the whole time. This mirrors the bundler's rule
 * (convex/dist/cjs/bundler/index.js, `entryPoints`) so the next one fails here.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const CONVEX_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY_POINT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"];

/** Every path under `dir` that `convex deploy` would bundle as a module. */
function deployedModules(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(CONVEX_ROOT, full);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "_generated" || name.startsWith(".")) return [];
      return deployedModules(full);
    }
    if (!ENTRY_POINT_EXTENSIONS.some((ext) => name.endsWith(ext))) return [];
    if (name.startsWith(".") || name.startsWith("#")) return [];
    if (name === "schema.ts" || name === "schema.js") return [];
    if ((name.match(/\./g) ?? []).length > 1) return [];
    if (rel.includes(" ")) return [];
    return [rel.split("\\").join("/")];
  });
}

describe("what convex deploy bundles", () => {
  const modules = deployedModules(CONVEX_ROOT);

  test("the rule sees the real functions, so it is not vacuous", () => {
    expect(modules).toContain("functions/files.ts");
    expect(modules).toContain("http.ts");
  });

  test("no test file or test helper is deployed", () => {
    const offenders = modules.filter((path) => path.startsWith("__tests__/"));
    expect(offenders).toEqual([]);
  });
});
