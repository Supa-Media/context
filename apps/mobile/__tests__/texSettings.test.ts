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
