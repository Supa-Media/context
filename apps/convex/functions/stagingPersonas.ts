/** Operator-only fixtures. No public seed endpoint and no production writes. */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { stagingStorageIsFree } from "./lib/managedStorage";
import { claimName, findName } from "./lib/nameClaims";
import { seedIngestionSettings } from "./lib/ingestionStore";

export const PERSONAS = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;
type Persona = typeof PERSONAS[number];
type Role = "owner" | "editor" | "member";
export const FIXTURES: { slug: string; name: string; owner: Persona; kind: "personal" | "shared"; roles: Partial<Record<Persona, Role>> }[] = [
  { slug: "alpha-morgan", name: "Alpha Morgan", owner: "alpha", kind: "personal", roles: { alpha: "owner" } },
  { slug: "delta-brooks", name: "Delta Brooks", owner: "delta", kind: "personal", roles: { delta: "owner" } },
  { slug: "lumio", name: "Lumio", owner: "alpha", kind: "shared", roles: { alpha: "owner", beta: "editor", gamma: "member" } },
  { slug: "maison-solenne", name: "Maison Solenne", owner: "delta", kind: "shared", roles: { delta: "owner", alpha: "editor", beta: "member" } },
  { slug: "common-ground", name: "Common Ground", owner: "delta", kind: "shared", roles: { delta: "owner", beta: "editor", gamma: "member" } },
];
const displayNames = ["Alpha Morgan", "Beta Chen", "Gamma Ellis", "Delta Brooks", "Epsilon Reed"];

export const prepare = internalMutation({
  args: { reset: v.optional(v.boolean()) },
  handler: async (ctx, { reset }) => {
    if (!stagingStorageIsFree()) throw new Error("Staging personas require the isolated staging deployment.");
    const now = Date.now();
    const users = {} as Record<Persona, Id<"users">>;
    for (const [i, persona] of PERSONAS.entries()) {
      const email = `${persona}@supa.media`;
      const existing = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", email)).unique();
      users[persona] = existing?._id ?? await ctx.db.insert("users", {
        email, emailVerificationTime: now, name: displayNames[i], isActive: true, createdAt: now,
      });
    }
    const workspaces: { slug: string; workspaceId: Id<"workspaces">; owner: Persona }[] = [];
    for (const fixture of FIXTURES) {
      const claim = await findName(ctx, fixture.slug);
      let workspaceId = claim?.workspaceId;
      if (claim) {
        const workspace = workspaceId ? await ctx.db.get(workspaceId) : null;
        if (!workspace || workspace.createdBy !== users[fixture.owner] || workspace.kind !== fixture.kind) {
          throw new Error(`Fixture name collision: ${fixture.slug}; nothing was changed.`);
        }
      } else {
        workspaceId = await ctx.db.insert("workspaces", {
          slug: fixture.slug, displayName: fixture.name, createdBy: users[fixture.owner],
          kind: fixture.kind, structureTemplate: "para", createdAt: now, updatedAt: now,
        });
        await claimName(ctx, fixture.slug, users[fixture.owner], { kind: "workspace", workspaceId });
      }
      const id = workspaceId!;
      const memberships = await ctx.db.query("workspaceMembers").withIndex("by_workspace", q => q.eq("workspaceId", id)).collect();
      // A reset may remove fixture identities, never an unrelated teammate.
      if (memberships.some(m => !Object.values(users).includes(m.userId))) {
        throw new Error(`Non-fixture member in ${fixture.slug}; refusing to reset their workspace.`);
      }
      for (const persona of PERSONAS) {
        const role = fixture.roles[persona];
        const member = memberships.find(m => m.userId === users[persona]);
        if (role && !member) await ctx.db.insert("workspaceMembers", { workspaceId: id, userId: users[persona], role, joinedAt: now });
        else if (role && member && reset) await ctx.db.patch(member._id, { role });
        else if (!role && member && reset) await ctx.db.delete(member._id);
      }
      if (!claim && fixture.kind === "personal") await seedIngestionSettings(ctx, { workspaceId: id, ownerUserId: users[fixture.owner], now });
      workspaces.push({ slug: fixture.slug, workspaceId: id, owner: fixture.owner });
    }
    const lumio = workspaces.find(w => w.slug === "lumio")!;
    const invitations = await ctx.db.query("workspaceInvitations").withIndex("by_workspace_status", q => q.eq("workspaceId", lumio.workspaceId).eq("status", "pending")).collect();
    const existing = invitations.find(i => i.invitee === "epsilon@supa.media");
    const epsilonMember = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", q => q.eq("workspaceId", lumio.workspaceId).eq("userId", users.epsilon)).unique();
    if (reset || (!epsilonMember && (!existing || existing.expiresAt <= now))) {
      if (existing) await ctx.db.patch(existing._id, { status: "revoked", respondedAt: now });
      await ctx.db.insert("workspaceInvitations", {
        workspaceId: lumio.workspaceId, inviteeKind: "email", invitee: "epsilon@supa.media", role: "editor",
        invitedBy: users.alpha, token: crypto.randomUUID(), status: "pending",
        expiresAt: now + 7 * 24 * 60 * 60 * 1000, createdAt: now,
      });
    }
    return { workspaces };
  },
});
