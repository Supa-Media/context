/**
 * `/gateway/workspaces/*` for the stub, cleared as the real route clears them
 * (`apps/convex/functions/lib/gatewayRoutes/workspaces.ts`): a live grant, the
 * workspace named inside its reach, and its `context:write`. A stub laxer than
 * that would let every isolation test below pass on the stub's manners.
 */

const NAME = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(["brain", "brains", "workspace", "context", "admin"]);
const LAYOUTS = {
  para: ["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"],
  business: ["0-inbox", "1-projects", "2-areas", "3-resources", "4-clients", "5-teams", "9-archive"],
  product: ["0-inbox", "1-projects", "2-areas", "3-resources", "5-teams", "6-products", "9-archive"],
};
const FOLDERS = { clients: "4-clients", teams: "5-teams", products: "6-products" };

export function createWorkspaceRoutes({ grantForAccessToken, coveredContexts, workspaces, grants }) {
  const calls = [];

  async function clear(body) {
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant || !grant.scopes.includes("context:write")) return null;
    const entry = coveredContexts(grant).find((row) => row.workspaceId === body.expectedWorkspaceId);
    return entry ? { grant, entry } : null;
  }

  function nameProblem(slug) {
    if (!NAME.test(slug)) return "Use 3 to 32 lowercase letters, digits and hyphens.";
    if (RESERVED.has(slug)) return "That name is reserved.";
    if ([...workspaces.values()].some((row) => row.slug === slug)) return "That name is taken.";
    return null;
  }

  async function handle(path, body) {
    switch (path) {
      case "/gateway/workspaces/create": {
        const cleared = await clear(body);
        if (!cleared) return { workspace: null };
        const slug = String(body.slug ?? "").toLowerCase();
        const problem = nameProblem(slug);
        calls.push({ path, userId: cleared.grant.userId, slug, dryRun: body.dryRun === true, invitations: body.invitations });
        if (body.dryRun === true) {
          return { workspace: { ok: true, dryRun: true, available: problem === null, normalized: slug, ...(problem ? { message: problem } : {}) } };
        }
        if (problem) return { workspace: { ok: false, message: problem } };
        const workspaceId = `ws_created_${calls.length}`;
        workspaces.set(workspaceId, { slug, kind: "shared" });
        // The real person is now its owner, so every grant of theirs reaches it.
        for (const grant of grants.values()) {
          if (grant.userId === cleared.grant.userId) grant.alsoMemberOf = [...(grant.alsoMemberOf || []), { workspaceId, role: "owner" }];
        }
        const invited = Array.isArray(body.invitations) ? body.invitations.length : 0;
        return { workspace: { ok: true, slug, storage: "starting", ...(invited > 0 ? { invited } : {}) } };
      }
      case "/gateway/workspaces/layout": {
        const cleared = await clear(body);
        if (!cleared) return { layout: null };
        calls.push({ path, userId: cleared.grant.userId, workspaceId: cleared.entry.workspaceId, template: body.template, role: body.role, job: body.job, jobPath: body.path });
        if (body.job !== undefined) {
          // As `giveJobHandler`: owner only; the real refusals are the control plane's own tests.
          if (cleared.entry.role !== "owner") return { layout: { ok: false, message: "Only an owner of this workspace can choose which folder does a job." } };
          if (body.job === "archive" && typeof body.path === "string" && body.path.includes("/")) return { layout: { ok: false, message: "Archive stays at the top of the workspace." } };
          return { layout: { ok: true, job: body.job, folders: body.path === null ? [] : [body.path] } };
        }
        if (body.role !== undefined) {
          if (cleared.entry.role !== "owner" && cleared.entry.role !== "editor") return { layout: { ok: false, message: "Adding a folder needs an owner or an editor of this workspace." } };
          return FOLDERS[body.role] ? { layout: { ok: true, folders: [FOLDERS[body.role]] } } : { layout: null };
        }
        if (cleared.entry.role !== "owner") return { layout: { ok: false, message: "Only an owner of this workspace can choose its layout." } };
        return LAYOUTS[body.template] ? { layout: { ok: true, queued: true, folders: LAYOUTS[body.template] } } : { layout: null };
      }
      case "/gateway/workspaces/invite": {
        // As `gatewayWorkspacesInviteHandler`: a shared workspace, by its owner.
        const cleared = await clear(body);
        if (!cleared || !Array.isArray(body.invitations) || body.invitations.length === 0) return { invite: null };
        calls.push({ path, userId: cleared.grant.userId, workspaceId: cleared.entry.workspaceId, invitations: body.invitations });
        if (cleared.entry.kind !== "shared") return { invite: { ok: false, message: "People are invited into a shared workspace; a personal one stays yours." } };
        if (cleared.entry.role !== "owner") return { invite: { ok: false, message: "Only an owner of this workspace can invite people into it." } };
        return { invite: { ok: true, invited: body.invitations.length } };
      }
      case "/gateway/workspaces/connect-google": {
        const cleared = await clear(body);
        if (!cleared) return { google: null };
        calls.push({ path, userId: cleared.grant.userId, workspaceId: cleared.entry.workspaceId, kind: body.kind });
        if (cleared.entry.kind !== "personal" || cleared.entry.role !== "owner") {
          return { google: { ok: false, message: "Google connects only to your own personal workspace, by its owner." } };
        }
        return { google: { ok: true, url: `https://app.context.test/console/@${cleared.entry.slug}?settings=integrations` } };
      }
      default:
        return undefined;
    }
  }

  return { handle, calls };
}
