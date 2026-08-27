/**
 * The keyboard layer's rules, pinned.
 *
 * `features/design/keymap.ts` is deliberately free of React, `react-native`
 * and the DOM, so all of this runs in plain node with no renderer — the same
 * arrangement `fileEditor.test.ts` uses. The web binder that attaches the real
 * listener is a separate file; what is worth testing is the decision, not the
 * `addEventListener` call.
 *
 * Two of these are the bugs that make a keyboard layer unusable rather than
 * merely wrong, and they are the reason the module exists in this shape:
 * typing `n` in a note must never create a note, and ⌘⌫ with Shift held must
 * never reach `archive` on its way to `deleteForever`.
 */

import { describe, expect, test } from "@jest/globals";
import {
  BINDINGS,
  describeBinding,
  resolve,
  type Binding,
  type Command,
  type KeyEvent,
  type Scope,
} from "../features/design/keymap";

const SCOPES: readonly Scope[] = ["global", "tree", "editor", "overlay"];

type Chord = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  inTextField?: boolean;
};

/** Build the event a browser would report for a chord on the given platform. */
function press(chord: Chord, apple: boolean): KeyEvent {
  return {
    // The browser reports the *shifted* character, so mimic that.
    key: chord.shift && chord.key.length === 1 ? chord.key.toUpperCase() : chord.key,
    metaKey: apple ? chord.mod === true : false,
    ctrlKey: apple ? false : chord.mod === true,
    shiftKey: chord.shift === true,
    altKey: chord.alt === true,
    inTextField: chord.inTextField === true,
  };
}

function eventFor(binding: Binding, apple: boolean, inTextField = false): KeyEvent {
  return press(
    {
      key: binding.key,
      mod: binding.mod,
      shift: binding.shift,
      alt: binding.alt,
      inTextField,
    },
    apple,
  );
}

/* -------------------------------------------------------------------------- */
/*                            the text-field rule                             */
/* -------------------------------------------------------------------------- */

describe("a bare key inside a text field is typing, not a command", () => {
  test("typing n in a note does not create a note", () => {
    expect(resolve(press({ key: "n", inTextField: true }, true), "editor", true)).toBeNull();
    expect(resolve(press({ key: "n", inTextField: true }, false), "editor", false)).toBeNull();
  });

  /**
   * Stated as the property rather than as cases, because the letter above is
   * only suggestive — nothing is bound to a bare `n`, so that assertion would
   * pass even with the rule deleted. This one would not: with the caret in a
   * field and no overlay open, *no* chord without ⌘/Ctrl or ⌥ may resolve.
   */
  test("no bare chord at all resolves in a text field outside an overlay", () => {
    for (const binding of BINDINGS.filter((b) => b.mod !== true && b.alt !== true)) {
      for (const scope of ["global", "tree", "editor"] satisfies Scope[]) {
        for (const apple of [true, false]) {
          expect(resolve(eventFor(binding, apple, true), scope, apple)).toBeNull();
        }
      }
    }
  });

  test("F2, the arrows and Enter all reach the textarea untouched", () => {
    for (const key of ["f2", "arrowup", "arrowdown", "arrowleft", "arrowright", "enter"]) {
      expect(resolve(press({ key, inTextField: true }, true), "tree", true)).toBeNull();
      expect(resolve(press({ key, inTextField: true }, true), "editor", true)).toBeNull();
    }
  });

  /** The other half. A layer where ⌘S stops working in the editor is useless. */
  test("modifier chords still fire from inside the textarea", () => {
    expect(resolve(press({ key: "s", mod: true, inTextField: true }, true), "editor", true)).toBe(
      "save",
    );
    expect(resolve(press({ key: "k", mod: true, inTextField: true }, true), "editor", true)).toBe(
      "palette",
    );
    expect(resolve(press({ key: "s", mod: true, inTextField: true }, false), "editor", false)).toBe(
      "save",
    );
  });

  test("outside a text field the bare keys do fire", () => {
    expect(resolve(press({ key: "f2" }, true), "tree", true)).toBe("rename");
    expect(resolve(press({ key: "arrowdown" }, true), "tree", true)).toBe("treeDown");
    expect(resolve(press({ key: "enter" }, true), "tree", true)).toBe("treeOpen");
  });

  /**
   * An overlay owns the keyboard, and its filter input is part of it — so its
   * bare keys have to work with the caret in a field, which is the one place
   * the rule above is deliberately relaxed.
   */
  test("an overlay's own bare keys work with the caret in its filter field", () => {
    expect(resolve(press({ key: "arrowdown", inTextField: true }, true), "overlay", true)).toBe(
      "treeDown",
    );
    expect(resolve(press({ key: "enter", inTextField: true }, true), "overlay", true)).toBe(
      "treeOpen",
    );
    expect(resolve(press({ key: "escape", inTextField: true }, true), "overlay", true)).toBe(
      "dismiss",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                          mod is ⌘ here and Ctrl there                       */
/* -------------------------------------------------------------------------- */

describe("mod maps to one modifier per platform and never both", () => {
  test("⌘S saves on Apple, Ctrl+S does not", () => {
    expect(resolve(press({ key: "s", mod: true }, true), "editor", true)).toBe("save");
    expect(
      resolve(
        { key: "s", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, inTextField: false },
        "editor",
        true,
      ),
    ).toBeNull();
  });

  test("Ctrl+S saves off Apple, ⌘/meta does not", () => {
    expect(resolve(press({ key: "s", mod: true }, false), "editor", false)).toBe("save");
    expect(
      resolve(
        { key: "s", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, inTextField: false },
        "editor",
        false,
      ),
    ).toBeNull();
  });

  /** Holding both is not "at least ⌘"; it is a chord we did not bind. */
  test("holding ⌘ and Ctrl together matches nothing", () => {
    expect(
      resolve(
        { key: "s", metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, inTextField: false },
        "editor",
        true,
      ),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                                   scopes                                    */
/* -------------------------------------------------------------------------- */

describe("a binding fires only where it is declared", () => {
  test("tree commands do not fire in the editor", () => {
    for (const chord of [
      { key: "f2" },
      { key: "d", mod: true },
      { key: "arrowup" },
      { key: "arrowdown" },
    ] satisfies Chord[]) {
      expect(resolve(press(chord, true), "editor", true)).toBeNull();
    }
    expect(resolve(press({ key: "f2" }, true), "tree", true)).toBe("rename");
    expect(resolve(press({ key: "d", mod: true }, true), "tree", true)).toBe("duplicate");
    expect(resolve(press({ key: "arrowup" }, true), "tree", true)).toBe("treeUp");
  });

  test("editor commands do not fire in the tree", () => {
    expect(resolve(press({ key: "s", mod: true }, true), "tree", true)).toBeNull();
    expect(resolve(press({ key: "e", mod: true }, true), "tree", true)).toBeNull();
    expect(resolve(press({ key: "e", mod: true }, true), "editor", true)).toBe("togglePreview");
  });

  test("global commands fire in every non-overlay scope", () => {
    for (const scope of ["global", "tree", "editor"] satisfies Scope[]) {
      expect(resolve(press({ key: "k", mod: true }, true), scope, true)).toBe("palette");
      expect(resolve(press({ key: "o", mod: true }, true), scope, true)).toBe("quickSwitcher");
      expect(resolve(press({ key: "b", mod: true }, true), scope, true)).toBe("toggleRail");
    }
  });

  test("dismiss is global and overlay both", () => {
    expect(resolve(press({ key: "escape" }, true), "global", true)).toBe("dismiss");
    expect(resolve(press({ key: "escape" }, true), "editor", true)).toBe("dismiss");
    expect(resolve(press({ key: "escape" }, true), "overlay", true)).toBe("dismiss");
  });
});

describe("nothing behind an open overlay may fire", () => {
  /** The whole point: no new note under a dialog the person cannot see. */
  test("⌘N is inert while an overlay is open", () => {
    expect(resolve(press({ key: "n", mod: true }, true), "global", true)).toBe("newNote");
    expect(resolve(press({ key: "n", mod: true }, true), "overlay", true)).toBeNull();
  });

  test("only dismiss and the overlay's own navigation resolve there", () => {
    const allowed = new Set<Command>(["dismiss", "treeUp", "treeDown", "treeOpen"]);
    for (const binding of BINDINGS) {
      for (const apple of [true, false]) {
        const got = resolve(eventFor(binding, apple), "overlay", apple);
        if (got !== null) expect(allowed.has(got)).toBe(true);
      }
    }
    // …and those four really do resolve, so the assertion above is not vacuous.
    for (const command of allowed) {
      const binding = BINDINGS.find((candidate) => candidate.command === command) as Binding;
      expect(resolve(eventFor(binding, true), "overlay", true)).toBe(command);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                        exact modifiers, not "at least"                      */
/* -------------------------------------------------------------------------- */

describe("archive and permanent delete are one Shift apart and never collide", () => {
  test("⌘⌫ archives", () => {
    expect(resolve(press({ key: "backspace", mod: true }, true), "tree", true)).toBe("archive");
  });

  test("⌘⇧⌫ deletes forever, and is never read as archive", () => {
    expect(resolve(press({ key: "backspace", mod: true, shift: true }, true), "tree", true)).toBe(
      "deleteForever",
    );
    expect(resolve(press({ key: "backspace", mod: true, shift: true }, false), "tree", false)).toBe(
      "deleteForever",
    );
  });

  test("a bare ⌫ on a selected row destroys nothing", () => {
    expect(resolve(press({ key: "backspace" }, true), "tree", true)).toBeNull();
  });

  test("an unbound extra modifier does not fall through to the plainer chord", () => {
    expect(resolve(press({ key: "backspace", mod: true, alt: true }, true), "tree", true)).toBeNull();
    expect(resolve(press({ key: "s", mod: true, shift: true }, true), "editor", true)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                             key normalization                               */
/* -------------------------------------------------------------------------- */

describe("keys compare lowercased, so Shift is read from the flag", () => {
  /** The browser reports `"N"` when Shift is down; the character is not the signal. */
  test("⌘⇧N is newFolder, not newNote", () => {
    expect(
      resolve(
        { key: "N", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, inTextField: false },
        "global",
        true,
      ),
    ).toBe("newFolder");
    expect(
      resolve(
        { key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, inTextField: false },
        "global",
        true,
      ),
    ).toBe("newNote");
  });

  test("an uppercase or mixed-case key name still matches", () => {
    expect(
      resolve(
        { key: "ArrowDown", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, inTextField: false },
        "tree",
        true,
      ),
    ).toBe("treeDown");
    expect(
      resolve(
        { key: "Escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, inTextField: false },
        "global",
        true,
      ),
    ).toBe("dismiss");
    expect(
      resolve(
        { key: "F2", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, inTextField: false },
        "tree",
        true,
      ),
    ).toBe("rename");
  });
});

/* -------------------------------------------------------------------------- */
/*                        the table describes itself                           */
/* -------------------------------------------------------------------------- */

describe("what the menu prints comes from the table", () => {
  test("the documented examples, both platforms", () => {
    expect(describeBinding("moveTo", true)).toBe("⌘⇧M");
    expect(describeBinding("moveTo", false)).toBe("Ctrl+Shift+M");
    expect(describeBinding("save", true)).toBe("⌘S");
    expect(describeBinding("save", false)).toBe("Ctrl+S");
    expect(describeBinding("rename", true)).toBe("F2");
    expect(describeBinding("rename", false)).toBe("F2");
    expect(describeBinding("archive", true)).toBe("⌘⌫");
    expect(describeBinding("archive", false)).toBe("Ctrl+Backspace");
    expect(describeBinding("deleteForever", true)).toBe("⌘⇧⌫");
    expect(describeBinding("deleteForever", false)).toBe("Ctrl+Shift+Backspace");
    expect(describeBinding("treeOpen", true)).toBe("↵");
    expect(describeBinding("treeOpen", false)).toBe("Enter");
    expect(describeBinding("nextTab", true)).toBe("⌘⌥→");
    expect(describeBinding("nextTab", false)).toBe("Ctrl+Alt+Right");
    expect(describeBinding("tab1", true)).toBe("⌘1");
  });

  /**
   * A command with no keystroke is a legitimate state — the product has to be
   * able to have touch-only commands — so this returns `null` rather than
   * throwing or printing a placeholder.
   */
  test("a command with no binding describes as null", () => {
    expect(describeBinding("notACommand" as Command, true)).toBeNull();
    expect(describeBinding("notACommand" as Command, false)).toBeNull();
  });

  test("every binding round-trips through describeBinding on both platforms", () => {
    for (const binding of BINDINGS) {
      for (const apple of [true, false]) {
        const label = describeBinding(binding.command, apple);
        expect(typeof label).toBe("string");
        expect(label).not.toBe("");
        const text = label as string;
        expect(text.includes(apple ? "⌘" : "Ctrl")).toBe(binding.mod === true);
        expect(text.includes(apple ? "⇧" : "Shift")).toBe(binding.shift === true);
        expect(text.includes(apple ? "⌥" : "Alt")).toBe(binding.alt === true);
      }
    }
  });
});

/**
 * The guard against a future addition silently shadowing an existing command.
 *
 * Rather than mirroring the scope rules here — a copy that would drift — this
 * asks the real resolver: press each binding's own chord in every scope, and
 * whatever comes back must be either nothing or that binding's own command. If
 * somebody adds a second binding on a chord that is already live in a scope,
 * one of the two resolves to the other's command and this fails.
 */
describe("no two bindings share a chord in a scope", () => {
  test("each binding's chord resolves to itself or to nothing, everywhere", () => {
    for (const binding of BINDINGS) {
      for (const apple of [true, false]) {
        for (const scope of SCOPES) {
          const got = resolve(eventFor(binding, apple), scope, apple);
          if (got !== null) expect(got).toBe(binding.command);
        }
      }
    }
  });

  test("and every binding fires somewhere, so the table has no dead rows", () => {
    for (const binding of BINDINGS) {
      const fired = SCOPES.some(
        (scope) => resolve(eventFor(binding, true), scope, true) === binding.command,
      );
      expect(fired).toBe(true);
    }
  });

  test("every command in the table is unique", () => {
    const commands = BINDINGS.map((binding) => binding.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});
