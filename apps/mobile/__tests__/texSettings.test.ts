/**
 * @jest-environment jsdom
 */

/**
 * Settings › Tex (docs/decisions/texting-assistant/custom-instructions.md):
 * how Tex talks to this person in their own chat, in their own words. A quick
 * pick is sent by its id and the control plane writes its line; the text box
 * saves what they wrote, and leaving it unchanged saves nothing.
 *
 * ## Sabotage record
 *
 *  1. The quick pick sent as its label. → `a quick pick is sent by id` fails.
 *  2. A blur saving the unchanged text. → `the box saves what they wrote, once` fails.
 *  3. `<ThisMac />` taken out of the panel. → `inside the Mac app, the panel has Let Tex use this Mac` fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockSaves: unknown[] = [];
let mockSaved: unknown = {};

jest.mock("convex/react", () => ({
  useConvex: () => ({}),
  useQuery: () => mockSaved,
  useMutation: () => async (args: unknown) => {
    mockSaves.push(args);
    return 1;
  },
}));

// The Mac app's bridge, or none (a browser or a phone).
let mockMachine: unknown = null;
const mockEnabled: boolean[] = [];
jest.mock("@context/desktop-bridge", () => ({
  getDesktopBridge: () => (mockMachine === null ? null : { machine: mockMachine }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TexSettings } from "../features/console/settings/panels/TexSettings";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(TexSettings));
  });
  return host;
}

function byTestId(id: string): HTMLElement {
  const found = host!.querySelector(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`no ${id}`);
  return found as HTMLElement;
}

async function pick(menu: string, label: string) {
  await act(async () => {
    const opener = (byTestId(menu).querySelector('[role="button"]') as HTMLElement | null) ?? byTestId(menu);
    opener.click();
  });
  const item = [...host!.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((entry) => entry.textContent?.trim() === label) as HTMLElement | undefined;
  if (item === undefined) throw new Error(`no ${label} in ${menu}`);
  await act(async () => {
    item.click();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  mockSaves.length = 0;
  mockSaved = {};
  mockMachine = null;
  mockEnabled.length = 0;
});

const PICKS = [
  { id: "emoji_none", label: "No emoji" },
  { id: "short", label: "Short answers" },
];

describe("Settings › Tex", () => {
  test("their instructions and progress updates show as saved", async () => {
    mockSaved = { instructions: "Answer in French.", updates: "planOnly", picks: PICKS };
    const view = await render();
    expect((byTestId("tex-instructions") as HTMLTextAreaElement).value).toBe("Answer in French.");
    expect(view.textContent).toContain("Plan only");
  });

  test("a quick pick is sent by id", async () => {
    mockSaved = { picks: PICKS };
    await render();
    await pick("tex-picks", "No emoji");
    expect(mockSaves).toEqual([{ change: { pick: "emoji_none" } }]);
  });

  test("the box saves what they wrote, once; progress updates save their level", async () => {
    mockSaved = { instructions: "Be brief.", picks: PICKS };
    await render();
    const box = byTestId("tex-instructions") as HTMLTextAreaElement;
    await act(async () => {
      box.focus();
      box.blur();
    });
    expect(mockSaves).toEqual([]);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!;
      setter.call(box, "Be brief. Call me Captain.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      byTestId("tex-save").click();
    });
    expect(mockSaves).toEqual([{ change: { replace: "Be brief. Call me Captain." } }]);
    await pick("tex-updates", "Off");
    expect(mockSaves.at(-1)).toEqual({ updates: "off" });
  });
});

// The Tex page's connect screen tells a Mac owner to "open Settings › Tex and
// turn on Let Tex use this Mac", and the Mac app has no link to the Tex page.
describe("Settings › Tex, this Mac", () => {
  const status = { available: true, enabled: false, state: "off" };
  test("inside the Mac app, the panel has Let Tex use this Mac, and the switch turns it on", async () => {
    mockMachine = {
      status: async () => status,
      onChange: () => () => {},
      setEnabled: async (on: boolean) => {
        mockEnabled.push(on);
        return { ...status, enabled: on, state: on ? "starting" : "off" };
      },
    };
    const view = await render();
    await act(async () => {});
    expect(view.textContent).toContain("Let Tex use this Mac");
    await act(async () => {
      (byTestId("tex-this-mac-switch").querySelector('[role="switch"]') as HTMLElement | null ?? byTestId("tex-this-mac-switch")).click();
    });
    expect(mockEnabled).toEqual([true]);
  });

  test("in a browser or on a phone, there is no switch", async () => {
    const view = await render();
    expect(view.textContent).not.toContain("Let Tex use this Mac");
  });
});
