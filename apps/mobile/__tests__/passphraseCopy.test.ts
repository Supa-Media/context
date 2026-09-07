/**
 * @jest-environment jsdom
 *
 * WHAT THE SCREEN SAYS BEFORE SOMEBODY LOSES A NOTE.
 *
 * `LockNoteDialog` takes the one decision in this product that cannot be
 * reversed by doing the opposite: after it, a forgotten passphrase is a note
 * nobody — including us — can ever open again. So the copy on it is held to
 * `docs/decisions/encryption.md` the way an access rule is held to a test,
 * and the assertions are about words rather than about layout.
 *
 * Rendered rather than read off the constants, because a promise that is in
 * `acknowledgement.ts` and not on the screen is not a promise anybody sees. The
 * console's suite already mounts components this way where a bug is only
 * visible to a reconciler; here it is because the question is "what does a
 * person actually read".
 *
 * Four things:
 *
 * 1. **Every consequence is on the screen before the field is.** Loss is
 *    permanent, the title and folder stay visible, no assistant can read it,
 *    and sharing the note does not share the passphrase.
 * 2. **Nothing on it promises a recovery**, in any of the forms
 *    `FORBIDDEN_CLAIMS` lists — including "encrypted at rest", which is the
 *    *other* mode and would understate this one.
 * 3. **The button does not arm until the passphrase is entered twice and the
 *    acknowledgement is typed.** A reflex cannot lock a note.
 * 4. **Where the runtime cannot open locked notes there is no form at all** —
 *    a reason and a way forward, never a weaker lock nobody was told about.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failing tests here.
 *
 *   the "if you lose this passphrase" point removed from the list             2
 *   the confirm button armed without the typed acknowledgement                1
 *   the second passphrase field's value ignored in `ready`                    1
 *   the unsupported branch rendering the form with a disabled button          2
 *   "we can recover it for you" added to the hint                             1
 */

import { describe, expect, it } from "@jest/globals";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LockNoteDialog } from "../features/console/encryption/LockNoteDialog";
import {
  ACKNOWLEDGEMENT_CONFIRM,
  ACKNOWLEDGEMENT_PHRASE,
  ACKNOWLEDGEMENT_POINTS,
  FORBIDDEN_CLAIMS,
} from "../features/console/encryption/acknowledgement";

// The dialog asks the runtime whether it can derive a key at all, and jsdom has
// no Web Crypto unless one is put there. Both answers are exercised below, so
// the switch is a fixture rather than an assumption.
function withSubtle(present: boolean): void {
  const existing = (globalThis as { crypto?: Crypto }).crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: present ? { ...existing, subtle: {} } : { ...existing, subtle: undefined },
  });
}

function render(props: Parameters<typeof LockNoteDialog>[0]): {
  html: () => string;
  type: (label: string, value: string) => void;
  confirmDisabled: () => boolean;
} {
  // `Modal` portals out of the mount point, so the rendered dialog lands on
  // `document.body` rather than inside the host node. Reading the host would
  // give an empty string, and every "does not contain" assertion in this file
  // would then pass by rendering nothing at all.
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(LockNoteDialog, props));
  });
  const scope = document.body;
  return {
    html: () => scope.innerHTML,
    type(label, value) {
      const field = scope.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
      if (!field) throw new Error(`no field labelled ${label}`);
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    confirmDisabled() {
      const buttons = [...scope.querySelectorAll("*")].filter((node) =>
        (node.textContent ?? "").trim().startsWith(ACKNOWLEDGEMENT_CONFIRM),
      );
      if (buttons.length === 0) throw new Error("no confirm control rendered");
      return buttons.some(
        (node) =>
          node.getAttribute("aria-disabled") === "true" ||
          (node as HTMLButtonElement).disabled === true,
      );
    },
  };
}

const noop = () => {};

describe("the screen that locks a note", () => {
  it("says every consequence out loud", () => {
    withSubtle(true);
    const screen = render({ path: "1-projects/a.md", onLock: noop, onClose: noop });
    const text = screen.html().replace(/<[^>]+>/g, " ");
    for (const point of ACKNOWLEDGEMENT_POINTS) {
      // Rendered React collapses nothing, but the markup interleaves tags, so
      // the comparison is on a normalised copy of both sides.
      expect(text.replace(/\s+/g, " ")).toContain(point.replace(/\s+/g, " "));
    }
    expect(text).toContain("1-projects/a.md");
  });

  it("promises no recovery, in any of the forms that would be a lie", () => {
    withSubtle(true);
    const screen = render({ path: "1-projects/a.md", onLock: noop, onClose: noop });
    const text = screen.html().toLowerCase();
    for (const claim of FORBIDDEN_CLAIMS) {
      expect(text).not.toContain(claim);
    }
  });

  it("does not arm until the passphrase is entered twice and the words are typed", () => {
    withSubtle(true);
    const screen = render({ path: "a.md", onLock: noop, onClose: noop });
    expect(screen.confirmDisabled()).toBe(true);

    screen.type("Passphrase", "several words together");
    expect(screen.confirmDisabled()).toBe(true);

    screen.type("Passphrase again", "several words togethe");
    expect(screen.confirmDisabled()).toBe(true);

    screen.type("Passphrase again", "several words together");
    expect(screen.confirmDisabled()).toBe(true);

    screen.type(`Type ${ACKNOWLEDGEMENT_PHRASE} to confirm`, ACKNOWLEDGEMENT_PHRASE);
    expect(screen.confirmDisabled()).toBe(false);
  });

  it("refuses a passphrase short enough to be guessed, in words", () => {
    withSubtle(true);
    const screen = render({ path: "a.md", onLock: noop, onClose: noop });
    screen.type("Passphrase", "short");
    expect(screen.html()).toContain("At least 12 characters");
    expect(screen.confirmDisabled()).toBe(true);
  });

  it("offers no form at all where the runtime cannot open a locked note", () => {
    withSubtle(false);
    const screen = render({ path: "a.md", onLock: noop, onClose: noop });
    const text = screen.html();
    expect(text).toContain("browser or the desktop app");
    // Not a disabled form and not a weaker lock: no passphrase field exists.
    expect(text).not.toContain('aria-label="Passphrase"');
    expect(text).not.toContain(ACKNOWLEDGEMENT_CONFIRM);
  });
});
