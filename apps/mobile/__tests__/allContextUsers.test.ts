/**
 * ALL CONTEXT USERS: a grant in the pinned workspace, beside Members, and never a word for `team`.
 *
 * `team` in `@context-lc` means its real members, as in every workspace (decided by the owner, 2026-10-19;
 * `docs/decisions/privacy-and-sharing/all-context-users.md`). Opening a note to every signed-in Context account is
 * the built-in `accounts` grant, which the share dialog offers as All Context users. So the share dialog keeps its
 * four positions there (Restricted / Members of @context-lc / All Context users / Anyone with the link), Members is
 * base `team`, All Context users is base `team` plus the accounts grant, and every sentence about `team` itself says
 * what it says in any workspace.
 *
 * Ordinary workspaces are unchanged, and the second half of each block pins that.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - bring back the `offersAllUsers` branch in `audienceName`: "team is the members" fails;
 *  - bring it back in `teamMeans`, `rootDefaultLine`, `folderDefaultLine`, `widenWarning` or `visibilityWord`:
 *    "every sentence about team says the members" fails;
 *  - drop the `offersAllUsers` branch in `scopeLabels`: "the final copy" fails;
 *  - make `scopeOf` ignore the accounts grant: "team without the accounts grant is Members" fails;
 *  - make `stepsTo` write plain `team` for All Context users: "every move ends where it asked, in the pinned
 *    workspace" fails;
 *  - make `scopeOf` ignore the members grant (treat it as Restricted): "a members grant is the Members position" fails;
 *  - drop the visibility step from `stepsTo("members", "anyone")`: "every move ends where it asked" fails.
 */

import { describe, expect, test } from "@jest/globals";
import {
  ALL_USERS_NAME,
  allUsersDetail,
  audienceDetail,
  audienceName,
  audienceContextOf,
  type AudienceContext,
} from "../features/console/privacy/audience";
import { folderDefaultLine, rootDefaultLine, teamMeans, visibilityWord, widenWarning } from "../features/console/privacy/words";
import { audiencePositions, scopeLabels, scopeOf, stepsTo, type NoteScope } from "../features/console/files/scope";
import { allUsersConfirmLine, ALL_USERS_TAG, scopeLine } from "../features/console/files/shareDialog/copy";

const lc: AudienceContext = { slug: "context-lc", kind: "shared", viewerIsOwner: true, offersAllUsers: true };
const acme: AudienceContext = { slug: "acme", kind: "shared", viewerIsOwner: true };

describe("in the pinned workspace, team is the members", () => {
  test("team is the members, and its detail says nobody outside it", () => {
    expect(audienceName("team", lc)).toBe("Everyone in @context-lc");
    expect(audienceDetail("team", lc)).toContain("nobody outside it");
    expect(audienceDetail("team", lc)).not.toContain("signed in to Context");
  });

  test("every sentence about team says the members", () => {
    for (const line of [teamMeans("shared", true), rootDefaultLine("team"), folderDefaultLine("team"), widenWarning("Roadmap")]) {
      expect(line).not.toContain("signed in to Context");
    }
    expect(teamMeans("shared", true)).toContain("the named list on People, and nobody else");
    // `map` hands an index as the second argument; the one-argument form can never read it as a flag.
    expect((["private", "team", "team"] as const).map(visibilityWord)).toEqual(["Restricted", "Everyone", "Everyone"]);
  });

  test("All Context users says anyone signed in, not just the members", () => {
    expect(ALL_USERS_NAME).toBe("All Context users");
    const detail = allUsersDetail(lc);
    expect(detail).toContain("Anyone signed in to Context");
    expect(detail).toContain("not just the members of @context-lc");
    expect(detail).not.toContain("nobody outside");
  });

  test("the derivation carries the flag, and leaves it off by default", () => {
    expect(audienceContextOf("context-lc", "shared", true, true).offersAllUsers).toBe(true);
    expect(audienceContextOf("acme", "shared", true).offersAllUsers).toBe(false);
  });

  test("an ordinary workspace keeps every sentence it had", () => {
    expect(audienceName("team", acme)).toBe("Everyone in @acme");
    expect(audienceDetail("team", acme)).toContain("nobody outside it");
    expect(rootDefaultLine("team")).toContain("everyone on People");
    expect(folderDefaultLine("team")).toContain("everyone on People");
    expect(widenWarning("Roadmap")).toContain("everyone on People");
    expect(visibilityWord("team")).toBe("Everyone");
  });
});

describe("the audience menu, one line per position, widest last", () => {
  const line = (scope: NoteScope, context: AudienceContext, memberCount?: number) =>
    scopeLine(scope, context, { kind: "file", memberCount, people: 0 });

  test("four positions in the pinned workspace, three elsewhere", () => {
    expect(audiencePositions({ offersAllUsers: true, membersWritable: true, scope: "private" })).toEqual([
      "private",
      "members",
      "team",
      "anyone",
    ]);
    expect(audiencePositions({ offersAllUsers: false, membersWritable: true, scope: "team" })).toEqual(["private", "team", "anyone"]);
  });

  test("Members is not offered where the list cannot be written, but a note already there still shows it", () => {
    expect(audiencePositions({ offersAllUsers: true, membersWritable: false, scope: "team" })).not.toContain("members");
    expect(audiencePositions({ offersAllUsers: false, membersWritable: true, scope: "members" })).toContain("members");
  });

  test("the final copy", () => {
    const labels = scopeLabels(lc);
    expect(labels.private.label).toBe("Restricted");
    expect(labels.members.label).toBe("Members of @context-lc");
    expect(labels.team.label).toBe("All Context users");
    expect(labels.anyone.label).toBe("Anyone with the link");
    expect(line("private", lc)).toBe("Only owners of @context-lc can open it");
    expect(line("members", lc, 4)).toBe("All 4 members can open it");
    expect(line("members", lc)).toBe("Every member of @context-lc can open it");
    expect(line("team", lc)).toBe("Anyone signed in to Context can open it");
    expect(line("anyone", lc)).toBe("Anyone can read it, and the notes it links to, without signing in");
    expect(ALL_USERS_TAG).toBe("Not just members. Keep anything sensitive out.");
  });

  test("an ordinary workspace's team line is unchanged", () => {
    expect(scopeLabels(acme).team.label).toBe("Everyone in @acme");
    expect(line("team", acme, 3)).toBe("All 3 members can open it");
  });

  test("the confirm says who, and that signing up is open", () => {
    expect(allUsersConfirmLine("Q4 roadmap", "file", "@context-lc", 4)).toBe(
      "Anyone signed in to Context will be able to open Q4 roadmap, not just the 4 members. Signing up is open to all, so keep anything sensitive out.",
    );
    expect(allUsersConfirmLine("Q4 roadmap", "file", "@context-lc")).toBe(
      "Anyone signed in to Context will be able to open Q4 roadmap, not just members of @context-lc. Signing up is open to all, so keep anything sensitive out.",
    );
    expect(allUsersConfirmLine("Roadmap", "folder", "@context-lc", 4)).toBe(
      "Anyone signed in to Context will be able to open everything in Roadmap, including notes added later. Signing up is open to all, so keep anything sensitive out.",
    );
  });
});

describe("the Members position", () => {
  test("a members grant is the Members position, never Restricted", () => {
    expect(scopeOf("private", false, true)).toBe("members");
    expect(scopeOf("private", true, true)).toBe("members");
    expect(scopeOf("private", false)).toBe("private");
    // A members grant under a team base adds nobody: the tier is what the row reads as.
    expect(scopeOf("team", false, true)).toBe("team");
  });

  test("team without the accounts grant is Members in the pinned workspace, and All Context users with it", () => {
    expect(scopeOf("team", false, false, false)).toBe("members");
    expect(scopeOf("team", false, false, true)).toBe("team");
    // While the list loads it reads as the wider of the two.
    expect(scopeOf("team", false, false, undefined)).toBe("team");
    expect(scopeOf("team", true, false, false)).toBe("anyone");
    // A row written the old way is still Members.
    expect(scopeOf("private", false, true, false)).toBe("members");
  });

  test("every move ends where it asked, members included", () => {
    const scopes: NoteScope[] = ["private", "members", "team", "anyone"];
    for (const from of scopes) {
      for (const to of scopes) {
        let base: "private" | "team" = from === "private" || from === "members" ? "private" : "team";
        let members = from === "members";
        let link = from === "anyone";
        for (const step of stepsTo(from, to)) {
          if (step.kind === "visibility") {
            base = step.to === "team" ? "team" : "private";
            members = step.to === "members";
          } else link = step.on;
        }
        expect(scopeOf(base, link, members)).toBe(to);
        // A link is never minted over a row the workspace cannot read.
        if (link) expect(base).toBe("team");
      }
    }
  });
});

describe("the pinned workspace's moves", () => {
  /** What the server writes for each step there once the pin readers read as guests (`nodesAccess.consoleAccess`). */
  test("every move ends where it asked, in the pinned workspace", () => {
    const scopes: NoteScope[] = ["private", "members", "team", "anyone"];
    for (const from of scopes) {
      for (const to of scopes) {
        let base: "private" | "team" = from === "private" ? "private" : "team";
        let accounts = from === "team";
        let link = from === "anyone";
        for (const step of stepsTo(from, to, true)) {
          if (step.kind === "visibility") {
            // Plain `team` is never written there by this control: it would be Members, which `members` says.
            expect(step.to).not.toBe("team");
            base = step.to === "private" ? "private" : "team";
            accounts = step.to === "accounts";
          } else link = step.on;
        }
        expect([from, to, scopeOf(base, link, false, accounts)]).toEqual([from, to, to]);
        if (link) expect(base).toBe("team");
      }
    }
  });

  test("All Context users from a link writes the grant, since the link may sit on Members", () => {
    expect(stepsTo("anyone", "team", true)).toEqual([
      { kind: "openLink", on: false },
      { kind: "visibility", to: "accounts" },
    ]);
    // Elsewhere a link is always over `team` already.
    expect(stepsTo("anyone", "team")).toEqual([{ kind: "openLink", on: false }]);
  });
});
