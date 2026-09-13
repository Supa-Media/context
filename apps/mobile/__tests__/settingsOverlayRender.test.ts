/**
 * @jest-environment jsdom
 */

/**
 * The settings overlay, actually rendered.
 *
 * Everything else about this feature is covered by pure functions — the
 * section catalogue, the URL parsing — and two adversarial reviews made the
 * same point about that: with only those, whole limbs of the feature can be
 * deleted and the suite stays green. Mutations that were green before this
 * file existed:
 *
 *  - `const show = () => true` in `SettingsPane` — every section renders the
 *    whole scroll again, and sectioning is gone;
 *  - swapping which block `show("email")` and `show("search")` guard —
 *    sections render each other's content;
 *  - making the section list's `onSelect` a no-op — the list stops navigating;
 *  - `Overlay`'s compact branch dropping `children` — no settings content is
 *    reachable on a phone at all, which is a bug that actually shipped in this
 *    PR's first commit and was found by reading rather than by testing.
 *
 * So this asserts the three things that are the feature: one section at a
 * time, the list moves between them, and the phone reaches content rather than
 * only a menu.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The whole of `convex/react` that any settings panel reaches for, not just
  `useAction`.

  Two sections could not be mounted at all until this grew: `DevicesPanel`
  calls `useConvexAuth` and `PremiumPanel` calls `useConvex`, and a narrower
  mock meant the sweep below could not even *render* the two screens whose
  headings it was written to check. Each stub answers the way an unauthorised,
  clientless console does, which is the state these panels already handle.
*/
jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import { SharedLinksPanel } from "../features/console/settings/panels/SharedLinksPanel";
import { AdvancedPanel } from "../features/console/settings/panels/AdvancedPanel";
import type { ConsoleData } from "../features/console/types";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "../features/console/settings/sections";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/** The demo console, resolved before mounting — an `act` inside an `act` never flushes. */
function demoData(): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  if (data === null) throw new Error("the demo console did not resolve");
  return data;
}

/**
 * Mounts and hands back `document.body`, not the container.
 *
 * `Modal` on react-native-web renders through a portal appended to the body,
 * so the mount container is empty — asserting against it would have been a
 * test that passes on an overlay that draws nothing.
 */
function overlay(
  section: SettingsSectionKey,
  onSelect: (next: SettingsSectionKey) => void = () => {},
  onDismiss: () => void = () => {},
  extra: Partial<Parameters<typeof SettingsOverlay>[0]> = {},
): HTMLElement {
  /*
    The demo console has no `deleteAccount` and no `invitations` — it is the
    landing page's data, where there is no account to act on. Supplying both
    here is what lets these assert the *controls* rather than the headings
    around them: an account section whose card never renders still prints its
    own title, so "the heading is there" passed on a screen with nothing on it.
  */
  const data: ConsoleData = {
    ...demoData(),
    deleteAccount: async () => {},
    invitations: [{ slug: "tomi", token: "invite-token" }],
  };
  mount(() =>
    createElement(SettingsOverlay, { data, section, onSelect, onDismiss, ...extra }),
  );
  return document.body;
}

/*
  jsdom reports a viewport width of 0, so every mount here takes `Overlay`'s
  **compact** branch. That is the right half to spend a render test on: the
  wide branch shows the list and the content together, where a mistake is
  visible, while compact shows one at a time — and the bug that actually
  shipped in this PR's first commit was compact rendering the list forever and
  the settings never.
*/

describe("a phone reaches the settings, not just a menu", () => {
  test("opens on the section, because that is what was asked for", () => {
    // The regression: `sidebar ?? children` with a sidebar always supplied
    // meant no section content was reachable below 880pt at all.
    const text = overlay("search").textContent ?? "";
    expect(text).toContain("Where this context");
  });

  test("one section at a time — search is not storage", () => {
    const text = overlay("search").textContent ?? "";
    expect(text).not.toContain("Your bucket, your credentials");
  });

  test("and storage is not search", () => {
    const text = overlay("storage").textContent ?? "";
    expect(text).toContain("Your bucket, your credentials");
    expect(text).not.toContain("Where this context");
  });

  test("overview answers which context this is before anything else", () => {
    const text = overlay("overview").textContent ?? "";
    expect(text).toContain("Overview");
    expect(text).toContain("Personal workspace");
  });

  test("people is in the context's own settings, not an app-level pane", () => {
    expect(overlay("people").textContent ?? "").toContain("People");
  });

  test("shared links lists what the demo console has shared, revoke and all", () => {
    // The demo has no `shares.actions`, so a real Revoke button must never
    // appear here — only the arming label with nothing behind it would be a
    // demo console pretending to act.
    const host = overlay("shares");
    const text = host.textContent ?? "";
    expect(text).toContain("Shared links");
    expect(text).toContain("1-projects/board-update.md");
    expect(host.querySelector('[data-testid^="share-revoke-"]')).toBeNull();
  });

  test("shares is not people, and people is not shares", () => {
    expect(overlay("people").textContent ?? "").not.toContain("Shared links");
    expect(overlay("shares").textContent ?? "").not.toContain("Nobody has access");
  });

  test("advanced shows the audit trail and offers no key export in the demo", () => {
    const host = overlay("advanced");
    const text = host.textContent ?? "";
    expect(text).toContain("Audit trail");
    expect(text).toContain("Encryption keys");
    expect(host.querySelector('[data-testid="advanced-export-keys"]')).toBeNull();
  });

  test("the binding's health is stated, since no storage chip exists here", () => {
    // `PaneHead` is skipped when a section is given, and the top bar's chip is
    // pointer-only — so without the overlay carrying this, a phone states the
    // health of the bucket nowhere.
    expect(overlay("storage").textContent ?? "").toContain("Connected");
  });
});

describe("the account's own settings have a home", () => {
  test("AI apps is reachable and is about apps, not this context", () => {
    const text = overlay("apps").textContent ?? "";
    expect(text).toContain("AI apps");
    // No context badge and no binding health: an account section wearing a
    // context chip would be naming a scope it is not in.
    expect(text).not.toContain("Your bucket, your credentials");
  });

  test("both ways out of a session are controls, not headings", () => {
    let signedOut = 0;
    const host = overlay("account", () => {}, () => {}, {
      onSignOut: () => {
        signedOut += 1;
      },
    });
    const remove = host.querySelector('[data-testid="delete-account"]');
    const out = host.querySelector('[data-testid="settings-sign-out"]');
    expect(remove).not.toBeNull();
    expect(out).not.toBeNull();
    // Sign-out used to be a glyph in the rail and nothing else, so somebody
    // searching for it landed on the one screen that can end an account.
    act(() => {
      (out as HTMLElement).click();
    });
    expect(signedOut).toBe(1);
  });

  test("an invitation is a live row, and answering it navigates", () => {
    const tokens: string[] = [];
    const host = overlay("invitations", () => {}, () => {}, {
      onOpenInvitation: (token) => tokens.push(token),
    });
    const row = host.querySelector('[data-testid="settings-invitation-tomi"]');
    expect(row).not.toBeNull();
    act(() => {
      (row as HTMLElement).click();
    });
    expect(tokens).toEqual(["invite-token"]);
  });

  test("profile states the name and does not pretend it can be changed", () => {
    expect(overlay("profile").textContent ?? "").toContain("Profile");
  });
});

describe("the search box", () => {
  test("narrows the list to what somebody typed", () => {
    const host = overlay("overview");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const field = host.querySelector('[data-testid="settings-search"]') as HTMLInputElement;
    expect(field).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "gmail");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const text = host.textContent ?? "";
    // Email is where Gmail lives, and it is not the only row it could have
    // been: a mailbox reaches a workspace through a Google account *or* through
    // the forwarding address, which is why those are one section rather than
    // two. What the box has to do is land on it from the word people type.
    expect(text).toContain("Email");
    expect(text).not.toContain("Delete account");
  });
});

describe("the list is one press away, and it navigates", () => {
  test("back reveals every section", () => {
    const host = overlay("storage");
    const back = host.querySelector('[data-testid="settings-overlay-back"]');
    expect(back).not.toBeNull();
    act(() => {
      (back as HTMLElement).click();
    });
    const text = host.textContent ?? "";
    for (const label of [
      "Overview",
      "People",
      "Shared links",
      "Storage",
      "Search",
      "Advanced",
      "Email",
      "Calendar",
      "Chats",
      "Meetings",
    ]) {
      expect(text).toContain(label);
    }
  });

  test("pressing a section asks for that section", () => {
    const chosen: string[] = [];
    const host = overlay("storage", (next) => chosen.push(next));
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const row = host.querySelector('[data-testid="settings-section-search"]');
    expect(row).not.toBeNull();
    act(() => {
      (row as HTMLElement).click();
    });
    expect(chosen).toEqual(["search"]);
  });

  test("closing asks to close, rather than navigating", () => {
    let closed = 0;
    const host = overlay("storage", () => {}, () => {
      closed += 1;
    });
    const close = host.querySelector('[data-testid="settings-overlay-close"]');
    expect(close).not.toBeNull();
    act(() => {
      (close as HTMLElement).click();
    });
    expect(closed).toBe(1);
  });
});

describe("the list is the context switcher too", () => {
  /*
    The old list was the *selected* context's sections and nothing else, so
    changing a workspace's storage meant closing settings, switching contexts
    in the rail, and opening settings again — on a phone, three screens away
    from a setting the person was already looking at the name of.
  */
  function list(onSwitchContext: (slug: string) => void) {
    const host = overlay("overview", () => {}, () => {}, { onSwitchContext });
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    return host;
  }

  test("every context this person can reach is a row", () => {
    const host = list(() => {});
    for (const slug of ["seyi", "lk", "public-worship"]) {
      expect(host.querySelector(`[data-testid="settings-context-${slug}"]`)).not.toBeNull();
    }
  });

  test("pressing another context asks to switch to it", () => {
    const asked: string[] = [];
    const host = list((slug) => asked.push(slug));
    act(() => {
      (
        host.querySelector('[data-testid="settings-context-public-worship"]') as HTMLElement
      ).click();
    });
    expect(asked).toEqual(["public-worship"]);
  });

  test("pressing the context you are already in is not a navigation", () => {
    const asked: string[] = [];
    const host = list((slug) => asked.push(slug));
    act(() => {
      (host.querySelector('[data-testid="settings-context-seyi"]') as HTMLElement).click();
    });
    expect(asked).toEqual([]);
  });

  test("only the open context carries its sections", () => {
    const host = list(() => {});
    // Two contexts' worth of Storage rows in one list is two answers to "what
    // is my bucket", which is the question the row is there to settle.
    expect(host.querySelectorAll('[data-testid="settings-section-storage"]')).toHaveLength(1);
  });
});


/**
 * The redesign, in the four claims that are the whole of it.
 *
 * Every one of these was green before this block existed, which is the same
 * complaint this file's header opens with: the list rendered, the sections
 * navigated, and none of that noticed that nineteen rows said nothing about
 * what they were set to, or that the section's name was drawn twice.
 *
 * Mutations these catch, and the old suite did not:
 *
 *  - `settingsPreview` returning `null` for everything — the rows go back to
 *    being labels, and the reason for the whole change is gone;
 *  - the scope chips moving back below the sections, or the sections nesting
 *    inside a context row again;
 *  - `Overlay` rendering `title` on a phone's section screen again;
 *  - a second row lit at the same time as the section, which is what the two
 *    stacked highlight bands were.
 */
describe("a row says what it is set to", () => {
  test("Storage carries the bucket it is bound to, in the list", () => {
    const host = overlay("overview");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const row = host.querySelector('[data-testid="settings-section-storage"]');
    expect(row).not.toBeNull();
    /*
      The demo binds a bucket, so this is the real label rather than an
      absence. `storagePillLabel` builds it, and its own tests pin the string
      — what this pins is that the *row* carries it, which is the difference
      between a list of destinations and a list of answers.
    */
    expect(row!.textContent ?? "").toContain("Storage");
    expect((row!.textContent ?? "").replace("Storage", "").trim()).not.toBe("");
  });

  test("a row with nothing to say carries only its label", () => {
    // Meetings has no persisted state to report, by design — so the row must
    // not invent one. See `settingsPreview`'s header for the three absences
    // this protects.
    const host = overlay("overview");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const row = host.querySelector('[data-testid="settings-section-meetings"]');
    expect(row).not.toBeNull();
    expect((row!.textContent ?? "").trim()).toBe("Meetings");
  });
});

describe("the contexts are a scope bar above the sections", () => {
  function listed(host: HTMLElement, selector: string): number {
    const node = host.querySelector(selector);
    if (node === null) throw new Error(`no ${selector}`);
    // Document order, which is what "above" means to a reader and to a
    // screen reader both.
    return Array.prototype.indexOf.call(host.querySelectorAll("*"), node);
  }

  test("every context comes before the first section row", () => {
    const host = overlay("overview");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const firstSection = listed(host, '[data-testid^="settings-section-"]');
    for (const slug of ["seyi", "lk", "public-worship"]) {
      expect(listed(host, `[data-testid="settings-context-${slug}"]`)).toBeLessThan(firstSection);
    }
  });

  test("one thing is lit at a time", () => {
    /*
      The open context used to wear `surface3` and its open section
      `accentDim`, stacked directly on top of each other — the old
      `contextOn`/`rowOn` pair, whose comment worried the two "read as one
      selection spanning both". With the contexts lifted out there is one
      selection left, and this is what says so.
    */
    const host = overlay("storage");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const selected = host.querySelectorAll('[data-testid^="settings-section-"][aria-current="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute("data-testid")).toBe("settings-section-storage");

    /*
      `aria-current` rather than `aria-selected`, and that is the assertion
      rather than an incidental choice of selector: react-native-web drops
      `accessibilityState={{ selected }}` for `role="button"`, so a test
      reading `aria-selected` here would have passed on a list that announced
      nothing. Checked against the rendered DOM before this was written.
    */
    const chips = host.querySelectorAll('[data-testid^="settings-context-"][aria-current="true"]');
    expect(chips).toHaveLength(1);
  });
});

describe("the section is named once", () => {
  test("a phone's title bar does not repeat the heading below it", () => {
    /*
      `Overlay`'s bar used to draw `chosen.label`, and `PanelHead` draws the
      same word as the panel's title twenty-four points underneath — about
      seventy points of the first screenful spent restating a word already on
      it. The bar names where Back goes instead.
    */
    const host = overlay("overview");
    const headings = Array.from(host.querySelectorAll('[role="heading"]')).map(
      (node) => node.textContent ?? "",
    );
    expect(headings.filter((text) => text === "Overview")).toHaveLength(1);
    expect(headings).not.toContain("Settings");

    // And the way back is named, not a bare chevron.
    const back = host.querySelector('[data-testid="settings-overlay-back"]');
    expect(back?.textContent ?? "").toContain("Settings");
  });

  test("the list screen is titled, because nothing under it is", () => {
    const host = overlay("overview");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const headings = Array.from(host.querySelectorAll('[role="heading"]')).map(
      (node) => node.textContent ?? "",
    );
    expect(headings).toContain("Settings");
  });
});

describe("Overview answers rather than listing properties", () => {
  test("the bucket, whether it is working, and when anybody last checked", () => {
    const host = overlay("overview");
    const strip = host.querySelector('[data-testid="overview-health"]');
    expect(strip).not.toBeNull();
    // The word the old title-bar pill carried, now beside the thing it is a
    // claim about.
    expect(strip!.textContent ?? "").toContain("Connected");
  });

  test("each fact is the way into the section that changes it", () => {
    const chosen: string[] = [];
    const host = overlay("overview", (next) => chosen.push(next));
    const fact = host.querySelector('[data-testid="overview-fact-privacy"]');
    expect(fact).not.toBeNull();
    act(() => {
      (fact as HTMLElement).click();
    });
    expect(chosen).toEqual(["privacy"]);
  });

  test("the role is a sentence about you, not a lower-cased enum", () => {
    const host = overlay("overview");
    const identity = host.querySelector('[data-testid="overview-identity"]');
    expect(identity).not.toBeNull();
    const text = identity!.textContent ?? "";
    expect(text).toContain("Personal workspace");
    expect(text).toContain("you're the owner");
    // `owner`, printed straight off the wire, is what this replaced.
    expect(text).not.toMatch(/\bowner\b(?!s)(?<!the owner)/);
  });
});


describe("every section names itself exactly once", () => {
  /*
    A sweep rather than a sample, because the defect this catches is a whole
    *class* and a spot check is how nine screens of it survived being written.

    Removing the compact title bar's `title` took away the only heading a
    phone's section screen had, and the replacement went into `PanelHead` —
    which nine sections did not use. Measured in jsdom before this was
    written: groups, privacy, apps, profile, invitations, appearance,
    account, devices and premium each returned zero headings, and `groups`
    had no section title of any kind, so its name survived only as a row
    title inside a card.

    "Exactly one" rather than "at least one" is the other half of the change:
    a bar titled "Overview" over a panel titled "Overview" is what this
    started as.
  */
  test.each(SETTINGS_SECTIONS.map((entry) => [entry.key, entry.label] as const))(
    "%s",
    (key, label) => {
      const host = overlay(key);
      const headings = Array.from(host.querySelectorAll('[role="heading"]')).map(
        (node) => node.textContent ?? "",
      );
      expect(headings).toEqual([label]);
    },
  );
});

/**
 * A `SettingsOverlay` whose `data` is genuinely live.
 *
 * `overlay()` above snapshots `useDemoConsoleData()` **once** and hands that
 * frozen object to a `SettingsOverlay` mounted separately — which is exactly
 * right for asserting a callback fired (the tests above), and wrong for
 * asserting the screen updates: the two trees share no state, so pressing a
 * context row there proves the click reached `onSwitchContext` and nothing
 * about what got drawn afterwards. This wires them into one component
 * instead, so calling `.selectContext(...)` on the object it returns causes a
 * real re-render with the new context's own `shares` and `advanced` already
 * in the `data` the overlay is holding.
 */
function liveOverlay(section: SettingsSectionKey): {
  host: HTMLElement;
  data: () => ConsoleData;
} {
  let latest: ConsoleData | null = null;
  function Harness() {
    const data = useDemoConsoleData();
    latest = data;
    return createElement(SettingsOverlay, {
      data,
      section,
      onSelect: () => {},
      onDismiss: () => {},
    });
  }
  mount(() => createElement(Harness));
  return {
    host: document.body,
    data: () => {
      if (latest === null) throw new Error("the demo console did not resolve");
      return latest;
    },
  };
}

/**
 * The isolation `useLiveConsoleData`'s `selectedContextId` derivation already
 * carries — proven the security-relevant way, at the query layer, elsewhere —
 * has no equivalent guard at the rendering layer for these two new sections.
 * Cheap to lose silently: `shares`/`advanced` keyed by the wrong id, or a
 * stale closure over the previously-selected context, would show one
 * context's rows on another's screen and nothing here would say so.
 */
describe("a section follows the context it belongs to, not the one beside it", () => {
  test("a shared link belongs to the context that has it, not the one beside it", () => {
    const { host, data } = liveOverlay("shares");
    // @seyi is selected first, by `useDemoConsoleData`'s own default.
    expect(host.textContent ?? "").toContain("1-projects/board-update.md");
    expect(host.textContent ?? "").not.toContain("1-projects/roadmap.md");

    act(() => {
      data().selectContext("pw");
    });

    const text = host.textContent ?? "";
    expect(text).toContain("1-projects/roadmap.md");
    expect(text).not.toContain("1-projects/board-update.md");
  });

  test("an audit row belongs to the context that recorded it, not the one beside it", () => {
    const { host, data } = liveOverlay("advanced");
    expect(host.textContent ?? "").toContain("1-projects/board-update.md");
    expect(host.textContent ?? "").not.toContain("1-projects/roadmap.md");

    act(() => {
      data().selectContext("pw");
    });

    const text = host.textContent ?? "";
    expect(text).toContain("1-projects/roadmap.md");
    expect(text).not.toContain("1-projects/board-update.md");
  });
});

/**
 * `readOnlyReason` for a non-owner, on both panels directly.
 *
 * Neither the demo console nor any test above ever builds a `SharesView` or
 * an `AuditView` with `actions`/rows absent and `readOnlyReason` set — the
 * demo shows every section's content regardless of the viewed context's role,
 * the same way `DEMO_MEMBERS` always renders. So the sentence a real
 * non-owner is shown had nothing exercising it: dropping it silently renders
 * an empty card with no explanation, and nothing above would have noticed.
 */
describe("what a non-owner is told instead of the controls", () => {
  test("shared links: the reason stands in for the missing Revoke", () => {
    const container = mount(() =>
      createElement(SharedLinksPanel, {
        view: {
          shares: [],
          actions: undefined,
          loading: false,
          failure: null,
          readOnlyReason: "Only an owner of this context can see or revoke the links shared from it.",
        },
      }),
    );
    expect(container.textContent ?? "").toContain(
      "Only an owner of this context can see or revoke the links shared from it.",
    );
  });

  test("advanced: the reason stands in for the missing audit trail", () => {
    const container = mount(() =>
      createElement(AdvancedPanel, {
        view: {
          moves: { jobs: [], loading: false, failure: null },
          audit: {
            events: [],
            loading: false,
            failure: null,
            readOnlyReason: "Only an owner of this context can see its audit trail.",
          },
          keyExport: undefined,
        },
      }),
    );
    expect(container.textContent ?? "").toContain(
      "Only an owner of this context can see its audit trail.",
    );
  });

  test("advanced: a durable move shows its measured phase and percentage", () => {
    const container = mount(() =>
      createElement(AdvancedPanel, {
        view: {
          moves: {
            jobs: [{
              jobId: "job-1",
              status: "running",
              phase: "copying",
              completed: 400,
              total: 500,
              updatedAt: 0,
            }],
            loading: false,
            failure: null,
          },
          audit: { events: [], loading: false, failure: null },
          keyExport: undefined,
        },
      }),
    );
    expect(container.textContent ?? "").toContain("Copying safely · 400 of 500 · 80%");
    expect(container.querySelector('[data-testid="durable-move-progress"]')).not.toBeNull();
  });
});
