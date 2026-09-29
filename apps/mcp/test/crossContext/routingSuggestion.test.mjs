/**
 * A routing suggestion ranks destinations, but never authorizes one.
 *
 * The caller has already oriented and supplies only context names and scores.
 * Note text, paths, and rationale are deliberately absent from the contract.
 * This suite puts the dangerous candidate first: a high-confidence context the
 * caller cannot write, followed by a lower-confidence context they own. The
 * backend must block, not silently file into the second-best workspace.
 */

import {
  callTool,
  textOf,
  TOKEN_EDITOR,
  TOKEN_GUEST,
  TOKEN_OWNER,
} from "./fixtures.mjs";

function resultOf(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return null;
  }
}

function auditKeys(bucket) {
  return [...bucket.keys()].filter((key) => key.startsWith(".context/audit/"));
}

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextRoutingSuggestionChecks(check, harness) {
  const { env, hooks, mine, theirs, stranger } = harness;

  const smuggled = textOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [{ context: "@mine", confidence: 95 }],
      content: "PRIVATE-MARKER",
    })
  );
  check(
    "the routing contract has no field for note content",
    smuggled.startsWith('unknown argument "content"')
  );

  const beforeUnreachable = [mine, theirs, stranger].map((bucket) => auditKeys(bucket).length);
  const unreachable = resultOf(
    await callTool(env, TOKEN_OWNER, "suggest_destination", {
      candidates: [
        { context: "@stranger", confidence: 99 },
        { context: "@mine", confidence: 80 },
      ],
      content_classification: "personal",
    })
  );
  check(
    "a high-confidence unreachable destination is blocked with a stable code",
    unreachable?.status === "blocked" &&
      unreachable?.error?.code === "routing.destination_unreachable"
  );
  check(
    "an unreachable first choice never falls back to a writable second choice",
    unreachable?.selected?.index === 0 && unreachable?.selected?.context === "@stranger"
  );
  check(
    "a blocked route writes no audit event into any candidate context",
    [mine, theirs, stranger].every(
      (bucket, index) => auditKeys(bucket).length === beforeUnreachable[index]
    )
  );

  const beforeReadOnly = [mine, theirs].map((bucket) => auditKeys(bucket).length);
  const readOnly = resultOf(
    await callTool(env, TOKEN_OWNER, "suggest_destination", {
      candidates: [
        { context: "@theirs", confidence: 96 },
        { context: "@mine", confidence: 75 },
      ],
      content_classification: "shared",
    })
  );
  check(
    "confidence does not turn read-only membership into write authority",
    readOnly?.status === "blocked" &&
      readOnly?.error?.code === "routing.destination_read_only"
  );
  check(
    "a read-only first choice also never falls back",
    readOnly?.selected?.index === 0 && readOnly?.selected?.context === "@theirs"
  );
  check(
    "a read-only route writes no audit event",
    [mine, theirs].every((bucket, index) => auditKeys(bucket).length === beforeReadOnly[index])
  );

  const beforeAmbiguous = [mine, theirs].map((bucket) => auditKeys(bucket).length);
  const ambiguous = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [
        { context: "@mine", confidence: 91 },
        { context: "@theirs", confidence: 84 },
      ],
      content_classification: "shared",
    })
  );
  check(
    "candidates fewer than ten points apart remain ambiguous",
    ambiguous?.status === "ambiguous" &&
      ambiguous?.error?.code === "routing.destination_ambiguous"
  );
  check(
    "an ambiguous route writes no audit event",
    [mine, theirs].every((bucket, index) => auditKeys(bucket).length === beforeAmbiguous[index])
  );

  const tooLow = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [{ context: "@mine", confidence: 74 }],
      content_classification: "shared",
    })
  );
  check(
    "a top score below seventy-five waits for a decision",
    tooLow?.status === "ambiguous" &&
      tooLow?.error?.code === "routing.confidence_too_low"
  );

  const exactBoundaries = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [
        { context: "@mine", confidence: 75 },
        { context: "@theirs", confidence: 65 },
      ],
      content_classification: "shared",
    })
  );
  check(
    "seventy-five confidence and a ten-point lead meet the exact boundaries",
    exactBoundaries?.status === "suggested" && exactBoundaries?.selected?.context === "@mine"
  );

  const plannedFromReadOnlySource = resultOf(
    await callTool(env, TOKEN_GUEST, "suggest_destination", {
      candidates: [{ context: "@stranger", confidence: 90 }],
      content_classification: "shared",
    })
  );
  check(
    "a read-only source does not hide write authority the connection holds elsewhere",
    plannedFromReadOnlySource?.status === "suggested" &&
      plannedFromReadOnlySource?.selected?.context === "@stranger"
  );

  const beforeConfirmation = auditKeys(theirs);
  const confirmation = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [{ context: "@theirs", confidence: 99 }],
      content_classification: "personal",
    })
  );
  check(
    "personal information crossing into a shared workspace always requires confirmation",
    confirmation?.status === "confirmation_required" &&
      confirmation?.error?.code === "routing.confirmation_required"
  );
  check(
    "confirmation is independent of a ninety-nine percent score",
    confirmation?.selected?.confidence === 99 && confirmation?.requires_confirmation === true
  );

  const afterConfirmation = auditKeys(theirs);
  const confirmationAuditKey = afterConfirmation.find((key) => !beforeConfirmation.includes(key));
  const confirmationAudit = confirmationAuditKey
    ? JSON.parse(theirs.get(confirmationAuditKey).body)
    : null;
  check(
    "a unique authorized suggestion is audited in its destination context",
    confirmationAudit?.action === "route_suggestion" &&
      confirmationAudit?.details?.outcome === "confirmation_required"
  );
  const auditText = JSON.stringify(confirmationAudit);
  check(
    "the routing audit stores no note content, path, rationale, or candidate name",
    confirmationAudit?.paths?.length === 0 &&
      !/PRIVATE-MARKER|1-projects|mine|theirs|stranger|rationale|content/.test(auditText)
  );

  const beforeSuggested = auditKeys(theirs);
  const suggested = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [{ context: "@theirs", confidence: 88 }],
      content_classification: "shared",
    })
  );
  check(
    "an authorized, confident, non-sensitive candidate is suggested without writing a note",
    suggested?.status === "suggested" &&
      suggested?.dry_run === true &&
      suggested?.selected?.context === "@theirs"
  );
  check(
    "a suggestion returns a stable decision id for later revalidation",
    /^[a-f0-9]{64}$/.test(suggested?.decision_id || "")
  );
  check(
    "the only destination mutation is one audit object",
    auditKeys(theirs).length === beforeSuggested.length + 1 &&
      !theirs.has("PRIVATE-MARKER") &&
      !mine.has("PRIVATE-MARKER")
  );

  const beforeAuditFailure = auditKeys(theirs).length;
  const failAuditWithProviderSecret = async (url, init = {}) => {
    const parsed = new URL(url);
    if (
      (init.method || "GET").toUpperCase() === "PUT" &&
      parsed.pathname.startsWith("/cross-theirs/.context/audit/")
    ) {
      throw new Error("S3-INTERNAL-SECRET-MUST-NOT-LEAK");
    }
  };
  hooks.push(failAuditWithProviderSecret);
  const auditUnavailable = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [{ context: "@theirs", confidence: 87 }],
      content_classification: "shared",
    })
  );
  hooks.splice(hooks.indexOf(failAuditWithProviderSecret), 1);
  check(
    "a destination audit failure blocks the suggestion with a stable redacted code",
    auditUnavailable?.status === "blocked" &&
      auditUnavailable?.error?.code === "routing.audit_unavailable" &&
      !JSON.stringify(auditUnavailable).includes("S3-INTERNAL-SECRET-MUST-NOT-LEAK")
  );
  check(
    "an audit failure does not leave a destination audit object behind",
    auditKeys(theirs).length === beforeAuditFailure
  );

  const changed = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [{ context: "@theirs", confidence: 89 }],
      content_classification: "shared",
      expected_decision_id: suggested.decision_id,
    })
  );
  check(
    "a changed candidate set invalidates the prior dry-run with a stable code",
    changed?.status === "changed" &&
      changed?.error?.code === "routing.destination_changed" &&
      changed?.decision_id !== suggested.decision_id
  );

  const duplicate = resultOf(
    await callTool(env, TOKEN_EDITOR, "suggest_destination", {
      candidates: [
        { context: "@theirs", confidence: 90 },
        { context: "THEIRS", confidence: 80 },
      ],
      content_classification: "shared",
    })
  );
  check(
    "two spellings of one destination are rejected instead of manufacturing ambiguity",
    duplicate?.status === "blocked" &&
      duplicate?.error?.code === "routing.duplicate_candidate"
  );
}
