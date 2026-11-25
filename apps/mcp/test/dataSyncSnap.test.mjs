/**
 * Right-now metrics kept hourly (`src/data/sync/snap.js`, the `metric` arm in `route.js` and `object.js`): a metric
 * over sheets with no dates gets one reading an hour in its own sheet beside its note, `data/metrics/<slug>.csv`,
 * worked out as the person who armed it reads its sheets, and never written where more people read it than can read
 * what it is made from.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `reachesNoWider` answering true always: "an input fewer people see than the kept sheet keeps nothing" fails.
 * 2. `runMetricSnap` skipping the armer's role check: "a metric whose armer can no longer edit stops" fails.
 * 3. `keptSheetOf` accepting a note anywhere under the Data folder: "only a note directly in metrics/ is a metric"
 *    fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceClient } from "../src/workspaceStore/api.js";
import { parseSheet } from "../src/sheets/csv.js";
import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { DATA_SYNC_ACTION, DATA_SYNC_CLIENT_ID } from "../src/data/sync/runParts.js";
import { keptSheetOf, reachesNoWider } from "../src/data/sync/snap.js";
import { parsedRules } from "../src/workspaceStore/serve.js";
import { audits, dataObject, noteId, NOW, RULES, roleOf, send, skip, world } from "./dataSyncWorld.mjs";

const METRIC = (formula) => `---\nmetric: Open incidents\nformula: "${formula}"\nevery: day\n---\n\nIncidents open right now.\n`;
const OPEN = "count(ops/incidents.id where open = true)";
const INCIDENTS = "id,severity,open:checkbox\nINC-1,high,true\nINC-2,low,true\nINC-3,high,false\n";
let version = 10;

/** The workspace's rules, as its object holds them for members, at a later access version. */
async function setRules(w, who, extra = {}) {
  version += 1;
  const rules = { ...RULES, accessVersion: version, folders: [...RULES.folders, ...(extra.folders ?? [])], notes: [...RULES.notes, ...(extra.notes ?? [])] };
  await workspaceClient(w.env, who.pwid).rules.put(rules, "member");
  who.object.store.rows.putRules(rules);
}

/** A metrics folder with one metric note and its empty kept sheet, and an ops source with an undated sheet. */
async function withMetric(w, who, { formula = OPEN, notePath = "data/metrics/open-incidents.md", keptPath = "data/metrics/open-incidents.csv", input = INCIDENTS } = {}) {
  const ids = { note: noteId(20, who.pwid), kept: noteId(21, who.pwid), incidents: noteId(22, who.pwid), prs: noteId(23, who.pwid) };
  who.object.store.rows.put([
    { id: `d-metrics-${who.pwid}`, path: "data/metrics", kind: "folder", at: 10 },
    { id: `f-metric-${who.pwid}`, path: notePath, kind: "file", at: 11, storageKey: `notes/${ids.note}.md`, noteId: ids.note, etag: "e-metric" },
    { id: `f-kept-${who.pwid}`, path: keptPath, kind: "file", at: 12, storageKey: `files/${ids.kept}.csv`, noteId: ids.kept, etag: "e-kept" },
    { id: `d-ops-${who.pwid}`, path: "data/ops", kind: "folder", at: 10 },
    { id: `f-inc-${who.pwid}`, path: "data/ops/incidents.csv", kind: "file", at: 13, storageKey: `files/${ids.incidents}.csv`, noteId: ids.incidents, etag: "e-inc" },
    { id: `d-gh-${who.pwid}`, path: "data/github", kind: "folder", at: 10 },
    { id: `f-prs-${who.pwid}`, path: "data/github/pull-requests.csv", kind: "file", at: 14, storageKey: `files/${ids.prs}.csv`, noteId: ids.prs, etag: "e-prs" },
  ]);
  await who.object.store.objects.put(`notes/${ids.note}.md`, METRIC(formula));
  await who.bucket.put(`files/${ids.kept}.csv`, "");
  await who.bucket.put(`files/${ids.incidents}.csv`, input);
  await who.bucket.put(`files/${ids.prs}.csv`, "number,merged:date\n1,2026-11-25\n");
  return { ids, notePath, keptPath };
}

const armMetric = (w, who, metric = "data/metrics/open-incidents.md", options) => send(w, who, { workspaceId: who.pwid, op: "arm", metric }, options);
const keptOf = async (who, made) => parseSheet((await (await who.bucket.get(`files/${made.ids.kept}.csv`))?.text()) ?? "");

test("only a note directly in the Data folder's metrics/ is a metric, and its kept sheet sits beside it", () => {
  assert.equal(keptSheetOf("data/metrics/open-incidents.md", "data"), "data/metrics/open-incidents.csv");
  assert.equal(keptSheetOf("Data/Metrics/Open.md", "Data"), "Data/Metrics/Open.csv");
  assert.equal(keptSheetOf("data/metrics/deep/open.md", "data"), null);
  assert.equal(keptSheetOf("data/ops/open.md", "data"), null);
  assert.equal(keptSheetOf("data/metrics/open.csv", "data"), null);
  assert.equal(keptSheetOf("elsewhere/metrics/open.md", "data"), null);
  assert.equal(keptSheetOf("data/metrics/.md", "data"), null);
});

test("who may read a kept value: owners-only always, team over team, one setting over the very same", () => {
  const parsed = parsedRules({ folders: [{ prefix: "data", visibility: "team" }, { prefix: "data/finance", visibility: "@finance" }, { prefix: "data/secret", visibility: "private" }], notes: [{ path: "data/metrics/private.csv", visibility: "private" }, { path: "data/metrics/fin.csv", visibility: "@finance" }] });
  assert.equal(reachesNoWider(parsed, "data/metrics/a.csv", "data/ops/x.csv"), true);
  assert.equal(reachesNoWider(parsed, "data/metrics/a.csv", "data/finance/x.csv"), false);
  assert.equal(reachesNoWider(parsed, "data/metrics/a.csv", "data/secret/x.csv"), false);
  assert.equal(reachesNoWider(parsed, "data/metrics/private.csv", "data/secret/x.csv"), true);
  assert.equal(reachesNoWider(parsed, "data/metrics/private.csv", "data/finance/x.csv"), true);
  assert.equal(reachesNoWider(parsed, "data/metrics/fin.csv", "data/finance/x.csv"), true);
  assert.equal(reachesNoWider(parsed, "data/metrics/fin.csv", "data/ops/x.csv"), false);
});

test("an owner keeps a right-now metric: it reads at once into its own sheet, audited as the data sync", { skip }, async () => {
  const w = await world();
  const made = await withMetric(w, w.alice);
  const armed = await armMetric(w, w.alice);
  assert.equal(armed.status, 200, JSON.stringify(armed.body));
  assert.equal(armed.body.metric, made.notePath);
  assert.equal(armed.body.armed, true);
  assert.equal(armed.body.last.outcome, "ok", JSON.stringify(armed.body.last));
  const kept = await keptOf(w.alice, made);
  assert.deepEqual(kept.columns.map((c) => [c.name, c.type]), [["hour", "date"], ["value", "number"]]);
  assert.deepEqual(kept.rows.map((r) => [r.hour, r.value]), [["2026-11-25T12:00Z", "2"]]);
  const [entry] = audits(w.alice);
  assert.equal(entry.action, DATA_SYNC_ACTION);
  assert.equal(entry.actor_client_id, DATA_SYNC_CLIENT_ID);
  assert.deepEqual(entry.paths, [made.keptPath]);
  // Its status is asked by the metric's note.
  const asked = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "status", metric: [made.notePath] });
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body.sources.map((s) => [s.metric, s.armed, s.last.outcome]), [[made.notePath, true, "ok"]]);
});

test("each hour adds one reading, and a second run in one hour replaces its reading", { skip }, async () => {
  const w = await world();
  const made = await withMetric(w, w.alice);
  await armMetric(w, w.alice);
  await w.alice.bucket.put(`files/${made.ids.incidents}.csv`, "id,open:checkbox\nINC-1,true\nINC-4,true\nINC-5,true\n");
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, w.alice.pwid).instance.alarm();
  assert.deepEqual((await keptOf(w.alice, made)).rows.map((r) => [r.hour, r.value]), [["2026-11-25T12:00Z", "2"], ["2026-11-25T13:00Z", "3"]]);
  await w.alice.bucket.put(`files/${made.ids.incidents}.csv`, "id,open:checkbox\nINC-1,true\n");
  w.clock.now = NOW + SYNC_EVERY_MS + 20 * 60_000;
  await dataObject(w, w.alice.pwid).instance.alarm();
  assert.deepEqual((await keptOf(w.alice, made)).rows.map((r) => [r.hour, r.value]), [["2026-11-25T12:00Z", "2"], ["2026-11-25T13:00Z", "1"]]);
});

test("an input fewer people see than the kept sheet keeps nothing, and says which sheet", { skip }, async () => {
  const w = await world();
  const made = await withMetric(w, w.alice);
  await setRules(w, w.alice, { notes: [{ path: "data/ops/incidents.csv", visibility: "private" }] });
  const armed = await armMetric(w, w.alice);
  assert.equal(armed.status, 200, JSON.stringify(armed.body));
  assert.equal(armed.body.last.outcome, "failed");
  assert.match(armed.body.last.said, /data\/ops\/incidents\.csv is seen by fewer people than data\/metrics\/open-incidents\.csv/);
  assert.equal((await keptOf(w.alice, made)).rows.length, 0);
  assert.equal(audits(w.alice).length, 0);
  // The kept sheet made owners-only: owners may keep a value over an owners-only sheet.
  await setRules(w, w.alice, { notes: [{ path: "data/ops/incidents.csv", visibility: "private" }, { path: made.keptPath, visibility: "private" }] });
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, w.alice.pwid).instance.alarm();
  assert.deepEqual((await keptOf(w.alice, made)).rows.map((r) => r.value), ["2"]);
});

test("a metric over sheets with dates is worked out when it is read, so keeping it stops", { skip }, async () => {
  const w = await world();
  const made = await withMetric(w, w.alice, { formula: "count(github/pull-requests.number)" });
  const armed = await armMetric(w, w.alice);
  assert.equal(armed.body.last.outcome, "stopped");
  assert.match(armed.body.last.said, /never kept/);
  assert.equal(armed.body.armed, false);
  assert.equal((await keptOf(w.alice, made)).rows.length, 0);
});

test("a metric whose armer can no longer edit stops, and a member can't arm one", { skip }, async () => {
  const w = await world();
  const made = await withMetric(w, w.alice);
  await armMetric(w, w.alice);
  await roleOf(w, w.alice, "member");
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, w.alice.pwid).instance.alarm();
  const held = (await dataObject(w, w.alice.pwid).storage.get("sources"))[made.ids.note];
  assert.equal(held.stopped, true);
  assert.match(held.last.said, /can no longer edit/);
  assert.equal((await keptOf(w.alice, made)).rows.length, 1);
  const refused = await armMetric(w, w.alice);
  assert.equal(refused.status, 403);
});

test("a body naming both, a note outside metrics/, a missing kept sheet and an AI client are each refused", { skip }, async () => {
  const w = await world();
  await withMetric(w, w.alice);
  const both = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "arm", metric: "data/metrics/open-incidents.md", about: "data/status/about.md" });
  assert.equal(both.status, 400);
  const outside = await armMetric(w, w.alice, "data/status/about.md");
  assert.equal(outside.status, 404);
  const ai = await armMetric(w, w.alice, "data/metrics/open-incidents.md", { token: w.alice.aiToken });
  assert.equal(ai.status, 403);
  // An about.md is never armed as a metric, nor a metric note as a source.
  const asSource = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "arm", about: "data/metrics/open-incidents.md" });
  assert.equal(asSource.status, 404);
  // The kept sheet gone: nothing is written and the page is told how to make it again.
  const w2 = await world();
  const made2 = await withMetric(w2, w2.alice, { keptPath: "data/metrics/other.csv" });
  const missing = await armMetric(w2, w2.alice, made2.notePath);
  assert.equal(missing.body.last.outcome, "failed");
  assert.match(missing.body.last.said, /data\/metrics\/open-incidents\.csv is missing/);
});
