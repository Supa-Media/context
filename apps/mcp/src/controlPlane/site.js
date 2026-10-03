/**
 * A website's status, or a publish, for an agent on an owner's or editor's
 * connection — `write_note`'s `site` argument (`../tools/notes/site.js`).
 */
import { ControlPlaneError } from "./client.js";

export function createSiteMethods({ post, required }) {
  return {
    /**
     * `{ action: "status" | "check" | "publish", draft?, inspect? }` in; the control plane's
     * answer out, or `null` for every refusal — not an owner or editor, no
     * write scope, no such workspace — so nothing here can tell them apart.
     */
    async site(accessToken, expectedWorkspaceId, request) {
      const parsed = await post("/gateway/site", {
        accessToken,
        expectedWorkspaceId,
        action: request.action,
        ...(typeof request.draft === "string" ? { draft: request.draft } : {}),
        ...(typeof request.inspect === "string" ? { path: request.inspect } : {}),
      });
      const site = required(parsed, "site");
      if (site === null) return null;
      if (!site || typeof site !== "object") throw new ControlPlaneError("malformed site");
      return site;
    },
  };
}
