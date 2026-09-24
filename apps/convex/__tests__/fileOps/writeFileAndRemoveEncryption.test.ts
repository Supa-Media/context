import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  deletePath,
  readFile,
  removeNoteEncryption,
  writeFile,
} from "../../functions/lib/fileOps";
import {
  NOW,
  bucket,
  capture,
  errorShape,
  names,
} from "./fixtures.helpers";


/**
 * A PASSPHRASE-LOCKED NOTE, EDITED, RE-PASSPHRASED AND REMOVED THROUGH THE
 * CONTROL PLANE.
 *
 * The console never holds a workspace key, so the only encrypted note it can
 * ever legitimately *produce* is one with a `passphrase` recipient and nothing
 * else — see `apps/mobile/features/console/encryption/envelope.ts`. These
 * fixtures build that shape by hand, in the control plane's own test, so this
 * suite exercises `canReplaceEncryptedNote` (and the door it guards) without
 * pulling the mobile app's crypto into a Convex test file.
 */
function passphraseNote(
  recipients: Array<{ kind?: string; id: string }>,
  body: { iv?: string; ct?: string } = {},
): string {
  const envelope = {
    v: 1,
    alg: "A256GCM",
    iv: body.iv ?? "AAAAAAAAAAAAAAAA",
    ct: body.ct ?? "AAAA",
    aad: "context-note-v1:ws_x",
    recipients: recipients.map((recipient) => ({
      kind: recipient.kind ?? "passphrase",
      id: recipient.id,
      alg: "A256GCM",
      iv: "BBBBBBBBBBBBBBBB",
      wrapped: "CCCC",
      kdf:
        (recipient.kind ?? "passphrase") === "passphrase"
          ? { id: "argon2id", v: 19, m: 19456, t: 2, p: 1, salt: "DDDDDDDDDDDDDDDD" }
          : undefined,
    })),
  };
  return [
    "---",
    "context_encryption: v1",
    "---",
    "",
    "> [!NOTE] This note is encrypted.",
    "",
    "```context-encrypted",
    JSON.stringify(envelope),
    "```",
    "",
  ].join("\n");
}

/**
 * ## Sabotage record for this suite and the one below it
 *
 * Run as temporary local edits and reverted; counts are failing tests across
 * the whole `apps/convex` run.
 *
 *   `canReplaceEncryptedNote`'s skeleton comparison removed                 6
 *   `writeFile`'s encrypted-note refusal removed entirely                  15
 *
 * The six are the smuggling shapes: content around the fence in three
 * positions, a second fenced block, a fence smuggled into the frontmatter, and
 * a line-ending rewrite. The one shape that does *not* move is the hand-written
 * multi-line JSON blob, and that is the point of having it — it is refused by
 * the parse rather than by the skeleton, because both cut the blob at the same
 * first `\n``` `, so it stays refused however the skeleton is broken.
 */
describe("writeFile's widened door: an envelope may replace an envelope", () => {
  test("the same recipient set, re-encrypted under a fresh IV, is accepted — an edit while unlocked", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const after = passphraseNote([{ id: "p1" }], { iv: "QQQQQQQQQQQQQQQQ", ct: "ZZZZ" });
    const written = await writeFile(store, {
      path: "1-projects/locked.md",
      text: after,
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(written.path).toBe("1-projects/locked.md");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(after);
  });

  test("the same single recipient, rewrapped under a new passphrase, is accepted — a passphrase change", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    // Same recipient `{kind, id}`, different `wrapped` and `kdf.salt` — exactly
    // what `changePassphrase` in the console produces, and nothing about the
    // body (`ct`/`iv`/`aad`) moves.
    const after = before.replace("CCCC", "EEEE").replace("DDDDDDDDDDDDDDDD", "FFFFFFFFFFFFFFFF");
    const written = await writeFile(store, {
      path: "1-projects/locked.md",
      text: after,
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(written.path).toBe("1-projects/locked.md");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(after);
  });

  test("plaintext is still refused, even though the door is now open for envelopes", async () => {
    const store = bucket();
    store.seed("1-projects/locked.md", passphraseNote([{ id: "p1" }]));
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: "# I decrypted this myself\n",
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(passphraseNote([{ id: "p1" }]));
  });

  test("a different recipient id is refused — the door is not a rename", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: passphraseNote([{ id: "p2" }]),
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("an added workspace recipient is refused — nothing may sneak a second key onto a passphrase note", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: passphraseNote([{ id: "p1" }, { kind: "workspace", id: "k1" }]),
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("a replacement envelope this control plane cannot parse is refused", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const brokenReplacement = [
      "---",
      "context_encryption: v1",
      "---",
      "",
      "```context-encrypted",
      "not json",
      "```",
      "",
    ].join("\n");
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: brokenReplacement,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("a stored envelope this control plane cannot parse refuses every replacement, even an identical-looking one", async () => {
    const store = bucket();
    const broken = "---\ncontext_encryption: v1\n---\n\nnot an envelope\n";
    store.seed("1-projects/broken.md", broken);

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/broken.md",
        text: passphraseNote([{ id: "p1" }]),
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/broken.md"]).toBe(broken);
  });

  /**
   * A WELL-FORMED ENVELOPE, NAMING EXACTLY THE RIGHT RECIPIENTS, WITH
   * PLAINTEXT SMUGGLED IN AROUND IT.
   *
   * `sameRecipientSet` alone would wave every one of these through — the
   * fenced block itself is untouched, valid, and names `p1` and nobody else.
   * This is the caller `envelopeSkeleton` exists for: someone who already
   * holds editor access to this path (a person, or an MCP client authorized
   * for this workspace) but was never given the passphrase, hand-typing a
   * submission the console itself would never produce. That is exactly the
   * "no AI client reads it" boundary this feature is for — an editor without
   * the passphrase is not supposed to be able to put a single readable byte
   * of this note's content into the bucket while it still answers as encrypted.
   */
  test("plaintext smuggled after the fenced block is refused, even though the envelope itself is well-formed", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const smuggled = `${before}\nA co-editor without the passphrase put this here.\n`;
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: smuggled,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("plaintext smuggled between the frontmatter and the fence is refused", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const smuggled = before.replace(
      "> [!NOTE] This note is encrypted.",
      "> [!NOTE] This note is encrypted.\nA co-editor without the passphrase put this here.",
    );
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: smuggled,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("an extra frontmatter key alongside the marker is refused", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const smuggled = before.replace(
      "context_encryption: v1",
      'context_encryption: v1\nsecret: "a co-editor without the passphrase put this here"',
    );
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: smuggled,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  /*
   * THE REST OF THE SHAPES AN EDITOR WITHOUT THE PASSPHRASE CAN TYPE.
   *
   * The three above are the ones `envelopeSkeleton` was written for. These are
   * the neighbouring shapes an adversarial reading of it turns up next — two
   * fenced blocks, a fence smuggled into the frontmatter (where
   * `parseEnvelopeRecipients` looks for the *first* fence in the document and
   * `envelopeSkeleton` looks for the first one *after* the frontmatter, which
   * is the one place those two could be made to disagree), a JSON blob carrying
   * a real fence close inside itself, and a line-ending rewrite of an otherwise
   * identical envelope. Each is refused, and each is here because "we thought
   * about it" is not a check.
   */
  test("a second fenced block after the envelope is refused", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: `${before}\n\`\`\`context-encrypted\nA co-editor put this here.\n\`\`\`\n`,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("a fence smuggled into the frontmatter, with the real one still below it, is refused", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    // The envelope JSON appears twice: once inside the frontmatter, where
    // `parseEnvelopeRecipients` finds it first, and once where it belongs. A
    // check that read the recipients from one block and compared the skeleton
    // around the *other* would wave the smuggled plaintext between them
    // through; the skeleton is computed over everything outside one JSON blob,
    // so the extra copy is part of what has to match and does not.
    const json = before.split("```context-encrypted\n")[1]!.split("\n```")[0]!;
    const smuggled = [
      "---",
      "context_encryption: v1",
      "```context-encrypted",
      json,
      "```",
      "A co-editor without the passphrase put this here.",
      before.slice(before.indexOf("\n---") + 1),
    ].join("\n");

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: smuggled,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("a hand-written multi-line JSON blob carrying its own fence close is refused", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    // No legitimate client produces this — `JSON.stringify` cannot emit a raw
    // newline — so the only writer of a blob like this is somebody typing it.
    // Both the parse and the skeleton cut at the *same* first `\n```, so the
    // JSON they see is truncated and refused rather than being read one way
    // for the recipients and another way for the skeleton.
    const smuggled = before.replace(
      /```context-encrypted\n[^\n]*\n```/,
      '```context-encrypted\n{"v":1,\n"leak":"a co-editor put this here\n```\nand this too",\n"alg":"A256GCM"}\n```',
    );
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: smuggled,
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("the same envelope with its line endings rewritten is refused — the skeleton is bytes, not lines", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/locked.md",
        text: before.replace(/\n/g, "\r\n"),
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  /*
   * WHAT THIS DOOR DOES **NOT** REFUSE, PINNED SO IT IS A DECISION.
   *
   * The skeleton and the recipient set are everything this runtime can check
   * without a key, and they do not distinguish one locked note's ciphertext
   * from another's: every passphrase note this console writes carries the same
   * deterministic wrapper (`renderEncryptedNote`) and, for a first passphrase,
   * the same `passphrase:p1` recipient identity. So a caller who already holds
   * editor access can put another locked note's envelope, or an older envelope
   * of this same note, at this path.
   *
   * That is **destruction, not disclosure**, and it is bounded by the write
   * authority the caller already has rather than by encryption:
   * `docs/decisions/encryption.md` opens by saying encryption "is not access
   * control, deletion protection, or availability", and the same caller can
   * delete this note outright through `deletePath`. What the door does refuse
   * is the thing that would be a disclosure — a readable byte of anybody's
   * plaintext landing at this path while it still answers as encrypted — and
   * the thing that would be a downgrade: a recipient added, dropped or swapped.
   * Neither substitution can reveal the note that was there, because nothing
   * here holds the key that would decrypt either side.
   *
   * These two are asserted rather than merely argued so that a future change
   * that makes them refusals has to come here and say so — and so that nobody
   * reads the three smuggling tests above as a claim this door verifies the
   * ciphertext, which it cannot.
   */
  test("another locked note's envelope is accepted — an editor can destroy what they cannot read", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const somebodyElses = passphraseNote([{ id: "p1" }], { ct: "AnotherNotesCiphertext" });
    await writeFile(store, {
      path: "1-projects/locked.md",
      text: somebodyElses,
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(store.snapshot()["1-projects/locked.md"]).toBe(somebodyElses);
  });

  test("an older envelope of this note is accepted — a rollback is a write, and this caller has writes", async () => {
    const store = bucket();
    const older = passphraseNote([{ id: "p1" }], { ct: "OlderCiphertext" });
    const current = passphraseNote([{ id: "p1" }], { ct: "CurrentCiphertext" });
    store.seed("1-projects/locked.md", current);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    // With the *current* etag, deliberately: a replay is not a way around the
    // conflict check, it is an ordinary write of bytes the caller had a copy
    // of, which is what every version-control-shaped worry about a bucket the
    // customer owns comes down to.
    await writeFile(store, {
      path: "1-projects/locked.md",
      text: older,
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(store.snapshot()["1-projects/locked.md"]).toBe(older);
  });
});

describe("removeNoteEncryption: the one door that writes plaintext over an encrypted note", () => {
  test("removes a passphrase lock with the right etag, writing plain Markdown", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const written = await removeNoteEncryption(store, {
      path: "1-projects/locked.md",
      text: "# no longer locked\n",
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
    });
    expect(written.path).toBe("1-projects/locked.md");
    expect(store.snapshot()["1-projects/locked.md"]).toBe("# no longer locked\n");
  });

  test("refuses a note that was never encrypted", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    const refused = await capture(() =>
      removeNoteEncryption(store, {
        path: "1-projects/context-lc.md",
        text: "# still not locked\n",
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
      }),
    );
    expect(refused.code).toBe("NOTE_NOT_ENCRYPTED");
  });

  test("refuses without an expected etag — removal never treats a note as new", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const refused = await capture(() =>
      removeNoteEncryption(store, {
        path: "1-projects/locked.md",
        text: "# no longer locked\n",
        clearance: clearanceOf("private"),
      }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("refuses a stale etag, and the bytes do not move", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const refused = await capture(() =>
      removeNoteEncryption(store, {
        path: "1-projects/locked.md",
        text: "# no longer locked\n",
        expectedEtag: "an-etag-that-was-never-issued",
        clearance: clearanceOf("private"),
      }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  /**
   * THE SABOTAGE THIS TEST EXISTS FOR.
   *
   * `removeNoteEncryption` is a narrower door than `writeFile`, not a weaker
   * one — see its own doc comment. If it accepted a still-encrypted
   * replacement, it would become a second way to swap a note's recipients that
   * skips `writeFile`'s own recipient-set check entirely: call the "remove"
   * action, submit an envelope with a *different* recipient, and the guard the
   * suite above spends six tests proving never opens is open again under a
   * different name.
   */
  test("refuses a replacement that is itself still an encrypted note, even with the right etag", async () => {
    const store = bucket();
    const before = passphraseNote([{ id: "p1" }]);
    store.seed("1-projects/locked.md", before);
    const read = await readFile(store, { path: "1-projects/locked.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      removeNoteEncryption(store, {
        path: "1-projects/locked.md",
        // A different recipient entirely — exactly what `writeFile` refuses on
        // its own, submitted here instead to prove this door refuses it too.
        text: passphraseNote([{ kind: "workspace", id: "k1" }]),
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    expect(store.snapshot()["1-projects/locked.md"]).toBe(before);
  });

  test("a team caller cannot remove encryption from a private note — the same refusal as a missing one", async () => {
    const store = bucket();
    store.seed("2-areas/vault.md", passphraseNote([{ id: "p1" }]));

    const hidden = await capture(() =>
      removeNoteEncryption(store, {
        path: "2-areas/vault.md",
        text: "# now plaintext\n",
        expectedEtag: "whatever",
        clearance: clearanceOf("team"),
      }),
    );
    const missing = await capture(() =>
      removeNoteEncryption(store, {
        path: "2-areas/no-such-note.md",
        text: "# now plaintext\n",
        expectedEtag: "whatever",
        clearance: clearanceOf("team"),
      }),
    );
    expect(errorShape(hidden)).toBe(errorShape(missing));
  });
});

