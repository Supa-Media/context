/**
 * "Put the setup checklist away" is remembered on the membership, so the
 * "You're set up." card stays away on every device and origin, not only in the
 * browser that closed it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `setupRetired` left off the summary row                          2 failed
 *   handler patching without the already-set guard                    1 failed
 *   handler dropping `requireWorkspaceAccess`                         1 failed
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

async function fixture() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, member, "editor", owner);
  return { t, owner, member, stranger, workspaceId };
}

async function retiredFor(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  user: Awaited<ReturnType<typeof fixture>>["owner"],
  slug: string,
) {
  const rows = await asUser(t, user).query(api.functions.workspaces.listMyWorkspaces, {});
  return rows.find((row) => row.slug === slug)?.setupRetired;
}

describe("retireSetupWidget", () => {
  test("a new membership has not put the checklist away", async () => {
    const { t, owner } = await fixture();
    expect(await retiredFor(t, owner, "atlas")).toBe(false);
  });

  test("putting it away is on the account, for that member only", async () => {
    const { t, owner, member, workspaceId } = await fixture();
    await asUser(t, owner).mutation(api.functions.workspaces.retireSetupWidget, { workspaceId });
    expect(await retiredFor(t, owner, "atlas")).toBe(true);
    expect(await retiredFor(t, member, "atlas")).toBe(false);
  });

  test("a second press does not move the stamp", async () => {
    const { t, owner, workspaceId } = await fixture();
    const as = asUser(t, owner);
    await as.mutation(api.functions.workspaces.retireSetupWidget, { workspaceId });
    const stamp = async () =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", workspaceId).eq("userId", owner),
          )
          .unique();
        return row?.setupRetiredAt;
      });
    const first = await stamp();
    expect(first).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await as.mutation(api.functions.workspaces.retireSetupWidget, { workspaceId });
    expect(await stamp()).toBe(first);
  });

  test("somebody who is not a member is refused, and nothing is written", async () => {
    const { t, stranger, workspaceId } = await fixture();
    await expect(
      asUser(t, stranger).mutation(api.functions.workspaces.retireSetupWidget, { workspaceId }),
    ).rejects.toThrow();
    const rows = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows.every((row) => row.setupRetiredAt === undefined)).toBe(true);
  });
});
