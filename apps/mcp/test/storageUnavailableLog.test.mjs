import test from "node:test";
import assert from "node:assert/strict";
import { storeForSession } from "../src/session.js";
import { StorageUnavailable } from "../src/store/factory.js";
import { ControlPlaneError } from "../src/controlPlane/client.js";

/*
  Every caller answers a store that cannot be opened with the same reasonless
  503, so the reason is logged where it is known or nowhere. Group Tex on
  2026-10-29: every reply in one chat failed for twenty minutes and no log said
  why. The line carries the reason as a code (`agent-logs.yml` prints only codes) and the
  workspace id, never the token.
*/

const SESSION = { workspaceId: "ws_logged", accessToken: "token-not-to-be-logged" };

async function logged(controlPlane) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await assert.rejects(storeForSession(SESSION, {}, controlPlane), StorageUnavailable);
  } finally {
    console.error = original;
  }
  return lines.map((line) => JSON.parse(line)).filter((line) => line.event === "storage_unavailable");
}

test("a control plane that refuses is logged with its status", async () => {
  const lines = await logged({ getStorageBinding: async () => { throw new ControlPlaneError("binding", 500); } });
  assert.deepEqual(lines, [{ event: "storage_unavailable", reason: "control_plane_500", workspace: "ws_logged" }]);
});

test("an inactive binding is logged by its reason, and the token never is", async () => {
  const lines = await logged({ getStorageBinding: async () => ({ binding: { status: "disconnected", workspaceId: "ws_logged" } }) });
  assert.deepEqual(lines, [{ event: "storage_unavailable", reason: "not_active", workspace: "ws_logged" }]);
  assert.ok(!JSON.stringify(lines).includes("token-not-to-be-logged"));
});
