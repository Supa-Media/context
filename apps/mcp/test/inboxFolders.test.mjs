// Where a writer's `inbox/...` path lands (`src/communications/inboxFolders.js`).
// Writers name the Inbox `inbox` since the numbers came off built-in folders
// (2026-10-21). An unkeyed workspace's write lands at the path it names, so
// the path is carried to the folder the tree says does the Inbox's job first;
// without that, a workspace whose Inbox is still `0-inbox` grows a second one.
import test from "node:test";
import assert from "node:assert/strict";
import { inboxFolders, inboxPath, underInbox } from "../src/communications/inboxFolders.js";

const storeWith = (jobs) => ({ treeFacts: async () => ({ served: true, jobs, roots: Object.values(jobs) }) });

test("a write under inbox/ goes to the folder doing the Inbox's job", async () => {
  const store = storeWith({ inbox: "0-inbox" });
  assert.equal(await inboxPath(store, "inbox/memories"), "0-inbox/memories");
  assert.equal(await inboxPath(store, "inbox"), "0-inbox");
  assert.equal(await inboxPath(storeWith({ inbox: "Work/Capture" }), "inbox/sessions/a.md"), "Work/Capture/sessions/a.md");
});

test("with no answer from the tree, the plain name is written", async () => {
  assert.equal(await inboxPath({}, "inbox/memories"), "inbox/memories");
  assert.deepEqual(await inboxFolders({}), { folders: ["inbox", "0-inbox"], home: null });
});

test("underInbox never doubles the Inbox's name", () => {
  assert.deepEqual(underInbox(["0-inbox"], "inbox"), ["0-inbox"]);
  assert.deepEqual(underInbox(["0-inbox", "inbox"], "inbox/email"), ["0-inbox/email", "inbox/email"]);
});

test("a path outside the Inbox is left alone, and the tree is not asked", async () => {
  let asked = false;
  const store = { treeFacts: async () => ((asked = true), { served: true, jobs: { inbox: "0-inbox" }, roots: [] }) };
  assert.equal(await inboxPath(store, "archive/chat-history"), "archive/chat-history");
  assert.equal(asked, false);
});
