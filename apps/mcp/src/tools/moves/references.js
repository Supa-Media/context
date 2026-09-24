/** Rewriting the links that point at a moved note. */

import { canSee } from "../../privacy/engine.js";
import { generatedCollaborationBase } from "../../notes/sealing.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { indexByName, rewriteLinks } from "../../links.js";
import { isEncryptedNote } from "../../encryption.js";
import { LINK_SCAN_CAP } from "../../moves/objects.js";
import { listAllNoteKeys } from "../../notes/visibleKeys.js";
import { replaceText as replaceCollaborationText } from "@context/collaboration";

/**
 * Point every link at where its note went.
 *
 * Called after a move has landed, so the bucket already holds the new paths and
 * `renames` is how to get back to the old ones. Three things about it are
 * decisions rather than mechanics.
 *
 * **It rewrites only what this connection can see.** That is `move_folder`'s
 * existing rule, arrived at for the same reason and quoted here because it is
 * easy to talk yourself out of: the gateway holds a credential that can read
 * every object, so it *could* repair a private note's links on behalf of a team
 * caller. It does not. Every other tool here operates on the visible surface,
 * counts reported back are counts over that surface, and a count over notes the
 * caller may not know exist is an inference channel. The residual is real and
 * worth stating: after a team caller moves a note, links to it inside private
 * notes are stale until an owner's connection moves something. An owner sees
 * everything, so an owner's move fixes everything.
 *
 * **The moved notes are rewritten too, not just the notes pointing at them.** A
 * note that moved keeps every relative link it had, and each one now needs a
 * different number of `../`. Fixing the inbound links and not the outbound ones
 * would trade one set of broken links for another.
 *
 * **Names are resolved as they were before the move.** `byName` is built over
 * pre-move paths, because a bare `[[overview]]` was written against the bucket
 * as it was; resolving it against the new shape would miss exactly the note
 * that just moved.
 */
export async function rewriteReferences(store, scope, rules, overrides, renames, { write = true } = {}) {
  if (renames.size === 0) return { notes: 0, links: 0, capped: false };

  let keys;
  try {
    keys = (await listAllNoteKeys(store))
      .map(({ key }) => key)
      .filter((key) => canSee(key, scope, rules, overrides));
  } catch {
    // `listAllKeys` throws rather than truncate. A walk that could not be
    // completed is reported as a rewrite that did not happen, never as one that
    // did — the move itself has already succeeded and must not be undone for
    // this.
    return { notes: 0, links: 0, capped: true };
  }
  if (keys.length > LINK_SCAN_CAP) return { notes: 0, links: 0, capped: true };

  const wasAt = new Map();
  for (const [from, to] of renames) wasAt.set(to, from);
  const byName = indexByName(keys.map((key) => wasAt.get(key) ?? key));

  let notes = 0;
  let links = 0;
  for (const key of keys) {
    const fromPath = wasAt.get(key) ?? key;
    const object = await getWithLegacyFallback(store, key);
    if (!object) continue;
    const storedText = await object.text();
    const collaborationBase = await generatedCollaborationBase(store, key, storedText);
    const text = collaborationBase?.text ?? storedText;
    /*
      AN ENCRYPTED NOTE'S STORED BYTES ARE NEVER REWRITTEN.

      There are no links in them to rewrite — the note's links are inside the
      ciphertext — and running a link regex over base64 is a way to corrupt a
      note that nothing can then recover. Skipping is the safe direction, and
      it is checked on the marker rather than on a successful parse so that a
      *broken* envelope is skipped exactly as hard as a good one.

      **The cost, stated rather than left to be discovered: links written
      inside an encrypted note are not rewritten when their target moves, and
      they go stale.** The alternative is decrypt-rewrite-re-encrypt inside a
      walk that already runs against a 50-subrequest budget and a 4,000-note
      cap, which is the trade `storage-and-credentials.md` has already made in
      the other direction for bulk moves. See `docs/decisions/encryption.md`,
      "Round-tripping without damaging ciphertext".
    */
    if (isEncryptedNote(text)) continue;
    const rewritten = rewriteLinks(text, { fromPath, toPath: key, renames, byName });
    if (rewritten === null) continue;
    notes += 1;
    links += rewritten.changed;
    if (!write) continue;
    /*
      No snapshot before the overwrite, and that is the *current* rule rather
      than an omission: version history is the customer's object versioning
      (`docs/decisions/storage-and-credentials.md`), and this write path landed
      the same week the snapshots were removed from every other one. Restoring
      one here would put back the write amplification that decision measured,
      on somebody else's bill, for a rollback nothing can read.
    */
    if (collaborationBase) {
      await replaceCollaborationText(store, key, {
        documentId: collaborationBase.documentId,
        expectedEtag: collaborationBase.etag,
        text: rewritten.text,
      });
    } else {
      await store.put(key, rewritten.text);
    }
  }
  return { notes, links, capped: false };
}
