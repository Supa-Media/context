/**
 * R2Store — a ContextStore over a Cloudflare R2 bucket binding.
 *
 * A thin pass-through by design: R2's binding already matches the ContextStore
 * contract (null on a failed `onlyIf`, unquoted etags, `delimitedPrefixes` on
 * list), so nothing is reshaped and today's behavior is preserved exactly.
 *
 * Keys are the customer's own keys. An optional `rootPrefix` is applied here
 * and is invisible to every caller above this file.
 */

import {
  applyRootPrefix,
  assertSafeEtag,
  assertSafeKey,
  assertSafePrefix,
  normalizeEtag,
  normalizeRootPrefix,
  stripListResult,
  assertWritableContentType,
} from "./index.js";

export class R2Store {
  /**
   * @param {R2Bucket} bucket a Cloudflare R2 binding
   * @param {{ rootPrefix?: string }} [options]
   */
  constructor(bucket, options = {}) {
    if (!bucket) throw new Error("R2Store requires an R2 bucket binding");
    this.bucket = bucket;
    this.rootPrefix = normalizeRootPrefix(options.rootPrefix);
    // R2 implements conditional writes natively.
    this.capabilities = { conditionalWrite: true };
  }

  // Keys are validated here for the same reasons as in S3Store, and with the
  // same shared helper: the two adapters must accept and reject exactly the
  // same keys, or the same input lands in two different places depending on
  // which backend a workspace is bound to.

  // async so a rejected key always rejects the promise, never throws
  // synchronously — rollback paths use `store.delete(key).catch(...)`.
  async get(key) {
    return this.bucket.get(applyRootPrefix(this.rootPrefix, assertSafeKey(key)));
  }

  async put(key, value, options) {
    // An `onlyIf` carrying a missing or empty etag is rejected, exactly as
    // S3Store does. R2's R2Conditional with no etagMatches carries no
    // condition at all — a caller that asked for a conditional write would
    // silently get last-writer-wins, which is the failure this adapter exists
    // to make impossible. Unreachable today (every call site passes a real
    // object etag), but the two adapters must agree, and the in-memory test
    // stub shares R2's blind spot so nothing else would catch a drift.
    if (options && "onlyIf" in options) {
      const expected = options.onlyIf?.etagMatches;
      if (typeof expected !== "string" || !expected.trim()) {
        throw new Error(
          "onlyIf requires a non-empty etagMatches; refusing to downgrade a conditional write to an unconditional one",
        );
      }
      assertSafeEtag(normalizeEtag(expected));
    }
    // R2 carries the content type in `httpMetadata` rather than a header, and
    // the same allow-list applies — the two adapters must agree about what a
    // bucket may be made to hold. `options` is forwarded whole so `onlyIf`
    // keeps working; only the metadata is added.
    const contentType = assertWritableContentType(options?.contentType);
    return this.bucket.put(applyRootPrefix(this.rootPrefix, assertSafeKey(key)), value, {
      ...options,
      httpMetadata: { ...options?.httpMetadata, contentType },
    });
  }

  async delete(key) {
    return this.bucket.delete(applyRootPrefix(this.rootPrefix, assertSafeKey(key)));
  }

  async list(options = {}) {
    const { prefix, delimiter, cursor, limit } = options;
    const scoped = applyRootPrefix(this.rootPrefix, assertSafePrefix(prefix));
    const page = await this.bucket.list({
      prefix: scoped || undefined,
      delimiter,
      cursor,
      limit,
    });
    return stripListResult(this.rootPrefix, page);
  }
}
