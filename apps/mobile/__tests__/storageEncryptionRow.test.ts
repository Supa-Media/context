import { describe, expect, test } from "@jest/globals";
import {
  ENCRYPTED_BODY,
  ENCRYPTED_TITLE,
  OWN_BUCKET_BODY,
  encryptionRowCopy,
} from "../features/console/storage/encryptionRow";
import { consoleStorageFrom } from "../features/console/liveConsole/derive";
import type { StorageBinding } from "../features/console/liveConsole/summaries";

/**
 * The Encryption row in Settings › Storage (Boards 4, 5, 7 and 8).
 *
 * The rules, each a decision rather than a rendering detail:
 *  - no row until the rollout reaches a workspace (choice 1: hide it);
 *  - an owner never sees "failed": the server sends `paused`, and so do we;
 *  - never "end-to-end": the encrypted copy says Context can still read notes;
 *  - a customer's own bucket gets the one honest sentence, Dropbox no row;
 *  - leaving says the files arrive plain.
 */

const managed = { managed: true, provider: "r2" } as const;

describe("encryptionRowCopy", () => {
  test("no encryption state yet: no row", () => {
    expect(encryptionRowCopy({ ...managed })).toBeNull();
    expect(encryptionRowCopy({ ...managed, encryption: null })).toBeNull();
  });

  test("encrypting, with progress", () => {
    const copy = encryptionRowCopy({
      ...managed,
      encryption: { state: "encrypting", filesDone: 1240, filesTotal: 3112 },
    });
    expect(copy?.title).toBe("Encrypting your files");
    expect(copy?.body).toBe("1,240 of 3,112. Keep working. New notes are encrypted as you save them.");
    expect(copy?.progress).toBeCloseTo(1240 / 3112);
    expect(copy?.lock).toBe(true);
  });

  test("encrypting on a phone is shorter", () => {
    const copy = encryptionRowCopy(
      { ...managed, encryption: { state: "encrypting", filesDone: 1240, filesTotal: 3112 } },
      true,
    );
    expect(copy?.body).toBe("1,240 of 3,112. Keep working.");
  });

  test("encrypting before the count is known draws no bar and no made-up figure", () => {
    const copy = encryptionRowCopy({ ...managed, encryption: { state: "encrypting" } });
    expect(copy?.progress).toBeUndefined();
    expect(copy?.body).toBe("Keep working. New notes are encrypted as you save them.");
  });

  test("checking", () => {
    const copy = encryptionRowCopy({ ...managed, encryption: { state: "checking" } });
    expect(copy?.title).toBe("Almost done: checking your files");
    expect(copy?.body).toBe("Every file is read back once to make sure it opens.");
  });

  test("encrypted: in transit and at rest, and honest about what Context can read", () => {
    const copy = encryptionRowCopy({ ...managed, encryption: { state: "encrypted" } });
    expect(copy?.title).toBe("Encrypted in transit and at rest");
    expect(copy?.lock).toBe(true);
    expect(copy?.body).toBe(
      "Context encrypts what's inside each file before storing it and keeps the key apart from your files. " +
        "File and folder names aren't encrypted. Context can still read your notes for search and your AI tools.",
    );
    expect(`${ENCRYPTED_TITLE} ${ENCRYPTED_BODY}`).not.toMatch(/end-to-end/i);
  });

  test("encrypted on a phone keeps the full text behind What this means", () => {
    const copy = encryptionRowCopy({ ...managed, encryption: { state: "encrypted" } }, true);
    expect(copy?.body).toBe(
      "What's inside each file is encrypted. Context can still read your notes for search and your AI tools.",
    );
    expect(copy?.more).toBe(ENCRYPTED_BODY);
  });

  test("paused, which is also what an owner sees for a failed check", () => {
    const copy = encryptionRowCopy({ ...managed, encryption: { state: "paused", filesDone: 3, filesTotal: 9 } });
    expect(copy?.title).toBe("Paused");
    expect(copy?.body).toBe("Your notes open normally. We'll finish this when we can. Nothing for you to do.");
    expect(JSON.stringify(copy)).not.toMatch(/fail/i);
  });

  test("a bucket the customer owns: one sentence, no lock", () => {
    const copy = encryptionRowCopy({ managed: false, provider: "s3" });
    expect(copy).toEqual({ lock: false, body: OWN_BUCKET_BODY, state: "own-bucket" });
    expect(OWN_BUCKET_BODY).toBe(
      "Context doesn't add its own encryption to a bucket you own. Your files stay plain and open in any app.",
    );
  });

  test("Dropbox is neither managed nor a bucket: no row", () => {
    expect(encryptionRowCopy({ managed: false, provider: "dropbox" })).toBeNull();
  });

  test("no copy uses an em dash", () => {
    const states = ["encrypting", "checking", "encrypted", "paused"] as const;
    for (const state of states) {
      for (const compact of [false, true]) {
        const copy = encryptionRowCopy({ ...managed, encryption: { state, filesDone: 1, filesTotal: 2 } }, compact);
        expect(JSON.stringify(copy)).not.toContain("—");
      }
    }
  });
});

describe("consoleStorageFrom", () => {
  const binding: StorageBinding = {
    provider: "r2",
    managed: true,
    capabilities: { conditionalWrite: true },
    status: "connected",
  } as StorageBinding;

  test("carries the owner's encryption view through", () => {
    const storage = consoleStorageFrom({ ...binding, encryption: { state: "encrypted" } });
    expect(storage?.encryption).toEqual({ state: "encrypted" });
  });

  test("a deployment without the field hides the row", () => {
    const storage = consoleStorageFrom(binding);
    expect(storage?.encryption).toBeUndefined();
    expect(encryptionRowCopy(storage!)).toBeNull();
  });
});
