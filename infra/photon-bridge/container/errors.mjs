/**
 * SDK failures -> HTTP status for the op responses (plan.md, Contract B):
 * 4xx when the request was refused or invalid, 5xx otherwise.
 *
 * The body carries the SDK's error code and never its message: SDK messages
 * can quote addresses and message text.
 */

/** A request the bridge refuses before any Photon call. */
export class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

const CODE_STATUS = new Map([
  ["invalidArgument", 400],
  ["chatNotFound", 404],
  ["messageNotFound", 404],
  ["attachmentNotFound", 404],
  ["addressNotFound", 404],
  ["pollNotFound", 404],
  ["groupIconNotFound", 404],
  ["sharedFriendLocationNotFound", 404],
  ["preconditionFailed", 409],
  ["duplicateMessage", 409],
  ["attachmentNotReady", 409],
  ["operationNotSupported", 422],
  ["recipientLocked", 422],
  ["sendReceiveRatioExceeded", 422],
  // Rate and daily limits are refusals Photon makes on purpose.
  ["dailyLimitExceeded", 429],
  ["recipientLimitExceeded", 429],
  ["uploadRateExceeded", 429],
  ["contentDuplicateExceeded", 429],
  ["recipientCoolingDown", 429],
  ["burstRateExceeded", 429],
  ["newContactThrottled", 429],
  // Credential and transport trouble is ours, not the caller's.
  ["unauthenticated", 502],
  ["tokenExpired", 502],
  ["tokenBlocked", 502],
  ["unauthorized", 502],
  ["privateApiUnavailable", 503],
  ["serviceUnavailable", 503],
  ["networkError", 503],
  ["timeout", 504],
  ["internalError", 502],
  ["databaseError", 502],
]);

/** Status for an SDK error code; anything unlisted is an upstream failure. */
export function statusForCode(code) {
  return CODE_STATUS.get(code) ?? 502;
}

/** `{status, body}` for a thrown value from the SDK, or from the bridge itself. */
export function describeError(error) {
  if (error instanceof RequestError) {
    return { status: error.status, body: { ok: false, status: error.status, error: error.code } };
  }
  const code = typeof error?.code === "string" ? error.code : "unknown";
  const status = statusForCode(code);
  return {
    status,
    body: {
      ok: false,
      status,
      error: code,
      retryable: error?.retryable === true,
    },
  };
}
