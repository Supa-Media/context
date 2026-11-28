/**
 * A group chat's Tex is told, on every `read_note`, the notes beside it whose names share a word with it
 * (`src/tools/notes/namedAlike.js`), so "share the setlist" with three setlists side by side is never answered as if
 * the one it opened were the only one (Lab, 2026-11-28). Names only, listed at the caller's scope: a note the caller
 * cannot see is never named. Every other client reads as before. A Lab test chat's own notes are named the same way
 * (`labSandbox/sandboxTools.js` `sandboxNamedAlike`).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-28):
 *   (i)   dispatch.js: the `namedAlike` line removed → "a group's read names the setlists beside it" fails.
 *   (ii)  namedAlike.js `namesAlike`: the folder check removed → "only notes in its own folder" fails.
 *   (iii) namedAlike.js `readWithNamedAlike`: listing at "private" in place of the caller's scope → "a note the caller
 *         cannot see is never named" fails.
 *   (iv)  session.js `groupTurn`: the Lab group test chat half removed → "a Lab group test chat's read is told too"
 *         fails (the Lab runs a group test chat on its user's own grant, so it was never told; Lab, 2026-11-28).
 *   (v)   policy.js `sandboxedTool`: answering with `toolAnswer` alone → "a group test chat's turn ... is told too"
 *         fails (Tex's turn answers a test chat's own note there, never through session.js; Lab, 2026-11-28).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callToolForSession } from "../src/tools/session.js";
import { TEXTS_GROUP_CLIENT_ID } from "../src/machines/reach.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { namesAlike, nameWords, withNamedAlike, NAMED_ALIKE } from "../src/tools/notes/namedAlike.js";
import { sandboxNamedAlike } from "../src/labSandbox/sandboxTools.js";
import { LAB_SANDBOX_KEY, sandboxedTool } from "../src/labSandbox/policy.js";
import { withServedTree } from "./servedTree.mjs";

function workspaceStore(notes, rules) {
  const files = new Map(Object.entries(notes));
  const store = {
    async list({ prefix } = {}) {
      const objects = [...files.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort().map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
      return { objects, truncated: false };
    },
    async get(key) {
      if (!files.has(key)) return null;
      const body = files.get(key);
      return { etag: `e-${key}`, text: async () => body, size: body.length };
    },
    async head(key) {
      return files.has(key) ? { etag: `e-${key}`, size: files.get(key).length } : null;
    },
  };
  return withPrivacyAuthority(withServedTree(store), { rules });
}

// Fake notes only.
const NOTES = {
  "band/zephyr-setlist.page.md": "# Zephyr setlist\n\n- Glass Lantern\n",
  "band/friday-setlist.page.md": "# Friday setlist\n\n- Amber Dock\n",
  "band/saturday-setlist.md": "# Saturday setlist\n\n- Iron Gate\n",
  "band/merch-plan.md": "# Merch plan\n",
  "band/held/setlist-draft.md": "# Draft\n",
  "other/zephyr-setlist.md": "# Elsewhere\n",
};
const RULES = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "band", visibility: "team" }], notes: [{ path: "band/saturday-setlist.md", visibility: "private" }] };
const read = (clientId, scope = "private") =>
  callToolForSession({ name: "read_note", arguments: { path: "band/zephyr-setlist.page.md" } }, workspaceStore(NOTES, RULES), { scope, workspaceId: "ws-own", actorClientId: clientId });
const header = (result) => result.content[0].text.split("\n\n")[0];

test("a group's read names the setlists beside it, in its header", async () => {
  const result = await read(TEXTS_GROUP_CLIENT_ID);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(header(result), new RegExp(`^${NAMED_ALIKE}: friday-setlist.page.md, saturday-setlist.md$`, "m"), header(result));
  assert.ok(result.content[0].text.includes("- Glass Lantern"));
});

test("only notes in its own folder: a note named alike in a subfolder or elsewhere is not named", () => {
  assert.deepEqual(namesAlike("band/zephyr-setlist.page.md", Object.keys(NOTES)), ["friday-setlist.page.md", "saturday-setlist.md"]);
});

test("a note the caller cannot see is never named: a team reader is not told of a private setlist", async () => {
  const result = await read(TEXTS_GROUP_CLIENT_ID, "team");
  assert.match(header(result), new RegExp(`^${NAMED_ALIKE}: friday-setlist.page.md$`, "m"), header(result));
});

test("any other client's read is as before", async () => {
  const result = await read("some-client");
  assert.doesNotMatch(result.content[0].text, new RegExp(NAMED_ALIKE));
});

test("name words drop every extension and short words; a name with no word alike names nothing", () => {
  assert.deepEqual([...nameWords("a/zephyr-setlist.page.md")], ["zephyr", "setlist"]);
  assert.deepEqual(namesAlike("band/merch-plan.md", Object.keys(NOTES)), []);
  const plain = { content: [{ type: "text", text: "etag: e\npath: x\n\nbody" }] };
  assert.equal(withNamedAlike(plain, []), plain);
});

test("a second listing joins the line already there, never a second line", () => {
  const once = withNamedAlike({ content: [{ type: "text", text: "etag: e\npath: band/a-setlist.md\n\nbody" }] }, ["b-setlist.md"]);
  const twice = withNamedAlike(once, ["c-setlist.md", "b-setlist.md"]);
  assert.equal(twice.content[0].text, `etag: e\npath: band/a-setlist.md\n${NAMED_ALIKE}: b-setlist.md, c-setlist.md\n\nbody`);
});

test("a Lab test chat's own notes are named alike beside one it wrote", async () => {
  const held = [
    { path: "band/zephyr-setlist.page.md", body: "# Z", adds: [] },
    { path: "band/friday-setlist.page.md", body: "# F", adds: [] },
    { path: "band/sunday-setlist.md", gone: true, body: null, adds: [] },
  ];
  const gate = { call: async (op) => (op === "note.list" ? { notes: held } : {}) };
  const stubbed = { content: [{ type: "text", text: "etag: lab-1\npath: band/zephyr-setlist.page.md\n\n# Z" }] };
  const result = await sandboxNamedAlike("read_note", { path: "band/zephyr-setlist.page.md" }, stubbed, gate);
  assert.match(header(result), new RegExp(`^${NAMED_ALIKE}: friday-setlist.page.md$`, "m"));
});

test("a Lab group test chat's read is told too, though it runs on the Lab user's own grant; a 1:1 test chat's is not", async () => {
  const held = [
    { path: "band/zephyr-setlist.page.md", body: "# Z", adds: [] },
    { path: "band/friday-setlist.page.md", body: "# F", adds: [] },
  ];
  const gateOf = (kind) => ({
    about: { kind },
    call: async (op, fields) => (op === "note.list" ? { notes: held } : op === "note.get" ? { found: held.find((note) => note.path === fields.path) ?? null } : {}),
    record() {},
    keepWrite() {},
  });
  const readAs = async (kind) => {
    const session = { scope: "private", workspaceId: "ws-own", actorClientId: "some-client" };
    Object.defineProperty(session, "labSandbox", { value: gateOf(kind), enumerable: false });
    return callToolForSession({ name: "read_note", arguments: { path: "band/zephyr-setlist.page.md" } }, workspaceStore({}, RULES), session);
  };
  const group = await readAs("group");
  assert.match(header(group), new RegExp(`^${NAMED_ALIKE}: friday-setlist.page.md$`, "m"), group.content[0].text);
  assert.doesNotMatch((await readAs("person")).content[0].text, new RegExp(NAMED_ALIKE));
});

test("a group test chat's turn reading a note it wrote is told too, as Tex's turn answers it (`sandboxedTool`)", async () => {
  const held = [
    { path: "band/zephyr-setlist.page.md", body: "# Z", adds: [] },
    { path: "band/friday-setlist.page.md", body: "# F", adds: [] },
  ];
  const gateOf = (kind) => ({
    about: { kind },
    call: async (op, fields) => (op === "note.list" ? { notes: held } : op === "note.get" ? { found: held.find((note) => note.path === fields.path) ?? null } : {}),
    record() {},
    keepWrite() {},
  });
  const read = (kind) => sandboxedTool({ [LAB_SANDBOX_KEY]: gateOf(kind) }, { name: "read_note", args: { path: "band/zephyr-setlist.page.md" } });
  assert.match(header(await read("group")), new RegExp(`^${NAMED_ALIKE}: friday-setlist.page.md$`, "m"));
  assert.doesNotMatch((await read("person")).content[0].text, new RegExp(NAMED_ALIKE));
});
