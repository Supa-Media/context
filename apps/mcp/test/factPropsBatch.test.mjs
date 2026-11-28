/**
 * A folder or list read asks its workspace's object for every note's props in one call, not one a hundred notes
 * (`src/tree/facts.js` `factProps`, `OBJECT_PROPS_REQUEST_PATHS`; `src/workspaceStore/facts.js` `PROPS_ASK_PATHS`), and
 * where the object does not serve it the control plane is asked a hundred at a time, as before
 * (`src/http/routing.js` `treeFacts`). The props found are the same either way.
 *
 * Production, 24 h to 2026-11-28: fetch's facts asks were 8.8 calls a request, p95 1,320 ms, each a trip to the same
 * object, which answers one at a time.
 *
 * Sabotage record (temporary local edits, reverted; each one fails the named test):
 *   `factProps` keeping the hundred-note batch for an object      -> "an object-homed read asks once ..." fails
 *   the object's `PROPS_ASK_PATHS` left at a hundred              -> "the object answers a thousand ..." fails
 *   the control-plane split dropped from `treeFacts`              -> "a larger ask the object did not serve ..." fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { factProps, OBJECT_PROPS_REQUEST_PATHS, PROPS_REQUEST_PATHS } from "../src/tree/facts.js";
import { attachLinkCalls } from "../src/http/routing.js";
import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceFacts, PROPS_ASK_PATHS, FactAskRefused } from "../src/workspaceStore/facts.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

const PATHS = Array.from({ length: 880 }, (_, n) => `notes/n${n}.md`);
const propsOf = (path) => ({ path, version: `v-${path}`, sealed: false, props: JSON.stringify({ properties: { status: path.length % 2 ? "doing" : "done" }, inlineTags: [], heading: path, lede: null }) });
/** A facts answerer that records each ask's size and answers every path it is asked. */
function answerer() {
  const sizes = [];
  const answer = async (request) => {
    sizes.push(request.paths.length);
    return { served: true, props: request.paths.map(propsOf) };
  };
  return { sizes, answer };
}

test("an object-homed read asks once for a folder's notes, and finds what a hundred at a time found", async () => {
  const object = answerer();
  const objectHomed = { treeFacts: object.answer, objectFacts: async () => null };
  const found = await factProps(objectHomed, PATHS);
  assert.deepEqual(object.sizes, [880]);

  const plane = answerer();
  const before = await factProps({ treeFacts: plane.answer }, PATHS);
  assert.deepEqual(plane.sizes, [100, 100, 100, 100, 100, 100, 100, 100, 80], "a store the control plane answers asks as before");
  assert.deepEqual([...found], [...before]);
  assert.equal(found.size, 880);

  const more = answerer();
  await factProps({ treeFacts: more.answer, objectFacts: async () => null }, Array.from({ length: OBJECT_PROPS_REQUEST_PATHS + 5 }, (_, n) => `a/${n}.md`));
  assert.deepEqual(more.sizes, [OBJECT_PROPS_REQUEST_PATHS, 5]);
});

test("a larger ask the object did not serve goes to the control plane a hundred at a time, and is answered whole", async () => {
  const sent = [];
  const controlPlane = {
    readTreeFacts: async (token, workspaceId, request) => {
      assert.ok(request.paths.length <= PROPS_REQUEST_PATHS, "the control plane takes a hundred");
      sent.push(request.paths.length);
      return { served: true, props: request.paths.map(propsOf) };
    },
  };
  const store = { objectFacts: async () => null };
  attachLinkCalls(store, { accessToken: "tok", workspaceId: "ws_1" }, controlPlane, {});
  const answer = await store.treeFacts({ ask: "props", paths: PATHS });
  assert.deepEqual(sent, [100, 100, 100, 100, 100, 100, 100, 100, 80]);
  assert.equal(answer.served, true);
  assert.deepEqual(answer.props.map((row) => row.path), PATHS);

  // One part not served: the whole ask is not, and the caller says what the listing alone says.
  let calls = 0;
  controlPlane.readTreeFacts = async (token, workspaceId, request) => (++calls === 3 ? { served: false } : { served: true, props: request.paths.map(propsOf) });
  assert.equal((await store.treeFacts({ ask: "props", paths: PATHS })).served, false);
  calls = 0;
  assert.equal(await factProps(store, PATHS), null);

  // What the object serves is its answer, with no trip to the control plane.
  sent.length = 0;
  const served = { served: true, props: [propsOf("notes/n1.md")] };
  const homed = { objectFacts: async () => served };
  attachLinkCalls(homed, { accessToken: "tok", workspaceId: "ws_1" }, { readTreeFacts: async () => assert.fail("not asked") }, {});
  assert.equal(await homed.treeFacts({ ask: "props", paths: PATHS }), served);
});

test("the object answers a thousand paths in one props ask, and refuses more", { skip }, () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
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
  const objects = texObjects(sql, { now: () => 1 });
  const rows = workspaceRows(sql);
  const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  for (let n = 0; n < 1_000; n += 1) objects.put(`notes/${ID(n)}.md`, new TextEncoder().encode(`---\nstatus: doing\n---\n# Note ${n}\n`), {});
  rows.put(Array.from({ length: 1_000 }, (_, n) => ({ id: `r${n}`, noteId: ID(n), path: `notes/n${n}.md`, kind: "file", storageKey: `notes/${ID(n)}.md`, at: 10 })));
  const facts = workspaceFacts(sql, objects);
  assert.equal(PROPS_ASK_PATHS, OBJECT_PROPS_REQUEST_PATHS);
  const paths = Array.from({ length: 1_000 }, (_, n) => `notes/n${n}.md`);
  const answer = facts.props({ paths }, () => true);
  assert.equal(answer.props.length, 1_000);
  assert.equal(JSON.parse(answer.props[7].props).properties.status, "doing");
  assert.throws(() => facts.props({ paths: [...paths, "notes/extra.md"] }, () => true), FactAskRefused);
});
