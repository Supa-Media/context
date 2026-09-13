/**
 * @jest-environment jsdom
 */

/**
 * The meetings destination control, rendered.
 *
 * `meetingsDestination.test.ts` proves the *resolver* reads the setting and
 * falls back where it must. What that cannot catch is the panel offering the
 * control to somebody the backend will refuse, or — the failure this replaced —
 * offering no control at all and explaining the folder in a paragraph.
 *
 * ## Sabotage record
 *
 * Applied to `MeetingsDestination.tsx`, suite re-run, failing tests counted.
 *
 *   drop the `kind === "personal"` half of `canChange`     1
 *   drop the `role === "owner"` half of `canChange`        1
 *   let Save light up for a folder the gateway refuses     2
 *   drop the second-offer row                              1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  // A console with a provider, so the live half renders and its gating is what
  // the assertions below are actually about.
  useConvex: () => ({}),
  useMutation: () => async () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "../features/design/theme";
import { MeetingsDestination } from "../features/console/settings/panels/MeetingsDestination";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const FOLDERS = ["", "0-inbox", "0-inbox/meetings", "1-projects", "2-areas", "2-areas/meetings"];

function mount(props: Partial<Parameters<typeof MeetingsDestination>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onCaughtError: () => {}, onUncaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(MeetingsDestination, {
          workspaceId: "ws_1",
          slug: "@seyi",
          kind: "personal",
          role: "owner",
          folder: undefined,
          folders: FOLDERS,
          ...props,
        }),
      }),
    );
  });
  return {
    container,
    text: () => container.textContent ?? "",
    find: (testID: string) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`),
    click: async (testID: string) => {
      const element = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
      if (!element) throw new Error(`missing ${testID}`);
      await act(async () => {
        element.click();
      });
    },
    type: async (value: string) => {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="meetings-folder-input"]',
      );
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
  };
}

describe("the folder is a control now, not a sentence", () => {
  test("an owner of a brain can change it", () => {
    const screen = mount();
    expect(screen.find("meetings-folder-edit")).not.toBeNull();
    // The default is shown as the default, not as a stored choice.
    expect(screen.text()).toContain("0-inbox/meetings");
  });

  test("a stored folder is the one shown", () => {
    expect(mount({ folder: "2-areas/meetings" }).text()).toContain("2-areas/meetings");
  });

  test("the editor completes folders from the loaded tree", async () => {
    const screen = mount();
    await screen.click("meetings-folder-edit");
    await screen.type("2-areas/");
    expect(screen.find("meetings-folder-suggest-2-areas/meetings")).not.toBeNull();
  });

  test("a folder the gateway would refuse is refused here, and will not save", async () => {
    const screen = mount();
    await screen.click("meetings-folder-edit");
    await screen.type(".plumbing/meetings");
    expect(screen.text()).toContain("will not file a meeting into this folder");
    expect(screen.find("meetings-folder-save")!.getAttribute("aria-disabled")).toBe("true");
  });

  test("the folder already stored will not save either, however it is spelled", async () => {
    const screen = mount({ folder: "2-areas/meetings" });
    await screen.click("meetings-folder-edit");
    await screen.type("2-areas/meetings/");
    expect(screen.find("meetings-folder-save")!.getAttribute("aria-disabled")).toBe("true");
  });

  test("a real change does light Save up", async () => {
    const screen = mount();
    await screen.click("meetings-folder-edit");
    await screen.type("2-areas/meetings");
    expect(screen.find("meetings-folder-save")!.getAttribute("aria-disabled")).not.toBe("true");
  });

  test("going back to the default is offered only when there is something to go back from", async () => {
    const chosen = mount({ folder: "2-areas/meetings" });
    await chosen.click("meetings-folder-edit");
    expect(chosen.find("meetings-folder-default")).not.toBeNull();

    const untouched = mount();
    await untouched.click("meetings-folder-edit");
    expect(untouched.find("meetings-folder-default")).toBeNull();
  });
});

describe("absent rather than disabled", () => {
  test("a member of somebody else's brain is shown the folder and no way to change it", () => {
    const screen = mount({ role: "member" });
    expect(screen.find("meetings-folder-edit")).toBeNull();
    expect(screen.text()).toContain("0-inbox/meetings");
    expect(screen.text()).toContain("Only the owner of @seyi can change");
  });

  test("a shared workspace says why the setting lives on a brain", () => {
    const screen = mount({ kind: "shared", slug: "@public-worship" });
    expect(screen.find("meetings-folder-edit")).toBeNull();
    expect(screen.text()).toContain("setting on a brain rather than on a shared workspace");
  });
});

describe("what the panel must keep saying", () => {
  test("the second offer is named, and named as always asked", () => {
    /*
      The rule this setting must not be mistaken for. A panel showing one
      configurable folder and nothing else would read as though that were the
      whole answer; the sheet still asks before every recording, and the page
      you are standing on is still offered second.
    */
    const screen = mount();
    expect(screen.text()).toContain("Second offer");
    expect(screen.text()).toContain("Always asked");
    expect(screen.text()).toContain("asked every time, before the microphone opens");
  });
});
