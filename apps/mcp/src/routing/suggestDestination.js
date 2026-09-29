/**
 * Multi-workspace destination suggestion.
 *
 * Semantic fit arrives as scores from an agent that has already oriented.
 * This module never sees the information being filed. It independently
 * re-clamps every candidate through `sessionForContext`, refuses fallback from
 * an unauthorized first choice, and records only aggregate decision metadata.
 */

import { recordChange } from "../activity/record.js";
import {
  hasScope,
  SCOPE_WRITE,
  sessionForContext,
  SessionRefusal,
} from "../session.js";
import { toolError, toolText } from "../tools/results.js";

export const ROUTING_CONTRACT_VERSION = 1;
export const ROUTING_MIN_CONFIDENCE = 75;
export const ROUTING_AMBIGUITY_GAP = 10;

const THRESHOLDS = Object.freeze({
  minimum_confidence: ROUTING_MIN_CONFIDENCE,
  ambiguity_gap: ROUTING_AMBIGUITY_GAP,
});

function safeContextLabel(value) {
  if (typeof value !== "string") return null;
  const slug = value.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,64}$/.test(slug) ? `@${slug}` : null;
}

function error(code, message) {
  return { code, message };
}

function response(body, isError = false) {
  const text = JSON.stringify({ dry_run: true, thresholds: THRESHOLDS, ...body });
  return isError ? toolError(text) : toolText(text);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {object} sourceSession The context named by the tool-level `context` argument.
 * @param {object} args Validated tool arguments, with `context` already stripped.
 * @param {(name: string) => Promise<{session: object, store: object}>} openContext
 */
export async function toolSuggestDestination(sourceSession, args, openContext) {
  const classification = args.content_classification || "unknown";
  const resolved = [];

  for (let index = 0; index < args.candidates.length; index += 1) {
    const candidate = args.candidates[index];
    const label = safeContextLabel(candidate.context);
    try {
      const session = sessionForContext(sourceSession, candidate.context);
      resolved.push({
        index,
        label: `@${session.workspaceSlug}`,
        confidence: candidate.confidence,
        authorization: hasScope(session, SCOPE_WRITE) ? "authorized" : "read_only",
        session,
      });
    } catch (cause) {
      if (!(cause instanceof SessionRefusal)) throw cause;
      resolved.push({
        index,
        label,
        confidence: candidate.confidence,
        authorization: "unreachable",
        session: null,
      });
    }
  }

  const seen = new Set();
  for (const candidate of resolved) {
    const key = candidate.session?.workspaceId || candidate.label;
    if (key === null) continue;
    if (seen.has(key)) {
      return response(
        {
          status: "blocked",
          error: error(
            "routing.duplicate_candidate",
            "Each destination may appear only once, regardless of case or @ decoration."
          ),
        },
        true
      );
    }
    seen.add(key);
  }

  const candidates = resolved.map(({ index, label, confidence, authorization }) => ({
    index,
    context: label,
    confidence,
    authorization,
  }));
  const ranked = [...resolved].sort(
    (left, right) => right.confidence - left.confidence || left.index - right.index
  );
  const top = ranked[0];
  const selected = {
    index: top.index,
    context: top.label,
    confidence: top.confidence,
  };
  const decisionId = await sha256(
    JSON.stringify({
      version: ROUTING_CONTRACT_VERSION,
      source: sourceSession.workspaceId,
      classification,
      candidates: resolved.map((candidate) => ({
        index: candidate.index,
        destination: candidate.session?.workspaceId || candidate.label || "unusable",
        confidence: candidate.confidence,
        authorization: candidate.authorization,
      })),
    })
  );
  const common = { decision_id: decisionId, candidates, selected };

  if (top.confidence < ROUTING_MIN_CONFIDENCE) {
    return response({
      ...common,
      status: "ambiguous",
      error: error(
        "routing.confidence_too_low",
        `The strongest candidate is below the ${ROUTING_MIN_CONFIDENCE}% suggestion threshold.`
      ),
    });
  }

  const runnerUp = ranked[1];
  if (runnerUp && top.confidence - runnerUp.confidence < ROUTING_AMBIGUITY_GAP) {
    return response({
      ...common,
      status: "ambiguous",
      error: error(
        "routing.destination_ambiguous",
        `The two strongest candidates are fewer than ${ROUTING_AMBIGUITY_GAP} points apart.`
      ),
    });
  }

  if (top.authorization === "unreachable") {
    return response(
      {
        ...common,
        status: "blocked",
        error: error(
          "routing.destination_unreachable",
          "The strongest candidate is not reachable through this connection."
        ),
      },
      true
    );
  }
  if (top.authorization === "read_only") {
    return response(
      {
        ...common,
        status: "blocked",
        error: error(
          "routing.destination_read_only",
          "The strongest candidate is reachable but this connection cannot write there."
        ),
      },
      true
    );
  }

  const crossWorkspace = top.session.workspaceId !== sourceSession.workspaceId;
  const requiresConfirmation =
    crossWorkspace && top.session.workspaceKind === "shared" && classification !== "shared";
  let status = requiresConfirmation ? "confirmation_required" : "suggested";
  let routeError = requiresConfirmation
    ? error(
        "routing.confirmation_required",
        "Routing personal or unclassified information into a shared workspace requires explicit confirmation."
      )
    : null;

  if (typeof args.expected_decision_id === "string" && args.expected_decision_id !== decisionId) {
    status = "changed";
    routeError = error(
      "routing.destination_changed",
      "The destination decision changed since the earlier dry-run. Review the new result before writing."
    );
  }

  let destination;
  try {
    destination = await openContext(top.label);
    await recordChange(destination.store, "route_suggestion", destination.session.scope, [], {
      contract_version: ROUTING_CONTRACT_VERSION,
      decision_id: decisionId,
      outcome: status,
      candidate_count: candidates.length,
      top_confidence: top.confidence,
      cross_workspace: crossWorkspace,
      confirmation_required: requiresConfirmation,
      // Audit-only routing decisions are owner-visible. A team-visible flag
      // would make a member's audit feed disclose activity outside their own
      // workspace even though the event deliberately stores no candidate name.
      team_visible: false,
    });
  } catch {
    // Storage adapters may throw provider-specific errors. None of that text
    // reaches the caller, for the same reason StorageUnavailable's does not.
    return response(
      {
        ...common,
        status: "blocked",
        error: error(
          "routing.audit_unavailable",
          "The destination could not record the routing audit event, so no suggestion was issued."
        ),
      },
      true
    );
  }

  return response({
    ...common,
    status,
    ...(routeError ? { error: routeError } : {}),
    requires_confirmation: requiresConfirmation,
    audit: { recorded: true, action: "route_suggestion" },
  });
}
