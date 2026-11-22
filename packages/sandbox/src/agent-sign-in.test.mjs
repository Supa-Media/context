import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authStorageKeys, keygen, mint, open, parsePublicKey, proof, seal, storageState, unseal } from "./agent-sign-in.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "agent-sign-in-"));
const ORIGIN = "https://context-router-pr42.fake-sub.workers.dev";

function env(overrides = {}) {
  return { PR: "42", PERSONA: "alpha", PREVIEW_ROUTER_ORIGIN: ORIGIN, CONVEX_DEPLOY_KEY: "preview:team|proj|fake", ...overrides };
}

async function minted(publicKey, overrides = {}, { signIn } = {}) {
  const lines = [];
  const calls = [];
  await mint(env({ PUBLIC_KEY: publicKey, ...overrides }), {
    find: async (key, name) => (name === "pr42" ? "example-deployment" : null),
    signIn: signIn ?? (async (args) => (calls.push(args), { token: "jwt-fake", refreshToken: "refresh-fake" })),
    log: (line) => lines.push(line),
  });
  return { lines, calls };
}

test("a session minted in CI opens only with the agent's private key, and the log holds no token", async () => {
  const keyFile = join(dir(), "key.pem");
  const pub = keygen(keyFile, { log: () => {} });
  const { lines, calls } = await minted(pub);
  const log = lines.join("\n");
  assert.ok(!log.includes("jwt-fake") && !log.includes("refresh-fake") && !log.includes("fake-sub") && !log.includes("example-deployment"), "nothing readable in the public log");
  assert.deepEqual(calls[0], { convexUrl: "https://example-deployment.convex.cloud", deployment: "example-deployment", deployKey: "preview:team|proj|fake", email: "alpha@supa.media" });

  const state = join(dir(), "state.json");
  const payload = await open(`noise\n2026 ${log}\nmore`, { keyFile, stateFile: state, log: () => {} });
  assert.equal(payload.origin, ORIGIN);
  assert.equal(payload.persona, "alpha");
  const keys = authStorageKeys("https://example-deployment.convex.cloud");
  assert.equal(keys.jwt, "__convexAuthJWT_httpsexampledeploymentconvexcloud");
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).origins[0].localStorage, [
    { name: keys.jwt, value: "jwt-fake" },
    { name: keys.refresh, value: "refresh-fake" },
  ]);
});

test("another key cannot open the line, and a tampered line is refused", async () => {
  const pub = keygen(join(dir(), "a.pem"), { log: () => {} });
  const { lines } = await minted(pub);
  const other = generateKeyPairSync("x25519").privateKey;
  assert.throws(() => unseal(lines[0], other), /not sealed to this key/);
  const keyFile = join(dir(), "b.pem");
  const mine = keygen(keyFile, { log: () => {} });
  const { lines: again } = await minted(mine);
  const tampered = again[0].slice(0, -2) + (again[0].endsWith("A") ? "BB" : "AA");
  assert.throws(() => unseal(tampered, createPrivateKey(readFileSync(keyFile))), /not sealed to this key/);
});

test("mint refuses anything but a fixture persona on this pull request's preview", async () => {
  const pub = keygen(join(dir(), "k.pem"), { log: () => {} });
  await assert.rejects(minted(pub, { PERSONA: "seyi" }), /PERSONA/);
  await assert.rejects(minted(pub, { PR: "42; rm -rf /" }), /PR must/);
  await assert.rejects(minted(pub, { PREVIEW_ROUTER_ORIGIN: "https://context.lc" }), /preview router/);
  await assert.rejects(minted(pub, { PREVIEW_ROUTER_ORIGIN: "https://context-router-pr43.fake.workers.dev" }), /preview router/);
  await assert.rejects(minted(pub, { CONVEX_DEPLOY_KEY: "prod:context|abc" }), /preview deploy key/);
  await assert.rejects(minted(pub, { PR: "43", PREVIEW_ROUTER_ORIGIN: "https://context-router-pr43.fake.workers.dev" }), /no preview deployment/);
  await assert.rejects(minted("not-a-key"), /PUBLIC_KEY/);
  await assert.rejects(minted(pub, {}, { signIn: async () => null }), /failed/);
});

test("open refuses a sealed origin that is not a preview router", async () => {
  const keyFile = join(dir(), "k.pem");
  const pub = keygen(keyFile, { log: () => {} });
  const line = seal({ v: 1, pr: 1, persona: "alpha", origin: "https://context.lc", convexUrl: "https://example-deployment.convex.cloud", token: "t", refreshToken: "r" }, parsePublicKey(pub));
  await assert.rejects(open(line, { keyFile, stateFile: join(dir(), "s.json"), log: () => {} }), /not a preview router/);
});

test("storage state puts the session on the preview's own origin", () => {
  const state = storageState({ origin: ORIGIN, convexUrl: "https://example-deployment.convex.cloud", token: "t", refreshToken: "r" });
  assert.equal(state.origins.length, 1);
  assert.equal(state.origins[0].origin, ORIGIN);
});

test("a waiting email code reaches only the agent: sealed in the log, printed by open", async () => {
  const keyFile = join(dir(), "key.pem");
  const pub = keygen(keyFile, { log: () => {} });
  const lines = [];
  const calls = [];
  await proof(env({ PUBLIC_KEY: pub, PERSONA: "beta" }), {
    find: async (key, name) => (name === "pr42" ? "example-deployment" : null),
    issue: async (args) => (calls.push(args), "482913"),
    log: (line) => lines.push(line),
  });
  const log = lines.join("\n");
  assert.ok(!log.includes("482913") && !log.includes("example-deployment"), "nothing readable in the public log");
  assert.deepEqual(calls[0], { deployment: "example-deployment", deployKey: "preview:team|proj|fake", email: "beta@supa.media" });
  const said = [];
  const opened = await open(log, { keyFile, log: (line) => said.push(line) });
  assert.equal(opened.code, "482913");
  assert.match(said.join("\n"), /beta on preview pr42: 482913/);
});

test("proof refuses anything but a fixture persona and a preview deploy key", async () => {
  const pub = keygen(join(dir(), "k.pem"), { log: () => {} });
  const options = { find: async () => "example-deployment", issue: async () => "111111", log: () => {} };
  await assert.rejects(proof(env({ PUBLIC_KEY: pub, PERSONA: "seyi" }), options), /PERSONA must be one of/);
  await assert.rejects(proof(env({ PUBLIC_KEY: pub, CONVEX_DEPLOY_KEY: "prod:team|x" }), options), /preview deploy key/);
  await assert.rejects(proof(env({ PUBLIC_KEY: pub }), { ...options, find: async () => null }), /no preview deployment/);
});
