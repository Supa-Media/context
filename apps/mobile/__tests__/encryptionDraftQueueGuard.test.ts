/**
 * THE OFFLINE STORE NEVER HOLDS AN UNLOCKED NOTE'S PLAINTEXT.
 *
 * `useNoteEncryption.ts`'s own header states the rule and the cost it pays:
 * editing a passphrase-unlocked note has no autosave and no offline queue, on
 * purpose, because `features/offline` is a durable, cross-reload store and an
 * unlocked note's plaintext must never sit in one — "in memory or persisted,
 * including across an app reload with a queued draft."
 *
 * A rule stated in a comment and not checked is not a rule, which is exactly
 * `docs/decisions/testing.md`'s "a guard nobody has checked is not a guard".
 * So this reads the **source** of every file in `features/console/encryption/`
 * — the whole surface this session's passphrase machinery lives in — and
 * refuses any of the identifiers that would put an unlocked note's plaintext
 * into that queue: the functions `features/offline` exposes for writing a
 * draft down, and the storage primitive underneath all of them.
 *
 * This is a source check rather than a behavioural one for the same reason
 * `sealNoteContent`'s own three-argument check in `apps/mcp` is: the failure
 * mode is a single call site, anywhere, and a behavioural test would have to
 * anticipate every path that could reach it rather than refusing the
 * capability outright.
 *
 * ## Why the *cache* writers are on the list too
 *
 * The list started as the draft-and-queue writers, because a draft is the
 * person's own typing and is the obvious durable copy. It is not the only one:
 * `features/offline` also caches **note bodies** — what the bucket answered —
 * under their own key kind, and a body cached before a lock is the same
 * plaintext by another name. The adversarial review of #360 found that copy
 * outliving a lock through the caller rather than through this directory, and
 * `discardLocalCopies` now takes it; naming `rememberNote`, `rememberBody`
 * and `putNote` here is the other half — the shorter path into the same store
 * is closed by the same rule that closes `AsyncStorage`, rather than being
 * left to the fact that nobody has taken it yet.
 *
 * **Sabotage record** (temporary local edits, reverted): adding a call to
 * `rememberDraft` inside `useNoteEncryption.ts`'s `save` — 1 failure, naming
 * the file and the identifier. Adding a call to `rememberNote` in the same
 * place — 1 failure, likewise.
 */

import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENCRYPTION_DIR = join(__dirname, "..", "features", "console", "encryption");

/**
 * Every identifier that would let this session's own plaintext reach the
 * offline store — its draft queue or its note cache — or its backing store,
 * directly or through a wrapper.
 *
 * `AsyncStorage` and `localStorage`/`sessionStorage` are named on their own,
 * not only through `features/offline`'s exports — a future file in this
 * directory reaching for browser storage directly, to "just remember the
 * draft locally", would defeat the guard exactly as calling `rememberDraft`
 * would, and by a shorter path.
 */
const FORBIDDEN_IDENTIFIERS: readonly string[] = [
  "rememberDraft",
  "queueSave",
  "putDraft",
  "rememberNote",
  "rememberBody",
  "putNote",
  "AsyncStorage",
  "localStorage",
  "sessionStorage",
  "features/offline",
];

/**
 * Strip comments so this file's own prose — which has to *name* every
 * forbidden identifier to explain the guard — does not trip the guard it is
 * explaining. None of these files puts `//` inside a string (checked by hand;
 * `self-test` below pins the behaviour rather than trusting that to stay
 * true), so a line-oriented strip is safe here without a real tokenizer.
 *
 * Deliberately not "does this file merely mention the word" — the direction
 * that matters is a *use*, and stripping comments first is what lets a
 * docstring say "no `rememberDraft`" without becoming the thing it forbids,
 * the same shape `isEncryptedNote` uses to let a note *about* this feature
 * mention its own marker without becoming one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function sourceFiles(): Array<{ path: string; code: string }> {
  return readdirSync(ENCRYPTION_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => {
      const path = join(ENCRYPTION_DIR, name);
      return { path, code: stripComments(readFileSync(path, "utf8")) };
    });
}

describe("stripComments", () => {
  test("removes both comment forms and leaves real code untouched", () => {
    const source = [
      "// a line comment naming rememberDraft",
      "/* a block\n   comment naming queueSave */",
      "const real = 1; // trailing, naming putDraft",
      "callSomething();",
    ].join("\n");
    const stripped = stripComments(source);
    expect(stripped).not.toContain("rememberDraft");
    expect(stripped).not.toContain("queueSave");
    expect(stripped).not.toContain("putDraft");
    expect(stripped).toContain("const real = 1;");
    expect(stripped).toContain("callSomething();");
  });
});

describe("no file under features/console/encryption/ can reach the offline draft queue", () => {
  const files = sourceFiles();

  test("the corpus is not vacuous — there is more than one file to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    test(`no file's code mentions ${identifier}`, () => {
      const offenders = files.filter(({ code }) => code.includes(identifier));
      expect(offenders.map((f) => f.path)).toEqual([]);
    });
  }
});
