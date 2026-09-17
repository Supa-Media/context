/**
 * A `@name` RULE GRANTS SOMEBODY SOMETHING.
 *
 * `canSee` has taken a `grantedGroups` set since the group namespace existed,
 * and until this suite **nothing in the product ever passed it**: a search for
 * a five-argument call matched the function's own definition and nothing else.
 * So `2-areas/hr: @atlas-leads` was a rule with no read path — readable by
 * owners, who read at `private` scope and see everything anyway, and by nobody
 * else on earth, the people in the group included. The manifest grammar, the
 * `workspaceGroups` table, the setter action and the console's group maker were
 * all built on top of a clearance that was never handed out.
 *
 * That is why this file leads with the two halves stated separately:
 *
 *  1. **A named person or group can read what was named to them.** The feature
 *     working at all.
 *  2. **Nobody else can**, and that is proved in ONE database and ONE
 *     workspace — attacker and victim side by side, the arrangement
 *     `files.test.ts` uses for the audit trail, because a fixture that
 *     separates them proves nothing: the refusal would come from the row not
 *     existing rather than from the gate.
 *
 * ## The rule reaches a caller two ways, and both are intersected with
 * membership
 *
 * A caller's granted names are the groups of **this** workspace they are a live
 * member of, plus the handles they personally answer to (`@kola`). Both are
 * intersected with live workspace membership at resolution time, so a group row
 * left behind by somebody who left the workspace is inert — the property
 * `resolveGroupMembers` was written for, now load-bearing on the read path
 * rather than only on the console's listing.
 *
 * ## What a missed call site costs
 *
 * Threading a clearance through twenty-odd `canSee` sites risks missing one.
 * Every miss fails **closed** — a person in the group sees less than they were
 * given — which is the direction this codebase asks for, and why the widening
 * cases below are asserted one operation at a time rather than through a single
 * listing that would pass while `readNote` stayed shut.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  PRIVACY_KEY,
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
} from "../functions/lib/privacy";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { grantedNamesFor } from "../functions/lib/grantedNames";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * A manifest naming one folder to one `@name`, written by hand.
 *
 * Hand-built rather than produced by the setter on purpose: this file is about
 * the READ path, and a fixture that went through the writer would fail for the
 * writer's reasons too. A hand-edited `privacy.md` is also the real case — the
 * customer owns this file and edits it in Obsidian.
 */
function manifestNaming(folder: string, name: string): string {
  return [
    "# Privacy",
    "",
    PRIVACY_RULES_BEGIN,
    "",
    "```yaml",
    "default_visibility: private",
    "",
    "folder_defaults:",
    `  ${folder}: ${name}`,
    "  3-resources: team",
    "",
    "note_overrides:",
    "  # No exact-note overrides.",
    "```",
    "",
    PRIVACY_RULES_END,
    "",
  ].join("\n");
}

interface Fixture {
  t: TestConvex;
  /** Reads at `private` scope, so every assertion about them is a control. */
  owner: Id<"users">;
  /** In `@atlas-leads`. The person the rule is for. */
  insider: Id<"users">;
  /** A member of the same workspace, in no group. The attacker. */
  outsider: Id<"users">;
  /**
   * An `editor` in no group.
   *
   * Needed because a `member` is refused a write by the role ladder before any
   * path is consulted, so `outsider` cannot prove anything about the write
   * path. An editor gets past the role check and is stopped — or not — by the
   * privacy engine alone, which is the thing under test.
   */
  editorOutside: Id<"users">;
  /** An `editor` who IS in the group, the other half of that pair. */
  editorInside: Id<"users">;
  /** Owns the personal workspace `kola`, so `@kola` is their handle. */
  kola: Id<"users">;
  workspaceId: Id<"workspaces">;
  groupName: string;
  backend: MemoryS3;
}

/**
 * One shared workspace, four people, one bucket.
 *
 * `insider` and `outsider` hold the **same role** — `member` — so nothing below
 * can pass by accident through the role ladder. The only difference between
 * them is the group row, which is exactly the thing under test.
 */
async function fixture(rule: { folder: string; name: string }): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const insider = await createUser(t, "insider@example.invalid");
  const outsider = await createUser(t, "outsider@example.invalid");
  const editorOutside = await createUser(t, "editor-out@example.invalid");
  const editorInside = await createUser(t, "editor-in@example.invalid");
  const kola = await createUser(t, "kola@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas", {
    kind: "shared",
    displayName: "Atlas",
  });
  await addMember(t, workspaceId, insider, "member", owner);
  await addMember(t, workspaceId, outsider, "member", owner);
  await addMember(t, workspaceId, editorOutside, "editor", owner);
  await addMember(t, workspaceId, editorInside, "editor", owner);
  await addMember(t, workspaceId, kola, "member", owner);

  // `@kola` is a handle because Kola owns a PERSONAL workspace of that slug.
  // Nothing claims a `kind: "user"` name row today — `resolveAddressedUser`
  // says so — so this is how a person is addressable in practice.
  await createWorkspace(t, kola, "kola", { kind: "personal" });

  const group = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
    workspaceId,
    label: "leads",
  });
  for (const userId of [insider, editorInside]) {
    await asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
      workspaceId,
      groupId: group.groupId,
      userId,
    });
  }

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, manifestNaming(rule.folder, rule.name));
  backend.seed("index.md", "# Atlas\n");
  backend.seed("2-areas/README.md", "# Areas\n");
  backend.seed("2-areas/hr.md", "# HR\n");
  backend.seed("2-areas/deep/nested.md", "# Nested\n");
  backend.seed("3-resources/open.md", "# Open\n");
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: {
        conditionalWrite: true,
        conditionalCreate: true,
        conditionalDelete: true,
      },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return {
    t,
    owner,
    insider,
    outsider,
    editorOutside,
    editorInside,
    kola,
    workspaceId,
    groupName: group.name,
    backend,
  };
}

/** The names in a folder listing, for the caller given. */
async function listing(f: Fixture, who: Id<"users">, path: string): Promise<string[]> {
  const result = await asUser(f.t, who).action(api.functions.files.listFiles, {
    workspaceId: f.workspaceId,
    path,
  });
  return result.entries.map((entry) => entry.name);
}

/* -------------------------------------------------------------------------- */
/*                      1. the rule grants what it names                      */
/* -------------------------------------------------------------------------- */

describe("a folder named to a group is readable by that group", () => {
  test("a member of the group can list it", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.insider, "2-areas")).toContain("hr.md");
  });

  test("a member of the group can read a note in it", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    const note = await asUser(f.t, f.insider).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/hr.md",
    });
    expect(note.text).toContain("# HR");
  });

  test("the rule reaches a subfolder, the way a folder default does", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.insider, "2-areas/deep")).toContain("nested.md");
  });

  test("the folder itself appears in its parent's listing", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.insider, "")).toContain("2-areas");
  });
});

describe("a folder named to a person is readable by that person", () => {
  test("a handle that resolves through their personal context grants access", async () => {
    const f = await fixture({ folder: "2-areas", name: "@kola" });
    expect(await listing(f, f.kola, "2-areas")).toContain("hr.md");
  });
});

/* -------------------------------------------------------------------------- */
/*                    2. and grants nothing to anybody else                   */
/* -------------------------------------------------------------------------- */

/**
 * THE ATTACK: READ A NOTE NAMED TO SOMEBODY ELSE.
 *
 * `outsider` holds the same role as `insider`, in the same workspace, in the
 * same database. Everything they are refused here, `insider` is granted three
 * tests above — so a refusal that came from the fixture rather than the gate
 * would have taken both.
 */
describe("a member outside the named set reaches nothing", () => {
  test("the folder is empty to them", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.outsider, "2-areas")).toEqual([]);
  });

  test("the note is not found, not forbidden", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    const refused = await captureError(() =>
      asUser(f.t, f.outsider).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/hr.md",
      }),
    );
    expect(errorCode(refused)).toBe("FILE_NOT_FOUND");
  });

  test("the folder does not appear in their root listing", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.outsider, "")).not.toContain("2-areas");
  });

  /**
   * An **editor**, so the role ladder lets the call through and the privacy
   * engine is the only thing left to stop it. The pair below is the point: the
   * same role, the same call, one in the group and one not.
   */
  test("an editor outside the named set cannot write into it", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    const refused = await captureError(() =>
      asUser(f.t, f.editorOutside).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/sneaky.md",
        text: "# Sneaky\n",
      }),
    );
    expect(errorCode(refused)).toBe("FILE_NOT_FOUND");
    expect(f.backend.snapshot()["2-areas/sneaky.md"]).toBeUndefined();
  });

  test("an editor inside it can", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    await asUser(f.t, f.editorInside).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/allowed.md",
      text: "# Allowed\n",
    });
    expect(f.backend.snapshot()["2-areas/allowed.md"]).toContain("# Allowed");
  });

  test("a person who is not the one named reaches nothing", async () => {
    const f = await fixture({ folder: "2-areas", name: "@kola" });
    expect(await listing(f, f.outsider, "2-areas")).toEqual([]);
    expect(await listing(f, f.insider, "2-areas")).toEqual([]);
  });

  test("what they CAN see is unchanged, so the refusal is about the rule", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.outsider, "3-resources")).toContain("open.md");
  });
});

/* -------------------------------------------------------------------------- */
/*                 3. a name grants only through live membership              */
/* -------------------------------------------------------------------------- */

describe("a granted name is intersected with live membership", () => {
  /**
   * Off-boarding, which is the promise the group split was built for: the name
   * in the customer's bucket never changes, and one control-plane row closes
   * the folder. Asserted before and after in one test, because "they cannot
   * see it" is worth nothing unless they could a moment earlier.
   */
  test("dropping somebody from the group closes the folder to them", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.insider, "2-areas")).toContain("hr.md");

    const groups = await asUser(f.t, f.owner).query(api.functions.groups.listGroups, {
      workspaceId: f.workspaceId,
    });
    await asUser(f.t, f.owner).mutation(api.functions.groups.removeGroupMember, {
      workspaceId: f.workspaceId,
      groupId: groups[0].groupId,
      userId: f.insider,
    });

    expect(await listing(f, f.insider, "2-areas")).toEqual([]);
    // The bucket was never touched: the rule still names the group.
    expect(f.backend.snapshot()[PRIVACY_KEY]).toContain("2-areas: @atlas-leads");
  });

  test("a group row left behind by somebody who left the workspace is inert", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    // They keep the group row; they lose the workspace.
    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect();
      const row = membership.find((entry) => entry.userId === f.insider);
      if (row !== undefined) await ctx.db.delete(row._id);
    });
    const stale = await f.t.run(async (ctx) =>
      ctx.db
        .query("workspaceGroupMembers")
        .withIndex("by_user", (q) => q.eq("userId", f.insider))
        .collect(),
    );
    // The row really is still there, so the refusal below is the intersection
    // doing its job rather than the row having been swept.
    expect(stale.length).toBe(1);

    const refused = await captureError(() =>
      asUser(f.t, f.insider).action(api.functions.files.listFiles, {
        workspaceId: f.workspaceId,
        path: "2-areas",
      }),
    );
    expect(refused).toBeDefined();
  });

  /**
   * THE ATTACK: REACH A RULE THROUGH A GROUP ITS OWNER CANNOT SEE.
   *
   * The first version of this test had the second workspace's group named
   * `leads` too and asserted the refusal — and it passed with **both**
   * workspace checks deleted from the resolver, because `buildGroupName`
   * derives the name from the slug, so that group is `@elsewhere-leads` and
   * could never have matched `@atlas-leads` whatever the resolver did. It was
   * a test of the naming scheme wearing a tenancy test's clothes. Found by
   * sabotage, which is the only thing that could have found it.
   *
   * The real attack is the manifest naming the *other* workspace's group. An
   * owner edits `privacy.md` by hand — the customer owns that file — and
   * writes `@elsewhere-leads`, a name they cannot resolve and whose membership
   * is set by somebody else entirely. Without the workspace check, anybody who
   * is a member here AND in that foreign group reads the folder, and the owner
   * of this context has no way to see who that is.
   */
  test("a group belonging to another workspace grants nothing here", async () => {
    // Built in one database: the rule names a group of `elsewhere`, and
    // `outsider` is a live member of BOTH workspaces and of that group.
    const f = await fixture({ folder: "2-areas", name: "@elsewhere-leads" });
    const otherWorkspace = await createWorkspace(f.t, f.outsider, "elsewhere", {
      kind: "shared",
      displayName: "Elsewhere",
    });
    const theirs = await asUser(f.t, f.outsider).mutation(
      api.functions.groups.createGroup,
      { workspaceId: otherWorkspace, label: "leads" },
    );
    await asUser(f.t, f.outsider).mutation(api.functions.groups.addGroupMember, {
      workspaceId: otherWorkspace,
      groupId: theirs.groupId,
      userId: f.outsider,
    });
    // Non-vacuity: the group really is called what the rule names, so a
    // refusal below is the workspace check and not a spelling mismatch.
    expect(theirs.name).toBe("elsewhere-leads");

    expect(await listing(f, f.outsider, "2-areas")).toEqual([]);
    const refused = await captureError(() =>
      asUser(f.t, f.outsider).action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/hr.md",
      }),
    );
    expect(errorCode(refused)).toBe("FILE_NOT_FOUND");
  });
});

/* -------------------------------------------------------------------------- */
/*              4. the resolver's own guards, reached directly                */
/* -------------------------------------------------------------------------- */

/**
 * TWO GUARDS THE PUBLIC API CANNOT REACH, AND WHY THEY ARE STILL TESTED.
 *
 * Sabotage found both of these unprotected after everything above was green:
 * deleting the membership check, and deleting the `resolveAddressedUser`
 * authority, each left all sixteen tests passing.
 *
 * Neither is dead code. They are unreachable *through `listFiles`* because
 * `authorizeFileAccess` refuses a non-member before the resolver is called at
 * all, and because a handle normally resolves to the person who owns it. They
 * are the guards that hold when a future caller does neither — and this
 * repository's rule is that a guard nobody has checked is not a guard, so they
 * are driven directly rather than left to a caller's good manners.
 */
describe("the resolver refuses on its own authority", () => {
  test("somebody who is not a member of the workspace is granted no name", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect();
      const row = rows.find((entry) => entry.userId === f.insider);
      if (row !== undefined) await ctx.db.delete(row._id);
    });

    const names = await f.t.run((ctx) =>
      grantedNamesFor(ctx, f.workspaceId, f.insider),
    );
    expect(names).toEqual([]);
  });

  /**
   * `resolveAddressedUser` answers `null` for a personal workspace with
   * anything other than exactly one owner — "this function decides who may
   * reach a context, and the one thing it must never do is pick". A handle
   * whose ownership is ambiguous must therefore grant nothing, and the
   * gathering step alone would have granted it: `identifiersForUser` yields
   * the slug for any personal workspace the caller owns a row in.
   */
  test("an ambiguously-owned handle grants nothing", async () => {
    const f = await fixture({ folder: "2-areas", name: "@kola" });
    const before = await f.t.run((ctx) => grantedNamesFor(ctx, f.workspaceId, f.kola));
    expect(before).toContain("kola");

    // A second owner on Kola's personal workspace. Nobody can now say whose
    // handle `@kola` is, so it is nobody's.
    await f.t.run(async (ctx) => {
      const claim = await ctx.db
        .query("names")
        .withIndex("by_name", (q) => q.eq("name", "kola"))
        .unique();
      if (claim?.workspaceId === undefined) throw new Error("no @kola workspace");
      await ctx.db.insert("workspaceMembers", {
        workspaceId: claim.workspaceId,
        userId: f.outsider,
        role: "owner",
        joinedAt: Date.now(),
      });
    });

    const after = await f.t.run((ctx) => grantedNamesFor(ctx, f.workspaceId, f.kola));
    expect(after).not.toContain("kola");
    expect(await listing(f, f.kola, "2-areas")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                           5. the owner is unmoved                          */
/* -------------------------------------------------------------------------- */

describe("an owner reads at private scope and is unaffected", () => {
  test("they see a folder named to a group they are not in", async () => {
    const f = await fixture({ folder: "2-areas", name: "@atlas-leads" });
    expect(await listing(f, f.owner, "2-areas")).toContain("hr.md");
  });
});
