import test from "node:test";
import assert from "node:assert/strict";
import {
  accessForLiveGrant,
  SCOPE_CAPTURE,
  SCOPE_PRIVATE,
  SCOPE_READ,
  SCOPE_WRITE,
} from "../src/session.js";

const WORKSPACE = "ws_live";

function grant(overrides = {}) {
  return {
    grantId: "grant_live",
    workspaceId: WORKSPACE,
    scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE],
    role: "owner",
    kind: "personal",
    ...overrides,
  };
}

test("a revoked or cross-workspace grant is refused", () => {
  assert.equal(accessForLiveGrant(null, WORKSPACE), null);
  assert.equal(accessForLiveGrant(grant({ workspaceId: "ws_other" }), WORKSPACE), null);
});

test("malformed granted names fail closed", () => {
  assert.equal(accessForLiveGrant(grant({ grantedNames: ["not a group"] }), WORKSPACE), null);
  assert.equal(accessForLiveGrant(grant({ grantedNames: [42] }), WORKSPACE), null);
});

test("a member cannot inherit write, capture, or private access", () => {
  const access = accessForLiveGrant(grant({ role: "member" }), WORKSPACE);
  assert.deepEqual(access?.scopes, [SCOPE_READ]);
  assert.equal(access?.scope, "team");
});

test("an editor gets only granted write capability and no private escalation", () => {
  const access = accessForLiveGrant(
    grant({ role: "editor", scopes: [SCOPE_READ, SCOPE_WRITE] }),
    WORKSPACE,
  );
  assert.deepEqual(access?.scopes, [SCOPE_READ, SCOPE_WRITE, SCOPE_CAPTURE]);
  assert.equal(access?.scope, "team");
  assert.ok(!access?.scopes.includes(SCOPE_PRIVATE));
});

test("an owner cannot gain scopes the grant did not carry", () => {
  const access = accessForLiveGrant(
    grant({ role: "owner", scopes: [SCOPE_READ] }),
    WORKSPACE,
  );
  assert.deepEqual(access?.scopes, [SCOPE_READ]);
  assert.equal(access?.scope, "team");
});

test("only explicit console group names become granted groups", () => {
  const access = accessForLiveGrant(
    grant({ grantedNames: ["@Editors", "writers"] }),
    WORKSPACE,
  );
  assert.deepEqual([...access.grantedGroups].sort(), ["@editors", "@writers"]);
  assert.equal(access.grantedGroups.has("@admins"), false);
});
