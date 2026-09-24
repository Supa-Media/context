/** Proposal limits, lookup, and the read-only proposal tools. Moved verbatim out of `src/index.js`. */

import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { PROPOSAL_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { toolError, toolText } from "./results.js";

export const PROPOSAL_PENDING_PREFIX = `${PROPOSAL_PREFIX}pending/`;
export const PROPOSAL_REVIEWED_PREFIX = `${PROPOSAL_PREFIX}reviewed/`;
export const PROPOSAL_PENDING_CAP = 100;
export const PROPOSAL_CONTENT_BYTE_CAP = 500_000;

function proposalIdIsValid(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export async function pendingProposalById(store, id) {
  if (!proposalIdIsValid(id)) return null;
  const candidates = await listAllKeysWithLegacy(store, PROPOSAL_PENDING_PREFIX);
  const match = candidates.find(({ key }) => key.endsWith(`-${id}.json`));
  if (!match) return null;
  const obj = await getWithLegacyFallback(store, match.key);
  if (!obj) return null;
  try {
    return { key: match.key, proposal: JSON.parse(await obj.text()) };
  } catch {
    return null;
  }
}

export async function toolListProposals(store, scope) {
  if (scope !== "private") {
    return toolError("permission denied: pending proposals are available only to a private connection");
  }
  const keys = (await listAllKeysWithLegacy(store, PROPOSAL_PENDING_PREFIX)).sort((a, b) => a.key.localeCompare(b.key));
  if (!keys.length) return toolText("(no pending proposals)");
  const lines = [];
  for (const { key } of keys) {
    const obj = await getWithLegacyFallback(store, key);
    if (!obj) continue;
    try {
      const proposal = JSON.parse(await obj.text());
      lines.push(
        `${proposal.id} — ${proposal.intended_path} — ${proposal.submitted_by} — ` +
          `${proposal.created_at} — ${proposal.content_bytes} bytes\n  reason: ${proposal.reason}`
      );
    } catch {
      continue;
    }
  }
  return toolText(lines.length ? lines.join("\n") : "(no readable pending proposals)");
}

export async function toolReadProposal(store, scope, id) {
  if (scope !== "private") {
    return toolError("permission denied: pending proposals are available only to a private connection");
  }
  const found = await pendingProposalById(store, id);
  if (!found) return toolError("proposal not found");
  const { proposal } = found;
  return toolText(
    `proposal: ${proposal.id}\nintended path: ${proposal.intended_path}\n` +
      `submitted by: ${proposal.submitted_by}\ncreated: ${proposal.created_at}\n` +
      `reason: ${proposal.reason}\n\n${proposal.content}`
  );
}
