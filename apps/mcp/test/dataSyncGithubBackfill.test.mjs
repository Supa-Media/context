/**
 * GitHub's merge-commit backfill (`src/data/connect/github.js` `readGithub`): a kept merged pull request opened before
 * the 90-day read window keeps an empty `merge_commit` only until a run asks for it by number, the oldest
 * `MERGE_BACKFILL_PER_RUN` a run, so every kept merged row ends with its commit (or "none") and nothing else on the
 * row changes.
 *
 * The properties with teeth: a kept row's own fields (title, opened, deployed, lines) are never rewritten by the
 * backfill; a merge commit already kept is never overwritten; a row GitHub names no commit for is marked "none" and
 * is not asked again; at most `MERGE_BACKFILL_PER_RUN` rows are asked for a run, oldest first, and the sheet's own
 * empty cells carry the cursor from one run to the next; the REST pull request pages a run reads stay within the
 * reading budget.
 *
 * Sabotage record (temporary local edit, reverted; the named case failed each time):
 * 1. The backfill block removed from `readGithub`: "kept pull requests opened before the read window gain their merge
 *    commit, and nothing else on the row changes" fails (#3 stays empty), and "the backfill takes at most
 *    MERGE_BACKFILL_PER_RUN rows a run, oldest first, and the next run carries on" fails (no row is filled).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { MERGE_BACKFILL_PER_RUN } from "../src/data/connect/github.js";
import { skip, world, dataObject } from "./dataSyncWorld.mjs";
import { installed, firstRun, sheet } from "./dataSyncGithubWorld.mjs";

const HEADER = "id,repo,number,title,author,opened:date,merged:date,deployed:date,lines_added:number,lines_removed:number,merge_commit,follow_up";
const DAY_MS = 86_400_000;
const NONE = "none";

/** A kept row as the sheet writes it, cells in the header's order. */
const line = ({ number, title = `Old change ${number}`, opened, merged = "", deployed = "", added = String(number * 10), removed = String(number), commit = "" }) =>
  [`supa/app#${number}`, "supa/app", String(number), title, "dev", opened, merged, deployed, added, removed, commit, ""].join(",");

/**
 * The GraphQL recent-pull-request read answers nothing for these runs: the default world answers two recent pull
 * requests, which would sit beside the old rows and blur the counts this file checks.
 */
function quietRecentPulls(w) {
  const inner = w.net.answers.get("api.github.com");
  w.net.answers.set("api.github.com", (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === "/graphql" && JSON.parse(init.body).query.includes("pullRequests")) {
      return Response.json({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    }
    return inner(url, init);
  });
}

const pulls = (seen) => seen.filter((call) => call.host === "api.github.com" && call.path.endsWith("/pulls"));

test("kept pull requests opened before the read window gain their merge commit, and nothing else on the row changes", { skip }, async () => {
  const w = await world();
  const { ids, state } = await installed(w, { closed: () => Array.from({ length: 29 }, (_, i) => 30 - i).map((number) => ({ number, merged_at: "2026-08-01T00:00:00Z", merge_commit_sha: number <= 26 ? String.fromCharCode(96 + number).repeat(40) : null })) });
  await w.alice.bucket.put(`files/${ids.pulls}.csv`, [
    HEADER,
    line({ number: 3, opened: "2026-08-01T00:00:00Z", merged: "2026-08-01T00:00:00Z", deployed: "2026-08-02T00:00:00Z" }),
    line({ number: 4, opened: "2026-08-01T00:00:00Z", merged: "2026-08-01T00:00:00Z", deployed: "2026-08-02T00:00:00Z", commit: "x".repeat(40) }),
    line({ number: 27, opened: "2026-07-20T00:00:00Z", merged: "2026-07-21T00:00:00Z" }),
    line({ number: 5, opened: "2026-07-22T00:00:00Z" }),
    "",
  ].join("\n"));
  const before = new Map((await sheet(w.alice, ids.pulls)).rows.map((row) => [row.id, row]));
  const last = await firstRun(w, state);
  assert.equal(last.outcome, "ok", JSON.stringify(last));
  const after = new Map((await sheet(w.alice, ids.pulls)).rows.map((row) => [row.id, row]));
  assert.equal(after.get("supa/app#3").merge_commit, "c".repeat(40));
  const rest = ({ merge_commit, ...row }) => row;
  assert.deepEqual(rest(after.get("supa/app#3")), rest(before.get("supa/app#3")), "a backfilled row changed beyond its merge commit");
  assert.equal(after.get("supa/app#4").merge_commit, "x".repeat(40), "a merge commit already kept was overwritten");
  assert.deepEqual(after.get("supa/app#4"), before.get("supa/app#4"));
  assert.equal(after.get("supa/app#27").merge_commit, NONE);
  assert.equal(after.get("supa/app#5").merge_commit, "", "an unmerged row was asked for a merge commit");
});

test("the backfill takes at most MERGE_BACKFILL_PER_RUN rows a run, oldest first, and the next run carries on", { skip }, async () => {
  const w = await world();
  const total = 60;
  const closed = () => Array.from({ length: 200 }, (_, i) => 200 - i).map((number) => ({ number, merged_at: "2026-08-01T00:00:00Z", merge_commit_sha: String(number).padStart(40, "0") }));
  const { ids, seen, state } = await installed(w, { closed });
  quietRecentPulls(w);
  // #1 is the oldest: opened a day later for each higher number, all before the read window (2026-08-27).
  const opened = (number) => new Date(Date.parse("2026-06-01T00:00:00Z") + number * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows = Array.from({ length: total }, (_, i) => line({ number: i + 1, opened: opened(i + 1), merged: "2026-08-01T00:00:00Z" }));
  await w.alice.bucket.put(`files/${ids.pulls}.csv`, [HEADER, ...rows, ""].join("\n"));
  const filled = async () => (await sheet(w.alice, ids.pulls)).rows.filter((row) => row.merge_commit !== "").map((row) => Number(row.number)).sort((a, b) => a - b);
  const restCalls = () => pulls(seen).length;

  const firstBefore = restCalls();
  const last = await firstRun(w, state);
  assert.equal(last.outcome, "ok", JSON.stringify(last));
  const firstPages = restCalls() - firstBefore;
  assert.equal(MERGE_BACKFILL_PER_RUN, 50);
  assert.deepEqual(await filled(), Array.from({ length: MERGE_BACKFILL_PER_RUN }, (_, i) => i + 1), "the first run did not take the oldest 50");
  assert.ok(firstPages >= 1 && firstPages <= 40, `first run read ${firstPages} REST pull pages`);

  const object = dataObject(w, w.alice.pwid);
  w.clock.now += SYNC_EVERY_MS;
  const secondBefore = restCalls();
  await object.instance.alarm();
  const secondPages = restCalls() - secondBefore;
  assert.deepEqual(await filled(), Array.from({ length: total }, (_, i) => i + 1), "the next run did not carry on to the rest");
  assert.ok(secondPages <= 40, `second run read ${secondPages} REST pull pages`);

  const settled = (await sheet(w.alice, ids.pulls)).rows.map((row) => [row.id, row.merge_commit]);
  w.clock.now += SYNC_EVERY_MS;
  await object.instance.alarm();
  assert.deepEqual((await sheet(w.alice, ids.pulls)).rows.map((row) => [row.id, row.merge_commit]), settled, "a further run changed a merge commit");
  for (const [id, commit] of settled) assert.equal(commit, String(Number(id.split("#")[1])).padStart(40, "0"), id);
});
