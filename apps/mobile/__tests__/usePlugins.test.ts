/**
 * @jest-environment jsdom
 */

/**
 * The plugin inventory's one call, and the three things it must not do.
 *
 * `listObsidianPlugins` is an action that reaches past Convex to the gateway
 * and opens every plugin's manifest and bundle in the customer's bucket. That
 * makes the wrong behaviours here expensive rather than merely wrong, and none
 * of them is visible from the panel's side:
 *
 *  - reading on mount — a settings pane that rescans somebody's whole vault
 *    every time it is opened;
 *  - sending the call for a member — `authorizeFileAccess(minimum: "owner")`
 *    refuses it, so the console would be rendering a permission error it could
 *    have predicted from `role`;
 *  - keeping one context's mockAnswer on screen under another context's name.
 *
 * The fourth is a claim rather than a cost: `available: false` is a storage
 * failure, and the reason the provider gave has to survive to the screen
 * verbatim rather than becoming "something went wrong".
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

type Inventory = {
  available: boolean;
  reason: string | null;
  plugins: unknown[];
  found: number;
  scanned: number;
  truncated: boolean;
  checkedAt: string;
};

/** Every call the hook makes, so "it did not call" is assertable. */
const mockCalls: unknown[] = [];
let mockAnswer: Inventory | Error = {
  available: true,
  reason: null,
  plugins: [],
  found: 0,
  scanned: 0,
  truncated: false,
  checkedAt: "2026-09-12T09:41:00.000Z",
};

jest.mock("convex/react", () => ({
  useAction: () => async (args: unknown) => {
    mockCalls.push(args);
    if (mockAnswer instanceof Error) throw mockAnswer;
    return mockAnswer;
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { usePlugins } from "../features/console/plugins/usePlugins";
import type { PluginsView } from "../features/console/plugins/plugins";
import type { Id } from "@context/convex/_generated/dataModel";

const WORKSPACE = "ws_one" as Id<"workspaces">;
const OTHER = "ws_two" as Id<"workspaces">;

interface Harness {
  view: () => PluginsView;
  set: (options: { workspaceId: Id<"workspaces"> | null; role: string | undefined }) => void;
  unmount: () => void;
}

function mount(initial: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
}): Harness {
  let latest: PluginsView | null = null;
  let options = initial;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe({ workspaceId, role }: { workspaceId: Id<"workspaces"> | null; role: string | undefined }) {
    latest = usePlugins({ workspaceId, role });
    return null;
  }

  const render = () => {
    act(() => {
      root.render(createElement(Probe, options));
    });
  };
  render();

  return {
    view: () => {
      if (latest === null) throw new Error("the hook did not render");
      return latest;
    },
    set: (next) => {
      options = next;
      render();
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const mounted: Harness[] = [];
function harness(options: { workspaceId: Id<"workspaces"> | null; role: string | undefined }) {
  const h = mount(options);
  mounted.push(h);
  return h;
}

beforeEach(() => {
  mockCalls.length = 0;
  mockAnswer = {
    available: true,
    reason: null,
    plugins: [],
    found: 0,
    scanned: 0,
    truncated: false,
    checkedAt: "2026-09-12T09:41:00.000Z",
  };
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
  document.body.innerHTML = "";
});

describe("a scan is an event, not a subscription", () => {
  test("mounting reads nothing", () => {
    const h = harness({ workspaceId: WORKSPACE, role: "owner" });
    expect(h.view().state).toBe("idle");
    expect(mockCalls).toHaveLength(0);
  });

  test("the owner's press is what sends the call", async () => {
    const h = harness({ workspaceId: WORKSPACE, role: "owner" });
    const view = h.view();
    if (view.state !== "idle") throw new Error(`expected idle, got ${view.state}`);
    await act(async () => {
      await view.actions?.read();
    });
    expect(mockCalls).toEqual([{ workspaceId: WORKSPACE }]);
    expect(h.view().state).toBe("ready");
  });
});

describe("owner-only, decided before the call rather than after the refusal", () => {
  test("a member is told whose it is, and no call is sent", async () => {
    const h = harness({ workspaceId: WORKSPACE, role: "member" });
    expect(h.view().state).toBe("withheld");
    expect(mockCalls).toHaveLength(0);
  });

  test("an editor is a member for this purpose", () => {
    expect(harness({ workspaceId: WORKSPACE, role: "editor" }).view().state).toBe("withheld");
  });

  test("a role still in flight is not yet an owner", () => {
    expect(harness({ workspaceId: WORKSPACE, role: undefined }).view().state).toBe("withheld");
  });
});

describe("one context's mockAnswer never appears under another's name", () => {
  test("changing context resets to idle rather than keeping the last inventory", async () => {
    const h = harness({ workspaceId: WORKSPACE, role: "owner" });
    const view = h.view();
    if (view.state !== "idle") throw new Error("expected idle");
    await act(async () => {
      await view.actions?.read();
    });
    expect(h.view().state).toBe("ready");

    act(() => h.set({ workspaceId: OTHER, role: "owner" }));
    expect(h.view().state).toBe("idle");
  });
});

describe("a storage failure keeps the provider's own words", () => {
  test("available:false becomes failed, quoting the reason verbatim", async () => {
    mockAnswer = {
      available: false,
      reason: "AccessDenied: the credential cannot list .obsidian/plugins/",
      plugins: [],
      found: 0,
      scanned: 0,
      truncated: false,
      checkedAt: "2026-09-12T09:41:00.000Z",
    };
    const h = harness({ workspaceId: WORKSPACE, role: "owner" });
    const view = h.view();
    if (view.state !== "idle") throw new Error("expected idle");
    await act(async () => {
      await view.actions?.read();
    });
    const failed = h.view();
    if (failed.state !== "failed") throw new Error(`expected failed, got ${failed.state}`);
    expect(failed.reason).toBe("AccessDenied: the credential cannot list .obsidian/plugins/");
  });

  test("a thrown action fails rather than leaving the pane loading forever", async () => {
    mockAnswer = new Error("network");
    const h = harness({ workspaceId: WORKSPACE, role: "owner" });
    const view = h.view();
    if (view.state !== "idle") throw new Error("expected idle");
    await act(async () => {
      await view.actions?.read();
    });
    expect(h.view().state).toBe("failed");
  });

  test("a failed read still offers the way to try again", async () => {
    mockAnswer = new Error("network");
    const h = harness({ workspaceId: WORKSPACE, role: "owner" });
    const view = h.view();
    if (view.state !== "idle") throw new Error("expected idle");
    await act(async () => {
      await view.actions?.read();
    });
    const failed = h.view();
    if (failed.state !== "failed") throw new Error("expected failed");
    expect(failed.actions).toBeDefined();
  });
});
