/**
 * GitHub, connected by an owner installing the deployment's read-only GitHub App (`src/data/connect/githubApp.js`,
 * `github.js`, the `github_start`, `github_finish` and `github_repos` ops of `POST /files/data-sync`), end to end
 * through the worker over real workspace objects in memory, with GitHub answered by host.
 *
 * The properties with teeth: an installation binds only when the state is the asking owner's own and GitHub lists
 * the installation among the ones that owner can reach; no token is kept, logged or answered (the owner's is
 * revoked, the installation's is minted each run, read-only); a run reads only the repositories picked.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `finishGithub` skipping the state's person check: "a state that isn't this owner's own, or has expired, binds
 *    nothing" fails.
 * 2. `checkGithubInstall` skipping the installations list: "an installation the owner can't reach is refused, and
 *    nothing is kept" fails.
 * 3. `installationToken` asking without `READ_ONLY`: "an owner installs GitHub: ..." fails.
 * 4. `readGithub` ignoring the pick: "the owner picks repositories: ..." fails.
 * 5. `fillDeployed` taking a deployment that started before the merge: "a pull request's deployed is the first
 *    production deployment after its merge" fails.
 * 6. The deploy read sending `branch` too: "Deploy to Production runs are read on every branch: ..." fails.
 * 7. The deploy read's 404 no longer skipped: the same test fails, and "an owner installs GitHub: ..." fails too
 *    (repo supa/context answers 404 for its deploy workflow).
 * 8. `mergeSynced` (`sync/keep.js`) adding an incoming row whose key it already holds as a second row: the same test
 *    fails, and "an owner installs GitHub: ..." fails too.
 * 9. The deploy workflow read removed (`DEPLOY_WORKFLOWS` read as empty): "Deploy to Production runs are read on
 *    every branch: ..." and "a non-404 failure of the deploy read ..." fail, and "an owner installs GitHub: ..." fails.
 * 10. The deploy read taking its span from every kept run of the repository, as the default-branch read once did:
 *    "each workflow-runs read keeps its own window: ..." fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

import { parseSheet } from "../src/sheets/csv.js";
import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { READ_ONLY, installState, readInstallState } from "../src/data/connect/githubApp.js";
import { fillDeployed, pullRequestRow } from "../src/data/connect/github.js";
import { skip, noteId, NOW, SECRET, world, send, dataObject, roleOf } from "./dataSyncWorld.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
const CLIENT_ID = "Iv1.testclient";
const CLIENT_SECRET = "client-secret-for-tests";
const CALLBACK = "https://context.lc/data/github/callback";
const USER_TOKEN = "ghu_userTokenForTestsOnly0000";
const INSTALL_TOKEN = "ghs_installTokenForTestsOnly00";
const CODE = "oneTimeCode123";
const INSTALLATION = "77";
const ABOUT = "data/github/about.md";
const ABOUT_TEXT = (source = "github") => `---\nsource: ${source}\nname: "GitHub"\n---\n\nConnected by an owner.\n`;

function withGithubApp(w) {
  Object.assign(w.env, { GH_DATA_APP_ID: "4242", GH_DATA_PRIVATE_KEY: privateKey, GH_DATA_APP_SLUG: "context-data", GH_DATA_CLIENT_ID: CLIENT_ID, GH_DATA_CLIENT_SECRET: CLIENT_SECRET, APP_ORIGIN: "https://context.lc" });
}

/** A github/ source folder with its about.md and its three empty sheets. */
async function withSource(w, who, source = "github") {
  const ids = { about: noteId(40, who.pwid), pulls: noteId(41, who.pwid), deploys: noteId(42, who.pwid), runs: noteId(43, who.pwid) };
  who.object.store.rows.put([
    { id: `d-gh-${who.pwid}`, path: "data/github", kind: "folder", at: 10 },
    { id: `f-gh-${who.pwid}`, path: ABOUT, kind: "file", at: 11, storageKey: `notes/${ids.about}.md`, noteId: ids.about, etag: "e-g" },
    { id: `f-pr-${who.pwid}`, path: "data/github/pull-requests.csv", kind: "file", at: 12, storageKey: `files/${ids.pulls}.csv`, noteId: ids.pulls, etag: "e-pr" },
    { id: `f-dp-${who.pwid}`, path: "data/github/deploys.csv", kind: "file", at: 13, storageKey: `files/${ids.deploys}.csv`, noteId: ids.deploys, etag: "e-dp" },
    { id: `f-wr-${who.pwid}`, path: "data/github/workflow-runs.csv", kind: "file", at: 14, storageKey: `files/${ids.runs}.csv`, noteId: ids.runs, etag: "e-wr" },
  ]);
  await who.object.store.objects.put(`notes/${ids.about}.md`, ABOUT_TEXT(source));
  for (const id of [ids.pulls, ids.deploys, ids.runs]) await who.bucket.put(`files/${id}.csv`, "");
  return ids;
}

const pr = (number, opened, merged, updated = merged ?? opened) => ({ number, title: `Change ${number}`, createdAt: opened, mergedAt: merged, updatedAt: updated, additions: 10 * number, deletions: number, author: { login: "dev" } });

/** GitHub as it answers, recording each call's host, path and the authorization it carried. */
const DEPLOY_RUN = { id: 7001, name: "Deploy to Production", head_branch: `prod-deploy/${"c".repeat(40)}`, run_started_at: "2026-11-25T08:30:00Z", updated_at: "2026-11-25T08:50:00Z", conclusion: "failure" };
const CI_RUN = { id: 5001, name: "CI", head_branch: "main", run_started_at: "2026-11-25T08:00:00Z", updated_at: "2026-11-25T08:09:00Z", conclusion: "success" };
/** The deploy workflow's runs per repo: the one deploy on a prod-deploy branch for supa/app, and a 404 for supa/context. */
const DEFAULT_DEPLOY_RUNS = (repo) => (repo === "supa/app" ? [DEPLOY_RUN] : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

function github(w, { installations = [Number(INSTALLATION)], mintStatus = 200, repos = ["supa/app", "supa/context"], trade = null, deployRuns = DEFAULT_DEPLOY_RUNS, mainRuns = (repo) => (repo === "supa/app" ? [CI_RUN] : []) } = {}) {
  const seen = [];
  const auth = (init) => String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
  w.net.answers.set("github.com", (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ host: "github.com", path: new URL(url).pathname, auth: auth(init), body });
    if (trade !== null) return trade(body);
    // GitHub answers a refused exchange 200, with its reason in the body and no token.
    const good = body.code === CODE && body.client_id === CLIENT_ID && body.client_secret === CLIENT_SECRET && body.redirect_uri === CALLBACK;
    return Response.json(good ? { access_token: USER_TOKEN } : { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
  });
  w.net.answers.set("api.github.com", (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const call = { host: "api.github.com", path: pathname, method: init?.method ?? "GET", auth: auth(init), body: init?.body ? JSON.parse(init.body) : null, query: searchParams };
    seen.push(call);
    if (pathname === "/user/installations") return call.auth === `Bearer ${USER_TOKEN}` ? Response.json({ installations: installations.map((id) => ({ id })) }) : new Response("{}", { status: 401 });
    if (pathname.startsWith("/applications/")) return new Response(null, { status: 204 });
    const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (minting) {
      const [head, claims, signature] = call.auth.replace(/^Bearer /, "").split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${head}.${claims}`);
      const signed = verifier.verify(publicKey, Buffer.from(signature, "base64url"));
      const iss = JSON.parse(Buffer.from(claims, "base64url").toString()).iss;
      if (!signed || iss !== "4242") return new Response("{}", { status: 401 });
      if (minting[1] !== INSTALLATION || mintStatus !== 200) return new Response("{}", { status: mintStatus === 200 ? 404 : mintStatus });
      return Response.json({ token: INSTALL_TOKEN });
    }
    if (call.auth !== `Bearer ${INSTALL_TOKEN}`) return new Response("{}", { status: 401 });
    if (pathname === "/installation/repositories") return Response.json({ repositories: repos.map((full_name) => ({ full_name, default_branch: "main", private: true })) });
    if (pathname === "/graphql") {
      const { query, variables } = call.body;
      call.repo = variables.owner ? `${variables.owner}/${variables.name}` : variables.q;
      if (query.includes("pullRequests")) {
        const nodes = variables.name === "app" ? [pr(2, "2026-11-24T09:00:00Z", "2026-11-24T10:00:00Z"), pr(1, "2026-11-20T09:00:00Z", null, "2026-11-24T08:00:00Z")] : [];
        return Response.json({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false } } } } });
      }
      if (query.includes("deployments")) {
        const nodes = variables.name === "app"
          ? [
              { databaseId: 902, commitOid: "b".repeat(40), environment: "production", createdAt: "2026-11-24T11:00:00Z", latestStatus: { state: "SUCCESS", createdAt: "2026-11-24T11:20:00Z" } },
              { databaseId: 901, commitOid: "a".repeat(40), environment: "production", createdAt: "2026-11-24T09:30:00Z", latestStatus: { state: "SUCCESS", createdAt: "2026-11-24T09:40:00Z" } },
            ]
          : [];
        return Response.json({ data: { repository: { deployments: { nodes, pageInfo: { hasNextPage: false } } } } });
      }
      return Response.json({ data: { search: { nodes: [], pageInfo: { hasNextPage: false } } } });
    }
    const deploying = /^\/repos\/(.+)\/actions\/workflows\/([^/]+)\/runs$/.exec(pathname);
    if (deploying) {
      const answer = deployRuns(deploying[1]);
      return answer instanceof Response ? answer : Response.json({ workflow_runs: answer });
    }
    if (/\/actions\/runs$/.test(pathname)) return Response.json({ workflow_runs: mainRuns(pathname.replace(/^\/repos\/|\/actions\/runs$/g, "")) });
    return new Response("{}", { status: 404 });
  });
  return seen;
}

const start = (w, who, about = ABOUT, options) => send(w, who, { workspaceId: who.pwid, op: "github_start", about }, options);
const finish = (w, who, state, extra = {}) => send(w, who, { workspaceId: who.pwid, op: "github_finish", state, code: CODE, installation: INSTALLATION, ...extra });
const sheet = async (who, id) => parseSheet((await (await who.bucket.get(`files/${id}.csv`))?.text()) ?? "");
const stateOf = (answer) => new URL(answer.body.url).searchParams.get("state");

/** Every console line while `work` runs, so a test can say no token reached a log. */
async function logsOf(work) {
  const lines = [];
  const was = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...parts) => lines.push(parts.join(" "));
  try {
    return { result: await work(), lines };
  } finally {
    Object.assign(console, was);
  }
}

async function installed(w, options) {
  withGithubApp(w);
  const ids = await withSource(w, w.alice);
  const seen = github(w, options);
  const started = await start(w, w.alice);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { ids, seen, state: stateOf(started) };
}

test("a pull request's deployed is the first production deployment after its merge", () => {
  const pull = pullRequestRow("supa/app", pr(3, "2026-11-20T09:00:00Z", "2026-11-24T10:00:00Z"));
  assert.equal(pull.id, "supa/app#3");
  const deploys = [
    { repo: "supa/app", status: "success", started: "2026-11-24T09:30:00Z", finished: "2026-11-24T09:40:00Z" },
    { repo: "supa/app", status: "failure", started: "2026-11-24T10:30:00Z", finished: "2026-11-24T10:35:00Z" },
    { repo: "supa/app", status: "success", started: "2026-11-24T11:00:00Z", finished: "2026-11-24T11:20:00Z" },
    { repo: "supa/site", status: "success", started: "2026-11-24T10:10:00Z", finished: "2026-11-24T10:12:00Z" },
  ];
  assert.deepEqual(fillDeployed([pull], deploys).map((row) => row.deployed), ["2026-11-24T11:20:00Z"]);
  assert.deepEqual(fillDeployed([{ ...pull, merged: "" }], deploys), []);
});

test("an install state holds only its own signature, for 30 minutes", async () => {
  const state = await installState({ secret: SECRET, workspaceId: "pAlice", userId: "uAlice", noteId: "n1", nowMs: NOW });
  assert.deepEqual(await readInstallState({ secret: SECRET, state, nowMs: NOW + 60_000 }), { workspaceId: "pAlice", userId: "uAlice", noteId: "n1" });
  assert.equal(await readInstallState({ secret: SECRET, state, nowMs: NOW + 31 * 60_000 }), null);
  assert.equal(await readInstallState({ secret: `${SECRET}-other`, state, nowMs: NOW }), null);
  const [body, mac] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), w: "pBob" })).toString("base64url");
  assert.equal(await readInstallState({ secret: SECRET, state: `${forged}.${mac}`, nowMs: NOW }), null);
});

test("an owner installs GitHub: the owner's token is revoked, nothing is kept but the installation, and three sheets fill", { skip }, async () => {
  const w = await world();
  const { ids, seen, state } = await installed(w);
  const { result: done, lines } = await logsOf(() => finish(w, w.alice, state));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.armed, true);
  assert.equal(done.body.last.outcome, "ok", JSON.stringify(done.body.last));
  // The owner's own token asked who could reach the installation, then was revoked.
  assert.ok(seen.some((call) => call.path === "/user/installations" && call.auth === `Bearer ${USER_TOKEN}`));
  assert.ok(seen.some((call) => call.path === `/applications/${CLIENT_ID}/token` && call.method === "DELETE"));
  // Every installation token asked for exactly read-only access.
  const mints = seen.filter((call) => call.path.endsWith("/access_tokens"));
  assert.ok(mints.length >= 1);
  for (const mint of mints) assert.deepEqual(mint.body, { permissions: { ...READ_ONLY } });
  // No token in an answer, a log, the object's storage or the bucket.
  const object = dataObject(w, "pAlice");
  for (const secret of [USER_TOKEN, INSTALL_TOKEN, CODE]) {
    assert.equal(JSON.stringify(done.body).includes(secret), false);
    assert.equal(lines.some((line) => line.includes(secret)), false, `${secret} reached a log`);
    assert.equal(JSON.stringify([...object.storage.map.values()]).includes(secret), false);
    for (const [key, value] of w.alice.bucket.objects) assert.equal(String(value.body ?? "").includes(secret), false, key);
  }
  assert.equal(typeof object.storage.map.get("connections").github.sealed, "string");
  assert.equal(object.storage.alarm, NOW + SYNC_EVERY_MS);
  const pulls = (await sheet(w.alice, ids.pulls)).rows;
  assert.deepEqual(
    pulls.map((row) => [row.id, row.merged, row.deployed, row.lines_added]).sort(),
    [
      ["supa/app#1", "", "", "10"],
      ["supa/app#2", "2026-11-24T10:00:00Z", "2026-11-24T11:20:00Z", "20"],
    ],
  );
  assert.deepEqual((await sheet(w.alice, ids.deploys)).rows.map((row) => [row.id, row.status]).sort(), [["901", "success"], ["902", "success"]]);
  assert.deepEqual(
    (await sheet(w.alice, ids.runs)).rows.map((row) => [row.id, row.workflow, row.branch, row.conclusion]).sort(),
    [
      ["5001", "CI", "main", "success"],
      ["7001", "Deploy to Production", `prod-deploy/${"c".repeat(40)}`, "failure"],
    ],
  );
  assert.ok(w.net.calls.every((url) => ["api.github.com", "github.com"].includes(new URL(url).hostname)));
});

test("Deploy to Production runs are read on every branch: no branch param, the workflow's own URL, a repo without it skipped, a run both reads find stored once", { skip }, async () => {
  const w = await world();
  const deployOnMain = { id: 7002, name: "Deploy to Production", head_branch: "main", run_started_at: "2026-11-25T09:00:00Z", updated_at: "2026-11-25T09:10:00Z", conclusion: "success" };
  const { ids, seen, state } = await installed(w, {
    mainRuns: (repo) => (repo === "supa/app" ? [CI_RUN, deployOnMain] : []),
    deployRuns: (repo) => (repo === "supa/app" ? [DEPLOY_RUN, deployOnMain] : new Response("{}", { status: 404 })),
  });
  const done = await finish(w, w.alice, state);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.last.outcome, "ok", JSON.stringify(done.body.last));
  const deployCalls = seen.filter((call) => call.path.endsWith("/actions/workflows/deploy-production.yml/runs"));
  assert.ok(deployCalls.some((call) => call.query.has("created")), "the deploy read ran");
  for (const call of deployCalls) {
    assert.equal(call.query.has("branch"), false, "the deploy read takes no branch");
    assert.equal(call.query.get("status"), "completed");
    assert.equal(call.query.get("per_page"), "100");
    assert.ok(call.query.has("created"));
  }
  assert.ok(deployCalls.some((call) => call.path === "/repos/supa/context/actions/workflows/deploy-production.yml/runs"), "supa/context's deploy read was made");
  const mainCalls = seen.filter((call) => call.path === "/repos/supa/app/actions/runs");
  assert.ok(mainCalls.length > 0);
  for (const call of mainCalls) assert.equal(call.query.get("branch"), "main");
  const rows = (await sheet(w.alice, ids.runs)).rows;
  assert.deepEqual(rows.map((row) => row.id).sort(), ["5001", "7001", "7002"]);
  const text = await (await w.alice.bucket.get(`files/${ids.runs}.csv`)).text();
  assert.equal(text.split("\n").filter((line) => line.startsWith("7002,")).length, 1, "run 7002 is stored once");
});

test("each workflow-runs read keeps its own window: kept default-branch runs don't cut the deploy read to a day", { skip }, async () => {
  const w = await world();
  const { ids, seen, state } = await installed(w);
  const runFloor = NOW - 30 * 86_400_000;
  const kept = [
    "id,repo,workflow,branch,started,finished,conclusion",
    "4001,supa/app,CI,main,2026-11-24T12:00:00Z,2026-11-24T12:05:00Z,success",
    "4002,supa/app,CI,main,2026-10-28T00:00:00Z,2026-10-28T00:05:00Z,success",
  ].join("\n");
  await w.alice.bucket.put(`files/${ids.runs}.csv`, `${kept}\n`);
  const done = await finish(w, w.alice, state);
  assert.equal(done.body.last.outcome, "ok", JSON.stringify(done.body.last));
  const created = (path) => seen.filter((call) => call.path === path).map((call) => call.query.get("created"));
  // The default-branch read: a day before its newest kept run, then the history back to the floor.
  assert.deepEqual(created("/repos/supa/app/actions/runs"), [">=2026-11-23T12:00:00.000Z", `${new Date(runFloor).toISOString()}..2026-10-28T00:00:00.000Z`]);
  // The deploy read has no kept rows of its own yet, so it reads the whole 30 days.
  assert.deepEqual(created("/repos/supa/app/actions/workflows/deploy-production.yml/runs"), [`>=${new Date(runFloor).toISOString()}`]);
});

test("a non-404 failure of the deploy read fails the run and keeps no workflow runs", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w, { deployRuns: (repo) => (repo === "supa/app" ? new Response("{}", { status: 500 }) : []) });
  const done = await finish(w, w.alice, state);
  assert.notEqual(done.body.last.outcome, "ok", JSON.stringify(done.body.last));
  assert.equal((await sheet(w.alice, ids.runs)).rows.length, 0);
});

test("a state that isn't this owner's own, or has expired, binds nothing", { skip }, async () => {
  const w = await world();
  const { ids, seen } = await installed(w);
  const others = await installState({ secret: SECRET, workspaceId: "pAlice", userId: "uMallory", noteId: ids.about, nowMs: Date.now() });
  const elsewhere = await installState({ secret: SECRET, workspaceId: "pBob", userId: "uAlice", noteId: ids.about, nowMs: Date.now() });
  const stale = await installState({ secret: SECRET, workspaceId: "pAlice", userId: "uAlice", noteId: ids.about, nowMs: Date.now() - 31 * 60_000 });
  assert.equal((await finish(w, w.alice, others)).status, 403);
  assert.equal((await finish(w, w.alice, elsewhere)).status, 403);
  assert.equal((await finish(w, w.alice, stale)).status, 400);
  assert.equal(seen.filter((call) => call.host === "github.com").length, 0, "no code was traded");
  assert.equal(dataObject(w, "pAlice")?.storage.map.get("connections"), undefined);
});

test("an installation the owner can't reach is refused, and nothing is kept", { skip }, async () => {
  const w = await world();
  withGithubApp(w);
  await withSource(w, w.alice);
  const seen = github(w, { installations: [12] });
  const done = await finish(w, w.alice, stateOf(await start(w, w.alice)));
  assert.equal(done.status, 400);
  assert.match(done.body.message, /isn't one you can reach/);
  assert.ok(seen.some((call) => call.method === "DELETE"), "the owner's token was revoked anyway");
  assert.equal(seen.some((call) => call.path.endsWith("/access_tokens")), false);
  assert.equal(dataObject(w, "pAlice").storage.map.get("connections"), undefined);
});

// Sabotage: drop `redirect_uri` from the exchange and the first assertion fails; drop `tradeRefusal`'s reason and the
// message assertions fail.
test("a refused code exchange binds nothing and says GitHub's reason, never a secret", { skip }, async () => {
  const w = await world();
  const { seen, state } = await installed(w);
  const { result: done, lines } = await logsOf(() => finish(w, w.alice, state, { code: "staleCode999" }));
  const traded = seen.find((call) => call.host === "github.com");
  assert.equal(traded.body.redirect_uri, CALLBACK);
  assert.equal(done.status, 400);
  assert.match(done.body.message, /didn't confirm who approved it \(bad_verification_code: The code passed is incorrect or expired\); connect it again/);
  for (const secret of [CLIENT_SECRET, "staleCode999", "PRIVATE KEY"]) {
    assert.equal(JSON.stringify(done.body).includes(secret), false, `${secret} reached the answer`);
    assert.equal(lines.some((line) => line.includes(secret)), false, `${secret} reached a log`);
  }
  assert.equal(seen.some((call) => call.host === "api.github.com"), false, "nothing was asked with no token");
  assert.equal(dataObject(w, "pAlice").storage.map.get("connections"), undefined);
});

test("a token endpoint that fails outright, or echoes a secret, is named without it", { skip }, async () => {
  const w = await world();
  withGithubApp(w);
  await withSource(w, w.alice);
  github(w, { trade: () => new Response("oops", { status: 502 }) });
  const failed = await finish(w, w.alice, stateOf(await start(w, w.alice)));
  assert.equal(failed.status, 400);
  assert.match(failed.body.message, /\(GitHub answered 502\)/);

  const v = await world();
  withGithubApp(v);
  await withSource(v, v.alice);
  github(v, { trade: (body) => Response.json({ error: "incorrect_client_credentials", error_description: `secret ${body.client_secret} is wrong`, access_token: 7 }) });
  const echoed = await finish(v, v.alice, stateOf(await start(v, v.alice)));
  assert.equal(echoed.status, 400);
  assert.match(echoed.body.message, /\(incorrect_client_credentials\); connect it again/);
  assert.equal(JSON.stringify(echoed.body).includes(CLIENT_SECRET), false);
  assert.equal(dataObject(v, "pAlice").storage.map.get("connections"), undefined);
});

test("with no https origin the exchange leaves redirect_uri out, and GitHub defaults it", { skip }, async () => {
  const w = await world();
  withGithubApp(w);
  delete w.env.APP_ORIGIN;
  await withSource(w, w.alice);
  const seen = github(w, { trade: (body) => Response.json(body.code === CODE && !("redirect_uri" in body) ? { access_token: USER_TOKEN } : { error: "redirect_uri_mismatch" }) });
  const done = await finish(w, w.alice, stateOf(await start(w, w.alice)));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal("redirect_uri" in seen.find((call) => call.host === "github.com").body, false);
});

test("only an owner starts or finishes it; a pasted key and a source that isn't GitHub are refused", { skip }, async () => {
  const w = await world();
  const { state } = await installed(w);
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "connect", about: ABOUT, key: "ghp_pastedPersonalToken0000000" })).status, 400);
  assert.equal((await start(w, w.alice, "data/status/about.md")).status, 400);
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_start", about: ABOUT }, { token: w.alice.aiToken })).status, 403);
  await roleOf(w, w.alice, "editor");
  assert.equal((await start(w, w.alice)).status, 403);
  assert.equal((await finish(w, w.alice, state)).status, 403);
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos" })).status, 403);
});

test("the owner picks repositories: one the installation lacks is refused, and a run reads only the pick", { skip }, async () => {
  const w = await world();
  const { seen, state } = await installed(w);
  await finish(w, w.alice, state);
  const listed = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.repos.map((repo) => repo.name), ["supa/app", "supa/context"]);
  assert.equal(listed.body.picked, null);
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos", set: ["someone/else"] })).status, 400);
  const before = seen.length;
  const picked = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos", set: ["supa/context"] });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.deepEqual(picked.body.picked, ["supa/context"]);
  const read = seen.slice(before).filter((call) => call.path === "/graphql" || call.path.endsWith("/actions/runs"));
  assert.ok(read.length > 0);
  assert.ok(read.every((call) => (call.repo ?? call.path).includes("supa/context")), JSON.stringify(read.map((call) => call.repo ?? call.path)));
});

test("an uninstalled App stops the source at the next hour", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w);
  await finish(w, w.alice, state);
  github(w, { mintStatus: 404 });
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  const source = dataObject(w, "pAlice").storage.map.get("sources")[ids.about];
  assert.equal(source.stopped, true);
  assert.match(source.last.said, /no longer lets Context read/);
});
