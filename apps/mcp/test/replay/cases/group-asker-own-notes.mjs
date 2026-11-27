import assert from "node:assert/strict";
import { resolveSession, sessionForContext, SCOPE_WRITE } from "../../../src/session.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";

const TOKEN = `cat_replay_own_notes_${"0".repeat(20)}`;
const HOME = "tex/groups/maple-kite-ridge";
const ROW = "#00000000-0000-7000-8000-0000000000c3";
const HEX = "c".repeat(64);

/** The grant the control plane mints for Rin's own ask in a group: the home, a shared workspace, and Rin's own notes. */
function controlPlane(rows) {
  return {
    async resolveSession() {
      return {
        grantId: "grant_rin_ask",
        clientId: "context_texts_group",
        actorUserId: "user_rin",
        scopes: ["context:read", "context:write"],
        defaultWorkspaceId: "ws_pin",
        workspaces: [
          { workspaceId: "ws_pin", slug: "context-lc", role: "editor", kind: "shared", grantedNames: ["#reads-as-chat", ROW, `${ROW}!edit`], homeOnly: true, chatHome: HOME },
          ...rows,
        ],
      };
    },
  };
}

const SHARED = { workspaceId: "ws_kiln", slug: "kiln-co", role: "editor", kind: "shared" };
const OWN = { workspaceId: "ws_rin", slug: "rin", role: "member", kind: "personal", askerOwn: true };

export default {
  id: "group-asker-own-notes",
  incident: "2026-11-26, an invented pottery studio's group chat: Rin asked Tex for the main points of a note in their own personal workspace, and Tex said it can't open personal notes from the chat and to text it on their own.",
  cause: "A group ask read the asker's shared workspaces but never their own personal one, and the turn was told nobody's personal notes can be read from a group, so the model rightly refused.",
  path: "group tag",
  async run() {
    const session = await resolveSession(TOKEN, null, controlPlane([SHARED, OWN]));
    const own = sessionForContext(session, "@rin");
    assert.equal(own.scope, "private", "the asker's own notes open at their private tier, private ones included");
    assert.ok(!own.scopes.includes(SCOPE_WRITE), "and read only from the group");
    assert.equal(own.role, "member", "never read as the person themselves");
    assert.equal(sessionForContext(session, "@kiln-co").scope, "team", "a shared workspace stays at team");
    const group = groupOf({ group: { key: HEX, members: HEX, from: "rin" } }, session);
    assert.deepEqual(group.reach, ["kiln-co"], "the asker's personal workspace is not the room's reach");
    const prompt = groupPrompt(group, "context-lc");
    assert.match(prompt, /"askers_own_personal_notes_readable_this_turn":\{"asker":"@rin","context":"@rin","read_only":true\}/, "the turn is told it can read them, as a fact");
    assert.doesNotMatch(prompt, /Nobody's personal notes/, "and never that nobody's can be read here");
    // Without the control plane's mark nothing changes: the old line, and nobody's personal notes.
    const plain = groupOf({ group: { key: HEX, members: HEX, from: "rin" } }, await resolveSession(TOKEN, null, controlPlane([SHARED])));
    assert.match(groupPrompt(plain, "context-lc"), /Nobody's personal notes/);
  },
};
