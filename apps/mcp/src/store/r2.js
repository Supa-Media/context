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
  normalizeRootPrefix,
  stripListResult,
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

  get(key) {
    return this.bucket.get(applyRootPrefix(this.rootPrefix, key));
  }

  put(key, value, options) {
    return this.bucket.put(applyRootPrefix(this.rootPrefix, key), value, options);
  }

  delete(key) {
    return this.bucket.delete(applyRootPrefix(this.rootPrefix, key));
  }

  async list(options = {}) {
    const { prefix, delimiter, cursor, limit } = options;
    const scoped = applyRootPrefix(this.rootPrefix, prefix || "");
    const page = await this.bucket.list({
      prefix: scoped || undefined,
      delimiter,
      cursor,
      limit,
    });
    return stripListResult(this.rootPrefix, page);
  }
}
