/**
 * WHAT A MOVE'S FAILURE IS ALLOWED TO SAY, AND TO WHOM.
 *
 * A failed materialization produces one string that travels two ways: back to
 * the owner in the tool response, and on to the control plane as the gateway
 * job's error. Those readers are allowed different things, and the rule for
 * each is stated in the move code itself.
 *
 *   - `safeMoveStorageDetail` returns a provider fragment "only in the
 *     immediate tool response; never persist it in the move marker, activity
 *     or gateway job status", and redacts URLs, paths, labelled credentials,
 *     long values, and the access key id this request signs with.
 *   - `moveProgressFromText` says of the other channel: "Counts only: never
 *     forward a marker's paths or provider text to the control plane".
 *     `moveErrorForControlPlane` is what holds the failure channel to it.
 *
 * Extracted from `movesAndBatch.test.mjs`, which sat exactly at the review
 * threshold: these are one cohesive responsibility and the move/batch
 * mechanics are another. Adding to that file without checking its size was
 * the mistake this extraction corrects.
 */
import { check } from "./harness.mjs";
import { safeMoveStorageDetail } from "../src/tools/moves/materialize.js";
import { moveErrorForControlPlane, moveProgressFromText } from "../src/moves/jobs.js";

export function runMoveDiagnosticsRedactionChecks() {
  check("link scan counts reach the owner progress card without paths",
    JSON.stringify(moveProgressFromText("move move-9f3a2b7c1d4e: rewriting\nreferences: 25/100\nnext: private.md")) ===
      JSON.stringify({ phase: "rewriting", completed: 25, total: 100 }));
  /*
    A MOVE'S FAILURE TEXT GOES TO THE CONTROL PLANE. ITS PATHS MUST NOT.

    `moveProgressFromText` beside this already states the rule — "Counts only:
    never forward a marker's paths or provider text to the control plane" — and
    keeps it with a strict integer regex. The failure channel out of the same
    consumer forwarded the tool's whole text, and a dozen of those throws
    interpolate `pair.source` or `pair.destination`, so a note path left the
    bucket and was stored in `gatewayJobs.lastError`, where the control plane
    only truncates it.

    `safeMoveStorageDetail` says the same thing about itself in its own words:
    its fragment belongs "only in the immediate tool response; never persist it
    in the move marker, activity or gateway job status."
  */
  const failureText =
    "move move-9f3a2b7c1d4e: materialization paused: copying: " +
    "source changed during materialization: 2-areas/private/secret-plan.md";
  const forwarded = moveErrorForControlPlane(failureText);
  check("a move failure forwarded to the control plane carries no note path",
    !forwarded.includes("2-areas/private/secret-plan.md") && !forwarded.includes("secret-plan"));
  check("POSITIVE CONTROL: the move id and the stage still reach an operator",
    forwarded.includes("move-9f3a2b7c1d4e") && forwarded.includes("copying"));
  for (const filename of ["secret plan.md", "café.md", "secret/plan.md", "secret\nplan.md"]) {
    const privatePath = `2-areas/private/${filename}`;
    const failure = `move move-9f3a2b7c1d4e: materialization paused: copying: source changed: ${privatePath}`;
    const safe = moveErrorForControlPlane(failure);
    check(`a move failure does not leak a fragment of ${JSON.stringify(filename)}`,
      safe === "move job failed: move-9f3a2b7c1d4e (copying)");
  }
  check("provider text without a known move id or stage cannot enter the control plane",
    moveErrorForControlPlane("storage failed: 2-areas/private/secret plan.md") === "move job failed");
  check("a filename that names a stage cannot masquerade as the worker stage",
    moveErrorForControlPlane("move move-9f3a2b7c1d4e: materialization paused: 2-areas/private/copying.md") ===
      "move job failed: move-9f3a2b7c1d4e");
  check("reference failures report a fixed stage without forwarding their note path",
    moveErrorForControlPlane("move move-9f3a2b7c1d4e: reference rewrite paused: 2-areas/private/café.md") ===
      "move job failed: move-9f3a2b7c1d4e (rewriting)");
  check("an empty or absent failure forwards nothing rather than an empty string",
    moveErrorForControlPlane("") === undefined && moveErrorForControlPlane(undefined) === undefined);

  const wrappedFailure = Object.assign(new Error("collaboration storage write failed", {
    cause: new Error("PUT https://storage.test/private/path.md object=2-areas/secret.md authorization: secret-value token=another-value refused"),
  }), { code: "STORAGE_WRITE_FAILED" });
  const safeDetail = safeMoveStorageDetail(wrappedFailure);
  check("owner move diagnostics redact provider URLs, paths and credentials",
    safeDetail.includes("[url]") && safeDetail.includes("[credential]") &&
      !safeDetail.includes("storage.test") && !safeDetail.includes("secret-value") &&
      !safeDetail.includes("another-value") && !safeDetail.includes("path.md") &&
      !safeDetail.includes("secret.md"));

  /*
    THE ONE CREDENTIAL SHAPE THE SHAPE RULES CANNOT SEE.

    An access key id is ~20 unlabelled alphanumerics: no scheme, no `/`, no
    `token=` beside it, and under the 32-character run the catch-all looks for.
    `InvalidAccessKeyId` is also the provider error most likely to carry one,
    and `bindingView` masks that same value on every other surface it reaches.
    So it is redacted by exact match against the value the store holds, the way
    `scrubProviderError` already argues in the control plane — a value we hold
    is detectable, and a shape rule broad enough to catch it would also eat
    real all-caps provider codes like REQUESTTIMETOOSKEWED.
  */
  const authFailure = Object.assign(new Error("collaboration storage write failed", {
    cause: new Error("The AWS Access Key Id you provided does not exist in our records: AKIAIOSFODNN7EXAMPLE"),
  }), { code: "STORAGE_WRITE_FAILED" });
  const authDetail = safeMoveStorageDetail(authFailure, { accessKeyId: "AKIAIOSFODNN7EXAMPLE" });
  check("...and the binding's own access key id, which a provider auth error echoes",
    !authDetail.includes("AKIAIOSFODNN7EXAMPLE") && authDetail.includes("[credential]"));
  check("POSITIVE CONTROL: the provider's own words still reach the owner",
    authDetail.includes("does not exist in our records"));
  check("a store without a key id neither throws nor blanks the detail",
    safeMoveStorageDetail(authFailure, {}).includes("does not exist in our records") &&
      safeMoveStorageDetail(authFailure).includes("does not exist in our records"));

}
