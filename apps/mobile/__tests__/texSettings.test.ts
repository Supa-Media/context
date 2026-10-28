/**
 * @jest-environment jsdom
 */

/**
 * Settings › Tex (docs/decisions/texting-assistant/tex-settings.md): how Tex
 * talks to this person in their own chat. A pick shows at once and saves the
 * whole style on the account, keeping only changed settings; humor goes in
 * tens.
 *
 * ## Sabotage record
 *
 *  1. `withSetting` keeping a setting put back to its default. → `a setting
 *     put back to its default is not kept` fails.
 *  2. The humor pick saved as the label's text ("60%"). → `humor saves a
 *     number in tens` fails.
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
import { TexSettings, withSetting } from "../features/console/settings/panels/TexSettings";

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
    (byTestId(menu).querySelector('[role="button"]') as HTMLElement | null)?.click() ?? byTestId(menu).click();
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

describe("Settings › Tex", () => {
  test("every setting shows what it is now, defaults included", async () => {
    mockSaved = { tone: "candid", humor: 40 };
    const view = await render();
    for (const word of ["Tone", "Candid", "Warmth", "Enthusiasm", "Emoji", "Length", "Bubbles", "Several per answer", "Humor", "40%"]) {
      expect(view.textContent).toContain(word);
    }
  });

  test("a pick saves the whole style", async () => {
    mockSaved = { humor: 40 };
    await render();
    await pick("tex-tone", "Efficient");
    expect(mockSaves).toEqual([{ texStyle: { humor: 40, tone: "efficient" } }]);
    expect(host!.textContent).toContain("Efficient");
  });

  test("humor saves a number in tens", async () => {
    await render();
    await pick("tex-humor", "60%");
    expect(mockSaves).toEqual([{ texStyle: { humor: 60 } }]);
  });

  test("a setting put back to its default is not kept", () => {
    expect(withSetting({ emoji: "less", humor: 40 }, "emoji", "default")).toEqual({ humor: 40 });
    expect(withSetting({ humor: 40 }, "humor", 75)).toEqual({});
    expect(withSetting({ bubbles: "one" }, "bubbles", "multiple")).toEqual({});
  });
});
