/** `propose_note` and `review_proposal` — the write side of proposals (`proposals.js` holds the read side). */

import { clearExactVisibilityIfAbsent } from "../moves/objects.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import { isPlumbing } from "../privacy/engine.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { loadScopeRules, persistExactVisibility } from "../privacy/state.js";
import { normalizePath, timestampSlug } from "../notes/paths.js";
import {
  pendingProposalById,
  PROPOSAL_CONTENT_BYTE_CAP,
  PROPOSAL_PENDING_CAP,
  PROPOSAL_PENDING_PREFIX,
  PROPOSAL_REVIEWED_PREFIX,
} from "./proposals.js";
import { recordChange } from "../activity/record.js";
import { toolError, toolText } from "./results.js";

export async function toolProposeNote(store, scope, pathArg, content, reason, agent) {
  const path = normalizePath(pathArg);
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (typeof content !== "string") return toolError("content must be a string");
  if (typeof reason !== "string" || !reason.trim()) return toolError("reason is required");
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > PROPOSAL_CONTENT_BYTE_CAP) {
    return toolError(`proposal content exceeds ${PROPOSAL_CONTENT_BYTE_CAP} bytes`);
  }
  const pending = await listAllKeysWithLegacy(store, PROPOSAL_PENDING_PREFIX);
  if (pending.length >= PROPOSAL_PENDING_CAP) {
    return toolError(`proposal queue is full (${PROPOSAL_PENDING_CAP}); ask a private connection to review it`);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const proposal = {
    id,
    intended_path: path,
    content,
    reason: reason.trim().slice(0, 2000),
    submitted_by: typeof agent === "string" && agent.trim() ? agent.trim().slice(0, 120) : "unspecified agent",
    submitted_scope: scope,
    created_at: createdAt,
    content_bytes: byteLength,
  };
  const key = `${PROPOSAL_PENDING_PREFIX}${timestampSlug(new Date(createdAt))}-${id}.json`;
  await store.put(key, JSON.stringify(proposal));
  await recordChange(store, "propose_note", scope, [path], {
    proposal_id: id,
    content_bytes: byteLength,
    team_visible: false,
  });
  return toolText(
    `proposal queued: ${id}\nintended path: ${path}\n` +
      "A private connection must review it. No note has been created or overwritten."
  );
}

export async function toolReviewProposal(store, scope, id, action, destinationArg, reviewNote) {
  if (scope !== "private") {
    return toolError("permission denied: only a private connection can review proposals");
  }
  if (!["approve", "reject"].includes(action)) return toolError("action must be approve or reject");
  const found = await pendingProposalById(store, id);
  if (!found) return toolError("proposal not found");
  const { key, proposal } = found;
  const reviewedAt = new Date().toISOString();
  let destination = null;

  if (action === "approve") {
    destination = normalizePath(destinationArg || proposal.intended_path);
    if (!destination || !destination.endsWith(".md")) {
      return toolError("invalid approval destination (must end in .md)");
    }
    if (isPlumbing(destination)) return toolError("that path is reserved");
    if (await getWithLegacyFallback(store, destination)) {
      return toolError("conflict: approval destination already exists; choose a new destination or reject the proposal");
    }
    // Proposal approval is a personal review action and defaults private even
    // when the logical destination sits in a team-default folder.
    await persistExactVisibility(store, destination, "private", await loadScopeRules(store));
    const created = await store.put(destination, proposal.content, { onlyIf: { absent: true } });
    if (!created) {
      await clearExactVisibilityIfAbsent(store, destination).catch(() => {});
      return toolError(
        "conflict: approval destination was created concurrently; the proposal remains pending",
      );
    }
  }

  const reviewed = {
    ...proposal,
    status: action === "approve" ? "approved" : "rejected",
    reviewed_at: reviewedAt,
    final_path: destination,
    review_note: typeof reviewNote === "string" ? reviewNote.trim().slice(0, 2000) : "",
  };
  const reviewedKey =
    `${PROPOSAL_REVIEWED_PREFIX}${action === "approve" ? "approved" : "rejected"}/` +
    `${timestampSlug(new Date(reviewedAt))}-${proposal.id}.json`;
  await store.put(reviewedKey, JSON.stringify(reviewed));
  await deleteWithLegacyFallback(store, key);
  await recordChange(
    store,
    action === "approve" ? "approve_proposal" : "reject_proposal",
    scope,
    [destination || proposal.intended_path],
    { proposal_id: proposal.id, team_visible: false }
  );
  return toolText(
    action === "approve"
      ? `proposal approved: ${proposal.id}\ncreated: ${destination}\nvisibility: private`
      : `proposal rejected: ${proposal.id}\nintended path: ${proposal.intended_path}`
  );
}
