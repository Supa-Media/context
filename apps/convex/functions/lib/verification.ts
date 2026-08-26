/**
 * Turning a storage probe into something a person can act on.
 *
 * Split out from `functions/provisioning.ts` so the interesting half — what
 * counts as connected, what capability we are willing to claim, and what the
 * failure text says — is a pure function over the probe result and can be
 * tested directly against every backend shape, including the ones that lie.
 */

/**
 * The shape `probeStore` (`apps/mcp/src/store/index.js`) returns.
 *
 * Declared structurally for the same reason as `ScaffoldStore`: the adapter is
 * JSDoc-typed JavaScript whose `@typedef`s are not importable bindings. The
 * real `probeStore` is what the tests run.
 */
export interface ProbeResult {
  ok: boolean;
  reachable: boolean;
  writable: boolean;
  capabilities: { conditionalWrite: boolean };
  conditionalWrite: {
    declared: boolean;
    verified: boolean;
    rejectsWrong: boolean;
    acceptsCorrect: boolean;
    rejectsStale: boolean;
    mismatch: boolean;
    detail: string;
  };
  cleanedUp: boolean;
  errors: string[];
}

export interface VerificationSummary {
  /** Whether the binding may be marked `connected`. */
  ok: boolean;
  reachable: boolean;
  writable: boolean;
  /** What we are willing to *claim*, which is only ever what was observed. */
  capabilities: { conditionalWrite: boolean };
  /** Actionable failure text. Absent when `ok`. */
  error?: string;
}

/** `lastError` is truncated again on the way into the row; keep it short here. */
const MAX_DETAIL_LENGTH = 160;

function firstDetail(errors: string[]): string {
  const detail = errors.find((entry) => entry.length > 0);
  if (!detail) return "";
  return detail.length > MAX_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : detail;
}

/**
 * Decide the binding's status and capabilities from a probe.
 *
 * ## Why `ok` is not `probe.ok`
 *
 * `probeStore` reports `ok: false` whenever a store *declared* conditional
 * writes and did not deliver them — and `S3Store` declares them
 * unconditionally, because it does send `If-Match`. So on Backblaze B2 or
 * Wasabi, `probe.ok` is false for a bucket that is perfectly reachable,
 * writable, and usable. Refusing to connect it would be the wrong kind of
 * strict: the customer's context works, it just cannot detect a concurrent
 * edit.
 *
 * The honest handling is the one CLAUDE.md asks for — connect, and **degrade
 * honestly**: `capabilities.conditionalWrite` is taken from what the probe
 * *observed* (`probe.capabilities`, which is true only when a wrong `If-Match`
 * was rejected, a correct one was accepted, and a stale one was rejected),
 * never from what the adapter claimed. A backend that accepts `If-Match` and
 * ignores it is recorded as `false`, which is what stops the gateway from
 * believing it has conflict detection it does not have.
 *
 * `reachable` and `writable` are the two things that genuinely decide whether
 * a context can exist in this bucket, so they are what `ok` is made of.
 */
export function summarizeProbe(
  probe: ProbeResult,
  context: { bucket: string },
): VerificationSummary {
  const capabilities = {
    conditionalWrite: probe.capabilities?.conditionalWrite === true,
  };

  if (!probe.reachable) {
    return {
      ok: false,
      reachable: false,
      writable: false,
      capabilities,
      error: joinDetail(
        `Could not list the bucket "${context.bucket}". Check the endpoint, region, and bucket name, and that the access key is allowed to list it.`,
        firstDetail(probe.errors),
      ),
    };
  }

  if (!probe.writable) {
    return {
      ok: false,
      reachable: true,
      writable: false,
      capabilities,
      error: joinDetail(
        `The bucket "${context.bucket}" can be listed but not written to. The access key needs permission to put and delete objects in it.`,
        firstDetail(probe.errors),
      ),
    };
  }

  return { ok: true, reachable: true, writable: true, capabilities };
}

function joinDetail(message: string, detail: string): string {
  return detail ? `${message} The provider said: ${detail}` : message;
}

/**
 * SigV4 artifacts, recognizable by shape rather than by value.
 *
 * S3 error bodies quote the canonical request back at you, which is the
 * realistic way a signature or a credential scope ends up in text somebody
 * stores. Exported so `recordVerification` and the verifying action apply the
 * *same* rule: the row and the value the action returns are both published
 * surfaces, and having two redactors that drifted apart is how one of them
 * ends up being the weak one.
 */
export function redactSigningArtifacts(text: string): string {
  return text.replace(
    /\b(Signature|Credential|X-Amz-Security-Token|X-Amz-Signature)=[^\s&,"']+/gi,
    "$1=[redacted]",
  );
}

/**
 * Remove values we know are secret from a string on its way out.
 *
 * `recordVerification` scrubs what *it* holds: the access key id, the stored
 * envelope, and the signing artifacts above. It cannot scrub the plaintext
 * secret, because it never has it. This runs where the plaintext *does* exist
 * — inside the verifying action — and is the reason "the caller must not put
 * the secret in an error string" is enforced rather than merely asked for.
 *
 * Short values are ignored: redacting a two-character "secret" would blank out
 * ordinary words and produce a useless error message. A credential shorter
 * than this is not a credential.
 */
const MIN_REDACTABLE_LENGTH = 8;

export function redactSecrets(
  text: string,
  secrets: ReadonlyArray<string | undefined>,
): string {
  let out = redactSigningArtifacts(text);
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_REDACTABLE_LENGTH) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
