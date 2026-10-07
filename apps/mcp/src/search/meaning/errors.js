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

export class MeaningError extends Error {
  constructor(code, detail = {}) {
    const known = MEANING_ERROR_CODES.includes(code) ? code : "REFUSED";
    super(`search by meaning unavailable: ${known}`);
    this.name = "MeaningError";
    this.code = known;
    const cause = typeof detail.cause === "string" ? detail.cause : undefined;
    this.failureCause = cause && (CAUSES.has(cause) || /^http_\d{3}$/.test(cause)) ? cause : undefined;
  }

  static fromStatus(status, cause) {
    if (status === 401 || status === 403) return new MeaningError("UNAUTHORIZED", { cause });
    if (status === 404) return new MeaningError("NOT_FOUND", { cause });
    if (status === 429) return new MeaningError("RATE_LIMITED", { cause });
    if (status >= 500) return new MeaningError("UNAVAILABLE", { cause });
    return new MeaningError("REFUSED", { cause });
  }
}
