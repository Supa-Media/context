// `objectFirstAddGrantees` (src/store/objectAccess.js): people added to a row's list by handle or address, written in the
// workspace object first (`ws.write.access` with `mode: "add"`), with a handle the object has not been told resolved
// by the control plane once (`resolveHandles`) and the answer sent back with the write. Proves: a cached handle is one
// object call; RESOLVE then resolved is two object calls; a handle nobody holds is GRANTEE_NOT_FOUND with nothing more
// written; NOT_READY falls back to the control plane with the same change; a non-owner, a no-write caller or a mixed
// entry never reaches the object; a malformed address goes to the control plane, a valid one is lower-cased; a throwing
// client falls back and logs no path or handle; without the object's home or the resolver, the control plane's
// function is returned as it was.
import assert from "node:assert/strict";
import { test } from "node:test";

import { HOMES } from "../src/workspaceStore/api.js";
import { objectFirstAddGrantees } from "../src/store/objectAccess.js";

const WS = "w1";
const ACTOR = { userId: "u1", clientId: "client-1" };
const PATH = "projects/plan.md";

/** The object's client: `answers` is a queue of what `ws.write.access` returns (or an Error to throw), in call order. */
function objectClient(...answers) {
  const asked = [];
  return {
    asked,
    write: {
      access: async (fields) => {
        asked.push(structuredClone(fields));
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

/** The control plane's `addGrantees`, answering `{ok: true, version: 9}` unless told otherwise. */
function controlAdd(answer = { ok: true, version: 9 }) {
  const asked = [];
  const addGrantees = async (change) => {
    asked.push(change);
    return answer;
  };
  return { asked, addGrantees };
}

/** The control plane's `resolveHandles`: `resolved` is what it answers, `[{handle, grantee}]`. */
function controlResolve(resolved) {
  const asked = [];
  const resolveHandles = async (handles) => {
    asked.push(handles);
    return { ok: true, resolved };
  };
  return { asked, resolveHandles };
}

// A resolver is always passed by default: with none, the object path is off (asserted in the last test), which would
// make the object-path cases below pass for the wrong reason.
const wire = ({ client, home = HOMES.OBJECT, role = "owner", canWrite = true, add, resolve = controlResolve([]), log }) =>
  objectFirstAddGrantees(add.addGrantees, resolve.resolveHandles, {
    client,
    home,
    role,
    canWrite,
    userId: ACTOR.userId,
    clientId: ACTOR.clientId,
    workspaceId: WS,
    ...(log ? { log } : {}),
  });

test("a cached handle is one object call and no control-plane call", async () => {
  const add = controlAdd();
  const resolve = controlResolve([]);
  const object = objectClient({ ok: true, version: 8 });
  const answer = await wire({ client: object, add, resolve })({ path: PATH, entries: [{ handle: "@ana", role: "view" }] });
  assert.deepEqual(answer, { ok: true, version: 8 });
  assert.deepEqual(object.asked, [
    { path: PATH, mode: "add", handles: [{ handle: "@ana", role: "view" }], actor: { role: "owner", userId: "u1", clientId: "client-1" } },
  ]);
  assert.deepEqual(resolve.asked, []);
  assert.deepEqual(add.asked, []);
});

test("RESOLVE, then resolved: the control plane's answer is sent back, and the second object call carries it", async () => {
  const add = controlAdd();
  const resolve = controlResolve([{ handle: "@ana", grantee: { kind: "user", id: "user-ana" } }]);
  const object = objectClient({ ok: false, code: "RESOLVE", handles: ["@ana"] }, { ok: true, version: 9 });
  const answer = await wire({ client: object, add, resolve })({ path: PATH, entries: [{ handle: "@ana", role: "view" }] });
  assert.deepEqual(answer, { ok: true, version: 9 });
  assert.deepEqual(resolve.asked, [["@ana"]]);
  assert.equal(object.asked.length, 2);
  assert.equal(object.asked[0].resolved, undefined, "the first call asks without a resolution");
  assert.deepEqual(object.asked[1].resolved, [{ handle: "@ana", kind: "user", id: "user-ana" }]);
  assert.deepEqual(object.asked[1].handles, [{ handle: "@ana", role: "view" }]);
  assert.deepEqual(add.asked, []);
});

test("a handle nobody holds is GRANTEE_NOT_FOUND: no second object call, no control add", async () => {
  const add = controlAdd();
  const resolve = controlResolve([{ handle: "@nobody", grantee: null }]);
  const object = objectClient({ ok: false, code: "RESOLVE", handles: ["@nobody"] });
  const answer = await wire({ client: object, add, resolve })({ path: PATH, entries: [{ handle: "@nobody", role: "edit" }] });
  assert.deepEqual(answer, { ok: false, code: "GRANTEE_NOT_FOUND" });
  assert.equal(object.asked.length, 1, "only the first, unresolved call");
  assert.deepEqual(add.asked, []);
});

test("NOT_READY from the object falls back to the control plane with the original change", async () => {
  const add = controlAdd({ ok: true, version: 11 });
  const object = objectClient({ ok: false, code: "NOT_READY" });
  const change = { path: PATH, entries: [{ email: "ana@example.com", role: "view" }] };
  const answer = await wire({ client: object, add })(change);
  assert.deepEqual(answer, { ok: true, version: 11 });
  assert.equal(add.asked.length, 1);
  assert.equal(add.asked[0], change, "the same change object reaches the control plane");
});

test("a non-owner, a caller without context:write, or a mixed entry goes straight to the control plane", async () => {
  const cases = [
    { role: "editor", canWrite: true, entries: [{ handle: "@ana", role: "view" }] },
    { role: "owner", canWrite: false, entries: [{ handle: "@ana", role: "view" }] },
    { role: "owner", canWrite: true, entries: [{ handle: "@ana", email: "ana@example.com", role: "view" }] },
  ];
  for (const { role, canWrite, entries } of cases) {
    const add = controlAdd();
    const resolve = controlResolve([]);
    const object = objectClient({ ok: true, version: 8 });
    const change = { path: PATH, entries };
    const answer = await wire({ client: object, role, canWrite, add, resolve })(change);
    assert.deepEqual(answer, { ok: true, version: 9 }, JSON.stringify({ role, canWrite, entries }));
    assert.deepEqual(object.asked, [], JSON.stringify({ role, canWrite, entries }));
    assert.equal(add.asked[0], change);
  }
});

test("a malformed address goes straight to the control plane; a valid one is sent lower-cased as an email grantee", async () => {
  const bad = controlAdd();
  const badChange = { path: PATH, entries: [{ email: "not-an-email", role: "view" }] };
  const badObject = objectClient({ ok: true, version: 8 });
  await wire({ client: badObject, add: bad })(badChange);
  assert.deepEqual(badObject.asked, []);
  assert.equal(bad.asked[0], badChange);

  const good = controlAdd();
  const goodObject = objectClient({ ok: true, version: 10 });
  const answer = await wire({ client: goodObject, add: good })({ path: PATH, entries: [{ email: " Ana.Lee@Example.com ", role: "edit" }] });
  assert.deepEqual(answer, { ok: true, version: 10 });
  assert.equal(goodObject.asked.length, 1);
  assert.deepEqual(goodObject.asked[0].grantees, [{ kind: "email", id: "ana.lee@example.com", role: "edit" }]);
  assert.equal(goodObject.asked[0].handles, undefined);
  assert.deepEqual(good.asked, []);
});

test("a client that throws falls back to the control plane, and the log carries no path or handle", async () => {
  const add = controlAdd({ ok: true, version: 12 });
  const logged = [];
  const log = (event, fields) => logged.push({ event, fields });
  const object = objectClient(new TypeError("secret-path-x handle @secretname leaked"));
  const change = { path: "secret-path-x.md", entries: [{ handle: "@secretname", role: "view" }] };
  const answer = await wire({ client: object, add, log })(change);
  assert.deepEqual(answer, { ok: true, version: 12 });
  assert.equal(add.asked[0], change);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, "workspace_object_people_failed");
  assert.equal(logged[0].fields.error, "TypeError");
  const text = JSON.stringify(logged[0].fields);
  assert.equal(text.includes("secret-path-x"), false, text);
  assert.equal(text.includes("secretname"), false, text);
});

test("without the object's home or the resolver, the control plane's function is returned as it was", () => {
  const add = controlAdd();
  const resolve = controlResolve([]);
  const object = objectClient({ ok: true, version: 8 });
  for (const home of [HOMES.BUCKET, HOMES.DUAL, null]) {
    assert.equal(
      objectFirstAddGrantees(add.addGrantees, resolve.resolveHandles, { client: object, home, role: "owner", canWrite: true, workspaceId: WS }),
      add.addGrantees,
      String(home),
    );
  }
  assert.equal(
    objectFirstAddGrantees(add.addGrantees, null, { client: object, home: HOMES.OBJECT, role: "owner", canWrite: true, workspaceId: WS }),
    add.addGrantees,
    "no resolver",
  );
});
