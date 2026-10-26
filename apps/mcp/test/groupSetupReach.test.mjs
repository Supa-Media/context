/**
 * A GROUP CHAT READS TEX'S SETUP IN THE PIN, AND NOTHING ELSE THERE.
 *
 * The control plane gives a group chat's grant its one workspace and, since
 * 2026-10-26, the pin marked `setupOnly` (`apps/convex/.../liveGrants.ts`), so
 * the turn runs on `ai/production/texting-assistant.md` like a 1:1 text. Before
 * that, every group turn silently ran on the built-in words: 5 pages a turn,
 * no picture section, none of the setup's rules.
 *
 * What must hold: the pin is not in `workspaces`, so no tool argument, URL or
 * orient listing reaches it; `sessionForSetup` opens it read-only; and the
 * flag is honoured for the group client only.
 *
 * Sabotage record (local edits, reverted):
 * 1. `normalizeSession` keeps setup-only rows in `workspaces`: 2 tests failed
 *    (listed and addressable; a 1:1 grant's listing).
 * 2. `sessionForSetup` keeps the clamped write scope: 1 failed (the editor row).
 * 3. The client check dropped: 1 failed (a 1:1 grant gets a setup door).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSession, sessionForContext, sessionForSetup, SCOPE_WRITE } from "../src/session.js";
import { contextsFor } from "../src/context/identity.js";

const TOKEN = `cat_group_setup_${"0".repeat(24)}`;

function controlPlane(clientId, pinRole = "member") {
  return {
    async resolveSession() {
      return {
        grantId: "grant_group",
        clientId,
        actorUserId: "user_group",
        scopes: ["context:read", "context:write"],
        defaultWorkspaceId: "ws_chat",
        workspaces: [
          { workspaceId: "ws_chat", slug: "studio", role: "editor", kind: "shared" },
          { workspaceId: "ws_pin", slug: "context-lc", role: pinRole, kind: "shared", grantedNames: ["pin-readers"], setupOnly: true },
        ],
      };
    },
  };
}

test("a group chat's pin is kept out of everything a tool or URL can address", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane("context_texts_group"));
  assert.deepEqual(session.workspaces.map((entry) => entry.slug), ["studio"], "only the chat's workspace is listed");
  assert.throws(() => sessionForContext(session, "@context-lc"), (error) => error.status === 403, "a context argument cannot name it");
  assert.deepEqual(contextsFor(session).map((entry) => entry.name), ["@studio"], "orient never lists it");
  await assert.rejects(resolveSession(TOKEN, "context-lc", controlPlane("context_texts_group")), "nor can a URL select it");
});

test("the setup door opens the pin read-only, at the pin's own names", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane("context_texts_group"));
  const setup = sessionForSetup(session);
  assert.equal(setup.workspaceId, "ws_pin");
  assert.deepEqual(setup.scopes, ["context:read"], "read only, whatever the grant holds");
  assert.ok(!setup.scopes.includes(SCOPE_WRITE));
  assert.equal(setup.scope, "team");
  assert.ok(setup.grantedGroups.has("@pin-readers"));
  assert.equal(setup.accessToken, TOKEN, "the same proof, for the control plane's own check");
  assert.equal(sessionForSetup(setup), null, "and it opens no further door");
});

test("read-only even where the pin row came back with a writing role", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane("context_texts_group", "editor"));
  assert.deepEqual(sessionForSetup(session).scopes, ["context:read"]);
});

test("the flag means nothing on any other client's grant", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane("context_texts"));
  assert.equal(sessionForSetup(session), null);
  assert.deepEqual(session.workspaces.map((entry) => entry.slug), ["studio"]);
});
