/**
 * THE GUEST MARK IN THE GATEWAY (owner, 2026-10-19; docs/decisions/privacy-and-sharing/all-context-users.md).
 *
 * Somebody who reaches `@context-lc` through the pin alone reads it as a guest: the control plane hands their
 * session the names `#reads-as-guest` plus the tokens of the rows opened to All Context users, and the binding the
 * rows rendered for a guest, where `team` never appears. These pin the gateway's half:
 *
 *  - the session keeps the mark, so the sibling it builds for `@context-lc` carries it into every read;
 *  - `canSee` shuts `team` to a holder of the mark even under a member's rules, so a read judged by the wrong
 *    rendering fails closed rather than open;
 *  - under a guest's rules the holder reads the All Context users notes and nothing else.
 *
 * ## Sabotage record
 *
 *   `canSee` answering `team` without looking at `readsAsGuest`
 *     → "the mark shuts team even under a member's rules" fails
 *   the `accounts` case dropped from `accessNamesFor`
 *     → "a pin reader reads the All Context users notes and nothing else" fails
 *   `ROW_NAME_PATTERN` refusing the mark at the grant boundary
 *     → "the session keeps the mark for the pinned workspace" fails: the whole session is refused
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canSee, READS_AS_GUEST } from "../../src/privacy/engine.js";
import { accessNamesFor, renderAccess } from "../../src/privacy/rowAccess.js";
import { resolveSession, sessionForContext } from "../../src/session.js";

const ROWS = [
  { path: "guides", noteId: "00000000-0000-7000-8000-000000000012", kind: "folder", base: "team", grantees: [{ kind: "accounts", id: "accounts", role: "view" }] },
  { path: "areas", noteId: "00000000-0000-7000-8000-000000000013", kind: "folder", base: "team", grantees: [] },
];

test("the mark shuts team even under a member's rules", () => {
  const member = renderAccess(ROWS, "member");
  for (const path of ["guides/start.md", "areas/ai/bench.md"]) {
    assert.equal(canSee(path, "team", member.rules, member.overrides, new Set()), true, path);
    assert.equal(canSee(path, "team", member.rules, member.overrides, new Set([READS_AS_GUEST])), false, path);
  }
});

test("a pin reader reads the All Context users notes and nothing else", () => {
  const guest = renderAccess(ROWS, "guest");
  const names = new Set([READS_AS_GUEST, ...accessNamesFor({ account: true }, ROWS)]);
  assert.equal(canSee("guides/start.md", "team", guest.rules, guest.overrides, names), true);
  assert.equal(canSee("areas/ai/bench.md", "team", guest.rules, guest.overrides, names), false);
  assert.equal(canSee("index.md", "team", guest.rules, guest.overrides, names), false);
});

test("the session keeps the mark for the pinned workspace", async () => {
  const controlPlane = {
    async resolveSession() {
      return {
        grantId: "grant_pin",
        clientId: "client_pin",
        actorUserId: "user_pin",
        scopes: ["context:read", "context:write"],
        defaultWorkspaceId: "ws_own",
        workspaces: [
          { workspaceId: "ws_own", slug: "sayo", role: "owner" },
          { workspaceId: "ws_pin", slug: "context-lc", role: "member", grantedNames: ["#reads-as-guest", "#00000000-0000-7000-8000-000000000012"] },
        ],
      };
    },
  };
  const session = await resolveSession("cat_example_token_000000000000000000", null, controlPlane);
  const pinned = sessionForContext(session, "@context-lc");
  assert.equal(pinned.scope, "team");
  assert.ok(pinned.grantedGroups.has(READS_AS_GUEST));
  // The person's own workspace is read as it always was.
  assert.equal(session.grantedGroups.has(READS_AS_GUEST), false);
});
