/**
 * @jest-environment jsdom
 */

/**
 * `/tex/<handle>` ON THE GLASS: the four screens of the approved mockup —
 * watching live, in control, nothing running, and not yours — and that each
 * control sends exactly the action it names.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-10-11):
 *  1. The type bar drawn only after a field is tapped → "in control, the type
 *     bar is always there and sends what was typed" fails.
 *  2. Delete sending `Enter` → "each key sends the key it names" fails.
 *  3. The frame drawn on the not-yours page → "not yours shows nothing of a
 *     browser" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
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
const LIVE: Frame = { running: true, url: "https://chatgpt.com/auth/login", title: "Log in", width: 1280, height: 860, frame: "QUJD" };

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

function render(view: TexPageView, state: TexComputerState) {
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(TexComputerBody, { view, computer: state }))));
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
function press(id: string) {
  const element = byTestId(id);
  if (element === null) throw new Error(`no ${id}`);
  act(() => element.click());
}

describe("/tex/<handle>", () => {
  test("watching live: where it is, the picture, and Take control / Stop", () => {
    const state = computer();
    render(READY, state);
    expect(byTestId("tex-live")).not.toBeNull();
    expect(byTestId("tex-live-pill")?.textContent).toBe("Live");
    expect(byTestId("tex-where")?.textContent).toBe("Log in · chatgpt.com");
    expect(container.innerHTML).toContain("data:image/jpeg;base64,QUJD");
    expect(byTestId("tex-take-control")).not.toBeNull();
    expect(byTestId("tex-type-bar")).toBeNull();
    press("tex-stop");
    expect(state.stopped).toBe(1);
  });

  test("in control, the type bar is always there and sends what was typed", () => {
    const state = computer();
    render(READY, state);
    press("tex-take-control");
    expect(byTestId("tex-control")).not.toBeNull();
    expect(byTestId("tex-live-pill")?.textContent).toBe("You're in control");
    const input = byTestId("tex-type-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute("placeholder")).toBe("Type into the page");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "maya@example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    press("tex-type-send");
    expect(state.sent).toEqual([{ kind: "type", text: "maya@example.com" }]);
    expect((byTestId("tex-type-input") as HTMLInputElement).value).toBe("");
  });

  test("each key sends the key it names", () => {
    const state = computer();
    render(READY, state);
    press("tex-take-control");
    for (const id of ["tex-key-tab", "tex-key-enter", "tex-key-delete", "tex-key-back", "tex-scroll-up", "tex-scroll-down"]) press(id);
    expect(state.sent).toEqual([
      { kind: "key", name: "Tab" },
      { kind: "key", name: "Enter" },
      { kind: "key", name: "Backspace" },
      { kind: "back" },
      { kind: "scroll", dy: -500 },
      { kind: "scroll", dy: 500 },
    ]);
  });

  test("Done hands back to Tex: back to watching, told to text done", () => {
    const state = computer();
    render(READY, state);
    press("tex-take-control");
    press("tex-done");
    expect(byTestId("tex-live")).not.toBeNull();
    expect(byTestId("tex-type-bar")).toBeNull();
    expect(byTestId("tex-notice")?.textContent).toBe(HAND_BACK_NOTICE);
  });

  test("nothing running is a calm off state", () => {
    render(READY, computer({ phase: "off", frame: { running: false } }));
    expect(byTestId("tex-off")?.textContent).toContain("Nothing running right now");
    expect(byTestId("tex-frame")).toBeNull();
    expect(byTestId("tex-take-control")).toBeNull();
  });

  test("not yours shows nothing of a browser", () => {
    // Even handed a live frame, the page that is not yours draws none of it.
    render({ kind: "notYours", own: "bola" }, computer());
    expect(byTestId("tex-not-yours")).not.toBeNull();
    expect(container.textContent).toContain("isn’t yours");
    expect(container.textContent).toContain("/tex/bola");
    expect(byTestId("tex-frame")).toBeNull();
    expect(container.innerHTML).not.toContain("chatgpt.com");
    expect(container.innerHTML).not.toContain("QUJD");
  });

  test("the gateway's not-yours is shown the same way", () => {
    render(READY, computer({ phase: "notYours", frame: null }));
    expect(byTestId("tex-not-yours")).not.toBeNull();
    expect(byTestId("tex-frame")).toBeNull();
  });
});
