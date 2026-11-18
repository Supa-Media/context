/**
 * The Lab runner lease (`scripts/lab-runner-lease.mjs`): which slots count as
 * connected, how a run waits for and takes one, and that no secret value ever
 * reaches a log, a file or the job output. Runs without network: the Convex
 * call, the GitHub listing and the clock are injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** A fake clock: `sleep` advances it, so a 170 minute wait takes no time. */
function clock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
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

test("acquire writes only slot= and attempt= to GITHUB_OUTPUT, and never logs a secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-lease-out-"));
  const output = join(dir, "output");
  const logs = [];
  const code = await runCommand(["acquire"], {
    env: connectedEnv({ GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "Supa-Media/context", RUNNER_TEMP: dir }),
    listActive: async () => ["4242"],
    callConvex: async (fn, args) => {
      assert.equal(fn, "functions/labRunnerSlots:acquire");
      assert.deepEqual(args, { ghRunId: "4242", attempt: 1, labRunId: "k57labrun0000000001", connected: [1, 2], active: ["4242"] });
      return { slot: 2 };
    },
    log: (line) => logs.push(line),
    ...clock(),
  });
  assert.equal(code, 0);
  assert.equal(await readFile(output, "utf8"), "slot=2\nattempt=1\n", "exactly these two lines");
  assert.deepEqual(logs, ["Leased Lab runner slot 2"]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_TOKEN));
});

test("acquire waits while the pool is full, then succeeds when a slot frees", async () => {
  const replies = [{ waiting: 1, free: 0 }, { waiting: 0, free: 0 }, { slot: 1 }];
  const logs = [];
  const timing = clock();
  const result = await acquireSlot({
    env: connectedEnv(),
    listActive: async () => [],
    callConvex: async () => replies.shift(),
    log: (line) => logs.push(line),
    ...timing,
  });
  assert.deepEqual(result, { code: 0, slot: 1, attempt: 1 });
  assert.deepEqual(timing.sleeps, [30_000, 30_000], "polls every 30 s");
  assert.deepEqual(logs, [
    "Waiting for a Lab runner slot: 1 ahead, 0 free",
    "Waiting for a Lab runner slot: 0 ahead, 0 free",
    "Leased Lab runner slot 1",
  ]);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_TOKEN));
});

test("acquire fails with a why and exit 1 when no slot is connected, without calling Convex", async () => {
  let called = false;
  const result = await acquireSlot({
    env: { GITHUB_RUN_ID: "4242", GITHUB_RUN_ATTEMPT: "1", RUN_ID: "k57labrun0000000001", LAB_RUNNER_1_CLIENT_ID: SECRET_ID },
    listActive: async () => {
      called = true;
      return [];
    },
    callConvex: async () => {
      called = true;
      return { slot: 1 };
    },
    log: () => {},
    ...clock(),
  });
  assert.equal(result.code, 1);
  assert.match(result.why, /no Lab runner slot is connected: run `pnpm ai connect --lab-slot 1`/);
  assert.equal(called, false, "nothing is asked of Convex or GitHub when no slot is connected");
  assert.doesNotMatch(result.why, new RegExp(SECRET_ID));
});

test("acquire gives up with exit 1 once the wait passes max minutes", async () => {
  const timing = clock();
  const logs = [];
  const result = await acquireSlot({
    env: connectedEnv(),
    maxMinutes: 2,
    listActive: async () => [],
    callConvex: async () => ({ waiting: 3, free: 0 }),
    log: (line) => logs.push(line),
    ...timing,
  });
  assert.equal(result.code, 1);
  assert.match(result.why, /waited 2 min for a Lab runner slot \(3 ahead, 0 free\)/);
  assert.equal(result.slot, undefined, "no slot is handed out on a timeout");
  assert.deepEqual(timing.sleeps, [30_000, 30_000, 30_000, 30_000], "2 minutes of 30 s polls, then the check fails");
  assert.doesNotMatch(result.why + logs.join("\n"), new RegExp(SECRET_TOKEN));
});

test("acquire refuses a run whose ids are missing, before any call", async () => {
  const result = await acquireSlot({
    env: connectedEnv({ GITHUB_RUN_ID: "not-a-number" }),
    listActive: async () => {
      throw new Error("must not run");
    },
    callConvex: async () => {
      throw new Error("must not run");
    },
    log: () => {},
    ...clock(),
  });
  assert.equal(result.code, 1);
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

test("no connected slot: the why file says so, nothing reaches GITHUB_OUTPUT, and the exit code is 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-lease-why-"));
  const output = join(dir, "output");
  const logs = [];
  const code = await runCommand(["acquire"], {
    env: { GITHUB_RUN_ID: "4242", GITHUB_RUN_ATTEMPT: "1", RUN_ID: "k57labrun0000000001", GITHUB_REPOSITORY: "Supa-Media/context", GITHUB_OUTPUT: output, RUNNER_TEMP: dir },
    listActive: async () => [],
    callConvex: async () => ({ slot: 1 }),
    log: (line) => logs.push(line),
    ...clock(),
  });
  assert.equal(code, 1);
  const why = await readFile(join(dir, "why"), "utf8");
  assert.match(why, /^no Lab runner slot is connected: run `pnpm ai connect --lab-slot 1`/);
  await assert.rejects(readFile(output, "utf8"), /ENOENT/, "no output is written on failure");
  assert.doesNotMatch(why + logs.join("\n"), new RegExp(SECRET_TOKEN));
  assert.doesNotMatch(why, /LAB_RUNNER_\d_REFRESH_TOKEN=/);
});

test("runCommand: a timeout writes the why file and exits 1, with no output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-lease-timeout-"));
  const output = join(dir, "output");
  const timing = clock();
  const logs = [];
  const code = await runCommand(["acquire", "--max-minutes", "1"], {
    env: connectedEnv({ GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "Supa-Media/context", RUNNER_TEMP: dir }),
    listActive: async () => [],
    callConvex: async () => ({ waiting: 2, free: 0 }),
    log: (line) => logs.push(line),
    ...timing,
  });
  assert.equal(code, 1);
  assert.match(await readFile(join(dir, "why"), "utf8"), /waited 1 min for a Lab runner slot \(2 ahead, 0 free\)/);
  await assert.rejects(readFile(output, "utf8"), /ENOENT/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET_TOKEN));
});

test("release through runCommand exits 0 and logs no secret", async () => {
  const logs = [];
  const seen = [];
  const code = await runCommand(["release"], {
    env: connectedEnv(),
    callConvex: async (fn, args) => {
      seen.push([fn, args]);
      return { released: false };
    },
    log: (line) => logs.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [["functions/labRunnerSlots:release", { ghRunId: "4242", attempt: 1 }]]);
  assert.deepEqual(logs, ["No Lab runner slot was held by this run"]);
});
