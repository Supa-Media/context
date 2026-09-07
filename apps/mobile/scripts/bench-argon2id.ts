/**
 * What the pure-JavaScript Argon2id actually costs, on the runtimes the console
 * runs in.
 *
 * The numbers this prints are the evidence under "The KDF, per client" in
 * `docs/decisions/encryption.md`. They are not a test and they are deliberately
 * not in the suite: a timing assertion on shared CI hardware is a flake
 * generator, and the decision it supports is about orders of magnitude rather
 * than milliseconds.
 *
 * Run it two ways, which is the whole point:
 *
 *     node --experimental-strip-types apps/mobile/scripts/bench-argon2id.ts
 *     node --jitless --experimental-strip-types apps/mobile/scripts/bench-argon2id.ts
 *
 * The first is the browser and the Electron shell: V8 with its optimising
 * compiler, which is what the web console gets. The second is the honest proxy
 * for Hermes, which has no JIT at all — it is not Hermes, and it is the closest
 * a checkout can get without an emulator. Hermes is expected to be slower still.
 */

import { argon2id } from "../features/console/encryption/argon2id.ts";

interface Row {
  label: string;
  memory: number;
  iterations: number;
  parallelism: number;
}

const CASES: Row[] = [
  { label: "8 MiB, t=2", memory: 8 * 1024, iterations: 2, parallelism: 1 },
  { label: "19 MiB, t=2 (RFC 9106 second option)", memory: 19 * 1024, iterations: 2, parallelism: 1 },
  { label: "32 MiB, t=2", memory: 32 * 1024, iterations: 2, parallelism: 1 },
  { label: "64 MiB, t=3", memory: 64 * 1024, iterations: 3, parallelism: 1 },
];

const password = new TextEncoder().encode("correct horse battery staple");
const salt = new Uint8Array(16).fill(7);

console.log(`node ${process.version}${jitless() ? " --jitless" : ""}`);
for (const row of CASES) {
  const started = Date.now();
  argon2id({ password, salt, tagLength: 32, ...row });
  const elapsed = Date.now() - started;
  const blocks = Math.floor(row.memory / 4) * 4;
  console.log(
    `${row.label.padEnd(40)} ${String(elapsed).padStart(7)} ms  ` +
      `${((blocks * row.iterations) / elapsed).toFixed(0)} blocks/ms`,
  );
}

function jitless(): boolean {
  return process.execArgv.includes("--jitless");
}
