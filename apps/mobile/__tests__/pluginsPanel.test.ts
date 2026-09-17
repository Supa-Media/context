/**
 * @jest-environment jsdom
 */

/**
 * The Plugins panel, actually rendered.
 *
 * `plugins.test.ts` covers the wording and the two guards as pure functions,
 * and on its own that leaves the limb this file exists for: a panel that never
 * calls them. Mutations that were green with only the pure tests:
 *
 *  - the unavailable branch falling through to the ready branch — fixture
 *    plugin names rendered into a live console, which is the one thing the
 *    frontend brief rules out flatly;
 *  - the failed branch dropping `view.reason` — a storage error reported as a
 *    sentence with no cause in it;
 *  - `found: 0` rendering the summary card instead of its own words — "0 in
 *    this bucket", where the reader needed to be told about their sync;
 *  - the row dropping `routeOut` — every won't-run plugin ending on its
 *    refusal, silently, across the whole list.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../features/console/settings/panels/PluginsPanel";
import type { ManagedInstallsView } from "../features/console/plugins/managedInstalls";
import type { GrantsView } from "../features/console/plugins/grants";
import type { BrowseView } from "../features/console/plugins/lifecycle";
import type { RuntimeView } from "../features/console/plugins/runtime";
import type { ContextPluginsView } from "../features/console/plugins/contextPlugins";
import {
  SCOPE_NOTE,
  type ConsolePlugin,
  type PluginVerdict,
  type PluginsView,
} from "../features/console/plugins/plugins";

/** No scan, nothing installed — the state a bucket with no plugins is really in. */
const NO_INSTALLS: ManagedInstallsView = {
  state: "ready",
  installs: [],
  truncated: false,
  read: async () => {},
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/*
  No grants and no actions by default: this file is about the inventory, and a
  grant view carrying controls would put an Approve button into every assertion
  about wording. `pluginGrants.test.ts` drives the other half.
*/
function panel(
  view: PluginsView,
  grants: GrantsView = { grants: [], loading: false, egress: false },
  browse: BrowseView = { query: "", limit: 20, searching: false, failure: null },
  runtime: RuntimeView = { states: [], loading: false },
  /*
    The built-ins, defaulted to an empty ready state so every check in this file
    keeps testing the vault half alone. They are a separate block of the panel
    with their own file of checks — `contextPluginsCard.test.ts` — and mixing
    them in here would make assertions like "the panel says no plugins" depend
    on a list that has nothing to do with `.obsidian/`.
  */
  contextPlugins: ContextPluginsView = {
    state: "ready",
    plugins: [],
    settingsError: null,
    canManage: false,
  },
  /* Last, so every positional call above this one keeps meaning what it did. */
  installs: ManagedInstallsView = NO_INSTALLS,
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(PluginsPanel, {
        view,
        contextPlugins,
        installs,
        grants,
        browse,
        runtime,
      }),
    );
  });
  return container;
}

/**
 * Open one plugin's own screen, and hand back the container showing it.
 *
 * ## Why half this file now goes through here
 *
 * None of the guarantees below changed. Every sentence a plugin's row carried
 * still has to reach a reader: the call named rather than the category, the
 * route out of a refusal, how much of a bundle was read, the limitations fold.
 * What changed is **where** — reported from a phone as "soooo much jargon text;
 * people just want to enable or disable a plugin", and they were right: a list
 * exists to choose from, and none of that helps choose.
 *
 * So the list answers "is it on and what turns it on", and the rest is one
 * press away. These tests press it. A sentence that stopped being rendered
 * anywhere still fails here, which is the property worth keeping — the risk in
 * a change like this is not that the words move, it is that they quietly stop
 * existing and nothing notices.
 */
function opened(container: HTMLElement, pluginId: string): HTMLElement {
  const details = container.querySelector(
    `[data-testid='plugin-details-${pluginId}']`,
  ) as HTMLElement | null;
  if (details === null) throw new Error(`no Details control for ${pluginId}`);
  act(() => details.click());
  const screen = container.querySelector(`[data-testid='plugin-detail-${pluginId}']`);
  if (screen === null) throw new Error(`pressing Details did not open ${pluginId}`);
  return container;
}

function plugin(over: Partial<ConsolePlugin> & { verdict: PluginVerdict }): ConsolePlugin {
  return {
    id: over.id ?? `plugin-${over.verdict}`,
    source: "obsidian",
    bundleFingerprint: `fp-${over.id ?? over.verdict}`,
    name: over.name ?? "A plugin",
    evidence: [],
    limitations: [],
    notes: [],
    ...over,
  };
}

const READY: PluginsView = {
  state: "ready",
  inventory: {
    found: 3,
    scanned: 3,
    truncated: false,
    checkedAt: "2026-09-12T09:41:00.000Z",
    plugins: [
      plugin({ id: "highlightr-plugin", name: "Highlightr", version: "1.2.2", verdict: "runs" }),
      plugin({
        id: "obsidian-git",
        name: "Obsidian Git",
        verdict: "wont-run",
        evidence: [
          {
            id: "child_process",
            reason: "runs another program; there is no process to start in a browser tab",
          },
        ],
      }),
      plugin({
        id: "dataview",
        name: "Dataview",
        verdict: "unknown",
        bytesRead: 512_000,
        bytesTotal: 1_800_000,
        evidence: [{ id: "read-cap", reason: "the bundle is larger than the check reads" }],
      }),
    ],
  },
};

describe("the five states are five screens", () => {
  test("each state renders its own branch and no other", () => {
    expect(panel({ state: "withheld" }).querySelector("[data-testid='plugins-withheld']")).not.toBeNull();
    expect(panel({ state: "idle" }).querySelector("[data-testid='plugins-idle']")).not.toBeNull();
    expect(panel({ state: "loading" }).querySelector("[data-testid='plugins-loading']")).not.toBeNull();
    expect(
      panel({ state: "failed", reason: "storage: 403" }).querySelector("[data-testid='plugins-failed']"),
    ).not.toBeNull();
    expect(panel(READY).querySelector("[data-testid='plugins-ready']")).not.toBeNull();
  });

  /*
    The guard against the mutation that matters most here. A console that has
    not read anything must render no plugin facts at all — not a name, not a
    verdict, not a count. The same holds for a reader the inventory is withheld
    from, who must additionally not be offered the control.
  */
  test("a scan nobody has run renders no plugin facts", () => {
    const text = panel({ state: "idle" }).textContent ?? "";
    for (const invented of ["Highlightr", "Obsidian Git", "Dataview", "Runs here", "Won't run here"]) {
      expect(text).not.toContain(invented);
    }
    expect(text).toContain(".obsidian/");
  });

  /*
    Scoped to the vault section rather than the whole panel, and the scope is
    the assertion doing its job rather than being weakened: the panel now
    carries its own chrome — a search box and three filter chips — which are
    controls this section's states have nothing to say about. Counting every
    button on the screen would make "a scan in flight offers nothing to press"
    fail for a filter chip, which is not what it is about.
  */
  function vaultControls(container: HTMLElement): NodeListOf<Element> {
    return container.querySelectorAll("[data-testid='plugins-vault'] [role='button'], [data-testid='plugins-vault'] button");
  }

  test("a non-owner is told whose it is, and offered no control", () => {
    const container = panel({ state: "withheld" });
    expect(container.textContent).toContain("Only an owner");
    expect(vaultControls(container)).toHaveLength(0);
  });

  test("the read control is disabled when the view carries no action", () => {
    const control = vaultControls(panel({ state: "idle" }))[0];
    expect(control).not.toBeUndefined();
    expect(control?.getAttribute("aria-disabled")).toBe("true");
  });

  test("a scan in flight offers nothing to press twice", () => {
    expect(vaultControls(panel({ state: "loading" }))).toHaveLength(0);
  });

  test("a failed read quotes the provider's own reason", () => {
    expect(panel({ state: "failed", reason: "storage: 403 from provider" }).textContent).toContain(
      "storage: 403 from provider",
    );
  });

  test("a failed read bounds itself to the Obsidian setup", () => {
    expect(panel({ state: "failed", reason: "storage: 403" }).textContent).toContain(
      "not about your notes",
    );
  });
});

describe("a successful read that found nothing", () => {
  const empty: PluginsView = {
    state: "ready",
    inventory: { found: 0, scanned: 0, truncated: false, checkedAt: "2026-09-12", plugins: [] },
  };

  test("gets its own words rather than an empty summary", () => {
    const container = panel(empty);
    expect(container.querySelector("[data-testid='plugins-empty']")).not.toBeNull();
    expect(container.querySelector("[data-testid='plugins-ready']")).toBeNull();
  });

  test("points at the sync setting that usually explains it", () => {
    expect(panel(empty).textContent).toContain(".obsidian");
  });

  test("still offers the community catalog so the first managed plugin can be installed", () => {
    const container = panel(empty, undefined, {
      query: "",
      limit: 20,
      searching: false,
      failure: null,
      actions: {
        search: async () => {},
        install: async () => {},
        uninstall: async () => {},
        recover: async () => {},
      },
    });
    expect(container.querySelector("[data-testid='plugin-browse-closed']")).not.toBeNull();
    expect(container.textContent).toContain("Add a plugin");
  });
});

describe("the ready list", () => {
  test("the summary counts read as sentences, not as noun phrases", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("Runs here · 1");
    expect(text).toContain("Needs approval · 0");
    expect(text).toContain("Couldn't be checked · 1");
  });

  test("draws a group heading for every verdict present", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("Runs here");
    expect(text).toContain("Won't run here");
    expect(text).toContain("Couldn't be checked");
  });

  test("names the call rather than the category", () => {
    expect(opened(panel(READY), "obsidian-git").textContent).toContain("child_process");
  });

  /*
    Two sentences on that screen that nothing was holding.

    This file's own header states the property the move was supposed to keep:
    *"A sentence that stopped being rendered anywhere still fails here … the
    risk in a change like this is not that the words move, it is that they
    quietly stop existing and nothing notices."* Measured against the whole
    mobile suite, by deleting each line from `PluginDetail` in turn:

    | line removed from the detail screen | tests reddened |
    | --- | --- |
    | the named findings (`child_process — …`) | **3** |
    | **`Hosts it names: …`** | **0** |
    | **the manifest error** | **0** |
    | (for contrast) the consent card's own host list | **1** |

    Neither was a regression — both were unasserted on the panel before the
    move too, and the fixture above is why: no plugin in `READY` carries
    `hosts` or a `manifestError`, so those two branches had never rendered in
    a test at all. The claim was simply wider than the assertions under it,
    which is this repository's most-repeated finding pointed at its own suite.

    **What is NOT at stake, and it matters for how hard to lean on this:** the
    sentence somebody actually decides by is the consent card's own
    `It will be able to reach:` list, and that one *is* held (the 1 above).
    Nobody approves a plugin blind because of this. What these two lines are is
    the *account of the bundle* — what the scan read, what it could not — sitting
    above the control, and an account nothing checks is an account that can
    quietly stop being given.
  */
  const NAMES_HOSTS: PluginsView = {
    state: "ready",
    inventory: {
      found: 2,
      scanned: 2,
      truncated: false,
      checkedAt: "2026-09-12T09:41:00.000Z",
      plugins: [
        plugin({
          id: "weather-sidebar",
          name: "Weather Sidebar",
          verdict: "needs-approval",
          hosts: ["api.example-weather.test", "cdn.example-weather.test"],
        }),
        plugin({
          id: "broken-manifest",
          name: "Broken Manifest",
          verdict: "unknown",
          manifestError: "its manifest.json is not valid JSON",
        }),
      ],
    },
  };

  test("the hosts a plugin names survive to its screen", () => {
    const text = opened(panel(NAMES_HOSTS), "weather-sidebar").textContent ?? "";
    // Both, and by name: a list that rendered only its first entry would be a
    // reader told about one of the two servers a plugin reaches.
    expect(text).toContain("api.example-weather.test");
    expect(text).toContain("cdn.example-weather.test");
  });

  test("and so does the reason a manifest could not be read", () => {
    // The scan's own words, not a category. A plugin whose manifest did not
    // parse is `unknown` for a reason the reader can act on, and the group
    // heading cannot carry it because it is this plugin's alone.
    expect(opened(panel(NAMES_HOSTS), "broken-manifest").textContent ?? "").toContain(
      "its manifest.json is not valid JSON",
    );
  });

  test("every plugin that cannot run here is told where it still runs", () => {
    expect(opened(panel(READY), "obsidian-git").textContent).toContain(
      "Keep it in Obsidian — Context reads what it writes.",
    );
  });

  /*
    Same rule, stated once instead of three times — see `plugins.test.ts`. The
    screen still has to say it was not read rather than refused; it says so in
    the group heading and blurb, and the row carries the part they do not.
  */
  test("an unchecked plugin is told it was not read, and how much was", () => {
    // The group heading and blurb are on the list; the reading and the route
    // are the plugin's own, so they are on the plugin's own screen.
    expect(panel(READY).textContent ?? "").toContain("could not read these");
    const text = opened(panel(READY), "dataview").textContent ?? "";
    expect(text).toContain("could not read these");
    expect(text).toContain("512 KB of 1.8 MB read");
    expect(text).toContain("Run it in Obsidian meanwhile.");
  });

  test("the floor and the shared-notes scope both survive to the screen", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("floor, not a guarantee");
    expect(text).toContain(SCOPE_NOTE);
  });

  test("a truncated listing renders its count as a floor", () => {
    const text =
      panel({
        state: "ready",
        inventory: { ...READY.inventory, found: 47, scanned: 23, truncated: true },
      } as PluginsView).textContent ?? "";
    expect(text).toContain("47+");
    expect(text).toContain("23 of 47+ read");
  });

  test("an approved bundle is explicitly started rather than inferred to be running", async () => {
    const start = jest.fn(async () => {});
    const container = panel(
      READY,
      {
        loading: false,
        egress: false,
        grants: [{
          pluginId: "highlightr-plugin",
          bundleFingerprint: "fp-highlightr-plugin",
          capabilities: ["vault:read"],
          networkHosts: [],
          status: "active",
          grantedAt: 1,
          updatedAt: 1,
        }],
      },
      { query: "", limit: 20, searching: false, failure: null },
      { states: [], loading: false, actions: { start, stop: async () => {}, run: () => {} } },
    );
    /*
      An approval is not a start, and the switch is where that is now visible:
      it reads off on a plugin nobody has started, and pressing it is what
      starts one. The claim under test is unchanged — the console must not
      infer that an approved bundle is running.
    */
    const control = container.querySelector(
      "[data-testid='plugin-switch-highlightr-plugin']",
    ) as HTMLElement;
    expect(control).not.toBeNull();
    expect(control.getAttribute("aria-checked")).toBe("false");
    await act(async () => control.click());
    expect(start).toHaveBeenCalledWith("highlightr-plugin", "fp-highlightr-plugin");
    expect(container.textContent).not.toContain("Running");
  });

  test("a loaded bundle can be stopped without revoking its grant", async () => {
    const stop = jest.fn(async () => {});
    const container = panel(
      READY,
      {
        loading: false,
        egress: false,
        grants: [{
          pluginId: "highlightr-plugin",
          bundleFingerprint: "fp-highlightr-plugin",
          capabilities: ["vault:read"],
          networkHosts: [],
          status: "active",
          grantedAt: 1,
          updatedAt: 1,
        }],
      },
      { query: "", limit: 20, searching: false, failure: null },
      {
        states: [{
          pluginId: "highlightr-plugin",
          bundleFingerprint: "fp-highlightr-plugin",
          status: "loaded",
          attempts: 1,
          updatedAt: 1,
        }],
        loading: false,
        actions: { start: async () => {}, stop, run: () => {} },
      },
    );
    /*
      The row's own stop, not the detail screen's. A running plugin's row is the
      one place somebody reaches for this, and it was two presses away for as
      long as the control lived only on the card underneath.

      It is a switch rather than a button as of `pluginSwitch.test.ts`, which
      holds the rule about which presses are allowed to become one. What is
      asserted here is unchanged and is the part this file is for: the row
      itself can stop a running plugin, addressed by id and fingerprint.
    */
    const control = container.querySelector(
      "[data-testid='plugin-switch-highlightr-plugin']",
    ) as HTMLElement;
    expect(control.getAttribute("aria-checked")).toBe("true");
    await act(async () => control.click());
    expect(stop).toHaveBeenCalledWith("highlightr-plugin", "fp-highlightr-plugin");
    // What it is allowed to do is a question about consent, so it is on the
    // plugin's own screen rather than under every row in the list.
    expect(opened(container, "highlightr-plugin").textContent).toContain("Allowed to");
  });
});

/*
  REACHING THE REGISTRY IS NOT PART OF READING SOMEBODY'S VAULT.

  Reported from the shipped app: "one of these sessions was supposed to build a
  place to search through existing obsidian plugins — I only see a way to search
  context.lc native plugins." The feature was built and merged, and it was
  unreachable in the state most people are in.

  `PluginBrowse` was rendered in two of the vault section's six outcomes —
  `found: 0` and `ready`. Every other state returns early, and **`idle` is the
  default**: nobody has pressed "Read my plugins" yet. So a first visit offered
  no registry at all, leaving only the panel's own search box, which filters the
  local lists. That is precisely what was seen.

  The panel's header comment already argued the general form of this — the
  Context block sits "outside every one of the vault block's states" so that the
  vault half's "refusals and its empty state no longer take the built-ins down
  with them". Browsing a third party's list is not a read of `.obsidian/`
  either, so it was the same mistake left half-done.

  The suite was green throughout, which is the part worth keeping: nothing
  asserted the affordance was reachable, so nothing failed when it was not.
*/
describe("adding a plugin does not depend on the vault scan", () => {
  const BROWSABLE: BrowseView = {
    query: "",
    limit: 20,
    searching: false,
    failure: null,
    actions: {
      search: async () => {},
      install: async () => {},
      uninstall: async () => {},
      recover: async () => {},
    },
  };

  const EMPTY: PluginsView = {
    state: "ready",
    inventory: {
      found: 0,
      scanned: 0,
      truncated: false,
      checkedAt: "2026-09-12T09:41:00.000Z",
      plugins: [],
    },
  };

  const reachable = (view: PluginsView) =>
    panel(view, undefined, BROWSABLE).querySelector("[data-testid='plugin-browse-closed']") !== null;

  /*
    `idle` is the one that shipped broken and the one a first visit lands on.
    The others are here because each was an early return too, and a fix that
    only covered the default would leave somebody whose scan failed with the
    same nothing.
  */
  test("the default state — nobody has read their vault yet — still offers the registry", () => {
    expect(reachable({ state: "idle" })).toBe(true);
  });

  test("a scan in flight does not hide it", () => {
    expect(reachable({ state: "loading" })).toBe(true);
  });

  test("a scan that failed does not hide it — the registry is not in that bucket", () => {
    expect(reachable({ state: "failed", reason: "storage: 403" })).toBe(true);
  });

  test("a vault with no plugins offers it", () => {
    expect(reachable(EMPTY)).toBe(true);
  });

  test("a vault full of plugins offers it", () => {
    expect(reachable(READY)).toBe(true);
  });

  /*
    The card moved, and what it knows had to move with it.

    A registry row says what installing it would mean *for this bucket* — a
    plugin already in the vault says so rather than offering a second, managed
    copy. That depends on the card being handed the inventory, which it used to
    read from the branch it was rendered inside. Nothing else here would notice
    if the refactor had quietly started passing an empty list to a scan that has
    one.
  */
  test("a plugin already in the vault is still known to be there", () => {
    const container = panel(READY, undefined, {
      ...BROWSABLE,
      results: [{
        id: "highlightr-plugin",
        name: "Highlightr",
        author: "chetachi",
        description: "Highlight text in colour.",
        repository: "chetachi/obsidian-highlightr-plugin",
      }],
      query: "highlightr",
    });
    act(() => {
      const browseButton = [...container.querySelectorAll("[role='button']")]
        .find((one) => (one.textContent ?? "").includes("Browse")
          || (one.textContent ?? "").startsWith("Search for"));
      browseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("In your vault");
  });

  /*
    The one state that shows nothing, and it is `actions` that decides rather
    than the state. A non-owner cannot install, so `useLifecycle` hands them no
    actions and `PluginBrowse` draws nothing of its own accord — which is why
    the fix needs no special case for `withheld`, and why this asserts the
    real pairing rather than the impossible one (an owner looking at an
    inventory withheld from them).
  */
  test("a non-owner is offered nothing, because they have no actions rather than because of the state", () => {
    const withheld = panel({ state: "withheld" }, undefined, {
      query: "", limit: 20, searching: false, failure: null,
    });
    expect(withheld.querySelector("[data-testid='plugin-browse-closed']")).toBeNull();
  });

  /*
    The top box seeds the registry search, and that has to survive the card
    moving. Without it the button reads "Browse" in a panel where somebody has
    already typed what they are looking for.
  */
  test("what was typed upstairs still seeds the registry search, from a state that had no card before", () => {
    const container = panel({ state: "idle" }, undefined, BROWSABLE);
    const box = container.querySelector("[data-testid='plugins-query']") as HTMLInputElement | null;
    if (box === null) throw new Error("no search box");
    /*
      React tracks an input's value on the node and ignores an event whose value
      it believes it already set, so the native setter is what makes this a real
      change rather than a no-op — the idiom `pluginBrowse.test.ts` uses.
    */
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(box, "kanban");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain('Search for "kanban"');
  });
});

/*
  The five-line wall, in the panel this time.

  `plugins.test.ts` holds the counting rule; this holds that the row actually
  uses it — and, more to the point, that pressing the count still gets you every
  sentence. A collapse that quietly dropped the detail would be the opposite of
  what the limitations are for.
*/
describe("a column of limitations collapses to a line you can open", () => {
  const WORDY: PluginsView = {
    state: "ready",
    inventory: {
      found: 1,
      scanned: 1,
      truncated: false,
      checkedAt: "2026-09-12T09:41:00.000Z",
      plugins: [plugin({
        id: "youversion-linker",
        name: "YouVersion Linker",
        verdict: "needs-approval",
        limitations: [
          "Not yet, so that part will not work: a plugin's own settings pane is accepted and not drawn yet.",
          "Not yet, so that part will not work: rendering a plugin's markdown output is accepted and not drawn yet.",
          "Not yet, so that part will not work: editor decorations are accepted and not applied yet.",
          "Not yet, so that part will not work: in-editor suggestions are not wired yet.",
          "Not yet, so that part will not work: the icon set is not exposed to plugins yet.",
        ],
      })],
    },
  };

  test("the five lines are one line until somebody asks", () => {
    const container = opened(panel(WORDY), "youversion-linker");
    expect(container.textContent).toContain("5 limits on what this one does here");
    expect(container.textContent).not.toContain("the icon set is not exposed");
  });

  test("opening it gives every sentence back, unedited", () => {
    const container = opened(panel(WORDY), "youversion-linker");
    const toggle = [...container.querySelectorAll("[role='button']")]
      .find((one) => (one.textContent ?? "").includes("5 limits"));
    expect(toggle).toBeDefined();
    act(() => { toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("the icon set is not exposed to plugins yet");
    expect(container.textContent).toContain("in-editor suggestions are not wired yet");
  });

  test("a plugin with two limitations still shows them outright", () => {
    const brief: PluginsView = {
      ...WORDY,
      inventory: {
        ...WORDY.state === "ready" ? WORDY.inventory : ({} as never),
        plugins: [plugin({
          id: "brief",
          verdict: "runs",
          limitations: ["Not yet: one thing.", "Not yet: another thing."],
        })],
      },
    };
    const container = opened(panel(brief), "brief");
    expect(container.textContent).toContain("Not yet: one thing.");
    expect(container.textContent).not.toContain("limits on what this one does here");
  });
});

describe("a row leads with what the plugin is for", () => {
  test("the author's sentence is on the card", () => {
    const container = panel({
      state: "ready",
      inventory: {
        found: 1,
        scanned: 1,
        truncated: false,
        checkedAt: "2026-09-12T09:41:00.000Z",
        plugins: [plugin({
          id: "youversion-linker",
          name: "YouVersion Linker",
          verdict: "needs-approval",
          description: "Automatically link bible verses in your notes to YouVersion bible.",
        })],
      },
    });
    expect(opened(container, "youversion-linker").textContent).toContain(
      "Automatically link bible verses in your notes to YouVersion bible.",
    );
  });

  test("a plugin whose manifest says nothing gets no empty line", () => {
    const container = panel({
      state: "ready",
      inventory: {
        found: 1,
        scanned: 1,
        truncated: false,
        checkedAt: "2026-09-12T09:41:00.000Z",
        plugins: [plugin({ id: "quiet", name: "Quiet", verdict: "runs", description: "" })],
      },
    });
    expect(opened(container, "quiet").querySelector("[data-testid='plugin-blurb-quiet']")).toBeNull();
  });
});

/*
  WHAT IS INSTALLED, BEFORE ANYBODY HAS SCANNED.

  The reported bug: install a plugin, come back tomorrow, and the panel that
  installs plugins names none of them. The install had persisted; the panel
  rested at "check my plugins" and nothing had ever read the bucket back. People
  reasonably concluded the install had not stuck — and, since every sentence on
  this panel talked about `.obsidian/`, that Context only ever looks there.

  Four checks, and the first is the bug: the names are on the screen with no
  press. The rest are the ways this could have been "fixed" into a new lie —
  claiming a verdict the scan has not reached, drawing an empty list over a read
  that failed, and telling somebody nothing is installed when the read never
  happened.
*/
describe("what Context has installed, before a scan", () => {
  const INSTALLED: ManagedInstallsView = {
    state: "ready",
    truncated: false,
    read: async () => {},
    installs: [
      { id: "obsidian-bible-reference", version: "26.08.07", repository: "tim-hub/x" },
      { id: "half-written", version: null, repository: null },
    ],
  };

  test("an install is named on arrival, with nothing pressed", () => {
    const container = panel({ state: "idle" }, undefined, undefined, undefined, undefined, INSTALLED);
    const card = container.querySelector("[data-testid='plugins-installed']");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("obsidian-bible-reference 26.08.07");
    expect(card?.textContent).toContain("2 installed by Context");
  });

  test("and no verdict is claimed for it, because none has been reached", () => {
    const container = panel({ state: "idle" }, undefined, undefined, undefined, undefined, INSTALLED);
    const card = container.querySelector("[data-testid='plugins-installed']");
    // The scan's vocabulary, none of which this read is entitled to.
    for (const word of ["Runs here", "Won't run", "Needs approval", "couldn't be checked"]) {
      expect(card?.textContent ?? "").not.toContain(word);
    }
  });

  test("a pointer naming no release is shown as unfinished rather than as a version", () => {
    const container = panel({ state: "idle" }, undefined, undefined, undefined, undefined, INSTALLED);
    const card = container.querySelector("[data-testid='plugins-installed']");
    expect(card?.textContent).toContain("half-written");
    expect(card?.textContent).toContain("Unfinished");
  });

  test("a read that failed says so rather than drawing an empty list", () => {
    const container = panel(
      { state: "idle" },
      undefined,
      undefined,
      undefined,
      undefined,
      { state: "failed", reason: "the bucket refused the listing", read: async () => {} },
    );
    expect(container.querySelector("[data-testid='plugins-installed']")).toBeNull();
    const failed = container.querySelector("[data-testid='plugins-installed-failed']");
    expect(failed?.textContent).toContain("the bucket refused the listing");
    // The sentence that stops a storage failure reading as "nothing installed".
    expect(failed?.textContent).toContain("only that the list could not be read");
  });

  test("once the scan has run the list is not drawn twice", () => {
    const container = panel(
      READY,
      undefined,
      undefined,
      undefined,
      undefined,
      INSTALLED,
    );
    expect(container.querySelector("[data-testid='plugins-installed']")).toBeNull();
  });

  /*
    The half that made people press Install twice. `PluginBrowse` decides the
    verb from what it is told is installed, and with no scan it used to be told
    nothing.
  */
  test("a registry row for something already installed offers an update, not an install", async () => {
    const container = panel(
      { state: "idle" },
      undefined,
      {
        query: "",
        limit: 20,
        searching: false,
        failure: null,
        results: [{
          id: "obsidian-bible-reference",
          name: "Bible Reference",
          author: "tim-hub",
          description: "Verses",
          repository: "tim-hub/x",
        }],
        actions: {
          search: async () => {},
          install: async () => {},
          uninstall: async () => {},
          recover: async () => {},
        },
      },
      undefined,
      undefined,
      INSTALLED,
    );
    act(() => {
      container
        .querySelector("[data-testid='plugin-browse-open']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const browse = container.querySelector("[data-testid='plugin-browse']");
    expect(browse?.textContent).toContain("Update to the latest release");
  });
});
