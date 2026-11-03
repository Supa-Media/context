// A tier-only access change in an object-home workspace goes to the object's `ws.write.access` first
// (`src/store/objectAccess.js`); the control plane's `setAccess` answers only what the object cannot decide.
//
// Sabotage, each confirmed to fail a case here: drop the `home !== OBJECT` guard (a bucket-home workspace calls the
// object), answer NOT_READY/NO_ROW without the control plane, pass a grantee list to the object, drop the owner|editor
// check so a member reaches the object, or treat MIRROR_PENDING as ok.
import assert from "node:assert/strict";
import { test } from "node:test";

import { objectFirstSetAccess } from "../src/store/objectAccess.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const WS = "w1";
const CHANGE = { path: "plans/a.md", base: "team", expectedVersion: 7 };
const ACTOR = { userId: "u1", clientId: "client-1" };

/** The object's client: `answer` is what `ws.write.access` returns, or an Error to throw (unreachable). */
function objectClient(answer) {
  const asked = [];
  return {
    asked,
    write: {
      access: async (fields) => {
        asked.push(fields);
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(fields) : answer;
      },
    },
  };
}

/** The control plane's `setAccess`, which answers `{ok: true, version: 9}`. */
function controlPlane(answer = { ok: true, version: 9 }) {
  const asked = [];
  const setAccess = async (change) => {
    asked.push(change);
    return answer;
  };
  return { asked, setAccess };
}

const wire = ({ client, home = "object", role = "editor", canWrite = true, control }) =>
  objectFirstSetAccess(control.setAccess, { client, home, role, canWrite, userId: ACTOR.userId, clientId: ACTOR.clientId, workspaceId: WS });

test("an object that decides the tier answers it alone, with the version it minted", async () => {
  const control = controlPlane();
  const object = objectClient({ ok: true, version: 12 });
  const setAccess = wire({ client: object, control });
  assert.deepEqual(await setAccess(CHANGE), { ok: true, version: 12 });
  assert.deepEqual(control.asked, [], "no control-plane call");
  assert.deepEqual(object.asked, [{ path: "plans/a.md", base: "team", expectedVersion: 7, actor: { role: "editor", userId: "u1", clientId: "client-1" } }]);
});

test("NOT_READY and NO_ROW are the control plane's, called with the same change as before", async () => {
  for (const code of ["NOT_READY", "NO_ROW"]) {
    const control = controlPlane({ ok: true, version: 9 });
    const object = objectClient({ ok: false, code });
    const answer = await wire({ client: object, control })(CHANGE);
    assert.deepEqual(answer, { ok: true, version: 9 }, code);
    assert.equal(control.asked.length, 1, code);
    assert.equal(control.asked[0], CHANGE, `${code}: the same change object reaches the control plane`);
  }
});

test("an unreachable object falls back to the control plane with the same change", async () => {
  const control = controlPlane();
  const answer = await wire({ client: objectClient(new Error("network")), control })(CHANGE);
  assert.deepEqual(answer, { ok: true, version: 9 });
  assert.equal(control.asked[0], CHANGE);
});

test("a refusal from the object passes through with its code and no control-plane call", async () => {
  for (const code of ["FORBIDDEN", "NOT_FOUND", "INVALID"]) {
    const control = controlPlane();
    const answer = await wire({ client: objectClient({ ok: false, code }), control })(CHANGE);
    assert.deepEqual(answer, { ok: false, code }, code);
    assert.deepEqual(control.asked, [], code);
  }
});

test("CONFLICT passes through with the object's version; setRowTier retries once without the version, on the object", async () => {
  const control = controlPlane();
  const object = objectClient((fields) => (fields.expectedVersion === undefined ? { ok: true, version: 13 } : { ok: false, code: "CONFLICT", version: 12 }));
  const store = withPrivacyAuthority(createMemoryStore(), {
    rules: { etag: "rows-v1", accessVersion: 7, folders: [], notes: [] },
    setAccess: wire({ client: object, control }),
    addGrantees: async () => ({ ok: false }),
  });
  await store.rowAccess.setTier("plans/a.md", "team");
  assert.equal(object.asked.length, 2, "one CONFLICT, one retry");
  assert.equal(object.asked[0].expectedVersion, 7);
  assert.equal(object.asked[1].expectedVersion, undefined);
  assert.deepEqual(control.asked, [], "the control plane is not asked for a CONFLICT retry either");
});

test("MIRROR_PENDING (503) is a failure code the caller can retry, never an ok", async () => {
  const control = controlPlane();
  const answer = await wire({ client: objectClient({ ok: false, code: "MIRROR_PENDING" }), control })({ ...CHANGE, base: "private" });
  assert.deepEqual(answer, { ok: false, code: "MIRROR_PENDING" });
  assert.deepEqual(control.asked, [], "the change is committed in the object; the control plane is not asked to repeat it");
});

test("a bucket or dual home never calls the object", async () => {
  for (const home of ["bucket", "dual", null]) {
    const control = controlPlane();
    const object = objectClient({ ok: true, version: 12 });
    const answer = await wire({ client: object, home, control })(CHANGE);
    assert.deepEqual(answer, { ok: true, version: 9 }, String(home));
    assert.deepEqual(object.asked, [], String(home));
  }
});

test("a member, or a write without context:write, never reaches the object", async () => {
  const control = controlPlane();
  const object = objectClient({ ok: true, version: 12 });
  const answer = await wire({ client: object, role: "member", canWrite: false, control })(CHANGE);
  assert.deepEqual(answer, { ok: true, version: 9 });
  assert.deepEqual(object.asked, []);
  assert.equal(control.asked[0], CHANGE);
});

test("a grantee list stays on the control plane", async () => {
  const control = controlPlane();
  const object = objectClient({ ok: true, version: 12 });
  const change = { ...CHANGE, grantees: [] };
  await wire({ client: object, control })(change);
  assert.deepEqual(object.asked, []);
  assert.equal(control.asked[0], change);
});

test("with no object client the control plane's setAccess is returned as it was", () => {
  const control = controlPlane();
  assert.equal(objectFirstSetAccess(control.setAccess, { client: null, home: "object", role: "owner", canWrite: true, workspaceId: WS }), control.setAccess);
});
