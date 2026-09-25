/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

/**
 * The setup widget: where the first run carries on after the fork (A-05, W-07)
 * and the "You're set up." that closes it (A-09).
 *
 * The wizard lost six screens to this, so the rows have to be as honest as the
 * screens were: each is done because of a fact — a verified binding, notes in
 * the bucket, a client that has actually called — never because somebody
 * pressed past it.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { setupView, showSetupWidget } from "../features/console/setupWidget/rules";
import { SetupWidget, type SetupActions } from "../features/console/setupWidget/SetupWidget";
import { SetupDone } from "../features/console/setupWidget/SetupDone";
import { SetupWidgetHost } from "../features/console/setupWidget/SetupWidgetHost";
import { setupWidgetRetiredKey } from "../features/console/setupWidget/useSetupWidget";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import type { ConsoleData, ConsoleStorage } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = (over: Partial<ConsoleStorage>): ConsoleStorage =>
  ({ connected: true, status: "connected", provider: "r2", conditionalWrite: true, updatedAt: 1, ...over }) as ConsoleStorage;

const claudeUsed = [{ clientId: "c1", clientName: "Claude", status: "active", lastUsedAt: 1_700_000_000_000 }];

describe("each row is done because of a fact", () => {
  test("a name and nothing else is one of four, and storage is what to do now", () => {
    const view = setupView({ slug: "seyi", storage: null, grants: [] });
    expect(view.done).toBe(1);
    expect(view.rows.map((row) => row.state)).toEqual(["done", "current", "todo", "todo"]);
    expect(view.rows[1]!.sub).toBe("Not connected yet");
    expect(view.rows[2]!.sub).toBe("Needs storage first");
  });

  test("“Start fresh” landed: our bucket, five folders — three of four, tools next", () => {
    const view = setupView({
      slug: "seyi",
      storage: storage({ managed: true, scaffoldReason: "created", noteCount: 0 }),
      grants: [],
    });
    expect(view.done).toBe(3);
    expect(view.rows[1]!.sub).toBe("Our bucket · @seyi");
    expect(view.rows[2]!.sub).toMatch(/Five folders/);
    expect(view.rows[3]!.state).toBe("current");
    expect(view.complete).toBe(false);
  });

  test("a client that has called is the fourth, and only then is it complete", () => {
    const view = setupView({
      slug: "seyi",
      storage: storage({ noteCount: 47 }),
      grants: claudeUsed,
    });
    expect(view.complete).toBe(true);
    expect(view.rows[2]!.sub).toBe("47 notes");
    expect(view.rows[3]!.title).toBe("Connect your AI");
    expect(view.rows[3]!.sub).toBe("Claude knows your work");
  });

  test("a grant nobody has used is not a connected tool", () => {
    const view = setupView({
      slug: "seyi",
      storage: storage({ noteCount: 3 }),
      grants: [{ clientId: "c1", clientName: "Claude", status: "active", lastUsedAt: null }],
    });
    expect(view.complete).toBe(false);
    expect(view.rows[3]!.sub).toBe("So it remembers what you tell it");
  });

  test("a bucket that failed its check is not storage done, and says so", () => {
    const view = setupView({ slug: "seyi", storage: storage({ status: "error" }), grants: [] });
    expect(view.rows[1]!.state).toBe("current");
    expect(view.rows[1]!.sub).toMatch(/Needs attention/);
  });

  test("a verified but empty bucket is not notes done", () => {
    const view = setupView({
      slug: "seyi",
      storage: storage({ scaffoldReason: "empty", noteCount: 0 }),
      grants: [],
    });
    expect(view.rows[2]!.state).toBe("current");
  });

  test("grants still loading are not zero tools", () => {
    const view = setupView({ slug: "seyi", storage: storage({ noteCount: 1 }), grants: undefined });
    expect(view.rows[3]!.state).toBe("current");
    expect(view.rows[3]!.sub).toBe("Checking…");
  });
});

describe("who sees it", () => {
  const base = { demo: false, compact: false, kind: "personal", role: "owner", retired: false };

  test("the owner of a personal workspace, at a pointer width", () => {
    expect(showSetupWidget(base)).toBe(true);
  });

  test("nobody else, and never before the device has answered", () => {
    expect(showSetupWidget({ ...base, role: "member" })).toBe(false);
    expect(showSetupWidget({ ...base, kind: "shared" })).toBe(false);
    expect(showSetupWidget({ ...base, compact: true })).toBe(false);
    expect(showSetupWidget({ ...base, demo: true })).toBe(false);
    expect(showSetupWidget({ ...base, retired: true })).toBe(false);
    // Unknown is not "not retired": drawing it and then pulling it away is the
    // flash `useContextIntro` refuses too.
    expect(showSetupWidget({ ...base, retired: undefined })).toBe(false);
  });
});

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    container,
    byId,
    press: async (id: string) => {
      const target = byId(id);
      if (target === null) throw new Error(`nothing to press: ${id}`);
      await act(async () => {
        target.click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the widget", () => {
  const calls: string[] = [];
  const actions: SetupActions = {
    onOpenStorage: () => calls.push("storage"),
    onOpenConnections: () => calls.push("connections"),
    onOpenGuide: (agent) => calls.push(`guide:${agent}`),
    onPutAway: () => calls.push("away"),
  };
  const view = setupView({ slug: "seyi", storage: storage({ managed: true, scaffoldReason: "created" }), grants: [] });

  beforeEach(() => {
    calls.length = 0;
  });

  test("says where you are, and opens storage from its row", async () => {
    const widget = mount(createElement(SetupWidget, { slug: "seyi", view, actions, workspaceId: "ws-test", grants: [] }));
    expect(widget.byId("setup-widget-count")?.textContent).toMatch(/^3 of 4/);
    await widget.press("setup-row-storage");
    expect(calls).toEqual(["storage"]);
    widget.unmount();
  });

  test("Claude and ChatGPT are tiles under the last row, and each opens its guide", async () => {
    const widget = mount(createElement(SetupWidget, { slug: "seyi", view, actions, workspaceId: "ws-test", grants: [] }));
    expect(widget.byId("setup-row-tools")?.textContent).toContain("Connect your AI");
    // No bootstrap row any more: bringing over what the AI knows is the guide's last step.
    expect(widget.byId("setup-tool-bootstrap")).toBeNull();
    await act(async () => {});
    expect(widget.byId("agent-tile-claude")?.textContent).toContain("Set up");
    await widget.press("agent-tile-claude");
    await widget.press("agent-tile-chatgpt");
    expect(calls).toEqual(["guide:claude", "guide:chatgpt"]);
    widget.unmount();
  });

  test("a tool that has called turns the row into a Manage link, and the tile says Connected", async () => {
    const done = setupView({ slug: "seyi", storage: storage({ noteCount: 3 }), grants: claudeUsed });
    const widget = mount(
      createElement(SetupWidget, { slug: "seyi", view: done, actions, workspaceId: "ws-test", grants: claudeUsed }),
    );
    await act(async () => {});
    expect(widget.byId("agent-tile-claude")?.textContent).toContain("Connected");
    expect(widget.byId("agent-tile-chatgpt")?.textContent).toContain("Set up");
    await widget.press("setup-row-tools");
    expect(calls).toEqual(["connections"]);
    widget.unmount();
  });

  test("collapses to its header, and can be put away", async () => {
    const widget = mount(createElement(SetupWidget, { slug: "seyi", view, actions, workspaceId: "ws-test", grants: [] }));
    await widget.press("setup-widget-toggle");
    expect(widget.byId("setup-row-storage")).toBeNull();
    await widget.press("setup-widget-toggle");
    await widget.press("setup-widget-hide");
    expect(calls).toEqual(["away"]);
    widget.unmount();
  });
});

describe("“You're set up.”", () => {
  test("states the exit and where to act on it, and closes", async () => {
    let closed = 0;
    const done = mount(
      createElement(SetupDone, { onClose: () => closed++, onCopyBootstrap: async () => true }),
    );
    expect(done.container.textContent).toContain("You're set up.");
    // No Download button: there is no whole-workspace download to wire it to.
    expect(done.byId("setup-done-exit")?.textContent).toMatch(/downloads as a \.zip from Files/);
    expect(done.container.textContent).not.toMatch(/\bDownload\b/);
    await done.press("setup-done-close");
    expect(closed).toBe(1);
    done.unmount();
  });
});

describe("mounted over a workspace", () => {
  function clientAnswering(grants: unknown) {
    return {
      watchQuery: (ref: never) => ({
        localQueryResult: () => (getFunctionName(ref) === "functions/grants:listGrants" ? grants : undefined),
        onUpdate: () => () => {},
        journal: () => undefined,
      }),
      mutation: async () => ({}),
      action: async () => ({}),
      connectionState: () => ({ isWebSocketConnected: true }),
    } as never;
  }

  function demo(contextId: string): ConsoleData {
    let latest: ConsoleData | null = null;
    function Probe() {
      latest = useDemoConsoleData();
      return null;
    }
    const probe = mount(createElement(Probe));
    act(() => {
      latest!.selectContext(contextId);
    });
    probe.unmount();
    return { ...latest!, demo: false, storage: storage({ managed: true, scaffoldReason: "created" }) } as ConsoleData;
  }

  function setWidth(width: number) {
    Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  beforeEach(() => {
    window.localStorage.clear();
    setWidth(1400);
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function host(data: ConsoleData) {
    const view = mount(
      createElement(ConvexProvider, { client: clientAnswering([]) }, createElement(SetupWidgetHost, { data })),
    );
    await act(async () => {});
    return view;
  }

  test("appears for the owner of their personal workspace, and “Hide” is remembered", async () => {
    const data = demo("seyi");
    const first = await host(data);
    expect(first.byId("setup-widget")).not.toBeNull();
    await first.press("setup-widget-hide");
    expect(first.byId("setup-widget")).toBeNull();
    expect(window.localStorage.getItem(setupWidgetRetiredKey("seyi"))).not.toBeNull();
    first.unmount();

    // The reload: still put away.
    const second = await host(data);
    expect(second.byId("setup-widget")).toBeNull();
    second.unmount();
  });

  test("never over somebody else's workspace", async () => {
    const view = await host(demo("lk"));
    expect(view.byId("setup-widget")).toBeNull();
    view.unmount();
  });

  test("never on a phone, where the workspace's own band carries the offers", async () => {
    setWidth(390);
    const view = await host(demo("seyi"));
    expect(view.byId("setup-widget")).toBeNull();
    view.unmount();
  });
});
