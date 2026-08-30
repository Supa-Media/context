/**
 * Put the share-card renderer's wasm into a deployment's file storage.
 *
 * Run once per deployment, and again whenever `@resvg/resvg-wasm` is bumped:
 *
 *   node scripts/installCardWasm.mjs                 # the dev deployment
 *   node scripts/installCardWasm.mjs --prod
 *
 * ## Why this exists at all
 *
 * Convex bundles JavaScript and does not ship a package's `.wasm`, so
 * `require.resolve("@resvg/resvg-wasm/index_bg.wasm")` inside a function
 * deploys cleanly and throws at runtime. The alternative — 3.15 MB of base64 in
 * a source module — is unreviewable and pushes at Convex's module limits. So
 * the bytes live in file storage and the renderer fetches them once per isolate.
 *
 * It is deliberately a script rather than something a deploy does implicitly: a
 * deploy that silently uploaded 2.4 MB every time would be a leak, and one that
 * uploaded it *conditionally* would need to answer "is the stored copy the same
 * build?" — which is this script's job, once, on purpose.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
const wasm = readFileSync(wasmPath);

const prod = process.argv.includes("--prod");
console.log(
  `installing ${(wasm.length / 1024 / 1024).toFixed(2)} MB of wasm into the ${
    prod ? "production" : "dev"
  } deployment…`,
);

// The bytes travel as base64, in pieces.
//
// 2.4 MB of wasm is 3.15 MB encoded, and passing that to `convex run` fails
// with `E2BIG` — the OS caps a process's arguments at about a megabyte — while
// `convex run` has no stdin form to fall back to. So it is split here and
// reassembled by `appendChunk`, which refuses to store anything until every
// piece has arrived.
const CHUNK_BYTES = 700 * 1024;
const total = Math.ceil(wasm.length / CHUNK_BYTES);

for (let index = 0; index < total; index += 1) {
  const slice = wasm.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
  process.stdout.write(`  chunk ${index + 1}/${total}…\n`);
  execFileSync(
    "npx",
    [
      "convex",
      "run",
      ...(prod ? ["--prod"] : []),
      "functions/cardRender:installWasm",
      // `{"$bytes": "<base64>"}` is Convex's JSON wire form for `v.bytes()`.
      // A bare base64 string is a *string* and the validator rejects it — with
      // the whole 900 KB chunk echoed into the error, which is how this was
      // found.
      JSON.stringify({
        chunk: { $bytes: slice.toString("base64") },
        index,
        total,
      }),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

console.log("installed.");
