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
    // R2 implements conditional writes natively. Its Worker delete API does
    // not expose an If-Match parameter, so delete below performs a strongly
    // consistent etag check immediately before deleting and `probeStore()`
    // still proves the advertised contract on the concrete binding.
    this.capabilities = {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: true,
      serverSideCopy: false,
    };
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
      if (options.onlyIf?.absent === true) {
        options = { ...options, onlyIf: { etagDoesNotMatch: "*" } };
      } else if (typeof expected !== "string" || !expected.trim()) {
        throw new Error(
          "onlyIf requires a non-empty etagMatches; refusing to downgrade a conditional write to an unconditional one",
        );
      }
      if (expected) assertSafeEtag(normalizeEtag(expected));
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

  async copy(sourceKey, destinationKey, options = {}) {
    if (options?.onlyIf?.absent === true && (await this.get(destinationKey)) !== null) return null;
    const source = await this.bucket.get(applyRootPrefix(this.rootPrefix, assertSafeKey(sourceKey)));
    if (!source) return null;
    const body =
      source.body && typeof source.body.getReader === "function"
        ? source.body
        : await source.arrayBuffer();
    return this.bucket.put(applyRootPrefix(this.rootPrefix, assertSafeKey(destinationKey)), body, {
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    });
  }

  async delete(key, options = {}) {
    const safeKey = assertSafeKey(key);
    const scoped = applyRootPrefix(this.rootPrefix, safeKey);
    if (options?.onlyIf?.etagMatches) {
      const expected = assertSafeEtag(normalizeEtag(options.onlyIf.etagMatches));
      const current = await this.bucket.get(scoped);
      if (!current || normalizeEtag(current.etag || current.httpEtag || "") !== expected) return null;
    }
    return this.bucket.delete(scoped);
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
