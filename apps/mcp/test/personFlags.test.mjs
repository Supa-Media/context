// Feature flags in the person object (src/workspaceStore/personFlags.js, docs/decisions/app-and-console/feature-flags.md):
// the control plane writes a person's whole set, every session their object answers carries it with no call of its
// own, a newer set always wins, a malformed one is refused, and one person's set never reaches another's session.
//
// Sabotage (temporary local edits, reverted): dropping `flags:` from `sessionFor` fails "carries the set"; letting
// `put` take an older set fails "a late older set"; `flagsOf` passing an odd value through fails the payload test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { personRows, sessionFor } from "../src/workspaceStore/personRows.js";
import { ACCESS_HOMES, AccessRowRefused } from "../src/workspaceStore/access.js";
import { TEXTING_TOKEN_MS } from "../src/workspaceStore/personTexting.js";
import { FLAGS_OPS, MAX_PERSON_FLAGS } from "../src/workspaceStore/personFlags.js";
import { servePersonCall } from "../src/workspaceStore/personServe.js";
import { normalizeSession } from "../src/sessionPayload.js";
import { flagOn } from "../src/flags.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
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

const hex = (seed) => seed.repeat(64).slice(0, 64);
const NOW = 1_800_000_000_000;

function person(userId, workspaceId) {
  const store = personRows(durableSql());
  store.pin(userId);
  store.put("reach", [{ workspaceId, slug: workspaceId.replace("ws_", ""), kind: "personal", role: "owner", groups: [], at: 1 }]);
  store.setHome(ACCESS_HOMES.OBJECT);
  store.texting.put({ phoneHashes: [hex("a1")], paused: false, scopes: ["context:read"], at: 1 });
  return store;
}

function sessionOf(store, seed) {
  const tokenHash = hex(seed);
  const answer = store.texting.open({ phoneHash: hex("a1"), tokenHash, refreshHash: hex("ee"), expiresAt: NOW + TEXTING_TOKEN_MS, at: NOW }, NOW);
  assert.equal(answer.status, "linked");
  return sessionFor(store, tokenHash, NOW + 1);
}

test("a session carries its person's set, none before one is written", { skip }, () => {
  const store = person("user_ada", "ws_ada");
  assert.deepEqual(sessionOf(store, "c1").flags, []);
  assert.deepEqual(store.flags.put({ flags: ["tex.sample", "app.other", "tex.sample"], at: 5 }), { kept: true });
  assert.deepEqual(sessionOf(store, "c2").flags, ["app.other", "tex.sample"]);
});

test("one person's set never reaches another person's session", { skip }, () => {
  const ada = person("user_ada", "ws_ada");
  const bo = person("user_bo", "ws_bo");
  ada.flags.put({ flags: ["tex.sample"], at: 5 });
  assert.deepEqual(sessionOf(bo, "c3").flags, []);
  assert.deepEqual(sessionOf(ada, "c4").flags, ["tex.sample"]);
});

test("a late older set is dropped, and an empty set clears it", { skip }, () => {
  const store = person("user_ada", "ws_ada");
  store.flags.put({ flags: ["tex.sample"], at: 10 });
  assert.deepEqual(store.flags.put({ flags: ["tex.sample", "app.other"], at: 9 }), { kept: false });
  assert.deepEqual(store.flags.ids(), ["tex.sample"]);
  store.flags.put({ flags: [], at: 11 });
  assert.deepEqual(store.flags.ids(), []);
});

test("a malformed set is refused and changes nothing", { skip }, () => {
  const store = person("user_ada", "ws_ada");
  store.flags.put({ flags: ["tex.sample"], at: 10 });
  for (const bad of [
    null,
    { flags: "tex.sample", at: 11 },
    { flags: ["Tex Sample"], at: 11 },
    { flags: [7], at: 11 },
    { flags: ["tex.sample"], at: -1 },
    { flags: Array.from({ length: MAX_PERSON_FLAGS + 1 }, (_, i) => `tex.f${i}`), at: 11 },
  ]) {
    assert.throws(() => store.flags.put(bad), AccessRowRefused);
  }
  assert.deepEqual(store.flags.ids(), ["tex.sample"]);
});

test("the person object answers person.flags.put and get", { skip }, async () => {
  const store = person("user_ada", "ws_ada");
  const rows = { pinWorkspace: () => {} };
  const call = async (op, fields) => await (await servePersonCall({ person: store, rows }, op, { personalWorkspaceId: "ws_ada", ...fields })).json();
  assert.deepEqual(await call(FLAGS_OPS.PUT, { record: { flags: ["tex.sample"], at: 3 } }), { kept: true });
  assert.deepEqual(await call(FLAGS_OPS.GET, {}), { record: { flags: ["tex.sample"], at: 3 } });
  const refused = await servePersonCall({ person: store, rows }, FLAGS_OPS.PUT, { personalWorkspaceId: "ws_ada", record: { flags: ["BAD"], at: 4 } });
  assert.equal(refused.status, 422);
});

const RAW = {
  grantId: "g1",
  clientId: "client_a",
  actorUserId: "user_ada",
  scopes: ["context:read"],
  workspaces: [{ workspaceId: "ws_ada", slug: "ada", role: "owner", kind: "personal" }],
  defaultWorkspaceId: "ws_ada",
};

test("the session payload keeps a well-formed set and reads anything else as none", () => {
  assert.deepEqual(normalizeSession({ ...RAW, flags: ["tex.sample"] }).flags, ["tex.sample"]);
  for (const flags of [undefined, null, "tex.sample", [1], ["no spaces allowed"], Array.from({ length: MAX_PERSON_FLAGS + 1 }, (_, i) => `tex.f${i}`)]) {
    assert.deepEqual(normalizeSession({ ...RAW, flags }).flags, []);
  }
});

test("flagOn is a lookup in the session's set, off for an id not on the list", () => {
  const known = (id) => id === "tex.sample" || id === "app.other";
  const session = { flags: ["tex.sample", "tex.retired"] };
  assert.equal(flagOn(session, "tex.sample", known), true);
  assert.equal(flagOn(session, "app.other", known), false);
  assert.equal(flagOn(session, "tex.retired", known), false, "a launched or removed flag is off whatever a session says");
  assert.equal(flagOn(null, "tex.sample", known), false);
  assert.equal(flagOn({}, "tex.sample", known), false);
  // With the real list, which names no flag yet, everything is off.
  assert.equal(flagOn(session, "tex.sample"), false);
});
