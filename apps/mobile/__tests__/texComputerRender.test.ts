/**
 * @jest-environment jsdom
 */

/**
 * `/tex/<handle>` ON THE GLASS, as Chrome Remote Desktop draws a computer on
 * a phone: the remote screen edge to edge, a top bar of three icons, a cursor
 * over the picture and a "Send text" bar under it — and that each control
 * sends exactly the action it names. The off and not-yours states keep their
 * words.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-10-12):
 *  1. Return sending the Enter before the text → "Send text: return sends
 *     the text, then Enter, and takes control" fails.
 *  2. The Tab key put back in the send-text bar → "opens straight into the
 *     live screen, with nothing but the remote's own controls" fails.
 *  3. The trackpad tap sent where the finger is → "a tap on the screen
 *     clicks where the cursor is, and takes control" fails.
 *  4. The screen's own not-yours check dropped, so a live frame handed to
 *     somebody else's page is drawn → "not yours shows nothing of a
 *     browser" fails.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  useLocalSearchParams: () => ({}),
}));
jest.mock("convex/react", () => ({
  useAction: () => async () => null,
  useQuery: () => undefined,
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "x", expiresAt: 0, scopes: [] }) }));

import { TexComputerBody } from "../features/tex/TexComputerScreen";
import { HAND_BACK_NOTICE, type Frame, type TexAction, type TexPageView } from "../features/tex/texComputer";
import type { TexComputerState } from "../features/tex/useTexComputer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const READY: TexPageView = { kind: "ready", handle: "seyi", workspaceId: "ws_seyi" };
const LIVE: Frame = { running: true, url: "https://chatgpt.com/auth/login", title: "Log in", width: 1280, height: 860, scale: 0.6, frame: "QUJD" };
/** Where the stage is on the glass: under a 50pt bar, a phone's width. */
const STAGE = { left: 0, top: 50, width: 390, height: 700 };

/*
  jsdom lays nothing out, so react-native-web's `onLayout` never fires there.
  A ResizeObserver that reports at once and a stage that measures as a phone
  is enough for the screen to place its picture and cursor as it would.
*/
beforeAll(() => {
  class Reporting {
    constructor(private readonly report: (entries: { target: Element }[]) => void) {}
    observe(target: Element) {
      queueMicrotask(() => this.report([{ target }]));
    }
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = Reporting;
  // `onLayout` reads offsets; `measureInWindow` reads the bounding box.
  const isStage = (node: Element) => node.getAttribute("data-testid") === "tex-frame";
  for (const [property, value] of [["offsetWidth", STAGE.width], ["offsetHeight", STAGE.height], ["offsetTop", STAGE.top]] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)!;
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        return isStage(this) ? value : original.get!.call(this);
      },
    });
  }
  const measure = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isStage(this)) {
      return { ...STAGE, x: STAGE.left, y: STAGE.top, right: STAGE.width, bottom: STAGE.top + STAGE.height, toJSON() {} } as DOMRect;
    }
    return measure.call(this);
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function computer(over: Partial<TexComputerState> = {}): TexComputerState & { sent: TexAction[]; stopped: number } {
  const state = {
    phase: "live" as const,
    frame: LIVE,
    busy: false,
    sent: [] as TexAction[],
    stopped: 0,
    send: (action: TexAction) => void state.sent.push(action),
    stop: () => void (state.stopped += 1),
    ...over,
  };
  return state;
}

async function render(view: TexPageView, state: TexComputerState) {
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(TexComputerBody, { view, computer: state }))));
  // The layout report and the window measure, each a tick away.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
function press(id: string) {
  const element = byTestId(id);
  if (element === null) throw new Error(`no ${id}`);
  act(() => element.click());
}
function typeInto(id: string, value: string) {
  const input = byTestId(id) as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** A finger as react-native-web's responder system reads a mouse: down, optionally along, up. */
function drag(path: Array<{ x: number; y: number }>) {
  const stage = byTestId("tex-frame")!;
  const at = (type: string, p: { x: number; y: number }, buttons: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, button: 0, buttons });
    // jsdom leaves `pageX` unset; the page does not scroll, so it is the client position.
    Object.defineProperties(event, { pageX: { value: p.x }, pageY: { value: p.y } });
    return event;
  };
  act(() => void stage.dispatchEvent(at("mousedown", path[0], 1)));
  for (const p of path.slice(1)) act(() => void stage.dispatchEvent(at("mousemove", p, 1)));
  act(() => void stage.dispatchEvent(at("mouseup", path[path.length - 1], 0)));
}
const iconIn = (id: string) => byTestId(id)?.querySelector("[data-icon]")?.getAttribute("data-icon");

describe("/tex/<handle>", () => {
  test("opens straight into the live screen, with nothing but the remote's own controls", async () => {
    await render(READY, computer());
    expect(byTestId("tex-live")).not.toBeNull();
    expect(byTestId("tex-status")?.textContent).toBe("Live · chatgpt.com");
    expect(container.innerHTML).toContain("data:image/jpeg;base64,QUJD");
    // The top bar: keyboard, mode, menu, and nothing else to press.
    const toolbar = byTestId("tex-toolbar")!;
    expect(Array.from(toolbar.querySelectorAll('[role="button"]')).map((b) => b.getAttribute("data-testid"))).toEqual([
      "tex-keyboard",
      "tex-mode",
      "tex-menu",
    ]);
    // The send-text bar: its keyboard, the field, Backspace and Return.
    expect((byTestId("tex-send-input") as HTMLInputElement).getAttribute("placeholder")).toBe("Send text");
    expect(byTestId("tex-key-backspace")).not.toBeNull();
    expect(byTestId("tex-key-enter")).not.toBeNull();
    // What the first version had and the owner asked to lose.
    for (const gone of ["tex-take-control", "tex-done", "tex-key-tab", "tex-key-delete", "tex-key-back", "tex-scroll-up", "tex-scroll-down", "tex-live-pill", "tex-where"]) {
      expect(byTestId(gone)).toBeNull();
    }
    expect(container.textContent).not.toContain("Your agent’s computer");
    expect(container.textContent).not.toContain("Context.lc");
  });

  test("the picture fills the stage's width and the cursor starts in its middle", async () => {
    await render(READY, computer());
    const picture = byTestId("tex-picture")!;
    const style = picture.getAttribute("style") ?? "";
    expect(style).toContain("width: 390px");
    const cursor = byTestId("tex-cursor")!;
    expect(cursor.style.left).toBe("195px");
    expect(cursor.style.top).toBe("350px");
  });

  test("a tap on the screen clicks where the cursor is, and takes control", async () => {
    const state = computer();
    await render(READY, state);
    // On the picture, well away from the cursor in its middle.
    drag([{ x: 20, y: STAGE.top + 300 }]);
    expect(state.sent).toEqual([{ kind: "tap", x: 640, y: 430, button: "left" }]);
    expect(byTestId("tex-control")).not.toBeNull();
    expect(byTestId("tex-status")?.textContent).toContain("You're in control");
  });

  test("trackpad: a drag moves the cursor, then hovers it there", async () => {
    const state = computer();
    await render(READY, state);
    drag([
      { x: 100, y: STAGE.top + 300 },
      { x: 120, y: STAGE.top + 300 },
      { x: 139, y: STAGE.top + 300 },
    ]);
    expect(state.sent).toEqual([{ kind: "move", x: 768, y: 430 }]);
    expect(byTestId("tex-cursor")!.style.left).toBe("234px");
  });

  test("touch mode: the toggle switches, and a tap clicks where it lands", async () => {
    const state = computer();
    await render(READY, state);
    expect(iconIn("tex-mode")).toBe("mouse");
    press("tex-mode");
    expect(iconIn("tex-mode")).toBe("touch");
    drag([{ x: 97.5, y: STAGE.top + 350 }]);
    expect(state.sent).toEqual([{ kind: "tap", x: 320, y: 430, button: "left" }]);
    expect(byTestId("tex-cursor")!.style.left).toBe("97.5px");
  });

  test("Send text: return sends the text, then Enter, and takes control", async () => {
    const state = computer();
    await render(READY, state);
    typeInto("tex-send-input", "maya@example.com");
    press("tex-key-enter");
    expect(state.sent).toEqual([
      { kind: "type", text: "maya@example.com" },
      { kind: "key", name: "Enter" },
    ]);
    expect((byTestId("tex-send-input") as HTMLInputElement).value).toBe("");
    expect(byTestId("tex-status")?.textContent).toContain("You're in control");
    // An empty field's return is a bare Enter; the backspace key is the page's.
    press("tex-key-enter");
    press("tex-key-backspace");
    expect(state.sent.slice(2)).toEqual([
      { kind: "key", name: "Enter" },
      { kind: "key", name: "Backspace" },
    ]);
  });

  test("the keyboard button hides and brings back the send-text bar", async () => {
    await render(READY, computer());
    expect(iconIn("tex-keyboard")).toBe("keyboardHide");
    press("tex-keyboard");
    expect(byTestId("tex-send-bar")).toBeNull();
    expect(iconIn("tex-keyboard")).toBe("keyboard");
    press("tex-keyboard");
    expect(byTestId("tex-send-bar")).not.toBeNull();
  });

  test("the menu holds hand back and stop, and each does what it says", async () => {
    const state = computer();
    await render(READY, state);
    typeInto("tex-send-input", "x");
    press("tex-key-enter");
    press("tex-menu");
    expect(byTestId("tex-hand-back")?.textContent).toContain("Hand back to Tex");
    expect(byTestId("tex-stop")?.textContent).toContain("Stop browser");
    press("tex-hand-back");
    expect(byTestId("tex-notice")?.textContent).toBe(HAND_BACK_NOTICE);
    expect(byTestId("tex-live")).not.toBeNull();
    expect(byTestId("tex-status")?.textContent).toContain("Live");
    press("tex-menu");
    press("tex-stop");
    expect(state.stopped).toBe(1);
  });

  test("nothing running is a calm off state, with no controls", async () => {
    await render(READY, computer({ phase: "off", frame: { running: false } }));
    expect(byTestId("tex-off")?.textContent).toContain("Nothing running right now");
    expect(byTestId("tex-frame")).toBeNull();
    expect(byTestId("tex-keyboard")).toBeNull();
    expect(byTestId("tex-send-bar")).toBeNull();
  });

  test("not yours shows nothing of a browser", async () => {
    // Even handed a live frame, the page that is not yours draws none of it.
    await render({ kind: "notYours", own: "bola" }, computer());
    expect(byTestId("tex-not-yours")).not.toBeNull();
    expect(container.textContent).toContain("isn’t yours");
    expect(container.textContent).toContain("/tex/bola");
    expect(byTestId("tex-frame")).toBeNull();
    expect(byTestId("tex-toolbar")).toBeNull();
    expect(container.innerHTML).not.toContain("chatgpt.com");
    expect(container.innerHTML).not.toContain("QUJD");
  });

  test("the gateway's not-yours is shown the same way", async () => {
    await render(READY, computer({ phase: "notYours", frame: null }));
    expect(byTestId("tex-not-yours")).not.toBeNull();
    expect(byTestId("tex-frame")).toBeNull();
  });
});
