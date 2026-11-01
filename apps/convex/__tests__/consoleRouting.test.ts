/**
 * Every store this deployment builds over a workspace's notes sends note texts to the workspace's object where they
 * live there (`functions/lib/rowWatch/consoleRouting.ts`). A store built without it would write a note's text to the
 * bucket alone after the switch, and the object would go on serving the old text. This test refuses a new builder
 * that skips it; the ones that do skip it are named here with why.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "functions");

/** Builders that never read or write a note's text, each with its reason. */
const NOT_NOTES: Record<string, string> = {
  "lib/managedEncryptionFns/walk.ts": "seals the bucket's own objects in place; the bucket stays the backup copy",
  "lib/managedProvisioningFns/targetReady.ts": "probes a new managed bucket before anything is in it",
  "lib/managedProvisioningFns/temporaryKey.ts": "probes a new managed bucket's key",
  "lib/noteIds/deps.ts": "the path-to-id copy's HEADs, over the bucket's raw keys",
  "moveCatchUp.ts": "copies one bucket's raw objects to another during a storage move",
  "provisioning.ts": "probes a connected bucket before it holds notes",
  "vault.ts": "the autofill vault, under .context/vault, which stays in the bucket",
  "workspaceObjects.ts": "the copy and compare, which must see the bucket alone beside the object",
};

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** The text of each `storeForBinding(...)` call's arguments in a source. */
export function builderCalls(source: string): string[] {
  const calls: string[] = [];
  for (let at = source.indexOf("storeForBinding("); at >= 0; at = source.indexOf("storeForBinding(", at + 1)) {
    let depth = 0;
    let end = at + "storeForBinding".length;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
  }
  return calls;
}

export const routes = (call: string) => /routing\.options/.test(call) && /routing\.credential\(/.test(call);

describe("console stores follow the workspace's notes to its object", () => {
  test("every builder over notes passes the routing, and only the named ones do not", () => {
    const skipping: string[] = [];
    for (const path of sources(ROOT)) {
      const name = relative(ROOT, path);
      if (name.startsWith("lib/rowWatch/")) continue;
      const calls = builderCalls(readFileSync(path, "utf8")).filter((call) => !/^storeForBinding\(\s*$/.test(call));
      if (calls.length > 0 && calls.some((call) => !routes(call))) skipping.push(name);
    }
    expect(skipping.sort()).toEqual(Object.keys(NOT_NOTES).sort());
  });

  test("the check sees a builder that skips it", () => {
    expect(builderCalls("const s = storeForBinding(credential, undefined, { managedEncryption });").map(routes)).toEqual([false]);
    expect(
      builderCalls("storeForBinding(routing.credential(credential), undefined, { a: f(1), ...routing.options })").map(routes),
    ).toEqual([true]);
  });
});
