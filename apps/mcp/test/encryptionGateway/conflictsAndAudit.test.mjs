/**
 * Sections (10)-(13): "off" actually turns encryption off, a conflict
 * response hands back an envelope rather than leaking plaintext, nothing of
 * the decrypted body reaches a log, and the audit trail records the path an
 * encrypted note took, never its content. See encryptionGateway.test.mjs
 * for the module overview and the sabotage-testing record.
 */

import { KEY_A, KEY_B, SECRET_BODY, indexableText } from "./fixtures.mjs";

export async function runEncryptionGatewayConflictsAndAuditChecks(check, harness) {
  const { a, call, KEYLESS, OWNER_A, readA, storeA, textOf, TEAM_A } = harness;

    /* -- (10) and off means off --------------------------------------------- */

    const decrypted = await call(OWNER_A, "set_encryption", {
      path: "1-projects/moved-secret.md",
      encrypted: false,
    });
    check(
      "an owner can decrypt a note again",
      !decrypted?.isError && readA("1-projects/moved-secret.md") === SECRET_BODY,
    );
    check(
      "...and it stops being excluded from the indexes",
      indexableText(readA("1-projects/moved-secret.md")) === SECRET_BODY,
    );
    // Asserted on the exclusion rather than on a search result, and the
    // difference is real rather than a convenience. The index still holds the
    // empty row it was given while the note was encrypted, and the pass that
    // replaces it runs behind the response — which this harness discards, and
    // which in production is the same one reconcile interval every other stale
    // row waits for. Asserting "a search finds it now" would be asserting that
    // the index is synchronous, which it is not and never was.
    const searchedAfter = await call(OWNER_A, "search_notes", { query: "forty-two" });
    check(
      "...and searching still works, from the index as it stands",
      !searchedAfter?.isError && textOf(searchedAfter).includes("1-projects/open.md"),
    );
    const decryptAgain = await call(OWNER_A, "set_encryption", {
      path: "1-projects/moved-secret.md",
      encrypted: false,
    });
    check(
      "decrypting a plaintext note is answered, not performed",
      !decryptAgain?.isError && /already stored as plain markdown/.test(textOf(decryptAgain)),
    );

    /* -- (11) the conflict body is the other way to hand back an envelope ---- */
    //
    // `write_note`'s stale-etag branch returns the note's *current content* and
    // tells the client to merge into it. That is a second place a caller is
    // handed a body, and if it were the stored bytes the client would merge its
    // change into base64 and post the result — which the write path would then
    // store as the note's new plaintext content. The refusal direction matters
    // as much: a caller with no key must not receive the envelope here either.

    await storeA.put("1-projects/conflict.md", SECRET_BODY);
    await call(OWNER_A, "set_encryption", { path: "1-projects/conflict.md", encrypted: true });
    const conflictCiphertext = readA("1-projects/conflict.md");

    const stale = await call(OWNER_A, "write_note", {
      path: "1-projects/conflict.md",
      content: "# whatever\n",
      expected_etag: "etag-nobody-ever-minted",
    });
    check(
      "a stale-etag write to an encrypted note is refused, not applied",
      stale?.isError === true && /conflict/.test(textOf(stale)),
    );
    check(
      "...and the envelope in the bucket is byte-for-byte unchanged",
      readA("1-projects/conflict.md") === conflictCiphertext,
    );
    check(
      "...and the body it hands back to merge into is the plaintext, never the envelope",
      textOf(stale).includes("# Compensation review") &&
        !textOf(stale).includes("context-encrypted") &&
        !textOf(stale).includes("A256GCM"),
    );

    // The same branch, for a connection that holds no key. It cannot open the
    // note, so there is nothing it could correctly be told to merge into — and
    // the one answer it must not get is the ciphertext.
    const keylessConflict = await call(KEYLESS, "write_note", {
      path: "1-projects/conflict.md",
      content: "# whatever\n",
      expected_etag: "etag-nobody-ever-minted",
    });
    check(
      "a keyless connection's stale-etag write is refused as locked, not answered with ciphertext",
      keylessConflict?.isError === true &&
        /encrypted/.test(textOf(keylessConflict)) &&
        !textOf(keylessConflict).includes("A256GCM") &&
        !textOf(keylessConflict).includes("context-encrypted"),
    );
    check(
      "...and it changed nothing either",
      readA("1-projects/conflict.md") === conflictCiphertext,
    );

    /* -- (12) nothing of the plaintext reaches a log ------------------------- */
    //
    // "Structured logs carry request, workspace and grant identifiers, never
    // secrets and never note content." An encrypted note is the sharpest case
    // of that rule, and it is the one place a refusal is deliberately *not*
    // uniform — so the message it logs has to be checked rather than assumed.
    // Every line the worker emits across a full cycle is swept, for the
    // plaintext, for the key, and for the envelope.

    const logLines = [];
    const realLog = console.log;
    console.log = (...args) => logLines.push(args.map(String).join(" "));
    try {
      await call(OWNER_A, "read_note", { path: "1-projects/conflict.md" });
      await call(TEAM_A, "read_note", { path: "1-projects/vault/private-secret.md" });
      await call(KEYLESS, "read_note", { path: "1-projects/conflict.md" });
      await call(OWNER_A, "search_notes", { query: "forty-two" });
      await call(OWNER_A, "list_changes", {});
      await call(OWNER_A, "set_encryption", {
        path: "1-projects/conflict.md",
        encrypted: false,
      });
      await call(OWNER_A, "set_encryption", {
        path: "1-projects/conflict.md",
        encrypted: true,
      });
    } finally {
      console.log = realLog;
    }
    const logged = logLines.join("\n");
    check(
      "no log line carries the plaintext of an encrypted note",
      logLines.length > 0 &&
        !logged.includes("forty-two") &&
        !logged.includes("Compensation review") &&
        !logged.includes("payroll"),
    );
    check(
      "...nor the workspace data key, in either alphabet",
      !logged.includes(KEY_A) &&
        !logged.includes(KEY_B) &&
        !logged.includes(KEY_A.slice(0, 16)) &&
        !logged.includes(KEY_B.slice(0, 16)),
    );
    check(
      "...nor an envelope, which is somebody's bytes even where it is unreadable",
      !logged.includes("context-encrypted") && !logged.includes("A256GCM"),
    );

    /* -- (13) and the audit trail records the path, never the content ------- */

    const auditKeys = [...a.objects.keys()].filter((key) => key.startsWith(".context/audit/"));
    const audit = auditKeys
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "the audit trail records that a note was encrypted, and names it",
      auditKeys.length > 0 &&
        /encrypt_note/.test(audit) &&
        audit.includes("1-projects/conflict.md"),
    );
    check(
      "...and carries none of its content, and no envelope, and no key",
      !audit.includes("forty-two") &&
        !audit.includes("Compensation review") &&
        !audit.includes("A256GCM") &&
        !audit.includes(KEY_A.slice(0, 16)),
    );
}
