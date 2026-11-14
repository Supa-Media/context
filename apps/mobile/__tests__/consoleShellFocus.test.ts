/**
 * @jest-environment jsdom
 */

/**
 * The staff console shell's keyboard and focus, against the artifact's `render()` and key
 * handler (staff-console.html), found by the UX sweep of 2026-11-14:
 *
 *  - Escape closes what is open wherever focus is. The artifact listens on the document; the
 *    shell listened on its root, so after a click redrew the focused button away (focus on the
 *    body) Escape did nothing: a confirm stayed up, the side panel stayed open.
 *  - What has focus is read as each redraw starts. A key kept from an earlier redraw pulled
 *    focus back to the row after the side panel's title took it.
 *  - The side panel's title keeps focus when the panel is drawn again.
 *  - A box that is drawn again keeps its caret, so typing carries on where it was.
 *
 * Fixtures are fake; the page is a stand-in drawn with the artifact's classes.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({ useQuery: () => undefined, useMutation: () => async () => undefined }));
jest.mock("@context/convex/_generated/api", () => ({ api: new Proxy({}, { get: (t, k) => (k === "then" ? undefined : t) }) }));
jest.mock("../features/admin/AdminPane", () => ({ AdminChrome: ({ children }: { children: unknown }) => children }));
jest.mock("../features/admin/StaffFactorGate", () => ({ StaffFactorGate: () => null }));
jest.mock("../features/site/host", () => ({ isTexHost: () => false }));
jest.mock("../features/design/fonts.web", () => ({ ensureFontsLoaded: () => {} }));
jest.mock("../features/admin/console/pages/needs.web", () => ({ useNeeds: () => [] }));
jest.mock("../features/admin/console/pages/registry", () => {
  const state = jest.requireActual("../features/admin/console/state") as typeof import("../features/admin/console/state");
  const page = {
    key: "people",
    windowed: false,
    // Every draw differs (`n`), as a page whose data keeps arriving does: the side panel and the
    // search box are replaced each time.
    render: () =>
      `<div class="tools"><input class="search" id="q" data-act="q" value="${state.S.q}"></div>` +
      `<table><tr class="click" tabindex="0" data-act="sel" data-id="maya"><td>Maya</td></tr></table>` +
      `<button class="ghost" data-act="ask">Ask</button>${state.S.confirm ? '<span class="confirm">Sure?</span>' : ""}<i data-n="${(globalThis as { __n?: number }).__n ?? 0}"></i>`,
    props: (_d: unknown, x: string) => `<div class="pph"><h3 tabindex="-1">${x}</h3><button class="ib sm" data-act="close" aria-label="Close">x</button></div><i data-n="${(globalThis as { __n?: number }).__n ?? 0}"></i>`,
    acts: {
      ask: () => {
        state.S.confirm = "ask";
        state.render();
      },
    },
  };
  const rows = [{ key: "people", name: "People", icon: "people", page }];
  state.setRoutes({ pages: ["people"], windowed: new Set(), filters: {} });
  return { SECTIONS: [["People", rows]], ROWS: rows, ROW: { people: rows[0], home: rows[0] }, hashForOldPath: () => null, windowedNow: () => false };
});

// The mocks above are hoisted by Jest, so these imports see them.
import { Console } from "../features/admin/console/StaffConsole.web";
import { S, render } from "../features/admin/console/state";

let root: Root;
let host: HTMLElement;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => host.querySelector<T>(s);
/** A redraw the page did not ask for: its data changed, so its HTML is new. */
const redraw = () =>
  act(() => {
    (globalThis as { __n?: number }).__n = ((globalThis as { __n?: number }).__n ?? 0) + 1;
    render();
  });
const key = (k: string, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

beforeEach(async () => {
  jest.useFakeTimers();
  history.replaceState(null, "", "/admin#people");
  Object.assign(S, { x: null, confirm: null, q: "" });
  host = document.createElement("div");
  host.className = "sc";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Console, { offerFactor: null })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
});

describe("Escape", () => {
  test("clears a confirm when focus is on the body, as the artifact's document listener does", async () => {
    act(() => $("[data-act=ask]")!.click());
    expect($(".confirm")).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    key("Escape");
    expect($(".confirm")).toBeNull();
  });

  test("closes the side panel when focus is on the body", async () => {
    jest.useRealTimers();
    act(() => $("tr[data-act=sel]")!.click());
    expect($("#props")!.hidden).toBe(false);
    (document.activeElement as HTMLElement | null)?.blur();
    key("Escape");
    // Closing steps Back, and the address answers on popstate.
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(S.x).toBeNull();
    expect($("#props")!.hidden).toBe(true);
  });
});

describe("focus across redraws", () => {
  test("opening the side panel moves focus to its title, and a later redraw neither replaces nor steals it", () => {
    const row = $("tr[data-act=sel]")!;
    row.focus();
    act(() => row.click());
    expect(document.activeElement?.tagName).toBe("H3");
    redraw();
    // The panel was drawn again (a new h3), and focus followed it rather than going back to the row.
    expect(document.activeElement?.tagName).toBe("H3");
    expect(document.activeElement?.closest("#props")).not.toBeNull();
  });

  test("a search box drawn again keeps the caret where it was", () => {
    act(() => {
      S.q = "dana";
      render();
    });
    const q = $<HTMLInputElement>("#q")!;
    q.focus();
    q.setSelectionRange(2, 2);
    redraw();
    const again = $<HTMLInputElement>("#q")!;
    expect(again).not.toBe(q);
    expect(document.activeElement).toBe(again);
    expect(again.selectionStart).toBe(2);
  });
});
