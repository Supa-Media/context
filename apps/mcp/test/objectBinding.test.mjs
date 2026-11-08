// A request's binding from its workspace's object (`store/objectBinding.js`, `workspaceStore/bindingRows.js`,
// `workspaceStore/bindingSeal.js`): one object call instead of the control plane's `/gateway/binding`, and every
// way it must refuse and ask the control plane instead: another workspace's sealed binding, another secret, a
// removed member, a guest or chat reader, a workspace whose keying is unknown or contradicted, a change still behind, a stale copy, and a change made
// while the control plane was being asked.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { bindingRows } from "../src/workspaceStore/bindingRows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { openBinding, sealBinding } from "../src/workspaceStore/bindingSeal.js";
import { FRESH_MS, SERVE_STALE_MS, openedFromObject } from "../src/store/objectBinding.js";
import { READS_AS_CHAT, READS_AS_GUEST } from "../src/privacy/engine.js";

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

function namespace() {
  const objects = new Map();
  return {
    stores: objects,
    idFromName: (name) => ({ name }),
    get(id) {
      if (!objects.has(id.name)) {
        const sql = durableSql();
        const store = { objects: texObjects(sql), rows: workspaceRows(sql), members: workspaceMembers(sql), binding: bindingRows(sql), marks: workspaceMarks(sql) };
        objects.set(id.name, { store, fetch: (request) => serveWorkspaceStore(store, request) });
      }
      return objects.get(id.name);
    },
  };
}

const SECRET = "gateway-secret-for-tests-only-0123456789";
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "", visibility: "team" }], notes: [] };
const MEMBER = { userId: "user_a", personalWorkspaceId: "ws_pa", role: "editor", groups: [], at: 1 };

function answerFor(workspaceId, extra = {}) {
  return {
    binding: {
      workspaceId,
      provider: "r2",
      bucket: `bucket-${workspaceId}`,
      accessKeyId: `key-${workspaceId}`,
      secretAccessKey: `secret-${workspaceId}`,
      capabilities: { conditionalWrite: true },
      notesHome: "object",
      status: "active",
    },
    searchIndex: null,
    meaningIndex: null,
    encryptionKey: null,
    rotation: null,
    noteCap: 1000,
    managedEncryption: null,
    privacy: RULES,
    idLayout: "keys",
    keyed: true,
    ...extra,
  };
}

/** A workspace whose object holds its notes and decides access, with `user_a` a member. */
async function world({ workspaceId = "ws_one", behind = false } = {}) {
  const ns = namespace();
  const env = { WORKSPACE_STORE: ns, GATEWAY_SECRET: SECRET };
  const client = workspaceClient(env, workspaceId);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(RULES, "member");
  const object = ns.get(ns.idFromName(`workspace:${workspaceId}`));
  object.store.members.put("members", [MEMBER]);
  object.store.members.setHome("object");
  const calls = { binding: 0, behind: 0 };
  const controlPlane = {
    behind,
    /** What the control plane's answer carries beyond the plain one: a data key, managed encryption. */
    extra: {},
    objectBehind: async () => {
      calls.behind += 1;
      return controlPlane.behind;
    },
    getStorageBinding: async () => {
      calls.binding += 1;
      return answerFor(workspaceId, controlPlane.extra);
    },
  };
  const session = { workspaceId, actorUserId: "user_a", scope: "team", grantedGroups: [], accessToken: "token" };
  return { ns, env, client, object, controlPlane, calls, session, workspaceId };
}

/** What `sessionStore.js` does: the object first, else the control plane, then kept. */
async function open(w, session = w.session, now = Date.now) {
  const first = await openedFromObject(session, w.env, w.controlPlane, { now });
  if (first.opened !== null) return { source: "object", opened: first.opened, reason: first.reason, refresh: first.refresh };
  const opened = await w.controlPlane.getStorageBinding();
  const kept = typeof first.keep === "function" ? await first.keep(opened) : null;
  return { source: "control_plane", opened, reason: first.reason, kept };
}

test("the second request opens its binding from the object, with the object's rules and no control-plane binding call", { skip }, async () => {
  const w = await world();
  const first = await open(w);
  assert.equal(first.source, "control_plane");
  assert.equal(first.reason, "none_kept");
  assert.deepEqual(first.kept, { kept: true, reason: null });
  const second = await open(w);
  assert.equal(second.source, "object");
  assert.equal(w.calls.binding, 1, "the control plane's binding was asked once, for the first request only");
  assert.deepEqual(second.opened.binding, answerFor("ws_one").binding);
  assert.deepEqual(second.opened.privacy, RULES);
  assert.equal(second.opened.idLayout, "keys");
  assert.equal(second.opened.noteCap, 1000);
  assert.equal(second.opened.keyed, true);
});

test("the object keeps only sealed text: no credential is readable in its storage", { skip }, async () => {
  const w = await world();
  await open(w);
  const kept = w.object.store.binding.get();
  assert.match(kept.sealed, /^v1\./);
  assert.equal(kept.sealed.includes("secret-ws_one"), false);
  assert.equal(Buffer.from(kept.sealed.split(".")[2], "base64url").toString("latin1").includes("secret-ws_one"), false);
  const value = await openBinding(kept.sealed, { secret: SECRET, workspaceId: "ws_one" });
  assert.equal(value.binding.secretAccessKey, "secret-ws_one");
  assert.equal("privacy" in value, false, "the rules are read live from the object, never from the kept copy");
});

test("ATTACK: another workspace's sealed binding copied into this object does not open, and the control plane is asked", { skip }, async () => {
  const w = await world();
  await open(w);
  const theirs = await sealBinding(answerFor("ws_two"), { secret: SECRET, workspaceId: "ws_two" });
  const { epoch } = w.object.store.binding.get();
  w.object.store.binding.put({ sealed: theirs, at: Date.now(), epoch });
  const next = await open(w);
  assert.equal(next.source, "control_plane");
  assert.equal(next.reason, "seal_refused");
  assert.equal(next.opened.binding.workspaceId, "ws_one");
});

test("ATTACK: a binding sealed for this workspace that names another inside is refused", { skip }, async () => {
  const w = await world();
  await open(w);
  const forged = await sealBinding(answerFor("ws_two"), { secret: SECRET, workspaceId: "ws_one" });
  const { epoch } = w.object.store.binding.get();
  w.object.store.binding.put({ sealed: forged, at: Date.now(), epoch });
  const next = await open(w);
  assert.equal(next.source, "control_plane");
  assert.equal(next.reason, "kept_not_usable");
});

test("ATTACK: a binding sealed under another secret does not open", { skip }, async () => {
  const w = await world();
  await open(w);
  const other = await sealBinding(answerFor("ws_one"), { secret: "another-secret-entirely-0123456789", workspaceId: "ws_one" });
  const { epoch } = w.object.store.binding.get();
  w.object.store.binding.put({ sealed: other, at: Date.now(), epoch });
  assert.equal((await open(w)).reason, "seal_refused");
});

test("ATTACK: a removed member gets neither the rules nor the sealed binding, and the control plane decides", { skip }, async () => {
  const w = await world();
  await open(w);
  assert.equal((await open(w)).source, "object");
  w.object.store.members.remove("members", ["user_a"], 2);
  const raw = await w.client.open("user_a");
  assert.equal(raw.member, false);
  assert.equal(raw.rules, null);
  assert.equal(raw.binding, null);
  const next = await open(w);
  assert.equal(next.source, "control_plane");
  assert.equal(next.reason, "not_a_member");
  assert.equal(next.kept, null, "nothing is kept for a reader who is not a member");
  const stranger = await w.client.open("user_x");
  assert.equal(stranger.binding, null);
});

test("where the control plane still decides access, the object answers no binding to anybody", { skip }, async () => {
  const w = await world();
  await open(w);
  w.object.store.members.setHome("convex");
  const raw = await w.client.open("user_a");
  assert.equal(raw.member, false);
  assert.equal(raw.binding, null);
  assert.equal((await open(w)).reason, "access_not_in_object");
});

test("ATTACK: a guest, a Tex chat, Tex's setup read and a session naming nobody are never served from the object", { skip }, async () => {
  const w = await world();
  await open(w);
  const cases = [
    [{ ...w.session, grantedGroups: [READS_AS_GUEST] }, "not_member_audience"],
    [{ ...w.session, grantedGroups: [READS_AS_CHAT, "@crew"] }, "not_member_audience"],
    // Tex's setup read is its own question of the pin's object (`objectBindingSetupRead.test.mjs`): never a session that is not Tex's, or not the pin.
    [{ ...w.session, setupRead: true }, "setup_read_client"],
    [{ ...w.session, setupRead: true, actorClientId: "context_texts", role: "member", workspaceSlug: "someone" }, "setup_read_not_pin"],
    [{ ...w.session, texChatId: "a".repeat(64) }, "tex_chat"],
    [{ ...w.session, actorUserId: undefined }, "no_reader"],
    [{ ...w.session, scope: "public" }, "no_scope"],
  ];
  for (const [session, reason] of cases) {
    const answer = await openedFromObject(session, w.env, w.controlPlane);
    assert.equal(answer.opened, null);
    assert.equal(answer.reason, reason);
    assert.equal(answer.keep, undefined, `nothing kept for ${reason}`);
  }
});

test("a change still coming (an open mark in the object) sends the request to the control plane, which is not asked otherwise", { skip }, async () => {
  const w = await world();
  await open(w);
  const served = await open(w);
  assert.equal(served.source, "object");
  assert.equal(w.calls.behind, 0, "the control plane is not asked whether the object is behind");
  // A writer that may narrow opened a mark and its push never came: the object answers behind after its wait.
  w.object.store.marks.open("mark-behind-01");
  const next = await open(w);
  assert.equal(next.source, "control_plane");
  assert.equal(next.reason, "behind");
  assert.equal(w.calls.behind, 0);
});

test("switched back on, the control plane's behind question is asked beside the object again", { skip }, async () => {
  const w = await world();
  w.env.OBJECT_BEHIND_FROM_CONTROL_PLANE = "on";
  await open(w);
  assert.equal((await open(w)).source, "object");
  w.controlPlane.behind = true;
  const next = await open(w);
  assert.equal(next.reason, "behind");
  w.controlPlane.objectBehind = async () => {
    throw new Error("down");
  };
  assert.equal((await open(w)).reason, "behind", "a behind question that fails reads as behind");
  assert.ok(w.calls.behind >= 1);
});

const DATA_KEY = { current: "g2", keys: { g1: "data-key-one", g2: "data-key-two" } };

test("a keyed workspace's data key is kept in the seal and served from the object, never readable in its storage", { skip }, async () => {
  const w = await world();
  await w.client.setEncryption("keyed");
  w.controlPlane.extra = { encryptionKey: DATA_KEY, managedEncryption: { mode: "encrypted" } };
  const first = await open(w);
  assert.equal(first.reason, "none_kept");
  assert.deepEqual(first.kept, { kept: true, reason: null });
  const second = await open(w);
  assert.equal(second.source, "object");
  assert.deepEqual(second.opened.encryptionKey, DATA_KEY);
  assert.deepEqual(second.opened.managedEncryption, { mode: "encrypted" });
  const sealed = w.object.store.binding.get().sealed;
  for (const plain of ["data-key-one", "data-key-two"]) {
    assert.equal(sealed.includes(plain), false);
    assert.equal(Buffer.from(sealed.split(".")[2], "base64url").toString("latin1").includes(plain), false);
  }
});

test("ATTACK: a keyed workspace answered with no key (a key that would not open) is never kept or served", { skip }, async () => {
  const w = await world();
  await w.client.setEncryption("keyed");
  const first = await open(w);
  assert.deepEqual(first.kept, { kept: false, reason: "not_keepable" });
  assert.equal((await open(w)).source, "control_plane");
  // A copy kept while the workspace was unkeyed is not served once the object says it is keyed.
  const v = await world({ workspaceId: "ws_two" });
  await open(v);
  await v.client.setEncryption("keyed");
  assert.equal((await open(v)).reason, "kept_not_usable");
});

test("ATTACK: an unkeyed workspace answered with a key is never kept", { skip }, async () => {
  const w = await world();
  w.controlPlane.extra = { encryptionKey: DATA_KEY };
  assert.deepEqual((await open(w)).kept, { kept: false, reason: "not_keepable" });
});

test("a workspace whose object does not know its keying, or whose notes are not in the object, always asks", { skip }, async () => {
  const w = await world();
  w.object.store.rows.encryption = () => null;
  assert.equal((await open(w)).reason, "encryption_unknown");
  assert.equal((await open(w)).reason, "encryption_unknown");
  const v = await world({ workspaceId: "ws_two" });
  await open(v);
  await v.client.setHome("dual");
  assert.equal((await open(v)).reason, "notes_not_in_object");
});

test("a binding older than FRESH_MS is served from the object and refreshed behind, and stale past SERVE_STALE_MS", { skip }, async () => {
  const w = await world();
  await open(w);
  // A clock the test can move: `now` is what the gateway reads, and a refresh stamps the moment it is called.
  const clock = { shift: 0 };
  const now = () => Date.now() + clock.shift;
  clock.shift = FRESH_MS + 1;
  const served = await open(w, w.session, now);
  assert.equal(served.source, "object");
  assert.equal(served.reason, "stale_served");
  assert.equal(typeof served.refresh, "function");
  assert.equal(w.calls.binding, 1, "the control plane is not asked for a copy that is served");
  clock.shift = 0;
  assert.deepEqual(await served.refresh(answerFor("ws_one")), { kept: true, reason: null });
  const fresh = await open(w);
  assert.equal(fresh.source, "object");
  assert.equal(fresh.reason, null);
  // A refresh stamped 5 min ahead of the clock is not trusted: the control plane is asked, and keeps its answer again.
  clock.shift = 5 * 60 * 1000;
  assert.deepEqual(await served.refresh(answerFor("ws_one")), { kept: true, reason: null });
  clock.shift = 0;
  const ahead = await open(w);
  assert.equal(ahead.source, "control_plane");
  assert.equal(ahead.reason, "stale", "a copy stamped ahead of the clock is not trusted");
  assert.equal(ahead.kept.kept, true);
  // Past SERVE_STALE_MS the copy is not served at all.
  clock.shift = SERVE_STALE_MS + 1;
  const old = await open(w, w.session, now);
  assert.equal(old.source, "control_plane");
  assert.equal(old.reason, "stale");
  assert.equal(old.kept.kept, true);
  assert.equal(w.calls.binding, 3);
});

test("ATTACK: a temporary credential is never served past FRESH_MS, and the control plane is asked", { skip }, async () => {
  const w = await world();
  w.controlPlane.extra = { binding: { ...answerFor("ws_one").binding, sessionToken: "temp-token" } };
  const first = await open(w);
  assert.equal(first.reason, "none_kept");
  assert.deepEqual(first.kept, { kept: true, reason: null });
  const later = () => Date.now() + FRESH_MS + 1;
  const next = await open(w, w.session, later);
  assert.equal(next.source, "control_plane");
  assert.equal(next.reason, "stale");
  assert.equal(next.kept.kept, true);
  assert.equal(w.calls.binding, 2);
});

test("a clear while the control plane was being asked: the answer read before it is not kept", { skip }, async () => {
  const w = await world();
  const first = await openedFromObject(w.session, w.env, w.controlPlane);
  assert.equal(first.reason, "none_kept");
  // The control plane changed the binding and its push cleared the object's copy after the epoch was read.
  await w.client.binding.clear();
  const kept = await first.keep(answerFor("ws_one"));
  assert.deepEqual(kept, { kept: false, reason: "epoch_moved" });
  assert.equal(w.object.store.binding.get().sealed, null);
});

test("a clear drops the kept binding, and the next request asks the control plane", { skip }, async () => {
  const w = await world();
  await open(w);
  assert.equal((await open(w)).source, "object");
  await w.client.binding.clear();
  const next = await open(w);
  assert.equal(next.reason, "none_kept");
  assert.equal(w.calls.binding, 2);
});

test("an answer carrying a key the object does not expect, a rotation, managed encryption moving, or a behind mark is never kept", { skip }, async () => {
  for (const extra of [
    { encryptionKey: { current: "g1", keys: { g1: "k" } } },
    { rotation: { fromGeneration: "g1", toGeneration: "g2" } },
    { managedEncryption: { mode: "migrating" } },
    { managedEncryption: { mode: "decrypting" } },
    { binding: { ...answerFor("ws_one").binding, notesBehind: true } },
    { binding: { ...answerFor("ws_one").binding, notesHome: "dual" } },
    { binding: { ...answerFor("ws_one").binding, workspaceId: "ws_two" } },
  ]) {
    const w = await world();
    const first = await openedFromObject(w.session, w.env, w.controlPlane);
    const kept = await first.keep({ ...answerFor("ws_one"), ...extra });
    assert.deepEqual(kept, { kept: false, reason: "not_keepable" }, JSON.stringify(extra));
    assert.equal(w.object.store.binding.get().sealed, null);
  }
});

test("switched off, the object is never asked", { skip }, async () => {
  const w = await world();
  await open(w);
  const answer = await openedFromObject(w.session, { ...w.env, BINDING_FROM_OBJECT: "off" }, w.controlPlane);
  assert.equal(answer.reason, "switched_off");
});

test("the object refuses a put that is not a sealed binding", { skip }, async () => {
  const w = await world();
  await assert.rejects(() => w.client.binding.put({ sealed: "plain text", at: Date.now(), epoch: 0 }));
  await assert.rejects(() => w.client.binding.put({ sealed: "v1.a.b", at: Date.now(), epoch: -1 }));
  await assert.rejects(() => w.client.binding.put({ sealed: `v1.a.${"b".repeat(70_000)}`, at: Date.now(), epoch: 0 }));
});

test("ATTACK: the control plane's door refuses ws.open and ws.binding.put, and lets a clear through", { skip }, async () => {
  const { handleWorkspaceStoreDoor } = await import("../src/workspaceStore/door.js");
  const w = await world();
  await open(w);
  const door = async (op, fields = {}) =>
    await handleWorkspaceStoreDoor(
      new Request("https://gateway.test/internal/workspace-store", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "x-workspace-ticket": "ticket", "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
        body: JSON.stringify(fields),
      }),
      w.env,
      { controlPlane: { openTexStoreTicket: async () => ({ workspaceId: "ws_one", owners: [] }) } },
    );
  assert.equal((await door("ws.open", { userId: "user_a" })).status, 403);
  assert.equal((await door("ws.binding.put", { sealed: "v1.a.b", at: Date.now(), epoch: 0 })).status, 403);
  assert.notEqual(w.object.store.binding.get().sealed, null);
  const cleared = await door("ws.binding.clear");
  assert.equal(cleared.status, 200);
  assert.equal(w.object.store.binding.get().sealed, null);
});

test("an open served from the object says how it answered: how long it waited for a mark's push", { skip }, async () => {
  const w = await world();
  await open(w);
  const served = await openedFromObject(w.session, w.env, w.controlPlane);
  assert.equal(served.source, "object");
  assert.equal(served.wake.cold, false, "the test object is not a woken instance");
  assert.equal(typeof served.wake.waitedMs, "number");
});
