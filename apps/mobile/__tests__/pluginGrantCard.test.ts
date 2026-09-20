/**
 * @jest-environment jsdom
 */

/**
 * The consent card, actually rendered.
 *
 * The pure module decides what is true; this file exists because a component
 * can be perfectly correct about that and still put the wrong control on
 * screen. Mutations that were green with only `pluginGrants.test.ts`:
 *
 *  - rendering Approve for a networked plugin, whose press returns
 *    `NETWORK_RUNTIME_UNAVAILABLE`;
 *  - rendering Approve for a viewer with no `actions` — the demo, and anyone
 *    who is not the owner;
 *  - opening the capability form expanded, so a plugin list becomes a column of
 *    consent forms nobody asked for;
 *  - a single-press Revoke.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginGrantCard } from "../features/console/settings/panels/PluginGrantCard";
import type { GrantsView, PluginGrant } from "../features/console/plugins/grants";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function plugin(over: Partial<ConsolePlugin> = {}): ConsolePlugin {
  return {
    id: "highlightr-plugin",
    source: "obsidian",
    bundleFingerprint: "fp-1",
    name: "Highlightr",
    verdict: "runs",
    evidence: [],
    limitations: [],
    notes: [],
    hosts: [],
    ...over,
  };
}

function grant(over: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: "highlightr-plugin",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read"],
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const approved: string[] = [];
/** `pluginId:capabilities|hosts`, so a grant's two halves can be asserted together. */
const approvedWithHosts: string[] = [];
const revoked: string[] = [];

function actions(): GrantsView["actions"] {
  return {
    approve: async (input) => {
      approved.push(`${input.pluginId}:${input.capabilities.join(",")}`);
      approvedWithHosts.push(
        `${input.pluginId}:${input.capabilities.join(",")}|${input.networkHosts.join(",")}`,
      );
    },
    revoke: async (pluginId) => {
      revoked.push(pluginId);
    },
  };
}

/**
 * `egress` defaults to false, which is what every existing test here assumed
 * when it did not exist: no public-only egress service, so no network row. The
 * tests that care about the other state pass it explicitly.
 */
function card(
  one: ConsolePlugin,
  partial: Omit<GrantsView, "egress"> & { egress?: boolean },
): HTMLElement {
  const view: GrantsView = { egress: false, ...partial };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(PluginGrantCard, { plugin: one, view }));
  });
  return container;
}

/** Every pressable, by its accessible name. */
function buttons(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[role='button']")).map(
    (node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(),
  );
}

function press(container: HTMLElement, name: string) {
  const target = Array.from(container.querySelectorAll("[role='button'], [role='checkbox']")).find(
    (node) => ((node.getAttribute("aria-label") ?? node.textContent) ?? "").trim().includes(name),
  );
  if (!target) throw new Error(`no control named ${name} — found ${buttons(container).join(" | ")}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("no control that cannot succeed", () => {
  test("a networked plugin gets the sentence and no approval control", () => {
    const container = card(
      plugin({ verdict: "needs-approval", hosts: ["readwise.io"] }),
      { grants: [], loading: false, actions: actions() },
    );
    expect(container.textContent).toContain("egress service");
    expect(buttons(container).some((label) => /review|approve/i.test(label))).toBe(false);
  });

  test("a viewer with no actions is offered nothing to press", () => {
    const container = card(plugin(), { grants: [], loading: false });
    expect(buttons(container)).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  /*
    Nineteen won't-run rows repeating "there is nothing to approve" directly
    under the line that already told them to keep it in Obsidian is a sentence
    people stop reading — including on the rows where it carries something.
  */
  test("a plugin that cannot run here draws nothing at all", () => {
    const container = card(plugin({ verdict: "wont-run" }), {
      grants: [],
      loading: false,
      actions: actions(),
    });
    expect(container.textContent).toBe("");
  });

  test("but a won't-run plugin that still holds a grant is not silent", () => {
    const container = card(plugin({ verdict: "wont-run" }), {
      grants: [grant()],
      loading: false,
      actions: actions(),
    });
    expect(container.textContent).toContain("Approved");
    expect(buttons(container).some((label) => /revoke/i.test(label))).toBe(true);
  });

  test("grants still loading renders nothing rather than an empty standing", () => {
    const container = card(plugin(), { loading: true, actions: actions() });
    expect(container.textContent).toBe("");
  });
});

describe("the form opens closed", () => {
  test("no capability rows until Choose what it can do is pressed", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    expect(container.querySelector("[data-testid='plugin-approve-highlightr-plugin']")).toBeNull();
    press(container, "Choose what it can do");
    expect(container.querySelector("[data-testid='plugin-approve-highlightr-plugin']")).not.toBeNull();
  });

  test("what it opens with is read-only", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Choose what it can do");
    const ticked = Array.from(container.querySelectorAll("[role='checkbox']"))
      .filter((node) => node.getAttribute("aria-checked") === "true")
      .map((node) => node.getAttribute("aria-label"));
    expect(ticked).not.toContain("Create and change notes");
    expect(ticked).not.toContain("Delete notes");
    expect(ticked).toContain("Read your notes");
  });

  test("network is never a row here — it is not grantable yet", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Choose what it can do");
    expect(container.querySelector("[data-testid='capability-network:request']")).toBeNull();
  });

  /*
    The decision this holds on screen: a plugin's handlers fire for changes
    Context makes, and not for an edit made in Obsidian against the same bucket.
    Seyi took that limit on 2026-09-14 rather than build the machinery to watch
    a bucket from outside, on the condition that the UI says so where somebody
    is enabling a plugin.

    It is asserted here rather than left to the copy, because the failure is
    invisible: a task panel that is simply wrong after an evening's work in
    Obsidian, with nothing on screen to explain it. Somebody who read this
    sentence reopens the plugin; somebody who did not concludes it is broken.
  */
  test("the form says which changes a plugin will actually notice", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Choose what it can do");
    const note = container.querySelector(
      "[data-testid='plugin-events-note-highlightr-plugin']",
    );
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("changes Context makes");
    expect(note!.textContent).toContain("Obsidian");
  });

  test("approving sends the ticked capabilities and the installed fingerprint", async () => {
    approved.length = 0;
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Choose what it can do");
    await act(async () => {
      press(container, "Enable with these");
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]).toContain("highlightr-plugin:");
    expect(approved[0]).toContain("vault:read");
    expect(approved[0]).not.toContain("vault:delete");
  });
});

describe("a refused approval says why", () => {
  test("the server's own sentence survives to the form", async () => {
    const container = card(plugin(), {
      grants: [],
      loading: false,
      actions: {
        approve: async () => {
          throw Object.assign(new Error("convex"), {
            data: { code: "PLUGIN_CHANGED", message: "The plugin changed; review it again" },
          });
        },
        revoke: async () => {},
      },
    });
    press(container, "Choose what it can do");
    await act(async () => {
      press(container, "Enable with these");
    });
    expect(container.textContent).toContain("The plugin changed; review it again");
    // Still open: a form that closes on a refusal looks like one that worked.
    expect(container.querySelector("[data-testid='plugin-approve-highlightr-plugin']")).not.toBeNull();
  });

  test("a refusal with nothing to quote still says nothing was granted", async () => {
    const container = card(plugin(), {
      grants: [],
      loading: false,
      actions: {
        approve: async () => {
          throw new Error("network");
        },
        revoke: async () => {},
      },
    });
    press(container, "Choose what it can do");
    await act(async () => {
      press(container, "Enable with these");
    });
    expect(container.textContent).toContain("nothing was granted");
  });
});

describe("a changed bundle returns to review", () => {
  test("a stale grant says so and offers to review the new bundle", () => {
    const container = card(plugin({ bundleFingerprint: "fp-2" }), {
      grants: [grant()],
      loading: false,
      actions: actions(),
    });
    expect(container.textContent).toContain("Needs review");
    expect(container.textContent).toContain("no access at all until you review it");
    expect(buttons(container).some((label) => /Review the new bundle/.test(label))).toBe(true);
  });

  test("an active grant lists what it is allowed, and never says 'running'", () => {
    const container = card(plugin(), {
      grants: [grant({ capabilities: ["vault:read", "metadata:read"] })],
      loading: false,
      actions: actions(),
    });
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("read your notes");
    expect(container.textContent).not.toMatch(/running|loaded/i);
  });
});

describe("revoke takes two presses", () => {
  test("one press arms, the second revokes", () => {
    revoked.length = 0;
    const container = card(plugin(), {
      grants: [grant()],
      loading: false,
      actions: actions(),
    });
    press(container, "Revoke");
    expect(revoked).toHaveLength(0);
    expect(container.textContent).toContain("press again");
    press(container, "press again");
    expect(revoked).toEqual(["highlightr-plugin"]);
  });

  test("nothing to revoke where nothing was granted", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    expect(buttons(container).some((label) => /revoke/i.test(label))).toBe(false);
  });
});

/*
  Slice 3. Until the egress service existed, every networked plugin was
  unapprovable and the console said so; now the deployment answers whether it
  can enforce a host, and the form follows that answer.

  What these hold, and what each would let through if it went:

   - the network row appearing where the deployment cannot enforce it, which is
     a tickbox whose only outcome is `NETWORK_EGRESS_UNAVAILABLE`;
   - hosts sent without the capability, or the capability without hosts —
     `approvePlugin` refuses both, in either direction;
   - a host being sent that the scan never found, which the server also refuses
     and which would be the client inventing authority;
   - a networked plugin whose address is built at runtime being offered a
     network row it can never use.
*/
describe("the network grant follows what the deployment can enforce", () => {
  const networked = (over: Partial<ConsolePlugin> = {}) =>
    plugin({ verdict: "needs-approval", hosts: ["www.bible.com"], ...over });

  test("no egress service, no network row — and the sentence says why", () => {
    const container = card(networked(), { grants: [], loading: false, actions: actions() });
    expect(container.querySelector("[data-testid='capability-network:request']")).toBeNull();
    expect(container.textContent).toContain("no egress service");
  });

  test("with egress, the row appears and the hosts are named", () => {
    const container = card(networked(), {
      grants: [],
      loading: false,
      egress: true,
      actions: actions(),
    });
    press(container, "Choose what it can do");
    expect(container.querySelector("[data-testid='capability-network:request']")).not.toBeNull();
    // Not ticked by default: reaching a third party is somebody's decision.
    expect(
      container
        .querySelector("[data-testid='capability-network:request']")
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(container.querySelector("[data-testid='plugin-hosts-highlightr-plugin']")).toBeNull();
  });

  test("ticking it lists the exact hosts, and approving sends them", async () => {
    approvedWithHosts.length = 0;
    const container = card(networked(), {
      grants: [],
      loading: false,
      egress: true,
      actions: actions(),
    });
    press(container, "Choose what it can do");
    press(container, "Reach the hosts it names");
    expect(container.querySelector("[data-testid='plugin-hosts-highlightr-plugin']")?.textContent)
      .toContain("www.bible.com");
    await act(async () => {
      press(container, "Enable with these");
    });
    expect(approvedWithHosts).toHaveLength(1);
    expect(approvedWithHosts[0]).toContain("network:request");
    expect(approvedWithHosts[0]).toContain("|www.bible.com");
  });

  /*
    The two halves of a network grant are refused apart by `approvePlugin`, in
    either direction. Leaving the capability unticked has to send no hosts, or
    the whole approval fails on something the reader did not choose.
  */
  test("leaving it unticked sends no hosts at all", async () => {
    approvedWithHosts.length = 0;
    const container = card(networked(), {
      grants: [],
      loading: false,
      egress: true,
      actions: actions(),
    });
    press(container, "Choose what it can do");
    await act(async () => {
      press(container, "Enable with these");
    });
    expect(approvedWithHosts[0]).not.toContain("network:request");
    expect(approvedWithHosts[0]!.endsWith("|")).toBe(true);
  });

  /*
    A plugin that builds its URL as it runs reaches the network with no host the
    scan can name. `approvePlugin` accepts only detected hosts, so the row could
    never succeed — and the absence has to be explained rather than left to be
    noticed after installing.
  */
  test("a networked plugin with no readable host gets no row, and is told why", () => {
    const container = card(networked({ hosts: [] }), {
      grants: [],
      loading: false,
      egress: true,
      actions: actions(),
    });
    press(container, "Choose what it can do");
    expect(container.querySelector("[data-testid='capability-network:request']")).toBeNull();
    expect(container.textContent).toContain("builds the address as it runs");
  });

  test("a plugin that reaches nothing is never told about hosts", () => {
    const container = card(plugin(), {
      grants: [],
      loading: false,
      egress: true,
      actions: actions(),
    });
    press(container, "Choose what it can do");
    expect(container.querySelector("[data-testid='plugin-network-note-highlightr-plugin']"))
      .toBeNull();
  });
});
