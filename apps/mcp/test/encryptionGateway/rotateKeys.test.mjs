/**
 * Section (16): `rotate_encryption_keys`. Reuses the passphrase-locked note
 * pinned at `harness.LOCKED` (section 14) and the smuggled-argument attack
 * shape at `harness.SMUGGLED` (section 15) to prove a rotation leaves both
 * alone. See encryptionGateway.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import { KEY_A, KEY_B, SECRET_BODY, isEncryptedNote, parseEncryptedNote } from "./fixtures.mjs";

export async function runEncryptionGatewayRotateKeysChecks(check, harness) {
  const { a, call, KEYLESS, LOCKED, OWNER_A, readA, readB, SMUGGLED, textOf, TEAM_A } = harness;

    /* -- (16) rotate_encryption_keys ------------------------------------------ */

    const teamRotate = await call(TEAM_A, "rotate_encryption_keys", {});
    check(
      "a team connection cannot see rotate_encryption_keys exists either",
      teamRotate?.isError === true && textOf(teamRotate) === "unknown tool: rotate_encryption_keys",
    );

    const keylessRotate = await call(KEYLESS, "rotate_encryption_keys", {});
    check(
      "a context with no key has nothing to rotate, and it is not a refusal",
      !keylessRotate?.isError && /nothing to rotate/.test(textOf(keylessRotate)),
    );

    // Four WORKSPACE-encrypted notes exist by this point:
    // `1-projects/vault/private-secret.md` (encrypted in section (3) and never
    // decrypted), `1-projects/conflict.md` (left encrypted by section (12)),
    // the one section (14) re-sealed while proving the write guard, and the
    // crash-recovery fixture above whose sealing journal was resumed.
    // `1-projects/moved-secret.md`, moved in section (6), was decrypted again
    // in section (10) and is plaintext.
    //
    // And one note that is NOT among them: `1-projects/locked.md`, the
    // passphrase-locked note from section (14), which carries a `passphrase`
    // recipient and no workspace one. The rotation walk must pass it by —
    // there is no workspace recipient in it to move, its key is not ours, and
    // the failure to avoid is a pass that counts it as a note it could not
    // place and therefore never reports itself finished. It is skipped on the
    // frontmatter marker, which `renderEncryptedNote` omits for a note with no
    // workspace recipient precisely so this walk does not go looking for a key
    // called "undefined".
    const beforeRotate = readA("1-projects/vault/private-secret.md");
    const lockedBeforeRotate = readA(LOCKED);
    const rotated = await call(OWNER_A, "rotate_encryption_keys", {});
    check(
      "rotation reports what it did and completes in one call for a small context",
      !rotated?.isError &&
        /rotation complete: k1 → k2/.test(textOf(rotated)) &&
        /4 note\(s\) re-wrapped/.test(textOf(rotated)),
    );
    check(
      "a passphrase-locked note is passed over by the walk, byte for byte, and does not stall it",
      readA(LOCKED) === lockedBeforeRotate,
    );

    const afterRotate = readA("1-projects/vault/private-secret.md");
    check(
      "the note's body ciphertext is byte-for-byte unchanged by rotation",
      isEncryptedNote(afterRotate) &&
        isEncryptedNote(beforeRotate) &&
        parseEncryptedNote(afterRotate).ct === parseEncryptedNote(beforeRotate).ct &&
        parseEncryptedNote(afterRotate).iv === parseEncryptedNote(beforeRotate).iv,
    );
    check(
      "...but its frontmatter now names the new generation",
      /context_encryption_key: ws:k2/.test(afterRotate),
    );

    const readAfterRotate = await call(OWNER_A, "read_note", {
      path: "1-projects/vault/private-secret.md",
    });
    check(
      "the rotated note still reads back to exactly its plaintext",
      !readAfterRotate?.isError && textOf(readAfterRotate).endsWith(SECRET_BODY),
    );

    // Calling the tool again with no rotation in progress starts a FRESH one
    // (k2 -> k3) — rotation has no "already rotated, do nothing" state, only
    // "a walk is in progress" or not. All four live notes move again, and the
    // walk completes in the same call for a context this small.
    const rotateAgain = await call(OWNER_A, "rotate_encryption_keys", {});
    check(
      "rotating again with no walk in progress starts and completes a fresh rotation",
      !rotateAgain?.isError &&
        /rotation complete: k2 → k3/.test(textOf(rotateAgain)) &&
        /4 note\(s\) re-wrapped/.test(textOf(rotateAgain)),
    );
    check(
      "...and the locked note is still exactly what it was, two rotations later",
      readA(LOCKED) === lockedBeforeRotate,
    );

    const auditAfterRotate = [...a.objects.keys()]
      .filter((key) => key.startsWith(".context/audit/"))
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "rotation is audited by generation id, never by key material",
      /rotate_encryption_keys/.test(auditAfterRotate) &&
        !auditAfterRotate.includes(KEY_A) &&
        !readA("1-projects/vault/private-secret.md").includes(KEY_A),
    );

    /*
      THE ROTATION HALF OF THE SMUGGLED-ARGUMENT ATTACK, ASKED LAST.

      The export half is above, beside the other export checks. This one has
      the sharper version of the same question and belongs here, after two
      real rotations, because it performs a third: two of the names in
      `SMUGGLED` are the literal flags `/gateway/binding` accepts
      (`startEncryptionRotation`, `completeEncryptionRotation`), so a tool
      that passed its arguments through to `store.rotateEncryptionKeys` would
      hand a caller a rotation of somebody else's workspace key — the one
      operation in this file that can strand every note in a bucket.

      Three things have to hold now. B's bytes are untouched, which was always
      the point. Nothing rotated at all, because the call is refused for its
      arguments before `callTool` runs — the strongest of the available
      answers, and the reason the third real rotation this block used to
      perform never happens: A stays on k3. And the refusal names only the
      caller's own property, disclosing neither key nor workspace id.

      A does not rotate is the load-bearing half, and it is asserted by the
      bytes rather than by the message: a completed rotation re-wraps every
      encrypted note in the bucket, so an unchanged ciphertext for A's own
      secret is what says the rotation did not run.
    */
    const bStolenBefore = readB("1-projects/stolen.md");
    const bOwnBefore = readB("1-projects/own.md");
    const aSecretBefore = readA("1-projects/vault/private-secret.md");
    const smuggledRotate = await call(OWNER_A, "rotate_encryption_keys", { ...SMUGGLED });
    check(
      "a rotation named at another context in every argument rotates nothing, and leaves that one's bytes alone",
      smuggledRotate?.isError === true &&
        textOf(smuggledRotate).startsWith("unknown argument") &&
        textOf(smuggledRotate).includes("permitted here: context") &&
        !/rotation complete/.test(textOf(smuggledRotate)) &&
        !textOf(smuggledRotate).includes(KEY_A) &&
        !textOf(smuggledRotate).includes(KEY_B) &&
        !textOf(smuggledRotate).includes("ws_enc_b") &&
        readA("1-projects/vault/private-secret.md") === aSecretBefore &&
        readB("1-projects/stolen.md") === bStolenBefore &&
        readB("1-projects/own.md") === bOwnBefore,
    );
}
