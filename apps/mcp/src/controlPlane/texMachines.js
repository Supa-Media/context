/**
 * A person's own computers ("machines") in the control plane, which keeps only
 * each machine's revocable grant (docs/decisions/texting-assistant/machines.md).
 * Grants and codes go verbatim and are hashed on arrival there; the gateway
 * mints them and verifies the machine's signatures, because the control plane
 * never sees a private key and needs no Ed25519.
 */
import { ControlPlaneError } from "./client.js";

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
  };
}
