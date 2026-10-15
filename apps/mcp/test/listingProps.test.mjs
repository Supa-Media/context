/**
 * The listing tools' rows come from the Convex tree's props of each note
 * (`/gateway/tree/facts` `ask: "props"`, `src/tree/facts.js`), never from the
 * note itself (owner, 2026-10-13). What a row says when the tree has not read
 * a note yet, or holds it sealed, is held here; `treeServed.test.mjs` holds
 * that the rows match the bucket's and that no note is opened.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `evaluate_lists` counting a note with no props as a row with empty
 *    properties: "a note the tree has not read is left out of a List, which
 *    says it is pending" fails.
 * 2. `parsedProps` returning `value.properties` itself (a plain object):
 *    "a List never reads a property off Object.prototype" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callTool } from "../src/tools/dispatch.js";
import { compareKeys } from "../src/tree/served.js";
import { propsOf } from "../src/tree/props.js";

const PRIVACY =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const SEALED = "---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{\"v\":1,\"ciphertext\":\"0000\"}\n```\n";

/**
 * A served store over `notes`: the manifest lists every key, and props are
 * answered for every key except those in `unread` (a note the tree's facts
 * have not read yet).
 */
function servedStore(notes, { unread = [] } = {}) {
  const objects = new Map(Object.entries(notes));
  const store = {
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(compareKeys);
      return { objects: keys.map((key) => ({ key, etag: `e-${key}`, size: objects.get(key).length })), truncated: false };
    },
    async get(key) {
      return objects.has(key) ? { key, etag: `e-${key}`, text: async () => objects.get(key) } : null;
    },
    async head(key) {
      return objects.has(key) ? { key, etag: `e-${key}` } : null;
    },
  };
  Object.defineProperty(store, "treeManifest", {
    value: async ({ folder } = {}) => ({
      served: true,
      entries: [...objects.keys()]
        .filter((key) => !key.startsWith(".") && (!folder || key.startsWith(`${folder}/`)))
        .sort(compareKeys)
        .map((path) => ({ path, etag: `e-${path}`, updatedAt: Date.UTC(2026, 9, 1) })),
      cursor: null,
    }),
  });
  Object.defineProperty(store, "treeFacts", {
    configurable: true,
    value: async ({ ask, paths }) => {
      assert.equal(ask, "props");
      return {
        served: true,
        props: paths
          .filter((path) => objects.has(path) && !unread.includes(path))
          .map((path) => {
            const parsed = propsOf(objects.get(path));
            return { path, version: `e-${path}`, sealed: parsed === null, props: parsed && JSON.stringify(parsed) };
          }),
      };
    },
  });
  return store;
}

const text = (answer) => answer.content[0].text;

test("a meeting the tree has not read is listed by its date and says its details are still loading", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "0-inbox/meetings/2026-10-02-review.md": "---\nstarted: 2026-10-02T10:00:00Z\nduration: 30m\nattendees: [Ana, Ben]\n---\n# Review\n",
    "0-inbox/meetings/2026-10-01-standup.md": "---\nstarted: 2026-10-01T09:00:00Z\n---\n# Standup\n",
    "0-inbox/meetings/2026-09-30-sealed.md": SEALED,
  }, { unread: ["0-inbox/meetings/2026-10-01-standup.md"] });
  const answer = text(await callTool("list_meetings", {}, store, "private"));
  assert.match(answer, /^2026-10-02 · Review · 30m · Ana, Ben$/m);
  assert.match(answer, /^2026-10-01 · \(details still loading\)$/m);
  assert.match(answer, /^2026-09-30 · \(encrypted\)$/m);
});

test("a channel day the tree has not read is listed off its path, and says so", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "0-inbox/email/me-at-example-com/2026-10-02.md": "---\naccount: me@example.com\nmessages: 3\n---\n# Mail\n",
    "0-inbox/email/me-at-example-com/2026-10-01.md": "---\naccount: me@example.com\nmessages: 1\n---\n# Mail\n",
  }, { unread: ["0-inbox/email/me-at-example-com/2026-10-01.md"] });
  const answer = text(await callTool("list_channel_days", {}, store, "private"));
  assert.match(answer, /^2026-10-02 · me@example\.com · 3 messages$/m);
  assert.match(answer, /^2026-10-01 · me-at-example-com · \(details still loading\)$/m);
});

test("list_contacts tells a contact page, an imported one, a note of your own and a sealed page apart from props", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "0-inbox/contacts/ana.md": "---\nupdated: \"2026-10-01T00:00:00.000Z\"\ntype: \"contact\"\n---\n\n# Ana Silva\n\n**Organization:** Example Ltd\n",
    "0-inbox/contacts/imessage/mum.md": "---\nrole: communication-contact\n---\n\n# Mum\n",
    "0-inbox/contacts/mine.md": "# Something I wrote\n",
    "0-inbox/contacts/sealed.md": SEALED,
    "0-inbox/contacts/later.md": "---\ntype: contact\n---\n# Later\n",
  }, { unread: ["0-inbox/contacts/later.md"] });
  const answer = text(await callTool("list_contacts", { limit: 25 }, store, "private"));
  assert.match(answer, /^Ana Silva · Example Ltd · updated 2026-10-01\n  0-inbox\/contacts\/ana\.md$/m);
  assert.match(answer, /^Mum\n  0-inbox\/contacts\/imessage\/mum\.md$/m);
  assert.match(answer, /^\(a note of your own\)\n  0-inbox\/contacts\/mine\.md$/m);
  assert.match(answer, /^\(encrypted\)\n  0-inbox\/contacts\/sealed\.md$/m);
  assert.match(answer, /^\(details still loading\)\n  0-inbox\/contacts\/later\.md$/m);
});

const LIST_SOURCE = "# Board\n\n```list\nfrom: 1-projects/work\nshow: status\n```\n";

test("a note the tree has not read is left out of a List, which says it is pending", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "1-projects/board.md": LIST_SOURCE,
    "1-projects/work/a.md": "---\nstatus: doing\n---\n# A\n",
    "1-projects/work/b.md": "---\nstatus: done\n---\n# B\n",
    "1-projects/work/sealed.md": SEALED,
  }, { unread: ["1-projects/work/b.md"] });
  const answer = JSON.parse(text(await callTool("evaluate_lists", { path: "1-projects/board.md" }, store, "private")));
  const [list] = answer.lists;
  assert.deepEqual(list.rows.map((row) => row.path), ["1-projects/work/a.md"]);
  assert.equal(list.pending, true);
});

test("a List whose every note the tree has read is not pending, and leaves sealed notes out", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "1-projects/board.md": LIST_SOURCE,
    "1-projects/work/a.md": "---\nstatus: doing\n---\n# A\n",
    "1-projects/work/sealed.md": SEALED,
  });
  const [list] = JSON.parse(text(await callTool("evaluate_lists", { path: "1-projects/board.md" }, store, "private"))).lists;
  assert.deepEqual(list.rows.map((row) => row.path), ["1-projects/work/a.md"]);
  assert.equal(list.pending, undefined);
});

test("a List never reads a property off Object.prototype", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "1-projects/board.md": "# Board\n\n```list\nfrom: 1-projects/work\nshow: constructor\n```\n",
    "1-projects/work/a.md": "---\nstatus: doing\n---\n# A\n",
  });
  const [list] = JSON.parse(text(await callTool("evaluate_lists", { path: "1-projects/board.md" }, store, "private"))).lists;
  assert.equal(list.rows.length, 1);
  // A plain object would hand the List `Object`'s constructor, a function
  // (which JSON then drops); the note has no such property, so it is null.
  assert.deepEqual(list.rows[0].values, [{ key: "constructor", value: null }]);
});

test("props the tree cannot answer leave every row pending rather than reading the notes", async () => {
  const store = servedStore({
    "privacy.md": PRIVACY,
    "1-projects/board.md": LIST_SOURCE,
    "1-projects/work/a.md": "---\nstatus: doing\n---\n# A\n",
  });
  Object.defineProperty(store, "treeFacts", { value: async () => ({ served: false }) });
  const opened = [];
  const get = store.get;
  store.get = async (key) => {
    opened.push(key);
    return await get(key);
  };
  const [list] = JSON.parse(text(await callTool("evaluate_lists", { path: "1-projects/board.md" }, store, "private"))).lists;
  assert.deepEqual(list.rows, []);
  assert.equal(list.pending, true);
  assert.ok(!opened.includes("1-projects/work/a.md"), "the candidate was not opened");
});
