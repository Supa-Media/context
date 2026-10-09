/**
 * THE PHONE MAP'S COMMITTED BUNDLE IS BUILT FROM UNCHANGED SOURCES.
 *
 * The native app draws the live map with the web build's own canvas engine,
 * compiled into `map/live/webview/bundle.generated.ts` by
 * `scripts/build-map-bundle.mjs` and run in a web view. Same shape and same
 * two halves as `editorBundle.test.ts`: this file proves the staleness half
 * (every recorded source hashes to what it did at build time); the
 * `editor-bundle` job in `ci.yml` rebuilds and diffs the bytes, and the last
 * test pins that it still does.
 */

import { describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUNDLE_DEPENDENCIES, BUNDLE_SOURCES, MAP_BUNDLE } from "../features/console/map/live/webview/bundle.generated";

const mobileRoot = resolve(__dirname, "..");
const repoRoot = resolve(mobileRoot, "..", "..");
const REBUILD = "run `node scripts/build-map-bundle.mjs` from the repo root";
const MAP = "apps/mobile/features/console/map/live";

describe("the map bundle is current", () => {
  test("it records the engine and the web view guest as its sources", () => {
    const sources = Object.keys(BUNDLE_SOURCES);
    expect(sources.length).toBeGreaterThanOrEqual(20);
    for (const file of ["engine/engine.ts", "engine/draw/render.ts", "webview/guest.ts", "webview/entry.ts", "webview/protocol.ts"]) {
      expect(sources).toContain(`${MAP}/${file}`);
    }
  });

  test("and every one of them is unchanged since it was built", () => {
    const stale: string[] = [];
    for (const [path, expected] of Object.entries(BUNDLE_SOURCES)) {
      const file = join(repoRoot, path);
      if (!existsSync(file)) {
        stale.push(`${path} (missing)`);
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (actual !== expected) stale.push(path);
    }
    expect(stale.length === 0 ? "" : `${stale.join(", ")} — ${REBUILD}`).toBe("");
  });

  test("it carries no packages: the engine is all this repository's code", () => {
    expect(BUNDLE_DEPENDENCIES).toEqual({});
  });
});

describe("the native path never imports the engine, only the bundle", () => {
  const NATIVE_PATH = [`${MAP}/LiveMapCanvas.tsx`, `${MAP}/webview/host.ts`, `${MAP}/webview/protocol.ts`];
  const FORBIDDEN = ["./webview/guest", "./webview/entry", "./guest", "./entry", "../engine/engine", "./engine/engine", "./faceImages", "../faceImages"];

  for (const file of NATIVE_PATH) {
    test(`${file} imports no code that only runs in the web view`, () => {
      const source = readFileSync(join(repoRoot, file), "utf8");
      // Type-only imports are erased and pull nothing into the native bundle.
      const specifiers = [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gms)].map((match) => match[1]);
      expect(specifiers.filter((s) => FORBIDDEN.some((bad) => s === bad || s.startsWith(bad)))).toEqual([]);
    });
  }
});

describe("what shipped is a script and nothing else", () => {
  test("it is one minified IIFE that evaluates no strings and reaches no network", () => {
    expect(MAP_BUNDLE.startsWith('"use strict";(()=>{')).toBe(true);
    expect(MAP_BUNDLE).not.toMatch(/^\s*import\s/m);
    expect(MAP_BUNDLE).not.toContain("eval(");
    expect(MAP_BUNDLE).not.toContain("new Function(");
    expect(MAP_BUNDLE).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  });

  test("and what it IS is proved by rebuilding in CI, which must still be there", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const code = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const start = code.indexOf("\n  editor-bundle:");
    expect(start).toBeGreaterThan(-1);
    const rest = code.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z-]*:\n/);
    const job = next === -1 ? rest : rest.slice(0, next);
    expect(job).toMatch(/^\s+run: node scripts\/build-map-bundle\.mjs\s*$/m);
    expect(job).toMatch(/^\s+file=apps\/mobile\/features\/console\/map\/live\/webview\/bundle\.generated\.ts\s*$/m);
    expect(job).not.toMatch(/^ {4}if:/m);
    expect(job).not.toMatch(/^\s+continue-on-error:/m);
  });
});
