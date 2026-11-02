// The gateway's call that writes Convex behind an object's take-away access write (src/controlPlane/accessMirror.js,
// POST /gateway/access/mirror): the path, the body, the secret, and that a refusal throws so the object never reports
// the change done. Fake ids and a fake secret only.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createControlPlane } from "../src/controlPlane/index.js";

const ORIGIN = "https://control-plane.example.invalid";
const env = { CONTROL_PLANE_URL: ORIGIN, GATEWAY_SECRET: "fake-gateway-secret" };

function recording(status, answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("posts the change with the gateway secret and returns the answer", async () => {
  const { calls, fetchImpl } = recording(200, { applied: true });
  const change = { op: "remove_member", userId: "user1", at: 5, by: "owner1" };
  const answer = await createControlPlane(env, { fetchImpl }).accessMirror("workspace1", change);
  assert.deepEqual(answer, { applied: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/gateway\/access\/mirror$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer fake-gateway-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), { workspaceId: "workspace1", change });
});

test("a refusal throws, so the object retries and never reports it done", async () => {
  const { fetchImpl } = recording(409, { applied: false, refused: "OWNER" });
  await assert.rejects(createControlPlane(env, { fetchImpl }).accessMirror("workspace1", { op: "remove_member", userId: "owner1", at: 5, by: "owner1" }));
});
