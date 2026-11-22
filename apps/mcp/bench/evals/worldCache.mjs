/**
 * A BENCHMARK'S BUILT WORLD, KEPT AND LOADED INSTEAD OF BUILT AGAIN.
 *
 * A benchmark's notes do not change from run to run, so neither do the indexes built over them. Building them is
 * most of a big run's setup (10,000 notes: the search database, the meaning index, then every note put into its
 * workspace object and both of the object's indexes built). Here a run's two worlds, the bucket world `prepareRun`
 * warms and the object world `createObjectWorld` builds, are written once to a folder and every later run opens
 * copies of them.
 *
 * A kept world is named by a hash of everything that could change it: the notes and people, the search settings,
 * the embedder, the pinned day, and the code that builds and reads the indexes (`codeHash`). Any change to those is
 * a new name, so a stale world is never loaded; the old one is just never read again.
 *
 * The folder is `BENCH_WORLD_CACHE` (`.github/workflows/lab-eval-run.yml` keeps it in the Actions cache).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareRun, preparedFrom } from "../warm.mjs";
import { createObjectWorld } from "./objectWorld.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The code a built world depends on: the gateway (search, the workspace object, the meaning index), the bench
 * harness and the test stand-ins it builds on, and the shared packages the gateway imports. Test files are left out.
 */
const CODE_ROOTS = [
  "apps/mcp/src",
  "apps/mcp/bench",
  "apps/mcp/test",
  "packages/shared/src",
  "packages/collaboration/src",
  "packages/communications/src",
  "packages/drawings/src",
  "packages/tex/gateway",
  "packages/bench/src",
];
const CODE_FILE = /\.(c|m)?js$|\.json$/;

function filesUnder(root, into = []) {
  if (!existsSync(root)) return into;
  for (const name of readdirSync(root).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) filesUnder(path, into);
    else if (CODE_FILE.test(name) && !name.endsWith(".test.mjs") && !name.endsWith(".test.js")) into.push(path);
  }
  return into;
}

let code = null;
/** One sha256 over every file the world's building depends on, by path and content. */
export function codeHash(repo = REPO) {
  if (code && repo === REPO) return code;
  const hash = createHash("sha256");
  for (const root of CODE_ROOTS) {
    for (const file of filesUnder(join(repo, root))) {
      hash.update(relative(repo, file));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  const out = hash.digest("hex");
  if (repo === REPO) code = out;
  return out;
}

/** A kept world's name: the bench, the settings, the embedder, the day and the code, hashed. */
export function worldKey({ bench, settings = null, embedder, today = null, objects = true, bucket = true, repo = REPO }) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ people: bench.people, settings, embedder, today, objects, ...(bucket ? {} : { bucket }), code: codeHash(repo) }));
  for (const name of Object.keys(bench.workspaces).sort()) {
    hash.update(`\0workspace\0${name}`);
    const files = bench.workspaces[name].files;
    for (const path of Object.keys(files).sort()) hash.update(`\0${path}\0${files[path]}`);
  }
  return hash.digest("hex").slice(0, 32);
}

/** The bucket world's parts as files: the databases, the buckets, the meaning vectors and the counts. */
function saveBucketWorld(prepared, dir) {
  mkdirSync(dir, { recursive: true });
  const names = [...prepared.buckets.keys()];
  for (const name of names) copyFileSync(prepared.databaseFile(name), join(dir, `${name}.db`));
  writeFileSync(
    join(dir, "world.json"),
    JSON.stringify({
      today: prepared.today ?? null,
      buckets: names.map((name) => [name, [...prepared.buckets.get(name)]]),
      indexed: [...prepared.indexed],
      embedded: [...prepared.embedded],
      vectors: prepared.vectors !== null,
    }),
  );
  if (prepared.vectors === null) return;
  // The vectors as one run of float32s, and a line per vector saying whose they are and how many.
  const lines = [];
  const chunks = [];
  for (const [index, vectors] of prepared.vectors) {
    for (const [id, { values, metadata }] of vectors) {
      lines.push(JSON.stringify({ index, id, metadata, n: values.length }));
      chunks.push(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
    }
  }
  writeFileSync(join(dir, "vectors.jsonl"), lines.join("\n"));
  writeFileSync(join(dir, "vectors.f32"), Buffer.concat(chunks));
}

function loadBucketWorld(dir) {
  const world = JSON.parse(readFileSync(join(dir, "world.json"), "utf8"));
  const buckets = new Map(world.buckets.map(([name, objects]) => [name, new Map(objects)]));
  let vectors = null;
  if (world.vectors) {
    const bytes = readFileSync(join(dir, "vectors.f32"));
    const all = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(all.buffer).set(bytes);
    vectors = new Map();
    let at = 0;
    const text = readFileSync(join(dir, "vectors.jsonl"), "utf8");
    for (const line of text ? text.split("\n") : []) {
      const { index, id, metadata, n } = JSON.parse(line);
      if (!vectors.has(index)) vectors.set(index, new Map());
      vectors.get(index).set(id, { values: all.subarray(at, at + n), metadata });
      at += n;
    }
  }
  // The run's own folder: `openCopy` copies a database out of it, and `close` removes it, never the kept one.
  const own = mkdtempSync(join(tmpdir(), "bench-warm-"));
  for (const name of buckets.keys()) copyFileSync(join(dir, `${name}.db`), join(own, `${name}.db`));
  return preparedFrom({ dir: own, today: world.today, buckets, indexed: new Map(world.indexed), vectors, embedded: new Map(world.embedded) });
}

/**
 * Both worlds for a run: loaded from `cache` when it holds them under this run's key, otherwise built and, when
 * `cache` is set, kept there for the next run. Returns `{ prepared, objectWorld, loaded }`.
 */
export async function warmWorlds(bench, { cache = null, ai = null, embedder = "none", today = null, settings = null, objects = true, bucket = true, keepOnly = false, log = () => {} }) {
  const key = cache ? worldKey({ bench, settings, embedder, today, objects, bucket }) : null;
  const dir = key ? join(cache, key) : null;
  // `keepOnly`: make sure the world is kept, and open nothing when it already is.
  if (keepOnly && dir && existsSync(join(dir, "done"))) return { prepared: null, objectWorld: null, loaded: true };
  if (dir && existsSync(join(dir, "done"))) {
    const prepared = bucket ? loadBucketWorld(join(dir, "bucket")) : null;
    const objectWorld = objects ? await createObjectWorld(bench, { ai, settings, from: join(dir, "objects") }) : null;
    return { prepared, objectWorld, loaded: true };
  }
  // `bucket: false`: the object world alone, as every managed workspace is searched; no search database is built.
  const prepared = bucket ? await prepareRun(bench, { today, ai }) : null;
  const objectWorld = objects ? await createObjectWorld(bench, { ai, settings }) : null;
  if (dir) {
    // Written beside, then renamed into place: a run that reads the folder sees all of a world or none of it, and
    // two processes building the same world at once both finish (the second rename finds the first's in place).
    mkdirSync(cache, { recursive: true });
    const part = `${dir}.part-${process.pid}`;
    rmSync(part, { recursive: true, force: true });
    if (prepared) saveBucketWorld(prepared, join(part, "bucket"));
    if (objectWorld) {
      mkdirSync(join(part, "objects"), { recursive: true });
      objectWorld.save(join(part, "objects"));
    }
    writeFileSync(join(part, "done"), new Date().toISOString());
    try {
      renameSync(part, dir);
      log(`kept the built world as ${key}\n`);
    } catch {
      rmSync(part, { recursive: true, force: true });
    }
  }
  return { prepared, objectWorld, loaded: false };
}
