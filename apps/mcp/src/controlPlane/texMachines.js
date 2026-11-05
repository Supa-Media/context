/**
 * A person's own computers ("machines") in the control plane, which keeps only
 * each machine's revocable grant (docs/decisions/texting-assistant/machines.md).
 * Grants and codes go verbatim and are hashed on arrival there; the gateway
 * mints them and verifies the machine's signatures, because the control plane
 * never sees a private key and needs no Ed25519.
 */
import { ControlPlaneError } from "./client.js";

/** The control plane's statuses for a refused `pair_device` approval, as the codes `tools/pairDevice.js` words. */
const APPROVE_REFUSALS = { 401: "UNAUTHORIZED", 403: "INSUFFICIENT_ROLE", 404: "PAIRING_NOT_FOUND", 410: "PAIRING_EXPIRED", 429: "RATE_LIMITED" };

export function createTexMachineMethods({ post }) {
  /** The control plane's refusal code for a 4xx, or null when it was not a refusal. */
  const refusalOf = (error) => (error instanceof ControlPlaneError && error.status >= 400 && error.status < 500 ? error.status : null);
  const call = async (path, body) => {
    try {
      return { ok: true, value: await post(path, body) };
    } catch (error) {
      const status = refusalOf(error);
      if (status === null) throw error;
      return { ok: false, status };
    }
  };
  return {
    /** `{pairingId, expiresAt}`, or `{taken: true}` when the code is in use (mint another). */
    async texMachinePairStart(fields) {
      const answer = await call("/gateway/machines/pair/start", fields);
      if (!answer.ok) return answer.status === 409 ? { taken: true } : { refused: answer.status };
      return { pairingId: answer.value.pairingId, expiresAt: answer.value.expiresAt };
    },
    /** `{status, publicKey, expired}`, or null for an unknown pairing. */
    async texMachinePairRead(pairingId) {
      const answer = await call("/gateway/machines/pair/read", { pairingId });
      return answer.ok ? answer.value : null;
    },
    /** `{machineId, workspaceId, ownerId, name, workspaceHandle}`, or `{refused}`. */
    async texMachinePairClaim(pairingId, grant) {
      const answer = await call("/gateway/machines/pair/claim", { pairingId, grant });
      return answer.ok ? answer.value : { refused: answer.status };
    },
    /** The machine a grant names, or null when the grant is unknown, revoked or its owner gone. */
    async texMachineResolve(grant) {
      const answer = await call("/gateway/machines/resolve", { grant });
      return answer.ok ? answer.value : null;
    },
    async texMachineRegister(fields) {
      const answer = await call("/gateway/machines/register", fields);
      return answer.ok ? answer.value : { refused: answer.status };
    },
    /** `{revoked, workspaceId}`, or null when the machine is not this person's to revoke. */
    async texMachineRevoke(machineId, userId) {
      const answer = await call("/gateway/machines/revoke", { machineId, userId });
      return answer.ok ? answer.value : null;
    },
    /**
     * A run grant for one part of a job on a machine: `{accessToken, expiresAt}`, or null when the job's own grant
     * (`parentToken`, the texting token the job presented) is no longer live or the machine is gone. The control
     * plane keeps only its hash and resolves it as the job's own grant under `context_tex_machine_run`.
     */
    async texMachineRunGrant({ parentToken, machineId, runId, jobId, expiresAt }) {
      const answer = await call("/gateway/machines/run-grant", { parentToken, machineId, runId, ...(typeof jobId === "string" ? { jobId } : {}), expiresAt });
      return answer.ok && typeof answer.value?.accessToken === "string" ? answer.value : null;
    },
    /** `{attached, workspaceId}` when the machine's own owner, a person in the chat, lends it there; else `{refused}`. */
    async texMachineChatAttach(userId, machineId, groupKey) {
      const answer = await call("/gateway/machines/chat/attach", { userId, machineId, groupKey });
      return answer.ok ? answer.value : { refused: answer.status };
    },
    /** `{detached}`, or null when it is not this person's computer. */
    async texMachineChatDetach(userId, machineId, groupKey) {
      const answer = await call("/gateway/machines/chat/detach", { userId, machineId, groupKey });
      return answer.ok ? answer.value : null;
    },
    /** The computers lent to a group chat, `[{machineId, workspaceId, ownerId}]`: live, and their owner still in the chat. */
    async texMachinesForChat(groupKey) {
      const answer = await call("/gateway/machines/for-chat", { groupKey });
      return answer.ok && Array.isArray(answer.value?.machines) ? answer.value.machines : [];
    },
    /** A chat's people `[{userId, handle}]` for one of them, or null when `userId` is not in it. */
    async texMachineChatPeople(userId, groupKey) {
      const answer = await call("/gateway/machines/chat/people", { userId, groupKey });
      return answer.ok && Array.isArray(answer.value?.people) ? answer.value.people : null;
    },
    /**
     * A session approving the code its own computer shows, with this connection's own token (`pair_device`): the
     * control plane approves it as the token's person, into `workspaceId`, as a mail-only device tied to this grant.
     * `{ approved: { name, os } }`, or `{ refused: code }` with the control plane's refusal code.
     */
    async texMachinePairApproveFromGrant(accessToken, workspaceId, code) {
      try {
        return { approved: await post("/gateway/machines/pair/approve-grant", { accessToken, workspaceId, code }) };
      } catch (error) {
        const status = refusalOf(error);
        if (status === null) throw error;
        return { refused: APPROVE_REFUSALS[status] ?? "REFUSED" };
      }
    },
    /** A machine giving its own grant back (`/machines/leave`): `{ machineId, workspaceId }`, or null for a dead grant. */
    async texMachineLeave(grant) {
      const answer = await call("/gateway/machines/leave", { grant });
      return answer.ok ? answer.value : null;
    },
    /** Takes a run's grant back when the part ended or was refused. */
    async texMachineRunRevoke(runId) {
      const answer = await call("/gateway/machines/run-grant/revoke", { runId });
      return answer.ok ? answer.value : null;
    },
  };
}
