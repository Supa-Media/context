/**
 * Connecting GitHub again once the App is already installed (`src/data/connect/route.js` `startGithub`,
 * `githubApp.js` `authorizeUrl`, `checkGithubInstall`). GitHub's install page, opened for an account the App is
 * already installed on, shows that installation's settings and never sends the owner back, so a stopped source could
 * not be armed again (@supa, 2026-11-27: the reconnect reached no `github_finish`, and the hourly alarm went on
 * without GitHub). A workspace that already holds a GitHub connection is sent to GitHub's sign-in page instead,
 * which always comes back, with the code and the state and no installation id; the installation is the one kept,
 * still bound only if the owner's own token reaches it.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `startGithub` always answering the install page: "a workspace that already holds GitHub is sent to GitHub's
 *    sign-in page" fails.
 * 2. `checkGithubInstall` taking the kept installation without asking GitHub: "a reconnect binds nothing when the
 *    owner can no longer reach the kept installation" fails.
 * 3. `connect` keeping `checked.kept` whole on a reconnect (2026-11-28): "a reconnect keeps the repositories the
 *    owner picked" fails, with `picked` back to null — every repository the owner can reach.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { skip, world, send, dataObject, status } from "./dataSyncWorld.mjs";
import { CLIENT_ID, CALLBACK, CODE, INSTALLATION, ABOUT, github, start, stateOf, installed, firstRun } from "./dataSyncGithubWorld.mjs";

/** The source stopped as the hourly run stops it (here: GitHub refused the mint, as an access change does). */
async function stoppedSource(w) {
  const { ids, state } = await installed(w);
  assert.equal((await firstRun(w, state)).outcome, "ok");
  const object = dataObject(w, "pAlice");
  github(w, { mintStatus: 403 });
  w.clock.now = object.storage.alarm;
  await object.instance.alarm();
  assert.equal(object.storage.map.get("sources")[ids.about].stopped, true);
  return { ids, object };
}

/** The owner back from GitHub's sign-in page: a code and the state, and no installation id. */
const finishSignedIn = (w, state) => send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_finish", state, code: CODE });

/** The owner narrows the source to one repository, as the data page's picker does. */
const pick = (w, set) => send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos", set });
const picked = async (w) => (await send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos" })).body?.picked;

// A reconnect re-binds the installation on the same checks and "never widens anything" (this file's own contract).
// The repositories the owner picked live in the sealed connection (`repos` op seals `{ ...kept, repos: picked }`), and
// a connect replaces that connection with what the check answers, whose `repos` is null — "every repository in reach,
// until the owner picks". So the pick has to be carried over, or the reconnect widens the source to the owner's whole
// reach without anybody asking for it.
test("a reconnect keeps the repositories the owner picked", { skip }, async () => {
  const w = await world();
  await stoppedSource(w);
  github(w);
  assert.deepEqual((await pick(w, ["supa/app"])).body?.picked, ["supa/app"]);
  const done = await finishSignedIn(w, stateOf(await start(w, w.alice)));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.armed, true);
  assert.deepEqual(await picked(w), ["supa/app"], "the pick survives the reconnect");
});

test("a reconnect refuses rather than widening when no picked repository is reachable any more", { skip }, async () => {
  const w = await world();
  const { ids, object } = await stoppedSource(w);
  github(w);
  await pick(w, ["supa/app"]);
  // The owner's access to the picked repository is gone; the installation is still reachable through another.
  github(w, { reach: ["supa/context"] });
  const done = await finishSignedIn(w, stateOf(await start(w, w.alice)));
  assert.equal(done.status, 400, JSON.stringify(done.body));
  assert.match(done.body.message, /pick/i);
  assert.equal(object.storage.map.get("sources")[ids.about].stopped, true, "the source stays stopped rather than reading more");
  github(w);
  assert.deepEqual(await picked(w), ["supa/app"], "and the pick is untouched");
});

test("a workspace that already holds GitHub is sent to GitHub's sign-in page, and a reconnect arms and runs it", { skip }, async () => {
  const w = await world();
  const { ids, object } = await stoppedSource(w);
  github(w);
  const started = await start(w, w.alice);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const url = new URL(started.body.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), CALLBACK);
  const state = stateOf(started);
  assert.ok(state);

  const done = await finishSignedIn(w, state);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.armed, true);
  const source = object.storage.map.get("sources")[ids.about];
  assert.equal(source.stopped, undefined);
  assert.deepEqual(object.storage.map.get("soon"), [ids.about]);
  await object.instance.alarm();
  assert.equal(object.storage.map.get("sources")[ids.about].last.outcome, "ok");
  const asked = await status(w, w.alice, [ABOUT]);
  assert.equal(asked.body.sources[0].armed, true);
});

test("a workspace that never connected GitHub still gets the install page", { skip }, async () => {
  const w = await world();
  const { state } = await installed(w);
  assert.ok(state);
  const started = await start(w, w.alice);
  assert.match(started.body.url, /^https:\/\/github\.com\/apps\/context-data\/installations\/new\?state=/);
});

test("a reconnect binds nothing when the owner can no longer reach the kept installation", { skip }, async () => {
  const w = await world();
  const { ids, object } = await stoppedSource(w);
  github(w, { installations: [12] });
  const done = await finishSignedIn(w, stateOf(await start(w, w.alice)));
  assert.equal(done.status, 400, JSON.stringify(done.body));
  assert.match(done.body.message, /isn't one you can reach/);
  assert.equal(object.storage.map.get("sources")[ids.about].stopped, true);
});

test("a first connect without an installation id binds nothing", { skip }, async () => {
  const w = await world();
  const { state } = await installed(w);
  const done = await finishSignedIn(w, state);
  assert.equal(done.status, 400, JSON.stringify(done.body));
  assert.equal(dataObject(w, "pAlice").storage.map.get("connections"), undefined);
  assert.equal(INSTALLATION, "77");
});
