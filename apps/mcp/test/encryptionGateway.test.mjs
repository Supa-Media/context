/**
 * ENCRYPTION THROUGH THE GATEWAY — the read path, the write path, the tool, and
 * everything that must not touch a ciphertext on its way past.
 *
 * `encryption.test.mjs` proves the envelope in isolation. This file stands up a
 * real worker over two in-memory buckets and two workspaces holding two
 * different keys, because the properties that matter here are not properties of
 * AES-GCM — they are properties of the twelve places in this gateway that read
 * or rewrite a note body.
 *
 * The seven claims, and why each has to be asked here rather than upstream:
 *
 * 1. **Encryption is orthogonal to visibility.** A team-tier caller on a
 *    *private* encrypted note gets the byte-identical refusal it gets for a
 *    path that never existed — so encrypting a note adds no inference channel.
 *    A team-tier caller on a *team* encrypted note gets the plaintext, because
 *    the key belongs to the workspace and not to the owner. Both halves, or the
 *    first one passes for a gateway that simply refuses everything.
 * 2. **A workspace's key never opens another workspace's note.** The same
 *    ciphertext, byte for byte, in the other tenant's bucket, read by that
 *    tenant's owner: refused.
 * 3. **A round trip is not a downgrade.** Whether a write is encrypted is
 *    decided by the stored object; a client that read plaintext and echoed it
 *    back stores ciphertext, and one that posts an envelope-shaped body stores
 *    that as *content*, encrypted, rather than as a raw envelope.
 * 4. **A move does not touch the bytes.** Byte-for-byte equality across
 *    `move_note`, which is what binding the AAD to the workspace and not the
 *    path buys.
 * 5. **A link rewrite does not touch them either**, and the neighbours it does
 *    rewrite still get rewritten — a skip that skipped everything would pass
 *    half of this.
 * 6. **Search never quotes one.** Not through `search_notes`, not through the
 *    ChatGPT `fetch` dialect, and not into the index: `indexableText` is what
 *    both index paths call, and it is asserted directly as well as through the
 *    tools, because the projection is exercised by `searchProjection.test.mjs`
 *    and not by a bucket this file can see.
 * 7. **No key is a locked note, never a lost one.** A context whose key did not
 *    arrive can still read its plaintext notes, is refused its encrypted ones
 *    with an error that says what they are, and — the one that matters — cannot
 *    overwrite an encrypted note with plaintext.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   `toolWriteNote` writing `content` instead of `body`                     12
 *   `toolReadNote` returning the stored bytes rather than the plaintext      5
 *   `openStoredNote` handing back the bytes when it cannot decrypt           4
 *   `toolSetEncryption`'s `scope !== "private"` gate removed                 3
 *   `scanVisibleNotes` dropping its `isEncryptedNote` skip              0 → 1
 *   `indexableText` returning its argument unchanged                         1
 *   `rewriteReferences` dropping its `isEncryptedNote` skip                  0
 *
 * Added in adversarial review, with their own counts:
 *
 *   `rotate_encryption_keys` left out of `PRIVATE_TIER_ONLY_TOOLS`, so
 *   `tools/list` advertises it to a team-tier connection the call then
 *   tells it does not exist                                                 1
 *   `toolRotateEncryptionKeys` taking `args` and reading a workspace id
 *   out of it — the smuggled-argument attack                                1
 *
 * The rows that measured `export_encryption_keys` (its gate, its rate limit,
 * its log and audit hygiene) went with the tool: the owner removed it on
 * 2026-10-08, because leaving the product already hands back every note in
 * plain text. Section (15) now proves every caller gets an invented name's
 * answer for it.
 *
 * Three of the original rows are findings about this file rather than about
 * the source.
 *
 * **The scan skip measured zero**, because the only search in the file used a
 * needle out of the note's plaintext, which no envelope contains — so the scan
 * could not have matched an encrypted note whether it skipped one or not. The
 * fix is ordering as much as content: the first search now runs before anything
 * has built an index, so it falls to the literal scan, and it looks for
 * `A256GCM` — a string in every envelope and in nobody's note.
 *
 * **The link-rewrite skip measures zero and is left at zero, with a check
 * beside it instead of a manufactured number.** An envelope contains nothing a
 * link parser can match: `ct` is base64url, whose alphabet has no brackets, and
 * the JSON around it has no `[[` and no `](`. So deleting the guard changes
 * nothing today. `an envelope carries nothing a link rewriter could match` is
 * what keeps that true — the day the format grows a field that can carry a
 * bracket, that check fails, and the guard is what stops a rewrite corrupting a
 * note nothing can recover.
 *
 * **`indexableText` is one**, and it is asserted directly rather than through a
 * tool, because its two callers are the R2 shard sync and the D1 projection and
 * neither runs against a bucket this file owns. Reaching them means an
 * encrypted fixture in `searchProjection.test.mjs`, which is a larger change to
 * a suite that is not about this. One honest check beats a wider number bought
 * by testing something else.
 */

import { createEncryptionGatewayHarness } from "./encryptionGateway/fixtures.mjs";
import { runEncryptionGatewayCoreChecks } from "./encryptionGateway/core.test.mjs";
import { runEncryptionGatewayConflictsAndAuditChecks } from "./encryptionGateway/conflictsAndAudit.test.mjs";
import { runEncryptionGatewayPassphraseChecks } from "./encryptionGateway/passphrase.test.mjs";
import { runEncryptionGatewayExportKeysChecks } from "./encryptionGateway/exportKeys.test.mjs";
import { runEncryptionGatewayRotateKeysChecks } from "./encryptionGateway/rotateKeys.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one large
 * function that built a single shared harness (two in-memory buckets, two
 * workspaces holding two different keys, and a third keyless one) and ran
 * every numbered section against it in order. It is now a thin facade over
 * `test/encryptionGateway/*.test.mjs`, grouped by theme, that builds that
 * same harness once and threads it through every section in its original
 * order, so `import { runEncryptionGatewayChecks } from
 * "./encryptionGateway.test.mjs"` keeps working unchanged.
 *
 * Sections (14) and (15) each stash a fixture onto the harness
 * (`harness.LOCKED`, `harness.SMUGGLED`) that section (16) reads, the same
 * way the harness's own fields are threaded through.
 */
export async function runEncryptionGatewayChecks(check) {
  const harness = await createEncryptionGatewayHarness();
  try {
    await runEncryptionGatewayCoreChecks(check, harness);
    await runEncryptionGatewayConflictsAndAuditChecks(check, harness);
    await runEncryptionGatewayPassphraseChecks(check, harness);
    await runEncryptionGatewayExportKeysChecks(check, harness);
    await runEncryptionGatewayRotateKeysChecks(check, harness);
  } finally {
    harness.restore();
  }
}
