/**
 * The gateway's `setAccess` body (`controlPlane/privacy.js`): a tier names no `grantees`, so the control plane keeps
 * the owner's list. Sending `grantees: []` for a tier would clear the people the owner named.
 *
 * Sabotage: put `grantees: []` back into the body and "a tier sends no grantees" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyMethods } from "../../src/controlPlane/privacy.js";

function authorityRecording(calls) {
  const post = async (path, body) => {
    calls.push({ path, body });
    return { ok: true, version: 1 };
  };
  return createPrivacyMethods({ post }).privacyAuthority({ accessToken: "token-not-real" }, "ws-test", null);
}

test("a tier sends no grantees, so the control plane keeps the owner's list", async () => {
  const calls = [];
  await authorityRecording(calls).setAccess({ path: "1-projects", base: "team", expectedVersion: 3, kind: "folder" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/gateway/privacy");
  assert.equal(calls[0].body.op, "setAccess");
  assert.equal("grantees" in calls[0].body, false);
  assert.equal(calls[0].body.base, "team");
  assert.equal(calls[0].body.expectedVersion, 3);
});

test("a list given by the caller is sent as it was given, and an empty one is sent as an empty one", async () => {
  const calls = [];
  const authority = authorityRecording(calls);
  const grantees = [{ kind: "email", email: "kola@example.test", role: "view" }];
  await authority.setAccess({ path: "1-projects/a.md", base: "private", grantees });
  await authority.setAccess({ path: "1-projects/a.md", base: "private", grantees: [] });
  assert.deepEqual(calls[0].body.grantees, grantees);
  assert.deepEqual(calls[1].body.grantees, []);
});
