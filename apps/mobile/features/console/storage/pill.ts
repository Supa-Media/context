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
 * The whole pill: `R2 · brain`, `Dropbox · second/`, or just `Dropbox`.
 *
 * The location half is the bucket when there is one, else the root prefix —
 * which is how a Dropbox binding scoped to a folder says where it points
 * (`rootPrefix` is stored normalized with its trailing slash, and is rendered
 * as stored). A binding with neither is the provider name alone: a pill is a
 * label, and a label must never carry a hole where a value failed to exist.
 *
 * `null` in, `null` out — "no bucket connected" is the caller's copy, because
 * it is a warning with a tone, not a label.
 */
export function storagePillLabel(
  storage: { provider: string; bucket?: string; rootPrefix?: string } | null,
): string | null {
  if (storage === null) return null;
  const provider = providerLabel(storage.provider);
  const location = [storage.bucket, storage.rootPrefix].find(
    (value) => value !== undefined && value.trim() !== "",
  );
  return location === undefined ? provider : `${provider} · ${location}`;
}
