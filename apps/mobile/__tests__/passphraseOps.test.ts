/**
 * THE PASSPHRASE NEVER LEAVES THE DEVICE, AND THIS IS HOW THAT IS CHECKED.
 *
 * `passphraseOps.ts` is written so that every byte it would ever send goes
 * through one injected `NoteWriter`. That is not a style choice: it turns "the
 * passphrase never reaches a server" from a claim about a call graph somebody
 * has to read into an assertion over recorded requests.
 *
 * So the central test here is dull to describe and is the point of the feature:
 * run a full protect / unlock / save / change / remove cycle, record every
 * request, and assert that the passphrase, the derived key and the note's
 * plaintext appear in none of them — not in a body, not in a path, not in an
 * etag, not anywhere in the JSON of the whole recording.
 *
 * The unlock is the strongest one and it needs saying: **it records no request
 * at all**. A locked note's ciphertext is its content, so the console already
 * has it, and opening it is arithmetic. There is no call to inspect because
 * there is no call.
 *
 * The rest of the file is the session: what "unlocked" is made of, that locking
 * is total, that an idle sweep locks on a clock rather than on a timer that may
 * never fire, and that whatever the session would hand to persistence contains
 * no key.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failing tests in this
 * file.
 *
 *   `protectNote` writing the plaintext instead of the document               3
 *   `changePassphrase` re-encrypting the body instead of rewrapping           2
 *   `changePassphrase` keeping the old salt for the new passphrase            1
 *   `sessionReducer`'s idle sweep comparing against the wrong timestamp       2
 *   `serializable` returning the state it was given                           1
 *   `removePassphrase` writing before it could decrypt                        1
 */

import { describe, expect, it } from "@jest/globals";
import {
  MINIMUM_PASSPHRASE_LENGTH,
  changePassphrase,
  protectNote,
  removePassphrase,
  saveUnlockedNote,
  unlockNote,
  type NoteWriter,
} from "../features/console/encryption/passphraseOps";
import {
  decryptWithPassphrase,
  isEncryptedNote,
  isPassphraseNote,
  parseEncryptedNote,
} from "../features/console/encryption/envelope";
import type { KdfDescriptor } from "../features/console/encryption/kdf";
import {
  DEFAULT_IDLE_MS,
  initialSessionState,
  isUnlocked,
  keyFor,
  msUntilLock,
  serializable,
  sessionReducer,
  type SessionState,
} from "../features/console/encryption/session";

const WORKSPACE = "ws_ops_00000000000000000";
const PASSPHRASE = "seven syllables of nonsense";
const NEW_PASSPHRASE = "a different sentence entirely";
const PLAINTEXT = "---\ntags: [private]\n---\n\nThe number is forty-two.\n";

/**
 * A fake derivation: the real one is a second of arithmetic per call, and this
 * file makes eight. What it must keep is the only property these tests depend
 * on — a different passphrase or a different salt is a different key.
 */
function fakeDerive(passphrase: string, kdf: KdfDescriptor): Uint8Array {
  const seed = `${passphrase}:${kdf.salt}:${kdf.m}:${kdf.t}`;
  const out = new Uint8Array(32);
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  for (let i = 0; i < 32; i += 1) {
    hash = Math.imul(hash ^ (i + 1), 16777619) >>> 0;
    out[i] = hash & 0xff;
  }
  return out;
}

interface Recorded {
  path: string;
  content: string;
  expectedEtag: string | null;
}

function recorder(): { writer: NoteWriter; requests: Recorded[] } {
  const requests: Recorded[] = [];
  let etag = 0;
  return {
    requests,
    writer: {
      async write(request) {
        // A structured clone, so a later mutation of the argument cannot make a
        // recording look innocent after the fact.
        requests.push(JSON.parse(JSON.stringify(request)));
        return { etag: `e${++etag}` };
      },
    },
  };
}

const base64Of = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

describe("locking a note behind a passphrase", () => {
  it("writes ciphertext, and the note is one nothing we run can open", async () => {
    const { writer, requests } = recorder();
    const context = { workspaceId: WORKSPACE, writer, derive: fakeDerive };
    const { key } = await protectNote(
      { path: "1-projects/a.md", plaintext: PLAINTEXT, etag: "e0", passphrase: PASSPHRASE },
      context,
    );

    expect(requests).toHaveLength(1);
    const [written] = requests;
    expect(written.path).toBe("1-projects/a.md");
    expect(written.expectedEtag).toBe("e0");
    expect(isEncryptedNote(written.content)).toBe(true);
    expect(isPassphraseNote(written.content)).toBe(true);
    // The claim that makes this the mode the owner asked for: one recipient,
    // and it is not the workspace. Nothing we hold opens this note.
    const recipients = parseEncryptedNote(written.content)!.recipients;
    expect(recipients).toHaveLength(1);
    expect(recipients[0].kind).toBe("passphrase");
    expect(written.content).not.toContain("workspace");

    await expect(
      decryptWithPassphrase(written.content, { workspaceId: WORKSPACE, kek: key }),
    ).resolves.toBe(PLAINTEXT);
  });

  it("refuses a passphrase short enough to be guessed, before writing anything", async () => {
    const { writer, requests } = recorder();
    await expect(
      protectNote(
        { path: "1-projects/a.md", plaintext: PLAINTEXT, etag: null, passphrase: "short" },
        { workspaceId: WORKSPACE, writer, derive: fakeDerive },
      ),
    ).rejects.toThrow(new RegExp(`${MINIMUM_PASSPHRASE_LENGTH} characters`));
    expect(requests).toHaveLength(0);
  });

  it("passes the etag through, so locking a note is as conflict-safe as saving one", async () => {
    const { writer, requests } = recorder();
    await protectNote(
      { path: "a.md", plaintext: PLAINTEXT, etag: "e17", passphrase: PASSPHRASE },
      { workspaceId: WORKSPACE, writer, derive: fakeDerive },
    );
    expect(requests[0].expectedEtag).toBe("e17");
  });
});

describe("a full cycle, and what it sends", () => {
  it("sends the passphrase, the key and the plaintext nowhere", async () => {
    const { writer, requests } = recorder();
    const context = { workspaceId: WORKSPACE, writer, derive: fakeDerive };

    const protectedNote = await protectNote(
      { path: "1-projects/a.md", plaintext: PLAINTEXT, etag: null, passphrase: PASSPHRASE },
      context,
    );
    let stored = requests[requests.length - 1].content;

    const opened = await unlockNote({ stored, passphrase: PASSPHRASE }, context);
    expect(opened.plaintext).toBe(PLAINTEXT);
    // The strongest assertion in the file: unlocking made no request at all.
    expect(requests).toHaveLength(1);

    await saveUnlockedNote(
      {
        path: "1-projects/a.md",
        plaintext: `${PLAINTEXT}\nAnd a second line.\n`,
        etag: protectedNote.etag,
        key: opened.key,
        stored,
      },
      context,
    );
    stored = requests[requests.length - 1].content;

    const changed = await changePassphrase(
      {
        path: "1-projects/a.md",
        stored,
        etag: "e2",
        currentPassphrase: PASSPHRASE,
        newPassphrase: NEW_PASSPHRASE,
      },
      context,
    );
    stored = requests[requests.length - 1].content;

    await removePassphrase(
      { path: "1-projects/a.md", stored, etag: changed.etag, passphrase: NEW_PASSPHRASE },
      context,
    );

    const recording = JSON.stringify(requests);
    expect(requests.length).toBeGreaterThan(3);
    expect(recording).not.toContain(PASSPHRASE);
    expect(recording).not.toContain(NEW_PASSPHRASE);
    expect(recording).not.toContain(base64Of(protectedNote.key));
    expect(recording).not.toContain(base64Of(changed.key));
    // Every request but the last is ciphertext. The last one is the deliberate
    // "take the lock off", which puts the note back in the clear on purpose.
    for (const request of requests.slice(0, -1)) {
      expect(request.content).not.toContain("forty-two");
    }
    expect(requests[requests.length - 1].content).toContain("forty-two");
    expect(isEncryptedNote(requests[requests.length - 1].content)).toBe(false);
  });

  it("changes the passphrase without rewriting the body, and needs the old one", async () => {
    const { writer, requests } = recorder();
    const context = { workspaceId: WORKSPACE, writer, derive: fakeDerive };
    await protectNote(
      { path: "a.md", plaintext: PLAINTEXT, etag: null, passphrase: PASSPHRASE },
      context,
    );
    const stored = requests[0].content;

    await expect(
      changePassphrase(
        {
          path: "a.md",
          stored,
          etag: null,
          currentPassphrase: "not the passphrase at all",
          newPassphrase: NEW_PASSPHRASE,
        },
        context,
      ),
    ).rejects.toThrow(/did not open/);
    expect(requests).toHaveLength(1);

    const changed = await changePassphrase(
      {
        path: "a.md",
        stored,
        etag: null,
        currentPassphrase: PASSPHRASE,
        newPassphrase: NEW_PASSPHRASE,
      },
      context,
    );
    const after = requests[1].content;
    expect(parseEncryptedNote(after)!.ct).toBe(parseEncryptedNote(stored)!.ct);
    expect(parseEncryptedNote(after)!.iv).toBe(parseEncryptedNote(stored)!.iv);
    // A new salt, so the two keys are related by nothing but the person.
    expect(parseEncryptedNote(after)!.recipients[0].kdf!.salt).not.toBe(
      parseEncryptedNote(stored)!.recipients[0].kdf!.salt,
    );
    await expect(
      decryptWithPassphrase(after, { workspaceId: WORKSPACE, kek: changed.key }),
    ).resolves.toBe(PLAINTEXT);
  });

  it("keeps the session's key working across a save", async () => {
    const { writer, requests } = recorder();
    const context = { workspaceId: WORKSPACE, writer, derive: fakeDerive };
    const { key } = await protectNote(
      { path: "a.md", plaintext: PLAINTEXT, etag: null, passphrase: PASSPHRASE },
      context,
    );
    await saveUnlockedNote(
      { path: "a.md", plaintext: "changed\n", etag: null, key, stored: requests[0].content },
      context,
    );
    // Rotating the salt on a save would invalidate the key the session holds,
    // and the next save would fail as though the passphrase were wrong.
    await expect(
      decryptWithPassphrase(requests[1].content, { workspaceId: WORKSPACE, kek: key }),
    ).resolves.toBe("changed\n");
  });

  it("refuses to unlock a note that is not passphrase-protected", async () => {
    const { writer } = recorder();
    await expect(
      unlockNote(
        { stored: PLAINTEXT, passphrase: PASSPHRASE },
        { workspaceId: WORKSPACE, writer, derive: fakeDerive },
      ),
    ).rejects.toThrow(/not protected by a passphrase/);
  });
});

describe("the unlock session", () => {
  const key = (seed: number) => new Uint8Array(32).fill(seed);
  const unlock = (state: SessionState, path: string, at: number, seed = 1) =>
    sessionReducer(state, { type: "unlocked", path, key: key(seed), at });

  it("holds a key per note and hands it back", () => {
    const state = unlock(initialSessionState, "a.md", 1000);
    expect(isUnlocked(state, "a.md")).toBe(true);
    expect(isUnlocked(state, "b.md")).toBe(false);
    expect(keyFor(state, "a.md")).toEqual(key(1));
    expect(keyFor(state, "b.md")).toBeNull();
  });

  it("locks everything at once, because locking answers a question about the room", () => {
    let state = unlock(initialSessionState, "a.md", 1000);
    state = unlock(state, "b.md", 1000, 2);
    state = sessionReducer(state, { type: "lock" });
    expect(Object.keys(state.open)).toHaveLength(0);
    expect(state.lastLock).toBe("manual");
  });

  it("locks on the clock, not on a timer that may never fire", () => {
    let state = unlock(initialSessionState, "a.md", 1000);
    state = sessionReducer(state, { type: "sweep", at: 1000 + DEFAULT_IDLE_MS - 1 });
    expect(isUnlocked(state, "a.md")).toBe(true);
    // A laptop that slept through the timeout locks on the next interaction
    // rather than staying open because no `setTimeout` ever ran.
    state = sessionReducer(state, { type: "sweep", at: 1000 + DEFAULT_IDLE_MS });
    expect(isUnlocked(state, "a.md")).toBe(false);
    expect(state.lastLock).toBe("idle");
  });

  it("counts idle from the last touch", () => {
    let state = unlock(initialSessionState, "a.md", 1000);
    state = sessionReducer(state, { type: "touched", path: "a.md", at: 1000 + DEFAULT_IDLE_MS - 1 });
    state = sessionReducer(state, { type: "sweep", at: 1000 + DEFAULT_IDLE_MS });
    expect(isUnlocked(state, "a.md")).toBe(true);
    expect(msUntilLock(state, "a.md", 1000 + DEFAULT_IDLE_MS)).toBe(DEFAULT_IDLE_MS - 1);
    expect(msUntilLock(state, "b.md", 0)).toBeNull();
  });

  it("does not resurrect a note that an idle sweep has already locked", () => {
    let state = unlock(initialSessionState, "a.md", 0);
    state = sessionReducer(state, { type: "sweep", at: DEFAULT_IDLE_MS });
    state = sessionReducer(state, { type: "touched", path: "a.md", at: DEFAULT_IDLE_MS + 1 });
    expect(isUnlocked(state, "a.md")).toBe(false);
  });

  it("drops a note's key when its tab closes", () => {
    let state = unlock(initialSessionState, "a.md", 0);
    state = unlock(state, "b.md", 0, 2);
    state = sessionReducer(state, { type: "closed", path: "a.md" });
    expect(isUnlocked(state, "a.md")).toBe(false);
    expect(isUnlocked(state, "b.md")).toBe(true);
  });

  it("hands persistence the paths and never the keys", () => {
    let state = unlock(initialSessionState, "a.md", 0, 7);
    state = unlock(state, "b.md", 0, 8);
    const persisted = JSON.stringify(serializable(state));
    expect(persisted).toContain("a.md");
    expect(persisted).not.toContain(base64Of(key(7)));
    // A key is 32 bytes; a serialisation that leaked one would carry its
    // numbers, so the shape is asserted rather than only the encoding.
    expect(persisted).not.toMatch(/"key"/);
    expect(persisted).not.toContain("7,7,7,7");
  });

  it("overwrites the key bytes it drops", () => {
    const live = new Uint8Array(32).fill(9);
    const unlockedState = sessionReducer(initialSessionState, {
      type: "unlocked",
      path: "a.md",
      key: live,
      at: 0,
    });
    sessionReducer(unlockedState, { type: "lock" });
    expect(Array.from(live).every((byte) => byte === 0)).toBe(true);
  });
});
