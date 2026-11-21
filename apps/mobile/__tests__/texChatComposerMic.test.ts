/**
 * @jest-environment jsdom
 */

/**
 * THE TEX CHAT'S ROUND KEY IS A MICROPHONE (Dev2, 2026-11-21 roast: "replace
 * the send button with a microphone button because people know that they could
 * just click enter to send").
 *
 * The composer is mounted with a fake speech engine: what is proven is the key
 * a person sees, that pressing it dictates into the box, that Enter still
 * sends, and where the send arrow stays (a touch screen with words, a browser
 * with no speech engine).
 *
 * Sabotage (run once, then restored): dropping `pageOnComputer()` from
 * `micKey` fails the computer test.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexChatComposer } from "../features/tex/chat/TexChatComposer";
import type { DictationEngine, DictationHandlers } from "../features/voice/engine";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
});

function fakeEngine(available = true) {
  const engine = {
    handlers: null as DictationHandlers | null,
    opened: 0,
    available,
    unavailable: available ? "" : "This browser can't turn speech into words.",
    open(handlers: DictationHandlers) {
      engine.opened += 1;
      engine.handlers = handlers;
    },
    finalize() {
      engine.handlers?.ended();
    },
    abandon() {},
  };
  return engine as typeof engine & DictationEngine;
}

function mount(engine: DictationEngine) {
  const sent: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() =>
    root.render(
      createElement(TexChatComposer, {
        sending: false,
        disabled: false,
        reply: null,
        edit: null,
        onCancelReply: () => {},
        onCancelEdit: () => {},
        onSend: (text: string) => sent.push(text),
        dictationEngine: engine,
      }),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const key = () => find("tex-send")?.getAttribute("aria-label");
  return {
    sent,
    find,
    key,
    value: () => (find("tex-input") as HTMLTextAreaElement).value,
    press: () => {
      const node = find("tex-send")!;
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    type: (text: string) => {
      const field = find("tex-input")!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    enter: () => {
      const field = find("tex-input")!;
      act(() => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        field.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
      });
    },
  };
}

describe("the microphone key", () => {
  test("an empty box shows a microphone, not a send arrow", () => {
    const box = mount(fakeEngine());
    expect(box.key()).toBe("Dictate");
  });

  test("pressing it listens, what is said lands in the box, and pressing again stops", () => {
    const engine = fakeEngine();
    const box = mount(engine);
    box.press();
    expect(engine.opened).toBe(1);
    expect(box.key()).toBe("Stop dictating");
    expect(box.find("tex-dictation-line")?.textContent).toBe("Listening…");
    act(() => engine.handlers?.interim("what's on"));
    expect(box.find("tex-dictation-line")?.textContent).toBe("what's on");
    act(() => engine.handlers?.final("what's on my calendar"));
    expect(box.value()).toBe("what's on my calendar");
    box.press();
    expect(box.find("tex-dictation-line")).toBeNull();
    expect(box.sent).toEqual([]);
  });

  test("Enter still sends what was said", () => {
    const engine = fakeEngine();
    const box = mount(engine);
    box.press();
    act(() => engine.handlers?.final("book the table"));
    box.enter();
    expect(box.sent).toEqual(["book the table"]);
    expect(box.find("tex-dictation-line")).toBeNull();
  });

  test("on a computer the key stays a microphone with words in the box", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: /pointer: fine/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
    const box = mount(fakeEngine());
    box.type("hello");
    expect(box.key()).toBe("Dictate");
  });

  test("a touch screen with words shows the send arrow, since its return key is a newline", () => {
    const box = mount(fakeEngine());
    box.type("hello");
    expect(box.key()).toBe("Send");
    box.press();
    expect(box.sent).toEqual(["hello"]);
  });

  test("a browser with no speech engine keeps the send arrow", () => {
    const box = mount(fakeEngine(false));
    expect(box.key()).toBe("Send");
  });

  test("a refused microphone says so in the box, and typing clears it", () => {
    const engine = fakeEngine();
    const box = mount(engine);
    box.press();
    act(() => engine.handlers?.error("denied"));
    expect(box.find("tex-dictation-line")?.textContent).toBe("Your browser is blocking the microphone.");
    box.type("h");
    expect(box.find("tex-dictation-line")).toBeNull();
  });
});
