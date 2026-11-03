// How many storage round trips one whole-note save waits for, one after another (`replaceText` with `onlyCurrent`,
// the gateway's `write_note` path). Every one of them is a trip to the bucket or the workspace object in front of the
// answer, so the count is held here: a change that adds one back fails this file.
import assert from "node:assert/strict";
import test from "node:test";
import { readDocument, replaceText } from "../src/index.js";

/** A store whose every call takes one tick of a logical clock, so calls made together share a tick. */
class TickStore {
  constructor() {
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
    this.objects = new Map();
    this.sequence = 0;
    this.ticks = 0;
    this.waiting = [];
    this.calls = [];
  }
  /** Calls asked in the same turn of the event loop land in the same tick. */
  turn(name, key, run) {
    this.calls.push(`${name} ${key}`);
    return new Promise((resolve, reject) => {
      this.waiting.push(() => {
        try {
          resolve(run());
        } catch (error) {
          reject(error);
        }
      });
      if (this.waiting.length === 1) {
        setTimeout(() => {
          this.ticks += 1;
          for (const run of this.waiting.splice(0)) run();
        }, 1);
      }
    });
  }
  get(key) {
    return this.turn("get", key, () => {
      const object = this.objects.get(key);
      return object ? { etag: object.etag, text: async () => object.text } : null;
    });
  }
  put(key, value, options = {}) {
    return this.turn("put", key, () => {
      const current = this.objects.get(key);
      if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
      if (options.onlyIf?.absent && current) return null;
      const etag = `e${++this.sequence}`;
      this.objects.set(key, { etag, text: typeof value === "string" ? value : new TextDecoder().decode(value) });
      return { etag };
    });
  }
  delete(key) {
    return this.turn("delete", key, () => {
      this.objects.delete(key);
    });
  }
  list({ prefix = "" } = {}) {
    return this.turn("list", prefix, () => ({
      objects: [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => ({ key, etag: object.etag })),
      truncated: false,
    }));
  }
}

/** The most round trips a save of an existing collaborative note may wait for in a row. */
const SAVE_ROUND_TRIPS = Number(process.env.SAVE_ROUND_TRIPS ?? 7);

test("a whole-note save of an existing collaborative note waits for at most SAVE_ROUND_TRIPS storage round trips", async () => {
  const store = new TickStore();
  store.objects.set("note.md", { etag: "e0", text: "# Note\n\nFirst words.\n" });
  // A first save makes the note collaborative; the one measured is the ordinary save after it.
  const first = await readDocument(store, "note.md");
  const saved = await replaceText(store, "note.md", { expectedEtag: first.etag, onlyCurrent: true, text: "# Note\n\nSecond words.\n" });
  store.ticks = 0;
  store.calls = [];
  const result = await replaceText(store, "note.md", { expectedEtag: saved.etag, onlyCurrent: true, text: "# Note\n\nThird words.\n" });
  assert.equal(store.objects.get("note.md").text, "# Note\n\nThird words.\n", "the save did not land in the Markdown");
  assert.ok(result.etag, "the save answered no version");
  assert.ok(
    store.ticks <= SAVE_ROUND_TRIPS,
    `a save waited for ${store.ticks} round trips, more than ${SAVE_ROUND_TRIPS}:\n${store.calls.join("\n")}`,
  );
});

test("Markdown changed between the commit and its rendering still ends as the accepted text, read afresh", async () => {
  const store = new TickStore();
  store.objects.set("note.md", { etag: "e0", text: "# Note\n\nFirst words.\n" });
  const first = await readDocument(store, "note.md");
  const put = store.put.bind(store);
  let raced = false;
  store.put = async (key, value, options) => {
    const answer = await put(key, value, options);
    // Right after the document's state accepts the save, somebody else rewrites the Markdown.
    if (!raced && key.includes("/documents/") && answer && JSON.parse(value).pending) {
      raced = true;
      store.objects.set("note.md", { etag: "outside", text: "# Note\n\nWritten outside.\n" });
    }
    return answer;
  };
  const result = await replaceText(store, "note.md", { expectedEtag: first.etag, onlyCurrent: true, text: "# Note\n\nSecond words.\n" });
  assert.ok(raced, "the race never ran");
  assert.equal(store.objects.get("note.md").text, "# Note\n\nSecond words.\n");
  const after = await readDocument(store, "note.md");
  assert.equal(after.etag, result.etag);
  assert.equal(after.text, "# Note\n\nSecond words.\n");
});
