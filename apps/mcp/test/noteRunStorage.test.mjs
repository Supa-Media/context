/**
 * The run log's storage in a note's own chat object (`packages/tex/gateway/texChat/noteRuns.js`): the newest 50 runs,
 * 90 days, one storage key per run, the name the object is given checked on every call. The route's side is in
 * `noteRunRoute.test.mjs`.
 *
 * Sabotage record (run 2026-11-20): dropping the 50-run cap in `prune` failed "keeps the newest 50 and drops the rest".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_RUNS, NOTE_RUNS_NAME_HEADER, RUN_DAYS, serveNoteRuns } from "../../../packages/tex/gateway/texChat/noteRuns.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const USER = "k7m2q9x4b8n3c6v1";

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

const runsIn = (storage) => [...storage.map].filter(([key]) => key.startsWith("run:")).map(([, value]) => value);

describe("the run log's storage: the newest 50, 90 days, one object per note", () => {
  const entry = (n, at) => ({
    runId: `nr_${String(n).padStart(16, "0")}`,
    at,
    who: "@ana",
    userId: USER,
    ask: "q",
    out: "a",
    replaced: false,
    sources: [],
    model: "haiku-5-5",
    ms: 1,
    calls: [],
    usage: {},
    outcome: "answered",
  });
  const put = (storage, e, name = "noteruns:wsT:n1") => serveNoteRuns(
    new Request("https://chat/note/runs", { method: "POST", headers: { [NOTE_RUNS_NAME_HEADER]: name, "content-type": "application/json" }, body: JSON.stringify(e) }),
    storage,
    { now: () => NOW },
  );
  const list = async (storage, name = "noteruns:wsT:n1") => (await (await serveNoteRuns(new Request("https://chat/note/runs", { headers: { [NOTE_RUNS_NAME_HEADER]: name } }), storage, { now: () => NOW })).json()).runs;

  it("keeps the newest 50 and drops the rest from storage", async () => {
    const storage = memoryStorage();
    for (let n = 1; n <= MAX_RUNS + 5; n += 1) await put(storage, entry(n, NOW - (MAX_RUNS + 5 - n) * 1000));
    const runs = await list(storage);
    assert.equal(runs.length, MAX_RUNS);
    assert.equal(runs[0].runId, `nr_${String(MAX_RUNS + 5).padStart(16, "0")}`, "newest first");
    assert.equal(runsIn(storage).length, MAX_RUNS, "the older five are deleted, not hidden");
  });

  it("drops a run older than 90 days, from the list and from storage", async () => {
    const storage = memoryStorage();
    await put(storage, entry(1, NOW - (RUN_DAYS + 1) * DAY));
    await put(storage, entry(2, NOW - 1000));
    const runs = await list(storage);
    assert.deepEqual(runs.map((run) => run.runId), [`nr_${"0".repeat(15)}2`]);
    assert.equal(runsIn(storage).length, 1);
  });

  it("refuses a name that is not a note's, and one that does not match the object's own", async () => {
    const storage = memoryStorage();
    const notNote = await put(storage, entry(1, NOW), "chat:+15555550101");
    assert.equal(notNote.status, 400);
    assert.equal((await put(storage, entry(1, NOW), "noteruns:wsT:n1")).status, 200);
    const other = await put(storage, entry(2, NOW), "noteruns:wsT:n2");
    assert.equal(other.status, 409);
    const read = await serveNoteRuns(new Request("https://chat/note/runs", { headers: { [NOTE_RUNS_NAME_HEADER]: "noteruns:wsT:n2" } }), storage, { now: () => NOW });
    assert.equal(read.status, 409, "a mismatched name reads nothing");
  });

  it("refuses an entry without a run id, and leaves the log as it was", async () => {
    const storage = memoryStorage();
    const bad = await put(storage, { ...entry(1, NOW), runId: "not a run" });
    assert.equal(bad.status, 400);
    assert.equal(runsIn(storage).length, 0);
  });

  it("caps the calls a run keeps at 40 and the words at 300", async () => {
    const storage = memoryStorage();
    const big = { ...entry(1, NOW), ask: "q".repeat(900), out: "a".repeat(900), calls: Array.from({ length: 60 }, (_, i) => ({ i })) };
    await put(storage, big);
    const [run] = await list(storage);
    assert.equal(run.ask.length, 300);
    assert.equal(run.out.length, 300);
    assert.equal(run.calls.length, 40);
  });
});
