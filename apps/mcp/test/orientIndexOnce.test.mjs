// `orient` reads `index.md` once for both its front page and its save procedure (src/orient/frontPage.js): each
// used to read it on its own, two reads of the same note per orient.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFrontPage, readIndexText, readSaveProcedure } from "../src/orient/frontPage.js";

const INDEX = "# Home\n\nThe first paragraph.\n\n## Save context\n\ndestination: inbox/sessions\nSave the decisions.\n";

function countingStore() {
  const store = {
    gets: 0,
    get: async (key) => {
      store.gets += 1;
      return key === "index.md" ? { text: async () => INDEX } : null;
    },
  };
  return store;
}

// Sabotage: make `readFrontPage` ignore `indexText` and read again, and the count is 2.
test("the front page and the save procedure share one read of index.md", async () => {
  const store = countingStore();
  const once = readIndexText(store);
  const [page, procedure] = await Promise.all([readFrontPage(store, "private", null, null, 10_000, once), readSaveProcedure(store, "private", null, null, once)]);
  assert.equal(store.gets, 1);
  assert.match(page, /The first paragraph/);
  assert.equal(procedure.destination, "inbox/sessions");
});

test("without a shared read each still reads it, and a missing index is nothing", async () => {
  const store = countingStore();
  assert.match(await readFrontPage(store, "private", null, null, 10_000), /Home/);
  assert.equal(store.gets, 1);
  const empty = { get: async () => null };
  assert.equal(await readFrontPage(empty, "private", null, null, 10_000, readIndexText(empty)), null);
  assert.equal(await readSaveProcedure(empty, "private", null, null), null);
});
