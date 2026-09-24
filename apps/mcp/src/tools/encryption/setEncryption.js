/** `set_encryption` and `export_encryption_keys`. */

import { canSee, isPlumbing } from "../../privacy/engine.js";
import { checkAndConsumeExportRateLimit, EXPORT_RATE_LIMIT } from "../../encryptionKeys/exportRateLimit.js";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  readDocument as readCollaborationDocument,
  sealDocument as sealCollaborationDocument,
} from "@context/collaboration";
import { collaborationHead } from "../../live/collaborationHttp.js";
import { encryptedNoteRefusal, openStoredNote, sealNoteContent } from "../../notes/sealing.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { isEncryptedNote, NoteCryptoError, renderKeyExport } from "../../encryption.js";
import { normalizePath } from "../../notes/paths.js";
import { recordChange } from "../../activity/record.js";
import { toolError, toolText } from "../results.js";

/**
 * Turn encryption on or off for one note, in place.
 *
 * ## Owner-only, through the gate this file already has
 *
 * `scope !== "private"` is the same check `set_visibility` and `list_plugins`
 * make, and it is at least as strict as "owner": `visibilityTierForGrant`
 * answers `private` only for the owner of a context *and* only where the person
 * granted the client the private tier. An owner on a team-tier grant is
 * refused, which is correct — deciding that a note's bytes become unreadable to
 * their own storage provider is not something a connection they gave narrower
 * access to gets to do on their behalf.
 *
 * Deliberately not derived from the role directly: "the privacy tier is a scope
 * on the grant, never an inference from a role"
 * (`docs/decisions/identity-and-access.md`).
 *
 * ## It is a re-write of one note, and it is conflict-safe
 *
 * The note is read, opened, and written back in the other form. `expected_etag`
 * is honoured exactly as `write_note` honours it, because this is a full-body
 * rewrite of somebody's note and a lost concurrent edit here is a lost note.
 *
 * ## The two no-ops are answered, not performed
 *
 * Encrypting an encrypted note would re-encrypt it under a fresh note key,
 * which is a pointless write, a new etag, and a sync in every connected
 * Obsidian vault. Decrypting a plaintext note is the same in reverse. Both are
 * reported as already being in the asked-for state.
 */
export async function toolSetEncryption(store, scope, rules, overrides, args) {
  if (scope !== "private") {
    return toolError(
      "permission denied: only a personal connection can encrypt or decrypt a note",
    );
  }
  const path = normalizePath(args?.path);
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (typeof args?.encrypted !== "boolean") {
    return toolError("encrypted must be true or false");
  }
  // `canSee` first, as everywhere. A personal connection sees everything in its
  // own context, so this is the plumbing and manifest refusal rather than a
  // tenancy one — which the two checks above have already made.
  if (!canSee(path, scope, rules, overrides)) return toolError("not found");

  const existing = await getWithLegacyFallback(store, path);
  if (!existing) return toolError("not found");
  const expectedEtag = args?.expected_etag;
  const stored = await existing.text();
  const alreadyEncrypted = isEncryptedNote(stored);
  let recoveredSeal = false;
  if (alreadyEncrypted && args.encrypted && collaborationSupported(store) &&
      store.capabilities?.conditionalDelete === true) {
    const head = await collaborationHead(store, path);
    if (head?.status === "sealing" || head?.status === "sealed") {
      let recoveryExpected = expectedEtag || "sealed-recovery";
      if (head.status === "sealing" && typeof head.operationId === "string") {
        try {
          const journal = await store.get(
            `.context/collaboration/v1/structural/${head.operationId}.json`,
          );
          const operation = journal ? JSON.parse(await journal.text()) : null;
          if (typeof operation?.expectedEtag === "string") {
            recoveryExpected = operation.expectedEtag;
          }
        } catch {
          return toolError("this note cannot finish its encryption transition safely right now");
        }
      }
      try {
        await sealCollaborationDocument(store, path, {
          expectedEtag: recoveryExpected,
          text: stored,
        });
        recoveredSeal = true;
      } catch {
        return toolError("this note cannot finish its encryption transition safely right now");
      }
    }
  }
  let collaborationBase = null;
  if (!alreadyEncrypted && collaborationSupported(store) && collaborationEligible(path, stored)) {
    try {
      collaborationBase = await readCollaborationDocument(store, path);
    } catch {
      return toolError("this note's transition could not finish safely; re-read it and retry");
    }
  }
  const currentEtag = collaborationBase?.etag ?? existing.etag;
  if (expectedEtag && currentEtag !== expectedEtag && !recoveredSeal) {
    return toolError(
      `conflict: note changed since you read it (current etag ${currentEtag}). Re-read and try again.`,
    );
  }
  if (alreadyEncrypted === args.encrypted) {
    return toolText(
      `unchanged: ${path} is already ${args.encrypted ? "encrypted" : "stored as plain markdown"}`,
    );
  }

  const opened = await openStoredNote(store, stored);
  if (!opened.ok) return encryptedNoteRefusal(path);

  let body;
  if (args.encrypted) {
    body = await sealNoteContent(store, opened.text, stored);
    if (body === null) {
      // No key reached this request. Encrypting with one we cannot read back
      // would be writing a note nothing can open, so this refuses instead.
      return toolError(
        "this context has no encryption key available right now; nothing was changed",
      );
    }
  } else {
    body = opened.text;
  }

  let put;
  if (args.encrypted && collaborationBase) {
    try {
      const sealed = await sealCollaborationDocument(store, path, {
        documentId: collaborationBase.documentId,
        expectedEtag: collaborationBase.etag,
        text: body,
      });
      put = { etag: sealed.etag };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (["BASE_MISSING", "CONFLICT", "GENERATION_MISMATCH", "SEAL_CONFLICT", "CONCURRENT_WRITE"].includes(code)) {
        return toolError("conflict: note changed while it was being encrypted; re-read and try again");
      }
      return toolError("this note's encryption transition could not finish safely; re-read it and retry");
    }
  } else {
    put = await store.put(path, body, { onlyIf: { etagMatches: existing.etag } });
  }
  if (!put) {
    // Only where the backend honours it. A `null` here means the note changed
    // between the read and the write, and a full-body rewrite that overwrites
    // somebody's concurrent edit is the one failure this tool must not have.
    return toolError("conflict: note changed while it was being rewritten; re-read and try again");
  }

  // The path and the new state, never the note's content and never the key.
  await recordChange(store, args.encrypted ? "encrypt_note" : "decrypt_note", scope, [path], {
    etag: put.etag,
    encrypted: args.encrypted,
  });
  return toolText(
    args.encrypted
      ? `encrypted: ${path} (etag ${put.etag})\n` +
          "Its content is now stored as ciphertext. It stays readable through Context to everyone " +
          "its visibility already reaches, and it is no longer searchable."
      : `decrypted: ${path} (etag ${put.etag})\nIts content is stored as plain markdown again.`,
  );
}

/**
 * Export this context's workspace data key(s) in the clear.
 *
 * Owner-only through the gate the dispatcher already applies (`scope !==
 * "private"` is masked as an unknown tool, one level up). This function's own
 * job is the rest of `docs/decisions/encryption.md`'s "Revocation and
 * export": rate limit, audit, and the versioned bundle itself.
 *
 * **The exported bytes never appear in the audit entry, in a log, or in a
 * URL.** `recordChange` is given the generation ids — operator-chosen
 * configuration strings, already visible in every affected note's own
 * frontmatter — and nothing else. The key material is returned exactly once,
 * in this call's own response, and is not retained by this gateway across the
 * request that produced it.
 */
export async function toolExportEncryptionKeys(store, scope) {
  const key = store.encryptionKey;
  if (!key) {
    return toolText(
      "this context has never encrypted a note; there is nothing to export.",
    );
  }
  const workspaceId = store?.actor?.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    return toolError("this connection has no workspace to export a key for");
  }

  if (await checkAndConsumeExportRateLimit(store)) {
    return toolError(
      `rate limited: encryption keys were exported ${EXPORT_RATE_LIMIT.limit} times in the ` +
        "last 24 hours for this context; try again later.",
    );
  }

  let doc;
  try {
    doc = renderKeyExport({
      workspaceId,
      current: key.current,
      keys: Object.entries(key.keys).map(([generation, material]) => ({ generation, material })),
    });
  } catch (error) {
    if (error instanceof NoteCryptoError) return toolError(`could not build the export: ${error.message}`);
    throw error;
  }

  // Names the generations touched and nothing else — never the material, and
  // never in a log line either, because this is the same `recordChange` every
  // audited write in this gateway uses.
  await recordChange(store, "export_encryption_keys", scope, [], {
    generations: Object.keys(key.keys).sort().join(","),
    current: key.current,
  });

  return toolText(
    "Exported this context's workspace data key(s), below.\n\n" +
      "Store this somewhere safe and offline. With this and the notes already in your bucket, " +
      "your context is complete and usable without Context — no gateway, no control plane. " +
      "This is a one-way action: there is no way to make this key material secret again once it " +
      "has left this response.\n\n" +
      // The one thing this file does NOT open, said here rather than found out
      // later: a note locked with a passphrase carries no workspace recipient,
      // so no export of ours can open it and none ever will. Saying "your
      // context is complete" without this sentence would be the overclaim
      // `docs/decisions/encryption.md` spends a whole section refusing.
      "One exception, and it is the feature working: a note you locked with a passphrase is not " +
      "opened by this file. Its key is your passphrase and was never written down anywhere — keep " +
      "that safe separately.\n\n" +
      "Open your notes with it using the offline decryptor: packages/encryption-decryptor (MIT-licensed, " +
      "zero dependencies, plain Web Crypto). The full format is docs/decisions/encryption.md.\n\n" +
      JSON.stringify(doc, null, 2),
  );
}
