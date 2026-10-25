/**
 * What each press in the share dialog writes, where a note has a list (`shareDialog/grants.ts`), and what the
 * field offers there (`shareDialog/grantMode.ts`).
 *
 * The one that matters most: naming somebody on a note that follows a team folder must write the note's base as
 * team, or the list alone would shut every other member out (`rowAccess.ts` reads a list with no base as private).
 */

import { describe, expect, test } from "@jest/globals";
import {
  addGrant,
  backToFolder,
  grantDetail,
  ownCopy,
  removeGrant,
  setRole,
  typedDomain,
  typedEmail,
  type GrantList,
} from "../features/console/files/shareDialog/grants";
import { domainRow, grantLine, pickOf, reachingOf } from "../features/console/files/shareDialog/grantMode";

const LIST: GrantList = {
  version: 1,
  kind: "file",
  base: "private",
  tier: "private",
  from: null,
  domains: ["publicworship.life"],
  grantees: [
    { kind: "group", groupId: "g1", name: "acme-leads", label: "leads", count: 2, role: "edit" },
    { kind: "user", userId: "u1", label: "Kola", member: true, role: "view" },
    { kind: "email", email: "pat@example.test", role: "view" },
  ],
};

describe("what a press writes", () => {
  test("adding somebody keeps everyone already there, by id, and the row's own base", () => {
    expect(addGrant(LIST, { kind: "email", email: "new@example.test" }, "edit")).toEqual({
      base: "private",
      grantees: [
        { groupId: "g1", role: "edit" },
        { userId: "u1", role: "view" },
        { email: "pat@example.test", role: "view" },
        { email: "new@example.test", role: "edit" },
      ],
    });
  });

  test("a note that follows a team folder gets the folder's people and team as its own, so nobody loses it", () => {
    const inherited: GrantList = { ...LIST, base: null, tier: "team", from: "1-projects" };
    const write = addGrant(inherited, { kind: "member", userId: "u2", label: "Ada" }, "view");
    expect(write.base).toBe("team");
    expect(write.grantees).toHaveLength(4);
    expect(ownCopy(inherited)).toEqual({ base: "team", grantees: LIST.grantees.map((entry) =>
      entry.kind === "group" ? { groupId: entry.groupId, role: entry.role }
        : entry.kind === "user" ? { userId: entry.userId, role: entry.role }
          : entry.kind === "email" ? { email: entry.email, role: entry.role }
            : { members: true, role: entry.role }) });
  });

  test("a group is added by its name, and re-adding somebody changes their role rather than listing them twice", () => {
    expect(addGrant({ ...LIST, grantees: [] }, { kind: "group", group: "acme-leads", label: "leads" }, "view").grantees).toEqual([
      { handle: "@acme-leads", role: "view" },
    ]);
    const again = addGrant(LIST, { kind: "email", email: "PAT@example.test" }, "edit");
    expect(again.grantees.filter((entry) => "email" in entry)).toEqual([{ email: "PAT@example.test", role: "edit" }]);
  });

  test("role changes and removals touch one entry", () => {
    expect(setRole(LIST, "user:u1", "edit").grantees[1]).toEqual({ userId: "u1", role: "edit" });
    expect(removeGrant(LIST, "group:g1").grantees).toEqual([
      { userId: "u1", role: "view" },
      { email: "pat@example.test", role: "view" },
    ]);
  });

  test("going back to the folder sends inherit and an empty list", () => {
    expect(backToFolder()).toEqual({ base: "inherit", grantees: [] });
  });
});

describe("what the field offers", () => {
  test("a domain is a domain, an address is an address", () => {
    expect(typedDomain("publicworship.life")).toBe("publicworship.life");
    expect(typedDomain("@PublicWorship.life ")).toBe("publicworship.life");
    expect(typedDomain("pat@example.test")).toBeNull();
    expect(typedDomain("kola")).toBeNull();
    expect(typedEmail("Pat@Example.test")).toBe("pat@example.test");
  });

  test("a domain set to join is an offer on a private note, an answer on a team one, and blocked when it is not set", () => {
    const options = { handle: "@acme", scope: "private" as const, personal: false };
    expect(domainRow("publicworship.life", LIST, options)).toMatchObject({ kind: "domain", domain: "publicworship.life" });
    expect(domainRow("publicworship.life", LIST, options)?.reaches).toBeUndefined();
    expect(domainRow("publicworship.life", LIST, { ...options, scope: "team" })?.reaches).toBe(true);
    expect(domainRow("example.org", LIST, options)?.blocked).toBe(true);
    expect(domainRow("example.org", LIST, { ...options, personal: true })?.blocked).toBe(true);
    expect(domainRow("pat@example.org", LIST, options)).toBeNull();
  });

  test("who is already on the list, and what a picked row stands for", () => {
    const reaching = reachingOf(LIST, ["owner"]);
    expect([...reaching.reachingUserIds].sort()).toEqual(["owner", "u1"]);
    expect([...reaching.reachingGroups]).toEqual(["acme-leads"]);
    expect([...reaching.reachingEmails]).toEqual(["pat@example.test"]);
    expect(pickOf({ kind: "invite", key: "x@example.test", label: "x@example.test" })).toEqual({ kind: "email", email: "x@example.test" });
    expect(pickOf({ kind: "domain", key: "domain:a.b", label: "Everyone at a.b", domain: "a.b" })).toBeNull();
  });

  test("an email given edit is told they can edit it once they sign in (#1803); an outsider's row says they are outside", () => {
    expect(grantLine({ kind: "invite", key: "x@example.test", label: "x@example.test" }, "edit", "@acme")).toBe(
      "They can edit it once they sign in with x@example.test, and find it under Shared with me.",
    );
    expect(grantDetail({ kind: "user", userId: "u9", label: "Mara", member: false, role: "view" }, "@acme")).toBe("Not in @acme");
  });
});

describe("someone outside, by their @name", () => {
  test("a picked @name is written as that handle, beside what the list already holds", () => {
    const pick = pickOf({ kind: "handle", key: "@seyi", label: "@seyi", handle: "seyi" });
    expect(pick).toEqual({ kind: "handle", handle: "seyi" });
    expect(addGrant(LIST, pick!, "edit").grantees).toEqual([
      { groupId: "g1", role: "edit" },
      { userId: "u1", role: "view" },
      { email: "pat@example.test", role: "view" },
      { handle: "@seyi", role: "edit" },
    ]);
  });

  test("an outsider the list shows by @name counts as reaching it, so the field does not offer them again", () => {
    const listed: GrantList = {
      ...LIST,
      grantees: [...LIST.grantees, { kind: "user", userId: "u9", label: "@seyi", member: false, role: "view" }],
    };
    expect([...reachingOf(listed, []).reachingHandles]).toEqual(["seyi"]);
  });

  test("the sentence beside Share says where they find it", () => {
    expect(grantLine({ kind: "handle", key: "@seyi", label: "@seyi", handle: "seyi" }, "view", "@acme")).toBe(
      "@seyi can read it, and finds it under Shared with me. You can take it back.",
    );
  });
});

describe("the visibility control on a note with a list", () => {
  test("a list's token is not a group rule: the control may change it, starting from what the dialog showed", () => {
    const { scopeGuard } = require("../features/console/files/fileBrowser/useShareScope") as typeof import("../features/console/files/fileBrowser/useShareScope");
    expect(scopeGuard("@#0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe("listed");
    expect(scopeGuard("@acme-leads")).toBe("group");
    expect(scopeGuard("team")).toBe("tier");
    expect(scopeGuard("private")).toBe("tier");
  });
});
