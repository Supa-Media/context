/**
 * GitHub's first run in the background (`src/data/sync/object.js`): an owner's Connect and a repository pick answer at
 * once and queue their run for an alarm set to now, so a slow first run (about 95 seconds on GitHub) never holds the
 * answers behind it. Over the real worker, workspace objects and sync object in memory, with GitHub's data calls held
 * on a deferred promise the test controls.
 *
 * The properties with teeth: nothing that is not a run waits for a run (a list, a status, a disconnect answer while
 * one is in flight); a source disconnected during a run stays stopped (the run's result is not written over it); and
 * the alarm goes back to the hourly time a run-soon alarm displaced.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `connect` awaiting the run for an installed app: "connect answers at once while the first run waits" fails
 *    (the answer times out behind the held run).
 * 2. `repos` without `set` put back under `serially`: "a repository list answers while a pick is still listing GitHub"
 *    fails (the list times out behind the pick, which holds the state lock).
 * 3. `alarm` writing its pre-run copy of the source back: "a re-connect that lands during an alarm run keeps its own
 *    arming" fails. (A disconnect never reaches that write: its stopped source returns first, so the disconnect test
 *    cannot see this one.)
 * 4. `alarm` ending with `setAlarm(now + SYNC_EVERY_MS)` where the displaced hourly time is due: "the alarm goes back to
 *    the hourly time a run-soon alarm displaced" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { skip, NOW, world, send, dataObject, status } from "./dataSyncWorld.mjs";
const ABOUT = "data/github/about.md";
import { USER_TOKEN, INSTALL_TOKEN, CODE, finish, installed, logsOf, start, stateOf } from "./dataSyncGithubWorld.mjs";

const MINUTE = 60 * 1000;

/** A promise the test resolves when it chooses. */
function gate() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** `work`, or a clear failure if it has not answered in two seconds: the thing it waited behind is named. */
async function within(work, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} waited behind a lock instead of answering`)), 2000);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** GitHub's data calls (the queries and the runs) wait on the gate; the token and the repositories answer at once. */
function holdRuns(w, held) {
  const answer = w.net.answers.get("api.github.com");
  w.net.answers.set("api.github.com", async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === "/graphql" || /\/actions\/runs$/.test(pathname)) await held;
    return answer(url, init);
  });
}

test("connect answers at once while the first run waits", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w);
  const hold = gate();
  holdRuns(w, hold.held);
  try {
    const done = await within(finish(w, w.alice, state), "connect");
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.last, null);

    // The run is now queued and starts; it blocks on GitHub's data until released.
    const running = logsOf(() => dataObject(w, "pAlice").instance.alarm());

    const repos = await within(send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos" }), "the repository list");
    assert.equal(repos.status, 200, JSON.stringify(repos.body));
    assert.deepEqual(repos.body.repos.map((repo) => repo.name), ["supa/app", "supa/context"]);

    const asked = await within(status(w, w.alice, [ABOUT]), "the status");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.sources[0].armed, true);
    assert.equal(asked.body.sources[0].last, null);

    hold.release();
    const { lines } = await running;
    const source = dataObject(w, "pAlice").storage.map.get("sources")[ids.about];
    assert.equal(source.last.outcome, "ok", JSON.stringify(source.last));
    assert.equal(dataObject(w, "pAlice").storage.alarm, NOW + SYNC_EVERY_MS);
    for (const secret of [USER_TOKEN, INSTALL_TOKEN, CODE]) assert.equal(lines.some((line) => line.includes(secret)), false, `${secret} reached a log`);
  } finally {
    hold.release();
  }
});

test("a disconnect that lands during an alarm run is not overwritten", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w);
  await finish(w, w.alice, state);
  const object = dataObject(w, "pAlice");
  const hold = gate();
  holdRuns(w, hold.held);
  try {
    const running = object.instance.alarm();
    const gone = await within(send(w, w.alice, { workspaceId: w.alice.pwid, op: "disconnect", app: "github" }), "the disconnect");
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.disconnected, true);

    hold.release();
    await running;
    const source = object.storage.map.get("sources")[ids.about];
    assert.equal(source.stopped, true, "the run's ok result was written over the disconnect");
    assert.equal(source.last.outcome, "stopped");
    assert.equal(object.storage.map.get("connections").github, undefined);
    assert.equal(object.storage.alarm, null, "nothing is left to run, so no alarm");
  } finally {
    hold.release();
  }
});

test("the alarm goes back to the hourly time a run-soon alarm displaced", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w);
  const object = dataObject(w, "pAlice");
  const connectedAt = NOW + 10 * MINUTE;
  w.clock.now = connectedAt;
  await finish(w, w.alice, state);
  // The run-soon alarm is due now, and the hourly time it displaced is kept an hour on from the connect.
  assert.equal(object.storage.alarm, connectedAt);
  assert.equal(object.storage.map.get("hourly"), connectedAt + SYNC_EVERY_MS);
  assert.deepEqual(object.storage.map.get("soon"), [ids.about]);

  // The alarm runs a few minutes later: the next one is the hourly time, not a fresh hour from this run.
  w.clock.now = connectedAt + 5 * MINUTE;
  await object.instance.alarm();
  assert.equal(object.storage.map.get("sources")[ids.about].last.outcome, "ok");
  assert.equal(object.storage.alarm, connectedAt + SYNC_EVERY_MS);
  assert.equal(object.storage.map.get("hourly"), undefined);
  assert.equal(object.storage.map.has("soon"), false);
});

test("a re-connect that lands during an alarm run keeps its own arming, not the run's copy", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w);
  await finish(w, w.alice, state);
  const object = dataObject(w, "pAlice");
  const hold = gate();
  holdRuns(w, hold.held);
  try {
    const running = object.instance.alarm();
    // Connected again a minute on, while the run waits on GitHub's data: the new arming is what must land.
    w.clock.now = NOW + MINUTE;
    const again = await within(finish(w, w.alice, stateOf(await start(w, w.alice))), "the re-connect");
    assert.equal(again.status, 200, JSON.stringify(again.body));

    hold.release();
    await running;
    const source = object.storage.map.get("sources")[ids.about];
    assert.equal(source.armedAt, NOW + MINUTE, "the run's copy overwrote the re-connect");
    assert.equal(source.last.outcome, "ok", JSON.stringify(source.last));
    // The re-connect queued its own run, so the alarm is set to now and that run is due.
    assert.equal(object.storage.alarm, NOW + MINUTE);
  } finally {
    hold.release();
  }
});

test("a repository list answers while a pick is still listing GitHub", { skip }, async () => {
  const w = await world();
  const { state } = await installed(w);
  await finish(w, w.alice, state);
  // Only the first listing waits (the pick's); the list asked after it is answered at once.
  const hold = gate();
  let reached;
  const inGithub = new Promise((resolve) => {
    reached = resolve;
  });
  const answer = w.net.answers.get("api.github.com");
  let held = false;
  w.net.answers.set("api.github.com", async (url, init) => {
    if (!held && new URL(url).pathname === "/installation/repositories") {
      held = true;
      reached();
      await hold.held;
    }
    return answer(url, init);
  });
  try {
    const pick = send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos", set: ["supa/context"] });
    await within(inGithub, "the pick's listing");
    const list = await within(send(w, w.alice, { workspaceId: w.alice.pwid, op: "github_repos" }), "the repository list");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    hold.release();
    const picked = await pick;
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.deepEqual(picked.body.picked, ["supa/context"]);
  } finally {
    hold.release();
  }
});
