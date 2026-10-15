/**
 * Gateway job tickets: create, open and report the result of a job the
 * control plane runs on the gateway's behalf.
 */
import { ControlPlaneError } from "./client.js";

export function createJobMethods({ post, required }) {
  return {
    async createGatewayJob(accessToken, expectedWorkspaceId, job) {
      const parsed = await post("/gateway/jobs/create", {
        accessToken,
        expectedWorkspaceId,
        job,
      });
      if (parsed?.alreadyActive === true) return null;
      const ticket = required(parsed, "ticket");
      if (typeof ticket !== "string" || ticket.length === 0) {
        throw new ControlPlaneError("malformed job ticket");
      }
      return ticket;
    },

    /** `contentSha256`: an image upload's ticket opens only for the bytes it was minted for. */
    async openGatewayJob(ticket, { contentSha256 } = {}) {
      const parsed = await post("/gateway/jobs/open", { ticket, ...(contentSha256 ? { contentSha256 } : {}) });
      const job = required(parsed, "job");
      if (job === null) return null;
      if (!job || typeof job !== "object") throw new ControlPlaneError("malformed job");
      return job;
    },

    async reportGatewayJob(ticket, result) {
      await post("/gateway/jobs/report", { ticket, result });
    },

    /**
     * Spend a mover ticket (`moves/mover.js`): one page of one workspace's
     * whole-bucket move, with both buckets' credentials. `null` when the
     * ticket is spent, expired, or no longer matches the move.
     */
    async openMoverPage(ticket) {
      const parsed = await post("/gateway/mover/open", { ticket });
      const page = required(parsed, "page");
      if (page === null) return null;
      if (!page || typeof page !== "object") throw new ControlPlaneError("malformed mover page");
      return page;
    },
  };
}
