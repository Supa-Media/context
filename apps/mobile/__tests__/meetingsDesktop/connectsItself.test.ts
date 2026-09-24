/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

/**
 * The control plane, as `ThisMachineCard` reaches it.
 *
 * The card now answers the machine approval the shell parks, which means one
 * action and one auth reading. Both are staged rather than provided, because
 * what is being checked is a *decision* — whether this page mints a credential,
 * and what it tells the shell — and a real Convex client would make that a
 * question about a network.
 */
let mockAuthState = { isLoading: false, isAuthenticated: true };
let mockMintCalls: { requestId: string }[] = [];
let mockMintAnswer: (args: { requestId: string }) => Promise<unknown> = async () => ({
  redirectTo: "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
  workspaceSlug: "seyi",
});

jest.mock("convex/react", () => ({
  useConvexAuth: () => mockAuthState,
  useAction: () => (args: { requestId: string }) => {
    mockMintCalls.push(args);
    return mockMintAnswer(args);
  },
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { ThisMachineCard } =
  require("../../features/meetings/components/ThisMachineCard") as typeof import("../../features/meetings/components/ThisMachineCard");
/* eslint-enable @typescript-eslint/no-require-imports */

import { has, installShell, mount, resetDesktop, teardownDesktop } from "./fixtures";

/**
 * The machine that connects itself, when its owner is already signed in. See
 * `fixtures.ts` for the fake shell and the sabotage record that proves it.
 */

beforeEach(() => {
  resetDesktop();
  mockAuthState = { isLoading: false, isAuthenticated: true };
  mockMintCalls = [];
  mockMintAnswer = async () => ({
    redirectTo: "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
    workspaceSlug: "seyi",
  });
});

afterEach(() => {
  teardownDesktop();
});

/**
 * THE MACHINE THAT CONNECTS ITSELF.
 *
 * The owner, on the first end-to-end desktop capture (2026-09-07): *"I don't
 * love this setup; when installing Granola I didn't have to 'connect' a
 * machine, things just worked."* He was signed in **in this window** and the app
 * still put an approve screen in front of him.
 *
 * So the shell hands this card the request it parked, and the card answers it
 * with the session the page already holds. What is checked here is the page's
 * whole half of that, which is three things a refactor could take away without
 * anything else noticing:
 *
 *  1. **a session means the grant is minted, once, with no screen** — and the
 *     window is sent to the loopback redirect the control plane answered with,
 *     which is where the code reaches the shell's own listener;
 *  2. **no session means the shell is told so**, immediately, because that is
 *     what turns a five-minute wait into the approve screen the console's own
 *     sign-in begins;
 *  3. **nothing credential-shaped crosses either way.** What the page is handed
 *     is a request id; what it hands back is that id and a boolean.
 *
 * And the shape of the estate: a **version-2 shell** — the one that shipped
 * #312's in-window approve screen — has none of these members, and this card
 * has to draw itself against it without calling them.
 *
 * ## Sabotage record
 *
 * Broken deliberately, whole mobile suite run, reverted. Counts are failing
 * tests.
 *
 *   `decideMachineApproval` minting unconditionally                    13
 *   ...ignoring `answered`, so a re-render mints again                  9
 *   ...ignoring `auth.isLoading`                                        2
 *   ...ignoring a connection that is already connected                  2
 *   the card not telling the shell about a refusal                      1
 *   ...not telling it about a success                                   2
 *   the card not navigating to the redirect it was given                1
 *   the refusal line naming what the control plane said                 2
 *   the card seeding a pending approval from `?request_id=`             2
 *
 * The first two are large for the reason the **20** above is: a card that
 * mints on every render mints inside a dozen other tests that merely happen to
 * have a shell installed, and that is the right direction to fail in. The rows
 * that are this block's own are the **1**s and **2**s, each naming a defect
 * nothing else in this app looks at.
 *
 * **The first run of this record measured every row as 0**, and the cause is
 * worth writing down: the counter read the suite's *stdout*, and Jest writes
 * its summary to stderr. A sabotage harness that cannot see a failure reports
 * a guard that does not exist as a guard that is not needed.
 */
describe("this machine connects itself when its owner is already signed in", () => {
  /** Where the page is sent at the end. Asserted, never followed. */
  let navigated: string | null = null;

  beforeEach(() => {
    navigated = null;
    /*
      `leaveTo` is how this app leaves itself, on web through
      `window.location.assign` — so that is what is staged, rather than a
      `href` setter that would pass whatever the card did.
    */
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://context.lc/console",
        assign: (next: string) => {
          navigated = next;
        },
      },
    });
  });

  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test("A SIGNED-IN CONSOLE MINTS THE GRANT WITH NO APPROVE SCREEN", async () => {
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(mockMintCalls).toEqual([{ requestId: "req_this_mac" }]);
    // The page is on its way to the loopback redirect, which is the one
    // navigation this window is allowed and where the code reaches the shell.
    expect(navigated).toBe(
      "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
    );
    // The shell is told, so it knows the page did not go silent.
    expect(shell.approvals).toEqual([{ requestId: "req_this_mac", approved: true }]);
    // And the card says which context this machine may now write to — the slug
    // the control plane resolved, never the one the console happens to show.
    expect(mounted.container.textContent).toContain("This machine can write to @seyi.");

    mounted.unmount();
  });

  test("...ONCE, however many times the card re-renders", async () => {
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();
    act(() => {
      shell.emitConnection({
        state: "disconnected",
        gateway: null,
        encrypted: true,
        connecting: true,
        error: null,
      });
    });
    await settle();
    act(() => {
      shell.emitPendingApproval({ requestId: "req_this_mac" });
    });
    await settle();

    // A card that re-minted on every push would mint a machine grant per
    // render, which is what the control plane's rate limit would then be
    // protecting this person from rather than an attacker.
    expect(mockMintCalls).toEqual([{ requestId: "req_this_mac" }]);

    mounted.unmount();
  });

  test("A SIGNED-OUT PAGE MINTS NOTHING AND SAYS SO AT ONCE", async () => {
    mockAuthState = { isLoading: false, isAuthenticated: false };
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(mockMintCalls).toEqual([]);
    expect(navigated).toBe(null);
    // Told immediately: the shell answers this by putting the approve screen in
    // this window, and that screen begins with the console's own sign-in.
    expect(shell.approvals).toEqual([{ requestId: "req_this_mac", approved: false }]);

    mounted.unmount();
  });

  test("...and a session that has not resolved yet decides nothing", async () => {
    mockAuthState = { isLoading: true, isAuthenticated: false };
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    // Answering "signed out" for somebody who is signed in costs them a screen
    // they did not need, which is the whole thing this change removes.
    expect(mockMintCalls).toEqual([]);
    expect(shell.approvals).toEqual([]);

    mounted.unmount();
  });

  test("A CONTROL PLANE THAT REFUSES COSTS A SCREEN, NEVER THE GRANT", async () => {
    mockMintAnswer = async () => {
      throw new Error("refused");
    };
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(shell.approvals).toEqual([{ requestId: "req_this_mac", approved: false }]);
    expect(navigated).toBe(null);
    // No sentence about which condition failed: every refusal ends the same way
    // for the person, with the approve screen a moment later.
    expect(mounted.container.textContent).toContain("Asking you to approve this machine");
    expect(mounted.container.textContent).not.toContain("refused");

    mounted.unmount();
  });

  test("a machine that is already connected mints nothing", async () => {
    const shell = fakeDesktopBridge({
      pendingApproval: { requestId: "req_this_mac" },
      connection: {
        state: "connected",
        gateway: "https://gateway.invalid",
        encrypted: true,
        connecting: false,
        error: null,
      },
    });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    expect(mockMintCalls).toEqual([]);
    mounted.unmount();
  });

  test("NOTHING CREDENTIAL-SHAPED CROSSES IN EITHER DIRECTION", async () => {
    const shell = fakeDesktopBridge({ pendingApproval: { requestId: "req_this_mac" } });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    // What went back: the id the shell handed over, and a boolean.
    expect(shell.approvals.map((answer) => Object.keys(answer).sort())).toEqual([
      ["approved", "requestId"],
    ]);

    mounted.unmount();
  });

  /*
    THE LINK THE WHOLE FEATURE HANGS FROM.

    `software_id` is client-asserted: anything that can register can claim to be
    the shell, and `docs/decisions/identity-and-access.md` says so out loud. So
    what stops a forged client from getting an auto-approved grant is not the
    declaration — it is that the *request id* only ever reaches this page over
    the shell's bridge. A page at a foreign origin gets no bridge at all
    (`shouldExposeBridge`, in the preload), and a page at this origin reads the
    id from nowhere else: not a query parameter, not the fragment, not a
    `postMessage` from an opener, not a global somebody set.

    That is a property of *this file*, which is why it is checked twice — once
    by driving the card with all three of those in place and no bridge push, and
    once by reading the two source files for the shapes that would make it
    false. The second check is the one that survives a refactor: a future deep
    link that read `?request_id=` into this card would be a confused deputy with
    a signed-in session behind it, and it would go red here rather than in
    production.
  */
  test("A REQUEST ID THAT DID NOT COME OVER THE BRIDGE MINTS NOTHING", async () => {
    // A shell is present — so the card renders and the bridge is live — but it
    // is holding no approval. Everything below is an attacker's delivery route.
    const shell = fakeDesktopBridge({ pendingApproval: null });
    installShell(shell);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://context.lc/console?request_id=req_forged#request_id=req_forged",
        search: "?request_id=req_forged",
        hash: "#request_id=req_forged",
        assign: (next: string) => {
          navigated = next;
        },
      },
    });
    (globalThis as Record<string, unknown>).__pendingApproval = { requestId: "req_forged" };

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    window.postMessage({ requestId: "req_forged" }, "*");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { pendingApproval: { requestId: "req_forged" } },
        origin: "https://attacker.invalid",
      }),
    );
    await settle();

    expect(mockMintCalls).toEqual([]);
    expect(shell.approvals).toEqual([]);
    expect(navigated).toBe(null);
    expect(has(mounted.container, "this-machine-approval")).toBe(false);

    mounted.unmount();
    delete (globalThis as Record<string, unknown>).__pendingApproval;
  });

  test("...and neither source file has a second way to learn one", () => {
    const sources = [
      "../../features/meetings/machineApproval.ts",
      "../../features/meetings/components/ThisMachineCard.tsx",
    ].map((path) => readFileSync(join(__dirname, path), "utf8"));

    for (const source of sources) {
      // Every shape that would let something other than the shell name the
      // request this page answers.
      expect(source).not.toMatch(/location|URLSearchParams|useLocalSearchParams|useSearchParams/);
      expect(source).not.toMatch(/postMessage|"message"|'message'|window\.opener|referrer/);
    }
    // And the one member it does read it from, named so a rename is a red test
    // rather than a silent widening.
    expect(sources[1]).toMatch(/connection\.pendingApproval\(\)/);
  });

  test("A VERSION-2 SHELL IS DRAWN WITHOUT CALLING MEMBERS IT NEVER PROMISED", async () => {
    const shell = fakeDesktopBridge({ noMachineApproval: true });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();

    // It approves in its own window, which is what #312 shipped, and this card
    // draws exactly what it drew then.
    expect(has(mounted.container, "this-machine-title")).toBe(true);
    expect(has(mounted.container, "this-machine-approval")).toBe(false);
    expect(mockMintCalls).toEqual([]);

    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });

  test("the subscription detaches with the pane, like every other one", async () => {
    const shell = fakeDesktopBridge();
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await settle();
    expect(shell.listenerCount()).toBeGreaterThan(0);

    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });
});
