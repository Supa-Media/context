// The gateway's name guards (`src/tree/twins.js`): a duplicate of a built-in
// folder is an ordinary folder, and a new name may not twin a sibling by case
// nor, at the root, a role another folder plays. Owner decision 2026-10-14,
// after an agent made `projects` beside `Projects`. Fake values only.
import test from "node:test";
import assert from "node:assert/strict";
import { nameTwinRefusal, protectedFolderRefusal } from "../src/tree/twins.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";

function storeOf(keys) {
  const sorted = [...keys].sort();
  return {
    async list({ prefix = "" } = {}) {
      return { objects: sorted.filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const NONE = new PrivacyOverrides();
const ALL = [{ prefix: "Projects", vis: "team" }, { prefix: "projects", vis: "team" }, { prefix: "Areas", vis: "team" }];

test("an agent's lowercase twin of a folder is refused, naming the path to use", async () => {
  const store = storeOf(["Projects/about.md", "Projects/launch.md", "Areas/about.md"]);
  const refusal = await nameTwinRefusal(store, "private", ALL, NONE, "projects/plan.md");
  assert.match(refusal, /Projects is already here/);
  assert.match(refusal, /Use Projects\/plan\.md instead/);
  assert.equal(await nameTwinRefusal(store, "private", ALL, NONE, "Projects/plan.md"), null);
  assert.equal(await nameTwinRefusal(store, "private", ALL, NONE, "Projects/new/plan.md"), null);
});

test("a new root folder may not take a role another folder plays; below the root it may", async () => {
  const store = storeOf(["Projects/about.md"]);
  assert.match(
    await nameTwinRefusal(store, "private", ALL, NONE, "1-projects/plan.md"),
    /Projects is already this workspace's Projects folder, so use Projects\/plan\.md/,
  );
  assert.equal(await nameTwinRefusal(store, "private", ALL, NONE, "Projects/1-projects/plan.md"), null);
});

test("a note twinning a note by case is refused; a rename that only changes case is not", async () => {
  const store = storeOf(["Projects/pay.md"]);
  assert.match(await nameTwinRefusal(store, "private", ALL, NONE, "Projects/Pay.md"), /pay\.md is already here/);
  assert.equal(await nameTwinRefusal(store, "private", ALL, NONE, "Projects/Pay.md", { ignore: "Projects/pay.md" }), null);
});

test("a twin this connection cannot see is never named", async () => {
  const store = storeOf(["Secret/plan.md", "Areas/about.md"]);
  // Secret is private (no rule); a team connection writing `secret/x.md` is not told it exists.
  assert.equal(await nameTwinRefusal(store, "team", ALL, NONE, "secret/x.md"), null);
  assert.match(await nameTwinRefusal(store, "private", ALL, NONE, "secret/x.md"), /Secret is already here/);
});

test("only the folder playing a role is locked; its duplicate moves", async () => {
  const store = storeOf(["Projects/about.md", "projects/about.md", "4-archive/a.md", "9-archive/b.md"]);
  const rules = [...ALL, { prefix: "4-archive", vis: "team" }, { prefix: "9-archive", vis: "team" }];
  assert.match(await protectedFolderRefusal(store, "private", rules, NONE, "Projects"), /built-in folder/);
  assert.equal(await protectedFolderRefusal(store, "private", rules, NONE, "projects"), null);
  assert.match(await protectedFolderRefusal(store, "private", rules, NONE, "4-archive"), /Archive is a built-in folder/);
  assert.equal(await protectedFolderRefusal(store, "private", rules, NONE, "9-archive"), null);
  // Alone, a role's folder is locked whether or not it exists yet.
  assert.match(await protectedFolderRefusal(storeOf([]), "private", rules, NONE, "Inbox"), /Inbox is a built-in folder/);
});

test("the Inbox's own folders stay put; a folder of a person's own in the Inbox moves", async () => {
  const store = storeOf(["0-inbox/email/a.md", "0-inbox/ideas/b.md", "recipes/email/c.md"]);
  const rules = [{ prefix: "0-inbox", vis: "team" }, { prefix: "recipes", vis: "team" }];
  assert.match(await protectedFolderRefusal(store, "private", rules, NONE, "0-inbox/email"), /Email is one of the Inbox's own folders/);
  assert.match(await protectedFolderRefusal(store, "private", rules, NONE, "0-inbox/google-chat"), /Google Chat is one of the Inbox's own/);
  assert.equal(await protectedFolderRefusal(store, "private", rules, NONE, "0-inbox/ideas"), null);
  assert.equal(await protectedFolderRefusal(store, "private", rules, NONE, "recipes/email"), null);
  assert.equal(await protectedFolderRefusal(store, "private", rules, NONE, "0-inbox/email/2026"), null);
});
