/**
 * GROUPS — a name in the manifest, a fact in the control plane.
 *
 * A privacy rule may name a group (`2-areas/feedback: @supa-leads`) and this is
 * the object behind that name. Three things are being proved, and they are the
 * three the design rests on.
 *
 * **The intersection.** A group row grants nothing by itself:
 * `resolveGroupMembers` intersects it with live workspace membership, so a name
 * left behind by somebody who left the workspace reaches nobody. That property
 * is what lets `privacy.md` carry a reference nothing in the bucket can check,
 * and it is what makes off-boarding one Convex change instead of a sweep
 * through every folder rule.
 *
 * **The prefix.** Group names share one global namespace with usernames and
 * workspace slugs, so the name is assembled from the workspace's own slug
 * rather than accepted from the caller. A workspace cannot mint a name inside
 * another's space, and a group cannot take a name a person already has.
 *
 * **Owner-only, in both directions.** Reading the groups is owner-only for the
 * reason the note census is — a member who could enumerate them could derive
 * the shape of what is kept from them — and writing is owner-only because a
 * group is an access control.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";

async function workspace() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const outsider = await createUser(t, "outsider@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "supa", {
    kind: "shared",
    displayName: "Supa",
  });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);

  return { t, owner, editor, member, outsider, workspaceId };
}

describe("a group takes its workspace's slug, and claims it once", () => {
  test("the name is assembled from the slug, not from what the caller typed", async () => {
    const { t, owner, workspaceId } = await workspace();
    const created = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    expect(created.name).toBe("supa-leads");
  });

  test("a label naming another workspace still lands under this one", async () => {
    const { t, owner, workspaceId } = await workspace();
    const created = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "publicworship-staff",
    });
    expect(created.name).toBe("supa-publicworship-staff");
  });

  test("the name is claimed in the shared namespace, so nothing else can take it", async () => {
    const { t, owner, workspaceId } = await workspace();
    await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    const again = await captureError(() =>
      asUser(t, owner).mutation(api.functions.groups.createGroup, {
        workspaceId,
        label: "leads",
      }),
    );
    expect(String(again)).toMatch(/NAME_TAKEN/);
  });

  test("a malformed label is refused with a sentence, not a stack trace", async () => {
    const { t, owner, workspaceId } = await workspace();
    const bad = await captureError(() =>
      asUser(t, owner).mutation(api.functions.groups.createGroup, {
        workspaceId,
        label: "leads_team",
      }),
    );
    // The sentence a person actually sees, not a code: this is the one place
    // a bad label is explained, and `describeRejection` owns the wording.
    expect(String(bad)).toMatch(/lowercase letters, numbers, and hyphens/);
  });
});

describe("a group row grants nothing on its own", () => {
  /**
   * The property the whole split rests on. The manifest keeps `@supa-leads`
   * whatever happens here; what changes is who that resolves to.
   */
  test("removing somebody from the workspace removes them from every group at once", async () => {
    const { t, owner, editor, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    await asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
      workspaceId,
      groupId,
      userId: editor,
    });

    const before = await asUser(t, owner).query(api.functions.groups.listGroups, { workspaceId });
    expect(before[0].members.map((m) => m.live)).toEqual([true]);

    await asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId,
      userId: editor,
    });

    const after = await asUser(t, owner).query(api.functions.groups.listGroups, { workspaceId });
    // The row survives — the group still NAMES them — and it reaches nothing.
    expect(after[0].members.map((m) => m.live)).toEqual([false]);
  });

  test("somebody who was never a member cannot be named at all", async () => {
    const { t, owner, outsider, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    const refused = await captureError(() =>
      asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
        workspaceId,
        groupId,
        userId: outsider,
      }),
    );
    // Not redundant with the intersection: a row that reaches nothing but reads
    // as though it does is worse in an owner's list than a refusal.
    expect(String(refused)).toMatch(/NOT_A_MEMBER/);
  });

  test("naming the same person twice is a no-op, not a duplicate row", async () => {
    const { t, owner, editor, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    for (let i = 0; i < 2; i += 1) {
      await asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
        workspaceId,
        groupId,
        userId: editor,
      });
    }
    const groups = await asUser(t, owner).query(api.functions.groups.listGroups, { workspaceId });
    expect(groups[0].members).toHaveLength(1);
  });
});

describe("groups are owner-only, in both directions", () => {
  test("an editor cannot read them", async () => {
    const { t, owner, editor, workspaceId } = await workspace();
    await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    const refused = await captureError(() =>
      asUser(t, editor).query(api.functions.groups.listGroups, { workspaceId }),
    );
    expect(refused).not.toBeNull();
  });

  test("an editor cannot create one", async () => {
    const { t, editor, workspaceId } = await workspace();
    const refused = await captureError(() =>
      asUser(t, editor).mutation(api.functions.groups.createGroup, {
        workspaceId,
        label: "leads",
      }),
    );
    expect(refused).not.toBeNull();
  });

  test("a member cannot add themselves to one", async () => {
    const { t, owner, member, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    const refused = await captureError(() =>
      asUser(t, member).mutation(api.functions.groups.addGroupMember, {
        workspaceId,
        groupId,
        userId: member,
      }),
    );
    expect(refused).not.toBeNull();
  });
});

describe("one workspace's groups are not another's", () => {
  test("an owner of another context cannot reach this one's group by id", async () => {
    const { t, owner, outsider, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    const otherWorkspace = await createWorkspace(t, outsider, "other-context", {
      kind: "shared",
    });

    const refused = await captureError(() =>
      asUser(t, outsider).mutation(api.functions.groups.addGroupMember, {
        workspaceId: otherWorkspace,
        groupId,
        userId: outsider,
      }),
    );
    // The same refusal a group that does not exist gets, so the id is not an
    // oracle for what lives in somebody else's context.
    expect(String(refused)).toMatch(/GROUP_NOT_FOUND/);
  });
});

describe("deleting a group releases its name and touches no bucket", () => {
  test("the name can be claimed again afterwards", async () => {
    const { t, owner, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    await asUser(t, owner).mutation(api.functions.groups.deleteGroup, { workspaceId, groupId });

    // Leaving the claim behind would make a deleted group a permanent
    // reservation in a namespace shared with every username.
    const again = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    expect(again.name).toBe("supa-leads");
  });

  test("its membership rows go with it", async () => {
    const { t, owner, editor, workspaceId } = await workspace();
    const { groupId } = await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    await asUser(t, owner).mutation(api.functions.groups.addGroupMember, {
      workspaceId,
      groupId,
      userId: editor,
    });
    await asUser(t, owner).mutation(api.functions.groups.deleteGroup, { workspaceId, groupId });
    expect(
      await asUser(t, owner).query(api.functions.groups.listGroups, { workspaceId }),
    ).toEqual([]);
  });
});

/**
 * Pointing one note at a group — the share dialog's verb.
 *
 * `setNoteVisibility` takes the two tiers and stays that way, so this is its
 * own action. What is NEW here is the resolution: group names are globally
 * unique, but a name belonging to somebody else's context has to be as
 * unusable here as one that exists nowhere. That check runs before any file
 * operation, which is why these tests need no bucket.
 *
 * The write itself — a group value reaching `privacy.md` — is covered where
 * there is a store to write to: `fileOps.test.ts`, over the memory bucket that
 * file already stands up. Driving it from here would mean standing up a second
 * fake S3, and a test that proves the writer works belongs beside the writer.
 */
describe("handing one note to a group", () => {
  /**
   * The one that matters. `@other-leads` is a real, unique, existing name —
   * and it is not this context's, so it must be refused exactly as a name
   * nobody has ever claimed is. Writing it would not leak (the engines read an
   * unresolvable group as reaching nobody) but it would put a rule in the
   * customer's manifest that no owner of this context can account for.
   */
  test("a group belonging to another context is refused, like one that does not exist", async () => {
    const { t, owner, outsider, workspaceId } = await workspace();
    const otherWorkspace = await createWorkspace(t, outsider, "other", { kind: "shared" });
    await asUser(t, outsider).mutation(api.functions.groups.createGroup, {
      workspaceId: otherWorkspace,
      label: "leads",
    });

    const borrowed = await captureError(() =>
      asUser(t, owner).action(api.functions.files.setNoteGroup, {
        workspaceId,
        path: "1-projects/rates.md",
        group: "@other-leads",
      }),
    );
    const invented = await captureError(() =>
      asUser(t, owner).action(api.functions.files.setNoteGroup, {
        workspaceId,
        path: "1-projects/rates.md",
        group: "@supa-nothing",
      }),
    );
    expect(String(borrowed)).toMatch(/GROUP_NOT_FOUND/);
    expect(String(invented)).toMatch(/GROUP_NOT_FOUND/);
    // Byte-identical, so a caller cannot use the refusal to discover that a
    // name exists in a context they are not in.
    expect(String(borrowed)).toBe(String(invented));
  });

  test("an editor cannot point a note at a group", async () => {
    const { t, owner, editor, workspaceId } = await workspace();
    await asUser(t, owner).mutation(api.functions.groups.createGroup, {
      workspaceId,
      label: "leads",
    });
    const refused = await captureError(() =>
      asUser(t, editor).action(api.functions.files.setNoteGroup, {
        workspaceId,
        path: "1-projects/rates.md",
        group: "@supa-leads",
      }),
    );
    expect(refused).not.toBeNull();
    // Refused for the role, before the group is even looked up.
    expect(String(refused)).not.toMatch(/GROUP_NOT_FOUND/);
  });
});
