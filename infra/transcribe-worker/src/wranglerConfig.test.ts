/**
 * A binding declared in `wrangler.jsonc` is what this Worker's rate limit was
 * meant to be enforced by, so the config file is where its numbers live and the
 * constants in `rateLimit.ts` are only a description of them.
 *
 * ⚠️ IT DOES NOT ENFORCE. `#226`/`#227` measured that against the deployed
 * Worker and `#228` moved the ceiling that does enforce to
 * `consumeTranscribeBudget` in the control plane; `rateLimit.ts`'s header and
 * the `ratelimits` block carry the measurements. This file still matters for
 * two reasons that outlive the enforcement: the numbers here are pinned to the
 * control plane's by a convex test, so a drift in either is caught; and the
 * block must stay declared, because `checkRateLimit` fails closed and losing it
 * refuses every request rather than quietly un-limiting anything.
 *
 * A description that drifts from the thing it describes is worse than none:
 * the comment justifying "20 a minute against a 3-a-minute workload" would go
 * on reading correctly while the deployed limiter allowed 20,000. So this test
 * reads the deployed config and pins the two to each other.
 *
 * SABOTAGE: change `simple.limit` in wrangler.jsonc without touching
 * `RATE_LIMIT_REQUESTS`, or delete the `ratelimits` block, and this file goes
 * RED. Nothing else does — no unit test can see a wrangler binding.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALLER_HEADER, RATE_LIMIT_PERIOD_SECONDS, RATE_LIMIT_REQUESTS } from "./rateLimit";

/**
 * `wrangler.jsonc` with its comments removed.
 *
 * Only whole-line `//` comments are stripped, which is every comment the file
 * has. Stripping `//` mid-line would corrupt any value containing one — and a
 * config parser that mangles a URL while "removing comments" is a worse bug
 * than the one this test exists to catch.
 */
function readWranglerConfig(): Record<string, unknown> {
  const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const source = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(source) as Record<string, unknown>;
}

interface RateLimitBinding {
  name?: unknown;
  namespace_id?: unknown;
  simple?: { limit?: unknown; period?: unknown };
}

describe("the deployed rate limit binding", () => {
  const config = readWranglerConfig();
  const bindings = config["ratelimits"] as RateLimitBinding[] | undefined;

  it("exists, because without it the Worker refuses every request", () => {
    // `checkRateLimit` fails closed on an absent binding, so deleting this
    // block does not quietly remove the limit — it stops transcription dead.
    // Both outcomes are bad deploys; this is the one that says so first.
    expect(Array.isArray(bindings)).toBe(true);
    expect(bindings).toHaveLength(1);
  });

  it("is bound under the name src/index.ts reads", () => {
    expect(bindings?.[0]?.name).toBe("TRANSCRIBE_RATE_LIMIT");
    // The namespace id provisions nothing, but it is not the arbitrary string
    // the comment here used to call it: Cloudflare documents "a string
    // containing a positive integer, unique per account". A value outside that
    // shape still deploys, and a binding that deploys without enforcing is the
    // failure this Worker actually hit — so the shape is asserted rather than
    // described. `"0"` and `"1e3"` are integers to `Number` and are not this.
    const namespaceId = bindings?.[0]?.namespace_id;
    expect(typeof namespaceId).toBe("string");
    expect(String(namespaceId)).toMatch(/^[1-9][0-9]*$/);
  });

  it("declares exactly the limit rateLimit.ts justifies in prose", () => {
    expect(bindings?.[0]?.simple?.limit).toBe(RATE_LIMIT_REQUESTS);
    expect(bindings?.[0]?.simple?.period).toBe(RATE_LIMIT_PERIOD_SECONDS);
  });

  it("uses a period the binding actually permits", () => {
    // Cloudflare's binding accepts 10 or 60 and rejects the config otherwise —
    // at deploy time, which is a broken deploy rather than a failed test.
    expect([10, 60]).toContain(bindings?.[0]?.simple?.period);
  });

  it("still declares no storage binding of any kind", () => {
    // The reason the native limiter was chosen over a KV counter: this Worker's
    // auditability claim is that there is nowhere here to keep audio.
    for (const key of ["kv_namespaces", "r2_buckets", "d1_databases", "durable_objects", "queues"]) {
      expect(config[key], key).toBeUndefined();
    }
  });

  it("keeps the caller header a header, not a var", () => {
    // Nothing about the caller is configuration: it arrives per request.
    expect(config["vars"]).toBeUndefined();
    expect(CALLER_HEADER).toBe(CALLER_HEADER.toLowerCase());
  });
});
