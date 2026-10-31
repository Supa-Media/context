/**
 * A HOME-ONLY GROUP CHAT'S SESSION IS ITS HOME AND NOTHING ELSE (E1 of the guest-mode retirement, decided by the owner,
 * 2026-10-31; docs/decisions/texting-assistant/group-guests.md, chat-homes.md).
 *
 * A chat that not everyone shares a workspace with is answered on a grant the control plane mints on the pinned
 * workspace (`lib/textGroupHomeOnly.ts`). Its one row is the pin, addressable (not setup-only), carrying the chat's
 * names (`READS_AS_CHAT`, the home's token and its edit name) and `homeOnly`. The gateway keeps that row as the
 * session's only reach, and opens the home door from it, and from nothing else:
 *
 *  - the row is the session's only reach: no other workspace, and no setup-only pin beside it;
 *  - `sessionForChatHome` opens the pin to write for it, at the home only;
 *  - `homeOnly` and the home are honoured for the group client alone, and the home must sit beneath the homes folder
 *    and the names must say the chat reads as a chat;
 *  - a row claiming `homeOnly` under any other client is an ordinary row, and opens no door.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `homeOnly` honoured for every client                     -> "a home-only claim under another client opens nothing" fails
 *   `setup` ignoring `homeOnly` rows                          -> "its home door opens" fails
 *   `homeOnly` rows dropped from `reach`                      -> "its one row is the session's only reach" fails
 *   `CHAT_HOME_PATTERN` loosened in the homeOnly branch       -> "a home outside the homes folder is dropped" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSession, sessionForChatHome, sessionForSetup, SCOPE_WRITE } from "../src/session.js";

const TOKEN = `cat_home_only_${"0".repeat(24)}`;
const HOME = "tex/groups/orbit-lamp-river";
const ROW = "#00000000-0000-7000-8000-0000000000b2";

/** A control plane whose grant is a home-only one for the pin, by default under the group client. */
function controlPlane({ clientId = "context_texts_group", scopes = ["context:read", "context:write"], row = {} } = {}) {
  return {
    async resolveSession() {
      return {
        grantId: "grant_home_only",
        clientId,
        actorUserId: "user_sponsor",
        scopes,
        defaultWorkspaceId: "ws_pin",
        workspaces: [
          {
            workspaceId: "ws_pin",
            slug: "context-lc",
            role: "editor",
            kind: "shared",
            grantedNames: ["#reads-as-chat", ROW, `${ROW}!edit`],
            homeOnly: true,
            chatHome: HOME,
            ...row,
          },
        ],
      };
    },
  };
}

test("its one row is the session's only reach, and it is addressable", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane());
  assert.deepEqual(session.workspaces.map((entry) => entry.workspaceId), ["ws_pin"]);
  assert.equal(session.setupReach?.workspaceId, "ws_pin", "the home's row is also the setup the home door reads");
  assert.equal(session.workspaces[0].setupOnly, undefined, "addressable: not a setup-only row");
});

test("its home door writes the home, and nothing else in the pin", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane());
  const home = sessionForChatHome(session);
  assert.equal(home.workspaceId, "ws_pin");
  assert.equal(home.chatHome, HOME);
  assert.ok(home.scopes.includes(SCOPE_WRITE), "it may write the home");
  assert.equal(home.scope, "team", "the chat's rules, never the private tier");
  assert.ok(home.grantedGroups.has("@#reads-as-chat"));
  assert.equal(sessionForChatHome(home), null, "the door opens no further door");
  assert.equal(sessionForSetup(home), null);
});

test("a grant that may not write gets no home door", async () => {
  const session = await resolveSession(TOKEN, null, controlPlane({ scopes: ["context:read"] }));
  assert.equal(sessionForChatHome(session), null);
});

test("a home outside the homes folder, or a name without the chat's reading, opens nothing", async () => {
  for (const chatHome of ["guides", "tex/groups", "tex/groups/a/b", "tex/groups/../guides", "Tex/Groups/orbit-lamp", "tex/groupsx/orbit-lamp"]) {
    const session = await resolveSession(TOKEN, null, controlPlane({ row: { chatHome } }));
    assert.equal(sessionForChatHome(session), null, chatHome);
  }
  const unnamed = await resolveSession(TOKEN, null, controlPlane({ row: { grantedNames: [ROW, `${ROW}!edit`] } }));
  assert.equal(sessionForChatHome(unnamed), null, "no READS_AS_CHAT, no door");
});

test("a home-only claim under another client is an ordinary row, and opens no door", async () => {
  const other = await resolveSession(TOKEN, null, controlPlane({ clientId: "context_texts" }));
  assert.equal(sessionForChatHome(other), null);
  assert.equal(other.workspaces[0].chatHome, undefined, "the home is not honoured for any other client");
  assert.equal(other.setupReach, null);
});
