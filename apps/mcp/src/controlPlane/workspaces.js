/**
 * Setting a workspace up through an agent: a new shared workspace, its
 * starting layout or one built-in folder, the page where the person connects
 * Google, and invitations into a shared one (`/gateway/workspaces/*`,
 * `apps/convex/functions/lib/gatewayRoutes/workspaces.ts`).
 *
 * Each answers what the control plane said, or `null` for a caller it did not
 * clear: one answer for a token, a workspace or a scope that does not, so
 * nothing here reconstructs a reason it was not given.
 */
import { CONTROL_PLANE_SITE_TIMEOUT_MS, ControlPlaneError } from "./client.js";

function objectOrNull(value, what) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlPlaneError(`malformed ${what}`);
  return value;
}

export function createWorkspaceMethods({ post, required }) {
  return {
    /** `{ok, slug, storage}`, `{ok: true, dryRun, available, normalized, message?}`, `{ok: false, message}` or null. */
    async createWorkspace(accessToken, expectedWorkspaceId, request) {
      const parsed = await post("/gateway/workspaces/create", { accessToken, expectedWorkspaceId, ...request });
      return objectOrNull(required(parsed, "workspace"), "workspace");
    },

    /**
     * `{ok, queued?, folders}`, `{ok: false, message}` or null. A built-in
     * folder is written into the bucket before the answer, so this waits as
     * long as a website check does.
     */
    async layoutWorkspace(accessToken, expectedWorkspaceId, request) {
      const parsed = await post(
        "/gateway/workspaces/layout",
        { accessToken, expectedWorkspaceId, ...request },
        { timeoutMs: CONTROL_PLANE_SITE_TIMEOUT_MS }
      );
      return objectOrNull(required(parsed, "layout"), "layout");
    },

    /** `{ok: true, invited}`, `{ok: false, message}` or null. */
    async inviteToWorkspace(accessToken, expectedWorkspaceId, invitations) {
      const parsed = await post("/gateway/workspaces/invite", { accessToken, expectedWorkspaceId, invitations });
      return objectOrNull(required(parsed, "invite"), "invite");
    },

    /** `{ok: true, url}`, `{ok: false, message}` or null. */
    async connectGoogle(accessToken, expectedWorkspaceId, kind) {
      const parsed = await post("/gateway/workspaces/connect-google", { accessToken, expectedWorkspaceId, kind });
      return objectOrNull(required(parsed, "google"), "google");
    },
  };
}
