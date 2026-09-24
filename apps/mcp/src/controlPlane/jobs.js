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
      const ticket = required(parsed, "ticket");
      if (typeof ticket !== "string" || ticket.length === 0) {
        throw new ControlPlaneError("malformed job ticket");
      }
      return ticket;
    },

    async openGatewayJob(ticket) {
      const parsed = await post("/gateway/jobs/open", { ticket });
      const job = required(parsed, "job");
      if (job === null) return null;
      if (!job || typeof job !== "object") throw new ControlPlaneError("malformed job");
      return job;
    },

    async reportGatewayJob(ticket, result) {
      await post("/gateway/jobs/report", { ticket, result });
    },
  };
}
