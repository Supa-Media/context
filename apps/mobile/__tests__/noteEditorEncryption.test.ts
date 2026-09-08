/**
 * @jest-environment jsdom
 */

/**
 * WHICH ENCRYPTED NOTE GETS WHICH TREATMENT.
 *
 * `state.encrypted` is true for both an at-rest (Phase 1, `workspace`
 * recipient) note and a passphrase-locked (Phase 2) one — the flag says
 * nothing about which. Getting this discrimination wrong in either direction
 * is a real failure: showing `LockedNoteView`'s passphrase prompt over a note
 * nobody locked with a passphrase asks somebody for a secret that does not
 * exist and can never open the note; showing the plain `EncryptedNotice` over
 * a passphrase note tells the reader "readable through a connected client to
 * everyone its visibility already reaches" — a sentence that is exactly false
 * for the one mode this product promises otherwise about.
 *
 * `LiveEditor` is stubbed, the same way `noteEditorReadOnly.test.ts` stubs it:
 * what is under test is which branch `NoteEditor` takes, not CodeMirror.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
 * jsdom's own `crypto` has no `subtle`, which `kdfSupport()` reads to decide
 * whether this runtime can open a locked note — every browser and desktop
 * shell this app ships to does. Without this, every case below that expects
 * the passphrase prompt gets the phone-style refusal instead, for a reason
 * that has nothing to do with what this file is testing.
 */
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: require("node:crypto").webcrypto,
    configurable: true,
  });
}

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: () => null,
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
const { initialSessionState } =
  require("../features/console/encryption/session") as typeof import("../features/console/encryption/session");

type EditorState = import("../features/console/files/editor").EditorState;
type NoteEncryptionController =
  import("../features/console/encryption/useNoteEncryption").NoteEncryptionController;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "1-projects/secret.md";

const AT_REST_ENVELOPE = [
  "---",
  "context_encryption: v1",
  "context_encryption_key: ws:k1",
  "---",
  "",
  "> [!NOTE] This note is encrypted.",
  "",
  "```context-encrypted",
  '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA","aad":"context-note-v1:w1","recipients":[{"kind":"workspace","id":"k1","alg":"A256GCM","iv":"BBBBBBBBBBBBBBBB","wrapped":"CCCC"}]}',
  "```",
  "",
].join("\n");

const PASSPHRASE_ENVELOPE = [
  "---",
  "context_encryption: v1",
  "---",
  "",
  "> [!NOTE] This note is encrypted.",
  "",
  "```context-encrypted",
  '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA","aad":"context-note-v1:w1","recipients":[{"kind":"passphrase","id":"p1","alg":"A256GCM","iv":"BBBBBBBBBBBBBBBB","wrapped":"CCCC","kdf":{"id":"argon2id","v":19,"m":19456,"t":2,"p":1,"salt":"DDDDDDDDDDDDDDDD"}}]}',
  "```",
  "",
].join("\n");

function stateFor(draft: string): EditorState {
  return { ...emptyEditor, status: "clean", path: PATH, baseline: draft, draft, encrypted: true, readOnly: true };
}

function fakeController(): NoteEncryptionController {
  return {
    session: initialSessionState,
    isUnlocked: () => false,
    msUntilLock: () => null,
    lock: () => {},
    touch: () => {},
    protect: async () => {
      throw new Error("not used in this test");
    },
    unlock: async () => {
      throw new Error("not used in this test");
    },
    peek: async () => null,
    save: async () => {
      throw new Error("not used in this test");
    },
    changePassphrase: async () => {
      throw new Error("not used in this test");
    },
    remove: async () => {
      throw new Error("not used in this test");
    },
  };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(draft: string, withController: boolean): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(NoteEditor, {
        state: stateFor(draft),
        canEdit: true,
        onChange: () => {},
        onSave: () => {},
        onDiscard: () => {},
        onUseTheirs: () => {},
        onKeepMine: () => {},
        encryption: withController ? { controller: fakeController() } : undefined,
      }),
    );
  });
  return container;
}

function text(container: HTMLDivElement): string {
  return container.textContent ?? "";
}

describe("an at-rest (workspace-recipient) encrypted note", () => {
  test("gets the plain envelope notice, never the passphrase prompt", () => {
    const container = mount(AT_REST_ENVELOPE, true);
    expect(text(container)).toContain("This note is encrypted");
    expect(text(container)).toContain("readable through a connected client");
    expect(container.querySelector('[data-testid="locked-note-prompt"]')).toBeNull();
  });

  test("is unaffected by encryption being wired in at all", () => {
    // No `encryption` prop — the landing page's demo, or any console with
    // nowhere for a write to land. An at-rest note's rendering must not
    // depend on it either way.
    const container = mount(AT_REST_ENVELOPE, false);
    expect(text(container)).toContain("This note is encrypted");
  });
});

describe("a passphrase-locked note", () => {
  test("gets the passphrase prompt when the console can act on it", () => {
    const container = mount(PASSPHRASE_ENVELOPE, true);
    expect(container.querySelector('[data-testid="locked-note-prompt"]')).not.toBeNull();
    // The Phase 1 sentence must not appear over a note it is false about.
    expect(text(container)).not.toContain("readable through a connected client");
  });

  test("falls back to the plain envelope notice with nowhere to route a write", () => {
    const container = mount(PASSPHRASE_ENVELOPE, false);
    expect(container.querySelector('[data-testid="locked-note-prompt"]')).toBeNull();
    expect(text(container)).toContain("This note is encrypted");
  });
});
