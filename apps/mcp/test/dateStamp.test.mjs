/**
 * The backfill pass and the owner-only tool around it (`notes/dateStamp.js` `fillDatesPage`, `tools/fillDates.js`;
 * Dev2, 2026-11-10): each note the object names as having an empty date key is filled from its row's clocks, a filled
 * value is kept, a note somebody saved in between is skipped rather than overwritten, and the count is reported.
 *
 * ## Sabotage record
 *
 * Passing the current text as `previous` with `modifiedAt` now (instead of the row's last save) failed "empty keys are
 * filled from the note's own history". Writing without `onlyCurrent` failed "a note saved meanwhile is not
 * overwritten". Dropping the etag check in `stampAfterQuiet`, or having the stamp record a change, failed "only the
 * last save of a burst stamps".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readDocument, replaceText } from "@context/collaboration";
import { fillDatesPage, stampAfterQuiet } from "../src/notes/dateStamp.js";
import { toolFillDates } from "../src/tools/fillDates.js";

const CREATED = Date.UTC(2026, 2, 14, 14, 5, 9); // Saturday, March 14th 2026, 9:05:09 am in Chicago
const SAVED = Date.UTC(2026, 10, 10, 3, 34, 0); // Monday, November 9th 2026, 9:34:00 pm in Chicago

function memoryStore({ gaps, style = null, zone = "America/Chicago" }) {
  const objects = new Map();
  let sequence = 0;
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    objects,
    async get(key) {
      const object = objects.get(key);
      return object ? { etag: object.etag, text: async () => object.text, body: object.text } : null;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { etag: object.etag, size: object.text.length } : null;
    },
    async put(key, value, options = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.absent && current) return null;
      const etag = `e${++sequence}`;
      objects.set(key, { etag, text: typeof value === "string" ? value : new TextDecoder().decode(value) });
      return { etag };
    },
    async delete(key) {
      for (const one of Array.isArray(key) ? key : [key]) objects.delete(one);
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: objects.get(key).etag })), truncated: false };
    },
    ownerTimeZone: async () => zone,
    asks: [],
    async objectFacts(request) {
      store.asks.push(request);
      if (request.ask !== "dateGaps") return null;
      const start = request.after ?? "";
      const rest = gaps.filter((gap) => gap.path > start);
      const page = rest.slice(0, 2);
      return { served: true, gaps: page, next: rest.length > 2 ? page.at(-1).path : null, style };
    },
  };
  return store;
}

test("empty keys are filled from the note's own history, in the workspace's format; filled ones are kept", async () => {
  const store = memoryStore({
    gaps: [
      { path: "a.md", created: CREATED, saved: SAVED },
      { path: "b.md", created: CREATED, saved: SAVED },
      { path: "c.md", created: null, saved: SAVED },
    ],
    style: "linter",
  });
  await store.put("a.md", "---\ndate created:\ndate modified:\n---\n\nA\n");
  await store.put("b.md", "---\ncreated: 2026-01-01\nupdated:\n---\n\nB\n");
  await store.put("c.md", "---\ndate created:\n---\n\nC\n");

  const page = await fillDatesPage(store);
  assert.deepEqual(page, { served: true, filled: 2, looked: 3, next: null });
  assert.equal(
    (await readDocument(store, "a.md")).text,
    "---\ndate created: Saturday, March 14th 2026, 9:05:09 am\ndate modified: Monday, November 9th 2026, 9:34:00 pm\n---\n\nA\n",
  );
  // b's own format wins over the workspace's, and its created stays.
  assert.equal((await readDocument(store, "b.md")).text, "---\ncreated: 2026-01-01\nupdated: 2026-11-09\n---\n\nB\n");
  // No first-save time: created waits rather than being guessed.
  assert.equal((await readDocument(store, "c.md")).text, "---\ndate created:\n---\n\nC\n");
  // Pages were followed to the end.
  assert.deepEqual(store.asks.map((ask) => ask.after ?? null), [null, "b.md"]);
});

test("a note saved meanwhile is not overwritten", async () => {
  const store = memoryStore({ gaps: [{ path: "a.md", created: CREATED, saved: SAVED }] });
  await store.put("a.md", "---\ndate created:\n---\n\nA\n");
  const before = await readDocument(store, "a.md");
  // Somebody's save lands between the pass's read and its write.
  const realPut = store.put.bind(store);
  let raced = false;
  store.put = async (key, value, options) => {
    if (!raced) {
      raced = true;
      store.put = realPut;
      await replaceText(store, "a.md", { expectedEtag: before.etag, text: "---\ndate created:\n---\n\nA, edited\n" });
      store.put = async (...again) => await realPut(...again);
    }
    return await realPut(key, value, options);
  };
  const page = await fillDatesPage(store);
  assert.equal(page.filled, 0);
  const after = await readDocument(store, "a.md");
  assert.ok(after.text.includes("A, edited"), after.text);
  assert.notEqual(after.etag, before.etag);
});

test("a long pass stops starting notes at its budget and says where to go on", async () => {
  const store = memoryStore({ gaps: [{ path: "a.md", created: CREATED, saved: SAVED }, { path: "b.md", created: CREATED, saved: SAVED }] });
  await store.put("a.md", "---\ncreated:\n---\n");
  await store.put("b.md", "---\ncreated:\n---\n");
  let clock = 0;
  const page = await fillDatesPage(store, { budgetMs: 5, now: () => (clock += 4) });
  assert.deepEqual({ filled: page.filled, next: page.next }, { filled: 1, next: "a.md" });
  const rest = await fillDatesPage(store, { after: page.next });
  assert.deepEqual({ filled: rest.filled, next: rest.next }, { filled: 1, next: null });
});

test("only the last save of a burst stamps, after its pause, and the stamp sets off nothing", async () => {
  const store = memoryStore({ gaps: [] });
  await store.put("n.md", "---\ndate modified: 2026-01-01\n---\n\nA\n");
  const base = await readDocument(store, "n.md");
  const first = await replaceText(store, "n.md", { expectedEtag: base.etag, text: "---\ndate modified: 2026-01-01\n---\n\nAB\n" });
  const firstRun = stampAfterQuiet(store, "n.md", first, base.text, SAVED - 1000, { quietMs: 30 });
  const second = await replaceText(store, "n.md", { expectedEtag: first.etag, text: "---\ndate modified: 2026-01-01\n---\n\nABC\n" });
  const secondRun = stampAfterQuiet(store, "n.md", second, first.text, SAVED, { quietMs: 30 });
  // Nothing is stamped while the typing goes on.
  assert.equal((await readDocument(store, "n.md")).etag, second.etag);
  assert.deepEqual(await Promise.all([firstRun, secondRun]), ["superseded", "stamped"]);
  const stamped = await readDocument(store, "n.md");
  assert.equal(stamped.text, "---\ndate modified: 2026-11-09\n---\n\nABC\n");
  // Not an edit: no audit record or activity line of its own.
  assert.deepEqual([...store.objects.keys()].filter((key) => key.startsWith(".context/audit")), []);
  // A date-only change is not content: nothing to wait for after the stamp.
  assert.equal(stampAfterQuiet(store, "n.md", stamped, second.text, SAVED + 5000, { quietMs: 30 }), null);
});

test("Tex's own folder keeps the dates Tex sets itself", async () => {
  const { datedForWrite, stampsPath } = await import("../src/notes/dateStamp.js");
  assert.equal(stampsPath("tex/skills/booking.md"), false);
  assert.equal(stampsPath("texts/plan.md"), true);
  const skill = "---\nname: booking\nupdated: 2026-01-01\n---\n\nSteps\n";
  assert.equal(await datedForWrite({}, "tex/skills/booking.md", skill, skill.replace("Steps", "Old")), skill);
  const store = memoryStore({ gaps: [{ path: "tex/skills/booking.md", created: CREATED, saved: SAVED }] });
  await store.put("tex/skills/booking.md", "---\ncreated:\n---\n");
  assert.deepEqual(await fillDatesPage(store), { served: true, filled: 0, looked: 0, next: null });
});

test("fill_dates is the owner's, and says when the notes are not in the object yet", async () => {
  const store = memoryStore({ gaps: [] });
  assert.match((await toolFillDates(store, "team", {})).content[0].text, /^Not run: only the owner/);
  assert.match((await toolFillDates({}, "private", {})).content[0].text, /^Not run: this context's notes/);
  assert.match((await toolFillDates(store, "private", {})).content[0].text, /^Filled date properties in 0 notes; 0 had a date key with no value/);
});
