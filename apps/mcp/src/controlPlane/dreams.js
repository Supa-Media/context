/**
 * Tex's dream now, asked for with `dream_now` (`tools/dreamNow.js`).
 */

const STATUSES = new Set(["started", "running", "recent", "not_included", "daily_limit", "unavailable", "not_texting"]);

export function createDreamMethods({ post }) {
  return {
    /**
     * Ask for a dream now as the person this token belongs to, in
     * `workspaceId`. The token is forwarded verbatim; the control plane
     * clears the owner from it and decides. Answers `{ status, retryAt? }`
     * with a known status, or `null` for a caller who may not ask (one answer
     * for every reason) or an answer this gateway does not know.
     */
    async dreamNow(accessToken, workspaceId) {
      const parsed = await post("/gateway/dreams/start", { accessToken, expectedWorkspaceId: workspaceId });
      const dream = parsed?.dream;
      if (!dream || typeof dream.status !== "string" || !STATUSES.has(dream.status)) return null;
      return { status: dream.status, ...(typeof dream.retryAt === "number" ? { retryAt: dream.retryAt } : {}) };
    },
  };
}
