/**
 * The storage pill's words, as data.
 *
 * The top bar's chip and the status bar's trailing segment both used to build
 * their label inline as `provider · bucket` — which printed **"dropbox ·
 * undefined"** the first time a real Dropbox binding reached either of them,
 * because a Dropbox binding has no bucket (see `ConsoleStorage.bucket` for why
 * the field is honestly absent rather than `""`). Two call sites interpolating
 * the same template is exactly how one of them ships a literal `undefined`, so
 * the words are decided here once, and the test can assert the string
 * "undefined" is unmanufacturable.
 */

/**
 * "Cloudflare R2" reads as "R2" in a chip that has to fit beside a name — and
 * "dropbox", which the control plane spells lowercase, reads as "Dropbox",
 * because the pill is prose, not a protocol field. Anything unrecognised is
 * printed raw: a deployment newer than this bundle can send a provider this
 * client has never heard of, and the honest response is to show it.
 */
export function providerLabel(provider: string): string {
  if (/dropbox/i.test(provider)) return "Dropbox";
  if (/r2/i.test(provider)) return "R2";
  if (/s3/i.test(provider)) return "S3";
  if (/b2|backblaze/i.test(provider)) return "B2";
  return provider;
}

/**
 * What a managed bucket's location half says instead of its name.
 *
 * `managedBucketName()` derives the name from the workspace id, on purpose and
 * permanently: immutable, unique, and incapable of colliding, where a slug can
 * be renamed, reserved, or typed by somebody else (see non-negotiable #2 and
 * `docs/decisions/storage-and-credentials.md`). The cost is that the name is
 * `ctx-j57a2m9qk4x1r8v6s3d0w7b5n2t8f4h6`, and a pill that prints it spends its
 * whole width on a 36-character string the person never chose and can do
 * nothing with.
 *
 * So the label says the one thing that *is* true of a managed binding and
 * carries information: this bucket is ours to run rather than one they
 * connected. The exact name stays in Settings → Storage → Bucket, which is
 * where somebody diagnosing a real problem is already looking.
 */
const MANAGED_LOCATION = "managed";

/**
 * The whole pill: `R2 · notes-bucket`, `Dropbox · second/`, `R2 · managed`, or just
 * `Dropbox`.
 *
 * The location half is the bucket when there is one, else the root prefix —
 * which is how a Dropbox binding scoped to a folder says where it points
 * (`rootPrefix` is stored normalized with its trailing slash, and is rendered
 * as stored). A binding with neither is the provider name alone: a pill is a
 * label, and a label must never carry a hole where a value failed to exist.
 *
 * A **managed** binding skips that choice entirely — see `MANAGED_LOCATION`.
 * Only `managed: true` counts: the field is optional, and a bundle talking to
 * a control plane that predates it reads `undefined` as "an ordinary binding"
 * and prints the name the person typed, which is the honest fallback.
 *
 * `null` in, `null` out — "no bucket connected" is the caller's copy, because
 * it is a warning with a tone, not a label.
 */
export function storagePillLabel(
  storage:
    | { provider: string; bucket?: string; rootPrefix?: string; managed?: boolean }
    | null
    | undefined,
): string | null {
  /*
    `null` and `undefined` both produce no label, and a caller must not read
    that as "no bucket" without checking which one it had — `undefined` is a
    binding that has not answered yet (`ConsoleData.storage`). The status bar
    is the one caller that needs no check: it *omits* the segment for a missing
    label rather than printing a claim.
  */
  if (storage === null || storage === undefined) return null;
  const provider = providerLabel(storage.provider);
  if (storage.managed === true) return `${provider} · ${MANAGED_LOCATION}`;
  const location = [storage.bucket, storage.rootPrefix].find(
    (value) => value !== undefined && value.trim() !== "",
  );
  return location === undefined ? provider : `${provider} · ${location}`;
}
