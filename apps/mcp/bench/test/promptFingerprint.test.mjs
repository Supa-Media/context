/**
 * PROMPT FINGERPRINTS (`bench/promptFingerprint.mjs`, the socket's fingerprint mode in `bench/modelSocket.mjs`; Dev2,
 * 2026-11-13: "even if it's a letter different, we need to check that").
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `fingerprintOf` hashing only the count -> "one changed prompt changes the fingerprint" fails;
 *  2. `changedAreas` comparing prompt counts, not hashes -> "an area whose prompts differ is changed" fails;
 *  3. the socket's fingerprint mode answering without writing the hash -> "every call is hashed" fails;
 *  4. `fingerprintEnv` passing the whole environment -> "a fingerprint run sees no key" fails;
 *  5. end to end on the real trees: one letter of the drawing's map (`texArchitecture.generated.js`, named by no area's
 *     files) changed review, core, all four advisor roles and jobs; one letter of the capability list changed review,
 *     core, advisor-chat and jobs; two spaces in the reviewer's instructions changed review alone; a clean tree none.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FINGERPRINT_ANSWER, modelSocket, requestHash, socketRequest } from "../modelSocket.mjs";
import { canFingerprint, changedAreas, FINGERPRINT_RUNS, fingerprintEnv, fingerprintLines, fingerprintOf, readCalls, treeFingerprints } from "../promptFingerprint.mjs";
import { AREAS } from "../replayAreas.mjs";

test("every area has a fingerprint run", () => {
  assert.deepEqual(Object.keys(FINGERPRINT_RUNS).sort(), Object.keys(AREAS).sort());
});

test("one changed prompt changes the fingerprint; order and repeats do not", () => {
  const a = fingerprintOf(["h1", "h2", "h3"]);
  assert.equal(a.prompts, 3);
  assert.deepEqual(fingerprintOf(["h3", "h1", "h2", "h1"]), a);
  assert.notEqual(fingerprintOf(["h1", "h2", "h4"]).hash, a.hash);
});

test("an area whose prompts differ is changed; one built nowhere, or broken, is too", () => {
  const same = fingerprintOf(["x"]);
  const base = { respond: same, review: fingerprintOf(["r1", "r2"]), core: same };
  const head = { respond: same, review: fingerprintOf(["r1", "r3"]), core: { error: "built no prompt" }, jobs: same };
  assert.deepEqual(changedAreas(base, head), ["review", "core", "jobs"]);
  assert.deepEqual(changedAreas(base, base), []);
});

test("a tree that can't fingerprint yet leaves the file rules to decide", () => {
  assert.equal(canFingerprint(tmpdir()), false);
  assert.match(fingerprintLines(null)[0], /only the file rules decided/);
});

test("a fingerprint run sees no key, only the fingerprint file", () => {
  const env = fingerprintEnv("/tmp/f.jsonl", { PATH: "/bin", HOME: "/h", AI_GATEWAY_TOKEN: "x", ANTHROPIC_CREDIT_KEY: "y", BENCH_MODEL_SOCKET: "/s", BENCH_MODEL_REPLAY: "/r" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", BENCH_MODEL_FINGERPRINT: "/tmp/f.jsonl" });
});

test("every call is hashed as the socket names it; Claude gets stand-in words, anything else is refused", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "fp-")), "calls.jsonl");
  const socket = modelSocket({ BENCH_MODEL_FINGERPRINT: file });
  assert.equal(socket.mode, "fingerprint");
  assert.equal(socket.covers("claude") && socket.covers("workers-ai"), true);
  const reply = await socketRequest(socket)({ model: "claude-haiku", system: "Be brief.", messages: [{ role: "user", text: "hi" }], maxTokens: 50 });
  assert.equal(reply.text, FINGERPRINT_ANSWER.text);
  await assert.rejects(socket.ask("workers-ai", { model: "clef", input: {} }), /fingerprint run/);
  const hashes = readCalls(await readFile(file, "utf8"));
  const request = { model: "claude-haiku", system: "Be brief.", messages: [{ role: "user", text: "hi" }], tools: [], maxTokens: 50 };
  assert.deepEqual(hashes, [requestHash("claude", request), requestHash("workers-ai", { model: "clef", input: {} })]);
});

test("a tree's areas are run with the fingerprint file and no key, and what they hashed is read back", async () => {
  const seen = [];
  const runner = async (_node, args, options) => {
    seen.push({ args, env: options.env });
    const { appendFileSync } = await import("node:fs");
    if (args.includes("review")) appendFileSync(options.env.BENCH_MODEL_FINGERPRINT, `${JSON.stringify({ kind: "claude", hash: "aa" })}\n`);
    else throw new Error("bench failed");
  };
  const scratch = await mkdtemp(join(tmpdir(), "fp-tree-"));
  const out = await treeFingerprints(process.cwd(), { areas: ["review", "respond"], scratch, runner });
  assert.equal(out.review.prompts, 1);
  assert.match(out.respond.error, /bench failed/);
  assert.ok(seen.every(({ env }) => env.BENCH_MODEL_FINGERPRINT && !("AI_GATEWAY_TOKEN" in env)));
});
