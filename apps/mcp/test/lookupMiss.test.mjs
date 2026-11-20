// Whether the object may answer that nothing is at a path (`workspaceStore/lookupMiss.js` `absentHere`), over a real
// workspace rows store on node:sqlite. A path with no live row is absent unless a built-in folder's name reroutes it
// (`inbox/...` once a root folder is not named so), or it is a Tex home (a folder with the tex role, `tex/`, or a group
// chat's `tex/groups/`), judged the same whatever the case of the path.
//
import { test } from "node:test";
import assert from "node:assert/strict";

import { absentHere, chatHomeOwner } from "../src/workspaceStore/lookupMiss.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function sqlOver(db) {
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function fresh() {
  const db = new DatabaseSync(":memory:");
  return workspaceRows(sqlOver(db));
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

test("no row at the path, and nothing reroutes it: absent", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "plans/x.md"), true);
});

test("a live row at the path is not absent", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(1), noteId: ID(1), path: "plans/x.md", kind: "file", at: 1 }]);
  assert.equal(absentHere(rows, "plans/x.md"), false);
});

test("a top-level path with no folders is absent", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "plans/x.md"), true);
  assert.equal(absentHere(rows, "x.md"), true);
});

test("inbox is a job name: with no root folder named inbox, a path under it is not absent (it is rerouted)", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "inbox/x.md"), false);
  // A numbered name plays the same job, so it is rerouted too.
  assert.equal(absentHere(rows, "0-inbox/x.md"), false);
});

test("inbox with a live root folder named inbox: the path is absent, the folder answers for itself", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(2), path: "inbox", kind: "folder", at: 1 }]);
  assert.equal(absentHere(rows, "inbox/x.md"), true);
});

test("a folder named inbox that is gone no longer answers the job, so the path is rerouted again", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(2), path: "inbox", kind: "folder", at: 1 }]);
  rows.remove([ID(2)], 2);
  assert.equal(absentHere(rows, "inbox/x.md"), false);
});

test("tex is a job: a path under tex is not absent when there is a tex folder", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(3), path: "tex", kind: "folder", at: 1 }]);
  assert.equal(absentHere(rows, "tex/x.md"), false);
});

test("tex with no folder named tex is still not absent: Tex's home is the control plane's to name", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "tex/x.md"), false);
});

test("a path under a folder with the tex role is not absent, whatever the folder is called", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(4), path: "assistant", kind: "folder", role: "tex", at: 1 }]);
  assert.equal(absentHere(rows, "assistant/x.md"), false);
  assert.equal(absentHere(rows, "assistant/deeper/y.md"), false);
});

test("a group chat's home is not absent, with no folders at all", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "tex/groups/abc/x.md"), false);
});

test("a group chat's home is not absent in any letter case", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "Tex/Groups/abc/x.md"), false);
  assert.equal(absentHere(rows, "TEX/GROUPS/abc/x.md"), false);
});

test("a gone row at the path is absent again", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(5), noteId: ID(5), path: "plans/x.md", kind: "file", at: 1 }]);
  assert.equal(absentHere(rows, "plans/x.md"), false);
  rows.remove([ID(5)], 2);
  assert.equal(absentHere(rows, "plans/x.md"), true);
});

test("an empty or non-string path is never absent", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, ""), false);
  assert.equal(absentHere(rows, null), false);
});

// 2026-11-20: a computer job's new note under `tex/groups/` in a shared workspace that is not the pin asked the control
// plane, which answered "not served" for its grant, and the save failed. Only the pinned workspace holds chat homes and
// only a personal one keeps its Tex folder in Tex's store (`apps/convex/functions/lib/noteIds/texHome.ts`), so where the
// object knows neither applies, the path is absent and the note is made in the object.
test("a chat-homes path is absent where the access set says this workspace holds no chat homes", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(6), path: "tex", kind: "folder", at: 1 }, { id: ID(7), path: "tex/groups", kind: "folder", at: 1 }]);
  assert.equal(absentHere(rows, "tex/groups/kite-willow-rocket/x.md", { chatHomes: false, texFolder: false }), true);
  // Unknown (no set held yet, or the pin) still reroutes, as before.
  assert.equal(absentHere(rows, "tex/groups/kite-willow-rocket/x.md", { texFolder: false }), false);
  assert.equal(absentHere(rows, "tex/groups/kite-willow-rocket/x.md"), false);
});

test("a Tex folder path is absent only where the gateway says the workspace is shared", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(8), path: "tex", kind: "folder", at: 1 }, { id: ID(9), path: "assistant", kind: "folder", role: "tex", at: 1 }]);
  assert.equal(absentHere(rows, "tex/x.md", { chatHomes: false, texFolder: false }), true);
  assert.equal(absentHere(rows, "assistant/x.md", { chatHomes: false, texFolder: false }), true);
  // A personal workspace (or one not said) keeps them in Tex's store: the control plane names the key.
  assert.equal(absentHere(rows, "tex/x.md", { chatHomes: false }), false);
  assert.equal(absentHere(rows, "assistant/x.md", { chatHomes: false, texFolder: true }), false);
  // A built-in folder's name is still the control plane's to place, whatever the workspace.
  assert.equal(absentHere(rows, "inbox/x.md", { chatHomes: false, texFolder: false }), false);
});

// A group chat's own session making a note in its own home (`chatHomeOwner`): the object names that chat's Tex owner
// only in the pin (the access set seals chat homes), only strictly beneath a live home folder whose note folder exists,
// and never for a plumbing path, a malformed home or a chat key that is not 64 hex.
// Sabotage: drop the `sealsChats !== true` check and the "not the pin" assertion fails.
test("chatHomeOwner names the chat's owner only for its own live home in the pin", { skip }, () => {
  const rows = fresh();
  const folder = "tex/groups/kite-willow-rocket";
  const chat = "a".repeat(64);
  rows.put([
    { id: ID(10), path: "tex", kind: "folder", at: 1 },
    { id: ID(11), path: "tex/groups", kind: "folder", at: 1 },
    { id: ID(12), path: folder, kind: "folder", at: 1 },
    { id: ID(13), path: `${folder}/notes`, kind: "folder", at: 1 },
  ]);
  const home = { folder, chat };
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, home, true), `chat:${chat}`);
  assert.equal(chatHomeOwner(rows, `${folder}/notes/b.md`, home, true), `chat:${chat}`);
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, home, false), null, "not the pin");
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, home, null), null, "access set not held yet");
  assert.equal(chatHomeOwner(rows, `${folder}/missing/c.md`, home, true), null, "note folder does not exist");
  assert.equal(chatHomeOwner(rows, "tex/groups/other-home-here/a.md", home, true), null, "another home");
  assert.equal(chatHomeOwner(rows, folder, home, true), null, "the home itself");
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, { folder, chat: "A".repeat(64) }, true), null, "chat key not lowercase hex");
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, { folder: "tex/groups/x", chat }, true), null, "not a three-word home");
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, null, true), null, "no chat home");
  assert.equal(chatHomeOwner(rows, `${folder}/.context/x.md`, home, true), null, "plumbing");
});

test("chatHomeOwner refuses a home folder that is not a live folder row", { skip }, () => {
  const rows = fresh();
  const folder = "tex/groups/kite-willow-rocket";
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, { folder, chat: "b".repeat(64) }, true), null);
  rows.put([{ id: ID(20), path: folder, kind: "folder", at: 1 }]);
  rows.remove([ID(20)], 2);
  assert.equal(chatHomeOwner(rows, `${folder}/a.md`, { folder, chat: "b".repeat(64) }, true), null);
});
