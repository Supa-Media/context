/**
 * Getting the person's attention, asked for with `notify_me` (`tools/attention.js`).
 */

const STATUSES = new Set(["soon", "later", "limit", "held", "not_texting"]);

export function createAttentionMethods({ post }) {
  return {
    /**
     * Ask, as the person this token belongs to in `workspaceId`, for one ping
     * of `urgency`; `deliver` false is a ping their settings held, which is
     * counted nowhere. The token is forwarded verbatim; the control plane
     * clears the owner from it and decides. Answers `{ status, dueAt?,
     * timeZone? }` with a known status, or `null` for a caller who may not ask
     * (one answer for every reason) or an answer this gateway does not know.
     */
    async requestAttention(accessToken, workspaceId, urgency, deliver) {
      const parsed = await post("/gateway/attention/ask", {
        accessToken,
        expectedWorkspaceId: workspaceId,
        urgency,
        deliver: deliver === true,
      });
      const attention = parsed?.attention;
      if (!attention || typeof attention.status !== "string" || !STATUSES.has(attention.status)) return null;
      if (attention.status === "not_texting") return { status: "not_texting" };
      if (typeof attention.timeZone !== "string") return null;
      return {
        status: attention.status,
        timeZone: attention.timeZone,
        ...(typeof attention.dueAt === "number" ? { dueAt: attention.dueAt } : {}),
      };
    },
  };
}
