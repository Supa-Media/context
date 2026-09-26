/**
 * @jest-environment jsdom
 */

/**
 * THE CORNER CARD: ONE ANNOUNCEMENT AT A TIME, CLEAR OF THE TOASTS.
 *
 * The browse band used to stack every notice full width above the note, and
 * the owner reported it as taking over the page. What is merely new now sits in
 * `AnnouncementCard`, over the note in the corner. Three things make that card
 * honest rather than a smaller version of the same problem, and each is pinned
 * here:
 *
 *  - **one at a time**: with several, a pager says "1 of 2" and steps through
 *    them; answering one shows the next instead of an empty card;
 *  - **never under a toast**: it shares the editor's bottom edge with
 *    `ToastHost`, so it sits above a measured toast and is not drawn for the
 *    frame in which a new toast has not been measured yet;
 *  - **never over the line being typed** on a phone, where the toolbar it sits
 *    above is replaced by the keyboard's accessory bar.
 *
 * Where each announcement comes from, and that the band no longer draws it, is
 * in the suites for each one: `organizerRender`, `storageMigrationEntry`,
 * `contextIntroNotice` and `browseNoticeActions`.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { AnnouncementCard } from "../features/console/panes/browsePane/AnnouncementCard";
import type { Announcement } from "../features/console/panes/browsePane/announcements";
import { ToastHost } from "../features/design/components/Toast";
import { ToastEdgeProvider, clearOfToasts, NO_TOASTS } from "../features/design/components/toastEdge";
import { FrameContext, type FrameApi } from "../features/app/appFrame/context";
import { space } from "../features/design/tokens";

/** Only the two fields the card reads; the rest of the frame is not consulted. */
const TEST_FRAME: Partial<FrameApi> = { framed: true };

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

const byId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`);
const press = (host: HTMLElement, id: string) => {
  const node = byId(host, id);
  if (node === null) throw new Error(`nothing to press: ${id}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

function item(id: string, answered?: (id: string) => void): Announcement {
  return {
    id,
    eyebrow: `Eyebrow ${id}`,
    title: `Title ${id}`,
    body: `Body ${id}`,
    actions: [{ label: "Got it", onPress: () => answered?.(id), testID: `ok-${id}` }],
    testID: `item-${id}`,
  };
}

describe("one at a time", () => {
  test("a single announcement has no pager", () => {
    const host = mount(createElement(AnnouncementCard, { items: [item("a")], compact: false }));
    expect(byId(host, "item-a")?.textContent).toContain("Title a");
    expect(byId(host, "announcement-pager")).toBeNull();
  });

  test("with two, it says 1 of 2 and steps to the second and back", () => {
    const host = mount(createElement(AnnouncementCard, { items: [item("a"), item("b")], compact: false }));
    expect(byId(host, "announcement-position")?.textContent).toBe("1 of 2");
    expect(byId(host, "item-a")).not.toBeNull();
    expect(byId(host, "item-b")).toBeNull();

    press(host, "announcement-next");
    expect(byId(host, "announcement-position")?.textContent).toBe("2 of 2");
    expect(byId(host, "item-b")?.textContent).toContain("Body b");
    expect(byId(host, "item-a")).toBeNull();

    // The end is the end: Next does nothing on the last one.
    press(host, "announcement-next");
    expect(byId(host, "announcement-position")?.textContent).toBe("2 of 2");

    press(host, "announcement-previous");
    expect(byId(host, "announcement-position")?.textContent).toBe("1 of 2");
  });

  test("answering the one on show brings up the next, never an empty card", () => {
    function Answering() {
      const [items, setItems] = useState([item("a", drop), item("b", drop)]);
      function drop(id: string) {
        setItems((current) => current.filter((row) => row.id !== id));
      }
      return createElement(AnnouncementCard, { items, compact: false });
    }
    const host = mount(createElement(Answering));
    press(host, "announcement-next");
    press(host, "ok-b");
    // The last one went, so the card falls back to the one left, with no pager.
    expect(byId(host, "item-a")).not.toBeNull();
    expect(byId(host, "announcement-pager")).toBeNull();
    press(host, "ok-a");
    expect(byId(host, "announcement-card")).toBeNull();
  });

  test("nothing to announce draws nothing", () => {
    const host = mount(createElement(AnnouncementCard, { items: [], compact: false }));
    expect(byId(host, "announcement-card")).toBeNull();
  });
});

describe("on a phone", () => {
  function onPhone(frame: Partial<FrameApi>) {
    return createElement(
      FrameContext.Provider,
      { value: { ...(TEST_FRAME as FrameApi), ...frame } },
      createElement(AnnouncementCard, { items: [item("a")], compact: true }),
    );
  }

  test("it sits just above the floating toolbar, full width", () => {
    const host = mount(onPhone({ contentInsets: { top: 100, bottom: 110 }, accessoryOpen: false }));
    const place = byId(host, "announcement-card") as HTMLElement;
    const style = getComputedStyle(place);
    expect(style.bottom).toBe(`${110 + space.x2}px`);
    expect(style.left).toBe(`${space.x3}px`);
    expect(style.right).toBe(`${space.x3}px`);
  });

  test("and is put away while the keyboard's accessory bar has the toolbar's place", () => {
    const host = mount(onPhone({ contentInsets: { top: 100, bottom: 110 }, accessoryOpen: true }));
    expect(byId(host, "announcement-card")).toBeNull();
  });
});

describe("the bottom edge it shares with the toasts", () => {
  test("above a measured toast, and unchanged with none", () => {
    expect(clearOfToasts(16, NO_TOASTS, 8)).toBe(16);
    expect(clearOfToasts(16, { showing: true, top: 70 }, 8)).toBe(78);
    // A phone's base is already above the toolbar; a low toast does not pull it down.
    expect(clearOfToasts(140, { showing: true, top: 70 }, 8)).toBe(140);
  });

  test("put away for the frame a new toast has not been measured in", () => {
    expect(clearOfToasts(16, { showing: true, top: null }, 8)).toBeNull();
  });

  /*
    Through the real host. jsdom performs no layout, so a toast here is never
    measured and the card must step aside for it; with no toast the card is
    drawn at its base. Sabotaging `clearOfToasts` to ignore an unmeasured toast
    fails the first half.
  */
  test("the real ToastHost tells the card a toast is up, and when it has gone", () => {
    function Edge({ toasts }: { toasts: { id: string; message: string }[] }) {
      return createElement(
        ToastEdgeProvider,
        null,
        createElement(AnnouncementCard, { items: [item("a")], compact: false }),
        createElement(ToastHost, { toasts, onDismiss: () => {} }),
      );
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    act(() => root.render(createElement(Edge, { toasts: [{ id: "t1", message: "Moved to areas." }] })));
    expect(byId(container, "toast-t1")).not.toBeNull();
    expect(byId(container, "announcement-card")).toBeNull();

    act(() => root.render(createElement(Edge, { toasts: [] })));
    expect(byId(container, "announcement-card")).not.toBeNull();
  });
});
