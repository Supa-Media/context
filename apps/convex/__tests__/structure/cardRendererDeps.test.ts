/**
 * The card renderer (`functions/cardRender.ts`) runs in Convex's Node runtime,
 * where a dependency that reads a file next to its own script cannot find it:
 * the deployment answers every card with a 404, and every unfurl falls back to
 * the site's small icon. satori 0.33 began loading HarfBuzz that way
 * (`harfbuzzjs` reads `hb.wasm` from its own folder), which is how every share,
 * website and note link card broke in production while every local render
 * worked. The renderer's own wasm comes from file storage for the same reason.
 * Bump satori only to a version that keeps its wasm inline, and run the
 * "Card renderer" workflow after deploying: its test render is the real check.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Packages known to load a wasm file from beside their own script at runtime. */
const READS_A_WASM_FILE = ["harfbuzzjs"];

describe("the card renderer's dependencies", () => {
  it("load no wasm from a file beside their own script", () => {
    const manifest = JSON.parse(readFileSync(require.resolve("satori/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => READS_A_WASM_FILE.includes(name))).toEqual([]);
  });
});
