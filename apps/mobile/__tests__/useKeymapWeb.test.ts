/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import type { Command, Scope } from "../features/design/keymap";

/**
 * The web keyboard binder, pinned.
 *
 * `features/design/keymap.ts` decides *what* a chord means and is tested in
 * plain node (`keymap.test.ts`). This file tests the other half — the part that
 * cannot be tested without a DOM, because every rule in it is about a real
 * `KeyboardEvent`: where it landed, whether an IME is mid-composition, whether
 * the key is being held down, and whether anything actually handled it.
 *
 * Four of these are the difference between a keyboard layer and a bug report:
 *
 *  - **`inTextField` comes from `event.target`.** Guess it and typing `F2` into
 *    a textarea renames the file you were writing about.
 *  - **An IME composition is not a command.** A Japanese, Chinese or Korean
 *    typist commits candidates with Enter and Escape; firing on those makes the
 *    app unusable in those languages, and nothing about it is visible to a
 *    keyboard that types Latin.
 *  - **Auto-repeat must not delete twice.** A held ⌘⇧⌫ is one intent.
 *  - **`preventDefault` only when handled.** Swallowing ⌘S when nothing saved
 *    breaks the browser's own Save for no gain.
 *
 * Jest has no platform-extension resolution, so the module is required by its
 * full `.web` path — a bare `../features/design/useKeymap` gives the native
 * no-op, which is exactly what we do *not* want to be testing here.
 */
const web = require("../features/design/useKeymap.web") as typeof import("../features/design/useKeymap.web");
const { useKeymap } = web;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/*                                  harness                                   */
/* -------------------------------------------------------------------------- */

/**
 * The platform is read through `navigator`, which jsdom owns and shares between
 * tests, so every test that sets one restores it afterwards. `configurable`
 * matters: without it the second `defineProperty` throws.
 */
function setPlatform(platform: string | undefined, uaPlatform?: string | undefined): () => void {
  const nav = navigator as unknown as Record<string, unknown>;
  const hadPlatform = "platform" in nav;
  const previousPlatform = Object.getOwnPropertyDescriptor(nav, "platform");
  const previousUaData = Object.getOwnPropertyDescriptor(nav, "userAgentData");

  Object.defineProperty(nav, "platform", { value: platform, configurable: true });
  if (uaPlatform === undefined) {
    delete nav.userAgentData;
  } else {
    Object.defineProperty(nav, "userAgentData", {
      value: { platform: uaPlatform },
      configurable: true,
    });
  }

  return () => {
    if (previousPlatform) Object.defineProperty(nav, "platform", previousPlatform);
    else if (!hadPlatform) delete nav.platform;
    if (previousUaData) Object.defineProperty(nav, "userAgentData", previousUaData);
    else delete nav.userAgentData;
  };
}

const APPLE = () => setPlatform("MacIntel");
const WINDOWS = () => setPlatform("Win32");

interface ProbeProps {
  scope: Scope;
  enabled?: boolean;
  onCommand: (command: Command) => boolean | void;
}

/** The smallest thing that can hold the hook: it renders nothing at all. */
function Probe(props: ProbeProps): null {
  useKeymap(props);
  return null;
}

interface Mounted {
  render: (props: ProbeProps) => void;
  unmount: () => void;
}

const cleanups: Array<() => void> = [];

function mount(props: ProbeProps): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const element = (next: ProbeProps): ReactElement => createElement(Probe, next);

  act(() => {
    root.render(element(props));
  });

  let live = true;
  const unmount = () => {
    if (!live) return;
    live = false;
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);

  return {
    render: (next) => {
      act(() => {
        root.render(element(next));
      });
    },
    unmount,
  };
}

interface Chord {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** Where the keystroke landed. Defaults to `document` itself. */
  target?: EventTarget;
}

/** Dispatch a real `KeyboardEvent` and hand the event back, for `defaultPrevented`. */
function press(chord: Chord): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: chord.key,
    metaKey: chord.meta === true,
    ctrlKey: chord.ctrl === true,
    shiftKey: chord.shift === true,
    altKey: chord.alt === true,
    repeat: chord.repeat === true,
    isComposing: chord.isComposing === true,
    keyCode: chord.keyCode ?? 0,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    (chord.target ?? document).dispatchEvent(event);
  });
  return event;
}

/** An element in the document, so a dispatched event really bubbles to it. */
function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  document.body.appendChild(node);
  cleanups.push(() => node.remove());
  return node;
}

/** Collects the commands the hook hands back; `handled` drives `preventDefault`. */
function recorder(handled: boolean | void = true) {
  const commands: Command[] = [];
  return {
    commands,
    onCommand: (command: Command) => {
      commands.push(command);
      return handled;
    },
  };
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */
/*                             platform detection                             */
/* -------------------------------------------------------------------------- */

describe("the modifier follows the platform", () => {
  test("⌘K opens the palette on Apple and Ctrl+K does not", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);

    // Not an alias, a different chord: Ctrl+K on a Mac is not ⌘K.
    press({ key: "k", ctrl: true });
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });

  test("Ctrl+K opens the palette off Apple and ⌘K does not", () => {
    const restore = WINDOWS();
    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    press({ key: "k", ctrl: true });
    expect(seen.commands).toEqual(["palette"]);

    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });

  test("`navigator.userAgentData.platform` is preferred when it exists", () => {
    // The modern API says macOS while the deprecated one lies about Windows.
    // Reading the modern one is the whole point of preferring it.
    const restore = setPlatform("Win32", "macOS");
    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });

  test("a missing `navigator.userAgentData` falls back and does not throw", () => {
    // Safari and Firefox have no `userAgentData` at all. A throw here would
    // take the app down on the first keypress, so this asserts both halves:
    // nothing thrown, and the deprecated `platform` still decides.
    const restore = setPlatform("iPhone", undefined);
    expect((navigator as unknown as Record<string, unknown>).userAgentData).toBeUndefined();

    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    expect(() => press({ key: "k", meta: true })).not.toThrow();
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });

  test("a `navigator` that throws on access degrades to non-Apple", () => {
    const nav = navigator as unknown as Record<string, unknown>;
    const previous = Object.getOwnPropertyDescriptor(nav, "userAgentData");
    Object.defineProperty(nav, "userAgentData", {
      get() {
        throw new Error("hostile embedder");
      },
      configurable: true,
    });
    const restorePlatform = setPlatform("MacIntel", undefined);
    // `setPlatform` deleted the throwing getter, so put it back.
    Object.defineProperty(nav, "userAgentData", {
      get() {
        throw new Error("hostile embedder");
      },
      configurable: true,
    });

    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    expect(() => press({ key: "k", ctrl: true })).not.toThrow();
    expect(seen.commands).toEqual(["palette"]);

    restorePlatform();
    if (previous) Object.defineProperty(nav, "userAgentData", previous);
    else delete nav.userAgentData;
  });

  test("no platform information at all is treated as non-Apple", () => {
    const restore = setPlatform(undefined, undefined);
    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    press({ key: "k", ctrl: true });
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/*                              the text field rule                           */
/* -------------------------------------------------------------------------- */

describe("a bare key inside a text field is typing", () => {
  test("F2 renames from the tree and does nothing from a textarea", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    // Same key, same scope, same everything — only the target differs, which
    // is what makes this a test of `event.target` rather than of the resolver.
    press({ key: "F2", target: element("div") });
    expect(seen.commands).toEqual(["rename"]);

    press({ key: "F2", target: element("textarea") });
    expect(seen.commands).toEqual(["rename"]);
    restore();
  });

  test.each(["input", "textarea", "select"] as const)(
    "a bare key in <%s> is left alone",
    (tag) => {
      const restore = APPLE();
      const seen = recorder();
      mount({ scope: "tree", onCommand: seen.onCommand });

      press({ key: "Enter", target: element(tag) });
      expect(seen.commands).toEqual([]);
      restore();
    },
  );

  test("a contenteditable element counts as a text field", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    // jsdom does not implement `contentEditable`, so the flag the browser
    // computes is supplied directly — the assertion is that the hook reads it.
    const editable = element("div");
    Object.defineProperty(editable, "isContentEditable", { value: true, configurable: true });

    press({ key: "Enter", target: editable });
    expect(seen.commands).toEqual([]);
    restore();
  });

  test("⌘S still saves from inside a textarea", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "editor", onCommand: seen.onCommand });

    // Nobody types ⌘, so a modified chord is never the person's prose. This is
    // what makes the layer usable rather than merely safe.
    press({ key: "s", meta: true, target: element("textarea") });
    expect(seen.commands).toEqual(["save"]);
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/*                                    IME                                     */
/* -------------------------------------------------------------------------- */

describe("an IME composition never fires a command", () => {
  test("`isComposing` suppresses the keystroke", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    // Enter commits the candidate the person is composing. Opening a note with
    // it is how this app becomes unusable in Japanese, Chinese and Korean.
    press({ key: "Enter", isComposing: true });
    expect(seen.commands).toEqual([]);

    press({ key: "Enter" });
    expect(seen.commands).toEqual(["treeOpen"]);
    restore();
  });

  test("`keyCode === 229` suppresses the keystroke", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    // Older WebKit and Chromium report the composition only as this legacy
    // sentinel, with `isComposing` false.
    const event = press({ key: "Enter", keyCode: 229 });
    expect(event.isComposing).toBe(false);
    expect(seen.commands).toEqual([]);
    restore();
  });

  test("a composition is suppressed even with a modifier held", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "global", onCommand: seen.onCommand });

    press({ key: "k", meta: true, isComposing: true });
    expect(seen.commands).toEqual([]);
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/*                                 auto-repeat                                */
/* -------------------------------------------------------------------------- */

describe("a held key does not repeat a destructive command", () => {
  test("deleteForever fires once however long the key is held", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    press({ key: "Backspace", meta: true, shift: true });
    press({ key: "Backspace", meta: true, shift: true, repeat: true });
    press({ key: "Backspace", meta: true, shift: true, repeat: true });

    expect(seen.commands).toEqual(["deleteForever"]);
    restore();
  });

  test("archive fires once however long the key is held", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    press({ key: "Backspace", meta: true });
    press({ key: "Backspace", meta: true, repeat: true });

    expect(seen.commands).toEqual(["archive"]);
    restore();
  });

  test("navigation still repeats, because holding Down is how a list is walked", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "tree", onCommand: seen.onCommand });

    press({ key: "ArrowDown" });
    press({ key: "ArrowDown", repeat: true });
    press({ key: "ArrowDown", repeat: true });

    expect(seen.commands).toEqual(["treeDown", "treeDown", "treeDown"]);
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/*                               preventDefault                               */
/* -------------------------------------------------------------------------- */

describe("the browser keeps its own behaviour unless we handled the key", () => {
  test("a handler returning true suppresses the default", () => {
    const restore = APPLE();
    mount({ scope: "editor", onCommand: () => true });

    expect(press({ key: "s", meta: true }).defaultPrevented).toBe(true);
    restore();
  });

  test("a handler returning false leaves ⌘S to the browser", () => {
    const restore = APPLE();
    mount({ scope: "editor", onCommand: () => false });

    expect(press({ key: "s", meta: true }).defaultPrevented).toBe(false);
    restore();
  });

  test("a handler returning nothing leaves ⌘S to the browser", () => {
    const restore = APPLE();
    mount({ scope: "editor", onCommand: () => undefined });

    expect(press({ key: "s", meta: true }).defaultPrevented).toBe(false);
    restore();
  });

  test("an unbound key is never touched", () => {
    const restore = APPLE();
    const seen = recorder();
    mount({ scope: "editor", onCommand: seen.onCommand });

    const event = press({ key: "j", meta: true });
    expect(seen.commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/*                          registration and lifetime                         */
/* -------------------------------------------------------------------------- */

describe("the listener's lifetime", () => {
  test("nothing fires after unmount", () => {
    const restore = APPLE();
    const seen = recorder();
    const probe = mount({ scope: "global", onCommand: seen.onCommand });

    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);

    probe.unmount();
    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });

  test("`enabled: false` attaches nothing at all", () => {
    const restore = APPLE();
    const seen = recorder();
    const added: string[] = [];
    const original = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (original as (...args: never[]) => void)(type as never, ...(rest as never[]));
    }) as typeof document.addEventListener;

    mount({ scope: "global", enabled: false, onCommand: seen.onCommand });
    document.addEventListener = original;

    expect(added).not.toContain("keydown");
    press({ key: "k", meta: true });
    expect(seen.commands).toEqual([]);
    restore();
  });

  test("toggling `enabled` re-registers", () => {
    const restore = APPLE();
    const seen = recorder();
    const probe = mount({ scope: "global", enabled: false, onCommand: seen.onCommand });

    press({ key: "k", meta: true });
    expect(seen.commands).toEqual([]);

    probe.render({ scope: "global", enabled: true, onCommand: seen.onCommand });
    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);

    probe.render({ scope: "global", enabled: false, onCommand: seen.onCommand });
    press({ key: "k", meta: true });
    expect(seen.commands).toEqual(["palette"]);
    restore();
  });

  test("a changed scope changes what fires", () => {
    const restore = APPLE();
    const seen = recorder();
    const probe = mount({ scope: "tree", onCommand: seen.onCommand });

    // ⌘N is global, so it fires behind nothing — but not behind an overlay.
    press({ key: "n", meta: true });
    expect(seen.commands).toEqual(["newNote"]);

    probe.render({ scope: "overlay", onCommand: seen.onCommand });
    press({ key: "n", meta: true });
    expect(seen.commands).toEqual(["newNote"]);
    restore();
  });

  test("an inline handler does not re-register the listener", () => {
    const restore = APPLE();
    let registrations = 0;
    const original = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "keydown") registrations += 1;
      return (original as (...args: never[]) => void)(type as never, ...(rest as never[]));
    }) as typeof document.addEventListener;

    const first: Command[] = [];
    const second: Command[] = [];
    const probe = mount({
      scope: "global",
      onCommand: (command) => {
        first.push(command);
        return true;
      },
    });
    // A caller passing an arrow literal re-renders with a new function every
    // time; the listener must survive that, and must still call the new one.
    probe.render({
      scope: "global",
      onCommand: (command) => {
        second.push(command);
        return true;
      },
    });
    document.addEventListener = original;

    press({ key: "k", meta: true });

    expect(registrations).toBe(1);
    expect(first).toEqual([]);
    expect(second).toEqual(["palette"]);
    restore();
  });
});

/* -------------------------------------------------------------------------- */
/*                              the native half                               */
/* -------------------------------------------------------------------------- */

/**
 * The other side of the `.ts` / `.web.ts` split, checked from here because it
 * is the same contract: a phone has no keyboard, and every command in the table
 * is reachable by touch, so native must attach nothing.
 *
 * The file extension is spelled out. A bare `../features/design/useKeymap`
 * resolves to whichever half `moduleFileExtensions` happens to prefer, and this
 * suite prefers the **web** one — so the bare path would quietly point both of
 * these tests at the module they are here to distinguish it from, and they
 * would fail for a reason that has nothing to do with native.
 */
const native = require("../features/design/useKeymap.ts") as typeof import("../features/design/useKeymap");

describe("the native binder is inert", () => {
  test("it attaches no listener and fires nothing", () => {
    const restore = APPLE();
    const seen = recorder();
    const added: string[] = [];
    const original = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (original as (...args: never[]) => void)(type as never, ...(rest as never[]));
    }) as typeof document.addEventListener;

    function NativeProbe(props: ProbeProps): null {
      native.useKeymap(props);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    act(() => {
      root.render(createElement(NativeProbe, { scope: "global", onCommand: seen.onCommand }));
    });
    document.addEventListener = original;

    expect(added).not.toContain("keydown");
    const event = press({ key: "k", meta: true });
    expect(seen.commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    restore();
  });

  test("it is a real hook, so hook order matches the web build", () => {
    // A plain empty function would satisfy the assertion above and still let a
    // conditional call compile on native and crash on web — so this asserts
    // the behaviour that distinguishes the two rather than reading the source:
    // outside a render there is no dispatcher, and a function that really calls
    // a hook throws. An empty one returns quietly.
    expect(() => native.useKeymap({ scope: "global", onCommand: () => true })).toThrow();
  });
});
