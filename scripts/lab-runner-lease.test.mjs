/**
 * The Lab runner lease (`scripts/lab-runner-lease.mjs`): which slots count as
 * connected, how a run takes one or falls back to the shared runner (slot 0,
 * never blocked), the workflow's fallback wiring, and that no secret value ever
 * reaches a log, a file or the job output. Runs without network: the Convex
 * call and the GitHub listing are injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { acquireSlot, connectedSlots, releaseSlot, runCommand } from "./lab-runner-lease.mjs";

const SECRET_ID = "fake-client-id-5c1e9a";
const SECRET_TOKEN = "fake-refresh-token-8d2b6f";

/** Two connected slots by default; the values are fake and asserted absent from every output. */
function connectedEnv(extra = {}) {
  return {
    LAB_RUNNER_1_CLIENT_ID: SECRET_ID,
    LAB_RUNNER_1_REFRESH_TOKEN: SECRET_TOKEN,
    LAB_RUNNER_2_CLIENT_ID: `${SECRET_ID}-2`,
    LAB_RUNNER_2_REFRESH_TOKEN: `${SECRET_TOKEN}-2`,
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: "1",
    RUN_ID: "k57labrun0000000001",
    ...extra,
  };
}

test("connectedSlots lists only slots whose two secrets are both set, and returns numbers only", () => {
  const env = connectedEnv({ LAB_RUNNER_3_CLIENT_ID: SECRET_ID, LAB_RUNNER_3_REFRESH_TOKEN: "" });
  const slots = connectedSlots(env);
  assert.deepEqual(slots, [1, 2]);
  assert.ok(slots.every((slot) => typeof slot === "number"), "never a value");
  assert.deepEqual(connectedSlots({ LAB_RUNNER_1_CLIENT_ID: SECRET_ID }), [], "a client id alone is not a connected slot");
  assert.deepEqual(connectedSlots({ LAB_RUNNER_1_REFRESH_TOKEN: SECRET_TOKEN }), [], "a refresh token alone is not a connected slot");
  assert.deepEqual(connectedSlots({ LAB_RUNNER_1_CLIENT_ID: "  ", LAB_RUNNER_1_REFRESH_TOKEN: SECRET_TOKEN }), [], "a blank value is not set");
  assert.deepEqual(connectedSlots({ LAB_RUNNER_4_CLIENT_ID: SECRET_ID, LAB_RUNNER_4_REFRESH_TOKEN: SECRET_TOKEN }), [], "there is no slot 4");
});

async function acquireVia(env, { listActive = async () => [], callConvex = async () => ({ slot: 1 }) } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lab-lease-"));
  const output = join(dir, "output");
  const logs = [];
  const code = await runCommand(["acquire"], {
    env: { GITHUB_REPOSITORY: "Supa-Media/context", GITHUB_OUTPUT: output, RUNNER_TEMP: dir, ...env },
    listActive,
    callConvex,
    log: (line) => logs.push(line),
  });
  const out = await readFile(output, "utf8").catch(() => null);
  return { code, out, logs, dir };
}

test("acquire writes only slot= and attempt= to GITHUB_OUTPUT, and never logs a secret", async () => {
  const { code, out, logs } = await acquireVia(connectedEnv(), {
    listActive: async () => ["4242"],
    callConvex: async (fn, args) => {
      assert.equal(fn, "functions/labRunnerSlots:acquire");
      assert.deepEqual(args, { ghRunId: "4242", attempt: 1, labRunId: "k57labrun0000000001", connected: [1, 2], active: ["4242"] });
      return { slot: 2 };
    },
  });
  assert.equal(code, 0);
  assert.equal(out, "slot=2\nattempt=1\n", "exactly these two lines");
  assert.deepEqual(logs, ["Leased Lab runner slot 2"]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_TOKEN));
});

// The case that broke every Lab run on 2026-11-18 (run 44418734393): no LAB_RUNNER_<N> secret exists at all.
test("zero slots connected: slot 0 (the shared runner), exit 0, nothing asked of Convex or GitHub, no why file", async () => {
  let called = false;
  const { code, out, logs, dir } = await acquireVia(
    { GITHUB_RUN_ID: "4242", GITHUB_RUN_ATTEMPT: "1", RUN_ID: "k57labrun0000000001" },
    {
      listActive: async () => {
        called = true;
        return [];
      },
      callConvex: async () => {
        called = true;
        return { slot: 1 };
      },
    },
  );
  assert.equal(code, 0, "a run is never blocked for want of a slot");
  assert.equal(out, "slot=0\nattempt=1\n");
  assert.equal(called, false);
  assert.match(logs.join("\n"), /Using the shared benchmark runner: no Lab runner slot is connected/);
  await assert.rejects(readFile(join(dir, "why"), "utf8"), /ENOENT/, "no failure why");
});

test("a half-set slot (client id only) counts as zero slots and falls back", async () => {
  const { code, out } = await acquireVia({ GITHUB_RUN_ID: "4242", GITHUB_RUN_ATTEMPT: "1", RUN_ID: "k57labrun0000000001", LAB_RUNNER_1_CLIENT_ID: SECRET_ID });
  assert.equal(code, 0);
  assert.equal(out, "slot=0\nattempt=1\n");
});

test("every slot busy: slot 0 at once, and the waiting row is released so it holds no place", async () => {
  const calls = [];
  const { code, out, logs } = await acquireVia(connectedEnv(), {
    callConvex: async (fn, args) => {
      calls.push(fn);
      return fn.endsWith(":acquire") ? { waiting: 2, free: 0 } : { released: true };
    },
  });
  assert.equal(code, 0);
  assert.equal(out, "slot=0\nattempt=1\n");
  assert.deepEqual(calls, ["functions/labRunnerSlots:acquire", "functions/labRunnerSlots:release"]);
  assert.match(logs.join("\n"), /every connected Lab runner slot is busy/);
});

test("the pool unreachable (GitHub or Convex throws): slot 0, never an empty active list sent", async () => {
  const sent = [];
  for (const [listActive, callConvex] of [
    [async () => { throw new Error("HTTP 502"); }, async (fn, args) => (sent.push(args), { slot: 1 })],
    [async () => ["4242"], async () => { throw new Error("convex run functions/labRunnerSlots:acquire failed (exit 1)"); }],
  ]) {
    const { code, out } = await acquireVia(connectedEnv(), { listActive, callConvex });
    assert.equal(code, 0);
    assert.equal(out, "slot=0\nattempt=1\n");
  }
  assert.deepEqual(sent, [], "a failed listing never reaches Convex");
});

test("an answer outside 1..3 is not a slot: slot 0", async () => {
  for (const reply of [{ slot: 0 }, { slot: 4 }, { slot: "1" }, null, {}]) {
    const { out } = await acquireVia(connectedEnv(), { callConvex: async (fn) => (fn.endsWith(":acquire") ? reply : { released: false }) });
    assert.equal(out, "slot=0\nattempt=1\n", JSON.stringify(reply));
  }
});

test("missing run ids fall back too, never block", async () => {
  const result = await acquireSlot({
    env: connectedEnv({ GITHUB_RUN_ID: "not-a-number" }),
    listActive: async () => {
      throw new Error("must not run");
    },
    callConvex: async () => {
      throw new Error("must not run");
    },
    log: () => {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.slot, 0);
});

test("release frees this run's attempt and says so without a secret", async () => {
  const seen = [];
  const logs = [];
  const result = await releaseSlot({
    env: connectedEnv(),
    callConvex: async (fn, args) => {
      seen.push([fn, args]);
      return { released: true };
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(seen, [["functions/labRunnerSlots:release", { ghRunId: "4242", attempt: 1 }]]);
  assert.deepEqual(result, { code: 0, released: true });
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_TOKEN));
});

/* ---------------------- the workflow's zero-slot path ---------------------- */

const WORKFLOW = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github/workflows/tex-lab-run.yml"), "utf8"));
const jobs = WORKFLOW.jobs;

test("workflow: the lease job can never fail the run (every step continues on error, slot defaults to 0)", () => {
  const lease = jobs.lease;
  for (const step of lease.steps.filter((s) => s.run || s.uses?.startsWith("pnpm/") || s.uses?.startsWith("actions/setup-node"))) {
    if (step.id === "why") continue;
    assert.equal(step["continue-on-error"], true, `lease step ${step.name ?? step.uses ?? step.run} must continue on error`);
  }
  assert.match(lease.outputs.slot, /\|\|\s*'0'/, "an empty slot output reads as 0");
});

test("workflow: slot 0 waits for the shared runner's lock exactly as before slots, a leased slot skips it", () => {
  const wait = jobs["wait-turn"];
  assert.ok(wait, "the wait-turn job exists");
  assert.match(wait.if, /needs\.lease\.outputs\.slot == '0'/);
  assert.ok(wait.steps.some((s) => /bench-runner-lock\.mjs --max-minutes 170/.test(s.run ?? "")));
  assert.ok(jobs.run.needs.includes("wait-turn"));
  assert.match(jobs.run.if, /needs\.wait-turn\.result == 'skipped'/);
  const check = jobs.run.steps.find((s) => /bench-runner-lock\.mjs --check/.test(s.run ?? ""));
  assert.ok(check, "the run job checks the shared lock again");
  assert.match(check.if ?? "", /needs\.lease\.outputs\.slot == '0'/);
});

test("workflow: slot 0 signs in and writes back with the shared BENCH_RUNNER secrets, a slot with its own", () => {
  const env = jobs.run.env;
  assert.match(env.BENCH_RUNNER_CLIENT_ID, /secrets\.LAB_RUNNER_1_CLIENT_ID/);
  assert.match(env.BENCH_RUNNER_CLIENT_ID, /needs\.lease\.outputs\.slot == '0' && secrets\.BENCH_RUNNER_CLIENT_ID \|\|/, "slot 0 takes the shared client id");
  assert.match(env.BENCH_RUNNER_REFRESH_TOKEN_LIVE, /needs\.lease\.outputs\.slot == '0' && secrets\.BENCH_RUNNER_REFRESH_TOKEN_LIVE \|\|/);
  for (const value of [env.BENCH_RUNNER_CLIENT_ID, env.BENCH_RUNNER_REFRESH_TOKEN_LIVE, env.BENCH_RUNNER_REFRESH_TOKEN]) {
    assert.match(value, /\|\| '' \}\}$/, "an unknown slot gets no grant at all, never a fall-through to another");
  }
  assert.match(env.BENCH_RUNNER_REFRESH_TOKEN, /needs\.lease\.outputs\.slot == '0' && secrets\.BENCH_RUNNER_REFRESH_TOKEN/, "the seed only on slot 0");
  const write = jobs["write-token"].steps.find((s) => /gh secret set/.test(s.run ?? ""));
  assert.match(write.run, /BENCH_RUNNER_REFRESH_TOKEN_LIVE/);
  assert.match(write.run, /LAB_RUNNER_\$\{SLOT\}_REFRESH_TOKEN/);
  assert.match(jobs.release.if, /needs\.lease\.outputs\.slot != '0'/, "slot 0 has no lease to release");
});

test("bench-runner-lock lists tex-lab-run.yml, so a slot-0 Lab run and the other runner workflows wait for each other", async () => {
  const { RUNNER_WORKFLOWS } = await import("./bench-runner-lock.mjs");
  assert.ok(RUNNER_WORKFLOWS.includes("tex-lab-run.yml"));
});
