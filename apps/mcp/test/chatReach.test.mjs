/**
 * A GROUP CHAT REACHES THE WORKSPACES ITS PEOPLE SHARE, AND NO OTHER (decided by the owner, 2026-10-31;
 * docs/decisions/texting-assistant/groups.md, chat-homes.md).
 *
 * The control plane mints the chat's grant on the pinned workspace and returns the home as the default row, then one
 * row per shared workspace every person in the chat is a live member of, at the lowest role among them
 * (`apps/convex/functions/lib/textGroupReach.ts`). The gateway adds nothing of its own to that: a tool call names a
 * workspace with `context: "@slug"` and can reach only the grant's own rows.
 *
 *  - the home is the default; a bare call reaches the home and no workspace;
 *  - `context` naming a reach row opens it, at team tier, with the row's role clamping writes;
 *  - `context` naming a workspace outside the rows is refused with the answer for a workspace that does not exist;
 *  - a row of the reach carries no granted names, so the grant never holds `context:private` there;
 *  - the prompt names the reach from the session, never from the body, and a body naming more changes nothing.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `sessionForContext` falling back to the default for an unknown name -> "a forged context ..." fails
 *   `effectiveScopes` ignoring the row's role                           -> "a viewer in the chat ..." fails
 *   `reachOf` listing the default row                                   -> "reach is the rows but the home" fails
 *   `groupOf` reading `reach` from the body                             -> "a body naming more ..." fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSession, sessionForContext, SCOPE_WRITE } from "../src/session.js";
import { groupOf, groupPrompt, inFirstReach, reachOf } from "../src/agent/groupTurn.js";

const TOKEN = `cat_chat_reach_${"0".repeat(24)}`;
const HOME = "tex/groups/orbit-lamp-river";
const ROW = "#00000000-0000-7000-8000-0000000000b2";
const HEX = "a".repeat(64);

function home() {
  return { workspaceId: "ws_pin", slug: "context-lc", role: "editor", kind: "shared", grantedNames: ["#reads-as-chat", ROW, `${ROW}!edit`], homeOnly: true, chatHome: HOME };
}

/** A control plane whose grant is a chat's: the home, then the given reach rows. */
function controlPlane(rows) {
  return {
    async resolveSession() {
      return {
        grantId: "grant_chat",
        clientId: "context_texts_group",
        actorUserId: "user_sponsor",
        scopes: ["context:read", "context:write"],
        defaultWorkspaceId: "ws_pin",
        workspaces: [home(), ...rows],
      };
    },
  };
}

const A = { workspaceId: "ws_a", slug: "alpha", role: "owner", kind: "shared" };
const B = { workspaceId: "ws_b", slug: "beta", role: "editor", kind: "shared" };

test("the home is the default and reach is the rows but the home", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane([A, B]));
  assert.equal(session.workspaceId, "ws_pin");
  assert.deepEqual(reachOf(session), ["alpha", "beta"]);
  const none = await resolveSession(TOKEN, null, controlPlane([]));
  assert.deepEqual(reachOf(none), [], "no account for someone: the home alone");
});

test("a named context in reach opens at team tier, with no granted names", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane([A, B]));
  const alpha = sessionForContext(session, "@alpha");
  assert.equal(alpha.workspaceId, "ws_a");
  assert.equal(alpha.scope, "team", "never the private tier, whatever the role");
  assert.ok(!alpha.scopes.includes("context:private"));
  assert.equal(alpha.grantedGroups.size, 0, "no granted names in a reach row");
});

test("a viewer in the chat makes that workspace read-only, and only that one", async () => {
  const viewer = { ...B, role: "member" };
  const session = await resolveSession(TOKEN, null, controlPlane([A, viewer]));
  assert.ok(!sessionForContext(session, "@beta").scopes.includes(SCOPE_WRITE), "member row: read only");
  assert.ok(sessionForContext(session, "@alpha").scopes.includes(SCOPE_WRITE), "the other workspace is unaffected");
});

test("a forged context naming a workspace outside the reach is refused as a missing one is", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane([A]));
  const refusal = (name) => {
    try {
      sessionForContext(session, name);
    } catch (error) {
      return `${error.status}:${error.message}`;
    }
    return "allowed";
  };
  const missing = refusal("@no-such-workspace");
  assert.match(missing, /^403:/);
  for (const forged of ["@beta", "beta", "@some-personal-handle", "@../beta", "@alpha/../beta", "@ws_b"]) {
    assert.equal(refusal(forged), missing, forged);
  }
  // And at the door: a slug in the URL is judged the same way.
  await assert.rejects(resolveSession(TOKEN, "beta", controlPlane([A])), (error) => error.status === 403);
});

test("the prompt names the reach from the session, and a body naming more changes nothing", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane([B, A]));
  const body = { group: { key: HEX, members: HEX, from: "ada", reach: ["gamma"], workspaces: ["gamma"] } };
  const group = groupOf(body, session);
  assert.deepEqual(group.reach, ["alpha", "beta"]);
  const prompt = groupPrompt(group, "context-lc");
  assert.match(prompt, /@alpha and @beta/);
  assert.doesNotMatch(prompt, /gamma/);
  const bare = groupOf({ group: { key: HEX, members: HEX, from: "ada" } }, await resolveSession(TOKEN, null, controlPlane([])));
  assert.equal(bare.reach, undefined);
});

test("a single-workspace reader goes to the first in reach by name", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane([B, A]));
  const group = groupOf({ group: { key: HEX, members: HEX, from: "ada" } }, session);
  const calls = [];
  await inFirstReach(async (name, args) => calls.push({ name, args }), group)("read_note", { path: "tex/groups/playbook.md" });
  assert.deepEqual(calls, [{ name: "read_note", args: { path: "tex/groups/playbook.md", context: "@alpha" } }]);
  const plain = async () => {};
  assert.equal(inFirstReach(plain, { reach: [] }), plain);
  assert.equal(inFirstReach(null, group), null);
});
