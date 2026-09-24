/**
 * Sections (1)-(9): turning encryption on, reading it back, the two privacy
 * channels (team inference and tenant isolation), a round trip that is not a
 * downgrade, a move and a link rewrite that do not touch the bytes, search
 * never quoting one, and a keyless context's notes staying locked rather
 * than lost. See encryptionGateway.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  FENCE_LANGUAGE,
  KEY_A,
  SECRET_BODY,
  indexableText,
  isEncryptedNote,
  parseEncryptedNote,
  parseLinks,
} from "./fixtures.mjs";

export async function runEncryptionGatewayCoreChecks(check, harness) {
  const { a, call, KEYLESS, OWNER_A, OWNER_B, readA, storeA, storeB, textOf, TEAM_A } = harness;

    /* -- (1) turning it on -------------------------------------------------- */

    const refusedTeam = await call(TEAM_A, "set_encryption", {
      path: "1-projects/team-secret.md",
      encrypted: true,
    });
    check(
      "a team connection cannot encrypt a note",
      refusedTeam?.isError === true && /only a personal connection/.test(textOf(refusedTeam)),
    );
    check(
      "...and nothing was written",
      readA("1-projects/team-secret.md") === SECRET_BODY,
    );

    const encrypted = await call(OWNER_A, "set_encryption", {
      path: "1-projects/team-secret.md",
      encrypted: true,
    });
    check(
      "an owner can encrypt a note, and is told what that did and did not do",
      !encrypted?.isError &&
        /^encrypted: 1-projects\/team-secret\.md/.test(textOf(encrypted)) &&
        /no longer searchable/.test(textOf(encrypted)),
    );

    const storedSecret = readA("1-projects/team-secret.md");
    check(
      "the bucket now holds ciphertext and no fragment of the plaintext",
      isEncryptedNote(storedSecret) &&
        !storedSecret.includes("forty-two") &&
        !storedSecret.includes("payroll") &&
        !storedSecret.includes("1-projects/alpha"),
    );
    check(
      "...and it is still a file at its own path, marked so a human can see it",
      storedSecret.startsWith("---\ncontext_encryption: v1\n") &&
        storedSecret.includes("This note is encrypted."),
    );
    check(
      "...and the key itself is nowhere in the bucket",
      !storedSecret.includes(KEY_A) && !readA("privacy.md").includes(KEY_A),
    );

    const again = await call(OWNER_A, "set_encryption", {
      path: "1-projects/team-secret.md",
      encrypted: true,
    });
    check(
      "encrypting an encrypted note is answered, not performed",
      !again?.isError &&
        /already encrypted/.test(textOf(again)) &&
        readA("1-projects/team-secret.md") === storedSecret,
    );

    await storeA.put("1-projects/crash-retry.md", "# crash retry\n\nplaintext history\n");
    a.controls.crashAfterEncryptedWrite = "1-projects/crash-retry.md";
    const crashedSeal = await call(OWNER_A, "set_encryption", {
      path: "1-projects/crash-retry.md",
      encrypted: true,
    });
    const strandedEnvelope = readA("1-projects/crash-retry.md");
    const sealingHead = [...a.objects]
      .filter(([key]) => key.startsWith(".context/collaboration/v1/heads/"))
      .map(([, value]) => JSON.parse(new TextDecoder().decode(value.bytes)))
      .find((head) => head.status === "sealing");
    check("a crash can land ciphertext while the collaboration seal is still pending",
      crashedSeal?.isError === true && isEncryptedNote(strandedEnvelope) &&
      typeof sealingHead?.documentId === "string");

    const resumedSeal = await call(OWNER_A, "set_encryption", {
      path: "1-projects/crash-retry.md",
      encrypted: true,
    });
    const recoveredHead = [...a.objects]
      .filter(([key]) => key.startsWith(".context/collaboration/v1/heads/"))
      .map(([, value]) => JSON.parse(new TextDecoder().decode(value.bytes)))
      .find((head) => head.documentId === sealingHead?.documentId);
    const recoveredPlaintextKeys = [...a.objects.keys()].filter((key) =>
      sealingHead?.documentId &&
      (key.includes(`/documents/${sealingHead.documentId}`) ||
        key.includes(`/revisions/${sealingHead.documentId}/`)));
    const purgedPlaintext = (await Promise.all(
      recoveredPlaintextKeys.map((key) => storeA.get(key)),
    )).every((value) => value === null);
    check("retrying already-written ciphertext finishes the seal and purges plaintext history",
      !resumedSeal?.isError && /already encrypted/.test(textOf(resumedSeal)) &&
      recoveredHead?.status === "sealed" &&
      purgedPlaintext);

    /* -- (2) reading it back ------------------------------------------------ */

    const readBack = await call(OWNER_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "the owner reads the plaintext back, whole",
      !readBack?.isError && textOf(readBack).endsWith(SECRET_BODY),
    );
    check(
      "...and is told the note is encrypted",
      /\nencryption: v1\n/.test(textOf(readBack)),
    );

    // The half that proves encryption is orthogonal to visibility rather than a
    // second private tier: this note is `team`, so the team connection reads it.
    const teamRead = await call(TEAM_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "a team connection reads an encrypted TEAM note, decrypted",
      !teamRead?.isError && textOf(teamRead).endsWith(SECRET_BODY),
    );

    /* -- (3) a team caller cannot infer a private encrypted note ------------ */

    await call(OWNER_A, "set_encryption", {
      path: "1-projects/vault/private-secret.md",
      encrypted: true,
    });
    const hiddenReal = await call(TEAM_A, "read_note", {
      path: "1-projects/vault/private-secret.md",
    });
    const hiddenInvented = await call(TEAM_A, "read_note", {
      path: "1-projects/vault/no-such-note.md",
    });
    check(
      "a team connection is refused a private encrypted note",
      hiddenReal?.isError === true,
    );
    check(
      "...with the byte-identical refusal a path that never existed gets",
      textOf(hiddenReal) === textOf(hiddenInvented) && textOf(hiddenReal) === "not found",
    );
    const teamList = await call(TEAM_A, "list_notes", { prefix: "1-projects" });
    check(
      "...and it is not listed, encrypted or otherwise",
      !textOf(teamList).includes("private-secret.md"),
    );

    /* -- (4) tenant isolation: the same bytes, the other tenant ------------- */

    await storeB.put("1-projects/stolen.md", storedSecret);
    const stolen = await call(OWNER_B, "read_note", { path: "1-projects/stolen.md" });
    check(
      "another workspace's key does not open this workspace's ciphertext",
      stolen?.isError === true && /encrypted and this connection cannot open it/.test(textOf(stolen)),
    );
    check(
      "...and the refusal is not the ciphertext with a warning on it",
      !textOf(stolen).includes(parseEncryptedNote(storedSecret).ct.slice(0, 32)),
    );
    // Non-vacuity: B is a working context that can encrypt and read its own.
    await storeB.put("1-projects/own.md", "# b's own note\n\nthe number is nine\n");
    await call(OWNER_B, "set_encryption", { path: "1-projects/own.md", encrypted: true });
    const bOwn = await call(OWNER_B, "read_note", { path: "1-projects/own.md" });
    check(
      "...while B reads B's own encrypted note perfectly well",
      !bOwn?.isError && textOf(bOwn).endsWith("# b's own note\n\nthe number is nine\n"),
    );

    /* -- (5) a round trip is not a downgrade -------------------------------- */

    const echoed = await call(OWNER_A, "write_note", {
      path: "1-projects/team-secret.md",
      content: `${SECRET_BODY}\nAnd one more line.\n`,
    });
    check("a plaintext write to an encrypted note succeeds", !echoed?.isError);
    check(
      "...and the note is still stored as ciphertext",
      isEncryptedNote(readA("1-projects/team-secret.md")) &&
        !readA("1-projects/team-secret.md").includes("And one more line."),
    );
    const afterEcho = await call(OWNER_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "...and it reads back as exactly what was written",
      textOf(afterEcho).endsWith(`${SECRET_BODY}\nAnd one more line.\n`),
    );

    // The other direction of the same rule: a client that posts something
    // envelope-shaped is writing *content*, not an envelope. Storing it raw
    // would let any writer replace a note with a document nothing can open.
    const envelopeShaped = readA("1-projects/team-secret.md");
    await call(OWNER_A, "write_note", {
      path: "1-projects/team-secret.md",
      content: envelopeShaped,
    });
    const nested = await call(OWNER_A, "read_note", { path: "1-projects/team-secret.md" });
    check(
      "an envelope-shaped body is stored as content, encrypted, not as a raw envelope",
      isEncryptedNote(readA("1-projects/team-secret.md")) &&
        textOf(nested).includes("context_encryption: v1") &&
        readA("1-projects/team-secret.md") !== envelopeShaped,
    );
    // Put it back, so the checks below are about a note and not about that one.
    await call(OWNER_A, "write_note", {
      path: "1-projects/team-secret.md",
      content: SECRET_BODY,
    });

    /* -- (6) a move does not touch the bytes -------------------------------- */

    const before = readA("1-projects/team-secret.md");
    const moved = await call(OWNER_A, "move_note", {
      source: "1-projects/team-secret.md",
      destination: "1-projects/moved-secret.md",
    });
    check("an encrypted note moves", !moved?.isError);
    check(
      "...and its ciphertext is byte-for-byte what it was",
      readA("1-projects/moved-secret.md") === before &&
        await storeA.get("1-projects/team-secret.md") === null,
    );
    const afterMove = await call(OWNER_A, "read_note", { path: "1-projects/moved-secret.md" });
    check(
      "...and it still opens at the new path, which is what binding the AAD to the workspace buys",
      !afterMove?.isError && textOf(afterMove).endsWith(SECRET_BODY),
    );

    /* -- (7) a link rewrite leaves it alone, and still rewrites the rest ---- */

    await storeA.put(
      "1-projects/pointer.md",
      "# pointer\n\npoints at [[1-projects/alpha]]\n",
    );
    const ciphertextBefore = readA("1-projects/moved-secret.md");
    const renamed = await call(OWNER_A, "move_note", {
      source: "1-projects/alpha.md",
      destination: "1-projects/renamed.md",
    });
    check("the neighbour's rename succeeds", !renamed?.isError);
    check(
      "a plaintext note pointing at it was rewritten",
      readA("1-projects/pointer.md") === "# pointer\n\npoints at [[1-projects/renamed]]\n",
    );
    check(
      "...and the encrypted note's bytes were not touched at all",
      readA("1-projects/moved-secret.md") === ciphertextBefore,
    );

    /* -- (8) search never quotes one ---------------------------------------- */

    /*
     * THIS ONE FIRST, AND THE ORDER IS THE TEST.
     *
     * Nothing has searched this context yet, so there is no index and the query
     * falls to the literal scan — the recovery path that reads live bytes out
     * of the bucket. "A256GCM" is a string that appears in every envelope and
     * in no note anybody writes, so it is the one needle that can tell a scan
     * which skips encrypted notes from a scan which happily matches their
     * wrapper and cuts a snippet out of it.
     *
     * A later search would prove nothing here: by then the index exists, it
     * holds the note as the empty string, and the scan is not reached at all.
     */
    const scanned = await call(OWNER_A, "search_notes", { query: "A256GCM" });
    check(
      "the literal scan does not match an encrypted note's own envelope",
      !textOf(scanned).includes("moved-secret") && !textOf(scanned).includes("A256GCM"),
    );

    const searched = await call(OWNER_A, "search_notes", { query: "forty-two" });
    check(
      "search does not find an encrypted note's content",
      !textOf(searched).includes("moved-secret") && !textOf(searched).includes("forty-two"),
    );
    // Non-vacuity: the same word in a plaintext note is found, so the check
    // above is not passing because search is broken.
    await storeA.put("1-projects/open.md", "# open\n\nthe number is forty-two here\n");
    const searchedOpen = await call(OWNER_A, "search_notes", { query: "forty-two" });
    check(
      "...while the same word in a plaintext note is found",
      textOf(searchedOpen).includes("1-projects/open.md"),
    );

    /*
     * AND THE COUNT MUST NOT COUNT WHAT THE HITS DO NOT SHOW.
     *
     * `visible.js` drops an encrypted note when it reads the body for a
     * snippet, but `matchCount` is `visible.length` — taken before that drop.
     * The index holds the note with empty content, so no body term ranks it,
     * but its PATH still can: MEASURED, a search for "moved" answered
     * "2 matching notes — the 1 best shown" with the encrypted note counted
     * and withheld.
     *
     * The word is NOT unique to `1-projects/moved-secret.md`, and an earlier
     * version of this comment said it was — contradicted by the check twelve
     * lines below, which asserts the plaintext hit and calls it correct. The
     * move rewrote `1-projects/alpha.md`'s link to `[[1-projects/moved-secret]]`
     * before that note was renamed, so the word is in a body this caller may
     * read. Which is why the assertion is about the COUNT rather than about
     * where the word occurs.
     *
     * Nothing leaks: `rankedVisibleTo` runs first, so only notes this caller
     * may see are ever counted, and the byte-identical promise
     * `docs/decisions/encryption.md` makes to a team-tier caller is untouched.
     * What is wrong is that `search does not find encrypted notes` is stated
     * flatly while the count still counts them, and "the N best shown" tells an
     * agent there is another match to page to when there is not.
     */
    const counted = await call(OWNER_A, "search_notes", { query: "moved" });
    const countedText = textOf(counted);
    const headline = countedText.split("\n")[0] ?? "";
    const shown = (countedText.match(/^1-projects\//gm) ?? []).length;
    const claimed = Number(headline.match(/^(\d+)/)?.[1] ?? "0");
    check(
      "THE MATCH COUNT DOES NOT COUNT AN ENCRYPTED NOTE IT WILL NOT SHOW",
      headline === "(no matches)" ? shown === 0 : claimed === shown,
    );
    check(
      "...and the one hit shown is the plaintext note that legitimately links to it",
      /*
        NOT "the encrypted note is never named". That assertion was written
        first and was false for a good reason: `1-projects/renamed.md` is a
        plaintext note whose body holds `[[1-projects/moved-secret]]`, and a
        search quoting its own body is correct. What must not appear is the
        encrypted note as a HIT of its own.
      */
      countedText.includes("1-projects/renamed.md") &&
        !/^1-projects\/moved-secret\.md$/m.test(countedText),
    );

    const fetched = await call(OWNER_A, "fetch", { id: "1-projects/moved-secret.md" });
    check(
      "the ChatGPT fetch dialect returns the plaintext for a caller that holds the key",
      !fetched?.isError && JSON.parse(textOf(fetched)).text.includes("forty-two"),
    );
    const fetchedStolen = await call(OWNER_B, "fetch", { id: "1-projects/stolen.md" });
    check(
      "...and refuses rather than putting ciphertext in a chat transcript",
      fetchedStolen?.isError === true,
    );

    check(
      "an encrypted note reaches both indexes as the empty string",
      indexableText(ciphertextBefore) === "" && indexableText(SECRET_BODY) === SECRET_BODY,
    );

    /*
     * AND THE INDEX THAT WAS ACTUALLY BUILT HOLDS NONE OF IT.
     *
     * The line above is a unit assertion about `indexableText`, and it was the
     * whole of the evidence for "nothing of an encrypted note reaches the
     * index". MEASURED: it was not true. `syncShardedIndex` — the pass every
     * search and every scheduled sweep actually runs — read note bodies with a
     * bare `object.text()`, so an envelope's own terms (`a256gcm`,
     * `context-encrypted`, the callout's words, the base64url of `ct`) were
     * tokenised into `.context/search/v2/shard-*.json`, an object that lives **in the
     * customer's own bucket under the same credential as the note**. The
     * `indexableText` call the decision file points at lived in `syncIndex`,
     * which nothing has called since the v2 index landed.
     *
     * That is not a plaintext leak — the terms come from the ciphertext the
     * bucket already holds — and it is exactly the shape `testing.md` calls a
     * guard nobody has checked: the assertion above passes for an
     * implementation that never calls the function it asserts about.
     *
     * So this asks the index itself, in both directions, because an assertion
     * that only checks for absence passes just as well against an index that
     * was never built.
     */
    const indexObjects = [...a.objects.keys()]
      .filter((key) => key.startsWith(".context/search/"))
      .map((key) => new TextDecoder().decode(a.objects.get(key).bytes))
      .join("\n");
    check(
      "the index that was really built holds the plaintext notes it should",
      indexObjects.length > 0 && indexObjects.includes("pointer"),
    );
    check(
      "...and not one term of an encrypted note's envelope",
      !/a256gcm/i.test(indexObjects) &&
        !indexObjects.includes(FENCE_LANGUAGE) &&
        !indexObjects.includes(parseEncryptedNote(ciphertextBefore).ct.slice(0, 24)),
    );

    /*
     * THE LINK REWRITER'S SKIP, ASKED THE ONLY WAY IT CAN BE ASKED.
     *
     * Deleting `rewriteReferences`' `isEncryptedNote` guard breaks nothing
     * measurable today, and that is worth stating rather than hiding behind a
     * sabotage count of zero. The reason is this line: an envelope contains
     * nothing a link parser can match. `ct` is base64url, whose alphabet has no
     * brackets at all, and the surrounding JSON has no `[[` and no `](`.
     *
     * So the skip is a margin rather than a load-bearing check — and this is
     * what keeps it one. The day the envelope grows a field that can carry a
     * bracket, this fails, and the skip is what stops a link rewrite corrupting
     * a note nothing can then recover.
     */
    check(
      "an envelope carries nothing a link rewriter could match",
      parseLinks(ciphertextBefore).length === 0,
    );

    /* -- (9) no key is a locked note, never a lost one ---------------------- */

    // `ws_enc_none` is bound to the same bucket and holds no key.
    const lockedRead = await call(KEYLESS, "read_note", { path: "1-projects/moved-secret.md" });
    check(
      "a context with no key is refused an encrypted note, and told what it is",
      lockedRead?.isError === true &&
        /encrypted and this connection cannot open it/.test(textOf(lockedRead)),
    );
    check(
      "...and its plaintext notes still read perfectly well",
      !(await call(KEYLESS, "read_note", { path: "1-projects/open.md" }))?.isError,
    );
    const lockedWrite = await call(KEYLESS, "write_note", {
      path: "1-projects/moved-secret.md",
      content: "# I am replacing this with plaintext\n",
    });
    check(
      "...and it CANNOT overwrite an encrypted note with plaintext",
      lockedWrite?.isError === true &&
        readA("1-projects/moved-secret.md") === ciphertextBefore,
    );
    const lockedEncrypt = await call(KEYLESS, "set_encryption", {
      path: "1-projects/open.md",
      encrypted: true,
    });
    check(
      "...and it cannot encrypt a note into a form nothing could open",
      lockedEncrypt?.isError === true &&
        !isEncryptedNote(readA("1-projects/open.md")),
    );
}
