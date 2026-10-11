/**
 * @jest-environment jsdom
 */

/**
 * The folder-icon hook, mounted, against recorded Convex actions.
 *
 * What is being proven is the order of events a person sees: a list read once
 * per workspace, a chosen icon shown before the server answers and taken back
 * if it refuses, and a folder's icon following the folder through a move made
 * by the file actions rather than by the icon code itself.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileBrowserOptions } from "../features/console/files/fileBrowser/types";
import { useFileActions } from "../features/console/files/fileBrowser/useFileActions";
import { useFolderIcons, type FolderIconsValues } from "../features/console/files/fileBrowser/useFolderIcons";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
  Every action is recorded by its Convex function name and answered by a test.
  A name a test did not answer throws, so an unexpected server call is a
  failure rather than a silent `undefined`.
*/
jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      const answer = answers[name];
      if (answer === undefined) throw new Error(`unanswered call to ${name}`);
      return answer(args);
    };
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

const bound: Record<string, (args: never) => Promise<unknown>> = {};
const answers: Record<string, (args: unknown) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];
const fn = (name: string) => `functions/folderIcons:${name}`;
const files = (name: string) => `functions/files:${name}`;

interface Api {
  icons: FolderIconsValues;
  actions: ReturnType<typeof useFileActions>;
}
let api: Api;

function mount(workspaceId: string | null): { rerender: (next: string | null) => void; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe({ id }: { id: string | null }) {
    const options = { workspaceId: id, canEdit: true, tier: "private" } as unknown as FileBrowserOptions;
    const icons = useFolderIcons(options);
    const actions = useFileActions({ options, folderIcons: icons });
    api = { icons, actions };
    return null;
  }
  act(() => root.render(createElement(Probe, { id: workspaceId })));
  return {
    rerender: (next) => act(() => root.render(createElement(Probe, { id: next }))),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function listed(name: string): unknown[] {
  return calls.filter((call) => call.name === fn(name)).map((call) => call.args);
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
  answers[fn("list")] = async () => [
    { path: "2-areas/cooking", icon: "🍳" },
    { path: "1-projects", icon: "🚀" },
    { path: "1-projects/site", icon: "🌐" },
  ];
  answers[fn("set")] = async () => [{ path: "2-areas/cooking", icon: "🥘" }];
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("reading the icons", () => {
  test("the list is read once for the workspace, and its icons are drawn", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    expect(listed("list")).toEqual([{ workspaceId: "w1" }]);
    expect(api.icons.iconOf("2-areas/cooking")).toBe("🍳");
    expect(api.icons.iconOf("2-areas")).toBeNull();
  });

  test("a rerender with the same workspace does not read it again", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    m.rerender("w1");
    await settle();
    expect(listed("list")).toHaveLength(1);
  });

  test("a failed read leaves every folder with the plain icon", async () => {
    answers[fn("list")] = async () => {
      throw new Error("offline");
    };
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    expect(api.icons.iconOf("2-areas/cooking")).toBeNull();
  });

  test("no workspace means no read at all", async () => {
    const m = mount(null);
    unmount = m.unmount;
    await settle();
    expect(listed("list")).toEqual([]);
  });

  test("a change of workspace reads the new one's icons and drops the old", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    answers[fn("list")] = async () => [{ path: "1-projects", icon: "🏠" }];
    m.rerender("w2");
    await settle();
    expect(listed("list")).toEqual([{ workspaceId: "w1" }, { workspaceId: "w2" }]);
    expect(api.icons.iconOf("2-areas/cooking")).toBeNull();
    expect(api.icons.iconOf("1-projects")).toBe("🏠");
  });
});

describe("setting an icon", () => {
  test("the new icon is shown at once, then the server's answer replaces the map", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    let release!: (value: unknown) => void;
    answers[fn("set")] = () => new Promise((resolve) => (release = resolve));
    let pending!: Promise<void>;
    act(() => {
      pending = api.icons.setIcon("2-areas/cooking", "🥘");
    });
    expect(api.icons.iconOf("2-areas/cooking")).toBe("🥘");
    await act(async () => {
      release([{ path: "2-areas/cooking", icon: "🥘" }, { path: "1-projects", icon: "🚀" }]);
      await pending;
    });
    expect(listed("set")).toEqual([{ workspaceId: "w1", path: "2-areas/cooking", icon: "🥘" }]);
    expect(api.icons.iconOf("1-projects")).toBe("🚀");
  });

  test("a null icon removes the icon", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    answers[fn("set")] = async () => [{ path: "1-projects", icon: "🚀" }];
    await act(async () => {
      await api.icons.setIcon("2-areas/cooking", null);
    });
    expect(listed("set").at(-1)).toEqual({ workspaceId: "w1", path: "2-areas/cooking", icon: null });
    expect(api.icons.iconOf("2-areas/cooking")).toBeNull();
  });

  test("a refused change puts the old icon back and tells the caller why", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    const refusal = Object.assign(new Error("A folder icon is a single emoji"), {
      data: { message: "A folder icon is a single emoji" },
    });
    answers[fn("set")] = async () => {
      throw refusal;
    };
    let failure: unknown = null;
    await act(async () => {
      try {
        await api.icons.setIcon("2-areas/cooking", "🥘");
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBe(refusal);
    expect(api.icons.iconOf("2-areas/cooking")).toBe("🍳");
  });
});

describe("a folder's icon follows it", () => {
  test("moved() carries the icon, and everything under it, at once", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    act(() => api.icons.moved("1-projects", "4-archive/1-projects"));
    expect(api.icons.iconOf("4-archive/1-projects")).toBe("🚀");
    expect(api.icons.iconOf("4-archive/1-projects/site")).toBe("🌐");
    expect(api.icons.iconOf("1-projects")).toBeNull();
  });

  test("removed() drops the icon of a folder that is gone", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    act(() => api.icons.removed("1-projects"));
    expect(api.icons.iconOf("1-projects")).toBeNull();
    expect(api.icons.iconOf("1-projects/site")).toBeNull();
    expect(api.icons.iconOf("2-areas/cooking")).toBe("🍳");
  });

  test("a rename through the file actions carries the icon, once the server has moved the folder", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    answers[files("moveEntry")] = async () => ({ kind: "moved", from: "1-projects", to: "1-work", paths: [] });
    await act(async () => {
      await api.actions.moveEntry({ workspaceId: "w1", from: "1-projects", to: "1-work" } as never);
    });
    expect(api.icons.iconOf("1-work")).toBe("🚀");
    expect(api.icons.iconOf("1-work/site")).toBe("🌐");
  });

  test("a move the server refuses leaves the icon where it was", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    answers[files("moveEntry")] = async () => {
      throw new Error("refused");
    };
    await act(async () => {
      await api.actions
        .moveEntry({ workspaceId: "w1", from: "1-projects", to: "1-work" } as never)
        .catch(() => {});
    });
    expect(api.icons.iconOf("1-projects")).toBe("🚀");
    expect(api.icons.iconOf("1-work")).toBeNull();
  });

  test("an archive moves the icon to where the folder went", async () => {
    const m = mount("w1");
    unmount = m.unmount;
    await settle();
    answers[files("archiveEntry")] = async () => ({
      kind: "moved",
      from: "1-projects",
      to: "4-archive/2024-01-01/1-projects",
      paths: [],
    });
    await act(async () => {
      await api.actions.archiveEntry({ workspaceId: "w1", path: "1-projects" } as never);
    });
    expect(api.icons.iconOf("4-archive/2024-01-01/1-projects")).toBe("🚀");
    expect(api.icons.iconOf("1-projects")).toBeNull();
  });
});
