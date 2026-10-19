/**
 * ALL CONTEXT USERS: what `team` is called in the pinned workspace, and the Members position beside it.
 *
 * `@context-lc` is read by every signed-in Context account through the pin, at `team`
 * (`docs/decisions/privacy-and-sharing/all-context-users.md`). So there, and only there, every sentence that
 * describes `team` must say it reaches anyone signed in to Context: `words.ts` forbids understating reach, and
 * "Everyone in @context-lc" or "the named list on People, and nobody else" would. Members (base `private` plus the
 * built-in members grantee) is the position that means the people actually invited.
 *
 * Ordinary workspaces are unchanged, and the second half of each block pins that.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the `everyAccount` branch in `audienceName`: "team is All Context users" fails;
 *  - drop it in `teamMeans`, `rootDefaultLine`, `folderDefaultLine`, `widenWarning` or `visibilityWordIn`:
 *    "every sentence about team says every account" fails;
 *  - make `scopeOf` ignore the members grant (treat it as Restricted): "a members grant is the Members position" fails;
 *  - drop the visibility step from `stepsTo("members", "anyone")`: "every move ends where it asked" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { audienceDetail, audienceName, audienceContextOf, type AudienceContext } from "../features/console/privacy/audience";
import {
  folderDefaultLine,
  rootDefaultLine,
  teamMeans,
  visibilityWord,
  visibilityWordIn,
  widenWarning,
} from "../features/console/privacy/words";
import { audiencePositions, scopeLabels, scopeOf, stepsTo, type NoteScope } from "../features/console/files/scope";
import { allUsersConfirmLine, ALL_USERS_TAG, scopeLine } from "../features/console/files/shareDialog/copy";

const lc: AudienceContext = { slug: "context-lc", kind: "shared", viewerIsOwner: true, everyAccount: true };
const acme: AudienceContext = { slug: "acme", kind: "shared", viewerIsOwner: true };

describe("in the pinned workspace, team is all Context users", () => {
  test("team is All Context users, and its detail says anyone signed in, not just members", () => {
    expect(audienceName("team", lc)).toBe("All Context users");
    const detail = audienceDetail("team", lc);
    expect(detail).toContain("Anyone signed in to Context");
    expect(detail).toContain("not just");
    expect(detail).not.toContain("nobody outside");
  });

  test("every sentence about team says every account", () => {
    for (const line of [
      teamMeans("shared", true, true),
      rootDefaultLine("team", true),
      folderDefaultLine("team", true),
      widenWarning("Roadmap", true),
    ]) {
      expect(line).toContain("signed in to Context");
      expect(line).not.toContain("nobody else");
    }
    expect(visibilityWordIn("team", true)).toBe("All users");
    // `map` hands an index as the second argument; the one-argument form can never read it as the flag.
    expect((["private", "team", "team"] as const).map(visibilityWord)).toEqual(["Restricted", "Everyone", "Everyone"]);
  });

  test("the derivation carries the flag, and leaves it off by default", () => {
    expect(audienceContextOf("context-lc", "shared", true, true).everyAccount).toBe(true);
    expect(audienceContextOf("acme", "shared", true).everyAccount).toBe(false);
  });

  test("an ordinary workspace keeps every sentence it had", () => {
    expect(audienceName("team", acme)).toBe("Everyone in @acme");
    expect(audienceDetail("team", acme)).toContain("nobody outside it");
    expect(teamMeans("shared", true)).toContain("the named list on People, and nobody else");
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
    expect(audiencePositions({ everyAccount: true, membersWritable: true, scope: "private" })).toEqual([
      "private",
      "members",
      "team",
      "anyone",
    ]);
    expect(audiencePositions({ everyAccount: false, membersWritable: true, scope: "team" })).toEqual(["private", "team", "anyone"]);
  });

  test("Members is not offered where the list cannot be written, but a note already there still shows it", () => {
    expect(audiencePositions({ everyAccount: true, membersWritable: false, scope: "team" })).not.toContain("members");
    expect(audiencePositions({ everyAccount: false, membersWritable: true, scope: "members" })).toContain("members");
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
