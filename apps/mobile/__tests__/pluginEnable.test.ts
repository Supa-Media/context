/**
 * @jest-environment jsdom
 */

/**
 * One control that turns a plugin on.
 *
 * ## What it replaces, and why the old shape was not a safety feature
 *
 * Getting YouVersion Linker running took ten interactions: install, open the
 * permission form, tick four boxes, Approve, Start, then find the command.
 * Seyi: *"enabling a plugin is so many steps, its like enable all the
 * permissions and then start command? its weird."*
 *
 * Two of those steps existed because the console made somebody **perform** a
 * distinction the system makes for itself. "Approved is permission, not
 * execution" is true and load-bearing — a revoked grant must stop a running
 * bundle, a stopped bundle must keep its approval — and it is not a thing
 * anybody wants to do by hand. Nobody approves a plugin they do not intend to
 * run, so the second button only ever collected a tap.
 *
 * ## What Enable does NOT do, which is the part that keeps it safe
 *
 * It grants `DEFAULT_CAPABILITIES` — read notes, read links and tags, read and
 * write its own settings — plus the exact network hosts the scan read out of
 * the bundle. **Create, change, rename and delete stay off.** That rule is
 * `grants.ts`'s own, written down long before this change: *"turning that into
 * a pre-ticked write grant would be the client deriving authority from
 * evidence — the one thing this frontend is not allowed to do."* Enable is
 * fast because most plugins need nothing more, not because it stopped asking.
 *
 * The hosts are the one addition, and they are not derived: `approvePlugin`
 * accepts only hosts the scan actually read and refuses the capability without
 * any, so the set is the server's, the card names it above the button, and
 * without it Enable would produce a plugin that cannot do the thing it exists
 * for.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginGrantCard } from "../features/console/settings/panels/PluginGrantCard";
import {
  DEFAULT_CAPABILITIES,
  approvalOffer,
  enableCapabilities,
  enableSummary,
} from "../features/console/plugins/grants";
import type { GrantsView, PluginCapability } from "../features/console/plugins/grants";
import type { RuntimeView } from "../features/console/plugins/runtime";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const NETWORKED: ConsolePlugin = {
  id: "youversion-linker",
  source: "obsidian",
  bundleFingerprint: "fp-1",
  name: "YouVersion Linker",
  verdict: "needs-approval",
  hosts: ["www.bible.com"],
  evidence: [],
  limitations: [],
  notes: [],
};

const PLAIN: ConsolePlugin = { ...NETWORKED, id: "plain", hosts: [], verdict: "runs" };

describe("what Enable actually grants", () => {
  test("the read-only defaults, and nothing that writes to a note", () => {
    const caps = enableCapabilities(approvalOffer(PLAIN, true), true);
    expect([...caps].sort()).toEqual([...DEFAULT_CAPABILITIES].sort());
    for (const destructive of ["vault:write", "vault:rename", "vault:delete"] as PluginCapability[]) {
      expect(caps).not.toContain(destructive);
    }
  });

  /*
    The hosts are the one thing Enable adds beyond the defaults, and the reason
    is that without them Enable ships a plugin that cannot do its job — the
    button would produce a broken plugin and a second trip through the form.
  */
  test("plus the network, when the scan read a host and the deployment can enforce it", () => {
    expect(enableCapabilities(approvalOffer(NETWORKED, true), true)).toContain("network:request");
  });

  test("never the network where this deployment has no egress service", () => {
    expect(enableCapabilities(approvalOffer(NETWORKED, false), false)).not.toContain("network:request");
  });

  /*
    A plugin whose URL is built at runtime has no host the scan can name, and
    `approvePlugin` refuses the capability with an empty host list. Granting it
    would make Enable fail outright rather than grant one capability less.
  */
  test("never the network for a bundle whose hosts could not be read", () => {
    const opaque = { ...NETWORKED, hosts: [] };
    expect(enableCapabilities(approvalOffer(opaque, true), true)).not.toContain("network:request");
  });

  test("the summary names the host, so the tap is informed rather than hidden", () => {
    const summary = enableSummary(approvalOffer(NETWORKED, true), true);
    expect(summary).toContain("www.bible.com");
    expect(summary).toContain("will not");
  });

  test("a plugin that reaches nothing gets a summary with no host in it", () => {
    expect(enableSummary(approvalOffer(PLAIN, true), true)).not.toContain("www.bible.com");
  });
});

/* -------------------------------------------------------------------------- */

interface Call { capabilities: PluginCapability[]; networkHosts: string[] }

function harness(options: { egress?: boolean } = {}) {
  const approved: Call[] = [];
  const started: string[] = [];
  const grants: GrantsView = {
    loading: false,
    egress: options.egress ?? true,
    grants: [],
    actions: {
      approve: async (input) => {
        approved.push({ capabilities: input.capabilities, networkHosts: input.networkHosts });
      },
      revoke: async () => {},
    },
  };
  const runtime: RuntimeView = {
    loading: false,
    states: [],
    actions: {
      start: async (pluginId: string) => { started.push(pluginId); },
      stop: async () => {},
      run: () => {},
    },
  };
  return { approved, started, grants, runtime };
}

function render(plugin: ConsolePlugin, grants: GrantsView, runtime: RuntimeView): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(PluginGrantCard, { plugin, view: grants, runtime }));
  });
  roots.push(() => act(() => root.unmount()));
  return host;
}

function press(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("[role='button']")]
    .find((one) => (one.textContent ?? "") === text || (one.textContent ?? "").includes(text));
  if (button === undefined) throw new Error(`no control reading "${text}"`);
  act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

describe("Enable approves and starts, in that order, from one press", () => {
  test("one press grants the defaults plus the host, and starts the bundle", async () => {
    const { approved, started, grants, runtime } = harness();
    const host = render(NETWORKED, grants, runtime);
    press(host, "Enable");
    await act(async () => { await Promise.resolve(); });
    expect(approved).toHaveLength(1);
    expect([...approved[0]!.capabilities].sort()).toEqual(
      [...DEFAULT_CAPABILITIES, "network:request"].sort(),
    );
    expect(approved[0]!.networkHosts).toEqual(["www.bible.com"]);
    expect(started).toEqual(["youversion-linker"]);
  });

  /*
    Order matters and is not cosmetic: starting a bundle the control plane has
    no grant for is a load that will be refused, and the refusal would be
    reported as a crash against a plugin that did nothing wrong.
  */
  test("a failed approval starts nothing", async () => {
    const { started, grants, runtime } = harness();
    grants.actions = {
      approve: async () => { throw new Error("nope"); },
      revoke: async () => {},
    };
    const host = render(NETWORKED, grants, runtime);
    press(host, "Enable");
    await act(async () => { await Promise.resolve(); });
    expect(started).toEqual([]);
  });

  test("the card says what Enable will grant before it is pressed", () => {
    const { grants, runtime } = harness();
    const host = render(NETWORKED, grants, runtime);
    expect(host.textContent).toContain("www.bible.com");
  });

  /*
    The form is not gone, it is behind the fast path. Somebody raising a plugin
    above reading still does it on purpose, which is the rule that makes the
    one-press default defensible rather than merely quick.
  */
  test("choosing what it can do still opens the full form", () => {
    const { grants, runtime } = harness();
    const host = render(NETWORKED, grants, runtime);
    expect(host.textContent).not.toContain("Delete notes");
    press(host, "Choose what it can do");
    expect(host.textContent).toContain("Delete notes");
  });

  test("approving from the form also starts it, so there is no leftover Start", async () => {
    const { approved, started, grants, runtime } = harness();
    const host = render(NETWORKED, grants, runtime);
    press(host, "Choose what it can do");
    press(host, "Enable with these");
    await act(async () => { await Promise.resolve(); });
    expect(approved).toHaveLength(1);
    expect(started).toEqual(["youversion-linker"]);
  });

  /*
    A non-owner has no runtime actions at all. Enable must then do what it can
    rather than throw on the way past — the grant is the part they were offered.
  */
  test("with no runtime to start, the approval still happens", async () => {
    const { approved, grants } = harness();
    const host = render(NETWORKED, grants, { loading: false, states: [] });
    press(host, "Enable");
    await act(async () => { await Promise.resolve(); });
    expect(approved).toHaveLength(1);
  });
});
