/**
 * SDK failures -> HTTP status for the op responses (plan.md, Contract B):
 * 4xx when the request was refused or invalid, 5xx otherwise.
 *
 * The body carries the SDK's error code and never its message: SDK messages
 * can quote addresses and message text.
 */

/**
 * The class name of a thrown value, for logs: the error's own name, or its
 * constructor's name when the name is the generic "Error". Never the message.
 */
export function errorClass(error) {
  if (error === null || typeof error !== "object") return "unknown";
  const name = typeof error.name === "string" ? error.name : undefined;
  if (name && name !== "Error") return name;
  return error.constructor?.name || "Error";
}

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

const FIELD = /^[A-Za-z][\w.[\]-]{0,60}$/;
const REQUEST = /^[\w-]{1,80}$/;
/**
 * What the SDK says about a failure, for the bridge's log only: the field it names, its request id, its gRPC
 * code, and its message with anything quoted, any number of five or more digits and any address taken out, cut
 * short. A Photon refusal with no reason was all the log had (2026-11-15: six sends refused "invalidArgument").
 */
export function errorDetail(error) {
  if (error instanceof RequestError || typeof error !== "object" || error === null) return {};
  const field = error.context?.field;
  const message = typeof error.message === "string" ? error.message : "";
  const detail = message
    .replace(/"[^"]*"|'[^']*'|\u201c[^\u201d]*\u201d|`[^`]*`/g, "\"\u2026\"")
    .replace(/[^\s@]+@[^\s@]+/g, "<address>")
    .replace(/\+?\d[\d\s().-]{3,}\d/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return {
    ...(typeof field === "string" && FIELD.test(field) ? { field } : {}),
    ...(typeof error.requestId === "string" && REQUEST.test(error.requestId) ? { request: error.requestId } : {}),
    ...(Number.isSafeInteger(error.grpcCode) ? { grpc: error.grpcCode } : {}),
    ...(detail !== "" ? { detail } : {}),
  };
}
