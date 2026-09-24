/**
 * Where a bucket is: which endpoints may be bound at all, how a root prefix is
 * normalised, and when two bindings name the same storage.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function; this module registers none and opens no credential.
 */

import { ConvexError } from "convex/values";
import { decodeSegment } from "../../../../mcp/src/store/index.js";
import { managedAccountId, refuseManagedEndpoint } from "../managedStorage";

/**
 * Hostnames and literal addresses that are not somewhere on the public
 * internet.
 *
 * The endpoint is a URL an owner supplies and something of ours later makes a
 * request to — the connect probe today, the gateway afterwards. That makes it
 * an SSRF sink: `https://169.254.169.254/…` is the cloud instance-metadata
 * service, `https://localhost:8080/…` and `https://10.0.0.5/…` are whatever
 * else is reachable from the machine running the probe. "The owner chose it"
 * is not a defense, because the owner is not who the request is made *as*.
 *
 * This is a literal-address filter, not a resolution-time one. A hostname that
 * resolves to a private address still passes here, and DNS rebinding still
 * beats any check made at this layer — whichever component ultimately performs
 * the request has to enforce its own egress policy. What this does buy is that
 * the obvious form of the attack cannot simply be typed into the connect form.
 */
export const BLOCKED_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127(\.\d{1,3}){3}$/, // loopback
  /^0(\.\d{1,3}){3}$/, // "this host"
  /^10(\.\d{1,3}){3}$/, // RFC 1918
  /^192\.168(\.\d{1,3}){2}$/, // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/, // RFC 1918
  /^169\.254(\.\d{1,3}){2}$/, // link-local, including instance metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d{1,3}){2}$/, // RFC 6598 CGNAT
];

/** IPv6 literals arrive from `URL` bracketed and lowercased. */
export function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[")) return false;
  const address = hostname.slice(1, -1);
  return (
    address === "::1" || // loopback
    address === "::" || // unspecified
    /^f[cd][0-9a-f]{2}:/.test(address) || // fc00::/7 unique-local
    /^fe[89ab][0-9a-f]:/.test(address) // fe80::/10 link-local
  );
}

/**
 * Reject an endpoint that would send the credential somewhere unencrypted, that
 * is not an absolute URL at all, that points back inside our own network, or
 * that addresses the account holding managed buckets.
 */
export function assertUsableEndpoint(endpoint: string): void {
  // No-ops on a deployment with no managed account, which is most of them —
  // see `managedAccountId`. Reads an environment variable and never a
  // credential, which is what keeps this callable from a public function:
  // `__tests__/structure.test.ts` fails any public path reaching `decryptSecret`.
  refuseManagedEndpoint(endpoint, managedAccountId());

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message: "The storage endpoint must be an absolute URL.",
    });
  }
  if (parsed.protocol !== "https:") {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message: "The storage endpoint must use https.",
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message: "Credentials must not be embedded in the endpoint URL.",
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  const blocked =
    isBlockedIpv6(hostname) ||
    BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  if (blocked) {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message:
        "The storage endpoint must be a public address, not a loopback, link-local, or private-network one.",
    });
  }
}

/**
 * `rootPrefix` is a convenience for customers whose bucket holds other things
 * — it is applied at the adapter boundary and is invisible above it. It is
 * emphatically NOT tenancy, so it must never be derived from a workspace id.
 * Normalized to `foo/bar/` (no leading slash, one trailing slash).
 */
export function normalizeRootPrefix(
  rootPrefix: string | undefined,
): string | undefined {
  if (rootPrefix === undefined) return undefined;
  const trimmed = rootPrefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("..")) {
    throw new ConvexError({
      code: "INVALID_ROOT_PREFIX",
      message: "The root prefix must not contain '..'.",
    });
  }
  /*
    AND THE SAME RULE ON THE DECODED SEGMENT.

    The check above compares raw text; the adapter's `describeKeyProblem` does
    not — it percent-decodes each segment before comparing, so `%2E%2E` is a
    ".." to the layer that finally builds the request and to no layer above it.
    A prefix refused only there is a binding that saves, probes into `error`,
    and throws on every request afterwards, which is the outcome the addressing
    check below is written to avoid: a probe records a status, it cannot explain
    a value, and the screen where the value was typed is where it can be.

    `decodeSegment` is the adapter's own, imported rather than restated — the
    decoding is the subtle half, and `apps/convex` already bundles this module.
    Equality per segment rather than `includes`, because the adapter compares
    whole segments: `a%2E%2Eb` is a prefix it accepts, and refusing it here
    would refuse a folder no layer objects to. Nothing escapes a bucket either
    way — the adapter holds — so this is about which door says so.
  */
  for (const segment of trimmed.split("/")) {
    const decoded = decodeSegment(segment);
    if (decoded === "." || decoded === "..") {
      throw new ConvexError({
        code: "INVALID_ROOT_PREFIX",
        message: "The root prefix must not contain '..'.",
      });
    }
  }
  return `${trimmed}/`;
}

/**
 * Is this endpoint/bucket pair one where nothing can tell path-style from
 * virtual-hosted addressing?
 *
 * **This must mean exactly what `S3Store`'s constructor means by it.** The
 * adapter refuses to guess when the endpoint's first host label is the bucket
 * name, because `https://my-context.s3.example` with bucket `my-context` is
 * either a virtual-hosted endpoint (the bucket is already in the host, so the
 * path must not repeat it) or a path-style endpoint that collides by
 * coincidence (`s3.wasabisys.com` with a bucket called `s3`,
 * `<account>.r2.cloudflarestorage.com` with a bucket named after the account).
 * Guessing wrong drops or adds a path segment, so the provider reads the first
 * *key* segment as the bucket and a write lands in a different bucket entirely,
 * silently.
 *
 * The point of duplicating the rule here is *when* it fires, not *whether*.
 * Left to the adapter alone it fires inside the connect probe, which cannot
 * throw usefully: the probe's job is to record a status, so the owner gets a
 * permanently-`error` binding and no way to say which addressing style they
 * meant. Checked at bind time it is a `ConvexError` naming both answers, on the
 * screen where the value would be typed.
 *
 * Two copies of a rule drift, so `__tests__/addressing.test.ts` pins this one
 * against the real `S3Store` constructor: for a matrix of endpoints and buckets
 * it asserts that this returns `true` exactly when constructing the adapter
 * without `forcePathStyle` throws.
 *
 * `URL` lowercases the hostname; the bucket is compared as given, which is the
 * same comparison `S3Store` makes.
 */
export function addressingIsAmbiguous(
  endpoint: string,
  bucket: string,
): boolean {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    // Not a URL at all. `assertUsableEndpoint` is what reports that; there is
    // no addressing question to answer about a string that is not an endpoint.
    return false;
  }
  return hostname.startsWith(`${bucket}.`);
}

/**
 * The refusal, worded so the person can act on it without reading this file.
 *
 * It names the bucket (which they just typed, so it is not a disclosure) and
 * both possible answers. It carries **no** access key id and no secret — an
 * error string is the easiest place in a system for a credential to escape, and
 * this one is shown to a user and likely pasted into a support thread.
 */
export function ambiguousAddressingError(
  bucket: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "AMBIGUOUS_ADDRESSING",
    message:
      `The endpoint's first host label is the bucket name ("${bucket}"), so nothing ` +
      "can tell whether this bucket is addressed by host or by path. Set " +
      "forcePathStyle to false if the endpoint already contains the bucket " +
      `(virtual-hosted, e.g. https://${bucket}.s3.amazonaws.com), or to true if the ` +
      "bucket belongs in the path and the host merely starts with the same word.",
  });
}

/**
 * Where a binding's notes actually live, as one comparable string.
 *
 * ## What this is for, and why it is not "did anything change"
 *
 * A binding row changes for two very different reasons, and every field on it
 * that describes the old bucket is cleared on both — `applyBinding` says so
 * eleven times over. The **projection of the notes** cannot be treated that
 * way, because releasing it deletes a billed database and re-provisioning one
 * is minutes of work against a bucket that may not even be reachable yet.
 *
 * So the question is narrower than "was this row rewritten": it is *"do the
 * notes live somewhere else now"*. Rotating an access key on the bucket
 * somebody already had is a repair and keeps its index. Pointing the workspace
 * at a different bucket, or at a different Dropbox account, is a move, and the
 * projection describes somewhere the person has left.
 *
 * `rootPrefix` is part of the address for the same reason it is part of every
 * key: the same bucket under a different prefix is a different context's worth
 * of notes. The credential is deliberately **not** — it is the thing that
 * changes on a repair.
 *
 * `null` where the row names nowhere yet, which compares equal to nothing,
 * including to another `null`: a half-built binding is not evidence that the
 * notes stayed put.
 */
export function storageAddress(
  binding: {
    provider?: string;
    endpoint?: string;
    bucket?: string;
    rootPrefix?: string;
    dropboxAccountId?: string;
  } | null,
): string | null {
  if (binding === null || binding === undefined) return null;
  const prefix = binding.rootPrefix ?? "";
  if (binding.provider === "dropbox") {
    return binding.dropboxAccountId
      ? `dropbox\u0000${binding.dropboxAccountId}\u0000${prefix}`
      : null;
  }
  if (!binding.provider || !binding.bucket) return null;
  return `${binding.provider}\u0000${binding.endpoint ?? ""}\u0000${binding.bucket}\u0000${prefix}`;
}

/**
 * Do these two rows name different places for the notes to be?
 *
 * **No row is not the same as a row that names nowhere**, and the difference
 * decides which way this fails. A `null` `before` is a first connect: there is
 * nothing to have moved from, so nothing is released. A row that exists and
 * whose address `storageAddress` cannot read is the other case — we cannot
 * tell where its notes were — and "cannot tell" is answered here the way the
 * rest of this codebase answers it, by taking the cost rather than the risk.
 * Keeping the projection leaves a D1 database of one bucket's note text
 * attached to a binding for a different bucket; releasing it costs a rebuild
 * of a derivative that is disposable by construction.
 *
 * It is not a hypothetical shape. `recordConnectFailure` records a failed
 * Dropbox sign-in by patching `provider: "dropbox"` onto a row that is not
 * `connected` — with no account id, and with the S3 fields it is written over
 * left in place — so one expired sign-in on a workspace whose binding is in
 * `error` is enough to make the address unreadable while its projection is
 * still `ready`. The next rebind is then a move nothing could see.
 */
export function storageMoved(
  before: Parameters<typeof storageAddress>[0],
  after: Parameters<typeof storageAddress>[0],
): boolean {
  if (before === null || before === undefined) return false;
  const from = storageAddress(before);
  if (from === null) return true;
  return from !== storageAddress(after);
}
