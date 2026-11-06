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
 *  4. The empty-list auto-open dropped from `useThisMac`. → `turning it on with no folders opens the Mac's picker` fails.
 *  5. The pick not saved by the page (the shell trusted to save, as v0.1.72 did). → `...the page saves what was picked` fails.
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
  machineFoldersFrom: (v: unknown) => (Array.isArray(v) ? v : null),
}));

// The page saves this Mac's folders with its own grant (`thisMacFolders.ts`); here, a store in memory.
let mockStore: { read: (id: string) => Promise<string[] | null>; save: (id: string, folders: string[]) => Promise<string[] | null> } | null = null;
jest.mock("../features/tex/page/useMachineFolderStore", () => ({
  useMachineFolderStore: () => mockStore,
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
  mockStore = null;
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

  // Dev2, 2026-11-04: choosing folders belongs on the Mac, in its own picker; the page saves them.
  function folderMac(list: string[] | null, picked: string[] | null) {
    const calls = { picked: 0, saved: [] as string[][] };
    let saved = list;
    let state = "off";
    let listen: ((s: unknown) => void) | null = null;
    mockMachine = {
      status: async () => ({ ...status, enabled: state !== "off", state, slots: 2, busy: 0 }),
      onChange: (fn: (s: unknown) => void) => {
        listen = fn;
        return () => {};
      },
      setEnabled: async (on: boolean) => {
        state = on ? "online" : "off";
        const next = { ...status, enabled: on, state, slots: 2, busy: 0 };
        listen?.(next);
        return next;
      },
      id: async () => "mch_1",
      pickFolders: async () => {
        calls.picked += 1;
        return picked;
      },
    };
    mockStore = {
      read: async (id) => (id === "mch_1" ? saved : null),
      save: async (id, folders) => {
        calls.saved.push(folders);
        if (id !== "mch_1") return null;
        saved = folders;
        return folders;
      },
    };
    return calls;
  }

  async function turnOn() {
    await act(async () => {
      (byTestId("tex-this-mac-switch").querySelector('[role="switch"]') as HTMLElement | null ?? byTestId("tex-this-mac-switch")).click();
    });
    await act(async () => {});
    await act(async () => {});
  }

  test("turning it on with no folders opens the Mac's picker, the page saves what was picked, and the row shows it", async () => {
    const calls = folderMac([], ["/Users/dana/Code/app"]);
    const view = await render();
    await act(async () => {});
    expect(view.querySelector('[data-testid="tex-this-mac-folders"]')).toBeNull();
    await turnOn();
    await act(async () => {});
    expect(calls.picked).toBe(1);
    expect(calls.saved).toEqual([["/Users/dana/Code/app"]]);
    expect(byTestId("tex-this-mac-folders").textContent).toContain("~/Code/app");
  });

  test("a folder list that can't be read says so, never Checking… for ever", async () => {
    folderMac(null, null);
    await render();
    await act(async () => {});
    await turnOn();
    expect(byTestId("tex-this-mac-folders").textContent).toContain("Couldn't reach Context");
  });

  test("turning it on with folders already chosen lists them and opens nothing; Change… opens the picker", async () => {
    const calls = folderMac(["/Users/dana/Code"], null);
    await render();
    await act(async () => {});
    await turnOn();
    expect(calls.picked).toBe(0);
    expect(byTestId("tex-this-mac-folders").textContent).toContain("~/Code");
    await act(async () => {
      (byTestId("tex-this-mac-folders-choose").querySelector('[role="button"]') as HTMLElement | null ?? byTestId("tex-this-mac-folders-choose")).click();
    });
    await act(async () => {});
    expect(calls.picked).toBe(1);
    expect(calls.saved).toEqual([]);
    expect(byTestId("tex-this-mac-folders").textContent).toContain("~/Code");
  });

  test("an older Mac app (v0.1.72, whose picker saved nothing), draws no folder row", async () => {
    folderMac([], null);
    const m = mockMachine as Record<string, unknown>;
    delete m.id;
    delete m.pickFolders;
    m.folders = async () => null;
    m.chooseFolders = async () => null;
    const view = await render();
    await act(async () => {});
    await turnOn();
    expect(view.textContent).toContain("Let Tex use this Mac");
    expect(view.querySelector('[data-testid="tex-this-mac-folders"]')).toBeNull();
  });

  test("in a browser or on a phone, there is no switch", async () => {
    const view = await render();
    expect(view.textContent).not.toContain("Let Tex use this Mac");
  });
});
