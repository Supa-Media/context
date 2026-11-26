/**
 * An answer held from a group chat, and the asker's yes that shares it (`apps/convex/functions/groupHolds.ts`).
 * Neither call carries a word of the answer: the hold is its workspaces (who was there is the token's own, kept by the control plane), and
 * the yes is which chat. Each answers `{ status, ... }`, or null when the control plane's answer can't be read.
 */

const answered = (parsed) => (parsed && typeof parsed === "object" && typeof parsed.status === "string" ? parsed : null);

export function createGroupHoldMethods({ post }) {
  return {
    /** The group turn's own token: `{ id, slugs }` held for the tagger. `{ status: "held" | "refused" | "bad_request" }`. */
    async groupHold(accessToken, { id, slugs }) {
      return answered(await post("/gateway/group/hold", { accessToken, id, slugs }));
    },
    /** The asker's own 1:1 token: share their hold in the chat `groupKey` (`id`, or their newest there). `{ status, slugs? }`. */
    async groupShare(accessToken, { groupKey, id }) {
      return answered(await post("/gateway/group/share", { accessToken, groupKey, ...(typeof id === "string" ? { id } : {}) }));
    },
  };
}
