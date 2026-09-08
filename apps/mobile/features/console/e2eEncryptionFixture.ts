import type { NoteWriter } from "./encryption/passphraseOps";
import { DEMO_CONTEXT_TREES } from "./placeholderData";
import type { FileEntry } from "./files/types";

/**
 * The one note in `apps/mobile/e2e/webkit`'s fixture with a real write path
 * behind it.
 *
 * Every other demo action — `files.save`, `share`, `destroy` — is a no-op by
 * design (`e2eFixtureData.ts`'s own header): the fixture exists to prove
 * *rendering* against real component code, not persistence, and a WebKit
 * suite that could actually write a customer's bucket would be the wrong
 * kind of realistic. Encryption breaks that rule on purpose. Locking,
 * unlocking, editing, saving and removing a passphrase are exactly the
 * operations `docs/decisions/encryption.md` and this session's task exist to
 * make reachable, and none of them can be proven by a component that renders
 * once and forgets what it was asked to remember — the whole claim under
 * test is that ciphertext survives being closed and reopened, and that the
 * session's key does not survive a reload. So this note's writes really do
 * persist: in memory for the length of the page, and in `localStorage` so a
 * genuine `page.reload()` can prove the first half of that claim, while
 * React's own state — the unlock session included — proves the second half
 * for free by simply not surviving one.
 *
 * **What this does not attempt**: conflict-safety. `expectedEtag` is ignored
 * entirely — every write here succeeds — because a fixture whose one purpose
 * is exercising the crypto has nothing to gain from also modelling a
 * concurrent editor, and `apps/convex/__tests__/fileOps.test.ts` already
 * covers that ground for real.
 */

export const E2E_ENCRYPTION_PATH = "1-projects/e2e-secret.md";
export const E2E_ENCRYPTION_FOLDER = "1-projects";

/** What the note says before anyone has locked it, on a machine that has
 * never run this suite before. */
export const E2E_ENCRYPTION_SEED_TEXT =
  "# A note for this suite alone\n\nThis paragraph is the plaintext this fixture starts with.\n";

const STORAGE_KEY = "context-e2e-encryption-fixture";

interface FixtureRecord {
  text: string;
  etag: string;
}

function readPersisted(): FixtureRecord | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<FixtureRecord>;
    if (typeof parsed.text === "string" && typeof parsed.etag === "string") {
      return { text: parsed.text, etag: parsed.etag };
    }
    return null;
  } catch {
    // A private tab, or a browser refusing site data. The fixture still works
    // for the length of this page; it just will not survive a reload.
    return null;
  }
}

function writePersisted(record: FixtureRecord): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // See above.
  }
}

/**
 * Make sure the `@seyi` demo tree has this note, seeded from whatever
 * `localStorage` remembers from a previous run of the suite — a real
 * `page.reload()` re-evaluates this whole module, so this is what makes the
 * note ciphertext survive one. Idempotent: `useE2EFixtureConsoleData` calls
 * it on every render, and calling it twice must not duplicate the tree row.
 *
 * Returns the writers `useNoteEncryption` should use instead of Convex.
 */
export function installE2EEncryptionFixture(): { write: NoteWriter; removeEncryption: NoteWriter } {
  const tree = DEMO_CONTEXT_TREES.seyi;
  const persisted = readPersisted();

  if (tree.notes[E2E_ENCRYPTION_PATH] === undefined) {
    tree.notes[E2E_ENCRYPTION_PATH] = persisted?.text ?? E2E_ENCRYPTION_SEED_TEXT;
    const folder = tree.listings[E2E_ENCRYPTION_FOLDER];
    if (folder && !folder.entries.some((entry) => entry.path === E2E_ENCRYPTION_PATH)) {
      const row: FileEntry = {
        kind: "file",
        path: E2E_ENCRYPTION_PATH,
        name: "e2e-secret.md",
        visibility: "private",
        // `1-projects` defaults to `team` in this tree; `exception: true` is
        // what makes this row read "private" rather than silently inheriting
        // a visibility this note never asked for.
        inherited: "team",
        exception: true,
        readOnly: false,
      };
      folder.entries.push(row);
    }
  }

  let etag = persisted?.etag ?? "e2e-seed";

  function commit(text: string): { etag: string } {
    tree.notes[E2E_ENCRYPTION_PATH] = text;
    etag = `e2e-${Math.random().toString(36).slice(2)}`;
    writePersisted({ text, etag });
    return { etag };
  }

  // One `NoteWriter` shape, used for both doors: this fixture has no Convex
  // rule to enforce ("never plaintext over an encrypted note" is
  // `fileOps.ts`'s job and is tested there), so both simply commit whatever
  // they are given.
  const writer: NoteWriter = { write: async (request) => commit(request.content) };

  return { write: writer, removeEncryption: writer };
}
