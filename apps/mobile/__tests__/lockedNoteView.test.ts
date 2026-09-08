/**
 * @jest-environment jsdom
 */

/**
 * What a passphrase-locked note actually renders as — the phone refusal, the
 * unlock prompt, and the unlocked editor, driven with a fully scripted
 * `NoteEncryptionController` rather than the real crypto: `passphraseOps.test.ts`
 * and `useNoteEncryption.test.ts` already prove the operations themselves, and
 * this file's job is the one they cannot see — what actually renders, and when.
 *
 * Three things this file exists to catch, all found while wiring this
 * component and not visible from the operations alone:
 *
 *  - A phone gets the refusal and **nothing else** — no field, no button, so
 *    there is no weaker path a person could stumble into.
 *  - A wrong passphrase's message is printed verbatim rather than relabelled,
 *    which is what keeps it indistinguishable from a corrupt envelope.
 *  - Locking the note from elsewhere (this component calls
 *    `controller.lock()`, but the session is shared — an idle sweep or a
 *    press somewhere else locks it exactly the same way) has to close this
 *    view's own plaintext, not leave a plaintext editor open with no key
 *    behind it.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import {
  initialSessionState,
  isUnlocked as sessionIsUnlocked,
  sessionReducer,
  type SessionState,
} from "../features/console/encryption/session";
import type { NoteEncryptionController } from "../features/console/encryption/useNoteEncryption";

jest.mock("../features/console/encryption/kdf", () => {
  const actual = jest.requireActual("../features/console/encryption/kdf") as object;
  return { ...actual, kdfSupport: () => mockSupportOverride };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import { LockedNoteView } from "../features/console/encryption/LockedNoteView";
import type { KdfSupport } from "../features/console/encryption/kdf";

let mockSupportOverride: KdfSupport = { supported: true };

const PATH = "1-projects/locked.md";
const STORED = "the-ciphertext";

/** A `NoteEncryptionController` a test can script by hand. */
function fakeController(overrides: Partial<NoteEncryptionController> = {}): NoteEncryptionController {
  let session: SessionState = initialSessionState;
  const dispatch = (action: Parameters<typeof sessionReducer>[1]) => {
    session = sessionReducer(session, action);
  };
  return {
    get session() {
      return session;
    },
    isUnlocked: (path) => sessionIsUnlocked(session, path),
    msUntilLock: () => null,
    lock: () => dispatch({ type: "lock", reason: "manual" }),
    touch: (path) => dispatch({ type: "touched", path, at: Date.now() }),
    protect: async () => {
      throw new Error("not used in this test");
    },
    unlock: async () => {
      throw new Error("override me");
    },
    peek: async () => null,
    save: async () => {
      throw new Error("override me");
    },
    changePassphrase: async () => {
      throw new Error("not used in this test");
    },
    remove: async () => {
      throw new Error("not used in this test");
    },
    ...overrides,
  };
}

function mount(props: {
  controller: NoteEncryptionController;
  canEdit?: boolean;
  onWritten?: (etag: string) => void;
}): { container: HTMLElement; rerender: () => void; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const render = () => {
    root.render(
      createElement(LockedNoteView, {
        path: PATH,
        stored: STORED,
        etag: "etag-1",
        canEdit: props.canEdit ?? true,
        controller: props.controller,
        onWritten: props.onWritten,
      }),
    );
  };
  act(render);
  return {
    container,
    /**
     * Re-render with the same props. `controller` is the same object by
     * reference in every test here — a hand-scripted stand-in, not the real
     * `useReducer`-backed hook — so this is what stands in for the real
     * app's own re-render whenever `useNoteEncryption`'s session state
     * changes and its `useMemo` hands the pane a **new** controller object.
     * Calling it after mutating the fake controller's session (via `.lock()`
     * or `.touch()`) is what lets `LockedNoteView`'s own effects see the
     * change, exactly as a real prop update would.
     */
    rerender: () => act(render),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function byTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function typeInto(node: Element, text: string): void {
  // `TextInput` renders an `<input>` when single-line and a `<textarea>` when
  // `multiline` — `LockedNoteView`'s own body is the latter, its passphrase
  // fields the former — and each has its own prototype's `value` setter.
  const prototype =
    node instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(node, text);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(node: Element): void {
  for (const type of ["mousedown", "mouseup", "click"]) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
}

describe("a phone", () => {
  afterEach(() => {
    mockSupportOverride = { supported: true };
  });

  test("gets the refusal by name, with no prompt and no field", () => {
    mockSupportOverride = {
      supported: false,
      reason: "Locked notes open on a computer.",
    };
    const { container, unmount } = mount({ controller: fakeController() });
    expect(byTestId(container, "locked-note-unsupported")).not.toBeNull();
    expect(container.textContent).toContain("Locked notes open on a computer");
    expect(byTestId(container, "locked-note-prompt")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    unmount();
  });
});

describe("unlocking", () => {
  afterEach(() => {
    mockSupportOverride = { supported: true };
  });

  test("a wrong passphrase's message is shown verbatim, and the view stays locked", async () => {
    const controller = fakeController({
      unlock: async () => {
        throw new Error("that passphrase did not open this note");
      },
    });
    const { container, unmount } = mount({ controller });

    const passphraseField = container.querySelector('[aria-label="Passphrase"]');
    expect(passphraseField).not.toBeNull();
    await act(async () => {
      typeInto(passphraseField!, "wrong one");
      press(byTestId(container, "locked-note-unlock")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(byTestId(container, "locked-note-error")?.textContent).toBe(
      "that passphrase did not open this note",
    );
    expect(byTestId(container, "locked-note-body")).toBeNull();
    unmount();
  });

  test("a correct passphrase opens the note for editing", async () => {
    const controller = fakeController({
      unlock: async () => ({ plaintext: "# secret\n\nhello\n" }),
    });
    const { container, unmount } = mount({ controller });

    const passphraseField = container.querySelector('[aria-label="Passphrase"]')!;
    await act(async () => {
      typeInto(passphraseField, "correct horse battery staple");
      press(byTestId(container, "locked-note-unlock")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    const body = byTestId(container, "locked-note-body") as HTMLTextAreaElement | null;
    expect(body).not.toBeNull();
    expect(body!.value).toBe("# secret\n\nhello\n");
    unmount();
  });
});

describe("editing and saving", () => {
  test("save calls the controller once with the edited text and reports the new etag", async () => {
    const written: string[] = [];
    const controller = fakeController({
      unlock: async () => ({ plaintext: "# a\n" }),
      save: async (input) => {
        written.push(input.plaintext);
        return { etag: "etag-2", stored: "new-ciphertext" };
      },
    });
    const reported: string[] = [];
    const { container, unmount } = mount({ controller, onWritten: (etag) => reported.push(etag) });

    const passphraseField = container.querySelector('[aria-label="Passphrase"]')!;
    await act(async () => {
      typeInto(passphraseField, "a very good passphrase");
      press(byTestId(container, "locked-note-unlock")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    const body = byTestId(container, "locked-note-body")!;
    await act(async () => {
      typeInto(body, "# a\n\nedited\n");
    });
    await act(async () => {
      press(byTestId(container, "locked-note-save")!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(written).toEqual(["# a\n\nedited\n"]);
    expect(reported).toEqual(["etag-2"]);
    unmount();
  });

  /**
   * TYPING IS AN INTERACTION, AND THE IDLE WINDOW IS MEASURED AGAINST IT.
   *
   * Without this, the five minutes ran from the unlock (or the last save)
   * whatever the person was doing at the keyboard, so an editing session
   * longer than the window locked itself mid-sentence — and locking clears
   * this view's `draft` on purpose, while an unlocked note deliberately has
   * no autosave and no offline queue behind it (`useNoteEncryption.ts`'s own
   * header), so everything typed since the last save went with it and nothing
   * could bring it back. `useNoteEncryption` sweeps before it renews, so this
   * cannot be used to hold a note open past a window that already expired;
   * that half is asserted in `useNoteEncryption.test.ts`.
   *
   * Sabotage record: dropping `controller.touch(path)` from `onChangeText` —
   * 1 failure, here.
   */
  test("a keystroke renews the note's idle window", async () => {
    const touched: string[] = [];
    const controller = fakeController({
      unlock: async () => ({ plaintext: "# a\n" }),
      touch: (path) => touched.push(path),
    });
    const { container, unmount } = mount({ controller });

    const passphraseField = container.querySelector('[aria-label="Passphrase"]')!;
    await act(async () => {
      typeInto(passphraseField, "a very good passphrase");
      press(byTestId(container, "locked-note-unlock")!);
      await Promise.resolve();
      await Promise.resolve();
    });
    // Unlocking is not typing: nothing has renewed the window yet.
    expect(touched).toEqual([]);

    await act(async () => {
      typeInto(byTestId(container, "locked-note-body")!, "# a\n\nstill working\n");
    });

    expect(touched).toEqual([PATH]);
    unmount();
  });
});

describe("locking from elsewhere in the session", () => {
  test("closes this view's own plaintext rather than leaving an editor open with no key", async () => {
    const controller = fakeController({
      unlock: async () => ({ plaintext: "# a\n" }),
    });
    const { container, rerender, unmount } = mount({ controller });

    const passphraseField = container.querySelector('[aria-label="Passphrase"]')!;
    await act(async () => {
      typeInto(passphraseField, "a very good passphrase");
      press(byTestId(container, "locked-note-unlock")!);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(byTestId(container, "locked-note-body")).not.toBeNull();

    // The session-wide lock, exactly as an idle sweep or a press on a
    // different note's view would call it — not this component reacting to
    // its own button. `rerender` stands in for the real app's parent handing
    // this component a fresh `controller` once its session actually changes.
    controller.lock();
    rerender();

    expect(byTestId(container, "locked-note-body")).toBeNull();
    expect(byTestId(container, "locked-note-prompt")).not.toBeNull();
    unmount();
  });
});
