import { describe, expect, test } from "@jest/globals";
import {
  resolveConsentView,
  type AuthorizationRequest,
  type ConsentContext,
  type ConsentInputs,
} from "../features/consent/state";
import { isSafeRedirect } from "../features/consent/redirectSafety";
import { describeMachine } from "../features/meetings/thisMachine";
import {
  decideMachineApproval,
  machineApprovalLine,
  type MachineApprovalInputs,
} from "../features/meetings/machineApproval";

/**
 * Approving a Mac inside the desktop shell's own window.
 *
 * The shell used to open the system browser for this, where the person arrives
 * signed out of a console they are signed in to in the app, signs in a second
 * time, approves, and is left reading "you can close this tab" somewhere that
 * is not the app. It now navigates its **own** console window to the same
 * authorize URL — `apps/desktop/src/core/shell/approval.ts` is the guard that
 * makes the loopback return trip one address rather than a hole in the origin
 * pin, and `docs/decisions/desktop.md` is the decision.
 *
 * **That sentence has since been reversed, on purpose, and the reversal is
 * bounded.** The owner's reaction to the first end-to-end capture, 2026-09-07:
 * *"I don't love this setup; when installing Granola I didn't have to 'connect'
 * a machine, things just worked."* So the shell now hands the parked request to
 * the console **card** — a component that only exists inside the shell in the
 * first place — which answers it with the session this page already holds. The
 * consent screen below is untouched, has no shell branch, and is still what
 * every other client and every refusal goes through. The decision about when a
 * page may mint a credential is `decideMachineApproval`, checked at the foot of
 * this file, and `docs/decisions/desktop.md` carries the argument.
 *
 * What the paragraph below said when the approval first moved into the window,
 * kept because it is still true of this screen:
 *
 * **Nothing in `apps/mobile` had to learn that it is inside the shell for this
 * to work, and that is the finding this file records rather than a gap in it.**
 * The window is at the console's own origin with the console's own session, so
 * `/authorize?request_id=…` is an ordinary page load: the screen this suite
 * already covers, reached with a session it already has. There is no new bridge
 * member, no `getDesktopBridge()` branch on this screen, and no shell-shaped
 * variant of the consent flow — every one of which would have been a second
 * code path through the highest-value screen in the product.
 *
 * So what is checked here is exactly the three things the desktop flow leans on
 * this app for, each of which a refactor could take away without noticing:
 *
 *  1. a session means the approve screen renders — no second sign-in;
 *  2. no session means the console's own sign-in, carrying the request, so the
 *     flow resumes on the same request afterwards;
 *  3. the loopback redirect the shell listens on is one this screen is willing
 *     to navigate to, and a non-loopback `http` one still is not;
 *  4. the tier control opens on the tier this machine asked for. That one was
 *     asserted the other way when the approval first moved into the window, and
 *     it was the privacy defect rather than the caution it read as: the Mac's
 *     grant tier is what a meeting is *filed as*, so approving the defaults
 *     published every meeting it recorded to everybody its owner shares a
 *     folder with. `docs/decisions/identity-and-access.md` carries the
 *     amendment.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests across
 * the whole `apps/mobile` suite.
 *
 *   `resolveConsentView` returning `signIn` for an authenticated session  49
 *   `loginHref` dropping the `next` parameter                            14
 *   `isSafeRedirect` refusing `http://127.0.0.1`                          2
 *   ...accepting any `http` host                                          2
 *   the "Connecting" sentence back to "a browser window is open"          1
 *   `defaultTierFor` back to always `team`                                3
 *   ...to always `private`                                               11
 *
 * The first two rows are large because those two functions are load-bearing far
 * beyond this feature — which is the point of measuring rather than guessing:
 * this file is not what holds them up, and it says so instead of taking credit.
 * The rows that are this file's own are the last three.
 */

/** The port is the OS's, as `listenForCode` takes it. A fake one here. */
const LOOPBACK = "http://127.0.0.1:53411/context-hook/callback";

const NOW = 1_800_000_000_000;

const CONTEXTS: ConsentContext[] = [{ id: "w1", slug: "seyi", role: "owner" }];

/**
 * What the desktop shell's client asks for, and no more.
 *
 * `context:write context:private` is `DESKTOP_SCOPE` — write because a meeting
 * is not a capture, private because the tier decides what the meeting is filed
 * as. Deliberately no `context:read`: a laptop credential that could read every
 * note its owner ever wrote is past what the feature is worth.
 */
const DESKTOP_REQUEST: AuthorizationRequest = {
  requestId: "req_desktop",
  clientName: "Context on this Mac",
  redirectUri: LOOPBACK,
  scope: "context:write context:private",
  scopes: ["context:write", "context:private"],
  requestedWorkspaceSlug: null,
  workspaceSlug: "seyi",
  expiresAt: NOW + 300_000,
};

function inputs(overrides: Partial<ConsentInputs> = {}): ConsentInputs {
  return {
    requestId: "req_desktop",
    auth: { isLoading: false, isAuthenticated: true },
    request: DESKTOP_REQUEST,
    contexts: CONTEXTS,
    chosenContextId: null,
    chosenScopes: null,
    chosenTier: null,
    decision: { kind: "idle" },
    now: NOW,
    ...overrides,
  };
}

describe("approving this machine inside the desktop shell's window", () => {
  test("a session in the shell's window means the approve screen, not a second sign-in", () => {
    const view = resolveConsentView(inputs());

    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    // The screen names the machine and what it is asking for, which is the
    // whole reason the shell's own modal in front of this one went away.
    expect(view.clientName).toBe("Context on this Mac");
    expect(view.scopeChoices.map((choice) => choice.scope)).toEqual(["context:write"]);
    expect(view.withheldScopes).toEqual([]);
    expect(view.canApprove).toBe(true);
    /*
      `context:private` is not a row: it is the **tier**, and this screen shows
      it as one control with the whole context's visibility on it rather than as
      a tick box among the operations. It is worth asserting here because a
      reader of `DESKTOP_SCOPE` would otherwise expect a second tick box.

      **And the control opens on what the machine asked for.** This assertion
      read `"team"` when the approval first moved into the window, and that was
      the privacy defect rather than a caution: a person pressing Approve on the
      defaults granted `context:write` at team tier, and the desktop's tier is
      not about reading — `publishMeetingNote` files a meeting at the grant's
      tier, so every meeting that Mac recorded was published to everybody its
      owner shares a folder with, having been approved on a screen that said
      nothing about it. `defaultTierFor` is the rule and
      `docs/decisions/identity-and-access.md` records the amendment; the person
      still moves it in one tap, and `apps/desktop` refuses to file a meeting at
      all if they do.
    */
    expect(view.tier.selected).toBe("private");
    expect(view.tier.options.map((option) => option.value)).toContain("private");
    expect(view.tier.isAChoice).toBe(true);
    expect(view.grantedScopes).toEqual(["context:write", "context:private"]);
  });

  test("...and choosing team is a real choice, not a refusal to draw one", () => {
    // The default is a default. A person who wants this Mac at team tier says
    // so and gets exactly that — and the desktop then holds its meetings rather
    // than filing them at a visibility that screen did not promise, which is
    // `grantCoversMeetings` in `apps/desktop/src/core/sync/connection.ts`.
    const view = resolveConsentView(inputs({ chosenTier: "team" }));
    if (view.kind !== "ready") throw new Error("expected the approve screen");
    expect(view.tier.selected).toBe("team");
    expect(view.grantedScopes).toEqual(["context:write"]);
  });

  test("...and it says the machine is what it is handing this to", () => {
    const view = resolveConsentView(inputs());
    if (view.kind !== "ready") throw new Error("expected the approve screen");
    // The host of a loopback redirect is this machine. Shown rather than
    // hidden: "which site am I handing this to" is the question this line
    // answers, and "your own computer" is the honest answer for a native app.
    expect(view.redirectHost).toBe("127.0.0.1:53411");
  });

  test("no session yet gets the console's own sign-in and comes back to this request", () => {
    const view = resolveConsentView(
      inputs({ auth: { isLoading: false, isAuthenticated: false } }),
    );

    expect(view).toEqual({
      kind: "signIn",
      href: "/login?next=%2Fauthorize%3Frequest_id%3Dreq_desktop",
    });
  });

  test("the shell's loopback listener is somewhere this screen will hand the window back to", () => {
    expect(isSafeRedirect(LOOPBACK)).toBe(true);
    // And the reason that is not a loosening: everything else over cleartext
    // is still refused, because a code in a query string on the wire is a code
    // handed to whoever is on it.
    expect(isSafeRedirect("http://gateway.example.test/callback")).toBe(false);
    expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
  });

  test("the card says the approval is in this window, because it is", () => {
    const view = describeMachine({
      state: "disconnected",
      gateway: null,
      encrypted: true,
      connecting: true,
      error: null,
    });

    expect(view.pill).toBe("Connecting");
    expect(view.sentence).toMatch(/in this window/i);
    // Not a browser: a person told to look for a browser window that never
    // opens is a person who thinks the app is broken.
    expect(view.sentence).not.toMatch(/browser/i);
    // Still no second control while one approval is open.
    expect(view.action).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * WHEN THIS PAGE MAY MINT A MACHINE GRANT, AS A PURE FUNCTION.
 *
 * `decideMachineApproval` is what stands between "the person is signed in in
 * this window" and a credential being minted for the machine they are sitting
 * at. The card renders what it returns and decides nothing, for the reason
 * `features/console/capabilities.ts` records in one line: *every guard
 * expressed inside a component in this app was held by nothing.*
 *
 * Every refusal here is a refusal to **act**, never a refusal of the person:
 * each one ends with the shell putting the approve screen in the same window,
 * which is what #312 shipped and what the consent screen above still is.
 */
describe("when this page mints the machine's grant, and when it declines to", () => {
  const inputs = (
    overrides: Partial<MachineApprovalInputs> = {},
  ): MachineApprovalInputs => ({
    pending: { requestId: "req_this_mac" },
    connection: {
      state: "disconnected",
      gateway: null,
      encrypted: true,
      connecting: true,
      error: null,
    },
    auth: { isLoading: false, isAuthenticated: true },
    minting: false,
    answered: null,
    ...overrides,
  });

  test("a signed-in session and a parked request mints it", () => {
    expect(decideMachineApproval(inputs())).toEqual({
      kind: "mint",
      requestId: "req_this_mac",
    });
  });

  test("nothing parked is the ordinary state of this app", () => {
    expect(decideMachineApproval(inputs({ pending: null }))).toEqual({ kind: "idle" });
  });

  test("A SESSION STILL RESOLVING DECIDES NOTHING", () => {
    // Answering "signed out" for somebody who is signed in costs them a screen
    // they did not need, which is the whole thing this feature removes.
    expect(
      decideMachineApproval(inputs({ auth: { isLoading: true, isAuthenticated: false } })),
    ).toEqual({ kind: "idle" });
  });

  test("no session tells the shell at once, so the screen opens rather than a wait", () => {
    expect(
      decideMachineApproval(inputs({ auth: { isLoading: false, isAuthenticated: false } })),
    ).toEqual({ kind: "declineSignedOut", requestId: "req_this_mac" });
  });

  test("A REQUEST IS ANSWERED ONCE, WHATEVER THE RENDER LOOP DOES", () => {
    expect(decideMachineApproval(inputs({ answered: "req_this_mac" }))).toEqual({
      kind: "idle",
    });
    expect(decideMachineApproval(inputs({ minting: true }))).toEqual({ kind: "idle" });
    // A different request is a different question, and is answered.
    expect(decideMachineApproval(inputs({ answered: "req_another_mac" })).kind).toBe("mint");
  });

  test("a machine that already has a grant does not get a second one", () => {
    expect(
      decideMachineApproval(
        inputs({
          connection: {
            state: "connected",
            gateway: "https://gateway.invalid",
            encrypted: true,
            connecting: false,
            error: null,
          },
        }),
      ),
    ).toEqual({ kind: "idle" });
  });

  test("...but a revoked one does, because that is a machine with a queue waiting", () => {
    expect(
      decideMachineApproval(
        inputs({
          connection: {
            state: "revoked",
            gateway: "https://gateway.invalid",
            encrypted: true,
            connecting: false,
            error: null,
          },
        }),
      ).kind,
    ).toBe("mint");
  });

  test("a shell whose connection has not been read yet is not a reason to wait", () => {
    // The card asks the bridge and subscribes; the answer can arrive after the
    // push. Refusing to act until it lands would mean a connect that started
    // before the card mounted is never answered.
    expect(decideMachineApproval(inputs({ connection: null })).kind).toBe("mint");
  });

  test("THE LINE THE CARD SHOWS NAMES THE CONTEXT, AND NEVER THE REFUSAL", () => {
    expect(machineApprovalLine("minting", null)).toMatch(/Connecting this machine/);
    expect(machineApprovalLine("granted", "seyi")).toBe("This machine can write to @seyi.");
    expect(machineApprovalLine("granted", null)).toBe("This machine can write to your context.");
    // Every refusal ends the same way for the person: the approve screen, in
    // this window, a moment later. Which condition failed is machinery.
    expect(machineApprovalLine("refused", "seyi")).toBe(
      "Asking you to approve this machine instead…",
    );
  });
});
