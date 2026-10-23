/**
 * Records which repository files each test file really used, so a pull
 * request can run only the Convex tests its change reaches
 * (`scripts/convex-tests.mjs` reads the map; docs/decisions/testing/
 * convex-test-impact.md says why and what still runs everything).
 *
 * Loaded only when `CONVEX_TEST_MAP_RECORD` names a directory, which CI sets
 * on pushes to main. One JSON file per test file lands there.
 *
 * "Used" is not "imported". `convex-test` loads every function module the
 * moment one is called, and `http.ts` imports all 34 gateway route modules,
 * so by import nearly every test reaches half the backend. V8 coverage says
 * which files had a function actually run. Three things count:
 *
 *  - a file with any function that ran, other than its module wrapper and
 *    the tiny `get` accessors vite's SSR transform writes for each export
 *    (reading `routes.handler` runs one; it does not run the handler);
 *  - a file imported as `?raw`, whose text is the thing under test;
 *  - a file or directory the test read or listed through `node:fs`, which is
 *    how the structure tests scan the sources.
 */
import { afterAll, beforeAll, expect } from "vitest";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Session } from "node:inspector/promises";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = process.env.CONVEX_TEST_MAP_RECORD && resolve(process.env.CONVEX_TEST_MAP_RECORD);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GETTER_MAX = 80;

const touched = new Set<string>();
const session = new Session();

function note(path: unknown): void {
  if (typeof path !== "string" && !(path instanceof URL)) return;
  const absolute = path instanceof URL ? fileURLToPath(path) : resolve(path);
  const rel = relative(ROOT, absolute);
  if (!rel.startsWith("..") && !rel.includes("node_modules")) touched.add(rel);
}

// Only a read the repository's own code asked for counts. vitest resolves
// and stats every module it loads through the same `node:fs`, and counting
// those would make every test depend on every file it imported.
function calledFromRepository(): boolean {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  const caller = frames.find((frame) => !frame.includes("testImpact.setup.ts"));
  return !!caller && caller.includes(ROOT) && !caller.includes("node_modules");
}

const SINK = Symbol.for("context.testImpact.sink");
const INSTALLED = Symbol.for("context.testImpact.installed");
type Sink = { [SINK]?: (path: unknown) => void; [INSTALLED]?: true };

if (OUT) {
  // A worker runs many test files, and `node:fs` is one object for all of
  // them, so it is wrapped once and the wrapper reports to whichever file's
  // sink is current. The named exports of a builtin follow its CommonJS
  // object once synced, so `import { readFileSync } from "node:fs"` in a
  // test sees the wrapper too.
  const global = globalThis as Sink;
  global[SINK] = note;
  if (!global[INSTALLED]) {
    global[INSTALLED] = true;
    const cjs = createRequire(import.meta.url)("node:fs") as typeof fs;
    const wrap = (target: Record<string, unknown>, name: string) => {
      const original = target[name] as (...args: unknown[]) => unknown;
      target[name] = function (this: unknown, ...args: unknown[]) {
        if (calledFromRepository()) global[SINK]?.(args[0]);
        return original.apply(this, args);
      };
    };
    for (const name of ["readFileSync", "readdirSync", "existsSync", "statSync", "opendirSync"]) wrap(cjs as never, name);
    for (const name of ["readFile", "readdir", "stat", "opendir"]) wrap(cjs.promises as never, name);
    syncBuiltinESMExports();
  }

  beforeAll(async () => {
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", { callCount: false, detailed: false });
  });

  afterAll(async () => {
    const { result } = (await session.post("Profiler.takePreciseCoverage")) as {
      result: { url: string; functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[];
    };
    await session.post("Profiler.stopPreciseCoverage");
    session.disconnect();
    for (const script of result) {
      if (!script.url.startsWith("file://") && !script.url.startsWith("/")) continue;
      const [path, query = ""] = script.url.replace(/^file:\/\//, "").split("?");
      // functions[0] is the script, functions[1] vite-node's module wrapper.
      const ran = script.functions.some((fn, index) => {
        const range = fn.ranges[0];
        if (index < 2 || range.count === 0) return false;
        return !(fn.functionName === "get" && range.endOffset - range.startOffset < GETTER_MAX);
      });
      if (ran || query.split("&").includes("raw")) note(decodeURIComponent(path));
    }
    // A `?raw` import never runs, so coverage cannot see it; the worker's
    // module cache lists it by its id.
    const worker = (globalThis as { __vitest_worker__?: { moduleCache?: Map<string, unknown> } }).__vitest_worker__;
    for (const id of worker?.moduleCache?.keys() ?? []) {
      const [path, query = ""] = id.replace(/^file:\/\//, "").split("?");
      if (query.split("&").includes("raw")) note(path);
    }
    const testPath = expect.getState().testPath;
    if (!testPath) return;
    const test = relative(ROOT, testPath);
    touched.add(test);
    fs.mkdirSync(OUT, { recursive: true });
    const name = createHash("sha1").update(test).digest("hex");
    fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ test, deps: [...touched].sort() }));
  });
}
