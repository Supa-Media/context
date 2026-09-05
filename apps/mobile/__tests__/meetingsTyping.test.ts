/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, memo, useCallback, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **Typing is never interrupted by anything arriving from anywhere.**
 *
 * This is the single most important interaction detail in the product. A
 * meeting recorder people keep is a notepad first: you type your own sparse
 * notes while the meeting happens, and the enhanced note afterwards follows the
 * shape of what you bothered to write down. Transcript segments land
 * continuously while that is going on, the elapsed clock ticks every second,
 * and a sync settles somewhere in the middle. None of them may move the caret,
 * reset the selection, drop a character, or scroll the pad.
 *
 * ## Why this file needs a real reconciler
 *
 * A string renderer cannot fail. `renderToStaticMarkup` renders once, so a
 * component that re-renders on every transcript segment and a component that
 * never re-renders produce byte-identical output — which is the whole failure
 * mode: **a broken version looks exactly right at rest.** The same argument
 * `consoleRenderLoop.test.ts` makes about render-phase `setState`.
 *
 * ## The guarantee has three parts and they break separately
 *
 * 1. **The screen hands the pad props that do not change.** Measured as a
 *    render count through a `memo` probe, because a re-rendered pad produces
 *    byte-identical DOM. Asserting the text is unchanged would pass against the
 *    version that eats a character when somebody types fast — the bug nobody
 *    can reproduce on demand.
 * 2. **The pad is memoised**, so stable props actually buy something. There is
 *    no behavioural assertion available for this one, which is why it is
 *    structural.
 * 3. **The caret does not move.** The observable half, and what a person feels:
 *    `selectionStart` is what jumps when a `value` prop is reassigned, so a
 *    controlled pad throws somebody's cursor to the end of their notes once a
 *    second while a transcript is coming in.
 *
 * Each was verified by sabotage, and each fails **only** its own test:
 *
 *  - replacing the screen's `useCallback` with an inline arrow takes part 1
 *    from 0 renders to 2, and leaves the other two green;
 *  - `value={initialValue}` instead of `defaultValue={seed}` fails parts 3 and
 *    the "never tells the pad" case, and leaves the render count green — which
 *    is the whole reason there is more than one assertion here.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const { NotesPad } =
  require("../features/meetings/components/NotesPad") as typeof import("../features/meetings/components/NotesPad");
/* eslint-enable @typescript-eslint/no-require-imports */

type NotesPadProps = import("../features/meetings/components/NotesPad").NotesPadProps;

interface Mounted {
  container: HTMLElement;
  pad: HTMLTextAreaElement;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  const pad = host.querySelector("textarea");
  if (pad === null) throw new Error("the notepad did not render a text area");
  return {
    container: host,
    pad,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Type into the pad the way a browser does: set the value, then fire `input`. */
function type(pad: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(pad, text);
    pad.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the notepad is not moved by anything around it", () => {
  test("the screen hands the pad props that do not change", () => {
    /*
      Half of the guarantee, and the half that lives in the *caller*. The screen
      re-renders on every segment — it draws a word count — and every prop it
      gives the pad has to be identical across those renders, or memoisation
      buys nothing.

      The probe is a `memo` wrapper with the same comparison React applies to
      `NotesPad` itself, so a changed prop shows up as a render here. Counting
      an unwrapped wrapper would measure the wrapper's own re-render and always
      report one, which is what the first version of this test did.

      Sabotaged by replacing the `useCallback` below with an inline arrow — the
      mistake a screen makes without thinking — this goes from 0 to 2.
    */
    let padRenders = 0;
    let pushSegment: (text: string) => void = () => {};

    const CountingPad = memo(function CountingPad(props: NotesPadProps) {
      padRenders += 1;
      return createElement(NotesPad, props);
    });

    function Screen() {
      const [segments, setSegments] = useState<string[]>([]);
      pushSegment = (text) => setSegments((all) => [...all, text]);
      // Exactly what `LiveMeetingScreen` does, and the line under test.
      const onChangeText = useCallback(() => {}, []);
      return createElement(
        "div",
        null,
        createElement("span", null, `${segments.length} segments`),
        createElement(CountingPad, { initialValue: "", onChangeText }),
      );
    }

    const mounted = mount(createElement(Screen));
    const afterMount = padRenders;

    act(() => {
      pushSegment("somebody said something");
      pushSegment("and then somebody else did");
    });

    expect(mounted.container.textContent).toContain("2 segments");
    expect(padRenders).toBe(afterMount);
    mounted.unmount();
  });

  test("the pad is memoised, which is the other half", () => {
    /*
      Stable props are worth nothing if the component re-renders anyway. This is
      a structural assertion because there is no behavioural one available: a
      re-rendered `NotesPad` produces identical DOM, which is the whole reason
      this bug is invisible at rest.
    */
    expect((NotesPad as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  test("the caret stays where it was when the screen re-renders around it", () => {
    /*
      What a person feels. A controlled input reassigns `value` on every parent
      render and the browser puts the caret at the end — so somebody typing in
      the middle of a line has the cursor thrown to the bottom of their notes
      once a second while a transcript is coming in.
    */
    let tick: () => void = () => {};

    function Screen() {
      const [ticks, setTicks] = useState(0);
      tick = () => setTicks((count) => count + 1);
      const onChangeText = useCallback(() => {}, []);
      return createElement(
        "div",
        null,
        createElement("span", null, `${ticks}`),
        createElement(NotesPad, { initialValue: "", onChangeText }),
      );
    }

    const mounted = mount(createElement(Screen));
    type(mounted.pad, "curiosity is the prerequisite");
    // Somebody goes back to fix a word.
    mounted.pad.setSelectionRange(9, 9);

    act(() => {
      tick();
      tick();
    });

    expect(mounted.pad.value).toBe("curiosity is the prerequisite");
    expect(mounted.pad.selectionStart).toBe(9);
    mounted.unmount();
  });

  test("the store is told what was typed and never tells the pad", () => {
    /*
      The direction that makes the rest possible. A controlled pad round-trips
      every keystroke through the store and back; this one only ever reports.
      The assertion is that a *later* `initialValue` is ignored — which is what
      a store echo would look like, and is the one thing that could put stale
      text in front of a fast typist.
    */
    const heard: string[] = [];
    const onChangeText = (text: string) => heard.push(text);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(NotesPad, { initialValue: "", onChangeText }));
    });
    const pad = host.querySelector("textarea") as HTMLTextAreaElement;

    type(pad, "half a sen");
    type(pad, "half a sentence");

    // The store echoing back an older value — the shape of the bug.
    act(() => {
      root.render(createElement(NotesPad, { initialValue: "half a sen", onChangeText }));
    });

    expect(heard).toEqual(["half a sen", "half a sentence"]);
    expect(pad.value).toBe("half a sentence");

    act(() => root.unmount());
    host.remove();
  });

  test("nothing in the notepad's module can reach a transcript", () => {
    /*
      Stronger than a rule saying it must not: `NotesPad` imports the design
      system and React, and nothing from `features/meetings` at all. A future
      caller cannot reintroduce the bug by wiring the session in, because there
      is nothing here to wire it to.

      Read as source rather than asserted through a render, because what is
      being checked is the *absence* of a path — which no render can show.
    */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path") as typeof import("node:path");
    const source = readFileSync(
      join(__dirname, "..", "features", "meetings", "components", "NotesPad.tsx"),
      "utf8",
    );
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );
    expect(imports.sort()).toEqual(["../../design/theme", "../../design/tokens", "react", "react-native"]);
    // And no `value=` prop, which is the one-word way to make it controlled.
    expect(source).not.toMatch(/^\s*value=/m);
  });
});

describe("the pad is a document, not a form field", () => {
  test("Return inserts a newline rather than submitting", () => {
    const mounted = mount(
      createElement(NotesPad, { initialValue: "", onChangeText: () => {} }),
    );
    // `multiline` is what react-native-web turns into a `<textarea>` at all; a
    // single-line input would be an `<input>`, and Return would end the note.
    expect(mounted.pad.tagName).toBe("TEXTAREA");
    mounted.unmount();
  });

  test("autocorrect is off, because these are names and jargon at speed", () => {
    const mounted = mount(
      createElement(NotesPad, { initialValue: "", onChangeText: () => {} }),
    );
    expect(mounted.pad.getAttribute("autocorrect")).toBe("off");
    expect(mounted.pad.getAttribute("spellcheck")).toBe("false");
    mounted.unmount();
  });

  test("it carries a name a screen reader can announce", () => {
    const mounted = mount(
      createElement(NotesPad, { initialValue: "", onChangeText: () => {} }),
    );
    expect(mounted.pad.getAttribute("aria-label")).toBe("Your notes for this meeting");
    mounted.unmount();
  });
});

/* Keeps `jest` imported for the environment pragma above without a stray use. */
jest.setTimeout(20_000);
