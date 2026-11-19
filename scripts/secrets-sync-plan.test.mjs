import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowlistProblems,
  isNotFound,
  loadAllowlist,
  secretAllowlistFor,
  syncVariables,
  variablesFor,
} from "./secrets-sync-plan.mjs";

const cfg = {
  required: ["DEPLOY_KEY"],
  optional: ["STAGING_ONLY_KEY", "OTHER_KEY"],
  variables: { required: ["APP_ORIGIN"], optional: ["FLAG", "PROD_FLAG"] },
  onlyIn: { STAGING_ONLY_KEY: ["staging"], PROD_FLAG: ["production"] },
};

test("the real allowlist is well formed", () => {
  assert.deepEqual(allowlistProblems(loadAllowlist()), []);
});

test("AgentMail goes to staging and never to production", () => {
  const real = loadAllowlist();
  for (const name of ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX"]) {
    assert.ok(secretAllowlistFor(real, "staging").optional.includes(name), `${name} in staging`);
    const production = secretAllowlistFor(real, "production");
    assert.ok(!production.optional.includes(name) && !production.required.includes(name), `${name} not in production`);
  }
});

test("no variable is written as a secret, in either environment", () => {
  const real = loadAllowlist();
  for (const env of ["staging", "production"]) {
    const secrets = secretAllowlistFor(real, env);
    for (const { name } of variablesFor(real, env)) {
      assert.ok(![...secrets.required, ...secrets.optional].includes(name), `${name} in ${env} secrets`);
    }
  }
});

test("nothing that grants access is a variable", () => {
  const real = loadAllowlist();
  const names = [...real.variables.required, ...real.variables.optional];
  for (const name of names) {
    assert.doesNotMatch(name, /SECRET|TOKEN|PASSWORD|PRIVATE|_DSN$|_P8$|CSC_|_API_KEY$|JWT|JWKS|DEPLOY_KEY/, name);
  }
});

test("secretAllowlistFor drops variables and other environments' names", () => {
  assert.deepEqual(secretAllowlistFor(cfg, "production"), { required: ["DEPLOY_KEY"], optional: ["OTHER_KEY"] });
  assert.deepEqual(secretAllowlistFor(cfg, "staging"), {
    required: ["DEPLOY_KEY"],
    optional: ["STAGING_ONLY_KEY", "OTHER_KEY"],
  });
  assert.throws(() => secretAllowlistFor(cfg, "both"), /unknown environment/);
});

test("variablesFor honours onlyIn and keeps required-ness", () => {
  assert.deepEqual(variablesFor(cfg, "staging"), [
    { name: "APP_ORIGIN", required: true },
    { name: "FLAG", required: false },
  ]);
  assert.deepEqual(
    variablesFor(cfg, "production").map((v) => v.name),
    ["APP_ORIGIN", "FLAG", "PROD_FLAG"],
  );
});

test("allowlistProblems catches a name in both lists and a bad onlyIn", () => {
  const problems = allowlistProblems({
    required: ["A"],
    variables: { optional: ["A"] },
    onlyIn: { B: ["staging"], A: ["prod"] },
  });
  assert.ok(problems.some((p) => p.includes("A is listed twice")));
  assert.ok(problems.some((p) => p.includes("onlyIn names B")));
  assert.ok(problems.some((p) => p.includes("unknown environment prod")));
});

test("only 1Password's not-found wording counts as absent", () => {
  assert.ok(isNotFound('"X" isn\'t an item in the "Context" vault'));
  assert.ok(isNotFound("item 'X' does not have a field 'production'"));
  assert.ok(!isNotFound("[ERROR] rate limit exceeded"));
});

function fakeIo({ vault = {}, github = [], failing = new Set() } = {}) {
  const calls = { set: [], delete: [], logs: [], reads: [] };
  return {
    calls,
    io: {
      read: async (ref) => {
        calls.reads.push(ref);
        const name = ref.split("/")[3];
        if (failing.has(name)) throw Object.assign(new Error("x"), { stderr: "[ERROR] network" });
        if (!(name in vault)) throw Object.assign(new Error("x"), { stderr: `"${name}" isn't an item in the "Context" vault` });
        return vault[name];
      },
      listVariables: async () => github,
      setVariable: async (env, name, value) => calls.set.push([env, name, value]),
      deleteVariable: async (env, name) => calls.delete.push([env, name]),
      log: (line) => calls.logs.push(line),
      sleep: async () => {},
    },
  };
}

test("writes every found variable for the environment, reading that environment's field", async () => {
  const { io, calls } = fakeIo({ vault: { APP_ORIGIN: "https://example.test", FLAG: "on", PROD_FLAG: "x" } });
  const result = await syncVariables({ cfg, env: "staging", vault: "Context", io });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.set, [
    ["staging", "APP_ORIGIN", "https://example.test"],
    ["staging", "FLAG", "on"],
  ]);
  assert.deepEqual(calls.reads, ["op://Context/APP_ORIGIN/staging", "op://Context/FLAG/staging"]);
});

test("never prints a value", async () => {
  const { io, calls } = fakeIo({ vault: { APP_ORIGIN: "VALUE-MARKER-1", FLAG: "VALUE-MARKER-2" } });
  await syncVariables({ cfg, env: "production", vault: "Context", io });
  assert.ok(!calls.logs.join("\n").includes("VALUE-MARKER"));
});

test("a missing required variable writes nothing at all", async () => {
  const { io, calls } = fakeIo({ vault: { FLAG: "on" } });
  const result = await syncVariables({ cfg, env: "staging", vault: "Context", io });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingRequired, ["APP_ORIGIN"]);
  assert.deepEqual(calls.set, []);
});

test("a read error is never an absence: retries, then writes nothing and prunes nothing", async () => {
  const { io, calls } = fakeIo({ vault: { APP_ORIGIN: "o" }, github: ["FLAG"], failing: new Set(["FLAG"]) });
  const result = await syncVariables({ cfg, env: "staging", vault: "Context", prune: true, io });
  assert.equal(result.ok, false);
  assert.deepEqual(result.readErrors, ["FLAG"]);
  assert.equal(calls.reads.filter((r) => r.includes("/FLAG/")).length, 3);
  assert.deepEqual(calls.set, []);
  assert.deepEqual(calls.delete, []);
});

test("an absent optional variable is kept unless prune", async () => {
  const kept = fakeIo({ vault: { APP_ORIGIN: "o" }, github: ["FLAG"] });
  await syncVariables({ cfg, env: "staging", vault: "Context", io: kept.io });
  assert.deepEqual(kept.calls.delete, []);

  const pruned = fakeIo({ vault: { APP_ORIGIN: "o" }, github: ["FLAG"] });
  await syncVariables({ cfg, env: "staging", vault: "Context", prune: true, io: pruned.io });
  assert.deepEqual(pruned.calls.delete, [["staging", "FLAG"]]);
});

test("an empty vault field is an absence, not an empty variable", async () => {
  const { io, calls } = fakeIo({ vault: { APP_ORIGIN: "o", FLAG: "" } });
  await syncVariables({ cfg, env: "staging", vault: "Context", io });
  assert.deepEqual(calls.set.map(([, name]) => name), ["APP_ORIGIN"]);
});

test("dry run writes and deletes nothing", async () => {
  const { io, calls } = fakeIo({ vault: { APP_ORIGIN: "o" }, github: ["FLAG"] });
  const result = await syncVariables({ cfg, env: "staging", vault: "Context", dryRun: true, prune: true, io });
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 2);
  assert.deepEqual(calls.set, []);
  assert.deepEqual(calls.delete, []);
});
