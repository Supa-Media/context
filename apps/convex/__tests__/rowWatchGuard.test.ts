/**
 * Every mutation in this deployment is built through `functions/lib/rowWatch/mutations.ts`, so every write to a
 * workspace's rows or access reaches the workspace's object when it is judged there. A file that builds one from
 * `_generated/server` (or from `convex/server`'s generic builders) would write rows the object never hears of, and
 * the object would go on judging reads by rules that were narrowed: this test refuses it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..");
const WRAPPER = "functions/lib/rowWatch/mutations.ts";

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "_generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** The names a file imports from a module matching `from`. */
export function importedFrom(source: string, from: RegExp): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (match[1] || !from.test(match[3])) continue;
    for (const raw of match[2].split(",")) {
      const name = raw.trim();
      if (name !== "" && !name.startsWith("type ")) names.push(name.split(/\s+as\s+/)[0]);
    }
  }
  return names;
}

const RAW_BUILDERS = /^(mutation|internalMutation|mutationGeneric|internalMutationGeneric)$/;

export function rawMutationBuilders(source: string): string[] {
  return [
    ...importedFrom(source, /_generated\/server$/),
    ...importedFrom(source, /^convex\/server$/),
  ].filter((name) => RAW_BUILDERS.test(name));
}

describe("every mutation is watched", () => {
  test("no file but the wrapper builds a mutation from Convex directly", () => {
    const offenders = sources(ROOT)
      .map((path) => relative(ROOT, path))
      .filter((path) => path !== WRAPPER)
      .filter((path) => rawMutationBuilders(readFileSync(join(ROOT, path), "utf8")).length > 0);
    expect(offenders).toEqual([]);
  });

  test("the check sees each way around it", () => {
    expect(rawMutationBuilders('import { query, mutation } from "../_generated/server";')).toEqual(["mutation"]);
    expect(rawMutationBuilders('import {\n  internalMutation as im,\n} from "../../_generated/server";')).toEqual(["internalMutation"]);
    expect(rawMutationBuilders('import { mutationGeneric } from "convex/server";')).toEqual(["mutationGeneric"]);
    expect(rawMutationBuilders('import { type MutationCtx } from "../_generated/server";')).toEqual([]);
    expect(rawMutationBuilders('import { mutation } from "./lib/rowWatch/mutations";')).toEqual([]);
  });

  test("the wrapper itself is the one that builds them", () => {
    expect(rawMutationBuilders(readFileSync(join(ROOT, WRAPPER), "utf8")).sort()).toEqual(["internalMutation", "mutation"]);
  });
});
