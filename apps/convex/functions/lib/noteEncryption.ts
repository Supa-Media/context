/**
 * Recognising an encrypted note, in the control plane.
 *
 * The gateway owns encryption — `apps/mcp/src/encryption.js` is the envelope,
 * the crypto and the normative spec, and `docs/decisions/encryption.md` says
 * decryption happens there, at request time, and nowhere else. This file is
 * deliberately **not** a second implementation of any of that. It is the one
 * question the console has to be able to answer without a key:
 *
 *     is the thing I am about to show in an editor, and about to save back over,
 *     an encrypted note?
 *
 * ## Why the control plane needs to ask at all
 *
 * The console reads and writes through `functions/lib/fileOps.ts`, which opens
 * the customer's bucket directly behind the credential barrier — a different
 * path from the gateway's, with its own privacy engine port beside it. So the
 * gateway's rule that *whether a write is encrypted is decided by the stored
 * object* is enforced in the gateway only. Without this file, the console would
 * load an envelope into a textarea and save whatever came back as the note's new
 * plaintext, **destroying the encryption of a note somebody deliberately
 * encrypted**, through a door the gateway's guard does not reach.
 *
 * ## What is deliberately not here
 *
 * No key, no decrypt, no encrypt. The console shows a locked note and refuses to
 * overwrite it; it does not open one. Adding a decrypt here would mean handing
 * the workspace data key to a second service and widening the set of places a
 * note's plaintext exists — a decision for `docs/decisions/encryption.md`, not a
 * convenience for an editor.
 *
 * ## One rule, two runtimes, one corpus
 *
 * This is a port, and it is held the way this repository holds its other port:
 * `__tests__/noteEncryptionParity.test.ts` runs this implementation and the
 * gateway's over the same fixture corpus and asserts identical answers, exactly
 * as `__tests__/privacyEngine.test.ts` does for `canSee`. A port with no parity
 * test is a second opinion waiting to disagree.
 */

/** The frontmatter key an encrypted note carries. Must match the gateway's. */
export const ENCRYPTION_MARKER_KEY = "context_encryption";

/**
 * Does this note's stored text mark it as encrypted?
 *
 * Reads the **frontmatter only**, and never the body — a note that merely
 * mentions the marker while writing about this feature is an ordinary note, and
 * a rule that read the body would let anybody make one of their own notes
 * permanently unsavable by describing it.
 *
 * Answers on the marker rather than on a successful parse of the envelope, so a
 * *broken* envelope is refused a save exactly as hard as a good one. That
 * direction is the point: the failure this prevents is overwriting ciphertext,
 * and a malformed envelope is the case where overwriting it is least
 * recoverable.
 */
export function isEncryptedNote(text: unknown): boolean {
  if (typeof text !== "string") return false;
  // A byte-order mark is the one thing that can sit in front of `---` and still
  // be frontmatter to everything that reads it — editors on Windows add one on
  // save, and Obsidian parses through it. Without this line a BOM'd envelope
  // answers `false` and the console saves plaintext over it. A leading
  // *newline* is deliberately not tolerated: frontmatter that does not start at
  // the first byte is not frontmatter. The gateway's copy says the same.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  if (end < 0) return false;
  return new RegExp(`^\\s*${ENCRYPTION_MARKER_KEY}\\s*:\\s*v?\\d+\\s*$`, "m").test(
    body.slice(3, end),
  );
}

/** The fence an envelope's JSON block opens with. Must match the gateway's. */
const FENCE = "```context-encrypted";

/**
 * One recipient's identity within an envelope — enough to tell two envelopes
 * apart without a key, and never anything a key would be needed to check.
 */
export interface RecipientIdentity {
  kind: string;
  id: string;
}

/**
 * The envelope inside an encrypted note's fenced block, read only far enough
 * to check its shape and name its recipients.
 *
 * **Never decrypted, and never fully validated the way `apps/mcp/src/encryption.js`
 * validates before it acts on one** — this runtime holds no key and performs
 * no cryptography, so there is nothing here that needs the KDF bounds or the
 * IV lengths the gateway and the console's own envelope module enforce before
 * *using* a descriptor. What this checks is only what `canReplaceEncryptedNote`
 * needs: that the document is a well-formed v1 envelope, and which recipients
 * it names.
 *
 * `null` for anything that is not one — an ordinary note, a note whose marker
 * is present but whose fenced block is missing or is not valid JSON, or one
 * whose shape does not match the spec in `docs/decisions/encryption.md`. A
 * parse failure here has to *refuse* a write rather than guess at one, which is
 * exactly what every caller below does with a `null`.
 */
export function parseEnvelopeRecipients(text: string): RecipientIdentity[] | null {
  if (!isEncryptedNote(text)) return null;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const start = body.indexOf(FENCE);
  if (start < 0) return null;
  const bodyStart = body.indexOf("\n", start);
  if (bodyStart < 0) return null;
  const end = body.indexOf("\n```", bodyStart);
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(bodyStart + 1, end));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== 1) return null;
  if (envelope.alg !== "A256GCM") return null;
  if (typeof envelope.iv !== "string" || typeof envelope.ct !== "string") return null;
  if (typeof envelope.aad !== "string" || envelope.aad.length === 0) return null;
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length === 0) return null;

  const identities: RecipientIdentity[] = [];
  for (const candidate of envelope.recipients) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const recipient = candidate as Record<string, unknown>;
    if (typeof recipient.kind !== "string" || typeof recipient.id !== "string") return null;
    if (recipient.alg !== "A256GCM") return null;
    if (typeof recipient.iv !== "string" || typeof recipient.wrapped !== "string") return null;
    identities.push({ kind: recipient.kind, id: recipient.id });
  }
  return identities;
}

/** One recipient set, folded to a string two sets can be compared by. */
function recipientSetKey(identities: readonly RecipientIdentity[]): string {
  return identities
    .map((recipient) => `${recipient.kind}:${recipient.id}`)
    .sort()
    .join("\x00");
}

/**
 * The same recipients, the same identities, in any order, no more and no
 * fewer.
 *
 * Order-independent because re-encrypting under the same key does not have to
 * preserve array order, and a multiset comparison (via the sorted join above)
 * rather than a set one, because two recipients that collided on `{kind, id}`
 * would otherwise be indistinguishable from one.
 */
export function sameRecipientSet(
  a: readonly RecipientIdentity[],
  b: readonly RecipientIdentity[],
): boolean {
  return a.length === b.length && recipientSetKey(a) === recipientSetKey(b);
}

/**
 * Every byte of an envelope document except its JSON blob.
 *
 * `parseEnvelopeRecipients` only ever looks *inside* the fenced block, on
 * purpose — it is answering "what does this envelope claim", not "is this
 * document nothing but an envelope". Left there, `canReplaceEncryptedNote`
 * would accept a submission that wraps a perfectly well-formed envelope,
 * naming exactly the right recipients, around **extra plaintext smuggled in
 * before the frontmatter's close, between it and the fence, or after the
 * fence's own close** — a shape no legitimate client ever produces (`envelope.ts`
 * on the client and `renderEncryptedNote` on the gateway are one deterministic
 * template each, byte-identical to each other), but nothing stops a caller
 * that already holds editor access to this path from typing it by hand. That
 * caller is exactly who this feature exists to keep out: an editor without the
 * passphrase, human or an MCP client wired to this workspace, is precisely the
 * "couple of other humans" this note was not shared with.
 *
 * Returns `null` for anything that does not even have the frontmatter-and-fence
 * shape `parseEnvelopeRecipients` already requires — a caller that checked that
 * first will never see it — and otherwise the document with its JSON blob (the
 * one thing a legitimate re-encryption is allowed to change) excised. Two
 * envelopes that differ **only** in their ciphertext produce an identical
 * skeleton; anything smuggled anywhere else does not.
 */
function envelopeSkeleton(text: string): string | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.startsWith("---")) return null;
  const frontEnd = body.indexOf("\n---", 3);
  if (frontEnd < 0) return null;
  const afterFront = frontEnd + "\n---".length;
  const fenceStart = body.indexOf(FENCE, afterFront);
  if (fenceStart < 0) return null;
  const jsonStart = body.indexOf("\n", fenceStart);
  if (jsonStart < 0) return null;
  const jsonEnd = body.indexOf("\n```", jsonStart);
  if (jsonEnd < 0) return null;
  return body.slice(0, jsonStart) + body.slice(jsonEnd);
}

/**
 * May `nextText` replace `storedText` at a path the control plane already
 * knows is encrypted?
 *
 * This is the whole of the widened door `fileOps.writeFile` opens, and it is
 * deliberately narrow: **`true` only when `nextText` is itself a well-formed
 * envelope naming exactly the recipients `storedText` already names, and
 * differing from it nowhere except the ciphertext.** Every other case —
 * plaintext, a malformed replacement, a different recipient added or removed,
 * an id or a kind swapped, or a well-formed envelope with anything extra
 * smuggled in around it — answers `false`.
 *
 * That is what lets an already-unlocked console re-encrypt a note under a
 * fresh IV (an edit), rewrap the same note key under a new passphrase-derived
 * one (a passphrase change) and nothing else through this door: the gateway's
 * own rule, "whether a write is encrypted is decided by the stored object",
 * taken one step further for the note this runtime can never open — a note
 * this request cannot open is a note this request cannot write, a note whose
 * recipients this request cannot even *see change* is the same rule applied to
 * a runtime with no key to open anything with, and a note whose every byte
 * outside the ciphertext this request cannot even *see move* closes the one
 * gap that check alone would still leave — see `envelopeSkeleton`.
 *
 * Deliberately does **not** check that `storedText` still parses — a stored
 * envelope this control plane can no longer make sense of is refused here too,
 * because `parseEnvelopeRecipients` and `envelopeSkeleton` both answer `null`
 * for it, and `null` never matches anything.
 */
export function canReplaceEncryptedNote(storedText: string, nextText: string): boolean {
  const nextRecipients = parseEnvelopeRecipients(nextText);
  if (nextRecipients === null) return false;
  const storedRecipients = parseEnvelopeRecipients(storedText);
  if (storedRecipients === null) return false;
  if (!sameRecipientSet(storedRecipients, nextRecipients)) return false;
  const nextSkeleton = envelopeSkeleton(nextText);
  if (nextSkeleton === null) return false;
  return nextSkeleton === envelopeSkeleton(storedText);
}
