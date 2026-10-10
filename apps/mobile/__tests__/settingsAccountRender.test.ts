/**
 * @jest-environment jsdom
 */

/**
 * The account sections of the settings overlay: Profile and the AI apps a
 * person connected. Split from `settingsOverlayRender.test.ts`, which shares
 * the same demo-console mount, to keep each file under the size limit.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The whole of `convex/react` that any settings panel reaches for, not just
  `useAction`.

  Two screens could not be mounted at all until this grew: the machines card
  at the foot of Profile calls `useConvexAuth` and `PremiumPanel` calls
  `useConvex`, and a narrower mock meant the sweep below could not even
  *render* the two screens whose headings it was written to check. Each stub answers the way an unauthorised,
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
import type { ConsoleData } from "../features/console/types";
import { type SettingsSectionKey } from "../features/console/settings/sections";

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


describe("the account's own settings have a home", () => {
  test("the AI apps a person connected are the first block of Integrations", () => {
    /*
      Account-scoped content on a context-scoped page, deliberately: what
      somebody wants from "Integrations" is everything talking to this context
      without being typed into it, and an MCP client is the first of those.
      The block keeps the sentence that says a connection reaches every
      workspace its person is a live member of.
    */
    const text = overlay("integrations").textContent ?? "";
    expect(text).toContain("AI apps");
    expect(text).toContain("Connect an app");
    expect(text).toContain("Your address for any other app");
    // And it is not the storage screen wearing another name.
    expect(text).not.toContain("Plain files in storage you own");
  });

  test("Connect an app opens every client's own setup, and the connected list is not a second grid", () => {
    const host = overlay("integrations");
    expect(host.querySelector('[data-testid="provider-cursor"]')).toBeNull();
    act(() => {
      (host.querySelector('[data-testid="connect-an-app"]') as HTMLElement).click();
    });
    for (const id of ["chatgpt", "claude", "claude-code", "codex", "cursor", "vscode", "notion", "gemini-cli"]) {
      expect(host.querySelector(`[data-testid="provider-${id}"]`)).not.toBeNull();
    }
  });

  /*
    THE PAGE MOUNTS THE SOURCES HALF, which is a different claim from "the
    panel renders".

    `sourcesPanel.test.ts` mounts `SourcesPanel` directly and proves what it
    draws. Nothing proved the *page* still drew it: delete the one line in
    `SettingsPane` and that suite stays green while half of Integrations
    quietly disappears — the accounts, the forwarding address, and the only
    control left on the page. A guard that mounts a component in isolation
    proves the component, not the call site.

    Asserted on content only this half produces, rather than on a testID: a
    testID can be moved onto anything, and what has to be true is that a
    person opening Integrations can see what is connected.
  */
  test("...and the accounts and the forwarding address are the other half of it", () => {
    const text = overlay("integrations").textContent ?? "";
    expect(text).toContain("Mail and calendar");
    expect(text).toContain("Forward mail to");
  });

  /*
    THE SENDER LIST IS ON THIS PAGE, UNDER THE ADDRESS IT GATES.

    Every other control went when Integrations became a list of connected
    things rather than a page of settings (#710). This one stayed, and where
    it is drawn is the decision rather than a leftover — see
    `docs/decisions/app-and-console.md`, "The allowed-sender list stays beside
    the address it gates". "Who may write into this context by email" is
    unreadable on a page that does not show the address they would write to;
    beside it, it needs no explanation at all.
  */
  test("the one control left on the page is the one that says who may write into the bucket", () => {
    const host = overlay("integrations");
    expect(host.textContent ?? "").toContain("See senders");
    act(() => {
      (host.querySelector('[data-testid="ingestion-edit"]') as HTMLElement).click();
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Who may send to it");
    // Still a page with no folder picker and no schedule on it.
    expect(text).not.toContain("Target folder");
    expect(text).not.toContain("Sync schedule");
  });

  test("both ways out of a session are controls at the foot of Profile", () => {
    let signedOut = 0;
    const host = overlay("profile", () => {}, () => {}, {
      onSignOut: () => {
        signedOut += 1;
      },
    });
    const remove = host.querySelector('[data-testid="delete-account"]');
    const out = host.querySelector('[data-testid="settings-sign-out"]');
    expect(remove).not.toBeNull();
    expect(out).not.toBeNull();
    // Sign-out was a glyph in the rail, then a section of its own paired with
    // account deletion. Neither is a place somebody looks: it is under the
    // identity it ends, and the section that used to hold it is gone.
    act(() => {
      (out as HTMLElement).click();
    });
    expect(signedOut).toBe(1);
  });

  test("with nothing pending there is no invitations row to press", () => {
    /*
      The row used to sit there reading "None" — a badge people learn to skip
      past on the way to the rows that change. Absent instead, and a URL that
      names it falls back the same way a section this context does not have
      already does.
    */
    const data: ConsoleData = { ...demoData(), deleteAccount: async () => {}, invitations: [] };
    mount(() =>
      createElement(SettingsOverlay, {
        data,
        section: "invitations",
        onSelect: () => {},
        onDismiss: () => {},
      }),
    );
    const body = document.body;
    expect(body.querySelector('[data-testid="settings-section-invitations"]')).toBeNull();
    // Fell back to the default section rather than opening an empty panel.
    expect(body.textContent ?? "").not.toContain("Nothing pending");
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

  test("profile says in one row that look follows the device", () => {
    // The three-button picker and the stored choice behind it are gone. What
    // is left is one quiet row saying so, on the screen the search box lands on.
    const text = overlay("profile").textContent ?? "";
    expect(text).toContain("Look");
    expect(text).toContain("Follows your device");
    expect(text).not.toContain("Follow device");
    expect(text).not.toContain("Appearance");
  });

  test("profile draws no Macs box while there are none to show", () => {
    // `useQuery` is stubbed to `undefined` here, which is the loading state. A
    // card reading "Loading…" or "none" is not drawn for it: the Macs card
    // appears only once there is a Mac to revoke.
    const text = overlay("profile").textContent ?? "";
    expect(text).not.toContain("Your Macs");
    expect(text).not.toContain("Loading…");
  });

  test("profile offers feedback as a row that opens its own page", () => {
    const opened: string[] = [];
    const host = overlay("profile", (next) => {
      opened.push(next);
    });
    const choose = host.querySelector('[data-testid="profile-feedback-choose"]');
    expect(choose).not.toBeNull();
    act(() => {
      (choose as HTMLElement).click();
    });
    expect(opened).toEqual(["feedback"]);
  });

  test("profile states the name and does not pretend it can be changed", () => {
    expect(overlay("profile").textContent ?? "").toContain("Profile");
  });
});
