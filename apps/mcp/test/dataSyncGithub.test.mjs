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
 *    production deployment that ships its merge commit" fails.
 * 11. `fillDeployed` matching a release by when it started again (`release.started >= merged`): "a deploy that starts
 *    after a merge but ships an older commit does not make that merge live" fails.
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

import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { READ_ONLY, installState, readInstallState } from "../src/data/connect/githubApp.js";
import { fillDeployed, pullRequestRow } from "../src/data/connect/github.js";
import { skip, NOW, SECRET, world, send, dataObject, roleOf } from "./dataSyncWorld.mjs";
import { CLIENT_ID, CLIENT_SECRET, CALLBACK, USER_TOKEN, INSTALL_TOKEN, CODE, ABOUT, CI_RUN, DEPLOY_RUN, withGithubApp, withSource, pr, github, start, finish, sheet, stateOf, logsOf, installed, firstRun } from "./dataSyncGithubWorld.mjs";

const sha = (n) => String(n).padStart(4, "0").repeat(10);
/** A merged pull request row whose squash merge made commit `sha(number)`. */
const merged = (number, opened, at) => ({ ...pullRequestRow("supa/app", { ...pr(number, opened, at), mergeCommit: { oid: sha(number) } }) });

test("a pull request's deployed is the first production deployment that ships its merge commit", () => {
  const pull = merged(3, "2026-11-20T09:00:00Z", "2026-11-24T10:00:00Z");
  assert.equal(pull.id, "supa/app#3");
  assert.equal(pull.merge_commit, sha(3));
  const before = merged(2, "2026-11-20T08:00:00Z", "2026-11-24T09:00:00Z");
  const deploys = [
    { repo: "supa/app", sha: sha(2), status: "success", started: "2026-11-24T09:30:00Z", finished: "2026-11-24T09:40:00Z" },
    { repo: "supa/app", sha: sha(3), status: "failure", started: "2026-11-24T10:30:00Z", finished: "2026-11-24T10:35:00Z" },
    { repo: "supa/app", sha: sha(3), status: "success", started: "2026-11-24T11:00:00Z", finished: "2026-11-24T11:20:00Z" },
    { repo: "supa/site", sha: sha(3), status: "success", started: "2026-11-24T10:10:00Z", finished: "2026-11-24T10:12:00Z" },
  ];
  assert.deepEqual(fillDeployed([pull], deploys, [], [pull, before]).map((row) => row.deployed), ["2026-11-24T11:20:00Z"]);
  assert.deepEqual(fillDeployed([{ ...pull, merged: "" }], deploys, [], [pull, before]), []);
  assert.equal(pullRequestRow("supa/app", { ...pr(4, "2026-11-20T09:00:00Z", null), mergeCommit: { oid: sha(4) } }).merge_commit, "", "an open pull request names no merge commit");
  assert.equal(pullRequestRow("supa/app", { ...pr(5, "2026-11-20T09:00:00Z", "2026-11-24T10:00:00Z"), mergeCommit: null }).merge_commit, "none", "a merge GitHub names no commit for is not read again");
});

test("a deploy that starts after a merge but ships an older commit does not make that merge live", () => {
  // 2026-11-26: #4375 merged 21:50, #4373 at 21:53, and the deploy of #4375's commit started at 21:54. Matching by
  // start time made #4373 live with it; 104 of 573 pull requests that week read about 5 minutes early.
  const first = merged(4375, "2026-11-26T21:46:52Z", "2026-11-26T21:50:24Z");
  const second = merged(4373, "2026-11-26T21:42:02Z", "2026-11-26T21:53:27Z");
  const runs = [
    { repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", branch: `prod-deploy/${sha(4375).slice(0, 12)}`, sha: sha(4375), started: "2026-11-26T21:54:33Z", finished: "2026-11-26T21:59:44Z" },
    // A run kept before `sha` was read: its branch names the commit.
    { repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", branch: `prod-deploy/${sha(4373).slice(0, 12)}`, started: "2026-11-26T21:57:37Z", finished: "2026-11-26T22:03:00Z" },
  ];
  const known = [first, second];
  assert.deepEqual(fillDeployed(known, [], runs, known).map((row) => [row.number, row.deployed]), [["4375", "2026-11-26T21:59:44Z"], ["4373", "2026-11-26T22:03:00Z"]]);
  // A later commit's release ships every earlier merge too, and a release whose commit is no known merge ships none.
  const later = merged(4376, "2026-11-26T21:55:00Z", "2026-11-26T21:56:00Z");
  const both = [{ repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", sha: sha(4376), started: "2026-11-26T21:57:00Z", finished: "2026-11-26T22:01:00Z" }, { repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", sha: "f".repeat(40), started: "2026-11-26T21:55:00Z", finished: "2026-11-26T21:58:00Z" }];
  assert.deepEqual(fillDeployed([second], [], both, [first, second, later]).map((row) => row.deployed), ["2026-11-26T22:01:00Z"]);
});

test("a superseded deploy still ships: deployed comes from the first successful Deploy to Production run of its commit", () => {
  // GitHub marks every older production deployment "inactive" once a newer one goes out, and that status's time is
  // when it was superseded. Matching only "success" deployments left every merged pull request waiting for the one
  // live deployment, so open to live read days (2026-11-25).
  const pull = merged(3, "2026-11-24T09:58:00Z", "2026-11-24T10:00:00Z");
  const deploys = [
    { repo: "supa/app", sha: sha(3), status: "inactive", started: "2026-11-24T10:05:00Z", finished: "2026-11-25T06:00:00Z" },
    { repo: "supa/app", sha: sha(3), status: "success", started: "2026-11-25T05:50:00Z", finished: "2026-11-25T06:00:00Z" },
  ];
  const runs = [
    { repo: "supa/app", workflow: "Deploy to Production", conclusion: "failure", sha: sha(3), started: "2026-11-24T10:02:00Z", finished: "2026-11-24T10:06:00Z" },
    { repo: "supa/app", workflow: "CI", conclusion: "success", sha: sha(3), started: "2026-11-24T10:01:00Z", finished: "2026-11-24T10:04:00Z" },
    { repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", sha: sha(3), started: "2026-11-24T10:08:00Z", finished: "2026-11-24T10:12:00Z" },
    { repo: "supa/site", workflow: "Deploy to Production", conclusion: "success", sha: sha(3), started: "2026-11-24T10:03:00Z", finished: "2026-11-24T10:04:00Z" },
  ];
  assert.deepEqual(fillDeployed([pull], deploys, runs).map((row) => row.deployed), ["2026-11-24T10:12:00Z"]);
});

test("a deployed time filled wrong is corrected once the runs cover its merge, and kept when they don't", () => {
  const runs = [
    { repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", sha: sha(1), started: "2026-11-20T09:00:00Z", finished: "2026-11-20T09:04:00Z" },
    { repo: "supa/app", workflow: "Deploy to Production", conclusion: "success", sha: sha(3), started: "2026-11-20T10:08:00Z", finished: "2026-11-20T10:12:00Z" },
  ];
  const wrong = { ...merged(3, "2026-11-20T09:58:00Z", "2026-11-20T10:00:00Z"), deployed: "2026-11-25T06:00:00Z" };
  assert.deepEqual(fillDeployed([wrong], [], runs).map((row) => row.deployed), ["2026-11-20T10:12:00Z"]);
  const right = { ...wrong, deployed: "2026-11-20T10:12:00Z" };
  assert.deepEqual(fillDeployed([right], [], runs), [], "a row already right is not rewritten");
  const older = { ...merged(2, "2026-11-01T09:00:00Z", "2026-11-01T10:00:00Z"), deployed: "2026-11-01T10:20:00Z" };
  assert.deepEqual(fillDeployed([older], [], runs, [older, wrong]), [], "a merge before the kept runs keeps the time it had");
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
  const { result: done, lines: finishLines } = await logsOf(() => finish(w, w.alice, state));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.armed, true);
  // The answer does not wait for the first run: nothing read GitHub's data, and the run is queued for the alarm.
  assert.equal(done.body.last, null, JSON.stringify(done.body));
  assert.equal(seen.some((call) => call.path === "/graphql" || call.path.endsWith("/actions/runs")), false, "a run happened inside the answer");
  const object = dataObject(w, "pAlice");
  assert.equal(object.storage.alarm, NOW);
  assert.ok(object.storage.map.get("soon").includes(ids.about));
  // The owner's own token asked who could reach the installation, then was revoked.
  assert.ok(seen.some((call) => call.path === "/user/installations" && call.auth === `Bearer ${USER_TOKEN}`));
  assert.ok(seen.some((call) => call.path === `/applications/${CLIENT_ID}/token` && call.method === "DELETE"));
  // The alarm runs the queued source: its sheets fill, and the alarm goes back to the hourly time.
  const { lines: runLines } = await logsOf(() => object.instance.alarm());
  const lines = [...finishLines, ...runLines];
  assert.equal(object.storage.map.get("sources")[ids.about].last.outcome, "ok", JSON.stringify(object.storage.map.get("sources")[ids.about].last));
  assert.equal(object.storage.alarm, NOW + SYNC_EVERY_MS);
  // Every installation token asked for exactly read-only access.
  const mints = seen.filter((call) => call.path.endsWith("/access_tokens"));
  assert.ok(mints.length >= 1);
  for (const mint of mints) assert.deepEqual(mint.body, { permissions: { ...READ_ONLY } });
  // No token in an answer, a log, the object's storage or the bucket.
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
  const last = await firstRun(w, state);
  assert.equal(last.outcome, "ok", JSON.stringify(last));
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
  const last = await firstRun(w, state);
  assert.equal(last.outcome, "ok", JSON.stringify(last));
  const created = (path) => seen.filter((call) => call.path === path).map((call) => call.query.get("created"));
  // The default-branch read: a day before its newest kept run, then the history back to the floor.
  assert.deepEqual(created("/repos/supa/app/actions/runs"), [">=2026-11-23T12:00:00.000Z", `${new Date(runFloor).toISOString()}..2026-10-28T00:00:00.000Z`]);
  // The deploy read has no kept rows of its own yet, so it reads the whole 30 days.
  assert.deepEqual(created("/repos/supa/app/actions/workflows/deploy-production.yml/runs"), [`>=${new Date(runFloor).toISOString()}`]);
});

test("sheets kept before commits were read gain merge_commit and sha, kept pull requests are read again, and deployed is matched by commit", { skip }, async () => {
  const w = await world();
  const queries = [];
  const search = (q) => (queries.push(q), q.startsWith("repo:supa/app ") ? [pr(3, "2026-11-22T09:00:00Z", "2026-11-22T10:00:00Z")] : []);
  const { ids, state } = await installed(w, { search });
  await w.alice.bucket.put(`files/${ids.pulls}.csv`, ["id,repo,number,title,author,opened:date,merged:date,deployed:date,lines_added:number,lines_removed:number", "supa/app#3,supa/app,3,Change 3,dev,2026-11-22T09:00:00Z,2026-11-22T10:00:00Z,2026-11-22T10:03:00Z,30,3", ""].join("\n"));
  await w.alice.bucket.put(`files/${ids.runs}.csv`, [
    "id,repo,workflow,branch,started:date,finished:date,conclusion",
    `6000,supa/app,Deploy to Production,prod-deploy/${"y".repeat(12)},2026-11-22T09:50:00Z,2026-11-22T09:58:00Z,success`,
    // Started after #3 merged, but shipped an older commit: the old rule took it.
    `6001,supa/app,Deploy to Production,prod-deploy/${"z".repeat(12)},2026-11-22T10:01:00Z,2026-11-22T10:03:00Z,success`,
    `6002,supa/app,Deploy to Production,prod-deploy/${"c".repeat(12)},2026-11-22T10:05:00Z,2026-11-22T10:15:00Z,success`,
    "",
  ].join("\n"));
  const last = await firstRun(w, state);
  assert.equal(last.outcome, "ok", JSON.stringify(last));
  assert.ok(queries.some((q) => q.startsWith("repo:supa/app ") && q.includes("created:") && q.includes("..2026-11-23")), queries.join(" | "));
  const pulls = await sheet(w.alice, ids.pulls);
  assert.ok(pulls.columns.some((c) => c.name === "merge_commit"));
  assert.deepEqual(pulls.rows.filter((row) => row.id === "supa/app#3").map((row) => [row.merge_commit, row.deployed]), [["c".repeat(40), "2026-11-22T10:15:00Z"]]);
  const runs = await sheet(w.alice, ids.runs);
  assert.ok(runs.columns.some((c) => c.name === "sha"));
  assert.deepEqual(runs.rows.filter((row) => row.id === "6001").map((row) => row.sha), [""], "a kept run keeps an empty sha; its branch names the commit");
});

test("a non-404 failure of the deploy read fails the run and keeps no workflow runs", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w, { deployRuns: (repo) => (repo === "supa/app" ? new Response("{}", { status: 500 }) : []) });
  const last = await firstRun(w, state);
  assert.notEqual(last.outcome, "ok", JSON.stringify(last));
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
  // The pick queues the source; the alarm runs it, and it reads only the pick.
  await dataObject(w, "pAlice").instance.alarm();
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
