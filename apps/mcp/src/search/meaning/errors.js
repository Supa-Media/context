/**
 * The failures of search by meaning, and the whole set of them.
 *
 * The same six codes as fast search (`../d1/client.js`), so a person reading a
 * `meaningIndexes` row next to a `searchIndexes` row reads one vocabulary.
 * A provider's text can name the account, the index, or quote a note that was
 * being embedded, so none of it is ever carried: an error holds our code and a
 * cause from a closed set of our own words.
 */

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export const MEANING_ERROR_CODES = Object.freeze([
  "NOT_CONFIGURED",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "REFUSED",
]);

/** The causes this module may write, so a log line can never carry anything else. */
const CAUSES = new Set([
  "timeout",
  "network",
  "model",
  "envelope",
  "body_read",
  "oversize",
  "shape",
]);

/**
 * What a provider's message was about, as one word of ours from a closed set, for a code no page documents
 * (Workers AI's 8006 from inside a workspace object, 2026-11-04). The message itself is never kept: it can quote
 * the note being embedded, so only which of these words it matched survives.
 */
export const PROVIDER_HINTS = Object.freeze(["rate", "capacity", "allocation", "too_long", "too_many", "timeout", "internal", "auth", "other"]);

const HINT_PATTERNS = [
  ["allocation", /neuron|allocation|quota/i],
  ["rate", /rate.?limit|too many requests/i],
  ["capacity", /capacity|overload|busy/i],
  ["too_long", /too long|too large|context|max(imum)?.{0,12}(token|length|size)|exceed/i],
  ["too_many", /too many|batch|array/i],
  ["timeout", /time.?out|timed out/i],
  ["auth", /auth|permission|forbidden|account/i],
  ["internal", /internal|unknown|server error/i],
];

/** The hint for a provider's message: the first word whose pattern matches, `other` when none does. */
export function providerHint(message) {
  if (typeof message !== "string" || message.length === 0) return undefined;
  const head = message.slice(0, 200);
  for (const [hint, pattern] of HINT_PATTERNS) if (pattern.test(head)) return hint;
  return "other";
}

/**
 * The words of a provider's message that cannot have come from the note being embedded: letters-only words that
 * appear in none of the inputs, at most twelve, from the first 160 characters past the code. A word the inputs hold
 * is dropped, so no note's word can reach a log through this; digits are dropped, so no id or number can either.
 * For a code no page documents (Workers AI's 8006, 2026-11-04), where `providerHint` matched none of its patterns.
 */
export function providerWords(message, inputs) {
  if (typeof message !== "string" || message.length === 0) return undefined;
  const held = new Set();
  for (const text of Array.isArray(inputs) ? inputs : []) {
    if (typeof text !== "string") continue;
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) held.add(word);
  }
  const words = (message.replace(/^\s*\d{4}\s*:?/, "").slice(0, 160).match(/[A-Za-z]+/g) ?? [])
    .filter((word) => word.length <= 20 && !held.has(word.toLowerCase()))
    .slice(0, 12);
  return words.length > 0 ? words.join(" ").toLowerCase() : undefined;
}

export class MeaningError extends Error {
  constructor(code, detail = {}) {
    const known = MEANING_ERROR_CODES.includes(code) ? code : "REFUSED";
    super(`search by meaning unavailable: ${known}`);
    this.name = "MeaningError";
    this.code = known;
    const cause = typeof detail.cause === "string" ? detail.cause : undefined;
    this.failureCause = cause && (CAUSES.has(cause) || /^http_\d{3}$/.test(cause)) ? cause : undefined;
    // Fixed operation names and numeric provider codes are diagnostic without
    // carrying a response message, note path, note text, or credential.
    this.operation = ["embed", "upsert", "delete_by_ids", "get_by_ids", "query"].includes(detail.operation) ? detail.operation : undefined;
    this.providerCodes = Array.isArray(detail.providerCodes)
      ? detail.providerCodes.filter((value) => Number.isSafeInteger(value)).slice(0, 5)
      : [];
    this.probeStatus = ["accepted", "refused", "other_error"].includes(detail.probeStatus)
      ? detail.probeStatus
      : undefined;
    this.hint = PROVIDER_HINTS.includes(detail.hint) ? detail.hint : undefined;
    this.providerWords = typeof detail.providerWords === "string" && /^[a-z ]{1,260}$/.test(detail.providerWords) ? detail.providerWords : undefined;
    this.inputChars = Number.isSafeInteger(detail.inputChars) && detail.inputChars >= 0
      ? detail.inputChars
      : undefined;
  }

  static fromStatus(status, cause, detail = {}) {
    if (status === 401 || status === 403) return new MeaningError("UNAUTHORIZED", { ...detail, cause });
    if (status === 404) return new MeaningError("NOT_FOUND", { ...detail, cause });
    if (status === 429) return new MeaningError("RATE_LIMITED", { ...detail, cause });
    if (status >= 500) return new MeaningError("UNAVAILABLE", { ...detail, cause });
    return new MeaningError("REFUSED", { ...detail, cause });
  }
}
